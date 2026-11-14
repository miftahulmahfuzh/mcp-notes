# Phase 4: HTTP API: read model, user state, review note, manual fix, SSE

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R1, R2, R3 — the owner (and phases 6 and 7) can read the library over HTTP with per-file state, host availability and loadable poster URLs, set watched / rating / review, and fix an unmatched file by hand
**Criteria:** R1.5, R2.4, R3.6, R3.7
**Depends on:** Phase 3 (and through it phases 1 and 2)
**Difficulty:** NORMAL
**Package:** `src/movies`, `src/http`

---

## Goal

After this phase every route in the contract's `src/http/moviesApi.ts` list answers. `src/movies/read.ts` returns the
read model: titles with a derived `state`, per-file `available` and absolute TMDB `poster_url`s. `src/movies/reviewNote.ts`
keeps the review as a real `#movie` note. The unmatched list, the TMDB search behind the manual fix, `assign`, the
watched flags, `sync` and the `changed` SSE stream all work over HTTP. With `deps.movies === null` every route answers
503 `movies_off`.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/movies/read.ts`: `listTitles`, `getTitle`, `listUnmatched`, `history`, `statusCounts`, `searchHitViews`,
  `ReadContext`, `TitleFilter`, `HistoryFilter`, `TitleSort`, `TITLE_SORTS`, `WATCH_STATES`, `IMAGE_SIZES`,
  `DEFAULT_LIST_LIMIT`, `MAX_LIST_LIMIT`, `DEFAULT_HISTORY_LIMIT`, `MAX_HISTORY_LIMIT`, `DETAIL_PLAY_LIMIT`, and the
  wire types `TitleListItem`, `TitleProgress`, `TitleDetail`, `SeasonView`, `EpisodeView`, `FileView`, `ProgressView`,
  `PlayView`, `UnmatchedFile`, `ParsedView`, `CompanyView`, `CrewCredit`, `CastCredit`, `TmdbHitView`, `StatusCounts`,
  `FileSource`, `PlaySource`, `UnavailableReason`.
- `src/movies/reviewNote.ts`: `saveReview`, `reviewHeader`, `reviewBody`, `reviewText`, `REVIEW_TAG`,
  `MAX_REVIEW_CHARS`, `SavedReview`.
- `src/http/moviesApi.ts` (body; phase 1 made the file): `moviesApiRoutes(deps, options?)`, `MoviesApiOptions`,
  the response types `TitleListResponse`, `UnmatchedResponse`, `MoviesStatusResponse`, `TmdbSearchResponse`,
  `FileChangeResponse`, `SyncResponse`, `MovieChangeWire`.
- `tests/integration/helpers/moviesSeed.ts` (seed rows + fake TMDB, reusable by phase 7's MCP tests),
  `tests/integration/movies.api.int.test.ts`, `tests/unit/movies/reviewNote.test.ts`.

**Signature changes (against the index's contract text):**
- `getTitle(db, id, host)` -> `getTitle(db, id, ctx: ReadContext)` and `listUnmatched(db, host)` ->
  `listUnmatched(db, ctx: ReadContext)`, where `ReadContext = { host: string; imageBase: string }`. The read model
  builds poster URLs, so it needs `config.movies.tmdb.imageBase` as well as the host. `listTitles(db, filter)` ->
  `listTitles(db, filter, ctx)`. `history(db, filter)` is unchanged (plays carry no URL or availability).
  Phase 7 calls these with `{ host: movies.host, imageBase: config.movies.tmdb.imageBase }`.
- `moviesApiRoutes(deps)` -> `moviesApiRoutes(deps, options: MoviesApiOptions = {})`. The new argument is optional,
  so phase 1's `app.route('/', moviesApiRoutes(deps))` in `src/http/app.ts` still compiles and is not edited.
- `saveReview(service, notes, titleId, text)` keeps its order. `service` is typed `Pick<MoviesService, 'repo'>`, and
  it returns `Promise<SavedReview | null>` (null = no such title).

**Requires (from earlier phases).** These are the names and shapes this plan is written against. If a landed phase
differs, adapt the call site and leave the wire unchanged.
- Phase 1, `src/db/schema.ts`: Drizzle objects `movieTitles`, `movieFiles`, `moviePlays`, `movieEpisodes`,
  `movieCompanies`, `movieTitleCompanies`, `moviePeople`, `movieCredits`. Their TypeScript properties are the camelCase
  of the contract's SQL columns (`titleId`, `deletedAt`, `durationS`, `positionS`, `reviewNoteId`, `posterPath`,
  `absoluteEpisode`, `firstSeenAt`, ...), which is the repo's convention. Timestamps use `mode: 'date'`. Ids of
  `movie_files` / `movie_plays` / `movie_credits` use `mode: 'number'`. `read.ts` only reads these tables.
- Phase 1, `src/movies/types.ts`: `TitleKind`, `FileStatus`, `FileReason`, `WatchState` (the six values),
  `titleId(kind, tmdbId)`.
- Phase 1, `src/movies/state.ts`: `FINISHED_RATIO`, `fileState(fileRow, lastPlayRow | null)`,
  `titleState(kind, states: WatchState[], watched = false)`, `resumePosition(fileRow, lastPlayRow | null): number`. The rows are
  `typeof movieFiles.$inferSelect` / `typeof moviePlays.$inferSelect`.
- Phase 1, `src/movies/repo.ts` `MoviesRepo`: `titleById(id): Promise<TitleRow | null>`,
  `fileById(id: number): Promise<FileRow | null>`,
  `setTitleUser(titleId, patch: TitleUserPatch)` (`{ watched?, rating?, reviewNoteId? }`; an absent key is left alone;
  `watched: true` sets `watched_at` (now, or kept if already set), `false` clears it), `setFileWatched(fileId, watched)`
  (unsetting also clears the done signal). `lastPlay(fileId)` orders by `(position_s is not null) desc, started_at desc,
  id desc` (the newest play with a known position, else the newest). `read.ts` uses the same order in its batched
  `distinct on` (reconciled against phase 1's code).
- Phase 1: `deps.movies: MoviesService | null` in `AppDeps`, `config.movies.tmdb.imageBase` in `Config`, and the
  integration api-harness (`tests/integration/helpers/api-harness.ts`) building `AppDeps` with `movies: null` and
  `config.movies: DEFAULT_MOVIES_CONFIG`.
- Phase 2, `src/movies/tmdb.ts`: `TmdbClient` with `searchMovie(query: string, year?: number | null)` and
  `searchTv(query: string, year?: number | null)`, both returning `Promise<TmdbSearchHit[]>`, where
  `TmdbSearchHit = { kind: TitleKind; tmdbId: number; title: string; originalTitle: string; year: number | null;
  overview: string; posterPath: string | null; popularity: number }`. Also `TmdbError extends Error` and
  `posterUrl(imageBase, path, size)`, which returns `` `${imageBase}/${size}${path}` ``. `ParsedName` comes from
  `src/movies/parse.ts`, with the fields `title, year, season, episode, absoluteEpisode, kindHint`.
- Phase 1/2: `TitleMetadata` (types.ts) with the fields `kind, tmdbId, title, originalTitle, year, releaseDate,
  overview, posterPath, backdropPath, runtimeMin, genres, seasonCount, episodeCount, companies, credits, episodes`.
  This shape is used only by the test fake in `moviesSeed.ts`. If the landed type differs, fix that one literal.
- Phase 3, `src/movies/service.ts` (reconciled to phase 3's code): the `MoviesService` members `host: string`,
  `repo: MoviesRepo`, `tmdb: TmdbClient | null` (null without credentials), `events: MovieEvents`,
  `syncNow(): Promise<SyncReport>`, `status(): MoviesStatus` (synchronous), `assign(fileId, target: AssignTarget):
  Promise<MovieFileRow>` (`AssignTarget = { kind; tmdbId; season?; episode? }`; it stores the title when new, sets the
  file `matched`, emits `changed('assign', ...)` itself, and throws `MoviesServiceError` with code `not_found`,
  `no_tmdb_credentials` (title not stored and no credential) or `tmdb_unreachable`), and `close()`. Also
  `buildMoviesService(config: Config, db: Db, overrides?: MoviesServiceOverrides): MoviesService | null` (null only with
  `NOTESD_MOVIES=off`; built, but never scanning, with empty roots).
- Phase 3, `MovieEvents`: `changed(reason: MovieChangeReason, ids?: { titleIds?; fileIds? })`,
  `on(listener: (event: MovieChangeEvent) => void): () => void`, `listenerCount()`.
  `MovieChangeEvent = { type: 'changed'; reason: 'sync' | 'assign' | 'user' | 'play'; title_ids: string[]; file_ids: number[] }`.
  Phase 4 emits `user` after user-state writes; `assign` is emitted by `service.assign`; the SSE `data:` is the event as-is.
- Phase 3, `MoviesStatus` (what `status()` returns, passed through unchanged; phase 6 mirrors exactly these fields):
  `{ host: string; roots: string[]; done_dirs: string[]; scan_ms: number; min_seconds: number; scanning: boolean;
  running: boolean; tmdb: 'ok' | 'no_credentials' | 'unreachable'; next_pass_at: string | null; last_pass: SyncReport | null }`,
  `SyncReport` as phase 3 defines it (`new`, `moved`, `deleted`, `done`, `matched`, `unmatched`, `pending`, `waiting`,
  `scanned`, `titles_fetched`, `hook_writes`, `error`, ...).

**Leaves alone (owned by others):** `src/http/app.ts` (phase 1 mounted the router), `src/http/moviesPlayApi.ts` and the
play route's `not_on_this_machine` (phase 5), `src/movies/{types,state,repo}.ts` (1), `parse/tmdb/match/fallback.ts` (2),
`scan/sync/service.ts` (3), `vlc/*`, `player.ts`, `continue.ts` (5), `web/` (6), `src/mcp/*`, `src/chat/*` (7), docs
and `.claude/skills/verify-notesd/features/*` (8), `src/db/schema.ts` and `drizzle/`.

### HTTP routes (the wire contract phases 6 and 7 build on)

Every route answers `503 { error: 'movies_off', message }` when `deps.movies === null`. Writes are `sameOriginOnly`, so
a missing or foreign `Origin` gets `403 { error: 'forbidden_origin' }`. Validation errors are
`400 { error: '<path>: <message>' }` (`describeIssues`), and invalid JSON is `400 { error: 'invalid_json' }`.

The `:id` param is registered as `:id{[a-z]+-[0-9]+}` and `:fileId` as `:fileId{[0-9]+}`. A path that does not have
that shape is never matched here, so phase 5's `GET /api/movies/player` and `POST /api/movies/continue` reach their
own router whatever the mount order.

| Method + path | Input | 200 body | Errors |
|---|---|---|---|
| `GET /api/movies` | query `q`, `state` (a `WatchState`), `kind` (`movie`/`tv`), `company` (TMDB id or name fragment), `person` (TMDB id or name fragment), `finished_from`, `finished_to` (`YYYY-MM-DD` local day or ISO datetime; `to` is inclusive of that day), `sort` (`recent` default, `title`, `year`, `rating`), `limit` (1..5000, default 1000). Empty params are ignored | `TitleListResponse` `{ titles: TitleListItem[] }` | 400 |
| `GET /api/movies/unmatched` | none | `UnmatchedResponse` `{ files: UnmatchedFile[] }` (this host, not deleted, status `unmatched` or `pending`, newest `last_seen_at` first) | none |
| `GET /api/movies/status` | none | `MoviesStatusResponse` = `MoviesStatus & { counts: StatusCounts }` | none |
| `GET /api/movies/search-tmdb` | query `q` (1..200, required), `kind` (`movie`/`tv`; absent = both, movies first), `year` (1870..2100) | `TmdbSearchResponse` `{ results: TmdbHitView[] }` | 400; 503 `{ error: 'tmdb_off', message }` without credentials; 502 `{ error: 'tmdb_error', message }` |
| `GET /api/movies/events` | none | SSE: `: connected`, then `event: changed` with `data: MovieChangeWire` = phase 3's `MovieChangeEvent` `{ type: 'changed', reason: 'sync' \| 'assign' \| 'user' \| 'play', title_ids: string[], file_ids: number[] }`, and `: heartbeat` every 25 s. Phase 5 emits `play` on play start and end only, never per position poll | none |
| `GET /api/movies/:id` | `id` = `movie-<n>` / `tv-<n>` | `TitleDetail` | 400 `invalid_id`; 404 `not_found` |
| `POST /api/movies/:id/user` | `{ watched?: boolean, rating?: 0..5 integer \| null, review?: string (≤ 20000) }`, at least one key, nothing else | `TitleDetail` (after the write) | 400, 403, 404 |
| `POST /api/movies/files/:fileId/watched` | `{ watched: boolean }` | `FileChangeResponse` `{ file_id: number, title: TitleDetail \| null }` (null for a file with no title) | 400, 403, 404 |
| `POST /api/movies/files/:fileId/assign` | `{ kind: 'movie', tmdb_id }` or `{ kind: 'tv', tmdb_id, season?, episode? }` (season and episode come together) | `FileChangeResponse` with the assigned title's detail | 400, 403, 404, 502 `tmdb_error` (`MoviesServiceError` `tmdb_unreachable`), 503 `tmdb_off` (`no_tmdb_credentials`: no credential and the title is not stored yet) |
| `POST /api/movies/sync` | query `wait=true` (optional) | without `wait`: `202 SyncResponse { started: true, report: null }`; with `wait`: `200 { started: true, report: SyncReport }` | 403 |

### Wire types (exported from `src/movies/read.ts`; the snake_case keys are the JSON)

```ts
type WatchState = 'finished' | 'in_progress' | 'unwatched' | 'dropped' | 'removed_unwatched' | 'seen';
type UnavailableReason = 'not_on_this_machine' | 'deleted';

interface ProgressView { position_s: number | null; duration_s: number | null; ratio: number | null } // ratio 0..1

type TitleProgress =
  | { kind: 'movie'; position_s: number | null; duration_s: number | null; ratio: number | null }
  | { kind: 'tv'; episodes_finished: number; episodes_total: number | null; episodes_present: number };

interface TitleListItem {            // one poster in the grid
  id: string; kind: 'movie' | 'tv'; tmdb_id: number; title: string; year: number | null;
  poster_url: string | null;         // absolute https://image.tmdb.org/t/p/w342/... (w500 in TitleDetail)
  state: WatchState;                 // 'finished' when the title's watched flag is set, else titleState()
  watched: boolean; watched_at: string | null; rating: number | null;
  progress: TitleProgress;
  last_played_at: string | null;     // newest play start over all its files, any host
  finished_at: string | null;        // latest moment the title or any of its files became finished
  present_here: boolean;             // some file is on this host and not deleted
  file_count: number; deleted_file_count: number;
  created_at: string;
}

interface TitleDetail extends TitleListItem {
  original_title: string; release_date: string | null; overview: string; runtime_min: number | null;
  genres: string[]; backdrop_url: string | null; season_count: number | null; episode_count: number | null;
  review: string;                    // the note's text without its header and #movie line; '' when none
  review_note_id: string | null;     // only while that note is live
  companies: CompanyView[];
  directors: CrewCredit[]; writers: CrewCredit[]; producers: CrewCredit[]; creators: CrewCredit[];
  cast: CastCredit[];
  files: FileView[];                 // every file, any host, deleted included
  seasons: SeasonView[];             // tv: ascending; movie: []
  unplaced_files: FileView[];        // tv files with no season/episode (absolute mapping failed); movie: []
  plays: PlayView[];                 // newest first, at most 50
  metadata_fetched_at: string | null;
}

interface SeasonView { season: number; episodes: EpisodeView[] }
interface EpisodeView {
  season: number; episode: number; name: string | null; air_date: string | null; runtime_min: number | null;
  overview: string | null; still_url: string | null;
  state: WatchState;                 // 'finished' if any of its files is; else its primary file's; 'unwatched' with no file
  has_file: boolean; present_here: boolean;
  deleted: boolean;                  // it has files and every one is deleted
  progress: ProgressView; last_played_at: string | null; finished_at: string | null;
  file_id: number | null;            // the primary file (what Play acts on)
  files: FileView[];
}

interface FileView {
  id: number; title_id: string | null; host: string; path: string; name: string;
  size: number | null; duration_s: number | null;
  season: number | null; episode: number | null; absolute_episode: number | null;
  status: 'matched' | 'unmatched' | 'pending'; reason: FileReason | null; source: 'scan' | 'vlc_recents';
  first_seen_at: string; last_seen_at: string; deleted_at: string | null; moved_at: string | null;
  done_at: string | null; watched_at: string | null;
  deleted: boolean;
  available: boolean;                // host === this host && not deleted (R3.7)
  unavailable_reason: UnavailableReason | null; // 'deleted' wins over 'not_on_this_machine'
  state: WatchState; progress: ProgressView; resume_position_s: number;
  last_played_at: string | null; finished_at: string | null;
}

interface PlayView {
  id: number; file_id: number; title_id: string | null; title: string | null; kind: 'movie' | 'tv' | null;
  season: number | null; episode: number | null; episode_name: string | null; // from movie_episodes; null for a film
  file_name: string; file_deleted: boolean; file_deleted_at: string | null; host: string;
  source: 'live' | 'vlc_recents'; started_at: string; ended_at: string | null;
  start_position_s: number | null; position_s: number | null; duration_s: number | null; ratio: number | null;
}

interface UnmatchedFile {
  id: number; host: string; path: string; name: string; size: number | null; duration_s: number | null;
  status: 'unmatched' | 'pending'; reason: FileReason | null; parsed: ParsedView | null;
  first_seen_at: string; last_seen_at: string; available: boolean;
}
interface ParsedView { title: string; year: number | null; season: number | null; episode: number | null;
  absolute_episode: number | null; kind_hint: 'movie' | 'tv' | null }

interface CompanyView { id: number; name: string; logo_url: string | null; origin_country: string | null }
interface CrewCredit { person_id: number; name: string; profile_url: string | null; job: string | null } // jobs joined ', '
interface CastCredit { person_id: number; name: string; profile_url: string | null; character: string | null } // characters joined ' / '
interface TmdbHitView { kind: 'movie' | 'tv'; tmdb_id: number; title_id: string; title: string; original_title: string;
  year: number | null; overview: string; poster_url: string | null; in_library: boolean }
interface StatusCounts { titles: number; files_here: number; unmatched_here: number; pending_here: number }
```

Image sizes: grid poster `w342`, detail poster `w500`, backdrop `w1280`, profile `w185`, company logo `w92`, episode
still `w300`. Each URL is `posterUrl(config.movies.tmdb.imageBase, path, size)`, an absolute TMDB CDN URL that does not
depend on which host holds the files (R2.4).

## Files

| File | Action | What changes |
|---|---|---|
| `src/movies/reviewNote.ts` | create | review body format, `reviewText`, `saveReview` through `NotesService` |
| `src/movies/read.ts` | create | the read model and every wire type above |
| `src/http/moviesApi.ts` | replace body (phase 1's empty router, whole file) | the ten routes |
| `tests/unit/movies/reviewNote.test.ts` | create | body/text round trip |
| `tests/integration/helpers/moviesSeed.ts` | create | `truncateMovies`, `seedLibrary`, `fakeTmdb`, `MOVIES_TEST_CONFIG` |
| `tests/integration/movies.api.int.test.ts` | create | every route over HTTP against seeded rows |

## Implementation Steps

### Step 1: Review note module
**File:** `src/movies/reviewNote.ts` (new)
**Change:** the body format of the linked note and the one write path. The note is a normal note: header line, the
owner's text, then a `#movie` line. The detail page shows only the text. An emptied review rewrites the note to header
plus tag. Nothing is soft-deleted, and the note keeps its id and revisions. A linked note the owner deleted in the wall
is left in the bin, and the next non-empty save creates a new note and relinks it.
**Code:**
```ts
import type { NotesService } from '../notes/service.js';
import type { MoviesService } from './service.js';

/** The tag every review note carries (R3.6: "a normal note linked to the title"). */
export const REVIEW_TAG = 'movie';
/** Longest review text the API accepts. */
export const MAX_REVIEW_CHARS = 20_000;

