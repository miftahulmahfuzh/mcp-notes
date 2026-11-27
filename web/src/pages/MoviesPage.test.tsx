// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MoviesStore } from '../hooks/useMovies';
import type { SiteTitle, StreamListResponse, TrendingListResponse, TrendingTitle } from '../moviesApi';
import { MOVIES_OFF_TEXT, STREAM_OFF_TEXT, streamEmptyText } from '../lib/movies';
import { CACHE_ROUTE, HEALTH_ROUTE, NO_MOVIES_ROUTE, STREAM_ROUTE, type MoviesRoute } from '../lib/route';
import { FIGHT_CLUB, FIGHT_CLUB_ITEM, KILLING_ITEM, makeItem, MOVIE, PLAYER_IDLE, PLAYING, STATUS, STREAM_LIST, TITLES, UNMATCHED } from '../testing/movieFixtures';
import { MoviesPage } from './MoviesPage';

/**
 * The Movies page (docs/guide/movies.md, "The Movies page", "The Stream side", "Stream health"),
 * rendered on its own with a store the test owns. The Cache and Stream health pages have their own
 * tests: here they are stand-ins that only show which one is open and hand back a title to open.
 */
vi.mock('../components/movies/CachePage', () => ({
  CachePage: ({ onOpen }: { onOpen: (id: string) => void }) => (
    <button type="button" data-testid="cache-page" onClick={() => onOpen('movie-550')}>
      cache page
    </button>
  ),
}));
vi.mock('../components/movies/HealthPage', () => ({
  HealthPage: ({ onOpen }: { onOpen: (id: string) => void }) => (
    <button type="button" data-testid="health-page" onClick={() => onOpen('movie-550')}>
      health page
    </button>
  ),
}));

