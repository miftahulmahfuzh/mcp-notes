import { z } from 'zod';
import type { CompanyMeta, CreditMeta, CreditRole, EpisodeMeta, TitleKind, TitleMetadata, TitleTrailers } from './types.js';

/**
 * TMDB v3 client: search, details with credits and trailers, every season's episodes, people. The only module
 * that talks to TMDB. Every response is checked against a schema here, at the edge, and turned
 * into the types below; callers never see TMDB's JSON. Every failure is a TmdbError, which the
 * sync pass treats as "TMDB unreachable, retry next pass".
 *
 * Auth: `Authorization: Bearer <token>` when a read access token is set, else `?api_key=`. Neither
 * ever appears in an error message.
 */

/** Per request. */
export const TMDB_TIMEOUT_MS = 15_000;
/** Cast members kept per title, by billing order. */
export const MAX_CAST = 40;
/** Directors, writers, producers and creators kept per title, each. */
export const MAX_CREW_PER_ROLE = 20;
/** Poster width used when the caller names none (TMDB sizes: w92 w154 w185 w342 w500 w780 original). */
export const DEFAULT_POSTER_SIZE = 'w342';
/** How much of a bad response body an error message carries. */
const SNIPPET_CHARS = 300;

// TitleMetadata and its parts have one definition, in ./types.ts (phase 1); this module re-exports them.
export type { CompanyMeta, CreditMeta, CreditRole, EpisodeMeta, TitleKind, TitleMetadata, TitleTrailers };

/** One search result, film or series. */
export interface TmdbSearchHit {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string;
  releaseDate: string | null;
  year: number | null;
  overview: string;
  posterPath: string | null;
  popularity: number;
  /** TMDB's `original_language` ("es"); absent or null when the list did not carry it. */
  originalLanguage?: string | null;
}

export interface TmdbPersonHit {
  personId: number;
  name: string;
  knownFor: string | null;
  profilePath: string | null;
  popularity: number;
}

/** One entry of a person's filmography (movies_person, phase 7). */
export interface TmdbPersonCredit {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  year: number | null;
  posterPath: string | null;
  popularity: number;
  credit: 'cast' | 'crew';
  character: string | null;
  job: string | null;
  department: string | null;
  /** Series: episodes this person is credited on. */
  episodeCount: number | null;
  /** TMDB's `original_language` ("id"); absent or null when the credit did not carry it. */
  originalLanguage?: string | null;
  /** TMDB's `genre_ids` of the title; absent when the credit did not carry them. */
  genreIds?: readonly number[];
}

export interface TmdbClient {
  /** Films matching `query`; `year` narrows to that release year. '' answers [] without a request. */
  searchMovie(query: string, year?: number | null): Promise<TmdbSearchHit[]>;
  /** Series matching `query`; `year` narrows to that first-air year. '' answers [] without a request. */
  searchTv(query: string, year?: number | null): Promise<TmdbSearchHit[]>;
  movieDetails(id: number): Promise<TitleMetadata>;
  /** One request for the series, then one per season (sequential). */
  tvDetails(id: number): Promise<TitleMetadata>;
  /**
   * The trailers alone, for a title stored before trailers were kept: one request for the title,
   * then one per season in `seasons` (sequential). A season TMDB has no page for has no trailer.
   */
  trailers(kind: TitleKind, id: number, seasons: readonly number[]): Promise<TitleTrailers>;
  searchPerson(query: string): Promise<TmdbPersonHit[]>;
  /** Films and series, cast then crew, in TMDB's order. */
  personCredits(personId: number): Promise<TmdbPersonCredit[]>;
}

/** A TMDB genre (`/genre/{kind}/list`): its id, which discover takes, and its English name. */
export interface TmdbGenre {
  id: number;
  name: string;
}

/** The ready-made TMDB lists `TmdbCatalog.list` reads. */
export type TmdbListName = 'trending' | 'popular';

/** Discover keeps titles with at least this many votes, so obscure titles that no provider carries stay out. */
export const DISCOVER_MIN_VOTES = 100;

/**
 * Lists of titles for the direct-streaming prober's candidates (src/directStream/candidates.ts).
 * Each call reads one page (TMDB pages hold 20 titles). Kept apart from TmdbClient, so the
 * library's fakes of TmdbClient stay valid; createTmdbClient returns both.
 */
