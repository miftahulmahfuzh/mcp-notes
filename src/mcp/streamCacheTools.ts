import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { STREAM_CACHE_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import { CACHE_ID_PATTERN, CacheError, type StreamCacheView } from '../directStream/cache/types.js';
import { LookupError, lookupTitle, parseTitleRequest, type StreamTarget } from '../directStream/lookup.js';
import { candidateView, chooseAbsolute, chooseEpisode, DIRECT_STREAM_OFF, directStreamToolDeps, label, targetFor, type DirectStreamToolDeps } from './directStreamTools.js';
import { DEFAULT_WALL_URL } from './instructions.js';
import { movieErrorResult } from './movieTools.js';
import { jsonResult, type ToolDeps } from './tools.js';

const [CACHE] = STREAM_CACHE_TOOL_NAMES;

/** What direct_stream_cache calls on the daemon's StreamCache (src/directStream/cache/service.ts); tests pass a fake. */
export interface StreamCacheApi {
  readonly host: string;
  request(ref: StreamTarget, options: { maxHeight: number | null }): Promise<{ cache: StreamCacheView; started: boolean }>;
  list(): Promise<StreamCacheView[]>;
  get(id: string): Promise<StreamCacheView | null>;
  forRef(ref: StreamTarget): Promise<StreamCacheView[]>;
  remove(id: string): Promise<void>;
}

export interface StreamCacheToolDeps {
  /** The direct-stream tools' lookup (titles, TMDB, the episode picks). */
  lookup: DirectStreamToolDeps;
  cache: StreamCacheApi;
}

/** The tool deps of a running daemon, or null when direct streaming (or the cache) is off. */
export function streamCacheToolDeps(deps: AppDeps): StreamCacheToolDeps | null {
  const lookup = directStreamToolDeps(deps);
  const cache = deps.streamCache ?? null;
  return lookup === null || cache === null ? null : { lookup, cache };
}

const DESCRIPTION =
  "Download a film, or one episode of a series, to this machine's disk so it can play from the local copy instead of the stream host (a slow or far host, a bad connection). " +
  'action start resolves a cloud source the way direct_stream_play does (out of sight, nothing plays, 5 to 40 seconds), then downloads one rendition with its segments, keys and the English subtitle in the background: the call answers at once with the cache (state downloading, progress, segments_done of segments_total) and the download goes on after it. ' +
  'Pass title (words without the year, a movie id, or a title key) with year and kind when known; for a series season and episode, or absolute_episode, or neither to take the episode direct_stream_play would (picked). max_height caches the tallest rendition not above it (720 for a smaller copy); without it the tallest. ' +
  'action status shows that title\'s caches (or the one of id) on both machines; list shows every cache; clear stops this machine\'s download of it and deletes its files. ' +
  'A cache belongs to the machine that made it: one made on the other laptop has available false and cannot be played or cleared here (not_on_this_machine). ' +
  'Answers carry cache { id, state downloading | ready | failed, progress, segments_done, segments_total, bytes, height, provider, subtitle, error }. error cache_unsupported means the source cannot be cached (DASH, DRM, a live stream); token_refused that the host kept refusing fresh tokens; cache_exists that this machine holds the title at another max_height: clear it first. ' +
  'Off on this server: direct_stream_off.';

interface CacheArgs {
  action: 'start' | 'status' | 'list' | 'clear';
  title?: string | undefined;
  year?: number | undefined;
  kind?: 'movie' | 'tv' | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  absolute_episode?: number | undefined;
  max_height?: number | undefined;
  id?: string | undefined;
}

type Resolved =
  | { found: true; target: StreamTarget; title: ReturnType<typeof candidateView>; picked: Record<string, unknown> }
  | { found: false; answer: Record<string, unknown> };

function ok(value: unknown): CallToolResult {
  return jsonResult(value, true);
}

function cacheErrorResult(err: CacheError): CallToolResult {
  const next =
    err.code === 'cache_exists'
      ? 'This machine already holds that title at another quality. Say so with the cache; to change it, clear it (action clear) and start again.'
      : err.code === 'not_on_this_machine'
        ? 'That cache is on the other laptop. Say so; it can be played or cleared only there.'
        : 'There is no such cache. Say so.';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: err.code, message: err.message, ...(err.extra.host === undefined ? {} : { host: err.extra.host }), ...(err.extra.cache === undefined ? {} : { cache: err.extra.cache }), next }),
      },
    ],
  };
}

