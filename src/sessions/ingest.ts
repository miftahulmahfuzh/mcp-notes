import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { SessionsRepo } from './repo.js';
import { headUuid, jobStateFor } from './fork.js';
import {
  PROMPTS_VERSION_EXCERPTS,
  type ContextBackfillRow,
  type ContextFill,
  type FillContextResult,
  type ForkBackfillRow,
  type HeadUuidFill,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
} from './types.js';
import { createGitRangeLog, withRangeCommits, type GitRangeLog } from './gitRange.js';
import { createRepoResolver, type RepoResolver } from './repoResolve.js';
import { isPendingCut, scanFork, type ForkScan } from './forkDetect.js';
import {
  buildTranscriptPatch,
  EXCLUDED_ENTRYPOINTS,
  isCopiedRecord,
  isLongContextRequestLine,
  isObject,
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
 *   `host = os.hostname()`. Ingest writes no tmux or summaries, and one kind of parent link only:
 *   `fork`, in the same transaction as the fork's row (see Forks).
 * - Forks: every read from byte 0 runs fork detection first (forkDetect.ts scanFork: a background
 *   job's state.json, else the rows of this host that share the file's head uuid). In a fork,
 *   records that have a uuid and start before the cut (transcript.ts isCopiedRecord) are the
 *   parent's copied history: they feed only cwd, entry point, branch and version, and are left out
 *   of the row's counts and of the observers' batch records. Records without a uuid are always
 *   read. While a fork holds only copied records its cut is pending: the read stops where
 *   detection stopped and every later read starts at byte 0 again until its first own record
 *   arrives (after a restart, a stored `fork_cut_offset >= transcript_offset` says so). Detection
 *   never fails a read: an error reads the file as an ordinary session and is logged once, except
 *   for a fork whose cut is pending, which waits for its next change.
 *
 * - Full prompts and replies: every write carries every prompt of the bytes it read and Claude's
 *   reply to each (SessionsRepo stores them, redacted, in `cc_session_prompts` and
 *   `cc_session_replies`; a turn split across reads is joined or superseded there, see
 *   `TranscriptDelta.leadingReply`). Once the startup pass is done, `promptsBackfill` runs once:
 *   each row of this host still below PROMPTS_VERSION or REPLIES_VERSION has its transcript re-read
 *   from 0 to its stored offset for prompts and replies only (no tokens, commits, links or
 *   observers) and its prompt columns and replies replaced (`SessionsRepo.replacePrompts`, a
 *   compare-and-set on the offset), under the same per-file hold as the tail reads. A row whose
 *   transcript is gone has its stored excerpts redacted in place (`redactStoredPrompts`,
 *   PROMPTS_VERSION_EXCERPTS) and keeps no replies; it stays a candidate, is skipped without a
 *   write (or a lock) while the file is missing, and is filled if the file is readable again. Only
 *   transcripts under `<claudeHome>/projects` are read. One log line, only when a row changed,
 *   was deferred or failed.
 * - Forks in the backfills: a fork's row stores `fork_cut_offset`. The prompts backfill skips the records with a
 *   uuid before it (`isCopiedRecord`), as the tail ingester did, so a fork never gets its parent's
 *   prompts or replies back. Before the prompts backfill, `forkBackfill` runs once per host
 *   (FORK_BACKFILL_VERSION, app_settings `${FORK_MARKER_PREFIX}${host}`): it fills head_uuid for rows
 *   ingested before it existed, checks every row that shares a head uuid with another row or has a
 *   background-job record with the fork detector, and re-reads each fork from byte 0 under the
 *   per-file hold, which links it (`fork`) and cuts the copied prefix. A transcript that is gone is
 *   skipped without a write; the marker is written once nothing was deferred or failed.
 * - Context (migration 0016): every session-file read also gathers the session's context evidence
 *   (TranscriptAccumulator: the latest main-chain assistant message's input + cache + output
 *   tokens, its model and time, the peak, the first own message's context) and, from the raw text
 *   of `api-request` lines that parseRecord drops unparsed, whether a main-thread request listed a
 *   `context-1m-*` beta (transcript.ts isLongContextRequestLine). SessionsRepo merges it
 *   (merge.ts mergeContext). Subagent transcripts never feed it. Rows ingested before it existed
 *   are filled once per host by `contextBackfill` (CONTEXT_BACKFILL_VERSION, app_settings
 *   `${CONTEXT_MARKER_PREFIX}${host}`), after the prompts backfill: each row's transcript is re-read
 *   from 0 to its stored offset under the per-file hold, a fork's copied records feed only the
 *   snapshot and peak as in a tail read, and `SessionsRepo.fillContext` writes the six columns (a
 *   compare-and-set on the offset; no observers, no updated_at). A transcript that is gone is
 *   skipped without a write; the marker is written once nothing was deferred or failed.
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
 * the subagent methods leaves subagent transcripts unread; one without the three prompts methods
 * skips the prompts backfill; one without `forkCandidates` finds forks from job state only; one
 * without forkBackfillRows, fillHeadUuids, getSetting or putSetting skips the fork backfill; one
 * without contextBackfillRows, fillContext, getSetting or putSetting skips the context backfill.
 */
export type IngestStore = Pick<SessionsRepo, 'offsets' | 'upsertFromTranscript'> &
  Partial<
    Pick<
      SessionsRepo,
      | 'subagentOffsets'
      | 'upsertFromSubagentTranscript'
      | 'promptsBackfillCandidates'
      | 'replacePrompts'
      | 'redactStoredPrompts'
      | 'forkCandidates'
      | 'forkBackfillRows'
      | 'fillHeadUuids'
      | 'contextBackfillRows'
      | 'fillContext'
      | 'getSetting'
      | 'putSetting'
      | 'requestSummary'
    >
  >;

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

/** What the one-time prompts backfill did. */
export interface PromptsBackfillReport {
  /** Rows of this host below PROMPTS_VERSION or REPLIES_VERSION when it started. */
  candidates: number;
  /** Re-read from the transcript and replaced. */
  filled: number;
  /** Transcript gone: stored excerpts redacted in place (PROMPTS_VERSION_EXCERPTS). */
  redacted: number;
  /** Nothing to do when reached: already redacted in place with the transcript still gone, or already current. */
  skipped: number;
  /** Left for the next daemon start: closing, a file that shrank, a second offset miss, a path outside this Claude home. */
  deferred: number;
  failed: number;
  ms: number;
}

type PromptsBackfillOutcome = 'filled' | 'redacted' | 'skipped' | 'deferred';

function emptyPromptsReport(): PromptsBackfillReport {
  return { candidates: 0, filled: 0, redacted: 0, skipped: 0, deferred: 0, failed: 0, ms: 0 };
}

/** Bump to make every host run the fork backfill once more (e.g. after detection improves). */
export const FORK_BACKFILL_VERSION = 1;
/** app_settings key prefix; the full key is `${FORK_MARKER_PREFIX}${host}`. */
export const FORK_MARKER_PREFIX = 'sessions.forks.backfill.';

/** What the one-time fork backfill did. */
export interface ForkBackfillReport {
  /** False when the marker says it already ran at FORK_BACKFILL_VERSION, or the store lacks the methods. */
  ran: boolean;
  /** Rows of this host with a transcript path. */
  rows: number;
  /** Rows given a head uuid they did not have. */
  headsFilled: number;
  /** Rows the fork detector looked at: a head uuid shared with another row, or a background-job record. */
  candidates: number;
  /** Rows the detector called a fork. */
  forks: number;
  /** Forks re-read from byte 0 (linked `fork`, copied prefix cut). */
  reingested: number;
  /** Transcript gone, or outside this Claude home: skipped without a write. */
  missing: number;
  /** A fork whose re-read wrote nothing (the file changed under it): left for the next start. */
  deferred: number;
  failed: number;
  ms: number;
}

function emptyForkReport(): ForkBackfillReport {
  return { ran: false, rows: 0, headsFilled: 0, candidates: 0, forks: 0, reingested: 0, missing: 0, deferred: 0, failed: 0, ms: 0 };
}

/** Bump to make every host run the context backfill once more (e.g. after the capture rules change). */
export const CONTEXT_BACKFILL_VERSION = 1;
/** app_settings key prefix; the full key is `${CONTEXT_MARKER_PREFIX}${host}`. */
export const CONTEXT_MARKER_PREFIX = 'sessions.context_backfill.';

/** What the one-time context backfill did. */
export interface ContextBackfillReport {
  /** False when the marker says it already ran at CONTEXT_BACKFILL_VERSION, or the store lacks the methods. */
  ran: boolean;
  /** Rows of this host with a transcript path. */
  rows: number;
  /** Re-read and written (or found already current). */
  filled: number;
  /** Transcript gone, outside this Claude home, or the row gone or moved host: skipped without a write. */
  missing: number;
  /** Left for the next daemon start: closing, a file shorter than its offset, a second offset miss. */
  deferred: number;
  failed: number;
  ms: number;
}

type ContextBackfillOutcome = 'filled' | 'missing' | 'deferred';
type FillContext = (sessionId: string, host: string, fill: ContextFill) => Promise<FillContextResult>;

function emptyContextReport(): ContextBackfillReport {
  return { ran: false, rows: 0, filled: 0, missing: 0, deferred: 0, failed: 0, ms: 0 };
}

async function fileSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** True when `file` is inside `dir` (not `dir` itself). */
function isUnder(dir: string, file: string): boolean {
  const rel = path.relative(dir, path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
  /** Settles once the one-time fork backfill that follows `ready` is done (never rejects). */
  forkBackfill: Promise<ForkBackfillReport>;
  /** Settles once the one-time prompts backfill that follows `forkBackfill` is done (never rejects). */
  promptsBackfill: Promise<PromptsBackfillReport>;
  /** Settles once the one-time context backfill that follows `promptsBackfill` is done (never rejects). */
  contextBackfill: Promise<ContextBackfillReport>;
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
  /** Forks whose cut is not final yet (only copied records read so far): every read starts at byte 0. */
  const pendingCuts = new Set<string>();
  /** Sessions whose failed fork detection was already logged (once each). */
  const forkErrorsLogged = new Set<string>();
  const forkCandidates = options.store.forkCandidates?.bind(options.store);
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
        for (const [sessionId, entry] of stored) {
          offsets.set(sessionId, entry.offset);
          const cut = entry.forkCutOffset ?? null;
          if (cut !== null && entry.offset > 0 && isPendingCut(cut, entry.offset)) pendingCuts.add(sessionId);
        }
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
   * Fork detection for a read from byte 0 (forkDetect.ts scanFork). Never throws. Null: the head
   * uuid could not be read (logged once per session). A scan with `error` set: the head uuid is
   * known, the fork is not (logged once per session). Phase 3's backfill asks the same question
   * through this function.
   */
  const scanForkSafely = async (file: string, sessionId: string): Promise<ForkScan | null> => {
    const failed = (message: string): void => {
      if (forkErrorsLogged.has(sessionId)) return;
      forkErrorsLogged.add(sessionId);
      log(`[notesd] sessions: fork detection for ${sessionId} failed, reading it as an ordinary session: ${message.slice(0, LOG_ERROR_CHARS)}`);
    };
    try {
      const scan = await scanFork(file, sessionId, { claudeHome: options.claudeHome, host, ...(forkCandidates !== undefined ? { forkCandidates } : {}) });
      if (scan.error !== null) failed(scan.error);
      return scan;
    } catch (err) {
      failed(errorMessage(err));
      return null;
    }
  };

  /**
   * Reads what is new in one file and writes the row. Returns the bytes consumed (0: nothing
   * written). A compare-and-set miss (`offset_mismatch`) adopts the repo's offset and reads once more.
   * A read from byte 0 runs fork detection first and leaves a fork's copied records out (header, Forks).
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
      // A fork whose cut is pending is read whole again: the bytes after its stored offset may be
      // the rest of the copy rather than its own records.
      const fromOffset = size < known || pendingCuts.has(sessionId) ? 0 : known;
      let scan: ForkScan | null = null;
      if (fromOffset === 0) {
        scan = await scanForkSafely(file, sessionId);
        // Read without its cut, a pending fork would count the copy: wait for the next change or sweep.
        if ((scan === null || scan.error !== null) && pendingCuts.has(sessionId)) return 0;
      }
      const fork = scan?.fork ?? null;
      const cutOffset = fork?.cutOffset ?? null;
      const acc = new TranscriptAccumulator(sessionId, fromOffset === 0 ? undefined : carries.get(sessionId));
      const keepRecords = [...observers].some((o) => o.onBatch !== undefined);
      const records: TranscriptRecord[] = [];
      const read = await readJsonlFrom(
        file,
        fromOffset,
        (line, lineStart) => {
          // parseRecord drops api-request lines unparsed; the one fact a row takes from them, a
          // main-thread 1M beta, is read from the raw text.
          if (isLongContextRequestLine(line)) acc.noteLongContextBeta();
          const record = parseRecord(line);
          if (record === null) return;
          if (isCopiedRecord(record, lineStart, cutOffset)) {
            acc.addCopied(record);
            return;
          }
          acc.add(record);
          if (keepRecords) records.push(record);
        },
        {
          shouldStop: () => closed,
          // A pending cut ends where detection stopped reading: what follows may be more of the copy.
          ...(fork !== null && !fork.final ? { until: fork.cutOffset } : {}),
          ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}),
        },
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
      if (scan !== null && scan.headUuid !== null) patch.headUuid = scan.headUuid;
      if (fork !== null) patch.fork = fork;
      const result = await options.store.upsertFromTranscript(patch);
      if (result.applied) {
        offsets.set(sessionId, read.endOffset);
        carries.set(sessionId, acc.carry());
        deferred.delete(file);
        if (fromOffset === 0) {
          if (fork !== null && isPendingCut(fork.cutOffset, read.endOffset)) pendingCuts.add(sessionId);
          else pendingCuts.delete(sessionId);
        }
        if (fork !== null && (result.forkLink === 'cycle' || result.forkLink === 'missing')) {
          log(`[notesd] sessions: fork ${sessionId} not linked to ${fork.parentSessionId}: ${result.forkLink}`);
        }
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

  /**
   * Holds `file` for one task: `first`, then every read asked for meanwhile (`again`), in order.
   * Tail reads and the prompts backfill of a file both go through here, so they never overlap.
   */
  const holdFile = (file: string, first: () => Promise<number>): Promise<number> => {
    const task: Promise<number> = (async () => {
      let bytes = await first();
      while (again.has(file) && !closed) {
        again.delete(file);
        bytes += await readFile(file);
      }
      return bytes;
    })().finally(() => {
      if (inflight.get(file) === task) inflight.delete(file);
    });
    inflight.set(file, task);
    return task;
  };

  /** `readFile`, serialized per file: a request during a read (or a backfill) runs once more right after it. */
  const runFile = (file: string): Promise<number> => {
    const running = inflight.get(file);
    if (running !== undefined) {
      again.add(file);
      return running.then(() => 0);
    }
    return holdFile(file, () => {
      again.delete(file);
      return readFile(file);
    });
  };

  /**
   * Runs `body` with `file` held: after the running read (if any), before any read asked for while
   * it runs. `body()` starts in the same tick the hold is taken, so no read can slip in between.
   */
  const withFileHeld = async <T>(file: string, body: () => Promise<T>): Promise<T> => {
    for (;;) {
      const running = inflight.get(file);
      if (running === undefined) break;
      await running.catch(() => 0);
    }
    const result = body();
    await holdFile(file, () => result.then(() => 0));
    return result;
  };

  /**
   * Re-reads `file` from byte 0 under the per-file hold: the in-memory offset is set to 0 in the
   * same tick the hold is taken, so this read takes `readFile`'s 0-read path (fork detection, the
   * `fork` link and the cut, written in one upsert that replaces the row's counters) and no tail read
   * can slip in first. A read that writes nothing puts the old offset back, so memory keeps matching
   * the row. Returns the bytes written (0: nothing written).
   */
  const rereadFromZero = (file: string, sessionId: string): Promise<number> =>
    withFileHeld(file, async () => {
      const before = offsets.get(sessionId);
      offsets.set(sessionId, 0);
      carries.delete(sessionId);
      deferred.delete(file);
      const bytes = await readFile(file);
      if (bytes === 0 && offsets.get(sessionId) === 0 && before !== undefined) offsets.set(sessionId, before);
      return bytes;
    });

  interface PromptsFill {
    replace: (sessionId: string, host: string, input: PromptsReplacement) => Promise<ReplacePromptsResult>;
    redact: (sessionId: string, host: string) => Promise<RedactStoredPromptsResult>;
  }

  /**
   * One candidate of the prompts backfill. Re-reads the transcript from 0 to the stored offset,
   * collecting prompts and replies only, and replaces the row's prompt columns and replies. An
   * offset miss (a tail write landed first) retries once with the stored offset; a second miss
   * waits for the next start.
   */
  const backfillSession = async (c: PromptsBackfillCandidate, fill: PromptsFill): Promise<PromptsBackfillOutcome> => {
    let upTo = c.transcriptOffset;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (closed) return 'deferred';
      const file = c.transcriptPath;
      if (file !== null && !isUnder(projectsDir, file)) return 'deferred';
      const size = file === null ? null : await fileSize(file);
      if (file === null || size === null) {
        // Transcript gone. Nothing is left to redact at PROMPTS_VERSION_EXCERPTS or above, and the
        // replies cannot be recovered: skip without a write or a row lock.
        if (c.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'skipped';
        const redacted = await fill.redact(c.sessionId, host);
        if (redacted === 'applied') return 'redacted';
        return redacted === 'current' ? 'skipped' : 'deferred';
      }
      // A file shorter than its offset is re-read from 0 by the tail ingester, which fills the prompts.
      if (size < upTo) return 'deferred';
      const acc = new TranscriptAccumulator(c.sessionId);
      const read = await readJsonlFrom(
        file,
        0,
        (line, lineStart) => {
          const record = parseRecord(line);
          // A fork's copied records were left out by the read that wrote the row; leave them out here too.
          if (record !== null && !isCopiedRecord(record, lineStart, c.forkCutOffset)) acc.add(record);
        },
        { until: upTo, shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
      if (read.stopped || read.endOffset !== upTo) return 'deferred';
      const delta = acc.delta();
      const result = await fill.replace(c.sessionId, host, {
        upToOffset: upTo,
        prompts: delta.prompts,
        replies: delta.replies,
        firstPrompt: delta.firstPrompt,
        lastPrompt: delta.lastPrompt,
      });
      if (result.status === 'applied') return 'filled';
      if (result.status !== 'offset_mismatch') return 'deferred';
      upTo = result.storedOffset;
    }
    return 'deferred';
  };

  /** The one-time prompts backfill for this host (see the header). Never notifies observers. */
  const backfillPrompts = async (): Promise<PromptsBackfillReport> => {
    const started = Date.now();
    const report = emptyPromptsReport();
    const store = options.store;
    const list = store.promptsBackfillCandidates?.bind(store);
    const replace = store.replacePrompts?.bind(store);
    const redact = store.redactStoredPrompts?.bind(store);
    if (list === undefined || replace === undefined || redact === undefined || closed) return report;
    const fill: PromptsFill = { replace, redact };
    const candidates = await list(host);
    report.candidates = candidates.length;
    if (candidates.length === 0) return report;
    await forEachLimit(candidates, concurrency, async (c) => {
      if (closed) {
        report.deferred += 1;
        return;
      }
      try {
        const file = c.transcriptPath;
        const outcome = file === null ? await backfillSession(c, fill) : await withFileHeld(file, () => backfillSession(c, fill));
        report[outcome] += 1;
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: prompts backfill ${c.sessionId}: ${errorMessage(err)}`);
      }
    });
    report.ms = Date.now() - started;
    // Rows redacted in place stay candidates and are skipped on every start: say nothing then.
    if (report.filled + report.redacted + report.deferred + report.failed > 0) log(formatPromptsReport(report));
    return report;
  };

  /** The one-time fork backfill for this host (see the header). */
  const backfillForks = async (): Promise<ForkBackfillReport> => {
    const started = Date.now();
    const report = emptyForkReport();
    const store = options.store;
    const getSetting = store.getSetting?.bind(store);
    const putSetting = store.putSetting?.bind(store);
    const listRows = store.forkBackfillRows?.bind(store);
    const fillHeads = store.fillHeadUuids?.bind(store);
    if (getSetting === undefined || putSetting === undefined || listRows === undefined || fillHeads === undefined || closed) return report;
    const key = `${FORK_MARKER_PREFIX}${host}`;
    const marker = await getSetting(key);
    if (isObject(marker) && marker.version === FORK_BACKFILL_VERSION) return report;
    report.ran = true;
    const rows = await listRows(host);
    report.rows = rows.length;

    // 1. Head uuids. Rows ingested before head_uuid existed have none, so the detector's lookup
    //    could not find them as originals. A transcript that is gone is skipped without a write.
    const heads = new Map<string, string | null>();
    const fills: HeadUuidFill[] = [];
    await forEachLimit(rows, concurrency, async (row) => {
      if (closed) return;
      if (!isUnder(projectsDir, row.transcriptPath) || (await fileSize(row.transcriptPath)) === null) {
        report.missing += 1;
        return;
      }
      if (row.headUuid !== null) {
        heads.set(row.sessionId, row.headUuid);
        return;
      }
      try {
        const head = await headUuid(row.transcriptPath);
        heads.set(row.sessionId, head);
        if (head !== null) fills.push({ sessionId: row.sessionId, headUuid: head });
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: fork backfill ${row.sessionId}: ${errorMessage(err)}`);
      }
    });
    if (closed) return report;
    report.headsFilled = await fillHeads(host, fills);

    // 2. Candidates: rows not already linked as forks that have a background-job record, or that
    //    share their head uuid with another row of this host. Only the detector decides. Job-state
    //    candidates go first (index Decisions): every row here was ingested before the cut, so a
    //    parent and its forks share one polluted started_at; linking the job forks first makes them
    //    descendants, which forkCandidates then leaves out when an original is examined.
    const sharing = new Map<string, number>();
    for (const head of heads.values()) if (head !== null) sharing.set(head, (sharing.get(head) ?? 0) + 1);
    const jobCandidates: ForkBackfillRow[] = [];
    const uuidCandidates: ForkBackfillRow[] = [];
    for (const row of rows) {
      if (closed) return report;
      if (!heads.has(row.sessionId) || row.parentLinkSource === 'fork') continue;
      const job = await jobStateFor(options.claudeHome, row.sessionId).catch(() => null);
      if (job !== null) {
        jobCandidates.push(row);
        continue;
      }
      const head = heads.get(row.sessionId) ?? null;
      if (head !== null && (sharing.get(head) ?? 0) > 1) uuidCandidates.push(row);
    }
    const candidates = [...jobCandidates, ...uuidCandidates];
    report.candidates = candidates.length;

    // 3. Detect, then re-read each fork from byte 0. Originals are never re-read: a 0-read
    //    recomputes push/merge range commits with `git log`, which loses them once a worktree is gone.
    for (const row of candidates) {
      if (closed) return report;
      try {
        if (((await scanForkSafely(row.transcriptPath, row.sessionId))?.fork ?? null) === null) continue;
        report.forks += 1;
        const bytes = await rereadFromZero(row.transcriptPath, row.sessionId);
        if (bytes === 0) {
          report.deferred += 1;
          continue;
        }
        report.reingested += 1;
        // Its summary was written from the parent's copied prompts: ask the summary worker for a new one.
        if (row.summarizedAt !== null) await store.requestSummary?.(row.sessionId);
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: fork backfill ${row.sessionId}: ${errorMessage(err)}`);
      }
    }
    report.ms = Date.now() - started;
    if (closed) return report; // no marker: the next start runs it again (every step is idempotent)
    if (report.deferred === 0 && report.failed === 0) {
      await putSetting(key, {
        version: FORK_BACKFILL_VERSION,
        finishedAt: new Date().toISOString(),
        rows: report.rows,
        headsFilled: report.headsFilled,
        forks: report.forks,
        reingested: report.reingested,
        missing: report.missing,
      });
    }
    if (report.headsFilled + report.forks + report.deferred + report.failed > 0) log(formatForkReport(report));
    return report;
  };

  /**
   * One row of the context backfill. Re-reads the transcript from 0 to the stored offset, a fork's
   * copied records through addCopied (snapshot and peak only, as the tail read did), and writes the
   * six context columns. An offset miss (a tail write landed first) retries once with the stored
   * offset; a second miss waits for the next start.
   */
  const backfillContextSession = async (r: ContextBackfillRow, fill: FillContext): Promise<ContextBackfillOutcome> => {
    let upTo = r.transcriptOffset;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (closed) return 'deferred';
      if (!isUnder(projectsDir, r.transcriptPath)) return 'missing';
      const size = await fileSize(r.transcriptPath);
      if (size === null) return 'missing';
      // A file shorter than its offset is re-read from 0 by the tail ingester, which writes the context.
      if (size < upTo) return 'deferred';
      const acc = new TranscriptAccumulator(r.sessionId);
      const read = await readJsonlFrom(
        r.transcriptPath,
        0,
        (line, lineStart) => {
          if (isLongContextRequestLine(line)) acc.noteLongContextBeta();
          const record = parseRecord(line);
          if (record === null) return;
          if (isCopiedRecord(record, lineStart, r.forkCutOffset)) acc.addCopied(record);
          else acc.add(record);
        },
        { until: upTo, shouldStop: () => closed, ...(options.chunkBytes !== undefined ? { chunkBytes: options.chunkBytes } : {}) },
      );
      if (read.stopped || read.endOffset !== upTo) return 'deferred';
      const result = await fill(r.sessionId, host, { upToOffset: upTo, ...acc.delta().context });
      if (result.status === 'applied') return 'filled';
      if (result.status !== 'offset_mismatch') return 'missing';
      upTo = result.storedOffset;
    }
    return 'deferred';
  };

  /** The one-time context backfill for this host (see the header). Never notifies observers. */
  const backfillContext = async (): Promise<ContextBackfillReport> => {
    const started = Date.now();
    const report = emptyContextReport();
    const store = options.store;
    const getSetting = store.getSetting?.bind(store);
    const putSetting = store.putSetting?.bind(store);
    const listRows = store.contextBackfillRows?.bind(store);
    const fill = store.fillContext?.bind(store);
    if (getSetting === undefined || putSetting === undefined || listRows === undefined || fill === undefined || closed) return report;
    const key = `${CONTEXT_MARKER_PREFIX}${host}`;
    const marker = await getSetting(key);
    if (isObject(marker) && marker.version === CONTEXT_BACKFILL_VERSION) return report;
    report.ran = true;
    const rows = await listRows(host);
    report.rows = rows.length;
    await forEachLimit(rows, concurrency, async (r) => {
      if (closed) {
        report.deferred += 1;
        return;
      }
      try {
        const outcome = await withFileHeld(r.transcriptPath, () => backfillContextSession(r, fill));
        report[outcome] += 1;
      } catch (err) {
        report.failed += 1;
        log(`[notesd] sessions: context backfill ${r.sessionId}: ${errorMessage(err)}`);
      }
    });
    report.ms = Date.now() - started;
    if (closed) return report; // no marker: the next start runs it again (every write is idempotent)
    if (report.deferred === 0 && report.failed === 0) {
      await putSetting(key, {
        version: CONTEXT_BACKFILL_VERSION,
        finishedAt: new Date().toISOString(),
        rows: report.rows,
        filled: report.filled,
        missing: report.missing,
      });
    }
    if (report.filled + report.deferred + report.failed > 0) log(formatContextReport(report));
    return report;
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

  let forkSettled = false;
  const forkBackfill: Promise<ForkBackfillReport> = ready
    .then(() => backfillForks())
    .catch((err: unknown) => {
      log(`[notesd] sessions: fork backfill failed: ${errorMessage(err)}`);
      return { ...emptyForkReport(), ran: true, failed: 1 };
    })
    .finally(() => {
      forkSettled = true;
    });

  // After the fork backfill: re-read forks are current and drop out of the prompts candidates.
  let promptsSettled = false;
  const promptsBackfill: Promise<PromptsBackfillReport> = forkBackfill
    .then(() => backfillPrompts())
    .catch((err: unknown) => {
      log(`[notesd] sessions: prompts backfill failed: ${errorMessage(err)}`);
      return { ...emptyPromptsReport(), failed: 1 };
    })
    .finally(() => {
      promptsSettled = true;
    });

  // After the prompts backfill, so the one-time re-reads of a host run one after another.
  let contextSettled = false;
  const contextBackfill: Promise<ContextBackfillReport> = promptsBackfill
    .then(() => backfillContext())
    .catch((err: unknown) => {
      log(`[notesd] sessions: context backfill failed: ${errorMessage(err)}`);
      return { ...emptyContextReport(), ran: true, failed: 1 };
    })
    .finally(() => {
      contextSettled = true;
    });

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
    forkBackfill,
    promptsBackfill,
    contextBackfill,
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
        const pending = [
          sweeping,
          watchDrain,
          forkSettled ? null : forkBackfill,
          promptsSettled ? null : promptsBackfill,
          contextSettled ? null : contextBackfill,
          ...inflight.values(),
        ].filter((p) => p !== null);
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
      const pending = Promise.allSettled([closing, sweeping, watchDrain, forkBackfill, promptsBackfill, contextBackfill, ...inflight.values()]);
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

/** e.g. `[notesd] sessions: prompts backfill 640 sessions, 612 filled, 25 redacted in place, 0 already done, 3 deferred, 0 failed, 4210ms` */
export function formatPromptsReport(r: PromptsBackfillReport): string {
  return `[notesd] sessions: prompts backfill ${r.candidates} sessions, ${r.filled} filled, ${r.redacted} redacted in place, ${r.skipped} already done, ${r.deferred} deferred, ${r.failed} failed, ${r.ms}ms`;
}

/** e.g. `[notesd] sessions: fork backfill 640 sessions, 612 head uuids filled, 6 checked, 3 forks, 3 re-read from byte 0, 25 transcripts gone, 0 deferred, 0 failed, 812ms` */
export function formatForkReport(r: ForkBackfillReport): string {
  return `[notesd] sessions: fork backfill ${r.rows} sessions, ${r.headsFilled} head uuids filled, ${r.candidates} checked, ${r.forks} forks, ${r.reingested} re-read from byte 0, ${r.missing} transcripts gone, ${r.deferred} deferred, ${r.failed} failed, ${r.ms}ms`;
}

/** e.g. `[notesd] sessions: context backfill 640 sessions, 612 filled, 25 transcripts gone, 0 deferred, 0 failed, 3810ms` */
export function formatContextReport(r: ContextBackfillReport): string {
  return `[notesd] sessions: context backfill ${r.rows} sessions, ${r.filled} filled, ${r.missing} transcripts gone, ${r.deferred} deferred, ${r.failed} failed, ${r.ms}ms`;
}
