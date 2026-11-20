import { hostname } from 'node:os';
import type { Config, TrendingConfig } from '../../config.js';
import type { Db } from '../../db/client.js';
import { listTitlesByIds, titleLanguages, type ReadContext, type TitleListItem } from '../../movies/read.js';
import type { MoviesService } from '../../movies/service.js';
import { MovieStreams } from '../../movies/streams.js';
import { createTmdbClient, type TmdbImdbLookup, type TmdbTitleNames } from '../../movies/tmdb.js';
import type { StreamTarget } from '../../movies/types.js';
import { parseRelease } from '../torrent/find/release.js';
import { fetchTrends, selectTrends, type FetchedTrends, type TrendSourceAttempt, type TrendTitle } from './sources.js';
import { TrendingRepo, type TrendingEntry, type TrendingStore } from './repo.js';

/**
 * The daily trending list of the Stream side. Once a day (checked every hour) the torrent indexes' top-seeded
 * listings are read, the titles the owner has not seen are kept, the top `size` films and `size` series become
 * this host's stream_trending rows. The seed count is the index's claim; no swarm is joined. Titles the owner marks
 * watched or not interested afterwards are not copied here: the route reads them from movie_titles and leaves
 * them out at once, and the next build does not list them.
 */

export const TRENDING_INITIAL_DELAY_MS = 120_000;
/** The job looks this often whether the list is a day old. */
export const TRENDING_CHECK_MS = 60 * 60_000;
export const TRENDING_EVERY_MS = 24 * 60 * 60_000;
/** How many candidates per wanted title are looked up in TMDB before the list is given up as short. */
const CANDIDATE_FACTOR = 3;
const RESOLVE_CONCURRENCY = 6;
const CLOSE_GRACE_MS = 5_000;

/**
 * True when a title is one the skip list names: its TMDB original language is in it, or, with no language known, the
 * release names only skipped languages ("Scene 2026 1080p Telugu DVDScr"). A release that also names another language
 * ("English Hindi" dual audio) is not skipped by its name: its film may be a dubbed Hollywood one.
 */
export function isSkippedLanguage(language: string | null | undefined, releaseName: string, skip: ReadonlySet<string>): boolean {
  if (skip.size === 0) return false;
  if (language !== null && language !== undefined && language !== '') return skip.has(language);
  const named = parseRelease(releaseName, {}).languages;
  return named.length > 0 && named.every((l) => skip.has(l));
}

/** States the owner has not "asked to play yet": every other state (seen, finished, started, dropped) leaves the list. */
export function isFreshForTrending(item: Pick<TitleListItem, 'state' | 'watched' | 'not_interested'>): boolean {
  return !item.watched && !item.not_interested && (item.state === 'unwatched' || item.state === 'removed_unwatched');
}

export type TrendingStop = 'done' | 'no_listing' | 'closed' | 'error';

export interface TrendingPass {
  started_at: string;
  finished_at: string | null;
  seconds: number;
  asked: boolean;
  indexes: TrendSourceAttempt[];
  /** Titles on the list after the build: films and series. */
  movies: number;
  series: number;
  stopped: TrendingStop;
  error: string | null;
}

export type TrendingOffReason = 'setting_off' | 'movies_off' | 'direct_stream_off' | 'torrent_off' | 'no_tmdb';

export interface TrendingStatus {
  enabled: boolean;
  off_reason: TrendingOffReason | null;
  host: string | null;
  running: boolean;
  next_check_at: string | null;
  settings: { size: number } | null;
  last_pass: TrendingPass | null;
}

/** What background.ts, the daemon and the routes hold. */
export interface TrendingHandle {
  readonly enabled: boolean;
  startLine(): string;
  start(): void;
  /** Asks for a pass now (the refresh icon). False when one is running or the job is off. */
  askPass(): boolean;
  status(): TrendingStatus;
  close(): Promise<void>;
}

