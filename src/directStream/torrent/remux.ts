import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TorrentConfig } from '../../config.js';
import { contentTypeOf, fileResponse } from '../cache/serve.js';
import type { MediaProbe } from './probe.js';

/**
 * The remux of a torrent file Chrome cannot play as is (torrent phase 5, R2.8): an MKV, AC3/E-AC3/DTS sound, HEVC.
 * One ffmpeg per file reads it (through this daemon's own file route while it downloads, so a read waits for its
 * pieces and the download follows ffmpeg from the start of the film; from disk once whole), copies the video,
 * converts the audio track in the title's original language to AAC stereo, and writes an HLS playlist of fMP4
 * segments in `<torrent dir>/<info hash>/notesd-remux/<file index>/`. The playlist is an EVENT one: it grows a segment
 * at a time and is served with EXT-X-ENDLIST only once ffmpeg has read the whole file and exited cleanly
 * (`done.json`). A finished remux is kept beside the download and plays again from disk with no ffmpeg; once nothing
 * needs the original any more, TorrentStreams deletes it and the remux is the one copy (remuxOnly.ts).
 */

/** Video ffmpeg copies into an fMP4 segment and Chrome decodes (HEVC where the machine's Chrome does). MPEG-2, VC-1, MPEG-4 Part 2 are not. */
export const REMUX_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'av1', 'vp9']);
/** ffmpeg cuts at the first keyframe after this many seconds. */
export const REMUX_SEGMENT_S = 6;
/** A play waits this long at most for the first segment (the probe already read the header, so the data flows). */
export const REMUX_FIRST_SEGMENT_TIMEOUT_MS = 60_000;
export const REMUX_POLL_MS = 500;
/** SIGTERM, then SIGKILL after this long. */
export const REMUX_KILL_GRACE_MS = 5_000;
export const REMUX_PLAYLIST = 'index.m3u8';
/** Written once ffmpeg exited 0 under -xerror: the remux is whole. */
export const REMUX_DONE_FILE = 'done.json';
/**
 * What the remuxed file holds, as the header probe read it (the original's streams, length and subtitle tracks), written
 * when its remux starts: a file that lives as its remux only is played again, and its embedded cues checked, from this.
 */
export const REMUX_PROBE_FILE = 'probe.json';
/** The only names the file route serves. */
export const REMUX_FILE_NAME = /^(?:index\.m3u8|init\.mp4|seg-\d{5}\.m4s)$/;
const STDERR_TAIL_CHARS = 2_000;

export type RemuxErrorCode = 'remux_unsupported' | 'remux_failed' | 'remux_timeout';

export class RemuxError extends Error {
  override name = 'RemuxError';

