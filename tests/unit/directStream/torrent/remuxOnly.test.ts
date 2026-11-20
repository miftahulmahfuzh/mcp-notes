import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaProbe } from '../../../../src/directStream/torrent/probe.js';
import { REMUX_DONE_FILE, REMUX_PROBE_FILE, remuxDir } from '../../../../src/directStream/torrent/remux.js';
import { RemuxOnly, remuxWholeBlocker } from '../../../../src/directStream/torrent/remuxOnly.js';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import type { TorrentPick } from '../../../../src/directStream/torrent/types.js';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';
import { eventPlaylist } from '../remuxFakes.js';

const FILM_HASH = 'f11a'.padEnd(40, '0');
const FILM_NAME = 'Fixture.Film.2026.1080p.BluRay.x265.DTS';
const FILM_PATH = `${FILM_NAME}/${FILM_NAME}.mkv`;
const FILM = { kind: 'movie', tmdbId: 550 } as const satisfies StreamRef;
const PACK = 'facade'.padEnd(40, '0');
const SHOW = 'Fixture.Show.S01.1080p';
const data = (seed: number, n = 4096): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i + seed) % 251));
const FILM_DATA = data(7, 64 * 1024);
const PACK_FILES = [
  { path: `${SHOW}/Fixture.Show.S01E01.mkv`, data: data(1) },
  { path: `${SHOW}/Fixture.Show.S01E02.mkv`, data: data(2) },
];
const ep = (episode: number): StreamRef => ({ kind: 'tv', tmdbId: 1399, season: 1, episode });
const OPEN = { timeoutMs: 1_000 };
/** Twenty 6 s segments: a 120 s film. */
const SEGMENTS = 20;
const PROBE: MediaProbe = { container: 'matroska,webm', video: { codec: 'hevc', height: 1080 }, audio: [{ codec: 'dts', lang: 'eng' }], subtitles: [], durationS: 120, direct: false };
const WITH_ENGLISH_TRACK: MediaProbe = { ...PROBE, subtitles: [{ index: 2, codec: 'subrip', lang: 'eng', text: true, title: null, forced: false, hearingImpaired: false }] };

let root: string;
let clock: number;

function build(o: { records?: MemoryTorrentRecords; probes?: string[] } = {}) {
  const records = o.records ?? new MemoryTorrentRecords();
  const engine = new FakeTorrentEngine([
    { infoHash: FILM_HASH, name: FILM_NAME, files: [{ path: FILM_PATH, data: FILM_DATA }] },
    { infoHash: PACK, name: SHOW, files: PACK_FILES },
  ]);
  const folder = new TorrentFolder(root);
  const lines: string[] = [];
  const probed = o.probes ?? [];
  const streams = new TorrentStreams({
    engine,
    repo: records,
    folder,
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    remuxes: new RemuxOnly({
      dir: root,
      probe: async (url) => {
        probed.push(url);
        return PROBE;
      },
    }),
    now: () => new Date(clock),
    log: (line) => lines.push(line),
    every: () => () => undefined,
  });
  return { streams, engine, records, folder, lines };
}

