import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { movieEpisodes, movieIds, movieTitles } from '../db/schema.js';
import { normalizeMovieId, resolveMovieId } from '../movies/ids.js';
import { TmdbError, type TmdbClient, type TmdbSearchHit, type TmdbTitleNames } from '../movies/tmdb.js';
import { titleId, type TitleKind } from '../movies/types.js';
import { isSameTitle, normalizeName, type TitleQuery } from './match.js';
import type { StreamRef } from './types.js';

/** Candidates an answer lists at most. */
export const LOOKUP_MAX_CANDIDATES = 10;
/** Near misses a `none` answer lists at most. */
export const LOOKUP_MAX_NEAR_MISSES = 5;
/** TMDB hits whose alternative titles are read when no name matches (one request each). */
export const ALTERNATIVE_TITLE_HITS = 5;
/** Stored titles the loose SQL pre-filter hands to the exact rule. */
const LIBRARY_SCAN_LIMIT = 50;
/** A title key: movie-550, tv-1399 (any case). */
const TITLE_KEY = /^(movie|tv)-(\d+)$/i;

/**
 * What to stream: a film, or one episode of a series. A series without an episode cannot be built.
 * Phase 3's StreamRef (src/directStream/types.ts), named here for the lookup's readers.
 */
export type StreamTarget = StreamRef;

/** The movie_titles key of a target's title (movie-550, tv-1399). */
export function targetKey(target: StreamTarget): string {
  return titleId(target.kind, target.tmdbId);
}

export interface EpisodePick {
  season: number;
  episode: number;
}

export interface SeasonCount {
  season: number;
  episodes: number;
}

/** One title the words may mean. */
export interface TitleCandidate {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  /** The title's movie id (M-23T4) when a movie_titles row exists for it; null for a TMDB-only hit. */
  movieId: string | null;
  /** A stored title's other names as the owner uses them, normalized (movie_titles.aliases). */
  aliases?: readonly string[];
}

/** What the tool was given, read once at the boundary by parseTitleRequest. */
export type LookupRequest =
  | { by: 'id'; text: string }
  | { by: 'words'; name: string; year: number | null; kind: TitleKind | null };

export type LookupResult =
  | { status: 'one'; candidate: TitleCandidate; /** Set when a movie id named one episode. */ episode: EpisodePick | null }
  | { status: 'several'; candidates: TitleCandidate[]; source: 'library' | 'tmdb' }
  | { status: 'none'; /** Titles close to the words, none of them the asked name: for "did you mean", never played unasked. */ nearMisses: TitleCandidate[] };

/** The stored titles, read-only. dbTitleLibrary is the real one; tests pass a fake. */
export interface TitleLibrary {
  /** movie_titles rows whose name or synopsis contains the words, or that have them as an alias: a loose pre-filter, the exact rule decides. */
  search(name: string, kind: TitleKind | null): Promise<TitleCandidate[]>;
  /** One stored title, or null. */
  byKey(kind: TitleKind, tmdbId: number): Promise<TitleCandidate | null>;
  /** What a movie id names (a title, or one episode of it), or null when no row has that id. */
  byMovieId(movieId: string): Promise<{ kind: TitleKind; tmdbId: number; episode: EpisodePick | null } | null>;
  /** Episodes per season (season 1 and up) from movie_episodes; [] when none are stored. */
  seasons(kind: TitleKind, tmdbId: number): Promise<SeasonCount[]>;
}

export interface LookupDeps {
  library: TitleLibrary;
  /** Null without TMDB credentials: only stored titles can be found. Without `alternativeTitles`, only names match. */
  tmdb: LookupTmdb | null;
}

/** What the lookup asks of TMDB; createTmdbClient's client has all of it. */
export type LookupTmdb = Pick<TmdbClient, 'searchMovie' | 'searchTv'> & Partial<TmdbTitleNames>;

/** A lookup that cannot answer: the tool result reads `<code>: <message>`. */
export class LookupError extends Error {
  override readonly name = 'LookupError';
  constructor(
    readonly code: 'not_found' | 'tmdb_unavailable' | 'invalid_input',
    message: string,
  ) {
    super(message);
  }
}

/** Reads what the tool was given: a movie id or title key is an id, anything else is words. */
export function parseTitleRequest(title: string, year: number | null, kind: TitleKind | null): LookupRequest {
  const text = title.trim();
  if (normalizeMovieId(text) !== null || TITLE_KEY.test(text)) return { by: 'id', text };
  return { by: 'words', name: text, year, kind };
}