/** The film or episode the words name, as direct_stream_play finds it; a series without an episode takes play's pick only for `start`. */
async function resolveTarget(a: CacheArgs, title: string, d: DirectStreamToolDeps, wall: string): Promise<Resolved> {
  const result = await lookupTitle(parseTitleRequest(title, a.year ?? null, a.kind ?? null), d);
  if (result.status === 'none') {
    return {
      found: false,
      answer: { skipped: 'no_match', did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)), next: 'No title has that name (or that name and year). Show did_you_mean with years and ask which is meant; then call again with its title_key.' },
    };
  }
  if (result.status === 'several') {
    return {
      found: false,
      answer: { skipped: 'several_matches', candidates: result.candidates.map((c) => candidateView(c, wall)), next: 'List the candidates with their years and ask which one; then call again with its movie_id or title_key.' },
    };
  }
  const c = result.candidate;
  let target = targetFor(c, result.episode, a.season, a.episode);
  let picked: Record<string, unknown> = {};
  if (a.absolute_episode !== undefined) {
    if (c.kind !== 'tv') throw new LookupError('invalid_input', `${label(c)} is a film: it takes no episode.`);
    if (target !== null || a.season !== undefined || a.episode !== undefined) throw new LookupError('invalid_input', 'pass absolute_episode alone, or season and episode: not both.');
    const { choice } = await chooseAbsolute(c, a.absolute_episode, d);
    if (choice.pick === 'unknown') {
      return { found: false, answer: { skipped: 'no_such_episode', title: candidateView(c, wall), absolute_episode: a.absolute_episode, episodes: choice.episodes, next: `${label(c)} has ${choice.episodes} episodes listed. Say so.` } };
    }
    if (choice.pick === 'unclear') {
      return {
        found: false,
        answer: {
          skipped: 'episode_unclear',
          title: candidateView(c, wall),
          absolute_episode: a.absolute_episode,
          candidates: choice.candidates.map((e) => ({ season: e.season, episode: e.episode, reading: e.reading })),
          next: 'That number can be read two ways. List the candidates as season and episode and ask which; then call again with that season and episode.',
        },
      };
    }
    target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
    picked = { picked: 'absolute', absolute_episode: a.absolute_episode };
  }
  if (target === null) {
    if (a.season !== undefined || a.episode !== undefined) throw new LookupError('invalid_input', `${label(c)} is a series: pass both season and episode.`);
    if (a.action !== 'start') {
      return { found: false, answer: { skipped: 'needs_episode', title: candidateView(c, wall), next: 'A series is cached per episode: call again with season and episode (or absolute_episode).' } };
    }
    const choice = await chooseEpisode(c, d);
    if (choice.pick === 'caught_up') {
      return { found: false, answer: { skipped: 'caught_up', title: candidateView(c, wall), last: choice.last, next: 'Every episode after the last one played is finished. Say so; name a season and episode to cache one.' } };
    }
    if (choice.pick === 'not_aired') {
      return { found: false, answer: { skipped: 'not_aired', title: candidateView(c, wall), season: choice.season, episode: choice.episode, air_date: choice.airDate, next: 'The next episode has not aired yet. Say which and when.' } };
    }
    target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
    picked = { picked: choice.pick };
  }
  return { found: true, target, title: candidateView(c, wall), picked: { ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : {}), ...picked } };
}

