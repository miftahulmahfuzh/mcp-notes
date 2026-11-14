import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  movieCompanies,
  movieCredits,
  movieEpisodes,
  movieFiles,
  movieIds,
  moviePeople,
  moviePlays,
  movieTitleCompanies,
  movieTitles,
  notes,
} from '../db/schema.js';
import { emptyTitleMovieIds, episodeKey, movieIdsOfTitles, type TitleMovieIds } from './ids.js';
import { reviewText } from './reviewNote.js';
import { FINISHED_RATIO, fileState, resumePosition, titleState } from './state.js';
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
export type PlaySource = 'live' | 'vlc_recents';
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
  file_id: number;
  title_id: string | null;
  title: string | null;
  kind: TitleKind | null;
  season: number | null;
  episode: number | null;
  /** The episode's TMDB name; null for a film or an episode TMDB does not list. */
  episode_name: string | null;
  /** What was played: the episode's movie id, or the title's for a film. */
  movie_id: string | null;
  file_name: string;
  file_deleted: boolean;
  file_deleted_at: string | null;
  host: string;
  source: PlaySource;
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

/** An episode (or film) watched to the end in any copy is finished; otherwise its primary file decides. */
function groupState(files: readonly FileView[]): WatchState {
  if (files.some((f) => f.state === 'finished')) return 'finished';
  return primaryFile(files)?.state ?? 'unwatched';
}

// ---------- titles ----------

interface TitleParts {
  files: FileView[];
  episodes: EpisodeRow[];
  ids: TitleMovieIds;
}

function emptyParts(): TitleParts {
  return { files: [], episodes: [], ids: emptyTitleMovieIds() };
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
  for (const row of fileRows) {
    if (row.titleId === null) continue;
    parts.get(row.titleId)?.files.push(fileView(row, last.get(Number(row.id)) ?? null, ctx));
  }
  for (const row of episodeRows) parts.get(row.titleId)?.episodes.push(row);
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
}

function episodeView(slot: EpisodeSlot, ids: TitleMovieIds, ctx: ReadContext): EpisodeView {
  const primary = primaryFile(slot.files);
  return {
    movie_id: ids.episodes.get(episodeKey(slot.season, slot.episode)) ?? null,
    season: slot.season,
    episode: slot.episode,
    name: slot.row?.name ?? null,
    air_date: dateOnly(slot.row?.airDate ?? null),
    runtime_min: slot.row?.runtimeMin ?? null,
    overview: slot.row?.overview ?? null,
    still_url: imageUrl(ctx, slot.row?.stillPath ?? null, IMAGE_SIZES.still),
    state: groupState(slot.files),
    has_file: slot.files.length > 0,
    present_here: slot.files.some((f) => f.available),
    deleted: slot.files.length > 0 && slot.files.every((f) => f.deleted),
    progress: primary?.progress ?? NO_PROGRESS,
    last_played_at: latest(slot.files.map((f) => f.last_played_at)),
    finished_at: latest(slot.files.map((f) => f.finished_at)),
    file_id: primary?.id ?? null,
    files: slot.files,
  };
}

