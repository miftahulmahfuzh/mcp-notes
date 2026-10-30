> Adopted from `/home/miftah/.worktrees/mcp-notes/semantic-search/.workflows/orchestration/semantic-search/PLAN.md` phase 1. Source: `.workflows/plan/semantic-search/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: pgvector schema, migration, embedding state + repo

**Plan set:** `SEMANTIC_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261030-140513-S6EM_code_analyzer.md`
**Satisfies:** R2 (pgvector schema, migration 0001, pgvector test container), R1 (the hash/staleness rules and the retry bookkeeping only; the client is phase 2, the trigger/loop is phase 3), R6 (this phase's own tests: unit tests for the stale-embedding logic, integration tests for the repo and migration on the pgvector container)
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/embeddings`, `src/db`, `drizzle`, `scripts`

---

## Goal

After this phase the notes database has the `vector` extension and a `note_embeddings` side table (HNSW cosine index), created by the first new migration since iteration 1, and the integration container runs `pgvector/pgvector:pg16`. `src/embeddings/` holds the constants, the pure staleness rules (`state.ts`) and every `note_embeddings` query the worker and search need (`repo.ts`, minus `nearestNotes`). Nothing calls them yet; no runtime behaviour changes.

**Verified before writing this plan.** Every code block below was built in a scratch copy of the worktree at `66b8e98` and run: `tsc -p tsconfig.json` and `tsc -p tsconfig.web.json` clean, `vitest run` 49 files / 514 tests green, and the full integration suite (16 files / 172 tests, including the 42 in the two files this phase adds or extends) green against a throwaway `pgvector/pgvector:pg16` container (pgvector 0.8.7; Neon has 0.8.6, which is fine for HNSW + `vector_cosine_ops`). The JS hash equals `encode(sha256(convert_to(body,'UTF8')),'hex')` for ASCII, emoji (incl. ZWJ + skin-tone sequences), CRLF, LF, accents/CJK, empty and a 20 000-char body. The `ensure_container` change was exercised end to end (create on postgres:16 → recreate on pgvector → reuse → start stopped).

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/embeddings/constants.ts`: `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MAX_CHARS`, `OPENROUTER_EMBEDDINGS_URL` (exactly the index contract).
- `src/embeddings/state.ts`: `bodySha256`, `embedInput`, `EmbeddingState`, `StoredEmbedding`, `embeddingState`, `retryDelayMs` (index contract), **plus** `clampError(message: string): string` (redacts `sk-or-…` / `Bearer …`, collapses whitespace, ≤ 500 chars). `recordFailure` applies it, so callers (phase 3) pass raw messages.
- `src/embeddings/repo.ts`: `currentBodySha256Sql`, `isCurrentEmbeddingSql`, `PendingNote`, `listPending`, `saveEmbedding`, `recordFailure`, `EmbeddingStats`, `embeddingStats`, `toVectorLiteral` (index contract; `nearestNotes` is phase 5's).
- `src/db/schema.ts`: `noteEmbeddings` table (`note_embeddings`).
- `drizzle/0001_note_embeddings.sql`, `drizzle/meta/0001_snapshot.json`, new entry in `drizzle/meta/_journal.json`.
- `tests/unit/embeddings.state.test.ts`, `tests/integration/embeddings.repo.int.test.ts`.

**Signature changes:** none to existing symbols. `truncateAll(db)` keeps its signature and now also empties `note_embeddings`.

**Contract refinements (within the index's signatures, the reconciler should note them):**
1. `isCurrentEmbeddingSql(model)` / `currentBodySha256Sql()` interpolate Drizzle columns, which render as `"notes"."body"` and `"note_embeddings"."…"`. **Queries that use them must reference `notes` and `note_embeddings` by their real names, never aliased** (phase 4 hybrid query, phase 5 `nearestNotes`). On a `left join` with no row the predicate is NULL, not false: wrap in `coalesce(…, false)` where that matters.
2. `toVectorLiteral` throws on a non-finite element (`NaN`/`Infinity` would serialise to `null` and fail in Postgres anyway).
3. `saveEmbedding` throws (before any query) when `embedding.length !== EMBEDDING_DIMENSIONS`. Phase 2's embedder already checks width, so this only fires on a bug.
4. `recordFailure`: `attempts` continues only when the previous row is a failure for the same `bodySha256` **and** the same `model` (a model change restarts at 1). It is a **no-op** when (a) the note's current body no longer hashes to `bodySha256` (the new body is pending anyway), (b) the row already holds a vector for this hash + model (another daemon succeeded), or (c) the note does not exist (no FK error). It writes `clampError(error)`.
5. "Non-empty trimmed body" in SQL is a regex bound as a parameter that matches exactly the characters JS `String.prototype.trim` keeps, so `listPending` / `embeddingStats` agree with `embedInput(body) !== null` (tested with a body of `\u00a0\u3000\ufeff\u2028`). A pending note therefore always has a non-null `embedInput`.
6. `embeddingStats` counts over **all** notes (live and deleted), the same universe as `listPending`, so "pending 0" after a backfill means `listPending(…, { ignoreBackoff: true })` is empty. `pending = withText - current` (includes failures not yet due); `failing` = failure rows for the current body + model.
7. `retryDelayMs(n)` treats `n < 1` and `NaN` as 1.

**Requires (from earlier phases):** none.
**Leaves alone (owned by others):** `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `src/notes/service.ts`, `tests/helpers/fakeEmbedder.ts`, `src/embeddings/embedder.ts`, `src/embeddings/openrouter.ts` (phase 2); `src/embeddings/worker.ts`, `src/embeddings/backfill.ts`, `src/background.ts`, `src/cli/*`, `package.json` (phase 3); `src/search/*`, `src/notes/repo.ts`, `src/notes/types.ts`, `src/mcp/*` (phase 4); `nearestNotes`, `src/chat/*` (phase 5); `vitest.config.ts`, `tests/live/*`, docs other than README's test-container sentence, Neon (phase 6). `web/**` untouched.

## Files

| File | Action | What changes |
|---|---|---|
| `src/embeddings/constants.ts` | create | the four constants |
| `src/embeddings/state.ts` | create | pure hash / input / state / backoff / error-clamp helpers |
| `src/embeddings/repo.ts` | create | SQL fragments + `listPending`, `saveEmbedding`, `recordFailure`, `embeddingStats`, `toVectorLiteral` |
| `src/db/schema.ts` | modify | `:2` import `integer`, `vector`; `:4-7` header comment; insert `noteEmbeddings` before `:79` (`export type NoteRow`) |
| `drizzle/0001_note_embeddings.sql` | create (generated + 1 hand-prepended line) | extension, table, FK, two indexes |
| `drizzle/meta/0001_snapshot.json` | create (generated, not edited) | snapshot incl. `note_embeddings` |
| `drizzle/meta/_journal.json` | modify (generated) | `idx: 1`, `tag: 0001_note_embeddings` |
| `scripts/test-int.sh` | modify | `:5` comment, `:19` `NOTES_IMAGE`, `:33-41` recreate on image mismatch |
| `tests/integration/setup.ts` | modify | `:50` truncate `note_embeddings` too |
| `tests/integration/schema.int.test.ts` | modify | `:5-6` imports, `:31` describe name, `:59` index names, 4 new `it`s before `:163` |
| `tests/integration/embeddings.repo.int.test.ts` | create | hash parity, pending, save guard, failure semantics, current predicate, stats |
| `tests/unit/embeddings.state.test.ts` | create | constants, hash, input clamp, state matrix, backoff, error clamp, vector literal |
| `README.md` | modify | `:384-385` test-container sentence |