const OFF_TEXT: Record<TrendingOffReason, string> = {
  setting_off: 'NOTESD_TRENDING=off',
  movies_off: 'the movie library is off (NOTESD_MOVIES=off)',
  direct_stream_off: 'direct streaming is off (NOTESD_DIRECT_STREAM=off)',
  torrent_off: 'torrents are off (NOTESD_TORRENT=off)',
  no_tmdb: 'no TMDB credential is configured',
};

/** The job when it must not run: no timer, no index request, no TMDB request. */
export class DisabledTrending implements TrendingHandle {
  readonly enabled = false;

  constructor(readonly reason: TrendingOffReason) {}

  startLine(): string {
    return `[notesd] trending off: ${OFF_TEXT[this.reason]}`;
  }

  start(): void {}

  askPass(): boolean {
    return false;
  }

  status(): TrendingStatus {
    return { enabled: false, off_reason: this.reason, host: null, running: false, next_check_at: null, settings: null, last_pass: null };
  }

  async close(): Promise<void> {}
}

export interface TrendingJobOptions {
  config: Pick<TrendingConfig, 'size'> & { skipLanguages?: readonly string[] };
  host: string;
  store: TrendingStore;
  tmdb: TmdbImdbLookup & Partial<Pick<TmdbTitleNames, 'originalLanguage'>>;
  /** Stores a title's original language when TMDB gave one for a title that had none (MoviesRepo.setOriginalLanguage). */
  saveLanguage?: (id: string, language: string) => Promise<void>;
  /** MovieStreams.ensureTitle: stores the title's row (TMDB details); null when it cannot. */
  ensureTitle: (target: StreamTarget) => Promise<string | null>;
  /** TMDB's original language of the listed titles, by title id (titleLanguages); a title not in it, or with null, is not skipped. */
  languages?: (ids: readonly string[]) => Promise<ReadonlyMap<string, string | null>>;
  /** The listed titles' states, by title id (listTitlesByIds). */
  titles: (ids: readonly string[]) => Promise<TitleListItem[]>;
  /** Tells the page the list changed. */
  changed: () => void;
  fetchTrends?: () => Promise<FetchedTrends>;
  now?: () => Date;
  log?: (line: string) => void;
  initialDelayMs?: number;
  checkMs?: number;
  everyMs?: number;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs `fn` over `items`, `limit` at a time, in order of start; results in item order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, at: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      out[at] = await fn(items[at] as T, at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class TrendingJob implements TrendingHandle {
  readonly enabled = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private closed = false;
  private abort = new AbortController();
  private last: TrendingPass | null = null;
  private nextAt: Date | null = null;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly o: TrendingJobOptions) {
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? ((line: string) => console.log(line));
  }

  startLine(): string {
    return `[notesd] trending on as ${this.o.host}: a list of the ${this.o.config.size} most seeded films and ${this.o.config.size} series the owner has not seen, once a day`;
  }

  start(): void {
    this.schedule(this.o.initialDelayMs ?? TRENDING_INITIAL_DELAY_MS);
  }

  askPass(): boolean {
    if (this.closed || this.running !== null) return false;
    this.running = this.pass(true).finally(() => {
      this.running = null;
    });
    return true;
  }

  status(): TrendingStatus {
    return {
      enabled: true,
      off_reason: null,
      host: this.o.host,
      running: this.running !== null,
      next_check_at: this.nextAt === null ? null : this.nextAt.toISOString(),
      settings: { size: this.o.config.size },
      last_pass: this.last,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const running = this.running;
    if (running !== null) await Promise.race([running.catch(() => undefined), new Promise((r) => setTimeout(r, CLOSE_GRACE_MS).unref())]);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    this.nextAt = new Date(this.now().getTime() + ms);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.running === null) {
        const at = await this.o.store.listedAt(this.o.host);
        if (at === null || this.now().getTime() - at.getTime() >= (this.o.everyMs ?? TRENDING_EVERY_MS)) {
          this.running = this.pass(false).finally(() => {
            this.running = null;
          });
        }
      }
      await this.running;
    } catch (err) {
      this.log(`[notesd] trending: ${messageOf(err)}`);
    } finally {
      this.schedule(this.o.checkMs ?? TRENDING_CHECK_MS);
    }
  }

