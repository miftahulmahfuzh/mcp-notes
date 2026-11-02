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
