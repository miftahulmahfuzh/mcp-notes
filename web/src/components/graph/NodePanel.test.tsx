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
