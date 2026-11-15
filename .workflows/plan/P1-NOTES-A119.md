> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/direct-streaming/PLAN.md` phase 9. Source: `.workflows/plan/direct-streaming/phase-9.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 9: The Stream side of `/movies`

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R5 — "the Stream page [...] after" with "Stream is a switch at the top of /movies, not a side-panel entry; the Stream grid shows only verified titles"
**Criteria:** R5.1, R5.2, R5.3, R5.4 (page half), R5.5
**Depends on:** Phase 4, Phase 5 (and, through them, Phase 3)
**Difficulty:** HARD
**Package:** `web/src` (page, store, client), `src/http` (one route)

---

## Goal

`/movies` gets a two-icon Library / Stream switch at the top of its toolbar. The Stream side
(`/movies?side=stream`) is the same poster grid, fed by a new `GET /api/movies/stream` that lists
only the titles with a source verified on this machine inside the freshness window. A title opened
from it (`/movies/<id>?side=stream`) is the same title page with a stream source line, and its Play
asks `POST /api/stream/play` to start the stream player full screen. A series lists every season,
and each episode is verified when clicked. A failed play says so and the title leaves the grid on
the refresh that follows. A title with a file on this machine still plays the file, and streaming
it is a second icon.

## Route state (decided here)

The Stream side is a **query parameter**, `side=stream`, not a path segment:

| URL | Route |
|---|---|
| `/movies` | Library grid `{title: null, unmatched: false}` |
| `/movies?side=stream` | Stream grid `{title: null, unmatched: false, stream: true}` |
| `/movies/<id>` | a title opened from the Library |
| `/movies/<id>?side=stream` | a title opened from the Stream grid (Back returns to Stream) |
| `/movies/unmatched` | the unmatched list (always the Library side; `side` is ignored) |

A path segment (`/movies/stream`) would be read as a title id by `moviesRouteFromLocation`, and
`/movies/stream/<id>` is a deeper path, which the parser rejects today. The query keeps
`/movies/<id>` and `/movies/unmatched` exactly as they are, and every existing `MoviesRoute` literal
stays valid because `stream` is optional (absent = Library).

## Interface Contract

**Deletes:** nothing.

**Renames:** nothing.

**Creates:**
- Route `GET /api/movies/stream` (`src/http/moviesApi.ts`), answering `StreamListResponse`.
- Server types `StreamListResponse`, `StreamSourceWire`, `TitleDetailResponse` (`src/http/moviesApi.ts`).
- Web: `fetchStreamTitles`, `streamPlay`, types `StreamSourceView`, `StreamListResponse`, `StreamRef`
  (`web/src/moviesApi.ts`); `STREAM_ROUTE`, `MOVIES_SIDE_PARAM` (`web/src/lib/route.ts`); `MoviesSide`,
  `sideOf`, `stateFilters`, `StreamTarget`, `TitleAction`, `EpisodeAction`, `sourceOf`,
  `episodeStreamTarget`, `streamTarget`, `titleAction`, `episodeAction`, `streamSourceText`,
  `streamLine`, `streamLabel`, `streamErrorText`, `streamEmptyText`, `STREAM_HEADING`,
  `STREAM_OFF_TEXT`, `STREAM_OPENING_NOTICE` (`web/src/lib/movies.ts`); `StreamAltButton`
  (`web/src/components/movies/parts.tsx`); fixtures `makeSource`, `FIGHT_CLUB_ITEM`, `FIGHT_CLUB`,
  `MOVIE_STREAMABLE`, `SERIES_STREAMABLE`, `STREAM_LIST` (`web/src/testing/movieFixtures.ts`).
- Tests `web/src/App.stream.test.tsx`, `tests/integration/movies.stream.int.test.ts`.

**Signature changes (all additive, old calls keep compiling):**
- `moviesApiRoutes(deps: Pick<AppDeps, 'config'|'db'|'service'|'movies'>)` -> `Pick<AppDeps, 'config'|'db'|'service'|'movies'|'directStream'>` (`directStream` is optional on `AppDeps`, so existing callers that spread `h.deps` still compile).
- `GET /api/movies/:id`, `GET /api/movies/:movieId`, `POST /api/movies/:id/user` and the `title` of `FileChangeResponse` now answer `TitleDetailResponse`: phase 5's `TitleDetail` (whose `stream_sources` are already this host's) with each row given `fresh: boolean` by phase 5's `isFreshStreamSource`.
- `MoviesRoute` gains `stream?: boolean`. `moviesHref` appends `?side=stream` when it is true.
- `MoviesStore` / `MoviesView` gain `stream: StreamListResponse | null` and `streamError: string | null`.
- `isGone`, `matchesFilter`, `stateCounts`, `sortTitles`, `seasonsShown` gain a trailing `side: MoviesSide = 'library'` parameter.
- `MoviesGrid`, `PosterTile` gain `side?: MoviesSide`; `MovieDetail` gains `side?: MoviesSide`, `streamEnabled?: boolean`; `EpisodeList` gains `side`, `streamEnabled`, `onStream`.
- Web `TitleDetail` gains `stream_sources: StreamSourceView[]`.

