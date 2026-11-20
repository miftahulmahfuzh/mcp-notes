import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { StreamDownloads } from '../../src/directStream/downloads/service.js';
import { streamDownloadsRoutes, type ListedDownload } from '../../src/http/streamDownloadsApi.js';
import { FakeCaches } from '../unit/directStream/downloads/fakes.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const SAME = { origin: 'http://localhost', 'content-type': 'application/json' };
let db: Db;

/** Phase 2's engine over the real repo: no torrents, a fake cloud cache, never started. */
function engine(host: string): StreamDownloads {
  return new StreamDownloads({
    host,
    repo: new DownloadsRepo(db),
    torrents: null,
    caches: new FakeCaches(),
    ssid: async () => null,
    playingTorrents: () => [],
    now: () => new Date('2026-11-20T12:00:00Z'),
    log: () => undefined,
    every: () => () => undefined,
  });
}

function routes(host: string) {
  return streamDownloadsRoutes({ streamDownloads: engine(host) });
}

beforeAll(() => {
  db = openTestDb();
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('/api/stream/downloads on a real stream_downloads', () => {
  it('queues a film and reads it back from GET, narrowed to the title', async () => {
    const a = routes('host-a');
    const posted = await a.request('/api/stream/downloads', { method: 'POST', headers: SAME, body: JSON.stringify({ kind: 'movie', tmdb_id: 467905, via: 'cloud' }) });
    expect(posted.status).toBe(202);
    const made = ((await posted.json()) as { downloads: ListedDownload[] }).downloads;
    expect(made).toHaveLength(1);
    const again = await a.request('/api/stream/downloads', { method: 'POST', headers: SAME, body: JSON.stringify({ kind: 'movie', tmdb_id: 467905, via: 'cloud' }) });
    expect(again.status).toBe(200);
    const listed = (await (await a.request('/api/stream/downloads?title=movie-467905')).json()) as { host: string; active: boolean; downloads: ListedDownload[] };
    expect(listed.host).toBe('host-a');
    expect(listed.downloads).toHaveLength(1);
    expect(listed.downloads[0]).toMatchObject({ id: made[0]!.id, title_id: 'movie-467905', kind: 'movie', tmdb_id: 467905, season: null, episode: null, via: 'cloud' });
    expect(['queued', 'running']).toContain(listed.downloads[0]!.state);
    expect(listed.active).toBe(true);
    expect(listed.downloads[0]!.progress).toBeGreaterThanOrEqual(0);
    expect(listed.downloads[0]!.progress).toBeLessThanOrEqual(1);
  });

  it("never lists or cancels the other machine's download", async () => {
    const b = routes('host-b');
    const posted = await b.request('/api/stream/downloads', { method: 'POST', headers: SAME, body: JSON.stringify({ kind: 'tv', tmdb_id: 247718, season: 1, episode: 2 }) });
    const id = ((await posted.json()) as { downloads: ListedDownload[] }).downloads[0]!.id;
    const a = routes('host-a');
    expect(((await (await a.request('/api/stream/downloads')).json()) as { downloads: ListedDownload[] }).downloads).toEqual([]);
    const cancel = await a.request(`/api/stream/downloads/${id}`, { method: 'DELETE', headers: SAME });
    expect(cancel.status).toBe(404);
    expect(((await (await b.request('/api/stream/downloads')).json()) as { downloads: ListedDownload[] }).downloads.map((d) => d.id)).toEqual([id]);
  });
});