export interface TmdbCatalog {
  /** `trending`: this week's trending titles of `kind`; `popular`: TMDB's popular list. */
  list(name: TmdbListName, kind: TitleKind, page?: number): Promise<TmdbSearchHit[]>;
  /** TMDB's genres for `kind`. */
  genres(kind: TitleKind): Promise<TmdbGenre[]>;
  /** The most popular titles of one genre with at least DISCOVER_MIN_VOTES votes. */
  discoverByGenre(kind: TitleKind, genreId: number, page?: number): Promise<TmdbSearchHit[]>;
  /** TMDB's recommendations for one title. A title TMDB does not know (404) answers []. */
  recommendations(kind: TitleKind, tmdbId: number, page?: number): Promise<TmdbSearchHit[]>;
}

/**
 * The other names TMDB keeps for a title, for the direct-stream lookup (src/directStream/lookup.ts).
 * Kept apart from TmdbClient for the same reason as TmdbCatalog; createTmdbClient returns it too.
 */
export interface TmdbTitleNames {
  /** A title's alternative titles in every country, in TMDB's order, without blanks. A title TMDB does not know (404) answers []. */
  alternativeTitles(kind: TitleKind, tmdbId: number): Promise<string[]>;
  /** TMDB's `original_language` of a title ("ko"), in one request; null when TMDB does not know the title or its language. */
  originalLanguage(kind: TitleKind, tmdbId: number): Promise<string | null>;
  /** TMDB's `external_ids.imdb_id` of a film or series (`tt0137523`), in one request; null when TMDB has none or does not know the title. */
  imdbId(kind: TitleKind, tmdbId: number): Promise<string | null>;
}

/** A production company or a streaming service as TMDB names it. */
export interface TmdbNamedHit {
  id: number;
  name: string;
  /** A company's origin country ("US"); null for a service, or when TMDB has none. */
  country: string | null;
}

/** What `TmdbDiscovery.discover` filters on. Every field is optional; ids come from the lookups below. */
export interface TmdbDiscoverFilter {
  /** Released (a film) or first aired (a series) on or after this day, `YYYY-MM-DD`. */
  dateFrom?: string | null;
  /** Released or first aired on or before this day, `YYYY-MM-DD`. */
  dateTo?: string | null;
  /** TMDB's language code of the original language ("es", "ko"); several joined by `|` pass a title in any of them ("zh|cn"). */
  originalLanguage?: string | null;
  /** Genres' TMDB ids (`TmdbCatalog.genres`): a title passes when it has every one. */
  genreIds?: readonly number[] | null;
  /** Keywords' TMDB ids (`searchKeyword`): a title that carries any one of them passes. */
  keywordIds?: readonly number[] | null;
  /** Production companies' TMDB ids: a title made by any one of them passes. */
  companyIds?: readonly number[] | null;
  /** A streaming service's TMDB watch-provider id; needs `watchRegion`. */
  providerId?: number | null;
  /** The country the service's catalogue is read for ("US"). */
  watchRegion?: string | null;
  /** `newest`: release date, newest first; `popular` (default): TMDB's popularity. */
  sort?: 'newest' | 'popular';
  page?: number;
}

/**
 * Discovery for direct_stream_discover (src/mcp/directStreamTools.ts): titles by date, language,
 * company and streaming service, and the name lookups behind the two ids. Kept apart from
 * TmdbClient for the same reason as TmdbCatalog; createTmdbClient returns it too.
 */
export interface TmdbDiscovery {
  /** One page (20 titles) of `kind` that pass every filter given. */
  discover(kind: TitleKind, filter: TmdbDiscoverFilter): Promise<TmdbSearchHit[]>;
  /** Production companies matching `query`, in TMDB's order. '' answers [] without a request. */
  searchCompany(query: string): Promise<TmdbNamedHit[]>;
  /** Every streaming service TMDB lists for `kind` in `region` ("US"), most prominent first. */
  watchProviders(kind: TitleKind, region: string): Promise<TmdbNamedHit[]>;
  /** Keywords matching `query` ("mafia": mafia, sicilian mafia, ...), in TMDB's order. '' answers [] without a request. */
  searchKeyword(query: string): Promise<TmdbNamedHit[]>;
}

/** The slice of `config.movies.tmdb` the client needs; the whole config object fits. */
export interface TmdbClientConfig {
  token: string | null;
  apiKey: string | null;
  apiBase: string;
}

export interface TmdbClientOptions {
  /** Default TMDB_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * no_credentials: neither token nor key set (no request made). network / timeout: TMDB not reached.
 * http: TMDB answered non-2xx (`status`). bad_response: the body is not JSON or not the expected shape.
 */
export type TmdbErrorCode = 'no_credentials' | 'network' | 'timeout' | 'http' | 'bad_response';

export class TmdbError extends Error {
  override readonly name = 'TmdbError';
  readonly code: TmdbErrorCode;
  /** HTTP status for `http`, else null. */
  readonly status: number | null;