/** Episodes of a series: TMDB's list plus any (season, episode) only a file names. Specials (season 0) only with a file. */
function buildSeasons(parts: TitleParts, ctx: ReadContext): { seasons: SeasonView[]; episodes: EpisodeView[]; unplaced: FileView[] } {
  const slots = new Map<string, EpisodeSlot>();
  const key = (s: number, e: number): string => `${s}x${e}`;
  for (const row of parts.episodes) slots.set(key(row.season, row.episode), { row, season: row.season, episode: row.episode, files: [] });
  const unplaced: FileView[] = [];
  for (const f of parts.files) {
    if (f.season === null || f.episode === null) {
      unplaced.push(f);
      continue;
    }
    const k = key(f.season, f.episode);
    let slot = slots.get(k);
    if (slot === undefined) {
      slot = { row: null, season: f.season, episode: f.episode, files: [] };
      slots.set(k, slot);
    }
    slot.files.push(f);
  }
  const episodes = [...slots.values()]
    .filter((s) => s.season >= 1 || s.files.length > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .map((s) => episodeView(s, parts.ids, ctx));
  const seasons: SeasonView[] = [];
  for (const ep of episodes) {
    const lastSeason = seasons[seasons.length - 1];
    if (lastSeason !== undefined && lastSeason.season === ep.season) lastSeason.episodes.push(ep);
    else seasons.push({ season: ep.season, episodes: [ep] });
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
  let state: WatchState;
  let progress: TitleProgress;
  let seasons: SeasonView[] = [];
  let unplaced: FileView[] = [];
  if (kind === 'tv') {
    const built = buildSeasons(parts, ctx);
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
    state = titleState('movie', files.map((f) => f.state));
    const primary = primaryFile(files);
    const p = primary?.progress ?? NO_PROGRESS;
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
    rating: t.rating,
    progress,
    last_played_at: latest(files.map((f) => f.last_played_at)),
    finished_at: latest([t.watchedAt, ...files.map((f) => f.finished_at)]),
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

/** The grid: every title matching the filter, with its derived state and progress. */
export async function listTitles(db: Db, filter: TitleFilter, ctx: ReadContext): Promise<TitleListItem[]> {
  const where: SQL[] = [];
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

/** One title with every file (deleted and other hosts included), episodes, credits, review and recent plays. */
export async function getTitle(db: Db, id: string, ctx: ReadContext): Promise<TitleDetail | null> {
  const [t] = await db.select().from(movieTitles).where(eq(movieTitles.id, id)).limit(1);
  if (t === undefined) return null;
  const parts = (await loadParts(db, [t], ctx)).get(t.id) ?? emptyParts();
  const built = buildTitle(t, parts, ctx, IMAGE_SIZES.detail);
  const [companies, credits, review, plays] = await Promise.all([
    titleCompanies(db, t.id, ctx),
    titleCredits(db, t.id),
    reviewOf(db, t.reviewNoteId),
    history(db, { titleId: t.id, limit: DETAIL_PLAY_LIMIT }),
  ]);
  return {
    ...built.item,
    original_title: t.originalTitle,
    release_date: dateOnly(t.releaseDate),
    overview: t.overview,
    runtime_min: t.runtimeMin,
    genres: t.genres ?? [],
    backdrop_url: imageUrl(ctx, t.backdropPath, IMAGE_SIZES.backdrop),
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
    metadata_fetched_at: isoOrNull(t.metadataFetchedAt),
  };
}

/** Play events, newest first, with their file and title; deleted files included (history survives deletion). */
export async function history(db: Db, filter: HistoryFilter = {}): Promise<PlayView[]> {
  const where: SQL[] = [];
  if (filter.titleId !== undefined) where.push(eq(movieFiles.titleId, filter.titleId));
  if (filter.fileId !== undefined) where.push(eq(moviePlays.fileId, filter.fileId));
  if (filter.host !== undefined) where.push(eq(moviePlays.host, filter.host));
  if (filter.from !== undefined) where.push(gte(moviePlays.startedAt, filter.from));
  if (filter.to !== undefined) where.push(lt(moviePlays.startedAt, filter.to));
  const limit = clamp(filter.limit ?? DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT);
  const rows = await db
    .select({ play: moviePlays, file: movieFiles, titleName: movieTitles.title, titleKind: movieTitles.kind, episodeName: movieEpisodes.name, movieId: movieIds.id })
    .from(moviePlays)
    .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
    .leftJoin(movieTitles, eq(movieTitles.id, movieFiles.titleId))
    .leftJoin(
      movieEpisodes,
      and(eq(movieEpisodes.titleId, movieFiles.titleId), eq(movieEpisodes.season, movieFiles.season), eq(movieEpisodes.episode, movieFiles.episode)),
    )
    // The episode's id for a file with a season and episode, else the title's (season and episode null on both sides).
    .leftJoin(
      movieIds,
      and(
        eq(movieIds.titleId, movieFiles.titleId),
        sql`${movieIds.season} is not distinct from ${movieFiles.season}`,
        sql`${movieIds.episode} is not distinct from ${movieFiles.episode}`,
      ),
    )
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
    .limit(limit);
  return rows.map(({ play, file, titleName, titleKind, episodeName, movieId }) => {
    const duration = play.durationS ?? file.durationS ?? null;
    return {
      id: Number(play.id),
      file_id: Number(play.fileId),
      title_id: file.titleId,
      title: titleName ?? null,
      kind: (titleKind ?? null) as TitleKind | null,
      season: file.season,
      episode: file.episode,
      episode_name: episodeName ?? null,
      movie_id: movieId ?? null,
      file_name: file.name,
      file_deleted: file.deletedAt !== null,
      file_deleted_at: isoOrNull(file.deletedAt),
      host: play.host,
      source: play.source as PlaySource,
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
      (select count(*)::int from movie_titles) as titles,
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
      : new Set((await db.select({ id: movieTitles.id }).from(movieTitles).where(inArray(movieTitles.id, ids))).map((r) => r.id));
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
