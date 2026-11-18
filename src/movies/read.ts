import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  movieCompanies,
  movieCredits,
  movieDialogues,
  movieEpisodeMarks,
  movieEpisodes,
  movieFiles,
  movieIds,
  moviePeople,
  moviePlays,
  movieStreamSources,
  movieTitleChannels,
  movieTitleMethods,
  movieTitleCompanies,
  movieTitles,
  notes,
} from '../db/schema.js';
import { emptyTitleMovieIds, episodeKey, movieIdsOfTitles, type TitleMovieIds } from './ids.js';
import { freshStreamSourceSql } from './repo.js';
import { STREAMING_SITES } from '../streaming/service.js';
import { TORRENT_PROVIDER_NAME } from './streams.js';
import { reviewText } from './reviewNote.js';
import { FINISHED_RATIO, episodeState, fileState, resumePosition, streamLeads, streamState, titleState, type SourceSummary } from './state.js';
import { posterUrl, type TmdbSearchHit } from './tmdb.js';
import { titleId as makeTitleId, type FileReason, type FileStatus, type ParsedNameRecord, type TitleKind, type WatchState } from './types.js';

type TitleRow = typeof movieTitles.$inferSelect;
type FileRow = typeof movieFiles.$inferSelect;
type PlayRow = typeof moviePlays.$inferSelect;
type EpisodeRow = typeof movieEpisodes.$inferSelect;

// ---------- constants ----------

/** Re-exported from types.ts (one definition). */
export { WATCH_STATES } from './types.js';
export const TITLE_SORTS = ['recent', 'title', 'year', 'rating'] as const;
export type TitleSort = (typeof TITLE_SORTS)[number];

export const DEFAULT_LIST_LIMIT = 1000;
export const MAX_LIST_LIMIT = 5000;
export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 500;
export const DETAIL_PLAY_LIMIT = 50;

/** TMDB image sizes per use. URLs are absolute CDN links, the same on every host (R2.4). */
export const IMAGE_SIZES = {
  grid: 'w342',
  detail: 'w500',
  backdrop: 'w1280',
  profile: 'w185',
  logo: 'w92',
  still: 'w300',
} as const;

// ---------- wire types ----------

export type FileSource = 'scan' | 'vlc_recents';
export type PlaySource = 'live' | 'vlc_recents' | 'stream';
export type UnavailableReason = 'not_on_this_machine' | 'deleted';

/** Which machine is asking, and where TMDB images live. */
export interface ReadContext {
  host: string;
  imageBase: string;
}

export interface ProgressView {
  position_s: number | null;
  duration_s: number | null;
  /** position / duration, 0..1; null when either is unknown. */
  ratio: number | null;
}

export type TitleProgress =
  | { kind: 'movie'; position_s: number | null; duration_s: number | null; ratio: number | null }
  | { kind: 'tv'; episodes_finished: number; episodes_total: number | null; episodes_present: number };

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
  status: FileStatus;
  reason: FileReason | null;
  source: FileSource;
  first_seen_at: string;
  last_seen_at: string;
  deleted_at: string | null;
  moved_at: string | null;
  done_at: string | null;
  watched_at: string | null;
  deleted: boolean;
  /** On this host and not deleted. A file of another host is never available here (R3.7). */
  available: boolean;
  unavailable_reason: UnavailableReason | null;
  state: WatchState;
  progress: ProgressView;
  resume_position_s: number;
  last_played_at: string | null;
  finished_at: string | null;
}

export interface EpisodeView {
  /** The episode's movie id (`M-0T77`); it has one whether or not a file exists. Null only before the registry knows it. */
  movie_id: string | null;
  season: number;
  episode: number;
  name: string | null;
  air_date: string | null;
  runtime_min: number | null;
  overview: string | null;
  still_url: string | null;
  state: WatchState;
  /** The owner's manual "finished" mark on this episode (it makes the state finished). */
  watched: boolean;
  /** A story of this episode is stored (src/movies/story.ts): opening it costs nothing. Set by getTitle only. */
  has_story: boolean;
  has_file: boolean;
  present_here: boolean;
  deleted: boolean;
  progress: ProgressView;
  last_played_at: string | null;
  finished_at: string | null;
  file_id: number | null;
  files: FileView[];
}

export interface SeasonView {
  season: number;
  /** YouTube video id of this season's trailer; null when TMDB lists none. */
  trailer_key: string | null;
  episodes: EpisodeView[];
}