13 files.

## Implementation Steps

### Step 1: Constants
**File:** `src/embeddings/constants.ts` (new)
**Code:**
```ts
/**
 * Embedding constants shared by the schema check, the embedder (phase 2), the worker (phase 3),
 * hybrid search (phase 4) and `related` (phase 5). Mirrors ~/run-insights/lib/nina/embedding.ts
 * (read for reference, never imported).
 *
 * EMBEDDING_DIMENSIONS must equal the `vector(1536)` width in src/db/schema.ts
 * (`noteEmbeddings.embedding`); tests/unit/embeddings.state.test.ts asserts it. Changing the
 * model or the width means a new migration plus a full re-embed (`npm run embed:backfill`).
 */
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
/** run-insights' clamp: input is trimmed then truncated to this many UTF-16 units, no marker. */
export const EMBEDDING_MAX_CHARS = 8_000;
export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
```
**Impact:** none (new module). `src/` uses semicolons (as in `src/notes/*`); tests do not.

### Step 2: Pure state helpers
**File:** `src/embeddings/state.ts` (new)
**Code:**
```ts
import { createHash } from 'node:crypto';

import { EMBEDDING_MAX_CHARS } from './constants.js';

/**
 * Pure rules for "does this note's embedding match its body?". No I/O.
 *
 * A note's embedding is tied to the body it was made from by `body_sha256`. The SQL side
 * (src/embeddings/repo.ts `currentBodySha256Sql`) computes the same hex digest with
 * `encode(sha256(convert_to(body, 'UTF8')), 'hex')`; the integration tests assert the two agree.
 */

/** Hex sha256 of the UTF-8 encoding of `body`. Equal to `currentBodySha256Sql()` for the same body. */
export function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * What gets sent to the embedder: the body trimmed (JS `String.prototype.trim`) and cut to
 * EMBEDDING_MAX_CHARS without a marker. Null when nothing is left: such a note (e.g. a photo
 * with no text) has no embedding. A cut that would split a surrogate pair drops the lone half.
 */
export function embedInput(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;
  if (trimmed.length <= EMBEDDING_MAX_CHARS) return trimmed;
  let cut = trimmed.slice(0, EMBEDDING_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * - `none`: the body is empty after trim; no embedding is needed.
 * - `missing`: no stored row.
 * - `stale`: a row exists but for another body hash or another model (re-embed, no backoff).
 * - `failed`: the row is for this body and model but holds no vector (last attempt failed).
 * - `current`: the row holds a vector for this body and model.
 */
export type EmbeddingState = 'current' | 'stale' | 'missing' | 'failed' | 'none';

/** The parts of a `note_embeddings` row the state depends on. */
export interface StoredEmbedding {
  bodySha256: string;
  model: string;
  hasVector: boolean;
  attempts: number;
}

export function embeddingState(body: string, stored: StoredEmbedding | null, model: string): EmbeddingState {
  if (embedInput(body) === null) return 'none';
  if (stored === null) return 'missing';
  if (stored.bodySha256 !== bodySha256(body) || stored.model !== model) return 'stale';
  return stored.hasVector ? 'current' : 'failed';
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;

/**
 * Wait before the next attempt after `attempts` consecutive failures for the same body:
 * 30 s, 1 min, 2 min, ... doubling, capped at 1 h. `attempts` below 1 is treated as 1.
 */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.trunc(Number.isFinite(attempts) ? attempts : 1));
  // 2^7 * 30 s already exceeds the cap; stop the exponent there so huge counts cannot overflow.
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n - 1, 7));
}

const MAX_ERROR_CHARS = 500;

/**
 * An error message fit for `note_embeddings.last_error`: OpenRouter keys (`sk-or-...`) and
 * `Bearer ...` tokens replaced with `[redacted]`, whitespace collapsed, at most 500 chars.
 */
export function clampError(message: string): string {
  const cleaned = message
    .replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= MAX_ERROR_CHARS ? cleaned : cleaned.slice(0, MAX_ERROR_CHARS);
}
```
**Impact:** none (new module, no I/O).

### Step 3: Schema table
**File:** `src/db/schema.ts`

3a. `:2`, replace the pg-core import:
```ts
import { bigserial, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core'
```

3b. `:4-7`, replace the stale header comment (it says no later phase adds a migration):
```ts
/**
 * The notes schema. Migration 0000 (drizzle/0000_init.sql, iterations 1-3) created `notes` and
 * `note_revisions`; migration 0001 (iteration 6, semantic search) adds the pgvector extension and
 * `note_embeddings`. Change a table here, then `npm run db:generate`; never edit an applied
 * migration. drizzle-kit does not emit `CREATE EXTENSION`, so 0001 carries a hand-prepended
 * `CREATE EXTENSION IF NOT EXISTS vector`.
 */
```

3c. Insert immediately before `:79` (`export type NoteRow = typeof notes.$inferSelect`), after the `noteRevisions` table, followed by a blank line:
```ts
/**
 * One row per note that has (or had) text to embed. Iteration 6 (semantic search), migration
 * 0001. A side table, not a column on `notes`, so `db.select().from(notes)` (every list, get and
 * search) never drags 1536 floats along, and the vector never enters `NoteRow`.
 *
 * The vector is *current* iff `embedding is not null`, `body_sha256` equals the note's current
 * body hash and `model` equals EMBEDDING_MODEL (src/embeddings/repo.ts `isCurrentEmbeddingSql`).
 * Deleted notes keep their row, so a restore needs no embedding call.
 */
export const noteEmbeddings = pgTable(
  'note_embeddings',
  {
    noteId: text('note_id')
      .primaryKey()
      .references(() => notes.id, { onDelete: 'cascade' }),
    /** Null while the latest attempt for `body_sha256` failed. Width = EMBEDDING_DIMENSIONS (unit test asserts it). */
    embedding: vector('embedding', { dimensions: 1536 }),
    /** Hex sha256 of the UTF-8 body this row refers to (embedded, or whose embedding failed). */
    bodySha256: text('body_sha256').notNull(),
    /** Model id the vector came from, e.g. `openai/text-embedding-3-small`. */
    model: text('model').notNull(),
    /** Consecutive failures for this `body_sha256` + `model`; 0 after a success. */
    attempts: integer('attempts').notNull().default(0),
    /** At most 500 chars, keys redacted (src/embeddings/state.ts `clampError`). */
    lastError: text('last_error'),
    /** Failures only: not retried before this time. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    /** When `embedding` was written. Null on a failure row. */
    embeddedAt: timestamp('embedded_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('note_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('note_embeddings_next_attempt_idx').on(t.nextAttemptAt),
  ],
)
```
The width is a literal (not `EMBEDDING_DIMENSIONS`) on purpose: `schema.ts` is loaded by drizzle-kit's own loader, and keeping it free of app imports keeps `db:generate` independent of `src/embeddings`. The unit test in step 9 asserts that `noteEmbeddings.embedding.getSQLType()` equals `vector(1536)` built from `EMBEDDING_DIMENSIONS`.

