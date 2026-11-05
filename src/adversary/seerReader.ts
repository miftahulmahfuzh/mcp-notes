import { toObjects } from '../connectors/rows.js';
import type { QueryOptions, QueryResult, ReadOnlySource } from '../connectors/types.js';
import type { Bar, CandidateRow, DecisionKind, LabMethod, MarkRef, PreviewRow, RosterRow, Verdict, VerdictRef } from './types.js';

/** A Seer connector (src/connectors/connector.ts): read-only Postgres plus, optionally, lab.sqlite. */
export interface SeerSource extends ReadOnlySource {
  lab?: ReadOnlySource;
}

const MAX_ROWS = 1_000;
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const SCHEMA_READY_SQL = `
SELECT (
  to_regclass('public.adversary_verdicts') IS NOT NULL
  AND to_regclass('public.adversary_marks') IS NOT NULL
  AND to_regclass('public.adversary_leases') IS NOT NULL
  AND to_regclass('public.strategy_candidates') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'strategies' AND column_name = 'twin_of')
  AND EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'book_previews' AND column_name = 'next_decision_session')
) AS ready`;

const ROSTER_SQL = `
SELECT id, name, sub, engine, rules_id, object_name, gate_note, promoted_from, status, twin_of, is_benchmark
FROM strategies
ORDER BY sort, id`;

const CANDIDATES_SQL = `
SELECT strategy_id, session_date::text AS session_date, data_date::text AS data_date, kind, rank, symbol, weight, evidence
FROM strategy_candidates
WHERE session_date >= $1::date AND strategy_id = ANY($2::text[])
ORDER BY session_date, strategy_id, rank`;

const PREVIEWS_SQL = `
SELECT strategy_id, data_date::text AS data_date, rank, symbol, weight, next_decision_session::text AS next_decision_session
FROM book_previews
WHERE next_decision_session IS NOT NULL AND next_decision_session >= $1::date AND strategy_id = ANY($2::text[])
ORDER BY strategy_id, rank`;

const VERDICTS_SQL = `
SELECT id, strategy_id, session_date::text AS session_date, symbol, verdict,
       to_char(decided_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS decided_at
FROM adversary_verdicts
WHERE session_date >= $1::date AND strategy_id = ANY($2::text[]) AND superseded_by IS NULL
ORDER BY session_date, strategy_id, symbol, decided_at`;

const MARKS_SQL = `
SELECT strategy_id, session_date::text AS session_date
FROM adversary_marks
WHERE session_date >= $1::date AND strategy_id = ANY($2::text[])`;

const LAST_SUCCESS_SQL = `
SELECT to_char(max(finished_at) AT TIME ZONE 'UTC', ${ISO_UTC}) AS at
FROM runs
WHERE status = 'success' AND NOT is_demo`;

const HELD_SQL = `SELECT DISTINCT symbol FROM book_positions WHERE strategy_id = $1 ORDER BY symbol`;

const BARS_SQL = `
SELECT date::text AS date, close, volume
FROM bars
WHERE symbol = $1 AND date <= $2::date
ORDER BY date DESC
LIMIT $3::int`;

const LAB_METHOD_SQL = `SELECT id, name, family, hypothesis FROM methods WHERE id = ?`;

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function kindOf(value: unknown): DecisionKind {
  if (value === 'bracket' || value === 'book') return value;
  throw new Error(`strategy_candidates.kind is ${str(value)}, expected bracket or book`);
}

function verdictOf(value: unknown): Verdict {
  if (value === 'agree' || value === 'object' || value === 'unsure') return value;
  throw new Error(`adversary_verdicts.verdict is ${str(value)}`);
}

/**
 * Every read the reviewer makes of Seer's database. Read-only by construction: it holds only a
 * ReadOnlySource. Writes go through SeerWriter (contract C4).
 */
export class SeerReader {
  constructor(private readonly source: SeerSource) {}

  private async rows(sql: string, params: readonly unknown[] = [], options: QueryOptions = { maxRows: MAX_ROWS }): Promise<Record<string, unknown>[]> {
    const result: QueryResult = await this.source.query(sql, params, options);
    return toObjects(result);
  }

