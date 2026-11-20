> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-downloads-season-story/PLAN.md` phase 1. Source: `.workflows/orchestration/stream-downloads-season-story/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 1: Schema and single writers: the download queue, the kept mark, the story store

**Plan set:** `STREAM_DOWNLOADS_SEASON_STORY_PLAN.md`
**Analysis:** `.workflows/analyze/20261120-213359-K7Q2_code_analyzer.md`
**Satisfies:** R1, R6. The download queue a click writes and a restart carries on (R1), and the store a story is answered from without a model call (R6)
**Criteria:** R1.7, R6.5
**Depends on:** none
**Difficulty:** NORMAL
**Package:** `src/db`, `src/directStream/downloads`, `src/directStream/torrent`, `src/movies`

---

## Goal

After this phase the database has `stream_downloads` (the persisted download queue, one writer: `DownloadsRepo`), `stream_torrents.kept_at` (the owner's mark, written by `TorrentsRepo.setKept`) and `movie_stories` (every story, written by `MoviesRepo.saveStory`). Every story already written on a `movie_dialogues` row is copied into `movie_stories` by migration 0043, and by the shared-import merge for the stories still on Neon. `MovieStories` and the title detail's `has_story` read stories from `movie_stories`. Nothing new runs yet: the engine (phase 2) and the web-story writer (phase 6) build on these writers.

## Interface Contract

**Deletes:** nothing. `MoviesRepo.saveStory` no longer writes `movie_dialogues.story|story_model|story_at`, and `MovieStories.get`, `MoviesRepo.storySlots` and `read.ts` no longer read them. The columns stay (migration 0043 leaves them alone).

**Renames:** none.

**Creates:**
- Table `stream_downloads` (`src/db/schema.ts`, `streamDownloads`). Columns: `id uuid pk default gen_random_uuid()`, `host text`, `kind text ('movie'|'tv')`, `tmdb_id int`, `season int default 0`, `episode int default 0` (a film is 0/0, as in `stream_caches`), `via text default 'auto' ('auto'|'torrent'|'cloud')`, `info_hash text null` (a torrent picked by hand; only with `via = 'torrent'`), `batch uuid null` (the season click), `state text default 'queued' ('queued'|'running'|'paused'|'done'|'failed')`, `source text null ('torrent'|'cloud')`, `source_id text null` (the info hash, or the `stream_caches.id`), `bytes_done bigint default 0`, `bytes_total bigint null`, `error text null`, `error_detail text null`, `created_at`, `updated_at`, `started_at null`, `completed_at null`. Unique partial index `stream_downloads_open_slot_idx` on `(host, kind, tmdb_id, season, episode) where state <> 'done'`; index `stream_downloads_host_state_idx (host, state, created_at)`. CHECKs: kind, slot, via, state, info_hash (`null`, or via torrent and 40 hex), source (`source`/`source_id` both null or both set; a torrent source is 40 hex), failed iff error, done iff completed_at and a done row has a source, byte counts >= 0.
- Schema exports: `STREAM_DOWNLOAD_VIAS`, `StreamDownloadVia`, `STREAM_DOWNLOAD_STATES`, `StreamDownloadState`, `STREAM_DOWNLOAD_SOURCES`, `StreamDownloadSource`, `streamDownloads`, `StreamDownloadRow`.
- Column `stream_torrents.kept_at timestamptz null` (`streamTorrents.keptAt`; `StreamTorrentRow.keptAt: Date | null`).
- Table `movie_stories` (`movieStories`): `title_id text fk movie_titles on delete cascade`, `season int`, `episode int`, `text text not null`, `sections jsonb default '[]'` (`MovieStorySection[]`: `{episode, name: string|null, text, found}`), `sources jsonb default '[]'` (`MovieStorySource[]`: `{url, title, site}`), `origin text ('web'|'dialogue')`, `model text null`, `written_at timestamptz not null`. PK `(title_id, season, episode)`: `(0, 0)` a film's, `(s, e>0)` an episode's, `(s>0, 0)` a season's. Schema exports: `MovieStorySection`, `MovieStorySource`, `MOVIE_STORY_ORIGINS`, `MovieStoryOrigin`, `movieStories`, `MovieStoryRow`.
- Migration `drizzle/0043_stream_downloads_stories.sql` (+ `drizzle/meta/0043_snapshot.json`, journal entry idx 43), ending with the copy of every `movie_dialogues.story` into `movie_stories` (origin `dialogue`).
- `src/directStream/downloads/repo.ts`:
  - `class DownloadsRepo(db: Db)`, the only writer of `stream_downloads`:
    - `create(host: string, req: DownloadRequest, now: Date): Promise<{ row: StreamDownloadRow; created: boolean }>`
    - `openFor(host: string, ref: StreamRef): Promise<StreamDownloadRow | null>`
    - `get(host: string, id: string): Promise<StreamDownloadRow | null>`
    - `list(host: string, filter?: DownloadFilter): Promise<StreamDownloadRow[]>` (oldest first; rows made in the same instant by season, then episode, then id: a season click downloads in episode order)
    - `claimNext(host: string, now: Date): Promise<StreamDownloadRow | null>`
    - `setState(host: string, id: string, state: DownloadOpenState, now: Date): Promise<StreamDownloadRow | null>`
    - `on(host: string, id: string, on: DownloadOn, now: Date): Promise<StreamDownloadRow | null>`
    - `progress(host: string, id: string, bytesDone: number, bytesTotal: number | null, now: Date): Promise<void>`
    - `done(host: string, id: string, on: DownloadOn, bytes: { bytesDone: number; bytesTotal: number | null }, now: Date): Promise<StreamDownloadRow | null>`
    - `failed(host: string, id: string, error: string, detail: string | null, now: Date): Promise<StreamDownloadRow | null>`
    - `cancel(host: string, id: string, now: Date): Promise<StreamDownloadRow | null>`
    - `toResume(host: string, now: Date): Promise<StreamDownloadRow[]>`
    - `delete(host: string, id: string): Promise<boolean>`
    - `deleteSlot(host: string, ref: StreamRef): Promise<number>`
  - `type DownloadRecords = Pick<DownloadsRepo, …all of the above…>` (what phase 2's service takes; tests pass `MemoryDownloadRecords`)
  - `interface DownloadRequest { ref: StreamRef; via: StreamDownloadVia; infoHash?: string | null; batch?: string | null }`
  - `type DownloadOn = { source: 'torrent'; infoHash: string } | { source: 'cloud'; cacheId: string }`
  - `type DownloadOpenState = 'queued' | 'running' | 'paused'`, `DOWNLOAD_OPEN_STATES`
  - `interface DownloadFilter { kind?: 'movie' | 'tv'; tmdbId?: number; states?: readonly StreamDownloadState[] }`
  - `downloadRef(row): StreamRef`, `downloadOn(row): DownloadOn | null`, `onColumns(on: DownloadOn)`
  - `DOWNLOAD_CANCELLED = 'cancelled'`, `MAX_DOWNLOAD_DETAIL = 500`
- `TorrentsRepo.setKept(host: string, infoHash: string, at: Date | null): Promise<number>` (every row of that torrent on that host; answers the rows marked; `updated_at` untouched). `'setKept'` is added to `TorrentRecords`.
- `MoviesRepo.story(titleId: string, season: number, episode: number): Promise<MovieStoryRow | null>`; `type NewMovieStory` (exported from `src/movies/repo.ts`).
- Test helpers: `tests/helpers/memoryDownloadRecords.ts` (`MemoryDownloadRecords implements DownloadRecords`), `tests/helpers/downloadRecordsContract.ts` (`downloadRecordsContract(label, make)`: one behavior suite run against both the fake and Postgres).

**Signature changes:**
- `MoviesRepo.saveStory(titleId, season, episode, story, model, at?) => Promise<boolean>` -> `MoviesRepo.saveStory(row: NewMovieStory) => Promise<MovieStoryRow>` (upsert onto `movie_stories`; replaces a stored story of that slot).
- `MoviesRepo.storySlots(titleId)`: same signature, now reads `movie_stories` and also answers season slots `(s, 0)`.
- `MovieStoriesOptions.repo`: `Pick<MoviesRepo, 'dialogue' | 'saveStory' | 'loadTitleMetadata'>` -> `Pick<MoviesRepo, 'dialogue' | 'story' | 'saveStory' | 'loadTitleMetadata'>`.
- `TorrentRecords` gains `'setKept'`; `MemoryTorrentRecords` implements it.

**Requires (from earlier phases):** nothing.

**Leaves alone (owned by others):** every service, route, MCP tool and web file except the two story readers named below; `src/directStream/downloads/{service,plan,types}.ts`, `TorrentStreams` (prune exemption), `daemon.ts`/`deps.ts` (phase 2); `StreamDownloads.requestSeason` (phase 3); `src/http/streamDownloadsApi.ts`, `direct_stream_cache`, `web/src/moviesApi.ts` (phase 4); `cacheShelf.ts` (phase 5); `src/movies/webStory.ts`, the rest of `MovieStories`, `StoryView`'s shape, the story routes (phase 6); `docs/guide/*`, `CLAUDE.md` (phase 9). `movie_dialogues`' columns are left as they are.

**Touched outside the strict "no service" line, and why:** `src/movies/story.ts` (`MovieStories.get` and the one `saveStory` call in `writeNew`) and `src/movies/read.ts` (the `has_story` query). Without them a story written after this phase is stored where nothing reads it, and `has_story` goes stale. That breaks `npm test` and the exit criterion "existing stories are still served". The change is limited to the store each one reads. `StoryView` and the routes keep their shape.

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts:1167-1192` | modify | `movie_dialogues` doc: the story columns are no longer written or read |
| `src/db/schema.ts:1477` (after `movieGenreGuides`) | modify | add `MovieStorySection`, `MovieStorySource`, `MOVIE_STORY_ORIGINS`, `movieStories` |
| `src/db/schema.ts:1699-1735` | modify | `streamTorrents` doc + `keptAt` column |
| `src/db/schema.ts:1785` (after `streamTorrentMarks`) | modify | add the `stream_downloads` constants and `streamDownloads` |
| `src/db/schema.ts:1828-1835` | modify | `MovieStoryRow`, `StreamDownloadRow` |
| `drizzle/0043_stream_downloads_stories.sql` | create | generated DDL + the hand-appended story copy |
| `drizzle/meta/0043_snapshot.json`, `drizzle/meta/_journal.json` | create / modify | generated by drizzle-kit |
| `src/db/sharedImport.ts:336` (after the `movie_titles` fill) | modify | a staged Neon dialogue's story is copied into `movie_stories` at the merge |
| `src/directStream/downloads/repo.ts` | create | `DownloadsRepo` and its types |
| `src/directStream/torrent/repo.ts:200-220` | modify | `setKept`; `TorrentRecords` gains it |
| `src/movies/repo.ts:1-33`, `:1191-1207` | modify | `NewMovieStory`, `story`, `saveStory`, `storySlots` on `movie_stories` |
| `src/movies/story.ts:174-186`, `:214-219`, `:255-258` | modify | `repo` pick, `get` reads `repo.story`, `writeNew` saves a `NewMovieStory` |
| `src/movies/read.ts:3-19`, `:1080-1083` | modify | `has_story` from `movie_stories` |
| `tests/helpers/memoryTorrentRecords.ts:16-32`, end of class | modify | `keptAt: null`, `setKept` |
| `tests/helpers/memoryDownloadRecords.ts` | create | in-memory `DownloadRecords` |
| `tests/helpers/downloadRecordsContract.ts` | create | the behavior suite both repos must pass |
| `tests/unit/directStream/downloads/repo.test.ts` | create | contract on the fake + `downloadOn`/`downloadRef` |
| `tests/unit/movies/story.test.ts:8`, `:99-116` + new `it` | modify | fake repo on `story`/`saveStory(row)`; stored story needs no model |
| `tests/integration/setup.ts:50` | modify | `truncateAll` empties `stream_downloads` |
| `tests/integration/directStream.downloads.int.test.ts` | create | contract on Postgres + the CHECKs and the partial index |
| `tests/integration/directStream.torrents.int.test.ts:127` | modify | one `it` for `setKept` |
| `tests/integration/movies.stories.int.test.ts` | create | `story`/`saveStory`/`storySlots`, cascade, CHECKs |
| `tests/integration/movies.api.int.test.ts:341-344` | modify | the story is read from `movie_stories`, the dialogue row keeps none |
| `tests/integration/migration0043.int.test.ts` | create | 0043 on a populated 0042 database |
| `tests/integration/sharedImport.int.test.ts:232` | modify | one `it`: a Neon dialogue's story arrives in `movie_stories` |
| `.claude/skills/verify-notesd/features/movies.md:48-49` | modify | seed a `movie_stories` row, not a dialogue's story |

## Implementation Steps

Run `npm ci` first if the worktree has no `node_modules`.

### Step 1: The story store in the schema
**File:** `src/db/schema.ts:1167-1192` and after line 1477
**Change:** Rewrite the `movie_dialogues` doc comment and the comment on its `story` column (the columns stay). Insert the story types and table right after `movieGenreGuides` (which ends at line 1477).
**Code:** replace lines 1167-1172 with:
```ts
/**
 * The dialogue of a film (season 0, episode 0) or of one episode: the text of its English
 * subtitle as a stream source carried it (src/directStream/dialogue.ts), one line per cue,
 * `mm:ss<TAB>text`. Read once and kept, so "what is this episode about" is answered
 * without resolving again. Written only by `MoviesRepo.saveDialogue`. Stories live in
 * `movie_stories` since migration 0043; the story columns below are no longer written or read.
 */
```
Replace line 1189 (the comment above `story: text('story'),`) with:
```ts
    /** Unused since migration 0043 copied every story into movie_stories; kept so nothing is lost. */
```
Insert after line 1477:
```ts

/** One episode's part of a season's story (movie_stories.sections). */
export interface MovieStorySection {
  episode: number
  /** The episode's name as TMDB has it; null when it has none. */
  name: string | null
  /** What happens in it, taken from the sources alone; empty when `found` is false. */
  text: string
  /** False: no source tells this episode's story, and none is invented. */
  found: boolean
}

/** A web page a story was written from (movie_stories.sources). */
export interface MovieStorySource {
  url: string
  title: string
  /** The site's name ("Wikipedia", "Vulture"). */
  site: string
}

/** Where a story was written from. The CHECK below keeps the same list. */
export const MOVIE_STORY_ORIGINS = ['web', 'dialogue'] as const
export type MovieStoryOrigin = (typeof MOVIE_STORY_ORIGINS)[number]

/**
 * The story of a film, an episode or a season (migration 0043). Claude writes it once when the owner asks, and it is
 * read from here after that, without a model call. One row per (title, season, episode): (0, 0) is a film's story,
 * (s, e) with e > 0 an episode's, and (s, 0) with s > 0 a season's, told per episode in `sections`. `origin`
 * `dialogue`: written from the episode's subtitle (every story migration 0043 copied out of movie_dialogues);
 * `web`: written from the published recaps in `sources`. Written by MoviesRepo.saveStory only. Neon never held it,
 * so it is not in SHARED_IMPORT_TABLES (the merge copies a staged dialogue's story into it instead).
 */
export const movieStories = pgTable(
  'movie_stories',
  {
    titleId: text('title_id')
      .notNull()
      .references(() => movieTitles.id, { onDelete: 'cascade' }),
    season: integer('season').notNull(),
    episode: integer('episode').notNull(),
    text: text('text').notNull(),
    sections: jsonb('sections').$type<MovieStorySection[]>().notNull().default(sql`'[]'::jsonb`),
    sources: jsonb('sources').$type<MovieStorySource[]>().notNull().default(sql`'[]'::jsonb`),
    origin: text('origin').$type<MovieStoryOrigin>().notNull(),
    model: text('model'),
    writtenAt: timestamp('written_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.titleId, t.season, t.episode] }),
    check('movie_stories_slot_check', sql`${t.season} >= 0 and ${t.episode} >= 0`),
    check('movie_stories_origin_check', sql`${t.origin} in ('web', 'dialogue')`),
    check('movie_stories_lists_check', sql`jsonb_typeof(${t.sections}) = 'array' and jsonb_typeof(${t.sources}) = 'array'`),
  ],
)
```
**Impact:** none yet. Nothing reads the new table until Step 7.

### Step 2: The kept mark on a torrent
**File:** `src/db/schema.ts:1699-1735`
**Change:** Add one sentence to the `streamTorrents` doc and a `keptAt` column after `playedAt` (line 1734).
**Code:** the doc block at 1699-1708 becomes:
```ts
/**
 * One torrent download on one host (migration 0031, torrent-stream-source phase 1). Written only by
 * TorrentsRepo (src/directStream/torrent/repo.ts). The files live in that host's torrent folder
 * (`<NOTESD_TORRENT_DIR>/<info hash>/`), so the other machine lists the row with `available: false`.
 * One row per host, info hash and episode (a film is season 0, episode 0, as in stream_caches): a season
 * pack has a row for every episode chosen from it, each with its own files, state and play, so watching
 * E02 never forgets E01's file. A film's row opened for another title forgets its chosen files. `files`
 * are the slot's chosen files only (the video and its subtitles), `file_index` the video. `error` is set exactly when it
 * failed; `completed_at` exactly when it is ready, which needs a chosen video. `kept_at` (migration 0043) is set while
 * the owner keeps the torrent as a download (TorrentsRepo.setKept): the age and budget prunes leave it alone.
 */
```
Insert after line 1734 (`playedAt: …`):
```ts
    /** The owner asked for this torrent as a download (stream_downloads): kept through both prunes until deleted. Null: not the owner's. */
    keptAt: timestamp('kept_at', { withTimezone: true, mode: 'date' }),
```
**Impact:** `StreamTorrentRow` gains `keptAt`. The only object literal of that type is in `tests/helpers/memoryTorrentRecords.ts` (Step 10 fixes it).

### Step 3: The download queue table
**File:** `src/db/schema.ts`, after `streamTorrentMarks` (ends line 1785)
**Code:**
```ts

/** How a download was asked to fetch (src/directStream/downloads/). The CHECK below keeps the same list. */
export const STREAM_DOWNLOAD_VIAS = ['auto', 'torrent', 'cloud'] as const
export type StreamDownloadVia = (typeof STREAM_DOWNLOAD_VIAS)[number]
/** Where a download is. The CHECK below keeps the same list. */
export const STREAM_DOWNLOAD_STATES = ['queued', 'running', 'paused', 'done', 'failed'] as const
export type StreamDownloadState = (typeof STREAM_DOWNLOAD_STATES)[number]
/** What a download fetches from: a torrent (`source_id` its info hash) or the cloud cache (`source_id` the stream_caches id). */
export const STREAM_DOWNLOAD_SOURCES = ['torrent', 'cloud'] as const
export type StreamDownloadSource = (typeof STREAM_DOWNLOAD_SOURCES)[number]

/**
 * One film or episode the owner asked to download to one host (migration 0043): the Download button, or
 * `direct_stream_cache` with a torrent. Written only by DownloadsRepo (src/directStream/downloads/repo.ts). The files
 * land in that host's torrent folder or stream cache, so the other machine lists the row with `available: false`. A
 * film is season 0, episode 0, as in stream_caches. One row per slot and host is open (not `done`) at a time; a season
 * click makes one row per episode under one `batch`. `via` is what was asked (`auto`: a 1080p torrent first, then
 * cloud); `info_hash` a torrent picked by hand, only with `via = 'torrent'`. `source`/`source_id` are what it fetches
 * from, set once chosen. `bytes_*` are the last progress written, which a daemon start carries on from (toResume).
 * `error` is set exactly when it failed (`cancelled` when the owner cancelled it); `completed_at` exactly when it is
 * done, which needs a source. Neon never held it, so it is not in SHARED_IMPORT_TABLES.
 */
export const streamDownloads = pgTable(
  'stream_downloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    host: text('host').notNull(),
    kind: text('kind').$type<MovieTitleKind>().notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    season: integer('season').notNull().default(0),
    episode: integer('episode').notNull().default(0),
    via: text('via').$type<StreamDownloadVia>().notNull().default('auto'),
    infoHash: text('info_hash'),
    batch: uuid('batch'),
    state: text('state').$type<StreamDownloadState>().notNull().default('queued'),
    source: text('source').$type<StreamDownloadSource>(),
    sourceId: text('source_id'),
    bytesDone: bigint('bytes_done', { mode: 'number' }).notNull().default(0),
    bytesTotal: bigint('bytes_total', { mode: 'number' }),
    error: text('error'),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('stream_downloads_open_slot_idx').on(t.host, t.kind, t.tmdbId, t.season, t.episode).where(sql`${t.state} <> 'done'`),
    index('stream_downloads_host_state_idx').on(t.host, t.state, t.createdAt),
    check('stream_downloads_kind_check', sql`${t.kind} in ('movie', 'tv')`),
    check(
      'stream_downloads_slot_check',
      sql`${t.tmdbId} > 0 and ((${t.kind} = 'movie' and ${t.season} = 0 and ${t.episode} = 0) or (${t.kind} = 'tv' and ${t.season} >= 0 and ${t.episode} > 0))`,
    ),
    check('stream_downloads_via_check', sql`${t.via} in ('auto', 'torrent', 'cloud')`),
    check('stream_downloads_state_check', sql`${t.state} in ('queued', 'running', 'paused', 'done', 'failed')`),
    check('stream_downloads_info_hash_check', sql`${t.infoHash} is null or (${t.via} = 'torrent' and ${t.infoHash} ~ '^[0-9a-f]{40}$')`),
    check(
      'stream_downloads_source_check',
      sql`(${t.source} is null) = (${t.sourceId} is null) and (${t.source} is null or ${t.source} in ('torrent', 'cloud')) and (${t.source} is distinct from 'torrent' or ${t.sourceId} ~ '^[0-9a-f]{40}$')`,
    ),
    check('stream_downloads_failed_check', sql`(${t.state} = 'failed') = (${t.error} is not null)`),
    check('stream_downloads_done_check', sql`(${t.state} = 'done') = (${t.completedAt} is not null) and (${t.state} <> 'done' or ${t.source} is not null)`),
    check('stream_downloads_counts_check', sql`${t.bytesDone} >= 0 and (${t.bytesTotal} is null or ${t.bytesTotal} >= 0)`),
  ],
)
```
At the end of the row-type list (after line 1835, `export type StreamTorrentRow = …`) add:
```ts
export type MovieStoryRow = typeof movieStories.$inferSelect
export type StreamDownloadRow = typeof streamDownloads.$inferSelect
```
**Impact:** none yet.

### Step 4: Generate migration 0043 and append the story copy
**File:** `drizzle/0043_stream_downloads_stories.sql`, `drizzle/meta/0043_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** Generate the migration. The worktree has no `.env.local`, and `drizzle.config.ts` accepts any non-pooler URL; `generate` does not connect:
```sh
cd /home/miftah/.worktrees/mcp-notes/stream-downloads-season-story
DATABASE_URL=postgres://gen:gen@127.0.0.1:5432/gen npx drizzle-kit generate --name stream_downloads_stories
```
Check that the generated SQL holds exactly: `CREATE TABLE "movie_stories"` (PK, three CHECKs), `CREATE TABLE "stream_downloads"` (ten CHECKs), `ALTER TABLE "stream_torrents" ADD COLUMN "kept_at" timestamp with time zone;`, the `movie_stories_title_id_movie_titles_id_fk` foreign key, `CREATE UNIQUE INDEX "stream_downloads_open_slot_idx" … WHERE "stream_downloads"."state" <> 'done'` and `CREATE INDEX "stream_downloads_host_state_idx"`. If it holds anything else (a drop, a change to another table), the schema edit is wrong: fix the schema and generate again. Do not hand-edit the DDL.

Then append to the generated file. The generated last statement has no breakpoint after it, so add one first:
```sql
--> statement-breakpoint
-- Every story written so far was written from a dialogue and kept on its row. Stories live in movie_stories from now
-- on; the old columns stay as they are, unread, so nothing is lost.
INSERT INTO "movie_stories" ("title_id", "season", "episode", "text", "origin", "model", "written_at")
SELECT d."title_id", d."season", d."episode", d."story", 'dialogue', d."story_model", coalesce(d."story_at", d."fetched_at")
FROM "movie_dialogues" d
WHERE d."story" IS NOT NULL;
```
**Impact:** the daemon applies it at the next start (`src/db/localDb.ts`). It is additive: two new tables, one nullable column, one copy.

### Step 5: Stories still on Neon arrive in the new store at the merge
**File:** `src/db/sharedImport.ts:336`, right after the `if (has('movie_titles')) { … }` block closes, before `if (has('movie_credits'))`
**Change:** `movie_dialogues` is in `MOVIE_FILL_TABLES`, and the merge has not run yet (~2026-12-01). A story Neon holds would arrive on a dialogue row that nothing reads. Copy staged stories into `movie_stories`, only for a title that is now here (the merge runs with `session_replication_role = replica`, so the foreign key is not checked row by row).
**Code:**
```ts
    // A story the shared side wrote sits on its dialogue row (it predates migration 0043): stories live in movie_stories now.
    if (has('movie_dialogues') && colsOf('movie_dialogues').includes('story')) {
      const res = await client.query(
        `insert into movie_stories (title_id, season, episode, text, origin, model, written_at)
         select s.title_id, s.season, s.episode, s.story, 'dialogue', s.story_model, coalesce(s.story_at, s.fetched_at)
         from ${stage('movie_dialogues')} s
         where s.story is not null and ${exists('movie_titles', 'p.id = s.title_id')}
         on conflict do nothing`,
      )
      written.movie_stories = res.rowCount ?? 0
    }
```
**Impact:** the merge gains one statement in its transaction. `SHARED_IMPORT_TABLES` is unchanged.

### Step 6: `DownloadsRepo`, the only writer of `stream_downloads`
**File:** `src/directStream/downloads/repo.ts` (new; phase 2 adds `service.ts`, `plan.ts` and `types.ts` beside it)
**Code:**
```ts
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  streamDownloads,
  type StreamDownloadRow,
  type StreamDownloadSource,
  type StreamDownloadState,
  type StreamDownloadVia,
} from '../../db/schema.js';
import { cacheSlot } from '../repo.js';
import type { StreamRef } from '../types.js';

/** Characters of a failure's detail kept on the row (as stream_caches keeps). */
export const MAX_DOWNLOAD_DETAIL = 500;
/** The error a download ends with when the owner cancelled it. */
export const DOWNLOAD_CANCELLED = 'cancelled';

/** What the owner asked for: one film or one episode, how to fetch it, and the season click it came from. */
export interface DownloadRequest {
  ref: StreamRef;
  via: StreamDownloadVia;
  /** A torrent picked by hand (40 lower-case hex); only with `via: 'torrent'` (the CHECK refuses it otherwise). */
  infoHash?: string | null;
  /** The season click that asked for it (one uuid per click); null for a single film or episode. */
  batch?: string | null;
}

/** What a download fetches from, once chosen: a torrent, or the cloud cache row. */
export type DownloadOn = { source: 'torrent'; infoHash: string } | { source: 'cloud'; cacheId: string };

/** The states of a download that is not finished. `done` and `failed` have their own writers. */
export type DownloadOpenState = Extract<StreamDownloadState, 'queued' | 'running' | 'paused'>;
export const DOWNLOAD_OPEN_STATES: readonly DownloadOpenState[] = ['queued', 'running', 'paused'];

/** Narrows `list`: one title (kind and TMDB id), some states. */
export interface DownloadFilter {
  kind?: 'movie' | 'tv';
  tmdbId?: number;
  states?: readonly StreamDownloadState[];
}

/** The title a row holds. */
export function downloadRef(row: Pick<StreamDownloadRow, 'kind' | 'tmdbId' | 'season' | 'episode'>): StreamRef {
  return row.kind === 'movie' ? { kind: 'movie', tmdbId: row.tmdbId } : { kind: 'tv', tmdbId: row.tmdbId, season: row.season, episode: row.episode };
}

/** What a row fetches from, or null before a source was chosen. */
export function downloadOn(row: Pick<StreamDownloadRow, 'source' | 'sourceId'>): DownloadOn | null {
  if (row.source === null || row.sourceId === null) return null;
  return row.source === 'torrent' ? { source: 'torrent', infoHash: row.sourceId } : { source: 'cloud', cacheId: row.sourceId };
}

/** The two columns a source is kept in. */
export function onColumns(on: DownloadOn): { source: StreamDownloadSource; sourceId: string } {
  return on.source === 'torrent' ? { source: 'torrent', sourceId: on.infoHash } : { source: 'cloud', sourceId: on.cacheId };
}

const own = (host: string, id: string): SQL | undefined => and(eq(streamDownloads.host, host), eq(streamDownloads.id, id));
const open = (): SQL => inArray(streamDownloads.state, [...DOWNLOAD_OPEN_STATES]);
const slotOf = (host: string, ref: StreamRef): SQL | undefined => {
  const s = cacheSlot(ref);
  return and(
    eq(streamDownloads.host, host),
    eq(streamDownloads.kind, s.kind),
    eq(streamDownloads.tmdbId, s.tmdbId),
    eq(streamDownloads.season, s.season),
    eq(streamDownloads.episode, s.episode),
  );
};
const startedNow = (now: Date): SQL => sql`coalesce(${streamDownloads.startedAt}, ${now.toISOString()}::timestamptz)`;

/** The only writer of `stream_downloads`. Every method acts on one host's rows; ids are the table's own (uuid). */
export class DownloadsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Queues one film or episode on this host. A slot already queued, running or paused is answered as it is
   * (`created: false`). A failed one is queued again from nothing with what is asked now (`created: true`), and so is a
   * new one. A finished (`done`) row does not hold its slot: whether the title is still whole on disk is the caller's to know.
   */
  async create(host: string, req: DownloadRequest, now: Date): Promise<{ row: StreamDownloadRow; created: boolean }> {
    const slot = cacheSlot(req.ref);
    const ask = { via: req.via, infoHash: req.infoHash ?? null, batch: req.batch ?? null };
    const [inserted] = await this.db
      .insert(streamDownloads)
      .values({ host, ...slot, ...ask, state: 'queued', createdAt: now, updatedAt: now })
      .onConflictDoNothing({
        target: [streamDownloads.host, streamDownloads.kind, streamDownloads.tmdbId, streamDownloads.season, streamDownloads.episode],
        // Must match the partial unique index stream_downloads_open_slot_idx.
        where: sql`state <> 'done'`,
      })
      .returning();
    if (inserted !== undefined) return { row: inserted, created: true };
    const existing = await this.openFor(host, req.ref);
    if (existing === null) throw new Error(`the download of ${slot.kind} ${slot.tmdbId} on ${host} vanished while it was queued`);
    if (existing.state !== 'failed') return { row: existing, created: false };
    const [requeued] = await this.db
      .update(streamDownloads)
      .set({
        ...ask,
        state: 'queued',
        source: null,
        sourceId: null,
        bytesDone: 0,
        bytesTotal: null,
        error: null,
        errorDetail: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .where(and(own(host, existing.id), eq(streamDownloads.state, 'failed')))
      .returning();
    if (requeued === undefined) return { row: (await this.get(host, existing.id)) ?? existing, created: false };
    return { row: requeued, created: true };
  }

  /** This host's row of a slot that is not done (queued, running, paused or failed), or null. */
  async openFor(host: string, ref: StreamRef): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .select()
      .from(streamDownloads)
      .where(and(slotOf(host, ref), sql`${streamDownloads.state} <> 'done'`))
      .limit(1);
    return row ?? null;
  }

  /** One row of this host by id, or null (another host's row is null here). `id` must be a uuid: the route checks it. */
  async get(host: string, id: string): Promise<StreamDownloadRow | null> {
    const [row] = await this.db.select().from(streamDownloads).where(own(host, id));
    return row ?? null;
  }

  /**
   * This host's rows in the queue's order, narrowed by `filter`: oldest first, and the rows of one season click
   * (made in the same instant) in episode order, so a season downloads E01, E02, … (phase 3).
   */
  async list(host: string, filter: DownloadFilter = {}): Promise<StreamDownloadRow[]> {
    const where = and(
      eq(streamDownloads.host, host),
      filter.kind === undefined ? undefined : eq(streamDownloads.kind, filter.kind),
      filter.tmdbId === undefined ? undefined : eq(streamDownloads.tmdbId, filter.tmdbId),
      filter.states === undefined ? undefined : inArray(streamDownloads.state, [...filter.states]),
    );
    return this.db
      .select()
      .from(streamDownloads)
      .where(where)
      .orderBy(asc(streamDownloads.createdAt), asc(streamDownloads.season), asc(streamDownloads.episode), asc(streamDownloads.id));
  }

  /** The oldest queued download of this host (in `list`'s order), now running; null when none waits. Two callers never get the same row. */
  async claimNext(host: string, now: Date): Promise<StreamDownloadRow | null> {
    const next = sql`(select d.id from stream_downloads d where d.host = ${host} and d.state = 'queued' order by d.created_at asc, d.season asc, d.episode asc, d.id asc limit 1 for update skip locked)`;
    const [row] = await this.db
      .update(streamDownloads)
      .set({ state: 'running', startedAt: startedNow(now), updatedAt: now })
      .where(eq(streamDownloads.id, next))
      .returning();
    return row ?? null;
  }

  /** Moves a download that is not finished between queued, running and paused. Null when there is none, or it is done or failed. */
  async setState(host: string, id: string, state: DownloadOpenState, now: Date): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ state, updatedAt: now, ...(state === 'running' ? { startedAt: startedNow(now) } : {}) })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** What a download that is not finished fetches from. */
  async on(host: string, id: string, on: DownloadOn, now: Date): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ ...onColumns(on), updatedAt: now })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** The bytes a download that is not finished holds on disk, and of how many. */
  async progress(host: string, id: string, bytesDone: number, bytesTotal: number | null, now: Date): Promise<void> {
    await this.db.update(streamDownloads).set({ bytesDone, bytesTotal, updatedAt: now }).where(and(own(host, id), open()));
  }

  /** A download whose files are whole. Null when there is none, or it was already done or failed. */
  async done(
    host: string,
    id: string,
    on: DownloadOn,
    bytes: { bytesDone: number; bytesTotal: number | null },
    now: Date,
  ): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ ...onColumns(on), ...bytes, state: 'done', error: null, errorDetail: null, completedAt: now, updatedAt: now })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** A download that cannot go on, with a code (`no_source`, `dubbed`, …) and what was seen. Null when it was not open. */
  async failed(host: string, id: string, error: string, detail: string | null, now: Date): Promise<StreamDownloadRow | null> {
    const [row] = await this.db
      .update(streamDownloads)
      .set({ state: 'failed', error, errorDetail: detail === null ? null : detail.slice(0, MAX_DOWNLOAD_DETAIL), completedAt: null, updatedAt: now })
      .where(and(own(host, id), open()))
      .returning();
    return row ?? null;
  }

  /** The owner cancelled a download that is not finished: failed with `cancelled`. Null when there was none to cancel. */
  async cancel(host: string, id: string, now: Date): Promise<StreamDownloadRow | null> {
    return this.failed(host, id, DOWNLOAD_CANCELLED, null, now);
  }

  /**
   * What a daemon start carries on: every download of this host that was queued, running or paused when the last
   * daemon stopped, queued again and answered oldest first. Each keeps its source and bytes, so the engine carries on
   * from what is on disk. Another host's rows, and finished and failed ones, are left alone.
   */
  async toResume(host: string, now: Date): Promise<StreamDownloadRow[]> {
    await this.db
      .update(streamDownloads)
      .set({ state: 'queued', updatedAt: now })
      .where(and(eq(streamDownloads.host, host), inArray(streamDownloads.state, ['running', 'paused'])));
    return this.list(host, { states: ['queued'] });
  }

  /** Deletes one row of this host. */
  async delete(host: string, id: string): Promise<boolean> {
    const rows = await this.db.delete(streamDownloads).where(own(host, id)).returning({ id: streamDownloads.id });
    return rows.length > 0;
  }

  /** Deletes every row of this host for a slot whose files were deleted (the Cache page), finished ones too. Answers how many. */
  async deleteSlot(host: string, ref: StreamRef): Promise<number> {
    const rows = await this.db.delete(streamDownloads).where(slotOf(host, ref)).returning({ id: streamDownloads.id });
    return rows.length;
  }
}

/** What the download engine needs of the repository (tests pass an in-memory one: tests/helpers/memoryDownloadRecords.ts). */
export type DownloadRecords = Pick<
  DownloadsRepo,
  'create' | 'openFor' | 'get' | 'list' | 'claimNext' | 'setState' | 'on' | 'progress' | 'done' | 'failed' | 'cancel' | 'toResume' | 'delete' | 'deleteSlot'
>;
```
**Impact:** new file, no caller yet (phase 2 builds `StreamDownloads` on `DownloadRecords`).

### Step 7: `TorrentsRepo.setKept`
**File:** `src/directStream/torrent/repo.ts`. Insert before `deleteSlot` (line 202, after `stale`). The `TorrentRecords` Pick is at line 215.
**Code:** insert:
```ts
  /**
   * The owner's mark on one torrent of this host, on every episode row of it: set while the owner keeps it as a download
   * (both prunes leave it alone), null to let the prunes have it again. `updated_at` is left alone. Answers the rows marked.
   */
  async setKept(host: string, infoHash: string, at: Date | null): Promise<number> {
    const rows = await this.db.update(streamTorrents).set({ keptAt: at }).where(torrentKey(host, infoHash)).returning({ season: streamTorrents.season });
    return rows.length;
  }

```
Replace the `TorrentRecords` type at the end of the file with:
```ts
/** What TorrentStreams needs of the repository (tests pass an in-memory one). */
export type TorrentRecords = Pick<
  TorrentsRepo,
  | 'record'
  | 'get'
  | 'slots'
  | 'byHash'
  | 'forRef'
  | 'all'
  | 'chosen'
  | 'progress'
  | 'ready'
  | 'failed'
  | 'restarted'
  | 'remuxed'
  | 'played'
  | 'duration'
  | 'stale'
  | 'delete'
  | 'deleteSlot'
  | 'setKept'
>;
```
**Impact:** `MemoryTorrentRecords implements TorrentRecords` must add `setKept` (Step 10). `record`, `restarted` and `delete` leave `kept_at` as it is: deleting the rows deletes the mark with them.

### Step 8: `MoviesRepo` stories on `movie_stories`
**File:** `src/movies/repo.ts:1-33` (imports), `:1191-1207`
**Change:** Import the table and row type, export `NewMovieStory`, add `story`, and rewrite `saveStory` and `storySlots`.
**Code:** replace lines 4-7 with:
```ts
import type { MovieDialogueRow, MovieStoryRow } from '../db/schema.js';

/** A dialogue as it is read from a subtitle. Its old story columns are no longer written (stories live in movie_stories). */
export type NewMovieDialogue = Omit<MovieDialogueRow, 'story' | 'storyModel' | 'storyAt'>;
/** A story as saveStory keeps it: `sections` and `sources` default to none. */
export type NewMovieStory = Omit<MovieStoryRow, 'sections' | 'sources'> & Partial<Pick<MovieStoryRow, 'sections' | 'sources'>>;
```
In the `from '../db/schema.js'` import list (lines 8-33) add `movieStories,` after `movieStreamSources,`.

Replace lines 1191-1207 (`saveStory` and `storySlots`) with:
```ts
  // ---------- stories (src/movies/story.ts) ----------

  /** The stored story of a film (0, 0), an episode (s, e) or a season (s > 0, 0), or null. */
  async story(titleIdValue: string, season: number, episode: number): Promise<MovieStoryRow | null> {
    const rows = await this.db
      .select()
      .from(movieStories)
      .where(and(eq(movieStories.titleId, titleIdValue), eq(movieStories.season, season), eq(movieStories.episode, episode)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Keeps a story, replacing the one stored for the same slot. The title row must exist. */
  async saveStory(row: NewMovieStory): Promise<MovieStoryRow> {
    const values = { ...row, sections: row.sections ?? [], sources: row.sources ?? [] };
    const [kept] = await this.db
      .insert(movieStories)
      .values(values)
      .onConflictDoUpdate({
        target: [movieStories.titleId, movieStories.season, movieStories.episode],
        set: { text: values.text, sections: values.sections, sources: values.sources, origin: values.origin, model: values.model, writtenAt: values.writtenAt },
      })
      .returning();
    if (kept === undefined) throw new Error(`the story of ${row.titleId} ${row.season}x${row.episode} was not kept`);
    return kept;
  }

  /** Every slot of a title that has a story: (0, 0) a film's, (s, e) an episode's, (s, 0) a season's. */
  async storySlots(titleIdValue: string): Promise<EpisodeRef[]> {
    return this.db
      .select({ season: movieStories.season, episode: movieStories.episode })
      .from(movieStories)
      .where(eq(movieStories.titleId, titleIdValue))
      .orderBy(asc(movieStories.season), asc(movieStories.episode));
  }
```
**Impact:** the only `saveStory` caller is `MovieStories.writeNew` (Step 9). `isNotNull` is still used elsewhere in the file (3 other uses), so keep the import.

### Step 9: `MovieStories` and `has_story` read the store
**File:** `src/movies/story.ts:174-186`, `:214-219`, `:255-258`; `src/movies/read.ts:3-19`, `:1080-1083`
**Change:** the minimum that keeps stories readable: `get` reads `repo.story`, and `writeNew` saves a `NewMovieStory` with origin `dialogue`. `StoryView`'s shape is unchanged (phase 6 owns it). `provider` and `cues` still come from the dialogue row, which every story has in this phase.
**Code:** `MovieStoriesOptions` (lines 174-186) becomes:
```ts
export interface MovieStoriesOptions {
  /** `story`/`saveStory`: movie_stories; `dialogue`: the subtitle a story names as its source. */
  repo: Pick<MoviesRepo, 'dialogue' | 'story' | 'saveStory' | 'loadTitleMetadata'>;
  /**
   * The title's dialogue, read from a stream source when it is not stored yet
   * (dialogueStore.ts loadDialogue). Null from it: none is stored and none can be read here
   * (direct streaming is off). It throws DirectStreamError when the title cannot be resolved.
   */
  dialogue: (target: StreamRef) => Promise<StoredDialogue | null>;
  /** Null: NOTESD_MOVIES_STORY_MODEL=off, or no claude binary. Stored stories are still read. */
  writer: StoryWriter | null;
  now?: () => Date;
  log?: (line: string) => void;
}
```
`get` (lines 214-219) becomes:
```ts
  /** The stored story of a film (season 0, episode 0) or an episode, or null. Never calls a model. */
  async get(titleId: string, season: number, episode: number): Promise<StoryView | null> {
    const row = await this.opts.repo.story(titleId, season, episode);
    if (row === null) return null;
    // The subtitle it was written from is named by its dialogue row; a story with none names no provider.
    const dialogue = await this.opts.repo.dialogue(titleId, season, episode);
    return {
      season,
      episode,
      text: row.text,
      model: row.model,
      written_at: row.writtenAt.toISOString(),
      provider: dialogue?.provider ?? '',
      cues: dialogue?.cues ?? 0,
    };
  }
```
In `writeNew`, replace lines 255-258 (from `const at = this.now();` to the `return`) with:
```ts
    const at = this.now();
    await this.opts.repo.saveStory({ titleId, season, episode, text, origin: 'dialogue', model: writer.model, writtenAt: at });
    this.log(`[notesd] movies: wrote the story of ${titleId} S${pad(season)}E${pad(episode)} with ${writer.model} from ${dialogue.cues} lines (${text.length} characters)`);
    return { story: { season, episode, text, model: writer.model, written_at: at.toISOString(), provider: dialogue.provider, cues: dialogue.cues }, cached: false };
```
`src/movies/read.ts`: in the schema import (lines 3-19) replace `movieDialogues,` with `movieStories,` (keep the list's order: put it after `movieStreamSources,`). Replace the fourth query of the `Promise.all` at lines 1080-1083 with:
```ts
    db
      .select({ season: movieStories.season, episode: movieStories.episode })
      .from(movieStories)
      .where(eq(movieStories.titleId, t.id)),
```
**Impact:** `GET`/`POST /api/movies/:id/story` and `has_story` behave as before, now backed by `movie_stories`. A season row `(s, 0)` matches no episode key, because episodes are > 0.

### Step 10: Test fakes
**File:** `tests/helpers/memoryTorrentRecords.ts`
**Change:** In the `created` literal (lines 16-32) add `keptAt: null,` after `playedAt: null,`. Add before `private at(`:
```ts
  async setKept(host: string, infoHash: string, at: Date | null): Promise<number> {
    const rows = this.rows.filter((r) => r.host === host && r.infoHash === infoHash);
    for (const r of rows) r.keptAt = at;
    return rows.length;
  }

```

**File:** `tests/helpers/memoryDownloadRecords.ts` (new)
```ts
import type { StreamDownloadRow, StreamDownloadState } from '../../src/db/schema.js';
import { cacheSlot } from '../../src/directStream/repo.js';
import {
  DOWNLOAD_CANCELLED,
  DOWNLOAD_OPEN_STATES,
  MAX_DOWNLOAD_DETAIL,
  onColumns,
  type DownloadFilter,
  type DownloadOn,
  type DownloadOpenState,
  type DownloadRecords,
  type DownloadRequest,
} from '../../src/directStream/downloads/repo.js';
import type { StreamRef } from '../../src/directStream/types.js';

const isOpen = (state: StreamDownloadState): boolean => (DOWNLOAD_OPEN_STATES as readonly string[]).includes(state);

/**
 * DownloadsRepo in memory, with the same rules: one open (not done) row per host and slot, a failed one queued again
 * from nothing, done and failed final, the CHECKs on a picked torrent and on a finished row. Proven against the real
 * repository by tests/helpers/downloadRecordsContract.ts.
 */
export class MemoryDownloadRecords implements DownloadRecords {
  readonly rows: StreamDownloadRow[] = [];
  private seq = 0;

  async create(host: string, req: DownloadRequest, now: Date): Promise<{ row: StreamDownloadRow; created: boolean }> {
    const slot = cacheSlot(req.ref);
    const ask = { via: req.via, infoHash: req.infoHash ?? null, batch: req.batch ?? null };
    if (ask.infoHash !== null && (ask.via !== 'torrent' || !/^[0-9a-f]{40}$/.test(ask.infoHash))) {
      throw new Error('stream_downloads_info_hash_check: a picked torrent needs via torrent and a 40-hex hash');
    }
    const existing = this.openRow(host, req.ref);
    if (existing === undefined) {
      this.seq += 1;
      const row: StreamDownloadRow = {
        id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
        host,
        ...slot,
        ...ask,
        state: 'queued',
        source: null,
        sourceId: null,
        bytesDone: 0,
        bytesTotal: null,
        error: null,
        errorDetail: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
      };
      this.rows.push(row);
      return { row: { ...row }, created: true };
    }
    if (existing.state !== 'failed') return { row: { ...existing }, created: false };
    Object.assign(existing, ask, {
      state: 'queued',
      source: null,
      sourceId: null,
      bytesDone: 0,
      bytesTotal: null,
      error: null,
      errorDetail: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    });
    return { row: { ...existing }, created: true };
  }

  async openFor(host: string, ref: StreamRef): Promise<StreamDownloadRow | null> {
    const row = this.openRow(host, ref);
    return row === undefined ? null : { ...row };
  }

  async get(host: string, id: string): Promise<StreamDownloadRow | null> {
    const row = this.at(host, id);
    return row === undefined ? null : { ...row };
  }

  async list(host: string, filter: DownloadFilter = {}): Promise<StreamDownloadRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.host === host &&
          (filter.kind === undefined || r.kind === filter.kind) &&
          (filter.tmdbId === undefined || r.tmdbId === filter.tmdbId) &&
          (filter.states === undefined || filter.states.includes(r.state)),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.season - b.season || a.episode - b.episode || a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }

  async claimNext(host: string, now: Date): Promise<StreamDownloadRow | null> {
    const [next] = await this.list(host, { states: ['queued'] });
    if (next === undefined) return null;
    const row = this.at(host, next.id) as StreamDownloadRow;
    Object.assign(row, { state: 'running', startedAt: row.startedAt ?? now, updatedAt: now });
    return { ...row };
  }

  async setState(host: string, id: string, state: DownloadOpenState, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, { state, updatedAt: now }, state === 'running' ? { startedAt: row.startedAt ?? now } : {});
    return { ...row };
  }

  async on(host: string, id: string, on: DownloadOn, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, onColumns(on), { updatedAt: now });
    return { ...row };
  }

  async progress(host: string, id: string, bytesDone: number, bytesTotal: number | null, now: Date): Promise<void> {
    const row = this.openById(host, id);
    if (row !== undefined) Object.assign(row, { bytesDone, bytesTotal, updatedAt: now });
  }

  async done(host: string, id: string, on: DownloadOn, bytes: { bytesDone: number; bytesTotal: number | null }, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, onColumns(on), bytes, { state: 'done', error: null, errorDetail: null, completedAt: now, updatedAt: now });
    return { ...row };
  }

  async failed(host: string, id: string, error: string, detail: string | null, now: Date): Promise<StreamDownloadRow | null> {
    const row = this.openById(host, id);
    if (row === undefined) return null;
    Object.assign(row, { state: 'failed', error, errorDetail: detail === null ? null : detail.slice(0, MAX_DOWNLOAD_DETAIL), completedAt: null, updatedAt: now });
    return { ...row };
  }

  async cancel(host: string, id: string, now: Date): Promise<StreamDownloadRow | null> {
    return this.failed(host, id, DOWNLOAD_CANCELLED, null, now);
  }

  async toResume(host: string, now: Date): Promise<StreamDownloadRow[]> {
    for (const r of this.rows) if (r.host === host && (r.state === 'running' || r.state === 'paused')) Object.assign(r, { state: 'queued', updatedAt: now });
    return this.list(host, { states: ['queued'] });
  }

  async delete(host: string, id: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !(r.host === host && r.id === id)));
    return this.rows.length < before;
  }

  async deleteSlot(host: string, ref: StreamRef): Promise<number> {
    const before = this.rows.length;
    this.rows.splice(0, this.rows.length, ...this.rows.filter((r) => !(r.host === host && this.sameSlot(r, ref))));
    return before - this.rows.length;
  }

  private sameSlot(r: StreamDownloadRow, ref: StreamRef): boolean {
    const s = cacheSlot(ref);
    return r.kind === s.kind && r.tmdbId === s.tmdbId && r.season === s.season && r.episode === s.episode;
  }

  private openRow(host: string, ref: StreamRef): StreamDownloadRow | undefined {
    return this.rows.find((r) => r.host === host && r.state !== 'done' && this.sameSlot(r, ref));
  }

  private at(host: string, id: string): StreamDownloadRow | undefined {
    return this.rows.find((r) => r.host === host && r.id === id);
  }

  private openById(host: string, id: string): StreamDownloadRow | undefined {
    const row = this.at(host, id);
    return row !== undefined && isOpen(row.state) ? row : undefined;
  }
}
```

### Step 11: One behavior suite for both download repositories
**File:** `tests/helpers/downloadRecordsContract.ts` (new; not a `*.test.ts`, so vitest collects it only through the two files that call it)
```ts
import { describe, expect, it } from 'vitest';
import type { DownloadRecords } from '../../src/directStream/downloads/repo.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const CACHE = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const NOBODY = '33333333-3333-4333-8333-333333333333';
const FILM = { kind: 'movie', tmdbId: 550 } as const;
const ep = (episode: number) => ({ kind: 'tv', tmdbId: 1399, season: 1, episode }) as const;
const at = (s: number): Date => new Date(Date.UTC(2026, 10, 20, 12, 0, s));

/** What DownloadsRepo promises, run against Postgres (tests/integration) and the in-memory fake (tests/unit). */
export function downloadRecordsContract(label: string, make: () => Promise<DownloadRecords>): void {
  describe(`${label}: the download queue (stream_downloads)`, () => {
    it('queues one open row per film or episode and host; asking again answers it; a failed one is queued again from nothing', async () => {
      const r = await make();
      const first = await r.create('host-a', { ref: FILM, via: 'auto' }, at(1));
      expect(first.created).toBe(true);
      expect(first.row).toMatchObject({
        host: 'host-a', kind: 'movie', tmdbId: 550, season: 0, episode: 0, via: 'auto', infoHash: null, batch: null,
        state: 'queued', source: null, sourceId: null, bytesDone: 0, bytesTotal: null, error: null, startedAt: null, completedAt: null,
      });
      const again = await r.create('host-a', { ref: FILM, via: 'cloud' }, at(2));
      expect(again).toMatchObject({ created: false, row: { id: first.row.id, via: 'auto', state: 'queued' } });
      const elsewhere = await r.create('host-b', { ref: FILM, via: 'cloud' }, at(3));
      expect(elsewhere.created).toBe(true);
      expect(elsewhere.row.id).not.toBe(first.row.id);

      await r.on('host-a', first.row.id, { source: 'torrent', infoHash: HASH }, at(4));
      await r.progress('host-a', first.row.id, 500, 1000, at(4));
      expect(await r.failed('host-a', first.row.id, 'no_source', 'x'.repeat(900), at(5))).toMatchObject({ state: 'failed', error: 'no_source', errorDetail: 'x'.repeat(500) });
      const retried = await r.create('host-a', { ref: FILM, via: 'torrent', infoHash: HASH }, at(6));
      expect(retried).toMatchObject({
        created: true,
        row: { id: first.row.id, via: 'torrent', infoHash: HASH, state: 'queued', error: null, errorDetail: null, source: null, sourceId: null, bytesDone: 0, bytesTotal: null },
      });
    });

    it('hands out the oldest queued download of the host, one at a time', async () => {
      const r = await make();
      const film = await r.create('host-b', { ref: FILM, via: 'auto' }, at(0));
      const e1 = await r.create('host-a', { ref: ep(1), via: 'auto', batch: BATCH }, at(1));
      const e2 = await r.create('host-a', { ref: ep(2), via: 'auto', batch: BATCH }, at(2));
      expect(await r.claimNext('host-a', at(3))).toMatchObject({ id: e1.row.id, state: 'running', startedAt: at(3), batch: BATCH });
      expect(await r.claimNext('host-a', at(4))).toMatchObject({ id: e2.row.id, state: 'running', startedAt: at(4) });
      expect(await r.claimNext('host-a', at(5))).toBeNull();
      expect(await r.claimNext('host-b', at(5))).toMatchObject({ id: film.row.id, state: 'running' });
    });

    it('follows a download to its end: source, progress, paused and running again, done; a done row is final and frees its slot', async () => {
      const r = await make();
      const { row } = await r.create('host-a', { ref: ep(1), via: 'cloud' }, at(1));
      expect(await r.setState('host-a', row.id, 'running', at(2))).toMatchObject({ state: 'running', startedAt: at(2) });
      expect(await r.on('host-a', row.id, { source: 'cloud', cacheId: CACHE }, at(3))).toMatchObject({ source: 'cloud', sourceId: CACHE });
      await r.progress('host-a', row.id, 10, 100, at(3));
      expect(await r.setState('host-a', row.id, 'paused', at(4))).toMatchObject({ state: 'paused', bytesDone: 10, bytesTotal: 100 });
      expect(await r.setState('host-a', row.id, 'running', at(5))).toMatchObject({ state: 'running', startedAt: at(2) });
      const done = await r.done('host-a', row.id, { source: 'cloud', cacheId: CACHE }, { bytesDone: 100, bytesTotal: 100 }, at(6));
      expect(done).toMatchObject({ state: 'done', completedAt: at(6), source: 'cloud', sourceId: CACHE, bytesDone: 100, error: null });
      expect(await r.setState('host-a', row.id, 'queued', at(7))).toBeNull();
      expect(await r.failed('host-a', row.id, 'download_failed', null, at(7))).toBeNull();
      await r.progress('host-a', row.id, 1, 1, at(7));
      expect(await r.get('host-a', row.id)).toMatchObject({ state: 'done', bytesDone: 100 });
      expect(await r.openFor('host-a', ep(1))).toBeNull();
      const next = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(8));
      expect(next.created).toBe(true);
      expect(next.row.id).not.toBe(row.id);
      expect((await r.list('host-a', { states: ['queued'] })).map((d) => d.id)).toEqual([next.row.id]);
    });

    it('cancels what is not finished, once', async () => {
      const r = await make();
      const { row } = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(1));
      expect(await r.cancel('host-a', row.id, at(2))).toMatchObject({ state: 'failed', error: 'cancelled', completedAt: null });
      expect(await r.cancel('host-a', row.id, at(3))).toBeNull();
      expect(await r.cancel('host-a', NOBODY, at(3))).toBeNull();
      expect(await r.cancel('host-b', row.id, at(3))).toBeNull();
    });

    it('carries on at a daemon start what was queued, running or paused on this host, from what it had on disk (R1.7)', async () => {
      const r = await make();
      const queued = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(1));
      const running = await r.create('host-a', { ref: ep(2), via: 'torrent' }, at(2));
      await r.setState('host-a', running.row.id, 'running', at(2));
      await r.on('host-a', running.row.id, { source: 'torrent', infoHash: HASH }, at(2));
      await r.progress('host-a', running.row.id, 700, 1000, at(2));
      const paused = await r.create('host-a', { ref: ep(3), via: 'auto' }, at(3));
      await r.setState('host-a', paused.row.id, 'paused', at(3));
      const done = await r.create('host-a', { ref: ep(4), via: 'cloud' }, at(4));
      await r.done('host-a', done.row.id, { source: 'cloud', cacheId: CACHE }, { bytesDone: 5, bytesTotal: 5 }, at(4));
      const failed = await r.create('host-a', { ref: ep(5), via: 'auto' }, at(5));
      await r.failed('host-a', failed.row.id, 'no_source', null, at(5));
      const other = await r.create('host-b', { ref: ep(1), via: 'auto' }, at(6));
      await r.setState('host-b', other.row.id, 'running', at(6));

      const resumed = await r.toResume('host-a', at(10));
      expect(resumed.map((d) => d.id)).toEqual([queued.row.id, running.row.id, paused.row.id]);
      expect(resumed.every((d) => d.state === 'queued')).toBe(true);
      expect(resumed[1]).toMatchObject({ source: 'torrent', sourceId: HASH, bytesDone: 700, bytesTotal: 1000, startedAt: at(2) });
      expect(await r.get('host-a', done.row.id)).toMatchObject({ state: 'done' });
      expect(await r.get('host-a', failed.row.id)).toMatchObject({ state: 'failed' });
      expect(await r.get('host-b', other.row.id)).toMatchObject({ state: 'running' });
    });

    it('reads one host only, narrowed by title and state', async () => {
      const r = await make();
      const e1 = await r.create('host-a', { ref: ep(1), via: 'auto' }, at(1));
      await r.create('host-a', { ref: FILM, via: 'auto' }, at(2));
      const e2 = await r.create('host-a', { ref: ep(2), via: 'auto' }, at(3));
      await r.create('host-b', { ref: ep(3), via: 'auto' }, at(4));
      expect((await r.list('host-a', { kind: 'tv', tmdbId: 1399 })).map((d) => d.id)).toEqual([e1.row.id, e2.row.id]);
      expect(await r.list('host-a')).toHaveLength(3);
      expect(await r.get('host-b', e1.row.id)).toBeNull();
      expect(await r.openFor('host-a', ep(2))).toMatchObject({ id: e2.row.id });
    });

    it('forgets a slot whose files were deleted, finished rows too', async () => {
      const r = await make();
      const first = await r.create('host-a', { ref: ep(1), via: 'cloud' }, at(1));
      await r.done('host-a', first.row.id, { source: 'cloud', cacheId: CACHE }, { bytesDone: 1, bytesTotal: 1 }, at(2));
      await r.create('host-a', { ref: ep(1), via: 'auto' }, at(3));
      const kept = await r.create('host-b', { ref: ep(1), via: 'auto' }, at(4));
      expect(await r.deleteSlot('host-a', ep(1))).toBe(2);
      expect(await r.list('host-a')).toEqual([]);
      expect(await r.delete('host-b', kept.row.id)).toBe(true);
      expect(await r.delete('host-b', kept.row.id)).toBe(false);
    });
  });
}
```

**File:** `tests/unit/directStream/downloads/repo.test.ts` (new)
```ts
import { describe, expect, it } from 'vitest';
import { downloadOn, downloadRef, onColumns } from '../../../../src/directStream/downloads/repo.js';
import { downloadRecordsContract } from '../../../helpers/downloadRecordsContract.js';
import { MemoryDownloadRecords } from '../../../helpers/memoryDownloadRecords.js';

downloadRecordsContract('in memory', async () => new MemoryDownloadRecords());

describe('a download row', () => {
  it('names its title and what it fetches from', () => {
    expect(downloadRef({ kind: 'movie', tmdbId: 550, season: 0, episode: 0 })).toEqual({ kind: 'movie', tmdbId: 550 });
    expect(downloadRef({ kind: 'tv', tmdbId: 1399, season: 2, episode: 3 })).toEqual({ kind: 'tv', tmdbId: 1399, season: 2, episode: 3 });
    expect(downloadOn({ source: null, sourceId: null })).toBeNull();
    expect(downloadOn({ source: 'torrent', sourceId: 'a'.repeat(40) })).toEqual({ source: 'torrent', infoHash: 'a'.repeat(40) });
    expect(downloadOn({ source: 'cloud', sourceId: 'c1' })).toEqual({ source: 'cloud', cacheId: 'c1' });
    expect(onColumns({ source: 'cloud', cacheId: 'c1' })).toEqual({ source: 'cloud', sourceId: 'c1' });
  });

  it('refuses a picked torrent without via torrent, as the CHECK does', async () => {
    await expect(new MemoryDownloadRecords().create('h', { ref: { kind: 'movie', tmdbId: 1 }, via: 'auto', infoHash: 'a'.repeat(40) }, new Date())).rejects.toThrow(/info_hash/);
  });
});
```

### Step 12: Story unit test on the new store
**File:** `tests/unit/movies/story.test.ts:8`, `:99-116`, and a new `it` after line 143's test
**Change:** The fake repo stores `MovieStoryRow`s. Its `dialogue` answers a row for every slot, as the stored dialogue of a written story would. Add one test: a story already stored is answered with no model call and no dialogue read (R6.5).
**Code:** replace line 8 with:
```ts
import type { MovieDialogueRow, MovieStoryRow } from '../../../src/db/schema.js';
import type { NewMovieStory } from '../../../src/movies/repo.js';
```
Replace the `setup` function (lines 99-116) with:
```ts
  function setup(over: { writer?: StoryWriter | null; dialogue?: () => Promise<StoredDialogue | null>; meta?: TitleMetadata | null; stored?: MovieStoryRow[] } = {}) {
    const rows = new Map<string, MovieStoryRow>((over.stored ?? []).map((r) => [`${r.titleId} ${r.season} ${r.episode}`, r]));
    const write = vi.fn(async (_input: StoryInput) => 'Jack gasses Zou.\n\nSanji arrives.');
    const writer = over.writer === undefined ? { model: 'sonnet', write } : over.writer;
    const dialogue = vi.fn(over.dialogue ?? (async () => DIALOGUE));
    const saveStory = vi.fn(async (row: NewMovieStory) => {
      const kept: MovieStoryRow = { sections: [], sources: [], ...row };
      rows.set(`${row.titleId} ${row.season} ${row.episode}`, kept);
      return kept;
    });
    const dialogueRow = (titleId: string, season: number, episode: number): MovieDialogueRow => ({
      titleId, season, episode, lang: 'en', provider: 'VidNest Anime', cues: 2, lastCueS: 723, body: DIALOGUE.body, fetchedAt: DIALOGUE.fetchedAt, story: null, storyModel: null, storyAt: null,
    });
    const stories = new MovieStories({
      repo: {
        story: async (titleId, season, episode) => rows.get(`${titleId} ${season} ${episode}`) ?? null,
        dialogue: async (titleId, season, episode) => dialogueRow(titleId, season, episode),
        saveStory,
        loadTitleMetadata: async () => (over.meta === undefined ? META : over.meta),
      },
      dialogue,
      writer,
      now: () => new Date('2026-11-16T06:00:00Z'),
      log: () => undefined,
    });
    return { stories, write, dialogue, saveStory };
  }
```
In the first test, after `expect(await t.stories.get('tv-37854', 18, 760)).toMatchObject({ text: first.story.text, model: 'sonnet' });` add:
```ts
    expect(t.saveStory).toHaveBeenCalledWith({ titleId: 'tv-37854', season: 18, episode: 760, text: 'Jack gasses Zou.\n\nSanji arrives.', origin: 'dialogue', model: 'sonnet', writtenAt: new Date('2026-11-16T06:00:00Z') });
```
Add a test after the first one:
```ts
  it('answers a story already in the store without a model call or a dialogue read (R6.5)', async () => {
    const stored: MovieStoryRow = {
      titleId: 'tv-37854', season: 18, episode: 760, text: 'Kept from before.', sections: [], sources: [], origin: 'dialogue', model: 'haiku', writtenAt: new Date('2026-11-01T00:00:00Z'),
    };
    const t = setup({ stored: [stored] });
    expect(await t.stories.write('tv-37854', 18, 760)).toEqual({
      cached: true,
      story: { season: 18, episode: 760, text: 'Kept from before.', model: 'haiku', written_at: '2026-11-01T00:00:00.000Z', provider: 'VidNest Anime', cues: 2 },
    });
    expect(t.write).not.toHaveBeenCalled();
    expect(t.dialogue).not.toHaveBeenCalled();
    expect(t.saveStory).not.toHaveBeenCalled();
    // Stories are off here, and a stored one still opens.
    expect((await setup({ writer: null, stored: [stored] }).stories.write('tv-37854', 18, 760)).cached).toBe(true);
  });
```

### Step 13: Integration tests
**File:** `tests/integration/setup.ts:50`
**Change:** in `truncateAll`'s statement, put `stream_downloads, ` before `stream_torrent_marks`. (`movie_stories` goes with `movie_titles` through `cascade`.)

**File:** `tests/integration/directStream.downloads.int.test.ts` (new)
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { streamDownloads } from '../../src/db/schema.js';
import { DownloadsRepo } from '../../src/directStream/downloads/repo.js';
import { downloadRecordsContract } from '../helpers/downloadRecordsContract.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

let db: Db;

async function pgCode(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return e.code;
      cur = e.cause;
    }
    return undefined;
  }
  throw new Error('expected the statement to fail');
}

beforeAll(() => {
  db = openTestDb();
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
});

downloadRecordsContract('Postgres', async () => new DownloadsRepo(db));

describe('stream_downloads checks', () => {
  const base = { host: 'host-a', kind: 'movie' as const, tmdbId: 550, season: 0, episode: 0 };
  const HASH = '0123456789abcdef0123456789abcdef01234567';

  it('refuses a row that contradicts itself', async () => {
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, via: 'auto', infoHash: HASH }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, via: 'torrent', infoHash: 'NOTAHASH' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, source: 'torrent' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, source: 'torrent', sourceId: 'cache-id' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, state: 'done', completedAt: new Date() }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, state: 'failed' }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, season: 1, episode: 1 }))).toBe('23514');
    expect(await pgCode(db.insert(streamDownloads).values({ ...base, bytesDone: -1 }))).toBe('23514');
  });

  it('holds one open row per slot and host; finished ones do not count', async () => {
    await db.insert(streamDownloads).values({ ...base, state: 'done', source: 'cloud', sourceId: 'c1', completedAt: new Date() });
    await db.insert(streamDownloads).values({ ...base, state: 'done', source: 'cloud', sourceId: 'c2', completedAt: new Date() });
    await db.insert(streamDownloads).values({ ...base, state: 'failed', error: 'no_source' });
    expect(await pgCode(db.insert(streamDownloads).values({ ...base }))).toBe('23505');
    await db.insert(streamDownloads).values({ ...base, host: 'host-b' });
  });
});
```

**File:** `tests/integration/directStream.torrents.int.test.ts`, insert after the test ending at line 127
```ts
  it('keeps the owner\'s mark on every episode row of a torrent of this host, and clears it', async () => {
    const later = new Date(T0.getTime() + 60_000);
    await repo.record('host-a', { infoHash: HASH, ref: EPISODE, name: NAME, release: null, trackers: [] }, T0);
    await repo.record('host-a', { infoHash: HASH, ref: { ...EPISODE, episode: 3 }, name: NAME, release: null, trackers: [] }, T0);
    await repo.record('host-b', { infoHash: HASH, ref: EPISODE, name: NAME, release: null, trackers: [] }, T0);
    expect((await repo.get('host-a', HASH, EPISODE))?.keptAt).toBeNull();
    expect(await repo.setKept('host-a', HASH, later)).toBe(2);
    expect((await repo.slots('host-a', HASH)).map((r) => r.keptAt)).toEqual([later, later]);
    expect((await repo.get('host-a', HASH, EPISODE))?.updatedAt).toEqual(T0);
    expect((await repo.get('host-b', HASH, EPISODE))?.keptAt).toBeNull();
    expect(await repo.setKept('host-a', HASH, null)).toBe(2);
    expect((await repo.slots('host-a', HASH)).every((r) => r.keptAt === null)).toBe(true);
    expect(await repo.setKept('host-a', 'f'.repeat(40), later)).toBe(0);
  });
