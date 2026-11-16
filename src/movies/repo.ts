import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import {
  movieCompanies,
  movieCredits,
  movieEpisodeMarks,
  movieEpisodes,
  movieFiles,
  moviePeople,
  moviePlays,
  movieStreamSources,
  movieTitleCompanies,
  movieTitles,
  type MovieFileRow,
  type MoviePlayRow,
  type MovieStreamSourceRow,
  type MovieTitleRow,
} from '../db/schema.js';
import { FINISHED_RATIO } from './state.js';
import {
  type EpisodeRef,
  classifyReason,
  titleId,
  type FileClassification,
  type FilePlay,
  type FileReason,
  type FileStatus,
  type FinishedFilter,
  type FinishedTitle,
  type NewMovieFile,
  type NewPlay,
  type PlayReading,
  type RecentsObservation,
  type StreamPositionInput,
  type StreamPositionWrite,
  type StreamSourceOutcome,
  type TitleKind,
  type TitleMetadata,
  type TitleTrailers,
  type TitleUserPatch,
} from './types.js';

/** Rows per multi-row INSERT: far below Postgres' 65535 bind parameters at 8 columns a row. */
const INSERT_CHUNK = 500;
/** Two VLC recents readings of one file closer than this (seconds) are the same observation. */
const SAME_OBSERVATION_S = 0.5;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) out.push(rows.slice(i, i + INSERT_CHUNK));
  return out;
}

