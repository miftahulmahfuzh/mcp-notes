import pg from 'pg';
import { loadDatabaseTarget } from '../connectors/env.js';
import { reasonOf, scrub } from '../connectors/errors.js';
import { CONNECTOR_PG_TYPES } from '../connectors/pg.js';
import { ConnectorError } from '../connectors/types.js';
import type { Source, Verdict } from './types.js';

/** The only Seer tables mcp-notes may write (contract C4). */
export const WRITABLE_TABLES = ['adversary_verdicts', 'adversary_marks', 'adversary_leases'] as const;
export type WritableTable = (typeof WRITABLE_TABLES)[number];

const WRITE_TIMEOUT_MS = 15_000;
const STATEMENT = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_.]*)\s/i;
const SUPERSEDE_ONLY = /^\s*UPDATE\s+adversary_verdicts\s+SET\s+superseded_by\s*=\s*\$\d+\s+WHERE\s/i;

export class AdversaryWriteError extends Error {
  override name = 'AdversaryWriteError';
}

/**
 * Refuses any statement outside contract C4 before it reaches the database: one statement, INSERT
 * into one of WRITABLE_TABLES, UPDATE of adversary_verdicts.superseded_by only, UPDATE/DELETE of
 * adversary_leases. Verdicts are append-only and marks are never removed. Returns the table.
 */
export function assertWritable(sql: string): WritableTable {
  if (sql.includes(';')) throw new AdversaryWriteError('the Seer writer sends one statement at a time');
  const match = STATEMENT.exec(sql);
  if (match === null) throw new AdversaryWriteError('the Seer writer only inserts, updates or deletes');
  const verb = (match[1] ?? '').toUpperCase().replace(/\s+/g, ' ');
  const table = (match[2] ?? '').toLowerCase();
  if (!(WRITABLE_TABLES as readonly string[]).includes(table)) {
    throw new AdversaryWriteError(`the Seer writer may not write ${table}`);
  }
  if (verb === 'DELETE FROM' && table !== 'adversary_leases') {
    throw new AdversaryWriteError(`${table} is never deleted from`);
  }
  if (verb === 'UPDATE' && table === 'adversary_marks') throw new AdversaryWriteError('adversary_marks is never updated');
  if (verb === 'UPDATE' && table === 'adversary_verdicts' && !SUPERSEDE_ONLY.test(sql)) {
    throw new AdversaryWriteError('adversary_verdicts only ever gets superseded_by set');
  }
  return table as WritableTable;
}

export interface NewVerdict {
  strategyId: string;
  sessionDate: string;
  symbol: string;
  verdict: Verdict;
  reason: string;
  sources: Source[];
  lens: string;
  /** Exact verdict model id. */
  model: string;
  promptVersion: string;
  host: string;
  /** When the review began (host clock); stored as LEAST(startedAt, DB now()). */
  startedAt: Date;
}

export interface WrittenVerdict {
  id: number;
  /** ISO 8601 UTC, the Seer DB's now() at insert. */
  decidedAt: string;
}

export interface SeerWriterOptions {
  /** Seer repo dir, resolved on every call (SEER_DIR may change without a restart). */
  repoDir: () => string;
  timeoutMs?: number;
}

