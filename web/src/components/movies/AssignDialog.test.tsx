// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TmdbHitView, UnmatchedFile } from '../../moviesApi';
import { UNMATCHED } from '../../testing/movieFixtures';
import { AssignDialog } from './AssignDialog';

/** The assign dialog of docs/guide/movies.md ("The unmatched list"): search from the parser's guess, pick, assign. */

const hit = (over: Partial<TmdbHitView>): TmdbHitView => ({ kind: 'movie', tmdb_id: 1, title_id: 'movie-1', title: 'T', original_title: 'T', year: 2020, overview: '', poster_url: null, in_library: false, ...over });
const NEZHA = hit({ tmdb_id: 1125510, title_id: 'movie-1125510', title: 'Ne Zha 2', year: 2025 });
const NEZHA_1 = hit({ tmdb_id: 615453, title_id: 'movie-615453', title: 'Ne Zha', year: 2019, in_library: true });
const MOBLAND = hit({ kind: 'tv', tmdb_id: 247718, title_id: 'tv-247718', title: 'MobLand', year: 2025 });

const CLIP = UNMATCHED[0]!;
const NEZHA_FILE = UNMATCHED[1]!;
const EPISODE_FILE: UnmatchedFile = {
  ...NEZHA_FILE,
  id: 33,
  path: '/lib/Mobland S01/MobLand.S01E02.mkv',
  name: 'MobLand.S01E02.mkv',
  parsed: { title: 'MobLand', year: null, season: 1, episode: 2, absolute_episode: null, kind_hint: null },
};

