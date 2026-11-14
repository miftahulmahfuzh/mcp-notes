import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { movieIds } from '../db/schema.js';

/**
 * Movie ids are `M-` and four chars from [0-9A-Z]: `M-23T4`. One per title and one per episode
 * (the `movie_ids` registry, migration 0018). The database generates them; never invent one.
 */
export const MOVIE_ID_PATTERN = /^M-[0-9A-Z]{4}$/;

/**
 * Case-insensitive lookup form: `m-23t4`, ` M-23T4 ` -> `M-23T4`; null for anything else. The dash
 * is required: without it `M3GAN` would read as an id.
 */
export function normalizeMovieId(input: string): string | null {
  const v = input.trim().toUpperCase();
  return MOVIE_ID_PATTERN.test(v) ? v : null;
}

/** What a movie id names: a title, or one episode of it. */
export interface MovieIdTarget {
  movieId: string;
  titleId: string;
  season: number | null;
  episode: number | null;
}

/** The target of a movie id, or null when the text is not one or names nothing. */
export async function resolveMovieId(db: Db, input: string): Promise<MovieIdTarget | null> {
  const id = normalizeMovieId(input);
  if (id === null) return null;
  const [row] = await db.select().from(movieIds).where(eq(movieIds.id, id)).limit(1);
  return row === undefined ? null : { movieId: row.id, titleId: row.titleId, season: row.season, episode: row.episode };
}

/** The ids of one title: its own, and one per episode. */
export interface TitleMovieIds {
  title: string | null;
  episodes: Map<string, string>;
}

/** The key of an episode in TitleMovieIds.episodes. */
export function episodeKey(season: number, episode: number): string {
  return `${season}x${episode}`;
}

export function emptyTitleMovieIds(): TitleMovieIds {
  return { title: null, episodes: new Map() };
}

/** Every movie id of the given titles, by title id. A title without rows gets no entry. */
export async function movieIdsOfTitles(db: Db, titleIds: readonly string[]): Promise<Map<string, TitleMovieIds>> {
  const out = new Map<string, TitleMovieIds>();
  if (titleIds.length === 0) return out;
  const rows = await db.select().from(movieIds).where(inArray(movieIds.titleId, [...titleIds]));
  for (const r of rows) {
    let entry = out.get(r.titleId);
    if (entry === undefined) {
      entry = emptyTitleMovieIds();
      out.set(r.titleId, entry);
    }
    if (r.season === null || r.episode === null) entry.title = r.id;
    else entry.episodes.set(episodeKey(r.season, r.episode), r.id);
  }
  return out;
}

/** The movie id of a title (season and episode null) or of one of its episodes; null when the registry has none. */
export async function movieIdFor(db: Db, titleId: string, season: number | null = null, episode: number | null = null): Promise<string | null> {
  const [row] = await db
    .select({ id: movieIds.id })
    .from(movieIds)
    .where(and(eq(movieIds.titleId, titleId), sql`${movieIds.season} is not distinct from ${season}`, sql`${movieIds.episode} is not distinct from ${episode}`))
    .limit(1);
  return row?.id ?? null;
}
