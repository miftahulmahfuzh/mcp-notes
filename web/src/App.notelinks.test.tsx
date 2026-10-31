// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bin, Note } from './types';
import { makeNote } from './testing/fixtures';
import { makeMessage } from './testing/chatFixtures';
import { App } from './App';

const iso = new Date().toISOString();
const older = new Date(Date.now() - 3_600_000).toISOString();

// Made-up notes only. Q-R88 lies past the wall's page; G-H19 is in the bin; Z-Z99 does not exist.
const textA = makeNote('A-B32', '#seer onboarding is long', { created: older });
const textC = makeNote('C-D45', 'buy fennel #kitchen', { created: older });
const photoK = makeNote('K-F07', 'River #walks', { created: older, updated: iso, images: ['K-F07', 'M-N11'] });
const far = makeNote('Q-R88', 'an old note past the first page', { created: older });
const gone: Note = { ...makeNote('G-H19', 'a deleted draft', { created: older }), deleted_at: iso };
const page = [textA, textC, photoK];

const ANSWER = 'See a-b32, Q-R88, G-H19, Z-Z99 and K-F07.';

// P7 wire for GET /api/chat/messages (`ChatPage`), built with P9's fixture. App asks with include_deleted=1 (P10).
const HISTORY = {
  messages: [
    makeMessage('K7F2', { thread_id: 'T-HR1', role: 'user', text: 'where is the seer note?', created_at: older }),
    makeMessage('M3Q9', { thread_id: 'T-HR1', role: 'assistant', text: 'It is A-B32.', created_at: older, brain: 'claude' }),
  ],
  next_before: null,
};

let calls: string[];
let flashed: string[];

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  flashed = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (method === 'POST' && url === '/api/chat') {
        const done = { thread_id: 't1', user_message_id: 'U001', assistant_message_id: 'A001', reply_to: null };
        return new Response(`event: delta\ndata: ${JSON.stringify({ text: ANSWER })}\n\nevent: done\ndata: ${JSON.stringify(done)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (method === 'GET' && url.startsWith('/api/chat/messages')) return json(HISTORY);
      if (method === 'GET' && url.startsWith('/api/notes?')) return json({ notes: page, next_cursor: null });
      const one = url.match(/^\/api\/notes\/([^/?]+)$/);
      if (one && method === 'GET') {
        const id = decodeURIComponent(one[1]);
        const hit = [...page, far].find((n) => n.id === id);
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
      }
      if (one && method === 'PATCH') {
        const id = decodeURIComponent(one[1]);
        const body = (JSON.parse(String(init?.body)) as { body: string }).body;
        const base = [...page, far].find((n) => n.id === id) as Note;
        return json({ ...base, body });
      }
      if (url.startsWith('/api/tags')) return json([]);
      if (url.startsWith('/api/bin')) {
        const bin: Bin = { notes: [gone], images: [] };
        return json(bin);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function animate(this: HTMLElement): Animation {
      flashed.push(this.getAttribute('data-note') ?? this.getAttribute('data-bin-note') ?? '?');
      return {} as Animation;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  window.history.replaceState(null, '', '/');
});

const at = (url: string) => window.history.replaceState(null, '', url);
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const notice = () => document.querySelector('[data-link-notice]')?.textContent ?? null;
const card = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
const dialog = (id: string) => screen.queryByRole('dialog', { name: `Edit note ${id}` });
const link = (id: string) => document.querySelector<HTMLAnchorElement>(`.answer [data-note-link="${id}"]`);
const tagChip = (id: string, tag: string) =>
  Array.from(card(id)?.querySelectorAll('.tagchip') ?? []).find((el) => el.textContent === `#${tag}`) as HTMLElement;
const settle = () => new Promise((r) => setTimeout(r, 300));
const mutations = () => calls.filter((c) => c.startsWith('PATCH ') || c.startsWith('DELETE '));

/** Click; true when the page cancelled it (see ChatText.test.tsx `press`). */
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

const loadedWall = async () => {
  render(<App />);
  await screen.findByText('onboarding is long');
};

const ask = async () => {
  fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'which notes?' } });
  fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
  await waitFor(() => expect(document.querySelector('.answer .used-row')).not.toBeNull());
};

