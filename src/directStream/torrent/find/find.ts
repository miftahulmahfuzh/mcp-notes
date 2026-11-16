import { apibayIndex } from './apibay.js';
import { normalizeImdbId } from './candidate.js';
import { eztvIndex } from './eztv.js';
import { DEFAULT_RANK_SETTINGS, rankCandidates, type RankSettings } from './rank.js';
import { torrentioIndex } from './torrentio.js';
import { ytsIndex } from './yts.js';
import type { FetchLike, FoundCandidates, IndexAnswer, IndexAttempt, IndexContext, TorrentCandidate, TorrentIndex, TorrentQuery } from './types.js';

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

export interface IndexBases {
  torrentio: string;
  apibay: string;
  eztv: string;
  /** Up to and including `/api/v2`. */
  yts: string;
}

export const DEFAULT_INDEX_BASES: Readonly<IndexBases> = {
  torrentio: 'https://torrentio.strem.fun',
  apibay: 'https://apibay.org',
  eztv: 'https://eztvx.to',
  yts: 'https://yts.mx/api/v2',
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
}

/** Torrentio, apibay, EZTV, and YTS unless `yts` is false. */
export function defaultIndexes(options: Pick<FindOptions, 'bases' | 'yts'> = {}): TorrentIndex[] {
  const bases = options.bases ?? {};
  const indexes = [
    torrentioIndex(bases.torrentio ?? DEFAULT_INDEX_BASES.torrentio),
    apibayIndex(bases.apibay ?? DEFAULT_INDEX_BASES.apibay),
    eztvIndex(bases.eztv ?? DEFAULT_INDEX_BASES.eztv),
  ];
  if (options.yts !== false) indexes.push(ytsIndex(bases.yts ?? DEFAULT_INDEX_BASES.yts));
  return indexes;
}

interface AskSettings {
  fetch: FetchLike;
  userAgent: string;
  timeoutMs: number;
  signal: AbortSignal | null;
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
      headers.set('user-agent', run.userAgent);
      return run.fetch(url, { headers, signal: controller.signal });
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
  const imdbId = normalizeImdbId(query.imdbId);
  if (imdbId === null) throw new RangeError(`not an IMDb id: ${query.imdbId}`);
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
  };
  const forKind = (list: readonly TorrentIndex[]): TorrentIndex[] => list.filter((i) => i.kinds === undefined || i.kinds.includes(asked.kind));

  const first = await askAll(forKind(options.indexes ?? defaultIndexes(options)), asked, run);
  let attempts = first.attempts;
  let found = first.candidates;
  let ranked = rankCandidates(found, asked, settings);
  const fallback = forKind(options.fallback ?? []);
  if (ranked.kept.length === 0 && fallback.length > 0) {
    // A fallback index (a browser-driven site) keeps its own, longer limit.
    const second = await askAll(fallback, asked, { ...run, timeoutMs: Math.max(run.timeoutMs, ...fallback.map((i) => i.timeoutMs ?? 0)) });
    attempts = [...attempts, ...second.attempts];
    found = [...found, ...second.candidates];
    ranked = rankCandidates(found, asked, settings);
  }
  return { candidates: ranked.kept.slice(0, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES), indexes: attempts, excluded: ranked.excluded };
}
