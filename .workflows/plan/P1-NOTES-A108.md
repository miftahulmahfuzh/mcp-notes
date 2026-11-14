> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/movies-library/PLAN.md` phase 7. Source: `.workflows/plan/movies-library/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: MCP tools, chat bar allow-list, /n skill

**Plan set:** `MOVIES_LIBRARY_PLAN.md`
**Analysis:** `.workflows/analyze/20261114-121616-M7VL_code_analyzer.md`
**Satisfies:** R6 — `/n` and the wall's chat bar can answer "which MobLand episode did I watch last and when", "Blumhouse movies I have seen this year", "recommend other Margaret Qualley films", "continue MobLand" and "continue what I watched last night"
**Criteria:** R6.1, R6.2, R6.3, R6.4, R6.5
**Depends on:** Phase 4, Phase 5 (and through them 1, 2, 3)
**Difficulty:** NORMAL
**Package:** `src/mcp`

---

## Goal

After this phase the `notes` MCP server has six `movies_*` tools over the movie library:
`movies_list`, `movies_get`, `movies_history`, `movies_continue`, `movies_person` and
`movies_mark`. The wall's chat bar is allowed to call them and captions them, and the MCP
instructions, the chat system prompt and the `/n` skill say when to use each one. Every result
carries ISO dates, state names, season/episode numbers with episode names, deleted dates, the
last play and its position, and the wall link `<wall>/movies/<title id>`, so `/n` never needs
SQL. With the library off (`deps.movies` null) each tool answers `movies_off`.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/mcp/movieTools.ts`: `registerMovieTools(server, deps)`, `movieToolDeps(appDeps): MovieToolDeps | null`, `interface MovieToolDeps`, `interface TitleUserPatch`, `MOVIES_OFF`, `movieErrorResult(err)`, `MOVIES_LIST_DEFAULT_LIMIT` / `_MAX_LIMIT`, `MOVIES_HISTORY_DEFAULT_LIMIT` / `_MAX_LIMIT`, `MOVIES_PERSON_DEFAULT_LIMIT` / `_MAX_LIMIT`, `MOVIES_REVIEW_MAX_CHARS`
- `src/chat/status.ts`: `MOVIE_TOOL_NAMES` (`['movies_list', 'movies_get', 'movies_history', 'movies_continue', 'movies_person', 'movies_mark']`), `type MovieToolName`
- `tests/unit/mcp.movieTools.test.ts`, `tests/integration/movies.mcp.int.test.ts`, `tests/integration/helpers/moviesMcpSeed.ts`

**Signature changes:**
- `interface ToolDeps` (`src/mcp/tools.ts`) gains `movies?: MovieToolDeps | null`
- `mcpToolDeps(deps, …)` (`src/http/app.ts`) now also sets `movies: movieToolDeps(deps)`
- `allowedChatTools()` returns 6 more names (19 + 5 + 3 + **6** + 21 + 2 = 56)
- `buildInstructions()` gains a `Movies.` paragraph between `Connectors.` and `Adversary.`
- `buildChatSystemPrompt()` gains one movies section after the daily-words section

**Requires (from earlier phases).** Code from phases 1–5 does not exist yet; these are the exact
names and shapes this plan compiles against. The reconciler aligns them with phases 1–5's plans.
Where a shape is an assumption beyond the index's contract it is marked *(assumed)*.

- Phase 1 `src/movies/types.ts`: `TitleKind` (`'movie' | 'tv'`), `WatchState` (`'finished' | 'in_progress' | 'unwatched' | 'dropped' | 'removed_unwatched' | 'seen'`), `titleId(kind: TitleKind, tmdbId: number): string`.
- Phase 1 `src/db/schema.ts`: `movieTitles` (`id` text), `movieFiles` (`id` bigserial in `mode: 'number'`, `titleId` text nullable). Tables exactly as in the index's "Tables".
- Phase 1 `src/movies/repo.ts`: `new MoviesRepo(db)` *(assumed constructor)*; `setTitleUser(titleId: string, patch: { watched?: boolean; rating?: number | null; reviewNoteId?: string | null })` *(assumed: title id first)*; `setFileWatched(fileId: number, watched: boolean)`. Return values are ignored.
- Phase 1: `AppDeps.movies: MoviesService | null`, every test builder sets it to `null`; `Config.movies.tmdb.imageBase` exists. Test fixtures that cast a partial `AppDeps` leave it `undefined`; `movieToolDeps` treats that as off.
- Phase 2 `src/movies/tmdb.ts` (reconciled to phase 2's code): `TmdbError`; `TmdbClient.searchPerson(query): Promise<TmdbPersonHit[]>` with `TmdbPersonHit = { personId, name, knownFor: string | null, profilePath, popularity }`; `TmdbClient.personCredits(personId): Promise<TmdbPersonCredit[]>` with `TmdbPersonCredit = { kind, tmdbId, title, releaseDate, year, posterPath, popularity, credit: 'cast' | 'crew', character, job, department, episodeCount }`, one entry per (title, credit).
- Phase 3 `src/movies/service.ts`: `MoviesService` has `host: string`, `repo: MoviesRepo`, `tmdb: TmdbClient | null` (null without TMDB credentials).
- Phase 4 `src/movies/read.ts` (reconciled to phase 4's code):
  - `ReadContext = { host: string; imageBase: string }` (`imageBase` = `config.movies.tmdb.imageBase`).
  - `listTitles(db, filter: TitleFilter, ctx): Promise<TitleListItem[]>`, `TitleFilter = { q?, state?, kind?, company?, person?, finishedFrom?, finishedTo?, sort?, limit? }` (no host; `company` / `person` = TMDB id or name fragment, case-insensitive; `finishedFrom` inclusive / `finishedTo` exclusive on the title's `finished_at`).
  - `getTitle(db, id, ctx): Promise<TitleDetail | null>`: `seasons[].episodes[]` (with `name`), `files` (deleted ones too, with `available`, `deleted_at`, `state`), `plays` (`PlayView[]`, newest first).
  - `history(db, filter: HistoryFilter): Promise<PlayView[]>`, `HistoryFilter = { titleId?, fileId?, host?, from?, to?, limit? }` (`from` inclusive, `to` exclusive, on `started_at`; this phase never passes `host`, so plays from both laptops are listed). `PlayView` carries `title_id` (nullable), `title`, `season`, `episode`, `episode_name`, `file_deleted`, `file_deleted_at`, `started_at`, `ended_at`, `position_s`, `duration_s`, `source`, `host`.
  - `saveReview(service: Pick<MoviesService, 'repo'>, notes: NotesService, titleId, text)` (`src/movies/reviewNote.ts`). Return value ignored.
- Phase 5 (reconciled to phase 5's code): `src/movies/continue.ts` `continueTitle(deps: ContinueDeps, titleQuery: string | null): Promise<ContinueResult>`, `ContinueDeps = { db: Db; player: Pick<MoviePlayer, 'host' | 'play'>; exists?: (abs) => Promise<boolean> }`, and `ContinueResult` the union `resumed | started` (`{ title, file, position, play }`), `missing` (`{ title, missing, present }`), `nothing` (`{ title, reason, finished_at, last }`), `ambiguous` (`{ query, candidates }`), `no_match` (`{ query }`). There is no `moviesContinueDeps`: the MCP tool and `POST /api/movies/continue` both use the daemon's one player, `AppDeps.moviesPlayer` (optional; null or absent when the library is off). `continueTitle` decides `missing` / `nothing` before touching the player; player failures are `PlayError`s with a lower-case `code` (`not_on_this_machine`, `player_unavailable`, `file_missing`, `not_found`).
- Phase 5 `src/movies/player.ts`: `MoviePlayer` with `host` and `play(fileId): Promise<PlayStarted>`.

**Leaves alone (owned by others):** `src/http/moviesApi.ts`, `src/movies/read.ts`, `src/movies/reviewNote.ts` (Phase 4); `src/http/moviesPlayApi.ts`, `src/movies/player.ts`, `src/movies/continue.ts`, `src/movies/vlc/*` (Phase 5); `web/src/*` (Phase 6); `CLAUDE.md`, `README.md`, `.claude/skills/verify-notesd/*` (Phase 8); `src/movies/repo.ts`, `src/db/schema.ts`, `src/config.ts`, `tests/integration/setup.ts` (Phase 1).

## Files

| File | Action | What changes |
|---|---|---|
| `src/mcp/movieTools.ts` | create | the six tools, `MovieToolDeps`, `movieToolDeps`, `MOVIES_OFF` |
| `src/mcp/tools.ts:13-37` | modify | `ToolDeps.movies?: MovieToolDeps \| null` |
| `src/mcp/server.ts:4-28` | modify | import and call `registerMovieTools` |
| `src/http/app.ts:65-82` | modify | `mcpToolDeps` sets `movies: movieToolDeps(deps)` |
| `src/chat/status.ts:53-106,190-205` | modify | `MOVIE_TOOL_NAMES`, spread into `allowedChatTools`, six captions |
| `src/chat/prompt.ts:25` | modify | one movies section after the daily-words section |
| `src/mcp/instructions.ts:22-28,57` | modify | `Movies.` paragraph before `Adversary.`; docstring |
| `claude/skills/n/SKILL.md:3,301` | modify | description mentions movies; new `## Movies` section before `## Deleting` |
| `tests/unit/chat-status.test.ts:3-44` | modify | counts 56; movie names and captions |
| `tests/unit/mcp.instructions.test.ts:273` | modify | Movies paragraph test |
| `tests/unit/chat-prompt.test.ts:155` | modify | movies section test |
| `tests/unit/mcp.movieTools.test.ts` | create | registration, `movies_off`, validation, error codes, continue wiring (no DB) |
| `tests/integration/helpers/moviesMcpSeed.ts` | create | seeds a library through SQL |
| `tests/integration/movies.mcp.int.test.ts` | create | the six tools over MCP against seeded rows, fake TMDB, fake player |

## Implementation Steps

### Step 1: Movie tool names, chat allow-list and captions
**File:** `src/chat/status.ts:53` (after `AdversaryToolName`, line 56), `:86-106` (`allowedChatTools`), `:190-205` (captions)
**Change:** add `MOVIE_TOOL_NAMES`, spread it into `allowedChatTools()` after the adversary names, update the doc comment, and add six `case`s before `case 'dword_vocab_lookup':`.
**Code:**

Insert after line 56:
```ts
/**
 * The movie library tools (MOVIES_LIBRARY_PLAN phase 7): src/mcp/movieTools.ts registers them under
 * these names, in this order. movies_continue and movies_mark write (VLC opens; marks are stored);
 * the other four only read.
 */
export const MOVIE_TOOL_NAMES = [
  'movies_list',
  'movies_get',
  'movies_history',
  'movies_continue',
  'movies_person',
  'movies_mark',
] as const;

export type MovieToolName = (typeof MOVIE_TOOL_NAMES)[number];
```

Replace lines 86-106 (doc comment and function) with:
```ts
/**
 * Exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 6 movie tools, the 21
 * connector tools and WebSearch + WebFetch (CONNECTORS_PLAN invariant 8, which supersedes
 * CHAT_BAR_BRAIN_PLAN invariant 4; SEMANTIC_SEARCH_PLAN phase 5 adds `related`; WALL_EDITING_PLAN
 * phase 3 adds `attach_image`, `remove_image` and `restore_image`; CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN
 * phase 6 adds `similar_images`; PROJECT_SESSION_GRAPH_PLAN phase 7 adds the session tools;
 * PROJECT_SESSION_GRAPH_PLAN phase 9 adds `session_resume`; SEER_ADVERSARIAL_PLAN phase 5 adds the
 * adversary tools; MOVIES_LIBRARY_PLAN phase 7 adds the movie tools; DWORD_CONNECTOR_PLAN phases
 * 1/3/4 add dword's six tool names to `ALL_CONNECTOR_TOOL_NAMES`, 15 -> 21, with no change needed to
 * this function's body).
 */
export function allowedChatTools(): string[] {
  return [
    ...NOTES_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...SESSION_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...ADVERSARY_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...MOVIE_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    // dword's six tool names (dword_schema, dword_sql, and DWORD_TOOL_NAMES above) arrive here
    // already, because CONNECTOR_SYSTEMS includes 'dword' (DWORD_CONNECTOR_PLAN phase 1).
    ...ALL_CONNECTOR_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
    ...WEB_TOOL_NAMES,
  ];
}
```

In `captionForToolUse`, insert before `case 'dword_vocab_lookup':` (line 197):
```ts
    case 'movies_list':
      return 'searching movies';
    case 'movies_get':
      return 'reading a title';
    case 'movies_history':
      return 'reading watch history';
    case 'movies_continue':
      return 'opening VLC';
    case 'movies_person':
      return 'reading a filmography';
    case 'movies_mark':
      return 'marking a title';
