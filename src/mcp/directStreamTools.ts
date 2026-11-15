import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { DIRECT_STREAM_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import { pickEpisode, withListedEpisodes, type EpisodeChoice, type EpisodeProgress } from '../directStream/episodePick.js';
import {
  dbTitleLibrary,
  LookupError,
  lookupTitle,
  parseTitleRequest,
  sameTitle,
  targetKey,
  type EpisodePick,
  type LookupTmdb,
  type SeasonCount,
  type StreamTarget,
  type TitleCandidate,
  type TitleLibrary,
} from '../directStream/lookup.js';
import { normalizeName } from '../directStream/match.js';
import type { ProviderView } from '../directStream/repo.js';
import { DirectStreamError } from '../directStream/types.js';
import type { UpdateSourceAnswer } from '../directStream/updateSource.js';
import { getTitle } from '../movies/read.js';
import { isFreshStreamSource, streamFreshSince } from '../movies/repo.js';
import { MovieStreams } from '../movies/streams.js';
import { TmdbError, type TmdbClient } from '../movies/tmdb.js';
import { titleId } from '../movies/types.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { movieErrorResult } from './movieTools.js';
import { jsonResult, type ToolDeps } from './tools.js';

const [FIND, PLAY] = DIRECT_STREAM_TOOL_NAMES;
const [, , SOURCES, UPDATE_SOURCE] = DIRECT_STREAM_TOOL_NAMES;

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
  tmdb: (TmdbClient & LookupTmdb) | null;
  /** A stored series' episodes with their watch state (files and streams) and last play; [] when the series is not stored. */
  progress(tmdbId: number): Promise<EpisodeProgress[]>;
  /** Stores `name` (normalized) as one more name of the title, storing the title first when it is new. False when nothing was added. */
  rememberAlias(candidate: TitleCandidate, name: string): Promise<boolean>;
  /** Default: the clock. */
  now?: () => Date;
  /** DirectStreamService.play: resolve, then open the player page full screen in the streaming Chrome, resuming where the last stream stopped. */
  play(target: StreamTarget): Promise<unknown>;
  /** This host's source verified inside the freshness window, or null. */
  freshSource(target: StreamTarget): Promise<FreshSource | null>;
  /** DirectStreamService.providers(): the registry with this host's health (direct_stream_sources). */
  providers(): Promise<ProviderView[]>;
  /** DirectStreamService.updateSource: read a site's templates, add and probe the new providers (/update-cloud-source). */
  updateSource(site: string): Promise<UpdateSourceAnswer>;
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
    progress: async (tmdbId) => {
      const detail = await getTitle(deps.db, titleId('tv', tmdbId), { host: movies.host, imageBase: deps.config.movies.tmdb.imageBase });
      return (detail?.seasons ?? []).flatMap((s) =>
        s.episodes.map((e) => ({ season: e.season, episode: e.episode, state: e.state, lastPlayedAt: e.last_played_at, airDate: e.air_date })),
      );
    },
    rememberAlias: async (candidate, name) => {
      const id = await new MovieStreams(movies).ensureTitle({ kind: candidate.kind, tmdbId: candidate.tmdbId });
      return id === null ? false : movies.repo.addTitleAlias(id, normalizeName(name));
    },
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
    providers: () => service.providers(),
    updateSource: (site) => service.updateSource(site),
  };
}

const FIND_DESCRIPTION =
  "Look a film or series up for direct streaming: a stream played in the owner's own player page straight from a cloud source, with no site and no adverts. " +
  'Pass title (the words without the year; or a movie id like M-23T4, of a title or of one episode; or a title key like movie-550 or tv-1399), year when known, and kind (movie or tv) when the owner said which. ' +
  "Titles already stored (the library, and titles streamed before) are matched first, then TMDB. A title matches when its English or original name, a name the owner gave it before, or one of TMDB's alternative titles is the asked title, and its year is the asked year when one was given. " +
  'With status none, did_you_mean lists titles close to the words (a site may call a title by another name than TMDB does): show them and ask; none of them is a match. ' +
  'Returns { status: one | several | none, matches: [{ title, original_title, year, kind, tmdb_id, movie_id, url, tmdb_url, episode, stream }] }. stream says whether this machine has a source verified recently: ' +
  'verified true with provider, manifest_kind, best_height and en_subtitle; verified false when none is known yet (it may still stream: only playing tries); verified null for a series named without an episode, whose episodes are checked when played. ' +
  'This tool only looks: nothing is resolved and nothing opens. To start one, call direct_stream_play.';

