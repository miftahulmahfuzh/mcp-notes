import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { INFO_HASH_PATTERN, TRACK_ID_PATTERN } from '../directStream/torrent/subtitles/feed.js';

/**
 * A growing subtitle's cues (torrent-stream-source phase 7): `GET /api/stream/torrent/:hash/cues/:track?after=<n>`
 * answers the cues after the first `n`, the index to ask from next and whether the feed is complete.
 * The player page reads it every few seconds until it is. Read-only, like the file routes the page
 * loads, so it is not same-origin only. 503 `torrent_off` without torrents.
 */

const TORRENT_OFF = { error: 'torrent_off', message: 'Torrents are off on this machine (NOTESD_TORRENT=off).' } as const;
const AFTER = /^\d{1,7}$/;

export function streamTorrentCuesRoutes(deps: Partial<Pick<AppDeps, 'torrentCues'>>): Hono {
  const r = new Hono();

  r.get('/api/stream/torrent/:hash/cues/:track', async (c) => {
    const feeds = deps.torrentCues ?? null;
    if (feeds === null) return c.json(TORRENT_OFF, 503);
    const hash = c.req.param('hash').toLowerCase();
    const track = c.req.param('track');
    const after = c.req.query('after') ?? '0';
    if (!AFTER.test(after)) return c.json({ error: 'invalid_query', message: 'after: a whole number from 0.' }, 400);
    const feed = INFO_HASH_PATTERN.test(hash) && TRACK_ID_PATTERN.test(track) ? await feeds.get(hash, track) : null;
    if (feed === null) return c.json({ error: 'unknown_feed', message: 'This machine has no cue feed by that name.' }, 404);
    c.header('Cache-Control', 'no-store');
    return c.json(feed.read(Number(after)));
  });

  return r;
}