**Requires (from earlier phases).** Plan against these names; the reconciler settles a mismatch.
- **Phase 3:** `Config.directStream?: { enabled: boolean; freshDays: number; cli: string; ... }` and `DEFAULT_DIRECT_STREAM_CONFIG` exported from `src/config.ts`; `AppDeps.directStream?: DirectStreamService | null` (`src/deps.ts`), passed into `moviesApiRoutes` by `src/http/app.ts:129` (it already passes the whole `deps`); `POST /api/stream/play` (same-origin) taking `{kind:'movie', tmdb_id}` or `{kind:'tv', tmdb_id, season, episode}`, 200 `{ok: true, page_url, session, attempts}` = started (it resolves, then opens `/stream/<session>` full screen in the streaming Chrome, where phase 1's `open` starts it with sound), errors `{error:'direct_stream_off'}` 503 and `{error:'no_source', attempts}` 502; other failures (`resolve_failed`, `open_failed`) carry `{error, reason, message}`. `verify.sh up --direct-stream` (implies `--movies`) is the throwaway run with direct streaming on, against a fake resolver; a plain `--movies` run pins it off.
- **Phase 4:** the player page exists, so a 2xx from `POST /api/stream/play` really ends in a playing, full-screen film. Phase 9 reads nothing from `web/src/stream/*`.
- **Phase 5, `src/movies/read.ts` and `src/movies/repo.ts` (as phase 5's plan writes them):**
  ```ts
  // read.ts (phase 5's Step 6b)
  export interface StreamSourceView {
    host: string;
    season: number;            // 0 for a film
    episode: number;           // 0 for a film
    provider: string;
    manifest_kind: string;     // 'hls' | 'dash' | 'mp4'
    best_height: number | null;
    en_subtitle: boolean;
    verified_at: string;       // ISO
    stale_at: string | null;   // ISO
  }
  // TitleDetail gains: stream_sources: StreamSourceView[]   (this host's ever-verified rows only)
  /** Titles with a fresh source on ctx.host (repo.ts freshStreamSourceSql), in the TitleListItem
   *  shape listTitles uses, state and progress included; filter.scope is ignored. */
  export async function listStreamTitles(db: Db, filter: TitleFilter, ctx: ReadContext, freshSince: Date): Promise<TitleListItem[]>;
  // repo.ts: the one freshness rule
  export function streamFreshSince(now: Date, freshDays: number): Date;
  export function isFreshStreamSource(row: Pick<MovieStreamSourceRow, 'host' | 'staleAt' | 'verifiedAt'>, host: string, since: Date): boolean;
  ```
- **Phase 5, store half of R5.4:** a resolve that fails inside `POST /api/stream/play` sets `stale_at` on the title's (or that episode's) row for this host before the 502 is answered, so the next `GET /api/movies/stream` no longer lists it.
- **Phase 5, schema:** `movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at, failure, updated_at)`; `movie_stream_sources_failure_check` makes `failure` set exactly when `stale_at` is, so every seeded stale row here carries `failure = 'no_source'` (the integration test, the Proof setup and J4's stub).
- **Phase 5, data:** a stream-only series stored by the "ensure the title exists" hook is stored through `upsertTitle` from `tvDetails`, which already carries every season's episodes (`src/movies/tmdb.ts:656-663`), so `movie_episodes` has every episode the Stream side lists.

**Leaves alone (owned by others):** the rail and sidebar (`web/src/components/Rail.tsx`, `web/src/components/Sidebar.tsx`), `web/src/App.tsx`, `src/movies/state.ts`, `src/movies/repo.ts`, `src/movies/read.ts` (phase 5), `src/http/directStreamApi.ts` and `src/directStream/*` (phases 3, 5, 10), `web/stream.html` and `web/src/stream/*` (phase 4), the prober (phase 10), `web/src/components/movies/MovieModal.tsx` (the chat pop-up keeps VLC-only Play), `docs/guide/movies.md` sections "What is stored", "Watch state", "Two machines" (phase 5), `docs/guide/streaming.md` (phases 1, 3, 4, 7, 8, 10).

## Files

| File | Action | What changes |
|---|---|---|
| `src/http/moviesApi.ts` | modify | `GET /api/movies/stream`; detail answers get this host's sources with `fresh` |
| `tests/integration/movies.stream.int.test.ts` | create | the route: fresh / stale / old / other host / off; the detail's `fresh` |
| `scripts/docs/httpRoutes.ts` | modify | describe the new route (and the `fresh` flag it adds to title answers); the `GET /api/movies/:id` sentence is phase 5's |
| `docs/guide/reference/http-api.md` | regenerate | `npm run docs:gen` |
| `web/src/moviesApi.ts` | modify | stream types, `fetchStreamTitles`, `streamPlay`, `stream_sources` normalized |
| `web/src/lib/route.ts` | modify | `stream?` on `MoviesRoute`, `?side=stream` parse and href, `STREAM_ROUTE` |
| `web/src/lib/movies.ts` | modify | side-aware grid helpers, stream play decisions, labels, notices, header lines |
| `web/src/hooks/useMovies.ts` | modify | fetch the Stream list on the Stream side |
| `web/src/pages/MoviesPage.tsx` | modify | the switch, the Stream grid and its empty/off states, side-aware Back |
| `web/src/components/movies/MoviesGrid.tsx` | modify | `side` prop |
| `web/src/components/movies/PosterTile.tsx` | modify | `side` prop: never "gone" on Stream, link keeps `?side=stream` |
| `web/src/components/movies/MovieDetail.tsx` | modify | stream line, file-first Play, secondary stream icon, stream Play |
| `web/src/components/movies/EpisodeList.tsx` | modify | every season on Stream, episode stream buttons |
| `web/src/components/movies/parts.tsx` | modify | `StreamAltButton` |
| `web/src/components/movies/Movies.css` | modify | `.mv-side`, `.mv-stream-line`, `.mv-row-play`, row column |
| `web/src/testing/movieFixtures.ts` | modify | `stream_sources: []` default; Stream fixtures |
| `web/src/App.stream.test.tsx` | create | R5.1-R5.5 through the rendered App |
| `web/src/lib/route.test.tsx` | modify | `?side=stream` parse and href |
| `web/src/lib/movies.test.tsx` | modify | `MoviesView` literal; `titleAction`, `streamLine`, `streamLabel` |
| `docs/guide/movies.md` | modify | "The Movies page": the switch, "The Stream side", toolbar; failure answers; proving |
| `scripts/docs/shots/movies.mjs` | modify | live `stream.png` of the Stream grid, no Play |
| `.claude/skills/verify-notesd/features/movies.md` | modify | Stream side sub-feature, how to reach it, how to drive it |
| `.claude/skills/verify-notesd/features/README.md` | modify | movies row mentions the Stream side |
| `docs/guide/img/movies/stream.png` | create (conditional, Step 15) | only when the live daemon serves this branch |

## Implementation Steps

### Step 1: `GET /api/movies/stream` and fresh sources on the detail
**File:** `src/http/moviesApi.ts:5-20` (imports), `:43-62` (types), `:145-169` (function head and helpers), `:171-214` (new route after `GET /api/movies`), `:322-377` (`FileChangeResponse` builders)
**Change:**

1. Imports (`:5-20`): add `listStreamTitles` and `type StreamSourceView` to the `../movies/read.js` import list, and `import { isFreshStreamSource, streamFreshSince } from '../movies/repo.js';` (phase 5's one freshness rule; this file defines none of its own).

2. Replace the `FileChangeResponse` interface (`:53-56`) and add the stream types right after `MovieChangeWire` (`:62`):

```ts
export interface FileChangeResponse {
  file_id: number;
  title: TitleDetailResponse | null;
}
```

```ts
/** One of this machine's stream sources as the page reads it: phase 5's row plus `fresh`, the Stream grid's own test. */
export type StreamSourceWire = StreamSourceView & { fresh: boolean };

/** A title as every detail route answers it: phase 5's TitleDetail with only this machine's stream sources, each marked fresh or not. */
export type TitleDetailResponse = Omit<TitleDetail, 'stream_sources'> & { stream_sources: StreamSourceWire[] };

/** `GET /api/movies/stream`. Off is a normal answer, not an error, so the page can say how to turn it on. */
export type StreamListResponse =
  | { enabled: true; titles: TitleListItem[]; fresh_days: number }
  | { enabled: false; reason: 'direct_stream_off'; titles: TitleListItem[] };
```

3. After the `TMDB_OFF` constant (`:72`), add:

```ts
interface StreamWindow {
  freshDays: number;
  since: Date;
}

/**
 * Direct streaming answers on this daemon only with movies on, NOTESD_DIRECT_STREAM on and a
 * DirectStreamService built (R2.6's three switches). Then: the freshness window, from
 * NOTESD_STREAM_FRESH_DAYS (`config.directStream.freshDays`), through phase 5's streamFreshSince.
 */
function streamWindow(deps: Pick<AppDeps, 'config' | 'movies' | 'directStream'>, now: Date = new Date()): StreamWindow | null {
  const ds = deps.config.directStream;
  if (deps.movies === null || (deps.directStream ?? null) === null || ds === undefined || !ds.enabled) return null;
  return { freshDays: ds.freshDays, since: streamFreshSince(now, ds.freshDays) };
}

/**
 * Each of this machine's sources (phase 5's getTitle returns only `ctx.host`'s) marked `fresh` by
 * phase 5's isFreshStreamSource, the same rule listStreamTitles applies in SQL. With direct
 * streaming off nothing is fresh.
 */
function withStreamFreshness(detail: TitleDetail, host: string, window: StreamWindow | null): TitleDetailResponse {
  return {
    ...detail,
    stream_sources: detail.stream_sources.map((s) => ({
      ...s,
      fresh:
        window !== null &&
        isFreshStreamSource(
          { host: s.host, staleAt: s.stale_at === null ? null : new Date(s.stale_at), verifiedAt: new Date(s.verified_at) },
          host,
          window.since,
        ),
    })),
  };
}
```

4. Function head (`:145-148`): widen the deps type.

```ts
export function moviesApiRoutes(
  deps: Pick<AppDeps, 'config' | 'db' | 'service' | 'movies' | 'directStream'>,
  options: MoviesApiOptions = {},
): Hono {
```

5. Replace `detailResponse` (`:162-165`) with:

```ts
  /** Every route that answers one title goes through here, so `stream_sources` always carries `fresh`. */
  async function titleResponse(id: string, ctx: ReadContext): Promise<TitleDetailResponse | null> {
    const detail = await getTitle(db, id, ctx);
    return detail === null ? null : withStreamFreshness(detail, ctx.host, streamWindow(deps));
  }

  async function detailResponse(c: Context, id: string, ctx: ReadContext): Promise<Response> {
    const detail = await titleResponse(id, ctx);
    return detail === null ? c.json({ error: 'not_found' }, 404) : c.json(detail);
  }
```

6. Insert after the `GET /api/movies` route (after `:214`):

```ts
  /**
   * The Stream side of the page: only the titles with a source verified on this machine inside the
   * freshness window and not marked stale (D4, invariant 10), in the grid's TitleListItem shape.
   * Direct streaming off is `enabled: false`, never an error, so the page can say how to turn it on.
   */
  api.get(
    '/api/movies/stream',
    withMovies(async (c, _movies, ctx) => {
      const window = streamWindow(deps);
      if (window === null) {
        const off: StreamListResponse = { enabled: false, reason: 'direct_stream_off', titles: [] };
        return c.json(off);
      }
      const body: StreamListResponse = {
        enabled: true,
        titles: await listStreamTitles(db, {}, ctx, window.since),
        fresh_days: window.freshDays,
      };
      return c.json(body);
    }),
  );
```

`/api/movies/stream` matches neither `MOVIE_ID_PATH` (`[Mm]-...`) nor `TITLE_PATH` (`[a-z]+-[0-9]+`), so registration order does not matter.

7. In `FILE_WATCHED_PATH` (`:336-339`) and `FILE_ASSIGN_PATH` (`:374`) replace `await getTitle(db, ..., ctx)` with `await titleResponse(..., ctx)`:

```ts
      const body: FileChangeResponse = {
        file_id: fileId.data,
        title: file.titleId === null ? null : await titleResponse(file.titleId, ctx),
      };
```

```ts
      const body: FileChangeResponse = { file_id: fileId.data, title: await titleResponse(titleId, ctx) };
```

After this step `getTitle` is no longer called directly in this file except inside `titleResponse`; keep it in the import list.

**Impact:** one new read-only route; detail bodies gain `fresh` on each stream source and lose other hosts' source rows. Nothing else changes. Every route still answers 503 `movies_off` without a `MoviesService`.

### Step 2: Integration test of the route
**File:** `tests/integration/movies.stream.int.test.ts` (new)
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DIRECT_STREAM_CONFIG, type Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { moviesApiRoutes, type StreamListResponse, type TitleDetailResponse, type TitleListResponse } from '../../src/http/moviesApi.js';
import { buildMoviesService, type MoviesService } from '../../src/movies/service.js';
import { truncateAll } from './setup.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { fakeTmdb, HOST_HERE, HOST_OTHER, MOVIES_TEST_CONFIG, NEZHA2_TMDB_ID, seedLibrary, truncateMovies } from './helpers/moviesSeed.js';

const DAY_MS = 86_400_000;
const FRESH_DAYS = 7;
/** The route only asks whether a DirectStreamService was built; it never calls one. */
const SERVICE = {} as NonNullable<AppDeps['directStream']>;

let h: ApiHarness;
let here: MoviesService;
let other: MoviesService;
let nezha2: string;

function serviceFor(host: string): MoviesService {
  const built = buildMoviesService({ ...h.deps.config, movies: MOVIES_TEST_CONFIG }, h.deps.db, { host, tmdb: fakeTmdb() });
  if (built === null) throw new Error('movies service not built');
  return built;
}

interface AppOptions {
  movies?: MoviesService | null;
  enabled?: boolean;
  service?: AppDeps['directStream'];
}

function appFor(o: AppOptions = {}): Hono {
  const config: Config = {
    ...h.deps.config,
    movies: MOVIES_TEST_CONFIG,
    directStream: { ...DEFAULT_DIRECT_STREAM_CONFIG, enabled: o.enabled ?? true, freshDays: FRESH_DAYS },
  };
  const app = new Hono();
  app.route(
    '/',
    moviesApiRoutes({
      ...h.deps,
      config,
      movies: o.movies === undefined ? here : o.movies,
      directStream: o.service === undefined ? SERVICE : o.service,
    }),
  );
  return app;
}

async function getJson<T>(app: Hono, path: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
}

/** A movie_stream_sources row (seeding only: the daemon writes these through MoviesRepo, phase 5). A stale row names its failure (movie_stream_sources_failure_check). */
async function source(titleId: string, season: number, episode: number, host: string, verifiedDaysAgo: number, stale = false): Promise<void> {
  const verifiedAt = new Date(Date.now() - verifiedDaysAgo * DAY_MS).toISOString();
  const staleAt = stale ? new Date().toISOString() : null;
  const failure = stale ? 'no_source' : null;
  await h.deps.db.execute(sql`
    insert into movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at, failure)
    values (${titleId}, ${season}, ${episode}, ${host}, 'VidFast', 'hls', 2160, true, ${verifiedAt}::timestamptz, ${staleAt}::timestamptz, ${failure})
  `);
}

const ids = (b: StreamListResponse) => b.titles.map((t) => t.id).sort();

beforeAll(async () => {
  h = await createApiHarness();
  here = serviceFor(HOST_HERE);
  other = serviceFor(HOST_OTHER);
});

afterAll(async () => {
  await here.close();
  await other.close();
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  await truncateMovies(h.deps.db);
  await seedLibrary(h.deps.db);
  // A title with no file anywhere: only a stream source brings it to the page.
  nezha2 = await here.repo.upsertTitle(await fakeTmdb().movieDetails(NEZHA2_TMDB_ID));
  await source(nezha2, 0, 0, HOST_HERE, 1);
  await source('movie-467905', 0, 0, HOST_HERE, 2);
  // MobLand on this host: S01E01 failed at its last play (stale), S01E03 was verified 10 days ago.
  await source('tv-247718', 1, 1, HOST_HERE, 1, true);
  await source('tv-247718', 1, 3, HOST_HERE, 10);
  // The other machine verified S01E02: that is not this machine's to play.
  await source('tv-247718', 1, 2, HOST_OTHER, 1);
});

describe('GET /api/movies/stream (the Stream grid)', () => {
  it('lists only titles with a source verified on this host inside the window and not stale', async () => {
    const { status, body } = await getJson<StreamListResponse>(appFor(), '/api/movies/stream');
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, fresh_days: FRESH_DAYS });
    expect(ids(body)).toEqual(['movie-467905', nezha2]);
    const streamOnly = body.titles.find((t) => t.id === nezha2);
    expect(streamOnly).toMatchObject({ kind: 'movie', title: 'Ne Zha 2', file_count: 0, present_here: false });
  });

  it('a fresh episode of a series brings the series in', async () => {
    await source('tv-247718', 1, 2, HOST_HERE, 3);
    const { body } = await getJson<StreamListResponse>(appFor(), '/api/movies/stream');
    expect(ids(body)).toEqual(['movie-467905', nezha2, 'tv-247718']);
  });

  it('the other machine sees its own verified titles, not this one\'s', async () => {
    const { body } = await getJson<StreamListResponse>(appFor({ movies: other }), '/api/movies/stream');
    expect(ids(body)).toEqual(['tv-247718']);
  });

  it('a stream-only title stays out of the Library list', async () => {
    const { body } = await getJson<TitleListResponse>(appFor(), '/api/movies');
    expect(body.titles.map((t) => t.id)).not.toContain(nezha2);
  });

  it('answers enabled: false with no titles when direct streaming is off or not built, 503 without movies', async () => {
    const off: StreamListResponse = { enabled: false, reason: 'direct_stream_off', titles: [] };
    expect((await getJson<StreamListResponse>(appFor({ enabled: false }), '/api/movies/stream')).body).toEqual(off);
    expect((await getJson<StreamListResponse>(appFor({ service: null }), '/api/movies/stream')).body).toEqual(off);
    const noMovies = await getJson<{ error: string }>(appFor({ movies: null }), '/api/movies/stream');
    expect(noMovies.status).toBe(503);
    expect(noMovies.body.error).toBe('movies_off');
  });
});

describe('GET /api/movies/:id stream_sources', () => {
  it('carries this host\'s rows only, each marked fresh or not', async () => {
    await source('movie-467905', 0, 0, HOST_OTHER, 1);
    const film = await getJson<TitleDetailResponse>(appFor(), '/api/movies/movie-467905');
    expect(film.body.stream_sources).toHaveLength(1);
    expect(film.body.stream_sources[0]).toMatchObject({ host: HOST_HERE, season: 0, episode: 0, provider: 'VidFast', fresh: true });

    const series = await getJson<TitleDetailResponse>(appFor(), '/api/movies/tv-247718');
    const byEpisode = Object.fromEntries(series.body.stream_sources.map((s) => [`${s.season}x${s.episode}`, s.fresh]));
    expect(byEpisode).toEqual({ '1x1': false, '1x3': false });
  });

  it('nothing is fresh while direct streaming is off', async () => {
    const film = await getJson<TitleDetailResponse>(appFor({ enabled: false }), '/api/movies/movie-467905');
    expect(film.body.stream_sources.map((s) => s.fresh)).toEqual([false]);
  });
});
```
**Impact:** new test file; runs under `npm run test:int`.

### Step 3: Route docs
**File:** `scripts/docs/httpRoutes.ts:193`
**Change:** add a line after `'GET /api/movies': ...` (`:193`). The `GET /api/movies/:id` sentence about
`stream_sources` is phase 5's alone (reconciler); this phase does not touch it and says what it adds
(`fresh`) here:

```ts
      'GET /api/movies/stream': 'The Stream side of the page: `{enabled: true, titles, fresh_days}`, the titles with a stream source verified on this machine in the last `fresh_days` days (`NOTESD_STREAM_FRESH_DAYS`) and not marked stale, each in the same shape as `GET /api/movies`. With direct streaming off (`NOTESD_DIRECT_STREAM=off`): `{enabled: false, reason: "direct_stream_off", titles: []}`. Every title answer (`GET /api/movies/:id` and the routes that return a title) also marks each of its `stream_sources` with `fresh`, the same test.',
```

Then run `npm run docs:gen` (rewrites `docs/guide/reference/http-api.md`; never edit that file by hand).
**Impact:** `npm test` (`tests/unit/docs/reference.test.ts`) passes with the new route.

### Step 4: Web API client
**File:** `web/src/moviesApi.ts:144-166` (`PlayView`), `:168-197` (`TitleDetail`), `:294-299` (`MovieChangeWire`), after `:351` (`AssignBody`), `:407-423` (`normalizeDetail`), after `:483` (end)
**Change:**

The web copies of phase 5's widened wire types (reconciler, from phase 5's handoff): in `PlayView`
(`:144-166`), `file_id: number;` becomes `file_id: number | null;`, `file_name: string;` becomes
`file_name: string | null;`, `source: 'live' | 'vlc_recents';` becomes
`source: 'live' | 'vlc_recents' | 'stream';`, and after `source` add:

```ts
  /** The direct-stream provider of a stream play (no file); null for a VLC play. */
  provider: string | null;
```

In `MovieChangeWire` (`:296`), `reason: 'sync' | 'assign' | 'user' | 'play';` becomes
`reason: 'sync' | 'assign' | 'user' | 'play' | 'stream';` (phase 5 emits `stream` when a source
turns verified or stale; the page refetches on any reason, and `useMovies` also refetches the
Stream list on it, Step 7). No page code reads a play's `file_id` or `file_name` today
(`MovieModal`'s `file_id` is the now-playing view's, not a `PlayView`'s), so nothing else changes.

Add before `export interface TitleDetail` (`:168`):

```ts
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
```

Add the field to `TitleDetail`, after `plays: PlayView[];` (`:195`):

```ts
  /** This machine's verified stream sources, in season and episode order; [] when none. */
  stream_sources: StreamSourceView[];
```

After `AssignBody` (`:351`):

```ts
/** `GET /api/movies/stream`. Off is an answer, not an error: the page says how to turn it on. */
export type StreamListResponse =
  | { enabled: true; titles: TitleListItem[]; fresh_days: number }
  | { enabled: false; reason: 'direct_stream_off'; titles: TitleListItem[] };

/** The body of phase 3's `POST /api/stream/play`. A series always names its episode. */
export type StreamRef = { kind: 'movie'; tmdb_id: number } | { kind: 'tv'; tmdb_id: number; season: number; episode: number };
```

In `normalizeDetail` (`:420-421`), after `plays: list(d.plays),` add:

```ts
    stream_sources: list(d.stream_sources),
```

Append at the end of the file:

```ts
/** The Stream side's titles. Anything but a well-formed `enabled: true` reads as off. */
export async function fetchStreamTitles(signal?: AbortSignal): Promise<StreamListResponse> {
  const j = await getJson<{ enabled?: unknown; titles?: TitleListItem[] | null; fresh_days?: unknown }>('/api/movies/stream', signal);
  if (j.enabled === true && typeof j.fresh_days === 'number') return { enabled: true, titles: list(j.titles), fresh_days: j.fresh_days };
  return { enabled: false, reason: 'direct_stream_off', titles: [] };
}

/** Phase 3: resolve the title and open the player page full screen in the streaming Chrome. Throws ApiError `no_source`, `direct_stream_off`, ... */
export async function streamPlay(ref: StreamRef): Promise<void> {
  await postJson<unknown>('/api/stream/play', ref);
}
```
**Impact:** `TitleDetail` has a new required field; the fixtures (Step 13) add it.

### Step 5: Route state
**File:** `web/src/lib/route.ts:11-13` (doc comment), `:120-151`
**Change:** In the file's doc comment, after the movies sentence (`:13`), add: ``The Stream side is `?side=stream` on `/movies` and on `/movies/<title id>`.``

Replace `:120-151` with:

```ts
/**
 * What `/movies` asks for: the grid (`title` null, `unmatched` false), one title, or the unmatched
 * list; `stream` is the Stream side (`?side=stream`): its grid, or a title opened from it. Absent =
 * the Library side. The parser never builds `title` with `unmatched`, nor `stream` with `unmatched`;
 * `moviesHref` gives `unmatched` precedence.
 */
export interface MoviesRoute {
  title: string | null;
  unmatched: boolean;
  stream?: boolean;
}

export const NO_MOVIES_ROUTE: MoviesRoute = { title: null, unmatched: false };
/** The Stream grid, `/movies?side=stream`. */
export const STREAM_ROUTE: MoviesRoute = { title: null, unmatched: false, stream: true };
/** `?side=stream`: a query, not a path segment, so `/movies/<id>` and `/movies/unmatched` keep their meaning. */
export const MOVIES_SIDE_PARAM = 'side';
const STREAM_SIDE = 'stream';

/** src/movies/ids.ts: `M-` and four of [0-9A-Z]. */
const MOVIE_ID_IN_NOTE_LINK = /^M-[0-9A-Z]{4}$/;

/** The movies route, or null when the URL is not `/movies[/<title id> | /unmatched]`. A deeper path is not this page. */
export function moviesRouteFromLocation(loc: Loc): MoviesRoute | null {
  const seg = oneSegment(pathOf(loc), MOVIES_PATH);
  if (seg === null) {
    // `/?note=M-23T4`: a movie id written as a note link (a model's slip). It can never be a note
    // (those have three characters after the dash), so it opens the movie.
    const mislinked = pathOf(loc) === '/' ? MOVIE_ID_IN_NOTE_LINK.exec(new URLSearchParams(loc.search).get('note')?.trim().toUpperCase() ?? '') : null;
    return mislinked === null ? null : { title: mislinked[0], unmatched: false };
  }
  if (seg === MOVIES_UNMATCHED_SEGMENT) return { title: null, unmatched: true };
  const title = seg === '' ? null : seg;
  return param(loc.search, MOVIES_SIDE_PARAM) === STREAM_SIDE ? { title, unmatched: false, stream: true } : { title, unmatched: false };
}

export function moviesHref(r: MoviesRoute): string {
  if (r.unmatched) return `${MOVIES_PATH}/${MOVIES_UNMATCHED_SEGMENT}`;
  const base = r.title ? `${MOVIES_PATH}/${encodeURIComponent(r.title)}` : MOVIES_PATH;
  return r.stream === true ? `${base}?${MOVIES_SIDE_PARAM}=${STREAM_SIDE}` : base;
}
```

`hrefForView` (`:174`) needs no change: it compares `moviesHref(m)` with `moviesHref(movies)`, which now includes the query.
**Impact:** `/movies?side=stream` is the Stream grid; App's popstate handling (`web/src/App.tsx:495-499`) and `hrefForView` carry it with no App change.

### Step 6: Library helpers become side-aware; stream decisions and texts
**File:** `web/src/lib/movies.ts`
**Change:** Edit the import (`:1-19`) to add `StreamListResponse`, `StreamRef`, `StreamSourceView` to the `../moviesApi` type import. Then:

(a) After `MOVIES_OFF_TEXT` (`:25`) add:

```ts
export const STREAM_HEADING = 'Stream.';
export const STREAM_OFF_TEXT =
  'Direct streaming is off on this machine. It runs with NOTESD_MOVIES on and NOTESD_DIRECT_STREAM unset or on; restart notesd after changing either.';
export const STREAM_OPENING_NOTICE = 'opening in the streaming Chrome';

/** Which side of `/movies` is shown: the files on your machines, or the titles verified to stream here. */
export type MoviesSide = 'library' | 'stream';

/** The unmatched list belongs to the Library side whatever the query says. */
export function sideOf(route: MoviesRoute): MoviesSide {
  return route.stream === true && !route.unmatched ? 'stream' : 'library';
}

/** The Stream side's empty grid: why it is empty and how a title gets onto it. */
export function streamEmptyText(freshDays: number): string {
  return `Nothing is verified to stream on this machine yet. A title shows here once a provider returned a playable stream for it on this machine in the last ${plural(freshDays, 'day')}: play one with /direct-stream <title> in Claude Code, or turn on the background prober (NOTESD_STREAM_PROBER=on) to fill this grid.`;
}
```

(b) Replace `isGone` (`:102-105`):

```ts
/** Gone: no file left on any machine. The tile is dimmed, never hidden. A Stream title has no file by design: never gone there. */
export function isGone(t: TitleListItem, side: MoviesSide = 'library'): boolean {
  return side === 'library' && t.file_count === 0;
}
```

(c) After `STATE_FILTERS` (`:133`) add:

```ts
/** The state pills a side shows: `gone` is about files, so the Stream side has none. */
export function stateFilters(side: MoviesSide): readonly { key: StateFilter; label: string }[] {
  return side === 'stream' ? STATE_FILTERS.filter((s) => s.key !== 'gone') : STATE_FILTERS;
}
```

(d) Replace `matchesFilter`, `stateCounts`, `rank`, `sortTitles` (`:141-185`):

```ts
/** `finished` includes `seen` (opened, position unknown). `gone` is about files, not state: it overlaps the others. */
export function matchesFilter(t: TitleListItem, f: MoviesFilter, side: MoviesSide = 'library'): boolean {
  if (f.kind !== 'all' && t.kind !== f.kind) return false;
  const q = f.text.trim().toLowerCase();
  if (q !== '' && !`${t.title} ${t.year ?? ''}`.toLowerCase().includes(q)) return false;
  switch (f.state) {
    case 'all':
      return true;
    case 'unwatched':
      return t.state === 'unwatched';
    case 'in_progress':
      return t.state === 'in_progress';
    case 'finished':
      return t.state === 'finished' || t.state === 'seen';
    case 'gone':
      return isGone(t, side);
  }
}

/** How many titles each state pill would show under the current kind and text filter. */
export function stateCounts(titles: TitleListItem[], f: MoviesFilter, side: MoviesSide = 'library'): Record<StateFilter, number> {
  const out: Record<StateFilter, number> = { all: 0, unwatched: 0, in_progress: 0, finished: 0, gone: 0 };
  for (const t of titles) {
    for (const s of STATE_FILTERS) if (matchesFilter(t, { ...f, state: s.key }, side)) out[s.key] += 1;
  }
  return out;
}

function rank(t: TitleListItem, side: MoviesSide): number {
  if (isGone(t, side)) return 3;
  if (t.state === 'in_progress') return 0;
  if (t.state === 'unwatched') return 1;
  return 2;
}

/** In progress first (what to continue), then unwatched (what to start), then finished, then gone; newest play, newest year, title. */
export function sortTitles(titles: TitleListItem[], side: MoviesSide = 'library'): TitleListItem[] {
  return [...titles].sort(
    (a, b) =>
      rank(a, side) - rank(b, side) ||
      (b.last_played_at ?? '').localeCompare(a.last_played_at ?? '') ||
      (b.year ?? 0) - (a.year ?? 0) ||
      a.title.localeCompare(b.title),
  );
}
```

(e) After `playLabel` (`:228`) add the stream decisions:

```ts
/** A stream the page can start: the body of POST /api/stream/play, what it names (`S01E02`; '' for a film) and this machine's source row for it. */
export interface StreamTarget {
  ref: StreamRef;
  code: string;
  source: StreamSourceView | null;
}

/** This machine's source row for a film (season 0, episode 0) or one episode; null when none was ever recorded. */
export function sourceOf(d: TitleDetail, season: number, episode: number): StreamSourceView | null {
  return d.stream_sources.find((s) => s.season === season && s.episode === episode) ?? null;
}

export function episodeStreamTarget(d: TitleDetail, e: EpisodeView): StreamTarget {
  return {
    ref: { kind: 'tv', tmdb_id: d.tmdb_id, season: e.season, episode: e.episode },
    code: episodeCode(e.season, e.episode),
    source: sourceOf(d, e.season, e.episode),
  };
}

/**
 * What streaming the whole title starts: the film, or a series' first episode (season 1 on) that is
 * not finished, else its first episode. Null for a series with no episode listed.
 */
export function streamTarget(d: TitleDetail): StreamTarget | null {
  if (d.kind === 'movie') return { ref: { kind: 'movie', tmdb_id: d.tmdb_id }, code: '', source: sourceOf(d, 0, 0) };
  const episodes = d.seasons.filter((s) => s.season >= 1).flatMap((s) => s.episodes);
  const next = episodes.find((e) => e.state !== 'finished' && e.state !== 'seen') ?? episodes[0];
  return next === undefined ? null : episodeStreamTarget(d, next);
}

function isFresh(t: StreamTarget | null): t is StreamTarget {
  return t !== null && t.source !== null && t.source.fresh;
}

/**
 * The big Play button. File first (R5.5): a file on this machine always plays in VLC, and a fresh
 * stream is then the second icon. Without a file here it streams on the Stream side, or on the
 * Library side when a fresh source exists; otherwise it keeps today's disabled reason.
 */
export type TitleAction =
  | { kind: 'vlc'; plan: { kind: 'file'; file: FileView } | { kind: 'continue' }; stream: StreamTarget | null }
  | { kind: 'stream'; target: StreamTarget }
  | { kind: 'idle'; plan: { kind: 'elsewhere'; host: string } | { kind: 'none' } };

export function titleAction(d: TitleDetail, side: MoviesSide): TitleAction {
  const plan = playPlan(d);
  const target = streamTarget(d);
  if (plan.kind === 'file' || plan.kind === 'continue') return { kind: 'vlc', plan, stream: isFresh(target) ? target : null };
  if (target !== null && (side === 'stream' || isFresh(target))) return { kind: 'stream', target };
  return { kind: 'idle', plan };
}

/** One episode row's play icon, by the same rule as the title's. */
export type EpisodeAction = { kind: 'vlc'; file: FileView; stream: StreamTarget | null } | { kind: 'stream'; target: StreamTarget } | { kind: 'idle' };

export function episodeAction(d: TitleDetail, e: EpisodeView, side: MoviesSide): EpisodeAction {
  const file = primaryFile(e);
  const target = episodeStreamTarget(d, e);
  if (file !== null && file.available) return { kind: 'vlc', file, stream: isFresh(target) ? target : null };
  if (side === 'stream' || isFresh(target)) return { kind: 'stream', target };
  return { kind: 'idle' };
}

/** `VidFast · 2160p · English subtitle`. */
export function streamSourceText(s: StreamSourceView): string {
  const sub = s.en_subtitle === true ? 'English subtitle' : s.en_subtitle === false ? 'no English subtitle' : 'subtitle unknown';
  return [s.provider, s.best_height !== null ? `${s.best_height}p` : '', sub].filter((x) => x !== '').join(' · ');
}

/** The stream line on a title's page: provider, quality and English subtitle; null when there is nothing to say. */
export function streamLine(d: TitleDetail, side: MoviesSide): string | null {
  if (d.kind === 'tv') {
    const verified = new Set(d.stream_sources.filter((s) => s.fresh).map((s) => `${s.season}x${s.episode}`)).size;
    if (verified > 0) return `Stream: ${plural(verified, 'episode')} verified on this machine; any other episode is checked when you play it`;
    return side === 'stream' ? 'Stream: an episode is checked when you play it' : null;
  }
  const s = sourceOf(d, 0, 0);
  if (s !== null && s.fresh) return `Stream: ${streamSourceText(s)}`;
  if (s !== null && s.stale_at !== null) return `Stream: no source answered on ${dayText(s.stale_at)}`;
  return side === 'stream' ? 'Stream: not verified yet; Play checks it' : null;
}

/** A stream button's label: what it starts and from where, or why it cannot. */
export function streamLabel(t: StreamTarget, enabled: boolean): PlayButtonState {
  if (!enabled) return { label: 'Direct streaming is off on this machine', disabled: true };
  const what = t.code === '' ? 'Stream' : `Stream ${t.code}`;
  const s = t.source;
  if (s !== null && s.fresh) return { label: `${what} (${streamSourceText(s)})`, disabled: false };
  if (s !== null && s.stale_at !== null) return { label: `${what}: no source answered last time, try again`, disabled: false };
  return { label: `${what}: checked when it starts`, disabled: false };
}

/** What a failed stream play says. `no_source`: phase 5 marked the source stale, so a film leaves the Stream grid. */
export function streamErrorText(code: string, detail: string | null, t: StreamTarget, title: string): string {
  if (code === 'no_source') return t.code === '' ? `no provider could stream ${title} now; it leaves the Stream grid` : `no provider could stream ${t.code} now`;
  if (code === 'direct_stream_off') return 'direct streaming is off on this machine';
  return detail ?? `could not stream ${t.code === '' ? title : t.code} (${code})`;
}
```

(f) Replace `seasonsShown` (`:308-312`):

```ts
/**
 * `focus`: an episode's movie id whose season is shown even when no machine holds a file of it.
 * The Stream side lists every season: any episode can be streamed, and is verified when clicked.
 */
export function seasonsShown(d: TitleDetail, focus: string | null = null, side: MoviesSide = 'library'): SeasonsShown {
  if (side === 'stream') return { seasons: d.seasons.filter((s) => s.episodes.length > 0), hidden: 0 };
  const seasons = d.seasons.filter((s) => s.episodes.some((e) => e.has_file || (focus !== null && e.movie_id === focus)));
  return { seasons, hidden: d.seasons.length - seasons.length };
}
```

(g) Replace `MoviesView` and `isMoviesOff` (`:350-363`):

```ts
/** What the header and the page read from the store (structurally `MoviesStore` minus its actions). */
export interface MoviesView {
  titles: TitleListItem[] | null;
  listError: string | null;
  detail: TitleDetail | null;
  detailError: string | null;
  unmatched: UnmatchedFile[] | null;
  unmatchedError: string | null;
  status: MoviesStatusResponse | null;
  /** The Stream side's list; null until it is asked for (only on the Stream side). */
  stream: StreamListResponse | null;
  streamError: string | null;
}

export function isMoviesOff(s: MoviesView): boolean {
  return s.listError === 'movies_off' || s.detailError === 'movies_off' || s.unmatchedError === 'movies_off' || s.streamError === 'movies_off';
}
```

(h) Replace `moviesHeading` and `moviesCountLine` (`:420-446`):

```ts
export function moviesHeading(s: MoviesView, route: MoviesRoute): string {
  if (route.unmatched) return UNMATCHED_HEADING;
  if (detailIsFor(s.detail, route.title)) return `${s.detail.title}.`;
  if (route.title === null && sideOf(route) === 'stream') return STREAM_HEADING;
  return MOVIES_HEADING;
}

export function moviesCountLine(s: MoviesView, route: MoviesRoute): string {
  if (isMoviesOff(s)) return 'Movies are off on this daemon.';
  if (route.unmatched) {
    if (s.unmatchedError !== null) return moviesErrorText(s.unmatchedError);
    if (s.unmatched === null) return 'Loading unmatched files.';
    const n = s.unmatched.length;
    return n === 0 ? 'Every file on this machine matched a title.' : `${plural(n, 'file')} on this machine matched no title. Assign one by hand.`;
  }
  if (route.title !== null) {
    if (s.detailError !== null) return moviesErrorText(s.detailError, route.title);
    if (!detailIsFor(s.detail, route.title)) return 'Loading.';
    return `${factsLine(s.detail)}.`;
  }
  if (sideOf(route) === 'stream') {
    if (s.streamError !== null) return moviesErrorText(s.streamError);
    if (s.stream === null) return 'Loading the Stream titles.';
    if (!s.stream.enabled) return 'Direct streaming is off on this machine.';
    const n = s.stream.titles.length;
    return n === 0 ? 'Nothing verified to stream on this machine yet.' : `${plural(n, 'title')} verified to stream on this machine in the last ${plural(s.stream.fresh_days, 'day')}.`;
  }
  if (s.listError !== null) return moviesErrorText(s.listError);
  if (s.titles === null) return 'Loading the library.';
  if (s.titles.length === 0) return 'No titles yet.';
  const films = s.titles.filter((t) => t.kind === 'movie').length;
  const series = s.titles.length - films;
  const going = s.titles.filter((t) => t.state === 'in_progress').length;
  return `${plural(s.titles.length, 'title')}: ${plural(films, 'film')}, ${series} series.${going > 0 ? ` ${going} in progress.` : ''}`;
}
```

(i) In `moviesChatMessage` (`:493`) replace `else if (route.title === null) where = 'library';` with:

```ts
  else if (route.title === null) where = sideOf(route) === 'stream' ? 'stream' : 'library';
```

**Impact:** existing callers keep the Library behaviour through the default `side`. `moviesChatMessage` now says `[Movies · stream]` on the Stream grid.

### Step 7: The store fetches the Stream list
**File:** `web/src/hooks/useMovies.ts` (whole file)
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  errorCode,
  fetchMovie,
  fetchMovies,
  fetchPlayer,
  fetchStatus,
  fetchStreamTitles,
  fetchUnmatched,
  MOVIES_EVENTS_URL,
  type MoviesStatusResponse,
  type PlayerState,
  type StreamListResponse,
  type TitleDetail,
  type TitleListItem,
  type UnmatchedFile,
} from '../moviesApi';
import { isPageVisible, onBecameVisible, startAdaptivePoll } from '../lib/pageActive';
import { detailIsFor } from '../lib/movies';
import type { MoviesRoute } from '../lib/route';

/** Every minute while the tab is visible: picks up a sync or a play on the other laptop (its events never reach this daemon). */
export const MOVIES_POLL_MS = 60_000;
/** While a VLC that notesd started is playing: the player and the open title, so the position moves on the page. */
export const PLAY_POLL_MS = 5_000;

export interface MoviesStore {
  titles: TitleListItem[] | null;
  listError: string | null;
  /** The detail of the title asked for (null while loading, and on the grid or unmatched page). */
  detail: TitleDetail | null;
  detailError: string | null;
  unmatched: UnmatchedFile[] | null;
  unmatchedError: string | null;
  status: MoviesStatusResponse | null;
  player: PlayerState | null;
  /** The Stream side's list (`GET /api/movies/stream`), fetched only while the route is on the Stream side. */
  stream: StreamListResponse | null;
  streamError: string | null;
  /** Re-read everything the page shows. Called after every write: the server's state wins. */
  refresh: () => void;
}

function quiet(what: string, e: unknown): void {
  if (errorCode(e) !== 'movies_off') console.error(`movies: ${what} failed`, e);
}

/**
 * The Movies page's data. Fetches only while `enabled` (the page is shown): the library (grid and
 * header), the status (unmatched badge, empty state), the player, the title or unmatched list the
 * route asks for, and on the Stream side its list. Refreshes on `GET /api/movies/events` `changed`,
 * every minute while visible, and, while a play is active, the player and the open title every 5 s
 * (one full refresh when it ends). Every refresh re-reads the Stream list too, so a title whose
 * source went stale leaves the grid on the refresh after a failed play.
 */
export function useMovies(enabled: boolean, route: MoviesRoute): MoviesStore {
  const [titles, setTitles] = useState<TitleListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [unmatched, setUnmatched] = useState<UnmatchedFile[] | null>(null);
  const [unmatchedError, setUnmatchedError] = useState<string | null>(null);
  const [status, setStatus] = useState<MoviesStatusResponse | null>(null);
  const [player, setPlayer] = useState<PlayerState | null>(null);
  const [stream, setStream] = useState<StreamListResponse | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [playTick, setPlayTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** A `changed` event arrived while the tab was hidden: refresh once on becoming visible. */
  const staleRef = useRef(false);
  const wasPlaying = useRef(false);
  const title = route.title;
  const wantUnmatched = route.unmatched;
  const wantStream = route.stream === true && !route.unmatched;
  const playing = player !== null && player.current !== null;

  useEffect(() => {
    if (!enabled) return;
    const onChanged = () => {
      if (isPageVisible()) refresh();
      else staleRef.current = true;
    };
    const es = typeof EventSource === 'undefined' ? null : new EventSource(MOVIES_EVENTS_URL);
    es?.addEventListener('changed', onChanged);
    const offVisible = onBecameVisible(() => {
      if (staleRef.current) {
        staleRef.current = false;
        refresh();
      }
    });
    const poll = startAdaptivePoll({
      baseMs: MOVIES_POLL_MS,
      run: async () => {
        refresh();
        return true;
      },
    });
    return () => {
      es?.close();
      offVisible();
      poll.stop();
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetchMovies(ac.signal).then(
      (t) => {
        if (ac.signal.aborted) return;
        setTitles(t);
        setListError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setListError(errorCode(e));
      },
    );
    fetchStatus(ac.signal).then(
      (s) => {
        if (!ac.signal.aborted) setStatus(s);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) quiet('status GET', e);
      },
    );
    return () => ac.abort();
  }, [enabled, tick]);

  useEffect(() => {
    if (!enabled || !wantStream) return;
    const ac = new AbortController();
    fetchStreamTitles(ac.signal).then(
      (s) => {
        if (ac.signal.aborted) return;
        setStream(s);
        setStreamError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setStreamError(errorCode(e));
      },
    );
    return () => ac.abort();
  }, [enabled, wantStream, tick]);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetchPlayer(ac.signal).then(
      (p) => {
        if (!ac.signal.aborted) setPlayer(p);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) quiet('player GET', e);
      },
    );
    return () => ac.abort();
  }, [enabled, tick, playTick]);

  useEffect(() => {
    if (!enabled || !playing) return;
    const timer = window.setInterval(() => {
      if (isPageVisible()) setPlayTick((t) => t + 1);
    }, PLAY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, playing]);

  // The play ended (VLC closed): states, progress and the grid changed, so read everything once.
  useEffect(() => {
    if (wasPlaying.current && !playing) refresh();
    wasPlaying.current = playing;
  }, [playing, refresh]);

  // A switch to another title drops the old detail at once, so its facts never show under the new heading.
  useEffect(() => {
    setDetail((d) => (detailIsFor(d, title) ? d : null));
    setDetailError(null);
  }, [title]);

  useEffect(() => {
    if (!enabled || title === null) return;
    const ac = new AbortController();
    fetchMovie(title, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setDetail(d);
        setDetailError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setDetailError(errorCode(e));
      },
    );
    return () => ac.abort();
  }, [enabled, title, tick, playTick]);

  useEffect(() => {
    if (!enabled || !wantUnmatched) return;
    const ac = new AbortController();
    fetchUnmatched(ac.signal).then(
      (f) => {
        if (ac.signal.aborted) return;
        setUnmatched(f);
        setUnmatchedError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setUnmatchedError(errorCode(e));
      },
    );
    return () => ac.abort();
  }, [enabled, wantUnmatched, tick]);

  return { titles, listError, detail, detailError, unmatched, unmatchedError, status, player, stream, streamError, refresh };
}
```
**Impact:** the Library side makes no new request (proved in J6's `App.stream.test.tsx`, "R5.1").

### Step 8: Grid and poster take a side
**File:** `web/src/components/movies/MoviesGrid.tsx` (whole file)
**Code:**
```tsx
import { FilmSlate, MagnifyingGlass, SquaresFour, Television } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { PlayerState, TitleListItem } from '../../moviesApi';
import { KIND_FILTERS, matchesFilter, sortTitles, stateCounts, stateFilters, tileLive, type KindFilter, type MoviesFilter, type MoviesSide } from '../../lib/movies';
import { PosterTile } from './PosterTile';

const KIND_ICON: Record<KindFilter, Icon> = { all: SquaresFour, movie: FilmSlate, tv: Television };

export interface MoviesGridProps {
  titles: TitleListItem[];
  /** The followed play marks its title's poster. */
  player?: PlayerState | null;
  filter: MoviesFilter;
  onFilter: (f: MoviesFilter) => void;
  onOpen: (titleId: string) => void;
  /** `stream`: the Stream side's grid. A title there has no file by design, so nothing is "gone" and there is no gone pill. */
  side?: MoviesSide;
}

/** The library or the Stream side: a filter row (state pills with counts, kind icons, a text filter), then one poster per title. */
export function MoviesGrid({ titles, player = null, filter, onFilter, onOpen, side = 'library' }: MoviesGridProps) {
  const counts = stateCounts(titles, filter, side);
  const shown = sortTitles(
    titles.filter((t) => matchesFilter(t, filter, side)),
    side,
  );
  return (
    <section className="mv-lib mv-content" aria-label={side === 'stream' ? 'Stream' : 'Library'}>
      <div className="mv-filter">
        <div className="mv-fstates" role="group" aria-label="State">
          {stateFilters(side).map((s) => (
            <button
              key={s.key}
              type="button"
              className={filter.state === s.key ? 'mv-fpill on' : 'mv-fpill'}
              aria-pressed={filter.state === s.key}
              onClick={() => onFilter({ ...filter, state: s.key })}
            >
              {s.label}
              <span className="mv-fn">{counts[s.key]}</span>
            </button>
          ))}
        </div>
        <div className="mv-fkinds" role="group" aria-label="Kind">
          {KIND_FILTERS.map((k) => {
            const I = KIND_ICON[k.key];
            const on = filter.kind === k.key;
            return (
              <button
                key={k.key}
                type="button"
                className={on ? 'ibtn on' : 'ibtn hov'}
                data-tip={k.label}
                data-tip-side="below"
                aria-label={k.label}
                aria-pressed={on}
                onClick={() => onFilter({ ...filter, kind: k.key })}
              >
                <I weight="duotone" />
              </button>
            );
          })}
        </div>
        <label className="mv-ftext">
          <MagnifyingGlass weight="duotone" />
          <input type="search" value={filter.text} placeholder="Filter titles" aria-label="Filter titles" onChange={(e) => onFilter({ ...filter, text: e.target.value })} />
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="mv-empty">Nothing matches this filter.</p>
      ) : (
        <div className="mv-grid" role="list" aria-label="Posters">
          {shown.map((t) => (
            <div key={t.id} role="listitem">
              <PosterTile title={t} side={side} live={tileLive(t.id, player)} onOpen={onOpen} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

**File:** `web/src/components/movies/PosterTile.tsx` (whole file)
**Code:**
```tsx
import type { MouseEvent } from 'react';
import type { TitleListItem } from '../../moviesApi';
import { isGone, kindLabel, stateBadge, TILE_LIVE_LABEL, tileProgress, type MoviesSide, type TileLive } from '../../lib/movies';
import { moviesHref } from '../../lib/route';
import { Poster } from './Poster';

export interface PosterTileProps {
  title: TitleListItem;
  /** This title is in the VLC notesd follows. */
  live?: TileLive | null;
  /** The Stream side: never dimmed as gone, and the link opens the title on the Stream side. */
  side?: MoviesSide;
  onOpen: (titleId: string) => void;
}

/** One poster: state chip, progress bar while in progress, caption below. A real link, so a middle click opens a tab. */
export function PosterTile({ title: t, live = null, side = 'library', onOpen }: PosterTileProps) {
  const gone = isGone(t, side);
  const badge = stateBadge(t.state);
  const progress = tileProgress(t);
  const titleId = t.movie_id ?? t.id;
  const href = moviesHref(side === 'stream' ? { title: titleId, unmatched: false, stream: true } : { title: titleId, unmatched: false });
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(titleId);
  };
  return (
    <a href={href} className={['mv-tile', gone ? 'gone' : '', live !== null ? `now ${live}` : ''].filter((c) => c !== '').join(' ')} data-title={titleId} onClick={open}>
      <span className="mv-art">
        <Poster key={t.poster_url ?? 'none'} url={t.poster_url} title={t.title} year={t.year} />
        {live === null && badge !== null && <span className={`mv-badge ${t.state}`}>{badge}</span>}
        {live !== null && (
          <span className={`mv-badge mv-now ${live}`} role="status" aria-label={`${t.title}: ${TILE_LIVE_LABEL[live]} in VLC`}>
            {TILE_LIVE_LABEL[live]}
          </span>
        )}
        {progress !== null && (
          <span className="mv-progress" aria-hidden="true">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="mv-cap">
        <span className="mv-cap-t">{t.title}</span>
        <span className="mv-cap-m">
          {[t.year === null ? '' : String(t.year), kindLabel(t.kind), gone ? 'no file left' : ''].filter((s) => s !== '').join(' · ')}
        </span>
      </span>
    </a>
  );
}
```
**Impact:** the Library grid renders exactly as before (default `side`).

### Step 9: The secondary stream icon
**File:** `web/src/components/movies/parts.tsx:1` (import), after `:66` (`PlayButton`)
**Change:** import `Broadcast` with the other icons:

```ts
import { Broadcast, CheckCircle, Desktop, MonitorPlay, Play, Trash } from '@phosphor-icons/react';
```

Add after `PlayButton`:

```tsx
/**
 * Stream instead: the second icon beside a Play that plays a file on this machine (R5.5 keeps the
 * file as the default). `ibtn` on a title's page, `pbtn` in an episode row.
 */
export function StreamAltButton({ state, busy, onClick, size = 'row' }: { state: PlayButtonState; busy: boolean; onClick: () => void; size?: 'row' | 'page' }) {
  return (
    <button
      type="button"
      className={size === 'page' ? 'ibtn hov mv-stream-alt' : 'pbtn hov mv-stream-alt'}
      data-tip={state.label}
      data-tip-side={size === 'page' ? 'below' : undefined}
      aria-label={state.label}
      disabled={state.disabled || busy}
      onClick={onClick}
    >
      <Broadcast weight="duotone" />
    </button>
  );
}
```

### Step 10: The title page streams
**File:** `web/src/components/movies/MovieDetail.tsx` (whole file; `CastList` is unchanged and repeated in full)
**Code:**
```tsx
import { Fragment, useEffect, useState } from 'react';
import { CaretUp, CheckCircle, DotsThree, Play } from '@phosphor-icons/react';
import { continueTitle, errorCode, errorDetail, playFile, saveTitleUser, setFileWatched, streamPlay, type CastCredit, type FileView, type PlayerState, type TitleDetail } from '../../moviesApi';
import {
  CAST_LIMIT,
  continueNotice,
  creditGroups,
  kindLabel,
  playErrorText,
  playLabel,
  releaseText,
  runtimeText,
  seasonsText,
  startedNotice,
  STATE_LABEL,
  STREAM_OPENING_NOTICE,
  streamErrorText,
  streamLabel,
  streamLine,
  TILE_LIVE_LABEL,
  tileLive,
  titleAction,
  trailerTarget,
  type MovieEntity,
  type MoviesSide,
  type StreamTarget,
  type TrailerTarget,
} from '../../lib/movies';
import { EpisodeList } from './EpisodeList';
import { EntityLink, FileRow, LiveStatus, StreamAltButton, TrailerButton } from './parts';
import { Poster } from './Poster';
import { ReviewField } from './ReviewField';
import { Stars } from './Stars';
import { TrailerModal } from './TrailerModal';

export interface MovieDetailProps {
  detail: TitleDetail;
  player: PlayerState | null;
  /** The movie id in the address (`/movies/M-0T77`): an episode's id scrolls the page to that episode. */
  focus?: string | null;
  /** Re-read the store after a write (the server's state wins). */
  onChanged: () => void;
  onNotice: (text: string) => void;
  /** Asks about a person, studio, character or genre through the page's pill. Absent: the names are plain text. */
  onEntity?: (e: MovieEntity) => void;
  /** An answer is streaming: entity links wait. */
  asking?: boolean;
  /** The side the title was opened from: on `stream`, Play streams when no file is on this machine. */
  side?: MoviesSide;
  /** False when GET /api/movies/stream said direct streaming is off: the stream buttons say so and are disabled. */
  streamEnabled?: boolean;
}

/**
 * One title (`/movies/<id>`, `/movies/<id>?side=stream`), a film or a series: poster, facts (release
 * date, runtime or seasons, genres), the stream source line, the Play button (VLC on a file here;
 * else the stream player), a second stream icon when both exist, the trailer, the watched flag,
 * stars, synopsis, the review, credits, the cast with character names, then the film's files or
 * the series' episodes, each with progress, its deleted / other-machine flag and its stream icon.
 */
export function MovieDetail({ detail: d, player, focus = null, onChanged, onNotice, onEntity, asking = false, side = 'library', streamEnabled = true }: MovieDetailProps) {
  const [watched, setWatched] = useState(d.watched);
  const [rating, setRating] = useState<number | null>(d.rating);
  const [busy, setBusy] = useState(false);
  useEffect(() => setWatched(d.watched), [d.watched]);
  useEffect(() => setRating(d.rating), [d.rating]);
  /** The trailer playing in the pop-up. It has a video id: a title without one searches YouTube in a new tab instead. */
  const [trailer, setTrailer] = useState<TrailerTarget | null>(null);
  useEffect(() => setTrailer(null), [d.id]);

  const action = titleAction(d, side);
  const play = action.kind === 'stream' ? streamLabel(action.target, streamEnabled) : playLabel(action.plan, player);
  /** The stream behind a Play that plays a file here (R5.5: the file stays the default). */
  const alt = action.kind === 'vlc' ? action.stream : null;
  const line = streamLine(d, side);
  const current = player?.current ?? null;
  const live = current !== null && current.title_id === d.id ? current : null;
  /** playing / paused / stalled, as on the poster in the grid; null when nothing of this title is in VLC (or it is stopped). */
  const now = tileLive(d.id, player);

  const run = async (act: () => Promise<string>, failed: (code: string, detail: string | null) => string = playErrorText) => {
    setBusy(true);
    try {
      onNotice(await act());
    } catch (e) {
      onNotice(failed(errorCode(e), errorDetail(e)));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const playOne = (f: FileView) => {
    void run(async () => {
      return startedNotice(f, await playFile(f.id));
    });
  };

  /** One request: the daemon resolves and opens the player full screen in the streaming Chrome. A refresh follows either way. */
  const streamOne = (t: StreamTarget) => {
    void run(
      async () => {
        await streamPlay(t.ref);
        return STREAM_OPENING_NOTICE;
      },
      (code, detail) => streamErrorText(code, detail, t, d.title),
    );
  };

  const start = () => {
    if (action.kind === 'stream') streamOne(action.target);
    else if (action.kind === 'vlc') {
      if (action.plan.kind === 'continue') void run(async () => continueNotice(await continueTitle(d.id)));
      else playOne(action.plan.file);
    }
  };

  const toggleWatched = async () => {
    const next = !watched;
    setWatched(next);
    try {
      await saveTitleUser(d.id, { watched: next });
    } catch (e) {
      setWatched(!next);
      onNotice(`could not save (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  const rate = async (value: number) => {
    const before = rating;
    setRating(value);
    try {
      await saveTitleUser(d.id, { rating: value });
    } catch (e) {
      setRating(before);
      onNotice(`could not save the rating (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  const toggleFileWatched = async (f: FileView) => {
    try {
      await setFileWatched(f.id, f.watched_at === null);
    } catch (e) {
      onNotice(`could not save (${errorCode(e)})`);
    } finally {
      onChanged();
    }
  };

  const watchedLabel = watched ? 'Watched (click to unmark)' : 'Mark as watched';
  const facts = [
    d.release_date !== null ? `Released ${releaseText(d.release_date)}` : d.year !== null ? String(d.year) : '',
    d.kind === 'tv' ? seasonsText(d.season_count) : runtimeText(d.runtime_min),
  ].filter((s) => s !== '');
  const credits = creditGroups(d);

  return (
    <article className="mv-detail mv-content" aria-label={d.title} data-title={d.id}>
      {d.backdrop_url !== null && (
        <div className="mv-hero" aria-hidden="true">
          <img src={d.backdrop_url} alt="" loading="lazy" />
        </div>
      )}
      <div className="mv-detail-grid">
        <div className={now === null ? 'mv-detail-art' : `mv-detail-art now ${now}`}>
          <Poster key={d.poster_url ?? 'none'} url={d.poster_url} title={d.title} year={d.year} />
          {now !== null && <span className={`mv-badge mv-now ${now}`}>{TILE_LIVE_LABEL[now]}</span>}
        </div>
        <div className="mv-detail-info">
          <p className="mv-facts">
            {d.movie_id !== null && (
              <span className="mv-code" data-testid="movie-id" data-tip="Movie id: name it to Claude" data-tip-side="below">
                {d.movie_id}
              </span>
            )}
            {facts.map((f, i) => (
              <span key={i}>{f}</span>
            ))}
            {d.genres.length > 0 && (
              <span className="mv-genres">
                {d.genres.map((g, i) => (
                  <Fragment key={g}>
                    {i > 0 && ', '}
                    <EntityLink entity={{ kind: 'genre', name: g }} onAsk={onEntity} busy={asking} />
                  </Fragment>
                ))}
              </span>
            )}
            <span className="mv-chip">
              {kindLabel(d.kind)} · {STATE_LABEL[d.state]}
            </span>
          </p>
          {line !== null && (
            <p className="mv-stream-line" data-testid="stream-source">
              {line}
            </p>
          )}
          <div className="mv-actions">
            <button type="button" className="ibtn on mv-play" data-tip={play.label} data-tip-side="below" aria-label={play.label} disabled={play.disabled || busy} onClick={start}>
              <Play weight="duotone" />
            </button>
            {alt !== null && <StreamAltButton size="page" state={streamLabel(alt, streamEnabled)} busy={busy} onClick={() => streamOne(alt)} />}
            <TrailerButton target={trailerTarget(d)} onWatch={setTrailer} />
            <button
              type="button"
              className={watched ? 'ibtn on' : 'ibtn hov'}
              data-tip={watchedLabel}
              data-tip-side="below"
              aria-label={watchedLabel}
              aria-pressed={watched}
              onClick={() => void toggleWatched()}
            >
              <CheckCircle weight="duotone" />
            </button>
            <Stars value={rating} onRate={(v) => void rate(v)} />
            {live !== null && <LiveStatus live={live} now={now} />}
          </div>
          {d.overview !== '' && <p className="mv-overview">{d.overview}</p>}
          <ReviewField key={d.id} titleId={d.id} saved={d.review} onSaved={onChanged} onNotice={onNotice} />
          {credits.length > 0 && (
            <dl className="mv-credits" aria-label="Credits">
              {credits.map((g) => (
                <div key={g.label}>
                  <dt>{g.label}</dt>
                  <dd>
                    {g.entities.map((e, i) => (
                      <Fragment key={`${e.name}-${i}`}>
                        {i > 0 && ', '}
                        <EntityLink entity={e} onAsk={onEntity} busy={asking} />
                      </Fragment>
                    ))}
                    {g.more > 0 && ` and ${g.more} more`}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      <CastList cast={d.cast} onEntity={onEntity} asking={asking} />
      {d.kind === 'tv' ? (
        <EpisodeList
          detail={d}
          player={player}
          focus={focus}
          busy={busy}
          side={side}
          streamEnabled={streamEnabled}
          onPlay={playOne}
          onStream={streamOne}
          onWatched={(f) => void toggleFileWatched(f)}
          onTrailer={setTrailer}
        />
      ) : (
        (side === 'library' || d.files.length > 0) && (
          <section className="mv-sec" aria-label="Files">
            <h2 className="mv-h2">Files</h2>
            <ul className="mv-files">
              {d.files.map((f) => (
                <FileRow key={f.id} file={f} player={player} busy={busy} onPlay={playOne} onWatched={(x) => void toggleFileWatched(x)} />
              ))}
            </ul>
          </section>
        )
      )}
      {trailer !== null && trailer.key !== null && <TrailerModal videoKey={trailer.key} name={trailer.name} onClose={() => setTrailer(null)} />}
    </article>
  );
}

/** The cast with their character names; the first CAST_LIMIT, then an icon to show the rest. */
function CastList({ cast, onEntity, asking }: { cast: CastCredit[]; onEntity: ((e: MovieEntity) => void) | undefined; asking: boolean }) {
  const [all, setAll] = useState(false);
  if (cast.length === 0) return null;
  const shown = all ? cast : cast.slice(0, CAST_LIMIT);
  const label = all ? 'Show less cast' : `Show all ${cast.length} cast`;
  return (
    <section className="mv-sec" aria-label="Cast">
      <h2 className="mv-h2">Cast</h2>
      <ul className="mv-cast">
        {shown.map((c) => (
          <li key={c.person_id}>
            <span className="mv-cast-n">
              <EntityLink entity={{ kind: 'person', name: c.name, personId: c.person_id, role: c.character === '' ? null : c.character, cast: true }} onAsk={onEntity} busy={asking} />
            </span>
            {c.character !== null && c.character !== '' && (
              <span className="mv-cast-c">
                <EntityLink entity={{ kind: 'character', name: c.character, actor: c.name, personId: c.person_id }} onAsk={onEntity} busy={asking} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {cast.length > CAST_LIMIT && (
        <button type="button" className="ibtn hov" data-tip={label} aria-label={label} onClick={() => setAll((a) => !a)}>
          {all ? <CaretUp weight="duotone" /> : <DotsThree weight="duotone" />}
        </button>
      )}
    </section>
  );
}
```
**Impact:** a Library title with a file and no stream source renders exactly as before (`action.kind === 'vlc'`, `alt === null`, `line === null`). `playPlan` stays exported and used by `MovieModal`.

### Step 11: Episodes stream
**File:** `web/src/components/movies/EpisodeList.tsx` (whole file)
**Code:**
```tsx
import { useEffect, useRef } from 'react';
import type { EpisodeView, FileView, PlayerState, TitleDetail } from '../../moviesApi';
import { episodeAction, episodeCode, filePlayLabel, primaryFile, seasonsShown, streamLabel, streamSourceText, trailerTarget, type MoviesSide, type PlayButtonState, type StreamTarget, type TrailerTarget } from '../../lib/movies';
import { FileFlags, FileRow, Meter, PlayButton, StreamAltButton, TrailerButton, WatchedButton } from './parts';

export interface EpisodeListProps {
  detail: TitleDetail;
  player: PlayerState | null;
  /** An episode's movie id from the address: its row is marked, its season shown even without a file, and scrolled to once. */
  focus?: string | null;
  busy: boolean;
  /** `stream`: every season is listed and an episode without a file here streams (verified when clicked). */
  side: MoviesSide;
  streamEnabled: boolean;
  onPlay: (f: FileView) => void;
  onStream: (t: StreamTarget) => void;
  onWatched: (f: FileView) => void;
  /** Plays a season's trailer in the page's pop-up. */
  onTrailer: (t: TrailerTarget) => void;
}

/** A series' seasons (Library: those with a file on any machine; Stream: all), each with its trailer and every episode with its progress, flags and play icons; then files with no episode. */
export function EpisodeList({ detail, player, focus = null, busy, side, streamEnabled, onPlay, onStream, onWatched, onTrailer }: EpisodeListProps) {
  const { seasons, hidden } = seasonsShown(detail, focus, side);
  const list = useRef<HTMLElement>(null);
  // Once per (title, focus): a refresh of the detail must not pull the page back to the episode.
  const found = focus !== null && seasons.some((s) => s.episodes.some((e) => e.movie_id === focus));
  useEffect(() => {
    if (!found || focus === null) return;
    list.current?.querySelector(`[data-movie-id="${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [detail.id, focus, found]);
  return (
    <section className="mv-sec" aria-label="Episodes" ref={list}>
      <h2 className="mv-h2">Episodes</h2>
      {seasons.map((s) => (
        <div key={s.season} className="mv-season">
          <div className="mv-season-head">
            <h3 className="mv-season-h">{s.season === 0 ? 'Specials' : `Season ${s.season}`}</h3>
            {s.season > 0 && <TrailerButton target={trailerTarget(detail, s.season)} onWatch={onTrailer} />}
          </div>
          <ol className="mv-eps">
            {s.episodes.map((e) => (
              <EpisodeItem
                key={e.episode}
                detail={detail}
                episode={e}
                focused={focus !== null && e.movie_id === focus}
                player={player}
                busy={busy}
                side={side}
                streamEnabled={streamEnabled}
                onPlay={onPlay}
                onStream={onStream}
                onWatched={onWatched}
              />
            ))}
          </ol>
        </div>
      ))}
      {hidden > 0 && <p className="mv-dim">{hidden === 1 ? '1 more season has' : `${hidden} more seasons have`} no file on any machine.</p>}
      {detail.unplaced_files.length > 0 && (
        <div className="mv-season">
          <h3 className="mv-season-h">Other files</h3>
          <ul className="mv-files">
            {detail.unplaced_files.map((f) => (
              <FileRow key={f.id} file={f} player={player} busy={busy} onPlay={onPlay} onWatched={onWatched} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

interface EpisodeItemProps {
  detail: TitleDetail;
  episode: EpisodeView;
  focused: boolean;
  player: PlayerState | null;
  busy: boolean;
  side: MoviesSide;
  streamEnabled: boolean;
  onPlay: (f: FileView) => void;
  onStream: (t: StreamTarget) => void;
  onWatched: (f: FileView) => void;
}

function EpisodeItem({ detail, episode: e, focused, player, busy, side, streamEnabled, onPlay, onStream, onWatched }: EpisodeItemProps) {
  const code = episodeCode(e.season, e.episode);
  const file = primaryFile(e);
  const act = episodeAction(detail, e, side);
  const play: PlayButtonState =
    act.kind === 'stream' ? streamLabel(act.target, streamEnabled) : file !== null ? filePlayLabel(file, player, code) : { label: `${code} has no file`, disabled: true };
  /** The stream behind a file here (R5.5: the file stays the default). */
  const alt = act.kind === 'vlc' ? act.stream : null;
  const source = act.kind === 'stream' ? act.target.source : alt !== null ? alt.source : null;
  const cls = `${!e.has_file && side === 'library' ? 'mv-row none' : e.deleted ? 'mv-row del' : 'mv-row'}${focused ? ' focus' : ''}`;
  return (
    <li
      className={cls}
      data-episode={code}
      data-movie-id={e.movie_id ?? undefined}
      data-focused={focused ? 'true' : undefined}
      data-testid="movie-file"
      data-file-id={file?.id}
      data-deleted={String(e.has_file && e.deleted)}
      data-state={e.state}
    >
      <span className="mv-code">{code}</span>
      <span className="mv-row-t">
        <span className="mv-row-name">{e.name ?? code}</span>
        {e.movie_id !== null && (
          <span className="mv-code mv-row-id" data-testid="episode-id">
            {e.movie_id}
          </span>
        )}
        {file !== null ? <FileFlags file={file} /> : side === 'library' && <span className="mv-flag">no file</span>}
        {source !== null && source.fresh && (
          <span className="mv-flag" data-tip={streamSourceText(source)}>
            verified
          </span>
        )}
      </span>
      <Meter state={e.state} progress={e.progress} />
      {file !== null ? <WatchedButton file={file} what={code} onWatched={onWatched} /> : <span />}
      <span className="mv-row-play">
        <PlayButton
          state={play}
          busy={busy}
          onClick={() => {
            if (act.kind === 'stream') onStream(act.target);
            else if (act.kind === 'vlc') onPlay(act.file);
          }}
        />
        {alt !== null && <StreamAltButton state={streamLabel(alt, streamEnabled)} busy={busy} onClick={() => onStream(alt)} />}
      </span>
    </li>
  );
}
```
**Impact:** on the Library side an episode without a fresh source renders as before, wrapped in `.mv-row-play`.

### Step 12: The page: switch, Stream grid, side-aware Back
**File:** `web/src/pages/MoviesPage.tsx` (whole file)
**Code:**
```tsx
import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowsClockwise, Books, Broadcast, FilmSlate, Question, Warning } from '@phosphor-icons/react';
import { MovieDetail } from '../components/movies/MovieDetail';
import { MoviesGrid } from '../components/movies/MoviesGrid';
import { MoviesPill } from '../components/movies/MoviesPill';
import { UnmatchedList } from '../components/movies/UnmatchedList';
import { useNotice } from '../hooks/useNotice';
import type { MoviesStore } from '../hooks/useMovies';
import { errorCode, startSync } from '../moviesApi';
import {
  detailIsFor,
  emptyLibraryText,
  entityHint,
  entityQuestion,
  entitySearchQuery,
  isMoviesOff,
  MOVIES_OFF_TEXT,
  moviesErrorText,
  moviesPillPlaceholder,
  NO_MOVIES_FILTER,
  normalizeMovieId,
  sideOf,
  stalledText,
  STREAM_OFF_TEXT,
  streamEmptyText,
  unmatchedCount,
  type MovieEntity,
  type MoviesFilter,
} from '../lib/movies';
import { NO_MOVIES_ROUTE, STREAM_ROUTE, type MoviesRoute } from '../lib/route';
import '../components/movies/Movies.css';

export interface MoviesPageProps {
  store: MoviesStore;
  route: MoviesRoute;
  /** Push another movies URL (grid, a title, the unmatched list, either side). */
  onRoute: (r: MoviesRoute) => void;
  onAsk: (text: string, imageIds: string[], entity?: MoviesEntityAsk) => void;
  /** An answer is still streaming in the wall's answer panel: entity links wait for it. */
  asking?: boolean;
}

/** What an entity link adds to its question: the person id for the agent, and what the Google icon under the answer searches. */
export interface MoviesEntityAsk {
  hint: string | null;
  search: string;
}

function MoviesEmpty({ text }: { text: string }) {
  return (
    <div className="mv-off mv-content">
      <FilmSlate weight="duotone" />
      <p>{text}</p>
    </div>
  );
}

/**
 * The movies view's main area:
 *   .mv-tools   toolbar, icon-only: the Library / Stream switch (left), then Back (on a title or the
 *               unmatched list), and on the Library side Unmatched files (with a count) and Rescan
 *   content     grid / detail / unmatched list, or an empty state (subsystem off, empty library or
 *               Stream side, direct streaming off, error)
 *   pill        "Ask about your movies"; "Ask about <title>" on a title's page
 * Each side keeps its own filter here, so it survives opening a title and coming back.
 * The Stream side has no entry in the rail or sidebar: it is this switch only (D3).
 */
export function MoviesPage({ store, route, onRoute, onAsk, asking = false }: MoviesPageProps) {
  const { notice, show } = useNotice(6000);
  const [filter, setFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [streamFilter, setStreamFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [busy, setBusy] = useState(false);
  const side = sideOf(route);
  const off = isMoviesOff(store);
  const stalled = off ? null : stalledText(store.player);
  const waiting = unmatchedCount(store.status);
  const unmatchedTip = waiting === null || waiting === 0 ? 'Unmatched files' : `Unmatched files (${waiting})`;
  const backLabel = side === 'stream' ? 'Back to Stream' : 'Back to the library';

  const rescan = async () => {
    setBusy(true);
    try {
      await startSync();
      show('rescan started');
    } catch (e) {
      show(`rescan refused: ${errorCode(e)}`);
    } finally {
      setBusy(false);
      store.refresh();
    }
  };

  let content: ReactNode;
  if (off) content = <MoviesEmpty text={MOVIES_OFF_TEXT} />;
  else if (route.unmatched)
    content = (
      <UnmatchedList
        files={store.unmatched}
        error={store.unmatchedError}
        onAssigned={(_id, name) => {
          show(`assigned to ${name}`);
          store.refresh();
        }}
      />
    );
  else if (route.title !== null) {
    if (store.detailError !== null) content = <MoviesEmpty text={moviesErrorText(store.detailError, route.title)} />;
    else if (!detailIsFor(store.detail, route.title)) content = <p className="mv-empty mv-content">loading</p>;
    else {
      const detail = store.detail;
      const askEntity = (e: MovieEntity) => onAsk(entityQuestion(e, detail), [], { hint: entityHint(e), search: entitySearchQuery(e, detail) });
      content = (
        <MovieDetail
          detail={detail}
          player={store.player}
          focus={normalizeMovieId(route.title)}
          side={side}
          streamEnabled={store.stream?.enabled ?? true}
          onChanged={store.refresh}
          onNotice={show}
          onEntity={askEntity}
          asking={asking}
        />
      );
    }
  } else if (side === 'stream') {
    const list = store.stream;
    if (store.streamError !== null) content = <MoviesEmpty text={moviesErrorText(store.streamError)} />;
    else if (list === null) content = <p className="mv-empty mv-content">loading the Stream titles</p>;
    else if (!list.enabled) content = <MoviesEmpty text={STREAM_OFF_TEXT} />;
    else if (list.titles.length === 0) content = <MoviesEmpty text={streamEmptyText(list.fresh_days)} />;
    else
      content = (
        <MoviesGrid side="stream" titles={list.titles} player={store.player} filter={streamFilter} onFilter={setStreamFilter} onOpen={(id) => onRoute({ title: id, unmatched: false, stream: true })} />
      );
  } else if (store.listError !== null) content = <MoviesEmpty text={moviesErrorText(store.listError)} />;
  else if (store.titles === null) content = <p className="mv-empty mv-content">loading the library</p>;
  else if (store.titles.length === 0) content = <MoviesEmpty text={emptyLibraryText(store.status)} />;
  else content = <MoviesGrid titles={store.titles} player={store.player} filter={filter} onFilter={setFilter} onOpen={(id) => onRoute({ title: id, unmatched: false })} />;

  return (
    <section className="mv" aria-label="Movies">
      <div className="mv-tools">
        <div className="mv-side" role="group" aria-label="Library or Stream">
          <button
            type="button"
            className={side === 'library' ? 'ibtn on' : 'ibtn hov'}
            data-tip="Library: the files on your machines"
            data-tip-side="below"
            aria-label="Library"
            aria-pressed={side === 'library'}
            disabled={off}
            onClick={() => onRoute(NO_MOVIES_ROUTE)}
          >
            <Books weight="duotone" />
          </button>
          <button
            type="button"
            className={side === 'stream' ? 'ibtn on' : 'ibtn hov'}
            data-tip="Stream: titles verified to play on this machine"
            data-tip-side="below"
            aria-label="Stream"
            aria-pressed={side === 'stream'}
            disabled={off}
            onClick={() => onRoute(STREAM_ROUTE)}
          >
            <Broadcast weight="duotone" />
          </button>
        </div>
        {notice && (
          <span className="mv-note" role="status">
            {notice}
          </span>
        )}
        {(route.title !== null || route.unmatched) && (
          <button type="button" className="ibtn hov" data-tip={backLabel} data-tip-side="below" aria-label={backLabel} onClick={() => onRoute(side === 'stream' ? STREAM_ROUTE : NO_MOVIES_ROUTE)}>
            <ArrowLeft weight="duotone" />
          </button>
        )}
        {side === 'library' && (
          <>
            <button
              type="button"
              className={route.unmatched ? 'ibtn on' : 'ibtn hov'}
              data-tip={unmatchedTip}
              data-tip-side="below"
              aria-label="Unmatched files"
              aria-pressed={route.unmatched}
              disabled={off}
              onClick={() => onRoute(route.unmatched ? NO_MOVIES_ROUTE : { title: null, unmatched: true })}
            >
              <Question weight="duotone" />
              {waiting !== null && waiting > 0 && <span className="mv-count">{waiting}</span>}
            </button>
            <button type="button" className="ibtn hov" data-tip="Rescan the library" data-tip-side="below" aria-label="Rescan the library" disabled={off || busy} onClick={() => void rescan()}>
              <ArrowsClockwise weight="duotone" />
            </button>
          </>
        )}
      </div>
      {stalled !== null && (
        <p className="mv-stalled mv-content" role="alert">
          <Warning weight="duotone" />
          <span>{stalled}</span>
        </p>
      )}
      {content}
      <MoviesPill onAsk={onAsk} placeholder={moviesPillPlaceholder(route, store.detail)} />
    </section>
  );
}
```
**Impact:** the rail (`toggleMovies` in `App.tsx:372-376`) still opens the Library grid; the switch is the only way to the Stream side. No change in `App.tsx`.

### Step 13: Styles
**File:** `web/src/components/movies/Movies.css:11` (after), `:109`, `:122` (after), `:162`
**Change:** after `:11` add:

```css
/* The Library / Stream switch: one segmented pill, pushed to the toolbar's left edge. */
.mv-side { display: inline-flex; align-items: center; gap: 2px; margin-right: auto; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); }
.mv-tools .mv-side .ibtn:not(:hover):not(.on) { background: transparent; }
.mv-stream-line { margin: 0; font-family: var(--mono); font-size: 11.5px; color: var(--soft); letter-spacing: .03em; }
```

Replace `:109` with:

```css
.mv-row { display: grid; grid-template-columns: 72px minmax(0, 1fr) 150px 32px minmax(32px, auto); gap: 14px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--line); }
```

After `:122` (the `.mv-flag` rules) add:

```css
.mv-row-play { display: inline-flex; justify-content: flex-end; gap: 2px; }
```

Replace `:162` (inside the 760px media query) with:

```css
  .mv-row { grid-template-columns: 60px minmax(0, 1fr) 32px minmax(32px, auto); }
```

### Step 14: Fixtures and tests
**File:** `web/src/testing/movieFixtures.ts:1` (import), `:67-95` (`detailOf`), end of file
**Change:** add `StreamListResponse`, `StreamSourceView` to the `../moviesApi` type import. In `detailOf`, after `plays: [],` add `stream_sources: [],`. Append:

```ts
/** One of this host's stream sources, fresh unless overridden. */
export function makeSource(season: number, episode: number, over: Partial<StreamSourceView> = {}): StreamSourceView {
  return {
    host: HOST,
    season,
    episode,
    provider: 'VidFast',
    manifest_kind: 'hls',
    best_height: 1080,
    en_subtitle: true,
    verified_at: ISO,
    stale_at: null,
    fresh: true,
    ...over,
  };
}

/** A film with no file anywhere: only its stream brings it to the page. */
export const FIGHT_CLUB_ITEM = makeItem('movie-550', 'Fight Club', {
  movie_id: 'M-FC55',
  year: 1999,
  poster_url: 'https://image.tmdb.org/t/p/w342/fc.jpg',
  present_here: false,
  file_count: 0,
});

export const FIGHT_CLUB: TitleDetail = detailOf(FIGHT_CLUB_ITEM, {
  poster_url: 'https://image.tmdb.org/t/p/w500/fc.jpg',
  overview: 'An insomniac office worker and a soap maker form an underground fight club.',
  runtime_min: 139,
  stream_sources: [makeSource(0, 0, { best_height: 2160 })],
});

/** How to Make a Killing with its file here and a fresh stream (R5.5: the file plays first). */
export const MOVIE_STREAMABLE: TitleDetail = { ...MOVIE, stream_sources: [makeSource(0, 0, { provider: 'VidLink', manifest_kind: 'dash' })] };

/** MobLand with S01E02 (whose file is here) verified to stream. */
export const SERIES_STREAMABLE: TitleDetail = { ...SERIES, stream_sources: [makeSource(1, 2)] };

export const STREAM_LIST: StreamListResponse = { enabled: true, titles: [FIGHT_CLUB_ITEM, KILLING_ITEM], fresh_days: 7 };
```

**File:** `web/src/lib/movies.test.tsx:156`
**Change:** the `MoviesView` literal gains the two new fields:

```ts
    const base: MoviesView = { titles: TITLES, listError: null, detail: null, detailError: null, unmatched: null, unmatchedError: null, status: STATUS, stream: null, streamError: null };
```

and append a new `describe` at the end of the file (add `titleAction`, `streamLine`, `streamLabel`, `streamTarget` to the import from `./movies`, and `FIGHT_CLUB`, `MOVIE_STREAMABLE`, `makeSource` to the fixtures import):

```ts
describe('stream decisions', () => {
  it('file first: a film with a file here plays it, and the fresh stream is the second icon (R5.5)', () => {
    const a = titleAction(MOVIE_STREAMABLE, 'stream');
    expect(a.kind).toBe('vlc');
    if (a.kind !== 'vlc') return;
    expect(a.plan).toEqual({ kind: 'file', file: MOVIE_STREAMABLE.files[0] });
    expect(a.stream?.ref).toEqual({ kind: 'movie', tmdb_id: 467905 });
    expect(titleAction(MOVIE, 'stream')).toMatchObject({ kind: 'vlc', stream: null });
  });

  it('no file here: Stream side streams; Library side streams only with a fresh source', () => {
    expect(titleAction(FIGHT_CLUB, 'stream')).toMatchObject({ kind: 'stream', target: { ref: { kind: 'movie', tmdb_id: 550 }, code: '' } });
    expect(titleAction(FIGHT_CLUB, 'library').kind).toBe('stream');
    const stale = { ...FIGHT_CLUB, stream_sources: [makeSource(0, 0, { fresh: false, stale_at: '2026-11-14T10:00:00.000Z' })] };
    expect(titleAction(stale, 'library')).toEqual({ kind: 'idle', plan: { kind: 'none' } });
    expect(titleAction(stale, 'stream').kind).toBe('stream');
  });

  it('names the provider, the quality and the English subtitle', () => {
    expect(streamLine(FIGHT_CLUB, 'stream')).toBe('Stream: VidFast · 2160p · English subtitle');
    expect(streamLine(MOVIE, 'library')).toBeNull();
    expect(streamLine(MOVIE, 'stream')).toBe('Stream: not verified yet; Play checks it');
    const target = streamTarget(FIGHT_CLUB);
    expect(target).not.toBeNull();
    if (target === null) return;
    expect(streamLabel(target, true)).toEqual({ label: 'Stream (VidFast · 2160p · English subtitle)', disabled: false });
    expect(streamLabel(target, false)).toEqual({ label: 'Direct streaming is off on this machine', disabled: true });
    expect(streamLine({ ...FIGHT_CLUB, stream_sources: [makeSource(0, 0, { en_subtitle: false, best_height: null })] }, 'stream')).toBe('Stream: VidFast · no English subtitle');
  });
});
```

**File:** `web/src/lib/route.test.tsx:150` (inside `describe('movies route')`, after the last `it`)
**Change:** add `STREAM_ROUTE` to the import, and:

```ts
  it('the Stream side is ?side=stream on the grid and on a title; the unmatched list ignores it', () => {
    expect(moviesRouteFromLocation(loc('/movies?side=stream'))).toEqual({ title: null, unmatched: false, stream: true });
    expect(moviesRouteFromLocation(loc('/movies/M-23T4?side=stream'))).toEqual({ title: 'M-23T4', unmatched: false, stream: true });
    expect(moviesRouteFromLocation(loc('/movies/unmatched?side=stream'))).toEqual({ title: null, unmatched: true });
    expect(moviesRouteFromLocation(loc('/movies?side=library'))).toEqual({ title: null, unmatched: false });
    expect(moviesHref(STREAM_ROUTE)).toBe('/movies?side=stream');
    expect(moviesHref({ title: 'M-23T4', unmatched: false, stream: true })).toBe('/movies/M-23T4?side=stream');
    expect(hrefForView('movies', null, loc('/movies'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, STREAM_ROUTE)).toBe('/movies?side=stream');
    expect(hrefForView('movies', null, loc('/movies?side=stream'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, STREAM_ROUTE)).toBeNull();
  });
```

**File:** `web/src/App.stream.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note } from './types';
import type { StreamListResponse } from './moviesApi';
import { makeNote } from './testing/fixtures';
import { FIGHT_CLUB, MOVIE_STREAMABLE, PLAYER_IDLE, SERIES_STREAMABLE, STATUS, STREAM_LIST, TITLES } from './testing/movieFixtures';
import { STREAM_OFF_TEXT } from './lib/movies';
import { App } from './App';

const notes: Note[] = [makeNote('A-B32', 'buy fennel #kitchen', { created: new Date().toISOString() })];

let calls: string[];
let posts: { url: string; body: Record<string, unknown> | null }[];
let streamList: StreamListResponse;
/** What phase 3's POST /api/stream/play answers. */
let playAnswer: { status: number; body: Record<string, unknown> };
/** Stands in for phase 5: a failed play marks the title's source stale, so the next list lacks it. */
let dropOnFailure: string | null;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  posts = [];
  streamList = STREAM_LIST;
  playAnswer = { status: 200, body: { ok: true } };
  dropOnFailure = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'POST') posts.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (method === 'POST' && url === '/api/stream/play') {
        if (playAnswer.status >= 400 && dropOnFailure !== null) {
          const gone = dropOnFailure;
          streamList = { ...streamList, titles: streamList.titles.filter((t) => t.id !== gone) };
        }
        return json(playAnswer.body, playAnswer.status);
      }
      if (url === '/api/movies') return json({ titles: TITLES });
      if (url === '/api/movies/stream') return json(streamList);
      if (url === '/api/movies/status') return json(STATUS);
      if (url === '/api/movies/player') return json(PLAYER_IDLE);
      if (url === '/api/movies/M-FC55' || url === '/api/movies/movie-550') return json(FIGHT_CLUB);
      if (url === '/api/movies/M-23T4' || url === '/api/movies/movie-467905') return json(MOVIE_STREAMABLE);
      if (url === '/api/movies/M-8TR4' || url === '/api/movies/tv-247718') return json(SERIES_STREAMABLE);
      if (method === 'POST' && url.startsWith('/api/movies/')) return json({}, 202);
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: () => ({}) as Animation });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  window.history.replaceState(null, '', '/');
});

const h1 = () => screen.queryByRole('heading', { level: 1 })?.textContent ?? null;
const at = (url: string) => window.history.replaceState(null, '', url);
const where = () => window.location.pathname + window.location.search;
const rail = () => document.querySelector('.rail') as HTMLElement;
const switcher = () => screen.getByRole('group', { name: 'Library or Stream' });
const tileIds = () =>
  within(screen.getByRole('list', { name: 'Posters' }))
    .getAllByRole('listitem')
    .map((t) => t.querySelector('a')?.getAttribute('data-title'));
const streamPlays = () => posts.filter((p) => p.url === '/api/stream/play').map((p) => p.body);
const vlcPlays = () => posts.filter((p) => /^\/api\/movies\/(files\/\d+\/play|continue)$/.test(p.url));
const count = (call: string) => calls.filter((c) => c === call).length;

describe('App: the Stream side of /movies', () => {
  it('R5.1: the Stream switch at the top shows the Stream grid in the same page; the rail gains nothing', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    const railBefore = within(rail()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(count('GET /api/movies/stream')).toBe(0);
    expect(within(switcher()).getByRole('button', { name: 'Library' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(switcher()).getByRole('button', { name: 'Stream' }));
    await waitFor(() => expect(where()).toBe('/movies?side=stream'));
    expect(h1()).toBe('Stream.');
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4', 'M-FC55']));
    expect(within(switcher()).getByRole('button', { name: 'Stream' }).getAttribute('aria-pressed')).toBe('true');
    // A title with no file is not "gone" on this side, and there is no gone pill.
    expect(document.querySelector('.mv-tile.gone')).toBeNull();
    expect(screen.queryByRole('button', { name: /^gone/ })).toBeNull();
    await screen.findByText(/2 titles verified to stream on this machine in the last 7 days\./);
    expect(within(rail()).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(railBefore);
    expect(within(rail()).queryByRole('button', { name: /stream/i })).toBeNull();
    fireEvent.click(within(switcher()).getByRole('button', { name: 'Library' }));
    await waitFor(() => expect(where()).toBe('/movies'));
    expect(h1()).toBe('Movies.');
  });

  it('R5.2: the Stream grid shows exactly the verified list; empty and off say why', async () => {
    at('/movies?side=stream');
    const first = render(<App />);
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4', 'M-FC55']));
    // Library titles without a verified stream (MobLand, The Dog Stars) are not on this side.
    expect(tileIds()).not.toContain('M-8TR4');
    expect(tileIds()).not.toContain('movie-9001');
    first.unmount();

    streamList = { enabled: true, titles: [], fresh_days: 7 };
    const second = render(<App />);
    await waitFor(() => expect(document.querySelector('.mv-off')?.textContent).toContain('/direct-stream <title>'));
    expect(document.querySelector('.mv-off')?.textContent).toContain('in the last 7 days');
    second.unmount();

    streamList = { enabled: false, reason: 'direct_stream_off', titles: [] };
    render(<App />);
    await screen.findByText(STREAM_OFF_TEXT);
  });

  it('R5.3: Play on a title opened from the Stream grid asks the daemon to stream it, once, with no other click', async () => {
    at('/movies?side=stream');
    render(<App />);
    await waitFor(() => expect(tileIds()).toContain('M-FC55'));
    fireEvent.click(screen.getByRole('link', { name: /Fight Club/ }));
    await waitFor(() => expect(where()).toBe('/movies/M-FC55?side=stream'));
    const article = within(await screen.findByRole('article', { name: 'Fight Club' }));
    expect(article.getByTestId('stream-source').textContent).toBe('Stream: VidFast · 2160p · English subtitle');
    fireEvent.click(article.getByRole('button', { name: 'Stream (VidFast · 2160p · English subtitle)' }));
    await screen.findByText('opening in the streaming Chrome');
    expect(streamPlays()).toEqual([{ kind: 'movie', tmdb_id: 550 }]);
    expect(vlcPlays()).toEqual([]);
  });

  it('R5.4: a play that finds no source says so, and the title leaves the Stream grid', async () => {
    playAnswer = { status: 502, body: { error: 'no_source', attempts: [{ provider: 'VidFast', outcome: 'no_stream', took_s: 9, detail: '' }] } };
    dropOnFailure = 'movie-550';
    at('/movies/M-FC55?side=stream');
    render(<App />);
    const article = within(await screen.findByRole('article', { name: 'Fight Club' }));
    await waitFor(() => expect(count('GET /api/movies/stream')).toBeGreaterThan(0));
    const before = count('GET /api/movies/stream');
    fireEvent.click(article.getByRole('button', { name: 'Stream (VidFast · 2160p · English subtitle)' }));
    await screen.findByText('no provider could stream Fight Club now; it leaves the Stream grid');
    await waitFor(() => expect(count('GET /api/movies/stream')).toBeGreaterThan(before));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Stream' }));
    await waitFor(() => expect(where()).toBe('/movies?side=stream'));
    await waitFor(() => expect(tileIds()).toEqual(['M-23T4']));
  });

  it('direct streaming off: Play on a Stream title is disabled and says so', async () => {
    streamList = { enabled: false, reason: 'direct_stream_off', titles: [] };
    at('/movies/M-FC55?side=stream');
    render(<App />);
    const article = within(await screen.findByRole('article', { name: 'Fight Club' }));
    await waitFor(() => expect((article.getByRole('button', { name: 'Direct streaming is off on this machine' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('R5.5: a title with a file here and a verified stream plays the file; the stream is the second icon', async () => {
    for (const url of ['/movies/M-23T4?side=stream', '/movies/M-23T4']) {
      posts = [];
      at(url);
      const view = render(<App />);
      const article = within(await screen.findByRole('article', { name: 'How to Make a Killing' }));
      fireEvent.click(article.getByRole('button', { name: 'Resume at 45:00' }));
      await waitFor(() => expect(posts.filter((p) => p.url === '/api/movies/files/11/play')).toHaveLength(1));
      expect(streamPlays()).toEqual([]);
      fireEvent.click(article.getByRole('button', { name: 'Stream (VidLink · 1080p · English subtitle)' }));
      await waitFor(() => expect(streamPlays()).toEqual([{ kind: 'movie', tmdb_id: 467905 }]));
      view.unmount();
    }
  });

  it('a series from the Stream side lists every season; an episode streams when clicked; a file here still plays in VLC', async () => {
    at('/movies/M-8TR4?side=stream');
    render(<App />);
    const eps = within(await screen.findByRole('region', { name: 'Episodes' }));
    expect(eps.getByText('Season 2')).toBeTruthy();
    const s02e01 = within(document.querySelector('[data-episode="S02E01"]') as HTMLElement);
    fireEvent.click(s02e01.getByRole('button', { name: 'Stream S02E01: checked when it starts' }));
    await waitFor(() => expect(streamPlays()).toEqual([{ kind: 'tv', tmdb_id: 247718, season: 2, episode: 1 }]));
    const s01e02 = within(document.querySelector('[data-episode="S01E02"]') as HTMLElement);
    expect(s01e02.getByRole('button', { name: 'Resume S01E02 at 20:00' })).toBeTruthy();
    expect(s01e02.getByRole('button', { name: 'Stream S01E02 (VidFast · 1080p · English subtitle)' })).toBeTruthy();
  });
});
```
**Impact:** the existing `web/src/App.movies.test.tsx` keeps passing: the Library side issues no Stream request, its toolbar still has `Unmatched files`, `Rescan the library` and `Back to the library`, and every Library label is unchanged.

### Step 15: Guide, picture script, feature map
**File:** `docs/guide/movies.md:3-7`, `:272-275`, `:362-367` (after), `:789-801`, `:863`, `:892-899`
**Change:**

1. Intro (`:3-7`): after "...follows the position while they play." insert the sentence: ``A second side of the same page, Stream, lists the titles a provider was verified to stream on this machine and plays them in the streaming Chrome (see [The Stream side](#the-stream-side)).``

2. `:274-275` becomes:

```markdown
The film-slate icon in the rail or sidebar opens `/movies`. Two icons at the top left switch the
page between its two sides: Library, the files on your machines (this section), and Stream, the
titles verified to stream on this machine ([The Stream side](#the-stream-side)). Stream has no
entry of its own in the rail or sidebar. The header counts titles, films, series and what is in
progress.
```

3. Replace the **Toolbar.** paragraph (`:362-363`) with:

```markdown
**Toolbar.** The Library / Stream switch, Back to the library (Back to Stream on a title opened
from Stream), and on the Library side the unmatched list with a count of this machine's unmatched
and pending files (`/movies/unmatched`) and Rescan the library, which starts a pass at once.
```

4. After the **Live updates.** paragraph (`:365-367`), before `## Playback`, add:

```markdown
### The Stream side

The Stream icon at the top of `/movies` opens `/movies?side=stream`: the same poster grid and
filters, filled from `GET /api/movies/stream` instead of the library. A title is on it only when a
provider returned a playable stream for it on this machine within the freshness window
(`NOTESD_STREAM_FRESH_DAYS`, 7 days by default) and its last try did not fail. Nothing else is
shown there, so every poster plays. A title with no file is not dimmed on this side, and there is
no `gone` pill. The header says how many titles are verified and over how many days.

Titles get onto it by being streamed: `/direct-stream <title>` from Claude Code (see
[streaming.md](streaming.md)), a play from this page, or the background prober when
`NOTESD_STREAM_PROBER=on`. An empty Stream side says so, and with direct streaming off it says how
to turn it on.

A poster opens the title's page at `/movies/<id>?side=stream`, the same page as from the library
(poster, facts, people, trailer, review), with one more line under the facts naming the stream
source: provider, best quality and whether it has an English subtitle (`Stream: VidFast · 2160p ·
English subtitle`).

- **Play** asks the daemon to resolve the title and open the player full screen in the streaming
  Chrome, with no further click; the page says "opening in the streaming Chrome". When no provider
  answers, the source is marked stale, the page says "no provider could stream <title> now; it
  leaves the Stream grid", and the title is gone from the grid on the refresh that follows.
- **A file on this machine wins.** When a title has both a file here and a verified stream, Play
  is still the VLC Play or Resume, and a second icon beside it streams instead. The same rule
  holds on each episode row, and on the Library side a title with no file here but a verified
  stream gets a stream Play too.
- **Series** list every season on this side, not only the seasons with a file. Every episode has
  a play icon; an episode without a verified stream is checked when you click it ("checked when
  it starts"), and one with a verified stream carries a `verified` flag naming its source.
- **The other machine** verifies its own titles. A title verified only on the other laptop is not
  on this machine's Stream side, and its source is not offered here.
```

If Step 16 produced the picture, add after the first paragraph of this subsection:

```markdown
![The Stream side: only titles verified to stream on this machine](img/movies/stream.png)
```

5. In the "Off switches and failure answers" table (`:791-801`), add two rows after the `NOTESD_MOVIES=off` row:

```markdown
| `NOTESD_DIRECT_STREAM=off` | `GET /api/movies/stream` answers `{enabled: false, reason: "direct_stream_off", titles: []}`; the Stream side says how to turn it on and its stream buttons are disabled; `POST /api/stream/play` answers 503 `direct_stream_off`. |
| No provider streams a title when Play is pressed | `POST /api/stream/play` answers 502 `no_source` with each provider's outcome; the source is marked stale and the title leaves the Stream grid. |
```

6. "Where the code is" (`:863`): change the routes row's text to `Routes: library, the Stream list, unmatched, assign, user marks, sync, events; play, continue, player, health`.

7. "Proving a change", in the `--live` bullet (`:893-897`), after "...(kept as it is when VLC has nothing open)." add: `It also takes `stream.png`, the Stream side, when this machine has at least one verified title; it presses no Play there either.` And in the unit-tests bullet (`:889`) add `web/src/App.stream.test.tsx`; in the integration bullet (`:890-891`) add `stream` to the list.

**File:** `scripts/docs/shots/movies.mjs:7-12` (header comment), after `:213` (`await shot('grid');`)
**Change:** in the header comment, after "...the page of whatever VLC is playing from the daemon on 7317." add the line `//   ...and the Stream side (stream.png) when this machine has a verified title; no Play is pressed there.` After `await shot('grid');` insert:

```js
  // The Stream side: only titles verified to stream on this machine. It looks only: no Play, so no
  // Chrome opens and no source is re-checked. Kept as it is when the daemon has no Stream side yet
  // (404), direct streaming is off, or nothing is verified.
  const stream = await fetchJson('GET', '/api/movies/stream').catch(() => null);
  if (stream?.enabled === true && stream.titles.length > 0) {
    await page.goto(`${base}/movies?side=stream`);
    await page.getByRole('list', { name: 'Posters' }).waitFor();
    await postersLoaded(page);
    await page.mouse.move(640, 60);
    await shot('stream');
  } else {
    const why = stream === null ? 'this daemon has no Stream side' : stream.enabled ? 'nothing is verified to stream' : 'direct streaming is off';
    console.log(`movies: ${why}, stream.png is kept as it is`);
  }
```

**File:** `.claude/skills/verify-notesd/features/movies.md:2` (after `## Sub-features`), `:83-91` ("How to get to it")
**Change:** add as the first sub-feature bullet:

```markdown
- Stream side (direct-streaming phase 9). Two icons at the top of `/movies` (group "Library or
  Stream") switch to `/movies?side=stream`: the same grid, fed by `GET /api/movies/stream`, which
  lists only titles with a `movie_stream_sources` row for this host, not stale, verified inside
  `NOTESD_STREAM_FRESH_DAYS`. No rail or sidebar entry. A title opened from it
  (`/movies/<id>?side=stream`) shows a stream line (provider, quality, English subtitle); its Play
  posts `POST /api/stream/play` once; `no_source` says so and the title leaves the grid on the
  refresh. A file here stays the default Play, the stream a second icon (R5.5). Series list every
  season, each episode streams when clicked. Proof: `web/src/App.stream.test.tsx`,
  `tests/integration/movies.stream.int.test.ts`; on a `verify.sh up --web --direct-stream` run
  (direct streaming on, phase 3's fake resolver), seed `movie_stream_sources` with `$V exec` (the
  daemon writes it only after a resolve) and stub `POST /api/stream/play` with Playwright
  `page.route` to choose its answer. Never give a throwaway run the real resolver.
```

and in "How to get to it", after the first sentence, add: ``The Library / Stream icons at the top of the page switch to `/movies?side=stream`, the titles verified to stream on this machine.``

**File:** `.claude/skills/verify-notesd/features/README.md:19`
**Change:** in the movies row's first cell, after `unmatched list,` add ` the Stream side (titles verified to stream here),`.

**Impact:** `npm run docs:check` passes: no picture is referenced that does not exist (Step 16 decides).

### Step 16: The live picture (only when it can be taken now)
**File:** `docs/guide/img/movies/stream.png`
**Change:** check whether the live daemon serves this branch and has a verified title:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7317/api/movies/stream
curl -s http://127.0.0.1:7317/api/movies/stream | jq '{enabled, n: (.titles | length)}'
```

- `200` with `enabled: true` and `n >= 1`: run `npm run docs:shots -- --live movies` (read-only; no `DOCS_SHOTS_PLAY`, no `DOCS_SHOTS_CHAT`), keep the retaken real-library pictures, and add the picture line from Step 15.4.
- Anything else (the live daemon still serves `main`, or nothing is verified): do not add the picture line and do not add a fixture picture (invariant 9). Leave it in **Handoffs** for the step that restarts the daemon on the merged branch.

**Impact:** the guide references `stream.png` only when the file exists, so `docs:check` passes either way.

## Principles applied

- Laziness protocol: the Stream side reuses `MoviesGrid`, `PosterTile`, `MovieDetail` and `EpisodeList` with a `side` prop and default parameters, instead of a second grid or title page; `App.tsx` and the rail are untouched because the route type carries the side. The scope asked for an ETag "like the library list", but `GET /api/movies` has none (`src/http/moviesApi.ts:171-214`); the Stream list is plain JSON like it, and the ETag goes to Handoffs.
- Make illegal states unrepresentable: `StreamListResponse` is a union (`fresh_days` exists only when enabled); `StreamRef` makes a series always name its episode; `TitleAction` / `EpisodeAction` are unions, so a stream Play never carries a VLC file and file-first (R5.5) is decided once, in `titleAction` / `episodeAction`, not in the JSX.
- Boundary discipline: freshness and "this host only" are applied once on the server (`withStreamFreshness` in the route layer, `listStreamTitles` in SQL), so the page reads one boolean, `fresh`; the client normalizes the list once in `fetchStreamTitles` and `stream_sources` once in `normalizeDetail`.
- Test behavior, not implementation: the web tests render `App` and assert URLs, posters, labels and request bodies; the integration test drives the real route against Postgres, seeding rows only through SQL and `MoviesRepo`.
- Prove it works: the Proof drives a real throwaway daemon (`verify.sh up --web --direct-stream`, direct streaming on against phase 3's fake resolver) with seeded source rows through the browser, stubbing `POST /api/stream/play` in the browser so J3/J4 control its answer.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (includes `web/src/App.stream.test.tsx`, `web/src/lib/{movies,route}.test.tsx`, and `tests/unit/docs/reference.test.ts`), `npm run docs:check`, `npm run test:int -- tests/integration/movies.stream.int.test.ts tests/integration/movies.api.int.test.ts`
**Proof:** a throwaway daemon built from this branch (`--direct-stream`: direct streaming on, phase 3's fake resolver, so `GET /api/movies/stream` answers `enabled: true`), its library synced, `movie_stream_sources` seeded for this host (fresh, stale, too old) and for another host, then driven through the wall with Playwright. `POST /api/stream/play` is stubbed in the browser (`page.route`) so J3/J4 decide its answer; the daemon's real play is phase 3's journey.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web --direct-stream`, `api`, `exec`, `sql`, `ui`, `vlc`)
- Feature-map entries: `features/movies.md` (Stream side; neighbor: the library journey)
- Setup (shared by J1-J5; run from the worktree; scratch files go in the session scratchpad, written below as `$S`):
  ```sh
  V=.claude/skills/verify-notesd/scripts/verify.sh
  $V up --web --direct-stream               # note RUN=... and URL=... (--direct-stream implies --movies; fake resolver)
  for i in $(seq 12); do $V api $RUN POST '/api/movies/sync?wait=true' >/dev/null; [ "$(curl -s "$URL/api/movies/status" | jq .counts.files_here)" -ge 6 ] && break; sleep 10; done
  curl -s "$URL/api/movies/stream" | jq .enabled    # must print true (a run without --direct-stream pins direct streaming off)
  HOST=$(curl -s "$URL/api/movies/status" | jq -r .host)
  $V exec $RUN "insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, poster_path, backdrop_path, runtime_min, genres, season_count, episode_count, metadata_fetched_at, created_at, updated_at) values ('movie-990550','movie',990550,'Verify Stream Only','Verify Stream Only',1999,'1999-10-15'::date,'A title with no file, verified to stream.',null,null,139,'[\"Drama\"]'::jsonb,null,null,now(),now(),now())"
  $V exec $RUN "insert into movie_stream_sources (title_id, season, episode, host, provider, manifest_kind, best_height, en_subtitle, verified_at, stale_at, failure) values
    ('movie-990550',0,0,'$HOST','VidFast','hls',2160,true,now()-interval '1 day',null,null),
    ('movie-467905',0,0,'$HOST','VidLink','dash',1080,true,now()-interval '2 days',null,null),
    ('movie-990001',0,0,'$HOST','VidNest','hls',720,false,now()-interval '10 days',null,null),
    ('movie-990004',0,0,'$HOST','VidFast','hls',1080,true,now()-interval '1 day',now(),'no_source'),
    ('tv-247718',1,2,'verify-other-host','VidFast','hls',1080,true,now()-interval '1 day',null,null)"
  ```
  `$S/j1.mjs`:
  ```js
  export default async ({ page, base, shot, log }) => {
    await page.goto(base + '/movies');
    await page.getByRole('list', { name: 'Posters' }).waitFor();
    const rail = async () => page.locator('.rail button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') ?? b.textContent));
    const before = await rail();
    await page.getByRole('group', { name: 'Library or Stream' }).getByRole('button', { name: 'Stream' }).click();
    await page.waitForURL(/\/movies\?side=stream$/);
    await page.getByRole('heading', { level: 1, name: 'Stream.' }).waitFor();
    await page.getByRole('list', { name: 'Posters' }).waitFor();
    const after = await rail();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`rail changed: ${before} -> ${after}`);
    if (after.some((l) => /stream/i.test(l ?? ''))) throw new Error('the rail has a Stream entry');
    const tiles = await page.locator('.mv-grid a.mv-tile .mv-cap-t').allTextContents();
    await shot('stream-grid');
    log(`Stream grid at /movies?side=stream with ${JSON.stringify(tiles)}; rail unchanged`);
  };
  ```
  `$S/j3.mjs` (R5.3; stub answers 200 and records the body):
  ```js
  export default async ({ page, base, shot, log }) => {
    const bodies = [];
    await page.route('**/api/stream/play', async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(base + '/movies?side=stream');
    await page.getByRole('link', { name: /Verify Stream Only/ }).click();
    await page.waitForURL(/\/movies\/M-[0-9A-Z]{4}\?side=stream$/);
    const article = page.getByRole('article', { name: 'Verify Stream Only' });
    await article.getByTestId('stream-source').filter({ hasText: 'Stream: VidFast · 2160p · English subtitle' }).waitFor();
    await article.getByRole('button', { name: 'Stream (VidFast · 2160p · English subtitle)' }).click();
    await page.getByText('opening in the streaming Chrome').waitFor();
    if (JSON.stringify(bodies) !== JSON.stringify([{ kind: 'movie', tmdb_id: 990550 }])) throw new Error(`play bodies: ${JSON.stringify(bodies)}`);
    await shot('stream-play');
    log(`one POST /api/stream/play ${JSON.stringify(bodies[0])}, notice shown, no other click`);
  };
  ```
  `$S/j4.mjs` (R5.4; the stub does what phase 5 does on a failed resolve, then answers 502):
  ```js
  import { execFileSync } from 'node:child_process';
  export default async ({ page, base, shot, log }) => {
    await page.route('**/api/stream/play', async (route) => {
      execFileSync('.claude/skills/verify-notesd/scripts/verify.sh', ['exec', process.env.STREAM_RUN, "update movie_stream_sources set stale_at = now(), failure = 'no_source' where title_id = 'movie-990550'"]);
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'no_source', attempts: [{ provider: 'VidFast', outcome: 'no_stream', took_s: 9, detail: '' }] }) });
    });
    await page.goto(base + '/movies?side=stream');
    await page.getByRole('link', { name: /Verify Stream Only/ }).click();
    const article = page.getByRole('article', { name: 'Verify Stream Only' });
    await article.getByRole('button', { name: /^Stream \(VidFast/ }).click();
    await page.getByText('no provider could stream Verify Stream Only now; it leaves the Stream grid').waitFor();
    await page.getByRole('button', { name: 'Back to Stream' }).click();
    await page.waitForURL(/\/movies\?side=stream$/);
    await page.getByRole('list', { name: 'Posters' }).waitFor();
    if ((await page.getByRole('link', { name: /Verify Stream Only/ }).count()) !== 0) throw new Error('the failed title is still on the Stream grid');
    await shot('stream-after-failure');
    log('no_source notice shown; the title left the Stream grid after the refresh');
  };
  ```
  `$S/j5.mjs` (R5.5):
  ```js
  export default async ({ page, base, shot, log }) => {
    let streamed = 0;
    await page.route('**/api/stream/play', async (route) => {
      streamed += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    await page.goto(base + '/movies?side=stream');
    await page.getByRole('link', { name: /How to Make a Killing/ }).click();
    const article = page.getByRole('article', { name: 'How to Make a Killing' });
    await article.getByRole('button', { name: 'Stream (VidLink · 1080p · English subtitle)' }).waitFor();
    const play = article.locator('button.mv-play');
    const label = await play.getAttribute('aria-label');
    if (!/^(Play|Resume at )/.test(label ?? '')) throw new Error(`big Play is not the file: ${label}`);
    await play.click();
    await page.getByText(/^(playing in VLC|resuming at )/).first().waitFor({ timeout: 20000 });
    if (streamed !== 0) throw new Error('Play streamed instead of playing the file');
    await shot('file-first');
    log(`big Play "${label}" played the file in VLC; the stream is the second icon`);
  };
  ```
- Journeys:
  - **J1** · traces R5.1 — Setup, then `$V ui $RUN $S/j1.mjs`, then `git diff --stat $(git merge-base HEAD origin/main) -- web/src/components/Rail.tsx web/src/components/Sidebar.tsx` → passes when the ui run ends with no error and its log line says `Stream grid at /movies?side=stream`, the screenshot `NN-ui-stream-grid.png` shows the Stream grid with the Library / Stream icons at the top, and the `git diff --stat` prints nothing
  - **J2** · traces R5.2 — Setup, then `curl -s "$URL/api/movies/stream" | jq -c '[.enabled, .fresh_days, ([.titles[].id] | sort)]'` and the tile list logged by J1 → passes when it prints `[true,7,["movie-467905","movie-990550"]]` (the stale `movie-990004`, the 10-day-old `movie-990001` and the other host's `tv-247718` are absent) and J1's log lists exactly `How to Make a Killing` and `Verify Stream Only`
  - **J3** · traces R5.3 — Setup, then `$V ui $RUN $S/j3.mjs` → passes when the run ends with no error and logs `one POST /api/stream/play {"kind":"movie","tmdb_id":990550}`: one request from one click, and the page shows "opening in the streaming Chrome" (the full-screen open behind that request is phase 3's `play`, proven in its plan)
  - **J4** · traces R5.4 — Setup, then `STREAM_RUN=$RUN $V ui $RUN $S/j4.mjs`, then `curl -s "$URL/api/movies/stream" | jq -c '[.titles[].id] | sort'` → passes when the run ends with no error (the notice appeared and, after Back to Stream, no `Verify Stream Only` poster is on the grid) and the curl prints `["movie-467905"]`
  - **J5** · traces R5.5 — Setup, then `$V ui $RUN $S/j5.mjs`, then `$V vlc $RUN args` → passes when the run ends with no error (the big Play's label starts with `Play` or `Resume at`, the page reports VLC, and the stubbed stream route was never called) and `vlc args` shows the fake `vlc.exe` started on the `How.to.Make.a.Killing` file
  - **J6** · traces R5.1, R5.2, R5.3, R5.4, R5.5 — `npx vitest run web/src/App.stream.test.tsx web/src/lib/movies.test.tsx web/src/lib/route.test.tsx` and `npm run test:int -- tests/integration/movies.stream.int.test.ts` → passes when every test passes, including "R5.1: the Stream switch...", "R5.2: the Stream grid shows exactly the verified list...", "R5.3: Play on a title opened from the Stream grid...", "R5.4: a play that finds no source...", "R5.5: a title with a file here..." and the integration test "lists only titles with a source verified on this host inside the window and not stale"
- Neighbor check: the Library side of the same page. On a separate run, `$V up --web --movies` then `.claude/skills/verify-notesd/scripts/movies/journey.sh $RUN` → ends with `journey: PASS (12 stages)`; and `npx vitest run web/src/App.movies.test.tsx web/src/hooks/useMovies.test.tsx` → all pass. Then `$V down $RUN` for both runs.
- Cost: none. No model call; no real Chrome (the stream route is stubbed in the browser); the fake TMDB and fake VLC only.

**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the two integration files pass; J1-J6 pass on a throwaway daemon; `/movies` has a Library / Stream switch whose Stream side lists only this host's fresh verified titles, streams on Play with one request, drops a title that failed, and keeps a local file as the default Play.

## Handoffs

- **Phase 5 (settled by the reconciler):** `listStreamTitles(db, filter, ctx, freshSince)`, `streamFreshSince`, `isFreshStreamSource` and `TitleDetail.stream_sources` (this host's verified rows, phase 5's Step 6b) are phase 5's, as in **Requires**; phase 5 marks the row stale before `POST /api/stream/play` answers `no_source` (the store half of R5.4). `truncateMovies` reaches `movie_stream_sources` through `cascade` (its foreign key to `movie_titles`). The `GET /api/movies/:id` sentence about `stream_sources` in `httpRoutes.ts` is phase 5's; this phase describes `fresh` in its own route's entry.
- **Phase 3 (settled by the reconciler):** `verify.sh up --direct-stream` turns direct streaming on with a fake resolver, so `GET /api/movies/stream` answers `enabled: true`; a later verifier may drive J3/J4 through the real `POST /api/stream/play` on that run (the fake's `mode` file picks `no_source`) instead of the Playwright stub.
- **Phase 7 (chat prompt):** the pill now sends `[Movies · stream]` from the Stream grid; `src/chat/prompt.ts` may want one line saying that means the Stream side (titles verified to stream here, `direct_stream_*` tools).
- **The landing step (completion / "p" rebuild):** after the daemon on 7317 serves the merged branch and at least one title is verified (one `/direct-stream` play is enough), run `npm run docs:shots -- --live movies` and add `![The Stream side: only titles verified to stream on this machine](img/movies/stream.png)` under "### The Stream side" in `docs/guide/movies.md`, unless Step 16 already did. Never a fixture picture (invariant 9).
- **Not built (out of R5's words):** an ETag on `GET /api/movies` and `GET /api/movies/stream` (the scope assumed the library list has one; it does not). Streaming from the chat's movie pop-up (`MovieModal.tsx`). Remembering the last side when the rail icon reopens `/movies` (it opens the Library, as today).

## Rollback

Revert this phase's commits. The route, the switch and the `side` parameters are additive: the
Library side, `/movies/<id>` and `/movies/unmatched` behave as before, and no table, migration or
setting belongs to this phase. Run `npm run docs:gen` after the revert so
`docs/guide/reference/http-api.md` drops the route.
