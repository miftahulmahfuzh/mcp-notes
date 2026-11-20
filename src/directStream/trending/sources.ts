import { isUsableHash, normalizeInfoHash, normalizeImdbId } from '../torrent/find/candidate.js';
import { asCount, asList, asRecord, asText, getIndexJson } from '../torrent/find/http.js';
import { DEFAULT_INDEX_BASES, TORRENT_INDEX_USER_AGENT } from '../torrent/find/find.js';
import { parseRelease } from '../torrent/find/release.js';
import { DEFAULT_MAX_SIZE_BYTES, DEFAULT_MIN_SEEDS } from '../torrent/find/rank.js';
import type { FetchLike, IndexContext, IndexOutcome } from '../torrent/find/types.js';

/**
 * Where the daily trending list comes from: the top-seeded listings the torrent indexes already published
 * (apibay's precompiled top 100 of each category, EZTV's newest episodes), read with plain requests that say
 * they are notesd, as the finder reads them for a play. A listing is only a claim: its seed count is what the
 * index says, which the swarm probe (job.ts) checks for the few that are shown. Nothing here reads settings.
 */

/** apibay's precompiled lists: 201 movies, 207 HD movies, 205 TV, 208 HD TV. */
export const APIBAY_TOP_CATEGORIES = { movie: [201, 207], tv: [205, 208] } as const;
/** EZTV lists newest first, 100 a page; its popular shows are among the newest 300. */
export const TRENDING_EZTV_PAGES = 3;
const EZTV_PAGE_LIMIT = 100;
const INDEX_TIMEOUT_MS = 15_000;

export type TrendKind = 'movie' | 'tv';

/** One listed torrent that names an IMDb id (a series' episode names its series). */
export interface TrendRow {
  kind: TrendKind;
  imdbId: string;
  infoHash: string;
  name: string;
  seeds: number;
  sizeBytes: number | null;
  index: string;
}

export interface TrendSourceAttempt {
  index: string;
  outcome: IndexOutcome;
  detail: string;
  listed: number;
}

export interface FetchedTrends {
  rows: TrendRow[];
  attempts: TrendSourceAttempt[];
}

export interface TrendSourceOptions {
  fetch?: FetchLike;
  /** The finder's addresses; `null` never asks that index. */
  apibay?: string | null;
  eztv?: string | null;
  userAgent?: string;
  signal?: AbortSignal;
}

function readApibay(value: unknown, kind: TrendKind): TrendRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.info_hash);
  const name = asText(row?.name);
  const imdbId = normalizeImdbId(asText(row?.imdb) ?? '');
  if (row === null || infoHash === null || name === null || imdbId === null) return null;
  return { kind, imdbId, infoHash, name, seeds: asCount(row.seeders) ?? 0, sizeBytes: asCount(row.size), index: 'apibay' };
}

function readEztv(value: unknown): TrendRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.hash);
  const name = asText(row?.title);
  const imdbId = normalizeImdbId(asText(row?.imdb_id) ?? '');
  if (row === null || infoHash === null || name === null || imdbId === null) return null;
  return { kind: 'tv', imdbId, infoHash, name, seeds: asCount(row.seeds) ?? 0, sizeBytes: asCount(row.size_bytes), index: 'eztv' };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every listing the indexes give now. An index that fails is an attempt with its outcome and detail; the others still count. */