function fromHit(hit: TmdbSearchHit): TitleCandidate {
  return { kind: hit.kind, tmdbId: hit.tmdbId, title: hit.title, originalTitle: hit.originalTitle, year: hit.year, movieId: null };
}

function yearFits(year: number | null, query: TitleQuery): boolean {
  return query.year === null || year === null || year === query.year;
}

/** The exact rule, or one of the title's aliases is the asked name (and the year fits). */
export function sameTitle(c: TitleCandidate, query: TitleQuery): boolean {
  if (isSameTitle({ name: c.title, originalName: c.originalTitle, year: c.year }, query)) return true;
  return (c.aliases ?? []).includes(normalizeName(query.name)) && yearFits(c.year, query);
}

function fromMatches(matches: TitleCandidate[], source: 'library' | 'tmdb'): LookupResult {
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { status: 'one', candidate: only, episode: null };
  if (matches.length === 0) return { status: 'none', nearMisses: [] };
  return { status: 'several', candidates: matches.slice(0, LOOKUP_MAX_CANDIDATES), source };
}

/**
 * A shorter name worth one more search when the full one found nothing: the name without its
 * subtitle ("Doctor X: Age of the White Mafia" is "Doctor X"), else the first two words of a name
 * of four or more. Null when there is none.
 */
export function shorterName(name: string): string | null {
  const full = name.trim();
  const base = full.split(/\s*[:\u2013\u2014]\s+|\s+-\s+/)[0]?.trim() ?? '';
  if (base !== '' && base !== full) return base;
  const words = full.split(/\s+/);
  return words.length >= 4 ? words.slice(0, 2).join(' ') : null;
}

/** The hits one of whose TMDB alternative titles is the asked name, in the order given. A TMDB failure matches nothing. */
async function matchesByAlternativeTitle(hits: TmdbSearchHit[], query: TitleQuery, tmdb: LookupTmdb): Promise<TmdbSearchHit[]> {
  const names = tmdb.alternativeTitles?.bind(tmdb);
  if (names === undefined) return [];
  const checked = await Promise.all(
    hits.map(async (hit) => {
      try {
        const alternatives = await names(hit.kind, hit.tmdbId);
        return alternatives.some((name) => isSameTitle({ name, originalName: null, year: hit.year }, query));
      } catch (err) {
        if (err instanceof TmdbError) return false;
        throw err;
      }
    }),
  );
  return hits.filter((_, i) => checked[i]);
}

/** A TMDB hit as a candidate, with the stored title's movie id when there is one. */
async function withStored(hit: TmdbSearchHit, library: TitleLibrary): Promise<TitleCandidate> {
  return (await library.byKey(hit.kind, hit.tmdbId)) ?? fromHit(hit);
}

async function lookupById(text: string, deps: LookupDeps): Promise<LookupResult> {
  const movieId = normalizeMovieId(text);
  let kind: TitleKind;
  let tmdbId: number;
  let episode: EpisodePick | null = null;
  if (movieId !== null) {
    const target = await deps.library.byMovieId(movieId);
    if (target === null) {
      throw new LookupError('not_found', `no title or episode has the movie id ${movieId}. Movie ids come from the movies_* and direct_stream_* tools; never invent one.`);
    }
    kind = target.kind;
    tmdbId = target.tmdbId;
    episode = target.episode;
  } else {
    const key = TITLE_KEY.exec(text);
    if (key === null) throw new LookupError('invalid_input', `"${text}" is neither a movie id (M-23T4) nor a title key (movie-550, tv-1399).`);
    kind = key[1]!.toLowerCase() as TitleKind;
    tmdbId = Number(key[2]);
  }
  const stored = await deps.library.byKey(kind, tmdbId);
  const key = titleId(kind, tmdbId);
  return { status: 'one', candidate: stored ?? { kind, tmdbId, title: key, originalTitle: key, year: null, movieId: null }, episode };
}

/**
 * The titles the owner's words (or id) may mean. Stored titles first: one or more exact matches
 * there (by name or by an alias the owner gave) answer without asking TMDB. Otherwise TMDB is
 * searched (films and series, or the one kind asked for), keeping the exact matches, most popular
 * first; when no name matches, the top hits whose TMDB alternative titles hold the asked name.
 * With no match at all the answer is `none` with near misses: the search's other hits, or, when it
 * found nothing, the hits for a shorter form of the name (shorterName).
 */