async function cacheAction(a: CacheArgs, d: StreamCacheToolDeps, wall: string): Promise<CallToolResult> {
  if (a.action === 'list') {
    const caches = await d.cache.list();
    return ok({
      host: d.cache.host,
      count: caches.length,
      caches,
      next: caches.length === 0 ? 'Nothing is cached on either machine. Say so.' : 'List them with their state and progress; available false is a cache on the other laptop.',
    });
  }
  if (a.id !== undefined) {
    const id = a.id.toLowerCase();
    if (a.action === 'start') throw new LookupError('invalid_input', 'start takes a title, not an id.');
    if (a.action === 'status') {
      const cache = await d.cache.get(id);
      if (cache === null) throw new CacheError('unknown_cache', 'No stream cache has this id.');
      return ok({ caches: [cache], next: "Say the cache's state, progress and machine." });
    }
    await d.cache.remove(id);
    return ok({ cleared: true, id, next: 'Say the cache was cleared and its files deleted from this machine.' });
  }
  if (a.title === undefined) throw new LookupError('invalid_input', `${a.action} needs a title (or an id from an earlier answer).`);
  const found = await resolveTarget(a, a.title, d.lookup, wall);
  if (!found.found) return ok(found.answer);
  const { target, title, picked } = found;
  if (a.action === 'start') {
    const { cache, started } = await d.cache.request(target, { maxHeight: a.max_height ?? null });
    return ok({
      started,
      title,
      ...picked,
      cache,
      next:
        cache.state === 'ready'
          ? 'It is cached on this machine already. Say so.'
          : started
            ? 'Say the download started in the background on this machine (nothing is playing) and that status shows how far it is.'
            : 'It is downloading already. Say how far it is (progress).',
    });
  }
  const caches = await d.cache.forRef(target);
  if (a.action === 'status') {
    return ok({ title, ...picked, caches, next: caches.length === 0 ? 'Nothing of it is cached on either machine. Say so.' : "Say each cache's state, progress and machine." });
  }
  const mine = caches.find((c) => c.available);
  if (mine === undefined) {
    const other = caches[0];
    if (other !== undefined) throw new CacheError('not_on_this_machine', `It is cached on ${other.host} only; clear it there.`, { host: other.host });
    return ok({ cleared: false, title, ...picked, reason: 'no_cache', next: 'Nothing of it is cached on this machine. Say so.' });
  }
  await d.cache.remove(mine.id);
  return ok({ cleared: true, id: mine.id, title, ...picked, next: 'Say the cache was cleared and its files deleted from this machine.' });
}

/** direct_stream_cache. Without deps.streamCache it answers direct_stream_off and starts nothing. */
export function registerStreamCacheTool(server: McpServer, deps: Pick<ToolDeps, 'streamCache' | 'wallUrl'>): void {
  const wall = (deps.wallUrl ?? DEFAULT_WALL_URL).replace(/\/+$/, '');
  server.registerTool(
    CACHE,
    {
      title: 'Cache a film or an episode on this machine',
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['start', 'status', 'list', 'clear']).describe('start a download, status of one title (or id), list every cache, clear (stop and delete) one.'),
        title: z.string().trim().min(1).max(200).optional().describe("The film or series title without the year, a movie id (M-23T4; an episode's id names its season and episode), or a title key (movie-550)."),
        year: z.number().int().min(1880).max(2100).optional().describe('The release year, when known.'),
        kind: z.enum(['movie', 'tv']).optional().describe('"movie" or "tv" (a series), when the owner said which.'),
        season: z.number().int().min(0).max(1000).optional().describe('A series only: the season of the episode.'),
        episode: z.number().int().min(0).max(100000).optional().describe('A series only: the episode number within that season.'),
        absolute_episode: z.number().int().min(1).max(100000).optional().describe('A series only, instead of season and episode: an episode named by one number ("One Piece episode 730").'),
        max_height: z.number().int().min(100).max(4320).optional().describe('start only: cache the tallest rendition not above this height (720, 480). Default: the tallest.'),
        id: z.string().trim().regex(CACHE_ID_PATTERN).optional().describe('A cache id from an earlier answer, instead of title (status, clear).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      const d = deps.streamCache;
      if (!d) return { isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] };
      try {
        return await cacheAction(args, d, wall);
      } catch (err) {
        return err instanceof CacheError ? cacheErrorResult(err) : movieErrorResult(err);
      }
    },
  );
}
