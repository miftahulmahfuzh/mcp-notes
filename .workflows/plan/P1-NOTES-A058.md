> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 10. Source: `.workflows/plan/project-session-graph/phase-10.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 10: Web: projects rail icon, repo sidebar, SVG graph

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R7 (repo sidebar with server-persisted selection + graph view). The node detail panel and per-project chat, which are also R7, belong to phases 11 and 12.
**Depends on:** Phase 7 (read API: `/api/projects`, `/api/projects/selected`, `/api/projects/:repo/sessions`)
**Difficulty:** HARD
**Package:** `web/`

---

## Goal

The wall gets a Projects view. A Phosphor duotone, icon-only rail button opens `/projects` and expands
the sidebar. In this view the sidebar lists repos instead of tags, and the chosen repo is saved
through `PUT /api/projects/selected`, so both laptops open on the same one. The main area draws the
repo's Claude Code sessions as a custom SVG git-graph. Newest sessions are at the top. Root
sessions sit on a thick trunk in lane 0, and children branch right into lanes, with siblings that
overlap in time side by side. Each subtree starts collapsed behind a `+N` chip. Running nodes pulse,
nodes on the other machine are marked like "uploaded on GPD", and every node shows its id. Only the
rows in the viewport mount, so ~1000 nodes scroll smoothly. Clicking a node sets `?node=`. This phase
leaves slots for the detail panel (phase 11), the project chat (phase 12) and the badge (phase 13),
but does not fill them.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/types.ts`: `ProjectSummary`, `ProjectsPayload`, `ParentLinkSource`, `SessionTokens`, `SessionNode` (mirrors phase 7's `GraphNode` field for field), `SessionGraphPayload` (mirrors phase 7's `GraphPayload`). `View` gains `'projects'`.
- `web/src/sessionsApi.ts`: `GRAPH_LIMIT`, `SessionGraphFetch`, `fetchProjects`, `fetchSelectedProject`, `saveSelectedProject`, `fetchSessionGraph` (sends `If-None-Match`, returns `payload: null` on 304), `normalizeSessionNode`
- `web/src/lib/route.ts`: `PROJECTS_PATH`, `ProjectsRoute`, `NO_PROJECT_ROUTE`, `canonicalNodeId`, `projectsRouteFromLocation`, `projectsHref`
- `web/src/lib/projects.ts`: `PROJECTS_HINT`, `projectHeading`, `projectsCountLine`, `sortProjects`
- `web/src/lib/sessionGraph.ts`: layout + geometry (`buildForest`, `layoutGraph`, `ancestorsOf`, `expandAll`, `visibleRange`, `edgesInRange`, `edgePath`, `laneX`, `rowY`, `labelX`, `graphWidth`, `nodeTitle`, `fmtTime`, `fmtDay`, `dayKey`, `timeOf`, the constants `ROW_H LANE_W GUTTER_W LABEL_GAP OVERSCAN ID_W CHIP_W REMOTE_W BADGE_W TITLE_W TITLE_MAX`, and the types `Forest LaidNode LaidEdge GraphLayout`)
- `web/src/hooks/useProjects.ts`: `useProjects(enabled)` -> `ProjectsStore`
- `web/src/hooks/useSessionGraph.ts`: `useSessionGraph(repo)` -> `SessionGraphStore`, `GRAPH_POLL_MS`
- `web/src/components/graph/SessionGraph.tsx` (+ `SessionGraph.css`), `GraphNode.tsx` (prop `badge?: ReactNode`, the phase 13 slot), `GraphEdges.tsx`
- `web/src/pages/ProjectsPage.tsx` (+ `ProjectsPage.css`). Props: `repo`, `resolving`, `node`, `onSelectNode`, `renderPanel?` (phase 11 slot), `renderBadge?` (phase 13 slot)
- `web/src/components/Rail.tsx`: `PROJECTS_TIP`, prop `onToggleProjects`
- `web/src/testing/sessionFixtures.ts`: `makeSession`, `childOf`, `nodeIdAt`, `SESSION_BASE`

**Signature changes:**
- `hrefForView(view, thread, loc)` -> `hrefForView(view, thread, loc, projects: ProjectsRoute = NO_PROJECT_ROUTE)`. The new parameter is optional, so existing callers and tests keep compiling.
- `RailProps` gains the required `onToggleProjects: () => void`.
- `SidebarProps` gains the required `onToggleProjects: () => void` and the optional `projects?: ProjectSummary[] | null`, `repo?: string | null` and `onPickRepo?: (repo: string) => void`.
- `HeaderProps` gains the optional `projects?: boolean`.
- `BIN_TIP: Record<View, string>` gains the key `projects`.

**Requires (from earlier phases): phase 7's published wire (reconciled; phase 7 owns it):**
1. `GET /api/projects` -> `200 { host: string; selected: string | null; projects: Array<{ repo; sessions; live; last_active_at; first_started_at; hosts: string[] }> }` (most recently active first).
2. `GET /api/projects/selected` -> `200 { repo: string | null }`. `PUT /api/projects/selected` with body `{ repo: string | null }` (JSON, same-origin only) -> `200 { repo }` | `404 { error: 'unknown_repo' }`.
3. `GET /api/projects/:repo/sessions?limit=N[&before=<iso>]` -> `200 GraphPayload` with a weak `ETag`; `304` (empty body) when `If-None-Match` matches; `404 unknown_repo` when the repo has no rows. `GraphPayload = { repo, host, generated_at, total, truncated, next_before, nodes: GraphNode[] }`, nodes newest `started_at` first. `GraphNode` fields: `session_id, node_id, repo, parent_session_id, parent_node_id, parent_link_source, title, name, custom_title, ai_title, first_prompt (<= 200 chars), branch, cwd, started_at, last_active_at, host, available, live, status, tmux, tokens {input, output, cache_read, cache_write, total}, cost_usd, summary_excerpt, child_count, unfinished (null until phase 13)`. This phase asks for `limit=2000` and does not page.
4. Refresh: phase 7 emits **no** SSE event for sessions (decided there: per-append events would be a firehose and the other laptop's writes never reach this daemon's bus). The graph is polled every `GRAPH_POLL_MS` (10 s) while the page is visible, with `If-None-Match`; a 304 keeps the current nodes. The project list is polled every 60 s.

**Leaves alone (owned by others):** every `src/**` server file (phase 7 owns the read API). `NodePanel`/`Timeline` and the body of `renderPanel` (phase 11). `project-pill-query-input`, the graph <-> `project-chat-history` toggle, and `chat_threads.project` on the client (phase 12). The badge content and the meaning of `unfinished` (phase 13). The README and CHANGELOG (phase 14).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/types.ts:86` | modify | `View` += `'projects'`; append session wire types at end of file (after line 166) |
| `web/src/sessionsApi.ts` | create | client for the four project endpoints (graph fetch with ETag / 304) |
| `web/src/sessionsApi.test.tsx` | create | URL/body/default-filling tests |
| `web/src/lib/route.ts` | rewrite (36 lines) | `/projects?repo=&node=` parsing, href building, `hrefForView` 4th arg |
| `web/src/lib/route.test.tsx:42` | modify | append projects route tests before the final `});` |
| `web/src/lib/projects.ts` | create | header heading/hint/count line, repo sort |
| `web/src/lib/projects.test.tsx` | create | count line + sort tests |
| `web/src/lib/sessionGraph.ts` | create | pure forest + lane layout + geometry + virtualization helpers |
| `web/src/lib/sessionGraph.test.tsx` | create | layout unit tests |
| `web/src/testing/sessionFixtures.ts` | create | `makeSession`, `childOf`, `nodeIdAt` |
| `web/src/hooks/useProjects.ts` | create | repo list + server-side selection, 60 s poll (no SSE) |
| `web/src/hooks/useSessionGraph.ts` | create | one repo's nodes, 10 s ETag poll while visible (no SSE) |
| `web/src/components/graph/SessionGraph.tsx` | create | scroll container + virtualized SVG |
| `web/src/components/graph/SessionGraph.css` | create | graph styling, live pulse |
| `web/src/components/graph/GraphNode.tsx` | create | one row: time, dot, id, `+N` chip, badge slot, other-host mark, title |
| `web/src/components/graph/GraphEdges.tsx` | create | trunk + in-range edges |
| `web/src/components/graph/SessionGraph.test.tsx` | create | 1000-node virtualization, click/chip, live/remote/badge, focus |
| `web/src/pages/ProjectsPage.tsx` | create | page: toolbar, graph, panel slot, empty states |
| `web/src/pages/ProjectsPage.css` | create | page layout |
| `web/src/components/Rail.tsx` | rewrite (82 lines) | Projects button (TreeStructure) above chat history |
| `web/src/components/Sidebar.tsx` | rewrite (74 lines) | Projects button; repo list instead of tags in the projects view |
| `web/src/components/Rail.test.tsx` | rewrite | helpers pass `onToggleProjects`; projects icon + repo list tests |
| `web/src/components/Header.tsx:14,22-23,28` | modify | `projects` prop: projects hint, no "Last edited" |
| `web/src/styles.css:66` | modify | `.side-repos`, `.side-note`, `.repo-name`, `.repo-live` after `.tagrow .n` |
| `web/src/App.tsx` (lines 18-20, 63, 70-72, 278, 298-317, 653-654, 664-711, 733, 752) | modify | projects view state, route sync, rail/sidebar/header/page wiring, wall chat hidden on projects |
| `web/src/App.projects.test.tsx` | create | rail -> /projects, selection persisted, deep link, node select, back |

## Design decisions (made here, binding for 11-13)

- **Time axis:** one visible node per row (`ROW_H = 34` px), with rows ordered by `started_at` descending, so the newest is at the top. The axis is ordinal, as in a git log, not linear in time, because a linear scale wastes space on idle weeks and makes virtualization depend on variable row heights. A day label and rule mark the first row of each Jakarta day (`jakartaParts`, as on the history page). Every row shows its `HH:MM` in the left gutter.
- **Trunk:** every root (no parent, parent not in this repo's payload, or broken cycle) sits in lane 0. One thick line (`stroke-width: 6`) runs from the oldest root up past the newest one. Non-roots never use lane 0.
- **Lanes:** a non-root node occupies its lane over the rows `[min(row, parentRow), max(row, parentRow)]`. Nodes are assigned in BFS order: depth ascending, then parent row descending (older parents first), then own row descending (older siblings first). Each takes the lowest lane above its parent's lane that is free over its span. Siblings of one wave all include the parent's row, so they overlap and get adjacent lanes `p+1, p+2, ...`. Spans that do not overlap reuse a lane.
- **Collapse:** `expanded: ReadonlySet<session_id>` lives in `ProjectsPage` and starts empty, so only roots show at first. A node with children shows a chip: `+N` (N = all descendants) when collapsed, `−` when expanded. A `?node=` target expands its ancestors once. The toolbar has expand-all and collapse-all icon buttons.
- **Virtualization:** a fixed row height makes the visible window `visibleRange(scrollTop, height, total, OVERSCAN = 8)`. Only those rows' `GraphNode`s mount. Edges are filtered by span overlap, and the trunk is clipped to the window. The SVG keeps the full height, so the native scrollbar stays right.
- **Other host:** `available === false` gives the node a hollow dot, the Phosphor `Devices` duotone icon in `#bdbcb4` with an `on <host>` mono caption (the treatment from commit 28f8cb2, `NoteImage` `remote`), and a dimmed title.
- **Live:** `live === true` adds a pulsing halo (CSS transform/opacity keyframes, disabled under `prefers-reduced-motion`).
- **Heuristic links** are drawn dashed.
- **Selection:** clicking a row calls `onSelectNode(node_id)`. Clicking the selected row again, or pressing Escape, clears it. The URL is `/projects?repo=<repo>&node=<NODE-ID>`.
- **Selected repo:** shown repo = URL `repo`, else the server selection (`GET /api/projects/selected`, re-read on every entry to the view), else the most recently active project. Picking a repo in the sidebar PUTs it and pushes it into the URL. A URL deep link does not overwrite the server selection.
- **Wall chat:** the wall `ChatBar` and `AnswerPanel` are hidden on the projects view, as they are on the history page. Phase 12 mounts the project pill there instead.

## Implementation Steps

