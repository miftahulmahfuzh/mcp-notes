import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TorrentVideos, type PreviewTorrents } from '../../../../src/directStream/previews/torrentSource.js';
import { PreviewNotYet, type LocalVideo } from '../../../../src/directStream/previews/types.js';
import { SessionStore, type SessionTorrent, type StreamSession } from '../../../../src/directStream/sessions.js';
import { REMUX_DONE_FILE, remuxArgs, remuxDir } from '../../../../src/directStream/torrent/remux.js';
import type { FileOnDisk } from '../../../../src/directStream/torrent/service.js';
import type { ResolvedSource } from '../../../../src/directStream/types.js';

const FFMPEG = 'ffmpeg';
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0;
const HASH = 'd'.repeat(40);

let root: string;
let film: string;

/** Runs ffmpeg without blocking the event loop (the gate answers in this process). */
function run(args: string[]): Promise<{ code: number | null; out: Buffer; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks), ms: Date.now() - t0 }));
  });
}

/** The grey level of the frame 0.5 s into what `input` gives: the film's second, since every second has its own level. */
async function levelOf(input: string[]): Promise<{ code: number | null; level: number | null; ms: number }> {
  const r = await run(['-nostdin', '-v', 'error', '-xerror', ...input, '-an', '-ss', '0.5', '-frames:v', '1', '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-']);
  return { code: r.code, level: r.out.length === 1 ? r.out[0]! : null, ms: r.ms };
}

function session(durationS: number): StreamSession {
  const manifestUrl = `/api/stream/torrent/${HASH}/f/0`;
  const torrent: SessionTorrent = {
    infoHash: HASH, fileIndex: 0, selected: [0], name: 'x', index: null, seeds: null, state: 'downloading', height: null,
    manifestUrl, manifestKind: 'mp4', subtitles: [], subtitleRev: 0, candidates: [], durationS, candidate: null, held: false,
    imdbId: null, query: null, stop: new AbortController(),
  };
  const source = { provider: 'Torrent', embed_url: '', manifest_url: manifestUrl, manifest_kind: 'mp4', headers: { referer: null, origin: null, user_agent: null }, subtitles: [], best_height: null, en_subtitle: false, took_s: null } as ResolvedSource;
  return new SessionStore().createTorrent({ kind: 'movie', tmdbId: 550 }, source, [], null, null, torrent);
}

/** The LocalVideo the source makes for `disk` (and the remux folder under root, when there is one). */
async function videoFor(disk: FileOnDisk | null): Promise<LocalVideo> {
  const view: PreviewTorrents = { root, onDisk: async () => disk, wholeVideos: async () => [] };
  const video = await new TorrentVideos(view, () => undefined).forSession(session(40));
  if (video === null) throw new Error('no video');
  return video;
}

beforeAll(async () => {
  if (!hasFfmpeg) return;
  root = await mkdtemp(path.join(os.tmpdir(), 'torrent-preview-ffmpeg-'));
  film = path.join(root, HASH, 'Film.mp4');
  await mkdir(path.dirname(film), { recursive: true });
  // 40 s, a grey level per second (20 + 20 × (second mod 10)), H.264 + AAC, the header first.
  const made = spawnSync(FFMPEG, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', "nullsrc=s=64x36:r=25:d=40,geq=lum='20+20*mod(floor(T)\\,10)':cb=128:cr=128,format=yuv420p",
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-g', '50', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', film,
  ]);
  expect(made.status).toBe(0);
}, 60_000);
afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!hasFfmpeg)('torrent previews with the real ffmpeg', () => {
  it("the remux's stretch shows the frame the file shows at the same second", async () => {
    const dir = remuxDir(root, HASH, 0);
    await mkdir(dir, { recursive: true });
    expect(spawnSync(FFMPEG, remuxArgs({ input: film, dir, videoCodec: 'h264', audioStream: 0 })).status).toBe(0);
    await writeFile(path.join(dir, REMUX_DONE_FILE), '{}\n');
    const length = (await stat(film)).size;
    const fromFile = await videoFor({ kind: 'whole', path: film, length });
    // Remux only: the original is gone, the remux is read.
    const fromRemux = await videoFor(null);
    expect(await fromRemux.coverage()).toEqual([[0, 40]]);
    const levels: number[] = [];
    for (const startS of [7, 14, 21, 33]) {
      const want = await levelOf((await fromFile.input(startS, startS + 6)).args);
      const got = await levelOf((await fromRemux.input(startS, startS + 6)).args);
      expect([want.code, got.code]).toEqual([0, 0]);
      expect(Math.abs(got.level! - want.level!)).toBeLessThanOrEqual(4);
      levels.push(want.level!);
    }
    // Every second asked has its own level, so a stretch read from the wrong second would not match.
    for (let i = 0; i < levels.length; i += 1) for (let j = i + 1; j < levels.length; j += 1) expect(Math.abs(levels[i]! - levels[j]!)).toBeGreaterThan(10);
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('a file partly on disk reads the stretch on disk, and a stretch past it fails at once with the missing byte named', async () => {
    const length = (await stat(film)).size;
    const cut = Math.floor(length / 2);
    const partial = path.join(root, HASH, 'Partial.mp4');
    const bytes = await readFile(film);
    const fd = await open(partial, 'w');
    await fd.truncate(length);
    await fd.write(bytes, 0, cut, 0);
    await fd.close();
    const video = await videoFor({ kind: 'partial', path: partial, length, ranges: [[0, cut]] });
    const want = await levelOf((await (await videoFor({ kind: 'whole', path: film, length })).input(3, 9)).args);

    const near = await video.input(3, 9);
    const got = await levelOf(near.args);
    // ffmpeg's first, open-ended read was cut short at the bytes on disk, so cleanup may say "not yet"; phase 1's
    // builder keeps a sheet whose ffmpeg exited 0 whatever cleanup says.
    await near.cleanup!().catch((err: unknown) => expect(err).toBeInstanceOf(PreviewNotYet));
    expect(got.code).toBe(0);
    expect(Math.abs(got.level! - want.level!)).toBeLessThanOrEqual(4);

    const far = await video.input(33, 39);
    const failed = await levelOf(far.args);
    expect(failed.code).not.toBe(0);
    expect(failed.level).toBeNull();
    expect(failed.ms).toBeLessThan(10_000);
    const missing = await far.cleanup!().then(() => null, (err: unknown) => err);
    expect(missing).toBeInstanceOf(PreviewNotYet);
    expect(Number(/byte (\d+) /.exec((missing as Error).message)?.[1])).toBeGreaterThanOrEqual(cut);
    await copyFile(film, partial); // not needed further; keeps the folder tidy for afterAll
  }, 60_000);
});
