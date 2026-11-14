> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/movies-library/PLAN.md` phase 1. Source: `.workflows/plan/movies-library/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Foundation: schema, repo, state, config, seams

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R3 — the three-layer data model (title, file, play) that outlives deleted files, with studios and people as real rows
**Criteria:** R3.4, R3.8
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/movies`, `src/db`, `src/config.ts`, `src/http`

---

## Goal

After this phase the database has the eight `movie_*` tables (migration `0017_movies`), and
`MoviesRepo` is the single writer that round-trips TMDB metadata (companies, credits, episodes),
files and play events. `fileState` derives each file's watch state (finished, in progress,
unwatched, dropped, removed unwatched, seen), and `titlesFinishedBetween` answers "titles of a
company or person I finished in a date range" with one query. `Config.movies` parses every
movie env var, `AppDeps.movies` exists (always `null` until phase 3), and both movie routers are
mounted empty, so later phases fill their own files without touching shared wiring.

## Interface Contract

**Deletes:** none
**Renames:** `parseClaudeBin(raw)` (private, `src/config.ts:258`) -> `parseBin(raw, fallback)` (private; the one caller passes `DEFAULT_CLAUDE_BIN`)
**Creates:**
- Tables (migration `drizzle/0017_movies.sql`, objects in `src/db/schema.ts`): `movie_titles` (`movieTitles`), `movie_companies` (`movieCompanies`), `movie_title_companies` (`movieTitleCompanies`), `movie_people` (`moviePeople`), `movie_credits` (`movieCredits`), `movie_episodes` (`movieEpisodes`), `movie_files` (`movieFiles`), `movie_plays` (`moviePlays`). Exactly the columns of the index's Shared contract, plus `movie_title_companies_company_idx` and these CHECKs: `movie_titles_kind_check`, `movie_titles_id_check` (`id = kind || '-' || tmdb_id`), `movie_titles_tmdb_id_check`, `movie_titles_rating_check`, `movie_credits_role_check`, `movie_files_status_check`, `movie_files_source_check`, `movie_files_match_check` (matched <=> title set and reason null), `movie_plays_source_check`. `movie_files.title_id` references titles with ON DELETE NO ACTION (a title with files cannot be deleted).
- `src/db/schema.ts`: `MovieParsedName`, `MOVIE_TITLE_KINDS`/`MovieTitleKind`, `MOVIE_FILE_STATUSES`/`MovieFileStatus`, `MOVIE_FILE_REASONS`/`MovieFileReason`, `MOVIE_FILE_SOURCES`/`MovieFileSource`, `MOVIE_PLAY_SOURCES`/`MoviePlaySource`, `MOVIE_CREDIT_ROLES`/`MovieCreditRole`, row types `MovieTitleRow`, `MovieCompanyRow`, `MoviePersonRow`, `MovieCreditRow`, `MovieEpisodeRow`, `MovieFileRow`, `MoviePlayRow`
- `src/movies/types.ts`: `TitleKind`, `FileStatus`, `FileReason`, `FileSource`, `PlaySource`, `CreditRole`, `ParsedNameRecord`, `WATCH_STATES`, `WatchState`, `CompanyMeta`, `CreditMeta`, `EpisodeMeta`, `TitleMetadata`, `FileClassification`, `NewMovieFile`, `NewPlay`, `PlayReading`, `RecentsObservation`, `TitleUserPatch`, `FinishedFilter`, `FinishedTitle`, `FilePlay`, `FileStateInput`, `PlayStateInput`, `titleId(kind, tmdbId)`, `parseTitleId(id)`, `classifyReason(reason)`; re-exports `MovieTitleRow`, `MovieFileRow`, `MoviePlayRow`
- `src/movies/state.ts`: `FINISHED_RATIO = 0.9`, `playDuration(file, play)`, `reachedEnd(file, play)`, `fileState(file, lastPlay)`, `titleState(kind, fileStates, watched = false)`, `resumePosition(file, lastPlay)`
- `src/movies/repo.ts`: `class MoviesRepo` with `upsertTitle`, `upsertFile`, `markSeen`, `markDeleted`, `moveFile`, `setDone`, `assignFile`, `setUnmatched`, `setTitleUser`, `setFileWatched`, `startPlay`, `updatePlay`, `endPlay`, `recordObservation`, `closeOpenPlays`, `fileById`, `fileByPath`, `findTrackedFile`, `filesForHost`, `titleById`, `loadTitleMetadata`, `lastPlay`, `latestPlay`, `titlesFinishedBetween`; exported helper `likePattern`
- `src/movies/service.ts`: `interface MoviesService { host; repo; start(); close() }` (forward declaration; phase 3 replaces the file)
- `src/config.ts`: `MoviesConfig`, `TmdbConfig`, `VlcConfig`, `DEFAULT_MOVIES_CONFIG`, `parseMovies(env)`, `Config.movies`, constants `DEFAULT_MOVIES_SCAN_MS`, `DEFAULT_MOVIES_MIN_SECONDS`, `DEFAULT_MOVIES_DONE_DIRS`, `DEFAULT_TMDB_API_BASE`, `DEFAULT_TMDB_IMAGE_BASE`, `DEFAULT_FFPROBE_BIN`, `DEFAULT_VLC_BIN`, `DEFAULT_VLC_HTTP_PORT`, `DEFAULT_VLC_POLL_MS`, `DEFAULT_CURL_EXE`, `DEFAULT_MOVIES_FALLBACK_MODEL`
- `src/deps.ts`: `AppDeps.movies: MoviesService | null`
- `src/http/moviesApi.ts`: `moviesApiRoutes(deps: AppDeps): Hono` (empty)
- `src/http/moviesPlayApi.ts`: `moviesPlayRoutes(deps: AppDeps): Hono` (empty)
**Signature changes:** `MoviesConfig.fallbackModel` is `string | null` (`NOTESD_MOVIES_FALLBACK_MODEL=off` -> null, no Haiku fallback). `titleState(kind, fileStates)` from the index gains an optional third parameter `watched = false` (the title's manual flag); callers that pass two arguments are unaffected.
**Requires (from earlier phases):** none
**Leaves alone (owned by others):** `src/movies/parse.ts`, `tmdb.ts`, `match.ts`, `fallback.ts` (Phase 2); `src/movies/scan.ts`, `sync.ts`, the body of `service.ts`, `src/background.ts`, the `deps.movies` construction in `src/daemon.ts` (Phase 3); `src/movies/read.ts`, `reviewNote.ts`, the body of `src/http/moviesApi.ts` (Phase 4); `src/movies/vlc/*`, `player.ts`, `continue.ts`, the body of `src/http/moviesPlayApi.ts`, `src/http/reveal.ts` (Phase 5); `web/*` (Phase 6); `src/mcp/*`, `src/chat/*`, `mcpToolDeps` in `src/http/app.ts`, `claude/skills/n` (Phase 7); `CLAUDE.md`, README tour/API/MCP tables, `.claude/skills/verify-notesd/*` (Phase 8)

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | imports `real`, `smallint` (`:2-22`); header note (`:45`); movie constants, `MovieParsedName` and eight tables after `adversaryReviews` (`:950`); row types at the end (`:981`) |
| `drizzle/0017_movies.sql` | create (generated) | the eight tables, FKs, indexes, CHECKs |
| `drizzle/meta/0017_snapshot.json`, `drizzle/meta/_journal.json` | create / modify (generated) | snapshot and journal entry `idx 17, tag 0017_movies` |
| `src/movies/types.ts` | create | shared vocabulary, `TitleMetadata`, id helpers, classification union |
| `src/movies/state.ts` | create | `FINISHED_RATIO`, `fileState`, `titleState`, `resumePosition` |
| `src/movies/repo.ts` | create | `MoviesRepo`, the only writer of `movie_*` |
| `src/movies/service.ts` | create | forward `MoviesService` interface |
| `src/config.ts` | modify | movie config types/defaults (`:144`), `Config.movies` (`:164`), `parseBin` (`:258`), `parseMovies` (`:344`), `loadConfig` doc + return (`:346-387`) |
| `src/deps.ts` | modify | `movies: MoviesService \| null` (`:23`) |
| `src/daemon.ts` | modify | `movies: null` in the `AppDeps` literal (`:105`) |
| `src/http/moviesApi.ts` | create | empty `moviesApiRoutes` |
| `src/http/moviesPlayApi.ts` | create | empty `moviesPlayRoutes` |
| `src/http/app.ts` | modify | import + mount both routers after `adversaryApiRoutes` (`:11-25`, `:84-95`, `:121`) |
| `README.md` | modify | 16 env rows after `NOTES_CLAUDE_RETENTION_DAYS` (`:1123`) |
| `tests/integration/setup.ts` | modify | `truncateAll` also empties the movie tables (`:54`) |
| `tests/unit/config.test.ts` | modify | import, `applies defaults` (`:48-49`), new `movies config` describe |
| `tests/unit/movies/state.test.ts` | create | R3.4 state table, `titleState`, `resumePosition` |
| `tests/unit/movies/types.test.ts` | create | `titleId`, `parseTitleId`, `classifyReason` |
| `tests/integration/movies.schema.int.test.ts` | create | tables, indexes, CHECKs, FK behavior |
| `tests/integration/movies.repo.int.test.ts` | create | repo round trips, lifecycle, plays, R3.8 query, TS/SQL agreement |
| `tests/integration/imageHarness.ts` (`:8,:47,:53`), `related.int.test.ts` (`:9,:44,:46`), `images.int.test.ts` (`:9,:139,:145,:170,:176`), `mcp.tools.int.test.ts` (`:9,:21,:24`), `connectors/mcp.int.test.ts` (`:8,:18,:21`), `sessions.ingest.int.test.ts` (`:8,:192,:202`), `sessions.replyEmbeddings.int.test.ts` (`:8,:268,:278`), `helpers/api-harness.ts` (`:10,:53,:60`), `embeddings.worker.int.test.ts` (`:9,:103,:330`), `daemon.int.test.ts` (`:5,:20`), `tests/unit/embeddings/embedBackfillCli.test.ts` (`:3,:39`) | modify | `movies: DEFAULT_MOVIES_CONFIG` in every hand-built `Config`, `movies: null` in every hand-built `AppDeps` (Step 11's script) |

## Implementation Steps

### Step 0: Install dependencies in the worktree
**File:** `/home/miftah/.worktrees/mcp-notes/movies-library` (no `node_modules` yet)
**Change:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm ci`
**Impact:** none on the tree; needed for every later command.

### Step 1: Movie tables in the Drizzle schema
**File:** `src/db/schema.ts:2-22` (imports), `:45` (header), `:950` (after `adversaryReviews`), `:981` (end)
**Change:** add `real` and `smallint` to the `drizzle-orm/pg-core` import list, keeping it alphabetical, so its tail reads `pgTable, primaryKey, real, smallint, text, timestamp, uniqueIndex, vector,`. Append to the header comment, before the line `* Change a table here, then \`npm run db:generate\`...`:

```ts
 * Migration 0017 (movies library) adds the eight `movie_*` tables: titles (TMDB data, never
 * deleted because files are gone), their companies, people, credits and episodes, the files seen
 * on each host (soft-deleted) and the play events (never deleted). src/movies/repo.ts
 * (`MoviesRepo`) is their only writer.
```

Insert after the closing `)` of `adversaryReviews` (line 950) and before `export type NoteRow`:

```ts
/** The closed sets of the movie tables. The CHECK constraints below enforce the same lists. */
export const MOVIE_TITLE_KINDS = ['movie', 'tv'] as const
export type MovieTitleKind = (typeof MOVIE_TITLE_KINDS)[number]
export const MOVIE_FILE_STATUSES = ['matched', 'unmatched', 'pending'] as const
export type MovieFileStatus = (typeof MOVIE_FILE_STATUSES)[number]
/** Why a file is not (yet) in the library. Not a CHECK: a new reason needs no migration. */
export const MOVIE_FILE_REASONS = ['too_short', 'no_match', 'low_confidence', 'tmdb_error', 'no_tmdb_credentials', 'probe_failed'] as const
export type MovieFileReason = (typeof MOVIE_FILE_REASONS)[number]
export const MOVIE_FILE_SOURCES = ['scan', 'vlc_recents'] as const
export type MovieFileSource = (typeof MOVIE_FILE_SOURCES)[number]
export const MOVIE_PLAY_SOURCES = ['live', 'vlc_recents'] as const
export type MoviePlaySource = (typeof MOVIE_PLAY_SOURCES)[number]
export const MOVIE_CREDIT_ROLES = ['cast', 'director', 'writer', 'producer', 'creator'] as const
export type MovieCreditRole = (typeof MOVIE_CREDIT_ROLES)[number]

