import { createTmdbClient, type TitleKind, type TmdbCatalog } from '../movies/tmdb.js';
import { probePassSeconds, type Config, type StreamProberConfig } from '../config.js';
import type { Db } from '../db/client.js';
import type { StreamProbeOutcome } from '../db/schema.js';
import type { MoviePlayer } from '../movies/player.js';
import { listTitles, MAX_LIST_LIMIT, type ReadContext } from '../movies/read.js';
import { streamFreshSince } from '../movies/repo.js';
import type { MoviesService } from '../movies/service.js';
import { CANDIDATE_REFRESH_MS, gatherCandidates, pickSeeds, type ListedCandidate, type SeedTitle } from './candidates.js';
import { detectIdleReader, type IdleDetection, type IdleOffReason, type IdleReader } from './idle.js';
import { ProbeRepo } from './repo.js';

/**
 * The direct-streaming prober (phase 10; D5, D6). Off unless NOTESD_STREAM_PROBER=on. Each pass:
 * refresh the TMDB candidate listing when it is a day old (HTTP only), then, only while nothing
 * plays and Windows has been idle for NOTESD_STREAM_IDLE_SECONDS (checked again before every
 * probe), re-check the verified sources nearest the end of their freshness window, then resolve
 * new candidates until NOTESD_STREAM_CATALOG_SIZE titles are fresh, inside NOTESD_STREAM_PROBE_BUDGET
 * probes and half of NOTESD_STREAM_PROBE_MS. Every probe is DirectStreamService.resolve with the
 * seconds left in the pass as its deadline: an out-of-sight tab, no sound, no play. Its hooks
 * (phase 5) ensure the title row and write verified or stale before it answers; the prober writes
 * only its own stream_probe_titles row (outcome and backoff).
 */

const DAY_MS = 86_400_000;
/** First pass after start: after the daemon's own startup work. */
export const INITIAL_DELAY_MS = 60_000;
const CLOSE_GRACE_MS = 5_000;
/** A source is re-checked once it is this far through its freshness window (about 4.9 days of 7). */
export const RECHECK_AT_FRACTION = 0.7;
/** An open play updated this recently means someone is watching: no probe. */
export const ACTIVE_PLAY_MS = 15 * 60_000;
/** One series slot in every SERIES_EVERY new-candidate probes, when a series is eligible. */
export const SERIES_EVERY = 4;
/** First wait after a failed probe; it doubles with each failure in a row, up to BACKOFF_MAX_MS. */
export const BACKOFF_BASE_MS = DAY_MS;
export const BACKOFF_MAX_MS = 30 * DAY_MS;
/** After a refresh that listed nothing (TMDB down), the next try waits this long. */
export const REFRESH_RETRY_MS = 60 * 60_000;
/** resolve() failures (phase 3's `reason` of a resolve_failed) that mean Chrome itself is missing: the pass stops and no title is blamed. */
export const ENVIRONMENT_ERRORS: ReadonlySet<string> = new Set(['no_chrome', 'chrome_not_reachable', 'direct_stream_off']);
/** A resolve cut short by its deadline (phase 1's --deadline-s): the pass's seconds are spent; no title is blamed. */
export const DEADLINE_ERROR = 'deadline';

/** What DirectStreamService.resolve takes (phase 3's `ref`). */
export interface ProbeRef {
  kind: TitleKind;
  tmdbId: number;
  season?: number;
  episode?: number;
}

/** A title to probe. A series candidate has no episode yet (S1E1 is probed); a re-check names its own. */
export interface ProbeTarget {
  kind: TitleKind;
  tmdbId: number;
  season: number | null;
  episode: number | null;
}

export type ProbeOutcome = StreamProbeOutcome;

export interface ProbeRecord {
  kind: TitleKind;
  tmdbId: number;
  outcome: ProbeOutcome;
  probedAt: Date;
  failures: number;
  retryAfter: Date | null;
}

