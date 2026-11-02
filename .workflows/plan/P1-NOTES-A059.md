> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 11. Source: `.workflows/plan/project-session-graph/phase-11.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 11: Web: node detail panel, Tree/Timeline, resume action

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R7 (the node detail panel with its Tree/Timeline toggle), R8 (resume/spawn from the wall, confirm only cross-host)
**Depends on:** Phase 9 (`POST /api/sessions/:nodeId/resume`), Phase 10 (`ProjectsPage`, `?node=` selection, graph payload, detail-panel slot). Phase 7's `GET /api/sessions/:nodeId` is reached through 9 and 10.
**Difficulty:** NORMAL
**Package:** `web/`

---

## Goal

Selecting a node in the project graph (`/projects?repo=<repo>&node=<nodeId>`) opens a panel that
shows the session: summary, prompts, commits, the notes it made (linked to the wall's `?note=`),
tokens and cost, its node id (one click copies it), host and availability. The panel can switch its
subtree between an indented Tree and a Gantt Timeline drawn in plain SVG. Two icon-only actions
resume the session in tmux or spawn a fresh session with its context. Neither asks for confirmation,
except for a node whose transcript is on the other machine: then the existing `ConfirmDialog` asks
first, and a `not_on_this_machine` answer is reported in the panel.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/sessionDetailApi.ts`: `SessionDetail`, `SessionCommit`, `SessionNoteRef`, `SessionTokens`, `ParentLinkSource`, `ResumeOptions`, `ResumeResult`, `normalizeSessionDetail(wire)`, `fetchSessionDetail(nodeId, signal?)`, `resumeSession(nodeId, opts?)`, `resumeNotice(result, fresh)`, `resumeErrorNotice(err, detail)`
- `web/src/lib/subtree.ts`: `SubtreeNode`, `SubtreeRow`, `GraphLikeNode`, `toSubtreeNodes(nodes)`, `subtreeRows(nodes, rootId)`, `GANTT`, `GanttBar`, `GanttTick`, `GanttLayout`, `timelineLayout(rows, now)`
- `web/src/lib/sessionFormat.ts`: `formatCount(n)`, `formatCost(usd)`
- `web/src/components/graph/NodePanel.tsx` (`NodePanel`, `NodePanelProps`, `SubtreeView`), `NodePanel.css`
- `web/src/components/graph/SubtreeTree.tsx` (`SubtreeTree`), `web/src/components/graph/SubtreeTimeline.tsx` (`SubtreeTimeline`)
- Tests: `web/src/sessionDetailApi.test.tsx`, `web/src/lib/subtree.test.tsx`, `web/src/lib/sessionFormat.test.tsx`, `web/src/components/graph/NodePanel.test.tsx`, `web/src/components/ConfirmDialog.test.tsx`

**Signature changes:** `ConfirmDialogProps` gains two OPTIONAL props, `confirmLabel?: string` (default `'Delete anyway'`) and `confirmIcon?: ReactNode` (default the duotone `Trash`). Every existing caller (`App.tsx:796`, `NoteEditor.tsx:335`) and every existing test that clicks "Delete anyway" is unchanged.

**Requires (from earlier phases):**
- Phase 7 (as published): `GET /api/sessions/:nodeId` (case-insensitive, dash optional) returns
  `200 SessionDetail = { session: GraphNode & { entrypoint, version, models, transcript_path, last_prompt, summary, summarized_at, final_message }, prompts: {text, at}[], commits: {sha, subject}[], files_edited: string[], plan_docs: string[], notes: {id, excerpt, tags, created_at}[], parent: NodeRef | null, children: NodeRef[] }`,
  `400 invalid_node_id`, `404 not_found`. `GraphNode` carries `session_id, node_id, repo, host, available, live, status, cwd, branch, name, custom_title, ai_title, title, started_at, last_active_at, tokens {input, output, cache_read, cache_write, total}, cost_usd, parent_node_id, parent_link_source, ...`; `NodeRef` carries `node_id, title, ...`. `notes` are the live notes whose `origin.claude_session` is this session (newest first, <= 50).
- Phase 9 (as published): `POST /api/sessions/:nodeId/resume` with JSON body `{}` / `{fresh: true}` / `{prompt}` returns 200 `{action: 'focused'|'messaged'|'resumed'|'spawned', window?, cwd?, original_cwd?}`, `404 {error: 'not_found'}`, `404 {error: 'not_on_this_machine', host}`, `409 {error: 'no_tmux'}` / `409 {error: 'live_outside_tmux', pid}`, `500 {error: 'spawn_failed', message}`, and 403 from `sameOriginOnly`.
- Phase 10 (as published): `web/src/pages/ProjectsPage.tsx` with props `repo`, `resolving?`,
  `node: string | null` (the canonical `?node=`), `onSelectNode(nodeId | null)`,
  `renderPanel?(node: SessionNode, close: () => void)` and `renderBadge?(node: SessionNode)`;
  inside, `const graph = useSessionGraph(repo)` (`graph.nodes: SessionNode[]`), `close`
  (= `onSelectNode(null)`), and `selectedNode: SessionNode | null` (the `?node=` row of the graph). It
  renders `<aside className="proj-panel">{renderPanel(selectedNode, close)}</aside>` only while
  `selectedNode !== null && renderPanel !== undefined`. `SessionNode` (phase 10's mirror of phase 7's
  `GraphNode`) has `session_id`, `node_id`, `parent_session_id`, `parent_node_id`, `name`,
  `custom_title`, `ai_title`, `started_at`, `last_active_at`, `live`, `available`, `host`, so it is
  assignable to `GraphLikeNode` (Step 2) as is.
- `App.tsx` renders `<Tooltip />` and wraps everything in `IconContext` (true today); `ProjectsPage` is rendered inside that tree (phase 10).

**Leaves alone (owned by others):** the graph layout and renderer (`web/src/lib/sessionGraph.ts`, `web/src/components/graph/*` except the three new files) and `web/src/sessionsApi.ts` / `web/src/types.ts` additions (phase 10); the chat bar, `project-pill-query-input` and the header graph/history toggle (phase 12); the "unfinished" badge (phase 13); every server file.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/components/ConfirmDialog.tsx` | modify (whole file, 54 lines) | optional `confirmLabel` / `confirmIcon` props; defaults keep today's trash "Delete anyway" |
| `web/src/components/ConfirmDialog.test.tsx` | create | default and custom confirm button |
| `web/src/sessionDetailApi.ts` | create | detail type, tolerant normaliser, detail fetch, resume POST, notice strings |
| `web/src/sessionDetailApi.test.tsx` | create | wire variants, 404, resume bodies, errors, notices |
| `web/src/lib/subtree.ts` | create | graph node adapter, subtree DFS, Gantt layout (pure) |
| `web/src/lib/subtree.test.tsx` | create | adapter, order, depth, cycles, bar geometry, clamp, ticks |
| `web/src/lib/sessionFormat.ts` | create | `12.3k` / `1.5M` token counts, `$1.23` cost |
| `web/src/lib/sessionFormat.test.tsx` | create | formatter cases |
| `web/src/components/graph/SubtreeTree.tsx` | create | indented subtree list |
| `web/src/components/graph/SubtreeTimeline.tsx` | create | custom SVG Gantt |
| `web/src/components/graph/NodePanel.tsx` | create | the panel |
| `web/src/components/graph/NodePanel.css` | create | panel, tree and Gantt styles |
| `web/src/components/graph/NodePanel.test.tsx` | create | jsdom component tests |
| `web/src/pages/ProjectsPage.tsx` | modify (phase 10's `renderPanel` slot) | default `renderPanel` to `NodePanel` |

## Implementation Steps

### Step 1: Let ConfirmDialog confirm something other than a delete
**File:** `web/src/components/ConfirmDialog.tsx:1-54` (whole file)
**Change:** Two optional props; the docstring no longer says "trash confirms". Defaults are byte-for-byte today's button, so `App.bin.test.tsx:101` and `NoteEditor.test.tsx:178` still find "Delete anyway".
**Code:**
```tsx
import { useEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { Trash, X } from '@phosphor-icons/react';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The confirm button's tooltip and accessible name. Default "Delete anyway" (every delete confirm). */
  confirmLabel?: string;
  /** The confirm button's icon. Default the duotone trash. */
  confirmIcon?: ReactNode;
}

const SELECTOR = '[data-modal="confirm"]';

/** True while a confirm dialog is mounted. Window Esc listeners registered before it yield via this (Lightbox's seam). */
export function isConfirmOpen(doc: Document = document): boolean {
  return doc.querySelector(SELECTOR) !== null;
}

// mousedown, not click, keeps focus where it is: an open editor must not blur-save mid-delete.
const keepFocus = (e: MouseEvent) => e.preventDefault();

