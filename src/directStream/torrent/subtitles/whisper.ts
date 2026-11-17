import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setPriority } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_TORRENT_WHISPER_SCRIPT, type TorrentWhisperConfig } from '../../../config.js';

/**
 * Whisper, the last subtitle tier of a torrent session (TORRENT_STREAM_SOURCE phase 8).
 *
 * It runs only when every earlier tier (a subtitle file in the torrent, the subtitle service, a
 * cloud provider's, the embedded text track) answered nothing. It never delays a play: `find`
 * answers at once with a growing track named "English (Whisper)" and the work goes on behind it.
 * The chosen file's first audio stream is cut into stretches with ffmpeg from the torrent's own
 * file route (a stretch whose bytes are not downloaded yet waits on the route), each stretch goes
 * through a long-lived faster-whisper worker (claude/streaming/torrent/whisper.py), and the cues,
 * moved to their place in the film, are appended to phase 7's growing cue feed.
 *
 * Order: the stretch the play starts in, then each one after it, then those before it, so cues are
 * ahead of the picture soon after the start. A title whose original language is English is
 * transcribed; any other is translated into English.
 *
 * It stops when the session releases the torrent (its signal aborts) or notesd stops. The finished
 * stretches are kept in `<torrent dir>/<info hash>/notesd-whisper/<info hash>-<file index>.json`, inside the
 * torrent's own folder beside phase 7's feed (both survive the swarm leaving and go with the folder when the download
 * is cleared), so a replay carries on from there, and a file done to the end starts nothing.
 */

export const WHISPER_TIER_NAME = 'whisper';
/** The tier's folder inside a torrent's folder: progress files and the WAV of the stretch in progress. */
export const WHISPER_DIR = 'notesd-whisper';
/** A transcript is not a subtitle: the track says what it is. */
export const WHISPER_LABEL = 'English (Whisper)';
/** A cue stays on screen at most this long, however long the worker says the line ran. */
export const WHISPER_MAX_CUE_S = 7;
/** First use downloads the model (464 MB for `small`, 46 s measured), so the first load may take long. */
export const WHISPER_READY_TIMEOUT_MS = 15 * 60_000;
/** One stretch: 5 minutes of dialogue took 2.5 s on 8 threads with `small`; a big model on few threads is far slower. */
export const WHISPER_STRETCH_TIMEOUT_MS = 10 * 60_000;
/** One cut: ffmpeg waits on the file route until the stretch's bytes are downloaded. */
export const WHISPER_CUT_TIMEOUT_MS = 30 * 60_000;
/** Failed stretches in a row before a file is given up (a replay tries again). */
export const WHISPER_MAX_FAILURES = 3;
/** The worker runs below the daemon, so the torrent engine and the file route stay quick. */
const WORKER_NICENESS = 10;
/** 16 kHz mono 16-bit PCM, with the 44-byte header ffmpeg writes in bitexact mode. */
const WAV_BYTES_PER_SECOND = 32_000;
const WAV_HEADER_BYTES = 44;

export interface WhisperCue {
  start_s: number;
  end_s: number;
  text: string;
}

export type WhisperTask = 'transcribe' | 'translate';

export interface WhisperRequest {
  /** A 16 kHz mono 16-bit PCM WAV. */
  wav: string;
  task: WhisperTask;
  /** The spoken language as a 2-letter code, or null to let Whisper detect it. */
  language: string | null;
}

/** What Whisper heard the clip spoken in: a 2-letter code and how sure it is. */
export interface DetectedLanguage {
  language: string;
  probability: number;
}

/**
 * The seam the cloud audio-language check depends on (audioLang.ts): just language detection, so it
 * does not pull in the whole transcriber. WorkerTranscriber satisfies it.
 */
export interface WhisperDetector {
  /** The language spoken in the clip, or null when the worker failed or answered nothing. Never rejects. */
  detect(wav: string, signal: AbortSignal): Promise<DetectedLanguage | null>;
}

/** The seam to the model. Production: WorkerTranscriber. Tests: a plain object. */
export interface Transcriber extends WhisperDetector {
  /** The cues of one stretch, in seconds into the stretch. Rejects when the worker fails or `signal` aborts. */
  transcribe(request: WhisperRequest, signal: AbortSignal): Promise<WhisperCue[]>;
  /** Ends the worker if one runs; the next transcribe starts a new one. */
  stop(): Promise<void>;
}

