import pg from 'pg';
import { loadDatabaseTarget } from '../connectors/env.js';
import { dwordUserNotConfiguredMessage, dwordUserNotFoundMessage } from '../connectors/dword/user.js';
import { reasonOf, scrub } from '../connectors/errors.js';
import { CONNECTOR_PG_TYPES } from '../connectors/pg.js';
import { ConnectorError } from '../connectors/types.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import type { DwordPartOfSpeech } from './rules.js';

/**
 * Resolves DWORD_USER_EMAIL to dword's users.id against this writer's own open pg.Client — the
 * transport-specific sibling of src/connectors/dword/user.ts's Connector-based
 * resolveDwordUserId (that function cannot be reused here: a Connector and a pg.Client return
 * incompatibly-shaped query results). Reuses the exact same refusal wording via the two message
 * builders so a caller sees identical text regardless of which path resolved the email.
 */
async function resolveUserIdFromClient(client: pg.Client, email: string | undefined): Promise<string> {
  if (!email) {
    throw new ConnectorError(dwordUserNotConfiguredMessage());
  }
  const result = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  const row = result.rows[0];
  if (!row) {
    throw new ConnectorError(dwordUserNotFoundMessage(email));
  }
  return row.id;
}

/** The only dword tables mcp-notes may write. */
export const WRITABLE_TABLES = ['vocab_entries', 'journal_entries', 'journal_entry_embeddings'] as const;
export type WritableTable = (typeof WRITABLE_TABLES)[number];

const WRITE_TIMEOUT_MS = 15_000;

/** INSERT or UPDATE only — dword rows are never deleted by mcp-notes. */
const STATEMENT = /^\s*(INSERT\s+INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_.]*)\s/i;

/**
 * The one UPDATE shape ever allowed: `vocab_entries`'s three origin columns, set together, in
 * this order, guarded by `origin_term IS NULL` somewhere in the WHERE clause. Anything else —
 * a different column, a different order, a missing guard — fails this and is refused.
 */
const ORIGIN_ATTACH_ONLY =
  /^\s*UPDATE\s+vocab_entries\s+SET\s+origin_term\s*=\s*\$\d+\s*,\s*origin_language\s*=\s*\$\d+\s*,\s*origin_context\s*=\s*\$\d+\s+WHERE\s+[\s\S]*\borigin_term\s+IS\s+NULL\b/i;

export class DwordWriteError extends Error {
  override name = 'DwordWriteError';
}

/**
 * Refuses any statement outside the dword write contract before it reaches the database: one
 * statement, INSERT into one of WRITABLE_TABLES, or the single allowed UPDATE of
 * `vocab_entries`'s origin columns. No DELETE, ever. Returns the table.
 */
export function assertWritable(sql: string): WritableTable {
  if (sql.includes(';')) throw new DwordWriteError('the dword writer sends one statement at a time');
  const match = STATEMENT.exec(sql);
  if (match === null) throw new DwordWriteError('the dword writer only inserts or updates');
  const verb = (match[1] ?? '').toUpperCase().replace(/\s+/g, ' ');
  const table = (match[2] ?? '').toLowerCase();
  if (!(WRITABLE_TABLES as readonly string[]).includes(table)) {
    throw new DwordWriteError(`the dword writer may not write ${table}`);
  }
  if (verb === 'UPDATE' && table !== 'vocab_entries') {
    throw new DwordWriteError(`${table} is never updated`);
  }
  if (verb === 'UPDATE' && table === 'vocab_entries' && !ORIGIN_ATTACH_ONLY.test(sql)) {
    throw new DwordWriteError('vocab_entries may only have origin_term/origin_language/origin_context attached, guarded by origin_term IS NULL');
  }
  return table as WritableTable;
}

export interface NewVocabEntry {
  term: string;
  partOfSpeech: DwordPartOfSpeech;
  pronunciation: string;
  definition: string;
  examples: readonly string[];
}

export interface VocabOrigin {
  originTerm: string;
  originLanguage: string;
  /** Nullable: an origin may have a term/language with no "as in ..." sentence given. */
  originContext: string | null;
}

export interface VocabEntryRow {
  id: string;
  term: string;
  partOfSpeech: string | null;
  pronunciation: string | null;
  definition: string | null;
  examples: string[] | null;
  enrichmentStatus: string;
  originTerm: string | null;
  originLanguage: string | null;
  originContext: string | null;
  createdAt: string;
}