/** A small question over everything: the confirm icon (trash unless told otherwise) confirms (Enter), X or the backdrop cancels (Esc). */
export function ConfirmDialog({ message, onConfirm, onCancel, confirmLabel = 'Delete anyway', confirmIcon }: ConfirmDialogProps) {
  const live = useRef({ onConfirm, onCancel });
  live.current = { onConfirm, onCancel };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.key === 'Enter') live.current.onConfirm();
      else live.current.onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="cf" data-modal="confirm" onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); onCancel(); }}>
      <div className="cf-box" role="alertdialog" aria-label={message} onClick={(e) => e.stopPropagation()}>
        <p className="cf-msg">{message}</p>
        <div className="cf-actions">
          <button type="button" className="cf-btn" data-tip="Cancel" aria-label="Cancel" onMouseDown={keepFocus} onClick={onCancel}>
            <X weight="duotone" />
          </button>
          <button type="button" className="cf-btn cf-yes" data-tip={confirmLabel} aria-label={confirmLabel} onMouseDown={keepFocus} onClick={onConfirm}>
            {confirmIcon ?? <Trash weight="duotone" />}
          </button>
        </div>
      </div>
    </div>
  );
}
```
**Impact:** none for existing callers.

**File:** `web/src/components/ConfirmDialog.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Play } from '@phosphor-icons/react';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('defaults to the trash "Delete anyway" button', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog message="Delete it?" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('takes another label and icon for a non-delete question', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog message="Resume anyway?" confirmLabel="Try anyway" confirmIcon={<Play weight="duotone" />} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.queryByRole('button', { name: 'Delete anyway' })).toBeNull();
    const yes = screen.getByRole('button', { name: 'Try anyway' });
    expect(yes.getAttribute('data-tip')).toBe('Try anyway');
    fireEvent.click(yes);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

### Step 2: Pure subtree helpers and the Gantt layout
**File:** `web/src/lib/subtree.ts` (new)
**Change:** The adapter from phase 10's graph nodes, the DFS that builds the Tree rows, and the Gantt geometry. All pure, all unit-tested. Children are listed oldest first (outline order; a Gantt reads left-to-right and top-down). The settled "newest at the top" rule is about the graph's trunk, which phase 10 owns and this phase does not touch.
**Code:**
```ts
import { chatTime } from './chatTime';

/** One session in the panel's subtree views. `parent` is the parent's NODE id (not session id). */
export interface SubtreeNode {
  node_id: string;
  parent: string | null;
  label: string;
  started_at: string | null;
  last_active_at: string | null;
  live: boolean;
  available: boolean;
  host: string | null;
}

export interface SubtreeRow extends SubtreeNode {
  /** 0 for the selected node, 1 for its children, and so on. */
  depth: number;
}

/**
 * The fields the panel reads from a phase 10 graph node. Every field but `node_id` is optional so
 * phase 10's node type is assignable whatever else it carries. The parent may come as a node id or
 * as a session id; both are resolved.
 */
export interface GraphLikeNode {
  node_id: string;
  session_id?: string | null;
  parent_node_id?: string | null;
  parent_session_id?: string | null;
  name?: string | null;
  custom_title?: string | null;
  ai_title?: string | null;
  started_at?: string | null;
  last_active_at?: string | null;
  live?: boolean | null;
  available?: boolean | null;
  host?: string | null;
}

export function toSubtreeNodes(nodes: readonly GraphLikeNode[]): SubtreeNode[] {
  const bySession = new Map<string, string>();
  for (const n of nodes) if (n.session_id) bySession.set(n.session_id, n.node_id);
  return nodes.map((n) => ({
    node_id: n.node_id,
    parent: n.parent_node_id ?? (n.parent_session_id ? bySession.get(n.parent_session_id) ?? null : null),
    label: n.name ?? n.custom_title ?? n.ai_title ?? '',
    started_at: n.started_at ?? null,
    last_active_at: n.last_active_at ?? null,
    live: n.live === true,
    available: n.available !== false,
    host: n.host ?? null,
  }));
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function byStart(a: SubtreeNode, b: SubtreeNode): number {
  const ta = ms(a.started_at);
  const tb = ms(b.started_at);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }
  return a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0;
}

/**
 * `rootId` and everything below it, depth-first, children oldest first (undated last). Empty when
 * `rootId` is not among `nodes`. A parent cycle (bad data) cannot loop: each node is listed once.
 */
export function subtreeRows(nodes: readonly SubtreeNode[], rootId: string): SubtreeRow[] {
  const root = nodes.find((n) => n.node_id === rootId);
  if (!root) return [];
  const kids = new Map<string, SubtreeNode[]>();
  for (const n of nodes) {
    if (n.parent === null || n.parent === n.node_id) continue;
    const list = kids.get(n.parent);
    if (list) list.push(n);
    else kids.set(n.parent, [n]);
  }
  for (const list of kids.values()) list.sort(byStart);
  const out: SubtreeRow[] = [];
  const seen = new Set<string>();
  const walk = (n: SubtreeNode, depth: number): void => {
    if (seen.has(n.node_id)) return;
    seen.add(n.node_id);
    out.push({ ...n, depth });
    for (const c of kids.get(n.node_id) ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Gantt geometry in SVG user units; the SVG scales to the panel's width. */
export const GANTT = {
  /** Left column for the node ids. */
  labelW: 132,
  /** Time axis width. */
  plotW: 368,
  rowH: 22,
  barH: 10,
  /** Tick labels under the rows. */
  axisH: 22,
  /** A zero-length session still shows. */
  minBar: 3,
  /** Label indent per depth level. */
  indent: 8,
  /** The axis never spans less than a minute. */
  minSpanMs: 60_000,
} as const;

export interface GanttBar {
  node_id: string;
  depth: number;
  x: number;
  y: number;
  width: number;
  live: boolean;
  available: boolean;
  /** Tooltip: id, label, start to end. */
  tip: string;
}

export interface GanttTick {
  x: number;
  label: string;
  anchor: 'start' | 'middle' | 'end';
}

export interface GanttLayout {
  width: number;
  height: number;
  bars: GanttBar[];
  ticks: GanttTick[];
  /** Rows with neither start nor last-active time; left off the chart. */
  undated: number;
}

/**
 * One bar per dated row, in row order, from `started_at` (or `last_active_at`) to `last_active_at`;
 * a live session runs to `now`. The axis spans the earliest start to the latest end; three ticks
 * (start, middle, end) labelled in Jakarta time like chat bubbles, repeated labels dropped.
 */
export function timelineLayout(rows: readonly SubtreeRow[], now: Date): GanttLayout {
  const nowMs = now.getTime();
  const width = GANTT.labelW + GANTT.plotW;
  const spans: Array<{ row: SubtreeRow; start: number; end: number }> = [];
  let undated = 0;
  for (const row of rows) {
    const start = ms(row.started_at) ?? ms(row.last_active_at);
    if (start === null) {
      undated++;
      continue;
    }
    const last = ms(row.last_active_at) ?? start;
    const end = Math.max(start, row.live ? Math.max(last, nowMs) : last);
    spans.push({ row, start, end });
  }
  if (spans.length === 0) return { width, height: GANTT.axisH, bars: [], ticks: [], undated };

  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of spans) {
    if (s.start < t0) t0 = s.start;
    if (s.end > t1) t1 = s.end;
  }
  const span = Math.max(t1 - t0, GANTT.minSpanMs);
  const right = GANTT.labelW + GANTT.plotW;
  const xOf = (t: number): number => GANTT.labelW + ((t - t0) / span) * GANTT.plotW;
  const when = (t: number): string => chatTime(new Date(t).toISOString(), now);

  const bars: GanttBar[] = spans.map((s, i) => {
    const w = Math.max(GANTT.minBar, xOf(s.end) - xOf(s.start));
    const x = Math.min(xOf(s.start), right - w);
    const label = s.row.label ? ` ${s.row.label}` : '';
    return {
      node_id: s.row.node_id,
      depth: s.row.depth,
      x,
      y: i * GANTT.rowH,
      width: w,
      live: s.row.live,
      available: s.row.available,
      tip: `${s.row.node_id}${label} · ${when(s.start)} to ${s.row.live ? 'now' : when(s.end)}`,
    };
  });

  const ticks: GanttTick[] = [];
  const candidates: Array<[number, GanttTick['anchor']]> = [
    [t0, 'start'],
    [t0 + span / 2, 'middle'],
    [t0 + span, 'end'],
  ];
  for (const [t, anchor] of candidates) {
    const label = when(t);
    if (ticks.length > 0 && ticks[ticks.length - 1]?.label === label) continue;
    ticks.push({ x: xOf(t), label, anchor });
  }

  return { width, height: spans.length * GANTT.rowH + GANTT.axisH, bars, ticks, undated };
}
```
**Impact:** new module.

**File:** `web/src/lib/subtree.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GANTT, subtreeRows, timelineLayout, toSubtreeNodes, type SubtreeNode, type SubtreeRow } from './subtree';

const node = (node_id: string, parent: string | null, over: Partial<SubtreeNode> = {}): SubtreeNode => ({
  node_id,
  parent,
  label: `s-${node_id}`,
  started_at: null,
  last_active_at: null,
  live: false,
  available: true,
  host: 'lenovo',
  ...over,
});

const row = (n: SubtreeNode, depth = 0): SubtreeRow => ({ ...n, depth });

describe('toSubtreeNodes', () => {
  it('resolves the parent from parent_node_id first, then through parent_session_id', () => {
    const out = toSubtreeNodes([
      { node_id: 'A0-00', session_id: 's-a', name: 'trunk' },
      { node_id: 'B1-11', session_id: 's-b', parent_session_id: 's-a', ai_title: 'by session' },
      { node_id: 'C2-22', parent_node_id: 'B1-11', parent_session_id: 's-a', custom_title: 'by node' },
      { node_id: 'D3-33', parent_session_id: 'gone', available: false, live: true, host: 'GPD' },
    ]);
    expect(out.map((n) => [n.node_id, n.parent, n.label])).toEqual([
      ['A0-00', null, 'trunk'],
      ['B1-11', 'A0-00', 'by session'],
      ['C2-22', 'B1-11', 'by node'],
      ['D3-33', null, ''],
    ]);
    expect(out[3]).toMatchObject({ available: false, live: true, host: 'GPD' });
    expect(out[0]).toMatchObject({ available: true, live: false, started_at: null });
  });
});

describe('subtreeRows', () => {
  const nodes = [
    node('T0-00', null),
    node('A0-3G', 'T0-00', { started_at: '2026-11-01T01:00:00Z' }),
    node('C2-22', 'A0-3G', { started_at: '2026-11-01T03:00:00Z' }),
    node('B1-11', 'A0-3G', { started_at: '2026-11-01T02:00:00Z' }),
    node('U9-99', 'A0-3G'),
    node('D3-33', 'B1-11', { started_at: '2026-11-01T02:30:00Z' }),
    node('E4-44', 'T0-00', { started_at: '2026-11-01T00:30:00Z' }),
  ];

  it('lists the root and its descendants depth-first, children oldest first, undated last', () => {
    expect(subtreeRows(nodes, 'A0-3G').map((r) => `${r.depth}:${r.node_id}`)).toEqual(['0:A0-3G', '1:B1-11', '2:D3-33', '1:C2-22', '1:U9-99']);
  });

  it('is empty for a root that is not in the graph', () => {
    expect(subtreeRows(nodes, 'ZZ-ZZ')).toEqual([]);
  });

  it('lists each node once when parents form a cycle', () => {
    const cyc = [node('A0-00', 'B1-11'), node('B1-11', 'A0-00'), node('S0-00', 'S0-00')];
    expect(subtreeRows(cyc, 'A0-00').map((r) => r.node_id)).toEqual(['A0-00', 'B1-11']);
    expect(subtreeRows(cyc, 'S0-00').map((r) => r.node_id)).toEqual(['S0-00']);
  });
});

describe('timelineLayout', () => {
  const NOW = new Date('2026-11-01T04:00:00Z');

  it('places bars on a shared axis; a live session runs to now', () => {
    const rows = [
      row(node('A0-3G', null, { started_at: '2026-11-01T01:00:00Z', last_active_at: '2026-11-01T03:00:00Z' })),
      row(node('B1-11', 'A0-3G', { started_at: '2026-11-01T02:00:00Z', last_active_at: '2026-11-01T02:30:00Z' }), 1),
      row(node('C2-22', 'A0-3G', { started_at: '2026-11-01T02:45:00Z', last_active_at: '2026-11-01T02:50:00Z', live: true }), 1),
      row(node('U9-99', 'A0-3G'), 1),
    ];
    const l = timelineLayout(rows, NOW);
    expect(l.width).toBe(GANTT.labelW + GANTT.plotW);
    expect(l.height).toBe(3 * GANTT.rowH + GANTT.axisH);
    expect(l.undated).toBe(1);
    const [a, b, c] = l.bars;
    expect(a).toMatchObject({ node_id: 'A0-3G', depth: 0, y: 0 });
    expect(a?.x).toBeCloseTo(GANTT.labelW);
    expect(a?.width).toBeCloseTo((2 / 3) * GANTT.plotW);
    expect(b?.x).toBeCloseTo(GANTT.labelW + GANTT.plotW / 3);
    expect(b?.width).toBeCloseTo(GANTT.plotW / 6);
    expect(b?.y).toBe(GANTT.rowH);
    expect(c?.x).toBeCloseTo(GANTT.labelW + (1.75 / 3) * GANTT.plotW);
    expect(c?.width).toBeCloseTo((1.25 / 3) * GANTT.plotW);
    expect(c?.tip.endsWith('to now')).toBe(true);
    expect(l.ticks.map((t) => t.anchor)).toEqual(['start', 'middle', 'end']);
    expect(l.ticks[0]?.x).toBeCloseTo(GANTT.labelW);
    expect(l.ticks[2]?.x).toBeCloseTo(GANTT.labelW + GANTT.plotW);
    // 01:00 UTC is 08:00 in Jakarta, same day as NOW.
    expect(l.ticks[0]?.label).toBe('08:00');
  });

  it('keeps a zero-length bar visible and inside the plot', () => {
    const rows = [
      row(node('A0-00', null, { started_at: '2026-11-01T01:00:00Z', last_active_at: '2026-11-01T02:00:00Z' })),
      row(node('B1-11', 'A0-00', { started_at: '2026-11-01T02:00:00Z', last_active_at: '2026-11-01T02:00:00Z' }), 1),
    ];
    const b = timelineLayout(rows, NOW).bars[1];
    expect(b?.width).toBe(GANTT.minBar);
    expect((b?.x ?? 0) + (b?.width ?? 0)).toBeCloseTo(GANTT.labelW + GANTT.plotW);
  });

  it('drops repeated tick labels on a sub-minute span and handles no dated rows', () => {
    const one = [row(node('A0-00', null, { started_at: '2026-11-01T01:00:00Z', last_active_at: '2026-11-01T01:00:10Z' }))];
    const l = timelineLayout(one, NOW);
    expect(l.bars).toHaveLength(1);
    expect(new Set(l.ticks.map((t) => t.label)).size).toBe(l.ticks.length);
    expect(timelineLayout([row(node('U0-00', null))], NOW)).toEqual({ width: GANTT.labelW + GANTT.plotW, height: GANTT.axisH, bars: [], ticks: [], undated: 1 });
  });
});
```

### Step 3: Token and cost formatters
**File:** `web/src/lib/sessionFormat.ts` (new)
**Code:**
```ts
function short(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
}

/** 950 -> "950", 12345 -> "12.3k", 1500000 -> "1.5M". Zero, negative or not finite -> "0". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${short(n / 1000)}k`;
  if (n < 1_000_000_000) return `${short(n / 1_000_000)}M`;
  return `${short(n / 1_000_000_000)}B`;
}

