import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { SessionsRepo } from './repo.js';
import { createGitRangeLog, withRangeCommits, type GitRangeLog } from './gitRange.js';
import { createRepoResolver, type RepoResolver } from './repoResolve.js';
import {
  buildTranscriptPatch,
  EXCLUDED_ENTRYPOINTS,
  parseRecord,
  readJsonlFrom,
  TranscriptAccumulator,
  type TranscriptCarry,
  type TranscriptRecord,
} from './transcript.js';

/**
 * Session ingest: keeps one `cc_sessions` row per Claude Code terminal session of this machine
 * in step with `<claudeHome>/projects/<dir>/<uuid>.jsonl`.
 *
 * - Backfill: the first pass reads every transcript on disk (628 files / ~895 MB measured on
 *   2026-11-02; ~2-5 s and ~70 MB RSS for the whole set), newest first, `concurrency` files at a
 *   time, each streamed in 1 MiB chunks.
 * - Tail: every later read starts at the byte offset stored on the row (`transcript_offset`), so a
 *   restart or an append costs only the new bytes. A trailing line without `\n` is not consumed.
 *   A file that shrank below its offset is re-read from 0 (`fromOffset: 0` replaces the row's
 *   accumulated values). The repo's write is a compare-and-set on the stored offset, so a replayed
 *   or stale read changes nothing; ingest then resumes from the offset the repo reports.
 * - Change detection: a chokidar watcher on the project dirs (debounced per burst) plus a full
 *   sweep every `sweepMs` that stats every file and catches anything the watcher missed.
 * - Subagents: `<dir>/<uuid>/subagents/agent-<id>.jsonl` (the Agent tool's subagents of session
 *   `<uuid>`) are tailed the same way, with their own offsets, through
 *   `SessionsRepo.upsertFromSubagentTranscript`: their tokens, models and commits count toward the
 *   parent session (a `p` commit runs in a subagent).
 * - Commits: `[branch sha] subject` lines of `git commit`, plus the commits of every `git push` /
 *   fast-forward `git merge` range, listed with `git log` in the range's cwd (`gitRange.ts`), so a
 *   `git commit -q` still shows once it is merged or pushed. Read only once the parent has a row of this
 *   host, so an excluded (sdk) session's subagents are never read. Observers do not see them.
 * - Excluded: project dirs ending `-data-chat` (the wall chat agent's cwd), files whose
 *   entrypoint is `sdk-ts`/`sdk-cli`, and anything else.
 * - Rows are written only through `SessionsRepo.upsertFromTranscript` (phase 1), with
 *   `host = os.hostname()`. Ingest never writes parent links, tmux or summaries.
 *
 * EXTENSION POINT (phase 4 heuristic links; any later consumer): `IngestObserver`, passed as
 * `observers` or added with `addObserver`. `onBatch` runs after each committed write with the
 * parsed records of exactly the bytes that write covered; `onPassComplete` runs after every full
 * sweep (the startup backfill is `initial: true`) with the ids written in it. Observers are called
 * synchronously after the commit, never awaited, and a throw or rejection is logged and dropped,
 * so an observer can neither slow nor fail ingest.
 */

export const DEFAULT_SWEEP_MS = 60_000;
export const DEFAULT_WATCH_DEBOUNCE_MS = 500;
export const DEFAULT_INGEST_CONCURRENCY = 4;
/** close() waits this long for in-flight reads (each stops at its next chunk). Matches the embedding workers. */
export const DEFAULT_CLOSE_GRACE_MS = 5_000;
const LOG_ERROR_CHARS = 200;

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENTS_DIR = 'subagents';
const SUBAGENT_FILE = /^agent-([0-9A-Za-z_-]{1,128})\.jsonl$/;
const CHAT_PROJECT_DIR = /-data-chat$/;

/**
 * The `SessionsRepo` methods ingest uses. Unit tests pass an in-memory implementation; one without
 * the subagent methods leaves subagent transcripts unread.
 */
export type IngestStore = Pick<SessionsRepo, 'offsets' | 'upsertFromTranscript'> &
  Partial<Pick<SessionsRepo, 'subagentOffsets' | 'upsertFromSubagentTranscript'>>;

