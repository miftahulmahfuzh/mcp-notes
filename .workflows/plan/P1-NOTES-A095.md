> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/session-fork-awareness/PLAN.md` phase 5. Source: `.workflows/plan/session-fork-awareness/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Fork and background-job wording in API, MCP and hook context

**Plan set:** `SESSION_FORK_AWARENESS_PLAN.md`
**Analysis:** `.workflows/analyze/20261111-093332-K7F2_code_analyzer.md`
**Satisfies:** R2, R4 — `session_transcript` on a fork searches only what the fork added (R2), and the API, MCP tools and prompt-hook context say "fork of <node>" with the fork point and give `claude attach <jobId>` for a live background job (R4)
**Criteria:** R2.4, R4.1, R4.3
**Depends on:** Phase 1, 4
**Difficulty:** NORMAL
**Package:** `src/sessions`, `src/mcp`

---

## Goal

Every read surface of the session graph describes a fork as a fork. API node shapes carry a `fork` object and a `job_id`. MCP `session_get` and `sessions_search` say `fork of <parent node id> (after prompt N, <local time>)`. The prompt-hook context prints `Fork of …` instead of `Parent: … (fork link)`. For a session that is live as a Claude Code background job, the hook context and `session_get` give `claude attach <jobId>` as the way back in. `session_transcript` and `GET /api/sessions/:nodeId/transcript` on a fork skip the records copied from the parent and say so.

## Interface Contract

**Deletes:** none.

**Renames:** none.

**Creates:**
- `ForkPoint` type (`src/sessions/view.ts`): `{ parent_node_id: string; forked_at: string | null; prompt_count: number | null }`.
- `forkPointText(fork: ForkPoint, timeZone: string): string` (`src/sessions/view.ts`). Returns `DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)`. The prompt part is `before its first prompt` when `prompt_count` is 0 and is left out when it is null. The time part is left out when `forked_at` is null. Both missing gives just `DM-OV`.
- `resumeCommand(s: Pick<GraphNode, 'available' | 'job_id' | 'session_id'>): string | null` (`src/sessions/view.ts`). Returns `claude attach <job_id>` for a live background job, `claude --resume <session_id>` for any other session on this host, and null on another host.
- `TranscriptSearchOptions.startOffset?: number` (`src/sessions/transcriptSearch.ts`).
- Test file `tests/integration/sessions.forkWording.int.test.ts`.

**Signature changes:**
- `view.ts LiveEntry` `{ sessionId, status, tmux }` -> `{ sessionId, status, tmux, jobId: string | null }`. This is also the element type of `SessionsReadOverrides.live` (`readModel.ts LiveSource`).
- `view.ts NodeRow` gains `forked_at: Date | string | null` and `fork_prompt_count: number | string | null`. `NODE_SELECT` selects them.
- `view.ts GraphNode` gains `fork: ForkPoint | null` (after `parent_link_source`) and `job_id: string | null` (after `tmux`). `SessionInfo` and `SearchHit` extend `GraphNode`, so they gain both.
- `view.ts NodeRef` gains `fork: ForkPoint | null` and `job_id: string | null`.
- `view.ts TranscriptPayload` gains `starts_at_fork_point: boolean`.

**Wire shapes. Phase 6 plans against these.**

```ts
// On every API node shape:
//   GET /api/projects/:repo/sessions      .nodes[]
//   GET /api/sessions/:nodeId             .session, .parent, .children[]
//   GET /api/sessions/search              .hits[]
fork: {
  parent_node_id: string;        // node id of the parent, e.g. "DM-OV"
  forked_at: string | null;      // ISO 8601 UTC, e.g. "2026-11-11T01:37:02.342Z" (cc_sessions.forked_at)
  prompt_count: number | null;   // parent prompts copied into the fork ("after prompt N"); 0 = before any prompt
} | null;
// Non-null exactly when parent_link_source === "fork" and parent_node_id is not null.

job_id: string | null;
// Non-null exactly when the session is live on THIS host as a Claude Code background job
// (registry kind "bg"), e.g. "e3650501". Null on other hosts, for interactive sessions and when not live.

// GET /api/sessions/:nodeId/transcript and MCP session_transcript:
starts_at_fork_point: boolean;   // true when cc_sessions.fork_cut_offset > 0: copied records were skipped.
                                 // matches[].line stays the line number in the transcript file.
```

These fields are MCP only and are not on the HTTP API:
- `session_get` → `session.fork_of: string | null`, e.g. `"fork of DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)"`, and `session.resume_command: string | null`, e.g. `"claude attach e3650501"`, `"claude --resume <sid>"`, or null on another host.
- `sessions_search` → `hits[].fork_of: string | null`, with the same wording.

The shape of `GET /api/sessions/context` (`{ nodes, missing, context }`) does not change. Only its text changes:
- `Fork of <parent node id> (after prompt N, YYYY-MM-DD HH:mm <zone>)` replaces `Parent: <id> (fork link)`.
- `Transcript: <path> (attach with: claude attach <jobId>)` replaces `(resume with: claude --resume <sid>)` for a live background job.

**Requires (from earlier phases):**
- Phase 1: `cc_sessions.forked_at timestamptz`, `cc_sessions.fork_prompt_count integer` and `cc_sessions.fork_cut_offset bigint` exist (migration 0015). The DB check allows `parent_link_source = 'fork'`.
- Phase 1: `view.ts` `ParentLinkSource` is `'fork' | 'env' | 'hook' | 'heuristic'` and `linkSource()` (`view.ts:450`) returns `'fork'` for `'fork'`. Phase 5 code compares `source !== 'fork'`, so this must be in place or the code does not typecheck.
- Phase 4: `registry.ts LiveSession` has `kind: string | null` and `jobId: string | null`, both parsed by `parseLiveEntry`, and `backgroundJobId(session: Pick<LiveSession, 'kind' | 'jobId'>): string | null` decides "this live entry is a background job".
- Phase 4: `src/mcp/sessionTools.ts` line 5 imports `RESUME_PROMPT_MAX_CHARS, type ResumeOutcome, type ResumeResult` from `../sessions/resume.js`, and `attachedText` / `resumeToolResult` (from about line 276) are phase 4's. Phase 5's line numbers below 276 are unchanged by phase 4 (its line-5 edit replaces one line with one line); keep phase 4's line 5 as it is.
- Phase 1: `src/sessions/transcript.ts` exports `isCopiedRecord(record, lineStart, forkCutOffset: number | null)` (Phase 1 Step 7b).
- Phase 2 (data meaning, not a build dependency): `fork_cut_offset` is the byte offset of the fork's first own uuid record, and it is set on every fork whose cut is known. It is null on non-forks.

**Leaves alone (owned by others):**
- `src/sessions/search.ts`. Phase 1 owns its enum guard. Phase 5 adds no columns there; see Principles applied.
- `src/sessions/ingest.ts`, `transcript.ts`, `repo.ts`, `merge.ts` (phases 2 and 3).
- `src/sessions/registry.ts`, `resume.ts`, `src/http/sessionResume.ts` (phase 4).
- `src/mcp/sessionTools.ts` from line 276 on (`resumeToolResult`, `registerSessionResumeTool`; phase 4). Phase 5 edits only lines 1-186: imports, `sessions_search`, `session_get` and `session_transcript`.
- `src/http/sessionsApi.ts` does not change. Its routes return the read-model payloads as they are, so the new fields pass through with no route edit.
- `claude/hooks/notes-prompt.mjs` does not change. It prints the route's `context` text as is (`notes-prompt.mjs:353-375`).
- `web/src/*` (phase 6). `CLAUDE.md` (phase 3). In `README.md` phase 5 owns only the MCP rows `sessions_search`, `session_get`, `session_transcript` and the HTTP row `GET /api/sessions/:nodeId/transcript` (Step 11); "Who started whom" is phase 3's, "Resume from the wall" and the `session_resume` / `POST …/resume` rows are phase 4's.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/view.ts` | modify | `ForkPoint`. `fork`/`job_id` on `GraphNode` (:42) and `NodeRef` (:136). `starts_at_fork_point` on `TranscriptPayload` (:274). Fork columns on `NodeRow` (:289). `jobId` on `LiveEntry` (:334). `toGraphNode`/`toNodeRef` (:463-509). New `forkPointText`, `resumeCommand`. `formatContext` (:777) |
| `src/sessions/readModel.ts` | modify | `liveFromRegistry` (:126) maps `jobId` for `kind: "bg"`. `NODE_SELECT` (:224) selects `forked_at`, `fork_prompt_count`. `readTranscript` (:742) passes `fork_cut_offset` and returns `starts_at_fork_point` |
| `src/sessions/transcriptSearch.ts` | modify | `startOffset` option (:27). `searchTranscript` (:114) skips uuid records that start before it |
| `src/mcp/sessionTools.ts` | modify | Imports (:8). `sessions_search` (:48) adds `fork_of`. `session_get` (:113) adds `fork_of` and `resume_command`. `session_transcript` (:143) description |
| `tests/unit/sessions.view.test.ts` | modify | `row()` fixture gets the fork columns, live entries get `jobId`, new `forks and background jobs` describe block |
| `tests/unit/sessions.transcriptSearch.test.ts` | modify | New `startOffset` test |
| `tests/integration/sessions.api.int.test.ts` | modify | `jobId: null` on the two fake live entries (:28-29) |
| `tests/integration/sessions.mcp.int.test.ts` | modify | `jobId: null` on the fake live entry (:19) |
| `tests/integration/sessions.forkWording.int.test.ts` | create | Fork plus live background job over the HTTP API and MCP |
| `.claude/skills/verify-notesd/features/projects.md` | modify | Sub-feature bullet and a driving block for forks and background jobs in the tools |
| `README.md` | modify | MCP rows `sessions_search`, `session_get`, `session_transcript` (:1059-1061); HTTP row `GET /api/sessions/:nodeId/transcript` (:1146) |

## Implementation Steps

### Step 1: Fork and job fields on the view types
**File:** `src/sessions/view.ts:34-69`, `:136-148`, `:274-283`, `:289-313`, `:333-338`
**Change:** Add `ForkPoint`. Extend `GraphNode`, `NodeRef`, `TranscriptPayload`, `NodeRow` and `LiveEntry`. Line 11 is assumed to read `export type ParentLinkSource = 'fork' | 'env' | 'hook' | 'heuristic';` after phase 1. If phase 1 left the alias alone and widened only `linkSource()`, widen the alias here too, as a one-token change.
**Code.** Replace `TokenCounts` through the end of `GraphNode` (lines 34-69) with:
```ts
export interface TokenCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

