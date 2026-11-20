import { describe, expect, it } from 'vitest';
import { streamPositionRoutes } from '../../../../src/http/directStreamApi.js';
import type { MovieStreamsSource } from '../../../../src/movies/streams.js';
import type { StreamLive } from '../../../../src/movies/streamLive.js';

const HASH = 'c0ffee'.padEnd(40, '0');
const BASE = 'http://127.0.0.1:7999';

/** A movies store that holds no title and has no TMDB: the report is answered unknown_title after the torrent is marked. */
const movies = { repo: { titleById: async () => null }, tmdb: null, events: { emit: () => true }, host: 'host-a' } as unknown as MovieStreamsSource;

function setup(options: { torrent: boolean; live?: StreamLive }) {
  const played: string[] = [];
  const session = { id: 's1', ref: { kind: 'movie', tmdbId: 550 }, source: { provider: 'Torrent' }, torrent: options.torrent ? { subtitleRev: 0, infoHash: HASH } : null };
  const app = streamPositionRoutes({
    movies,
    directStream: { session: () => session as never },
    live: options.live ?? null,
    torrents: { played: async (h) => void played.push(h) },
  });
  const report = (body: object) =>
    app.request(`${BASE}/api/stream/sessions/s1/position`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { played, report };
}

describe('a torrent download counts as played only from the player page\'s reports', () => {
  it('a position report of a torrent session marks its download played', async () => {
    const { played, report } = setup({ torrent: true });
    await report({ position_s: 12 });
    expect(played).toEqual([HASH]);
  });

  it('a cloud session marks no torrent', async () => {
    const { played, report } = setup({ torrent: false });
    await report({ position_s: 12 });
    expect(played).toEqual([]);
  });

  it('a paused page\'s beat marks nothing', async () => {
    const live = { has: () => true, current: () => ({ title_id: 'movie-550', duration: 100 }), report: () => undefined } as unknown as StreamLive;
    const { played, report } = setup({ torrent: true, live });
    await report({ position_s: 12, paused: true, beat: true });
    expect(played).toEqual([]);
  });
});
