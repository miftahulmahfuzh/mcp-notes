import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamDownloads, streamTorrents } from '../../src/db/schema.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { packSwarmOf, SeasonDownloads, seasonRowsOf } from '../../src/directStream/downloads/season.js';
import { parseRelease, type TorrentCandidate } from '../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../src/directStream/torrent/probe.js';
import { TorrentsRepo } from '../../src/directStream/torrent/repo.js';
import { TorrentStreams } from '../../src/directStream/torrent/service.js';
import { TorrentSource } from '../../src/directStream/torrent/source.js';
import { TorrentFolder } from '../../src/directStream/torrent/store.js';
import { FakeTorrentEngine } from '../helpers/fakeTorrentEngine.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'host-a';
const PACK = 'facade'.padEnd(40, '3');
const SHOW = 'Fixture.Show.S01.1080p.WEB.x264';
const T0 = new Date('2026-11-20T12:00:00Z');
// stream_downloads.batch is a uuid column (phase 1's schema): a fixed one, where the engine mints randomUUID().
const BATCH = '0b0b0b0b-0000-4000-8000-00000000ba7c';
const data = (seed: number): Buffer => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + seed) % 251));
const FILES = [1, 2, 3].map((e) => ({ path: `${SHOW}/Fixture.Show.S01E0${e}.1080p.mp4`, data: data(e) }));
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 2_700, direct: true };
const PACK_CANDIDATE: TorrentCandidate = {
  infoHash: PACK,
  name: SHOW,
  fileName: null,
  fileIdx: null,
  seeds: 60,
  sizeBytes: 12_288,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: [],
  scoped: false,
  release: parseRelease(SHOW),
};

let db: Db;
let root: string;

beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  root = await mkdtemp(path.join(os.tmpdir(), 'season-int-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a season download from its pack', () => {
  it('joins one swarm, records and keeps one stream_torrents row per episode, and ends each stream_downloads row done', async () => {
    const torrentsRepo = new TorrentsRepo(db);
    const downloads = new DownloadsRepo(db);
    const engine = new FakeTorrentEngine([{ infoHash: PACK, name: SHOW, files: FILES }]);
    const folder = new TorrentFolder(root);
    const streams = new TorrentStreams({ engine, repo: torrentsRepo, folder, host: HOST, uploadKbps: 100, keepDays: 7, discovery: true, now: () => T0, log: () => undefined, every: () => () => undefined });
    const source = new TorrentSource({
      swarm: streams,
      find: async () => ({ candidates: [PACK_CANDIDATE], indexes: [], excluded: [], lastResort: [] }),
      probe: async () => MP4_EN,
      tiers: [],
      localBase: () => 'http://127.0.0.1:1',
      log: () => undefined,
    });
    const rows = seasonRowsOf(downloads, HOST, () => T0);
    const seasons = new SeasonDownloads({
      episodes: async () => [
        { episode: 1, airDate: '2026-10-01' },
        { episode: 2, airDate: '2026-10-08' },
        { episode: 3, airDate: '2026-10-15' },
        { episode: 4, airDate: '2026-12-01' },
      ],
      whole: (ref) => source.onDisk(ref),
      request: (ref, o) => downloads.create(HOST, { ref, via: o.via, infoHash: null, batch: o.batch }, T0),
      rows,
      packs: { fetch: (tmdbId, season, episodes, o) => source.fetchPack(tmdbId, season, episodes, { audioLang: 'en', imdbId: null, names: null, ...o }) },
      // TorrentStreams.keep (phase 2) writes the owner's mark through TorrentsRepo.setKept.
      swarm: packSwarmOf(streams),
      office: async () => false,
      now: () => T0,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
      newBatch: () => BATCH,
      log: () => undefined,
    });

    const answer = await seasons.request(1399, 1, { via: 'auto' });
    expect(answer).toMatchObject({ ok: true, batch: BATCH, left_out: [{ episode: 4, why: 'not_aired' }] });
    const [first] = await rows.open(BATCH);
    const job = await seasons.take(first!);
    expect(job).not.toBeNull();
    expect(engine.added).toEqual([PACK]);

    for (const [index, f] of FILES.entries()) {
      const target = folder.diskPath(PACK, f.path)!;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, f.data);
      engine.have(PACK, index);
    }
    await job!.done;
    await streams.tick();

    const torrents = await db.select().from(streamTorrents).where(eq(streamTorrents.infoHash, PACK));
    expect(torrents.map((r) => [r.episode, r.fileIndex, r.state, r.keptAt !== null]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, 0, 'ready', true],
      [2, 1, 'ready', true],
      [3, 2, 'ready', true],
    ]);
    const asked = await db.select().from(streamDownloads).where(eq(streamDownloads.batch, BATCH));
    expect(asked.map((r) => [r.episode, r.state, r.source, r.sourceId]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, 'done', 'torrent', PACK],
      [2, 'done', 'torrent', PACK],
      [3, 'done', 'torrent', PACK],
    ]);
    for (const episode of [1, 2, 3]) expect(await source.onDisk({ kind: 'tv', tmdbId: 1399, season: 1, episode })).toBe(true);
    expect(engine.added).toEqual([PACK]);
  });
});
