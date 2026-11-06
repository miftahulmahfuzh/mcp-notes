# Phase 2: Writer and rules

**Plan set:** `DWORD_CONNECTOR_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-070115-DW6C_code_analyzer.md`
**Satisfies:** R1, R4 — mirrors dword's own validation ceilings exactly (R1) and specifies the exact
parameterised SQL and allow-list for every write (R4)
**Depends on:** Phase 1 (Connector plumbing)
**Difficulty:** HARD
**Package:** `src/dword`

---

## Goal

After this phase, `src/dword/rules.ts` holds every dword limit mcp-notes must mirror — the POS
enum, the term/context/pronunciation/definition/example ceilings, the insight ceilings and the
daily add limit — each constant commented with the dword source line it came from, plus a test
that diffs those constants against dword's real source whenever `~/daily-words` is checked out.
`src/dword/writer.ts` holds the only code path in mcp-notes that may write to dword's database: a
narrow, allow-listed, fully parameterised writer modeled on `src/adversary/seerWriter.ts`, proved
against a throwaway Postgres rebuilt from dword's own migrations. Neither file has a caller yet
(phases 3 and 4 wire them into MCP tools) — both are complete, independently correct, and inert.

## Interface Contract

**Creates:**
- `src/dword/rules.ts` — `PART_OF_SPEECH_VALUES`, `DwordPartOfSpeech`, `isDwordPartOfSpeech`,
  `MAX_TERM_CHARS`, `MAX_TERM_WORDS`, `MAX_CONTEXT_CHARS`, `validateDwordContext`,
  `DwordContextValidation`, `PRONUNCIATION_MAX_CHARS`, `DEFINITION_TARGET_CHARS`,
  `DEFINITION_MAX_CHARS`, `EXAMPLES_COUNT`, `EXAMPLE_TARGET_CHARS`, `EXAMPLE_MAX_CHARS`,
  `exampleContainsTerm`, `JOURNAL_TEXT_MIN`, `JOURNAL_TEXT_MAX`, `JOURNAL_SOURCE_NOTE_MAX`
  (**[Reconciled]** added during reconciliation — see Handoffs), `INSIGHT_MEANING_MIN_CHARS`,
  `INSIGHT_MEANING_MAX_CHARS`, `INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS`,
  `INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS`, `INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS`,
  `INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS`, `DAILY_ADD_LIMIT` (all `src/dword/rules.ts`).
- `src/dword/writer.ts` — `WRITABLE_TABLES`, `WritableTable`, `DwordWriteError`, `assertWritable`,
  `DwordWriter`, `DwordWriterOptions`, `NewVocabEntry`, `VocabOrigin`, `VocabEntryRow`,
  `NewJournalEntry`, `JournalEntryRow`, `NewJournalEmbedding` (all `src/dword/writer.ts`).
- `tests/unit/dword/writer.test.ts` — `assertWritable` allow-list proof + one `DwordWriter` smoke
  test (missing repo).
- `tests/unit/dword/rules.drift.test.ts` — the drift test against real `~/daily-words` source,
  skips when absent.
- `tests/integration/connectors/dword.writer.int.test.ts` — proves `DwordWriter`'s SQL against a
  throwaway Postgres rebuilt from dword's migrations (phase 1's harness wiring). This name is
  reserved: phases 3/4 name their curated-tool integration tests `dword.vocab.curated.int.test.ts`
  / `dword.journal.curated.int.test.ts`, which is a different layer (MCP tool + rules + writer
  together) and must not duplicate this file's coverage of the writer alone.

**Deletes:** nothing.
**Renames:** nothing.
**Signature changes:** none (new module).

**Requires (from earlier phases):**
- Phase 1 has added `'dword'` to `CONNECTOR_SYSTEMS` / `SYSTEM_META` in `src/connectors/names.ts`
  (this phase's `writer.ts` calls `loadDatabaseTarget('dword', …)`, which needs `SYSTEM_META.dword`
  to exist and type-check as a `SystemId`).
- Phase 1 has added `'dword'` to `tests/integration/connectors/siblings.ts` /
  `tests/integration/connectors/harness.ts` (the `migrationsMarker`/`migrationFiles`/
  `buildSystemDb` functions need no new branches for dword per the analysis, only the new id) and
  to `tests/integration/connectors/globalSetup.ts`'s `CONNECTOR_SYSTEMS` loop, so
  `connectors_dword` is built automatically under `npm run test:int` from dword's real
  `drizzle/*.sql` files.
