import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRelease, type TorrentCandidate } from '../../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../../src/directStream/torrent/probe.js';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentSource, type FindAnswer } from '../../../../src/directStream/torrent/source.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

/**
 * The soak of 2026-11-27 (note 2-IFP, rows 15 and 20): season packs and a 4-file film took in tens of MB from many
 * peers and the probed file's header never arrived (Babylon Berlin S01E01: 9-file pack, 25.2 MB, 14 peers, 78.6 s).
 * `use` selected the whole episode, and nothing asked for its last pieces before ffprobe seeked there. The probe
 * must find the probed file's first and last pieces asked for first, and only that file's.
 */

const PACK = 'babe1'.padEnd(40, '0');
const SHOW = 'Babylon.Berlin.S01.1080p.x265-Ghost';
const data = (seed: number): Buffer => Buffer.from(Array.from({ length: 4096 }, (_, i) => (i + seed) % 251));
const FILES = [
  ...Array.from({ length: 8 }, (_, i) => ({ path: `${SHOW}/Babylon.Berlin.S01E0${i + 1}.1080p.x265-Ghost.mkv`, data: data(i) })),
  { path: `${SHOW}/Babylon.Berlin.S01E01.eng.srt`, data: data(40) },
  { path: `${SHOW}/RARBG.txt`, data: data(50) },
];
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 66980, season: 1, episode: 1 };
const MKV: MediaProbe = { container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'ger' }], subtitles: [], durationS: 3_000, direct: false };

const candidate: TorrentCandidate = {
  infoHash: PACK,
  name: SHOW,
  fileName: null,
  fileIdx: null,
  seeds: 40,
  sizeBytes: 9_000_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: [],
  scoped: false,
  release: parseRelease(SHOW),
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-head-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function build() {
  const engine = new FakeTorrentEngine([{ infoHash: PACK, name: SHOW, files: FILES }]);
  const logged: string[] = [];
  const streams = new TorrentStreams({
    engine,
    repo: new MemoryTorrentRecords(),
    folder: new TorrentFolder(root),
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    now: () => new Date('2026-11-27T06:54:00Z'),
    log: (line) => void logged.push(line),
    every: () => () => undefined,
  });
  /** What the engine had been asked for when ffprobe started reading. */
  let atProbe: { headFirst: number[]; selected: number[][] } | null = null;
  const answer: FindAnswer = { candidates: [candidate], indexes: [{ index: 'torrentio', outcome: 'ok', detail: '1 candidate', took_s: 0.1, listed: 1 }], excluded: [], lastResort: [] };
  const source = new TorrentSource({
    swarm: streams,
    find: async () => answer,
    probe: async () => {
      atProbe = { headFirst: engine.headFirst.map((h) => h.index), selected: engine.selected.map((s) => s.indexes) };
      return MKV;
    },
    tiers: [],
    localBase: () => 'http://127.0.0.1:4321',
    settleMs: 0,
    log: (line) => void logged.push(line),
    remux: null,
  });
  return { engine, source, logged, atProbe: () => atProbe };
}

describe('a multi-file torrent: the probed file\'s head and tail come first', () => {
  it('asks the engine for the episode\'s first and last pieces before ffprobe reads, and for no other file\'s', async () => {
    const t = build();
    await t.source.resolve(EPISODE, { audioLang: 'de', imdbId: 'tt4378376' });
    expect(t.atProbe()).not.toBeNull();
    expect(t.atProbe()!.selected).toEqual([[0, 8]]);
    expect(t.atProbe()!.headFirst).toEqual([0]);
  });

  it('logs the file chosen for the probe, with its place in the torrent', async () => {
    const t = build();
    await t.source.resolve(EPISODE, { audioLang: 'de', imdbId: 'tt4378376' });
    const line = t.logged.find((l) => l.includes('probing'));
    expect(line).toBeDefined();
    expect(line).toContain('Babylon.Berlin.S01E01.1080p.x265-Ghost.mkv');
    expect(line).toContain('file 0 of 10');
    expect(line).toContain(PACK.slice(0, 8));
  });
});
