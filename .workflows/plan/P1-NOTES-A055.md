> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 7. Source: `.workflows/plan/project-session-graph/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: Sessions read API, selected project, MCP + chat tools, usage

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R6 — MCP + chat agent tools `sessions_search`, `session_get`, `session_transcript`, usage (tokens per node / month). The HTTP read API built here is the same read model R5 (phase 8) and R7 (phases 10-13) consume; this phase serves them, it does not implement them.
**Depends on:** Phase 5, Phase 6 (and transitively 1, 3, 4)
**Difficulty:** NORMAL
**Package:** `src/http`, `src/mcp`, `src/chat`, `src/sessions` (new read-only modules)

---

## Goal

Every session row ingested by phases 3-6 becomes readable: the wall gets a project list, a
persisted selected project, a per-repo graph payload (~1000 nodes, ETag-cheap to poll), node
detail, transcript search on the owning host, session search and usage; the prompt hook gets a
fast `/api/sessions/context`; Claude Code and the chat bar get four read-only MCP tools
(`sessions_search`, `session_get`, `session_transcript`, `sessions_usage`) plus a "Sessions."
paragraph in the MCP instructions. Nothing in this phase writes `cc_sessions`.

## Decisions taken in this phase

| Fork | Chosen | Why |
|---|---|---|
| SSE event on `/api/events` when sessions change vs. web polls | **Web polls** `GET /api/projects/:repo/sessions` (suggested 10 s while the projects page is visible), with a weak `ETag` and `If-None-Match` -> `304` | (1) Busy sessions append to their transcript every few seconds, so a per-upsert event would be a firehose; (2) the other laptop's daemon ingests into the same DB and its writes never reach this daemon's in-process bus anyway (the same reason the wall already polls notes every 60 s); (3) "live" comes from `~/.claude/sessions/*.json` on each request, which no DB event would carry; (4) an event bus would have to be threaded through `SessionsRepo`/ingest (phases 1/3), which this phase must not touch. `api.ts`'s SSE route is left alone. |
| Use `SessionsRepo` row reads (phase 1) vs. own read SQL | **Own read-only SQL** in `src/sessions/readModel.ts`, written against the column names fixed in the index's schema contract. `SessionsRepo` is used only for settings (`app_settings`) and nothing here writes `cc_*` tables | The read API needs projections the row API does not give: excerpts, `child_count`, the parent's node id via a self-join, aggregates for usage, and the notes-made join. Depending on the SQL column contract (exact in the index) instead of phase 1's TypeScript property names (not in the index) keeps the reconcile to one place. Invariant 3 (one *writer*) holds. |
| Where the shared read logic lives | `src/sessions/readModel.ts` (SQL), `src/sessions/view.ts` (pure shaping + context text), `src/sessions/transcriptSearch.ts` (file scan) | HTTP and MCP return the same shapes from one implementation; pure parts unit-tested without a DB. |
| Selected project storage | `app_settings` key `projects.selected`, value a bare JSON string `"<repo>"`, and `null` deletes the key: the format phase 1's `SessionsRepo.getSelectedProject/setSelectedProject` read and write (reconciled; phase 1 owns the table). The reader also tolerates a legacy `{repo}` object | Contract key from the index; one storage format for both accessors. |
| `available` / `live` | `available = row.host === os.hostname()`; `live` only for rows of this host present in the registry | Two daemons, one DB: this daemon can only see its own `~/.claude/sessions`. A node live on the other laptop shows `live: false, available: false`. |
| `total_tokens` | `input + output + cache_read + cache_write`; each part is also returned | "Tokens per node" is ambiguous; returning all four lets the caller pick. |
| Transcript search bounds | at most 100 matches (default 20), 600-char excerpts, 256 MB scanned; keeps the **last** N matches in file order | Bounded payload; recent matches are usually what "what did we decide" needs. |

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/sessions/view.ts`: types `ParentLinkSource`, `TokenCounts`, `GraphNode`, `GraphPayload`, `ProjectSummary`, `ProjectsPayload`, `SelectedProject`, `SessionPrompt`, `SessionCommit`, `NoteRef`, `NodeRef`, `SessionInfo`, `SessionDetail`, `ContextNode`, `ContextPayload`, `SearchHit`, `SearchPayload`, `UsageTotals`, `UsageMonthRow`, `UsageNodeRow`, `UsagePayload`, `TranscriptPayload`, `NodeRow`, `DetailRow`, `LiveEntry`, `NodeContext`, `ContextInput`; functions `iso`, `num`, `numOrNull`, `excerpt`, `clip`, `nonEmpty`, `sessionTitle`, `linkSource`, `tokenCounts`, `toGraphNode`, `toNodeRef`, `toSessionInfo`, `normalizePrompts`, `normalizeCommits`, `normalizePaths`, `nodeUrl`, `formatLocalTime`, `formatContext`, `CONTEXT_HEADER`; constants listed in Step 1.
- `src/sessions/transcriptSearch.ts`: `searchTranscript`, `messageText`, `queryTerms`, `excerptAround`, `TRANSCRIPT_DEFAULT_LIMIT` (20), `TRANSCRIPT_MAX_LIMIT` (100), `TRANSCRIPT_EXCERPT_CHARS` (600), `TRANSCRIPT_MAX_SCAN_BYTES` (256 MiB), types `TranscriptMatch`, `TranscriptSearchResult`, `TranscriptSearchOptions`.
- `src/sessions/readModel.ts`: `SessionsReadDeps`, `SessionsReadOverrides`, `LiveSource`, `SettingsStore`, `SessionSearchFn`, `SessionSearchOutcome`, `sessionsReadDeps(deps, overrides)`, `listProjects`, `readSelected`, `writeSelected`, `repoExists`, `graphForRepo`, `sessionDetail`, `contextFor`, `searchNodes`, `usage`, `readTranscript`, `SELECTED_PROJECT_KEY = 'projects.selected'`, `CONTEXT_MAX_IDS = 10`.
- `src/http/sessionsApi.ts`: `sessionsApiRoutes(deps, options)`, `loopbackReadGuard`, `graphEtag`, `parseIdList`, limits constants.
- `src/mcp/sessionTools.ts`: `registerSessionTools(server, deps)`, `SESSIONS_OFF`.
- `src/chat/status.ts`: `SESSION_TOOL_NAMES = ['sessions_search', 'session_get', 'session_transcript', 'sessions_usage']`, `SessionToolName`.
- HTTP routes: `GET /api/projects`, `GET /api/projects/selected`, `PUT /api/projects/selected` (same-origin), `GET /api/projects/:repo/sessions`, `GET /api/sessions/context` (loopback), `GET /api/sessions/search`, `GET /api/sessions/usage`, `GET /api/sessions/:nodeId/transcript`, `GET /api/sessions/:nodeId`.
- MCP tools: `sessions_search`, `session_get`, `session_transcript`, `sessions_usage` (all `readOnlyHint`).
- MCP instructions: one paragraph starting `Sessions.`, last in `sections`.

**Signature changes:**
- `mcpToolDeps(deps: AppDeps): ToolDeps` -> `mcpToolDeps(deps: AppDeps, sessions?: SessionsReadOverrides): ToolDeps` (`src/http/app.ts:46`), now always sets `sessions`.
- `CreateAppOptions` gains `sessions?: SessionsReadOverrides` (`src/http/app.ts:34`).
- `ToolDeps` gains `sessions?: SessionsReadDeps` (`src/mcp/tools.ts:12`).
- `allowedChatTools()` returns 19 notes + **4 session** + 15 connector + 2 web = 40 names.

**Requires (from earlier phases):**
- Phase 1: tables `cc_sessions` (columns exactly as in the index contract: `session_id, node_id, host, repo, cwd, branch, name, custom_title, ai_title, first_prompt, last_prompt, entrypoint, version, started_at, last_active_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, models, parent_session_id, parent_link_source, tmux, transcript_path, prompts, commits, files_edited, plan_docs, final_message, summary, summarized_at`) and `app_settings (key, value jsonb, updated_at)`.
- Phase 1: `normalizeNodeId(input: string): string | null` in `src/sessions/ids.ts` (case-insensitive, dash optional, canonical `A0-3G` out, null for anything that is not a node id).
- Phase 1: `new SessionsRepo(db, opts?)` (stateless; constructing it does no I/O) with `getSetting(key: string): Promise<unknown | null>` and `putSetting(key: string, value: unknown): Promise<void>` (upsert; `null` deletes the key). `SELECTED_PROJECT_KEY` is also exported from `src/sessions/types.ts`; this phase's `readModel.ts` re-exports that constant instead of redefining it. Only `repoSettings()` in `readModel.ts` constructs the repo.
- Phase 1 (pinned): `prompts` jsonb is `SessionPrompt[]` = `{ text: string; at: string | null }[]`; `commits` is `SessionCommit[]` = `{ sha: string; subject: string; at: string | null }[]`; `files_edited` / `plan_docs` are `string[]`; all `not null default '[]'`. The normalizers in `view.ts` still accept the looser shapes (harmless), but these are what phase 3 writes.
- Phase 3: `config.sessions.claudeHome: string` on `Config` (required field); `readLiveSessions(claudeHome: string, isAlive?): Promise<LiveSession[]>` in `src/sessions/registry.ts` (pid-liveness already applied; `LiveSession` carries `sessionId, pid, cwd, status, tmux, name, nameSource, entrypoint, version, startedAt, updatedAt, messagingSocketPath`). **Only `liveFromRegistry()` in `readModel.ts` touches it.**
- Phase 6 (as published): `searchSessions(deps: SessionSearchDeps /* {db, embedder, host?} */, query: string, filter?: { repo?, host?, from?, to?, limit?, cursor? }, opts?: { mode?, queryTimeoutMs?, now? }): Promise<{ sessions: SessionSearchHit[] /* session_id, node_id, ..., score */; next_cursor: string | null; mode: SearchMode; fallback?: string }>` in `src/sessions/search.ts`; throws `NoteError('invalid_input')` on a bad query. **Only `phase6Search()` in `readModel.ts` touches it.**
- Phase 5: `src/http/app.ts` already imports `sessionHookRoutes` from `./sessionHooks.js` and mounts `app.route('/', sessionHookRoutes(deps));` right after `captureRoutes`. If phase 5 used another name, keep its line verbatim and insert this phase's line after it.

**Leaves alone (owned by others):** `src/sessions/{ids,types,repo,registry,ingest,transcript,links,summarize,summaryWorker,search,redact}.ts` (1, 3, 4, 6); `src/http/sessionHooks.ts` (5); `POST /api/sessions/:nodeId/resume`, `src/sessions/resume.ts`, `src/http/sessionResume.ts`, `session_resume` (9); `claude/hooks/notes-prompt.mjs` (8); everything in `web/` (10-13); `src/http/api.ts` SSE route; `src/chat/prompt.ts` (12); the `unfinished` value (13); README/CHANGELOG/CLAUDE.md (14).

## Published JSON shapes (phases 8, 10, 11, 12, 13 plan against these)

All timestamps are ISO 8601 UTC strings (`2026-11-01T03:00:00.000Z`) or `null`. Node ids are canonical `A0-3G`.

```ts
// GET /api/projects  -> 200
interface ProjectsPayload {
  host: string;                       // os.hostname() of this daemon
  selected: string | null;            // same value as GET /api/projects/selected
  projects: Array<{
    repo: string;
    sessions: number;                 // all rows, both hosts
    live: number;                     // rows of THIS host present in ~/.claude/sessions
    last_active_at: string | null;    // max(coalesce(last_active_at, started_at))
    first_started_at: string | null;
    hosts: string[];                  // distinct hosts, sorted
  }>;                                 // most recently active first
}

// GET /api/projects/selected -> 200 { repo: string | null }
// PUT /api/projects/selected  body { repo: string | null }   (same-origin only)
//   200 { repo } | 400 { error } | 403 { error: 'forbidden_origin' } | 404 { error: 'unknown_repo', repo }

// GET /api/projects/:repo/sessions?limit=2000&before=<iso>
//   200 GraphPayload, headers ETag: W/"<sha1>", Cache-Control: no-cache
//   304 (empty) when If-None-Match equals the ETag
//   400 { error } bad limit/before | 404 { error: 'unknown_repo', repo } when the repo has no rows
interface GraphPayload {
  repo: string;
  host: string;
  generated_at: string;
  total: number;                      // rows for the repo (all pages)
  truncated: boolean;                 // more rows older than the last node
  next_before: string | null;         // pass as ?before= for the next (older) page
  nodes: GraphNode[];                 // newest started_at first (nulls last)
}
interface GraphNode {
  session_id: string;                 // Claude Code UUID
  node_id: string;                    // A0-3G
  repo: string | null;
  parent_session_id: string | null;
  parent_node_id: string | null;      // null when no parent or parent not ingested yet
  parent_link_source: 'env' | 'hook' | 'heuristic' | null;
  title: string;                      // custom_title ?? name ?? ai_title ?? first_prompt (80 chars) ?? node_id
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;        // excerpt, <= 200 chars (full text in SessionDetail)
  branch: string | null;
  cwd: string | null;
  started_at: string | null;
  last_active_at: string | null;
  host: string;
  available: boolean;                 // host === this daemon's host
  live: boolean;                      // only ever true for this host's rows
  status: string | null;              // registry status ('busy' | 'idle' | ...) when live
  tmux: string | null;                // registry tmux target when live, else the stored one
  tokens: { input: number; output: number; cache_read: number; cache_write: number; total: number };
  cost_usd: number | null;
  summary_excerpt: string | null;     // <= 280 chars
  child_count: number;                // rows whose parent_session_id is this session (any repo)
  unfinished: boolean | null;         // reserved for phase 13; always null in phase 7
}

// GET /api/sessions/:nodeId     (id case-insensitive, dash optional)
//   200 SessionDetail | 400 { error: 'invalid_node_id' } | 404 { error: 'not_found', node_id }
interface SessionDetail {
  session: GraphNode & {              // first_prompt here is the full prompt, <= 4000 chars
    entrypoint: string | null;
    version: string | null;
    models: unknown;                  // cc_sessions.models jsonb as stored, or null
    transcript_path: string | null;
    last_prompt: string | null;       // <= 4000 chars
    summary: string | null;           // full summary
    summarized_at: string | null;
    final_message: string | null;     // <= 4000 chars
  };
  prompts: Array<{ text: string; at: string | null }>;   // oldest first, last 200, each <= 2000 chars
  commits: Array<{ sha: string | null; subject: string | null }>;
  files_edited: string[];
  plan_docs: string[];
  notes: Array<{ id: string; excerpt: string; tags: string[]; created_at: string | null }>; // live notes with origin.claude_session = session_id, newest first, <= 50
  parent: NodeRef | null;
  children: NodeRef[];                // oldest first, <= 500
}
interface NodeRef {
  session_id: string; node_id: string; repo: string | null; title: string;
  started_at: string | null; last_active_at: string | null;
  host: string; available: boolean; live: boolean; status: string | null;
  parent_link_source: 'env' | 'hook' | 'heuristic' | null;
}

// GET /api/sessions/:nodeId/transcript?query=<words>&limit=20
//   200 TranscriptPayload
//   400 invalid_node_id / bad limit | 404 { error: 'not_found', node_id }
//   404 { error: 'not_on_this_machine', node_id, host }   (row.host !== this host)
//   404 { error: 'transcript_missing', node_id }            (no path recorded, or file pruned)
interface TranscriptPayload {
  node_id: string; session_id: string;
  query: string | null;               // null: no query, returns the last `limit` messages
  transcript_path: string;
  matches: Array<{ line: number; at: string | null; role: 'user' | 'assistant'; excerpt: string }>; // file order, the LAST `limit` matches
  total_matches: number;
  truncated: boolean;                 // total_matches > matches.length, or the 256 MB scan cap was hit
  scanned_bytes: number;
}
// query semantics: case-insensitive; whitespace-separated words and "quoted phrases"; a message matches when it contains every term; text blocks of user/assistant records only (tool calls/results and isMeta records skipped).

// GET /api/sessions/context?ids=A0-3G,b122   (loopback only: 403 forbidden_host / forbidden_origin)
//   200 ContextPayload (always 200; unknown ids just go to `missing`)
interface ContextPayload {
  nodes: Array<{ node_id: string; session_id: string; text: string }>; // in request order, each text <= 4000 chars
  missing: string[];                  // first the inputs that are not node ids (as given, trimmed), then well-formed ids with no row (canonical)
  context: string;                    // '' when nodes is empty; else CONTEXT_HEADER + '\n\n' + texts joined by '\n\n'
}
// ids: split on commas/whitespace, deduped, at most 10 considered (rest ignored). Cost: one indexed
// query on node_id + one on parent_session_id + one registry read.

// GET /api/sessions/search?q=<text>&repo=<repo>&limit=10   (limit 1-50)
//   200 SearchPayload | 400 { error }
interface SearchPayload {
  query: string;
  mode: 'hybrid' | 'text';
  fallback: string | null;            // phase 6's fallback reason when meaning search was unavailable
  hits: Array<GraphNode & { score: number }>; // phase 6's order, score rounded to 4 decimals
}

// GET /api/sessions/usage?by=month|node&repo=<repo>&month=YYYY-MM&limit=20   (by default 'month'; limit 1-200, by=node only)
//   200 UsagePayload | 400 { error }
interface UsageTotals {
  sessions: number; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; total_tokens: number;
  cost_usd: number | null;            // null when no row has a cost
}
type UsagePayload =
  | { by: 'month'; repo: string | null; month: string | null; time_zone: string;
      rows: Array<UsageTotals & { month: string }>;      // newest month first; month in the daemon's timezone
      totals: UsageTotals }
  | { by: 'node'; repo: string | null; month: string | null; time_zone: string;
      rows: Array<{ node_id: string; session_id: string; repo: string | null; title: string; started_at: string | null;
                    input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
                    total_tokens: number; cost_usd: number | null }>;  // total_tokens desc
      totals: UsageTotals };          // over every matching row, not just the top `limit`
