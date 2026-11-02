# Phase 1: Schema, node ids, SessionsRepo

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R1 — every Claude Code session becomes a `cc_sessions` row with a node id (this phase lands the storage and the single writer; Phase 3 fills it). Also carries the R7 schema (`app_settings`, `chat_threads.project`) by design of the index, so all schema change is one migration.
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/sessions`, `src/db`

---

## Goal

After this phase the database has `cc_sessions`, `cc_session_embeddings`, `cc_pending_spawns`,
`app_settings` and `chat_threads.project` (migration `0007_cc_sessions`), node ids of shape
`A0-3G` can be generated, normalized and spotted in free text (`src/sessions/ids.ts`), and
`SessionsRepo` (`src/sessions/repo.ts`) is the one writer of the session tables: idempotent
offset-guarded transcript upserts, hook upserts, parent links with `env > hook > heuristic`
precedence, pending spawn record/claim, settings, listings, summaries and embeddings. Nothing
calls it yet; no runtime behaviour of the daemon changes.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.

**Creates (schema, `src/db/schema.ts`):**
- `PARENT_LINK_SOURCES` (`['env','hook','heuristic']`), `type ParentLinkSource`
- `interface SessionPrompt { text: string; at: string | null }`
- `interface SessionCommit { sha: string; subject: string; at: string | null }`
- `interface ModelUsage { inputTokens; outputTokens; cacheReadTokens; cacheWriteTokens }` (all `number`)
- tables `ccSessions` (`cc_sessions`), `ccSessionEmbeddings` (`cc_session_embeddings`),
  `ccPendingSpawns` (`cc_pending_spawns`), `appSettings` (`app_settings`)
- `chatThreads.project` (`chat_threads.project text null`) + index `chat_threads_project_updated_idx (project, updated_at)`
- row types `CcSessionRow`, `NewCcSessionRow`, `CcSessionEmbeddingRow`, `CcPendingSpawnRow`, `AppSettingRow`
- `ChatThreadRow` gains `project: string | null` (inferred)

Refinements against the index's draft schema (reconciler: these are deliberate):
- token columns are `bigint not null default 0` (draft: nullable); `prompts`, `commits`,
  `files_edited`, `plan_docs` are `jsonb not null default '[]'`; `models` is `jsonb not null default '{}'`.
- `cost_usd numeric` is read as a JS `number`.
- full-text column is named `search_tsv` (`tsvector GENERATED ALWAYS AS ... STORED`), GIN index
  `cc_sessions_search_gin`, `simple` config, over node_id, repo, name, custom_title, ai_title,
  first_prompt, last_prompt, the `text` of every `prompts` entry, and summary.
- `cc_session_embeddings` mirrors `note_embeddings` (failure tracking columns: `attempts`,
  `last_error`, `next_attempt_at`, `embedded_at`) so Phase 6 needs no migration. Its hash column
  is `sha` (as drafted). `embedding vector(1536)` = `EMBEDDING_DIMENSIONS`, nullable (failure row).
- extra checks: `cc_sessions_node_id_check` (shape), `cc_sessions_parent_pair_check`
  (`parent_session_id` and `parent_link_source` both null or both set).
- extra index `cc_sessions_last_active_idx` (Phase 6 idle detection).

**Creates (`src/sessions/ids.ts`):**
```ts
export const NODE_ID_ALPHABET: string               // same as note ids: [0-9A-Z]
export const NODE_ID_PATTERN: RegExp                // /^[0-9A-Z]{2}-[0-9A-Z]{2}$/
export const NODE_ID_SPACE: number                  // 36^4
export const NODE_ID_CANDIDATE_SOURCE: string       // regex source the prompt hook (Phase 8) copies verbatim
export const MAX_NODE_ID_CANDIDATES: number         // 5
export function generateNodeId(random?: (max: number) => number): string   // never all digits
export function isValidNodeId(value: string): boolean
export function normalizeNodeId(input: string): string | null
export class InvalidNodeIdError extends Error
export function parseNodeId(input: string): string
export function findNodeIdCandidates(text: string): string[]
```
`findNodeIdCandidates` implements the one candidate rule shared with the prompt hook (Phase 8,
reconciled): **upper case as typed, dash required, a whole token** (no letter, digit, `_`, `-`,
`/`, `\`, `.` or `:` before it; no letter, digit, `_`, `-`, `/` or `\` after it, and no `.`/`:`
followed by a letter or digit), **at least one letter**. So `a0-3g`, `re-do`, `10-15`,
`2026-11-02`, `UATP-2960`, `A0-3G.md` are not candidates; `A0-3G`, `AB-CD`, `(A0-3G)`, `A0-3G.`
are. Returns ids in order of first appearance, deduped, at most 5. `generateNodeId` redraws an
all-digit id, so every generated id is quotable under this rule. Lookups of a typed id
(`normalizeNodeId`: case-insensitive, dash optional) are unchanged.

**Creates (`src/sessions/types.ts`):** re-exports of the schema types above plus
`SessionRow`, `SessionListItem`, `TokenCounts`, `TranscriptPatch`, `TranscriptSet`,
`TranscriptUpsertResult`, `HookStart`, `HookStartResult`, `SetParentResult`,
`PendingSpawnInput`, `SpawnClaim`, `SpawnClaimResult`, `PendingSpawnRow`, `ProjectSummary`,
`ListForRepoOptions`, `ListByNameOptions`, `TranscriptOffset`, `SummaryInput`,
`SessionEmbeddingInput`, `SessionEmbeddingFailure`, `SessionsRepoOptions`, and constants
`SELECTED_PROJECT_KEY = 'projects.selected'`, `PENDING_SPAWN_WINDOW_MS = 30_000`,
`PENDING_SPAWN_SKEW_MS = 5_000`, `PARENT_LINK_RANK`, `NODE_ID_ATTEMPTS = 8`, `MAX_PROMPTS = 100`,
`MAX_PROMPT_CHARS = 2000`, `MAX_TITLE_CHARS = 300`, `MAX_COMMITS = 200`, `MAX_FILES_EDITED = 500`,
`MAX_PLAN_DOCS = 100`, `MAX_FINAL_MESSAGE_CHARS = 8000`, `LIST_DEFAULT_LIMIT = 1000`, `LIST_MAX_LIMIT = 5000`.

**Creates (`src/sessions/merge.ts`, pure):** `mergeTranscriptPatch(row, patch): TranscriptSet`,
`earliest`, `latest`, `clip`, `normalizeCwd`.

**Creates (`src/sessions/repo.ts`):** `class SessionsRepo` — the published API every later phase calls:
```ts
constructor(db: Db, opts?: SessionsRepoOptions)                     // { random?, now? }
ensureSession(sessionId: string, host: string): Promise<SessionRow>  // creates minimal row + node id (retry on clash)
getBySessionId(sessionId: string): Promise<SessionRow | null>
getByNodeId(input: string): Promise<SessionRow | null>              // case/dash tolerant; null for non-ids
getManyByNodeIds(inputs: readonly string[]): Promise<SessionRow[]>  // existing only, input order, deduped
upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult>
upsertFromHook(start: HookStart): Promise<HookStartResult>
setParent(childSessionId: string, parentSessionId: string, source: ParentLinkSource): Promise<SetParentResult>
listChildren(parentSessionId: string): Promise<SessionListItem[]>
listByName(name: string, opts?: ListByNameOptions): Promise<SessionListItem[]>
listProjects(): Promise<ProjectSummary[]>
listForRepo(repo: string, opts?: ListForRepoOptions): Promise<SessionListItem[]>
offsets(host: string): Promise<Map<string, TranscriptOffset>>
recordPendingSpawn(input: PendingSpawnInput): Promise<PendingSpawnRow>
claimPendingSpawn(claim: SpawnClaim): Promise<SpawnClaimResult | null>
prunePendingSpawns(before: Date): Promise<number>
setSummary(sessionId: string, input: SummaryInput): Promise<boolean>
saveEmbedding(sessionId: string, input: SessionEmbeddingInput): Promise<boolean>
recordEmbeddingFailure(sessionId: string, input: SessionEmbeddingFailure): Promise<void>
getSetting(key: string): Promise<unknown | null>
putSetting(key: string, value: unknown): Promise<void>             // null/undefined deletes the key
getSelectedProject(): Promise<string | null>
setSelectedProject(repo: string | null): Promise<void>
```
Index-draft name mapping: the draft's "`setting/get + put`" is `getSetting`/`putSetting`
(+ `getSelectedProject`/`setSelectedProject`); `embeddings upsert` is `saveEmbedding`/`recordEmbeddingFailure`.

**Semantics later phases rely on:**
- `upsertFromTranscript` is a compare-and-set on `transcript_offset`. `patch.fromOffset === 0`
  means "this patch describes the file from byte 0": accumulators (tokens, models, prompts,
  commits, files_edited, plan_docs) are **replaced**. `fromOffset > 0` is applied only when the
  stored `transcript_offset === fromOffset`; accumulators are **added/appended**. Any other
  stored offset returns `{applied:false, reason:'offset_mismatch', storedOffset}` and changes
  nothing (so replaying a patch is a no-op). A row whose `host` differs returns
  `reason:'other_host'`. Scalars are `patch.x ?? row.x` (a null/undefined never clobbers a
  hook-reported name/tmux/cwd); `first_prompt` keeps the earliest; `started_at` = min,
  `last_active_at` = max; `cost_usd` is an absolute total (latest `cost-state`), not a delta;
  `tokens` and `models` are deltas.
- `setParent` applies when the existing source rank `<=` the new one (`env 3 > hook 2 > heuristic 1`),
  so equal-rank re-links overwrite (heuristic refinement). Returns `'set' | 'kept' | 'missing' | 'self' | 'cycle'`.
  The child row must exist (`'missing'` otherwise); the parent row need not.
- `upsertFromHook` ensures both the child row and (if given) the parent row exist, so both node
  ids are available to the SessionStart hook immediately. Default `parentSource` is `'env'`.
- `claimPendingSpawn` matches `host`, normalized `cwd` (trailing slashes stripped on record and
  claim), unclaimed, `created_at` in `[at - windowMs, at + 5 s]`, parent ≠ child, and name
  (spawn name null, claim name null, or equal; an equal name is preferred, then newest). It
  claims at most once (`for update skip locked`) and sets the child's parent with source `'hook'`
  in the same transaction (child row ensured first).
- Listings (`listProjects`, `listForRepo`, `listChildren`, `listByName`) include only rows whose
  `entrypoint` is `'cli'` or null (hook-created rows not yet ingested). Order key for
  `listForRepo` is `coalesce(started_at, created_at) desc, session_id`; `before` is exclusive.

**Requires (from earlier phases):** none.

**Leaves alone (owned by others):** `src/sessions/{transcript,repoResolve,registry,ingest}.ts`,
`src/config.ts`, `src/background.ts` (Phase 3); `src/sessions/links.ts` (Phase 4);
`claude/hooks/*`, `src/http/sessionHooks.ts`, `scripts/*` (Phase 5 / 8); `src/sessions/{summarize,redact,summaryWorker,search}.ts` (Phase 6);
`src/http/*`, `src/mcp/*`, `src/chat/*` (Phases 7, 9, 12); `web/` (10–13); docs (14).
`src/chat/types.ts` `toThreadView` is NOT changed to expose `project` (Phase 12).

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts:2-15` | modify | import `bigint`, `customType`, `numeric` |
| `src/db/schema.ts:26-31` | modify | header comment mentions migration 0007 |
| `src/db/schema.ts:348` / `:355` | modify | `chatThreads.project` column + `chat_threads_project_updated_idx` |
| `src/db/schema.ts:431` (after `chatMessageAttachments`) | modify | new session types, `tsvector` custom type, four tables |
| `src/db/schema.ts:447` (end) | modify | new row type exports |
| `drizzle/0007_cc_sessions.sql` | create | generated by drizzle-kit (expected text below) |
| `drizzle/meta/0007_snapshot.json` | create | generated by drizzle-kit |
| `drizzle/meta/_journal.json` | modify | generated: entry idx 7, tag `0007_cc_sessions` |
| `src/sessions/ids.ts` | create | node id helpers |
| `src/sessions/types.ts` | create | repo types + constants |
| `src/sessions/merge.ts` | create | pure transcript-patch merge |
| `src/sessions/repo.ts` | create | `SessionsRepo` |
| `tests/integration/setup.ts:50` | modify | `truncateAll` also truncates the four new tables |
| `tests/unit/sessions/ids.test.ts` | create | node id unit tests |
| `tests/unit/sessions/merge.test.ts` | create | merge unit tests |
| `tests/unit/sessions/schema.test.ts` | create | vector width + source list checks |
| `tests/integration/sessions.schema.int.test.ts` | create | migration shape, checks, chat_threads.project |
| `tests/integration/sessions.repo.int.test.ts` | create | repo behaviour |

## Implementation Steps

### Step 0: Install dependencies in the worktree
The worktree has no `node_modules`. Run `npm ci` in `/home/miftah/.worktrees/mcp-notes/project-session-graph` first.

### Step 1: Schema imports
**File:** `src/db/schema.ts:2-15`
**Change:** replace the pg-core import block.
**Code:**
```ts
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core'
```
**Impact:** none.

### Step 2: Header comment
**File:** `src/db/schema.ts:26-30`
**Change:** in the header doc comment, after the sentence ending "`/n` exchange (src/chat/service.ts is the only writer)." insert:
```ts
 * Migration 0007 (project session graph) adds `cc_sessions`, `cc_session_embeddings`,
 * `cc_pending_spawns` and `app_settings`, and `chat_threads.project`; src/sessions/repo.ts is the
 * only writer of the three `cc_*` tables and of `app_settings`.
```
(The existing "Change a table here, then `npm run db:generate`; ..." sentence stays after it.)

### Step 3: `chat_threads.project`
**File:** `src/db/schema.ts:348` and `:355`
**Change:** add the column after `externalKey`, and the index after `chat_threads_updated_at_idx`. Full replacement of the `chatThreads` definition:
**Code:**
```ts
export const chatThreads = pgTable(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    source: text('source').$type<ChatSource>().notNull(),
    /** The brain of the latest answer (`claude`, `glm`, ...), or null before any answer. */
    brain: text('brain'),
    /** Idempotency key for captured exchanges (phase 8). Null for wall threads. */
    externalKey: text('external_key'),
    /**
     * Repo key (`cc_sessions.repo`, e.g. `mcp-notes`) of the project page the thread was started
     * from (migration 0007). Null for wall and captured threads.
     */
    project: text('project'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Bumped (never lowered) by every message written to the thread. */
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chat_threads_external_key_uniq').on(t.externalKey),
    index('chat_threads_updated_at_idx').on(t.updatedAt),
    index('chat_threads_project_updated_idx').on(t.project, t.updatedAt),
    check('chat_threads_source_check', sql`${t.source} in ('wall', 'claude_code')`),
  ],
)
```
**Impact:** `ChatThreadRow` gains `project: string | null`. `src/chat/repo.ts` `insertThread` uses an explicit values object without `project` (column defaults to null), and `toThreadView` picks fields explicitly, so nothing else changes. Verified no test asserts `chat_threads` column lists.

### Step 4: Session tables
**File:** `src/db/schema.ts`, insert after the closing `)` of `chatMessageAttachments` (currently line 431), before the `export type NoteRow` block.
**Code:**
```ts
/** How a session's parent link was learned, best first. src/sessions/repo.ts enforces the order. */
export const PARENT_LINK_SOURCES = ['env', 'hook', 'heuristic'] as const
export type ParentLinkSource = (typeof PARENT_LINK_SOURCES)[number]