  constructor(code: TmdbErrorCode, message: string, status: number | null = null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.status = status;
  }
}

// ---- response schemas (the boundary) ----

const intId = z.number().int();
const text = z.string().nullish();
const num = z.number().nullish();

const GenreSchema = z.object({ name: z.string() });
const CompanySchema = z.object({ id: intId, name: z.string(), logo_path: text, origin_country: text });
const MovieCastSchema = z.object({ id: intId, name: z.string(), character: text, order: num, profile_path: text });
const MovieCrewSchema = z.object({ id: intId, name: z.string(), job: text, department: text, profile_path: text });

const VideoSchema = z.object({
  key: text,
  site: text,
  type: text,
  official: z.boolean().nullish(),
  published_at: text,
});
const VideosSchema = z.object({ results: z.array(VideoSchema).nullish() });

const MovieDetailsSchema = z.object({
  id: intId,
  title: z.string(),
  original_title: text,
  original_language: text,
  release_date: text,
  overview: text,
  poster_path: text,
  backdrop_path: text,
  runtime: num,
  genres: z.array(GenreSchema).nullish(),
  production_companies: z.array(CompanySchema).nullish(),
  credits: z.object({ cast: z.array(MovieCastSchema).nullish(), crew: z.array(MovieCrewSchema).nullish() }).nullish(),
  videos: VideosSchema.nullish(),
});

const TvCastSchema = z.object({
  id: intId,
  name: z.string(),
  profile_path: text,
  order: num,
  roles: z.array(z.object({ character: text, episode_count: num })).nullish(),
});
const TvCrewSchema = z.object({
  id: intId,
  name: z.string(),
  profile_path: text,
  department: text,
  total_episode_count: num,
  jobs: z.array(z.object({ job: text, episode_count: num })).nullish(),
});
const PersonRefSchema = z.object({ id: intId, name: z.string(), profile_path: text });

const TvDetailsSchema = z.object({
  id: intId,
  name: z.string(),
  original_name: text,
  original_language: text,
  first_air_date: text,
  overview: text,
  poster_path: text,
  backdrop_path: text,
  episode_run_time: z.array(z.number()).nullish(),
  genres: z.array(GenreSchema).nullish(),
  number_of_seasons: num,
  number_of_episodes: num,
  created_by: z.array(PersonRefSchema).nullish(),
  production_companies: z.array(CompanySchema).nullish(),
  seasons: z.array(z.object({ season_number: intId })).nullish(),
  aggregate_credits: z.object({ cast: z.array(TvCastSchema).nullish(), crew: z.array(TvCrewSchema).nullish() }).nullish(),
  videos: VideosSchema.nullish(),
});

const SeasonSchema = z.object({
  episodes: z
    .array(
      z.object({
        episode_number: intId,
        name: text,
        air_date: text,
        runtime: num,
        overview: text,
        still_path: text,
      }),
    )
    .nullish(),
  videos: VideosSchema.nullish(),
});

const MovieSearchSchema = z.object({
  results: z
    .array(
      z.object({
        id: intId,
        title: z.string(),
        original_title: text,
        release_date: text,
        overview: text,
        poster_path: text,
        popularity: num,
        original_language: text,
      }),
    )
    .nullish(),
});

const TvSearchSchema = z.object({
  results: z
    .array(
      z.object({
        id: intId,
        name: z.string(),
        original_name: text,
        first_air_date: text,
        overview: text,
        poster_path: text,
        popularity: num,
        original_language: text,
      }),
    )
    .nullish(),
});

const CompanySearchSchema = z.object({
  results: z.array(z.object({ id: intId, name: z.string(), origin_country: text })).nullish(),
});

const KeywordSearchSchema = z.object({
  results: z.array(z.object({ id: intId, name: z.string() })).nullish(),
});

const WatchProvidersSchema = z.object({
  results: z.array(z.object({ provider_id: intId, provider_name: z.string(), display_priority: num })).nullish(),
});

const PersonSearchSchema = z.object({
  results: z
    .array(z.object({ id: intId, name: z.string(), known_for_department: text, profile_path: text, popularity: num }))
    .nullish(),
});

const OriginalLanguageSchema = z.object({ original_language: text });
const ExternalIdsSchema = z.object({ imdb_id: text });

/** `/movie/{id}/alternative_titles` answers `titles`, `/tv/{id}/alternative_titles` answers `results`. */
const AlternativeTitlesSchema = z.object({
  titles: z.array(z.object({ title: text })).nullish(),
  results: z.array(z.object({ title: text })).nullish(),
});

const GenreListSchema = z.object({ genres: z.array(z.object({ id: intId, name: z.string() })).nullish() });

const PersonCreditSchema = z.object({
  id: intId,
  media_type: text,
  title: text,
  name: text,
  release_date: text,
  first_air_date: text,
  character: text,
  job: text,
  department: text,
  poster_path: text,
  popularity: num,
  episode_count: num,
  original_language: text,
  genre_ids: z.array(intId).nullish(),
});
const CombinedCreditsSchema = z.object({
  cast: z.array(PersonCreditSchema).nullish(),
  crew: z.array(PersonCreditSchema).nullish(),
});

type PersonCreditJson = z.infer<typeof PersonCreditSchema>;

function decode<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.join('.') || '(root)'}: ${issue.message}`;
    throw new TmdbError('bad_response', `TMDB ${what} had an unexpected shape${where}`);
  }
  return parsed.data;
}

// ---- small helpers ----

function orNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : value;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/** 2019 from "2019-07-26"; null for null or a malformed date. */
export function yearOf(date: string | null): number | null {
  if (date === null) return null;
  const m = /^(\d{4})-/.exec(date);
  return m === null ? null : Number(m[1]);
}

function errorName(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined;
}

function isTimeout(cause: unknown): boolean {
  const name = errorName(cause);
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Full poster URL, loadable from any machine (posters are hotlinked, never cached on disk). */
export function posterUrl(imageBase: string, path: string | null, size: string = DEFAULT_POSTER_SIZE): string | null {
  if (path === null || path.trim() === '') return null;
  return `${imageBase.replace(/\/+$/, '')}/${size}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Season and episode of the n-th episode (1-based) of a series counted over seasons >= 1 in order:
 * "One Piece - 405" -> the 405th listed episode. Returns that episode's own TMDB numbers, which
 * for some anime run on across seasons (One Piece season 2 starts at episode 62). Null when n is
 * out of range. `episodes` is TitleMetadata.episodes (any order).
 */
