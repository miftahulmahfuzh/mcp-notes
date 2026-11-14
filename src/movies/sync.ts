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