let calls: { method: string; url: string; body: unknown }[];
/** `METHOD url` → the error the fake daemon answers with. */
let fails: Record<string, { status: number; error: string; message?: string }>;
let answers: Record<string, unknown>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  fails = {};
  answers = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      const f = fails[`${method} ${url}`];
      if (f !== undefined) return json({ error: f.error, message: f.message }, f.status);
      if (url.startsWith('/api/stream/downloads')) return json({ host: 'lenovo', active: false, downloads: [] });
      return json(answers[`${method} ${url}`] ?? {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const DUNE: TrendingTitle = {
  ...makeItem('movie-693134', 'Dune: Part Two', { year: 2024, present_here: false, file_count: 0 }),
  trending: { kind_rank: 1, seeds: 4200, index: 'apibay', release: 'Dune.Part.Two.2024.1080p', size_bytes: 3e9, listed_at: '2026-11-27T00:00:00.000Z' },
};
const TRENDING: TrendingListResponse = { enabled: true, titles: [DUNE], listed_at: '2026-11-27T00:00:00.000Z', running: false };
const SUMMER: SiteTitle = {
  id: 7,
  site: 'dramacool',
  site_url: 'https://dramacool.test/summer-vacation',
  kind: 'series',
  name: 'Summer Vacation',
  year: 2020,
  poster_url: null,
  overview: '',
  country: 'South Korea',
  status: null,
  genres: [],
  also_known: null,
  season: 1,
  episode: 3,
  played_at: '2026-11-20T00:00:00.000Z',
};

function makeStore(over: Partial<MoviesStore> = {}): MoviesStore {
  return { titles: TITLES, listError: null, detail: null, detailError: null, unmatched: UNMATCHED, unmatchedError: null, status: STATUS, player: PLAYER_IDLE, stream: null, streamError: null, trending: null, refresh: vi.fn(), ...over };
}

/** The Stream list with its titles and the streaming-site titles given. */
const streamList = (siteTitles: SiteTitle[] = [], titles = STREAM_LIST.titles): StreamListResponse => ({ enabled: true, titles, fresh_days: 7, site_titles: siteTitles });

const streamStore = (over: Partial<MoviesStore> = {}) => makeStore({ stream: streamList(), trending: TRENDING, ...over });

function show(store: MoviesStore, route: MoviesRoute) {
  const onRoute = vi.fn();
  const onAsk = vi.fn();
  const view = render(<MoviesPage store={store} route={route} onRoute={onRoute} onAsk={onAsk} />);
  return { onRoute, onAsk, rerender: (s: MoviesStore, r: MoviesRoute) => view.rerender(<MoviesPage store={s} route={r} onRoute={onRoute} onAsk={onAsk} />) };
}

const tiles = (name = 'Posters') => within(screen.getByRole('list', { name })).queryAllByRole('listitem').map((t) => t.querySelector('.mv-cap-t')?.textContent);
const pills = () => within(screen.getByRole('group', { name: 'State' })).getAllByRole('button').map((b) => b.textContent);
const note = () => document.querySelector('.mv-note');
const posted = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body);

describe('MoviesPage: the Library side', () => {
  it('one row of controls over the grid: the switch, the state pills with counts, the kinds, the text filter, Unmatched and Rescan', () => {
    show(makeStore(), NO_MOVIES_ROUTE);
    const lib = within(screen.getByRole('region', { name: 'Library' }));
    expect(lib.getByRole('button', { name: 'Library' }).getAttribute('aria-pressed')).toBe('true');
    expect(lib.getByRole('button', { name: 'Stream' }).getAttribute('aria-pressed')).toBe('false');
    // The Library has a gone pill and no interested ones; the Dog Stars has no file left.
    expect(pills()).toEqual(['all3', 'unwatched0', 'in progress2', 'finished0', 'gone1']);
    expect(within(screen.getByRole('group', { name: 'Kind' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['All kinds', 'Films', 'Series']);
    // Two unmatched files wait on this machine: the icon counts them.
    const unmatched = lib.getByRole('button', { name: 'Unmatched files' });
    expect(unmatched.getAttribute('data-tip')).toBe('Unmatched files (2)');
    expect(unmatched.querySelector('.mv-count')?.textContent).toBe('2');
    expect(lib.getByRole('button', { name: 'Rescan the library' })).toBeTruthy();
    // No Cache, no health, no toolbar of its own: everything sits in the grid's row.
    expect(screen.queryByRole('button', { name: 'Cache' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stream health' })).toBeNull();
    expect(document.querySelector('.mv-tools')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Trending' })).toBeNull();
  });

  it('the state pills, the kinds and the text narrow the grid, and the counts follow the kind and text', () => {
    show(makeStore(), NO_MOVIES_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: /^gone/ }));
    expect(tiles()).toEqual(['The Dog Stars']);
    fireEvent.click(screen.getByRole('button', { name: /^all/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Series' }));
    expect(tiles()).toEqual(['MobLand']);
    expect(pills()).toEqual(['all1', 'unwatched0', 'in progress1', 'finished0', 'gone0']);
    fireEvent.click(screen.getByRole('button', { name: 'All kinds' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'killing' } });
    expect(tiles()).toEqual(['How to Make a Killing']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'nothing like this' } });
    expect(screen.getByText('Nothing matches this filter.')).toBeTruthy();
  });

  it("each side keeps its own filter, and it survives opening a title and coming back", () => {
    const store = streamStore({ detail: MOVIE });
    const { rerender } = show(store, NO_MOVIES_ROUTE);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'mob' } });
    rerender(store, { title: 'movie-467905', unmatched: false });
    expect(screen.getByRole('article', { name: 'How to Make a Killing' })).toBeTruthy();
    rerender(store, STREAM_ROUTE);
    expect((screen.getByRole('searchbox', { name: 'Filter titles' }) as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'fight' } });
    rerender(store, NO_MOVIES_ROUTE);
    expect((screen.getByRole('searchbox', { name: 'Filter titles' }) as HTMLInputElement).value).toBe('mob');
    expect(tiles()).toEqual(['MobLand']);
    rerender(store, STREAM_ROUTE);
    expect((screen.getByRole('searchbox', { name: 'Filter titles' }) as HTMLInputElement).value).toBe('fight');
  });

  it('the switch and the unmatched icon route; the unmatched icon on its own page goes back', () => {
    const { onRoute, rerender } = show(makeStore(), NO_MOVIES_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Stream' }));
    expect(onRoute).toHaveBeenLastCalledWith(STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Unmatched files' }));
    expect(onRoute).toHaveBeenLastCalledWith({ title: null, unmatched: true });
    rerender(makeStore(), { title: null, unmatched: true });
    // Its own page: a toolbar, with Back, and the icon lit.
    const tools = within(document.querySelector('.mv-tools') as HTMLElement);
    expect(tools.getByRole('button', { name: 'Unmatched files' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tools.getByRole('button', { name: 'Unmatched files' }));
    expect(onRoute).toHaveBeenLastCalledWith(NO_MOVIES_ROUTE);
    fireEvent.click(tools.getByRole('button', { name: 'Back to the library' }));
    expect(onRoute).toHaveBeenLastCalledWith(NO_MOVIES_ROUTE);
  });

  it('with nothing unmatched the icon carries no count', () => {
    show(makeStore({ status: { ...STATUS, counts: { ...STATUS.counts, unmatched_here: 0, pending_here: 0 } } }), NO_MOVIES_ROUTE);
    const b = screen.getByRole('button', { name: 'Unmatched files' });
    expect(b.getAttribute('data-tip')).toBe('Unmatched files');
    expect(b.querySelector('.mv-count')).toBeNull();
  });

  it('Rescan starts a pass and says so; a refusal says why; the store is read again either way', async () => {
    const store = makeStore();
    show(store, NO_MOVIES_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Rescan the library' }));
    await waitFor(() => expect(note()?.textContent).toBe('rescan started'));
    expect(posted('/api/movies/sync')).toEqual([{}]);
    expect(store.refresh).toHaveBeenCalledTimes(1);
    fails['POST /api/movies/sync'] = { status: 503, error: 'movies_off' };
    fireEvent.click(screen.getByRole('button', { name: 'Rescan the library' }));
    await waitFor(() => expect(note()?.textContent).toBe('rescan refused: movies_off'));
    expect(store.refresh).toHaveBeenCalledTimes(2);
  });

  it('marking a poster watched takes it off "all" at the click, with an undo; it is then under finished', async () => {
    const store = makeStore();
    show(store, NO_MOVIES_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: /^Mark How to Make a Killing as watched/ }));
    expect(tiles()).toEqual(['MobLand', 'The Dog Stars']);
    await waitFor(() => expect(note()?.textContent).toBe('How to Make a Killing: watched, under finishedundo'));
    expect(posted('/api/movies/movie-467905/user')).toEqual([{ watched: true }]);
    fireEvent.click(screen.getByRole('button', { name: /^finished/ }));
    expect(tiles()).toEqual(['How to Make a Killing']);
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    await waitFor(() => expect(posted('/api/movies/movie-467905/user')).toEqual([{ watched: true }, { watched: false }]));
    expect(screen.getByText('Nothing matches this filter.')).toBeTruthy();
  });

  it('a series marked watched says every season', async () => {
    show(makeStore(), NO_MOVIES_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: /^Mark MobLand as watched/ }));
    await waitFor(() => expect(note()?.textContent).toBe('MobLand: watched, every season, under finishedundo'));
  });

  it('a mark that is not saved puts the poster back and says so', async () => {
    fails['POST /api/movies/movie-467905/user'] = { status: 503, error: 'movies_off' };
    show(makeStore(), NO_MOVIES_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: /^Mark How to Make a Killing as watched/ }));
    await waitFor(() => expect(note()?.textContent).toBe('could not save (movies_off)'));
    expect(tiles()).toContain('How to Make a Killing');
  });

  it('the store catching up drops the mark laid over it', async () => {
    const store = makeStore();
    const { rerender } = show(store, NO_MOVIES_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: /^Mark How to Make a Killing as watched/ }));
    await waitFor(() => expect(posted('/api/movies/movie-467905/user')).toHaveLength(1));
    // The list now says watched: the page shows the list, so a later clear in the list wins.
    const watched = TITLES.map((t) => (t.id === 'movie-467905' ? { ...t, watched: true, state: 'finished' as const } : t));
    rerender({ ...store, titles: watched }, NO_MOVIES_ROUTE);
    rerender({ ...store, titles: TITLES }, NO_MOVIES_ROUTE);
    expect(tiles()).toContain('How to Make a Killing');
  });

  it('empty, failed and loading lists say so', () => {
    show(makeStore({ titles: [] }), NO_MOVIES_ROUTE);
    expect(screen.getByText(/^No titles yet\. notesd scans \/lib every few minutes/)).toBeTruthy();
    // With no grid, the controls are a toolbar of their own.
    expect(within(document.querySelector('.mv-tools') as HTMLElement).getByRole('button', { name: 'Rescan the library' })).toBeTruthy();
    cleanup();
    show(makeStore({ titles: null, listError: 'internal' }), NO_MOVIES_ROUTE);
    expect(screen.getByText('Could not load the movies library (internal).')).toBeTruthy();
    cleanup();
    show(makeStore({ titles: null }), NO_MOVIES_ROUTE);
    expect(screen.getByText('loading the library')).toBeTruthy();
  });

  it('movies off: the page says so and every control that would ask the daemon is off', () => {
    show(makeStore({ titles: null, listError: 'movies_off', status: null }), NO_MOVIES_ROUTE);
    expect(screen.getByText(MOVIES_OFF_TEXT)).toBeTruthy();
    for (const name of ['Library', 'Stream', 'Unmatched files', 'Rescan the library']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a VLC that lost its picture is named above the grid', () => {
    show(makeStore({ player: { ...PLAYING, current: { ...PLAYING.current!, video_stalled: true } } }), NO_MOVIES_ROUTE);
    expect(screen.getByRole('alert').textContent).toBe('VLC lost its picture at 45:10 (the graphics driver was reset). Close that VLC window and press Play again; /trace-vlc-bug has the evidence.');
  });
});

describe('MoviesPage: the Stream side', () => {
  it('the Cache icon and, beside it, the Stream health icon sit after Films and Series', () => {
    show(streamStore(), STREAM_ROUTE);
    expect(within(screen.getByRole('region', { name: 'Stream' })).getByRole('button', { name: 'Stream' }).getAttribute('aria-pressed')).toBe('true');
    const kinds = within(screen.getByRole('group', { name: 'Kind' })).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(kinds).toEqual(['All kinds', 'Films', 'Series', 'Cache', 'Stream health']);
    expect(screen.getByRole('button', { name: 'Stream health' }).getAttribute('data-tip')).toBe('Stream health: how plays went on this machine');
    expect(screen.getByRole('button', { name: 'Stream health' }).getAttribute('aria-pressed')).toBe('false');
    // The Stream side has interested filters and no gone pill; the Library's own buttons are not here.
    expect(pills()).toEqual(['all2', 'unwatched1', 'in progress1', 'finished0', 'interested0', 'not interested0']);
    expect(screen.queryByRole('button', { name: 'Rescan the library' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unmatched files' })).toBeNull();
  });

  it('the health icon opens /movies/health, lit there with Back to Stream; a second press goes back', () => {
    const { onRoute, rerender } = show(streamStore(), STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Stream health' }));
    expect(onRoute).toHaveBeenLastCalledWith(HEALTH_ROUTE);
    rerender(streamStore(), HEALTH_ROUTE);
    expect(screen.getByTestId('health-page')).toBeTruthy();
    const tools = within(document.querySelector('.mv-tools') as HTMLElement);
    expect(tools.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Library', 'Stream', 'Cache', 'Stream health', 'Back to Stream']);
    expect(tools.getByRole('button', { name: 'Stream health' }).getAttribute('aria-pressed')).toBe('true');
    expect(tools.getByRole('button', { name: 'Cache' }).getAttribute('aria-pressed')).toBe('false');
    // Neither the grid nor the sections under it are on the health page.
    expect(screen.queryByRole('region', { name: 'Trending' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Posters' })).toBeNull();
    fireEvent.click(tools.getByRole('button', { name: 'Stream health' }));
    expect(onRoute).toHaveBeenLastCalledWith(STREAM_ROUTE);
    fireEvent.click(tools.getByRole('button', { name: 'Cache' }));
    expect(onRoute).toHaveBeenLastCalledWith(CACHE_ROUTE);
    fireEvent.click(tools.getByRole('button', { name: 'Back to Stream' }));
    expect(onRoute).toHaveBeenLastCalledWith(STREAM_ROUTE);
    // A title the health page names opens on the Stream side.
    fireEvent.click(screen.getByTestId('health-page'));
    expect(onRoute).toHaveBeenLastCalledWith({ title: 'movie-550', unmatched: false, stream: true });
  });

  it('the Cache icon opens the Cache page, lit there; a second press goes back; a title there opens on the Stream side', () => {
    const { onRoute, rerender } = show(streamStore(), STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Cache' }));
    expect(onRoute).toHaveBeenLastCalledWith(CACHE_ROUTE);
    rerender(streamStore(), CACHE_ROUTE);
    expect(screen.getByTestId('cache-page')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cache' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Stream health' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Cache' }));
    expect(onRoute).toHaveBeenLastCalledWith(STREAM_ROUTE);
    fireEvent.click(screen.getByTestId('cache-page'));
    expect(onRoute).toHaveBeenLastCalledWith({ title: 'movie-550', unmatched: false, stream: true });
  });

  it('with no Stream grid (an empty list) the Cache and health icons are in the toolbar', () => {
    show(streamStore({ stream: { enabled: true, titles: [], fresh_days: 7, site_titles: [] } }), STREAM_ROUTE);
    const tools = within(document.querySelector('.mv-tools') as HTMLElement);
    expect(tools.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Library', 'Stream', 'Cache', 'Stream health']);
    // Trending is on, so the empty grid is a line above it, not the big empty state.
    expect(screen.getByText(streamEmptyText(7)).tagName).toBe('P');
    expect(screen.getByRole('region', { name: 'Trending' })).toBeTruthy();
  });

  it('on a title opened from Stream the toolbar has Cache, health and Back to Stream', () => {
    const { onRoute } = show(streamStore({ detail: FIGHT_CLUB }), { title: 'movie-550', unmatched: false, stream: true });
    const tools = within(document.querySelector('.mv-tools') as HTMLElement);
    expect(tools.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Library', 'Stream', 'Cache', 'Stream health', 'Back to Stream']);
    fireEvent.click(tools.getByRole('button', { name: 'Back to Stream' }));
    expect(onRoute).toHaveBeenLastCalledWith(STREAM_ROUTE);
  });

  it('movies off disables the Cache and health icons too', () => {
    show(streamStore({ titles: null, listError: 'movies_off', status: null }), STREAM_ROUTE);
    expect(screen.getByText(MOVIES_OFF_TEXT)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cache' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Stream health' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a poster opens the title on the Stream side, by its movie id', () => {
    const { onRoute } = show(streamStore(), STREAM_ROUTE);
    fireEvent.click(screen.getByRole('link', { name: /Fight Club/ }));
    expect(onRoute).toHaveBeenLastCalledWith({ title: 'M-FC55', unmatched: false, stream: true });
  });

  it('not interested takes a Stream poster off the grid at the click; it is under its own filter, with an undo', async () => {
    show(streamStore(), STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: /^Not interested in Fight Club/ }));
    expect(tiles()).toEqual(['How to Make a Killing']);
    await waitFor(() => expect(note()?.textContent).toBe('Fight Club: not interested, off the Stream gridundo'));
    expect(posted('/api/movies/movie-550/user')).toEqual([{ not_interested: true }]);
    fireEvent.click(screen.getByRole('button', { name: /^not interested/ }));
    expect(tiles()).toEqual(['Fight Club']);
  });

  it('interested puts a poster on the watch list: under interested, with its notice', async () => {
    show(streamStore(), STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: /^Interested in Fight Club/ }));
    await waitFor(() => expect(note()?.textContent).toBe("Fight Club: interested, on the Stream side's interested listundo"));
    fireEvent.click(screen.getByRole('button', { name: /^interested/ }));
    expect(tiles()).toEqual(['Fight Club']);
  });

  it('a stream list that failed, is loading, is off, or is empty with Trending off says so', () => {
    show(makeStore({ streamError: 'internal' }), STREAM_ROUTE);
    expect(screen.getByText('Could not load the movies library (internal).')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Trending' })).toBeNull();
    cleanup();
    show(makeStore(), STREAM_ROUTE);
    expect(screen.getByText('loading the Stream titles')).toBeTruthy();
    cleanup();
    const off: StreamListResponse = { enabled: false, reason: 'direct_stream_off', titles: [] };
    show(makeStore({ stream: off }), STREAM_ROUTE);
    expect(screen.getByText(STREAM_OFF_TEXT)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'From streaming sites' })).toBeNull();
    cleanup();
    show(makeStore({ stream: { enabled: true, titles: [], fresh_days: 3, site_titles: [] }, trending: { enabled: false, reason: 'setting_off', titles: [], listed_at: null } }), STREAM_ROUTE);
    expect(screen.getByText(streamEmptyText(3)).closest('.mv-off')).not.toBeNull();
  });
});

describe('MoviesPage: Trending and streaming-site titles', () => {
  it('a trending film plays from its torrent; a failure says so', async () => {
    show(streamStore(), STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Play Dune: Part Two from its torrent' }));
    await waitFor(() => expect(posted('/api/stream/play')).toEqual([{ kind: 'movie', tmdb_id: 693134, provider: 'torrent' }]));
    expect(note()?.textContent).toBe('Dune: Part Two: opening from its torrent');
    fails['POST /api/stream/play'] = { status: 404, error: 'no_source' };
    fireEvent.click(screen.getByRole('button', { name: 'Play Dune: Part Two from its torrent' }));
    await waitFor(() => expect(note()?.textContent).toBe('Dune: Part Two: could not play from its torrent (no_source)'));
  });

  it('the refresh icon builds the list again now and the page reads it every 5 s while it runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = streamStore();
    const { rerender } = show(store, STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Build the trending list again now' }));
    await waitFor(() => expect(note()?.textContent).toBe('building the trending list'));
    expect(posted('/api/movies/trending/refresh')).toEqual([{}]);
    const after = vi.mocked(store.refresh).mock.calls.length;
    const running = { ...store, trending: { ...TRENDING, running: true } };
    rerender(running, STREAM_ROUTE);
    act(() => vi.advanceTimersByTime(5000));
    expect(vi.mocked(store.refresh).mock.calls.length).toBe(after + 1);
    act(() => vi.advanceTimersByTime(5000));
    expect(vi.mocked(store.refresh).mock.calls.length).toBe(after + 2);
    rerender(store, STREAM_ROUTE);
    act(() => vi.advanceTimersByTime(15000));
    expect(vi.mocked(store.refresh).mock.calls.length).toBe(after + 2);
  });

  it('a refresh refused because the list is off says how to turn it on', async () => {
    fails['POST /api/movies/trending/refresh'] = { status: 503, error: 'trending_off' };
    show(streamStore(), STREAM_ROUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Build the trending list again now' }));
    await waitFor(() => expect(note()?.textContent).toBe('the trending list is off: set NOTESD_TRENDING=on and restart notesd'));
  });

  it('a site title plays its next episode on the site, or the last one again', async () => {
    answers['POST /api/movies/site-titles/7/play'] = { episode: 4 };
    show(streamStore({ stream: streamList([SUMMER]) }), STREAM_ROUTE);
    const sites = within(screen.getByRole('region', { name: 'From streaming sites' }));
    fireEvent.click(sites.getAllByRole('button', { name: 'Play episode 4 of Summer Vacation on Dramacool' })[0]!);
    await waitFor(() => expect(note()?.textContent).toBe('Summer Vacation: episode 4 is playing on dramacool in the streaming Chrome window'));
    fireEvent.click(sites.getByRole('button', { name: 'Play episode 3 of Summer Vacation again' }));
    await waitFor(() => expect(posted('/api/movies/site-titles/7/play')).toEqual([{}, { episode: 3 }]));
  });

  it('a site with no later episode says so; the cross takes a title off the list', async () => {
    fails['POST /api/movies/site-titles/7/play'] = { status: 404, error: 'no_episode' };
    const store = streamStore({ stream: streamList([SUMMER]) });
    show(store, STREAM_ROUTE);
    fireEvent.click(screen.getAllByRole('button', { name: 'Play episode 4 of Summer Vacation on Dramacool' })[0]!);
    await waitFor(() => expect(note()?.textContent).toBe('Summer Vacation: dramacool lists no later episode yet'));
    fireEvent.click(screen.getByRole('button', { name: 'Take Summer Vacation off this list' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/movies/site-titles/7')).toBe(true));
    fails['DELETE /api/movies/site-titles/7'] = { status: 500, error: 'internal' };
    fireEvent.click(screen.getByRole('button', { name: 'Take Summer Vacation off this list' }));
    await waitFor(() => expect(note()?.textContent).toBe('Summer Vacation: could not take it off the list (internal)'));
  });
});

describe("MoviesPage: a title's page", () => {
  it('waits for the title, says when it is not found, and shows it with the pill asking about it', () => {
    show(makeStore(), { title: 'movie-467905', unmatched: false });
    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Ask about How to Make a Killing')).toBeNull();
    cleanup();
    show(makeStore({ detailError: 'not_found' }), { title: 'M-ZZZZ', unmatched: false });
    expect(screen.getByText('No title M-ZZZZ in the library.')).toBeTruthy();
    cleanup();
    const { onRoute } = show(makeStore({ detail: MOVIE }), { title: 'M-23T4', unmatched: false });
    expect(screen.getByRole('article', { name: 'How to Make a Killing' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Ask about How to Make a Killing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the library' }));
    expect(onRoute).toHaveBeenLastCalledWith(NO_MOVIES_ROUTE);
  });

  it('a title no machine holds a file of is shown as the Stream side, even from the Library', () => {
    show(makeStore({ detail: { ...FIGHT_CLUB, stream_sources: [] } }), { title: 'movie-550', unmatched: false });
    // Library side, but nothing to show there: Play streams and the stream line says Play checks it.
    expect(document.querySelector('.mv-actions .mv-play')?.getAttribute('aria-label')).toBe('Stream: checked when it starts');
    expect(screen.getByTestId('stream-source').textContent).toBe('Stream: not verified yet; Play checks it');
    // The toolbar is still the Library's.
    expect(screen.getByRole('button', { name: 'Back to the library' })).toBeTruthy();
  });

  it('a character asks the chat with the title on the first line and the person for the Google icon', () => {
    const { onAsk } = show(makeStore({ detail: MOVIE }), { title: 'movie-467905', unmatched: false });
    fireEvent.click(screen.getByRole('button', { name: 'Julia' }));
    expect(onAsk).toHaveBeenCalledTimes(1);
    const [text, images, entity] = onAsk.mock.calls[0]!;
    expect(text).toBe('Who is Julia, played by Mara Example, in this film?');
    expect(images).toEqual([]);
    expect(entity).toEqual({ hint: 'person 4', search: expect.stringContaining('Julia') });
  });

  it('a mark the list has not caught up with holds across opening a title and coming back', () => {
    const store = streamStore({ stream: streamList([], [FIGHT_CLUB_ITEM, KILLING_ITEM]) });
    const { rerender } = show(store, STREAM_ROUTE);
    // The title played last is first, then the verified ones never played.
    expect(tiles()).toEqual(['How to Make a Killing', 'Fight Club']);
    fireEvent.click(screen.getByRole('button', { name: /^Mark Fight Club as watched/ }));
    expect(tiles()).toEqual(['How to Make a Killing']);
    rerender({ ...store, detail: FIGHT_CLUB }, { title: 'movie-550', unmatched: false, stream: true });
    rerender(store, STREAM_ROUTE);
    // The list has not caught up yet: the mark laid over it still holds.
    expect(tiles()).toEqual(['How to Make a Killing']);
  });
});
