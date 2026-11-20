import { describe, expect, it } from 'vitest';
import { DownloadError } from '../../../src/directStream/downloads/types.js';
import { streamDownloadsRoutes, type StreamDownloadsPort } from '../../../src/http/streamDownloadsApi.js';
import { DL_ID, dview, fakeDownloads } from './downloadsFakes.js';

const SAME = { origin: 'http://localhost', 'content-type': 'application/json' };
const HASH = '67B07B417F6F8F7D367BBDED3CD797A0840724B6';
const req = (path: string, init: RequestInit = {}) => new Request(`http://localhost${path}`, init);
const app = (port: StreamDownloadsPort | null) => streamDownloadsRoutes({ streamDownloads: port as never });
const post = (port: StreamDownloadsPort | null, body: unknown, headers: Record<string, string> = SAME) =>
  app(port).fetch(req('/api/stream/downloads', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));

describe('the download routes', () => {
  it('answer downloads_off on every route when the queue is off', async () => {
    for (const r of [
      await post(null, { kind: 'movie', tmdb_id: 1 }),
      await app(null).fetch(req('/api/stream/downloads')),
      await app(null).fetch(req(`/api/stream/downloads/${DL_ID}`, { method: 'DELETE', headers: SAME })),
    ]) {
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ error: 'downloads_off' });
    }
  });

  it('queue a film with via auto by default and answer 202 at once with the row', async () => {
    const f = fakeDownloads();
    const r = await post(f.port, { kind: 'movie', tmdb_id: 930564 });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ ok: true, created: 1, whole: 0, not_aired: 0, downloads: [{ id: DL_ID, kind: 'movie', tmdb_id: 930564 }] });
    expect(f.request).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 930564 }, { via: 'auto' });
    expect(f.requestSeason).not.toHaveBeenCalled();
  });

  it('queue one episode only, from the source chosen', async () => {
    const f = fakeDownloads();
    await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, via: 'cloud' });
    expect(f.request).toHaveBeenCalledWith({ kind: 'tv', tmdbId: 247718, season: 1, episode: 2 }, { via: 'cloud' });
    expect(f.requestSeason).not.toHaveBeenCalled();
  });

  it('download exactly the torrent picked: info_hash means via torrent, in lower case', async () => {
    const f = fakeDownloads();
    expect((await post(f.port, { kind: 'movie', tmdb_id: 930564, info_hash: HASH })).status).toBe(202);
    expect(f.request).toHaveBeenLastCalledWith({ kind: 'movie', tmdbId: 930564 }, { via: 'torrent', infoHash: HASH.toLowerCase() });
    await post(f.port, { kind: 'movie', tmdb_id: 930564, via: 'torrent' });
    expect(f.request).toHaveBeenLastCalledWith({ kind: 'movie', tmdbId: 930564 }, { via: 'torrent' });
  });

  it('queue a whole season when tv names a season and no episode', async () => {
    const f = fakeDownloads();
    const r = await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 1, via: 'torrent' });
    expect(r.status).toBe(202);
    const body = (await r.json()) as { created: number; downloads: Array<{ season: number; episode: number }> };
    expect(body.created).toBe(3);
    expect(body.downloads.map((d) => [d.season, d.episode])).toEqual([[1, 1], [1, 2], [1, 3]]);
    expect(f.requestSeason).toHaveBeenCalledWith(247718, 1, { via: 'torrent' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('answer 200 when everything asked for is queued already or whole here', async () => {
    const f = fakeDownloads();
    f.request.mockResolvedValueOnce({ download: dview({ state: 'running' }), created: false, onDisk: false });
    expect((await post(f.port, { kind: 'movie', tmdb_id: 930564 })).status).toBe(200);
    f.request.mockResolvedValueOnce({ download: null, created: false, onDisk: true });
    const r = await post(f.port, { kind: 'movie', tmdb_id: 930564 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ created: 0, whole: 1, downloads: [] });
  });

  it('refuse a bad body with invalid_body and queue nothing', async () => {
    const f = fakeDownloads();
    for (const body of [
      { kind: 'movie', tmdb_id: 930564, season: 1 },
      { kind: 'tv', tmdb_id: 247718, episode: 2 },
      { kind: 'tv', tmdb_id: 247718, season: 1, info_hash: HASH },
      { kind: 'movie', tmdb_id: 930564, via: 'cloud', info_hash: HASH },
      { kind: 'movie', tmdb_id: 930564, info_hash: 'abc' },
      { kind: 'movie', tmdb_id: 930564, via: 'magnet' },
    ]) {
      const r = await post(f.port, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'invalid_body' });
    }
    expect((await post(f.port, '{not json')).status).toBe(400);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.requestSeason).not.toHaveBeenCalled();
  });

  it('refuse a write from another origin', async () => {
    const f = fakeDownloads();
    expect((await post(f.port, { kind: 'movie', tmdb_id: 930564 }, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await app(f.port).fetch(req(`/api/stream/downloads/${DL_ID}`, { method: 'DELETE' }))).status).toBe(403);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("list this machine's queued, running, paused and failed downloads with their progress, title, source and error", async () => {
    const rows = [
      dview({ id: 'a', state: 'running', source: 'torrent', progress: 0.42, bytes_done: 420, bytes_total: 1000, peers: 3, down_kbps: 900 }),
      dview({ id: 'b', state: 'failed', error: 'no_source', tmdb_id: 990004 }),
      dview({ id: 'c', state: 'paused', kind: 'tv', tmdb_id: 247718, season: 1, episode: 2, batch: 'b1' }),
      dview({ id: 'd', state: 'done', progress: 1 }),
      dview({ id: 'e', state: 'failed', error: 'cancelled' }),
      dview({ id: 'f', host: 'other-laptop', available: false }),
    ];
    const r = await app(fakeDownloads(rows).port).fetch(req('/api/stream/downloads'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { host: string; active: boolean; downloads: Array<Record<string, unknown>> };
    expect(body.host).toBe('here');
    expect(body.active).toBe(true);
    expect(body.downloads.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(body.downloads[0]).toMatchObject({ title_id: 'movie-930564', season: null, episode: null, state: 'running', source: 'torrent', progress: 0.42, bytes_done: 420, bytes_total: 1000, error: null });
    expect(body.downloads[1]).toMatchObject({ state: 'failed', error: 'no_source', title_id: 'movie-990004' });
    expect(body.downloads[2]).toMatchObject({ season: 1, episode: 2, batch: 'b1', title_id: 'tv-247718' });
  });

  it('with a title, also list its finished downloads (on this machine), which never make it active', async () => {
    const f = fakeDownloads([dview({ id: 'a', state: 'done', progress: 1, source: 'torrent' })]);
    const r = await app(f.port).fetch(req('/api/stream/downloads?title=movie-930564'));
    expect(f.list).toHaveBeenCalledWith({ kind: 'movie', tmdbId: 930564 });
    expect(await r.json()).toMatchObject({ active: false, downloads: [{ id: 'a', state: 'done', title_id: 'movie-930564' }] });
    await app(f.port).fetch(req('/api/stream/downloads'));
    expect(f.list).toHaveBeenLastCalledWith(undefined);
  });

  it('answer 404 unknown_season, or 503 downloads_off when no season download is wired', async () => {
    const f = fakeDownloads();
    f.requestSeason.mockResolvedValueOnce({ ok: false, error: 'unknown_season', detail: 'TMDB tv 247718 lists no episode of season 9.' });
    const r = await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 9 });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: 'unknown_season' });
    f.requestSeason.mockResolvedValueOnce({ ok: false, error: 'seasons_off', detail: 'off' });
    expect((await post(f.port, { kind: 'tv', tmdb_id: 247718, season: 1 })).status).toBe(503);
  });

  it('narrow the list to one title, say active false when nothing moves, and refuse a bad title', async () => {
    const rows = [dview({ id: 'a', state: 'failed', error: 'no_source' }), dview({ id: 'b', state: 'running', kind: 'tv', tmdb_id: 247718, season: 1, episode: 1 })];
    const a = app(fakeDownloads(rows).port);
    const film = (await (await a.fetch(req('/api/stream/downloads?title=movie-930564'))).json()) as { active: boolean; downloads: Array<{ id: string }> };
    expect(film.downloads.map((d) => d.id)).toEqual(['a']);
    expect(film.active).toBe(false);
    const show = (await (await a.fetch(req('/api/stream/downloads?title=tv-247718'))).json()) as { active: boolean; downloads: Array<{ id: string }> };
    expect(show.downloads.map((d) => d.id)).toEqual(['b']);
    expect(show.active).toBe(true);
    const bad = await a.fetch(req('/api/stream/downloads?title=M-23T4'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_query' });
  });

  it('cancel a download by id, and answer unknown_download', async () => {
    const f = fakeDownloads();
    const r = await app(f.port).fetch(req(`/api/stream/downloads/${DL_ID.toUpperCase()}`, { method: 'DELETE', headers: SAME }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, download: { id: DL_ID } });
    expect(f.cancel).toHaveBeenCalledWith(DL_ID);
    expect((await app(f.port).fetch(req('/api/stream/downloads/not-an-id', { method: 'DELETE', headers: SAME }))).status).toBe(404);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    f.cancel.mockRejectedValueOnce(new DownloadError('unknown_download', 'No download has this id.'));
    const gone = await app(f.port).fetch(req(`/api/stream/downloads/${DL_ID}`, { method: 'DELETE', headers: SAME }));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: 'unknown_download' });
  });
});