export interface TitleListItem {
  id: string;
  /** The id the owner types and reads (`M-23T4`, src/movies/ids.ts). `id` stays the key of routes and rows. */
  movie_id: string | null;
  kind: TitleKind;
  tmdb_id: number;
  title: string;
  year: number | null;
  poster_url: string | null;
  state: WatchState;
  watched: boolean;
  watched_at: string | null;
  /** The owner's "not interested" mark: on the Stream side the title shows only under that filter. */
  not_interested: boolean;
  rating: number | null;
  progress: TitleProgress;
  last_played_at: string | null;
  finished_at: string | null;
  present_here: boolean;
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

export interface CrewCredit {
  person_id: number;
  name: string;
  profile_url: string | null;
  job: string | null;
}

export interface CastCredit {
  person_id: number;
  name: string;
  profile_url: string | null;
  character: string | null;
}

export interface PlayView {
  id: number;
  /** The file played; null for a stream play (source `stream`). */
  file_id: number | null;
  title_id: string | null;
  title: string | null;
  kind: TitleKind | null;
  season: number | null;
  episode: number | null;
  /** The episode's TMDB name; null for a film or an episode TMDB does not list. */
  episode_name: string | null;
  /** What was played: the episode's movie id, or the title's for a film. */
  movie_id: string | null;
  /** The file's name; null for a stream play. */
  file_name: string | null;
  file_deleted: boolean;
  file_deleted_at: string | null;
  host: string;
  source: PlaySource;
  /** The direct-stream provider of a stream play (`VidFast`); null for a file play. */
  provider: string | null;
  started_at: string;
  ended_at: string | null;
  start_position_s: number | null;
  position_s: number | null;
  duration_s: number | null;
  ratio: number | null;
}

export interface TitleDetail extends TitleListItem {
  /** A film: its story is stored (an episode's flag is on the episode). */
  has_story: boolean;
  original_title: string;
  release_date: string | null;
  overview: string;
  runtime_min: number | null;
  genres: string[];
  backdrop_url: string | null;
  /** YouTube video id of the title's trailer; null when TMDB lists none (or was not asked yet). */
  trailer_key: string | null;
  /** The trailer on YouTube; null with `trailer_key`. */
  trailer_url: string | null;
  season_count: number | null;
  episode_count: number | null;
  review: string;
  review_note_id: string | null;
  companies: CompanyView[];
  directors: CrewCredit[];
  writers: CrewCredit[];
  producers: CrewCredit[];
  creators: CrewCredit[];
  cast: CastCredit[];
  files: FileView[];
  seasons: SeasonView[];
  unplaced_files: FileView[];
  plays: PlayView[];
  /** This host's verified stream sources (direct streaming): the film's, or each episode's. */
  stream_sources: StreamSourceView[];
  /** How the title was last played on this host; null: never. A play with no source named goes there again. */
  played_through: PlayedThrough | null;
  /** When each kind of stream last found nothing for the title on this host; null: it never failed, or played since. */
  stream_failed: { cloud_at: string | null; torrent_at: string | null };
  /** What last played the title through each stream method on this host (`cloud`, `torrent`, a site's name): where a play that names the method goes first. */
  played_methods: PlayedMethod[];
  metadata_fetched_at: string | null;
}

/** One stream method's last play of a title on this host. `provider` names the cloud provider; null for a torrent or a site. */
export interface PlayedMethod {
  method: string;
  provider: string | null;
  played_at: string;
  season: number | null;
  episode: number | null;
}

/**
 * How a title was last played on this host: a downloaded file in VLC (`vlc`), a cloud provider's
 * stream (`cloud`, `provider` names it), a torrent, or a streaming site (`site`, `provider` names
 * it: `dramacool`). `season` and `episode` are those of that play; null for a film.
 */
export interface PlayedThrough {
  channel: 'vlc' | 'cloud' | 'torrent' | 'site';
  provider: string | null;
  played_at: string;
  season: number | null;
  episode: number | null;
}

/** One verified stream source of this host, as the routes answer it (a film is season 0, episode 0). */
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
  /** The title is in the Library (a title known only from streams is not). */
  in_library: boolean;
}

export interface StatusCounts {
  titles: number;
  files_here: number;
  unmatched_here: number;
  pending_here: number;
}

export interface TitleFilter {
  q?: string;
  state?: WatchState;
  kind?: TitleKind;
  /** A TMDB company id (digits) or a fragment of its name, case-insensitive. */
  company?: string;
  /** A TMDB person id (digits) or a fragment of their name, any role. */
  person?: string;
  /** finished_at >= finishedFrom. */
  finishedFrom?: Date;
  /** finished_at < finishedTo (parseDateBound's exclusive upper bound). */
  finishedTo?: Date;
  sort?: TitleSort;
  limit?: number;
  /** `library` (default): leave out titles known only from streams (invariant 10). `all`: every title. */
  scope?: 'library' | 'all';
}

export interface HistoryFilter {
  titleId?: string;
  /** Plays of one file. */
  fileId?: number;
  host?: string;
  /** started_at >= from. */
  from?: Date;
  /** started_at < to. */
  to?: Date;
  limit?: number;
}