const HEADER_PREFIX = 'Review of ';

/** First line of a review note: names the title so full-text search and /n find it. */
export function reviewHeader(title: string, year: number | null): string {
  return `${HEADER_PREFIX}${title}${year !== null ? ` (${year})` : ''}`;
}

/** The whole note body for `text`. An empty text keeps the header and the tag, so the note stays non-empty. */
export function reviewBody(header: string, text: string): string {
  const t = text.trim();
  return t === '' ? `${header}\n\n#${REVIEW_TAG}` : `${header}\n\n${t}\n\n#${REVIEW_TAG}`;
}

function isReviewTagLine(line: string): boolean {
  const words = line.trim().split(/\s+/).filter((w) => w !== '');
  return (
    words.length > 0 &&
    words.every((w) => /^#[A-Za-z0-9_-]+$/.test(w)) &&
    words.some((w) => w.toLowerCase() === `#${REVIEW_TAG}`)
  );
}

/**
 * The review text shown in the detail page's one field: the body without our header line and without the trailing
 * tags-only line that holds #movie. A note edited elsewhere (/n, the wall) shows whatever text it now has.
 */
export function reviewText(body: string): string {
  const lines = body.split('\n');
  if (lines[0] !== undefined && lines[0].startsWith(HEADER_PREFIX)) lines.shift();
  for (;;) {
    const last = lines[lines.length - 1];
    if (last === undefined) break;
    if (last.trim() === '' || isReviewTagLine(last)) lines.pop();
    else break;
  }
  return lines.join('\n').trim();
}

export interface SavedReview {
  review: string;
  review_note_id: string | null;
}

/**
 * Creates or updates the title's review note through NotesService (invariant 6) and stores its id with
 * MoviesRepo.setTitleUser. Returns null when the title does not exist.
 * - linked note live: update it (no write when the body is unchanged); an empty text clears the text, keeps the note.
 * - no live linked note and empty text: nothing is written.
 * - no live linked note and some text: create a note (origin source 'movies') and link it.
 */
export async function saveReview(
  service: Pick<MoviesService, 'repo'>,
  notes: NotesService,
  titleId: string,
  text: string,
): Promise<SavedReview | null> {
  const title = await service.repo.titleById(titleId);
  if (title === null) return null;
  const body = reviewBody(reviewHeader(title.title, title.year), text);
  const current = title.reviewNoteId !== null ? await notes.getOne(title.reviewNoteId) : null;
  if (current !== null) {
    const note = current.body === body ? current : await notes.update(current.id, body);
    return { review: reviewText(note.body), review_note_id: note.id };
  }
  if (text.trim() === '') return { review: '', review_note_id: null };
  const note = await notes.create({ body, origin: { source: 'movies' } });
  await service.repo.setTitleUser(titleId, { reviewNoteId: note.id });
  return { review: reviewText(note.body), review_note_id: note.id };
}
```
**Impact:** new file. It writes notes only through `NotesService`, which emits the note event and keeps revisions.

### Step 2: Unit test for the review text
**File:** `tests/unit/movies/reviewNote.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { parseTags } from '../../../src/notes/tags.js';
import { reviewBody, reviewHeader, reviewText } from '../../../src/movies/reviewNote.js';

describe('review note body', () => {
  const header = reviewHeader('How to Make a Killing', 2026);

  it('names the title and year in the header', () => {
    expect(header).toBe('Review of How to Make a Killing (2026)');
    expect(reviewHeader('MobLand', null)).toBe('Review of MobLand');
  });

  it('round-trips the text and carries #movie', () => {
    const body = reviewBody(header, '  Great twist.\n\nSecond paragraph.  ');
    expect(body).toBe('Review of How to Make a Killing (2026)\n\nGreat twist.\n\nSecond paragraph.\n\n#movie');
    expect(parseTags(body)).toEqual(['movie']);
    expect(reviewText(body)).toBe('Great twist.\n\nSecond paragraph.');
  });

  it('an emptied review keeps a non-empty, tagged body with no text', () => {
    const body = reviewBody(header, '   ');
    expect(body).toBe('Review of How to Make a Killing (2026)\n\n#movie');
    expect(parseTags(body)).toEqual(['movie']);
    expect(reviewText(body)).toBe('');
  });

  it('shows a note edited elsewhere as it is, keeping inline hashtags', () => {
    expect(reviewText('Rewatched it, still #great\n\n#movie #rewatch')).toBe('Rewatched it, still #great');
    expect(reviewText('no header, no tag line')).toBe('no header, no tag line');
  });
});
```
**Impact:** runs in `npm test`. No database.

### Step 3: Read model
**File:** `src/movies/read.ts` (new)
**Change:** batched reads: one query for the titles, one for their files, one `distinct on` for the last play of each
file, one for the episodes of tv titles. The number of queries does not grow with the number of titles. Only reads
here: `MoviesRepo` stays the only writer (invariant 2). State comes from phase 1's `state.ts`. The title's manual
watched flag overrides it.
**Code:**
```ts
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
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
  notes,
} from '../db/schema.js';
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
}

