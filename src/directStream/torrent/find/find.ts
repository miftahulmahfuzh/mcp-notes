import { apibayIndex } from './apibay.js';
import { bitsearchIndex } from './bitsearch.js';
import { normalizeImdbId } from './candidate.js';
import { eztvIndex } from './eztv.js';
import { knabenIndex } from './knaben.js';
import { peerflixIndex } from './peerflix.js';
import { DEFAULT_RANK_SETTINGS, rankCandidates, type RankSettings } from './rank.js';
import { torrentioIndex } from './torrentio.js';
import { torrentscsvIndex } from './torrentscsv.js';
import { torrentsdbIndex } from './torrentsdb.js';
import { ytsIndex } from './yts.js';
import type { FetchLike, FoundCandidates, IndexAnswer, IndexAttempt, IndexContext, IndexOutcome, TorrentCandidate, TorrentIndex, TorrentQuery } from './types.js';

/**
 * Asks the JSON torrent indexes for a film or one episode by IMDb id and answers ranked candidates
 * (TORRENT_STREAM_SOURCE_PLAN phase 2). Reads no settings: phase 3 maps them onto FindOptions.
 * Every request says it is notesd; a bot check is the outcome `bot_check`, never worked around.
 */

/** Sent as the User-Agent of every index request; an index cannot replace it. */
export const TORRENT_INDEX_USER_AGENT = 'notesd (personal notes daemon; torrent index lookup)';
export const DEFAULT_INDEX_TIMEOUT_MS = 10_000;
/** Candidates answered at most (phase 3 keeps the rest for the shuffle button). */
export const DEFAULT_MAX_CANDIDATES = 20;

/** An index that failed or timed out this many plays in a row is left out for INDEX_COOL_DOWN_MS. */
export const INDEX_FAILURES_TO_SKIP = 3;
export const INDEX_COOL_DOWN_MS = 30 * 60_000;

/**
 * What the finder remembers of each index between plays, in memory (one per daemon run): how many times in a row
 * it answered `error` (a timeout or a failure), and until when it is left out. An index that listed something, or
 * nothing, starts from zero again. A bot check is never counted and never skipped: it stays the answer `bot_check`.
 * After the cool-down the index is asked again; one more failure leaves it out for another cool-down.
 */
export class IndexHealth {
  private readonly failures = new Map<string, number>();
  private readonly until = new Map<string, number>();

