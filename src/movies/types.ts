import type {
  MovieCreditRole,
  MovieFileReason,
  MovieFileRow,
  MovieFileSource,
  MovieFileStatus,
  MovieParsedName,
  MoviePlayRow,
  MoviePlaySource,
  MovieStreamSourceRow,
  MovieTitleKind,
} from '../db/schema.js';

/**
 * The movies subsystem's shared vocabulary (MOVIES_LIBRARY_PLAN phase 1). The closed sets live
 * next to their tables in src/db/schema.ts, whose CHECK constraints enforce them; this module
 * names them for src/movies and holds the shapes that cross phases (`TitleMetadata` is what a
 * TMDB match stores, phase 2 builds it, `MoviesRepo.upsertTitle` writes it).
 */

export type { MovieFileRow, MoviePlayRow, MovieStreamSourceRow, MovieTitleRow } from '../db/schema.js';

export type TitleKind = MovieTitleKind;
export type FileStatus = MovieFileStatus;
export type FileReason = MovieFileReason;
export type FileSource = MovieFileSource;
export type PlaySource = MoviePlaySource;
/** A file play's source. A `stream` play has no file (MoviesRepo.recordStreamPosition writes it). */
export type FilePlaySource = Exclude<PlaySource, 'stream'>;
export type CreditRole = MovieCreditRole;
/** What the filename parser read, as stored in `movie_files.parsed`. */
export type ParsedNameRecord = MovieParsedName;

/**
 * A file's (or title's) watch state, derived at read time (src/movies/state.ts), never stored.
 * `seen`: deleted, and every play of it was "opened, position unknown" (a VLC recents entry
 * with time 0 or -1); counted as seen in history but shown as uncertain.
 */
export const WATCH_STATES = ['finished', 'in_progress', 'unwatched', 'dropped', 'removed_unwatched', 'seen'] as const;
export type WatchState = (typeof WATCH_STATES)[number];

/** Largest TMDB id `movie_titles.tmdb_id` (int4) holds. */
const MAX_TMDB_ID = 2_147_483_647;
const TITLE_ID = /^(movie|tv)-([1-9][0-9]*)$/;

/** The id of a title: `movie-<tmdb id>` or `tv-<tmdb id>`. The only way a title id is made. */
export function titleId(kind: TitleKind, tmdbId: number): string {
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0 || tmdbId > MAX_TMDB_ID) {
    throw new RangeError(`TMDB id must be a positive integer, got ${tmdbId}`);
  }
  return `${kind}-${tmdbId}`;
}

/** The kind and TMDB id of a title id, or null when `id` is not one `titleId` could have made. */
export function parseTitleId(id: string): { kind: TitleKind; tmdbId: number } | null {
  const m = TITLE_ID.exec(id);
  if (m === null) return null;
  const tmdbId = Number(m[2]);
  if (!Number.isSafeInteger(tmdbId) || tmdbId > MAX_TMDB_ID) return null;
  return { kind: m[1] as TitleKind, tmdbId };
}

/** A production company as TMDB lists it. */
export interface CompanyMeta {
  id: number;
  name: string;
  logoPath: string | null;
  originCountry: string | null;
}

/** One credit as TMDB lists it, in billing order. `character` is set for cast, `job` for crew. */
export interface CreditMeta {
  personId: number;
  name: string;
  profilePath: string | null;
  role: CreditRole;
  character: string | null;
  job: string | null;
}

/** One episode of a series. */
export interface EpisodeMeta {
  season: number;
  episode: number;
  name: string;
  /** `YYYY-MM-DD`. */
  airDate: string | null;
  runtimeMin: number | null;
  overview: string | null;
  stillPath: string | null;
}

/** The trailers TMDB lists for one title, as YouTube video ids. */
export interface TitleTrailers {
  /** The film's or the series' own trailer. */
  title: string | null;
  /** Season number -> that season's trailer. A season without one is absent; always {} for a film. */
  seasons: Record<string, string>;
}

/** Everything a TMDB match stores for one title. `episodes` is empty for a movie. */
export interface TitleMetadata {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  /** `YYYY-MM-DD`. */
  releaseDate: string | null;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  runtimeMin: number | null;
  genres: string[];
  seasonCount: number | null;
  episodeCount: number | null;
  companies: CompanyMeta[];
  credits: CreditMeta[];
  episodes: EpisodeMeta[];
  trailers: TitleTrailers;
}

/**
 * Whether a file is in the library. Each variant carries exactly the columns that status allows
 * (the `movie_files_match_check` CHECK enforces the same): a matched file has a title and no
 * reason; a pending file (TMDB unreachable, or not tried yet) and an unmatched file have no title.
 */
export type FileClassification =
  | { status: 'matched'; titleId: string }
  | { status: 'unmatched'; reason: Exclude<FileReason, 'tmdb_error'> }
  | { status: 'pending'; reason: 'tmdb_error' | null };

/** The classification a failed match leaves: `tmdb_error` is retried (pending), anything else is unmatched. */
export function classifyReason(reason: FileReason): FileClassification {
  return reason === 'tmdb_error' ? { status: 'pending', reason } : { status: 'unmatched', reason };
}