No `$inferSelect` type is exported for the table: nothing outside `src/embeddings/repo.ts` should read rows of it.

**Impact:** `schema` (re-exported by `src/db/client.ts`) gains a table; the drizzle client is typed with it. No existing query changes.

### Step 4: Generate migration 0001 and hand-prepend the extension
**Files:** `drizzle/0001_note_embeddings.sql`, `drizzle/meta/0001_snapshot.json`, `drizzle/meta/_journal.json`

Run from the worktree root (after `npm ci` if `node_modules` is missing):
```sh
cd /home/miftah/.worktrees/mcp-notes/semantic-search
ln -sf /home/miftah/mcp-notes/.env.local .env.local     # drizzle.config.ts throws without a direct URL, even for generate
npx drizzle-kit generate --name note_embeddings
sed -i '1i CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint' drizzle/0001_note_embeddings.sql
```
`generate` makes no connection. If the symlink is unwanted, `DATABASE_URL=postgres://u:p@127.0.0.1:1/x npx drizzle-kit generate --name note_embeddings` produces byte-identical SQL (verified). The `.env.local` symlink is gitignored; do not commit it.

`--name` fixes the file name; do not accept a random tag. drizzle-kit prints `note_embeddings 9 columns 2 indexes 1 fks`. The resulting **`drizzle/0001_note_embeddings.sql` must be exactly**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "note_embeddings" (
	"note_id" text PRIMARY KEY NOT NULL,
	"embedding" vector(1536),
	"body_sha256" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "note_embeddings" ADD CONSTRAINT "note_embeddings_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_embeddings_embedding_hnsw_idx" ON "note_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "note_embeddings_next_attempt_idx" ON "note_embeddings" USING btree ("next_attempt_at");
```
(no trailing newline after the last statement, as drizzle-kit writes it.)

`drizzle/meta/_journal.json` gains one entry (only `when` differs run to run):
```json
    {
      "idx": 1,
      "version": "7",
      "when": <generation time in ms>,
      "tag": "0001_note_embeddings",
      "breakpoints": true
    }
```
`drizzle/meta/0001_snapshot.json` is generated, never hand-edited: its `prevId` is `67b8ea1d-f877-4cd1-9b6b-d25e798ce8b2` (0000's `id`), its `id` is a fresh UUID, and `tables["public.note_embeddings"]` lists the nine columns (`embedding` as `"type": "vector(1536)"`), the HNSW index with `"opclass": "vector_cosine_ops"`, `"method": "hnsw"`, and the FK `note_embeddings_note_id_notes_id_fk` with `onDelete: cascade`. The snapshot does not record the extension, so a later `generate` will not try to drop it.

Sanity check: `npx drizzle-kit generate --name noop` right after must report "No schema changes" (then delete nothing; it writes no file).

**Impact:** `migrate()` in `tests/integration/setup.ts` and `npm run db:migrate` now apply 0001. Additive only: `CREATE EXTENSION IF NOT EXISTS`, a new table, its FK and indexes. On plain `postgres:16` it fails (`extension "vector" is not available`), which is why step 5 must land in the same commit.

### Step 5: Integration container on pgvector, recreated on image mismatch
**File:** `scripts/test-int.sh`

5a. `:5`, header comment line:
```bash
#   mcp-notes-pg-test        pgvector/pgvector:pg16  127.0.0.1:55433  notes schema (drizzle/*.sql)
```
and add after `:8` (`# Exports TEST_DATABASE_URL ...`):
```bash
# A container created from another image than the one named here is removed and recreated.
```

5b. `:19`:
```bash
NOTES_IMAGE=pgvector/pgvector:pg16
```

5c. `:33-41`, replace from `# ensure_container NAME IMAGE HOST_PORT DB` down to and including the first `  fi` and the following `  case "$state" in` line with:
```bash
# ensure_container NAME IMAGE HOST_PORT DB
# A container that exists but was created from another image (e.g. mcp-notes-pg-test from the
# days of plain postgres:16) is removed and recreated: both containers hold test data only.
ensure_container() {
  local name=$1 image=$2 port=$3 db=$4 state current ready=0
  # docker inspect prints a blank line on stdout for an unknown container, so the
  # exit status decides "missing", not the output.
  if ! state="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)"; then
    state=missing
  fi
  if [ "$state" != missing ]; then
    current="$(docker inspect -f '{{.Config.Image}}' "$name")"
    if [ "$current" != "$image" ]; then
      echo "test-int: $name runs $current, not $image; recreating it (it holds test data only)"
      docker rm -f "$name" >/dev/null
      state=missing
    fi
  fi
  case "$state" in
```
The rest of the function (the `case` arms, the readiness loop) is unchanged. `.Config.Image` is the image reference given to `docker run` (`postgres:16`, `pgvector/pgvector:pg16`), so the comparison is by name, exactly as the script spells it.

**Impact:** on this machine the first `npm run test:int` prints `test-int: mcp-notes-pg-test runs postgres:16, not pgvector/pgvector:pg16; recreating it (it holds test data only)` and recreates the container (the image is already pulled for the connectors container). `mcp-notes-pg-connectors` already runs that image and is reused. `mcp-notes-pg-demo` (55434) and `seer-pg` are never touched (different names). A second machine (GPD) recreates its container the same way on first run.

### Step 6: truncateAll empties note_embeddings
**File:** `tests/integration/setup.ts:50`
**Code:**
```ts
/** Empties every app table. Call in `beforeEach` of any file that writes. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table note_embeddings, note_revisions, notes restart identity cascade`)
}
```
**Impact:** `cascade` already reached it through the FK; listing it makes the intent explicit and survives a future FK change.

### Step 7: Embedding repo
**File:** `src/embeddings/repo.ts` (new)
**Code:**
```ts
import { sql, type SQL } from 'drizzle-orm';

import { noteEmbeddings, notes } from '../db/schema.js';
import type { Executor } from '../notes/repo.js';
import { EMBEDDING_DIMENSIONS } from './constants.js';
import { clampError, retryDelayMs } from './state.js';

/**
 * Queries on `note_embeddings`. Every statement here refers to the tables by their real names
 * (`notes`, `note_embeddings`) with no alias, because the SQL fragments below interpolate
 * Drizzle columns, which render as `"notes"."body"` / `"note_embeddings"."embedding"`.
 * Callers that join these fragments into their own queries (phase 4 search, phase 5 related)
 * must not alias the two tables either.
 *
 * The vector column is never selected here except by the callers that rank by it; it never
 * enters `NoteRow`, the wire `Note`, or a log line.
 */

/** `encode(sha256(convert_to(notes.body, 'UTF8')), 'hex')`: the SQL twin of `bodySha256`. */
export function currentBodySha256Sql(): SQL {
  return sql`encode(sha256(convert_to(${notes.body}, 'UTF8')), 'hex')`;
}

