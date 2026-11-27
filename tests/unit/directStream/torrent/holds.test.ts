import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { parseRelease, type TorrentCandidate } from '../../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../../src/directStream/torrent/probe.js';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentSource, type FindAnswer } from '../../../../src/directStream/torrent/source.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { TorrentPick } from '../../../../src/directStream/torrent/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const HASH = 'c0ffee'.padEnd(40, '0');
const NAME = 'Fixture.Film.2026';
// Two files, so an episode's ask finds none of its own (a lone video would be taken for it).
const FILES = [
  { path: `${NAME}/${NAME}.mp4`, data: Buffer.alloc(4096, 7) },
  { path: `${NAME}/Another.Show.S09E09.mp4`, data: Buffer.alloc(512, 7) },
];
const FILM: StreamRef = { kind: 'movie', tmdbId: 550 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 1399, season: 1, episode: 2 };
const PICK: TorrentPick = { infoHash: HASH, trackers: [], name: NAME, ref: FILM };
const OPEN = { timeoutMs: 1_000 };
const MP4: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };

const candidate: TorrentCandidate = {
  infoHash: HASH,
  name: `${NAME}.720p.WEB-DL`,
  fileName: null,
  fileIdx: null,
  seeds: 40,
  sizeBytes: 700_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: [],
  scoped: false,
  release: parseRelease(`${NAME}.720p.WEB-DL`),
};

let root: string;

function build() {
  const engine = new FakeTorrentEngine([{ infoHash: HASH, name: NAME, files: FILES }]);
  const records = new MemoryTorrentRecords();
  const streams = new TorrentStreams({
    engine,
    repo: records,
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    log: () => undefined,
    every: () => () => undefined,
  });
  const answer: FindAnswer = { candidates: [candidate], indexes: [], excluded: [], lastResort: [] };
  const source = new TorrentSource({ swarm: streams, find: async () => answer, probe: async () => MP4, tiers: [], localBase: () => 'http://127.0.0.1:1', log: () => undefined });
  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
  return { engine, records, streams, source, settled };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-holds-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a hold on a torrent is given back only by the caller that took it', () => {
  it('discard leaves a torrent nobody uses, and never one a session plays', async () => {
    const { streams, engine } = build();
    await streams.open(PICK, OPEN);
    await streams.use(HASH, [0]);
    // Another caller opened the same torrent and took no hold.
    await streams.open(PICK, OPEN);
    await streams.discard(HASH);
    expect(engine.removed).toEqual([]);
    expect(streams.status().swarm).toMatchObject([{ info_hash: HASH, users: 1 }]);
    await streams.drop(HASH);
    expect(engine.removed).toEqual([HASH]);
    await streams.open(PICK, OPEN);
    await streams.discard(HASH);
    expect(engine.removed).toEqual([HASH, HASH]);
  });

  it('a resolve that tries a torrent a session is playing, and cannot use it, leaves the session its torrent', async () => {
    const { source, streams, engine, settled } = build();
    const film = await source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0137523' });
    expect(film.ok).toBe(true);
    expect(streams.status().swarm).toMatchObject([{ info_hash: HASH, users: 1 }]);
    // The same torrent is listed for an episode: it holds no file of it, so this ask takes no hold and lets go.
    const episode = await source.resolve(EPISODE, { audioLang: 'en', imdbId: 'tt0944947' });
    expect(episode.ok).toBe(false);
    expect(episode.attempts.find((a) => a.provider.startsWith('Torrent: '))).toMatchObject({ outcome: 'no_stream', detail: 'the torrent holds no file of S01E02 (from torrentio)' });
    await settled();
    expect(engine.removed).toEqual([]);
    expect(streams.status().swarm).toMatchObject([{ info_hash: HASH, users: 1 }]);
    expect((await streams.serve(HASH, 0, 'bytes=0-9')).status).toBe(206);
  });

  it('a second play of the torrent that fails after taking its hold gives back its own hold only', async () => {
    const { streams, engine, records, settled } = build();
    const DUB: MediaProbe = { ...MP4, audio: [{ codec: 'aac', lang: 'ger' }] };
    const answer: FindAnswer = { candidates: [candidate], indexes: [], excluded: [], lastResort: [] };
    const playing = new TorrentSource({ swarm: streams, find: async () => answer, probe: async () => MP4, tiers: [], localBase: () => 'http://127.0.0.1:1', log: () => undefined });
    const refusing = new TorrentSource({ swarm: streams, find: async () => answer, probe: async () => DUB, tiers: [], localBase: () => 'http://127.0.0.1:1', log: () => undefined });
    expect((await playing.resolve(FILM, { audioLang: 'en', imdbId: 'tt0137523' })).ok).toBe(true);
    const out = await refusing.resolve(FILM, { audioLang: 'en', imdbId: 'tt0137523' });
    expect(out.ok).toBe(false);
    await settled();
    expect(engine.removed).toEqual([]);
    expect(streams.status().swarm).toMatchObject([{ info_hash: HASH, users: 1 }]);
    expect(records.rows).toHaveLength(1);
  });

  it('the torrents of a race that do not play leave no row behind', async () => {
    const OTHER = 'beef'.padEnd(40, '1');
    const DEAD = 'dead'.padEnd(40, '2');
    const engine = new FakeTorrentEngine([
      { infoHash: HASH, name: NAME, files: FILES },
      { infoHash: OTHER, name: 'Other', files: [{ path: 'Other/Fixture.Film.2026.mkv', data: Buffer.alloc(2048, 3) }] },
    ]);
    const records = new MemoryTorrentRecords();
    const streams = new TorrentStreams({ engine, repo: records, folder: new TorrentFolder(root), host: 'host-a', uploadKbps: 100, keepDays: 7, discovery: true, log: () => undefined, every: () => () => undefined });
    const answer: FindAnswer = {
      candidates: [candidate, { ...candidate, infoHash: OTHER, name: 'Other.720p' }, { ...candidate, infoHash: DEAD, name: 'Dead.720p' }],
      indexes: [],
      excluded: [],
      lastResort: [],
    };
    const source = new TorrentSource({ swarm: streams, find: async () => answer, probe: async () => MP4, tiers: [], localBase: () => 'http://127.0.0.1:1', log: () => undefined, settleMs: 20 });
    const out = await source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0137523' });
    expect(out.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(records.rows.map((r) => r.infoHash)).toEqual([out.ok ? out.torrent.infoHash : '']);
  });

  it("the line of the torrent that plays names the index it was found in and the others that list it", async () => {
    const { streams } = build();
    const lines: string[] = [];
    const answer: FindAnswer = { candidates: [{ ...candidate, index: 'knaben', listedBy: ['knaben', 'apibay'] }], indexes: [], excluded: [], lastResort: [] };
    const source = new TorrentSource({ swarm: streams, find: async () => answer, probe: async () => MP4, tiers: [], localBase: () => 'http://127.0.0.1:1', log: (l) => lines.push(l) });
    expect((await source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0137523' })).ok).toBe(true);
    expect(lines).toContainEqual(expect.stringMatching(/playing Fixture\.Film\.2026\.720p\.WEB-DL \(from knaben, also listed by apibay\)$/));
  });

  it('a use whose row cannot be written counts no user', async () => {
    const { streams, records } = build();
    await streams.open(PICK, OPEN);
    records.chosen = async () => {
      throw new Error('the database is away');
    };
    await expect(streams.use(HASH, [0])).rejects.toThrow('the database is away');
    expect(streams.status().swarm).toMatchObject([{ users: 0 }]);
  });
});
