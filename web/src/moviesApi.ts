import { ApiError } from './api';

/**
 * Movies wire types and fetchers (movies-library phase 6). The read types are phase 4's
 * `src/movies/read.ts` / `src/http/moviesApi.ts` types copied with the same names, fields and
 * nullability (the producer's plan is the authority; the web cannot import server code).
 * `PlayerState` and `ContinueResult` are what this phase expects from phase 5's play routes.
 * Every payload is normalized once, here, where it enters: arrays are always arrays whatever an
 * older server omits. Errors are `ApiError`s whose message is the server's `error` code
 * (`movies_off`, `not_found`, `tmdb_off`, `tmdb_error`, `not_on_this_machine`, `player_unavailable`, `file_missing`).
 */

export type TitleKind = 'movie' | 'tv';
export type WatchState = 'finished' | 'in_progress' | 'unwatched' | 'dropped' | 'removed_unwatched' | 'seen';
export type FileReason = 'too_short' | 'no_match' | 'low_confidence' | 'tmdb_error' | 'no_tmdb_credentials' | 'probe_failed';
export type UnavailableReason = 'not_on_this_machine' | 'deleted';

export interface ProgressView {
  position_s: number | null;
  duration_s: number | null;
  /** 0..1. */
  ratio: number | null;
}

export type TitleProgress =
  | { kind: 'movie'; position_s: number | null; duration_s: number | null; ratio: number | null }
  | { kind: 'tv'; episodes_finished: number; episodes_total: number | null; episodes_present: number };

/** One poster in the grid. */
export interface TitleListItem {
  id: string;
  /** The id the owner reads and types, `M-23T4`. `id` stays the key of routes. Null from a server older than movie ids. */
  movie_id: string | null;
  kind: TitleKind;
  tmdb_id: number;
  title: string;
  year: number | null;
  /** Absolute `https://image.tmdb.org/t/p/w342/...` (w500 in TitleDetail); null when TMDB has none. */
  poster_url: string | null;
  /** 'finished' when the title's watched flag is set. */
  state: WatchState;
  watched: boolean;
  watched_at: string | null;
  /** The owner's "not interested" mark: on the Stream side the title shows only under that filter. */
  not_interested: boolean;
  /** The owner's "interested" mark, the Stream side's watch list. Never true together with not_interested. */
  interested: boolean;
  /** The Stream list only: listed for its "interested" mark alone (no verified source), so it shows under that filter only. */
  interested_only?: boolean;
  rating: number | null;
  progress: TitleProgress;
  /** Newest play start over all its files, any host. */
  last_played_at: string | null;
  finished_at: string | null;
  /** Some file is on this host and not deleted. */
  present_here: boolean;
  /** Files not deleted, any host. 0 = only deleted files are left. */
  file_count: number;
  deleted_file_count: number;
  created_at: string;
}

export interface CompanyView {
  id: number;
  name: string;
  logo_url: string | null;
  origin_country: string | null;
}

/** Jobs joined ', '. */
export interface CrewCredit {
  person_id: number;
  name: string;
  profile_url: string | null;
  job: string | null;
}

/** Characters joined ' / '. */
export interface CastCredit {
  person_id: number;
  name: string;
  profile_url: string | null;
  character: string | null;
}

export interface FileView {
  id: number;
  title_id: string | null;
  host: string;
  path: string;
  name: string;
  size: number | null;
  duration_s: number | null;
  season: number | null;
  episode: number | null;
  absolute_episode: number | null;
  status: 'matched' | 'unmatched' | 'pending';
  reason: FileReason | null;
  source: 'scan' | 'vlc_recents';
  first_seen_at: string;
  last_seen_at: string;
  deleted_at: string | null;
  moved_at: string | null;
  done_at: string | null;
  watched_at: string | null;
  deleted: boolean;
  /** host === this host && not deleted (R3.7). */
  available: boolean;
  /** 'deleted' wins over 'not_on_this_machine'. */
  unavailable_reason: UnavailableReason | null;
  state: WatchState;
  progress: ProgressView;
  /** Where Play starts: 0 = from the beginning (none, or finished). */
  resume_position_s: number;
  last_played_at: string | null;
  finished_at: string | null;
}

