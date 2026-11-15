> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/direct-streaming/PLAN.md` phase 5. Source: `.workflows/plan/direct-streaming/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Streams in the movies store: plays, verified sources, state

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R2, R5 — a streamed film writes the same play history and moves watch state like a VLC play (R2.4); a title whose resolve fails is marked stale in the store and drops out of the fresh list the Stream grid reads (R5.4, store half)
**Criteria:** R2.4, R5.4
**Depends on:** Phase 3
**Difficulty:** HARD
**Package:** `src/movies`, `src/db`

---

## Goal

After this phase a stream is a second kind of source in the movies store. The player page's
position reports land on one `movie_plays` row per player session (source `stream`, with the
title, season, episode and provider, no file), and that row moves the title's and the episode's
watch state through `state.ts` exactly as a VLC play does. Every resolve writes a per-host
`movie_stream_sources` row, verified or stale, and the store answers "which titles have a fresh
verified source on this host" for the Stream grid, while a title known only from streams stays
out of the Library grid (invariant 10).

## Interface Contract

The reconciler reads this section to detect cross-phase conflicts.

**Deletes:** nothing. The private `groupState` in `src/movies/read.ts:431` is replaced by `slotState` (same file), whose rule for file-only episodes is unchanged.

**Renames:** none.

**Creates:**
- Table `movie_stream_sources` (`src/db/schema.ts`, migration `drizzle/0021_stream_plays.sql`): pk `(title_id, season, episode, host)`; `provider`, `manifest_kind`, `best_height`, `en_subtitle`, `verified_at`, `stale_at`, `failure`, `updated_at`; a film is season 0, episode 0. Checks `movie_stream_sources_slot_check`, `movie_stream_sources_outcome_check`, `movie_stream_sources_failure_check`; index `movie_stream_sources_host_verified_idx`. Drizzle symbol `movieStreamSources`, row type `MovieStreamSourceRow`.
- Columns on `movie_plays`: `title_id` (FK `movie_titles`, no cascade), `season`, `episode`, `provider`, `stream_session`. **`stream_session` is an addition to the Shared contract**: the player session a stream play belongs to, so "one open row per session" is a unique partial index (`movie_plays_open_session_uniq`) rather than in-memory state. Index `movie_plays_title_started_idx`. Check `movie_plays_target_check` (a file play has a file and no stream columns; a stream play has a title, a provider and a session and no file). Trigger `movie_plays_register_id` (the 0018 `movie_ids_register()` function, so a streamed episode TMDB does not list still gets its movie id).
- `src/movies/types.ts`: `FilePlaySource`, `StreamTarget`, `StreamSlot`, `streamSlot()`, `StreamPositionInput`, `StreamPositionWrite`, `StreamSourceKey`, `StreamSourceOutcome`, re-export `MovieStreamSourceRow`.
- `src/movies/state.ts`: `STREAM_SOURCE`, `streamState()`, `streamResumePosition()`, `SourceSummary`, `streamLeads()`, `episodeState()`.
- `src/movies/repo.ts`: `MoviesRepo.closeOpenStreamPlays`, `.recordStreamPosition`, `.lastStreamPlay`, `.recordStreamSource`, `.freshStreamTitleIds`, `.streamSourcesOfTitle`; module functions `freshStreamSourceSql`, `isFreshStreamSource`, `streamFreshSince`.
- `src/movies/read.ts`: `listStreamTitles(db, filter, ctx, freshSince)` (the function phase 9's `GET /api/movies/stream` calls), `TitleFilter.scope?: 'library' | 'all'`, `PlayView.provider`, **and (reconciler) `StreamSourceView` plus `TitleDetail.stream_sources: StreamSourceView[]`**: this host's (`ctx.host`) verified source rows of the title, film as season 0 episode 0, in season and episode order, `{ host, season, episode, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at }` (ISO strings; a stale-only row that was never verified is left out). Phase 9 adds `fresh` per row in its route with `isFreshStreamSource`; the `GET /api/movies/:id` sentence about `stream_sources` in `scripts/docs/httpRoutes.ts` is this phase's alone.
- `src/movies/streams.ts` (new): `MovieStreams` (`ensureTitle`, `recordResolve`, `resumeS`, `recordPosition`, `closeLeftOpen`), `MovieStreamsSource`, `ResolveRecord`, `StreamSessionRef`, `StreamReading`, `MovieStreamsOptions`, `NO_SOURCE`, `hasEnglishSubtitle`.
- `src/http/directStreamApi.ts`: `streamPositionRoutes(deps, options)`, `StreamPositionDeps`, route `POST /api/stream/sessions/:id/position` (same-origin only).
- MovieEvents reason `'stream'` (a source row appeared, or turned verified or stale).

**Signature changes:**
- `MOVIE_PLAY_SOURCES` `['live','vlc_recents']` -> `['live','vlc_recents','stream']` (so `MoviePlaySource`, `PlaySource` gain `'stream'`).
- `MoviePlayRow.fileId: number` -> `number | null`; the row gains `titleId`, `season`, `episode`, `provider`, `streamSession` (all `| null`).
- `NewPlay.source: PlaySource` -> `FilePlaySource` (a file play can no longer be typed as a stream play).
- `PlayView.file_id: number` -> `number | null`; `PlayView.file_name: string` -> `string | null`; `PlayView.source` gains `'stream'`; new `PlayView.provider: string | null`.
- `MovieChangeReason` gains `'stream'`.
- `listTitles` now leaves out stream-only titles unless `filter.scope === 'all'`. `statusCounts().titles` and `searchHitViews()[].in_library` count Library titles only (same predicate).

**Requires (from earlier phases):** all from Phase 3, which has landed:
1. Migration `0020` exists; this phase generates `0021`.
2. `DirectStreamService.session(id: string)` returns a session or `null` for an unknown or expired id (sync or a Promise; both are accepted). The session has at least `id: string`, `ref: { kind: 'movie' | 'tv'; tmdbId: number; season?: number; episode?: number }` and `source: { provider: string }`. This is structurally `StreamSessionRef`.
3. Phase 3's builder `buildDirectStreamService(config, db, { movies, pageBase, hooks? })` takes `hooks?: DirectStreamHooks` (`recordResolve?(ref: StreamRef, result: ResolveOutput): Promise<void>`, `resumeS?(ref): Promise<number | null>`, `titleLabel?(ref): Promise<string | null>`; optional, so absent means none, never `null`). Phase 3 **awaits** `recordResolve` after every resolve that `resolve()`, `play()` or `refresh()` makes (plays, refreshes and the phase 10 prober), success or failure, before it answers, so a `no_source` answer is already stale in the store when `POST /api/stream/play` returns; `runResolve` alone (phase 8's probes) never calls it. A hook that throws is logged and ignored by phase 3. `result` is phase 3's `ResolveOutput` (`ok`, `source.{provider, manifest_kind, best_height, subtitles[].lang}`, `error`), structurally a `ResolveRecord`; only `error === 'no_source'` marks stale (`deadline`, `no_chrome`, ... say nothing about the title). `resumeS` gives a new session its `resume_s` when the caller passed none.
4. `src/http/directStreamApi.ts` exports `DIRECT_STREAM_OFF` (the 503 body, `{ error: 'direct_stream_off', message }`) and builds its router in `directStreamRoutes(deps)`, whose `deps` include `movies` and `directStream` (add `'movies'` to its `Pick<AppDeps, ...>` if it is not there).
5. `POST /api/stream/sessions/:id/refresh` keeps the session id. (If phase 3 mints a new id, the continuation gets a second play row starting at the resume position; nothing breaks.)
6. `scripts/docs/httpRoutes.ts` has a "Direct streaming" group and `.claude/skills/verify-notesd/features/direct-streaming.md` exists.

**Leaves alone (owned by others):** `web/*` (phases 4, 9), `src/mcp/*` and tool text (phases 7, 8), `GET /api/movies/stream` and the title page's stream block (phase 9), `src/directStream/*` (phase 3: this phase does not edit `service.ts`; it implements the hooks in `src/movies/streams.ts` and passes them in `src/daemon.ts`), `src/movies/continue.ts` and `src/movies/player.ts` (read, unchanged), `claude/streaming/direct/*`.

**Readers of `movie_plays` / `movie_files` checked for the nullable `file_id`:**