### Step 1: Wire types
**File:** `web/src/types.ts:86` and end of file (after line 166)
**Change:** widen `View`; append the session wire types.
**Code:** replace line 85-86:
```ts
/** What the main area shows: the wall (text / images / all modes), the recycle bin, the chat history page (phase 9), or the projects session graph (project-session-graph phase 10). */
export type View = 'wall' | 'bin' | 'history' | 'projects';
```
Append at the end of the file:
```ts
/** project-session-graph phase 7 wire (`GET /api/projects`): one repo that has Claude Code sessions. */
export interface ProjectSummary {
  /** Resolved repo key, e.g. `mcp-notes`. */
  repo: string;
  /** All sessions of the repo, both hosts. */
  sessions: number;
  /** Sessions of this repo running right now on THIS daemon's machine (its live registry). */
  live: number;
  last_active_at: string | null;
  first_started_at: string | null;
  /** Distinct hosts holding the repo's transcripts, sorted. */
  hosts: string[];
}

/** Phase 7 wire: `GET /api/projects`. */
export interface ProjectsPayload {
  /** os.hostname() of the daemon that answered. */
  host: string;
  /** Same value as `GET /api/projects/selected`. */
  selected: string | null;
  projects: ProjectSummary[];
}

/** How a parent link was found: swarm env var, SessionStart/Bash hook, or transcript heuristic. */
export type ParentLinkSource = 'env' | 'hook' | 'heuristic';

export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

/** Phase 7 wire (`GraphNode` in `GET /api/projects/:repo/sessions`): one Claude Code session, one graph node. Times are UTC ISO. */
export interface SessionNode {
  /** Claude Code session UUID. */
  session_id: string;
  /** `A0-3G`: the id the user quotes. Generated server-side. */
  node_id: string;
  repo: string | null;
  parent_session_id: string | null;
  /** Null when there is no parent or the parent is not ingested yet. */
  parent_node_id: string | null;
  parent_link_source: ParentLinkSource | null;
  /** Server-picked label: custom_title ?? name ?? ai_title ?? first prompt (80 chars) ?? node_id. */
  title: string;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  /** Excerpt, at most 200 chars (the full text is in the phase 7 detail). */
  first_prompt: string | null;
  branch: string | null;
  cwd: string | null;
  started_at: string | null;
  last_active_at: string | null;
  /** Machine whose `~/.claude` holds the transcript. */
  host: string;
  /** The transcript is on this machine. False: marked like "uploaded on GPD". */
  available: boolean;
  /** In this machine's live registry right now: the node pulses. */
  live: boolean;
  /** Registry status (`busy` | `idle` | ...) when live. */
  status: string | null;
  tmux: string | null;
  tokens: SessionTokens;
  cost_usd: number | null;
  summary_excerpt: string | null;
  /** Rows whose parent is this session (any repo). */
  child_count: number;
  /** Phase 13: orch node with pending ledger phases and no live session. Null until phase 13. */
  unfinished: boolean | null;
}

/** Phase 7 wire: `GET /api/projects/:repo/sessions` (`GraphPayload`). */
export interface SessionGraphPayload {
  repo: string;
  host: string;
  generated_at: string;
  /** Rows for the repo over all pages. */
  total: number;
  truncated: boolean;
  next_before: string | null;
  nodes: SessionNode[];
}
```
**Impact:** `Record<View, ...>` maps must add `projects` (only `BIN_TIP`, Step 9). The `View` switches in `App.tsx` are ternaries and keep compiling.

### Step 2: Sessions API client
**File:** `web/src/sessionsApi.ts` (new)
**Code:**
```ts
import { ApiError } from './api';
import type { ProjectSummary, SessionGraphPayload, SessionNode } from './types';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Upper bound asked of the graph endpoint. The SVG graph is virtualized for ~1000 nodes. */
export const GRAPH_LIMIT = 2000;

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') msg = (j as { error: string }).error;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Defensive copy of a phase 7 `GraphNode`: the layout never sees `undefined`. */
export function normalizeSessionNode(n: SessionNode): SessionNode {
  const src = n.parent_link_source;
  const t: Partial<SessionNode['tokens']> = n.tokens ?? {};
  return {
    session_id: n.session_id,
    node_id: n.node_id,
    repo: str(n.repo),
    parent_session_id: str(n.parent_session_id),
    parent_node_id: str(n.parent_node_id),
    parent_link_source: src === 'env' || src === 'hook' || src === 'heuristic' ? src : null,
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
    live: n.live === true,
    status: str(n.status),
    tmux: str(n.tmux),
    tokens: { input: num(t.input), output: num(t.output), cache_read: num(t.cache_read), cache_write: num(t.cache_write), total: num(t.total) },
    cost_usd: typeof n.cost_usd === 'number' ? n.cost_usd : null,
    summary_excerpt: str(n.summary_excerpt),
    child_count: num(n.child_count),
    unfinished: typeof n.unfinished === 'boolean' ? n.unfinished : null,
  };
}

/** One graph poll: `payload` null means 304 (unchanged since `etag`). */
export interface SessionGraphFetch {
  payload: SessionGraphPayload | null;
  etag: string | null;
}

/** `GET /api/projects` → every repo with sessions. */
export async function fetchProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const res = await fetch('/api/projects', { signal });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { projects?: unknown };
  return Array.isArray(j.projects) ? (j.projects as ProjectSummary[]) : [];
}

/** `GET /api/projects/selected` → the repo both laptops last picked, or null. */
export async function fetchSelectedProject(signal?: AbortSignal): Promise<string | null> {
  const res = await fetch('/api/projects/selected', { signal });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { repo?: unknown };
  return str(j.repo);
}

/** `PUT /api/projects/selected` `{ repo }` → the stored value. */
export async function saveSelectedProject(repo: string | null): Promise<string | null> {
  const res = await fetch('/api/projects/selected', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ repo }) });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { repo?: unknown };
  return str(j.repo);
}

/**
 * `GET /api/projects/:repo/sessions?limit=` → the repo's graph. Sends `If-None-Match: etag` when
 * given; a 304 answers `{ payload: null, etag }` so the caller keeps what it has (phase 7 decided
 * on ETag polling instead of an SSE event).
 */
export async function fetchSessionGraph(
  repo: string,
  opts: { signal?: AbortSignal; etag?: string | null } = {},
): Promise<SessionGraphFetch> {
  const headers: Record<string, string> = opts.etag ? { 'if-none-match': opts.etag } : {};
  const res = await fetch(`/api/projects/${enc(repo)}/sessions?limit=${GRAPH_LIMIT}`, { signal: opts.signal, headers });
  if (res.status === 304) return { payload: null, etag: opts.etag ?? null };
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as Partial<SessionGraphPayload> & { nodes?: unknown };
  const nodes = Array.isArray(j.nodes) ? (j.nodes as SessionNode[]).map(normalizeSessionNode) : [];
  return {
    payload: {
      repo: typeof j.repo === 'string' ? j.repo : repo,
      host: typeof j.host === 'string' ? j.host : '',
      generated_at: typeof j.generated_at === 'string' ? j.generated_at : '',
      total: typeof j.total === 'number' ? j.total : nodes.length,
      truncated: j.truncated === true,
      next_before: str(j.next_before),
      nodes,
    },
    etag: res.headers.get('etag'),
  };
}
```

### Step 3: Client test
**File:** `web/src/sessionsApi.test.tsx` (new; node env, no pragma)
**Code:**
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { fetchProjects, fetchSelectedProject, fetchSessionGraph, GRAPH_LIMIT, saveSelectedProject } from './sessionsApi';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('sessionsApi', () => {
  it('asks for one repo by its encoded key and fills missing fields', async () => {
    const fetchMock = vi.fn(async () => json({ repo: 'a b', nodes: [{ session_id: 's1', node_id: 'A0-3G', host: 'gpd', available: false }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { payload: p } = await fetchSessionGraph('a b');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`/api/projects/a%20b/sessions?limit=${GRAPH_LIMIT}`);
    expect(p?.repo).toBe('a b');
    expect(p?.nodes[0]).toEqual({
      session_id: 's1',
      node_id: 'A0-3G',
      repo: null,
      parent_session_id: null,
      parent_node_id: null,
      parent_link_source: null,
      title: 'A0-3G',
      name: null,
      custom_title: null,
      ai_title: null,
      first_prompt: null,
      branch: null,
      cwd: null,
      started_at: null,
      last_active_at: null,
      host: 'gpd',
      available: false,
      live: false,
      status: null,
      tmux: null,
      tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
      cost_usd: null,
      summary_excerpt: null,
      child_count: 0,
      unfinished: null,
    });
  });

  it('sends If-None-Match and keeps nothing new on 304', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSessionGraph('seer', { etag: 'W/"abc"' })).toEqual({ payload: null, etag: 'W/"abc"' });
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)['if-none-match']).toBe('W/"abc"');
  });

  it('reads the project list and the selection, and PUTs a pick as JSON', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects')
        return json({ host: 'lenovo', selected: 'seer', projects: [{ repo: 'seer', sessions: 2, live: 0, last_active_at: null, first_started_at: null, hosts: ['lenovo'] }] });
      if (init?.method === 'PUT') return json(JSON.parse(String(init.body)));
      return json({ repo: 'seer' });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchProjects()).map((p) => p.repo)).toEqual(['seer']);
    expect(await fetchSelectedProject()).toBe('seer');
    expect(await saveSelectedProject('mcp-notes')).toBe('mcp-notes');
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT') as [string, RequestInit];
    expect(put[0]).toBe('/api/projects/selected');
    expect(JSON.parse(String(put[1].body))).toEqual({ repo: 'mcp-notes' });
  });

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'boom' }, 500)));
    await expect(fetchProjects()).rejects.toEqual(new ApiError(500, 'boom'));
  });
});
```

### Step 4: Route
**File:** `web/src/lib/route.ts` (whole file, 36 lines -> below)
**Code:**
```ts
import type { View } from '../types';

/**
 * The history page's URL (phase 9): `/history`, or `/history?thread=<id>` to open it on one thread.
 * The projects view (project-session-graph phase 10): `/projects`, `/projects?repo=<repo>`, and
 * `/projects?repo=<repo>&node=<NODE-ID>` with one graph node selected.
 * The wall and the bin have no path of their own: they live at `/` (and `/?note=<id>` deep links,
 * lib/deepLink.ts), so leaving the history or projects page pushes `/` and nothing else is touched.
 */
export const HISTORY_PATH = '/history';
export const PROJECTS_PATH = '/projects';

export interface Route {
  history: boolean;
  thread: string | null;
}

/** What `/projects` asks for. `repo` null = the server-side selection; `node` is canonical (`A0-3G`). */
export interface ProjectsRoute {
  repo: string | null;
  node: string | null;
}

export const NO_PROJECT_ROUTE: ProjectsRoute = { repo: null, node: null };

type Loc = Pick<Location, 'pathname' | 'search'>;

/** The path without trailing slashes (`/` stays `/`). */
function pathOf(loc: Loc): string {
  return loc.pathname.length > 1 ? loc.pathname.replace(/\/+$/, '') : loc.pathname;
}

/** A trimmed query value; empty counts as absent. */
function param(search: string, key: string): string | null {
  const v = new URLSearchParams(search).get(key);
  return v !== null && v.trim() !== '' ? v.trim() : null;
}

/** What the URL asks for. A trailing slash is tolerated; an empty `thread` is no thread. */
export function routeFromLocation(loc: Loc): Route {
  if (pathOf(loc) !== HISTORY_PATH) return { history: false, thread: null };
  return { history: true, thread: param(loc.search, 'thread') };
}

export function historyHref(thread: string | null): string {
  return thread ? `${HISTORY_PATH}?thread=${encodeURIComponent(thread)}` : HISTORY_PATH;
}

const NODE_ID_LOOSE = /^([0-9A-Z]{2})-?([0-9A-Z]{2})$/;

/** `a03g`, `A0-3g` → `A0-3G`; anything not shaped like a node id → null. Never checks existence. */
export function canonicalNodeId(input: string): string | null {
  const m = NODE_ID_LOOSE.exec(input.trim().toUpperCase());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** The projects route, or null when the URL is not `/projects`. A malformed `node` is dropped. */
export function projectsRouteFromLocation(loc: Loc): ProjectsRoute | null {
  if (pathOf(loc) !== PROJECTS_PATH) return null;
  const node = param(loc.search, 'node');
  return { repo: param(loc.search, 'repo'), node: node === null ? null : canonicalNodeId(node) };
}

export function projectsHref(r: ProjectsRoute): string {
  const p = new URLSearchParams();
  if (r.repo) p.set('repo', r.repo);
  if (r.node) p.set('node', r.node);
  const q = p.toString();
  return q ? `${PROJECTS_PATH}?${q}` : PROJECTS_PATH;
}

/**
 * The URL to push so the address bar matches `view`, or null when it already does. Wall and bin
 * accept any non-history, non-projects URL as it is (a `/?note=` link stays put); only leaving
 * `/history` or `/projects` pushes `/`.
 */
export function hrefForView(view: View, thread: string | null, loc: Loc, projects: ProjectsRoute = NO_PROJECT_ROUTE): string | null {
  const r = routeFromLocation(loc);
  const p = projectsRouteFromLocation(loc);
  if (view === 'history') return r.history && r.thread === thread ? null : historyHref(thread);
  if (view === 'projects') return p !== null && p.repo === projects.repo && p.node === projects.node ? null : projectsHref(projects);
  return r.history || p !== null ? '/' : null;
}
```
**Impact:** existing `route.test.tsx` cases are unchanged and still pass (`routeFromLocation`'s output shape is the same).

### Step 5: Route tests
**File:** `web/src/lib/route.test.tsx:1-2` (import) and `:42` (append inside the `describe`, before its closing `});`)
**Change:** replace the import line:
```tsx
import { canonicalNodeId, historyHref, hrefForView, projectsHref, projectsRouteFromLocation, routeFromLocation } from './route';
```
Append these cases inside `describe('route', ...)`:
```tsx
  it('reads /projects with repo and node, canonicalising the node id', () => {
    expect(projectsRouteFromLocation(loc('/projects'))).toEqual({ repo: null, node: null });
    expect(projectsRouteFromLocation(loc('/projects/'))).toEqual({ repo: null, node: null });
    expect(projectsRouteFromLocation(loc('/projects?repo=mcp-notes'))).toEqual({ repo: 'mcp-notes', node: null });
    expect(projectsRouteFromLocation(loc('/projects?repo=mcp-notes&node=a03g'))).toEqual({ repo: 'mcp-notes', node: 'A0-3G' });
    expect(projectsRouteFromLocation(loc('/projects?node=not-an-id'))).toEqual({ repo: null, node: null });
    expect(projectsRouteFromLocation(loc('/'))).toBeNull();
    expect(projectsRouteFromLocation(loc('/history'))).toBeNull();
    expect(projectsRouteFromLocation(loc('/projectsx'))).toBeNull();
  });

  it('a node id is two-dash-two; note ids are not node ids', () => {
    expect(canonicalNodeId('A0-3G')).toBe('A0-3G');
    expect(canonicalNodeId(' a0-3g ')).toBe('A0-3G');
    expect(canonicalNodeId('A-B32')).toBeNull();
    expect(canonicalNodeId('A0-3G1')).toBeNull();
  });

  it('builds the projects href', () => {
    expect(projectsHref({ repo: null, node: null })).toBe('/projects');
    expect(projectsHref({ repo: 'mcp-notes', node: null })).toBe('/projects?repo=mcp-notes');
    expect(projectsHref({ repo: 'mcp-notes', node: 'A0-3G' })).toBe('/projects?repo=mcp-notes&node=A0-3G');
  });

  it('syncs the projects view and leaves it for /', () => {
    expect(hrefForView('projects', null, loc('/'), { repo: null, node: null })).toBe('/projects');
    expect(hrefForView('projects', null, loc('/projects'), { repo: null, node: null })).toBeNull();
    expect(hrefForView('projects', null, loc('/projects?repo=a'), { repo: 'a', node: 'A0-3G' })).toBe('/projects?repo=a&node=A0-3G');
    expect(hrefForView('projects', null, loc('/projects?repo=a&node=a03g'), { repo: 'a', node: 'A0-3G' })).toBeNull();
    expect(hrefForView('wall', null, loc('/projects?repo=a'))).toBe('/');
    expect(hrefForView('bin', null, loc('/projects'))).toBe('/');
    expect(hrefForView('history', null, loc('/projects'))).toBe('/history');
    expect(hrefForView('projects', null, loc('/history'), { repo: 'a', node: null })).toBe('/projects?repo=a');
  });