function emptyParts(): TitleParts {
  return { files: [], episodes: [] };
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
  return parts;
}

interface EpisodeSlot {
  row: EpisodeRow | null;
  season: number;
  episode: number;
  files: FileView[];
}

function episodeView(slot: EpisodeSlot, ctx: ReadContext): EpisodeView {
  const primary = primaryFile(slot.files);
  return {
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
    .map((s) => episodeView(s, ctx));
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
    .select({ play: moviePlays, file: movieFiles, titleName: movieTitles.title, titleKind: movieTitles.kind, episodeName: movieEpisodes.name })
    .from(moviePlays)
    .innerJoin(movieFiles, eq(movieFiles.id, moviePlays.fileId))
    .leftJoin(movieTitles, eq(movieTitles.id, movieFiles.titleId))
    .leftJoin(
      movieEpisodes,
      and(eq(movieEpisodes.titleId, movieFiles.titleId), eq(movieEpisodes.season, movieFiles.season), eq(movieEpisodes.episode, movieFiles.episode)),
    )
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(desc(moviePlays.startedAt), desc(moviePlays.id))
    .limit(limit);
  return rows.map(({ play, file, titleName, titleKind, episodeName }) => {
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
    parsed: parsedView((row.parsed ?? null) as ParsedName | null),
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
```
**Impact:** new file, read-only. If phase 1 types a column differently from the Requires list (for example
`genres` as `unknown`), the cast or the `?? []` is the only line to adjust. The wire types stay as written.

### Step 4: The router
**File:** `src/http/moviesApi.ts`. Replace the whole file. Phase 1 left an empty `moviesApiRoutes(deps)` that returns
`new Hono()`.
**Change:** ten routes, a per-route `withMovies` guard and no `use()` middleware, plus regex-constrained params (see
Principles applied).
**Code:**
```ts
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import {
  getTitle,
  listTitles,
  listUnmatched,
  MAX_LIST_LIMIT,
  searchHitViews,
  statusCounts,
  TITLE_SORTS,
  WATCH_STATES,
  type ReadContext,
  type StatusCounts,
  type TitleDetail,
  type TitleListItem,
  type TmdbHitView,
  type UnmatchedFile,
} from '../movies/read.js';
import { MAX_REVIEW_CHARS, saveReview } from '../movies/reviewNote.js';
import { MoviesServiceError, type MovieChangeEvent, type MoviesService } from '../movies/service.js';
import { TmdbError } from '../movies/tmdb.js';
import { titleId as makeTitleId } from '../movies/types.js';
import { parseDateBound } from '../notes/dates.js';
import { NoteError } from '../notes/types.js';
import { describeIssues, readJson, SSE_HEARTBEAT_MS } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * /api/movies/* (MOVIES_LIBRARY_PLAN phase 4): the read model, user state (watched, rating, review note), the
 * unmatched list and its manual fix, a sync trigger and the `changed` stream. Phase 5's play routes live in
 * moviesPlayApi.ts. Path params are regex-constrained, so `/api/movies/player` and `/api/movies/continue` never
 * match here. Every route answers 503 movies_off without a MoviesService; writes are same-origin only.
 */

export interface MoviesApiOptions {
  /** Defaults to SSE_HEARTBEAT_MS. Tests pass a small value. */
  sseHeartbeatMs?: number;
}

export interface TitleListResponse {
  titles: TitleListItem[];
}
export interface UnmatchedResponse {
  files: UnmatchedFile[];
}
export type MoviesStatusResponse = Awaited<ReturnType<MoviesService['status']>> & { counts: StatusCounts };
export interface TmdbSearchResponse {
  results: TmdbHitView[];
}
export interface FileChangeResponse {
  file_id: number;
  title: TitleDetail | null;
}
export interface SyncResponse {
  started: true;
  report: Awaited<ReturnType<MoviesService['syncNow']>> | null;
}
/** `data:` of each `event: changed`: phase 3's event, unchanged. */
export type MovieChangeWire = MovieChangeEvent;

const MOVIES_OFF = {
  error: 'movies_off',
  message: 'The movies library is off on this machine (NOTESD_MOVIES=off).',
} as const;

const TMDB_OFF = {
  error: 'tmdb_off',
  message: 'No TMDB credentials (TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY) on this machine.',
} as const;

const TITLE_PATH = '/api/movies/:id{[a-z]+-[0-9]+}';
const USER_PATH = '/api/movies/:id{[a-z]+-[0-9]+}/user';
const FILE_WATCHED_PATH = '/api/movies/files/:fileId{[0-9]+}/watched';
const FILE_ASSIGN_PATH = '/api/movies/files/:fileId{[0-9]+}/assign';

const titleIdSchema = z.string().regex(/^(?:movie|tv)-[1-9][0-9]{0,9}$/);
const fileIdSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const textParam = z.string().trim().min(1).max(200);
const dateParam = z.string().trim().min(1).max(40);

const listQuery = z.object({
  q: textParam.optional(),
  state: z.enum(WATCH_STATES).optional(),
  kind: z.enum(['movie', 'tv']).optional(),
  company: textParam.optional(),
  person: textParam.optional(),
  finished_from: dateParam.optional(),
  finished_to: dateParam.optional(),
  sort: z.enum(TITLE_SORTS).default('recent'),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

const searchQuery = z.object({
  q: textParam,
  kind: z.enum(['movie', 'tv']).optional(),
  year: z.coerce.number().int().min(1870).max(2100).optional(),
});

const userBody = z
  .object({
    watched: z.boolean().optional(),
    rating: z.number().int().min(0).max(5).nullable().optional(),
    review: z.string().max(MAX_REVIEW_CHARS).optional(),
  })
  .strict()
  .refine((b) => b.watched !== undefined || b.rating !== undefined || b.review !== undefined, {
    message: 'set at least one of watched, rating, review',
  });

const watchedBody = z.object({ watched: z.boolean() }).strict();

const tmdbIdSchema = z.number().int().positive().max(2_147_483_647);
/** A movie has no slot; a tv slot is a season and an episode together, or neither. */
const assignBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('movie'), tmdb_id: tmdbIdSchema }).strict(),
  z
    .object({
      kind: z.literal('tv'),
      tmdb_id: tmdbIdSchema,
      season: z.number().int().min(0).max(999).optional(),
      episode: z.number().int().min(0).max(99_999).optional(),
    })
    .strict()
    .refine((b) => (b.season === undefined) === (b.episode === undefined), {
      message: 'season and episode go together',
      path: ['episode'],
    }),
]);

/** A query param, with an empty value treated as absent. */
function qp(c: Context, name: string): string | undefined {
  const v = c.req.query(name);
  return v === undefined || v.trim() === '' ? undefined : v;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function moviesApiRoutes(
  deps: Pick<AppDeps, 'config' | 'db' | 'service' | 'movies'>,
  options: MoviesApiOptions = {},
): Hono {
  const api = new Hono();
  const db = deps.db;
  const heartbeatMs = options.sseHeartbeatMs ?? SSE_HEARTBEAT_MS;

  /** The movies_off guard, per route: a `use('/api/movies/*')` middleware would also catch phase 5's play routes. */
  function withMovies(handler: (c: Context, movies: MoviesService, ctx: ReadContext) => Promise<Response>) {
    return async (c: Context): Promise<Response> => {
      const movies = deps.movies;
      if (movies === null) return c.json(MOVIES_OFF, 503);
      return handler(c, movies, { host: movies.host, imageBase: deps.config.movies.tmdb.imageBase });
    };
  }

  async function detailResponse(c: Context, id: string, ctx: ReadContext): Promise<Response> {
    const detail = await getTitle(db, id, ctx);
    return detail === null ? c.json({ error: 'not_found' }, 404) : c.json(detail);
  }

  function tmdbFailed(c: Context, err: TmdbError): Response {
    return c.json({ error: 'tmdb_error', message: err.message }, 502);
  }

  api.get(
    '/api/movies',
    withMovies(async (c, _movies, ctx) => {
      const parsed = listQuery.safeParse({
        q: qp(c, 'q'),
        state: qp(c, 'state'),
        kind: qp(c, 'kind'),
        company: qp(c, 'company'),
        person: qp(c, 'person'),
        finished_from: qp(c, 'finished_from'),
        finished_to: qp(c, 'finished_to'),
        sort: qp(c, 'sort'),
        limit: qp(c, 'limit'),
      });
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const p = parsed.data;
      let finishedFrom: Date | undefined;
      let finishedTo: Date | undefined;
      try {
        finishedFrom = p.finished_from === undefined ? undefined : parseDateBound(p.finished_from, 'from');
        finishedTo = p.finished_to === undefined ? undefined : parseDateBound(p.finished_to, 'to');
      } catch (err) {
        if (err instanceof NoteError) return c.json({ error: `finished_from/finished_to: ${err.message}` }, 400);
        throw err;
      }
      const titles = await listTitles(
        db,
        {
          ...(p.q !== undefined ? { q: p.q } : {}),
          ...(p.state !== undefined ? { state: p.state } : {}),
          ...(p.kind !== undefined ? { kind: p.kind } : {}),
          ...(p.company !== undefined ? { company: p.company } : {}),
          ...(p.person !== undefined ? { person: p.person } : {}),
          ...(finishedFrom !== undefined ? { finishedFrom } : {}),
          ...(finishedTo !== undefined ? { finishedTo } : {}),
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
          sort: p.sort,
        },
        ctx,
      );
      const body: TitleListResponse = { titles };
      return c.json(body);
    }),
  );

  api.get(
    '/api/movies/unmatched',
    withMovies(async (c, _movies, ctx) => {
      const body: UnmatchedResponse = { files: await listUnmatched(db, ctx) };
      return c.json(body);
    }),
  );

  api.get(
    '/api/movies/status',
    withMovies(async (c, movies, ctx) => {
      const [status, counts] = await Promise.all([movies.status(), statusCounts(db, ctx)]);
      const body: MoviesStatusResponse = { ...status, counts };
      return c.json(body);
    }),
  );

  api.get(
    '/api/movies/search-tmdb',
    withMovies(async (c, movies, ctx) => {
      const parsed = searchQuery.safeParse({ q: qp(c, 'q'), kind: qp(c, 'kind'), year: qp(c, 'year') });
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const tmdb = movies.tmdb;
      if (tmdb === null) return c.json(TMDB_OFF, 503);
      const { q, kind, year } = parsed.data;
      try {
        const [films, shows] = await Promise.all([
          kind !== 'tv' ? tmdb.searchMovie(q, year ?? null) : Promise.resolve([]),
          kind !== 'movie' ? tmdb.searchTv(q, year ?? null) : Promise.resolve([]),
        ]);
        const body: TmdbSearchResponse = { results: await searchHitViews(db, [...films, ...shows], ctx) };
        return c.json(body);
      } catch (err) {
        if (err instanceof TmdbError) return tmdbFailed(c, err);
        throw err;
      }
    }),
  );

  api.get('/api/movies/events', (c) => {
    const movies = deps.movies;
    if (movies === null) return c.json(MOVIES_OFF, 503);
    const events = movies.events;
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = events.on((change: MovieChangeEvent) => {
        if (closed) return;
        const wire: MovieChangeWire = change;
        void stream.writeSSE({ event: 'changed', data: JSON.stringify(wire) }).catch(() => undefined);
      });
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(timer);
          unsubscribe();
          resolve();
        });
        void stream.write(': connected\n\n').catch(() => undefined);
      });
    });
  });

  api.get(
    TITLE_PATH,
    withMovies(async (c, _movies, ctx) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      return detailResponse(c, id.data, ctx);
    }),
  );

  api.post(
    USER_PATH,
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const id = titleIdSchema.safeParse(c.req.param('id'));
      if (!id.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = userBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      if ((await movies.repo.titleById(id.data)) === null) return c.json({ error: 'not_found' }, 404);
      const { watched, rating, review } = parsed.data;
      if (watched !== undefined || rating !== undefined) {
        await movies.repo.setTitleUser(id.data, {
          ...(watched !== undefined ? { watched } : {}),
          ...(rating !== undefined ? { rating } : {}),
        });
      }
      if (review !== undefined) await saveReview(movies, deps.service, id.data, review);
      movies.events.changed('user', { titleIds: [id.data] });
      return detailResponse(c, id.data, ctx);
    }),
  );

  api.post(
    FILE_WATCHED_PATH,
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const fileId = fileIdSchema.safeParse(c.req.param('fileId'));
      if (!fileId.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = watchedBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      const file = await movies.repo.fileById(fileId.data);
      if (file === null) return c.json({ error: 'not_found' }, 404);
      await movies.repo.setFileWatched(fileId.data, parsed.data.watched);
      movies.events.changed('user', { fileIds: [fileId.data], titleIds: file.titleId !== null ? [file.titleId] : [] });
      const body: FileChangeResponse = {
        file_id: fileId.data,
        title: file.titleId === null ? null : await getTitle(db, file.titleId, ctx),
      };
      return c.json(body);
    }),
  );

  api.post(
    FILE_ASSIGN_PATH,
    sameOriginOnly,
    withMovies(async (c, movies, ctx) => {
      const fileId = fileIdSchema.safeParse(c.req.param('fileId'));
      if (!fileId.success) return c.json({ error: 'invalid_id' }, 400);
      const json = await readJson(c);
      if (!json.ok) return c.json({ error: 'invalid_json' }, 400);
      const parsed = assignBody.safeParse(json.value);
      if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
      if ((await movies.repo.fileById(fileId.data)) === null) return c.json({ error: 'not_found' }, 404);
      const target = parsed.data;
      try {
        await movies.assign(fileId.data, {
          kind: target.kind,
          tmdbId: target.tmdb_id,
          ...(target.kind === 'tv' && target.season !== undefined && target.episode !== undefined
            ? { season: target.season, episode: target.episode }
            : {}),
        });
      } catch (err) {
        // service.assign maps TMDB failures to MoviesServiceError (phase 3) and emits 'assign' itself.
        if (err instanceof MoviesServiceError) {
          if (err.code === 'not_found') return c.json({ error: 'not_found' }, 404);
          if (err.code === 'no_tmdb_credentials') return c.json(TMDB_OFF, 503);
          return c.json({ error: 'tmdb_error', message: err.message }, 502);
        }
        throw err;
      }
      const titleId = makeTitleId(target.kind, target.tmdb_id);
      const body: FileChangeResponse = { file_id: fileId.data, title: await getTitle(db, titleId, ctx) };
      return c.json(body);
    }),
  );

  /** Starts a pass and answers 202 at once; `?wait=true` (scripts, tests) answers with the report. */
  api.post(
    '/api/movies/sync',
    sameOriginOnly,
    withMovies(async (c, movies) => {
      const wait = c.req.query('wait');
      if (wait === 'true' || wait === '1') {
        const body: SyncResponse = { started: true, report: await movies.syncNow() };
        return c.json(body);
      }
      void movies.syncNow().catch((err: unknown) => console.error(`[notesd] movies sync failed: ${errorMessage(err)}`));
      const body: SyncResponse = { started: true, report: null };
      return c.json(body, 202);
    }),
  );

  return api;
}
```
**Impact:** the body of a file phase 1 created. `app.ts` is unchanged: `moviesApiRoutes(deps)` still type-checks
because `options` is optional and `AppDeps` satisfies the `Pick`. Static routes (`unmatched`, `status`, `search-tmdb`,
`events`) are registered before `TITLE_PATH`. The regex already keeps them apart, and the order makes that easy to see.

### Step 5: Seed helper and fake TMDB
**File:** `tests/integration/helpers/moviesSeed.ts` (new)
**Change:** raw-SQL seeds (tests are not product writers. Raw SQL keeps the seed independent of `TitleMetadata`) plus
a fake `TmdbClient`. Phase 7's MCP tests can import the same library.
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { DEFAULT_MOVIES_CONFIG, type MoviesConfig } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { TmdbClient, TmdbSearchHit } from '../../../src/movies/tmdb.js';
import type { TitleMetadata } from '../../../src/movies/types.js';

export const HOST_HERE = 'host-a';
export const HOST_OTHER = 'host-b';
export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Enabled, no roots (nothing is scanned), TMDB images at the real CDN base. */
export const MOVIES_TEST_CONFIG: MoviesConfig = {
  ...DEFAULT_MOVIES_CONFIG,
  enabled: true,
  roots: [],
  tmdb: { ...DEFAULT_MOVIES_CONFIG.tmdb, imageBase: IMAGE_BASE },
};

export async function truncateMovies(db: Db): Promise<void> {
  await db.execute(sql`truncate table movie_plays, movie_files, movie_credits, movie_people, movie_title_companies,
    movie_companies, movie_episodes, movie_titles restart identity cascade`);
}

interface TitleSeed {
  id: string;
  kind: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: number;
  releaseDate: string;
  posterPath: string;
  runtimeMin: number | null;
  seasonCount: number | null;
  episodeCount: number | null;
  createdAt: string;
}

async function insertTitle(db: Db, t: TitleSeed): Promise<void> {
  await db.execute(sql`
    insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, poster_path,
      backdrop_path, runtime_min, genres, season_count, episode_count, metadata_fetched_at, created_at, updated_at)
    values (${t.id}, ${t.kind}, ${t.tmdbId}, ${t.title}, ${t.title}, ${t.year}, ${t.releaseDate}::date,
      ${`Overview of ${t.title}`}, ${t.posterPath}, null, ${t.runtimeMin}, '["Drama"]'::jsonb, ${t.seasonCount},
      ${t.episodeCount}, now(), ${t.createdAt}::timestamptz, now())
  `);
}

interface FileSeed {
  titleId: string | null;
  host: string;
  path: string;
  durationS: number;
  season?: number;
  episode?: number;
  status: 'matched' | 'unmatched' | 'pending';
  reason?: string;
  parsed?: Record<string, unknown>;
  deletedAt?: string;
}

async function insertFile(db: Db, f: FileSeed): Promise<number> {
  const name = f.path.slice(f.path.lastIndexOf('/') + 1);
  const res = await db.execute<{ id: string | number }>(sql`
    insert into movie_files (title_id, host, path, name, size, duration_s, season, episode, absolute_episode, status,
      reason, parsed, source, first_seen_at, last_seen_at, deleted_at, updated_at)
    values (${f.titleId}, ${f.host}, ${f.path}, ${name}, 1000000, ${f.durationS}, ${f.season ?? null},
      ${f.episode ?? null}, null, ${f.status}, ${f.reason ?? null},
      ${f.parsed === undefined ? null : JSON.stringify(f.parsed)}::jsonb, 'scan', '2026-11-01T00:00:00Z'::timestamptz,
      now(), ${f.deletedAt ?? null}::timestamptz, now())
    returning id
  `);
  const row = res.rows[0];
  if (row === undefined) throw new Error('insertFile returned no id');
  return Number(row.id);
}

async function insertPlay(db: Db, fileId: number, host: string, startedAt: string, endedAt: string, position: number, duration: number): Promise<void> {
  await db.execute(sql`
    insert into movie_plays (file_id, host, source, started_at, ended_at, start_position_s, position_s, duration_s, updated_at)
    values (${fileId}, ${host}, 'live', ${startedAt}::timestamptz, ${endedAt}::timestamptz, 0, ${position}, ${duration},
      ${endedAt}::timestamptz)
  `);
}

export interface SeededLibrary {
  /** movie-467905 on HOST_HERE, played to 50%. */
  killingHere: number;
  /** movie-467905 on HOST_OTHER, never played. */
  killingOther: number;
  /** tv-247718 S01E01 on HOST_HERE, deleted after a 96.7% play. */
  mobE1: number;
  /** tv-247718 S01E02 on HOST_HERE, played to 20%. */
  mobE2: number;
  /** Unmatched (no_match) on HOST_HERE. */
  nezha2: number;
  /** Pending (tmdb_error) on HOST_OTHER: never in HOST_HERE's unmatched list. */
  pendingOther: number;
}

/**
 * Two titles and two loose files:
 * - movie-467905 "How to Make a Killing" (Blumhouse; director/writer John Patton Ford; cast Glen Powell, Margaret Qualley)
 * - tv-247718 "MobLand", season 1 with episodes 1..3; E3 has no file.
 */
export async function seedLibrary(db: Db): Promise<SeededLibrary> {
  await insertTitle(db, {
    id: 'movie-467905', kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', year: 2026,
    releaseDate: '2026-02-20', posterPath: '/kill.jpg', runtimeMin: 100, seasonCount: null, episodeCount: null,
    createdAt: '2026-11-01T00:00:00Z',
  });
  await insertTitle(db, {
    id: 'tv-247718', kind: 'tv', tmdbId: 247718, title: 'MobLand', year: 2025,
    releaseDate: '2025-03-30', posterPath: '/mob.jpg', runtimeMin: null, seasonCount: 1, episodeCount: 3,
    createdAt: '2026-11-02T00:00:00Z',
  });
  await db.execute(sql`insert into movie_companies (id, name, logo_path, origin_country) values (3172, 'Blumhouse Productions', '/blum.png', 'US')`);
  await db.execute(sql`insert into movie_title_companies (title_id, company_id, ord) values ('movie-467905', 3172, 0)`);
  await db.execute(sql`insert into movie_people (id, name, profile_path) values
    (1, 'John Patton Ford', null), (2, 'Glen Powell', '/glen.jpg'), (3, 'Margaret Qualley', '/mq.jpg')`);
  await db.execute(sql`insert into movie_credits (title_id, person_id, role, character, job, ord) values
    ('movie-467905', 1, 'director', null, 'Director', 0),
    ('movie-467905', 1, 'writer', null, 'Screenplay', 0),
    ('movie-467905', 2, 'cast', 'Becket', null, 0),
    ('movie-467905', 3, 'cast', 'Julia', null, 1)`);
  await db.execute(sql`insert into movie_episodes (title_id, season, episode, name, air_date, runtime_min, overview, still_path) values
    ('tv-247718', 1, 1, 'Stick or Twist', '2025-03-30', 50, null, '/e1.jpg'),
    ('tv-247718', 1, 2, 'Episode Two', '2025-04-06', 50, null, null),
    ('tv-247718', 1, 3, 'Episode Three', '2025-04-13', 50, null, null)`);

  const killingHere = await insertFile(db, {
    titleId: 'movie-467905', host: HOST_HERE, path: '/lib/How.to.Make.a.Killing.2026.1080p.mkv', durationS: 6000, status: 'matched',
  });
  const killingOther = await insertFile(db, {
    titleId: 'movie-467905', host: HOST_OTHER, path: '/other/How.to.Make.a.Killing.2026.1080p.mkv', durationS: 6000, status: 'matched',
  });
  const mobE1 = await insertFile(db, {
    titleId: 'tv-247718', host: HOST_HERE, path: '/lib/MobLand S01/MobLand.S01E01.mkv', durationS: 3000, season: 1, episode: 1,
    status: 'matched', deletedAt: '2026-11-12T00:00:00Z',
  });
  const mobE2 = await insertFile(db, {
    titleId: 'tv-247718', host: HOST_HERE, path: '/lib/MobLand S01/MobLand.S01E02.mkv', durationS: 3000, season: 1, episode: 2,
    status: 'matched',
  });
  const nezha2 = await insertFile(db, {
    titleId: null, host: HOST_HERE, path: '/lib/Nezha (2019)/Ne.Zha.2.2025.1080p.mkv', durationS: 8400, status: 'unmatched',
    reason: 'no_match',
    parsed: { title: 'Ne Zha 2', year: 2025, season: null, episode: null, absoluteEpisode: null, kindHint: 'movie' },
  });
  const pendingOther = await insertFile(db, {
    titleId: null, host: HOST_OTHER, path: '/other/Some.Film.2024.mkv', durationS: 5400, status: 'pending', reason: 'tmdb_error',
  });

  await insertPlay(db, killingHere, HOST_HERE, '2026-11-10T13:00:00Z', '2026-11-10T13:50:00Z', 3000, 6000);
  await insertPlay(db, mobE1, HOST_HERE, '2026-11-11T13:00:00Z', '2026-11-11T14:00:00Z', 2900, 3000);
  await insertPlay(db, mobE2, HOST_HERE, '2026-11-12T13:00:00Z', '2026-11-12T13:10:00Z', 600, 3000);

  return { killingHere, killingOther, mobE1, mobE2, nezha2, pendingOther };
}

export const NEZHA2_TMDB_ID = 980477;

/** What the fake TMDB knows about Ne Zha 2. Field names follow phase 1's TitleMetadata; adjust here if they differ. */
const NEZHA2: TitleMetadata = {
  kind: 'movie',
  tmdbId: NEZHA2_TMDB_ID,
  title: 'Ne Zha 2',
  originalTitle: 'Ne Zha 2',
  year: 2025,
  releaseDate: '2025-01-29',
  overview: 'Ne Zha and Ao Bing face a new trial.',
  posterPath: '/nezha2.jpg',
  backdropPath: null,
  runtimeMin: 144,
  genres: ['Animation'],
  seasonCount: null,
  episodeCount: null,
  companies: [],
  credits: [],
  episodes: [],
};

export const SEARCH_HITS: TmdbSearchHit[] = [
  { kind: 'movie', tmdbId: NEZHA2_TMDB_ID, title: 'Ne Zha 2', originalTitle: 'Ne Zha 2', year: 2025, overview: 'Sequel.', posterPath: '/nezha2.jpg', popularity: 50 },
  { kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', originalTitle: 'How to Make a Killing', year: 2026, overview: 'Heir.', posterPath: '/kill.jpg', popularity: 20 },
];

/** A TMDB that knows one film's details and answers every search with SEARCH_HITS. No network. */
export function fakeTmdb(): TmdbClient {
  const unused = (name: string) => (): Promise<never> => Promise.reject(new Error(`fake TMDB: ${name} is not used by these tests`));
  return {
    searchMovie: () => Promise.resolve(SEARCH_HITS),
    searchTv: () => Promise.resolve([]),
    movieDetails: (id: number) =>
      id === NEZHA2_TMDB_ID ? Promise.resolve(NEZHA2) : Promise.reject(new Error(`fake TMDB: no movie ${id}`)),
    tvDetails: unused('tvDetails'),
    searchPerson: unused('searchPerson'),
    personCredits: unused('personCredits'),
  };
}
```
**Impact:** test-only. It assumes `DEFAULT_MOVIES_CONFIG.tmdb` exists (phase 1). If the landed `TmdbClient` has more
members, add each as `unused('<name>')`.