/**
 * True when the joined `note_embeddings` row holds a vector made from the note's current body
 * by `model`. Null (not false) when the left join found no row; wrap in `coalesce(..., false)`
 * where that matters.
 */
export function isCurrentEmbeddingSql(model: string): SQL {
  return sql`(${noteEmbeddings.embedding} is not null and ${noteEmbeddings.bodySha256} = ${currentBodySha256Sql()} and ${noteEmbeddings.model} = ${model})`;
}

/**
 * Postgres regex matching any character JS `String.prototype.trim` keeps, so
 * `body ~ NON_BLANK_PATTERN` is exactly `embedInput(body) !== null`. Bound as a parameter, so
 * the backslash escapes reach the regex engine untouched.
 */
const NON_BLANK_PATTERN =
  '[^\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';

function hasTextSql(): SQL {
  return sql`(${notes.body} ~ ${NON_BLANK_PATTERN})`;
}

/** `JSON.stringify` of the vector, for binding as `${toVectorLiteral(v)}::vector`. Rejects NaN/Infinity. */
export function toVectorLiteral(v: readonly number[]): string {
  for (const x of v) {
    if (!Number.isFinite(x)) throw new Error('embedding contains a non-finite value');
  }
  return JSON.stringify(Array.from(v));
}

export interface PendingNote {
  id: string;
  body: string;
  /** Hash of `body` as read; pass it back to `saveEmbedding` / `recordFailure` unchanged. */
  bodySha256: string;
}

/**
 * Notes that need an embedding: live AND deleted (so a restore never needs a call), with a
 * non-blank body, whose row is missing, stale (other body hash or other model), or failed
 * for this body and due (`next_attempt_at <= now()`; `ignoreBackoff` makes every failure due).
 * Live notes first, then most recently updated, then id.
 */
export async function listPending(
  db: Executor,
  opts: { model: string; limit: number; ignoreBackoff?: boolean },
): Promise<PendingNote[]> {
  const limit = Math.max(1, Math.trunc(opts.limit));
  const due = opts.ignoreBackoff
    ? sql`true`
    : sql`(note_embeddings.next_attempt_at is null or note_embeddings.next_attempt_at <= now())`;
  const res = await db.execute<{ id: string; body: string; body_sha256: string }>(sql`
    select notes.id, notes.body, ${currentBodySha256Sql()} as body_sha256
    from notes
    left join note_embeddings on note_embeddings.note_id = notes.id
    where ${hasTextSql()}
      and (
        note_embeddings.note_id is null
        or note_embeddings.model <> ${opts.model}
        or note_embeddings.body_sha256 <> ${currentBodySha256Sql()}
        or (note_embeddings.embedding is null and ${due})
      )
    order by (notes.deleted_at is null) desc, notes.updated_at desc, notes.id asc
    limit ${limit}
  `);
  return res.rows.map((r) => ({ id: r.id, body: r.body, bodySha256: r.body_sha256 }));
}

/**
 * Stores a vector for `noteId`, but only if the note's body still hashes to `bodySha256`
 * (the body may have changed while the embedding call was in flight). Resets attempts,
 * last_error and next_attempt_at. Returns false when skipped (body changed or note gone).
 * Idempotent: two daemons saving the same vector leave the same row.
 */
