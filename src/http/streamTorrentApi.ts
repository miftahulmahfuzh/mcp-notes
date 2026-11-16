import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { fileResponse } from '../directStream/cache/serve.js';
import type { TorrentStreams } from '../directStream/torrent/service.js';
import { SubtitleShelf, isFile } from '../directStream/torrent/subtitles/disk.js';
import { mediaOf, normalizeInfoHash, TORRENT_OPEN_TIMEOUT_MS, TorrentError } from '../directStream/torrent/types.js';
import type { StreamRef } from '../directStream/types.js';
import { DIRECT_STREAM_OFF } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * Torrents (torrent-stream-source phase 1): the engine's status, opening a torrent and using its files,
 * letting go, one download's view and map, and the file route the player and ffmpeg read. 503
 * direct_stream_off without direct streaming (the directStreamRoutes guard answers first when both are
 * mounted), 503 torrent_off with NOTESD_TORRENT=off. The two POSTs join or leave a swarm, so they are
 * same-origin only.
 */

export const TORRENT_OFF = { error: 'torrent_off', message: 'Torrents are off on this machine (NOTESD_TORRENT=off).' } as const;
const UNKNOWN_TORRENT = { error: 'unknown_torrent', message: 'No torrent download has this info hash.' } as const;

const tmdbId = z.number().int().min(1).max(2_147_483_647);
const tracker = z
  .string()
  .trim()
  .max(500)
  .regex(/^(?:udp|https?|wss?):\/\/\S+$/, 'a tracker is a udp, http(s) or ws(s) address');
const common = {
  info_hash: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{40}$/, 'an info hash is 40 hexadecimal characters'),
  /** The release name as an index lists it. */
  name: z.string().trim().min(1).max(500).nullish(),
  trackers: z.array(tracker).max(50).nullish(),
  /** The file indexes to download: video and subtitle files only. */
  files: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(50).nullish(),
};

export const openBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('movie'), tmdb_id: tmdbId, season: z.null().optional(), episode: z.null().optional(), ...common }),
  z.strictObject({
    kind: z.literal('tv'),
    tmdb_id: tmdbId,
    season: z.number().int().min(0).max(1000),
    episode: z.number().int().min(1).max(10_000),
    ...common,
  }),
]);

type OpenBody = z.infer<typeof openBody>;

function refOf(body: OpenBody): StreamRef {
  return body.kind === 'movie' ? { kind: 'movie', tmdbId: body.tmdb_id } : { kind: 'tv', tmdbId: body.tmdb_id, season: body.season, episode: body.episode };
}

/** TorrentError -> its HTTP answer; anything else is rethrown (500). */
export function torrentErrorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof TorrentError)) throw err;
  const body = { error: err.code, message: err.message };
  switch (err.code) {
    case 'invalid_hash':
    case 'not_media':
      return c.json(body, 400);
    case 'unknown_torrent':
      return c.json(body, 404);
    case 'not_on_this_machine':
      return c.json({ ...body, host: err.extra.host ?? null }, 404);
    case 'not_open':
      return c.json(body, 409);
    case 'unsafe_path':
      return c.json(body, 422);
    case 'engine_error':
      return c.json(body, 502);
    case 'closing':
      return c.json(body, 503);
    case 'no_metadata':
      return c.json(body, 504);
  }
}