- **[Reconciled]** Phase 1's real `src/connectors/dword/user.ts` exports
  `resolveDwordUserId(connector: Connector, email: string | null): Promise<string>` — it takes a
  `Connector` (the read-only connector abstraction phases 3/4's MCP tools hold), not a `pg.Client`.
  `Connector.query()` and `pg.Client.query()` return incompatibly-shaped results (array-of-values
  rows vs. object-keyed rows), and this writer opens its own raw `pg.Client` for writing (the
  read-only `Connector.query()` path refuses non-`SELECT` statements) — so `writer.ts` cannot call
  `resolveDwordUserId` itself. Instead it imports phase 1's two refusal-message builders,
  `dwordUserNotConfiguredMessage()` and `dwordUserNotFoundMessage(email)`, and runs the same
  `SELECT id FROM users WHERE email = $1` directly against its own open client, throwing
  `ConnectorError` with the identical wording phase 1's `resolveDwordUserId` throws. This keeps one
  source of truth for the refusal text (R3) while each transport does its own query. See the plan
  index's Reconciliation Log.
- Phase 1 has NOT yet added `DWORD_USER_EMAIL` resolution to a config object this phase reads
  directly — `DwordWriter` takes `userEmail: () => string | undefined` as a constructor option
  (a thunk, exactly like `SeerWriterOptions.repoDir`), so whichever phase wires the MCP tools
  (3/4) decides how that thunk reads `DWORD_USER_EMAIL`. This phase does not read `process.env` or
  `src/config.ts` at all.

**Leaves alone (owned by others):** `src/connectors/*` (phase 1, only imported here); any
`src/mcp/*` file (phases 3/4); `src/chat/*` (phase 6); `claude/skills/*` (phase 5).

## Files

| File | Action | What changes |
|---|---|---|
| `src/dword/rules.ts` | create | every mirrored dword limit, each constant commented with its dword source file/line |
| `src/dword/writer.ts` | create | the allow-listed SQL writer: `assertWritable`, `DwordWriter` |
| `tests/unit/dword/writer.test.ts` | create | `assertWritable` allow-list proof + missing-repo smoke test |
| `tests/unit/dword/rules.drift.test.ts` | create | drift test vs. real `~/daily-words` source, skips when absent |
| `tests/integration/connectors/dword.writer.int.test.ts` | create | `DwordWriter` proved against a throwaway Postgres built from dword's migrations |

## Implementation Steps

### Step 1: `src/dword/rules.ts`

**File:** `src/dword/rules.ts` (new)
**Change:** every limit mcp-notes must mirror from dword, one module, each constant cited.

Every number below was read directly from `~/daily-words`'s real source during this plan's
research (2026-11-06), and matches the analysis document's "Key Data Structures" / "Verified
Facts" sections exactly:
- `src/lib/llm/prompts/vocab-enrich.ts`: `PART_OF_SPEECH_VALUES` (14 values), `pronunciation:
  z.string().trim().max(60)`, `const DEFINITION_TARGET = 60`, `const DEFINITION_MAX = 80`,
  `examples: z.array(z.string().trim().min(1).max(120)).max(3)`, and the prompt's own instruction
  text "Each at most 100 characters" (advisory, not a schema ceiling).
- `src/lib/vocab/normalize.ts`: `export const MAX_TERM_CHARS = 80`, `export const MAX_TERM_WORDS =
  6`, `export const MAX_CONTEXT_CHARS = 200`, and `validateContext(raw)` — checked on the raw,
  untruncated input, which this module mirrors with the same order.
- `src/lib/db/queries/vocab.ts`: `export const DAILY_ADD_LIMIT = 50` (rolling 24h window, not a
  calendar day).
- `src/lib/journal/schemas.ts`: `insightSchema` — `meaning: z.string().trim().min(20).max(220)`,
  `whenItApplies: z.array(z.string().trim().min(8).max(120)).min(2).max(3)`.

**Code (complete file):**
```ts
/**
 * Every limit mcp-notes must mirror from dword (daily-words), in one place (plan invariant 8).
 * Each constant is commented with the dword source file/line it was read from on 2026-11-06.
 * `tests/unit/dword/rules.drift.test.ts` re-reads those files and fails if a number here no
 * longer matches, whenever `~/daily-words` is checked out locally.
 *
 * This module is pure: no I/O, no imports from `src/connectors/*` or `pg`. `src/dword/writer.ts`
 * and the phase 3/4 MCP tools both depend on it; it depends on nothing of mcp-notes' own.
 */

/* --------------------------------- Part of speech -------------------------------- */

/** dword `src/lib/llm/prompts/vocab-enrich.ts:13-28` (`PART_OF_SPEECH_VALUES`). Exact order. */
export const PART_OF_SPEECH_VALUES = [
  'noun',
  'verb',
  'adjective',
  'adverb',
  'pronoun',
  'preposition',
  'conjunction',
  'interjection',
  'determiner',
  'phrase',
  'idiom',
  'phrasal verb',
  'abbreviation',
  'other',
] as const;

export type DwordPartOfSpeech = (typeof PART_OF_SPEECH_VALUES)[number];

export function isDwordPartOfSpeech(value: string): value is DwordPartOfSpeech {
  return (PART_OF_SPEECH_VALUES as readonly string[]).includes(value);
}

/* ------------------------------------- Term --------------------------------------- */

/** dword `src/lib/vocab/normalize.ts:14` (`MAX_TERM_CHARS`). */
export const MAX_TERM_CHARS = 80;

/** dword `src/lib/vocab/normalize.ts:17` (`MAX_TERM_WORDS`). More than this is a sentence. */
export const MAX_TERM_WORDS = 6;

/** Word count for the six-word cap, same rule as dword's `countWords`: split on spaces, drop empties. */
export function countTermWords(term: string): number {
  return term.split(' ').filter(Boolean).length;
}

/* ----------------------------------- Context --------------------------------------- */

/** dword `src/lib/vocab/normalize.ts:104` (`MAX_CONTEXT_CHARS`), the "as in" sentence on `/v`. */
export const MAX_CONTEXT_CHARS = 200;

export type DwordContextErrorCode = 'context_too_long';

export interface DwordContextValidation {
  ok: boolean;
  code?: DwordContextErrorCode;
  message?: string;
}

/**
 * Mirrors dword's `validateContext` (`src/lib/vocab/normalize.ts:149`) exactly, including its
 * order: checked on the RAW, untouched input, before any truncation. Truncating first would
 * silently accept and cut a too-long sentence instead of telling the caller it was too long —
 * dword's own comment states this is deliberate, and this function keeps the same order.
 */
export function validateDwordContext(raw: string): DwordContextValidation {
  if (raw.trim().length > MAX_CONTEXT_CHARS) {
    return { ok: false, code: 'context_too_long', message: "That's too long. One sentence is enough." };
  }
  return { ok: true };
}

/* ------------------------------ Pronunciation / definition ------------------------------- */

/** dword `src/lib/llm/prompts/vocab-enrich.ts:54` (`pronunciation: z.string().trim().max(60)`). */
export const PRONUNCIATION_MAX_CHARS = 60;

/**
 * dword `src/lib/llm/prompts/vocab-enrich.ts:44` (`const DEFINITION_TARGET = 60`) — the prompt's
 * own target, not a hard ceiling. mcp-notes' `/v` flow has Claude write the definition directly
 * (no enrichment prompt call), so this is advisory: aim for it, but `DEFINITION_MAX_CHARS` is the
 * one that must be enforced before a write.
 */
export const DEFINITION_TARGET_CHARS = 60;

/** dword `src/lib/llm/prompts/vocab-enrich.ts:45` (`const DEFINITION_MAX = 80`). The hard ceiling. */
export const DEFINITION_MAX_CHARS = 80;

/* ----------------------------------- Examples ------------------------------------- */

/** dword `src/lib/llm/prompts/vocab-enrich.ts:56,76-81` — exactly 3 examples (non-"unknown" case). */
export const EXAMPLES_COUNT = 3;

/**
 * dword `src/lib/llm/prompts/vocab-enrich.ts:179` — the prompt's own instruction, "Each at most
 * 100 characters." Advisory only: the schema's hard ceiling is `EXAMPLE_MAX_CHARS` (120).
 */
export const EXAMPLE_TARGET_CHARS = 100;

/** dword `src/lib/llm/prompts/vocab-enrich.ts:56` (`z.string().trim().min(1).max(120)`). Hard ceiling. */
export const EXAMPLE_MAX_CHARS = 120;

/**
 * dword's prompt requires each example to "contain the term or an inflected form of it"
 * (`vocab-enrich.ts:179`). mcp-notes' simpler rule (per this plan set's design): each example
 * must contain the term verbatim, case-insensitively — inflected-form matching is not attempted.
 */
export function exampleContainsTerm(example: string, term: string): boolean {
  return example.toLowerCase().includes(term.toLowerCase());
}

/* ------------------------------------ Journal -------------------------------------- */

/**
 * dword `src/lib/journal/limits.ts` (`JOURNAL_TEXT_MIN`). **[Reconciled]** Added during plan
 * reconciliation: phase 4 (journal tools) needs this and the two constants below, and this
 * module's original enumerated list never named `limits.ts` at all — confirmed against the real
 * file during reconciliation, 2026-11-06.
 */
export const JOURNAL_TEXT_MIN = 2;

/** dword `src/lib/journal/limits.ts` (`JOURNAL_TEXT_MAX`). ~150-170 English words. */
export const JOURNAL_TEXT_MAX = 1000;

/** dword `src/lib/journal/limits.ts` (`JOURNAL_SOURCE_NOTE_MAX`). */
export const JOURNAL_SOURCE_NOTE_MAX = 200;

/* ------------------------------------ Insight -------------------------------------- */

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.meaning`, `z.string().trim().min(20)`). */
export const INSIGHT_MEANING_MIN_CHARS = 20;

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.meaning`, `.max(220)`). */
export const INSIGHT_MEANING_MAX_CHARS = 220;

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.whenItApplies`, `.min(2)` items). */
export const INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS = 2;

/** dword `src/lib/journal/schemas.ts:115-118` (`insightSchema.whenItApplies`, `.max(3)` items). */
export const INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS = 3;

/** dword `src/lib/journal/schemas.ts:115-118` (`whenItApplies` item, `z.string().trim().min(8)`). */
export const INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS = 8;

/** dword `src/lib/journal/schemas.ts:115-118` (`whenItApplies` item, `.max(120)`). */
export const INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS = 120;

/* ---------------------------------- Daily limit ------------------------------------- */

/**
 * dword `src/lib/db/queries/vocab.ts:20` (`DAILY_ADD_LIMIT`). A rolling 24h window, not a
 * calendar day — dword's own comment: "needs no timezone and no profile."
 */
export const DAILY_ADD_LIMIT = 50;
```

