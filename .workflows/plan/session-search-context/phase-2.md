# Phase 2: Commit subjects in search_tsv and the session embedding

**Plan set:** `SESSION_SEARCH_CONTEXT_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-145826-SSC7_code_analyzer.md`
**Satisfies:** R1 — a session's commit messages become part of its search context (words and meaning)
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/sessions`, `src/db`, `drizzle`

---

## Goal

A word or a meaning that appears only in a session's commit subjects finds that session in
`sessions_search` / `GET /api/sessions/search` / the Projects chat, in text and hybrid mode. To do
that, the generated `cc_sessions.search_tsv` gains `commits[*].subject` (migration `0013`), and
`buildEmbedText` puts commit subjects before the prompts so the 8000-char clamp keeps them. Every
existing session vector is rebuilt exactly once, driven by a new **embed-text version**
(`SESSION_EMBED_TEXT_VERSION = 1`) stored with each vector in `cc_session_embeddings.text_version`.

## Interface Contract

**Deletes:** none.

**Renames:** none.

**Creates:**
- Migration `drizzle/0013_session_commit_search.sql` (journal idx 13, tag `0013_session_commit_search`) + `drizzle/meta/0013_snapshot.json` + a journal entry. It:
  1. drops index `cc_sessions_search_gin`,
  2. drops and re-adds generated column `cc_sessions.search_tsv` with `|| ' ' || coalesce(jsonb_path_query_array("commits", '$[*].subject')::text, '')` appended,
  3. adds `cc_session_embeddings.text_version integer NOT NULL DEFAULT 0`,
  4. recreates `cc_sessions_search_gin` (gin on `search_tsv`).
- Schema column `ccSessionEmbeddings.textVersion` (`text_version`) in `src/db/schema.ts`.
- `SESSION_EMBED_TEXT_VERSION = 1` (exported const, `src/sessions/summarize.ts`).
- `MAX_EMBED_COMMITS = 20` (exported const, `src/sessions/summarize.ts`), plus module-private `MAX_EMBED_COMMIT_CHARS = 150`.
- `commitSubjects(value: unknown): string[]` (exported, `src/sessions/summarize.ts`).
- New tests: `tests/integration/sessions.commitSearch.int.test.ts`, `tests/integration/migration0013.int.test.ts`.

**Signature changes:**
- `SessionEmbeddingInput` (`src/sessions/types.ts:385`) gains required `textVersion: number`. `SessionsRepo.saveEmbedding(sessionId, input)` writes it (insert and on-conflict update).
- `SummaryCandidate` (`src/sessions/summaryWorker.ts:40`) gains `embeddingTextVersion: number | null`.
- `SummaryStore.saveEmbedding(v)` (`src/sessions/summaryWorker.ts:73`) takes `{ sessionId, sha, model, embedding, textVersion }`.
- `buildEmbedText(s)` output layout: `head`, `summary`, **commit subjects (newest 20, one line each, ≤150 chars)**, prompts. Signature unchanged.

**Re-embed rule (the decision this phase was asked to make):** *embed-text version*, not a
sha comparison in SQL. The SQL cannot compute `buildEmbedText`, so a stored sha cannot be compared
to the "current" one in `listIdle`. Instead:
- `listIdle` lists a session for embedding when, in addition to today's conditions,
  `e.text_version < SESSION_EMBED_TEXT_VERSION`;
- `processOne` re-embeds when `sha !== c.embeddingSha || c.embeddingModel !== embedder.model ||
  (c.embeddingTextVersion ?? 0) < SESSION_EMBED_TEXT_VERSION`, and saves with
  `textVersion: SESSION_EMBED_TEXT_VERSION`.
So every pre-0013 vector (text_version 0) is rebuilt once, also when its text did not change (a
session with no commits costs one extra embed call; ~738 calls total, about $0.005, at the
existing 1 call/s limiter), and is then never listed again. Future layout changes bump the
constant. Only the owning host re-embeds its own sessions (unchanged host filter).

**Requires (from earlier phases):** nothing.

**Leaves alone (owned by others):**
- `src/sessions/search.ts` (Phase 1 structure, Phase 5 replies source). No change is needed: it reads `search_tsv` by name (`SESSION_TSV_COLUMN`) and joins `cc_session_embeddings` on model + `embedding is not null`, never on `text_version`.
- `src/sessions/transcript.ts`, `ingest.ts`, `merge.ts` and the prompt/reply writers in `repo.ts` (Phase 3).
- `drizzle/0014_*` and new tables in `schema.ts` (Phase 3 generates 0014 **after** this 0013 and its snapshot).
- `src/search/blend.ts`, readModel/view/MCP/HTTP/chat (Phase 5). Everything under `web/` (R5).

**Shared files, edited in different places (reconciler note):** `src/db/schema.ts` (Phase 3 adds tables after `ccSessionPromptImages`; this phase edits `ccSessions.searchTsv` and `ccSessionEmbeddings`), `src/sessions/repo.ts` (this phase: `saveEmbedding` only), `src/sessions/types.ts` (this phase: `SessionEmbeddingInput` only), `CLAUDE.md` sessions paragraph and `features/projects.md` (Phases 3 and 5 also add sentences), `README.md` `sessions_search` table row (Phase 5 adds `via_replies` to the same row).

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts:48` | modify | header comment: one line for migration 0013 |
| `src/db/schema.ts:560-563` | modify | `searchTsv` expression appends commit subjects; doc comment says so |
| `src/db/schema.ts:686-714` | modify | `ccSessionEmbeddings`: doc comment + `textVersion` column |
| `drizzle/0013_session_commit_search.sql` | create (generated, then hand-edited) | drop index, drop/add `search_tsv`, add `text_version`, create index |
| `drizzle/meta/0013_snapshot.json` | create (generated) | drizzle snapshot |
| `drizzle/meta/_journal.json` | modify (generated) | entry idx 13 |
| `src/sessions/summarize.ts:30-31, 192-207` | modify | constants, `commitSubjects`, `buildEmbedText` with commits before prompts |
| `src/sessions/types.ts:385-389` | modify | `SessionEmbeddingInput.textVersion` |
| `src/sessions/repo.ts:859-882` | modify | `saveEmbedding` writes `text_version` |
| `src/sessions/summaryWorker.ts:9-17, 39-48, 73, 91-98, 118-213, 318-397` | modify | candidate field, store signature, SQL, re-embed rule |
| `tests/unit/sessions/summarize.test.ts:8-19, 126-140` | modify | import + new commit-subject tests |
| `tests/unit/sessions/summaryWorker.test.ts:1-112` + new tests | modify | memory store carries text version; re-embed-once tests |
| `tests/integration/sessions.repo.int.test.ts:378-383` | modify | pass `textVersion`, assert column |
| `tests/integration/sessions.commitSearch.int.test.ts` | create | commit word finds session in text + hybrid; meaning via vector; re-embed once against Postgres |
| `tests/integration/migration0013.int.test.ts` | create | 0013 on a 0012 DB with data |
| `README.md:686-692, 1039` | modify | search prose + `sessions_search` row mention commits |
| `CLAUDE.md:41` | modify | sessions paragraph: commits in full text + embed text, text_version |
| `.claude/skills/verify-notesd/features/projects.md` | modify | sub-feature bullet + driving snippet |

## Implementation Steps