export interface EpisodeView {
  /** The episode's own movie id; it has one with or without a file. */
  movie_id: string | null;
  season: number;
  episode: number;
  name: string | null;
  air_date: string | null;
  runtime_min: number | null;
  overview: string | null;
  still_url: string | null;
  /** 'finished' if any of its files is; else its primary file's; 'unwatched' with no file. */
  state: WatchState;
  /** The owner's manual "finished" mark on this episode. */
  watched: boolean;
  /** A story of this episode is stored: opening it calls no model. Absent from a server older than stories. */
  has_story?: boolean;
  has_file: boolean;
  present_here: boolean;
  /** It has files and every one is deleted. */
  deleted: boolean;
  progress: ProgressView;
  last_played_at: string | null;
  finished_at: string | null;
  /** The primary file (what Play acts on). */
  file_id: number | null;
  files: FileView[];
}

export interface SeasonView {
  season: number;
  /** YouTube video id of this season's trailer; null when TMDB lists none. */
  trailer_key: string | null;
  episodes: EpisodeView[];
}

export interface PlayView {
  id: number;
  file_id: number | null;
  title_id: string | null;
  title: string | null;
  kind: TitleKind | null;
  season: number | null;
  episode: number | null;
  episode_name: string | null;
  /** The episode that was played, or the film. */
  movie_id: string | null;
  file_name: string | null;
  file_deleted: boolean;
  file_deleted_at: string | null;
  host: string;
  source: 'live' | 'vlc_recents' | 'stream';
  /** The direct-stream provider of a stream play (no file); null for a VLC play. */
  provider: string | null;
  started_at: string;
  ended_at: string | null;
  start_position_s: number | null;
  position_s: number | null;
  duration_s: number | null;
  ratio: number | null;
}

/**
 * One of this machine's stream sources (phase 5's `movie_stream_sources` row, as `GET /api/movies/:id`
 * answers it). A film's is season 0, episode 0. `fresh`: verified inside the freshness window, not
 * stale, and direct streaming is on: what the Stream side counts as playable.
 */
export interface StreamSourceView {
  host: string;
  season: number;
  episode: number;
  provider: string;
  manifest_kind: string;
  best_height: number | null;
  en_subtitle: boolean;
  verified_at: string;
  stale_at: string | null;
  fresh: boolean;
}

export interface TitleDetail extends TitleListItem {
  original_title: string;
  release_date: string | null;
  overview: string;
  runtime_min: number | null;
  genres: string[];
  backdrop_url: string | null;
  /** YouTube video id of the title's trailer; null when TMDB lists none. */
  trailer_key: string | null;
  trailer_url: string | null;
  season_count: number | null;
  episode_count: number | null;
  /** The review note's text; '' when none. */
  review: string;
  review_note_id: string | null;
  companies: CompanyView[];
  directors: CrewCredit[];
  writers: CrewCredit[];
  producers: CrewCredit[];
  creators: CrewCredit[];
  cast: CastCredit[];
  /** Every file, any host, deleted included. */
  files: FileView[];
  /** tv: ascending; movie: []. */
  seasons: SeasonView[];
  /** tv files with no season/episode; movie: []. */
  unplaced_files: FileView[];
  plays: PlayView[];
  /** This machine's verified stream sources, in season and episode order; [] when none. */
  stream_sources: StreamSourceView[];
  /** How the title was last played on this machine; null: never. Play goes there again unless another source is named. */
  played_through: PlayedThrough | null;
  /** When each kind of stream last found nothing for the title on this machine; null: never, or it played since. */
  stream_failed: { cloud_at: string | null; torrent_at: string | null };
  /** What last played the title through each stream method here (`cloud`, `torrent`, a site's name), newest first. */
  played_methods: PlayedMethod[];
  metadata_fetched_at: string | null;
}

/** One stream method's last play of a title on this machine. `provider` names the cloud provider. */
export interface PlayedMethod {
  method: string;
  provider: string | null;
  played_at: string;
  season: number | null;
  episode: number | null;
}

/**
 * How a title was last played on this machine: a downloaded file in VLC, a cloud provider's stream
 * (`provider` names it), a torrent, or a streaming site (`provider` names it: `dramacool`).
 * `season` and `episode` are that play's; null for a film.
 */
export interface PlayedThrough {
  channel: 'vlc' | 'cloud' | 'torrent' | 'site';
  provider: string | null;
  played_at: string;
  season: number | null;
  episode: number | null;
}

export interface ParsedView {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  absolute_episode: number | null;
  kind_hint: TitleKind | null;
}

export interface UnmatchedFile {
  id: number;
  host: string;
  path: string;
  name: string;
  size: number | null;
  duration_s: number | null;
  status: 'unmatched' | 'pending';
  reason: FileReason | null;
  parsed: ParsedView | null;
  first_seen_at: string;
  last_seen_at: string;
  available: boolean;
}

