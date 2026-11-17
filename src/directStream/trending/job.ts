import { hostname } from 'node:os';
import type { Config, TrendingConfig } from '../../config.js';
import type { Db } from '../../db/client.js';
import type { StreamTrendingRow, TrendingProbeOutcome } from '../../db/schema.js';
import { listTitlesByIds, type ReadContext, type TitleListItem } from '../../movies/read.js';
import type { MoviesService } from '../../movies/service.js';
import { MovieStreams } from '../../movies/streams.js';
import { createTmdbClient, type TmdbImdbLookup } from '../../movies/tmdb.js';
import type { StreamTarget } from '../../movies/types.js';
import type { TorrentStreams } from '../torrent/service.js';
import { TorrentError } from '../torrent/types.js';
import { TRENDING_TRACKERS, fetchTrends, selectTrends, type FetchedTrends, type TrendSourceAttempt, type TrendTitle } from './sources.js';
import { TrendingRepo, type TrendingEntry, type TrendingStore } from './repo.js';

/**
 * The daily trending list of the Stream side. Once a day (checked every hour) the torrent indexes' top-seeded
 * listings are read, the titles the owner has not seen are kept, the top `size` films and `size` series become
 * this host's stream_trending rows, and then the first `probe` of them have their swarm opened once to see
 * whether a peer sends a file list ("confirmed") or nobody answers ("no peers"). A listed seed count is only
 * the index's claim; the probe is the one thing that tells a live swarm from a dead one. Titles the owner marks
 * watched or not interested afterwards are not copied here: the route reads them from movie_titles and leaves
 * them out at once, and the next build does not list them.
 */

export const TRENDING_INITIAL_DELAY_MS = 120_000;
/** The job looks this often whether the list is a day old. */
export const TRENDING_CHECK_MS = 60 * 60_000;
export const TRENDING_EVERY_MS = 24 * 60 * 60_000;
/** A swarm that sent no file list within this is a dead one (several real plays hit one on 2026-11-16). */
export const TRENDING_PEEK_TIMEOUT_MS = 20_000;
export const TRENDING_PEEK_CONCURRENCY = 3;
/** A probe younger than this is kept when a build lists the same torrent again (a refresh asked by hand). */
export const TRENDING_PROBE_REUSE_MS = 12 * 60 * 60_000;
/** How many candidates per wanted title are looked up in TMDB before the list is given up as short. */
const CANDIDATE_FACTOR = 3;
const RESOLVE_CONCURRENCY = 6;
const CLOSE_GRACE_MS = 5_000;

/** States the owner has not "asked to play yet": every other state (seen, finished, started, dropped) leaves the list. */
export function isFreshForTrending(item: Pick<TitleListItem, 'state' | 'watched' | 'not_interested'>): boolean {
  return !item.watched && !item.not_interested && (item.state === 'unwatched' || item.state === 'removed_unwatched');
}

export type TrendingStop = 'done' | 'no_listing' | 'busy' | 'closed' | 'error';

export interface TrendingPass {
  started_at: string;
  finished_at: string | null;
  seconds: number;
  asked: boolean;
  indexes: TrendSourceAttempt[];
  /** Titles on the list after the build: films and series. */
  movies: number;
  series: number;
  probed: number;
  confirmed: number;
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
  settings: { size: number; probe: number } | null;
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

/** The job when it must not run: no timer, no index request, no TMDB request, no swarm. */
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

export interface PeekResult {
  files: number;
  videos: number;
  peers: number | null;
  live: boolean;
}

export interface TrendingJobOptions {
  config: Pick<TrendingConfig, 'size' | 'probe'>;
  host: string;
  store: TrendingStore;
  tmdb: TmdbImdbLookup;
  /** MovieStreams.ensureTitle: stores the title's row (TMDB details); null when it cannot. */
  ensureTitle: (target: StreamTarget) => Promise<string | null>;
  /** The listed titles' states, by title id (listTitlesByIds). */
  titles: (ids: readonly string[]) => Promise<TitleListItem[]>;
  peek: (infoHash: string, trackers: readonly string[], options: { timeoutMs: number }) => Promise<PeekResult>;
  /** True while something plays or is being started: the probe then waits for the next pass. */
  busy: () => boolean;
  /** Tells the page the list changed. */
  changed: () => void;
  fetchTrends?: () => Promise<FetchedTrends>;
  now?: () => Date;
  log?: (line: string) => void;
  initialDelayMs?: number;
  checkMs?: number;
  everyMs?: number;
  peekTimeoutMs?: number;
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
    return `[notesd] trending on as ${this.o.host}: a list of the ${this.o.config.size} most seeded films and ${this.o.config.size} series the owner has not seen, once a day, ${this.o.config.probe} swarms probed`;
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
      settings: { size: this.o.config.size, probe: this.o.config.probe },
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