```

**File:** `tests/integration/movies.stories.int.test.ts` (new)
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

let db: Db;
let repo: MoviesRepo;
const T0 = new Date('2026-11-20T12:00:00Z');
const T1 = new Date('2026-11-20T13:00:00Z');

async function pgCode(statement: Promise<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (err) {
    let cur: unknown = err;
    while (cur && typeof cur === 'object') {
      const e = cur as { code?: unknown; cause?: unknown };
      if (typeof e.code === 'string') return e.code;
      cur = e.cause;
    }
    return undefined;
  }
  throw new Error('expected the statement to fail');
}

beforeAll(() => {
  db = openTestDb();
  repo = new MoviesRepo(db);
});
afterAll(async () => {
  await closeTestDb(db);
});
beforeEach(async () => {
  await truncateAll(db);
  await db.execute(sql`insert into movie_titles (id, kind, tmdb_id, title, original_title) values ('tv-247718', 'tv', 247718, 'MobLand', 'MobLand'), ('movie-550', 'movie', 550, 'Fight Club', 'Fight Club')`);
});

describe('movie_stories (MoviesRepo.story, saveStory, storySlots)', () => {
  it('keeps a film\'s, an episode\'s and a season\'s story, and answers each from the store', async () => {
    const episode = await repo.saveStory({ titleId: 'tv-247718', season: 1, episode: 2, text: 'He fixes it.', origin: 'dialogue', model: 'sonnet', writtenAt: T0 });
    expect(episode).toMatchObject({ sections: [], sources: [], origin: 'dialogue' });
    await repo.saveStory({
      titleId: 'tv-247718', season: 1, episode: 0, text: 'The season.', origin: 'web', model: 'sonnet', writtenAt: T0,
      sections: [{ episode: 1, name: 'Pilot', text: 'It starts.', found: true }, { episode: 2, name: null, text: '', found: false }],
      sources: [{ url: 'https://en.wikipedia.org/wiki/MobLand', title: 'MobLand', site: 'Wikipedia' }],
    });
    await repo.saveStory({ titleId: 'movie-550', season: 0, episode: 0, text: 'A film.', origin: 'dialogue', model: null, writtenAt: T0 });
    expect(await repo.story('tv-247718', 1, 2)).toEqual({ titleId: 'tv-247718', season: 1, episode: 2, text: 'He fixes it.', sections: [], sources: [], origin: 'dialogue', model: 'sonnet', writtenAt: T0 });
    expect((await repo.story('tv-247718', 1, 0))?.sections).toHaveLength(2);
    expect(await repo.story('tv-247718', 1, 3)).toBeNull();
    expect(await repo.storySlots('tv-247718')).toEqual([{ season: 1, episode: 0 }, { season: 1, episode: 2 }]);
  });

  it('replaces the story of a slot when it is written again, and goes with its title', async () => {
    await repo.saveStory({ titleId: 'tv-247718', season: 1, episode: 2, text: 'First.', origin: 'dialogue', model: 'haiku', writtenAt: T0 });
    await repo.saveStory({ titleId: 'tv-247718', season: 1, episode: 2, text: 'Second.', origin: 'web', model: 'sonnet', writtenAt: T1, sources: [{ url: 'https://x.example/r', title: 'Recap', site: 'X' }] });
    expect(await repo.story('tv-247718', 1, 2)).toMatchObject({ text: 'Second.', origin: 'web', model: 'sonnet', writtenAt: T1, sources: [{ site: 'X' }] });
    await db.execute(sql`delete from movie_titles where id = 'tv-247718'`);
    expect(await repo.story('tv-247718', 1, 2)).toBeNull();
  });

  it('refuses an unknown title, origin or slot', async () => {
    expect(await pgCode(repo.saveStory({ titleId: 'tv-1', season: 1, episode: 1, text: 'x', origin: 'web', model: null, writtenAt: T0 }))).toBe('23503');
    expect(await pgCode(db.execute(sql`insert into movie_stories (title_id, season, episode, text, origin, written_at) values ('tv-247718', 1, 1, 'x', 'guess', now())`))).toBe('23514');
    expect(await pgCode(db.execute(sql`insert into movie_stories (title_id, season, episode, text, origin, written_at) values ('tv-247718', -1, 1, 'x', 'web', now())`))).toBe('23514');
  });
});
```