/** ProbeRepo's surface; tests use an in-memory store with the same rules. */
export interface ProbeStore {
  freshCount(host: string, since: Date): Promise<number>;
  dueRechecks(host: string, dueBefore: Date, limit: number): Promise<ProbeTarget[]>;
  listedAt(host: string): Promise<Date | null>;
  replaceListing(host: string, entries: readonly ListedCandidate[], at: Date): Promise<void>;
  eligible(host: string, kind: TitleKind, now: Date, freshSince: Date, limit: number): Promise<ProbeTarget[]>;
  failures(host: string, kind: TitleKind, tmdbId: number): Promise<number>;
  record(host: string, r: ProbeRecord): Promise<void>;
  activePlay(host: string, since: Date): Promise<boolean>;
}

/** Why a pass ended. Every pass ends with exactly one. */
export type PassStop =
  | 'catalog_full'
  | 'no_candidates'
  | 'probe_budget'
  | 'time_budget'
  | 'not_idle'
  | 'busy'
  | 'chrome_unavailable'
  | 'closed'
  | 'error';

export interface PassSummary {
  started_at: string;
  finished_at: string | null;
  seconds: number;
  rechecked: number;
  recheck_verified: number;
  probed: number;
  probe_verified: number;
  failed: number;
  /** Candidates listed when this pass refreshed the listing; null when it did not. */
  listed: number | null;
  catalog_fresh: number | null;
  catalog_size: number;
  /** The last idle time read this pass; null when none was read. */
  idle_s: number | null;
  busy: 'vlc' | 'play' | null;
  stopped: PassStop;
  error: string | null;
}

export type ProberOffReason = 'setting_off' | 'movies_off' | 'direct_stream_off' | 'no_tmdb' | IdleOffReason;

export interface ProberStatus {
  enabled: boolean;
  off_reason: ProberOffReason | null;
  host: string | null;
  running: boolean;
  next_pass_at: string | null;
  settings: {
    catalog_size: number;
    probe_budget: number;
    pass_seconds: number;
    idle_seconds: number;
    probe_ms: number;
    fresh_days: number;
  } | null;
  catalog: { size: number; fresh: number | null } | null;
  last_pass: PassSummary | null;
}

/** What background.ts, the daemon and the status route hold. */
export interface StreamProberHandle {
  readonly enabled: boolean;
  /** The one line background.ts logs at start. */
  startLine(): string;
  start(): void;
  status(): Promise<ProberStatus>;
  close(): Promise<void>;
}

const OFF_TEXT: Record<ProberOffReason, string> = {
  setting_off: 'NOTESD_STREAM_PROBER is off (the default)',
  movies_off: 'NOTESD_MOVIES=off',
  direct_stream_off: 'direct streaming is off',
  no_tmdb: 'no TMDB credential (TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY)',
  not_linux: 'not running on Linux, so there is no Windows idle time to read',
  no_interop: 'no WSL interop, so there is no Windows idle time to read',
  no_powershell: 'powershell.exe not found (NOTESD_POWERSHELL_EXE), so there is no Windows idle time to read',
};

/** The prober when it must not run: no timer, no tab, no TMDB request, no idle read. */
export class DisabledProber implements StreamProberHandle {
  readonly enabled = false;

  constructor(readonly reason: ProberOffReason) {}

  startLine(): string {
    return `[notesd] stream prober off: ${OFF_TEXT[this.reason]}`;
  }

  start(): void {}

  async status(): Promise<ProberStatus> {
    return {
      enabled: false,
      off_reason: this.reason,
      host: null,
      running: false,
      next_pass_at: null,
      settings: null,
      catalog: null,
      last_pass: null,
    };
  }

  async close(): Promise<void> {}
}

export type ResolveVerdict = ProbeOutcome | 'chrome_unavailable' | 'deadline';

/**
 * The failure's name. Phase 3's DirectStreamError carries `code` (`no_source`, `resolve_failed`,
 * ...) and, for `resolve_failed`, the `reason` that names it (`no_chrome`, `deadline`, ...).
 */
function codeOf(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as { code?: unknown; reason?: unknown; error?: unknown };
  if (o.code === 'resolve_failed' && typeof o.reason === 'string' && o.reason !== '') return o.reason;
  const c = typeof o.code === 'string' ? o.code : o.error;
  return typeof c === 'string' && c !== '' ? c : null;
}

/**
 * What one DirectStreamService.resolve came to. The one place its answer is read: a rejection
 * with a `code` (phase 3's DirectStreamError), or an answer with `ok: false` and an `error` code,
 * are failures; anything else resolved (phase 5's hook has written `verified`).
 */