  /** True when Seer migration 027 is applied (all adversary tables and columns exist). Throws ConnectorError when Seer is unreachable. */
  async schemaReady(): Promise<boolean> {
    const rows = await this.rows(SCHEMA_READY_SQL, [], { maxRows: 1 });
    return rows[0]?.ready === true;
  }

  async roster(): Promise<RosterRow[]> {
    return (await this.rows(ROSTER_SQL)).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      sub: str(r.sub),
      engine: strOrNull(r.engine),
      rulesId: strOrNull(r.rules_id),
      objectName: strOrNull(r.object_name),
      gateNote: strOrNull(r.gate_note),
      promotedFrom: strOrNull(r.promoted_from),
      status: str(r.status),
      twinOf: strOrNull(r.twin_of),
      isBenchmark: r.is_benchmark === true,
    }));
  }

  async candidates(fromDate: string, strategyIds: readonly string[]): Promise<CandidateRow[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(CANDIDATES_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      strategyId: str(r.strategy_id),
      sessionDate: str(r.session_date),
      dataDate: str(r.data_date),
      kind: kindOf(r.kind),
      rank: num(r.rank),
      symbol: str(r.symbol),
      weight: numOrNull(r.weight),
      evidence: r.evidence ?? null,
    }));
  }

  async previews(fromDate: string, strategyIds: readonly string[]): Promise<PreviewRow[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(PREVIEWS_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      strategyId: str(r.strategy_id),
      dataDate: str(r.data_date),
      rank: num(r.rank),
      symbol: str(r.symbol),
      weight: num(r.weight),
      nextDecisionSession: str(r.next_decision_session),
    }));
  }

  /** Non-superseded verdicts for sessions on/after fromDate. */
  async verdictsFrom(fromDate: string, strategyIds: readonly string[]): Promise<VerdictRef[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(VERDICTS_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      id: num(r.id),
      strategyId: str(r.strategy_id),
      sessionDate: str(r.session_date),
      symbol: str(r.symbol),
      verdict: verdictOf(r.verdict),
      decidedAt: str(r.decided_at),
    }));
  }

  async marksFrom(fromDate: string, strategyIds: readonly string[]): Promise<MarkRef[]> {
    if (strategyIds.length === 0) return [];
    return (await this.rows(MARKS_SQL, [fromDate, [...strategyIds]])).map((r) => ({
      strategyId: str(r.strategy_id),
      sessionDate: str(r.session_date),
    }));
  }

  /** `finished_at` of the newest successful real nightly run, null when Seer has none. Needs no adversary tables. */
  async lastSuccessfulRunAt(): Promise<Date | null> {
    const at = (await this.rows(LAST_SUCCESS_SQL, [], { maxRows: 1 }))[0]?.at;
    if (at === null || at === undefined) return null;
    const ms = Date.parse(str(at));
    return Number.isNaN(ms) ? null : new Date(ms);
  }

  /** Symbols the original holds now (book strategies). */
  async heldSymbols(strategyId: string): Promise<string[]> {
    return (await this.rows(HELD_SQL, [strategyId])).map((r) => str(r.symbol));
  }

  /** Newest first, never later than `throughDate` (the decision night: the information cutoff of the price tool). */
  async priceBars(symbol: string, throughDate: string, limit: number): Promise<Bar[]> {
    const cap = Math.max(1, Math.min(MAX_ROWS, Math.floor(limit)));
    return (await this.rows(BARS_SQL, [symbol, throughDate, cap], { maxRows: cap })).map((r) => ({
      date: str(r.date),
      close: num(r.close),
      volume: num(r.volume),
    }));
  }

  /** The lab method a roster row was promoted from. Null when there is no lab reader or no such method; throws when lab.sqlite cannot be read. */
  async labMethod(methodId: string): Promise<LabMethod | null> {
    const lab = this.source.lab;
    if (lab === undefined) return null;
    const rows = toObjects(await lab.query(LAB_METHOD_SQL, [methodId], { maxRows: 1 }));
    const r = rows[0];
    if (r === undefined) return null;
    return { id: str(r.id), name: str(r.name), family: str(r.family), hypothesis: str(r.hypothesis) };
  }
}