```

**MCP tool results** (JSON text): `sessions_search` -> `{ query, mode, fallback, hits: [{ node_id, repo, title, started_at, last_active_at, host, available, live, status, parent_node_id, summary, score, url }], next }`; `session_get` -> `SessionDetail` with `url` added on `session`, `parent` and every child; `session_transcript` -> `TranscriptPayload` (errors as `isError` text starting `invalid_node_id:` / `not_found:` / `not_on_this_machine:` / `transcript_missing:`); `sessions_usage` -> `UsagePayload` (by=node rows gain `url`). `url` = `<wall>/projects?repo=<encoded repo>&node=<node_id>`, or `null` when the row has no repo.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/view.ts` | create | published types, row shaping, normalizers, context text |
| `src/sessions/transcriptSearch.ts` | create | bounded streaming search over one transcript JSONL |
| `src/sessions/readModel.ts` | create | read-only SQL + the three cross-phase seams (registry, settings, search) |
| `src/http/sessionsApi.ts` | create | the nine read/settings routes |
| `src/http/app.ts:34-88` | modify | `CreateAppOptions.sessions`, `mcpToolDeps(deps, sessions?)`, mount `sessionsApiRoutes` after phase 5's `sessionHookRoutes` |
| `src/mcp/tools.ts:12-28` | modify | `ToolDeps.sessions?` |
| `src/mcp/sessionTools.ts` | create | four MCP tools |
| `src/mcp/server.ts:12-23` | modify | `registerSessionTools(server, deps)` |
| `src/chat/status.ts` | modify (whole file given) | `SESSION_TOOL_NAMES`, allowlist, captions |
| `src/mcp/instructions.ts:22-58` | modify | doc comment + `Sessions.` paragraph appended to `sections` |
| `tests/unit/sessions.view.test.ts` | create | shaping, normalizers, context text |
| `tests/unit/sessions.transcriptSearch.test.ts` | create | transcript scan |
| `tests/unit/chat-status.test.ts:8-25`, `:66` | modify | counts 19+4+15+2, session captions |
| `tests/unit/mcp.instructions.test.ts` (append) | modify | Sessions paragraph test |
| `tests/integration/helpers/sessionsSeed.ts` | create | raw-SQL fixture rows + transcript file |
| `tests/integration/sessions.api.int.test.ts` | create | every endpoint |
| `tests/integration/sessions.mcp.int.test.ts` | create | every tool |

## Implementation Steps

### Step 1: Pure shaping and published types
**File:** `src/sessions/view.ts` (new)
**Change:** All JSON shapes in one place, plus pure functions turning raw SQL rows into them and the context text the prompt hook injects.
**Code:**
```ts
/**
 * Pure shaping of cc_sessions rows into the JSON the sessions read API, the MCP session tools
 * and the prompt hook's context endpoint return (iteration 8, phase 7). No I/O here: the SQL is in
 * readModel.ts, the transcript scan in transcriptSearch.ts. These types are the published
 * contract the web (phases 10-13) and the prompt hook (phase 8) plan against.
 */

export type ParentLinkSource = 'env' | 'hook' | 'heuristic';

export const SUMMARY_EXCERPT_CHARS = 280;
export const FIRST_PROMPT_EXCERPT_CHARS = 200;
export const TITLE_PROMPT_CHARS = 80;
export const DETAIL_TEXT_CHARS = 4000;
export const DETAIL_PROMPT_CHARS = 2000;
export const DETAIL_MAX_PROMPTS = 200;
export const DETAIL_MAX_CHILDREN = 500;
export const DETAIL_MAX_NOTES = 50;
export const NOTE_EXCERPT_CHARS = 200;
export const CONTEXT_NODE_MAX_CHARS = 4000;
export const CONTEXT_MAX_COMMITS = 10;
export const CONTEXT_MAX_PLAN_DOCS = 10;
export const CONTEXT_MAX_CHILDREN = 20;
export const CONTEXT_PROMPT_CHARS = 500;

/** First line of ContextPayload.context: tells the reading model where the blocks come from. */
export const CONTEXT_HEADER =
  'Claude Code session nodes mentioned in this prompt (from mcp-notes; node ids look like A0-3G):';

export interface TokenCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface GraphNode {
  session_id: string;
  node_id: string;
  repo: string | null;
  parent_session_id: string | null;
  parent_node_id: string | null;
  parent_link_source: ParentLinkSource | null;
  title: string;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  branch: string | null;
  cwd: string | null;
  started_at: string | null;
  last_active_at: string | null;
  host: string;
  available: boolean;
  live: boolean;
  status: string | null;
  tmux: string | null;
  tokens: TokenCounts;
  cost_usd: number | null;
  summary_excerpt: string | null;
  child_count: number;
  /** Phase 13 fills it; null until then. */
  unfinished: boolean | null;
}

export interface GraphPayload {
  repo: string;
  host: string;
  generated_at: string;
  total: number;
  truncated: boolean;
  next_before: string | null;
  nodes: GraphNode[];
}

export interface ProjectSummary {
  repo: string;
  sessions: number;
  live: number;
  last_active_at: string | null;
  first_started_at: string | null;
  hosts: string[];
}

export interface ProjectsPayload {
  host: string;
  selected: string | null;
  projects: ProjectSummary[];
}

export interface SelectedProject {
  repo: string | null;
}

export interface SessionPrompt {
  text: string;
  at: string | null;
}

export interface SessionCommit {
  sha: string | null;
  subject: string | null;
}

export interface NoteRef {
  id: string;
  excerpt: string;
  tags: string[];
  created_at: string | null;
}

export interface NodeRef {
  session_id: string;
  node_id: string;
  repo: string | null;
  title: string;
  started_at: string | null;
  last_active_at: string | null;
  host: string;
  available: boolean;
  live: boolean;
  status: string | null;
  parent_link_source: ParentLinkSource | null;
}

export interface SessionInfo extends GraphNode {
  entrypoint: string | null;
  version: string | null;
  models: unknown;
  transcript_path: string | null;
  last_prompt: string | null;
  summary: string | null;
  summarized_at: string | null;
  final_message: string | null;
}

export interface SessionDetail {
  session: SessionInfo;
  prompts: SessionPrompt[];
  commits: SessionCommit[];
  files_edited: string[];
  plan_docs: string[];
  notes: NoteRef[];
  parent: NodeRef | null;
  children: NodeRef[];
}

export interface ContextNode {
  node_id: string;
  session_id: string;
  text: string;
}

export interface ContextPayload {
  nodes: ContextNode[];
  missing: string[];
  context: string;
}

export interface SearchHit extends GraphNode {
  score: number;
}

export interface SearchPayload {
  query: string;
  mode: 'hybrid' | 'text';
  fallback: string | null;
  hits: SearchHit[];
}

export interface UsageTotals {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
}

export interface UsageMonthRow extends UsageTotals {
  month: string;
}

export interface UsageNodeRow {
  node_id: string;
  session_id: string;
  repo: string | null;
  title: string;
  started_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
}

export type UsagePayload =
  | { by: 'month'; repo: string | null; month: string | null; time_zone: string; rows: UsageMonthRow[]; totals: UsageTotals }
  | { by: 'node'; repo: string | null; month: string | null; time_zone: string; rows: UsageNodeRow[]; totals: UsageTotals };

export interface TranscriptPayload {
  node_id: string;
  session_id: string;
  query: string | null;
  transcript_path: string;
  matches: Array<{ line: number; at: string | null; role: 'user' | 'assistant'; excerpt: string }>;
  total_matches: number;
  truncated: boolean;
  scanned_bytes: number;
}

/**
 * One row of readModel's NODE_SELECT (snake_case SQL names; token columns already cast to float8).
 * A type alias, not an interface: db.execute<T> needs T assignable to Record<string, unknown>.
 */
export type NodeRow = {
  session_id: string;
  node_id: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  started_at: Date | string | null;
  last_active_at: Date | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
  parent_session_id: string | null;
  parent_link_source: string | null;
  tmux: string | null;
  summary_head: string | null;
  parent_node_id: string | null;
  child_count: number | string | null;
};

/** NODE_SELECT + DETAIL_SELECT. */
export type DetailRow = NodeRow & {
  entrypoint: string | null;
  version: string | null;
  models: unknown;
  transcript_path: string | null;
  first_prompt_full: string | null;
  last_prompt: string | null;
  summary: string | null;
  summarized_at: Date | string | null;
  final_message: string | null;
  prompts: unknown;
  commits: unknown;
  files_edited: unknown;
  plan_docs: unknown;
};

/** One live session from phase 3's registry, as the read model needs it. */
export interface LiveEntry {
  sessionId: string;
  status: string | null;
  tmux: string | null;
}

export interface NodeContext {
  /** os.hostname() of this daemon. */
  host: string;
  /** This host's live sessions, by session id. */
  live: ReadonlyMap<string, LiveEntry>;
}

export interface ContextInput {
  session: SessionInfo;
  commits: SessionCommit[];
  plan_docs: string[];
  children_node_ids: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/** Date or date-like string -> ISO 8601 UTC; anything else (or an invalid date) -> null. */
export function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** pg numeric/bigint may come back as strings; null/NaN -> 0. */
export function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed string, or null when empty / not a string. */
export function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

function dropTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** Whitespace collapsed to single spaces, at most `max` chars, an ellipsis when cut; null when empty. */
export function excerpt(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const flat = text.trim().replace(/\s+/g, ' ');
  if (flat === '') return null;
  if (flat.length <= max) return flat;
  return `${dropTrailingHighSurrogate(flat.slice(0, Math.max(0, max - 1)))}…`;
}

/** Like excerpt but keeps line breaks (multi-line text such as a summary or the context block). */
export function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const t = text.trim();
  if (t === '') return null;
  if (t.length <= max) return t;
  return `${dropTrailingHighSurrogate(t.slice(0, Math.max(0, max - 1)))}…`;
}

export function sessionTitle(row: {
  node_id: string;
  custom_title: string | null;
  name: string | null;
  ai_title: string | null;
  first_prompt: string | null;
}): string {
  return (
    nonEmpty(row.custom_title) ??
    nonEmpty(row.name) ??
    nonEmpty(row.ai_title) ??
    excerpt(row.first_prompt, TITLE_PROMPT_CHARS) ??
    row.node_id
  );
}

export function linkSource(value: unknown): ParentLinkSource | null {
  return value === 'env' || value === 'hook' || value === 'heuristic' ? value : null;
}

export function tokenCounts(row: Pick<NodeRow, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): TokenCounts {
  const input = num(row.input_tokens);
  const output = num(row.output_tokens);
  const cacheRead = num(row.cache_read_tokens);
  const cacheWrite = num(row.cache_write_tokens);
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** A row becomes a graph node. `available`/`live` are relative to `ctx.host`; `unfinished` stays null (phase 13). */
export function toGraphNode(row: NodeRow, ctx: NodeContext): GraphNode {
  const available = row.host === ctx.host;
  const live = available ? ctx.live.get(row.session_id) : undefined;
  return {
    session_id: row.session_id,
    node_id: row.node_id,
    repo: nonEmpty(row.repo),
    parent_session_id: nonEmpty(row.parent_session_id),
    parent_node_id: nonEmpty(row.parent_node_id),
    parent_link_source: linkSource(row.parent_link_source),
    title: sessionTitle(row),
    name: nonEmpty(row.name),
    custom_title: nonEmpty(row.custom_title),
    ai_title: nonEmpty(row.ai_title),
    first_prompt: excerpt(row.first_prompt, FIRST_PROMPT_EXCERPT_CHARS),
    branch: nonEmpty(row.branch),
    cwd: nonEmpty(row.cwd),
    started_at: iso(row.started_at),
    last_active_at: iso(row.last_active_at),
    host: row.host,
    available,
    live: live !== undefined,
    status: live?.status ?? null,
    tmux: live?.tmux ?? nonEmpty(row.tmux),
    tokens: tokenCounts(row),
    cost_usd: numOrNull(row.cost_usd),
    summary_excerpt: excerpt(row.summary_head, SUMMARY_EXCERPT_CHARS),
    child_count: num(row.child_count),
    unfinished: null,
  };
}

export function toNodeRef(node: GraphNode): NodeRef {
  return {
    session_id: node.session_id,
    node_id: node.node_id,
    repo: node.repo,
    title: node.title,
    started_at: node.started_at,
    last_active_at: node.last_active_at,
    host: node.host,
    available: node.available,
    live: node.live,
    status: node.status,
    parent_link_source: node.parent_link_source,
  };
}

export function toSessionInfo(row: DetailRow, ctx: NodeContext): SessionInfo {
  return {
    ...toGraphNode(row, ctx),
    first_prompt: clip(row.first_prompt_full, DETAIL_TEXT_CHARS),
    entrypoint: nonEmpty(row.entrypoint),
    version: nonEmpty(row.version),
    models: row.models ?? null,
    transcript_path: nonEmpty(row.transcript_path),
    last_prompt: clip(row.last_prompt, DETAIL_TEXT_CHARS),
    summary: clip(row.summary, Number.MAX_SAFE_INTEGER),
    summarized_at: iso(row.summarized_at),
    final_message: clip(row.final_message, DETAIL_TEXT_CHARS),
  };
}

/** cc_sessions.prompts -> [{text, at}], oldest first, the last DETAIL_MAX_PROMPTS. Strings or {text|prompt|content, at|timestamp|ts}. */
export function normalizePrompts(value: unknown): SessionPrompt[] {
  if (!Array.isArray(value)) return [];
  const out: SessionPrompt[] = [];
  for (const item of value) {
    let text: string | null = null;
    let at: string | null = null;
    if (typeof item === 'string') {
      text = item;
    } else if (isRecord(item)) {
      text = firstString(item, ['text', 'prompt', 'content']);
      at = iso(firstString(item, ['at', 'timestamp', 'ts']));
    }
    const t = clip(text, DETAIL_PROMPT_CHARS);
    if (t !== null) out.push({ text: t, at });
  }
  return out.slice(-DETAIL_MAX_PROMPTS);
}

const SHA_THEN_SUBJECT = /^([0-9a-f]{7,40})(?:\s+(.*))?$/i;

/** cc_sessions.commits -> [{sha, subject}]. Strings "sha subject" or {sha|hash|commit, subject|message|title}. */
export function normalizeCommits(value: unknown): SessionCommit[] {
  if (!Array.isArray(value)) return [];
  const out: SessionCommit[] = [];
  for (const item of value) {
    let sha: string | null = null;
    let subject: string | null = null;
    if (typeof item === 'string') {
      const t = item.trim();
      const m = SHA_THEN_SUBJECT.exec(t);
      if (m) {
        sha = m[1] ?? null;
        subject = nonEmpty(m[2]);
      } else {
        subject = nonEmpty(t);
      }
    } else if (isRecord(item)) {
      sha = nonEmpty(firstString(item, ['sha', 'hash', 'commit']));
      const message = firstString(item, ['subject', 'message', 'title']);
      subject = message === null ? null : nonEmpty(message.split('\n')[0]);
    }
    if (sha !== null || subject !== null) out.push({ sha, subject });
  }
  return out;
}

/** cc_sessions.files_edited / plan_docs -> unique paths in first-seen order. Strings or {path|file|file_path}. */
export function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const p = typeof item === 'string' ? nonEmpty(item) : isRecord(item) ? nonEmpty(firstString(item, ['path', 'file', 'file_path'])) : null;
    if (p !== null) seen.add(p);
  }
  return [...seen];
}

/** Wall deep link to a node in its project graph (phase 10's route); null without a repo. */
export function nodeUrl(wallUrl: string, repo: string | null, nodeId: string): string | null {
  if (repo === null) return null;
  const base = wallUrl.replace(/\/+$/, '');
  return `${base}/projects?repo=${encodeURIComponent(repo)}&node=${encodeURIComponent(nodeId)}`;
}

/** ISO instant -> "YYYY-MM-DD HH:mm" in `timeZone`; null for a missing or invalid instant. */
export function formatLocalTime(value: string | null, timeZone: string): string | null {
  if (value === null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function span(start: string | null, end: string | null, timeZone: string): string | null {
  const a = formatLocalTime(start, timeZone);
  const b = formatLocalTime(end, timeZone);
  if (a !== null && b !== null) return `${a} to ${b} ${timeZone}`;
  if (a !== null) return `started ${a} ${timeZone}`;
  if (b !== null) return `last active ${b} ${timeZone}`;
  return null;
}

function listed(items: readonly string[], max: number, sep: string): string {
  const shown = items.slice(0, max).join(sep);
  return items.length > max ? `${shown}${sep}+${items.length - max} more` : shown;
}

/**
 * The block the prompt hook (phase 8) injects for one node id: who/where/when, parent and
 * children, summary (or first prompt), plan docs, commits, transcript path or the host that holds
 * it, and the wall link. At most CONTEXT_NODE_MAX_CHARS.
 */
export function formatContext(input: ContextInput, opts: { timeZone: string; wallUrl: string }): string {
  const s = input.session;
  const where = [s.repo !== null ? `repo ${s.repo}` : null, s.branch !== null ? `branch ${s.branch}` : null, `host ${s.host}`]
    .filter((x): x is string => x !== null)
    .join(', ');
  const when = span(s.started_at, s.last_active_at, opts.timeZone);
  const state = s.live ? `; running now${s.status !== null ? ` (${s.status})` : ''}` : '';
  const lines: string[] = [`Session ${s.node_id} "${s.title}" (${where}${when !== null ? `; ${when}` : ''}${state})`];
  if (s.parent_node_id !== null) {
    lines.push(`Parent: ${s.parent_node_id}${s.parent_link_source !== null ? ` (${s.parent_link_source} link)` : ''}`);
  }
  if (input.children_node_ids.length > 0) {
    lines.push(`Children: ${listed(input.children_node_ids, CONTEXT_MAX_CHILDREN, ', ')}`);
  }
  if (s.summary !== null) {
    lines.push(`Summary: ${s.summary}`);
  } else {
    const first = excerpt(s.first_prompt, CONTEXT_PROMPT_CHARS);
    lines.push(`Summary: not summarized yet.${first !== null ? ` First prompt: ${first}` : ''}`);
  }
  if (input.plan_docs.length > 0) lines.push(`Plan docs: ${listed(input.plan_docs, CONTEXT_MAX_PLAN_DOCS, ', ')}`);
  if (input.commits.length > 0) {
    const commits = input.commits.map((c) => [c.sha?.slice(0, 7) ?? null, c.subject].filter((x) => x !== null).join(' '));
    lines.push(`Commits: ${listed(commits, CONTEXT_MAX_COMMITS, '; ')}`);
  }
  if (!s.available) {
    lines.push(`Transcript: on ${s.host}, not readable from this machine.`);
  } else if (s.transcript_path !== null) {
    lines.push(`Transcript: ${s.transcript_path} (resume with: claude --resume ${s.session_id})`);
  } else {
    lines.push('Transcript: not recorded.');
  }
  const url = nodeUrl(opts.wallUrl, s.repo, s.node_id);
  if (url !== null) lines.push(`Wall: ${url}`);
  return clip(lines.join('\n'), CONTEXT_NODE_MAX_CHARS) ?? '';
}
```
**Impact:** New file, no callers yet.