```

### Step 6: Header text helpers
**File:** `web/src/lib/projects.ts` (new)
**Code:**
```ts
import type { ProjectSummary } from '../types';

export const PROJECTS_HINT = 'Every Claude Code session of the repo, newest at the top. +N opens a branch.';

/** The page's big heading: the repo, or "Projects." while none is chosen. */
export function projectHeading(repo: string | null): string {
  return repo ? `${repo}.` : 'Projects.';
}

/** Header count line for the projects view. */
export function projectsCountLine(list: ProjectSummary[] | null, repo: string | null): string {
  if (list === null) return 'Loading projects.';
  if (repo === null) return list.length === 1 ? '1 project.' : `${list.length} projects.`;
  const hit = list.find((p) => p.repo === repo);
  if (!hit) return `No sessions in ${repo}.`;
  const n = hit.sessions === 1 ? '1 session' : `${hit.sessions} sessions`;
  return hit.live > 0 ? `${n}, ${hit.live} running.` : `${n}.`;
}

/** Most recently active first; ties and never-active repos by name. */
export function sortProjects(list: readonly ProjectSummary[]): ProjectSummary[] {
  const t = (p: ProjectSummary) => {
    const ms = p.last_active_at ? Date.parse(p.last_active_at) : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return list.slice().sort((a, b) => {
    const ta = t(a);
    const tb = t(b);
    if (ta !== tb) return tb > ta ? 1 : -1;
    return a.repo.localeCompare(b.repo);
  });
}
```
**File:** `web/src/lib/projects.test.tsx` (new)
```tsx
import { describe, expect, it } from 'vitest';
import { projectHeading, projectsCountLine, sortProjects } from './projects';
import type { ProjectSummary } from '../types';

const p = (repo: string, sessions: number, live: number, last: string | null): ProjectSummary => ({
  repo,
  sessions,
  live,
  last_active_at: last,
  first_started_at: null,
  hosts: ['lenovo'],
});

describe('projects text', () => {
  it('heading and count line', () => {
    expect(projectHeading(null)).toBe('Projects.');
    expect(projectHeading('seer')).toBe('seer.');
    expect(projectsCountLine(null, null)).toBe('Loading projects.');
    expect(projectsCountLine([p('a', 1, 0, null)], null)).toBe('1 project.');
    expect(projectsCountLine([p('a', 1, 0, null)], 'a')).toBe('1 session.');
    expect(projectsCountLine([p('a', 5, 2, null)], 'a')).toBe('5 sessions, 2 running.');
    expect(projectsCountLine([], 'gone')).toBe('No sessions in gone.');
  });

  it('sorts most recently active first, then by name', () => {
    const list = [p('b', 1, 0, null), p('a', 1, 0, null), p('old', 1, 0, '2026-01-01T00:00:00Z'), p('new', 1, 0, '2026-11-01T00:00:00Z')];
    expect(sortProjects(list).map((x) => x.repo)).toEqual(['new', 'old', 'a', 'b']);
  });
});
```

### Step 7: Pure graph layout
**File:** `web/src/lib/sessionGraph.ts` (new)
**Code:**
```ts
import type { SessionNode } from '../types';
import { jakartaParts } from './chatTime';
import { oneLine } from './oneLine';

/** One visible node per row, newest at the top. Fixed height: virtualization is arithmetic. */
export const ROW_H = 34;
/** Horizontal distance between lanes. Lane 0 is the trunk. */
export const LANE_W = 20;
/** Left gutter: day label + HH:MM. */
export const GUTTER_W = 84;
/** Gap between the rightmost lane and the label column. */
export const LABEL_GAP = 16;
/** Rows rendered above and below the viewport. */
export const OVERSCAN = 8;
/** Label column: node id, `+N` chip, phase 13 badge slot (when filled), other-host mark (when remote), title. */
export const ID_W = 54;
export const CHIP_W = 40;
export const BADGE_W = 92;
export const REMOTE_W = 84;
export const TITLE_W = 560;
export const TITLE_MAX = 96;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface Forest {
  bySession: Map<string, SessionNode>;
  /** Effective parent: null for roots (no parent, parent outside this payload, self-parent, broken cycle). */
  parentOf: Map<string, string | null>;
  /** Children per parent, oldest first. */
  children: Map<string, SessionNode[]>;
  /** Newest first. */
  roots: SessionNode[];
  /** All descendants per node (0 for leaves). */
  descendants: Map<string, number>;
}

export interface LaidNode {
  node: SessionNode;
  row: number;
  lane: number;
  depth: number;
  root: boolean;
  parentRow: number | null;
  parentLane: number | null;
  childCount: number;
  descendants: number;
  /** Children are shown. */
  expanded: boolean;
  /** First row (from the top) of its Jakarta day: draws the day label and rule. */
  firstOfDay: boolean;
}

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
  heuristic: boolean;
}

export interface GraphLayout {
  rows: LaidNode[];
  edges: LaidEdge[];
  /** Lanes used, trunk included (>= 1). */
  lanes: number;
  /** Rows of the newest and oldest root; null with no rows. */
  trunk: { top: number; bottom: number } | null;
  bySession: Map<string, LaidNode>;
  byNodeId: Map<string, LaidNode>;
  forest: Forest;
}

