import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import type { TorrentMark } from '../directStream/torrent/marks.js';
import { DIRECT_STREAM_OFF, directStreamErrorResponse } from './directStreamApi.js';
import { sameOriginOnly } from './sameOrigin.js';

/**
 * The torrent candidates of a film or episode and the owner's torrent blacklist (the title page's candidates list,
 * DirectStreamService.torrentCandidates / blacklistTorrent). Listing joins no swarm. The blacklist writes go through
 * the service, which clears what titles remember of the torrent; they are same-origin only. A torrent is played from
 * the list through `POST /api/stream/play` with its info hash as `magnet`.
 */

const listQuery = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('movie'), tmdb_id: z.coerce.number().int().min(1).max(2_147_483_647), fresh: z.enum(['0', '1', 'true', 'false']).optional() }),
  z.object({
    kind: z.literal('tv'),
    tmdb_id: z.coerce.number().int().min(1).max(2_147_483_647),
    season: z.coerce.number().int().min(0).max(1000),
    episode: z.coerce.number().int().min(1).max(10_000),
    fresh: z.enum(['0', '1', 'true', 'false']).optional(),
  }),
]);
const blacklistBody = z.strictObject({ reason: z.string().trim().max(300).nullish(), name: z.string().trim().max(500).nullish() });
const HASH = /^[0-9a-fA-F]{40}$/;
const BAD_HASH = { error: 'bad_info_hash', message: 'An info hash is 40 hexadecimal characters.' } as const;

/** A mark as the routes and the tool answer it. */
export function markView(m: TorrentMark): Record<string, unknown> {
  return {
    info_hash: m.infoHash,
    name: m.name,
    blacklisted_at: m.blacklistedAt?.toISOString() ?? null,
    reason: m.blacklistReason,
    heard_language: m.heardLanguage,
    tag_languages: m.tagLanguages,
  };
}

export function streamTorrentCandidatesRoutes(deps: Pick<AppDeps, 'directStream'>): Hono {
  const r = new Hono();
  r.use('/api/stream/torrents/*', async (c, next) => {
    if ((deps.directStream ?? null) === null) return c.json(DIRECT_STREAM_OFF, 503);
    await next();
  });
  r.use('/api/stream/torrents', async (c, next) => {
    if ((deps.directStream ?? null) === null) return c.json(DIRECT_STREAM_OFF, 503);
    await next();
  });

  r.get('/api/stream/torrents', async (c) => {
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'invalid_query', message: q.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ') }, 400);
    const ref = q.data.kind === 'movie' ? { kind: 'movie' as const, tmdbId: q.data.tmdb_id } : { kind: 'tv' as const, tmdbId: q.data.tmdb_id, season: q.data.season, episode: q.data.episode };
    try {
      const list = await deps.directStream!.torrentCandidates(ref, { fresh: q.data.fresh === '1' || q.data.fresh === 'true' });
      return c.json(list);
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  r.get('/api/stream/torrents/blacklist', async (c) => {
    try {
      return c.json({ torrents: (await deps.directStream!.blacklistedTorrents()).map(markView) });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  r.post('/api/stream/torrents/:hash/blacklist', sameOriginOnly, async (c) => {
    const hash = c.req.param('hash');
    if (!HASH.test(hash)) return c.json(BAD_HASH, 400);
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim() !== '') {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
    }
    const body = blacklistBody.safeParse(raw);
    if (!body.success) return c.json({ error: 'invalid_body', message: body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400);
    try {
      const done = await deps.directStream!.blacklistTorrent(hash, { reason: body.data.reason ?? null, name: body.data.name ?? null });
      return c.json({ ok: true, torrent: markView(done.mark), forgotten_by: done.forgotten, moving_sessions: done.moving });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  r.delete('/api/stream/torrents/:hash/blacklist', sameOriginOnly, async (c) => {
    const hash = c.req.param('hash');
    if (!HASH.test(hash)) return c.json(BAD_HASH, 400);
    try {
      return c.json({ ok: true, was_blacklisted: await deps.directStream!.unblacklistTorrent(hash) });
    } catch (err) {
      return directStreamErrorResponse(c, err);
    }
  });

  return r;
}