/** One human prompt of a Claude Code session (`cc_sessions.prompts`). `at` is the record's ISO timestamp. */
export interface SessionPrompt {
  text: string
  at: string | null
}

/** One commit a session made (`cc_sessions.commits`). */
export interface SessionCommit {
  sha: string
  subject: string
  at: string | null
}

/** Token totals of one model within a session (`cc_sessions.models[<model>]`). */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Postgres `tsvector`; only ever written by a generated column, never selected by the app. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector'
  },
})

/**
 * One row per Claude Code session (migration 0007), keyed by Claude Code's session UUID. Written
 * only by src/sessions/repo.ts: the transcript ingester fills most columns, the SessionStart hook
 * fills `name`/`tmux`/parent early, the summarizer fills `summary*`. `node_id` (`A0-3G`, see
 * src/sessions/ids.ts) is assigned on first insert and never changes. `host` is the machine that
 * holds the transcript (`os.hostname()`); transcript reads and resume work only there.
 * `parent_session_id` has no foreign key: the parent may not be ingested yet.
 * `transcript_offset` is the byte offset just after the last complete JSONL line consumed.
 */
export const ccSessions = pgTable(
  'cc_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    nodeId: text('node_id').notNull(),
    host: text('host').notNull(),
    /** Resolved repo key, e.g. `mcp-notes` (worktree sessions map to their repo). */
    repo: text('repo'),
    cwd: text('cwd'),
    branch: text('branch'),
    /** `agent-name` record or the hook-reported name, e.g. `impl-project-session-graph-p3`. */
    name: text('name'),
    customTitle: text('custom_title'),
    aiTitle: text('ai_title'),
    firstPrompt: text('first_prompt'),
    lastPrompt: text('last_prompt'),
    /** `cli` for terminal sessions; `sdk-ts` / `sdk-cli` are never ingested. */
    entrypoint: text('entrypoint'),
    version: text('version'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
    /** Latest `cost-state.totalCostUSD` seen (an absolute total, not a sum of deltas). */
    costUsd: numeric('cost_usd', { mode: 'number' }),
    models: jsonb('models').$type<Record<string, ModelUsage>>().notNull().default(sql`'{}'::jsonb`),
    parentSessionId: text('parent_session_id'),
    parentLinkSource: text('parent_link_source').$type<ParentLinkSource>(),
    /** tmux target reported by the live registry / SessionStart hook, e.g. `note:@0.%7`. */
    tmux: text('tmux'),
    transcriptPath: text('transcript_path'),
    transcriptOffset: bigint('transcript_offset', { mode: 'number' }).notNull().default(0),
    transcriptSize: bigint('transcript_size', { mode: 'number' }),
    /** Human prompts, oldest first, capped (src/sessions/types.ts MAX_PROMPTS / MAX_PROMPT_CHARS). */
    prompts: jsonb('prompts').$type<SessionPrompt[]>().notNull().default(sql`'[]'::jsonb`),
    commits: jsonb('commits').$type<SessionCommit[]>().notNull().default(sql`'[]'::jsonb`),
    filesEdited: jsonb('files_edited').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    planDocs: jsonb('plan_docs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    finalMessage: text('final_message'),
    summary: text('summary'),
    /** Opaque hash of the summarizer input the summary came from (Phase 6 decides what it hashes). */
    summarySha: text('summary_sha'),
    summarizedAt: timestamp('summarized_at', { withTimezone: true, mode: 'date' }),
    /** Full text (`simple`) over ids, names, titles, prompts and summary. Never selected by the app. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", ''))`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cc_sessions_node_id_uniq').on(t.nodeId),
    index('cc_sessions_repo_started_idx').on(t.repo, t.startedAt.desc()),
    index('cc_sessions_parent_idx').on(t.parentSessionId),
    index('cc_sessions_host_idx').on(t.host),
    index('cc_sessions_name_idx').on(t.name),
    index('cc_sessions_last_active_idx').on(t.lastActiveAt),
    index('cc_sessions_search_gin').using('gin', t.searchTsv),
    check('cc_sessions_node_id_check', sql`${t.nodeId} ~ '^[0-9A-Z]{2}-[0-9A-Z]{2}$'`),
    check('cc_sessions_parent_link_source_check', sql`${t.parentLinkSource} in ('env', 'hook', 'heuristic')`),
    check('cc_sessions_parent_pair_check', sql`(${t.parentSessionId} is null) = (${t.parentLinkSource} is null)`),
  ],
)

/**
 * One row per session that has (or had) a summary to embed (migration 0007). Mirrors
 * `note_embeddings`: the vector is current iff `embedding is not null`, `sha` equals the hash
 * Phase 6 computes from the session's current summary, and `model` equals EMBEDDING_MODEL.
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

/**
 * A `claude` launch inside tmux seen by the Bash PreToolUse hook (migration 0007): the parent is
 * the session that ran the command. The child's SessionStart claims it within
 * PENDING_SPAWN_WINDOW_MS by host + cwd (+ name). `cwd` is stored without trailing slashes.
 */
export const ccPendingSpawns = pgTable(
  'cc_pending_spawns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    parentSessionId: text('parent_session_id').notNull(),
    cwd: text('cwd').notNull(),
    name: text('name'),
    host: text('host').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Session id of the child that claimed this spawn. */
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    index('cc_pending_spawns_open_idx').on(t.host, t.cwd, t.createdAt).where(sql`${t.claimedBy} is null`),
    index('cc_pending_spawns_created_idx').on(t.createdAt),
  ],
)

/**
 * Small key/value settings shared by both machines (migration 0007), e.g. `projects.selected`
 * (src/sessions/types.ts SELECTED_PROJECT_KEY). Written only through src/sessions/repo.ts.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
})
```
**Impact:** new tables only.

### Step 5: Row type exports
**File:** `src/db/schema.ts`, append after the last line (`export type ChatMessageAttachmentRow ...`, currently 447).
**Code:**
```ts
export type CcSessionRow = typeof ccSessions.$inferSelect
export type NewCcSessionRow = typeof ccSessions.$inferInsert
export type CcSessionEmbeddingRow = typeof ccSessionEmbeddings.$inferSelect
export type CcPendingSpawnRow = typeof ccPendingSpawns.$inferSelect
export type AppSettingRow = typeof appSettings.$inferSelect
```

### Step 6: Generate migration 0007
**Files:** `drizzle/0007_cc_sessions.sql`, `drizzle/meta/0007_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** generated, never hand-written from scratch. `drizzle.config.ts` throws without a
direct URL, and the worktree has no `.env.local`; `generate` does not connect, so a dummy URL is fine:
```sh
cd /home/miftah/.worktrees/mcp-notes/project-session-graph
DATABASE_URL_UNPOOLED=postgres://gen:gen@localhost:5432/gen npx drizzle-kit generate --name cc_sessions
```
It must produce exactly one new migration named `0007_cc_sessions.sql`, journal entry `idx: 7`,
`tag: "0007_cc_sessions"`, and `0007_snapshot.json` whose `prevId` is the `id` of
`0006_snapshot.json` (`6aa24309-c751-4d7c-94ab-ab36a3a9a206`). drizzle-kit should ask no
questions (only additions). Compare the generated SQL with the expected text below; statement
order may differ, the substance must not. If drizzle-kit renders the custom type as
`"tsvector"` (quoted) that is fine — Postgres resolves it. If anything substantive differs,
fix `schema.ts` and regenerate (delete the three generated artifacts first); do not hand-edit
the SQL except as stated in Risks.

Expected `drizzle/0007_cc_sessions.sql` (reference):
```sql
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cc_pending_spawns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"parent_session_id" text NOT NULL,
	"cwd" text NOT NULL,
	"name" text,
	"host" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cc_session_embeddings" (
	"session_id" text PRIMARY KEY NOT NULL,
	"embedding" vector(1536),
	"sha" text NOT NULL,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"embedded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cc_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"node_id" text NOT NULL,
	"host" text NOT NULL,
	"repo" text,
	"cwd" text,
	"branch" text,
	"name" text,
	"custom_title" text,
	"ai_title" text,
	"first_prompt" text,
	"last_prompt" text,
	"entrypoint" text,
	"version" text,
	"started_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parent_session_id" text,
	"parent_link_source" text,
	"tmux" text,
	"transcript_path" text,
	"transcript_offset" bigint DEFAULT 0 NOT NULL,
	"transcript_size" bigint,
	"prompts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commits" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files_edited" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_docs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"final_message" text,
	"summary" text,
	"summary_sha" text,
	"summarized_at" timestamp with time zone,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("node_id", '') || ' ' || coalesce("repo", '') || ' ' || coalesce("name", '') || ' ' || coalesce("custom_title", '') || ' ' || coalesce("ai_title", '') || ' ' || coalesce("first_prompt", '') || ' ' || coalesce("last_prompt", '') || ' ' || coalesce(jsonb_path_query_array("prompts", '$[*].text')::text, '') || ' ' || coalesce("summary", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cc_sessions_node_id_check" CHECK ("cc_sessions"."node_id" ~ '^[0-9A-Z]{2}-[0-9A-Z]{2}$'),
	CONSTRAINT "cc_sessions_parent_link_source_check" CHECK ("cc_sessions"."parent_link_source" in ('env', 'hook', 'heuristic')),
	CONSTRAINT "cc_sessions_parent_pair_check" CHECK (("cc_sessions"."parent_session_id" is null) = ("cc_sessions"."parent_link_source" is null))
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "project" text;--> statement-breakpoint
ALTER TABLE "cc_session_embeddings" ADD CONSTRAINT "cc_session_embeddings_session_id_cc_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."cc_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cc_pending_spawns_open_idx" ON "cc_pending_spawns" USING btree ("host","cwd","created_at") WHERE "cc_pending_spawns"."claimed_by" is null;--> statement-breakpoint
CREATE INDEX "cc_pending_spawns_created_idx" ON "cc_pending_spawns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cc_session_embeddings_embedding_hnsw_idx" ON "cc_session_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "cc_session_embeddings_next_attempt_idx" ON "cc_session_embeddings" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cc_sessions_node_id_uniq" ON "cc_sessions" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "cc_sessions_repo_started_idx" ON "cc_sessions" USING btree ("repo","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cc_sessions_parent_idx" ON "cc_sessions" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX "cc_sessions_host_idx" ON "cc_sessions" USING btree ("host");--> statement-breakpoint
CREATE INDEX "cc_sessions_name_idx" ON "cc_sessions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "cc_sessions_last_active_idx" ON "cc_sessions" USING btree ("last_active_at");--> statement-breakpoint
CREATE INDEX "cc_sessions_search_gin" ON "cc_sessions" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "chat_threads_project_updated_idx" ON "chat_threads" USING btree ("project","updated_at");
```
**Impact:** `migrate()` in `tests/integration/globalSetup.ts` applies it to the test DB; the daemon's
deploy path (`npm run db:migrate`) applies it to Neon. `migration0002/0004` tests copy only
entries up to their idx and are unaffected.

### Step 7: Node ids
**File:** `src/sessions/ids.ts` (new)
**Code:**
```ts
import { randomInt } from 'node:crypto'

import { ID_ALPHABET } from '../notes/ids.js'

/**
 * Node ids name one Claude Code session in the project graph: two characters, a dash, two
 * characters, all from [0-9A-Z] (`A0-3G`). Same alphabet as note ids (`A-B32`) but a different
 * shape, so neither linkifier mistakes one for the other. Generated only here; uniqueness is
 * the caller's job (src/sessions/repo.ts inserts and retries on a unique-index clash).
 */
export const NODE_ID_ALPHABET = ID_ALPHABET

/** Canonical form only. Use `normalizeNodeId` for user input. */
export const NODE_ID_PATTERN = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/

/** 36^4 = 1,679,616 distinct ids. */
export const NODE_ID_SPACE = NODE_ID_ALPHABET.length ** 4

const LOOSE_NODE_ID = /^([0-9A-Z]{2})-?([0-9A-Z]{2})$/

/**
 * Regex source (flags `g`) for spotting node ids in free text: upper case as typed, dash required,
 * a whole token (no letter, digit, _, -, /, \, . or : before it; no letter, digit, _, -, / or \
 * after it, and no "." or ":" followed by a letter or digit). Dates 2026-11-02, times
 * 10:30-11:00, versions 1.12-RC1, paths a/A0-3G, files A0-3G.md, keys UATP-2960, UUIDs and note
 * ids (A-B32) never match; "A0-3G." ending a sentence does. claude/hooks/notes-prompt.mjs
 * (Phase 8) holds this exact source as its NODE_ID_CANDIDATE literal; a test there asserts
 * `NODE_ID_CANDIDATE.source === NODE_ID_CANDIDATE_SOURCE`.
 */
export const NODE_ID_CANDIDATE_SOURCE = String.raw`(?<![0-9A-Za-z_.\/:\\-])([0-9A-Z]{2}-[0-9A-Z]{2})(?![0-9A-Za-z_\/\\-]|[.:][0-9A-Za-z])`

/** At most this many candidates are returned per text (same as the hook's MAX_NODE_IDS). */
export const MAX_NODE_ID_CANDIDATES = 5

const HAS_LETTER = /[A-Z]/

/**
 * A fresh random node id in canonical form, never all digits (an all-digit pair reads as a page
 * range or score, so the candidate rule skips it; redrawing keeps every id quotable in a prompt).
 * `random(n)` must return an integer in [0, n); it defaults to `crypto.randomInt` and is
 * injectable for tests.
 */
export function generateNodeId(random: (max: number) => number = randomInt): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    let raw = ''
    for (let i = 0; i < 4; i++) {
      const ch = NODE_ID_ALPHABET[random(NODE_ID_ALPHABET.length)]
      if (ch === undefined) throw new RangeError('generateNodeId: random() returned an out-of-range index')
      raw += ch
    }
    if (HAS_LETTER.test(raw)) return `${raw.slice(0, 2)}-${raw.slice(2)}`
  }
  throw new RangeError('generateNodeId: random() kept producing all-digit ids')
}

