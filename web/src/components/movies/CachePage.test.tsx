// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DiskTitle, DiskView } from '../../moviesApi';
import { CachePage, FAST_REFRESH_MS, sizeText, totalLine } from './CachePage';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function episode(e: number, bytes: number, over: Partial<DiskTitle['seasons'][number]['episodes'][number]> = {}) {
  return { season: 1, episode: e, movie_id: `M-DD0${e}`, name: `Episode ${e}`, bytes, kinds: ['torrent' as const], watched: false, playing: false, in_use: false, downloading: null, ...over };
}

const DANDADAN: DiskTitle = {
  title_id: 'tv-240411',
  movie_id: 'M-DDDN',
  kind: 'tv',
  tmdb_id: 240411,
  title: 'Dandadan',
  year: 2024,
  poster_url: null,
  stored: true,
  bytes: 3 * GIB,
  torrent_bytes: 3 * GIB,
  cloud_bytes: 0,
  kinds: ['torrent'],
  watched: false,
  not_interested: false,
  playing: true,
  in_use: true,
  shared_bytes: 0,
  downloading: null,
  seasons: [
    {
      season: 1,
      bytes: 3 * GIB,
      shared_bytes: 100 * MIB,
      kinds: ['torrent'],
      watched: false,
      playing: true,
      in_use: true,
      downloading: null,
      episodes: [episode(3, 1.5 * GIB, { watched: true }), episode(4, 1.4 * GIB, { playing: true, in_use: true })],
    },
  ],
};
const BARBIE: DiskTitle = { ...DANDADAN, title_id: 'movie-346698', movie_id: 'M-BARB', kind: 'movie', tmdb_id: 346698, title: 'Barbie', year: 2023, bytes: 154 * MIB, torrent_bytes: 0, cloud_bytes: 154 * MIB, kinds: ['cloud'], watched: true, playing: false, in_use: false, seasons: [] };
/** A film the owner asked for, 42 % down. */
const OPPENHEIMER: DiskTitle = { ...BARBIE, title_id: 'movie-872585', movie_id: 'M-OPPN', tmdb_id: 872585, title: 'Oppenheimer', bytes: 900 * MIB, torrent_bytes: 900 * MIB, cloud_bytes: 0, kinds: ['torrent'], watched: false, downloading: { count: 1, progress: 0.42, why: ['asked'], state: 'running' } };

let calls: Array<{ url: string; method: string; body: unknown }>;
let pendingIds: Set<string>;
/** True: Oppenheimer downloads, and Dandadan's S01E05 is fetched ahead. */
let downloads: boolean;

function titlesNow(): DiskTitle[] {
  if (!downloads) return [DANDADAN, BARBIE];
  const s1 = DANDADAN.seasons[0]!;
  const ahead = { count: 1, progress: 0.3, why: ['ahead' as const], state: 'running' as const };
  const e05 = episode(5, 300 * MIB, { downloading: { progress: 0.3, why: 'ahead', state: 'running' } });
  return [{ ...DANDADAN, downloading: ahead, seasons: [{ ...s1, downloading: ahead, episodes: [...s1.episodes, e05] }] }, OPPENHEIMER, BARBIE];
}

function view(): DiskView {
  const hidden = (key: string) => pendingIds.has(key);
  const titles = titlesNow()
    .filter((t) => !hidden(t.title_id))
    .map((t) => ({ ...t, seasons: t.seasons.map((s) => ({ ...s, episodes: s.episodes.filter((e) => !hidden(`${t.title_id}:${e.season}:${e.episode}`)) })) }));
  return {
    host: 'pc',
    total_bytes: 41.2 * GIB,
    torrent_bytes: 35.8 * GIB,
    cloud_bytes: 5.4 * GIB,
    unnamed_bytes: 0,
    budget_bytes: 40 * GIB,
    titles,
    downloading: downloads ? 2 : 0,
    bulk: { watched: { bytes: 12.3 * GIB, titles: 4 }, not_interested: { bytes: 2.1 * GIB, titles: 1 } },
    pending: [],
    undo_ms: 10_000,
  };
}