| Site | Change |
| --- | --- |
| `src/movies/repo.ts:87` `finishEventsSql` | adds a stream-play branch (history "finished" agrees with `streamState`) |
| `src/movies/repo.ts:499` `closeOpenPlays`, `:509` `recentLivePlays`, `:520` `reopenPlay`, `:530` `startPlay`, `:549` `updatePlay`, `:559` `endPlay`, `:576` `recordObservation`, `:605` `lastPlay`, `:616` `latestPlay` | unchanged: each filters on `source = 'live'`, on a file id, or inner-joins `movie_files`, so stream rows never reach them |
| `src/movies/read.ts:405` `lastPlays` | unchanged (filters `file_id in (...)`) |
| `src/movies/read.ts:448` `loadParts` | adds the last stream play per streamed film or episode |
| `src/movies/read.ts:795` `history` | left-joins the file; title, season, episode from the file or the play; `provider` |
| `src/movies/read.ts:637` `listTitles`, `:887` `statusCounts`, `:905` `searchHitViews` | Library predicate (invariant 10) |
| `src/movies/continue.ts:218,231,246` | unchanged: inner joins and `file_id in (...)` ignore stream plays; `lastBy` becomes `Map<number \| null, PlayRow>` and still compiles. Continue stays file-only (Handoffs) |
| `src/movies/player.ts:87,250,409` | unchanged (file plays only) |
| `src/movies/vlc/recents.ts:164,207` | unchanged (`lastPlay(fileId)`) |
| `src/mcp/movieTools.ts:186,461,588` | unchanged (not this phase's): the values pass through; `history` rows gain `provider`; see Handoffs |
| `drizzle/0018_movie_ids.sql` `movie_ids_register()` | reused by a new trigger on `movie_plays` (its generic branch reads `title_id`, `season`, `episode`; a file play has `title_id` null, so it is a no-op there). Not attached to `movie_stream_sources`, whose film rows are season 0 episode 0 |
| `tests/fixtures/movies/rows.ts:40` `playRow` | the five new columns, null |

## Files

| File | Action | What changes |
|---|---|---|
| `src/db/schema.ts` | modify | `MOVIE_PLAY_SOURCES`, `moviePlays` columns/indexes/checks, new `movieStreamSources`, row type |
| `drizzle/0021_stream_plays.sql`, `drizzle/meta/0021_snapshot.json`, `drizzle/meta/_journal.json` | create/modify | generated by drizzle-kit, plus the trigger appended by hand |
| `src/movies/types.ts` | modify | stream types, `streamSlot`, `FilePlaySource` |
| `src/movies/state.ts` | modify | the stream pseudo-source rule, `episodeState`, `streamLeads` |
| `src/movies/repo.ts` | modify | stream play and stream source writes and reads, the freshness rule, finish events |
| `src/movies/read.ts` | modify | stream plays in title state, episodes, history; invariant 10; `listStreamTitles`; `TitleDetail.stream_sources` (reconciler) |
| `src/movies/service.ts` | modify | `MovieChangeReason` gains `'stream'` |
| `src/movies/streams.ts` | create | `MovieStreams`: the hooks, the position recorder |
| `src/http/directStreamApi.ts` | modify | `streamPositionRoutes` and its mount line (phase 3's file) |
| `src/daemon.ts` | modify | build `MovieStreams`, close left-open stream plays, pass the hooks to phase 3's builder |
| `tests/fixtures/movies/rows.ts` | modify | `playRow` gains the new columns |
| `tests/unit/movies/state.test.ts` | modify | stream rule cases |
| `tests/unit/movies/types.test.ts` | modify | `streamSlot` cases |
| `tests/integration/movies.streams.int.test.ts` | create | the route, plays, state, history, sources, freshness, invariant 10, schema |
| `scripts/docs/httpRoutes.ts` | modify | the position route; the `stream_sources` sentence of `GET /api/movies/:id` (this phase's alone) |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `docs/guide/movies.md` | modify | "What is stored", "Watch state", "Two machines", "Where the code is" |
| `docs/guide/architecture.md` | modify | Movies data model row |
| `.claude/skills/verify-notesd/features/movies.md` | modify | State sub-feature: streams |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify | new "Stream plays and verified sources" entry (phase 3 creates the file) |

## Implementation Steps

Line numbers are those of `d996abb`. Phase 3 lands first and appends its own tables to
`src/db/schema.ts` and its wiring to `src/daemon.ts`; find the quoted anchors rather than trusting
the numbers there.

### Step 1: Schema: stream plays and stream sources
**File:** `src/db/schema.ts:970` (`MOVIE_PLAY_SOURCES`), `:1192-1218` (`moviePlays`), after `:1218` (new table), `:1255` (row types)
**Change:** widen the play source set; make `file_id` nullable and add the stream columns with a check that keeps the two kinds apart; add `movie_stream_sources`.
**Code:** replace line 970-971:
```ts
export const MOVIE_PLAY_SOURCES = ['live', 'vlc_recents', 'stream'] as const
export type MoviePlaySource = (typeof MOVIE_PLAY_SOURCES)[number]
```
Replace the whole `moviePlays` definition (the doc comment at 1192 through 1218) with:
```ts
/**
 * One play event (migration 0017; streams 0021). A file play: a VLC that notesd started (`live`,
 * updated while it plays, closed with `ended_at`), or one entry of VLC's recent list
 * (`vlc_recents`, one row per distinct position seen). A stream play (`stream`, direct streaming):
 * the daemon's player page, one row per player session (`stream_session`), updated by its position
 * reports. A file play has `file_id` and none of `title_id`, `season`, `episode`, `provider`,
 * `stream_session`; a stream play has `title_id`, `provider` and `stream_session` and no file
 * (`movie_plays_target_check`). A film's stream play has season and episode null. `position_s` null
 * means "opened, position unknown". Never deleted.
 */
export const moviePlays = pgTable(
  'movie_plays',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** The file played; null on a stream play. */
    fileId: bigint('file_id', { mode: 'number' }).references(() => movieFiles.id, { onDelete: 'cascade' }),
    /** A stream play's title; null on a file play, whose title is its file's. */
    titleId: text('title_id').references(() => movieTitles.id),
    /** A stream play's episode; both null for a film and on every file play. */
    season: integer('season'),
    episode: integer('episode'),
    /** The direct-stream provider that served a stream play (`VidFast`). */
    provider: text('provider'),
    /** The player session of a stream play: at most one open row per session. */
    streamSession: text('stream_session'),
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
    index('movie_plays_title_started_idx').on(t.titleId, t.startedAt.desc()).where(sql`${t.titleId} is not null`),
    // MoviesRepo.recordStreamPosition's ON CONFLICT names this predicate word for word.
    uniqueIndex('movie_plays_open_session_uniq').on(t.streamSession).where(sql`${t.endedAt} is null and ${t.streamSession} is not null`),
    check('movie_plays_source_check', sql`${t.source} in ('live', 'vlc_recents', 'stream')`),
    check(
      'movie_plays_target_check',
      sql`(${t.source} = 'stream' and ${t.fileId} is null and ${t.titleId} is not null and ${t.provider} is not null and ${t.streamSession} is not null and (${t.season} is null) = (${t.episode} is null))
        or (${t.source} <> 'stream' and ${t.fileId} is not null and ${t.titleId} is null and ${t.season} is null and ${t.episode} is null and ${t.provider} is null and ${t.streamSession} is null)`,
    ),
  ],
)

/**
 * What resolving a film or an episode on one host last gave (migration 0021, direct streaming).
 * One row per (title, season, episode, host); a film is season 0, episode 0 (a primary key holds
 * no null), an episode its own numbers. Written by MoviesRepo.recordStreamSource after every
 * resolve: a success sets the provider, manifest kind, best height and English-subtitle flag,
 * `verified_at`, and clears `stale_at`; a resolve that found no source sets `stale_at` and
 * `failure` and keeps the last verified columns. A row with no verification yet is stale-only.
 * "Fresh" (the Stream grid) is repo.ts `freshStreamSourceSql`.
 */
export const movieStreamSources = pgTable(
  'movie_stream_sources',
  {
    titleId: text('title_id')
      .notNull()
      .references(() => movieTitles.id, { onDelete: 'cascade' }),
    season: integer('season').notNull(),
    episode: integer('episode').notNull(),
    host: text('host').notNull(),
    provider: text('provider'),
    /** `hls`, `dash`, `mp4`: as the resolver reported it. Not a CHECK: a new kind needs no migration. */
    manifestKind: text('manifest_kind'),
    bestHeight: integer('best_height'),
    enSubtitle: boolean('en_subtitle').notNull().default(false),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    staleAt: timestamp('stale_at', { withTimezone: true, mode: 'date' }),
    /** The resolve error that made the row stale (`no_source`); null while it is not stale. */
    failure: text('failure'),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.titleId, t.season, t.episode, t.host] }),
    index('movie_stream_sources_host_verified_idx').on(t.host, t.verifiedAt.desc()),
    check('movie_stream_sources_slot_check', sql`${t.season} >= 0 and ${t.episode} >= 0 and (${t.episode} > 0 or ${t.season} = 0)`),
    check(
      'movie_stream_sources_outcome_check',
      sql`(${t.verifiedAt} is not null and ${t.provider} is not null and ${t.manifestKind} is not null)
        or (${t.verifiedAt} is null and ${t.staleAt} is not null and ${t.provider} is null and ${t.manifestKind} is null and ${t.bestHeight} is null)`,
    ),
    check('movie_stream_sources_failure_check', sql`(${t.staleAt} is null) = (${t.failure} is null)`),
  ],
)
```
Append to the row types at the end of the file (after `export type MoviePlayRow = ...`):
```ts
export type MovieStreamSourceRow = typeof movieStreamSources.$inferSelect
```
**Impact:** `MoviePlayRow.fileId` becomes `number | null` and the row type gains five columns. `npm run typecheck` fails until Steps 3 to 6 and Step 11 land; do Steps 1-6 and 11 before the first typecheck.

### Step 2: Migration 0021
**File:** `drizzle/0021_stream_plays.sql` (new), `drizzle/meta/0021_snapshot.json`, `drizzle/meta/_journal.json`
**Change:** generate from the schema, then append the trigger, which drizzle-kit does not model (as `0018` did).
**Code:** generate (drizzle-kit only reads the URL's host to pick the direct one; it does not connect):
```sh
cd /home/miftah/.worktrees/mcp-notes/direct-streaming
DATABASE_URL_UNPOOLED=postgres://u:p@127.0.0.1:5432/x npx drizzle-kit generate --name stream_plays
```
The generated file must hold these statements (drizzle-kit's order may differ; the check bodies are
rendered with `"movie_plays".`/`"movie_stream_sources".` column prefixes):
```sql
CREATE TABLE "movie_stream_sources" (
	"title_id" text NOT NULL,
	"season" integer NOT NULL,
	"episode" integer NOT NULL,
	"host" text NOT NULL,
	"provider" text,
	"manifest_kind" text,
	"best_height" integer,
	"en_subtitle" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"failure" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "movie_stream_sources_title_id_season_episode_host_pk" PRIMARY KEY("title_id","season","episode","host"),
	CONSTRAINT "movie_stream_sources_slot_check" CHECK (...),
	CONSTRAINT "movie_stream_sources_outcome_check" CHECK (...),
	CONSTRAINT "movie_stream_sources_failure_check" CHECK (...)
);
ALTER TABLE "movie_plays" DROP CONSTRAINT "movie_plays_source_check";
ALTER TABLE "movie_plays" ALTER COLUMN "file_id" DROP NOT NULL;
ALTER TABLE "movie_plays" ADD COLUMN "title_id" text;
ALTER TABLE "movie_plays" ADD COLUMN "season" integer;
ALTER TABLE "movie_plays" ADD COLUMN "episode" integer;
ALTER TABLE "movie_plays" ADD COLUMN "provider" text;
ALTER TABLE "movie_plays" ADD COLUMN "stream_session" text;
ALTER TABLE "movie_stream_sources" ADD CONSTRAINT "movie_stream_sources_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "movie_stream_sources_host_verified_idx" ON "movie_stream_sources" USING btree ("host","verified_at" DESC NULLS LAST);
ALTER TABLE "movie_plays" ADD CONSTRAINT "movie_plays_title_id_movie_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."movie_titles"("id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "movie_plays_title_started_idx" ON "movie_plays" USING btree ("title_id","started_at" DESC NULLS LAST) WHERE "movie_plays"."title_id" is not null;
CREATE UNIQUE INDEX "movie_plays_open_session_uniq" ON "movie_plays" USING btree ("stream_session") WHERE "movie_plays"."ended_at" is null and "movie_plays"."stream_session" is not null;
ALTER TABLE "movie_plays" ADD CONSTRAINT "movie_plays_source_check" CHECK ("movie_plays"."source" in ('live', 'vlc_recents', 'stream'));
ALTER TABLE "movie_plays" ADD CONSTRAINT "movie_plays_target_check" CHECK (...);
```
Then append by hand at the end of `drizzle/0021_stream_plays.sql`:
```sql
--> statement-breakpoint
-- A streamed episode gets its movie id like a file's episode does (0018's movie_ids_register, generic
-- branch). A file play has title_id null, so the trigger does nothing for it. Not on
-- movie_stream_sources: its film rows are season 0, episode 0, which is not an episode.
CREATE TRIGGER "movie_plays_register_id" AFTER INSERT ON "movie_plays" FOR EACH ROW EXECUTE FUNCTION movie_ids_register();
```
Existing rows satisfy the new checks: every row is `live` or `vlc_recents` with a `file_id` and the new columns null.
**Impact:** `npm run test:int` migrates the test database with it; `verify.sh up` applies it to each run's database.

### Step 3: Types: the stream vocabulary
**File:** `src/movies/types.ts:1-11` (imports), `:20` (re-exports), `:158-167` (`NewPlay`), append after `:223`
**Change:** narrow `NewPlay.source`; add the target, slot and write shapes.
**Code:** in the import list at lines 1-11 add `MovieStreamSourceRow,` (alphabetical, after `MoviePlaySource,`). Replace line 20:
```ts
export type { MovieFileRow, MoviePlayRow, MovieStreamSourceRow, MovieTitleRow } from '../db/schema.js';
```
After line 26 (`export type PlaySource = MoviePlaySource;`) add:
```ts
/** A file play's source. A `stream` play has no file (MoviesRepo.recordStreamPosition writes it). */
export type FilePlaySource = Exclude<PlaySource, 'stream'>;
```
Replace `NewPlay` (158-167):
```ts
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
```
Append at the end of the file:
```ts
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
```
**Impact:** `src/movies/player.ts` passes `source: 'live'` to `startPlay`, which still type-checks.

### Step 4: state.ts: a stream is one more copy
**File:** `src/movies/state.ts:1-9` (header), append after `:74`
**Change:** write the stream rule next to the file rule, reusing `fileState` and `resumePosition` for the pseudo-source.
**Code:** replace lines 1-9:
```ts
import type { FileStateInput, PlayStateInput, TitleKind, WatchState } from './types.js';

/**
 * Watch state, derived at read time from a file row and its last play (MOVIES_LIBRARY_PLAN
 * R3.4), and from a film's or an episode's stream plays (direct streaming). "Last play" is
 * `MoviesRepo.lastPlay` (or, for a stream, `MoviesRepo.lastStreamPlay`): the newest play whose
 * position is known, else the newest play (whose position is then unknown). The same "reached the
 * end" rule is written in SQL in src/movies/repo.ts (`finishEventsSql`, with a stream branch);
 * tests/integration/movies.repo.int.test.ts and movies.streams.int.test.ts prove they agree.
 */
```
Append at the end of the file:
```ts
/**
 * A streamed film or episode has one stream pseudo-source: a "file" that is never deleted, never
 * flagged and has no duration of its own (only the player's reading counts), whose last play is
 * its last stream play. Streams are never deleted, so the pseudo-source is finished, in_progress
 * or unwatched.
 */
export const STREAM_SOURCE: FileStateInput = { deletedAt: null, doneAt: null, watchedAt: null, durationS: null };

/** The state of a streamed film or episode, from its last stream play. */
export function streamState(lastPlay: PlayStateInput): WatchState {
  return fileState(STREAM_SOURCE, lastPlay);
}

/** Where the stream player resumes a film or an episode: its last stream play's position, 0 when none or finished. */
export function streamResumePosition(lastPlay: PlayStateInput | null): number {
  return resumePosition(STREAM_SOURCE, lastPlay);
}

/** One source of a film or an episode, as the slot rules read it: its state and when it was last played (ISO, null: never). */
export interface SourceSummary {
  state: WatchState;
  playedAt: string | null;
}

function playedMs(at: string | null): number {
  return at === null ? Number.NEGATIVE_INFINITY : Date.parse(at);
}

/** The stream decides a slot (its state, unless something is finished, and its progress) when it was played after the primary copy, or there is no copy. */
export function streamLeads(primary: SourceSummary | null, stream: SourceSummary | null): boolean {
  if (stream === null) return false;
  if (primary === null) return true;
  return playedMs(stream.playedAt) > playedMs(primary.playedAt);
}

/**
 * One episode from its file copies and its stream. Copies: finished when any copy is, else the
 * primary copy's state (read.ts `primaryFile`: present here first, then the newest play). The
 * stream joins as one more copy: finished when it is; otherwise it decides when it leads
 * (`streamLeads`). With no stream this is exactly the file-only rule.
 */
export function episodeState(anyCopyFinished: boolean, primary: SourceSummary | null, stream: SourceSummary | null): WatchState {
  if (anyCopyFinished || stream?.state === 'finished') return 'finished';
  if (stream !== null && streamLeads(primary, stream)) return stream.state;
  return primary?.state ?? 'unwatched';
}
```
A film keeps `titleState('movie', ...)`: read.ts adds the stream's state to the list of its files' states, so the precedence order (`finished`, `in_progress`, ...) applies to it as to any copy. A series keeps `titleState('tv', episodeStates)`.
**Impact:** none on existing callers; the rule for file-only titles is unchanged.

### Step 5: repo.ts: stream writes, stream reads, the freshness rule
**File:** `src/movies/repo.ts:1-35` (imports), `:87-101` (`finishEventsSql`), insert the new section after `latestPlay` (`:625`) and before `// ---------- history (R3.8) ----------`, add the module functions after `likePattern` (`:63`)
**Change:** the only writer gains stream play and stream source writes; the freshness rule lives here in its SQL and JS forms.
**Code:** replace the imports at lines 1-35:
```ts
import { and, asc, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client.js';
import {
  movieCompanies,
  movieCredits,
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
```
After `likePattern` (line 63) add:
```ts
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
```
Replace `finishEventsSql` (lines 81-101, doc comment included):
```ts
/**
 * Every moment a title or one of its files became finished, as (title_id, at): the title's manual
 * flag, a file's manual flag, a file's done signal, every file play that reached FINISHED_RATIO of
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
```
Insert after `latestPlay` (after line 625):
```ts
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
```
Also update the class doc comment (line 103-107) to:
```ts
/**
 * The only writer of the `movie_*` tables (MOVIES_LIBRARY_PLAN invariant 2): the sync pass,
 * routes, MCP tools, the player and the direct-stream recorder (src/movies/streams.ts) all write
 * through it. It also holds the reads those callers share. Titles are never deleted, files only
 * soft-deleted, plays never deleted.
 */
```
**Impact:** `MoviesRepo` gains six methods; no existing method changes behavior. `.for('update')` on the select locks the row so two resolves of one target serialize their before/after.

### Step 6: read.ts: stream plays in state, episodes, history; invariant 10; the Stream list
**File:** `src/movies/read.ts` (anchors below)
**Change:** see each block.
**Code:**

Replace the imports at lines 1-19:
```ts
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
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
import { freshStreamSourceSql } from './repo.js';
import { reviewText } from './reviewNote.js';
import { FINISHED_RATIO, episodeState, fileState, resumePosition, streamLeads, streamState, titleState, type SourceSummary } from './state.js';
import { posterUrl, type TmdbSearchHit } from './tmdb.js';
import { titleId as makeTitleId, type FileReason, type FileStatus, type ParsedNameRecord, type TitleKind, type WatchState } from './types.js';
```
Replace line 52:
```ts
export type PlaySource = 'live' | 'vlc_recents' | 'stream';
```
Replace `PlayView` (174-197):
```ts
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
```
In `TitleFilter` (270-284) add after `limit?: number;`:
```ts
  /** `library` (default): leave out titles known only from streams (invariant 10). `all`: every title. */
  scope?: 'library' | 'all';
```
Replace `groupState` (lines 430-434) with:
```ts
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
```
Replace `TitleParts`, `emptyParts` and `loadParts` (438-477):
```ts
interface TitleParts {
  files: FileView[];
  episodes: EpisodeRow[];
  ids: TitleMovieIds;
  /** By streamKey: the film's stream, or each streamed episode's. */
  streams: Map<string, StreamSlotView>;
}

function emptyParts(): TitleParts {
  return { files: [], episodes: [], ids: emptyTitleMovieIds(), streams: new Map() };
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
```
Replace `EpisodeSlot`, `episodeView` and `buildSeasons` (479-539):
```ts
interface EpisodeSlot {
  row: EpisodeRow | null;
  season: number;
  episode: number;
  files: FileView[];
  stream: StreamSlotView | null;
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
    state: slotState(slot.files, slot.stream),
    has_file: slot.files.length > 0,
    present_here: slot.files.some((f) => f.available),
    deleted: slot.files.length > 0 && slot.files.every((f) => f.deleted),
    progress: lead?.progress ?? primary?.progress ?? NO_PROGRESS,
    last_played_at: latest([...slot.files.map((f) => f.last_played_at), slot.stream?.last_played_at]),
    finished_at: latest([...slot.files.map((f) => f.finished_at), slot.stream?.finished_at]),
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
      slot = { row: null, season, episode, files: [], stream: null };
      slots.set(k, slot);
    }
    return slot;
  };
  for (const row of parts.episodes) slots.set(key(row.season, row.episode), { row, season: row.season, episode: row.episode, files: [], stream: null });
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
```
Replace `buildTitle` (548-596):
```ts
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
    rating: t.rating,
    progress,
    last_played_at: latest([...files.map((f) => f.last_played_at), ...streams.map((s) => s.last_played_at)]),
    finished_at: latest([t.watchedAt, ...files.map((f) => f.finished_at), ...streams.map((s) => s.finished_at)]),
    present_here: files.some((f) => f.available),
    file_count: files.filter((f) => !f.deleted).length,
    deleted_file_count: files.filter((f) => f.deleted).length,
    created_at: iso(t.createdAt),
  };
  return { item, seasons, unplaced, files };
}
```
Replace `listTitles` (636-661):
```ts
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
 * `ctx.host` at or after `freshSince` and not stale (repo.ts freshStreamSourceSql), files or not.
 * `filter.scope` is ignored. GET /api/movies/stream (phase 9) calls it with
 * `streamFreshSince(now, config.directStream.freshDays)`.
 */
export async function listStreamTitles(db: Db, filter: TitleFilter, ctx: ReadContext, freshSince: Date): Promise<TitleListItem[]> {
  return selectTitles(db, filter, ctx, freshStreamSourceSql(ctx.host, freshSince));
}
```
Replace `history` (794-849):
```ts
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
```
In `statusCounts` (887-902) replace the `titles` line of the query:
```ts
      (select count(*)::int from movie_titles where ${inLibrarySql()}) as titles,
```
In `searchHitViews` (905-925) replace the `known` query line:
```ts
      : new Set((await db.select({ id: movieTitles.id }).from(movieTitles).where(and(inArray(movieTitles.id, ids), inLibrarySql()))).map((r) => r.id));
```
and the `TmdbHitView.in_library` field (line 260) gets the doc comment:
```ts
  /** The title is in the Library (a title known only from streams is not). */
  in_library: boolean;
```
**Impact:** existing file-only titles read exactly as before (every new term is empty for them). `GET /api/movies`, `movies_list` and the name lookup in `movieTools.ts:186` stop returning stream-only titles (Handoffs, phase 7). `history` rows gain `provider`; stream rows have `file_id` and `file_name` null.

### Step 6b: This host's stream sources on the title (reconciler)
**File:** `src/movies/read.ts` (`TitleDetail`, `getTitle`; imports)
**Change:** the title page's stream block (phase 9) reads this host's verified sources from the
detail it already loads. The field is this phase's because `read.ts` is; phase 9 only adds `fresh`
per row in its route, with `isFreshStreamSource` and `streamFreshSince` (the one freshness rule).
**Code:** add `isNotNull` to the `drizzle-orm` import and `movieStreamSources` to the
`../db/schema.js` import. After `TitleDetail`'s `plays: PlayView[];` add:
```ts
  /** This host's verified stream sources (direct streaming): the film's, or each episode's. */
  stream_sources: StreamSourceView[];
```
Beside `TitleDetail`:
```ts
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
```
In `getTitle`, add `streamSourceViews(db, t.id, ctx.host)` as a fifth member of the
`Promise.all` (`const [companies, credits, review, plays, streamSources] = ...`) and, after
`plays,` in the returned object, `stream_sources: streamSources,`. (A verified row always has a
provider and a manifest kind: `movie_stream_sources_outcome_check`.)
**Test:** in `tests/integration/movies.streams.int.test.ts`, inside the "verified and stale
sources" describe:
```ts
    it('getTitle carries this host\'s verified sources only', async () => {
      const store = streams()
      await store.recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidFast', manifest_kind: 'hls', best_height: 2160, subtitles: [{ lang: 'en' }] } })
      await streams(OTHER).recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidLink', manifest_kind: 'dash', best_height: 1080, subtitles: [] } })
      const detail = await getTitle(db, 'movie-550', CTX)
      expect(detail?.stream_sources).toEqual([
        expect.objectContaining({ host: HOST, season: 0, episode: 0, provider: 'VidFast', manifest_kind: 'hls', best_height: 2160, en_subtitle: true, stale_at: null }),
      ])
    })
```
**Impact:** every detail answer gains `stream_sources` (empty for a title never streamed here).
Phase 9's web types read it.

### Step 7: MovieEvents reason `stream`
**File:** `src/movies/service.ts:32`, `:44-47`
**Code:**
```ts
export type MovieChangeReason = 'sync' | 'assign' | 'user' | 'play' | 'stream';
```
and the `MovieEvents` doc comment:
```ts
/**
 * In-process bus for movie changes. The service emits after a pass that wrote and after assign;
 * phase 4 emits 'user' after user-state writes and subscribes for SSE; phase 5 emits 'play'.
 * Direct streaming emits 'play' when a stream play opens or closes and 'stream' when a title's
 * stream source appears, or turns verified or stale (src/movies/streams.ts).
 */
```
**Impact:** the SSE wire type (`MovieChangeWire = MovieChangeEvent`) carries the new reason; the web's own copy of the union is phase 9's (Handoffs).

### Step 8: MovieStreams: the hooks and the position recorder
**File:** `src/movies/streams.ts` (new)
**A TMDB miss never fails a play (reconciler, decided here):** when the title is not stored and
TMDB cannot give it (no credential, TMDB down, or TMDB has no such id, as with verify's fake TMDB
and Fight Club 550), `ensureTitle` logs and answers null. `recordResolve` then writes no verified
or stale row and returns normally (it never throws), so phase 3 answers `POST /api/stream/play`
with 200 and the film plays. The play is not recorded either, because a `movie_plays` stream row
needs a title (`movie_plays_target_check`): the position route answers 404 `unknown_title`, which
the player page ignores. Nothing is retried later; the next play tries TMDB again.
**Code:**
```ts
import type { MoviesService } from './service.js';
import { streamResumePosition } from './state.js';
import { streamSlot, titleId, type MovieStreamSourceRow, type StreamPositionWrite, type StreamTarget, type TitleMetadata } from './types.js';

/** The resolve error that means the title has no source now. Every other error is the local Chrome's and records nothing. */
export const NO_SOURCE = 'no_source';

/** What MovieStreams needs of the movies service (AppDeps.movies fits). */
export type MovieStreamsSource = Pick<MoviesService, 'repo' | 'tmdb' | 'events' | 'host'>;

/** One resolve's answer as phase 3 parsed it from `direct/cli.mjs resolve` (its JSON shape). */
export interface ResolveRecord {
  ok: boolean;
  source?: {
    provider: string;
    manifest_kind: string;
    best_height?: number | null;
    subtitles?: ReadonlyArray<{ lang?: string | null }>;
  } | null;
  error?: string | null;
}

/** The part of a live player session the position route reads (phase 3's session fits). */
export interface StreamSessionRef {
  id: string;
  ref: StreamTarget;
  source: { provider: string };
}

/** One position report of the player page, validated by the route. */
export interface StreamReading {
  positionS: number;
  durationS: number | null;
  ended: boolean;
}

export interface MovieStreamsOptions {
  now?: () => Date;
  log?: (line: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeTarget(target: StreamTarget): string {
  return target.kind === 'movie' ? `movie ${target.tmdbId}` : `tv ${target.tmdbId} S${target.season ?? '?'}E${target.episode ?? '?'}`;
}

/** True when one of the tracks is English (`en`, `en-US`, `eng`, `English`). */
export function hasEnglishSubtitle(subtitles: ReadonlyArray<{ lang?: string | null }> | undefined): boolean {
  return (subtitles ?? []).some((s) => {
    const lang = (s.lang ?? '').trim().toLowerCase();
    return lang === 'en' || lang === 'eng' || lang === 'english' || lang.startsWith('en-');
  });
}

/** The Stream grid may change when a row is new, or turns verified or stale. */
function visibilityChanged(before: MovieStreamSourceRow | null, after: MovieStreamSourceRow): boolean {
  return (
    before === null ||
    (before.staleAt === null) !== (after.staleAt === null) ||
    (before.verifiedAt === null) !== (after.verifiedAt === null)
  );
}

/**
 * Direct streaming in the movies store. Implements phase 3's hooks (`recordResolve` after every
 * resolve, `resumeS` for a new session) and the player page's position reports. Writes only
 * through MoviesRepo; watch state stays in state.ts. Holds no state of its own: build one per use.
 */
export class MovieStreams {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(
    private readonly movies: MovieStreamsSource,
    options: MovieStreamsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line: string) => console.log(line));
  }

  /**
   * Makes sure the target's title row exists (TMDB details, then MoviesRepo.upsertTitle, as a
   * matched file's title is stored). Returns the title id, or null when it is not stored and cannot
   * be (no TMDB credential, TMDB unreachable): the stream is then played but not recorded.
   */
  async ensureTitle(target: StreamTarget): Promise<string | null> {
    const id = titleId(target.kind, target.tmdbId);
    if ((await this.movies.repo.titleById(id)) !== null) return id;
    const tmdb = this.movies.tmdb;
    if (tmdb === null) {
      this.log(`[notesd] direct stream: ${id} is not stored and no TMDB credential is configured; the stream is not recorded`);
      return null;
    }
    let meta: TitleMetadata;
    try {
      meta = target.kind === 'movie' ? await tmdb.movieDetails(target.tmdbId) : await tmdb.tvDetails(target.tmdbId);
    } catch (err) {
      this.log(`[notesd] direct stream: could not fetch ${id} from TMDB: ${messageOf(err)}`);
      return null;
    }
    await this.movies.repo.upsertTitle(meta, this.now());
    return id;
  }

  /**
   * Phase 3's recorder hook, awaited after every resolve. A resolved source verifies the film's or
   * the episode's row on this host; `no_source` makes it stale (R5.4); any other failure (the
   * streaming Chrome is down) records nothing. The title row is ensured first. Never throws.
   */
  async recordResolve(target: StreamTarget, result: ResolveRecord): Promise<void> {
    const source = result.ok ? (result.source ?? null) : null;
    if (source === null && (result.ok || result.error !== NO_SOURCE)) return;
    try {
      const slot = streamSlot(target);
      if (slot === null) return;
      const id = await this.ensureTitle(target);
      if (id === null) return;
      const key = { titleId: id, season: slot.source.season, episode: slot.source.episode, host: this.movies.host, at: this.now() };
      const { before, after } = await this.movies.repo.recordStreamSource(
        source !== null
          ? {
              ...key,
              outcome: 'verified',
              provider: source.provider,
              manifestKind: source.manifest_kind,
              bestHeight: source.best_height ?? null,
              enSubtitle: hasEnglishSubtitle(source.subtitles),
            }
          : { ...key, outcome: 'stale', failure: NO_SOURCE },
      );
      if (visibilityChanged(before, after)) this.emit('stream', id);
    } catch (err) {
      this.log(`[notesd] direct stream: could not record the resolve of ${describeTarget(target)}: ${messageOf(err)}`);
    }
  }

  /** Phase 3's resume hook: where a new session starts (state.ts streamResumePosition). 0 on any failure. */
  async resumeS(target: StreamTarget): Promise<number> {
    try {
      const slot = streamSlot(target);
      if (slot === null) return 0;
      return streamResumePosition(await this.movies.repo.lastStreamPlay(slot.titleId, slot.play.season, slot.play.episode));
    } catch (err) {
      this.log(`[notesd] direct stream: could not read the resume position of ${describeTarget(target)}: ${messageOf(err)}`);
      return 0;
    }
  }

  /**
   * One position report of the player page (R2.4): written on the session's one `movie_plays` row.
   * Emits 'play' when the row opens or closes, never per report, as a VLC play does. Null when the
   * target has no slot or its title cannot be stored.
   */
  async recordPosition(session: StreamSessionRef, reading: StreamReading): Promise<StreamPositionWrite | null> {
    const slot = streamSlot(session.ref);
    if (slot === null) return null;
    const id = await this.ensureTitle(session.ref);
    if (id === null) return null;
    const written = await this.movies.repo.recordStreamPosition({
      sessionId: session.id,
      titleId: id,
      season: slot.play.season,
      episode: slot.play.episode,
      provider: session.source.provider,
      host: this.movies.host,
      positionS: reading.positionS,
      durationS: reading.durationS,
      ended: reading.ended,
      at: this.now(),
    });
    if (written.created || written.closed) this.emit('play', id);
    return written;
  }

  /** Daemon start: closes the stream plays this host left open (MoviesRepo.closeOpenStreamPlays). */
  async closeLeftOpen(): Promise<number> {
    return this.movies.repo.closeOpenStreamPlays(this.movies.host);
  }

  private emit(reason: 'play' | 'stream', id: string): void {
    try {
      this.movies.events.changed(reason, { titleIds: [id] });
    } catch (err) {
      this.log(`[notesd] direct stream: a change listener threw: ${messageOf(err)}`);
    }
  }
}
```
**Impact:** new module; imports only `service.ts` types, `state.ts` and `types.ts`.

### Step 9: The position route
**File:** `src/http/directStreamApi.ts` (phase 3's file): add the imports at its top, `streamPositionRoutes` at its end, and one mount line inside phase 3's `directStreamRoutes(deps)`
**Change:** `POST /api/stream/sessions/:id/position`, same-origin only.
**Code:** imports (merge with phase 3's; `z`, `Hono` and `sameOriginOnly` are likely already imported):
```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { MovieStreams, type MovieStreamsSource, type StreamSessionRef } from '../movies/streams.js';
import { sameOriginOnly } from './sameOrigin.js';
```
At the end of the file:
```ts
/** Longest position or duration a report may carry, in seconds (11.5 days: a sanity bound, not a film's length). */
const MAX_STREAM_SECONDS = 1_000_000;

/** The player page's report (phase 4 posts it every 5 s and on pause and end). Unknown keys are dropped. */
const positionBody = z.object({
  position_s: z.number().finite().min(0).max(MAX_STREAM_SECONDS),
  duration_s: z.number().finite().positive().max(MAX_STREAM_SECONDS).nullable().optional(),
  ended: z.boolean().optional(),
});

/** What the position route reads (AppDeps fits: DirectStreamService.session returns a superset of StreamSessionRef). */
export interface StreamPositionDeps {
  movies: MovieStreamsSource | null;
  directStream?: { session(id: string): StreamSessionRef | null | Promise<StreamSessionRef | null> } | null;
}

/**
 * Direct streaming phase 5 (R2.4): the player page's position reports, written on the one
 * `movie_plays` row of its session (src/movies/streams.ts). Same-origin only: it writes.
 * 503 `direct_stream_off` without the service or the movies store; 404 `unknown_session` for a
 * session the daemon does not hold (the page ignores 404s); 404 `unknown_title` when the title
 * cannot be stored (no TMDB credential); 400 `invalid_body`.
 */
export function streamPositionRoutes(deps: StreamPositionDeps, options: { now?: () => Date } = {}): Hono {
  const r = new Hono();
  r.post('/api/stream/sessions/:id/position', sameOriginOnly, async (c) => {
    const service = deps.directStream ?? null;
    const movies = deps.movies;
    if (service === null || movies === null) return c.json(DIRECT_STREAM_OFF, 503);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'The body is not JSON.' }, 400);
    }
    const body = positionBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => i.message).join('; ') }, 400);
    const session = await service.session(c.req.param('id'));
    if (session === null) {
      return c.json({ error: 'unknown_session', message: 'No live stream session has this id (it expired, or the daemon restarted).' }, 404);
    }
    const written = await new MovieStreams(movies, options).recordPosition(session, {
      positionS: body.data.position_s,
      durationS: body.data.duration_s ?? null,
      ended: body.data.ended ?? false,
    });
    if (written === null) {
      return c.json({ error: 'unknown_title', message: 'The title is not stored and TMDB cannot be asked for it; the play is not recorded.' }, 404);
    }
    return c.json({ ok: true, play_id: written.play.id, ended: written.play.endedAt !== null });
  });
  return r;
}
```
Inside phase 3's `directStreamRoutes(deps)`, before its `return r;` (or equivalent), add:
```ts
  // Phase 5: the player page's position reports (src/movies/streams.ts).
  r.route('/', streamPositionRoutes(deps));
```
If phase 3's `deps` type is a `Pick<AppDeps, ...>` without `movies`, add `'movies'` to it.
**Impact:** one new route; `npm run docs:check` fails until Step 14 documents it.

### Step 10: Wire the hooks in the daemon
**File:** `src/daemon.ts`: the import block (`:22-25`), after the movie player block (`:129-140`, ends with the `playback via` log), and phase 3's direct-stream builder call
**Code:** import:
```ts
import { MovieStreams } from './movies/streams.js';
```
After the `if (moviesPlayer !== null) { ... }` block:
```ts
  // Direct streaming phase 5: stream plays and verified sources are written to the movies store.
  // Player sessions live in memory, so a stream play the previous run left open is closed here.
  const movieStreams = movies === null ? null : new MovieStreams(movies);
  if (movieStreams !== null) {
    try {
      const closed = await movieStreams.closeLeftOpen();
      if (closed > 0) console.log(`[notesd] direct stream: closed ${closed} stream play(s) left open by the previous run at their last position`);
    } catch (err) {
      console.error(`[notesd] direct stream: could not close stale stream plays: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```
Phase 3's call that builds `directStream` (phase 3's Step 13, in the block that replaced
`d996abb`'s lines 143-148, so it already comes after the movie player block and after this one)
reads:
```ts
  const directStream = buildDirectStreamService(config, db, {
    movies,
    pageBase: () => `http://localhost:${boundPort ?? config.port}`,
  });
```
and becomes (phase 3's `hooks` is optional, so off is `undefined`, never `null`):
```ts
  const directStream = buildDirectStreamService(config, db, {
    movies,
    pageBase: () => `http://localhost:${boundPort ?? config.port}`,
    hooks:
      movieStreams === null
        ? undefined
        : {
            recordResolve: (ref, result) => movieStreams.recordResolve(ref, result),
            resumeS: (ref) => movieStreams.resumeS(ref),
          },
  });
```
**Impact:** every resolve made by `resolve()`, `play()` or `refresh()` (plays, refreshes, and phase 10's prober) now writes a source row before the caller is answered; phase 8's `runResolve` probes write none. A new session gets `resume_s` from the last stream play. With `NOTESD_MOVIES=off` nothing is built (phase 3 answers `direct_stream_off` then).

### Step 11: Test fixture rows
**File:** `tests/fixtures/movies/rows.ts:39-50`
**Code:**
```ts
/** A full movie_plays row (an ended file play), overridable. */
export function playRow(over: Partial<PlayRow> & Pick<PlayRow, 'id' | 'fileId'>): PlayRow {
  return {
    titleId: null,
    season: null,
    episode: null,
    provider: null,
    streamSession: null,
    host: 'this-host',
    source: 'live',
    startedAt: T0,
    endedAt: T0,
    startPositionS: 0,
    positionS: 0,
    durationS: 3000,
    updatedAt: T0,
    ...over,
  };
}
```
**Impact:** the player and recents unit tests keep compiling.

### Step 12: Unit tests: the stream rule and the slot mapping
**File:** `tests/unit/movies/state.test.ts:3-4` (imports), append at the end; `tests/unit/movies/types.test.ts:3` (import), append at the end
**Code:** replace the imports of `state.test.ts`:
```ts
import { FINISHED_RATIO, episodeState, fileState, reachedEnd, resumePosition, streamResumePosition, streamState, titleState, type SourceSummary } from '../../../src/movies/state.js'
import { WATCH_STATES, type FileStateInput, type PlayStateInput, type WatchState } from '../../../src/movies/types.js'
```
Append to `state.test.ts`:
```ts
describe('streams (direct streaming)', () => {
  it.each<[string, PlayStateInput, WatchState]>([
    ['opened and left at 0', play(0, 6000), 'unwatched'],
    ['partway', play(1200, 6000), 'in_progress'],
    ['at 90% of what the player reported', play(5400, 6000), 'finished'],
    ['just under 90%', play(5399, 6000), 'in_progress'],
    ['with no duration reported, never finished', play(99_999, null), 'in_progress'],
  ])('a stream %s is %s', (_name, p, expected) => {
    expect(streamState(p)).toBe(expected)
  })

  it('a stream reads like a present file with the same play', () => {
    for (const p of [play(0, 6000), play(1200, 6000), play(5400, 6000)]) {
      expect(streamState(p)).toBe(fileState(file({ durationS: null }), p))
    }
  })

  it('resumes a stream where it stopped, and from the start when there is none or it is finished', () => {
    expect(streamResumePosition(play(1200, 6000))).toBe(1200)
    expect(streamResumePosition(play(5800, 6000))).toBe(0)
    expect(streamResumePosition(null)).toBe(0)
  })

  const src = (state: WatchState, playedAt: string | null): SourceSummary => ({ state, playedAt })
  const D1 = '2026-11-01T20:00:00.000Z'
  const D2 = '2026-11-02T20:00:00.000Z'
  const D3 = '2026-11-03T20:00:00.000Z'

  it.each<[string, boolean, SourceSummary | null, SourceSummary | null, WatchState]>([
    ['no copy and no stream', false, null, null, 'unwatched'],
    ['no copy, streamed partway', false, null, src('in_progress', D2), 'in_progress'],
    ['a copy finished, the stream partway', true, src('finished', D1), src('in_progress', D2), 'finished'],
    ['the stream finished, the copy unwatched', false, src('unwatched', null), src('finished', D2), 'finished'],
    ['streamed after the copy was dropped', false, src('dropped', D1), src('in_progress', D2), 'in_progress'],
    ['the copy played after the stream', false, src('in_progress', D3), src('unwatched', D2), 'in_progress'],
    ['a copy never played, streamed partway', false, src('unwatched', null), src('in_progress', D2), 'in_progress'],
    ['no stream: the primary copy decides, as before', false, src('removed_unwatched', null), null, 'removed_unwatched'],
  ])('an episode: %s', (_name, anyFinished, primary, stream, expected) => {
    expect(episodeState(anyFinished, primary, stream)).toBe(expected)
  })

  it("a film takes its stream's state into the precedence list", () => {
    expect(titleState('movie', ['dropped', streamState(play(1200, 6000))])).toBe('in_progress')
    expect(titleState('movie', [streamState(play(5500, 6000))])).toBe('finished')
  })
})
```
Replace line 3 of `types.test.ts`:
```ts
import { classifyReason, parseTitleId, streamSlot, titleId } from '../../../src/movies/types.js'
```
Append to `types.test.ts`:
```ts
describe('streamSlot', () => {
  it('records a film as null/null on a play and 0/0 on a source row', () => {
    expect(streamSlot({ kind: 'movie', tmdbId: 550 })).toEqual({
      titleId: 'movie-550',
      play: { season: null, episode: null },
      source: { season: 0, episode: 0 },
    })
  })

  it('keeps an episode, specials included', () => {
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 1, episode: 2 })).toEqual({
      titleId: 'tv-247718',
      play: { season: 1, episode: 2 },
      source: { season: 1, episode: 2 },
    })
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 0, episode: 3 })?.source).toEqual({ season: 0, episode: 3 })
  })

  it('has no slot for a series without a whole episode', () => {
    expect(streamSlot({ kind: 'tv', tmdbId: 247718 })).toBeNull()
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 1 })).toBeNull()
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 1, episode: 0 })).toBeNull()
  })

  it('refuses a bad TMDB id', () => {
    expect(() => streamSlot({ kind: 'movie', tmdbId: 0 })).toThrow(RangeError)
  })
})
```
**Impact:** `npm test` covers the rule with no database.

### Step 13: Integration tests
**File:** `tests/integration/movies.streams.int.test.ts` (new)
**Code:**
```ts
import { asc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { moviePlays, movieTitles } from '../../src/db/schema.js'
import { streamPositionRoutes } from '../../src/http/directStreamApi.js'
import { getTitle, history, listStreamTitles, listTitles } from '../../src/movies/read.js'
import { MoviesRepo, isFreshStreamSource, streamFreshSince } from '../../src/movies/repo.js'
import { MovieEvents, type MovieChangeEvent } from '../../src/movies/service.js'
import { MovieStreams, type MovieStreamsSource, type ResolveRecord, type StreamSessionRef } from '../../src/movies/streams.js'
import type { TmdbClient } from '../../src/movies/tmdb.js'
import type { NewMovieFile } from '../../src/movies/types.js'
import { movieMeta, tvMeta } from './helpers/movieMeta.js'
import { fakeTmdb } from './helpers/moviesSeed.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const HOST = 'host-a'
const OTHER = 'host-b'
const CTX = { host: HOST, imageBase: 'https://image.tmdb.org/t/p' }
const SAME_ORIGIN = { origin: 'http://localhost' }
const T0 = new Date('2026-11-15T12:00:00.000Z')
const FIGHT_CLUB = { kind: 'movie' as const, tmdbId: 550 }
const MOBLAND_S1E2 = { kind: 'tv' as const, tmdbId: 247718, season: 1, episode: 2 }
const RESOLVED: ResolveRecord = { ok: true, source: { provider: 'VidFast', manifest_kind: 'hls', best_height: 2160, subtitles: [{ lang: 'en' }] } }
const NO_SOURCE: ResolveRecord = { ok: false, error: 'no_source' }

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000)
}

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