### Step 2: Bounded transcript search
**File:** `src/sessions/transcriptSearch.ts` (new)
**Change:** Stream a JSONL transcript once, keep the last N matching user/assistant text messages. A trailing partial line fails `JSON.parse` and is skipped (invariant 4's "partial line is not yet written").
**Code:**
```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export const TRANSCRIPT_DEFAULT_LIMIT = 20;
export const TRANSCRIPT_MAX_LIMIT = 100;
export const TRANSCRIPT_EXCERPT_CHARS = 600;
export const TRANSCRIPT_MAX_SCAN_BYTES = 256 * 1024 * 1024;
export const TRANSCRIPT_MAX_QUERY_TERMS = 8;

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptMessage {
  role: TranscriptRole;
  text: string;
  at: string | null;
}

export interface TranscriptMatch {
  /** 1-based JSONL line number. */
  line: number;
  at: string | null;
  role: TranscriptRole;
  excerpt: string;
}

export interface TranscriptSearchOptions {
  /** Null or blank: no filter, the last `limit` messages come back. */
  query: string | null;
  limit: number;
  /** Tests lower it. Default TRANSCRIPT_MAX_SCAN_BYTES. */
  maxScanBytes?: number;
}

export interface TranscriptSearchResult {
  matches: TranscriptMatch[];
  total_matches: number;
  truncated: boolean;
  scanned_bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The human-readable text of one transcript record: user/assistant text blocks only; tool calls, tool results and isMeta records give null. */
export function messageText(record: unknown): TranscriptMessage | null {
  if (!isRecord(record)) return null;
  const type = record.type;
  if (type !== 'user' && type !== 'assistant') return null;
  if (record.isMeta === true) return null;
  const message = record.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    text = parts.join('\n');
  }
  text = text.trim();
  if (text === '') return null;
  const ts = record.timestamp;
  const at = typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toISOString() : null;
  return { role: type, text, at };
}

/** Lower-cased terms: "quoted phrases" stay whole, other words split on whitespace; unique, at most TRANSCRIPT_MAX_QUERY_TERMS. */
export function queryTerms(query: string | null): string[] {
  if (query === null) return [];
  const terms: string[] = [];
  for (const m of query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? '').trim();
    if (t !== '' && !terms.includes(t)) terms.push(t);
  }
  return terms.slice(0, TRANSCRIPT_MAX_QUERY_TERMS);
}

function sliceSafe(text: string, start: number, end: number): string {
  let a = start;
  let b = end;
  const first = text.charCodeAt(a);
  if (a > 0 && first >= 0xdc00 && first <= 0xdfff) a += 1;
  const last = text.charCodeAt(b - 1);
  if (b < text.length && last >= 0xd800 && last <= 0xdbff) b -= 1;
  return text.slice(a, b);
}

/** About `max` chars of `text` (whitespace collapsed) around the earliest term hit, ellipses where cut. */
export function excerptAround(text: string, terms: readonly string[], max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let hit = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (hit < 0 || i < hit)) hit = i;
  }
  if (hit < 0) return `${sliceSafe(flat, 0, max - 1)}…`;
  const start = Math.max(0, Math.min(hit - Math.floor(max / 3), flat.length - max));
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? '…' : ''}${sliceSafe(flat, start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Scans `file` once. A message matches when it contains every query term (case-insensitive).
 * Keeps the LAST `limit` matches in file order. Throws ENOENT when the file is gone (the caller
 * maps it to transcript_missing).
 */
export async function searchTranscript(file: string, options: TranscriptSearchOptions): Promise<TranscriptSearchResult> {
  await stat(file);
  const terms = queryTerms(options.query === null || options.query.trim() === '' ? null : options.query);
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), TRANSCRIPT_MAX_LIMIT);
  const maxScan = options.maxScanBytes ?? TRANSCRIPT_MAX_SCAN_BYTES;
  const kept: TranscriptMatch[] = [];
  let total = 0;
  let scanned = 0;
  let line = 0;
  let capped = false;
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      line += 1;
      const size = Buffer.byteLength(raw, 'utf8') + 1;
      if (scanned + size > maxScan) {
        capped = true;
        break;
      }
      scanned += size;
      if (raw.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      const msg = messageText(record);
      if (msg === null) continue;
      if (terms.length > 0) {
        const lower = msg.text.toLowerCase();
        if (!terms.every((t) => lower.includes(t))) continue;
      }
      total += 1;
      kept.push({ line, at: msg.at, role: msg.role, excerpt: excerptAround(msg.text, terms, TRANSCRIPT_EXCERPT_CHARS) });
      if (kept.length > limit) kept.shift();
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { matches: kept, total_matches: total, truncated: capped || total > kept.length, scanned_bytes: scanned };
}
```
**Impact:** New file.

### Step 3: Read model (SQL) and the three cross-phase seams
**File:** `src/sessions/readModel.ts` (new)
**Change:** Every read the API and the tools need. Reads only; the one write (`writeSelected`) goes through phase 1's `SessionsRepo` settings. Every phase-1/3/6 runtime symbol is touched in exactly one function (`repoSettings`, `liveFromRegistry`, `phase6Search`) so the reconciler fixes a name in one place.
**Code:**
```ts
import os from 'node:os';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { AppDeps } from '../deps.js';
import type { Embedder } from '../embeddings/embedder.js';
import { DEFAULT_WALL_URL, localTimeZone, wallUrlForPort } from '../mcp/instructions.js';
import { normalizeNodeId } from './ids.js';
import { readLiveSessions } from './registry.js';
import { SessionsRepo } from './repo.js';
import { searchSessions } from './search.js';
import { searchTranscript } from './transcriptSearch.js';
import {
  CONTEXT_HEADER,
  DETAIL_MAX_CHILDREN,
  DETAIL_MAX_NOTES,
  NOTE_EXCERPT_CHARS,
  excerpt,
  formatContext,
  iso,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  num,
  numOrNull,
  toGraphNode,
  toNodeRef,
  toSessionInfo,
  type ContextNode,
  type ContextPayload,
  type DetailRow,
  type GraphPayload,
  type LiveEntry,
  type NodeContext,
  type NodeRow,
  type ProjectsPayload,
  type SearchPayload,
  type SessionDetail,
  type TranscriptPayload,
  type UsageMonthRow,
  type UsageNodeRow,
  type UsagePayload,
  type UsageTotals,
} from './view.js';

import { SELECTED_PROJECT_KEY } from './types.js';

export { SELECTED_PROJECT_KEY };
export const CONTEXT_MAX_IDS = 10;
const USAGE_MAX_MONTHS = 120;

export type LiveSource = () => Promise<LiveEntry[]>;

export interface SettingsStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface SessionSearchHit {
  sessionId: string;
  score: number;
}

export interface SessionSearchOutcome {
  mode: 'hybrid' | 'text';
  fallback: string | null;
  hits: SessionSearchHit[];
}

export type SessionSearchFn = (args: { query: string; repo: string | null; limit: number }) => Promise<SessionSearchOutcome>;

/** Everything the sessions read API and MCP session tools read through. */
export interface SessionsReadDeps {
  db: Db;
  /** os.hostname() of this daemon: decides `available` and which rows can be `live`. */
  host: string;
  /** IANA zone for usage months and context times (the daemon's local zone). */
  timeZone: string;
  /** Wall base URL for node links. */
  wallUrl: string;
  live: LiveSource;
  settings: SettingsStore;
  search: SessionSearchFn;
}

/** Test seams; production passes none. */
export interface SessionsReadOverrides {
  host?: string;
  timeZone?: string;
  live?: LiveSource;
  settings?: SettingsStore;
  search?: SessionSearchFn;
}

// ---- Cross-phase seams: the only places this phase calls phase 1/3/6 runtime code. ----

/** Phase 3's live registry reduced to {sessionId, status, tmux}. A missing or unreadable registry means nothing is live. */
async function liveFromRegistry(claudeHome: string): Promise<LiveEntry[]> {
  try {
    const entries = await readLiveSessions(claudeHome);
    return entries.map((e) => ({ sessionId: e.sessionId, status: e.status ?? null, tmux: e.tmux ?? null }));
  } catch {
    return [];
  }
}

/** Phase 1's app_settings accessors. The repo is created on first use, so building deps does no I/O. */
function repoSettings(db: Db): SettingsStore {
  let repo: SessionsRepo | null = null;
  const get = (): SessionsRepo => (repo ??= new SessionsRepo(db));
  return {
    get: (key) => get().getSetting(key),
    put: (key, value) => get().putSetting(key, value),
  };
}

/** Phase 6's hybrid session search. */
function phase6Search(db: Db, embedder: Embedder | null): SessionSearchFn {
  return async ({ query, repo, limit }) => {
    const res = await searchSessions({ db, embedder }, query, { limit, ...(repo !== null ? { repo } : {}) });
    return {
      mode: res.mode,
      fallback: res.fallback ?? null,
      hits: res.sessions.map((h) => ({ sessionId: h.session_id, score: h.score })),
    };
  };
}

// ---------------------------------------------------------------------------------------------

export function sessionsReadDeps(deps: AppDeps, over: SessionsReadOverrides = {}): SessionsReadDeps {
  const claudeHome = deps.config.sessions?.claudeHome ?? path.join(os.homedir(), '.claude');
  const embedder = deps.embedder ?? null;
  return {
    db: deps.db,
    host: over.host ?? os.hostname(),
    timeZone: over.timeZone ?? localTimeZone(),
    wallUrl: wallUrlForPort(deps.config.port) ?? DEFAULT_WALL_URL,
    live: over.live ?? (() => liveFromRegistry(claudeHome)),
    settings: over.settings ?? repoSettings(deps.db),
    search: over.search ?? phase6Search(deps.db, embedder),
  };
}

/** `= any(<this>)` over a JS string list, as one jsonb parameter (works for an empty list). */
function textArray(ids: readonly string[]): SQL {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
}

async function liveMap(rd: SessionsReadDeps): Promise<Map<string, LiveEntry>> {
  let entries: LiveEntry[];
  try {
    entries = await rd.live();
  } catch {
    entries = [];
  }
  return new Map(entries.map((e) => [e.sessionId, e]));
}

async function nodeContext(rd: SessionsReadDeps): Promise<NodeContext> {
  return { host: rd.host, live: await liveMap(rd) };
}

/** Columns of a graph node. `s` is the row, `p` its parent (left join). */
const NODE_SELECT = sql.raw(`
  s.session_id, s.node_id, s.host, s.repo, s.cwd, s.branch, s.name, s.custom_title, s.ai_title,
  left(s.first_prompt, 400) as first_prompt, s.started_at, s.last_active_at,
  coalesce(s.input_tokens, 0)::float8 as input_tokens,
  coalesce(s.output_tokens, 0)::float8 as output_tokens,
  coalesce(s.cache_read_tokens, 0)::float8 as cache_read_tokens,
  coalesce(s.cache_write_tokens, 0)::float8 as cache_write_tokens,
  s.cost_usd::float8 as cost_usd,
  s.parent_session_id, s.parent_link_source, s.tmux,
  left(s.summary, 600) as summary_head,
  p.node_id as parent_node_id,
  (select count(*)::int from cc_sessions c where c.parent_session_id = s.session_id) as child_count`);

/** Extra columns for node detail and the context endpoint. */
const DETAIL_SELECT = sql.raw(`
  s.entrypoint, s.version, s.models, s.transcript_path,
  left(s.first_prompt, 4000) as first_prompt_full,
  left(s.last_prompt, 4000) as last_prompt,
  s.summary, s.summarized_at,
  left(s.final_message, 4000) as final_message,
  s.prompts, s.commits, s.files_edited, s.plan_docs`);

const NODE_FROM = sql.raw(`cc_sessions s left join cc_sessions p on p.session_id = s.parent_session_id`);

const TOTAL_TOKENS = sql.raw(
  `(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0) + coalesce(s.cache_read_tokens, 0) + coalesce(s.cache_write_tokens, 0))`,
);

const USAGE_SUMS = sql.raw(`
  count(*)::int as sessions,
  coalesce(sum(s.input_tokens), 0)::float8 as input_tokens,
  coalesce(sum(s.output_tokens), 0)::float8 as output_tokens,
  coalesce(sum(s.cache_read_tokens), 0)::float8 as cache_read_tokens,
  coalesce(sum(s.cache_write_tokens), 0)::float8 as cache_write_tokens,
  sum(s.cost_usd)::float8 as cost_usd`);

type ProjectRow = {
  repo: string;
  sessions: number | string;
  live: number | string;
  last_active_at: Date | string | null;
  first_started_at: Date | string | null;
  hosts: string[] | null;
};

type NoteRow = { id: string; body: string; tags: string[] | null; created_at: Date | string | null };

type SumsRow = {
  sessions: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readSelected(rd: SessionsReadDeps): Promise<string | null> {
  const value = await rd.settings.get(SELECTED_PROJECT_KEY);
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (isRecord(value) && typeof value.repo === 'string' && value.repo.trim() !== '') return value.repo;
  return null;
}

export async function writeSelected(rd: SessionsReadDeps, repo: string | null): Promise<void> {
  // Same format as SessionsRepo.setSelectedProject: a bare JSON string; null deletes the key.
  await rd.settings.put(SELECTED_PROJECT_KEY, repo);
}

export async function repoExists(rd: SessionsReadDeps, repo: string): Promise<boolean> {
  const res = await rd.db.execute<{ one: number }>(sql`select 1 as one from cc_sessions where repo = ${repo} limit 1`);
  return res.rows.length > 0;
}

export async function listProjects(rd: SessionsReadDeps): Promise<ProjectsPayload> {
  const live = await liveMap(rd);
  const res = await rd.db.execute<ProjectRow>(sql`
    select repo,
      count(*)::int as sessions,
      count(*) filter (where host = ${rd.host} and session_id = any(${textArray([...live.keys()])}))::int as live,
      max(coalesce(last_active_at, started_at)) as last_active_at,
      min(started_at) as first_started_at,
      array_agg(distinct host order by host) as hosts
    from cc_sessions
    where repo is not null
    group by repo
    order by max(coalesce(last_active_at, started_at)) desc nulls last, repo`);
  const selected = await readSelected(rd);
  return {
    host: rd.host,
    selected,
    projects: res.rows.map((r) => ({
      repo: r.repo,
      sessions: num(r.sessions),
      live: num(r.live),
      last_active_at: iso(r.last_active_at),
      first_started_at: iso(r.first_started_at),
      hosts: Array.isArray(r.hosts) ? r.hosts : [],
    })),
  };
}

export interface GraphQuery {
  /** ISO instant: only nodes that started strictly before it (keyset paging). */
  before: string | null;
  limit: number;
}

export async function graphForRepo(rd: SessionsReadDeps, repo: string, q: GraphQuery): Promise<GraphPayload> {
  const ctx = await nodeContext(rd);
  const beforeCond = q.before === null ? sql`` : sql`and s.started_at < ${q.before}::timestamptz`;
  const [rows, count] = await Promise.all([
    rd.db.execute<NodeRow>(sql`
      select ${NODE_SELECT} from ${NODE_FROM}
      where s.repo = ${repo} ${beforeCond}
      order by s.started_at desc nulls last, s.session_id desc
      limit ${q.limit + 1}`),
    rd.db.execute<{ n: number | string }>(sql`select count(*)::int as n from cc_sessions where repo = ${repo}`),
  ]);
  const more = rows.rows.length > q.limit;
  const nodes = rows.rows.slice(0, q.limit).map((r) => toGraphNode(r, ctx));
  const last = nodes.at(-1);
  return {
    repo,
    host: rd.host,
    generated_at: new Date().toISOString(),
    total: num(count.rows[0]?.n),
    truncated: more,
    next_before: more && last !== undefined ? last.started_at : null,
    nodes,
  };
}

export async function sessionDetail(rd: SessionsReadDeps, nodeId: string): Promise<SessionDetail | null> {
  const res = await rd.db.execute<DetailRow>(sql`
    select ${NODE_SELECT}, ${DETAIL_SELECT} from ${NODE_FROM} where s.node_id = ${nodeId} limit 1`);
  const row = res.rows[0];
  if (row === undefined) return null;
  const ctx = await nodeContext(rd);
  const [children, parent, notes] = await Promise.all([
    rd.db.execute<NodeRow>(sql`
      select ${NODE_SELECT} from ${NODE_FROM}
      where s.parent_session_id = ${row.session_id}
      order by s.started_at asc nulls last, s.session_id
      limit ${DETAIL_MAX_CHILDREN}`),
    row.parent_session_id === null
      ? Promise.resolve(null)
      : rd.db.execute<NodeRow>(sql`select ${NODE_SELECT} from ${NODE_FROM} where s.session_id = ${row.parent_session_id} limit 1`),
    rd.db.execute<NoteRow>(sql`
      select id, body, tags, created_at from notes
      where deleted_at is null and origin ->> 'claude_session' = ${row.session_id}
      order by created_at desc
      limit ${DETAIL_MAX_NOTES}`),
  ]);
  const parentRow = parent?.rows[0];
  return {
    session: toSessionInfo(row, ctx),
    prompts: normalizePrompts(row.prompts),
    commits: normalizeCommits(row.commits),
    files_edited: normalizePaths(row.files_edited),
    plan_docs: normalizePaths(row.plan_docs),
    notes: notes.rows.map((n) => ({
      id: n.id,
      excerpt: excerpt(n.body, NOTE_EXCERPT_CHARS) ?? '',
      tags: Array.isArray(n.tags) ? n.tags : [],
      created_at: iso(n.created_at),
    })),
    parent: parentRow === undefined ? null : toNodeRef(toGraphNode(parentRow, ctx)),
    children: children.rows.map((c) => toNodeRef(toGraphNode(c, ctx))),
  };
}

/**
 * Prompt-hook context for up to CONTEXT_MAX_IDS node ids: one indexed query on node_id, one on
 * parent_session_id, one registry read. Ids that are not node ids or do not exist go to `missing`.
 */
export async function contextFor(rd: SessionsReadDeps, rawIds: readonly string[]): Promise<ContextPayload> {
  const wanted: string[] = [];
  const missing: string[] = [];
  for (const raw of rawIds.slice(0, CONTEXT_MAX_IDS)) {
    const id = normalizeNodeId(raw);
    if (id === null) missing.push(raw);
    else if (!wanted.includes(id)) wanted.push(id);
  }
  if (wanted.length === 0) return { nodes: [], missing, context: '' };

  const res = await rd.db.execute<DetailRow>(sql`
    select ${NODE_SELECT}, ${DETAIL_SELECT} from ${NODE_FROM}
    where s.node_id = any(${textArray(wanted)})`);
  const byNode = new Map(res.rows.map((r) => [r.node_id, r]));
  const sessionIds = res.rows.map((r) => r.session_id);
  const kids =
    sessionIds.length === 0
      ? { rows: [] as Array<{ parent_session_id: string; node_id: string }> }
      : await rd.db.execute<{ parent_session_id: string; node_id: string }>(sql`
          select parent_session_id, node_id from cc_sessions
          where parent_session_id = any(${textArray(sessionIds)})
          order by started_at asc nulls last, node_id`);
  const childrenOf = new Map<string, string[]>();
  for (const k of kids.rows) {
    const list = childrenOf.get(k.parent_session_id) ?? [];
    list.push(k.node_id);
    childrenOf.set(k.parent_session_id, list);
  }
  const ctx = await nodeContext(rd);
  const nodes: ContextNode[] = [];
  for (const id of wanted) {
    const row = byNode.get(id);
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    const text = formatContext(
      {
        session: toSessionInfo(row, ctx),
        commits: normalizeCommits(row.commits),
        plan_docs: normalizePaths(row.plan_docs),
        children_node_ids: childrenOf.get(row.session_id) ?? [],
      },
      { timeZone: rd.timeZone, wallUrl: rd.wallUrl },
    );
    nodes.push({ node_id: row.node_id, session_id: row.session_id, text });
  }
  const context = nodes.length === 0 ? '' : `${CONTEXT_HEADER}\n\n${nodes.map((n) => n.text).join('\n\n')}`;
  return { nodes, missing, context };
}

export async function searchNodes(
  rd: SessionsReadDeps,
  q: { query: string; repo: string | null; limit: number },
): Promise<SearchPayload> {
  const outcome = await rd.search(q);
  const ids = outcome.hits.map((h) => h.sessionId);
  if (ids.length === 0) return { query: q.query, mode: outcome.mode, fallback: outcome.fallback, hits: [] };
  const res = await rd.db.execute<NodeRow>(sql`
    select ${NODE_SELECT} from ${NODE_FROM} where s.session_id = any(${textArray(ids)})`);
  const bySession = new Map(res.rows.map((r) => [r.session_id, r]));
  const ctx = await nodeContext(rd);
  const hits = outcome.hits.flatMap((h) => {
    const row = bySession.get(h.sessionId);
    return row === undefined ? [] : [{ ...toGraphNode(row, ctx), score: Math.round(h.score * 10_000) / 10_000 }];
  });
  return { query: q.query, mode: outcome.mode, fallback: outcome.fallback, hits };
}

export interface UsageQuery {
  by: 'node' | 'month';
  repo: string | null;
  /** YYYY-MM in rd.timeZone, or null for all time. */
  month: string | null;
  /** by=node only. */
  limit: number;
}

function usageWhere(rd: SessionsReadDeps, q: UsageQuery): SQL {
  const conds: SQL[] = [sql`true`];
  if (q.repo !== null) conds.push(sql`s.repo = ${q.repo}`);
  if (q.month !== null) conds.push(sql`to_char(s.started_at at time zone ${rd.timeZone}, 'YYYY-MM') = ${q.month}`);
  return sql.join(conds, sql` and `);
}

function totalsOf(r: SumsRow): UsageTotals {
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  const cacheRead = num(r.cache_read_tokens);
  const cacheWrite = num(r.cache_write_tokens);
  return {
    sessions: num(r.sessions),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: input + output + cacheRead + cacheWrite,
    cost_usd: numOrNull(r.cost_usd),
  };
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    sessions: a.sessions + b.sessions,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cost_usd: a.cost_usd === null && b.cost_usd === null ? null : (a.cost_usd ?? 0) + (b.cost_usd ?? 0),
  };
}

const ZERO_TOTALS: UsageTotals = {
  sessions: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  cost_usd: null,
};

export async function usage(rd: SessionsReadDeps, q: UsageQuery): Promise<UsagePayload> {
  const where = usageWhere(rd, q);
  if (q.by === 'month') {
    const res = await rd.db.execute<SumsRow & { month: string }>(sql`
      select to_char(s.started_at at time zone ${rd.timeZone}, 'YYYY-MM') as month, ${USAGE_SUMS}
      from cc_sessions s
      where s.started_at is not null and ${where}
      group by 1
      order by 1 desc
      limit ${USAGE_MAX_MONTHS}`);
    const rows: UsageMonthRow[] = res.rows.map((r) => ({ month: r.month, ...totalsOf(r) }));
    const totals = rows.reduce<UsageTotals>((acc, r) => addTotals(acc, r), ZERO_TOTALS);
    return { by: 'month', repo: q.repo, month: q.month, time_zone: rd.timeZone, rows, totals };
  }
  const [top, sums] = await Promise.all([
    rd.db.execute<NodeRow>(sql`
      select ${NODE_SELECT} from ${NODE_FROM}
      where ${where}
      order by ${TOTAL_TOKENS} desc, s.started_at desc nulls last
      limit ${q.limit}`),
    rd.db.execute<SumsRow>(sql`select ${USAGE_SUMS} from cc_sessions s where ${where}`),
  ]);
  const ctx: NodeContext = { host: rd.host, live: new Map() };
  const rows: UsageNodeRow[] = top.rows.map((r) => {
    const n = toGraphNode(r, ctx);
    return {
      node_id: n.node_id,
      session_id: n.session_id,
      repo: n.repo,
      title: n.title,
      started_at: n.started_at,
      input_tokens: n.tokens.input,
      output_tokens: n.tokens.output,
      cache_read_tokens: n.tokens.cache_read,
      cache_write_tokens: n.tokens.cache_write,
      total_tokens: n.tokens.total,
      cost_usd: n.cost_usd,
    };
  });
  const totalsRow = sums.rows[0];
  return {
    by: 'node',
    repo: q.repo,
    month: q.month,
    time_zone: rd.timeZone,
    rows,
    totals: totalsRow === undefined ? ZERO_TOTALS : totalsOf(totalsRow),
  };
}

export type TranscriptOutcome =
  | { ok: true; payload: TranscriptPayload }
  | { ok: false; error: 'not_found'; node_id: string }
  | { ok: false; error: 'not_on_this_machine'; node_id: string; host: string }
  | { ok: false; error: 'transcript_missing'; node_id: string };

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** Transcript search on the owning host only (invariant 7). */
export async function readTranscript(
  rd: SessionsReadDeps,
  nodeId: string,
  opts: { query: string | null; limit: number },
): Promise<TranscriptOutcome> {
  const res = await rd.db.execute<{ session_id: string; node_id: string; host: string; transcript_path: string | null }>(sql`
    select session_id, node_id, host, transcript_path from cc_sessions where node_id = ${nodeId} limit 1`);
  const row = res.rows[0];
  if (row === undefined) return { ok: false, error: 'not_found', node_id: nodeId };
  if (row.host !== rd.host) return { ok: false, error: 'not_on_this_machine', node_id: row.node_id, host: row.host };
  const file = row.transcript_path;
  if (file === null || file.trim() === '') return { ok: false, error: 'transcript_missing', node_id: row.node_id };
  const query = opts.query === null || opts.query.trim() === '' ? null : opts.query.trim();
  try {
    const r = await searchTranscript(file, { query, limit: opts.limit });
    return {
      ok: true,
      payload: {
        node_id: row.node_id,
        session_id: row.session_id,
        query,
        transcript_path: file,
        matches: r.matches,
        total_matches: r.total_matches,
        truncated: r.truncated,
        scanned_bytes: r.scanned_bytes,
      },
    };
  } catch (err) {
    if (isNotFound(err)) return { ok: false, error: 'transcript_missing', node_id: row.node_id };
    throw err;
  }
}
```
**Impact:** New file; first runtime import of phase 1's `SessionsRepo`/`normalizeNodeId`, phase 3's `readLiveSessions`, phase 6's `searchSessions`.

