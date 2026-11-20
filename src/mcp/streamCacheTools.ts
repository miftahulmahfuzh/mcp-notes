import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { STREAM_CACHE_TOOL_NAMES } from '../chat/status.js';
import type { AppDeps } from '../deps.js';
import { CACHE_ID_PATTERN, CacheError, type StreamCacheView } from '../directStream/cache/types.js';
import { DownloadError } from '../directStream/downloads/types.js';
import { LookupError, lookupTitle, parseTitleRequest, type StreamTarget } from '../directStream/lookup.js';
import { DOWNLOADS_OFF, listedDownloads, queueDownload, type DownloadAsk, type ListedDownload, type StreamDownloadsPort } from '../http/streamDownloadsApi.js';
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
  /**
   * The download queue (src/directStream/downloads/service.ts): provider "torrent", a season, and the downloads in status
   * and list. Omitted or null (NOTESD_STREAM_DOWNLOADS=off): those starts answer downloads_off, and the lists carry none.
   */
  downloads?: StreamDownloadsPort | null;
}

/** The tool deps of a running daemon, or null when direct streaming (or the cache) is off. */
export function streamCacheToolDeps(deps: AppDeps): StreamCacheToolDeps | null {
  const lookup = directStreamToolDeps(deps);
  const cache = deps.streamCache ?? null;
  return lookup === null || cache === null ? null : { lookup, cache, downloads: deps.streamDownloads ?? null };
}

const DESCRIPTION =
  "Download a film, or one episode of a series, to this machine's disk so it can play from the local copy instead of the stream host (a slow or far host, a bad connection). " +
  'action start resolves a cloud source the way direct_stream_play does (out of sight, nothing plays, 5 to 40 seconds), then downloads one rendition with its segments, keys and the English subtitle in the background: the call answers at once with the cache (state downloading, progress, segments_done of segments_total) and the download goes on after it. ' +
  'Pass title (words without the year, a movie id, or a title key) with year and kind when known; for a series season and episode, or absolute_episode, or neither to take the episode direct_stream_play would (picked). max_height caches the tallest rendition not above it (720 for a smaller copy); without it the tallest. ' +
  'provider "torrent" downloads from a torrent instead (the best one with live seeds, 1080p first; info_hash, from direct_stream_torrents, names one torrent), through the same queue as the wall\'s Download button, and keeps it on this machine until it is deleted (stream_disk): the answer carries downloads. A series\' season without an episode (start only) downloads every aired episode of that season not yet whole here, one download each, from torrents with provider "torrent", else from the cloud; the answer says how many were queued (created), already here (whole) and not aired yet or with no air date (not_aired). provider "cloud", or none, for one film or episode is the cache above. ' +
  'action status shows that title\'s caches and downloads (or the one of id); list shows every cache and this machine\'s downloads; clear stops this machine\'s download of a cache and deletes its files. ' +
  'A cache belongs to the machine that made it: one made on the other laptop has available false and cannot be played or cleared here (not_on_this_machine). ' +
  'Answers carry cache { id, state downloading | ready | failed, progress, segments_done, segments_total, bytes, height, provider, subtitle, error, auto }. auto true is a cache a pause in the player started by itself: it clears itself three days after it was last written, and start on it makes it the owner\'s to keep. error cache_unsupported means the source cannot be cached (DASH, DRM, a live stream); token_refused that the host kept refusing fresh tokens; cache_exists that this machine holds the title at another max_height: clear it first. ' +
  'A download is { id, title_id, season, episode, state queued | running | paused | failed, via, source torrent | cloud, progress 0 to 1, bytes_done, bytes_total, error, detail }; paused waits for a torrent play on screen to end; error no_source means no torrent and no cloud source could be downloaded. downloads_off means the download queue is off on this machine; unknown_season that the series lists no episode of that season. ' +
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
  provider?: 'torrent' | 'cloud' | undefined;
  info_hash?: string | undefined;
}

type TitleView = ReturnType<typeof candidateView>;

type Resolved =
  | { scope: 'one'; target: StreamTarget; title: TitleView; picked: Record<string, unknown> }
  | { scope: 'season'; tmdbId: number; season: number; title: TitleView }
  | { scope: 'none'; answer: Record<string, unknown> };

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

function downloadErrorResult(err: DownloadError): CallToolResult {
  const next = err.code === 'unknown_download' ? 'There is no such download on this machine. Say so.' : 'Say the download could not be queued, and why (message).';
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: err.code, message: err.message, next }) }],
  };
}

const DOWNLOADS_OFF_RESULT: CallToolResult = {
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ ...DOWNLOADS_OFF, next: 'Downloads are off on this machine. Say so; provider "cloud" (or none) still caches one film or episode.' }) }],
};