/** `movie_files.parsed`: what the filename parser read from a file's path (src/movies/parse.ts). */
export interface MovieParsedName {
  title: string
  year: number | null
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  kindHint: 'movie' | 'tv' | null
}

/**
 * One row per TMDB movie or series (migration 0017). `id` is `movie-<tmdb id>` or `tv-<tmdb id>`
 * (a CHECK ties it to `kind` and `tmdb_id`, so no other id can be stored). TMDB columns are
 * rewritten on every metadata fetch; `watched_at` (manual flag), `rating` and `review_note_id`
 * are the owner's and survive a refetch. A title is never deleted because its files are gone:
 * `movie_files.title_id` has no cascade, so deleting a title with files fails.
 */
export const movieTitles = pgTable(
  'movie_titles',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<MovieTitleKind>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    originalTitle: text('original_title').notNull(),
    year: integer('year'),
    releaseDate: date('release_date', { mode: 'string' }),
    overview: text('overview').notNull().default(''),
    /** TMDB image path (`/abc.jpg`); the URL is built from TMDB_IMAGE_BASE at read time. */
    posterPath: text('poster_path'),
    backdropPath: text('backdrop_path'),
    runtimeMin: integer('runtime_min'),
    genres: jsonb('genres').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    seasonCount: integer('season_count'),
    episodeCount: integer('episode_count'),
    /** The owner's manual "watched" flag for the whole title. */
    watchedAt: timestamp('watched_at', { withTimezone: true, mode: 'date' }),
    /** 0..5 stars. */
    rating: smallint('rating'),
    /** The review, a normal note (written through NotesService). Purging the note clears the link. */
    reviewNoteId: text('review_note_id').references(() => notes.id, { onDelete: 'set null' }),
    metadataFetchedAt: timestamp('metadata_fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** Full text (`simple`) over title, original title and synopsis. Never selected by the app. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("original_title", '') || ' ' || coalesce("overview", ''))`,
    ),
  },
  (t) => [
    uniqueIndex('movie_titles_kind_tmdb_uniq').on(t.kind, t.tmdbId),
    index('movie_titles_search_gin').using('gin', t.searchTsv),
    check('movie_titles_kind_check', sql`${t.kind} in ('movie', 'tv')`),
    check('movie_titles_tmdb_id_check', sql`${t.tmdbId} > 0`),
    check('movie_titles_id_check', sql`${t.id} = ${t.kind} || '-' || ${t.tmdbId}::text`),
    check('movie_titles_rating_check', sql`${t.rating} between 0 and 5`),
  ],
)

/** A production company, keyed by its TMDB company id. Shared by every title it made. */
export const movieCompanies = pgTable('movie_companies', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  logoPath: text('logo_path'),
  originCountry: text('origin_country'),
})

/** Which companies made a title, in TMDB's order (`ord`). Replaced on every metadata fetch. */
export const movieTitleCompanies = pgTable(
  'movie_title_companies',
  {
    titleId: text('title_id')
      .notNull()
      .references(() => movieTitles.id, { onDelete: 'cascade' }),
    companyId: integer('company_id')
      .notNull()
      .references(() => movieCompanies.id),
    ord: integer('ord').notNull(),
  },
  (t) => [primaryKey({ columns: [t.titleId, t.companyId] }), index('movie_title_companies_company_idx').on(t.companyId)],
)

/** A person (cast or crew), keyed by their TMDB person id. */
export const moviePeople = pgTable('movie_people', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  profilePath: text('profile_path'),
})

/**
 * One credit of a person on a title: `role` cast (with `character`), director, writer, producer
 * or creator (with TMDB's `job`). A person may hold several credits on one title. `ord` is the
 * credit's position in the title's credit list. Replaced on every metadata fetch.
 */
export const movieCredits = pgTable(
  'movie_credits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    titleId: text('title_id')
      .notNull()
      .references(() => movieTitles.id, { onDelete: 'cascade' }),
    personId: integer('person_id')
      .notNull()
      .references(() => moviePeople.id),
    role: text('role').$type<MovieCreditRole>().notNull(),
    character: text('character'),
    job: text('job'),
    ord: integer('ord').notNull(),
  },
  (t) => [
    index('movie_credits_person_idx').on(t.personId),
    index('movie_credits_title_role_idx').on(t.titleId, t.role, t.ord),
    check('movie_credits_role_check', sql`${t.role} in ('cast', 'director', 'writer', 'producer', 'creator')`),
  ],
)

/** A series' episodes per season, from TMDB. Replaced on every metadata fetch. */
export const movieEpisodes = pgTable(
  'movie_episodes',
  {
    titleId: text('title_id')
      .notNull()
      .references(() => movieTitles.id, { onDelete: 'cascade' }),
    season: integer('season').notNull(),
    episode: integer('episode').notNull(),
    name: text('name').notNull(),
    airDate: date('air_date', { mode: 'string' }),
    runtimeMin: integer('runtime_min'),
    overview: text('overview'),
    stillPath: text('still_path'),
  },
  (t) => [primaryKey({ columns: [t.titleId, t.season, t.episode] })],
)

/**
 * One video file on one host (migration 0017). `title_id` is null while the file is unmatched or
 * pending (a CHECK keeps `status`, `title_id` and `reason` consistent). Files are soft-deleted
 * (`deleted_at`); a live (host, path) is unique, deleted rows may repeat it. `done_at` is the
 * "moved into a Done folder" signal, `watched_at` the owner's manual per-file flag; either makes
 * the file finished (src/movies/state.ts). `source` vlc_recents marks a file known only from
 * VLC's recent list, created already deleted.
 */