async function put(folder: TorrentFolder, hash: string, filePath: string, bytes: Buffer | string): Promise<void> {
  const file = folder.diskPath(hash, filePath)!;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

/** A remux of a file as TorrentRemux leaves it: init, segments, the closed playlist, and (unless told) done.json and the probe. */
async function remuxOf(hash: string, index: number, o: { segments?: number; done?: boolean; probe?: MediaProbe | null; missing?: string } = {}): Promise<string> {
  const dir = remuxDir(root, hash, index);
  await mkdir(dir, { recursive: true });
  const n = o.segments ?? SEGMENTS;
  await writeFile(path.join(dir, 'init.mp4'), 'init');
  for (let i = 0; i < n; i++) {
    const name = `seg-${String(i).padStart(5, '0')}.m4s`;
    if (name !== o.missing) await writeFile(path.join(dir, name), `segment ${i} `.repeat(50));
  }
  await writeFile(path.join(dir, 'index.m3u8'), eventPlaylist(n, true));
  if (o.done !== false) await writeFile(path.join(dir, REMUX_DONE_FILE), '{}\n');
  if (o.probe !== null) await writeFile(path.join(dir, REMUX_PROBE_FILE), JSON.stringify(o.probe ?? PROBE));
  return dir;
}

/** A finished download of the film on this host, its file whole on disk. */
async function finishedFilm(records: MemoryTorrentRecords, folder: TorrentFolder): Promise<void> {
  const slot = { infoHash: FILM_HASH, season: 0, episode: 0 };
  const at = new Date(clock - 3_600_000);
  await records.record('host-a', { infoHash: FILM_HASH, ref: FILM, name: FILM_NAME, release: FILM_NAME, trackers: [] }, at);
  await records.chosen('host-a', slot, { files: [{ index: 0, path: FILM_PATH, length: FILM_DATA.length }], fileIndex: 0, fileLength: FILM_DATA.length }, at);
  await records.ready('host-a', slot, FILM_DATA.length, at);
  await records.duration('host-a', slot, 120, at);
  await put(folder, FILM_HASH, FILM_PATH, FILM_DATA);
}

const filmPick: TorrentPick = { infoHash: FILM_HASH, trackers: [], name: FILM_NAME, ref: FILM };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-remux-only-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a remuxed film keeps its remux only', () => {
  it('deletes the original once the torrent leaves the swarm with its remux whole, marks the file, and says how much went', async () => {
    const { streams, engine, records, folder, lines } = build();
    await streams.open(filmPick, OPEN);
    await streams.use(FILM_HASH, [0]);
    engine.have(FILM_HASH, 0);
    await put(folder, FILM_HASH, FILM_PATH, FILM_DATA);
    await streams.setDuration(FILM_HASH, 120, 0);
    await remuxOf(FILM_HASH, 0);
    // The remux finished while the session still plays: the original stays while the torrent is in the swarm.
    expect(await streams.dropOriginals(FILM_HASH, { fileIndex: 0 })).toBe(0);
    await streams.tick();
    expect(existsSync(folder.diskPath(FILM_HASH, FILM_PATH)!)).toBe(true);
    // The page closes: the finished torrent leaves the swarm, and its original goes with nothing reading it.
    await streams.release(FILM_HASH);
    expect(engine.removed).toEqual([FILM_HASH]);
    expect(existsSync(folder.diskPath(FILM_HASH, FILM_PATH)!)).toBe(false);
    expect(await readdir(folder.dirOf(FILM_HASH))).toEqual(['notesd-remux']);
    expect(records.rows[0]).toMatchObject({ state: 'ready', files: [{ index: 0, path: FILM_PATH, remuxed: true }] });
    expect(lines.filter((l) => l.includes('deleted the original'))).toEqual([
      `[notesd] torrent: deleted the original of ${FILM_NAME} (${FILM_NAME}.mkv, 0 MB): its whole remux plays in its place, one copy on disk`,
    ]);
    // Every reader asks for the remux now: no original path, the file route says so, the download is still whole.
    expect(await streams.filePath(FILM_HASH, 0)).toBeNull();
    expect(await streams.remuxOnly(FILM_HASH, 0)).toBe(true);
    const route = await streams.serve(FILM_HASH, 0, null);
    expect(route.status).toBe(410);
    expect(await route.json()).toMatchObject({ error: 'remuxed' });
    expect(await streams.find(FILM)).toMatchObject({ state: 'ready', fileIndex: 0 });
    expect(await streams.map(FILM_HASH)).toMatchObject({ duration_s: 120, ranges: [[0, 120]] });
  });

  it('plays again with no swarm after a restart, and a later use never fetches the original again', async () => {
    const records = new MemoryTorrentRecords();
    const first = build({ records });
    await finishedFilm(records, first.folder);
    await remuxOf(FILM_HASH, 0);
    expect(await first.streams.sweepRemuxed()).toBe(1);
    // A new daemon: the row says the file lives as its remux.
    const { streams, engine } = build({ records });
    const handle = await streams.open(filmPick, OPEN);
    expect(handle.live).toBe(false);
    await streams.use(FILM_HASH, [0]);
    expect(engine.added).toEqual([]);
    expect(engine.selected).toEqual([]);
  });

  it('leaves a remuxed episode of a pack unselected when the pack is in the swarm for another episode', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, engine, folder } = build({ records });
    await streams.open({ infoHash: PACK, trackers: [], name: SHOW, ref: ep(1) }, OPEN);
    await streams.use(PACK, [0]);
    engine.have(PACK, 0);
    await put(folder, PACK, PACK_FILES[0]!.path, PACK_FILES[0]!.data);
    await remuxOf(PACK, 0, { segments: 1, probe: { ...PROBE, durationS: 6 } });
    await streams.tick();
    await streams.release(PACK);
    expect(records.rows.find((r) => r.episode === 1)?.files).toEqual([{ index: 0, path: PACK_FILES[0]!.path, length: 4096, remuxed: true }]);
    // E02 is fetched, and E01's page is reloaded meanwhile: E01's file is not asked of the swarm again.
    await streams.open({ infoHash: PACK, trackers: [], name: SHOW, ref: ep(2) }, OPEN);
    await streams.use(PACK, [1]);
    await streams.use(PACK, [0]);
    expect(engine.selected.map((s) => s.indexes)).toEqual([[0], [1], []]);
    // An edge piece E02 shares with E01 lands at E01's path; leaving the swarm takes it away, it is no file of E01's.
    await put(folder, PACK, PACK_FILES[0]!.path, 'edge bytes');
    engine.have(PACK, 1);
    await put(folder, PACK, PACK_FILES[1]!.path, PACK_FILES[1]!.data);
    await streams.tick();
    await streams.release(PACK);
    await streams.release(PACK);
    expect(existsSync(folder.diskPath(PACK, PACK_FILES[0]!.path)!)).toBe(false);
    expect(existsSync(folder.diskPath(PACK, PACK_FILES[1]!.path)!)).toBe(true);
  });
});

