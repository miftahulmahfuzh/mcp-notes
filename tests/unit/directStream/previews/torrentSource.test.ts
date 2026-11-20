import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSource } from '../../../../src/directStream/previews/local.js';
import type { PreviewSourceDeps } from '../../../../src/directStream/previews/sources.js';
import { readRemux, torrentSource, TorrentVideos, torrentVideos, type PreviewTorrents } from '../../../../src/directStream/previews/torrentSource.js';
import { PreviewNotYet, type LocalVideo, type PreviewList } from '../../../../src/directStream/previews/types.js';
import { SessionStore, type SessionTorrent, type StreamSession } from '../../../../src/directStream/sessions.js';
import { REMUX_DONE_FILE, remuxDir } from '../../../../src/directStream/torrent/remux.js';
import type { RemuxKeeper } from '../../../../src/directStream/torrent/remuxOnly.js';
import { TorrentStreams } from '../../../../src/directStream/torrent/service.js';
import { TorrentFolder } from '../../../../src/directStream/torrent/store.js';
import { TORRENT_LINGER_MS, type TorrentPick } from '../../../../src/directStream/torrent/types.js';
import type { ResolvedSource } from '../../../../src/directStream/types.js';
import { FakeTorrentEngine } from '../../../helpers/fakeTorrentEngine.js';
import { MemoryTorrentRecords } from '../../../helpers/memoryTorrentRecords.js';

const MIB = 1024 * 1024;
const BIG = 'b1'.repeat(20);
const SMALL = 'a1'.repeat(20);
const BIG_LENGTH = 40 * MIB;
const BIG_VIDEO = Buffer.alloc(BIG_LENGTH);
for (let i = 0; i < BIG_LENGTH; i += 4096) BIG_VIDEO[i] = (i / 4096) % 251;
for (let i = 0; i < 4096; i += 1) BIG_VIDEO[i] = i % 253;
const SMALL_VIDEO = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 249));
const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
const pick = (infoHash: string, name: string): TorrentPick => ({ infoHash, trackers: [], name, ref: { kind: 'movie', tmdbId: 550 } });

let root: string;
let clock: number;

function build(remuxes: RemuxKeeper | null = null) {
  const engine = new FakeTorrentEngine([
    { infoHash: BIG, name: 'Big', files: [{ path: 'Big/Big.en.srt', data: SRT }, { path: 'Big/Big.mp4', data: BIG_VIDEO }] },
    { infoHash: SMALL, name: 'Small', files: [{ path: 'Small/Small.en.srt', data: SRT }, { path: 'Small/Small.mkv', data: SMALL_VIDEO }] },
  ]);
  const folder = new TorrentFolder(root);
  const streams = new TorrentStreams({
    engine,
    repo: new MemoryTorrentRecords(),
    folder,
    host: 'host-a',
    uploadKbps: 100,
    keepDays: 7,
    discovery: true,
    remuxes,
    now: () => new Date(clock),
    log: () => undefined,
    every: () => () => undefined,
  });
  const videos = torrentVideos(streams, () => undefined)!;
  // What phase 1's LocalSource asks of the videos, recorded: `list` answers 'none' with no video, else 'partial'
  // (the sheets themselves are phase 1's), and every video handed out lands in `seen`.
  const seen: LocalVideo[] = [];
  const source = {
    list: async (session: StreamSession): Promise<PreviewList> => {
      const video = await videos.forSession(session);
      if (video === null) return { state: 'none', source: null, cues: [] };
      seen.push(video);
      return { state: 'partial', source: 'local', cues: [] };
    },
    wholeVideos: () => videos.whole(),
  };
  return { engine, folder, streams, seen, source };
}

function sessionOf(infoHash: string, fileIndex: number, durationS: number | null, manifestKind: 'mp4' | 'hls' = 'mp4'): StreamSession {
  const manifestUrl = `/api/stream/torrent/${infoHash}/f/${fileIndex}`;
  const torrent: SessionTorrent = {
    infoHash, fileIndex, selected: [fileIndex], name: 'x', index: null, seeds: null, state: 'downloading', height: null,
    manifestUrl, manifestKind, subtitles: [], subtitleRev: 0, candidates: [], durationS, candidate: null, held: false,
    imdbId: null, query: null, stop: new AbortController(),
  };
  return new SessionStore().createTorrent({ kind: 'movie', tmdbId: 550 }, standIn(manifestUrl, manifestKind), [], null, null, torrent);
}

function standIn(manifestUrl: string, kind: 'mp4' | 'hls'): ResolvedSource {
  return { provider: 'Torrent', embed_url: '', manifest_url: manifestUrl, manifest_kind: kind, headers: { referer: null, origin: null, user_agent: null }, subtitles: [], best_height: null, en_subtitle: false, took_s: null };
}

/** The file on disk with only `runs` written (the rest a hole), at its full length, as webtorrent leaves a download in progress. */
async function sparse(file: string, data: Buffer, runs: [number, number][]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const fd = await open(file, 'w');
  await fd.truncate(data.length);
  for (const [a, b] of runs) await fd.write(data, a, b - a, a);
  await fd.close();
}

