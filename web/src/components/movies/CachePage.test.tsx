// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DiskTitle, DiskView } from '../../moviesApi';
import { CachePage, sizeText, totalLine } from './CachePage';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function episode(e: number, bytes: number, over: Partial<DiskTitle['seasons'][number]['episodes'][number]> = {}) {
  return { season: 1, episode: e, movie_id: `M-DD0${e}`, name: `Episode ${e}`, bytes, kinds: ['torrent' as const], watched: false, playing: false, in_use: false, ...over };
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
  seasons: [
    {
      season: 1,
      bytes: 3 * GIB,
      shared_bytes: 100 * MIB,
      kinds: ['torrent'],
      watched: false,
      playing: true,
      in_use: true,
      episodes: [episode(3, 1.5 * GIB, { watched: true }), episode(4, 1.4 * GIB, { playing: true, in_use: true })],
    },
  ],
};
const BARBIE: DiskTitle = { ...DANDADAN, title_id: 'movie-346698', movie_id: 'M-BARB', kind: 'movie', tmdb_id: 346698, title: 'Barbie', year: 2023, bytes: 154 * MIB, torrent_bytes: 0, cloud_bytes: 154 * MIB, kinds: ['cloud'], watched: true, playing: false, in_use: false, seasons: [] };

let calls: Array<{ url: string; method: string; body: unknown }>;
let pendingIds: Set<string>;

function view(): DiskView {
  const hidden = (key: string) => pendingIds.has(key);
  const titles = [DANDADAN, BARBIE]
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
    bulk: { watched: { bytes: 12.3 * GIB, titles: 4 }, not_interested: { bytes: 2.1 * GIB, titles: 1 } },
    pending: [],
    undo_ms: 10_000,
  };
}

beforeEach(() => {
  calls = [];
  pendingIds = new Set();
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
});

describe('the Cache page', () => {
  it('says the total against the budget, split by kind, and what each bulk button frees', async () => {
    render(<CachePage onOpen={() => {}} />);
    expect((await screen.findByTestId('cp-total')).textContent).toContain('41.2 of 40 GB · torrents 35.8 · cloud 5.4');
    expect((screen.getByRole('button', { name: 'Delete Watched · 12.3 GB' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Delete Not interested · 2.1 GB' }) as HTMLButtonElement).disabled).toBe(false);
    expect(totalLine(view())).toBe('41.2 of 40 GB · torrents 35.8 · cloud 5.4');
    expect(sizeText(154 * MIB)).toBe('154 MB');
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