export function absoluteToSeasonEpisode(
  episodes: ReadonlyArray<{ season: number; episode: number }>,
  n: number,
): { season: number; episode: number } | null {
  if (!Number.isInteger(n) || n < 1) return null;
  const ordered = episodes
    .filter((e) => e.season >= 1)
    .slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const hit = ordered[n - 1];
  return hit === undefined ? null : { season: hit.season, episode: hit.episode };
}

// ---- trailers ----

/** What a YouTube video id looks like. The key goes into an embed URL, so nothing else is kept. */
const YOUTUBE_KEY = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * The one video to show as the trailer, as a YouTube video id, or null. Only YouTube videos of type
 * Trailer or Teaser count. A trailer beats a teaser, an official video an unofficial one, and
 * among equals the newest wins (the final trailer, not the first announcement).
 */
export function pickTrailer(videos: ReadonlyArray<z.infer<typeof VideoSchema>> | null | undefined): string | null {
  let best: { key: string; rank: number; at: string } | null = null;
  for (const v of videos ?? []) {
    const key = orNull(v.key);
    if (key === null || !YOUTUBE_KEY.test(key) || v.site !== 'YouTube') continue;
    if (v.type !== 'Trailer' && v.type !== 'Teaser') continue;
    const rank = (v.type === 'Trailer' ? 2 : 0) + (v.official === true ? 1 : 0);
    const at = v.published_at ?? '';
    if (best === null || rank > best.rank || (rank === best.rank && at > best.at)) best = { key, rank, at };
  }
  return best === null ? null : best.key;
}

// ---- credits ----

const ROLE_ORDER: readonly CreditRole[] = ['cast', 'director', 'writer', 'producer', 'creator'];
const PRODUCER_JOBS: ReadonlySet<string> = new Set(['Producer', 'Executive Producer']);
/** Writing-department jobs that are not authorship. */
const NON_WRITER_JOBS: ReadonlySet<string> = new Set([
  'Script Editor',
  'Script Consultant',
  'Script Coordinator',
  'Story Editor',
  'Executive Story Editor',
  'Researcher',
  'Storyboard',
  'Storyboard Artist',
]);

/** The role a crew job is stored under, or null for jobs the library does not keep (grips, editors, ...). */
export function crewRole(job: string | null, department: string | null): CreditRole | null {
  if (job === 'Director') return 'director';
  if (job !== null && PRODUCER_JOBS.has(job)) return 'producer';
  if (department === 'Writing' && (job === null || !NON_WRITER_JOBS.has(job))) return 'writer';
  return null;
}

interface PersonRef {
  id: number;
  name: string;
  profilePath: string | null;
}

interface PendingCredit {
  person: PersonRef;
  role: CreditRole;
  jobs: string[];
  characters: string[];
  /** Higher first: -billing order for cast, episode count for series crew. */
  weight: number;
  seq: number;
}

