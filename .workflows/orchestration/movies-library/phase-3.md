# Phase 3: Library sync: scan, diff, match, store, background service

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R1, R2, R3 — the owner's video folders become a library: files registered under TMDB titles, junk kept out, moves/deletes/done folders followed
**Criteria:** R1.1, R1.2, R1.4, R2.1, R2.3, R3.1, R3.2, R3.3, R3.5
**Depends on:** Phase 1, Phase 2
**Difficulty:** HARD
**Package:** `src/movies`

---

## Goal

After this phase a running notesd with `NOTESD_MOVIES` on and `NOTESD_MOVIES_ROOTS` set polls those
directories (and nothing else), registers each video file of this host in `movie_files`, matches it
to a TMDB title whose full metadata is stored once through `MoviesRepo.upsertTitle`, keeps junk
(short clips, no match, probe failures) as `unmatched` with a reason, follows moves by name+size,
soft-deletes vanished files, records done signals for files inside a `Done` folder, and leaves
files `pending` while TMDB is unreachable so the next pass retries them. `AppDeps.movies` holds a
real `MoviesService` that phase 4 (`syncNow`, `status`, `assign`, `events`) and phase 5
(`addSyncHook`) build on.

## Interface Contract

**Deletes:** the mirrored type block (`TitleKind`, `CreditRole`, `CompanyMeta`, `CreditMeta`, `EpisodeMeta`, `TitleMetadata` declarations) in `src/movies/tmdb.ts` (phase 2), replaced by a re-export of the same names from `./types.js` (Step 0); the phase 1 placeholder body of `src/movies/service.ts` (the forward `MoviesService` interface shape) — replaced by the class of the same name; every member the placeholder declared exists on the class.

**Renames:** none.

**Creates:**
- `src/movies/scan.ts`: `ScanFs`, `ScanEntry`, `ScanEntryKind`, `nodeScanFs`, `ScannedFile`, `WalkResult`, `WalkOptions`, `walkRoots(roots, options?)`, `Probe` (`(file, signal?) => Promise<number>`), `ProbeError` (`code: 'missing_binary' | 'failed'`), `ProbeOptions`, `DEFAULT_PROBE_TIMEOUT_MS`, `probeDuration(ffprobeBin, file, options?)`.
- `src/movies/sync.ts`: `PROBE_CONCURRENCY`, `TmdbHealth`, `SyncReport`, `emptySyncReport(host, roots, at, tmdb)`, `TitleResolver` (`match(parsed)`, `details(kind, tmdbId)`), `tmdbResolver(tmdb, fallback)`, `Resolution`, `SyncMemory`, `createSyncMemory()`, `SyncHookContext`, `SyncHook` (`{ name?, afterScan?(ctx): Promise<number | void> }`), `SyncDeps`, `TitleStore`, `episodeFor(kind, parsed, meta)`, `isUnder`, `rootOf`, `inDoneDir`, `pairMoves`, `runSyncPass(deps): Promise<SyncReport>` (never rejects).
- `src/movies/service.ts`: `MoviesService` (class: `host`, `repo`, `tmdb`, `events`, `start()`, `close()`, `syncNow()`, `status()`, `assign(fileId, target)`, `addSyncHook(hook)`), `MoviesServiceOptions`, `MoviesServiceOverrides`, `buildMoviesService(config, db, overrides?)`, `MovieEvents` (`changed(reason, ids?)`, `on(listener)`, `listenerCount()`), `MovieChangeEvent`, `MovieChangeReason` (`'sync' | 'assign' | 'user' | 'play'`), `MoviesStatus`, `AssignTarget`, `MoviesServiceError` (`code: 'not_found' | 'no_tmdb_credentials' | 'tmdb_unreachable'`), `INITIAL_DELAY_MS`, `MOVIES_SUBDIR`.

**Signature changes:**
- `src/daemon.ts` `startDaemon`: `deps.movies` becomes `buildMoviesService(config, db)` instead of `null`.
- `src/background.ts` `startBackground`: starts `deps.movies` and closes it on stop.

**Requires (from earlier phases)** — reconciled against phases 1 and 2 (their plans are the source of truth for these names):
- Phase 1, `src/config.ts`: `MoviesConfig` with `enabled`, `roots: string[]` (absolute), `doneDirs: string[]`, `scanMs`, `minSeconds`, `tmdb: { token: string | null; apiKey: string | null; apiBase: string; imageBase: string }`, `ffprobeBin`, `fallbackModel: string | null` (`null` when `NOTESD_MOVIES_FALLBACK_MODEL=off`: no Haiku fallback), `vlc`; `Config.movies`; `DEFAULT_MOVIES_CONFIG` (`enabled: false`).
- Phase 1, `src/deps.ts`: `AppDeps.movies: MoviesService | null` importing the type from `./movies/service.js`; `src/daemon.ts` literal currently `movies: null`.
- Phase 1, `src/movies/types.ts`: `TitleKind`, `FileStatus`, `FileReason`, `FileClassification`, `classifyReason(reason)`, `NewMovieFile` (`{ host, path, name, size, mtime, durationS, season, episode, absoluteEpisode, parsed, source, classification, seenAt, deletedAt?, doneAt? }`), `TitleMetadata` / `CompanyMeta` / `CreditMeta` / `EpisodeMeta`, `titleId(kind, tmdbId)`, `MovieFileRow` (camelCase row of `movie_files`).
- Phase 1, `src/movies/repo.ts` `class MoviesRepo` (`new MoviesRepo(db)`):
  - `filesForHost(host, { includeDeleted? } = {}): Promise<MovieFileRow[]>` — live rows only by default
  - `fileById(id): Promise<MovieFileRow | null>`, `titleById(id): Promise<MovieTitleRow | null>`
  - `upsertTitle(meta: TitleMetadata, now?): Promise<string>`
  - `upsertFile(input: NewMovieFile, now?): Promise<{ file: MovieFileRow; created: boolean }>` — inserts a new live (host, path) with its classification; on an existing live row it refreshes only size, mtime, duration (when known) and `last_seen_at`, keeping title, status, reason and every signal. A retried row's new classification is therefore written with `assignFile` / `setUnmatched` (Step 2's `store`).
  - `markSeen(ids, at): Promise<number>`, `markDeleted(id, at): Promise<boolean>`
  - `moveFile(id, to: { path; name }, at, options: { done: boolean }): Promise<MovieFileRow | null>` — this phase passes `{ done: false }` and records the done signal with `setDone`
  - `setDone(id, at): Promise<MovieFileRow | null>` — keeps the first `done_at`
  - `assignFile(fileId, titleId, episode?: { season; episode }, now?): Promise<MovieFileRow | null>` — `status = 'matched'`, `reason = null`
  - `setUnmatched(fileId, reason, now?): Promise<MovieFileRow | null>` — `tmdb_error` leaves it `pending`, any other reason `unmatched`