export type IngestReason = 'backfill' | 'sweep' | 'watch';

export interface IngestReport {
  reason: IngestReason;
  /** Transcript files considered. */
  files: number;
  /** Rows written. */
  upserted: number;
  /** Bytes consumed (complete lines). */
  bytes: number;
  failed: number;
  ms: number;
}

/** One committed write: the records of bytes [fromOffset, toOffset) of one transcript. */
export interface IngestBatch {
  sessionId: string;
  host: string;
  transcriptPath: string;
  fromOffset: number;
  toOffset: number;
  /** Parsed records of the complete lines read, in file order (ignored record types excluded). */
  records: readonly TranscriptRecord[];
}

/** The end of one full sweep over `<claudeHome>/projects`. */
export interface IngestPass {
  /** True for the first full pass this process completed (the startup backfill). */
  initial: boolean;
  reason: 'backfill' | 'sweep';
  /** Sessions whose row was written during the pass, each once (may be empty). */
  sessionIds: string[];
  report: IngestReport;
}

export interface IngestObserver {
  /** After a write committed. Must not block; a throw is logged and dropped. */
  onBatch?(batch: IngestBatch): void;
  /** After every full sweep. Not awaited; a throw or rejection is logged and dropped. */
  onPassComplete?(pass: IngestPass): void | Promise<void>;
}

export interface SessionIngestOptions {
  /** `config.sessions.claudeHome`; transcripts are under `<claudeHome>/projects`. */
  claudeHome: string;
  /** `config.sessions.worktreesDir`, for repo resolution. */
  worktreesDir: string;
  store: IngestStore;
  /** See EXTENSION POINT above. */
  observers?: IngestObserver[];
  /** Default os.homedir(). */
  homeDir?: string;
  /** Default os.hostname(). */
  hostname?: () => string;
  /** Default `createRepoResolver({ homeDir, worktreesDir })`. */
  resolver?: RepoResolver;
  /** Expands push / merge ranges into commits. Default `createGitRangeLog()` (`git log` in the range's cwd). */
  gitLog?: GitRangeLog;
  /** Watch the project dirs with chokidar. Default true. Tests that drive `sweep()` turn it off. */
  watch?: boolean;
  /** Default DEFAULT_SWEEP_MS. 0 disables the periodic sweep (the backfill still runs). */
  sweepMs?: number;
  /** Default DEFAULT_WATCH_DEBOUNCE_MS. */
  debounceMs?: number;
  /** Files read at once. Default DEFAULT_INGEST_CONCURRENCY. */
  concurrency?: number;
  /** Default DEFAULT_CLOSE_GRACE_MS. */
  closeGraceMs?: number;
  /** Read chunk size, for tests. Default 1 MiB. */
  chunkBytes?: number;
  /** Default console.log. */
  log?: (line: string) => void;
}

export interface SessionIngester {
  /** Settles when the startup backfill pass has finished (never rejects). */
  ready: Promise<IngestReport>;
  /** Adds an observer (see EXTENSION POINT above). Returns the function that removes it. */
  addObserver(observer: IngestObserver): () => void;
  /** One full sweep now. Concurrent calls share the running sweep. */
  sweep(): Promise<IngestReport>;
  /** Resolves when no sweep, watcher burst or file read is running or scheduled. For tests. */
  idle(): Promise<void>;
  /** Stops watching and sweeping; waits at most `closeGraceMs` for in-flight reads. */
  close(): Promise<void>;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, LOG_ERROR_CHARS);
}

/** The session id of a top-level transcript path, or null for anything else. */
export function sessionIdFromPath(file: string): string | null {
  const base = path.basename(file);
  return SESSION_FILE.test(base) ? base.slice(0, -'.jsonl'.length).toLowerCase() : null;
}

/** `{ sessionId, agentId }` of `<dir>/<uuid>/subagents/agent-<id>.jsonl`, or null for anything else. */
export function subagentFromPath(file: string): { sessionId: string; agentId: string } | null {
  const m = SUBAGENT_FILE.exec(path.basename(file));
  const subagents = path.dirname(file);
  const sessionDir = path.basename(path.dirname(subagents));
  if (m === null || m[1] === undefined || path.basename(subagents) !== SUBAGENTS_DIR || !SESSION_DIR.test(sessionDir)) return null;
  return { sessionId: sessionDir.toLowerCase(), agentId: m[1] };
}