/**
 * Where a fork left its parent: set on a node whose parent link source is `fork` (Claude Code
 * copied the parent's history into it with --fork-session, or as a background job). `forked_at`
 * is the fork boundary (cc_sessions.forked_at, ISO UTC); `prompt_count` is how many of the
 * parent's prompts the fork copied ("after prompt N"), 0 when it forked before any prompt.
 */
export interface ForkPoint {
  parent_node_id: string;
  forked_at: string | null;
  prompt_count: number | null;
}

export interface GraphNode {
  session_id: string;
  node_id: string;
  repo: string | null;
  parent_session_id: string | null;
  parent_node_id: string | null;
  parent_link_source: ParentLinkSource | null;
  /** Non-null exactly when parent_link_source is "fork" (and the parent row exists). */
  fork: ForkPoint | null;
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
  /** Claude Code background job id (registry kind "bg") while the session is live on this host as one; else null. */
  job_id: string | null;
  tokens: TokenCounts;
  cost_usd: number | null;
  summary_excerpt: string | null;
  child_count: number;
  /** Phase 13 fills it; null until then. */
  unfinished: boolean | null;
}
```
Replace `NodeRef` (lines 136-148) with:
```ts
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
  job_id: string | null;
  parent_link_source: ParentLinkSource | null;
  fork: ForkPoint | null;
}
```
Replace `TranscriptPayload` (lines 274-283) with:
```ts
export interface TranscriptPayload {
  node_id: string;
  session_id: string;
  query: string | null;
  transcript_path: string;
  /**
   * True on a fork with a known cut (cc_sessions.fork_cut_offset > 0): the records it copied from
   * its parent were skipped, so only what the fork added is searched. `line` stays the file's line.
   */
  starts_at_fork_point: boolean;
  matches: Array<{ line: number; at: string | null; role: 'user' | 'assistant'; excerpt: string }>;
  total_matches: number;
  truncated: boolean;
  scanned_bytes: number;
}
```
Replace `NodeRow` (lines 289-313) with:
```ts
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
  forked_at: Date | string | null;
  fork_prompt_count: number | string | null;
  summary_head: string | null;
  parent_node_id: string | null;
  child_count: number | string | null;
};
```
Replace `LiveEntry` (lines 333-338) with:
```ts
/** One live session from phase 3's registry, as the read model needs it. */
export interface LiveEntry {
  sessionId: string;
  status: string | null;
  tmux: string | null;
  /** The background job id when the registry entry is `kind: "bg"`; null for any other session. */
  jobId: string | null;
}
```
**Impact:** The tree does not typecheck until Steps 2 and 4 land (`toGraphNode`, `toNodeRef` and `liveFromRegistry` build these shapes) and Step 7/9 update the test fixtures. Run typecheck after Step 4.

### Step 2: Map the fork point and the job id in toGraphNode / toNodeRef
**File:** `src/sessions/view.ts:462-509`
**Change:** Compute `fork` from the link source, the parent node id and the two fork columns. Take `job_id` from the live entry, which `ctx.live` only holds for this host. One private helper is the only place that decides whether a node is a fork, so `fork` and `parent_link_source` cannot disagree.
**Code.** Replace lines 462-509 (the `toGraphNode` doc comment through the end of `toNodeRef`) with:
```ts
/**
 * The fork point of a node, or null. Only a `fork` parent link with a parent row makes one, so
 * `fork` is never set on a node whose link says otherwise.
 */
function forkPoint(
  source: ParentLinkSource | null,
  parentNodeId: string | null,
  row: Pick<NodeRow, 'forked_at' | 'fork_prompt_count'>,
): ForkPoint | null {
  if (source !== 'fork' || parentNodeId === null) return null;
  const count = numOrNull(row.fork_prompt_count);
  return { parent_node_id: parentNodeId, forked_at: iso(row.forked_at), prompt_count: count === null ? null : Math.trunc(count) };
}

/** A row becomes a graph node. `available`/`live`/`job_id` are relative to `ctx.host`; `unfinished` stays null (phase 13). */
export function toGraphNode(row: NodeRow, ctx: NodeContext): GraphNode {
  const available = row.host === ctx.host;
  const live = available ? ctx.live.get(row.session_id) : undefined;
  const parentNodeId = nonEmpty(row.parent_node_id);
  const parentLinkSource = linkSource(row.parent_link_source);
  return {
    session_id: row.session_id,
    node_id: row.node_id,
    repo: nonEmpty(row.repo),
    parent_session_id: nonEmpty(row.parent_session_id),
    parent_node_id: parentNodeId,
    parent_link_source: parentLinkSource,
    fork: forkPoint(parentLinkSource, parentNodeId, row),
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
    job_id: live?.jobId ?? null,
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
    job_id: node.job_id,
    parent_link_source: node.parent_link_source,
    fork: node.fork,
  };
}
```
**Impact:** Every API node shape gains `fork` and `job_id`. `SessionInfo` (`toSessionInfo`, :536) spreads `toGraphNode`, so it needs no edit. Search hits (`readModel.ts searchNodes`) spread it too. Graph ETags change when a fork column or a job's liveness changes, which is what the wall wants.

### Step 3: Fork and way-back-in wording, and formatContext
**File:** `src/sessions/view.ts:740-812`
**Change:** Add `forkPointText` and `resumeCommand` after `formatLocalTime`. They are the single source of the wording that the hook context and the MCP tools share. Then rewrite `formatContext` so a fork gets a `Fork of` line instead of the `Parent:` line, and a live background job gets the attach command.
**Code.** Insert after `formatLocalTime` (after line 756):
```ts
/**
 * "DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)": the parent and where the fork left it.
 * Callers prefix "fork of " / "Fork of ". The prompt part reads "before its first prompt" for 0 and
 * is left out when unknown; the time is left out when unknown.
 */
export function forkPointText(fork: ForkPoint, timeZone: string): string {
  const parts: string[] = [];
  if (fork.prompt_count !== null) parts.push(fork.prompt_count === 0 ? 'before its first prompt' : `after prompt ${fork.prompt_count}`);
  const at = formatLocalTime(fork.forked_at, timeZone);
  if (at !== null) parts.push(`${at} ${timeZone}`);
  return parts.length === 0 ? fork.parent_node_id : `${fork.parent_node_id} (${parts.join(', ')})`;
}

/**
 * How to get back into a session from a terminal on this machine: `claude attach <job>` while it is
 * live as a Claude Code background job (resuming it would start a second copy), else
 * `claude --resume <session>`. Null when the session ran on another host.
 */
export function resumeCommand(s: Pick<GraphNode, 'available' | 'job_id' | 'session_id'>): string | null {
  if (!s.available) return null;
  return s.job_id !== null ? `claude attach ${s.job_id}` : `claude --resume ${s.session_id}`;
}
```
Replace `formatContext` and its doc comment (lines 772-812) with:
```ts
/**
 * The block the prompt hook (phase 8) injects for one node id: who/where/when, parent (or, for a
 * fork, "Fork of <parent> (after prompt N, <time>)") and children, summary (or first prompt), plan
 * docs, commits, transcript path with the way back in (`claude attach <job>` for a live background
 * job, else `claude --resume`) or the host that holds it, and the wall link. At most CONTEXT_NODE_MAX_CHARS.
 */