  constructor(
    readonly code: RemuxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** What the remux reads of phase 3's MediaProbe (MediaProbe fits it). `audio` is in stream order: `audio[n]` is ffmpeg's `0:a:n`. */
export interface RemuxProbe {
  video: { codec: string } | null;
  audio: readonly { lang: string | null }[];
  durationS: number | null;
}

export interface RemuxRequest {
  /** Lower-case hex. */
  infoHash: string;
  fileIndex: number;
  /** The file's absolute path once it is whole on disk, else the absolute address of its file route on this daemon. */
  input: string;
  probe: RemuxProbe;
  /** The title's original language (TMDB's ISO 639-1), or null. */
  audioLang: string | null;
}

export interface RemuxPlay {
  /** `/api/stream/torrent/<hash>/hls/<index>/index.m3u8?remux=1&total_s=<film seconds>`. */
  manifestUrl: string;
  durationS: number | null;
}

/** The shape of the cache's and phase 1's map: the stretches of the film the page can play, in seconds. */
export interface RemuxMap {
  duration_s: number | null;
  ranges: [number, number][];
}

/** One ffmpeg run. */
export interface FfmpegProcess {
  /** Its exit code once it has exited (null after a signal, -1 when it could not start). */
  readonly exited: Promise<number | null>;
  /** The last of what it wrote to stderr. */
  stderrTail(): string;
  /** SIGTERM, then SIGKILL after REMUX_KILL_GRACE_MS. Safe to call twice or after the exit. */
  kill(): void;
}

export type SpawnFfmpeg = (args: readonly string[]) => FfmpegProcess;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function remuxDir(torrentDir: string, infoHash: string, fileIndex: number): string {
  return path.join(torrentDir, infoHash, 'notesd-remux', String(fileIndex));
}

/** The playlist's address as a session hands it to the page: `remux=1` marks a growing remux, `total_s` the film's length. */
export function remuxPlaylistUrl(infoHash: string, fileIndex: number, durationS: number | null): string {
  const total = durationS !== null && durationS > 0 ? `&total_s=${round1(durationS)}` : '';
  return `/api/stream/torrent/${infoHash}/hls/${fileIndex}/${REMUX_PLAYLIST}?remux=1${total}`;
}

/**
 * What an audio cutter (Whisper, Wyzie Synced, /sync-subtitle) reads a file that lives as its remux from: the remux's
 * own segments over this daemon's route, through hlsCut.ts's `withHlsSegments`. Never ffmpeg on the playlist alone:
 * its seek in an fMP4 playlist reads nothing, and a stretch past the end comes back with the film's start.
 */
export function remuxAudioInput(base: string, infoHash: string, fileIndex: number): { url: string; hls: { manifest_kind: 'hls'; manifest_url: string; headers: { referer: null; origin: null; user_agent: null } } } {
  const url = `${base}/api/stream/torrent/${infoHash}/hls/${fileIndex}/${REMUX_PLAYLIST}`;
  return { url, hls: { manifest_kind: 'hls', manifest_url: url, headers: { referer: null, origin: null, user_agent: null } } };
}

/** The probe a remux kept beside it (REMUX_PROBE_FILE), or null when there is none or it cannot be read as one. */
export async function readRemuxProbe(dir: string): Promise<MediaProbe | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, REMUX_PROBE_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Partial<MediaProbe>;
  const shaped =
    typeof p.container === 'string' &&
    Array.isArray(p.audio) &&
    Array.isArray(p.subtitles) &&
    typeof p.direct === 'boolean' &&
    (p.video === null || (typeof p.video === 'object' && typeof p.video?.codec === 'string')) &&
    (p.durationS === null || typeof p.durationS === 'number');
  return shaped ? (p as MediaProbe) : null;
}

/** Writes the probe beside the remux (best effort: without it the file's original is never deleted). */
export async function writeRemuxProbe(dir: string, probe: RemuxProbe): Promise<void> {
  await writeFile(path.join(dir, REMUX_PROBE_FILE), `${JSON.stringify(probe)}\n`);
}

/** Whether a remux can make the file playable: its video is one Chrome decodes from an fMP4 segment. Any audio ffmpeg reads becomes AAC. */
export function canRemux(probe: RemuxProbe): boolean {
  return probe.video !== null && REMUX_VIDEO_CODECS.has(probe.video.codec.toLowerCase());
}

/** "eng", "en-US", "en" → "en" (ISO 639-2 and BCP 47 tags through Intl); a tag Intl rejects as it is, lower-cased. */
function languageOf(tag: string): string {
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  try {
    return Intl.getCanonicalLocales(primary)[0]?.split('-')[0] ?? primary;
  } catch {
    return primary;
  }
}

/** The audio stream to keep, as an index among the audio streams: the first in the original language, else the first. Null: no audio. */
export function pickAudioStream(audio: RemuxProbe['audio'], audioLang: string | null): number | null {
  if (audio.length === 0) return null;
  if (audioLang !== null) {
    const want = languageOf(audioLang);
    const at = audio.findIndex((a) => a.lang !== null && languageOf(a.lang) === want);
    if (at !== -1) return at;
  }
  return 0;
}

/**
 * ffmpeg's arguments, checked on ffmpeg 6.1.1 (see the phase plan): `-xerror` makes a read error a non-zero exit
 * (without it ffmpeg exits 0 on a dead input); the reconnect options carry on at the same byte when the file route
 * drops a connection; the HLS muxer writes an EVENT playlist of fMP4 segments, renaming each file into place.
 */
export function remuxArgs(o: { input: string; dir: string; videoCodec: string; audioStream: number | null }): string[] {
  const overHttp = /^https?:\/\//.test(o.input);
  return [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
    ...(overHttp ? ['-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '30', '-rw_timeout', '120000000'] : []),
    '-i', o.input,
    '-map', '0:v:0',
    ...(o.audioStream === null ? ['-an'] : ['-map', `0:a:${o.audioStream}`]),
    '-sn', '-dn',
    '-c:v', 'copy',
    ...(o.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    ...(o.audioStream === null ? [] : ['-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '192k']),
    // A copied video stream with a converted audio stream can queue many packets before the first audio frame.
    '-max_muxing_queue_size', '4096',
    '-f', 'hls',
    '-hls_time', String(REMUX_SEGMENT_S),
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(o.dir, 'seg-%05d.m4s'),
    '-hls_flags', 'independent_segments+temp_file',
    path.join(o.dir, REMUX_PLAYLIST),
  ];
}

/** The playlist without EXT-X-ENDLIST: ffmpeg writes it on any exit, a failed one too. */
export function openPlaylist(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '#EXT-X-ENDLIST')
    .join('\n');
}

/** The seconds a playlist's segments add up to. */
export function playlistSeconds(text: string): number {
  let total = 0;
  for (const line of text.split('\n')) {
    const m = /^#EXTINF:([\d.]+)/.exec(line.trim());
    if (m !== null) total += Number(m[1]);
  }
  return total;
}

/** The real ffmpeg. stderr is kept (its tail goes into the log and an attempt's detail); stdout is ignored. */
export function ffmpegSpawner(bin: string): SpawnFfmpeg {
  return (args) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    const keep = (text: string): void => {
      tail = (tail + text).slice(-STDERR_TAIL_CHARS);
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', keep);
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (err) => {
        keep(`\n${err.message}`);
        resolve(-1);
      });
      child.once('close', (code) => resolve(code));
    }).finally(() => {
      if (killTimer !== null) clearTimeout(killTimer);
    });
    return {
      exited,
      stderrTail: () => tail.trim(),
      kill() {
        if (child.exitCode !== null || child.signalCode !== null || killTimer !== null) return;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), REMUX_KILL_GRACE_MS);
        killTimer.unref();
      },
    };
  };
}