// ---------- small helpers ----------

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function dateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function num(value: number | string | bigint | null): number | null {
  return value === null ? null : Number(value);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function ratioOf(position: number | null, duration: number | null): number | null {
  if (position === null || duration === null || duration <= 0) return null;
  return clamp(position / duration, 0, 1);
}

/** Newest of the given instants, as ISO; null when none is set. */
function latest(values: readonly (Date | string | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const t = new Date(v).getTime();
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

function imageUrl(ctx: ReadContext, path: string | null, size: string): string | null {
  return path === null || path === '' ? null : posterUrl(ctx.imageBase, path, size);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Descending ISO order, nulls last. */
function cmpDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? 1 : -1;
}

const NO_PROGRESS: ProgressView = { position_s: null, duration_s: null, ratio: null };

// ---------- files and plays ----------

function fileFinishedAt(row: FileRow, last: PlayRow | null, state: WatchState): string | null {
  if (state !== 'finished') return null;
  const marks: (Date | null)[] = [row.watchedAt, row.doneAt];
  if (last !== null) {
    const r = ratioOf(last.positionS, last.durationS ?? row.durationS);
    if (r !== null && r >= FINISHED_RATIO) marks.push(last.endedAt ?? last.updatedAt);
  }
  return latest(marks);
}

function fileView(row: FileRow, last: PlayRow | null, ctx: ReadContext): FileView {
  const deleted = row.deletedAt !== null;
  const here = row.host === ctx.host;
  const state = fileState(row, last);
  const position = last?.positionS ?? null;
  const duration = last?.durationS ?? row.durationS ?? null;
  return {
    id: Number(row.id),
    title_id: row.titleId,
    host: row.host,
    path: row.path,
    name: row.name,
    size: num(row.size),
    duration_s: row.durationS,
    season: row.season,
    episode: row.episode,
    absolute_episode: row.absoluteEpisode,
    status: row.status as FileStatus,
    reason: (row.reason ?? null) as FileReason | null,
    source: row.source as FileSource,
    first_seen_at: iso(row.firstSeenAt),
    last_seen_at: iso(row.lastSeenAt),
    deleted_at: isoOrNull(row.deletedAt),
    moved_at: isoOrNull(row.movedAt),
    done_at: isoOrNull(row.doneAt),
    watched_at: isoOrNull(row.watchedAt),
    deleted,
    available: here && !deleted,
    unavailable_reason: deleted ? 'deleted' : here ? null : 'not_on_this_machine',
    state,
    progress: { position_s: position, duration_s: duration, ratio: ratioOf(position, duration) },
    resume_position_s: resumePosition(row, last),
    last_played_at: last === null ? null : iso(last.startedAt),
    finished_at: fileFinishedAt(row, last, state),
  };
}

/** The last play of each file, in MoviesRepo.lastPlay's order: known position first, then started_at desc, id desc. */
async function lastPlays(db: Db, fileIds: readonly number[]): Promise<Map<number, PlayRow>> {
  const out = new Map<number, PlayRow>();
  if (fileIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([moviePlays.fileId])
    .from(moviePlays)
    .where(inArray(moviePlays.fileId, [...fileIds]))
    .orderBy(moviePlays.fileId, sql`(${moviePlays.positionS} is not null) desc`, desc(moviePlays.startedAt), desc(moviePlays.id));
  for (const row of rows) out.set(Number(row.fileId), row);
  return out;
}

/** The file Play acts on: present here first, then present elsewhere, then deleted; newest play, then newest seen. */
function primaryFile(files: readonly FileView[]): FileView | null {
  const tier = (f: FileView): number => (f.available ? 0 : f.deleted ? 2 : 1);
  const sorted = [...files].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      cmpDesc(a.last_played_at, b.last_played_at) ||
      cmpDesc(a.first_seen_at, b.first_seen_at) ||
      b.id - a.id,
  );
  return sorted[0] ?? null;
}

/** The key of a title's stream slot: the film itself, or one episode (`<season>x<episode>`, buildSeasons' key). */
const FILM_STREAM = 'film';

function streamKey(season: number | null, episode: number | null): string {
  return season === null || episode === null ? FILM_STREAM : `${season}x${episode}`;
}

/** A film's or an episode's stream pseudo-source (state.ts STREAM_SOURCE), from its last stream play. */
interface StreamSlotView {
  season: number | null;
  episode: number | null;
  state: WatchState;
  progress: ProgressView;
  last_played_at: string;
  finished_at: string | null;
}

function streamSlotView(play: PlayRow): StreamSlotView {
  const state = streamState(play);
  return {
    season: play.season,
    episode: play.episode,
    state,
    progress: { position_s: play.positionS, duration_s: play.durationS, ratio: ratioOf(play.positionS, play.durationS) },
    last_played_at: iso(play.startedAt),
    finished_at: state === 'finished' ? iso(play.endedAt ?? play.updatedAt) : null,
  };
}

function fileSummary(file: FileView | null): SourceSummary | null {
  return file === null ? null : { state: file.state, playedAt: file.last_played_at };
}

function streamSummary(stream: StreamSlotView | null): SourceSummary | null {
  return stream === null ? null : { state: stream.state, playedAt: stream.last_played_at };
}

/** The stream when it decides a slot's progress (state.ts streamLeads), else null. */
function leadingStream(primary: FileView | null, stream: StreamSlotView | null): StreamSlotView | null {
  return stream !== null && streamLeads(fileSummary(primary), streamSummary(stream)) ? stream : null;
}

/** An episode's state from its copies and its stream (state.ts episodeState; file-only episodes as before). */
function slotState(files: readonly FileView[], stream: StreamSlotView | null): WatchState {
  return episodeState(files.some((f) => f.state === 'finished'), fileSummary(primaryFile(files)), streamSummary(stream));
}

// ---------- titles ----------

interface TitleParts {
  files: FileView[];
  episodes: EpisodeRow[];
  ids: TitleMovieIds;
  /** By streamKey: the film's stream, or each streamed episode's. */
  streams: Map<string, StreamSlotView>;
  /** By streamKey: when the owner marked the episode finished. */
  marks: Map<string, Date>;
}

function emptyParts(): TitleParts {
  return { files: [], episodes: [], ids: emptyTitleMovieIds(), streams: new Map(), marks: new Map() };
}

async function loadParts(db: Db, titles: readonly TitleRow[], ctx: ReadContext): Promise<Map<string, TitleParts>> {
  const parts = new Map<string, TitleParts>();
  for (const t of titles) parts.set(t.id, emptyParts());
  const ids = titles.map((t) => t.id);
  if (ids.length === 0) return parts;
  const tvIds = titles.filter((t) => t.kind === 'tv').map((t) => t.id);
  const fileRows = await db.select().from(movieFiles).where(inArray(movieFiles.titleId, ids));
  const last = await lastPlays(
    db,
    fileRows.map((f) => Number(f.id)),
  );
  const episodeRows =
    tvIds.length === 0
      ? []
      : await db
          .select()
          .from(movieEpisodes)
          .where(inArray(movieEpisodes.titleId, tvIds))
          .orderBy(asc(movieEpisodes.season), asc(movieEpisodes.episode));
  // The last stream play of each streamed film or episode, in MoviesRepo.lastStreamPlay's order.
  const streamRows = await db
    .selectDistinctOn([moviePlays.titleId, moviePlays.season, moviePlays.episode])
    .from(moviePlays)
    .where(and(eq(moviePlays.source, 'stream'), inArray(moviePlays.titleId, ids)))
    .orderBy(
      moviePlays.titleId,
      moviePlays.season,
      moviePlays.episode,
      sql`(${moviePlays.positionS} is not null) desc`,
      desc(moviePlays.startedAt),
      desc(moviePlays.id),
    );
  for (const row of fileRows) {
    if (row.titleId === null) continue;
    parts.get(row.titleId)?.files.push(fileView(row, last.get(Number(row.id)) ?? null, ctx));
  }
  for (const row of episodeRows) parts.get(row.titleId)?.episodes.push(row);
  const markRows = tvIds.length === 0 ? [] : await db.select().from(movieEpisodeMarks).where(inArray(movieEpisodeMarks.titleId, tvIds));
  for (const row of markRows) parts.get(row.titleId)?.marks.set(streamKey(row.season, row.episode), row.watchedAt);
  for (const row of streamRows) {
    if (row.titleId === null) continue;
    parts.get(row.titleId)?.streams.set(streamKey(row.season, row.episode), streamSlotView(row));
  }
  for (const [id, movieIdsOfTitle] of await movieIdsOfTitles(db, ids)) {
    const p = parts.get(id);
    if (p !== undefined) p.ids = movieIdsOfTitle;
  }
  return parts;
}

interface EpisodeSlot {
  row: EpisodeRow | null;
  season: number;
  episode: number;
  files: FileView[];
  stream: StreamSlotView | null;
  /** The owner's manual mark; null when the episode has none. */
  markedAt: Date | null;
}

function episodeView(slot: EpisodeSlot, ids: TitleMovieIds, ctx: ReadContext): EpisodeView {
  const primary = primaryFile(slot.files);
  const lead = leadingStream(primary, slot.stream);
  return {
    movie_id: ids.episodes.get(episodeKey(slot.season, slot.episode)) ?? null,
    season: slot.season,
    episode: slot.episode,
    name: slot.row?.name ?? null,
    air_date: dateOnly(slot.row?.airDate ?? null),
    runtime_min: slot.row?.runtimeMin ?? null,
    overview: slot.row?.overview ?? null,
    still_url: imageUrl(ctx, slot.row?.stillPath ?? null, IMAGE_SIZES.still),
    state: slot.markedAt !== null ? 'finished' : slotState(slot.files, slot.stream),
    watched: slot.markedAt !== null,
    has_story: false,
    has_file: slot.files.length > 0,
    present_here: slot.files.some((f) => f.available),
    deleted: slot.files.length > 0 && slot.files.every((f) => f.deleted),
    progress: lead?.progress ?? primary?.progress ?? NO_PROGRESS,
    last_played_at: latest([...slot.files.map((f) => f.last_played_at), slot.stream?.last_played_at]),
    finished_at: latest([slot.markedAt, ...slot.files.map((f) => f.finished_at), slot.stream?.finished_at]),
    file_id: primary?.id ?? null,
    files: slot.files,
  };
}

/** Episodes of a series: TMDB's list plus any (season, episode) only a file or a stream names. Specials (season 0) only with a file or a stream. */
function buildSeasons(parts: TitleParts, ctx: ReadContext, trailers: Readonly<Record<string, string>>): { seasons: SeasonView[]; episodes: EpisodeView[]; unplaced: FileView[] } {
  const slots = new Map<string, EpisodeSlot>();
  const key = (s: number, e: number): string => `${s}x${e}`;
  const slotAt = (season: number, episode: number): EpisodeSlot => {
    const k = key(season, episode);
    let slot = slots.get(k);
    if (slot === undefined) {
      slot = { row: null, season, episode, files: [], stream: null, markedAt: null };
      slots.set(k, slot);
    }
    return slot;
  };
  for (const row of parts.episodes) slots.set(key(row.season, row.episode), { row, season: row.season, episode: row.episode, files: [], stream: null, markedAt: null });
  const unplaced: FileView[] = [];
  for (const f of parts.files) {
    if (f.season === null || f.episode === null) {
      unplaced.push(f);
      continue;
    }
    slotAt(f.season, f.episode).files.push(f);
  }
  for (const stream of parts.streams.values()) {
    if (stream.season === null || stream.episode === null) continue;
    slotAt(stream.season, stream.episode).stream = stream;
  }
  for (const [k, at] of parts.marks) {
    const [season, episode] = k.split('x').map(Number);
    if (season === undefined || episode === undefined || !Number.isInteger(season) || !Number.isInteger(episode)) continue;
    slotAt(season, episode).markedAt = at;
  }
  const episodes = [...slots.values()]
    .filter((s) => s.season >= 1 || s.files.length > 0 || s.stream !== null)
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .map((s) => episodeView(s, parts.ids, ctx));
  const seasons: SeasonView[] = [];
  for (const ep of episodes) {
    const lastSeason = seasons[seasons.length - 1];
    if (lastSeason !== undefined && lastSeason.season === ep.season) lastSeason.episodes.push(ep);
    else seasons.push({ season: ep.season, trailer_key: trailers[String(ep.season)] ?? null, episodes: [ep] });
  }
  return { seasons, episodes, unplaced };
}

interface BuiltTitle {
  item: TitleListItem;
  seasons: SeasonView[];
  unplaced: FileView[];
  files: FileView[];
}

function buildTitle(t: TitleRow, parts: TitleParts, ctx: ReadContext, posterSize: string): BuiltTitle {
  const kind = t.kind as TitleKind;
  const files = parts.files;
  const streams = [...parts.streams.values()];
  let state: WatchState;
  let progress: TitleProgress;
  let seasons: SeasonView[] = [];
  let unplaced: FileView[] = [];
  if (kind === 'tv') {
    const built = buildSeasons(parts, ctx, t.seasonTrailers ?? {});
    seasons = built.seasons;
    unplaced = built.unplaced;
    state = titleState('tv', built.episodes.map((e) => e.state));
    const known = parts.episodes.filter((e) => e.season >= 1).length;
    progress = {
      kind: 'tv',
      episodes_finished: built.episodes.filter((e) => e.state === 'finished').length,
      episodes_total: known > 0 ? known : (t.episodeCount ?? null),
      episodes_present: built.episodes.filter((e) => e.present_here).length,
    };
  } else {
    // The film's stream is one more copy in the precedence list (state.ts titleState).
    const stream = parts.streams.get(FILM_STREAM) ?? null;
    state = titleState('movie', stream === null ? files.map((f) => f.state) : [...files.map((f) => f.state), stream.state]);
    const primary = primaryFile(files);
    const p = leadingStream(primary, stream)?.progress ?? primary?.progress ?? NO_PROGRESS;
    const duration = p.duration_s ?? (t.runtimeMin !== null ? t.runtimeMin * 60 : null);
    progress = { kind: 'movie', position_s: p.position_s, duration_s: duration, ratio: ratioOf(p.position_s, duration) };
  }
  if (t.watchedAt !== null) state = 'finished';
  const item: TitleListItem = {
    id: t.id,
    movie_id: parts.ids.title,
    kind,
    tmdb_id: t.tmdbId,
    title: t.title,
    year: t.year,
    poster_url: imageUrl(ctx, t.posterPath, posterSize),
    state,
    watched: t.watchedAt !== null,
    watched_at: isoOrNull(t.watchedAt),
    not_interested: t.notInterestedAt !== null,
    rating: t.rating,
    progress,
    last_played_at: latest([...files.map((f) => f.last_played_at), ...streams.map((s) => s.last_played_at)]),
    finished_at: latest([t.watchedAt, ...parts.marks.values(), ...files.map((f) => f.finished_at), ...streams.map((s) => s.finished_at)]),
    present_here: files.some((f) => f.available),
    file_count: files.filter((f) => !f.deleted).length,
    deleted_file_count: files.filter((f) => f.deleted).length,
    created_at: iso(t.createdAt),
  };
  return { item, seasons, unplaced, files };
}

function companyMatch(value: string): SQL {
  if (/^\d+$/.test(value)) {
    return sql`exists (select 1 from movie_title_companies tc where tc.title_id = movie_titles.id and tc.company_id = ${Number(value)})`;
  }
  return sql`exists (select 1 from movie_title_companies tc join movie_companies c on c.id = tc.company_id
    where tc.title_id = movie_titles.id and c.name ilike ${`%${escapeLike(value)}%`})`;
}

function personMatch(value: string): SQL {
  if (/^\d+$/.test(value)) {
    return sql`exists (select 1 from movie_credits cr where cr.title_id = movie_titles.id and cr.person_id = ${Number(value)})`;
  }
  return sql`exists (select 1 from movie_credits cr join movie_people p on p.id = cr.person_id
    where cr.title_id = movie_titles.id and p.name ilike ${`%${escapeLike(value)}%`})`;
}

function textMatch(q: string): SQL {
  const like = `%${escapeLike(q)}%`;
  return sql`(movie_titles.search_tsv @@ websearch_to_tsquery('simple', ${q})
    or ${movieTitles.title} ilike ${like} or ${movieTitles.originalTitle} ilike ${like})`;
}

function sortItems(items: TitleListItem[], sort: TitleSort): TitleListItem[] {
  const byTitle = (a: TitleListItem, b: TitleListItem): number => a.title.localeCompare(b.title);
  switch (sort) {
    case 'title':
      return items.sort(byTitle);
    case 'year':
      return items.sort((a, b) => (b.year ?? -1) - (a.year ?? -1) || byTitle(a, b));
    case 'rating':
      return items.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || byTitle(a, b));
    case 'recent':
      return items.sort(
        (a, b) => cmpDesc(latest([a.last_played_at, a.created_at]), latest([b.last_played_at, b.created_at])) || byTitle(a, b),
      );
  }
}

/**
 * Invariant 10 (direct streaming): the Library lists a title that has a file row (any host,
 * deleted ones included), or that was never streamed nor stream-checked (a title stored before
 * streams existed). A title known only from streams is left out; getTitle still opens it.
 */
function inLibrarySql(): SQL {
  return sql`(exists (select 1 from movie_files lf where lf.title_id = movie_titles.id)
    or (not exists (select 1 from movie_stream_sources ls where ls.title_id = movie_titles.id)
        and not exists (select 1 from movie_plays lp where lp.title_id = movie_titles.id)))`;
}

/** Titles matching the filter and `scope` (a condition on `movie_titles`, or none), with their derived state and progress. */
async function selectTitles(db: Db, filter: TitleFilter, ctx: ReadContext, scope: SQL | null): Promise<TitleListItem[]> {
  const where: SQL[] = scope === null ? [] : [scope];
  if (filter.kind !== undefined) where.push(eq(movieTitles.kind, filter.kind));
  if (filter.q !== undefined) where.push(textMatch(filter.q));
  if (filter.company !== undefined) where.push(companyMatch(filter.company));
  if (filter.person !== undefined) where.push(personMatch(filter.person));
  const rows = await db
    .select()
    .from(movieTitles)
    .where(where.length > 0 ? and(...where) : undefined);
  const parts = await loadParts(db, rows, ctx);
  let items = rows.map((t) => buildTitle(t, parts.get(t.id) ?? emptyParts(), ctx, IMAGE_SIZES.grid).item);
  if (filter.state !== undefined) items = items.filter((i) => i.state === filter.state);
  const from = filter.finishedFrom?.getTime();
  const to = filter.finishedTo?.getTime();
  if (from !== undefined || to !== undefined) {
    items = items.filter((i) => {
      if (i.finished_at === null) return false;
      const t = new Date(i.finished_at).getTime();
      return (from === undefined || t >= from) && (to === undefined || t < to);
    });
  }
  const limit = clamp(filter.limit ?? DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  return sortItems(items, filter.sort ?? 'recent').slice(0, limit);
}

/** The Library grid: every Library title matching the filter (every title with `scope: 'all'`), with its derived state and progress. */
export async function listTitles(db: Db, filter: TitleFilter, ctx: ReadContext): Promise<TitleListItem[]> {
  return selectTitles(db, filter, ctx, filter.scope === 'all' ? null : inLibrarySql());
}

/**
 * The Stream grid's titles (direct streaming, invariant 10): those with a source verified on
 * `ctx.host` at or after `freshSince` and not stale (repo.ts freshStreamSourceSql), files or not,
 * and those last played here on a streaming site.
 * `filter.scope` is ignored. GET /api/movies/stream (phase 9) calls it with
 * `streamFreshSince(now, config.directStream.freshDays)`.
 */
export async function listStreamTitles(db: Db, filter: TitleFilter, ctx: ReadContext, freshSince: Date): Promise<TitleListItem[]> {
  // A title marked "not interested" is no longer re-checked, so it stays listed (under its own
  // filter) for as long as this host ever verified it: the mark can always be taken back here.
  const kept = sql`(movie_titles.not_interested_at is not null and exists (
    select 1 from movie_stream_sources s where s.title_id = movie_titles.id and s.host = ${ctx.host} and s.verified_at is not null))`;
  // A title last played on a streaming site has no source to verify: it is listed for as long as that is how it plays here.
  const onSite = sql`exists (select 1 from movie_title_channels c where c.title_id = movie_titles.id and c.host = ${ctx.host} and c.channel = 'site')`;
  return selectTitles(db, filter, ctx, sql`(${freshStreamSourceSql(ctx.host, freshSince)} or ${kept} or ${onSite})`);
}

/**
 * These stored titles with their derived state and marks (the Trending section reads what the owner has seen through it).
 * Unknown ids are absent. A title nothing was ever done to (no flag, mark, file or play) is `unwatched` by definition, so it is
 * built from its row and its own movie id alone: a series' every episode row and episode id (thousands over the remote database)
 * are read only for the titles that were touched.
 */
export async function listTitlesByIds(db: Db, ids: readonly string[], ctx: ReadContext): Promise<TitleListItem[]> {
  if (ids.length === 0) return [];
  const list = [...ids];
  const touchedRows = await db.execute<{ id: string }>(sql`
    select t.id from movie_titles t
    where t.id in (${sql.join(list.map((id) => sql`${id}`), sql`, `)})
      and (t.watched_at is not null or t.not_interested_at is not null
        or exists (select 1 from movie_files f where f.title_id = t.id)
        or exists (select 1 from movie_plays p where p.title_id = t.id)
        or exists (select 1 from movie_episode_marks m where m.title_id = t.id))`);
  const touched = touchedRows.rows.map((r) => r.id);
  const pristine = list.filter((id) => !touched.includes(id));
  const full = touched.length === 0 ? [] : await selectTitles(db, { limit: MAX_LIST_LIMIT }, ctx, inArray(movieTitles.id, touched));
  if (pristine.length === 0) return full;
  const rows = await db.select().from(movieTitles).where(inArray(movieTitles.id, pristine));
  const own = await db.select().from(movieIds).where(and(inArray(movieIds.titleId, pristine), isNull(movieIds.season)));
  const movieIdOf = new Map(own.map((r) => [r.titleId, r.id]));
  const light = rows.map((t) => {
    const parts = emptyParts();
    parts.ids = { title: movieIdOf.get(t.id) ?? null, episodes: new Map() };
    return buildTitle(t, parts, ctx, IMAGE_SIZES.grid).item;
  });
  return [...full, ...light];
}

/** TMDB's original language of these stored titles ("hi"), by title id; null when it is not known. Unknown ids are absent. */
export async function titleLanguages(db: Db, ids: readonly string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: movieTitles.id, language: movieTitles.originalLanguage }).from(movieTitles).where(inArray(movieTitles.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.language]));
}