export async function fetchTrends(options: TrendSourceOptions = {}): Promise<FetchedTrends> {
  const doFetch = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? TORRENT_INDEX_USER_AGENT;
  const rows: TrendRow[] = [];
  const attempts: TrendSourceAttempt[] = [];

  const ctxFor = (signal: AbortSignal): IndexContext => ({
    signal,
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('accept', 'application/json');
      headers.set('user-agent', userAgent);
      return doFetch(url, { headers, signal });
    },
  });

  /** One index, several requests: its rows are kept even when a later request fails. */
  const ask = async (index: string, run: (ctx: IndexContext) => Promise<{ listed: TrendRow[]; outcome: IndexOutcome; detail: string }>): Promise<void> => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), INDEX_TIMEOUT_MS * 3);
    try {
      const got = await run(ctxFor(controller.signal));
      rows.push(...got.listed);
      attempts.push({ index, outcome: got.outcome, detail: got.detail, listed: got.listed.length });
    } catch (err) {
      attempts.push({ index, outcome: 'error', detail: errorText(err), listed: 0 });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  };

  const apibay = options.apibay === undefined ? DEFAULT_INDEX_BASES.apibay : options.apibay;
  const eztv = options.eztv === undefined ? DEFAULT_INDEX_BASES.eztv : options.eztv;
  await Promise.all([
    apibay === null
      ? undefined
      : ask('apibay', async (ctx) => {
          const listed: TrendRow[] = [];
          let failure: { outcome: IndexOutcome; detail: string } | null = null;
          for (const kind of ['movie', 'tv'] as const) {
            for (const category of APIBAY_TOP_CATEGORIES[kind]) {
              const got = await getIndexJson(ctx, `${apibay.replace(/\/+$/, '')}/precompiled/data_top100_${category}.json`);
              if (!got.ok) {
                failure ??= { outcome: got.outcome, detail: `category ${category}: ${got.detail}` };
                continue;
              }
              for (const value of asList(got.json) ?? []) {
                const row = readApibay(value, kind);
                if (row !== null) listed.push(row);
              }
            }
          }
          return listed.length > 0 || failure === null
            ? { listed, outcome: listed.length > 0 ? 'ok' : 'empty', detail: failure === null ? `${listed.length} listed` : `${listed.length} listed; ${failure.detail}` }
            : { listed, ...failure };
        }),
    eztv === null
      ? undefined
      : ask('eztv', async (ctx) => {
          const listed: TrendRow[] = [];
          for (let page = 1; page <= TRENDING_EZTV_PAGES; page++) {
            const got = await getIndexJson(ctx, `${eztv.replace(/\/+$/, '')}/api/get-torrents?limit=${EZTV_PAGE_LIMIT}&page=${page}`);
            if (!got.ok) {
              if (page === 1) return { listed, outcome: got.outcome, detail: got.detail };
              break;
            }
            const list = asList(asRecord(got.json)?.torrents) ?? [];
            for (const value of list) {
              const row = readEztv(value);
              if (row !== null) listed.push(row);
            }
            if (list.length < EZTV_PAGE_LIMIT) break;
          }
          return { listed, outcome: listed.length > 0 ? 'ok' : 'empty', detail: `${listed.length} listed` };
        }),
  ]);
  return { rows, attempts };
}

/** The listing of one title (a film, or a series by its best-seeded episode or pack) that goes on the trending list. */
export interface TrendTitle {
  kind: TrendKind;
  imdbId: string;
  infoHash: string;
  name: string;
  seeds: number;
  sizeBytes: number | null;
  index: string;
  height: number | null;
}

export interface SelectOptions {
  minSeeds?: number;
  maxSizeBytes?: number;
}

/**
 * One entry per IMDb id: the best-seeded listing that is not a cinema recording, a dub or a 3D release, with
 * enough seeds and a usable hash, most seeded first. A series is its best-seeded episode or pack (the swarm
 * that is most alive tells how alive the series is). A film's single file larger than the finder's cap is left out.
 */
export function selectTrends(rows: readonly TrendRow[], options: SelectOptions = {}): TrendTitle[] {
  const minSeeds = options.minSeeds ?? DEFAULT_MIN_SEEDS;
  const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const best = new Map<string, TrendTitle>();
  for (const row of rows) {
    const infoHash = normalizeInfoHash(row.infoHash);
    if (!isUsableHash(infoHash) || row.seeds < minSeeds) continue;
    const release = parseRelease(row.name, {});
    if (release.cam || release.dubbed || release.threeD) continue;
    if (row.kind === 'movie' && row.sizeBytes !== null && row.sizeBytes > maxSize) continue;
    const key = `${row.kind}:${row.imdbId}`;
    const held = best.get(key);
    if (held !== undefined && held.seeds >= row.seeds) continue;
    best.set(key, { kind: row.kind, imdbId: row.imdbId, infoHash, name: row.name, seeds: row.seeds, sizeBytes: row.sizeBytes, index: row.index, height: release.height });
  }
  return [...best.values()].sort((a, b) => b.seeds - a.seeds || a.imdbId.localeCompare(b.imdbId));
}