export function formatContext(input: ContextInput, opts: { timeZone: string; wallUrl: string }): string {
  const s = input.session;
  const where = [s.repo !== null ? `repo ${s.repo}` : null, s.branch !== null ? `branch ${s.branch}` : null, `host ${s.host}`]
    .filter((x): x is string => x !== null)
    .join(', ');
  const when = span(s.started_at, s.last_active_at, opts.timeZone);
  const state = s.live ? `; running now${s.status !== null ? ` (${s.status})` : ''}` : '';
  const lines: string[] = [`Session ${s.node_id} "${s.title}" (${where}${when !== null ? `; ${when}` : ''}${state})`];
  if (s.fork !== null) {
    lines.push(`Fork of ${forkPointText(s.fork, opts.timeZone)}`);
  } else if (s.parent_node_id !== null) {
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
  // Null exactly when the session ran on another host.
  const command = resumeCommand(s);
  if (command === null) {
    lines.push(`Transcript: on ${s.host}, not readable from this machine.`);
  } else if (s.transcript_path !== null) {
    lines.push(`Transcript: ${s.transcript_path} (${s.job_id !== null ? 'attach' : 'resume'} with: ${command})`);
  } else {
    lines.push('Transcript: not recorded.');
  }
  const url = nodeUrl(opts.wallUrl, s.repo, s.node_id);
  if (url !== null) lines.push(`Wall: ${url}`);
  return clip(lines.join('\n'), CONTEXT_NODE_MAX_CHARS) ?? '';
}
```
**Impact:** Non-fork nodes that are not background jobs render the same text as before (invariant 4 in spirit; the neighbor check covers it). The hook script needs no change.

### Step 4: Read model passes the job id, the fork columns and the cut
**File:** `src/sessions/readModel.ts:125-133`, `:223-235`, `:741-774`
**Change:**
- `liveFromRegistry` keeps `jobId` only for background jobs, through phase 4's `backgroundJobId(e)` (`src/sessions/registry.ts`: `kind === 'bg'` with a safe job id). The rule lives in one function shared with resume, so `job_id` on the wire is non-null exactly when resume would answer `attached`. Add `backgroundJobId` to `readModel.ts`'s existing `./registry.js` import (it already imports `readLiveSessions`).
- `NODE_SELECT` adds the two fork display columns. It is shared by the graph, detail, context, search and usage queries.
- `readTranscript` reads `fork_cut_offset` and hands it to `searchTranscript`.
**Code.** Replace lines 125-133 with:
```ts
/**
 * Phase 3's live registry reduced to {sessionId, status, tmux, jobId}. jobId is kept only for a
 * Claude Code background job (registry kind "bg"). A missing or unreadable registry means nothing is live.
 */
async function liveFromRegistry(claudeHome: string): Promise<LiveEntry[]> {
  try {
    const entries = await readLiveSessions(claudeHome);
    return entries.map((e) => ({
      sessionId: e.sessionId,
      status: e.status ?? null,
      tmux: e.tmux ?? null,
      jobId: backgroundJobId(e),
    }));
  } catch {
    return [];
  }
}
```
Replace lines 223-235 (`NODE_SELECT`) with:
```ts
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
  s.forked_at, s.fork_prompt_count,
  left(s.summary, 600) as summary_head,
  p.node_id as parent_node_id,
  (select count(*)::int from cc_sessions c where c.parent_session_id = s.session_id) as child_count`);
```
Replace lines 741-774 (`readTranscript`) with:
```ts
/**
 * Transcript search on the owning host only (invariant 7). On a fork with a known cut
 * (fork_cut_offset), the records copied from the parent are skipped: only what the fork added is searched.
 */
export async function readTranscript(
  rd: SessionsReadDeps,
  nodeId: string,
  opts: { query: string | null; limit: number },
): Promise<TranscriptOutcome> {
  const res = await rd.db.execute<{
    session_id: string;
    node_id: string;
    host: string;
    transcript_path: string | null;
    fork_cut_offset: number | string | null;
  }>(sql`
    select session_id, node_id, host, transcript_path, fork_cut_offset from cc_sessions where node_id = ${nodeId} limit 1`);
  const row = res.rows[0];
  if (row === undefined) return { ok: false, error: 'not_found', node_id: nodeId };
  if (row.host !== rd.host) return { ok: false, error: 'not_on_this_machine', node_id: row.node_id, host: row.host };
  const file = row.transcript_path;
  if (file === null || file.trim() === '') return { ok: false, error: 'transcript_missing', node_id: row.node_id };
  const query = opts.query === null || opts.query.trim() === '' ? null : opts.query.trim();
  const cut = num(row.fork_cut_offset);
  try {
    const r = await searchTranscript(file, { query, limit: opts.limit, startOffset: cut });
    return {
      ok: true,
      payload: {
        node_id: row.node_id,
        session_id: row.session_id,
        query,
        transcript_path: file,
        starts_at_fork_point: cut > 0,
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
**Impact:** `usage()` (:703) builds `{ host, live: new Map() }`, so it keeps compiling. `sessionsApi.ts` routes pass the new fields through as they are. The `bigint` `fork_cut_offset` comes back from pg as a string, and `num()` parses it.
**Check:** `npm run typecheck`. It still fails only on the test fixtures that Steps 7 and 9 fix.

### Step 5: Transcript search starts at the fork point
**File:** `src/sessions/transcriptSearch.ts:27-33`, `:109-157`
**Change:** Add the `startOffset` option. While scanning, track each line's starting byte offset. A record whose line starts before `startOffset` and that carries a uuid was copied from the parent, so it is skipped. A record without a uuid is always read (invariant 7). Line numbers stay absolute. The bytes skipped this way still count toward `scanned_bytes` and the scan cap.
**Code.** Replace lines 27-33 with:
```ts
export interface TranscriptSearchOptions {
  /** Null or blank: no filter, the last `limit` messages come back. */
  query: string | null;
  limit: number;
  /**
   * A fork's cut (cc_sessions.fork_cut_offset): a record that carries a uuid and whose line starts
   * before this byte was copied from the parent and is skipped. Records without a uuid are always
   * read. Default 0: nothing is skipped.
   */
  startOffset?: number;
  /** Tests lower it. Default TRANSCRIPT_MAX_SCAN_BYTES. */
  maxScanBytes?: number;
}
```
Replace lines 109-157 (doc comment and `searchTranscript`) with:
```ts
/**
 * Scans `file` once. A message matches when it contains every query term (case-insensitive).
 * Keeps the LAST `limit` matches in file order. With `startOffset`, uuid records whose line starts
 * before it are skipped (a fork's copied prefix); `line` stays the file's own 1-based line number.
 * Throws ENOENT when the file is gone (the caller maps it to transcript_missing).
 */
export async function searchTranscript(file: string, options: TranscriptSearchOptions): Promise<TranscriptSearchResult> {
  await stat(file);
  const terms = queryTerms(options.query === null || options.query.trim() === '' ? null : options.query);
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), TRANSCRIPT_MAX_LIMIT);
  const maxScan = options.maxScanBytes ?? TRANSCRIPT_MAX_SCAN_BYTES;
  const cut = options.startOffset !== undefined && options.startOffset > 0 ? options.startOffset : null;
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
      // Byte offset where this line starts (transcripts are LF-terminated JSONL).
      const lineStart = scanned;
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
      // Invariant 7, one rule for every reader (transcript.ts isCopiedRecord, phase 1).
      if (isRecord(record) && isCopiedRecord(record, lineStart, cut)) continue;
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
Add the import at the top of the file: `import { isCopiedRecord } from './transcript.js';` (`transcript.ts` does not import `transcriptSearch.ts`, so there is no cycle).
`lineStart` here is counted from the decoded line (`Buffer.byteLength(raw, 'utf8') + 1`), the way this function already counts `scanned_bytes`; for the LF-terminated, valid UTF-8 JSONL Claude Code writes it equals `readJsonlFrom`'s raw `lineStart` byte for byte (index Decisions: search keeps its readline loop).
**Impact:** Calls without `startOffset` behave exactly as before.
**Check:** `npx vitest run tests/unit/sessions.transcriptSearch.test.ts`. The existing tests stay green.