export function classifyResolve(r: { ok: true; value: unknown } | { ok: false; error: unknown }): ResolveVerdict {
  let code: string | null;
  if (r.ok) {
    const failed = typeof r.value === 'object' && r.value !== null && (r.value as { ok?: unknown }).ok === false;
    code = failed ? (codeOf(r.value) ?? 'error') : null;
  } else {
    code = codeOf(r.error) ?? 'error';
  }
  if (code === null) return 'verified';
  if (ENVIRONMENT_ERRORS.has(code)) return 'chrome_unavailable';
  if (code === DEADLINE_ERROR) return 'deadline';
  return code === 'no_source' ? 'no_source' : 'error';
}

/** When a title may be probed again: never held after `verified`; 1, 2, 4 ... days after failures, at most 30. */
export function retryAfter(outcome: ProbeOutcome, failures: number, at: Date): Date | null {
  if (outcome === 'verified') return null;
  const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return new Date(at.getTime() + wait);
}

/** Films in order, with a series in every `every`-th place while series remain; leftovers at the end. */
export function interleave<T>(films: readonly T[], series: readonly T[], every: number): T[] {
  const out: T[] = [];
  let f = 0;
  let s = 0;
  while (f < films.length || s < series.length) {
    const seriesTurn = (out.length + 1) % every === 0;
    if ((seriesTurn && s < series.length) || f >= films.length) out.push(series[s++]!);
    else out.push(films[f++]!);
  }
  return out;
}

export function passLine(s: PassSummary): string {
  const parts = [
    `${s.rechecked} re-checked (${s.recheck_verified} verified)`,
    `${s.probed} probed (${s.probe_verified} verified)`,
    `${s.failed} failed`,
    `catalog ${s.catalog_fresh ?? '?'}/${s.catalog_size}`,
  ];
  if (s.listed !== null) parts.push(`${s.listed} candidates listed`);
  const why =
    s.stopped === 'not_idle' && s.idle_s !== null
      ? `not_idle (idle ${s.idle_s} s)`
      : s.stopped === 'busy' && s.busy !== null
        ? `busy (${s.busy})`
        : s.stopped;
  return `[notesd] stream prober: pass ${s.seconds} s: ${parts.join(', ')}; stopped: ${why}${s.error === null ? '' : `; ${s.error}`}`;
}