/** Start time in ms; a session with no time sorts as the oldest. */
export function timeOf(n: SessionNode): number {
  const t = Date.parse(n.started_at ?? n.last_active_at ?? '');
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function newestFirst(a: SessionNode, b: SessionNode): number {
  const ta = timeOf(a);
  const tb = timeOf(b);
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
}

/** Parent links resolved inside this payload, roots and descendant counts. */
export function buildForest(nodes: readonly SessionNode[]): Forest {
  const bySession = new Map<string, SessionNode>();
  for (const n of nodes) bySession.set(n.session_id, n);

  const parentOf = new Map<string, string | null>();
  for (const n of bySession.values()) {
    const p = n.parent_session_id;
    parentOf.set(n.session_id, p !== null && p !== n.session_id && bySession.has(p) ? p : null);
  }
  // Break cycles: a node whose parent chain comes back to itself becomes a root.
  for (const id of bySession.keys()) {
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id) ?? null;
    while (cur !== null) {
      if (seen.has(cur)) {
        if (cur === id) parentOf.set(id, null);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }

  const children = new Map<string, SessionNode[]>();
  const roots: SessionNode[] = [];
  for (const n of bySession.values()) {
    const p = parentOf.get(n.session_id) ?? null;
    if (p === null) {
      roots.push(n);
      continue;
    }
    const list = children.get(p);
    if (list) list.push(n);
    else children.set(p, [n]);
  }
  for (const list of children.values()) list.sort((a, b) => newestFirst(b, a));
  roots.sort(newestFirst);

  const descendants = new Map<string, number>();
  const count = (id: string): number => {
    const known = descendants.get(id);
    if (known !== undefined) return known;
    let n = 0;
    for (const c of children.get(id) ?? []) n += 1 + count(c.session_id);
    descendants.set(id, n);
    return n;
  };
  for (const id of bySession.keys()) count(id);

  return { bySession, parentOf, children, roots, descendants };
}

/** Session ids of the node's ancestors, nearest first. */
export function ancestorsOf(forest: Forest, sessionId: string): string[] {
  const out: string[] = [];
  let cur = forest.parentOf.get(sessionId) ?? null;
  while (cur !== null && !out.includes(cur)) {
    out.push(cur);
    cur = forest.parentOf.get(cur) ?? null;
  }
  return out;
}

/** Every node that has children: the "expand all" set. */
export function expandAll(forest: Forest): Set<string> {
  return new Set(forest.children.keys());
}

/** Jakarta calendar day, `YYYY-M-D`; '' for a session with no time. */
export function dayKey(n: SessionNode): string {
  const t = timeOf(n);
  if (!Number.isFinite(t)) return '';
  const p = jakartaParts(t);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

/** `HH:MM` Jakarta time, '' when unknown. */
export function fmtTime(n: SessionNode): string {
  const t = timeOf(n);
  if (!Number.isFinite(t)) return '';
  const p = jakartaParts(t);
  return p ? `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` : '';
}

/** `Nov 2` Jakarta date, '' when unknown. */
export function fmtDay(n: SessionNode): string {
  const t = timeOf(n);
  if (!Number.isFinite(t)) return '';
  const p = jakartaParts(t);
  return p ? `${MONTHS[p.month - 1]} ${p.day}` : '';
}

/** Custom title, then name, then AI title, then the first prompt on one line. Truncated. */
export function nodeTitle(n: SessionNode): string {
  const raw = n.custom_title || n.name || n.ai_title || (n.first_prompt ? oneLine(n.first_prompt) : '') || 'untitled session';
  return raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX - 1)}…` : raw;
}

/**
 * Lays out the visible part of the forest. Roots are always visible; a node's children are visible
 * when it is visible and in `expanded`. Rows: newest first. Lanes: roots on 0; others take the
 * lowest lane right of their parent that is free over [their row, parent row], assigned by depth,
 * then older parent first, then older sibling first, so one wave lands in adjacent lanes.
 */
export function layoutGraph(nodes: readonly SessionNode[], expanded: ReadonlySet<string>, forest: Forest = buildForest(nodes)): GraphLayout {
  const visible: SessionNode[] = [];
  const depthOf = new Map<string, number>();
  const stack: Array<{ node: SessionNode; depth: number }> = forest.roots.map((node) => ({ node, depth: 0 }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: SessionNode; depth: number };
    visible.push(node);
    depthOf.set(node.session_id, depth);
    if (!expanded.has(node.session_id)) continue;
    for (const c of forest.children.get(node.session_id) ?? []) stack.push({ node: c, depth: depth + 1 });
  }
  visible.sort(newestFirst);

  const rowOf = new Map<string, number>();
  visible.forEach((n, i) => rowOf.set(n.session_id, i));

  const laneOf = new Map<string, number>();
  const occupied: Array<Array<[number, number]>> = [[]];
  const pending: SessionNode[] = [];
  for (const n of visible) {
    if (forest.parentOf.get(n.session_id) == null) laneOf.set(n.session_id, 0);
    else pending.push(n);
  }
  const parentRow = (n: SessionNode) => rowOf.get(forest.parentOf.get(n.session_id) as string) as number;
  pending.sort((a, b) => {
    const d = (depthOf.get(a.session_id) as number) - (depthOf.get(b.session_id) as number);
    if (d !== 0) return d;
    const pr = parentRow(b) - parentRow(a);
    if (pr !== 0) return pr;
    return (rowOf.get(b.session_id) as number) - (rowOf.get(a.session_id) as number);
  });
  for (const n of pending) {
    const p = forest.parentOf.get(n.session_id) as string;
    const rp = rowOf.get(p) as number;
    const rc = rowOf.get(n.session_id) as number;
    const top = Math.min(rp, rc);
    const bottom = Math.max(rp, rc);
    let lane = (laneOf.get(p) as number) + 1;
    for (;;) {
      if (occupied[lane] === undefined) occupied[lane] = [];
      const spans = occupied[lane] as Array<[number, number]>;
      if (!spans.some(([a, b]) => a <= bottom && top <= b)) {
        spans.push([top, bottom]);
        break;
      }
      lane++;
    }
    laneOf.set(n.session_id, lane);
  }

  const rows: LaidNode[] = [];
  const bySession = new Map<string, LaidNode>();
  const byNodeId = new Map<string, LaidNode>();
  let prevDay: string | null = null;
  let trunkTop = -1;
  let trunkBottom = -1;
  visible.forEach((node, row) => {
    const id = node.session_id;
    const p = forest.parentOf.get(id) ?? null;
    const day = dayKey(node);
    const kids = forest.children.get(id) ?? [];
    const laid: LaidNode = {
      node,
      row,
      lane: laneOf.get(id) as number,
      depth: depthOf.get(id) as number,
      root: p === null,
      parentRow: p === null ? null : (rowOf.get(p) as number),
      parentLane: p === null ? null : (laneOf.get(p) as number),
      childCount: kids.length,
      descendants: forest.descendants.get(id) ?? 0,
      expanded: kids.length > 0 && expanded.has(id),
      firstOfDay: row === 0 || day !== prevDay,
    };
    prevDay = day;
    if (p === null) {
      if (trunkTop < 0) trunkTop = row;
      trunkBottom = row;
    }
    rows.push(laid);
    bySession.set(id, laid);
    byNodeId.set(node.node_id, laid);
  });

  const edges: LaidEdge[] = [];
  for (const laid of rows) {
    if (laid.root) continue;
    const fromRow = laid.parentRow as number;
    edges.push({
      parent: forest.parentOf.get(laid.node.session_id) as string,
      child: laid.node.session_id,
      fromRow,
      fromLane: laid.parentLane as number,
      toRow: laid.row,
      toLane: laid.lane,
      top: Math.min(fromRow, laid.row),
      bottom: Math.max(fromRow, laid.row),
      heuristic: laid.node.parent_link_source === 'heuristic',
    });
  }

  return {
    rows,
    edges,
    lanes: occupied.length,
    trunk: trunkTop < 0 ? null : { top: trunkTop, bottom: trunkBottom },
    bySession,
    byNodeId,
    forest,
  };
}

/** Rows to mount for a viewport: [first, last] inclusive, with overscan. Empty graph → last < first. */
export function visibleRange(scrollTop: number, height: number, total: number, overscan: number = OVERSCAN): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: -1 };
  const top = Math.max(0, scrollTop);
  const first = Math.max(0, Math.floor(top / ROW_H) - overscan);
  const lastVisible = Math.floor((top + Math.max(height, 1) - 1) / ROW_H);
  return { first: Math.min(first, total - 1), last: Math.min(total - 1, lastVisible + overscan) };
}

/** Edges whose lane span crosses [first, last]. */
export function edgesInRange(layout: GraphLayout, first: number, last: number): LaidEdge[] {
  if (last < first) return [];
  return layout.edges.filter((e) => e.top <= last && e.bottom >= first);
}

export function laneX(lane: number): number {
  return GUTTER_W + LANE_W / 2 + lane * LANE_W;
}

export function rowY(row: number): number {
  return row * ROW_H + ROW_H / 2;
}

/** Where the label column starts: right of every lane, so labels line up. */
export function labelX(lanes: number): number {
  return GUTTER_W + lanes * LANE_W + LABEL_GAP;
}

export function graphWidth(lanes: number): number {
  return labelX(lanes) + ID_W + CHIP_W + BADGE_W + REMOTE_W + TITLE_W;
}

/** Branch from the parent's dot into the child's lane, then straight along the lane to the child. */
export function edgePath(e: LaidEdge): string {
  const xp = laneX(e.fromLane);
  const yp = rowY(e.fromRow);
  const xc = laneX(e.toLane);
  const yc = rowY(e.toRow);
  const bend = e.toRow <= e.fromRow ? yp - ROW_H / 2 : yp + ROW_H / 2;
  return `M${xp} ${yp}Q${xc} ${yp} ${xc} ${bend}L${xc} ${yc}`;
}
```

### Step 8: Fixtures and layout tests
**File:** `web/src/testing/sessionFixtures.ts` (new)
```ts
import type { SessionNode } from '../types';

/** 12:00 UTC = 19:00 Jakarta: a few hours of minutes stay on one Jakarta day. */
export const SESSION_BASE = Date.UTC(2026, 9, 1, 12, 0, 0);

/** A wire session node started `minute` minutes after SESSION_BASE; session id is `s-<nodeId>`. */
export function makeSession(nodeId: string, minute: number, opts: Partial<SessionNode> = {}): SessionNode {
  const at = new Date(SESSION_BASE + minute * 60_000).toISOString();
  return {
    session_id: `s-${nodeId}`,
    node_id: nodeId,
    repo: 'mcp-notes',
    parent_session_id: null,
    parent_node_id: null,
    parent_link_source: null,
    title: opts.custom_title ?? opts.name ?? nodeId,
    name: null,
    custom_title: null,
    ai_title: null,
    first_prompt: null,
    branch: null,
    cwd: '/home/u/mcp-notes',
    started_at: at,
    last_active_at: at,
    host: 'lenovo',
    available: true,
    live: false,
    status: null,
    tmux: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 },
    cost_usd: null,
    summary_excerpt: null,
    child_count: 0,
    unfinished: null,
    ...opts,
  };
}

export function childOf(parent: SessionNode, nodeId: string, minute: number, opts: Partial<SessionNode> = {}): SessionNode {
  return makeSession(nodeId, minute, { parent_session_id: parent.session_id, parent_node_id: parent.node_id, parent_link_source: 'env', ...opts });
}

/** Distinct node ids for bulk fixtures: 0 → `00-00`, 37 → `00-11`. */
export function nodeIdAt(i: number): string {
  const s = i.toString(36).toUpperCase().padStart(4, '0');
  return `${s.slice(0, 2)}-${s.slice(2)}`;
}
```
**File:** `web/src/lib/sessionGraph.test.tsx` (new; node env)
```tsx
import { describe, expect, it } from 'vitest';
import { childOf, makeSession } from '../testing/sessionFixtures';
import {
  ancestorsOf,
  buildForest,
  edgePath,
  edgesInRange,
  expandAll,
  laneX,
  layoutGraph,
  nodeTitle,
  rowY,
  visibleRange,
  type GraphLayout,
} from './sessionGraph';

const R1 = makeSession('R1-00', 0, { custom_title: 'orch-wall-editing' });
const P1 = childOf(R1, 'P1-00', 10);
const P2 = childOf(R1, 'P2-00', 11);
const P3 = childOf(R1, 'P3-00', 12);
const G = childOf(P1, 'G1-00', 20);
const R2 = makeSession('R2-00', 100);
const ALL = [R1, P1, P2, P3, G, R2];

const order = (l: GraphLayout) => l.rows.map((r) => r.node.node_id);
const at = (l: GraphLayout, id: string) => l.byNodeId.get(id)!;

describe('layoutGraph', () => {
  it('starts with roots only, newest at the top, on the trunk, with +N counts', () => {
    const l = layoutGraph(ALL, new Set());
    expect(order(l)).toEqual(['R2-00', 'R1-00']);
    expect(l.rows.every((r) => r.lane === 0 && r.root)).toBe(true);
    expect(at(l, 'R1-00').childCount).toBe(3);
    expect(at(l, 'R1-00').descendants).toBe(4);
    expect(at(l, 'R1-00').expanded).toBe(false);
    expect(at(l, 'R2-00').childCount).toBe(0);
    expect(l.edges).toEqual([]);
    expect(l.trunk).toEqual({ top: 0, bottom: 1 });
    expect(l.lanes).toBe(1);
  });

  it('expanding a root puts one wave side by side in adjacent lanes', () => {
    const l = layoutGraph(ALL, new Set([R1.session_id]));
    expect(order(l)).toEqual(['R2-00', 'P3-00', 'P2-00', 'P1-00', 'R1-00']);
    expect([at(l, 'P1-00').lane, at(l, 'P2-00').lane, at(l, 'P3-00').lane]).toEqual([1, 2, 3]);
    expect(at(l, 'P1-00').descendants).toBe(1);
    expect(at(l, 'P1-00').expanded).toBe(false);
    expect(l.byNodeId.has('G1-00')).toBe(false);
    expect(l.lanes).toBe(4);
    expect(l.trunk).toEqual({ top: 0, bottom: 4 });
  });

  it('grandchildren branch right of their parent', () => {
    const l = layoutGraph(ALL, new Set([R1.session_id, P1.session_id]));
    expect(at(l, 'G1-00').lane).toBeGreaterThan(at(l, 'P1-00').lane);
    expect(at(l, 'G1-00').lane).toBe(4);
    expect(at(l, 'G1-00').depth).toBe(2);
  });

  it('children whose spans do not overlap reuse a lane', () => {
    const a = makeSession('A0-00', 0);
    const a1 = childOf(a, 'A1-00', 10);
    const b = makeSession('B0-00', 40);
    const b1 = childOf(b, 'B1-00', 50);
    const l = layoutGraph([a, a1, b, b1], expandAll(buildForest([a, a1, b, b1])));
    expect(order(l)).toEqual(['B1-00', 'B0-00', 'A1-00', 'A0-00']);
    expect(at(l, 'A1-00').lane).toBe(1);
    expect(at(l, 'B1-00').lane).toBe(1);
    expect(l.lanes).toBe(2);
  });

  it('a missing parent, a self-parent or a cycle never loses a node', () => {
    const x = makeSession('X0-00', 0, { parent_session_id: 'elsewhere' });
    const s = makeSession('S0-00', 1);
    const self = { ...s, parent_session_id: s.session_id };
    const y = makeSession('Y0-00', 2, { parent_session_id: 's-Z0-00' });
    const z = makeSession('Z0-00', 3, { parent_session_id: 's-Y0-00' });
    const f = buildForest([x, self, y, z]);
    expect(f.parentOf.get(x.session_id)).toBeNull();
    expect(f.parentOf.get(self.session_id)).toBeNull();
    expect(f.roots.length).toBe(3);
    const l = layoutGraph([x, self, y, z], expandAll(f), f);
    expect(l.rows.length).toBe(4);
    expect(new Set(order(l)).size).toBe(4);
  });

  it('ancestors come nearest first; expand-all holds every parent', () => {
    const f = buildForest(ALL);
    expect(ancestorsOf(f, G.session_id)).toEqual([P1.session_id, R1.session_id]);
    expect(ancestorsOf(f, R1.session_id)).toEqual([]);
    expect([...expandAll(f)].sort()).toEqual([P1.session_id, R1.session_id].sort());
  });

  it('marks the first row of each Jakarta day', () => {
    const late = makeSession('D2-00', 3 * 24 * 60);
    const early = makeSession('D1-00', 0);
    const sameDay = makeSession('D1-01', 1);
    const l = layoutGraph([late, early, sameDay], new Set());
    expect(l.rows.map((r) => r.firstOfDay)).toEqual([true, true, false]);
  });

  it('marks heuristic links on the edge', () => {
    const h = childOf(R1, 'H0-00', 30, { parent_link_source: 'heuristic' });
    const l = layoutGraph([R1, h], new Set([R1.session_id]));
    expect(l.edges).toHaveLength(1);
    expect(l.edges[0]!.heuristic).toBe(true);
  });
});

describe('virtualization helpers', () => {
  it('visibleRange covers the viewport plus overscan', () => {
    expect(visibleRange(0, 340, 1000, 2)).toEqual({ first: 0, last: 11 });
    expect(visibleRange(3400, 340, 1000, 2)).toEqual({ first: 98, last: 111 });
    expect(visibleRange(0, 340, 5, 2)).toEqual({ first: 0, last: 4 });
    expect(visibleRange(0, 340, 0, 2)).toEqual({ first: 0, last: -1 });
  });

  it('edgesInRange keeps only edges whose lane span crosses the window', () => {
    const l = layoutGraph(ALL, new Set([R1.session_id]));
    expect(edgesInRange(l, 0, 0)).toEqual([]);
    expect(edgesInRange(l, 0, 2).map((e) => e.child).sort()).toEqual([P2.session_id, P3.session_id].sort());
    expect(edgesInRange(l, 4, 4)).toHaveLength(3);
  });

  it('edgePath leaves the parent dot and ends on the child dot', () => {
    const l = layoutGraph(ALL, new Set([R1.session_id]));
    const e = l.edges.find((x) => x.child === P1.session_id)!;
    const d = edgePath(e);
    expect(d.startsWith(`M${laneX(0)} ${rowY(4)}`)).toBe(true);
    expect(d.endsWith(`L${laneX(1)} ${rowY(3)}`)).toBe(true);
  });
});

describe('nodeTitle', () => {
  it('prefers custom title, then name, then AI title, then the first prompt', () => {
    expect(nodeTitle(makeSession('T0-00', 0, { custom_title: 'c', name: 'n' }))).toBe('c');
    expect(nodeTitle(makeSession('T0-00', 0, { name: 'n', ai_title: 'a' }))).toBe('n');
    expect(nodeTitle(makeSession('T0-00', 0, { ai_title: 'a' }))).toBe('a');
    expect(nodeTitle(makeSession('T0-00', 0, { first_prompt: 'fix\n  the bug' }))).toBe('fix the bug');
    expect(nodeTitle(makeSession('T0-00', 0))).toBe('untitled session');
    expect(nodeTitle(makeSession('T0-00', 0, { name: 'x'.repeat(200) })).length).toBe(96);
  });
});
```

### Step 9: Data hooks
**File:** `web/src/hooks/useSessionGraph.ts` (new)
```ts
import { useEffect, useState } from 'react';
import { fetchSessionGraph } from '../sessionsApi';
import type { SessionNode } from '../types';

/**
 * Phase 7's suggested poll while the projects page is visible. Each poll sends If-None-Match, so an
 * unchanged graph costs one 304. There is no SSE event for sessions (phase 7's decision).
 */
export const GRAPH_POLL_MS = 10_000;

export interface SessionGraphStore {
  nodes: SessionNode[];
  loaded: boolean;
  error: string | null;
}

/**
 * One repo's graph nodes. Loads on mount, then polls every GRAPH_POLL_MS while the tab is visible
 * (and once when it becomes visible again). ProjectsPage is keyed by repo, so a repo switch remounts.
 */
export function useSessionGraph(repo: string | null): SessionGraphStore {
  const [state, setState] = useState<SessionGraphStore>({ nodes: [], loaded: repo === null, error: null });

  useEffect(() => {
    if (repo === null) return;
    let alive = true;
    let inFlight = false;
    let etag: string | null = null;
    const ctrl = new AbortController();

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetchSessionGraph(repo, { signal: ctrl.signal, etag });
        etag = res.etag;
        const payload = res.payload;
        if (alive && payload !== null) setState({ nodes: payload.nodes, loaded: true, error: null });
      } catch (e) {
        if (alive && !ctrl.signal.aborted) setState((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        inFlight = false;
      }
    };
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };

    void load();
    const poll = window.setInterval(tick, GRAPH_POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [repo]);

  return state;
}
```
**File:** `web/src/hooks/useProjects.ts` (new)
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchProjects, fetchSelectedProject, saveSelectedProject } from '../sessionsApi';
import type { ProjectSummary } from '../types';

/** The repo list changes slowly; no SSE event exists for sessions (phase 7), so poll. */
export const PROJECTS_POLL_MS = 60_000;

export interface ProjectsStore {
  /** Repos with sessions; null until the first load. */
  projects: ProjectSummary[] | null;
  /** Server-side selection (`app_settings` key `projects.selected`, shared by both laptops). */
  selected: string | null;
  /** The selection GET has answered (or failed) for this visit. */
  selectedLoaded: boolean;
  error: string | null;
  /** Show `repo` and store it server-side. Fire-and-forget: a failed PUT keeps the local choice. */
  pick: (repo: string) => void;
}

/**
 * The sidebar's repo list and the shared selection. Fetches only while `enabled` (the projects view
 * is shown); every entry re-reads the selection, so a pick on the other laptop shows up next visit.
 */
export function useProjects(enabled: boolean): ProjectsStore {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedLoaded, setSelectedLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A pick made during this visit wins over a slower selection GET. */
  const picked = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    picked.current = false;
    setSelectedLoaded(false);

    const loadList = async (): Promise<void> => {
      try {
        const list = await fetchProjects();
        if (!alive) return;
        setProjects(list);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void loadList();
    void (async () => {
      try {
        const repo = await fetchSelectedProject();
        if (alive && !picked.current) setSelected(repo);
      } catch {
        // no selection stored or the route failed: fall back to the most recent project
      } finally {
        if (alive) setSelectedLoaded(true);
      }
    })();
    const poll = window.setInterval(() => void loadList(), PROJECTS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [enabled]);

  const pick = useCallback((repo: string) => {
    picked.current = true;
    setSelected(repo);
    setSelectedLoaded(true);
    void saveSelectedProject(repo).catch(() => {});
  }, []);

  return { projects, selected, selectedLoaded, error, pick };
}
```

### Step 10: SVG renderer
**File:** `web/src/components/graph/GraphEdges.tsx` (new)
```tsx
import { memo } from 'react';
import { ROW_H, edgePath, edgesInRange, laneX, rowY, type GraphLayout } from '../../lib/sessionGraph';

export interface GraphEdgesProps {
  layout: GraphLayout;
  /** Mounted rows, inclusive. */
  first: number;
  last: number;
}

/** The thick trunk (clipped to the window, poking out above the newest root) and the edges crossing the window. */
export const GraphEdges = memo(function GraphEdges({ layout, first, last }: GraphEdgesProps) {
  if (last < first) return null;
  const trunk = layout.trunk;
  let trunkLine = null;
  if (trunk !== null && trunk.top <= last && trunk.bottom >= first) {
    const x = laneX(0);
    const y1 = trunk.top >= first ? Math.max(2, rowY(trunk.top) - ROW_H * 0.75) : rowY(first) - ROW_H;
    const y2 = trunk.bottom <= last ? rowY(trunk.bottom) : rowY(last) + ROW_H;
    trunkLine = <line className="gtrunk" x1={x} x2={x} y1={y1} y2={y2} />;
  }
  return (
    <g className="gedges">
      {trunkLine}
      {edgesInRange(layout, first, last).map((e) => (
        <path key={e.child} className={e.heuristic ? 'gedge heur' : 'gedge'} d={edgePath(e)} data-edge={e.child} />
      ))}
    </g>
  );
});
```
**File:** `web/src/components/graph/GraphNode.tsx` (new)
```tsx
import { memo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Devices } from '@phosphor-icons/react';
import { BADGE_W, CHIP_W, GUTTER_W, ID_W, REMOTE_W, ROW_H, fmtDay, fmtTime, nodeTitle, type LaidNode } from '../../lib/sessionGraph';

export interface GraphNodeProps {
  laid: LaidNode;
  /** Dot centre. */
  x: number;
  y: number;
  /** Start of the label column (shared by every row). */
  labelX: number;
  /** Full row width (hit area). */
  width: number;
  selected: boolean;
  onSelect: (nodeId: string) => void;
  onToggle: (sessionId: string) => void;
  /**
   * Phase 13 slot (the "unfinished" badge): SVG content drawn in its own BADGE_W column after the
   * chip, inside a <g> translated to (column start, row centre). Absent → the column collapses.
   */
  badge?: ReactNode;
}

/** One graph row: gutter time, dot (halo when live), node id, +N chip, badge slot, other-host mark, title. */
export const GraphNode = memo(function GraphNode({ laid, x, y, labelX, width, selected, onSelect, onToggle, badge }: GraphNodeProps) {
  const { node, root, childCount, descendants, expanded, firstOfDay } = laid;
  const remote = !node.available;
  const top = y - ROW_H / 2;
  const r = root ? 6 : 4.5;
  const cls = ['gnode', root ? 'root' : '', node.live ? 'live' : '', remote ? 'remote' : '', selected ? 'sel' : ''].filter(Boolean).join(' ');
  const title = nodeTitle(node);
  const chipX = labelX + ID_W;
  const hasBadge = badge !== undefined && badge !== null && badge !== false;
  const badgeX = chipX + CHIP_W;
  const remoteX = badgeX + (hasBadge ? BADGE_W : 0);
  const titleX = remoteX + (remote ? REMOTE_W : 0);
  const label = `${node.node_id} ${title}${node.live ? ', running' : ''}${remote ? `, on ${node.host || 'another device'}` : ''}`;

  const select = () => onSelect(node.node_id);
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  };
  const toggleClick = (e: MouseEvent<SVGGElement>) => {
    e.stopPropagation();
    onToggle(node.session_id);
  };
  const toggleKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onToggle(node.session_id);
  };

  return (
    <g className={cls} data-node={node.node_id} role="button" tabIndex={0} aria-label={label} aria-pressed={selected} onClick={select} onKeyDown={onKey}>
      <rect className="gnode-hit" x={0} y={top} width={width} height={ROW_H} />
      {firstOfDay && <line className="gnode-dayrule" x1={0} x2={width} y1={top + 0.5} y2={top + 0.5} />}
      {firstOfDay ? (
        <>
          <text className="gnode-day" x={GUTTER_W - 12} y={y - 3} textAnchor="end">
            {fmtDay(node)}
          </text>
          <text className="gnode-time" x={GUTTER_W - 12} y={y + 10} textAnchor="end">
            {fmtTime(node)}
          </text>
        </>
      ) : (
        <text className="gnode-time" x={GUTTER_W - 12} y={y + 4} textAnchor="end">
          {fmtTime(node)}
        </text>
      )}
      {node.live && <circle className="gnode-halo" cx={x} cy={y} r={r + 4} />}
      <circle className="gnode-dot" cx={x} cy={y} r={r} />
      <text className="gnode-id" x={labelX} y={y + 4}>
        {node.node_id}
      </text>
      {childCount > 0 && (
        <g
          className={expanded ? 'gchip open' : 'gchip'}
          role="button"
          tabIndex={0}
          aria-label={expanded ? `Hide ${descendants} sessions` : `Show ${descendants} more sessions`}
          aria-expanded={expanded}
          data-tip={expanded ? 'Collapse branch' : 'Expand branch'}
          onClick={toggleClick}
          onKeyDown={toggleKey}
        >
          <rect x={chipX} y={y - 9} width={CHIP_W - 8} height={18} rx={9} />
          <text x={chipX + (CHIP_W - 8) / 2} y={y + 4} textAnchor="middle">
            {expanded ? '−' : `+${descendants}`}
          </text>
        </g>
      )}
      {hasBadge && (
        <g className="gnode-badge" transform={`translate(${badgeX} ${y})`}>
          {badge}
        </g>
      )}
      {remote && (
        <g className="gnode-remote" data-tip={`Transcript is on ${node.host || 'another device'}`}>
          <Devices x={remoteX} y={y - 7} size={14} weight="duotone" color="#bdbcb4" />
          <text x={remoteX + 18} y={y + 4}>
            on {node.host || 'another device'}
          </text>
        </g>
      )}
      <text className="gnode-title" x={titleX} y={y + 4}>
        {title}
      </text>
    </g>
  );
});
```
**File:** `web/src/components/graph/SessionGraph.tsx` (new)
```tsx
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import type { SessionNode } from '../../types';
import { GraphEdges } from './GraphEdges';
import { GraphNode } from './GraphNode';
import { OVERSCAN, ROW_H, graphWidth, labelX, laneX, rowY, visibleRange, type GraphLayout } from '../../lib/sessionGraph';
import './SessionGraph.css';

export interface SessionGraphProps {
  layout: GraphLayout;
  /** Selected node id (`?node=`). */
  selected: string | null;
  onSelect: (nodeId: string) => void;
  /** Expand / collapse one node's children (session id). */
  onToggle: (sessionId: string) => void;
  /** Node id to bring into view once (the URL's node). */
  focus?: string | null;
  /** Phase 13 slot, forwarded to GraphNode `badge`. */
  renderBadge?: (node: SessionNode) => ReactNode;
  overscan?: number;
}

/**
 * Custom SVG git-graph (no graph library: settled). The scroll container holds a full-height SVG;
 * only rows in the viewport (plus overscan) mount, and only edges crossing them are drawn.
 */
export function SessionGraph({ layout, selected, onSelect, onToggle, focus = null, renderBadge, overscan = OVERSCAN }: SessionGraphProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const focused = useRef<string | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom (and a not-yet-laid-out box) reports 0: fall back to the window height.
    const read = () => setHeight(el.clientHeight || window.innerHeight);
    read();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(read);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);

  // Bring the URL's node into view once per node id, as soon as its row exists. Later polls that
  // rebuild the layout do not yank the scroll back.
  useEffect(() => {
    if (focus === null) {
      focused.current = null;
      return;
    }
    if (focused.current === focus) return;
    const hit = layout.byNodeId.get(focus);
    const el = ref.current;
    if (!hit || !el) return;
    focused.current = focus;
    const y = hit.row * ROW_H;
    const view = el.clientHeight || window.innerHeight;
    if (y >= el.scrollTop && y + ROW_H <= el.scrollTop + view) return;
    const target = Math.max(0, y - Math.floor(view / 3));
    el.scrollTop = target;
    setScrollTop(target);
  }, [focus, layout]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop);

  const total = layout.rows.length;
  const { first, last } = visibleRange(scrollTop, height, total, overscan);
  const lx = labelX(layout.lanes);
  const width = graphWidth(layout.lanes);
  const svgH = Math.max(total * ROW_H, ROW_H);
  const rows = last >= first ? layout.rows.slice(first, last + 1) : [];

  return (
    <div ref={ref} className="graph-scroll" onScroll={onScroll}>
      <svg className="graph-svg" width={width} height={svgH} viewBox={`0 0 ${width} ${svgH}`} role="group" aria-label="Session graph">
        <GraphEdges layout={layout} first={first} last={last} />
        {rows.map((laid) => (
          <GraphNode
            key={laid.node.session_id}
            laid={laid}
            x={laneX(laid.lane)}
            y={rowY(laid.row)}
            labelX={lx}
            width={width}
            selected={selected === laid.node.node_id}
            onSelect={onSelect}
            onToggle={onToggle}
            badge={renderBadge ? renderBadge(laid.node) : undefined}
          />
        ))}
      </svg>
    </div>
  );
}
```
**File:** `web/src/components/graph/SessionGraph.css` (new)
```css
/* Session graph (project-session-graph phase 10): monochrome on the wall's dark ground, mono ids. */
.graph-scroll { position: relative; height: max(360px, calc(100vh - 140px)); overflow: auto; overscroll-behavior: contain; }
.graph-svg { display: block; font-family: var(--sans); }