export async function saveEmbedding(
  db: Executor,
  v: { noteId: string; bodySha256: string; model: string; embedding: number[] },
): Promise<boolean> {
  if (v.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding has ${v.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  }
  const literal = toVectorLiteral(v.embedding);
  const res = await db.execute<{ note_id: string }>(sql`
    insert into note_embeddings
      (note_id, embedding, body_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select notes.id, ${literal}::vector, ${v.bodySha256}, ${v.model}, 0, null, null, now(), now()
    from notes
    where notes.id = ${v.noteId} and ${currentBodySha256Sql()} = ${v.bodySha256}
    on conflict (note_id) do update set
      embedding = excluded.embedding,
      body_sha256 = excluded.body_sha256,
      model = excluded.model,
      attempts = 0,
      last_error = null,
      next_attempt_at = null,
      embedded_at = excluded.embedded_at,
      updated_at = excluded.updated_at
    returning note_id
  `);
  return res.rows.length > 0;
}

/**
 * Records a failed embedding attempt: embedding := NULL, attempts := previous + 1 when the
 * previous row was already a failure for this same body hash and model, else 1;
 * next_attempt_at := now() + retryDelayMs(attempts); last_error := clampError(error).
 *
 * No-op when the note's body no longer hashes to `bodySha256` (the new body is pending anyway)
 * or when the row already holds a vector for this body and model (another daemon succeeded).
 */
export async function recordFailure(
  db: Executor,
  v: { noteId: string; bodySha256: string; model: string; error: string },
): Promise<void> {
  const prev = await db.execute<{ body_sha256: string; model: string; attempts: number; has_vector: boolean }>(sql`
    select body_sha256, model, attempts, embedding is not null as has_vector
    from note_embeddings
    where note_id = ${v.noteId}
  `);
  const row = prev.rows[0];
  const sameTarget = row !== undefined && row.body_sha256 === v.bodySha256 && row.model === v.model;
  if (sameTarget && row.has_vector) return;
  const attempts = sameTarget ? row.attempts + 1 : 1;
  const delayMs = retryDelayMs(attempts);
  await db.execute(sql`
    insert into note_embeddings
      (note_id, embedding, body_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select notes.id, null, ${v.bodySha256}, ${v.model}, ${attempts}::integer, ${clampError(v.error)},
           now() + ${delayMs}::integer * interval '1 millisecond', null, now()
    from notes
    where notes.id = ${v.noteId} and ${currentBodySha256Sql()} = ${v.bodySha256}
    on conflict (note_id) do update set
      embedding = null,
      body_sha256 = excluded.body_sha256,
      model = excluded.model,
      attempts = excluded.attempts,
      last_error = excluded.last_error,
      next_attempt_at = excluded.next_attempt_at,
      embedded_at = null,
      updated_at = excluded.updated_at
    where not (
      note_embeddings.embedding is not null
      and note_embeddings.body_sha256 = excluded.body_sha256
      and note_embeddings.model = excluded.model
    )
  `);
}

/** Counts over every note (live and deleted), matching `listPending`'s universe. */
export interface EmbeddingStats {
  /** Notes whose body is non-blank, i.e. that should have an embedding. */
  withText: number;
  /** Of those, notes with a current vector for `model`. */
  current: number;
  /** `withText - current`: missing, stale or failed (due or not). `0` means fully embedded. */
  pending: number;
  /** Of the pending, notes whose last attempt for this body and model failed. */
  failing: number;
}

export async function embeddingStats(db: Executor, model: string): Promise<EmbeddingStats> {
  const res = await db.execute<{ with_text: number; current: number; failing: number }>(sql`
    select
      count(*)::int as with_text,
      count(*) filter (where coalesce(${isCurrentEmbeddingSql(model)}, false))::int as current,
      count(*) filter (
        where note_embeddings.embedding is null
          and note_embeddings.body_sha256 = ${currentBodySha256Sql()}
          and note_embeddings.model = ${model}
      )::int as failing
    from notes
    left join note_embeddings on note_embeddings.note_id = notes.id
    where ${hasTextSql()}
  `);
  const r = res.rows[0];
  const withText = r?.with_text ?? 0;
  const current = r?.current ?? 0;
  return { withText, current, pending: withText - current, failing: r?.failing ?? 0 };
}
```
Notes for the implementer:
- `Executor` is imported type-only from `src/notes/repo.ts` (no runtime dependency on the notes repo).
- Everything is raw `db.execute(sql…)` with unaliased table names, because the shared fragments interpolate Drizzle columns (qualified names). `res.rows` works on both drivers (`Db` is typed as node-postgres; the Neon pool returns the same shape), as everywhere else in the repo.
- `saveEmbedding` and `recordFailure` are `insert … select … from notes where notes.id = $id and <hash> = $sha … on conflict (note_id) do update`. The `select` both enforces the body guard and avoids an FK violation for an unknown id. Two daemons racing on the same note produce the same row (idempotent upsert).
- `recordFailure` reads the previous row first to compute `attempts` and the delay in JS (single source: `retryDelayMs`), then upserts with `now() + delay * interval '1 millisecond'` so `next_attempt_at` is on the database clock that `listPending` compares against. The `on conflict … where not (…)` clause is the race guard for (b) above if a success lands between the read and the write.

**Impact:** none at runtime (no caller until phases 3–5).

### Step 8: README test-container sentence
**File:** `README.md:384-385`
**Change:** replace
```
`test:int` starts or reuses two containers: `mcp-notes-pg-test` (Postgres 16, port 55433) for the
notes, and `mcp-notes-pg-connectors` (pgvector Postgres 16, port 55435), where it rebuilds one
```
with
```
`test:int` starts or reuses two containers, both on `pgvector/pgvector:pg16` (one that runs another
image is recreated): `mcp-notes-pg-test` (port 55433) for the notes, and
`mcp-notes-pg-connectors` (port 55435), where it rebuilds one
```
The rest of the paragraph (from `database per connector from that repo's own migration files …`) is unchanged.
**Impact:** docs only. All other README/INSTALL/ROADMAP changes are phase 6's.

### Step 9: Unit tests for state (and constants / vector literal)
**File:** `tests/unit/embeddings.state.test.ts` (new)
**Code:**
```ts
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { noteEmbeddings } from '../../src/db/schema.js'
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_CHARS,
  EMBEDDING_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
} from '../../src/embeddings/constants.js'
import { toVectorLiteral } from '../../src/embeddings/repo.js'
import {
  bodySha256,
  clampError,
  embedInput,
  embeddingState,
  retryDelayMs,
  type StoredEmbedding,
} from '../../src/embeddings/state.js'

const M = EMBEDDING_MODEL

function stored(body: string, over: Partial<StoredEmbedding> = {}): StoredEmbedding {
  return { bodySha256: bodySha256(body), model: M, hasVector: true, attempts: 0, ...over }
}

describe('embedding constants', () => {
  it('match run-insights and the schema column width', () => {
    expect(EMBEDDING_MODEL).toBe('openai/text-embedding-3-small')
    expect(EMBEDDING_DIMENSIONS).toBe(1536)
    expect(EMBEDDING_MAX_CHARS).toBe(8000)
    expect(OPENROUTER_EMBEDDINGS_URL).toBe('https://openrouter.ai/api/v1/embeddings')
    expect(noteEmbeddings.embedding.getSQLType()).toBe(`vector(${EMBEDDING_DIMENSIONS})`)
  })
})

describe('bodySha256', () => {
  it('is the hex sha256 of the UTF-8 bytes', () => {
    expect(bodySha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(bodySha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const emoji = 'deploy 🚀 done'
    expect(bodySha256(emoji)).toBe(createHash('sha256').update(Buffer.from(emoji, 'utf8')).digest('hex'))
  })

  it('distinguishes CRLF from LF and trailing whitespace', () => {
    expect(bodySha256('a\r\nb')).not.toBe(bodySha256('a\nb'))
    expect(bodySha256('a ')).not.toBe(bodySha256('a'))
  })
})

describe('embedInput', () => {
  it('trims and returns null for blank bodies', () => {
    expect(embedInput('  hello \n')).toBe('hello')
    expect(embedInput('')).toBeNull()
    expect(embedInput(' \n\t\r ')).toBeNull()
    expect(embedInput(' 　﻿ ')).toBeNull()
  })

  it('clamps to EMBEDDING_MAX_CHARS without a marker', () => {
    const long = 'x'.repeat(EMBEDDING_MAX_CHARS + 50)
    expect(embedInput(long)).toBe('x'.repeat(EMBEDDING_MAX_CHARS))
    expect(embedInput(`  ${'y'.repeat(EMBEDDING_MAX_CHARS)}  `)).toBe('y'.repeat(EMBEDDING_MAX_CHARS))
  })

  it('never ends on half a surrogate pair', () => {
    const body = 'a'.repeat(EMBEDDING_MAX_CHARS - 1) + '🚀tail'
    const out = embedInput(body)
    expect(out).toBe('a'.repeat(EMBEDDING_MAX_CHARS - 1))
  })
})

describe('embeddingState', () => {
  it('is none for blank bodies whatever is stored', () => {
    expect(embeddingState('   ', null, M)).toBe('none')
    expect(embeddingState('', stored('old'), M)).toBe('none')
  })

  it('is missing without a row', () => {
    expect(embeddingState('hello', null, M)).toBe('missing')
  })

  it('is current when hash and model match and a vector exists', () => {
    expect(embeddingState('hello', stored('hello'), M)).toBe('current')
  })

  it('is stale on a body change, including whitespace-only changes', () => {
    expect(embeddingState('hello!', stored('hello'), M)).toBe('stale')
    expect(embeddingState('hello\r\n', stored('hello\n'), M)).toBe('stale')
  })

  it('is stale on a model change, even for a failed row', () => {
    expect(embeddingState('hello', stored('hello', { model: 'other/model' }), M)).toBe('stale')
    expect(embeddingState('hello', stored('hello', { model: 'other/model', hasVector: false }), M)).toBe('stale')
  })

  it('is failed when the row for this body has no vector', () => {
    expect(embeddingState('hello', stored('hello', { hasVector: false, attempts: 2 }), M)).toBe('failed')
  })

  it('prefers stale over failed when the body changed after a failure', () => {
    expect(embeddingState('new', stored('old', { hasVector: false, attempts: 3 }), M)).toBe('stale')
  })
})

describe('retryDelayMs', () => {
  it('doubles from 30 s and caps at 1 h', () => {
    expect(retryDelayMs(1)).toBe(30_000)
    expect(retryDelayMs(2)).toBe(60_000)
    expect(retryDelayMs(3)).toBe(120_000)
    expect(retryDelayMs(7)).toBe(1_920_000)
    expect(retryDelayMs(8)).toBe(3_600_000)
    expect(retryDelayMs(1000)).toBe(3_600_000)
  })

  it('treats 0, negatives and NaN as the first attempt', () => {
    expect(retryDelayMs(0)).toBe(30_000)
    expect(retryDelayMs(-5)).toBe(30_000)
    expect(retryDelayMs(Number.NaN)).toBe(30_000)
  })
})

describe('clampError', () => {
  it('redacts keys and bearer tokens', () => {
    const out = clampError('401 for Bearer sk-or-v1-abcDEF123 and key sk-or-v1-xyz_9')
    expect(out).not.toContain('sk-or-')
    expect(out).toContain('[redacted]')
  })

  it('collapses whitespace and caps at 500 chars', () => {
    expect(clampError('a\n\n  b\tc')).toBe('a b c')
    expect(clampError('e'.repeat(2000))).toHaveLength(500)
  })
})

describe('toVectorLiteral', () => {
  it('is JSON.stringify of the numbers', () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe('[0.5,-1,0]')
  })

  it('rejects non-finite values', () => {
    expect(() => toVectorLiteral([0, Number.NaN])).toThrow(/non-finite/)
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/non-finite/)
  })
})
```

### Step 10: Schema integration test: migration 0001
**File:** `tests/integration/schema.int.test.ts`

10a. `:5-6`, imports:
```ts
import { noteEmbeddings, noteRevisions, notes, type ImageMeta } from '../../src/db/schema.js'
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js'
```
10b. `:31`: `describe('schema (migrations 0000 + 0001)', () => {`
10c. `:59`, after `'note_revisions_note_saved_idx',` add:
```ts
        'note_embeddings_pkey',
        'note_embeddings_embedding_hnsw_idx',
        'note_embeddings_next_attempt_idx',
```
10d. Before the closing `})` of the describe at `:163` (i.e. after the `'wraps a body change and its revision in one transaction'` test), add:
```ts
  it('installs pgvector >= 0.8 and an HNSW cosine index on note_embeddings', async () => {
    const ext = await db.execute<{ extname: string; extversion: string }>(
      sql`select extname, extversion from pg_extension where extname = 'vector'`,
    )
    expect(ext.rows).toHaveLength(1)
    // Phases 4 and 5 use `set local hnsw.iterative_scan`, which exists from pgvector 0.8 (Neon: 0.8.6).
    const [major = 0, minor = 0] = (ext.rows[0]?.extversion ?? '0.0').split('.').map(Number)
    expect(major > 0 || minor >= 8).toBe(true)
    const idx = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'note_embeddings_embedding_hnsw_idx'`,
    )
    expect(idx.rows[0]?.indexdef).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/)
  })

  it('re-applying the migrations is a no-op', async () => {
    const count = async () =>
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]?.n
    expect(await count()).toBe(2)
    await migrateTestDb()
    expect(await count()).toBe(2)
  })

  it('applies note_embeddings defaults and enforces the vector width', async () => {
    await db.insert(notes).values({ id: 'W-X23', body: 'hello' })
    const [row] = await db
      .insert(noteEmbeddings)
      .values({ noteId: 'W-X23', bodySha256: 'abc', model: 'm' })
      .returning({
        attempts: noteEmbeddings.attempts,
        embeddedAt: noteEmbeddings.embeddedAt,
        updatedAt: noteEmbeddings.updatedAt,
      })
    expect(row).toMatchObject({ attempts: 0, embeddedAt: null })
    expect(row?.updatedAt).toBeInstanceOf(Date)

    const narrow = await db
      .execute(sql`update note_embeddings set embedding = '[1,2,3]'::vector where note_id = 'W-X23'`)
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(narrow)).toBe('22000')
  })

  it('cascades note_embeddings when a note row is removed', async () => {
    await db.insert(notes).values({ id: 'Y-Z45', body: 'x' })
    await db.insert(noteEmbeddings).values({ noteId: 'Y-Z45', bodySha256: 'abc', model: 'm' })
    await db.delete(notes).where(eq(notes.id, 'Y-Z45'))
    const left = await db.select().from(noteEmbeddings)
    expect(left).toHaveLength(0)
  })
