import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { SeasonAnswer } from '../directStream/downloads/season.js';
import type { StreamDownloads } from '../directStream/downloads/service.js';
import { DownloadError, type DownloadRequestAnswer, type DownloadVia, type DownloadView } from '../directStream/downloads/types.js';
import type { StreamRef } from '../directStream/types.js';
import { parseTitleId, type TitleKind } from '../movies/types.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * The download queue (src/directStream/downloads/service.ts): the title page's Download buttons and direct_stream_cache's
 * torrent option queue a film, an episode or a season here; the title page and the Cache page read how far each one is.
 * POST answers at once and the engine downloads after it. The writes are same-origin only. Only this host's downloads
 * are listed: a row of the other machine names files that are not here.
 */

export const DOWNLOADS_OFF = {
  error: 'downloads_off',
  message: 'Downloads are off on this machine (NOTESD_STREAM_DOWNLOADS=off, or direct streaming off).',
} as const;

const UNKNOWN_DOWNLOAD = { error: 'unknown_download', message: 'No download has this id.' } as const;

/** A download id: the uuid `stream_downloads` makes. */
export const DOWNLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the routes and direct_stream_cache call on the daemon's StreamDownloads; tests pass a fake. */
export type StreamDownloadsPort = Pick<StreamDownloads, 'host' | 'request' | 'requestSeason' | 'cancel' | 'list'>;

/** A download as the routes and the tool answer it: the engine's view plus the title key (`movie-550`, `tv-1399`). */
export type ListedDownload = DownloadView & { title_id: string };

export function listed(d: DownloadView): ListedDownload {
  return { ...d, title_id: `${d.kind}-${d.tmdb_id}` };
}

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const season = z.number().int().min(0).max(1000);
const episode = z.number().int().min(1).max(10_000);
const via = z.enum(['auto', 'torrent', 'cloud']);
const infoHash = z.string().regex(/^[0-9a-fA-F]{40}$/, 'an info hash is 40 hexadecimal characters');

/** A film, one episode, or a season (`tv` with `season` and no `episode`; it takes no info_hash). */
export const downloadBody = z.union([
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, via: via.optional(), info_hash: infoHash.optional() }),
  z.strictObject({ kind: z.literal('tv'), tmdb_id: tmdbId, season, episode, via: via.optional(), info_hash: infoHash.optional() }),
  z.strictObject({ kind: z.literal('tv'), tmdb_id: tmdbId, season, via: via.optional() }),
]);

export type DownloadBody = z.infer<typeof downloadBody>;

/**
 * One ask of the queue, as the route and the tool both build it. A torrent named by hand goes with via torrent only, and a
 * season names no torrent: the type cannot hold either mistake.
 */
export type DownloadAsk =
  | { scope: 'one'; ref: StreamRef; via: 'auto' | 'cloud'; infoHash: null }
  | { scope: 'one'; ref: StreamRef; via: 'torrent'; infoHash: string | null }
  | { scope: 'season'; tmdbId: number; season: number; via: DownloadVia };

/** What a queued ask answers. */
export interface QueuedDownloads {
  /** Rows this ask made (or failed rows it queued again). 0: everything asked for was queued already or is whole here. */
  created: number;
  /** Films or episodes left out because they are whole on this machine. */
  whole: number;
  /** A season's episodes left out because they have not aired or TMDB gives them no air date (0 for a film or one episode). */
  not_aired: number;
  /** The rows made or found, in GET /api/stream/downloads' shape. */
  downloads: ListedDownload[];
}

/** A season ask the engine refused: no episode of it is listed (404), or no season download is wired (503 downloads_off). */
export interface SeasonRefused {
  refused: 'unknown_season' | 'downloads_off';
  message: string;
}

function fromOne(answers: readonly DownloadRequestAnswer[]): Pick<QueuedDownloads, 'created' | 'whole' | 'downloads'> {
  return {
    created: answers.filter((a) => a.created).length,
    whole: answers.filter((a) => a.onDisk).length,
    downloads: answers.flatMap((a) => (a.download === null ? [] : [listed(a.download)])),
  };
}

function fromSeason(r: SeasonAnswer<DownloadRequestAnswer>): QueuedDownloads | SeasonRefused {
  if (!r.ok) return { refused: r.error === 'unknown_season' ? 'unknown_season' : 'downloads_off', message: r.detail };
  const one = fromOne(r.queued);
  return {
    ...one,
    whole: one.whole + r.left_out.filter((l) => l.why === 'whole').length,
    not_aired: r.left_out.filter((l) => l.why === 'not_aired' || l.why === 'no_air_date').length,
  };
}

function one(ref: StreamRef, asked: DownloadVia | undefined, hash: string | undefined): DownloadAsk | { refused: string } {
  if (hash === undefined) {
    const v = asked ?? 'auto';
    return v === 'torrent' ? { scope: 'one', ref, via: 'torrent', infoHash: null } : { scope: 'one', ref, via: v, infoHash: null };
  }
  if (asked !== undefined && asked !== 'torrent') return { refused: 'info_hash names one torrent: send it with via "torrent", or with no via.' };
  return { scope: 'one', ref, via: 'torrent', infoHash: hash.toLowerCase() };
}