async function titleCompanies(db: Db, id: string, ctx: ReadContext): Promise<CompanyView[]> {
  const rows = await db
    .select({
      id: movieCompanies.id,
      name: movieCompanies.name,
      logoPath: movieCompanies.logoPath,
      originCountry: movieCompanies.originCountry,
    })
    .from(movieTitleCompanies)
    .innerJoin(movieCompanies, eq(movieCompanies.id, movieTitleCompanies.companyId))
    .where(eq(movieTitleCompanies.titleId, id))
    .orderBy(asc(movieTitleCompanies.ord));
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    logo_url: imageUrl(ctx, r.logoPath, IMAGE_SIZES.logo),
    origin_country: r.originCountry,
  }));
}

interface CreditRow {
  personId: number;
  role: string;
  character: string | null;
  job: string | null;
  name: string;
  profilePath: string | null;
}

async function titleCredits(db: Db, id: string): Promise<CreditRow[]> {
  const rows = await db
    .select({
      personId: movieCredits.personId,
      role: movieCredits.role,
      character: movieCredits.character,
      job: movieCredits.job,
      name: moviePeople.name,
      profilePath: moviePeople.profilePath,
    })
    .from(movieCredits)
    .innerJoin(moviePeople, eq(moviePeople.id, movieCredits.personId))
    .where(eq(movieCredits.titleId, id))
    .orderBy(asc(movieCredits.ord), asc(movieCredits.id));
  return rows.map((r) => ({ ...r, personId: Number(r.personId) }));
}