### Step 6: Integration tests over HTTP
**File:** `tests/integration/movies.api.int.test.ts` (new)
**Code:**
```ts
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { moviesApiRoutes } from '../../src/http/moviesApi.js';
import type { FileChangeResponse, MoviesStatusResponse, SyncResponse, TitleListResponse, TmdbSearchResponse, UnmatchedResponse } from '../../src/http/moviesApi.js';
import type { TitleDetail } from '../../src/movies/read.js';
import { buildMoviesService, type MoviesService } from '../../src/movies/service.js';
import { truncateAll } from './setup.js';
import { createApiHarness, SAME_ORIGIN, type ApiHarness } from './helpers/api-harness.js';
import {
  fakeTmdb,
  HOST_HERE,
  HOST_OTHER,
  IMAGE_BASE,
  MOVIES_TEST_CONFIG,
  NEZHA2_TMDB_ID,
  seedLibrary,
  truncateMovies,
  type SeededLibrary,
} from './helpers/moviesSeed.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';

let h: ApiHarness;
let here: MoviesService;
let elsewhere: MoviesService;

/** phase 3's factory takes the whole Config; null only with NOTESD_MOVIES=off, which MOVIES_TEST_CONFIG is not. */
function serviceFor(host: string): MoviesService {
  const built = buildMoviesService({ ...h.deps.config, movies: MOVIES_TEST_CONFIG }, h.deps.db, { host, tmdb: fakeTmdb() });
  if (built === null) throw new Error('movies service not built');
  return built;
}
let lib: SeededLibrary;

function appFor(movies: MoviesService | null): Hono {
  const app = new Hono();
  app.route(
    '/',
    moviesApiRoutes({ ...h.deps, config: { ...h.deps.config, movies: MOVIES_TEST_CONFIG }, movies }, { sseHeartbeatMs: 50 }),
  );
  return app;
}

async function getJson<T>(app: Hono, path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

async function post(app: Hono, path: string, payload: unknown, headers: Record<string, string> = SAME_ORIGIN): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
}

beforeAll(async () => {
  h = await createApiHarness();
  here = serviceFor(HOST_HERE);
  elsewhere = serviceFor('host-c');
});

afterAll(async () => {
  await here.close();
  await elsewhere.close();
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await truncateMovies(h.deps.db);
  lib = await seedLibrary(h.deps.db);
});

describe('GET /api/movies (the grid)', () => {
  it('lists every title with state, progress, poster_url and present_here, most recently played first', async () => {
    const { status, body } = await getJson<TitleListResponse>(appFor(here), '/api/movies');
    expect(status).toBe(200);
    expect(body.titles.map((t) => t.id)).toEqual(['tv-247718', 'movie-467905']);
    const [mob, killing] = body.titles;
    expect(killing).toMatchObject({
      kind: 'movie', title: 'How to Make a Killing', year: 2026, state: 'in_progress', watched: false, rating: null,
      poster_url: `${IMAGE_BASE}/w342/kill.jpg`, present_here: true, file_count: 2, deleted_file_count: 0,
      last_played_at: '2026-11-10T13:00:00.000Z',
      progress: { kind: 'movie', position_s: 3000, duration_s: 6000, ratio: 0.5 },
    });
    expect(mob).toMatchObject({
      kind: 'tv', poster_url: `${IMAGE_BASE}/w342/mob.jpg`, present_here: true, file_count: 1, deleted_file_count: 1,
      progress: { kind: 'tv', episodes_finished: 1, episodes_total: 3, episodes_present: 1 },
      finished_at: '2026-11-11T14:00:00.000Z',
    });
  });

  it('filters by kind, text, company, person, state and finished range', async () => {
    const app = appFor(here);
    const ids = async (qs: string): Promise<string[]> => (await getJson<TitleListResponse>(app, `/api/movies?${qs}`)).body.titles.map((t) => t.id);
    expect(await ids('kind=tv')).toEqual(['tv-247718']);
    expect(await ids('q=mobland')).toEqual(['tv-247718']);
    expect(await ids('company=blumhouse')).toEqual(['movie-467905']);
    expect(await ids('company=3172')).toEqual(['movie-467905']);
    expect(await ids('person=qualley')).toEqual(['movie-467905']);
    expect(await ids('finished_from=2026-11-11T00:00:00Z&finished_to=2026-11-11T23:59:59Z')).toEqual(['tv-247718']);
    expect(await ids('sort=title')).toEqual(['movie-467905', 'tv-247718']);
    expect(await ids('q=')).toHaveLength(2);
  });

  it('rejects a bad filter with 400', async () => {
    expect((await appFor(here).request('/api/movies?state=bogus')).status).toBe(400);
    expect((await appFor(here).request('/api/movies?finished_from=yesterday')).status).toBe(400);
  });

  it('R2.4: a host that holds none of the files gets the same absolute TMDB poster URLs', async () => {
    const list = await getJson<TitleListResponse>(appFor(elsewhere), '/api/movies');
    const killing = list.body.titles.find((t) => t.id === 'movie-467905');
    expect(killing?.poster_url).toBe('https://image.tmdb.org/t/p/w342/kill.jpg');
    expect(killing?.present_here).toBe(false);
    const detail = await getJson<TitleDetail>(appFor(elsewhere), '/api/movies/movie-467905');
    expect(detail.body.poster_url).toBe('https://image.tmdb.org/t/p/w500/kill.jpg');
    expect(detail.body.files.every((f) => !f.available && f.unavailable_reason === 'not_on_this_machine')).toBe(true);
  });
});

describe('GET /api/movies/:id (detail)', () => {
  it('R3.7: a file recorded for another host is available: false, this host\'s file is available', async () => {
    const { status, body } = await getJson<TitleDetail>(appFor(here), '/api/movies/movie-467905');
    expect(status).toBe(200);
    const mine = body.files.find((f) => f.id === lib.killingHere);
    const theirs = body.files.find((f) => f.id === lib.killingOther);
    expect(mine).toMatchObject({ host: HOST_HERE, available: true, unavailable_reason: null, state: 'in_progress', resume_position_s: 3000 });
    expect(theirs).toMatchObject({ host: HOST_OTHER, available: false, unavailable_reason: 'not_on_this_machine', deleted: false });
  });

  it('carries metadata, studios, crew and cast with character names', async () => {
    const { body } = await getJson<TitleDetail>(appFor(here), '/api/movies/movie-467905');
    expect(body).toMatchObject({ release_date: '2026-02-20', runtime_min: 100, genres: ['Drama'], review: '', review_note_id: null, seasons: [] });
    expect(body.companies).toEqual([{ id: 3172, name: 'Blumhouse Productions', logo_url: `${IMAGE_BASE}/w92/blum.png`, origin_country: 'US' }]);
    expect(body.directors.map((p) => p.name)).toEqual(['John Patton Ford']);
    expect(body.writers).toEqual([{ person_id: 1, name: 'John Patton Ford', profile_url: null, job: 'Screenplay' }]);
    expect(body.cast.map((p) => [p.name, p.character])).toEqual([['Glen Powell', 'Becket'], ['Margaret Qualley', 'Julia']]);
    expect(body.plays.map((p) => p.file_id)).toEqual([lib.killingHere]);
  });

  it('a series has one entry per episode with its own state, progress and deleted flag', async () => {
    const { body } = await getJson<TitleDetail>(appFor(here), '/api/movies/tv-247718');
    expect(body.seasons).toHaveLength(1);
    const eps = body.seasons[0]?.episodes ?? [];
    expect(eps.map((e) => [e.episode, e.name, e.state, e.deleted, e.has_file, e.present_here])).toEqual([
      [1, 'Stick or Twist', 'finished', true, true, false],
      [2, 'Episode Two', 'in_progress', false, true, true],
      [3, 'Episode Three', 'unwatched', false, false, false],
    ]);
    expect(eps[0]?.still_url).toBe(`${IMAGE_BASE}/w300/e1.jpg`);
    expect(eps[1]?.file_id).toBe(lib.mobE2);
    expect(eps[1]?.progress.ratio).toBeCloseTo(0.2);
  });

  it('answers 400 for a malformed id, 404 for an unknown one, and leaves other /api/movies/* paths to other routers', async () => {
    const app = appFor(here);
    expect((await app.request('/api/movies/movie-0')).status).toBe(400);
    expect((await app.request('/api/movies/movie-999')).status).toBe(404);
    app.get('/api/movies/player', (c) => c.json({ owner: 'phase 5' }));
    const player = await getJson<{ owner: string }>(app, '/api/movies/player');
    expect(player).toEqual({ status: 200, body: { owner: 'phase 5' } });
  });
});

describe('POST /api/movies/:id/user (R3.6)', () => {
  it('stores watched and rating on the title and the review as a #movie note linked to it', async () => {
    const app = appFor(here);
    const res = await post(app, '/api/movies/movie-467905/user', { watched: true, rating: 4, review: 'Great twist.' });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as TitleDetail;
    expect(detail).toMatchObject({ watched: true, rating: 4, state: 'finished', review: 'Great twist.' });
    expect(detail.review_note_id).not.toBeNull();
    const note = await h.notes.getOne(detail.review_note_id ?? '');
    expect(note?.tags).toEqual(['movie']);
    expect(note?.body).toContain('Review of How to Make a Killing (2026)');
    expect(note?.body).toContain('Great twist.');

    const edited = (await (await post(app, '/api/movies/movie-467905/user', { review: 'Even better twice.' })).json()) as TitleDetail;
    expect(edited.review_note_id).toBe(detail.review_note_id);
    expect(edited.review).toBe('Even better twice.');
    expect((await h.notes.revisions(detail.review_note_id ?? '')).length).toBeGreaterThanOrEqual(1);

    const cleared = (await (await post(app, '/api/movies/movie-467905/user', { review: '', rating: null, watched: false })).json()) as TitleDetail;
    expect(cleared).toMatchObject({ review: '', review_note_id: detail.review_note_id, rating: null, watched: false });
    expect(await h.notes.getOne(detail.review_note_id ?? '')).not.toBeNull();
  });

  it('accepts rating 0, rejects 6, empty bodies, unknown keys, cross-origin calls and unknown titles', async () => {
    const app = appFor(here);
    expect((await post(app, '/api/movies/movie-467905/user', { rating: 0 })).status).toBe(200);
    expect((await post(app, '/api/movies/movie-467905/user', { rating: 6 })).status).toBe(400);
    expect((await post(app, '/api/movies/movie-467905/user', {})).status).toBe(400);
    expect((await post(app, '/api/movies/movie-467905/user', { stars: 3 })).status).toBe(400);
    expect((await post(app, '/api/movies/movie-467905/user', { rating: 3 }, {})).status).toBe(403);
    expect((await post(app, '/api/movies/movie-999/user', { rating: 3 })).status).toBe(404);
  });
});

describe('POST /api/movies/files/:fileId/watched', () => {
  it('marks one episode file finished', async () => {
    const res = await post(appFor(here), `/api/movies/files/${lib.mobE2}/watched`, { watched: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileChangeResponse;
    expect(body.file_id).toBe(lib.mobE2);
    expect(body.title?.seasons[0]?.episodes[1]?.state).toBe('finished');
    expect((await post(appFor(here), '/api/movies/files/999999/watched', { watched: true })).status).toBe(404);
  });
});

describe('unmatched list and manual fix (R1.5)', () => {
  it('lists this host\'s unmatched files with reason and parsed name, then assigning one moves it into the library', async () => {
    const app = appFor(here);
    const before = await getJson<UnmatchedResponse>(app, '/api/movies/unmatched');
    expect(before.body.files.map((f) => f.id)).toEqual([lib.nezha2]);
    expect(before.body.files[0]).toMatchObject({
      reason: 'no_match', status: 'unmatched', available: true,
      parsed: { title: 'Ne Zha 2', year: 2025, season: null, episode: null, absolute_episode: null, kind_hint: 'movie' },
    });

    const search = await getJson<TmdbSearchResponse>(app, '/api/movies/search-tmdb?q=ne%20zha&kind=movie');
    expect(search.body.results.map((r) => [r.title_id, r.in_library, r.poster_url])).toEqual([
      [`movie-${NEZHA2_TMDB_ID}`, false, `${IMAGE_BASE}/w342/nezha2.jpg`],
      ['movie-467905', true, `${IMAGE_BASE}/w342/kill.jpg`],
    ]);

    const res = await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'movie', tmdb_id: NEZHA2_TMDB_ID });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FileChangeResponse;
    expect(body.title?.id).toBe(`movie-${NEZHA2_TMDB_ID}`);
    expect(body.title?.files.map((f) => [f.id, f.status, f.available])).toEqual([[lib.nezha2, 'matched', true]]);

    const after = await getJson<UnmatchedResponse>(app, '/api/movies/unmatched');
    expect(after.body.files).toEqual([]);
    const list = await getJson<TitleListResponse>(app, '/api/movies');
    expect(list.body.titles.map((t) => t.id)).toContain(`movie-${NEZHA2_TMDB_ID}`);
  });

  it('validates the assign body', async () => {
    const app = appFor(here);
    expect((await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'movie', tmdb_id: 1, season: 1, episode: 1 })).status).toBe(400);
    expect((await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'tv', tmdb_id: 1, season: 1 })).status).toBe(400);
    expect((await post(app, '/api/movies/files/999999/assign', { kind: 'movie', tmdb_id: NEZHA2_TMDB_ID })).status).toBe(404);
    expect((await post(app, `/api/movies/files/${lib.nezha2}/assign`, { kind: 'movie', tmdb_id: NEZHA2_TMDB_ID }, {})).status).toBe(403);
    expect((await app.request('/api/movies/search-tmdb')).status).toBe(400);
  });
});

describe('status, sync and the changed stream', () => {
  it('reports counts for this host', async () => {
    const { status, body } = await getJson<MoviesStatusResponse>(appFor(here), '/api/movies/status');
    expect(status).toBe(200);
    expect(body.counts).toEqual({ titles: 2, files_here: 2, unmatched_here: 1, pending_here: 0 });
  });

  it('runs a pass on POST /api/movies/sync?wait=true and answers 202 without wait', async () => {
    const waited = await post(appFor(here), '/api/movies/sync?wait=true', {});
    expect(waited.status).toBe(200);
    expect(((await waited.json()) as SyncResponse).report).not.toBeNull();
    const started = await post(appFor(here), '/api/movies/sync', {});
    expect(started.status).toBe(202);
    expect((await started.json()) as SyncResponse).toEqual({ started: true, report: null });
    expect((await post(appFor(here), '/api/movies/sync', {}, {})).status).toBe(403);
  });

  it('writes event: changed for a user write and unsubscribes on abort', async () => {
    const app = appFor(here);
    const res = await app.request('/api/movies/events');
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    await readUntil(reader, (t) => t.includes(': connected'));
    expect(here.events.listenerCount()).toBe(1);
    await post(app, '/api/movies/movie-467905/user', { rating: 3 });
    const text = await readUntil(reader, (t) => t.includes('event: changed'));
    expect(parseSse(text)).toContainEqual({ event: 'changed', data: { type: 'changed', reason: 'user', title_ids: ['movie-467905'], file_ids: [] } });
    await reader.cancel();
    await waitFor(() => here.events.listenerCount() === 0);
  });
});

describe('movies off', () => {
  it('answers 503 movies_off on every route', async () => {
    const app = appFor(null);
    for (const path of ['/api/movies', '/api/movies/unmatched', '/api/movies/status', '/api/movies/search-tmdb?q=x', '/api/movies/events', '/api/movies/movie-1']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(503);
      expect(await res.json()).toMatchObject({ error: 'movies_off' });
    }
    for (const path of ['/api/movies/movie-1/user', '/api/movies/files/1/watched', '/api/movies/files/1/assign', '/api/movies/sync']) {
      expect((await post(app, path, {})).status, path).toBe(503);
    }
  });
});
```
**Impact:** test-only. `truncateMovies` runs in `beforeEach`, so the file does not depend on phase 1 adding the movie
tables to `truncateAll`. Integration files run one at a time.

