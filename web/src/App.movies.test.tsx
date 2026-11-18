// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note } from './types';
import type { TitleListItem } from './moviesApi';
import { makeNote } from './testing/fixtures';
import { MOVIE, PLAYER_IDLE, PLAYING, SEARCH, SERIES, STATUS, TITLES, UNMATCHED } from './testing/movieFixtures';
import { MOVIES_OFF_TEXT } from './lib/movies';
import { App } from './App';

const notes: Note[] = [makeNote('A-B32', 'buy fennel #kitchen', { created: new Date().toISOString() })];
const CHAT_SSE =
  'event: delta\ndata: {"text":"Watch MobLand next."}\n\n' +
  'event: done\ndata: {"thread_id":"T-1","user_message_id":"Q001","assistant_message_id":"A001","reply_to":null,"brain":"claude"}\n\n';

const CHAT_SSE_IDS =
  'event: delta\ndata: {"text":"Next up is M-0S12 of MobLand."}\n\n' +
  'event: done\ndata: {"thread_id":"T-1","user_message_id":"Q001","assistant_message_id":"A001","reply_to":null,"brain":"claude"}\n\n';
let chatSse: string;

const guideTitle = (over: Record<string, unknown>) => ({ kind: 'movie', tmdb_id: 1, title_id: 'movie-1', title: 'T', year: 2020, release_date: '2020-01-01', poster_url: null, note: null, movie_id: null, mark: null, has_file: false, ...over });
const PERSON_GUIDE = {
  entity: { kind: 'person', name: 'Mara Example', image_url: 'https://img.test/mara.jpg', description: 'An actor.', facts: ['Acting'], link: 'https://www.themoviedb.org/person/4' },
  titles: [
    guideTitle({ tmdb_id: 467905, title_id: 'movie-467905', title: 'How to Make a Killing', year: 2026, note: 'as Julia', movie_id: 'M-23T4', mark: 'started', has_file: true }),
    guideTitle({ tmdb_id: 900, title_id: 'movie-900', title: 'Older Film', year: 2019, note: 'as Ann', mark: 'watched', movie_id: 'M-9AAA' }),
    guideTitle({ tmdb_id: 901, title_id: 'movie-901', title: 'Skipped Film', year: 2018, mark: 'not_interested', movie_id: 'M-9AAB' }),
    guideTitle({ tmdb_id: 902, title_id: 'movie-902', title: 'Unknown Film', year: 2017 }),
  ],
};
const COMPANY_GUIDE = { entity: { kind: 'company', name: 'Blumhouse Productions', image_url: null, description: '', facts: ['US'], link: null }, titles: [guideTitle({ title: 'Studio Film' })] };
const GENRE_GUIDE = { entity: { kind: 'genre', name: 'Crime', image_url: null, description: 'A con that curdles.', facts: [], link: null }, titles: [guideTitle({ title: 'Close Cousin', note: 'the same cold humour' })], written_at: '2026-11-18T00:00:00.000Z', model: 'sonnet' };
/** The stored Crime guide; null until the first POST writes it. */
let genreStored: typeof GENRE_GUIDE | null;

