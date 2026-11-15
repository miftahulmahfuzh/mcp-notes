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

  it('a person, a studio, a character and a genre on the title page each ask about themselves in one click, with a Google icon under the answer', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    const a = within(article);
    const sent = () => postsTo('/api/chat').map((p) => String(p?.message));

    fireEvent.click(within(a.getByRole('region', { name: 'Cast' })).getByRole('button', { name: 'Mara Example' }));
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toBe(
      '[Movies · How to Make a Killing (2026) · M-23T4 · at 45:00 of 1:52:00 · person 4]\nTell me about Mara Example (Julia in this film) and list their other films and series. Mark the ones in my library.',
    );
    await screen.findByText('Watch MobLand next.');
    const google = await screen.findByRole('link', { name: 'Search Google' });
    expect(google.getAttribute('href')).toBe('https://www.google.com/search?q=Mara%20Example%20movies%20and%20series');
    expect(google.getAttribute('target')).toBe('_blank');

    fireEvent.click(a.getByRole('button', { name: 'Julia' }));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]!.split('\n')[1]).toBe('Who is Julia, played by Mara Example, in this film?');
    expect(sent()[1]!.split('\n')[0]).toContain('· person 4]');
    await waitFor(() => expect(screen.getByRole('link', { name: 'Search Google' }).getAttribute('href')).toContain('Julia%20How%20to%20Make%20a%20Killing%202026%20character'));

    fireEvent.click(a.getByRole('button', { name: 'Blumhouse Productions' }));
    await waitFor(() => expect(sent()).toHaveLength(3));
    expect(sent()[2]!.split('\n')[1]).toBe('Tell me about Blumhouse Productions and list their other films and series. Mark the ones in my library.');
    expect(sent()[2]!.split('\n')[0]).toBe('[Movies · How to Make a Killing (2026) · M-23T4 · at 45:00 of 1:52:00]');

    await screen.findByRole('link', { name: 'Search Google' });
    fireEvent.click(a.getByRole('button', { name: 'Crime' }));
    await waitFor(() => expect(sent()).toHaveLength(4));
    expect(sent()[3]!.split('\n')[1]).toBe(
      'Recommend other Crime films similar to How to Make a Killing: the same tone and premise, not just the genre. Prefer ones I have not seen, and say which are already in my library.',
    );
    const director = a.getAllByRole('button', { name: 'Ava Director' });
    expect(director).toHaveLength(2);
    await screen.findByRole('link', { name: 'Search Google' });
    fireEvent.click(director[0]!);
    await waitFor(() => expect(sent()).toHaveLength(5));
    expect(sent()[4]!.split('\n')[1]).toBe('Tell me about Ava Director (director of this film) and list their other films and series. Mark the ones in my library.');
  });

  it('entity links wait while an answer is still streaming', async () => {
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
    const crime = within(article).getByRole('button', { name: 'Crime' }) as HTMLButtonElement;
    fireEvent.click(crime);
    await screen.findByText(/Thinking/);
    expect(crime.disabled).toBe(true);
    fireEvent.click(within(article).getByRole('button', { name: 'Comedy' }));
    expect(postsTo('/api/chat')).toHaveLength(1);
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