### Step 0: Tooling in the worktree
**File:** none
**Change:** The worktree has no `node_modules`. Run once from the worktree root:
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
[ -d node_modules ] || npm ci
```
`drizzle.config.ts` throws without a direct (non-pooler) URL and the worktree has no
`.env.local`. `drizzle-kit generate` does not connect, so pass a dummy direct URL in Step 3.
**Impact:** none on the tree.

### Step 1: Red first — write the integration tests that must fail today
**File:** `tests/integration/sessions.commitSearch.int.test.ts` (new)
**Change:** Create the file below now, before any source change. Before Step 2 lands, the
"text mode" and "hybrid literal" tests fail (no session found for `zanzibar`) and the file does not
typecheck (`textVersion`, `text_version`); that is the reproduction. It passes after Step 6.
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { searchSessions } from '../../src/sessions/search.js';
import { SESSION_EMBED_TEXT_VERSION } from '../../src/sessions/summarize.js';
import { dbSummaryStore, startSummaryWorker } from '../../src/sessions/summaryWorker.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

/**
 * Commit subjects are a session's own search context (phase 2 of session-search-context):
 * `cc_sessions.search_tsv` indexes `commits[*].subject` (migration 0013) and the session embed
 * text carries them before the prompts. Sessions are embedded by the real summary worker (fake
 * embedder, summaries off), so the vectors are the ones production would store.
 */

const HOST = 'int-host';
const COMMIT_ONLY = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEANING_ONLY = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
let db: Db;
let embedder: FakeEmbedder;

async function insertSession(v: { sessionId: string; nodeId: string; prompts: string[]; commits: Array<{ sha: string; subject: string }> }): Promise<void> {
  const commits = v.commits.map((c) => ({ ...c, at: null }));
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, first_prompt, prompts, commits,
      started_at, last_active_at, created_at, updated_at)
    values (${v.sessionId}, ${v.nodeId}, ${HOST}, 'mcp-notes', '/tmp', ${v.prompts[0] ?? null},
      ${JSON.stringify(v.prompts)}::jsonb, ${JSON.stringify(commits)}::jsonb,
      now() - interval '2 hours', now() - interval '1 hour', now(), now())
  `);
}

async function embedAll(e: FakeEmbedder): Promise<void> {
  const w = startSummaryWorker({
    store: dbSummaryStore(db, new SessionsRepo(db)),
    summarizer: null,
    embedder: e,
    host: HOST,
    embedMinIntervalMs: 0,
    sweepMs: 3_600_000,
    log: () => {},
  });
  await w.idle();
  await w.close();
}

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
  embedder = createFakeEmbedder();
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  await insertSession({
    sessionId: COMMIT_ONLY,
    nodeId: 'A0-3G',
    prompts: ['tidy the spinner css'],
    commits: [{ sha: '0123456789abcdef', subject: 'fix(wall): zanzibar spinner stalls' }],
  });
  await insertSession({
    sessionId: MEANING_ONLY,
    nodeId: 'B1-4H',
    prompts: ['tidy up'],
    commits: [{ sha: 'fedcba9876543210', subject: 'login broke after laptop resume' }],
  });
  await insertSession({ sessionId: OTHER, nodeId: 'C2-5J', prompts: ['leaderboard ranking tweaks'], commits: [] });
});

describe('searchSessions: commit subjects are part of a session', () => {
  it('text mode: a word only a commit subject has finds the session', async () => {
    const page = await searchSessions({ db, embedder: null, host: HOST }, 'zanzibar');
    expect(page.mode).toBe('text');
    expect(page.sessions.map((s) => s.session_id)).toEqual([COMMIT_ONLY]);
  });

  it('hybrid: a word only a commit subject has ranks that session first', async () => {
    await embedAll(embedder);
    const page = await searchSessions({ db, embedder, host: HOST }, 'zanzibar');
    expect(page.mode).toBe('hybrid');
    expect(page.sessions[0]?.session_id).toBe(COMMIT_ONLY);
  });

  it('hybrid: a meaning only a commit subject carries finds the session through its vector', async () => {
    await embedAll(embedder);
    const query = 'auth failures on wake notebook';
    const words = await searchSessions({ db, embedder: null, host: HOST }, query);
    expect(words.sessions.map((s) => s.session_id)).not.toContain(MEANING_ONLY);
    const page = await searchSessions({ db, embedder, host: HOST }, query);
    expect(page.sessions[0]?.session_id).toBe(MEANING_ONLY);
  });

  it('the sha of a commit is not indexed, only its subject', async () => {
    const page = await searchSessions({ db, embedder: null, host: HOST }, '0123456789abcdef');
    expect(page.sessions).toEqual([]);
  });
});

