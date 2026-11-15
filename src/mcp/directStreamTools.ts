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