let calls: string[];
let posts: { url: string; body: Record<string, unknown> | null }[];
let off: boolean;
let titles: TitleListItem[];
let player: typeof PLAYER_IDLE;
let alreadyPlaying: boolean;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  posts = [];
  off = false;
  titles = TITLES;
  player = PLAYER_IDLE;
  alreadyPlaying = false;
  chatSse = CHAT_SSE;
  genreStored = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'POST') posts.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (method === 'POST' && url === '/api/chat') return new Response(chatSse, { headers: { 'content-type': 'text/event-stream' } });
      if (url.startsWith('/api/movies') && off) return json({ error: 'movies_off', message: 'off' }, 503);
      if (url === '/api/movies') return json({ titles });
      if (url === '/api/movies/status') return json(STATUS);
      if (url === '/api/movies/player') return json(player);
      if (url === '/api/movies/unmatched') return json({ files: UNMATCHED });
      if (url.startsWith('/api/movies/search-tmdb?')) return json({ results: SEARCH });
      if (url === '/api/movies/movie-467905' || url === '/api/movies/M-23T4') return json(MOVIE);
      if (url === '/api/movies/tv-247718' || url === '/api/movies/M-0S12' || url === '/api/movies/M-8TR4') return json(SERIES);
      if (url === '/api/movies/people/4') return json(PERSON_GUIDE);
      if (url === '/api/movies/companies/3172') return json(COMPANY_GUIDE);
      if (url === '/api/movies/movie-467905/genres/Crime') {
        if (method === 'POST') genreStored = GENRE_GUIDE;
        return json({ guide: genreStored, cached: method !== 'POST' });
      }
      if (method === 'POST' && url === '/api/movies/ensure') return json({ title_id: 'movie-902', movie_id: 'M-23T4' });
      if (url === '/api/movies/movie-467905/pahe') return json({ matches: [{ title: 'How to Make a Killing (2026) WEB-DL', url: 'https://pahe.ink/how-to-make-a-killing', year: 2026, release: 'WEB-DL' }], search_url: 'https://pahe.ink/?s=x' });
      if (method === 'POST' && url === '/api/movies/files/32/assign') return json({ file_id: 32, title: { ...MOVIE, id: 'movie-1125510', title: 'Ne Zha 2' } });
      if (method === 'POST' && url === '/api/movies/continue' && alreadyPlaying) return json({ action: 'already_playing', title: { id: 'movie-467905', title: 'How to Make a Killing', kind: 'movie', year: 2026 }, file: { file_id: 11, season: null, episode: null, absolute_episode: null, name: null }, position: 2710, play: { already_playing: true } });
      if (method === 'POST' && /^\/api\/movies\/files\/\d+\/play$/.test(url) && alreadyPlaying) return json({ ok: true, play: { already_playing: true } }, 202);
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
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
const tiles = () => within(screen.getByRole('list', { name: 'Posters' })).getAllByRole('listitem');
const postsTo = (url: string) => posts.filter((p) => p.url === url).map((p) => p.body);