export interface StretchRequest {
  /** The file route, absolute (ffmpeg reads it with Range requests). */
  url: string;
  /** ffmpeg arguments for this input, before `-i` (a stream host's headers, for Wyzie Synced on a cloud stream). */
  inputArgs?: readonly string[];
  startS: number;
  lengthS: number;
  /** The WAV to write. */
  out: string;
}

/** `lengthS`: the seconds of audio written; under the asked length at the end of the film, 0 past it. */
export type StretchCut = { ok: true; lengthS: number } | { ok: false; reason: string };

/** The seam to ffmpeg. Production: ffmpegCutter. Tests: a plain function. */
export type AudioCutter = (request: StretchRequest, signal: AbortSignal) => Promise<StretchCut>;

/** The part of phase 7's growing cue feed (subtitles/feed.ts) this tier writes. */
export interface WhisperFeed {
  /** Relative to the daemon's origin: what the session's subtitle points at. */
  readonly url: string;
  /** Cues in film time. Whisper appends the stretch on screen first and earlier ones later. */
  append(cues: readonly WhisperCue[]): Promise<void>;
  complete(): Promise<void>;
}

export type OpenWhisperFeed = (infoHash: string, fileIndex: number) => Promise<WhisperFeed>;

/** What this tier reads of the subtitle chain's context (phase 3's SubtitleTier ctx). */
export interface WhisperContext {
  infoHash: string;
  fileIndex: number;
  /** The title's original language, as the session has it ("en", "ko"); null when not known. */
  audioLang: string | null;
  /** Where the play starts, in seconds; null from the start. */
  resumeS: number | null;
  probe: { durationS: number | null };
  /** Aborts when the session releases the torrent. */
  signal: AbortSignal;
}

/**
 * One session subtitle. Always a cue feed, so always `growing: true` (phase 7's mark: `url` answers JSON cues and the
 * page reads it from where it stopped until the feed says it is complete; a finished feed is read once).
 */
export interface WhisperTrack {
  url: string;
  lang: string;
  label: string;
  growing: true;
}

/** English is transcribed; anything else, or a language not known, is translated into English. */
export function whisperTask(audioLang: string | null): Pick<WhisperRequest, 'task' | 'language'> {
  const lang = audioLang?.trim().toLowerCase() ?? '';
  if (lang === 'en' || lang === 'eng') return { task: 'transcribe', language: 'en' };
  return { task: 'translate', language: /^[a-z]{2}$/.test(lang) ? lang : null };
}

/** The start of the stretch that holds `fromS` (the last stretch for a position past the end). */
export function firstStretch(fromS: number | null, stretchS: number, durationS: number | null): number {
  const at = Math.max(0, fromS ?? 0);
  const inside = durationS !== null && at >= durationS ? Math.max(0, durationS - 1) : at;
  return Math.floor(inside / stretchS) * stretchS;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Cues of a stretch moved to film time, each at most WHISPER_MAX_CUE_S long. */
export function placeCues(cues: readonly WhisperCue[], startS: number): WhisperCue[] {
  return cues.map((cue) => ({
    start_s: round3(startS + cue.start_s),
    end_s: round3(startS + Math.min(cue.end_s, cue.start_s + WHISPER_MAX_CUE_S)),
    text: cue.text,
  }));
}

/** The worker's cues, kept only when well formed: it is another program's output. */
export function parseCues(raw: unknown): WhisperCue[] {
  if (!Array.isArray(raw)) return [];
  const cues: WhisperCue[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { start_s: start, end_s: end, text } = item as Record<string, unknown>;
    if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || text.trim() === '') continue;
    cues.push({ start_s: start, end_s: end, text: text.trim() });
  }
  return cues;
}

/**
 * ffmpeg's arguments for one stretch: seek in the input (a ranged read of the file route), the first
 * audio stream only, 16 kHz mono 16-bit PCM, no metadata, so the header is exactly 44 bytes.
 * The first audio stream: the finder leaves dual-audio releases out, so it is the original.
 */