**Impact:** new module, no existing file changes, nothing imports it yet.

### Step 2: `src/dword/writer.ts`

**File:** `src/dword/writer.ts` (new)
**Change:** the narrow allow-listed SQL writer, modeled directly on `src/adversary/seerWriter.ts`.

**Code (complete file):**
```ts
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
   * succeeded — a failed embedding never blocks `insertJournalEntry` and never calls this at all,
   * matching dword's own backfill expectation that some rows have none yet.
   */
  async insertJournalEmbedding(input: NewJournalEmbedding): Promise<void> {
    await this.withClient(async (exec, userId) => {
      await exec(INSERT_JOURNAL_EMBEDDING_SQL, [input.entryId, userId, input.textSha, input.normSha, input.model, toVectorLiteral(input.embedding)]);
    });
  }
}
```

**Impact:** new module, no existing file changes, nothing imports it yet (inert until phases 3/4).

### Step 3: `tests/unit/dword/writer.test.ts`

**File:** `tests/unit/dword/writer.test.ts` (new)
**Change:** proves the allow-list, mirroring `tests/unit/adversary/seerWriter.test.ts` exactly.

**Code (complete file):**
```ts
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DwordWriteError, DwordWriter, assertWritable } from '../../../src/dword/writer.js';

const INSERT_VOCAB =
  "INSERT INTO vocab_entries (user_id, term, source, status, part_of_speech, pronunciation, definition, examples, enrichment_status) VALUES ($1, $2, 'manual', 'active', $3, $4, $5, $6::jsonb, 'ready') ON CONFLICT (user_id, lower(term)) DO NOTHING RETURNING id";
const ATTACH_ORIGIN =
  'UPDATE vocab_entries SET origin_term = $2, origin_language = $3, origin_context = $4 WHERE id = $1 AND user_id = $5 AND origin_term IS NULL RETURNING id';
const INSERT_JOURNAL = "INSERT INTO journal_entries (user_id, text, source_note, insight, insight_status) VALUES ($1, $2, $3, $4::jsonb, 'ready') RETURNING id";
const INSERT_EMBEDDING =
  "INSERT INTO journal_entry_embeddings (entry_id, user_id, status, text_sha, norm_sha, model, embedding) VALUES ($1, $2, 'ready', $3, $4, $5, $6::vector)";

describe('assertWritable (dword write allow-list)', () => {
  it.each([
    [INSERT_VOCAB, 'vocab_entries'],
    [ATTACH_ORIGIN, 'vocab_entries'],
    [INSERT_JOURNAL, 'journal_entries'],
    [INSERT_EMBEDDING, 'journal_entry_embeddings'],
  ])('allows %s', (sql, table) => {
    expect(assertWritable(sql)).toBe(table);
  });

  it.each([
    'DELETE FROM vocab_entries WHERE id = $1',
    'DELETE FROM journal_entries WHERE id = $1',
    'DELETE FROM journal_entry_embeddings WHERE entry_id = $1',
    'INSERT INTO users (id, email) VALUES ($1, $2)',
    'UPDATE users SET email = $1 WHERE id = $2',
    'UPDATE journal_entries SET text = $1 WHERE id = $2',
    "UPDATE journal_entry_embeddings SET status = 'failed' WHERE entry_id = $1",
    'UPDATE vocab_entries SET definition = $1 WHERE id = $2',
    'UPDATE vocab_entries SET origin_term = $1 WHERE id = $2',
    'UPDATE vocab_entries SET origin_term = $2, origin_language = $3, origin_context = $4 WHERE id = $1 AND user_id = $5',
    'UPDATE vocab_entries SET origin_context = $2, origin_term = $3, origin_language = $4 WHERE id = $1 AND user_id = $5 AND origin_term IS NULL',
    'SELECT * FROM vocab_entries',
    "INSERT INTO vocab_entries (term) VALUES ($1); DROP TABLE vocab_entries",
    'INSERT INTO public.vocab_entries (term) VALUES ($1)',
  ])('refuses %s', (sql) => {
    expect(() => assertWritable(sql)).toThrow(DwordWriteError);
  });
});

describe('DwordWriter', () => {
  it('names the missing daily-words repository instead of connecting anywhere', async () => {
    const writer = new DwordWriter({
      repoDir: () => path.join(tmpdir(), `no-dword-here-${process.pid}`),
      userEmail: () => 'owner@example.com',
    });
    await expect(
      writer.insertJournalEntry({ text: 'hello', sourceNote: null, insight: { meaning: 'm'.repeat(20), whenItApplies: ['a'.repeat(8), 'b'.repeat(8)] } }),
    ).rejects.toThrow(/daily-words is not reachable: no repository/);
  });
});
```