function uniqueBy<T, K>(rows: readonly T[], key: (row: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

/** An ILIKE pattern matching `text` anywhere, with `%`, `_` and `\` in it taken literally. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The freshness rule of a stream source row (direct streaming, invariant 10), in its three forms,
 * kept together: a row of `host`, verified at or after `since`, and not stale. A stale row (a
 * resolve that found no source) leaves the Stream grid until a resolve verifies it again, which
 * clears `stale_at`. tests/integration/movies.streams.int.test.ts proves the forms agree.
 */
function freshCondition(host: string, since: Date): SQL {
  return sql`s.host = ${host} and s.stale_at is null and s.verified_at >= ${since}`;
}

/** SQL, inside a query over `movie_titles`: the title has a fresh source on `host`. */
export function freshStreamSourceSql(host: string, since: Date): SQL {
  return sql`exists (select 1 from movie_stream_sources s where s.title_id = movie_titles.id and ${freshCondition(host, since)})`;
}

/** JS: the same rule on one row. */
export function isFreshStreamSource(row: Pick<MovieStreamSourceRow, 'host' | 'staleAt' | 'verifiedAt'>, host: string, since: Date): boolean {
  return row.host === host && row.staleAt === null && row.verifiedAt !== null && row.verifiedAt.getTime() >= since.getTime();
}

/** The start of the freshness window: `freshDays` (NOTESD_STREAM_FRESH_DAYS) before `now`. */
export function streamFreshSince(now: Date, freshDays: number): Date {
  return new Date(now.getTime() - freshDays * 86_400_000);
}

function classificationColumns(c: FileClassification): { status: FileStatus; titleId: string | null; reason: FileReason | null } {
  switch (c.status) {
    case 'matched':
      return { status: 'matched', titleId: c.titleId, reason: null };
    case 'unmatched':
      return { status: 'unmatched', titleId: null, reason: c.reason };
    case 'pending':
      return { status: 'pending', titleId: null, reason: c.reason };
  }
}

function samePosition(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < SAME_OBSERVATION_S;
}

/**
 * Every moment a title or one of its files became finished, as (title_id, at): the title's manual
 * flag, a file's manual flag, a file's done signal, an episode's manual mark, every file play that reached FINISHED_RATIO of
 * its duration (the play's reading, else the file's; state.ts `reachedEnd` is the same rule), and
 * every stream play that reached it of the player's reading (state.ts `streamState`: a stream has
 * no duration of its own). A play still open counts at its last update. Comparisons run in double
 * precision, as in JS.
 */
function finishEventsSql(): SQL {
  return sql`
    select t.id as title_id, t.watched_at as at from movie_titles t where t.watched_at is not null
    union all
    select f.title_id, f.watched_at from movie_files f where f.title_id is not null and f.watched_at is not null
    union all
    select f.title_id, f.done_at from movie_files f where f.title_id is not null and f.done_at is not null
    union all
    select m.title_id, m.watched_at from movie_episode_marks m
    union all
    select f.title_id, coalesce(p.ended_at, p.updated_at)
    from movie_plays p join movie_files f on f.id = p.file_id
    where f.title_id is not null
      and p.position_s is not null
      and coalesce(p.duration_s, f.duration_s) > 0
      and p.position_s::double precision >= ${FINISHED_RATIO}::double precision * coalesce(p.duration_s, f.duration_s)::double precision
    union all
    select p.title_id, coalesce(p.ended_at, p.updated_at)
    from movie_plays p
    where p.source = 'stream'
      and p.position_s is not null
      and p.duration_s > 0
      and p.position_s::double precision >= ${FINISHED_RATIO}::double precision * p.duration_s::double precision`;
}

/**
 * The only writer of the `movie_*` tables (MOVIES_LIBRARY_PLAN invariant 2): the sync pass,
 * routes, MCP tools, the player and the direct-stream recorder (src/movies/streams.ts) all write
 * through it. It also holds the reads those callers share. Titles are never deleted, files only
 * soft-deleted, plays never deleted.
 */
export class MoviesRepo {
  constructor(private readonly db: Db) {}

  // ---------- titles ----------

  /**
   * Stores a TMDB match: the title's TMDB columns are rewritten (the owner's watched flag, rating
   * and review link are kept), companies and people are upserted, and the title's company links,
   * credits and episodes are replaced. Returns the title id.
   */
  async upsertTitle(meta: TitleMetadata, now: Date = new Date()): Promise<string> {
    const id = titleId(meta.kind, meta.tmdbId);
    await this.db.transaction(async (tx) => {
      const tmdbColumns = {
        title: meta.title,
        originalTitle: meta.originalTitle,
        // Kept when this metadata does not say (older callers, a TMDB answer without it).
        ...(meta.originalLanguage === undefined || meta.originalLanguage === null ? {} : { originalLanguage: meta.originalLanguage }),
        year: meta.year,
        releaseDate: meta.releaseDate,
        overview: meta.overview,
        posterPath: meta.posterPath,
        backdropPath: meta.backdropPath,
        trailerKey: meta.trailers.title,
        seasonTrailers: meta.trailers.seasons,
        trailersCheckedAt: now,
        runtimeMin: meta.runtimeMin,
        genres: meta.genres,
        seasonCount: meta.seasonCount,
        episodeCount: meta.episodeCount,
        metadataFetchedAt: now,
        updatedAt: now,
      };
      await tx
        .insert(movieTitles)
        .values({ id, kind: meta.kind, tmdbId: meta.tmdbId, createdAt: now, ...tmdbColumns })
        .onConflictDoUpdate({ target: movieTitles.id, set: tmdbColumns });

      const companies = uniqueBy(meta.companies, (c) => c.id);
      if (companies.length > 0) {
        await tx
          .insert(movieCompanies)
          .values(companies.map((c) => ({ id: c.id, name: c.name, logoPath: c.logoPath, originCountry: c.originCountry })))
          .onConflictDoUpdate({
            target: movieCompanies.id,
            set: { name: sql`excluded.name`, logoPath: sql`excluded.logo_path`, originCountry: sql`excluded.origin_country` },
          });
      }
      await tx.delete(movieTitleCompanies).where(eq(movieTitleCompanies.titleId, id));
      if (companies.length > 0) {
        await tx.insert(movieTitleCompanies).values(companies.map((c, ord) => ({ titleId: id, companyId: c.id, ord })));
      }

      const people = uniqueBy(meta.credits, (c) => c.personId);
      for (const batch of chunks(people)) {
        await tx
          .insert(moviePeople)
          .values(batch.map((p) => ({ id: p.personId, name: p.name, profilePath: p.profilePath })))
          .onConflictDoUpdate({ target: moviePeople.id, set: { name: sql`excluded.name`, profilePath: sql`excluded.profile_path` } });
      }
      await tx.delete(movieCredits).where(eq(movieCredits.titleId, id));
      const credits = meta.credits.map((c, ord) => ({
        titleId: id,
        personId: c.personId,
        role: c.role,
        character: c.character,
        job: c.job,
        ord,
      }));
      for (const batch of chunks(credits)) await tx.insert(movieCredits).values(batch);

      await tx.delete(movieEpisodes).where(eq(movieEpisodes.titleId, id));
      const episodes = uniqueBy(meta.episodes, (e) => `${e.season}x${e.episode}`).map((e) => ({ titleId: id, ...e }));
      for (const batch of chunks(episodes)) await tx.insert(movieEpisodes).values(batch);
    });
    return id;
  }

  /**
   * Titles TMDB was never asked about trailers for (stored before trailers were kept), oldest
   * first, each with the seasons its episode list names.
   */
  async titlesWithoutTrailers(limit: number): Promise<Array<{ id: string; kind: TitleKind; tmdbId: number; seasons: number[] }>> {
    const titles = await this.db
      .select({ id: movieTitles.id, kind: movieTitles.kind, tmdbId: movieTitles.tmdbId })
      .from(movieTitles)
      .where(isNull(movieTitles.trailersCheckedAt))
      .orderBy(asc(movieTitles.createdAt), asc(movieTitles.id))
      .limit(limit);
    const out: Array<{ id: string; kind: TitleKind; tmdbId: number; seasons: number[] }> = [];
    for (const t of titles) {
      const seasons =
        t.kind === 'tv'
          ? await this.db
              .selectDistinct({ season: movieEpisodes.season })
              .from(movieEpisodes)
              .where(eq(movieEpisodes.titleId, t.id))
              .orderBy(asc(movieEpisodes.season))
          : [];
      out.push({ ...t, seasons: seasons.map((s) => s.season) });
    }
    return out;
  }

  /** Stores a title's trailers and marks them checked. Nothing else of the title changes. */
  async setTitleTrailers(id: string, trailers: TitleTrailers, now: Date = new Date()): Promise<void> {
    await this.db
      .update(movieTitles)
      .set({ trailerKey: trailers.title, seasonTrailers: trailers.seasons, trailersCheckedAt: now })
      .where(eq(movieTitles.id, id));
  }

  /** Sets the owner's state on a title. Returns the updated row, or null for an unknown id. */
  async setTitleUser(id: string, patch: TitleUserPatch, now: Date = new Date()): Promise<MovieTitleRow | null> {
    const set: PgUpdateSetSource<typeof movieTitles> = { updatedAt: now };
    if (patch.watched !== undefined) set.watchedAt = patch.watched ? sql`coalesce(${movieTitles.watchedAt}, ${now})` : null;
    if (patch.notInterested !== undefined) set.notInterestedAt = patch.notInterested ? sql`coalesce(${movieTitles.notInterestedAt}, ${now})` : null;
    if (patch.rating !== undefined) set.rating = patch.rating;
    if (patch.reviewNoteId !== undefined) set.reviewNoteId = patch.reviewNoteId;
    const rows = await this.db.update(movieTitles).set(set).where(eq(movieTitles.id, id)).returning();
    return rows[0] ?? null;
  }

  /**
   * The episodes of one season the owner can mark: the ones TMDB lists, plus any a file of the
   * title names (deleted files included), in episode order.
   */
  async seasonEpisodes(titleIdValue: string, season: number): Promise<EpisodeRef[]> {
    const res = await this.db.execute<{ episode: number }>(sql`
      select episode from movie_episodes where title_id = ${titleIdValue} and season = ${season}
      union
      select episode from movie_files where title_id = ${titleIdValue} and season = ${season} and episode is not null
      order by episode`);
    return res.rows.map((r) => ({ season, episode: Number(r.episode) }));
  }

  /**
   * Sets or clears the owner's "finished" mark on episodes of one title. Returns the episodes whose
   * mark changed (already marked, or already unmarked, ones are left out), so the caller can undo
   * exactly this call. A mark is independent of files and plays: clearing it never un-finishes an
   * episode a play or a file flag finished.
   */
  async setEpisodesWatched(titleIdValue: string, episodes: readonly EpisodeRef[], watched: boolean, now: Date = new Date()): Promise<EpisodeRef[]> {
    if (episodes.length === 0) return [];
    const changed: EpisodeRef[] = [];
    await this.db.transaction(async (tx) => {
      for (const e of episodes) {
        const rows = watched
          ? await tx
              .insert(movieEpisodeMarks)
              .values({ titleId: titleIdValue, season: e.season, episode: e.episode, watchedAt: now })
              .onConflictDoNothing()
              .returning({ season: movieEpisodeMarks.season })
          : await tx
              .delete(movieEpisodeMarks)
              .where(and(eq(movieEpisodeMarks.titleId, titleIdValue), eq(movieEpisodeMarks.season, e.season), eq(movieEpisodeMarks.episode, e.episode)))
              .returning({ season: movieEpisodeMarks.season });
        if (rows.length > 0) changed.push({ season: e.season, episode: e.episode });
      }
      if (changed.length > 0) await tx.update(movieTitles).set({ updatedAt: now }).where(eq(movieTitles.id, titleIdValue));
    });
    return changed;
  }

  async titleById(id: string): Promise<MovieTitleRow | null> {
    const rows = await this.db.select().from(movieTitles).where(eq(movieTitles.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Stores a title's original language (TMDB's code). False when the title is not stored. */
  async setOriginalLanguage(id: string, language: string, now: Date = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(movieTitles)
      .set({ originalLanguage: language, updatedAt: now })
      .where(eq(movieTitles.id, id))
      .returning({ id: movieTitles.id });
    return rows.length > 0;
  }

  /**
   * Remembers one more name the owner uses for a title (already normalized), once. False when the
   * title is not stored or already has it.
   */
  async addTitleAlias(id: string, alias: string, now: Date = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(movieTitles)
      .set({ aliases: sql`array_append(${movieTitles.aliases}, ${alias})`, updatedAt: now })
      .where(and(eq(movieTitles.id, id), sql`not (${alias} = any(${movieTitles.aliases}))`))
      .returning({ id: movieTitles.id });
    return rows.length > 0;
  }

  /** The stored TMDB metadata of a title, in the shape `upsertTitle` takes, or null. */
  async loadTitleMetadata(id: string): Promise<TitleMetadata | null> {
    const title = await this.titleById(id);
    if (title === null) return null;
    const [companies, credits, episodes] = await Promise.all([
      this.db
        .select({
          id: movieCompanies.id,
          name: movieCompanies.name,
          logoPath: movieCompanies.logoPath,
          originCountry: movieCompanies.originCountry,
        })
        .from(movieTitleCompanies)
        .innerJoin(movieCompanies, eq(movieCompanies.id, movieTitleCompanies.companyId))
        .where(eq(movieTitleCompanies.titleId, id))
        .orderBy(asc(movieTitleCompanies.ord)),
      this.db
        .select({
          personId: moviePeople.id,
          name: moviePeople.name,
          profilePath: moviePeople.profilePath,
          role: movieCredits.role,
          character: movieCredits.character,
          job: movieCredits.job,
        })
        .from(movieCredits)
        .innerJoin(moviePeople, eq(moviePeople.id, movieCredits.personId))
        .where(eq(movieCredits.titleId, id))
        .orderBy(asc(movieCredits.ord), asc(movieCredits.id)),
      this.db
        .select({
          season: movieEpisodes.season,
          episode: movieEpisodes.episode,
          name: movieEpisodes.name,
          airDate: movieEpisodes.airDate,
          runtimeMin: movieEpisodes.runtimeMin,
          overview: movieEpisodes.overview,
          stillPath: movieEpisodes.stillPath,
        })
        .from(movieEpisodes)
        .where(eq(movieEpisodes.titleId, id))
        .orderBy(asc(movieEpisodes.season), asc(movieEpisodes.episode)),
    ]);
    return {
      kind: title.kind,
      tmdbId: title.tmdbId,
      title: title.title,
      originalTitle: title.originalTitle,
      year: title.year,
      releaseDate: title.releaseDate,
      overview: title.overview,
      posterPath: title.posterPath,
      backdropPath: title.backdropPath,
      runtimeMin: title.runtimeMin,
      genres: title.genres,
      seasonCount: title.seasonCount,
      episodeCount: title.episodeCount,
      companies,
      credits,
      episodes,
      trailers: { title: title.trailerKey, seasons: title.seasonTrailers },
    };
  }

  // ---------- files ----------

  /**
   * Records a file. A new live (host, path) is inserted with everything in `input`; a live row
   * already at that path only gets the scan facts refreshed (size, mtime, duration when known,
   * last_seen_at) and keeps its title, status, reason and signals. An input with `deletedAt` (a
   * file known only from VLC's recent list) is always inserted, already deleted.
   */
  async upsertFile(input: NewMovieFile, now: Date = new Date()): Promise<{ file: MovieFileRow; created: boolean }> {
    const values = {
      ...classificationColumns(input.classification),
      host: input.host,
      path: input.path,
      name: input.name,
      size: input.size,
      mtime: input.mtime,
      durationS: input.durationS,
      season: input.season,
      episode: input.episode,
      absoluteEpisode: input.absoluteEpisode,
      parsed: input.parsed,
      source: input.source,
      firstSeenAt: input.seenAt,
      lastSeenAt: input.seenAt,
      deletedAt: input.deletedAt ?? null,
      doneAt: input.doneAt ?? null,
      updatedAt: now,
    };
    if (values.deletedAt !== null) {
      const [file] = await this.db.insert(movieFiles).values(values).returning();
      if (file === undefined) throw new Error('movie_files insert returned no row');
      return { file, created: true };
    }
    const rows = await this.db
      .insert(movieFiles)
      .values(values)
      .onConflictDoUpdate({
        target: [movieFiles.host, movieFiles.path],
        // Must match the partial unique index movie_files_live_path_uniq.
        targetWhere: sql`deleted_at is null`,
        set: {
          size: sql`excluded.size`,
          mtime: sql`excluded.mtime`,
          durationS: sql`coalesce(excluded.duration_s, ${movieFiles.durationS})`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      // xmax = 0 only on a freshly inserted row version (the standard upsert "was it new" test).
      .returning({ ...getTableColumns(movieFiles), inserted: sql<boolean>`(xmax = 0)` });
    const row = rows[0];
    if (row === undefined) throw new Error('movie_files upsert returned no row');
    const { inserted, ...file } = row;
    return { file, created: inserted };
  }

  /** Refreshes last_seen_at of live files. Returns how many rows changed. */
  async markSeen(fileIds: readonly number[], at: Date): Promise<number> {
    if (fileIds.length === 0) return 0;
    const rows = await this.db
      .update(movieFiles)
      .set({ lastSeenAt: at, updatedAt: at })
      .where(and(inArray(movieFiles.id, [...fileIds]), isNull(movieFiles.deletedAt)))
      .returning({ id: movieFiles.id });
    return rows.length;
  }

  /** Soft-deletes a live file; its title and plays stay. False when it was already deleted or is unknown. */
  async markDeleted(fileId: number, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(movieFiles)
      .set({ deletedAt: at, updatedAt: at })
      .where(and(eq(movieFiles.id, fileId), isNull(movieFiles.deletedAt)))
      .returning({ id: movieFiles.id });
    return rows.length > 0;
  }

  /**
   * Moves a live file to a new path (same name and size found elsewhere: not a delete). With
   * `done`, it also records the done signal (kept at its first time if already set).
   */
  async moveFile(fileId: number, to: { path: string; name: string }, at: Date, options: { done: boolean }): Promise<MovieFileRow | null> {
    const rows = await this.db
      .update(movieFiles)
      .set({
        path: to.path,
        name: to.name,
        movedAt: at,
        lastSeenAt: at,
        updatedAt: at,
        ...(options.done ? { doneAt: sql`coalesce(${movieFiles.doneAt}, ${at})` } : {}),
      })
      .where(and(eq(movieFiles.id, fileId), isNull(movieFiles.deletedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** Records the done signal (kept at its first time). */
  async setDone(fileId: number, at: Date): Promise<MovieFileRow | null> {
    const rows = await this.db
      .update(movieFiles)
      .set({ doneAt: sql`coalesce(${movieFiles.doneAt}, ${at})`, updatedAt: at })
      .where(eq(movieFiles.id, fileId))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * The owner's per-file flag. Unsetting it also clears the done signal, so a file moved into a
   * Done folder that the owner did not finish can be put back to its position-derived state.
   */
  async setFileWatched(fileId: number, watched: boolean, now: Date = new Date()): Promise<MovieFileRow | null> {
    const rows = await this.db
      .update(movieFiles)
      .set(watched ? { watchedAt: sql`coalesce(${movieFiles.watchedAt}, ${now})`, updatedAt: now } : { watchedAt: null, doneAt: null, updatedAt: now })
      .where(eq(movieFiles.id, fileId))
      .returning();
    return rows[0] ?? null;
  }

  /** Puts a file under a title (sync match or the owner's manual fix), optionally as one episode. */
  async assignFile(
    fileId: number,
    titleIdValue: string,
    episode?: { season: number | null; episode: number | null },
    now: Date = new Date(),
  ): Promise<MovieFileRow | null> {
    const rows = await this.db
      .update(movieFiles)
      .set({
        status: 'matched',
        titleId: titleIdValue,
        reason: null,
        updatedAt: now,
        ...(episode !== undefined ? { season: episode.season, episode: episode.episode } : {}),
      })
      .where(eq(movieFiles.id, fileId))
      .returning();
    return rows[0] ?? null;
  }

  /** Takes a file out of the library: `tmdb_error` leaves it pending (retried), any other reason unmatched. */
  async setUnmatched(fileId: number, reason: FileReason, now: Date = new Date()): Promise<MovieFileRow | null> {
    const rows = await this.db
      .update(movieFiles)
      .set({ ...classificationColumns(classifyReason(reason)), updatedAt: now })
      .where(eq(movieFiles.id, fileId))
      .returning();
    return rows[0] ?? null;
  }

  async fileById(fileId: number): Promise<MovieFileRow | null> {
    const rows = await this.db.select().from(movieFiles).where(eq(movieFiles.id, fileId)).limit(1);
    return rows[0] ?? null;
  }

  /** The live file at (host, path), else the most recently deleted one there, else null. */
  async fileByPath(host: string, path: string): Promise<MovieFileRow | null> {
    const rows = await this.db
      .select()
      .from(movieFiles)
      .where(and(eq(movieFiles.host, host), eq(movieFiles.path, path)))
      .orderBy(sql`(${movieFiles.deletedAt} is null) desc`, desc(movieFiles.deletedAt), desc(movieFiles.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** This host's files by path; deleted ones only with `includeDeleted`. */
  async filesForHost(host: string, options: { includeDeleted?: boolean } = {}): Promise<MovieFileRow[]> {
    const where = options.includeDeleted === true ? eq(movieFiles.host, host) : and(eq(movieFiles.host, host), isNull(movieFiles.deletedAt));
    return this.db.select().from(movieFiles).where(where).orderBy(asc(movieFiles.path), asc(movieFiles.id));
  }

  /**
   * The file a VLC recents entry names (phase 5): same host and path first, else same host and
   * basename (a file the sync moved keeps its row under the new path). Live rows before deleted
   * ones, then the newest.
   */
  async findTrackedFile(host: string, path: string, name: string): Promise<MovieFileRow | null> {
    const order = [sql`${movieFiles.deletedAt} is not null`, desc(movieFiles.id)] as const;
    const byPath = await this.db
      .select()
      .from(movieFiles)
      .where(and(eq(movieFiles.host, host), eq(movieFiles.path, path)))
      .orderBy(...order)
      .limit(1);
    if (byPath[0] !== undefined) return byPath[0];
    const byName = await this.db
      .select()
      .from(movieFiles)
      .where(and(eq(movieFiles.host, host), eq(movieFiles.name, name)))
      .orderBy(...order)
      .limit(1);
    return byName[0] ?? null;
  }

  // ---------- plays ----------

  /**
   * Daemon start (phase 5's MoviePlayer.start): every live play of `host` a previous process left
   * open is closed at the last position it wrote (`ended_at = updated_at`). Returns how many.
   */
  async closeOpenPlays(host: string): Promise<number> {
    const rows = await this.db
      .update(moviePlays)
      .set({ endedAt: sql`${moviePlays.updatedAt}` })
      .where(and(eq(moviePlays.host, host), eq(moviePlays.source, 'live'), isNull(moviePlays.endedAt)))
      .returning({ id: moviePlays.id });
    return rows.length;
  }

  /** This host's newest live plays with their files, newest first: what a VLC that outlived the daemon is matched against. */
  async recentLivePlays(host: string, limit: number): Promise<FilePlay[]> {
    return this.db
      .select({ play: moviePlays, file: movieFiles })
      .from(moviePlays)
      .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
      .where(and(eq(moviePlays.host, host), eq(moviePlays.source, 'live')))
      .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
      .limit(limit);
  }

  /** Opens a closed live play again: the VLC it followed is still running. Null when it is unknown or already open. */
  async reopenPlay(playId: number, now: Date = new Date()): Promise<MoviePlayRow | null> {
    const rows = await this.db
      .update(moviePlays)
      .set({ endedAt: null, updatedAt: now })
      .where(and(eq(moviePlays.id, playId), eq(moviePlays.source, 'live'), isNotNull(moviePlays.endedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /** Opens a play event; its position starts at `startPositionS`. */
  async startPlay(input: NewPlay): Promise<MoviePlayRow> {
    const [play] = await this.db
      .insert(moviePlays)
      .values({
        fileId: input.fileId,
        host: input.host,
        source: input.source,
        startedAt: input.startedAt,
        startPositionS: input.startPositionS,
        positionS: input.startPositionS,
        durationS: input.durationS,
        updatedAt: input.startedAt,
      })
      .returning();
    if (play === undefined) throw new Error('movie_plays insert returned no row');
    return play;
  }

  /** Writes one reading into an open play. False when the play is closed or unknown. */
  async updatePlay(playId: number, reading: PlayReading, now: Date = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(moviePlays)
      .set({ positionS: reading.positionS, durationS: reading.durationS, updatedAt: now })
      .where(and(eq(moviePlays.id, playId), isNull(moviePlays.endedAt)))
      .returning({ id: moviePlays.id });
    return rows.length > 0;
  }

  /** Closes an open play, with its last reading when given (an absent key keeps the stored value). */
  async endPlay(playId: number, reading: Partial<PlayReading>, endedAt: Date): Promise<MoviePlayRow | null> {
    const set: PgUpdateSetSource<typeof moviePlays> = { endedAt, updatedAt: endedAt };
    if (reading.positionS !== undefined) set.positionS = reading.positionS;
    if (reading.durationS !== undefined) set.durationS = reading.durationS;
    const rows = await this.db
      .update(moviePlays)
      .set(set)
      .where(and(eq(moviePlays.id, playId), isNull(moviePlays.endedAt)))
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Records one VLC recents entry as a closed play at `observedAt`, unless the newest recents
   * play of that file already has the same position (VLC keeps the entry until it changes, so
   * every sync pass reads it again).
   */
  async recordObservation(obs: RecentsObservation): Promise<{ play: MoviePlayRow; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const [last] = await tx
        .select()
        .from(moviePlays)
        .where(and(eq(moviePlays.fileId, obs.fileId), eq(moviePlays.source, 'vlc_recents')))
        .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
        .limit(1);
      if (last !== undefined && samePosition(last.positionS, obs.positionS)) return { play: last, created: false };
      const [play] = await tx
        .insert(moviePlays)
        .values({
          fileId: obs.fileId,
          host: obs.host,
          source: 'vlc_recents',
          startedAt: obs.observedAt,
          endedAt: obs.observedAt,
          startPositionS: null,
          positionS: obs.positionS,
          durationS: obs.durationS,
          updatedAt: obs.observedAt,
        })
        .returning();
      if (play === undefined) throw new Error('movie_plays insert returned no row');
      return { play, created: true };
    });
  }

  /** The play `fileState` reads: the newest with a known position, else the newest, else null. */
  async lastPlay(fileId: number): Promise<MoviePlayRow | null> {
    const rows = await this.db
      .select()
      .from(moviePlays)
      .where(eq(moviePlays.fileId, fileId))
      .orderBy(sql`(${moviePlays.positionS} is not null) desc`, desc(moviePlays.startedAt), desc(moviePlays.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The newest play of any file (of one host when given), with its file. */
  async latestPlay(host?: string): Promise<FilePlay | null> {
    const rows = await this.db
      .select({ play: moviePlays, file: movieFiles })
      .from(moviePlays)
      .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
      .where(host === undefined ? undefined : eq(moviePlays.host, host))
      .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ---------- streams (direct streaming) ----------

  /**
   * Daemon start: player sessions live in memory, so every stream play of `host` the previous
   * process left open is closed at the last position it wrote (`ended_at = updated_at`). Returns how many.
   */
  async closeOpenStreamPlays(host: string): Promise<number> {
    const rows = await this.db
      .update(moviePlays)
      .set({ endedAt: sql`${moviePlays.updatedAt}` })
      .where(and(eq(moviePlays.host, host), eq(moviePlays.source, 'stream'), isNull(moviePlays.endedAt)))
      .returning({ id: moviePlays.id });
    return rows.length;
  }

  /**
   * One position report of the player page. The session's open row gets the position (its first
   * report opens it, starting at that position); `ended` closes it. Opening a row closes this
   * host's other open stream plays at their last update (one screen, one film). A report with
   * `ended` for a session whose row is already closed writes nothing. At most one open row per
   * session (`movie_plays_open_session_uniq`), so two reports at once still write one row.
   */
  async recordStreamPosition(input: StreamPositionInput): Promise<StreamPositionWrite> {
    return this.db.transaction(async (tx) => {
      const [open] = await tx
        .select({ id: moviePlays.id })
        .from(moviePlays)
        .where(and(eq(moviePlays.streamSession, input.sessionId), isNull(moviePlays.endedAt)))
        .limit(1);
      if (open === undefined && input.ended) {
        const [last] = await tx
          .select()
          .from(moviePlays)
          .where(eq(moviePlays.streamSession, input.sessionId))
          .orderBy(desc(moviePlays.id))
          .limit(1);
        if (last !== undefined) return { play: last, created: false, closed: false };
      }
      await tx
        .update(moviePlays)
        .set({ endedAt: sql`${moviePlays.updatedAt}` })
        .where(
          and(
            eq(moviePlays.host, input.host),
            eq(moviePlays.source, 'stream'),
            isNull(moviePlays.endedAt),
            ne(moviePlays.streamSession, input.sessionId),
          ),
        );
      const rows = await tx
        .insert(moviePlays)
        .values({
          fileId: null,
          titleId: input.titleId,
          season: input.season,
          episode: input.episode,
          provider: input.provider,
          streamSession: input.sessionId,
          host: input.host,
          source: 'stream',
          startedAt: input.at,
          endedAt: null,
          startPositionS: input.positionS,
          positionS: input.positionS,
          durationS: input.durationS,
          updatedAt: input.at,
        })
        .onConflictDoUpdate({
          target: moviePlays.streamSession,
          // Must match the partial unique index movie_plays_open_session_uniq.
          targetWhere: sql`ended_at is null and stream_session is not null`,
          set: {
            positionS: sql`excluded.position_s`,
            durationS: sql`coalesce(excluded.duration_s, ${moviePlays.durationS})`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        // xmax = 0 only on a freshly inserted row version (the standard upsert "was it new" test).
        .returning({ ...getTableColumns(moviePlays), inserted: sql<boolean>`(xmax = 0)` });
      const row = rows[0];
      if (row === undefined) throw new Error('movie_plays upsert returned no row');
      const { inserted, ...play } = row;
      if (!input.ended) return { play, created: inserted, closed: false };
      const [ended] = await tx
        .update(moviePlays)
        .set({ endedAt: input.at, updatedAt: input.at })
        .where(eq(moviePlays.id, play.id))
        .returning();
      return { play: ended ?? play, created: inserted, closed: true };
    });
  }

  /** The stream play `streamState` reads for a film (season and episode null) or an episode, from any host: lastPlay's order. */
  async lastStreamPlay(titleIdValue: string, season: number | null, episode: number | null): Promise<MoviePlayRow | null> {
    const rows = await this.db
      .select()
      .from(moviePlays)
      .where(
        and(
          eq(moviePlays.source, 'stream'),
          eq(moviePlays.titleId, titleIdValue),
          sql`${moviePlays.season} is not distinct from ${season}::integer`,
          sql`${moviePlays.episode} is not distinct from ${episode}::integer`,
        ),
      )
      .orderBy(sql`(${moviePlays.positionS} is not null) desc`, desc(moviePlays.startedAt), desc(moviePlays.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Writes one resolve's outcome on its (title, season, episode, host) row. Verified: provider,
   * manifest kind, best height, English subtitle, `verified_at`, and `stale_at`/`failure` cleared.
   * Stale: `stale_at` and `failure` set, the last verified columns kept (a first failure makes a
   * stale-only row). Returns the row before and after, so the caller can tell whether the Stream
   * grid changed.
   */
  async recordStreamSource(input: StreamSourceOutcome): Promise<{ before: MovieStreamSourceRow | null; after: MovieStreamSourceRow }> {
    const key = and(
      eq(movieStreamSources.titleId, input.titleId),
      eq(movieStreamSources.season, input.season),
      eq(movieStreamSources.episode, input.episode),
      eq(movieStreamSources.host, input.host),
    );
    const values =
      input.outcome === 'verified'
        ? {
            provider: input.provider,
            manifestKind: input.manifestKind,
            bestHeight: input.bestHeight,
            enSubtitle: input.enSubtitle,
            verifiedAt: input.at,
            staleAt: null,
            failure: null,
            updatedAt: input.at,
          }
        : { staleAt: input.at, failure: input.failure, updatedAt: input.at };
    return this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(movieStreamSources).where(key).limit(1).for('update');
      const [after] = await tx
        .insert(movieStreamSources)
        .values({ titleId: input.titleId, season: input.season, episode: input.episode, host: input.host, ...values })
        .onConflictDoUpdate({
          target: [movieStreamSources.titleId, movieStreamSources.season, movieStreamSources.episode, movieStreamSources.host],
          set: values,
        })
        .returning();
      if (after === undefined) throw new Error('movie_stream_sources upsert returned no row');
      return { before: before ?? null, after };
    });
  }

  /** Titles with a fresh source on `host` (`freshCondition`), by id. */
  async freshStreamTitleIds(host: string, since: Date): Promise<string[]> {
    const res = await this.db.execute<{ title_id: string }>(
      sql`select distinct s.title_id from movie_stream_sources s where ${freshCondition(host, since)} order by s.title_id`,
    );
    return res.rows.map((r) => r.title_id);
  }

  /** One title's source rows on `host`, the film's or each episode's, in episode order (phase 9's stream block). */
  async streamSourcesOfTitle(titleIdValue: string, host: string): Promise<MovieStreamSourceRow[]> {
    return this.db
      .select()
      .from(movieStreamSources)
      .where(and(eq(movieStreamSources.titleId, titleIdValue), eq(movieStreamSources.host, host)))
      .orderBy(asc(movieStreamSources.season), asc(movieStreamSources.episode));
  }

  // ---------- history (R3.8) ----------

  /**
   * Titles that became finished in [from, to) — by the title's or a file's manual flag, a done
   * signal, or a play that reached FINISHED_RATIO — optionally only those with a company or a
   * person (in one role) whose name contains the given text. Newest finish first. One query.
   */
  async titlesFinishedBetween(filter: FinishedFilter): Promise<FinishedTitle[]> {
    const conditions: SQL[] = [sql`fin.at >= ${filter.from}`, sql`fin.at < ${filter.to}`];
    if (filter.company !== undefined) {
      conditions.push(sql`exists (
        select 1 from movie_title_companies tc join movie_companies c on c.id = tc.company_id
        where tc.title_id = t.id and c.name ilike ${likePattern(filter.company)})`);
    }
    if (filter.person !== undefined) {
      const role = filter.role !== undefined ? sql` and cr.role = ${filter.role}` : sql``;
      conditions.push(sql`exists (
        select 1 from movie_credits cr join movie_people pe on pe.id = cr.person_id
        where cr.title_id = t.id and pe.name ilike ${likePattern(filter.person)}${role})`);
    }
    const res = await this.db.execute<{ id: string; kind: TitleKind; title: string; year: number | null; finished_at: Date | string }>(sql`
      with fin as (${finishEventsSql()})
      select t.id, t.kind, t.title, t.year, max(fin.at) as finished_at
      from fin join movie_titles t on t.id = fin.title_id
      where ${sql.join(conditions, sql` and `)}
      group by t.id
      order by finished_at desc, t.id`);
    return res.rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, year: r.year, finishedAt: new Date(r.finished_at) }));
  }
}