```
`migrateTestDb()` opens its own pool, so calling it inside a test is safe; `globalSetup` already applied both migrations, so the count is 2 before and after (this is the "re-applies as a no-op" exit criterion). `22000` is pgvector's "expected 1536 dimensions, not 3".

### Step 11: Repo integration tests
**File:** `tests/integration/embeddings.repo.int.test.ts` (new)
**Code:**
```ts
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { noteEmbeddings, notes } from '../../src/db/schema.js'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../src/embeddings/constants.js'
import {
  currentBodySha256Sql,
  embeddingStats,
  isCurrentEmbeddingSql,
  listPending,
  recordFailure,
  saveEmbedding,
} from '../../src/embeddings/repo.js'
import { bodySha256, retryDelayMs } from '../../src/embeddings/state.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const M = EMBEDDING_MODEL

/** A unit vector along axis `i`. */
function axis(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  v[i] = 1
  return v
}

async function insertNote(
  db: Db,
  id: string,
  body: string,
  opts: { updatedAt?: Date; deleted?: boolean } = {},
): Promise<void> {
  await db.insert(notes).values({
    id,
    body,
    updatedAt: opts.updatedAt ?? new Date(),
    deletedAt: opts.deleted ? new Date() : null,
  })
}

async function row(db: Db, id: string) {
  const [r] = await db
    .select({
      bodySha256: noteEmbeddings.bodySha256,
      model: noteEmbeddings.model,
      attempts: noteEmbeddings.attempts,
      lastError: noteEmbeddings.lastError,
      nextAttemptAt: noteEmbeddings.nextAttemptAt,
      embeddedAt: noteEmbeddings.embeddedAt,
      hasVector: sql<boolean>`${noteEmbeddings.embedding} is not null`,
    })
    .from(noteEmbeddings)
    .where(eq(noteEmbeddings.noteId, id))
  return r
}

async function pendingIds(db: Db, opts: { ignoreBackoff?: boolean; model?: string } = {}): Promise<string[]> {
  const rows = await listPending(db, { model: opts.model ?? M, limit: 100, ignoreBackoff: opts.ignoreBackoff })
  return rows.map((r) => r.id)
}

