// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { DownloadView } from '../moviesApi';
import { DOWNLOADS_POLL_MS, downloadBody, downloadName, downloadNotice, downloadStatus, downloadTip, useDownloads } from './downloads';
import { makeDownload } from '../testing/downloadFixtures';
import { MOVIE, SERIES } from '../testing/movieFixtures';

let answers: boolean[];
let asked: string[];

function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}
const downloadAsks = (): string[] => asked.filter((u) => u.startsWith('/api/stream/downloads'));
const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
  answers = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      const active = answers.shift() ?? false;
      const downloads = active ? [makeDownload({ state: 'running' })] : [makeDownload({ state: 'done', progress: 1 })];
      return new Response(JSON.stringify({ host: 'lenovo', active, downloads }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility('visible');
});

describe('useDownloads: when the title page asks', () => {
  it('asks once when nothing downloads, never on a timer, and again only with the page refresh', async () => {
    const { rerender } = renderHook(({ key }) => useDownloads('movie-467905', key), { initialProps: { key: 1 } });
    await flush(60_000);
    expect(downloadAsks()).toHaveLength(1);
    expect(downloadAsks()[0]).toContain('title=movie-467905');
    rerender({ key: 2 });
    await flush(10_000);
    expect(downloadAsks()).toHaveLength(2);
    rerender({ key: 2 });
    await flush(10_000);
    expect(downloadAsks()).toHaveLength(2);
  });

  it('asks every 2.5 s while a download runs, and stops when none does', async () => {
    answers = [true, true, false];
    renderHook(() => useDownloads('movie-467905', 1));
    await flush();
    expect(downloadAsks()).toHaveLength(1);
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(2);
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(3);
    await flush(30_000);
    expect(downloadAsks()).toHaveLength(3);
  });

  it('asks nothing while the tab is hidden, and at once when it is visible again', async () => {
    answers = [true, true, true];
    renderHook(() => useDownloads('movie-467905', 1));
    await flush();
    expect(downloadAsks()).toHaveLength(1);
    act(() => setVisibility('hidden'));
    await flush(10_000);
    expect(downloadAsks()).toHaveLength(1);
    act(() => setVisibility('visible'));
    await flush();
    expect(downloadAsks()).toHaveLength(2);
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(3);
  });

  it('never asks without a title (the Library side, or streaming off)', async () => {
    renderHook(() => useDownloads(null, 1));
    await flush(60_000);
    expect(downloadAsks()).toHaveLength(0);
  });

  it('asks again at once on reload, then keeps the 2.5 s pace while active', async () => {
    answers = [false, true, false];
    const { result } = renderHook(() => useDownloads('movie-467905', 1));
    await flush();
    act(() => result.current.reload());
    await flush();
    expect(downloadAsks()).toHaveLength(2);
    expect(result.current.rows[0]?.state).toBe('running');
    await flush(DOWNLOADS_POLL_MS);
    expect(downloadAsks()).toHaveLength(3);
    await flush(30_000);
    expect(downloadAsks()).toHaveLength(3);
  });
});

describe('downloadStatus: what a button shows', () => {
  const ep = (episode: number, over: Partial<DownloadView> = {}) => makeDownload({ title_id: SERIES.id, kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 1, episode, ...over });

  it("a season's progress is the mean of its rows; another season's rows do not count", () => {
    const rows = [ep(1, { state: 'done', progress: 1 }), ep(2, { state: 'running', progress: 0.5 }), ep(3, { state: 'queued', progress: 0, source: null }), makeDownload({ kind: 'tv', tmdb_id: SERIES.tmdb_id, season: 2, episode: 1, progress: 0.9 })];
    const s = downloadStatus(SERIES, { kind: 'season', season: 1 }, rows);
    expect(s).toEqual({ state: 'active', phase: 'running', progress: 0.5, left: 2, source: 'torrent', ids: [rows[1]!.id, rows[2]!.id] });
    expect(downloadTip('MobLand season 1', s)).toBe('MobLand season 1: downloading from a torrent, 50% (2 episodes left)');
    expect(downloadStatus(SERIES, { kind: 'episode', season: 1, episode: 3 }, rows)).toMatchObject({ state: 'active', phase: 'queued', progress: 0 });
  });

  it('a season is on this machine only when every aired episode is', () => {
    const all = [1, 2, 3, 4].map((e) => ep(e, { state: 'done', progress: 1, bytes_total: 1024 ** 3 }));
    expect(downloadStatus(SERIES, { kind: 'season', season: 1 }, all)).toEqual({ state: 'here', source: 'torrent', bytes: 4 * 1024 ** 3 });
    expect(downloadStatus(SERIES, { kind: 'season', season: 1 }, all.slice(0, 3))).toEqual({ state: 'idle' });
    const unaired = { ...SERIES, seasons: SERIES.seasons.map((s) => (s.season === 1 ? { ...s, episodes: s.episodes.map((e) => (e.episode === 4 ? { ...e, air_date: '2099-01-01' } : e)) } : s)) };
    expect(downloadStatus(unaired, { kind: 'season', season: 1 }, all.slice(0, 3), new Date('2026-11-20T00:00:00Z'))).toMatchObject({ state: 'here' });
  });

  it('says a failure with its reason, and a film is matched by its own TMDB id only', () => {
    expect(downloadStatus(MOVIE, { kind: 'movie' }, [makeDownload({ state: 'failed', progress: 0, error: 'no_source' })])).toEqual({ state: 'failed', error: 'no_source', count: 1 });
    expect(downloadStatus(MOVIE, { kind: 'movie' }, [makeDownload({ tmdb_id: 1 })])).toEqual({ state: 'idle' });
  });

  it('names what it downloads and builds the body the route takes', () => {
    expect(downloadName(SERIES, { kind: 'season', season: 0 })).toBe('MobLand specials');
    expect(downloadName(SERIES, { kind: 'episode', season: 1, episode: 3 })).toBe('MobLand S01E03');
    expect(downloadBody(SERIES, { kind: 'season', season: 1 }, 'auto')).toEqual({ kind: 'tv', tmdb_id: 247718, season: 1, via: 'auto' });
    expect(downloadBody(MOVIE, { kind: 'movie' }, 'torrent', 'a'.repeat(40))).toEqual({ kind: 'movie', tmdb_id: 467905, via: 'torrent', info_hash: 'a'.repeat(40) });
  });

  it("a season's notice says how many episodes the server left out for not having aired (or having no air date)", () => {
    const q = (created: number, not_aired: number, downloads: DownloadView[] = []) => ({ created, whole: 0, not_aired, downloads });
    expect(downloadNotice('MobLand season 1', 'auto', q(3, 0))).toBe('MobLand season 1: 3 episodes queued');
    expect(downloadNotice('MobLand season 1', 'torrent', q(2, 1))).toBe('MobLand season 1: 2 episodes queued, from a torrent; 1 episode left out (not aired yet, or no air date)');
    expect(downloadNotice('MobLand season 1', 'auto', q(0, 2))).toBe('MobLand season 1: nothing left to download; 2 episodes left out (not aired yet, or no air date)');
  });
});
