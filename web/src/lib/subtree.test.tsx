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