describe('embeddings repo', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  describe('body hash', () => {
    const bodies: Array<[string, string]> = [
      ['ascii', 'arango root password is in the vault #ops'],
      ['emoji', 'deploy 🚀 done 👩🏽‍💻 ok'],
      ['crlf', 'line one\r\nline two\r\n'],
      ['lf', 'line one\nline two\n'],
      ['cjk + accents', 'café naïve 日本語 ünïcödé'],
      ['empty', ''],
      ['long', 'ab🚀'.repeat(5000)],
    ]

    it.each(bodies)('SQL and JS agree on %s', async (_name, body) => {
      await insertNote(db, 'A-B32', body)
      const res = await db.execute<{ h: string }>(
        sql`select ${currentBodySha256Sql()} as h from notes where id = 'A-B32'`,
      )
      expect(res.rows[0]?.h).toBe(bodySha256(body))
    })
  })

  describe('listPending', () => {
    it('returns notes with text and no row, live first, then newest updated', async () => {
      await insertNote(db, 'A-001', 'old live', { updatedAt: new Date('2026-01-01T00:00:00Z') })
      await insertNote(db, 'A-002', 'new live', { updatedAt: new Date('2026-06-01T00:00:00Z') })
      await insertNote(db, 'A-003', 'newest deleted', { updatedAt: new Date('2026-09-01T00:00:00Z'), deleted: true })
      await insertNote(db, 'A-004', '')
      await insertNote(db, 'A-005', ' \n\t ')
      await insertNote(db, 'A-006', ' 　﻿ ')

      const rows = await listPending(db, { model: M, limit: 10 })
      expect(rows.map((r) => r.id)).toEqual(['A-002', 'A-001', 'A-003'])
      expect(rows[0]).toEqual({ id: 'A-002', body: 'new live', bodySha256: bodySha256('new live') })
    })

    it('honours the limit', async () => {
      await insertNote(db, 'A-001', 'one')
      await insertNote(db, 'A-002', 'two')
      expect(await listPending(db, { model: M, limit: 1 })).toHaveLength(1)
    })

    it('drops a note once it has a current vector, brings it back when the body or model changes', async () => {
      await insertNote(db, 'A-001', 'first')
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('first'), model: M, embedding: axis(0) })).toBe(true)
      expect(await pendingIds(db)).toEqual([])

      expect(await pendingIds(db, { model: 'other/model' })).toEqual(['A-001'])

      await db.update(notes).set({ body: 'second' }).where(eq(notes.id, 'A-001'))
      const rows = await listPending(db, { model: M, limit: 10 })
      expect(rows).toEqual([{ id: 'A-001', body: 'second', bodySha256: bodySha256('second') }])
    })

    it('holds a failed note until next_attempt_at, unless ignoreBackoff', async () => {
      await insertNote(db, 'A-001', 'body')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, error: 'timeout' })
      expect(await pendingIds(db)).toEqual([])
      expect(await pendingIds(db, { ignoreBackoff: true })).toEqual(['A-001'])

      await db.update(noteEmbeddings).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(noteEmbeddings.noteId, 'A-001'))
      expect(await pendingIds(db)).toEqual(['A-001'])
    })

    it('makes a failed note due at once when its body changes', async () => {
      await insertNote(db, 'A-001', 'body')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, error: 'timeout' })
      await db.update(notes).set({ body: 'edited body' }).where(eq(notes.id, 'A-001'))
      expect(await pendingIds(db)).toEqual(['A-001'])
    })

    it('includes deleted notes so a restore needs no call', async () => {
      await insertNote(db, 'A-001', 'gone', { deleted: true })
      expect(await pendingIds(db)).toEqual(['A-001'])
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('gone'), model: M, embedding: axis(1) })
      expect(await pendingIds(db)).toEqual([])
      expect((await row(db, 'A-001'))?.hasVector).toBe(true)
    })
  })

  describe('saveEmbedding', () => {
    it('writes the vector and resets the failure fields', async () => {
      await insertNote(db, 'A-001', 'body')
      const h = bodySha256('body')
      await recordFailure(db, { noteId: 'A-001', bodySha256: h, model: M, error: 'boom' })
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: h, model: M, embedding: axis(2) })).toBe(true)
      const r = await row(db, 'A-001')
      expect(r).toMatchObject({ bodySha256: h, model: M, attempts: 0, lastError: null, nextAttemptAt: null, hasVector: true })
      expect(r?.embeddedAt).toBeInstanceOf(Date)
    })

    it('skips when the body changed while the call was in flight', async () => {
      await insertNote(db, 'A-001', 'v1')
      const h1 = bodySha256('v1')
      await db.update(notes).set({ body: 'v2' }).where(eq(notes.id, 'A-001'))
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: h1, model: M, embedding: axis(3) })).toBe(false)
      expect(await row(db, 'A-001')).toBeUndefined()
    })

    it('does not overwrite a newer vector with a stale one', async () => {
      await insertNote(db, 'A-001', 'v2')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('v2'), model: M, embedding: axis(4) })
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, embedding: axis(5) })).toBe(false)
      expect((await row(db, 'A-001'))?.bodySha256).toBe(bodySha256('v2'))
    })

    it('returns false for an unknown note', async () => {
      expect(await saveEmbedding(db, { noteId: 'Z-ZZZ', bodySha256: bodySha256('x'), model: M, embedding: axis(0) })).toBe(false)
    })

    it('is idempotent', async () => {
      await insertNote(db, 'A-001', 'body')
      const v = { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, embedding: axis(6) }
      expect(await saveEmbedding(db, v)).toBe(true)
      expect(await saveEmbedding(db, v)).toBe(true)
      const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from note_embeddings`)
      expect(n.rows[0]?.n).toBe(1)
    })

    it('rejects a vector of the wrong width before touching the database', async () => {
      await insertNote(db, 'A-001', 'body')
      await expect(
        saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, embedding: [1, 0, 0] }),
      ).rejects.toThrow(/expected 1536/)
    })
  })

  describe('recordFailure', () => {
    it('counts consecutive failures for one body and backs off', async () => {
      await insertNote(db, 'A-001', 'body')
      const h = bodySha256('body')
      for (const expected of [1, 2, 3]) {
        const before = Date.now()
        await recordFailure(db, { noteId: 'A-001', bodySha256: h, model: M, error: `fail ${expected}` })
        const r = await row(db, 'A-001')
        expect(r).toMatchObject({ attempts: expected, lastError: `fail ${expected}`, hasVector: false, embeddedAt: null })
        const wait = r!.nextAttemptAt!.getTime() - before
        expect(wait).toBeGreaterThan(retryDelayMs(expected) - 5_000)
        expect(wait).toBeLessThan(retryDelayMs(expected) + 5_000)
      }
    })

    it('restarts the count when the failure is for another body or model', async () => {
      await insertNote(db, 'A-001', 'v1')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, error: 'a' })
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, error: 'b' })
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: 'other/model', error: 'c' })
      expect((await row(db, 'A-001'))?.attempts).toBe(1)

      await db.update(notes).set({ body: 'v2' }).where(eq(notes.id, 'A-001'))
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v2'), model: M, error: 'd' })
      expect(await row(db, 'A-001')).toMatchObject({ attempts: 1, bodySha256: bodySha256('v2'), model: M })
    })

    it('replaces a stale vector with a failure row for the new body', async () => {
      await insertNote(db, 'A-001', 'v1')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, embedding: axis(7) })
      await db.update(notes).set({ body: 'v2' }).where(eq(notes.id, 'A-001'))
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v2'), model: M, error: 'down' })
      expect(await row(db, 'A-001')).toMatchObject({ hasVector: false, attempts: 1, bodySha256: bodySha256('v2'), embeddedAt: null })
    })

    it('never wipes a current vector (another daemon already succeeded)', async () => {
      await insertNote(db, 'A-001', 'body')
      const h = bodySha256('body')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: h, model: M, embedding: axis(8) })
      await recordFailure(db, { noteId: 'A-001', bodySha256: h, model: M, error: 'late failure' })
      expect(await row(db, 'A-001')).toMatchObject({ hasVector: true, attempts: 0, lastError: null })
    })

    it('ignores a failure for a body the note no longer has', async () => {
      await insertNote(db, 'A-001', 'v2')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, error: 'old' })
      expect(await row(db, 'A-001')).toBeUndefined()
    })

    it('ignores an unknown note instead of violating the foreign key', async () => {
      await expect(recordFailure(db, { noteId: 'Z-ZZZ', bodySha256: bodySha256('x'), model: M, error: 'x' })).resolves.toBeUndefined()
    })

    it('stores a redacted, clamped error', async () => {
      await insertNote(db, 'A-001', 'body')
      await recordFailure(db, {
        noteId: 'A-001',
        bodySha256: bodySha256('body'),
        model: M,
        error: `401 Bearer sk-or-v1-secret ${'z'.repeat(1000)}`,
      })
      const r = await row(db, 'A-001')
      expect(r?.lastError).not.toContain('sk-or-')
      expect(r?.lastError?.length).toBeLessThanOrEqual(500)
    })
  })

  describe('isCurrentEmbeddingSql', () => {
    it('is true only for a vector made from the current body by the given model', async () => {
      await insertNote(db, 'A-001', 'current')
      await insertNote(db, 'A-002', 'was v1')
      await insertNote(db, 'A-003', 'failed')
      await insertNote(db, 'A-004', 'no row')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('current'), model: M, embedding: axis(0) })
      await saveEmbedding(db, { noteId: 'A-002', bodySha256: bodySha256('was v1'), model: M, embedding: axis(1) })
      await db.update(notes).set({ body: 'now v2' }).where(eq(notes.id, 'A-002'))
      await recordFailure(db, { noteId: 'A-003', bodySha256: bodySha256('failed'), model: M, error: 'x' })

      const res = await db.execute<{ id: string; cur: boolean }>(sql`
        select notes.id, coalesce(${isCurrentEmbeddingSql(M)}, false) as cur
        from notes left join note_embeddings on note_embeddings.note_id = notes.id
        order by notes.id
      `)
      expect(res.rows).toEqual([
        { id: 'A-001', cur: true },
        { id: 'A-002', cur: false },
        { id: 'A-003', cur: false },
        { id: 'A-004', cur: false },
      ])
      const other = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from notes join note_embeddings on note_embeddings.note_id = notes.id
        where ${isCurrentEmbeddingSql('other/model')}
      `)
      expect(other.rows[0]?.n).toBe(0)
    })
  })

  describe('embeddingStats', () => {
    it('counts with-text, current, pending and failing over live and deleted notes', async () => {
      await insertNote(db, 'A-001', 'embedded')
      await insertNote(db, 'A-002', 'embedded then deleted', { deleted: true })
      await insertNote(db, 'A-003', 'failing')
      await insertNote(db, 'A-004', 'missing')
      await insertNote(db, 'A-005', '   ')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('embedded'), model: M, embedding: axis(0) })
      await saveEmbedding(db, { noteId: 'A-002', bodySha256: bodySha256('embedded then deleted'), model: M, embedding: axis(1) })
      await recordFailure(db, { noteId: 'A-003', bodySha256: bodySha256('failing'), model: M, error: 'x' })

      expect(await embeddingStats(db, M)).toEqual({ withText: 4, current: 2, pending: 2, failing: 1 })
      expect(await embeddingStats(db, 'other/model')).toEqual({ withText: 4, current: 0, pending: 4, failing: 0 })
    })

    it('is all zeros on an empty table', async () => {
      expect(await embeddingStats(db, M)).toEqual({ withText: 0, current: 0, pending: 0, failing: 0 })
    })
  })
})
```

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (adds 19 tests in `tests/unit/embeddings.state.test.ts`), then `npm run test:int` (adds 29 in the repo file and 4 in the schema file; expect the one-time "recreating it" line for `mcp-notes-pg-test`).
**Manual check:**
- `cat drizzle/0001_note_embeddings.sql` starts with `CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint`.
- `docker inspect -f '{{.Config.Image}}' mcp-notes-pg-test` prints `pgvector/pgvector:pg16`.
- Run `npm run test:int` a second time: no "recreating" line, container reused, still green.
- `git status` shows no `.env.local` staged.
**Exit criteria:** migration 0001 applies on a fresh pgvector container and re-applies as a no-op (schema test); the installed `vector` extension is >= 0.8 (the test image ships 0.8.7, Neon 0.8.6; phases 4 and 5 need `hnsw.iterative_scan`); the JS and SQL hashes agree on ASCII, emoji, CRLF (and more) bodies; `listPending` / `saveEmbedding` / `recordFailure` / `embeddingStats` behave per the contract and refinements above; typecheck, `npm test`, `npm run test:int` all green.

## Handoffs

- **Phase 2 (depends on this phase, reconciled):** `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_MAX_CHARS`, `OPENROUTER_EMBEDDINGS_URL` come from `src/embeddings/constants.ts`; the embedder should import them rather than redefine. `embedInput` is the input clamp (trim + 8 000 UTF-16 units, surrogate-safe); phase 2's `embed()` applies it to every input (reconciled), so there is one clamp in the code base. Do not add a second error-redaction helper: `clampError` already exists in `state.ts` (phase 2 may use it for `EmbeddingError` messages if useful).
- **Phase 3 (R1, R3):** call `listPending({ model: embedder.model, limit, ignoreBackoff })`, embed `embedInput(p.body)` (never null for a pending note, see refinement 5), then `saveEmbedding({ noteId: p.id, bodySha256: p.bodySha256, model, embedding })` (false = body changed mid-flight, just move on: the new body is pending) or `recordFailure({ …, error })` with phase 3's `errorMessage(err)` (which includes an `EmbeddingError`'s transport detail; raw text is fine, it is clamped/redacted inside). Use `embeddingStats` for the CLI progress and the "quiet when idle" check. A model change shows up as everything pending automatically.
- **Phase 4 (R4):** the hybrid candidate query joins `note_embeddings on note_embeddings.note_id = notes.id`, filters with `isCurrentEmbeddingSql(model)`, orders by `note_embeddings.embedding <=> ${toVectorLiteral(q)}::vector`; similarity = `1 - distance`. Do not alias `notes` or `note_embeddings` (refinement 1). With a `where` that restricts to current vectors, the HNSW index may or may not be chosen on small tables; correctness does not depend on it.
- **Phase 5 (R5):** `nearestNotes` goes in `src/embeddings/repo.ts` next to these functions, same no-alias rule; exclude the note itself and deleted notes (rows of deleted notes exist on purpose).
- **Phase 6:** `npm run db:migrate` on Neon runs `CREATE EXTENSION IF NOT EXISTS vector` (Neon's owner role may create it; pgvector 0.8.6). `drizzle-kit migrate` applies only 0001 (0000 is already recorded). Phase 6 also owns the rest of the docs (INSTALL / ROADMAP / skill); this phase changed only README's test-container sentence.
- Not done here, by design: no `NoteEmbeddingRow` type export, no change to `src/notes/repo.ts` (its `Executor` type is reused as is).

## Rollback

Revert the phase commit. On any database where 0001 was applied (only the Docker test DB at this point; Neon is phase 6): `drop table note_embeddings; delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations);` (the `vector` extension may stay). To put the test container back on plain Postgres: `docker rm -f mcp-notes-pg-test`, revert the commit (which also removes the mismatch logic), then `npm run test:int` recreates it on `postgres:16`.