export const movieFiles = pgTable(
  'movie_files',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    titleId: text('title_id').references(() => movieTitles.id),
    host: text('host').notNull(),
    /** Absolute Linux path on `host`. */
    path: text('path').notNull(),
    /** Basename of `path`; with `size` it recognizes a moved file. */
    name: text('name').notNull(),
    size: bigint('size', { mode: 'number' }),
    mtime: timestamp('mtime', { withTimezone: true, mode: 'date' }),
    durationS: real('duration_s'),
    season: integer('season'),
    episode: integer('episode'),
    absoluteEpisode: integer('absolute_episode'),
    status: text('status').$type<MovieFileStatus>().notNull(),
    reason: text('reason').$type<MovieFileReason>(),
    parsed: jsonb('parsed').$type<MovieParsedName>(),
    source: text('source').$type<MovieFileSource>().notNull().default('scan'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    movedAt: timestamp('moved_at', { withTimezone: true, mode: 'date' }),
    doneAt: timestamp('done_at', { withTimezone: true, mode: 'date' }),
    watchedAt: timestamp('watched_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('movie_files_live_path_uniq').on(t.host, t.path).where(sql`${t.deletedAt} is null`),
    index('movie_files_title_idx').on(t.titleId),
    index('movie_files_name_size_idx').on(t.host, t.name, t.size),
    check('movie_files_status_check', sql`${t.status} in ('matched', 'unmatched', 'pending')`),
    check('movie_files_source_check', sql`${t.source} in ('scan', 'vlc_recents')`),
    check(
      'movie_files_match_check',
      sql`(${t.status} = 'matched' and ${t.titleId} is not null and ${t.reason} is null) or (${t.status} <> 'matched' and ${t.titleId} is null)`,
    ),
  ],
)

/**
 * One play event of a file (migration 0017): a VLC that notesd started (`live`, updated while it
 * plays, closed with `ended_at`), or one entry of VLC's recent list (`vlc_recents`, one row per
 * distinct position seen). `position_s` null means "opened, position unknown". Never deleted.
 */
export const moviePlays = pgTable(
  'movie_plays',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    fileId: bigint('file_id', { mode: 'number' })
      .notNull()
      .references(() => movieFiles.id, { onDelete: 'cascade' }),
    host: text('host').notNull(),
    source: text('source').$type<MoviePlaySource>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    startPositionS: real('start_position_s'),
    positionS: real('position_s'),
    durationS: real('duration_s'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('movie_plays_file_started_idx').on(t.fileId, t.startedAt.desc()),
    index('movie_plays_started_idx').on(t.startedAt.desc()),
    check('movie_plays_source_check', sql`${t.source} in ('live', 'vlc_recents')`),
  ],
)
```

Append at the end of the file (after `export type NewAdversaryReviewRow ...`, line 981):

```ts
export type MovieTitleRow = typeof movieTitles.$inferSelect
export type MovieCompanyRow = typeof movieCompanies.$inferSelect
export type MoviePersonRow = typeof moviePeople.$inferSelect
export type MovieCreditRow = typeof movieCredits.$inferSelect
export type MovieEpisodeRow = typeof movieEpisodes.$inferSelect
export type MovieFileRow = typeof movieFiles.$inferSelect
export type MoviePlayRow = typeof moviePlays.$inferSelect
```

**Impact:** schema only; nothing reads it yet. `npm run typecheck` must pass.

### Step 2: Generate migration 0017
**File:** `drizzle/0017_movies.sql`, `drizzle/meta/0017_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** the worktree has no `.env.local`, and `drizzle.config.ts` needs a direct (non-pooler) URL even to generate (generate never connects). Run:

```sh
cd /home/miftah/.worktrees/mcp-notes/movies-library
DATABASE_URL_UNPOOLED=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit generate --name movies
```

Never hand-edit the generated SQL unless it lacks something below. It must contain (order may differ):
- `CREATE TABLE` for all eight tables; `"search_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("original_title", '') || ' ' || coalesce("overview", ''))) STORED`
- the CHECKs `movie_titles_kind_check`, `movie_titles_tmdb_id_check`, `movie_titles_id_check`, `movie_titles_rating_check`, `movie_credits_role_check`, `movie_files_status_check`, `movie_files_source_check`, `movie_files_match_check`, `movie_plays_source_check`
- PKs `movie_title_companies_title_id_company_id_pk`, `movie_episodes_title_id_season_episode_pk`
- FKs: `movie_titles.review_note_id -> notes.id ON DELETE set null`; `movie_title_companies.title_id`, `movie_credits.title_id`, `movie_episodes.title_id -> movie_titles.id ON DELETE cascade`; `movie_title_companies.company_id -> movie_companies.id`, `movie_credits.person_id -> movie_people.id`, `movie_files.title_id -> movie_titles.id` all `ON DELETE no action`; `movie_plays.file_id -> movie_files.id ON DELETE cascade`
- indexes `movie_titles_kind_tmdb_uniq` (unique), `movie_titles_search_gin` (gin), `movie_title_companies_company_idx`, `movie_credits_person_idx`, `movie_credits_title_role_idx`, `movie_files_live_path_uniq` (unique, `WHERE "movie_files"."deleted_at" is null`), `movie_files_title_idx`, `movie_files_name_size_idx`, `movie_plays_file_started_idx` (`"file_id","started_at" DESC`), `movie_plays_started_idx` (`"started_at" DESC`)
- journal entry `{ "idx": 17, "version": "7", "tag": "0017_movies", "breakpoints": true }`

No `ALTER` of any existing table appears in it (the migration is purely additive). If one does, the schema step changed an existing table by mistake: fix Step 1, delete the three generated artifacts, regenerate.
**Impact:** `npm run test:int` applies it through `tests/integration/globalSetup.ts`; `verify.sh up` applies it to each throwaway DB.

### Step 3: Shared movie vocabulary
**File:** `src/movies/types.ts` (new)
**Code:**
```ts
import type {
  MovieCreditRole,
  MovieFileReason,
  MovieFileRow,
  MovieFileSource,
  MovieFileStatus,
  MovieParsedName,
  MoviePlayRow,
  MoviePlaySource,
  MovieTitleKind,
} from '../db/schema.js';

/**
 * The movies subsystem's shared vocabulary (MOVIES_LIBRARY_PLAN phase 1). The closed sets live
 * next to their tables in src/db/schema.ts, whose CHECK constraints enforce them; this module
 * names them for src/movies and holds the shapes that cross phases (`TitleMetadata` is what a
 * TMDB match stores, phase 2 builds it, `MoviesRepo.upsertTitle` writes it).
 */

export type { MovieFileRow, MoviePlayRow, MovieTitleRow } from '../db/schema.js';

export type TitleKind = MovieTitleKind;
export type FileStatus = MovieFileStatus;
export type FileReason = MovieFileReason;
export type FileSource = MovieFileSource;
export type PlaySource = MoviePlaySource;
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

/** A play to open (`MoviesRepo.startPlay`). */
export interface NewPlay {
  fileId: number;
  host: string;
  source: PlaySource;
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
```
**Impact:** new module; typecheck.

### Step 4: Watch-state derivation (R3.4)
**File:** `src/movies/state.ts` (new)
**Code:**
```ts
import type { FileStateInput, PlayStateInput, TitleKind, WatchState } from './types.js';

/**
 * Watch state, derived at read time from a file row and its last play (MOVIES_LIBRARY_PLAN
 * R3.4). "Last play" is `MoviesRepo.lastPlay`: the newest play whose position is known, else the
 * newest play (whose position is then unknown). The same "reached the end" rule is written in SQL
 * in src/movies/repo.ts (`finishEventsSql`); tests/integration/movies.repo.int.test.ts proves the
 * two agree.
 */

/** A play at or past this share of the duration finishes the file. */
export const FINISHED_RATIO = 0.9;

/** The duration a position is measured against: the player's own reading, else ffprobe's. */
export function playDuration(file: FileStateInput, play: PlayStateInput): number | null {
  const duration = play.durationS ?? file.durationS;
  return duration !== null && duration > 0 ? duration : null;
}

/** True when the play's position is at least FINISHED_RATIO of the duration. */
export function reachedEnd(file: FileStateInput, play: PlayStateInput): boolean {
  if (play.positionS === null) return false;
  const duration = playDuration(file, play);
  return duration !== null && play.positionS >= FINISHED_RATIO * duration;
}

/**
 * - finished: manual flag, done signal, or the last play reached FINISHED_RATIO
 * - present file: in_progress when it was played (a position above 0, or opened with the
 *   position unknown), else unwatched
 * - deleted file: dropped when played partway, seen when only opened with the position unknown,
 *   removed_unwatched when never played (or left at 0)
 */
export function fileState(file: FileStateInput, lastPlay: PlayStateInput | null): WatchState {
  if (file.watchedAt !== null || file.doneAt !== null) return 'finished';
  if (lastPlay !== null && reachedEnd(file, lastPlay)) return 'finished';
  const positionUnknown = lastPlay !== null && lastPlay.positionS === null;
  const played = positionUnknown || (lastPlay !== null && lastPlay.positionS !== null && lastPlay.positionS > 0);
  if (file.deletedAt !== null) {
    if (!played) return 'removed_unwatched';
    return positionUnknown ? 'seen' : 'dropped';
  }
  return played ? 'in_progress' : 'unwatched';
}

/** Where Play/Resume starts: the last known position, or 0 when there is none or the file is finished. */
export function resumePosition(file: FileStateInput, lastPlay: PlayStateInput | null): number {
  if (lastPlay === null || lastPlay.positionS === null || lastPlay.positionS <= 0) return 0;
  if (fileState(file, lastPlay) === 'finished') return 0;
  return lastPlay.positionS;
}

/** For a movie with several files, the most-watched state of any of them wins. */
const MOVIE_PRECEDENCE: readonly WatchState[] = ['finished', 'in_progress', 'dropped', 'seen', 'unwatched', 'removed_unwatched'];

/**
 * A title's state from its files' states. `watched` is the title's own manual flag.
 * Movie: the first state of MOVIE_PRECEDENCE any file has. Series: finished when every file is;
 * in_progress when something was watched and a present file is still unfinished; unwatched or
 * removed_unwatched when nothing was watched; otherwise (watched, nothing present left to
 * watch) dropped when a file was dropped or deleted unwatched, else seen.
 */
export function titleState(kind: TitleKind, fileStates: readonly WatchState[], watched = false): WatchState {
  if (watched) return 'finished';
  if (fileStates.length === 0) return 'unwatched';
  if (kind === 'movie') return MOVIE_PRECEDENCE.find((s) => fileStates.includes(s)) ?? 'unwatched';
  if (fileStates.every((s) => s === 'finished')) return 'finished';
  const started = fileStates.some((s) => s === 'finished' || s === 'in_progress' || s === 'dropped' || s === 'seen');
  const presentUnfinished = fileStates.some((s) => s === 'in_progress' || s === 'unwatched');
  if (!started) return presentUnfinished ? 'unwatched' : 'removed_unwatched';
  if (presentUnfinished) return 'in_progress';
  if (fileStates.some((s) => s === 'dropped' || s === 'removed_unwatched')) return 'dropped';
  return 'seen';
}
```
**Impact:** pure; covered by Step 13.

### Step 5: `MoviesRepo`, the only writer
**File:** `src/movies/repo.ts` (new)
**Code:**
```ts
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import {
  movieCompanies,
  movieCredits,
  movieEpisodes,
  movieFiles,
  moviePeople,
  moviePlays,
  movieTitleCompanies,
  movieTitles,
  type MovieFileRow,
  type MoviePlayRow,
  type MovieTitleRow,
} from '../db/schema.js';
import { FINISHED_RATIO } from './state.js';
import {
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
  type TitleKind,
  type TitleMetadata,
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
 * flag, a file's manual flag, a file's done signal, and every play that reached FINISHED_RATIO of
 * its duration (the play's reading, else the file's; state.ts `reachedEnd` is the same rule). A
 * play still open counts at its last update. Comparisons run in double precision, as in JS.
 */
function finishEventsSql(): SQL {
  return sql`
    select t.id as title_id, t.watched_at as at from movie_titles t where t.watched_at is not null
    union all
    select f.title_id, f.watched_at from movie_files f where f.title_id is not null and f.watched_at is not null
    union all
    select f.title_id, f.done_at from movie_files f where f.title_id is not null and f.done_at is not null
    union all
    select f.title_id, coalesce(p.ended_at, p.updated_at)
    from movie_plays p join movie_files f on f.id = p.file_id
    where f.title_id is not null
      and p.position_s is not null
      and coalesce(p.duration_s, f.duration_s) > 0
      and p.position_s::double precision >= ${FINISHED_RATIO}::double precision * coalesce(p.duration_s, f.duration_s)::double precision`;
}

/**
 * The only writer of the `movie_*` tables (MOVIES_LIBRARY_PLAN invariant 2): the sync pass,
 * routes, MCP tools and the player all write through it. It also holds the reads those callers
 * share. Titles are never deleted, files only soft-deleted, plays never deleted.
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
        year: meta.year,
        releaseDate: meta.releaseDate,
        overview: meta.overview,
        posterPath: meta.posterPath,
        backdropPath: meta.backdropPath,
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

  /** Sets the owner's state on a title. Returns the updated row, or null for an unknown id. */
  async setTitleUser(id: string, patch: TitleUserPatch, now: Date = new Date()): Promise<MovieTitleRow | null> {
    const set: PgUpdateSetSource<typeof movieTitles> = { updatedAt: now };
    if (patch.watched !== undefined) set.watchedAt = patch.watched ? sql`coalesce(${movieTitles.watchedAt}, ${now})` : null;
    if (patch.rating !== undefined) set.rating = patch.rating;
    if (patch.reviewNoteId !== undefined) set.reviewNoteId = patch.reviewNoteId;
    const rows = await this.db.update(movieTitles).set(set).where(eq(movieTitles.id, id)).returning();
    return rows[0] ?? null;
  }

  async titleById(id: string): Promise<MovieTitleRow | null> {
    const rows = await this.db.select().from(movieTitles).where(eq(movieTitles.id, id)).limit(1);
    return rows[0] ?? null;
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
```
**Impact:** new module, no caller yet (phases 3, 4, 5, 7 call it). Typecheck.

### Step 6: Forward `MoviesService` type
**File:** `src/movies/service.ts` (new)
**Code:**
```ts
import type { MoviesRepo } from './repo.js';

/**
 * Forward declaration (MOVIES_LIBRARY_PLAN phase 1) so `AppDeps.movies` has a type before the
 * service exists. Phase 3 replaces this file with the real `class MoviesService` (which must keep
 * at least these members) and `buildMoviesService`; until then `deps.movies` is always null.
 */
export interface MoviesService {
  /** os.hostname() of this daemon: the host whose files it scans and plays. */
  readonly host: string;
  readonly repo: MoviesRepo;
  start(): void;
  close(): Promise<void>;
}
```
**Impact:** type only.

### Step 7: Movie config
**File:** `src/config.ts`
**Change 7a** — insert after `DEFAULT_ADVERSARY_CONFIG` (after line 144):

```ts
export const DEFAULT_MOVIES_SCAN_MS = 120_000
export const DEFAULT_MOVIES_MIN_SECONDS = 900
export const DEFAULT_MOVIES_DONE_DIRS: readonly string[] = ['Done']
export const DEFAULT_TMDB_API_BASE = 'https://api.themoviedb.org/3'
export const DEFAULT_TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p'
export const DEFAULT_FFPROBE_BIN = 'ffprobe'
export const DEFAULT_VLC_BIN = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe'
export const DEFAULT_VLC_HTTP_PORT = 47318
export const DEFAULT_VLC_POLL_MS = 5_000
export const DEFAULT_CURL_EXE = '/mnt/c/Windows/System32/curl.exe'
export const DEFAULT_MOVIES_FALLBACK_MODEL = 'haiku'

/** TMDB credentials and hosts (src/movies/tmdb.ts). Secrets are never logged. */
export interface TmdbConfig {
  /** `TMDB_API_READ_ACCESS_TOKEN` (v4 bearer), trimmed; null when unset or blank. Preferred. */
  token: string | null
  /** `TMDB_API_KEY` (v3 `api_key=`), trimmed; null when unset or blank. Used when there is no token. */
  apiKey: string | null
  /** `TMDB_API_BASE`, no trailing slash. Tests point it at a fixture server. */
  apiBase: string
  /** `TMDB_IMAGE_BASE`, no trailing slash. Poster URLs are `<imageBase>/<size><poster_path>`. */
  imageBase: string
}

/** The Windows VLC notesd launches and reads (src/movies/vlc/*). */
export interface VlcConfig {
  /** `NOTESD_VLC_BIN`. A bare name is a PATH lookup; a path is ~-expanded and made absolute. */
  bin: string
  /** `NOTESD_VLC_INI`: VLC's `vlc-qt-interface.ini`, absolute. Null turns the recents backfill off. */
  ini: string | null
  /** `NOTESD_VLC_HTTP_PORT`, 1-65535: the port of the HTTP interface of a VLC notesd starts. */
  httpPort: number
  /** `NOTESD_VLC_POLL_MS`: how often a playing VLC is read. */
  pollMs: number
  /** `NOTESD_CURL_EXE`: the Windows curl that reaches VLC's loopback-only HTTP interface. */
  curlExe: string
}

/** The movies library (src/movies/*). */
export interface MoviesConfig {
  /** `NOTESD_MOVIES`, default on. `off` scans nothing and spawns nothing. */
  enabled: boolean
  /** `NOTESD_MOVIES_ROOTS`, `:`-separated absolute directories, scanned recursively. Empty: nothing is scanned. */
  roots: string[]
  /** `NOTESD_MOVIES_DONE_DIRS`, `:`-separated folder names (not paths), matched case-insensitively below a root. */
  doneDirs: string[]
  /** `NOTESD_MOVIES_SCAN_MS`: pause between sync passes. */
  scanMs: number
  /** `NOTESD_MOVIES_MIN_SECONDS`: shorter videos stay out of the library (unmatched, too_short). */
  minSeconds: number
  tmdb: TmdbConfig
  /** `NOTESD_FFPROBE_BIN`. A bare name is a PATH lookup; a path is ~-expanded and made absolute. */
  ffprobeBin: string
  vlc: VlcConfig
  /**
   * `NOTESD_MOVIES_FALLBACK_MODEL`: Agent SDK alias or model id that names a file TMDB could not match.
   * `off` gives null: no Haiku fallback (phase 3 then builds none; verify.sh pins it off).
   */
  fallbackModel: string | null
}

/** Movies off, no roots, no TMDB credentials, no VLC ini. Tests build `Config` literals with it. */
export const DEFAULT_MOVIES_CONFIG: MoviesConfig = {
  enabled: false,
  roots: [],
  doneDirs: [...DEFAULT_MOVIES_DONE_DIRS],
  scanMs: DEFAULT_MOVIES_SCAN_MS,
  minSeconds: DEFAULT_MOVIES_MIN_SECONDS,
  tmdb: { token: null, apiKey: null, apiBase: DEFAULT_TMDB_API_BASE, imageBase: DEFAULT_TMDB_IMAGE_BASE },
  ffprobeBin: DEFAULT_FFPROBE_BIN,
  vlc: {
    bin: DEFAULT_VLC_BIN,
    ini: null,
    httpPort: DEFAULT_VLC_HTTP_PORT,
    pollMs: DEFAULT_VLC_POLL_MS,
    curlExe: DEFAULT_CURL_EXE,
  },
  fallbackModel: DEFAULT_MOVIES_FALLBACK_MODEL,
}
```

**Change 7b** — in `interface Config` (after `dword: DwordConfig`, line 164) add:

```ts
  /** The movies library. `enabled: false` starts nothing (DEFAULT_MOVIES_CONFIG in tests). */
  movies: MoviesConfig
```

**Change 7c** — replace `parseClaudeBin` (lines 258-262) with a general helper, and update its one caller in `parseChat` (line 286) to `claudeBin: parseBin(env.NOTESD_CLAUDE_BIN, DEFAULT_CLAUDE_BIN),`:

```ts
function parseBin(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback
  // A bare command name stays a PATH lookup; anything with a slash is a path.
  return value.includes('/') ? path.resolve(expandHome(value)) : value
}
```

**Change 7d** — insert after `parseSessions` (after line 344):

```ts
function parseSecret(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  return value === '' ? null : value
}

function parseAbsolutePaths(name: string, raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(':')) {
    const value = part.trim()
    if (value === '') continue
    const expanded = expandHome(value)
    if (!path.isAbsolute(expanded)) throw new ConfigError(`${name} takes absolute paths separated by ":", got "${value}"`)
    const resolved = path.resolve(expanded)
    if (!out.includes(resolved)) out.push(resolved)
  }
  return out
}

function parseFolderNames(name: string, raw: string | undefined, fallback: readonly string[]): string[] {
  const names = (raw ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (names.length === 0) return [...fallback]
  for (const n of names) {
    if (n.includes('/') || n === '.' || n === '..') throw new ConfigError(`${name} takes folder names, not paths, got "${n}"`)
  }
  return names
}

function parseOptionalAbsolutePath(name: string, raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  if (value === '') return null
  const expanded = expandHome(value)
  if (!path.isAbsolute(expanded)) throw new ConfigError(`${name} must be an absolute path, got "${raw}"`)
  return path.resolve(expanded)
}

function parseHttpBase(name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() ?? ''
  if (value === '') return fallback
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must be an http(s) URL, got "${raw}"`)
  return value.replace(/\/+$/, '')
}