function emptyPass(startedAt: Date, catalogSize: number): PassSummary {
  return {
    started_at: startedAt.toISOString(),
    finished_at: null,
    seconds: 0,
    rechecked: 0,
    recheck_verified: 0,
    probed: 0,
    probe_verified: 0,
    failed: 0,
    listed: null,
    catalog_fresh: null,
    catalog_size: catalogSize,
    idle_s: null,
    busy: null,
    stopped: 'no_candidates',
    error: null,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface StreamProberDeps {
  config: StreamProberConfig;
  /** NOTESD_STREAM_FRESH_DAYS (phase 3). */
  freshDays: number;
  host: string;
  store: ProbeStore;
  tmdb: TmdbCatalog;
  /** The owner's finished titles (all of them; pickSeeds chooses). */
  seeds: () => Promise<SeedTitle[]>;
  /** DirectStreamService.resolve, given the seconds left in the pass (phase 1's --deadline-s). */
  resolve: (ref: ProbeRef, options: { deadlineS: number }) => Promise<unknown>;
  idle: IdleReader;
  /** True while the VLC notesd follows is open. */
  vlcPlaying: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export class StreamProber implements StreamProberHandle {
  readonly enabled = true;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextPassAt: Date | null = null;
  private current: Promise<PassSummary> | null = null;
  private lastPass: PassSummary | null = null;
  private lastQuietStop: PassStop | null = null;
  private refreshFailedAt: number | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly deps: StreamProberDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line: string) => console.log(line));
  }

  get host(): string {
    return this.deps.host;
  }

  private get passSeconds(): number {
    return probePassSeconds(this.deps.config.probeMs);
  }

  startLine(): string {
    const c = this.deps.config;
    return (
      `[notesd] stream prober on as ${this.deps.host}: a pass every ${Math.round(c.probeMs / 1000)} s while Windows is idle ${c.idleSeconds} s ` +
      `and nothing plays, up to ${c.probeBudget} probes or ${this.passSeconds} s a pass, catalog ${c.catalogSize} titles fresh for ${this.deps.freshDays} days`
    );
  }

  /** Starts the loop (background.ts). The first pass runs after min(60 s, probeMs). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.schedule(Math.min(INITIAL_DELAY_MS, this.deps.config.probeMs));
  }

  /** One pass now, or the one in flight. Never rejects. */
  passNow(): Promise<PassSummary> {
    if (this.current !== null) return this.current;
    const pass = this.runPass();
    this.current = pass;
    void pass.then(() => {
      if (this.current === pass) this.current = null;
    });
    return pass;
  }

  async status(): Promise<ProberStatus> {
    let fresh: number | null;
    try {
      fresh = await this.deps.store.freshCount(this.deps.host, this.freshSince());
    } catch {
      fresh = null;
    }
    const c = this.deps.config;
    return {
      enabled: true,
      off_reason: null,
      host: this.deps.host,
      running: this.current !== null,
      next_pass_at: this.nextPassAt === null ? null : this.nextPassAt.toISOString(),
      settings: {
        catalog_size: c.catalogSize,
        probe_budget: c.probeBudget,
        pass_seconds: this.passSeconds,
        idle_seconds: c.idleSeconds,
        probe_ms: c.probeMs,
        fresh_days: this.deps.freshDays,
      },
      catalog: { size: c.catalogSize, fresh },
      last_pass: this.lastPass,
    };
  }

  /** Stops the loop; a probe in flight is waited for up to 5 s (no new one starts). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextPassAt = null;
    const running = this.current ?? Promise.resolve();
    await Promise.race([running, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);
  }

  /** Phase 5's one freshness window (NOTESD_STREAM_FRESH_DAYS before now). */
  private freshSince(): Date {
    return streamFreshSince(this.now(), this.deps.freshDays);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.nextPassAt = new Date(this.now().getTime() + delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextPassAt = null;
      void this.passNow().finally(() => this.schedule(this.deps.config.probeMs));
    }, delayMs);
    this.timer.unref();
  }

  private async runPass(): Promise<PassSummary> {
    const startedAt = this.now();
    const s = emptyPass(startedAt, this.deps.config.catalogSize);
    if (this.closed) {
      s.stopped = 'closed';
      return this.finish(s, startedAt);
    }
    try {
      await this.refreshCandidates(s, startedAt);
      if (!(await this.halted(s, startedAt))) await this.probeAll(s, startedAt);
    } catch (err) {
      s.stopped = 'error';
      s.error = messageOf(err);
    }
    try {
      s.catalog_fresh = await this.deps.store.freshCount(this.deps.host, this.freshSince());
    } catch {
      s.catalog_fresh = null;
    }
    return this.finish(s, startedAt);
  }

  /** Rebuilds the listing when it is a day old. TMDB only: it opens no tab, so it does not wait for idle. */
  private async refreshCandidates(s: PassSummary, now: Date): Promise<void> {
    if (this.refreshFailedAt !== null && now.getTime() - this.refreshFailedAt < REFRESH_RETRY_MS) return;
    const last = await this.deps.store.listedAt(this.deps.host);
    if (last !== null && now.getTime() - last.getTime() < CANDIDATE_REFRESH_MS) return;
    const seeds = pickSeeds(await this.deps.seeds());
    const gathered = await gatherCandidates(this.deps.tmdb, seeds, now.toISOString().slice(0, 10));
    if (gathered.errors.length > 0) {
      s.error = `TMDB: ${gathered.errors.length} list(s) unread, first: ${gathered.errors[0]}`;
    }
    if (gathered.entries.length === 0) {
      // Keep the old listing rather than unlist everything because TMDB answered nothing.
      this.refreshFailedAt = now.getTime();
      return;
    }
    this.refreshFailedAt = null;
    await this.deps.store.replaceListing(this.deps.host, gathered.entries, now);
    s.listed = gathered.entries.length;
  }

  /** Asked before the first probe and before every one after it: true (s.stopped set) when the pass must stop. */
  private async halted(s: PassSummary, startedAt: Date): Promise<boolean> {
    const stop = await this.stopReason(s, startedAt);
    if (stop === null) return false;
    s.stopped = stop;
    return true;
  }

  private async stopReason(s: PassSummary, startedAt: Date): Promise<PassStop | null> {
    if (this.closed) return 'closed';
    if (s.rechecked + s.probed >= this.deps.config.probeBudget) return 'probe_budget';
    if (this.now().getTime() - startedAt.getTime() >= this.passSeconds * 1000) return 'time_budget';
    if (this.deps.vlcPlaying()) {
      s.busy = 'vlc';
      return 'busy';
    }
    if (await this.deps.store.activePlay(this.deps.host, new Date(this.now().getTime() - ACTIVE_PLAY_MS))) {
      s.busy = 'play';
      return 'busy';
    }
    const idle = await this.deps.idle();
    if (idle.kind === 'error') {
      // Fail closed: an idle time that cannot be read is never "idle".
      s.error = `idle time unreadable: ${idle.message}`;
      return 'not_idle';
    }
    s.idle_s = idle.idleSeconds;
    return idle.idleSeconds < this.deps.config.idleSeconds ? 'not_idle' : null;
  }

  private async probeAll(s: PassSummary, startedAt: Date): Promise<void> {
    const { host, store, config } = this.deps;
    const dueBefore = new Date(this.now().getTime() - RECHECK_AT_FRACTION * this.deps.freshDays * DAY_MS);
    const due = await store.dueRechecks(host, dueBefore, config.probeBudget);
    for (const [i, target] of due.entries()) {
      if (i > 0 && (await this.halted(s, startedAt))) return;
      const verdict = await this.probe(target, startedAt);
      if (verdict === 'chrome_unavailable') {
        s.stopped = 'chrome_unavailable';
        return;
      }
      if (verdict === 'deadline') {
        s.stopped = 'time_budget';
        return;
      }
      s.rechecked += 1;
      if (verdict === 'verified') s.recheck_verified += 1;
      else s.failed += 1;
    }

    const freshSince = this.freshSince();
    let fresh = await store.freshCount(host, freshSince);
    if (fresh >= config.catalogSize) {
      s.stopped = 'catalog_full';
      return;
    }
    const left = config.probeBudget - s.rechecked;
    if (left <= 0) {
      s.stopped = 'probe_budget';
      return;
    }
    const now = this.now();
    const films = await store.eligible(host, 'movie', now, freshSince, left);
    const series = await store.eligible(host, 'tv', now, freshSince, left);
    for (const target of interleave(films, series, SERIES_EVERY)) {
      if (fresh >= config.catalogSize) {
        s.stopped = 'catalog_full';
        return;
      }
      if ((s.rechecked > 0 || s.probed > 0) && (await this.halted(s, startedAt))) return;
      const verdict = await this.probe(target, startedAt);
      if (verdict === 'chrome_unavailable') {
        s.stopped = 'chrome_unavailable';
        return;
      }
      if (verdict === 'deadline') {
        s.stopped = 'time_budget';
        return;
      }
      s.probed += 1;
      if (verdict === 'verified') {
        s.probe_verified += 1;
        fresh += 1;
      } else {
        s.failed += 1;
      }
    }
    s.stopped = fresh >= config.catalogSize ? 'catalog_full' : s.rechecked + s.probed >= config.probeBudget ? 'probe_budget' : 'no_candidates';
  }

  /** One resolve, bounded by the seconds left in the pass (the budget is otherwise checked only between probes). */
  private async probe(t: ProbeTarget, startedAt: Date): Promise<ResolveVerdict> {
    const ref: ProbeRef =
      t.kind === 'tv'
        ? { kind: 'tv', tmdbId: t.tmdbId, season: t.season ?? 1, episode: t.episode ?? 1 }
        : { kind: 'movie', tmdbId: t.tmdbId };
    const elapsedS = (this.now().getTime() - startedAt.getTime()) / 1000;
    const deadlineS = Math.max(1, Math.floor(this.passSeconds - elapsedS));
    let verdict: ResolveVerdict;
    try {
      verdict = classifyResolve({ ok: true, value: await this.deps.resolve(ref, { deadlineS }) });
    } catch (error) {
      verdict = classifyResolve({ ok: false, error });
    }
    if (verdict === 'chrome_unavailable' || verdict === 'deadline') return verdict;
    const probedAt = this.now();
    const failures = verdict === 'verified' ? 0 : (await this.deps.store.failures(this.deps.host, t.kind, t.tmdbId)) + 1;
    await this.deps.store.record(this.deps.host, {
      kind: t.kind,
      tmdbId: t.tmdbId,
      outcome: verdict,
      probedAt,
      failures,
      retryAfter: retryAfter(verdict, failures, probedAt),
    });
    return verdict;
  }

  /** Stores the summary and logs one line: always for a pass that probed, listed or failed; for a quiet one only when its stop reason changed. */
  private finish(s: PassSummary, startedAt: Date): PassSummary {
    const end = this.now();
    s.finished_at = end.toISOString();
    s.seconds = Math.round((end.getTime() - startedAt.getTime()) / 100) / 10;
    this.lastPass = s;
    const quiet = s.rechecked + s.probed === 0 && s.listed === null && s.error === null;
    if (!quiet) {
      this.lastQuietStop = null;
      this.log(passLine(s));
    } else if (s.stopped !== this.lastQuietStop) {
      this.lastQuietStop = s.stopped;
      this.log(passLine(s));
    }
    return s;
  }
}