/** Project dirs never ingested: the wall chat agent's sessions. */
export function isExcludedProjectDir(name: string): boolean {
  return CHAT_PROJECT_DIR.test(name);
}

export interface TranscriptFile {
  path: string;
  mtimeMs: number;
}

/**
 * Every `<projectsDir>/<dir>/<uuid>.jsonl`, newest first, then every subagent transcript
 * `<dir>/<uuid>/subagents/agent-<id>.jsonl`, newest first (after the sessions, so a parent's row
 * is usually written before its subagents are read). A missing projects dir is an empty list.
 */
export async function listTranscripts(projectsDir: string): Promise<TranscriptFile[]> {
  let dirs;
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  const subagents: TranscriptFile[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || isExcludedProjectDir(dir.name)) continue;
    const dirPath = path.join(projectsDir, dir.name);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SESSION_DIR.test(entry.name)) {
        await listSubagents(path.join(dirPath, entry.name, SUBAGENTS_DIR), subagents);
        continue;
      }
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
      const file = path.join(dirPath, entry.name);
      try {
        files.push({ path: file, mtimeMs: (await stat(file)).mtimeMs });
      } catch {
        // Removed between readdir and stat.
      }
    }
  }
  const newest = (a: TranscriptFile, b: TranscriptFile) => b.mtimeMs - a.mtimeMs;
  return [...files.sort(newest), ...subagents.sort(newest)];
}

async function listSubagents(dir: string, out: TranscriptFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // most sessions never ran a subagent
  }
  for (const entry of entries) {
    if (!entry.isFile() || !SUBAGENT_FILE.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      out.push({ path: file, mtimeMs: (await stat(file)).mtimeMs });
    } catch {
      // Removed between readdir and stat.
    }
  }
}

/**
 * chokidar `ignored`: keep the projects dir, its project dirs, `<uuid>.jsonl` directly inside them,
 * and the `<uuid>/subagents/agent-<id>.jsonl` path (its two folders and the file).
 */