- Phase 2, `src/movies/parse.ts`: `isVideoFile(name)`, `parseVideoPath(relPath): ParsedName` (`title`, `year`, `season`, `episode`, `absoluteEpisode`, `kindHint`, `fileName`, `dirName`; assignable to `MovieParsedName`).
- Phase 2, `src/movies/tmdb.ts`: `TmdbClient` (`movieDetails(id)`, `tvDetails(id)` returning `TitleMetadata`), `createTmdbClient(config.movies.tmdb)`, `TmdbError(code: TmdbErrorCode, message, status?)` with `code` `no_credentials | network | timeout | http | bad_response`, `absoluteToSeasonEpisode(TitleMetadata['episodes'], n): { season; episode } | null` (the n-th listed episode over seasons >= 1, TMDB's own numbers). Its mirrored `TitleMetadata` type block is replaced by a re-export from `types.ts` in Step 0 below.
- Phase 2, `src/movies/match.ts`: `matchTitle(parsed, client, fallback?: NameFallback | null)` resolving `{ kind: 'matched'; tmdbKind; tmdbId; confidence; source; matchedTitle } | { kind: 'none'; reason: 'no_match' | 'low_confidence' }`, rejecting with `TmdbError` when a TMDB call fails.
- Phase 2, `src/movies/fallback.ts`: `NameFallback`; `createHaikuFallback({ claudeBin, cwd, model? }): NameFallback | null` (null when the claude binary cannot be found); `resolve` never rejects (a failed Haiku call answers null, so the file is left `unmatched no_match` and, being unmatched, is never re-matched by a later pass).

**Leaves alone (owned by others):** `src/db/schema.ts`, `drizzle/*`, `src/config.ts`, `src/deps.ts`, `src/movies/types.ts`, `state.ts`, `repo.ts` (phase 1); `src/movies/parse.ts`, `tmdb.ts`, `match.ts`, `fallback.ts`, `tests/fixtures/movies/*` (phase 2); `src/http/*` incl. `moviesApi.ts`, `moviesPlayApi.ts`, `read.ts`, `reviewNote.ts` (phase 4); `src/movies/vlc/*`, `player.ts`, `continue.ts` and the player wiring in `src/daemon.ts` (phase 5); `web/*` (phase 6); `src/mcp/*`, `src/chat/*` (phase 7); `README.md`, `CLAUDE.md`, `.claude/skills/verify-notesd/*` (phase 8).

## Files

| File | Action | What changes |
|---|---|---|
| `src/movies/tmdb.ts` | modify (phase 2's mirrored type block) | the six mirrored type declarations become `export type { ... } from './types.js'` (Step 0) |
| `src/movies/scan.ts` | create | recursive walk of the roots through an injectable `ScanFs`; `probeDuration` via ffprobe with timeout and abort |
| `src/movies/sync.ts` | create | one sync pass: diff, move, delete, done, stability gate, probe, match, store, hooks |
| `src/movies/service.ts` | replace (phase 1 placeholder) | `MoviesService` poll loop, `syncNow`, `status`, `assign`, `addSyncHook`, `MovieEvents`, `buildMoviesService` |
| `src/daemon.ts` | modify (`:21`, `:105`) | build the service into `deps.movies` |
| `src/background.ts` | modify (`:17`, `:163`, `:184`) | start it, log one line, close it on stop |
| `tests/unit/movies/scan.test.ts` | create | walk + probe behavior with an in-memory fs and fake ffprobe scripts |
| `tests/unit/movies/sync.helpers.test.ts` | create | done-dir rule, move pairing, root containment, episode choice |
| `tests/unit/movies/service.test.ts` | create | loop: no roots, one pass at a time, queued syncNow, errors, events, close, hooks |
| `tests/integration/helpers/movieMeta.ts` | create | `TitleMetadata` builders for the fake resolver |
| `tests/integration/movies.sync.int.test.ts` | create | passes over a temp tree against the test DB: every criterion of this phase |

## Implementation Steps

### Step 0: One `TitleMetadata` definition
**File:** `src/movies/tmdb.ts` (phase 2), the block that starts with the comment `TitleMetadata: what a match stores ... TEMPORARY MIRROR of src/movies/types.ts` and ends after `export interface TitleMetadata { ... }`; keep `TmdbSearchHit` and everything below it.
**Change:** delete the `export type TitleKind = ...`, `export type CreditRole = ...` lines and the `CompanyMeta`, `CreditMeta`, `EpisodeMeta`, `TitleMetadata` interfaces with their comment, and put in their place:
```ts
// TitleMetadata and its parts have one definition, in ./types.ts (phase 1); this module re-exports them.
import type { CompanyMeta, CreditMeta, CreditRole, EpisodeMeta, TitleKind, TitleMetadata } from './types.js';
export type { CompanyMeta, CreditMeta, CreditRole, EpisodeMeta, TitleKind, TitleMetadata };
```
(move the `import type` line up to the module's imports, after `import { z } from 'zod';`).
**Impact:** no behavior change; phase 2's tests keep importing these names from `tmdb.ts`. `npm run typecheck` proves the mirror was field-for-field identical.

### Step 1: Scanner and probe
**File:** `src/movies/scan.ts` (new)
**Change:** A walk over the configured roots only (R1.4). Directories that cannot be read (a root that is not mounted, `EACCES`) are reported in `unreadable` so the pass never deletes the files under them. Symlinks are never followed. `relPath` is normalized to `/`-separated once here; everything downstream trusts it. `probeDuration` turns ffprobe's text into a number once, separates "the binary is missing" (an environment problem: the file is retried, never stored) from "this file cannot be probed" (`probe_failed`), and has a timeout and an abort signal.
**Code:**
```ts
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
```
**Impact:** new file; no caller until step 2.

### Step 2: The sync pass
**File:** `src/movies/sync.ts` (new)
**Change:** One pass, in this order:
1. Walk the roots (none: skip straight to hooks).
2. Load this host's live tracked files. A tracked file is **missing** when its path was not found, it sits under a configured root, and it is not under anything `unreadable` (an unmounted `/mnt/c` must never delete the library). **A pass only judges files whose path is under a currently configured root:** a row whose path is under no configured root (a root removed from config, a row seeded by a test or `verify.sh exec` at a path outside the roots, a `vlc_recents` row) is never marked deleted, moved, seen or done by a pass, and rows of another host are never loaded. With no roots, the walk is skipped and no row is judged at all. Later phases' proofs rely on this (seeded rows survive passes).
3. **Moves first (R3.2):** a missing file whose name and size equal a newly appeared file is moved (`moveFile`), before the stability gate, so a move is never a delete followed by a new file. A moved file landing in a done dir gets `setDone` (R3.3).
4. Remaining missing files: `markDeleted` (R3.1). Plays and titles are untouched.
5. Present tracked files: `markSeen`; `setDone` when inside a done dir and `done_at` is null (R3.3). A changed size/mtime is written back (keeps the name+size key accurate).
6. **Stability gate:** a genuinely new file (and a `probe_failed` file whose size/mtime changed) is processed only when its size and mtime equal what the previous pass saw (`SyncMemory`, in memory: after a restart a new file waits one extra pass). Zero-byte files never pass.
7. Probe stable files with at most `PROBE_CONCURRENCY` ffprobe processes. Missing ffprobe binary: log once, store nothing (retried next pass). Probe failure: `unmatched probe_failed`. Shorter than `minSeconds`: `unmatched too_short` (R1.2), no TMDB call.
8. Resolve long-enough files plus tracked retries (`pending`, and `no_tmdb_credentials` once a resolver exists): parse, `matchTitle` (cached per pass by normalized title/year/kind, so ten episode files cost one search), store the title's metadata the first time it is seen (`TitleStore`: one `details` call per title per pass, none when the row exists, R2.1), pick season/episode per file (R3.5). Without a resolver: `unmatched no_tmdb_credentials`. A `TmdbError` that means TMDB is unreachable (`tmdbUnreachable(err)`: code `network`, `timeout` or `no_credentials`, or `http` with status 401, 403, 429 or >= 500) trips a per-pass breaker: that file and every later one this pass are `pending tmdb_error` without further calls, and the pass finishes (R2.3). Any other `TmdbError` (`http` 404 or another 4xx, `bad_response`) leaves only that file `pending tmdb_error` (retried next pass) and the pass keeps matching the rest. Before writing a retried row, it is re-read: a row assigned by hand meanwhile is skipped.
9. Hooks (`afterScan`) run last, each in its own try/catch.

The function never rejects: any error (including abort) lands in `report.error`.
**Code:**
```ts
import path from 'node:path';
import type { NameFallback } from './fallback.js';
import { matchTitle, type MatchResult } from './match.js';
import { parseVideoPath, type ParsedName } from './parse.js';
import type { MoviesRepo } from './repo.js';
import { ProbeError, walkRoots, type Probe, type ScanFs, type ScannedFile } from './scan.js';
import { TmdbError, absoluteToSeasonEpisode, type TmdbClient } from './tmdb.js';
import {
  classifyReason,
  titleId,
  type FileClassification,
  type FileReason,
  type MovieFileRow,
  type NewMovieFile,
  type TitleKind,
  type TitleMetadata,
} from './types.js';

/** ffprobe processes at once: drvfs (9p) reads are slow and the daemon shares the machine. */
export const PROBE_CONCURRENCY = 2;

export type TmdbHealth = 'ok' | 'no_credentials' | 'unreachable';

/**
 * True when a TmdbError means TMDB cannot be reached at all (trips the pass's breaker, R2.3).
 * A 404 or other 4xx for one title, or one malformed body, is that title's problem only.
 */
export function tmdbUnreachable(err: TmdbError): boolean {
  if (err.code === 'network' || err.code === 'timeout' || err.code === 'no_credentials') return true;
  if (err.code !== 'http' || err.status === null) return false;
  return err.status === 401 || err.status === 403 || err.status === 429 || err.status >= 500;
}

export interface SyncReport {
  host: string;
  started_at: string;
  finished_at: string;
  roots: string[];
  /** Video files found under the roots. */
  scanned: number;
  /** Files registered this pass, whatever their status. */
  new: number;
  /** New files held back because their size or mtime changed since the previous pass (still downloading). */
  waiting: number;
  moved: number;
  deleted: number;
  /** Done signals recorded (R3.3). */
  done: number;
  /** Files that became matched this pass (new or retried). */
  matched: number;
  /** Files that became unmatched this pass. */
  unmatched: number;
  /** Files left pending this pass (TMDB unreachable). */
  pending: number;
  /** TMDB detail calls made (one per title at most). */
  titles_fetched: number;
  /** Rows the hooks reported writing. */
  hook_writes: number;
  unreadable: string[];
  hook_errors: string[];
  tmdb: TmdbHealth;
  /** Set when the pass stopped early (database error, abort). Counts above are what happened before. */
  error: string | null;
}

export function emptySyncReport(host: string, roots: readonly string[], at: Date, tmdb: TmdbHealth): SyncReport {
  return {
    host,
    started_at: at.toISOString(),
    finished_at: at.toISOString(),
    roots: [...roots],
    scanned: 0,
    new: 0,
    waiting: 0,
    moved: 0,
    deleted: 0,
    done: 0,
    matched: 0,
    unmatched: 0,
    pending: 0,
    titles_fetched: 0,
    hook_writes: 0,
    unreadable: [],
    hook_errors: [],
    tmdb,
    error: null,
  };
}

/** Name -> TMDB title, and TMDB title -> metadata. The daemon wraps the TMDB client; tests pass a fake. */
export interface TitleResolver {
  match(parsed: ParsedName): Promise<MatchResult>;
  details(kind: TitleKind, tmdbId: number): Promise<TitleMetadata>;
}

export function tmdbResolver(tmdb: TmdbClient, fallback: NameFallback | null): TitleResolver {
  return {
    match: (parsed) => matchTitle(parsed, tmdb, fallback ?? undefined),
    details: (kind, tmdbId) => (kind === 'movie' ? tmdb.movieDetails(tmdbId) : tmdb.tvDetails(tmdbId)),
  };
}

/** What one file resolves to. A title id exists only on `matched`, a reason only on the others. */
export type Resolution =
  | { status: 'matched'; titleId: string; season: number | null; episode: number | null; parsed: ParsedName }
  | { status: 'unmatched' | 'pending'; reason: FileReason; parsed: ParsedName };

/** Size and mtime of not-yet-registered files, as the previous pass saw them. Held by the service. */
export interface SyncMemory {
  readonly sizes: Map<string, { size: number; mtimeMs: number }>;
}

export function createSyncMemory(): SyncMemory {
  return { sizes: new Map() };
}

export interface SyncHookContext {
  host: string;
  /** The pass's timestamp (what last_seen_at / deleted_at got). */
  at: Date;
  repo: MoviesRepo;
  /** Absolute paths of the video files found under the roots this pass. */
  present: ReadonlySet<string>;
  /** Classifies a root-relative path or a bare file name exactly as the pass does; stores a title's metadata on its first match. */
  resolve(relPath: string): Promise<Resolution>;
  report: Readonly<SyncReport>;
  signal: AbortSignal | undefined;
  log(line: string): void;
}

export interface SyncHook {
  /** Shown in report.hook_errors. */
  name?: string;
  /** Runs once per pass after the scan's writes. Returns how many rows it wrote. A throw never fails the pass. */
  afterScan?(ctx: SyncHookContext): Promise<number | void>;
}

export interface SyncDeps {
  host: string;
  roots: readonly string[];
  doneDirs: readonly string[];
  minSeconds: number;
  repo: MoviesRepo;
  /** Null without TMDB credentials: every long-enough file is unmatched `no_tmdb_credentials`. */
  resolver: TitleResolver | null;
  probe: Probe;
  memory: SyncMemory;
  fs?: ScanFs;
  hooks?: readonly SyncHook[];
  now?: () => Date;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export function isUnder(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/** The configured root a path is under (the deepest one), or null. */
export function rootOf(file: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (isUnder(file, root) && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

/** True when a directory segment of `relPath` (below the root) is one of `doneDirs`, compared case-insensitively. */
export function inDoneDir(relPath: string, doneDirs: readonly string[]): boolean {
  if (doneDirs.length === 0) return false;
  const wanted = new Set(doneDirs.map((d) => d.toLowerCase()));
  return relPath
    .split('/')
    .slice(0, -1)
    .some((segment) => wanted.has(segment.toLowerCase()));
}

/** Pairs each missing tracked file with one newly appeared file of the same name and size (R3.2). */
export function pairMoves<R extends { name: string; size: number | null }, F extends { path: string; name: string; size: number }>(
  missing: readonly R[],
  appeared: readonly F[],
): Array<{ row: R; file: F }> {
  const used = new Set<string>();
  const pairs: Array<{ row: R; file: F }> = [];
  for (const row of missing) {
    if (row.size === null) continue;
    const file = appeared.find((f) => !used.has(f.path) && f.name === row.name && f.size === row.size);
    if (file === undefined) continue;
    used.add(file.path);
    pairs.push({ row, file });
  }
  return pairs;
}

type EpisodeFields = Pick<ParsedName, 'season' | 'episode' | 'absoluteEpisode'>;

function needsEpisodeList(kind: TitleKind, parsed: EpisodeFields): boolean {
  return kind === 'tv' && parsed.episode === null && parsed.absoluteEpisode !== null;
}

/** Season/episode stored on a file of a title (R3.5): none for a film, SxxEyy as parsed, absolute numbers mapped through the episode list. */
export function episodeFor(
  kind: TitleKind,
  parsed: EpisodeFields,
  meta: TitleMetadata | null,
): { season: number | null; episode: number | null } {
  if (kind === 'movie') return { season: null, episode: null };
  if (parsed.episode === null && parsed.absoluteEpisode !== null && meta !== null) {
    const mapped = absoluteToSeasonEpisode(meta.episodes, parsed.absoluteEpisode);
    if (mapped !== null) return { season: mapped.season, episode: mapped.episode };
  }
  return { season: parsed.season, episode: parsed.episode };
}

/**
 * Title rows on demand. A title's metadata is fetched at most once per instance (one pass, or one
 * assign) and stored through MoviesRepo.upsertTitle only when the row does not exist yet (R2.1).
 */
export class TitleStore {
  private readonly stored = new Set<string>();
  private readonly fetched = new Map<string, Promise<TitleMetadata>>();
  fetchedCount = 0;

  constructor(
    private readonly repo: MoviesRepo,
    private readonly resolver: TitleResolver,
  ) {}

  /** Makes sure the title row exists; returns its id and, when it had to be fetched or `needEpisodes`, its metadata. */
  async ensure(kind: TitleKind, tmdbId: number, needEpisodes: boolean): Promise<{ id: string; meta: TitleMetadata | null }> {
    const id = titleId(kind, tmdbId);
    if (!this.stored.has(id) && (await this.repo.titleById(id)) !== null) this.stored.add(id);
    if (this.stored.has(id) && !needEpisodes) return { id, meta: null };
    const meta = await this.metadata(id, kind, tmdbId);
    if (!this.stored.has(id)) {
      await this.repo.upsertTitle(meta);
      this.stored.add(id);
    }
    return { id, meta };
  }

  private metadata(id: string, kind: TitleKind, tmdbId: number): Promise<TitleMetadata> {
    let pending = this.fetched.get(id);
    if (pending === undefined) {
      pending = this.resolver.details(kind, tmdbId);
      this.fetched.set(id, pending);
      this.fetchedCount += 1;
    }
    return pending;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Matching for one pass: cached per normalized name, with a breaker that stops calling TMDB after the first TmdbError. */
class PassResolver {
  private readonly matches = new Map<string, Promise<MatchResult>>();
  tmdbDown = false;

  constructor(
    private readonly resolver: TitleResolver | null,
    readonly titles: TitleStore | null,
    private readonly log: (line: string) => void,
  ) {}

  async resolve(parsed: ParsedName): Promise<Resolution> {
    if (this.resolver === null || this.titles === null) return { status: 'unmatched', reason: 'no_tmdb_credentials', parsed };
    if (this.tmdbDown) return { status: 'pending', reason: 'tmdb_error', parsed };
    try {
      const match = await this.match(this.resolver, parsed);
      if (match.kind === 'none') return { status: 'unmatched', reason: match.reason, parsed };
      const { id, meta } = await this.titles.ensure(match.tmdbKind, match.tmdbId, needsEpisodeList(match.tmdbKind, parsed));
      const { season, episode } = episodeFor(match.tmdbKind, parsed, meta);
      return { status: 'matched', titleId: id, season, episode, parsed };
    } catch (err) {
      if (err instanceof TmdbError && tmdbUnreachable(err)) {
        if (!this.tmdbDown) this.log(`[notesd] movies: TMDB unreachable (${err.message}); files stay pending until the next pass`);
        this.tmdbDown = true;
      } else if (err instanceof TmdbError) {
        this.log(`[notesd] movies: TMDB ${err.code}${err.status === null ? '' : ` ${err.status}`} for "${parsed.title}"; that file stays pending`);
      } else {
        this.log(`[notesd] movies: matching "${parsed.title}" failed: ${messageOf(err)}`);
      }
      return { status: 'pending', reason: 'tmdb_error', parsed };
    }
  }

  private match(resolver: TitleResolver, parsed: ParsedName): Promise<MatchResult> {
    const key = `${parsed.kindHint ?? '-'}|${parsed.title.toLowerCase()}|${parsed.year ?? '-'}`;
    let pending = this.matches.get(key);
    if (pending === undefined) {
      pending = resolver.match(parsed);
      this.matches.set(key, pending);
    }
    return pending;
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/** True when the file has the same non-zero size and mtime as the previous pass saw; records what this pass saw. */
function stable(memory: SyncMemory, file: ScannedFile): boolean {
  const prev = memory.sizes.get(file.path);
  const mtimeMs = file.mtime.getTime();
  memory.sizes.set(file.path, { size: file.size, mtimeMs });
  return prev !== undefined && file.size > 0 && prev.size === file.size && prev.mtimeMs === mtimeMs;
}

/** The row as stored, with the size/mtime seen on disk now. */
function sameRow(row: MovieFileRow, file: ScannedFile, at: Date): NewMovieFile {
  return {
    host: row.host,
    path: row.path,
    name: row.name,
    size: file.size,
    mtime: file.mtime,
    durationS: row.durationS,
    season: row.season,
    episode: row.episode,
    absoluteEpisode: row.absoluteEpisode,
    parsed: row.parsed,
    source: row.source,
    // Ignored on a live row (upsertFile only refreshes scan facts there); required by the type.
    classification: currentClassification(row),
    seenAt: at,
  };
}

function currentClassification(row: MovieFileRow): FileClassification {
  if (row.status === 'matched' && row.titleId !== null) return { status: 'matched', titleId: row.titleId };
  return row.reason === null ? { status: 'pending', reason: null } : classifyReason(row.reason);
}

function classificationOf(outcome: Resolution): FileClassification {
  return outcome.status === 'matched' ? { status: 'matched', titleId: outcome.titleId } : classifyReason(outcome.reason);
}

interface Candidate {
  file: ScannedFile;
  /** The tracked row being retried, or null for a new file. */
  row: MovieFileRow | null;
}

/**
 * One sync pass over this host's roots (see the step list in the phase plan). Never rejects: an
 * error or an abort ends the pass with `report.error` set.
 */
export async function runSyncPass(deps: SyncDeps): Promise<SyncReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const roots = deps.roots.map((r) => path.resolve(r));
  const report = emptySyncReport(deps.host, roots, now(), deps.resolver === null ? 'no_credentials' : 'ok');
  const titles = deps.resolver === null ? null : new TitleStore(deps.repo, deps.resolver);
  const resolver = new PassResolver(deps.resolver, titles, log);
  const { repo, host } = deps;
  const at = now();
  let present = new Map<string, ScannedFile>();

  try {
    if (roots.length > 0) {
      const walk = await walkRoots(roots, { fs: deps.fs, signal: deps.signal });
      report.scanned = walk.files.length;
      report.unreadable = walk.unreadable;
      present = new Map(walk.files.map((f) => [f.path, f]));
      const tracked = await repo.filesForHost(host);
      const trackedPaths = new Set(tracked.map((r) => r.path));

      const missing = tracked.filter(
        (r) => !present.has(r.path) && rootOf(r.path, roots) !== null && !walk.unreadable.some((d) => isUnder(r.path, d)),
      );
      const appeared = walk.files.filter((f) => !trackedPaths.has(f.path));

      // R3.2: a missing file reappearing elsewhere with the same name and size is a move, never a delete.
      const moves = pairMoves(missing, appeared);
      const movedIds = new Set<number>();
      const movedPaths = new Set<string>();
      for (const { row, file } of moves) {
        await repo.moveFile(row.id, { path: file.path, name: file.name }, at, { done: false });
        movedIds.add(row.id);
        movedPaths.add(file.path);
        report.moved += 1;
        if (row.doneAt === null && inDoneDir(file.relPath, deps.doneDirs)) {
          await repo.setDone(row.id, at);
          report.done += 1;
        }
      }

      // R3.1: gone, and not moved. The title and the plays stay.
      for (const row of missing) {
        if (movedIds.has(row.id)) continue;
        await repo.markDeleted(row.id, at);
        report.deleted += 1;
      }

      const still: Array<{ row: MovieFileRow; file: ScannedFile }> = [];
      for (const row of tracked) {
        const file = present.get(row.path);
        if (file !== undefined) still.push({ row, file });
      }
      await repo.markSeen(
        still.map((s) => s.row.id),
        at,
      );

      const waiting = new Set<string>();
      const toProbe: Candidate[] = [];
      const toResolve: Array<Candidate & { durationS: number }> = [];

      for (const { row, file } of still) {
        // R3.3: inside a done folder (found there, or moved there while the daemon was down).
        if (row.doneAt === null && inDoneDir(file.relPath, deps.doneDirs)) {
          await repo.setDone(row.id, at);
          report.done += 1;
        }
        const changed = row.size !== file.size || row.mtime?.getTime() !== file.mtime.getTime();
        if (row.status === 'unmatched' && row.reason === 'probe_failed') {
          // Retried only when the file changed, and only once the change has settled.
          if (!changed) continue;
          if (stable(deps.memory, file)) toProbe.push({ file, row });
          else waiting.add(file.path);
          continue;
        }
        if (changed) await repo.upsertFile(sameRow(row, file, at));
        const retry =
          row.status === 'pending' || (row.status === 'unmatched' && row.reason === 'no_tmdb_credentials' && deps.resolver !== null);
        if (retry && row.durationS !== null) toResolve.push({ file, row, durationS: row.durationS });
      }

      for (const file of appeared) {
        if (movedPaths.has(file.path)) continue;
        if (stable(deps.memory, file)) toProbe.push({ file, row: null });
        else waiting.add(file.path);
      }
      for (const key of [...deps.memory.sizes.keys()]) {
        if (!waiting.has(key)) deps.memory.sizes.delete(key);
      }
      report.waiting = waiting.size;

      const store = async (candidate: Candidate, durationS: number | null, outcome: Resolution): Promise<void> => {
        const { file, row: prior } = candidate;
        if (prior !== null) {
          // A file assigned by hand (or deleted) since this pass loaded it is not overwritten.
          const fresh = await repo.fileById(prior.id);
          if (fresh === null || fresh.deletedAt !== null || fresh.status === 'matched') return;
        }
        const matched = outcome.status === 'matched';
        const season = matched ? outcome.season : outcome.parsed.season;
        const episode = matched ? outcome.episode : outcome.parsed.episode;
        // New file: inserted with its classification. Retried row: upsertFile refreshes the scan
        // facts (size, mtime, duration) only, so the new classification is written explicitly.
        const { file: row } = await repo.upsertFile({
          host,
          path: file.path,
          name: file.name,
          size: file.size,
          mtime: file.mtime,
          durationS,
          season,
          episode,
          absoluteEpisode: outcome.parsed.absoluteEpisode,
          parsed: outcome.parsed,
          source: 'scan',
          classification: classificationOf(outcome),
          seenAt: at,
        });
        if (prior !== null) {
          if (matched) await repo.assignFile(row.id, outcome.titleId, { season, episode }, at);
          else await repo.setUnmatched(row.id, outcome.reason, at);
        }
        report[outcome.status] += 1;
        if (prior === null) {
          report.new += 1;
          if (inDoneDir(file.relPath, deps.doneDirs)) {
            await repo.setDone(row.id, at);
            report.done += 1;
          }
        }
      };

      let ffprobeMissing = false;
      const probed = await mapLimit(toProbe, PROBE_CONCURRENCY, async (candidate) => {
        if (ffprobeMissing) return { candidate, durationS: undefined };
        try {
          return { candidate, durationS: await deps.probe(candidate.file.path, deps.signal) as number | null | undefined };
        } catch (err) {
          if (!(err instanceof ProbeError)) throw err;
          if (err.code === 'missing_binary') {
            if (!ffprobeMissing) log(`[notesd] movies: ${err.message}; new files wait until it is installed`);
            ffprobeMissing = true;
            return { candidate, durationS: undefined };
          }
          return { candidate, durationS: null };
        }
      });

      for (const { candidate, durationS } of probed) {
        if (durationS === undefined) continue;
        const parsed = parseVideoPath(candidate.file.relPath);
        if (durationS === null) {
          await store(candidate, null, { status: 'unmatched', reason: 'probe_failed', parsed });
        } else if (durationS < deps.minSeconds) {
          await store(candidate, durationS, { status: 'unmatched', reason: 'too_short', parsed });
        } else {
          toResolve.push({ ...candidate, durationS });
        }
      }

      for (const candidate of toResolve) {
        deps.signal?.throwIfAborted();
        const outcome = await resolver.resolve(parseVideoPath(candidate.file.relPath));
        await store(candidate, candidate.durationS, outcome);
      }
    }

    const ctx: SyncHookContext = {
      host,
      at,
      repo,
      present: new Set(present.keys()),
      resolve: (relPath) => resolver.resolve(parseVideoPath(relPath)),
      report,
      signal: deps.signal,
      log,
    };
    for (const hook of deps.hooks ?? []) {
      if (hook.afterScan === undefined) continue;
      try {
        const wrote = await hook.afterScan(ctx);
        if (typeof wrote === 'number') report.hook_writes += wrote;
      } catch (err) {
        report.hook_errors.push(`${hook.name ?? 'hook'}: ${messageOf(err)}`);
      }
    }
  } catch (err) {
    report.error = messageOf(err);
  }
  if (resolver.tmdbDown) report.tmdb = 'unreachable';
  report.titles_fetched = titles?.fetchedCount ?? 0;
  report.finished_at = now().toISOString();
  return report;
}
```
Note for the implementer: `report[outcome.status] += 1` relies on `SyncReport` having numeric `matched`, `unmatched`, `pending` keys, which it does. The `as number | null | undefined` cast only widens the resolved `number` so the three-way union types; it does not change a value.
**Impact:** new file. Typechecks only once phases 1 and 2 have landed (it imports their modules).

### Step 3: The service, its events and the factory
**File:** `src/movies/service.ts` (replace phase 1's placeholder entirely)
**Change:** `MoviesService` owns the poll loop (a self-rescheduling `setTimeout`, unref'd: the next pass is scheduled `scanMs` after the previous one ends, so passes never overlap and `next_pass_at` is exact — this keeps the index's "setInterval, one pass at a time" intent without a skip-if-running check), `syncNow` (coalesces: while a pass runs, every caller shares one queued follow-up pass), `status`, `assign` (manual fix, serving phase 4's `POST /api/movies/files/:fileId/assign`), `addSyncHook` (phase 5), and `MovieEvents`. With no roots the loop never starts (Invariant 5). `buildMoviesService` returns null when `NOTESD_MOVIES=off`, builds a TMDB client only when a credential exists, and the Haiku fallback only alongside it.
**Code:**
```ts
import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Config, MoviesConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { createHaikuFallback, type NameFallback } from './fallback.js';
import { MoviesRepo } from './repo.js';
import { probeDuration, type Probe, type ScanFs } from './scan.js';
import {
  TitleStore,
  createSyncMemory,
  emptySyncReport,
  episodeFor,
  runSyncPass,
  tmdbResolver,
  type SyncDeps,
  type SyncHook,
  type SyncMemory,
  type SyncReport,
  type TitleResolver,
  type TmdbHealth,
} from './sync.js';
import { TmdbError, createTmdbClient, type TmdbClient } from './tmdb.js';
import { titleId, type MovieFileRow, type TitleKind, type TitleMetadata } from './types.js';

/** First pass after start: soon, but not during the daemon's own startup work. */
export const INITIAL_DELAY_MS = 5_000;
const CLOSE_GRACE_MS = 5_000;
/** `<dataDir>/movies`: the cwd of the Haiku name fallback. */
export const MOVIES_SUBDIR = 'movies';

export type MovieChangeReason = 'sync' | 'assign' | 'user' | 'play';

/** Something about movies changed. Carries ids only: listeners re-read. */
export interface MovieChangeEvent {
  type: 'changed';
  reason: MovieChangeReason;
  title_ids: string[];
  file_ids: number[];
}

export type MovieEventListener = (event: MovieChangeEvent) => void;

/**
 * In-process bus for movie changes. The service emits after a pass that wrote and after assign;
 * phase 4 emits 'user' after user-state writes and subscribes for SSE; phase 5 emits 'play'.
 */
export class MovieEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  changed(reason: MovieChangeReason, ids: { titleIds?: readonly string[]; fileIds?: readonly number[] } = {}): void {
    const event: MovieChangeEvent = {
      type: 'changed',
      reason,
      title_ids: [...(ids.titleIds ?? [])],
      file_ids: [...(ids.fileIds ?? [])],
    };
    this.emitter.emit('changed', event);
  }

  /** Subscribes and returns the unsubscribe function. */
  on(listener: MovieEventListener): () => void {
    this.emitter.on('changed', listener);
    return () => {
      this.emitter.off('changed', listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount('changed');
  }
}

export type MoviesErrorCode = 'not_found' | 'no_tmdb_credentials' | 'tmdb_unreachable';

export class MoviesServiceError extends Error {
  override name = 'MoviesServiceError';
  constructor(
    readonly code: MoviesErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface AssignTarget {
  kind: TitleKind;
  tmdbId: number;
  /** For a series: overrides what was parsed from the file name. */
  season?: number | null;
  episode?: number | null;
}

export interface MoviesStatus {
  host: string;
  roots: string[];
  done_dirs: string[];
  scan_ms: number;
  min_seconds: number;
  /** The poll loop is running (started, not closed, at least one root). */
  scanning: boolean;
  /** A pass is running now. */
  running: boolean;
  tmdb: TmdbHealth;
  next_pass_at: string | null;
  last_pass: SyncReport | null;
}

export interface MoviesServiceOptions {
  config: MoviesConfig;
  /** os.hostname(): the host written on every file row of this machine. */
  host: string;
  repo: MoviesRepo;
  /** Null without TMDB credentials. Phase 7 reads it for person filmographies. */
  tmdb: TmdbClient | null;
  /** Null without TMDB credentials. */
  resolver: TitleResolver | null;
  probe: Probe;
  fs?: ScanFs;
  /** The pass itself; tests replace it. Default runSyncPass. */
  pass?: (deps: SyncDeps) => Promise<SyncReport>;
  events?: MovieEvents;
  now?: () => Date;
  log?: (line: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function wrote(report: SyncReport): boolean {
  return report.new + report.moved + report.deleted + report.done + report.matched + report.unmatched + report.hook_writes > 0;
}

/**
 * The movies library of this host: a poll loop over NOTESD_MOVIES_ROOTS (no watcher: /mnt/c is
 * drvfs and delivers no inotify events for Windows-side changes), one pass at a time, never
 * throwing out of the loop. Held in AppDeps.movies; phase 4's routes and phase 5's player use it.
 */
export class MoviesService {
  readonly events: MovieEvents;
  readonly repo: MoviesRepo;
  readonly tmdb: TmdbClient | null;
  private readonly resolver: TitleResolver | null;
  private readonly hooks: SyncHook[] = [];
  private readonly memory: SyncMemory = createSyncMemory();
  private readonly controller = new AbortController();
  private readonly pass: (deps: SyncDeps) => Promise<SyncReport>;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<SyncReport> | null = null;
  private queued: Promise<SyncReport> | null = null;
  private lastPass: SyncReport | null = null;
  private nextPassAt: Date | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly opts: MoviesServiceOptions) {
    this.events = opts.events ?? new MovieEvents();
    this.repo = opts.repo;
    this.tmdb = opts.tmdb;
    this.resolver = opts.resolver;
    this.pass = opts.pass ?? runSyncPass;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((line: string) => console.log(line));
  }

  get host(): string {
    return this.opts.host;
  }

  /** Starts the poll loop (background.ts). Without roots nothing is ever scanned. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    if (this.opts.config.roots.length === 0) return;
    this.schedule(Math.min(INITIAL_DELAY_MS, this.opts.config.scanMs));
  }

  /**
   * A pass now. While one runs, every caller shares a single follow-up pass that starts when it
   * ends. Never rejects. A pass over the real library can take a minute: a request handler should
   * not await it.
   */
  syncNow(): Promise<SyncReport> {
    if (this.current === null) return this.startPass();
    this.queued ??= this.current.then(() => {
      this.queued = null;
      return this.current ?? this.startPass();
    });
    return this.queued;
  }

  status(): MoviesStatus {
    const config = this.opts.config;
    return {
      host: this.opts.host,
      roots: [...config.roots],
      done_dirs: [...config.doneDirs],
      scan_ms: config.scanMs,
      min_seconds: config.minSeconds,
      scanning: this.started && !this.closed && config.roots.length > 0,
      running: this.current !== null,
      tmdb: this.resolver === null ? 'no_credentials' : (this.lastPass?.tmdb ?? 'ok'),
      next_pass_at: this.nextPassAt === null ? null : this.nextPassAt.toISOString(),
      last_pass: this.lastPass,
    };
  }

  /** Phase 5 registers the VLC recents reader here. Returns the function that removes the hook. */
  addSyncHook(hook: SyncHook): () => void {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i >= 0) this.hooks.splice(i, 1);
    };
  }

  /**
   * Manual fix: registers a file (usually unmatched) under a TMDB title, fetching and storing the
   * title's metadata when it is new. For a series, season/episode come from `target`, else from the
   * file's parsed name, else from its absolute episode number through the title's episode list.
   */
  async assign(fileId: number, target: AssignTarget): Promise<MovieFileRow> {
    const file = await this.repo.fileById(fileId);
    if (file === null) throw new MoviesServiceError('not_found', `no movie file ${fileId}`);
    const id = titleId(target.kind, target.tmdbId);
    const fields = {
      season: target.season ?? file.season,
      episode: target.episode ?? file.episode,
      absoluteEpisode: file.absoluteEpisode,
    };
    let meta: TitleMetadata | null = null;
    if (this.resolver === null) {
      if ((await this.repo.titleById(id)) === null) {
        throw new MoviesServiceError('no_tmdb_credentials', `${id} is not stored yet and no TMDB credential is configured`);
      }
    } else {
      const needEpisodes = target.kind === 'tv' && fields.episode === null && fields.absoluteEpisode !== null;
      try {
        meta = (await new TitleStore(this.repo, this.resolver).ensure(target.kind, target.tmdbId, needEpisodes)).meta;
      } catch (err) {
        if (err instanceof TmdbError) throw new MoviesServiceError('tmdb_unreachable', `TMDB could not be reached: ${err.message}`);
        throw err;
      }
    }
    const { season, episode } = episodeFor(target.kind, fields, meta);
    const row = await this.repo.assignFile(fileId, id, { season, episode });
    if (row === null) throw new MoviesServiceError('not_found', `no movie file ${fileId}`);
    this.emit('assign', [id], [fileId]);
    return row;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextPassAt = null;
    this.controller.abort('closed');
    const running = this.current ?? Promise.resolve();
    await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextPassAt = new Date(this.now().getTime() + delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  /** One automatic pass (or wait for the manual one in flight), then the next one scanMs later. */
  private async tick(): Promise<void> {
    this.nextPassAt = null;
    await (this.current ?? this.startPass());
    this.schedule(this.opts.config.scanMs);
  }

  private startPass(): Promise<SyncReport> {
    const pass = this.runOnePass();
    this.current = pass;
    void pass.then(() => {
      if (this.current === pass) this.current = null;
    });
    return pass;
  }

  private async runOnePass(): Promise<SyncReport> {
    const config = this.opts.config;
    const startedAt = Date.now();
    let report: SyncReport;
    if (this.closed) {
      report = emptySyncReport(this.opts.host, config.roots, this.now(), this.resolver === null ? 'no_credentials' : 'ok');
      report.error = 'closed';
      return report;
    }
    try {
      report = await this.pass({
        host: this.opts.host,
        roots: config.roots,
        doneDirs: config.doneDirs,
        minSeconds: config.minSeconds,
        repo: this.repo,
        resolver: this.resolver,
        probe: this.opts.probe,
        memory: this.memory,
        fs: this.opts.fs,
        hooks: [...this.hooks],
        now: this.now,
        signal: this.controller.signal,
        log: this.log,
      });
    } catch (err) {
      report = emptySyncReport(this.opts.host, config.roots, this.now(), this.resolver === null ? 'no_credentials' : 'ok');
      report.error = messageOf(err);
    }
    this.lastPass = report;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (report.error !== null && !this.closed) {
      this.log(`[notesd] movies: pass failed after ${seconds} s: ${report.error}`);
    }
    for (const line of report.hook_errors) this.log(`[notesd] movies: sync hook failed: ${line}`);
    if (wrote(report)) {
      this.log(
        `[notesd] movies: pass ${seconds} s: ${report.new} new, ${report.moved} moved, ${report.deleted} deleted, ${report.done} done, ` +
          `${report.matched} matched, ${report.unmatched} unmatched, ${report.pending} pending, ${report.waiting} waiting`,
      );
      this.emit('sync', [], []);
    }
    return report;
  }

  private emit(reason: 'sync' | 'assign', titleIds: string[], fileIds: number[]): void {
    try {
      this.events.changed(reason, { titleIds, fileIds });
    } catch (err) {
      this.log(`[notesd] movies: a change listener threw: ${messageOf(err)}`);
    }
  }
}

export interface MoviesServiceOverrides {
  host?: string;
  tmdb?: TmdbClient | null;
  fallback?: NameFallback | null;
  resolver?: TitleResolver | null;
  probe?: Probe;
  fs?: ScanFs;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's movies service, or null with NOTESD_MOVIES=off. With no roots it is still built
 * (the read routes work on titles from the other machine) but never scans. Without a TMDB
 * credential every long-enough file is registered unmatched `no_tmdb_credentials`.
 */
export function buildMoviesService(config: Config, db: Db, overrides: MoviesServiceOverrides = {}): MoviesService | null {
  const movies = config.movies;
  if (!movies.enabled) return null;
  const hasCredential = movies.tmdb.token !== null || movies.tmdb.apiKey !== null;
  const tmdb = overrides.tmdb !== undefined ? overrides.tmdb : hasCredential ? createTmdbClient(movies.tmdb) : null;
  const fallback =
    overrides.fallback !== undefined
      ? overrides.fallback
      : tmdb === null || movies.fallbackModel === null
        ? null // NOTESD_MOVIES_FALLBACK_MODEL=off: no Haiku fallback
        : createHaikuFallback({ claudeBin: config.chat.claudeBin, model: movies.fallbackModel, cwd: join(config.dataDir, MOVIES_SUBDIR) });
  const resolver = overrides.resolver !== undefined ? overrides.resolver : tmdb === null ? null : tmdbResolver(tmdb, fallback);
  const probe: Probe = overrides.probe ?? ((file, signal) => probeDuration(movies.ffprobeBin, file, { signal }));
  return new MoviesService({
    config: movies,
    host: overrides.host ?? hostname(),
    repo: new MoviesRepo(db),
    tmdb,
    resolver,
    probe,
    fs: overrides.fs,
    now: overrides.now,
    log: overrides.log,
  });
}
```
**Impact:** replaces the phase 1 placeholder. `src/deps.ts` keeps importing `type MoviesService` from here unchanged. Every phase 1 test builder that sets `movies: null` still typechecks.

### Step 4: Build the service in the daemon
**File:** `src/daemon.ts:21` (imports) and `:105` (the `deps` literal; phase 1 added `movies: null` to it)
**Change:** Add the import below `import { NotesService } from './notes/service.js';`:
```ts
import { buildMoviesService } from './movies/service.js';
```
Replace the `deps` line (as phase 1 left it):
```ts
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory, adversary, sessionEvents, movies: null };
```
with:
```ts
  // Movies library (phase 3): null with NOTESD_MOVIES=off; started and closed by startBackground.
  const movies = buildMoviesService(config, db);
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory, adversary, sessionEvents, movies };
```
**Impact:** the daemon has a service whenever `NOTESD_MOVIES` is on (its default in `parseMovies`). Phase 5 attaches its player right after this line.

### Step 5: Start and close it with the background jobs
**File:** `src/background.ts:163` (after the adversary block, before `// Hourly egress line`) and `:184` (the stop `Promise.all`)
**Change:** Insert after the adversary `if/else` block:
```ts
  // Movies library sync (phase 3): built by the daemon, started here, closed on stop.
  if (deps.movies === null) {
    console.log('[notesd] movies off: NOTESD_MOVIES=off');
  } else {
    deps.movies.start();
    const m = deps.config.movies;
    console.log(
      m.roots.length === 0
        ? `[notesd] movies on as ${deps.movies.host}: NOTESD_MOVIES_ROOTS is empty, nothing is scanned`
        : `[notesd] movies on as ${deps.movies.host}: scanning ${m.roots.join(', ')} every ${Math.round(m.scanMs / 1000)} s, ` +
            `TMDB ${deps.movies.tmdb === null ? 'off (no TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY)' : 'on'}`,
    );
  }
```
In the returned stop function, add `deps.movies?.close(),` as the last element of the `Promise.all([...])` list, after `deps.adversary?.close(),`. Extend the doc comment above `startBackground` with one sentence: `With deps.movies, the movies library's poll loop over NOTESD_MOVIES_ROOTS.`
**Impact:** startup log gains one line; stop waits at most 5 s for a running pass (within `main.ts`'s 10 s exit).

### Step 6: Unit tests — scanner and probe
**File:** `tests/unit/movies/scan.test.ts` (new)
**Code:**
```ts
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProbeError, probeDuration, walkRoots, type ScanEntryKind, type ScanFs } from '../../../src/movies/scan.js';

type Node = { kind: 'dir' } | { kind: 'file'; size: number } | { kind: 'other' };

function memFs(nodes: Record<string, Node>, broken: readonly string[] = []): ScanFs {
  return {
    async list(dir) {
      if (broken.includes(dir) || nodes[dir]?.kind !== 'dir') throw new Error(`EACCES: ${dir}`);
      const prefix = `${dir}/`;
      return Object.entries(nodes)
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, n]) => ({ name: p.slice(prefix.length), kind: n.kind as ScanEntryKind }));
    },
    async stat(file) {
      const n = nodes[file];
      if (n?.kind !== 'file') throw new Error(`ENOENT: ${file}`);
      return { size: n.size, mtimeMs: 1_700_000_000_000 };
    },
  };
}

const TREE: Record<string, Node> = {
  '/lib': { kind: 'dir' },
  '/lib/Videos': { kind: 'dir' },
  '/lib/Videos/Oldboy (2003)': { kind: 'dir' },
  '/lib/Videos/Oldboy (2003)/Oldboy.mkv': { kind: 'file', size: 10 },
  '/lib/Videos/Oldboy (2003)/Oldboy.srt': { kind: 'file', size: 1 },
  '/lib/Videos/clip.mp4': { kind: 'file', size: 5 },
  '/lib/Videos/link-to-elsewhere': { kind: 'other' },
  '/lib/Telegram': { kind: 'dir' },
  '/lib/Telegram/Film.2026.mkv': { kind: 'file', size: 20 },
  '/elsewhere': { kind: 'dir' },
  '/elsewhere/Secret.2020.mkv': { kind: 'file', size: 30 },
};

describe('walkRoots', () => {
  it('walks exactly the given roots, recursively, and returns only video files', async () => {
    const result = await walkRoots(['/lib/Videos', '/lib/Telegram'], { fs: memFs(TREE) });
    expect(result.files.map((f) => [f.path, f.relPath, f.size])).toEqual([
      ['/lib/Telegram/Film.2026.mkv', 'Film.2026.mkv', 20],
      ['/lib/Videos/Oldboy (2003)/Oldboy.mkv', 'Oldboy (2003)/Oldboy.mkv', 10],
      ['/lib/Videos/clip.mp4', 'clip.mp4', 5],
    ]);
    expect(result.unreadable).toEqual([]);
  });

  it('reports a root or directory it cannot read instead of throwing', async () => {
    const result = await walkRoots(['/lib/Videos', '/missing'], { fs: memFs(TREE, ['/lib/Videos/Oldboy (2003)']) });
    expect(result.unreadable.sort()).toEqual(['/lib/Videos/Oldboy (2003)', '/missing']);
    expect(result.files.map((f) => f.path)).toEqual(['/lib/Videos/clip.mp4']);
  });

  it('lists a file under two nested roots once', async () => {
    const result = await walkRoots(['/lib', '/lib/Videos'], { fs: memFs(TREE) });
    const paths = result.files.map((f) => f.path);
    expect(paths).toHaveLength(new Set(paths).size);
    expect(paths).toContain('/lib/Videos/clip.mp4');
  });
});

describe('probeDuration', () => {
  let dir: string;

  async function fakeFfprobe(name: string, script: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${script}\n`);
    await chmod(file, 0o755);
    return file;
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-probe-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the duration ffprobe prints', async () => {
    const bin = await fakeFfprobe('ok', 'echo 7198.750000');
    await expect(probeDuration(bin, '/x/Oldboy.mkv')).resolves.toBe(7198.75);
  });

  it('fails a file whose duration is unknown', async () => {
    const bin = await fakeFfprobe('na', 'echo N/A');
    await expect(probeDuration(bin, '/x/a.mkv')).rejects.toMatchObject({ code: 'failed' });
  });

  it('fails a file ffprobe cannot read', async () => {
    const bin = await fakeFfprobe('bad', 'echo "Invalid data found" >&2; exit 1');
    await expect(probeDuration(bin, '/x/a.mkv')).rejects.toBeInstanceOf(ProbeError);
    await expect(probeDuration(bin, '/x/a.mkv')).rejects.toMatchObject({ code: 'failed' });
  });

  it('tells a missing ffprobe apart from a bad file', async () => {
    await expect(probeDuration(path.join(dir, 'no-such-ffprobe'), '/x/a.mkv')).rejects.toMatchObject({ code: 'missing_binary' });
  });

  it('gives up on a stuck probe after the timeout', async () => {
    const bin = await fakeFfprobe('stuck', 'sleep 5');
    await expect(probeDuration(bin, '/x/a.mkv', { timeoutMs: 200 })).rejects.toMatchObject({ code: 'failed' });
  });
});
```
**Impact:** `npm test` runs it (no network, no DB).

### Step 7: Unit tests — pure pass rules
**File:** `tests/unit/movies/sync.helpers.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { episodeFor, inDoneDir, isUnder, pairMoves, rootOf, tmdbUnreachable } from '../../../src/movies/sync.js';
import { TmdbError } from '../../../src/movies/tmdb.js';

describe('tmdbUnreachable (R2.3 breaker)', () => {
  it('trips on network, timeout, auth, rate limit and server errors', () => {
    expect(tmdbUnreachable(new TmdbError('network', 'x'))).toBe(true);
    expect(tmdbUnreachable(new TmdbError('timeout', 'x'))).toBe(true);
    for (const status of [401, 403, 429, 500, 503]) expect(tmdbUnreachable(new TmdbError('http', 'x', status))).toBe(true);
  });
  it('does not trip on one title\'s 404 or a malformed body', () => {
    expect(tmdbUnreachable(new TmdbError('http', 'x', 404))).toBe(false);
    expect(tmdbUnreachable(new TmdbError('bad_response', 'x'))).toBe(false);
  });
});

describe('inDoneDir', () => {
  it('is true when any folder below the root is a done dir, in any case', () => {
    expect(inDoneDir('Done/Film.mkv', ['Done'])).toBe(true);
    expect(inDoneDir('done/docker_es/clip.mp4', ['Done'])).toBe(true);
    expect(inDoneDir('Series/Watched/E01.mkv', ['Done', 'Watched'])).toBe(true);
  });
  it('ignores the file name itself and folders that only contain the word', () => {
    expect(inDoneDir('Done.mkv', ['Done'])).toBe(false);
    expect(inDoneDir('Not Done Yet/Film.mkv', ['Done'])).toBe(false);
    expect(inDoneDir('Done/Film.mkv', [])).toBe(false);
  });
});

describe('pairMoves', () => {
  const appeared = [
    { path: '/lib/Videos/Done/A.mkv', name: 'A.mkv', size: 100 },
    { path: '/lib/Videos/B.mkv', name: 'B.mkv', size: 7 },
  ];
  it('pairs a missing file with a new one of the same name and size', () => {
    const pairs = pairMoves([{ id: 1, name: 'A.mkv', size: 100 }], appeared);
    expect(pairs.map((p) => [p.row.id, p.file.path])).toEqual([[1, '/lib/Videos/Done/A.mkv']]);
  });
  it('does not pair on name alone, on unknown size, or twice', () => {
    expect(pairMoves([{ id: 2, name: 'B.mkv', size: 8 }], appeared)).toEqual([]);
    expect(pairMoves([{ id: 3, name: 'A.mkv', size: null }], appeared)).toEqual([]);
    const twice = pairMoves(
      [
        { id: 4, name: 'A.mkv', size: 100 },
        { id: 5, name: 'A.mkv', size: 100 },
      ],
      appeared,
    );
    expect(twice.map((p) => p.row.id)).toEqual([4]);
  });
});

describe('rootOf / isUnder', () => {
  it('finds the deepest configured root and never matches a sibling prefix', () => {
    expect(rootOf('/lib/Videos/a.mkv', ['/lib', '/lib/Videos'])).toBe('/lib/Videos');
    expect(rootOf('/lib/Videos2/a.mkv', ['/lib/Videos'])).toBeNull();
    expect(isUnder('/lib/Videos', '/lib/Videos')).toBe(true);
  });
});

describe('episodeFor', () => {
  it('stores no season or episode on a film', () => {
    expect(episodeFor('movie', { season: 1, episode: 2, absoluteEpisode: null }, null)).toEqual({ season: null, episode: null });
  });
  it('keeps the parsed season and episode of a series file', () => {
    expect(episodeFor('tv', { season: 1, episode: 3, absoluteEpisode: null }, null)).toEqual({ season: 1, episode: 3 });
  });
  it('leaves an absolute number unmapped without an episode list', () => {
    expect(episodeFor('tv', { season: null, episode: null, absoluteEpisode: 405 }, null)).toEqual({ season: null, episode: null });
  });
});
```
**Impact:** `npm test`.

### Step 8: Unit tests — the service loop
**File:** `tests/unit/movies/service.test.ts` (new)
**Code:**
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVIES_CONFIG } from '../../../src/config.js';
import type { MoviesRepo } from '../../../src/movies/repo.js';
import { MoviesService, type MovieChangeEvent } from '../../../src/movies/service.js';
import { emptySyncReport, type SyncDeps, type SyncReport } from '../../../src/movies/sync.js';

type Pass = (deps: SyncDeps) => Promise<SyncReport>;

function report(deps: SyncDeps, changes: Partial<SyncReport> = {}): SyncReport {
  return { ...emptySyncReport(deps.host, deps.roots, new Date(), 'no_credentials'), ...changes };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function service(pass: Pass, roots: string[] = ['/lib']): MoviesService {
  return new MoviesService({
    config: { ...DEFAULT_MOVIES_CONFIG, enabled: true, roots, scanMs: 1_000 },
    host: 'test-host',
    repo: {} as MoviesRepo,
    tmdb: null,
    resolver: null,
    probe: async () => 0,
    pass,
    log: () => {},
  });
}

describe('MoviesService loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never scans without roots', async () => {
    const pass = vi.fn<Pass>(async (d) => report(d));
    const s = service(pass, []);
    s.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pass).not.toHaveBeenCalled();
    expect(s.status().scanning).toBe(false);
    await s.close();
  });

  it('runs one pass at a time and schedules the next scanMs after it ends', async () => {
    const gate = deferred();
    const pass = vi.fn<Pass>(async (d) => {
      if (pass.mock.calls.length === 1) await gate.promise;
      return report(d);
    });
    const s = service(pass);
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pass).toHaveBeenCalledTimes(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pass).toHaveBeenCalledTimes(2);
    await s.close();
  });

  it('shares one follow-up pass between every syncNow made while a pass runs', async () => {
    const gate = deferred();
    const pass = vi.fn<Pass>(async (d) => {
      if (pass.mock.calls.length === 1) await gate.promise;
      return report(d);
    });
    const s = service(pass);
    const first = s.syncNow();
    const second = s.syncNow();
    const third = s.syncNow();
    expect(second).toBe(third);
    expect(pass).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    await second;
    expect(pass).toHaveBeenCalledTimes(2);
    await s.close();
  });

  it('reports a pass that throws and keeps polling', async () => {
    const pass = vi.fn<Pass>(async (d) => report(d));
    pass.mockRejectedValueOnce(new Error('database down'));
    const s = service(pass);
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.status().last_pass?.error).toBe('database down');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(s.status().last_pass?.error).toBeNull();
    await s.close();
  });

  it('emits changed after a pass that wrote something, and stays quiet otherwise', async () => {
    const pass = vi.fn<Pass>(async (d) => report(d));
    pass.mockImplementationOnce(async (d) => report(d, { new: 2, matched: 2 }));
    const s = service(pass);
    const events: MovieChangeEvent[] = [];
    s.events.on((e) => events.push(e));
    await s.syncNow();
    await s.syncNow();
    expect(events.map((e) => e.reason)).toEqual(['sync']);
    await s.close();
  });

  it('close aborts the running pass and stops the loop', async () => {
    let signal: AbortSignal | undefined;
    const pass = vi.fn<Pass>(
      (d) =>
        new Promise<SyncReport>((resolve) => {
          signal = d.signal;
          d.signal?.addEventListener('abort', () => resolve(report(d, { error: 'aborted' })));
        }),
    );
    const s = service(pass);
    s.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await s.close();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('hands registered hooks to the pass until they are removed', async () => {
    const seen: number[] = [];
    const s = service(async (d) => {
      seen.push(d.hooks?.length ?? 0);
      return report(d);
    });
    const remove = s.addSyncHook({ name: 'recents', afterScan: async () => 0 });
    await s.syncNow();
    remove();
    await s.syncNow();
    expect(seen).toEqual([1, 0]);
    await s.close();
  });
});
```
**Impact:** `npm test`.

### Step 9: Integration test fixtures — title metadata
**File:** `tests/integration/helpers/movieMeta.ts` (new)
**Change:** Builders for `TitleMetadata` as the fake resolver returns it. The field names follow the shared contract's columns in camelCase; if phase 1's `TitleMetadata` names a field differently, this is the single file to align (typecheck points at it).
**Code:**
```ts
import type { TitleMetadata } from '../../../src/movies/types.js';

/** A film with a studio, a cast member with a character name, a director, a writer and a producer. */
export function movieMeta(tmdbId: number): TitleMetadata {
  return {
    kind: 'movie',
    tmdbId,
    title: `Film ${tmdbId}`,
    originalTitle: `Film ${tmdbId}`,
    year: 2026,
    releaseDate: '2026-02-20',
    overview: `Synopsis of film ${tmdbId}.`,
    posterPath: `/poster-${tmdbId}.jpg`,
    backdropPath: null,
    runtimeMin: 110,
    genres: ['Thriller'],
    seasonCount: null,
    episodeCount: null,
    companies: [{ id: 3172, name: 'Blumhouse Productions', logoPath: null, originCountry: 'US' }],
    credits: [
      { personId: 9001, name: 'Glen Powell', profilePath: null, role: 'cast', character: 'Becket', job: null, ord: 0 },
      { personId: 9002, name: 'John Patton Ford', profilePath: null, role: 'director', character: null, job: 'Director', ord: 0 },
      { personId: 9002, name: 'John Patton Ford', profilePath: null, role: 'writer', character: null, job: 'Screenplay', ord: 0 },
      { personId: 9003, name: 'Jason Blum', profilePath: null, role: 'producer', character: null, job: 'Producer', ord: 0 },
    ],
    episodes: [],
  };
}

/** A one-season series with three named episodes. */
export function tvMeta(tmdbId: number): TitleMetadata {
  return {
    kind: 'tv',
    tmdbId,
    title: `Series ${tmdbId}`,
    originalTitle: `Series ${tmdbId}`,
    year: 2025,
    releaseDate: '2025-03-30',
    overview: `Synopsis of series ${tmdbId}.`,
    posterPath: `/poster-${tmdbId}.jpg`,
    backdropPath: null,
    runtimeMin: 58,
    genres: ['Crime'],
    seasonCount: 1,
    episodeCount: 3,
    companies: [{ id: 4000, name: 'Paramount+', logoPath: null, originCountry: 'US' }],
    credits: [
      { personId: 9101, name: 'Ronan Bennett', profilePath: null, role: 'creator', character: null, job: 'Creator', ord: 0 },
      { personId: 9102, name: 'Tom Hardy', profilePath: null, role: 'cast', character: 'Harry Da Souza', job: null, ord: 0 },
    ],
    episodes: [
      { season: 1, episode: 1, name: 'Stick or Twist', airDate: '2025-03-30', runtimeMin: 58, overview: null, stillPath: null },
      { season: 1, episode: 2, name: 'Alpha Male', airDate: '2025-04-06', runtimeMin: 55, overview: null, stillPath: null },
      { season: 1, episode: 3, name: 'Sweet Dreams', airDate: '2025-04-13', runtimeMin: 56, overview: null, stillPath: null },
    ],
  };
}
```
**Impact:** test-only.

### Step 10: Integration test — passes over a temp tree against the test database
**File:** `tests/integration/movies.sync.int.test.ts` (new)
**Change:** Real `MoviesRepo` on the test DB, a real temp directory with two roots and an outside folder, a fake probe (duration by file name) and a fake resolver (TMDB faked at the `TitleResolver` seam; the real parser from phase 2 parses the real file-name shapes). The file truncates the movie tables itself, so it does not depend on `truncateAll` knowing them.
**Code:**
```ts
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ADVERSARY_CONFIG,
  DEFAULT_CHAT_CONFIG,
  DEFAULT_DWORD_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_MOVIES_CONFIG,
  DEFAULT_SESSIONS_CONFIG,
  type Config,
  type MoviesConfig,
} from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { ProbeError, type Probe } from '../../src/movies/scan.js';
import { MoviesService, MoviesServiceError, buildMoviesService, type MovieChangeEvent } from '../../src/movies/service.js';
import { createSyncMemory, runSyncPass, type SyncDeps, type SyncMemory, type SyncReport, type TitleResolver } from '../../src/movies/sync.js';
import { TmdbError } from '../../src/movies/tmdb.js';
import type { TitleKind } from '../../src/movies/types.js';
import { movieMeta, tvMeta } from './helpers/movieMeta.js';
import { closeTestDb, openTestDb } from './setup.js';

const HOST = 'test-host';
const KILLING = 'How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const RIVALS = 'The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv';
const MOBLAND = 'Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]';
const E01 = 'MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const E02 = 'MobLand.S01E02.Alpha.Male.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const E03 = 'MobLand.S01E03.Sweet.Dreams.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';
const UNKNOWN = 'Totally.Unknown.Picture.2019.1080p.WEB-DL.x265-Pahe.in.mkv';
const CLIP = 'VID-20250101-WA0001.mp4';
const BAD_APPLES = 'Bad.Apples.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv';

const CATALOG: Record<string, { kind: TitleKind; id: number }> = {
  'how to make a killing': { kind: 'movie', id: 467905 },
  oldboy: { kind: 'movie', id: 670 },
  'the rivals of amziah king': { kind: 'movie', id: 1100001 },
  mobland: { kind: 'tv', id: 247718 },
  'bad apples': { kind: 'movie', id: 1200002 },
};

function normalize(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

interface FakeResolver extends TitleResolver {
  down: boolean;
  detailCalls: string[];
}

function fakeResolver(): FakeResolver {
  const r: FakeResolver = {
    down: false,
    detailCalls: [],
    async match(parsed) {
      if (r.down) throw new TmdbError('network', 'TMDB unreachable (test)');
      const hit = CATALOG[normalize(parsed.title)];
      return hit === undefined
        ? { kind: 'none', reason: 'no_match' }
        : { kind: 'matched', tmdbKind: hit.kind, tmdbId: hit.id, confidence: 1 };
    },
    async details(kind, tmdbId) {
      if (r.down) throw new TmdbError('network', 'TMDB unreachable (test)');
      r.detailCalls.push(`${kind}-${tmdbId}`);
      return kind === 'movie' ? movieMeta(tmdbId) : tvMeta(tmdbId);
    },
  };
  return r;
}

type FileRow = {
  id: string;
  name: string;
  path: string;
  host: string;
  title_id: string | null;
  status: string;
  reason: string | null;
  season: number | null;
  episode: number | null;
  duration_s: number | null;
  deleted: boolean;
  moved: boolean;
  done: boolean;
};

let db: Db;
let repo: MoviesRepo;
let lib: string;
let videos: string;
let telegram: string;
let memory: SyncMemory;
const durations = new Map<string, number>();
let probeCalls = 0;

const probe: Probe = async (file) => {
  probeCalls += 1;
  const seconds = durations.get(path.basename(file));
  if (seconds === undefined) throw new ProbeError('failed', `no duration for ${file}`);
  return seconds;
};

async function video(rel: string, seconds: number | null, size = 4096): Promise<string> {
  const file = path.join(lib, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(size, 1));
  if (seconds === null) durations.delete(path.basename(file));
  else durations.set(path.basename(file), seconds);
  return file;
}

function deps(resolver: TitleResolver | null, extra: Partial<SyncDeps> = {}): SyncDeps {
  return {
    host: HOST,
    roots: [videos, telegram],
    doneDirs: ['Done'],
    minSeconds: 15 * 60,
    repo,
    resolver,
    probe,
    memory,
    log: () => {},
    ...extra,
  };
}

/** New files need two passes: the first records their size, the second sees it unchanged. */
async function settle(resolver: TitleResolver | null, extra: Partial<SyncDeps> = {}): Promise<SyncReport> {
  await runSyncPass(deps(resolver, extra));
  return runSyncPass(deps(resolver, extra));
}

async function files(): Promise<FileRow[]> {
  const res = await db.execute<FileRow>(sql`
    select id::text as id, name, path, host, title_id, status, reason, season, episode, duration_s,
           deleted_at is not null as deleted, moved_at is not null as moved, done_at is not null as done
    from movie_files order by path`);
  return res.rows;
}

async function file(name: string): Promise<FileRow> {
  const row = (await files()).find((f) => f.name === name);
  if (row === undefined) throw new Error(`no movie_files row named ${name}`);
  return row;
}

function config(movies: MoviesConfig): Config {
  return {
    databaseUrl: 'postgres://unused',
    port: 0,
    host: '127.0.0.1',
    dataDir: lib,
    chat: DEFAULT_CHAT_CONFIG,
    embeddings: DEFAULT_EMBEDDINGS_CONFIG,
    sessions: DEFAULT_SESSIONS_CONFIG,
    adversary: DEFAULT_ADVERSARY_CONFIG,
    dword: DEFAULT_DWORD_CONFIG,
    movies,
  };
}

beforeAll(() => {
  db = openTestDb();
  repo = new MoviesRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(
    sql`truncate table movie_plays, movie_files, movie_episodes, movie_credits, movie_people, movie_title_companies, movie_companies, movie_titles restart identity cascade`,
  );
  lib = await mkdtemp(path.join(os.tmpdir(), 'notesd-movies-'));
  videos = path.join(lib, 'Videos');
  telegram = path.join(lib, 'Telegram');
  await mkdir(videos, { recursive: true });
  await mkdir(telegram, { recursive: true });
  memory = createSyncMemory();
  durations.clear();
  probeCalls = 0;
});

afterEach(async () => {
  await rm(lib, { recursive: true, force: true });
});

describe('movies sync pass', () => {
  it('registers a long video that matches TMDB under its title for this host once its size is stable (R1.1)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    const first = await runSyncPass(deps(r));
    expect(first.waiting).toBe(1);
    expect(await files()).toEqual([]);
    const second = await runSyncPass(deps(r));
    expect(second).toMatchObject({ new: 1, matched: 1, error: null });
    expect(await file(KILLING)).toMatchObject({
      host: HOST,
      status: 'matched',
      reason: null,
      title_id: 'movie-467905',
      season: null,
      episode: null,
      duration_s: 7200,
      deleted: false,
    });
  });

  it('stores a title\'s metadata the first time it is matched and fetches it once (R2.1)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    await video(`Telegram/${MOBLAND}/${E01}`, 3500);
    await video(`Telegram/${MOBLAND}/${E02}`, 3300);
    await settle(r);
    expect([...r.detailCalls].sort()).toEqual(['movie-467905', 'tv-247718']);

    const title = (
      await db.execute<{ poster_path: string | null; release_date: string | null; overview: string }>(
        sql`select poster_path, release_date::text as release_date, overview from movie_titles where id = 'movie-467905'`,
      )
    ).rows[0];
    expect(title).toEqual({ poster_path: '/poster-467905.jpg', release_date: '2026-02-20', overview: 'Synopsis of film 467905.' });
    const credits = (
      await db.execute<{ role: string; name: string; character: string | null }>(
        sql`select c.role, p.name, c.character from movie_credits c join movie_people p on p.id = c.person_id
            where c.title_id = 'movie-467905' order by c.role, c.ord`,
      )
    ).rows;
    expect(credits).toEqual([
      { role: 'cast', name: 'Glen Powell', character: 'Becket' },
      { role: 'director', name: 'John Patton Ford', character: null },
      { role: 'producer', name: 'Jason Blum', character: null },
      { role: 'writer', name: 'John Patton Ford', character: null },
    ]);
    const companies = (
      await db.execute<{ name: string }>(
        sql`select co.name from movie_title_companies tc join movie_companies co on co.id = tc.company_id where tc.title_id = 'movie-467905'`,
      )
    ).rows;
    expect(companies).toEqual([{ name: 'Blumhouse Productions' }]);
    const episodes = (
      await db.execute<{ season: number; episode: number; name: string }>(
        sql`select season, episode, name from movie_episodes where title_id = 'tv-247718' order by season, episode`,
      )
    ).rows;
    expect(episodes.map((e) => `${e.season}x${e.episode} ${e.name}`)).toEqual(['1x1 Stick or Twist', '1x2 Alpha Male', '1x3 Sweet Dreams']);

    await video(`Telegram/${MOBLAND}/${E03}`, 3400);
    await settle(r);
    expect(r.detailCalls).toHaveLength(2);
  });

  it('keeps every episode of a season folder under one tv title with its own season, episode and deleted flag (R3.5)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${MOBLAND}/${E01}`, 3500);
    const e2 = await video(`Telegram/${MOBLAND}/${E02}`, 3300);
    await settle(r);
    expect(await file(E01)).toMatchObject({ title_id: 'tv-247718', season: 1, episode: 1 });
    expect(await file(E02)).toMatchObject({ title_id: 'tv-247718', season: 1, episode: 2 });
    expect((await db.execute(sql`select id from movie_titles`)).rows).toHaveLength(1);

    await rm(e2);
    await runSyncPass(deps(r));
    expect(await file(E01)).toMatchObject({ deleted: false });
    expect(await file(E02)).toMatchObject({ deleted: true, title_id: 'tv-247718' });
  });

  it('keeps short and unknown videos out of the library as unmatched with the reason (R1.2)', async () => {
    const r = fakeResolver();
    await video(`Videos/Done/docker_es/${CLIP}`, 42);
    await video(`Videos/${UNKNOWN}`, 6000);
    const report = await settle(r);
    expect(report.unmatched).toBe(2);
    expect(await file(CLIP)).toMatchObject({ status: 'unmatched', reason: 'too_short', title_id: null });
    expect(await file(UNKNOWN)).toMatchObject({ status: 'unmatched', reason: 'no_match', title_id: null });
    expect((await db.execute(sql`select id from movie_titles`)).rows).toHaveLength(0);
  });

  it('scans exactly the configured roots, recursively, and nothing else (R1.4)', async () => {
    const r = fakeResolver();
    await video('Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv', 7200);
    await video('Outside/Oldboy.2003.1080p.mkv', 7200);
    await writeFile(path.join(videos, 'notes.txt'), 'not a video');
    await settle(r);
    expect((await files()).map((f) => path.relative(lib, f.path))).toEqual(['Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv']);
  });

  it('marks a vanished file deleted and keeps its title and plays (R3.1)', async () => {
    const r = fakeResolver();
    const killing = await video(`Telegram/${KILLING}`, 7200);
    await settle(r);
    const row = await file(KILLING);
    await db.execute(
      sql`insert into movie_plays (file_id, host, source, started_at, position_s, duration_s, updated_at)
          values (${Number(row.id)}, ${HOST}, 'live', now(), 600, 7200, now())`,
    );
    await rm(killing);
    const report = await runSyncPass(deps(r));
    expect(report).toMatchObject({ deleted: 1, moved: 0 });
    expect(await file(KILLING)).toMatchObject({ id: row.id, deleted: true, title_id: 'movie-467905' });
    expect((await db.execute(sql`select id from movie_titles where id = 'movie-467905'`)).rows).toHaveLength(1);
    expect((await db.execute(sql`select id from movie_plays where file_id = ${Number(row.id)}`)).rows).toHaveLength(1);
  });

  it('follows a file moved elsewhere under the roots by name and size instead of deleting it (R3.2)', async () => {
    const r = fakeResolver();
    const from = await video('Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv', 7200);
    await settle(r);
    const before = await file('Oldboy.mkv');
    const to = path.join(telegram, 'Oldboy.mkv');
    await rename(from, to);
    const report = await runSyncPass(deps(r));
    expect(report).toMatchObject({ moved: 1, deleted: 0, new: 0 });
    const rows = await files();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, path: to, moved: true, deleted: false, title_id: 'movie-670' });
  });

  it('records a done signal for a file first found inside, or moved into, a Done folder (R3.3)', async () => {
    const r = fakeResolver();
    await video(`Videos/Done/${RIVALS}`, 7000);
    const killing = await video(`Telegram/${KILLING}`, 7200);
    await settle(r);
    expect(await file(RIVALS)).toMatchObject({ done: true, status: 'matched' });
    const before = await file(KILLING);
    expect(before.done).toBe(false);

    await rename(killing, path.join(videos, 'Done', KILLING));
    const report = await runSyncPass(deps(r));
    expect(report).toMatchObject({ moved: 1, done: 1, deleted: 0 });
    expect(await file(KILLING)).toMatchObject({ id: before.id, done: true, moved: true, deleted: false });
  });

  it('finishes the pass with files pending while TMDB is unreachable and matches them on the next pass (R2.3)', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    await video(`Telegram/${MOBLAND}/${E01}`, 3500);
    await video(`Videos/Done/docker_es/${CLIP}`, 42);
    r.down = true;
    const outage = await settle(r);
    expect(outage).toMatchObject({ error: null, tmdb: 'unreachable', pending: 2, unmatched: 1 });
    expect(outage.finished_at).not.toBe('');
    expect(await file(KILLING)).toMatchObject({ status: 'pending', reason: 'tmdb_error', title_id: null });
    expect(await file(E01)).toMatchObject({ status: 'pending', reason: 'tmdb_error' });

    r.down = false;
    const retry = await runSyncPass(deps(r));
    expect(retry).toMatchObject({ matched: 2, tmdb: 'ok' });
    expect(await file(KILLING)).toMatchObject({ status: 'matched', reason: null, title_id: 'movie-467905' });
    expect(await file(E01)).toMatchObject({ status: 'matched', title_id: 'tv-247718', season: 1, episode: 1 });
  });

  it('registers files as no_tmdb_credentials without a resolver and matches them once one exists (R1.2)', async () => {
    await video(`Telegram/${KILLING}`, 7200);
    const off = await settle(null);
    expect(off.tmdb).toBe('no_credentials');
    expect(await file(KILLING)).toMatchObject({ status: 'unmatched', reason: 'no_tmdb_credentials', title_id: null });
    await runSyncPass(deps(fakeResolver()));
    expect(await file(KILLING)).toMatchObject({ status: 'matched', title_id: 'movie-467905' });
  });

  it('holds a file back while its size keeps changing', async () => {
    const r = fakeResolver();
    const killing = await video(`Telegram/${KILLING}`, 7200, 100);
    expect((await runSyncPass(deps(r))).waiting).toBe(1);
    await appendFile(killing, Buffer.alloc(100, 1));
    expect((await runSyncPass(deps(r))).waiting).toBe(1);
    expect(probeCalls).toBe(0);
    expect(await files()).toEqual([]);
    expect((await runSyncPass(deps(r))).new).toBe(1);
  });

  it('stores probe_failed and probes again only after the file changes', async () => {
    const r = fakeResolver();
    const oldboy = await video('Videos/Pak Bernard/Oldboy (2003)/Oldboy.mkv', null);
    await settle(r);
    expect(await file('Oldboy.mkv')).toMatchObject({ status: 'unmatched', reason: 'probe_failed' });
    const calls = probeCalls;
    await runSyncPass(deps(r));
    expect(probeCalls).toBe(calls);

    durations.set('Oldboy.mkv', 7200);
    await appendFile(oldboy, Buffer.alloc(10, 1));
    await settle(r);
    expect(probeCalls).toBe(calls + 1);
    expect(await file('Oldboy.mkv')).toMatchObject({ status: 'matched', title_id: 'movie-670', duration_s: 7200 });
  });

  it('never deletes the files of a root it cannot read', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    await settle(r);
    await rename(telegram, `${telegram}.unmounted`);
    const report = await runSyncPass(deps(r));
    expect(report.deleted).toBe(0);
    expect(report.unreadable).toContain(telegram);
    expect(await file(KILLING)).toMatchObject({ deleted: false });
  });

  it('runs hooks after the scan; a throwing hook never fails the pass', async () => {
    const r = fakeResolver();
    await video(`Telegram/${KILLING}`, 7200);
    let present = 0;
    let resolved: unknown = null;
    const report = await settle(r, {
      hooks: [
        { name: 'broken', afterScan: async () => Promise.reject(new Error('ini unreadable')) },
        {
          name: 'recents',
          afterScan: async (ctx) => {
            present = ctx.present.size;
            resolved = await ctx.resolve(BAD_APPLES);
            return 1;
          },
        },
      ],
    });
    expect(report.error).toBeNull();
    expect(report.hook_errors).toEqual(['broken: ini unreadable']);
    expect(report.hook_writes).toBe(1);
    expect(present).toBe(1);
    expect(resolved).toMatchObject({ status: 'matched', titleId: 'movie-1200002' });
    expect((await db.execute(sql`select id from movie_titles where id = 'movie-1200002'`)).rows).toHaveLength(1);
  });
});