/** The owner's finished titles with their genres. Watch state comes from listTitles (state.ts), never from here. */
export async function libraryFinishedTitles(db: Db, repo: Pick<ProbeRepo, 'titleGenres'>, ctx: ReadContext): Promise<SeedTitle[]> {
  const items = await listTitles(db, { state: 'finished', sort: 'rating', limit: MAX_LIST_LIMIT }, ctx);
  const genres = await repo.titleGenres(items.map((i) => i.id));
  return items.map((i) => ({
    kind: i.kind,
    tmdbId: i.tmdb_id,
    rating: i.rating,
    finishedAt: i.finished_at,
    genres: genres.get(i.id) ?? [],
  }));
}

export interface StreamProberInput {
  config: Config;
  db: Db;
  movies: MoviesService | null;
  moviesPlayer?: MoviePlayer | null;
  /** AppDeps.directStream (phase 3): `resolve(input, { deadlineS })`. */
  directStream?: { resolve(ref: ProbeRef, options: { deadlineS?: number }): Promise<unknown> } | null;
}

/** Test seams. The daemon passes none. */
export interface StreamProberOverrides {
  idle?: IdleDetection;
  tmdb?: TmdbCatalog;
  store?: ProbeStore;
  seeds?: () => Promise<SeedTitle[]>;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * The daemon's prober. A DisabledProber unless every condition holds, checked in this order:
 * NOTESD_STREAM_PROBER=on, movies on, direct streaming on, a TMDB credential, WSL with
 * powershell.exe. The setting comes first, so with it unset or off nothing else is even looked at.
 */
export async function buildStreamProber(input: StreamProberInput, overrides: StreamProberOverrides = {}): Promise<StreamProberHandle> {
  const ds = input.config.directStream;
  if (ds === undefined || !ds.prober.enabled) return new DisabledProber('setting_off');
  const movies = input.movies;
  if (movies === null) return new DisabledProber('movies_off');
  const directStream = input.directStream ?? null;
  if (!ds.enabled || directStream === null) return new DisabledProber('direct_stream_off');
  const tmdbConfig = input.config.movies.tmdb;
  const tmdb =
    overrides.tmdb ?? (tmdbConfig.token !== null || tmdbConfig.apiKey !== null ? createTmdbClient(tmdbConfig) : null);
  if (tmdb === null) return new DisabledProber('no_tmdb');
  const idle = overrides.idle ?? (await detectIdleReader());
  if (!idle.available) return new DisabledProber(idle.reason);
  const repo = new ProbeRepo(input.db);
  const ctx: ReadContext = { host: movies.host, imageBase: tmdbConfig.imageBase };
  const player = input.moviesPlayer ?? null;
  return new StreamProber({
    config: ds.prober,
    freshDays: ds.freshDays,
    host: movies.host,
    store: overrides.store ?? repo,
    tmdb,
    seeds: overrides.seeds ?? (() => libraryFinishedTitles(input.db, repo, ctx)),
    resolve: (ref, options) => directStream.resolve(ref, options),
    idle: idle.read,
    vlcPlaying: () => player !== null && player.current() !== null,
    now: overrides.now,
    log: overrides.log,
  });
}
