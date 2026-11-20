import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { cancelDownload, fetchDownloads, requestDownload } from './moviesApi';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('the download client', () => {
  it('posts the film, episode or season asked for and returns the rows', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true, created: 1, whole: 0, not_aired: 0, downloads: [{ id: 'x', title_id: 'tv-247718', kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, state: 'queued', via: 'auto', progress: 0 }] }, 202));
    vi.stubGlobal('fetch', fetchMock);
    const q = await requestDownload({ kind: 'tv', tmdb_id: 247718, season: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/stream/downloads');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'tv', tmdb_id: 247718, season: 1 });
    expect(q.created).toBe(1);
    expect(q.downloads[0]).toMatchObject({ id: 'x', season: 1, episode: 2, source: null, error: null, batch: null });
  });

  it('reads one title, clamps progress and says whether anything moves', async () => {
    const fetchMock = vi.fn(async () => json({ host: 'gpd', active: true, downloads: [{ id: 'a', state: 'running', progress: 1.7 }, { id: 'b', state: 'failed', progress: -1, error: 'no_source' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const v = await fetchDownloads('movie-550');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/stream/downloads?title=movie-550');
    expect(v.active).toBe(true);
    expect(v.downloads.map((d) => d.progress)).toEqual([1, 0]);
    expect(v.downloads[1]?.error).toBe('no_source');
    vi.stubGlobal('fetch', vi.fn(async () => json({ host: 'gpd' })));
    expect(await fetchDownloads()).toEqual({ host: 'gpd', active: false, downloads: [] });
  });

  it('cancels by id and throws the server code', async () => {
    const fetchMock = vi.fn(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await cancelDownload('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(fetchMock.mock.calls[0]).toMatchObject(['/api/stream/downloads/dddddddd-dddd-4ddd-8ddd-dddddddddddd', { method: 'DELETE' }]);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'downloads_off', message: 'off' }, 503)));
    await expect(fetchDownloads()).rejects.toEqual(new ApiError(503, 'downloads_off', 'off'));
  });
});