  constructor(
    private readonly options: { failures?: number; coolDownMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Why the index is not asked now, or null. */
  skipReason(name: string): string | null {
    const until = this.until.get(name);
    if (until === undefined) return null;
    const leftMs = until - this.now();
    if (leftMs <= 0) {
      this.until.delete(name);
      return null;
    }
    return `not asked: it failed or timed out ${this.failures.get(name) ?? 0} times in a row; asked again in ${Math.max(1, Math.ceil(leftMs / 60_000))} min`;
  }

  record(name: string, outcome: IndexOutcome): void {
    if (outcome === 'ok' || outcome === 'empty') {
      this.failures.delete(name);
      return;
    }
    if (outcome !== 'error') return;
    const count = (this.failures.get(name) ?? 0) + 1;
    this.failures.set(name, count);
    if (count >= (this.options.failures ?? INDEX_FAILURES_TO_SKIP)) this.until.set(name, this.now() + (this.options.coolDownMs ?? INDEX_COOL_DOWN_MS));
  }
}

export interface IndexBases {
  torrentio: string;
  apibay: string;
  eztv: string;
  /** Up to and including `/api/v2`. */
  yts: string;
  /** A Stremio add-on, like Torrentio. */
  torrentsdb: string;
  /** A Stremio add-on of Spanish releases, asked only for a title made in Spanish. */
  peerflix: string;
  /** Asked by title with a JSON POST (find/titleSearch.ts). */
  knaben: string;
  /** Up to and including `/api/v1`. Asked by title. */
  bitsearch: string;
  /** Up to and including `/service`. Asked by title. */
  torrentscsv: string;
}

export const DEFAULT_INDEX_BASES: Readonly<IndexBases> = {
  torrentio: 'https://torrentio.strem.fun',
  apibay: 'https://apibay.org',
  eztv: 'https://eztvx.to',
  yts: 'https://yts.mx/api/v2',
  torrentsdb: 'https://torrentsdb.com',
  peerflix: 'https://addon.peerflix.mov',
  knaben: 'https://api.knaben.org/v1',
  bitsearch: 'https://bitsearch.to/api/v1',
  torrentscsv: 'https://torrents-csv.com/service',
};

export interface FindOptions extends Partial<RankSettings> {
  /** Default: the global fetch. Tests pass a fake; nothing here touches the network otherwise. */
  fetch?: FetchLike;
  /** Default: defaultIndexes(options). */
  indexes?: readonly TorrentIndex[];
  /**
   * Asked side by side, only when `indexes` leave no usable candidate (phase 9: 1337x and ext.to through the streaming
   * Chrome). Each is given its own `timeoutMs` when it has one, even a longer one than `timeoutMs`.
   */
  fallback?: readonly TorrentIndex[];
  bases?: Partial<IndexBases>;
  /** Ask YTS (films only). Default true. */
  yts?: boolean;
  /** Per index. Default DEFAULT_INDEX_TIMEOUT_MS; an index's own shorter limit wins. */
  timeoutMs?: number;
  maxCandidates?: number;
  /** Default TORRENT_INDEX_USER_AGENT; phase 3 may pass one with the daemon's version. */
  userAgent?: string;
  signal?: AbortSignal;
  /**
   * Info hashes already tried for this title (the torrent source's memory of failed torrents). The fallback indexes
   * are also asked when every kept candidate is one of them: the JSON indexes have nothing new left.
   */
  tried?: ReadonlySet<string>;
  /** The indexes' failures between plays; an index it leaves out is a `skipped` attempt. Unset: every index is asked every time. */
  health?: IndexHealth;
}

/**
 * Torrentio, apibay, EZTV, TorrentsDB, Peerflix (it asks only for a title made in Spanish), and YTS unless `yts` is
 * false, all asked by IMDb id; then Knaben, Bitsearch and torrents-csv, asked by title (find/titleSearch.ts).
 */
export function defaultIndexes(options: Pick<FindOptions, 'bases' | 'yts'> = {}): TorrentIndex[] {
  const bases = options.bases ?? {};
  const indexes = [
    torrentioIndex(bases.torrentio ?? DEFAULT_INDEX_BASES.torrentio),
    apibayIndex(bases.apibay ?? DEFAULT_INDEX_BASES.apibay),
    eztvIndex(bases.eztv ?? DEFAULT_INDEX_BASES.eztv),
    torrentsdbIndex(bases.torrentsdb ?? DEFAULT_INDEX_BASES.torrentsdb),
    peerflixIndex(bases.peerflix ?? DEFAULT_INDEX_BASES.peerflix),
  ];
  if (options.yts !== false) indexes.push(ytsIndex(bases.yts ?? DEFAULT_INDEX_BASES.yts));
  // Asked by title, not by IMDb id (titleSearch.ts); each answers `empty` without a request for a title with no name or a film with no year.
  indexes.push(
    knabenIndex(bases.knaben ?? DEFAULT_INDEX_BASES.knaben),
    bitsearchIndex(bases.bitsearch ?? DEFAULT_INDEX_BASES.bitsearch),
    torrentscsvIndex(bases.torrentscsv ?? DEFAULT_INDEX_BASES.torrentscsv),
  );
  return indexes;
}

interface AskSettings {
  fetch: FetchLike;
  userAgent: string;
  timeoutMs: number;
  signal: AbortSignal | null;
  health: IndexHealth | null;
}

interface Asked {
  attempts: IndexAttempt[];
  candidates: TorrentCandidate[];
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

async function askOne(index: TorrentIndex, query: TorrentQuery, run: AskSettings): Promise<{ attempt: IndexAttempt; candidates: TorrentCandidate[] }> {
  const skip = run.health?.skipReason(index.name) ?? null;
  if (skip !== null) return { attempt: { index: index.name, outcome: 'skipped', detail: skip, took_s: 0, listed: 0 }, candidates: [] };
  const started = Date.now();
  const limitMs = Math.min(index.timeoutMs ?? run.timeoutMs, run.timeoutMs);
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  run.signal?.addEventListener('abort', onParentAbort, { once: true });
  if (run.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<IndexAnswer>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ outcome: 'error', detail: `timed out after ${seconds(limitMs)} s`, candidates: [] });
    }, limitMs);
  });
  const ctx: IndexContext = {
    signal: controller.signal,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      // Set last: whatever headers an index passes, every request says it is notesd.
      headers.set('user-agent', run.userAgent);
      return run.fetch(url, {
        ...(init?.method === undefined ? {} : { method: init.method }),
        headers,
        ...(init?.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
    },
  };
  let answer: IndexAnswer;
  try {
    answer = await Promise.race([index.find(query, ctx), timedOut]);
  } catch (err) {
    answer = { outcome: 'error', detail: run.signal?.aborted ? 'aborted' : errorText(err), candidates: [] };
  } finally {
    clearTimeout(timer);
    run.signal?.removeEventListener('abort', onParentAbort);
  }
  // A caller that gave up says nothing of the index.
  if (!run.signal?.aborted) run.health?.record(index.name, answer.outcome);
  return {
    attempt: { index: index.name, outcome: answer.outcome, detail: answer.detail, took_s: seconds(Date.now() - started), listed: answer.candidates.length },
    candidates: answer.candidates,
  };
}

async function askAll(indexes: readonly TorrentIndex[], query: TorrentQuery, run: AskSettings): Promise<Asked> {
  const answers = await Promise.all(indexes.map((index) => askOne(index, query, run)));
  return { attempts: answers.map((a) => a.attempt), candidates: answers.flatMap((a) => a.candidates) };
}

export async function findCandidates(query: TorrentQuery, options: FindOptions = {}): Promise<FoundCandidates> {
  // No IMDb id: the indexes keyed by it answer `empty` without a request; the ones asked by title go on.
  const imdbId = query.imdbId === null ? null : normalizeImdbId(query.imdbId);
  if (query.imdbId !== null && imdbId === null) throw new RangeError(`not an IMDb id: ${query.imdbId}`);
  const asked: TorrentQuery = { ...query, imdbId };
  const settings: RankSettings = {
    minSeeds: options.minSeeds ?? DEFAULT_RANK_SETTINGS.minSeeds,
    goodSeeds: options.goodSeeds ?? DEFAULT_RANK_SETTINGS.goodSeeds,
    maxSizeBytes: options.maxSizeBytes ?? DEFAULT_RANK_SETTINGS.maxSizeBytes,
  };
  const run: AskSettings = {
    fetch: options.fetch ?? fetch,
    userAgent: options.userAgent ?? TORRENT_INDEX_USER_AGENT,
    timeoutMs: options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
    signal: options.signal ?? null,
    health: options.health ?? null,
  };
  const forKind = (list: readonly TorrentIndex[]): TorrentIndex[] => list.filter((i) => i.kinds === undefined || i.kinds.includes(asked.kind));

  const first = await askAll(forKind(options.indexes ?? defaultIndexes(options)), asked, run);
  let attempts = first.attempts;
  let found = first.candidates;
  let ranked = rankCandidates(found, asked, settings);
  const fallback = forKind(options.fallback ?? []);
  const tried = options.tried ?? new Set<string>();
  if (ranked.kept.every((c) => tried.has(c.infoHash)) && fallback.length > 0) {
    // A fallback index (a browser-driven site) keeps its own, longer limit.
    const second = await askAll(fallback, asked, { ...run, timeoutMs: Math.max(run.timeoutMs, ...fallback.map((i) => i.timeoutMs ?? 0)) });
    attempts = [...attempts, ...second.attempts];
    found = [...found, ...second.candidates];
    ranked = rankCandidates(found, asked, settings);
  }
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  return { candidates: ranked.kept.slice(0, max), indexes: attempts, excluded: ranked.excluded, lastResort: ranked.lastResort.slice(0, max) };
}