**Impact:** no existing file changes.

### Step 4: `tests/unit/dword/rules.drift.test.ts`

**File:** `tests/unit/dword/rules.drift.test.ts` (new)
**Change:** diffs `src/dword/rules.ts` against dword's real source files, when present.

Chosen location: **`tests/unit`**, not `tests/integration`, because this test needs no database at
all — only file reads — so it belongs where it runs under plain `npm test` (fast, no Docker). It
reuses `siblingRepo` from `tests/integration/connectors/siblings.ts` for the same present/absent
check every other connector test uses (honours `DAILY_WORDS_DIR`, checks for dword's real
migrations), but does **not** import `tests/integration/connectors/harness.ts` — that file pulls
in the MCP SDK and `node:sqlite` for a database-driving harness this test never touches. It also
does **not** use `describeWithRepo`'s shared-callback shape: that helper's own comment warns
"`describe.skip` still runs the callback", so building `vocabEnrich`/`normalize`/etc. by reading
files at the top of a shared callback would throw before the skip took effect when the repo is
absent. This test instead branches at the top level: a full `describe.skip` with no body when the
repo is absent, a full `describe` with real file reads when it is present.

**Code (complete file):**
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SYSTEM_META } from '../../../src/connectors/names.js';
import {
  DAILY_ADD_LIMIT,
  DEFINITION_MAX_CHARS,
  DEFINITION_TARGET_CHARS,
  EXAMPLE_MAX_CHARS,
  EXAMPLE_TARGET_CHARS,
  EXAMPLES_COUNT,
  INSIGHT_MEANING_MAX_CHARS,
  INSIGHT_MEANING_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS,
  INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS,
  INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS,
  INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS,
  JOURNAL_SOURCE_NOTE_MAX,
  JOURNAL_TEXT_MAX,
  JOURNAL_TEXT_MIN,
  MAX_CONTEXT_CHARS,
  MAX_TERM_CHARS,
  MAX_TERM_WORDS,
  PART_OF_SPEECH_VALUES,
  PRONUNCIATION_MAX_CHARS,
} from '../../../src/dword/rules.js';
import { siblingRepo } from '../../integration/connectors/siblings.js';