function parseTcpPort(name: string, raw: string | undefined, fallback: number): number {
  const port = parsePositiveInt(name, raw, fallback)
  if (port > 65535) throw new ConfigError(`${name} must be an integer 1-65535, got "${raw}"`)
  return port
}

export function parseMovies(env: Record<string, string | undefined>): MoviesConfig {
  return {
    enabled: parseSwitch('NOTESD_MOVIES', env.NOTESD_MOVIES),
    roots: parseAbsolutePaths('NOTESD_MOVIES_ROOTS', env.NOTESD_MOVIES_ROOTS),
    doneDirs: parseFolderNames('NOTESD_MOVIES_DONE_DIRS', env.NOTESD_MOVIES_DONE_DIRS, DEFAULT_MOVIES_DONE_DIRS),
    scanMs: parsePositiveInt('NOTESD_MOVIES_SCAN_MS', env.NOTESD_MOVIES_SCAN_MS, DEFAULT_MOVIES_SCAN_MS),
    minSeconds: parsePositiveInt('NOTESD_MOVIES_MIN_SECONDS', env.NOTESD_MOVIES_MIN_SECONDS, DEFAULT_MOVIES_MIN_SECONDS),
    tmdb: {
      token: parseSecret(env.TMDB_API_READ_ACCESS_TOKEN),
      apiKey: parseSecret(env.TMDB_API_KEY),
      apiBase: parseHttpBase('TMDB_API_BASE', env.TMDB_API_BASE, DEFAULT_TMDB_API_BASE),
      imageBase: parseHttpBase('TMDB_IMAGE_BASE', env.TMDB_IMAGE_BASE, DEFAULT_TMDB_IMAGE_BASE),
    },
    ffprobeBin: parseBin(env.NOTESD_FFPROBE_BIN, DEFAULT_FFPROBE_BIN),
    vlc: {
      bin: parseBin(env.NOTESD_VLC_BIN, DEFAULT_VLC_BIN),
      ini: parseOptionalAbsolutePath('NOTESD_VLC_INI', env.NOTESD_VLC_INI),
      httpPort: parseTcpPort('NOTESD_VLC_HTTP_PORT', env.NOTESD_VLC_HTTP_PORT, DEFAULT_VLC_HTTP_PORT),
      pollMs: parsePositiveInt('NOTESD_VLC_POLL_MS', env.NOTESD_VLC_POLL_MS, DEFAULT_VLC_POLL_MS),
      curlExe: parseBin(env.NOTESD_CURL_EXE, DEFAULT_CURL_EXE),
    },
    fallbackModel:
      env.NOTESD_MOVIES_FALLBACK_MODEL?.trim().toLowerCase() === 'off'
        ? null
        : parseModel('NOTESD_MOVIES_FALLBACK_MODEL', env.NOTESD_MOVIES_FALLBACK_MODEL, DEFAULT_MOVIES_FALLBACK_MODEL),
  }
}
```

**Change 7e** — in the `loadConfig` doc comment (lines 346-361), after the sentence ending `dword_schema/dword_sql are unaffected, since they need no user id).` insert:

```ts
 * Movies keys: NOTESD_MOVIES, NOTESD_MOVIES_ROOTS, NOTESD_MOVIES_DONE_DIRS, NOTESD_MOVIES_SCAN_MS,
 * NOTESD_MOVIES_MIN_SECONDS, TMDB_API_READ_ACCESS_TOKEN, TMDB_API_KEY, TMDB_API_BASE, TMDB_IMAGE_BASE,
 * NOTESD_FFPROBE_BIN, NOTESD_VLC_BIN, NOTESD_VLC_INI, NOTESD_VLC_HTTP_PORT, NOTESD_VLC_POLL_MS,
 * NOTESD_CURL_EXE, NOTESD_MOVIES_FALLBACK_MODEL (relative roots or ini, a path as a Done folder
 * name, a non-http TMDB base or a port above 65535 throw ConfigError).
```

and in the returned object (line 386) add after `dword: parseDword(env),`:

```ts
    movies: parseMovies(env),
```
**Impact:** every hand-built `Config` literal now fails typecheck until Step 11.

### Step 8: `AppDeps.movies`
**File:** `src/deps.ts:1-9` and after line 23
**Change:** add `import type { MoviesService } from './movies/service.js';` (after the `ImageEmbedder` import, keeping alphabetical order: after `./embeddings/imageEmbedder.js`, before `./notes/events.js`), and after the `adversary` field:

```ts
  /**
   * The movies library: sync, matching and playback on this host (MOVIES_LIBRARY_PLAN phase 3
   * builds it). Null when NOTESD_MOVIES=off, and always null until phase 3 lands. Routes answer
   * 503 `movies_off` without it.
   */
  movies: MoviesService | null;
```

**File:** `src/daemon.ts:105`
**Change:** the literal becomes

```ts
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory, adversary, movies: null, sessionEvents };
```
**Impact:** every hand-built `AppDeps` literal fails typecheck until Step 11.

### Step 9: Empty movie routers, mounted once
**File:** `src/http/moviesApi.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/**
 * /api/movies* (MOVIES_LIBRARY_PLAN). Mounted empty by phase 1 so later phases fill this file and
 * never src/http/app.ts. Phase 4 adds: GET /api/movies, /api/movies/unmatched, /api/movies/status,
 * /api/movies/:id, /api/movies/search-tmdb; POST /api/movies/:id/user,
 * /api/movies/files/:fileId/watched, /api/movies/files/:fileId/assign, /api/movies/sync; the SSE
 * stream GET /api/movies/events. With `deps.movies === null` every route answers 503 `movies_off`.
 */
export function moviesApiRoutes(_deps: AppDeps): Hono {
  return new Hono();
}
```

**File:** `src/http/moviesPlayApi.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';

/**
 * Movie playback routes (MOVIES_LIBRARY_PLAN). Mounted empty by phase 1; phase 5 adds
 * POST /api/movies/files/:fileId/play, POST /api/movies/continue and GET /api/movies/player,
 * all same-origin only.
 */
export function moviesPlayRoutes(_deps: AppDeps): Hono {
  return new Hono();
}
```

**File:** `src/http/app.ts`
**Change:** add these imports right after `import { imageRoutes } from './images.js';` (line 17):

```ts
import { moviesApiRoutes } from './moviesApi.js';
import { moviesPlayRoutes } from './moviesPlayApi.js';
```

In the `createApp` doc comment (lines 84-95) replace `Adversarial read model, toggle and review-now), staticRoutes (P6, last: ...` with:

```ts
 * Adversarial read model, toggle and review-now), moviesApiRoutes and moviesPlayRoutes
 * (movies-library phases 4 and 5: library, user state, sync, playback), staticRoutes (P6, last: it
 * owns the SPA fallback; it reserves /api, so the order is for clarity).
```

and after `app.route('/', adversaryApiRoutes(deps, { seer: options.adversarySeer }));` (line 121):

```ts
  app.route('/', moviesApiRoutes(deps));
  app.route('/', moviesPlayRoutes(deps));
```
**Impact:** no behavior change: `/api/movies*` still falls through to `staticRoutes`, which answers 404 for `/api`.

### Step 10: README env rows
**File:** `README.md:1123` (after the `NOTES_CLAUDE_RETENTION_DAYS` row, before `## How it works`)
**Change:** insert:

