> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/movies-library/PLAN.md` phase 6. Source: `.workflows/plan/movies-library/phase-6.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 6: Web: Movies page, grid, detail, unmatched, pill

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R5 — the wall's `/movies` page: poster grid, detail page, unmatched list with a manual fix, and the pill
**Criteria:** R5.1, R5.2, R5.3, R5.4, R5.5
**Depends on:** Phase 4, Phase 5
**Difficulty:** HARD
**Package:** `web/src`

---

## Goal

The wall gets a Movies view. A FilmSlate icon in the rail and the sidebar opens `/movies`, a poster grid of the library
with a filter row (state, kind, text). Deleted-only titles are dimmed, not hidden. A poster opens `/movies/<title id>`:
release date, synopsis, studios, directors, writers, producers, cast with character names, a big Play/Resume button,
the watched flag, 0-5 stars, a review field saved on blur, and per-file or per-episode progress with deleted and
"on another machine" flags. `/movies/unmatched` lists the files that matched no title, each with its reason, and an
assign dialog that searches TMDB. The page carries its own pill. The pill asks the wall chat, with the page (and the open
title) named on the message's first line, and the answer panel stays visible over the page. The page has two empty
states: a 503 `movies_off`, and an empty library.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `web/src/types.ts`: `View` gains `'movies'`.
- `web/src/lib/route.ts`: `MOVIES_PATH = '/movies'`, `MOVIES_UNMATCHED_SEGMENT = 'unmatched'`,
  `MoviesRoute { title: string | null; unmatched: boolean }`, `NO_MOVIES_ROUTE`, `moviesRouteFromLocation(loc)`,
  `moviesHref(r)`, a `'movies'` branch in `hrefForView`.
- `web/src/moviesApi.ts`: the wire mirrors (below), `MOVIES_EVENTS_URL`, `errorCode`, and the fetchers `fetchMovies`,
  `fetchMovie`, `fetchUnmatched`, `fetchStatus`, `fetchPlayer`, `searchTmdb`, `saveTitleUser`, `setFileWatched`,
  `assignFile`, `startSync`, `playFile`, `continueTitle`.
- `web/src/hooks/useMovies.ts`: `useMovies(enabled, route): MoviesStore`, `MOVIES_POLL_MS`, `PLAY_POLL_MS`.
- `web/src/lib/movies.ts`: `moviesChatMessage`, headings, hint, count lines, state labels, filters, sort, play plans,
  formatters (full list in Step 4).
- `web/src/pages/MoviesPage.tsx`; `web/src/components/movies/{Movies.css, Poster.tsx, PosterTile.tsx, MoviesGrid.tsx,
  MovieDetail.tsx, Stars.tsx, ReviewField.tsx, EpisodeList.tsx, parts.tsx, UnmatchedList.tsx, AssignDialog.tsx,
  MoviesPill.tsx}`; `web/src/testing/movieFixtures.ts`; jsdom tests.
- `web/src/components/Rail.tsx`: `MOVIES_TIP = 'Movies'`, `RailProps.onToggleMovies` (required),
  `BIN_TIP.movies`. `Sidebar.tsx`: `SidebarProps.onToggleMovies` (required). `Header.tsx`: `HeaderProps.movies?`.

**Signature changes:**
- `hrefForView(view, thread, loc, projects?, adversary?)` -> `hrefForView(view, thread, loc, projects?, adversary?,
  movies: MoviesRoute = NO_MOVIES_ROUTE)`. The new parameter is optional, so existing callers and tests compile.
- `Rail` and `Sidebar` take a required `onToggleMovies`. Their only callers are `App.tsx` and `Rail.test.tsx`, and
  both are updated here.

**Requires (from earlier phases): the wire this page consumes.** The read routes and their types come from
**phase 4's plan** (`phase-4.md`, Interface Contract, "HTTP routes" and "Wire types"). They are mirrored verbatim in
`web/src/moviesApi.ts`: `TitleListItem`, `TitleProgress`, `TitleDetail`, `SeasonView`, `EpisodeView`, `FileView`,
`ProgressView`, `PlayView`, `UnmatchedFile`, `ParsedView`, `CompanyView`, `CrewCredit`, `CastCredit`, `TmdbHitView`,
`StatusCounts`, plus the response envelopes `TitleListResponse { titles }`, `UnmatchedResponse { files }`,
`MoviesStatusResponse` (phase 3's `MoviesStatus` = `{ host, roots, done_dirs, scan_ms, min_seconds, scanning,
running, tmdb: 'ok' | 'no_credentials' | 'unreachable', next_pass_at, last_pass }` & `{ counts }`; reconciled),
`TmdbSearchResponse { results }`, `FileChangeResponse { file_id, title }`, `MovieChangeWire` (phase 3's
`MovieChangeEvent` `{ type: 'changed', reason, title_ids, file_ids }`). `PlayView` carries `episode_name` and
`file_deleted_at` (reconciled, phase 4). Routes used:

| Route | Used for |
|---|---|
| `GET /api/movies` | the grid and the header count line (no query: filtering is client-side) |
| `GET /api/movies/:id` | the detail page |
| `GET /api/movies/unmatched` | the unmatched list |
| `GET /api/movies/status` | the empty-library text (`roots`, `tmdb`) and the unmatched badge (`counts.unmatched_here + counts.pending_here`) |
| `GET /api/movies/search-tmdb?q=<enc>&kind=movie\|tv` | the assign dialog |
| `POST /api/movies/:id/user` `{ watched }` / `{ rating }` / `{ review }` (one key per call) | watched flag, stars, review |
| `POST /api/movies/files/:fileId/watched` `{ watched }` | per-file / per-episode watched |
| `POST /api/movies/files/:fileId/assign` `{ kind, tmdb_id, season?, episode? }` -> `FileChangeResponse` | assign |
| `POST /api/movies/sync` (202) | the rescan icon |
| `GET /api/movies/events` (SSE `event: changed`) | refetch |
| every route: `503 { error: 'movies_off' }` | the "off" empty state |

**Phase 5's play routes (reconciled to phase 5's Interface Contract, mirrored verbatim):**
- `GET /api/movies/player` -> `PlayerState { available: boolean; reason: string | null; current: PlayerSnapshot | null }`,
  `PlayerSnapshot { play_id, file_id, title_id, name, port, state: 'playing' | 'paused' | 'stopped', position: number,
  duration: number | null, started_at, last_read_at }`. `available` false = vlc.exe / interop / curl.exe missing (R4.5),
  `reason: 'movies_off'` without a player. The page reads playback availability **here**; phase 5 also adds
  `movies_playback` to `/api/capabilities`, which the web does not read.
- `POST /api/movies/files/:fileId/play` `{}` -> `202 { ok: true, play: PlayStarted }` (the page ignores the body).
  Errors `{ error }`: `not_on_this_machine` (404), `player_unavailable` (409), `file_missing` (410), `not_found` (404).
- `POST /api/movies/continue` `{ title: '<title id>' }` -> `ContinueResult`, phase 5's union:
  `resumed | started` (`{ title, file: ContinueEpisodeRef, position, play }`), `missing` (`{ title, missing:
  ContinueEpisodeRef, present: ContinueEpisodeRef[] }`), `nothing` (`{ title, reason: 'finished' | 'caught_up' |
  'no_episodes', finished_at, last }`), `ambiguous` (`{ query, candidates }`), `no_match` (`{ query }`).
  `ContinueEpisodeRef = { file_id, season, episode, absolute_episode, name }` (nullable fields). The page sends the
  exact title id; phase 5's `continueTitle` matches an exact id first.
- The server emits `changed` (reason `play`) on play start and end only, never per position poll; the page polls
  `GET /api/movies/player` during a play.

**Leaves alone (owned by others):** everything under `src/**` (phases 1-5, 7), `src/http/reveal.ts` capabilities
(phase 5), `.claude/skills/verify-notesd/**` including `features/movies.md` (phase 8), `README.md`, `CLAUDE.md`
(phase 8), `web/src/hooks/useCapabilities.ts` and `web/src/api.ts` (untouched; `ApiError` is only imported).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/types.ts:86` | modify | `View` gains `'movies'` |
| `web/src/lib/route.ts` | modify (full file below) | movies path, route, href, `hrefForView` branch |
| `web/src/lib/route.test.tsx:2`, end of file | modify | import line; a `movies route` describe |
| `web/src/moviesApi.ts` | create | wire mirrors + fetchers |
| `web/src/hooks/useMovies.ts` | create | the page's store: fetch on open, SSE `changed`, play polling, 60 s fallback poll |
| `web/src/hooks/useMovies.test.tsx` | create | hook behavior |
| `web/src/lib/movies.ts` | create | chat message, headings, count lines, filters, sort, play plans, formatters |
| `web/src/lib/movies.test.tsx` | create | pure helpers |
| `web/src/testing/movieFixtures.ts` | create | wire fixtures shared by the tests |
| `web/src/components/movies/Movies.css` | create | every `mv-*` style |
| `web/src/components/movies/Poster.tsx` | create | lazy `<img>` with a designed title tile fallback |
| `web/src/components/movies/Poster.test.tsx` | create | fallback on error / no URL |
| `web/src/components/movies/PosterTile.tsx` | create | one grid tile: poster, state badge, progress bar, caption, dimmed when gone |
| `web/src/components/movies/MoviesGrid.tsx` | create | filter row + grid |
| `web/src/components/movies/MovieDetail.tsx` | create | detail page (film and series), credits, cast |
| `web/src/components/movies/Stars.tsx` | create | 0-5 stars |
| `web/src/components/movies/ReviewField.tsx` | create | review textarea saved on blur |
| `web/src/components/movies/EpisodeList.tsx` | create | seasons and episode rows |
| `web/src/components/movies/parts.tsx` | create | `FileFlags`, `Meter`, `WatchedButton`, `PlayButton`, `FileRow` |
| `web/src/components/movies/UnmatchedList.tsx` | create | unmatched rows + opens the assign dialog |
| `web/src/components/movies/AssignDialog.tsx` | create | TMDB search and assign |
| `web/src/components/movies/MoviesPill.tsx` | create | the page's pill (ChatBar page variant) |
| `web/src/pages/MoviesPage.tsx` | create | toolbar, content switch, pill |
| `web/src/components/Rail.tsx` | modify (full file below) | FilmSlate "Movies" icon, `BIN_TIP.movies` |
| `web/src/components/Sidebar.tsx` | modify (full file below) | FilmSlate "Movies" icon |
| `web/src/components/Header.tsx` | modify (full file below) | `movies` flag: hint, no "Last edited" |
| `web/src/components/Rail.test.tsx:12-43`, end | modify | helpers pass `onToggleMovies`; a `Movies icon` describe |
| `web/src/App.tsx` | modify (13 edits) | state, toggle, URL sync, popstate, header, page render, pill, wall chat bar hidden |
| `web/src/App.movies.test.tsx` | create | end-to-end page behavior through the stubbed API |

## Implementation Steps

Before step 1, if `/home/miftah/.worktrees/mcp-notes/movies-library/node_modules` is missing, run `npm ci` in the worktree.

### Step 1: `View` gains `'movies'`
**File:** `web/src/types.ts:86`
**Change:** replace the `View` line and its comment.
**Code:**
```ts
/** What the main area shows: the wall (text / images / all modes), the recycle bin, the chat history page (phase 9), the projects session graph (project-session-graph phase 10), Seer Adversarial, or the movies library (movies-library phase 6). */
export type View = 'wall' | 'bin' | 'history' | 'projects' | 'adversary' | 'movies';
```
**Impact:** `BIN_TIP: Record<View, string>` in `Rail.tsx` no longer typechecks until Step 13 adds `movies`. Steps 1
and 13 land in the same commit. No other `Record<View, ...>` exists (`grep -rn "Record<View" web/src`).

### Step 2: Movies route
**File:** `web/src/lib/route.ts` (whole file, 130 lines today)
**Change:** add the movies path, route type, parser and href. `hrefForView` gets an optional sixth parameter and
treats `/movies[/...]` like the other page paths: leaving it pushes `/`.
**Code:**
```ts
import type { View } from '../types';

/**
 * The history page's URL (phase 9): `/history`, or `/history?thread=<id>` to open it on one thread.
 * The projects view (project-session-graph phase 10): `/projects`, `/projects?repo=<repo>`, and
 * `/projects?repo=<repo>&node=<NODE-ID>` with one graph node selected. `&focus=1` is graph focus
 * mode: the page alone, without rail, sidebar and header. `/projects?node=<NODE-ID>` (no repo) is how
 * Claude Code links a node: the app looks up the node's repo.
 * Seer Adversarial (seer-adversarial phase 6): `/adversary` (overview) and `/adversary/<strategy_id>`
 * (one roster method, the id exactly as Seer stores it), each with `?focus=1` for focus mode.
 * Movies (movies-library phase 6): `/movies` (the poster grid), `/movies/<title id>` (`movie-<n>` /
 * `tv-<n>`, never altered) and `/movies/unmatched` (the files that matched no title).
 * The wall and the bin have no path of their own: they live at `/` (and `/?note=<id>` deep links,
 * lib/deepLink.ts), so leaving the history, projects, adversary or movies page pushes `/` and nothing else is touched.
 */
export const HISTORY_PATH = '/history';
export const PROJECTS_PATH = '/projects';
export const ADVERSARY_PATH = '/adversary';
export const MOVIES_PATH = '/movies';
/** `/movies/unmatched`. Title ids are `movie-<n>` / `tv-<n>`, so this segment never names a title. */
export const MOVIES_UNMATCHED_SEGMENT = 'unmatched';

export interface Route {
  history: boolean;
  thread: string | null;
}

/** What `/projects` asks for. `repo` null = the server-side selection; `node` is canonical (`A0-3G`). */
export interface ProjectsRoute {
  repo: string | null;
  node: string | null;
  /** Graph focus mode: only the page (graph or project chat, toolbar, pill) is shown. */
  focus: boolean;
}

export const NO_PROJECT_ROUTE: ProjectsRoute = { repo: null, node: null, focus: false };

type Loc = Pick<Location, 'pathname' | 'search'>;

/** The path without trailing slashes (`/` stays `/`). */
function pathOf(loc: Loc): string {
  return loc.pathname.length > 1 ? loc.pathname.replace(/\/+$/, '') : loc.pathname;
}

/** A trimmed query value; empty counts as absent. */
function param(search: string, key: string): string | null {
  const v = new URLSearchParams(search).get(key);
  return v !== null && v.trim() !== '' ? v.trim() : null;
}

/** The one segment after `<base>/`, decoded and trimmed: '' for the bare base, null when the path is not `<base>[/<one segment>]`. */
function oneSegment(p: string, base: string): string | null {
  if (p === base) return '';
  if (!p.startsWith(`${base}/`)) return null;
  const rest = p.slice(base.length + 1);
  if (rest === '' || rest.includes('/')) return null;
  try {
    return decodeURIComponent(rest).trim();
  } catch {
    return null;
  }
}

/** What the URL asks for. A trailing slash is tolerated; an empty `thread` is no thread. */
export function routeFromLocation(loc: Loc): Route {
  if (pathOf(loc) !== HISTORY_PATH) return { history: false, thread: null };
  return { history: true, thread: param(loc.search, 'thread') };
}

export function historyHref(thread: string | null): string {
  return thread ? `${HISTORY_PATH}?thread=${encodeURIComponent(thread)}` : HISTORY_PATH;
}

const NODE_ID_LOOSE = /^([0-9A-Z]{2})-?([0-9A-Z]{2})$/;

/** `a03g`, `A0-3g` → `A0-3G`; anything not shaped like a node id → null. Never checks existence. */
export function canonicalNodeId(input: string): string | null {
  const m = NODE_ID_LOOSE.exec(input.trim().toUpperCase());
  return m ? `${m[1]}-${m[2]}` : null;
}

/** The projects route, or null when the URL is not `/projects`. A malformed `node` is dropped. */
export function projectsRouteFromLocation(loc: Loc): ProjectsRoute | null {
  if (pathOf(loc) !== PROJECTS_PATH) return null;
  const node = param(loc.search, 'node');
  return { repo: param(loc.search, 'repo'), node: node === null ? null : canonicalNodeId(node), focus: param(loc.search, 'focus') === '1' };
}

export function projectsHref(r: ProjectsRoute): string {
  const p = new URLSearchParams();
  if (r.repo) p.set('repo', r.repo);
  if (r.node) p.set('node', r.node);
  if (r.focus) p.set('focus', '1');
  const q = p.toString();
  return q ? `${PROJECTS_PATH}?${q}` : PROJECTS_PATH;
}

/** What `/adversary` asks for. `strategy` null = the overview; else a Seer strategy id, never altered. */
export interface AdversaryRoute {
  strategy: string | null;
  /** Focus mode: the page alone, without rail, sidebar and header. */
  focus: boolean;
}

export const NO_ADVERSARY_ROUTE: AdversaryRoute = { strategy: null, focus: false };

/** The adversary route, or null when the URL is not `/adversary[/<id>]`. A deeper path is not this page. */
export function adversaryRouteFromLocation(loc: Loc): AdversaryRoute | null {
  const id = oneSegment(pathOf(loc), ADVERSARY_PATH);
  if (id === null) return null;
  return { strategy: id === '' ? null : id, focus: param(loc.search, 'focus') === '1' };
}

export function adversaryHref(r: AdversaryRoute): string {
  const base = r.strategy ? `${ADVERSARY_PATH}/${encodeURIComponent(r.strategy)}` : ADVERSARY_PATH;
  return r.focus ? `${base}?focus=1` : base;
}

/**
 * What `/movies` asks for: the grid (`title` null, `unmatched` false), one title, or the unmatched
 * list. The parser never builds `title` and `unmatched` together; `moviesHref` gives `unmatched` precedence.
 */
export interface MoviesRoute {
  title: string | null;
  unmatched: boolean;
}

export const NO_MOVIES_ROUTE: MoviesRoute = { title: null, unmatched: false };

/** The movies route, or null when the URL is not `/movies[/<title id> | /unmatched]`. A deeper path is not this page. */
export function moviesRouteFromLocation(loc: Loc): MoviesRoute | null {
  const seg = oneSegment(pathOf(loc), MOVIES_PATH);
  if (seg === null) return null;
  if (seg === '') return { title: null, unmatched: false };
  if (seg === MOVIES_UNMATCHED_SEGMENT) return { title: null, unmatched: true };
  return { title: seg, unmatched: false };
}

export function moviesHref(r: MoviesRoute): string {
  if (r.unmatched) return `${MOVIES_PATH}/${MOVIES_UNMATCHED_SEGMENT}`;
  return r.title ? `${MOVIES_PATH}/${encodeURIComponent(r.title)}` : MOVIES_PATH;
}

/**
 * The URL to push so the address bar matches `view`, or null when it already does. Wall and bin
 * accept any non-history, non-projects, non-adversary, non-movies URL as it is (a `/?note=` link stays put);
 * only leaving `/history`, `/projects`, `/adversary` or `/movies` pushes `/`.
 */