const titleIds = (): (string | null)[] => within(screen.getByRole('list', { name: 'Titles on disk' })).getAllByRole('listitem').filter((li) => li.hasAttribute('data-title')).map((li) => li.getAttribute('data-title'));
const reads = (): number => calls.filter((c) => c.method === 'GET' && c.url === '/api/stream/disk').length;
/** Lets the page's fetch and its render settle (setTimeout stays real). */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

beforeEach(() => {
  calls = [];
  pendingIds = new Set();
  downloads = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      calls.push({ url, method, body });
      if (url === '/api/stream/disk/delete') {
        const key = [body.title_id, body.season, body.episode].filter((x: unknown) => x !== undefined).join(':');
        pendingIds.add(key);
        const label = body.episode !== undefined ? `Dandadan S01E0${body.episode}` : 'Barbie';
        return new Response(JSON.stringify({ deletion: { id: 'abcdef012345', label, bytes: body.episode !== undefined ? 1.5 * GIB : 154 * MIB, execute_at: '', skipped: [] } }), { status: 202 });
      }
      if (url.startsWith('/api/stream/disk/deletions/')) {
        pendingIds.clear();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(view()), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe('the Cache page', () => {
  it('says the total against the budget, split by kind, and what each bulk button frees', async () => {
    render(<CachePage onOpen={() => {}} />);
    expect((await screen.findByTestId('cp-total')).textContent).toContain('41.2 of 40 GB · torrents 35.8 · cloud 5.4');
    expect((screen.getByRole('button', { name: 'Delete Watched · 12.3 GB' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Delete Not interested · 2.1 GB' }) as HTMLButtonElement).disabled).toBe(false);
    expect(totalLine(view())).toBe('41.2 of 40 GB · torrents 35.8 · cloud 5.4');
    expect(sizeText(154 * MIB)).toBe('154 MB');
    // Nothing downloads: the filter has nothing to show.
    expect((screen.getByRole('button', { name: 'Downloading · 0' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists the titles with their tags; a series unfolds to seasons and episodes, collapsed by default', async () => {
    const open = vi.fn();
    render(<CachePage onOpen={open} />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-title'))).toEqual(['tv-240411', 'movie-346698']);
    const barbie = rows[1]!;
    expect(within(barbie).getByText('watched')).toBeTruthy();
    expect(within(barbie).getByText('154 MB')).toBeTruthy();
    fireEvent.click(within(barbie).getByRole('button', { name: 'Open Barbie' }));
    expect(open).toHaveBeenCalledWith('M-BARB');

    // The series plays: its trash is disabled, and nothing below it shows until it is unfolded.
    const show = rows[0]!;
    expect((within(show).getByRole('button', { name: 'Dandadan: in use now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(show).getByText('playing')).toBeTruthy();
    expect(screen.queryByText('Season 1')).toBeNull();
    fireEvent.click(within(show).getByRole('button', { name: 'Unfold Dandadan' }));
    expect(screen.getByText('Season 1')).toBeTruthy();
    expect(screen.queryByText('S01E03')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unfold season 1' }));
    expect(screen.getByText('S01E03')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Dandadan S01E04: in use now' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete Dandadan S01E03' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('trashes an episode with no confirmation, hides it at once, and brings it back with Undo', async () => {
    render(<CachePage onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Unfold Dandadan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unfold season 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Dandadan S01E03' }));
    expect(screen.queryByText('S01E03')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    const toast = await screen.findByRole('status');
    expect(toast.textContent).toContain('Deleted Dandadan S01E03 · 1.5 GB');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ title_id: 'tv-240411', season: 1, episode: 3 });
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByText('S01E03')).toBeTruthy());
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/stream/disk/deletions/abcdef012345')).toBe(true);
    expect((await screen.findByRole('status')).textContent).toContain('Kept Dandadan S01E03');
  });

  it('runs a bulk deletion from its button', async () => {
    render(<CachePage onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Watched · 12.3 GB' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && JSON.stringify(c.body) === JSON.stringify({ bulk: 'watched' }))).toBe(true));
  });
});

describe('what downloads, on the Cache page', () => {
  it('lists what downloads together with what is downloaded, each downloading row with its bar and why (default view)', async () => {
    downloads = true;
    render(<CachePage onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Downloading · 2' });
    expect(titleIds()).toEqual(['tv-240411', 'movie-872585', 'movie-346698']);
    const opp = screen.getByRole('progressbar', { name: 'Oppenheimer download' });
    // Phase 9's drive finds a row's bar inside that row's own .cp-row.
    expect(opp.closest('.cp-row')).not.toBeNull();
    expect(opp.getAttribute('aria-valuenow')).toBe('42');
    const oppRow = screen.getByRole('progressbar', { name: 'Oppenheimer download' }).closest('li')!;
    expect(within(oppRow).getByText('asked')).toBeTruthy();
    // Barbie is downloaded, not downloading: no bar, no reason.
    const barbie = screen.getByText('Barbie (2023)').closest('li')!;
    expect(within(barbie).queryByRole('progressbar')).toBeNull();
    // The series' row, its season's and its episode's: each with its bar and `ahead`; the downloaded episodes stay listed.
    expect(screen.getByRole('progressbar', { name: 'Dandadan download' }).getAttribute('aria-valuenow')).toBe('30');
    fireEvent.click(screen.getByRole('button', { name: 'Unfold Dandadan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unfold season 1' }));
    expect(screen.getByRole('progressbar', { name: 'Dandadan S01 download' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByRole('progressbar', { name: 'Dandadan S01E05 download' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getAllByText('ahead')).toHaveLength(3);
    expect(screen.getByText('S01E03')).toBeTruthy();
    expect(screen.getByText('S01E04')).toBeTruthy();
  });

  it('the Downloading filter lists only what downloads now, unfolded, and a second click brings everything back', async () => {
    downloads = true;
    render(<CachePage onOpen={() => {}} />);
    const filter = await screen.findByRole('button', { name: 'Downloading · 2' });
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('true');
    expect(titleIds()).toEqual(['tv-240411', 'movie-872585']);
    // Unfolded by itself, down to the one episode that downloads.
    expect(screen.getByText('S01E05')).toBeTruthy();
    expect(screen.queryByText('S01E03')).toBeNull();
    expect(screen.queryByText('S01E04')).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Dandadan S01E05 download' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByRole('progressbar', { name: 'Oppenheimer download' }).getAttribute('aria-valuenow')).toBe('42');
    // Folding in this view works too.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Dandadan' }));
    expect(screen.queryByText('S01E05')).toBeNull();

    fireEvent.click(filter);
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    expect(titleIds()).toEqual(['tv-240411', 'movie-872585', 'movie-346698']);
    // The default view's folds are its own: the series is folded, as it was.
    expect(screen.queryByText('Season 1')).toBeNull();
  });

  it('reads the disk every 3 s while something downloads, and every 15 s once nothing does', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    downloads = true;
    render(<CachePage onOpen={() => {}} />);
    await screen.findByRole('button', { name: 'Downloading · 2' });
    const first = reads();
    act(() => void vi.advanceTimersByTime(FAST_REFRESH_MS));
    expect(reads()).toBe(first + 1);
    await settle();
    // The downloads end: that read says so, and the page slows down.
    downloads = false;
    act(() => void vi.advanceTimersByTime(FAST_REFRESH_MS));
    expect(reads()).toBe(first + 2);
    await settle();
    await screen.findByRole('button', { name: 'Downloading · 0' });
    act(() => void vi.advanceTimersByTime(FAST_REFRESH_MS));
    expect(reads()).toBe(first + 2);
    act(() => void vi.advanceTimersByTime(15_000 - FAST_REFRESH_MS));
    expect(reads()).toBe(first + 3);
  });
});
