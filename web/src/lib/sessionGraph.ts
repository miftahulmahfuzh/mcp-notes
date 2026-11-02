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
