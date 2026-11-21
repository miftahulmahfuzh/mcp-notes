import { z } from 'zod';
import { DEFAULT_ANIME_MAP_URL } from '../config.js';

export { DEFAULT_ANIME_MAP_URL };

/**
 * From a TMDB title to the anime embeds' key. The anime providers (`id_kind: "anilist"` in the
 * registry) are addressed by AniList id and by the episode counted through the whole series,
 * where TMDB files a long anime in seasons (One Piece episode 730 is TMDB's season 17). The
 * mapping comes from api.ani.zip, a public index that takes a TMDB id and lists the AniList
 * entry's episodes with their air dates. An episode is mapped only when exactly one of them aired
 * on the day TMDB gives: a series AniList splits into several entries simply has no match for the
 * episodes of its later entries, and those go to the ordinary providers. TMDB and the index do not
 * always agree on the day (One Piece from episode 787 on: TMDB says Saturday, the index Sunday, the
 * same broadcast in two time zones), so when no episode aired on TMDB's day, the one episode that
 * aired the day before or after is taken; two of them, and nothing is mapped.
 */

export const ANIME_MAP_TIMEOUT_MS = 8_000;
/** How long an answer (a mapping, or "not an anime") is kept. */
export const ANIME_MAP_TTL_MS = 6 * 3_600_000;
/** How long a failed request is remembered, so a provider outage does not slow every resolve. */
export const ANIME_MAP_RETRY_MS = 5 * 60_000;
/** The User-Agent of the anime id lookup. */
export const ANIME_MAP_USER_AGENT = 'notesd-direct-stream (plain request; anime id lookup)';

/** What an anime embed is keyed by: the AniList id and the episode as AniList counts it (1 for a film). */
export interface AnimeRef {
  id: number;
  episode: number;
}

export interface AnimeQuery {
  kind: 'movie' | 'tv';
  tmdbId: number;
  /** The episode's air date as TMDB gives it, `YYYY-MM-DD`; null for a film, or when TMDB has none. */
  airDate: string | null;
}

export interface AnimeMapper {
  /** The anime key of a film or an episode, or null: not an anime, not mapped, or the index did not answer. Never throws. */
  lookup(query: AnimeQuery): Promise<AnimeRef | null>;
}

export interface AnimeMapperOptions {
  /** `NOTESD_ANIME_MAP_URL`; null turns the lookup off (every answer is null, nothing is requested). */
  baseUrl: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

const MappingSchema = z.object({
  mappings: z
    .object({
      anilist_id: z.number().int().positive().nullish(),
      themoviedb_id: z.union([z.string(), z.number()]).nullish(),
      type: z.string().nullish(),
    })
    .nullish(),
  episodes: z.record(z.string(), z.object({ airdate: z.string().nullish() }).passthrough()).nullish(),
});

interface Mapping {
  anilistId: number;
  film: boolean;
  /** Air date -> the numbered episodes that aired that day (specials, keyed "S1", are left out). */
  byAirDate: Map<string, number[]>;
}

function readMapping(json: unknown, tmdbId: number): Mapping | null {
  const parsed = MappingSchema.safeParse(json);
  if (!parsed.success) return null;
  const m = parsed.data.mappings;
  if (m === null || m === undefined || m.anilist_id === null || m.anilist_id === undefined) return null;
  // The index answered for another title than the one asked about.
  if (String(m.themoviedb_id ?? '') !== String(tmdbId)) return null;
  const byAirDate = new Map<string, number[]>();
  for (const [key, entry] of Object.entries(parsed.data.episodes ?? {})) {
    if (!/^\d+$/.test(key) || typeof entry.airdate !== 'string') continue;
    const day = entry.airdate.slice(0, 10);
    byAirDate.set(day, [...(byAirDate.get(day) ?? []), Number(key)]);
  }
  return { anilistId: m.anilist_id, film: (m.type ?? '').toUpperCase() === 'MOVIE', byAirDate };
}

/** `YYYY-MM-DD` moved by whole days; '' for a date that is not one. */
function shiftDay(day: string, days: number): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(at) ? '' : new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/** The anime key of one query against a mapping; null when the kinds differ or the air date names no single episode. */
export function animeRefFrom(mapping: Mapping, query: AnimeQuery): AnimeRef | null {
  if (query.kind === 'movie') return mapping.film ? { id: mapping.anilistId, episode: 1 } : null;
  if (mapping.film || query.airDate === null) return null;
  let aired = mapping.byAirDate.get(query.airDate) ?? [];
  if (aired.length === 0) aired = [-1, 1].flatMap((days) => mapping.byAirDate.get(shiftDay(query.airDate ?? '', days)) ?? []);
  const [only] = aired;
  return aired.length === 1 && only !== undefined ? { id: mapping.anilistId, episode: only } : null;
}

export function createAnimeMapper(options: AnimeMapperOptions): AnimeMapper {
  const base = options.baseUrl === null ? null : options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const cache = new Map<number, { mapping: Mapping | null; until: number }>();

  async function mappingOf(tmdbId: number): Promise<Mapping | null> {
    const hit = cache.get(tmdbId);
    if (hit !== undefined && hit.until > now()) return hit.mapping;
    let mapping: Mapping | null = null;
    let ttl = ANIME_MAP_TTL_MS;
    try {
      const res = await fetchImpl(`${base}/mappings?themoviedb_id=${tmdbId}`, {
        headers: { accept: 'application/json', 'user-agent': ANIME_MAP_USER_AGENT },
        signal: AbortSignal.timeout(ANIME_MAP_TIMEOUT_MS),
      });
      if (res.ok) mapping = readMapping(await res.json(), tmdbId);
      // 404: the index does not know the title, so it is not an anime. Anything else may pass.
      else if (res.status !== 404) ttl = ANIME_MAP_RETRY_MS;
    } catch (err) {
      ttl = ANIME_MAP_RETRY_MS;
      log(`[notesd] direct stream: the anime index did not answer for TMDB ${tmdbId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    cache.set(tmdbId, { mapping, until: now() + ttl });
    return mapping;
  }

  return {
    async lookup(query) {
      if (base === null) return null;
      const mapping = await mappingOf(query.tmdbId);
      return mapping === null ? null : animeRefFrom(mapping, query);
    },
  };
}
