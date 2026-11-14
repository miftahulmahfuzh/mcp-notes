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
  season: number;
  episode: number;
  name: string | null;
  air_date: string | null;
  runtime_min: number | null;
  overview: string | null;
  still_url: string | null;
  /** 'finished' if any of its files is; else its primary file's; 'unwatched' with no file. */
  state: WatchState;
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
  episodes: EpisodeView[];
}

export interface PlayView {
  id: number;
  file_id: number;
  title_id: string | null;
  title: string | null;
  kind: TitleKind | null;
  season: number | null;
  episode: number | null;
  episode_name: string | null;
  file_name: string;
  file_deleted: boolean;
  file_deleted_at: string | null;
  host: string;
  source: 'live' | 'vlc_recents';
  started_at: string;
  ended_at: string | null;
  start_position_s: number | null;
  position_s: number | null;
  duration_s: number | null;
  ratio: number | null;
}

export interface TitleDetail extends TitleListItem {
  original_title: string;
  release_date: string | null;
  overview: string;
  runtime_min: number | null;
  genres: string[];
  backdrop_url: string | null;
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
  metadata_fetched_at: string | null;
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
  reason: 'sync' | 'assign' | 'user' | 'play';
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
}

/** Phase 5's `GET /api/movies/player`. `available` false = no vlc.exe, interop or curl.exe on this machine. */
export interface PlayerState {
  available: boolean;
  reason: string | null;
  current: PlayerSnapshot | null;
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
  | { action: 'resumed' | 'started'; title: ContinueTitleRef; file: ContinueEpisodeRef; position: number; play: unknown }
  | { action: 'missing'; title: ContinueTitleRef; missing: ContinueEpisodeRef; present: ContinueEpisodeRef[] }
  | { action: 'nothing'; title: ContinueTitleRef; reason: 'finished' | 'caught_up' | 'no_episodes'; finished_at: string | null; last: ContinueEpisodeRef | null }
  | { action: 'ambiguous'; query: string; candidates: ContinueTitleRef[] }
  | { action: 'no_match'; query: string | null };

/** One key per call (phase 4 accepts any subset; the page sends one change at a time). */
export type TitleUserPatch = { watched: boolean } | { rating: number } | { review: string };

export type AssignBody = { kind: 'movie'; tmdb_id: number } | { kind: 'tv'; tmdb_id: number; season?: number; episode?: number };

export const MOVIES_EVENTS_URL = '/api/movies/events';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };
const ZERO_COUNTS: StatusCounts = { titles: 0, files_here: 0, unmatched_here: 0, pending_here: 0 };

/** The server's `error` code of a failed call (`movies_off`, ...), or the thrown message. */
export function errorCode(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') msg = (j as { error: string }).error;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg);
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
  return { available: p.available !== false, reason: typeof p.reason === 'string' ? p.reason : null, current: p.current ?? null };
}

export async function searchTmdb(q: string, kind: TitleKind, signal?: AbortSignal): Promise<TmdbHitView[]> {
  const j = await getJson<TmdbSearchResponse>(`/api/movies/search-tmdb?q=${enc(q)}&kind=${kind}`, signal);
  return list(j.results);
}

export async function saveTitleUser(id: string, patch: TitleUserPatch): Promise<void> {
  await postJson<TitleDetail>(`/api/movies/${enc(id)}/user`, patch);
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

export async function playFile(fileId: number): Promise<void> {
  await postJson<unknown>(`/api/movies/files/${fileId}/play`, {});
}

export async function continueTitle(titleId: string): Promise<ContinueResult> {
  const r = await postJson<ContinueResult>('/api/movies/continue', { title: titleId });
  return r ?? { action: 'no_match', query: titleId };
}