```
**Impact:** the chat agent (`src/chat/agent.ts:320`) passes `allowedChatTools()` to the Agent SDK, so the chat bar may call the six tools once they are registered (Step 4). `tests/unit/chat-status.test.ts` must be updated in the same step (Step 9) or it fails on the count.

### Step 2: `src/mcp/movieTools.ts`
**File:** `src/mcp/movieTools.ts` (new)
**Change:** the six tools. Input is validated once at the boundary (zod, `parseDateBound`, `markRequest`); title names are resolved to ids once (`resolveTitleId`); everything else is read through `read.ts`; writes go through `MoviesRepo`, `saveReview` and `continueTitle`. Two small read-only selects live here: which TMDB ids are in the library (`movies_person`) and which title a file belongs to (`movies_mark` on a file).
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { MOVIE_TOOL_NAMES } from '../chat/status.js';
import type { Db } from '../db/client.js';
import { movieFiles, movieTitles } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import { continueTitle, type ContinueResult } from '../movies/continue.js';
import { getTitle, history, listTitles, type HistoryFilter, type ReadContext, type TitleFilter, type TitleListItem } from '../movies/read.js';
import { saveReview } from '../movies/reviewNote.js';
import { TmdbError, type TmdbClient, type TmdbPersonCredit } from '../movies/tmdb.js';
import { titleId, type TitleKind, type WatchState } from '../movies/types.js';
import { parseDateBound } from '../notes/dates.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { errorResult, jsonResult, type ToolDeps } from './tools.js';

const [LIST, GET, HISTORY, CONTINUE, PERSON, MARK] = MOVIE_TOOL_NAMES;

export const MOVIES_LIST_DEFAULT_LIMIT = 50;
export const MOVIES_LIST_MAX_LIMIT = 200;
export const MOVIES_HISTORY_DEFAULT_LIMIT = 30;
export const MOVIES_HISTORY_MAX_LIMIT = 200;
export const MOVIES_PERSON_DEFAULT_LIMIT = 60;
export const MOVIES_PERSON_MAX_LIMIT = 200;
export const MOVIES_REVIEW_MAX_CHARS = 20_000;

/** How many of a person's in-library titles get their state read (one getTitle each). */
const PERSON_STATE_LOOKUPS = 50;

export const MOVIES_OFF =
  'movies_off: the movie library is not running on this server (NOTESD_MOVIES=off, or the daemon was started without it), so there are no titles, plays or playback here.';

const WATCH_STATES = ['finished', 'in_progress', 'unwatched', 'dropped', 'removed_unwatched', 'seen'] as const satisfies readonly WatchState[];

/** States in which the owner has seen the title (finished it, or opened it with the position unknown). */
const SEEN_STATES: ReadonlySet<WatchState> = new Set<WatchState>(['finished', 'seen']);
/** States in which the owner began the title and did not finish it. */
const STARTED_STATES: ReadonlySet<WatchState> = new Set<WatchState>(['in_progress', 'dropped']);

const TITLE_ID = /^(movie|tv)-\d+$/i;

export interface TitleUserPatch {
  watched?: boolean;
  rating?: number | null;
}

/**
 * What the movie tools need, bound once per daemon by `movieToolDeps` (tests build their own).
 * Reads go through `read.ts` with `ToolDeps.db`; every write goes through one of these functions.
 */
export interface MovieToolDeps {
  /** This machine's host name: files and plays recorded for another host answer available: false. */
  host: string;
  /** `config.movies.tmdb.imageBase`, for the read model's poster URLs. */
  imageBase: string;
  /** TMDB behind movies_person. Null without TMDB credentials. */
  tmdb: TmdbClient | null;
  setTitleUser(titleId: string, patch: TitleUserPatch): Promise<void>;
  setFileWatched(fileId: number, watched: boolean): Promise<void>;
  /** Creates or updates the title's review note through NotesService (phase 4's saveReview). */
  saveReview(titleId: string, text: string): Promise<unknown>;
  /** Phase 5's continueTitle on the daemon's one MoviePlayer: may open VLC on this machine. */
  continueTitle(title: string | null): Promise<ContinueResult>;
}

/** The movie tool deps for a running daemon, or null when the library is off. */
export function movieToolDeps(deps: AppDeps): MovieToolDeps | null {
  const movies = deps.movies;
  if (!movies) return null;
  return {
    host: movies.host,
    imageBase: deps.config.movies.tmdb.imageBase,
    tmdb: movies.tmdb,
    async setTitleUser(id, patch) {
      await movies.repo.setTitleUser(id, patch);
    },
    async setFileWatched(fileId, watched) {
      await movies.repo.setFileWatched(fileId, watched);
    },
    saveReview: (id, text) => saveReview(movies, deps.service, id, text),
    // The daemon's one MoviePlayer, the same instance POST /api/movies/continue drives.
    continueTitle: async (title) => {
      const player = deps.moviesPlayer ?? null;
      if (player === null) throw new MovieToolError('movies_off', 'playback is not running on this server.');
      return continueTitle({ db: deps.db, player }, title);
    },
  };
}

/** A tool-level failure: the result text is `<code>: <message>`. */
class MovieToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MovieToolError';
  }
}

/** What to tell the owner after a player error's own message. */
const PLAYER_HINTS: Readonly<Record<string, string>> = {
  not_on_this_machine: 'The file is on the other laptop (its host); play it there.',
  player_unavailable: 'VLC cannot be started by this daemon (vlc.exe, WSL interop or the Windows curl.exe is missing).',
  file_missing: 'The library lists this file as present but it is not on disk. That is a bug: tell the owner.',
};

function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Any error from a movie tool -> `<code>: <what happened and what to do>`. */
export function movieErrorResult(err: unknown): CallToolResult {
  if (err instanceof TmdbError) {
    return fail(`tmdb_error: TMDB could not be reached or refused the request (${err.message}). Answer from the library tools, or use web search.`);
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z][a-z_]*$/.test(code)) {
      const hint = PLAYER_HINTS[code];
      return fail(hint === undefined ? `${code}: ${err.message}` : `${code}: ${err.message} ${hint}`);
    }
  }
  return errorResult(err);
}

/** Like `run` in tools.ts (compact JSON), with the movie error codes. */
async function answer(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return jsonResult(await fn(), true);
  } catch (err) {
    return movieErrorResult(err);
  }
}

function normalizedTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function describeCandidate(t: TitleListItem): string {
  return `${t.title}${t.year !== null ? ` (${t.year})` : ''} = ${t.id}`;
}

/**
 * A title id from what the owner typed: an id (movie-467905, tv-247718, any case) is taken as is;
 * words go through the read model's text search. One hit, or one hit whose name equals the words,
 * wins; otherwise not_found / ambiguous.
 */
async function resolveTitleId(db: Db, ctx: ReadContext, query: string): Promise<string> {
  const q = query.trim();
  if (TITLE_ID.test(q)) return q.toLowerCase();
  const hits = await listTitles(db, { q, limit: 6 }, ctx);
  if (hits.length === 0) {
    throw new MovieToolError(
      'not_found',
      `no title in the library matches "${q}". movies_list lists titles; movies_person finds films that are not in the library.`,
    );
  }
  const exact = hits.filter((t) => normalizedTitle(t.title) === normalizedTitle(q));
  const only = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : undefined;
  if (only !== undefined) return only.id;
  throw new MovieToolError(
    'ambiguous',
    `"${q}" fits several titles: ${hits.map(describeCandidate).join('; ')}. Call again with one id as title.`,
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 1500 -> "25:00", 4000 -> "1:06:40". */
function clock(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function continueMessage(r: ContinueResult): string {
  switch (r.action) {
    case 'resumed':
      return `Opened VLC on the owner's screen (this machine): ${r.title.title}, resumed at ${clock(r.position)}. file is what is playing.`;
    case 'started':
      return `Opened VLC on the owner's screen (this machine): ${r.title.title}, from the start of file (the next episode, or a film not started yet).`;
    case 'missing':
      return `Nothing was played. ${r.title.title}: missing is the next episode, which has no file on this machine; present lists the later episodes that do. Tell the owner both.`;
    case 'nothing':
      return `Nothing was played: ${r.title.title} has nothing to continue (${r.reason === 'finished' ? 'already finished' : r.reason === 'caught_up' ? 'no episode after the last one watched' : 'no episodes known'}).`;
    case 'ambiguous':
      return `Nothing was played: "${r.query}" fits several titles (candidates). Ask which one, then call again with its id.`;
    case 'no_match':
      return r.query === null ? 'Nothing was played: there is no play event to continue.' : `Nothing was played: no title in the library matches "${r.query}".`;
  }
}

function continueUrl(r: ContinueResult, titleUrl: (id: string) => string): string | null {
  return r.action === 'ambiguous' || r.action === 'no_match' ? null : titleUrl(r.title.id);
}

type MarkRequest =
  | { target: 'title'; title: string; watched?: boolean; rating?: number | null; review?: string }
  | { target: 'file'; fileId: number; watched: boolean };

interface MarkArgs {
  title?: string | undefined;
  file_id?: number | undefined;
  watched?: boolean | undefined;
  rating?: number | null | undefined;
  review?: string | undefined;
}