```markdown
| `NOTESD_MOVIES` | on | `off` stops the movies library on this machine: no scan, no TMDB calls, no VLC. |
| `NOTESD_MOVIES_ROOTS` | — | `:`-separated absolute directories scanned recursively for video files (mkv, mp4, avi, m4v, webm). Unset: nothing is scanned. |
| `NOTESD_MOVIES_DONE_DIRS` | `Done` | `:`-separated folder names (not paths). A file moved into, or first found inside, such a folder below a root counts as finished. |
| `NOTESD_MOVIES_SCAN_MS` | `120000` | Pause between library sync passes. |
| `NOTESD_MOVIES_MIN_SECONDS` | `900` | Videos shorter than this stay out of the library (unmatched, `too_short`). |
| `TMDB_API_READ_ACCESS_TOKEN` | — | TMDB v4 read access token (Bearer), preferred. Without it and `TMDB_API_KEY`, files are recorded as unmatched (`no_tmdb_credentials`). |
| `TMDB_API_KEY` | — | TMDB v3 API key, used when there is no read access token. |
| `TMDB_API_BASE` | `https://api.themoviedb.org/3` | TMDB API host. Tests point it at a fixture server. |
| `TMDB_IMAGE_BASE` | `https://image.tmdb.org/t/p` | Poster host. Posters are linked, not stored, so both machines show them. |
| `NOTESD_FFPROBE_BIN` | `ffprobe` | The ffprobe that measures each video's duration. |
| `NOTESD_VLC_BIN` | `/mnt/c/Program Files/VideoLAN/VLC/vlc.exe` | The Windows VLC that Play starts. |
| `NOTESD_VLC_INI` | — | VLC's `vlc-qt-interface.ini` (e.g. `/mnt/c/Users/<you>/AppData/Roaming/vlc/vlc-qt-interface.ini`). Its recent list backfills plays of films opened outside notesd. Unset: no backfill. |
| `NOTESD_VLC_HTTP_PORT` | `47318` | Port of the HTTP interface of a VLC that notesd starts (bound to Windows loopback). |
| `NOTESD_VLC_POLL_MS` | `5000` | How often a playing VLC's position is recorded. |
| `NOTESD_CURL_EXE` | `/mnt/c/Windows/System32/curl.exe` | The Windows curl that reads VLC's HTTP interface from the Windows side (WSL's NAT network cannot reach Windows loopback). |
| `NOTESD_MOVIES_FALLBACK_MODEL` | `haiku` | Claude model alias that names a file TMDB could not match from its name. `off`: no fallback (such files stay unmatched). |
```
**Impact:** docs only.

### Step 11: Hand-built `Config` and `AppDeps` literals (the lever)
**Files:** the 11 test files in the Files table.
**Change:** run this script from the worktree root (it only touches lines that already name `DEFAULT_DWORD_CONFIG` or the `AppDeps` field `adversary: null`), then let `npm run typecheck` prove nothing was missed:

```sh
cd /home/miftah/.worktrees/mcp-notes/movies-library
FILES="tests/integration/imageHarness.ts tests/integration/related.int.test.ts tests/integration/images.int.test.ts \
  tests/integration/mcp.tools.int.test.ts tests/integration/connectors/mcp.int.test.ts \
  tests/integration/sessions.ingest.int.test.ts tests/integration/sessions.replyEmbeddings.int.test.ts \
  tests/integration/helpers/api-harness.ts tests/integration/embeddings.worker.int.test.ts \
  tests/integration/daemon.int.test.ts tests/unit/embeddings/embedBackfillCli.test.ts"
# imports: add DEFAULT_MOVIES_CONFIG next to DEFAULT_DWORD_CONFIG
sed -i -E '/^import .*DEFAULT_DWORD_CONFIG/ s/DEFAULT_DWORD_CONFIG,/DEFAULT_DWORD_CONFIG, DEFAULT_MOVIES_CONFIG,/' $FILES
# Config literals
sed -i -E 's/dword: DEFAULT_DWORD_CONFIG( ?)/dword: DEFAULT_DWORD_CONFIG, movies: DEFAULT_MOVIES_CONFIG\1/' $FILES
# AppDeps literals
sed -i -E 's/adversary: null( ?)([,}])/adversary: null, movies: null\1\2/' $FILES
grep -c "DEFAULT_MOVIES_CONFIG" $FILES
npm run typecheck
```

Expected `grep -c` counts: `imageHarness.ts` 2, `related.int.test.ts` 2, `images.int.test.ts` 3, `mcp.tools.int.test.ts` 2, `connectors/mcp.int.test.ts` 2, `sessions.ingest.int.test.ts` 2, `sessions.replyEmbeddings.int.test.ts` 2, `helpers/api-harness.ts` 2, `embeddings.worker.int.test.ts` 2, `daemon.int.test.ts` 2, `embedBackfillCli.test.ts` 2. Any typecheck error left names a literal the script missed: fix it by hand the same way (Config: `movies: DEFAULT_MOVIES_CONFIG`; AppDeps: `movies: null`). `tests/unit/config.test.ts` is NOT in the list (Step 12 edits it by hand). Literals built with `as unknown as AppDeps` or by spreading `h.deps` need nothing.
**Impact:** the tree typechecks again.

### Step 12: Config tests
**File:** `tests/unit/config.test.ts`
**Change:** add `DEFAULT_MOVIES_CONFIG` to the import list (lines 6-16, after `DEFAULT_EMBEDDINGS_CONFIG`). In `applies defaults` (line 49), after `dword: DEFAULT_DWORD_CONFIG,` add:

```ts
      movies: { ...DEFAULT_MOVIES_CONFIG, enabled: true },
```

Append at the end of the file:

```ts
describe('movies config', () => {
  const movies = (env: Record<string, string>) => loadConfig({ env: { DATABASE_URL: URL_A, ...env }, envFile: false }).movies

  it('defaults to on with no roots, Done as the done folder, no TMDB credentials and no VLC ini', () => {
    expect(movies({})).toEqual({
      enabled: true,
      roots: [],
      doneDirs: ['Done'],
      scanMs: 120_000,
      minSeconds: 900,
      tmdb: { token: null, apiKey: null, apiBase: 'https://api.themoviedb.org/3', imageBase: 'https://image.tmdb.org/t/p' },
      ffprobeBin: 'ffprobe',
      vlc: {
        bin: '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe',
        ini: null,
        httpPort: 47318,
        pollMs: 5000,
        curlExe: '/mnt/c/Windows/System32/curl.exe',
      },
      fallbackModel: 'haiku',
    })
  })

  it('reads every key', () => {
    expect(
      movies({
        NOTESD_MOVIES: 'off',
        NOTESD_MOVIES_ROOTS: '/mnt/c/Users/x/Videos/:/mnt/c/Users/x/Downloads/Telegram Desktop:~/films:/mnt/c/Users/x/Videos',
        NOTESD_MOVIES_DONE_DIRS: 'Done: Watched ',
        NOTESD_MOVIES_SCAN_MS: '60000',
        NOTESD_MOVIES_MIN_SECONDS: '600',
        TMDB_API_READ_ACCESS_TOKEN: ' tok ',
        TMDB_API_KEY: 'key',
        TMDB_API_BASE: 'http://127.0.0.1:9999/3/',
        TMDB_IMAGE_BASE: 'http://127.0.0.1:9999/img',
        NOTESD_FFPROBE_BIN: '/usr/bin/ffprobe',
        NOTESD_VLC_BIN: '/tmp/fake vlc/vlc.exe',
        NOTESD_VLC_INI: '~/vlc/vlc-qt-interface.ini',
        NOTESD_VLC_HTTP_PORT: '48000',
        NOTESD_VLC_POLL_MS: '250',
        NOTESD_CURL_EXE: 'curl.exe',
        NOTESD_MOVIES_FALLBACK_MODEL: 'claude-haiku-4-5',
      }),
    ).toEqual({
      enabled: false,
      roots: ['/mnt/c/Users/x/Videos', '/mnt/c/Users/x/Downloads/Telegram Desktop', path.join(homedir(), 'films')],
      doneDirs: ['Done', 'Watched'],
      scanMs: 60_000,
      minSeconds: 600,
      tmdb: { token: 'tok', apiKey: 'key', apiBase: 'http://127.0.0.1:9999/3', imageBase: 'http://127.0.0.1:9999/img' },
      ffprobeBin: '/usr/bin/ffprobe',
      vlc: {
        bin: '/tmp/fake vlc/vlc.exe',
        ini: path.join(homedir(), 'vlc', 'vlc-qt-interface.ini'),
        httpPort: 48000,
        pollMs: 250,
        curlExe: 'curl.exe',
      },
      fallbackModel: 'claude-haiku-4-5',
    })
  })

  it('turns the Haiku fallback off with NOTESD_MOVIES_FALLBACK_MODEL=off', () => {
    expect(movies({ NOTESD_MOVIES_FALLBACK_MODEL: 'off' }).fallbackModel).toBeNull()
    expect(movies({ NOTESD_MOVIES_FALLBACK_MODEL: 'OFF' }).fallbackModel).toBeNull()
  })

  it('treats blank TMDB credentials as unset', () => {
    expect(movies({ TMDB_API_READ_ACCESS_TOKEN: '  ', TMDB_API_KEY: '' }).tmdb).toMatchObject({ token: null, apiKey: null })
  })

  it.each([
    ['NOTESD_MOVIES', 'maybe'],
    ['NOTESD_MOVIES_ROOTS', 'relative/films'],
    ['NOTESD_MOVIES_DONE_DIRS', 'Videos/Done'],
    ['NOTESD_MOVIES_SCAN_MS', '0'],
    ['NOTESD_MOVIES_MIN_SECONDS', '-1'],
    ['TMDB_API_BASE', 'ftp://tmdb.example'],
    ['TMDB_IMAGE_BASE', 'not a url'],
    ['NOTESD_VLC_INI', 'vlc-qt-interface.ini'],
    ['NOTESD_VLC_HTTP_PORT', '70000'],
    ['NOTESD_VLC_POLL_MS', '1.5'],
    ['NOTESD_MOVIES_FALLBACK_MODEL', 'ha iku'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => movies({ [key]: value })).toThrow(ConfigError)
  })

  it('keeps DEFAULT_MOVIES_CONFIG off, with no roots, no credentials and no VLC ini, so hand-built test configs never scan', () => {
    expect(DEFAULT_MOVIES_CONFIG).toMatchObject({ enabled: false, roots: [], tmdb: { token: null, apiKey: null }, vlc: { ini: null } })
  })
})
```
**Impact:** `npx vitest run tests/unit/config.test.ts` passes.

### Step 13: State and id unit tests (R3.4)
**File:** `tests/unit/movies/state.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest'

import { FINISHED_RATIO, fileState, reachedEnd, resumePosition, titleState } from '../../../src/movies/state.js'
import { WATCH_STATES, type FileStateInput, type PlayStateInput, type WatchState } from '../../../src/movies/types.js'

const DAY = new Date('2026-11-01T00:00:00.000Z')

function file(over: Partial<FileStateInput> = {}): FileStateInput {
  return { deletedAt: null, doneAt: null, watchedAt: null, durationS: 6000, ...over }
}

function play(positionS: number | null, durationS: number | null = null): PlayStateInput {
  return { positionS, durationS }
}

const CASES: Array<[string, FileStateInput, PlayStateInput | null, WatchState]> = [
  ['present, never played', file(), null, 'unwatched'],
  ['present, opened and left at 0', file(), play(0), 'unwatched'],
  ['present, partway', file(), play(1200), 'in_progress'],
  ['present, opened with the position unknown', file(), play(null), 'in_progress'],
  ['present, at exactly 90% of the file duration', file(), play(5400), 'finished'],
  ['present, just under 90%', file(), play(5399), 'in_progress'],
  ['the player duration wins over the file duration', file({ durationS: 6000 }), play(4500, 5000), 'finished'],
  ['no duration anywhere: a position never finishes the file', file({ durationS: null }), play(99_999), 'in_progress'],
  ['manual watched flag', file({ watchedAt: DAY }), null, 'finished'],
  ['done signal', file({ doneAt: DAY }), play(10), 'finished'],
  ['deleted at >= 90%', file({ deletedAt: DAY }), play(5900), 'finished'],
  ['deleted, manually flagged', file({ deletedAt: DAY, watchedAt: DAY }), play(100), 'finished'],
  ['deleted after a done signal', file({ deletedAt: DAY, doneAt: DAY }), null, 'finished'],
  ['deleted partway', file({ deletedAt: DAY }), play(3000), 'dropped'],
  ['deleted, never played', file({ deletedAt: DAY }), null, 'removed_unwatched'],
  ['deleted at 0%', file({ deletedAt: DAY }), play(0), 'removed_unwatched'],
  ['deleted, only opened with the position unknown', file({ deletedAt: DAY }), play(null), 'seen'],
]

describe('fileState (R3.4)', () => {
  it.each(CASES)('%s', (_name, f, p, expected) => {
    expect(fileState(f, p)).toBe(expected)
  })

  it('the table reaches every watch state', () => {
    expect(new Set(CASES.map((c) => c[3]))).toEqual(new Set(WATCH_STATES))
  })

  it('finishes at 90%', () => {
    expect(FINISHED_RATIO).toBe(0.9)
    expect(reachedEnd(file({ durationS: 1000 }), play(900))).toBe(true)
    expect(reachedEnd(file({ durationS: 1000 }), play(899.9))).toBe(false)
    expect(reachedEnd(file({ durationS: 0 }), play(10))).toBe(false)
  })
})