export function isIgnoredWatchPath(projectsDir: string, p: string): boolean {
  const rel = path.relative(projectsDir, path.resolve(p));
  if (rel === '') return false;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true;
  const parts = rel.split(path.sep);
  if (parts.length === 1) return isExcludedProjectDir(parts[0] ?? '');
  const name = parts[1] ?? '';
  if (parts.length === 2) return !SESSION_FILE.test(name) && !SESSION_DIR.test(name);
  if (!SESSION_DIR.test(name) || parts[2] !== SUBAGENTS_DIR) return true;
  if (parts.length === 3) return false;
  return parts.length !== 4 || !SUBAGENT_FILE.test(parts[3] ?? '');
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

export function startSessionIngest(options: SessionIngestOptions): SessionIngester {
  const projectsDir = path.join(options.claudeHome, 'projects');
  const homeDir = options.homeDir ?? os.homedir();
  const host = (options.hostname ?? os.hostname)();
  const resolver = options.resolver ?? createRepoResolver({ homeDir, worktreesDir: options.worktreesDir });
  const gitLog = options.gitLog ?? createGitRangeLog();
  const log = options.log ?? ((line: string) => console.log(line));
  const concurrency = options.concurrency ?? DEFAULT_INGEST_CONCURRENCY;
  const debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  const sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS;

  const observers = new Set<IngestObserver>(options.observers ?? []);
  /** Stored offsets by session id (seeded from the store once, then kept current here). */
  const offsets = new Map<string, number>();
  let seeded: Promise<void> | null = null;
  /** Read-to-read carry per session (message ids, pending commits). Memory only. */
  const carries = new Map<string, TranscriptCarry>();
  /** Files of excluded entry points or of another host's row: never read again in this process. */
  const excluded = new Set<string>();
  /** Stored subagent offsets by transcript path, and their read-to-read carry. */
  const subOffsets = new Map<string, number>();
  const subCarries = new Map<string, TranscriptCarry>();
  /** Files with no entry point yet and no row: size at the last look, re-read only when it changes. */
  const deferred = new Map<string, number>();
  /** Per-file serialization: the running read, and whether another was asked for meanwhile. */
  const inflight = new Map<string, Promise<number>>();
  const again = new Set<string>();
  let closed = false;
  let passesCompleted = 0;
  let sweeping: Promise<IngestReport> | null = null;
  let watchQueue = new Set<string>();
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let watchDrain: Promise<void> | null = null;

  const observerFailed = (err: unknown): void => {
    log(`[notesd] sessions: observer failed: ${errorMessage(err)}`);
  };

  const notifyBatch = (batch: IngestBatch): void => {
    for (const observer of observers) {
      try {
        observer.onBatch?.(batch);
      } catch (err) {
        observerFailed(err);
      }
    }
  };

  const notifyPass = (pass: IngestPass): void => {
    for (const observer of observers) {
      try {
        const result = observer.onPassComplete?.(pass);
        if (result instanceof Promise) result.catch(observerFailed);
      } catch (err) {
        observerFailed(err);
      }
    }
  };

  const seed = (): Promise<void> => {
    seeded ??= Promise.all([options.store.offsets(host), options.store.subagentOffsets?.(host)]).then(
      ([stored, storedSubs]) => {
        for (const [sessionId, entry] of stored) offsets.set(sessionId, entry.offset);
        for (const [file, offset] of storedSubs ?? []) subOffsets.set(file, offset);
      },
      (err: unknown) => {
        seeded = null; // retry on the next pass
        throw err;
      },
    );
    return seeded;
  };

  /**
   * Reads what is new in one subagent transcript and folds it into its parent session. Waits (reads
   * nothing) until the parent has a row of this host. Same offset and retry rules as `readFile`.
   */
  const readSubagentFile = async (file: string, sessionId: string, agentId: string): Promise<number> => {
    const upsert = options.store.upsertFromSubagentTranscript?.bind(options.store);
    if (upsert === undefined) return 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (excluded.has(file) || closed || !offsets.has(sessionId)) return 0;
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        return 0;
      }
      const known = subOffsets.get(file) ?? 0;
      if (size === known) return 0;
      const fromOffset = size < known ? 0 : known;
      const acc = new TranscriptAccumulator(sessionId, fromOffset === 0 ? undefined : subCarries.get(file), { sidechain: true });
      const read = await readJsonlFrom(
        file,
        fromOffset,
        (line) => {
          const record = parseRecord(line);
          if (record !== null) acc.add(record);
        },
        { shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
      if (read.endOffset <= fromOffset) {
        if (size < known) subOffsets.set(file, read.endOffset);
        return 0;
      }
      const delta = acc.delta();
      const result = await upsert({
        sessionId,
        agentId,
        host,
        transcriptPath: file,
        fromOffset,
        toOffset: read.endOffset,
        size: read.size,
        lastActiveAt: delta.lastAt,
        tokens: delta.tokens,
        models: delta.models,
        commits: await withRangeCommits(delta.commits, delta.commitRanges, gitLog),
      });
      if (result.applied) {
        subOffsets.set(file, read.endOffset);
        subCarries.set(file, acc.carry());
        return Math.max(1, read.endOffset - fromOffset);
      }
      if (result.reason === 'other_host') {
        excluded.add(file);
        return 0;
      }
      if (result.reason === 'no_session') return 0;
      subOffsets.set(file, result.storedOffset);
      subCarries.delete(file);
    }
    return 0;
  };

  /**
   * Reads what is new in one file and writes the row. Returns the bytes consumed (0: nothing
   * written). A compare-and-set miss (`offset_mismatch`) adopts the repo's offset and reads once more.
   */
  const readFile = async (file: string): Promise<number> => {
    const subagent = subagentFromPath(file);
    if (subagent !== null) return readSubagentFile(file, subagent.sessionId, subagent.agentId);
    const sessionId = sessionIdFromPath(file);
    if (sessionId === null) return 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (excluded.has(file) || closed) return 0;
      let size: number;
      try {
        size = (await stat(file)).size;
      } catch {
        return 0; // deleted (Claude Code prunes old transcripts)
      }
      const known = offsets.get(sessionId) ?? 0;
      if (size === known || deferred.get(file) === size) return 0;
      const fromOffset = size < known ? 0 : known;
      const acc = new TranscriptAccumulator(sessionId, fromOffset === 0 ? undefined : carries.get(sessionId));
      const keepRecords = [...observers].some((o) => o.onBatch !== undefined);
      const records: TranscriptRecord[] = [];
      const read = await readJsonlFrom(
        file,
        fromOffset,
        (line) => {
          const record = parseRecord(line);
          if (record === null) return;
          acc.add(record);
          if (keepRecords) records.push(record);
        },
        { shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
      if (read.endOffset <= fromOffset) {
        if (size < known) offsets.set(sessionId, read.endOffset);
        return 0;
      }
      const delta = acc.delta();
      let repo: string | null = null;
      if (fromOffset === 0) {
        if (delta.entrypoint !== null && EXCLUDED_ENTRYPOINTS.has(delta.entrypoint)) {
          excluded.add(file);
          return 0;
        }
        if (delta.entrypoint === null && !offsets.has(sessionId)) {
          // Only bookkeeping records so far and no row: wait for the first message.
          deferred.set(file, size);
          return 0;
        }
        repo = await resolver.resolve(delta.cwd, path.basename(path.dirname(file)));
      }
      const patch = buildTranscriptPatch(delta, { host, transcriptPath: file, fromOffset, toOffset: read.endOffset, size: read.size, repo });
      patch.commits = await withRangeCommits(delta.commits, delta.commitRanges, gitLog);
      const result = await options.store.upsertFromTranscript(patch);
      if (result.applied) {
        offsets.set(sessionId, read.endOffset);
        carries.set(sessionId, acc.carry());
        deferred.delete(file);
        notifyBatch({ sessionId, host, transcriptPath: file, fromOffset, toOffset: read.endOffset, records });
        return Math.max(1, read.endOffset - fromOffset);
      }
      if (result.reason === 'other_host') {
        excluded.add(file);
        log(`[notesd] sessions: ${sessionId} belongs to host ${result.row.host}; not ingesting ${file}`);
        return 0;
      }
      offsets.set(sessionId, result.storedOffset);
      carries.delete(sessionId);
    }
    return 0;
  };

  /** `readFile`, serialized per file: a request during a read runs once more right after it. */
  const runFile = (file: string): Promise<number> => {
    const running = inflight.get(file);
    if (running !== undefined) {
      again.add(file);
      return running.then(() => 0);
    }
    const task = (async () => {
      let bytes = 0;
      do {
        again.delete(file);
        bytes += await readFile(file);
      } while (again.has(file) && !closed);
      return bytes;
    })().finally(() => inflight.delete(file));
    inflight.set(file, task);
    return task;
  };

  const pass = async (files: string[], reason: IngestReason): Promise<{ report: IngestReport; written: string[] } | null> => {
    const started = Date.now();
    const report: IngestReport = { reason, files: files.length, upserted: 0, bytes: 0, failed: 0, ms: 0 };
    const written: string[] = [];
    try {
      await seed();
    } catch (err) {
      log(`[notesd] sessions: could not load offsets: ${errorMessage(err)}`);
      return null;
    }
    // Sessions first, then subagents: a subagent is read only once its parent has a row.
    const isSub = (file: string) => subagentFromPath(file) !== null;
    const ordered = [files.filter((f) => !isSub(f)), files.filter(isSub)];
    const one = async (file: string): Promise<void> => {
      if (closed) return;
      try {
        const bytes = await runFile(file);
        if (bytes > 0) {
          report.upserted += 1;
          report.bytes += bytes;
          const id = sessionIdFromPath(file);
          if (id !== null) written.push(id);
        }
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: ${path.basename(file)}: ${errorMessage(err)}`);
      }
    };
    for (const wave of ordered) await forEachLimit(wave, concurrency, one);
    report.ms = Date.now() - started;
    return { report, written };
  };

  const fullSweep = (reason: 'backfill' | 'sweep'): Promise<IngestReport> => {
    if (sweeping !== null) return sweeping;
    const run = (async (): Promise<IngestReport> => {
      const files = (await listTranscripts(projectsDir)).map((f) => f.path);
      const result = await pass(files, reason);
      if (result === null) return { reason, files: files.length, upserted: 0, bytes: 0, failed: files.length, ms: 0 };
      if (!closed) {
        notifyPass({ initial: passesCompleted === 0, reason, sessionIds: [...new Set(result.written)], report: result.report });
        passesCompleted += 1;
      }
      return result.report;
    })().finally(() => {
      if (sweeping === run) sweeping = null;
    });
    sweeping = run;
    return run;
  };

  const drainWatch = (): void => {
    watchTimer = null;
    if (closed || watchQueue.size === 0) return;
    const files = [...watchQueue];
    watchQueue = new Set();
    const run = pass(files, 'watch').then(
      (result) => {
        if (result !== null && result.report.failed > 0) log(formatReport(result.report));
      },
      (err: unknown) => log(`[notesd] sessions: watch pass failed: ${errorMessage(err)}`),
    );
    const tracked: Promise<void> = run.finally(() => {
      if (watchDrain === tracked) watchDrain = null;
    });
    watchDrain = tracked;
  };

  const queueWatch = (p: string): void => {
    if (closed) return;
    const file = path.resolve(p);
    if (sessionIdFromPath(file) === null && subagentFromPath(file) === null) return;
    watchQueue.add(file);
    watchTimer ??= setTimeout(drainWatch, debounceMs);
  };

  let watcher: FSWatcher | null = null;
  if (options.watch !== false && existsSync(projectsDir)) {
    watcher = watch(projectsDir, {
      ignoreInitial: true,
      persistent: true,
      depth: 3,
      ignored: (p: string) => isIgnoredWatchPath(projectsDir, p),
    });
    watcher.on('add', queueWatch);
    watcher.on('change', queueWatch);
    watcher.on('error', (err: unknown) => log(`[notesd] sessions: watcher error: ${errorMessage(err)}`));
  }

  const ready = fullSweep('backfill').then(
    (report) => {
      log(formatReport(report));
      return report;
    },
    (err: unknown) => {
      log(`[notesd] sessions: backfill failed: ${errorMessage(err)}`);
      return { reason: 'backfill' as const, files: 0, upserted: 0, bytes: 0, failed: 1, ms: 0 };
    },
  );

  let timer: ReturnType<typeof setInterval> | null = null;
  if (sweepMs > 0) {
    timer = setInterval(() => {
      if (closed) return;
      fullSweep('sweep').then(
        (report) => {
          if (report.failed > 0) log(formatReport(report));
        },
        (err: unknown) => log(`[notesd] sessions: sweep failed: ${errorMessage(err)}`),
      );
    }, sweepMs);
    timer.unref();
  }

  return {
    ready,
    addObserver(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    sweep: () => fullSweep('sweep'),
    async idle() {
      for (;;) {
        if (watchTimer !== null) {
          clearTimeout(watchTimer);
          drainWatch();
        }
        const pending = [sweeping, watchDrain, ...inflight.values()].filter((p) => p !== null);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearInterval(timer);
      if (watchTimer !== null) clearTimeout(watchTimer);
      watchTimer = null;
      const closing = watcher?.close().catch(() => undefined);
      const pending = Promise.allSettled([closing, sweeping, watchDrain, ...inflight.values()]);
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, closeGraceMs);
          grace.unref();
        }),
      ]);
      if (grace !== undefined) clearTimeout(grace);
    },
  };
}

/** e.g. `[notesd] sessions: backfill 628 files, 612 rows written, 838.2 MB, 0 failed, 2205ms` */
export function formatReport(report: IngestReport): string {
  const mb = (report.bytes / (1024 * 1024)).toFixed(1);
  return `[notesd] sessions: ${report.reason} ${report.files} files, ${report.upserted} rows written, ${mb} MB, ${report.failed} failed, ${report.ms}ms`;
}
