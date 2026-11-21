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
import type { FetchLike, FoundCandidates, IndexAnswer, IndexAttempt, IndexContext, IndexOutcome, TorrentCandidate, TorrentIndex, TorrentQuery } from './types.js';

/**
 * Asks the JSON torrent indexes for a film or one episode by IMDb id and answers ranked candidates
 * (TORRENT_STREAM_SOURCE_PLAN phase 2). Reads no settings: phase 3 maps them onto FindOptions.
 * Every index request carries notesd's User-Agent; a bot check is the outcome `bot_check`.
 */

/** Sent as the User-Agent of every index request; an index cannot replace it. */
export const TORRENT_INDEX_USER_AGENT = 'notesd (personal notes daemon; torrent index lookup)';
export const DEFAULT_INDEX_TIMEOUT_MS = 10_000;
/** Candidates answered at most (phase 3 keeps the rest for the shuffle button). */
export const DEFAULT_MAX_CANDIDATES = 20;

/** A connection to an index that failed at once is asked again after this long (once). */
export const INDEX_RETRY_MS = 1_000;

/** Node's fetch failing before any answer (`TypeError: fetch failed`, with the socket's error as its cause). */
function isConnectFailure(err: unknown): boolean {
  return err instanceof TypeError && err.message === 'fetch failed';
}

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
 * Torrentio, apibay, EZTV, TorrentsDB and Peerflix (asked only for a title made in Spanish), all asked by IMDb id;
 * then Knaben, Bitsearch and torrents-csv, asked by title (find/titleSearch.ts). YTS has no index of its own:
 * Torrentio lists its releases.
 */
export function defaultIndexes(options: Pick<FindOptions, 'bases'> = {}): TorrentIndex[] {
  const bases = options.bases ?? {};
  const indexes: TorrentIndex[] = [
    torrentioIndex(bases.torrentio ?? DEFAULT_INDEX_BASES.torrentio),
    apibayIndex(bases.apibay ?? DEFAULT_INDEX_BASES.apibay),
    eztvIndex(bases.eztv ?? DEFAULT_INDEX_BASES.eztv),
    torrentsdbIndex(bases.torrentsdb ?? DEFAULT_INDEX_BASES.torrentsdb),
    peerflixIndex(bases.peerflix ?? DEFAULT_INDEX_BASES.peerflix),
  ];
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

/**
 * An index's failure as words. Node's fetch says only `fetch failed`; the cause carries the code (`ECONNRESET`,
 * `EAI_AGAIN`), and a connection tried on several addresses fails with an AggregateError whose message is empty.
 */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (!(cause instanceof Error)) return err.message;
  const code = (e: unknown): string => (typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '');
  const parts = cause instanceof AggregateError ? [...new Set(cause.errors.map((e) => code(e) || (e instanceof Error ? e.message : String(e))))] : [[code(cause), cause.message].filter((x) => x !== '').join(' ')];
  const said = parts.filter((x) => x !== '').join(', ');
  return said === '' ? err.message : `${err.message}: ${said}`;
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
      // Set last: whatever headers an index passes, the User-Agent is notesd's.
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
    try {
      answer = await Promise.race([index.find(query, ctx), timedOut]);
    } catch (err) {
      // A connection that failed at once (`fetch failed`, before any answer) is asked once more after a moment, within
      // the index's time: on this machine the index requests of a play's first second failed together, now and then.
      if (!isConnectFailure(err) || controller.signal.aborted || Date.now() - started > limitMs - INDEX_RETRY_MS - 1_000) throw err;
      await new Promise((resolve) => setTimeout(resolve, INDEX_RETRY_MS));
      if (controller.signal.aborted) throw err;
      answer = await Promise.race([index.find(query, ctx), timedOut]);
      if (answer.outcome !== 'error') answer = { ...answer, detail: `${answer.detail} (asked again after ${errorText(err)})` };
    }
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
  // An index not asked for this title (Peerflix for a title not made in Spanish) gets no request and no attempt.
  const forKind = (list: readonly TorrentIndex[]): TorrentIndex[] =>
    list.filter((i) => (i.kinds === undefined || i.kinds.includes(asked.kind)) && i.asks?.(asked) !== false);

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