/** One entry per person, in billing order; a person with several jobs gets them joined. */
function crewOf(rows: readonly CreditRow[], role: string, ctx: ReadContext): CrewCredit[] {
  const out = new Map<number, CrewCredit>();
  for (const r of rows) {
    if (r.role !== role) continue;
    const seen = out.get(r.personId);
    if (seen === undefined) {
      out.set(r.personId, { person_id: r.personId, name: r.name, profile_url: imageUrl(ctx, r.profilePath, IMAGE_SIZES.profile), job: r.job });
    } else if (r.job !== null && !(seen.job ?? '').split(', ').includes(r.job)) {
      seen.job = seen.job === null ? r.job : `${seen.job}, ${r.job}`;
    }
  }
  return [...out.values()];
}

function castOf(rows: readonly CreditRow[], ctx: ReadContext): CastCredit[] {
  const out = new Map<number, CastCredit>();
  for (const r of rows) {
    if (r.role !== 'cast') continue;
    const seen = out.get(r.personId);
    if (seen === undefined) {
      out.set(r.personId, {
        person_id: r.personId,
        name: r.name,
        profile_url: imageUrl(ctx, r.profilePath, IMAGE_SIZES.profile),
        character: r.character,
      });
    } else if (r.character !== null && !(seen.character ?? '').split(' / ').includes(r.character)) {
      seen.character = seen.character === null ? r.character : `${seen.character} / ${r.character}`;
    }
  }
  return [...out.values()];
}

