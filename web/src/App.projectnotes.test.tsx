// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note, ProjectSummary } from './types';
import { makeNote } from './testing/fixtures';
import { makeSession } from './testing/sessionFixtures';
import { App } from './App';

const iso = new Date().toISOString();
const older = new Date(Date.now() - 3_600_000).toISOString();
// Made-up ids. A-B32 is on the wall's page; Q-R88 is past it (fetched on open) and linked, not made.
const made = makeNote('A-B32', 'buy fennel #kitchen', { created: iso });
const far = makeNote('Q-R88', 'an old note past the first page', { created: older });
const notes: Note[] = [made];
const projects: ProjectSummary[] = [
  { repo: 'mcp-notes', sessions: 1, live: 0, last_active_at: '2026-11-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
];
const root = makeSession('A0-3G', 0, { custom_title: 'session-note-links' });
const DETAIL = {
  session: { session_id: 's-A0-3G', node_id: 'A0-3G', repo: 'mcp-notes', host: 'lenovo', available: true, live: false, name: 'session-note-links' },
  prompts: [],
  commits: [],
  notes: [
    { id: 'A-B32', excerpt: 'buy fennel #kitchen', tags: ['kitchen'], created_at: iso, kind: 'made' },
    { id: 'Q-R88', excerpt: 'an old note past the first page', tags: [], created_at: older, kind: 'linked' },
  ],
  parent: null,
  children: [],
};

let calls: string[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (url === '/api/projects') return json({ projects });
      if (url === '/api/projects/selected') return json({ repo: 'mcp-notes' });
      if (url.startsWith('/api/sessions/known?')) return json({ nodes: [] });
      if (url === '/api/sessions/A0-3G') return json(DETAIL);
      if (url.startsWith('/api/projects/mcp-notes/sessions')) return json({ repo: 'mcp-notes', nodes: [root] });
      const one = /^\/api\/notes\/([^/?]+)$/.exec(url);
      if (one && method === 'GET') {
        const hit = [made, far].find((n) => n.id === decodeURIComponent(one[1]!));
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
      }
      if (one && method === 'PATCH') {
        const base = [made, far].find((n) => n.id === decodeURIComponent(one[1]!)) as Note;
        return json({ ...base, body: (JSON.parse(String(init?.body)) as { body: string }).body });
      }
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

const at = (url: string) => window.history.replaceState(null, '', url);
const where = () => window.location.pathname + window.location.search;
const dialog = (id: string) => screen.queryByRole('dialog', { name: `Edit note ${id}` });
const panel = () => document.querySelector<HTMLElement>('aside.np[data-node="A0-3G"]');

/** Click; true when the page cancelled it (see App.notelinks.test.tsx `press`). */
function press(el: Element, init: MouseEventInit = {}): boolean {
  const box: { seen: boolean | null } = { seen: null };
  const stop = (e: Event) => {
    box.seen = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', stop);
  try {
    const notCancelled = fireEvent.click(el, init);
    return box.seen ?? !notCancelled;
  } finally {
    document.removeEventListener('click', stop);
  }
}

async function openPanel(): Promise<HTMLElement> {
  at('/projects?repo=mcp-notes&node=A0-3G');
  render(<App />);
  return waitFor(() => {
    const el = panel();
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
}

describe('App: a session note opens the big editor over /projects', () => {
  it('a click opens the editor in place; Esc closes only the editor (draft saved), the node panel stays', async () => {
    const p = await openPanel();
    const a = await within(p).findByRole('link', { name: 'A-B32' });
    expect(press(a)).toBe(true);
    await waitFor(() => expect(dialog('A-B32')).not.toBeNull());
    expect(where()).toBe('/projects?repo=mcp-notes&node=A0-3G');
    fireEvent.change(screen.getByLabelText('Note text'), { target: { value: 'buy fennel and dill #kitchen' } });
    // On document, where ProjectsPage listens: the editor's window capture listener must stop it there.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog('A-B32')).toBeNull());
    await waitFor(() => expect(calls).toContain('PATCH /api/notes/A-B32'));
    expect(panel()).not.toBeNull();
    expect(where()).toBe('/projects?repo=mcp-notes&node=A0-3G');
    // With the editor gone, Esc is the page's again: it clears the node.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(where()).toBe('/projects?repo=mcp-notes'));
  });

  it('a linked note past the wall page is fetched and opened; only it carries the link icon', async () => {
    const p = await openPanel();
    const linked = await within(p).findByRole('link', { name: 'Q-R88' });
    const madeRow = within(p).getByRole('link', { name: 'A-B32' }).closest('li') as HTMLElement;
    expect(within(linked.closest('li') as HTMLElement).getByRole('img', { name: 'Linked note' })).toBeTruthy();
    expect(within(madeRow).queryByRole('img', { name: 'Linked note' })).toBeNull();
    expect(press(linked)).toBe(true);
    await waitFor(() => expect(dialog('Q-R88')).not.toBeNull());
    expect(calls).toContain('GET /api/notes/Q-R88');
    expect(where()).toBe('/projects?repo=mcp-notes&node=A0-3G');
  });
});