### Step 4: HTTP routes
**File:** `src/http/sessionsApi.ts` (new)
**Change:** Nine routes. Static `/api/sessions/{context,search,usage}` are registered before `/api/sessions/:nodeId` so the param route never shadows them. `PUT /api/projects/selected` is `sameOriginOnly`; `GET /api/sessions/context` is loopback-only.
**Code:**
```ts
import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { normalizeNodeId } from '../sessions/ids.js';
import {
  contextFor,
  graphForRepo,
  listProjects,
  readSelected,
  readTranscript,
  repoExists,
  searchNodes,
  sessionDetail,
  sessionsReadDeps,
  usage,
  writeSelected,
  type SessionsReadOverrides,
} from '../sessions/readModel.js';
import { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from '../sessions/transcriptSearch.js';
import type { GraphPayload, SelectedProject } from '../sessions/view.js';
import { isLoopbackUrl, sameOriginOnly } from './sameOrigin.js';

export const GRAPH_DEFAULT_LIMIT = 2000;
export const GRAPH_MAX_LIMIT = 5000;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;
export const USAGE_DEFAULT_LIMIT = 20;
export const USAGE_MAX_LIMIT = 200;
export const MAX_REPO_CHARS = 200;
export const MAX_QUERY_CHARS = 500;
export const MAX_CONTEXT_IDS_CHARS = 2000;

export type SessionsApiOptions = SessionsReadOverrides;

const repoField = z.string().trim().min(1).max(MAX_REPO_CHARS);

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GRAPH_MAX_LIMIT).default(GRAPH_DEFAULT_LIMIT),
  before: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'before: not a valid datetime')
    .optional(),
});

const selectedBodySchema = z.object({ repo: repoField.nullable() });

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'q is empty').max(MAX_QUERY_CHARS),
  repo: repoField.optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
});

const usageQuerySchema = z.object({
  by: z.enum(['node', 'month']).default('month'),
  repo: repoField.optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM')
    .optional(),
  limit: z.coerce.number().int().min(1).max(USAGE_MAX_LIMIT).default(USAGE_DEFAULT_LIMIT),
});

const transcriptQuerySchema = z.object({
  query: z.string().max(MAX_QUERY_CHARS).optional(),
  limit: z.coerce.number().int().min(1).max(TRANSCRIPT_MAX_LIMIT).default(TRANSCRIPT_DEFAULT_LIMIT),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

/**
 * Loopback-only reads (the prompt hook's context lookup): the request URL must name loopback
 * (DNS-rebinding guard) and a browser Origin, when present, must be loopback too.
 */
export const loopbackReadGuard: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url)) return c.json({ error: 'forbidden_host' }, 403);
  const origin = c.req.header('origin');
  if (origin !== undefined && !isLoopbackUrl(origin)) return c.json({ error: 'forbidden_origin' }, 403);
  await next();
};

/** Weak ETag over everything but generated_at, so an unchanged graph polls as 304. */
export function graphEtag(payload: GraphPayload): string {
  const digest = createHash('sha1')
    .update(JSON.stringify([payload.repo, payload.total, payload.next_before, payload.nodes]))
    .digest('hex');
  return `W/"${digest}"`;
}

/** "A0-3G, b122  zz-zz" -> ['A0-3G', 'b122', 'zz-zz'] (raw, trimmed, deduped, in order). */
export function parseIdList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const t = part.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The sessions read API (iteration 8, phase 7). The web polls GET /api/projects/:repo/sessions
 * (ETag + If-None-Match) instead of an SSE event: session rows change on every transcript append,
 * and the other laptop's ingest never reaches this daemon's event bus anyway.
 *
 * GET  /api/projects                       repo list, counts, live counts, selected repo
 * GET  /api/projects/selected              { repo }
 * PUT  /api/projects/selected              { repo | null }   same-origin only
 * GET  /api/projects/:repo/sessions        graph payload
 * GET  /api/sessions/context?ids=          prompt-hook context   loopback only
 * GET  /api/sessions/search?q=&repo=&limit=
 * GET  /api/sessions/usage?by=&repo=&month=&limit=
 * GET  /api/sessions/:nodeId/transcript?query=&limit=   owning host only
 * GET  /api/sessions/:nodeId
 */
export function sessionsApiRoutes(deps: AppDeps, options: SessionsApiOptions = {}): Hono {
  const rd = sessionsReadDeps(deps, options);
  const r = new Hono();

  r.get('/api/projects', async (c) => c.json(await listProjects(rd)));

  r.get('/api/projects/selected', async (c) => {
    const body: SelectedProject = { repo: await readSelected(rd) };
    return c.json(body);
  });

  r.put('/api/projects/selected', sameOriginOnly, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = selectedBodySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const repo = parsed.data.repo;
    if (repo !== null && !(await repoExists(rd, repo))) return c.json({ error: 'unknown_repo', repo }, 404);
    await writeSelected(rd, repo);
    const body: SelectedProject = { repo };
    return c.json(body);
  });

  r.get('/api/projects/:repo/sessions', async (c) => {
    const repo = c.req.param('repo');
    const parsed = graphQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const payload = await graphForRepo(rd, repo, { before: parsed.data.before ?? null, limit: parsed.data.limit });
    if (payload.total === 0) return c.json({ error: 'unknown_repo', repo }, 404);
    const etag = graphEtag(payload);
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(payload);
  });

  r.get('/api/sessions/context', loopbackReadGuard, async (c) => {
    const raw = c.req.query('ids') ?? '';
    if (raw.length > MAX_CONTEXT_IDS_CHARS) return c.json({ error: 'ids: too long' }, 400);
    return c.json(await contextFor(rd, parseIdList(raw)));
  });

  r.get('/api/sessions/search', async (c) => {
    const parsed = searchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const { q, repo, limit } = parsed.data;
    return c.json(await searchNodes(rd, { query: q, repo: repo ?? null, limit }));
  });

  r.get('/api/sessions/usage', async (c) => {
    const parsed = usageQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const { by, repo, month, limit } = parsed.data;
    return c.json(await usage(rd, { by, repo: repo ?? null, month: month ?? null, limit }));
  });

  r.get('/api/sessions/:nodeId/transcript', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const parsed = transcriptQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const out = await readTranscript(rd, nodeId, { query: parsed.data.query ?? null, limit: parsed.data.limit });
    if (out.ok) return c.json(out.payload);
    if (out.error === 'not_on_this_machine') return c.json({ error: out.error, node_id: out.node_id, host: out.host }, 404);
    return c.json({ error: out.error, node_id: out.node_id }, 404);
  });

  r.get('/api/sessions/:nodeId', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const detail = await sessionDetail(rd, nodeId);
    return detail === null ? c.json({ error: 'not_found', node_id: nodeId }, 404) : c.json(detail);
  });

  return r;
}
```
**Impact:** New routes; nothing existing changes. Phase 5's `POST /api/sessions/hook/*` and phase 9's `POST /api/sessions/:nodeId/resume` are POST and never collide with these GETs.