/** The review text and note id, only while the linked note is live. */
async function reviewOf(db: Db, noteId: string | null): Promise<{ review: string; noteId: string | null }> {
  if (noteId === null) return { review: '', noteId: null };
  const [row] = await db
    .select({ body: notes.body })
    .from(notes)
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
    .limit(1);
  return row === undefined ? { review: '', noteId: null } : { review: reviewText(row.body), noteId };
}

/** The title's source rows on `host` that were ever verified (a stale-only row has nothing to show), in episode order. */
async function streamSourceViews(db: Db, titleIdValue: string, host: string): Promise<StreamSourceView[]> {
  const rows = await db
    .select()
    .from(movieStreamSources)
    .where(and(eq(movieStreamSources.titleId, titleIdValue), eq(movieStreamSources.host, host), isNotNull(movieStreamSources.verifiedAt)))
    .orderBy(asc(movieStreamSources.season), asc(movieStreamSources.episode));
  return rows.map((r) => ({
    host: r.host,
    season: r.season,
    episode: r.episode,
    provider: r.provider ?? '',
    manifest_kind: r.manifestKind ?? '',
    best_height: r.bestHeight,
    en_subtitle: r.enSubtitle,
    verified_at: (r.verifiedAt as Date).toISOString(),
    stale_at: r.staleAt === null ? null : r.staleAt.toISOString(),
  }));
}