export interface TmdbHitView {
  kind: TitleKind;
  tmdb_id: number;
  title_id: string;
  title: string;
  original_title: string;
  year: number | null;
  overview: string;
  poster_url: string | null;
  in_library: boolean;
}

export interface StatusCounts {
  titles: number;
  files_here: number;
  unmatched_here: number;
  pending_here: number;
}

/** The fields of phase 3's `SyncReport` the page may show (the server sends more). */
export interface SyncReport {
  started_at: string;
  finished_at: string;
  new: number;
  moved: number;
  deleted: number;
  done: number;
  matched: number;
  unmatched: number;
  pending: number;
  waiting: number;
  error: string | null;
}

export type TmdbHealth = 'ok' | 'no_credentials' | 'unreachable';

/** Phase 3's `MoviesStatus` plus phase 4's `counts` (reconciled). */
export interface MoviesStatusResponse {
  host: string;
  roots: string[];
  done_dirs: string[];
  scan_ms: number;
  min_seconds: number;
  /** The poll loop runs (started, at least one root). */
  scanning: boolean;
  /** A pass is running now. */
  running: boolean;
  tmdb: TmdbHealth;
  next_pass_at: string | null;
  last_pass: SyncReport | null;
  counts: StatusCounts;
}

export interface TitleListResponse {
  titles: TitleListItem[];
}

export interface UnmatchedResponse {
  files: UnmatchedFile[];
}

export interface TmdbSearchResponse {
  results: TmdbHitView[];
}

export interface FileChangeResponse {
  file_id: number;
  title: TitleDetail | null;
}

/** `data:` of each `event: changed` on `GET /api/movies/events` (phase 3's MovieChangeEvent). The page only refetches. */
export interface MovieChangeWire {
  type: 'changed';
  reason: 'sync' | 'assign' | 'user' | 'play' | 'stream';
  title_ids: string[];
  file_ids: number[];
}

/** Phase 5's `PlayerSnapshot`: the VLC that notesd started and tracks, if any. */
export interface PlayerSnapshot {
  play_id: number;
  file_id: number;
  title_id: string | null;
  name: string;
  port: number;
  state: 'playing' | 'paused' | 'stopped';
  /** Seconds. */
  position: number;
  duration: number | null;
  started_at: string;
  last_read_at: string | null;
  /** VLC says it plays and its clock advances, but it shows no new frame (its video device was removed). */
  video_stalled?: boolean;
}

/** The stream on screen in notesd's player page (direct streaming): the twin of `PlayerSnapshot`. */
export interface StreamLiveSnapshot {
  session_id: string;
  title_id: string;
  /** Null for a film. */
  season: number | null;
  episode: number | null;
  provider: string;
  state: 'playing' | 'paused';
  /** Seconds. */
  position: number;
  duration: number | null;
  last_report_at: string;
}

/** Phase 5's `GET /api/movies/player`. `available` false = no vlc.exe, interop or curl.exe on this machine. */
export interface PlayerState {
  available: boolean;
  reason: string | null;
  current: PlayerSnapshot | null;
  /** The stream the player page shows now; null when none (absent from an older daemon). */
  stream?: StreamLiveSnapshot | null;
  /** The stream plays being started: asked for and still resolving, or opened with a page that does not report yet (absent from an older daemon). */
  starting?: StartingPlay[];
}

/** One stream play the daemon is starting, with what it is doing right now. */
export interface StartingPlay {
  kind: TitleKind;
  tmdb_id: number;
  season: number | null;
  episode: number | null;
  title: string;
  provider: string | null;
  since: string;
  /** "asking the torrent indexes", "opening 3 torrents", "opening the player page". */
  stage: string;
}

export interface ContinueTitleRef {
  id: string;
  title: string;
  kind: TitleKind;
  year: number | null;
}

export interface ContinueEpisodeRef {
  file_id: number | null;
  season: number | null;
  episode: number | null;
  absolute_episode: number | null;
  name: string | null;
}

/** Phase 5's `POST /api/movies/continue` answer (`play` is the 202 body of the play route; the page ignores it). */
export type ContinueResult =
  | { action: 'resumed' | 'started' | 'already_playing'; title: ContinueTitleRef; file: ContinueEpisodeRef; position: number; play: unknown }
  | { action: 'missing'; title: ContinueTitleRef; missing: ContinueEpisodeRef; present: ContinueEpisodeRef[] }
  | { action: 'nothing'; title: ContinueTitleRef; reason: 'finished' | 'caught_up' | 'no_episodes'; finished_at: string | null; last: ContinueEpisodeRef | null }
  | { action: 'ambiguous'; query: string; candidates: ContinueTitleRef[] }
  | { action: 'no_match'; query: string | null };

