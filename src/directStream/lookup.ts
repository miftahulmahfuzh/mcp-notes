import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { movieEpisodes, movieIds, movieTitles } from '../db/schema.js';
import { normalizeMovieId, resolveMovieId } from '../movies/ids.js';
import type { TmdbClient, TmdbSearchHit } from '../movies/tmdb.js';
import { titleId, type TitleKind } from '../movies/types.js';
import { isSameTitle, type TitleQuery } from './match.js';
import type { StreamRef } from './types.js';

/** Candidates an answer lists at most. */
export const LOOKUP_MAX_CANDIDATES = 10;
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
}

/** What the tool was given, read once at the boundary by parseTitleRequest. */
export type LookupRequest =
  | { by: 'id'; text: string }
  | { by: 'words'; name: string; year: number | null; kind: TitleKind | null };

export type LookupResult =
  | { status: 'one'; candidate: TitleCandidate; /** Set when a movie id named one episode. */ episode: EpisodePick | null }
  | { status: 'several'; candidates: TitleCandidate[]; source: 'library' | 'tmdb' }
  | { status: 'none' };

/** The stored titles, read-only. dbTitleLibrary is the real one; tests pass a fake. */
export interface TitleLibrary {
  /** movie_titles rows whose name or synopsis contains the words: a loose pre-filter, the exact rule decides. */
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
  /** Null without TMDB credentials: only stored titles can be found. */
  tmdb: TmdbClient | null;
}

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

function sameTitle(c: TitleCandidate, query: TitleQuery): boolean {
  return isSameTitle({ name: c.title, originalName: c.originalTitle, year: c.year }, query);
}

function fromMatches(matches: TitleCandidate[], source: 'library' | 'tmdb'): LookupResult {
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { status: 'one', candidate: only, episode: null };
  if (matches.length === 0) return { status: 'none' };
  return { status: 'several', candidates: matches.slice(0, LOOKUP_MAX_CANDIDATES), source };
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
 * there answer without asking TMDB. Otherwise TMDB is searched (films and series, or the one kind
 * asked for), keeping the exact matches, most popular first.
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
  const hits = (
    await Promise.all(kinds.map((kind) => (kind === 'movie' ? tmdb.searchMovie(req.name, req.year) : tmdb.searchTv(req.name, req.year))))
  ).flat();
  const matches = hits
    .map((hit) => ({ hit, candidate: fromHit(hit) }))
    .filter(({ candidate }) => sameTitle(candidate, query))
    .sort((a, b) => b.hit.popularity - a.hit.popularity)
    .map(({ candidate }) => candidate);
  return fromMatches(matches, 'tmdb');
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
  };
  const titleIdRow = and(eq(movieIds.titleId, movieTitles.id), isNull(movieIds.season), isNull(movieIds.episode));
  return {
    async search(name, kind) {
      const like = `%${escapeLike(name)}%`;
      const text = sql`(movie_titles.search_tsv @@ websearch_to_tsquery('simple', ${name})
        or ${movieTitles.title} ilike ${like} or ${movieTitles.originalTitle} ilike ${like})`;
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