/** The validated body as an ask, or why it is refused (400 invalid_body). */
export function askOf(body: DownloadBody): DownloadAsk | { refused: string } {
  if (body.kind === 'movie') return one({ kind: 'movie', tmdbId: body.tmdb_id }, body.via, body.info_hash);
  if (!('episode' in body)) return { scope: 'season', tmdbId: body.tmdb_id, season: body.season, via: body.via ?? 'auto' };
  return one({ kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode }, body.via, body.info_hash);
}

/**
 * Queues an ask on the engine (phase 2's `request`, phase 3's `requestSeason`) and says what it queued. The route and
 * direct_stream_cache both come through here, so they queue the same download.
 */
export async function queueDownload(port: StreamDownloadsPort, ask: DownloadAsk): Promise<QueuedDownloads | SeasonRefused> {
  if (ask.scope === 'season') return fromSeason(await port.requestSeason(ask.tmdbId, ask.season, { via: ask.via }));
  const r = await port.request(ask.ref, ask.infoHash === null ? { via: ask.via } : { via: ask.via, infoHash: ask.infoHash });
  return { ...fromOne([r]), not_aired: 0 };
}

/**
 * What is listed: this host's downloads, leaving out the ones the owner cancelled; narrowed to one title when `only`
 * names it, and then with that title's finished ones the engine answered (the title page's "on this machine"), else
 * never a finished one (a finished one is on the Cache page). The engine's order is kept; each row gains `title_id`.
 */
export function listedDownloads(all: readonly DownloadView[], host: string, only: { kind: TitleKind; tmdbId: number } | null): ListedDownload[] {
  return all
    .filter(
      (d) =>
        d.host === host &&
        !(d.state === 'failed' && d.error === 'cancelled') &&
        (only === null ? d.state !== 'done' : d.kind === only.kind && d.tmdb_id === only.tmdbId),
    )
    .map(listed);
}

/** True while a listed download still moves (queued, running, or paused for a play): the title page reads again only then. */
export function downloadsActive(list: readonly DownloadView[]): boolean {
  return list.some((d) => d.state === 'queued' || d.state === 'running' || d.state === 'paused');
}

/** DownloadError -> its HTTP answer; anything else is rethrown (500). */
export function downloadErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof DownloadError)) throw err;
  if (err.code === 'unknown_download') return c.json({ error: err.code, message: err.message }, 404);
  if (err.code === 'downloads_off') return c.json(DOWNLOADS_OFF, 503);
  return c.json({ error: 'invalid_body', message: err.message }, 400);
}

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

export function streamDownloadsRoutes(deps: Pick<AppDeps, 'streamDownloads'>): Hono {
  const r = new Hono();
  r.use('/api/stream/downloads', async (c, next) => {
    if ((deps.streamDownloads ?? null) === null) return c.json(DOWNLOADS_OFF, 503);
    await next();
  });
  r.use('/api/stream/downloads/*', async (c, next) => {
    if ((deps.streamDownloads ?? null) === null) return c.json(DOWNLOADS_OFF, 503);
    await next();
  });

  r.post('/api/stream/downloads', sameOriginOnly, async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = downloadBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: issues(body.error) }, 400);
    const ask = askOf(body.data);
    if ('refused' in ask) return c.json({ error: 'invalid_body', message: ask.refused }, 400);
    try {
      const queued = await queueDownload(deps.streamDownloads!, ask);
      if ('refused' in queued) {
        return queued.refused === 'unknown_season' ? c.json({ error: 'unknown_season', message: queued.message }, 404) : c.json(DOWNLOADS_OFF, 503);
      }
      return c.json({ ok: true, ...queued }, queued.created > 0 ? 202 : 200);
    } catch (err) {
      return downloadErrorResponse(c, err);
    }
  });

  r.get('/api/stream/downloads', async (c) => {
    const port = deps.streamDownloads!;
    const title = c.req.query('title');
    const only = title === undefined ? null : parseTitleId(title);
    if (title !== undefined && only === null) {
      return c.json({ error: 'invalid_query', message: 'title: a title id is movie-<tmdb id> or tv-<tmdb id>.' }, 400);
    }
    const downloads = listedDownloads(await port.list(only === null ? undefined : { kind: only.kind, tmdbId: only.tmdbId }), port.host, only);
    return c.json({ host: port.host, active: downloadsActive(downloads), downloads });
  });

  r.delete('/api/stream/downloads/:id', sameOriginOnly, async (c) => {
    const id = c.req.param('id');
    if (!DOWNLOAD_ID_PATTERN.test(id)) return c.json(UNKNOWN_DOWNLOAD, 404);
    try {
      const download = await deps.streamDownloads!.cancel(id.toLowerCase());
      return c.json({ ok: true, download });
    } catch (err) {
      return downloadErrorResponse(c, err);
    }
  });

  return r;
}
