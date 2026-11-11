# Phase 6: Wall: fork edge, badge, fork point, attach notices

**Plan set:** `SESSION_FORK_AWARENESS_PLAN.md`
**Analysis:** `.workflows/analyze/20261111-093332-K7F2_code_analyzer.md`
**Satisfies:** R3, R4 — the wall shows a fork as a child of its parent (fork edge, fork badge, fork point) and turns a background-job resume into a notice naming `claude attach <jobId>`
**Criteria:** R3.5, R4.2
**Depends on:** Phase 4, Phase 5
**Difficulty:** NORMAL
**Package:** `web/src`

---

## Goal

After this phase the `/projects` graph draws a fork as a child of its parent along a dotted fork
edge, marks the fork's row with an icon-only Phosphor `GitFork` badge, and the node panel says
`forked from <node> after prompt N` with the fork time. The panel's resume button reads
"Attach to the background session" for a live background job. An `attached` answer (or a 409 for a
live job) shows a notice naming `claude attach <jobId>` instead of a raw error code.

## Interface Contract

Reconciled against the phase 4 and phase 5 plans as written (their Interface Contracts):

- **Phase 5 wire:** every node shape in `GET /api/projects/:repo/sessions` (`nodes[]`),
  `GET /api/sessions/:nodeId` (`session`, `parent`, `children[]`) and `GET /api/sessions/search`
  (`hits[]`) carries `fork: { parent_node_id: string, forked_at: string | null, prompt_count: number | null } | null`
  (non-null exactly when `parent_link_source === "fork"` and `parent_node_id` is set; `forked_at`
  ISO 8601 UTC; `prompt_count` 0 = before any prompt) and `job_id: string | null` (non-null exactly
  when the session is live on this host as a background job, decided by phase 4's
  `backgroundJobId`, e.g. `e3650501`). `parent_link_source` can be `"fork"`.