describe('resumePosition', () => {
  it('resumes a partway file at its last position', () => {
    expect(resumePosition(file(), play(1234.5))).toBe(1234.5)
  })

  it('starts from 0 when there is no position or the file is finished', () => {
    expect(resumePosition(file(), null)).toBe(0)
    expect(resumePosition(file(), play(null))).toBe(0)
    expect(resumePosition(file(), play(0))).toBe(0)
    expect(resumePosition(file(), play(5800))).toBe(0)
    expect(resumePosition(file({ watchedAt: DAY }), play(1200))).toBe(0)
  })
})

describe('titleState', () => {
  it('a movie takes the most-watched state of its files', () => {
    expect(titleState('movie', ['removed_unwatched', 'in_progress'])).toBe('in_progress')
    expect(titleState('movie', ['dropped', 'finished'])).toBe('finished')
    expect(titleState('movie', ['seen'])).toBe('seen')
    expect(titleState('movie', [])).toBe('unwatched')
  })

  it.each<[WatchState[], WatchState]>([
    [['finished', 'finished'], 'finished'],
    [['finished', 'unwatched'], 'in_progress'],
    [['dropped', 'unwatched'], 'in_progress'],
    [['in_progress', 'removed_unwatched'], 'in_progress'],
    [['unwatched', 'unwatched'], 'unwatched'],
    [['unwatched', 'removed_unwatched'], 'unwatched'],
    [['removed_unwatched'], 'removed_unwatched'],
    [['finished', 'removed_unwatched'], 'dropped'],
    [['finished', 'dropped'], 'dropped'],
    [['finished', 'seen'], 'seen'],
  ])('a series with episodes %j is %s', (states, expected) => {
    expect(titleState('tv', states)).toBe(expected)
  })

  it("the title's own watched flag finishes it", () => {
    expect(titleState('tv', ['unwatched'], true)).toBe('finished')
    expect(titleState('movie', [], true)).toBe('finished')
  })
})
```

**File:** `tests/unit/movies/types.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest'

import { classifyReason, parseTitleId, titleId } from '../../../src/movies/types.js'

describe('title ids', () => {
  it('builds movie-<tmdb id> and tv-<tmdb id>', () => {
    expect(titleId('movie', 467905)).toBe('movie-467905')
    expect(titleId('tv', 247718)).toBe('tv-247718')
  })

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])('refuses TMDB id %s', (id) => {
    expect(() => titleId('movie', id)).toThrow(RangeError)
  })

  it('parses only ids titleId could have made', () => {
    expect(parseTitleId('tv-247718')).toEqual({ kind: 'tv', tmdbId: 247718 })
    for (const bad of ['movie-0', 'movie-01', 'film-1', 'tv-', 'TV-1', 'movie-1x', 'movie-2147483648']) {
      expect(parseTitleId(bad)).toBeNull()
    }
  })
})