const PLAY_DESCRIPTION =
  'Stream one film, or one episode of a series, directly: the daemon finds a cloud source (providers with an English subtitle first), then opens its own player page full screen in the streaming Chrome window on the Windows side, ' +
  'resuming where the last stream of it stopped. It takes 5 to 40 seconds; call it once and wait. ' +
  'Call it only when the owner asks to stream (/direct-stream <title>, "stream it", "let\'s direct-stream the first one"). A film in the library plays in VLC with movies_continue unless the owner says stream; a recommendation is not a request; a question is direct_stream_find. ' +
  'Pass title (words without the year, a movie id, or a title key) with year when known. For a series pass season and episode only when the owner named them (an episode\'s movie id names both): ' +
  'without them the daemon picks the episode from what was watched, on file or streamed (picked: first, nothing played yet; resume, the episode played last is unfinished and carries on where it stopped; next, the episode after the last finished one). ' +
  'started true: the player page is open, season and episode say which episode, and play carries the session and the source (provider, quality, subtitles). ' +
  'started false with skipped_play says why nothing started: several_matches (list candidates with their years and ask which, then call again with that one\'s movie_id, or title and year), ' +
  'caught_up (every episode after the last one played is finished or there is none: say so, with last and seasons), not_aired (the next episode airs on air_date), ' +
  'or no_match: did_you_mean lists titles close to the words, none of them the asked name; show them with their years and ask which. When the owner picks one, call again with its title_key (or movie_id) and asked_as set to the name the owner first used, ' +
  'so that name finds the title from then on. Never pass asked_as for a name the owner did not use. ' +
  'The error no_source means no provider could stream it: attempts lists each provider with its outcome (resolved, no_stream, bot_check, error, dubbed, skipped_browser_only, skipped_no_template), and nothing started; offer /idlix or /lk21. ' +
  'A stream always plays in the title\'s original language: a provider whose stream is dubbed into another language is skipped (dubbed), and play.session.audio says what was heard (languages; original true when the stream names the original language, null when it names none). ' +
  'The errors resolve_failed and open_failed mean the streaming Chrome could not be used: reason says why (no_chrome, chrome_not_reachable, ...). ' +
  'Tell the owner it plays in the streaming Chrome window and that F11 leaves full screen. Works only on the machine with Windows Chrome.';

const SOURCES_DESCRIPTION =
  'List the direct-streaming providers in the registry both machines share: each one\'s name, film and episode address templates ' +
  '({id} is the TMDB id), whether it plays only in its own page (browser_only), whether it is known to offer an English subtitle, ' +
  'the aggregator site it was added from (origin_site, null for the checked-in seed) and when, and this machine\'s health for it ' +
  '(last success and failure, consecutive failures, median seconds to a stream, best quality). Health is per machine: the other ' +
  'laptop measures its own. Read-only: nothing opens and nothing is probed.';

const UPDATE_SOURCE_DESCRIPTION =
  'Add the providers an aggregator streaming site uses that the registry lacks, and probe each new one. Use it for ' +
  '"/update-cloud-source <site url>" in Claude Code. It reads the site\'s page and scripts with plain requests (no browser) for ' +
  'provider address templates, keeps the ones whose host and path the registry does not have (a name already taken by another host ' +
  'is stored as "<name> (<host>)"; existing providers are never changed), inserts them, then resolves each known title (Fight Club ' +
  'and the others) with only that provider, recording its health on this machine. Probing opens tabs in the streaming Chrome out ' +
  'of sight, plays nothing and makes no sound; a provider that finds nothing takes about 35 seconds per title, so the call can take ' +
  'minutes. Answers ok: true with added (per provider: resolves, and per title the outcome, seconds, manifest kind, best height, ' +
  'English subtitle), known (found but already in the registry) and skipped; or ok: false with error bot_check, no_templates, ' +
  'unreachable, bad_url, reader_failed or busy, and the registry unchanged. Reading the frames a site\'s server buttons load is not built.';

const siteField = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), 'an http or https address');

/**
 * The registry tools (/update-cloud-source): list the providers with this host's health, and
 * add a site's new providers. Without deps.directStream both answer direct_stream_off, as phase 7's do.
 */
function registerDirectStreamSourceTools(server: McpServer, deps: Pick<ToolDeps, 'directStream'>): void {
  const off = (): CallToolResult => ({ isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] });

  server.registerTool(
    SOURCES,
    {
      title: 'List the direct-streaming providers',
      description: SOURCES_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => {
        const providers = await d.providers();
        return ok({ count: providers.length, providers });
      });
    },
  );

  server.registerTool(
    UPDATE_SOURCE,
    {
      title: 'Add an aggregator site\'s new stream providers',
      description: UPDATE_SOURCE_DESCRIPTION,
      inputSchema: {
        site: siteField.describe('The aggregator site\'s address, such as https://ww6-fmovies.com/ (its home page or a film page).'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ site }) => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => ok(await d.updateSource(site)));
    },
  );
}

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
    title_key: titleId(c.kind, c.tmdbId),
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