describe('direct streaming in the movies store', () => {
  let db: Db
  let repo: MoviesRepo
  let events: MovieEvents
  let seen: MovieChangeEvent[]
  let clock: Date
  let tmdbCalls: number
  const sessions = new Map<string, StreamSessionRef>()

  beforeAll(() => {
    db = openTestDb()
    repo = new MoviesRepo(db)
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
    events = new MovieEvents()
    seen = []
    events.on((e) => seen.push(e))
    clock = T0
    tmdbCalls = 0
    sessions.clear()
  })

  function tmdb(): TmdbClient {
    return {
      ...fakeTmdb(),
      movieDetails: (id: number) => {
        tmdbCalls += 1
        return Promise.resolve(movieMeta(id))
      },
      tvDetails: (id: number) => {
        tmdbCalls += 1
        return Promise.resolve(tvMeta(id))
      },
    }
  }

  function moviesOf(host = HOST, client: TmdbClient | null = tmdb()): MovieStreamsSource {
    return { repo, tmdb: client, events, host }
  }

  function streams(host = HOST): MovieStreams {
    return new MovieStreams(moviesOf(host), { now: () => clock, log: () => undefined })
  }

  function app(movies: MovieStreamsSource | null = moviesOf(), withService = true): Hono {
    const a = new Hono()
    const directStream = withService ? { session: (id: string) => sessions.get(id) ?? null } : null
    a.route('/', streamPositionRoutes({ movies, directStream }, { now: () => clock }))
    return a
  }

  function report(a: Hono, sessionId: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
    return Promise.resolve(
      a.request(`/api/stream/sessions/${sessionId}/position`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    )
  }

  function streamRows() {
    return db.select().from(moviePlays).where(eq(moviePlays.source, 'stream')).orderBy(asc(moviePlays.id))
  }

  function newFile(titleId: string, path: string, durationS: number): NewMovieFile {
    return {
      host: HOST,
      path,
      name: path.split('/').pop() ?? path,
      size: 1_000_000,
      mtime: T0,
      durationS,
      season: null,
      episode: null,
      absoluteEpisode: null,
      parsed: null,
      source: 'scan',
      classification: { status: 'matched', titleId },
      seenAt: T0,
    }
  }

  describe('stream plays from the player page (R2.4)', () => {
    it('R2.4 writes every report of one play on one movie_plays row, and the title state derives from it as from a VLC play', async () => {
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      const a = app()
      for (const [i, position] of [5, 10, 600].entries()) {
        clock = at(i)
        const res = await report(a, 'sess-1', { position_s: position, duration_s: 8340, ended: false })
        expect(res.status).toBe(200)
      }
      const rows = await streamRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        source: 'stream', fileId: null, titleId: 'movie-550', season: null, episode: null, provider: 'VidFast',
        streamSession: 'sess-1', host: HOST, startPositionS: 5, positionS: 600, durationS: 8340, startedAt: at(0), endedAt: null,
      })
      expect(tmdbCalls).toBe(1)

      const streamed = await getTitle(db, 'movie-550', CTX)
      expect(streamed).toMatchObject({ state: 'in_progress', last_played_at: at(0).toISOString(), progress: { kind: 'movie', position_s: 600, duration_s: 8340 } })
      expect(streamed?.plays[0]).toMatchObject({ source: 'stream', provider: 'VidFast', file_id: null, file_name: null, file_deleted: false, title_id: 'movie-550', title: 'Film 550', position_s: 600 })

      // The same reading on a VLC play of another film gives the same state.
      const other = await repo.upsertTitle(movieMeta(551))
      const { file } = await repo.upsertFile(newFile(other, '/lib/film.551.mkv', 8340))
      const vlc = await repo.startPlay({ fileId: file.id, host: HOST, source: 'live', startedAt: at(0), startPositionS: 5, durationS: 8340 })
      await repo.updatePlay(vlc.id, { positionS: 600, durationS: 8340 }, at(2))
      expect((await getTitle(db, other, CTX))?.state).toBe(streamed?.state)

      clock = at(60)
      expect((await report(a, 'sess-1', { position_s: 7600, duration_s: 8340, ended: true })).status).toBe(200)
      expect(await streamRows()).toMatchObject([{ positionS: 7600, endedAt: at(60) }])
      expect((await getTitle(db, 'movie-550', CTX))?.state).toBe('finished')
      // A report after the end writes nothing new.
      expect((await report(a, 'sess-1', { position_s: 7600, duration_s: 8340, ended: true })).status).toBe(200)
      expect(await streamRows()).toHaveLength(1)
      // 'play' when the row opened and when it closed, never per report.
      expect(seen.filter((e) => e.reason === 'play').map((e) => e.title_ids)).toEqual([['movie-550'], ['movie-550']])
      // History's SQL "finished" agrees with streamState.
      const finished = await repo.titlesFinishedBetween({ from: at(-1), to: at(120) })
      expect(finished.map((f) => f.id)).toContain('movie-550')
    })

    it('a new session starts a second row, closes the first at its last report, and resumes from it', async () => {
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      sessions.set('sess-2', { id: 'sess-2', ref: FIGHT_CLUB, source: { provider: 'VidLink' } })
      const a = app()
      await report(a, 'sess-1', { position_s: 1200, duration_s: 8340 })
      expect(await streams().resumeS(FIGHT_CLUB)).toBe(1200)
      clock = at(30)
      await report(a, 'sess-2', { position_s: 1205, duration_s: 8340 })
      const rows = await streamRows()
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ streamSession: 'sess-1', endedAt: T0, positionS: 1200 })
      expect(rows[1]).toMatchObject({ streamSession: 'sess-2', endedAt: null, provider: 'VidLink' })
      clock = at(200)
      await report(a, 'sess-2', { position_s: 8000, duration_s: 8340, ended: true })
      expect(await streams().resumeS(FIGHT_CLUB)).toBe(0)
    })

    it('an episode play names its season and episode, moves the episode and the series, and shows in history', async () => {
      sessions.set('sess-tv', { id: 'sess-tv', ref: MOBLAND_S1E2, source: { provider: 'VidLink' } })
      expect((await report(app(), 'sess-tv', { position_s: 300, duration_s: 3300 })).status).toBe(200)
      const detail = await getTitle(db, 'tv-247718', CTX)
      const ep2 = detail?.seasons[0]?.episodes.find((e) => e.episode === 2)
      expect(ep2).toMatchObject({ state: 'in_progress', has_file: false, present_here: false, file_id: null, progress: { position_s: 300, duration_s: 3300 } })
      expect(ep2?.movie_id).toMatch(/^M-[0-9A-Z]{4}$/)
      expect(detail?.state).toBe('in_progress')
      const [h] = await history(db, { titleId: 'tv-247718' })
      expect(h).toMatchObject({ source: 'stream', provider: 'VidLink', season: 1, episode: 2, episode_name: 'Alpha Male', movie_id: ep2?.movie_id, file_id: null, kind: 'tv' })
    })

    it('answers 400, 403, 404 and 503 and writes nothing', async () => {
      const a = app()
      expect(await (await report(a, 'nope', { position_s: 1 })).json()).toMatchObject({ error: 'unknown_session' })
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      expect((await report(a, 'sess-1', { position_s: -1 })).status).toBe(400)
      expect((await report(a, 'sess-1', { duration_s: 10 })).status).toBe(400)
      expect((await report(a, 'sess-1', { position_s: 1 }, { origin: 'http://evil.example' })).status).toBe(403)
      expect((await report(app(moviesOf(), false), 'sess-1', { position_s: 1 })).status).toBe(503)
      expect((await report(app(null), 'sess-1', { position_s: 1 })).status).toBe(503)
      const noTmdb = await report(app(moviesOf(HOST, null)), 'sess-1', { position_s: 1 })
      expect(noTmdb.status).toBe(404)
      expect(await noTmdb.json()).toMatchObject({ error: 'unknown_title' })
      expect(await streamRows()).toHaveLength(0)
    })

    it('a title TMDB does not have records nothing and never throws, so a play still answers', async () => {
      const missing: TmdbClient = {
        ...fakeTmdb(),
        movieDetails: async () => {
          throw new Error('TMDB 404: movie 550')
        },
      }
      const store = new MovieStreams(moviesOf(HOST, missing), { log: () => {} })
      await expect(store.recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidFast', manifest_kind: 'hls', best_height: 1080, subtitles: [] } })).resolves.toBeUndefined()
      await expect(store.recordResolve(FIGHT_CLUB, { ok: false, source: null, error: 'no_source' })).resolves.toBeUndefined()
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toEqual([])
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      const res = await report(app(moviesOf(HOST, missing)), 'sess-1', { position_s: 30 })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ error: 'unknown_title' })
      expect(await streamRows()).toHaveLength(0)
    })

    it('a daemon start closes the stream plays this host left open, and only those', async () => {
      sessions.set('sess-1', { id: 'sess-1', ref: FIGHT_CLUB, source: { provider: 'VidFast' } })
      sessions.set('sess-b', { id: 'sess-b', ref: MOBLAND_S1E2, source: { provider: 'VidFast' } })
      await report(app(), 'sess-1', { position_s: 900, duration_s: 8340 })
      await report(app(moviesOf(OTHER)), 'sess-b', { position_s: 100, duration_s: 3300 })
      expect(await streams().closeLeftOpen()).toBe(1)
      const rows = await streamRows()
      expect(rows.find((r) => r.host === HOST)?.endedAt).toEqual(T0)
      expect(rows.find((r) => r.host === OTHER)?.endedAt).toBeNull()
    })
  })

  describe('verified and stale sources (R5.4, store half)', () => {
    it('R5.4 a resolve that finds no source marks the row stale and the title leaves the fresh list', async () => {
      const store = streams()
      await store.recordResolve(FIGHT_CLUB, RESOLVED)
      const since = streamFreshSince(clock, 7)
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toMatchObject([
        { season: 0, episode: 0, provider: 'VidFast', manifestKind: 'hls', bestHeight: 2160, enSubtitle: true, verifiedAt: T0, staleAt: null, failure: null },
      ])
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual(['movie-550'])
      expect((await listStreamTitles(db, {}, CTX, since)).map((t) => t.id)).toEqual(['movie-550'])

      clock = at(60)
      await store.recordResolve(FIGHT_CLUB, NO_SOURCE)
      const [row] = await repo.streamSourcesOfTitle('movie-550', HOST)
      expect(row).toMatchObject({ provider: 'VidFast', verifiedAt: T0, staleAt: at(60), failure: 'no_source' })
      expect(row !== undefined && isFreshStreamSource(row, HOST, since)).toBe(false)
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual([])
      expect(await listStreamTitles(db, {}, CTX, since)).toEqual([])

      clock = at(120)
      await store.recordResolve(FIGHT_CLUB, RESOLVED)
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual(['movie-550'])
      expect(seen.filter((e) => e.reason === 'stream')).toHaveLength(3)
      expect(tmdbCalls).toBe(1)
    })

    it("a failure of the streaming Chrome is not the source's: nothing is recorded", async () => {
      await streams().recordResolve(FIGHT_CLUB, { ok: false, error: 'chrome_not_reachable' })
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toEqual([])
      expect(await repo.titleById('movie-550')).toBeNull()
      expect(tmdbCalls).toBe(0)
    })

    it('a first failed resolve stores the title and a stale-only episode row', async () => {
      await streams().recordResolve(MOBLAND_S1E2, NO_SOURCE)
      expect(await repo.titleById('tv-247718')).not.toBeNull()
      expect(await repo.streamSourcesOfTitle('tv-247718', HOST)).toMatchObject([
        { season: 1, episode: 2, provider: null, manifestKind: null, verifiedAt: null, staleAt: T0, failure: 'no_source', enSubtitle: false },
      ])
    })

    it('freshness is per host and inside the window, in SQL and in JS alike', async () => {
      await streams(OTHER).recordResolve(FIGHT_CLUB, RESOLVED)
      const since = streamFreshSince(clock, 7)
      expect(await repo.freshStreamTitleIds(HOST, since)).toEqual([])
      expect(await repo.freshStreamTitleIds(OTHER, since)).toEqual(['movie-550'])
      await streams().recordResolve(FIGHT_CLUB, RESOLVED)
      const eightDaysOn = streamFreshSince(at(8 * 24 * 60), 7)
      expect(await repo.freshStreamTitleIds(HOST, eightDaysOn)).toEqual([])
      const [row] = await repo.streamSourcesOfTitle('movie-550', HOST)
      expect(row !== undefined && isFreshStreamSource(row, HOST, since)).toBe(true)
      expect(row !== undefined && isFreshStreamSource(row, HOST, eightDaysOn)).toBe(false)
    })

    it('records no English subtitle when the source has none', async () => {
      await streams().recordResolve(FIGHT_CLUB, { ok: true, source: { provider: 'VidLink', manifest_kind: 'dash', best_height: 480, subtitles: [{ lang: 'fr' }] } })
      expect(await repo.streamSourcesOfTitle('movie-550', HOST)).toMatchObject([{ enSubtitle: false, manifestKind: 'dash' }])
    })
  })

  describe('the Library grid (invariant 10)', () => {
    it('a title known only from streams is absent from listTitles but opens by id', async () => {
      await streams().recordResolve(FIGHT_CLUB, RESOLVED)
      expect((await listTitles(db, {}, CTX)).map((t) => t.id)).not.toContain('movie-550')
      expect((await listTitles(db, { scope: 'all' }, CTX)).map((t) => t.id)).toContain('movie-550')
      expect(await getTitle(db, 'movie-550', CTX)).not.toBeNull()

      sessions.set('sess-tv', { id: 'sess-tv', ref: MOBLAND_S1E2, source: { provider: 'VidLink' } })
      await report(app(), 'sess-tv', { position_s: 300, duration_s: 3300 })
      expect((await listTitles(db, {}, CTX)).map((t) => t.id)).not.toContain('tv-247718')

      // A file makes it a Library title; a title stored before streams (no file, never streamed) stays listed.
      await repo.upsertFile(newFile('movie-550', '/lib/fight.club.1999.mkv', 8340))
      await repo.upsertTitle(movieMeta(700))
      expect((await listTitles(db, {}, CTX)).map((t) => t.id).sort()).toEqual(['movie-550', 'movie-700'])
    })
  })

  describe('migration 0021', () => {
    it('keeps a stream play on a title and a file play on a file, one open row per session', async () => {
      await db.insert(movieTitles).values({ id: 'movie-550', kind: 'movie', tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club' })
      const base = { host: HOST, startedAt: T0 }
      const noTitle = await pgFailure(db.insert(moviePlays).values({ ...base, source: 'stream', provider: 'VidFast', streamSession: 's' }))
      const noFile = await pgFailure(db.insert(moviePlays).values({ ...base, source: 'live', titleId: 'movie-550' }))
      const halfEpisode = await pgFailure(db.insert(moviePlays).values({ ...base, source: 'stream', titleId: 'movie-550', season: 1, provider: 'VidFast', streamSession: 's' }))
      for (const failure of [noTitle, noFile, halfEpisode]) expect(failure).toEqual({ code: '23514', constraint: 'movie_plays_target_check' })
      await db.insert(moviePlays).values({ ...base, source: 'stream', titleId: 'movie-550', provider: 'VidFast', streamSession: 's' })
      expect(await pgFailure(db.insert(moviePlays).values({ ...base, source: 'stream', titleId: 'movie-550', provider: 'VidFast', streamSession: 's' }))).toEqual({
        code: '23505',
        constraint: 'movie_plays_open_session_uniq',
      })
    })

    it('a stream source row is verified with a provider, or stale-only with a failure', async () => {
      await db.insert(movieTitles).values({ id: 'movie-550', kind: 'movie', tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club' })
      const bad = [
        sql`insert into movie_stream_sources (title_id, season, episode, host) values ('movie-550', 0, 0, 'h')`,
        sql`insert into movie_stream_sources (title_id, season, episode, host, verified_at) values ('movie-550', 0, 0, 'h', now())`,
        sql`insert into movie_stream_sources (title_id, season, episode, host, stale_at) values ('movie-550', 0, 0, 'h', now())`,
        sql`insert into movie_stream_sources (title_id, season, episode, host, stale_at, failure) values ('movie-550', 1, 0, 'h', now(), 'no_source')`,
      ]
      const failures = await Promise.all(bad.map((s) => pgFailure(db.execute(s))))
      expect(failures.map((f) => f.constraint)).toEqual([
        'movie_stream_sources_outcome_check',
        'movie_stream_sources_outcome_check',
        'movie_stream_sources_failure_check',
        'movie_stream_sources_slot_check',
      ])
    })
  })
})
```
Note on the last test: when a row breaks two checks Postgres reports the first it evaluates; each bad row above breaks exactly one.
**Impact:** proves R2.4 and the store half of R5.4 against the real Postgres, through the real route.

### Step 14: Docs and the feature map
**File:** `scripts/docs/httpRoutes.ts` (phase 3's "Direct streaming" group), then `npm run docs:gen`; `docs/guide/movies.md:58-71`, `:242-270`, `:574-592`, `:843-870`; `docs/guide/architecture.md:91`; `.claude/skills/verify-notesd/features/movies.md`; `.claude/skills/verify-notesd/features/direct-streaming.md`
**Change and code:**

`scripts/docs/httpRoutes.ts`, in the "Direct streaming" group's `routes`:
```ts
      'POST /api/stream/sessions/:id/position': '`{position_s, duration_s?, ended?}` from the player page, every 5 s and on pause and end: written on the one open `movie_plays` row (source `stream`) of this session, which the first report opens and `ended: true` closes; opening one closes this machine\'s other open stream play. The title\'s watch state derives from it as from a VLC play. 200 `{ok: true, play_id, ended}`. 400 `invalid_body`, 404 `unknown_session` / `unknown_title` (the title is not stored and TMDB cannot give it: the play is not recorded; the page ignores it), 503 `direct_stream_off`. Same-origin only.',
```
and, in the "Movies" group, append to the end of the `'GET /api/movies/:id'` string (before its
closing quote) this sentence, the only one about `stream_sources` (reconciler: phase 9 does not
add one):
```text
 `stream_sources`: this machine's verified stream sources of the title (direct streaming; season and episode 0 for a film): `provider`, `manifest_kind`, `best_height`, `en_subtitle`, `verified_at`, and `stale_at` when its last resolve found no source.
```
Then `npm run docs:gen` (regenerates `docs/guide/reference/http-api.md`; never edit it by hand).

`docs/guide/movies.md` "What is stored": replace the Play row and add a Stream source row after it:
```markdown
| Play | `movie_plays` | Per host | One row per play: start, end, position reached, duration, and source (`live` for a VLC notesd started, `vlc_recents` for one read from VLC's recent list, `stream` for the direct-stream player page). A file play names its file. A stream play has no file: it names its title, season and episode (none for a film), the provider, and its player session (one row per session). Never deleted, and it outlives its file. |
| Stream source | `movie_stream_sources` | Per host | One row per film or episode this machine resolved: the provider that last resolved it, manifest kind, best height, whether it had an English subtitle, `verified_at`, and `stale_at` with `failure` when a resolve last found no source. A film is season 0, episode 0. Written after every resolve; a failure of the streaming Chrome itself writes nothing. |
```
and after the paragraph that follows the table add:
```markdown
A title first met through a stream is stored like any other (TMDB details, credits, episodes), but
it stays out of the Library grid until it has a file: the Library lists titles with a file on
either machine, and titles that were never streamed. Opened by id (`/movies/<id>`, `movies_get`)
it shows like any title, with its stream plays. A title is on the Stream side only while one of
its source rows on this machine was verified within `NOTESD_STREAM_FRESH_DAYS` and is not stale.
```
"Watch state": after the bullet "An episode with several copies is finished when any copy is." add:
```markdown
- A stream counts as one more copy. A streamed film or episode has one stream source whose last
  play is its newest stream play. It is never deleted and has no duration of its own, so it is
  `finished` at 90 % of the duration the player reported, `in_progress` when played past 0, and
  `unwatched` otherwise. A film puts it in the precedence list with its files. An episode is
  finished when any copy or the stream is; otherwise the stream decides when it was played after
  the episode's primary copy (or there is no copy), and the primary copy decides when not.
```
and replace the closing sentence "Play resumes at the last known position, ..." with:
```markdown
Play resumes at the last known position, or from the start when there is none or the file is
finished. The stream player resumes a film or an episode at its last stream play's position, from
either machine, with the same rule.
```
"Two machines": add a row to the table and a bullet:
```markdown
| Stream plays (history lists both machines') | Stream sources: what each machine verified |
```
```markdown
- A stream verified on one machine is not on the other's Stream side until that machine resolves
  it too. Stream plays are history on both, and the stream player resumes from either machine's
  last stream play.
```
"Where the code is": add after the `src/movies/continue.ts` row:
```markdown
| `src/movies/streams.ts` | `MovieStreams`: stream plays from the player page's position reports, verified and stale sources after every resolve, the stream resume position |
```
and replace the drizzle row with:
```markdown
| `drizzle/0017_movies.sql`, `drizzle/0018_movie_ids.sql`, `drizzle/0019_movie_trailers.sql`, `drizzle/0021_stream_plays.sql` | The tables; the id sequence, function and triggers; the trailer columns; stream plays and stream sources |
```
and in the `src/http/moviesApi.ts, moviesPlayApi.ts` row append `; the stream position report is in src/http/directStreamApi.ts`.

`docs/guide/architecture.md:91` (Movies row of the data model):
```markdown
| Movies | `movie_titles`, `movie_episodes`, `movie_companies`, `movie_title_companies`, `movie_people`, `movie_credits`, `movie_files`, `movie_plays`, `movie_ids`, `movie_stream_sources` | Titles are shared and never deleted with their files; files are per host and soft-deleted; play events are never deleted (a stream play names its title instead of a file). Stream sources are per host: what each machine verified or found stale. Watch state is derived at read time, never stored. |
```

`.claude/skills/verify-notesd/features/movies.md`, append to the "State, derived at read time" bullet:
```markdown
  A stream play (direct streaming) counts as one more copy of the film or episode and moves state
  the same way; a title known only from streams is not in the grid but opens by id. Proof:
  `npx vitest run tests/unit/movies/state.test.ts -t streams`,
  `npm run test:int -- tests/integration/movies.streams.int.test.ts`.
```
`.claude/skills/verify-notesd/features/direct-streaming.md` (phase 3's file), add a sub-feature:
```markdown
- Stream plays and verified sources (phase 5). The player page's position reports
  (`POST /api/stream/sessions/:id/position`, same-origin) land on one `movie_plays` row per player
  session (source `stream`, provider, no file); the title's and episode's state, history and the
  resume position follow it like a VLC play. After every resolve this machine's
  `movie_stream_sources` row is verified, or stale on `no_source` (a Chrome failure writes
  nothing); a title is fresh while verified within `NOTESD_STREAM_FRESH_DAYS` and not stale. A
  title known only from streams stays out of the Library grid. Proof:
  `npm run test:int -- tests/integration/movies.streams.int.test.ts`; on a run, seed a stream play
  with `verify.sh exec` and read `GET /api/movies/<id>` and `GET /api/movies` (journey J2 of
  `.workflows/plan/direct-streaming/phase-5.md`).
```
**Impact:** `npm run docs:check` passes (the route is described, no new env var).

## Principles applied

- Make illegal states unrepresentable: `movie_plays_target_check` makes "a file play with stream columns" and "a stream play without a title, provider or session" impossible; `movie_stream_sources_outcome_check` / `_failure_check` make a verified row without a provider or a stale row without a failure impossible; `NewPlay.source` is narrowed to `FilePlaySource` so `startPlay` cannot write a stream play; "one open row per session" is the unique partial index `movie_plays_open_session_uniq`, not an in-memory map.
- Laziness protocol: the stream is a pseudo-source fed to the existing `fileState` / `resumePosition` / `titleState` (no second state machine); `MovieStreams` holds no state and is built per use, so the route and the daemon share it without a new `AppDeps` field; `listStreamTitles` shares `selectTitles` with `listTitles`.
- Boundary discipline: the position body is validated once in the route (zod); a resolve result is interpreted once in `recordResolve` (only `no_source` marks stale); `streamSlot` is the one mapping from a target to its play and source rows; the freshness rule is written once per form (SQL condition, JS predicate) side by side in `repo.ts` and a test proves they agree.
- Test behavior, not implementation: the integration tests post to the real route against Postgres and read back rows, `getTitle`, `history` and the fresh lists; nothing mocks the repo.
- Prove it works: Proof J2 drives the real daemon (`verify.sh up --movies`) and reads the routes the page uses.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int` (both whole suites; `npm run docs:check` is part of `npm test`)
**Proof:** the real route against the test Postgres (integration), and the real daemon from this checkout with seeded stream rows (harness).
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --movies`). A live session needs a real resolve (Chrome), so the harness journey seeds the rows the route writes and reads them back through the daemon's own routes; the route itself is proven by the integration journeys.
- Feature-map entries: `features/movies.md` (State), `features/direct-streaming.md` (Stream plays and verified sources)
- Journeys:
  - **J1** · traces R2.4 — `npm run test:int -- tests/integration/movies.streams.int.test.ts -t "R2.4"` → passes when the test passes: three reports and an `ended` report of session `sess-1` leave exactly one `movie_plays` row (source `stream`, `file_id` null, provider `VidFast`, `position_s` 600 then 7600, `ended_at` set at the end), `getTitle` gives `in_progress` (the same state a VLC play at the same reading gives) and then `finished`, and `titlesFinishedBetween` lists `movie-550`.
  - **J2** · traces R2.4 — on a run of the real daemon:
    `V=.claude/skills/verify-notesd/scripts/verify.sh; $V up --movies` (note `RUN`), `H=$(hostname)`, then
    `$V exec $RUN "insert into movie_titles (id, kind, tmdb_id, title, original_title, runtime_min) values ('movie-550','movie',550,'Fight Club','Fight Club',139)"`,
    `$V exec $RUN "insert into movie_plays (title_id, host, source, started_at, start_position_s, position_s, duration_s, provider, stream_session, updated_at) values ('movie-550','$H','stream', now() - interval '20 minutes', 0, 1200, 8340, 'VidFast', 'verify-1', now())"`,
    `$V api $RUN GET /api/movies/movie-550`, `$V api $RUN GET /api/movies`,
    `$V exec $RUN "update movie_plays set position_s = 7600, ended_at = now() where stream_session = 'verify-1'"`,
    `$V api $RUN GET /api/movies/movie-550`,
    `$V exec $RUN "insert into movie_plays (host, source, started_at, provider, stream_session) values ('$H','stream', now(), 'VidFast', 'bad')"`,
    `$V down $RUN` → passes when the first title read shows `"state":"in_progress"` with `plays[0]` `"source":"stream"`, `"provider":"VidFast"`, `"file_id":null`; the `/api/movies` list has no `movie-550`; the second title read shows `"state":"finished"`; and the last insert fails naming `movie_plays_target_check`.
  - **J3** · traces R5.4 — `npm run test:int -- tests/integration/movies.streams.int.test.ts -t "R5.4"` → passes when the test passes: after a resolved record the `movie-550` row is verified and `freshStreamTitleIds(host)` / `listStreamTitles` return `movie-550`; after a `no_source` record the row has `stale_at` and `failure: 'no_source'` with `verified_at` kept, and both lists are empty; a new resolved record brings it back.
- Neighbor check: VLC plays and the Library, which share `movie_plays`, `read.ts` and `state.ts`: `npm run test:int -- tests/integration/movies.repo.int.test.ts tests/integration/movies.api.int.test.ts tests/integration/movies.play.int.test.ts tests/integration/movies.continue.int.test.ts tests/integration/movies.mcp.int.test.ts tests/integration/movies.recents.int.test.ts tests/integration/movies.schema.int.test.ts` all pass, and on a `verify.sh up --movies` run `.claude/skills/verify-notesd/scripts/movies/journey.sh $RUN` ends with `journey: PASS (12 stages)`.
- Cost: none (no model call, no Chrome, no provider, fake TMDB).
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run test:int` and `npm run docs:check` pass; J1, J2 and J3 pass; the movies journey still passes.

## Handoffs

- **Phase 3:** the Requires list above, which phase 3's plan matches: `DIRECT_STREAM_OFF` exported; `session(id)` returns `null` for unknown or expired and carries `id`, `ref`, `source.provider`; the builder's optional `hooks` (`DirectStreamHooks`), with `recordResolve` **awaited** after every `resolve()`/`play()`/`refresh()` resolve before answering, and `resumeS` for `resume_s`; the session id kept across `refresh`.
- **Phase 6:** a TMDB miss (verify's fake TMDB has no 550) records nothing and `POST /api/stream/play` still answers 200 (Step 8); the position route then answers 404 `unknown_title`, which the page ignores. Phase 6 needs nothing else from this phase and does not depend on it.
- **Phase 7 (R3):** `src/mcp/movieTools.ts:186` finds a title by name through `listTitles`, which now leaves out stream-only titles; pass `scope: 'all'` there so "rate Saltburn" finds a film the owner only streamed. The `movies_get` / `movies_history` descriptions (`movieTools.ts:389,394`) list play sources `live` and `vlc_recents` only; add `stream` and `provider`, then `npm run docs:gen`. `movies_continue` / `continueTitle` (`src/movies/continue.ts`) consider files only and ignore stream plays (a streamed film is not resumed by continue, and "continue" with no title follows the newest VLC play); `direct_stream_play` can resume through phase 3's `resumeS`.
- **Phase 9 (R5):** `GET /api/movies/stream` calls `listStreamTitles(db, filter, ctx, streamFreshSince(now, config.directStream.freshDays))` (`src/movies/read.ts`, `src/movies/repo.ts`). The title page's stream block reads `TitleDetail.stream_sources` (Step 6b: this host's verified rows) and phase 9's route adds `fresh` per row with `isFreshStreamSource` and `streamFreshSince`, the one freshness rule (phase 9 defines none of its own). The `GET /api/movies/:id` sentence about `stream_sources` in `httpRoutes.ts` is this phase's; phase 9 describes `fresh` in its own route's entry. Widen the web copies of the wire types in `web/src/moviesApi.ts`: `PlayView.file_id` and `file_name` nullable, `source` `'stream'`, new `provider`; `MovieChangeEvent.reason` `'stream'`. The page half of R5.4 (the title leaving the grid on screen) and an end-to-end test through `POST /api/stream/play` with a fake runner (which also proves the Step 10 wiring) are phase 9's.
- **Phase 10 (R6):** each prober resolve goes through `resolve()` and so through the hooks, so a failed candidate stores its title and a stale-only row (the title stays out of the Library). Its `ProbeRepo` counts and excludes fresh titles with `freshStreamSourceSql` and `streamFreshSince` (the one rule; it defines none of its own). The prober's "oldest first" re-check orders this host's verified, not stale `movie_stream_sources` rows by `verified_at` (reads are fine anywhere; writes stay in the repo).
- **Phase 7 (R3):** `direct_stream_find`'s "fresh verified source" is `MoviesRepo.streamSourcesOfTitle(titleId, host)` filtered with `isFreshStreamSource(row, host, streamFreshSince(now, freshDays))` for the film's (0, 0) or the episode's row.

## Rollback

Revert this phase's commits. Migration `0021` stays applied and is harmless to the old code: it
only adds a table and nullable columns, relaxes `file_id`'s `NOT NULL` and widens a check; the old
readers inner-join files, so stream rows are invisible to them (stream-only titles would show in
the old Library grid). To drop the data as well: `drop table movie_stream_sources; delete` nothing
from `movie_plays` (play events are never deleted); the columns can stay.
