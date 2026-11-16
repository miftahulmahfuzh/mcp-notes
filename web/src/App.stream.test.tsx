// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note } from './types';
import type { PlayerState, StreamListResponse, StreamLiveSnapshot } from './moviesApi';
import { makeNote } from './testing/fixtures';
import { FIGHT_CLUB, MOVIE_STREAMABLE, PLAYER_IDLE, SERIES_STREAMABLE, STATUS, STREAM_LIST, TITLES } from './testing/movieFixtures';
import { STREAM_OFF_TEXT } from './lib/movies';
import { App } from './App';

const notes: Note[] = [makeNote('A-B32', 'buy fennel #kitchen', { created: new Date().toISOString() })];

let calls: string[];
let posts: { url: string; body: Record<string, unknown> | null }[];
let streamList: StreamListResponse;
/** What phase 3's POST /api/stream/play answers. */
let playAnswer: { status: number; body: Record<string, unknown> };
/** Stands in for phase 5: a failed play marks the title's source stale, so the next list lacks it. */
let dropOnFailure: string | null;
/** What GET /api/movies/player answers. */
let player: PlayerState;
/** What GET /api/stream/prober answers. */
let prober: { enabled: boolean; running: boolean; last_pass: { probed: number; probe_verified: number; rechecked: number; stopped: string; busy: string | null } | null; settings: { probe_budget: number; pass_seconds: number } | null };

/** The stream the player page reports: Fight Club, or (with season and episode) an episode of MobLand. */
const streaming = (over: Partial<StreamLiveSnapshot> = {}): PlayerState => ({
  ...PLAYER_IDLE,
  stream: { session_id: 'S1', title_id: 'movie-550', season: null, episode: null, provider: 'VidFast', state: 'playing', position: 754, duration: 8340, last_report_at: '2026-11-16T00:00:00.000Z', ...over },
});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  posts = [];
  streamList = STREAM_LIST;
  playAnswer = { status: 200, body: { ok: true } };
  dropOnFailure = null;
  player = PLAYER_IDLE;
  prober = { enabled: true, running: false, last_pass: null, settings: { probe_budget: 14, pass_seconds: 600 } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'POST') posts.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (method === 'POST' && url === '/api/stream/play') {
        if (playAnswer.status >= 400 && dropOnFailure !== null) {
          const gone = dropOnFailure;
          streamList = { ...streamList, titles: streamList.titles.filter((t) => t.id !== gone) };
        }
        return json(playAnswer.body, playAnswer.status);
      }
      if (url === '/api/stream/prober') return json(prober);
      if (method === 'POST' && url === '/api/stream/prober/pass') {
        if (!prober.enabled) return json({ error: 'prober_off' }, 409);
        prober = { ...prober, running: true };
        return json(prober, 202);
      }
      if (method === 'POST' && url.endsWith('/episodes/watched')) {
        const body = JSON.parse(String(init?.body)) as { watched: boolean; season?: number; episodes?: { season: number; episode: number }[] };
        // A season call changes two episodes; an undo sends those two back.
        return json({ watched: body.watched, changed: body.episodes ?? [{ season: body.season, episode: 1 }, { season: body.season, episode: 2 }], title: null });
      }
      if (url === '/api/movies') return json({ titles: TITLES });
      if (url === '/api/movies/stream') return json(streamList);
      if (url === '/api/movies/status') return json(STATUS);
      if (url === '/api/movies/player') return json(player);
      if (url === '/api/movies/M-FC55' || url === '/api/movies/movie-550') return json(FIGHT_CLUB);
      if (url === '/api/movies/M-23T4' || url === '/api/movies/movie-467905') return json(MOVIE_STREAMABLE);
      if (url === '/api/movies/M-8TR4' || url === '/api/movies/tv-247718') return json(SERIES_STREAMABLE);
      if (method === 'POST' && url.startsWith('/api/movies/')) return json({}, 202);
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