### Step 6: MCP tools say "fork of" and give the way back in
**File:** `src/mcp/sessionTools.ts:8`, `:48-111`, `:113-141`, `:143-186`
**Change:**
- Import the wording helpers.
- Add a local `forkOf` that prefixes `fork of `.
- `sessions_search` hits add `fork_of`.
- `session_get` adds `session.fork_of` and `session.resume_command`.
- The three descriptions say what the new fields mean.
**Code.** Replace line 8 with:
```ts
import { forkPointText, nodeUrl, resumeCommand, type ForkPoint, type NodeRef } from '../sessions/view.js';
```
Insert after `withUrl` (after line 43):
```ts
/** "fork of DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)" for a fork, null otherwise. */
function forkOf(rd: SessionsReadDeps, fork: ForkPoint | null): string | null {
  return fork === null ? null : `fork of ${forkPointText(fork, rd.timeZone)}`;
}
```
Replace the `sessions_search` registration (lines 48-111) with:
```ts
  server.registerTool(
    'sessions_search',
    {
      title: 'Search Claude Code sessions',
      description:
        "Find the user's past Claude Code sessions (both laptops) by meaning and words in their summaries, names, titles, prompts and commit messages, in the notes saved from or linked to each session, and in what Claude replied to each prompt, e.g. \"when did I fix photo delete in the wall?\". " +
        'Optional repo narrows to one repository (e.g. "mcp-notes"). Returns { query, mode, fallback, hits: [{ node_id, repo, title, started_at, last_active_at, host, available, live, status, parent_node_id, fork_of, summary, via_notes, via_replies, score, url }] }, best first. ' +
        'fork_of is set when the session is a fork Claude Code copied from another session: "fork of <parent node id> (after prompt N, <local time>)", i.e. the parent and how many of its prompts the fork copied; null otherwise. ' +
        'via_notes lists the session\'s notes that matched ({ id, excerpt }, note ids like A-B32). via_replies lists Claude\'s replies in that session that matched ({ seq, excerpt }: seq is the number of the prompt the reply answered, excerpt the passage around the match). Both are best first, at most 3, and empty when the session matched on its own text. A match through a note or a reply counts a little less than the same match in the session\'s own summary or prompts. ' +
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
              fork_of: forkOf(rd, h.fork),
              summary: h.summary_excerpt,
              via_notes: h.via_notes,
              via_replies: h.via_replies,
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
```
Replace the `session_get` registration (lines 113-141) with:
```ts
  server.registerTool(
    'session_get',
    {
      title: 'Get a Claude Code session',
      description:
        'One Claude Code session by node id (like A0-3G): { session: { node_id, session_id, repo, title, name, branch, cwd, started_at, last_active_at, host, available, live, status, job_id, parent_node_id, parent_link_source, fork, fork_of, resume_command, tokens, cost_usd, summary, first_prompt, last_prompt, final_message, transcript_path, url, ... }, ' +
        'prompts, commits, files_edited, plan_docs, notes, parent, children (sessions it spawned) }. notes are the notes saved from that session and the notes linked to it with link_note, newest first, each { id, excerpt, tags, created_at, kind: "made" | "linked" }; a note that is both is listed once as "made". ' +
        'A fork (parent_link_source "fork") is a session Claude Code copied from its parent with --fork-session or as a background job: fork is { parent_node_id, forked_at, prompt_count } and fork_of says "fork of <parent node id> (after prompt N, <local time>)"; both are null for any other session. ' +
        'resume_command is the way back into the session from a terminal on this machine: "claude attach <job_id>" while it runs as a Claude Code background job (job_id set), else "claude --resume <session_id>"; null when it ran on the other machine. ' +
        'available: false means it ran on the other machine (host).',
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
          session: {
            ...withUrl(rd, detail.session),
            fork_of: forkOf(rd, detail.session.fork),
            resume_command: resumeCommand(detail.session),
          },
          parent: detail.parent === null ? null : withUrl(rd, detail.parent),
          children: detail.children.map((c: NodeRef) => withUrl(rd, c)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
```
In the `session_transcript` registration (lines 143-186), replace only the `description` value (lines 147-149) with:
```ts
      description:
        "Search one Claude Code session's own transcript for words and get the matching messages: { node_id, session_id, query, transcript_path, starts_at_fork_point, matches: [{ line, at, role, excerpt }], total_matches, truncated }. " +
        'Every word must appear; "quoted phrases" stay together. Without query, the last messages come back. line is the line number in the transcript file. ' +
        'On a fork (session_get shows fork_of), only what the fork added is searched: the history it copied from its parent is skipped and starts_at_fork_point is true; search the parent node for that history. ' +
        'Works only on the machine that ran the session; elsewhere it answers not_on_this_machine (use session_get there).',
```
**Impact:** The MCP JSON gains fields and the descriptions change. Nothing is removed. Phase 4 edits the same file below line 276 (`resumeToolResult`, `registerSessionResumeTool`), so the hunks do not overlap.

### Step 7: Unit tests for the view mapping and wording
**File:** `tests/unit/sessions.view.test.ts:2-20`, `:23-48`, `:89`, `:227`, end of file
**Change:**
- Add the new imports.
- Give `row()` the two fork columns.
- Give both literal live entries `jobId: null`.
- Append a describe block that tests behavior: what a caller of `toGraphNode`/`formatContext` sees.
**Code.** Replace the import block (lines 2-20) with:
```ts
import {
  CONTEXT_NODE_MAX_CHARS,
  excerpt,
  forkPointText,
  formatContext,
  formatLocalTime,
  iso,
  nodeUrl,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  resumeCommand,
  sessionTitle,
  summaryState,
  toGraphNode,
  toNodeRef,
  toNoteRef,
  toSessionInfo,
  type DetailRow,
  type LiveEntry,
  type NodeRow,
} from '../../src/sessions/view.js';
```
In `row()` (lines 23-48), replace the line `    tmux: null,` with:
```ts
    tmux: null,
    forked_at: null,
    fork_prompt_count: null,
```
Line 89 becomes:
```ts
    const live = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'busy', tmux: 'note:@0.%7', jobId: null }]]);
```
Line 227 becomes:
```ts
    const live = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'busy', tmux: null, jobId: null }]]);
```
Append at the end of the file:
```ts
describe('forks and background jobs', () => {
  const opts = { timeZone: 'Asia/Jakarta', wallUrl: 'http://localhost:7317' };
  const ctx = { host: 'lenovo', live: noLive };
  // JM-UJ-shaped: forked from DM-OV after its 12th prompt, at the job's forkBoundaryAt.
  const forkCols = {
    parent_session_id: 'sess-0',
    parent_node_id: 'DM-OV',
    parent_link_source: 'fork',
    forked_at: '2026-11-11T01:37:02.342Z',
    fork_prompt_count: '12',
  };
  const bgLive = new Map<string, LiveEntry>([['sess-1', { sessionId: 'sess-1', status: 'idle', tmux: null, jobId: 'e3650501' }]]);

  it('a fork node carries its fork point on the node and its ref; any other link carries none', () => {
    const n = toGraphNode(row(forkCols), ctx);
    expect(n.parent_link_source).toBe('fork');
    expect(n.fork).toEqual({ parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 });
    expect(toNodeRef(n).fork).toEqual(n.fork);
    expect(toGraphNode(row({ ...forkCols, parent_link_source: 'env' }), ctx).fork).toBeNull();
    expect(toGraphNode(row({ ...forkCols, parent_node_id: null }), ctx).fork).toBeNull();
    expect(toGraphNode(row(), ctx).fork).toBeNull();
  });

  it('job_id comes from a live background entry on this host only', () => {
    expect(toGraphNode(row(), { host: 'lenovo', live: bgLive })).toMatchObject({ live: true, job_id: 'e3650501' });
    expect(toNodeRef(toGraphNode(row(), { host: 'lenovo', live: bgLive })).job_id).toBe('e3650501');
    expect(toGraphNode(row({ host: 'gpd' }), { host: 'lenovo', live: bgLive }).job_id).toBeNull();
    expect(toGraphNode(row(), ctx).job_id).toBeNull();
  });

  it('forkPointText names the parent, the prompts copied and the local fork time', () => {
    expect(forkPointText({ parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 }, 'Asia/Jakarta')).toBe(
      'DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)',
    );
    expect(forkPointText({ parent_node_id: 'DM-OV', forked_at: null, prompt_count: 0 }, 'Asia/Jakarta')).toBe('DM-OV (before its first prompt)');
    expect(forkPointText({ parent_node_id: 'DM-OV', forked_at: null, prompt_count: null }, 'Asia/Jakarta')).toBe('DM-OV');
  });

  it('the hook context says "Fork of <parent>" with the fork point instead of a Parent line', () => {
    const session = toSessionInfo(detail(forkCols), ctx);
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text).toContain('Fork of DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)');
    expect(text).not.toContain('Parent:');
    expect(text).toContain('Transcript: /home/m/.claude/projects/x/sess-1.jsonl (resume with: claude --resume sess-1)');
  });

  it('a live background job is attached, never resumed', () => {
    const session = toSessionInfo(detail(), { host: 'lenovo', live: bgLive });
    const text = formatContext({ session, commits: [], plan_docs: [], children_node_ids: [] }, opts);
    expect(text).toContain('Transcript: /home/m/.claude/projects/x/sess-1.jsonl (attach with: claude attach e3650501)');
    expect(text).not.toContain('claude --resume');
    expect(resumeCommand(session)).toBe('claude attach e3650501');
  });

  it('resumeCommand is claude --resume for an ordinary local session and null on another host', () => {
    expect(resumeCommand(toSessionInfo(detail(), ctx))).toBe('claude --resume sess-1');
    expect(resumeCommand(toSessionInfo(detail({ host: 'gpd' }), ctx))).toBeNull();
  });
});
```
**Impact:** The existing `formatContext` assertions (`Parent: B1-22 (env link)`, `resume with: claude --resume sess-1`) stay as they are and keep passing. They are the non-fork regression guard.
**Check:** `npx vitest run tests/unit/sessions.view.test.ts`