### Step 5: `ToolDeps.sessions`
**File:** `src/mcp/tools.ts:1-28`
**Change:** Add one type import and one optional field to `ToolDeps`.
**Code:** add the import after line 10 (`import { ConnectorError, type Connectors } from '../connectors/types.js';`):
```ts
import type { SessionsReadDeps } from '../sessions/readModel.js';
```
and replace the `ToolDeps` interface (lines 12-28) with:
```ts
export interface ToolDeps {
  service: NotesService;
  dataDir: string;
  /** Read-only use by phase 5's image tools (raw image records); writes still go through `service`. */
  db: Db;
  /** Connectors for the connector tools. Omitted: defaultConnectors() (sibling repos, read per call). Tests inject their own. */
  connectors?: Connectors;
  /**
   * The wall's base URL (`http://localhost:<port>`, no trailing slash) named in the instructions'
   * Links paragraph. Omitted: `DEFAULT_WALL_URL` (port 7317), e.g. a daemon on port 0 in tests.
   */
  wallUrl?: string;
  /** Image embedder behind `similar_images`. Omitted or null: image search off (existing vectors still answer image_id). */
  imageEmbedder?: ImageEmbedder | null;
  /** Reads a wall-chat upload for `similar_images` upload_id. Omitted: upload_id answers that uploads are unavailable. */
  chatUploads?: ChatUploadSource;
  /** Session read model behind sessions_search / session_get / session_transcript / sessions_usage (iteration 8). Omitted: those tools answer SESSIONS_OFF. */
  sessions?: SessionsReadDeps;
}
```
**Impact:** Optional field; every existing `ToolDeps` literal still compiles.

### Step 6: MCP session tools
**File:** `src/mcp/sessionTools.ts` (new)
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { normalizeNodeId } from '../sessions/ids.js';
import { readTranscript, searchNodes, sessionDetail, usage, type SessionsReadDeps } from '../sessions/readModel.js';
import { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from '../sessions/transcriptSearch.js';
import { nodeUrl, type NodeRef } from '../sessions/view.js';
import { errorResult, jsonResult, type ToolDeps } from './tools.js';

export const SESSIONS_SEARCH_DEFAULT_LIMIT = 10;
export const SESSIONS_SEARCH_MAX_LIMIT = 50;
export const SESSIONS_USAGE_DEFAULT_LIMIT = 20;
export const SESSIONS_USAGE_MAX_LIMIT = 200;

export const SESSIONS_OFF = 'Claude Code sessions are not available on this server (it was started without the session read model).';

const nodeIdField = z
  .string()
  .min(1)
  .describe('Session node id like A0-3G: two characters, a dash, two characters. Case-insensitive; the dash may be omitted. Not a note id (A-B32).');

function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function badNodeId(input: string): CallToolResult {
  return fail(`invalid_node_id: "${input}" is not a session node id. Node ids look like A0-3G (two characters, a dash, two characters); note ids like A-B32 are a different thing.`);
}

function notFound(nodeId: string): CallToolResult {
  return fail(`not_found: no session ${nodeId}. Node ids come from sessions_search, session_get, a SessionStart note in the conversation, or the wall's project graph.`);
}

function withUrl<T extends { node_id: string; repo: string | null }>(rd: SessionsReadDeps, item: T): T & { url: string | null } {
  return { ...item, url: nodeUrl(rd.wallUrl, item.repo, item.node_id) };
}

export function registerSessionTools(server: McpServer, deps: ToolDeps): void {
  const rd = deps.sessions;

  server.registerTool(
    'sessions_search',
    {
      title: 'Search Claude Code sessions',
      description:
        "Find the user's past Claude Code sessions (both laptops) by meaning and words in their summaries, names, titles and prompts, e.g. \"when did I fix photo delete in the wall?\". " +
        'Optional repo narrows to one repository (e.g. "mcp-notes"). Returns { query, mode, fallback, hits: [{ node_id, repo, title, started_at, last_active_at, host, available, live, status, parent_node_id, summary, score, url }] }, best first. ' +
        'fallback set means meaning search was unavailable and only word matches came back. Then call session_get(node_id) for the full record.',
      inputSchema: {
        query: z.string().min(1).describe('What the session was about, in plain words.'),
        repo: z.string().min(1).optional().describe('Only sessions of this repository, e.g. "mcp-notes". Omit for every repository.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SESSIONS_SEARCH_MAX_LIMIT)
          .optional()
          .describe(`How many sessions, 1-${SESSIONS_SEARCH_MAX_LIMIT}. Default ${SESSIONS_SEARCH_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      const query = args.query.trim();
      if (query === '') return fail('query is empty: describe what the session was about.');
      try {
        const res = await searchNodes(rd, {
          query,
          repo: args.repo?.trim() || null,
          limit: args.limit ?? SESSIONS_SEARCH_DEFAULT_LIMIT,
        });
        return jsonResult({
          query: res.query,
          mode: res.mode,
          fallback: res.fallback,
          hits: res.hits.map((h) =>
            withUrl(rd, {
              node_id: h.node_id,
              repo: h.repo,
              title: h.title,
              started_at: h.started_at,
              last_active_at: h.last_active_at,
              host: h.host,
              available: h.available,
              live: h.live,
              status: h.status,
              parent_node_id: h.parent_node_id,
              summary: h.summary_excerpt,
              score: h.score,
            }),
          ),
          next:
            res.hits.length > 0
              ? 'Call session_get with a node_id for its summary, prompts, commits, plan docs and children; link node ids with their url.'
              : 'No session matched. Try other words, drop repo, or ask which repository it was in.',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_get',
    {
      title: 'Get a Claude Code session',
      description:
        'One Claude Code session by node id (like A0-3G): { session: { node_id, session_id, repo, title, name, branch, cwd, started_at, last_active_at, host, available, live, status, tokens, cost_usd, summary, first_prompt, last_prompt, final_message, transcript_path, url, ... }, ' +
        'prompts, commits, files_edited, plan_docs, notes (notes saved from that session), parent, children (sessions it spawned) }. available: false means it ran on the other machine (host).',
      inputSchema: { node_id: nodeIdField },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      const nodeId = normalizeNodeId(args.node_id);
      if (nodeId === null) return badNodeId(args.node_id);
      try {
        const detail = await sessionDetail(rd, nodeId);
        if (detail === null) return notFound(nodeId);
        return jsonResult({
          ...detail,
          session: withUrl(rd, detail.session),
          parent: detail.parent === null ? null : withUrl(rd, detail.parent),
          children: detail.children.map((c: NodeRef) => withUrl(rd, c)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_transcript',
    {
      title: 'Search a session transcript',
      description:
        "Search one Claude Code session's own transcript for words and get the matching messages: { node_id, session_id, query, transcript_path, matches: [{ line, at, role, excerpt }], total_matches, truncated }. " +
        'Every word must appear; "quoted phrases" stay together. Without query, the last messages come back. Works only on the machine that ran the session; elsewhere it answers not_on_this_machine (use session_get there).',
      inputSchema: {
        node_id: nodeIdField,
        query: z.string().optional().describe('Words to find in the transcript. Omit for the last messages.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TRANSCRIPT_MAX_LIMIT)
          .optional()
          .describe(`How many matching messages (the most recent ones), 1-${TRANSCRIPT_MAX_LIMIT}. Default ${TRANSCRIPT_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      const nodeId = normalizeNodeId(args.node_id);
      if (nodeId === null) return badNodeId(args.node_id);
      try {
        const out = await readTranscript(rd, nodeId, { query: args.query ?? null, limit: args.limit ?? TRANSCRIPT_DEFAULT_LIMIT });
        if (out.ok) return jsonResult(out.payload);
        switch (out.error) {
          case 'not_found':
            return notFound(nodeId);
          case 'not_on_this_machine':
            return fail(
              `not_on_this_machine: session ${out.node_id} ran on ${out.host}; its transcript is only on that machine, so it cannot be searched from here. session_get still returns its summary, prompts and commits.`,
            );
          case 'transcript_missing':
            return fail(
              `transcript_missing: the transcript of ${out.node_id} is no longer on disk (Claude Code prunes old transcripts). session_get still returns what was recorded.`,
            );
        }
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'sessions_usage',
    {
      title: 'Claude Code token usage',
      description:
        'Token and cost totals of Claude Code sessions. by "month" (default): one row per month { month, sessions, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd }, newest first. ' +
        'by "node": the sessions that used the most tokens, with node_id, title and url. Optional repo and month (YYYY-MM, in the daemon timezone) filter both; totals covers every matching session.',
      inputSchema: {
        by: z.enum(['month', 'node']).optional().describe('"month" (default) or "node".'),
        repo: z.string().min(1).optional().describe('Only this repository, e.g. "mcp-notes".'),
        month: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional()
          .describe('Only sessions started in this month, YYYY-MM.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SESSIONS_USAGE_MAX_LIMIT)
          .optional()
          .describe(`by "node": how many sessions, 1-${SESSIONS_USAGE_MAX_LIMIT}. Default ${SESSIONS_USAGE_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args): Promise<CallToolResult> => {
      if (rd === undefined) return fail(SESSIONS_OFF);
      try {
        const res = await usage(rd, {
          by: args.by ?? 'month',
          repo: args.repo?.trim() || null,
          month: args.month ?? null,
          limit: args.limit ?? SESSIONS_USAGE_DEFAULT_LIMIT,
        });
        if (res.by === 'node') return jsonResult({ ...res, rows: res.rows.map((r) => withUrl(rd, r)) });
        return jsonResult(res);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
```
**Impact:** New file. Phase 9 adds `session_resume` to this file (its own `server.registerTool` call appended at the end of `registerSessionTools`, or a separate exported register function called from `server.ts`).

### Step 7: Register the tools
**File:** `src/mcp/server.ts:1-23`
**Change:** Import and call `registerSessionTools` after `registerSimilarTools`.
**Code:** replace lines 1-23 (imports through `createMcpServer`) with:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { defaultConnectors, registerConnectorTools } from '../connectors/register.js';
import { registerImageTools } from './imageTools.js';
import { buildInstructions } from './instructions.js';
import { registerSessionTools } from './sessionTools.js';
import { registerSimilarTools } from './similarTools.js';
import { registerNoteTools, type ToolDeps } from './tools.js';

export const SERVER_NAME = 'mcp-notes';
export const SERVER_VERSION = '0.1.0';

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(undefined, deps.wallUrl) },
  );
  registerNoteTools(server, deps);
  registerImageTools(server, deps);
  registerSimilarTools(server, deps);
  // Iteration 8: read-only Claude Code session tools. Answer SESSIONS_OFF when deps.sessions is unset.
  registerSessionTools(server, deps);
  // Lazy: nothing is read or connected until a connector tool is called.
  registerConnectorTools(server, deps.connectors ?? defaultConnectors());
  return server;
}
```
(`handleMcpRequest` below is unchanged.)
**Impact:** Four more tools in `tools/list`.

### Step 8: Wire routes and tool deps in the app
**File:** `src/http/app.ts:1-88` (as it stands after phase 5)
**Change:** `CreateAppOptions.sessions`, `mcpToolDeps(deps, sessions?)` always sets `sessions`, mount `sessionsApiRoutes` directly after phase 5's `sessionHookRoutes` and before `staticRoutes`.
**Code:** full file after this phase (the `sessionHookRoutes` import and mount line are phase 5's; keep phase 5's exact spelling if it differs):
```ts
import { Hono, type MiddlewareHandler } from 'hono';
import type { ChatBackend } from '../chat/backend.js';
import type { AppDeps } from '../deps.js';
import { dbChatUploadSource } from '../embeddings/chatUploads.js';
import { wallUrlForPort } from '../mcp/instructions.js';
import { handleMcpRequest } from '../mcp/server.js';
import type { ToolDeps } from '../mcp/tools.js';
import { sessionsReadDeps, type SessionsReadOverrides } from '../sessions/readModel.js';
import { apiRoutes } from './api.js';
import { chatHistoryRoutes } from './chatApi.js';
import { chatImageRoutes } from './chatImages.js';
import { fileRoutes } from './files.js';
import { captureRoutes } from './capture.js';
import { imageRoutes } from './images.js';
import { revealRoutes, type RevealDeps } from './reveal.js';
import { isLoopbackUrl } from './sameOrigin.js';
import { sessionHookRoutes } from './sessionHooks.js';
import { sessionsApiRoutes } from './sessionsApi.js';
import { staticRoutes } from './static.js';

/**
 * DNS-rebinding guard for /mcp. The request URL (built from the Host header by the node adapter)
 * must name loopback, and a browser Origin, when present, must be a loopback origin too.
 * Claude Code sends no Origin header.
 */
export const loopbackOnly: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url)) {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden host.' }, id: null }, 403);
  }
  const origin = c.req.header('origin');
  if (origin !== undefined && !isLoopbackUrl(origin)) {
    return c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin.' }, id: null }, 403);
  }
  await next();
};

export interface CreateAppOptions {
  /** The brain behind POST /api/chat. Omitted: apiRoutes' default (the stub). */
  chat?: ChatBackend;
  /** OS hooks behind /api/capabilities and the reveal route. Omitted: the real WSL detection and spawn. */
  reveal?: RevealDeps;
  /** Session read model seams (host, live registry, settings, search) for /api/projects*, /api/sessions/* and the MCP session tools. Omitted: the real ones. */
  sessions?: SessionsReadOverrides;
}

/**
 * What POST /mcp hands the MCP server. `wallUrl` comes from `Config.port` (`NOTESD_PORT`), so the
 * instructions' Links paragraph names the port this daemon is configured for. Port 0 (tests: "any
 * free port", only known after listen) leaves it unset and the instructions fall back to 7317.
 * `sessions` is always set (building it does no I/O); `sessionOverrides` are test seams.
 */
export function mcpToolDeps(deps: AppDeps, sessionOverrides?: SessionsReadOverrides): ToolDeps {
  const wallUrl = wallUrlForPort(deps.config.port);
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    imageEmbedder: deps.imageEmbedder ?? null,
    chatUploads: dbChatUploadSource(deps.db, deps.config.dataDir),
    sessions: sessionsReadDeps(deps, sessionOverrides),
    ...(wallUrl !== undefined ? { wallUrl } : {}),
  };
}

/**
 * The whole HTTP surface, mounted in this order (later phases fill the routers, never this file):
 * /health, /mcp, apiRoutes (P6), chatHistoryRoutes (chat history phase 7), imageRoutes (P5),
 * chatImageRoutes (pasted chat images), fileRoutes (note files), revealRoutes (iteration 7:
 * capabilities + reveal; note files add file and note reveal), captureRoutes (Claude Code `/n`
 * capture, loopback + X-Notes-Capture only), sessionHookRoutes (iteration 8 phase 5: SessionStart
 * and spawn hooks), sessionsApiRoutes (iteration 8 phase 7: projects, session graph, detail,
 * transcript, context, search, usage), staticRoutes (P6, last: it owns the SPA fallback; it
 * reserves /api, so the order is for clarity).
 */
export function createApp(deps: AppDeps, options: CreateAppOptions = {}): Hono {
  const app = new Hono();
  const toolDeps = mcpToolDeps(deps, options.sessions);

  app.get('/health', (c) => c.json({ ok: true, service: 'notesd' }));

  app.use('/mcp', loopbackOnly);
  app.post('/mcp', (c) => handleMcpRequest(c.req.raw, toolDeps));
  // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, 405, { Allow: 'POST' }),
  );

  app.route('/', apiRoutes(deps, { chat: options.chat }));
  app.route('/', chatHistoryRoutes(deps));
  app.route('/', imageRoutes(deps));
  app.route('/', chatImageRoutes(deps));
  app.route('/', fileRoutes(deps));
  app.route('/', revealRoutes(deps, { reveal: options.reveal }));
  app.route('/', captureRoutes(deps));
  app.route('/', sessionHookRoutes(deps));
  app.route('/', sessionsApiRoutes(deps, options.sessions));
  app.route('/', staticRoutes(deps));
  return app;
}
```
**Impact:** `tests/unit/mcp.instructions.test.ts`'s minimal `appDeps` (`config: { port, dataDir }`, `db: {}`) still works: `sessionsReadDeps` only reads `config.sessions?.claudeHome`, `config.port`, `embedder`, and constructs closures (the `SessionsRepo` is created lazily). Phase 9 adds its resume router line after `sessionsApiRoutes`.

### Step 9: Chat allowlist and captions
**File:** `src/chat/status.ts` (whole file)
**Change:** `SESSION_TOOL_NAMES`; `allowedChatTools()` includes them between notes and connector tools; captions.
**Code:**
```ts
import {
  ALL_CONNECTOR_TOOL_NAMES,
  CONNECTOR_SYSTEMS,
  CONNECTOR_TOOL_NAMES,
  SYSTEM_META,
  type SystemId,
} from '../connectors/names.js';

/**
 * The chat agent's tool surface and the terse captions the answer panel shows while a tool runs.
 * Notes tool names match src/mcp/tools.ts and src/mcp/imageTools.ts; session tool names match
 * src/mcp/sessionTools.ts; connector tool names come from src/connectors/names.ts. Claude Code
 * exposes all of them as `mcp__notes__<name>` because the daemon registers its one MCP server
 * under the name `notes`.
 */
export const NOTES_MCP_SERVER = 'notes';

export const NOTES_TOOL_NAMES = [
  'create',
  'get',
  'update',
  'append',
  'delete',
  'restore',
  'list',
  'search',
  'tags',
  'related',
  'revisions',
  'revert',
  'create_image',
  'view_images',
  'attach_image',
  'remove_image',
  'restore_image',
  'move_image',
  'similar_images',
] as const;

export type NotesToolName = (typeof NOTES_TOOL_NAMES)[number];

/** Read-only Claude Code session tools (PROJECT_SESSION_GRAPH_PLAN phase 7; phase 9 appends session_resume). */
export const SESSION_TOOL_NAMES = ['sessions_search', 'session_get', 'session_transcript', 'sessions_usage'] as const;

export type SessionToolName = (typeof SESSION_TOOL_NAMES)[number];

export const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch'] as const;

/** Status-line caption for every tool of one read-only system ('reading expenses' / 'reading runs' / 'reading seer'). */
export const CONNECTOR_CAPTIONS = Object.fromEntries(
  CONNECTOR_SYSTEMS.map((id) => [id, SYSTEM_META[id].caption]),
) as Record<SystemId, string>;

const MCP_PREFIX = `mcp__${NOTES_MCP_SERVER}__`;

/**
 * Exactly the 19 notes tools, the 4 session tools, the 15 connector tools and WebSearch +
 * WebFetch (CONNECTORS_PLAN invariant 8, which supersedes CHAT_BAR_BRAIN_PLAN invariant 4;
 * SEMANTIC_SEARCH_PLAN phase 5 adds `related`; WALL_EDITING_PLAN phase 3 adds
 * `attach_image`, `remove_image` and `restore_image`; CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN
 * phase 6 adds `similar_images`; PROJECT_SESSION_GRAPH_PLAN phase 7 adds the session tools).
 */
export function allowedChatTools(): string[] {
  return [
    ...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...SESSION_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...ALL_CONNECTOR_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...WEB_TOOL_NAMES,
  ];
}

function idCount(input: unknown): number | null {
  if (typeof input !== 'object' || input === null) return null;
  const ids = (input as { ids?: unknown }).ids;
  return Array.isArray(ids) ? ids.length : null;
}

function counted(n: number | null, one: string, many: (n: number) => string, unknown: string): string {
  if (n === 1) return one;
  if (n !== null && n > 1) return many(n);
  return unknown;
}

/** The caption for a connector tool name (without the MCP prefix), or null if it is not one. */
function connectorCaption(tool: string): string | null {
  for (const system of CONNECTOR_SYSTEMS) {
    const names: readonly string[] = CONNECTOR_TOOL_NAMES[system];
    if (names.includes(tool)) return CONNECTOR_CAPTIONS[system];
  }
  return null;
}

/** True when a tool input carries a non-empty `image_id` string (a pasted chat image on create_image / attach_image). */
function hasImageId(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const imageId = (input as { image_id?: unknown }).image_id;
  return typeof imageId === 'string' && imageId.trim() !== '';
}

/**
 * The caption for one top-level `tool_use` block, or null for a tool the panel does not name.
 * `input` is the block's raw input; only `ids` (get, view_images) and `image_id` (create_image,
 * attach_image: a pasted chat image rather than a file path) are read.
 */
export function captionForToolUse(name: string, input: unknown): string | null {
  if (name === 'WebSearch') return 'searching the web';
  if (name === 'WebFetch') return 'reading a web page';
  if (!name.startsWith(MCP_PREFIX)) return null;
  const tool = name.slice(MCP_PREFIX.length);
  switch (tool) {
    case 'search':
    case 'list':
    case 'tags':
      return 'searching notes';
    case 'related':
      return 'finding related notes';
    case 'similar_images':
      return 'finding similar photos';
    case 'get':
      return counted(idCount(input), 'reading a note', (n) => `reading ${n} notes`, 'reading notes');
    case 'view_images':
      return counted(idCount(input), 'looking at a photo', (n) => `looking at ${n} photos`, 'looking at photos');
    case 'revisions':
      return 'reading history';
    case 'create':
      return 'saving a note';
    case 'create_image':
      return hasImageId(input) ? 'saving the pasted photo as a note' : 'saving a note';
    case 'update':
    case 'append':
    case 'revert':
      return 'editing a note';
    case 'delete':
      return 'deleting a note';
    case 'restore':
      return 'restoring a note';
    case 'attach_image':
      return hasImageId(input) ? 'attaching the pasted photo' : 'attaching a photo';
    case 'remove_image':
      return 'removing a photo';
    case 'restore_image':
      return 'restoring a photo';
    case 'move_image':
      return 'moving a photo to its own note';
    case 'sessions_search':
      return 'searching sessions';
    case 'session_get':
      return 'reading a session';
    case 'session_transcript':
      return 'reading a session transcript';
    case 'sessions_usage':
      return 'counting session tokens';
    default:
      return connectorCaption(tool);
  }
}
```
**Impact:** The chat brain (`src/chat/agent.ts:320`) now allows 40 tools. `tests/unit/chat-agent.test.ts:282` compares to `allowedChatTools()` and stays green.

### Step 10: MCP instructions paragraph
**File:** `src/mcp/instructions.ts:22-58`
**Change:** (a) Doc comment line 23-24 becomes: `MCP server instructions: Claude reads these once per session. Phase 5 appends one paragraph about image notes to \`sections\`. Iteration 5 phase 1 appends the connectors paragraph; iteration 8 phase 7 appends the sessions paragraph (last).` (b) Append this element to `sections`, after the `Connectors.` element at line 56 (so it becomes the last element):
**Code:**
```ts
    `Sessions. The same server records every Claude Code session the user has run on both laptops, grouped by repository, as nodes with ids like A0-3G (two characters from 0-9/A-Z, a dash, two more; the server assigns them, never invent one, and never confuse them with note ids like A-B32). sessions_search(query, repo?) finds sessions by meaning and words in their summaries, names, titles and prompts ("when did I work on photo delete in the wall?"). session_get(node_id) returns one session: its summary, prompts, commits, files edited, plan docs, the notes saved from it, tokens and cost, its parent and its children (the sessions it spawned). session_transcript(node_id, query) searches that session's own transcript and returns the matching messages, but only on the machine that ran it; elsewhere it answers not_on_this_machine, so use session_get. sessions_usage(by "month" or "node", repo?, month?) answers token and cost questions. available: false means the session ran on the other machine (host); live: true means it is running now on this machine. When you mention a session to the user, write its node id as a markdown link to the wall's project graph: [A0-3G](${wall}/projects?repo=REPO&node=A0-3G), with that session's repo for REPO; every session result carries this link as url, so use it as is. Links are for replies only, never for tool arguments.`,
```
**Impact:** Instructions gain a final paragraph; the existing order tests (`Links` after `Ids`, `Similar images` after `Files`) are untouched; the paragraph uses `${wall}`, so the "never mentions 7317" test with port 4321 stays green.

### Step 11: Unit tests — view
**File:** `tests/unit/sessions.view.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_NODE_MAX_CHARS,
  excerpt,
  formatContext,
  formatLocalTime,
  iso,
  nodeUrl,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  sessionTitle,
  toGraphNode,
  toSessionInfo,
  type DetailRow,
  type LiveEntry,
  type NodeRow,
} from '../../src/sessions/view.js';

function row(over: Partial<NodeRow> = {}): NodeRow {
  return {
    session_id: 'sess-1',
    node_id: 'A0-3G',
    host: 'lenovo',
    repo: 'mcp-notes',
    cwd: '/home/m/mcp-notes',
    branch: 'main',
    name: null,
    custom_title: null,
    ai_title: null,
    first_prompt: 'plan the session graph',
    started_at: new Date('2026-11-01T03:00:00Z'),
    last_active_at: '2026-11-01T05:30:00Z',
    input_tokens: '100',
    output_tokens: 200,
    cache_read_tokens: 1000,
    cache_write_tokens: null,
    cost_usd: '1.25',
    parent_session_id: null,
    parent_link_source: null,
    tmux: null,
    summary_head: null,
    parent_node_id: null,
    child_count: '2',
    ...over,
  };
}

function detail(over: Partial<DetailRow> = {}): DetailRow {
  return {
    ...row(),
    entrypoint: 'cli',
    version: '2.1.0',
    models: null,
    transcript_path: '/home/m/.claude/projects/x/sess-1.jsonl',
    first_prompt_full: 'plan the session graph',
    last_prompt: null,
    summary: null,
    summarized_at: null,
    final_message: null,
    prompts: [],
    commits: [],
    files_edited: [],
    plan_docs: [],
    ...over,
  };
}

const noLive = new Map<string, LiveEntry>();

describe('toGraphNode', () => {
  it('maps a local row: tokens summed from strings and nulls, cost parsed, unfinished null', () => {
    const n = toGraphNode(row(), { host: 'lenovo', live: noLive });
    expect(n.tokens).toEqual({ input: 100, output: 200, cache_read: 1000, cache_write: 0, total: 1300 });
    expect(n.cost_usd).toBe(1.25);
    expect(n.available).toBe(true);
    expect(n.live).toBe(false);
    expect(n.child_count).toBe(2);
    expect(n.unfinished).toBeNull();
    expect(n.started_at).toBe('2026-11-01T03:00:00.000Z');
    expect(n.last_active_at).toBe('2026-11-01T05:30:00.000Z');
    expect(n.title).toBe('plan the session graph');
  });

  it('marks live only for this host, and takes status and tmux from the registry', () => {
    const live = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'busy', tmux: 'note:@0.%7' }]]);
    const here = toGraphNode(row(), { host: 'lenovo', live });
    expect(here).toMatchObject({ live: true, status: 'busy', tmux: 'note:@0.%7', available: true });
    const there = toGraphNode(row({ host: 'gpd' }), { host: 'lenovo', live });
    expect(there).toMatchObject({ live: false, status: null, available: false });
  });

  it('keeps only known link sources', () => {
    expect(toGraphNode(row({ parent_link_source: 'env' }), { host: 'x', live: noLive }).parent_link_source).toBe('env');
    expect(toGraphNode(row({ parent_link_source: 'bogus' }), { host: 'x', live: noLive }).parent_link_source).toBeNull();
  });
});