## Principles applied

- Boundary discipline: all input (path params, query, JSON bodies, date bounds via the existing `parseDateBound`) is validated with zod once, in `moviesApi.ts`. `read.ts` and `reviewNote.ts` take typed values and do not re-check them.
- Make illegal states unrepresentable: `TitleProgress` is a union discriminated on `kind`, so a movie cannot carry episode counts and a series cannot carry a single position. The assign body is a `discriminatedUnion` on `kind`: a movie cannot have a season or episode, and a tv slot is a season and an episode together or neither.
- Encode lessons in structure: the movies-off guard is a per-route `withMovies` wrapper, not `api.use('/api/movies/*')`. Hono merges a sub-router's `use` into the parent app, where it would also run on phase 5's play routes under the same prefix. Path params carry regexes (`:id{[a-z]+-[0-9]+}`, `:fileId{[0-9]+}`), so `/api/movies/:id` cannot swallow `/api/movies/player` whatever the mount order. A test pins this by mounting a sentinel `/api/movies/player` after the router.
- Laziness protocol: no `/api/movies/history` route (not in the contract; detail carries the newest 50 plays, and `history()` exists for phase 7). No new link table for the review: the contract's `review_note_id` column plus `NotesService` give revisions, search and `/n` for free. The SSE route, `describeIssues`, `readJson`, `sameOriginOnly` and `parseDateBound` are reused rather than rewritten.
- Test behavior, not implementation: the tests drive the real router over HTTP against seeded Postgres rows and assert the wire. Only TMDB is faked, which is an outside service.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test -- tests/unit/movies/reviewNote.test.ts && npm run test:int -- tests/integration/movies.api.int.test.ts`, then the full `npm test` and `npm run test:int`
**Proof:** the real daemon, built from this worktree, serves the routes over HTTP. Rows are seeded with SQL. One free
TMDB call proves the manual fix and the poster.
- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh`)
- Feature-map entries: none yet. `features/movies.md` is phase 8's (see Handoffs).
- Setup (run from `/home/miftah/.worktrees/mcp-notes/movies-library`). Write each block to a file in the scratchpad.
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  ROOTS=$(mktemp -d)                      # an empty library root: the startup pass finds nothing
  TOKEN=$(sed -n 's/^TMDB_API_READ_ACCESS_TOKEN=//p' /home/miftah/mcp-notes/.env.local)
  NOTESD_MOVIES=on NOTESD_MOVIES_ROOTS="$ROOTS" NOTESD_MOVIES_SCAN_MS=86400000 TMDB_API_READ_ACCESS_TOKEN="$TOKEN" $V up
  # -> RUN=<id>
  H=$(hostname)                            # the daemon's os.hostname()
  POSTER=$(curl -s -H "Authorization: Bearer $TOKEN" https://api.themoviedb.org/3/movie/467905 | jq -r .poster_path)
  $V exec RUN "insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, poster_path, backdrop_path, runtime_min, genres, season_count, episode_count, metadata_fetched_at, created_at, updated_at) values ('movie-467905','movie',467905,'How to Make a Killing','How to Make a Killing',2026,'2026-02-20','seeded','$POSTER',null,100,'[]'::jsonb,null,null,now(),now(),now());
  insert into movie_files (title_id, host, path, name, size, duration_s, status, source, first_seen_at, last_seen_at, updated_at) values ('movie-467905','other-laptop','/mnt/c/x/Killing.mkv','Killing.mkv',1,6000,'matched','scan',now(),now(),now());
  insert into movie_files (title_id, host, path, name, size, duration_s, status, reason, parsed, source, first_seen_at, last_seen_at, updated_at) values (null,'$H','$ROOTS/How.to.Make.a.Killing.2026.1080p.mkv','How.to.Make.a.Killing.2026.1080p.mkv',1,6000,'unmatched','low_confidence','{\"title\":\"How to Make a Killing\",\"year\":2026}'::jsonb,'scan',now(),now(),now())"
  ```
- Journeys:
  - **J1** · traces R2.4 — `$V api RUN GET /api/movies/movie-467905`, then `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "<poster_url from that body>"` → passes when `poster_url` is `https://image.tmdb.org/t/p/w500$POSTER`, while the title's only matched file is on `other-laptop` (so `present_here` is `false`), and the curl prints `200 image/jpeg`
  - **J2** · traces R3.7 — `$V api RUN GET /api/movies/movie-467905` → passes when the file with host `other-laptop` has `"available": false` and `"unavailable_reason": "not_on_this_machine"`, and `$V api RUN GET /api/movies` shows the title with `"present_here": false`
  - **J3** · traces R3.6 — `$V api RUN POST /api/movies/movie-467905/user '{"watched":true,"rating":4,"review":"Great twist."}'`, then `$V sql RUN "select watched_at is not null as watched, rating, review_note_id from movie_titles where id='movie-467905'"`, then `$V api RUN GET /api/notes/<review_note_id>` → passes when the SQL row shows `watched = t`, `rating = 4` and a note id, and that note's `body` contains `Great twist.` and its `tags` are `["movie"]`. Then `$V api RUN POST /api/movies/movie-467905/user '{"review":""}'` and `$V sql RUN "select deleted_at from notes where id='<review_note_id>'"`: passes when the detail shows `"review": ""` with the same `review_note_id` and `deleted_at` is null
  - **J4** · traces R1.5 — `$V api RUN GET /api/movies/unmatched` (lists `How.to.Make.a.Killing.2026.1080p.mkv` with `reason: low_confidence`), then `$V api RUN POST /api/movies/files/<its id>/assign '{"kind":"movie","tmdb_id":467905}'`, then `$V api RUN GET /api/movies/unmatched` and `$V sql RUN "select status, title_id from movie_files where id=<its id>"` → passes when the assign answers 200 with `title.id = movie-467905` and that file has `available: true` in `title.files`, the second unmatched list is `{"files":[]}`, and the row is `matched | movie-467905`
  - **J5** · traces R1.5, R2.4, R3.6, R3.7 — `npm run test:int -- tests/integration/movies.api.int.test.ts` → passes when every test passes. This includes the cases the harness cannot build: two hosts' views of one row, a series' episode states, the SSE `changed` event and 503 `movies_off`
- Neighbor check: notes over HTTP and the shared SSE wiring. Run `npm run test:int -- tests/integration/api.int.test.ts tests/integration/adversary.sse.int.test.ts`, then `$V api RUN POST /api/notes '{"body":"still fine #neighbor"}'` and `$V api RUN GET /api/notes?tag=neighbor`. Passes when the tests are green and the note comes back. Finish with `$V down RUN`.
- Cost: no LLM turns. Two free TMDB requests (the poster path lookup and `assign`'s details fetch) and one image fetch.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass. J1 through J4 pass on a throwaway daemon:
every contract route answers, the detail carries per-file `state` and `available` and an absolute `poster_url` that
loads, assign empties the unmatched list, and watched / rating / review persist with the review as a live `#movie` note.

## Handoffs

- **R3.7, second half (phase 5):** the play route's `not_on_this_machine` answer for a file of another host belongs to `moviesPlayApi.ts`. Phase 4 proves only `available: false`.
- **Feature map (phase 8):** add `.claude/skills/verify-notesd/features/movies.md` and its README row. Phase 4's journeys J1 to J4 (seed SQL above, routes, expected bodies) are ready to copy into the "Driving it with verify.sh" section. Also put the HTTP routes table above into README's HTTP API section.
- **Phase 6 (web):** use the wire types in this plan's Interface Contract exactly. For phase 6's journeys: the grid uses `poster_url` (w342) and `progress.kind`; the detail uses `seasons[].episodes[]` with `deleted`, `state`, `progress` and `file_id`; the file chips use `available` / `unavailable_reason`; the unmatched list uses `UnmatchedFile` plus `GET /api/movies/search-tmdb` and `POST .../assign`; refetch on `GET /api/movies/events` `changed`. A 503 `movies_off` from `GET /api/movies/status` means the subsystem is off on this machine.
- **Phase 7 (MCP):** call `listTitles(db, filter, ctx)`, `getTitle(db, id, ctx)` and `history(db, filter)` with `ctx = { host: movies.host, imageBase: config.movies.tmdb.imageBase }`. `TitleFilter` already has `company`, `person` (id or name fragment), `state`, `finishedFrom`/`finishedTo` (against `finished_at`) for R6.3. `tests/integration/helpers/moviesSeed.ts` (`seedLibrary`, `fakeTmdb`) gives MCP tests the same library.
- **Phases 1 and 3:** reconciled (events, status, assign errors, `lastPlay` order) — see Requires.
- **Phase 5:** owns its own seed helper under a different name (`tests/integration/helpers/moviesPlaySeed.ts`); this phase alone creates `tests/integration/helpers/moviesSeed.ts`.
- **Phase 1:** adding the `movie_*` tables to `truncateAll` in `tests/integration/setup.ts` is welcome but not required by this phase (it truncates them itself).

## Rollback

Revert this phase's commit. That restores phase 1's empty `moviesApiRoutes` and removes `read.ts`, `reviewNote.ts`, the
seed helper and the two test files. No migration, config or `app.ts` change to undo. Review notes the owner already
created stay as ordinary `#movie` notes.
