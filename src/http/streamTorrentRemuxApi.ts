import { Hono } from 'hono';
import { REMUX_FILE_NAME, type TorrentRemux } from '../directStream/torrent/remux.js';

/**
 * The files of a torrent remux (torrent phase 5): `GET /api/stream/torrent/:hash/hls/:index/:name`, what hls.js
 * loads for a torrent file Chrome cannot play as is. The hash, the file index and the name are checked here once;
 * TorrentRemux trusts them. Not same-origin only: like the cache's file route it starts nothing.
 */

const INFO_HASH = /^[0-9a-f]{40}$/;
const FILE_INDEX = /^\d{1,5}$/;

/** What the route reads of phase 1's TorrentStreams: whether a torrent is the other machine's. */
interface TorrentViews {
  view(infoHash: string): unknown;
}

/** The other machine's name when phase 1's view says the download is there, else null. */
function otherHost(view: unknown): string | null {
  if (typeof view !== 'object' || view === null) return null;
  const v = view as { available?: unknown; host?: unknown };
  return v.available === false && typeof v.host === 'string' ? v.host : null;
}

export function streamTorrentRemuxRoutes(deps: { torrentRemux?: TorrentRemux | null; torrents?: TorrentViews | null }): Hono {
  const r = new Hono();
  r.get('/api/stream/torrent/:hash/hls/:index/:name', async (c) => {
    const torrents = deps.torrents ?? null;
    if (torrents === null) return c.json({ error: 'torrent_off', message: 'Torrents are off on this machine (NOTESD_TORRENT=off).' }, 503);
    const remux = deps.torrentRemux ?? null;
    if (remux === null) return c.json({ error: 'remux_off', message: 'The remux is off on this machine (NOTESD_TORRENT_REMUX=off).' }, 404);
    const hash = c.req.param('hash').toLowerCase();
    const index = c.req.param('index');
    const name = c.req.param('name');
    if (!INFO_HASH.test(hash) || !FILE_INDEX.test(index) || !REMUX_FILE_NAME.test(name)) {
      return c.json({ error: 'not_found', message: 'No such remux file.' }, 404);
    }
    const answer = await remux.file(hash, Number(index), name, c.req.header('range') ?? null);
    if (answer !== null) return answer;
    const host = otherHost(await Promise.resolve(torrents.view(hash)));
    if (host !== null) return c.json({ error: 'not_on_this_machine', message: `This torrent was downloaded on ${host}.`, host }, 404);
    return c.json({ error: 'not_found', message: 'This machine has no remux of that file.' }, 404);
  });
  return r;
}