describe('summary worker: the embed-text version re-embeds every session once', () => {
  it('stamps new vectors with the current version', async () => {
    await embedAll(embedder);
    const res = await db.execute<{ text_version: number }>(sql`select text_version from cc_session_embeddings order by session_id`);
    expect(res.rows.map((r) => r.text_version)).toEqual([SESSION_EMBED_TEXT_VERSION, SESSION_EMBED_TEXT_VERSION, SESSION_EMBED_TEXT_VERSION]);
  });

  it('a vector from before the version (text_version 0) is rebuilt exactly once, then left alone', async () => {
    await embedAll(createFakeEmbedder());
    // What migration 0013 leaves behind: every existing vector at version 0, unchanged sha.
    await db.execute(sql`update cc_session_embeddings set text_version = 0`);

    const second = createFakeEmbedder();
    await embedAll(second);
    expect(second.calls.flat()).toHaveLength(3);
    const res = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_embeddings where text_version = ${SESSION_EMBED_TEXT_VERSION}`);
    expect(res.rows[0]?.n).toBe(3);

    const third = createFakeEmbedder();
    await embedAll(third);
    expect(third.calls).toHaveLength(0);
  });
});
```
**Impact:** test-only; red until Step 6.

### Step 2: Schema — `search_tsv` with commit subjects, `text_version` on session embeddings
**File:** `src/db/schema.ts:560-563` (`ccSessions.searchTsv`)
**Change:** replace the doc comment and the expression.
**Code:**
```ts
    /**
     * Full text (`simple`) over ids, names, titles, prompts, summary and commit subjects
     * (`commits[*].subject`, migration 0013; not the shas). Never selected by the app.
     */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", '') || ' ' || coalesce(jsonb_path_query_array("commits", '$[*].subject')::text, ''))`,
    ),
```

**File:** `src/db/schema.ts:686-714` (`ccSessionEmbeddings`)
**Change:** replace the doc comment and the table definition (adds `textVersion` after `model`).
**Code:**
```ts
/**
 * One row per session that has (or had) a summary to embed (migration 0007). Mirrors
 * `note_embeddings`: the vector is current iff `embedding is not null`, `sha` equals the hash of
 * the session's current embed text (src/sessions/summarize.ts `buildEmbedText` / `embedTextSha`),
 * `model` equals EMBEDDING_MODEL and `text_version` equals `SESSION_EMBED_TEXT_VERSION` (migration
 * 0013; rows from before it are 0, and the summary worker rebuilds them once).
 * Width = EMBEDDING_DIMENSIONS (a unit test asserts it).
 */
export const ccSessionEmbeddings = pgTable(
  'cc_session_embeddings',
  {
    sessionId: text('session_id')
      .primaryKey()
      .references(() => ccSessions.sessionId, { onDelete: 'cascade' }),
    /** Null while the latest attempt for `sha` failed. */
    embedding: vector('embedding', { dimensions: 1536 }),
    sha: text('sha').notNull(),
    model: text('model').notNull(),
    /** Layout version of the embed text the vector came from (src/sessions/summarize.ts SESSION_EMBED_TEXT_VERSION). */
    textVersion: integer('text_version').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    /** At most 500 chars, keys redacted (src/embeddings/state.ts `clampError`). */
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
    embeddedAt: timestamp('embedded_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('cc_session_embeddings_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('cc_session_embeddings_next_attempt_idx').on(t.nextAttemptAt),
  ],
)
```

**File:** `src/db/schema.ts:48` (header comment, after the migration 0011 sentence ending "...never written to Seer.")
**Change:** insert these lines before ` * Change a table here, then \`npm run db:generate\`...`:
```ts
 * Migration 0013 (session search context) adds commit subjects to the generated
 * `cc_sessions.search_tsv` (drop + re-add of the column; the GIN index is dropped and recreated by
 * hand-added statements, because drizzle-kit's drop/add does not re-emit it) and
 * `cc_session_embeddings.text_version`.
```
**Impact:** schema now differs from the 0012 snapshot; Step 3 generates the migration.

### Step 3: Generate migration 0013 and hand-fix the index
**File:** `drizzle/0013_session_commit_search.sql`, `drizzle/meta/0013_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** generate with drizzle-kit (never hand-write the snapshot or journal):
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit generate --name session_commit_search
```
drizzle-kit 0.31.10 turns a changed generated expression into `ALTER TABLE ... drop column` +
`ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` (`PgAlterTableAlterColumnAlterrGeneratedConvertor`
in `node_modules/drizzle-kit/bin.cjs`) and does **not** re-create the GIN index, which Postgres
silently drops with the column. Edit the generated SQL so the file is exactly this (drizzle's
own statements may come in a different order; keep the five statements below, index drop first and
index create last):
**Code:**
```sql
DROP INDEX IF EXISTS "cc_sessions_search_gin";--> statement-breakpoint
ALTER TABLE "cc_sessions" drop column "search_tsv";--> statement-breakpoint
ALTER TABLE "cc_sessions" ADD COLUMN "search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", '') || ' ' || coalesce(jsonb_path_query_array("commits", '$[*].subject')::text, ''))) STORED;--> statement-breakpoint
ALTER TABLE "cc_session_embeddings" ADD COLUMN "text_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "cc_sessions_search_gin" ON "cc_sessions" USING gin ("search_tsv");
```
Then check: `grep -c cc_sessions_search_gin drizzle/0013_session_commit_search.sql` prints `2`;
`jq '.entries[-1].tag' drizzle/meta/_journal.json` prints `"0013_session_commit_search"`;
`DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit check` passes; a
second `generate` run reports no schema changes (then delete nothing — it writes no file).
**Impact:** the drizzle migrator runs pending migrations in one transaction, so the rewrite of
`cc_sessions` (738 rows) is atomic. Backward compatible with the other laptop's older daemon: no
column it names is removed, and its `saveEmbedding` never names `text_version` (default 0, so its
vectors stay "old" until it runs this code). Phase 3 generates 0014 on top of this snapshot.

### Step 4: Embed text carries commit subjects before the prompts
**File:** `src/sessions/summarize.ts:30-31` (after `MAX_EMBED_PROMPT_CHARS`)
**Change:** add the constants and the version.
**Code:**
```ts
/** Per-prompt cap inside the embed text (embedInput then clamps the whole to 8000). */
const MAX_EMBED_PROMPT_CHARS = 500;
/** Most commit subjects in the embed text (the newest ones); full text indexes all of them. */
export const MAX_EMBED_COMMITS = 20;
/** Per-subject cap inside the embed text. */
const MAX_EMBED_COMMIT_CHARS = 150;
/**
 * Layout version of buildEmbedText, stored with each vector in `cc_session_embeddings.text_version`.
 * Bump it whenever the layout changes: the summary worker then re-embeds every session once.
 * 0 = vectors from before versions existed (no commit subjects); 1 = commit subjects (migration 0013).
 */
export const SESSION_EMBED_TEXT_VERSION = 1;
```

**File:** `src/sessions/summarize.ts:192-207` (`buildEmbedText`)
**Change:** add `commitSubjects` and replace `buildEmbedText`.
**Code:**
```ts
/**
 * Commit subjects of a `commits` jsonb value, in stored order (oldest first). Objects give their
 * `subject` (or `message`); a string is taken as the subject. Shas are never included.
 */
export function commitSubjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    let subject: unknown;
    if (typeof item === 'string') subject = item;
    else if (item !== null && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      subject = rec.subject ?? rec.message;
    }
    if (typeof subject === 'string' && subject.trim() !== '') out.push(subject.trim());
  }
  return out;
}

/**
 * What gets embedded for a session: title/name/repo, the summary, the newest MAX_EMBED_COMMITS
 * commit subjects, then the prompts; redacted, then trimmed and clamped by embedInput. Commits
 * come before the prompts because the clamp cuts the end. Null when nothing is left. Changing
 * this layout means bumping SESSION_EMBED_TEXT_VERSION.
 */
export function buildEmbedText(s: SessionSummarySource): string | null {
  const head = [titleOf(s), s.name !== titleOf(s) ? s.name : null, s.repo].filter(
    (v): v is string => v !== null && v.trim() !== '',
  );
  const parts: string[] = [];
  if (head.length > 0) parts.push(head.join(' | '));
  if (s.summary !== null && s.summary.trim() !== '') parts.push(s.summary.trim());
  for (const subject of commitSubjects(s.commits).slice(-MAX_EMBED_COMMITS)) parts.push(oneLine(subject, MAX_EMBED_COMMIT_CHARS));
  let prompts = asLines(s.prompts);
  if (prompts.length === 0 && s.firstPrompt !== null) prompts = [s.firstPrompt];
  for (const p of prompts) parts.push(oneLine(p, MAX_EMBED_PROMPT_CHARS));
  return embedInput(redactSecrets(parts.join('\n')));
}
```
`buildSummaryInput` is untouched (it already lists commits), so no session is re-summarized.
**Impact:** the embed sha changes for every session with commits.

### Step 5: Store the version with each vector
**File:** `src/sessions/types.ts:385-389`
**Code:**
```ts
export interface SessionEmbeddingInput {
  sha: string;
  model: string;
  embedding: number[];
  /** Layout version of the embed text (src/sessions/summarize.ts SESSION_EMBED_TEXT_VERSION). */
  textVersion: number;
}
```

**File:** `src/sessions/repo.ts:859-882` (`SessionsRepo.saveEmbedding`; keep its existing doc comment above it)
**Code:**
```ts
  async saveEmbedding(sessionId: string, input: SessionEmbeddingInput): Promise<boolean> {
    if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding has ${input.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
    }
    const literal = toVectorLiteral(input.embedding);
    const res = await this.db.execute<{ session_id: string }>(sql`
      insert into cc_session_embeddings
        (session_id, embedding, sha, model, text_version, attempts, last_error, next_attempt_at, embedded_at, created_at, updated_at)
      select cc_sessions.session_id, ${literal}::vector, ${input.sha}, ${input.model}, ${input.textVersion}::integer, 0, null, null, now(), now(), now()
      from cc_sessions
      where cc_sessions.session_id = ${sessionId}
      on conflict (session_id) do update set
        embedding = excluded.embedding,
        sha = excluded.sha,
        model = excluded.model,
        text_version = excluded.text_version,
        attempts = 0,
        last_error = null,
        next_attempt_at = null,
        embedded_at = excluded.embedded_at,
        updated_at = excluded.updated_at
      returning session_id
    `);
    return res.rows.length > 0;
  }
```
`recordEmbeddingFailure` is unchanged: a failed row has `embedding = null`, which `listIdle`
already lists, and its `text_version` is rewritten on the next successful save.

### Step 6: Summary worker — list and rebuild vectors below the version
**File:** `src/sessions/summaryWorker.ts:9-17` (imports)
**Code:**
```ts
import {
  SESSION_EMBED_TEXT_VERSION,
  buildEmbedText,
  buildSummaryInput,
  cleanSummary,
  embedTextSha,
  summaryInputSha,
  type SessionSummarySource,
  type Summarizer,
} from './summarize.js';
```

**File:** `src/sessions/summaryWorker.ts:39-48` (`SummaryCandidate`)
**Code:**
```ts
/** One idle session as the light candidate query returns it. */
export interface SummaryCandidate {
  sessionId: string;
  lastActiveAt: Date;
  summarySha: string | null;
  summarizedAt: Date | null;
  /** Stored embedding's sha / model / embed-text version; null when there is none. */
  embeddingSha: string | null;
  embeddingModel: string | null;
  embeddingTextVersion: number | null;
}
```

**File:** `src/sessions/summaryWorker.ts:73` (in `SummaryStore`)
**Code:**
```ts
  saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[]; textVersion: number }): Promise<void>;
```

**File:** `src/sessions/summaryWorker.ts:91-98` (`CandidateDbRow`)
**Code:**
```ts
type CandidateDbRow = {
  session_id: string;
  last_active_at: Date | string;
  summary_sha: string | null;
  summarized_at: Date | string | null;
  embedding_sha: string | null;
  embedding_model: string | null;
  embedding_text_version: number | null;
};
```

**File:** `src/sessions/summaryWorker.ts:118-213` (`toCandidates` and `dbSummaryStore`, replace both)
**Code:**
```ts
function toCandidates(rows: readonly CandidateDbRow[]): SummaryCandidate[] {
  const out: SummaryCandidate[] = [];
  for (const r of rows) {
    const lastActiveAt = toDate(r.last_active_at);
    if (lastActiveAt === null) continue;
    out.push({
      sessionId: r.session_id,
      lastActiveAt,
      summarySha: r.summary_sha,
      summarizedAt: toDate(r.summarized_at),
      embeddingSha: r.embedding_sha,
      embeddingModel: r.embedding_model,
      embeddingTextVersion: r.embedding_text_version,
    });
  }
  return out;
}

/** Reads by raw SQL on the phase-1 column names; writes only through SessionsRepo (invariant 3). */
export function dbSummaryStore(db: Db, repo: SessionsRepo): SummaryStore {
  return {
    async listIdle(o) {
      const needSummary = o.wantSummary
        ? sql`(s.summarized_at is null or s.summarized_at < s.last_active_at)`
        : sql`false`;
      // text_version below the current layout: the vector predates it (e.g. migration 0013), so
      // every such session is listed until processOne re-embeds it once.
      const needEmbedding =
        o.embeddingModel !== null
          ? sql`(e.session_id is null or e.embedding is null or e.embedded_at is null or e.model <> ${o.embeddingModel} or e.text_version < ${SESSION_EMBED_TEXT_VERSION}::integer or e.embedded_at < s.last_active_at or (s.summarized_at is not null and e.embedded_at < s.summarized_at))`
          : sql`false`;
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id, s.last_active_at, s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model, e.text_version as embedding_text_version
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.last_active_at is not null
          and s.last_active_at < ${o.idleBefore.toISOString()}::timestamptz
          and (${needSummary} or ${needEmbedding})
        order by s.last_active_at desc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      return toCandidates(res.rows);
    },
    async listRequested(o) {
      // last_active_at can be null on a row that has only just been created; the request time
      // stands in so the candidate (and the `seen` bookkeeping keyed on it) stays well defined.
      const res = await db.execute<CandidateDbRow>(sql`
        select s.session_id,
               coalesce(s.last_active_at, s.started_at, s.summary_requested_at) as last_active_at,
               s.summary_sha, s.summarized_at,
               e.sha as embedding_sha, e.model as embedding_model, e.text_version as embedding_text_version
        from cc_sessions s
        left join cc_session_embeddings e on e.session_id = s.session_id
        where s.host = ${o.host}
          and s.summary_requested_at is not null
        order by s.summary_requested_at asc, s.session_id asc
        limit ${Math.max(1, Math.trunc(o.limit))}
      `);
      return toCandidates(res.rows);
    },
    async load(sessionIds) {
      if (sessionIds.length === 0) return [];
      const res = await db.execute<SourceDbRow>(sql`
        select session_id, node_id, repo, branch, name, custom_title, ai_title, first_prompt,
               prompts, commits, files_edited, plan_docs, final_message, summary, summary_sha
        from cc_sessions
        where session_id in (${idList(sessionIds)})
      `);
      return res.rows.map((r) => ({
        sessionId: r.session_id,
        nodeId: r.node_id,
        repo: r.repo,
        branch: r.branch,
        name: r.name,
        customTitle: r.custom_title,
        aiTitle: r.ai_title,
        firstPrompt: r.first_prompt,
        prompts: r.prompts,
        commits: r.commits,
        filesEdited: r.files_edited,
        planDocs: r.plan_docs,
        finalMessage: r.final_message,
        summary: r.summary,
        summarySha: r.summary_sha,
      }));
    },
    async saveSummary(v) {
      await repo.setSummary(v.sessionId, { summary: v.summary, sha: v.summarySha });
    },
    async saveEmbedding(v) {
      await repo.saveEmbedding(v.sessionId, { sha: v.sha, model: v.model, embedding: v.embedding, textVersion: v.textVersion });
    },
    async clearRequest(sessionId) {
      await repo.clearSummaryRequest(sessionId);
    },
  };
}
```

**File:** `src/sessions/summaryWorker.ts:313-397` (`processOne` inside `startSummaryWorker`, replace the whole function incl. its doc comment)
**Code:**
```ts
  /**
   * One session: its summary (summarizer on and not paused), then its embedding. `requested`: the
   * row carries summary_requested_at. An up-to-date summary is then saved again (setSummary clears
   * the request, no model call), and a row with nothing to summarize has its request dropped.
   * The vector is rebuilt when the embed text's sha or the model changed, or when it was made from
   * an older embed-text layout (text_version < SESSION_EMBED_TEXT_VERSION), even if the text is the same.
   */
  async function processOne(
    row: SessionSummarySource,
    c: SummaryCandidate,
    report: SummaryDrainReport,
    requested: boolean,
  ): Promise<void> {
    const id = row.sessionId;
    const signal = abort.signal;
    let summary = row.summary;
    let failure: string | null = null;
    const summarize = summarizer !== null && !summariesPaused();
    const deferred = summarizer !== null && !summarize;

    if (summarize && summarizer !== null) {
      const input = buildSummaryInput(row);
      if (input === null) {
        // No prompts and no final message: a request for this row can never be served.
        if (requested) await store.clearRequest(id);
      } else {
        const sha = summaryInputSha(input);
        if (sha === row.summarySha && row.summary !== null) {
          const stale = c.summarizedAt === null || c.summarizedAt.getTime() < c.lastActiveAt.getTime();
          if (requested || stale) {
            await store.saveSummary({ sessionId: id, summary: row.summary, summarySha: sha });
          }
        } else {
          if (!(await summaryLimiter.acquire(signal))) return;
          try {
            const clean = cleanSummary(await summarizer.summarize({ sessionId: id, input, signal }));
            if (clean === '') throw new Error('the summarizer returned an empty summary');
            await store.saveSummary({ sessionId: id, summary: clean, summarySha: sha });
            summary = clean;
            report.summarized += 1;
            consecutiveSummaryFailures = 0;
          } catch (err) {
            if (signal.aborted) return;
            failure = errorMessage(err);
            consecutiveSummaryFailures += 1;
            if (consecutiveSummaryFailures >= PAUSE_AFTER_FAILURES) {
              const wait = retryDelayMs(consecutiveSummaryFailures - PAUSE_AFTER_FAILURES + 1);
              pausedUntil = clock.now() + wait;
              log(`[notesd] session summaries: ${consecutiveSummaryFailures} failures in a row, pausing summaries for ${Math.round(wait / 1000)} s`);
            }
          }
        }
      }
    }

    if (embedder !== null) {
      const text = buildEmbedText({ ...row, summary });
      if (text !== null) {
        const sha = embedTextSha(text);
        const olderLayout = (c.embeddingTextVersion ?? 0) < SESSION_EMBED_TEXT_VERSION;
        if (sha !== c.embeddingSha || c.embeddingModel !== embedder.model || olderLayout) {
          if (!(await embedLimiter.acquire(signal))) return;
          try {
            const vectors = await embedder.embed([text]);
            const vector = vectors[0];
            if (vector === undefined || vector.length !== EMBEDDING_DIMENSIONS) {
              throw new Error(`the embedder returned ${vector?.length ?? 0} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
            }
            await store.saveEmbedding({ sessionId: id, sha, model: embedder.model, embedding: vector, textVersion: SESSION_EMBED_TEXT_VERSION });
            report.embedded += 1;
          } catch (err) {
            if (signal.aborted) return;
            failure ??= embeddingErrorText(err);
          }
        }
      }
    }

    if (failure !== null) {
      fail(report, id, failure);
      return;
    }
    // A row whose summary step was skipped by the pause is picked up again after it.
    if (deferred) return;
    seen.set(id, c.lastActiveAt.getTime());
    attempts.delete(id);
    retryAt.delete(id);
  }
