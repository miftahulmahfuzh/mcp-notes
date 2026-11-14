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