type RunState = 'running' | 'done' | 'failed' | 'stopped';

interface Run {
  key: string;
  infoHash: string;
  fileIndex: number;
  dir: string;
  durationS: number | null;
  state: RunState;
  /** Sessions playing it: start() adds one, release() takes one; at none a running ffmpeg is stopped. */
  users: number;
  process: FfmpegProcess | null;
  firstSegment: Promise<void>;
}

export interface TorrentRemuxOptions {
  /** `config.torrent.dir`. */
  dir: string;
  spawn: SpawnFfmpeg;
  firstSegmentTimeoutMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export class TorrentRemux {
  private readonly runs = new Map<string, Run>();
  /** The file a torrent's map answers for: the one started last. */
  private readonly latest = new Map<string, string>();
  /** What each file was started with, so a session that takes its torrent again starts the same remux. */
  private readonly requests = new Map<string, RemuxRequest>();
  /** Half-made remuxes being deleted after a stop; a new run of the same file waits for its folder to be gone. */
  private readonly clearing = new Map<string, Promise<void>>();
  /** Told of each remux that became whole (`done.json` written): TorrentStreams may then delete its original. */
  private readonly doneListeners: Array<(infoHash: string, fileIndex: number) => void> = [];
  private readonly log: (line: string) => void;

  constructor(private readonly opts: TorrentRemuxOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /**
   * The remux of one file for one more session: answered once its first segment is on disk (at once for a finished
   * one, kept from before). Two plays of one file share one ffmpeg. A remux stopped, failed or cut off by a restart
   * starts over from the start of the file. Throws RemuxError: `remux_unsupported` (nothing ran), `remux_failed`
   * (ffmpeg ended before a segment), `remux_timeout` (no segment in time; ffmpeg is stopped).
   */
  async start(req: RemuxRequest, options: { timeoutMs?: number } = {}): Promise<RemuxPlay> {
    if (!canRemux(req.probe)) {
      throw new RemuxError('remux_unsupported', `Chrome does not decode ${req.probe.video?.codec ?? 'a file without'} video, so a remux would not help`);
    }
    const key = `${req.infoHash}:${req.fileIndex}`;
    const label = `${req.infoHash} file ${req.fileIndex}`;
    const play: RemuxPlay = { manifestUrl: remuxPlaylistUrl(req.infoHash, req.fileIndex, req.probe.durationS), durationS: req.probe.durationS };
    this.requests.set(key, req);
    const known = this.runs.get(key);
    if (known !== undefined && (known.state === 'running' || known.state === 'done')) {
      await known.firstSegment;
      known.users += 1;
      this.latest.set(req.infoHash, key);
      if (known.state === 'done') this.log(`[notesd] torrent remux: ${label} plays from disk`);
      return play;
    }
    const dir = remuxDir(this.opts.dir, req.infoHash, req.fileIndex);
    if (existsSync(path.join(dir, REMUX_DONE_FILE))) {
      // A remux made before the probe was kept beside it gets it now, so its original can go once nothing needs it.
      if (!existsSync(path.join(dir, REMUX_PROBE_FILE))) await writeRemuxProbe(dir, req.probe).catch(() => undefined);
      this.runs.set(key, { key, infoHash: req.infoHash, fileIndex: req.fileIndex, dir, durationS: req.probe.durationS, state: 'done', users: 1, process: null, firstSegment: Promise.resolve() });
      this.latest.set(req.infoHash, key);
      this.log(`[notesd] torrent remux: ${label} plays from disk`);
      return play;
    }
    const run: Run = { key, infoHash: req.infoHash, fileIndex: req.fileIndex, dir, durationS: req.probe.durationS, state: 'running', users: 0, process: null, firstSegment: Promise.resolve() };
    run.firstSegment = this.begin(run, req, options.timeoutMs ?? this.opts.firstSegmentTimeoutMs ?? REMUX_FIRST_SEGMENT_TIMEOUT_MS);
    this.runs.set(key, run);
    try {
      await run.firstSegment;
    } catch (err) {
      if (this.runs.get(key) === run) this.runs.delete(key);
      this.log(`[notesd] torrent remux: ${label} did not start: ${messageOf(err)}`);
      throw err;
    }
    run.users += 1;
    this.latest.set(req.infoHash, key);
    this.log(`[notesd] torrent remux: ${label} started (${req.probe.video?.codec ?? ''} copied, audio to AAC)`);
    return play;
  }

  /** Calls `listener` each time a remux becomes whole, after its `done.json` is written. */
  whenDone(listener: (infoHash: string, fileIndex: number) => void): void {
    this.doneListeners.push(listener);
  }

  /** The probe kept beside a file's remux (what the original held), or null. */
  savedProbe(infoHash: string, fileIndex: number): Promise<MediaProbe | null> {
    return readRemuxProbe(remuxDir(this.opts.dir, infoHash, fileIndex));
  }

  /** start() again with what the file was last started with (a session that took its torrent again). No-op for a file never started. */
  async resume(infoHash: string, fileIndex: number): Promise<void> {
    const req = this.requests.get(`${infoHash}:${fileIndex}`);
    if (req !== undefined) await this.start(req);
  }

  /**
   * One session fewer on the file; with none left a running ffmpeg is stopped and its half-made remux is deleted
   * once ffmpeg has exited (the next play starts it over anyway).
   */
  release(infoHash: string, fileIndex: number): void {
    const key = `${infoHash}:${fileIndex}`;
    const run = this.runs.get(key);
    if (run === undefined || run.users === 0) return;
    run.users -= 1;
    if (run.users > 0 || run.state !== 'running') return;
    run.state = 'stopped';
    const proc = run.process;
    proc?.kill();
    this.runs.delete(key);
    if (this.latest.get(infoHash) === key) this.latest.delete(infoHash);
    this.log(`[notesd] torrent remux: ${infoHash} file ${fileIndex} stopped: no session plays it`);
    const cleared = (proc === null ? Promise.resolve() : proc.exited.then(() => undefined))
      .then(async () => {
        await rm(run.dir, { recursive: true, force: true });
        // The torrent's notesd-remux folder goes too when no other file of it is remuxed.
        await rmdir(path.dirname(run.dir)).catch(() => undefined);
      })
      .catch((err: unknown) => this.log(`[notesd] torrent remux: the half-made remux of ${infoHash} file ${fileIndex} could not be deleted: ${messageOf(err)}`))
      .finally(() => {
        if (this.clearing.get(key) === cleared) this.clearing.delete(key);
      });
    this.clearing.set(key, cleared);
  }

  /** What of the film the remux holds (from 0 to where it is), or null when this torrent has no remux here. */
  async map(infoHash: string): Promise<RemuxMap | null> {
    const key = this.latest.get(infoHash);
    const run = key === undefined ? undefined : this.runs.get(key);
    if (run === undefined) return null;
    const covered = round1(await this.seconds(run.dir));
    return { duration_s: run.durationS === null ? (covered > 0 ? covered : null) : round1(run.durationS), ranges: covered > 0 ? [[0, covered]] : [] };
  }

  /**
   * One file of a remux from disk, or null when there is no such file. The playlist is never cached and carries
   * EXT-X-ENDLIST only once `done.json` is there; segments and the init section are served with `Range`. `name`
   * must already match REMUX_FILE_NAME (the route checks it).
   */
  async file(infoHash: string, fileIndex: number, name: string, rangeHeader: string | null): Promise<Response | null> {
    const dir = remuxDir(this.opts.dir, infoHash, fileIndex);
    const file = path.join(dir, name);
    if (name === REMUX_PLAYLIST) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return null;
      }
      const whole = existsSync(path.join(dir, REMUX_DONE_FILE));
      return new Response(whole ? text : openPlaylist(text), { status: 200, headers: { 'content-type': contentTypeOf(name), 'cache-control': 'no-store' } });
    }
    try {
      return await fileResponse(file, name, rangeHeader);
    } catch {
      return null;
    }
  }