### Step 8: Unit test for the transcript cut
**File:** `tests/unit/sessions.transcriptSearch.test.ts`, end of file
**Change:** Append one test that writes its own fork file in the suite's temp `dir`. `writeFile`, `path` and `dir` are already in scope.
**Code:**
```ts
describe('searchTranscript from a fork cut', () => {
  it('skips uuid records before the cut, keeps uuid-less records and the file line numbers', async () => {
    const forkFile = path.join(dir, 'fork.jsonl');
    const beforeCut = [
      { type: 'user', uuid: 'u-1', timestamp: '2026-11-01T01:00:00Z', message: { role: 'user', content: 'copied photo question' } },
      { type: 'assistant', uuid: 'a-1', timestamp: '2026-11-01T01:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'copied photo answer' }] } },
      // No uuid: written by Claude Code for the fork itself, so it is read even before the cut.
      { type: 'user', timestamp: '2026-11-01T01:01:30Z', message: { role: 'user', content: 'uuid-less photo line' } },
    ];
    const own = [{ type: 'user', uuid: 'u-2', timestamp: '2026-11-01T02:00:00Z', message: { role: 'user', content: 'own photo question' } }];
    const head = beforeCut.map((l) => `${JSON.stringify(l)}\n`).join('');
    await writeFile(forkFile, head + own.map((l) => `${JSON.stringify(l)}\n`).join(''));
    const cut = Buffer.byteLength(head, 'utf8');

    const whole = await searchTranscript(forkFile, { query: 'photo', limit: 10 });
    expect(whole.total_matches).toBe(4);

    const fromCut = await searchTranscript(forkFile, { query: 'photo', limit: 10, startOffset: cut });
    expect(fromCut.total_matches).toBe(2);
    expect(fromCut.matches.map((m) => [m.line, m.excerpt])).toEqual([
      [3, 'uuid-less photo line'],
      [4, 'own photo question'],
    ]);
    expect((await searchTranscript(forkFile, { query: 'copied', limit: 10, startOffset: cut })).total_matches).toBe(0);
  });
});
```
**Check:** `npx vitest run tests/unit/sessions.transcriptSearch.test.ts`

### Step 9: Integration tests: fixture updates and the fork wording test
**File:** `tests/integration/sessions.api.int.test.ts:27-30`, `tests/integration/sessions.mcp.int.test.ts:19`, new `tests/integration/sessions.forkWording.int.test.ts`
**Change:** Add `jobId: null` to the existing fake live entries, which is required by Step 1's `LiveEntry`. Add a self-contained test of a fork that is live as a background job, driven over the real HTTP routes and the real MCP server. It seeds the fork columns with its own `update`, so the shared `sessionsSeed.ts` helper, which phases 2 and 3 may also edit, stays untouched.
**Code.** `tests/integration/sessions.api.int.test.ts` lines 27-30 become:
```ts
  live: async () => [
    { sessionId: 'sess-b1', status: 'busy', tmux: 'note:@0.%7', jobId: null },
    { sessionId: 'sess-c2', status: 'busy', tmux: null, jobId: null },
  ],
```
`tests/integration/sessions.mcp.int.test.ts` line 19 becomes:
```ts
  live: async () => [{ sessionId: 'sess-b1', status: 'idle', tmux: null, jobId: null }],
```
New file `tests/integration/sessions.forkWording.int.test.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mcpToolDeps } from '../../src/http/app.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { resetGraphCache, type SessionsReadOverrides } from '../../src/sessions/readModel.js';
import type { ContextPayload, GraphPayload, SearchPayload, SessionDetail, TranscriptPayload } from '../../src/sessions/view.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { clearSessions, seedGraph, seedSession, THIS_HOST, writeTranscript } from './helpers/sessionsSeed.js';

/**
 * session-fork-awareness phase 5: the read surfaces describe a fork and a live background job.
 * F5-55 (sess-f5) is a fork of A0-3G (sess-root) made after A0-3G's first prompt, live as
 * background job f5f5f5f5. Its transcript starts with the two records it copied from A0-3G
 * (after a uuid-less agent-name line), then its own two.
 */
const JOB_ID = 'f5f5f5f5';
const FORKED_AT = '2026-10-31T19:00:00Z'; // 2026-11-01 02:00 in Asia/Jakarta
const FORK_OF = 'fork of A0-3G (after prompt 1, 2026-11-01 02:00 Asia/Jakarta)';

const overrides: SessionsReadOverrides = {
  host: THIS_HOST,
  timeZone: 'Asia/Jakarta',
  commitLinks: async () => new Map(),
  live: async () => [{ sessionId: 'sess-f5', status: 'idle', tmux: null, jobId: JOB_ID }],
  search: async () => ({
    mode: 'hybrid',
    fallback: null,
    hits: [
      { sessionId: 'sess-f5', score: 0.9 },
      { sessionId: 'sess-root', score: 0.5 },
    ],
  }),
};

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let h: ApiHarness;
let app: Hono;
let client: Client;
let rootTranscript: { file: string; cleanup: () => Promise<void> };
let forkDir: string;
let forkFile: string;
let cut: number;

async function get<T>(pathname: string): Promise<T> {
  const res = await app.request(pathname);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  expect(r.isError ?? false).toBe(false);
  return JSON.parse(r.content.map((c) => c.text ?? '').join('\n')) as T;
}

beforeAll(async () => {
  h = await createApiHarness();
  app = new Hono();
  app.route('/', sessionsApiRoutes(h.deps, overrides));
  const server = createMcpServer(mcpToolDeps(h.deps, overrides));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'fork-wording', version: '0.0.0' });
  await client.connect(clientSide);
  rootTranscript = await writeTranscript();
  forkDir = await mkdtemp(path.join(os.tmpdir(), 'cc-fork-'));
  forkFile = path.join(forkDir, 'sess-f5.jsonl');
  const beforeCut = [
    { type: 'agent-name', agentName: 'fork-fixture', sessionId: 'sess-f5' },
    { type: 'user', uuid: 'u-1', timestamp: '2026-10-31T18:00:00Z', message: { role: 'user', content: 'Plan the wall photo delete flow' } },
    { type: 'assistant', uuid: 'a-1', timestamp: '2026-10-31T18:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Photo delete goes to the recycle bin.' }] } },
  ];
  const own = [
    { type: 'user', uuid: 'u-2', timestamp: '2026-10-31T19:05:00Z', message: { role: 'user', content: 'Add an undo toast for photo delete' } },
    { type: 'assistant', uuid: 'a-2', timestamp: '2026-10-31T19:06:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The undo toast is in.' }] } },
  ];
  const head = beforeCut.map((r) => `${JSON.stringify(r)}\n`).join('');
  cut = Buffer.byteLength(head, 'utf8');
  await writeFile(forkFile, head + own.map((r) => `${JSON.stringify(r)}\n`).join(''));
});

afterAll(async () => {
  await client.close();
  await clearSessions(h.deps.db);
  await rootTranscript.cleanup();
  await rm(forkDir, { recursive: true, force: true });
  await h.close();
});

beforeEach(async () => {
  resetGraphCache();
  await clearSessions(h.deps.db);
  await seedGraph(h.deps.db, rootTranscript.file);
  await seedSession(h.deps.db, {
    sessionId: 'sess-f5',
    nodeId: 'F5-55',
    firstPrompt: 'Add an undo toast for photo delete',
    startedAt: '2026-10-31T19:05:00Z',
    lastActiveAt: '2026-10-31T19:06:00Z',
    inputTokens: 5,
    transcriptPath: forkFile,
  });
  await h.deps.db.execute(sql`
    update cc_sessions
    set parent_session_id = 'sess-root', parent_link_source = 'fork',
        forked_at = ${FORKED_AT}::timestamptz, fork_prompt_count = 1, fork_cut_offset = ${cut},
        fork_detected_by = 'uuid'
    where session_id = 'sess-f5'`);
});

describe('fork and background-job wording', () => {
  it('API: the fork point and the job id are on every node shape', async () => {
    const forkPoint = { parent_node_id: 'A0-3G', forked_at: '2026-10-31T19:00:00.000Z', prompt_count: 1 };
    const fork = await get<SessionDetail>('/api/sessions/F5-55');
    expect(fork.session).toMatchObject({ parent_link_source: 'fork', fork: forkPoint, live: true, job_id: JOB_ID });
    expect(fork.parent).toMatchObject({ node_id: 'A0-3G', fork: null, job_id: null });

    const root = await get<SessionDetail>('/api/sessions/A0-3G');
    expect(root.session).toMatchObject({ fork: null, job_id: null });
    expect(root.children.find((c) => c.node_id === 'F5-55')).toMatchObject({ fork: forkPoint, job_id: JOB_ID });

    const graph = await get<GraphPayload>('/api/projects/mcp-notes/sessions');
    expect(graph.nodes.find((n) => n.node_id === 'F5-55')).toMatchObject({ fork: forkPoint, job_id: JOB_ID });
    expect(graph.nodes.find((n) => n.node_id === 'B1-22')).toMatchObject({ parent_link_source: 'env', fork: null });

    const search = await get<SearchPayload>('/api/sessions/search?q=undo');
    expect(search.hits[0]).toMatchObject({ node_id: 'F5-55', fork: forkPoint });
  });

  it('hook context: "Fork of <parent>" with the fork point, and claude attach for the live job', async () => {
    const forkCtx = await get<ContextPayload>('/api/sessions/context?ids=F5-55');
    const text = forkCtx.nodes[0]!.text;
    expect(text).toContain('Fork of A0-3G (after prompt 1, 2026-11-01 02:00 Asia/Jakarta)');
    expect(text).not.toContain('Parent:');
    expect(text).toContain(`Transcript: ${forkFile} (attach with: claude attach ${JOB_ID})`);
    expect(text).not.toContain('claude --resume');

    const rootCtx = await get<ContextPayload>('/api/sessions/context?ids=A0-3G');
    expect(rootCtx.nodes[0]!.text).toContain(`(resume with: claude --resume sess-root)`);
    expect(rootCtx.nodes[0]!.text).not.toContain('Fork of');
  });

  it('MCP session_get and sessions_search say "fork of <parent>"; session_get gives the way back in', async () => {
    const fork = await callJson<{ session: { fork_of: string | null; resume_command: string | null; job_id: string | null } }>('session_get', { node_id: 'f555' });
    expect(fork.session).toMatchObject({ fork_of: FORK_OF, resume_command: `claude attach ${JOB_ID}`, job_id: JOB_ID });

    const root = await callJson<{ session: { fork_of: string | null; resume_command: string | null } }>('session_get', { node_id: 'A0-3G' });
    expect(root.session).toMatchObject({ fork_of: null, resume_command: 'claude --resume sess-root' });

    const remote = await callJson<{ session: { resume_command: string | null } }>('session_get', { node_id: 'C2-33' });
    expect(remote.session.resume_command).toBeNull();

    const hits = await callJson<{ hits: Array<{ node_id: string; fork_of: string | null }> }>('sessions_search', { query: 'undo toast' });
    expect(hits.hits.map((x) => [x.node_id, x.fork_of])).toEqual([
      ['F5-55', FORK_OF],
      ['A0-3G', null],
    ]);
  });

  it('session_transcript on a fork searches only what the fork added', async () => {
    const copied = await callJson<TranscriptPayload>('session_transcript', { node_id: 'F5-55', query: 'recycle bin' });
    expect(copied).toMatchObject({ starts_at_fork_point: true, total_matches: 0, matches: [] });

    const own = await callJson<TranscriptPayload>('session_transcript', { node_id: 'F5-55', query: 'photo delete' });
    expect(own.total_matches).toBe(1);
    expect(own.matches[0]).toMatchObject({ line: 4, role: 'user' });
    expect(own.matches[0]!.excerpt).toContain('undo toast');

    const api = await get<TranscriptPayload>('/api/sessions/F5-55/transcript?query=recycle%20bin');
    expect(api).toMatchObject({ starts_at_fork_point: true, total_matches: 0 });

    const root = await get<TranscriptPayload>('/api/sessions/A0-3G/transcript?query=recycle%20bin');
    expect(root).toMatchObject({ starts_at_fork_point: false, total_matches: 1 });
  });
});
```
**Impact:** None outside tests.
**Check:** `npm run test:int -- tests/integration/sessions.forkWording.int.test.ts tests/integration/sessions.api.int.test.ts tests/integration/sessions.mcp.int.test.ts`