type Exec = (sql: string, params: readonly unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>>;

const CLAIM_SQL = `INSERT INTO adversary_leases (strategy_id, session_date, host, claimed_at, expires_at)
VALUES ($1, $2::date, $3, now(), now() + make_interval(secs => $4::double precision))
ON CONFLICT (strategy_id, session_date) DO UPDATE
  SET host = EXCLUDED.host, claimed_at = now(), expires_at = EXCLUDED.expires_at
  WHERE adversary_leases.expires_at < now() OR adversary_leases.host = EXCLUDED.host
RETURNING host`;

const RENEW_SQL = `UPDATE adversary_leases SET expires_at = now() + make_interval(secs => $4::double precision)
WHERE strategy_id = $1 AND session_date = $2::date AND host = $3
RETURNING host`;

const RELEASE_SQL = `DELETE FROM adversary_leases WHERE strategy_id = $1 AND session_date = $2::date AND host = $3`;

const VERDICT_SQL = `INSERT INTO adversary_verdicts
  (strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version, host, started_at, decided_at)
VALUES ($1, $2::date, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, LEAST($11::timestamptz, now()), now())
RETURNING id, to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at`;

const SUPERSEDE_SQL = `UPDATE adversary_verdicts SET superseded_by = $1 WHERE id = $2 AND superseded_by IS NULL`;

const MARK_SQL = `INSERT INTO adversary_marks (strategy_id, session_date, mark, host)
VALUES ($1, $2::date, 'paused', $3)
ON CONFLICT (strategy_id, session_date) DO NOTHING
RETURNING strategy_id`;

/**
 * The narrow writer of Seer's adversary tables (contract C4). Separate from the read-only connector
 * guard on purpose: the guard stays read-only. Opens one connection per call and closes it.
 */
export class SeerWriter {
  constructor(private readonly opts: SeerWriterOptions) {}

  private async withClient<T>(fn: (exec: Exec, client: pg.Client) => Promise<T>): Promise<T> {
    const target = loadDatabaseTarget('seer', this.opts.repoDir());
    const timeoutMs = this.opts.timeoutMs ?? WRITE_TIMEOUT_MS;
    const client = new pg.Client({
      connectionString: target.url,
      options: `-c statement_timeout=${timeoutMs} -c TimeZone=UTC`,
      application_name: 'mcp-notes-adversary',
      connectionTimeoutMillis: 10_000,
      query_timeout: timeoutMs + 2_000,
      types: CONNECTOR_PG_TYPES,
    });
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      await client.end().catch(() => {});
      throw new AdversaryWriteError(`seer is not reachable for writing: ${scrub(reasonOf(err), target.secrets)}`);
    }
    const exec: Exec = (sql, params) => {
      assertWritable(sql);
      return client.query<Record<string, unknown>>(sql, [...params]);
    };
    try {
      return await fn(exec, client);
    } catch (err) {
      if (err instanceof AdversaryWriteError || err instanceof ConnectorError) throw err;
      throw new AdversaryWriteError(`seer write failed: ${scrub(reasonOf(err), target.secrets)}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Claims (or re-claims as the same host) the lease of one decision. Expiry is the DB clock's. */
  async claimLease(strategyId: string, sessionDate: string, host: string, ttlMs: number): Promise<boolean> {
    return this.withClient(async (exec) => (await exec(CLAIM_SQL, [strategyId, sessionDate, host, ttlMs / 1000])).rowCount === 1);
  }

  /** Extends this host's lease; false when another host took it over. */
  async renewLease(strategyId: string, sessionDate: string, host: string, ttlMs: number): Promise<boolean> {
    return this.withClient(async (exec) => (await exec(RENEW_SQL, [strategyId, sessionDate, host, ttlMs / 1000])).rowCount === 1);
  }

  async releaseLease(strategyId: string, sessionDate: string, host: string): Promise<void> {
    await this.withClient(async (exec) => {
      await exec(RELEASE_SQL, [strategyId, sessionDate, host]);
    });
  }

  /** Inserts a verdict and, in the same transaction, points the verdict it replaces at it. */
  async insertVerdict(v: NewVerdict, supersedes: number | null): Promise<WrittenVerdict> {
    return this.withClient(async (exec, client) => {
      await client.query('BEGIN');
      try {
        const inserted = await exec(VERDICT_SQL, [
          v.strategyId,
          v.sessionDate,
          v.symbol,
          v.verdict,
          v.reason,
          JSON.stringify(v.sources),
          v.lens,
          v.model,
          v.promptVersion,
          v.host,
          v.startedAt.toISOString(),
        ]);
        const row = inserted.rows[0];
        if (row === undefined) throw new AdversaryWriteError('adversary_verdicts insert returned no row');
        const written: WrittenVerdict = { id: Number(row.id), decidedAt: String(row.decided_at) };
        if (supersedes !== null) await exec(SUPERSEDE_SQL, [written.id, supersedes]);
        await client.query('COMMIT');
        return written;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  }

  /** Writes a 'paused' mark; false when the decision already had one. */
  async insertMark(strategyId: string, sessionDate: string, host: string): Promise<boolean> {
    return this.withClient(async (exec) => (await exec(MARK_SQL, [strategyId, sessionDate, host])).rowCount === 1);
  }
}