/** One credit per (role, person): a writer credited for "Screenplay" and "Story" is one row. */
class CreditCollector {
  private readonly entries = new Map<string, PendingCredit>();

  add(role: CreditRole, person: PersonRef, detail: { job?: string | null; character?: string | null; weight: number }): void {
    const key = `${role}:${person.id}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { person, role, jobs: [], characters: [], weight: detail.weight, seq: this.entries.size };
      this.entries.set(key, entry);
    } else {
      entry.weight = Math.max(entry.weight, detail.weight);
    }
    const job = orNull(detail.job);
    if (job !== null && !entry.jobs.includes(job)) entry.jobs.push(job);
    const character = orNull(detail.character);
    if (character !== null && !entry.characters.includes(character)) entry.characters.push(character);
  }

  build(): CreditMeta[] {
    const all = [...this.entries.values()];
    const out: CreditMeta[] = [];
    for (const role of ROLE_ORDER) {
      const cap = role === 'cast' ? MAX_CAST : MAX_CREW_PER_ROLE;
      const items = all
        .filter((e) => e.role === role)
        .sort((a, b) => b.weight - a.weight || a.seq - b.seq)
        .slice(0, cap);
      items.forEach((e) =>
        out.push({
          personId: e.person.id,
          name: e.person.name,
          profilePath: e.person.profilePath,
          role,
          character: e.characters.length > 0 ? e.characters.join(' / ') : null,
          job: e.jobs.length > 0 ? e.jobs.join(', ') : null,
        }),
      );
    }
    return out;
  }
}

function personRef(p: { id: number; name: string; profile_path?: string | null }): PersonRef {
  return { id: p.id, name: p.name, profilePath: orNull(p.profile_path) };
}

function companiesOf(list: ReadonlyArray<z.infer<typeof CompanySchema>> | null | undefined): CompanyMeta[] {
  return (list ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    logoPath: orNull(c.logo_path),
    originCountry: orNull(c.origin_country),
  }));
}

function searchHit(
  kind: TitleKind,
  r: {
    id: number;
    title: string;
    original: string | null | undefined;
    date: string | null | undefined;
    overview: string | null | undefined;
    poster: string | null | undefined;
    popularity: number | null | undefined;
    language?: string | null | undefined;
  },
): TmdbSearchHit {
  const releaseDate = orNull(r.date);
  return {
    kind,
    tmdbId: r.id,
    title: r.title,
    originalTitle: orNull(r.original) ?? r.title,
    releaseDate,
    year: yearOf(releaseDate),
    overview: r.overview ?? '',
    posterPath: orNull(r.poster),
    popularity: r.popularity ?? 0,
    originalLanguage: orNull(r.language),
  };
}

function movieHits(raw: z.infer<typeof MovieSearchSchema>): TmdbSearchHit[] {
  return (raw.results ?? []).map((r) =>
    searchHit('movie', {
      id: r.id,
      title: r.title,
      original: r.original_title,
      date: r.release_date,
      overview: r.overview,
      poster: r.poster_path,
      popularity: r.popularity,
      language: r.original_language,
    }),
  );
}

function tvHits(raw: z.infer<typeof TvSearchSchema>): TmdbSearchHit[] {
  return (raw.results ?? []).map((r) =>
    searchHit('tv', {
      id: r.id,
      title: r.name,
      original: r.original_name,
      date: r.first_air_date,
      overview: r.overview,
      poster: r.poster_path,
      popularity: r.popularity,
      language: r.original_language,
    }),
  );
}

/** A page of titles of `kind` (trending, popular, discover, recommendations share the search shape). */
function hitsOf(kind: TitleKind, json: unknown, what: string): TmdbSearchHit[] {
  return kind === 'movie' ? movieHits(decode(MovieSearchSchema, json, what)) : tvHits(decode(TvSearchSchema, json, what));
}

function personCredit(c: PersonCreditJson, credit: 'cast' | 'crew'): TmdbPersonCredit | null {
  const kind: TitleKind | null = c.media_type === 'movie' ? 'movie' : c.media_type === 'tv' ? 'tv' : null;
  if (kind === null) return null;
  const title = orNull(kind === 'movie' ? c.title : c.name) ?? orNull(c.title) ?? orNull(c.name);
  if (title === null) return null;
  const releaseDate = orNull(kind === 'movie' ? c.release_date : c.first_air_date);
  return {
    kind,
    tmdbId: c.id,
    title,
    releaseDate,
    year: yearOf(releaseDate),
    posterPath: orNull(c.poster_path),
    popularity: c.popularity ?? 0,
    credit,
    character: credit === 'cast' ? orNull(c.character) : null,
    job: credit === 'crew' ? orNull(c.job) : null,
    department: credit === 'crew' ? orNull(c.department) : null,
    episodeCount: positiveOrNull(c.episode_count),
    originalLanguage: orNull(c.original_language),
    genreIds: c.genre_ids ?? [],
  };
}

/** TMDB ids as one query value: `,` for "every one of them", `|` for "any of them". Undefined (no filter) for none. */
function idList(ids: readonly number[] | null | undefined, separator: ',' | '|'): string | undefined {
  return ids === null || ids === undefined || ids.length === 0 ? undefined : ids.join(separator);
}

type QueryParams = Record<string, string | number | boolean | null | undefined>;

export function createTmdbClient(
  config: TmdbClientConfig,
  fetchImpl: typeof fetch = fetch,
  options: TmdbClientOptions = {},
): TmdbClient & TmdbCatalog & TmdbTitleNames & TmdbDiscovery {
  const base = config.apiBase.replace(/\/+$/, '');
  const token = orNull(config.token);
  const apiKey = orNull(config.apiKey);
  const timeoutMs = options.timeoutMs ?? TMDB_TIMEOUT_MS;

  /** GET `path` (no query string in it) and parse JSON. Errors name the path, never the URL (it may hold the key). */
  async function get(path: string, params: QueryParams): Promise<unknown> {
    if (token === null && apiKey === null) {
      throw new TmdbError('no_credentials', 'TMDB is not configured: set TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY');
    }
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    else if (apiKey !== null) url.searchParams.set('api_key', apiKey);

    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      if (isTimeout(cause)) throw new TmdbError('timeout', `TMDB ${path} timed out after ${timeoutMs} ms`, null, cause);
      throw new TmdbError('network', `TMDB ${path} could not be reached`, null, cause);
    }
    let raw: string;
    try {
      raw = await res.text();
    } catch (cause) {
      if (isTimeout(cause)) throw new TmdbError('timeout', `TMDB ${path} timed out after ${timeoutMs} ms`, null, cause);
      throw new TmdbError('network', `TMDB ${path} response could not be read`, null, cause);
    }
    if (!res.ok) {
      throw new TmdbError('http', `TMDB ${path} returned ${res.status}: ${raw.slice(0, SNIPPET_CHARS)}`, res.status);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch (cause) {
      throw new TmdbError('bad_response', `TMDB ${path} did not return JSON: ${raw.slice(0, SNIPPET_CHARS)}`, null, cause);
    }
  }

  /** A 404 answers null: TMDB sometimes lists a season it has no page for, which is not a failed sync. */
  async function getOrNull(path: string, params: QueryParams): Promise<unknown> {
    try {
      return await get(path, params);
    } catch (err) {
      if (err instanceof TmdbError && err.status === 404) return null;
      throw err;
    }
  }

  async function seasonDetails(tvId: number, season: number): Promise<{ episodes: EpisodeMeta[]; trailer: string | null }> {
    const json = await getOrNull(`/tv/${tvId}/season/${season}`, { append_to_response: 'videos' });
    if (json === null) return { episodes: [], trailer: null };
    const raw = decode(SeasonSchema, json, `tv ${tvId} season ${season}`);
    const episodes = (raw.episodes ?? []).map((e) => ({
      season,
      episode: e.episode_number,
      name: orNull(e.name) ?? `Episode ${e.episode_number}`,
      airDate: orNull(e.air_date),
      runtimeMin: positiveOrNull(e.runtime),
      overview: orNull(e.overview),
      stillPath: orNull(e.still_path),
    }));
    return { episodes, trailer: pickTrailer(raw.videos?.results) };
  }

  return {
    async searchMovie(query, year = null) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(
        MovieSearchSchema,
        await get('/search/movie', { query: q, year: year ?? undefined, include_adult: false }),
        'movie search',
      );
      return (raw.results ?? []).map((r) =>
        searchHit('movie', {
          id: r.id,
          title: r.title,
          original: r.original_title,
          date: r.release_date,
          overview: r.overview,
          poster: r.poster_path,
          popularity: r.popularity,
        }),
      );
    },

    async searchTv(query, year = null) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(
        TvSearchSchema,
        await get('/search/tv', { query: q, first_air_date_year: year ?? undefined, include_adult: false }),
        'tv search',
      );
      return (raw.results ?? []).map((r) =>
        searchHit('tv', {
          id: r.id,
          title: r.name,
          original: r.original_name,
          date: r.first_air_date,
          overview: r.overview,
          poster: r.poster_path,
          popularity: r.popularity,
        }),
      );
    },

    async movieDetails(id) {
      const raw = decode(MovieDetailsSchema, await get(`/movie/${id}`, { append_to_response: 'credits,videos' }), `movie ${id}`);
      const credits = new CreditCollector();
      (raw.credits?.cast ?? []).forEach((c, i) =>
        credits.add('cast', personRef(c), { character: c.character, weight: -(c.order ?? i) }),
      );
      for (const c of raw.credits?.crew ?? []) {
        const role = crewRole(orNull(c.job), orNull(c.department));
        if (role !== null) credits.add(role, personRef(c), { job: c.job, weight: 0 });
      }
      const releaseDate = orNull(raw.release_date);
      return {
        kind: 'movie',
        tmdbId: raw.id,
        title: raw.title,
        originalTitle: orNull(raw.original_title) ?? raw.title,
        originalLanguage: orNull(raw.original_language),
        year: yearOf(releaseDate),
        releaseDate,
        overview: raw.overview ?? '',
        posterPath: orNull(raw.poster_path),
        backdropPath: orNull(raw.backdrop_path),
        runtimeMin: positiveOrNull(raw.runtime),
        genres: (raw.genres ?? []).map((g) => g.name),
        seasonCount: null,
        episodeCount: null,
        companies: companiesOf(raw.production_companies),
        credits: credits.build(),
        episodes: [],
        trailers: { title: pickTrailer(raw.videos?.results), seasons: {} },
      };
    },

    async tvDetails(id) {
      const raw = decode(TvDetailsSchema, await get(`/tv/${id}`, { append_to_response: 'aggregate_credits,videos' }), `tv ${id}`);
      const credits = new CreditCollector();
      (raw.aggregate_credits?.cast ?? []).forEach((c, i) => {
        const weight = -(c.order ?? i);
        const roles = [...(c.roles ?? [])].sort((a, b) => (b.episode_count ?? 0) - (a.episode_count ?? 0)).slice(0, 2);
        if (roles.length === 0) credits.add('cast', personRef(c), { weight });
        for (const r of roles) credits.add('cast', personRef(c), { character: r.character, weight });
      });
      for (const c of raw.aggregate_credits?.crew ?? []) {
        for (const j of c.jobs ?? []) {
          const role = crewRole(orNull(j.job), orNull(c.department));
          if (role !== null) credits.add(role, personRef(c), { job: j.job, weight: c.total_episode_count ?? 0 });
        }
      }
      for (const c of raw.created_by ?? []) credits.add('creator', personRef(c), { weight: 0 });

      const seasonNumbers = [...new Set((raw.seasons ?? []).map((s) => s.season_number))].sort((a, b) => a - b);
      const episodes: EpisodeMeta[] = [];
      const seasonTrailers: Record<string, string> = {};
      for (const n of seasonNumbers) {
        const season = await seasonDetails(raw.id, n);
        episodes.push(...season.episodes);
        if (season.trailer !== null) seasonTrailers[String(n)] = season.trailer;
      }

      const releaseDate = orNull(raw.first_air_date);
      return {
        kind: 'tv',
        tmdbId: raw.id,
        title: raw.name,
        originalTitle: orNull(raw.original_name) ?? raw.name,
        originalLanguage: orNull(raw.original_language),
        year: yearOf(releaseDate),
        releaseDate,
        overview: raw.overview ?? '',
        posterPath: orNull(raw.poster_path),
        backdropPath: orNull(raw.backdrop_path),
        runtimeMin: positiveOrNull(raw.episode_run_time?.[0]),
        genres: (raw.genres ?? []).map((g) => g.name),
        seasonCount: raw.number_of_seasons ?? null,
        episodeCount: raw.number_of_episodes ?? null,
        companies: companiesOf(raw.production_companies),
        credits: credits.build(),
        episodes,
        trailers: { title: pickTrailer(raw.videos?.results), seasons: seasonTrailers },
      };
    },

    async trailers(kind, id, seasons) {
      const own = decode(VideosSchema, await get(`/${kind}/${id}/videos`, {}), `${kind} ${id} videos`);
      const out: TitleTrailers = { title: pickTrailer(own.results), seasons: {} };
      if (kind === 'movie') return out;
      for (const n of [...new Set(seasons)].sort((a, b) => a - b)) {
        const json = await getOrNull(`/tv/${id}/season/${n}/videos`, {});
        if (json === null) continue;
        const key = pickTrailer(decode(VideosSchema, json, `tv ${id} season ${n} videos`).results);
        if (key !== null) out.seasons[String(n)] = key;
      }
      return out;
    },

    async searchPerson(query) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(PersonSearchSchema, await get('/search/person', { query: q, include_adult: false }), 'person search');
      return (raw.results ?? []).map((r) => ({
        personId: r.id,
        name: r.name,
        knownFor: orNull(r.known_for_department),
        profilePath: orNull(r.profile_path),
        popularity: r.popularity ?? 0,
      }));
    },

    async personCredits(personId) {
      const raw = decode(
        CombinedCreditsSchema,
        await get(`/person/${personId}/combined_credits`, {}),
        `person ${personId} credits`,
      );
      const out: TmdbPersonCredit[] = [];
      for (const c of raw.cast ?? []) {
        const entry = personCredit(c, 'cast');
        if (entry !== null) out.push(entry);
      }
      for (const c of raw.crew ?? []) {
        const entry = personCredit(c, 'crew');
        if (entry !== null) out.push(entry);
      }
      return out;
    },

    async list(name, kind, page = 1) {
      const path = name === 'trending' ? `/trending/${kind}/week` : `/${kind}/popular`;
      return hitsOf(kind, await get(path, { page }), `${kind} ${name} list`);
    },

    async genres(kind) {
      const raw = decode(GenreListSchema, await get(`/genre/${kind}/list`, {}), `${kind} genre list`);
      return (raw.genres ?? []).map((g) => ({ id: g.id, name: g.name }));
    },

    async discoverByGenre(kind, genreId, page = 1) {
      const json = await get(`/discover/${kind}`, {
        with_genres: genreId,
        sort_by: 'popularity.desc',
        'vote_count.gte': DISCOVER_MIN_VOTES,
        include_adult: false,
        page,
      });
      return hitsOf(kind, json, `${kind} discover genre ${genreId}`);
    },

    async recommendations(kind, tmdbId, page = 1) {
      const json = await getOrNull(`/${kind}/${tmdbId}/recommendations`, { page });
      return json === null ? [] : hitsOf(kind, json, `${kind} ${tmdbId} recommendations`);
    },

    async alternativeTitles(kind, tmdbId) {
      const json = await getOrNull(`/${kind}/${tmdbId}/alternative_titles`, {});
      if (json === null) return [];
      const raw = decode(AlternativeTitlesSchema, json, `${kind} ${tmdbId} alternative titles`);
      return [...(raw.titles ?? []), ...(raw.results ?? [])].flatMap((t) => orNull(t.title) ?? []);
    },

    async originalLanguage(kind, tmdbId) {
      const json = await getOrNull(`/${kind}/${tmdbId}`, {});
      return json === null ? null : orNull(decode(OriginalLanguageSchema, json, `${kind} ${tmdbId}`).original_language);
    },

    async imdbId(kind, tmdbId) {
      const json = await getOrNull(`/${kind}/${tmdbId}/external_ids`, {});
      if (json === null) return null;
      const id = orNull(decode(ExternalIdsSchema, json, `${kind} ${tmdbId} external ids`).imdb_id);
      return id !== null && /^tt\d{5,10}$/.test(id) ? id : null;
    },

    async discover(kind, filter) {
      // A film's date is its first release anywhere; a series' is its first air date.
      const date = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
      const json = await get(`/discover/${kind}`, {
        [`${date}.gte`]: filter.dateFrom,
        [`${date}.lte`]: filter.dateTo,
        with_original_language: filter.originalLanguage,
        with_genres: idList(filter.genreIds, ','),
        with_keywords: idList(filter.keywordIds, '|'),
        with_companies: idList(filter.companyIds, '|'),
        with_watch_providers: filter.providerId,
        watch_region: filter.providerId === null || filter.providerId === undefined ? undefined : filter.watchRegion,
        sort_by: filter.sort === 'newest' ? `${date}.desc` : 'popularity.desc',
        include_adult: false,
        page: filter.page ?? 1,
      });
      return hitsOf(kind, json, `${kind} discover`);
    },

    async searchCompany(query) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(CompanySearchSchema, await get('/search/company', { query: q }), 'company search');
      return (raw.results ?? []).map((r) => ({ id: r.id, name: r.name, country: orNull(r.origin_country) }));
    },

    async searchKeyword(query) {
      const q = query.trim();
      if (q === '') return [];
      const raw = decode(KeywordSearchSchema, await get('/search/keyword', { query: q }), 'keyword search');
      return (raw.results ?? []).map((r) => ({ id: r.id, name: r.name, country: null }));
    },

    async watchProviders(kind, region) {
      const raw = decode(WatchProvidersSchema, await get(`/watch/providers/${kind}`, { watch_region: region }), `${kind} watch providers`);
      return [...(raw.results ?? [])]
        .sort((a, b) => (a.display_priority ?? Number.MAX_SAFE_INTEGER) - (b.display_priority ?? Number.MAX_SAFE_INTEGER))
        .map((r) => ({ id: r.provider_id, name: r.provider_name, country: null }));
    },
  };
}