/** One key per call (phase 4 accepts any subset; the page sends one change at a time). */
export type TitleUserPatch = { watched: boolean } | { not_interested: boolean } | { interested: boolean } | { rating: number } | { review: string };

export type AssignBody = { kind: 'movie'; tmdb_id: number } | { kind: 'tv'; tmdb_id: number; season?: number; episode?: number };

/** `GET /api/movies/stream`. Off is an answer, not an error: the page says how to turn it on. */
export type StreamListResponse =
  | { enabled: true; titles: TitleListItem[]; fresh_days: number; /** Titles played on a streaming site that TMDB does not list; absent reads as none. */ site_titles?: SiteTitle[] }
  | { enabled: false; reason: 'direct_stream_off'; titles: TitleListItem[] };

/**
 * A title played on a streaming site that TMDB does not list: it has no title page, only what the
 * site's own page says of it. `season` and `episode` are the episode last played; null for a film.
 */
export interface SiteTitle {
  id: number;
  site: string;
  site_url: string;
  kind: 'movie' | 'series';
  name: string;
  year: number | null;
  poster_url: string | null;
  overview: string;
  country: string | null;
  status: string | null;
  genres: string[];
  also_known: string | null;
  season: number | null;
  episode: number | null;
  played_at: string;
}

/** The body of phase 3's `POST /api/stream/play`. A series always names its episode. `provider` asks that one provider only (`torrent`). */
export type StreamRef = ({ kind: 'movie'; tmdb_id: number } | { kind: 'tv'; tmdb_id: number; season: number; episode: number }) & { provider?: string };

/** One poster of the Trending section: the grid's shape plus what the indexes listed of its torrent. */
export interface TrendingTitle extends TitleListItem {
  trending: {
    kind_rank: number;
    seeds: number;
    index: string;
    release: string;
    size_bytes: number | null;
    listed_at: string;
  };
}

/** `GET /api/movies/trending`. Off is an answer, not an error. */
export type TrendingListResponse =
  | { enabled: true; titles: TrendingTitle[]; listed_at: string | null; running: boolean }
  | { enabled: false; reason: string; titles: TrendingTitle[]; listed_at: null };

export const MOVIES_EVENTS_URL = '/api/movies/events';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };
const ZERO_COUNTS: StatusCounts = { titles: 0, files_here: 0, unmatched_here: 0, pending_here: 0 };

/** The server's `error` code of a failed call (`movies_off`, ...), or the thrown message. */
export function errorCode(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** The server's `message` of a failed call (the play route says why the player is unavailable), or null. */
export function errorDetail(e: unknown): string | null {
  return e instanceof ApiError ? e.detail : null;
}

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  let detail: string | null = null;
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object') {
      const o = j as { error?: unknown; message?: unknown };
      if (typeof o.error === 'string') msg = o.error;
      if (typeof o.message === 'string' && o.message.trim() !== '') detail = o.message;
    }
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg, detail);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