  /** Stops every running ffmpeg (the daemon closes). Bounded by REMUX_KILL_GRACE_MS. */
  async close(): Promise<void> {
    const procs: FfmpegProcess[] = [];
    for (const run of this.runs.values()) {
      if (run.state !== 'running') continue;
      run.state = 'stopped';
      if (run.process !== null) {
        procs.push(run.process);
        run.process.kill();
      }
    }
    await Promise.all(procs.map((p) => p.exited));
    this.runs.clear();
    this.latest.clear();
  }

  private async seconds(dir: string): Promise<number> {
    try {
      return playlistSeconds(await readFile(path.join(dir, REMUX_PLAYLIST), 'utf8'));
    } catch {
      return 0;
    }
  }

  /** Empties the folder, starts ffmpeg, and resolves once the playlist names a segment. */
  private async begin(run: Run, req: RemuxRequest, timeoutMs: number): Promise<void> {
    await this.clearing.get(run.key);
    await rm(run.dir, { recursive: true, force: true });
    await mkdir(run.dir, { recursive: true });
    await writeRemuxProbe(run.dir, req.probe).catch((err: unknown) => this.log(`[notesd] torrent remux: the probe of ${run.infoHash} file ${run.fileIndex} could not be kept: ${messageOf(err)}`));
    if (run.state !== 'running') throw new RemuxError('remux_failed', 'the daemon closed before ffmpeg started');
    const proc = this.opts.spawn(
      remuxArgs({ input: req.input, dir: run.dir, videoCodec: (req.probe.video?.codec ?? '').toLowerCase(), audioStream: pickAudioStream(req.probe.audio, req.audioLang) }),
    );
    run.process = proc;
    let exitCode: number | null | undefined;
    const ended = (): boolean => exitCode !== undefined;
    void proc.exited.then((code) => {
      exitCode = code;
      return this.finish(run, proc, code);
    });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.seconds(run.dir)) > 0) return;
      if (ended()) throw new RemuxError('remux_failed', proc.stderrTail().slice(-300) || `ffmpeg ended (exit ${String(exitCode)}) before writing a segment`);
      if (Date.now() >= deadline) {
        run.state = 'stopped';
        proc.kill();
        throw new RemuxError('remux_timeout', `ffmpeg wrote no segment in ${Math.round(timeoutMs / 1000)} s`);
      }
      await sleep(this.opts.pollMs ?? REMUX_POLL_MS);
    }
  }

  private async finish(run: Run, proc: FfmpegProcess, code: number | null): Promise<void> {
    if (run.process === proc) run.process = null;
    if (run.state !== 'running') return;
    const label = `${run.infoHash} file ${run.fileIndex}`;
    const covered = await this.seconds(run.dir);
    if (code !== 0 || covered === 0) {
      run.state = 'failed';
      this.log(`[notesd] torrent remux: ${label} failed (exit ${String(code)}) after ${round1(covered)} s: ${proc.stderrTail().slice(-300)}`);
      return;
    }
    try {
      await writeFile(path.join(run.dir, REMUX_DONE_FILE), `${JSON.stringify({ duration_s: round1(covered), at: new Date().toISOString() })}\n`);
    } catch (err) {
      this.log(`[notesd] torrent remux: ${label} is whole but ${REMUX_DONE_FILE} could not be written: ${messageOf(err)}`);
    }
    run.state = 'done';
    this.log(`[notesd] torrent remux: ${label} done (${round1(covered)} s)`);
    for (const listener of this.doneListeners) {
      try {
        listener(run.infoHash, run.fileIndex);
      } catch (err) {
        this.log(`[notesd] torrent remux: ${label}: ${messageOf(err)}`);
      }
    }
  }
}

/** The daemon's remuxer, or null when torrents or the remux are off. Building it starts nothing. */
export function buildTorrentRemux(torrent: Pick<TorrentConfig, 'enabled' | 'remux' | 'dir' | 'ffmpegBin'> | null | undefined): TorrentRemux | null {
  if (torrent === null || torrent === undefined || !torrent.enabled || !torrent.remux) return null;
  return new TorrentRemux({ dir: torrent.dir, spawn: ffmpegSpawner(torrent.ffmpegBin) });
}