export interface NewJournalEntry {
  text: string;
  sourceNote: string | null;
  insight: { meaning: string; whenItApplies: readonly string[] };
}

export interface JournalEntryRow {
  id: string;
  text: string;
  sourceNote: string | null;
  insight: { meaning: string; whenItApplies: string[] } | null;
  insightStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewJournalEmbedding {
  entryId: string;
  textSha: string;
  normSha: string;
  model: string;
  embedding: readonly number[];
}

export interface UnembeddedJournalEntry {
  entryId: string;
  textSha: string;
  normSha: string;
  reason: string;
}

export interface DwordWriterOptions {
  /** dword repo dir, resolved on every call (DAILY_WORDS_DIR may change without a restart). */
  repoDir: () => string;
  /** DWORD_USER_EMAIL, resolved on every call, same reasoning as repoDir. */
  userEmail: () => string | undefined;
  timeoutMs?: number;
}

type Exec = (sql: string, params: readonly unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>>;

const INSERT_VOCAB_ENTRY_SQL = `INSERT INTO vocab_entries
  (user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status)
VALUES
  ($1, $2, 'manual', 'active', $3, $4, $5, $6::jsonb, 'ready')
ON CONFLICT (user_id, lower(term)) DO NOTHING
RETURNING id, term, part_of_speech, pronunciation, definition, examples, enrichment_status,
  origin_term, origin_language, origin_context,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

const ATTACH_VOCAB_ORIGIN_SQL = `UPDATE vocab_entries
SET origin_term = $2, origin_language = $3, origin_context = $4
WHERE id = $1 AND user_id = $5 AND origin_term IS NULL
RETURNING id`;

const INSERT_JOURNAL_ENTRY_SQL = `INSERT INTO journal_entries (user_id, text, source_note, insight, insight_status)
VALUES ($1, $2, $3, $4::jsonb, 'ready')
RETURNING id, text, source_note, insight, insight_status,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`;

const INSERT_JOURNAL_EMBEDDING_SQL = `INSERT INTO journal_entry_embeddings
  (entry_id, user_id, status, text_sha, norm_sha, model, embedding)
VALUES ($1, $2, 'ready', $3, $4, $5, $6::vector)`;

/**
 * The "attempted, could not" sibling row dword's own route writes on every save without a vector
 * (~/daily-words/src/lib/journal/duplicate-check.ts `unembedded`, journal-embeddings.ts
 * `upsertEmbedding`): it records norm_sha, which is what lets Layer 1 find this entry with no
 * embedding provider, and dword's backfill embeds it later under --retry-failed.
 */
const INSERT_UNEMBEDDED_JOURNAL_SQL = `INSERT INTO journal_entry_embeddings
  (entry_id, user_id, status, text_sha, norm_sha, failed_reason)
VALUES ($1, $2, 'failed', $3, $4, $5)`;

function toVocabEntryRow(row: Record<string, unknown>): VocabEntryRow {
  return {
    id: String(row.id),
    term: String(row.term),
    partOfSpeech: row.part_of_speech === null || row.part_of_speech === undefined ? null : String(row.part_of_speech),
    pronunciation: row.pronunciation === null || row.pronunciation === undefined ? null : String(row.pronunciation),
    definition: row.definition === null || row.definition === undefined ? null : String(row.definition),
    examples: Array.isArray(row.examples) ? (row.examples as string[]) : null,
    enrichmentStatus: String(row.enrichment_status),
    originTerm: row.origin_term === null || row.origin_term === undefined ? null : String(row.origin_term),
    originLanguage: row.origin_language === null || row.origin_language === undefined ? null : String(row.origin_language),
    originContext: row.origin_context === null || row.origin_context === undefined ? null : String(row.origin_context),
    createdAt: String(row.created_at),
  };
}

function toJournalEntryRow(row: Record<string, unknown>): JournalEntryRow {
  return {
    id: String(row.id),
    text: String(row.text),
    sourceNote: row.source_note === null || row.source_note === undefined ? null : String(row.source_note),
    insight: (row.insight as JournalEntryRow['insight'] | null | undefined) ?? null,
    insightStatus: String(row.insight_status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * The narrow writer of dword's tables. Separate from the read-only connector guard on purpose:
 * the guard stays read-only. Opens one connection per call and closes it — no pooling, no shared
 * state, matching `SeerWriter`. No statement here is ever part of a transaction: a failed
 * `journal_entry_embeddings` insert must never roll back the `journal_entries` row it follows
 * (dword's own rule — a journal entry is allowed to have no embedding yet), and the conditional
 * origin attach on a vocab add is a single statement, not a multi-statement transaction.
 */
export class DwordWriter {
  constructor(private readonly opts: DwordWriterOptions) {}

  private async withClient<T>(fn: (exec: Exec, userId: string) => Promise<T>): Promise<T> {
    const target = loadDatabaseTarget('dword', this.opts.repoDir());
    const timeoutMs = this.opts.timeoutMs ?? WRITE_TIMEOUT_MS;
    const client = new pg.Client({
      connectionString: target.url,
      options: `-c statement_timeout=${timeoutMs} -c TimeZone=UTC`,
      application_name: 'mcp-notes-dword',
      connectionTimeoutMillis: 10_000,
      query_timeout: timeoutMs + 2_000,
      types: CONNECTOR_PG_TYPES,
    });
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      await client.end().catch(() => {});
      throw new DwordWriteError(`daily-words is not reachable for writing: ${scrub(reasonOf(err), target.secrets)}`);
    }
    let userId: string;
    try {
      userId = await resolveUserIdFromClient(client, this.opts.userEmail());
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    const exec: Exec = (sql, params) => {
      assertWritable(sql);
      return client.query<Record<string, unknown>>(sql, [...params]);
    };
    try {
      return await fn(exec, userId);
    } catch (err) {
      if (err instanceof DwordWriteError || err instanceof ConnectorError) throw err;
      throw new DwordWriteError(`dword write failed: ${scrub(reasonOf(err), target.secrets)}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Inserts a new vocab entry; null on a case-insensitive term collision (caller re-looks-up). */
  async insertVocabEntry(input: NewVocabEntry): Promise<VocabEntryRow | null> {
    return this.withClient(async (exec, userId) => {
      const result = await exec(INSERT_VOCAB_ENTRY_SQL, [
        userId,
        input.term,
        input.partOfSpeech,
        input.pronunciation,
        input.definition,
        JSON.stringify(input.examples),
      ]);
      const row = result.rows[0];
      return row === undefined ? null : toVocabEntryRow(row);
    });
  }

  /** D4's conditional attach: true when it set the origin, false when the row already had one (or did not exist / belong to this user). */
  async attachVocabOrigin(vocabEntryId: string, origin: VocabOrigin): Promise<boolean> {
    return this.withClient(async (exec, userId) => {
      const result = await exec(ATTACH_VOCAB_ORIGIN_SQL, [vocabEntryId, origin.originTerm, origin.originLanguage, origin.originContext, userId]);
      return result.rowCount === 1;
    });
  }

  /** Inserts a journal entry with its insight already attached (D2: Claude writes the explanation itself). */
  async insertJournalEntry(input: NewJournalEntry): Promise<JournalEntryRow> {
    return this.withClient(async (exec, userId) => {
      const result = await exec(INSERT_JOURNAL_ENTRY_SQL, [userId, input.text, input.sourceNote, JSON.stringify(input.insight)]);
      const row = result.rows[0];
      if (row === undefined) throw new DwordWriteError('journal_entries insert returned no row');
      return toJournalEntryRow(row);
    });
  }

  /**
   * Inserts a 'ready' embedding row. Callers must only call this when the embedding call
   * succeeded — a failed embedding never blocks `insertJournalEntry`; it records
   * `insertUnembeddedJournalEntry` instead, for dword's own backfill to pick up.
   */
  async insertJournalEmbedding(input: NewJournalEmbedding): Promise<void> {
    await this.withClient(async (exec, userId) => {
      await exec(INSERT_JOURNAL_EMBEDDING_SQL, [input.entryId, userId, input.textSha, input.normSha, input.model, toVectorLiteral(input.embedding)]);
    });
  }

  /** The 'failed' sibling row for an entry saved without a vector (Layer 1 still finds it by norm_sha). */
  async insertUnembeddedJournalEntry(input: UnembeddedJournalEntry): Promise<void> {
    await this.withClient(async (exec, userId) => {
      await exec(INSERT_UNEMBEDDED_JOURNAL_SQL, [input.entryId, userId, input.textSha, input.normSha, input.reason]);
    });
  }
}