### Step 10: Feature map entry
**File:** `.claude/skills/verify-notesd/features/projects.md`

**Shared file (reconciled):** `features/projects.md` gets append-only edits from phases 2, 4, 5 and 6 (and one sentence from phase 3 inside phase 2's bullet). Order, top to bottom, in both `## Sub-features` and the blocks before `## Gotchas`: phase 4's section (wave 1), then phase 2's, then phase 5's, then phase 6's. Phases 2 and 5 can run at the same time and anchor at the same spot; whoever merges second keeps both sides in that order (an append-append conflict, never a rewrite of the other phase's lines).
**Change:** Two edits. First, add a sub-feature bullet at the end of `## Sub-features`, after the "Expand prompts (R2)" bullet and before `## How to get to it (user POV)`. Second, add a driving block at the end of `## Driving it with verify.sh`, after the "Pasted images on a prompt" block and before `## Gotchas`. Phase 6 adds the wall part of forks (edge, badge, panel line) to this same file.
**Code.** The sub-feature bullet:
```markdown
- Forks and background jobs in the session tools (session-fork-awareness phase 5). A fork (a
  session Claude Code copied from another with `--fork-session`, or a background job forked from
  one) has `parent_link_source: "fork"` and `fork: { parent_node_id, forked_at, prompt_count }` on
  every API node shape (graph `nodes[]`, detail `session` / `parent` / `children[]`, search `hits[]`);
  every other node has `fork: null`. MCP `session_get` (`session.fork_of`) and `sessions_search`
  (`hits[].fork_of`) say `fork of <parent node id> (after prompt N, <YYYY-MM-DD HH:mm> <zone>)`,
  and the prompt hook's context block prints `Fork of …` instead of `Parent: … (fork link)`.
  `session_transcript` and `GET /api/sessions/:nodeId/transcript` on a fork search only what the
  fork added: records copied from the parent are skipped, `starts_at_fork_point: true`, and `line`
  stays the file's line number. A session live on this host as a Claude Code background job
  (registry `kind: "bg"`) carries `job_id`. Its hook context reads `Transcript: <path> (attach
  with: claude attach <jobId>)`, and `session_get` gives `session.resume_command: "claude attach
  <jobId>"` (otherwise `claude --resume <session id>`, and null for another host's session).
```
The driving block:
````markdown
Forks and background jobs in the tools and hook context. The fixtures hold no fork, so the run
seeds one. It makes fixture `…0005` a fork of `…0001` cut after its first copied prompt/reply pair
(lines 2-3), and makes it a live background job by writing a registry entry for a running `sleep`.
Nothing is billed:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
P=5e55a001-0000-4000-8000-000000000001; F=5e55a001-0000-4000-8000-000000000005
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
PN=$(jq -r --arg s $P '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S"); FN=$(jq -r --arg s $F '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S")
CUT=$(head -n 3 tests/fixtures/claude-home/projects/-home-u-mcp-notes/$F.jsonl | wc -c)
for i in $(seq 20); do $V sql RUN "select key from app_settings where key like 'sessions.forks.backfill.%'" | grep -q 'sessions.forks.backfill.' && break; sleep 1; done   # with phase 3 in the tree: seed after the fork backfill
$V exec RUN "update cc_sessions set parent_session_id='$P', parent_link_source='fork', forked_at='2026-10-20T01:02:30Z', fork_prompt_count=1, fork_cut_offset=$CUT, fork_detected_by='uuid', updated_at=now() where session_id='$F'"
$V mcp RUN session_transcript "$(jq -nc --arg n $FN '{node_id:$n, query:"\"step 1 of\""}')"   # total_matches 0, starts_at_fork_point true
$V mcp RUN session_transcript "$(jq -nc --arg n $FN '{node_id:$n, query:"\"step 2 of\""}')"   # 1 match, line 4
$V mcp RUN session_get "{\"node_id\":\"$FN\"}"        # session.fork_of "fork of $PN (after prompt 1, 2026-10-20 …)"
curl -sf "$URL/api/sessions/context?ids=$FN" | jq -r .context   # "Fork of $PN (after prompt 1, …)"
sleep 900 >/dev/null 2>&1 & JOBPID=$!
printf '{"pid":%d,"sessionId":"%s","kind":"bg","jobId":"5e55a005","status":"idle"}\n' $JOBPID $F > "$(dirname "$EVIDENCE")/claude/sessions/$JOBPID.json"
curl -sf "$URL/api/sessions/context?ids=$FN" | jq -r .context   # "(attach with: claude attach 5e55a005)"
$V mcp RUN session_get "{\"node_id\":\"$FN\"}"        # session.job_id "5e55a005", resume_command "claude attach 5e55a005"
kill $JOBPID
```
The same checks with assertions are `tests/integration/sessions.forkWording.int.test.ts`.
````
**Impact:** Documentation only.