/** "$1.23"; "<$0.01" for a cost too small to show; null when no cost is recorded. */
export function formatCost(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
```

**File:** `web/src/lib/sessionFormat.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatCost, formatCount } from './sessionFormat';

describe('formatCount', () => {
  it('shortens token counts', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(-5)).toBe('0');
    expect(formatCount(Number.NaN)).toBe('0');
    expect(formatCount(950)).toBe('950');
    expect(formatCount(2000)).toBe('2k');
    expect(formatCount(12_345)).toBe('12.3k');
    expect(formatCount(250_000)).toBe('250k');
    expect(formatCount(1_500_000)).toBe('1.5M');
    expect(formatCount(3_200_000_000)).toBe('3.2B');
  });
});

describe('formatCost', () => {
  it('prints dollars with cents', () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});
```

### Step 4: The detail and resume client
**File:** `web/src/sessionDetailApi.ts` (new)
**Change:** Kept out of phase 10's `web/src/sessionsApi.ts` so the two phases never edit the same file; the reconciler may fold it in later. The normaliser is deliberately tolerant (see Requires) because phase 7's exact wire shape is decided in parallel.
**Code:**
```ts
import { ApiError } from './api';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

export type ParentLinkSource = 'env' | 'hook' | 'heuristic';

export interface SessionCommit {
  sha: string;
  subject: string;
}

/** A note this session saved (its `origin.claude_session` is this session). */
export interface SessionNoteRef {
  id: string;
  /** First non-empty line of the body, clipped; '' when the server sent only the id. */
  preview: string;
}

export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** Phase 7's `GET /api/sessions/:nodeId`, normalised. */
export interface SessionDetail {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  /** False: the transcript lives on another machine (resume there, not here). */
  available: boolean;
  live: boolean;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  /** `custom_title`, else `ai_title`. */
  title: string | null;
  started_at: string | null;
  last_active_at: string | null;
  summary: string | null;
  prompts: string[];
  commits: SessionCommit[];
  notes: SessionNoteRef[];
  tokens: SessionTokens;
  cost_usd: number | null;
  parent: { node_id: string; name: string | null } | null;
  parent_link_source: ParentLinkSource | null;
  transcript_path: string | null;
}

export interface ResumeOptions {
  /** Start a new session seeded with this node's context instead of `claude --resume`. */
  fresh?: boolean;
  prompt?: string;
}

/** Phase 9's answer: what the daemon did (`resumed`, `spawned`, `focused`, `messaged`) and the tmux window. */
export interface ResumeResult {
  action: string;
  window: string | null;
}

type Wire = Record<string, unknown>;

const PREVIEW_MAX = 120;

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

function isObj(v: unknown): v is Wire {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const num = (v: unknown): number => numOrNull(v) ?? 0;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function compact<T>(xs: Array<T | null>): T[] {
  return xs.filter((x): x is T => x !== null);
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
}

function prompt(v: unknown): string | null {
  if (typeof v === 'string') return str(v);
  if (isObj(v)) return str(v.text) ?? str(v.prompt);
  return null;
}

function commit(v: unknown): SessionCommit | null {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const sp = t.indexOf(' ');
    return sp < 0 ? { sha: t, subject: '' } : { sha: t.slice(0, sp), subject: t.slice(sp + 1).trim() };
  }
  if (isObj(v)) {
    const sha = str(v.sha) ?? str(v.hash);
    if (sha === null) return null;
    return { sha, subject: str(v.subject) ?? str(v.message) ?? '' };
  }
  return null;
}

function noteRef(v: unknown): SessionNoteRef | null {
  if (typeof v === 'string') return str(v) === null ? null : { id: v.trim(), preview: '' };
  if (isObj(v)) {
    const id = str(v.id);
    if (id === null) return null;
    return { id, preview: firstLine(str(v.excerpt) ?? str(v.preview) ?? str(v.body) ?? '') };
  }
  return null;
}

/**
 * Phase 7's `SessionDetail` wire into `SessionDetail`. Phase 7 sends
 * `{session: GraphNode & {summary, transcript_path, ...}, prompts, commits, files_edited, plan_docs, notes, parent, children}`:
 * the session's own fields sit under `session`, the lists and `parent` (a NodeRef: node_id, title, ...)
 * at the top level. A bare object (everything at the top level) is also read, for tests.
 */
export function normalizeSessionDetail(raw: Wire): SessionDetail {
  const w = isObj(raw.session) ? raw.session : raw;
  const t = isObj(w.tokens) ? w.tokens : null;
  const parentObj = isObj(raw.parent) ? raw.parent : isObj(w.parent) ? w.parent : null;
  const parentId = str(parentObj?.node_id) ?? str(w.parent_node_id);
  const src = w.parent_link_source;
  return {
    session_id: str(w.session_id) ?? '',
    node_id: str(w.node_id) ?? '',
    repo: str(w.repo),
    host: str(w.host) ?? '',
    available: w.available !== false,
    live: w.live === true,
    cwd: str(w.cwd),
    branch: str(w.branch),
    name: str(w.name),
    title: str(w.custom_title) ?? str(w.ai_title) ?? str(w.title),
    started_at: str(w.started_at),
    last_active_at: str(w.last_active_at),
    summary: str(w.summary),
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
    parent: parentId === null ? null : { node_id: parentId, name: str(parentObj?.title) ?? str(parentObj?.name) },
    parent_link_source: src === 'env' || src === 'hook' || src === 'heuristic' ? src : null,
    transcript_path: str(w.transcript_path),
  };
}

/** `GET /api/sessions/:nodeId` -> the session, or null on 404. The server normalises the id. */
export async function fetchSessionDetail(nodeId: string, signal?: AbortSignal): Promise<SessionDetail | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  if (!isObj(j)) throw new ApiError(500, 'bad session detail');
  return normalizeSessionDetail(j);
}