let gets: string[];
let posts: { url: string; body: unknown }[];
/** The answer of each search, by its kind; a function answers per query. */
let results: Record<string, TmdbHitView[]>;
let searchFails: { status: number; error: string } | null;
let assignFails: { status: number; error: string } | null;
/** Held search answers, released by the test: the newest search must win whatever order they land in. */
let hold: ((url: string) => Promise<void>) | null;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  gets = [];
  posts = [];
  results = { movie: [NEZHA, NEZHA_1], tv: [MOBLAND] };
  searchFails = null;
  assignFails = null;
  hold = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push({ url, body: JSON.parse(String(init?.body)) });
        if (assignFails !== null) return json({ error: assignFails.error }, assignFails.status);
        const body = JSON.parse(String(init?.body)) as { kind: string; tmdb_id: number };
        return json({ file_id: 1, title: { id: `${body.kind}-${body.tmdb_id}` } });
      }
      gets.push(url);
      if (hold !== null) await hold(url);
      if (searchFails !== null) return json({ error: searchFails.error }, searchFails.status);
      const kind = new URL(url, 'http://x').searchParams.get('kind') ?? 'movie';
      return json({ results: results[kind] ?? [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(file: UnmatchedFile) {
  const onClose = vi.fn();
  const onAssigned = vi.fn();
  render(<AssignDialog file={file} onClose={onClose} onAssigned={onAssigned} />);
  const dialog = screen.getByRole('dialog', { name: `Assign a title to ${file.name}` });
  return { onClose, onAssigned, dialog, d: within(dialog) };
}

/** A result row as it reads: its name, then year and "in library" (the poster placeholder repeats the name, so it is left out). */
const optionTexts = (d: { getAllByRole: (role: string) => HTMLElement[] }) => d.getAllByRole('option').map((o) => [...o.querySelectorAll(':scope > span')].map((x) => x.textContent).join(' | '));

const assignButton = () => screen.getByRole('button', { name: 'Assign' }) as HTMLButtonElement;

describe('AssignDialog', () => {
  it("searches TMDB at once with the parser's guess and its kind, and shows the file's path", async () => {
    const { d } = show(NEZHA_FILE);
    expect(d.getByText('/lib/Nezha (2019)/Ne.Zha.2.2025.1080p.mkv')).toBeTruthy();
    expect((d.getByRole('textbox', { name: 'Search TMDB' }) as HTMLInputElement).value).toBe('Ne Zha 2');
    expect(d.getByRole('button', { name: 'Search films' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(d.getAllByRole('option')).toHaveLength(2));
    expect(gets).toEqual(['/api/movies/search-tmdb?q=Ne%20Zha%202&kind=movie']);
    // A result already in the library says so.
    expect(optionTexts(d)).toEqual(['Ne Zha 2 | 2025', 'Ne Zha | 2019 · in library']);
  });

  it('a file the parser could not read searches its file name, as a film', async () => {
    show(CLIP);
    await waitFor(() => expect(gets).toEqual(['/api/movies/search-tmdb?q=clip-0412.mp4&kind=movie']));
  });

  it('an episode guess searches series and prefills the season and episode', async () => {
    const { d } = show(EPISODE_FILE);
    await waitFor(() => expect(gets).toEqual(['/api/movies/search-tmdb?q=MobLand&kind=tv']));
    expect(d.getByRole('button', { name: 'Search series' }).getAttribute('aria-pressed')).toBe('true');
    // The season and episode ask only once a series is picked.
    expect(d.queryByRole('textbox', { name: 'Season' })).toBeNull();
    fireEvent.click(await d.findByRole('option', { name: /MobLand/ }));
    expect((d.getByRole('textbox', { name: 'Season' }) as HTMLInputElement).value).toBe('1');
    expect((d.getByRole('textbox', { name: 'Episode' }) as HTMLInputElement).value).toBe('2');
  });

  it('an absolute-numbered episode (One Piece - 405) searches series, with season and episode left for the owner', async () => {
    const onePiece: UnmatchedFile = {
      ...NEZHA_FILE,
      id: 34,
      path: '/lib/One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv',
      name: 'One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv',
      parsed: { title: 'One Piece', year: null, season: null, episode: null, absolute_episode: 405, kind_hint: 'tv' },
    };
    results = { movie: [], tv: [hit({ kind: 'tv', tmdb_id: 37854, title_id: 'tv-37854', title: 'One Piece', year: 1999 })] };
    const { d, onAssigned } = show(onePiece);
    await waitFor(() => expect(gets).toEqual(['/api/movies/search-tmdb?q=One%20Piece&kind=tv']));
    fireEvent.click(await d.findByRole('option', { name: /One Piece/ }));
    expect((d.getByRole('textbox', { name: 'Season' }) as HTMLInputElement).value).toBe('');
    expect((d.getByRole('textbox', { name: 'Episode' }) as HTMLInputElement).value).toBe('');
    fireEvent.click(assignButton());
    await waitFor(() => expect(onAssigned).toHaveBeenCalledWith('tv-37854', 'One Piece'));
    expect(posts.map((p) => p.body)).toEqual([{ kind: 'tv', tmdb_id: 37854 }]);
  });

  it('assigns a picked film, and hands the page the title it went to and its name', async () => {
    const { d, onAssigned } = show(NEZHA_FILE);
    expect(assignButton().disabled).toBe(true);
    fireEvent.click(await d.findByRole('option', { name: /^Ne Zha 2/ }));
    expect(d.getByRole('option', { name: /^Ne Zha 2/ }).getAttribute('aria-selected')).toBe('true');
    expect(assignButton().disabled).toBe(false);
    fireEvent.click(assignButton());
    await waitFor(() => expect(onAssigned).toHaveBeenCalledWith('movie-1125510', 'Ne Zha 2'));
    expect(posts).toEqual([{ url: '/api/movies/files/32/assign', body: { kind: 'movie', tmdb_id: 1125510 } }]);
  });

  it('assigns a series with the season and episode typed, or without them when one is not a number', async () => {
    const cases: [string, string, unknown][] = [
      ['1', ' 5 ', { kind: 'tv', tmdb_id: 247718, season: 1, episode: 5 }],
      ['1', '', { kind: 'tv', tmdb_id: 247718 }],
      ['-1', '3', { kind: 'tv', tmdb_id: 247718 }],
    ];
    for (const [season, episode, body] of cases) {
      posts = [];
      const { d, onAssigned } = show(EPISODE_FILE);
      fireEvent.click(await d.findByRole('option', { name: /MobLand/ }));
      fireEvent.change(d.getByRole('textbox', { name: 'Season' }), { target: { value: season } });
      fireEvent.change(d.getByRole('textbox', { name: 'Episode' }), { target: { value: episode } });
      fireEvent.click(assignButton());
      await waitFor(() => expect(onAssigned).toHaveBeenCalledWith('tv-247718', 'MobLand'));
      expect(posts.map((p) => p.body)).toEqual([body]);
      // Taken: Assign stays off until the page closes the dialog, so one click assigns once.
      expect(assignButton().disabled).toBe(true);
      cleanup();
    }
  });

  it('switching film / series searches the current text again and drops the pick; typing waits for Enter', async () => {
    const { d } = show(NEZHA_FILE);
    fireEvent.click(await d.findByRole('option', { name: /^Ne Zha 2/ }));
    fireEvent.change(d.getByRole('textbox', { name: 'Search TMDB' }), { target: { value: 'Mobland' } });
    expect(gets).toHaveLength(1);
    fireEvent.click(d.getByRole('button', { name: 'Search series' }));
    await waitFor(() => expect(gets).toEqual(['/api/movies/search-tmdb?q=Ne%20Zha%202&kind=movie', '/api/movies/search-tmdb?q=Mobland&kind=tv']));
    await waitFor(() => expect(optionTexts(d)).toEqual(['MobLand | 2025']));
    expect(assignButton().disabled).toBe(true);
    fireEvent.change(d.getByRole('textbox', { name: 'Search TMDB' }), { target: { value: '  Ne Zha  ' } });
    fireEvent.submit(d.getByRole('textbox', { name: 'Search TMDB' }).closest('form')!);
    await waitFor(() => expect(gets[2]).toBe('/api/movies/search-tmdb?q=Ne%20Zha&kind=tv'));
  });

  it('a blank search asks nothing', async () => {
    const { d } = show(NEZHA_FILE);
    await waitFor(() => expect(gets).toHaveLength(1));
    fireEvent.change(d.getByRole('textbox', { name: 'Search TMDB' }), { target: { value: '   ' } });
    fireEvent.click(d.getByRole('button', { name: 'Search' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(gets).toHaveLength(1);
  });

  it('no result says so with the text searched', async () => {
    results = { movie: [], tv: [] };
    const { d } = show(NEZHA_FILE);
    expect(await d.findByText('No TMDB match for Ne Zha 2.')).toBeTruthy();
  });

  it('a TMDB with no credentials says so; another failure names its code', async () => {
    searchFails = { status: 503, error: 'tmdb_off' };
    show(NEZHA_FILE);
    expect((await screen.findByRole('alert')).textContent).toBe('TMDB credentials are not set on this machine');
    cleanup();
    searchFails = { status: 502, error: 'tmdb_error' };
    show(NEZHA_FILE);
    expect((await screen.findByRole('alert')).textContent).toBe('could not search TMDB (tmdb_error)');
  });

  it('a refused assign says why, keeps the dialog and lets it be tried again', async () => {
    assignFails = { status: 404, error: 'not_found' };
    const { d, onAssigned } = show(NEZHA_FILE);
    fireEvent.click(await d.findByRole('option', { name: /^Ne Zha 2/ }));
    fireEvent.click(assignButton());
    expect((await screen.findByRole('alert')).textContent).toBe('could not assign (not_found)');
    expect(onAssigned).not.toHaveBeenCalled();
    expect(assignButton().disabled).toBe(false);
  });

  it('the newest search wins: an older answer that lands later is dropped', async () => {
    const waiting = new Map<string, () => void>();
    hold = (url) => new Promise<void>((r) => waiting.set(url, r));
    const { d } = show(NEZHA_FILE);
    await waitFor(() => expect(gets).toHaveLength(1));
    fireEvent.click(d.getByRole('button', { name: 'Search series' }));
    await waitFor(() => expect(gets).toHaveLength(2));
    waiting.get(gets[1]!)!();
    await waitFor(() => expect(optionTexts(d)).toEqual(['MobLand | 2025']));
    waiting.get(gets[0]!)!();
    await new Promise((r) => setTimeout(r, 20));
    expect(optionTexts(d)).toEqual(['MobLand | 2025']);
  });

  it('Esc, the cancel icon and a click on the backdrop close it; Esc reaches nothing behind it', async () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      const { onClose, dialog } = show(NEZHA_FILE);
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(behind).not.toHaveBeenCalled();
      fireEvent.click(dialog);
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(2);
      fireEvent.click(document.querySelector('[data-modal="assign"]')!);
      expect(onClose).toHaveBeenCalledTimes(3);
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });
});
