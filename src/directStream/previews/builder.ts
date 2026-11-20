import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { covered, PREVIEW_COLS, PREVIEW_FRAME_WIDTH, PREVIEW_INTERVAL_S, PREVIEW_ROWS, type SheetRecord, type SheetSpec } from './plan.js';
import { homeOf, PREVIEW_INPUT_PROTOCOLS, PREVIEW_LOOPBACK_PROTOCOLS, PreviewNotYet, type LocalVideo, type PreviewInput } from './types.js';

/** The CPU priority every preview ffmpeg runs at: the lowest. */
export const PREVIEW_NICENESS = 19;
/** A sheet's ffmpeg past this is killed and the sheet counts as failed. */
export const PREVIEW_SHEET_TIME_LIMIT_MS = 120_000;
const STDERR_TAIL_CHARS = 600;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** One ffmpeg run, as the builder sees it. */
export interface PreviewProcess {
  /** The OS process id; null when the binary could not be started at all. */
  readonly pid: number | null;
  /** The exit code; -1 when it could not start (startError says why), null when a signal ended it. */
  readonly exited: Promise<number | null>;
  /** Why it could not start (code `ENOENT`: no such binary); null otherwise. */
  startError(): NodeJS.ErrnoException | null;
  stderrTail(): string;
  /** SIGKILL: a preview is never worth waiting for. */
  kill(): void;
}

export type SpawnPreview = (args: readonly string[]) => PreviewProcess;

/** The real ffmpeg. stdout is ignored, the tail of stderr is kept for the log line. */
export function ffmpegPreviewSpawner(bin: string): SpawnPreview {
  return (args) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const state: { tail: string; startError: NodeJS.ErrnoException | null } = { tail: '', startError: null };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      state.tail = (state.tail + text).slice(-STDERR_TAIL_CHARS);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        state.startError = err;
        resolve(-1);
      });
      child.once('close', (code) => resolve(code));
    });
    return {
      pid: child.pid ?? null,
      exited,
      startError: () => state.startError,
      stderrTail: () => state.tail.trim(),
      kill: () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      },
    };
  };
}

/** The `-protocol_whitelist` of one input: files only, or (a `loopback` input) also http over tcp. */
export function inputProtocols(loopback: boolean): string {
  return loopback ? `${PREVIEW_INPUT_PROTOCOLS},${PREVIEW_LOOPBACK_PROTOCOLS}` : PREVIEW_INPUT_PROTOCOLS;
}

/**
 * Why an input may not run, or null. Every address it opens (each value after `-i`) must be a path, a `file:` or a
 * `concat:` of paths; with `loopback`, also `http://127.0.0.1` (this daemon's own gate), never another host.
 */
export function refusedInput(args: readonly string[], loopback: boolean): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-i') continue;
    const target = args[i + 1] ?? '';
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)?.[1]?.toLowerCase() ?? null;
    if (scheme === null || scheme === 'file' || scheme === 'concat') continue;
    if (scheme === 'http' && loopback) {
      let host = '';
      try {
        host = new URL(target).hostname;
      } catch {
        // not an address: refused below
      }
      if (host === '127.0.0.1') continue;
    }
    return `the input opens ${scheme}: on ${loopback ? 'a host that is not 127.0.0.1' : 'no file of this machine'}, and is not run`;
  }
  return null;
}

/** ffmpeg's arguments for one sheet: the input as LocalVideo.input gave it, one 6×6 JPEG of a frame every 10 s, to `out`. */
export function sheetArgs(input: readonly string[], out: string, loopback = false): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-xerror',
    '-y',
    '-threads',
    '1',
    '-skip_frame',
    'nokey',
    '-protocol_whitelist',
    inputProtocols(loopback),
    ...input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `fps=1/${PREVIEW_INTERVAL_S},scale=${PREVIEW_FRAME_WIDTH}:-2,tile=${PREVIEW_COLS}x${PREVIEW_ROWS}`,
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-q:v',
    '5',
    '-pix_fmt',
    'yuvj420p',
    '-f',
    'mjpeg',
    out,
  ];
}

/** A JPEG's size from its first SOF marker; null for anything that is not a JPEG. */
export function jpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let at = 2;
  while (at + 3 < data.length) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = ((data[at + 2] ?? 0) << 8) | (data[at + 3] ?? 0);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 8 >= data.length) return null;
      const height = ((data[at + 5] ?? 0) << 8) | (data[at + 6] ?? 0);
      const width = ((data[at + 7] ?? 0) << 8) | (data[at + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + length;
  }
  return null;
}

/** How one sheet ended. Only `made` leaves a file; every other outcome leaves no part of the sheet. */
export type SheetOutcome =
  | { kind: 'made'; record: SheetRecord; tookMs: number; nice: number | null }
  | { kind: 'not_yet'; detail: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'no_ffmpeg'; detail: string }
  | { kind: 'aborted' };

export interface SheetBuilderOptions {
  spawn: SpawnPreview;
  /** For log lines only. */
  ffmpegBin: string;
  /** os.setPriority; a test's seam. */
  setPriority?: (pid: number, priority: number) => void;
  /** os.getPriority; a test's seam. */
  getPriority?: (pid: number) => number;
  timeLimitMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** Makes one sheet at a time (PreviewQueue never asks for two at once). */
export class SheetBuilder {
  /** Folders whose leftover `*.part` files (a run a restart cut short) were deleted this run. */
  private readonly swept = new Set<string>();

  constructor(private readonly opts: SheetBuilderOptions) {}

  get ffmpegBin(): string {
    return this.opts.ffmpegBin;
  }

