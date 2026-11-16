import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apibayIndex } from '../../../../../src/directStream/torrent/find/apibay.js';
import { DEFAULT_TRACKERS } from '../../../../../src/directStream/torrent/find/candidate.js';
import { eztvIndex } from '../../../../../src/directStream/torrent/find/eztv.js';
import { getIndexJson } from '../../../../../src/directStream/torrent/find/http.js';
import { torrentioIndex } from '../../../../../src/directStream/torrent/find/torrentio.js';
import type { IndexContext, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';
import { ytsIndex } from '../../../../../src/directStream/torrent/find/yts.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');
const SINTEL: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', originalLanguage: 'en' };

function ctxFor(routes: Record<string, string | Response>): { ctx: IndexContext; urls: string[] } {
  const urls: string[] = [];
  const ctx: IndexContext = {
    signal: new AbortController().signal,
    fetch: async (url) => {
      urls.push(url);
      const answer = routes[url];
      if (answer === undefined) throw new TypeError(`fetch failed: no route for ${url}`);
      return typeof answer === 'string' ? new Response(answer, { status: 200 }) : answer;
    },
  };
  return { ctx, urls };
}

describe('torrentio', () => {
  it('reads a film answer: release, file, seeds, size, site, trackers', async () => {
    const { ctx, urls } = ctxFor({ 'https://torrentio.example/stream/movie/tt1727587.json': fixture('torrentio-movie-sintel.json') });
    const answer = await torrentioIndex('https://torrentio.example/').find(SINTEL, ctx);
    expect(urls).toEqual(['https://torrentio.example/stream/movie/tt1727587.json']);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(32);
    const yts = answer.candidates.find((c) => c.infoHash === 'a779fa758f2229586eebc2e5960eb32fe5659596');
    expect(yts).toMatchObject({
      name: 'Sintel 2010 720p BluRay',
      fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4',
      fileIdx: 0,
      seeds: 30,
      sizeBytes: 143099167,
      site: 'YTS',
      index: 'torrentio',
      scoped: false,
    });
    expect(yts?.release.direct).toBe(true);
    const rutor = answer.candidates.find((c) => c.infoHash === 'c334138ef5bfc2d568ea7324e0e2a3a7ec229bdd');
    expect(rutor?.trackers).toEqual(expect.arrayContaining(['http://retracker.local/announce', DEFAULT_TRACKERS[0]]));
  });

  it('reads an episode answer and marks it scoped to the episode', async () => {
    const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
    const { ctx } = ctxFor({ 'https://torrentio.example/stream/series/tt0903747:1:1.json': fixture('torrentio-series-bb-s01e01.json') });
    const answer = await torrentioIndex('https://torrentio.example').find(query, ctx);
    expect(answer.candidates).toHaveLength(18);
    expect(answer.candidates.every((c) => c.scoped)).toBe(true);
    expect(answer.candidates.find((c) => c.infoHash === 'b43df67a93863ea91f2f773f00361072da771dd3')).toMatchObject({
      fileIdx: 245,
      fileName: 'Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).mkv',
      seeds: 523,
    });
  });
});

describe('apibay', () => {
  it('reads rows and lower-cases the info hash', async () => {
    const { ctx } = ctxFor({ 'https://apibay.example/q.php?q=tt1727587': fixture('apibay-sintel.json') });
    const answer = await apibayIndex('https://apibay.example').find(SINTEL, ctx);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(19);
    expect(answer.candidates[0]).toMatchObject({ infoHash: '43f4001de4ab25d521c63684e2b69804193ed9d9', name: 'Sintel.2010.1080p.WEB.H264-CLASSiCALHD', seeds: 22, sizeBytes: 583689809, site: 'ThePirateBay' });
    expect(answer.candidates[0]?.trackers).toEqual([...DEFAULT_TRACKERS]);
  });

  it('reads "No results returned" as empty', async () => {
    const { ctx } = ctxFor({ 'https://apibay.example/q.php?q=tt1727587': fixture('apibay-empty.json') });
    expect(await apibayIndex('https://apibay.example').find(SINTEL, ctx)).toEqual({ outcome: 'empty', detail: 'nothing listed', candidates: [] });
  });
});

describe('eztv', () => {
  it('asks by the IMDb digits and keeps the asked episode only', async () => {
    const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 2, episode: 2 };
    const { ctx, urls } = ctxFor({ 'https://eztv.example/api/get-torrents?imdb_id=0903747&limit=100&page=1': fixture('eztv-page.json') });
    const answer = await eztvIndex('https://eztv.example').find(query, ctx);
    expect(urls).toHaveLength(1);
    expect(answer.candidates).toHaveLength(1);
    expect(answer.candidates[0]).toMatchObject({ infoHash: '1697fa425af41580da18a07b3dd0bc6b589c51a0', seeds: 0, sizeBytes: 924303336, index: 'eztv' });
    expect(answer.candidates[0]?.trackers).toEqual(expect.arrayContaining(['udp://tracker.opentrackr.org:1337/announce', 'https://tracker.zhuqiy.com:443/announce']));
  });
});

describe('yts', () => {
  it('reads every torrent of the asked film as MP4 with AAC', async () => {
    const { ctx } = ctxFor({ 'https://yts.example/api/v2/list_movies.json?query_term=tt1727587': fixture('yts-sintel.json') });
    const answer = await ytsIndex('https://yts.example/api/v2').find(SINTEL, ctx);
    expect(answer.candidates.map((c) => c.infoHash)).toEqual([
      'a779fa758f2229586eebc2e5960eb32fe5659596',
      'b9c4e2d4c0f43a5d1e8f7a6b5c4d3e2f1a0b9c8d',
      '3d0000000000000000000000000000000000ab3d',
    ]);
    expect(answer.candidates[1]).toMatchObject({ name: 'Sintel (2010) [1080p] [bluray] [x264] [YTS]', seeds: 12, site: 'YTS' });
    expect(answer.candidates[1]?.release).toMatchObject({ direct: true, height: 1080 });
    expect(answer.candidates[2]?.release.threeD).toBe(true);
  });

  it('reads an empty list as empty', async () => {
    const { ctx } = ctxFor({ 'https://yts.example/api/v2/list_movies.json?query_term=tt1727587': '{"status":"ok","data":{"movie_count":0}}' });
    expect((await ytsIndex('https://yts.example/api/v2').find(SINTEL, ctx)).outcome).toBe('empty');
  });
});

describe('getIndexJson', () => {
  it('reads a Cloudflare challenge as bot_check, a failed status as error, and text that is not JSON as error', async () => {
    const page = fixture('cloudflare-challenge.html');
    const cases: Array<[Response, unknown]> = [
      [new Response(page, { status: 403, headers: { 'cf-mitigated': 'challenge' } }), { ok: false, outcome: 'bot_check', detail: 'HTTP 403: a bot check page' }],
      [new Response(page, { status: 503 }), { ok: false, outcome: 'bot_check', detail: 'HTTP 503: a bot check page' }],
      [new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }), { ok: false, outcome: 'bot_check', detail: 'HTTP 200: a bot check page' }],
      [new Response('', { status: 500 }), { ok: false, outcome: 'error', detail: 'HTTP 500' }],
      [new Response('<html>maintenance</html>', { status: 200 }), { ok: false, outcome: 'error', detail: 'the answer is not JSON' }],
      [new Response('[1]', { status: 200 }), { ok: true, json: [1] }],
    ];
    for (const [res, expected] of cases) {
      const { ctx } = ctxFor({ 'https://index.example/x': res });
      expect(await getIndexJson(ctx, 'https://index.example/x')).toEqual(expected);
    }
  });
});
