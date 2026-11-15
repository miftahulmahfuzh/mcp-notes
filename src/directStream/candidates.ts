import type { StreamProbeListSource } from '../db/schema.js';
import { TmdbError, type TitleKind, type TmdbCatalog, type TmdbSearchHit } from '../movies/tmdb.js';

/**
 * Which TMDB titles the prober may try to verify, in what order (direct streaming phase 10). Pure
 * except gatherCandidates, which reads TMDB only. Nothing here opens Chrome.
 *
 * Sources, in the order each round of the merge takes from them: `recommended` (TMDB's
 * recommendations for the owner's finished, highly rated titles), `genre` (discover over the
 * owner's most common genres), `trending` (this week), `popular`. Films and series are ranked
 * separately; the prober interleaves them.
 */

export const CANDIDATE_SOURCE_ORDER: readonly StreamProbeListSource[] = ['recommended', 'genre', 'trending', 'popular'];
/** Seed titles whose recommendations are read. */
export const MAX_SEEDS = 20;
/** A finished title rated this or higher is a seed before any unrated one; rated lower, it is none. */
export const MIN_SEED_RATING = 4;
/** Genres discovered per kind. */
export const GENRES_PER_KIND = 3;
/** Pages of trending and of popular per kind (20 titles a page). */
export const LIST_PAGES = 2;
/** The listing is rebuilt at most this often. */
export const CANDIDATE_REFRESH_MS = 24 * 60 * 60_000;

export interface SeedTitle {
  kind: TitleKind;
  tmdbId: number;
  /** The owner's 0-5 rating; null when unrated. */
  rating: number | null;
  /** ISO 8601, when the title became finished; null when unknown. */
  finishedAt: string | null;
  /** TMDB genre names stored on the title. */
  genres: string[];
}

export interface ListedCandidate {
  kind: TitleKind;
  tmdbId: number;
  source: StreamProbeListSource;
  /** 0-based position among the candidates of its kind; lower is probed first. */
  rank: number;
}

export interface GatheredCandidates {
  entries: ListedCandidate[];
  /** One line per TMDB list that could not be read. The lists that were read still count. */
  errors: string[];
}

/** Rated 4-5 first (higher rating, then newer finish), then unrated (newer finish first). At most `max`. */
export function pickSeeds(finished: readonly SeedTitle[], max: number = MAX_SEEDS): SeedTitle[] {
  const newerFirst = (a: SeedTitle, b: SeedTitle): number => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '');
  const rated = finished
    .filter((t) => t.rating !== null && t.rating >= MIN_SEED_RATING)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || newerFirst(a, b));
  const unrated = finished.filter((t) => t.rating === null).sort(newerFirst);
  return [...rated, ...unrated].slice(0, max);
}

/** Genre names by how many seeds carry them, most first (ties by name). */
export function topGenres(seeds: readonly SeedTitle[]): string[] {
  const counts = new Map<string, number>();
  for (const s of seeds) for (const g of new Set(s.genres)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
}

/** One item from each list in turn until every list is spent; an item whose key was seen is skipped. */
export function roundRobin<T>(lists: ReadonlyArray<readonly T[]>, key: (item: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item === undefined) continue;
      const k = key(item);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

/** TMDB says the title is out by `today` (YYYY-MM-DD). A title with no date is not. */
export function released(hit: TmdbSearchHit, today: string): boolean {
  return hit.releaseDate !== null && hit.releaseDate <= today;
}

/**
 * The ranked candidates of one kind. Each source's lists are merged round-robin (one
 * recommendation list per seed, one discover list per genre), then the sources are merged
 * round-robin in CANDIDATE_SOURCE_ORDER. Unreleased titles and titles of the other kind are dropped,
 * each title is kept once, under the first source that reached it.
 */
export function rankKind(
  kind: TitleKind,
  bySource: Readonly<Record<StreamProbeListSource, ReadonlyArray<readonly TmdbSearchHit[]>>>,
  today: string,
): ListedCandidate[] {
  const tagged = CANDIDATE_SOURCE_ORDER.map((source) =>
    roundRobin(bySource[source], (h) => String(h.tmdbId))
      .filter((h) => h.kind === kind && released(h, today))
      .map((h) => ({ tmdbId: h.tmdbId, source })),
  );
  return roundRobin(tagged, (c) => String(c.tmdbId)).map((c, rank) => ({ kind, tmdbId: c.tmdbId, source: c.source, rank }));
}

/**
 * Reads every list, sequentially, and ranks films and series. A TmdbError on one list is recorded
 * in `errors` and that list counts as empty; any other error is thrown.
 */
export async function gatherCandidates(tmdb: TmdbCatalog, seeds: readonly SeedTitle[], today: string): Promise<GatheredCandidates> {
  const errors: string[] = [];
  async function read(what: string, call: () => Promise<TmdbSearchHit[]>): Promise<TmdbSearchHit[]> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof TmdbError)) throw err;
      errors.push(`${what}: ${err.message}`);
      return [];
    }
  }
  const genreNames = topGenres(seeds);
  const entries: ListedCandidate[] = [];
  for (const kind of ['movie', 'tv'] as const) {
    const trending: TmdbSearchHit[] = [];
    const popular: TmdbSearchHit[] = [];
    for (let page = 1; page <= LIST_PAGES; page++) {
      trending.push(...(await read(`${kind} trending page ${page}`, () => tmdb.list('trending', kind, page))));
      popular.push(...(await read(`${kind} popular page ${page}`, () => tmdb.list('popular', kind, page))));
    }
    const genre: TmdbSearchHit[][] = [];
    if (genreNames.length > 0) {
      let ids: number[] = [];
      try {
        const known = new Map((await tmdb.genres(kind)).map((g) => [g.name.toLowerCase(), g.id] as const));
        ids = genreNames
          .map((n) => known.get(n.toLowerCase()))
          .filter((id): id is number => id !== undefined)
          .slice(0, GENRES_PER_KIND);
      } catch (err) {
        if (!(err instanceof TmdbError)) throw err;
        errors.push(`${kind} genre list: ${err.message}`);
      }
      for (const id of ids) genre.push(await read(`${kind} genre ${id}`, () => tmdb.discoverByGenre(kind, id, 1)));
    }
    const recommended: TmdbSearchHit[][] = [];
    for (const seed of seeds) {
      if (seed.kind !== kind) continue;
      recommended.push(await read(`${kind} ${seed.tmdbId} recommendations`, () => tmdb.recommendations(kind, seed.tmdbId, 1)));
    }
    entries.push(...rankKind(kind, { recommended, genre, trending: [trending], popular: [popular] }, today));
  }
  return { entries, errors };
}
