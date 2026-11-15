> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/direct-streaming/PLAN.md` phase 7. Source: `.workflows/plan/direct-streaming/phase-7.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 7: /direct-stream: title lookup, tools, skill, chat bar

**Plan set:** `DIRECT_STREAMING_PLAN.md`
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Satisfies:** R3 — "the /direct-stream [...] skills first": `/direct-stream saltburn` and "this is a LOTR night. let's /direct-stream the first one" end in a full-screen film
**Criteria:** R3.1, R3.2, R3.3
**Depends on:** Phase 4, 5 (and through them 3)
**Difficulty:** NORMAL
**Package:** `src/mcp`, `src/directStream`, `claude/skills`

---

## Goal

After this phase the owner can type `/direct-stream <title>` in Claude Code, or the same words in
the wall's chat bar, and one matching film (or one named episode) is resolved and opened full
screen in the streaming Chrome through `DirectStreamService.play`. Words become a TMDB reference
here: library titles first, then TMDB search, with the exact-title-and-year rule of
`claude/streaming/match.mjs`. Several matches, a series with no episode, and a title no provider
can stream all start nothing and say why.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `src/directStream/match.ts`: `normalizeName(name)`, `isSameTitle(result, query)`, `TitleQuery`, `NamedTitle` (a TypeScript port of `claude/streaming/match.mjs` `pickMatches`' rule; a parity test pins it to the `.mjs`).
- `src/directStream/lookup.ts`: `StreamTarget` (an alias of phase 3's `StreamRef`, `{ kind: 'movie'; tmdbId } | { kind: 'tv'; tmdbId; season; episode }`; not a second type), `TitleCandidate`, `EpisodePick`, `SeasonCount`, `LookupRequest`, `LookupResult`, `TitleLibrary`, `LookupDeps`, `LookupError`, `LOOKUP_MAX_CANDIDATES`, `parseTitleRequest`, `lookupTitle`, `dbTitleLibrary(db)`, `targetKey(target)`.
- `src/mcp/directStreamTools.ts`: `registerDirectStreamTools(server, deps)`, `directStreamToolDeps(appDeps)`, `DirectStreamToolDeps`, `FreshSource`, `DIRECT_STREAM_OFF`.
- `src/chat/status.ts`: `DIRECT_STREAM_TOOL_NAMES = ['direct_stream_find', 'direct_stream_play']`, `DirectStreamToolName`.
- `ToolDeps.directStream?: DirectStreamToolDeps | null` (`src/mcp/tools.ts`).
- MCP tools `direct_stream_find`, `direct_stream_play`.
- `claude/skills/direct-stream/SKILL.md`.
- Tests: `tests/unit/directStream/match.test.ts`, `tests/unit/directStream/lookup.test.ts`, `tests/unit/mcp.directStreamTools.test.ts`, `tests/integration/directStream.lookup.int.test.ts`.

**Signature changes:** `src/mcp/movieTools.ts`'s title lookup by name passes `scope: 'all'` to `listTitles` (stream-only titles are found), and the `movies_get` / `movies_history` descriptions name play source `stream` and `provider` (reconciler, from phase 5's handoff). `allowedChatTools()` returns 2 more names. `captionForToolUse` names 2 more tools. `mcpToolDeps(...)` returns `directStream` too. `buildInstructions` gains a `Direct streaming.` paragraph between `Streaming.` and `Adversary.`. `buildChatSystemPrompt` gains one section after the idlix/lk21 section.

**Requires (from earlier phases):**
- Phase 3: `AppDeps.directStream?: DirectStreamService | null`, left null/unset when `NOTESD_DIRECT_STREAM=off`, `NOTESD_MOVIES=off` or no movies service.
- Phase 3: `Config.directStream?: DirectStreamConfig` (`{ enabled, freshDays, cli, ... }`; unset or disabled means off).
- Phase 3: `DirectStreamService.play(input: StreamRefInput, { resumeS? })` (`StreamRefInput` is `{ kind: 'movie' | 'tv', tmdbId, season?, episode? }`; this phase's `StreamTarget` is phase 3's `StreamRef`, which fits it). `play` resolves, then opens `http://localhost:<port>/stream/<sessionId> --fullscreen` in the streaming Chrome (phase 1's `open` then starts it with sound), and resolves to `PlayResult { page_url, session: SessionInfo, attempts }`. This phase passes that value through as `play` and does not read its fields.
- Phase 3: failures **throw** `DirectStreamError` (`src/directStream/types.ts`) with `code` `no_source` (every provider's `attempts`, the CLI's `[{ provider, outcome, took_s, detail }]`), `resolve_failed` (`reason`: `no_chrome`, `chrome_not_reachable`, `script_failed`, `bad_output`, ...), `open_failed` (`reason`, plus `sessionId`, `pageUrl`) or `unknown_session`. The tools read `code`, and `reason` when `code` is not `no_source` (Step 4).
- Phase 5: when `resumeS` is omitted, phase 5's `resumeS` hook starts the session at the last stream position of that title, or that episode, on this host (the session's `resume_s`). The tool therefore passes no `resumeS`.
- Phase 5: the one freshness rule, `src/movies/repo.ts`: `MoviesRepo.streamSourcesOfTitle(titleId, host): Promise<MovieStreamSourceRow[]>` (the film's row is season 0, episode 0), `isFreshStreamSource(row, host, since)` and `streamFreshSince(now, freshDays)`. Only `directStreamToolDeps` (Step 4) reads them.
- Phase 5: `listTitles` leaves out stream-only titles unless `filter.scope === 'all'`; `history` rows gain `source: 'stream'` and `provider`. Step 5b passes `scope: 'all'` where `movieTools.ts` finds a title by name and updates the `movies_get` / `movies_history` descriptions.
- Phase 3: `.claude/skills/verify-notesd/features/direct-streaming.md` exists, and `docs/guide/streaming.md` has a `## Direct streaming` section. Phase 3 also pins `NOTESD_DIRECT_STREAM=off` in `verify.sh` for every throwaway run, so no throwaway daemon reaches the real resolver or Chrome. If phase 3 does not pin it, the R2.6 neighbor check below still holds on a default `$V up`, because that run pins `NOTESD_MOVIES=off`.

**Leaves alone (owned by others):** `direct_stream_sources` / `direct_stream_update_source`, `DirectStreamService.updateSource` (phase 8; phase 8 adds its tools to `src/mcp/directStreamTools.ts` and appends their names to `DIRECT_STREAM_TOOL_NAMES` after this phase); `src/directStream/{repo,service,sessions,...}.ts`, `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, routes (phase 3); `src/movies/{repo,state,read,types}.ts` (phase 5); `web/` (phases 4, 9); `claude/streaming/**` (phases 1, 2, 6, 8); `streaming_find` / `streaming_play` and their prompt text (unchanged, invariant 8).

## Files

| File | Action | What changes |
|---|---|---|
| `src/directStream/match.ts` | create | the exact-title-and-year rule, ported from `claude/streaming/match.mjs:12-26` |
| `src/directStream/lookup.ts` | create | words / movie id / title key -> one candidate, several, or none; library first, then TMDB; `dbTitleLibrary` |
| `src/mcp/directStreamTools.ts` | create | `direct_stream_find`, `direct_stream_play`, `directStreamToolDeps` |
| `src/chat/status.ts` | modify (after line 80; lines 111-134; after line 240) | `DIRECT_STREAM_TOOL_NAMES`, allow list, captions |
| `src/mcp/tools.ts` | modify (lines 14-15, 41-42) | `ToolDeps.directStream` |
| `src/mcp/server.ts` | modify (lines 10, 33) | register the tools |
| `src/http/app.ts` | modify (line 9, line 84) | `directStream: directStreamToolDeps(deps)` in `mcpToolDeps` |
| `src/mcp/movieTools.ts` | modify (line 186; lines 389-394) | `scope: 'all'` in the name lookup; `stream` source and `provider` in the `movies_get` / `movies_history` descriptions (reconciler) |
| `docs/guide/chat.md` | modify (caption table line 64; allow list line 162; behaviour list after line 195) | the direct-stream caption row, allow-list row and behaviour bullet (reconciler; phase 8 extends both rows) |
| `src/mcp/instructions.ts` | modify (lines 23-29, after line 60) | `Direct streaming.` paragraph |
| `src/chat/prompt.ts` | modify (after line 36) | when the chat bar streams, and when it only looks |
| `claude/skills/direct-stream/SKILL.md` | create | the `/direct-stream` skill |
| `scripts/install.sh` | modify (line 39) | `direct-stream` added to `SKILL_NAMES` |
| `tests/unit/directStream/match.test.ts` | create | parity with `match.mjs` |
| `tests/unit/directStream/lookup.test.ts` | create | lookup with a fake library and fake TMDB |
| `tests/unit/mcp.directStreamTools.test.ts` | create | the tools with a fake service |
| `tests/integration/directStream.lookup.int.test.ts` | create | `dbTitleLibrary` against Postgres |
| `tests/unit/chat-status.test.ts` | modify (lines 1-12, 17-43, 51-61) | the new names and captions |
| `tests/unit/mcp.instructions.test.ts` | modify (lines 286-288, append after 304) | paragraph order; the new paragraph |
| `tests/unit/chat-prompt.test.ts` | modify (append inside the describe that ends at line 199) | the new section |
| `docs/guide/reference/mcp-tools.md` | regenerate | `npm run docs:gen` |
| `docs/guide/streaming.md` | modify | top table row; `/direct-stream` under "What you can ask"; `### /direct-stream` under "Direct streaming"; "Where the code is" rows |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | modify (phase 3 creates it) | the `/direct-stream` entry |

## Implementation Steps

### Step 1: The title rule, ported
**File:** `src/directStream/match.ts` (new)
**Change:** A TypeScript copy of the rule in `claude/streaming/match.mjs:12-26` and `normalizeName` in `claude/skills/pahe/search.mjs:26-33`. The server build cannot import `.mjs` files from outside `src/`, so the rule is ported. Step 9's parity test runs both over the same cases, so the two cannot drift apart.
**Code:**
```ts
/**
 * The exact-title-and-year rule of the streaming sites (claude/streaming/match.mjs pickMatches),
 * for the daemon. The server build cannot import that .mjs, so it is ported here, and
 * tests/unit/directStream/match.test.ts runs both over the same cases so they cannot drift.
 */

/** What the owner asked for: a name, and a year when they gave one. */
export interface TitleQuery {
  name: string;
  year: number | null;
}

/** A title to test: its English name, its original-language name, its year. */
export interface NamedTitle {
  name: string;
  originalName: string | null;
  year: number | null;
}

/** Lower case, accents dropped, "&" read as "and", everything but letters and digits removed. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * True when `result` is the asked title: the same normalized name (its English or its original
 * one; the original also matches unnormalized, for a title in another script), and the same year
 * when a year was asked for and the result has one.
 */
export function isSameTitle(result: NamedTitle, query: TitleQuery): boolean {
  const wanted = normalizeName(query.name);
  const wantedRaw = query.name.normalize('NFKC').toLowerCase();
  const original = result.originalName;
  const sameName =
    normalizeName(result.name) === wanted ||
    (original !== null &&
      (original.normalize('NFKC').toLowerCase() === wantedRaw || (normalizeName(original) !== '' && normalizeName(original) === wanted)));
  const sameYear = query.year === null || result.year === null || result.year === query.year;
  return sameName && sameYear;
}
```
**Impact:** none outside this phase.

### Step 2: Title lookup
**File:** `src/directStream/lookup.ts` (new)
**Change:** This module turns words, a movie id (`M-23T4`, of a title or of one episode) or a title key (`movie-550`, `tv-1399`) into a TMDB reference.
- **Words:** `movie_titles` rows come first. That covers library titles, and stream-only titles that phase 5 stored when they were resolved, which is why this reads the table and not `listTitles` (phase 5's Library filter hides stream-only titles there). If no stored title matches, TMDB `searchMovie` and `searchTv` are asked in parallel.
- **Matching:** both sources go through `isSameTitle`.
- **Results:** exactly one match is `one`, more than one is `several` (most popular first for TMDB), and zero is `none`.
- **No TMDB:** without TMDB, a library miss is the error `tmdb_unavailable`.
- **Illegal states:** `StreamTarget` is a union, so a series target always has both season and episode.
**Code:**
```ts
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { movieEpisodes, movieIds, movieTitles } from '../db/schema.js';
import { normalizeMovieId, resolveMovieId } from '../movies/ids.js';
import type { TmdbClient, TmdbSearchHit } from '../movies/tmdb.js';
import { titleId, type TitleKind } from '../movies/types.js';
import { isSameTitle, type TitleQuery } from './match.js';
import type { StreamRef } from './types.js';

/** Candidates an answer lists at most. */
export const LOOKUP_MAX_CANDIDATES = 10;
/** Stored titles the loose SQL pre-filter hands to the exact rule. */
const LIBRARY_SCAN_LIMIT = 50;
/** A title key: movie-550, tv-1399 (any case). */
const TITLE_KEY = /^(movie|tv)-(\d+)$/i;

/**
 * What to stream: a film, or one episode of a series. A series without an episode cannot be built.
 * Phase 3's StreamRef (src/directStream/types.ts), named here for the lookup's readers.
 */
export type StreamTarget = StreamRef;

/** The movie_titles key of a target's title (movie-550, tv-1399). */
export function targetKey(target: StreamTarget): string {
  return titleId(target.kind, target.tmdbId);
}

export interface EpisodePick {
  season: number;
  episode: number;
}

export interface SeasonCount {
  season: number;
  episodes: number;
}

/** One title the words may mean. */
export interface TitleCandidate {
  kind: TitleKind;
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  /** The title's movie id (M-23T4) when a movie_titles row exists for it; null for a TMDB-only hit. */
  movieId: string | null;
}

/** What the tool was given, read once at the boundary by parseTitleRequest. */
export type LookupRequest =
  | { by: 'id'; text: string }
  | { by: 'words'; name: string; year: number | null; kind: TitleKind | null };

export type LookupResult =
  | { status: 'one'; candidate: TitleCandidate; /** Set when a movie id named one episode. */ episode: EpisodePick | null }
  | { status: 'several'; candidates: TitleCandidate[]; source: 'library' | 'tmdb' }
  | { status: 'none' };

/** The stored titles, read-only. dbTitleLibrary is the real one; tests pass a fake. */
export interface TitleLibrary {
  /** movie_titles rows whose name or synopsis contains the words: a loose pre-filter, the exact rule decides. */
  search(name: string, kind: TitleKind | null): Promise<TitleCandidate[]>;
  /** One stored title, or null. */
  byKey(kind: TitleKind, tmdbId: number): Promise<TitleCandidate | null>;
  /** What a movie id names (a title, or one episode of it), or null when no row has that id. */
  byMovieId(movieId: string): Promise<{ kind: TitleKind; tmdbId: number; episode: EpisodePick | null } | null>;
  /** Episodes per season (season 1 and up) from movie_episodes; [] when none are stored. */
  seasons(kind: TitleKind, tmdbId: number): Promise<SeasonCount[]>;
}

export interface LookupDeps {
  library: TitleLibrary;
  /** Null without TMDB credentials: only stored titles can be found. */
  tmdb: TmdbClient | null;
}

/** A lookup that cannot answer: the tool result reads `<code>: <message>`. */
export class LookupError extends Error {
  override readonly name = 'LookupError';
  constructor(
    readonly code: 'not_found' | 'tmdb_unavailable' | 'invalid_input',
    message: string,
  ) {
    super(message);
  }
}

/** Reads what the tool was given: a movie id or title key is an id, anything else is words. */
export function parseTitleRequest(title: string, year: number | null, kind: TitleKind | null): LookupRequest {
  const text = title.trim();
  if (normalizeMovieId(text) !== null || TITLE_KEY.test(text)) return { by: 'id', text };
  return { by: 'words', name: text, year, kind };
}

function fromHit(hit: TmdbSearchHit): TitleCandidate {
  return { kind: hit.kind, tmdbId: hit.tmdbId, title: hit.title, originalTitle: hit.originalTitle, year: hit.year, movieId: null };
}

function sameTitle(c: TitleCandidate, query: TitleQuery): boolean {
  return isSameTitle({ name: c.title, originalName: c.originalTitle, year: c.year }, query);
}

function fromMatches(matches: TitleCandidate[], source: 'library' | 'tmdb'): LookupResult {
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { status: 'one', candidate: only, episode: null };
  if (matches.length === 0) return { status: 'none' };
  return { status: 'several', candidates: matches.slice(0, LOOKUP_MAX_CANDIDATES), source };
}

async function lookupById(text: string, deps: LookupDeps): Promise<LookupResult> {
  const movieId = normalizeMovieId(text);
  let kind: TitleKind;
  let tmdbId: number;
  let episode: EpisodePick | null = null;
  if (movieId !== null) {
    const target = await deps.library.byMovieId(movieId);
    if (target === null) {
      throw new LookupError('not_found', `no title or episode has the movie id ${movieId}. Movie ids come from the movies_* and direct_stream_* tools; never invent one.`);
    }
    kind = target.kind;
    tmdbId = target.tmdbId;
    episode = target.episode;
  } else {
    const key = TITLE_KEY.exec(text);
    if (key === null) throw new LookupError('invalid_input', `"${text}" is neither a movie id (M-23T4) nor a title key (movie-550, tv-1399).`);
    kind = key[1]!.toLowerCase() as TitleKind;
    tmdbId = Number(key[2]);
  }
  const stored = await deps.library.byKey(kind, tmdbId);
  const key = titleId(kind, tmdbId);
  return { status: 'one', candidate: stored ?? { kind, tmdbId, title: key, originalTitle: key, year: null, movieId: null }, episode };
}

/**
 * The titles the owner's words (or id) may mean. Stored titles first: one or more exact matches
 * there answer without asking TMDB. Otherwise TMDB is searched (films and series, or the one kind
 * asked for), keeping the exact matches, most popular first.
 */
export async function lookupTitle(req: LookupRequest, deps: LookupDeps): Promise<LookupResult> {
  if (req.by === 'id') return lookupById(req.text, deps);
  const query: TitleQuery = { name: req.name, year: req.year };
  const stored = (await deps.library.search(req.name, req.kind)).filter((c) => sameTitle(c, query));
  if (stored.length > 0) return fromMatches(stored, 'library');
  const tmdb = deps.tmdb;
  if (tmdb === null) {
    throw new LookupError('tmdb_unavailable', `no stored title is called "${req.name}", and this server has no TMDB credentials to search further.`);
  }
  const kinds: TitleKind[] = req.kind === null ? ['movie', 'tv'] : [req.kind];
  const hits = (
    await Promise.all(kinds.map((kind) => (kind === 'movie' ? tmdb.searchMovie(req.name, req.year) : tmdb.searchTv(req.name, req.year))))
  ).flat();
  const matches = hits
    .map((hit) => ({ hit, candidate: fromHit(hit) }))
    .filter(({ candidate }) => sameTitle(candidate, query))
    .sort((a, b) => b.hit.popularity - a.hit.popularity)
    .map(({ candidate }) => candidate);
  return fromMatches(matches, 'tmdb');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function fromKey(key: string): { kind: TitleKind; tmdbId: number } {
  const m = TITLE_KEY.exec(key);
  if (m === null) throw new Error(`movie_titles id ${key} is not a title key`);
  return { kind: m[1]!.toLowerCase() as TitleKind, tmdbId: Number(m[2]) };
}

/** The real TitleLibrary over movie_titles, movie_ids and movie_episodes. Reads only. */
export function dbTitleLibrary(db: Db): TitleLibrary {
  const columns = {
    kind: movieTitles.kind,
    tmdbId: movieTitles.tmdbId,
    title: movieTitles.title,
    originalTitle: movieTitles.originalTitle,
    year: movieTitles.year,
    movieId: movieIds.id,
  };
  const titleIdRow = and(eq(movieIds.titleId, movieTitles.id), isNull(movieIds.season), isNull(movieIds.episode));
  return {
    async search(name, kind) {
      const like = `%${escapeLike(name)}%`;
      const text = sql`(movie_titles.search_tsv @@ websearch_to_tsquery('simple', ${name})
        or ${movieTitles.title} ilike ${like} or ${movieTitles.originalTitle} ilike ${like})`;
      const rows = await db
        .select(columns)
        .from(movieTitles)
        .leftJoin(movieIds, titleIdRow)
        .where(kind === null ? text : and(text, eq(movieTitles.kind, kind)))
        .limit(LIBRARY_SCAN_LIMIT);
      return rows.map((r) => ({ ...r, kind: r.kind as TitleKind, movieId: r.movieId ?? null }));
    },
    async byKey(kind, tmdbId) {
      const [row] = await db
        .select(columns)
        .from(movieTitles)
        .leftJoin(movieIds, titleIdRow)
        .where(eq(movieTitles.id, titleId(kind, tmdbId)))
        .limit(1);
      return row === undefined ? null : { ...row, kind: row.kind as TitleKind, movieId: row.movieId ?? null };
    },
    async byMovieId(movieId) {
      const target = await resolveMovieId(db, movieId);
      if (target === null) return null;
      const episode = target.season !== null && target.episode !== null ? { season: target.season, episode: target.episode } : null;
      return { ...fromKey(target.titleId), episode };
    },
    async seasons(kind, tmdbId) {
      const rows = await db
        .select({ season: movieEpisodes.season, episodes: sql<number>`count(*)::int` })
        .from(movieEpisodes)
        .where(and(eq(movieEpisodes.titleId, titleId(kind, tmdbId)), sql`${movieEpisodes.season} >= 1`))
        .groupBy(movieEpisodes.season)
        .orderBy(movieEpisodes.season);
      return rows;
    },
  };
}
```
**Impact:** new module, no callers until Step 4.

### Step 3: Tool names, allow list, captions
**File:** `src/chat/status.ts:80` (insert after `StreamingToolName`), `:111-134` (`allowedChatTools` doc and body), `:240` (switch)
**Change:** Add the names, allow them in the chat bar, and caption them. The list is written so that phase 8 appends two names to it.
**Code:** insert after line 80:
```ts

/**
 * The direct-streaming tools (src/mcp/directStreamTools.ts): direct_stream_find looks a title up
 * and says whether this machine has a fresh verified stream of it; direct_stream_play resolves
 * one film or episode and opens the daemon's player page full screen in the streaming Chrome.
 * DIRECT_STREAMING_PLAN phase 8 appends the registry tools.
 */
export const DIRECT_STREAM_TOOL_NAMES = ['direct_stream_find', 'direct_stream_play'] as const;

export type DirectStreamToolName = (typeof DIRECT_STREAM_TOOL_NAMES)[number];
```
Replace the doc comment's first two lines (lines 112-113) so they read:
```ts
 * Exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 6 movie tools, the 2
 * streaming tools, the direct-streaming tools, the connector tools and WebSearch + WebFetch (CONNECTORS_PLAN invariant 8, which supersedes
```
and in the body, after line 128 (`...STREAMING_TOOL_NAMES.map(...)`), add:
```ts
    ...DIRECT_STREAM_TOOL_NAMES.map((name) => `${MCP_PREFIX}${name}`),
```
In `captionForToolUse`, after the `case 'streaming_play':` / `return 'starting a film';` pair (lines 239-240), add:
```ts
    case 'direct_stream_find':
      return 'looking for a stream';
    case 'direct_stream_play':
      return 'starting a stream';
```
**Impact:** the chat agent (`src/chat/agent.ts:320`) is allowed the two tools. `tests/unit/chat-status.test.ts` must change in the same step (Step 10).

### Step 4: The tools
**File:** `src/mcp/directStreamTools.ts` (new)
**Change:**
- **`direct_stream_find`:** a lookup only. Each match carries whether this host has a fresh verified source, and nothing resolves or opens.
- **`direct_stream_play`:** these cases start nothing, as R3.2 asks:
  - several matches: `skipped_play: several_matches` and the candidates.
  - a series with no episode: `skipped_play: series` and its seasons.
  - no match: `skipped_play: no_match`.
- **R3.1:** with one film, or one named episode, the tool calls `play(target)` and answers `started: true` with the service's answer as `play`.
- **R3.3:** a `no_source` failure answers an error result whose JSON carries `error: "no_source"` and each provider's `attempts`. Phase 3's other failures (`resolve_failed`, `open_failed`) answer an error result with `error` (the code), `reason` (`no_chrome`, `chrome_not_reachable`, ...), `started: false` and `attempts`.
- **R2.6:** without `deps.directStream`, both tools answer `DIRECT_STREAM_OFF`. `directStreamToolDeps` is null when the service, the movies service or the config section is missing, so movies off means streaming off. This is the tools half of R2.6, whose criterion phase 3 owns.
**Code:**
```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DIRECT_STREAM_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import {
  dbTitleLibrary,
  LookupError,
  lookupTitle,
  parseTitleRequest,
  targetKey,
  type EpisodePick,
  type SeasonCount,
  type StreamTarget,
  type TitleCandidate,
  type TitleLibrary,
} from '../directStream/lookup.js';
import { DirectStreamError } from '../directStream/types.js';
import { isFreshStreamSource, streamFreshSince } from '../movies/repo.js';
import { TmdbError, type TmdbClient } from '../movies/tmdb.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { movieErrorResult } from './movieTools.js';
import { jsonResult, type ToolDeps } from './tools.js';

const [FIND, PLAY] = DIRECT_STREAM_TOOL_NAMES;

export const DIRECT_STREAM_OFF =
  'direct_stream_off: direct streaming is not running on this server (NOTESD_DIRECT_STREAM=off, NOTESD_MOVIES=off, or the daemon was started without it), so nothing can be streamed here.';

/** This host's fresh verified source of a film or one episode (phase 5's movie_stream_sources). */
export interface FreshSource {
  provider: string;
  manifestKind: string;
  bestHeight: number | null;
  enSubtitle: boolean | null;
  verifiedAt: Date;
}

/** What the direct-streaming tools need, bound once per daemon by directStreamToolDeps (tests build their own). */
export interface DirectStreamToolDeps {
  library: TitleLibrary;
  tmdb: TmdbClient | null;
  /** DirectStreamService.play: resolve, then open the player page full screen in the streaming Chrome, resuming where the last stream stopped. */
  play(target: StreamTarget): Promise<unknown>;
  /** This host's source verified inside the freshness window, or null. */
  freshSource(target: StreamTarget): Promise<FreshSource | null>;
}

/** The tool deps of a running daemon, or null when direct streaming (or the movie library under it) is off. */
export function directStreamToolDeps(deps: AppDeps): DirectStreamToolDeps | null {
  const service = deps.directStream ?? null;
  const movies = deps.movies;
  const config = deps.config.directStream;
  if (service === null || movies === null || config === undefined || !config.enabled) return null;
  return {
    library: dbTitleLibrary(deps.db),
    tmdb: movies.tmdb,
    play: (target) => service.play(target),
    freshSource: async (target) => {
      // Phase 5's one freshness rule: this host's row of the film (0, 0) or the episode, fresh as of now.
      const season = target.kind === 'tv' ? target.season : 0;
      const episode = target.kind === 'tv' ? target.episode : 0;
      const since = streamFreshSince(new Date(), config.freshDays);
      const row = (await movies.repo.streamSourcesOfTitle(targetKey(target), movies.host)).find(
        (r) => r.season === season && r.episode === episode && isFreshStreamSource(r, movies.host, since),
      );
      // A fresh row is verified, so it has a provider and a manifest kind (movie_stream_sources_outcome_check).
      return row === undefined || row.verifiedAt === null
        ? null
        : { provider: row.provider ?? '', manifestKind: row.manifestKind ?? '', bestHeight: row.bestHeight, enSubtitle: row.enSubtitle, verifiedAt: row.verifiedAt };
    },
  };
}

const FIND_DESCRIPTION =
  "Look a film or series up for direct streaming: a stream played in the owner's own player page straight from a cloud source, with no site and no adverts. " +
  'Pass title (the words without the year; or a movie id like M-23T4, of a title or of one episode; or a title key like movie-550 or tv-1399), year when known, and kind (movie or tv) when the owner said which. ' +
  "Titles already stored (the library, and titles streamed before) are matched first, then TMDB. A title matches when its English or original name is the asked title and its year is the asked year when one was given. " +
  'Returns { status: one | several | none, matches: [{ title, original_title, year, kind, tmdb_id, movie_id, url, tmdb_url, episode, stream }] }. stream says whether this machine has a source verified recently: ' +
  'verified true with provider, manifest_kind, best_height and en_subtitle; verified false when none is known yet (it may still stream: only playing tries); verified null for a series named without an episode, whose episodes are checked when played. ' +
  'This tool only looks: nothing is resolved and nothing opens. To start one, call direct_stream_play.';

const PLAY_DESCRIPTION =
  'Stream one film, or one episode of a series, directly: the daemon finds a cloud source (providers with an English subtitle first), then opens its own player page full screen in the streaming Chrome window on the Windows side, ' +
  'resuming where the last stream of it stopped. It takes 5 to 40 seconds; call it once and wait. ' +
  'Call it only when the owner asks to stream (/direct-stream <title>, "stream it", "let\'s direct-stream the first one"). A film in the library plays in VLC with movies_continue unless the owner says stream; a recommendation is not a request; a question is direct_stream_find. ' +
  'Pass title (words without the year, a movie id, or a title key) with year when known; for a series also season and episode (an episode\'s movie id names both). ' +
  'started true: the player page is open, and play carries the session and the source (provider, quality, subtitles). ' +
  'started false with skipped_play says why nothing started: several_matches (list candidates with their years and ask which, then call again with that one\'s movie_id, or title and year), ' +
  'series (ask for a season and an episode; seasons lists what there is), or no_match. ' +
  'The error no_source means no provider could stream it: attempts lists each provider with its outcome (resolved, no_stream, bot_check, error, skipped_browser_only, skipped_no_template), and nothing started; offer /idlix or /lk21. ' +
  'The errors resolve_failed and open_failed mean the streaming Chrome could not be used: reason says why (no_chrome, chrome_not_reachable, ...). ' +
  'Tell the owner it plays in the streaming Chrome window and that F11 leaves full screen. Works only on the machine with Windows Chrome.';

const titleField = z.string().trim().min(1).max(200);
const yearField = z.number().int().min(1880).max(2100);
const kindField = z.enum(['movie', 'tv']);
const seasonField = z.number().int().min(0).max(1000);
const episodeField = z.number().int().min(0).max(100000);

function ok(value: unknown): CallToolResult {
  return jsonResult(value, true);
}

function failJson(value: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

async function respond(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return movieErrorResult(err);
  }
}

function label(c: TitleCandidate): string {
  return c.year === null ? c.title : `${c.title} (${c.year})`;
}

function candidateView(c: TitleCandidate, wall: string) {
  return {
    title: c.title,
    ...(c.originalTitle !== c.title ? { original_title: c.originalTitle } : {}),
    year: c.year,
    kind: c.kind,
    tmdb_id: c.tmdbId,
    movie_id: c.movieId,
    url: c.movieId === null ? null : `${wall}/movies/${encodeURIComponent(c.movieId)}`,
    tmdb_url: `https://www.themoviedb.org/${c.kind}/${c.tmdbId}`,
  };
}

/** The film, the episode a movie id named, or the season and episode passed; null for a series with no episode. */
function targetFor(c: TitleCandidate, named: EpisodePick | null, season: number | undefined, episode: number | undefined): StreamTarget | null {
  if (c.kind === 'movie') {
    if (season !== undefined || episode !== undefined) {
      throw new LookupError('invalid_input', `${label(c)} is a film: it takes no season or episode.`);
    }
    return { kind: 'movie', tmdbId: c.tmdbId };
  }
  const pick = named ?? (season !== undefined && episode !== undefined ? { season, episode } : null);
  return pick === null ? null : { kind: 'tv', tmdbId: c.tmdbId, season: pick.season, episode: pick.episode };
}

/** A series' seasons with their episode counts: stored episodes first, else TMDB; null when neither knows. */
async function seasonsOf(c: TitleCandidate, d: DirectStreamToolDeps): Promise<SeasonCount[] | null> {
  const stored = await d.library.seasons(c.kind, c.tmdbId);
  if (stored.length > 0) return stored;
  if (d.tmdb === null) return null;
  try {
    const meta = await d.tmdb.tvDetails(c.tmdbId);
    const counts = new Map<number, number>();
    for (const e of meta.episodes) if (e.season >= 1) counts.set(e.season, (counts.get(e.season) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a - b).map(([season, episodes]) => ({ season, episodes }));
  } catch (err) {
    if (err instanceof TmdbError) return null;
    throw err;
  }
}

async function streamView(d: DirectStreamToolDeps, target: StreamTarget | null) {
  if (target === null) return { verified: null, note: 'a series is checked per episode, when one is played' };
  const s = await d.freshSource(target);
  if (s === null) return { verified: false };
  return {
    verified: true,
    provider: s.provider,
    manifest_kind: s.manifestKind,
    best_height: s.bestHeight,
    en_subtitle: s.enSubtitle,
    verified_at: s.verifiedAt.toISOString(),
  };
}

/**
 * A failure DirectStreamService.play threw (phase 3's DirectStreamError), as the tool answers it:
 * `no_source` with every attempt, or `resolve_failed` / `open_failed` with the `reason` (no_chrome,
 * chrome_not_reachable, ...). Null for anything else, which movieErrorResult answers.
 */
function playFailure(err: unknown): { error: string; reason: string | null; attempts: unknown[]; message: string } | null {
  if (!(err instanceof DirectStreamError)) return null;
  return { error: err.code, reason: err.code === 'no_source' ? null : err.reason, attempts: err.attempts, message: err.message };
}

/**
 * direct_stream_find and direct_stream_play (DIRECT_STREAMING_PLAN phase 7). Words become a TMDB
 * reference through src/directStream/lookup.ts; a play goes through DirectStreamService.play.
 * Without deps.directStream both answer DIRECT_STREAM_OFF and nothing is looked up or started.
 */
export function registerDirectStreamTools(server: McpServer, deps: Pick<ToolDeps, 'directStream' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  const off = (): CallToolResult => ({ isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] });

  server.registerTool(
    FIND,
    {
      title: 'Find a title to stream directly',
      description: FIND_DESCRIPTION,
      inputSchema: {
        title: titleField.describe('The film or series title without the year, a movie id (M-23T4), or a title key (movie-550).'),
        year: yearField.optional().describe('The release year, when known. Tells a remake from its original.'),
        kind: kindField.optional().describe('"movie" or "tv" (a series), when the owner said which.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ title, year, kind }) => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => {
        const result = await lookupTitle(parseTitleRequest(title, year ?? null, kind ?? null), d);
        const found =
          result.status === 'none'
            ? []
            : result.status === 'one'
              ? [{ candidate: result.candidate, episode: result.episode }]
              : result.candidates.map((candidate) => ({ candidate, episode: null }));
        const matches = await Promise.all(
          found.map(async ({ candidate, episode }) => ({
            ...candidateView(candidate, wall),
            episode,
            stream: await streamView(d, targetFor(candidate, episode, undefined, undefined)),
          })),
        );
        return ok({
          status: result.status,
          matches,
          next:
            result.status === 'none'
              ? 'No title has that name (or that name and year). Say so; offer a near spelling only if the owner asks.'
              : 'Nothing was started. To stream one, call direct_stream_play with its movie_id, or its title and year.',
        });
      });
    },
  );

  server.registerTool(
    PLAY,
    {
      title: 'Stream a film or episode directly, full screen',
      description: PLAY_DESCRIPTION,
      inputSchema: {
        title: titleField.describe('The film or series title without the year, a movie id (M-23T4; an episode\'s id names its season and episode), or a title key (movie-550).'),
        year: yearField.optional().describe('The release year, when known.'),
        kind: kindField.optional().describe('"movie" or "tv" (a series), when the owner said which.'),
        season: seasonField.optional().describe('A series only: the season to stream from.'),
        episode: episodeField.optional().describe('A series only: the episode number within that season.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, year, kind, season, episode }) => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => {
        const result = await lookupTitle(parseTitleRequest(title, year ?? null, kind ?? null), d);
        if (result.status === 'none') {
          return ok({ started: false, skipped_play: 'no_match', query: { title, year: year ?? null }, next: 'No title has that name (or that name and year). Say so; nothing started.' });
        }
        if (result.status === 'several') {
          return ok({
            started: false,
            skipped_play: 'several_matches',
            candidates: result.candidates.map((c) => candidateView(c, wall)),
            next: 'Nothing started. List the candidates with their years and ask which one; then call again with its movie_id, or its title and year.',
          });
        }
        const c = result.candidate;
        const target = targetFor(c, result.episode, season, episode);
        if (target === null) {
          return ok({
            started: false,
            skipped_play: 'series',
            title: candidateView(c, wall),
            seasons: await seasonsOf(c, d),
            next: 'A series streams one episode at a time. Ask which season and episode; nothing started.',
          });
        }
        const picked = target.kind === 'tv' ? { season: target.season, episode: target.episode } : { season: null, episode: null };
        try {
          const play = await d.play(target);
          return ok({
            started: true,
            title: candidateView(c, wall),
            ...picked,
            play,
            next: 'Say it is playing full screen in the streaming Chrome window, and that F11 leaves full screen.',
          });
        } catch (err) {
          const failure = playFailure(err);
          if (failure === null) throw err;
          if (failure.error === 'no_source') {
            return failJson({
              error: 'no_source',
              started: false,
              title: candidateView(c, wall),
              ...picked,
              attempts: failure.attempts,
              next: 'No provider could stream it and nothing started. Tell the owner, one short line per provider with its outcome, and offer /idlix or /lk21.',
            });
          }
          return failJson({
            error: failure.error,
            reason: failure.reason,
            started: false,
            title: candidateView(c, wall),
            ...picked,
            attempts: failure.attempts,
            message: failure.message,
            next: 'Nothing is playing. Say in one line why (reason: no_chrome means Chrome is not installed on Windows, chrome_not_reachable that the streaming Chrome did not answer), and offer /idlix or /lk21.',
          });
        }
      });
    },
  );
}
```
**Impact:** none until Step 5 wires it.

### Step 5: Wire the tools into the MCP server
**Files:** `src/mcp/tools.ts:14-15, 41-42`; `src/mcp/server.ts:10, 33`; `src/http/app.ts:9, 84`
**Change:** Add the `ToolDeps` field, register the tools after the streaming tools, and build the deps in `mcpToolDeps`.
**Code:**
`src/mcp/tools.ts`, after line 15 (`import type { StreamingRunner } ...`):
```ts
import type { DirectStreamToolDeps } from './directStreamTools.js';
```
and after line 42 (`streaming?: StreamingRunner | null;`):
```ts
  /** Direct streaming behind direct_stream_find / direct_stream_play (DIRECT_STREAMING_PLAN phase 7). Omitted or null: both answer direct_stream_off. */
  directStream?: DirectStreamToolDeps | null;
```
`src/mcp/server.ts`, after line 10:
```ts
import { registerDirectStreamTools } from './directStreamTools.js';
```
and after line 33 (`registerStreamingTools(server, deps);`):
```ts
  // Direct streaming (DIRECT_STREAMING_PLAN phase 7). Answer direct_stream_off when deps.directStream is unset.
  registerDirectStreamTools(server, deps);
```
`src/http/app.ts`, after line 9:
```ts
import { directStreamToolDeps } from '../mcp/directStreamTools.js';
```
and after line 84 (`streaming: deps.streaming ?? null,`):
```ts
    directStream: directStreamToolDeps(deps),
```
Also append to `mcpToolDeps`' doc comment (line 66): ` \`directStream\` is null while direct streaming or the movie library is off; building it does no I/O.`
**Impact:** `/mcp` lists 2 more tools. `tests/unit/docs/reference.test.ts` fails until Step 11's `docs:gen`.

### Step 5b: Stream-only titles in the movie tools (reconciler, from phase 5's handoff)
**File:** `src/mcp/movieTools.ts:186` (`resolveTitleId`), `:389` (the `movies_get` description), `:394-396` (`HISTORY_DESCRIPTION`)
**Change:** phase 5's `listTitles` leaves out titles known only from streams unless `scope: 'all'`;
the movie tools' name lookup must still find them ("rate Saltburn" after streaming it), and their
descriptions name the new play source.
**Code:** in `resolveTitleId`, line 186:
```ts
  const hits = await listTitles(db, { q, limit: 6, scope: 'all' }, ctx);
```
In the `movies_get` description (line 389), replace
`source "live" = VLC started by notesd or "vlc_recents" = read from VLC\'s recent list).` with
`source "live" = VLC started by notesd, "vlc_recents" = read from VLC\'s recent list, or "stream" = the direct-stream player page, with provider for a stream play and no file).`
In `HISTORY_DESCRIPTION` (line 394), replace `ratio, source, host, title_id,` with
`ratio, source (live, vlc_recents or stream), provider (a stream play's provider, else null), host, title_id,`
and append to its last sentence: ` A stream play has file_id null and file_deleted false.`
Then `npm run docs:gen` (Step 12) regenerates `mcp-tools.md`.
**Impact:** `movies_list` (`listTitles` without `scope`) still lists the Library only (invariant
10); `movies_get`, `movies_mark` and `movies_history` with a title name also find a stream-only
title. Neighbor check: `npm run test:int -- tests/integration/movies.mcp.int.test.ts` passes unchanged.

### Step 6: The MCP instructions
**File:** `src/mcp/instructions.ts:23-29` (doc comment), after line 60 (the `Streaming.` paragraph)
**Change:** Add one `Direct streaming.` paragraph between `Streaming.` and `Adversary.`. Append to the doc comment: `direct-streaming phase 7 inserts the Direct streaming paragraph after Streaming, before Adversary.`
**Code:** insert as a new array element after line 60:
```ts
    `Direct streaming. direct_stream_play streams one film, or one episode of a series, straight from a cloud source into the daemon's own player page, full screen in the streaming Chrome window, with an English subtitle when any source has one and no adverts, resuming where the last stream of it stopped (5 to 40 seconds); direct_stream_find only looks a title up and says whether this machine has a recently verified source. Call direct_stream_play only when the user asks to stream ("/direct-stream saltburn", "stream it"); a question ("can I stream it directly?") is direct_stream_find, a film in the library plays in VLC with movies_continue unless the user says stream, and a recommendation is not a request. Pass the exact title with its year: words like "the first one" are resolved from the conversation to one title first ("this is a LOTR night. let's /direct-stream the first one" is The Lord of the Rings: The Fellowship of the Ring, 2001). A series needs season and episode. Nothing starts when several titles match (list them with their years and ask), for a series without an episode (ask which; seasons lists them), or on no_source (no provider could stream it: give each provider's outcome from attempts and offer /idlix or /lk21). When it answers started: true, say the film is playing in the streaming Chrome window and that F11 leaves full screen. Off on this server, the tools answer direct_stream_off.`,
```
**Impact:** the `Adversary` paragraph index moves by one (Step 10 updates the order test).

### Step 7: The chat bar prompt
**File:** `src/chat/prompt.ts`, after line 36 (the idlix/lk21 section)
**Change:** Add one section saying when the bar streams and when it only looks. The library rule and "a recommendation is not a request" carry over from the streaming section.
**Code:** insert as a new array element after line 36:
```ts

    // DIRECT_STREAMING_PLAN phase 7: the wall's side of the /direct-stream skill
    // (claude/skills/direct-stream/SKILL.md), through src/mcp/directStreamTools.ts.
    `The owner can also stream a film or one episode directly, from a cloud source into their own player page, with no site and no adverts, through two tools: direct_stream_find and direct_stream_play. A message that starts with /direct-stream followed by a title ("/direct-stream saltburn", "/direct-stream the bear season 2 episode 3"), or asks to stream something directly ("stream it", "direct-stream that one"), means start it: call direct_stream_play with the exact title, the year when you know it, and for a series the season and episode. Words like "it", "that one" or "the first one" are resolved first, from the conversation, the [Movies line or what you know, into one title with its year: "this is a LOTR night. let's /direct-stream the first one" is The Lord of the Rings: The Fellowship of the Ring (2001). It opens the daemon's player page full screen in the streaming Chrome window and takes 5 to 40 seconds, so call it once and wait. When it answers started true, say in one line which title is playing, from which provider and whether an English subtitle is on (from play), that it plays full screen in the streaming Chrome window and that F11 leaves full screen, with the title's movie id when it has one. When skipped_play is several_matches, list the candidates with their years and ask which one, then call direct_stream_play again with the chosen one's movie_id; when it is series, list the seasons and ask which season and episode; when it is no_match, say no title has that name. When it answers no_source, say no source could stream it, with each provider's outcome from attempts in one short line, and offer /idlix or /lk21; do not call again unless the owner asks. A question ("can I stream Saltburn directly?", "is it streamable?") is a lookup, not a request to play: call direct_stream_find and answer with each match and whether this laptop has a verified source. A film that is in the library is played with movies_continue in VLC unless the owner says stream or /direct-stream. Do not start a stream because you recommended a film; only when asked.`,
```
**Impact:** the chat prompt grows by one section. The existing idlix/lk21 section is unchanged (invariant 8).

### Step 8: The `/direct-stream` skill, and installing it
**Files:** `claude/skills/direct-stream/SKILL.md` (new); `scripts/install.sh:39`
**Change:** The skill calls the notes MCP tools, with no script of its own. `install.sh` does **not** link every folder of `claude/skills`: it links the names in `SKILL_NAMES` (line 39) and `check_preconditions` (line 114) requires each one's `SKILL.md`. So `direct-stream` is added to that array.
**Code:** `scripts/install.sh:39` becomes:
```sh
SKILL_NAMES=(n migrate check-seer-adversarial-nightly redo v j trace-vlc-bug pahe idlix lk21 create-streaming-skill direct-stream)
```
`claude/skills/direct-stream/SKILL.md`:
````markdown
---
name: direct-stream
description: Stream a film or one episode of a series straight from a cloud source into mcp-notes' own player page, full screen in the streaming Chrome on Windows, with an English subtitle when a source has one and no site adverts. Use whenever the user types "/direct-stream <title>" or "/direct-stream <title> <year>" in any Claude Code session — e.g. "/direct-stream saltburn", "/direct-stream dune 2021", "/direct-stream the bear season 2 episode 3", "this is a LOTR night. let's /direct-stream the first one" — and for a plain-English request to the same effect, such as "stream Saltburn directly", "direct-stream that one". A question such as "can I stream Saltburn directly?" is a lookup that starts nothing.
argument-hint: <title> [year] [season N episode M]
---

# /direct-stream — stream a film straight to the player page

The text after `/direct-stream` names a film or a series episode. Start it through the `notes` MCP
server's tools, `mcp__notes__direct_stream_play` and `mcp__notes__direct_stream_find`. Do not
answer from memory, do not build a stream address, and do not open a provider's page yourself:
the daemon finds the source and opens the player.

How it works, and what can go wrong, is in `docs/guide/streaming.md` of the mcp-notes repo
("Direct streaming").

## Step 1: work out one title

- **The user typed it:** `/direct-stream saltburn` is the title "saltburn", no year.
  `/direct-stream dune 2021` is "dune", year 2021. A trailing number is a year only when words
  come before it and it is a plausible release year, so `/direct-stream 1917` and
  `/direct-stream blade runner 2049` are whole titles.
- **The user points at one:** "the first one", "that one", "it" mean a title from this
  conversation or from what you know. "this is a LOTR night. let's /direct-stream the first one"
  is The Lord of the Rings: The Fellowship of the Ring, 2001. Pass that exact title and year.
  When you cannot tell which title is meant, ask; do not guess between two.
- **A series:** pass `kind: "tv"`, `season` and `episode` ("the bear season 2 episode 3").
  An episode's movie id (`M-23T4`) names both, so pass it alone as `title`.
- **A movie id or title key** from an earlier answer (`M-23T4`, `movie-550`) is passed as
  `title` as is.

## Step 2: play, or look

`/direct-stream <title>` and "stream it" mean start it: call `direct_stream_play` once with
`title`, `year` when known, and `kind`, `season`, `episode` for a series. It takes 5 to 40
seconds; wait for it.

A question ("can I stream it directly?", "is Saltburn streamable?") is a lookup: call
`direct_stream_find`. It opens nothing.

The rule for a film in the library: `/direct-stream` or "stream" means stream it, even when the
file is here. Without those words a library film plays in VLC (`movies_continue`), not here.

## Step 3: answer

- **`started: true`:** one line: the title (with its year and movie id when it has one), the
  provider and whether an English subtitle is on (from `play`), that it plays full screen in the
  streaming Chrome window, and that F11 leaves full screen.
- **`skipped_play: "several_matches"`:** one line per candidate with its year and kind; ask which
  one. When the user picks, call `direct_stream_play` again with that candidate's `movie_id`
  (or its exact title and year when it has none).
- **`skipped_play: "series"`:** say a series streams one episode at a time, list `seasons` (season
  and number of episodes) and ask which season and episode.
- **`skipped_play: "no_match"`:** say no title has that name (and year). One retry is worth it
  when the title has an obvious other form (an original-language title, without a subtitle);
  say which name found it.
- **Error `no_source`:** nothing started. Say no source could stream it, then one short line per
  provider from `attempts` with its `outcome` (`no_stream`, `bot_check`, `error`,
  `skipped_browser_only`). Offer `/idlix` or `/lk21`. Do not call again unless asked.
- **`direct_stream_off`:** direct streaming is off on this daemon (or this is the machine
  without it). Say so; offer `/idlix` or `/lk21`.
- **Error `resolve_failed` or `open_failed`:** the streaming Chrome could not be used; report
  `reason` in one line (`no_chrome`: Chrome is not installed on Windows; `chrome_not_reachable`:
  the streaming Chrome did not answer) and offer `/idlix` or `/lk21`.
- **Another error:** report it in one line.

Never start a stream the user did not ask for, and never because you recommended a film.
Keep the answer short.
````
**Impact:** after `scripts/install.sh`, `~/.claude/skills/direct-stream` is a symlink to this folder.

### Step 9: Unit tests for the rule and the lookup
**Files:** `tests/unit/directStream/match.test.ts`, `tests/unit/directStream/lookup.test.ts` (new)
**Code:** `tests/unit/directStream/match.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isSameTitle } from '../../../src/directStream/match.js';
// @ts-expect-error -- a plain .mjs module without type declarations
import { pickMatches } from '../../../claude/streaming/match.mjs';

type Case = [query: string, year: number | null, name: string, original: string | null, resultYear: number | null];

const CASES: Case[] = [
  ['saltburn', null, 'Saltburn', 'Saltburn', 2023],
  ['saltburn', null, 'Saltburn 2', null, 2026],
  ['dune', 2021, 'Dune', 'Dune', 2021],
  ['dune', 2021, 'Dune', 'Dune', 1984],
  ['dune', null, 'Dune', 'Dune', 1984],
  ['spider-man: no way home', null, 'Spider-Man: No Way Home', null, 2021],
  ['fast & furious', null, 'Fast and Furious', null, 2009],
  ['amelie', null, 'Amélie', "Le Fabuleux Destin d'Amélie Poulain", 2001],
  ['the host', 2006, 'The Host', '괴물', null],
  ['기생충', null, 'Parasite', '기생충', 2019],
  ['parasite', 2019, 'Parasite', '기생충', 2019],
  ['the lord of the rings: the fellowship of the ring', 2001, 'The Lord of the Rings: The Fellowship of the Ring', null, 2001],
  ['the lord of the rings', null, 'The Lord of the Rings: The Fellowship of the Ring', null, 2001],
];

describe('isSameTitle', () => {
  it.each(CASES)('agrees with claude/streaming/match.mjs for %s (%s) vs %s', (query, year, name, original, resultYear) => {
    const script = pickMatches([{ name, original_name: original, year: resultYear }], { name: query, year }).matches.length === 1;
    expect(isSameTitle({ name, originalName: original, year: resultYear }, { name: query, year })).toBe(script);
  });

  it('keeps a remake apart from its original only when a year is given', () => {
    const dune1984 = { name: 'Dune', originalName: 'Dune', year: 1984 };
    expect(isSameTitle(dune1984, { name: 'dune', year: null })).toBe(true);
    expect(isSameTitle(dune1984, { name: 'dune', year: 2021 })).toBe(false);
  });
});
```
`tests/unit/directStream/lookup.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import {
  LOOKUP_MAX_CANDIDATES,
  lookupTitle,
  parseTitleRequest,
  type SeasonCount,
  type TitleCandidate,
  type TitleLibrary,
} from '../../../src/directStream/lookup.js';
import type { TmdbClient, TmdbSearchHit } from '../../../src/movies/tmdb.js';

const stored = (over: Partial<TitleCandidate> & Pick<TitleCandidate, 'title'>): TitleCandidate => ({
  kind: 'movie',
  tmdbId: 1,
  originalTitle: over.title,
  year: null,
  movieId: null,
  ...over,
});

function fakeLibrary(titles: TitleCandidate[], movieIds: Record<string, { kind: 'movie' | 'tv'; tmdbId: number; episode: { season: number; episode: number } | null }> = {}, seasons: SeasonCount[] = []): TitleLibrary {
  return {
    search: vi.fn(async (_name: string, kind: 'movie' | 'tv' | null) => titles.filter((t) => kind === null || t.kind === kind)),
    byKey: vi.fn(async (kind: 'movie' | 'tv', tmdbId: number) => titles.find((t) => t.kind === kind && t.tmdbId === tmdbId) ?? null),
    byMovieId: vi.fn(async (id: string) => movieIds[id] ?? null),
    seasons: vi.fn(async () => seasons),
  };
}

const hit = (over: Partial<TmdbSearchHit> & Pick<TmdbSearchHit, 'title' | 'tmdbId'>): TmdbSearchHit => ({
  kind: 'movie',
  originalTitle: over.title,
  releaseDate: null,
  year: null,
  overview: '',
  posterPath: null,
  popularity: 1,
  ...over,
});

function fakeTmdb(movies: TmdbSearchHit[], tv: TmdbSearchHit[] = []) {
  return {
    searchMovie: vi.fn(async () => movies),
    searchTv: vi.fn(async () => tv),
  } as unknown as TmdbClient & { searchMovie: ReturnType<typeof vi.fn>; searchTv: ReturnType<typeof vi.fn> };
}

const words = (title: string, year: number | null = null) => parseTitleRequest(title, year, null);

describe('lookupTitle', () => {
  it('reads a movie id and a title key as ids, and anything else as words', () => {
    expect(parseTitleRequest(' m-23t4 ', null, null)).toEqual({ by: 'id', text: 'm-23t4' });
    expect(parseTitleRequest('TV-1399', null, null)).toEqual({ by: 'id', text: 'TV-1399' });
    expect(parseTitleRequest('M3GAN', 2022, null)).toEqual({ by: 'words', name: 'M3GAN', year: 2022, kind: null });
  });

  it('answers from the stored titles without asking TMDB when one matches exactly', async () => {
    const tmdb = fakeTmdb([hit({ title: 'Saltburn', tmdbId: 930564, year: 2023 })]);
    const library = fakeLibrary([stored({ title: 'Saltburn', tmdbId: 930564, year: 2023, movieId: 'M-23T4' }), stored({ title: 'Saltburn Road', tmdbId: 5 })]);
    const r = await lookupTitle(words('saltburn'), { library, tmdb });
    expect(r).toEqual({ status: 'one', candidate: expect.objectContaining({ tmdbId: 930564, movieId: 'M-23T4' }), episode: null });
    expect(tmdb.searchMovie).not.toHaveBeenCalled();
  });

  it('asks TMDB for films and series when nothing stored matches, keeping exact names, most popular first', async () => {
    const tmdb = fakeTmdb(
      [hit({ title: 'Dune', tmdbId: 841, year: 1984, popularity: 10 }), hit({ title: 'Dune', tmdbId: 438631, year: 2021, popularity: 90 }), hit({ title: 'Dune: Part Two', tmdbId: 693134, year: 2024 })],
      [hit({ kind: 'tv', title: 'Dune', tmdbId: 1000, year: 2000, popularity: 5 })],
    );
    const r = await lookupTitle(words('dune'), { library: fakeLibrary([]), tmdb });
    expect(r.status).toBe('several');
    if (r.status !== 'several') return;
    expect(r.source).toBe('tmdb');
    expect(r.candidates.map((c) => [c.kind, c.tmdbId])).toEqual([['movie', 438631], ['movie', 841], ['tv', 1000]]);
  });

  it('narrows by year and kind', async () => {
    const tmdb = fakeTmdb([hit({ title: 'Dune', tmdbId: 841, year: 1984 }), hit({ title: 'Dune', tmdbId: 438631, year: 2021 })]);
    const r = await lookupTitle(parseTitleRequest('dune', 2021, 'movie'), { library: fakeLibrary([]), tmdb });
    expect(r).toEqual({ status: 'one', candidate: expect.objectContaining({ tmdbId: 438631, year: 2021, movieId: null }), episode: null });
    expect(tmdb.searchTv).not.toHaveBeenCalled();
  });

  it('answers none when no result has the name, and caps several at the limit', async () => {
    expect(await lookupTitle(words('saltburn'), { library: fakeLibrary([]), tmdb: fakeTmdb([hit({ title: 'Saltburn 2', tmdbId: 9 })]) })).toEqual({ status: 'none' });
    const many = Array.from({ length: LOOKUP_MAX_CANDIDATES + 3 }, (_, i) => hit({ title: 'Pilot', tmdbId: i + 1 }));
    const r = await lookupTitle(words('pilot'), { library: fakeLibrary([]), tmdb: fakeTmdb(many) });
    expect(r.status === 'several' ? r.candidates.length : 0).toBe(LOOKUP_MAX_CANDIDATES);
  });

  it('says tmdb_unavailable when nothing stored matches and there is no TMDB', async () => {
    await expect(lookupTitle(words('saltburn'), { library: fakeLibrary([]), tmdb: null })).rejects.toMatchObject({ code: 'tmdb_unavailable' });
  });

  it("takes an episode's movie id as that series and episode, and refuses an unknown one", async () => {
    const library = fakeLibrary([stored({ kind: 'tv', title: 'The Bear', tmdbId: 136315, movieId: 'M-0BEA' })], { 'M-0E23': { kind: 'tv', tmdbId: 136315, episode: { season: 2, episode: 3 } } });
    expect(await lookupTitle(parseTitleRequest('m-0e23', null, null), { library, tmdb: null })).toEqual({
      status: 'one',
      candidate: expect.objectContaining({ title: 'The Bear', kind: 'tv' }),
      episode: { season: 2, episode: 3 },
    });
    await expect(lookupTitle(parseTitleRequest('M-ZZZZ', null, null), { library, tmdb: null })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('takes a title key that is not stored as that TMDB title', async () => {
    const r = await lookupTitle(parseTitleRequest('movie-550', null, null), { library: fakeLibrary([]), tmdb: null });
    expect(r).toEqual({ status: 'one', candidate: { kind: 'movie', tmdbId: 550, title: 'movie-550', originalTitle: 'movie-550', year: null, movieId: null }, episode: null });
  });
});
```

### Step 10: Tool tests with a fake service, and the touched tests
**Files:** `tests/unit/mcp.directStreamTools.test.ts` (new); `tests/unit/chat-status.test.ts`; `tests/unit/mcp.instructions.test.ts`; `tests/unit/chat-prompt.test.ts`
**Code:** `tests/unit/mcp.directStreamTools.test.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { DIRECT_STREAM_TOOL_NAMES } from '../../src/chat/status.js';
import type { SeasonCount, StreamTarget, TitleCandidate, TitleLibrary } from '../../src/directStream/lookup.js';
import { DirectStreamError } from '../../src/directStream/types.js';
import type { AppDeps } from '../../src/deps.js';
import { DIRECT_STREAM_OFF, directStreamToolDeps, registerDirectStreamTools, type DirectStreamToolDeps, type FreshSource } from '../../src/mcp/directStreamTools.js';
import type { TmdbClient, TmdbSearchHit } from '../../src/movies/tmdb.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');
const json = (r: ToolResult): any => JSON.parse(text(r));

const SALTBURN: TitleCandidate = { kind: 'movie', tmdbId: 930564, title: 'Saltburn', originalTitle: 'Saltburn', year: 2023, movieId: 'M-5A1T' };
const THE_BEAR: TitleCandidate = { kind: 'tv', tmdbId: 136315, title: 'The Bear', originalTitle: 'The Bear', year: 2022, movieId: 'M-0BEA' };

const hit = (over: Partial<TmdbSearchHit> & Pick<TmdbSearchHit, 'title' | 'tmdbId'>): TmdbSearchHit => ({
  kind: 'movie', originalTitle: over.title, releaseDate: null, year: null, overview: '', posterPath: null, popularity: 1, ...over,
});

function fakeDeps(over: Partial<DirectStreamToolDeps> & { stored?: TitleCandidate[]; seasons?: SeasonCount[]; tmdbMovies?: TmdbSearchHit[] } = {}) {
  const stored = over.stored ?? [SALTBURN, THE_BEAR];
  const library: TitleLibrary = {
    search: async (_name, kind) => stored.filter((t) => kind === null || t.kind === kind),
    byKey: async (kind, tmdbId) => stored.find((t) => t.kind === kind && t.tmdbId === tmdbId) ?? null,
    byMovieId: async (id) => (id === 'M-0E23' ? { kind: 'tv' as const, tmdbId: 136315, episode: { season: 2, episode: 3 } } : null),
    seasons: async () => over.seasons ?? [{ season: 1, episodes: 8 }, { season: 2, episodes: 10 }],
  };
  const tmdb = { searchMovie: async () => over.tmdbMovies ?? [], searchTv: async () => [], tvDetails: async () => ({ episodes: [] }) } as unknown as TmdbClient;
  const play = vi.fn<(t: StreamTarget) => Promise<unknown>>(async () => ({ session_id: 's1', source: { provider: 'VidFast', subtitles: [{ lang: 'en' }] } }));
  const freshSource = vi.fn<(t: StreamTarget) => Promise<FreshSource | null>>(async () => null);
  const deps: DirectStreamToolDeps = { library, tmdb, play, freshSource, ...over };
  return { deps, play: deps.play as typeof play, freshSource: deps.freshSource as typeof freshSource };
}

async function connect(directStream: DirectStreamToolDeps | null) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerDirectStreamTools(server, { directStream, wallUrl: 'http://localhost:7317' });
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

describe('direct-stream MCP tools', () => {
  it('registers every DIRECT_STREAM_TOOL_NAMES name (phase 8 adds two); find is read-only, play is not', async () => {
    const c = await connect(fakeDeps().deps);
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...DIRECT_STREAM_TOOL_NAMES].sort());
    expect(tools.find((t) => t.name === 'direct_stream_find')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'direct_stream_play')?.annotations?.readOnlyHint).toBe(false);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(200);
    await c.close();
  });

  it('answers direct_stream_off from both tools without the service, and starts nothing', async () => {
    const c = await connect(null);
    for (const [name, args] of [
      ['direct_stream_find', { title: 'saltburn' }],
      ['direct_stream_play', { title: 'saltburn' }],
    ] as const) {
      const r = await c.call(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(DIRECT_STREAM_OFF);
    }
    await c.close();
  });

  it('builds no tool deps while direct streaming or the movie library is off', () => {
    const base = { db: {}, movies: { tmdb: null, host: 'h', repo: {} }, directStream: { play: vi.fn() }, config: { directStream: { enabled: true, freshDays: 7 } } };
    expect(directStreamToolDeps({ ...base, directStream: null } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps({ ...base, movies: null } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps({ ...base, config: { directStream: { enabled: false, freshDays: 7 } } } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps({ ...base, config: {} } as unknown as AppDeps)).toBeNull();
    expect(directStreamToolDeps(base as unknown as AppDeps)).not.toBeNull();
  });

  it('direct_stream_play starts exactly one matching film through the service', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'saltburn' }));
    expect(f.play.mock.calls).toEqual([[{ kind: 'movie', tmdbId: 930564 }]]);
    expect(out).toMatchObject({ started: true, title: { title: 'Saltburn', year: 2023, movie_id: 'M-5A1T', url: 'http://localhost:7317/movies/M-5A1T' }, play: { session_id: 's1' } });
    await c.close();
  });

  it('direct_stream_play starts a named episode, by season and episode or by its movie id', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 2, episode: 3 })).started).toBe(true);
    expect(json(await c.call('direct_stream_play', { title: 'M-0E23' })).started).toBe(true);
    expect(f.play.mock.calls).toEqual([[{ kind: 'tv', tmdbId: 136315, season: 2, episode: 3 }], [{ kind: 'tv', tmdbId: 136315, season: 2, episode: 3 }]]);
    await c.close();
  });

  it('lists the candidates and starts nothing when several titles match', async () => {
    const f = fakeDeps({ stored: [], tmdbMovies: [hit({ title: 'Dune', tmdbId: 841, year: 1984 }), hit({ title: 'Dune', tmdbId: 438631, year: 2021, popularity: 9 })] });
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'dune' }));
    expect(out).toMatchObject({ started: false, skipped_play: 'several_matches' });
    expect(out.candidates.map((x: any) => [x.title, x.year])).toEqual([['Dune', 2021], ['Dune', 1984]]);
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('lists the seasons and starts nothing for a series without an episode', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const out = json(await c.call('direct_stream_play', { title: 'the bear' }));
    expect(out).toMatchObject({ started: false, skipped_play: 'series', title: { title: 'The Bear' }, seasons: [{ season: 1, episodes: 8 }, { season: 2, episodes: 10 }] });
    expect(json(await c.call('direct_stream_play', { title: 'the bear', season: 2 })).skipped_play).toBe('series');
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('answers no_source with each provider outcome when no provider resolves, and nothing starts', async () => {
    const attempts = [
      { provider: 'VidFast', outcome: 'no_stream', took_s: 35, detail: '' },
      { provider: 'Videasy', outcome: 'bot_check', took_s: 4, detail: 'Just a moment' },
      { provider: 'VidLink', outcome: 'skipped_browser_only', took_s: 0, detail: '' },
    ];
    const f = fakeDeps({ play: vi.fn(async () => { throw new DirectStreamError('no_source', 'No provider could stream TMDB movie 930564.', { attempts: attempts as never }); }) });
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn', year: 2023 });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'no_source', started: false, title: { title: 'Saltburn' }, attempts });
    await c.close();
  });

  it('answers a resolve that could not run with its code and reason, and nothing starts', async () => {
    const f = fakeDeps({ play: vi.fn(async () => { throw new DirectStreamError('resolve_failed', 'chrome.exe was not found', { reason: 'no_chrome' }); }) });
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn' });
    expect(r.isError).toBe(true);
    expect(json(r)).toMatchObject({ error: 'resolve_failed', reason: 'no_chrome', started: false, title: { title: 'Saltburn' }, attempts: [] });
    await c.close();
  });

  it('refuses a season or episode for a film', async () => {
    const f = fakeDeps();
    const c = await connect(f.deps);
    const r = await c.call('direct_stream_play', { title: 'saltburn', season: 1, episode: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^invalid_input: Saltburn \(2023\) is a film/);
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });

  it('direct_stream_find says per match whether this host has a fresh verified source, and never plays', async () => {
    const verifiedAt = new Date('2026-11-14T10:00:00Z');
    const f = fakeDeps({
      freshSource: vi.fn(async (t: StreamTarget) => (t.kind === 'movie' ? { provider: 'VidFast', manifestKind: 'hls', bestHeight: 2160, enSubtitle: true, verifiedAt } : null)),
    });
    const c = await connect(f.deps);
    const film = json(await c.call('direct_stream_find', { title: 'saltburn' }));
    expect(film).toMatchObject({ status: 'one', matches: [{ title: 'Saltburn', stream: { verified: true, provider: 'VidFast', best_height: 2160, en_subtitle: true, verified_at: verifiedAt.toISOString() } }] });
    const series = json(await c.call('direct_stream_find', { title: 'the bear' }));
    expect(series.matches[0].stream.verified).toBeNull();
    const episode = json(await c.call('direct_stream_find', { title: 'M-0E23' }));
    expect(episode.matches[0]).toMatchObject({ episode: { season: 2, episode: 3 }, stream: { verified: false } });
    expect(json(await c.call('direct_stream_find', { title: 'nothing like it' }))).toMatchObject({ status: 'none', matches: [] });
    expect(f.play).not.toHaveBeenCalled();
    await c.close();
  });
});
```
`tests/unit/chat-status.test.ts`:
- Add `DIRECT_STREAM_TOOL_NAMES,` to the import list (lines 3-11).
- In the first `it` (lines 17-43), rename it to `'is exactly the 19 notes tools, the 5 session tools, the 3 adversary tools, the 6 movie tools, the 2 streaming tools, the direct-streaming tools, the 22 connector tools, WebSearch and WebFetch'`. Replace line 25 with:
```ts
    expect(DIRECT_STREAM_TOOL_NAMES.slice(0, 2)).toEqual(['direct_stream_find', 'direct_stream_play']);
    expect(tools).toHaveLength(19 + 5 + 3 + 6 + 2 + DIRECT_STREAM_TOOL_NAMES.length + 22 + 2);