.gtrunk { stroke: var(--fg); stroke-width: 6; stroke-linecap: round; opacity: .85; }
.gedge { fill: none; stroke: var(--line-25); stroke-width: 2; }
.gedge.heur { stroke-dasharray: 3 4; }

.gnode { cursor: pointer; outline: none; }
.gnode-hit { fill: transparent; }
.gnode:hover .gnode-hit, .gnode:focus-visible .gnode-hit { fill: var(--hover); }
.gnode.sel .gnode-hit { fill: var(--chip-bg); }
.gnode-dayrule { stroke: var(--line); }
.gnode-day { fill: var(--fg); font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; }
.gnode-time { fill: var(--dim); font-family: var(--mono); font-size: 10.5px; }

.gnode-dot { fill: var(--fg); stroke: var(--bg); stroke-width: 2; }
.gnode.root .gnode-dot { stroke-width: 2.5; }
.gnode.remote .gnode-dot { fill: var(--bg); stroke: var(--id); stroke-width: 1.5; }
.gnode.sel .gnode-dot { fill: var(--bg); stroke: var(--fg); stroke-width: 3; }
.gnode-halo { fill: none; stroke: var(--fg); stroke-width: 1.5; transform-box: fill-box; transform-origin: center; animation: gpulse 1.6s ease-out infinite; pointer-events: none; }
@keyframes gpulse { 0% { transform: scale(.6); opacity: .9; } 100% { transform: scale(1.9); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .gnode-halo { animation: none; opacity: .6; } }

.gnode-id { fill: var(--id); font-family: var(--mono); font-size: 12px; letter-spacing: .02em; }
.gnode.sel .gnode-id { fill: var(--fg); }
.gnode-title { fill: var(--text); font-size: 13px; }
.gnode.remote .gnode-title { fill: var(--dim); }
.gnode-remote text { fill: var(--dim); font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; }

.gchip { cursor: pointer; outline: none; }
.gchip rect { fill: var(--chip-bg); stroke: var(--line-14); }
.gchip text { fill: var(--chip); font-family: var(--mono); font-size: 11px; }
.gchip.open rect { fill: transparent; }
.gchip:hover rect, .gchip:focus-visible rect { fill: var(--fg); }
.gchip:hover text, .gchip:focus-visible text { fill: var(--bg); }
```

### Step 11: Renderer tests (1000 nodes)
**File:** `web/src/components/graph/SessionGraph.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionGraph } from './SessionGraph';
import { buildForest, expandAll, layoutGraph, OVERSCAN, ROW_H } from '../../lib/sessionGraph';
import { childOf, makeSession, nodeIdAt } from '../../testing/sessionFixtures';
import type { SessionNode } from '../../types';

afterEach(cleanup);

const MAX_MOUNTED = () => Math.ceil(window.innerHeight / ROW_H) + 2 * OVERSCAN + 1;
const mounted = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-node]')).map((g) => g.getAttribute('data-node'));