describe('classifyReason', () => {
  it('leaves a TMDB outage pending and every other reason unmatched', () => {
    expect(classifyReason('tmdb_error')).toEqual({ status: 'pending', reason: 'tmdb_error' })
    expect(classifyReason('too_short')).toEqual({ status: 'unmatched', reason: 'too_short' })
    expect(classifyReason('no_tmdb_credentials')).toEqual({ status: 'unmatched', reason: 'no_tmdb_credentials' })
  })
})
```
**Impact:** `npm test` covers R3.4.

### Step 14: Integration test setup truncates the movie tables
**File:** `tests/integration/setup.ts:54`
**Change:** the truncate statement becomes

```ts
  await db.execute(sql`truncate table movie_plays, movie_files, movie_episodes, movie_credits, movie_people, movie_title_companies, movie_companies, movie_titles, adversary_reviews, note_session_links, cc_session_reply_embeddings, cc_session_replies, cc_session_prompt_images, cc_session_prompts, cc_subagent_transcripts, cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings, chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
```
**Impact:** every integration file starts with empty movie tables.

### Step 15: Migration integration test
**File:** `tests/integration/movies.schema.int.test.ts` (new)
**Code:**
```ts
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { movieFiles, movieTitles, notes } from '../../src/db/schema.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

/** The Postgres error code and constraint name behind a failed statement (drizzle wraps it in `cause`). */
async function pgFailure(statement: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await statement
  } catch (err) {
    let cur: unknown = err
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; constraint?: unknown; cause?: unknown }
      if (typeof e.code === 'string') return { code: e.code, constraint: typeof e.constraint === 'string' ? e.constraint : undefined }
      cur = e.cause
    }
    return {}
  }
  throw new Error('expected the statement to fail')
}

function title(id: string, kind: 'movie' | 'tv', tmdbId: number) {
  return { id, kind, tmdbId, title: `Title ${tmdbId}`, originalTitle: `Title ${tmdbId}`, overview: 'A killing in the family.' }
}

function fileRow(path: string, over: Partial<typeof movieFiles.$inferInsert> = {}): typeof movieFiles.$inferInsert {
  return { host: 'host-a', path, name: path.split('/').pop() ?? path, status: 'unmatched', reason: 'no_match', ...over }
}

describe('migration 0017 (movies)', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates the movie tables and every index the plan set relies on', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename like 'movie_%' order by indexname`,
    )
    expect(res.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining([
        'movie_titles_pkey',
        'movie_titles_kind_tmdb_uniq',
        'movie_titles_search_gin',
        'movie_companies_pkey',
        'movie_title_companies_title_id_company_id_pk',
        'movie_title_companies_company_idx',
        'movie_people_pkey',
        'movie_credits_pkey',
        'movie_credits_person_idx',
        'movie_credits_title_role_idx',
        'movie_episodes_title_id_season_episode_pk',
        'movie_files_pkey',
        'movie_files_live_path_uniq',
        'movie_files_title_idx',
        'movie_files_name_size_idx',
        'movie_plays_pkey',
        'movie_plays_file_started_idx',
        'movie_plays_started_idx',
      ]),
    )
  })

  it('accepts only an id made from kind and TMDB id', async () => {
    await db.insert(movieTitles).values(title('movie-467905', 'movie', 467905))
    expect(await pgFailure(db.insert(movieTitles).values(title('movie-1', 'tv', 1)))).toEqual({
      code: '23514',
      constraint: 'movie_titles_id_check',
    })
    expect(await pgFailure(db.insert(movieTitles).values(title('show-2', 'tv', 2)))).toMatchObject({ code: '23514' })
  })

  it('keeps a rating within 0..5', async () => {
    await db.insert(movieTitles).values({ ...title('movie-1', 'movie', 1), rating: 5 })
    expect(await pgFailure(db.update(movieTitles).set({ rating: 6 }).where(eq(movieTitles.id, 'movie-1')))).toEqual({
      code: '23514',
      constraint: 'movie_titles_rating_check',
    })
  })

  it('ties a file status to its title and reason', async () => {
    await db.insert(movieTitles).values(title('movie-1', 'movie', 1))
    await db.insert(movieFiles).values(fileRow('/lib/ok.mkv', { status: 'matched', titleId: 'movie-1', reason: null }))
    const matchedWithoutTitle = await pgFailure(db.insert(movieFiles).values(fileRow('/lib/a.mkv', { status: 'matched', reason: null })))
    const unmatchedWithTitle = await pgFailure(db.insert(movieFiles).values(fileRow('/lib/b.mkv', { titleId: 'movie-1' })))
    const matchedWithReason = await pgFailure(
      db.insert(movieFiles).values(fileRow('/lib/c.mkv', { status: 'matched', titleId: 'movie-1', reason: 'no_match' })),
    )
    for (const failure of [matchedWithoutTitle, unmatchedWithTitle, matchedWithReason]) {
      expect(failure).toEqual({ code: '23514', constraint: 'movie_files_match_check' })
    }
  })

  it('allows one live row per host and path and any number of deleted ones', async () => {
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv', { deletedAt: new Date('2026-01-01T00:00:00Z') }))
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv', { deletedAt: new Date('2026-02-01T00:00:00Z') }))
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv'))
    await db.insert(movieFiles).values(fileRow('/lib/a.mkv', { host: 'host-b' }))
    expect(await pgFailure(db.insert(movieFiles).values(fileRow('/lib/a.mkv')))).toEqual({
      code: '23505',
      constraint: 'movie_files_live_path_uniq',
    })
  })

  it('refuses to delete a title that still has files, deleted ones included', async () => {
    await db.insert(movieTitles).values(title('movie-1', 'movie', 1))
    await db
      .insert(movieFiles)
      .values(fileRow('/lib/a.mkv', { status: 'matched', titleId: 'movie-1', reason: null, deletedAt: new Date('2026-01-01T00:00:00Z') }))
    expect(await pgFailure(db.delete(movieTitles).where(eq(movieTitles.id, 'movie-1')))).toMatchObject({ code: '23503' })
  })

  it('clears the review link when its note is purged', async () => {
    await db.insert(notes).values({ id: 'R-V01', body: 'loved it #movie' })
    await db.insert(movieTitles).values({ ...title('movie-1', 'movie', 1), reviewNoteId: 'R-V01' })
    await db.delete(notes).where(eq(notes.id, 'R-V01'))
    const [row] = await db.select({ reviewNoteId: movieTitles.reviewNoteId }).from(movieTitles)
    expect(row?.reviewNoteId).toBeNull()
  })

  it('indexes title, original title and synopsis for full text', async () => {
    await db.insert(movieTitles).values({ ...title('movie-1', 'movie', 1), originalTitle: 'Ne Zha' })
    await db.insert(movieTitles).values(title('movie-2', 'movie', 2))
    const hit = await db.execute<{ id: string }>(sql`select id from movie_titles where search_tsv @@ plainto_tsquery('simple', 'zha') order by id`)
    expect(hit.rows.map((r) => r.id)).toEqual(['movie-1'])
    const synopsis = await db.execute<{ id: string }>(sql`select id from movie_titles where search_tsv @@ plainto_tsquery('simple', 'killing') order by id`)
    expect(synopsis.rows.map((r) => r.id)).toEqual(['movie-1', 'movie-2'])
  })
})
```
**Impact:** proves the migration and its structural guarantees.

### Step 16: Repo integration test (R3.4, R3.8)
**File:** `tests/integration/movies.repo.int.test.ts` (new)
**Code:**
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { notes } from '../../src/db/schema.js'
import { MoviesRepo } from '../../src/movies/repo.js'
import { fileState } from '../../src/movies/state.js'
import type { CompanyMeta, CreditMeta, CreditRole, FileClassification, NewMovieFile, TitleMetadata } from '../../src/movies/types.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const T0 = new Date('2026-01-01T00:00:00.000Z')

function day(n: number): Date {
  return new Date(T0.getTime() + n * 86_400_000)
}

const BLUMHOUSE: CompanyMeta = { id: 3172, name: 'Blumhouse Productions', logoPath: '/blumhouse.png', originCountry: 'US' }
const A24: CompanyMeta = { id: 41077, name: 'A24', logoPath: null, originCountry: 'US' }
const QUALLEY = { personId: 1392137, name: 'Margaret Qualley', profilePath: '/qualley.jpg' }
const DIRECTOR = { personId: 5655, name: 'John Patton Ford', profilePath: null }

function credit(person: { personId: number; name: string; profilePath: string | null }, role: CreditRole, character: string | null, job: string | null = null): CreditMeta {
  return { ...person, role, character, job }
}

function movie(tmdbId: number, over: Partial<TitleMetadata> = {}): TitleMetadata {
  return {
    kind: 'movie',
    tmdbId,
    title: `Film ${tmdbId}`,
    originalTitle: `Film ${tmdbId}`,
    year: 2026,
    releaseDate: '2026-02-20',
    overview: `Synopsis of film ${tmdbId}.`,
    posterPath: `/poster-${tmdbId}.jpg`,
    backdropPath: null,
    runtimeMin: 100,
    genres: ['Thriller'],
    seasonCount: null,
    episodeCount: null,
    companies: [],
    credits: [],
    episodes: [],
    ...over,
  }
}

function series(tmdbId: number, over: Partial<TitleMetadata> = {}): TitleMetadata {
  return movie(tmdbId, {
    kind: 'tv',
    title: `Series ${tmdbId}`,
    originalTitle: `Series ${tmdbId}`,
    runtimeMin: null,
    seasonCount: 1,
    episodeCount: 2,
    episodes: [
      { season: 1, episode: 1, name: 'Stick or Twist', airDate: '2025-03-30', runtimeMin: 56, overview: 'One.', stillPath: '/s1e1.jpg' },
      { season: 1, episode: 2, name: 'Hearts and Minds', airDate: '2025-04-06', runtimeMin: 52, overview: null, stillPath: null },
    ],
    ...over,
  })
}

function newFile(path: string, classification: FileClassification, over: Partial<NewMovieFile> = {}): NewMovieFile {
  return {
    host: HOST,
    path,
    name: path.split('/').pop() ?? path,
    size: 1_000_000,
    mtime: T0,
    durationS: 6000,
    season: null,
    episode: null,
    absoluteEpisode: null,
    parsed: null,
    source: 'scan',
    classification,
    seenAt: T0,
    ...over,
  }
}

describe('MoviesRepo', () => {
  let db: Db
  let repo: MoviesRepo

  beforeAll(() => {
    db = openTestDb()
    repo = new MoviesRepo(db)
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  async function addFile(titleId: string, path: string, over: Partial<NewMovieFile> = {}): Promise<number> {
    return (await repo.upsertFile(newFile(path, { status: 'matched', titleId }, over))).file.id
  }

  /** A file of `titleId` with one closed live play that ended at `positionS` on `at`. */
  async function playTo(titleId: string, path: string, positionS: number | null, at: Date): Promise<number> {
    const fileId = await addFile(titleId, path)
    const play = await repo.startPlay({ fileId, host: HOST, source: 'live', startedAt: at, startPositionS: null, durationS: 6000 })
    await repo.endPlay(play.id, { positionS }, at)
    return fileId
  }

  describe('titles', () => {
    it('round-trips a movie with companies and credits, and a series with episodes', async () => {
      const meta = movie(467905, {
        title: 'How to Make a Killing',
        companies: [BLUMHOUSE, A24],
        credits: [credit(QUALLEY, 'cast', 'Julia'), credit(DIRECTOR, 'director', null, 'Director'), credit(DIRECTOR, 'writer', null, 'Screenplay')],
      })
      const id = await repo.upsertTitle(meta)
      expect(id).toBe('movie-467905')
      expect(await repo.loadTitleMetadata(id)).toEqual(meta)

      const show = series(247718, { title: 'MobLand', companies: [BLUMHOUSE], credits: [credit(QUALLEY, 'cast', 'Bella')] })
      expect(await repo.loadTitleMetadata(await repo.upsertTitle(show))).toEqual(show)
      expect(await repo.loadTitleMetadata('movie-1')).toBeNull()
    })

    it('a refetch replaces companies, credits and episodes and keeps the owner state', async () => {
      const id = await repo.upsertTitle(series(5, { companies: [BLUMHOUSE], credits: [credit(QUALLEY, 'cast', 'Bella')] }))
      await repo.setTitleUser(id, { watched: true, rating: 4 }, day(3))
      const refetched = series(5, { title: 'Renamed', companies: [A24], credits: [], episodes: [] })
      await repo.upsertTitle(refetched, day(4))
      expect(await repo.loadTitleMetadata(id)).toEqual(refetched)
      expect(await repo.titleById(id)).toMatchObject({ title: 'Renamed', watchedAt: day(3), rating: 4, metadataFetchedAt: day(4) })
    })

    it('stores the watched flag, rating and review link on the title', async () => {
      await db.insert(notes).values({ id: 'R-V01', body: 'loved it #movie' })
      const id = await repo.upsertTitle(movie(1))
      expect(await repo.setTitleUser(id, { watched: true, rating: 5, reviewNoteId: 'R-V01' }, day(1))).toMatchObject({
        watchedAt: day(1),
        rating: 5,
        reviewNoteId: 'R-V01',
      })
      expect(await repo.setTitleUser(id, { watched: true }, day(9))).toMatchObject({ watchedAt: day(1) })
      expect(await repo.setTitleUser(id, { watched: false, rating: null })).toMatchObject({ watchedAt: null, rating: null, reviewNoteId: 'R-V01' })
      expect(await repo.setTitleUser('movie-404', { rating: 1 })).toBeNull()
    })
  })

  describe('files', () => {
    it('inserts a new path, refreshes the same live path, and starts a new row after a delete', async () => {
      const id = await repo.upsertTitle(movie(1))
      const first = await repo.upsertFile(newFile('/lib/a.mkv', { status: 'matched', titleId: id }))
      expect(first.created).toBe(true)

      const again = await repo.upsertFile(newFile('/lib/a.mkv', { status: 'unmatched', reason: 'no_match' }, { size: 2_000_000, durationS: null, seenAt: day(1) }))
      expect(again.created).toBe(false)
      expect(again.file).toMatchObject({ id: first.file.id, status: 'matched', titleId: id, size: 2_000_000, durationS: 6000, firstSeenAt: T0, lastSeenAt: day(1) })

      expect(await repo.markDeleted(first.file.id, day(2))).toBe(true)
      expect(await repo.markDeleted(first.file.id, day(3))).toBe(false)
      const reborn = await repo.upsertFile(newFile('/lib/a.mkv', { status: 'pending', reason: null }, { seenAt: day(4) }))
      expect(reborn.created).toBe(true)
      expect(reborn.file.id).not.toBe(first.file.id)
      expect((await repo.fileByPath(HOST, '/lib/a.mkv'))?.id).toBe(reborn.file.id)
      expect((await repo.filesForHost(HOST)).map((f) => f.id)).toEqual([reborn.file.id])
      expect((await repo.filesForHost(HOST, { includeDeleted: true })).map((f) => f.id).sort()).toEqual([first.file.id, reborn.file.id].sort())
      expect(await repo.filesForHost('host-b')).toEqual([])
    })

    it('records a file known only from VLC recents as already deleted', async () => {
      const id = await repo.upsertTitle(movie(1))
      const gone = await repo.upsertFile(newFile('/tg/gone.mkv', { status: 'matched', titleId: id }, { source: 'vlc_recents', deletedAt: day(1) }))
      expect(gone).toMatchObject({ created: true, file: { source: 'vlc_recents', deletedAt: day(1) } })
      expect((await repo.fileByPath(HOST, '/tg/gone.mkv'))?.id).toBe(gone.file.id)
    })

    it('a move into a Done folder is a done signal, and unwatching clears it', async () => {
      const id = await repo.upsertTitle(movie(1))
      const fileId = await addFile(id, '/tg/a.mkv')
      expect(await repo.markSeen([fileId], day(1))).toBe(1)
      const moved = await repo.moveFile(fileId, { path: '/videos/Done/a.mkv', name: 'a.mkv' }, day(5), { done: true })
      expect(moved).toMatchObject({ path: '/videos/Done/a.mkv', movedAt: day(5), doneAt: day(5), deletedAt: null })
      expect(fileState(moved!, await repo.lastPlay(fileId))).toBe('finished')
      expect(await repo.setDone(fileId, day(9))).toMatchObject({ doneAt: day(5) })
      const unwatched = await repo.setFileWatched(fileId, false)
      expect(unwatched).toMatchObject({ watchedAt: null, doneAt: null })
      expect(fileState(unwatched!, null)).toBe('unwatched')
    })

    it('moves a file between unmatched, pending and matched', async () => {
      const id = await repo.upsertTitle(series(7))
      const { file } = await repo.upsertFile(newFile('/lib/s01e02.mkv', { status: 'pending', reason: null }))
      expect(await repo.setUnmatched(file.id, 'tmdb_error')).toMatchObject({ status: 'pending', reason: 'tmdb_error', titleId: null })
      expect(await repo.setUnmatched(file.id, 'no_match')).toMatchObject({ status: 'unmatched', reason: 'no_match', titleId: null })
      expect(await repo.assignFile(file.id, id, { season: 1, episode: 2 })).toMatchObject({ status: 'matched', reason: null, titleId: id, season: 1, episode: 2 })
    })
  })

  describe('plays', () => {
    it('opens, updates and closes a live play, and dedupes VLC recents observations', async () => {
      const id = await repo.upsertTitle(movie(1))
      const fileId = await addFile(id, '/lib/a.mkv')
      const live = await repo.startPlay({ fileId, host: HOST, source: 'live', startedAt: day(1), startPositionS: 600, durationS: 6000 })
      expect(live).toMatchObject({ positionS: 600, startPositionS: 600, endedAt: null })
      expect(await repo.updatePlay(live.id, { positionS: 1200, durationS: 6000 }, day(1))).toBe(true)
      expect(await repo.endPlay(live.id, { positionS: 1500 }, day(1))).toMatchObject({ positionS: 1500, durationS: 6000, endedAt: day(1) })
      expect(await repo.updatePlay(live.id, { positionS: 9, durationS: 6000 }, day(2))).toBe(false)
      expect(await repo.endPlay(live.id, {}, day(2))).toBeNull()

      const unknown = await repo.recordObservation({ fileId, host: HOST, positionS: null, durationS: null, observedAt: day(3) })
      expect(unknown.created).toBe(true)
      expect((await repo.recordObservation({ fileId, host: HOST, positionS: null, durationS: null, observedAt: day(4) })).created).toBe(false)
      const later = await repo.recordObservation({ fileId, host: HOST, positionS: 2400, durationS: null, observedAt: day(5) })
      expect(later.created).toBe(true)
      expect((await repo.recordObservation({ fileId, host: HOST, positionS: 2400.2, durationS: null, observedAt: day(6) })).created).toBe(false)

      expect((await repo.lastPlay(fileId))?.id).toBe(later.play.id)
      expect((await repo.latestPlay())?.play.id).toBe(later.play.id)
      expect((await repo.latestPlay(HOST))?.file.id).toBe(fileId)
      expect(await repo.latestPlay('host-b')).toBeNull()
    })

    it('lastPlay prefers the newest play with a known position', async () => {
      const id = await repo.upsertTitle(movie(1))
      const fileId = await playTo(id, '/lib/a.mkv', 3000, day(1))
      await repo.recordObservation({ fileId, host: HOST, positionS: null, durationS: null, observedAt: day(2) })
      expect((await repo.lastPlay(fileId))?.positionS).toBe(3000)
      await repo.markDeleted(fileId, day(3))
      expect(fileState((await repo.fileById(fileId))!, await repo.lastPlay(fileId))).toBe('dropped')
    })
  })

  describe('titlesFinishedBetween (R3.8)', () => {
    it('lists the titles of a company or a person finished in a date range', async () => {
      const year = { from: T0, to: day(365) }
      const killing = await repo.upsertTitle(movie(1, { title: 'Finished Blumhouse film', companies: [BLUMHOUSE], credits: [credit(QUALLEY, 'cast', 'Julia')] }))
      const dropped = await repo.upsertTitle(movie(2, { title: 'Dropped Blumhouse film', companies: [BLUMHOUSE] }))
      const nextYear = await repo.upsertTitle(movie(3, { title: 'Blumhouse film finished next year', companies: [BLUMHOUSE] }))
      const a24 = await repo.upsertTitle(movie(4, { title: 'A24 film', companies: [A24], credits: [credit(QUALLEY, 'cast', 'Ruth')] }))
      const show = await repo.upsertTitle(series(5, { title: 'Blumhouse series', companies: [BLUMHOUSE] }))

      await playTo(killing, '/lib/1.mkv', 5700, day(40))
      await playTo(dropped, '/lib/2.mkv', 3000, day(50))
      await playTo(nextYear, '/lib/3.mkv', 6000, day(400))
      await repo.setDone(await addFile(a24, '/videos/Done/4.mkv'), day(60))
      await repo.setFileWatched(await addFile(show, '/lib/show/S01E01.mkv', { season: 1, episode: 1 }), true, day(70))

      const blumhouse = await repo.titlesFinishedBetween({ ...year, company: 'blumhouse' })
      expect(blumhouse.map((t) => [t.id, t.finishedAt.toISOString()])).toEqual([
        [show, day(70).toISOString()],
        [killing, day(40).toISOString()],
      ])
      expect(blumhouse[1]).toMatchObject({ kind: 'movie', title: 'Finished Blumhouse film', year: 2026 })
      expect((await repo.titlesFinishedBetween({ ...year, person: 'margaret qualley', role: 'cast' })).map((t) => t.id)).toEqual([a24, killing])
      expect(await repo.titlesFinishedBetween({ ...year, person: 'Qualley', role: 'director' })).toEqual([])
      expect((await repo.titlesFinishedBetween({ from: T0, to: day(500), company: 'Blumhouse' })).map((t) => t.id)).toEqual([nextYear, show, killing])
      expect(await repo.titlesFinishedBetween({ ...year, company: '%' })).toEqual([])
    })

    it('agrees with fileState on which files are finished (R3.4)', async () => {
      const cases: Array<{ name: string; position: number | null | 'none'; deleted?: boolean; done?: boolean; watched?: boolean }> = [
        { name: 'play-95', position: 5700 },
        { name: 'play-90', position: 5400 },
        { name: 'play-89', position: 5399 },
        { name: 'play-50', position: 3000 },
        { name: 'never', position: 'none' },
        { name: 'unknown', position: null },
        { name: 'zero', position: 0 },
        { name: 'deleted-95', position: 5700, deleted: true },
        { name: 'deleted-50', position: 3000, deleted: true },
        { name: 'deleted-never', position: 'none', deleted: true },
        { name: 'deleted-unknown', position: null, deleted: true },
        { name: 'done', position: 'none', done: true },
        { name: 'watched', position: 3000, watched: true },
      ]
      const finishedByState: string[] = []
      for (const [i, c] of cases.entries()) {
        const id = await repo.upsertTitle(movie(100 + i, { title: c.name }))
        const fileId = c.position === 'none' ? await addFile(id, `/lib/${c.name}.mkv`) : await playTo(id, `/lib/${c.name}.mkv`, c.position, day(10))
        if (c.done === true) await repo.setDone(fileId, day(10))
        if (c.watched === true) await repo.setFileWatched(fileId, true, day(10))
        if (c.deleted === true) await repo.markDeleted(fileId, day(11))
        if (fileState((await repo.fileById(fileId))!, await repo.lastPlay(fileId)) === 'finished') finishedByState.push(id)
      }
      const finishedBySql = (await repo.titlesFinishedBetween({ from: T0, to: day(365) })).map((t) => t.id)
      expect([...finishedBySql].sort()).toEqual([...finishedByState].sort())
      expect(finishedByState).toHaveLength(5)
    })
  })
})
```
**Impact:** proves R3.8 and the TS/SQL agreement behind R3.4 against real Postgres.