```
**Impact:** after the daemon restarts on this code (the in-process `seen` map is empty then), each
host's worker rebuilds its own idle sessions' vectors once, newest first, at the existing
1 call/s embed limiter. Until then the old vectors keep serving search (search ignores
`text_version`). Live/non-idle sessions are rebuilt once they go idle.

### Step 7: Unit tests
**File:** `tests/unit/sessions/summarize.test.ts:8-19` (import list)
**Change:** add `MAX_EMBED_COMMITS` and `commitSubjects` to the import from `'../../../src/sessions/summarize.js'`:
```ts
import {
  MAX_EMBED_COMMITS,
  SUMMARY_MODEL,
  asLines,
  buildEmbedText,
  buildSummaryInput,
  cleanSummary,
  commitSubjects,
  createAgentSummarizer,
  embedTextSha,
  findClaudeBin,
  summaryInputSha,
  type SessionSummarySource,
} from '../../../src/sessions/summarize.js';
```
(keep any other names the current import list has; this list shows the current ones plus the two new.)

**File:** `tests/unit/sessions/summarize.test.ts:140` (after the `describe('shas', ...)` block)
**Code:**
```ts
describe('commit subjects in the embed text', () => {
  it('commitSubjects takes subjects (or messages, or strings), never shas', () => {
    expect(
      commitSubjects([{ sha: '0123456789abcdef', subject: ' fix(wall): spinner ' }, { message: 'chore: bump' }, 'docs: readme', { sha: 'x' }, null, 3]),
    ).toEqual(['fix(wall): spinner', 'chore: bump', 'docs: readme']);
    expect(commitSubjects(null)).toEqual([]);
    expect(commitSubjects({ subject: 'not a list' })).toEqual([]);
  });

  it('puts commit subjects after the summary and before the prompts, without the sha', () => {
    const text = buildEmbedText(source({ summary: 'Made the wall editable.' })) ?? '';
    const summaryAt = text.indexOf('Made the wall editable.');
    const commitAt = text.indexOf('feat(web): edit on the wall');
    const promptAt = text.indexOf('also delete photos');
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(summaryAt);
    expect(promptAt).toBeGreaterThan(commitAt);
    expect(text).not.toContain('8c259df0');
  });

  it('keeps commit subjects when long prompts fill the 8000-char clamp', () => {
    const prompts = Array.from({ length: 40 }, (_, i) => `prompt ${i} ${'x'.repeat(480)}`);
    const text = buildEmbedText(source({ prompts, commits: [{ sha: 'abc', subject: 'fix: zanzibar spinner' }] })) ?? '';
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(text).toContain('fix: zanzibar spinner');
    expect(text).not.toContain('prompt 39');
  });

  it('keeps only the newest MAX_EMBED_COMMITS subjects', () => {
    const commits = Array.from({ length: MAX_EMBED_COMMITS + 5 }, (_, i) => ({ sha: `s${i}`, subject: `subject-${String(i + 1).padStart(2, '0')}` }));
    const text = buildEmbedText(source({ commits })) ?? '';
    expect(text).toContain(`subject-${String(MAX_EMBED_COMMITS + 5).padStart(2, '0')}`);
    expect(text).toContain('subject-06');
    expect(text).not.toContain('subject-05');
  });

  it('a commit changes the embed sha', () => {
    const a = buildEmbedText(source({ commits: [] })) ?? '';
    const b = buildEmbedText(source()) ?? '';
    expect(embedTextSha(a)).not.toBe(embedTextSha(b));
  });
});
```

**File:** `tests/unit/sessions/summaryWorker.test.ts:1-112` (imports, `MemRow`, `MemoryStore`)
**Change:** the memory store keeps the text version with each vector, like the real table.
Replace from the first line through the end of `class MemoryStore` with:
```ts
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../../src/embeddings/backfill.js';
import { SESSION_EMBED_TEXT_VERSION, type SessionSummarySource } from '../../../src/sessions/summarize.js';
import {
  startSummaryWorker,
  type SummaryCandidate,
  type SummaryStore,
  type SummaryWorker,
} from '../../../src/sessions/summaryWorker.js';
import { createFakeEmbedder } from '../../helpers/fakeEmbedder.js';
import { createFakeSummarizer } from '../../helpers/fakeSummarizer.js';