- **Phase 4 wire:** `POST /api/sessions/:nodeId/resume` answers 200 with a union on `action`:
  `{ action: "attached", job_id: string, window?, prompt_delivered?: false }` (`job_id` always
  present; `prompt_delivered: false` present only when a prompt was given and could not be typed),
  `{ action: "focused" | "messaged", window?, job_id? }` (`job_id` when the pane is a background
  job's attach pane), or `{ action: "resumed" | "spawned", window?, cwd?, original_cwd? }`. No new
  error code: a live background job never answers 409; a live non-background session outside tmux
  still answers 409 `live_outside_tmux`. The wall's 409-with-`job_id` notice (Step 4) is a
  defensive fallback for an older daemon and stays.

The web side still reads every one of these defensively (`ResumeResult.job_id` optional, a missing
field reads as `null` / absent), so this phase builds and passes on its own. The proof journeys
J3/J4 need phases 1, 4 and 5 merged.

**Deletes:** `LaidEdge.heuristic` (`web/src/lib/sessionGraph.ts:67`), replaced by `LaidEdge.style`. The local `ParentLinkSource` union in `web/src/sessionDetailApi.ts:6` becomes a re-export of `types.ts`'s.
**Renames:** none
**Creates:** `ForkPoint` (`web/src/types.ts`), `EdgeStyle` and `FORK_ICON` (`web/src/lib/sessionGraph.ts`), module `web/src/lib/parentLink.ts` (`parseParentLinkSource`, `parseForkPoint`, `liveJobId`, `forkAfter`, `forkLabel`), fixture `forkOf` (`web/src/testing/sessionFixtures.ts`)
**Signature changes:**
- `ParentLinkSource`: `'env' | 'hook' | 'heuristic'` -> `'fork' | 'env' | 'hook' | 'heuristic'` (`web/src/types.ts:192`)
- `SessionNode` gains `fork: ForkPoint | null`, `job_id: string | null`
- `SessionDetail` gains `fork: ForkPoint | null`, `job_id: string | null`
- `ResumeResult` gains optional `job_id?: string`, `prompt_delivered?: boolean`
- `resumeErrorNotice(err, d: Pick<SessionDetail,'node_id'|'host'>)` -> `resumeErrorNotice(err, d: Pick<SessionDetail,'node_id'|'host'> & Partial<Pick<SessionDetail,'job_id'>>)`
- `LaidEdge.heuristic: boolean` -> `LaidEdge.style: EdgeStyle` (`'plain' | 'heuristic' | 'fork'`)
**Requires (from earlier phases):** the phase 5 and phase 4 wire fields above. The `cc_sessions` columns `forked_at`, `fork_prompt_count`, `fork_detected_by`, `fork_cut_offset` and the `fork` value in the parent-link check (Phase 1) are needed by the proof seed only; `cc_sessions_fork_info_check` requires `fork_detected_by`, `fork_cut_offset` and `fork_prompt_count` to be set together.
**Leaves alone (owned by others):** all of `src/**`, `drizzle/**`, `tests/**`, `claude/**` (phases 1 to 5). `README.md` and `CLAUDE.md` belong to phases 3 and 5. `web/src/styles.css` is listed in this phase's scope but is not changed: the graph and panel styles live in `SessionGraph.css` and `NodePanel.css`.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/types.ts:191-240` | modify | `ParentLinkSource` gains `'fork'`, new `ForkPoint`, `SessionNode.fork` / `.job_id` |
| `web/src/lib/parentLink.ts` | create | wire parsers for link source / fork point / live job id, fork wording |
| `web/src/sessionsApi.ts:1-55` | modify | `normalizeSessionNode` reads `fork`, `job_id`, accepts `'fork'` |
| `web/src/sessionDetailApi.ts:1-283` | modify | `SessionDetail.fork` / `.job_id`, parent falls back to the fork's parent, `ResumeResult` fields, `attached` and background-job notices |
| `web/src/lib/sessionGraph.ts:5-68,284-299` | modify | `EdgeStyle`, `LaidEdge.style`, `FORK_ICON` |
| `web/src/components/graph/GraphEdges.tsx:27-29` | modify | edge class from `style` (`gedge fork`) |
| `web/src/components/graph/GraphNode.tsx:1-120` | modify | `GitFork` badge in the label gap, `fork of <id>` in the row's aria-label |
| `web/src/components/graph/SessionGraph.css:7` | modify | `.gedge.fork`, `.gnode-fork` |
| `web/src/components/graph/NodePanel.tsx:3,178,276-287,498-517` | modify | `ParentLine` fork wording + time, resume tip for a live background job, pass `job_id` to the error notice |
| `web/src/components/graph/NodePanel.css:25` | modify | `.np-fork` icon |
| `web/src/testing/sessionFixtures.ts` | modify | `fork: null, job_id: null` defaults, `forkOf` |
| `web/src/sessionsApi.test.tsx:16-42` | modify | expected node gains `fork`, `job_id`; new fork test |
| `web/src/sessionDetailApi.test.tsx` | modify | fork/job normalisation, resume fields, attach notices |
| `web/src/lib/sessionGraph.test.tsx:106-111` | modify | heuristic test on `style`; fork edge test |
| `web/src/components/graph/SessionGraph.test.tsx` | modify | fork edge class and badge |
| `web/src/components/graph/NodePanel.test.tsx` | modify | fork parent line, attach tip and notices |
| `.claude/skills/verify-notesd/features/projects.md` | modify | fork / background-job sub-feature and how to drive it |

## Implementation Steps

Run `npm ci` in the worktree first if `node_modules` is missing (the worktree had none when this was
planned; `verify.sh up` refuses to start without it).

### Step 1: Wire types
**File:** `web/src/types.ts:191-192` and `:238-240`
**Change:** Widen `ParentLinkSource` and add `ForkPoint`. Add two fields at the end of `SessionNode`.
**Code:** replace lines 191-192:
```ts
/** How a parent link was found: Claude Code fork record, swarm env var, SessionStart/Bash hook, or transcript heuristic. */
export type ParentLinkSource = 'fork' | 'env' | 'hook' | 'heuristic';

/**
 * Where a fork left its parent (session-fork-awareness phase 5 wire `fork`). `prompt_count` is how
 * many of the parent's prompts the fork copied ("after prompt N"); `forked_at` is the fork boundary.
 */
export interface ForkPoint {
  parent_node_id: string;
  forked_at: string | null;
  prompt_count: number | null;
}
```
and replace the last two lines of `SessionNode` (`:238-240`):
```ts
  /** Phase 13: orch node with pending ledger phases and no live session. Null until phase 13. */
  unfinished: boolean | null;
  /** Set when this session is a fork of another (its parent link source is then `fork`). */
  fork: ForkPoint | null;
  /** Claude Code background job id while the session is live as one (`claude attach <job_id>`); null otherwise. */
  job_id: string | null;
}
```
**Impact:** every `SessionNode` literal must now carry `fork` and `job_id`. There are exactly three:
`normalizeSessionNode` (Step 3), `makeSession` (Step 10) and the expected object in
`sessionsApi.test.tsx` (Step 11).

### Step 2: Wire parsers and fork wording, in one place
**File:** `web/src/lib/parentLink.ts` (new)
**Change:** Both normalisers (graph node and session detail) parse the same three wire fields, and the
graph badge and the panel say the same fork point. Put that logic here once.
**Code:**
```ts
import type { ForkPoint, ParentLinkSource } from '../types';

const SOURCES: readonly ParentLinkSource[] = ['fork', 'env', 'hook', 'heuristic'];

/** A wire `parent_link_source`, or null for a missing or unknown one. */
export function parseParentLinkSource(v: unknown): ParentLinkSource | null {
  return typeof v === 'string' && (SOURCES as readonly string[]).includes(v) ? (v as ParentLinkSource) : null;
}

/** A wire `fork` object, or null when it is absent or names no parent node. */
export function parseForkPoint(v: unknown): ForkPoint | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const parent = typeof o.parent_node_id === 'string' && o.parent_node_id.trim() !== '' ? o.parent_node_id : null;
  if (parent === null) return null;
  const at = typeof o.forked_at === 'string' && o.forked_at.trim() !== '' ? o.forked_at : null;
  const n = o.prompt_count;
  const count = typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
  return { parent_node_id: parent, forked_at: at, prompt_count: count };
}

/** A background job id only means something while the session runs: null unless `live`. */
export function liveJobId(v: unknown, live: boolean): string | null {
  return live && typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** The fork point as the parent's prompt count: " after prompt N", " before its first prompt", or "". */
export function forkAfter(f: ForkPoint): string {
  if (f.prompt_count === null) return '';
  return f.prompt_count === 0 ? ' before its first prompt' : ` after prompt ${f.prompt_count}`;
}

/** "forked from <id> after prompt N": the graph badge's hover text. */
export function forkLabel(f: ForkPoint): string {
  return `forked from ${f.parent_node_id}${forkAfter(f)}`;
}
```
**Impact:** new module, no callers until Steps 3, 4, 7 and 8.

### Step 3: Graph node normaliser
**File:** `web/src/sessionsApi.ts:1-55`
**Change:** Accept `'fork'`, read `fork` and `job_id` (the job id is dropped when the node is not live).
**Code:** replace lines 1-2 (the two imports) with:
```ts
import { ApiError } from './api';
import { liveJobId, parseForkPoint, parseParentLinkSource } from './lib/parentLink';
import type { ProjectSummary, SessionGraphPayload, SessionNode } from './types';
```
and replace `normalizeSessionNode` (lines 24-55) with:
```ts
/** Defensive copy of a phase 7 `GraphNode`: the layout never sees `undefined`. */
export function normalizeSessionNode(n: SessionNode): SessionNode {
  const wire = n as SessionNode & { fork?: unknown; job_id?: unknown };
  const t: Partial<SessionNode['tokens']> = n.tokens ?? {};
  const live = n.live === true;
  return {
    session_id: n.session_id,
    node_id: n.node_id,
    repo: str(n.repo),
    parent_session_id: str(n.parent_session_id),
    parent_node_id: str(n.parent_node_id),
    parent_link_source: parseParentLinkSource(n.parent_link_source),
    title: typeof n.title === 'string' && n.title !== '' ? n.title : n.node_id,
    name: str(n.name),
    custom_title: str(n.custom_title),
    ai_title: str(n.ai_title),
    first_prompt: str(n.first_prompt),
    branch: str(n.branch),
    cwd: str(n.cwd),
    started_at: str(n.started_at),
    last_active_at: str(n.last_active_at),
    host: typeof n.host === 'string' ? n.host : '',
    available: n.available !== false,
    live,
    status: str(n.status),
    tmux: str(n.tmux),
    tokens: { input: num(t.input), output: num(t.output), cache_read: num(t.cache_read), cache_write: num(t.cache_write), total: num(t.total) },
    cost_usd: typeof n.cost_usd === 'number' ? n.cost_usd : null,
    summary_excerpt: str(n.summary_excerpt),
    child_count: num(n.child_count),
    unfinished: typeof n.unfinished === 'boolean' ? n.unfinished : null,
    fork: parseForkPoint(wire.fork),
    job_id: liveJobId(wire.job_id, live),
  };
}
```
**Impact:** an older daemon (no `fork`/`job_id`) yields `null` for both, the same as a non-fork node.

### Step 4: Session detail, resume result and notices
**File:** `web/src/sessionDetailApi.ts`
**Change:**
- line 1-6: import the parsers. Re-export `ParentLinkSource` from `types.ts` instead of redeclaring the union.
- `SessionDetail` (lines 75-79): add `fork` and `job_id`.
- `ResumeResult` (lines 87-91): optional `job_id` and `prompt_delivered`.
- `normalizeSessionDetail` (lines 190-232): read the new fields. A detail with no parent object but a fork falls back to the fork's parent.
- `resumeSession` (lines 244-255): carry `job_id` / `prompt_delivered` when present.
- `resumeNotice` (lines 257-273) and `resumeErrorNotice` (lines 275-283): attach notices.

**Code:** lines 1-6 become:
```ts
import { ApiError } from './api';
import { liveJobId, parseForkPoint, parseParentLinkSource } from './lib/parentLink';
import type { ForkPoint, ParentLinkSource } from './types';

export type { ParentLinkSource } from './types';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };
```
(delete the old `export type ParentLinkSource = 'env' | 'hook' | 'heuristic';` and the old lines 3-4, which are now above).

The end of `SessionDetail` (lines 75-79) becomes:
```ts
  /** `repo` can differ from this session's: a session spawned from another project's session. */
  parent: { node_id: string; name: string | null; repo: string | null } | null;
  parent_link_source: ParentLinkSource | null;
  transcript_path: string | null;
  /** Set when this session is a fork: where it left its parent. */
  fork: ForkPoint | null;
  /** Claude Code background job id while the session is live as one; null otherwise. */
  job_id: string | null;
}
```

`ResumeResult` (lines 87-91) becomes:
```ts
/**
 * What the daemon did (`resumed`, `spawned`, `focused`, `messaged`, `attached`) and the tmux window.
 * `job_id`: the background job behind an `attached` (or a focused/messaged attach pane).
 * `prompt_delivered`: false when a prompt was given but no attach pane could take it yet.
 */
export interface ResumeResult {
  action: string;
  window: string | null;
  job_id?: string;
  prompt_delivered?: boolean;
}
```

`normalizeSessionDetail` (lines 190-232) becomes:
```ts
export function normalizeSessionDetail(raw: Wire): SessionDetail {
  const w = isObj(raw.session) ? raw.session : raw;
  const t = isObj(w.tokens) ? w.tokens : null;
  const parentObj = isObj(raw.parent) ? raw.parent : isObj(w.parent) ? w.parent : null;
  const fork = parseForkPoint(w.fork ?? raw.fork);
  const parentId = str(parentObj?.node_id) ?? str(w.parent_node_id) ?? fork?.parent_node_id ?? null;
  const live = w.live === true;
  const summary = str(w.summary);
  const state = summaryState(w.summary_state);
  return {
    session_id: str(w.session_id) ?? '',
    node_id: str(w.node_id) ?? '',
    repo: str(w.repo),
    host: str(w.host) ?? '',
    available: w.available !== false,
    live,
    unfinished: typeof w.unfinished === 'boolean' ? w.unfinished : null,
    cwd: str(w.cwd),
    branch: str(w.branch),
    name: str(w.name),
    title: str(w.custom_title) ?? str(w.ai_title) ?? str(w.title),
    started_at: str(w.started_at),
    last_active_at: str(w.last_active_at),
    summary,
    summary_state: summary !== null ? 'ready' : state === 'ready' ? null : state,
    summary_requested_at: str(w.summary_requested_at),
    prompts: compact(list(raw.prompts ?? w.prompts).map(prompt)),
    commits: compact(list(raw.commits ?? w.commits).map(commit)),
    notes: compact(list(raw.notes ?? w.notes).map(noteRef)),
    tokens: {
      input: num(t ? t.input : w.input_tokens),
      output: num(t ? t.output : w.output_tokens),
      cache_read: num(t ? t.cache_read : w.cache_read_tokens),
      cache_write: num(t ? t.cache_write : w.cache_write_tokens),
    },
    cost_usd: numOrNull(w.cost_usd),
    cost_estimated: w.cost_estimated === true,
    subagent_count: num(w.subagent_count),
    subagent_cost_usd: numOrNull(w.subagent_cost_usd),
    parent: parentId === null ? null : { node_id: parentId, name: str(parentObj?.title) ?? str(parentObj?.name), repo: str(parentObj?.repo) },
    parent_link_source: parseParentLinkSource(w.parent_link_source),
    transcript_path: str(w.transcript_path),
    fork,
    job_id: liveJobId(w.job_id ?? raw.job_id, live),
  };
}
```

`resumeSession` (lines 244-255) becomes:
```ts
/** `POST /api/sessions/:nodeId/resume` `{fresh?, prompt?}` -> `{action, window?, job_id?, prompt_delivered?}`. Throws `ApiError` (`not_on_this_machine`, 403 from the same-origin guard, ...). */
export async function resumeSession(nodeId: string, opts: ResumeOptions = {}): Promise<ResumeResult> {
  const body: { fresh?: boolean; prompt?: string } = {};
  if (opts.fresh) body.fresh = true;
  const p = opts.prompt?.trim();
  if (p) body.prompt = p;
  const res = await fetch(`/api/sessions/${enc(nodeId)}/resume`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  const o = isObj(j) ? j : {};
  const jobId = str(o.job_id);
  return {
    action: str(o.action) ?? 'unknown',
    window: str(o.window),
    ...(jobId !== null ? { job_id: jobId } : {}),
    ...(typeof o.prompt_delivered === 'boolean' ? { prompt_delivered: o.prompt_delivered } : {}),
  };
}
```

`resumeNotice` and `resumeErrorNotice` (lines 257-283) become:
```ts
/** The panel's one-line report of a successful resume / spawn / attach. */
export function resumeNotice(r: ResumeResult, fresh: boolean): string {
  const where = r.window ? ` in ${r.window}` : '';
  const attach = r.job_id ? `claude attach ${r.job_id}` : null;
  switch (r.action) {
    case 'resumed':
      return `Resumed${where}`;
    case 'spawned':
    case 'fresh':
      return `Fresh session started${where}`;
    case 'attached': {
      const opened = attach ? `Opened ${attach}${where}` : `Attached to the background session${where}`;
      return r.prompt_delivered === false ? `${opened}; prompt not sent, type it there` : opened;
    }
    case 'focused':
      return attach ? `Background job, focused ${attach}${where}` : `Already running, focused${where}`;
    case 'messaged':
      return attach ? `Background job, prompt sent to ${attach}${where}` : `Already running, prompt sent${where}`;
    default:
      return `${fresh ? 'Fresh session' : 'Resume'}: ${r.action}${where}`;
  }
}

/**
 * The panel's one-line report of a failed resume / spawn. A 409 for a live background job
 * (`no_tmux`, or `live_outside_tmux` from a daemon without phase 4) names the attach command.
 */
export function resumeErrorNotice(err: unknown, d: Pick<SessionDetail, 'node_id' | 'host'> & Partial<Pick<SessionDetail, 'job_id'>>): string {
  if (err instanceof ApiError) {
    if (err.message === 'not_on_this_machine') return `${d.node_id} is not on this machine${d.host ? ` (it ran on ${d.host})` : ''}`;
    if (err.status === 403) return 'Resume only works from the wall on this machine';
    if (err.status === 409 && d.job_id) return `${d.node_id} is background job ${d.job_id}: run claude attach ${d.job_id}`;
    return `Could not resume ${d.node_id}: ${err.message}`;
  }
  return `Could not resume ${d.node_id}`;
}
```
**Impact:** existing callers keep working. `ResumeResult`'s new fields are optional and the error
notice's `job_id` is optional, so the existing `resumeNotice({action, window})` and
`resumeErrorNotice(e, {node_id, host})` calls in tests still typecheck and keep their text.

### Step 5: Edge style instead of a heuristic flag
**File:** `web/src/lib/sessionGraph.ts:12-13`, `:56-68`, `:297`
**Change:** Replace `LaidEdge.heuristic: boolean` with one `style` value, so an edge can never be marked
both heuristic and fork. Add the badge size constant next to `LABEL_GAP`, which it must fit inside.
**Code:** after line 12 (`export const LABEL_GAP = 16;`) insert:
```ts
/** The fork badge (Phosphor GitFork) sits in the LABEL_GAP just left of the node id: it must stay narrower. */
export const FORK_ICON = 12;
```
Replace `LaidEdge` (lines 56-68) with:
```ts
/** How an edge is drawn: from its child's parent link source. */
export type EdgeStyle = 'plain' | 'heuristic' | 'fork';

export interface LaidEdge {
  /** Session ids. */
  parent: string;
  child: string;
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  /** Row span the edge's lane is occupied over (inclusive). */
  top: number;
  bottom: number;
  style: EdgeStyle;
}

function edgeStyle(n: SessionNode): EdgeStyle {
  if (n.parent_link_source === 'fork') return 'fork';
  return n.parent_link_source === 'heuristic' ? 'heuristic' : 'plain';
}
```
and in `layoutGraph` replace line 297 (`heuristic: laid.node.parent_link_source === 'heuristic',`) with:
```ts
      style: edgeStyle(laid.node),
```
**Impact:** `GraphEdges.tsx` (Step 6) and `sessionGraph.test.tsx:110` (Step 12) are the only readers of
the old flag. A fork stays a child in the forest: `buildForest` keys on `parent_session_id`, which phase 1/2
set for a fork, so no layout change is needed.

### Step 6: Fork edge class
**File:** `web/src/components/graph/GraphEdges.tsx:2,27-29`
**Change:** Class from the edge style.
**Code:** line 2 becomes:
```ts
import { ROW_H, edgePath, edgesInRange, laneX, rowY, type EdgeStyle, type GraphLayout } from '../../lib/sessionGraph';
```
insert after the `GraphEdgesProps` interface (after line 9):
```ts
const EDGE_CLASS: Record<EdgeStyle, string> = { plain: 'gedge', heuristic: 'gedge heur', fork: 'gedge fork' };
```
and lines 27-29 become:
```tsx
      {edgesInRange(layout, first, last).map((e) => (
        <path key={e.child} className={EDGE_CLASS[e.style]} d={edgePath(e)} data-edge={e.child} />
      ))}
```
**Impact:** the existing `.gedge.heur` look is kept.

### Step 7: Fork badge on the graph row
**File:** `web/src/components/graph/GraphNode.tsx:1-3`, `:42`, `:80-84`
**Change:** Draw an icon-only `GitFork` badge in the 16 px label gap left of the node id, with a
`<title>` hover text (`forked from <id> after prompt N`). Add `, fork of <id>` to the row's aria-label.
Placing the badge in the label gap means no layout column is added, so `titleOffset` / `graphWidth`
stay as they are and the unfinished badge slot is untouched.
**Code:** lines 1-3 become:
```tsx
import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Devices, GitFork } from '@phosphor-icons/react';
import { forkLabel } from '../../lib/parentLink';
import { CHIP_W, FORK_ICON, GUTTER_W, ID_W, ROW_H, fmtDay, fmtTime, nodeTitle, titleOffset, type LaidNode } from '../../lib/sessionGraph';
```
line 42 becomes:
```tsx
  const label = `${node.node_id} ${title}${node.fork ? `, fork of ${node.fork.parent_node_id}` : ''}${node.live ? ', running' : ''}${remote ? `, on ${node.host || 'another device'}` : ''}`;
```
and between the dot (line 81) and the id text (line 82) insert:
```tsx
      {node.fork && (
        <g className="gnode-fork" data-testid="fork-badge" role="img" aria-label={`fork of ${node.fork.parent_node_id}`}>
          <title>{forkLabel(node.fork)}</title>
          <GitFork x={labelX - FORK_ICON - 2} y={y - FORK_ICON / 2} size={FORK_ICON} weight="bold" aria-hidden="true" />
        </g>
      )}
```
**Impact:** the badge spans `labelX-14 .. labelX-2`. The rightmost lane's dot ends at
`labelX - LABEL_GAP - LANE_W/2 + 6 = labelX - 20`, so the badge never overlaps a dot.

### Step 8: Styles
**File:** `web/src/components/graph/SessionGraph.css:7` (insert after) and `web/src/components/graph/NodePanel.css:25` (insert after `.np-src`)
**Code:** SessionGraph.css, after `.gedge.heur { stroke-dasharray: 3 4; }`:
```css
/* A fork: round dots in the id colour, distinct from the heuristic dashes. */
.gedge.fork { stroke: var(--id); stroke-width: 2.5; stroke-linecap: round; stroke-dasharray: 0 5; }
.gnode-fork { color: var(--id); }
.gnode.sel .gnode-fork { color: var(--fg); }
```
The badge keeps pointer events, so its `<title>` shows on hover. A click on it still selects the row,
because the badge sits inside the row's `<g role="button">` and the click bubbles up.

NodePanel.css, after `.np-src { color: var(--dim); }`:
```css
.np-parent .np-fork { vertical-align: -2px; margin-right: 4px; font-size: 12px; color: var(--id); }
```

### Step 9: Node panel: fork line, attach tip, job-aware errors
**File:** `web/src/components/graph/NodePanel.tsx`
**Change:**
- line 3: import `GitFork`.
- add the import `import { forkAfter } from '../../lib/parentLink';` after line 11.
- line 145 (`text = resumeErrorNotice(e, d);`) is unchanged: `d` is the full `SessionDetail`, so the notice already gets `job_id`.
- line 178: resume tip.
- lines 276-287: pass `fork` and `now` to `ParentLine`.
- lines 498-517: `ParentLine` wording.

**Code:** line 3 becomes:
```tsx
import { ArrowsOut, ChartBarHorizontal, Check, CloudSlash, Copy, GitFork, Graph, LinkSimple, MagicWand, Play, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
```
line 178 becomes:
```tsx
  const resumeTip = detail?.live ? (detail.job_id ? 'Attach to the background session' : 'Focus the running session') : 'Resume in tmux';
```
lines 276-287 become:
```tsx
          {detail.parent && (
            <ParentLine
              parent={detail.parent}
              source={detail.parent_link_source}
              fork={detail.fork}
              now={now}
              onSelect={() => {
                const p = detail.parent;
                if (!p) return;
                if (p.repo !== null && p.repo !== detail.repo) onSelectNode(p.node_id, p.repo);
                else onSelectNode(p.node_id);
              }}
            />
          )}
```
`ParentLine` (lines 498-517) becomes:
```tsx
function ParentLine({
  parent,
  source,
  fork,
  now,
  onSelect,
}: {
  parent: NonNullable<SessionDetail['parent']>;
  source: SessionDetail['parent_link_source'];
  fork: SessionDetail['fork'];
  now: Date;
  onSelect: () => void;
}) {
  return (
    <p className="np-parent">
      {fork && <GitFork className="np-fork" weight="duotone" aria-hidden="true" />}
      {fork ? 'forked from ' : 'from '}
      <button type="button" className="np-link" aria-label={`Open parent ${parent.node_id}`} onClick={onSelect}>
        {parent.node_id}
      </button>
      {fork ? forkAfter(fork) : ''}
      {fork?.forked_at && (
        <time className="np-src" dateTime={fork.forked_at} title={chatTimeTitle(fork.forked_at)}>
          {` · ${chatTime(fork.forked_at, now)}`}
        </time>
      )}
      {parent.name ? `${fork ? ' · ' : ' '}${parent.name}` : ''}
      {source === 'heuristic' && <span className="np-src" data-tip="Linked by matching names in the parent's transcript"> (guessed)</span>}
    </p>
  );
}
```
**Impact:** a non-fork parent line renders exactly as before (`from <id> <name>`, plus `(guessed)`).
`now` is the panel's `Date` (`nowProp ?? clock`), the same value its other times use.

### Step 10: Fixtures
**File:** `web/src/testing/sessionFixtures.ts:34-41`
**Change:** Default the two new fields and add a fork builder.
**Code:** in `makeSession`, replace lines 34-35 (`unfinished: null,` / `...opts,`) with:
```ts
    unfinished: null,
    fork: null,
    job_id: null,
    ...opts,
```
and append after `childOf` (after line 41):
```ts

/** A fork of `parent` that copied `promptCount` of its prompts, forked at its own start time. */
export function forkOf(parent: SessionNode, nodeId: string, minute: number, promptCount = 3, opts: Partial<SessionNode> = {}): SessionNode {
  const at = new Date(SESSION_BASE + minute * 60_000).toISOString();
  return childOf(parent, nodeId, minute, {
    parent_link_source: 'fork',
    fork: { parent_node_id: parent.node_id, forked_at: at, prompt_count: promptCount },
    ...opts,
  });
}
```

### Step 11: API normaliser tests
**File:** `web/src/sessionsApi.test.tsx:40-42` and new test after line 43; `web/src/sessionDetailApi.test.tsx`
**Code:** in the first test's expected object, replace
```ts
      child_count: 0,
      unfinished: null,
    });
```
with
```ts
      child_count: 0,
      unfinished: null,
      fork: null,
      job_id: null,
    });
```
and add after that test (after line 43):
```ts
  it('reads a fork node and keeps a background job id only while live', async () => {
    const fork = { parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          repo: 'r',
          nodes: [
            { session_id: 's1', node_id: 'JM-UJ', parent_link_source: 'fork', parent_node_id: 'DM-OV', fork, live: true, job_id: 'e3650501' },
            { session_id: 's2', node_id: 'A0-3G', parent_link_source: 'fork', fork: { forked_at: null }, live: false, job_id: 'e3650501' },
          ],
        }),
      ),
    );
    const { payload } = await fetchSessionGraph('r');
    const [a, b] = payload!.nodes;
    expect(a!.parent_link_source).toBe('fork');
    expect(a!.fork).toEqual(fork);
    expect(a!.job_id).toBe('e3650501');
    expect(b!.fork).toBeNull();
    expect(b!.job_id).toBeNull();
  });
```
In `sessionDetailApi.test.tsx`, add inside `describe('normalizeSessionDetail', ...)` (before its closing `});` at line 145):
```ts
  it('reads a fork: source, fork point, and the fork parent when no parent object came', () => {
    const fork = { parent_node_id: 'DM-OV', forked_at: '2026-11-11T01:37:02.342Z', prompt_count: 12 };
    const d = normalizeSessionDetail({ session: { node_id: 'JM-UJ', parent_link_source: 'fork', fork, live: true, job_id: 'e3650501' } });
    expect(d.parent_link_source).toBe('fork');
    expect(d.fork).toEqual(fork);
    expect(d.parent).toEqual({ node_id: 'DM-OV', name: null, repo: null });
    expect(d.job_id).toBe('e3650501');
    expect(normalizeSessionDetail({ session: { node_id: 'JM-UJ', live: false, job_id: 'e3650501' } }).job_id).toBeNull();
    expect(normalizeSessionDetail({ session: { node_id: 'A0-3G', parent_link_source: 'nope' } })).toMatchObject({ parent_link_source: null, fork: null, job_id: null });
  });
```
Add inside `describe('resumeSession', ...)`:
```ts
  it('carries the background job and whether the prompt was delivered', async () => {
    stub(200, { action: 'attached', window: 'note:6', job_id: 'e3650501', prompt_delivered: false });
    expect(await resumeSession('JM-UJ', { prompt: 'go on' })).toEqual({ action: 'attached', window: 'note:6', job_id: 'e3650501', prompt_delivered: false });
  });
```
Add inside `describe('notices', ...)`:
```ts
  it('names the background job instead of an error code', () => {
    expect(resumeNotice({ action: 'attached', window: 'note:6', job_id: 'e3650501' }, false)).toBe('Opened claude attach e3650501 in note:6');
    expect(resumeNotice({ action: 'attached', window: 'note:6', job_id: 'e3650501', prompt_delivered: false }, false)).toBe(
      'Opened claude attach e3650501 in note:6; prompt not sent, type it there',
    );
    expect(resumeNotice({ action: 'attached', window: null }, false)).toBe('Attached to the background session');
    expect(resumeNotice({ action: 'focused', window: 'note:6', job_id: 'e3650501' }, false)).toBe('Background job, focused claude attach e3650501 in note:6');
    expect(resumeNotice({ action: 'messaged', window: null, job_id: 'e3650501' }, false)).toBe('Background job, prompt sent to claude attach e3650501');
    const bg = { node_id: 'JM-UJ', host: 'lenovo', job_id: 'e3650501' };
    expect(resumeErrorNotice(new ApiError(409, 'live_outside_tmux'), bg)).toBe('JM-UJ is background job e3650501: run claude attach e3650501');
    expect(resumeErrorNotice(new ApiError(409, 'live_outside_tmux'), { ...bg, job_id: null })).toBe('Could not resume JM-UJ: live_outside_tmux');
  });
```

### Step 12: Graph tests
**File:** `web/src/lib/sessionGraph.test.tsx:2,106-111`; `web/src/components/graph/SessionGraph.test.tsx:6`, new test in `describe('SessionGraph rows')`
**Code:** `sessionGraph.test.tsx` line 2 becomes:
```ts
import { childOf, forkOf, makeSession } from '../testing/sessionFixtures';
```
and replace the heuristic test (lines 106-111) with:
```ts
  it('marks heuristic links on the edge', () => {
    const h = childOf(R1, 'H0-00', 30, { parent_link_source: 'heuristic' });
    const l = layoutGraph([R1, h], new Set([R1.session_id]));
    expect(l.edges).toHaveLength(1);
    expect(l.edges[0]!.style).toBe('heuristic');
  });

  it('lays a fork out as a child of its parent, on a fork edge', () => {
    const f = forkOf(R1, 'F0-00', 31);
    const l = layoutGraph([R1, P1, f], new Set([R1.session_id]));
    expect(at(l, 'F0-00').root).toBe(false);
    expect(at(l, 'F0-00').depth).toBe(1);
    const edge = l.edges.find((e) => e.child === f.session_id)!;
    expect(edge.parent).toBe(R1.session_id);
    expect(edge.style).toBe('fork');
    expect(l.edges.find((e) => e.child === P1.session_id)!.style).toBe('plain');
  });
```
`SessionGraph.test.tsx` line 6 becomes:
```ts
import { childOf, forkOf, makeSession, nodeIdAt } from '../../testing/sessionFixtures';
```
and add inside `describe('SessionGraph rows', ...)`, before its closing `});`:
```ts
  it('draws a fork on a fork edge with a fork badge; a plain child gets neither', () => {
    const fork = forkOf(root, 'F0-00', 7, 12);
    const plain = childOf(root, 'C0-00', 8);
    const { container } = draw([root, fork, plain], new Set([root.session_id]));
    expect(container.querySelector(`[data-edge="${fork.session_id}"]`)!.getAttribute('class')).toBe('gedge fork');
    expect(container.querySelector(`[data-edge="${plain.session_id}"]`)!.getAttribute('class')).toBe('gedge');
    const row = container.querySelector('[data-node="F0-00"]') as Element;
    const badge = row.querySelector('[data-testid="fork-badge"]') as Element;
    expect(badge.getAttribute('aria-label')).toBe('fork of A0-3G');
    expect(badge.querySelector('title')!.textContent).toBe('forked from A0-3G after prompt 12');
    expect(row.getAttribute('aria-label')).toContain('fork of A0-3G');
    expect(container.querySelector('[data-node="C0-00"] [data-testid="fork-badge"]')).toBeNull();
    expect(container.querySelector('[data-node="A0-3G"] [data-testid="fork-badge"]')).toBeNull();
  });
```
(`root` is `makeSession('A0-3G', 0, …)`, defined at the top of that describe.)

### Step 13: Node panel tests
**File:** `web/src/components/graph/NodePanel.test.tsx`, inside `describe('NodePanel', ...)` before its closing `});` (line 356)
**Code:**
```ts
  it('says a fork was forked from its parent after prompt N, with the fork time, and opens the parent', async () => {
    const fork = { parent_node_id: 'B1-11', forked_at: '2026-11-01T02:00:00.000Z', prompt_count: 12 };
    stubFetch({ ...WIRE, parent: { node_id: 'B1-11', name: 'trunk' }, parent_link_source: 'fork', fork });
    const { props, container } = renderPanel();
    const open = await screen.findByRole('button', { name: 'Open parent B1-11' });
    const line = container.querySelector('.np-parent') as HTMLElement;
    expect(line.textContent).toMatch(/^forked from B1-11 after prompt 12 · .+ · trunk$/);
    expect(line.querySelector('time')!.getAttribute('dateTime')).toBe('2026-11-01T02:00:00.000Z');
    expect(screen.queryByText('(guessed)')).toBeNull();
    fireEvent.click(open);
    expect(props.onSelectNode).toHaveBeenCalledWith('B1-11');
  });

  it('shows the fork parent even when the detail carries no parent object', async () => {
    stubFetch({ ...WIRE, parent: null, parent_link_source: 'fork', fork: { parent_node_id: 'B1-11', forked_at: null, prompt_count: 0 } });
    const { container } = renderPanel();
    await screen.findByRole('button', { name: 'Open parent B1-11' });
    expect((container.querySelector('.np-parent') as HTMLElement).textContent).toBe('forked from B1-11 before its first prompt');
  });

  it('offers to attach to a live background job and names claude attach in the notice', async () => {
    const calls = stubFetch({ ...WIRE, live: true, job_id: 'e3650501' }, { status: 200, body: { action: 'attached', window: 'note:6', job_id: 'e3650501' } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to the background session' }));
    expect(await screen.findByText('Opened claude attach e3650501 in note:6')).toBeTruthy();
    expect(posts(calls)).toEqual([{ url: '/api/sessions/A0-3G/resume', method: 'POST', body: {} }]);
  });

  it('turns a 409 for a live background job into the attach command, not the error code', async () => {
    stubFetch({ ...WIRE, live: true, job_id: 'e3650501' }, { status: 409, body: { error: 'live_outside_tmux', pid: 7 } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Attach to the background session' }));
    expect(await screen.findByText('A0-3G is background job e3650501: run claude attach e3650501')).toBeTruthy();
    expect(screen.queryByText(/live_outside_tmux/)).toBeNull();
  });

  it('ignores a background job id on a session that is not running', async () => {
    stubFetch({ ...WIRE, live: false, job_id: 'e3650501' });
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Resume in tmux' })).toBeTruthy();
  });
```
`renderPanel` returns `render(...)`'s result spread with `props`, so `container` is available.

### Step 14: Feature map
**File:** `.claude/skills/verify-notesd/features/projects.md`. Add a sub-feature bullet at the end of `## Sub-features`, and a driving block before `## Gotchas`.

**Shared file (reconciled):** `features/projects.md` gets append-only edits from phases 2, 4, 5 and 6 (and one sentence from phase 3 inside phase 2's bullet). Order, top to bottom, in both `## Sub-features` and the blocks before `## Gotchas`: phase 4's section (wave 1), then phase 2's, then phase 5's, then phase 6's. Phases 2 and 5 can run at the same time and anchor at the same spot; whoever merges second keeps both sides in that order (an append-append conflict, never a rewrite of the other phase's lines).
**Code:** sub-feature bullet (append after the "Expand prompts (R2)" bullet):
```markdown
- Forks (session-fork-awareness R4.2): a Claude Code fork (`--fork-session`, background jobs) is
  its own node and a child of the session it was forked from (`parent_link_source: "fork"`). The
  graph draws its edge as round dots in the id colour (`path.gedge.fork`, `data-edge=<fork session id>`)
  and marks its row with an icon-only GitFork badge left of the node id (`data-testid="fork-badge"`,
  aria-label `fork of <parent>`, hover text `forked from <parent> after prompt N`). The node panel's
  parent line reads `forked from <parent> after prompt N · <fork time> · <parent title>`. API: graph
  nodes and session detail carry `fork: { parent_node_id, forked_at, prompt_count } | null`.
- Background jobs (R3.5): a session live as a Claude Code background job (`job_id` set, live only)
  shows the resume button as "Attach to the background session". An `attached` answer shows
  `Opened claude attach <jobId> in <window>` (plus `; prompt not sent, type it there` when
  `prompt_delivered` is false). A focused/messaged attach pane names the job too. A 409 for a live job
  shows `<NODE> is background job <jobId>: run claude attach <jobId>`, never the raw code.
```
Driving block (insert before `## Gotchas`):
````markdown
Forks and background jobs in the wall. The fixtures hold no fork, so seed one after ingest settles:
fixture `…0005` becomes a fork of `…0001` that copied 3 prompts. A live background job is a registry
file in the run's own CLAUDE_HOME whose pid is a `sleep` you started (never the real `~/.claude`).
Resume is never driven: the steps file answers the resume POST itself with `page.route`.
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --web
P=5e55a001-0000-4000-8000-000000000001; F=5e55a001-0000-4000-8000-000000000005
for i in $(seq 60); do S=$(curl -sf "$URL/api/projects/mcp-notes/sessions") && [ "$(jq --arg f $F '[.nodes[]|select(.session_id==$f)]|length' <<<"$S")" = 1 ] && break; sleep 1; done
PARENT=$(jq -r --arg s $P '.nodes[]|select(.session_id==$s)|.node_id' <<<"$S"); FORK=$(jq -r --arg s $F '.nodes[]|select(.session_id==$s)|.node_id' <<<"$S")
for i in $(seq 20); do $V sql RUN "select key from app_settings where key like 'sessions.forks.backfill.%'" | grep -q 'sessions.forks.backfill.' && break; sleep 1; done   # with phase 3 in the tree: seed after the fork backfill
$V exec RUN "update cc_sessions set parent_session_id='$P', parent_link_source='fork', forked_at='2026-10-01T12:30:00Z', fork_prompt_count=3, fork_cut_offset=0, fork_detected_by='job' where session_id='$F'"
$V api RUN GET /api/projects/mcp-notes/sessions     # FORK: parent_node_id PARENT, parent_link_source "fork", fork.prompt_count 3
sleep 900 & JOBPID=$!
echo "{\"pid\":$JOBPID,\"sessionId\":\"$F\",\"cwd\":\"/home/u/mcp-notes\",\"kind\":\"bg\",\"jobId\":\"5e55a005\",\"status\":\"idle\"}" > "$HOME/.local/state/notesd-verify/RUN/claude/sessions/$JOBPID.json"
$V api RUN GET /api/sessions/$FORK                   # session.live true, session.job_id "5e55a005" (registry cache: up to 2 s)
kill $JOBPID
```
UI selectors: row `g[data-node="<FORK>"]`, badge `getByTestId('fork-badge')` in it, edge
`path[data-edge="<fork session id>"]` (class `gedge fork`), panel `aside.np[data-node="<FORK>"]`,
parent line `.np-parent`, resume button `getByRole('button', { name: 'Attach to the background session' })`,
notice `getByRole('status')`.
````

## Principles applied

- Make illegal states unrepresentable: `LaidEdge.heuristic: boolean` becomes one `style: 'plain' | 'heuristic' | 'fork'` (Step 5), not a second `fork` boolean beside it. `ForkPoint` requires `parent_node_id`, so a fork with no parent cannot be built (Step 2). `job_id` is forced to null unless `live` (`liveJobId`), so the panel never offers "Attach" for a stopped job.
- Boundary discipline: fork/link-source/job parsing happens once, in `lib/parentLink.ts`, called only by the two normalisers. Components read typed `ForkPoint | null` and never re-check the wire. The fork-parent fallback lives in `normalizeSessionDetail`, not in `NodePanel`.
- Laziness protocol: the badge goes in the existing 16 px label gap instead of a new layout column, so `titleOffset`, `graphWidth` and the unfinished-badge slot are unchanged. `ResumeResult`'s new fields and the error notice's `job_id` are optional, so existing callers and tests are untouched. `ParentLinkSource` is re-exported from `types.ts` instead of a second union being widened.
- Prove it works: J3/J4 drive the built wall on a throwaway daemon (seeded fork row, real registry file in the run's CLAUDE_HOME), on top of the jsdom tests.
- Test behavior, not implementation: the tests assert what the user sees (edge class, badge aria-label/title, the panel's text, the notice), not calls into helpers.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-fork-awareness && npm ci && npm run typecheck`
**Tests:** `npm test` (the web part alone: `npx vitest run web/src`)
**Proof:**
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree). J3 and J4 need phases 1, 4 and 5 merged into the tree under test. J1/J2 need only this phase.
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md`
- Journeys:
  - **J1** · traces R4.2 — `npx vitest run web/src/lib/sessionGraph.test.tsx web/src/components/graph/SessionGraph.test.tsx web/src/components/graph/NodePanel.test.tsx web/src/sessionsApi.test.tsx -t "fork"` → passes when the tests "lays a fork out as a child of its parent, on a fork edge", "draws a fork on a fork edge with a fork badge; a plain child gets neither", "says a fork was forked from its parent after prompt N, with the fork time, and opens the parent", "shows the fork parent even when the detail carries no parent object" and "reads a fork node and keeps a background job id only while live" all pass (≥ 5 passed, 0 failed)
  - **J2** · traces R3.5 — `npx vitest run web/src/sessionDetailApi.test.tsx web/src/components/graph/NodePanel.test.tsx -t "background|attach"` → passes when "names the background job instead of an error code", "carries the background job and whether the prompt was delivered", "offers to attach to a live background job and names claude attach in the notice", "turns a 409 for a live background job into the attach command, not the error code" and "ignores a background job id on a session that is not running" pass (≥ 5 passed, 0 failed)
  - **J3** · traces R4.2 — follow the "Forks and background jobs in the wall" block of `features/projects.md` up to and including the `$V api RUN GET /api/projects/mcp-notes/sessions` line, then write the steps file below to `$SCRATCH/fork-steps.mjs` (any scratch dir outside the repo) and run `PARENT=$PARENT FORK=$FORK FORK_SID=$F $V ui RUN $SCRATCH/fork-steps.mjs` → passes when the ui transcript ends `result: PASS`, the screenshot `NN-ui-fork-steps-1-fork.png` shows the dotted edge and the GitFork badge on FORK's row, and the API evidence shows FORK with `"parent_link_source":"fork"` and `fork.parent_node_id` = PARENT
    ```js
    export default async ({ page, base, shot, log }) => {
      const { PARENT, FORK, FORK_SID } = process.env
      await page.goto(`${base}/projects?repo=mcp-notes&node=${FORK}`)
      await page.getByTestId('graph').waitFor()
      const row = page.locator(`g[data-node="${FORK}"]`)
      const badge = row.getByTestId('fork-badge')
      await badge.waitFor()
      const label = await badge.getAttribute('aria-label')
      if (label !== `fork of ${PARENT}`) throw new Error(`badge aria-label: ${label}`)
      const edge = page.locator(`path[data-edge="${FORK_SID}"]`)
      const cls = await edge.getAttribute('class')
      if (cls !== 'gedge fork') throw new Error(`edge class: ${cls}`)
      if ((await page.locator(`g[data-node="${PARENT}"]`).getByTestId('fork-badge').count()) !== 0) throw new Error('parent has a fork badge')
      const line = page.locator(`aside.np[data-node="${FORK}"] .np-parent`)
      await line.waitFor()
      const text = (await line.textContent()) ?? ''
      if (!text.startsWith(`forked from ${PARENT} after prompt 3`)) throw new Error(`parent line: ${text}`)
      await shot('fork')
      log(`fork ${FORK}: badge "${label}", edge "${cls}", panel "${text}"`)
    }
    ```
  - **J4** · traces R3.5 — continue the same run with the registry lines of that block (`sleep 900 &`, the registry `echo`, `$V api RUN GET /api/sessions/$FORK` showing `job_id` `5e55a005`), then write the steps file below to `$SCRATCH/attach-steps.mjs` and run `FORK=$FORK JOB=5e55a005 $V ui RUN $SCRATCH/attach-steps.mjs`, then `kill $JOBPID; $V down RUN` → passes when the transcript ends `result: PASS` with the line `resume POSTs answered by the stub: 1`, and the screenshot shows the notice `Opened claude attach 5e55a005 in verify:1`. The resume POST is answered by `page.route`, so no tmux window or Claude session is started (the skill forbids driving resume). Phase 4's own proof covers the server's `attached` answer; this journey proves the wall's handling of it.
    ```js
    export default async ({ page, base, shot, log }) => {
      const { FORK, JOB } = process.env
      let posts = 0
      await page.route('**/api/sessions/*/resume', async (route) => {
        posts++
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ action: 'attached', window: 'verify:1', job_id: JOB }) })
      })
      await page.goto(`${base}/projects?repo=mcp-notes&node=${FORK}`)
      const panel = page.locator(`aside.np[data-node="${FORK}"]`)
      const btn = panel.getByRole('button', { name: 'Attach to the background session' })
      await btn.waitFor()
      await btn.click()
      await panel.getByRole('status').filter({ hasText: `Opened claude attach ${JOB} in verify:1` }).waitFor()
      if (posts !== 1) throw new Error(`resume POSTs: ${posts}`)
      await shot('attached')
      log(`resume POSTs answered by the stub: ${posts}`)
    }
    ```
- Neighbor check: the plain graph and panel. `npx vitest run web/src` must stay fully green (the "marks heuristic links on the edge", "shows the session: summary, prompts, commits, notes made, tokens, parent" (`(guessed)` still shown), "resumes at once, without a confirm click" (`Resumed in note:4`) and "names the live action \"Focus the running session\"" tests are unchanged and pass). In J3, PARENT's row has no fork badge (asserted in the steps file).
- Cost: none (no LLM turns; the run starts with `NOTESD_CLAUDE_BIN=/nonexistent/claude`, so the summary worker stays off).
**Exit criteria:** `npm run typecheck` and `npm test` pass. J1 and J2 pass. On a tree with phases 1, 4 and 5 merged, J3 and J4 end `result: PASS` with screenshots of the fork edge, the badge, the `forked from … after prompt 3` line and the `claude attach` notice.

## Handoffs

- **Phase 5 (R4.2 data, R4.1):** the wall needs `fork` and `job_id` on both the graph node and the detail `session` object, named exactly as in the Interface Contract. `job_id` must be the short `jobId` that `claude attach` takes. If phase 5 names them differently, the reconciler should change `parseForkPoint` / `liveJobId`'s call sites in Steps 3-4, not the server.
- **Phase 4 (R3.1-R3.3):** the notices expect `job_id` on the `attached` answer (and ideally on `focused`/`messaged` for an attach pane) and `prompt_delivered: false` when a prompt was not typed. Without `job_id` the notice falls back to "Attached to the background session", which does not meet R3.5's "naming the job". So phase 4 must send `job_id` with `attached`.
- **Phases 2/3 (reconciled):** phase 2's real fork fixtures live in a separate home, `tests/fixtures/claude-home-forks`, copied in by hand (its "Forks at ingest" block), not in the `tests/fixtures/claude-home` that `up --sessions` loads. J3 keeps its `exec` seed on `…0005` (no shared head uuid, no job record), so phase 3's fork backfill never selects it, and the seed waits for the backfill marker first. `fork_cut_offset=0` satisfies `cc_sessions_fork_info_check` and cuts nothing, so the fixture's counts and transcript stay as they were.
- **Proof caveat for the verifier:** the J3 seed writes `cc_sessions` directly after ingest settles. If a later ingest pass rewrites the row's fork columns (phase 2 writes them only on a byte-0 read of a detected fork, so it should not), the API shows `fork: null`. Report that as `inconclusive`, not a fail, with the `$V sql RUN "select parent_link_source, forked_at, fork_prompt_count from cc_sessions where session_id='$F'"` evidence.
- `web/src/styles.css` (named in the coordinator's scope) needs no change; noted so no one adds rules there.

## Rollback

Revert this phase's commit. Every change is in `web/src` plus one feature-map file. Nothing is
persisted, and the server keeps sending `fork`/`job_id`, which an older wall ignores. Rebuild
`web/dist` (`npm run build`) and restart the daemon to serve the old wall.