/** True only for the canonical form (`A0-3G`). */
export function isValidNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value)
}

/**
 * Case-insensitive, dash-tolerant lookup form: `a03g`, `a0-3g`, ` A0-3G ` -> `A0-3G`.
 * Returns null for anything that cannot be a node id.
 */
export function normalizeNodeId(input: string): string | null {
  const m = LOOSE_NODE_ID.exec(input.trim().toUpperCase())
  if (!m) return null
  return `${m[1]}-${m[2]}`
}

export class InvalidNodeIdError extends Error {
  override name = 'InvalidNodeIdError'
  constructor(readonly input: string) {
    super(`"${input}" is not a node id. Node ids look like A0-3G (the dash is optional, case does not matter).`)
  }
}

/** `normalizeNodeId` that throws `InvalidNodeIdError` instead of returning null. */
export function parseNodeId(input: string): string {
  const id = normalizeNodeId(input)
  if (id === null) throw new InvalidNodeIdError(input)
  return id
}

/**
 * Node ids that `text` may mention (the NODE_ID_CANDIDATE_SOURCE rule plus "at least one
 * letter"), in order of first appearance, deduped, at most MAX_NODE_ID_CANDIDATES. Same result
 * as the prompt hook's `nodeIdCandidates`. Candidates are not checked against the database;
 * resolve them with SessionsRepo.getManyByNodeIds.
 */
export function findNodeIdCandidates(text: string): string[] {
  const out: string[] = []
  if (text.length < 5 || !text.includes('-')) return out
  const re = new RegExp(NODE_ID_CANDIDATE_SOURCE, 'g')
  for (const m of text.matchAll(re)) {
    const id = m[1]
    if (id === undefined || !HAS_LETTER.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_NODE_ID_CANDIDATES) break
  }
  return out
}
```

### Step 8: Types
**File:** `src/sessions/types.ts` (new)
**Code:**
```ts
import type {
  CcPendingSpawnRow,
  CcSessionRow,
  ModelUsage,
  ParentLinkSource,
  SessionCommit,
  SessionPrompt,
} from '../db/schema.js';

export type { ModelUsage, ParentLinkSource, SessionCommit, SessionPrompt } from '../db/schema.js';
export { PARENT_LINK_SOURCES } from '../db/schema.js';

/** A `cc_sessions` row as the app sees it: every column except the generated `search_tsv`. */
export type SessionRow = Omit<CcSessionRow, 'searchTsv'>;

/** The light projection used by listings (graph payloads): no prompts/commits/files/final message. */
export type SessionListItem = Pick<
  SessionRow,
  | 'sessionId'
  | 'nodeId'
  | 'host'
  | 'repo'
  | 'cwd'
  | 'branch'
  | 'name'
  | 'customTitle'
  | 'aiTitle'
  | 'firstPrompt'
  | 'entrypoint'
  | 'startedAt'
  | 'lastActiveAt'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'parentSessionId'
  | 'parentLinkSource'
  | 'tmux'
  | 'transcriptPath'
  | 'summary'
>;

export type PendingSpawnRow = CcPendingSpawnRow;

/** Settings key of the repo selected in the wall's project sidebar (a JSON string). */
export const SELECTED_PROJECT_KEY = 'projects.selected';

/** A child's SessionStart claims a pending spawn recorded at most this long before it. */
export const PENDING_SPAWN_WINDOW_MS = 30_000;
/** Tolerated clock skew: a spawn recorded up to this long AFTER the claim time still matches. */
export const PENDING_SPAWN_SKEW_MS = 5_000;

/** Parent-link precedence. A link is replaced only by a source of equal or higher rank. */
export const PARENT_LINK_RANK: Readonly<Record<ParentLinkSource, number>> = { env: 3, hook: 2, heuristic: 1 };

/** Inserts tried before ensureSession gives up on finding a free node id. */
export const NODE_ID_ATTEMPTS = 8;

export const MAX_PROMPTS = 100;
export const MAX_PROMPT_CHARS = 2000;
export const MAX_TITLE_CHARS = 300;
export const MAX_COMMITS = 200;
export const MAX_FILES_EDITED = 500;
export const MAX_PLAN_DOCS = 100;
export const MAX_FINAL_MESSAGE_CHARS = 8000;
export const LIST_DEFAULT_LIMIT = 1000;
export const LIST_MAX_LIMIT = 5000;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * What one ingest pass read from a transcript, from byte `fromOffset` to `toOffset` (both on
 * line boundaries). `fromOffset === 0` means the patch describes the whole file so far:
 * accumulators are replaced. Otherwise the stored offset must equal `fromOffset` and
 * accumulators are added to. Scalars: undefined or null = keep the stored value.
 */
export interface TranscriptPatch {
  sessionId: string;
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  /** File size when read. */
  size: number;
  repo?: string | null;
  cwd?: string | null;
  branch?: string | null;
  name?: string | null;
  customTitle?: string | null;
  aiTitle?: string | null;
  /** Only the earliest first prompt is kept. */
  firstPrompt?: string | null;
  lastPrompt?: string | null;
  entrypoint?: string | null;
  version?: string | null;
  finalMessage?: string | null;
  /** Merged as the minimum with the stored value. */
  startedAt?: Date | null;
  /** Merged as the maximum with the stored value. */
  lastActiveAt?: Date | null;
  /** Deltas for the bytes in this patch. */
  tokens?: Partial<TokenCounts>;
  /** Per-model deltas for the bytes in this patch. */
  models?: Record<string, Partial<ModelUsage>>;
  /** Absolute total from the latest `cost-state` record in this patch. */
  costUsd?: number | null;
  /** Appended (or, on fromOffset 0, replacing), capped to the newest MAX_PROMPTS. */
  prompts?: SessionPrompt[];
  /** Appended, deduped by sha, capped to the newest MAX_COMMITS. */
  commits?: SessionCommit[];
  /** Union, first-seen order, capped to MAX_FILES_EDITED. */
  filesEdited?: string[];
  /** Union, first-seen order, capped to MAX_PLAN_DOCS. */
  planDocs?: string[];
}

/** Columns a transcript patch writes. */
export type TranscriptSet = Pick<
  SessionRow,
  | 'repo'
  | 'cwd'
  | 'branch'
  | 'name'
  | 'customTitle'
  | 'aiTitle'
  | 'firstPrompt'
  | 'lastPrompt'
  | 'entrypoint'
  | 'version'
  | 'finalMessage'
  | 'startedAt'
  | 'lastActiveAt'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'costUsd'
  | 'models'
  | 'prompts'
  | 'commits'
  | 'filesEdited'
  | 'planDocs'
  | 'transcriptPath'
  | 'transcriptOffset'
  | 'transcriptSize'
>;

export type TranscriptUpsertResult =
  | { applied: true; row: SessionRow }
  | { applied: false; reason: 'offset_mismatch' | 'other_host'; storedOffset: number; row: SessionRow };

/** What the SessionStart hook reports (Phase 5). */
export interface HookStart {
  sessionId: string;
  host: string;
  cwd?: string | null;
  repo?: string | null;
  name?: string | null;
  tmux?: string | null;
  startedAt?: Date | null;
  /** From `CC_PARENT_SESSION`. */
  parentSessionId?: string | null;
  /** Default 'env'. */
  parentSource?: ParentLinkSource;
}

export interface HookStartResult {
  session: SessionRow;
  /** The parent's row (created if it did not exist), or null when no parent was given. */
  parent: SessionRow | null;
  /** Outcome of linking the parent, or null when no parent was given. */
  parentLink: SetParentResult | null;
}

export type SetParentResult = 'set' | 'kept' | 'missing' | 'self' | 'cycle';

export interface PendingSpawnInput {
  parentSessionId: string;
  host: string;
  cwd: string;
  name?: string | null;
  /** Default: the repo clock. */
  createdAt?: Date;
}

export interface SpawnClaim {
  childSessionId: string;
  host: string;
  cwd: string;
  name?: string | null;
  /** Default: the repo clock. */
  at?: Date;
  /** Default PENDING_SPAWN_WINDOW_MS. */
  windowMs?: number;
}

export interface SpawnClaimResult {
  spawn: PendingSpawnRow;
  parentLink: SetParentResult;
}

export interface ProjectSummary {
  repo: string;
  sessionCount: number;
  /** Newest of last_active_at / started_at / created_at over the repo's sessions. */
  lastActiveAt: Date;
  /** Distinct hosts holding the repo's transcripts, sorted. */
  hosts: string[];
}

export interface ListForRepoOptions {
  /** Exclusive upper bound on coalesce(started_at, created_at): the previous page's last value. */
  before?: Date;
  /** 1..LIST_MAX_LIMIT, default LIST_DEFAULT_LIMIT. */
  limit?: number;
}

export interface ListByNameOptions {
  /** Inclusive bounds on coalesce(started_at, created_at). */
  from?: Date;
  to?: Date;
  host?: string;
}

export interface TranscriptOffset {
  offset: number;
  size: number | null;
  path: string | null;
}

export interface SummaryInput {
  summary: string;
  sha: string;
  /** Default: the repo clock. */
  at?: Date;
}

export interface SessionEmbeddingInput {
  sha: string;
  model: string;
  embedding: number[];
}

export interface SessionEmbeddingFailure {
  sha: string;
  model: string;
  error: string;
}

export interface SessionsRepoOptions {
  /** Node id randomness, `(max) => int in [0, max)`. Default crypto.randomInt. */
  random?: (max: number) => number;
  /** Clock for updated_at / claimed_at / default times. Default `() => new Date()`. */
  now?: () => Date;
}
```

### Step 9: Pure merge
**File:** `src/sessions/merge.ts` (new)
**Code:**
```ts
import type { ModelUsage, SessionCommit, SessionPrompt } from '../db/schema.js';
import {
  MAX_COMMITS,
  MAX_FILES_EDITED,
  MAX_FINAL_MESSAGE_CHARS,
  MAX_PLAN_DOCS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS,
  MAX_TITLE_CHARS,
  type SessionRow,
  type TranscriptPatch,
  type TranscriptSet,
} from './types.js';

/** `value` cut to at most `max` characters, the last one an ellipsis when cut. */
export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function clipOrKeep(value: string | null | undefined, max: number): string | null | undefined {
  return value === null || value === undefined ? value : clip(value, max);
}

/** The earlier of two times; a missing one never wins. */
export function earliest(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() < a.getTime() ? b : a;
}

/** The later of two times; a missing one never wins. */
export function latest(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() > a.getTime() ? b : a;
}