const HOST = 'lenovo';
const OLD = new Date(Date.now() - 60 * 60_000);

interface MemRow extends SessionSummarySource {
  host: string;
  lastActiveAt: Date;
  summarizedAt: Date | null;
  requestedAt: Date | null;
  embedding: { sha: string; model: string; vector: number[]; textVersion: number } | null;
}

class MemoryStore implements SummaryStore {
  readonly rows = new Map<string, MemRow>();
  summarySaves = 0;
  embeddingSaves = 0;
  requestClears = 0;

  add(over: Partial<MemRow> & { sessionId: string }): MemRow {
    const row: MemRow = {
      nodeId: 'A0-3G',
      repo: 'mcp-notes',
      branch: null,
      name: null,
      customTitle: 'wall editing',
      aiTitle: null,
      firstPrompt: null,
      prompts: ['make the wall editable'],
      commits: [],
      filesEdited: [],
      planDocs: [],
      finalMessage: 'done',
      summary: null,
      summarySha: null,
      host: HOST,
      lastActiveAt: OLD,
      summarizedAt: null,
      requestedAt: null,
      embedding: null,
      ...over,
    };
    this.rows.set(row.sessionId, row);
    return row;
  }

  private candidate(r: MemRow): SummaryCandidate {
    return {
      sessionId: r.sessionId,
      lastActiveAt: r.lastActiveAt,
      summarySha: r.summarySha,
      summarizedAt: r.summarizedAt,
      embeddingSha: r.embedding?.sha ?? null,
      embeddingModel: r.embedding?.model ?? null,
      embeddingTextVersion: r.embedding?.textVersion ?? null,
    };
  }