/** A remux folder: init, `count` 6 s segments, the playlist, and done.json when whole. */
async function remuxOf(infoHash: string, fileIndex: number, count: number, whole: boolean): Promise<string> {
  const dir = remuxDir(root, infoHash, fileIndex);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'init.mp4'), 'init');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < count; i += 1) {
    const name = `seg-${String(i).padStart(5, '0')}.m4s`;
    await writeFile(path.join(dir, name), 'seg');
    lines.push('#EXTINF:6.000000,', name);
  }
  if (whole) lines.push('#EXT-X-ENDLIST');
  await writeFile(path.join(dir, 'index.m3u8'), `${lines.join('\n')}\n`);
  if (whole) await writeFile(path.join(dir, REMUX_DONE_FILE), '{}\n');
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-preview-source-'));
  clock = Date.parse('2026-11-20T12:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the torrent preview source (R1.3)', () => {
  it("is phase 1's LocalSource named torrent, and none with torrents off", () => {
    const { streams } = build();
    const deps = { torrents: streams, log: () => undefined } as unknown as PreviewSourceDeps;
    const made = torrentSource(deps);
    expect(made).toBeInstanceOf(LocalSource);
    expect(made?.name).toBe('torrent');
    expect(torrentSource({ ...deps, torrents: null })).toBeNull();
  });

  it("has nothing for a session that is not a torrent's, or whose length is not known", async () => {
    const { source, seen } = build();
    const cloud = new SessionStore().create({ kind: 'movie', tmdbId: 550 }, standIn('https://cdn.example/a.m3u8', 'hls'), []);
    expect(await source.list(cloud)).toEqual({ state: 'none', source: null, cues: [] });
    expect(await source.list(sessionOf(SMALL, 1, null))).toEqual({ state: 'none', source: null, cues: [] });
    expect(seen).toEqual([]);
  });

  it('a file whole on disk: the whole film, read from its path, sheets in notesd-previews/<index>', async () => {
    const { streams, engine, folder, source, seen } = build();
    await streams.open(pick(SMALL, 'Small'), { timeoutMs: 1000 });
    await streams.use(SMALL, [1]);
    engine.have(SMALL, 1);
    const file = folder.diskPath(SMALL, 'Small/Small.mkv')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SMALL_VIDEO);
    expect(await source.list(sessionOf(SMALL, 1, 100))).toMatchObject({ state: 'partial' });
    const video = seen[0]!;
    expect(video.key).toBe(`torrent-${SMALL}-1`);
    expect(video.dir).toBe(path.join(root, SMALL, 'notesd-previews', '1'));
    // Its home: phase 1's builder makes `dir` inside it and never makes it again after a delete.
    expect((video as LocalVideo & { home: string }).home).toBe(path.join(root, SMALL));
    expect(video.durationS).toBe(100);
    expect(await video.coverage()).toEqual([[0, 100]]);
    expect((await video.input(10, 20)).args).toEqual(['-ss', '10.000', '-t', '10.000', '-i', file]);
  });

  it('a file partly on disk: only stretches well inside the bytes on disk, and none before its header is there', async () => {
    const { streams, engine, source, seen } = build();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    engine.have(BIG, 1, [10 * MIB, 30 * MIB]);
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([]);
    engine.have(BIG, 1, [0, 10 * MIB]);
    await source.list(sessionOf(BIG, 1, 1000));
    // [0, 30 MiB) on disk, less the 8 MiB margin at its inner edge: 22/40 of 1000 s.
    expect(await seen.at(-1)!.coverage()).toEqual([[0, 550]]);
  });

  it('the gate serves only bytes on disk; a read of a missing byte fails at once, and the file is not offered again until that byte is there (R2.4)', async () => {
    const { streams, engine, folder, source, seen } = build();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    engine.have(BIG, 1, [0, 20 * MIB]);
    await sparse(folder.diskPath(BIG, 'Big/Big.mp4')!, BIG_VIDEO, [[0, 20 * MIB]]);
    await source.list(sessionOf(BIG, 1, 1000));
    const video = seen.at(-1)!;
    expect(await video.coverage()).toEqual([[0, 300]]);
    const input = await video.input(0, 100);
    const url = input.args.at(-1)!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(input.loopback).toBe(true);
    const inside = await fetch(url, { headers: { range: 'bytes=100-4195' } });
    expect(inside.status).toBe(206);
    expect(Buffer.from(await inside.arrayBuffer()).equals(BIG_VIDEO.subarray(100, 4196))).toBe(true);
    const edge = await fetch(url, { headers: { range: `bytes=${20 * MIB - 10}-` } });
    expect(edge.headers.get('content-range')).toBe(`bytes ${20 * MIB - 10}-${20 * MIB - 1}/${BIG_LENGTH}`);
    expect((await edge.arrayBuffer()).byteLength).toBe(10);
    const t0 = Date.now();
    expect((await fetch(url, { headers: { range: `bytes=${25 * MIB}-` } })).status).toBe(416);
    expect(Date.now() - t0).toBeLessThan(1000);
    // A gate miss is "not yet" (phase 1 never counts it against the sheet's tries), naming the first byte not on disk.
    await expect(input.cleanup!()).rejects.toBeInstanceOf(PreviewNotYet);
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([]);
    engine.have(BIG, 1, [20 * MIB, 30 * MIB]);
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([[0, 550]]);
  });

  it('making previews never touches the swarm: no open, no use, no selection, no read, and the torrent still leaves on time (R2.4)', async () => {
    const { streams, engine, folder, source, seen } = build();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    engine.have(BIG, 1, [0, 20 * MIB]);
    await sparse(folder.diskPath(BIG, 'Big/Big.mp4')!, BIG_VIDEO, [[0, 20 * MIB]]);
    await streams.release(BIG); // the page closed: nothing uses it, it lingers
    const before = { added: engine.added.length, selected: engine.selected.length, deselected: engine.deselected.length, reads: engine.reads.length };
    await source.list(sessionOf(BIG, 1, 1000));
    const video = seen.at(-1)!;
    await video.coverage();
    const input = await video.input(0, 100);
    await (await fetch(input.args.at(-1)!, { headers: { range: 'bytes=0-4095' } })).arrayBuffer();
    await input.cleanup?.();
    await source.wholeVideos();
    expect({ added: engine.added.length, selected: engine.selected.length, deselected: engine.deselected.length, reads: engine.reads.length }).toEqual(before);
    expect(streams.inUse(BIG)).toBe(false);
    clock += TORRENT_LINGER_MS;
    await streams.tick();
    expect(engine.removed).toContain(BIG);
    // Out of the swarm and unfinished: the pieces on disk are not known, so nothing new is offered and nothing reopens it.
    await source.list(sessionOf(BIG, 1, 1000));
    expect(await seen.at(-1)!.coverage()).toEqual([]);
    expect(engine.added.length).toBe(before.added);
  });

  it('a film that lives as its remux gets its sheets from the remux, in the same folder, and the sheets made before stay', async () => {
    const keeper: RemuxKeeper = { playable: () => true, blocker: async () => null };
    const { streams, engine, folder, source, seen } = build(keeper);
    await streams.open(pick(SMALL, 'Small'), { timeoutMs: 1000 });
    await streams.use(SMALL, [1]);
    engine.have(SMALL, 1);
    const file = folder.diskPath(SMALL, 'Small/Small.mkv')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SMALL_VIDEO);
    const dir = await remuxOf(SMALL, 1, 17, true);
    await streams.tick(); // ready
    await source.list(sessionOf(SMALL, 1, 100, 'hls'));
    const before = seen.at(-1)!;
    await mkdir(before.dir, { recursive: true });
    await writeFile(path.join(before.dir, 'sheet-00000.jpg'), 'jpeg');
    await streams.release(SMALL); // finished: leaves the swarm, and the original goes beside its whole remux
    await expect(stat(file)).rejects.toThrow();
    await source.list(sessionOf(SMALL, 1, 100, 'hls'));
    const after = seen.at(-1)!;
    expect([after.key, after.dir]).toEqual([before.key, before.dir]);
    expect((await stat(path.join(after.dir, 'sheet-00000.jpg'))).isFile()).toBe(true);
    expect(await after.coverage()).toEqual([[0, 100]]);
    expect((await after.input(13, 20)).args).toEqual(['-ss', '1.000', '-t', '7.000', '-i', `concat:${[path.join(dir, 'init.mp4'), path.join(dir, 'seg-00002.m4s'), path.join(dir, 'seg-00003.m4s')].join('|')}`]);
  });

  it("a growing remux offers what its playlist lists; a playlist naming anything else is not read", async () => {
    const dir = await remuxOf(SMALL, 1, 3, false);
    const view: PreviewTorrents = { root, onDisk: async () => null, wholeVideos: async () => [] };
    const video = await new TorrentVideos(view, () => undefined).forSession(sessionOf(SMALL, 1, 100, 'hls'));
    expect(await video!.coverage()).toEqual([[0, 18]]);
    await writeFile(path.join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\n../../../etc.m4s\n');
    expect(await readRemux(dir)).toBeNull();
  });

  it('the sweep lists whole files and whole remuxes, never a download still running', async () => {
    const keeper: RemuxKeeper = { playable: () => true, blocker: async () => null };
    const { streams, engine, folder, source } = build(keeper);
    await streams.open(pick(SMALL, 'Small'), { timeoutMs: 1000 });
    await streams.use(SMALL, [1]);
    engine.have(SMALL, 1);
    const file = folder.diskPath(SMALL, 'Small/Small.mkv')!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, SMALL_VIDEO);
    await streams.setDuration(SMALL, 100, 1);
    await streams.tick();
    await streams.open(pick(BIG, 'Big'), { timeoutMs: 1000 });
    await streams.use(BIG, [1]);
    await streams.setDuration(BIG, 1000, 1);
    engine.have(BIG, 1, [0, 20 * MIB]);
    expect((await source.wholeVideos()).map((v) => v.key)).toEqual([`torrent-${SMALL}-1`]);
    expect(await (await source.wholeVideos())[0]!.coverage()).toEqual([[0, 100]]);
  });
});