```
  and after line 38 add:
```ts
    for (const name of DIRECT_STREAM_TOOL_NAMES) expect(tools).toContain(n(name));
```
- In `'captions the movie tools'`, after line 60 add:
```ts
    expect(captionForToolUse(n('direct_stream_find'), { title: 'saltburn' })).toBe('looking for a stream');
    expect(captionForToolUse(n('direct_stream_play'), { title: 'saltburn' })).toBe('starting a stream');
```
`tests/unit/mcp.instructions.test.ts`: replace line 288 with:
```ts
    expect(order.indexOf('Direct streaming')).toBe(order.indexOf('Streaming') + 1);
    expect(order.indexOf('Adversary')).toBe(order.indexOf('Direct streaming') + 1);
```
and append after the `buildInstructions: Streaming` describe (after line 304):
```ts

describe('buildInstructions: Direct streaming', () => {
  it('has one Direct streaming paragraph naming both tools, when a stream may start, and what starts nothing', () => {
    const text = buildInstructions('Asia/Jakarta', 'http://localhost:4321');
    const paragraphs = text.split('\n\n').filter((p) => p.startsWith('Direct streaming.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    for (const word of ['direct_stream_find', 'direct_stream_play', '/direct-stream saltburn', 'movies_continue unless the user says stream', 'a recommendation is not a request', 'The Lord of the Rings: The Fellowship of the Ring, 2001', 'no_source', 'attempts', 'F11', 'direct_stream_off']) {
      expect(p).toContain(word);
    }
  });
});
```
`tests/unit/chat-prompt.test.ts`: append inside the describe that holds the streaming test, after line 199:
```ts

  it('streams directly only when asked, resolves "the first one" to a title, and looks up with direct_stream_find otherwise', () => {
    expect(prompt).toMatch(/A message that starts with \/direct-stream followed by a title/);
    expect(prompt).toMatch(/call direct_stream_play with the exact title, the year when you know it, and for a series the season and episode/);
    expect(prompt).toMatch(/"this is a LOTR night\. let's \/direct-stream the first one" is The Lord of the Rings: The Fellowship of the Ring \(2001\)/);
    expect(prompt).toMatch(/When it answers no_source, say no source could stream it, with each provider's outcome from attempts/);
    expect(prompt).toMatch(/is a lookup, not a request to play: call direct_stream_find/);
    expect(prompt).toMatch(/A film that is in the library is played with movies_continue in VLC unless the owner says stream or \/direct-stream/);
    expect(prompt).toMatch(/Do not start a stream because you recommended a film; only when asked/);
  });
```

### Step 11: Integration test for the stored-title library
**File:** `tests/integration/directStream.lookup.int.test.ts` (new)
**Change:** Prove `dbTitleLibrary` against Postgres, including the parts no fake can prove:
- the loose pre-filter (`search_tsv` and `ilike`) finds by original title too;
- the title's own movie id comes back through the join;
- an episode's movie id names its season and episode (the `movie_ids` triggers write it);
- seasons are counted from `movie_episodes`.
The test writes only its own rows.
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { dbTitleLibrary, lookupTitle, parseTitleRequest, type TitleLibrary } from '../../src/directStream/lookup.js';
import { clearMovies } from './helpers/moviesMcpSeed.js';
import { closeTestDb, openTestDb } from './setup.js';

let db: Db;
let library: TitleLibrary;

beforeAll(() => {
  db = openTestDb();
  library = dbTitleLibrary(db);
});

afterAll(async () => {
  await clearMovies(db);
  await closeTestDb(db);
});

beforeEach(async () => {
  await clearMovies(db);
  await db.execute(sql`
    insert into movie_titles (id, kind, tmdb_id, title, original_title, year, overview, genres, metadata_fetched_at, created_at, updated_at)
    values ('movie-990001', 'movie', 990001, 'The Untouchables Lookup', 'Les Intouchables Lookup', 2011, '', '[]'::jsonb, now(), now(), now()),
           ('tv-990002', 'tv', 990002, 'Lookup Series', 'Lookup Series', 2024, '', '[]'::jsonb, now(), now(), now())`);
  await db.execute(sql`
    insert into movie_episodes (title_id, season, episode, name)
    values ('tv-990002', 1, 1, 'One'), ('tv-990002', 1, 2, 'Two'), ('tv-990002', 2, 1, 'Three'), ('tv-990002', 0, 1, 'Special')`);
});

describe('dbTitleLibrary', () => {
  it('finds a stored title by its original name, with its movie id', async () => {
    const r = await lookupTitle(parseTitleRequest('les intouchables lookup', null, null), { library, tmdb: null });
    expect(r.status).toBe('one');
    if (r.status !== 'one') return;
    expect(r.candidate).toMatchObject({ kind: 'movie', tmdbId: 990001, year: 2011 });
    expect(r.candidate.movieId).toMatch(/^M-[0-9A-Z]{4}$/);
  });

  it("takes an episode's movie id as its series, season and episode", async () => {
    const rows = await db.execute(sql`select id from movie_ids where title_id = 'tv-990002' and season = 2 and episode = 1`);
    const id = (rows.rows[0] as { id: string }).id;
    const r = await lookupTitle(parseTitleRequest(id, null, null), { library, tmdb: null });
    expect(r).toMatchObject({ status: 'one', candidate: { kind: 'tv', tmdbId: 990002, title: 'Lookup Series' }, episode: { season: 2, episode: 1 } });
  });

  it('counts episodes per season from season 1 up', async () => {
    expect(await library.seasons('tv', 990002)).toEqual([{ season: 1, episodes: 2 }, { season: 2, episodes: 1 }]);
    expect(await library.seasons('movie', 990001)).toEqual([]);
  });

  it('keeps kind apart', async () => {
    expect(await library.search('lookup series', 'movie')).toEqual([]);
    expect((await library.search('lookup series', 'tv')).map((t) => t.tmdbId)).toEqual([990002]);
  });
});
```
**Impact:** runs only under `npm run test:int`.

### Step 12: Reference docs, guide, feature map
**Files:** `docs/guide/reference/mcp-tools.md` (generated); `docs/guide/streaming.md`; `.claude/skills/verify-notesd/features/direct-streaming.md`
**Change:**
1. Run `npm run docs:gen`. Never hand-edit `mcp-tools.md`.
2. `docs/guide/streaming.md`:
   a. In the table at the top (lines 6-11), add after the lk21 row:
```markdown
| A cloud source, no site (streaming) | `/direct-stream <title> [year]` | Finds the title, resolves a stream, plays it full screen in our own player | Yes, through `direct_stream_play` |
```
   b. Under `## What you can ask`, after the `/idlix` and `/lk21` subsection (it ends before `### /create-streaming-skill`, line 146 today), insert:
````markdown
### `/direct-stream`: straight from a cloud source

```text
/direct-stream saltburn
/direct-stream dune 2021
this is a LOTR night. let's /direct-stream the first one
/direct-stream the bear season 2 episode 3
/direct-stream M-23T4
can I stream saltburn directly?
```

| You type | What happens |
| --- | --- |
| `/direct-stream saltburn` | One film matches: it is resolved and plays full screen in the streaming Chrome, English subtitle on when a source has one |
| `/direct-stream dune 2021` | The 2021 film. Without the year, Dune matches three titles: the answer lists them and starts nothing |
| `this is a LOTR night. let's /direct-stream the first one` | Claude names the film first (The Lord of the Rings: The Fellowship of the Ring, 2001), then streams it |
| `/direct-stream the bear` | A series: its seasons, and a question about which episode. Nothing starts |
| `/direct-stream the bear season 2 episode 3` | That episode plays |
| A film no source can stream | `no_source`, with what each provider did. Nothing starts |
| `can I stream saltburn directly?` | A lookup: the match, and whether this laptop has a recently verified source |

- **`/direct-stream` streams even a film you have.** Without it, a library film plays in VLC.
- **A question is a lookup**, and **a recommendation is not a request**.
- **It continues where the last stream stopped.**
````
   c. Under `## Direct streaming` (phase 3's section), after the subsections phases 3 and 4 placed there (phase 3's "The resolver", "Providers and their health", "Sessions and the pass-through", "Direct streaming answers"; phase 4's "The player") and before phase 8's, add:
```markdown
### `/direct-stream`

`/direct-stream <title>` in Claude Code (the `claude/skills/direct-stream` skill) and the same
words in the chat bar end in the same two MCP tools:

- `direct_stream_find` looks the title up and says, per match, whether this laptop has a source
  verified inside the freshness window. It resolves nothing and opens nothing.
- `direct_stream_play` looks the title up, then hands one film or one episode to the daemon's
  stream service: resolve, then the player page full screen in the streaming Chrome, from the
  last stream position.

The lookup (`src/directStream/lookup.ts`) reads titles already stored first (the library, and
titles streamed before), then TMDB's film and series search. A result matches when its English
or original name is the asked title and its year is the asked year when one was given: the rule
of `claude/streaming/match.mjs`, ported, and a test keeps the two equal. A movie id (`M-23T4`,
of a title or one episode) or a title key (`movie-550`) is taken as is.

Nothing starts when several titles match (the candidates come back with their years), when a
series is named without an episode (its seasons come back), or when no provider resolves: then
the answer is `no_source` with each provider's outcome (`no_stream`, `bot_check`, `error`,
`skipped_browser_only`). With direct streaming off, both tools answer `direct_stream_off`.
```
   d. In "Where the code is", add rows:
```markdown
| `src/directStream/lookup.ts`, `match.ts` | Words, a movie id or a title key to a TMDB title; the exact-title rule |
| `src/mcp/directStreamTools.ts` | `direct_stream_find`, `direct_stream_play` |
| `claude/skills/direct-stream/` | The `/direct-stream` skill |
```
3. `docs/guide/chat.md` (reconciler; phase 8 then extends the first two rows):
   a. Caption table, after the `| searching the streaming sites, starting a film | using the streaming tools |` row (line 64):
```markdown
| looking for a stream, starting a stream | using the direct-streaming tools |
```
   b. Allow-list table, after the `| Streaming sites | ... |` row (line 162):
```markdown
| Direct streaming | `direct_stream_find`, `direct_stream_play` | `direct_stream_play` opens the player page full screen in the streaming Chrome |
```
   c. "How it is told to behave", after the idlix/lk21 bullet (ends line 195, `[streaming.md](streaming.md).`):
```markdown
- Asked to stream a film or an episode directly ("/direct-stream saltburn", "stream it"), it calls
  `direct_stream_play`, which plays it full screen in notesd's own player page in the streaming
  Chrome. A question ("can I stream it directly?") is `direct_stream_find`, which starts nothing.
  See [streaming.md](streaming.md#direct-stream).
```
4. `.claude/skills/verify-notesd/features/direct-streaming.md` (phase 3 creates it): append:
```markdown
## /direct-stream (find and play)
- `direct_stream_find`, `direct_stream_play` (MCP, chat bar, `/direct-stream` skill): one film
  starts through the service, several matches and a series without an episode start nothing,
  `no_source` carries every provider's outcome, off answers `direct_stream_off`. Proven with a
  fake service by `npx vitest run tests/unit/mcp.directStreamTools.test.ts tests/unit/directStream`;
  the stored-title lookup by `npm run test:int -- tests/integration/directStream.lookup.int.test.ts`;
  the chat allow list, captions and prompt by `tests/unit/chat-status.test.ts tests/unit/chat-prompt.test.ts tests/unit/mcp.instructions.test.ts`.
- Throwaway daemon: both tools answer `direct_stream_off` (`$V mcp RUN direct_stream_play '{"title":"saltburn"}'`).
  That is the expected proof there; never wire the real resolver into a throwaway instance.
- Live: `/direct-stream saltburn` in Claude Code against the installed daemon. It resolves
  through the streaming Chrome and plays full screen with sound: the owner's to run.
```
**Impact:** `npm run docs:check` passes again.

## Principles applied

- Laziness protocol: the tools reuse `movieErrorResult` (codes become `<code>: <message>`, TMDB errors become `tmdb_error`), `resolveMovieId`, `titleId` and `jsonResult`, and the skill calls the MCP tools instead of shipping its own script. No second title resolver is written beside `movieTools.resolveTitleId`, because that one answers `ambiguous` for words that the exact rule must separate by year.
- Encode lessons in structure: the TypeScript port of `match.mjs`'s rule gets a parity test that runs both over one table of cases (Step 9). A change to either file that is not made in the other then fails `npm test`, where a comment saying "keep in sync" would not.
- Make illegal states unrepresentable: `StreamTarget` is a union in which a series always carries both season and episode, so the "series without an episode" case can only be the `series` answer and can never reach `play`. `LookupResult` is a union with no "one candidate plus a list" state.
- Boundary discipline: the tool reads its input once (zod, then `parseTitleRequest` decides id or words), and the lookup trusts the typed request. The phase-3/phase-5 shapes are read in exactly two places, `directStreamToolDeps` and `playFailure`, so a contract change edits one function.
- Test behavior, not implementation: the tool tests drive a real MCP client and assert on the answers and on what the injected service was asked to play. The lookup's database half is proven against Postgres, not a mocked query builder.

## Verification

**Build:** `npm run typecheck && npm run build`
**Tests:** `npm test` (includes `tests/unit/docs/reference.test.ts`), then `npm run test:int -- tests/integration/directStream.lookup.int.test.ts`
**Proof:** the tools answer through a real MCP client with a fake `DirectStreamService` in unit tests, the stored-title lookup is proven against Postgres, and a throwaway daemon shows both tools registered and answering `direct_stream_off`. A live full-screen play with sound is the owner's to run (see Exit criteria), never an automated journey.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`)
- Feature-map entries: `features/direct-streaming.md`, `features/streaming.md` (neighbor), `features/chat.md` (allow list)
- Journeys:
  - **J1** · traces R3.1 — `npx vitest run tests/unit/mcp.directStreamTools.test.ts -t "starts exactly one matching film"` and `npx vitest run tests/unit/mcp.directStreamTools.test.ts -t "starts a named episode"` → passes when both pass. The fake service's `play` was called exactly once with `{ kind: 'movie', tmdbId: 930564 }`, and the answer is `started: true` with `title.movie_id` `M-5A1T`. The episode test shows `{ kind: 'tv', tmdbId: 136315, season: 2, episode: 3 }` reached `play` both by season/episode and by the episode's movie id.
  - **J2** · traces R3.1, R3.2 — `npm run test:int -- tests/integration/directStream.lookup.int.test.ts` → passes when all four tests pass against Postgres. Words find a stored title by its original name with a trigger-made `M-xxxx` id; an episode's movie id resolves to season 2, episode 1; seasons come back as `[{1,2},{2,1}]` with the specials left out.
  - **J3** · traces R3.2 — `npx vitest run tests/unit/mcp.directStreamTools.test.ts -t "several titles match"`, then `-t "series without an episode"`, then `npx vitest run tests/unit/directStream` → passes when all pass. `direct_stream_play {title:"dune"}` answers `skipped_play: "several_matches"` with candidates `[["Dune",2021],["Dune",1984]]`. `{title:"the bear"}` (and `{title:"the bear", season:2}`) answers `skipped_play: "series"` with both seasons. The fake `play` has 0 calls, and the `match.mjs` parity cases all agree.
  - **J4** · traces R3.3 — `npx vitest run tests/unit/mcp.directStreamTools.test.ts -t "no_source"` → passes when the result has `isError: true` and its JSON is `{ error: "no_source", started: false, title: { title: "Saltburn" }, attempts: [...] }` with all three attempts (`no_stream`, `bot_check`, `skipped_browser_only`) unchanged.
  - **J5** · traces R3.1, R3.2 — `$V up`, then `$V mcp RUN --list | grep -c direct_stream_` → passes when it prints `2` (the throwaway daemon built from this checkout registers both tools with their schemas). Then `$V down RUN`.
- Neighbor check (R2.6, tools half; the criterion is phase 3's): `$V up`, then `$V mcp RUN direct_stream_play '{"title":"saltburn"}'` and `$V mcp RUN direct_stream_find '{"title":"saltburn"}'`, then `$V mcp RUN streaming_play '{"site":"lk21","title":"saltburn"}'`, then `$V down RUN` → passes when:
  - both direct tools answer `isError` with text starting `direct_stream_off:`;
  - `streaming_play` still answers `streaming_off:` exactly as before;
  - the evidence log shows no Chrome or PowerShell process started.
  
  Also `npx vitest run tests/unit/mcp.streamingTools.test.ts tests/unit/chat-status.test.ts tests/unit/mcp.instructions.test.ts tests/unit/chat-prompt.test.ts` passes, so `streaming_find` and `streaming_play`, their prompt text and the allow list are unchanged except for the two added names.
- Cost: none. No LLM turns, no TMDB, no provider, no Chrome. Do not drive `/api/chat` for this phase: the prompt is proven by `tests/unit/chat-prompt.test.ts`.

**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the integration file pass. J1 to J5 and the neighbor check pass. `scripts/install.sh` links `~/.claude/skills/direct-stream`. The owner's live check, run only when the owner asks for it because it plays full screen with sound: after `scripts/install.sh` restarts the daemon, type `/direct-stream saltburn` in Claude Code. The streaming Chrome comes to the front with the player page full screen, playing.

## Handoffs

- **Phase 3 (settled by the reconciler):**
  - Routes keep phase 3's `DIRECT_STREAM_OFF` object (`src/http/directStreamApi.ts`); the tools keep this phase's `DIRECT_STREAM_OFF` string. Both say `direct_stream_off` first.
  - `play` throws `DirectStreamError` (`code` `no_source` with `attempts`; `resolve_failed` / `open_failed` with `reason`); `playFailure` (Step 4) reads it.
  - `verify.sh` pins `NOTESD_DIRECT_STREAM=off` on every throwaway run except `--direct-stream`, so `$V up` here shows the off answer.
  - R2.6 itself (routes and tools) is phase 3's criterion. This phase proves only the tools half, as its neighbor check.
- **Phase 5 (settled by the reconciler):** the fresh-verified read is phase 5's `streamSourcesOfTitle` + `isFreshStreamSource` + `streamFreshSince` (Step 4); `play` without `resumeS` resumes through phase 5's `resumeS` hook; `scope: 'all'` and the `movies_get` / `movies_history` descriptions are Step 5b.
- **Phase 8:**
  - Appends `direct_stream_sources` and `direct_stream_update_source` to `DIRECT_STREAM_TOOL_NAMES` and registers them from the end of `registerDirectStreamTools`; extends `DirectStreamToolDeps` with `providers()` and `updateSource(site)` bound in `directStreamToolDeps`, and adds those two to this phase's test `fakeDeps`.
  - Adds their captions in `captionForToolUse`, the `CLAUDE_CODE_ONLY_TOOL_NAMES` filter in `allowedChatTools`, and extends this phase's `chat.md` caption and allow-list rows.
  - Appends `update-cloud-source` to `SKILL_NAMES` in `scripts/install.sh:39`, after `direct-stream`, quoting the line as this phase leaves it.
  - This phase's tool test compares the registered tools with the whole `DIRECT_STREAM_TOOL_NAMES`, so it keeps passing with four; the `chat-status` count test's direct-stream term is edited by phase 8 (the chat bar gets three of the four).
- **Phase 9:** the Stream grid's Play goes through `POST /api/stream/play`, not these tools. The title page could link `/direct-stream` answers by `movie_id` once stream-only titles open on `/movies/:id`. Confirm that a stream-only title's `url` (`/movies/<movie id>`) opens there.
- **Not done here (scope):** `escapeLike` now exists twice (`src/movies/read.ts:341` and `src/directStream/lookup.ts`). Exporting it from `read.ts` would touch a phase 5 file, so it is left for a cleanup after the set lands. `isSameTitle` keeps `match.mjs`'s quirk: a non-Latin query normalizes to `''` and equals any result name that also normalizes to `''`. Fixing it belongs in both files at once, after this set.

## Rollback

Revert this phase's commits. Nothing else is involved:
- no migration;
- the tools, the prompt and instruction text, the skill and its `SKILL_NAMES` entry go together.

After the revert, run `npm run docs:gen` (or keep the reverted generated file) and `scripts/install.sh`, which removes nothing but stops linking `direct-stream`. Delete the stale `~/.claude/skills/direct-stream` symlink by hand. `NOTESD_DIRECT_STREAM=off` makes both tools answer `direct_stream_off` without a revert.