/** Phase 9: `POST /api/sessions/:nodeId/resume` `{fresh?, prompt?}` -> `{action, window?}`. Throws `ApiError` (`not_on_this_machine`, 403 from the same-origin guard, ...). */
export async function resumeSession(nodeId: string, opts: ResumeOptions = {}): Promise<ResumeResult> {
  const body: { fresh?: boolean; prompt?: string } = {};
  if (opts.fresh) body.fresh = true;
  const p = opts.prompt?.trim();
  if (p) body.prompt = p;
  const res = await fetch(`/api/sessions/${enc(nodeId)}/resume`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  const o = isObj(j) ? j : {};
  return { action: str(o.action) ?? 'unknown', window: str(o.window) };
}

/** The panel's one-line report of a successful resume / spawn. */
export function resumeNotice(r: ResumeResult, fresh: boolean): string {
  const where = r.window ? ` in ${r.window}` : '';
  switch (r.action) {
    case 'resumed':
      return `Resumed${where}`;
    case 'spawned':
    case 'fresh':
      return `Fresh session started${where}`;
    case 'focused':
      return `Already running, focused${where}`;
    case 'messaged':
      return `Already running, prompt sent${where}`;
    default:
      return `${fresh ? 'Fresh session' : 'Resume'}: ${r.action}${where}`;
  }
}

/** The panel's one-line report of a failed resume / spawn. */
export function resumeErrorNotice(err: unknown, d: Pick<SessionDetail, 'node_id' | 'host'>): string {
  if (err instanceof ApiError) {
    if (err.message === 'not_on_this_machine') return `${d.node_id} is not on this machine${d.host ? ` (it ran on ${d.host})` : ''}`;
    if (err.status === 403) return 'Resume only works from the wall on this machine';
    return `Could not resume ${d.node_id}: ${err.message}`;
  }
  return `Could not resume ${d.node_id}`;
}
```

**File:** `web/src/sessionDetailApi.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { fetchSessionDetail, normalizeSessionDetail, resumeErrorNotice, resumeNotice, resumeSession } from './sessionDetailApi';

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function stub(status: number, body: unknown): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('normalizeSessionDetail', () => {
  it('reads phase 7 detail: session fields under `session`, lists and parent NodeRef at the top', () => {
    const d = normalizeSessionDetail({
      session: {
        session_id: 'cc64',
        node_id: 'A0-3G',
        repo: 'mcp-notes',
        host: 'lenovo',
        available: true,
        live: false,
        title: 'Wall editing',
        ai_title: 'Wall editing',
        tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4, total: 10 },
        cost_usd: 0.25,
        summary: 'Did the thing.',
        parent_node_id: 'B1-11',
        parent_link_source: 'env',
      },
      prompts: [{ text: 'first', at: null }],
      commits: [{ sha: 'abcdef1', subject: 'feat: x' }],
      files_edited: [],
      plan_docs: [],
      notes: [{ id: 'K-F07', excerpt: 'saved note', tags: [], created_at: null }],
      parent: { session_id: 'p', node_id: 'B1-11', repo: 'mcp-notes', title: 'orch-x', started_at: null, last_active_at: null, host: 'lenovo', available: true, live: false, status: null, parent_link_source: null },
      children: [],
    });
    expect(d.prompts).toEqual(['first']);
    expect(d.commits).toEqual([{ sha: 'abcdef1', subject: 'feat: x' }]);
    expect(d.notes).toEqual([{ id: 'K-F07', preview: 'saved note' }]);
    expect(d.parent).toEqual({ node_id: 'B1-11', name: 'orch-x' });
    expect(d.tokens).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
    expect(d.summary).toBe('Did the thing.');
  });

  it('reads flat token columns, a numeric-string cost, string commits and string note ids', () => {
    const d = normalizeSessionDetail({
      session_id: 'cc64',
      node_id: 'A0-3G',
      host: 'lenovo',
      available: true,
      live: true,
      ai_title: 'Wall editing',
      prompts: ['first', { text: 'second' }, '  ', 7],
      commits: ['abcdef1 feat: x', { hash: '1234567', message: 'fix: y' }, { subject: 'no sha' }],
      notes: ['K-F07', { id: 'Z-Z01', excerpt: '\n  first line  \nsecond' }],
      input_tokens: 10,
      output_tokens: '20',
      cache_read_tokens: 30,
      cache_write_tokens: null,
      cost_usd: '1.5',
      parent_node_id: 'B1-11',
      parent_link_source: 'heuristic',
    });
    expect(d.title).toBe('Wall editing');
    expect(d.prompts).toEqual(['first', 'second']);
    expect(d.commits).toEqual([
      { sha: 'abcdef1', subject: 'feat: x' },
      { sha: '1234567', subject: 'fix: y' },
    ]);
    expect(d.notes).toEqual([
      { id: 'K-F07', preview: '' },
      { id: 'Z-Z01', preview: 'first line' },
    ]);
    expect(d.tokens).toEqual({ input: 10, output: 20, cache_read: 30, cache_write: 0 });
    expect(d.cost_usd).toBe(1.5);
    expect(d.parent).toEqual({ node_id: 'B1-11', name: null });
    expect(d.parent_link_source).toBe('heuristic');
    expect(d.live).toBe(true);
    expect(d.repo).toBeNull();
  });

  it('reads a tokens object, a parent object, a {session} wrapper and defaults the rest', () => {
    const d = normalizeSessionDetail({
      session: {
        node_id: 'A0-3G',
        custom_title: 'mine',
        ai_title: 'theirs',
        tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
        parent: { node_id: 'B1-11', name: 'trunk' },
        parent_link_source: 'bogus',
        available: false,
      },
    });
    expect(d.title).toBe('mine');
    expect(d.tokens).toEqual({ input: 1, output: 2, cache_read: 3, cache_write: 4 });
    expect(d.parent).toEqual({ node_id: 'B1-11', name: 'trunk' });
    expect(d.parent_link_source).toBeNull();
    expect(d.available).toBe(false);
    expect(d.cost_usd).toBeNull();
    expect(d.prompts).toEqual([]);
    expect(d.notes).toEqual([]);
  });
});

describe('fetchSessionDetail', () => {
  it('GETs the node and normalises it', async () => {
    const seen = stub(200, { node_id: 'A0-3G', host: 'lenovo' });
    const d = await fetchSessionDetail('a03g');
    expect(d?.node_id).toBe('A0-3G');
    expect(seen[0]).toEqual({ url: '/api/sessions/a03g', method: 'GET', body: null });
  });

  it('is null on 404 and throws ApiError otherwise', async () => {
    stub(404, { error: 'not_found' });
    expect(await fetchSessionDetail('ZZ-ZZ')).toBeNull();
    stub(500, { error: 'boom' });
    await expect(fetchSessionDetail('A0-3G')).rejects.toMatchObject({ status: 500, message: 'boom' });
  });
});

