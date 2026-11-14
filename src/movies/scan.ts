import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isVideoFile } from './parse.js';

export type ScanEntryKind = 'file' | 'dir' | 'other';

export interface ScanEntry {
  name: string;
  /** Symlinks and anything else that is not a plain file or directory are 'other' and never followed. */
  kind: ScanEntryKind;
}

/** The filesystem calls a walk makes. Tests pass an in-memory fake; the daemon uses `nodeScanFs`. */
export interface ScanFs {
  /** Entries of one directory. Throws when the directory cannot be read. */
  list(dir: string): Promise<ScanEntry[]>;
  /** Size in bytes and modification time (ms since epoch) of one file. */
  stat(file: string): Promise<{ size: number; mtimeMs: number }>;
}

export const nodeScanFs: ScanFs = {
  async list(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry): ScanEntry => ({
      name: entry.name,
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other',
    }));
  },
  async stat(file) {
    const s = await stat(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
};

export interface ScannedFile {
  /** The configured root the file was found under (absolute, resolved). */
  root: string;
  /** Absolute Linux path. */
  path: string;
  /** Path below the root, '/'-separated: what parseVideoPath and the done-dir rule read. */
  relPath: string;
  name: string;
  size: number;
  mtime: Date;
}

export interface WalkResult {
  /** Video files under the roots, sorted by path, each listed once. */
  files: ScannedFile[];
  /** Roots, directories and files that could not be read this pass. Tracked files under them are left alone. */
  unreadable: string[];
}

export interface WalkOptions {
  fs?: ScanFs;
  signal?: AbortSignal;
  /** Directory levels below a root that are still walked. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 24;

/** Walks exactly `roots`, recursively, and returns the video files under them (R1.4). Never throws for an unreadable path. */
export async function walkRoots(roots: readonly string[], options: WalkOptions = {}): Promise<WalkResult> {
  const fs = options.fs ?? nodeScanFs;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const files: ScannedFile[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const rawRoot of roots) {
    const root = path.resolve(rawRoot);
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      options.signal?.throwIfAborted();
      let entries: ScanEntry[];
      try {
        entries = await fs.list(next.dir);
      } catch {
        unreadable.push(next.dir);
        continue;
      }
      for (const entry of entries) {
        const full = path.join(next.dir, entry.name);
        if (entry.kind === 'dir') {
          if (next.depth < maxDepth) stack.push({ dir: full, depth: next.depth + 1 });
          continue;
        }
        if (entry.kind !== 'file' || !isVideoFile(entry.name) || seen.has(full)) continue;
        let st: { size: number; mtimeMs: number };
        try {
          st = await fs.stat(full);
        } catch {
          unreadable.push(full);
          continue;
        }
        seen.add(full);
        files.push({
          root,
          path: full,
          relPath: path.relative(root, full).split(path.sep).join('/'),
          name: entry.name,
          size: st.size,
          mtime: new Date(st.mtimeMs),
        });
      }
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, unreadable };
}

/** Duration in seconds of one video file. */
export type Probe = (file: string, signal?: AbortSignal) => Promise<number>;

export type ProbeFailure = 'missing_binary' | 'failed';

export class ProbeError extends Error {
  override name = 'ProbeError';
  constructor(
    readonly code: ProbeFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** ffprobe over drvfs reads a 2-hour mkv in well under a second; a stuck read is killed after this. */
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/**
 * `ffprobe -v error -show_entries format=duration -of csv=p=0 <file>` -> seconds.
 * Rejects with ProbeError('missing_binary') when ffprobe cannot be spawned, ProbeError('failed')
 * on a non-zero exit, a timeout or output without a positive duration, and with the AbortError
 * when `signal` aborts.
 */
export function probeDuration(ffprobeBin: string, file: string, options: ProbeOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      {
        timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        signal: options.signal,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (err, stdout) => {
        if (err !== null) {
          if (err.name === 'AbortError') {
            reject(err);
            return;
          }
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new ProbeError('missing_binary', `ffprobe not found at "${ffprobeBin}" (set NOTESD_FFPROBE_BIN)`));
            return;
          }
          const why = err.killed ? 'timed out' : (err.message.split('\n')[0] ?? 'failed');
          reject(new ProbeError('failed', `ffprobe on ${file}: ${why}`));
          return;
        }
        const seconds = Number.parseFloat(String(stdout).trim().split(/\r?\n/)[0] ?? '');
        if (!Number.isFinite(seconds) || seconds <= 0) {
          reject(new ProbeError('failed', `ffprobe printed no duration for ${file}`));
          return;
        }
        resolve(seconds);
      },
    );
  });
}