/** Arguments that only mean something together, refused where they enter. */
function argumentProblem(a: CacheArgs): string | null {
  if (a.action !== 'start' && (a.provider !== undefined || a.info_hash !== undefined)) return 'provider and info_hash go with action start only.';
  if (a.info_hash !== undefined && a.provider !== 'torrent') return 'info_hash names one torrent: pass provider "torrent" with it.';
  if (a.max_height !== undefined && a.provider === 'torrent') return 'max_height is for the cloud cache: a torrent download takes the best torrent (1080p first).';
  return null;
}

/** The film, episode or (start only) season the words name, as direct_stream_play finds it; a series without an episode takes play's pick only for `start`. */
async function resolveTarget(a: CacheArgs, title: string, d: DirectStreamToolDeps, wall: string): Promise<Resolved> {
  const result = await lookupTitle(parseTitleRequest(title, a.year ?? null, a.kind ?? null), d);
  if (result.status === 'none') {
    return {
      scope: 'none',
      answer: { skipped: 'no_match', did_you_mean: result.nearMisses.map((c) => candidateView(c, wall)), next: 'No title has that name (or that name and year). Show did_you_mean with years and ask which is meant; then call again with its title_key.' },
    };
  }
  if (result.status === 'several') {
    return {
      scope: 'none',
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
      return { scope: 'none', answer: { skipped: 'no_such_episode', title: candidateView(c, wall), absolute_episode: a.absolute_episode, episodes: choice.episodes, next: `${label(c)} has ${choice.episodes} episodes listed. Say so.` } };
    }
    if (choice.pick === 'unclear') {
      return {
        scope: 'none',
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
    // A season with no episode: start downloads the whole season (every aired episode not whole here).
    if (a.action === 'start' && a.season !== undefined && a.episode === undefined) {
      return { scope: 'season', tmdbId: c.tmdbId, season: a.season, title: candidateView(c, wall) };
    }
    if (a.season !== undefined || a.episode !== undefined) throw new LookupError('invalid_input', `${label(c)} is a series: pass both season and episode.`);
    if (a.action !== 'start') {
      return { scope: 'none', answer: { skipped: 'needs_episode', title: candidateView(c, wall), next: 'A series is cached per episode: call again with season and episode (or absolute_episode).' } };
    }
    const choice = await chooseEpisode(c, d);
    if (choice.pick === 'caught_up') {
      return { scope: 'none', answer: { skipped: 'caught_up', title: candidateView(c, wall), last: choice.last, next: 'Every episode after the last one played is finished. Say so; name a season and episode to cache one.' } };
    }
    if (choice.pick === 'not_aired') {
      return { scope: 'none', answer: { skipped: 'not_aired', title: candidateView(c, wall), season: choice.season, episode: choice.episode, air_date: choice.airDate, next: 'The next episode has not aired yet. Say which and when.' } };
    }
    target = { kind: 'tv', tmdbId: c.tmdbId, season: choice.season, episode: choice.episode };
    picked = { picked: choice.pick };
  }
  return { scope: 'one', target, title: candidateView(c, wall), picked: { ...(target.kind === 'tv' ? { season: target.season, episode: target.episode } : {}), ...picked } };
}

/** This machine's listed downloads (what GET /api/stream/downloads lists without a title); none when the queue is off. */
async function allDownloads(d: StreamCacheToolDeps): Promise<ListedDownload[]> {
  const port = d.downloads ?? null;
  return port === null ? [] : listedDownloads(await port.list(), port.host, null);
}

function sameSlot(x: ListedDownload, target: StreamTarget): boolean {
  if (x.kind !== target.kind || x.tmdb_id !== target.tmdbId) return false;
  return target.kind === 'movie' || (x.season === target.season && x.episode === target.episode);
}

/** Queues a download through the same call as POST /api/stream/downloads, and says what was queued. */
async function startDownload(d: StreamCacheToolDeps, ask: DownloadAsk, title: TitleView, picked: Record<string, unknown>): Promise<CallToolResult> {
  const port = d.downloads ?? null;
  if (port === null) return DOWNLOADS_OFF_RESULT;
  const q = await queueDownload(port, ask);
  const season = ask.scope === 'season';
  if ('refused' in q) {
    if (q.refused === 'downloads_off') return DOWNLOADS_OFF_RESULT;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_season', message: q.message, next: 'That season lists no episode. Say so.' }) }] };
  }
  return ok({
    started: q.created > 0,
    title,
    ...picked,
    provider: ask.via === 'cloud' ? 'cloud' : 'torrent',
    created: q.created,
    whole: q.whole,
    ...(season ? { not_aired: q.not_aired } : {}),
    downloads: q.downloads,
    next:
      q.downloads.length === 0
        ? season
          ? 'Every aired episode of that season is on this machine already (whole), or none has aired (not_aired). Say so.'
          : 'It is on this machine already. Say so.'
        : q.created > 0
          ? 'Say the download is queued on this machine (nothing is playing), that it is kept until it is deleted on the Cache page, and that status shows how far it is.'
          : 'It is queued or downloading already. Say how far it is (progress).',
  });
}

async function cacheAction(a: CacheArgs, d: StreamCacheToolDeps, wall: string): Promise<CallToolResult> {
  const problem = argumentProblem(a);
  if (problem !== null) throw new LookupError('invalid_input', problem);
  if (a.action === 'list') {
    const caches = await d.cache.list();
    const downloads = await allDownloads(d);
    return ok({
      host: d.cache.host,
      count: caches.length,
      caches,
      downloads,
      next: caches.length === 0 && downloads.length === 0 ? 'Nothing is cached or downloading. Say so.' : 'List them with their state and progress; available false is a cache on the other laptop.',
    });
  }
  if (a.id !== undefined) {
    const id = a.id.toLowerCase();
    if (a.action === 'start') throw new LookupError('invalid_input', 'start takes a title, not an id.');
    if (a.action === 'status') {
      const cache = await d.cache.get(id);
      if (cache !== null) return ok({ caches: [cache], next: "Say the cache's state, progress and machine." });
      const download = (await allDownloads(d)).find((x) => x.id === id);
      if (download === undefined) throw new CacheError('unknown_cache', 'No stream cache or download has this id.');
      return ok({ downloads: [download], next: "Say the download's state, progress and source." });
    }
    await d.cache.remove(id);
    return ok({ cleared: true, id, next: 'Say the cache was cleared and its files deleted from this machine.' });
  }
  if (a.title === undefined) throw new LookupError('invalid_input', `${a.action} needs a title (or an id from an earlier answer).`);
  const found = await resolveTarget(a, a.title, d.lookup, wall);
  if (found.scope === 'none') return ok(found.answer);
  if (found.scope === 'season') {
    if (a.info_hash !== undefined || a.max_height !== undefined) {
      throw new LookupError('invalid_input', 'A season downloads one torrent or cache per episode: it takes no info_hash or max_height.');
    }
    return startDownload(d, { scope: 'season', tmdbId: found.tmdbId, season: found.season, via: a.provider === 'torrent' ? 'torrent' : 'cloud' }, found.title, { season: found.season });
  }
  const { target, title, picked } = found;
  if (a.action === 'start') {
    if (a.provider === 'torrent') {
      return startDownload(d, { scope: 'one', ref: target, via: 'torrent', infoHash: a.info_hash === undefined ? null : a.info_hash.toLowerCase() }, title, picked);
    }
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
    const downloads = (await allDownloads(d)).filter((x) => sameSlot(x, target));
    return ok({
      title,
      ...picked,
      caches,
      downloads,
      next: caches.length === 0 && downloads.length === 0 ? 'Nothing of it is cached or downloading. Say so.' : "Say each cache's and download's state, progress and machine.",
    });
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
        action: z.enum(['start', 'status', 'list', 'clear']).describe('start a download, status of one title (or id), list every cache and download, clear (stop and delete) one cache.'),
        title: z.string().trim().min(1).max(200).optional().describe("The film or series title without the year, a movie id (M-23T4; an episode's id names its season and episode), or a title key (movie-550)."),
        year: z.number().int().min(1880).max(2100).optional().describe('The release year, when known.'),
        kind: z.enum(['movie', 'tv']).optional().describe('"movie" or "tv" (a series), when the owner said which.'),
        season: z.number().int().min(0).max(1000).optional().describe('A series only: the season of the episode; with start and no episode, the whole season.'),
        episode: z.number().int().min(0).max(100000).optional().describe('A series only: the episode number within that season.'),
        absolute_episode: z.number().int().min(1).max(100000).optional().describe('A series only, instead of season and episode: an episode named by one number ("One Piece episode 730").'),
        max_height: z.number().int().min(100).max(4320).optional().describe('start from the cloud only: cache the tallest rendition not above this height (720, 480). Default: the tallest.'),
        provider: z.enum(['torrent', 'cloud']).optional().describe('start only: "torrent" downloads from a torrent (kept until deleted); "cloud" or none caches from a cloud source.'),
        info_hash: z.string().trim().regex(/^[0-9a-fA-F]{40}$/).optional().describe('start with provider "torrent", one film or episode: download exactly this torrent (an info_hash from direct_stream_torrents).'),
        id: z.string().trim().regex(CACHE_ID_PATTERN).optional().describe('A cache or download id from an earlier answer, instead of title (status; clear takes a cache id).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => {
      const d = deps.streamCache;
      if (!d) return { isError: true, content: [{ type: 'text', text: DIRECT_STREAM_OFF }] };
      try {
        return await cacheAction(args, d, wall);
      } catch (err) {
        if (err instanceof CacheError) return cacheErrorResult(err);
        if (err instanceof DownloadError) return downloadErrorResult(err);
        return movieErrorResult(err);
      }
    },
  );
}