describe('the sweep at start', () => {
  it('frees the originals already standing beside a whole remux, never one of a torrent in use, and logs each with its size', async () => {
    const records = new MemoryTorrentRecords();
    const probes: string[] = [];
    const { streams, folder, lines } = build({ records, probes });
    await finishedFilm(records, folder);
    // Made before the probe was kept: ffprobe reads the whole original once, and the probe is kept from then on.
    const dir = await remuxOf(FILM_HASH, 0, { probe: null });
    expect(await streams.start()).toBe(0);
    expect(probes).toEqual([folder.diskPath(FILM_HASH, FILM_PATH)]);
    expect(existsSync(path.join(dir, REMUX_PROBE_FILE))).toBe(true);
    expect(existsSync(folder.diskPath(FILM_HASH, FILM_PATH)!)).toBe(false);
    expect(lines.filter((l) => l.includes('deleted the original'))).toHaveLength(1);
  });

  it('keeps an original while its torrent is in the swarm (a pack fetching the next episode), and frees it when it leaves', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder } = build({ records });
    const slot = { infoHash: PACK, season: 1, episode: 1 };
    const at = new Date(clock - 3_600_000);
    await records.record('host-a', { infoHash: PACK, ref: ep(1), name: SHOW, release: SHOW, trackers: [] }, at);
    await records.chosen('host-a', slot, { files: [{ index: 0, path: PACK_FILES[0]!.path, length: 4096 }], fileIndex: 0, fileLength: 4096 }, at);
    await records.ready('host-a', slot, 4096, at);
    await put(folder, PACK, PACK_FILES[0]!.path, PACK_FILES[0]!.data);
    await remuxOf(PACK, 0, { segments: 1, probe: { ...PROBE, durationS: 6 } });
    await streams.open({ infoHash: PACK, trackers: [], name: SHOW, ref: ep(2) }, OPEN);
    expect(await streams.sweepRemuxed()).toBe(0);
    expect(existsSync(folder.diskPath(PACK, PACK_FILES[0]!.path)!)).toBe(true);
    await streams.release(PACK);
    expect(existsSync(folder.diskPath(PACK, PACK_FILES[0]!.path)!)).toBe(false);
    expect(records.rows.find((r) => r.episode === 1)?.files[0]?.remuxed).toBe(true);
  });

  it('keeps an original whose remux is not whole, or whose English text track is not in a complete cue feed, and says why', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder, lines } = build({ records });
    await finishedFilm(records, folder);
    // No done.json: an unfinished remux is no remux; nothing is said.
    const dir = await remuxOf(FILM_HASH, 0, { done: false });
    expect(await streams.sweepRemuxed()).toBe(0);
    expect(lines).toEqual([]);
    // Finished, but short of the film; then a segment missing.
    await writeFile(path.join(dir, REMUX_DONE_FILE), '{}');
    await writeFile(path.join(dir, 'index.m3u8'), eventPlaylist(15, true));
    expect(await streams.sweepRemuxed()).toBe(0);
    await remuxOf(FILM_HASH, 0, { missing: 'seg-00007.m4s' });
    await rm(path.join(dir, 'seg-00007.m4s'));
    expect(await streams.sweepRemuxed()).toBe(0);
    // Whole, but the file's English subtitle track is extracted only halfway.
    await remuxOf(FILM_HASH, 0, { probe: WITH_ENGLISH_TRACK });
    const cues = path.join(folder.dirOf(FILM_HASH), 'notesd-cues');
    await mkdir(cues, { recursive: true });
    await writeFile(path.join(cues, 'embedded-0-2.jsonl'), '{"start_s":1,"end_s":2,"text":"Hello."}\n');
    expect(await streams.sweepRemuxed()).toBe(0);
    expect(lines).toEqual([
      `[notesd] torrent: kept the original of ${FILM_NAME} beside its remux: its remux holds 90 s of the 120 s film`,
      `[notesd] torrent: kept the original of ${FILM_NAME} beside its remux: its remux is missing seg-00007.m4s`,
      `[notesd] torrent: kept the original of ${FILM_NAME} beside its remux: its English subtitle track (stream 2) is not extracted to the end yet, and the remux holds no subtitle track`,
    ]);
    expect(existsSync(folder.diskPath(FILM_HASH, FILM_PATH)!)).toBe(true);
    // The feed complete (a later play extracted it): the six-hourly clearing frees the original.
    await writeFile(path.join(cues, 'embedded-0-2.jsonl'), '{"start_s":1,"end_s":2,"text":"Hello."}\n{"complete":true}\n');
    expect(await streams.prune()).toBe(0);
    expect(existsSync(folder.diskPath(FILM_HASH, FILM_PATH)!)).toBe(false);
    expect(records.rows[0]!.files[0]?.remuxed).toBe(true);
  });

  it('downloads again a file marked as its remux whose remux is gone', async () => {
    const records = new MemoryTorrentRecords();
    const { streams, folder, lines } = build({ records });
    await finishedFilm(records, folder);
    const dir = await remuxOf(FILM_HASH, 0);
    await streams.sweepRemuxed();
    await rm(dir, { recursive: true });
    await streams.sweepRemuxed();
    expect(records.rows[0]).toMatchObject({ state: 'downloading', files: [{ index: 0, path: FILM_PATH, length: FILM_DATA.length }] });
    expect(records.rows[0]!.files[0]).not.toHaveProperty('remuxed');
    expect(lines.at(-1)).toBe(`[notesd] torrent: ${FILM_NAME} lived as its remux, and the remux is gone; it downloads again on the next play`);
  });

  it('does nothing without a remux keeper (the remux off)', async () => {
    const records = new MemoryTorrentRecords();
    const folder = new TorrentFolder(root);
    await finishedFilm(records, folder);
    await remuxOf(FILM_HASH, 0);
    const streams = new TorrentStreams({ engine: new FakeTorrentEngine(), repo: records, folder, host: 'host-a', uploadKbps: 100, keepDays: 7, discovery: true, now: () => new Date(clock), log: () => undefined, every: () => () => undefined });
    expect(await streams.sweepRemuxed()).toBe(0);
    expect(await streams.remuxOnly(FILM_HASH, 0)).toBe(false);
    expect(existsSync(folder.diskPath(FILM_HASH, FILM_PATH)!)).toBe(true);
  });
});

describe('remuxWholeBlocker', () => {
  it('wants done.json, a closed playlist, every part on disk and the film covered within a segment or two', async () => {
    const dir = await remuxOf(FILM_HASH, 0);
    expect(await remuxWholeBlocker(dir, 120)).toBeNull();
    expect(await remuxWholeBlocker(dir, 131)).toBeNull();
    expect(await remuxWholeBlocker(dir, 140)).toBe('its remux holds 120 s of the 140 s film');
    await writeFile(path.join(dir, 'index.m3u8'), eventPlaylist(SEGMENTS, false));
    expect(await remuxWholeBlocker(dir, 120)).toBe('its remux playlist is not closed');
    await rm(path.join(dir, REMUX_DONE_FILE));
    expect(await remuxWholeBlocker(dir, 120)).toBe('its remux is not finished');
  });
});