function draw(nodes: SessionNode[], expanded: ReadonlySet<string> = new Set(), extra: Partial<Parameters<typeof SessionGraph>[0]> = {}) {
  const layout = layoutGraph(nodes, expanded);
  const onSelect = vi.fn();
  const onToggle = vi.fn();
  const r = render(<SessionGraph layout={layout} selected={null} onSelect={onSelect} onToggle={onToggle} {...extra} />);
  return { ...r, layout, onSelect, onToggle };
}

function scrollTo(container: HTMLElement, top: number) {
  const el = container.querySelector('.graph-scroll') as HTMLElement;
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: top });
  fireEvent.scroll(el);
}

describe('SessionGraph virtualization', () => {
  it('1000 roots: only the rows in the viewport mount, and scrolling swaps them', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => makeSession(nodeIdAt(i), i));
    const { container, layout } = draw(nodes);
    const ids = mounted(container);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.length).toBeLessThanOrEqual(MAX_MOUNTED());
    expect(ids).toContain(layout.rows[0]!.node.node_id);
    expect(ids).not.toContain(layout.rows[999]!.node.node_id);

    scrollTo(container, 500 * ROW_H);
    const after = mounted(container);
    expect(after).toContain(layout.rows[500]!.node.node_id);
    expect(after).not.toContain(layout.rows[0]!.node.node_id);
    expect(after.length).toBeLessThanOrEqual(MAX_MOUNTED() + OVERSCAN);
  });

  it('a fully expanded 1000-node forest mounts only visible rows and edges', () => {
    const nodes: SessionNode[] = [];
    for (let r = 0; r < 10; r++) {
      const root = makeSession(nodeIdAt(r * 100), r * 1000);
      nodes.push(root);
      for (let c = 1; c < 100; c++) nodes.push(childOf(root, nodeIdAt(r * 100 + c), r * 1000 + c));
    }
    const forest = buildForest(nodes);
    const { container, layout } = draw(nodes, expandAll(forest));
    expect(layout.rows).toHaveLength(1000);
    expect(mounted(container).length).toBeLessThanOrEqual(MAX_MOUNTED());
    expect(container.querySelectorAll('[data-edge]').length).toBeLessThan(layout.edges.length);
    expect(container.querySelector('.gtrunk')).not.toBeNull();
  });
});