/** The one place movies_mark's arguments are checked: a title takes any mark, a file only watched. */
function markRequest(args: MarkArgs): MarkRequest {
  const { title, file_id: fileId, watched, rating, review } = args;
  if ((title === undefined) === (fileId === undefined)) {
    throw new MovieToolError('invalid_input', 'pass exactly one of title (a title id or name) or file_id (one file, from movies_get files[].id).');
  }
  if (fileId !== undefined) {
    if (rating !== undefined || review !== undefined) {
      throw new MovieToolError('invalid_input', 'rating and review belong to a title, not a file: pass title instead of file_id.');
    }
    if (watched === undefined) throw new MovieToolError('invalid_input', 'file_id needs watched (true or false).');
    return { target: 'file', fileId, watched };
  }
  if (title === undefined) throw new MovieToolError('invalid_input', 'pass title or file_id.');
  if (watched === undefined && rating === undefined && review === undefined) {
    throw new MovieToolError('invalid_input', 'nothing to change: pass watched, rating or review.');
  }
  return {
    target: 'title',
    title,
    ...(watched !== undefined ? { watched } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(review !== undefined ? { review } : {}),
  };
}

interface MergedCredit {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  roles: string[];
  cast: boolean;
  crew: boolean;
}

function roleText(c: TmdbPersonCredit): string {
  if (c.credit === 'cast') return c.character ? `cast as ${c.character}` : 'cast';
  return c.job ?? 'crew';
}

/** TMDB lists a person once per role; one entry per title, roles merged, newest release first, undated last. */
function mergeCredits(credits: readonly TmdbPersonCredit[]): MergedCredit[] {
  const byTitle = new Map<string, MergedCredit>();
  for (const c of credits) {
    const key = `${c.kind}:${c.tmdbId}`;
    const entry =
      byTitle.get(key) ??
      { kind: c.kind, tmdbId: c.tmdbId, title: c.title, releaseDate: c.releaseDate, roles: [], cast: false, crew: false };
    const role = roleText(c);
    if (!entry.roles.includes(role)) entry.roles.push(role);
    if (c.credit === 'cast') entry.cast = true;
    else entry.crew = true;
    byTitle.set(key, entry);
  }
  return [...byTitle.values()].sort((a, b) => {
    if (a.releaseDate === b.releaseDate) return a.title.localeCompare(b.title);
    if (a.releaseDate === null) return 1;
    if (b.releaseDate === null) return -1;
    return a.releaseDate < b.releaseDate ? 1 : -1;
  });
}

const titleField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('A title id like movie-467905 or tv-247718 (from these tools; never invent one), or the title in words, e.g. "mobland".');

const dateField = (what: string) =>
  z
    .string()
    .optional()
    .describe(`${what}: YYYY-MM-DD (a whole day in the daemon's timezone) or an ISO 8601 datetime.`);

const LIST_DESCRIPTION =
  "The owner's movie and TV library (files on both laptops, titles shared). Finds titles by words in the title or synopsis (q), production company (company, e.g. \"Blumhouse\"), a person in the cast or crew (person, e.g. \"Margaret Qualley\"), kind (movie | tv), state, and the day the owner finished it (finished_from / finished_to; giving either keeps only finished titles). " +
  '"Blumhouse films I have seen this year" is company "Blumhouse" with finished_from = 1 January and finished_to = today. ' +
  'Returns { count, titles: [{ id, kind, title, year, release_date, state, finished_at, last_played_at, rating, watched_at, companies, available, poster_url, url, ... }] }. ' +
  "id is movie-<tmdb id> or tv-<tmdb id>; url opens the title on the owner's wall. state: finished (the watched flag, moved into a Done folder, or played to 90%), in_progress, unwatched, dropped (file deleted partway), removed_unwatched (file deleted, never played), seen (opened in VLC, position unknown). " +
  'Dates are ISO 8601 UTC. available: false means no file of it is on this machine. Then call movies_get for episodes, files and plays.';

const GET_DESCRIPTION =
  'One title of the owner\'s library, by id (movie-467905, tv-247718) or by name ("mobland"; a name that fits several titles answers ambiguous with the candidates\' ids). ' +
  'Returns the title (title, year, release_date, overview, genres, companies, credits: directors, writers, producers, creators and cast with character names, rating 0-5, watched_at, review_note_id and the review, state, poster_url, url), ' +
  'seasons (a series: seasons[].episodes[] with season, episode, name, air_date, state, deleted and progress per episode), files (every file ever seen, deleted ones too: id, host, path, season, episode, duration_s, state, available, first_seen_at, deleted_at = when the owner deleted it, done_at = moved into a Done folder, watched_at, last_play) ' +
  'and plays (every play event, newest first: started_at, ended_at, position_s reached, duration_s, season, episode, episode_name, source "live" = VLC started by notesd or "vlc_recents" = read from VLC\'s recent list). ' +
  'last_play is the newest play: "which MobLand episode did I watch last and when" is last_play.season / episode / episode_name / started_at, and it survives the file\'s deletion. ' +
  'Positions and durations are seconds; dates are ISO 8601 UTC. available: false means that file is on the other laptop (host).';

const HISTORY_DESCRIPTION =
  "The owner's play events across the library, newest first: { count, plays: [{ started_at, ended_at, position_s, duration_s, ratio, source, host, title_id, title, kind, file_id, season, episode, episode_name, file_deleted, file_deleted_at, url }] }. " +
  'from / to filter on started_at ("what did I watch last night" is from = yesterday). title narrows to one title (id or name). ' +
  'A play outlives its file: file_deleted_at says when the file was deleted. position_s null means VLC was opened but the position is unknown. Dates are ISO 8601 UTC; positions are seconds.';

const CONTINUE_DESCRIPTION =
  "Plays something in VLC on the owner's screen, on the machine that runs this server: VLC opens and notesd records the play, so call it only when the owner asked to play, resume or continue something. " +
  'With title (id or name; "continue MobLand"): resumes the latest unfinished episode or film from where it stopped; else starts the next episode whose file is on this machine; else plays nothing and answers which next episode is missing (missing) and which later episodes are present (present). ' +
  'Without title ("continue what I watched last night"): the same for the title of the newest play event. ' +
  'Returns { action: resumed | started | missing | nothing | ambiguous | no_match, message, title, file, position (the second it starts at), missing, present, reason, candidates, url }. ambiguous lists candidates (call again with one id); no_match means nothing fits (or, without title, nothing was ever played). ' +
  'Errors: not_on_this_machine (the file is on the other laptop: play it there), player_unavailable (VLC cannot be started here), file_missing (the library lists the file but it is not on disk: a bug, tell the owner), not_found and ambiguous (no single title matches).';

const PERSON_DESCRIPTION =
  'A person\'s filmography from TMDB with each entry marked against the owner\'s library, for recommendations ("recommend other Margaret Qualley films", "what else did this director make"). ' +
  'name finds the person (the most popular match); other_people lists others with a similar name, and person_id picks one of them. ' +
  "Returns { person: { id, name, known_for }, other_people, counts: { credits, in_library, seen }, credits: [{ kind, tmdb_id, title_id, title, release_date, roles (\"cast as Sue\", \"Director\", ...), in_library, state, seen, started, url, tmdb_url }] }, newest release first. " +
  'seen: true when the owner finished the title or opened it (state finished or seen); started: true when they began it and did not finish (in_progress, dropped); in_library: false means it is not in the library at all, so seen is false and url is null. ' +
  'role "cast" or "crew" narrows the list; unseen_only drops what the owner has seen. Recommend from seen: false entries and use web search for reviews or anything newer than TMDB lists. ' +
  'Reads TMDB over the network: tmdb_unavailable means this server has no TMDB credentials, tmdb_error that TMDB could not be reached.';

const MARK_DESCRIPTION =
  "Sets the owner's own marks. On a title (title = id or name): watched (true sets the watched flag, which makes the title finished even when the credits were skipped; false clears it), rating (0-5 stars as a whole number; null clears it) and review (plain text; saved as a note tagged #movie and linked to the title, so it is searchable like any note; it replaces the earlier review). " +
  'On one file (file_id from movies_get files[].id, e.g. one episode): watched only. Pass exactly one of title or file_id, and at least one change. ' +
  'Returns { title_id, title, state, watched_at, rating, review_note_id, url } after the change, plus file for file_id.';

/** The six movie tools. With deps.movies null or omitted every one answers MOVIES_OFF. */
export function registerMovieTools(server: McpServer, deps: Pick<ToolDeps, 'db' | 'movies' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  const titleUrl = (id: string): string => `${wall}/movies/${encodeURIComponent(id)}`;
  const off = (): CallToolResult => fail(MOVIES_OFF);
  const ctxOf = (m: MovieToolDeps): ReadContext => ({ host: m.host, imageBase: m.imageBase });

  server.registerTool(
    LIST,
    {
      title: 'List movie and TV titles',
      description: LIST_DESCRIPTION,
      inputSchema: {
        q: z.string().trim().min(1).max(200).optional().describe('Words in the title or synopsis.'),
        company: z.string().trim().min(1).max(120).optional().describe('A production company by name, e.g. "Blumhouse" (part of the name is enough).'),
        person: z.string().trim().min(1).max(120).optional().describe('A person in the cast or crew by name, e.g. "Margaret Qualley".'),
        kind: z.enum(['movie', 'tv']).optional().describe('"movie" or "tv" (a series).'),
        state: z.enum(WATCH_STATES).optional().describe('Only titles in this state (see the description).'),
        finished_from: dateField('Finished on or after this day'),
        finished_to: dateField('Finished on or before this day (the whole day is included)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MOVIES_LIST_MAX_LIMIT)
          .optional()
          .describe(`At most this many titles, 1-${MOVIES_LIST_MAX_LIMIT}. Default ${MOVIES_LIST_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const m = deps.movies;
      if (!m) return off();
      return answer(async () => {
        const filter: TitleFilter = { limit: args.limit ?? MOVIES_LIST_DEFAULT_LIMIT };
        if (args.q !== undefined) filter.q = args.q;
        if (args.company !== undefined) filter.company = args.company;
        if (args.person !== undefined) filter.person = args.person;
        if (args.kind !== undefined) filter.kind = args.kind;
        if (args.state !== undefined) filter.state = args.state;
        if (args.finished_from !== undefined) filter.finishedFrom = parseDateBound(args.finished_from, 'from');
        if (args.finished_to !== undefined) filter.finishedTo = parseDateBound(args.finished_to, 'to');
        const titles = await listTitles(deps.db, filter, ctxOf(m));
        return {
          count: titles.length,
          titles: titles.map((t) => ({ ...t, url: titleUrl(t.id) })),
          next:
            titles.length > 0
              ? 'Call movies_get with an id for episodes, files and plays; link titles with their url.'
              : 'No title matched. Try fewer filters, other words, or movies_person for films outside the library.',
        };
      });
    },
  );

  server.registerTool(
    GET,
    {
      title: 'Get one movie or series',
      description: GET_DESCRIPTION,
      inputSchema: { title: titleField },
      annotations: { readOnlyHint: true },
    },
    async ({ title }) => {
      const m = deps.movies;
      if (!m) return off();
      return answer(async () => {
        const id = await resolveTitleId(deps.db, ctxOf(m), title);
        const detail = await getTitle(deps.db, id, ctxOf(m));
        if (detail === null) throw new MovieToolError('not_found', `no title ${id} in the library.`);
        return { ...detail, last_play: detail.plays[0] ?? null, url: titleUrl(detail.id) };
      });
    },
  );

  server.registerTool(
    HISTORY,
    {
      title: 'Movie watch history',
      description: HISTORY_DESCRIPTION,
      inputSchema: {
        from: dateField('Plays that started on or after this'),
        to: dateField('Plays that started on or before this (a whole day is included)'),
        title: titleField.optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MOVIES_HISTORY_MAX_LIMIT)
          .optional()
          .describe(`At most this many plays, 1-${MOVIES_HISTORY_MAX_LIMIT}. Default ${MOVIES_HISTORY_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const m = deps.movies;
      if (!m) return off();
      return answer(async () => {
        // No host filter: plays from both laptops are history.
        const filter: HistoryFilter = { limit: args.limit ?? MOVIES_HISTORY_DEFAULT_LIMIT };
        if (args.from !== undefined) filter.from = parseDateBound(args.from, 'from');
        if (args.to !== undefined) filter.to = parseDateBound(args.to, 'to');
        if (args.title !== undefined) filter.titleId = await resolveTitleId(deps.db, ctxOf(m), args.title);
        const plays = await history(deps.db, filter);
        return { count: plays.length, plays: plays.map((p) => ({ ...p, url: p.title_id === null ? null : titleUrl(p.title_id) })) };
      });
    },
  );

  server.registerTool(
    CONTINUE,
    {
      title: 'Continue watching in VLC',
      description: CONTINUE_DESCRIPTION,
      inputSchema: {
        title: titleField
          .optional()
          .describe('The title to continue, as an id or in words ("mobland"). Omit to continue whatever was played last.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title }) => {
      const m = deps.movies;
      if (!m) return off();
      return answer(async () => {
        const result = await m.continueTitle(title ?? null);
        return { ...result, message: continueMessage(result), url: continueUrl(result, titleUrl) };
      });
    },
  );

  server.registerTool(
    PERSON,
    {
      title: "A person's filmography, marked seen or not",
      description: PERSON_DESCRIPTION,
      inputSchema: {
        name: z.string().trim().min(1).max(120).describe('The person\'s name, e.g. "Margaret Qualley".'),
        person_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('A TMDB person id from other_people, to pick that person instead of the most popular match.'),
        role: z.enum(['any', 'cast', 'crew']).optional().describe('"cast" (acted in), "crew" (directed, wrote, produced, ...) or "any" (default).'),
        unseen_only: z.boolean().optional().describe('true: leave out the titles the owner has seen.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MOVIES_PERSON_MAX_LIMIT)
          .optional()
          .describe(`At most this many credits, 1-${MOVIES_PERSON_MAX_LIMIT}. Default ${MOVIES_PERSON_DEFAULT_LIMIT}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const m = deps.movies;
      if (!m) return off();
      return answer(async () => {
        const tmdb = m.tmdb;
        if (tmdb === null) {
          throw new MovieToolError(
            'tmdb_unavailable',
            'this server has no TMDB credentials (TMDB_API_READ_ACCESS_TOKEN or TMDB_API_KEY), so filmographies cannot be looked up. Use web search instead.',
          );
        }
        const people = await tmdb.searchPerson(args.name);
        const person =
          args.person_id !== undefined
            ? (people.find((p) => p.personId === args.person_id) ?? { personId: args.person_id, name: args.name, knownFor: null })
            : people[0];
        if (person === undefined) throw new MovieToolError('not_found', `TMDB knows no person named "${args.name}".`);

        const merged = mergeCredits(await tmdb.personCredits(person.personId));
        const ids = merged.map((c) => titleId(c.kind, c.tmdbId));
        const inLibrary =
          ids.length === 0
            ? []
            : await deps.db.select({ id: movieTitles.id }).from(movieTitles).where(inArray(movieTitles.id, ids));
        const states = new Map<string, WatchState>();
        await Promise.all(
          inLibrary.slice(0, PERSON_STATE_LOOKUPS).map(async ({ id }) => {
            const detail = await getTitle(deps.db, id, ctxOf(m));
            if (detail !== null) states.set(id, detail.state);
          }),
        );
        const libraryIds = new Set(inLibrary.map((r) => r.id));

        const all = merged.map((c) => {
          const id = titleId(c.kind, c.tmdbId);
          const state = states.get(id) ?? null;
          const inLib = libraryIds.has(id);
          return {
            kind: c.kind,
            tmdb_id: c.tmdbId,
            title_id: id,
            title: c.title,
            release_date: c.releaseDate,
            roles: c.roles,
            cast: c.cast,
            crew: c.crew,
            in_library: inLib,
            state,
            seen: state !== null && SEEN_STATES.has(state),
            started: state !== null && STARTED_STATES.has(state),
            url: inLib ? titleUrl(id) : null,
            tmdb_url: `https://www.themoviedb.org/${c.kind}/${c.tmdbId}`,
          };
        });
        const role = args.role ?? 'any';
        const credits = all
          .filter((c) => role === 'any' || (role === 'cast' ? c.cast : c.crew))
          .filter((c) => !(args.unseen_only ?? false) || !c.seen)
          .slice(0, args.limit ?? MOVIES_PERSON_DEFAULT_LIMIT)
          .map(({ cast: _cast, crew: _crew, ...rest }) => rest);

        return {
          person: { id: person.personId, name: person.name, known_for: person.knownFor },
          other_people: people
            .filter((p) => p.personId !== person.personId)
            .slice(0, 4)
            .map((p) => ({ id: p.personId, name: p.name, known_for: p.knownFor })),
          counts: { credits: all.length, in_library: all.filter((c) => c.in_library).length, seen: all.filter((c) => c.seen).length },
          credits,
        };
      });
    },
  );

  server.registerTool(
    MARK,
    {
      title: 'Mark a title watched, rate or review it',
      description: MARK_DESCRIPTION,
      inputSchema: {
        title: titleField.optional(),
        file_id: z.number().int().positive().optional().describe('One file (an episode), from movies_get files[].id. Takes watched only.'),
        watched: z.boolean().optional().describe('true: set the watched flag; false: clear it.'),
        rating: z.number().int().min(0).max(5).nullable().optional().describe('Stars, 0-5, whole numbers. null clears the rating.'),
        review: z
          .string()
          .trim()
          .min(1)
          .max(MOVIES_REVIEW_MAX_CHARS)
          .optional()
          .describe("The owner's review as plain text. Replaces the earlier review; saved as a note tagged #movie."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const m = deps.movies;
      if (!m) return off();
      return answer(async () => {
        const req = markRequest(args);
        if (req.target === 'file') {
          const rows = await deps.db
            .select({ titleId: movieFiles.titleId })
            .from(movieFiles)
            .where(eq(movieFiles.id, req.fileId))
            .limit(1);
          const row = rows[0];
          if (row === undefined) throw new MovieToolError('not_found', `no file ${req.fileId}. File ids come from movies_get files[].id.`);
          if (row.titleId === null) {
            throw new MovieToolError('unmatched_file', `file ${req.fileId} is not matched to a title yet; the owner can assign it from the unmatched list on the wall's Movies page.`);
          }
          await m.setFileWatched(req.fileId, req.watched);
          const detail = await getTitle(deps.db, row.titleId, ctxOf(m));
          if (detail === null) throw new MovieToolError('not_found', `no title ${row.titleId} in the library.`);
          return {
            title_id: detail.id,
            title: detail.title,
            state: detail.state,
            url: titleUrl(detail.id),
            file: detail.files.find((f) => f.id === req.fileId) ?? null,
          };
        }
        const id = await resolveTitleId(deps.db, ctxOf(m), req.title);
        const patch: TitleUserPatch = {};
        if (req.watched !== undefined) patch.watched = req.watched;
        if (req.rating !== undefined) patch.rating = req.rating;
        if (patch.watched !== undefined || patch.rating !== undefined) await m.setTitleUser(id, patch);
        if (req.review !== undefined) await m.saveReview(id, req.review);
        const detail = await getTitle(deps.db, id, ctxOf(m));
        if (detail === null) throw new MovieToolError('not_found', `no title ${id} in the library.`);
        return {
          title_id: detail.id,
          title: detail.title,
          state: detail.state,
          watched_at: detail.watched_at,
          rating: detail.rating,
          review_note_id: detail.review_note_id,
          url: titleUrl(detail.id),
        };
      });
    },
  );
}
```
**Impact:** new file; nothing calls it until Step 4. `resolveTitleId` makes a missing title for `movies_mark` fail before any write (the title must resolve first). `movies_continue` hands the raw title text to `continueTitle`, which resolves it itself (phase 5 owns that rule), so the tool and `POST /api/movies/continue` resolve titles the same way.

### Step 3: `ToolDeps.movies`
**File:** `src/mcp/tools.ts:13` (imports) and `:35-37` (end of `ToolDeps`)
**Change:** type-only import of `MovieToolDeps` (a type-only cycle with `movieTools.ts`, which imports `run`-style helpers from here; erased at runtime, as `AdversaryService` already is), and one field.
**Code:**

After line 13 (`import type { AdversaryService } …`):
```ts
import type { MovieToolDeps } from './movieTools.js';
```

Replace lines 35-37:
```ts
  /** Seer Adversarial reviewer (phase 4) for adversary_overview's `reviewer`. Omitted or null: reported as null. */
  adversary?: AdversaryService | null;
  /** The movie library behind the movies_* tools (MOVIES_LIBRARY_PLAN phase 7). Omitted or null: every movie tool answers movies_off. */
  movies?: MovieToolDeps | null;
}
```
**Impact:** optional field; every existing `ToolDeps` literal still compiles.

### Step 4: Register the tools
**File:** `src/mcp/server.ts:5` (imports) and `:27` (after `registerAdversaryTools`)
**Change:**
After line 5 add:
```ts
import { registerMovieTools } from './movieTools.js';
```
Replace lines 26-28:
```ts
  // Seer Adversarial (phase 5): read-only, reads Seer through the connector per call.
  registerAdversaryTools(server, deps);
  // Movies (MOVIES_LIBRARY_PLAN phase 7). Answer movies_off when deps.movies is unset.
  registerMovieTools(server, deps);
  return server;
```
**Impact:** `/mcp` lists six more tools. Existing `listTools` assertions use `arrayContaining` or only check for `purge|forever|destroy` names (`tests/integration/bin.int.test.ts:409`, `images.attach.int.test.ts:380`, `connectors/mcp.int.test.ts:48`), so none breaks. `tests/unit/connectors/failsoft.test.ts:75` builds its own server with connector tools only and is not affected.

### Step 5: `mcpToolDeps` carries the movie deps
**File:** `src/http/app.ts:65-82` (line numbers are today's; phase 1 adds the two movie router imports and mounts above and below it, which shifts them by a few lines)
**Change:** import `movieToolDeps` and set `movies`.
**Code:**
Add next to the other `../mcp/*` imports (after `import type { ToolDeps } from '../mcp/tools.js';`):
```ts
import { movieToolDeps } from '../mcp/movieTools.js';
```
Replace the body of `mcpToolDeps`:
```ts
export function mcpToolDeps(
  deps: AppDeps,
  sessionOverrides?: SessionsReadOverrides,
  extra: { sessionResume?: SessionResumer } = {},
): ToolDeps {
  const wallUrl = wallUrlForPort(deps.config.port);
  return {
    service: deps.service,
    dataDir: deps.config.dataDir,
    db: deps.db,
    imageEmbedder: deps.imageEmbedder ?? null,
    chatUploads: dbChatUploadSource(deps.db, deps.config.dataDir),
    sessions: sessionsReadDeps(deps, sessionOverrides),
    adversary: deps.adversary,
    movies: movieToolDeps(deps),
    ...(wallUrl !== undefined ? { wallUrl } : {}),
    ...(extra.sessionResume !== undefined ? { sessionResume: extra.sessionResume } : {}),
  };
}
```
Also extend the doc comment above it with one sentence: `` `movies` is null while the movie library is off; building it does no I/O. ``
**Impact:** `tests/unit/mcp.instructions.test.ts:188` casts a partial `AppDeps` without `movies`; `movieToolDeps` returns null for `undefined`, so it still passes.

### Step 6: The Movies paragraph in the MCP instructions
**File:** `src/mcp/instructions.ts:22-28` (docstring) and between line 57 (`Connectors.`) and line 58 (`Adversary.`)
**Change:** one new section. It must sit before `Adversary.` because `tests/unit/mcp.instructions.test.ts:271` requires Adversary immediately before Sessions and `:134` requires Sessions last.
**Code:**

Docstring, replace the sentence ending in "inserts the Adversary paragraph before Sessions." with:
```ts
 * paragraph (last); seer-adversarial phase 5 inserts the Adversary paragraph before Sessions;
 * movies-library phase 7 inserts the Movies paragraph after Connectors, before Adversary.
```

Insert as a new array element after the `Connectors.` element:
```ts
    `Movies. The same server keeps the user's movie and TV library: titles (ids movie-<tmdb id> and tv-<tmdb id>; they come from these tools, never invent one) with TMDB metadata, studios, cast and crew; every video file on each laptop, with season, episode, host, and deleted_at once the user deleted it (a title and its history outlive its files); and every play event, with when it happened and the position reached. States: finished (the watched flag, moved into a Done folder, or played to 90%), in_progress, unwatched, dropped (deleted partway), removed_unwatched (deleted, never played), seen (opened in VLC, position unknown). movies_list(q?, company?, person?, kind?, state?, finished_from?, finished_to?) finds titles: "Blumhouse films I saw this year" is company "Blumhouse" with finished_from and finished_to. movies_get(title) returns one title with its episodes and episode names, its files (deleted ones too) and its plays newest first, and last_play answers "which MobLand episode did I watch last and when". movies_history(from?, to?, title?) lists play events newest first. movies_continue(title?) opens VLC on the user's screen on the machine that runs this server: it resumes the latest unfinished episode or film where it stopped, else starts the next episode whose file is here, else plays nothing and says which episode is missing and which later ones are present; without title it continues whatever was played last ("continue what I watched last night"). Call it only when the user asks to play, resume or continue. movies_person(name) returns a person's TMDB filmography with each entry marked in_library and seen, for recommendations: suggest the unseen ones and use web search for anything newer. movies_mark sets the watched flag, a 0-5 star rating or a review on a title (the review is a note tagged #movie), or the watched flag on one file. available: false means a file is on the other laptop (host); not_on_this_machine means play it there. When you mention a title, link it as [Title](${wall}/movies/<title id>); every result carries that link as url. A chat turn whose first line starts with [Movies was asked from the wall's Movies page; a title id on that line is the title the user has open.`,
```
**Impact:** every MCP session reads one more paragraph (~2 KB).

### Step 7: The movies section of the chat system prompt
**File:** `src/chat/prompt.ts:25` (after the daily-words section, before the `Today is …` section)
**Change:** insert one array element.
**Code:**
```ts
    // MOVIES_LIBRARY_PLAN phase 7. Tool names match src/mcp/movieTools.ts and MOVIE_TOOL_NAMES.
    `The owner's movie and TV library is open to you too, through movies_* tools on the same server. movies_list finds titles by words, studio, person, kind, state and the day they were finished; movies_get returns one title with its episodes, its files (deleted ones too) and its plays, and last_play says which episode was watched last and when; movies_history lists what was watched when; movies_person gives an actor's or director's TMDB filmography with each entry marked seen or not, for recommendations (recommend the unseen ones and use WebSearch for anything newer); movies_mark sets the watched flag, a 0-5 star rating or a review. movies_continue opens VLC on the owner's screen, so call it only when the owner asks to play, resume or continue something ("continue MobLand"; "continue what I watched last night" is movies_continue with no title), then say which title and episode it opened, or which episode is missing and which later ones are there. Name titles with their year, never by id alone. A message whose first line starts with [Movies was asked from the Movies page; a title id on that line (movie-123, tv-456) is the title the owner has open.`,
```
**Impact:** the chat bar's system prompt grows by one paragraph.

### Step 8: The `/n` skill
**File:** `claude/skills/n/SKILL.md:3` (frontmatter `description`) and after line 300 (end of `## Sessions`, before `## Deleting` at 302)
**Change:** the description mentions the movie library and two example asks, so `/n` triggers on them; a new `## Movies` section says which tool answers which question.
**Code:**

Replace line 3 with:
```markdown
description: The user's personal notes system, mcp-notes, reached through the `notes` MCP server, which also reads the user's own apps read-only — expense-tracking (spending in rupiah), run-insights (Apple Watch runs, the app's run analyses and weekly/monthly reviews, coach Nina) and Seer (trading lab, leaderboard, positions, Sera methods) — and keeps their movie and TV library (what they watched and when, VLC playback). Use whenever the user types "/n <request>" from any repo, and when they ask to save, find, read, edit, tag, delete, restore, compare or summarize their notes or look at, attach or remove pictures in them, or link a note to a Claude Code session ("save this session's insights as a note", "what was my last #v250 note", "check note A-B32", "summarize #seer this week vs last week", "show me the pictures I saved on 30 oct", "show me the pictures in note A-B32", "attach this screenshot to note A-B32", "link 5-BW7 into 5U-I7"), or ask about their spending, expenses, runs or Seer ("how is my spending this week", "how did yesterday's run go", "compare my running this month with last month", "what are the best Sera methods so far", "what's on the Seer leaderboard"), or about their movies and series ("which MobLand episode did I watch last", "continue MobLand", "recommend other Margaret Qualley films").
```

Insert after line 300:
```markdown

## Movies

The same server keeps the user's movie and TV library: every title (id `movie-<tmdb id>` or
`tv-<tmdb id>`; never invent one) with its TMDB metadata, studios, cast and crew; every video
file on each laptop, with season, episode, `host`, and `deleted_at` once the user deleted it;
and every play event (when, and to what position). A title and its history outlive its files,
so "what did I watch" still answers after the file is gone.

- "What Blumhouse films have I seen this year", "my unfinished series", "which films with
  Margaret Qualley do I have" → `movies_list` (`company`, `person`, `kind`, `state`,
  `finished_from` / `finished_to`, `q`). Dates are `YYYY-MM-DD`, like every other date filter.
- "Which MobLand episode did I watch last and when", "how far am I in X", "is X still on
  disk" → `movies_get` with the title's name or id. `last_play` answers "last watched"
  (season, episode, episode name, `started_at`, `position_s`); `files[].deleted_at` says when a
  file was deleted; `plays` are newest first.
- "What did I watch last week" → `movies_history` with `from` / `to`.
- "Continue MobLand", "resume X", "play the next episode", and "continue what I watched last
  night" (no title) → `movies_continue`. It opens VLC on the user's screen on this machine, so
  call it only when they asked to play something. `action` says what happened: `resumed` (from
  `position` seconds), `started` (the next episode, or a film from the start), `missing`
  (nothing played: `missing` is the next episode with no file here and `present` the later ones
  that are here; tell the user both), `nothing`. `not_on_this_machine` means the file is on the
  other laptop; `file_missing` means the library thinks the file is there but it is not on disk:
  say it is a bug.
- "Recommend other Margaret Qualley films", "what else did this director make" →
  `movies_person` with the name, then `WebSearch` for reviews or anything newer than TMDB.
  Recommend entries with `seen: false`, and say which ones they have already seen. When
  `other_people` lists someone else with the same name, make sure you have the right person
  (pass `person_id`).
- "Mark X watched", "rate X 4 stars", "my review of X: ..." → `movies_mark`. The review is a
  normal note tagged `#movie`, linked to the title; one episode's watched flag goes on its
  `file_id` (from `movies_get`).
- When you mention a title, link it with the `url` the tool returned, e.g.
  `[MobLand](<wall>/movies/tv-247718)`.
- `movies_off` means the movie library is not running on this daemon; say so in one line.
```
**Impact:** the skill is symlinked into `~/.claude/skills` by `scripts/install.sh`, so the live `/n` picks it up after the next install (phase 8 or the "p" flow runs it).

### Step 9: Update the chat status test
**File:** `tests/unit/chat-status.test.ts:3-44`
**Change:** import `MOVIE_TOOL_NAMES`, count 56, assert every movie name is allowed, add a caption test.
**Code:**
Replace lines 3-10:
```ts
import {
  ADVERSARY_TOOL_NAMES,
  DWORD_TOOL_NAMES,
  MOVIE_TOOL_NAMES,
  NOTES_TOOL_NAMES,
  SESSION_TOOL_NAMES,
  allowedChatTools,
  captionForToolUse,
} from '../../src/chat/status.js';
```
Replace lines 15-22:
```ts
  it('is exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 6 movie tools, the 21 connector tools, WebSearch and WebFetch', () => {
    const tools = allowedChatTools();
    expect(NOTES_TOOL_NAMES).toHaveLength(19);
    expect(SESSION_TOOL_NAMES).toHaveLength(5);
    expect(ADVERSARY_TOOL_NAMES).toHaveLength(3);
    expect(MOVIE_TOOL_NAMES).toHaveLength(6);
    expect(ALL_CONNECTOR_TOOL_NAMES).toHaveLength(21);
    expect(tools).toHaveLength(19 + 5 + 3 + 6 + 21 + 2);
    expect(new Set(tools).size).toBe(tools.length);
```
After line 32 (`for (const name of ADVERSARY_TOOL_NAMES) …`) add:
```ts
    for (const name of MOVIE_TOOL_NAMES) expect(tools).toContain(n(name));
```
After the `captions the adversary tools` test (line 44) add:
```ts
  it('captions the movie tools', () => {
    expect(captionForToolUse(n('movies_list'), { company: 'Blumhouse' })).toBe('searching movies');
    expect(captionForToolUse(n('movies_get'), { title: 'mobland' })).toBe('reading a title');
    expect(captionForToolUse(n('movies_history'), {})).toBe('reading watch history');
    expect(captionForToolUse(n('movies_continue'), {})).toBe('opening VLC');
    expect(captionForToolUse(n('movies_person'), { name: 'Margaret Qualley' })).toBe('reading a filmography');
    expect(captionForToolUse(n('movies_mark'), { title: 'tv-247718', rating: 4 })).toBe('marking a title');
  });
```

### Step 10: Instructions and prompt tests
**File:** `tests/unit/mcp.instructions.test.ts:273` (append at end of file), `tests/unit/chat-prompt.test.ts:155` (inside the outer `describe`, before its closing `});`)
**Code:**

Append to `tests/unit/mcp.instructions.test.ts`:
```ts
describe('buildInstructions: Movies', () => {
  it('has one Movies paragraph after Connectors and before Adversary, naming the six tools and the wall link', () => {
    const text = buildInstructions('Asia/Jakarta', 'http://localhost:4321');
    const paragraphs = text.split('\n\n').filter((p) => p.startsWith('Movies.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['movies_list', 'movies_get', 'movies_history', 'movies_continue', 'movies_person', 'movies_mark', 'last_play', 'never invent', 'not_on_this_machine', 'opens VLC']) {
      expect(p).toContain(word);
    }
    expect(p).toContain('[Title](http://localhost:4321/movies/<title id>)');
    const order = text.split('\n\n').map((s) => s.split('.')[0]);
    expect(order.indexOf('Movies')).toBe(order.indexOf('Connectors') + 1);
    expect(order.indexOf('Adversary')).toBe(order.indexOf('Movies') + 1);
    expect(order.at(-1)).toBe('Sessions');
  });
});
```

Insert into `tests/unit/chat-prompt.test.ts` before the last `});`:
```ts

  it('names the movie tools and keeps movies_continue for explicit play requests', () => {
    for (const name of ['movies_list', 'movies_get', 'movies_history', 'movies_continue', 'movies_person', 'movies_mark']) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toMatch(/movies_continue opens VLC on the owner's screen, so call it only when the owner asks to play, resume or continue something/);
    expect(prompt).toMatch(/"continue what I watched last night" is movies_continue with no title/);
  });
```

### Step 11: Unit tests for the tools (no database)
**File:** `tests/unit/mcp.movieTools.test.ts` (new)
**Change:** drives the registered tools through an in-memory MCP client. Every case here returns before the read model touches `db`, so `{} as Db` is safe.
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { MOVIE_TOOL_NAMES } from '../../src/chat/status.js';
import type { Db } from '../../src/db/client.js';
import { MOVIES_OFF, registerMovieTools, type MovieToolDeps } from '../../src/mcp/movieTools.js';
import type { ContinueResult } from '../../src/movies/continue.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function fakeMovies(over: Partial<MovieToolDeps> = {}): MovieToolDeps {
  return {
    host: 'this-host',
    imageBase: 'https://image.tmdb.org/t/p',
    tmdb: null,
    setTitleUser: vi.fn(async () => {}),
    setFileWatched: vi.fn(async () => {}),
    saveReview: vi.fn(async () => null),
    continueTitle: vi.fn(async (): Promise<ContinueResult> => ({ action: 'no_match', query: null })),
    ...over,
  };
}

async function connect(movies: MovieToolDeps | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerMovieTools(server, { db: {} as Db, movies, wallUrl: 'http://localhost:7317/' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  movies_list: {},
  movies_get: { title: 'mobland' },
  movies_history: {},
  movies_continue: {},
  movies_person: { name: 'Margaret Qualley' },
  movies_mark: { title: 'mobland', watched: true },
};

describe('movie MCP tools without a database', () => {
  it('registers exactly the six names; only movies_continue and movies_mark write', async () => {
    const c = await connect(fakeMovies());
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MOVIE_TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(t.name !== 'movies_continue' && t.name !== 'movies_mark');
      expect(t.description?.length ?? 0).toBeGreaterThan(200);
    }
    expect(tools.find((t) => t.name === 'movies_continue')?.description).toContain("VLC on the owner's screen");
    await c.close();
  });

  it('answers movies_off from every tool while the library is off', async () => {
    const c = await connect(null);
    for (const name of MOVIE_TOOL_NAMES) {
      const r = await c.call(name, MINIMAL_ARGS[name]!);
      expect(r.isError, name).toBe(true);
      expect(text(r)).toBe(MOVIES_OFF);
    }
    await c.close();
  });

  it('movies_continue passes the title or null, and adds a message and the wall link', async () => {
    const continueTitle = vi.fn(
      async (): Promise<ContinueResult> => ({
        action: 'resumed',
        title: { id: 'movie-1002', title: 'A Film', kind: 'movie', year: 2025 },
        file: { file_id: 7, season: null, episode: null, absolute_episode: null, name: null },
        position: 1500,
        play: { play_id: 1, file_id: 7, title_id: 'movie-1002', name: 'A.Film.mkv', start_position: 1500, port: 47318, tracking: true, note: null },
      }),
    );
    const c = await connect(fakeMovies({ continueTitle }));
    const withTitle = await c.call('movies_continue', { title: '  A Film ' });
    expect(withTitle.isError ?? false).toBe(false);
    const body = JSON.parse(text(withTitle)) as { action: string; url: string; message: string; position: number };
    expect(body).toMatchObject({ action: 'resumed', position: 1500, url: 'http://localhost:7317/movies/movie-1002' });
    expect(body.message).toContain('25:00');
    await c.call('movies_continue', {});
    expect(continueTitle.mock.calls).toEqual([['A Film'], [null]]);
    await c.close();
  });

  it('turns a player error into its code with what to do', async () => {
    const continueTitle = vi.fn(async (): Promise<ContinueResult> => {
      throw Object.assign(new Error('file 7 is on gpd'), { code: 'not_on_this_machine' });
    });
    const c = await connect(fakeMovies({ continueTitle }));
    const r = await c.call('movies_continue', { title: 'mobland' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('not_on_this_machine: file 7 is on gpd The file is on the other laptop (its host); play it there.');
    await c.close();
  });

  it('movies_mark refuses contradictory or empty marks before writing anything', async () => {
    const movies = fakeMovies();
    const c = await connect(movies);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ title: 'mobland', file_id: 3, watched: true }, /^invalid_input: pass exactly one of title/],
      [{ watched: true }, /^invalid_input: pass exactly one of title/],
      [{ file_id: 3, rating: 4 }, /^invalid_input: rating and review belong to a title/],
      [{ file_id: 3 }, /^invalid_input: file_id needs watched/],
      [{ title: 'mobland' }, /^invalid_input: nothing to change/],
    ];
    for (const [args, expected] of cases) {
      const r = await c.call('movies_mark', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toMatch(expected);
    }
    const outOfRange = await c.call('movies_mark', { title: 'mobland', rating: 6 });
    expect(outOfRange.isError).toBe(true);
    expect(movies.setTitleUser).not.toHaveBeenCalled();
    expect(movies.setFileWatched).not.toHaveBeenCalled();
    expect(movies.saveReview).not.toHaveBeenCalled();
    await c.close();
  });

  it('movies_person says when there are no TMDB credentials', async () => {
    const c = await connect(fakeMovies({ tmdb: null }));
    const r = await c.call('movies_person', { name: 'Margaret Qualley' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^tmdb_unavailable: /);
    await c.close();
  });

  it('movies_list rejects a date that is not one', async () => {
    const c = await connect(fakeMovies());
    const r = await c.call('movies_list', { finished_from: '2026-13-45' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_input: /);
    await c.close();
  });
});
```

### Step 12: Integration seed helper
**File:** `tests/integration/helpers/moviesMcpSeed.ts` (new; named so it cannot collide with a seed helper phases 4 or 5 add)
**Change:** seeds titles, companies, people, credits, episodes, files and plays with SQL against the index's table contract. Test-only seeding, like `sessionsSeed.ts`; product code still writes only through `MoviesRepo`.
**Code:**
```ts
import { sql } from 'drizzle-orm';
import type { Db } from '../../../src/db/client.js';

export const THIS_HOST = 'movies-this-host';
export const OTHER_HOST = 'movies-other-host';

/** Every movie table, children first. Integration files run one at a time, so this is safe. */
export async function clearMovies(db: Db): Promise<void> {
  await db.execute(sql`delete from movie_plays`);
  await db.execute(sql`delete from movie_files`);
  await db.execute(sql`delete from movie_credits`);
  await db.execute(sql`delete from movie_title_companies`);
  await db.execute(sql`delete from movie_episodes`);
  await db.execute(sql`delete from movie_titles`);
  await db.execute(sql`delete from movie_people`);
  await db.execute(sql`delete from movie_companies`);
}

interface SeedTitle {
  id: string;
  kind: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  year: number;
  releaseDate: string;
  watchedAt?: string;
  seasons?: number;
  episodes?: number;
}

async function insertTitle(db: Db, t: SeedTitle): Promise<void> {
  await db.execute(sql`
    insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, genres,
                              season_count, episode_count, watched_at, metadata_fetched_at, created_at, updated_at)
    values (${t.id}, ${t.kind}, ${t.tmdbId}, ${t.title}, ${t.title}, ${t.year}, ${t.releaseDate}, ${`About ${t.title}.`}, '[]'::jsonb,
            ${t.seasons ?? null}, ${t.episodes ?? null}, ${t.watchedAt ?? null}, now(), now(), now())`);
}

interface SeedFile {
  titleId: string;
  host?: string;
  name: string;
  durationS: number;
  season?: number;
  episode?: number;
  firstSeenAt: string;
  deletedAt?: string;
}

async function insertFile(db: Db, f: SeedFile): Promise<number> {
  const res = await db.execute(sql`
    insert into movie_files (title_id, host, path, name, size, duration_s, season, episode, status, source,
                             first_seen_at, last_seen_at, deleted_at, updated_at)
    values (${f.titleId}, ${f.host ?? THIS_HOST}, ${`/library/${f.name}`}, ${f.name}, 1000000, ${f.durationS},
            ${f.season ?? null}, ${f.episode ?? null}, 'matched', 'scan',
            ${f.firstSeenAt}, ${f.deletedAt ?? f.firstSeenAt}, ${f.deletedAt ?? null}, now())
    returning id`);
  return Number((res.rows[0] as { id: string | number }).id);
}

/** One closed play event on `fileId` (source live). */
export async function insertPlay(
  db: Db,
  fileId: number,
  startedAt: string,
  endedAt: string,
  positionS: number,
  durationS: number,
  host: string = THIS_HOST,
): Promise<void> {
  await db.execute(sql`
    insert into movie_plays (file_id, host, source, started_at, ended_at, start_position_s, position_s, duration_s, updated_at)
    values (${fileId}, ${host}, 'live', ${startedAt}, ${endedAt}, 0, ${positionS}, ${durationS}, now())`);
}

export interface SeededLibrary {
  files: {
    killing: number;
    oldBlumhouse: number;
    unfinished: number;
    moblandE1: number;
    moblandE2: number;
    moblandE3: number;
    nextE1: number;
    nextE2: number;
    gapE1: number;
    gapE3: number;
    otherLaptop: number;
  };
}

/**
 * A small library:
 * - movie-467905 How to Make a Killing: Blumhouse, Margaret Qualley in the cast, finished 2026-03-01.
 * - movie-1001 Old Blumhouse Film: Blumhouse, finished 2025-06-01, file deleted.
 * - movie-1002 Unfinished Blumhouse Film: Blumhouse, played to 1200 of 6000 s on 2026-11-01 (in progress).
 * - tv-247718 MobLand: S1E1 finished then deleted, S1E2 played to 1300 of 3100 s on 2026-11-12 then
 *   deleted (the last episode watched), S1E3 present and never played.
 * - tv-1003 Series Next: E1 finished, E2 present and never played.
 * - tv-1004 Series Gap: E1 finished (file deleted), E2 never had a file, E3 present.
 * - movie-1005 Other Laptop Film: one file on OTHER_HOST.
 * The newest play is MobLand S1E2 (2026-11-12T13:00Z).
 */
export async function seedLibrary(db: Db): Promise<SeededLibrary> {
  await db.execute(sql`insert into movie_companies (id, name) values (3172, 'Blumhouse Productions'), (33, 'Universal Pictures')`);
  await db.execute(sql`insert into movie_people (id, name) values (1373737, 'Margaret Qualley'), (500, 'Tom Hardy')`);

  await insertTitle(db, { id: 'movie-467905', kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', year: 2026, releaseDate: '2026-02-20', watchedAt: '2026-03-01T13:00:00Z' });
  await insertTitle(db, { id: 'movie-1001', kind: 'movie', tmdbId: 1001, title: 'Old Blumhouse Film', year: 2024, releaseDate: '2024-05-01', watchedAt: '2025-06-01T13:00:00Z' });
  await insertTitle(db, { id: 'movie-1002', kind: 'movie', tmdbId: 1002, title: 'Unfinished Blumhouse Film', year: 2025, releaseDate: '2025-05-01' });
  await insertTitle(db, { id: 'tv-247718', kind: 'tv', tmdbId: 247718, title: 'MobLand', year: 2025, releaseDate: '2025-03-30', seasons: 1, episodes: 3 });
  await insertTitle(db, { id: 'tv-1003', kind: 'tv', tmdbId: 1003, title: 'Series Next', year: 2025, releaseDate: '2025-01-01', seasons: 1, episodes: 2 });
  await insertTitle(db, { id: 'tv-1004', kind: 'tv', tmdbId: 1004, title: 'Series Gap', year: 2025, releaseDate: '2025-01-01', seasons: 1, episodes: 3 });
  await insertTitle(db, { id: 'movie-1005', kind: 'movie', tmdbId: 1005, title: 'Other Laptop Film', year: 2023, releaseDate: '2023-01-01' });

  await db.execute(sql`
    insert into movie_title_companies (title_id, company_id, ord)
    values ('movie-467905', 3172, 0), ('movie-1001', 3172, 0), ('movie-1002', 3172, 0), ('tv-247718', 33, 0)`);
  await db.execute(sql`
    insert into movie_credits (title_id, person_id, role, character, job, ord)
    values ('movie-467905', 1373737, 'cast', 'Julia', null, 0), ('tv-247718', 500, 'cast', 'Harry Da Souza', null, 0)`);
  await db.execute(sql`
    insert into movie_episodes (title_id, season, episode, name)
    values ('tv-247718', 1, 1, 'Stick or Twist'), ('tv-247718', 1, 2, 'Alternative Fuel'), ('tv-247718', 1, 3, 'Sweet Home'),
           ('tv-1003', 1, 1, 'Next One'), ('tv-1003', 1, 2, 'Next Two'),
           ('tv-1004', 1, 1, 'Gap One'), ('tv-1004', 1, 2, 'Gap Two'), ('tv-1004', 1, 3, 'Gap Three')`);

  const files = {
    killing: await insertFile(db, { titleId: 'movie-467905', name: 'How.to.Make.a.Killing.2026.mkv', durationS: 6000, firstSeenAt: '2026-02-28T00:00:00Z' }),
    oldBlumhouse: await insertFile(db, { titleId: 'movie-1001', name: 'Old.Blumhouse.Film.2024.mkv', durationS: 6000, firstSeenAt: '2025-05-30T00:00:00Z', deletedAt: '2025-06-02T00:00:00Z' }),
    unfinished: await insertFile(db, { titleId: 'movie-1002', name: 'Unfinished.Blumhouse.Film.2025.mkv', durationS: 6000, firstSeenAt: '2026-10-30T00:00:00Z' }),
    moblandE1: await insertFile(db, { titleId: 'tv-247718', name: 'MobLand.S01E01.mkv', durationS: 3000, season: 1, episode: 1, firstSeenAt: '2026-11-01T00:00:00Z', deletedAt: '2026-11-11T00:00:00Z' }),
    moblandE2: await insertFile(db, { titleId: 'tv-247718', name: 'MobLand.S01E02.mkv', durationS: 3100, season: 1, episode: 2, firstSeenAt: '2026-11-01T00:00:00Z', deletedAt: '2026-11-13T00:00:00Z' }),
    moblandE3: await insertFile(db, { titleId: 'tv-247718', name: 'MobLand.S01E03.mkv', durationS: 3000, season: 1, episode: 3, firstSeenAt: '2026-11-01T00:00:00Z' }),
    nextE1: await insertFile(db, { titleId: 'tv-1003', name: 'Series.Next.S01E01.mkv', durationS: 3000, season: 1, episode: 1, firstSeenAt: '2026-09-25T00:00:00Z' }),
    nextE2: await insertFile(db, { titleId: 'tv-1003', name: 'Series.Next.S01E02.mkv', durationS: 3000, season: 1, episode: 2, firstSeenAt: '2026-09-25T00:00:00Z' }),
    gapE1: await insertFile(db, { titleId: 'tv-1004', name: 'Series.Gap.S01E01.mkv', durationS: 3000, season: 1, episode: 1, firstSeenAt: '2026-08-25T00:00:00Z', deletedAt: '2026-09-02T00:00:00Z' }),
    gapE3: await insertFile(db, { titleId: 'tv-1004', name: 'Series.Gap.S01E03.mkv', durationS: 3000, season: 1, episode: 3, firstSeenAt: '2026-08-25T00:00:00Z' }),
    otherLaptop: await insertFile(db, { titleId: 'movie-1005', host: OTHER_HOST, name: 'Other.Laptop.Film.2023.mkv', durationS: 5400, firstSeenAt: '2026-01-01T00:00:00Z' }),
  };

  await insertPlay(db, files.killing, '2026-03-01T11:00:00Z', '2026-03-01T12:40:00Z', 5900, 6000);
  await insertPlay(db, files.oldBlumhouse, '2025-06-01T11:00:00Z', '2025-06-01T12:40:00Z', 5950, 6000);
  await insertPlay(db, files.unfinished, '2026-11-01T14:00:00Z', '2026-11-01T14:20:00Z', 1200, 6000);
  await insertPlay(db, files.moblandE1, '2026-11-10T13:00:00Z', '2026-11-10T13:50:00Z', 2950, 3000);
  await insertPlay(db, files.moblandE2, '2026-11-12T13:00:00Z', '2026-11-12T13:22:00Z', 1300, 3100);
  await insertPlay(db, files.nextE1, '2026-10-01T13:00:00Z', '2026-10-01T13:50:00Z', 2950, 3000);
  await insertPlay(db, files.gapE1, '2026-09-01T13:00:00Z', '2026-09-01T13:50:00Z', 2950, 3000);

  return { files };
}
```

### Step 13: Integration test over MCP
**File:** `tests/integration/movies.mcp.int.test.ts` (new)
**Change:** builds the real MCP server with `mcpToolDeps(h.deps)` and a `movies` entry wired to the real `MoviesRepo`, the real `continueTitle` and `read.ts`, with only TMDB and the VLC player faked. The `continueTitle` deps literal is the one place that depends on phase 5's `ContinueDeps` shape.
**Code:**
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MOVIE_TOOL_NAMES } from '../../src/chat/status.js';
import { mcpToolDeps } from '../../src/http/app.js';
import type { MovieToolDeps } from '../../src/mcp/movieTools.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { continueTitle } from '../../src/movies/continue.js';
import type { MoviePlayer, PlayStarted } from '../../src/movies/player.js';
import { MoviesRepo } from '../../src/movies/repo.js';
import { resumePosition } from '../../src/movies/state.js';
import type { TmdbClient } from '../../src/movies/tmdb.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { clearMovies, insertPlay, seedLibrary, THIS_HOST, OTHER_HOST, type SeededLibrary } from './helpers/moviesMcpSeed.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const WALL = 'http://localhost:7317';

/** Only searchPerson and personCredits are reached by the movie tools. */
const fakeTmdb = {
  async searchPerson(name: string) {
    return name.toLowerCase().includes('qualley')
      ? [
          { personId: 1373737, name: 'Margaret Qualley', knownFor: 'Acting', profilePath: null, popularity: 50 },
          { personId: 42, name: 'Margaret Qualls', knownFor: 'Writing', profilePath: null, popularity: 1 },
        ]
      : [];
  },
  async personCredits(personId: number) {
    if (personId !== 1373737) return [];
    return [
      { kind: 'movie', tmdbId: 467905, title: 'How to Make a Killing', releaseDate: '2026-02-20', credit: 'cast', character: 'Julia', job: null },
      { kind: 'movie', tmdbId: 1002, title: 'Unfinished Blumhouse Film', releaseDate: '2025-05-01', credit: 'cast', character: 'Ann', job: null },
      { kind: 'movie', tmdbId: 9001, title: 'The Substance', releaseDate: '2024-09-20', credit: 'cast', character: 'Sue', job: null },
      { kind: 'movie', tmdbId: 9001, title: 'The Substance', releaseDate: '2024-09-20', credit: 'crew', character: null, job: 'Producer' },
    ];
  },
} as unknown as TmdbClient;

let h: ApiHarness;
let client: Client;
let lib: SeededLibrary;
const played: number[] = [];
const reviews: Array<{ titleId: string; text: string }> = [];

/** Records what VLC would have been asked to play and answers like MoviePlayer (resume second included); never spawns anything. */
let fakeRepo: MoviesRepo;
const fakePlayer: Pick<MoviePlayer, 'host' | 'play'> = {
  host: THIS_HOST,
  async play(fileId: number): Promise<PlayStarted> {
    const file = await fakeRepo.fileById(fileId);
    if (file === null) throw new Error(`no file ${fileId}`);
    played.push(fileId);
    const start = resumePosition(file, await fakeRepo.lastPlay(fileId));
    return { play_id: 0, file_id: fileId, title_id: file.titleId, name: file.name, start_position: start, port: 0, tracking: true, note: null };
  },
};

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(name, args);
  expect(r.isError ?? false, text(r)).toBe(false);
  return JSON.parse(text(r)) as T;
}

beforeAll(async () => {
  h = await createApiHarness();
  const repo = new MoviesRepo(h.deps.db);
  fakeRepo = repo;
  const movies: MovieToolDeps = {
    host: THIS_HOST,
    imageBase: 'https://image.tmdb.org/t/p',
    tmdb: fakeTmdb,
    async setTitleUser(id, patch) {
      await repo.setTitleUser(id, patch);
    },
    async setFileWatched(fileId, watched) {
      await repo.setFileWatched(fileId, watched);
    },
    async saveReview(titleId, reviewText) {
      reviews.push({ titleId, text: reviewText });
    },
    // Phase 5's ContinueDeps: the real continue rule over the seeded rows, with a recording player.
    // Phase 5's ContinueDeps: the real continue rule over the seeded rows (seeded paths count as on disk), with a recording player.
    continueTitle: (title) => continueTitle({ db: h.deps.db, player: fakePlayer, exists: async () => true }, title),
  };
  const server = createMcpServer({ ...mcpToolDeps(h.deps), movies });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'movies-in-process', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await clearMovies(h.deps.db);
  await h.close();
});

beforeEach(async () => {
  await clearMovies(h.deps.db);
  lib = await seedLibrary(h.deps.db);
  played.length = 0;
  reviews.length = 0;
});

interface ListBody {
  count: number;
  titles: Array<{ id: string; state: string; url: string }>;
}

describe('movie MCP tools', () => {
  it('registers the six tools and the instructions explain them', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith('movies_'));
    expect(names.sort()).toEqual([...MOVIE_TOOL_NAMES].sort());
    expect(client.getInstructions() ?? '').toContain('Movies.');
  });

  it('movies_list: the Blumhouse films finished this year', async () => {
    const res = await callJson<ListBody>('movies_list', { company: 'Blumhouse', finished_from: '2026-01-01', finished_to: '2026-12-31' });
    expect(res.titles.map((t) => t.id)).toEqual(['movie-467905']);
    expect(res.titles[0]).toMatchObject({ state: 'finished', url: `${WALL}/movies/movie-467905` });
  });

  it('movies_list by person, words, kind and state', async () => {
    const byPerson = await callJson<ListBody>('movies_list', { person: 'Margaret Qualley' });
    expect(byPerson.titles.map((t) => t.id)).toEqual(['movie-467905']);
    const byWords = await callJson<ListBody>('movies_list', { q: 'mobland' });
    expect(byWords.titles.map((t) => t.id)).toEqual(['tv-247718']);
    const series = await callJson<ListBody>('movies_list', { kind: 'tv' });
    expect(series.titles.map((t) => t.id).sort()).toEqual(['tv-1003', 'tv-1004', 'tv-247718']);
    const inProgress = await callJson<ListBody>('movies_list', { state: 'in_progress' });
    expect(inProgress.titles.map((t) => t.id)).toContain('movie-1002');
    expect(inProgress.titles.map((t) => t.id)).not.toContain('movie-467905');
  });

  it('movies_get: which MobLand episode was watched last and when, with the deleted files', async () => {
    const res = await callJson<{
      id: string;
      url: string;
      last_play: { season: number; episode: number; episode_name: string; started_at: string; position_s: number };
      seasons: Array<{ season: number; episodes: Array<{ season: number; episode: number; name: string }> }>;
      files: Array<{ id: number; deleted_at: string | null; available: boolean }>;
      plays: Array<{ started_at: string }>;
    }>('movies_get', { title: 'mobland' });
    expect(res.id).toBe('tv-247718');
    expect(res.url).toBe(`${WALL}/movies/tv-247718`);
    expect(res.last_play).toMatchObject({ season: 1, episode: 2, episode_name: 'Alternative Fuel', position_s: 1300 });
    expect(new Date(res.last_play.started_at).toISOString()).toBe('2026-11-12T13:00:00.000Z');
    expect(res.seasons.flatMap((x) => x.episodes).map((e) => e.name)).toEqual(['Stick or Twist', 'Alternative Fuel', 'Sweet Home']);
    expect(res.files).toHaveLength(3);
    const deleted = res.files.filter((f) => f.deleted_at !== null).map((f) => f.id).sort((a, b) => a - b);
    expect(deleted).toEqual([lib.files.moblandE1, lib.files.moblandE2].sort((a, b) => a - b));
    expect(res.plays).toHaveLength(2);
    expect(Date.parse(res.plays[0]!.started_at)).toBeGreaterThan(Date.parse(res.plays[1]!.started_at));
  });

  it('movies_get by id: a file on the other laptop is available: false', async () => {
    const res = await callJson<{ files: Array<{ host: string; available: boolean }> }>('movies_get', { title: 'MOVIE-1005' });
    expect(res.files).toEqual([expect.objectContaining({ host: OTHER_HOST, available: false })]);
  });

  it('movies_get with an unknown or an ambiguous name', async () => {
    const none = await call('movies_get', { title: 'no such film anywhere' });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/^not_found: /);
    const both = await call('movies_get', { title: 'blumhouse film' });
    expect(both.isError).toBe(true);
    expect(text(both)).toMatch(/^ambiguous: /);
    expect(text(both)).toContain('movie-1001');
    expect(text(both)).toContain('movie-1002');
  });

  it('movies_history: plays newest first, across deleted files, and for one title', async () => {
    const all = await callJson<{ plays: Array<{ title_id: string; episode: number | null; episode_name: string | null; url: string }> }>(
      'movies_history',
      { from: '2026-11-01' },
    );
    expect(all.plays.map((p) => p.title_id)).toEqual(['tv-247718', 'tv-247718', 'movie-1002']);
    expect(all.plays[0]).toMatchObject({ episode: 2, episode_name: 'Alternative Fuel', url: `${WALL}/movies/tv-247718` });
    const mobland = await callJson<{ count: number; plays: Array<{ title_id: string }> }>('movies_history', { title: 'mobland' });
    expect(mobland.count).toBe(2);
    expect(new Set(mobland.plays.map((p) => p.title_id))).toEqual(new Set(['tv-247718']));
  });

  it('movies_continue with a title resumes the latest unfinished film from its position', async () => {
    const res = await callJson<{ action: string; position: number; url: string; message: string }>('movies_continue', { title: 'Unfinished Blumhouse Film' });
    expect(res).toMatchObject({ action: 'resumed', position: 1200, url: `${WALL}/movies/movie-1002` });
    expect(played).toEqual([lib.files.unfinished]);
  });

  it('movies_continue starts the next episode whose file is present', async () => {
    const res = await callJson<{ action: string }>('movies_continue', { title: 'Series Next' });
    expect(res.action).toBe('started');
    expect(played).toEqual([lib.files.nextE2]);
  });

  it('movies_continue says which next episode is missing and which later ones are present, and plays nothing', async () => {
    const res = await callJson<{
      action: string;
      missing: { season: number; episode: number };
      present: Array<{ season: number; episode: number }>;
    }>('movies_continue', { title: 'Series Gap' });
    expect(res.action).toBe('missing');
    expect(res.missing).toMatchObject({ season: 1, episode: 2 });
    expect(res.present.map((p) => p.episode)).toEqual([3]);
    expect(played).toEqual([]);
  });

  it('movies_continue without a title continues the title of the newest play event', async () => {
    await insertPlay(h.deps.db, lib.files.unfinished, '2026-11-13T14:00:00Z', '2026-11-13T14:10:00Z', 1500, 6000);
    const res = await callJson<{ action: string; title: { id: string }; position: number }>('movies_continue', {});
    expect(res).toMatchObject({ action: 'resumed', title: { id: 'movie-1002' }, position: 1500 });
    expect(played).toEqual([lib.files.unfinished]);
  });

  it('movies_person marks each TMDB credit seen or not seen against the library', async () => {
    const res = await callJson<{
      person: { id: number; name: string };
      other_people: Array<{ id: number }>;
      counts: { credits: number; in_library: number; seen: number };
      credits: Array<{ title_id: string; in_library: boolean; seen: boolean; started: boolean; state: string | null; roles: string[]; url: string | null }>;
    }>('movies_person', { name: 'Margaret Qualley' });
    expect(res.person).toMatchObject({ id: 1373737, name: 'Margaret Qualley' });
    expect(res.other_people.map((p) => p.id)).toEqual([42]);
    expect(res.counts).toEqual({ credits: 3, in_library: 2, seen: 1 });
    const byId = new Map(res.credits.map((c) => [c.title_id, c]));
    expect(byId.get('movie-467905')).toMatchObject({ in_library: true, seen: true, state: 'finished', url: `${WALL}/movies/movie-467905` });
    expect(byId.get('movie-1002')).toMatchObject({ in_library: true, seen: false, started: true });
    expect(byId.get('movie-9001')).toMatchObject({ in_library: false, seen: false, state: null, url: null });
    expect(byId.get('movie-9001')!.roles).toEqual(['cast as Sue', 'Producer']);
    expect(res.credits.map((c) => c.title_id)).toEqual(['movie-467905', 'movie-1002', 'movie-9001']);

    const unseen = await callJson<{ credits: Array<{ title_id: string }> }>('movies_person', { name: 'Margaret Qualley', unseen_only: true });
    expect(unseen.credits.map((c) => c.title_id)).toEqual(['movie-1002', 'movie-9001']);
    const crew = await callJson<{ credits: Array<{ title_id: string }> }>('movies_person', { name: 'Margaret Qualley', role: 'crew' });
    expect(crew.credits.map((c) => c.title_id)).toEqual(['movie-9001']);
  });

  it('movies_mark stores watched and rating on a title, watched on a file, and hands the review on', async () => {
    const marked = await callJson<{ title_id: string; rating: number; watched_at: string | null; url: string }>('movies_mark', {
      title: 'tv-1003',
      watched: true,
      rating: 4,
    });
    expect(marked).toMatchObject({ title_id: 'tv-1003', rating: 4, url: `${WALL}/movies/tv-1003` });
    expect(marked.watched_at).not.toBeNull();
    const titleRow = await h.deps.db.execute(sql`select rating, watched_at from movie_titles where id = 'tv-1003'`);
    expect(titleRow.rows[0]).toMatchObject({ rating: 4 });
    expect((titleRow.rows[0] as { watched_at: unknown }).watched_at).not.toBeNull();

    const file = await callJson<{ file: { id: number; watched_at: string | null } }>('movies_mark', { file_id: lib.files.gapE3, watched: true });
    expect(file.file.id).toBe(lib.files.gapE3);
    const fileRow = await h.deps.db.execute(sql`select watched_at from movie_files where id = ${lib.files.gapE3}`);
    expect((fileRow.rows[0] as { watched_at: unknown }).watched_at).not.toBeNull();

    await callJson('movies_mark', { title: 'Series Next', review: 'Great pilot.' });
    expect(reviews).toEqual([{ titleId: 'tv-1003', text: 'Great pilot.' }]);

    const cleared = await callJson<{ rating: number | null }>('movies_mark', { title: 'tv-1003', rating: null });
    expect(cleared.rating).toBeNull();
  });
});
```
**Impact:** new file; runs only under `npm run test:int`.

## Principles applied

- Boundary discipline: arguments are checked once where they enter — zod schemas, `parseDateBound` for every date, `resolveTitleId` turns a typed name into one title id (or `not_found` / `ambiguous`) before any read or write, and `markRequest` is the single check for `movies_mark`. The read model and repo only ever get typed values.
- Make illegal states unrepresentable: `movies_mark`'s flat MCP input (a raw zod shape, which cannot be a union) is turned into the `MarkRequest` union (`title` with any mark, or `file` with `watched` only) right away, so "a rating on a file" or "a file and a title" cannot reach the write code.
- Laziness protocol: no new read queries. Lists, details and history come from phase 4's `read.ts`; the continue rule is phase 5's `continueTitle`. The only SQL here is two one-line selects (TMDB ids in the library; a file's title), and state comes from `getTitle`, not from a second copy of `state.ts` rules. The tools take a narrow `MovieToolDeps` of six members instead of the whole `MoviesService`, so tests need no service builder.
- Test behavior, not implementation: the integration test drives the real MCP server over seeded rows with the real repo, read model and continue rule, and fakes only what reaches outside (TMDB, VLC). It asserts what `/n` would see (ids, episode names, ISO dates, urls, which file VLC would get), not calls inside the tools.
- Encode lessons in structure: the tool names exist once, in `MOVIE_TOOL_NAMES`. `movieTools.ts` registers them by destructuring that array, and both the unit and integration tests assert the registered `movies_*` names equal it, so the server and the chat allow-list cannot drift apart.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/movies-library && npm run typecheck`
**Tests:** `npm test` and `npm run test:int` (focused: `npx vitest run tests/unit/mcp.movieTools.test.ts tests/unit/chat-status.test.ts tests/unit/mcp.instructions.test.ts tests/unit/chat-prompt.test.ts tests/unit/chat-agent.test.ts` and `npm run test:int -- tests/integration/movies.mcp.int.test.ts`)
**Proof:** the real daemon's `/mcp` answers the owner's questions from a seeded library, and the continue rule picks resume / next / missing and the newest play, with VLC never spawned.
- Harness: `.claude/skills/verify-notesd` (`verify.sh`), plus the MCP integration test for the branches that would open VLC or reach TMDB.
- Feature-map entries: none yet. `features/movies.md` is phase 8's; these journeys are written so phase 8 can copy them into it.
- Setup for J1–J5 and J8 (all from the worktree root; `$(hostname)` makes the seeded files belong to the throwaway daemon's host; a bogus `NOTESD_VLC_BIN` and empty TMDB credentials mean nothing can open VLC on the owner's screen or reach the network; the one-hour scan interval keeps the sync from marking the seeded paths deleted during the run):
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/movies-library
  V=.claude/skills/verify-notesd/scripts/verify.sh
  ROOT=$(mktemp -d)
  NOTESD_MOVIES=on NOTESD_MOVIES_ROOTS="$ROOT" NOTESD_MOVIES_SCAN_MS=3600000 NOTESD_VLC_BIN=/nonexistent/vlc.exe NOTESD_VLC_INI= TMDB_API_READ_ACCESS_TOKEN= TMDB_API_KEY= $V up
  RUN=<the RUN= value printed>
  $V doctor $RUN
  HOST=$(hostname)
  $V exec $RUN "$(cat <<SQL | sed "s/__HOST__/$HOST/g"
  insert into movie_companies (id, name) values (3172, 'Blumhouse Productions'), (33, 'Universal Pictures');
  insert into movie_titles (id, kind, tmdb_id, title, original_title, year, release_date, overview, genres, season_count, episode_count, watched_at, metadata_fetched_at, created_at, updated_at) values
   ('movie-467905','movie',467905,'How to Make a Killing','How to Make a Killing',2026,'2026-02-20','A heist.','[]'::jsonb,null,null,'2026-03-01T13:00:00Z',now(),now(),now()),
   ('movie-1001','movie',1001,'Old Blumhouse Film','Old Blumhouse Film',2024,'2024-05-01','Old.','[]'::jsonb,null,null,'2025-06-01T13:00:00Z',now(),now(),now()),
   ('tv-247718','tv',247718,'MobLand','MobLand',2025,'2025-03-30','Crime.','[]'::jsonb,1,3,null,now(),now(),now()),
   ('tv-1004','tv',1004,'Series Gap','Series Gap',2025,'2025-01-01','Gap.','[]'::jsonb,1,3,null,now(),now(),now());
  insert into movie_title_companies (title_id, company_id, ord) values ('movie-467905',3172,0),('movie-1001',3172,0),('tv-247718',33,0);
  insert into movie_episodes (title_id, season, episode, name) values ('tv-247718',1,1,'Stick or Twist'),('tv-247718',1,2,'Alternative Fuel'),('tv-247718',1,3,'Sweet Home'),('tv-1004',1,1,'Gap One'),('tv-1004',1,2,'Gap Two'),('tv-1004',1,3,'Gap Three');
  insert into movie_files (id, title_id, host, path, name, size, duration_s, season, episode, status, source, first_seen_at, last_seen_at, deleted_at, updated_at) values
   (9001,'movie-467905','__HOST__','/v/killing.mkv','killing.mkv',1000,6000,null,null,'matched','scan','2026-02-28T00:00:00Z',now(),null,now()),
   (9002,'movie-1001','__HOST__','/v/old.mkv','old.mkv',1000,6000,null,null,'matched','scan','2025-05-30T00:00:00Z','2025-06-02T00:00:00Z','2025-06-02T00:00:00Z',now()),
   (9003,'tv-247718','__HOST__','/v/MobLand.S01E01.mkv','MobLand.S01E01.mkv',1000,3000,1,1,'matched','scan','2026-11-01T00:00:00Z','2026-11-11T00:00:00Z','2026-11-11T00:00:00Z',now()),
   (9004,'tv-247718','__HOST__','/v/MobLand.S01E02.mkv','MobLand.S01E02.mkv',1000,3100,1,2,'matched','scan','2026-11-01T00:00:00Z','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z',now()),
   (9005,'tv-1004','__HOST__','/v/Gap.S01E01.mkv','Gap.S01E01.mkv',1000,3000,1,1,'matched','scan','2026-11-01T00:00:00Z','2026-11-14T00:00:00Z','2026-11-14T00:00:00Z',now()),
   (9006,'tv-1004','__HOST__','/v/Gap.S01E03.mkv','Gap.S01E03.mkv',1000,3000,1,3,'matched','scan','2026-11-01T00:00:00Z',now(),null,now());
  insert into movie_plays (file_id, host, source, started_at, ended_at, start_position_s, position_s, duration_s, updated_at) values
   (9001,'__HOST__','live','2026-03-01T11:00:00Z','2026-03-01T12:40:00Z',0,5900,6000,now()),
   (9002,'__HOST__','live','2025-06-01T11:00:00Z','2025-06-01T12:40:00Z',0,5950,6000,now()),
   (9003,'__HOST__','live','2026-11-10T13:00:00Z','2026-11-10T13:50:00Z',0,2950,3000,now()),
   (9004,'__HOST__','live','2026-11-12T13:00:00Z','2026-11-12T13:22:00Z',0,1300,3100,now()),
   (9005,'__HOST__','live','2026-11-13T13:00:00Z','2026-11-13T13:50:00Z',0,2950,3000,now())
  SQL
  )"
  ```
- Journeys:
  - **J1** · traces R6.3 — `$V mcp $RUN movies_list '{"company":"Blumhouse","finished_from":"2026-01-01","finished_to":"2026-12-31"}'` → passes when the output has `"count":1`, contains `"id":"movie-467905"` and `"url":"http://localhost:7317/movies/movie-467905"` (or the run's wall port), and does not contain `movie-1001` (finished in 2025)
  - **J2** · traces R6.3 — `$V mcp $RUN movies_get '{"title":"mobland"}'` → passes when `last_play` shows `"season":1`, `"episode":2`, `"episode_name":"Alternative Fuel"` and a `started_at` of `2026-11-12T13:00:00`, the `files` array has three entries of which `9003` and `9004` carry a non-null `deleted_at`, and the output contains `/movies/tv-247718`
  - **J3** · traces R6.3 — `$V mcp $RUN movies_history '{"from":"2026-11-01","title":"MobLand"}'` → passes when `"count":2` and the first play has `"episode":2` and `"episode_name":"Alternative Fuel"` and a non-null `file_deleted_at`
  - **J4** · traces R6.1 — `$V mcp $RUN movies_continue '{"title":"Series Gap"}'`, then `$V sql $RUN "select count(*) from movie_plays"` → passes when the tool answers `"action":"missing"` with `missing` at season 1 episode 2 and `present` holding episode 3, and the play count is still `5` (nothing was played)
  - **J5** · traces R6.2 — `$V mcp $RUN movies_continue '{}'` → passes when it answers for `"id":"tv-1004"` (the title of the newest play event, 2026-11-13) with `"action":"missing"`, not for MobLand or the films
  - **J6** · traces R6.1, R6.2 — `npm run test:int -- tests/integration/movies.mcp.int.test.ts -t "movies_continue"` → passes when the four `movies_continue` tests pass: resumed at 1200 s on the unfinished film's file, started on Series Next E2's file, missing E2 with E3 present and no play, and no title resuming the newest play's film at 1500 s (the recording player received exactly those file ids)
  - **J7** · traces R6.4 — `npm run test:int -- tests/integration/movies.mcp.int.test.ts -t "movies_person"` → passes when the test passes: the finished film is `seen: true`, the in-progress one `seen: false, started: true`, the film outside the library `in_library: false, seen: false` with its cast and producer roles merged, and `unseen_only` / `role` filter as asserted. Then `$V mcp $RUN movies_person '{"name":"Margaret Qualley"}'` → passes when it answers `tmdb_unavailable:` (the throwaway daemon has no TMDB credentials), which proves the tool is registered on the real daemon
  - **J8** · traces R6.5 — `$V mcp $RUN --list | grep -c '^movies_'` and `npx tsx -e "import('./src/chat/status.ts').then(m => console.log(m.allowedChatTools().filter(t => t.startsWith('mcp__notes__movies_')).length))"` and `npx vitest run tests/unit/chat-status.test.ts tests/unit/mcp.instructions.test.ts tests/unit/chat-prompt.test.ts` and `grep -c 'movies_continue' claude/skills/n/SKILL.md` → passes when the first prints `6`, the second prints `6`, the three test files pass, and the grep prints a number >= 1
- Neighbor check: the session and adversary MCP tools and the instruction order they rely on — `npx vitest run tests/unit/mcp.instructions.test.ts tests/unit/sessions/linkNoteTool.test.ts tests/unit/chat-agent.test.ts && npm run test:int -- tests/integration/sessions.mcp.int.test.ts tests/integration/mcp.tools.int.test.ts` → passes when all pass (Sessions still last, Adversary still right before it, notes tools unchanged), and `$V mcp $RUN sessions_search '{"query":"anything"}'` answers without an error
- Cleanup: `$V down $RUN`
- Cost: none. No LLM turns, no TMDB calls, no VLC.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run test:int` pass; on a throwaway daemon `movies_list` returns only the Blumhouse film finished this year, `movies_get "mobland"` names episode 2 "Alternative Fuel" as the last watched with both deleted files listed, `movies_continue` answers `missing` for Series Gap and continues the newest play's title with no title, all six names are listed on `/mcp` and allowed in the chat bar, and the `/n` skill and MCP instructions describe them.

## Handoffs

- **Phases 2, 4, 5:** reconciled; Requires quotes their final shapes (`ReadContext`, `PlayView.episode_name` / `file_deleted_at`, `TmdbPersonHit.personId`, `TmdbPersonCredit.credit`, `ContinueResult` union, `AppDeps.moviesPlayer`). This phase owns the `src/http/app.ts` `mcpToolDeps` edit; phase 5 does not touch `app.ts`.
- **Phase 6 (web).** The chat prompt and the MCP instructions tell the agent that a chat turn whose first line starts with `[Movies` came from the Movies page. Phase 6's `moviesChatMessage` sends exactly one of `[Movies · library]`, `[Movies · unmatched files]`, `[Movies · <title> (<year>) · <title id>]`, or `[Movies · <title id>]` while the detail is loading; the title id, when present, is the last ` · ` field.
- **Phase 8 (docs, feature map).** Add the six tools to README's MCP tool table and the CLAUDE.md movies paragraph; create `.claude/skills/verify-notesd/features/movies.md` with an MCP sub-feature that reuses the setup and J1–J5 above (they need no fixtures beyond the SQL seed); and run `scripts/install.sh` so the live `/n` skill and daemon pick up this phase's changes.
- **Phase 1 (test setup).** `truncateAll` in `tests/integration/setup.ts` should include the `movie_*` tables; this phase does not depend on it (its test clears the movie tables itself).

## Rollback

Revert this phase's commit. It adds `src/mcp/movieTools.ts`, three test files and text sections, and four one- or two-line wirings (`ToolDeps.movies`, `registerMovieTools`, `mcpToolDeps`, `MOVIE_TOOL_NAMES` in `allowedChatTools`). Nothing in the database or in phases 1–6 depends on it. To switch the tools off without a revert, set `NOTESD_MOVIES=off`: every movie tool then answers `movies_off`.