describe('App: Movies', () => {
  it('R5.1: the film-slate icon opens /movies with one poster per title; a second press returns to the wall', async () => {
    render(<App />);
    expect(calls.some((c) => c.includes('/api/movies'))).toBe(false);
    fireEvent.click(within(rail()).getByRole('button', { name: 'Movies' }));
    await waitFor(() => expect(where()).toBe('/movies'));
    expect(h1()).toBe('Movies.');
    await screen.findByRole('list', { name: 'Posters' });
    expect(tiles().map((t) => t.querySelector('a')?.getAttribute('data-title'))).toEqual(['M-23T4', 'M-8TR4', 'movie-9001']);
    const poster = screen.getByRole('img', { name: 'How to Make a Killing' });
    expect(poster.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/kill.jpg');
    expect(poster.getAttribute('loading')).toBe('lazy');
    expect(screen.getByRole('img', { name: 'MobLand (no poster)' })).toBeTruthy();
    expect(document.querySelector('.mv-tile.gone')?.getAttribute('data-title')).toBe('movie-9001');
    await screen.findByText(/3 titles: 2 films, 1 series\. 2 in progress\./);
    // The page's own pill replaces the wall chat bar.
    expect(screen.getByPlaceholderText('Ask about your movies')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Ask about your notes')).toBeNull();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Movies' }));
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('the filter row narrows the grid by state, kind and text', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('button', { name: /^gone/ }));
    expect(tiles()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^all/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Series' }));
    expect(tiles().map((t) => t.textContent)).toEqual([expect.stringContaining('MobLand')]);
    fireEvent.click(screen.getByRole('button', { name: 'All kinds' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'killing' } });
    expect(tiles()).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches this filter.')).toBeTruthy();
  });

  it('R5.2: a poster opens the detail with date, synopsis, studios, crew, cast, play, watched, stars and review', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('link', { name: /How to Make a Killing/ }));
    await waitFor(() => expect(where()).toBe('/movies/M-23T4'));
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    expect(h1()).toBe('How to Make a Killing.');
    const a = within(article);
    expect(a.getByText('Released Feb 20, 2026')).toBeTruthy();
    expect(a.getByText('A disinherited heir plots his way back into the family fortune.')).toBeTruthy();
    const credits = within(article.querySelector('dl.mv-credits') as HTMLElement);
    expect(credits.getByText('Blumhouse Productions')).toBeTruthy();
    expect(credits.getAllByText('Ava Director')).toHaveLength(2);
    expect(credits.getByText('Pat Producer')).toBeTruthy();
    const cast = within(a.getByRole('region', { name: 'Cast' }));
    expect(cast.getByText('Glen Example')).toBeTruthy();
    expect(cast.getByText('Becket')).toBeTruthy();
    expect((a.getByRole('button', { name: 'Resume at 45:00' }) as HTMLButtonElement).disabled).toBe(false);
    expect(a.getByRole('button', { name: 'Mark as watched' })).toBeTruthy();
    expect(a.getAllByRole('button', { name: /^Rate \d of 5$/ })).toHaveLength(5);
    expect(a.getByRole('textbox', { name: 'Review' })).toBeTruthy();
  });

  it('a VLC that plays without video is named on the grid and on its title, and not while it plays fine', async () => {
    player = { ...PLAYING, current: { ...PLAYING.current!, video_stalled: true } };
    at('/movies');
    const first = render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('VLC lost its picture at 45:10');
    expect(alert.textContent).toContain('Close that VLC window and press Play again');
    fireEvent.click(screen.getByRole('link', { name: /How to Make a Killing/ }));
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    expect(within(article).getByText(/no picture in VLC/)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    first.unmount();

    player = PLAYING;
    at('/movies/M-23T4');
    render(<App />);
    const fine = await screen.findByRole('article', { name: 'How to Make a Killing' });
    await waitFor(() => expect(within(fine).getByText(/playing in VLC/)).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the poster of the title in the followed VLC says playing, paused or no picture; other posters keep their state chip', async () => {
    player = PLAYING;
    at('/movies');
    const first = render(<App />);
    const list = await screen.findByRole('list', { name: 'Posters' });
    const now = await within(list).findByRole('status', { name: 'How to Make a Killing: playing in VLC' });
    expect(now.textContent).toBe('playing');
    expect(now.closest('a')!.className).toBe('mv-tile now playing');
    expect(within(list).getAllByRole('status')).toHaveLength(1);
    first.unmount();

    player = { ...PLAYING, current: { ...PLAYING.current!, state: 'paused' } };
    const second = render(<App />);
    expect((await screen.findByRole('status', { name: 'How to Make a Killing: paused in VLC' })).closest('a')!.className).toBe('mv-tile now paused');
    second.unmount();

    player = { ...PLAYING, current: { ...PLAYING.current!, video_stalled: true } };
    const third = render(<App />);
    expect((await screen.findByRole('status', { name: 'How to Make a Killing: no picture in VLC' })).closest('a')!.className).toBe('mv-tile now stalled');
    third.unmount();

    player = { ...PLAYING, current: { ...PLAYING.current!, state: 'stopped' } };
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    expect(screen.queryByRole('status', { name: /in VLC$/ })).toBeNull();
  });

  it('the title page shows the same state: a framed poster with the chip, and playing / paused / no picture beside Play', async () => {
    const cases = [
      [PLAYING, 'playing', 'playing in VLC · 45:10 / 1:52:00'],
      [{ ...PLAYING, current: { ...PLAYING.current!, state: 'paused' as const } }, 'paused', 'paused in VLC · 45:10 / 1:52:00'],
      [{ ...PLAYING, current: { ...PLAYING.current!, video_stalled: true } }, 'stalled', 'no picture in VLC · 45:10 / 1:52:00'],
    ] as const;
    for (const [state, cls, line] of cases) {
      player = state;
      at('/movies/M-23T4');
      const view = render(<App />);
      const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
      const status = await within(article).findByRole('status');
      expect(status.textContent).toBe(line);
      expect(status.className).toBe(`mv-live ${cls}`);
      const art = article.querySelector('.mv-detail-art') as HTMLElement;
      expect(art.className).toBe(`mv-detail-art now ${cls}`);
      expect(art.querySelector('.mv-now')!.textContent).toBe(cls === 'stalled' ? 'no picture' : cls);
      view.unmount();
    }
    player = PLAYER_IDLE;
    at('/movies/M-23T4');
    render(<App />);
    const idle = await screen.findByRole('article', { name: 'How to Make a Killing' });
    expect(within(idle).queryByRole('status')).toBeNull();
    expect((idle.querySelector('.mv-detail-art') as HTMLElement).className).toBe('mv-detail-art');
  });

  it('Play on a file that is already open in VLC says so instead of "resuming"', async () => {
    at('/movies/M-23T4');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    alreadyPlaying = true;
    fireEvent.click(within(article).getByRole('button', { name: 'Resume at 45:00' }));
    expect(await screen.findByText('already open in VLC: brought to the front')).toBeTruthy();
  });

  it('a library poster carries the watched flag only; on a series it says every season', async () => {
    window.history.replaceState(null, '', '/movies');
    render(<App />);
    const btn = await screen.findByRole('button', { name: 'Mark MobLand as watched' });
    expect(within(btn.closest('.mv-cell') as HTMLElement).queryByRole('button', { name: /^Not interested/ })).toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(postsTo('/api/movies/tv-247718/user')).toEqual([{ watched: true }]));
    // It leaves the grid at the click and shows under `finished`.
    expect(screen.queryByRole('button', { name: 'MobLand: watched (click to unmark)' })).toBeNull();
    expect(await screen.findByText('MobLand: watched, every season, under finished')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^finished/ }));
    expect(screen.getByRole('button', { name: 'MobLand: watched (click to unmark)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    await waitFor(() => expect(postsTo('/api/movies/tv-247718/user')).toEqual([{ watched: true }, { watched: false }]));
  });

  it('play, watched, stars and review write through the API', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const a = within(await screen.findByRole('article', { name: 'How to Make a Killing' }));
    fireEvent.click(a.getByRole('button', { name: 'Resume at 45:00' }));
    await waitFor(() => expect(postsTo('/api/movies/files/11/play')).toHaveLength(1));
    await screen.findByText('resuming at 45:00');
    fireEvent.click(a.getByRole('button', { name: 'Mark as watched' }));
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/user')).toContainEqual({ watched: true }));
    fireEvent.click(a.getByRole('button', { name: 'Rate 4 of 5' }));
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/user')).toContainEqual({ rating: 4 }));
    const review = a.getByRole('textbox', { name: 'Review' });
    fireEvent.focus(review);
    fireEvent.change(review, { target: { value: 'Sharp and mean.' } });
    expect(postsTo('/api/movies/movie-467905/user')).not.toContainEqual({ review: 'Sharp and mean.' });
    fireEvent.blur(review);
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/user')).toContainEqual({ review: 'Sharp and mean.' }));
    const n = postsTo('/api/movies/movie-467905/user').length;
    fireEvent.focus(review);
    fireEvent.blur(review);
    await new Promise((r) => setTimeout(r, 20));
    expect(postsTo('/api/movies/movie-467905/user').length).toBe(n);
  });

  it('the trailer icon plays the trailer TMDB lists in a pop-up; Esc closes it and the page stays', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(article).getByRole('button', { name: 'Watch the trailer' }));
    const dialog = screen.getByRole('dialog', { name: 'Trailer of How to Make a Killing (2026)' });
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/BxBof_p3_es?autoplay=1&rel=0');
    expect(within(dialog).getByRole('link', { name: 'Open on YouTube' }).getAttribute('href')).toBe('https://www.youtube.com/watch?v=BxBof_p3_es');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('article', { name: 'How to Make a Killing' })).toBeTruthy();
  });

  it('a title without a trailer searches YouTube in a new tab; a season plays its own trailer', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    at('/movies/tv-247718');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'MobLand' });
    fireEvent.click(within(article).getByRole('button', { name: 'Find the trailer on YouTube' }));
    expect(open).toHaveBeenCalledWith('https://www.youtube.com/results?search_query=MobLand%202025%20trailer', '_blank', 'noopener');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(within(article).getByRole('button', { name: 'Watch the season 1 trailer' }));
    const dialog = screen.getByRole('dialog', { name: 'Trailer of MobLand, season 1' });
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toContain('/embed/moblandS1tr?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('R5.2 + R5.3: a series lists episodes with progress, a deleted flag and an on-another-machine flag', async () => {
    at('/movies/tv-247718');
    render(<App />);
    const eps = await screen.findByRole('region', { name: 'Episodes' });
    const row = (code: string) => eps.querySelector(`[data-episode="${code}"]`) as HTMLElement;
    expect(row('S01E01').textContent).toContain('deleted');
    expect(row('S01E01').className).toBe('mv-row del');
    expect((within(row('S01E01')).getByRole('button', { name: 'S01E01 is deleted' }) as HTMLButtonElement).disabled).toBe(true);
    expect(row('S01E02').textContent).toContain('in progress · 40%');
    expect((within(row('S01E02')).getByRole('button', { name: 'Resume S01E02 at 20:00' }) as HTMLButtonElement).disabled).toBe(false);
    expect(row('S01E03').textContent).toContain('on gpd');
    expect((within(row('S01E03')).getByRole('button', { name: 'S01E03 is on gpd' }) as HTMLButtonElement).disabled).toBe(true);
    expect(row('S01E04').className).toBe('mv-row none');
    expect(eps.querySelector('[data-episode="S02E01"]')).toBeNull();
    expect(within(eps).getByText('1 more season has no file on any machine.')).toBeTruthy();
    fireEvent.click(within(row('S01E02')).getByRole('button', { name: 'Mark S01E02 watched' }));
    await waitFor(() => expect(postsTo('/api/movies/files/22/watched')).toContainEqual({ watched: true }));
  });

  it('R5.4: the pill sends to the wall chat with the page and the open title on the first line; the answer panel shows', async () => {
    at('/movies/movie-467905');
    render(<App />);
    await screen.findByRole('article', { name: 'How to Make a Killing' });
    expect(screen.queryByPlaceholderText('Ask about your notes')).toBeNull();
    const box = screen.getByPlaceholderText('Ask about How to Make a Killing');
    fireEvent.change(box, { target: { value: 'what should I watch after this?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() => expect(postsTo('/api/chat')).toHaveLength(1));
    const message = String(postsTo('/api/chat')[0]?.message ?? '');
    expect(message.split('\n')[0]).toBe('[Movies · How to Make a Killing (2026) · M-23T4 · at 45:00 of 1:52:00]');
    expect(message.split('\n').slice(1).join('\n')).toBe('what should I watch after this?');
    await screen.findByText('Watch MobLand next.');
    expect(screen.queryByRole('link', { name: 'Search Google' })).toBeNull();
  });

  it('the first line says where the owner is now: the followed VLC read at the moment of asking, not the page\'s older reading', async () => {
    at('/movies/movie-467905');
    render(<App />);
    await screen.findByRole('article', { name: 'How to Make a Killing' });
    player = { ...PLAYING, current: { ...PLAYING.current!, position: 2715, state: 'paused' } };
    const box = screen.getByPlaceholderText('Ask about How to Make a Killing');
    fireEvent.change(box, { target: { value: 'who is Becket?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() => expect(postsTo('/api/chat')).toHaveLength(1));
    expect(String(postsTo('/api/chat')[0]?.message).split('\n')[0]).toBe('[Movies · How to Make a Killing (2026) · M-23T4 · at 45:15 of 1:52:00]');
  });

  it('a person, a studio and a genre on the title page open their pop-up with their titles tagged; a character asks the chat', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    const a = within(article);
    const sent = () => postsTo('/api/chat').map((p) => String(p?.message));

    fireEvent.click(within(a.getByRole('region', { name: 'Cast' })).getByRole('button', { name: 'Mara Example' }));
    const person = within(await screen.findByRole('dialog', { name: 'About Mara Example' }));
    await person.findByText('An actor.');
    expect(sent()).toHaveLength(0);
    expect(person.getByRole('status').textContent).toBe('4 titles · 1 watched · 1 started · 1 not interested · newest first');
    const rows = person.getAllByTestId('guide-title');
    expect(rows.map((r) => r.dataset.mark ?? null)).toEqual(['started', 'watched', 'not_interested', null]);
    expect(within(rows[0]!).getByText('file here')).toBeTruthy();
    expect(within(rows[1]!).getByText('watched')).toBeTruthy();
    expect(within(rows[2]!).getByText('not interested')).toBeTruthy();
    expect(within(rows[1]!).getByText('2019 · as Ann')).toBeTruthy();

    // A stored title opens the movie pop-up over this one; Esc closes that one only.
    fireEvent.click(rows[1]!);
    await screen.findByRole('dialog', { name: 'Movie M-9AAA' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Movie M-9AAA' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'About Mara Example' })).toBeTruthy();

    // A title the library does not hold is stored first, then opened.
    fireEvent.click(rows[3]!);
    await waitFor(() => expect(postsTo('/api/movies/ensure')).toEqual([{ kind: 'movie', tmdb_id: 902 }]));
    await screen.findByRole('dialog', { name: 'Movie M-23T4' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Movie M-23T4' })).toBeNull());

    // The chat icon sends the question the name used to ask, and closes the pop-up.
    fireEvent.click(person.getByRole('button', { name: 'Ask the chat about Mara Example' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toBe(
      '[Movies · How to Make a Killing (2026) · M-23T4 · at 45:00 of 1:52:00 · person 4]\nTell me about Mara Example (Julia in this film) and list their other films and series. Mark the ones in my library.',
    );
    expect(screen.queryByRole('dialog', { name: 'About Mara Example' })).toBeNull();
    await screen.findByText('Watch MobLand next.');
    const google = await screen.findByRole('link', { name: 'Search Google' });
    expect(google.getAttribute('href')).toBe('https://www.google.com/search?q=Mara%20Example%20movies%20and%20series');

    fireEvent.click(a.getByRole('button', { name: 'Julia' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]!.split('\n')[1]).toBe('Who is Julia, played by Mara Example, in this film?');
    expect(sent()[1]!.split('\n')[0]).toContain('· person 4]');

    fireEvent.click(a.getByRole('button', { name: 'Blumhouse Productions' }));
    const studio = within(await screen.findByRole('dialog', { name: 'About Blumhouse Productions' }));
    await studio.findAllByText('Studio Film');
    expect(studio.queryByTestId('entity-description')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'About Blumhouse Productions' })).toBeNull());
    expect(sent()).toHaveLength(2);
  });

  it('a genre is collated once for the title, then read from the store', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    fireEvent.click(within(article).getByRole('button', { name: 'Crime' }));
    const first = within(await screen.findByRole('dialog', { name: 'About Crime' }));
    await first.findByText('A con that curdles.');
    expect(first.getByText('genre · for How to Make a Killing')).toBeTruthy();
    expect(first.getByText('2020 · the same cold humour')).toBeTruthy();
    expect(postsTo('/api/movies/movie-467905/genres/Crime')).toEqual([{}]);
    fireEvent.click(first.getByRole('button', { name: 'Close' }));

    fireEvent.click(within(article).getByRole('button', { name: 'Crime' }));
    await within(await screen.findByRole('dialog', { name: 'About Crime' })).findByText('A con that curdles.');
    expect(postsTo('/api/movies/movie-467905/genres/Crime')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Rewrite this guide' }));
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/genres/Crime')).toEqual([{}, { refresh: true }]));
    expect(postsTo('/api/chat')).toHaveLength(0);
  });

  it('the play menu names the source: the file, a cloud stream, a torrent, a site; without a file, pahe', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    const openMenu = () => fireEvent.click(within(article).getByRole('button', { name: 'Choose how to play How to Make a Killing' }));
    openMenu();
    const menu = within(screen.getByRole('menu', { name: 'Play How to Make a Killing from' }));
    expect(menu.getAllByRole('menuitem').map((m) => m.dataset.method)).toEqual(['file', 'cloud', 'torrent', 'idlix', 'lk21', 'flicksy', 'dramacool']);
    fireEvent.click(menu.getByRole('menuitem', { name: /^Torrent stream/ }));
    await waitFor(() => expect(postsTo('/api/stream/play')).toEqual([{ kind: 'movie', tmdb_id: 467905, provider: 'torrent' }]));
    expect(screen.queryByRole('menu')).toBeNull();

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Non Torrent stream/ }));
    await waitFor(() => expect(postsTo('/api/stream/play')).toHaveLength(2));
    expect(postsTo('/api/stream/play')[1]).toEqual({ kind: 'movie', tmdb_id: 467905, provider: 'cloud' });

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Lk21/ }));
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/site-play')).toEqual([{ site: 'lk21' }]));

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Downloaded file/ }));
    await waitFor(() => expect(postsTo('/api/movies/files/11/play')).toHaveLength(1));
  });

  it('a play chosen in the menu says what the daemon is doing while it starts, then its outcome', async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/stream/play') {
          posts.push({ url: '/api/stream/play', body: JSON.parse(String(init?.body)) as Record<string, unknown> });
          await hold;
          return json({ ok: true });
        }
        return real(input, init);
      }),
    );
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    fireEvent.click(within(article).getByRole('button', { name: 'Choose how to play How to Make a Killing' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Torrent stream/ }));
    // At once, before the daemon names a stage.
    expect((await within(article).findByTestId('play-progress')).textContent).toBe('asking the torrents');
    player = { ...PLAYER_IDLE, starting: [{ kind: 'movie', tmdb_id: 467905, season: null, episode: null, title: 'How to Make a Killing', provider: 'torrent', since: new Date().toISOString(), stage: 'opening 3 torrents' }] };
    await waitFor(() => expect(within(article).getByTestId('play-progress').textContent).toMatch(/^opening 3 torrents/), { timeout: 4000 });
    // Another title's play is not this one's.
    player = { ...PLAYER_IDLE, starting: [{ kind: 'movie', tmdb_id: 1, season: null, episode: null, title: 'Other', provider: null, since: new Date().toISOString(), stage: 'asking the cloud providers' }] };
    await new Promise((r) => setTimeout(r, 1200));
    expect(within(article).getByTestId('play-progress').textContent).toMatch(/^opening 3 torrents · \d+ s$/);
    release();
    await waitFor(() => expect(within(article).queryByTestId('play-progress')).toBeNull());
    await screen.findByText('opening in the streaming Chrome, from a torrent');
  });

  it('on a title page, reaching for the page folds the answer panel to its header; the panel itself, the pill and a pinned panel do not', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    const panel = () => document.querySelector('.answer') as HTMLElement;
    fireEvent.click(within(article).getByRole('button', { name: 'Julia' }));
    await screen.findByText('Watch MobLand next.');
    expect(panel().className).toBe('answer');

    fireEvent.pointerDown(screen.getByText('Watch MobLand next.'));
    fireEvent.wheel(panel());
    fireEvent.pointerDown(screen.getByPlaceholderText('Ask about How to Make a Killing'));
    expect(panel().className).toBe('answer');

    fireEvent.wheel(article);
    await waitFor(() => expect(panel().className).toBe('answer collapsed'));
    fireEvent.pointerDown(article);
    expect(panel().className).toBe('answer collapsed');

    fireEvent.click(within(article).getByRole('button', { name: 'Becket' }));
    await waitFor(() => expect(panel().className).toBe('answer'));
    await screen.findByText('Watch MobLand next.');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    fireEvent.pointerDown(article);
    fireEvent.wheel(article);
    expect(panel().className).toBe('answer');
    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    fireEvent.pointerDown(article);
    await waitFor(() => expect(panel().className).toBe('answer collapsed'));
  });

  it('the answer panel does not fold on the grid', async () => {
    at('/movies');
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Posters' });
    const box = screen.getByPlaceholderText('Ask about your movies');
    fireEvent.change(box, { target: { value: 'what next?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await screen.findByText('Watch MobLand next.');
    fireEvent.pointerDown(list);
    fireEvent.wheel(list);
    expect((document.querySelector('.answer') as HTMLElement).className).toBe('answer');
  });

  it('character links wait while an answer is still streaming; a name still opens its pop-up, without its chat icon', async () => {
    chatSse = 'event: accepted\ndata: {"thread_id":"t1"}\n\nevent: delta\ndata: {"text":"Thinking"}\n\n';
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/chat') {
          posts.push({ url: '/api/chat', body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
          const enc = new TextEncoder();
          return new Response(
            new ReadableStream({
              async start(c) {
                c.enqueue(enc.encode(chatSse));
                await hold;
                c.enqueue(enc.encode('event: done\ndata: {}\n\n'));
                c.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return real(input, init);
      }),
    );
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    const crime = within(article).getByRole('button', { name: 'Julia' }) as HTMLButtonElement;
    fireEvent.click(crime);
    await screen.findByText(/Thinking/);
    expect(crime.disabled).toBe(true);
    fireEvent.click(within(article).getByRole('button', { name: 'Becket' }));
    expect(postsTo('/api/chat')).toHaveLength(1);
    fireEvent.click(within(article).getByRole('button', { name: 'Blumhouse Productions' }));
    const studio = within(await screen.findByRole('dialog', { name: 'About Blumhouse Productions' }));
    await studio.findAllByText('Studio Film');
    expect(studio.queryByRole('button', { name: /Ask the chat/ })).toBeNull();
    fireEvent.click(studio.getByRole('button', { name: 'Close' }));
    release();
    await waitFor(() => expect(crime.disabled).toBe(false));
  });

  it('a movie id in a chat answer opens the pop-up: the episode, Play, and the page scrolled to it', async () => {
    chatSse = CHAT_SSE_IDS;
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    const box = screen.getByPlaceholderText('Ask about your movies');
    fireEvent.change(box, { target: { value: 'what next?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    const link = await screen.findByRole('link', { name: 'M-0S12' });
    expect(link.getAttribute('href')).toBe('/movies/M-0S12');
    fireEvent.click(link);
    const dialog = await screen.findByRole('dialog', { name: 'Movie M-0S12' });
    await within(dialog).findByRole('heading', { name: 'Episode Two' });
    expect(within(dialog).getByText('MobLand (2025)')).toBeTruthy();
    const e2 = SERIES.seasons[0]!.episodes[1]!;
    fireEvent.click(dialog.querySelector('.mm-actions button') as HTMLButtonElement);
    await waitFor(() => expect(postsTo(`/api/movies/files/${e2.file_id}/play`)).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the page at S01E02' }));
    await waitFor(() => expect(where()).toBe('/movies/M-0S12'));
    expect(screen.queryByRole('dialog', { name: 'Movie M-0S12' })).toBeNull();
    await screen.findByRole('article', { name: 'MobLand' });
    const row = document.querySelector('[data-movie-id="M-0S12"]') as HTMLElement;
    expect(row.dataset.focused).toBe('true');
    expect(row.dataset.episode).toBe('S01E02');
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(h1()).toBe('MobLand.');
  });

  it('the pop-up follows the play: outline and badge on the poster, the position beside Play, moving every 5 s', async () => {
    chatSse = CHAT_SSE_IDS;
    const e2 = SERIES.seasons[0]!.episodes[1]!;
    const onE2 = (position: number, state: 'playing' | 'paused' = 'playing') => ({ ...PLAYING, current: { ...PLAYING.current!, title_id: SERIES.id, file_id: e2.file_id!, position, state } });
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    const box = screen.getByPlaceholderText('Ask about your movies');
    fireEvent.change(box, { target: { value: 'what next?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    fireEvent.click(await screen.findByRole('link', { name: 'M-0S12' }));
    const dialog = await screen.findByRole('dialog', { name: 'Movie M-0S12' });
    await within(dialog).findByRole('heading', { name: 'Episode Two' });
    expect(dialog.querySelector('.mm-art')!.className).toBe('mm-art');
    expect(dialog.querySelector('.mv-live')).toBeNull();
    // Another episode of the series in VLC does not mark this one.
    player = { ...onE2(10), current: { ...onE2(10).current, file_id: SERIES.seasons[0]!.episodes[0]!.file_id! } };
    fireEvent.click(dialog.querySelector('.mm-actions button') as HTMLButtonElement);
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/movies/player').length).toBeGreaterThan(2));
    expect(dialog.querySelector('.mm-art')!.className).toBe('mm-art');
    // This episode in VLC: the mark, and the position moves with the 5 s poll.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      player = onE2(60);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      await waitFor(() => expect(dialog.querySelector('.mm-art')!.className).toBe('mm-art now playing'));
      expect(dialog.querySelector('.mv-now')!.textContent).toBe('playing');
      expect(dialog.querySelector('.mv-live')!.textContent).toBe('playing in VLC · 1:00 / 1:52:00');
      player = onE2(65, 'paused');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      await waitFor(() => expect(dialog.querySelector('.mv-live')!.textContent).toBe('paused in VLC · 1:05 / 1:52:00'));
      expect(dialog.querySelector('.mm-art')!.className).toBe('mm-art now paused');
    } finally {
      vi.useRealTimers();
    }
  });

  it('R5.5: the unmatched list shows each file with its reason and assigns a TMDB title', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('button', { name: /^Unmatched files/ }));
    await waitFor(() => expect(where()).toBe('/movies/unmatched'));
    expect(h1()).toBe('Unmatched.');
    const list = await screen.findByRole('region', { name: 'Unmatched files' });
    expect(within(list).getByText('shorter than 15 minutes')).toBeTruthy();
    expect(within(list).getByText('TMDB match not confident')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Assign a title to Ne.Zha.2.2025.1080p.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign a title to Ne.Zha.2.2025.1080p.mkv' });
    expect((within(dialog).getByRole('textbox', { name: 'Search TMDB' }) as HTMLInputElement).value).toBe('Ne Zha 2');
    await waitFor(() => expect(calls).toContain('GET /api/movies/search-tmdb?q=Ne%20Zha%202&kind=movie'));
    fireEvent.click(await within(dialog).findByRole('option', { name: /Ne Zha 2/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(postsTo('/api/movies/files/32/assign')).toEqual([{ kind: 'movie', tmdb_id: 1125510 }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByText('assigned to Ne Zha 2');
  });

  it('Esc closes the assign dialog without leaving the page', async () => {
    at('/movies/unmatched');
    render(<App />);
    const list = await screen.findByRole('region', { name: 'Unmatched files' });
    fireEvent.click(within(list).getByRole('button', { name: 'Assign a title to clip-0412.mp4' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(where()).toBe('/movies/unmatched');
  });

  it('503 movies_off: the page says the subsystem is off', async () => {
    off = true;
    at('/movies');
    render(<App />);
    await screen.findByText(MOVIES_OFF_TEXT);
    expect(document.querySelector('.hdr-p')?.textContent).toContain('Movies are off on this daemon.');
    expect((screen.getByRole('button', { name: /^Unmatched files/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByPlaceholderText('Ask about your movies')).toBeTruthy();
  });

  it('an empty library says where notesd looks', async () => {
    titles = [];
    at('/movies');
    render(<App />);
    await waitFor(() => expect(document.querySelector('.mv-off')?.textContent).toContain('notesd scans /lib'));
  });

  it('Back and forward move between the grid, a title and the wall', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('link', { name: /MobLand/ }));
    await waitFor(() => expect(where()).toBe('/movies/M-8TR4'));
    await screen.findByRole('region', { name: 'Episodes' });
    pop('/movies');
    await screen.findByRole('list', { name: 'Posters' });
    expect(h1()).toBe('Movies.');
    pop('/');
    await waitFor(() => expect(h1()).not.toBe('Movies.'));
    expect(screen.getByPlaceholderText('Ask about your notes')).toBeTruthy();
    pop('/movies/movie-467905');
    await screen.findByRole('article', { name: 'How to Make a Killing' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to the library' }));
    await waitFor(() => expect(where()).toBe('/movies'));
  });
});