/**
 * How the title was last played on `host`: its last stream as movie_title_channels keeps it, or its
 * last file play (`plays`: the title's plays, newest first) when that is the later one.
 */
async function playedThrough(db: Db, titleIdValue: string, host: string, plays: readonly PlayView[]): Promise<Pick<TitleDetail, 'played_through' | 'stream_failed' | 'played_methods'>> {
  const [row] = await db
    .select()
    .from(movieTitleChannels)
    .where(and(eq(movieTitleChannels.titleId, titleIdValue), eq(movieTitleChannels.host, host)))
    .limit(1);
  const stream_failed = { cloud_at: isoOrNull(row?.cloudFailedAt ?? null), torrent_at: isoOrNull(row?.torrentFailedAt ?? null) };
  // No channel kept yet (a title streamed before the table existed, or copied in): its last stream play here says.
  const earlier = row === undefined ? plays.find((p) => p.source === 'stream' && p.host === host && p.provider !== null) : undefined;
  const streamed: PlayedThrough | null =
    row !== undefined && row.channel !== null && row.playedAt !== null
      ? { channel: row.channel, provider: row.provider, played_at: row.playedAt.toISOString(), season: row.season, episode: row.episode }
      : earlier !== undefined
        ? {
            channel: earlier.provider === TORRENT_PROVIDER_NAME ? 'torrent' : (STREAMING_SITES as readonly string[]).includes(earlier.provider ?? '') ? 'site' : 'cloud',
            provider: earlier.provider === TORRENT_PROVIDER_NAME ? null : earlier.provider,
            played_at: earlier.started_at,
            season: earlier.season,
            episode: earlier.episode,
          }
        : null;
  const file = plays.find((p) => p.file_id !== null && p.host === host);
  const onFile: PlayedThrough | null = file === undefined ? null : { channel: 'vlc', provider: null, played_at: file.started_at, season: file.season, episode: file.episode };
  const played_through = onFile !== null && (streamed === null || Date.parse(onFile.played_at) > Date.parse(streamed.played_at)) ? onFile : streamed;
  const methods = await db
    .select()
    .from(movieTitleMethods)
    .where(and(eq(movieTitleMethods.titleId, titleIdValue), eq(movieTitleMethods.host, host)))
    .orderBy(desc(movieTitleMethods.playedAt));
  const played_methods = methods.map((m) => ({ method: m.method, provider: m.provider, played_at: m.playedAt.toISOString(), season: m.season, episode: m.episode }));
  return { played_through, stream_failed, played_methods };
}

/** One title with every file (deleted and other hosts included), episodes, credits, review and recent plays. */
export async function getTitle(db: Db, id: string, ctx: ReadContext): Promise<TitleDetail | null> {
  const [t] = await db.select().from(movieTitles).where(eq(movieTitles.id, id)).limit(1);
  if (t === undefined) return null;
  const parts = (await loadParts(db, [t], ctx)).get(t.id) ?? emptyParts();
  const built = buildTitle(t, parts, ctx, IMAGE_SIZES.detail);
  const [companies, credits, review, plays, streamSources, stories] = await Promise.all([
    titleCompanies(db, t.id, ctx),
    titleCredits(db, t.id),
    reviewOf(db, t.reviewNoteId),
    history(db, { titleId: t.id, limit: DETAIL_PLAY_LIMIT }),
    streamSourceViews(db, t.id, ctx.host),
    db
      .select({ season: movieDialogues.season, episode: movieDialogues.episode })
      .from(movieDialogues)
      .where(and(eq(movieDialogues.titleId, t.id), isNotNull(movieDialogues.story))),
  ]);
  const storied = new Set(stories.map((s) => `${s.season}x${s.episode}`));
  for (const season of built.seasons) for (const e of season.episodes) e.has_story = storied.has(`${e.season}x${e.episode}`);
  return {
    ...built.item,
    has_story: storied.has('0x0'),
    original_title: t.originalTitle,
    release_date: dateOnly(t.releaseDate),
    overview: t.overview,
    runtime_min: t.runtimeMin,
    genres: t.genres ?? [],
    backdrop_url: imageUrl(ctx, t.backdropPath, IMAGE_SIZES.backdrop),
    trailer_key: t.trailerKey,
    trailer_url: t.trailerKey === null ? null : `https://www.youtube.com/watch?v=${t.trailerKey}`,
    season_count: t.seasonCount,
    episode_count: t.episodeCount,
    review: review.review,
    review_note_id: review.noteId,
    companies,
    directors: crewOf(credits, 'director', ctx),
    writers: crewOf(credits, 'writer', ctx),
    producers: crewOf(credits, 'producer', ctx),
    creators: crewOf(credits, 'creator', ctx),
    cast: castOf(credits, ctx),
    files: built.files,
    seasons: built.seasons,
    unplaced_files: built.unplaced,
    plays,
    stream_sources: streamSources,
    ...(await playedThrough(db, t.id, ctx.host, plays)),
    metadata_fetched_at: isoOrNull(t.metadataFetchedAt),
  };
}

/**
 * Play events, newest first, with their file (a file play) and title; deleted files included
 * (history survives deletion). A stream play has no file: its title, season and episode are its
 * own (movie_plays_target_check keeps exactly one side set), and it names its provider.
 */