describe('resumeSession', () => {
  it('POSTs {} to resume, {fresh:true} to spawn fresh, and a trimmed prompt', async () => {
    const seen = stub(200, { action: 'resumed', window: 'note:4' });
    expect(await resumeSession('A0-3G')).toEqual({ action: 'resumed', window: 'note:4' });
    await resumeSession('A0-3G', { fresh: true });
    await resumeSession('A0-3G', { prompt: '  go on  ' });
    expect(seen).toEqual([
      { url: '/api/sessions/A0-3G/resume', method: 'POST', body: {} },
      { url: '/api/sessions/A0-3G/resume', method: 'POST', body: { fresh: true } },
      { url: '/api/sessions/A0-3G/resume', method: 'POST', body: { prompt: 'go on' } },
    ]);
  });

  it('throws the error code as an ApiError', async () => {
    stub(404, { error: 'not_on_this_machine' });
    const err = await resumeSession('A0-3G').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe('not_on_this_machine');
  });
});

describe('notices', () => {
  it('says what the daemon did', () => {
    expect(resumeNotice({ action: 'resumed', window: 'note:4' }, false)).toBe('Resumed in note:4');
    expect(resumeNotice({ action: 'spawned', window: null }, true)).toBe('Fresh session started');
    expect(resumeNotice({ action: 'focused', window: 'note:2' }, false)).toBe('Already running, focused in note:2');
    expect(resumeNotice({ action: 'messaged', window: null }, false)).toBe('Already running, prompt sent');
    expect(resumeNotice({ action: 'queued', window: null }, true)).toBe('Fresh session: queued');
  });

  it('explains failures', () => {
    const d = { node_id: 'A0-3G', host: 'GPD' };
    expect(resumeErrorNotice(new ApiError(404, 'not_on_this_machine'), d)).toBe('A0-3G is not on this machine (it ran on GPD)');
    expect(resumeErrorNotice(new ApiError(404, 'not_on_this_machine'), { node_id: 'A0-3G', host: '' })).toBe('A0-3G is not on this machine');
    expect(resumeErrorNotice(new ApiError(403, 'forbidden'), d)).toBe('Resume only works from the wall on this machine');
    expect(resumeErrorNotice(new ApiError(500, 'tmux_failed'), d)).toBe('Could not resume A0-3G: tmux_failed');
    expect(resumeErrorNotice(new Error('x'), d)).toBe('Could not resume A0-3G');
  });
});
```

### Step 5: Tree view
**File:** `web/src/components/graph/SubtreeTree.tsx` (new)
**Code:**
```tsx
import type { SubtreeRow } from '../../lib/subtree';

export interface SubtreeTreeProps {
  rows: readonly SubtreeRow[];
  /** The panel's node (highlighted). */
  current: string;
  onSelect: (nodeId: string) => void;
}