/** A path without trailing slashes (`/` stays `/`), trimmed. Used for spawn matching. */
export function normalizeCwd(cwd: string): string {
  const t = cwd.trim();
  if (t.length <= 1) return t;
  const stripped = t.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function count(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function mergeModels(
  prev: Record<string, ModelUsage>,
  delta: Record<string, Partial<ModelUsage>> | undefined,
  reset: boolean,
): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = reset ? {} : { ...prev };
  for (const [model, d] of Object.entries(delta ?? {})) {
    const base = out[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    out[model] = {
      inputTokens: base.inputTokens + count(d.inputTokens),
      outputTokens: base.outputTokens + count(d.outputTokens),
      cacheReadTokens: base.cacheReadTokens + count(d.cacheReadTokens),
      cacheWriteTokens: base.cacheWriteTokens + count(d.cacheWriteTokens),
    };
  }
  return out;
}

function mergePrompts(prev: SessionPrompt[], next: SessionPrompt[] | undefined, reset: boolean): SessionPrompt[] {
  const incoming = (next ?? [])
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({ text: clip(p.text, MAX_PROMPT_CHARS), at: p.at ?? null }));
  const all = [...(reset ? [] : prev), ...incoming];
  return all.length > MAX_PROMPTS ? all.slice(all.length - MAX_PROMPTS) : all;
}

function mergeCommits(prev: SessionCommit[], next: SessionCommit[] | undefined, reset: boolean): SessionCommit[] {
  const bySha = new Map<string, SessionCommit>();
  for (const c of [...(reset ? [] : prev), ...(next ?? [])]) {
    if (c.sha.length === 0 || bySha.has(c.sha)) continue;
    bySha.set(c.sha, { sha: c.sha, subject: clip(c.subject, MAX_TITLE_CHARS), at: c.at ?? null });
  }
  const all = [...bySha.values()];
  return all.length > MAX_COMMITS ? all.slice(all.length - MAX_COMMITS) : all;
}

function unionStrings(prev: string[], next: string[] | undefined, reset: boolean, max: number): string[] {
  const out = new Set<string>(reset ? [] : prev);
  for (const s of next ?? []) {
    if (out.size >= max) break;
    if (s.length > 0) out.add(s);
  }
  return [...out].slice(0, max);
}

/**
 * The column values `row` takes after applying `patch`. Pure; the caller (SessionsRepo) has
 * already checked the offset precondition. See TranscriptPatch for the rules.
 */
export function mergeTranscriptPatch(row: SessionRow, patch: TranscriptPatch): TranscriptSet {
  const reset = patch.fromOffset === 0;
  const tokens = patch.tokens ?? {};
  const firstPrompt = clipOrKeep(patch.firstPrompt, MAX_PROMPT_CHARS);
  return {
    repo: patch.repo ?? row.repo,
    cwd: patch.cwd ?? row.cwd,
    branch: patch.branch ?? row.branch,
    name: clipOrKeep(patch.name, MAX_TITLE_CHARS) ?? row.name,
    customTitle: clipOrKeep(patch.customTitle, MAX_TITLE_CHARS) ?? row.customTitle,
    aiTitle: clipOrKeep(patch.aiTitle, MAX_TITLE_CHARS) ?? row.aiTitle,
    firstPrompt: reset ? (firstPrompt ?? row.firstPrompt) : (row.firstPrompt ?? firstPrompt ?? null),
    lastPrompt: clipOrKeep(patch.lastPrompt, MAX_PROMPT_CHARS) ?? row.lastPrompt,
    entrypoint: patch.entrypoint ?? row.entrypoint,
    version: patch.version ?? row.version,
    finalMessage: clipOrKeep(patch.finalMessage, MAX_FINAL_MESSAGE_CHARS) ?? row.finalMessage,
    startedAt: earliest(row.startedAt, patch.startedAt),
    lastActiveAt: latest(row.lastActiveAt, patch.lastActiveAt),
    inputTokens: (reset ? 0 : row.inputTokens) + count(tokens.inputTokens),
    outputTokens: (reset ? 0 : row.outputTokens) + count(tokens.outputTokens),
    cacheReadTokens: (reset ? 0 : row.cacheReadTokens) + count(tokens.cacheReadTokens),
    cacheWriteTokens: (reset ? 0 : row.cacheWriteTokens) + count(tokens.cacheWriteTokens),
    costUsd:
      patch.costUsd !== undefined && patch.costUsd !== null && Number.isFinite(patch.costUsd)
        ? patch.costUsd
        : row.costUsd,
    models: mergeModels(row.models, patch.models, reset),
    prompts: mergePrompts(row.prompts, patch.prompts, reset),
    commits: mergeCommits(row.commits, patch.commits, reset),
    filesEdited: unionStrings(row.filesEdited, patch.filesEdited, reset, MAX_FILES_EDITED),
    planDocs: unionStrings(row.planDocs, patch.planDocs, reset, MAX_PLAN_DOCS),
    transcriptPath: patch.transcriptPath,
    transcriptOffset: patch.toOffset,
    transcriptSize: patch.size,
  };
}
```

### Step 10: SessionsRepo
**File:** `src/sessions/repo.ts` (new)
**Code:**
```ts
import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, ne, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { appSettings, ccPendingSpawns, ccSessionEmbeddings, ccSessions } from '../db/schema.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings/constants.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import { clampError, retryDelayMs } from '../embeddings/state.js';
import { pgErrorInfo } from '../notes/imageRepo.js';
import { generateNodeId, normalizeNodeId } from './ids.js';
import { clip, earliest, mergeTranscriptPatch, normalizeCwd } from './merge.js';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  MAX_TITLE_CHARS,
  NODE_ID_ATTEMPTS,
  PARENT_LINK_RANK,
  PENDING_SPAWN_SKEW_MS,
  PENDING_SPAWN_WINDOW_MS,
  SELECTED_PROJECT_KEY,
  type HookStart,
  type HookStartResult,
  type ListByNameOptions,
  type ListForRepoOptions,
  type ParentLinkSource,
  type PendingSpawnInput,
  type PendingSpawnRow,
  type ProjectSummary,
  type SessionEmbeddingFailure,
  type SessionEmbeddingInput,
  type SessionListItem,
  type SessionRow,
  type SessionsRepoOptions,
  type SetParentResult,
  type SpawnClaim,
  type SpawnClaimResult,
  type SummaryInput,
  type TranscriptOffset,
  type TranscriptPatch,
  type TranscriptUpsertResult,
} from './types.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Name of the unique index on cc_sessions.node_id; a 23505 on it means "pick another id". */
export const NODE_ID_UNIQUE_INDEX = 'cc_sessions_node_id_uniq';

/** Every cc_sessions column except the generated tsvector. */
function sessionColumns() {
  const { searchTsv, ...rest } = getTableColumns(ccSessions);
  void searchTsv;
  return rest;
}
const SESSION_COLUMNS = sessionColumns();

const LIST_COLUMNS = {
  sessionId: ccSessions.sessionId,
  nodeId: ccSessions.nodeId,
  host: ccSessions.host,
  repo: ccSessions.repo,
  cwd: ccSessions.cwd,
  branch: ccSessions.branch,
  name: ccSessions.name,
  customTitle: ccSessions.customTitle,
  aiTitle: ccSessions.aiTitle,
  firstPrompt: ccSessions.firstPrompt,
  entrypoint: ccSessions.entrypoint,
  startedAt: ccSessions.startedAt,
  lastActiveAt: ccSessions.lastActiveAt,
  inputTokens: ccSessions.inputTokens,
  outputTokens: ccSessions.outputTokens,
  cacheReadTokens: ccSessions.cacheReadTokens,
  cacheWriteTokens: ccSessions.cacheWriteTokens,
  costUsd: ccSessions.costUsd,
  parentSessionId: ccSessions.parentSessionId,
  parentLinkSource: ccSessions.parentLinkSource,
  tmux: ccSessions.tmux,
  transcriptPath: ccSessions.transcriptPath,
  summary: ccSessions.summary,
};

/** Terminal sessions, plus hook-created rows the ingester has not filled yet. */
const CLI_ONLY: SQL = sql`coalesce(${ccSessions.entrypoint}, 'cli') = 'cli'`;

/** Listing order key. */
const ORDER_AT: SQL = sql`coalesce(${ccSessions.startedAt}, ${ccSessions.createdAt})`;

/** `case parent_link_source ... end`: the stored link's rank, 0 when there is none. */
const STORED_RANK: SQL = sql`(case ${ccSessions.parentLinkSource} when 'env' then 3 when 'hook' then 2 when 'heuristic' then 1 else 0 end)`;

const MAX_SESSION_ID_CHARS = 128;

function assertSessionId(id: string, what = 'session id'): void {
  if (id.length === 0 || id.length > MAX_SESSION_ID_CHARS || /\s/.test(id)) {
    throw new TypeError(`invalid ${what}: ${JSON.stringify(id)}`);
  }
}

function assertHost(host: string): void {
  if (host.trim().length === 0) throw new TypeError('host must be non-empty');
}

function assertOffset(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
}