export function cutArgs(request: StretchRequest): string[] {
  return [
    '-v', 'error', '-nostdin', '-y',
    '-ss', String(request.startS), '-t', String(request.lengthS),
    ...(request.inputArgs ?? []),
    '-i', request.url,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact',
    request.out,
  ];
}

export function ffmpegCutter(options: { ffmpegBin: string; timeoutMs?: number }): AudioCutter {
  return async (request, signal) => {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(options.ffmpegBin, cutArgs(request), { timeout: options.timeoutMs ?? WHISPER_CUT_TIMEOUT_MS, killSignal: 'SIGKILL', signal }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      const size = (await stat(request.out)).size;
      return { ok: true, lengthS: Math.max(0, size - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND };
    } catch (err) {
      return { ok: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
  };
}

export interface WorkerTranscriberOptions {
  python: string;
  script: string;
  model: string;
  threads: number;
  /** Where the model is downloaded to and loaded from. */
  modelsDir: string;
  /** Hugging Face's own cache and settings, kept beside the models instead of in ~/.cache. */
  hfHome: string;
  /** The worker's base environment; default process.env. */
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  stretchTimeoutMs?: number;
  log?: (line: string) => void;
}

interface WorkerLine {
  ready?: boolean;
  model?: string;
  load_s?: number;
  id?: string | number | null;
  cues?: unknown;
  language?: unknown;
  probability?: unknown;
  error?: string;
}

interface Waiting {
  /** Hands one answer line to the ask that is waiting on it; the ask interprets it. */
  handle: (message: WorkerLine) => void;
  reject: (err: Error) => void;
}

/**
 * The client of one long-lived worker: started on the first stretch, asked one stretch at a time,
 * stopped when nothing needs it. A worker that dies is started again on the next stretch.
 */
export class WorkerTranscriber implements Transcriber {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readonly waiting = new Map<string, Waiting>();
  private nextId = 1;
  private turn: Promise<unknown> = Promise.resolve();
  private stderrTail = '';
  private readonly log: (line: string) => void;

  constructor(private readonly opts: WorkerTranscriberOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  transcribe(request: WhisperRequest, signal: AbortSignal): Promise<WhisperCue[]> {
    // One stretch at a time, so each one's timeout counts only its own run.
    const run = this.turn.then(() =>
      this.ask({ wav: request.wav, task: request.task, language: request.language }, signal, (message) => {
        if (Array.isArray(message.cues)) return parseCues(message.cues);
        throw new Error(message.error ?? 'the Whisper worker answered nothing');
      }),
    );
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** The clip's spoken language, through the same shared worker as transcribe. Null on any failure: it never fails a play. */
  detect(wav: string, signal: AbortSignal): Promise<DetectedLanguage | null> {
    const run = this.turn.then(() =>
      this.ask({ wav, task: 'detect' }, signal, (message) => {
        const language = typeof message.language === 'string' && message.language.trim() !== '' ? message.language.trim() : null;
        const probability = typeof message.probability === 'number' && Number.isFinite(message.probability) ? message.probability : null;
        if (language === null || probability === null) throw new Error(message.error ?? 'the Whisper worker detected no language');
        return { language, probability };
      }),
    );
    this.turn = run.catch(() => undefined);
    return run.then(
      (value) => value,
      () => null,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGKILL');
    });
  }

  /** One request to the worker, one answer line interpreted by `read`. Shared by transcribe (cues) and detect (a language). */
  private async ask<T>(payload: Record<string, unknown>, signal: AbortSignal, read: (message: WorkerLine) => T): Promise<T> {
    signal.throwIfAborted();
    await this.start();
    signal.throwIfAborted();
    const child = this.child;
    if (child === null || child.stdin === null) throw new Error('the Whisper worker is not running');
    const id = String(this.nextId++);
    const timeoutMs = this.opts.stretchTimeoutMs ?? WHISPER_STRETCH_TIMEOUT_MS;
    return await new Promise<T>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiting.delete(id);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`the Whisper worker gave no answer in ${Math.round(timeoutMs / 1000)} s`));
        void this.stop();
      }, timeoutMs);
      timer.unref();
      // The worker finishes the request anyway; its answer then finds no one waiting and is dropped.
      const onAbort = (): void => {
        done();
        reject(signal.reason instanceof Error ? signal.reason : new Error('the request was dropped'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, {
        handle: (message) => {
          done();
          try {
            resolve(read(message));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
        reject: (err) => {
          done();
          reject(err);
        },
      });
      child.stdin?.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  private start(): Promise<void> {
    if (this.ready !== null) return this.ready;
    const { python, script, model, threads, modelsDir, hfHome } = this.opts;
    const child = spawn(python, ['-I', script, '--model', model, '--threads', String(threads), '--models-dir', modelsDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(this.opts.env ?? process.env), HF_HOME: hfHome, HF_HUB_DISABLE_TELEMETRY: '1' },
    });
    this.child = child;
    try {
      if (child.pid !== undefined) setPriority(child.pid, WORKER_NICENESS);
    } catch {
      // Not allowed here: it runs at the daemon's priority.
    }
    this.stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.stdin?.on('error', () => undefined);
    const readyTimeoutMs = this.opts.readyTimeoutMs ?? WHISPER_READY_TIMEOUT_MS;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the Whisper worker did not load model ${model} in ${Math.round(readyTimeoutMs / 1000)} s`)), readyTimeoutMs);
      timer.unref();
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        let message: WorkerLine;
        try {
          message = JSON.parse(line) as WorkerLine;
        } catch {
          return;
        }
        if (message.ready !== undefined) {
          clearTimeout(timer);
          if (message.ready === true) {
            this.log(`[notesd] torrent whisper: worker ready (model ${message.model ?? model}, loaded in ${message.load_s ?? '?'} s)`);
            resolve();
          } else {
            reject(new Error(message.error ?? 'the Whisper worker did not start'));
          }
          return;
        }
        const key = message.id === undefined || message.id === null ? null : String(message.id);
        const waiting = key === null ? undefined : this.waiting.get(key);
        if (waiting === undefined) return;
        waiting.handle(message);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      // `close`, not `exit`: it comes after stdout is drained, so a `{"ready": false, "error"}` line
      // written just before the worker exits is read first and its reason wins.
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        const why = `the Whisper worker stopped (${sig ?? `exit ${code}`})${this.stderrTail.trim() === '' ? '' : `: ${this.stderrTail.trim().slice(-300)}`}`;
        reject(new Error(why));
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        for (const waiting of [...this.waiting.values()]) waiting.reject(new Error(why));
      });
    });
    this.ready = ready;
    ready.catch(() => {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
        child.kill('SIGKILL');
      }
    });
    return ready;
  }
}

/** The finished stretches of one file, kept beside the torrent. */
interface WhisperProgress {
  stretchS: number;
  done: number[];
  /** Where the audio ends, once known (the probe's duration, or found by a short last stretch). */
  endS: number | null;
  complete: boolean;
}

function parseProgress(raw: unknown): WhisperProgress | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { stretchS, done, endS, complete } = raw as Record<string, unknown>;
  if (typeof stretchS !== 'number' || !(stretchS > 0) || !Array.isArray(done) || typeof complete !== 'boolean') return null;
  if (endS !== null && typeof endS !== 'number') return null;
  return { stretchS, done: done.filter((d): d is number => typeof d === 'number' && d >= 0), endS, complete };
}

/** One file being transcribed, shared by every session that plays it. */
class WhisperJob {
  readonly controller = new AbortController();
  private users = 0;

  /** The job goes on while at least one session's signal has not aborted. */
  join(signal: AbortSignal): void {
    this.users += 1;
    signal.addEventListener(
      'abort',
      () => {
        this.users -= 1;
        if (this.users === 0) this.controller.abort(new Error('the torrent was released'));
      },
      { once: true },
    );
  }
}

export interface WhisperTierOptions {
  /** Seconds per stretch for a file not started yet (a file started before keeps its own). */
  stretchS: number;
  /** A torrent's `notesd-whisper` folder (`<torrent dir>/<info hash>/notesd-whisper`): progress files and the WAV of the stretch in progress. */
  workDirOf: (infoHash: string) => string;
  /** The file route of a torrent's file, absolute (`http://127.0.0.1:<port>/api/stream/torrent/<hash>/f/<index>`). */
  fileUrl: (infoHash: string, fileIndex: number) => string;
  openFeed: OpenWhisperFeed;
  cutter: AudioCutter;
  transcriber: Transcriber;
  log?: (line: string) => void;
}

export class WhisperTier {
  readonly name = WHISPER_TIER_NAME;
  /** A growing tier (phase 3's SubtitleTier): it answers at once and is not counted in the chain's 40 s budget. */
  readonly blocks = false;
  private readonly jobs = new Map<string, WhisperJob>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: WhisperTierOptions) {
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  /** A growing English track at once (a finished one when the file is done); nothing when no feed can be opened. Never throws. */
  async find(ctx: WhisperContext): Promise<WhisperTrack[]> {
    const key = `${ctx.infoHash.toLowerCase()}-${ctx.fileIndex}`;
    let feed: WhisperFeed;
    try {
      feed = await this.opts.openFeed(ctx.infoHash, ctx.fileIndex);
    } catch (err) {
      this.log(`[notesd] torrent whisper: no cue feed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    const progress = await this.readProgress(key);
    if (progress?.complete === true) return [this.track(feed)];
    if (!ctx.signal.aborted) this.jobFor(key, ctx, feed, progress).join(ctx.signal);
    return [this.track(feed)];
  }

  /** Stops every file and the worker: notesd is stopping. */
  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.controller.abort(new Error('notesd is stopping'));
    this.jobs.clear();
    await this.opts.transcriber.stop();
  }

  private track(feed: WhisperFeed): WhisperTrack {
    return { url: feed.url, lang: 'en', label: WHISPER_LABEL, growing: true };
  }

  private jobFor(key: string, ctx: WhisperContext, feed: WhisperFeed, progress: WhisperProgress | null): WhisperJob {
    const running = this.jobs.get(key);
    if (running !== undefined && !running.controller.signal.aborted) return running;
    const job = new WhisperJob();
    this.jobs.set(key, job);
    void this.transcribeFile(key, ctx, feed, progress, job.controller.signal)
      .catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        this.log(`[notesd] torrent whisper: ${key} stopped: ${job.controller.signal.aborted ? 'the torrent was released' : why}`);
      })
      .finally(() => {
        if (this.jobs.get(key) === job) this.jobs.delete(key);
        // Nothing left to transcribe: the worker's memory (about 850 MB with `small`) goes back.
        if (this.jobs.size === 0) void this.opts.transcriber.stop();
      });
    return job;
  }

  private async transcribeFile(key: string, ctx: WhisperContext, feed: WhisperFeed, stored: WhisperProgress | null, signal: AbortSignal): Promise<void> {
    const { task, language } = whisperTask(ctx.audioLang);
    const stretchS = stored?.stretchS ?? this.opts.stretchS;
    const done = new Set(stored?.done ?? []);
    let endS = stored?.endS ?? ctx.probe.durationS;
    const url = this.opts.fileUrl(ctx.infoHash, ctx.fileIndex);
    const first = firstStretch(ctx.resumeS, stretchS, endS);
    let failures = 0;
    await mkdir(this.opts.workDirOf(ctx.infoHash.toLowerCase()), { recursive: true });
    const save = (complete: boolean): Promise<void> => this.saveProgress(key, { stretchS, done: [...done].sort((a, b) => a - b), endS, complete });

    /** One stretch: `end` once the audio is over. Throws when released or after too many failures. */
    const one = async (startS: number): Promise<'next' | 'end'> => {
      const wav = path.join(this.opts.workDirOf(ctx.infoHash.toLowerCase()), `${key}-${startS}.wav`);
      try {
        const cut = await this.opts.cutter({ url, startS, lengthS: stretchS, out: wav }, signal);
        signal.throwIfAborted();
        if (!cut.ok) throw new Error(`the audio at ${startS} s could not be cut: ${cut.reason}`);
        if (cut.lengthS < 0.5) {
          endS = startS;
          await save(false);
          return 'end';
        }
        const cues = await this.opts.transcriber.transcribe({ wav, task, language }, signal);
        signal.throwIfAborted();
        await feed.append(placeCues(cues, startS));
        done.add(startS);
        const last = cut.lengthS < stretchS - 1;
        if (last) endS = startS + cut.lengthS;
        await save(false);
        failures = 0;
        this.log(`[notesd] torrent whisper: ${key} ${startS}-${round3(startS + cut.lengthS)} s: ${cues.length} cue(s) (${task})`);
        return last ? 'end' : 'next';
      } catch (err) {
        if (signal.aborted) throw err;
        failures += 1;
        this.log(`[notesd] torrent whisper: ${key} stretch at ${startS} s failed: ${err instanceof Error ? err.message : String(err)}`);
        if (failures >= WHISPER_MAX_FAILURES) throw new Error(`gave up after ${failures} failed stretches in a row; a replay tries again`);
        return 'next';
      } finally {
        await rm(wav, { force: true });
      }
    };

    for (let startS = first; endS === null || startS < endS; startS += stretchS) {
      if (done.has(startS)) continue;
      if ((await one(startS)) === 'end') break;
    }
    for (let startS = first - stretchS; startS >= 0; startS -= stretchS) {
      if (done.has(startS)) continue;
      await one(startS);
    }
    const finalEnd = endS;
    if (finalEnd === null) return;
    for (let startS = 0; startS < finalEnd; startS += stretchS) {
      if (!done.has(startS)) {
        this.log(`[notesd] torrent whisper: ${key} has stretches left over; a replay tries them again`);
        return;
      }
    }
    await save(true);
    await feed.complete();
    this.log(`[notesd] torrent whisper: ${key} transcribed to the end`);
  }

  /** `key` is `<info hash>-<file index>`, the hash 40 lower-case hex characters. */
  private progressFile(key: string): string {
    return path.join(this.opts.workDirOf(key.slice(0, 40)), `${key}.json`);
  }

  private async readProgress(key: string): Promise<WhisperProgress | null> {
    try {
      return parseProgress(JSON.parse(await readFile(this.progressFile(key), 'utf8')));
    } catch {
      return null;
    }
  }

  private async saveProgress(key: string, progress: WhisperProgress): Promise<void> {
    const file = this.progressFile(key);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(progress));
    await rename(tmp, file);
  }
}

export interface BuildWhisperTierOptions {
  whisper: TorrentWhisperConfig;
  /** `config.torrent.dir`: the tier keeps its files under `<dir>/<info hash>/notesd-whisper`. */
  torrentDir: string;
  ffmpegBin: string;
  fileUrl: (infoHash: string, fileIndex: number) => string;
  openFeed: OpenWhisperFeed;
  /** Default: claude/streaming/torrent/whisper.py in this checkout. */
  script?: string;
  log?: (line: string) => void;
}

/** The tier, or null: Whisper is off, or install.sh has not made its Python (the log says which). */
export async function buildWhisperTier(options: BuildWhisperTierOptions): Promise<WhisperTier | null> {
  const log = options.log ?? ((line: string) => console.log(line));
  const whisper = options.whisper;
  if (!whisper.enabled) {
    log('[notesd] torrent whisper: off (NOTESD_TORRENT_WHISPER=off)');
    return null;
  }
  try {
    await access(whisper.python, constants.X_OK);
  } catch {
    log(`[notesd] torrent whisper: no Python at ${whisper.python}; scripts/install.sh installs it. No Whisper subtitles until then.`);
    return null;
  }
  log(`[notesd] torrent whisper: on (model ${whisper.model}, ${whisper.threads} threads, ${whisper.stretchS} s stretches)`);
  return new WhisperTier({
    stretchS: whisper.stretchS,
    workDirOf: (infoHash) => path.join(options.torrentDir, infoHash, WHISPER_DIR),
    fileUrl: options.fileUrl,
    openFeed: options.openFeed,
    cutter: ffmpegCutter({ ffmpegBin: options.ffmpegBin }),
    transcriber: new WorkerTranscriber({
      python: whisper.python,
      script: options.script ?? DEFAULT_TORRENT_WHISPER_SCRIPT,
      model: whisper.model,
      threads: whisper.threads,
      modelsDir: path.join(whisper.dir, 'models'),
      hfHome: path.join(whisper.dir, 'hf'),
      log,
    }),
    log,
  });
}