export function hrefForView(
  view: View,
  thread: string | null,
  loc: Loc,
  projects: ProjectsRoute = NO_PROJECT_ROUTE,
  adversary: AdversaryRoute = NO_ADVERSARY_ROUTE,
  movies: MoviesRoute = NO_MOVIES_ROUTE,
): string | null {
  const r = routeFromLocation(loc);
  const p = projectsRouteFromLocation(loc);
  const a = adversaryRouteFromLocation(loc);
  const m = moviesRouteFromLocation(loc);
  if (view === 'history') return r.history && r.thread === thread ? null : historyHref(thread);
  if (view === 'projects') return p !== null && p.repo === projects.repo && p.node === projects.node && p.focus === projects.focus ? null : projectsHref(projects);
  if (view === 'adversary') return a !== null && a.strategy === adversary.strategy && a.focus === adversary.focus ? null : adversaryHref(adversary);
  if (view === 'movies') return m !== null && moviesHref(m) === moviesHref(movies) ? null : moviesHref(movies);
  return r.history || p !== null || a !== null || m !== null ? '/' : null;
}
```
**Impact:** `adversaryRouteFromLocation` now goes through the shared `oneSegment` helper. Its behavior is unchanged:
`/adversary` gives the overview, one decoded segment gives a strategy, and a deeper or malformed path gives null. The
existing `route.test.tsx` adversary cases still pass. A blank decoded segment (`/adversary/%20`) still gives the
overview, as before.

### Step 3: Route tests
**File:** `web/src/lib/route.test.tsx:2` (import line) and the end of the file
**Change:** replace the import on line 2; append one describe block.
**Code (line 2):**
```ts
import { adversaryHref, adversaryRouteFromLocation, canonicalNodeId, historyHref, hrefForView, moviesHref, moviesRouteFromLocation, NO_ADVERSARY_ROUTE, NO_PROJECT_ROUTE, projectsHref, projectsRouteFromLocation, routeFromLocation } from './route';
```
**Code (appended):**
```ts
describe('movies route', () => {
  it('reads the grid, a title and the unmatched list', () => {
    expect(moviesRouteFromLocation(loc('/movies'))).toEqual({ title: null, unmatched: false });
    expect(moviesRouteFromLocation(loc('/movies/'))).toEqual({ title: null, unmatched: false });
    expect(moviesRouteFromLocation(loc('/movies/tv-247718'))).toEqual({ title: 'tv-247718', unmatched: false });
    expect(moviesRouteFromLocation(loc('/movies/unmatched'))).toEqual({ title: null, unmatched: true });
  });

  it('anything else is not the movies page', () => {
    expect(moviesRouteFromLocation(loc('/'))).toBeNull();
    expect(moviesRouteFromLocation(loc('/moviesx'))).toBeNull();
    expect(moviesRouteFromLocation(loc('/movies/a/b'))).toBeNull();
    expect(moviesRouteFromLocation(loc('/movies/%E0%A4%A'))).toBeNull();
  });

  it('builds hrefs and pushes only when the URL disagrees with the view', () => {
    expect(moviesHref({ title: null, unmatched: false })).toBe('/movies');
    expect(moviesHref({ title: 'movie-467905', unmatched: false })).toBe('/movies/movie-467905');
    expect(moviesHref({ title: null, unmatched: true })).toBe('/movies/unmatched');
    expect(hrefForView('movies', null, loc('/'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, { title: 'tv-1', unmatched: false })).toBe('/movies/tv-1');
    expect(hrefForView('movies', null, loc('/movies/tv-1'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, { title: 'tv-1', unmatched: false })).toBeNull();
    expect(hrefForView('movies', null, loc('/movies/tv-1'), NO_PROJECT_ROUTE, NO_ADVERSARY_ROUTE, { title: null, unmatched: true })).toBe('/movies/unmatched');
    expect(hrefForView('wall', null, loc('/movies/tv-1'))).toBe('/');
    expect(hrefForView('adversary', null, loc('/movies'))).toBe('/adversary');
    expect(hrefForView('wall', null, loc('/?note=A-B32'))).toBeNull();
  });
});
```
**Impact:** none beyond the new cases.

### Step 4: Wire mirrors and fetchers
**File:** `web/src/moviesApi.ts` (new)
**Code:**
```ts
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
```
**Impact:** new module, nothing imports it yet.

### Step 5: Pure helpers
**File:** `web/src/lib/movies.ts` (new)
**Code:**
```ts
import type {
  CastCredit,
  ContinueEpisodeRef,
  ContinueResult,
  CrewCredit,
  EpisodeView,
  FileReason,
  FileView,
  MoviesStatusResponse,
  PlayerState,
  ProgressView,
  SeasonView,
  TitleDetail,
  TitleKind,
  TitleListItem,
  UnmatchedFile,
  WatchState,
} from '../moviesApi';
import type { MoviesRoute } from './route';

export const MOVIES_HEADING = 'Movies.';
export const UNMATCHED_HEADING = 'Unmatched.';
export const MOVIES_HINT = 'Posters and credits come from TMDB. Play opens VLC on the machine that holds the file.';
export const MOVIES_PILL_PLACEHOLDER = 'Ask about your movies';
export const MOVIES_OFF_TEXT = 'Movies are off on this daemon. Set NOTESD_MOVIES=on and NOTESD_MOVIES_ROOTS, then restart notesd.';
export const PLAYER_OFF_LABEL = 'VLC is not available on this machine';
/** Producers beyond this are counted ("and 12 more"): TMDB lists every executive producer. */
export const PRODUCER_LIMIT = 8;
/** Cast shown before the "show all" icon. */
export const CAST_LIMIT = 18;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const STATE_LABEL: Record<WatchState, string> = {
  finished: 'finished',
  in_progress: 'in progress',
  unwatched: 'unwatched',
  dropped: 'dropped',
  removed_unwatched: 'removed unwatched',
  seen: 'seen',
};

export function kindLabel(kind: TitleKind): string {
  return kind === 'movie' ? 'film' : 'series';
}

/** The chip on a poster. Unwatched shows nothing: a clean poster is the invitation. */
export function stateBadge(state: WatchState): string | null {
  return state === 'unwatched' ? null : STATE_LABEL[state];
}

/** Seconds -> `45:00` / `2:03:05`. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Minutes -> `1h 52m` / `2h` / `48m`; '' when unknown. */
export function runtimeText(min: number | null): string {
  if (min === null || min <= 0) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** `2026-02-20` (or a datetime starting with it) -> `Feb 20, 2026`, no time zone shift; '' when null. */
export function releaseText(iso: string | null): string {
  if (iso === null) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** An ISO datetime -> its local `Nov 4, 2026`. */
export function dayText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function sizeText(bytes: number | null): string {
  if (bytes === null) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** `S01E05`; '' when either number is unknown. */
export function episodeCode(season: number | null, episode: number | null): string {
  if (season === null || episode === null) return '';
  return `S${pad(season)}E${pad(episode)}`;
}

export function seasonsText(n: number | null): string {
  return n === null ? '' : plural(n, 'season');
}

/** Gone: no file left on any machine. The tile is dimmed, never hidden. */
export function isGone(t: TitleListItem): boolean {
  return t.file_count === 0;
}

/** The bar under a poster while a title is in progress: how far into a film, or the share of episodes finished. */
export function tileProgress(t: TitleListItem): number | null {
  if (t.state !== 'in_progress') return null;
  const p = t.progress;
  if (p.kind === 'movie') return p.ratio;
  const total = p.episodes_total ?? p.episodes_present;
  return total > 0 ? Math.min(1, p.episodes_finished / total) : null;
}

export type StateFilter = 'all' | 'unwatched' | 'in_progress' | 'finished' | 'gone';
export type KindFilter = 'all' | TitleKind;

export interface MoviesFilter {
  state: StateFilter;
  kind: KindFilter;
  text: string;
}

export const NO_MOVIES_FILTER: MoviesFilter = { state: 'all', kind: 'all', text: '' };

export const STATE_FILTERS: readonly { key: StateFilter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'unwatched', label: 'unwatched' },
  { key: 'in_progress', label: 'in progress' },
  { key: 'finished', label: 'finished' },
  { key: 'gone', label: 'gone' },
];

export const KIND_FILTERS: readonly { key: KindFilter; label: string }[] = [
  { key: 'all', label: 'All kinds' },
  { key: 'movie', label: 'Films' },
  { key: 'tv', label: 'Series' },
];

/** `finished` includes `seen` (opened, position unknown). `gone` is about files, not state: it overlaps the others. */
export function matchesFilter(t: TitleListItem, f: MoviesFilter): boolean {
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
      return isGone(t);
  }
}

/** How many titles each state pill would show under the current kind and text filter. */
export function stateCounts(titles: TitleListItem[], f: MoviesFilter): Record<StateFilter, number> {
  const out: Record<StateFilter, number> = { all: 0, unwatched: 0, in_progress: 0, finished: 0, gone: 0 };
  for (const t of titles) {
    for (const s of STATE_FILTERS) if (matchesFilter(t, { ...f, state: s.key })) out[s.key] += 1;
  }
  return out;
}

function rank(t: TitleListItem): number {
  if (isGone(t)) return 3;
  if (t.state === 'in_progress') return 0;
  if (t.state === 'unwatched') return 1;
  return 2;
}

/** In progress first (what to continue), then unwatched (what to start), then finished, then gone; newest play, newest year, title. */
export function sortTitles(titles: TitleListItem[]): TitleListItem[] {
  return [...titles].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.last_played_at ?? '').localeCompare(a.last_played_at ?? '') ||
      (b.year ?? 0) - (a.year ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

/** What the big Play button does. One shape per case, so a disabled reason never travels with a playable file. */
export type PlayPlan =
  | { kind: 'file'; file: FileView }
  | { kind: 'continue' }
  | { kind: 'elsewhere'; host: string }
  | { kind: 'none' };

export interface PlayButtonState {
  label: string;
  disabled: boolean;
}

/**
 * A film plays its most recently played file on this machine (the server resumes it, or starts over
 * when finished). A series asks phase 5's continue (resume the open episode, else the next one with
 * a file). With no present file here: `elsewhere` when another machine holds one, else `none`.
 */
export function playPlan(d: TitleDetail): PlayPlan {
  const present = d.files.filter((f) => !f.deleted);
  const here = present.filter((f) => f.available);
  const first = present[0];
  if (here.length === 0) return first !== undefined ? { kind: 'elsewhere', host: first.host } : { kind: 'none' };
  if (d.kind === 'tv') return { kind: 'continue' };
  const file = here.reduce((best, f) => ((f.last_played_at ?? '') > (best.last_played_at ?? '') ? f : best));
  return { kind: 'file', file };
}

export function playLabel(plan: PlayPlan, player: PlayerState | null): PlayButtonState {
  if (plan.kind === 'none') return { label: 'No file left to play', disabled: true };
  if (plan.kind === 'elsewhere') return { label: `On ${plan.host}: play it on that machine`, disabled: true };
  if (player !== null && !player.available) return { label: PLAYER_OFF_LABEL, disabled: true };
  if (plan.kind === 'continue') return { label: 'Continue: resume the open episode or play the next one', disabled: false };
  const at = plan.file.resume_position_s;
  return { label: at > 0 ? `Resume at ${clock(at)}` : 'Play', disabled: false };
}

/** A row's play icon. `what` names the row: `S01E02`, or `this file`. */
export function filePlayLabel(f: FileView, player: PlayerState | null, what: string): PlayButtonState {
  if (f.deleted) return { label: `${what} is deleted`, disabled: true };
  if (!f.available) return { label: `${what} is on ${f.host}`, disabled: true };
  if (player !== null && !player.available) return { label: PLAYER_OFF_LABEL, disabled: true };
  const at = f.resume_position_s;
  return { label: at > 0 ? `Resume ${what} at ${clock(at)}` : `Play ${what}`, disabled: false };
}

export function startedNotice(f: FileView): string {
  return f.resume_position_s > 0 ? `resuming at ${clock(f.resume_position_s)}` : 'playing in VLC';
}

export function playErrorText(code: string): string {
  if (code === 'not_on_this_machine') return 'that file is on another machine';
  if (code === 'player_unavailable') return PLAYER_OFF_LABEL;
  if (code === 'file_missing') return 'the file is gone from disk; rescan to update the library';
  if (code === 'not_found') return 'no such file';
  return `could not play (${code})`;
}

function refCode(e: ContinueEpisodeRef): string {
  return episodeCode(e.season, e.episode);
}

export function continueNotice(r: ContinueResult): string {
  if (r.action === 'resumed' || r.action === 'started') {
    const what = episodeCode(r.file.season, r.file.episode) || 'it';
    if (r.action === 'started') return `playing ${what}`;
    return r.position > 0 ? `resuming ${what} at ${clock(r.position)}` : `resuming ${what}`;
  }
  if (r.action === 'missing') {
    const miss = refCode(r.missing) || 'the next episode';
    const have = r.present.map(refCode).filter((c) => c !== '').join(', ');
    return have ? `${miss} is not on this machine; ${have} ${r.present.length === 1 ? 'is' : 'are'}` : `${miss} is not on this machine`;
  }
  if (r.action === 'nothing') return r.reason === 'finished' ? 'already finished' : r.reason === 'caught_up' ? 'caught up: nothing after the last episode' : 'nothing to continue';
  return 'nothing to continue';
}

/** Progress text of a file or episode: `in progress · 40%`, else the state's label. */
export function meterText(state: WatchState, p: ProgressView): string {
  return state === 'in_progress' && p.ratio !== null ? `${STATE_LABEL[state]} · ${Math.round(p.ratio * 100)}%` : STATE_LABEL[state];
}

export function meterRatio(state: WatchState, p: ProgressView): number {
  if (state === 'finished') return 1;
  return p.ratio === null ? 0 : Math.min(1, Math.max(0, p.ratio));
}

/** The file an episode's row speaks for: phase 4's primary file. */
export function primaryFile(e: EpisodeView): FileView | null {
  return e.files.find((f) => f.id === e.file_id) ?? e.files[0] ?? null;
}

export interface SeasonsShown {
  seasons: SeasonView[];
  /** Seasons with no file on any machine: counted, not listed (a long series would list hundreds of empty rows). */
  hidden: number;
}

export function seasonsShown(d: TitleDetail): SeasonsShown {
  const seasons = d.seasons.filter((s) => s.episodes.some((e) => e.has_file));
  return { seasons, hidden: d.seasons.length - seasons.length };
}

export function namesText(people: (CrewCredit | CastCredit)[], limit = Number.POSITIVE_INFINITY): string {
  const shown = people.slice(0, limit).map((c) => c.name).join(', ');
  return people.length > limit ? `${shown} and ${people.length - limit} more` : shown;
}

/** The credits block: studios, then the crew the owner asked for. Empty groups are left out. */
export function creditRows(d: TitleDetail): [string, string][] {
  const rows: [string, string][] = [];
  if (d.companies.length > 0) rows.push(['Studios', d.companies.map((c) => c.name).join(', ')]);
  if (d.creators.length > 0) rows.push(['Created by', namesText(d.creators)]);
  if (d.directors.length > 0) rows.push(['Directed by', namesText(d.directors)]);
  if (d.writers.length > 0) rows.push(['Written by', namesText(d.writers)]);
  if (d.producers.length > 0) rows.push(['Produced by', namesText(d.producers, PRODUCER_LIMIT)]);
  return rows;
}

const REASON_TEXT: Record<FileReason, string> = {
  too_short: 'shorter than 15 minutes',
  no_match: 'no TMDB match',
  low_confidence: 'TMDB match not confident',
  tmdb_error: 'TMDB could not be reached',
  no_tmdb_credentials: 'no TMDB credentials',
  probe_failed: 'ffprobe could not read it',
};

export function reasonText(reason: FileReason | null, status: UnmatchedFile['status']): string {
  if (reason !== null) return REASON_TEXT[reason] ?? reason;
  return status === 'pending' ? 'waiting for the next scan' : 'unmatched';
}

/** `2026 · film · 1h 52m · in progress`. */
export function factsLine(d: TitleDetail): string {
  const length = d.kind === 'tv' ? seasonsText(d.season_count) : runtimeText(d.runtime_min);
  return [d.year === null ? '' : String(d.year), kindLabel(d.kind), length, STATE_LABEL[d.state]].filter((s) => s !== '').join(' · ');
}

/** What the header and the page read from the store (structurally `MoviesStore` minus its actions). */
export interface MoviesView {
  titles: TitleListItem[] | null;
  listError: string | null;
  detail: TitleDetail | null;
  detailError: string | null;
  unmatched: UnmatchedFile[] | null;
  unmatchedError: string | null;
  status: MoviesStatusResponse | null;
}

export function isMoviesOff(s: MoviesView): boolean {
  return s.listError === 'movies_off' || s.detailError === 'movies_off' || s.unmatchedError === 'movies_off';
}

export function moviesErrorText(code: string, titleId: string | null = null): string {
  if (code === 'movies_off') return MOVIES_OFF_TEXT;
  if (code === 'not_found') return titleId ? `No title ${titleId} in the library.` : 'Not found.';
  return `Could not load the movies library (${code}).`;
}

export function emptyLibraryText(status: MoviesStatusResponse | null): string {
  if (status === null) return 'No titles yet.';
  if (status.roots.length === 0) return 'No library folders are set on this machine. Add them to NOTESD_MOVIES_ROOTS and restart notesd.';
  const tmdb =
    status.tmdb === 'no_credentials'
      ? ' TMDB credentials are missing, so every file waits in the unmatched list.'
      : status.tmdb === 'unreachable'
        ? ' TMDB could not be reached; new files wait and are retried on the next pass.'
        : '';
  return `No titles yet. notesd scans ${status.roots.join(' and ')} every few minutes; the arrows above rescan now.${tmdb}`;
}

/** Files waiting for a hand: unmatched plus pending, on this machine. Null until the status answers. */
export function unmatchedCount(status: MoviesStatusResponse | null): number | null {
  return status === null ? null : status.counts.unmatched_here + status.counts.pending_here;
}

export function moviesHeading(s: MoviesView, route: MoviesRoute): string {
  if (route.unmatched) return UNMATCHED_HEADING;
  if (route.title !== null && s.detail !== null && s.detail.id === route.title) return `${s.detail.title}.`;
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
    if (s.detail === null || s.detail.id !== route.title) return 'Loading.';
    return `${factsLine(s.detail)}.`;
  }
  if (s.listError !== null) return moviesErrorText(s.listError);
  if (s.titles === null) return 'Loading the library.';
  if (s.titles.length === 0) return 'No titles yet.';
  const films = s.titles.filter((t) => t.kind === 'movie').length;
  const series = s.titles.length - films;
  const going = s.titles.filter((t) => t.state === 'in_progress').length;
  return `${plural(s.titles.length, 'title')}: ${plural(films, 'film')}, ${series} series.${going > 0 ? ` ${going} in progress.` : ''}`;
}

/**
 * The chat bar has no page field (POST /api/chat carries message, thread_id, image_ids). The page's
 * context rides on the message's first line, as on Seer Adversarial: `[Movies · library]`,
 * `[Movies · unmatched files]`, or `[Movies · <title> (<year>) · <title id>]` once the open title's
 * detail is loaded (the bare id before). The chat agent reads it with phase 7's movies_* tools.
 */
export function moviesChatMessage(text: string, route: MoviesRoute, detail: TitleDetail | null): string {
  let where: string;
  if (route.unmatched) where = 'unmatched files';
  else if (route.title === null) where = 'library';
  else if (detail !== null && detail.id === route.title) where = `${detail.title}${detail.year !== null ? ` (${detail.year})` : ''} · ${route.title}`;
  else where = route.title;
  return `[Movies · ${where}]\n${text}`;
}
```
**Impact:** new module.

### Step 6: The page's store
**File:** `web/src/hooks/useMovies.ts` (new)
**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  errorCode,
  fetchMovie,
  fetchMovies,
  fetchPlayer,
  fetchStatus,
  fetchUnmatched,
  MOVIES_EVENTS_URL,
  type MoviesStatusResponse,
  type PlayerState,
  type TitleDetail,
  type TitleListItem,
  type UnmatchedFile,
} from '../moviesApi';
import { isPageVisible, onBecameVisible, startAdaptivePoll } from '../lib/pageActive';
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
  /** Re-read everything the page shows. Called after every write: the server's state wins. */
  refresh: () => void;
}

function quiet(what: string, e: unknown): void {
  if (errorCode(e) !== 'movies_off') console.error(`movies: ${what} failed`, e);
}

/**
 * The Movies page's data. Fetches only while `enabled` (the page is shown): the library (grid and
 * header), the status (unmatched badge, empty state), the player, and the title or unmatched list
 * the route asks for. Refreshes on `GET /api/movies/events` `changed`, every minute while visible,
 * and, while a play is active, the player and the open title every 5 s (one full refresh when it ends).
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
  const [tick, setTick] = useState(0);
  const [playTick, setPlayTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  /** A `changed` event arrived while the tab was hidden: refresh once on becoming visible. */
  const staleRef = useRef(false);
  const wasPlaying = useRef(false);
  const title = route.title;
  const wantUnmatched = route.unmatched;
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
    setDetail((d) => (d !== null && d.id === title ? d : null));
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

  return { titles, listError, detail, detailError, unmatched, unmatchedError, status, player, refresh };
}
```
**Impact:** new hook. While a play is active and the tab is visible, it makes two requests every 5 s (player and the
open title). The full refresh (list, status) stays on SSE and the 60 s poll.

### Step 7: Test fixtures
**File:** `web/src/testing/movieFixtures.ts` (new)
**Code:**
```ts
import type { EpisodeView, FileView, MoviesStatusResponse, PlayerState, TitleDetail, TitleKind, TitleListItem, TmdbHitView, UnmatchedFile } from '../moviesApi';

export const HOST = 'lenovo';
const ISO = '2026-11-10T12:00:00.000Z';
const NO_PROGRESS = { position_s: null, duration_s: null, ratio: null };

/** A wire `FileView`: a 1 h unwatched file on this host, present. */
export function makeFile(id: number, over: Partial<FileView> = {}): FileView {
  const base: FileView = {
    id,
    title_id: null,
    host: HOST,
    path: `/lib/f${id}.mkv`,
    name: `f${id}.mkv`,
    size: 2_000_000_000,
    duration_s: 3600,
    season: null,
    episode: null,
    absolute_episode: null,
    status: 'matched',
    reason: null,
    source: 'scan',
    first_seen_at: ISO,
    last_seen_at: ISO,
    deleted_at: null,
    moved_at: null,
    done_at: null,
    watched_at: null,
    deleted: false,
    available: true,
    unavailable_reason: null,
    state: 'unwatched',
    progress: NO_PROGRESS,
    resume_position_s: 0,
    last_played_at: null,
    finished_at: null,
  };
  return { ...base, ...over };
}

/** A wire `TitleListItem`; the kind follows the id (`tv-` / `movie-`). */
export function makeItem(id: string, title: string, over: Partial<TitleListItem> = {}): TitleListItem {
  const kind: TitleKind = id.startsWith('tv-') ? 'tv' : 'movie';
  const base: TitleListItem = {
    id,
    kind,
    tmdb_id: Number(id.slice(id.indexOf('-') + 1)),
    title,
    year: 2026,
    poster_url: null,
    state: 'unwatched',
    watched: false,
    watched_at: null,
    rating: null,
    progress: kind === 'movie' ? { kind: 'movie', ...NO_PROGRESS } : { kind: 'tv', episodes_finished: 0, episodes_total: null, episodes_present: 0 },
    last_played_at: null,
    finished_at: null,
    present_here: true,
    file_count: 1,
    deleted_file_count: 0,
    created_at: ISO,
  };
  return { ...base, ...over };
}

function detailOf(item: TitleListItem, over: Partial<TitleDetail>): TitleDetail {
  return {
    ...item,
    original_title: item.title,
    release_date: null,
    overview: '',
    runtime_min: null,
    genres: [],
    backdrop_url: null,
    season_count: null,
    episode_count: null,
    review: '',
    review_note_id: null,
    companies: [],
    directors: [],
    writers: [],
    producers: [],
    creators: [],
    cast: [],
    files: [],
    seasons: [],
    unplaced_files: [],
    plays: [],
    metadata_fetched_at: ISO,
    ...over,
  };
}

function episodeOf(season: number, episode: number, name: string, file: FileView | null): EpisodeView {
  return {
    season,
    episode,
    name,
    air_date: null,
    runtime_min: 50,
    overview: null,
    still_url: null,
    state: file?.state ?? 'unwatched',
    has_file: file !== null,
    present_here: file?.available ?? false,
    deleted: file?.deleted ?? false,
    progress: file?.progress ?? NO_PROGRESS,
    last_played_at: file?.last_played_at ?? null,
    finished_at: null,
    file_id: file?.id ?? null,
    files: file ? [file] : [],
  };
}

export const KILLING_ITEM = makeItem('movie-467905', 'How to Make a Killing', {
  poster_url: 'https://image.tmdb.org/t/p/w342/kill.jpg',
  state: 'in_progress',
  progress: { kind: 'movie', position_s: 2700, duration_s: 6720, ratio: 0.4 },
  last_played_at: '2026-11-13T14:00:00.000Z',
});

export const MOBLAND_ITEM = makeItem('tv-247718', 'MobLand', {
  year: 2025,
  state: 'in_progress',
  progress: { kind: 'tv', episodes_finished: 1, episodes_total: 4, episodes_present: 1 },
  file_count: 2,
  deleted_file_count: 1,
  last_played_at: '2026-11-12T20:00:00.000Z',
});

export const DOG_ITEM = makeItem('movie-9001', 'The Dog Stars', {
  year: 2025,
  poster_url: 'https://image.tmdb.org/t/p/w342/dog.jpg',
  state: 'dropped',
  present_here: false,
  file_count: 0,
  deleted_file_count: 1,
  last_played_at: '2026-10-01T20:00:00.000Z',
});

/** In server order on purpose (not the page's): the page sorts. */
export const TITLES: TitleListItem[] = [DOG_ITEM, MOBLAND_ITEM, KILLING_ITEM];

export const KILLING_FILE = makeFile(11, {
  title_id: 'movie-467905',
  name: 'How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
  duration_s: 6720,
  state: 'in_progress',
  progress: { position_s: 2700, duration_s: 6720, ratio: 2700 / 6720 },
  resume_position_s: 2700,
  last_played_at: '2026-11-13T14:00:00.000Z',
});

export const MOVIE: TitleDetail = detailOf(KILLING_ITEM, {
  poster_url: 'https://image.tmdb.org/t/p/w500/kill.jpg',
  release_date: '2026-02-20',
  overview: 'A disinherited heir plots his way back into the family fortune.',
  runtime_min: 112,
  genres: ['Comedy', 'Crime'],
  companies: [{ id: 3172, name: 'Blumhouse Productions', logo_url: null, origin_country: 'US' }],
  directors: [{ person_id: 1, name: 'Ava Director', profile_url: null, job: 'Director' }],
  writers: [{ person_id: 1, name: 'Ava Director', profile_url: null, job: 'Screenplay' }],
  producers: [{ person_id: 2, name: 'Pat Producer', profile_url: null, job: 'Producer' }],
  cast: [
    { person_id: 3, name: 'Glen Example', profile_url: null, character: 'Becket' },
    { person_id: 4, name: 'Mara Example', profile_url: null, character: 'Julia' },
  ],
  files: [KILLING_FILE],
});

const E1 = makeFile(21, {
  title_id: 'tv-247718',
  name: 'MobLand.S01E01.Stick.or.Twist.mkv',
  season: 1,
  episode: 1,
  deleted: true,
  deleted_at: '2026-11-01T10:00:00.000Z',
  available: false,
  unavailable_reason: 'deleted',
  state: 'finished',
  progress: { position_s: 2950, duration_s: 3000, ratio: 0.98 },
});
const E2 = makeFile(22, {
  title_id: 'tv-247718',
  name: 'MobLand.S01E02.mkv',
  season: 1,
  episode: 2,
  state: 'in_progress',
  progress: { position_s: 1200, duration_s: 3000, ratio: 0.4 },
  resume_position_s: 1200,
  last_played_at: '2026-11-12T20:00:00.000Z',
});
const E3 = makeFile(23, {
  title_id: 'tv-247718',
  name: 'MobLand.S01E03.mkv',
  season: 1,
  episode: 3,
  host: 'gpd',
  available: false,
  unavailable_reason: 'not_on_this_machine',
});

export const SERIES: TitleDetail = detailOf(MOBLAND_ITEM, {
  release_date: '2025-03-30',
  overview: 'Two crime families clash in London.',
  season_count: 2,
  episode_count: 5,
  creators: [{ person_id: 5, name: 'Ronan Creator', profile_url: null, job: 'Creator' }],
  files: [E1, E2, E3],
  seasons: [
    {
      season: 1,
      episodes: [episodeOf(1, 1, 'Stick or Twist', E1), episodeOf(1, 2, 'Episode Two', E2), episodeOf(1, 3, 'Episode Three', E3), episodeOf(1, 4, 'Episode Four', null)],
    },
    { season: 2, episodes: [episodeOf(2, 1, 'Season Two Opener', null)] },
  ],
});

export const UNMATCHED: UnmatchedFile[] = [
  {
    id: 31,
    host: HOST,
    path: '/lib/Done/docker_es/clip-0412.mp4',
    name: 'clip-0412.mp4',
    size: 4_000_000,
    duration_s: 42,
    status: 'unmatched',
    reason: 'too_short',
    parsed: null,
    first_seen_at: ISO,
    last_seen_at: ISO,
    available: true,
  },
  {
    id: 32,
    host: HOST,
    path: '/lib/Nezha (2019)/Ne.Zha.2.2025.1080p.mkv',
    name: 'Ne.Zha.2.2025.1080p.mkv',
    size: 3_000_000_000,
    duration_s: 8640,
    status: 'unmatched',
    reason: 'low_confidence',
    parsed: { title: 'Ne Zha 2', year: 2025, season: null, episode: null, absolute_episode: null, kind_hint: 'movie' },
    first_seen_at: ISO,
    last_seen_at: ISO,
    available: true,
  },
];

export const STATUS: MoviesStatusResponse = {
  host: HOST,
  roots: ['/lib'],
  done_dirs: ['Done'],
  scan_ms: 120000,
  min_seconds: 900,
  scanning: true,
  running: false,
  tmdb: 'ok',
  next_pass_at: ISO,
  last_pass: null,
  counts: { titles: 3, files_here: 3, unmatched_here: 2, pending_here: 0 },
};

export const PLAYER_IDLE: PlayerState = { available: true, reason: null, current: null };

export const PLAYING: PlayerState = {
  available: true,
  reason: null,
  current: { play_id: 7, file_id: 11, title_id: 'movie-467905', name: 'How.to.Make.a.Killing.2026.1080p.mkv', port: 47318, state: 'playing', position: 2710, duration: 6720, started_at: ISO, last_read_at: ISO },
};

export const SEARCH: TmdbHitView[] = [
  { kind: 'movie', tmdb_id: 1125510, title_id: 'movie-1125510', title: 'Ne Zha 2', original_title: 'Ne Zha 2', year: 2025, overview: '', poster_url: null, in_library: false },
];
```
**Impact:** test-only module (no test file imports it until the steps below).

### Step 8: Styles
**File:** `web/src/components/movies/Movies.css` (new; imported once, by `MoviesPage.tsx`)
**Code:**
```css
/* Movies (/movies, movies-library phase 6). Posters are the content: big, close together, the wall's
   film filter, which lifts on hover. Text is small, mono or muted. Monochrome, hairlines, no shadows. */
.mv { min-width: 0; }
.mv-tools { position: sticky; top: 0; z-index: 42; display: flex; align-items: center; justify-content: flex-end; gap: 4px; height: 44px; padding-top: 10px; pointer-events: none; }
.mv-tools > * { pointer-events: auto; }
.mv-tools .ibtn { font-size: 19px; position: relative; }
.mv-tools .ibtn:not(:hover):not(.on) { background: var(--bg); }
.mv-tools .ibtn:disabled { opacity: .35; cursor: default; }
.mv-note { font-family: var(--mono); font-size: 10.5px; color: var(--dim); letter-spacing: .03em; margin-right: 8px; }
.mv-count { position: absolute; top: 2px; right: 0; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 999px; background: var(--fg); color: var(--bg); font-family: var(--mono); font-size: 9px; line-height: 14px; text-align: center; }
.mv-tools .ibtn.on .mv-count { background: var(--bg); color: var(--fg); }
.mv-empty { margin: 32px 0; font-family: var(--mono); font-size: 12px; color: var(--dim); letter-spacing: .03em; }
.mv-off { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; margin: 48px 0; max-width: 560px; }
.mv-off svg { font-size: 56px; color: var(--deep); }
.mv-off p { margin: 0; font-size: 17px; line-height: 1.4; color: var(--muted); text-wrap: pretty; }
.mv-dim { color: var(--dim); font-family: var(--mono); font-size: 10.5px; letter-spacing: .03em; }

/* filter row: state pills (as the adversary filter), kind icons, a text filter */
.mv-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding-top: 18px; }
.mv-fstates { display: flex; flex-wrap: wrap; gap: 6px; }
.mv-fpill { font-family: var(--mono); font-size: 10.5px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line-25); background: transparent; color: var(--fg); cursor: pointer; letter-spacing: .02em; }
.mv-fpill.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.mv-fn { opacity: .6; margin-left: 4px; }
.mv-fkinds { display: flex; gap: 2px; }
.mv-fkinds .ibtn { width: 32px; height: 32px; font-size: 16px; }
.mv-ftext { display: flex; align-items: center; gap: 6px; margin-left: auto; border-bottom: 1px solid var(--line-25); padding: 4px 2px; color: var(--dim); font-size: 14px; }
.mv-ftext input { background: transparent; border: 0; color: var(--fg); font: inherit; font-size: 13px; width: 180px; }

/* grid */
.mv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(164px, 1fr)); gap: 22px 12px; padding-top: 22px; }
.mv-tile { display: flex; flex-direction: column; gap: 8px; color: inherit; text-decoration: none; transition: opacity .3s; }
.mv-tile:hover { color: inherit; }
.mv-tile:focus-visible { outline: 1px solid var(--ring); outline-offset: 3px; }
.mv-tile.gone { opacity: .32; }
.mv-tile.gone:hover { opacity: .7; }
.mv-art { position: relative; }
.mv-poster { aspect-ratio: 2 / 3; background: var(--img-bg); overflow: hidden; }
.mv-poster img { display: block; width: 100%; height: 100%; object-fit: cover; filter: var(--film); transition: filter .3s, transform .4s; }
.mv-tile:hover .mv-poster img { filter: none; transform: scale(1.03); }
.mv-fallback { display: flex; flex-direction: column; justify-content: flex-end; gap: 6px; padding: 14px; box-sizing: border-box; background: var(--card); border: 1px solid var(--line); }
.mv-fallback-t { font-size: 22px; line-height: 1; letter-spacing: -.03em; color: var(--text); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; overflow: hidden; }
.mv-fallback-y { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.mv-badge { position: absolute; left: 7px; top: 7px; font-family: var(--mono); font-size: 10px; line-height: 1; padding: 3px 7px 4px; border-radius: 999px; background: var(--fg); color: var(--bg); letter-spacing: .02em; }
.mv-badge.dropped, .mv-badge.removed_unwatched, .mv-badge.seen { background: var(--bg); color: var(--soft); border: 1px dashed var(--line-45); }
.mv-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(18, 18, 17, .7); }
.mv-progress > span { display: block; height: 3px; background: var(--fg); }
.mv-cap { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mv-cap-t { font-size: 13px; line-height: 1.25; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-cap-m { font-family: var(--mono); font-size: 10.5px; color: var(--dim); letter-spacing: .03em; }

/* detail */
.mv-detail { position: relative; padding-top: 18px; }
.mv-hero { position: absolute; top: 0; left: -20px; right: -20px; height: 420px; overflow: hidden; z-index: 0; pointer-events: none; }
.mv-hero img { width: 100%; height: 100%; object-fit: cover; opacity: .22; filter: var(--film); -webkit-mask-image: linear-gradient(to bottom, #000 30%, transparent); mask-image: linear-gradient(to bottom, #000 30%, transparent); }
.mv-detail-grid { position: relative; z-index: 1; display: grid; grid-template-columns: minmax(180px, 300px) minmax(0, 1fr); gap: 32px; align-items: start; }
.mv-detail-info { display: flex; flex-direction: column; gap: 18px; min-width: 0; padding-top: 6px; }
.mv-facts { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .03em; }
.mv-chip { display: inline-block; font-family: var(--mono); font-size: 10.5px; line-height: 1; padding: 3px 8px 4px; border-radius: 999px; border: 1px solid var(--line-25); color: var(--chip); white-space: nowrap; }
.mv-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mv-play { width: 56px; height: 56px; font-size: 26px; }
.mv-actions .ibtn:disabled { opacity: .35; cursor: default; }
.mv-stars { display: flex; align-items: center; margin-left: 6px; }
.mv-star { width: 30px; height: 30px; border: 0; border-radius: 999px; background: transparent; color: var(--deep); font-size: 20px; cursor: pointer; display: grid; place-items: center; }
.mv-star.on { color: var(--fg); }
.mv-star:hover { background: var(--hover); }
.mv-stars-n { margin-left: 6px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.mv-live { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
.mv-live::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; animation: repo-pulse 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .mv-live::before { animation: none; } }
.mv-overview { margin: 0; font-size: 16px; line-height: 1.5; color: var(--text); max-width: 68ch; text-wrap: pretty; }
.mv-review { display: flex; flex-direction: column; gap: 6px; max-width: 68ch; }
.mv-label, .mv-h2 { font-family: var(--mono); font-size: 10.5px; color: var(--dim); letter-spacing: .03em; font-weight: 400; margin: 0; }
.mv-review textarea { background: var(--card); color: var(--fg); border: 1px solid var(--line); font: inherit; font-size: 14px; line-height: 1.45; padding: 10px 12px; resize: vertical; min-height: 64px; }
.mv-review textarea:focus { border-color: var(--line-45); }
.mv-credits { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 18px; font-size: 13px; }
.mv-credits > div { display: contents; }
.mv-credits dt { font-family: var(--mono); font-size: 10.5px; color: var(--dim); letter-spacing: .03em; padding-top: 2px; }
.mv-credits dd { margin: 0; color: var(--muted); line-height: 1.4; }
.mv-sec { padding-top: 34px; display: flex; flex-direction: column; gap: 12px; }
.mv-cast { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px 16px; }
.mv-cast li { display: flex; flex-direction: column; gap: 2px; }
.mv-cast-n { font-size: 14px; color: var(--text); }
.mv-cast-c { font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.mv-season { display: flex; flex-direction: column; gap: 2px; }
.mv-season-h { font-size: 20px; font-weight: 400; letter-spacing: -.02em; margin: 0; padding: 10px 0 6px; }
.mv-eps, .mv-files { list-style: none; margin: 0; padding: 0; }
.mv-row { display: grid; grid-template-columns: 72px minmax(0, 1fr) 150px 32px 32px; gap: 14px; align-items: center; padding: 8px 4px; border-bottom: 1px solid var(--line); }
.mv-row.none { color: var(--dim); }
.mv-row.del .mv-row-name { color: var(--soft); text-decoration: line-through; text-decoration-color: var(--line-45); }
.mv-code { font-family: var(--mono); font-size: 11px; color: var(--id); letter-spacing: .03em; }
.mv-row-t { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0; font-size: 14px; }
.mv-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mv-flag { display: inline-flex; align-items: center; gap: 4px; font-family: var(--mono); font-size: 10px; line-height: 1; padding: 3px 7px 4px; border-radius: 999px; border: 1px dashed var(--line-45); color: var(--soft); white-space: nowrap; }
.mv-flag.del { border-style: solid; border-color: var(--band-red); color: var(--band-red); }
.mv-meter { display: flex; flex-direction: column; gap: 4px; font-family: var(--mono); font-size: 10px; color: var(--dim); }
.mv-meter-bar { height: 3px; background: var(--chip-bg); }
.mv-meter-bar > span { display: block; height: 3px; background: var(--fg); }
.mv-row .pbtn:disabled { opacity: .3; cursor: default; }

/* unmatched */
.mv-unm { list-style: none; margin: 0; padding: 18px 0 0; }
.mv-unm-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 70px 40px; gap: 16px; align-items: center; padding: 10px 4px; border-bottom: 1px solid var(--line); }
.mv-unm-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mv-unm-name { font-size: 14px; overflow-wrap: anywhere; }
.mv-unm-path { font-family: var(--mono); font-size: 10.5px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* assign dialog: the confirm dialog's frame (ConfirmDialog.css), wider */
.mv-dlg { position: fixed; inset: 0; z-index: 80; background: rgba(10, 10, 9, .6); display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
.mv-dlg-box { width: min(560px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; gap: 14px; padding: 18px; box-sizing: border-box; background: var(--bg); border: 1px solid var(--line-25); color: var(--text); font-family: var(--sans); overflow: hidden; }
.mv-dlg-file { margin: 0; font-family: var(--mono); font-size: 11px; color: var(--dim); overflow-wrap: anywhere; }
.mv-dlg-search { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--line-25); }
.mv-dlg-search input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--fg); font: inherit; font-size: 18px; padding: 8px 2px; }
.mv-dlg-search .ibtn { width: 34px; height: 34px; font-size: 17px; }
.mv-dlg-results { list-style: none; margin: 0; padding: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.mv-dlg-results li { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 6px; cursor: pointer; }
.mv-dlg-results li:hover { background: var(--hover); }
.mv-dlg-results li[aria-selected="true"] { background: var(--fg); color: var(--bg); }
.mv-dlg-results .mv-poster { width: 40px; }
.mv-dlg-results .mv-fallback { padding: 3px; }
.mv-dlg-results .mv-fallback-t { font-size: 8px; }
.mv-dlg-results .mv-fallback-y { display: none; }
.mv-dlg-ep { display: flex; gap: 16px; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.mv-dlg-ep input { width: 48px; margin-left: 6px; background: transparent; border: 0; border-bottom: 1px solid var(--line-25); color: var(--fg); font: inherit; }
.mv-dlg-err { margin: 0; font-family: var(--mono); font-size: 11px; color: var(--band-red); }
.mv-dlg-actions { display: flex; justify-content: flex-end; gap: 4px; }
.mv-dlg-actions .ibtn:disabled { opacity: .35; cursor: default; }

/* The pill rests at the bottom of the window, as on Seer Adversarial (styles.css .adv-pill). */
.main:has(.mv-pill) { display: flex; flex-direction: column; min-height: 100vh; box-sizing: border-box; padding-bottom: 0; }
.main:has(.mv-pill) > .mv { flex: 1 0 auto; display: flex; flex-direction: column; }
.main:has(.mv-pill) > .mv > .mv-content { flex: 1 0 auto; }
.mv-pill { position: sticky; bottom: 16px; z-index: 41; width: 100%; max-width: 760px; margin: 48px auto 0; }
.mv-pill .chatbar.chatbar-page { position: relative; left: auto; right: auto; bottom: auto; width: 100%; }
@media (max-width: 760px) {
  .mv-detail-grid { grid-template-columns: minmax(0, 1fr); }
  .mv-detail-art { max-width: 240px; }
  .mv-row { grid-template-columns: 60px minmax(0, 1fr) 32px 32px; }
  .mv-row > .mv-meter { display: none; }
  .mv-unm-row { grid-template-columns: minmax(0, 1fr) 40px; }
  .mv-unm-row > .mv-chip, .mv-unm-row > .mv-dim { display: none; }
  .mv-ftext { margin-left: 0; }
}
```
**Impact:** class names prefixed `mv-`; nothing existing changes. `repo-pulse` is the keyframe in `styles.css:77`.

### Step 9: Poster and grid tile
**File:** `web/src/components/movies/Poster.tsx` (new)
**Code:**
```tsx
import { useState } from 'react';

export interface PosterProps {
  url: string | null;
  title: string;
  year: number | null;
}

/**
 * A TMDB poster, hotlinked and lazy (posters are shared by both machines; nothing is cached on disk),
 * or a designed tile with the title when TMDB has none or the image fails to load. Key it by `url`
 * at the call site so a new URL gets a fresh try.
 */
export function Poster({ url, title, year }: PosterProps) {
  const [failed, setFailed] = useState(false);
  if (url === null || failed) {
    return (
      <div className="mv-poster mv-fallback" role="img" aria-label={`${title} (no poster)`}>
        <span className="mv-fallback-t">{title}</span>
        {year !== null && <span className="mv-fallback-y">{year}</span>}
      </div>
    );
  }
  return (
    <div className="mv-poster">
      <img src={url} alt={title} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </div>
  );
}
```
**File:** `web/src/components/movies/PosterTile.tsx` (new)
**Code:**
```tsx
import type { MouseEvent } from 'react';
import type { TitleListItem } from '../../moviesApi';
import { isGone, kindLabel, stateBadge, tileProgress } from '../../lib/movies';
import { moviesHref } from '../../lib/route';
import { Poster } from './Poster';

export interface PosterTileProps {
  title: TitleListItem;
  onOpen: (titleId: string) => void;
}

/** One poster: state chip, progress bar while in progress, caption below. A real link, so a middle click opens a tab. */
export function PosterTile({ title: t, onOpen }: PosterTileProps) {
  const gone = isGone(t);
  const badge = stateBadge(t.state);
  const progress = tileProgress(t);
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(t.id);
  };
  return (
    <a href={moviesHref({ title: t.id, unmatched: false })} className={gone ? 'mv-tile gone' : 'mv-tile'} data-title={t.id} onClick={open}>
      <span className="mv-art">
        <Poster key={t.poster_url ?? 'none'} url={t.poster_url} title={t.title} year={t.year} />
        {badge !== null && <span className={`mv-badge ${t.state}`}>{badge}</span>}
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
**Impact:** new components.

### Step 10: Grid with the filter row
**File:** `web/src/components/movies/MoviesGrid.tsx` (new)
**Code:**
```tsx
import { FilmSlate, MagnifyingGlass, SquaresFour, Television } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { TitleListItem } from '../../moviesApi';
import { KIND_FILTERS, matchesFilter, sortTitles, stateCounts, STATE_FILTERS, type KindFilter, type MoviesFilter } from '../../lib/movies';
import { PosterTile } from './PosterTile';

const KIND_ICON: Record<KindFilter, Icon> = { all: SquaresFour, movie: FilmSlate, tv: Television };

export interface MoviesGridProps {
  titles: TitleListItem[];
  filter: MoviesFilter;
  onFilter: (f: MoviesFilter) => void;
  onOpen: (titleId: string) => void;
}

/** The library: a filter row (state pills with counts, kind icons, a text filter), then one poster per title. */
export function MoviesGrid({ titles, filter, onFilter, onOpen }: MoviesGridProps) {
  const counts = stateCounts(titles, filter);
  const shown = sortTitles(titles.filter((t) => matchesFilter(t, filter)));
  return (
    <section className="mv-lib mv-content" aria-label="Library">
      <div className="mv-filter">
        <div className="mv-fstates" role="group" aria-label="State">
          {STATE_FILTERS.map((s) => (
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
              <PosterTile title={t} onOpen={onOpen} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```
**Impact:** new component.

### Step 11: Detail page pieces
**File:** `web/src/components/movies/Stars.tsx` (new)
**Code:**
```tsx
import { Star } from '@phosphor-icons/react';

export interface StarsProps {
  /** 0..5; null = never rated. */
  value: number | null;
  onRate: (value: number) => void;
}

/** Five duotone stars, lit up to the rating. Clicking the lit top star sets 0 (a real "0 of 5", not "unrated"). */
export function Stars({ value, onRate }: StarsProps) {
  return (
    <div className="mv-stars" role="group" aria-label={value === null ? 'Rating: not rated' : `Rating: ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => {
        const lit = value !== null && n <= value;
        const label = value === n ? `Rated ${n} of 5 (click for 0)` : `Rate ${n} of 5`;
        return (
          <button
            key={n}
            type="button"
            className={lit ? 'mv-star on' : 'mv-star'}
            data-tip={label}
            data-tip-side="below"
            aria-label={label}
            aria-pressed={lit}
            onClick={() => onRate(value === n ? 0 : n)}
          >
            <Star weight="duotone" />
          </button>
        );
      })}
      <span className="mv-stars-n">{value === null ? 'unrated' : `${value}/5`}</span>
    </div>
  );
}
```
**File:** `web/src/components/movies/ReviewField.tsx` (new)
**Code:**
```tsx
import { useEffect, useRef, useState } from 'react';
import { errorCode, saveTitleUser } from '../../moviesApi';

export interface ReviewFieldProps {
  titleId: string;
  /** The server's review text ('' when none). */
  saved: string;
  onSaved: () => void;
  onNotice: (text: string) => void;
}

/**
 * The review: one text field, saved when it loses focus and only when the text changed. Phase 4
 * stores it as a normal note linked to the title (search, revisions and /n come with it). A server
 * update never overwrites what the owner is typing.
 */
export function ReviewField({ titleId, saved, onSaved, onNotice }: ReviewFieldProps) {
  const [draft, setDraft] = useState(saved);
  const focused = useRef(false);
  const last = useRef(saved);

  useEffect(() => {
    last.current = saved;
    if (!focused.current) setDraft(saved);
  }, [saved]);

  const commit = async () => {
    focused.current = false;
    if (draft === last.current) return;
    const text = draft;
    try {
      await saveTitleUser(titleId, { review: text });
      last.current = text;
      onNotice('review saved');
    } catch (e) {
      onNotice(`could not save the review (${errorCode(e)})`);
    } finally {
      onSaved();
    }
  };

  return (
    <label className="mv-review">
      <span className="mv-label">Review</span>
      <textarea
        value={draft}
        rows={3}
        aria-label="Review"
        placeholder="What did you think? Saved as a note when you leave the field."
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
      />
    </label>
  );
}
```
**File:** `web/src/components/movies/parts.tsx` (new)
**Code:**
```tsx
import { CheckCircle, Desktop, Play, Trash } from '@phosphor-icons/react';
import type { FileView, PlayerState, ProgressView, WatchState } from '../../moviesApi';
import { dayText, filePlayLabel, meterRatio, meterText, sizeText, type PlayButtonState } from '../../lib/movies';

/** R5.3: a deleted file says so; a present file on the other laptop says where it is. */
export function FileFlags({ file }: { file: FileView }) {
  if (file.deleted) {
    return (
      <span className="mv-flag del" data-tip={file.deleted_at ? `Deleted ${dayText(file.deleted_at)}` : 'Deleted'}>
        <Trash weight="duotone" />
        deleted
      </span>
    );
  }
  if (!file.available) {
    return (
      <span className="mv-flag far" data-tip="On another machine">
        <Desktop weight="duotone" />
        on {file.host}
      </span>
    );
  }
  return null;
}

export function Meter({ state, progress }: { state: WatchState; progress: ProgressView }) {
  return (
    <span className="mv-meter">
      <span>{meterText(state, progress)}</span>
      <span className="mv-meter-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(meterRatio(state, progress) * 100)}%` }} />
      </span>
    </span>
  );
}

/** The per-file manual "watched" flag (covers skipping the credits at 95%). `what` names the row. */
export function WatchedButton({ file, what, onWatched }: { file: FileView; what: string; onWatched: (f: FileView) => void }) {
  const on = file.watched_at !== null;
  const label = on ? `${what} marked watched (click to unmark)` : `Mark ${what} watched`;
  return (
    <button type="button" className={on ? 'pbtn on' : 'pbtn hov'} data-tip={label} aria-label={label} aria-pressed={on} onClick={() => onWatched(file)}>
      <CheckCircle weight="duotone" />
    </button>
  );
}

export function PlayButton({ state, busy, onClick }: { state: PlayButtonState; busy: boolean; onClick: () => void }) {
  return (
    <button type="button" className="pbtn hov" data-tip={state.label} aria-label={state.label} disabled={state.disabled || busy} onClick={onClick}>
      <Play weight="duotone" />
    </button>
  );
}

export interface FileRowProps {
  file: FileView;
  player: PlayerState | null;
  busy: boolean;
  onPlay: (f: FileView) => void;
  onWatched: (f: FileView) => void;
}

/** One file of a film, or a series file with no season/episode: size, name with its flags, progress, watched, play. */
export function FileRow({ file: f, player, busy, onPlay, onWatched }: FileRowProps) {
  return (
    <li className={f.deleted ? 'mv-row del' : 'mv-row'} data-testid="movie-file" data-file-id={f.id} data-deleted={String(f.deleted)} data-state={f.state}>
      <span className="mv-code">{sizeText(f.size)}</span>
      <span className="mv-row-t">
        <span className="mv-row-name">{f.name}</span>
        <FileFlags file={f} />
      </span>
      <Meter state={f.state} progress={f.progress} />
      <WatchedButton file={f} what="this file" onWatched={onWatched} />
      <PlayButton state={filePlayLabel(f, player, 'this file')} busy={busy} onClick={() => onPlay(f)} />
    </li>
  );
}
```
**File:** `web/src/components/movies/EpisodeList.tsx` (new)
**Code:**
```tsx
import type { EpisodeView, FileView, PlayerState, TitleDetail } from '../../moviesApi';
import { episodeCode, filePlayLabel, primaryFile, seasonsShown, type PlayButtonState } from '../../lib/movies';
import { FileFlags, FileRow, Meter, PlayButton, WatchedButton } from './parts';

export interface EpisodeListProps {
  detail: TitleDetail;
  player: PlayerState | null;
  busy: boolean;
  onPlay: (f: FileView) => void;
  onWatched: (f: FileView) => void;
}

/** A series' seasons (those with a file on any machine), each episode with its progress and flags; then files with no episode. */
export function EpisodeList({ detail, player, busy, onPlay, onWatched }: EpisodeListProps) {
  const { seasons, hidden } = seasonsShown(detail);
  return (
    <section className="mv-sec" aria-label="Episodes">
      <h2 className="mv-h2">Episodes</h2>
      {seasons.map((s) => (
        <div key={s.season} className="mv-season">
          <h3 className="mv-season-h">{s.season === 0 ? 'Specials' : `Season ${s.season}`}</h3>
          <ol className="mv-eps">
            {s.episodes.map((e) => (
              <EpisodeItem key={e.episode} episode={e} player={player} busy={busy} onPlay={onPlay} onWatched={onWatched} />
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
  episode: EpisodeView;
  player: PlayerState | null;
  busy: boolean;
  onPlay: (f: FileView) => void;
  onWatched: (f: FileView) => void;
}

function EpisodeItem({ episode: e, player, busy, onPlay, onWatched }: EpisodeItemProps) {
  const code = episodeCode(e.season, e.episode);
  const file = primaryFile(e);
  const play: PlayButtonState = file !== null ? filePlayLabel(file, player, code) : { label: `${code} has no file`, disabled: true };
  const cls = !e.has_file ? 'mv-row none' : e.deleted ? 'mv-row del' : 'mv-row';
  return (
    <li
      className={cls}
      data-episode={code}
      data-testid="movie-file"
      data-file-id={file?.id}
      data-deleted={String(e.has_file && e.deleted)}
      data-state={e.state}
    >
      <span className="mv-code">{code}</span>
      <span className="mv-row-t">
        <span className="mv-row-name">{e.name ?? code}</span>
        {file !== null ? <FileFlags file={file} /> : <span className="mv-flag">no file</span>}
      </span>
      <Meter state={e.state} progress={e.progress} />
      {file !== null ? <WatchedButton file={file} what={code} onWatched={onWatched} /> : <span />}
      <PlayButton
        state={play}
        busy={busy}
        onClick={() => {
          if (file !== null) onPlay(file);
        }}
      />
    </li>
  );
}
```
**File:** `web/src/components/movies/MovieDetail.tsx` (new)
**Code:**
```tsx
import { useEffect, useState } from 'react';
import { CaretUp, CheckCircle, DotsThree, Play } from '@phosphor-icons/react';
import { continueTitle, errorCode, playFile, saveTitleUser, setFileWatched, type CastCredit, type FileView, type PlayerState, type TitleDetail } from '../../moviesApi';
import { CAST_LIMIT, clock, continueNotice, creditRows, kindLabel, playErrorText, playLabel, playPlan, releaseText, runtimeText, seasonsText, startedNotice, STATE_LABEL } from '../../lib/movies';
import { EpisodeList } from './EpisodeList';
import { FileRow } from './parts';
import { Poster } from './Poster';
import { ReviewField } from './ReviewField';
import { Stars } from './Stars';

export interface MovieDetailProps {
  detail: TitleDetail;
  player: PlayerState | null;
  /** Re-read the store after a write (the server's state wins). */
  onChanged: () => void;
  onNotice: (text: string) => void;
}

/**
 * One title (`/movies/<id>`), a film or a series: poster, facts (release date, runtime or seasons,
 * genres), the Play/Resume button, the watched flag, stars, synopsis, the review, credits (studios,
 * directors, writers, producers; creators for a series), the cast with character names, then the
 * film's files or the series' episodes, each with progress and its deleted / other-machine flag.
 */
export function MovieDetail({ detail: d, player, onChanged, onNotice }: MovieDetailProps) {
  const [watched, setWatched] = useState(d.watched);
  const [rating, setRating] = useState<number | null>(d.rating);
  const [busy, setBusy] = useState(false);
  useEffect(() => setWatched(d.watched), [d.watched]);
  useEffect(() => setRating(d.rating), [d.rating]);

  const plan = playPlan(d);
  const play = playLabel(plan, player);
  const current = player?.current ?? null;
  const live = current !== null && current.title_id === d.id ? current : null;

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      onNotice(await action());
    } catch (e) {
      onNotice(playErrorText(errorCode(e)));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const playOne = (f: FileView) => {
    void run(async () => {
      await playFile(f.id);
      return startedNotice(f);
    });
  };

  const start = () => {
    if (plan.kind === 'continue') void run(async () => continueNotice(await continueTitle(d.id)));
    else if (plan.kind === 'file') playOne(plan.file);
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
    d.genres.join(', '),
  ].filter((s) => s !== '');
  const credits = creditRows(d);

  return (
    <article className="mv-detail mv-content" aria-label={d.title} data-title={d.id}>
      {d.backdrop_url !== null && (
        <div className="mv-hero" aria-hidden="true">
          <img src={d.backdrop_url} alt="" loading="lazy" />
        </div>
      )}
      <div className="mv-detail-grid">
        <div className="mv-detail-art">
          <Poster key={d.poster_url ?? 'none'} url={d.poster_url} title={d.title} year={d.year} />
        </div>
        <div className="mv-detail-info">
          <p className="mv-facts">
            {facts.map((f, i) => (
              <span key={i}>{f}</span>
            ))}
            <span className="mv-chip">
              {kindLabel(d.kind)} · {STATE_LABEL[d.state]}
            </span>
          </p>
          <div className="mv-actions">
            <button type="button" className="ibtn on mv-play" data-tip={play.label} data-tip-side="below" aria-label={play.label} disabled={play.disabled || busy} onClick={start}>
              <Play weight="duotone" />
            </button>
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
            {live !== null && (
              <span className="mv-live">
                playing in VLC
                {` · ${clock(live.position)}`}
                {live.duration !== null ? ` / ${clock(live.duration)}` : ''}
              </span>
            )}
          </div>
          {d.overview !== '' && <p className="mv-overview">{d.overview}</p>}
          <ReviewField key={d.id} titleId={d.id} saved={d.review} onSaved={onChanged} onNotice={onNotice} />
          {credits.length > 0 && (
            <dl className="mv-credits" aria-label="Credits">
              {credits.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      <CastList cast={d.cast} />
      {d.kind === 'tv' ? (
        <EpisodeList detail={d} player={player} busy={busy} onPlay={playOne} onWatched={(f) => void toggleFileWatched(f)} />
      ) : (
        <section className="mv-sec" aria-label="Files">
          <h2 className="mv-h2">Files</h2>
          <ul className="mv-files">
            {d.files.map((f) => (
              <FileRow key={f.id} file={f} player={player} busy={busy} onPlay={playOne} onWatched={(x) => void toggleFileWatched(x)} />
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

/** The cast with their character names; the first CAST_LIMIT, then an icon to show the rest. */
function CastList({ cast }: { cast: CastCredit[] }) {
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
            <span className="mv-cast-n">{c.name}</span>
            {c.character !== null && c.character !== '' && <span className="mv-cast-c">{c.character}</span>}
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
**Impact:** new components. A series' big Play calls `POST /api/movies/continue`. A film's big Play and every row's
play icon call `POST /api/movies/files/:id/play`.

### Step 12: Unmatched list, assign dialog, pill, page
**File:** `web/src/components/movies/AssignDialog.tsx` (new)
**Code:**
```tsx
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, FilmSlate, MagnifyingGlass, Television, X } from '@phosphor-icons/react';
import { assignFile, errorCode, searchTmdb, type AssignBody, type TitleKind, type TmdbHitView, type UnmatchedFile } from '../../moviesApi';
import { Poster } from './Poster';

export interface AssignDialogProps {
  file: UnmatchedFile;
  onClose: () => void;
  /** The server took it: the title it went to (null when the answer did not say) and its name. */
  onAssigned: (titleId: string | null, name: string) => void;
}

function toInt(s: string): number | null {
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function guessKind(file: UnmatchedFile): TitleKind {
  const p = file.parsed;
  if (p === null) return 'movie';
  if (p.kind_hint !== null) return p.kind_hint;
  return p.season !== null || p.episode !== null ? 'tv' : 'movie';
}

/**
 * The manual fix (R5.5): search TMDB from the parser's guess, pick a result (a series also takes a
 * season and episode, prefilled from the guess), assign. Esc or the backdrop cancels; Esc never
 * reaches the page or the answer panel behind it.
 */
export function AssignDialog({ file, onClose, onAssigned }: AssignDialogProps) {
  const guess = file.parsed;
  const [q, setQ] = useState(guess !== null && guess.title !== '' ? guess.title : file.name);
  const [kind, setKind] = useState<TitleKind>(() => guessKind(file));
  const [results, setResults] = useState<TmdbHitView[] | null>(null);
  const [picked, setPicked] = useState<TmdbHitView | null>(null);
  const [season, setSeason] = useState(guess !== null && guess.season !== null ? String(guess.season) : '');
  const [episode, setEpisode] = useState(guess !== null && guess.episode !== null ? String(guess.episode) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const search = async (text: string, k: TitleKind) => {
    const query = text.trim();
    if (query === '') return;
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    setPicked(null);
    try {
      const found = await searchTmdb(query, k);
      if (mine === seq.current) setResults(found);
    } catch (e) {
      if (mine === seq.current) {
        setResults(null);
        const code = errorCode(e);
        setError(code === 'tmdb_off' ? 'TMDB credentials are not set on this machine' : `could not search TMDB (${code})`);
      }
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  };

  // The guess is searched at once; switching film / series searches the current text again.
  // Only the kind switch re-searches here; typing waits for Enter (the repo runs no hooks lint).
  useEffect(() => {
    void search(q, kind);
  }, [kind]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void search(q, kind);
  };

  const assign = async () => {
    if (picked === null) return;
    let body: AssignBody;
    if (picked.kind === 'tv') {
      const s = toInt(season);
      const ep = toInt(episode);
      body = s !== null && ep !== null ? { kind: 'tv', tmdb_id: picked.tmdb_id, season: s, episode: ep } : { kind: 'tv', tmdb_id: picked.tmdb_id };
    } else {
      body = { kind: 'movie', tmdb_id: picked.tmdb_id };
    }
    setBusy(true);
    setError(null);
    try {
      onAssigned(await assignFile(file.id, body), picked.title);
    } catch (e) {
      setError(`could not assign (${errorCode(e)})`);
      setBusy(false);
    }
  };

  return (
    <div className="mv-dlg" data-modal="assign" onClick={onClose}>
      <div className="mv-dlg-box" role="dialog" aria-modal="true" aria-label={`Assign a title to ${file.name}`} onClick={(e) => e.stopPropagation()}>
        <p className="mv-dlg-file">{file.path}</p>
        <form className="mv-dlg-search" onSubmit={submit}>
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search TMDB" placeholder="Title on TMDB" autoFocus />
          <button type="button" className={kind === 'movie' ? 'ibtn on' : 'ibtn hov'} data-tip="Films" data-tip-side="below" aria-label="Search films" aria-pressed={kind === 'movie'} onClick={() => setKind('movie')}>
            <FilmSlate weight="duotone" />
          </button>
          <button type="button" className={kind === 'tv' ? 'ibtn on' : 'ibtn hov'} data-tip="Series" data-tip-side="below" aria-label="Search series" aria-pressed={kind === 'tv'} onClick={() => setKind('tv')}>
            <Television weight="duotone" />
          </button>
          <button type="submit" className="ibtn hov" data-tip="Search TMDB" data-tip-side="below" aria-label="Search" disabled={busy}>
            <MagnifyingGlass weight="duotone" />
          </button>
        </form>
        {error !== null && (
          <p className="mv-dlg-err" role="alert">
            {error}
          </p>
        )}
        {results !== null && results.length === 0 && <p className="mv-dim">No TMDB match for {q.trim()}.</p>}
        {results !== null && results.length > 0 && (
          <ul className="mv-dlg-results" role="listbox" aria-label="TMDB results">
            {results.map((r) => {
              const on = picked !== null && picked.kind === r.kind && picked.tmdb_id === r.tmdb_id;
              return (
                <li key={`${r.kind}-${r.tmdb_id}`} role="option" aria-selected={on} onClick={() => setPicked(r)}>
                  <Poster key={r.poster_url ?? 'none'} url={r.poster_url} title={r.title} year={r.year} />
                  <span>{r.title}</span>
                  <span className="mv-dim">
                    {[r.year === null ? '' : String(r.year), r.in_library ? 'in library' : ''].filter((s) => s !== '').join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {picked !== null && picked.kind === 'tv' && (
          <div className="mv-dlg-ep">
            <label>
              season
              <input inputMode="numeric" value={season} aria-label="Season" onChange={(e) => setSeason(e.target.value)} />
            </label>
            <label>
              episode
              <input inputMode="numeric" value={episode} aria-label="Episode" onChange={(e) => setEpisode(e.target.value)} />
            </label>
          </div>
        )}
        <div className="mv-dlg-actions">
          <button type="button" className="ibtn hov" data-tip="Cancel" aria-label="Cancel" onClick={onClose}>
            <X weight="duotone" />
          </button>
          <button type="button" className="ibtn on" data-tip="Assign" aria-label="Assign" disabled={picked === null || busy} onClick={() => void assign()}>
            <Check weight="duotone" />
          </button>
        </div>
      </div>
    </div>
  );
}
```
Phase 4 sends season and episode together or not at all. A series assignment with either field blank sends neither,
and the server's mapping then applies.

**File:** `web/src/components/movies/UnmatchedList.tsx` (new)
**Code:**
```tsx
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { LinkSimple } from '@phosphor-icons/react';
import type { UnmatchedFile } from '../../moviesApi';
import { clock, moviesErrorText, reasonText } from '../../lib/movies';
import { AssignDialog } from './AssignDialog';

export interface UnmatchedListProps {
  files: UnmatchedFile[] | null;
  error: string | null;
  onAssigned: (titleId: string | null, name: string) => void;
}

/** `/movies/unmatched`: this machine's files that matched no title, each with its reason and an assign icon. */
export function UnmatchedList({ files, error, onAssigned }: UnmatchedListProps) {
  const [assigning, setAssigning] = useState<UnmatchedFile | null>(null);
  if (error !== null) return <p className="mv-empty mv-content">{moviesErrorText(error)}</p>;
  if (files === null) return <p className="mv-empty mv-content">loading unmatched files</p>;
  if (files.length === 0) return <p className="mv-empty mv-content">Every file on this machine matched a title.</p>;
  return (
    <section className="mv-content" aria-label="Unmatched files">
      <ul className="mv-unm">
        {files.map((f) => (
          <li key={f.id} className="mv-unm-row" data-file={f.id}>
            <span className="mv-unm-main">
              <span className="mv-unm-name">{f.name}</span>
              <span className="mv-unm-path">{f.path}</span>
            </span>
            <span className="mv-chip">{reasonText(f.reason, f.status)}</span>
            <span className="mv-dim">{f.duration_s !== null ? clock(f.duration_s) : ''}</span>
            <button type="button" className="ibtn hov" data-tip="Assign a title" data-tip-side="below" aria-label={`Assign a title to ${f.name}`} onClick={() => setAssigning(f)}>
              <LinkSimple weight="duotone" />
            </button>
          </li>
        ))}
      </ul>
      {assigning !== null &&
        createPortal(
          <AssignDialog
            file={assigning}
            onClose={() => setAssigning(null)}
            onAssigned={(id, name) => {
              setAssigning(null);
              onAssigned(id, name);
            }}
          />,
          document.body,
        )}
    </section>
  );
}
```
**File:** `web/src/components/movies/MoviesPill.tsx` (new)
**Code:**
```tsx
import { useState, type FormEvent } from 'react';
import { useChatImages } from '../../hooks/useChatImages';
import { MOVIES_PILL_PLACEHOLDER } from '../../lib/movies';
import { ChatBar } from '../ChatBar';

export interface MoviesPillProps {
  /** Sends one question through the wall's chat (App wraps it with the page context). */
  onAsk: (text: string, imageIds: string[]) => void;
}

/** "Ask about your movies": ChatBar's page variant with its own draft, as AdversaryPill. The answer shows in the wall's answer panel over the page. */
export function MoviesPill({ onAsk }: MoviesPillProps) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (images.blocked) return;
    const ids = images.readyIds;
    if (!draft.trim() && ids.length === 0) return;
    onAsk(draft, ids);
    setDraft('');
    images.clear();
  };
  return (
    <div className="mv-pill" data-testid="movies-pill">
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
        placeholder={MOVIES_PILL_PLACEHOLDER}
      />
    </div>
  );
}
```
**File:** `web/src/pages/MoviesPage.tsx` (new)
**Code:**
```tsx
import { useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowsClockwise, FilmSlate, Question } from '@phosphor-icons/react';
import { MovieDetail } from '../components/movies/MovieDetail';
import { MoviesGrid } from '../components/movies/MoviesGrid';
import { MoviesPill } from '../components/movies/MoviesPill';
import { UnmatchedList } from '../components/movies/UnmatchedList';
import { useNotice } from '../hooks/useNotice';
import type { MoviesStore } from '../hooks/useMovies';
import { errorCode, startSync } from '../moviesApi';
import { emptyLibraryText, isMoviesOff, MOVIES_OFF_TEXT, moviesErrorText, NO_MOVIES_FILTER, unmatchedCount, type MoviesFilter } from '../lib/movies';
import { NO_MOVIES_ROUTE, type MoviesRoute } from '../lib/route';
import '../components/movies/Movies.css';

export interface MoviesPageProps {
  store: MoviesStore;
  route: MoviesRoute;
  /** Push another movies URL (grid, a title, the unmatched list). */
  onRoute: (r: MoviesRoute) => void;
  onAsk: (text: string, imageIds: string[]) => void;
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
 *   .mv-tools   toolbar, icon-only: Back (on a title or the unmatched list), Unmatched files (with a count), Rescan
 *   content     grid / detail / unmatched list, or an empty state (subsystem off, empty library, error)
 *   pill        "Ask about your movies"
 * The filter lives here, so it survives opening a title and coming back.
 */
export function MoviesPage({ store, route, onRoute, onAsk }: MoviesPageProps) {
  const { notice, show } = useNotice(6000);
  const [filter, setFilter] = useState<MoviesFilter>(NO_MOVIES_FILTER);
  const [busy, setBusy] = useState(false);
  const off = isMoviesOff(store);
  const waiting = unmatchedCount(store.status);
  const unmatchedTip = waiting === null || waiting === 0 ? 'Unmatched files' : `Unmatched files (${waiting})`;

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
    else if (store.detail === null || store.detail.id !== route.title) content = <p className="mv-empty mv-content">loading</p>;
    else content = <MovieDetail detail={store.detail} player={store.player} onChanged={store.refresh} onNotice={show} />;
  } else if (store.listError !== null) content = <MoviesEmpty text={moviesErrorText(store.listError)} />;
  else if (store.titles === null) content = <p className="mv-empty mv-content">loading the library</p>;
  else if (store.titles.length === 0) content = <MoviesEmpty text={emptyLibraryText(store.status)} />;
  else content = <MoviesGrid titles={store.titles} filter={filter} onFilter={setFilter} onOpen={(id) => onRoute({ title: id, unmatched: false })} />;

  return (
    <section className="mv" aria-label="Movies">
      <div className="mv-tools">
        {notice && (
          <span className="mv-note" role="status">
            {notice}
          </span>
        )}
        {(route.title !== null || route.unmatched) && (
          <button type="button" className="ibtn hov" data-tip="Back to the library" data-tip-side="below" aria-label="Back to the library" onClick={() => onRoute(NO_MOVIES_ROUTE)}>
            <ArrowLeft weight="duotone" />
          </button>
        )}
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
      </div>
      {content}
      <MoviesPill onAsk={onAsk} />
    </section>
  );
}
```
**Impact:** the badge's digit sits inside the Unmatched button, so the button's accessible name is
`Unmatched files` plus the digit. Tests and journeys match it by name prefix (`/^Unmatched files/`), never by exact
name.

### Step 13: Rail, Sidebar and Header
**File:** `web/src/components/Rail.tsx` (whole file)
**Change:** a FilmSlate "Movies" icon between the mode icon and Projects; `BIN_TIP.movies`; `onToggleMovies`.
**Code:**
```tsx
import { ChatsCircle, FilmSlate, Images, NotePencil, SidebarSimple, SquaresFour, Sword, TextAa, Trash, TreeStructure, XCircle } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import type { Mode, View } from '../types';
import { MODE_TIP } from '../lib/filter';

export const MODE_ICON: Record<Mode, Icon> = { text: TextAa, images: Images, all: SquaresFour };

/** Tooltip / label of the Trash toggle, by the view it is pressed from. */
export const BIN_TIP: Record<View, string> = {
  wall: 'Recycle bin',
  bin: 'Back to the wall',
  history: 'Recycle bin',
  projects: 'Recycle bin',
  adversary: 'Recycle bin',
  movies: 'Recycle bin',
};

/** Tooltip / label of the chat-history toggle (phase 9). Pressed state says when it is open; a second press returns to the wall. */
export const HISTORY_TIP = 'Chat history';

/** Tooltip / label of the projects toggle (project-session-graph phase 10): the session graph, with the repo list in the sidebar. */
export const PROJECTS_TIP = 'Projects';

/** Tooltip / label of the Seer Adversarial toggle (seer-adversarial phase 6): Claude's twins of Seer's roster, with the roster in the sidebar. */
export const ADVERSARY_TIP = 'Seer Adversarial';

/** Tooltip / label of the movies toggle (movies-library phase 6): the poster grid of the film and series library. */
export const MOVIES_TIP = 'Movies';

export interface RailProps {
  mode: Mode;
  view: View;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleMovies: () => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleAdversary: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, view, active, onToggleSide, onAdd, onCycleMode, onToggleMovies, onToggleProjects, onToggleHistory, onToggleAdversary, onToggleBin, onToggleTag, onClear }: RailProps) {
  const ModeIcon = MODE_ICON[mode];
  return (
    <nav className="rail">
      <button type="button" className="ibtn hov" data-tip="Toggle sidebar (Alt+B)" data-tip-side="right" aria-label="Toggle sidebar" onClick={onToggleSide}>
        <SidebarSimple weight="duotone" />
      </button>
      <button type="button" className="ibtn hov" data-tip="New note" data-tip-side="right" aria-label="New note" onClick={onAdd}>
        <NotePencil weight="duotone" />
      </button>
      <button
        type="button"
        className={mode === 'text' ? 'ibtn' : 'ibtn on'}
        data-tip={`${MODE_TIP[mode]} (click to switch)`}
        data-tip-side="right"
        aria-label={`${MODE_TIP[mode]} (click to switch)`}
        onClick={onCycleMode}
      >
        <ModeIcon weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'movies' ? 'ibtn on' : 'ibtn hov'}
        data-tip={MOVIES_TIP}
        data-tip-side="right"
        aria-label={MOVIES_TIP}
        aria-pressed={view === 'movies'}
        onClick={onToggleMovies}
      >
        <FilmSlate weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'projects' ? 'ibtn on' : 'ibtn hov'}
        data-tip={PROJECTS_TIP}
        data-tip-side="right"
        aria-label={PROJECTS_TIP}
        aria-pressed={view === 'projects'}
        onClick={onToggleProjects}
      >
        <TreeStructure weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'history' ? 'ibtn on' : 'ibtn hov'}
        data-tip={HISTORY_TIP}
        data-tip-side="right"
        aria-label={HISTORY_TIP}
        aria-pressed={view === 'history'}
        onClick={onToggleHistory}
      >
        <ChatsCircle weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'adversary' ? 'ibtn on' : 'ibtn hov'}
        data-tip={ADVERSARY_TIP}
        data-tip-side="right"
        aria-label={ADVERSARY_TIP}
        aria-pressed={view === 'adversary'}
        onClick={onToggleAdversary}
      >
        <Sword weight="duotone" />
      </button>
      <button
        type="button"
        className={view === 'bin' ? 'ibtn on' : 'ibtn hov'}
        data-tip={BIN_TIP[view]}
        data-tip-side="right"
        aria-label={BIN_TIP[view]}
        aria-pressed={view === 'bin'}
        onClick={onToggleBin}
      >
        <Trash weight="duotone" />
      </button>
      <div className="rail-sep" />
      {active.map((t) => (
        <button key={t} type="button" className="rail-chip" data-tip="Remove filter" data-tip-side="right" onClick={() => onToggleTag(t)}>
          #{t}
        </button>
      ))}
      {active.length > 0 && (
        <button type="button" className="ibtn hov clear" data-tip="Clear filters" data-tip-side="right" aria-label="Clear filters" onClick={onClear}>
          <XCircle weight="duotone" />
        </button>
      )}
    </nav>
  );
}
```
**File:** `web/src/components/Sidebar.tsx` (whole file)
**Change:** the same FilmSlate button after the mode buttons, before Projects. On the movies view the sidebar keeps the
tag list, as it does on the history page.
**Code:**
```tsx
import { ChatsCircle, FilmSlate, Sword, TreeStructure } from '@phosphor-icons/react';
import type { Mode, ProjectSummary, TagCount, View } from '../types';
import type { AdversaryMethod } from '../adversaryApi';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { sortProjects } from '../lib/projects';
import { ADVERSARY_TIP, HISTORY_TIP, MODE_ICON, MOVIES_TIP, PROJECTS_TIP } from './Rail';
import { RosterList } from './adversary/RosterList';

export interface SidebarProps {
  mode: Mode;
  view: View;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleMovies: () => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleAdversary: () => void;
  onToggleTag: (tag: string) => void;
  /** Projects view: repos with sessions (null while loading). */
  projects?: ProjectSummary[] | null;
  /** Projects view: the repo shown. */
  repo?: string | null;
  onPickRepo?: (repo: string) => void;
  /** Adversary view: Seer's roster (null while loading). */
  roster?: AdversaryMethod[] | null;
  /** Adversary view: the method shown; null = Overview. */
  strategy?: string | null;
  onPickStrategy?: (strategyId: string | null) => void;
}

export function Sidebar({
  mode,
  view,
  tags,
  active,
  onMode,
  onToggleMovies,
  onToggleProjects,
  onToggleHistory,
  onToggleAdversary,
  onToggleTag,
  projects = null,
  repo = null,
  onPickRepo,
  roster = null,
  strategy = null,
  onPickStrategy,
}: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const inProjects = view === 'projects';
  const inAdversary = view === 'adversary';
  const inMovies = view === 'movies';
  return (
    <aside className="side">
      <div className="side-modes">
        {MODE_ORDER.map((m) => {
          const I = MODE_ICON[m];
          return (
            <button
              key={m}
              type="button"
              className={view === 'wall' && m === mode ? 'ibtn on' : 'ibtn'}
              data-tip={MODE_TIP[m]}
              data-tip-side="below"
              aria-label={MODE_TIP[m]}
              onClick={() => onMode(m)}
            >
              <I weight="duotone" />
            </button>
          );
        })}
        <button
          type="button"
          className={inMovies ? 'ibtn on' : 'ibtn'}
          data-tip={MOVIES_TIP}
          data-tip-side="below"
          aria-label={MOVIES_TIP}
          aria-pressed={inMovies}
          onClick={onToggleMovies}
        >
          <FilmSlate weight="duotone" />
        </button>
        <button
          type="button"
          className={inProjects ? 'ibtn on' : 'ibtn'}
          data-tip={PROJECTS_TIP}
          data-tip-side="below"
          aria-label={PROJECTS_TIP}
          aria-pressed={inProjects}
          onClick={onToggleProjects}
        >
          <TreeStructure weight="duotone" />
        </button>
        <button
          type="button"
          className={view === 'history' ? 'ibtn on' : 'ibtn'}
          data-tip={HISTORY_TIP}
          data-tip-side="below"
          aria-label={HISTORY_TIP}
          aria-pressed={view === 'history'}
          onClick={onToggleHistory}
        >
          <ChatsCircle weight="duotone" />
        </button>
        <button
          type="button"
          className={inAdversary ? 'ibtn on' : 'ibtn'}
          data-tip={ADVERSARY_TIP}
          data-tip-side="below"
          aria-label={ADVERSARY_TIP}
          aria-pressed={inAdversary}
          onClick={onToggleAdversary}
        >
          <Sword weight="duotone" />
        </button>
      </div>
      <div className="side-sep" />
      {inAdversary ? (
        <RosterList roster={roster} strategy={strategy} onPick={(id) => onPickStrategy?.(id)} />
      ) : inProjects ? (
        <div className="side-repos" role="list" aria-label="Projects">
          {projects === null ? (
            <span className="side-note">loading</span>
          ) : projects.length === 0 ? (
            <span className="side-note">no sessions yet</span>
          ) : (
            sortProjects(projects).map((p) => (
              <div
                key={p.repo}
                role="listitem"
                data-repo={p.repo}
                className={p.repo === repo ? 'tagrow on' : 'tagrow'}
                aria-current={p.repo === repo ? 'true' : undefined}
                onClick={() => onPickRepo?.(p.repo)}
              >
                <span className="repo-name">
                  {p.live > 0 && <span className="repo-live" data-tip={`${p.live} running`} aria-label={`${p.live} running`} />}
                  {p.repo}
                </span>
                <span className="n">{p.sessions}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="side-tags">
          {sorted.map((t) => (
            <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
              <span>#{t.tag}</span>
              <span className="n">{t.count}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
```
**File:** `web/src/components/Header.tsx` (whole file)
**Code:**
```tsx
import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';
import { HISTORY_HINT } from '../lib/timeline';
import { PROJECTS_HINT } from '../lib/projects';
import { ADVERSARY_HINT } from '../lib/adversary';
import { MOVIES_HINT } from '../lib/movies';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  /** The recycle bin is showing: no "Last edited" link, and the hint explains the bin. */
  bin?: boolean;
  /** The chat history page is showing (phase 9): no "Last edited" link, and the hint explains the page. */
  history?: boolean;
  /** The projects view is showing (project-session-graph phase 10): no "Last edited" link, and the hint explains the graph. */
  projects?: boolean;
  /** Seer Adversarial is showing (seer-adversarial phase 6): no "Last edited" link, and the hint explains the twins. */
  adversary?: boolean;
  /** The movies library is showing (movies-library phase 6): no "Last edited" link, and the hint says where posters and Play come from. */
  movies?: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

const WALL_HINT = 'Drop or paste an image anywhere to make a photo note.';
const BIN_HINT = 'Restore brings a note or an image back. Delete forever removes it and its files.';

export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, history = false, projects = false, adversary = false, movies = false, onJumpLast, onAdd }: HeaderProps) {
  const hint = bin ? BIN_HINT : history ? HISTORY_HINT : projects ? PROJECTS_HINT : adversary ? ADVERSARY_HINT : movies ? MOVIES_HINT : WALL_HINT;
  const page = bin || history || projects || adversary || movies;
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {!page && last && (
          <>
            {' '}Last edited{' '}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onJumpLast();
              }}
            >
              {last.id}
            </a>{' '}
            {lastWhen}.
          </>
        )}{' '}
        {hint}
      </p>
      <h1>{heading}</h1>
      {showSticker && (
        <button type="button" className="sticker" data-tip="New note" aria-label="New note" onClick={onAdd}>
          <Plus weight="duotone" />
        </button>
      )}
    </header>
  );
}
```
**Impact:** `Rail`/`Sidebar` gain a required prop. Step 14 updates `App.tsx` and Step 16 updates `Rail.test.tsx`; both
are the only render sites (`grep -rln "<Rail\|<Sidebar" web/src`). The existing order tests still hold: Projects is
right above Chat history, Chat history right above Seer Adversarial, and Seer Adversarial right above the bin.

### Step 14: App wiring
**File:** `web/src/App.tsx`. Thirteen exact replacements; line numbers are today's.

**14a, line 19 (route import):**
```tsx
import { adversaryRouteFromLocation, hrefForView, moviesRouteFromLocation, NO_ADVERSARY_ROUTE, NO_MOVIES_ROUTE, NO_PROJECT_ROUTE, projectsHref, projectsRouteFromLocation, routeFromLocation, type AdversaryRoute, type MoviesRoute, type ProjectsRoute } from './lib/route';
```
**14b, after line 22 (`import { adversaryChatMessage, ... } from './lib/adversary';`), insert:**
```tsx
import { MoviesPage } from './pages/MoviesPage';
import { useMovies } from './hooks/useMovies';
import { moviesChatMessage, moviesCountLine, moviesHeading } from './lib/movies';
```
**14c, lines 81-87 (the initial view), replace with:**
```tsx
  // `/history[?thread=ID]` opens straight into the chat history page, `/projects[?repo=&node=]`
  // into the session graph, `/adversary[/<id>]` into Seer Adversarial, `/movies[/<id>|/unmatched]`
  // into the movies library (all served by the SPA fallback).
  const [view, setView] = useState<View>(() => {
    if (routeFromLocation(window.location).history) return 'history';
    if (projectsRouteFromLocation(window.location) !== null) return 'projects';
    if (moviesRouteFromLocation(window.location) !== null) return 'movies';
    return adversaryRouteFromLocation(window.location) !== null ? 'adversary' : 'wall';
  });
```
**14d, after line 90 (`const [adversaryRoute, setAdversaryRoute] = ...;`), insert:**
```tsx
  const [moviesRoute, setMoviesRoute] = useState<MoviesRoute>(() => moviesRouteFromLocation(window.location) ?? NO_MOVIES_ROUTE);
```
**14e, after line 92 (`const adversary = useAdversary(view === 'adversary', adversaryRoute.strategy);`), insert:**
```tsx
  // Fetches only while the movies view is shown: the library, status and player, plus the title or unmatched list shown.
  const movies = useMovies(view === 'movies', moviesRoute);
```
**14f, after line 359 (`const toggleAdversaryFocus = ...;`), insert:**
```tsx
  /** Rail / sidebar film-slate icon: open the movies grid (always the grid, wherever the page was left); a second press returns to the wall. */
  const toggleMovies = useCallback(() => {
    const opening = wallRef.current.view !== 'movies';
    setView(opening ? 'movies' : 'wall');
    if (opening) setMoviesRoute(NO_MOVIES_ROUTE);
  }, []);
```
**14g, after line 368 (the end of `askAdversary`), insert:**
```tsx
  /** The movies pill: the wall chat, with the page and the open title named on the first line (lib/movies moviesChatMessage). */
  const moviesDetail = movies.detail;
  const askMovies = useCallback(
    (text: string, imageIds: string[]) => {
      void askChat(moviesChatMessage(text, moviesRoute, moviesDetail), imageIds);
    },
    [askChat, moviesRoute, moviesDetail],
  );
```
**14h, lines 423-426 (URL sync), replace with:**
```tsx
  useEffect(() => {
    const href = hrefForView(view, historyThread, window.location, projectsRoute, adversaryRoute, moviesRoute);
    if (href !== null) window.history.pushState(null, '', href);
  }, [view, historyThread, projectsRoute, adversaryRoute, moviesRoute]);
```
**14i, lines 430-444 (popstate), replace with:**
```tsx
  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation(window.location);
      const p = projectsRouteFromLocation(window.location);
      const a = adversaryRouteFromLocation(window.location);
      const m = moviesRouteFromLocation(window.location);
      setHistoryThread(r.thread);
      if (p !== null) setProjectsRoute(p);
      if (a !== null) setAdversaryRoute(a);
      if (m !== null) setMoviesRoute(m);
      setView((v) =>
        r.history
          ? 'history'
          : p !== null
            ? 'projects'
            : a !== null
              ? 'adversary'
              : m !== null
                ? 'movies'
                : v === 'history' || v === 'projects' || v === 'adversary' || v === 'movies'
                  ? 'wall'
                  : v,
      );
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
```
**14j, the `<Rail ... />` element (lines 816-832): add one prop after `onCycleMode={...}`:**
```tsx
                onToggleMovies={toggleMovies}
```
**14k, the `<Sidebar ... />` element (lines 835-851): add one prop after `onMode={pickMode}`:**
```tsx
                onToggleMovies={toggleMovies}
```
**14l, the `<Header ... />` element (lines 856-888), replace the `heading`, `countLine` props and add `movies`:**
```tsx
                  <Header
                    heading={
                      view === 'movies'
                        ? moviesHeading(movies, moviesRoute)
                        : view === 'adversary'
                          ? adversaryHeading(adversary, adversaryRoute.strategy)
                          : view === 'projects'
                            ? projectHeading(projectRepo)
                            : view === 'history'
                              ? HISTORY_HEADING
                              : view === 'bin'
                                ? BIN_HEADING
                                : headingFor(mode, active)
                    }
                    countLine={
                      view === 'movies'
                        ? moviesCountLine(movies, moviesRoute)
                        : view === 'adversary'
                          ? adversaryCountLine(adversary, adversaryRoute.strategy, now)
                          : view === 'projects'
                            ? projectsCountLine(projectsStore.projects, projectRepo)
                            : view === 'history'
                              ? historyCountLine(history.items, history.hasMore)
                              : view === 'bin'
                                ? binCountLine(binStore.bin, active)
                                : countLineFor(mode, active, notes, visible, photos)
                    }
                    last={last}
                    lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
                    showSticker={view === 'wall' && mode !== 'images'}
                    bin={view === 'bin'}
                    history={view === 'history'}
                    projects={view === 'projects'}
                    adversary={view === 'adversary'}
                    movies={view === 'movies'}
                    onJumpLast={() => last && jump(last.id)}
                    onAdd={() => void addNote()}
                  />
```
**14m, line 892 (`{view === 'adversary' ? (`), replace that one line with:**
```tsx
              {view === 'movies' ? (
                <MoviesPage store={movies} route={moviesRoute} onRoute={setMoviesRoute} onAsk={askMovies} />
              ) : view === 'adversary' ? (
```
**14n, line 955 (the wall chat bar's guard), replace with:**
```tsx
            {view !== 'history' && view !== 'projects' && view !== 'adversary' && view !== 'movies' && (
```
The `AnswerPanel` guard at line 936 (`chat.open && view !== 'history' && view !== 'projects'`) stays as it is, so the
answer panel shows over the movies page (R5.4). Esc closes an unpinned answer there, as on the adversary page; the
assign dialog swallows its own Esc (Step 12).
**Impact:** `App` now has thirteen insertion points. 14m keeps the existing `: view === 'projects' ? (...)` chain
after it unchanged.

### Step 15: Tests
**File:** `web/src/lib/movies.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { makeFile, MOVIE, PLAYER_IDLE, SERIES, STATUS, TITLES } from '../testing/movieFixtures';
import {
  clock,
  continueNotice,
  creditRows,
  emptyLibraryText,
  filePlayLabel,
  matchesFilter,
  moviesChatMessage,
  moviesCountLine,
  NO_MOVIES_FILTER,
  playLabel,
  playPlan,
  reasonText,
  releaseText,
  seasonsShown,
  sortTitles,
  stateCounts,
  type MoviesFilter,
  type MoviesView,
} from './movies';

const ids = (f: MoviesFilter) => TITLES.filter((t) => matchesFilter(t, f)).map((t) => t.id);

describe('moviesChatMessage', () => {
  it('names the page, and the open title once its detail is loaded', () => {
    expect(moviesChatMessage('what next?', { title: null, unmatched: false }, null)).toBe('[Movies · library]\nwhat next?');
    expect(moviesChatMessage('why?', { title: null, unmatched: true }, null)).toBe('[Movies · unmatched files]\nwhy?');
    expect(moviesChatMessage('cast?', { title: 'movie-467905', unmatched: false }, MOVIE)).toBe('[Movies · How to Make a Killing (2026) · movie-467905]\ncast?');
    expect(moviesChatMessage('cast?', { title: 'movie-467905', unmatched: false }, SERIES)).toBe('[Movies · movie-467905]\ncast?');
  });
});

describe('grid order and filter', () => {
  it('puts in-progress titles first (newest play first) and titles with no file left last', () => {
    expect(sortTitles(TITLES).map((t) => t.id)).toEqual(['movie-467905', 'tv-247718', 'movie-9001']);
  });

  it('filters by state, kind and text, and counts each state under the other filters', () => {
    expect(ids({ ...NO_MOVIES_FILTER, state: 'gone' })).toEqual(['movie-9001']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'in_progress' })).toEqual(['tv-247718', 'movie-467905']);
    expect(ids({ ...NO_MOVIES_FILTER, state: 'unwatched' })).toEqual([]);
    expect(ids({ ...NO_MOVIES_FILTER, kind: 'tv' })).toEqual(['tv-247718']);
    expect(ids({ ...NO_MOVIES_FILTER, text: 'KILL' })).toEqual(['movie-467905']);
    expect(stateCounts(TITLES, NO_MOVIES_FILTER)).toEqual({ all: 3, unwatched: 0, in_progress: 2, finished: 0, gone: 1 });
    expect(stateCounts(TITLES, { ...NO_MOVIES_FILTER, kind: 'movie' })).toEqual({ all: 2, unwatched: 0, in_progress: 1, finished: 0, gone: 1 });
  });
});

describe('play plans', () => {
  it('a film resumes its file here; another machine or no file disables Play with the reason', () => {
    expect(playPlan(MOVIE)).toEqual({ kind: 'file', file: MOVIE.files[0] });
    expect(playLabel(playPlan(MOVIE), PLAYER_IDLE)).toEqual({ label: 'Resume at 45:00', disabled: false });
    expect(playLabel(playPlan(MOVIE), { available: false, reason: null, current: null })).toEqual({ label: 'VLC is not available on this machine', disabled: true });
    const elsewhere = { ...MOVIE, files: [makeFile(12, { host: 'gpd', available: false, unavailable_reason: 'not_on_this_machine' })] };
    expect(playLabel(playPlan(elsewhere), PLAYER_IDLE)).toEqual({ label: 'On gpd: play it on that machine', disabled: true });
    const gone = { ...MOVIE, files: [makeFile(13, { deleted: true, deleted_at: '2026-11-01T00:00:00.000Z', available: false, unavailable_reason: 'deleted' })] };
    expect(playPlan(gone)).toEqual({ kind: 'none' });
  });

  it('a series continues; each row says why it cannot play', () => {
    expect(playPlan(SERIES)).toEqual({ kind: 'continue' });
    const [e1, e2, e3] = SERIES.files;
    expect(filePlayLabel(e1!, PLAYER_IDLE, 'S01E01')).toEqual({ label: 'S01E01 is deleted', disabled: true });
    expect(filePlayLabel(e2!, PLAYER_IDLE, 'S01E02')).toEqual({ label: 'Resume S01E02 at 20:00', disabled: false });
    expect(filePlayLabel(e3!, PLAYER_IDLE, 'S01E03')).toEqual({ label: 'S01E03 is on gpd', disabled: true });
  });

  it('says what continue did', () => {
    const title = { id: 'tv-247718', title: 'MobLand', kind: 'tv' as const, year: 2025 };
    const ep = (season: number, episode: number, file_id: number | null = null) => ({ file_id, season, episode, absolute_episode: null, name: null });
    expect(continueNotice({ action: 'resumed', title, file: ep(1, 2, 22), position: 1200, play: {} })).toBe('resuming S01E02 at 20:00');
    expect(continueNotice({ action: 'missing', title, missing: ep(1, 5), present: [ep(1, 6, 26), ep(1, 7, 27)] })).toBe('S01E05 is not on this machine; S01E06, S01E07 are');
    expect(continueNotice({ action: 'nothing', title, reason: 'caught_up', finished_at: null, last: null })).toBe('caught up: nothing after the last episode');
    expect(continueNotice({ action: 'no_match', query: 'x' })).toBe('nothing to continue');
  });
});

describe('detail text', () => {
  it('lists studios and crew; seasons with no file are counted, not shown', () => {
    expect(creditRows(MOVIE)).toEqual([
      ['Studios', 'Blumhouse Productions'],
      ['Directed by', 'Ava Director'],
      ['Written by', 'Ava Director'],
      ['Produced by', 'Pat Producer'],
    ]);
    expect(creditRows(SERIES)).toEqual([['Created by', 'Ronan Creator']]);
    const shown = seasonsShown(SERIES);
    expect(shown.seasons.map((s) => s.season)).toEqual([1]);
    expect(shown.hidden).toBe(1);
  });

  it('formats times, dates and reasons', () => {
    expect(clock(2700)).toBe('45:00');
    expect(clock(7385)).toBe('2:03:05');
    expect(releaseText('2026-02-20')).toBe('Feb 20, 2026');
    expect(reasonText('too_short', 'unmatched')).toBe('shorter than 15 minutes');
    expect(reasonText(null, 'pending')).toBe('waiting for the next scan');
  });

  it('count lines and empty states', () => {
    const base: MoviesView = { titles: TITLES, listError: null, detail: null, detailError: null, unmatched: null, unmatchedError: null, status: STATUS };
    expect(moviesCountLine(base, { title: null, unmatched: false })).toBe('3 titles: 2 films, 1 series. 2 in progress.');
    expect(moviesCountLine({ ...base, detail: MOVIE }, { title: 'movie-467905', unmatched: false })).toBe('2026 · film · 1h 52m · in progress.');
    expect(moviesCountLine({ ...base, listError: 'movies_off' }, { title: null, unmatched: false })).toBe('Movies are off on this daemon.');
    expect(emptyLibraryText({ ...STATUS, roots: [] })).toContain('NOTESD_MOVIES_ROOTS');
    expect(emptyLibraryText(STATUS)).toContain('/lib');
  });
});
```
**File:** `web/src/hooks/useMovies.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MOVIE, PLAYER_IDLE, PLAYING, STATUS, TITLES, UNMATCHED } from '../testing/movieFixtures';
import type { PlayerState } from '../moviesApi';
import { NO_MOVIES_ROUTE } from '../lib/route';
import { PLAY_POLL_MS, useMovies } from './useMovies';

class FakeES {
  static all: FakeES[] = [];
  closed = false;
  private l = new Map<string, Array<(e?: unknown) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data: '{"op":"sync","title_id":null,"file_id":null}' });
  }
}

let calls: string[];
let players: PlayerState[];
let off: boolean;
/** A plain object, not a `Response`: its body resolves in microtasks only, so the fake-timer test can flush it. */
const json = (v: unknown, status = 200) => ({ ok: status < 400, status, statusText: '', json: async () => v }) as unknown as Response;
const count = (c: string) => calls.filter((x) => x === c).length;
/** Under fake timers: run due timers and let every fetch -> json -> setState chain settle. */
const flush = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

beforeEach(() => {
  calls = [];
  players = [PLAYER_IDLE];
  off = false;
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (off) return json({ error: 'movies_off', message: 'off' }, 503);
      if (url === '/api/movies') return json({ titles: TITLES });
      if (url === '/api/movies/status') return json(STATUS);
      if (url === '/api/movies/player') return json(players.length > 1 ? players.shift() : players[0]);
      if (url === '/api/movies/unmatched') return json({ files: UNMATCHED });
      if (url === '/api/movies/movie-467905') return json(MOVIE);
      return json({ error: 'not_found' }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  FakeES.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useMovies', () => {
  it('fetches nothing while disabled', async () => {
    renderHook(() => useMovies(false, NO_MOVIES_ROUTE));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
    expect(FakeES.all).toHaveLength(0);
  });

  it('loads the library, status and player; the title or unmatched list only when the route asks', async () => {
    const { result, rerender } = renderHook(({ title, unmatched }) => useMovies(true, { title, unmatched }), {
      initialProps: { title: null as string | null, unmatched: false },
    });
    await waitFor(() => expect(result.current.titles).toHaveLength(3));
    await waitFor(() => expect(result.current.status?.counts.unmatched_here).toBe(2));
    await waitFor(() => expect(result.current.player?.available).toBe(true));
    expect(count('GET /api/movies/unmatched')).toBe(0);
    rerender({ title: 'movie-467905', unmatched: false });
    await waitFor(() => expect(result.current.detail?.id).toBe('movie-467905'));
    rerender({ title: null, unmatched: true });
    await waitFor(() => expect(result.current.unmatched).toHaveLength(2));
    expect(result.current.detail).toBeNull();
  });

  it('refetches when /api/movies/events says changed, and closes the stream when the page closes', async () => {
    const { result, rerender } = renderHook(({ on }) => useMovies(on, NO_MOVIES_ROUTE), { initialProps: { on: true } });
    await waitFor(() => expect(result.current.titles).toHaveLength(3));
    const es = FakeES.all.find((e) => e.url === '/api/movies/events');
    expect(es).toBeDefined();
    act(() => es!.emit('changed'));
    await waitFor(() => expect(count('GET /api/movies')).toBe(2));
    rerender({ on: false });
    expect(es!.closed).toBe(true);
  });

  it('reports movies_off from a 503', async () => {
    off = true;
    const { result } = renderHook(() => useMovies(true, NO_MOVIES_ROUTE));
    await waitFor(() => expect(result.current.listError).toBe('movies_off'));
    expect(result.current.titles).toBeNull();
  });

  it('polls the player and the open title every 5 s while a play is active, then refreshes everything once', async () => {
    vi.useFakeTimers();
    players = [PLAYING, PLAYING, PLAYER_IDLE];
    renderHook(() => useMovies(true, { title: 'movie-467905', unmatched: false }));
    await flush(0);
    expect(count('GET /api/movies/player')).toBe(1);
    expect(count('GET /api/movies')).toBe(1);
    expect(count('GET /api/movies/movie-467905')).toBe(1);
    await flush(PLAY_POLL_MS);
    expect(count('GET /api/movies/player')).toBe(2);
    expect(count('GET /api/movies/movie-467905')).toBe(2);
    expect(count('GET /api/movies')).toBe(1);
    await flush(PLAY_POLL_MS);
    // The third read says idle: the play ended, so the library is read once more.
    expect(count('GET /api/movies')).toBe(2);
    const players3 = count('GET /api/movies/player');
    await flush(PLAY_POLL_MS * 3);
    expect(count('GET /api/movies/player')).toBe(players3);
  });
});
```
**File:** `web/src/components/movies/Poster.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Poster } from './Poster';

afterEach(cleanup);

describe('Poster', () => {
  it('hotlinks the poster lazily and falls back to a title tile when it fails to load', () => {
    render(<Poster url="https://image.tmdb.org/t/p/w342/x.jpg" title="Oldboy" year={2003} />);
    const img = screen.getByRole('img', { name: 'Oldboy' });
    expect(img.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/x.jpg');
    expect(img.getAttribute('loading')).toBe('lazy');
    fireEvent.error(img);
    expect(screen.getByRole('img', { name: 'Oldboy (no poster)' }).textContent).toBe('Oldboy2003');
  });

  it('shows the title tile when TMDB has no poster', () => {
    render(<Poster url={null} title="Pak Bernard" year={null} />);
    expect(screen.getByRole('img', { name: 'Pak Bernard (no poster)' }).textContent).toBe('Pak Bernard');
  });
});
```
**File:** `web/src/App.movies.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note } from './types';
import type { TitleListItem } from './moviesApi';
import { makeNote } from './testing/fixtures';
import { MOVIE, PLAYER_IDLE, SEARCH, SERIES, STATUS, TITLES, UNMATCHED } from './testing/movieFixtures';
import { MOVIES_OFF_TEXT } from './lib/movies';
import { App } from './App';

const notes: Note[] = [makeNote('A-B32', 'buy fennel #kitchen', { created: new Date().toISOString() })];
const CHAT_SSE =
  'event: delta\ndata: {"text":"Watch MobLand next."}\n\n' +
  'event: done\ndata: {"thread_id":"T-1","user_message_id":"Q001","assistant_message_id":"A001","reply_to":null,"brain":"claude"}\n\n';

let calls: string[];
let posts: { url: string; body: Record<string, unknown> | null }[];
let off: boolean;
let titles: TitleListItem[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  posts = [];
  off = false;
  titles = TITLES;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'POST') posts.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (method === 'POST' && url === '/api/chat') return new Response(CHAT_SSE, { headers: { 'content-type': 'text/event-stream' } });
      if (url.startsWith('/api/movies') && off) return json({ error: 'movies_off', message: 'off' }, 503);
      if (url === '/api/movies') return json({ titles });
      if (url === '/api/movies/status') return json(STATUS);
      if (url === '/api/movies/player') return json(PLAYER_IDLE);
      if (url === '/api/movies/unmatched') return json({ files: UNMATCHED });
      if (url.startsWith('/api/movies/search-tmdb?')) return json({ results: SEARCH });
      if (url === '/api/movies/movie-467905') return json(MOVIE);
      if (url === '/api/movies/tv-247718') return json(SERIES);
      if (method === 'POST' && url === '/api/movies/files/32/assign') return json({ file_id: 32, title: { ...MOVIE, id: 'movie-1125510', title: 'Ne Zha 2' } });
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
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
const tiles = () => within(screen.getByRole('list', { name: 'Posters' })).getAllByRole('listitem');
const postsTo = (url: string) => posts.filter((p) => p.url === url).map((p) => p.body);

describe('App: Movies', () => {
  it('R5.1: the film-slate icon opens /movies with one poster per title; a second press returns to the wall', async () => {
    render(<App />);
    expect(calls.some((c) => c.includes('/api/movies'))).toBe(false);
    fireEvent.click(within(rail()).getByRole('button', { name: 'Movies' }));
    await waitFor(() => expect(where()).toBe('/movies'));
    expect(h1()).toBe('Movies.');
    await screen.findByRole('list', { name: 'Posters' });
    expect(tiles().map((t) => t.querySelector('a')?.getAttribute('data-title'))).toEqual(['movie-467905', 'tv-247718', 'movie-9001']);
    const poster = screen.getByRole('img', { name: 'How to Make a Killing' });
    expect(poster.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w342/kill.jpg');
    expect(poster.getAttribute('loading')).toBe('lazy');
    expect(screen.getByRole('img', { name: 'MobLand (no poster)' })).toBeTruthy();
    expect(document.querySelector('.mv-tile.gone')?.getAttribute('data-title')).toBe('movie-9001');
    await screen.findByText(/3 titles: 2 films, 1 series\. 2 in progress\./);
    // The page's own pill replaces the wall chat bar.
    expect(screen.getByPlaceholderText('Ask about your movies')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Ask about your notes')).toBeNull();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Movies' }));
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('the filter row narrows the grid by state, kind and text', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('button', { name: /^gone/ }));
    expect(tiles()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^all/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Series' }));
    expect(tiles().map((t) => t.textContent)).toEqual([expect.stringContaining('MobLand')]);
    fireEvent.click(screen.getByRole('button', { name: 'All kinds' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'killing' } });
    expect(tiles()).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter titles' }), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches this filter.')).toBeTruthy();
  });

  it('R5.2: a poster opens the detail with date, synopsis, studios, crew, cast, play, watched, stars and review', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('link', { name: /How to Make a Killing/ }));
    await waitFor(() => expect(where()).toBe('/movies/movie-467905'));
    const article = await screen.findByRole('article', { name: 'How to Make a Killing' });
    expect(h1()).toBe('How to Make a Killing.');
    const a = within(article);
    expect(a.getByText('Released Feb 20, 2026')).toBeTruthy();
    expect(a.getByText('A disinherited heir plots his way back into the family fortune.')).toBeTruthy();
    const credits = within(article.querySelector('dl.mv-credits') as HTMLElement);
    expect(credits.getByText('Blumhouse Productions')).toBeTruthy();
    expect(credits.getAllByText('Ava Director')).toHaveLength(2);
    expect(credits.getByText('Pat Producer')).toBeTruthy();
    const cast = within(a.getByRole('region', { name: 'Cast' }));
    expect(cast.getByText('Glen Example')).toBeTruthy();
    expect(cast.getByText('Becket')).toBeTruthy();
    expect((a.getByRole('button', { name: 'Resume at 45:00' }) as HTMLButtonElement).disabled).toBe(false);
    expect(a.getByRole('button', { name: 'Mark as watched' })).toBeTruthy();
    expect(a.getAllByRole('button', { name: /^Rate \d of 5$/ })).toHaveLength(5);
    expect(a.getByRole('textbox', { name: 'Review' })).toBeTruthy();
  });

  it('play, watched, stars and review write through the API', async () => {
    at('/movies/movie-467905');
    render(<App />);
    const a = within(await screen.findByRole('article', { name: 'How to Make a Killing' }));
    fireEvent.click(a.getByRole('button', { name: 'Resume at 45:00' }));
    await waitFor(() => expect(postsTo('/api/movies/files/11/play')).toHaveLength(1));
    await screen.findByText('resuming at 45:00');
    fireEvent.click(a.getByRole('button', { name: 'Mark as watched' }));
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/user')).toContainEqual({ watched: true }));
    fireEvent.click(a.getByRole('button', { name: 'Rate 4 of 5' }));
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/user')).toContainEqual({ rating: 4 }));
    const review = a.getByRole('textbox', { name: 'Review' });
    fireEvent.focus(review);
    fireEvent.change(review, { target: { value: 'Sharp and mean.' } });
    expect(postsTo('/api/movies/movie-467905/user')).not.toContainEqual({ review: 'Sharp and mean.' });
    fireEvent.blur(review);
    await waitFor(() => expect(postsTo('/api/movies/movie-467905/user')).toContainEqual({ review: 'Sharp and mean.' }));
    const n = postsTo('/api/movies/movie-467905/user').length;
    fireEvent.focus(review);
    fireEvent.blur(review);
    await new Promise((r) => setTimeout(r, 20));
    expect(postsTo('/api/movies/movie-467905/user').length).toBe(n);
  });

  it('R5.2 + R5.3: a series lists episodes with progress, a deleted flag and an on-another-machine flag', async () => {
    at('/movies/tv-247718');
    render(<App />);
    const eps = await screen.findByRole('region', { name: 'Episodes' });
    const row = (code: string) => eps.querySelector(`[data-episode="${code}"]`) as HTMLElement;
    expect(row('S01E01').textContent).toContain('deleted');
    expect(row('S01E01').className).toBe('mv-row del');
    expect((within(row('S01E01')).getByRole('button', { name: 'S01E01 is deleted' }) as HTMLButtonElement).disabled).toBe(true);
    expect(row('S01E02').textContent).toContain('in progress · 40%');
    expect((within(row('S01E02')).getByRole('button', { name: 'Resume S01E02 at 20:00' }) as HTMLButtonElement).disabled).toBe(false);
    expect(row('S01E03').textContent).toContain('on gpd');
    expect((within(row('S01E03')).getByRole('button', { name: 'S01E03 is on gpd' }) as HTMLButtonElement).disabled).toBe(true);
    expect(row('S01E04').className).toBe('mv-row none');
    expect(eps.querySelector('[data-episode="S02E01"]')).toBeNull();
    expect(within(eps).getByText('1 more season has no file on any machine.')).toBeTruthy();
    fireEvent.click(within(row('S01E02')).getByRole('button', { name: 'Mark S01E02 watched' }));
    await waitFor(() => expect(postsTo('/api/movies/files/22/watched')).toContainEqual({ watched: true }));
  });

  it('R5.4: the pill sends to the wall chat with the page and the open title on the first line; the answer panel shows', async () => {
    at('/movies/movie-467905');
    render(<App />);
    await screen.findByRole('article', { name: 'How to Make a Killing' });
    expect(screen.queryByPlaceholderText('Ask about your notes')).toBeNull();
    const box = screen.getByPlaceholderText('Ask about your movies');
    fireEvent.change(box, { target: { value: 'what should I watch after this?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() => expect(postsTo('/api/chat')).toHaveLength(1));
    const message = String(postsTo('/api/chat')[0]?.message ?? '');
    expect(message.split('\n')[0]).toBe('[Movies · How to Make a Killing (2026) · movie-467905]');
    expect(message.split('\n').slice(1).join('\n')).toBe('what should I watch after this?');
    await screen.findByText('Watch MobLand next.');
  });

  it('R5.5: the unmatched list shows each file with its reason and assigns a TMDB title', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('button', { name: /^Unmatched files/ }));
    await waitFor(() => expect(where()).toBe('/movies/unmatched'));
    expect(h1()).toBe('Unmatched.');
    const list = await screen.findByRole('region', { name: 'Unmatched files' });
    expect(within(list).getByText('shorter than 15 minutes')).toBeTruthy();
    expect(within(list).getByText('TMDB match not confident')).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: 'Assign a title to Ne.Zha.2.2025.1080p.mkv' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assign a title to Ne.Zha.2.2025.1080p.mkv' });
    expect((within(dialog).getByRole('textbox', { name: 'Search TMDB' }) as HTMLInputElement).value).toBe('Ne Zha 2');
    await waitFor(() => expect(calls).toContain('GET /api/movies/search-tmdb?q=Ne%20Zha%202&kind=movie'));
    fireEvent.click(await within(dialog).findByRole('option', { name: /Ne Zha 2/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(postsTo('/api/movies/files/32/assign')).toEqual([{ kind: 'movie', tmdb_id: 1125510 }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByText('assigned to Ne Zha 2');
  });

  it('Esc closes the assign dialog without leaving the page', async () => {
    at('/movies/unmatched');
    render(<App />);
    const list = await screen.findByRole('region', { name: 'Unmatched files' });
    fireEvent.click(within(list).getByRole('button', { name: 'Assign a title to clip-0412.mp4' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(where()).toBe('/movies/unmatched');
  });

  it('503 movies_off: the page says the subsystem is off', async () => {
    off = true;
    at('/movies');
    render(<App />);
    await screen.findByText(MOVIES_OFF_TEXT);
    expect(document.querySelector('.hdr-p')?.textContent).toContain('Movies are off on this daemon.');
    expect((screen.getByRole('button', { name: /^Unmatched files/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByPlaceholderText('Ask about your movies')).toBeTruthy();
  });

  it('an empty library says where notesd looks', async () => {
    titles = [];
    at('/movies');
    render(<App />);
    await waitFor(() => expect(document.querySelector('.mv-off')?.textContent).toContain('notesd scans /lib'));
  });

  it('Back and forward move between the grid, a title and the wall', async () => {
    at('/movies');
    render(<App />);
    await screen.findByRole('list', { name: 'Posters' });
    fireEvent.click(screen.getByRole('link', { name: /MobLand/ }));
    await waitFor(() => expect(where()).toBe('/movies/tv-247718'));
    await screen.findByRole('region', { name: 'Episodes' });
    pop('/movies');
    await screen.findByRole('list', { name: 'Posters' });
    expect(h1()).toBe('Movies.');
    pop('/');
    await waitFor(() => expect(h1()).not.toBe('Movies.'));
    expect(screen.getByPlaceholderText('Ask about your notes')).toBeTruthy();
    pop('/movies/movie-467905');
    await screen.findByRole('article', { name: 'How to Make a Killing' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to the library' }));
    await waitFor(() => expect(where()).toBe('/movies'));
  });
});
```
**File:** `web/src/components/Rail.test.tsx`
**Change:** add `onToggleMovies={vi.fn()}` to the `rail()` helper (after `onCycleMode={vi.fn()}`, line ~20) and to
the `side()` helper (after `onMode={vi.fn()}`, line ~36). Append:
```tsx
describe('Movies icon', () => {
  it('is an icon-only FilmSlate above Projects, pressed on the movies view, in the rail and the sidebar', () => {
    const toggle = vi.fn();
    const { container } = render(
      <Rail
        mode="text"
        view="movies"
        active={[]}
        onToggleSide={vi.fn()}
        onAdd={vi.fn()}
        onCycleMode={vi.fn()}
        onToggleMovies={toggle}
        onToggleProjects={vi.fn()}
        onToggleHistory={vi.fn()}
        onToggleAdversary={vi.fn()}
        onToggleBin={vi.fn()}
        onToggleTag={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const labels = order(container.querySelector('.rail') as Element);
    expect(labels.indexOf('Movies')).toBe(labels.indexOf('Projects') - 1);
    const btn = screen.getByRole('button', { name: 'Movies' });
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.getAttribute('data-tip')).toBe('Movies');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toBe('ibtn on');
    expect(screen.getByRole('button', { name: 'Recycle bin' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
    cleanup();
    const s = side('movies');
    const sideLabels = order(s.container.querySelector('.side-modes') as Element);
    expect(sideLabels.indexOf('Movies')).toBe(sideLabels.indexOf('Projects') - 1);
    expect(screen.getByRole('button', { name: 'Movies' }).getAttribute('aria-pressed')).toBe('true');
  });
});
```
**Impact:** only new tests. The existing Rail/Sidebar tests keep passing, because the new icon sits before Projects
and does not change any adjacency they assert.

## Principles applied

- Boundary discipline: every payload is normalized once, in the `moviesApi.ts` fetchers. Arrays are defaulted, status
  `counts` is defaulted, the player's `available` becomes a strict boolean, and the continue `action` is clamped to its
  four values. Components and `lib/movies.ts` trust the typed values and never re-check shapes.
- Make illegal states unrepresentable: the big Play button reads one `PlayPlan` union
  (`file | continue | elsewhere | none`) instead of parallel `file | null`, `canPlay` and `reason` fields.
  `TitleUserPatch` and `AssignBody` are unions too, so a series assignment cannot carry a season without its episode
  (phase 4 requires them together). `MoviesRoute` keeps the shape the phase scope fixed (`title`, `unmatched`). Its
  parser never builds both fields set, and `moviesHref` gives `unmatched` precedence.
- Laziness protocol: filtering and sorting run on the client over the one `GET /api/movies` list (about 100 titles), so
  the page sends no query to the server. The page reuses `ChatBar`'s page variant, the `AdversaryPill` pattern,
  `ApiError`, `startAdaptivePoll`, `useNotice`, `.ibtn`/`.pbtn` and the CSS variables. It reads playback availability
  from the contract's `GET /api/movies/player` instead of widening `useCapabilities`/`Capabilities` (a second store for
  one boolean). No client-side episode grouping: phase 4 already sends `seasons`, `unplaced_files` and grouped credits.
- Test behavior, not implementation: the App tests drive the real `App` through a stubbed `fetch`, the same as
  `App.adversary.test.tsx`. They click, type and blur, then assert the URL, the visible text and the request bodies.
  No hook or component is mocked.
- Prove it works: the Proof section drives a throwaway daemon with Playwright on seeded rows and a real sync pass. It
  checks SQL for the writes.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm run typecheck && npm run build`
**Tests:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npx vitest run web/src/lib/route.test.tsx web/src/lib/movies.test.tsx web/src/hooks/useMovies.test.tsx web/src/components/movies web/src/components/Rail.test.tsx web/src/App.movies.test.tsx && npm test`
**Proof:** a throwaway daemon built from this worktree serves the `/movies` page. Its database is seeded with two
titles on another host plus one deleted-only title, and one junk file sits in a temp root so a real sync pass produces
an unmatched row. Playwright drives the page. Chat and TMDB are stubbed at the browser (`page.route`), so nothing is
billed and the network is not touched.
- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh`)
- Feature-map entries: none yet. `features/movies.md` belongs to phase 8; the page's selectors for it are in Handoffs.
- Setup, run once from the worktree (a stranger can paste this):
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/movies-library
  V=.claude/skills/verify-notesd/scripts/verify.sh
  S=$(mktemp -d); ROOT="$S/library"; mkdir -p "$ROOT"
  head -c 65536 /dev/urandom > "$ROOT/Verify.Clip.2024.1080p.mkv"      # not a video: ffprobe fails, so it lands unmatched
  NOTESD_MOVIES=on NOTESD_MOVIES_ROOTS="$ROOT" NOTESD_MOVIES_SCAN_MS=3600000 NOTESD_VLC_INI= \
    TMDB_API_READ_ACCESS_TOKEN= TMDB_API_KEY= $V up --web              # prints RUN=<id>, URL=...
  cat > "$S/seed.sql" <<'SQL'
  insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, poster_path, runtime_min, genres, season_count, episode_count) values
    ('movie-467905','movie',467905,'How to Make a Killing','How to Make a Killing',2026,'2026-02-20','A disinherited heir plots his way back into the family fortune.','/verify-killing.jpg',112,'["Comedy","Crime"]',null,null),
    ('tv-247718','tv',247718,'MobLand','MobLand',2025,'2025-03-30','Two crime families clash in London.',null,null,'["Crime"]',1,3),
    ('movie-900001','movie',900001,'Verify Gone Film','Verify Gone Film',2024,'2024-05-01','Only a deleted file is left.',null,95,'[]',null,null);
  insert into movie_companies (id, name) values (990001,'Verify Studios');
  insert into movie_title_companies (title_id, company_id, ord) values ('movie-467905',990001,0);
  insert into movie_people (id, name) values (990011,'Dee Rector'),(990012,'Rita Writer'),(990013,'Pro Ducer'),(990014,'Ann Actor');
  insert into movie_credits (title_id, person_id, role, character, job, ord) values
    ('movie-467905',990011,'director',null,'Director',0),('movie-467905',990012,'writer',null,'Screenplay',0),
    ('movie-467905',990013,'producer',null,'Producer',0),('movie-467905',990014,'cast','Lead Character',null,0);
  insert into movie_episodes (title_id, season, episode, name) values
    ('tv-247718',1,1,'Stick or Twist'),('tv-247718',1,2,'Episode Two'),('tv-247718',1,3,'Episode Three');
  insert into movie_files (id, title_id, host, path, name, size, duration_s, season, episode, status, source, deleted_at) values
    (990101,'movie-467905','verify-other-host','/other/How.to.Make.a.Killing.2026.mkv','How.to.Make.a.Killing.2026.mkv',2000000000,6720,null,null,'matched','scan',null),
    (990102,'tv-247718','verify-other-host','/other/MobLand.S01E01.mkv','MobLand.S01E01.mkv',1000000000,3000,1,1,'matched','scan',now()),
    (990103,'tv-247718','verify-other-host','/other/MobLand.S01E02.mkv','MobLand.S01E02.mkv',1000000000,3000,1,2,'matched','scan',null),
    (990104,'movie-900001','verify-other-host','/other/Gone.Film.2024.mkv','Gone.Film.2024.mkv',1000000000,5700,null,null,'matched','scan',now());
  insert into movie_plays (file_id, host, source, started_at, ended_at, start_position_s, position_s, duration_s) values
    (990101,'verify-other-host','live',now() - interval '1 day',now() - interval '23 hours',0,2700,6720),
    (990103,'verify-other-host','live',now() - interval '2 hours',now() - interval '1 hour',0,1200,3000);
  SQL
  $V exec RUN "$(cat "$S/seed.sql")"
  $V api RUN POST /api/movies/sync
  timeout 60 bash -c "until $V api RUN GET /api/movies/unmatched | grep -q Verify.Clip; do sleep 2; done"
  $V doctor RUN
  ```
  The seed's column names are phase 1's (`phase-1.md` Step 1). If the landed schema differs, change only the column
  names, never the values. Every seeded file sits on `verify-other-host`, so this host's sync never marks it deleted.
  Write each `jN.mjs` below into `$S` and run `$V ui RUN "$S/jN.mjs"`.
- Journeys:
  - **J1** · traces R5.1 — `$V ui RUN "$S/j1.mjs"` with
    ```js
    export default async ({ page, base, shot, log }) => {
      await page.goto(base + '/')
      await page.locator('.rail').getByRole('button', { name: 'Movies' }).click()
      await page.waitForURL('**/movies')
      const tiles = page.getByRole('list', { name: 'Posters' }).getByRole('listitem')
      await tiles.first().waitFor()
      const n = await tiles.count()
      if (n !== 3) throw new Error(`expected 3 posters, got ${n}`)
      const gone = await page.locator('.mv-tile.gone').getAttribute('data-title')
      if (gone !== 'movie-900001') throw new Error(`expected the deleted-only title dimmed, got ${gone}`)
      if (await page.getByRole('heading', { level: 1 }).textContent() !== 'Movies.') throw new Error('heading is not Movies.')
      await shot('movies-grid')
      log(`rail icon opened /movies: ${n} posters, movie-900001 dimmed`)
    }
    ```
    → passes when the run's evidence `NN-ui-j1.txt` ends without an error, the URL is `/movies`, and there are exactly
    3 poster tiles with `movie-900001` carrying the `gone` class.
  - **J2** · traces R5.2, R5.3 — `$V ui RUN "$S/j2.mjs"` with
    ```js
    export default async ({ page, base, shot, log }) => {
      await page.goto(base + '/movies')
      await page.getByRole('link', { name: /MobLand/ }).click()
      await page.waitForURL('**/movies/tv-247718')
      const eps = page.getByRole('region', { name: 'Episodes' })
      await eps.waitFor()
      const e1 = await eps.locator('[data-episode="S01E01"]').textContent()
      if (!e1.includes('deleted')) throw new Error(`S01E01 has no deleted flag: ${e1}`)
      const e2 = await eps.locator('[data-episode="S01E02"]').textContent()
      if (!e2.includes('40%')) throw new Error(`S01E02 shows no progress: ${e2}`)
      if (!e2.includes('on verify-other-host')) throw new Error(`S01E02 has no other-machine flag: ${e2}`)
      if ((await eps.locator('[data-episode="S01E03"]').getAttribute('class')) !== 'mv-row none') throw new Error('S01E03 should read as no file')
      await shot('series-detail')
      log('series: S01E01 deleted, S01E02 40% on verify-other-host, S01E03 no file')
    }
    ```
    → passes when the run ends without an error: S01E01's row says `deleted`, S01E02's row says `40%` and
    `on verify-other-host`, and S01E03 is the `mv-row none` row.
  - **J3** · traces R5.2 — `$V ui RUN "$S/j3.mjs"` with
    ```js
    export default async ({ page, base, shot, log }) => {
      await page.goto(base + '/movies')
      await page.getByRole('link', { name: /How to Make a Killing/ }).click()
      await page.waitForURL('**/movies/movie-467905')
      const art = page.getByRole('article', { name: 'How to Make a Killing' })
      await art.waitFor()
      const text = await art.textContent()
      for (const want of ['Released Feb 20, 2026', 'A disinherited heir', 'Verify Studios', 'Dee Rector', 'Rita Writer', 'Pro Ducer', 'Ann Actor', 'Lead Character', 'Review']) {
        if (!text.includes(want)) throw new Error(`detail is missing "${want}"`)
      }
      const play = art.getByRole('button', { name: /^On verify-other-host/ })
      if (!(await play.isDisabled())) throw new Error('Play must be disabled for a file on another machine')
      await art.getByRole('button', { name: 'Mark as watched' }).click()
      await art.getByRole('button', { name: 'Rate 4 of 5' }).click()
      await art.getByRole('textbox', { name: 'Review' }).fill('verify review')
      await art.getByRole('button', { name: /^Rated 4 of 5/ }).focus()
      await page.locator('.mv-note', { hasText: 'review saved' }).waitFor()
      await shot('movie-detail')
      log('detail: date, synopsis, studio, crew, cast with character; watched, 4 stars and a review saved')
    }
    ```
    then `$V sql RUN "select rating, watched_at is not null as watched, review_note_id is not null as has_review from movie_titles where id = 'movie-467905'"`
    and `$V sql RUN "select n.body like '%verify review%' as has_text from notes n join movie_titles t on t.review_note_id = n.id where t.id = 'movie-467905'"`
    → passes when the UI run ends without an error and the SQL prints `4 | t | t` and `t`.
  - **J4** · traces R5.4 — `$V ui RUN "$S/j4.mjs"` with
    ```js
    export default async ({ page, base, shot, log }) => {
      let sent = null
      await page.route('**/api/chat', async (route) => {
        sent = JSON.parse(route.request().postData() ?? '{}')
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: 'event: delta\ndata: {"text":"stub answer"}\n\nevent: done\ndata: {"thread_id":"T-V","user_message_id":"Q001","assistant_message_id":"A001","reply_to":null,"brain":"claude"}\n\n',
        })
      })
      await page.goto(base + '/movies/movie-467905')
      await page.getByRole('article', { name: 'How to Make a Killing' }).waitFor()
      if ((await page.getByPlaceholder('Ask about your notes').count()) !== 0) throw new Error('the wall chat bar must give way to the pill')
      const pill = page.getByPlaceholder('Ask about your movies')
      await pill.fill('what should I watch after this?')
      await pill.press('Enter')
      await page.getByText('stub answer').waitFor()
      const first = String(sent?.message ?? '').split('\n')[0]
      if (first !== '[Movies · How to Make a Killing (2026) · movie-467905]') throw new Error(`first line was ${JSON.stringify(first)}`)
      await shot('movies-pill-answer')
      log(`pill sent "${first}"; the answer panel shows the reply over the page`)
    }
    ```
    → passes when the run ends without an error: the captured `/api/chat` body's first line is
    `[Movies · How to Make a Killing (2026) · movie-467905]`, and `stub answer` is visible on `/movies/movie-467905`.
    The chat is stubbed in the browser, so no model runs.
  - **J5** · traces R5.5 — `$V ui RUN "$S/j5.mjs"` with
    ```js
    export default async ({ page, base, shot, log }) => {
      let assigned = null
      await page.route('**/api/movies/search-tmdb?*', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [{ kind: 'movie', tmdb_id: 467905, title_id: 'movie-467905', title: 'How to Make a Killing', original_title: 'How to Make a Killing', year: 2026, overview: '', poster_url: null, in_library: true }] }) }),
      )
      await page.route('**/api/movies/files/*/assign', async (route) => {
        assigned = JSON.parse(route.request().postData() ?? '{}')
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ file_id: 0, title: null }) })
      })
      await page.goto(base + '/movies')
      await page.getByRole('button', { name: /^Unmatched files/ }).click()
      await page.waitForURL('**/movies/unmatched')
      const list = page.getByRole('region', { name: 'Unmatched files' })
      const row = list.locator('li', { hasText: 'Verify.Clip.2024.1080p.mkv' })
      await row.waitFor()
      const t = await row.textContent()
      if (!/ffprobe could not read it|no TMDB credentials|shorter than 15 minutes|no TMDB match/.test(t)) throw new Error(`no reason on the row: ${t}`)
      await row.getByRole('button', { name: 'Assign a title to Verify.Clip.2024.1080p.mkv' }).click()
      const dlg = page.getByRole('dialog', { name: 'Assign a title to Verify.Clip.2024.1080p.mkv' })
      await dlg.getByRole('option', { name: /How to Make a Killing/ }).click()
      await dlg.getByRole('button', { name: 'Assign' }).click()
      await dlg.waitFor({ state: 'detached' })
      if (assigned?.kind !== 'movie' || assigned?.tmdb_id !== 467905) throw new Error(`assign body was ${JSON.stringify(assigned)}`)
      await shot('unmatched-assign')
      log(`unmatched row "${t.trim()}" assigned with ${JSON.stringify(assigned)}`)
    }
    ```
    → passes when the run ends without an error: the real sync's unmatched row for `Verify.Clip.2024.1080p.mkv` shows a
    reason, and the dialog posts `{"kind":"movie","tmdb_id":467905}` to `/api/movies/files/<id>/assign`. TMDB is
    stubbed in the browser. That the server registers the file is phase 4's R1.5.
- Neighbor check: Seer Adversarial and the wall chat bar, which share the URL-sync effect, the popstate handler and the
  chat-bar guard this phase edits. `$V ui RUN "$S/nb.mjs"` with
  ```js
  export default async ({ page, base, shot, log }) => {
    await page.goto(base + '/')
    await page.getByPlaceholder('Ask about your notes').waitFor()
    await page.locator('.rail').getByRole('button', { name: 'Seer Adversarial' }).click()
    await page.waitForURL('**/adversary')
    await page.getByPlaceholder('Ask about Seer Adversarial').waitFor()
    await page.locator('.rail').getByRole('button', { name: 'Movies' }).click()
    await page.waitForURL('**/movies')
    await page.goBack()
    await page.waitForURL('**/adversary')
    await page.getByPlaceholder('Ask about Seer Adversarial').waitFor()
    await page.goBack()
    await page.waitForURL((u) => new URL(u).pathname === '/')
    await page.getByPlaceholder('Ask about your notes').waitFor()
    await shot('neighbor-wall')
    log('wall -> adversary -> movies, then Back twice returns to adversary and the wall with its chat bar')
  }
  ```
  → passes when the run ends without an error. Also `npm test` passes, including the unchanged
  `App.adversary.test.tsx`, `App.projects.test.tsx` and `App.history.test.tsx`.
- Cleanup: `$V down RUN`.
- Cost: none. No LLM turn: chat and TMDB are stubbed in the browser, and no Play is ever clicked (every seeded file is
  on another host).
**Exit criteria:** typecheck and `npm test` pass. J1-J5 and the neighbor check run green on a throwaway daemon: the rail
icon opens a poster grid; a poster opens a detail page with every listed field; a series shows per-episode progress
with deleted and other-machine flags; the pill sends `[Movies · ...]` on the first line and the answer panel shows;
the unmatched list shows a reason and the assign dialog posts the chosen title.

## Handoffs

- **Phase 8 (feature map, R7.1):** this phase changes what the user can do, but `features/movies.md` is phase 8's file
  under the index. Its "Wall page" section should list:
  - Selectors: rail and sidebar `getByRole('button', { name: 'Movies' })` (FilmSlate, above Projects), grid
    `getByRole('list', { name: 'Posters' })`, tiles `a.mv-tile[data-title="<id>"]` (`.gone` = no file left), filter
    buttons `/^all|^unwatched|^in progress|^finished|^gone/`, `'All kinds'`, `'Films'`, `'Series'`, searchbox
    `'Filter titles'`.
  - Detail: `getByRole('article', { name: '<title>' })`; regions `'Cast'`, `'Episodes'`, `'Files'`; rows
    `[data-episode="S01E02"]`; Play label `'Play'` / `'Resume at mm:ss'` / `'Continue: ...'` / `'On <host>: ...'`;
    `'Mark as watched'`; `'Rate N of 5'`; textbox `'Review'`.
  - Toolbar: `/^Unmatched files/`, `'Rescan the library'`, `'Back to the library'`.
  - Unmatched: region `'Unmatched files'`, `'Assign a title to <file name>'`, a dialog with textbox `'Search TMDB'`,
    listbox `'TMDB results'` and `'Assign'`.
  - Pill: `getByPlaceholder('Ask about your movies')`.
  - J1-J5 of this plan can be copied as the entry's journeys. Phase 8's planned verify fixtures (a generated tree, fake
    TMDB, fake VLC) can replace the env lines and seed SQL above.
- **Phase 5:** reconciled; this plan mirrors its wire types (see Requires). Phase 5 emits `changed` only on play
  start and end.
- **Phase 4:** none required; this plan mirrors its wire types verbatim. One note: the page always sends `kind` to
  `search-tmdb`, so the "absent = both" branch is unused by the web.
- **Phase 8 hooks (reconciled):** rail/sidebar button named `Movies`; grid `<img alt={title}>` from `Poster`; every
  file row and episode row is `<li data-testid="movie-file" data-file-id data-deleted="true|false" data-state>`
  (`FileRow` in `parts.tsx`, `EpisodeItem` in `EpisodeList.tsx`).
- **Phase 7:** the chat agent should read the `[Movies · <title> (<year>) · <title id>]` first line the way it reads
  `[Seer Adversarial · ...]`, and name the movies tools when it sees it. That is a sentence in `src/chat/prompt.ts`,
  which phase 7 owns.

## Rollback

Revert this phase's commit. It touches only `web/src`: one line in `types.ts`, `lib/route.ts`, `App.tsx`, `Rail.tsx`,
`Sidebar.tsx`, `Header.tsx` and `Rail.test.tsx`, plus new files. No server code, schema or config changes, so the
daemon and phases 1-5 and 7 are unaffected. After reverting, run `npm run build` (and restart the daemon) so `web/dist`
no longer serves the page.