describe('SessionGraph rows', () => {
  const root = makeSession('A0-3G', 0, { custom_title: 'session-graph-discussion', live: true });
  const kid = childOf(root, 'B1-00', 5, { host: 'GPD', available: false, name: 'impl-x-p1' });

  it('click selects by node id; the chip toggles without selecting', () => {
    const { onSelect, onToggle, container } = draw([root, kid]);
    fireEvent.click(container.querySelector('[data-node="A0-3G"]') as Element);
    expect(onSelect).toHaveBeenCalledWith('A0-3G');
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more sessions' }));
    expect(onToggle).toHaveBeenCalledWith(root.session_id);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('shows the id, pulses running nodes and marks other-host nodes', () => {
    const { container } = draw([root, kid], new Set([root.session_id]));
    expect(screen.getByText('A0-3G')).toBeTruthy();
    const live = container.querySelector('[data-node="A0-3G"]') as Element;
    expect(live.getAttribute('class')).toContain('live');
    expect(live.querySelector('.gnode-halo')).not.toBeNull();
    const remote = container.querySelector('[data-node="B1-00"]') as Element;
    expect(remote.getAttribute('class')).toContain('remote');
    expect(remote.textContent).toContain('on GPD');
    expect(remote.querySelector('.gnode-halo')).toBeNull();
    expect(screen.getByRole('button', { name: 'Hide 1 sessions' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('marks the selected node and fills the badge slot', () => {
    const layout = layoutGraph([root, kid], new Set());
    const { container } = render(
      <SessionGraph
        layout={layout}
        selected="A0-3G"
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        renderBadge={(n) => (n.node_id === 'A0-3G' ? <text data-testid="badge">unfinished</text> : null)}
      />,
    );
    const g = container.querySelector('[data-node="A0-3G"]') as Element;
    expect(g.getAttribute('aria-pressed')).toBe('true');
    expect(g.querySelector('.gnode-badge [data-testid="badge"]')).not.toBeNull();
  });

  it('focus scrolls a far node into the mounted window', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => makeSession(nodeIdAt(i), i));
    const layout = layoutGraph(nodes, new Set());
    const far = layout.rows[700]!.node.node_id;
    const { container } = render(<SessionGraph layout={layout} selected={far} focus={far} onSelect={vi.fn()} onToggle={vi.fn()} />);
    expect(mounted(container)).toContain(far);
  });
});
```

### Step 12: ProjectsPage
**File:** `web/src/pages/ProjectsPage.tsx` (new)
```tsx
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowsInLineVertical, ArrowsOutLineVertical } from '@phosphor-icons/react';
import { SessionGraph } from '../components/graph/SessionGraph';
import { useSessionGraph } from '../hooks/useSessionGraph';
import { ancestorsOf, buildForest, expandAll, layoutGraph } from '../lib/sessionGraph';
import type { SessionNode } from '../types';
import './ProjectsPage.css';

export interface ProjectsPageProps {
  /** Repo shown; null while none is chosen. App keys this page by repo, so a switch remounts it. */
  repo: string | null;
  /** The repo is still being resolved (selection GET / project list in flight). */
  resolving?: boolean;
  /** `?node=`: the selected node id, canonical. */
  node: string | null;
  onSelectNode: (nodeId: string | null) => void;
  /** Phase 11 slot: the node detail panel, beside the graph while a node is selected. */
  renderPanel?: (node: SessionNode, close: () => void) => ReactNode;
  /** Phase 13 slot: forwarded to each GraphNode's `badge`. */
  renderBadge?: (node: SessionNode) => ReactNode;
}

/**
 * The projects view's main area. Layout (later phases add to it, nothing here moves):
 *   .proj-bar   toolbar, icon-only (expand all / collapse all); phase 12 adds its graph <-> chat toggle here
 *   .proj-body  .proj-graph (SessionGraph) + .proj-panel (phase 11's renderPanel)
 *   phase 12 mounts `project-pill-query-input` after .proj-body
 */
export function ProjectsPage({ repo, resolving = false, node, onSelectNode, renderPanel, renderBadge }: ProjectsPageProps) {
  const graph = useSessionGraph(repo);
  const forest = useMemo(() => buildForest(graph.nodes), [graph.nodes]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // Reveal the URL's node once: expand its collapsed ancestors as soon as the graph has it.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (node === null) {
      revealed.current = null;
      return;
    }
    if (revealed.current === node) return;
    const hit = graph.nodes.find((n) => n.node_id === node);
    if (!hit) return;
    revealed.current = node;
    const up = ancestorsOf(forest, hit.session_id);
    if (up.length === 0) return;
    setExpanded((prev) => {
      if (up.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of up) next.add(id);
      return next;
    });
  }, [node, graph.nodes, forest]);

  // Esc clears the selection (the wall's Esc closes the answer panel, which is hidden here).
  useEffect(() => {
    if (node === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') onSelectNode(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [node, onSelectNode]);

  const layout = useMemo(() => layoutGraph(graph.nodes, expanded, forest), [graph.nodes, expanded, forest]);

  const toggle = useCallback((sessionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);
  const select = useCallback((id: string) => onSelectNode(id === node ? null : id), [node, onSelectNode]);
  const close = useCallback(() => onSelectNode(null), [onSelectNode]);

  const selectedNode = node === null ? null : (graph.nodes.find((n) => n.node_id === node) ?? null);
  const branchy = forest.children.size > 0;

  let content: ReactNode;
  if (repo === null) content = <p className="proj-empty">{resolving ? 'loading projects' : 'pick a project in the sidebar'}</p>;
  else if (!graph.loaded) content = <p className="proj-empty">loading sessions</p>;
  else if (graph.error !== null && graph.nodes.length === 0) content = <p className="proj-empty">could not load sessions: {graph.error}</p>;
  else if (graph.nodes.length === 0) content = <p className="proj-empty">no sessions recorded for {repo} yet</p>;
  else content = <SessionGraph layout={layout} selected={node} focus={node} onSelect={select} onToggle={toggle} renderBadge={renderBadge} />;

  return (
    <section className="proj" aria-label="Project sessions">
      <div className="proj-bar">
        <div className="proj-tools">
          <button
            type="button"
            className="ibtn hov"
            data-tip="Expand all"
            aria-label="Expand all"
            disabled={!branchy}
            onClick={() => setExpanded(expandAll(forest))}
          >
            <ArrowsOutLineVertical weight="duotone" />
          </button>
          <button
            type="button"
            className="ibtn hov"
            data-tip="Collapse all"
            aria-label="Collapse all"
            disabled={!branchy}
            onClick={() => setExpanded(new Set())}
          >
            <ArrowsInLineVertical weight="duotone" />
          </button>
        </div>
      </div>
      <div className="proj-body">
        <div className="proj-graph">{content}</div>
        {selectedNode !== null && renderPanel !== undefined && <aside className="proj-panel">{renderPanel(selectedNode, close)}</aside>}
      </div>
    </section>
  );
}
```
**File:** `web/src/pages/ProjectsPage.css` (new)
```css
.proj { padding-top: 10px; }
.proj-bar { display: flex; align-items: center; justify-content: flex-end; gap: 4px; height: 44px; }
.proj-tools { display: flex; gap: 4px; }
.proj-tools .ibtn { font-size: 19px; }
.proj-tools .ibtn:disabled { opacity: .35; cursor: default; }
.proj-body { display: flex; align-items: stretch; gap: 16px; min-width: 0; }
.proj-graph { flex: 1 1 auto; min-width: 0; }
.proj-panel { flex: 0 0 min(440px, 40vw); max-height: max(360px, calc(100vh - 140px)); overflow: auto; border-left: 1px solid var(--line); padding-left: 16px; box-sizing: border-box; }
.proj-empty { margin: 48px 0; font-family: var(--mono); font-size: 12px; color: var(--dim); letter-spacing: .03em; }
```

### Step 13: Rail
**File:** `web/src/components/Rail.tsx` (whole file)
**Code:**
```tsx
import { ChatsCircle, Images, NotePencil, SidebarSimple, SquaresFour, TextAa, Trash, TreeStructure, XCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Mode, View } from '../types';
import { MODE_TIP } from '../lib/filter';

export const MODE_ICON: Record<Mode, Icon> = { text: TextAa, images: Images, all: SquaresFour };

/** Tooltip / label of the Trash toggle, by the view it is pressed from. */
export const BIN_TIP: Record<View, string> = { wall: 'Recycle bin', bin: 'Back to the wall', history: 'Recycle bin', projects: 'Recycle bin' };

/** Tooltip / label of the chat-history toggle (phase 9). Pressed state says when it is open; a second press returns to the wall. */
export const HISTORY_TIP = 'Chat history';

/** Tooltip / label of the projects toggle (project-session-graph phase 10): the session graph, with the repo list in the sidebar. */
export const PROJECTS_TIP = 'Projects';

export interface RailProps {
  mode: Mode;
  view: View;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, view, active, onToggleSide, onAdd, onCycleMode, onToggleProjects, onToggleHistory, onToggleBin, onToggleTag, onClear }: RailProps) {
  const ModeIcon = MODE_ICON[mode];
  return (
    <nav className="rail">
      <button type="button" className="ibtn hov" data-tip="Toggle sidebar" data-tip-side="right" aria-label="Toggle sidebar" onClick={onToggleSide}>
        <SidebarSimple weight="duotone" />
      </button>
      <button type="button" className="ibtn hov" data-tip="New note" data-tip-side="right" aria-label="New note" onClick={onAdd}>
        <NotePencil weight="duotone" />
      </button>
      <button
        type="button"
        className={mode === 'text' ? 'ibtn' : 'ibtn on'}
        data-tip={`${MODE_TIP[mode]} (click to switch)`}
        data-tip-side="right"
        aria-label={`${MODE_TIP[mode]} (click to switch)`}
        onClick={onCycleMode}
      >
        <ModeIcon weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'projects' ? 'ibtn on' : 'ibtn hov'}
        data-tip={PROJECTS_TIP}
        data-tip-side="right"
        aria-label={PROJECTS_TIP}
        aria-pressed={view === 'projects'}
        onClick={onToggleProjects}
      >
        <TreeStructure weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'history' ? 'ibtn on' : 'ibtn hov'}
        data-tip={HISTORY_TIP}
        data-tip-side="right"
        aria-label={HISTORY_TIP}
        aria-pressed={view === 'history'}
        onClick={onToggleHistory}
      >
        <ChatsCircle weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'bin' ? 'ibtn on' : 'ibtn hov'}
        data-tip={BIN_TIP[view]}
        data-tip-side="right"
        aria-label={BIN_TIP[view]}
        aria-pressed={view === 'bin'}
        onClick={onToggleBin}
      >
        <Trash weight="duotone" />
      </button>
      <div className="rail-sep" />
      {active.map((t) => (
        <button key={t} type="button" className="rail-chip" data-tip="Remove filter" data-tip-side="right" onClick={() => onToggleTag(t)}>
          #{t}
        </button>
      ))}
      {active.length > 0 && (
        <button type="button" className="ibtn hov clear" data-tip="Clear filters" data-tip-side="right" aria-label="Clear filters" onClick={onClear}>
          <XCircle weight="duotone" />
        </button>
      )}
    </nav>
  );
}
```

### Step 14: Sidebar
**File:** `web/src/components/Sidebar.tsx` (whole file)
**Code:**
```tsx
import { ChatsCircle, Trash, TreeStructure } from '@phosphor-icons/react';
import type { Mode, ProjectSummary, TagCount, View } from '../types';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { sortProjects } from '../lib/projects';
import { BIN_TIP, HISTORY_TIP, MODE_ICON, PROJECTS_TIP } from './Rail';

export interface SidebarProps {
  mode: Mode;
  view: View;
  photoCount: number;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  /** Projects view: repos with sessions (null while loading). */
  projects?: ProjectSummary[] | null;
  /** Projects view: the repo shown. */
  repo?: string | null;
  onPickRepo?: (repo: string) => void;
}

export function Sidebar({
  mode,
  view,
  photoCount,
  tags,
  active,
  onMode,
  onToggleProjects,
  onToggleHistory,
  onToggleBin,
  onToggleTag,
  projects = null,
  repo = null,
  onPickRepo,
}: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const inProjects = view === 'projects';
  return (
    <aside className="side">
      <div className="side-modes">
        {MODE_ORDER.map((m) => {
          const I = MODE_ICON[m];
          return (
            <button
              key={m}
              type="button"
              className={view === 'wall' && m === mode ? 'ibtn on' : 'ibtn'}
              data-tip={MODE_TIP[m]}
              data-tip-side="below"
              aria-label={MODE_TIP[m]}
              onClick={() => onMode(m)}
            >
              <I weight="duotone" />
            </button>
          );
        })}
        <button
          type="button"
          className={inProjects ? 'ibtn on' : 'ibtn'}
          data-tip={PROJECTS_TIP}
          data-tip-side="below"
          aria-label={PROJECTS_TIP}
          aria-pressed={inProjects}
          onClick={onToggleProjects}
        >
          <TreeStructure weight="duotone" />
        </button>
        <button
          type="button"
          className={view === 'history' ? 'ibtn on' : 'ibtn'}
          data-tip={HISTORY_TIP}
          data-tip-side="below"
          aria-label={HISTORY_TIP}
          aria-pressed={view === 'history'}
          onClick={onToggleHistory}
        >
          <ChatsCircle weight="duotone" />
        </button>
        <button
          type="button"
          className={view === 'bin' ? 'ibtn on' : 'ibtn'}
          data-tip={BIN_TIP[view]}
          data-tip-side="below"
          aria-label={BIN_TIP[view]}
          aria-pressed={view === 'bin'}
          onClick={onToggleBin}
        >
          <Trash weight="duotone" />
        </button>
        {!inProjects && <span className="side-count">{photoCount} photos</span>}
      </div>
      <div className="side-sep" />
      {inProjects ? (
        <div className="side-repos" role="list" aria-label="Projects">
          {projects === null ? (
            <span className="side-note">loading</span>
          ) : projects.length === 0 ? (
            <span className="side-note">no sessions yet</span>
          ) : (
            sortProjects(projects).map((p) => (
              <div
                key={p.repo}
                role="listitem"
                data-repo={p.repo}
                className={p.repo === repo ? 'tagrow on' : 'tagrow'}
                aria-current={p.repo === repo ? 'true' : undefined}
                onClick={() => onPickRepo?.(p.repo)}
              >
                <span className="repo-name">
                  {p.live > 0 && <span className="repo-live" data-tip={`${p.live} running`} aria-label={`${p.live} running`} />}
                  {p.repo}
                </span>
                <span className="n">{p.sessions}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="side-tags">
          {sorted.map((t) => (
            <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
              <span>#{t.tag}</span>
              <span className="n">{t.count}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
```
**File:** `web/src/styles.css:66` (insert after the line `.tagrow .n { ... }`)
```css
.side-repos { display: flex; flex-direction: column; gap: 2px; }
.side-note { font-family: var(--mono); font-size: 11px; color: var(--dim); padding: 7px 10px; letter-spacing: .03em; }
.repo-name { display: inline-flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.repo-live { width: 6px; height: 6px; border-radius: 999px; background: currentColor; flex: none; animation: repo-pulse 1.6s ease-in-out infinite; }
@keyframes repo-pulse { 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .repo-live { animation: none; } }
```

### Step 15: Rail/Sidebar tests
**File:** `web/src/components/Rail.test.tsx` (whole file. The existing chat-history cases stay as they are, and the helpers gain `onToggleProjects`.)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ProjectSummary, View } from '../types';
import { Rail } from './Rail';
import { Sidebar, type SidebarProps } from './Sidebar';

afterEach(cleanup);

const rail = (view: View, onToggleHistory = vi.fn(), onToggleProjects = vi.fn()) =>
  render(
    <Rail
      mode="text"
      view={view}
      active={[]}
      onToggleSide={vi.fn()}
      onAdd={vi.fn()}
      onCycleMode={vi.fn()}
      onToggleProjects={onToggleProjects}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      onClear={vi.fn()}
    />,
  );

const side = (view: View, onToggleHistory = vi.fn(), extra: Partial<SidebarProps> = {}) =>
  render(
    <Sidebar
      mode="text"
      view={view}
      photoCount={0}
      tags={[]}
      active={[]}
      onMode={vi.fn()}
      onToggleProjects={vi.fn()}
      onToggleHistory={onToggleHistory}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      {...extra}
    />,
  );

/** Labels of the icon buttons in DOM order. */
const order = (root: Element) => Array.from(root.querySelectorAll('button.ibtn')).map((b) => b.getAttribute('aria-label'));

describe('chat-history icon', () => {
  it('sits directly above the recycle bin in the rail', () => {
    const { container } = rail('wall');
    const labels = order(container.querySelector('.rail') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Recycle bin') - 1);
  });

  it('sits directly before the recycle bin in the sidebar', () => {
    const { container } = side('wall');
    const labels = order(container.querySelector('.side-modes') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Recycle bin') - 1);
  });

  it('is pressed on the history page and calls the toggle', () => {
    const toggle = vi.fn();
    rail('history', toggle);
    const btn = screen.getByRole('button', { name: 'Chat history' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toBe('ibtn on');
    expect(btn.getAttribute('data-tip')).toBe('Chat history');
    expect(screen.getByRole('button', { name: 'Recycle bin' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('is not pressed on the wall; the sidebar mirrors the rail', () => {
    const toggle = vi.fn();
    side('history', toggle);
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Chat history' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    cleanup();
    rail('wall');
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('projects icon', () => {
  it('sits directly above chat history, in the rail and in the sidebar', () => {
    const r = rail('wall');
    const railLabels = order(r.container.querySelector('.rail') as Element);
    expect(railLabels.indexOf('Projects')).toBe(railLabels.indexOf('Chat history') - 1);
    cleanup();
    const s = side('wall');
    const sideLabels = order(s.container.querySelector('.side-modes') as Element);
    expect(sideLabels.indexOf('Projects')).toBe(sideLabels.indexOf('Chat history') - 1);
  });

  it('is icon-only, pressed on the projects view, and calls its toggle', () => {
    const toggle = vi.fn();
    rail('projects', vi.fn(), toggle);
    const btn = screen.getByRole('button', { name: 'Projects' });
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toBe('ibtn on');
    expect(screen.getByRole('button', { name: 'Chat history' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});

describe('sidebar repo list', () => {
  const projects: ProjectSummary[] = [
    { repo: 'seer', sessions: 4, live: 0, last_active_at: '2026-10-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
    { repo: 'mcp-notes', sessions: 12, live: 2, last_active_at: '2026-11-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
  ];

  it('replaces the tags with repos, most recent first, the shown one marked', () => {
    const pick = vi.fn();
    const { container } = side('projects', vi.fn(), { projects, repo: 'seer', onPickRepo: pick, tags: [{ tag: 'kitchen', count: 3, last_used: null }] });
    expect(container.querySelector('.side-tags')).toBeNull();
    expect(screen.queryByText('#kitchen')).toBeNull();
    const list = screen.getByRole('list', { name: 'Projects' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-repo'))).toEqual(['mcp-notes', 'seer']);
    expect(rows[1]!.className).toBe('tagrow on');
    expect(rows[0]!.querySelector('.repo-live')).not.toBeNull();
    expect(rows[0]!.textContent).toContain('12');
    fireEvent.click(rows[0]!);
    expect(pick).toHaveBeenCalledWith('mcp-notes');
  });

  it('says loading before the list arrives and keeps tags outside the projects view', () => {
    side('projects', vi.fn(), { projects: null });
    expect(screen.getByText('loading')).toBeTruthy();
    cleanup();
    const { container } = side('wall', vi.fn(), { projects, tags: [{ tag: 'kitchen', count: 3, last_used: null }] });
    expect(container.querySelector('.side-repos')).toBeNull();
    expect(screen.getByText('#kitchen')).toBeTruthy();
  });
});
```

### Step 16: Header
**File:** `web/src/components/Header.tsx`
**Change 1** (line 3, imports): add after `import { HISTORY_HINT } from '../lib/timeline';`
```tsx
import { PROJECTS_HINT } from '../lib/projects';
```
**Change 2** (line 14, after `history?: boolean;`):
```tsx
  /** The projects view is showing (project-session-graph phase 10): no "Last edited" link, and the hint explains the graph. */
  projects?: boolean;
```
**Change 3** (lines 22-23): replace
```tsx
export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, history = false, onJumpLast, onAdd }: HeaderProps) {
  const hint = bin ? BIN_HINT : history ? HISTORY_HINT : WALL_HINT;
```
with
```tsx
export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, history = false, projects = false, onJumpLast, onAdd }: HeaderProps) {
  const hint = bin ? BIN_HINT : history ? HISTORY_HINT : projects ? PROJECTS_HINT : WALL_HINT;
```
**Change 4** (line 28): `{!bin && !history && last && (` -> `{!bin && !history && !projects && last && (`

### Step 17: App wiring
**File:** `web/src/App.tsx`

**17a (line 18, imports):** replace
```tsx
import { hrefForView, routeFromLocation } from './lib/route';
```
with
```tsx
import { hrefForView, NO_PROJECT_ROUTE, projectsRouteFromLocation, routeFromLocation, type ProjectsRoute } from './lib/route';
```
and after line 20 (`import { HistoryPage } from './pages/HistoryPage';`) add
```tsx
import { ProjectsPage } from './pages/ProjectsPage';
import { useProjects } from './hooks/useProjects';
import { projectHeading, projectsCountLine, sortProjects } from './lib/projects';
```

**17b (line 63):** replace `  const [side, setSide] = useState(false);` with
```tsx
  // Opening the projects view expands the sidebar with the repo list; a /projects deep link starts that way.
  const [side, setSide] = useState(() => projectsRouteFromLocation(window.location) !== null);
```

**17c (lines 70-72):** replace
```tsx
  // `/history[?thread=ID]` opens straight into the chat history page (served by the SPA fallback).
  const [view, setView] = useState<View>(() => (routeFromLocation(window.location).history ? 'history' : 'wall'));
  const [historyThread, setHistoryThread] = useState<string | null>(() => routeFromLocation(window.location).thread);
```
with
```tsx
  // `/history[?thread=ID]` opens straight into the chat history page, `/projects[?repo=&node=]`
  // into the session graph (both served by the SPA fallback).
  const [view, setView] = useState<View>(() => {
    if (routeFromLocation(window.location).history) return 'history';
    return projectsRouteFromLocation(window.location) !== null ? 'projects' : 'wall';
  });
  const [historyThread, setHistoryThread] = useState<string | null>(() => routeFromLocation(window.location).thread);
  const [projectsRoute, setProjectsRoute] = useState<ProjectsRoute>(() => projectsRouteFromLocation(window.location) ?? NO_PROJECT_ROUTE);
  // Fetches only while the projects view is shown; every visit re-reads the server-side selection.
  const projectsStore = useProjects(view === 'projects');
  const { pick: pickProject } = projectsStore;
  // Shown repo: the URL's, else the one both laptops last picked, else the most recently active.
  // The fallback uses the sidebar's sort, so it matches the sidebar's top row whatever order the server sends.
  const mostRecentRepo = projectsStore.projects ? (sortProjects(projectsStore.projects)[0]?.repo ?? null) : null;
  const projectRepo = projectsRoute.repo ?? (projectsStore.selectedLoaded ? (projectsStore.selected ?? mostRecentRepo) : null);
  const resolvingRepo = projectsRoute.repo === null && (!projectsStore.selectedLoaded || projectsStore.projects === null);
```

**17d (after line 278, the end of `toggleHistory`):** insert
```tsx
  /** Rail / sidebar projects icon: open the graph and expand the sidebar with the repo list; a second press returns to the wall. */
  const toggleProjects = useCallback(() => {
    const opening = wallRef.current.view !== 'projects';
    setView(opening ? 'projects' : 'wall');
    if (opening) setSide(true);
  }, []);

  /** Sidebar repo row: show it, store it server-side (both laptops), drop any node selection. */
  const pickRepo = useCallback(
    (repo: string) => {
      pickProject(repo);
      setProjectsRoute({ repo, node: null });
    },
    [pickProject],
  );

  /** Graph click: `?node=`. Pins the shown repo into the URL too, so the link is complete. */
  const selectNode = useCallback((node: string | null) => setProjectsRoute({ repo: projectRepo, node }), [projectRepo]);
```

**17e (lines 298-305):** replace
```tsx
  // The address bar follows the view (pathname guard, lib/route.ts hrefForView): entering the
  // history page pushes /history[?thread=]; leaving it pushes / only when the path is /history.
  // Wall and bin never rewrite a non-history URL, so /?note=ID survives a switch to the wall
  // (Phase 11's show-on-wall relies on this). This is the one URL-sync owner; no other phase adds one.
  useEffect(() => {
    const href = hrefForView(view, historyThread, window.location);
    if (href !== null) window.history.pushState(null, '', href);
  }, [view, historyThread]);
```
with
```tsx
  // The address bar follows the view (pathname guard, lib/route.ts hrefForView): entering the
  // history page pushes /history[?thread=], the projects view /projects[?repo=&node=]; leaving
  // either pushes / only when the path is theirs. Wall and bin never rewrite another URL, so
  // /?note=ID survives a switch to the wall (Phase 11's show-on-wall relies on this). This is the
  // one URL-sync owner; no other phase adds one.
  useEffect(() => {
    const href = hrefForView(view, historyThread, window.location, projectsRoute);
    if (href !== null) window.history.pushState(null, '', href);
  }, [view, historyThread, projectsRoute]);
```

**17f (lines 307-317):** replace
```tsx
  // Back / forward between /history and the wall. A /?note= target is handled by useDeepLink's own
  // popstate listener (planReveal moves the view to the wall).
  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation(window.location);
      setHistoryThread(r.thread);
      setView((v) => (r.history ? 'history' : v === 'history' ? 'wall' : v));
    };
```
with
```tsx
  // Back / forward between /history, /projects and the wall. A /?note= target is handled by
  // useDeepLink's own popstate listener (planReveal moves the view to the wall).
  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation(window.location);
      const p = projectsRouteFromLocation(window.location);
      setHistoryThread(r.thread);
      if (p !== null) setProjectsRoute(p);
      setView((v) => (r.history ? 'history' : p !== null ? 'projects' : v === 'history' || v === 'projects' ? 'wall' : v));
    };
```
(the following `window.addEventListener('popstate', onPop); ...` lines are unchanged.)

**17g (lines 653-654):** replace
```tsx
      // The answer panel is hidden on the history page; Esc there must not end the wall conversation.
      if (e.key === 'Escape' && chatOpen && !pinned && view !== 'history') closeChat();
```
with
```tsx
      // The answer panel is hidden on the history and projects pages; Esc there must not end the wall conversation.
      if (e.key === 'Escape' && chatOpen && !pinned && view !== 'history' && view !== 'projects') closeChat();
```

**17h (lines 664-691, Rail + Sidebar):** replace
```tsx
          <Rail
            mode={mode}
            view={view}
            active={active}
            onToggleSide={() => setSide((s) => !s)}
            onAdd={() => void addNote()}
            onCycleMode={() => {
              setMode(nextMode);
              setView('wall');
            }}
            onToggleHistory={toggleHistory}
            onToggleBin={toggleBin}
            onToggleTag={toggleTag}
            onClear={() => setActive([])}
          />
          {side && (
            <Sidebar
              mode={mode}
              view={view}
              photoCount={photoCount}
              tags={tags}
              active={active}
              onMode={pickMode}
              onToggleHistory={toggleHistory}
              onToggleBin={toggleBin}
              onToggleTag={toggleTag}
            />
          )}
```
with
```tsx
          <Rail
            mode={mode}
            view={view}
            active={active}
            onToggleSide={() => setSide((s) => !s)}
            onAdd={() => void addNote()}
            onCycleMode={() => {
              setMode(nextMode);
              setView('wall');
            }}
            onToggleProjects={toggleProjects}
            onToggleHistory={toggleHistory}
            onToggleBin={toggleBin}
            onToggleTag={toggleTag}
            onClear={() => setActive([])}
          />
          {side && (
            <Sidebar
              mode={mode}
              view={view}
              photoCount={photoCount}
              tags={tags}
              active={active}
              onMode={pickMode}
              onToggleProjects={toggleProjects}
              onToggleHistory={toggleHistory}
              onToggleBin={toggleBin}
              onToggleTag={toggleTag}
              projects={projectsStore.projects}
              repo={projectRepo}
              onPickRepo={pickRepo}
            />
          )}
```

**17i (lines 693-711, Header + main content head):** replace
```tsx
            <Header
              heading={view === 'history' ? HISTORY_HEADING : view === 'bin' ? BIN_HEADING : headingFor(mode, active)}
              countLine={
                view === 'history'
                  ? historyCountLine(history.items, history.hasMore)
                  : view === 'bin'
                    ? binCountLine(binStore.bin, active)
                    : countLineFor(mode, active, notes, visible, photos)
              }
```
with
```tsx
            <Header
              heading={
                view === 'projects'
                  ? projectHeading(projectRepo)
                  : view === 'history'
                    ? HISTORY_HEADING
                    : view === 'bin'
                      ? BIN_HEADING
                      : headingFor(mode, active)
              }
              countLine={
                view === 'projects'
                  ? projectsCountLine(projectsStore.projects, projectRepo)
                  : view === 'history'
                    ? historyCountLine(history.items, history.hasMore)
                    : view === 'bin'
                      ? binCountLine(binStore.bin, active)
                      : countLineFor(mode, active, notes, visible, photos)
              }
```
then replace
```tsx
              history={view === 'history'}
```
with
```tsx
              history={view === 'history'}
              projects={view === 'projects'}
```
then replace
```tsx
            {view === 'history' ? (
              <HistoryPage store={history} focusThread={historyThread} now={now} pushUndo={pushUndo} seedImage={chatSeed} />
```
with
```tsx
            {view === 'projects' ? (
              <ProjectsPage key={projectRepo ?? ''} repo={projectRepo} resolving={resolvingRepo} node={projectsRoute.node} onSelectNode={selectNode} />
            ) : view === 'history' ? (
              <HistoryPage store={history} focusThread={historyThread} now={now} pushUndo={pushUndo} seedImage={chatSeed} />
```

**17j (line 733):** `{chat.open && view !== 'history' && (` -> `{chat.open && view !== 'history' && view !== 'projects' && (`
**17k (line 752):** `{view !== 'history' && (` -> `{view !== 'history' && view !== 'projects' && (` (the wall ChatBar. Phase 12 mounts the project pill inside ProjectsPage.)

**Impact:** the wall, bin and history behave as before. `/projects` is a new view.

### Step 18: App-level test
**File:** `web/src/App.projects.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note, ProjectSummary } from './types';
import { makeNote } from './testing/fixtures';
import { childOf, makeSession } from './testing/sessionFixtures';
import { App } from './App';

const iso = new Date().toISOString();
const notes: Note[] = [makeNote('A-B32', 'buy fennel #kitchen', { created: iso })];
const projects: ProjectSummary[] = [
  { repo: 'mcp-notes', sessions: 3, live: 1, last_active_at: '2026-11-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
  { repo: 'seer', sessions: 1, live: 0, last_active_at: '2026-10-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
];
const root = makeSession('A0-3G', 0, { custom_title: 'session-graph-discussion', live: true });
const graphs: Record<string, unknown> = {
  'mcp-notes': { repo: 'mcp-notes', nodes: [root, childOf(root, 'B1-00', 5), childOf(root, 'B2-00', 6)] },
  seer: { repo: 'seer', nodes: [makeSession('C0-01', 0)] },
};

let calls: string[];
let stored: string | null;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  stored = 'mcp-notes';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (url === '/api/projects') return json({ projects });
      if (url === '/api/projects/selected') {
        if (method === 'PUT') stored = (JSON.parse(String(init?.body)) as { repo: string | null }).repo;
        return json({ repo: stored });
      }
      const m = /^\/api\/projects\/([^/]+)\/sessions/.exec(url);
      if (m) return json(graphs[decodeURIComponent(m[1]!)] ?? { repo: m[1], nodes: [] });
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: () => ({}) as Animation });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  window.history.replaceState(null, '', '/');
});

const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const at = (url: string) => window.history.replaceState(null, '', url);
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
const where = () => window.location.pathname + window.location.search;
const rail = () => document.querySelector('.rail') as HTMLElement;
const node = (id: string) => document.querySelector(`[data-node="${id}"]`);

describe('App: projects view', () => {
  it('the rail icon opens /projects on the server-selected repo, with the repo list in the sidebar', async () => {
    render(<App />);
    fireEvent.click(within(rail()).getByRole('button', { name: 'Projects' }));
    await waitFor(() => expect(where()).toBe('/projects'));
    await screen.findByText('A0-3G');
    expect(h1()).toBe('mcp-notes.');
    expect(calls).toContain('GET /api/projects/selected');
    const list = screen.getByRole('list', { name: 'Projects' });
    expect(within(list).getAllByRole('listitem').map((r) => r.getAttribute('data-repo'))).toEqual(['mcp-notes', 'seer']);
    // Children start collapsed behind the chip.
    expect(node('B1-00')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 2 more sessions' })).toBeTruthy();
    // A second press returns to the wall at /.
    fireEvent.click(within(rail()).getByRole('button', { name: 'Projects' }));
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('picking a repo stores it server-side and puts it in the URL', async () => {
    at('/projects');
    render(<App />);
    await screen.findByText('A0-3G');
    const list = screen.getByRole('list', { name: 'Projects' });
    fireEvent.click(within(list).getByText('seer'));
    await waitFor(() => expect(where()).toBe('/projects?repo=seer'));
    await screen.findByText('C0-01');
    expect(calls).toContain('PUT /api/projects/selected');
    expect(stored).toBe('seer');
    expect(h1()).toBe('seer.');
  });

  it('a deep link to a child node expands its branch and selects it', async () => {
    at('/projects?repo=mcp-notes&node=b1-00');
    render(<App />);
    await screen.findByText('B1-00');
    await waitFor(() => expect(node('B1-00')?.getAttribute('aria-pressed')).toBe('true'));
    expect(where()).toBe('/projects?repo=mcp-notes&node=b1-00');
  });

  it('clicking a node sets ?node=, Back leaves for the wall', async () => {
    at('/projects');
    render(<App />);
    await screen.findByText('A0-3G');
    fireEvent.click(node('A0-3G') as Element);
    await waitFor(() => expect(where()).toBe('/projects?repo=mcp-notes&node=A0-3G'));
    expect(node('A0-3G')?.getAttribute('aria-pressed')).toBe('true');
    pop('/');
    await waitFor(() => expect(within(rail()).getByRole('button', { name: 'Projects' }).getAttribute('aria-pressed')).toBe('false'));
    expect(h1()).not.toBe('mcp-notes.');
  });
});
```
Note on the deep-link case: `hrefForView` compares the parsed (canonical) route, so `node=b1-00` in the address bar already equals `{ node: 'B1-00' }` and no push happens. The URL keeps the user's casing, which is intended.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:**
- `npx vitest run web/src/lib/sessionGraph.test.tsx web/src/lib/route.test.tsx web/src/lib/projects.test.tsx web/src/sessionsApi.test.tsx web/src/components/graph/SessionGraph.test.tsx web/src/components/Rail.test.tsx web/src/App.projects.test.tsx`
- `npm test` (the whole unit suite: App history/deeplink/bin tests must stay green)
- `npm run test:int` is unaffected (no server change), but run it per invariant 1.

**Manual check:** `npm run dev` + `npm run dev:web`, open `http://localhost:5173/projects`:
1. The sidebar opens with repos. The rail TreeStructure icon is filled (pressed).
2. Roots sit on a thick trunk, newest at the top, with day rules in the gutter.
3. `+N` expands a branch. One swarm wave's impl phases sit in adjacent lanes.
4. A running session's dot pulses. A GPD session shows the devices icon and "on GPD".
5. Scrolling a large repo stays smooth: DevTools shows about 30-50 `g.gnode` elements at any time.
6. Clicking a node updates `?node=`. Esc clears it.
7. Pick a repo, reload `/projects` on the other laptop: it opens on the same repo.

**Exit criteria:** `/projects` renders the server-selected repo's graph from phase 7's payload. Rail and sidebar carry the icon-only Projects toggle. Picking a repo PUTs `/api/projects/selected` and updates the URL. The layout tests (newest at top, trunk, wave lanes, lane reuse, collapse counts, cycles), the route tests, the 1000-node virtualization tests and the Rail/Sidebar tests pass. `npm run typecheck` and `npm test` are green.

## Handoffs

- **Phase 7 (reconciled):** this phase mirrors phase 7's published `ProjectsPayload`, `GraphPayload` and `GraphNode` in `web/src/types.ts` and polls with `If-None-Match` (no SSE event exists). If phase 7's wire changes, only `web/src/sessionsApi.ts` and those types change.
- **Phase 11:** mount `NodePanel`/`Timeline` through `ProjectsPage`'s `renderPanel(node, close)` prop. It is called only while a node is selected, inside `<aside className="proj-panel">`. Reconciled: phase 11 defaults it inside `ProjectsPage` (App.tsx stays as Step 17i wrote it). `close()` clears `?node=`. The Tree/Timeline toggle can reuse `buildForest`/`ancestorsOf`/`layoutGraph` from `web/src/lib/sessionGraph.ts`.
- **Phase 12:** this phase hides the wall `ChatBar` and `AnswerPanel` on `view === 'projects'` (Step 17j/k). Mount `project-pill-query-input` inside `ProjectsPage` after `.proj-body`. Put the graph <-> `project-chat-history` icon toggle in `.proj-bar` (left of `.proj-tools`). `.graph-scroll`'s height (`SessionGraph.css`) will need to subtract the pill's height. The route has no `tab` param, so if the toggle should survive reload, extend `ProjectsRoute` in `web/src/lib/route.ts`.
- **Phase 13:** fill the badge through `ProjectsPage`'s `renderBadge(node)` prop (reconciled: phase 13 defaults it inside `ProjectsPage`; `GraphNode.tsx` is not edited), which is forwarded to `GraphNode` `badge`. The slot is a `<g>` translated to (badge column x, row centre y) with `BADGE_W = 92` px reserved only when a badge is returned. `SessionNode.unfinished` is already typed `boolean | null`.
- **Phase 14:** README web section (Projects view, `/projects?repo=&node=`), CHANGELOG entry.
- **Not done (drive-by):** the sidebar's `.side-modes` row now holds six icon buttons in 216 px. Flex shrinks them slightly, and the photo count is hidden in the projects view to make room. A later redesign of that row is out of scope here.

## Rollback

Revert this phase's commit. It touches only `web/`. The new files go away and `Rail.tsx`, `Sidebar.tsx`, `Header.tsx`, `App.tsx`, `route.ts`, `types.ts`, `styles.css` and `Rail.test.tsx`/`route.test.tsx` return to their phase-7 state. No data or schema is involved. A selection already PUT to `app_settings` is harmless and is ignored without this UI.