export async function history(db: Db, filter: HistoryFilter = {}): Promise<PlayView[]> {
  const titleOf = sql<string | null>`coalesce(${movieFiles.titleId}, ${moviePlays.titleId})`;
  const seasonOf = sql<number | null>`coalesce(${movieFiles.season}, ${moviePlays.season})`;
  const episodeOf = sql<number | null>`coalesce(${movieFiles.episode}, ${moviePlays.episode})`;
  const where: SQL[] = [];
  if (filter.titleId !== undefined) {
    const ofTitle = or(eq(movieFiles.titleId, filter.titleId), eq(moviePlays.titleId, filter.titleId));
    if (ofTitle !== undefined) where.push(ofTitle);
  }
  if (filter.fileId !== undefined) where.push(eq(moviePlays.fileId, filter.fileId));
  if (filter.host !== undefined) where.push(eq(moviePlays.host, filter.host));
  if (filter.from !== undefined) where.push(gte(moviePlays.startedAt, filter.from));
  if (filter.to !== undefined) where.push(lt(moviePlays.startedAt, filter.to));
  const limit = clamp(filter.limit ?? DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
  const rows = await db
    .select({
      play: moviePlays,
      file: movieFiles,
      titleId: titleOf,
      season: seasonOf,
      episode: episodeOf,
      titleName: movieTitles.title,
      titleKind: movieTitles.kind,
      episodeName: movieEpisodes.name,
      movieId: movieIds.id,
    })
    .from(moviePlays)
    .leftJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
    .leftJoin(movieTitles, sql`${movieTitles.id} = ${titleOf}`)
    .leftJoin(
      movieEpisodes,
      and(sql`${movieEpisodes.titleId} = ${titleOf}`, sql`${movieEpisodes.season} = ${seasonOf}`, sql`${movieEpisodes.episode} = ${episodeOf}`),
    )
    // The episode's id when the play names a season and episode, else the title's (season and episode null on both sides).
    .leftJoin(
      movieIds,
      and(
        sql`${movieIds.titleId} = ${titleOf}`,
        sql`${movieIds.season} is not distinct from ${seasonOf}`,
        sql`${movieIds.episode} is not distinct from ${episodeOf}`,
      ),
    )
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
    .limit(limit);
  return rows.map(({ play, file, titleId, season, episode, titleName, titleKind, episodeName, movieId }) => {
    const duration = play.durationS ?? file?.durationS ?? null;
    return {
      id: Number(play.id),
      file_id: play.fileId === null ? null : Number(play.fileId),
      title_id: titleId,
      title: titleName ?? null,
      kind: (titleKind ?? null) as TitleKind | null,
      season: season === null ? null : Number(season),
      episode: episode === null ? null : Number(episode),
      episode_name: episodeName ?? null,
      movie_id: movieId ?? null,
      file_name: file?.name ?? null,
      file_deleted: file !== null && file.deletedAt !== null,
      file_deleted_at: isoOrNull(file?.deletedAt ?? null),
      host: play.host,
      source: play.source as PlaySource,
      provider: play.provider,
      started_at: iso(play.startedAt),
      ended_at: isoOrNull(play.endedAt),
      start_position_s: play.startPositionS,
      position_s: play.positionS,
      duration_s: duration,
      ratio: ratioOf(play.positionS, duration),
    };
  });
}

function parsedView(raw: ParsedNameRecord | null): ParsedView | null {
  if (raw === null) return null;
  return {
    title: raw.title,
    year: raw.year ?? null,
    season: raw.season ?? null,
    episode: raw.episode ?? null,
    absolute_episode: raw.absoluteEpisode ?? null,
    kind_hint: raw.kindHint ?? null,
  };
}

/** The hidden list: this host's live files the sync could not place, newest seen first. */
export async function listUnmatched(db: Db, ctx: ReadContext): Promise<UnmatchedFile[]> {
  const rows = await db
    .select()
    .from(movieFiles)
    .where(and(eq(movieFiles.host, ctx.host), isNull(movieFiles.deletedAt), inArray(movieFiles.status, ['unmatched', 'pending'])))
    .orderBy(desc(movieFiles.lastSeenAt), desc(movieFiles.id));
  return rows.map((row) => ({
    id: Number(row.id),
    host: row.host,
    path: row.path,
    name: row.name,
    size: num(row.size),
    duration_s: row.durationS,
    status: row.status as 'unmatched' | 'pending',
    reason: (row.reason ?? null) as FileReason | null,
    parsed: parsedView(row.parsed ?? null),
    first_seen_at: iso(row.firstSeenAt),
    last_seen_at: iso(row.lastSeenAt),
    available: true,
  }));
}

/** Counts for the page header and the unmatched badge. */
export async function statusCounts(db: Db, ctx: ReadContext): Promise<StatusCounts> {
  const res = await db.execute<{ titles: number; files_here: number; unmatched_here: number; pending_here: number }>(sql`
    select
      (select count(*)::int from movie_titles where ${inLibrarySql()}) as titles,
      (select count(*)::int from movie_files where host = ${ctx.host} and deleted_at is null and status = 'matched') as files_here,
      (select count(*)::int from movie_files where host = ${ctx.host} and deleted_at is null and status = 'unmatched') as unmatched_here,
      (select count(*)::int from movie_files where host = ${ctx.host} and deleted_at is null and status = 'pending') as pending_here
  `);
  const row = res.rows[0];
  return {
    titles: Number(row?.titles ?? 0),
    files_here: Number(row?.files_here ?? 0),
    unmatched_here: Number(row?.unmatched_here ?? 0),
    pending_here: Number(row?.pending_here ?? 0),
  };
}

/** TMDB search hits for the manual fix, each marked when its title is already in the library. */
export async function searchHitViews(db: Db, hits: readonly TmdbSearchHit[], ctx: ReadContext): Promise<TmdbHitView[]> {
  const ids = hits.map((h) => makeTitleId(h.kind, h.tmdbId));
  const known =
    ids.length === 0
      ? new Set<string>()
      : new Set((await db.select({ id: movieTitles.id }).from(movieTitles).where(and(inArray(movieTitles.id, ids), inLibrarySql()))).map((r) => r.id));
  return hits.map((h, i) => {
    const id = ids[i] ?? makeTitleId(h.kind, h.tmdbId);
    return {
      kind: h.kind,
      tmdb_id: h.tmdbId,
      title_id: id,
      title: h.title,
      original_title: h.originalTitle,
      year: h.year,
      overview: h.overview,
      poster_url: imageUrl(ctx, h.posterPath, IMAGE_SIZES.grid),
      in_library: known.has(id),
    };
  });
}