**File:** `tests/integration/movies.api.int.test.ts:341-344`. Replace:
```ts
    // A subtitle read again keeps the story that was written.
    await seedDialogue();
    expect((await here.repo.dialogue('tv-247718', 1, 2))?.story).toBe(first.story.text);
    expect(await here.repo.storySlots('tv-247718')).toEqual([{ season: 1, episode: 2 }]);
```
with:
```ts
    // The story lives in movie_stories: a subtitle read again leaves it alone, and the dialogue row holds none.
    await seedDialogue();
    expect(await here.repo.story('tv-247718', 1, 2)).toMatchObject({ text: first.story.text, origin: 'dialogue', model: 'test-model' });
    expect((await here.repo.dialogue('tv-247718', 1, 2))?.story).toBeNull();
    expect(await here.repo.storySlots('tv-247718')).toEqual([{ season: 1, episode: 2 }]);
```

**File:** `tests/integration/migration0043.int.test.ts` (new)
```ts
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../src/db/client.js';
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js';

/**
 * Migration 0043 on a 0042-shaped database that already holds stories on dialogue rows and a torrent: the stories are
 * copied into movie_stories (origin dialogue), the dialogue rows are left as they were, the torrent has no kept mark,
 * and the download queue is empty. Runs in its own database inside the Docker container.
 */

const DB_PREFIX = 'mcp_notes_mig0043_';
const HASH = '0123456789abcdef0123456789abcdef01234567';

type Journal = { entries: Array<{ idx: number; tag: string }> } & Record<string, unknown>;

function urlForDatabase(name: string): string {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
}

async function dropStaleDatabases(admin: Db): Promise<void> {
  const res = await admin.execute<{ datname: string }>(sql`select datname from pg_database where starts_with(datname, ${DB_PREFIX})`);
  for (const row of res.rows) await admin.execute(sql.raw(`drop database if exists "${row.datname}" with (force)`));
}

/** A migrations folder holding the journal entries with idx <= maxIdx. */
async function migrationsUpTo(maxIdx: number): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `mcp-notes-mig0043-${maxIdx}-`));
  await mkdir(path.join(dir, 'meta'));
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((e) => e.idx <= maxIdx);
  if (kept.length !== maxIdx + 1) throw new Error(`drizzle/meta/_journal.json lacks entries 0..${maxIdx}`);
  if (maxIdx >= 43 && kept[43]?.tag !== '0043_stream_downloads_stories') throw new Error('journal entry 43 is not 0043_stream_downloads_stories');
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

describe('migration 0043 (the download queue, the kept mark, the story store)', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`;
  let admin: Db;
  let mig: Db;
  const dirs: string[] = [];
  let dialoguesBefore: unknown[];

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl());
    await dropStaleDatabases(admin);
    await admin.execute(sql.raw(`create database "${dbName}"`));
    mig = createDb(urlForDatabase(dbName));

    const upTo42 = await migrationsUpTo(42);
    dirs.push(upTo42);
    await migrate(mig, { migrationsFolder: upTo42 });

    await mig.execute(sql`insert into movie_titles (id, kind, tmdb_id, title, original_title) values
      ('tv-247718', 'tv', 247718, 'MobLand', 'MobLand'), ('movie-550', 'movie', 550, 'Fight Club', 'Fight Club')`);
    await mig.execute(sql`insert into movie_dialogues
      (title_id, season, episode, provider, cues, last_cue_s, body, fetched_at, story, story_model, story_at) values
      ('tv-247718', 1, 2, 'VidNest', 2, 70, 'Who are you?', '2026-11-16T05:00:00Z', 'He fixes it.', 'sonnet', '2026-11-16T06:00:00Z'),
      ('tv-247718', 1, 3, 'VidNest', 2, 70, 'Nothing yet.', '2026-11-16T05:00:00Z', null, null, null),
      ('movie-550', 0, 0, 'VidFast', 3, 90, 'First rule.', '2026-11-16T05:00:00Z', 'A film.', null, null)`);
    await mig.execute(sql`insert into stream_torrents (host, info_hash, kind, tmdb_id, name) values ('host-a', ${HASH}, 'movie', 550, 'Fixture')`);
    dialoguesBefore = (await mig.execute(sql`select to_jsonb(d) as j from movie_dialogues d order by title_id, season, episode`)).rows;

    const upTo43 = await migrationsUpTo(43);
    dirs.push(upTo43);
    await migrate(mig, { migrationsFolder: upTo43 });
  });

  afterAll(async () => {
    if (mig) await closeDb(mig);
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`));
      await closeDb(admin);
    }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('applies exactly one migration on top of 0000-0042', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(res.rows[0]?.n).toBe(44);
  });

  it('copies every story written on a dialogue row into movie_stories, origin dialogue', async () => {
    const res = await mig.execute<{ title_id: string; season: number; episode: number; text: string; origin: string; model: string | null; written_at: Date; sections: unknown; sources: unknown }>(
      sql`select title_id, season, episode, text, origin, model, written_at, sections, sources from movie_stories order by title_id, season, episode`,
    );
    expect(res.rows).toEqual([
      { title_id: 'movie-550', season: 0, episode: 0, text: 'A film.', origin: 'dialogue', model: null, written_at: new Date('2026-11-16T05:00:00Z'), sections: [], sources: [] },
      { title_id: 'tv-247718', season: 1, episode: 2, text: 'He fixes it.', origin: 'dialogue', model: 'sonnet', written_at: new Date('2026-11-16T06:00:00Z'), sections: [], sources: [] },
    ]);
  });

  it('leaves the dialogue rows as they were', async () => {
    const after = await mig.execute(sql`select to_jsonb(d) as j from movie_dialogues d order by title_id, season, episode`);
    expect(after.rows).toEqual(dialoguesBefore);
  });

  it('gives an existing torrent no kept mark', async () => {
    const res = await mig.execute<{ kept_at: Date | null }>(sql`select kept_at from stream_torrents`);
    expect(res.rows).toEqual([{ kept_at: null }]);
  });

  it('starts an empty download queue that holds one open row per slot and host', async () => {
    expect((await mig.execute<{ n: number }>(sql`select count(*)::int as n from stream_downloads`)).rows[0]?.n).toBe(0);
    await mig.execute(sql`insert into stream_downloads (host, kind, tmdb_id) values ('host-a', 'movie', 550)`);
    await expect(mig.execute(sql`insert into stream_downloads (host, kind, tmdb_id) values ('host-a', 'movie', 550)`)).rejects.toThrow();
  });
});
```

**File:** `tests/integration/sharedImport.int.test.ts`, insert after the test that ends at line 232
```ts
  it('brings a story the shared side kept on a dialogue row into movie_stories', async () => {
    await title(shared, 'tv-2')
    await run(
      shared,
      `insert into movie_dialogues (title_id, season, episode, provider, cues, last_cue_s, body, fetched_at, story, story_model, story_at)
       values ('tv-2', 1, 1, 'VidNest', 1, 5, 'Hi.', '2026-01-04T10:00:00Z', 'The pilot.', 'sonnet', '2026-01-04T11:00:00Z'),
              ('tv-2', 1, 2, 'VidNest', 1, 5, 'Bye.', '2026-01-04T10:00:00Z', null, null, null)`,
    )
    await stageSharedImport(shared, local)
    const written = await mergeStagedImport(local)
    expect(written.movie_stories).toBe(1)
    expect(await rows(local, `select title_id, season, episode, text, origin, model from movie_stories`)).toEqual([
      { title_id: 'tv-2', season: 1, episode: 1, text: 'The pilot.', origin: 'dialogue', model: 'sonnet' },
    ])
  })
```

### Step 14: The feature map's seeding hint
**File:** `.claude/skills/verify-notesd/features/movies.md:48-49`
**Change:** the instruction "seed a dialogue row with a story through `$V exec`" no longer opens a story. Replace lines 48-49:
```
  throwaway daemon never writes one (`NOTESD_MOVIES_STORY_MODEL=off` is pinned): seed a dialogue row
  with a story through `$V exec` and open it on the page. Proof:
```
with:
```
  throwaway daemon never writes one (`NOTESD_MOVIES_STORY_MODEL=off` is pinned): seed a `movie_stories`
  row (origin `dialogue`) through `$V exec` and open it on the page. Proof:
```
**Impact:** text only. Phase 9 rewrites the entry for the web-first and season stories.

## Principles applied

- Make illegal states unrepresentable: what a download fetches from is the union `DownloadOn` (`torrent`+info hash, or `cloud`+cache id), never two loose strings. `stream_downloads` CHECKs refuse a picked hash without `via = 'torrent'`, a half-set source, a torrent source that is not 40 hex, a done row without a source, and failed without an error. Only one row per slot and host can be open (partial unique index). `setState` takes only `queued|running|paused`, so `done`/`failed` go through their own writers.
- Build the lever: one behavior suite (`downloadRecordsContract`) runs against Postgres and against `MemoryDownloadRecords`. Phase 2 tests its engine on the fake, and the fake cannot drift from the real repository unnoticed.
- Test behavior, not implementation: the tests assert rows read back (and, for stories, "no model call, no dialogue read" on a stored story), never private calls. The migration test checks the copied rows on a real 0042 database.
- Subtract before you add: `saveStory` and `storySlots` are rewritten in place onto `movie_stories`, not kept beside new ones. The only writer of `movie_dialogues.story` is gone, so the old columns are dead in code and stay only as data.
- Laziness protocol: no claim-by-via filter, no batch index and no `StoryView` change. `setKept` is per torrent, as the index asks. `MovieStories`/`read.ts` get only the edit that keeps stories readable.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit: the contract on the fake, `downloadOn`/`downloadRef`, `story.test.ts`); `npm run test:int` (the contract on Postgres, the CHECKs, `setKept`, `movie_stories`, migration 0043, the shared-import merge, the story route test)
**Proof:**
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`), plus the integration suite for the repo's own behavior. This phase exposes no route.
- Feature-map entries: `features/movies.md` (the story bullet; Step 14 fixes its seeding hint)
- Journeys:
  - **J1** · traces R1.7 — `npm run test:int -- tests/integration/directStream.downloads.int.test.ts -t "carries on at a daemon start"` → passes when that one Postgres test passes: `toResume('host-a')` answers the queued, running and paused rows of host-a, oldest first, all `queued`, the running one still with `source: 'torrent'`, `sourceId` its hash, `bytesDone: 700` and `bytesTotal: 1000`; the done and failed rows and host-b's running row are unchanged
  - **J2** · traces R1.7 — `$V up` (prints `RUN`); `$V sql RUN "select to_regclass('stream_downloads') as t, (select count(*) from information_schema.columns where table_name='stream_torrents' and column_name='kept_at') as kept"`; `$V exec RUN "insert into stream_downloads (host, kind, tmdb_id, via, state, source, source_id, bytes_done, bytes_total, started_at) values ('$(hostname)', 'movie', 550, 'torrent', 'running', 'torrent', '0123456789abcdef0123456789abcdef01234567', 1048576, 4194304, now())"`; `$V restart RUN --gap 2`; `$V doctor RUN`; `$V sql RUN "select host, state, source_id, bytes_done, bytes_total from stream_downloads"`; `$V down RUN` → passes when the first `sql` shows `t = stream_downloads` and `kept = 1` (the daemon applied 0043 at start), `doctor` is OK after the restart, and the last `sql` shows the one row for this host still `running` with `bytes_done 1048576`, `bytes_total 4194304` and the same `source_id`, which is what phase 2's `start()` carries on from
  - **J3** · traces R6.5 — `$V up --movies`; `$V api RUN POST /api/movies/ensure '{"kind":"tv","tmdb_id":247718}'`; `$V exec RUN "insert into movie_stories (title_id, season, episode, text, origin, model, written_at) values ('tv-247718', 1, 2, 'Stored before: he fixes it.', 'dialogue', 'sonnet', now())"`; `$V api RUN POST /api/movies/tv-247718/story '{"season":1,"episode":2}'`; `$V api RUN GET /api/movies/tv-247718`; `$V down RUN` → passes when the POST answers 200 with `"cached":true` and `"text":"Stored before: he fixes it."`. The run pins `NOTESD_MOVIES_STORY_MODEL=off`, so any path that called a model would answer 503 `story_off`. The title detail shows `has_story: true` on S01E02 only
  - **J4** · traces R6.5 — `npm run test:int -- tests/integration/migration0043.int.test.ts tests/integration/movies.api.int.test.ts tests/integration/sharedImport.int.test.ts -t "migration 0043|the story of an episode|brings a story"` → passes when the stories written on 0042 dialogue rows are in `movie_stories` (origin `dialogue`, model and time kept, dialogue rows unchanged), a story written through `POST` is answered `cached: true` on the second `POST` with the writer called once, and a Neon dialogue's story arrives in `movie_stories` at the merge
- Neighbor check: the torrent side that now reads `StreamTorrentRow.keptAt` through its fake. `npx vitest run tests/unit/directStream/torrent tests/unit/directStream/cacheShelf.test.ts tests/unit/movies/story.test.ts` → all pass (`MemoryTorrentRecords` still satisfies `TorrentRecords`, and prune/budget/shelf behaviour is unchanged)
- Cost: none (no model call; J3 runs with stories off)

**Exit criteria:** migration 0043 applies on a fresh database (`$V up`, `test:int` global setup) and on a populated 0042 database (J4); `DownloadsRepo`, `TorrentsRepo.setKept` and `MoviesRepo.story/saveStory/storySlots` pass their unit and integration tests; `npm run typecheck`, `npm test` and `npm run test:int` pass; a stored story (copied or seeded) is served by `GET`/`POST /api/movies/:id/story` without a model (J3).

## Handoffs

- **Phase 2:** build `StreamDownloads` on `DownloadRecords`, and test with `MemoryDownloadRecords` (`tests/helpers/memoryDownloadRecords.ts`). Call `toResume(host, now)` in `start()`: the rows come back `queued` with `source`/`sourceId`/`bytes*` kept, so a torrent can reopen its own folder. That half of R1.7 (actually carrying on from disk) is phase 2's to prove. The prune exemption reads `row.keptAt` from the rows `TorrentStreams` already loads, and the kept mark is written with `repo.setKept` (now in `TorrentRecords`). Cancelling is `cancel` (error `cancelled`). A deletion on the Cache page is `deleteSlot(host, ref)`.
- **Phase 3:** a season click is one `create` per episode with the same `batch` uuid (`randomUUID()`); the table has no batch-level row. `list` and `claimNext` order by `created_at`, then `season`, `episode`, `id` (reconciler: phase 3's rows a pack lacks must run in episode order, and a season's rows can share one `created_at`).
- **Phase 4:** the route's integration test is `tests/integration/streamDownloads.routes.int.test.ts`; this phase owns `tests/integration/directStream.downloads.int.test.ts` (the contract on Postgres). `truncateAll` empties `stream_downloads` from this phase on.
- **Phase 4:** check the `:id` path parameter is a uuid before calling `get`/`cancel`/`delete` (Postgres rejects a non-uuid with 22P02; the repo trusts its caller). `?title=` maps to `{kind, tmdbId}` for `list`. The repo answers only this host's rows; a row of the other machine with `available: false` must be read by the route itself. `progress` from 0 to 1 is computed from `bytesDone/bytesTotal` or the live engine (phase 2).
- **Phase 6:** `MoviesRepo.saveStory(row: NewMovieStory)` takes `sections`, `sources`, `origin`. `StoryView` still has `provider: string` and `cues: number`, filled with `''`/`0` when a story has no dialogue row; phase 6 owns making them nullable and adding `origin`/`sources`/`sections`. Per-season `has_story` reads `(s, 0)` rows. Note that for a series `(0, 0)` would be the story of its specials season and would read as the title's `has_story` in `read.ts`; decide whether a season-0 story is written at all. `StoredDialogue.story` in `src/directStream/dialogueStore.ts` is now never set from a written story (no reader uses it); remove it with the rest of the dialogue route's changes.
- **Phase 9:** `docs/guide/architecture.md` (writers table line 72, data-model row line 96: `stream_downloads`/`DownloadsRepo`, `movie_stories`/`MoviesRepo`, `stream_torrents.kept_at`), `docs/guide/movies.md:94` ("Dialogue and story" row: stories now in `movie_stories`), `docs/guide/streaming.md:1599` ("It is kept, in `movie_dialogues`"), and the `CLAUDE.md` single-writer list.

## Rollback

Revert this phase's commit. A database that already applied 0043 keeps two unused tables and one nullable column, which the reverted code ignores. Drop them with a follow-up migration (`DROP TABLE stream_downloads; DROP TABLE movie_stories; ALTER TABLE stream_torrents DROP COLUMN kept_at;`). Nothing is lost: `movie_dialogues.story|story_model|story_at` were never cleared, and the reverted code reads stories from them again. A story written after 0043 lives only in `movie_stories` and would need writing again.