function isNodeIdClash(err: unknown): boolean {
  const info = pgErrorInfo(err);
  if (!info || info.code !== '23505') return false;
  if (info.constraint !== undefined) return info.constraint === NODE_ID_UNIQUE_INDEX;
  return info.message.includes(NODE_ID_UNIQUE_INDEX);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIST_DEFAULT_LIMIT;
  return Math.min(LIST_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The only writer of `cc_sessions`, `cc_session_embeddings`, `cc_pending_spawns` and
 * `app_settings`. Ingest (Phase 3), the heuristic linker (Phase 4), the hook endpoints
 * (Phase 5), the summarizer (Phase 6) and the read API (Phase 7) all go through it.
 */
export class SessionsRepo {
  private readonly random: (max: number) => number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    opts: SessionsRepoOptions = {},
  ) {
    this.random = opts.random ?? randomInt;
    this.now = opts.now ?? (() => new Date());
  }

  // ---------- rows and node ids ----------

  /**
   * The session's row, inserting a minimal one (session id, node id, host) when missing. The
   * node id is drawn at random and redrawn on a clash with another row, NODE_ID_ATTEMPTS times.
   * An existing row keeps its node id and host.
   */
  async ensureSession(sessionId: string, host: string): Promise<SessionRow> {
    assertSessionId(sessionId);
    assertHost(host);
    for (let attempt = 0; attempt < NODE_ID_ATTEMPTS; attempt += 1) {
      const existing = await this.getBySessionId(sessionId);
      if (existing) return existing;
      try {
        const now = this.now();
        const inserted = await this.db
          .insert(ccSessions)
          .values({ sessionId, nodeId: generateNodeId(this.random), host, createdAt: now, updatedAt: now })
          .onConflictDoNothing({ target: ccSessions.sessionId })
          .returning(SESSION_COLUMNS);
        const row = inserted[0];
        if (row) return row;
        // Another writer inserted the same session id first: the next loop reads it.
      } catch (err) {
        if (!isNodeIdClash(err)) throw err;
      }
    }
    throw new Error(`could not find a free node id for session ${sessionId} after ${NODE_ID_ATTEMPTS} attempts`);
  }

  async getBySessionId(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.db.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, sessionId)).limit(1);
    return rows[0] ?? null;
  }

  /** Case-insensitive, dash optional. Null for input that is not a node id, or an id nobody has. */
  async getByNodeId(input: string): Promise<SessionRow | null> {
    const id = normalizeNodeId(input);
    if (id === null) return null;
    const rows = await this.db.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.nodeId, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Rows for the ids that exist, in the order first requested; invalid and unknown ids are dropped. */
  async getManyByNodeIds(inputs: readonly string[]): Promise<SessionRow[]> {
    const ids = [...new Set(inputs.map((s) => normalizeNodeId(s)).filter((s): s is string => s !== null))];
    if (ids.length === 0) return [];
    const rows = await this.db.select(SESSION_COLUMNS).from(ccSessions).where(inArray(ccSessions.nodeId, ids));
    const byId = new Map(rows.map((r) => [r.nodeId, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  private async lock(tx: Tx, sessionId: string): Promise<SessionRow> {
    const rows = await tx.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, sessionId)).for('update');
    const row = rows[0];
    if (!row) throw new Error(`cc_sessions row ${sessionId} disappeared`);
    return row;
  }

  // ---------- transcript ingest (Phase 3) ----------

  /**
   * Applies one ingest pass. Compare-and-set on transcript_offset: see TranscriptPatch. Replaying
   * a patch is a no-op (`offset_mismatch`); the caller then resumes from `storedOffset`.
   */
  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    assertSessionId(patch.sessionId);
    assertHost(patch.host);
    assertOffset(patch.fromOffset, 'fromOffset');
    assertOffset(patch.toOffset, 'toOffset');
    assertOffset(patch.size, 'size');
    if (patch.toOffset < patch.fromOffset) throw new RangeError('toOffset is before fromOffset');
    await this.ensureSession(patch.sessionId, patch.host);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, patch.sessionId);
      if (row.host !== patch.host) {
        return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row } as const;
      }
      if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
        return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row } as const;
      }
      const set = mergeTranscriptPatch(row, patch);
      const updated = await tx
        .update(ccSessions)
        .set({ ...set, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, patch.sessionId))
        .returning(SESSION_COLUMNS);
      const next = updated[0];
      if (!next) throw new Error(`cc_sessions row ${patch.sessionId} disappeared`);
      return { applied: true, row: next } as const;
    });
  }

  /** session_id -> stored offset/size/path, for every row of `host`. The ingester's resume point. */
  async offsets(host: string): Promise<Map<string, TranscriptOffset>> {
    const rows = await this.db
      .select({
        sessionId: ccSessions.sessionId,
        offset: ccSessions.transcriptOffset,
        size: ccSessions.transcriptSize,
        path: ccSessions.transcriptPath,
      })
      .from(ccSessions)
      .where(eq(ccSessions.host, host));
    return new Map(rows.map((r) => [r.sessionId, { offset: r.offset, size: r.size, path: r.path }]));
  }

  // ---------- hooks (Phase 5) ----------

  /**
   * SessionStart: records what the hook knows, without clobbering better data (`name`/`tmux`
   * from the hook win over null; cwd/repo fill only when empty; started_at is the minimum),
   * and links the parent (default source 'env'). Both rows exist afterwards, so both node ids
   * can be returned to the session.
   */
  async upsertFromHook(start: HookStart): Promise<HookStartResult> {
    assertSessionId(start.sessionId);
    assertHost(start.host);
    const parentId = start.parentSessionId ?? null;
    if (parentId !== null) assertSessionId(parentId, 'parent session id');
    await this.ensureSession(start.sessionId, start.host);
    if (parentId !== null && parentId !== start.sessionId) await this.ensureSession(parentId, start.host);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, start.sessionId);
      const name = start.name ? clip(start.name, MAX_TITLE_CHARS) : null;
      await tx
        .update(ccSessions)
        .set({
          name: name ?? row.name,
          tmux: start.tmux ?? row.tmux,
          cwd: row.cwd ?? start.cwd ?? null,
          repo: row.repo ?? start.repo ?? null,
          startedAt: earliest(row.startedAt, start.startedAt ?? null),
          updatedAt: this.now(),
        })
        .where(eq(ccSessions.sessionId, start.sessionId));
      const parentLink =
        parentId === null ? null : await this.setParentIn(tx, start.sessionId, parentId, start.parentSource ?? 'env');
      const session = await this.lock(tx, start.sessionId);
      let parent: SessionRow | null = null;
      if (parentId !== null) {
        const rows = await tx.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, parentId)).limit(1);
        parent = rows[0] ?? null;
      }
      return { session, parent, parentLink };
    });
  }

  /** Bash PreToolUse: a `claude` launched in tmux by `parentSessionId`, not via swarm.py. */
  async recordPendingSpawn(input: PendingSpawnInput): Promise<PendingSpawnRow> {
    assertSessionId(input.parentSessionId, 'parent session id');
    assertHost(input.host);
    const cwd = normalizeCwd(input.cwd);
    if (cwd.length === 0) throw new TypeError('cwd must be non-empty');
    const rows = await this.db
      .insert(ccPendingSpawns)
      .values({
        parentSessionId: input.parentSessionId,
        host: input.host,
        cwd,
        name: input.name ?? null,
        createdAt: input.createdAt ?? this.now(),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert into cc_pending_spawns returned no row');
    return row;
  }

  /**
   * A child's SessionStart claims the newest matching unclaimed spawn (see the contract in the
   * Phase 1 plan) and, in the same transaction, links child -> parent with source 'hook'.
   * Null when nothing matches. A spawn is claimed at most once.
   */
  async claimPendingSpawn(claim: SpawnClaim): Promise<SpawnClaimResult | null> {
    assertSessionId(claim.childSessionId);
    assertHost(claim.host);
    const cwd = normalizeCwd(claim.cwd);
    const at = claim.at ?? this.now();
    const windowMs = claim.windowMs ?? PENDING_SPAWN_WINDOW_MS;
    const from = new Date(at.getTime() - windowMs);
    const to = new Date(at.getTime() + PENDING_SPAWN_SKEW_MS);
    const name = claim.name ?? null;
    await this.ensureSession(claim.childSessionId, claim.host);
    return this.db.transaction(async (tx) => {
      const conditions: SQL[] = [
        eq(ccPendingSpawns.host, claim.host),
        eq(ccPendingSpawns.cwd, cwd),
        isNull(ccPendingSpawns.claimedBy),
        gte(ccPendingSpawns.createdAt, from),
        lte(ccPendingSpawns.createdAt, to),
        ne(ccPendingSpawns.parentSessionId, claim.childSessionId),
      ];
      if (name !== null) conditions.push(sql`(${ccPendingSpawns.name} is null or ${ccPendingSpawns.name} = ${name})`);
      const order: SQL[] =
        name === null
          ? [desc(ccPendingSpawns.createdAt), desc(ccPendingSpawns.id)]
          : [
              sql`(case when ${ccPendingSpawns.name} = ${name} then 0 else 1 end)`,
              desc(ccPendingSpawns.createdAt),
              desc(ccPendingSpawns.id),
            ];
      const found = await tx
        .select()
        .from(ccPendingSpawns)
        .where(and(...conditions))
        .orderBy(...order)
        .limit(1)
        .for('update', { skipLocked: true });
      const spawn = found[0];
      if (!spawn) return null;
      const claimed = await tx
        .update(ccPendingSpawns)
        .set({ claimedBy: claim.childSessionId, claimedAt: this.now() })
        .where(and(eq(ccPendingSpawns.id, spawn.id), isNull(ccPendingSpawns.claimedBy)))
        .returning();
      const row = claimed[0];
      if (!row) return null;
      const parentLink = await this.setParentIn(tx, claim.childSessionId, row.parentSessionId, 'hook');
      return { spawn: row, parentLink };
    });
  }

  /** Deletes spawns (claimed or not) created before `before`. Returns how many. */
  async prunePendingSpawns(before: Date): Promise<number> {
    const rows = await this.db
      .delete(ccPendingSpawns)
      .where(lt(ccPendingSpawns.createdAt, before))
      .returning({ id: ccPendingSpawns.id });
    return rows.length;
  }

  // ---------- parent links (Phases 4, 5) ----------

  /**
   * Links child -> parent unless a better source already linked it (env > hook > heuristic;
   * equal rank overwrites). Refuses self-links and links that would close a cycle. The child
   * row must exist; the parent need not have been ingested.
   */
  async setParent(childSessionId: string, parentSessionId: string, source: ParentLinkSource): Promise<SetParentResult> {
    assertSessionId(childSessionId);
    assertSessionId(parentSessionId, 'parent session id');
    return this.setParentIn(this.db, childSessionId, parentSessionId, source);
  }

  private async setParentIn(
    ex: Executor,
    childSessionId: string,
    parentSessionId: string,
    source: ParentLinkSource,
  ): Promise<SetParentResult> {
    if (childSessionId === parentSessionId) return 'self';
    const cycle = await ex.execute<{ hit: number }>(sql`
      with recursive up(id, depth) as (
        select ${parentSessionId}::text, 0
        union all
        select s.parent_session_id, up.depth + 1
        from cc_sessions s join up on s.session_id = up.id
        where s.parent_session_id is not null and up.depth < 64
      )
      select 1 as hit from up where id = ${childSessionId} limit 1
    `);
    if (cycle.rows.length > 0) return 'cycle';
    const updated = await ex
      .update(ccSessions)
      .set({ parentSessionId, parentLinkSource: source, updatedAt: this.now() })
      .where(and(eq(ccSessions.sessionId, childSessionId), sql`${STORED_RANK} <= ${PARENT_LINK_RANK[source]}::int`))
      .returning({ id: ccSessions.sessionId });
    if (updated.length > 0) return 'set';
    const exists = await ex
      .select({ id: ccSessions.sessionId })
      .from(ccSessions)
      .where(eq(ccSessions.sessionId, childSessionId))
      .limit(1);
    return exists.length > 0 ? 'kept' : 'missing';
  }

  // ---------- listings (Phases 4, 7) ----------

  /** Direct children, oldest first. */
  async listChildren(parentSessionId: string): Promise<SessionListItem[]> {
    return this.db
      .select(LIST_COLUMNS)
      .from(ccSessions)
      .where(and(eq(ccSessions.parentSessionId, parentSessionId), CLI_ONLY))
      .orderBy(asc(ORDER_AT), asc(ccSessions.sessionId));
  }

  /** Sessions with exactly this name, oldest first, optionally within a time range / on one host. */
  async listByName(name: string, opts: ListByNameOptions = {}): Promise<SessionListItem[]> {
    const conditions: SQL[] = [eq(ccSessions.name, name), CLI_ONLY];
    if (opts.from) conditions.push(sql`${ORDER_AT} >= ${opts.from.toISOString()}::timestamptz`);
    if (opts.to) conditions.push(sql`${ORDER_AT} <= ${opts.to.toISOString()}::timestamptz`);
    if (opts.host !== undefined) conditions.push(eq(ccSessions.host, opts.host));
    return this.db
      .select(LIST_COLUMNS)
      .from(ccSessions)
      .where(and(...conditions))
      .orderBy(asc(ORDER_AT), asc(ccSessions.sessionId));
  }

  /** One entry per repo with at least one terminal session, most recently active first. */
  async listProjects(): Promise<ProjectSummary[]> {
    const lastActive = sql<Date>`max(coalesce(${ccSessions.lastActiveAt}, ${ccSessions.startedAt}, ${ccSessions.createdAt}))`.mapWith(
      ccSessions.createdAt,
    );
    const sessionCount = sql<number>`count(*)`.mapWith(Number);
    const hosts = sql<string[]>`array_agg(distinct ${ccSessions.host} order by ${ccSessions.host})`;
    const rows = await this.db
      .select({ repo: ccSessions.repo, sessionCount, lastActiveAt: lastActive, hosts })
      .from(ccSessions)
      .where(and(isNotNull(ccSessions.repo), CLI_ONLY))
      .groupBy(ccSessions.repo)
      .orderBy(desc(lastActive), asc(ccSessions.repo));
    return rows.flatMap((r) =>
      r.repo === null ? [] : [{ repo: r.repo, sessionCount: r.sessionCount, lastActiveAt: r.lastActiveAt, hosts: r.hosts }],
    );
  }

  /** A repo's sessions, newest first (coalesce(started_at, created_at) desc, session_id). */
  async listForRepo(repo: string, opts: ListForRepoOptions = {}): Promise<SessionListItem[]> {
    const conditions: SQL[] = [eq(ccSessions.repo, repo), CLI_ONLY];
    if (opts.before) conditions.push(sql`${ORDER_AT} < ${opts.before.toISOString()}::timestamptz`);
    return this.db
      .select(LIST_COLUMNS)
      .from(ccSessions)
      .where(and(...conditions))
      .orderBy(desc(ORDER_AT), asc(ccSessions.sessionId))
      .limit(clampLimit(opts.limit));
  }

  // ---------- summaries and embeddings (Phase 6) ----------

  /** False when the session has no row. */
  async setSummary(sessionId: string, input: SummaryInput): Promise<boolean> {
    const at = input.at ?? this.now();
    const rows = await this.db
      .update(ccSessions)
      .set({ summary: input.summary, summarySha: input.sha, summarizedAt: at, updatedAt: this.now() })
      .where(eq(ccSessions.sessionId, sessionId))
      .returning({ id: ccSessions.sessionId });
    return rows.length > 0;
  }

  /** Stores a vector (clearing any failure). False when the session has no row. */
  async saveEmbedding(sessionId: string, input: SessionEmbeddingInput): Promise<boolean> {
    if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding has ${input.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
    }
    const literal = toVectorLiteral(input.embedding);
    const res = await this.db.execute<{ session_id: string }>(sql`
      insert into cc_session_embeddings
        (session_id, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, created_at, updated_at)
      select cc_sessions.session_id, ${literal}::vector, ${input.sha}, ${input.model}, 0, null, null, now(), now(), now()
      from cc_sessions
      where cc_sessions.session_id = ${sessionId}
      on conflict (session_id) do update set
        embedding = excluded.embedding,
        sha = excluded.sha,
        model = excluded.model,
        attempts = 0,
        last_error = null,
        next_attempt_at = null,
        embedded_at = excluded.embedded_at,
        updated_at = excluded.updated_at
      returning session_id
    `);
    return res.rows.length > 0;
  }

  /**
   * Records a failed attempt for `sha` + `model` with backoff (src/embeddings/state.ts
   * retryDelayMs). A row already holding a vector for the same sha + model is left alone.
   */
  async recordEmbeddingFailure(sessionId: string, input: SessionEmbeddingFailure): Promise<void> {
    const prev = await this.db
      .select({
        sha: ccSessionEmbeddings.sha,
        model: ccSessionEmbeddings.model,
        attempts: ccSessionEmbeddings.attempts,
        hasVector: sql<boolean>`${ccSessionEmbeddings.embedding} is not null`,
      })
      .from(ccSessionEmbeddings)
      .where(eq(ccSessionEmbeddings.sessionId, sessionId))
      .limit(1);
    const row = prev[0];
    const sameTarget = row !== undefined && row.sha === input.sha && row.model === input.model;
    if (sameTarget && row.hasVector) return;
    const attempts = sameTarget ? row.attempts + 1 : 1;
    const delayMs = retryDelayMs(attempts);
    await this.db.execute(sql`
      insert into cc_session_embeddings
        (session_id, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, created_at, updated_at)
      select cc_sessions.session_id, null, ${input.sha}, ${input.model}, ${attempts}::integer, ${clampError(input.error)},
             now() + ${delayMs}::integer * interval '1 millisecond', null, now(), now()
      from cc_sessions
      where cc_sessions.session_id = ${sessionId}
      on conflict (session_id) do update set
        embedding = null,
        sha = excluded.sha,
        model = excluded.model,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        next_attempt_at = excluded.next_attempt_at,
        embedded_at = null,
        updated_at = excluded.updated_at
    `);
  }

  // ---------- settings (Phase 7) ----------

  /** The stored JSON value, or null when the key is unset. */
  async getSetting(key: string): Promise<unknown | null> {
    const rows = await this.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
    const row = rows[0];
    return row === undefined ? null : row.value;
  }

  /** Stores any JSON value; null or undefined deletes the key. */
  async putSetting(key: string, value: unknown): Promise<void> {
    if (key.length === 0) throw new TypeError('setting key must be non-empty');
    if (value === null || value === undefined) {
      await this.db.delete(appSettings).where(eq(appSettings.key, key));
      return;
    }
    const now = this.now();
    await this.db
      .insert(appSettings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  }

  /** The repo selected in the wall's project sidebar, shared by both machines. */
  async getSelectedProject(): Promise<string | null> {
    const value = await this.getSetting(SELECTED_PROJECT_KEY);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  async setSelectedProject(repo: string | null): Promise<void> {
    await this.putSetting(SELECTED_PROJECT_KEY, repo === null || repo.length === 0 ? null : repo);
  }
}
```
**Impact:** none at runtime (no caller yet). Notes for the implementer:
- `sql<Date>\`max(...)\`.mapWith(ccSessions.createdAt)` decodes the timestamp the same way the
  column does (drizzle's node-postgres driver returns timestamptz as text).
- If TypeScript rejects the `.returning(SESSION_COLUMNS)` / `.select(LIST_COLUMNS)` result
  being assigned to `SessionRow` / `SessionListItem`, the column objects drifted from the type —
  fix the object, not the type.
- If drizzle's `.set({ ...set })` rejects a jsonb `$type` (`models`, `prompts`, ...), the
  `TranscriptSet` pick is wrong; types come straight from the table.

### Step 11: truncateAll
**File:** `tests/integration/setup.ts:50`
**Change:** replace the truncate statement so every file that truncates also empties the new tables.
**Code:**
```ts
  await db.execute(sql`truncate table cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```

### Step 12: Unit tests — node ids
**File:** `tests/unit/sessions/ids.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest'

import {
  findNodeIdCandidates,
  generateNodeId,
  InvalidNodeIdError,
  isValidNodeId,
  MAX_NODE_ID_CANDIDATES,
  NODE_ID_ALPHABET,
  NODE_ID_PATTERN,
  NODE_ID_SPACE,
  normalizeNodeId,
  parseNodeId,
} from '../../../src/sessions/ids.js'
import { ID_PATTERN } from '../../../src/notes/ids.js'

describe('generateNodeId', () => {
  it('produces the canonical XX-XX form', () => {
    for (let i = 0; i < 2000; i++) expect(generateNodeId()).toMatch(NODE_ID_PATTERN)
  })

  it('uses the injected random source', () => {
    const picks = [10, 0, 3, 16] // A 0 3 G
    let i = 0
    expect(generateNodeId(() => picks[i++]!)).toBe('A0-3G')
  })

  it('covers the whole alphabet', () => {
    expect(generateNodeId(() => 10)).toBe('AA-AA')
    expect(generateNodeId(() => NODE_ID_ALPHABET.length - 1)).toBe('ZZ-ZZ')
  })

  it('redraws all-digit ids', () => {
    const picks = [0, 1, 2, 3, 0, 1, 2, 35] // 01-23 (redrawn), then 01-2Z
    let i = 0
    expect(generateNodeId(() => picks[i++]!)).toBe('01-2Z')
    expect(() => generateNodeId(() => 0)).toThrow(RangeError)
  })

  it('never produces an all-digit id', () => {
    for (let i = 0; i < 2000; i++) expect(generateNodeId()).toMatch(/[A-Z]/)
  })

  it('throws on an out-of-range random source', () => {
    expect(() => generateNodeId(() => 36)).toThrow(RangeError)
  })

  it('reports the id space', () => {
    expect(NODE_ID_SPACE).toBe(1_679_616)
  })

  it('never has the note id shape', () => {
    for (let i = 0; i < 200; i++) expect(generateNodeId()).not.toMatch(ID_PATTERN)
  })
})

describe('normalizeNodeId / parseNodeId / isValidNodeId', () => {
  it('accepts any case, with or without the dash, trimmed', () => {
    expect(normalizeNodeId('a03g')).toBe('A0-3G')
    expect(normalizeNodeId('a0-3g')).toBe('A0-3G')
    expect(normalizeNodeId('  A0-3G ')).toBe('A0-3G')
  })

  it('rejects other shapes', () => {
    for (const bad of ['', 'A-B32', 'A0-3G1', 'A0--3G', 'A0_3G', 'Ä0-3G', 'A03']) {
      expect(normalizeNodeId(bad)).toBeNull()
    }
  })

  it('parseNodeId throws InvalidNodeIdError', () => {
    expect(parseNodeId('a03g')).toBe('A0-3G')
    expect(() => parseNodeId('nope')).toThrow(InvalidNodeIdError)
  })

  it('isValidNodeId accepts only the canonical form', () => {
    expect(isValidNodeId('A0-3G')).toBe(true)
    expect(isValidNodeId('a0-3g')).toBe(false)
    expect(isValidNodeId('A03G')).toBe(false)
  })
})

describe('findNodeIdCandidates', () => {
  it('finds upper-case ids in prose, deduped, in order', () => {
    expect(findNodeIdCandidates('compare A0-3G with B7-K2, then A0-3G again')).toEqual(['A0-3G', 'B7-K2'])
  })

  it('ignores lower case, all-digit pairs and ordinary hyphenated words', () => {
    expect(findNodeIdCandidates('see AB-CD')).toEqual(['AB-CD'])
    expect(findNodeIdCandidates('b7-k2, re-do the go-to step, pages 10-15')).toEqual([])
  })

  it('ignores paths, files, versions, times and ticket keys', () => {
    expect(findNodeIdCandidates('a/A0-3G A0-3G.md 1.12-RC1 10:30-11:00 UATP-2960')).toEqual([])
    expect(findNodeIdCandidates('done with A0-3G.')).toEqual(['A0-3G'])
  })

  it('ignores note ids, uuids, dates and longer hyphenated tokens', () => {
    const text = 'note A-B32, session d5c27d87-c38b-4fb8-83b5-1b1afaa5991f, on 2026-11-02, branch fix-ab-cd-ef'
    expect(findNodeIdCandidates(text)).toEqual([])
  })

  it('needs the dash in free text', () => {
    expect(findNodeIdCandidates('A03G')).toEqual([])
  })

  it('accepts punctuation and brackets around an id', () => {
    expect(findNodeIdCandidates('(A0-3G), "B1-C2". [C3-D4]')).toEqual(['A0-3G', 'B1-C2', 'C3-D4'])
  })

  it('returns at most MAX_NODE_ID_CANDIDATES (5)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `A${i % 10}-${String.fromCharCode(65 + i)}1`).join(' ')
    expect(MAX_NODE_ID_CANDIDATES).toBe(5)
    expect(findNodeIdCandidates(many)).toHaveLength(MAX_NODE_ID_CANDIDATES)
  })

  it('returns [] for text without a candidate', () => {
    expect(findNodeIdCandidates('what did I do yesterday?')).toEqual([])
  })
})
```

### Step 13: Unit tests — merge
**File:** `tests/unit/sessions/merge.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest'

import { clip, earliest, latest, mergeTranscriptPatch, normalizeCwd } from '../../../src/sessions/merge.js'
import { MAX_PROMPTS, type SessionRow, type TranscriptPatch } from '../../../src/sessions/types.js'

const T = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m))

function blankRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 's-1',
    nodeId: 'A0-3G',
    host: 'h',
    repo: null,
    cwd: null,
    branch: null,
    name: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    lastPrompt: null,
    entrypoint: null,
    version: null,
    startedAt: null,
    lastActiveAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    models: {},
    parentSessionId: null,
    parentLinkSource: null,
    tmux: null,
    transcriptPath: null,
    transcriptOffset: 0,
    transcriptSize: null,
    prompts: [],
    commits: [],
    filesEdited: [],
    planDocs: [],
    finalMessage: null,
    summary: null,
    summarySha: null,
    summarizedAt: null,
    createdAt: T(0),
    updatedAt: T(0),
    ...over,
  }
}