  async listIdle(o: Parameters<SummaryStore['listIdle']>[0]): Promise<SummaryCandidate[]> {
    return [...this.rows.values()]
      .filter((r) => r.host === o.host && r.lastActiveAt < o.idleBefore)
      .sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
      .slice(0, o.limit)
      .map((r) => this.candidate(r));
  }

  async listRequested(o: Parameters<SummaryStore['listRequested']>[0]): Promise<SummaryCandidate[]> {
    return [...this.rows.values()]
      .filter((r): r is MemRow & { requestedAt: Date } => r.host === o.host && r.requestedAt !== null)
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
      .slice(0, o.limit)
      .map((r) => this.candidate(r));
  }

  async load(ids: readonly string[]): Promise<SessionSummarySource[]> {
    return ids.flatMap((id) => {
      const r = this.rows.get(id);
      return r === undefined ? [] : [{ ...r }];
    });
  }

  /** Like SessionsRepo.setSummary: a saved summary also clears a pending request. */
  async saveSummary(v: { sessionId: string; summary: string; summarySha: string }): Promise<void> {
    const r = this.rows.get(v.sessionId)!;
    r.summary = v.summary;
    r.summarySha = v.summarySha;
    r.summarizedAt = new Date();
    r.requestedAt = null;
    this.summarySaves += 1;
  }

  async saveEmbedding(v: { sessionId: string; sha: string; model: string; embedding: number[]; textVersion: number }): Promise<void> {
    this.rows.get(v.sessionId)!.embedding = { sha: v.sha, model: v.model, vector: v.embedding, textVersion: v.textVersion };
    this.embeddingSaves += 1;
  }

  async clearRequest(sessionId: string): Promise<void> {
    this.rows.get(sessionId)!.requestedAt = null;
    this.requestClears += 1;
  }
}
```
(The `Clock` import is unchanged from today's file; later tests use it.)

**File:** `tests/unit/sessions/summaryWorker.test.ts` (append inside `describe('summary worker', ...)`, after the `'without a summarizer still embeds; ...'` test)
**Code:**
```ts
  it('stores the current embed-text version with each vector', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const w = start(store, { summarizer: null });
    await w.idle();
    expect(store.rows.get('s-1')?.embedding?.textVersion).toBe(SESSION_EMBED_TEXT_VERSION);
    await w.close();
  });

  it('re-embeds a vector from an older embed-text layout once, even when its text is unchanged', async () => {
    const store = new MemoryStore();
    store.add({ sessionId: 's-1' });
    const first = start(store, { summarizer: null });
    await first.idle();
    await first.close();
    const row = store.rows.get('s-1')!;
    row.embedding = { ...row.embedding!, textVersion: SESSION_EMBED_TEXT_VERSION - 1 };
    const sha = row.embedding.sha;

    const embedder = createFakeEmbedder();
    const second = start(store, { summarizer: null, embedder });
    await second.idle();
    await second.close();
    expect(embedder.calls).toHaveLength(1);
    expect(row.embedding?.sha).toBe(sha);
    expect(row.embedding?.textVersion).toBe(SESSION_EMBED_TEXT_VERSION);

    const again = createFakeEmbedder();
    const third = start(store, { summarizer: null, embedder: again });
    await third.idle();
    await third.close();
    expect(again.calls).toHaveLength(0);
  });

  it('re-embeds when a new commit changes the embed text', async () => {
    const store = new MemoryStore();
    const row = store.add({ sessionId: 's-1' });
    const first = start(store, { summarizer: null });
    await first.idle();
    await first.close();
    const before = row.embedding?.sha;
    row.commits = [{ sha: 'abc1234', subject: 'fix(wall): zanzibar spinner', at: null }];
    row.lastActiveAt = new Date(OLD.getTime() + 1000);

    const embedder = createFakeEmbedder();
    const second = start(store, { summarizer: null, embedder });
    await second.idle();
    await second.close();
    expect(embedder.calls.flat().join('\n')).toContain('fix(wall): zanzibar spinner');
    expect(row.embedding?.sha).not.toBe(before);
  });
```

**File:** `tests/integration/sessions.repo.int.test.ts:378-383` (`'saves vectors and records failures with backoff'`)
**Change:** pass `textVersion` and read it back. Replace the three `saveEmbedding` lines with:
```ts
      expect(await repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: v, textVersion: 1 })).toBe(true)
      expect(
        (await db.execute<{ text_version: number }>(sql`select text_version from cc_session_embeddings where session_id = 's-1'`)).rows[0],
      ).toEqual({ text_version: 1 })
      expect(await repo.saveEmbedding('missing', { sha: 'h1', model: 'm', embedding: v, textVersion: 1 })).toBe(false)
      await expect(repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: [1, 2], textVersion: 1 })).rejects.toThrow(/dimensions/)
```
(this file uses no semicolons; keep its style.)

### Step 8: Migration test on a 0012 database with data
**File:** `tests/integration/migration0013.int.test.ts` (new)
**Change:** same structure as `tests/integration/migration0010.int.test.ts` (own database inside
the Docker container, migrations copied up to a journal idx). Proves: one migration applied,
existing rows' `search_tsv` now matches a commit-only word, the index is back on `search_tsv`,
existing embedding rows get `text_version 0`, nothing else in `cc_sessions` changed.
**Code:**
```ts
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js';

/**
 * Migration 0013 on a 0012-shaped database that already holds sessions: `cc_sessions.search_tsv`
 * is re-generated with commit subjects (column dropped and re-added, GIN index dropped and
 * recreated) and `cc_session_embeddings.text_version` is added (0 for existing rows). Runs in its
 * own database inside the Docker container.
 */

const DB_PREFIX = 'mcp_notes_mig0013_';