  /** One pass: build the list, then probe. Never throws. */
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
      probed: 0,
      confirmed: 0,
      stopped: 'done',
      error: null,
    };
    this.last = summary;
    try {
      await this.build(summary);
      if (summary.stopped === 'done') await this.probe(summary);
    } catch (err) {
      summary.stopped = 'error';
      summary.error = messageOf(err);
      this.log(`[notesd] trending: the pass failed: ${summary.error}`);
    } finally {
      const end = this.now();
      summary.finished_at = end.toISOString();
      summary.seconds = Math.round((end.getTime() - started.getTime()) / 100) / 10;
      this.log(
        `[notesd] trending: ${summary.stopped}: ${summary.movies} films, ${summary.series} series, ${summary.confirmed} of ${summary.probed} swarms confirmed in ${summary.seconds} s` +
          (summary.error === null ? '' : ` (${summary.error})`),
      );
    }
  }

  private async build(summary: TrendingPass): Promise<void> {
    const { size, probe } = this.o.config;
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
      const fresh = new Map((await this.o.titles(unique.map((u) => u.id))).filter(isFreshForTrending).map((i) => [i.id, i]));
      const kept = unique.filter((u) => fresh.has(u.id)).slice(0, size);
      kept.forEach(({ id, t }, i) => {
        const old = before.find((r) => r.titleId === id);
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
          probe: carriedProbe(old, t.infoHash, this.now(), probe),
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

  private async probe(summary: TrendingPass): Promise<void> {
    const rows = (await this.o.store.rows(this.o.host)).filter((r) => r.probeOutcome === null);
    // Films and series alternate, most seeded first, so a pass cut short leaves both kinds probed at the top.
    const movies = rows.filter((r) => r.kind === 'movie');
    const series = rows.filter((r) => r.kind === 'tv');
    const order: StreamTrendingRow[] = [];
    for (let i = 0; i < Math.max(movies.length, series.length); i++) {
      const m = movies[i];
      const s = series[i];
      if (m !== undefined) order.push(m);
      if (s !== undefined) order.push(s);
    }
    const wanted = order.slice(0, Math.max(0, this.o.config.probe - (await this.alreadyProbed())));
    let cut: TrendingStop | null = null;
    await mapLimit(wanted, TRENDING_PEEK_CONCURRENCY, async (row) => {
      if (cut !== null) return;
      if (this.closed) {
        cut = 'closed';
        return;
      }
      if (this.o.busy()) {
        cut = 'busy';
        return;
      }
      const { outcome, detail } = await this.peekOne(row);
      summary.probed += 1;
      if (outcome === 'confirmed') summary.confirmed += 1;
      await this.o.store.recordProbe(this.o.host, row.titleId, row.infoHash, outcome, detail, this.now());
    });
    if (cut !== null) summary.stopped = cut;
    this.o.changed();
  }

  private async alreadyProbed(): Promise<number> {
    return (await this.o.store.rows(this.o.host)).filter((r) => r.probeOutcome !== null).length;
  }

  private async peekOne(row: StreamTrendingRow): Promise<{ outcome: TrendingProbeOutcome; detail: string }> {
    const timeoutMs = this.o.peekTimeoutMs ?? TRENDING_PEEK_TIMEOUT_MS;
    try {
      const got = await this.o.peek(row.infoHash, TRENDING_TRACKERS, { timeoutMs });
      if (got.videos === 0) return { outcome: 'no_video', detail: `a file list arrived (${got.files} files) but none is a video` };
      return {
        outcome: 'confirmed',
        detail: `${got.videos} video file${got.videos === 1 ? '' : 's'} of ${got.files}${got.peers === null ? '' : `, ${got.peers} peer${got.peers === 1 ? '' : 's'} connected`}${got.live ? '' : ', already on this machine'}`,
      };
    } catch (err) {
      if (err instanceof TorrentError && err.code === 'no_metadata') return { outcome: 'no_peers', detail: `no peer sent a file list within ${Math.round(timeoutMs / 1000)} s` };
      return { outcome: 'error', detail: messageOf(err) };
    }
  }
}

/** The last build's probe of this torrent when it is recent enough to stand for today's. */
function carriedProbe(old: StreamTrendingRow | undefined, infoHash: string, now: Date, probeCap: number): TrendingEntry['probe'] {
  if (old === undefined || probeCap === 0 || old.infoHash !== infoHash || old.probeOutcome === null || old.probedAt === null) return null;
  if (now.getTime() - old.probedAt.getTime() > TRENDING_PROBE_REUSE_MS) return null;
  return { outcome: old.probeOutcome, detail: old.probeDetail, at: old.probedAt };
}

export interface BuildTrendingInput {
  config: Config;
  db: Db;
  movies: MoviesService | null;
  torrents: TorrentStreams | null;
  /** True while a VLC play, a stream on screen or a stream being started exists. */
  busy: () => boolean;
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
    titles: (ids) => listTitlesByIds(input.db, ids, ctx),
    peek: (hash, trackers, options) => torrents.peek(hash, trackers, options),
    busy: input.busy,
    changed: () => movies.events.changed('stream'),
    fetchTrends:
      overrides.fetchTrends ??
      ((): Promise<FetchedTrends> => fetchTrends({ ...(finder.apibay === undefined ? {} : { apibay: finder.apibay }), ...(finder.eztv === undefined ? {} : { eztv: finder.eztv }) })),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  });
}
