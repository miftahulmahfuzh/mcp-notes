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