export async function lookupTitle(req: LookupRequest, deps: LookupDeps): Promise<LookupResult> {
  if (req.by === 'id') return lookupById(req.text, deps);
  const query: TitleQuery = { name: req.name, year: req.year };
  const stored = (await deps.library.search(req.name, req.kind)).filter((c) => sameTitle(c, query));
  if (stored.length > 0) return fromMatches(stored, 'library');
  const tmdb = deps.tmdb;
  if (tmdb === null) {
    throw new LookupError('tmdb_unavailable', `no stored title is called "${req.name}", and this server has no TMDB credentials to search further.`);
  }
  const kinds: TitleKind[] = req.kind === null ? ['movie', 'tv'] : [req.kind];
  /** Films and series for `name`, the asked year only, most popular first. */
  const search = async (name: string): Promise<TmdbSearchHit[]> =>
    (await Promise.all(kinds.map((kind) => (kind === 'movie' ? tmdb.searchMovie(name, req.year) : tmdb.searchTv(name, req.year)))))
      .flat()
      .filter((hit) => yearFits(hit.year, query))
      .sort((a, b) => b.popularity - a.popularity);
  const asCandidates = (hits: TmdbSearchHit[]) => Promise.all(hits.map((hit) => withStored(hit, deps.library)));

  const hits = await search(req.name);
  const exact = hits.filter((hit) => sameTitle(fromHit(hit), query));
  if (exact.length > 0) return fromMatches(await asCandidates(exact), 'tmdb');
  const alternative = await matchesByAlternativeTitle(hits.slice(0, ALTERNATIVE_TITLE_HITS), query, tmdb);
  if (alternative.length > 0) return fromMatches(await asCandidates(alternative), 'tmdb');

  const base = hits.length === 0 ? shorterName(req.name) : null;
  const near = base === null ? hits : await search(base);
  return { status: 'none', nearMisses: await asCandidates(near.slice(0, LOOKUP_MAX_NEAR_MISSES)) };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function fromKey(key: string): { kind: TitleKind; tmdbId: number } {
  const m = TITLE_KEY.exec(key);
  if (m === null) throw new Error(`movie_titles id ${key} is not a title key`);
  return { kind: m[1]!.toLowerCase() as TitleKind, tmdbId: Number(m[2]) };
}

/** The real TitleLibrary over movie_titles, movie_ids and movie_episodes. Reads only. */
export function dbTitleLibrary(db: Db): TitleLibrary {
  const columns = {
    kind: movieTitles.kind,
    tmdbId: movieTitles.tmdbId,
    title: movieTitles.title,
    originalTitle: movieTitles.originalTitle,
    year: movieTitles.year,
    movieId: movieIds.id,
    aliases: movieTitles.aliases,
  };
  const titleIdRow = and(eq(movieIds.titleId, movieTitles.id), isNull(movieIds.season), isNull(movieIds.episode));
  return {
    async search(name, kind) {
      const like = `%${escapeLike(name)}%`;
      const text = sql`(movie_titles.search_tsv @@ websearch_to_tsquery('simple', ${name})
        or ${movieTitles.title} ilike ${like} or ${movieTitles.originalTitle} ilike ${like}
        or ${normalizeName(name)} = any(${movieTitles.aliases}))`;
      const rows = await db
        .select(columns)
        .from(movieTitles)
        .leftJoin(movieIds, titleIdRow)
        .where(kind === null ? text : and(text, eq(movieTitles.kind, kind)))
        .limit(LIBRARY_SCAN_LIMIT);
      return rows.map((r) => ({ ...r, kind: r.kind as TitleKind, movieId: r.movieId ?? null }));
    },
    async byKey(kind, tmdbId) {
      const [row] = await db
        .select(columns)
        .from(movieTitles)
        .leftJoin(movieIds, titleIdRow)
        .where(eq(movieTitles.id, titleId(kind, tmdbId)))
        .limit(1);
      return row === undefined ? null : { ...row, kind: row.kind as TitleKind, movieId: row.movieId ?? null };
    },
    async byMovieId(movieId) {
      const target = await resolveMovieId(db, movieId);
      if (target === null) return null;
      const episode = target.season !== null && target.episode !== null ? { season: target.season, episode: target.episode } : null;
      return { ...fromKey(target.titleId), episode };
    },
    async seasons(kind, tmdbId) {
      const rows = await db
        .select({ season: movieEpisodes.season, episodes: sql<number>`count(*)::int` })
        .from(movieEpisodes)
        .where(and(eq(movieEpisodes.titleId, titleId(kind, tmdbId)), sql`${movieEpisodes.season} >= 1`))
        .groupBy(movieEpisodes.season)
        .orderBy(movieEpisodes.season);
      return rows;
    },
  };
}