describe('sessionTitle', () => {
  it('prefers custom title, then name, then ai title, then the first prompt, then the node id', () => {
    const base = { node_id: 'A0-3G', custom_title: null, name: null, ai_title: null, first_prompt: null };
    expect(sessionTitle({ ...base, custom_title: 'mine', name: 'impl-x-p1', ai_title: 'ai' })).toBe('mine');
    expect(sessionTitle({ ...base, name: 'impl-x-p1', ai_title: 'ai' })).toBe('impl-x-p1');
    expect(sessionTitle({ ...base, ai_title: 'ai' })).toBe('ai');
    expect(sessionTitle({ ...base, first_prompt: 'x'.repeat(200) })).toHaveLength(80);
    expect(sessionTitle(base)).toBe('A0-3G');
  });
});

describe('normalizers', () => {
  it('prompts: strings and objects, blanks dropped, timestamps normalised', () => {
    expect(normalizePrompts(['a', { text: 'b', timestamp: '2026-11-01T00:00:00Z' }, { prompt: '  ' }, 5, null])).toEqual([
      { text: 'a', at: null },
      { text: 'b', at: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(normalizePrompts('nope')).toEqual([]);
  });

  it('commits: "sha subject" strings and objects', () => {
    expect(normalizeCommits(['abc1234 feat: x', { hash: 'def5678', message: 'fix: y\n\nbody' }, 'not a sha'])).toEqual([
      { sha: 'abc1234', subject: 'feat: x' },
      { sha: 'def5678', subject: 'fix: y' },
      { sha: null, subject: 'not a sha' },
    ]);
  });

  it('paths: strings and {path}, deduped in order', () => {
    expect(normalizePaths(['a.md', { path: 'b.md' }, 'a.md', { file: 'c.md' }, 3])).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

describe('helpers', () => {
  it('excerpt collapses whitespace and cuts with an ellipsis', () => {
    expect(excerpt('  a \n b  ', 10)).toBe('a b');
    expect(excerpt('abcdef', 4)).toBe('abc…');
    expect(excerpt('   ', 4)).toBeNull();
  });

  it('iso accepts dates and strings, rejects junk', () => {
    expect(iso(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(iso('nope')).toBeNull();
    expect(iso(null)).toBeNull();
  });

  it('nodeUrl encodes the repo and needs one', () => {
    expect(nodeUrl('http://localhost:7317/', 'my repo', 'A0-3G')).toBe('http://localhost:7317/projects?repo=my%20repo&node=A0-3G');
    expect(nodeUrl('http://localhost:7317', null, 'A0-3G')).toBeNull();
  });

  it('formatLocalTime renders in the given zone', () => {
    expect(formatLocalTime('2026-10-31T18:00:00Z', 'Asia/Jakarta')).toBe('2026-11-01 01:00');
  });
});

describe('formatContext', () => {
  const opts = { timeZone: 'Asia/Jakarta', wallUrl: 'http://localhost:7317' };

  it('names the node, parent, children, summary, plan docs, commits, transcript and wall link', () => {
    const session = toSessionInfo(
      detail({ summary: 'Built the graph.', parent_node_id: 'B1-22', parent_link_source: 'env' }),
      { host: 'lenovo', live: noLive },
    );
    const text = formatContext(
      {
        session,
        commits: [{ sha: 'abc1234def', subject: 'feat: graph' }],
        plan_docs: ['docs/plans/X.md'],
        children_node_ids: ['C2-33'],
      },
      opts,
    );
    expect(text).toContain('Session A0-3G "plan the session graph" (repo mcp-notes, branch main, host lenovo; 2026-11-01 10:00 to 2026-11-01 12:30 Asia/Jakarta)');
    expect(text).toContain('Parent: B1-22 (env link)');
    expect(text).toContain('Children: C2-33');
    expect(text).toContain('Summary: Built the graph.');
    expect(text).toContain('Plan docs: docs/plans/X.md');
    expect(text).toContain('Commits: abc1234 feat: graph');
    expect(text).toContain('Transcript: /home/m/.claude/projects/x/sess-1.jsonl (resume with: claude --resume sess-1)');
    expect(text).toContain('Wall: http://localhost:7317/projects?repo=mcp-notes&node=A0-3G');
  });

  it('says where the transcript is for another host, and falls back to the first prompt without a summary', () => {
    const session = toSessionInfo(detail({ host: 'gpd' }), { host: 'lenovo', live: noLive });
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text).toContain('Transcript: on gpd, not readable from this machine.');
    expect(text).toContain('Summary: not summarized yet. First prompt: plan the session graph');
    expect(text).not.toContain('Commits:');
  });

  it('is bounded', () => {
    const session = toSessionInfo(detail({ summary: 'x'.repeat(10_000) }), { host: 'lenovo', live: noLive });
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text.length).toBeLessThanOrEqual(CONTEXT_NODE_MAX_CHARS);
  });
});
```

### Step 12: Unit tests — transcript search
**File:** `tests/unit/sessions.transcriptSearch.test.ts` (new)
**Code:**
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { excerptAround, messageText, queryTerms, searchTranscript } from '../../src/sessions/transcriptSearch.js';

let dir: string;
let file: string;

const lines = [
  { type: 'user', timestamp: '2026-11-01T01:00:00Z', message: { role: 'user', content: 'Plan the wall photo delete flow' } },
  { type: 'assistant', timestamp: '2026-11-01T01:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Photo delete goes to the recycle bin.' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  { type: 'user', timestamp: '2026-11-01T01:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'photo delete in tool output' }] } },
  { type: 'user', isMeta: true, timestamp: '2026-11-01T01:03:00Z', message: { role: 'user', content: 'photo delete meta' } },
  { type: 'custom-title', customTitle: 'x', sessionId: 's' },
  { type: 'assistant', timestamp: '2026-11-01T01:04:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: the photo is in the bin.' }] } },
];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'transcript-search-'));
  file = path.join(dir, 's.jsonl');
  // The last line is partial (Claude Code mid-write): it must be skipped, not fail the scan.
  await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"type":"user","message":{"content":"photo del`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('messageText', () => {
  it('takes user/assistant text only', () => {
    expect(messageText(lines[0])).toEqual({ role: 'user', text: 'Plan the wall photo delete flow', at: '2026-11-01T01:00:00.000Z' });
    expect(messageText(lines[1])?.text).toBe('Photo delete goes to the recycle bin.');
    expect(messageText(lines[2])).toBeNull();
    expect(messageText(lines[3])).toBeNull();
    expect(messageText(lines[4])).toBeNull();
  });
});

describe('queryTerms', () => {
  it('lower-cases, keeps quoted phrases whole, dedupes', () => {
    expect(queryTerms('Photo "recycle bin" photo')).toEqual(['photo', 'recycle bin']);
    expect(queryTerms(null)).toEqual([]);
  });
});

describe('excerptAround', () => {
  it('centres on the first hit with ellipses', () => {
    const text = `${'a '.repeat(500)}needle ${'b '.repeat(500)}`;
    const ex = excerptAround(text, ['needle'], 100);
    expect(ex).toContain('needle');
    expect(ex.startsWith('…')).toBe(true);
    expect(ex.endsWith('…')).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(102);
  });
});

describe('searchTranscript', () => {
  it('matches every term, skips tool results, meta and the partial line', async () => {
    const r = await searchTranscript(file, { query: 'photo delete', limit: 10 });
    expect(r.matches.map((m) => m.line)).toEqual([1, 2]);
    expect(r.total_matches).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('keeps the last N matches', async () => {
    const r = await searchTranscript(file, { query: 'photo', limit: 1 });
    expect(r.matches.map((m) => m.line)).toEqual([6]);
    expect(r.total_matches).toBe(3);
    expect(r.truncated).toBe(true);
  });

  it('without a query returns the tail', async () => {
    const r = await searchTranscript(file, { query: null, limit: 2 });
    expect(r.matches.map((m) => m.role)).toEqual(['assistant', 'assistant']);
    expect(r.total_matches).toBe(3);
  });

  it('stops at the scan cap', async () => {
    const r = await searchTranscript(file, { query: 'photo', limit: 10, maxScanBytes: 200 });
    expect(r.truncated).toBe(true);
    expect(r.scanned_bytes).toBeLessThanOrEqual(200);
  });

  it('throws ENOENT for a missing file', async () => {
    await expect(searchTranscript(path.join(dir, 'gone.jsonl'), { query: null, limit: 5 })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
```

### Step 13: Unit tests — chat status and instructions
**File:** `tests/unit/chat-status.test.ts:3`, `:8-25`, and the first `it.each` table (`:33-66`)
**Change:** import `SESSION_TOOL_NAMES`; replace the first `it(...)` in `describe('allowedChatTools')` (lines 8-25) with:
```ts
  it('is exactly the 19 notes tools, the 4 session tools, the 15 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(19);
    expect(SESSION_TOOL_NAMES).toHaveLength(4);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(15);
    expect(tools).toHaveLength(19 + 4 + 15 + 2);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toContain('mcp__notes__view_images');
    expect(tools).toContain('mcp__notes__create_image');
    expect(tools).toContain('mcp__notes__related');
    expect(tools).toContain('mcp__notes__attach_image');
    expect(tools).toContain('mcp__notes__remove_image');
    expect(tools).toContain('mcp__notes__restore_image');
    expect(tools).toContain('mcp__notes__similar_images');
    for (const name of SESSION_TOOL_NAMES) expect(tools).toContain(n(name));
    for (const name of ALL_CONNECTOR_TOOL_NAMES) expect(tools).toContain(n(name));
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools.filter((t) => !t.startsWith('mcp__notes__'))).toEqual(['WebSearch', 'WebFetch']);
  });
```
with line 3 becoming `import { NOTES_TOOL_NAMES, SESSION_TOOL_NAMES, allowedChatTools, captionForToolUse } from '../../src/chat/status.js';`, and add these rows to the first caption table, before the `['WebSearch', ...]` row:
```ts
    [n('sessions_search'), { query: 'wall' }, 'searching sessions'],
    [n('session_get'), { node_id: 'A0-3G' }, 'reading a session'],
    [n('session_transcript'), { node_id: 'A0-3G', query: 'x' }, 'reading a session transcript'],
    [n('sessions_usage'), { by: 'month' }, 'counting session tokens'],
```
**File:** `tests/unit/mcp.instructions.test.ts` — append inside `describe('buildInstructions', ...)` (after the Similar images test, before its closing `});` at line 122):
```ts
  it('ends with one Sessions paragraph: the four tools, node ids vs note ids, the wall link form', () => {
    const text = buildInstructions('Asia/Jakarta');
    const paragraphs = text.split('\n\n').filter((p) => p.startsWith('Sessions.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['sessions_search', 'session_get', 'session_transcript', 'sessions_usage', 'not_on_this_machine', 'A0-3G', 'A-B32']) {
      expect(p).toContain(word);
    }
    expect(p).toContain('[A0-3G](http://localhost:7317/projects?repo=REPO&node=A0-3G)');
    const order = text.split('\n\n').map((s) => s.split('.')[0]);
    expect(order.at(-1)).toBe('Sessions');
    expect(buildInstructions('Asia/Jakarta', 'http://localhost:4321')).toContain('[A0-3G](http://localhost:4321/projects?repo=REPO&node=A0-3G)');
  });
```

### Step 14: Integration fixture helper
**File:** `tests/integration/helpers/sessionsSeed.ts` (new)
**Change:** Raw-SQL fixture rows (tests only; the same approach `api-harness.ts` uses for image notes), independent of phase 1's TypeScript API.
**Code:**
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../../../src/db/client.js';

export const THIS_HOST = 'this-host-test';
export const OTHER_HOST = 'gpd-test';

export interface SeedSession {
  sessionId: string;
  nodeId: string;
  host?: string;
  repo?: string | null;
  cwd?: string | null;
  branch?: string | null;
  name?: string | null;
  customTitle?: string | null;
  aiTitle?: string | null;
  firstPrompt?: string | null;
  startedAt?: string | null;
  lastActiveAt?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number | null;
  parentSessionId?: string | null;
  parentLinkSource?: 'env' | 'hook' | 'heuristic' | null;
  transcriptPath?: string | null;
  prompts?: unknown;
  commits?: unknown;
  filesEdited?: unknown;
  planDocs?: unknown;
  finalMessage?: string | null;
  summary?: string | null;
}

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

export async function clearSessions(db: Db): Promise<void> {
  await db.execute(sql`delete from cc_sessions`);
  await db.execute(sql`delete from app_settings where key = 'projects.selected'`);
}

export async function seedSession(db: Db, s: SeedSession): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (
      session_id, node_id, host, repo, cwd, branch, name, custom_title, ai_title, first_prompt,
      entrypoint, started_at, last_active_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
      parent_session_id, parent_link_source, transcript_path,
      prompts, commits, files_edited, plan_docs, final_message, summary
    ) values (
      ${s.sessionId}, ${s.nodeId}, ${s.host ?? THIS_HOST}, ${s.repo === undefined ? 'mcp-notes' : s.repo},
      ${s.cwd ?? null}, ${s.branch ?? null}, ${s.name ?? null}, ${s.customTitle ?? null}, ${s.aiTitle ?? null},
      ${s.firstPrompt ?? null}, 'cli',
      ${s.startedAt ?? null}::timestamptz, ${s.lastActiveAt ?? null}::timestamptz,
      ${s.inputTokens ?? 0}, ${s.outputTokens ?? 0}, ${s.cacheReadTokens ?? 0}, ${s.cacheWriteTokens ?? 0}, ${s.costUsd ?? null},
      ${s.parentSessionId ?? null}, ${s.parentLinkSource ?? null}, ${s.transcriptPath ?? null},
      ${json(s.prompts)}::jsonb, ${json(s.commits)}::jsonb, ${json(s.filesEdited)}::jsonb, ${json(s.planDocs)}::jsonb,
      ${s.finalMessage ?? null}, ${s.summary ?? null}
    )`);
}

/** A small transcript JSONL in a temp dir; `cleanup` removes it. */
export async function writeTranscript(): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cc-transcript-'));
  const file = path.join(dir, 'sess-root.jsonl');
  const records = [
    { type: 'user', timestamp: '2026-10-31T18:00:00Z', message: { role: 'user', content: 'Plan the wall photo delete flow' } },
    { type: 'assistant', timestamp: '2026-10-31T18:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Photo delete goes to the recycle bin.' }] } },
    { type: 'assistant', timestamp: '2026-10-31T18:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Unrelated closing words.' }] } },
  ];
  await writeFile(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * The fixture graph used by the sessions API and MCP tests:
 *   A0-3G sess-root  mcp-notes  this host   2026-10-31 18:00Z (2026-11-01 01:00 WIB), summary, plan doc, commit, transcript
 *   B1-22 sess-b1    mcp-notes  this host   child of root (env), name impl-wall-p1, LIVE in the fake registry
 *   C2-33 sess-c2    mcp-notes  other host  child of root (heuristic)
 *   D4-44 sess-d4    seer       this host   2026-09-15, the biggest token user
 */
export async function seedGraph(db: Db, transcriptPath: string): Promise<void> {
  await seedSession(db, {
    sessionId: 'sess-root',
    nodeId: 'A0-3G',
    branch: 'main',
    firstPrompt: 'Plan the wall photo delete flow',
    startedAt: '2026-10-31T18:00:00Z',
    lastActiveAt: '2026-10-31T20:00:00Z',
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 1000,
    cacheWriteTokens: 50,
    costUsd: 1.25,
    transcriptPath,
    prompts: [{ text: 'Plan the wall photo delete flow', at: '2026-10-31T18:00:00Z' }],
    commits: [{ sha: 'abc1234def', subject: 'feat(web): photo delete' }],
    filesEdited: ['web/src/components/NoteEditor.tsx'],
    planDocs: ['docs/plans/WALL_EDITING_PLAN.md'],
    finalMessage: 'Done.',
    summary: 'Planned the wall editing photo delete flow and wrote the plan.',
  });
  await seedSession(db, {
    sessionId: 'sess-b1',
    nodeId: 'B1-22',
    name: 'impl-wall-p1',
    startedAt: '2026-11-01T01:00:00Z',
    lastActiveAt: '2026-11-01T02:00:00Z',
    inputTokens: 10,
    outputTokens: 20,
    parentSessionId: 'sess-root',
    parentLinkSource: 'env',
  });
  await seedSession(db, {
    sessionId: 'sess-c2',
    nodeId: 'C2-33',
    host: OTHER_HOST,
    name: 'impl-wall-p2',
    startedAt: '2026-11-01T02:00:00Z',
    lastActiveAt: '2026-11-01T03:00:00Z',
    parentSessionId: 'sess-root',
    parentLinkSource: 'heuristic',
    transcriptPath: '/home/gpd/.claude/projects/x/sess-c2.jsonl',
  });
  await seedSession(db, {
    sessionId: 'sess-d4',
    nodeId: 'D4-44',
    repo: 'seer',
    customTitle: 'seer leaderboard',
    startedAt: '2026-09-15T00:00:00Z',
    lastActiveAt: '2026-09-15T01:00:00Z',
    inputTokens: 5000,
    outputTokens: 5000,
    cacheReadTokens: 90000,
    costUsd: 9.5,
  });
}
```

### Step 15: Integration tests — HTTP
**File:** `tests/integration/sessions.api.int.test.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/http/app.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import type { SessionsReadOverrides } from '../../src/sessions/readModel.js';
import type {
  ContextPayload,
  GraphPayload,
  ProjectsPayload,
  SearchPayload,
  SessionDetail,
  TranscriptPayload,
  UsagePayload,
} from '../../src/sessions/view.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import { clearSessions, OTHER_HOST, seedGraph, seedSession, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  // sess-c2 is "live" in the registry but on the other host: it must not show as live.
  live: async () => [
    { sessionId: 'sess-b1', status: 'busy', tmux: 'note:@0.%7' },
    { sessionId: 'sess-c2', status: 'busy', tmux: null },
  ],
};

let h: ApiHarness;
let app: Hono;
let transcript: { file: string; cleanup: () => Promise<void> };

async function get<T>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T; res: Response }> {
  const res = await app.request(pathname, init);
  const text = await res.text();
  return { status: res.status, body: (text === '' ? null : JSON.parse(text)) as T, res };
}

beforeAll(async () => {
  h = await createApiHarness();
  app = new Hono();
  app.route('/', sessionsApiRoutes(h.deps, overrides));
  transcript = await writeTranscript();
});

afterAll(async () => {
  await clearSessions(h.deps.db);
  await transcript.cleanup();
  await h.close();
});

beforeEach(async () => {
  await clearSessions(h.deps.db);
  await seedGraph(h.deps.db, transcript.file);
});

describe('GET /api/projects', () => {
  it('lists repos most recently active first with counts, live count and hosts', async () => {
    const { status, body } = await get<ProjectsPayload>('/api/projects');
    expect(status).toBe(200);
    expect(body.host).toBe(THIS_HOST);
    expect(body.selected).toBeNull();
    expect(body.projects.map((p) => p.repo)).toEqual(['mcp-notes', 'seer']);
    expect(body.projects[0]).toMatchObject({
      sessions: 3,
      live: 1,
      hosts: [OTHER_HOST, THIS_HOST].sort(),
      last_active_at: '2026-11-01T03:00:00.000Z',
      first_started_at: '2026-10-31T18:00:00.000Z',
    });
  });

  it('is mounted by createApp', async () => {
    const full = createApp(h.deps, { sessions: overrides });
    const res = await full.request('/api/projects');
    expect(res.status).toBe(200);
    expect(((await res.json()) as ProjectsPayload).projects).toHaveLength(2);
  });
});

describe('selected project', () => {
  const put = (repo: string | null, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> =>
    Promise.resolve(
      app.request('/api/projects/selected', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ repo }),
      }),
    );

  it('round-trips through app_settings, same-origin only, known repos only', async () => {
    expect((await get<{ repo: string | null }>('/api/projects/selected')).body).toEqual({ repo: null });

    const noOrigin = await put('mcp-notes', {});
    expect(noOrigin.status).toBe(403);
    expect(await noOrigin.json()).toEqual({ error: 'forbidden_origin' });

    const ok = await put('mcp-notes');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ repo: 'mcp-notes' });
    expect((await get<{ repo: string | null }>('/api/projects/selected')).body).toEqual({ repo: 'mcp-notes' });
    expect((await get<ProjectsPayload>('/api/projects')).body.selected).toBe('mcp-notes');

    const unknown = await put('no-such-repo');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown_repo', repo: 'no-such-repo' });

    expect((await put(null)).status).toBe(200);
    expect((await get<{ repo: string | null }>('/api/projects/selected')).body).toEqual({ repo: null });
  });

  it('400 on a bad body', async () => {
    const res = await app.request('/api/projects/selected', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...SAME_ORIGIN },
      body: JSON.stringify({ repo: 42 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects/:repo/sessions', () => {
  it('returns every node newest first with parent node ids, availability, liveness and a reserved unfinished', async () => {
    const { status, body, res } = await get<GraphPayload>('/api/projects/mcp-notes/sessions');
    expect(status).toBe(200);
    expect(res.headers.get('etag')).toMatch(/^W\/"[0-9a-f]{40}"$/);
    expect(body).toMatchObject({ repo: 'mcp-notes', host: THIS_HOST, total: 3, truncated: false, next_before: null });
    expect(body.nodes.map((n) => n.node_id)).toEqual(['C2-33', 'B1-22', 'A0-3G']);
    const [c2, b1, root] = body.nodes;
    expect(c2).toMatchObject({ parent_node_id: 'A0-3G', parent_link_source: 'heuristic', available: false, live: false, host: OTHER_HOST });
    expect(b1).toMatchObject({ parent_node_id: 'A0-3G', parent_link_source: 'env', available: true, live: true, status: 'busy', tmux: 'note:@0.%7', title: 'impl-wall-p1' });
    expect(root).toMatchObject({
      parent_node_id: null,
      child_count: 2,
      cost_usd: 1.25,
      tokens: { input: 100, output: 200, cache_read: 1000, cache_write: 50, total: 1350 },
      unfinished: null,
    });
    expect(root!.summary_excerpt).toContain('photo delete');
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const first = await app.request('/api/projects/mcp-notes/sessions');
    const etag = first.headers.get('etag')!;
    const again = await app.request('/api/projects/mcp-notes/sessions', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('pages with limit and before', async () => {
    const page1 = await get<GraphPayload>('/api/projects/mcp-notes/sessions?limit=2');
    expect(page1.body.nodes.map((n) => n.node_id)).toEqual(['C2-33', 'B1-22']);
    expect(page1.body.truncated).toBe(true);
    expect(page1.body.next_before).toBe('2026-11-01T01:00:00.000Z');
    const page2 = await get<GraphPayload>(`/api/projects/mcp-notes/sessions?limit=2&before=${encodeURIComponent(page1.body.next_before!)}`);
    expect(page2.body.nodes.map((n) => n.node_id)).toEqual(['A0-3G']);
    expect(page2.body.truncated).toBe(false);
  });

  it('404 for an unknown repo, 400 for a bad limit', async () => {
    expect((await get('/api/projects/nope/sessions')).status).toBe(404);
    expect((await get('/api/projects/mcp-notes/sessions?limit=0')).status).toBe(400);
    expect((await get('/api/projects/mcp-notes/sessions?before=yesterday')).status).toBe(400);
  });

  it('serves a 1000-node repo in one page', async () => {
    for (let i = 0; i < 1000; i++) {
      const a = (i % 36).toString(36).toUpperCase();
      const b = Math.floor(i / 36).toString(36).toUpperCase().padStart(2, '0');
      await seedSession(h.deps.db, {
        sessionId: `bulk-${i}`,
        nodeId: `Z${a}-${b}`,
        repo: 'bulk',
        startedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      });
    }
    const { status, body } = await get<GraphPayload>('/api/projects/bulk/sessions');
    expect(status).toBe(200);
    expect(body.total).toBe(1000);
    expect(body.nodes).toHaveLength(1000);
    expect(body.truncated).toBe(false);
  });
});

describe('GET /api/sessions/:nodeId', () => {
  it('returns the full detail, case-insensitive and dash-tolerant, with notes made in the session', async () => {
    const note = await h.notes.create({ body: 'insight from the wall session #psgtest', origin: { claude_session: 'sess-root' } });
    const { status, body } = await get<SessionDetail>('/api/sessions/a03g');
    expect(status).toBe(200);
    expect(body.session).toMatchObject({
      node_id: 'A0-3G',
      session_id: 'sess-root',
      summary: 'Planned the wall editing photo delete flow and wrote the plan.',
      transcript_path: transcript.file,
      entrypoint: 'cli',
      final_message: 'Done.',
    });
    expect(body.prompts).toEqual([{ text: 'Plan the wall photo delete flow', at: '2026-10-31T18:00:00.000Z' }]);
    expect(body.commits).toEqual([{ sha: 'abc1234def', subject: 'feat(web): photo delete' }]);
    expect(body.files_edited).toEqual(['web/src/components/NoteEditor.tsx']);
    expect(body.plan_docs).toEqual(['docs/plans/WALL_EDITING_PLAN.md']);
    expect(body.notes.map((n) => n.id)).toEqual([note.id]);
    expect(body.parent).toBeNull();
    expect(body.children.map((c) => c.node_id)).toEqual(['B1-22', 'C2-33']);
    expect(body.children[0]).toMatchObject({ live: true, parent_link_source: 'env' });
  });

  it('a child names its parent', async () => {
    const { body } = await get<SessionDetail>('/api/sessions/B1-22');
    expect(body.parent).toMatchObject({ node_id: 'A0-3G', session_id: 'sess-root' });
    expect(body.notes).toEqual([]);
  });

  it('400 invalid_node_id, 404 not_found', async () => {
    expect((await get<{ error: string }>('/api/sessions/A-B32')).body).toEqual({ error: 'invalid_node_id' });
    const missing = await get<{ error: string }>('/api/sessions/ZZ-ZZ');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });
});

describe('GET /api/sessions/:nodeId/transcript', () => {
  it('searches the transcript on the owning host', async () => {
    const { status, body } = await get<TranscriptPayload>('/api/sessions/A0-3G/transcript?query=photo%20delete');
    expect(status).toBe(200);
    expect(body).toMatchObject({ node_id: 'A0-3G', query: 'photo delete', transcript_path: transcript.file, total_matches: 2, truncated: false });
    expect(body.matches.map((m) => m.line)).toEqual([1, 2]);
  });

  it('without a query returns the last messages', async () => {
    const { body } = await get<TranscriptPayload>('/api/sessions/A0-3G/transcript?limit=1');
    expect(body.query).toBeNull();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]!.excerpt).toBe('Unrelated closing words.');
  });

  it('404 not_on_this_machine for another host, transcript_missing when the file is gone or unrecorded', async () => {
    const remote = await get<{ error: string; host: string }>('/api/sessions/C2-33/transcript?query=x');
    expect(remote.status).toBe(404);
    expect(remote.body).toEqual({ error: 'not_on_this_machine', node_id: 'C2-33', host: OTHER_HOST });

    const unrecorded = await get<{ error: string }>('/api/sessions/B1-22/transcript');
    expect(unrecorded.status).toBe(404);
    expect(unrecorded.body).toEqual({ error: 'transcript_missing', node_id: 'B1-22' });

    await seedSession(h.deps.db, { sessionId: 'sess-gone', nodeId: 'E5-55', transcriptPath: '/nonexistent/sess-gone.jsonl', startedAt: '2026-10-01T00:00:00Z' });
    expect((await get<{ error: string }>('/api/sessions/E5-55/transcript')).body).toEqual({ error: 'transcript_missing', node_id: 'E5-55' });
  });
});

describe('GET /api/sessions/context', () => {
  it('returns context only for ids that exist, in request order', async () => {
    // 'bad!' is not a node id at all (note: a bare 4-letter word like "nope" IS one, NO-PE, and would be looked up).
    const { status, body } = await get<ContextPayload>('/api/sessions/context?ids=a03g,ZZ-ZZ,%20bad!,B1-22,A0-3G');
    expect(status).toBe(200);
    expect(body.nodes.map((n) => n.node_id)).toEqual(['A0-3G', 'B1-22']);
    // Invalid inputs first (as given), then well-formed ids that do not exist (canonical).
    expect(body.missing).toEqual(['bad!', 'ZZ-ZZ']);
    const root = body.nodes[0]!.text;
    expect(root).toContain('Session A0-3G');
    expect(root).toContain('Children: B1-22, C2-33');
    expect(root).toContain('Summary: Planned the wall editing photo delete flow');
    expect(root).toContain('Plan docs: docs/plans/WALL_EDITING_PLAN.md');
    expect(root).toContain('Commits: abc1234 feat(web): photo delete');
    expect(root).toContain(`Transcript: ${transcript.file}`);
    expect(body.context.startsWith('Claude Code session nodes mentioned in this prompt')).toBe(true);
  });

  it('is empty for no ids or only unknown ids', async () => {
    expect((await get<ContextPayload>('/api/sessions/context')).body).toEqual({ nodes: [], missing: [], context: '' });
    expect((await get<ContextPayload>('/api/sessions/context?ids=ZZ-ZZ')).body).toEqual({ nodes: [], missing: ['ZZ-ZZ'], context: '' });
  });

  it('is loopback only', async () => {
    const foreignOrigin = await app.request('/api/sessions/context?ids=A0-3G', { headers: { origin: 'http://evil.example' } });
    expect(foreignOrigin.status).toBe(403);
    expect(await foreignOrigin.json()).toEqual({ error: 'forbidden_origin' });
    const foreignHost = await app.request('http://evil.example/api/sessions/context?ids=A0-3G');
    expect(foreignHost.status).toBe(403);
    expect(await foreignHost.json()).toEqual({ error: 'forbidden_host' });
  });
});

describe('GET /api/sessions/search', () => {
  it('hydrates the search hits in rank order (injected search)', async () => {
    const searchApp = new Hono();
    searchApp.route(
      '/',
      sessionsApiRoutes(h.deps, {
        ...overrides,
        search: async ({ query, repo, limit }) => {
          expect({ query, repo, limit }).toEqual({ query: 'photo delete', repo: 'mcp-notes', limit: 5 });
          return { mode: 'hybrid', fallback: null, hits: [{ sessionId: 'sess-b1', score: 0.912345 }, { sessionId: 'gone', score: 0.5 }, { sessionId: 'sess-root', score: 0.8 }] };
        },
      }),
    );
    const res = await searchApp.request('/api/sessions/search?q=photo%20delete&repo=mcp-notes&limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchPayload;
    expect(body.mode).toBe('hybrid');
    expect(body.hits.map((x) => [x.node_id, x.score])).toEqual([
      ['B1-22', 0.9123],
      ['A0-3G', 0.8],
    ]);
  });

  it('uses phase 6 search for real and reports the text fallback without an embedder', async () => {
    const { status, body } = await get<SearchPayload>('/api/sessions/search?q=photo%20delete');
    expect(status).toBe(200);
    expect(body.mode).toBe('text');
    expect(typeof body.fallback).toBe('string');
    expect(body.hits.map((x) => x.node_id)).toContain('A0-3G');
  });

  it('400 without q', async () => {
    expect((await get('/api/sessions/search')).status).toBe(400);
    expect((await get('/api/sessions/search?q=%20')).status).toBe(400);
  });
});

describe('GET /api/sessions/usage', () => {
  it('by month, in the daemon timezone', async () => {
    const { status, body } = await get<Extract<UsagePayload, { by: 'month' }>>('/api/sessions/usage?by=month');
    expect(status).toBe(200);
    expect(body.time_zone).toBe('Asia/Jakarta');
    // sess-root started 2026-10-31T18:00Z = 2026-11-01 01:00 WIB, so it counts in November.
    expect(body.rows.map((r) => [r.month, r.sessions])).toEqual([
      ['2026-11', 3],
      ['2026-09', 1],
    ]);
    expect(body.rows[0]).toMatchObject({ input_tokens: 110, output_tokens: 220, cache_read_tokens: 1000, cache_write_tokens: 50, total_tokens: 1380, cost_usd: 1.25 });
    expect(body.totals.sessions).toBe(4);
    expect(body.totals.cost_usd).toBe(10.75);
  });

  it('by node, filtered by repo and month', async () => {
    const all = await get<Extract<UsagePayload, { by: 'node' }>>('/api/sessions/usage?by=node');
    expect(all.body.rows[0]!.node_id).toBe('D4-44');
    const repo = await get<Extract<UsagePayload, { by: 'node' }>>('/api/sessions/usage?by=node&repo=mcp-notes&limit=1');
    expect(repo.body.rows.map((r) => r.node_id)).toEqual(['A0-3G']);
    expect(repo.body.totals.sessions).toBe(3);
    const sept = await get<Extract<UsagePayload, { by: 'node' }>>('/api/sessions/usage?by=node&month=2026-09');
    expect(sept.body.rows.map((r) => r.node_id)).toEqual(['D4-44']);
  });

  it('400 on bad parameters', async () => {
    expect((await get('/api/sessions/usage?by=week')).status).toBe(400);
    expect((await get('/api/sessions/usage?month=2026-13')).status).toBe(400);
  });
});
```

### Step 16: Integration tests — MCP tools
**File:** `tests/integration/sessions.mcp.int.test.ts` (new)
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_TOOL_NAMES } from '../../src/chat/status.js';
import { mcpToolDeps } from '../../src/http/app.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { SESSIONS_OFF } from '../../src/mcp/sessionTools.js';
import type { SessionsReadOverrides } from '../../src/sessions/readModel.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { clearSessions, OTHER_HOST, seedGraph, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  live: async () => [{ sessionId: 'sess-b1', status: 'idle', tmux: null }],
  search: async () => ({ mode: 'hybrid', fallback: null, hits: [{ sessionId: 'sess-root', score: 0.7 }] }),
};

let h: ApiHarness;
let client: Client;
let transcript: { file: string; cleanup: () => Promise<void> };

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(name, args);
  expect(r.isError ?? false).toBe(false);
  return JSON.parse(text(r)) as T;
}

beforeAll(async () => {
  h = await createApiHarness();
  transcript = await writeTranscript();
  const server = createMcpServer(mcpToolDeps(h.deps, overrides));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'sessions-in-process', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await clearSessions(h.deps.db);
  await transcript.cleanup();
  await h.close();
});

beforeEach(async () => {
  await clearSessions(h.deps.db);
  await seedGraph(h.deps.db, transcript.file);
});

describe('session MCP tools', () => {
  it('registers exactly the read-only session tools, and the instructions explain them', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of SESSION_TOOL_NAMES) expect(names).toContain(name);
    for (const t of tools.filter((x) => (SESSION_TOOL_NAMES as readonly string[]).includes(x.name))) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description?.length ?? 0).toBeGreaterThan(40);
    }
    expect(client.getInstructions() ?? '').toContain('Sessions.');
  });

  it('sessions_search returns hits with wall links', async () => {
    const res = await callJson<{ mode: string; hits: Array<{ node_id: string; url: string; summary: string }> }>('sessions_search', { query: 'photo delete' });
    expect(res.mode).toBe('hybrid');
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ node_id: 'A0-3G', url: 'http://localhost:7317/projects?repo=mcp-notes&node=A0-3G' });
    expect(res.hits[0]!.summary).toContain('photo delete');
  });

  it('session_get returns the detail with urls on the session, parent and children', async () => {
    const res = await callJson<{
      session: { node_id: string; url: string };
      children: Array<{ node_id: string; url: string; live: boolean }>;
      plan_docs: string[];
    }>('session_get', { node_id: 'a0-3g' });
    expect(res.session).toMatchObject({ node_id: 'A0-3G', url: 'http://localhost:7317/projects?repo=mcp-notes&node=A0-3G' });
    expect(res.children.map((c) => [c.node_id, c.live])).toEqual([
      ['B1-22', true],
      ['C2-33', false],
    ]);
    expect(res.children[0]!.url).toContain('node=B1-22');
    expect(res.plan_docs).toEqual(['docs/plans/WALL_EDITING_PLAN.md']);
  });

  it('session_get rejects note ids and unknown node ids', async () => {
    const bad = await call('session_get', { node_id: 'A-B32' });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^invalid_node_id:/);
    const missing = await call('session_get', { node_id: 'ZZ-ZZ' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^not_found: no session ZZ-ZZ/);
  });

  it('session_transcript searches on the owning host and refuses another host', async () => {
    const res = await callJson<{ total_matches: number; matches: Array<{ excerpt: string }> }>('session_transcript', {
      node_id: 'A0-3G',
      query: 'recycle bin',
    });
    expect(res.total_matches).toBe(1);
    expect(res.matches[0]!.excerpt).toContain('recycle bin');

    const remote = await call('session_transcript', { node_id: 'C2-33', query: 'x' });
    expect(remote.isError).toBe(true);
    expect(text(remote)).toMatch(new RegExp(`^not_on_this_machine: session C2-33 ran on ${OTHER_HOST}`));
  });

  it('sessions_usage by node carries urls; by month defaults', async () => {
    const byNode = await callJson<{ by: string; rows: Array<{ node_id: string; url: string | null }> }>('sessions_usage', { by: 'node', limit: 2 });
    expect(byNode.rows.map((r) => r.node_id)).toEqual(['D4-44', 'A0-3G']);
    expect(byNode.rows[0]!.url).toBe('http://localhost:7317/projects?repo=seer&node=D4-44');
    const byMonth = await callJson<{ by: string; rows: Array<{ month: string }> }>('sessions_usage', {});
    expect(byMonth.by).toBe('month');
    expect(byMonth.rows.map((r) => r.month)).toEqual(['2026-11', '2026-09']);
  });

  it('answers SESSIONS_OFF when the server has no session read model', async () => {
    const deps = mcpToolDeps(h.deps, overrides);
    delete deps.sessions;
    const server = createMcpServer(deps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name: 'sessions-off', version: '0.0.0' });
    await c.connect(a);
    const r = (await c.callTool({ name: 'session_get', arguments: { node_id: 'A0-3G' } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(SESSIONS_OFF);
    await c.close();
  });
});
```

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit: `tests/unit/sessions.view.test.ts`, `tests/unit/sessions.transcriptSearch.test.ts`, `tests/unit/chat-status.test.ts`, `tests/unit/mcp.instructions.test.ts`, `tests/unit/chat-agent.test.ts`) and `npm run test:int` (`tests/integration/sessions.api.int.test.ts`, `tests/integration/sessions.mcp.int.test.ts`, plus the existing `mcp.tools.int.test.ts`, `similarImages.mcp.int.test.ts`, `reveal.int.test.ts`, which construct `mcpToolDeps`/`createApp` and must stay green).
One file: `npx vitest run tests/unit/sessions.view.test.ts`.
**Manual check:** with the daemon running after phases 3-6 have ingested: `curl -s localhost:7317/api/projects | jq '.projects[:3]'`; `curl -s localhost:7317/api/projects/mcp-notes/sessions | jq '.total, (.nodes|length), .nodes[0]'`; `curl -s 'localhost:7317/api/sessions/context?ids=<a real node id>' | jq -r .context`; in Claude Code ask "which session planned the project session graph?" and confirm `sessions_search` then `session_get` are called and the reply links `[XX-XX](http://localhost:7317/projects?repo=mcp-notes&node=XX-XX)`.
**Exit criteria:** every endpoint and tool above has a passing integration test; `session_transcript` and `GET /api/sessions/:id/transcript` return `not_on_this_machine` for other-host rows; `allowedChatTools()` has 40 entries including the four session tools; `npm run typecheck`, `npm test`, `npm run test:int` pass.

## Handoffs

- **Phase 8 (R5):** call `GET /api/sessions/context?ids=<comma list>` only when the regex finds a candidate; use `context` verbatim as `additionalContext` when non-empty, add nothing when it is `''`. At most 10 ids are considered. The route needs no `X-Notes-Capture` header (loopback guard only). `CONTEXT_HEADER` is the first line. The server normalizes leniently (`normalizeNodeId`: dash optional), so any 4-character word ("nope", "TODO") is a well-formed id to it; the hook's candidate regex should require the dashed `XX-XX` form to keep the near-zero-cost path.
- **Phase 9 (R8/R6):** append `'session_resume'` to `SESSION_TOOL_NAMES` in `src/chat/status.ts`, add its caption, and bump `tests/unit/chat-status.test.ts` to `19 + 5 + 15 + 2`; register the tool in `src/mcp/sessionTools.ts` (guard on `deps.sessions` like the others; `deps.sessions.host` is this host for the cross-host check); mount its router in `src/http/app.ts` after `sessionsApiRoutes`. `readTranscript`'s row lookup is a template for its owner-host check.
- **Phase 10 (R7):** no SSE event exists for sessions — poll `GET /api/projects/:repo/sessions` (suggested 10 s while visible) sending `If-None-Match` with the last `ETag`; 304 means unchanged. Use `PUT /api/projects/selected` (same-origin) to persist the selection; `GET /api/projects` already carries `selected`. Mirror the JSON shapes above in `web/src/types.ts`. Paging: `?before=<next_before>`.
- **Phase 12 (R7):** `src/chat/prompt.ts` does not mention the session tools; when per-project chat lands, add a sentence there (the MCP `Sessions.` paragraph already explains them to Claude Code). Project-scoped chat can call `sessions_search` with `repo`.
- **Phase 13 (R9):** set `unfinished` in `graphForRepo` (post-map `nodes`) or in `toGraphNode` via a new `NodeContext` field; it is `null` today and is part of the ETag hash, so badge changes invalidate the 304.
- **Phase 14:** README: HTTP API rows for the nine routes, MCP tool rows for the four tools, the poll-not-SSE note; CLAUDE.md: the read model lives in `src/sessions/readModel.ts` / `view.ts`.
- **Phase 1 / 3 / 6 (reconciled):** `repoSettings()` uses `new SessionsRepo(db)` with `getSetting`/`putSetting` and writes `projects.selected` as a bare JSON string (Phase 1's `setSelectedProject` format); `liveFromRegistry()` uses Phase 3's `readLiveSessions(claudeHome)`; `phase6Search()` calls `searchSessions({db, embedder}, query, {repo?, limit})` and maps `sessions[].session_id/score`. `truncateAll` covers the cc tables, so `clearSessions` is redundant but harmless. `transcriptSearch.ts#messageText` overlaps phase 3's transcript parser in purpose; a later cleanup may share one extractor.

## Rollback

Revert this phase's commit. It adds no migration and writes only the `projects.selected` row of
`app_settings` (harmless if left; `delete from app_settings where key = 'projects.selected'` to
clear). Files to drop on a manual revert: `src/sessions/{view,readModel,transcriptSearch}.ts`,
`src/http/sessionsApi.ts`, `src/mcp/sessionTools.ts`, the two integration tests, the seed helper,
the two unit tests; restore `src/http/app.ts`, `src/mcp/{server,tools,instructions}.ts`,
`src/chat/status.ts`, `tests/unit/{chat-status,mcp.instructions}.test.ts` from the parent commit.
Phases 8-13 depend on these routes and must be reverted first.