describe('MoviesService', () => {
  function service(resolver: TitleResolver | null): MoviesService {
    return new MoviesService({
      config: { ...DEFAULT_MOVIES_CONFIG, enabled: true, roots: [videos, telegram] },
      host: HOST,
      repo,
      tmdb: null,
      resolver,
      probe,
      log: () => {},
    });
  }

  it('assign registers an unmatched file under the chosen title and stores the title', async () => {
    const s = service(fakeResolver());
    await video(`Videos/${UNKNOWN}`, 6000);
    await s.syncNow();
    await s.syncNow();
    const before = await file(UNKNOWN);
    expect(before.status).toBe('unmatched');
    const events: MovieChangeEvent[] = [];
    s.events.on((e) => events.push(e));

    await s.assign(Number(before.id), { kind: 'movie', tmdbId: 670 });

    expect(await file(UNKNOWN)).toMatchObject({ status: 'matched', reason: null, title_id: 'movie-670' });
    expect((await db.execute(sql`select id from movie_titles where id = 'movie-670'`)).rows).toHaveLength(1);
    expect(events).toEqual([{ type: 'changed', reason: 'assign', title_ids: ['movie-670'], file_ids: [Number(before.id)] }]);
    await s.close();
  });

  it('assign answers not_found for an unknown file and no_tmdb_credentials for a new title without TMDB', async () => {
    await expect(service(fakeResolver()).assign(999_999, { kind: 'movie', tmdbId: 670 })).rejects.toMatchObject({ code: 'not_found' });
    const offline = service(null);
    await video(`Videos/${UNKNOWN}`, 6000);
    await offline.syncNow();
    await offline.syncNow();
    const row = await file(UNKNOWN);
    await expect(offline.assign(Number(row.id), { kind: 'movie', tmdbId: 670 })).rejects.toBeInstanceOf(MoviesServiceError);
    await expect(offline.assign(Number(row.id), { kind: 'movie', tmdbId: 670 })).rejects.toMatchObject({ code: 'no_tmdb_credentials' });
    await offline.close();
  });

  it('is not built with NOTESD_MOVIES=off, and scans nothing without roots', async () => {
    expect(buildMoviesService(config(DEFAULT_MOVIES_CONFIG), db)).toBeNull();
    await video(`Telegram/${KILLING}`, 7200);
    const s = buildMoviesService(config({ ...DEFAULT_MOVIES_CONFIG, enabled: true, roots: [] }), db, {
      host: HOST,
      tmdb: null,
      fallback: null,
      resolver: null,
      probe,
      log: () => {},
    });
    expect(s).not.toBeNull();
    s?.start();
    const report = await s?.syncNow();
    expect(report).toMatchObject({ scanned: 0, new: 0, error: null });
    expect(await files()).toEqual([]);
    expect(probeCalls).toBe(0);
    await s?.close();
  });
});
```
**Impact:** `npm run test:int` (Docker Postgres with migration 0017 from phase 1).

## Principles applied

- Boundary discipline: ffprobe's text becomes a number (or a typed `ProbeError`) once in `probeDuration`, and disk entries become `ScannedFile` with a normalized `/` `relPath` once in `walkRoots`; the pass, the done-dir rule and the parser trust those values and never re-check them.
- Make illegal states unrepresentable: `Resolution` carries `titleId` only when `matched` and `reason` only otherwise, and every file write in the pass is built from one `Resolution` in `store`, so the pass cannot write a matched row with a reason or an unmatched row with a title.
- Laziness protocol: polling (no watcher), file-size stability kept in an in-memory map instead of a new table or a new `FileReason`, one `TitleResolver` seam over phase 2's `matchTitle`/`TmdbClient` instead of a TMDB fake that mimics search payloads, and no new `StartDaemonOptions` field (the proof drives TMDB through `TMDB_API_BASE`).
- Test behavior, not implementation: the sync is tested against the real test database and a real temp directory, faking only the network (resolver) and ffprobe; the loop is tested by what callers see (pass calls, reports, events, abort), not by private timers.
- Prove it works: the Proof drives a throwaway daemon with real ffprobe on real generated videos over real folders; only TMDB is a local fake server.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm run typecheck`
**Tests:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm test && npm run test:int`
**Proof:** a throwaway notesd scans two real folders of generated videos, with real ffprobe and a local fake TMDB; every claim is read back from the run's database.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up` / `sql` / `exec` / `doctor` / `down`). The movie env vars are passed through the caller's environment (`up` inherits it; real env wins over `.env.local`).
- Feature-map entries: none yet — `features/movies.md` is written by phase 8 (see Handoffs); the neighbor check uses `notes.md`.
- Setup (run once, in one shell, before the journeys):
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/movies-library
  V=.claude/skills/verify-notesd/scripts/verify.sh
  S=$(mktemp -d /tmp/movies-proof.XXXXXX)
  # write the fake TMDB below to "$S/fake-tmdb.mjs", then:
  node "$S/fake-tmdb.mjs" 47390 >"$S/tmdb.log" 2>&1 & echo $! >"$S/tmdb.pid"
  ffmpeg -v error -f lavfi -i color=c=black:s=16x16:r=1:d=1000 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$S/long.mkv"
  ffmpeg -v error -f lavfi -i color=c=black:s=16x16:r=1:d=60 -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$S/short.mp4"
  VID="$S/lib/Videos"; T="$S/lib/Telegram"; MB="$T/Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]"
  mkdir -p "$VID/Done/docker_es" "$VID/Pak Bernard/Oldboy (2003)" "$MB" "$S/outside"
  cp "$S/long.mkv" "$T/How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv"
  cp "$S/long.mkv" "$VID/Pak Bernard/Oldboy (2003)/Oldboy.mkv"
  cp "$S/long.mkv" "$VID/Done/The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv"
  cp "$S/long.mkv" "$MB/MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv"
  cp "$S/long.mkv" "$MB/MobLand.S01E02.Alpha.Male.1080p.WEB-DL.x265.6CH-Pahe.in.mkv"
  cp "$S/long.mkv" "$VID/Totally.Unknown.Picture.2019.1080p.WEB-DL.x265-Pahe.in.mkv"
  cp "$S/short.mp4" "$VID/Done/docker_es/VID-20250101-WA0001.mp4"
  cp "$S/long.mkv" "$S/outside/Oldboy.2003.1080p.mkv"
  RUN=$(NOTESD_MOVIES=on NOTESD_MOVIES_ROOTS="$VID:$T" NOTESD_MOVIES_SCAN_MS=3000 NOTESD_FFPROBE_BIN=/usr/bin/ffprobe \
        TMDB_API_READ_ACCESS_TOKEN=fake-token TMDB_API_KEY= TMDB_API_BASE=http://127.0.0.1:47390 \
        NOTESD_CLAUDE_BIN=/nonexistent/claude $V up | sed -n 's/^RUN=//p'); echo "RUN=$RUN"
  q() { docker exec -i mcp-notes-pg-verify psql -X -qtA -U postgres -d "$(cat ~/.local/state/notesd-verify/$RUN/db)" -c "$1"; }
  waitq() { for _ in $(seq 1 90); do [ "$(q "$1")" = "$2" ] && return 0; sleep 1; done; echo "TIMEOUT: $1 -> $(q "$1")"; return 1; }
  waitq "select count(*) from movie_files where status <> 'pending'" 7
  ```
  `NOTESD_CLAUDE_BIN=/nonexistent/claude` keeps the Haiku fallback unbuilt, so no journey bills a model call. The fake TMDB (`$S/fake-tmdb.mjs`):
  ```js
  import http from 'node:http';
  const port = Number(process.argv[2] ?? 47390);
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const studio = { id: 3172, name: 'Blumhouse Productions', logo_path: null, origin_country: 'US' };
  const movies = {
    467905: { title: 'How to Make a Killing', date: '2026-02-20' },
    670: { title: 'Oldboy', date: '2003-11-21' },
    1100001: { title: 'The Rivals of Amziah King', date: '2026-03-01' },
    1200002: { title: 'Bad Apples', date: '2025-09-12' },
  };
  const shows = { 247718: { name: 'MobLand', date: '2025-03-30' } };
  const episodes = [[1, 'Stick or Twist', '2025-03-30'], [2, 'Alpha Male', '2025-04-06'], [3, 'Sweet Dreams', '2025-04-13']];
  const movieRow = (id) => ({ id: Number(id), title: movies[id].title, original_title: movies[id].title, release_date: movies[id].date,
    overview: `Synopsis of ${movies[id].title}.`, poster_path: `/poster-${id}.jpg`, backdrop_path: null, popularity: 50,
    vote_count: 1000, vote_average: 7.1, genre_ids: [53], original_language: 'en', adult: false });
  const tvRow = (id) => ({ id: Number(id), name: shows[id].name, original_name: shows[id].name, first_air_date: shows[id].date,
    overview: `Synopsis of ${shows[id].name}.`, poster_path: `/poster-${id}.jpg`, backdrop_path: null, popularity: 80,
    vote_count: 500, vote_average: 8, genre_ids: [80], original_language: 'en', origin_country: ['GB'] });
  const movieDetails = (id) => ({ ...movieRow(id), runtime: 105, status: 'Released', genres: [{ id: 53, name: 'Thriller' }],
    production_companies: [studio],
    credits: {
      cast: [{ id: 9001, name: 'Glen Powell', character: 'Becket', order: 0, profile_path: null, known_for_department: 'Acting' }],
      crew: [
        { id: 9002, name: 'John Patton Ford', job: 'Director', department: 'Directing', profile_path: null },
        { id: 9002, name: 'John Patton Ford', job: 'Screenplay', department: 'Writing', profile_path: null },
        { id: 9003, name: 'Jason Blum', job: 'Producer', department: 'Production', profile_path: null },
      ],
    } });
  const tvDetails = (id) => ({ ...tvRow(id), number_of_seasons: 1, number_of_episodes: 3, episode_run_time: [58], genres: [{ id: 80, name: 'Crime' }],
    production_companies: [{ id: 4000, name: 'Paramount+', logo_path: null, origin_country: 'US' }],
    created_by: [{ id: 9101, name: 'Ronan Bennett', profile_path: null }],
    seasons: [{ season_number: 1, episode_count: 3, name: 'Season 1', air_date: '2025-03-30' }],
    credits: { cast: [{ id: 9102, name: 'Tom Hardy', character: 'Harry Da Souza', order: 0, profile_path: null }], crew: [] },
    aggregate_credits: {
      cast: [{ id: 9102, name: 'Tom Hardy', profile_path: null, order: 0, total_episode_count: 3, roles: [{ character: 'Harry Da Souza', episode_count: 3 }] }],
      crew: [{ id: 9103, name: 'Guy Ritchie', profile_path: null, department: 'Production', total_episode_count: 3, jobs: [{ job: 'Executive Producer', episode_count: 3 }] }],
    } });
  const season = (n) => ({ season_number: n, episodes: n !== 1 ? [] : episodes.map(([e, name, air]) =>
    ({ season_number: 1, episode_number: e, name, air_date: air, runtime: 58, overview: '', still_path: null })) });
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    const p = url.pathname.replace(/^\/3(?=\/)/, '');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const q = norm(url.searchParams.get('query'));
    let m;
    if (p === '/search/movie') { const r = Object.keys(movies).filter((id) => norm(movies[id].title) === q).map(movieRow); return send(200, { page: 1, results: r, total_pages: 1, total_results: r.length }); }
    if (p === '/search/tv') { const r = Object.keys(shows).filter((id) => norm(shows[id].name) === q).map(tvRow); return send(200, { page: 1, results: r, total_pages: 1, total_results: r.length }); }
    if ((m = p.match(/^\/movie\/(\d+)$/)) && movies[m[1]]) return send(200, movieDetails(m[1]));
    if ((m = p.match(/^\/tv\/(\d+)$/)) && shows[m[1]]) return send(200, tvDetails(m[1]));
    if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/)) && shows[m[1]]) return send(200, season(Number(m[2])));
    send(404, { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' });
  }).listen(port, '127.0.0.1', () => console.log(`fake tmdb on ${port}`));
  ```
- Journeys:
  - **J1** · traces R1.1, R1.4, R2.1, R3.5 — `$V sql $RUN "select name, status, title_id, season, episode, host from movie_files order by name"`; `q "select count(*) from movie_files where path like '%/outside/%'"`; `$V sql $RUN "select id, poster_path, release_date, overview <> '' as has_overview from movie_titles order by id"`; `$V sql $RUN "select c.role, p.name, c.character from movie_credits c join movie_people p on p.id = c.person_id where c.title_id = 'movie-467905' order by c.role, c.ord"`; `$V sql $RUN "select co.name from movie_title_companies tc join movie_companies co on co.id = tc.company_id where tc.title_id = 'movie-467905'"`; `$V sql $RUN "select season, episode, name from movie_episodes where title_id = 'tv-247718' order by 1, 2"` → passes when the How.to.Make.a.Killing file is `matched` `movie-467905`, `Oldboy.mkv` (two folders deep under `Videos`) is `matched` `movie-670`, both MobLand files are `matched` `tv-247718` with season 1 and episodes 1 and 2, every row's host equals `hostname` on this machine, the outside count is `0`, `movie-467905` has `poster_path` `/poster-467905.jpg`, release date `2026-02-20` and `has_overview` `t`, its credits list cast Glen Powell as Becket plus a director, a writer and a producer, its company is Blumhouse Productions, and `tv-247718` has episodes 1x1 Stick or Twist, 1x2 Alpha Male, 1x3 Sweet Dreams
  - **J2** · traces R1.2 — `$V sql $RUN "select name, status, reason, title_id from movie_files where status = 'unmatched' order by name"`; `q "select count(*) from movie_titles"` → passes when exactly two rows come back, `Totally.Unknown.Picture...mkv` with reason `no_match` and `VID-20250101-WA0001.mp4` with reason `too_short`, both with an empty `title_id`, and the title count is `4` (no title was made for either)
  - **J3** · traces R3.2 — `id=$(q "select id from movie_files where name = 'Oldboy.mkv'")`; `mv "$VID/Pak Bernard/Oldboy (2003)/Oldboy.mkv" "$T/Oldboy.mkv"`; `waitq "select path from movie_files where id = $id" "$T/Oldboy.mkv"`; `$V sql $RUN "select id, path, moved_at is not null as moved, deleted_at is null as live from movie_files where name = 'Oldboy.mkv'"` → passes when exactly one row comes back, with the same `id` as before the move, the new path under `Telegram`, `moved` `t` and `live` `t`
  - **J4** · traces R3.3 — `$V sql $RUN "select name, done_at is not null as done from movie_files where name like 'The_Rivals%'"`; `e1=$(q "select id from movie_files where name like 'MobLand.S01E01%'")`; `q "select (done_at is null)::text from movie_files where id = $e1"` (prints `true`); `mv "$MB/MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv" "$VID/Done/"`; `waitq "select (done_at is not null)::text from movie_files where id = $e1" true`; `$V sql $RUN "select id, path, done_at is not null as done, moved_at is not null as moved, deleted_at is null as live from movie_files where id = $e1"` → passes when the Rivals file (first found inside `Videos/Done`) shows `done` `t`, and the E01 row keeps its id, now has a path under `Videos/Done`, `done` `t`, `moved` `t`, `live` `t`
  - **J5** · traces R3.1 — `k=$(q "select id from movie_files where name like 'How.to.Make%'")`; `$V exec $RUN "insert into movie_plays (file_id, host, source, started_at, position_s, duration_s, updated_at) values ($k, '$(hostname)', 'live', now(), 600, 1000, now())"`; `rm "$T/How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv"`; `waitq "select (deleted_at is not null)::text from movie_files where id = $k" true`; `$V sql $RUN "select f.id, f.deleted_at is not null as deleted, f.title_id, (select count(*) from movie_titles t where t.id = f.title_id) as titles, (select count(*) from movie_plays p where p.file_id = f.id) as plays from movie_files f where f.id = $k"` → passes when the row shows `deleted` `t`, `title_id` `movie-467905`, `titles` `1` and `plays` `1`
  - **J6** · traces R2.3 — `kill "$(cat "$S/tmdb.pid")"`; `cp "$S/long.mkv" "$T/Bad.Apples.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv"`; `waitq "select status || '/' || coalesce(reason, '') from movie_files where name like 'Bad.Apples%'" "pending/tmdb_error"`; `q "select count(*) from movie_files where status = 'matched' and deleted_at is null"`; `$V doctor $RUN`; then `node "$S/fake-tmdb.mjs" 47390 >>"$S/tmdb.log" 2>&1 & echo $! >"$S/tmdb.pid"`; `waitq "select status || '/' || coalesce(title_id, '') from movie_files where name like 'Bad.Apples%'" "matched/movie-1200002"`; `$V sql $RUN "select name, status, reason, title_id from movie_files where name like 'Bad.Apples%'"` → passes when, with TMDB down, the new file reaches `pending/tmdb_error` while the other matched files stay matched (count `4`: Oldboy, Rivals, E01, E02 live and matched; Killing was deleted in J5, so run J6 after J5) and `doctor` reports the daemon alive, and after the fake TMDB is back the same row becomes `matched` with `movie-1200002` and an empty reason
- Neighbor check: notes on a daemon with movies on but no roots (the default `$V up`, since `parseMovies` defaults to on) — `R2=$($V up | sed -n 's/^RUN=//p')`; `$V api $R2 POST /api/notes '{"body":"movies neighbor #verify"}'`; `$V api $R2 GET /api/notes`; `$V sql $R2 "select count(*) from movie_files"`; `grep 'movies on as' ~/.local/state/notesd-verify/$R2/daemon.log` → passes when the POST answers 201, the GET lists the note, `movie_files` has `0` rows and the log says `NOTESD_MOVIES_ROOTS is empty, nothing is scanned`; then `$V down $R2`
- Cleanup: `$V down $RUN; kill "$(cat "$S/tmdb.pid")"; rm -rf "$S"`
- Cost: none. No LLM call (fallback unbuilt), no real TMDB, no network beyond loopback.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass; J1–J6 pass on a throwaway daemon; with `NOTESD_MOVIES=off` the daemon logs `movies off` and builds no service; with no roots nothing is scanned or spawned.

## Handoffs

- **Phase 8 (R7.1):** write `.claude/skills/verify-notesd/features/movies.md` with this phase's sync journeys (the proof tree, the fake TMDB server and J1–J6 above are ready to lift into verify fixtures), its README row, the `CLAUDE.md` paragraph (sync is polling, moves are name+size, done dirs, pending retry, stability gate) and README rows for every movie env var. This phase deliberately writes no feature-map entry because the index assigns `movies.md` to phase 8.
- **Phase 4:** `MoviesStatus` (what `status()` returns, the body of `GET /api/movies/status`) is exactly `{ host, roots, done_dirs, scan_ms, min_seconds, scanning, running, tmdb, next_pass_at, last_pass }` (reconciled: phase 4 and phase 6 mirror this shape). `POST /api/movies/sync` should start `service.syncNow()` without awaiting it (a real pass can take a minute) and answer with `status()`; `GET /api/movies/status` returns `service.status()` (synchronous); map `MoviesServiceError` codes `not_found` -> 404, `no_tmdb_credentials` -> 503, `tmdb_unreachable` -> 502 in `POST /api/movies/files/:fileId/assign` (body `{ kind, tmdb_id, season?, episode? }` validated with zod there, then `service.assign(fileId, { kind, tmdbId, season, episode })`); call `service.events.changed('user', { titleIds })` after user-state writes; the SSE route subscribes with `service.events.on`. Proving R1.5 is phase 4's.
- **Phase 5:** register the VLC recents reader with `service.addSyncHook({ name: 'vlc-recents', afterScan })`; `ctx.resolve(fileName)` classifies a gone file's name exactly like a scanned one (and stores the title on first match), `ctx.present` tells whether a path is on disk this pass, `ctx.repo` writes observations; return the number of rows written so the pass emits `changed`. Emit `service.events.changed('play', { titleIds, fileIds })` from the player on play start and play end only, never on a position poll (the web reloads on every `changed`).
- **Phase 7:** `service.tmdb` (null without credentials) is the client for `movies_person`.
- **Phases 1 and 2:** reconciled; **Requires** above quotes their final signatures (`NewMovieFile` + `FileClassification`, `upsertFile` returning `{ file, created }`, `moveFile(..., { done })`, `TmdbError(code, message, status?)`).
- **Not done here (out of scope, noted for later):** a deleted row whose file reappears in a later pass (restored from the Windows recycle bin, or a move that finished copying after the pass that saw the old path gone) is registered as a new row instead of being revived; files under a root removed from `NOTESD_MOVIES_ROOTS` are left untouched rather than deleted.

## Rollback

Revert this phase's commit. `src/movies/service.ts` returns to phase 1's placeholder, `src/daemon.ts` to `movies: null`, `src/background.ts` loses the movies block; the new files and tests disappear. No migration or schema change to undo. Rows the sync wrote stay in `movie_*` and are harmless; without the revert, `NOTESD_MOVIES=off` stops all scanning.