### Step 11: README rows for the fork and job fields
**File:** `README.md:1059-1061` (MCP table) and `:1146` (HTTP table). Phase 4 has already changed the `session_resume` row (:1063) and the resume HTTP row (:1153); do not touch them.
**Change:** replace the three MCP rows and the one HTTP row with:
```markdown
| `sessions_search` | Claude Code sessions by meaning and by words over their summaries, names, prompts and commit messages, and over the notes saved from or linked to each session and Claude's replies in it, blended like `search`; filter by `repo`. Each hit has its node id, repo, times, summary, `fork_of` (`"fork of <parent node> (after prompt N, <time>)"` for a fork, else null), `via_notes` (`[{ id, excerpt }]`) and `via_replies` (`[{ seq, excerpt }]`, `seq` = the prompt the reply answered), each best first, at most 3, `[]` when none matched. Says `fallback` when only words were used |
| `session_get` | One session by node id (`A0-3G`, any case, dash optional): summary, prompts, commits, plan docs, files edited, its notes (saved from it or linked to it, each with `kind: "made" \| "linked"`), tokens and cost, parent and children, `host` and `available`. A fork has `fork` (`{ parent_node_id, forked_at, prompt_count }`) and `fork_of`; `resume_command` is `claude attach <job>` for a live background job (`job_id`), else `claude --resume <session>`, null on the other machine |
| `session_transcript` | Passages of a session's transcript matching `query`. On a fork only what it added after the fork point is searched (`starts_at_fork_point: true`). Only on the laptop that holds the transcript; elsewhere `not_on_this_machine` |
```
```markdown
| `GET /api/sessions/:nodeId/transcript?query=` | Matching passages of the transcript; on a fork, only the records after the fork point (`starts_at_fork_point: true`). 404 `not_on_this_machine` when it lives on the other machine |
```
**Impact:** Documentation only.

## Principles applied