  /** One pass: build the list. Never throws. */
  async pass(asked: boolean): Promise<void> {
    const started = this.now();
    const summary: TrendingPass = {
      started_at: started.toISOString(),
      finished_at: null,
      seconds: 0,
      asked,
      indexes: [],
      movies: 0,
      series: 0,
      stopped: 'done',
      error: null,
    };
    this.last = summary;
    try {
      await this.build(summary);
    } catch (err) {
      summary.stopped = 'error';
      summary.error = messageOf(err);
      this.log(`[notesd] trending: the pass failed: ${summary.error}`);
    } finally {
      const end = this.now();
      summary.finished_at = end.toISOString();
      summary.seconds = Math.round((end.getTime() - started.getTime()) / 100) / 10;
      this.log(
        `[notesd] trending: ${summary.stopped}: ${summary.movies} films, ${summary.series} series in ${summary.seconds} s` +
          (summary.error === null ? '' : ` (${summary.error})`),
      );
    }
  }

  private async build(summary: TrendingPass): Promise<void> {
    const { size } = this.o.config;
    const fetched = await (this.o.fetchTrends ?? fetchTrends)();
    summary.indexes = fetched.attempts;
    const titles = selectTrends(fetched.rows);
    if (titles.length === 0) {
      // The old list stays: a failed index must not empty the page.
      summary.stopped = 'no_listing';
      return;
    }
    const before = await this.o.store.rows(this.o.host);
    const known = new Map(before.map((r) => [r.imdbId, r.titleId]));
    const entries: TrendingEntry[] = [];
    for (const kind of ['movie', 'tv'] as const) {
      const candidates = titles.filter((t) => t.kind === kind).slice(0, size * CANDIDATE_FACTOR);
      const resolved = (await mapLimit(candidates, RESOLVE_CONCURRENCY, (t) => this.resolve(t, known))).filter((r): r is { id: string; t: TrendTitle } => r !== null);
      const unique: { id: string; t: TrendTitle }[] = [];
      for (const r of resolved) if (!unique.some((u) => u.id === r.id)) unique.push(r);
      const skip = new Set(this.o.config.skipLanguages ?? []);
      const languages = new Map<string, string | null>(skip.size === 0 || this.o.languages === undefined ? [] : await this.o.languages(unique.map((u) => u.id)));
      await this.learnLanguages(unique, languages);
      const wanted = unique.filter((u) => !isSkippedLanguage(languages.get(u.id), u.t.name, skip));
      const fresh = new Map((await this.o.titles(wanted.map((u) => u.id))).filter(isFreshForTrending).map((i) => [i.id, i]));
      const kept = wanted.filter((u) => fresh.has(u.id)).slice(0, size);
      kept.forEach(({ id, t }, i) => {
        entries.push({
          titleId: id,
          kind,
          imdbId: t.imdbId,
          rank: i + 1,
          seeds: t.seeds,
          index: t.index,
          infoHash: t.infoHash,
          releaseName: t.name,
          sizeBytes: t.sizeBytes,
        });
      });
      if (kind === 'movie') summary.movies = kept.length;
      else summary.series = kept.length;
    }
    await this.o.store.replace(this.o.host, entries, this.now());
    this.o.changed();
  }