export function streamTorrentRoutes(deps: Pick<AppDeps, 'directStream'> & Partial<Pick<AppDeps, 'torrents' | 'config' | 'torrentRemux'>>): Hono {
  const r = new Hono();
  /** Info hashes POST /api/stream/torrent holds in use (one user each) until their release route. */
  const held = new Set<string>();
  const torrentsOf = (): TorrentStreams | null => ((deps.directStream ?? null) === null ? null : (deps.torrents ?? null));
  const off = (c: Context): Response => ((deps.directStream ?? null) === null ? c.json(DIRECT_STREAM_OFF, 503) : c.json(TORRENT_OFF, 503));

  r.get('/api/stream/torrent', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    return c.json({ ...torrents.status(), downloads: await torrents.list() });
  });

  r.post('/api/stream/torrent', sameOriginOnly, async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
    }
    const body = openBody.safeParse(raw);
    if (!body.success) {
      return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    }
    const hash = body.data.info_hash.toLowerCase();
    try {
      const handle = await torrents.open(
        { infoHash: hash, trackers: body.data.trackers ?? [], name: body.data.name ?? null, ref: refOf(body.data) },
        { timeoutMs: TORRENT_OPEN_TIMEOUT_MS },
      );
      const files = body.data.files ?? null;
      if (files !== null) {
        await torrents.use(hash, files);
        // The route holds one user per torrent: a second POST re-chooses without counting twice.
        if (held.has(hash)) await torrents.release(hash);
        else held.add(hash);
      }
      return c.json({
        ok: true,
        from_disk: !handle.live,
        files: handle.files.map((f) => ({ index: f.index, path: f.path, length: f.length, media: mediaOf(f.name) })),
        torrent: await torrents.view(hash),
      });
    } catch (err) {
      return torrentErrorResponse(c, err);
    }
  });

  r.post('/api/stream/torrent/:hash/release', sameOriginOnly, async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    const hash = normalizeInfoHash(c.req.param('hash'));
    if (hash === null) return c.json(UNKNOWN_TORRENT, 404);
    const released = held.delete(hash);
    if (released) await torrents.release(hash);
    const view = await torrents.view(hash);
    if (view === null) return c.json(UNKNOWN_TORRENT, 404);
    return c.json({ ok: true, released, torrent: view });
  });

  r.get('/api/stream/torrent/:hash', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    const view = await torrents.view(c.req.param('hash'));
    if (view === null) return c.json(UNKNOWN_TORRENT, 404);
    return c.json(view);
  });

  // What of the video is on disk: the player's timeline draws it.
  r.get('/api/stream/torrent/:hash/map', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    // Torrent phase 5: a remuxed file is played from its remux, so its stretches are what the remux holds.
    const remuxed = (await deps.torrentRemux?.map(c.req.param('hash').toLowerCase())) ?? null;
    if (remuxed !== null) return c.json(remuxed);
    const map = await torrents.map(c.req.param('hash'));
    if (map === null) return c.json({ ...UNKNOWN_TORRENT, message: 'This machine has no torrent download with this info hash.' }, 404);
    return c.json(map);
  });

  r.get('/api/stream/torrent/:hash/f/:index', async (c) => {
    const torrents = torrentsOf();
    if (torrents === null) return off(c);
    const raw = c.req.param('index');
    const index = /^\d{1,7}$/.test(raw) ? Number(raw) : -1;
    return torrents.serve(c.req.param('hash'), index, c.req.header('range') ?? null);
  });

  // Phase 6: a torrent's subtitle files (WebVTT), kept under its folder by the subtitle tiers.
  r.get('/api/stream/torrent/:hash/sub/:name', async (c) => {
    const torrents = deps.torrents ?? null;
    const dir = deps.config?.torrent?.dir ?? null;
    if (torrents === null || dir === null) return c.json(TORRENT_OFF, 503);
    const hash = c.req.param('hash').toLowerCase();
    const name = c.req.param('name');
    const file = new SubtitleShelf(dir).file(hash, name);
    if (file !== null && (await isFile(file))) return fileResponse(file, name, c.req.header('range') ?? null);
    const view = file === null ? null : await torrents.view(hash);
    if (view !== null && view.available === false) {
      return c.json({ error: 'not_on_this_machine', message: `That torrent is on ${view.host}, not on this machine.`, host: view.host }, 404);
    }
    return c.json({ error: 'not_found', message: 'This machine has no subtitle file by that name for that torrent.' }, 404);
  });

  return r;
}
