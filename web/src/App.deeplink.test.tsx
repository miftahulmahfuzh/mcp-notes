// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bin, Note } from './types';
import { makeNote } from './testing/fixtures';
import { App } from './App';

const iso = new Date().toISOString();
const older = new Date(Date.now() - 3_600_000).toISOString();

// Made-up notes only. Q-R88 lies past the wall's 2000-note page; G-H19 is in the bin; Z-Z99 does not exist.
const textA = makeNote('A-B32', '#seer onboarding is long', { created: older });
const textC = makeNote('C-D45', 'buy fennel #kitchen', { created: older });
const textE = makeNote('E-F56', 'miso soup #seer #kitchen', { created: older });
const photoK = makeNote('K-F07', 'River #walks', { created: older, updated: iso, images: ['K-F07', 'M-N11'] });
const far = makeNote('Q-R88', 'an old note past the first page', { created: older });
const gone: Note = { ...makeNote('G-H19', 'a deleted draft #seer', { created: older }), deleted_at: iso };
const page = [textA, textC, textE, photoK];

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
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url.startsWith('/api/notes?')) return json({ notes: page, next_cursor: null });
      if (method === 'GET' && url.startsWith('/api/notes/')) {
        const id = decodeURIComponent(url.slice('/api/notes/'.length));
        const hit = [...page, far].find((n) => n.id === id);
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
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
const go = (hash: string) =>
  act(() => {
    window.location.hash = hash;
  });
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
const card = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const notice = () => document.querySelector('[data-link-notice]')?.textContent ?? null;
const chip = (id: string, tag: string) =>
  Array.from(card(id)?.querySelectorAll('.tagchip') ?? []).find((el) => el.textContent === `#${tag}`) as HTMLElement;
const settle = () => new Promise((r) => setTimeout(r, 200));
const loadedWall = async () => {
  render(<App />);
  await screen.findByText('onboarding is long');
};

describe('App: deep link to a note', () => {
  it('?note= with a lower-case id selects the note on load', async () => {
    at('/?note=a-b32');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
    expect(notice()).toBeNull();
  });

  it('?note= without the dash', async () => {
    at('/?note=cd45');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
  });

  it('#id of a photo note hidden by text mode switches to Everything.', async () => {
    at('/#k-f07');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['K-F07']));
    expect(h1()).toBe('Everything.');
    expect(card('K-F07')).not.toBeNull();
  });

  it('from the Photos. gallery, a text note switches to Everything.', async () => {
    await loadedWall();
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    expect(h1()).toBe('Photos.');
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Everything.');
  });

  it('drops only the active tags that exclude the note', async () => {
    await loadedWall();
    fireEvent.click(chip('C-D45', 'kitchen'));
    fireEvent.click(chip('E-F56', 'seer'));
    expect(h1()).toBe('#kitchen #seer');
    expect(card('C-D45')).toBeNull();
    go('#C-D45');
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
    expect(h1()).toBe('#kitchen');
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['C-D45', 'A-B32']));
    expect(h1()).toBe('Notes.');
  });

  it('leaves the bin view for a live note', async () => {
    await loadedWall();
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(h1()).toBe('Notes.');
  });

  it('follows hashchange, and a new hashchange to the same note flashes it again', async () => {
    await loadedWall();
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    go('#C-D45');
    await waitFor(() => expect(flashed).toEqual(['A-B32', 'C-D45']));
    go('#a-b32');
    await waitFor(() => expect(flashed).toEqual(['A-B32', 'C-D45', 'A-B32']));
  });

  it('follows popstate; popstate + hashchange of one navigation flash once', async () => {
    await loadedWall();
    pop('/?note=C-D45');
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
    pop('/?note=E-F56');
    await waitFor(() => expect(flashed).toEqual(['C-D45', 'E-F56']));
    act(() => {
      window.location.hash = '#A-B32';
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(flashed).toEqual(['C-D45', 'E-F56', 'A-B32']));
    await settle();
    expect(flashed).toEqual(['C-D45', 'E-F56', 'A-B32']);
  });

  it('keeps the big editor open when it holds the target', async () => {
    await loadedWall();
    fireEvent.click(within(card('A-B32') as HTMLElement).getByRole('button', { name: 'Expand note' }));
    expect(screen.getByRole('dialog', { name: 'Edit note A-B32' })).toBeTruthy();
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(screen.getByRole('dialog', { name: 'Edit note A-B32' })).toBeTruthy();
  });

  it('closes a big editor open on another note (unchanged draft: no save, no delete)', async () => {
    await loadedWall();
    fireEvent.click(within(card('A-B32') as HTMLElement).getByRole('button', { name: 'Expand note' }));
    expect(document.querySelector('[data-modal="editor"]')).not.toBeNull();
    go('#C-D45');
    await waitFor(() => expect(flashed).toEqual(['C-D45']));
    expect(document.querySelector('[data-modal="editor"]')).toBeNull();
    expect(calls.some((c) => c.startsWith('PATCH ') || c.startsWith('DELETE '))).toBe(false);
  });

  it('keeps the inline editor of the target', async () => {
    await loadedWall();
    fireEvent.click(card('A-B32')?.querySelector('.card-text') as HTMLElement);
    expect(card('A-B32')?.querySelector('.card-edit')).not.toBeNull();
    go('#A-B32');
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    expect(card('A-B32')?.querySelector('.card-edit')).not.toBeNull();
  });

  it('fetches a note that is not in the loaded page and shows it', async () => {
    at('/?note=q-r88');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['Q-R88']));
    expect(calls).toContain('GET /api/notes/Q-R88');
    expect(card('Q-R88')).not.toBeNull();
  });

  it('a deleted note opens the bin on its card with a notice', async () => {
    at('/?note=gh19');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['G-H19']));
    expect(h1()).toBe('Deleted.');
    expect(calls).toContain('GET /api/notes/G-H19');
    expect(notice()).toBe('G-H19 is deleted. Restore it from the bin.');
    const binCard = document.querySelector('[data-bin-note="G-H19"]') as HTMLElement;
    expect(within(binCard).getByRole('button', { name: 'Restore note' })).toBeTruthy();
  });

  it('an unknown id shows a quiet notice and changes nothing', async () => {
    at('/?note=Z-Z99');
    await loadedWall();
    await waitFor(() => expect(notice()).toBe('no note Z-Z99'));
    expect(h1()).toBe('Notes.');
    expect(flashed).toEqual([]);
  });

  it('ignores a value that cannot be a note id', async () => {
    at('/?note=hello');
    await loadedWall();
    await settle();
    expect(calls.some((c) => c.startsWith('GET /api/notes/'))).toBe(false);
    expect(notice()).toBeNull();
    expect(flashed).toEqual([]);
  });

  it('a background refetch (SSE note event) does not select the note again', async () => {
    class FakeES {
      static last: FakeES | null = null;
      private l = new Map<string, Array<() => void>>();
      constructor(public url: string) {
        FakeES.last = this;
      }
      addEventListener(type: string, fn: () => void) {
        this.l.set(type, [...(this.l.get(type) ?? []), fn]);
      }
      close() {}
      emit(type: string) {
        for (const fn of this.l.get(type) ?? []) fn();
      }
    }
    vi.stubGlobal('EventSource', FakeES);
    at('/?note=A-B32');
    await loadedWall();
    await waitFor(() => expect(flashed).toEqual(['A-B32']));
    const pages = () => calls.filter((c) => c === 'GET /api/notes?limit=2000').length;
    const before = pages();
    act(() => FakeES.last?.emit('note'));
    await waitFor(() => expect(pages()).toBe(before + 1), { timeout: 2000 });
    await settle();
    expect(flashed).toEqual(['A-B32']);
  });

  it('without a target, the Header "Last edited" jump behaves as before (no flash)', async () => {
    await loadedWall();
    fireEvent.click(screen.getByRole('link', { name: 'K-F07' }));
    await waitFor(() => expect(h1()).toBe('Everything.'));
    await settle();
    expect(flashed).toEqual([]);
    expect(window.scrollTo).toHaveBeenCalled();
  });
});