/** POST JSON; resolves to the parsed body, or null when there is none (a bare 202). */
async function postJson<T>(url: string, body: unknown): Promise<T | null> {
  const res = await fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function list<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

function normalizeDetail(d: TitleDetail): TitleDetail {
  return {
    ...d,
    genres: list(d.genres),
    review: d.review ?? '',
    companies: list(d.companies),
    directors: list(d.directors),
    writers: list(d.writers),
    producers: list(d.producers),
    creators: list(d.creators),
    cast: list(d.cast),
    files: list(d.files),
    seasons: list(d.seasons).map((s) => ({ ...s, episodes: list(s.episodes).map((e) => ({ ...e, files: list(e.files) })) })),
    unplaced_files: list(d.unplaced_files),
    plays: list(d.plays),
    stream_sources: list(d.stream_sources),
    played_through: d.played_through ?? null,
    stream_failed: { cloud_at: d.stream_failed?.cloud_at ?? null, torrent_at: d.stream_failed?.torrent_at ?? null },
    played_methods: list(d.played_methods),
  };
}

export async function fetchMovies(signal?: AbortSignal): Promise<TitleListItem[]> {
  const j = await getJson<TitleListResponse>('/api/movies', signal);
  return list(j.titles);
}

export async function fetchMovie(id: string, signal?: AbortSignal): Promise<TitleDetail> {
  return normalizeDetail(await getJson<TitleDetail>(`/api/movies/${enc(id)}`, signal));
}

export async function fetchUnmatched(signal?: AbortSignal): Promise<UnmatchedFile[]> {
  const j = await getJson<UnmatchedResponse>('/api/movies/unmatched', signal);
  return list(j.files);
}

export async function fetchStatus(signal?: AbortSignal): Promise<MoviesStatusResponse> {
  const s = await getJson<MoviesStatusResponse>('/api/movies/status', signal);
  return { ...s, roots: list(s.roots), counts: s.counts ?? ZERO_COUNTS };
}

/** Phase 5's player state. Anything but `available: false` reads as available (the play route still answers `player_unavailable`). */
export async function fetchPlayer(signal?: AbortSignal): Promise<PlayerState> {
  const p = await getJson<Partial<PlayerState>>('/api/movies/player', signal);
  return { available: p.available !== false, reason: typeof p.reason === 'string' ? p.reason : null, current: p.current ?? null, stream: p.stream ?? null, starting: Array.isArray(p.starting) ? p.starting : [] };
}

export async function searchTmdb(q: string, kind: TitleKind, signal?: AbortSignal): Promise<TmdbHitView[]> {
  const j = await getJson<TmdbSearchResponse>(`/api/movies/search-tmdb?q=${enc(q)}&kind=${kind}`, signal);
  return list(j.results);
}

export async function saveTitleUser(id: string, patch: TitleUserPatch): Promise<void> {
  await postJson<TitleDetail>(`/api/movies/${enc(id)}/user`, patch);
}

/** saveTitleUser, answering the title as it is after the change. */
export async function markTitle(id: string, patch: TitleUserPatch): Promise<TitleDetail> {
  const d = await postJson<TitleDetail>(`/api/movies/${enc(id)}/user`, patch);
  if (d === null) throw new Error('not_saved');
  return d;
}

export interface EpisodeRef {
  season: number;
  episode: number;
}

/**
 * Marks a whole season, or the listed episodes, finished or not. Resolves to the episodes whose
 * mark changed: sending them back with `watched` flipped undoes exactly this call.
 */
export async function setEpisodesWatched(titleId: string, target: { season: number } | { episodes: EpisodeRef[] }, watched: boolean): Promise<EpisodeRef[]> {
  const j = await postJson<{ changed?: EpisodeRef[] }>(`/api/movies/${enc(titleId)}/episodes/watched`, { ...target, watched });
  return list(j?.changed);
}

/** The story of a film or an episode, written by Claude from its dialogue (`POST /api/movies/:id/story`). */
export interface StoryView {
  season: number;
  episode: number;
  /** Plain paragraphs, separated by a blank line. */
  text: string;
  model: string | null;
  written_at: string | null;
  /** The stream provider whose subtitle it was written from, and how many lines that was. */
  provider: string;
  cues: number;
}

/**
 * The story of one episode: the stored one, else the daemon reads the dialogue and has it written
 * (a model call, up to a few minutes), then keeps it. `cached` is false only for a story this
 * call had written. Throws ApiError: `story_off`, `no_subtitle`, `no_source`, `story_failed`, ...
 */
export async function writeStory(titleId: string, season: number, episode: number): Promise<{ story: StoryView; cached: boolean }> {
  const j = await postJson<{ story?: StoryView | null; cached?: boolean }>(`/api/movies/${enc(titleId)}/story`, { season, episode });
  if (j === null || j.story === null || j.story === undefined) throw new ApiError(502, 'story_failed', 'The daemon answered no story.');
  return { story: j.story, cached: j.cached === true };
}

export async function setFileWatched(fileId: number, watched: boolean): Promise<void> {
  await postJson<FileChangeResponse>(`/api/movies/files/${fileId}/watched`, { watched });
}

/** Resolves to the id of the title the file went to (null when the answer does not say). */
export async function assignFile(fileId: number, body: AssignBody): Promise<string | null> {
  const r = await postJson<FileChangeResponse>(`/api/movies/files/${fileId}/assign`, body);
  return r?.title?.id ?? null;
}

/** Starts one sync pass; phase 4 answers 202 at once and the result arrives as SSE `changed`. */
export async function startSync(): Promise<void> {
  await postJson<unknown>('/api/movies/sync', {});
}

/** True when no VLC was started: the file was already open in the VLC notesd follows, which came to the front. */
export async function playFile(fileId: number): Promise<boolean> {
  const r = await postJson<{ play?: { already_playing?: boolean } }>(`/api/movies/files/${fileId}/play`, {});
  return r?.play?.already_playing === true;
}

export async function continueTitle(titleId: string): Promise<ContinueResult> {
  const r = await postJson<ContinueResult>('/api/movies/continue', { title: titleId });
  return r ?? { action: 'no_match', query: titleId };
}

/** The Stream side's titles. Anything but a well-formed `enabled: true` reads as off. */
export async function fetchStreamTitles(signal?: AbortSignal): Promise<StreamListResponse> {
  const j = await getJson<{ enabled?: unknown; titles?: TitleListItem[] | null; fresh_days?: unknown; site_titles?: SiteTitle[] | null }>('/api/movies/stream', signal);
  if (j.enabled === true && typeof j.fresh_days === 'number') return { enabled: true, titles: list(j.titles), fresh_days: j.fresh_days, site_titles: list(j.site_titles) };
  return { enabled: false, reason: 'direct_stream_off', titles: [] };
}

/** The Stream side's Trending section. Anything but a well-formed `enabled: true` reads as off. */
export async function fetchTrending(signal?: AbortSignal): Promise<TrendingListResponse> {
  const j = await getJson<{ enabled?: unknown; reason?: unknown; titles?: TrendingTitle[] | null; listed_at?: unknown; status?: { running?: unknown } | null }>('/api/movies/trending', signal);
  if (j.enabled === true) {
    return {
      enabled: true,
      titles: list(j.titles),
      listed_at: typeof j.listed_at === 'string' ? j.listed_at : null,
      running: j.status?.running === true,
    };
  }
  return { enabled: false, reason: typeof j.reason === 'string' ? j.reason : 'setting_off', titles: [], listed_at: null };
}

/** Asks for a new trending list now (the section's refresh icon). Throws `trending_off` when the job is off. */
export async function askTrendingRefresh(): Promise<void> {
  await postJson<unknown>('/api/movies/trending/refresh', {});
}

/** Plays a title TMDB does not list on its streaming site again: the film, or `episode` (none: the one after the last played). Throws ApiError `no_episode`, `not_playing`, `streaming_off`. */
export async function playSiteTitle(id: number, episode?: number): Promise<{ episode: number | null }> {
  const r = await postJson<{ episode?: unknown }>(`/api/movies/site-titles/${id}/play`, episode === undefined ? {} : { episode });
  return { episode: typeof r?.episode === 'number' ? r.episode : null };
}

/** Takes a title TMDB does not list off this machine's Stream side. */
export async function removeSiteTitle(id: number): Promise<void> {
  const res = await fetch(`/api/movies/site-titles/${id}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
}

/** Phase 3: resolve the title and open the player page full screen in the streaming Chrome. Throws ApiError `no_source`, `direct_stream_off`, ... */
export async function streamPlay(ref: StreamRef & { magnet?: string }): Promise<{ site: string | null }> {
  const r = await postJson<{ site?: unknown }>('/api/stream/play', ref);
  // A title last played on a streaming site plays there again: the answer names the site and carries no session.
  return { site: typeof r?.site === 'string' ? r.site : null };
}

/** One torrent of a film or episode, as the candidates list shows it (GET /api/stream/torrents). */
export interface TorrentCandidateView {
  info_hash: string;
  name: string;
  height: number | null;
  size_bytes: number | null;
  seeds: number | null;
  scrape: { seeders: number; leechers: number } | null;
  from: string[];
  audio: { languages: string[]; how: 'heard' | 'tags' | 'name' | 'unknown'; heard_probability: number | null };
  worked: boolean;
  failed: string | null;
  blacklisted: { at: string; reason: string | null } | null;
  dub_group: string | null;
  heard_dub: boolean;
  dub_named: boolean;
  left_out: string | null;
  remembered: boolean;
  on_disk: boolean;
}

export interface TorrentCandidatesView {
  original_language: string | null;
  listed_at: string | null;
  cached: boolean;
  candidates: TorrentCandidateView[];
}

/** The torrent candidates of a film or episode; `fresh` asks the indexes now. Throws ApiError `torrent_off`, `direct_stream_off`. */
export async function fetchTorrentCandidates(ref: StreamRef, fresh = false): Promise<TorrentCandidatesView> {
  const q = new URLSearchParams({ kind: ref.kind, tmdb_id: String(ref.tmdb_id) });
  if (ref.kind === 'tv') {
    q.set('season', String(ref.season));
    q.set('episode', String(ref.episode));
  }
  if (fresh) q.set('fresh', '1');
  const r = await getJson<Partial<TorrentCandidatesView>>(`/api/stream/torrents?${q.toString()}`);
  return { original_language: r.original_language ?? null, listed_at: r.listed_at ?? null, cached: r.cached === true, candidates: list(r.candidates) };
}

/** Blacklists a torrent for every title; the titles that remembered it forget it. */
export async function blacklistTorrent(infoHash: string, reason: string | null, name: string | null): Promise<void> {
  await postJson(`/api/stream/torrents/${encodeURIComponent(infoHash)}/blacklist`, { reason, name });
}

/** Takes a torrent off the blacklist. */
export async function unblacklistTorrent(infoHash: string): Promise<void> {
  const res = await fetch(`/api/stream/torrents/${encodeURIComponent(infoHash)}/blacklist`, { method: 'DELETE', headers: JSON_HEADERS });
  if (!res.ok) throw await failure(res);
}

/** The streaming sites a title can be played on by name, in the play menu's order. */
export const STREAMING_SITES = ['idlix', 'lk21', 'flicksy', 'dramacool'] as const;
export type StreamingSite = (typeof STREAMING_SITES)[number];

/** Plays the title on one named streaming site (a series: that episode). Throws ApiError `no_match`, `several_matches`, `no_episode`, `series`, `not_playing`, `streaming_off`. */
export async function sitePlay(titleId: string, site: StreamingSite, slot: { season: number; episode: number } | null): Promise<void> {
  await postJson(`/api/movies/${encodeURIComponent(titleId)}/site-play`, slot === null ? { site } : { site, ...slot });
}

export interface PaheMatch {
  title: string;
  url: string;
  year: number | null;
  release: string | null;
}

/** The title's download pages on pahe.ink, best source first. Throws ApiError `pahe_error`. */
export async function fetchPahe(titleId: string): Promise<{ matches: PaheMatch[]; search_url: string | null }> {
  const r = await getJson<{ matches?: PaheMatch[]; search_url?: string | null }>(`/api/movies/${encodeURIComponent(titleId)}/pahe`);
  return { matches: list(r.matches), search_url: r.search_url ?? null };
}

/** What the owner did with a listed title; null: nothing, or it is not stored. */
export type GuideMark = 'watched' | 'not_interested' | 'started';

export interface GuideTitle {
  kind: TitleKind;
  tmdb_id: number;
  title_id: string;
  title: string;
  year: number | null;
  release_date: string | null;
  poster_url: string | null;
  /** A person's roles in it, or why a genre's guide lists it. */
  note: string | null;
  /** Null until the title is stored (`ensureTitle`). */
  movie_id: string | null;
  mark: GuideMark | null;
  /** The "interested" mark (the watch list); it stands beside `mark`. */
  interested: boolean;
  has_file: boolean;
}

export interface GuideEntity {
  kind: 'person' | 'company' | 'genre';
  name: string;
  image_url: string | null;
  description: string;
  facts: string[];
  link: string | null;
}

/** Who a person or a studio is, or what a genre means for one title, with its titles newest first. */
export interface EntityGuide {
  entity: GuideEntity;
  titles: GuideTitle[];
  written_at?: string | null;
  model?: string | null;
}

function normalizeGuide(g: EntityGuide): EntityGuide {
  return { ...g, entity: { ...g.entity, description: g.entity.description ?? '', facts: list(g.entity.facts) }, titles: list(g.titles).map((t) => ({ ...t, interested: t.interested ?? false })) };
}

export async function fetchPersonGuide(personId: number, signal?: AbortSignal): Promise<EntityGuide> {
  return normalizeGuide(await getJson<EntityGuide>(`/api/movies/people/${personId}`, signal));
}

export async function fetchCompanyGuide(companyId: number, signal?: AbortSignal): Promise<EntityGuide> {
  return normalizeGuide(await getJson<EntityGuide>(`/api/movies/companies/${companyId}`, signal));
}

const genreUrl = (titleId: string, genre: string): string => `/api/movies/${encodeURIComponent(titleId)}/genres/${encodeURIComponent(genre)}`;

/** The stored guide of a genre for one title; null when it was never written. Never calls a model. */
export async function fetchGenreGuide(titleId: string, genre: string, signal?: AbortSignal): Promise<EntityGuide | null> {
  const r = await getJson<{ guide: EntityGuide | null }>(genreUrl(titleId, genre), signal);
  return r.guide === null || r.guide === undefined ? null : normalizeGuide(r.guide);
}

/** Has the guide collated with web search (about a minute) and kept; `refresh` replaces the stored one. Throws ApiError `guide_off`, `guide_failed`. */
export async function writeGenreGuide(titleId: string, genre: string, refresh = false): Promise<EntityGuide> {
  const r = await postJson<{ guide: EntityGuide }>(genreUrl(titleId, genre), refresh ? { refresh: true } : {});
  if (r === null || r.guide === null || r.guide === undefined) throw new Error('guide_failed');
  return normalizeGuide(r.guide);
}

/** Stores a title the library does not hold yet and answers its movie id, so its pop-up can open. Throws ApiError `not_stored`. */
export async function ensureTitle(kind: TitleKind, tmdbId: number): Promise<string> {
  const r = await postJson<{ movie_id?: string | null }>('/api/movies/ensure', { kind, tmdb_id: tmdbId });
  if (r === null || typeof r.movie_id !== 'string') throw new Error('not_stored');
  return r.movie_id;
}

// ---------- the Cache page (GET /api/stream/disk) ----------

export type DiskKind = 'torrent' | 'cloud';

export interface DiskEpisode {
  season: number;
  episode: number;
  movie_id: string | null;
  name: string | null;
  bytes: number;
  kinds: DiskKind[];
  watched: boolean;
  playing: boolean;
  in_use: boolean;
}

export interface DiskSeason {
  season: number;
  bytes: number;
  shared_bytes: number;
  kinds: DiskKind[];
  watched: boolean;
  playing: boolean;
  in_use: boolean;
  episodes: DiskEpisode[];
}

export interface DiskTitle {
  title_id: string;
  movie_id: string | null;
  kind: TitleKind;
  tmdb_id: number;
  title: string;
  year: number | null;
  poster_url: string | null;
  stored: boolean;
  bytes: number;
  torrent_bytes: number;
  cloud_bytes: number;
  kinds: DiskKind[];
  watched: boolean;
  not_interested: boolean;
  playing: boolean;
  in_use: boolean;
  seasons: DiskSeason[];
  shared_bytes: number;
}

export interface DiskDeletion {
  id: string;
  label: string;
  bytes: number;
  execute_at: string;
  skipped: string[];
}

export interface DiskView {
  host: string;
  total_bytes: number;
  torrent_bytes: number;
  cloud_bytes: number;
  unnamed_bytes: number;
  budget_bytes: number | null;
  titles: DiskTitle[];
  bulk: { watched: { bytes: number; titles: number }; not_interested: { bytes: number; titles: number } };
  pending: DiskDeletion[];
  undo_ms: number;
}

export type DiskScope = { title_id: string; season?: number; episode?: number } | { bulk: 'watched' | 'not_interested' };

/** What this machine keeps on disk for streaming. Throws ApiError `stream_disk_off`. */
export async function fetchStreamDisk(signal?: AbortSignal): Promise<DiskView> {
  const v = await getJson<Partial<DiskView>>('/api/stream/disk', signal);
  return {
    host: v.host ?? '',
    total_bytes: v.total_bytes ?? 0,
    torrent_bytes: v.torrent_bytes ?? 0,
    cloud_bytes: v.cloud_bytes ?? 0,
    unnamed_bytes: v.unnamed_bytes ?? 0,
    budget_bytes: v.budget_bytes ?? null,
    titles: list(v.titles).map((t) => ({ ...t, seasons: list(t.seasons).map((s) => ({ ...s, episodes: list(s.episodes) })) })),
    bulk: v.bulk ?? { watched: { bytes: 0, titles: 0 }, not_interested: { bytes: 0, titles: 0 } },
    pending: list(v.pending),
    undo_ms: v.undo_ms ?? 10_000,
  };
}

/** Deletes a title, season or episode (or a bulk set) after the undo window. Throws ApiError `in_use`, `nothing_cached`. */
export async function deleteStreamDisk(scope: DiskScope): Promise<DiskDeletion> {
  const r = await postJson<{ deletion: DiskDeletion }>('/api/stream/disk/delete', scope);
  if (r === null) throw new Error('no answer');
  return r.deletion;
}

/** Cancels a pending deletion. Throws ApiError `unknown_deletion` once it was carried out. */
export async function undoStreamDisk(id: string): Promise<void> {
  const res = await fetch(`/api/stream/disk/deletions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: JSON_HEADERS });
  if (!res.ok) throw await failure(res);
}