type Journal = { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;

function urlForDatabase(name: string): string {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

async function dropStaleDatabases(admin: Db): Promise<void> {
  const res = await admin.execute<{ datname: string }>(sql`select datname from pg_database where starts_with(datname, ${DB_PREFIX})`);
  for (const row of res.rows) await admin.execute(sql.raw(`drop database if exists "${row.datname}" with (force)`));
}

/** A migrations folder holding the journal entries with idx <= maxIdx. */
async function migrationsUpTo(maxIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0013-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 13 && kept[13]?.tag !== '0013_session_commit_search') {
    throw new Error('journal entry 13 is not 0013_session_commit_search');
  }
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

describe('migration 0013 (commit subjects in session search, embed-text version)', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: Db;
  let mig: Db;
  const dirs: string[] = [];
  let before: unknown[];

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl());
    await dropStaleDatabases(admin);
    await admin.execute(sql.raw(`create database "${dbName}"`));
    mig = createDb(urlForDatabase(dbName));

    const upTo12 = await migrationsUpTo(12);
    dirs.push(upTo12);
    await migrate(mig, { migrationsFolder: upTo12 });

    await mig.execute(sql`insert into cc_sessions
      (session_id, node_id, host, repo, first_prompt, prompts, commits, summary)
      values
      ('s-1', 'A0-3G', 'pc', 'mcp-notes', 'why does resume break',
       '[{"text":"why does resume break","at":null}]'::jsonb,
       '[{"sha":"0123456789abcdef","subject":"fix(wall): zanzibar spinner stalls","at":null}]'::jsonb,
       'Fixed resume'),
      ('s-2', 'B1-4H', 'GPD', 'seer', null, '[]'::jsonb, '[]'::jsonb, null)`);
    await mig.execute(sql`insert into cc_session_embeddings (session_id, sha, model) values ('s-1', 'sha-old', 'm')`);
    const zero = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'zanzibar')`,
    );
    expect(zero.rows[0]?.n).toBe(0);
    before = (await mig.execute(sql`select to_jsonb(s) - 'search_tsv' as j from cc_sessions s order by session_id`)).rows;

    const upTo13 = await migrationsUpTo(13);
    dirs.push(upTo13);
    await migrate(mig, { migrationsFolder: upTo13 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0012', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(14);
  });

  it('re-generates search_tsv of existing rows with commit subjects, not shas', async () => {
    const hit = await mig.execute<{ session_id: string }>(
      sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'zanzibar spinner')`,
    );
    expect(hit.rows.map((r) => r.session_id)).toEqual(['s-1']);
    const old = await mig.execute<{ session_id: string }>(
      sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'resume')`,
    );
    expect(old.rows.map((r) => r.session_id)).toEqual(['s-1']);
    const sha = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from cc_sessions where search_tsv @@ plainto_tsquery('simple', '0123456789abcdef')`,
    );
    expect(sha.rows[0]?.n).toBe(0);
  });

  it('keeps the GIN index on search_tsv', async () => {
    const res = await mig.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'cc_sessions_search_gin'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.indexdef).toMatch(/USING gin \(search_tsv\)/);
  });

  it('leaves every other session column as it was', async () => {
    const after = await mig.execute(sql`select to_jsonb(s) - 'search_tsv' as j from cc_sessions s order by session_id`);
    expect(after.rows).toEqual(before);
  });

  it('gives existing embedding rows text_version 0, and new rows default 0', async () => {
    const res = await mig.execute<{ session_id: string; text_version: number }>(
      sql`select session_id, text_version from cc_session_embeddings order by session_id`,
    );
    expect(res.rows).toEqual([{ session_id: 's-1', text_version: 0 }]);
    await mig.execute(sql`insert into cc_session_embeddings (session_id, sha, model) values ('s-2', 'x', 'm')`);
    const fresh = await mig.execute<{ text_version: number }>(sql`select text_version from cc_session_embeddings where session_id = 's-2'`);
    expect(fresh.rows[0]?.text_version).toBe(0);
  });

  it('a commit written after the migration is searchable at once', async () => {
    await mig.execute(sql`update cc_sessions set commits = '[{"sha":"abc","subject":"feat: quokka graph","at":null}]'::jsonb where session_id = 's-2'`);
    const res = await mig.execute<{ session_id: string }>(
      sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'quokka')`,
    );
    expect(res.rows.map((r) => r.session_id)).toEqual(['s-2']);
  });
});
```
Note: `tests/integration/sessions.schema.int.test.ts` already asserts `cc_sessions_search_gin`
exists after the full migrate, so a 0013 that loses the index also fails there.

### Step 9: Docs and feature map
**File:** `README.md:690-692` (paragraph under "### Summaries and search")
**Change:** replace the paragraph starting "Summaries are embedded like notes" with:
```markdown
Summaries are embedded like notes and searched the same way: words, meaning and recency blended
with the weights in `src/search/blend.ts`. A session's commit messages count as its own text:
their subjects are in its full-text index and in the text its vector is made from (before the
prompts, so a long session does not cut them off). When the embed-text layout changes, each daemon
re-embeds its own sessions once in the background. Without `OPENROUTER_API_KEY` session search is
words only and says so.
```

**File:** `README.md:1039` (`sessions_search` row of the MCP table)
**Change:** replace "over their summaries, names and prompts" with "over their summaries, names, prompts and commit messages". The full row becomes:
```markdown
| `sessions_search` | Claude Code sessions by meaning and by words over their summaries, names, prompts and commit messages, blended like `search`; filter by `repo`. Each hit has its node id, repo, times and summary. Says `fallback` when only words were used |
```
(Phase 5 adds `via_replies` to this row; if the row has changed since, apply only the "prompts and commit messages" wording.)

**File:** `CLAUDE.md:41` (Claude Code sessions paragraph)
**Change:** replace the sentence "Idle sessions get Haiku summaries (redacted, embedded, searched with `src/search/blend.ts`)." with:
```markdown
Idle sessions get Haiku summaries (redacted, embedded, searched with `src/search/blend.ts`). A session's full text (`search_tsv`, generated; `drizzle/0013` added commit subjects) and its embed text (`buildEmbedText`: title, summary, commit subjects, then prompts) both include its commits; a vector is current only at `SESSION_EMBED_TEXT_VERSION` (`src/sessions/summarize.ts`, stored in `cc_session_embeddings.text_version`), so bump it when the embed layout changes and the summary worker re-embeds every session once.
```

**File:** `.claude/skills/verify-notesd/features/projects.md`
**Change 1 (Sub-features):** after the "Session search matches a session's notes too ..." bullet, add:
```markdown
- Session search matches a session's commit messages: every commit subject (not the sha) is in the
  session's full-text index (`cc_sessions.search_tsv`, migration 0013) and in the text its vector
  is made from, so a word or meaning only a commit has finds that session, in text and hybrid
  mode. Vectors made before this (`cc_session_embeddings.text_version` 0) are rebuilt once by
  the owning host's summary worker after a restart, then never again.
```
**Change 2 (Driving it with verify.sh):** add before "Summary requests.":
````markdown
Commit messages in search. Fixture `5e55a001-…-000000000001` committed `feat(sessions): ingest
transcripts`; `feat` appears nowhere else in its indexed text (only in tool output, which is not
indexed), so it is a commit-only word:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000001") | .node_id' <<<"$S")
$V sql RUN "select node_id, commits from cc_sessions where session_id = '5e55a001-0000-4000-8000-000000000001'"
$V mcp RUN sessions_search '{"query":"feat"}'        # mode "text" (fallback), hits contain NODE
$V api RUN GET '/api/sessions/search?q=feat'         # same NODE in .hits
$V sql RUN "select indexdef from pg_indexes where indexname = 'cc_sessions_search_gin'"   # gin (search_tsv)
```
With `--embed` (billed, a few embeddings) the vectors carry the version:
`$V sql RUN "select count(*) filter (where text_version = 1) as cur, count(*) as all from cc_session_embeddings where embedding is not null"`
→ `cur = all`. "Rebuilt once, then never again" needs a daemon restart, which `verify.sh` has no
command for: it is proven by `tests/integration/sessions.commitSearch.int.test.ts`.
````

## Principles applied

- Laziness protocol: no new worker, table or job for the forced re-embed; the existing summary worker's candidate SQL gains one predicate and `processOne` one condition, driven by one constant, mirroring `SUMMARY_PROMPT_VERSION` / `PROMPTS_VERSION`. `buildSummaryInput` and `src/sessions/search.ts` are left alone (search ignores `text_version`).
- Make illegal states unrepresentable: `textVersion` is a required field of `SessionEmbeddingInput` and of `SummaryStore.saveEmbedding`, so no caller can save a vector without saying which layout it came from (a default would let a future caller stamp an old-layout vector as current).
- Encode lessons in structure: drizzle-kit's drop/add of a generated column silently drops the GIN index. Instead of a comment only, `migration0013.int.test.ts` asserts the index exists on `search_tsv` after the migration, `sessions.schema.int.test.ts` already asserts it after a full migrate, and the schema header comment records why 0013 carries hand-added index statements.
- Sequence into verifiable units / fix root causes: Step 1 writes the commit-search integration test first, so it fails on today's schema (no session found for a commit-only word), then passes after Step 6.
- Test behavior, not implementation: tests assert what a caller sees (`searchSessions` hits, rows in `cc_session_embeddings`, embedder call counts), not private SQL strings; the real `dbSummaryStore` SQL is exercised against Postgres because the memory store in the unit test does not filter.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-search-context && npm run typecheck`
**Tests:**
- `npm test` (unit; includes `tests/unit/sessions/summarize.test.ts`, `tests/unit/sessions/summaryWorker.test.ts`)
- `npm run test:int` (Docker Postgres; includes the two new files and `sessions.repo/schema/search/summaries` int tests)
- Focused: `npx vitest run tests/unit/sessions/summarize.test.ts tests/unit/sessions/summaryWorker.test.ts` and `scripts/test-int.sh tests/integration/sessions.commitSearch.int.test.ts tests/integration/migration0013.int.test.ts`
- Golden snapshot (phase 1, which may land before or after this phase): when `tests/integration/sessions.search.golden.int.test.ts` exists in the tree, `scripts/test-int.sh tests/integration/sessions.search.golden.int.test.ts` passes **without** `--update` (its seed has no commits; the new `search_tsv` term adds no lexemes for an empty array). Never regenerate that snapshot in this phase.
- Migration sanity: `DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit check` passes; `grep -c cc_sessions_search_gin drizzle/0013_session_commit_search.sql` prints `2`.

**Proof:**
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree root). `up` creates a fresh DB with all migrations, so 0013 applies on a fresh DB on every run; "on a DB with data" is `migration0013.int.test.ts`.
- Feature-map entries: `features/projects.md` (updated by Step 9), `features/search.md` untouched (note search unchanged).
- Journeys:
  1. **Commit-only word, text mode (MCP + HTTP).**
     ```sh
     cd /home/miftah/.worktrees/mcp-notes/session-search-context
     V=.claude/skills/verify-notesd/scripts/verify.sh
     NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions      # note RUN and URL from the output
     S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
     NODE=$(jq -r '.nodes[] | select(.session_id=="5e55a001-0000-4000-8000-000000000001") | .node_id' <<<"$S")
     $V sql RUN "select commits from cc_sessions where session_id = '5e55a001-0000-4000-8000-000000000001'"
     $V mcp RUN sessions_search '{"query":"feat"}' | sed 1d | jq -r '.mode, ([.hits[].node_id] | join(","))'
     $V api RUN GET '/api/sessions/search?q=feat'
     $V note RUN "commit-only word 'feat' finds the fixture session that committed it"
     ```
     Pass: the `sql` evidence shows a commit with subject `feat(sessions): ingest transcripts`; MCP prints `text` then a list containing `$NODE`; the HTTP evidence body has `"mode":"text"` and a hit with `"node_id":"$NODE"`. Before this phase (same commands on a checkout at `b41ae04`) the hits list is empty; the in-repo reproduction of that is Step 1's test failing before Step 2.
  2. **Schema state on the run.**
     `$V sql RUN "select indexdef from pg_indexes where indexname = 'cc_sessions_search_gin'"` → one row containing `USING gin (search_tsv)`;
     `$V sql RUN "select column_name, column_default, is_nullable from information_schema.columns where table_name = 'cc_session_embeddings' and column_name = 'text_version'"` → `text_version | 0 | NO`;
     `$V sql RUN "select count(*) from drizzle.__drizzle_migrations"` → `14` (or more once Phase 3 lands).
  3. **Hybrid + version stamp (billed).**
     ```sh
     $V down RUN
     NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --embed
     # wait until the summary worker has embedded the idle fixtures (it starts a drain at boot)
     for i in $(seq 60); do n=$($V sql RUN "select count(*) from cc_session_embeddings where embedding is not null" | grep -Eo '^[[:space:]]*[0-9]+' | tr -d ' ' | tail -1); [ "${n:-0}" -ge 1 ] && break; sleep 2; done
     $V sql RUN "select count(*) filter (where text_version = 1) as cur, count(*) as total from cc_session_embeddings where embedding is not null"
     $V mcp RUN sessions_search '{"query":"feat"}' | sed 1d | jq -r '.mode, .fallback, .hits[0].node_id'
     grep 'session summaries:' ~/.local/state/notesd-verify/$RUN/daemon.log
     $V note RUN "hybrid: commit-only word ranks its session first; all vectors at text_version 1"
     ```
     Pass: `cur = total` and `total >= 1`; MCP prints `hybrid`, `null`, then the node id of session `5e55a001-0000-4000-8000-000000000001` (re-read `NODE` from `/api/projects/mcp-notes/sessions` on this run); the log shows `session embeddings: openai/text-embedding-3-small` and an `N embedded` line.
  - "Re-embedded exactly once, then not again" needs a daemon restart between drains, which `verify.sh` cannot do on one run: proven by `tests/integration/sessions.commitSearch.int.test.ts` ("a vector from before the version ... rebuilt exactly once") against real Postgres and by the unit test in `summaryWorker.test.ts`.
- Neighbor check: note-based session search (b41ae04) and own-text search must be unchanged:
  `npx vitest run` is not enough; run `scripts/test-int.sh tests/integration/sessions.search.int.test.ts` (unchanged file, must pass), and on the journey-1 run: `$V mcp RUN sessions_search '{"query":"transcripts"}'` still returns hits (prompt/summary words keep working), and the "Session notes" journey in `features/projects.md` (`sessions_search '{"query":"saved elsewhere"}'` → NODE first with `via_notes`) still passes.
- Cost: journeys 1–2 free (no `--embed`, summarizer off). Journey 3 bills OpenRouter for one embedding per fixture session plus one query embedding (well under $0.001). No LLM turns.
- Cleanup: `$V down RUN` after each run.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass; a word only in a commit subject finds its session in text mode (journey 1) and hybrid mode (journey 3 and the int test); every vector saved by the new worker has `text_version = 1`, a pre-0013 vector is rebuilt exactly once and the next worker run makes no embed call (int + unit tests); `migration0013.int.test.ts` passes on a 0012 DB with data and `verify.sh up` applies all migrations on a fresh DB.

## Handoffs

- **Phase 3:** generate `drizzle/0014_*` only after this phase's `0013_session_commit_search` and `meta/0013_snapshot.json` are in the tree (shared linear journal); add new tables to `schema.ts` without touching `ccSessions.searchTsv` or `ccSessionEmbeddings`. Phase 3's `CLAUDE.md` sessions-paragraph sentence for `cc_session_replies` goes next to the commit sentence added here.
- **Phase 5:** the final docs pass should keep the "commit messages" wording in the README `sessions_search` row and in `features/projects.md`, and may mention commits in the `sessions_search` MCP tool description (`src/mcp/sessionTools.ts:54`, owned by Phase 5) — this phase does not touch that file.
- **Not taken (no R):** searching by commit sha (a sha prefix finding the session that made it) was deliberately left out of `search_tsv`; R1 asks for commit messages. File a card if wanted.

## Rollback

Revert this phase's commit (source, tests, docs, `drizzle/0013_session_commit_search.sql`,
`meta/0013_snapshot.json`, the journal entry). A database that already applied 0013 needs, by hand:
```sql
DROP INDEX IF EXISTS "cc_sessions_search_gin";
ALTER TABLE "cc_sessions" DROP COLUMN "search_tsv";
ALTER TABLE "cc_sessions" ADD COLUMN "search_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", ''))) STORED;
CREATE INDEX "cc_sessions_search_gin" ON "cc_sessions" USING gin ("search_tsv");
ALTER TABLE "cc_session_embeddings" DROP COLUMN "text_version";
DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);
```
Old code ignores `text_version`, so leaving the column in place is also safe. Vectors rebuilt with
commit subjects stay valid for the old code (it re-embeds them only when their sha changes).
Rolling back after Phase 3 landed means rolling Phase 3 back first (0014 sits on top of 0013).