function patch(over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return { sessionId: 's-1', host: 'h', transcriptPath: '/t.jsonl', fromOffset: 0, toOffset: 10, size: 10, ...over }
}

describe('mergeTranscriptPatch', () => {
  it('adds deltas when appending', () => {
    const row = blankRow({ transcriptOffset: 10, inputTokens: 5, models: { m: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } })
    const set = mergeTranscriptPatch(row, patch({ fromOffset: 10, toOffset: 20, tokens: { inputTokens: 3 }, models: { m: { inputTokens: 3 }, n: { outputTokens: 2 } } }))
    expect(set.inputTokens).toBe(8)
    expect(set.models).toEqual({
      m: { inputTokens: 8, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      n: { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    expect(set.transcriptOffset).toBe(20)
  })

  it('replaces accumulators on a patch from offset 0', () => {
    const row = blankRow({ transcriptOffset: 50, inputTokens: 99, prompts: [{ text: 'old', at: null }], filesEdited: ['a'] })
    const set = mergeTranscriptPatch(row, patch({ tokens: { inputTokens: 4 }, prompts: [{ text: 'new', at: null }] }))
    expect(set.inputTokens).toBe(4)
    expect(set.prompts).toEqual([{ text: 'new', at: null }])
    expect(set.filesEdited).toEqual([])
  })

  it('never clobbers a scalar with null or undefined', () => {
    const row = blankRow({ name: 'impl-x-p1', cwd: '/w', repo: 'r' })
    const set = mergeTranscriptPatch(row, patch({ name: null, cwd: undefined }))
    expect(set).toMatchObject({ name: 'impl-x-p1', cwd: '/w', repo: 'r' })
  })

  it('keeps the earliest first prompt when appending, and the min/max times', () => {
    const row = blankRow({ transcriptOffset: 10, firstPrompt: 'first', startedAt: T(5), lastActiveAt: T(6) })
    const set = mergeTranscriptPatch(row, patch({ fromOffset: 10, firstPrompt: 'later', startedAt: T(1), lastActiveAt: T(9) }))
    expect(set.firstPrompt).toBe('first')
    expect(set.startedAt).toEqual(T(1))
    expect(set.lastActiveAt).toEqual(T(9))
  })

  it('treats costUsd as an absolute total', () => {
    const row = blankRow({ transcriptOffset: 10, costUsd: 1.5 })
    expect(mergeTranscriptPatch(row, patch({ fromOffset: 10, costUsd: 2.25 })).costUsd).toBe(2.25)
    expect(mergeTranscriptPatch(row, patch({ fromOffset: 10 })).costUsd).toBe(1.5)
  })

  it('caps prompts to the newest MAX_PROMPTS and drops blank ones', () => {
    const prompts = Array.from({ length: MAX_PROMPTS + 5 }, (_, i) => ({ text: `p${i}`, at: null }))
    const set = mergeTranscriptPatch(blankRow(), patch({ prompts: [...prompts, { text: '  ', at: null }] }))
    expect(set.prompts).toHaveLength(MAX_PROMPTS)
    expect(set.prompts[0]?.text).toBe('p5')
  })

  it('dedupes commits by sha and unions files', () => {
    const row = blankRow({ transcriptOffset: 10, commits: [{ sha: 'a', subject: 's', at: null }], filesEdited: ['x'] })
    const set = mergeTranscriptPatch(
      row,
      patch({ fromOffset: 10, commits: [{ sha: 'a', subject: 's2', at: null }, { sha: 'b', subject: 't', at: null }], filesEdited: ['x', 'y'] }),
    )
    expect(set.commits.map((c) => c.sha)).toEqual(['a', 'b'])
    expect(set.filesEdited).toEqual(['x', 'y'])
  })

  it('ignores negative or non-finite token deltas', () => {
    const set = mergeTranscriptPatch(blankRow(), patch({ tokens: { inputTokens: -3, outputTokens: Number.NaN } }))
    expect(set.inputTokens).toBe(0)
    expect(set.outputTokens).toBe(0)
  })
})

describe('helpers', () => {
  it('clip', () => {
    expect(clip('abc', 5)).toBe('abc')
    expect(clip('abcdef', 4)).toBe('abc…')
  })

  it('earliest / latest ignore missing values', () => {
    expect(earliest(null, T(1))).toEqual(T(1))
    expect(earliest(T(1), null)).toEqual(T(1))
    expect(latest(T(1), T(2))).toEqual(T(2))
  })

  it('normalizeCwd strips trailing slashes', () => {
    expect(normalizeCwd('/a/b/')).toBe('/a/b')
    expect(normalizeCwd('/a/b//')).toBe('/a/b')
    expect(normalizeCwd('/')).toBe('/')
    expect(normalizeCwd('///')).toBe('/')
  })
})
```

### Step 14: Unit test — schema widths
**File:** `tests/unit/sessions/schema.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest'

import { ccSessionEmbeddings, PARENT_LINK_SOURCES } from '../../../src/db/schema.js'
import { EMBEDDING_DIMENSIONS } from '../../../src/embeddings/constants.js'
import { PARENT_LINK_RANK } from '../../../src/sessions/types.js'

describe('session schema', () => {
  it('session vectors have the note embedding width', () => {
    expect(ccSessionEmbeddings.embedding.getSQLType()).toBe(`vector(${EMBEDDING_DIMENSIONS})`)
  })

  it('ranks every parent link source, env highest', () => {
    expect(Object.keys(PARENT_LINK_RANK).sort()).toEqual([...PARENT_LINK_SOURCES].sort())
    expect(PARENT_LINK_RANK.env).toBeGreaterThan(PARENT_LINK_RANK.hook)
    expect(PARENT_LINK_RANK.hook).toBeGreaterThan(PARENT_LINK_RANK.heuristic)
  })
})
```

### Step 15: Integration test — migration shape
**File:** `tests/integration/sessions.schema.int.test.ts` (new)
**Code:**
```ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { MIGRATIONS_DIR, closeTestDb, openTestDb, truncateAll } from './setup.js'

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string') return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return pgErrorCode(err)
  }
}

describe('migration 0007 (cc_sessions)', () => {
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

  it('is journal entry 7', () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    expect(journal.entries.find((e) => e.idx === 7)?.tag).toBe('0007_cc_sessions')
  })

  it('creates the tables and indexes', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' order by indexname`,
    )
    expect(res.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'cc_sessions_pkey',
        'cc_sessions_node_id_uniq',
        'cc_sessions_repo_started_idx',
        'cc_sessions_parent_idx',
        'cc_sessions_host_idx',
        'cc_sessions_name_idx',
        'cc_sessions_last_active_idx',
        'cc_sessions_search_gin',
        'cc_session_embeddings_pkey',
        'cc_session_embeddings_embedding_hnsw_idx',
        'cc_session_embeddings_next_attempt_idx',
        'cc_pending_spawns_pkey',
        'cc_pending_spawns_open_idx',
        'cc_pending_spawns_created_idx',
        'app_settings_pkey',
        'chat_threads_project_updated_idx',
      ]),
    )
  })

  it('adds a nullable chat_threads.project', async () => {
    const res = await db.execute<{ is_nullable: string; data_type: string }>(sql`
      select is_nullable, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'chat_threads' and column_name = 'project'
    `)
    expect(res.rows).toEqual([{ is_nullable: 'YES', data_type: 'text' }])
  })

  it('applies defaults and fills the generated search column', async () => {
    await db.execute(sql`insert into cc_sessions (session_id, node_id, host, name, summary, prompts)
      values ('s-1', 'A0-3G', 'h', 'orch-wall-editing', 'fixed the photo delete', '[{"text":"why does resume break","at":null}]'::jsonb)`)
    const row = await db.execute<{ input_tokens: string; models: unknown; files_edited: unknown; transcript_offset: string }>(
      sql`select input_tokens, models, files_edited, transcript_offset from cc_sessions where session_id = 's-1'`,
    )
    expect(row.rows[0]).toEqual({ input_tokens: '0', models: {}, files_edited: [], transcript_offset: '0' })
    for (const q of ['photo delete', 'resume', 'orch', 'wall']) {
      const hit = await db.execute<{ n: number }>(
        sql`select count(*)::int as n from cc_sessions where search_tsv @@ plainto_tsquery('simple', ${q})`,
      )
      expect(hit.rows[0]?.n, q).toBe(1)
    }
  })

  it('rejects malformed node ids, unknown link sources and half links', async () => {
    expect(await codeOf(db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-1', 'a0-3g', 'h')`))).toBe('23514')
    expect(
      await codeOf(
        db.execute(sql`insert into cc_sessions (session_id, node_id, host, parent_session_id, parent_link_source) values ('s-2', 'A0-3H', 'h', 'p', 'guess')`),
      ),
    ).toBe('23514')
    expect(
      await codeOf(db.execute(sql`insert into cc_sessions (session_id, node_id, host, parent_session_id) values ('s-3', 'A0-3J', 'h', 'p')`)),
    ).toBe('23514')
  })

  it('keeps node ids unique', async () => {
    await db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-1', 'A0-3G', 'h')`)
    expect(await codeOf(db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-2', 'A0-3G', 'h')`))).toBe('23505')
  })

  it('cascades embeddings when a session row is removed', async () => {
    await db.execute(sql`insert into cc_sessions (session_id, node_id, host) values ('s-1', 'A0-3G', 'h')`)
    await db.execute(sql`insert into cc_session_embeddings (session_id, sha, model) values ('s-1', 'x', 'm')`)
    await db.execute(sql`delete from cc_sessions where session_id = 's-1'`)
    const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_embeddings`)
    expect(n.rows[0]?.n).toBe(0)
  })
})
```
Note: raw `db.execute` returns bigint as text (`'0'`), which is why the default check compares strings.

### Step 16: Integration test — SessionsRepo
**File:** `tests/integration/sessions.repo.int.test.ts` (new)
**Code:**
```ts
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { EMBEDDING_DIMENSIONS } from '../../src/embeddings/constants.js'
import { NODE_ID_PATTERN } from '../../src/sessions/ids.js'
import { SessionsRepo } from '../../src/sessions/repo.js'
import { SELECTED_PROJECT_KEY, type TranscriptPatch } from '../../src/sessions/types.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const T0 = new Date('2026-11-01T10:00:00.000Z')

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000)
}

function cycle(values: number[]): (max: number) => number {
  let i = 0
  return () => values[i++ % values.length]!
}

function patch(sessionId: string, over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return {
    sessionId,
    host: HOST,
    transcriptPath: `/home/u/.claude/projects/p/${sessionId}.jsonl`,
    fromOffset: 0,
    toOffset: 100,
    size: 100,
    ...over,
  }
}

describe('SessionsRepo', () => {
  let db: Db
  let repo: SessionsRepo

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
    repo = new SessionsRepo(db)
  })

  describe('node ids', () => {
    it('assigns a node id once and keeps it', async () => {
      const a = await repo.ensureSession('s-1', HOST)
      expect(a.nodeId).toMatch(NODE_ID_PATTERN)
      const b = await repo.ensureSession('s-1', 'other-host')
      expect(b.nodeId).toBe(a.nodeId)
      expect(b.host).toBe(HOST)
    })

    it('redraws on a node id clash', async () => {
      const first = new SessionsRepo(db, { random: () => 10 })
      expect((await first.ensureSession('s-1', HOST)).nodeId).toBe('AA-AA')
      const second = new SessionsRepo(db, { random: cycle([10, 10, 10, 10, 11, 11, 11, 11]) })
      expect((await second.ensureSession('s-2', HOST)).nodeId).toBe('BB-BB')
    })

    it('gives up when every draw clashes', async () => {
      const stuck = new SessionsRepo(db, { random: () => 10 })
      await stuck.ensureSession('s-1', HOST)
      await expect(stuck.ensureSession('s-2', HOST)).rejects.toThrow(/free node id/)
    })

    it('rejects a blank session id', async () => {
      await expect(repo.ensureSession('', HOST)).rejects.toThrow(TypeError)
    })

    it('finds rows by node id in any case, with or without the dash', async () => {
      const fixed = new SessionsRepo(db, { random: cycle([10, 0, 3, 16]) })
      await fixed.ensureSession('s-1', HOST)
      expect((await repo.getByNodeId('a03g'))?.sessionId).toBe('s-1')
      expect((await repo.getByNodeId('A0-3G'))?.sessionId).toBe('s-1')
      expect(await repo.getByNodeId('ZZ-ZZ')).toBeNull()
      expect(await repo.getByNodeId('not an id')).toBeNull()
      const many = await repo.getManyByNodeIds(['a0-3g', 'ZZ-ZZ', 'A03G', 'junk'])
      expect(many.map((r) => r.sessionId)).toEqual(['s-1'])
    })
  })

  describe('transcript upserts', () => {
    it('creates the row, applies an append once, and ignores a replay', async () => {
      const first = await repo.upsertFromTranscript(
        patch('s-1', {
          cwd: '/home/u/mcp-notes',
          repo: 'mcp-notes',
          branch: 'main',
          entrypoint: 'cli',
          version: '2.1.0',
          startedAt: at(0),
          lastActiveAt: at(1),
          firstPrompt: 'hello',
          lastPrompt: 'hello',
          tokens: { inputTokens: 10, outputTokens: 5 },
          models: { 'claude-opus': { inputTokens: 10, outputTokens: 5 } },
          prompts: [{ text: 'hello', at: at(0).toISOString() }],
          filesEdited: ['src/a.ts'],
        }),
      )
      expect(first.applied).toBe(true)
      expect(first.row.nodeId).toMatch(NODE_ID_PATTERN)
      expect(first.row.transcriptOffset).toBe(100)

      const append = patch('s-1', {
        fromOffset: 100,
        toOffset: 250,
        size: 250,
        lastActiveAt: at(5),
        firstPrompt: 'second',
        lastPrompt: 'second',
        tokens: { inputTokens: 3 },
        models: { 'claude-opus': { inputTokens: 3 } },
        prompts: [{ text: 'second', at: null }],
        filesEdited: ['src/a.ts', 'src/b.ts'],
        commits: [{ sha: 'abc1234', subject: 'feat: x', at: null }],
        costUsd: 0.42,
      })
      const second = await repo.upsertFromTranscript(append)
      expect(second.applied).toBe(true)
      expect(second.row).toMatchObject({
        transcriptOffset: 250,
        transcriptSize: 250,
        inputTokens: 13,
        outputTokens: 5,
        firstPrompt: 'hello',
        lastPrompt: 'second',
        filesEdited: ['src/a.ts', 'src/b.ts'],
        commits: [{ sha: 'abc1234', subject: 'feat: x', at: null }],
        startedAt: at(0),
        lastActiveAt: at(5),
        costUsd: 0.42,
      })
      expect(second.row.prompts.map((p) => p.text)).toEqual(['hello', 'second'])
      expect(second.row.models['claude-opus']?.inputTokens).toBe(13)

      const replay = await repo.upsertFromTranscript(append)
      expect(replay).toMatchObject({ applied: false, reason: 'offset_mismatch', storedOffset: 250 })
      expect((await repo.getBySessionId('s-1'))?.inputTokens).toBe(13)
    })

    it('a patch from offset 0 replaces the accumulators', async () => {
      await repo.upsertFromTranscript(patch('s-1', { tokens: { inputTokens: 50 }, prompts: [{ text: 'a', at: null }] }))
      const again = await repo.upsertFromTranscript(patch('s-1', { tokens: { inputTokens: 50 }, prompts: [{ text: 'a', at: null }] }))
      expect(again.applied).toBe(true)
      expect(again.row.inputTokens).toBe(50)
      expect(again.row.prompts).toHaveLength(1)
    })

    it('keeps the hook-reported name and tmux when the transcript has none', async () => {
      await repo.upsertFromHook({ sessionId: 's-1', host: HOST, name: 'impl-x-p1', tmux: 'note:@0.%7', cwd: '/w' })
      const r = await repo.upsertFromTranscript(patch('s-1', { name: null, cwd: '/w', entrypoint: 'cli' }))
      expect(r.row).toMatchObject({ name: 'impl-x-p1', tmux: 'note:@0.%7', cwd: '/w' })
    })

    it('refuses a patch for a row held by another host', async () => {
      await repo.ensureSession('s-1', 'host-b')
      const r = await repo.upsertFromTranscript(patch('s-1'))
      expect(r).toMatchObject({ applied: false, reason: 'other_host' })
    })

    it('rejects inconsistent offsets', async () => {
      await expect(repo.upsertFromTranscript(patch('s-1', { fromOffset: 50, toOffset: 10 }))).rejects.toThrow(RangeError)
      await expect(repo.upsertFromTranscript(patch('s-1', { fromOffset: -1 }))).rejects.toThrow(RangeError)
    })

    it('lists offsets for one host only', async () => {
      await repo.upsertFromTranscript(patch('s-1', { toOffset: 40, size: 40 }))
      await repo.upsertFromTranscript(patch('s-2', { host: 'host-b' }))
      const offsets = await repo.offsets(HOST)
      expect([...offsets.keys()]).toEqual(['s-1'])
      expect(offsets.get('s-1')).toEqual({ offset: 40, size: 40, path: '/home/u/.claude/projects/p/s-1.jsonl' })
    })
  })

  describe('parent links', () => {
    it('honours env > hook > heuristic', async () => {
      for (const id of ['c', 'p1', 'p2', 'p3']) await repo.ensureSession(id, HOST)
      expect(await repo.setParent('c', 'p1', 'heuristic')).toBe('set')
      expect(await repo.setParent('c', 'p2', 'hook')).toBe('set')
      expect(await repo.setParent('c', 'p3', 'heuristic')).toBe('kept')
      expect(await repo.setParent('c', 'p3', 'env')).toBe('set')
      expect(await repo.setParent('c', 'p1', 'hook')).toBe('kept')
      expect(await repo.getBySessionId('c')).toMatchObject({ parentSessionId: 'p3', parentLinkSource: 'env' })
    })

    it('lets an equal-rank heuristic link be refined', async () => {
      for (const id of ['c', 'p1', 'p2']) await repo.ensureSession(id, HOST)
      await repo.setParent('c', 'p1', 'heuristic')
      expect(await repo.setParent('c', 'p2', 'heuristic')).toBe('set')
    })

    it('refuses self links, cycles and missing children', async () => {
      await repo.ensureSession('a', HOST)
      await repo.ensureSession('b', HOST)
      expect(await repo.setParent('b', 'a', 'env')).toBe('set')
      expect(await repo.setParent('a', 'b', 'env')).toBe('cycle')
      expect(await repo.setParent('a', 'a', 'env')).toBe('self')
      expect(await repo.setParent('nope', 'a', 'env')).toBe('missing')
    })

    it('upsertFromHook links an env parent and returns both rows', async () => {
      const res = await repo.upsertFromHook({
        sessionId: 'child',
        host: HOST,
        cwd: '/w',
        name: 'impl-x-p2',
        tmux: 'note:@1.%2',
        startedAt: at(0),
        parentSessionId: 'parent',
      })
      expect(res.parentLink).toBe('set')
      expect(res.parent?.nodeId).toMatch(NODE_ID_PATTERN)
      expect(res.session).toMatchObject({ parentSessionId: 'parent', parentLinkSource: 'env', name: 'impl-x-p2', startedAt: at(0) })
      expect((await repo.listChildren('parent')).map((c) => c.sessionId)).toEqual(['child'])
    })

    it('upsertFromHook without a parent leaves the link alone', async () => {
      const res = await repo.upsertFromHook({ sessionId: 's-1', host: HOST })
      expect(res).toMatchObject({ parent: null, parentLink: null })
      expect(res.session.parentSessionId).toBeNull()
    })
  })

  describe('pending spawns', () => {
    it('a child claims a matching spawn once, within the window', async () => {
      await repo.ensureSession('parent', HOST)
      await repo.recordPendingSpawn({ parentSessionId: 'parent', host: HOST, cwd: '/w/repo/', name: 'helper', createdAt: at(0) })
      expect(await repo.claimPendingSpawn({ childSessionId: 'other', host: HOST, cwd: '/elsewhere', at: at(0.1) })).toBeNull()
      expect(await repo.claimPendingSpawn({ childSessionId: 'other', host: 'host-b', cwd: '/w/repo', at: at(0.1) })).toBeNull()
      const claim = await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w/repo', name: 'helper', at: at(0.2) })
      expect(claim?.spawn.claimedBy).toBe('child')
      expect(claim?.parentLink).toBe('set')
      expect(await repo.getBySessionId('child')).toMatchObject({ parentSessionId: 'parent', parentLinkSource: 'hook' })
      expect(await repo.claimPendingSpawn({ childSessionId: 'child2', host: HOST, cwd: '/w/repo', at: at(0.3) })).toBeNull()
    })

    it('ignores a spawn older than the window', async () => {
      await repo.recordPendingSpawn({ parentSessionId: 'parent', host: HOST, cwd: '/w', createdAt: at(0) })
      expect(await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w', at: at(1) })).toBeNull()
    })

    it('prefers the spawn whose name matches', async () => {
      await repo.recordPendingSpawn({ parentSessionId: 'p-named', host: HOST, cwd: '/w', name: 'helper', createdAt: at(0) })
      await repo.recordPendingSpawn({ parentSessionId: 'p-anon', host: HOST, cwd: '/w', createdAt: at(0.05) })
      const claim = await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w', name: 'helper', at: at(0.1) })
      expect(claim?.spawn.parentSessionId).toBe('p-named')
    })

    it('a hook claim does not replace an env link', async () => {
      await repo.upsertFromHook({ sessionId: 'child', host: HOST, parentSessionId: 'env-parent' })
      await repo.recordPendingSpawn({ parentSessionId: 'other', host: HOST, cwd: '/w', createdAt: at(0) })
      const claim = await repo.claimPendingSpawn({ childSessionId: 'child', host: HOST, cwd: '/w', at: at(0.1) })
      expect(claim?.parentLink).toBe('kept')
      expect((await repo.getBySessionId('child'))?.parentSessionId).toBe('env-parent')
    })

    it('prunes old spawns', async () => {
      await repo.recordPendingSpawn({ parentSessionId: 'p', host: HOST, cwd: '/w', createdAt: at(0) })
      await repo.recordPendingSpawn({ parentSessionId: 'p', host: HOST, cwd: '/w', createdAt: at(60) })
      expect(await repo.prunePendingSpawns(at(30))).toBe(1)
    })
  })

  describe('listings', () => {
    it('lists projects and sessions newest first, terminal sessions only', async () => {
      await repo.upsertFromTranscript(patch('s1', { repo: 'mcp-notes', entrypoint: 'cli', startedAt: at(0) }))
      await repo.upsertFromTranscript(patch('s2', { host: 'host-b', repo: 'mcp-notes', entrypoint: 'cli', startedAt: at(10) }))
      await repo.upsertFromTranscript(patch('s3', { repo: 'seer', entrypoint: 'cli', startedAt: at(5) }))
      await repo.upsertFromTranscript(patch('s4', { repo: 'mcp-notes', entrypoint: 'sdk-ts', startedAt: at(20) }))

      const projects = await repo.listProjects()
      expect(projects).toEqual([
        { repo: 'mcp-notes', sessionCount: 2, lastActiveAt: at(10), hosts: ['host-a', 'host-b'] },
        { repo: 'seer', sessionCount: 1, lastActiveAt: at(5), hosts: ['host-a'] },
      ])
      expect((await repo.listForRepo('mcp-notes')).map((s) => s.sessionId)).toEqual(['s2', 's1'])
      expect((await repo.listForRepo('mcp-notes', { limit: 1 })).map((s) => s.sessionId)).toEqual(['s2'])
      expect((await repo.listForRepo('mcp-notes', { before: at(10) })).map((s) => s.sessionId)).toEqual(['s1'])
    })

    it('finds sessions by name within a time range', async () => {
      await repo.upsertFromTranscript(patch('old', { name: 'impl-x-p1', entrypoint: 'cli', startedAt: at(0) }))
      await repo.upsertFromTranscript(patch('new', { name: 'impl-x-p1', entrypoint: 'cli', startedAt: at(120) }))
      expect((await repo.listByName('impl-x-p1')).map((s) => s.sessionId)).toEqual(['old', 'new'])
      expect((await repo.listByName('impl-x-p1', { from: at(60), to: at(180) })).map((s) => s.sessionId)).toEqual(['new'])
    })
  })

  describe('summaries and embeddings', () => {
    it('setSummary stores the summary and feeds full text', async () => {
      await repo.ensureSession('s-1', HOST)
      expect(await repo.setSummary('s-1', { summary: 'Fixed the wall photo delete bug', sha: 'abc', at: at(3) })).toBe(true)
      expect(await repo.setSummary('missing', { summary: 'x', sha: 'y' })).toBe(false)
      expect(await repo.getBySessionId('s-1')).toMatchObject({ summary: 'Fixed the wall photo delete bug', summarySha: 'abc', summarizedAt: at(3) })
      const hit = await db.execute<{ session_id: string }>(
        sql`select session_id from cc_sessions where search_tsv @@ plainto_tsquery('simple', 'photo delete')`,
      )
      expect(hit.rows.map((r) => r.session_id)).toEqual(['s-1'])
    })

    it('saves vectors and records failures with backoff', async () => {
      await repo.ensureSession('s-1', HOST)
      const v = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0))
      expect(await repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: v })).toBe(true)
      expect(await repo.saveEmbedding('missing', { sha: 'h1', model: 'm', embedding: v })).toBe(false)
      await expect(repo.saveEmbedding('s-1', { sha: 'h1', model: 'm', embedding: [1, 2] })).rejects.toThrow(/dimensions/)

      await repo.recordEmbeddingFailure('s-1', { sha: 'h1', model: 'm', error: 'boom' })
      let row = await db.execute<{ sha: string; attempts: number; has_vector: boolean }>(
        sql`select sha, attempts, embedding is not null as has_vector from cc_session_embeddings where session_id = 's-1'`,
      )
      expect(row.rows[0]).toEqual({ sha: 'h1', attempts: 0, has_vector: true })

      await repo.recordEmbeddingFailure('s-1', { sha: 'h2', model: 'm', error: 'boom' })
      await repo.recordEmbeddingFailure('s-1', { sha: 'h2', model: 'm', error: 'boom again' })
      row = await db.execute<{ sha: string; attempts: number; has_vector: boolean }>(
        sql`select sha, attempts, embedding is not null as has_vector from cc_session_embeddings where session_id = 's-1'`,
      )
      expect(row.rows[0]).toEqual({ sha: 'h2', attempts: 2, has_vector: false })
    })
  })

  describe('settings', () => {
    it('stores, reads and clears values', async () => {
      expect(await repo.getSelectedProject()).toBeNull()
      await repo.setSelectedProject('mcp-notes')
      expect(await repo.getSelectedProject()).toBe('mcp-notes')
      expect(await repo.getSetting(SELECTED_PROJECT_KEY)).toBe('mcp-notes')
      await repo.putSetting('x', { a: 1 })
      expect(await repo.getSetting('x')).toEqual({ a: 1 })
      await repo.setSelectedProject(null)
      expect(await repo.getSelectedProject()).toBeNull()
      await repo.putSetting('x', null)
      expect(await repo.getSetting('x')).toBeNull()
    })
  })
})
```

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (new unit files under `tests/unit/sessions/`), then `npm run test:int` (applies 0007 to the Docker DB via globalSetup; runs `sessions.schema.int.test.ts`, `sessions.repo.int.test.ts` and every existing integration file, which now also truncate the new tables).
Single files: `npx vitest run tests/unit/sessions/ids.test.ts`, `npm run test:int -- tests/integration/sessions.repo.int.test.ts`.
**Manual check:** `git diff --stat drizzle/` shows exactly `0007_cc_sessions.sql`, `meta/0007_snapshot.json`, `meta/_journal.json`; the SQL matches Step 6 in substance. Do NOT run `npm run db:migrate` against Neon from this phase; the landing of the set does that.
**Exit criteria:** migration 0007 applies on the test DB; `SessionsRepo` upserts are idempotent (replay = `offset_mismatch`, no double counting), assign node ids with redraw on clash, honour `env > hook > heuristic`, refuse self/cycle links, and claim a pending spawn at most once within the window; typecheck, unit and integration suites green.

## Handoffs

- **Phase 3 (R1):** build `TranscriptPatch`es. First read of a file uses `fromOffset: 0` (whole
  file, accumulators replaced); later passes use the stored offset from `repo.offsets(host)`.
  On `offset_mismatch`, resume from `storedOffset`; on `other_host`, skip. `tokens`/`models` are
  deltas over the bytes read; `costUsd` is the latest absolute `cost-state.totalCostUSD`. Skip
  `sdk-ts`/`sdk-cli` sessions before calling the repo (listings also filter them, but rows
  would still be created). Phase 3 owns how `repo` is resolved and passed in.
- **Phase 4 (R3):** candidates via `repo.listByName(name, {from, to, host})`; link with
  `repo.setParent(child, parent, 'heuristic')` — it never replaces `env`/`hook`, refuses cycles.
- **Phase 5 (R2):** `repo.upsertFromHook(...)` (returns both node ids for additionalContext),
  `repo.recordPendingSpawn(...)`, `repo.claimPendingSpawn(...)`, `repo.prunePendingSpawns(...)`
  (reconciled: Phase 5's `POST /api/sessions/hook/spawn` prunes spawns older than 24 h after each
  record; nothing calls it in Phase 1). Phase 5 imports `PENDING_SPAWN_WINDOW_MS` from `types.ts`. Every consumer
  constructs `new SessionsRepo(deps.db)` where it needs one (stateless, no I/O; reconciled round 2):
  no phase adds a repo to `AppDeps` (`src/deps.ts`), and Phase 1 does not touch `AppDeps`.
- **Phase 6 (R4):** `repo.setSummary(sessionId, {summary, sha})`, `repo.saveEmbedding(sessionId, {sha, model, embedding})`
  (refreshes `embedded_at` on every save; Phase 6 judges staleness on `embedded_at`), `repo.recordEmbeddingFailure`.
  Read queries for pending work (sessions idle with no/stale summary; summaries with no/stale
  vector) are Phase 6's; add them as new read methods in `src/sessions/repo.ts` (append-only,
  no signature changes to the above) or in its own module. Text search uses `cc_sessions.search_tsv`
  (`simple`); vectors are `cc_session_embeddings.embedding` (hnsw cosine).
- **Phase 7 (R6/R7):** `getByNodeId`, `getManyByNodeIds`, `listProjects`, `listForRepo`,
  `listChildren`, `getSelectedProject`/`setSelectedProject`.
- **Phase 8 (R5):** `claude/hooks/notes-prompt.mjs` cannot import TS; its `NODE_ID_CANDIDATE`
  literal is `NODE_ID_CANDIDATE_SOURCE` verbatim (upper case, dash, whole token) plus the
  at-least-one-letter filter and max 5, and its unit test asserts
  `NODE_ID_CANDIDATE.source === NODE_ID_CANDIDATE_SOURCE` and that `nodeIdCandidates` agrees with
  `findNodeIdCandidates` on a corpus.
- **Phase 12 (R7):** `chat_threads.project` exists and `ChatThreadRow.project` is typed;
  `ChatService`/`chatApi`/`toThreadView` plumbing and the `chat_threads_project_updated_idx`
  query are Phase 12's.
- **Phase 14:** README/CLAUDE.md should mention migration 0007, the four tables and
  `SessionsRepo` as the single writer.

## Rollback

Revert the phase commit (removes schema additions, the three `src/sessions` files, the generated
migration artifacts and the tests). If 0007 was already applied to a database, run by hand:
```sql
drop table if exists cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings;
drop index if exists chat_threads_project_updated_idx;
alter table chat_threads drop column if exists project;
delete from drizzle.__drizzle_migrations where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
```
(the last line only if 0007 is the newest applied migration). The tables hold derived data only.

## Risks

- `drizzle-kit generate` with a `customType` generated column: if the snapshot/SQL renders the
  expression or type oddly, prefer fixing `schema.ts`. Last resort: hand-edit only the
  `search_tsv` line of `0007_cc_sessions.sql` to the expected text (the snapshot can keep drizzle's form).
- `jsonb_path_query_array(jsonb, jsonpath)` is IMMUTABLE (only the `_tz` variants are STABLE),
  so it is allowed in a generated column. If Postgres 16 rejects it, replace that term with
  `coalesce("prompts"::text, '')` in both schema and SQL (JSON keys `text`/`at` then also become tokens).
- `findNodeIdCandidates` still yields false candidates such as `UI-UX`, `TO-DO`; by design they
  resolve to nothing (only existing ids resolve), at the cost of one lookup in Phase 8.