## Principles applied

- Make illegal states unrepresentable: `movie_titles_id_check` makes an invented title id unstorable (invariant 8); `FileClassification` is a union whose variants carry only the columns their status allows, mirrored by the `movie_files_match_check` CHECK; `movie_files.title_id` has no cascade, so "a title is never deleted because its files are gone" (invariant 3) is enforced by the database, not by convention.
- Encode lessons in structure: the "reached the end" rule exists twice (TS `fileState` for current state, SQL `finishEventsSql` for the date-range query). Both read `FINISHED_RATIO` and the same duration precedence, compare in double precision, and the repo integration test `agrees with fileState on which files are finished` fails if they drift.
- Boundary discipline: every movie env var is validated once in `parseMovies` (absolute roots and ini, folder names without `/`, http(s) TMDB bases, port <= 65535, model name), so phases 3 and 5 trust `MoviesConfig` without re-checking.
- Laziness protocol: `parseClaudeBin` is generalized to `parseBin(raw, fallback)` and reused for ffprobe, vlc.exe and curl.exe instead of three new parsers; `MoviesService` is a four-member interface, not a stub class; `reason` gets no CHECK (TS union only) so phase 3 can add a reason without a migration.
- Build the lever: the 11 hand-built `Config`/`AppDeps` literals are rewritten by one `sed` script with expected per-file counts, and `npm run typecheck` is the proof nothing was missed.
- Test behavior, not implementation: repo tests round-trip through public reads (`loadTitleMetadata`, `fileState` over `lastPlay`), and the schema tests assert observable constraint failures by Postgres code and constraint name.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm run typecheck`
**Tests:** `npm test` (unit, includes `tests/unit/config.test.ts`, `tests/unit/movies/*.test.ts`) and `npm run test:int` (whole integration suite; the new files are `tests/integration/movies.schema.int.test.ts`, `tests/integration/movies.repo.int.test.ts`)
**Proof:** the migration applied to a real throwaway daemon's database holds the data model, and one plain SQL query lists a company's finished titles in a date range; the state rules are proven by the unit table and by their agreement with the SQL rule on real Postgres.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree root)
- Feature-map entries: none (this phase adds no user-facing behavior; Phase 8 adds `features/movies.md`)
- Journeys:
  - **J1** · traces R3.4 — `cd /home/miftah/.worktrees/mcp-notes/movies-library && npx vitest run tests/unit/movies/state.test.ts tests/unit/movies/types.test.ts` → passes when vitest reports 0 failed and the `fileState (R3.4)` block shows all 17 named cases passing (finished by flag/done/90%, in_progress, unwatched, dropped, removed_unwatched, seen) plus `the table reaches every watch state`
  - **J2** · traces R3.8 — `RUN=$($V up | sed -n 's/^RUN=//p')`; then `$V exec $RUN "insert into movie_companies (id, name) values (3172, 'Blumhouse Productions'), (41077, 'A24'); insert into movie_titles (id, kind, tmdb_id, title, original_title, overview) values ('movie-1','movie',1,'Finished Blumhouse film','Finished Blumhouse film',''), ('movie-2','movie',2,'Dropped Blumhouse film','Dropped Blumhouse film',''), ('movie-3','movie',3,'A24 film','A24 film',''); insert into movie_title_companies (title_id, company_id, ord) values ('movie-1',3172,0), ('movie-2',3172,0), ('movie-3',41077,0); insert into movie_files (title_id, host, path, name, status, duration_s) values ('movie-1','h','/lib/1.mkv','1.mkv','matched',6000), ('movie-2','h','/lib/2.mkv','2.mkv','matched',6000), ('movie-3','h','/lib/3.mkv','3.mkv','matched',6000); insert into movie_plays (file_id, host, source, started_at, ended_at, position_s, duration_s) select id, 'h', 'live', '2026-03-01T20:00:00Z', '2026-03-01T22:00:00Z', case name when '2.mkv' then 3000 else 5700 end, 6000 from movie_files"`; then `$V sql $RUN "select distinct t.id, t.title from movie_titles t join movie_title_companies tc on tc.title_id = t.id join movie_companies c on c.id = tc.company_id join movie_files f on f.title_id = t.id join movie_plays p on p.file_id = f.id where c.name ilike '%blumhouse%' and p.position_s >= 0.9 * coalesce(p.duration_s, f.duration_s) and coalesce(p.ended_at, p.updated_at) >= '2026-01-01' and coalesce(p.ended_at, p.updated_at) < '2027-01-01' order by t.id"` → passes when the exec evidence shows no `ERROR` and the sql evidence lists exactly one row, `movie-1 | Finished Blumhouse film` (the dropped Blumhouse film and the A24 film are absent)
  - **J3** · traces R3.8, R3.4 — `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm run test:int -- tests/integration/movies.repo.int.test.ts tests/integration/movies.schema.int.test.ts` → passes when vitest reports 0 failed, including `lists the titles of a company or a person finished in a date range` and `agrees with fileState on which files are finished (R3.4)`
- Neighbor check: notes and daemon boot through the changed `AppDeps`/`createApp`, on the same run as J2: `$V api $RUN POST /api/notes '{"body":"movies neighbor check #verify"}'`, `$V api $RUN GET /api/notes`, `$V api $RUN GET /api/movies`, then `$V doctor $RUN` and `$V down $RUN` → passes when the POST answers 201 with an id, the GET lists that body, `/api/movies` answers 404 (empty router, falls through), and doctor reports the process alive; also `npm run test:int -- tests/integration/daemon.int.test.ts` passes
- Cost: none (no LLM, TMDB or VLC calls)
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass; migration `0017_movies` applies on a fresh throwaway database (`verify.sh up` succeeds); J1-J3 pass.

## Handoffs

- **Phase 2 (R1, R2):** reconciled: `TitleMetadata`, `CompanyMeta`, `CreditMeta`, `EpisodeMeta`, `TitleKind`, `CreditRole` have their one definition here (Step 3). Phase 2 (same wave, cannot import this file) declares a field-for-field structural mirror under the same names in `tmdb.ts`; phase 3 replaces the mirror with a re-export from `./types.js`. Do not add fields to these types in this phase without the same change to phase 2's mirror. Phase 2's `ParsedName` (`MovieParsedName` plus `fileName`, `dirName`) is assignable to `MovieParsedName`. `CreditMeta.role` uses `creator` for a series' creators.
- **Phase 3 (R1, R2, R3):** replace `src/movies/service.ts` with the real `class MoviesService` (keeping `host`, `repo`, `start()`, `close()`), set `deps.movies` in `src/daemon.ts:105` (currently the literal `movies: null`), and use `MoviesRepo` for every write: `upsertFile` with a `FileClassification` (a new file whose match is not tried yet is `{ status: 'pending', reason: null }`), `markSeen`, `markDeleted`, `moveFile(..., { done })`, `setDone` (call it only on a move into, or first sighting inside, a Done folder: `setFileWatched(id, false)` clears `done_at` and must stay cleared), `assignFile`, `setUnmatched`. A move must check the target path is free: `movie_files_live_path_uniq` rejects two live rows at one (host, path).
- **Phase 4 (R1, R2, R3):** derive `state` with `fileState(file, await repo.lastPlay(id))` and `titleState(kind, states, title.watchedAt !== null)`; `POST /api/movies/files/:fileId/watched` with `false` should go through `setFileWatched`, which also clears the done signal. Validate `:id` with `parseTitleId`. `titlesFinishedBetween` serves a finished-date-range filter if `GET /api/movies` grows one.
- **Phase 5 (R3, R4, R6):** resume from `resumePosition(file, await repo.lastPlay(fileId))`; live plays through `startPlay`/`updatePlay`/`endPlay`; stale live plays at daemon start through `closeOpenPlays(host)`; recents entries through `findTrackedFile` and `recordObservation` (one row per distinct position, `positionS: null` for VLC time 0/-1). A recents entry whose file is gone (no tracked file): `upsertFile({ ..., source: 'vlc_recents', deletedAt: now, classification: { status: 'matched', titleId } })`. `moviesPlayRoutes(deps: AppDeps)` takes the full deps; add an optional second options parameter if tests need a player seam (mounting in `app.ts` passes only `deps`).
- **Phase 7 (R6):** `movies_list`'s company/person/finished-date-range filter can call `repo.titlesFinishedBetween` (name substrings, case-insensitive, LIKE wildcards literal).
- **Phase 8 (R7):** README env rows exist (Step 10); Phase 8 completes the tour, HTTP and MCP tables, CLAUDE.md and `features/movies.md`.
- **Decision for the reconciler:** the Decisions table defines `seen` only for deleted files. This plan makes a *present* file whose only plays have an unknown position `in_progress` (resume from 0), not `seen`, and makes a play left at exactly 0 count as never played (`unwatched` / `removed_unwatched`). Phases 4 to 7 should rely on `fileState` rather than restating the rule.
- `untraced`: none.

## Rollback

Revert this phase's commit. The migration is additive: on a database that already applied it, `drop table movie_plays, movie_files, movie_episodes, movie_credits, movie_title_companies, movie_people, movie_companies, movie_titles;` and remove the `0017_movies` row from `drizzle.__drizzle_migrations`, then delete `drizzle/0017_movies.sql`, `drizzle/meta/0017_snapshot.json` and the journal entry. No existing table or behavior changes, so nothing else needs undoing.