function dwordFile(repoDir: string, rel: string): string {
  return readFileSync(path.join(repoDir, rel), 'utf8');
}

function extractOne(source: string, pattern: RegExp, file: string): string {
  const match = pattern.exec(source);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`drift test: could not find the expected pattern in dword's ${file} — its source shape changed; update the pattern and the mirrored constant together`);
  }
  return value;
}

const repoDir = siblingRepo('dword');

if (repoDir === null) {
  const meta = SYSTEM_META.dword;
  describe.skip(`dword rules drift [skipped: ${meta.label} repository not found; clone it to ${meta.defaultRepoDir} or set ${meta.repoDirEnv}]`, () => {});
} else {
  const vocabEnrich = dwordFile(repoDir, 'src/lib/llm/prompts/vocab-enrich.ts');
  const normalize = dwordFile(repoDir, 'src/lib/vocab/normalize.ts');
  const vocabQueries = dwordFile(repoDir, 'src/lib/db/queries/vocab.ts');
  const journalSchemas = dwordFile(repoDir, 'src/lib/journal/schemas.ts');
  const journalLimits = dwordFile(repoDir, 'src/lib/journal/limits.ts');

  describe('dword rules drift (src/dword/rules.ts vs. the real ~/daily-words source)', () => {
    it('mirrors PART_OF_SPEECH_VALUES exactly, same order', () => {
      const block = extractOne(vocabEnrich, /PART_OF_SPEECH_VALUES = \[([\s\S]*?)\] as const/, 'vocab-enrich.ts');
      const values = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(values).toEqual([...PART_OF_SPEECH_VALUES]);
    });

    it('mirrors the pronunciation max', () => {
      const n = Number(extractOne(vocabEnrich, /pronunciation:\s*z\.string\(\)\.trim\(\)\.max\((\d+)\)/, 'vocab-enrich.ts'));
      expect(PRONUNCIATION_MAX_CHARS).toBe(n);
    });

    it('mirrors the definition target and max', () => {
      const target = Number(extractOne(vocabEnrich, /const DEFINITION_TARGET = (\d+);/, 'vocab-enrich.ts'));
      const max = Number(extractOne(vocabEnrich, /const DEFINITION_MAX = (\d+);/, 'vocab-enrich.ts'));
      expect(DEFINITION_TARGET_CHARS).toBe(target);
      expect(DEFINITION_MAX_CHARS).toBe(max);
    });

    it('mirrors the examples count, hard ceiling and advisory target', () => {
      const match = vocabEnrich.match(/examples:\s*z\.array\(z\.string\(\)\.trim\(\)\.min\(1\)\.max\((\d+)\)\)\.max\((\d+)\)/);
      const oneMax = match?.[1];
      const arrMax = match?.[2];
      if (oneMax === undefined || arrMax === undefined) throw new Error("drift test: could not find dword's examples schema shape in vocab-enrich.ts");
      expect(EXAMPLE_MAX_CHARS).toBe(Number(oneMax));
      expect(EXAMPLES_COUNT).toBe(Number(arrMax));
      const advisory = Number(extractOne(vocabEnrich, /Each at most (\d+) characters\./, 'vocab-enrich.ts'));
      expect(EXAMPLE_TARGET_CHARS).toBe(advisory);
    });

    it('mirrors the term length/word limits and the context length', () => {
      const maxChars = Number(extractOne(normalize, /export const MAX_TERM_CHARS = (\d+);/, 'normalize.ts'));
      const maxWords = Number(extractOne(normalize, /export const MAX_TERM_WORDS = (\d+);/, 'normalize.ts'));
      const maxContext = Number(extractOne(normalize, /export const MAX_CONTEXT_CHARS = (\d+);/, 'normalize.ts'));
      expect(MAX_TERM_CHARS).toBe(maxChars);
      expect(MAX_TERM_WORDS).toBe(maxWords);
      expect(MAX_CONTEXT_CHARS).toBe(maxContext);
    });

    it('mirrors the daily add limit', () => {
      const n = Number(extractOne(vocabQueries, /export const DAILY_ADD_LIMIT = (\d+);/, 'queries/vocab.ts'));
      expect(DAILY_ADD_LIMIT).toBe(n);
    });

    it('mirrors the journal text and source-note length limits', () => {
      const textMin = Number(extractOne(journalLimits, /export const JOURNAL_TEXT_MIN = (\d+);/, 'journal/limits.ts'));
      const textMax = Number(extractOne(journalLimits, /export const JOURNAL_TEXT_MAX = (\d+);/, 'journal/limits.ts'));
      const sourceNoteMax = Number(extractOne(journalLimits, /export const JOURNAL_SOURCE_NOTE_MAX = (\d+);/, 'journal/limits.ts'));
      expect(JOURNAL_TEXT_MIN).toBe(textMin);
      expect(JOURNAL_TEXT_MAX).toBe(textMax);
      expect(JOURNAL_SOURCE_NOTE_MAX).toBe(sourceNoteMax);
    });

    it('mirrors the insight meaning and whenItApplies bounds', () => {
      const match = journalSchemas.match(
        /meaning:\s*z\.string\(\)\.trim\(\)\.min\((\d+)\)\.max\((\d+)\)[\s\S]*?whenItApplies:\s*z\.array\(z\.string\(\)\.trim\(\)\.min\((\d+)\)\.max\((\d+)\)\)\.min\((\d+)\)\.max\((\d+)\)/,
      );
      if (!match) throw new Error("drift test: could not find dword's insightSchema shape in journal/schemas.ts");
      const [, meaningMin, meaningMax, itemMin, itemMax, itemsMin, itemsMax] = match;
      expect(INSIGHT_MEANING_MIN_CHARS).toBe(Number(meaningMin));
      expect(INSIGHT_MEANING_MAX_CHARS).toBe(Number(meaningMax));
      expect(INSIGHT_WHEN_IT_APPLIES_ITEM_MIN_CHARS).toBe(Number(itemMin));
      expect(INSIGHT_WHEN_IT_APPLIES_ITEM_MAX_CHARS).toBe(Number(itemMax));
      expect(INSIGHT_WHEN_IT_APPLIES_MIN_ITEMS).toBe(Number(itemsMin));
      expect(INSIGHT_WHEN_IT_APPLIES_MAX_ITEMS).toBe(Number(itemsMax));
    });
  });
}
```

**Impact:** no existing file changes. Verified against the real `~/daily-words` checkout present
on this machine during planning: every regex above was matched against the actual file contents
read in this session and produces the values already baked into `rules.ts` in Step 1.

### Step 5: `tests/integration/connectors/dword.writer.int.test.ts`

**File:** `tests/integration/connectors/dword.writer.int.test.ts` (new)
**Change:** proves `DwordWriter`'s SQL for real, against `connectors_dword` (phase 1's harness
wiring rebuilds it from dword's own `drizzle/*.sql` on every `npm run test:int` run). This is the
only artifact-level proof this phase can give — `DwordWriter` has no MCP caller until phases 3/4,
so without this file the only evidence would be the allow-list unit test, which never opens a
connection.

**Code (complete file):**
```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DwordWriter } from '../../../src/dword/writer.js';
import { cleanupHarness, describeWithRepo, seedSystem, systemDbUrl, truncateSystem, withAdmin } from './harness.js';

const OWNER_EMAIL = 'owner@example.com';

let repoDir: string;

function writer(email: string | undefined = OWNER_EMAIL): DwordWriter {
  return new DwordWriter({ repoDir: () => repoDir, userEmail: () => email });
}

async function seedOwner(): Promise<string> {
  await truncateSystem('dword');
  const result = await withAdmin(systemDbUrl('dword'), (c) => c.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [OWNER_EMAIL]));
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('seeding the dword owner row failed');
  return id;
}

describeWithRepo('dword', 'DwordWriter against the dword schema rebuilt from its migrations', () => {
  beforeAll(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), 'mcp-notes-dword-writer-'));
    writeFileSync(path.join(repoDir, '.env.local'), `DATABASE_URL_UNPOOLED=${systemDbUrl('dword')}\n`);
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    cleanupHarness();
  });

  it('inserts a vocab entry with examples and no origin', async () => {
    await seedOwner();
    const row = await writer().insertVocabEntry({
      term: 'genteel',
      partOfSpeech: 'adjective',
      pronunciation: '/dʒɛnˈtiːl/',
      definition: 'polite and refined, straining to seem upper class',
      examples: ['Her genteel manners impressed the household.', 'He kept a genteel appearance.', 'The village had a genteel charm.'],
    });
    expect(row?.term).toBe('genteel');
    expect(row?.originTerm).toBeNull();
    expect(row?.examples).toHaveLength(3);
  });

  it('returns null on a case-insensitive duplicate term instead of failing', async () => {
    const userId = await seedOwner();
    await seedSystem('dword', "INSERT INTO vocab_entries (user_id, term, source, status, enrichment_status) VALUES ($1, 'Genteel', 'manual', 'active', 'ready')", [userId]);
    const row = await writer().insertVocabEntry({
      term: 'genteel',
      partOfSpeech: 'adjective',
      pronunciation: '/dʒɛnˈtiːl/',
      definition: 'polite and refined',
      examples: ['One genteel day.', 'Two genteel ways.', 'Three genteel places.'],
    });
    expect(row).toBeNull();
  });

  it('attaches an origin only when the row has none yet', async () => {
    const userId = await seedOwner();
    const inserted = await withAdmin(systemDbUrl('dword'), (c) =>
      c.query<{ id: string }>("INSERT INTO vocab_entries (user_id, term, source, status, enrichment_status) VALUES ($1, 'smear', 'manual', 'active', 'ready') RETURNING id", [userId]),
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('seed insert returned no row');

    const first = await writer().attachVocabOrigin(id, { originTerm: 'smear', originLanguage: 'English', originContext: 'The paint began to smear in the rain.' });
    expect(first).toBe(true);

    const second = await writer().attachVocabOrigin(id, { originTerm: 'smear', originLanguage: 'English', originContext: 'a different sentence' });
    expect(second).toBe(false);

    const stored = await withAdmin(systemDbUrl('dword'), (c) => c.query<{ origin_context: string }>('SELECT origin_context FROM vocab_entries WHERE id = $1', [id]));
    expect(stored.rows[0]?.origin_context).toBe('The paint began to smear in the rain.');
  });

  it('inserts a journal entry with its insight, ready to read', async () => {
    await seedOwner();
    const row = await writer().insertJournalEntry({
      text: 'Measure twice, cut once.',
      sourceNote: null,
      insight: { meaning: 'Plan carefully before acting to avoid costly mistakes.', whenItApplies: ['Before a big decision', 'When a mistake is expensive to undo'] },
    });
    expect(row.text).toBe('Measure twice, cut once.');
    expect(row.insightStatus).toBe('ready');
    expect(row.insight?.meaning).toContain('Plan carefully');
  });

  it('inserts a journal embedding only when called, and it never blocks the entry insert', async () => {
    await seedOwner();
    const entry = await writer().insertJournalEntry({
      text: 'A stitch in time saves nine.',
      sourceNote: null,
      insight: { meaning: 'Fixing a small problem now prevents a bigger one later.', whenItApplies: ['A small issue is noticed early'] },
    });
    // No embedding call made yet: the row exists with no embeddings row, same as dword's own "not tried" state.
    const before = await withAdmin(systemDbUrl('dword'), (c) => c.query('SELECT 1 FROM journal_entry_embeddings WHERE entry_id = $1', [entry.id]));
    expect(before.rowCount).toBe(0);

    await writer().insertJournalEmbedding({
      entryId: entry.id,
      textSha: 'a'.repeat(64),
      normSha: 'b'.repeat(64),
      model: 'text-embedding-3-small',
      embedding: new Array(1536).fill(0.01),
    });
    const after = await withAdmin(systemDbUrl('dword'), (c) => c.query<{ status: string; model: string }>('SELECT status, model FROM journal_entry_embeddings WHERE entry_id = $1', [entry.id]));
    expect(after.rows[0]?.status).toBe('ready');
    expect(after.rows[0]?.model).toBe('text-embedding-3-small');
  });

  it('refuses to write when the configured email has no dword user', async () => {
    await seedOwner();
    await expect(
      writer('nobody@example.com').insertJournalEntry({ text: 'x', sourceNote: null, insight: { meaning: 'y'.repeat(20), whenItApplies: ['a'.repeat(8), 'b'.repeat(8)] } }),
    ).rejects.toThrow();
  });
});
```

**Impact:** no existing file changes. Depends on phase 1's harness wiring (`'dword'` as a
`SystemId`, `connectors_dword` built by `globalSetup.ts`) and phase 1's `resolveDwordUserId`
(exercised for real here, against a real `users` row and a real miss).

## Principles applied

- **Boundary discipline:** `writer.ts` does zero business validation (no length/word/example
  checks) — it trusts its typed inputs completely. Every ceiling in `rules.ts` is meant to be
  enforced once, at the MCP tool boundary phases 3/4 build, not re-checked here.
- **Make illegal states unrepresentable:** `ORIGIN_ATTACH_ONLY` makes "attach an origin without
  the `origin_term IS NULL` guard" a statement `assertWritable` physically refuses, rather than a
  runtime convention a future call site could get wrong — the regex checks the SQL text's shape,
  not just the table name, the same way `seerWriter.ts`'s `SUPERSEDE_ONLY` already does for Seer.
- **Prove it works:** `DwordWriter` has no caller yet (inert until phases 3/4), so a unit test
  proving only `assertWritable`'s string logic would leave the actual SQL — column names, the
  `ON CONFLICT` target, the `::vector` cast, the `to_char` formatting — completely unverified.
  Step 5 adds a real integration test against a throwaway Postgres rebuilt from dword's own
  migrations, so every statement in `writer.ts` is proved against the real schema before any MCP
  tool exists to call it.
- **Laziness protocol:** reused `toVectorLiteral` from `src/embeddings/repo.ts` instead of writing
  a second vector-literal encoder; reused `siblingRepo` (fs/path only) for the drift test's
  present/absent check instead of importing `tests/integration/connectors/harness.ts`, which pulls
  in the MCP SDK and `node:sqlite` for a database harness this test never touches.
- **Encode lessons in structure:** the drift test (Step 4) turns "this plan cites dword line
  numbers that could rot" into a running check — a future dword change to any mirrored constant
  fails `npm test` with a concrete mismatch instead of silently letting mcp-notes store vocab or
  journal rows dword's own app would now reject.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npx vitest run tests/unit/dword/` (unit; always runs, drift test skips cleanly if
`~/daily-words` is absent) and, once phase 1 has landed, `npm run test:int -- dword.writer`
(requires Docker; builds `connectors_dword` from the real `~/daily-words` migrations).

**Proof:**
- Harness: `no harness` for `verify-notesd` — this phase adds no HTTP route, MCP tool, or wall
  surface a user can reach (phases 3/4 do). `verify-notesd`'s feature map is not touched by this
  phase; proof here is the module's own tests against the real artifact (dword's schema), per the
  Verification commands above.
- Feature-map entries: none — no user-facing behavior changes in this phase.
- Journeys (each a command + the end state that passes it):
  1. `npx vitest run tests/unit/dword/writer.test.ts` — every allowed shape in `assertWritable`'s
     `it.each` returns its table name; every refused shape throws `DwordWriteError`; the
     missing-repo smoke test rejects with `/daily-words is not reachable: no repository/`.
  2. `npx vitest run tests/unit/dword/rules.drift.test.ts` — on this machine, where
     `~/daily-words` is checked out, every `it` passes by reading the real files and comparing;
     on a machine without it, the whole `describe` reports `skipped` (not failed, not silently
     absent from the run).
  3. `npm run test:int -- dword.writer` (after phase 1 lands) —
     `tests/integration/connectors/dword.writer.int.test.ts` passes against `connectors_dword`:
     a vocab insert returns a row with `examples.length === 3`; a second insert of the same term
     differing only in case returns `null`; `attachVocabOrigin` returns `true` once and `false` on
     a second attempt on the same row, and the stored `origin_context` matches the first call's
     value, never the second's; a journal insert returns `insightStatus: 'ready'`; a journal
     embedding insert is independent of the entry insert (no row exists before it is called, a
     `'ready'` row with the exact model string exists after); an unrecognised `DWORD_USER_EMAIL`
     rejects without writing anything.
- Neighbor check: `tests/unit/adversary/seerWriter.test.ts` still passes unchanged —
  `src/dword/writer.ts` is a new, parallel module and touches nothing `SeerWriter` owns.
- Cost: none — no LLM calls, no network calls other than the local throwaway Postgres.

**Exit criteria:** `assertWritable` refuses every statement outside the four allowed shapes
(a second statement, a `DELETE`, any table outside the three, any `UPDATE` without the
`origin_term IS NULL` guard on `vocab_entries`) and accepts exactly those four; the drift test
passes against the real `~/daily-words` present on this machine and skips cleanly when absent;
`npm run typecheck` and `npm test` are green; once phase 1 lands, `npm run test:int` proves every
`DwordWriter` method against a throwaway Postgres built from dword's real migrations.

## Handoffs

- **`TERM_PATTERN` / character-class term validation** (dword `normalize.ts`'s `TERM_PATTERN`,
  rejecting non-Latin terms) is not in `rules.ts`. The phase scope's enumerated list of limits to
  mirror names only `MAX_TERM_CHARS`/`MAX_TERM_WORDS`, not the character class. If phase 3's `/v`
  validation needs to reject terms with unsupported characters, it must add that constant/function
  to `src/dword/rules.ts` (not a second copy elsewhere) to keep plan invariant 8 ("one module")
  true — this phase deliberately leaves that decision to phase 3, since it owns the validation
  call site and knows whether Claude-authored terms ever need the check.
- **Daily-limit enforcement** (counting a user's adds in the rolling 24h window against
  `DAILY_ADD_LIMIT`) is phase 3's job: it requires a read-only query against `vocab_entries`,
  which belongs with the curated read tools, not this phase's writer. `rules.ts` only exports the
  number.
- **`exampleContainsTerm` / `validateDwordContext` call sites** are phase 3/4's job (invoking them
  before calling `DwordWriter`); this phase only exports the functions.
- **dword's dedup algorithm** (`normalizeForDedup`, `foldMorphology`, `dedupKey`,
  `findNearDuplicate`, `findEntryByNormalizedTerm`, `listTermsForDedup`) is entirely out of this
  phase's scope — `rules.ts` holds limits, not dedup logic, and phase 3 owns `dword_vocab_lookup`.
- **[Reconciled] `NEAR_DUPLICATE_MAX_DISTANCE = 0.25`** (dword `src/lib/journal/similarity.ts:176`)
  lives in `src/dword/journalSimilarity.ts` (phase 4), not here: it is a dedup-algorithm threshold,
  not a form-validation ceiling like this file's constants, and phase 4 already ports
  `similarity.ts`'s Layer-1 hashing into that same file, so the one constant from the same source
  file belongs alongside them rather than in this module. Invariant 8 ("dword's limits ... live in
  exactly one module, `src/dword/rules.ts`") is read as governing validation ceilings (POS enum,
  char/word/example/insight limits — everything this file actually holds); a dedup-comparison
  threshold is a different kind of constant, and `journalSimilarity.ts`'s own comment names
  `similarity.ts:176` as its source, which keeps the "mirror, cite the source" spirit of the
  invariant even though the constant is not physically in this file. See the plan index's
  Reconciliation Log and Decisions table.
- **Where `DWORD_USER_EMAIL` is read into a thunk** (`DwordWriterOptions.userEmail`) is phase 3/4's
  wiring code, not this phase — this phase only defines the shape it needs (`() => string |
  undefined`).

## Rollback

Delete `src/dword/rules.ts`, `src/dword/writer.ts`, `tests/unit/dword/`, and
`tests/integration/connectors/dword.writer.int.test.ts`. Nothing else references them yet (no
MCP tool, no route, no skill), so removal is a plain file deletion with no follow-on edits. No
state in dword's database is created by this phase outside test runs against the throwaway
`connectors_dword` database, which `npm run test:int`'s next run rebuilds from scratch anyway.