  /** A listed torrent to its title: the stored one when its IMDb id is known, else TMDB's, ensured in the library tables. */
  private async resolve(t: TrendTitle, known: ReadonlyMap<string, string>): Promise<{ id: string; t: TrendTitle } | null> {
    const stored = known.get(t.imdbId);
    if (stored !== undefined) return { id: stored, t };
    try {
      const found = await this.o.tmdb.findByImdb(t.imdbId);
      if (found === null || found.kind !== t.kind) return null;
      const id = await this.o.ensureTitle({ kind: found.kind, tmdbId: found.tmdbId });
      return id === null ? null : { id, t };
    } catch (err) {
      this.log(`[notesd] trending: ${t.imdbId} (${t.name}) could not be matched: ${messageOf(err)}`);
      return null;
    }
  }

  /** A stored title that has no original language is asked of TMDB, and the answer is kept, so every later read can tell. */
  private async learnLanguages(unique: readonly { id: string; t: TrendTitle }[], languages: Map<string, string | null>): Promise<void> {
    const ask = this.o.tmdb.originalLanguage?.bind(this.o.tmdb);
    if (ask === undefined || (this.o.config.skipLanguages ?? []).length === 0) return;
    const unknown = unique.filter((u) => (languages.get(u.id) ?? null) === null);
    await mapLimit(unknown, RESOLVE_CONCURRENCY, async (u) => {
      const m = /^(movie|tv)-(\d+)$/.exec(u.id);
      if (m === null) return;
      try {
        const language = await ask(m[1] as 'movie' | 'tv', Number(m[2]));
        if (language === null) return;
        languages.set(u.id, language);
        await this.o.saveLanguage?.(u.id, language);
      } catch (err) {
        this.log(`[notesd] trending: the language of ${u.id} is unknown: ${messageOf(err)}`);
      }
    });
  }

}

export interface BuildTrendingInput {
  config: Config;
  db: Db;
  movies: MoviesService | null;
  /** Null with torrents off: the list names torrents, so it is off too. */
  torrents: unknown | null;
}

export interface BuildTrendingOverrides {
  tmdb?: TmdbImdbLookup;
  store?: TrendingStore;
  fetchTrends?: () => Promise<FetchedTrends>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The daemon's trending job, or a DisabledTrending saying why not. */
export function buildTrending(input: BuildTrendingInput, overrides: BuildTrendingOverrides = {}): TrendingHandle {
  const ds = input.config.directStream;
  const trending = ds?.trending;
  if (ds === undefined || trending === undefined || !trending.enabled) return new DisabledTrending('setting_off');
  const movies = input.movies;
  if (movies === null) return new DisabledTrending('movies_off');
  if (!ds.enabled) return new DisabledTrending('direct_stream_off');
  const torrents = input.torrents;
  if (torrents === null) return new DisabledTrending('torrent_off');
  const tmdbConfig = input.config.movies.tmdb;
  const tmdb = overrides.tmdb ?? (tmdbConfig.token !== null || tmdbConfig.apiKey !== null ? createTmdbClient(tmdbConfig) : null);
  if (tmdb === null) return new DisabledTrending('no_tmdb');
  const host = movies.host ?? hostname();
  const ctx: ReadContext = { host, imageBase: tmdbConfig.imageBase };
  const streams = new MovieStreams(movies, { ...(overrides.now === undefined ? {} : { now: overrides.now }), ...(overrides.log === undefined ? {} : { log: overrides.log }) });
  const finder = input.config.torrent?.finder?.indexes ?? {};
  return new TrendingJob({
    config: trending,
    host,
    store: overrides.store ?? new TrendingRepo(input.db),
    tmdb,
    ensureTitle: (target) => streams.ensureTitle(target),
    languages: (ids) => titleLanguages(input.db, ids),
    saveLanguage: async (id, language) => {
      await movies.repo.setOriginalLanguage(id, language);
    },
    titles: (ids) => listTitlesByIds(input.db, ids, ctx),
    changed: () => movies.events.changed('stream'),
    fetchTrends:
      overrides.fetchTrends ??
      ((): Promise<FetchedTrends> => fetchTrends({ ...(finder.apibay === undefined ? {} : { apibay: finder.apibay }), ...(finder.eztv === undefined ? {} : { eztv: finder.eztv }) })),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  });
}