const h1 = () => screen.queryByRole('heading', { level: 1 })?.textContent ?? null;
const at = (url: string) => window.history.replaceState(null, '', url);
const where = () => window.location.pathname + window.location.search;
const rail = () => document.querySelector('.rail') as HTMLElement;
const switcher = () => screen.getByRole('group', { name: 'Library or Stream' });
const tileIds = () =>
  within(screen.getByRole('list', { name: 'Posters' }))
    .getAllByRole('listitem')
    .map((t) => t.querySelector('a')?.getAttribute('data-title'));
const streamPlays = () => posts.filter((p) => p.url === '/api/stream/play').map((p) => p.body);
const vlcPlays = () => posts.filter((p) => /^\/api\/movies\/(files\/\d+\/play|continue)$/.test(p.url));
const count = (call: string) => calls.filter((c) => c === call).length;

describe('App: the Stream side of /movies', () => {
  it('R5.1: the Stream switch at the top shows the Stream grid in the same page; the rail gains nothing', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    const railBefore = within(rail()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(count('GET /api/movies/stream')).toBe(0);
    expect(within(switcher()).getByRole('button', { name: 'Library' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(switcher()).getByRole('button', { name: 'Stream' }));
    await waitFor(() => expect(where()).toBe('/movies?side=stream'));
    expect(h1()).toBe('Stream.');
    // The header hint follows the side: nothing on the Stream side plays in VLC.
    expect(screen.getByText(/Play streams the title full screen/)).toBeTruthy();
    expect(screen.queryByText(/Play opens VLC/)).toBeNull();
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4', 'M-FC55']));
    expect(within(switcher()).getByRole('button', { name: 'Stream' }).getAttribute('aria-pressed')).toBe('true');
    // One row of controls: the switch sits in the grid's filter row, before a separator, and there is no toolbar row above it.
    expect(switcher().closest('.mv-filter')).not.toBeNull();
    expect(switcher().nextElementSibling?.className).toBe('mv-fsep');
    expect(document.querySelector('.mv-tools')).toBeNull();
    // A title with no file is not "gone" on this side, and there is no gone pill.
    expect(document.querySelector('.mv-tile.gone')).toBeNull();
    expect(screen.queryByRole('button', { name: /^gone/ })).toBeNull();
    await screen.findByText(/2 titles verified to stream on this machine in the last 7 days\./);
    expect(within(rail()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(railBefore);
    expect(within(rail()).queryByRole('button', { name: /stream/i })).toBeNull();
    fireEvent.click(within(switcher()).getByRole('button', { name: 'Library' }));
    await waitFor(() => expect(where()).toBe('/movies'));
    expect(h1()).toBe('Movies.');
    expect(screen.getByText(/Play opens VLC/)).toBeTruthy();
  });

  it('R5.2: the Stream grid shows exactly the verified list; empty and off say why', async () => {
    at('/movies?side=stream');
    const first = render(<App />);
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4', 'M-FC55']));
    // Library titles without a verified stream (MobLand, The Dog Stars) are not on this side.
    expect(tileIds()).not.toContain('M-8TR4');
    expect(tileIds()).not.toContain('movie-9001');
    first.unmount();

    streamList = { enabled: true, titles: [], fresh_days: 7 };
    const second = render(<App />);
    await waitFor(() => expect(document.querySelector('.mv-off')?.textContent).toContain('/direct-stream <title>'));
    expect(document.querySelector('.mv-off')?.textContent).toContain('in the last 7 days');
    second.unmount();

    streamList = { enabled: false, reason: 'direct_stream_off', titles: [] };
    render(<App />);
    await screen.findByText(STREAM_OFF_TEXT);
  });

  it('R5.3: Play on a title opened from the Stream grid asks the daemon to stream it, once, with no other click', async () => {
    at('/movies?side=stream');
    render(<App />);
    await waitFor(() => expect(tileIds()).toContain('M-FC55'));
    fireEvent.click(screen.getByRole('link', { name: /Fight Club/ }));
    await waitFor(() => expect(where()).toBe('/movies/M-FC55?side=stream'));
    const article = within(await screen.findByRole('article', { name: 'Fight Club' }));
    expect(article.getByTestId('stream-source').textContent).toBe('Stream: VidFast · 2160p · English subtitle');
    fireEvent.click(article.getByRole('button', { name: 'Stream (VidFast · 2160p · English subtitle)' }));
    await screen.findByText('opening in the streaming Chrome');
    expect(streamPlays()).toEqual([{ kind: 'movie', tmdb_id: 550 }]);
    expect(vlcPlays()).toEqual([]);
  });

  it('R5.4: a play that finds no source says so, and the title leaves the Stream grid', async () => {
    playAnswer = { status: 502, body: { error: 'no_source', attempts: [{ provider: 'VidFast', outcome: 'no_stream', took_s: 9, detail: '' }] } };
    dropOnFailure = 'movie-550';
    at('/movies/M-FC55?side=stream');
    render(<App />);
    const article = within(await screen.findByRole('article', { name: 'Fight Club' }));
    await waitFor(() => expect(count('GET /api/movies/stream')).toBeGreaterThan(0));
    const before = count('GET /api/movies/stream');
    fireEvent.click(article.getByRole('button', { name: 'Stream (VidFast · 2160p · English subtitle)' }));
    await screen.findByText('no provider could stream Fight Club now; it leaves the Stream grid');
    await waitFor(() => expect(count('GET /api/movies/stream')).toBeGreaterThan(before));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Stream' }));
    await waitFor(() => expect(where()).toBe('/movies?side=stream'));
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4']));
  });

  it('direct streaming off: Play on a Stream title is disabled and says so', async () => {
    streamList = { enabled: false, reason: 'direct_stream_off', titles: [] };
    at('/movies/M-FC55?side=stream');
    render(<App />);
    const article = within(await screen.findByRole('article', { name: 'Fight Club' }));
    await waitFor(() => expect((article.getByRole('button', { name: 'Direct streaming is off on this machine' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('R5.5: a title with a file here and a verified stream plays the file; the stream is the second icon', async () => {
    for (const url of ['/movies/M-23T4?side=stream', '/movies/M-23T4']) {
      posts = [];
      at(url);
      const view = render(<App />);
      const article = within(await screen.findByRole('article', { name: 'How to Make a Killing' }));
      fireEvent.click(article.getByRole('button', { name: 'Resume at 45:00' }));
      await waitFor(() => expect(posts.filter((p) => p.url === '/api/movies/files/11/play')).toHaveLength(1));
      expect(streamPlays()).toEqual([]);
      fireEvent.click(article.getByRole('button', { name: 'Stream (VidLink · 1080p · English subtitle)' }));
      await waitFor(() => expect(streamPlays()).toEqual([{ kind: 'movie', tmdb_id: 467905 }]));
      view.unmount();
    }
  });

  it('a series from the Stream side lists every season; an episode streams when clicked; a file here still plays in VLC', async () => {
    at('/movies/M-8TR4?side=stream');
    render(<App />);
    const eps = within(await screen.findByRole('region', { name: 'Episodes' }));
    expect(eps.getByText('Season 2')).toBeTruthy();
    const s02e01 = within(document.querySelector('[data-episode="S02E01"]') as HTMLElement);
    fireEvent.click(s02e01.getByRole('button', { name: 'Stream S02E01: checked when it starts' }));
    await waitFor(() => expect(streamPlays()).toEqual([{ kind: 'tv', tmdb_id: 247718, season: 2, episode: 1 }]));
    const s01e02 = within(document.querySelector('[data-episode="S01E02"]') as HTMLElement);
    expect(s01e02.getByRole('button', { name: 'Resume S01E02 at 20:00' })).toBeTruthy();
    expect(s01e02.getByRole('button', { name: 'Stream S01E02 (VidFast · 1080p · English subtitle)' })).toBeTruthy();
  });

  it('the refresh button asks the prober for a pass now, turns while it runs, and says so when the prober is off', async () => {
    at('/movies?side=stream');
    const first = render(<App />);
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4', 'M-FC55']));
    const refresh = screen.getByRole('button', { name: 'Find more titles to stream' });
    // It sits in the one row of controls, like the Library's Rescan.
    expect(refresh.closest('.mv-filter')).not.toBeNull();
    fireEvent.click(refresh);
    await waitFor(() => expect(posts.some((p) => p.url === '/api/stream/prober/pass')).toBe(true));
    const turning = await screen.findByRole('button', { name: 'Looking for more titles to stream' });
    expect((turning as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText('looking for more titles: up to 14, out of sight')).toBeTruthy();
    first.unmount();

    prober = { ...prober, enabled: false, running: false };
    posts = [];
    render(<App />);
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4', 'M-FC55']));
    fireEvent.click(screen.getByRole('button', { name: 'Find more titles to stream' }));
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/api/stream/prober/pass']));
    await waitFor(() => expect(document.querySelector('.mv-note')?.textContent).toBe('the prober is off: set NOTESD_STREAM_PROBER=on and restart notesd'));
  });

  it('not interested: a title page toggle, with an undo; the grid shows such a title only under its own filter', async () => {
    at('/movies/M-FC55?side=stream');
    const first = render(<App />);
    const article = await screen.findByRole('article', { name: 'Fight Club' });
    fireEvent.click(within(article).getByRole('button', { name: 'Not interested: take it off the Stream grid' }));
    await waitFor(() => expect(posts.find((p) => p.url === '/api/movies/movie-550/user')?.body).toEqual({ not_interested: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'undo' }));
    await waitFor(() => expect(posts.filter((p) => p.url === '/api/movies/movie-550/user').map((p) => p.body)).toEqual([{ not_interested: true }, { not_interested: false }]));
    first.unmount();

    streamList = { enabled: true, fresh_days: 7, titles: STREAM_LIST.enabled ? STREAM_LIST.titles.map((t) => (t.id === 'movie-550' ? { ...t, not_interested: true } : t)) : [] };
    at('/movies?side=stream');
    render(<App />);
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4']));
    fireEvent.click(screen.getByRole('button', { name: /^not interested/ }));
    await waitFor(() => expect(tileIds()).toEqual(['M-FC55']));
  });

  it('a poster carries watched and not interested: one click each, no confirmation, and the poster leaves the grid at the click', async () => {
    at('/movies?side=stream');
    render(<App />);
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4', 'M-FC55']));
    const user = () => posts.filter((p) => p.url === '/api/movies/movie-550/user').map((p) => p.body);
    // The list the daemon answers never changes in this test: the poster goes because of the click alone.
    fireEvent.click(screen.getByRole('button', { name: 'Mark Fight Club as watched' }));
    expect(tileIds()).toEqual(['M-23T4']);
    await waitFor(() => expect(user()).toEqual([{ watched: true }]));
    expect(await screen.findByText('Fight Club: watched, under finished')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^finished/ }));
    expect(tileIds()).toEqual(['M-FC55']);
    fireEvent.click(screen.getByRole('button', { name: /^all/ }));
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(tileIds()).toEqual(['M-23T4', 'M-FC55']);
    await waitFor(() => expect(user()).toEqual([{ watched: true }, { watched: false }]));

    fireEvent.click(screen.getByRole('button', { name: 'Not interested in Fight Club: take it off the Stream grid' }));
    expect(tileIds()).toEqual(['M-23T4']);
    await waitFor(() => expect(user()).toEqual([{ watched: true }, { watched: false }, { not_interested: true }]));
    fireEvent.click(screen.getByRole('button', { name: /^not interested/ }));
    expect(tileIds()).toEqual(['M-FC55']);
    // The buttons are beside the poster's link, not inside it: a click never opens the title.
    expect(window.location.pathname).toBe('/movies');
  });

  it('a season is marked finished with one button, and the notice offers an undo of exactly what it changed', async () => {
    at('/movies/M-8TR4?side=stream');
    render(<App />);
    const eps = within(await screen.findByRole('region', { name: 'Episodes' }));
    fireEvent.click(eps.getByRole('button', { name: 'Mark all of season 2 finished' }));
    const watched = () => posts.filter((p) => p.url === '/api/movies/tv-247718/episodes/watched').map((p) => p.body);
    await waitFor(() => expect(watched()).toEqual([{ season: 2, watched: true }]));
    expect(await screen.findByText(/Season 2 marked finished \(2 episodes\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    await waitFor(() =>
      expect(watched()[1]).toEqual({ episodes: [{ season: 2, episode: 1 }, { season: 2, episode: 2 }], watched: false }),
    );
    // An episode without a file has its own mark.
    const s02e01 = within(document.querySelector('[data-episode="S02E01"]') as HTMLElement);
    fireEvent.click(s02e01.getByRole('button', { name: 'Mark S02E01 finished' }));
    await waitFor(() => expect(watched()[2]).toEqual({ episodes: [{ season: 2, episode: 1 }], watched: true }));
  });

  it('the poster of the title streaming in the player page says playing or paused, on both sides', async () => {
    player = streaming();
    at('/movies?side=stream');
    const first = render(<App />);
    const now = await screen.findByRole('status', { name: 'Fight Club: playing in the stream player' });
    expect(now.textContent).toBe('playing');
    expect(now.closest('a')!.className).toBe('mv-tile now playing');
    expect(within(screen.getByRole('list', { name: 'Posters' })).getAllByRole('status')).toHaveLength(1);
    first.unmount();

    player = streaming({ state: 'paused' });
    const second = render(<App />);
    expect((await screen.findByRole('status', { name: 'Fight Club: paused in the stream player' })).closest('a')!.className).toBe('mv-tile now paused');
    second.unmount();

    // A stream of a title in the library marks its poster there too.
    player = streaming({ title_id: 'movie-467905' });
    at('/movies');
    render(<App />);
    expect((await screen.findByRole('status', { name: 'How to Make a Killing: playing in the stream player' })).closest('a')!.className).toBe('mv-tile now playing');
  });

  it("the title page shows the stream's state: a framed poster with the chip, and the position beside Play", async () => {
    for (const state of ['playing', 'paused'] as const) {
      player = streaming({ state });
      at('/movies/M-FC55?side=stream');
      const view = render(<App />);
      const article = await screen.findByRole('article', { name: 'Fight Club' });
      const status = await within(article).findByRole('status');
      expect(status.textContent).toBe(`${state} in the stream player · 12:34 / 2:19:00`);
      expect(status.className).toBe(`mv-live ${state}`);
      const art = article.querySelector('.mv-detail-art') as HTMLElement;
      expect(art.className).toBe(`mv-detail-art now ${state}`);
      expect(art.querySelector('.mv-now')!.textContent).toBe(state);
      view.unmount();
    }
    // Another title's stream marks nothing here.
    player = streaming({ title_id: 'movie-467905' });
    at('/movies/M-FC55?side=stream');
    render(<App />);
    const idle = await screen.findByRole('article', { name: 'Fight Club' });
    expect(within(idle).queryByRole('status')).toBeNull();
    expect((idle.querySelector('.mv-detail-art') as HTMLElement).className).toBe('mv-detail-art');
  });

  it("a series' page names the episode that is streaming and marks its row", async () => {
    player = streaming({ title_id: 'tv-247718', season: 2, episode: 1, state: 'paused', position: 65, duration: 3000 });
    at('/movies/M-8TR4?side=stream');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'MobLand' });
    await waitFor(() => expect(article.querySelector('.mv-live')?.textContent).toBe('S02E01 · paused in the stream player · 1:05 / 50:00'));
    const row = within(document.querySelector('[data-episode="S02E01"]') as HTMLElement).getByRole('status', { name: 'S02E01: paused' });
    expect(row.className).toBe('mv-flag mv-now paused');
    expect(within(document.querySelector('[data-episode="S01E02"]') as HTMLElement).queryByRole('status')).toBeNull();
  });
});
