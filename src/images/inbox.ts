import { mkdir, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { IngestResult } from './ingest.js';
import { sniffImageFile } from './probe.js';
import { fileExists, moveIntoNewFile } from './store.js';

export type InboxLogger = {
  info: (msg: string) => void;
  error: (msg: string) => void;
};

export type InboxWatcherOptions = {
  /** Absolute path of `<dataDir>/inbox`. */
  inboxDir: string;
  /** Absolute path of `<dataDir>/inbox/failed`. */
  failedDir: string;
  /** Ingest one file; expected to move it into the store (move: true). */
  ingest: (absPath: string) => Promise<IngestResult>;
  log?: InboxLogger;
  /** How long the size must stay unchanged before a file is taken. Default 2000 ms. */
  stabilityThresholdMs?: number;
  /** Size polling interval while waiting. Default 200 ms. */
  pollIntervalMs?: number;
};

export type InboxWatcher = {
  /** Resolves when every file seen so far has been handled. */
  idle: () => Promise<void>;
  close: () => Promise<void>;
};

const PARTIAL_SUFFIXES = ['.crdownload', '.part', '.partial', '.tmp', '.download', '.opdownload', '.!ut'];

/** Dotfiles and in-progress downloads are never touched. */
export function isIgnoredInboxName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.') || lower.startsWith('~$')) return true;
  return PARTIAL_SUFFIXES.some((s) => lower.endsWith(s));
}

const consoleLog: InboxLogger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/** `failed/<name>`, or `failed/<stem>-<epoch ms>[-n]<ext>` when the name is taken. */
async function failedTarget(failedDir: string, name: string): Promise<string> {
  let candidate = path.join(failedDir, name);
  if (!(await fileExists(candidate))) return candidate;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const stamp = Date.now();
  for (let n = 0; ; n++) {
    candidate = path.join(failedDir, `${stem}-${stamp}${n ? `-${n}` : ''}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
}

/** Wait until size and mtime hold still for `stableMs`. false if the file disappears. */
async function waitStable(absPath: string, stableMs: number, pollMs: number): Promise<boolean> {
  let last = '';
  let since = Date.now();
  for (;;) {
    let sig: string;
    try {
      const s = await stat(absPath);
      sig = `${s.size}:${s.mtimeMs}`;
    } catch {
      return false;
    }
    if (sig !== last) {
      last = sig;
      since = Date.now();
    } else if (Date.now() - since >= stableMs) {
      return true;
    }
    await sleep(pollMs);
  }
}

/**
 * Watch `<dataDir>/inbox` (top level only). Every image that appears — and every image already
 * there at startup — is ingested once its size has been stable for `stabilityThresholdMs`.
 * Files that are not images stay where they are. A failed ingest moves the file to
 * `inbox/failed/` and logs one line. Files are handled one at a time, in arrival order.
 */
export async function startInboxWatcher(opts: InboxWatcherOptions): Promise<InboxWatcher> {
  const inboxDir = path.resolve(opts.inboxDir);
  const failedDir = path.resolve(opts.failedDir);
  const log = opts.log ?? consoleLog;
  await mkdir(failedDir, { recursive: true });

  const stabilityMs = opts.stabilityThresholdMs ?? 2000;
  const pollMs = opts.pollIntervalMs ?? 200;
  const seen = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let ready = false;

  async function handle(absPath: string, checkStable: boolean): Promise<void> {
    const name = path.basename(absPath);
    try {
      if (checkStable && !(await waitStable(absPath, stabilityMs, pollMs))) return;
      if (!(await fileExists(absPath))) return;
      const sniff = await sniffImageFile(absPath);
      if (!sniff) {
        log.info(`[inbox] ignored ${name}: not an image`);
        return;
      }
      const { note, created } = await opts.ingest(absPath);
      log.info(`[inbox] ${name} -> ${note.id}${created ? '' : ' (already stored)'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!(await fileExists(absPath))) {
        log.error(`[inbox] failed ${name}: ${msg}`);
        return;
      }
      try {
        const target = await failedTarget(failedDir, name);
        await moveIntoNewFile(absPath, target);
        log.error(`[inbox] failed ${name}: ${msg} -> inbox/failed/${path.basename(target)}`);
      } catch (moveErr) {
        const moveMsg = moveErr instanceof Error ? moveErr.message : String(moveErr);
        log.error(`[inbox] failed ${name}: ${msg}; could not move it to inbox/failed/: ${moveMsg}`);
      }
    } finally {
      seen.delete(absPath);
    }
  }

  function enqueue(absPath: string): void {
    const p = path.resolve(absPath);
    if (path.dirname(p) !== inboxDir || isIgnoredInboxName(path.basename(p)) || seen.has(p)) return;
    seen.add(p);
    // chokidar's awaitWriteFinish does not hold back the initial scan, so files found
    // before 'ready' get the same stable-size wait here.
    const checkStable = !ready;
    queue = queue.then(() => handle(p, checkStable));
  }

  const watcher: FSWatcher = watch(inboxDir, {
    depth: 0,
    ignoreInitial: false,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: stabilityMs,
      pollInterval: pollMs,
    },
    ignored: (p: string, stats?: { isDirectory(): boolean }) => {
      const abs = path.resolve(p);
      if (abs === inboxDir) return false;
      if (path.dirname(abs) !== inboxDir) return true;
      if (stats?.isDirectory()) return true;
      return isIgnoredInboxName(path.basename(abs));
    },
  });
  watcher.on('add', (p: string) => enqueue(p));
  watcher.on('error', (err: unknown) => {
    log.error(`[inbox] watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });
  await new Promise<void>((resolve) => {
    watcher.once('ready', () => {
      ready = true;
      resolve();
    });
  });

  return {
    idle: async () => {
      let current: Promise<void>;
      do {
        current = queue;
        await current;
      } while (current !== queue);
    },
    close: async () => {
      await watcher.close();
      await queue;
    },
  };
}
