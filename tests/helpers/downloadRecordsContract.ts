import { describe, expect, it } from 'vitest';
import type { DownloadRecords } from '../../src/directStream/downloads/repo.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const CACHE = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const NOBODY = '33333333-3333-4333-8333-333333333333';
const FILM = { kind: 'movie', tmdbId: 550 } as const;
const ep = (episode: number) => ({ kind: 'tv', tmdbId: 1399, season: 1, episode }) as const;
const at = (s: number): Date => new Date(Date.UTC(2026, 10, 20, 12, 0, s));

/** What DownloadsRepo promises, run against Postgres (tests/integration) and the in-memory fake (tests/unit). */
export function downloadRecordsContract(label: string, make: () => Promise<DownloadRecords>): void {
  describe(`${label}: the download queue (stream_downloads)`, () => {
    it('queues one open row per film or episode and host; asking again answers it; a failed one is queued again from nothing', async () => {
      const r = await make();
      const first = await r.create('host-a', { ref: FILM, via: 'auto' }, at(1));
      expect(first.created).toBe(true);
      expect(first.row).toMatchObject({
        host: 'host-a', kind: 'movie', tmdbId: 550, season: 0, episode: 0, via: 'auto', infoHash: null, batch: null,
        state: 'queued', source: null, sourceId: null, bytesDone: 0, bytesTotal: null, error: null, startedAt: null, completedAt: null,
      });
      const again = await r.create('host-a', { ref: FILM, via: 'cloud' }, at(2));
      expect(again).toMatchObject({ created: false, row: { id: first.row.id, via: 'auto', state: 'queued' } });
      const elsewhere = await r.create('host-b', { ref: FILM, via: 'cloud' }, at(3));
      expect(elsewhere.created).toBe(true);
      expect(elsewhere.row.id).not.toBe(first.row.id);

      await r.on('host-a', first.row.id, { source: 'torrent', infoHash: HASH }, at(4));
      await r.progress('host-a', first.row.id, 500, 1000, at(4));
      expect(await r.failed('host-a', first.row.id, 'no_source', 'x'.repeat(900), at(5))).toMatchObject({ state: 'failed', error: 'no_source', errorDetail: 'x'.repeat(500) });
      const retried = await r.create('host-a', { ref: FILM, via: 'torrent', infoHash: HASH }, at(6));
      expect(retried).toMatchObject({
        created: true,
        row: { id: first.row.id, via: 'torrent', infoHash: HASH, state: 'queued', error: null, errorDetail: null, source: null, sourceId: null, bytesDone: 0, bytesTotal: null },
      });
    });

    it('hands out the oldest queued download of the host, one at a time', async () => {
      const r = await make();
      const film = await r.create('host-b', { ref: FILM, via: 'auto' }, at(0));
      const e1 = await r.create('host-a', { ref: ep(1), via: 'auto', batch: BATCH }, at(1));
      const e2 = await r.create('host-a', { ref: ep(2), via: 'auto', batch: BATCH }, at(2));
      expect(await r.claimNext('host-a', at(3))).toMatchObject({ id: e1.row.id, state: 'running', startedAt: at(3), batch: BATCH });
      expect(await r.claimNext('host-a', at(4))).toMatchObject({ id: e2.row.id, state: 'running', startedAt: at(4) });
      expect(await r.claimNext('host-a', at(5))).toBeNull();
      expect(await r.claimNext('host-b', at(5))).toMatchObject({ id: film.row.id, state: 'running' });
    });

    it('follows a download to its end: source, progress, paused and running again, done; a done row is final and frees its slot', async () => {
      const r = await make();
      const { row } = await r.create('host-a', { ref: ep(1), via: 'cloud' }, at(1));
      expect(await r.setState('host-a', row.id, 'running', at(2))).toMatchObject({ state: 'running', startedAt: at(2) });
      expect(await r.on('host-a', row.id, { source: 'cloud', cacheId: CACHE }, at(3))).toMatchObject({ source: 'cloud', sourceId: CACHE });
      await r.progress('host-a', row.id, 10, 100, at(3));
      expect(await r.setState('host-a', row.id, 'paused', at(4))).toMatchObject({ state: 'paused', bytesDone: 10, bytesTotal: 100 });
      expect(await r.setState('host-a', row.id, 'running', at(5))).toMatchObject({ state: 'running', startedAt: at(2) });
      const done = await r.done('host-a', row.id, { source: 'cloud', cacheId: CACHE }, { bytesDone: 100, bytesTotal: 100 }, at(6));
      expect(done).toMatchObject({ state: 'done', completedAt: at(6), source: 'cloud', sourceId: CACHE, bytesDone: 100, error: null });
      expect(await r.setState('host-a', row.id, 'queued', at(7))).toBeNull();
      expect(await r.failed('host-a', row.id, 'download_failed', null, at(7))).toBeNull();
      await r.progress('host-a', row.id, 1, 1, at(7));
      expect(await r.get('host-a', row.id)).toMatchObject({ state: 'done', bytesDone: 100 });
      expect(await r.openFor('host-a', ep(1))).toBeNull();
      const next = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(8));
      expect(next.created).toBe(true);
      expect(next.row.id).not.toBe(row.id);
      expect((await r.list('host-a', { states: ['queued'] })).map((d) => d.id)).toEqual([next.row.id]);
    });

    it('cancels what is not finished, once', async () => {
      const r = await make();
      const { row } = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(1));
      expect(await r.cancel('host-a', row.id, at(2))).toMatchObject({ state: 'failed', error: 'cancelled', completedAt: null });
      expect(await r.cancel('host-a', row.id, at(3))).toBeNull();
      expect(await r.cancel('host-a', NOBODY, at(3))).toBeNull();
      expect(await r.cancel('host-b', row.id, at(3))).toBeNull();
    });

    it('carries on at a daemon start what was queued, running or paused on this host, from what it had on disk (R1.7)', async () => {
      const r = await make();
      const queued = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(1));
      const running = await r.create('host-a', { ref: ep(2), via: 'torrent' }, at(2));
      await r.setState('host-a', running.row.id, 'running', at(2));
      await r.on('host-a', running.row.id, { source: 'torrent', infoHash: HASH }, at(2));
      await r.progress('host-a', running.row.id, 700, 1000, at(2));
      const paused = await r.create('host-a', { ref: ep(3), via: 'auto' }, at(3));
      await r.setState('host-a', paused.row.id, 'paused', at(3));
      const done = await r.create('host-a', { ref: ep(4), via: 'cloud' }, at(4));
      await r.done('host-a', done.row.id, { source: 'cloud', cacheId: CACHE }, { bytesDone: 5, bytesTotal: 5 }, at(4));
      const failed = await r.create('host-a', { ref: ep(5), via: 'auto' }, at(5));
      await r.failed('host-a', failed.row.id, 'no_source', null, at(5));
      const other = await r.create('host-b', { ref: ep(1), via: 'auto' }, at(6));
      await r.setState('host-b', other.row.id, 'running', at(6));

      const resumed = await r.toResume('host-a', at(10));
      expect(resumed.map((d) => d.id)).toEqual([queued.row.id, running.row.id, paused.row.id]);
      expect(resumed.every((d) => d.state === 'queued')).toBe(true);
      expect(resumed[1]).toMatchObject({ source: 'torrent', sourceId: HASH, bytesDone: 700, bytesTotal: 1000, startedAt: at(2) });
      expect(await r.get('host-a', done.row.id)).toMatchObject({ state: 'done' });
      expect(await r.get('host-a', failed.row.id)).toMatchObject({ state: 'failed' });
      expect(await r.get('host-b', other.row.id)).toMatchObject({ state: 'running' });
    });

    it('reads one host only, narrowed by title and state', async () => {
      const r = await make();
      const e1 = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(1));
      await r.create('host-a', { ref: FILM, via: 'auto' }, at(2));
      const e2 = await r.create('host-a', { ref: ep(2), via: 'auto' }, at(3));
      await r.create('host-b', { ref: ep(3), via: 'auto' }, at(4));
      expect((await r.list('host-a', { kind: 'tv', tmdbId: 1399 })).map((d) => d.id)).toEqual([e1.row.id, e2.row.id]);
      expect(await r.list('host-a')).toHaveLength(3);
      expect(await r.get('host-b', e1.row.id)).toBeNull();
      expect(await r.openFor('host-a', ep(2))).toMatchObject({ id: e2.row.id });
    });

    it('forgets a slot whose files were deleted, finished rows too', async () => {
      const r = await make();
      const first = await r.create('host-a', { ref: ep(1), via: 'cloud' }, at(1));
      await r.done('host-a', first.row.id, { source: 'cloud', cacheId: CACHE }, { bytesDone: 1, bytesTotal: 1 }, at(2));
      await r.create('host-a', { ref: ep(1), via: 'auto' }, at(3));
      const kept = await r.create('host-b', { ref: ep(1), via: 'auto' }, at(4));
      expect(await r.deleteSlot('host-a', ep(1))).toBe(2);
      expect(await r.list('host-a')).toEqual([]);
      expect(await r.delete('host-b', kept.row.id)).toBe(true);
      expect(await r.delete('host-b', kept.row.id)).toBe(false);
    });
  });
}