describe('App: note ids in chat open the big editor in place', () => {
  it('renders each id as a /?note= link, canonical href, text as written', async () => {
    await loadedWall();
    await ask();
    expect(link('A-B32')?.textContent).toBe('a-b32');
    expect(link('A-B32')?.getAttribute('href')).toBe('/?note=A-B32');
    for (const id of ['Q-R88', 'G-H19', 'Z-Z99', 'K-F07']) expect(link(id)).not.toBeNull();
    expect(within(document.querySelector('.answer') as HTMLElement).getByRole('button', { name: 'A-B32' }).className).toBe('usedchip');
  });

  it('a plain click on a loaded note opens the editor; URL, view and scroll stay', async () => {
    await loadedWall();
    await ask();
    vi.mocked(window.scrollTo).mockClear();
    const href = window.location.href;
    expect(press(link('A-B32') as HTMLElement)).toBe(true);
    expect(dialog('A-B32')).not.toBeNull();
    expect(window.location.href).toBe(href);
    expect(h1()).toBe('Notes.');
    expect(calls).not.toContain('GET /api/notes/A-B32');
    expect(window.scrollTo).not.toHaveBeenCalled();
    await settle();
    expect(flashed).toEqual([]);
  });

  it('closing it unchanged saves and deletes nothing and leaves the answer open', async () => {
    await loadedWall();
    await ask();
    press(link('A-B32') as HTMLElement);
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Escape' });
    expect(dialog('A-B32')).toBeNull();
    await settle();
    expect(mutations()).toEqual([]);
    expect(document.querySelector('.answer')).not.toBeNull();
  });

  it('a note past the loaded page is fetched, opened, and stays open across a refetch', async () => {
    await loadedWall();
    await ask();
    press(link('Q-R88') as HTMLElement);
    await waitFor(() => expect(dialog('Q-R88')).not.toBeNull());
    expect(calls).toContain('GET /api/notes/Q-R88');
    const pages = () => calls.filter((c) => c.startsWith('GET /api/notes?')).length;
    const before = pages();
    const ta = screen.getByLabelText('Note text') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'an old note, edited' } });
    fireEvent.blur(ta);
    await waitFor(() => expect(calls).toContain('PATCH /api/notes/Q-R88'));
    await waitFor(() => expect(pages()).toBeGreaterThan(before), { timeout: 2000 });
    await settle();
    expect(dialog('Q-R88')).not.toBeNull();
    expect((screen.getByLabelText('Note text') as HTMLTextAreaElement).value).toBe('an old note, edited');
  });

  it('a deleted note says so quietly and stays on the wall (no bin switch, no editor)', async () => {
    await loadedWall();
    await ask();
    press(link('G-H19') as HTMLElement);
    await waitFor(() => expect(notice()).toBe('G-H19 is deleted. Restore it from the bin.'));
    expect(h1()).toBe('Notes.');
    expect(dialog('G-H19')).toBeNull();
    expect(flashed).toEqual([]);
  });

  it('an unknown id says "no note"', async () => {
    await loadedWall();
    await ask();
    press(link('Z-Z99') as HTMLElement);
    await waitFor(() => expect(notice()).toBe('no note Z-Z99'));
    expect(calls).toContain('GET /api/notes/Z-Z99');
    expect(document.querySelector('[data-modal="editor"]')).toBeNull();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])('a modified click %j keeps the real link', async (init) => {
    await loadedWall();
    await ask();
    expect(press(link('A-B32') as HTMLElement, init)).toBe(false);
    expect(document.querySelector('[data-modal="editor"]')).toBeNull();
  });

  it('opens over the bin without leaving it', async () => {
    await loadedWall();
    await ask();
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    press(link('A-B32') as HTMLElement);
    expect(dialog('A-B32')).not.toBeNull();
    expect(h1()).toBe('Deleted.');
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Escape' });
    expect(h1()).toBe('Deleted.');
  });

  it('opens over the history page; closing returns to it with no navigation', async () => {
    at('/history');
    render(<App />);
    const a = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('[data-note-link="A-B32"]');
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    const len = window.history.length;
    expect(press(a)).toBe(true);
    expect(dialog('A-B32')).not.toBeNull();
    expect(window.location.pathname).toBe('/history');
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Escape' });
    expect(dialog('A-B32')).toBeNull();
    expect(window.location.pathname).toBe('/history');
    expect(window.history.length).toBe(len);
    expect(document.querySelector('[data-note-link="A-B32"]')).not.toBeNull();
  });
});

describe('App: "Show on wall" in the big editor', () => {
  it('from the bin: closes the editor, switches to the wall, pushes /?note=ID and flashes the card', async () => {
    await loadedWall();
    await ask();
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    press(link('A-B32') as HTMLElement);
    const len = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    expect(dialog('A-B32')).toBeNull();
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
    expect(`${window.location.pathname}${window.location.search}`).toBe('/?note=A-B32');
    expect(window.history.length).toBe(len + 1);
    expect(mutations()).toEqual([]);
  });

  it('from the history page: lands on the wall with the card flashed', async () => {
    at('/history');
    render(<App />);
    const a = await waitFor(() => {
      const el = document.querySelector<HTMLAnchorElement>('[data-note-link="A-B32"]');
      expect(el).not.toBeNull();
      return el as HTMLAnchorElement;
    });
    press(a);
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(`${window.location.pathname}${window.location.search}`).toBe('/?note=A-B32');
    expect(card('A-B32')).not.toBeNull();
  });

  it('drops an active tag that hides the note (the editor no longer counts as keeping it)', async () => {
    await loadedWall();
    await ask();
    fireEvent.click(tagChip('C-D45', 'kitchen'));
    expect(h1()).toBe('#kitchen');
    expect(card('A-B32')).toBeNull();
    press(link('A-B32') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
    expect(card('A-B32')).not.toBeNull();
  });

  it('a photo note hidden by text mode switches to Everything.', async () => {
    await loadedWall();
    await ask();
    press(link('K-F07') as HTMLElement);
    expect(dialog('K-F07')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['K-F07']));
    expect(h1()).toBe('Everything.');
  });

  it('a later Forward/Back through popstate re-reads the URL as before', async () => {
    await loadedWall();
    await ask();
    press(link('A-B32') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Show on wall' }));
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    window.history.pushState(null, '', '/?note=C-D45');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(flashed).toEqual(['A-B32', 'C-D45']));
  });
});