/** A series' episodes as TMDB lists them now; null when TMDB cannot be asked. */
async function listedEpisodes(c: TitleCandidate, d: DirectStreamToolDeps): Promise<{ season: number; episode: number; airDate: string | null }[] | null> {
  if (d.tmdb === null) return null;
  try {
    return (await d.tmdb.tvDetails(c.tmdbId)).episodes;
  } catch (err) {
    if (err instanceof TmdbError) return null;
    throw err;
  }
}

/**
 * The episode a series named without one streams (episodePick.ts). The stored episodes decide;
 * TMDB's list is read when the series is not stored, or when the stored list has no episode left
 * (a series still airing has newer ones).
 */
async function chooseEpisode(c: TitleCandidate, d: DirectStreamToolDeps): Promise<EpisodeChoice> {
  const today = (d.now?.() ?? new Date()).toISOString().slice(0, 10);
  const stored = await d.progress(c.tmdbId);
  const choice = pickEpisode(stored, today);
  if (stored.length > 0 && choice.pick !== 'caught_up') return choice;
  const listed = await listedEpisodes(c, d);
  return listed === null ? choice : pickEpisode(withListedEpisodes(stored, listed), today);
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
          ...(result.status === 'none' ? { did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)) } : {}),
          next:
            result.status === 'none'
              ? result.nearMisses.length > 0
                ? 'No title has that name (or that name and year). Say so, show did_you_mean with years and kinds, and ask whether one of them is meant.'
                : 'No title has that name (or that name and year). Say so.'
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
        asked_as: titleField
          .optional()
          .describe('Only after the owner picked a title from did_you_mean: the name they first used for it, word for word. It is remembered as another name of this title.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, year, kind, season, episode, asked_as }) => {
      const d = deps.directStream;
      if (!d) return off();
      return respond(async () => {
        const result = await lookupTitle(parseTitleRequest(title, year ?? null, kind ?? null), d);
        if (result.status === 'none') {
          return ok({
            started: false,
            skipped_play: 'no_match',
            query: { title, year: year ?? null },
            did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)),
            next:
              result.nearMisses.length > 0
                ? 'Nothing started: no title has that name (or that name and year). Show did_you_mean with years and kinds and ask whether one of them is meant. When the owner picks one, call again with its title_key and asked_as set to the name they used.'
                : 'No title has that name (or that name and year). Say so; nothing started.',
          });
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
        // A name the owner confirmed for this title: remembered whether or not a source resolves.
        const remembered =
          asked_as !== undefined && normalizeName(asked_as) !== '' && !sameTitle(c, { name: asked_as, year: null }) ? await d.rememberAlias(c, asked_as) : false;
        let target = targetFor(c, result.episode, season, episode);
        let choice: EpisodeChoice | null = null;
        if (target === null) {
          if (season !== undefined || episode !== undefined) {
            throw new LookupError('invalid_input', `${label(c)} is a series: pass both season and episode, or neither to carry on from the last episode watched.`);
          }
          choice = await chooseEpisode(c, d);
          if (choice.pick === 'caught_up') {
            return ok({
              started: false,
              skipped_play: 'caught_up',
              title: candidateView(c, wall),
              last: choice.last,
              seasons: await seasonsOf(c, d),
              next: 'Nothing started: the last episode played is finished and no episode after it is left. Say so with last; to watch one again the owner names a season and an episode.',
            });
          }
          if (choice.pick === 'not_aired') {
            return ok({
              started: false,
              skipped_play: 'not_aired',
              title: candidateView(c, wall),
              season: choice.season,
              episode: choice.episode,
              air_date: choice.airDate,
              next: 'Nothing started: the next episode has not aired yet. Say which episode and its air date.',
            });
          }
          target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
        }
        const picked = {
          ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : { season: null, episode: null }),
          ...(choice === null ? {} : { picked: choice.pick }),
          ...(remembered ? { remembered_as: asked_as } : {}),
        };
        try {
          const play = await d.play(target);
          return ok({
            started: true,
            title: candidateView(c, wall),
            ...picked,
            play,
            next:
              choice === null
                ? 'Say it is playing full screen in the streaming Chrome window, and that F11 leaves full screen.'
                : 'Say which season and episode is playing and why (picked: first, resume from where it stopped, or next), that it plays full screen in the streaming Chrome window, and that F11 leaves full screen.',
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

  registerDirectStreamSourceTools(server, deps);
}