/** A file to record (`MoviesRepo.upsertFile`). */
export interface NewMovieFile {
  host: string;
  /** Absolute Linux path on `host`. */
  path: string;
  name: string;
  size: number | null;
  mtime: Date | null;
  durationS: number | null;
  season: number | null;
  episode: number | null;
  absoluteEpisode: number | null;
  parsed: ParsedNameRecord | null;
  source: FileSource;
  classification: FileClassification;
  /** Becomes first_seen_at on insert and last_seen_at always. */
  seenAt: Date;
  /** Set for a file known only from VLC's recent list: the row is created already deleted. */
  deletedAt?: Date | null;
  /** A file first found inside a Done folder carries its done signal from the start. */
  doneAt?: Date | null;
}

/** A file play to open (`MoviesRepo.startPlay`). */
export interface NewPlay {
  fileId: number;
  host: string;
  source: FilePlaySource;
  startedAt: Date;
  /** Where playback started; also the play's first `position_s`. */
  startPositionS: number | null;
  durationS: number | null;
}

/** One reading of a running player. */
export interface PlayReading {
  positionS: number | null;
  durationS: number | null;
}

/** One entry of VLC's `[RecentsMRL]` list, resolved to a file. `positionS` null: time 0 or -1. */
export interface RecentsObservation {
  fileId: number;
  host: string;
  positionS: number | null;
  durationS: number | null;
  observedAt: Date;
}

/** The owner's state on a title. Absent keys are left as they are. */
export interface TitleUserPatch {
  watched?: boolean;
  /** 0..5; null clears it. */
  rating?: number | null;
  reviewNoteId?: string | null;
}

/** `MoviesRepo.titlesFinishedBetween`: titles finished in [from, to), optionally by company or person. */
export interface FinishedFilter {
  from: Date;
  /** Exclusive. */
  to: Date;
  /** Case-insensitive substring of a company name. */
  company?: string;
  /** Case-insensitive substring of a person's name. */
  person?: string;
  /** Narrows `person` to one role. */
  role?: CreditRole;
}

export interface FinishedTitle {
  id: string;
  kind: TitleKind;
  title: string;
  year: number | null;
  /** The latest moment in the range at which the title or one of its files became finished. */
  finishedAt: Date;
}

/** A play with the file it belongs to. */
export interface FilePlay {
  play: MoviePlayRow;
  file: MovieFileRow;
}

/** What `fileState` reads from a file row. */
export type FileStateInput = Pick<MovieFileRow, 'deletedAt' | 'doneAt' | 'watchedAt' | 'durationS'>;
/** What `fileState` reads from a play (`MoviesRepo.lastPlay`). */
export type PlayStateInput = Pick<MoviePlayRow, 'positionS' | 'durationS'>;

/**
 * What a stream is of (direct streaming): a film, or one episode of a series. Phase 3's `StreamRef`
 * has this shape; phase 3 validated it at its route.
 */
export interface StreamTarget {
  kind: TitleKind;
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
}

/** Where a stream of one target is recorded. */
export interface StreamSlot {
  titleId: string;
  /** On a `movie_plays` row: both null for a film (as on a film's file and its movie id). */
  play: { season: number | null; episode: number | null };
  /** On a `movie_stream_sources` row, whose primary key holds no null: 0 and 0 for a film. */
  source: { season: number; episode: number };
}

/**
 * The one mapping from a stream target to its rows. Null for a series without a whole season and
 * episode (nothing can be streamed or recorded for it). Throws RangeError for a TMDB id `titleId`
 * refuses.
 */
export function streamSlot(target: StreamTarget): StreamSlot | null {
  const id = titleId(target.kind, target.tmdbId);
  if (target.kind === 'movie') return { titleId: id, play: { season: null, episode: null }, source: { season: 0, episode: 0 } };
  const season = target.season ?? null;
  const episode = target.episode ?? null;
  if (season === null || episode === null || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 1) return null;
  return { titleId: id, play: { season, episode }, source: { season, episode } };
}

/** One position report of the player page, ready to write (`MoviesRepo.recordStreamPosition`). */
export interface StreamPositionInput {
  sessionId: string;
  titleId: string;
  season: number | null;
  episode: number | null;
  provider: string;
  host: string;
  positionS: number;
  durationS: number | null;
  /** The player reached the end or the page closed the play: the row is closed. */
  ended: boolean;
  at: Date;
}

/** What a position report wrote: the session's row, whether this report opened it, whether it closed it. */
export interface StreamPositionWrite {
  play: MoviePlayRow;
  created: boolean;
  closed: boolean;
}

/** The row a resolve outcome is written to. */
export interface StreamSourceKey {
  titleId: string;
  season: number;
  episode: number;
  host: string;
  at: Date;
}

/** One resolve's outcome for `MoviesRepo.recordStreamSource`. Only `no_source` makes a row stale. */
export type StreamSourceOutcome =
  | (StreamSourceKey & { outcome: 'verified'; provider: string; manifestKind: string; bestHeight: number | null; enSubtitle: boolean })
  | (StreamSourceKey & { outcome: 'stale'; failure: string });
