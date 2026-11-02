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
