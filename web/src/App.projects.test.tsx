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