  async build(video: LocalVideo, sheet: SheetSpec, signal: AbortSignal): Promise<SheetOutcome> {
    // Read again now: a cache deleted since the job was queued has no coverage, and its folder is not made again.
    if (!covered(sheet, await video.coverage())) return { kind: 'not_yet', detail: 'the stretch is not on this machine' };
    if (!(await this.prepare(video))) return { kind: 'not_yet', detail: 'the video\'s folder is gone' };
    const final = path.join(video.dir, sheet.name);
    const tmp = `${final}.${randomBytes(4).toString('hex')}.part`;
    const drop = (): Promise<void> => rm(tmp, { force: true });
    let input: PreviewInput;
    try {
      input = await video.input(sheet.startS, sheet.endS);
    } catch (err) {
      return err instanceof PreviewNotYet ? { kind: 'not_yet', detail: err.message } : { kind: 'failed', detail: `the stretch could not be opened: ${messageOf(err)}` };
    }
    const loopback = input.loopback === true;
    const refusal = refusedInput(input.args, loopback);
    if (refusal !== null) {
      await input.cleanup?.().catch(() => undefined);
      return { kind: 'failed', detail: refusal };
    }
    const now = this.opts.now ?? Date.now;
    const started = now();
    const timeLimitMs = this.opts.timeLimitMs ?? PREVIEW_SHEET_TIME_LIMIT_MS;
    const proc = this.opts.spawn(sheetArgs(input.args, tmp, loopback));
    const nice = proc.pid === null ? null : this.lower(proc.pid);
    const run = { timedOut: false };
    const timer = setTimeout(() => {
      run.timedOut = true;
      proc.kill();
    }, timeLimitMs);
    const onAbort = (): void => proc.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    let code: number | null;
    try {
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    let notYet: string | null = null;
    if (input.cleanup !== undefined) {
      try {
        await input.cleanup();
      } catch (err) {
        if (err instanceof PreviewNotYet) notYet = err.message;
        else this.log(`[notesd] previews: could not clean up after ${sheet.name} of ${video.key}: ${messageOf(err)}`);
      }
    }
    const startError = proc.startError();
    if (startError?.code === 'ENOENT') {
      await drop();
      return { kind: 'no_ffmpeg', detail: startError.message };
    }
    if (signal.aborted) {
      await drop();
      return { kind: 'aborted' };
    }
    if (run.timedOut) {
      await drop();
      return { kind: 'failed', detail: `ffmpeg ran past ${Math.round(timeLimitMs / 1000)} s and was stopped` };
    }
    if (!(await this.stillThere(video))) {
      // The video was deleted while ffmpeg ran: nothing is kept and no folder is made again.
      await drop();
      await rmdir(video.dir).catch(() => undefined);
      return { kind: 'not_yet', detail: 'the video was deleted while its sheet was made' };
    }
    if (code !== 0) {
      await drop();
      // A read the input's gate refused or cut short (PreviewNotYet from cleanup) is "not yet", never a try used up.
      if (notYet !== null) return { kind: 'not_yet', detail: notYet };
      const tail = proc.stderrTail();
      return { kind: 'failed', detail: `ffmpeg exited with ${code ?? 'a signal'}${tail === '' ? '' : `: ${tail}`}` };
    }
    let size: { width: number; height: number } | null;
    try {
      size = jpegSize(await readFile(tmp));
    } catch {
      size = null;
    }
    if (size === null || size.width < PREVIEW_COLS || size.height < PREVIEW_ROWS) {
      await drop();
      return { kind: 'failed', detail: 'ffmpeg wrote no picture' };
    }
    try {
      await rename(tmp, final);
    } catch (err) {
      await drop();
      return { kind: 'failed', detail: `the sheet could not be kept: ${messageOf(err)}` };
    }
    return {
      kind: 'made',
      record: {
        index: sheet.index,
        name: sheet.name,
        start_s: sheet.startS,
        end_s: sheet.endS,
        frames: sheet.frames,
        frame_w: Math.floor(size.width / PREVIEW_COLS),
        frame_h: Math.floor(size.height / PREVIEW_ROWS),
      },
      tookMs: now() - started,
      nice,
    };
  }

  /**
   * Makes `dir` one level at a time inside the video's home, never the home itself: false (nothing made) when the home
   * is gone. The first time this run, deletes the `*.part` files a stopped run left in `dir`.
   */
  private async prepare(video: LocalVideo): Promise<boolean> {
    const home = homeOf(video);
    if (!(await isDir(home))) return false;
    const rel = path.relative(home, video.dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    let at = home;
    for (const part of rel === '' ? [] : rel.split(path.sep)) {
      at = path.join(at, part);
      await mkdir(at).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
    }
    const dir = video.dir;
    if (this.swept.has(dir)) return true;
    this.swept.add(dir);
    for (const name of await readdir(dir)) if (name.endsWith('.part')) await rm(path.join(dir, name), { force: true });
    return true;
  }

  /** The video's home and its sheets' folder are both still on disk (checked before a sheet is kept). */
  private async stillThere(video: LocalVideo): Promise<boolean> {
    return (await isDir(homeOf(video))) && (await isDir(video.dir));
  }

  /** Lowers the process to PREVIEW_NICENESS and answers the niceness it runs at (what was set when it ended already). */
  private lower(pid: number): number | null {
    try {
      (this.opts.setPriority ?? ((p: number, n: number) => os.setPriority(p, n)))(pid, PREVIEW_NICENESS);
    } catch (err) {
      this.log(`[notesd] previews: could not lower the priority of ffmpeg ${pid}: ${messageOf(err)}`);
      return null;
    }
    try {
      return (this.opts.getPriority ?? ((p: number) => os.getPriority(p)))(pid);
    } catch {
      return PREVIEW_NICENESS;
    }
  }

  private log(line: string): void {
    (this.opts.log ?? ((l: string) => console.log(l)))(line);
  }
}
