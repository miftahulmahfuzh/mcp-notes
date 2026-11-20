import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canRemux,
  pickAudioStream,
  REMUX_DONE_FILE,
  REMUX_PROBE_FILE,
  remuxArgs,
  remuxDir,
  RemuxError,
  TorrentRemux,
  type RemuxProbe,
  type RemuxRequest,
  type SpawnFfmpeg,
} from '../../../src/directStream/torrent/remux.js';
import { eventPlaylist, fakeFfmpeg } from './remuxFakes.js';

const HASH = 'b'.repeat(40);
const MKV: RemuxProbe = { video: { codec: 'h264' }, audio: [{ lang: 'spa' }, { lang: 'eng' }], durationS: 5400.46 };
const URL3 = `/api/stream/torrent/${HASH}/hls/3/index.m3u8?remux=1&total_s=5400.5`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-remux-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<RemuxRequest> = {}): RemuxRequest => ({ infoHash: HASH, fileIndex: 3, input: `http://127.0.0.1:7317/api/stream/torrent/${HASH}/f/3`, probe: MKV, audioLang: 'en', ...over });
const remuxWith = (spawn: SpawnFfmpeg, over: { firstSegmentTimeoutMs?: number } = {}) => new TorrentRemux({ dir, spawn, pollMs: 5, log: () => undefined, ...over });
const text = async (res: Response | null): Promise<string> => (res === null ? 'null' : res.text());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('which files the remux can help, and with what', () => {
  it('helps H.264, HEVC, AV1 and VP9 video; not MPEG-2, VC-1, MPEG-4 Part 2 or a file without video', () => {
    for (const codec of ['h264', 'hevc', 'av1', 'vp9', 'HEVC']) expect(canRemux({ ...MKV, video: { codec } })).toBe(true);
    for (const codec of ['mpeg2video', 'vc1', 'mpeg4']) expect(canRemux({ ...MKV, video: { codec } })).toBe(false);
    expect(canRemux({ ...MKV, video: null })).toBe(false);
  });

  it("keeps the audio in the title's original language, else the first, and none when the file has no audio", () => {
    expect(pickAudioStream([{ lang: 'spa' }, { lang: 'eng' }], 'en')).toBe(1);
    expect(pickAudioStream([{ lang: 'jpn' }, { lang: 'eng' }], 'ja')).toBe(0);
    expect(pickAudioStream([{ lang: 'fre' }, { lang: 'ger' }], 'de')).toBe(1);
    expect(pickAudioStream([{ lang: null }, { lang: 'eng' }], 'ko')).toBe(0);
    expect(pickAudioStream([{ lang: 'eng' }], null)).toBe(0);
    expect(pickAudioStream([], 'en')).toBeNull();
  });

  it('copies the video (hvc1 for HEVC), converts the chosen audio to AAC stereo, and writes an EVENT playlist of fMP4 segments', () => {
    const args = remuxArgs({ input: 'http://127.0.0.1:1/f/0', dir: '/d', videoCodec: 'hevc', audioStream: 1 });
    const has = (...seq: string[]) => args.join('\u0000').includes(seq.join('\u0000'));
    expect(has('-xerror')).toBe(true);
    expect(has('-reconnect', '1')).toBe(true);
    expect(has('-map', '0:v:0', '-map', '0:a:1')).toBe(true);
    expect(has('-c:v', 'copy', '-tag:v', 'hvc1')).toBe(true);
    expect(has('-c:a', 'aac', '-ac', '2')).toBe(true);
    expect(has('-hls_playlist_type', 'event', '-hls_segment_type', 'fmp4')).toBe(true);
    expect(args.at(-1)).toBe('/d/index.m3u8');
    const plain = remuxArgs({ input: '/data/film.mkv', dir: '/d', videoCodec: 'h264', audioStream: null });
    expect(plain).toContain('-an');
    expect(plain).not.toContain('-reconnect');
    expect(plain).not.toContain('-tag:v');
    expect(plain).not.toContain('-c:a');
  });
});

