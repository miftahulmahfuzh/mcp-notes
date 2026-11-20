import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apibayIndex } from '../../../../../src/directStream/torrent/find/apibay.js';
import { DEFAULT_TRACKERS } from '../../../../../src/directStream/torrent/find/candidate.js';
import { eztvIndex } from '../../../../../src/directStream/torrent/find/eztv.js';
import { getIndexJson } from '../../../../../src/directStream/torrent/find/http.js';
import { peerflixIndex } from '../../../../../src/directStream/torrent/find/peerflix.js';
import { torrentioIndex } from '../../../../../src/directStream/torrent/find/torrentio.js';
import { torrentsdbIndex } from '../../../../../src/directStream/torrent/find/torrentsdb.js';
import type { IndexContext, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

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
  it('asks for an episode by its number within the season when the query carries one', async () => {
    const { ctx, urls } = ctxFor({ 'https://torrentio.example/stream/series/tt0388629:21:109.json': JSON.stringify({ streams: [] }) });
    const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0388629', season: 21, episode: 1000, absoluteEpisode: 1000, alt: { season: 21, episode: 109 } };
    expect((await torrentioIndex('https://torrentio.example').find(query, ctx)).outcome).toBe('empty');
    expect(urls).toEqual(['https://torrentio.example/stream/series/tt0388629:21:109.json']);
  });

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

const SHAWSHANK: TorrentQuery = { kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: 1994, originalLanguage: 'en' };

describe('torrentsdb', () => {
  it('reads a film answer in Torrentio\'s shape: release, file, seeds, size, site, trackers, any-case info hash', async () => {
    const { ctx, urls } = ctxFor({ 'https://torrentsdb.example/stream/movie/tt0111161.json': fixture('torrentsdb-movie-shawshank.json') });
    const answer = await torrentsdbIndex('https://torrentsdb.example/').find(SHAWSHANK, ctx);
    expect(urls).toEqual(['https://torrentsdb.example/stream/movie/tt0111161.json']);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(4);
    expect(answer.candidates.every((c) => c.index === 'torrentsdb' && c.listedBy.join() === 'torrentsdb' && !c.scoped)).toBe(true);
    expect(answer.candidates[0]).toMatchObject({
      infoHash: 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6',
      name: 'The Shawshank Redemption 1994 2160p BluRay',
      fileName: 'The.Shawshank.Redemption.1994.2160p.4K.BluRay.x265.10bit.HDR.AAC5.1-[YTS.MX].mkv',
      fileIdx: 0,
      seeds: 100,
      sizeBytes: 7419556004,
      site: 'YTS',
    });
    expect(answer.candidates[1]?.infoHash).toBe('c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6');
    expect(answer.candidates[2]).toMatchObject({ infoHash: '32770c6dd35a4dd71deb80d5deff7a4e084eedab', site: 'rargb', seeds: 93, sizeBytes: 62255550956, fileIdx: 1 });
    expect(answer.candidates[2]?.trackers).toEqual(expect.arrayContaining(['udp://9.rarbg.me:2860/announce', DEFAULT_TRACKERS[0]]));
    expect(answer.candidates[2]?.trackers.some((t) => t.startsWith('dht:'))).toBe(false);
  });

  it('asks for an episode by season and episode and marks it scoped', async () => {
    const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
    const stream = { name: 'TorrentsDB\n1080p', title: 'Breaking.Bad.S01E01.1080p.BluRay.x264-GRP\n👤 40 💾 1.5 GB ⚙️ knaben', infoHash: 'ab'.repeat(20) };
    const { ctx, urls } = ctxFor({ 'https://torrentsdb.example/stream/series/tt0903747:1:1.json': JSON.stringify({ streams: [stream] }) });
    const answer = await torrentsdbIndex('https://torrentsdb.example').find(query, ctx);
    expect(urls).toEqual(['https://torrentsdb.example/stream/series/tt0903747:1:1.json']);
    expect(answer.candidates).toEqual([expect.objectContaining({ infoHash: 'ab'.repeat(20), scoped: true, site: 'knaben', seeds: 40 })]);
  });
});

describe('peerflix', () => {
  // The recorded answer is The Shawshank Redemption's; the query says Spanish only so that Peerflix is asked.
  const SPANISH: TorrentQuery = { ...SHAWSHANK, originalLanguage: 'es' };

  it('reads a stats line that ends in the globe and the flag line before it', async () => {
    const { ctx, urls } = ctxFor({ 'https://peerflix.example/stream/movie/tt0111161.json': fixture('peerflix-movie-shawshank.json') });
    const answer = await peerflixIndex('https://peerflix.example').find(SPANISH, ctx);
    expect(urls).toEqual(['https://peerflix.example/stream/movie/tt0111161.json']);
    expect(answer.outcome).toBe('ok');
    expect(answer.candidates).toHaveLength(3);
    expect(answer.candidates[0]).toMatchObject({
      infoHash: '814978f980297cc7cd42be9d60b37b928a5e7cdc',
      name: 'Cadena perpetua [4Kreescaldo][2160p][HDR10][AC3 5.1 Castellano-AC3 5.1-Ingles+Subs][ES-EN]',
      fileName: 'Cadena perpetua 4Kreescalado2160.pctmix1.com.mkv',
      fileIdx: 5,
      seeds: 6,
      sizeBytes: 64005750129,
      site: 'Peerflix',
      index: 'peerflix',
    });
    expect(answer.candidates[1]?.seeds).toBe(0);
  });

  it('reads a row with no size', async () => {
    const stream = {
      name: 'Peerflix 1080p',
      title: 'El laberinto del fauno [1080p][Castellano]\nEl laberinto del fauno 1080p.mkv\n🇪🇸\n  👤 4 🌐 Peerflix',
      infoHash: 'cd'.repeat(20),
    };
    const { ctx } = ctxFor({ 'https://peerflix.example/stream/movie/tt0111161.json': JSON.stringify({ streams: [stream] }) });
    const answer = await peerflixIndex('https://peerflix.example').find(SPANISH, ctx);
    expect(answer.candidates).toEqual([
      expect.objectContaining({ name: 'El laberinto del fauno [1080p][Castellano]', fileName: 'El laberinto del fauno 1080p.mkv', seeds: 4, sizeBytes: null, site: 'Peerflix' }),
    ]);
  });

  it('sends no request for a title made in another language, or in an unknown one, and asks for Spanish in any case', async () => {
    for (const originalLanguage of ['en', 'pt', null]) {
      const { ctx, urls } = ctxFor({});
      const answer = await peerflixIndex('https://peerflix.example').find({ ...SHAWSHANK, originalLanguage }, ctx);
      expect(urls).toEqual([]);
      expect(answer).toEqual({ outcome: 'empty', detail: expect.stringMatching(/^not asked: .*Spanish/), candidates: [] });
    }
    const { ctx, urls } = ctxFor({ 'https://peerflix.example/stream/movie/tt0111161.json': '{"streams":[]}' });
    await peerflixIndex('https://peerflix.example').find({ ...SHAWSHANK, originalLanguage: 'ES' }, ctx);
    expect(urls).toEqual(['https://peerflix.example/stream/movie/tt0111161.json']);
  });
});