/** The subtree as an indented list; a row opens that node (`?node=`). */
export function SubtreeTree({ rows, current, onSelect }: SubtreeTreeProps) {
  return (
    <ul className="np-tree">
      {rows.map((r) => {
        const cur = r.node_id === current;
        const cls = ['np-tree-row', cur ? 'cur' : '', r.live ? 'live' : '', r.available ? '' : 'away'].filter(Boolean).join(' ');
        return (
          <li key={r.node_id}>
            <button
              type="button"
              className={cls}
              style={{ paddingLeft: 6 + r.depth * 14 }}
              aria-label={`Open ${r.node_id}`}
              aria-current={cur ? 'true' : undefined}
              onClick={() => onSelect(r.node_id)}
            >
              <span className="np-dot" aria-hidden="true" />
              <span className="np-tree-id">{r.node_id}</span>
              <span className="np-tree-label">{r.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

### Step 6: Timeline (Gantt) view, plain SVG
**File:** `web/src/components/graph/SubtreeTimeline.tsx` (new)
**Change:** One `<svg>` with a `viewBox`, scaled to the panel width. Label column on the left, bars on the time axis, three ticks underneath. Rows are focusable (`role="button"`, Enter/Space) and carry `data-tip` for the existing `Tooltip`. No library (invariant 10).
**Code:**
```tsx
import { useMemo, type KeyboardEvent } from 'react';
import { GANTT, timelineLayout, type SubtreeRow } from '../../lib/subtree';

export interface SubtreeTimelineProps {
  rows: readonly SubtreeRow[];
  current: string;
  now: Date;
  onSelect: (nodeId: string) => void;
}

/** The subtree as Gantt bars on one time axis (custom SVG). */
export function SubtreeTimeline({ rows, current, now, onSelect }: SubtreeTimelineProps) {
  const layout = useMemo(() => timelineLayout(rows, now), [rows, now]);
  if (layout.bars.length === 0) return <p className="np-dim">No times recorded for this subtree</p>;
  const plotBottom = layout.height - GANTT.axisH;
  const onKey = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onSelect(id);
  };
  return (
    <figure className="np-gantt">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} width="100%" role="group" aria-label="Subtree timeline">
        {layout.ticks.map((t) => (
          <g key={t.anchor}>
            <line className="np-gantt-grid" x1={t.x} x2={t.x} y1={0} y2={plotBottom} />
            <text className="np-gantt-tick" x={t.x} y={layout.height - 7} textAnchor={t.anchor}>
              {t.label}
            </text>
          </g>
        ))}
        {layout.bars.map((b) => {
          const cls = ['np-gantt-row', b.node_id === current ? 'cur' : '', b.live ? 'live' : '', b.available ? '' : 'away'].filter(Boolean).join(' ');
          return (
            <g
              key={b.node_id}
              className={cls}
              data-bar={b.node_id}
              data-tip={b.tip}
              role="button"
              tabIndex={0}
              aria-label={`Open ${b.node_id}`}
              onClick={() => onSelect(b.node_id)}
              onKeyDown={onKey(b.node_id)}
            >
              <rect className="np-gantt-hit" x={0} y={b.y} width={layout.width} height={GANTT.rowH} />
              <text className="np-gantt-label" x={4 + b.depth * GANTT.indent} y={b.y + GANTT.rowH / 2 + 4}>
                {b.node_id}
              </text>
              <rect className="np-gantt-bar" x={b.x} y={b.y + (GANTT.rowH - GANTT.barH) / 2} width={b.width} height={GANTT.barH} rx={2} />
            </g>
          );
        })}
      </svg>
      {layout.undated > 0 && <figcaption className="np-dim">{layout.undated} without times</figcaption>}
    </figure>
  );
}
```

### Step 7: The panel
**File:** `web/src/components/graph/NodePanel.tsx` (new)
**Change:** Fetches the detail for `nodeId`, quietly re-fetches when the graph reports new activity for that node (its `last_active_at` changes after phase 10's 10 s ETag poll), and keeps the old detail on screen while it does. Resume and fresh spawn run at once; only `available === false` goes through `ConfirmDialog` (portaled to `<body>` like `App.tsx:794`). A reply that arrives after the user has moved to another node is dropped.
**Code:**
```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChartBarHorizontal, Check, CloudSlash, Copy, Play, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
import { ConfirmDialog } from '../ConfirmDialog';
import { useCopied } from '../../hooks/useCopied';
import { useNow } from '../../hooks/useNow';
import { chatTime, chatTimeTitle } from '../../lib/chatTime';
import { hostsLabel } from '../../lib/remote';
import { formatCost, formatCount } from '../../lib/sessionFormat';
import { subtreeRows, type SubtreeNode, type SubtreeRow } from '../../lib/subtree';
import { fetchSessionDetail, resumeErrorNotice, resumeNotice, resumeSession, type SessionDetail } from '../../sessionDetailApi';
import { SubtreeTimeline } from './SubtreeTimeline';
import { SubtreeTree } from './SubtreeTree';
import './NodePanel.css';

export type SubtreeView = 'tree' | 'timeline';

/** Prompts listed before "+N more". */
const PROMPTS_SHOWN = 20;

export interface NodePanelProps {
  /** The selected node from `?node=` (any case, dash optional; the server normalises). */
  nodeId: string;
  /** The project graph's nodes (phase 10's payload through `toSubtreeNodes`), for the subtree views and refresh. */
  nodes: readonly SubtreeNode[];
  /** Select another node (pushes `?node=`). */
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  /** Tests pin the clock; the page uses a minute tick. */
  now?: Date;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; detail: SessionDetail }
  | { state: 'missing' }
  | { state: 'error'; message: string };

/** Case- and dash-insensitive id key: `a03g`, `A0-3G` are the same node. */
const idKey = (id: string): string => id.toUpperCase().replace(/-/g, '');

function placeLabel(host: string): string {
  return hostsLabel(host ? [host] : []);
}

export function NodePanel({ nodeId, nodes, onSelectNode, onClose, now: nowProp }: NodePanelProps) {
  const clock = useNow();
  const now = nowProp ?? clock;
  const { copied, copy } = useCopied();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [view, setView] = useState<SubtreeView>('tree');
  const [busy, setBusy] = useState<'resume' | 'fresh' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ fresh: boolean } | null>(null);
  const currentKey = useRef(idKey(nodeId));
  currentKey.current = idKey(nodeId);

  const stamp = useMemo(() => {
    const k = idKey(nodeId);
    return nodes.find((n) => idKey(n.node_id) === k)?.last_active_at ?? '';
  }, [nodes, nodeId]);

  useEffect(() => {
    const ac = new AbortController();
    setLoad((prev) => (prev.state === 'ready' && idKey(prev.detail.node_id) === idKey(nodeId) ? prev : { state: 'loading' }));
    fetchSessionDetail(nodeId, ac.signal).then(
      (d) => {
        if (!ac.signal.aborted) setLoad(d ? { state: 'ready', detail: d } : { state: 'missing' });
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => ac.abort();
  }, [nodeId, stamp]);

  useEffect(() => {
    setNotice(null);
    setConfirm(null);
  }, [nodeId]);

  const detail = load.state === 'ready' ? load.detail : null;
  const shownId = detail?.node_id ?? nodeId.toUpperCase();

  const rows = useMemo<SubtreeRow[]>(() => {
    const found = subtreeRows(nodes, shownId);
    if (found.length > 0 || !detail) return found;
    return [
      {
        node_id: detail.node_id,
        parent: detail.parent?.node_id ?? null,
        label: detail.name ?? detail.title ?? '',
        started_at: detail.started_at,
        last_active_at: detail.last_active_at,
        live: detail.live,
        available: detail.available,
        host: detail.host || null,
        depth: 0,
      },
    ];
  }, [nodes, shownId, detail]);

  const run = async (d: SessionDetail, fresh: boolean): Promise<void> => {
    setBusy(fresh ? 'fresh' : 'resume');
    setNotice(null);
    let text: string;
    try {
      text = resumeNotice(await resumeSession(d.node_id, { fresh }), fresh);
    } catch (e) {
      text = resumeErrorNotice(e, d);
    }
    setBusy(null);
    if (currentKey.current === idKey(d.node_id)) setNotice(text);
  };

  // No confirm click (settled), except a node whose transcript is on the other machine.
  const ask = (fresh: boolean): void => {
    if (!detail || busy !== null) return;
    if (detail.available) void run(detail, fresh);
    else setConfirm({ fresh });
  };

  const resumeTip = detail?.live ? 'Focus the running session' : 'Resume in tmux';

  return (
    <aside className="np" aria-label={`Session ${shownId}`} data-node={shownId}>
      <header className="np-head">
        <button
          type="button"
          className="np-id"
          data-tip={copied === shownId ? 'Copied' : 'Copy node id'}
          data-tip-side="below"
          aria-label="Copy node id"
          onClick={() => copy(shownId)}
        >
          {shownId}
          {copied === shownId ? <Check weight="duotone" /> : <Copy weight="duotone" />}
        </button>
        <div className="np-actions">
          <button
            type="button"
            className="ibtn hov"
            data-tip={resumeTip}
            data-tip-side="below"
            aria-label={resumeTip}
            disabled={!detail || busy !== null}
            onClick={() => ask(false)}
          >
            <Play weight="duotone" />
          </button>
          <button
            type="button"
            className="ibtn hov"
            data-tip="Spawn fresh with this context"
            data-tip-side="below"
            aria-label="Spawn fresh with this context"
            disabled={!detail || busy !== null}
            onClick={() => ask(true)}
          >
            <Sparkle weight="duotone" />
          </button>
          <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close" onClick={onClose}>
            <X weight="duotone" />
          </button>
        </div>
      </header>

      <p className="np-notice" role="status">
        {busy !== null ? (busy === 'fresh' ? 'Starting a fresh session…' : 'Resuming…') : notice ?? ''}
      </p>

      {load.state === 'loading' && <p className="np-dim">Loading {shownId}</p>}
      {load.state === 'missing' && <p className="np-dim">No session {shownId}</p>}
      {load.state === 'error' && <p className="np-dim">Could not load {shownId}: {load.message}</p>}

      {detail && (
        <>
          <div className="np-meta">
            {detail.live && <span className="np-live">running</span>}
            {detail.available ? (
              detail.host && <span>{detail.host}</span>
            ) : (
              <span className="np-away" data-tip="Its transcript is on the other machine">
                <CloudSlash weight="duotone" /> on {placeLabel(detail.host)}
              </span>
            )}
            {detail.repo && (
              <span>
                {detail.repo}
                {detail.branch ? ` · ${detail.branch}` : ''}
              </span>
            )}
            {detail.started_at && (
              <time dateTime={detail.started_at} title={chatTimeTitle(detail.started_at)}>
                {chatTime(detail.started_at, now)}
              </time>
            )}
            {detail.last_active_at && detail.last_active_at !== detail.started_at && (
              <time dateTime={detail.last_active_at} title={chatTimeTitle(detail.last_active_at)}>
                to {chatTime(detail.last_active_at, now)}
              </time>
            )}
          </div>

          <h2 className="np-title">{detail.name ?? detail.title ?? 'Untitled session'}</h2>
          {detail.name && detail.title && detail.title !== detail.name && <p className="np-sub">{detail.title}</p>}
          {detail.parent && (
            <ParentLine parent={detail.parent} source={detail.parent_link_source} onSelect={onSelectNode} />
          )}

          <section className="np-sec" aria-label="Summary">
            <h3>Summary</h3>
            {detail.summary ? <p className="np-summary">{detail.summary}</p> : <p className="np-dim">No summary yet</p>}
          </section>

          <section className="np-sec" aria-label="Prompts">
            <h3>Prompts</h3>
            {detail.prompts.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ol className="np-prompts">
                {detail.prompts.slice(0, PROMPTS_SHOWN).map((p, i) => (
                  <li key={i}>
                    <span className="np-clamp">{p}</span>
                  </li>
                ))}
              </ol>
            )}
            {detail.prompts.length > PROMPTS_SHOWN && <p className="np-dim">+{detail.prompts.length - PROMPTS_SHOWN} more</p>}
          </section>

          <section className="np-sec" aria-label="Commits">
            <h3>Commits</h3>
            {detail.commits.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ul className="np-commits">
                {detail.commits.map((c) => (
                  <li key={c.sha}>
                    <code title={c.sha}>{c.sha.slice(0, 7)}</code>
                    {c.subject}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="np-sec" aria-label="Notes made">
            <h3>Notes made</h3>
            {detail.notes.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ul className="np-notes">
                {detail.notes.map((n) => (
                  <li key={n.id}>
                    <a href={`/?note=${encodeURIComponent(n.id)}`}>{n.id}</a>
                    {n.preview && <span>{n.preview}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="np-sec" aria-label="Tokens">
            <h3>Tokens</h3>
            <dl className="np-tokens">
              <div>
                <dt>input</dt>
                <dd>{formatCount(detail.tokens.input)}</dd>
              </div>
              <div>
                <dt>output</dt>
                <dd>{formatCount(detail.tokens.output)}</dd>
              </div>
              <div>
                <dt>cache read</dt>
                <dd>{formatCount(detail.tokens.cache_read)}</dd>
              </div>
              <div>
                <dt>cache write</dt>
                <dd>{formatCount(detail.tokens.cache_write)}</dd>
              </div>
              {formatCost(detail.cost_usd) !== null && (
                <div>
                  <dt>cost</dt>
                  <dd>{formatCost(detail.cost_usd)}</dd>
                </div>
              )}
            </dl>
          </section>

          <section className="np-sec" aria-label="Subtree">
            <div className="np-sec-head">
              <h3>Subtree</h3>
              <div className="np-toggle">
                <button
                  type="button"
                  className={`ibtn hov${view === 'tree' ? ' on' : ''}`}
                  data-tip="Tree"
                  aria-label="Tree"
                  aria-pressed={view === 'tree'}
                  onClick={() => setView('tree')}
                >
                  <TreeStructure weight="duotone" />
                </button>
                <button
                  type="button"
                  className={`ibtn hov${view === 'timeline' ? ' on' : ''}`}
                  data-tip="Timeline"
                  aria-label="Timeline"
                  aria-pressed={view === 'timeline'}
                  onClick={() => setView('timeline')}
                >
                  <ChartBarHorizontal weight="duotone" />
                </button>
              </div>
            </div>
            {view === 'tree' ? (
              <SubtreeTree rows={rows} current={shownId} onSelect={onSelectNode} />
            ) : (
              <SubtreeTimeline rows={rows} current={shownId} now={now} onSelect={onSelectNode} />
            )}
          </section>
        </>
      )}

      {confirm &&
        detail &&
        createPortal(
          <ConfirmDialog
            message={`${detail.node_id} ran on ${placeLabel(detail.host)}, and its transcript is not on this machine. ${confirm.fresh ? 'Spawn a fresh session' : 'Resume'} anyway?`}
            confirmLabel="Try anyway"
            confirmIcon={confirm.fresh ? <Sparkle weight="duotone" /> : <Play weight="duotone" />}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const fresh = confirm.fresh;
              setConfirm(null);
              void run(detail, fresh);
            }}
          />,
          document.body,
        )}
    </aside>
  );
}

function ParentLine({
  parent,
  source,
  onSelect,
}: {
  parent: { node_id: string; name: string | null };
  source: SessionDetail['parent_link_source'];
  onSelect: (nodeId: string) => void;
}) {
  return (
    <p className="np-parent">
      from{' '}
      <button type="button" className="np-link" aria-label={`Open parent ${parent.node_id}`} onClick={() => onSelect(parent.node_id)}>
        {parent.node_id}
      </button>
      {parent.name ? ` ${parent.name}` : ''}
      {source === 'heuristic' && <span className="np-src" data-tip="Linked by matching names in the parent's transcript"> (guessed)</span>}
    </p>
  );
}
```
**Impact:** new component; nothing renders it until Step 8.

**File:** `web/src/components/graph/NodePanel.css` (new)
```css
/* Node detail panel (phase 11). The wall's dark mono language: hairlines, Geist Mono meta, no
   shadows, icon-only buttons. Phase 10's slot positions and sizes it; the panel fills the slot
   and scrolls on its own. */
.np { display: flex; flex-direction: column; gap: 18px; height: 100%; overflow: auto; padding: 14px 16px 32px; box-sizing: border-box; background: var(--bg); border-left: 1px solid var(--line); color: var(--text); font-family: var(--sans); }
.np-head { display: flex; align-items: center; gap: 6px; }
.np-id { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line-25); border-radius: 999px; background: transparent; color: var(--fg); font-family: var(--mono); font-size: 13px; letter-spacing: .04em; padding: 5px 10px; cursor: pointer; }
.np-id:hover, .np-id:focus-visible { background: var(--fg); color: var(--bg); }
.np-actions { margin-left: auto; display: flex; gap: 2px; }
.np-actions .ibtn { font-size: 19px; }
.np-actions .ibtn:disabled { opacity: .4; cursor: default; }
.np-actions .ibtn:disabled:hover { background: transparent; }
.np-notice { margin: -10px 0 0; min-height: 14px; font-family: var(--mono); font-size: 11px; color: var(--muted); }

.np-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.np-meta time { cursor: default; }
.np-live { color: var(--fg); }
.np-live::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 999px; background: var(--fg); vertical-align: 1px; animation: np-pulse 1.6s ease-in-out infinite; }
.np-away { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); }

.np-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 1.25; color: var(--fg); overflow-wrap: anywhere; }
.np-sub { margin: -12px 0 0; font-size: 13px; color: var(--muted); }
.np-parent { margin: -8px 0 0; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.np-link { border: 0; padding: 0; background: none; color: var(--fg); font: inherit; text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; cursor: pointer; }
.np-src { color: var(--dim); }

.np-sec { display: flex; flex-direction: column; gap: 8px; }
.np-sec h3 { margin: 0; font-family: var(--mono); font-size: 10.5px; font-weight: 400; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
.np-sec-head { display: flex; align-items: center; justify-content: space-between; }
.np-summary { margin: 0; font-size: 14.5px; line-height: 1.55; white-space: pre-wrap; text-wrap: pretty; overflow-wrap: anywhere; }
.np-dim { margin: 0; font-family: var(--mono); font-size: 11px; color: var(--dim); }

.np-prompts { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; line-height: 1.45; }
.np-prompts li::marker { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.np-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
.np-commits, .np-notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 1.4; }
.np-commits code { font-family: var(--mono); font-size: 11.5px; color: var(--id); margin-right: 8px; }
.np-notes a { font-family: var(--mono); font-size: 11.5px; margin-right: 8px; }
.np-notes span { color: var(--muted); }

.np-tokens { margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
.np-tokens div { display: flex; flex-direction: column; gap: 2px; }
.np-tokens dt { font-family: var(--mono); font-size: 10px; color: var(--dim); }
.np-tokens dd { margin: 0; font-family: var(--mono); font-size: 14px; color: var(--fg); }

.np-toggle { display: flex; gap: 2px; }
.np-toggle .ibtn { width: 32px; height: 32px; font-size: 17px; }

.np-tree { list-style: none; margin: 0; padding: 0; }
.np-tree-row { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; color: var(--text); padding-top: 4px; padding-bottom: 4px; padding-right: 6px; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.np-tree-row:hover, .np-tree-row:focus-visible { background: var(--hover); }
.np-tree-row.cur { background: var(--chip-bg); }
.np-tree-row.away { color: var(--dim); }
.np-dot { flex: none; width: 7px; height: 7px; border-radius: 999px; border: 1px solid var(--line-25); box-sizing: border-box; }
.np-tree-row.live .np-dot { background: var(--fg); border-color: var(--fg); animation: np-pulse 1.6s ease-in-out infinite; }
.np-tree-row.away .np-dot { border-style: dashed; }
.np-tree-id { flex: none; font-family: var(--mono); font-size: 11.5px; color: var(--id); }
.np-tree-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.np-gantt { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.np-gantt svg { display: block; }
.np-gantt-grid { stroke: var(--line-12); stroke-width: 1; }
.np-gantt-tick { fill: var(--dim); font-family: var(--mono); font-size: 9.5px; }
.np-gantt-label { fill: var(--id); font-family: var(--mono); font-size: 10.5px; }
.np-gantt-hit { fill: transparent; }
.np-gantt-bar { fill: var(--muted); }
.np-gantt-row { cursor: pointer; outline: none; }
.np-gantt-row:hover .np-gantt-hit, .np-gantt-row:focus-visible .np-gantt-hit { fill: var(--hover); }
.np-gantt-row.cur .np-gantt-bar { fill: var(--fg); }
.np-gantt-row.live .np-gantt-bar { animation: np-pulse 1.6s ease-in-out infinite; }
.np-gantt-row.away .np-gantt-bar { fill: none; stroke: var(--dim); stroke-dasharray: 3 2; }

@keyframes np-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) {
  .np-live::before, .np-tree-row.live .np-dot, .np-gantt-row.live .np-gantt-bar { animation: none; }
}
```

**File:** `web/src/components/graph/NodePanel.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SubtreeNode } from '../../lib/subtree';
import { NodePanel } from './NodePanel';

// 2026-11-01 11:00 in Jakarta.
const NOW = new Date('2026-11-01T04:00:00Z');

const WIRE = {
  session_id: 'cc6491fc-0000-4000-8000-000000000000',
  node_id: 'A0-3G',
  repo: 'mcp-notes',
  host: 'lenovo',
  available: true,
  live: false,
  cwd: '/home/miftah/mcp-notes',
  branch: 'main',
  name: 'orch-wall-editing',
  custom_title: null,
  ai_title: 'Wall editing orchestration',
  started_at: '2026-11-01T01:00:00.000Z',
  last_active_at: '2026-11-01T03:00:00.000Z',
  summary: 'Orchestrated the wall editing phases.',
  prompts: ['run the swarm', { text: 'merge phase 3' }],
  commits: [{ sha: 'abcdef1234567', subject: 'feat(web): edit in place' }],
  notes: [{ id: 'K-F07', body: 'wall editing notes\nmore' }],
  input_tokens: 12_345,
  output_tokens: 2_000,
  cache_read_tokens: 1_500_000,
  cache_write_tokens: 0,
  cost_usd: '1.234',
  parent: { node_id: 'B1-11', name: 'trunk' },
  parent_link_source: 'heuristic',
  transcript_path: '/home/miftah/.claude/projects/x/cc6491fc.jsonl',
};

const n = (node_id: string, parent: string | null, over: Partial<SubtreeNode> = {}): SubtreeNode => ({
  node_id,
  parent,
  label: `s-${node_id}`,
  started_at: '2026-11-01T01:00:00.000Z',
  last_active_at: '2026-11-01T02:00:00.000Z',
  live: false,
  available: true,
  host: 'lenovo',
  ...over,
});

const NODES: SubtreeNode[] = [
  n('B1-11', null),
  n('A0-3G', 'B1-11', { last_active_at: '2026-11-01T03:00:00.000Z' }),
  n('C2-22', 'A0-3G', { started_at: '2026-11-01T02:00:00.000Z', last_active_at: '2026-11-01T02:30:00.000Z' }),
  n('D3-33', 'C2-22', { started_at: '2026-11-01T02:10:00.000Z', last_active_at: '2026-11-01T02:20:00.000Z' }),
  n('E4-44', 'B1-11'),
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(detail: unknown, resume: { status: number; body: unknown } = { status: 200, body: { action: 'resumed', window: 'note:4' } }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'POST') return json(resume.status, resume.body);
      return detail === null ? json(404, { error: 'not_found' }) : json(200, detail);
    }),
  );
  return calls;
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

function renderPanel(over: Partial<Parameters<typeof NodePanel>[0]> = {}) {
  const props = { nodeId: 'A0-3G', nodes: NODES, onSelectNode: vi.fn(), onClose: vi.fn(), now: NOW, ...over };
  const r = render(<NodePanel {...props} />);
  return { ...r, props };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('NodePanel', () => {
  it('shows the session: summary, prompts, commits, notes made, tokens, parent', async () => {
    const calls = stubFetch(WIRE);
    renderPanel();
    expect(await screen.findByText('Orchestrated the wall editing phases.')).toBeTruthy();
    expect(calls[0]).toEqual({ url: '/api/sessions/A0-3G', method: 'GET', body: null });
    expect(screen.getByRole('heading', { name: 'orch-wall-editing' })).toBeTruthy();
    expect(screen.getByText('Wall editing orchestration')).toBeTruthy();
    expect(screen.getByText('run the swarm')).toBeTruthy();
    expect(screen.getByText('merge phase 3')).toBeTruthy();
    expect(screen.getByText('abcdef1')).toBeTruthy();
    expect(screen.getByText('feat(web): edit in place')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'K-F07' }).getAttribute('href')).toBe('/?note=K-F07');
    expect(screen.getByText('wall editing notes')).toBeTruthy();
    expect(screen.getByText('12.3k')).toBeTruthy();
    expect(screen.getByText('1.5M')).toBeTruthy();
    expect(screen.getByText('$1.23')).toBeTruthy();
    expect(screen.getByText('mcp-notes · main')).toBeTruthy();
    expect(screen.getByText('(guessed)')).toBeTruthy();
  });

  it('opens the parent and closes', async () => {
    stubFetch(WIRE);
    const { props } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Open parent B1-11' }));
    expect(props.onSelectNode).toHaveBeenCalledWith('B1-11');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('copies the node id', async () => {
    stubFetch(WIRE);
    renderPanel({ nodeId: 'a03g' });
    await screen.findByText('Orchestrated the wall editing phases.');
    fireEvent.click(screen.getByRole('button', { name: 'Copy node id' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('A0-3G');
    expect(screen.getByRole('button', { name: 'Copy node id' }).getAttribute('data-tip')).toBe('Copied');
  });

  it('resumes at once, without a confirm click', async () => {
    const calls = stubFetch(WIRE);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Resume in tmux' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Resumed in note:4')).toBeTruthy();
    expect(posts(calls)).toEqual([{ url: '/api/sessions/A0-3G/resume', method: 'POST', body: {} }]);
  });

  it('spawns a fresh session with this context, without a confirm click', async () => {
    const calls = stubFetch(WIRE, { status: 200, body: { action: 'spawned', window: 'note:5' } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Spawn fresh with this context' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Fresh session started in note:5')).toBeTruthy();
    expect(posts(calls)).toEqual([{ url: '/api/sessions/A0-3G/resume', method: 'POST', body: { fresh: true } }]);
  });

  it('names the live action "Focus the running session"', async () => {
    stubFetch({ ...WIRE, live: true });
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Focus the running session' })).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
  });

  it('asks first for a node on the other machine, then reports not_on_this_machine', async () => {
    const calls = stubFetch({ ...WIRE, available: false, host: 'GPD' }, { status: 404, body: { error: 'not_on_this_machine' } });
    renderPanel();
    await screen.findByText('Orchestrated the wall editing phases.');
    expect(screen.getByText(/on GPD/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume in tmux' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(posts(calls)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try anyway' }));
    expect(await screen.findByText('A0-3G is not on this machine (it ran on GPD)')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts(calls)).toEqual([{ url: '/api/sessions/A0-3G/resume', method: 'POST', body: {} }]);
  });

  it('sends nothing when the cross-host confirm is cancelled', async () => {
    const calls = stubFetch({ ...WIRE, available: false, host: 'GPD' });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Spawn fresh with this context' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts(calls)).toEqual([]);
  });

  it('toggles the subtree between Tree and Timeline; both open a node', async () => {
    stubFetch(WIRE);
    const { props } = renderPanel();
    await screen.findByText('Orchestrated the wall editing phases.');
    expect(screen.getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('true');
    const tree = ['A0-3G', 'C2-22', 'D3-33'].map((id) => screen.getByRole('button', { name: `Open ${id}` }));
    expect(tree).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Open E4-44' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open B1-11' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open D3-33' }));
    expect(props.onSelectNode).toHaveBeenLastCalledWith('D3-33');

    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));
    expect(screen.getByRole('button', { name: 'Timeline' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.np-tree')).toBeNull();
    const bars = Array.from(document.querySelectorAll('[data-bar]')).map((el) => el.getAttribute('data-bar'));
    expect(bars).toEqual(['A0-3G', 'C2-22', 'D3-33']);
    fireEvent.click(document.querySelector('[data-bar="C2-22"]') as Element);
    expect(props.onSelectNode).toHaveBeenLastCalledWith('C2-22');
    fireEvent.keyDown(document.querySelector('[data-bar="D3-33"]') as Element, { key: 'Enter' });
    expect(props.onSelectNode).toHaveBeenLastCalledWith('D3-33');
  });

  it('shows the node alone when the graph does not hold it', async () => {
    stubFetch(WIRE);
    renderPanel({ nodes: [] });
    expect(await screen.findByRole('button', { name: 'Open A0-3G' })).toBeTruthy();
  });

  it('says so for an unknown node', async () => {
    stubFetch(null);
    renderPanel({ nodeId: 'ZZ-ZZ' });
    expect(await screen.findByText('No session ZZ-ZZ')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Resume in tmux' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refetches when the graph reports new activity for the node', async () => {
    const calls = stubFetch(WIRE);
    const { rerender, props } = renderPanel();
    await screen.findByText('Orchestrated the wall editing phases.');
    const later = NODES.map((x) => (x.node_id === 'A0-3G' ? { ...x, last_active_at: '2026-11-01T03:30:00.000Z' } : x));
    rerender(<NodePanel {...props} nodes={later} />);
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2));
    expect(screen.getByText('Orchestrated the wall editing phases.')).toBeTruthy();
  });
});
```

### Step 8: Mount the panel in ProjectsPage
**File:** `web/src/pages/ProjectsPage.tsx` as phase 10 Step 12 wrote it.
**Change:** `NodePanel` becomes the default of phase 10's `renderPanel` slot, so `App.tsx` needs no
change and a caller can still pass its own `renderPanel`. Phase 10's `<aside className="proj-panel">`
line stays exactly as it is.

Imports (with the file's other imports; `useMemo` is already imported by phase 10):
```tsx
import { NodePanel } from '../components/graph/NodePanel';
import { toSubtreeNodes } from '../lib/subtree';
```

Right after phase 10's `const close = useCallback(() => onSelectNode(null), [onSelectNode]);`:
```tsx
  const panelNodes = useMemo(() => toSubtreeNodes(graph.nodes), [graph.nodes]);
  const panel =
    renderPanel ??
    ((n: SessionNode, closePanel: () => void) => (
      <NodePanel nodeId={n.node_id} nodes={panelNodes} onSelectNode={(id) => onSelectNode(id)} onClose={closePanel} />
    ));
```

Replace phase 10's panel line
`{selectedNode !== null && renderPanel !== undefined && <aside className="proj-panel">{renderPanel(selectedNode, close)}</aside>}`
with:
```tsx
        {selectedNode !== null && <aside className="proj-panel">{panel(selectedNode, close)}</aside>}
```
**Impact:** selecting a node in the graph now opens the panel. Phase 10's own `ProjectsPage` tests
still pass because they do not select a node, or, if they do, they stub `fetch` for
`/api/sessions/*`. If one of phase 10's tests selects a node without stubbing that URL, add a
`GET /api/sessions/` branch returning 404 to its fetch stub. The panel then renders "No session ..."
and the test's assertions are untouched.

## Verification

**Build:** `npm run typecheck` (both tsconfigs; `tsconfig.web.json` has `noUnusedLocals`), then `npm run build`.
**Tests:** `npx vitest run web/src/components/graph/NodePanel.test.tsx web/src/lib/subtree.test.tsx web/src/lib/sessionFormat.test.tsx web/src/sessionDetailApi.test.tsx web/src/components/ConfirmDialog.test.tsx web/src/App.bin.test.tsx web/src/components/NoteEditor.test.tsx`, then the full `npm test`. `npm run test:int` is unaffected (no server change) but must still pass.
**Manual check:** `npm run dev` + `npm run dev:web`, open `/projects?repo=mcp-notes&node=<an existing id>`:
- the panel shows summary, prompts, commits, notes made (click one: the wall opens scrolled to it), tokens and cost
- clicking the id chip copies it
- the Tree/Timeline icons switch views, and a row or bar moves `?node=`
- Play opens a tmux window with no dialog
- a GPD node asks first and then reports "not on this machine"
**Exit criteria:** every new test passes; the existing "Delete anyway" tests pass unchanged; selecting a node on `/projects` mounts `NodePanel`; resume/spawn POSTs fire without a dialog for local nodes and only after the `ConfirmDialog` for `available: false` nodes.

## Handoffs

- **Phase 7 / 9 / 10 (reconciled):** the normaliser reads phase 7's published detail (`session` + top-level `prompts`, `commits`, `notes`, `parent`); the mount uses phase 10's `renderPanel` slot; phase 9's actions are the four in `resumeNotice`.
- **Phase 12 (R7):** the panel has no prompt field for `resume {prompt}`. If the per-project chat should "resume A0-3G with: ..." it can call `resumeSession(nodeId, {prompt})` from `sessionDetailApi.ts`.
- **Phase 13 (R9):** if the "unfinished" badge should also appear in the panel header, it goes next to `.np-live` in `NodePanel.tsx`'s `.np-meta`. Phase 11 does not add it.
- **Phase 14:** README wall section: node panel, Tree/Timeline, resume/spawn and its cross-host confirm.

## Rollback

Revert this phase's commit. That deletes the new files, restores `ConfirmDialog.tsx` (all callers used only the defaults), and removes the mount from `ProjectsPage.tsx`, which goes back to phase 10's empty slot. No server, schema or data changes.