- Laziness protocol: the plan does not edit `src/sessions/search.ts` or `src/http/sessionsApi.ts`, though the scope names both. `search.ts`'s `SessionSearchHit` is never serialized: `readModel.ts phase6Search` keeps only `session_id`, score and via lists, and hits are rebuilt from `NODE_SELECT` in `searchNodes`. So fork columns there would be dead. The routes return read-model payloads as they are, so the new fields reach `/api` with no route edit.
- Laziness protocol: `claude/hooks/notes-prompt.mjs` is not changed. It prints the route's `context` text, so the new lines reach the hook through `formatContext` alone.
- Make illegal states unrepresentable: `fork` is derived in one place (`forkPoint`) and only from `parent_link_source === 'fork'` with a parent node id, so a node can never show a fork object while its link says `env`. `job_id` comes only from a live entry, and that entry exists only for this host, so a session on another host can never carry an attach command.
- Boundary discipline: the "is this a background job" rule (`kind === 'bg'`) is applied once, in `liveFromRegistry` at the registry boundary. `LiveEntry.jobId` is non-null only for jobs. View code trusts it and never looks at `kind`.
- DRY wording (Laziness: reuse over new): `forkPointText` and `resumeCommand` in `view.ts` produce the fork and way-back-in strings for both the hook context and the MCP tools, so the two surfaces cannot drift.
- Test behavior, not implementation: the tests assert what callers see: the JSON fields, the context text, and the transcript matches with their file line numbers. They drive the real Hono routes and the real MCP server against Postgres. Nothing is mocked except the live registry and search seams the read model already exposes.
- Prove it works: Proof drives a throwaway daemon with verify-notesd over MCP and HTTP, with a real registry file, not only the unit tests.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int -- tests/integration/sessions.forkWording.int.test.ts tests/integration/sessions.api.int.test.ts tests/integration/sessions.mcp.int.test.ts` (then the full `npm run test:int`)
**Proof:** a throwaway daemon built from this worktree. One fixture session is seeded as a fork and made a live background job. It is then read back over MCP `session_transcript` / `session_get` / `sessions_search` and the hook's context route.
- Harness: `.claude/skills/verify-notesd`
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md`
- Run-level script. The verifier writes it to its scratchpad as `phase5-proof.sh` and runs `bash <scratchpad>/phase5-proof.sh` from the worktree root `/home/miftah/.worktrees/mcp-notes/session-fork-awareness`. It prints `J4 PASS`, `J5 PASS`, `J6 PASS` and `NEIGHBOR PASS`, or `FAIL: …` with the body that failed. It always runs `down` on exit.
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  V=.claude/skills/verify-notesd/scripts/verify.sh
  fail() { echo "FAIL: $*" >&2; exit 1; }
  eval "$(NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions | grep -E '^(RUN|URL|EVIDENCE)=')"
  JOBPID=""
  cleanup() { if [ -n "$JOBPID" ]; then kill "$JOBPID" 2>/dev/null || true; fi; $V down "$RUN" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  P=5e55a001-0000-4000-8000-000000000001
  F=5e55a001-0000-4000-8000-000000000005
  FIX=tests/fixtures/claude-home/projects/-home-u-mcp-notes/$F.jsonl
  mcp() { $V mcp "$RUN" "$1" "$2" | sed 1d; }
  q() { jq -nc --arg n "$1" --arg q "$2" '{node_id: $n, query: $q}'; }
  S=""
  for _ in $(seq 60); do
    S=$(curl -sf "$URL/api/projects/mcp-notes/sessions" || true)
    if [ -n "$S" ] && [ "$(jq --arg p "$P" --arg f "$F" '[.nodes[] | select(.session_id == $p or .session_id == $f)] | length' <<<"$S")" = 2 ]; then break; fi
    sleep 1
  done
  PN=$(jq -r --arg s "$P" '.nodes[] | select(.session_id == $s) | .node_id' <<<"$S")
  FN=$(jq -r --arg s "$F" '.nodes[] | select(.session_id == $s) | .node_id' <<<"$S")
  { [ -n "$PN" ] && [ -n "$FN" ]; } || fail "fixture sessions were not ingested"
  echo "RUN=$RUN PN=$PN FN=$FN"

  # Baseline before seeding: fixture prompt 1 (file line 2) is found and nothing is cut.
  B=$(mcp session_transcript "$(q "$FN" '"step 1 of"')")
  jq -e '.total_matches == 1 and .matches[0].line == 2 and .starts_at_fork_point == false' <<<"$B" >/dev/null || fail "baseline: $B"

  # Seed: FN becomes a fork of PN, cut after file line 3 (prompt 1 and its reply were "copied").
  CUT=$(head -n 3 "$FIX" | wc -c)
  # cc_sessions_fork_info_check (phase 1) keeps fork_detected_by, fork_cut_offset and fork_prompt_count together.
  # When phase 3 is in the tree, wait for its one-time fork backfill first (the marker row; absent before phase 3,
  # so the loop just times out harmlessly). The backfill skips rows already linked `fork` and never re-reads …0005
  # (no shared head uuid, no job record), and a later tail read keeps the stored fork columns (phase 2 merge).
  for _ in $(seq 20); do $V sql "$RUN" "select key from app_settings where key like 'sessions.forks.backfill.%'" | grep -q 'sessions.forks.backfill.' && break; sleep 1; done
  $V exec "$RUN" "update cc_sessions set parent_session_id = '$P', parent_link_source = 'fork', forked_at = '2026-10-20T01:02:30Z', fork_prompt_count = 1, fork_cut_offset = $CUT, fork_detected_by = 'uuid', updated_at = now() where session_id = '$F'" >/dev/null
  $V sql "$RUN" "select node_id, parent_link_source, forked_at, fork_prompt_count, fork_cut_offset from cc_sessions where session_id = '$F'"

  # J4 (R2.4): the copied prompt is no longer found; the fork's own prompt is, at its file line.
  A=$(mcp session_transcript "$(q "$FN" '"step 1 of"')")
  jq -e '.total_matches == 0 and .starts_at_fork_point == true' <<<"$A" >/dev/null || fail "J4 copied record still searched: $A"
  O=$(mcp session_transcript "$(q "$FN" '"step 2 of"')")
  jq -e '.total_matches == 1 and .matches[0].line == 4' <<<"$O" >/dev/null || fail "J4 own record: $O"
  H=$(curl -sf "$URL/api/sessions/$FN/transcript?query=%22step%201%20of%22")
  jq -e '.total_matches == 0 and .starts_at_fork_point == true' <<<"$H" >/dev/null || fail "J4 API: $H"
  echo "J4 PASS"; $V note "$RUN" "J4: session_transcript on fork $FN skips the copied prefix (cut $CUT bytes)"

  # J5 (R4.1): session_get, sessions_search and the hook context say fork of PN with the fork point.
  G=$(mcp session_get "{\"node_id\":\"$FN\"}")
  jq -e --arg p "$PN" '.session.parent_link_source == "fork" and .session.fork.parent_node_id == $p and .session.fork.prompt_count == 1 and .session.fork.forked_at == "2026-10-20T01:02:30.000Z" and (.session.fork_of | startswith("fork of " + $p + " (after prompt 1, 2026-10-20 "))' <<<"$G" >/dev/null || fail "J5 session_get: $G"
  SR=$(mcp sessions_search "$(jq -nc --arg q "$FN" '{query: $q, limit: 50}')")
  jq -e --arg f "$FN" --arg p "$PN" '[.hits[] | select(.node_id == $f)][0].fork_of | startswith("fork of " + $p + " (after prompt 1, 2026-10-20 ")' <<<"$SR" >/dev/null || fail "J5 sessions_search: $SR"
  C=$(curl -sf "$URL/api/sessions/context?ids=$FN")
  jq -e --arg p "$PN" '.context | contains("Fork of " + $p + " (after prompt 1, 2026-10-20 ") and (contains("Parent:") | not)' <<<"$C" >/dev/null || fail "J5 context: $C"
  D=$(curl -sf "$URL/api/sessions/$PN")
  jq -e --arg f "$FN" --arg p "$PN" '[.children[] | select(.node_id == $f)][0].fork.parent_node_id == $p' <<<"$D" >/dev/null || fail "J5 children: $D"
  echo "J5 PASS"; $V note "$RUN" "J5: $FN described as fork of $PN in session_get, sessions_search, hook context, children"

  # J6 (R4.3): a live background job gets claude attach, never claude --resume.
  sleep 900 >/dev/null 2>&1 & JOBPID=$!
  printf '{"pid":%d,"sessionId":"%s","cwd":"/home/u/mcp-notes","kind":"bg","jobId":"5e55a005","status":"idle","updatedAt":%s}\n' "$JOBPID" "$F" "$(date +%s000)" >"$(dirname "$EVIDENCE")/claude/sessions/$JOBPID.json"
  C2=$(curl -sf "$URL/api/sessions/context?ids=$FN")
  jq -e '.context | contains("(attach with: claude attach 5e55a005)") and (contains("claude --resume") | not)' <<<"$C2" >/dev/null || fail "J6 context: $C2"
  G2=$(mcp session_get "{\"node_id\":\"$FN\"}")
  jq -e '.session.live == true and .session.job_id == "5e55a005" and .session.resume_command == "claude attach 5e55a005"' <<<"$G2" >/dev/null || fail "J6 session_get: $G2"
  echo "J6 PASS"; $V note "$RUN" "J6: live background job $FN answers claude attach 5e55a005"

  # Neighbor: an ordinary session keeps its Parent/resume wording and has no fork.
  CP=$(curl -sf "$URL/api/sessions/context?ids=$PN")
  jq -e --arg p "$P" '.context | contains("resume with: claude --resume " + $p) and (contains("Fork of") | not)' <<<"$CP" >/dev/null || fail "NEIGHBOR context: $CP"
  GP=$(mcp session_get "{\"node_id\":\"$PN\"}")
  jq -e --arg p "$P" '.session.fork == null and .session.fork_of == null and .session.job_id == null and .session.resume_command == ("claude --resume " + $p)' <<<"$GP" >/dev/null || fail "NEIGHBOR session_get: $GP"
  echo "NEIGHBOR PASS"
  ```
- Journeys:
  - **J1** · traces R4.1, R4.3 — `npx vitest run tests/unit/sessions.view.test.ts` → passes when the `forks and background jobs` block is green. That proves a fork row maps to `fork: { parent_node_id: "DM-OV", forked_at: "2026-11-11T01:37:02.342Z", prompt_count: 12 }`; `formatContext` prints `Fork of DM-OV (after prompt 12, 2026-11-11 08:37 Asia/Jakarta)` and no `Parent:` line; a live `bg` entry prints `(attach with: claude attach e3650501)` and no `claude --resume`. The existing `Parent: B1-22 (env link)` and `resume with: claude --resume sess-1` assertions also stay green.
  - **J2** · traces R2.4 — `npx vitest run tests/unit/sessions.transcriptSearch.test.ts` → passes when `searchTranscript(..., { startOffset: cut })` returns exactly `[[3, 'uuid-less photo line'], [4, 'own photo question']]` while the uncut search finds 4 matches.
  - **J3** · traces R2.4, R4.1, R4.3 — `npm run test:int -- tests/integration/sessions.forkWording.int.test.ts` → passes when all 4 tests are green. That proves:
    - over the real routes and MCP server, F5-55 has `fork` / `job_id` on detail, children, graph and search;
    - the context text contains `Fork of A0-3G (after prompt 1, 2026-11-01 02:00 Asia/Jakarta)` and `(attach with: claude attach f5f5f5f5)`;
    - `session_get` gives `fork_of: "fork of A0-3G (after prompt 1, 2026-11-01 02:00 Asia/Jakarta)"` and `resume_command: "claude attach f5f5f5f5"`, and `sessions_search` gives the same `fork_of`;
    - `session_transcript` finds 0 matches for the copied `recycle bin` and 1 match at line 4 for `photo delete`, with `starts_at_fork_point: true`.
  - **J4** · traces R2.4 — `bash <scratchpad>/phase5-proof.sh` (baseline and J4 section) → passes when, on the verify daemon, `session_transcript` for fixture `…0005` finds `"step 1 of"` at line 2 before seeding. After `fork_cut_offset` is seeded it finds 0 matches with `starts_at_fork_point: true`, still finds `"step 2 of"` at line 4, and `GET /api/sessions/$FN/transcript` agrees. The script prints `J4 PASS`.
  - **J5** · traces R4.1 — same script, J5 section → passes when MCP `session_get` `.session.fork_of` and `sessions_search` `.hits[].fork_of` for `$FN` both start with `fork of $PN (after prompt 1, 2026-10-20 `. `GET /api/sessions/context?ids=$FN` `.context` must contain `Fork of $PN (after prompt 1, 2026-10-20 ` and no `Parent:`, and `$PN`'s detail lists `$FN` among its children with `fork.parent_node_id == $PN`. The script prints `J5 PASS`.
  - **J6** · traces R4.3 — same script, J6 section, after a registry file `{"kind":"bg","jobId":"5e55a005"}` is written for a live `sleep` pid in the run's `CLAUDE_HOME/sessions` → passes when the hook context route for `$FN` contains `(attach with: claude attach 5e55a005)` and no `claude --resume`, and MCP `session_get` returns `live: true`, `job_id: "5e55a005"`, `resume_command: "claude attach 5e55a005"`. The script prints `J6 PASS`.
- Neighbor check: the hook context and `session_get` of ordinary sessions, the most likely to break because `formatContext` and the node mappers were rewritten. Run the same script's NEIGHBOR section: for fixture `…0001` the context must still contain `resume with: claude --resume 5e55a001-0000-4000-8000-000000000001` and no `Fork of`, and `session_get` must give `fork: null`, `fork_of: null`, `job_id: null` and `resume_command: "claude --resume 5e55a001-…0001"`. The script prints `NEIGHBOR PASS`. `npx vitest run tests/unit/sessions.view.test.ts` keeps `Parent: B1-22 (env link)` green.
- Cost: none. `NOTESD_CLAUDE_BIN=/nonexistent/claude` keeps the summary worker off, there is no `--embed`, and resume is never driven.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` are green. `phase5-proof.sh` prints `J4 PASS`, `J5 PASS`, `J6 PASS` and `NEIGHBOR PASS` on a verify-notesd run, and its evidence directory holds the `mcp-session_transcript`, `mcp-session_get` and `mcp-sessions_search` files.

## Handoffs

- **Phase 1 (reconciled):** phase 1 makes `view.ts`'s `ParentLinkSource` a re-export of the schema type (gains `'fork'`), so phase 5's Step 1 fallback ("widen the alias here too") is not needed.
- **Phase 4 (reconciled):** `liveFromRegistry` uses phase 4's `backgroundJobId(e)`. `src/mcp/sessionTools.ts` is shared: phase 4 (earlier) edits line 5 and from line 276 on; phase 5 edits line 8 and lines 9-186 of the file as phase 4 leaves it.
- **Phase 1/2 (reconciled):** `searchTranscript` calls the shared `isCopiedRecord` (phase 1). Phase 5 also assumes `fork_cut_offset` is non-null on every fork with a known cut, including a pending one, and null on every non-fork.
- **README (reconciled):** phase 5 documents its own fields in the README tool rows (Step 11), because phase 3 is not ordered after phase 5. CLAUDE.md stays phase 3's alone: its sessions paragraph is one line, and the wire fields belong in the README tables.
- **Phase 6 (wall):** consumes `fork` and `job_id` exactly as written in the Interface Contract wire shapes. It also edits `.claude/skills/verify-notesd/features/projects.md`; phase 5 adds one sub-feature bullet and one driving block there, so the two edits should be appended, not merged into one bullet. The R4.2 and R3.5 journeys belong to phase 6.
- **Left alone on purpose:** the MCP server instructions' Sessions paragraph (`src/mcp/instructions.ts:59`) could mention forks and `claude attach`. The tool descriptions already carry the meaning, so it is not changed here; it is a follow-up candidate, not part of any criterion.

## Rollback

Revert this phase's commit. It has no migration and no data write: the fork columns it reads belong to phase 1, and the only runtime state it touches is the live registry, read-only. After a revert, the API and MCP lose `fork`, `job_id`, `fork_of`, `resume_command` and `starts_at_fork_point`, and the hook context goes back to `Parent: <id> (fork link)` / `claude --resume`. Nothing else depends on these fields except phase 6, which must be reverted first if it has landed.
