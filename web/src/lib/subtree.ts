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