describe('TorrentRemux', () => {
  it("answers the playlist's address once the first segment is written, with the film's length on it", async () => {
    const f = fakeFfmpeg();
    const started = remuxWith(f.spawn).start(request());
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    let answered = false;
    void started.then(() => {
      answered = true;
    });
    await sleep(30);
    expect(answered).toBe(false);
    await f.runs[0]!.write(1);
    await expect(started).resolves.toEqual({ manifestUrl: URL3, durationS: 5400.46 });
    expect(f.runs[0]!.args).toContain(request().input);
    expect(f.runs[0]!.dir).toBe(remuxDir(dir, HASH, 3));
  });

  it('serves a growing playlist without EXT-X-ENDLIST, and closes it only after a clean exit', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    // ffmpeg writes EXT-X-ENDLIST as it exits; until it has exited 0 the page must not read the film as ended.
    await f.runs[0]!.write(2, true);
    expect(await text(await remux.file(HASH, 3, 'index.m3u8', null))).not.toContain('#EXT-X-ENDLIST');
    expect(await remux.map(HASH)).toEqual({ duration_s: 5400.5, ranges: [[0, 12]] });
    f.runs[0]!.exit(0);
    await vi.waitFor(() => expect(existsSync(path.join(remuxDir(dir, HASH, 3), REMUX_DONE_FILE))).toBe(true));
    const done = await remux.file(HASH, 3, 'index.m3u8', null);
    expect(done?.headers.get('cache-control')).toBe('no-store');
    expect(done?.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect((await text(done)).trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
  });

  it('never closes the playlist of a run ffmpeg ended with an error (a dead input)', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    await f.runs[0]!.write(2, true);
    f.runs[0]!.exit(251);
    await sleep(30);
    expect(existsSync(path.join(remuxDir(dir, HASH, 3), REMUX_DONE_FILE))).toBe(false);
    expect(await text(await remux.file(HASH, 3, 'index.m3u8', null))).not.toContain('#EXT-X-ENDLIST');
  });

  it('plays a finished remux again from disk with no ffmpeg, after a restart too', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 2 });
    const first = remuxWith(f.spawn);
    await first.start(request());
    f.runs[0]!.exit(0);
    await vi.waitFor(() => expect(existsSync(path.join(remuxDir(dir, HASH, 3), REMUX_DONE_FILE))).toBe(true));
    await expect(first.start(request())).resolves.toEqual({ manifestUrl: URL3, durationS: 5400.46 });
    const restarted = remuxWith(() => {
      throw new Error('ffmpeg must not run for a finished remux');
    });
    await expect(restarted.start(request())).resolves.toEqual({ manifestUrl: URL3, durationS: 5400.46 });
    expect(f.runs).toHaveLength(1);
    expect(await restarted.map(HASH)).toEqual({ duration_s: 5400.5, ranges: [[0, 12]] });
  });

  it('keeps the probe beside the remux and tells its listeners once the remux is whole', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    const done: string[] = [];
    remux.whenDone((infoHash, fileIndex) => done.push(`${infoHash}:${fileIndex}`));
    await remux.start(request());
    expect(await remux.savedProbe(HASH, 3)).toBeNull(); // RemuxProbe alone is not a whole MediaProbe
    expect(existsSync(path.join(remuxDir(dir, HASH, 3), REMUX_PROBE_FILE))).toBe(true);
    expect(done).toEqual([]);
    f.runs[0]!.exit(0);
    await vi.waitFor(() => expect(done).toEqual([`${HASH}:3`]));
    // A remux finished before the probe was kept gets it on its next play from disk.
    await rm(path.join(remuxDir(dir, HASH, 3), REMUX_PROBE_FILE));
    const probe = { container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'ac3', lang: 'eng' }], subtitles: [], durationS: 12, direct: false };
    await remuxWith(f.spawn).start(request({ probe }));
    expect(await remux.savedProbe(HASH, 3)).toEqual(probe);
  });

  it('fails the start with ffmpeg\'s last words when it ends before a segment', async () => {
    const f = fakeFfmpeg({ exitAtStart: 1 });
    const err = await remuxWith(f.spawn).start(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemuxError);
    expect((err as RemuxError).code).toBe('remux_failed');
    expect((err as RemuxError).message).toContain('Invalid data found');
  });

  it('stops ffmpeg and fails with remux_timeout when no segment comes in time', async () => {
    const f = fakeFfmpeg();
    const err = await remuxWith(f.spawn, { firstSegmentTimeoutMs: 40 }).start(request()).catch((e: unknown) => e);
    expect((err as RemuxError).code).toBe('remux_timeout');
    expect(f.runs[0]!.killed).toBe(true);
  });

  it('refuses a file whose video Chrome cannot decode before ffmpeg runs', async () => {
    const f = fakeFfmpeg();
    const err = await remuxWith(f.spawn).start(request({ probe: { ...MKV, video: { codec: 'mpeg2video' } } })).catch((e: unknown) => e);
    expect((err as RemuxError).code).toBe('remux_unsupported');
    expect(f.runs).toHaveLength(0);
  });

  it('shares one ffmpeg between two plays of a file and stops it when the last one lets go; the next play starts over', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await Promise.all([remux.start(request()), remux.start(request())]);
    expect(f.runs).toHaveLength(1);
    remux.release(HASH, 3);
    expect(f.runs[0]!.killed).toBe(false);
    remux.release(HASH, 3);
    expect(f.runs[0]!.killed).toBe(true);
    expect(await remux.map(HASH)).toBeNull();
    await remux.resume(HASH, 3);
    expect(f.runs).toHaveLength(2);
    await vi.waitFor(async () => expect((await readdir(remuxDir(dir, HASH, 3))).sort()).toEqual(['index.m3u8', 'init.mp4', 'probe.json', 'seg-00000.m4s']));
  });

  it('deletes the half-made remux once a stopped ffmpeg has exited, and leaves a finished one', async () => {
    const exits: ((code: number) => void)[] = [];
    const base = fakeFfmpeg({ segmentsAtStart: 1 });
    // An ffmpeg that takes a moment to exit after it is told to stop.
    const slow: SpawnFfmpeg = (args) => {
      const proc = base.spawn(args);
      const exited = new Promise<number | null>((resolve) => {
        exits.push(resolve);
      });
      return { exited, stderrTail: proc.stderrTail, kill: () => undefined };
    };
    const remux = remuxWith(slow);
    await remux.start(request());
    await remux.start(request({ fileIndex: 4 }));
    remux.release(HASH, 3);
    await sleep(20);
    expect(existsSync(remuxDir(dir, HASH, 3))).toBe(true);
    exits[0]!(255);
    await vi.waitFor(() => expect(existsSync(remuxDir(dir, HASH, 3))).toBe(false));
    // File 4 still remuxes: the torrent's notesd-remux folder stays.
    expect(existsSync(remuxDir(dir, HASH, 4))).toBe(true);

    const done = fakeFfmpeg({ segmentsAtStart: 1 });
    const whole = remuxWith(done.spawn);
    await whole.start(request({ fileIndex: 5 }));
    await done.runs[0]!.write(2, true);
    done.runs[0]!.exit(0);
    await vi.waitFor(() => expect(existsSync(path.join(remuxDir(dir, HASH, 5), REMUX_DONE_FILE))).toBe(true));
    whole.release(HASH, 5);
    await sleep(20);
    expect(existsSync(remuxDir(dir, HASH, 5))).toBe(true);
  });

  it('serves a segment with Range and answers null for a file that is not there', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    const part = await remux.file(HASH, 3, 'seg-00000.m4s', 'bytes=0-9');
    expect(part?.status).toBe(206);
    expect((await part!.arrayBuffer()).byteLength).toBe(10);
    expect(await remux.file(HASH, 3, 'seg-00009.m4s', null)).toBeNull();
    expect(await remux.file(HASH, 4, 'index.m3u8', null)).toBeNull();
  });

  it('close stops every running ffmpeg', async () => {
    const f = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = remuxWith(f.spawn);
    await remux.start(request());
    await remux.close();
    expect(f.runs[0]!.killed).toBe(true);
  });

  it('keeps a stale half-made remux from an earlier run out of the new one', async () => {
    const stale = remuxDir(dir, HASH, 3);
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'index.m3u8'), eventPlaylist(9, true));
    await writeFile(path.join(stale, 'seg-00008.m4s'), 'old');
    const f = fakeFfmpeg();
    const started = remuxWith(f.spawn).start(request());
    await vi.waitFor(() => expect(f.runs).toHaveLength(1));
    expect(existsSync(path.join(stale, 'seg-00008.m4s'))).toBe(false);
    await f.runs[0]!.write(1);
    await started;
  });
});
