import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { candidateFrom, NO_IMDB_ID } from '../../../../../src/directStream/torrent/find/candidate.js';
import { findCandidates, TORRENT_INDEX_USER_AGENT } from '../../../../../src/directStream/torrent/find/find.js';
import type { FetchLike, TorrentIndex, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const SINTEL: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', year: 2010, originalLanguage: 'en' };
const BREAKING_BAD: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
const TORRENTIO_FILM = 'https://torrentio.strem.fun/stream/movie/tt1727587.json';
const TORRENTIO_EPISODE = 'https://torrentio.strem.fun/stream/series/tt0903747:1:1.json';
const APIBAY_FILM = 'https://apibay.org/q.php?q=tt1727587';
const APIBAY_SERIES = 'https://apibay.org/q.php?q=tt0903747';
const EZTV_SERIES = 'https://eztvx.to/api/get-torrents?imdb_id=0903747&limit=100&page=1';
const TORRENTSDB_FILM = 'https://torrentsdb.com/stream/movie/tt1727587.json';
const TORRENTSDB_EPISODE = 'https://torrentsdb.com/stream/series/tt0903747:1:1.json';
const NO_STREAMS = '{"streams":[]}';

type Route = () => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: Array<{ url: string; userAgent: string | null }> } {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, userAgent: init.headers.get('user-agent') });
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fetch failed: no route for ${url}`);
    return route();
  };
  return { fetch, calls };
}
const body = (text: string, status = 200, headers: Record<string, string> = {}): Route => () => new Response(text, { status, headers });
const hash = (n: number): string => n.toString(16).padStart(40, 'a');
function torrentioAnswer(rows: Array<{ title: string; seeds: number; hash: string }>): string {
  return JSON.stringify({
    streams: rows.map((r) => ({ name: 'Torrentio\n1080p', title: `${r.title}\n👤 ${r.seeds} 💾 1.2 GB ⚙️ ThePirateBay`, infoHash: r.hash, behaviorHints: {} })),
  });
}
function addonAnswer(addon: string, rows: Array<{ title: string; seeds: number; hash: string; site: string }>): string {
  return JSON.stringify({
    streams: rows.map((r) => ({ name: `${addon}\n1080p`, title: `${r.title}\n👤 ${r.seeds} 💾 1.2 GB ⚙️ ${r.site}`, infoHash: r.hash, behaviorHints: {} })),
  });
}
// The title-search indexes (WIDER_TORRENT_SOURCES phase 2) answering nothing, for the tests about the IMDb-keyed ones.
const KNABEN = 'https://api.knaben.org/v1';
const BITSEARCH_FILM = 'https://bitsearch.to/api/v1/search?q=Sintel%202010&sort=seeders';
const BITSEARCH_EPISODE = 'https://bitsearch.to/api/v1/search?q=Breaking%20Bad%20S01E01&sort=seeders';
const TCSV_FILM = 'https://torrents-csv.com/service/search?q=Sintel%202010&size=50';
const TCSV_EPISODE = 'https://torrents-csv.com/service/search?q=Breaking%20Bad%20S01E01&size=50';
const NOTHING_BY_TITLE_FILM: Record<string, Route> = { [KNABEN]: body('{"hits":[]}'), [BITSEARCH_FILM]: body('{"success":true,"results":[]}'), [TCSV_FILM]: body('{"torrents":[]}') };
const NOTHING_BY_TITLE_EPISODE: Record<string, Route> = { [KNABEN]: body('{"hits":[]}'), [BITSEARCH_EPISODE]: body('{"success":true,"results":[]}'), [TCSV_EPISODE]: body('{"torrents":[]}') };

describe('findCandidates', () => {
  it('a title with no IMDb id: the indexes keyed by it send no request, the ones asked by title are asked', async () => {
    const { fetch, calls } = fakeFetch({
      [KNABEN]: body('{"hits":[]}'),
      [BITSEARCH_FILM]: body(JSON.stringify({ success: true, results: [{ infohash: hash(21), title: 'Sintel 2010 1080p WEB x264 AAC', seeders: 40, size: 900 * 1024 * 1024 }] })),
      [TCSV_FILM]: body('{"torrents":[]}'),
    });
    const found = await findCandidates({ ...SINTEL, imdbId: null }, { fetch });
    expect(calls.map((c) => c.url).sort()).toEqual([KNABEN, BITSEARCH_FILM, TCSV_FILM].sort());
    const byName = Object.fromEntries(found.indexes.map((a) => [a.index, a]));
    for (const name of ['torrentio', 'apibay', 'torrentsdb']) {
      expect(byName[name]).toMatchObject({ outcome: 'empty', detail: NO_IMDB_ID, listed: 0 });
    }
    expect(byName.bitsearch).toMatchObject({ outcome: 'ok', listed: 1 });
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(21)]);
    expect(found.candidates[0]?.titleSearch).toBe(true);
  });

  it('a series with no IMDb id: EZTV sends no request either', async () => {
    const { fetch, calls } = fakeFetch({ ...NOTHING_BY_TITLE_EPISODE });
    const found = await findCandidates({ ...BREAKING_BAD, imdbId: null }, { fetch });
    expect(found.indexes.find((a) => a.index === 'eztv')).toMatchObject({ outcome: 'empty', detail: NO_IMDB_ID });
    expect(calls.every((c) => [KNABEN, BITSEARCH_EPISODE, TCSV_EPISODE].includes(c.url))).toBe(true);
  });

  it('still refuses an id that is not an IMDb id', async () => {
    await expect(findCandidates({ ...SINTEL, imdbId: 'nonsense' }, { fetch: fakeFetch({}).fetch })).rejects.toThrow(RangeError);
  });

  it('asks Torrentio, apibay and TorrentsDB for a film by its IMDb id and answers ranked candidates', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_FILM]: body(fixture('torrentio-movie-sintel.json')),
      [APIBAY_FILM]: body(fixture('apibay-sintel.json')),
      [TORRENTSDB_FILM]: body(NO_STREAMS),
      ...NOTHING_BY_TITLE_FILM,
    });
    const found = await findCandidates(SINTEL, { fetch });
    expect(calls.map((c) => c.url).sort()).toEqual([APIBAY_FILM, TORRENTIO_FILM, TORRENTSDB_FILM, KNABEN, BITSEARCH_FILM, TCSV_FILM].sort());
    expect(calls.every((c) => c.userAgent === TORRENT_INDEX_USER_AGENT)).toBe(true);
    expect(found.indexes.map((a) => [a.index, a.outcome, a.listed])).toEqual([
      ['torrentio', 'ok', 32],
      ['apibay', 'ok', 19],
      ['torrentsdb', 'empty', 0],
      ['peerflix', 'empty', 0],
      ['knaben', 'empty', 0],
      ['bitsearch', 'empty', 0],
      ['torrentscsv', 'empty', 0],
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([
      'a779fa758f2229586eebc2e5960eb32fe5659596',
      '43f4001de4ab25d521c63684e2b69804193ed9d9',
      '150922bce30a1091e347741ebbf96072593a69b4',
    ]);
    for (const c of found.candidates) {
      expect(c.infoHash).toMatch(/^[0-9a-f]{40}$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.seeds).toBeGreaterThanOrEqual(5);
      expect(c.sizeBytes).toBeGreaterThan(0);
    }
    expect(found.candidates[0]).toMatchObject({ listedBy: ['torrentio'], fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4' });
    expect(found.candidates[0]?.release.direct).toBe(true);
    const mitzep = found.excluded.filter((e) => e.infoHash === 'afb2c3f4ee0901947219e69997e95cd7280ca2d7');
    expect(mitzep).toEqual([expect.objectContaining({ seeds: 1, reason: 'few_seeds' })]);
  });

  it('asks Torrentio, apibay and EZTV for an episode and keeps only that episode or a pack that holds it', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_EPISODE]: body(fixture('torrentio-series-bb-s01e01.json')),
      [APIBAY_SERIES]: body(fixture('apibay-empty.json')),
      [EZTV_SERIES]: body(fixture('eztv-page.json')),
      [TORRENTSDB_EPISODE]: body(NO_STREAMS),
      ...NOTHING_BY_TITLE_EPISODE,
    });
    const found = await findCandidates(BREAKING_BAD, { fetch });
    expect(calls.some((c) => c.url.includes('peerflix'))).toBe(false);
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([
      ['torrentio', 'ok'],
      ['apibay', 'empty'],
      ['eztv', 'empty'],
      ['torrentsdb', 'empty'],
      ['peerflix', 'empty'],
      ['knaben', 'empty'],
      ['bitsearch', 'empty'],
      ['torrentscsv', 'empty'],
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([
      '6bbad06245a0d631b0a5e47c8cd6e5abc9a70211',
      'b43df67a93863ea91f2f773f00361072da771dd3',
      '97a13de6bb8b741a099a446e755a8a09cfd3a493',
      'a43107ec1e5c2f5d6429c68cc030031cddbcb0ad',
      '3c7a0d35b01b8d3b0abab10bb363cbe0b00ace3a',
      '6a12ce77043c07604314f30fa62f2b17ea8d4ab9',
      'a5c1aefb62c9bd67ff49412544915533155a0b99',
      'a77271af0ceae766101146f62899999e8a45ca41',
      '0d9b239b02f5fa8c4cdda71f3ccfde93ae918bd9',
      'c6d960000329117d615b3bcf1f8f93e521d891ab',
      'f6ed72e8ff4ec570210c66abf54acb4342a7bf62',
      '88a54ed7baef627dc1ecc2fd2df70f8ce990ab09',
    ]);
    expect(Object.fromEntries(found.excluded.map((e) => [e.infoHash, e.reason]))).toEqual({
      '703ff2ed0c176f5c432ea7e7e16a41aa137c9c87': 'dubbed',
      '9b2f37817de4b2a5722f622db6d73ba8c774d94c': 'other_title',
      '167e34bbf6fc3e53382d0c8d2a8fe5852b522e91': 'three_d',
      'bbd4d315a00580f9cafd9c36f35165c83f13043c': 'dubbed',
      'd71705838d78b41eaf4a2e1c8da53dc28027ea68': 'few_seeds',
      '0a03aba4f6395f865b40e5c83b27ae4f630897c1': 'dubbed',
    });
    const rutracker = found.candidates.find((c) => c.infoHash === '97a13de6bb8b741a099a446e755a8a09cfd3a493');
    expect(rutracker?.release).toMatchObject({ dubbed: false, multiAudio: true, direct: false });
  });

  it('leaves out an episode that names another one, from an index that was not asked for that episode', async () => {
    const { fetch } = fakeFetch({
      [TORRENTIO_EPISODE]: body('{"streams":[]}'),
      [APIBAY_SERIES]: body(
        JSON.stringify([
          { name: 'Breaking.Bad.S01E01.720p.HDTV.x264', info_hash: hash(1).toUpperCase(), seeders: '40', size: '500000000', imdb: 'tt0903747' },
          { name: 'Breaking.Bad.S01E02.720p.HDTV.x264', info_hash: hash(2).toUpperCase(), seeders: '90', size: '500000000', imdb: 'tt0903747' },
          { name: 'Breaking.Bad.S01.720p.BluRay.x264', info_hash: hash(3).toUpperCase(), seeders: '30', size: '5000000000', imdb: 'tt0903747' },
          { name: 'Breaking Bad 720p', info_hash: hash(4).toUpperCase(), seeders: '80', size: '500000000', imdb: 'tt0903747' },
        ]),
      ),
      [EZTV_SERIES]: body('{"torrents_count":0,"torrents":[]}'),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch });
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1), hash(3)]);
    expect(found.excluded.map((e) => [e.infoHash, e.reason])).toEqual([
      [hash(2), 'other_episode'],
      [hash(4), 'other_episode'],
    ]);
  });

  it('leaves out dubs, cinema recordings and 3D however many seeds they have', async () => {
    const rows = [
      { title: 'Sintel.2010.1080p.WEB.x264-GOOD', seeds: 50, hash: hash(1) },
      { title: 'Sintel.2010.HDCAM.x264-BAD', seeds: 900, hash: hash(2) },
      { title: 'Sintel 2010 1080p TELESYNC', seeds: 800, hash: hash(3) },
      { title: 'Sintel.2010.1080p.3D.HSBS.BluRay.x264', seeds: 700, hash: hash(4) },
      { title: 'Sintel.2010.1080p.Hindi.Dubbed.WEB-DL', seeds: 600, hash: hash(5) },
      { title: 'Sintel (2010) 1080p Latino', seeds: 500, hash: hash(6) },
      { title: 'Sintel.2010.MULTi.1080p.WEB.x264', seeds: 40, hash: hash(7) },
    ];
    const { fetch } = fakeFetch({
      [TORRENTIO_FILM]: body(torrentioAnswer(rows)),
      [APIBAY_FILM]: body(fixture('apibay-empty.json')),
    });
    const found = await findCandidates(SINTEL, { fetch });
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1), hash(7)]);
    expect(found.excluded.map((e) => [e.infoHash, e.reason])).toEqual([
      [hash(2), 'cam'],
      [hash(3), 'cam'],
      [hash(4), 'three_d'],
      [hash(5), 'dubbed'],
      [hash(6), 'dubbed'],
    ]);
  });

  it('records an index that times out or answers a bot check and goes on with the others', async () => {
    const { fetch } = fakeFetch({
      [TORRENTIO_FILM]: body(fixture('cloudflare-challenge.html'), 403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
      [APIBAY_FILM]: body(fixture('apibay-sintel.json')),
      [TORRENTSDB_FILM]: () => new Promise<Response>(() => {}),
      ...NOTHING_BY_TITLE_FILM,
    });
    const found = await findCandidates(SINTEL, { fetch, timeoutMs: 50 });
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'bot_check', listed: 0 }),
      expect.objectContaining({ index: 'apibay', outcome: 'ok', listed: 19 }),
      expect.objectContaining({ index: 'torrentsdb', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
      expect.objectContaining({ index: 'peerflix', outcome: 'empty', listed: 0 }),
      expect.objectContaining({ index: 'knaben', outcome: 'empty', listed: 0 }),
      expect.objectContaining({ index: 'bitsearch', outcome: 'empty', listed: 0 }),
      expect.objectContaining({ index: 'torrentscsv', outcome: 'empty', listed: 0 }),
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual(['43f4001de4ab25d521c63684e2b69804193ed9d9', '150922bce30a1091e347741ebbf96072593a69b4']);
  });

  it('records an index that fails or answers an error status, and answers nothing rather than throwing', async () => {
    const { fetch } = fakeFetch({
      [TORRENTIO_EPISODE]: body('', 500),
      [EZTV_SERIES]: body(fixture('cloudflare-challenge.html'), 200, { 'content-type': 'text/html' }),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch });
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'error', detail: 'HTTP 500' }),
      expect.objectContaining({ index: 'apibay', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'eztv', outcome: 'bot_check' }),
      expect.objectContaining({ index: 'torrentsdb', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'peerflix', outcome: 'empty' }),
      expect.objectContaining({ index: 'knaben', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'bitsearch', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
      expect.objectContaining({ index: 'torrentscsv', outcome: 'error', detail: expect.stringContaining('fetch failed') }),
    ]);
    expect(found.candidates).toEqual([]);
  });

  it('sends every request as notesd, whatever an index asks for', async () => {
    const sneaky: TorrentIndex = {
      name: 'sneaky',
      async find(_query, ctx) {
        await ctx.fetch('https://index.example/x', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        return { outcome: 'empty', detail: 'nothing listed', candidates: [] };
      },
    };
    const { fetch, calls } = fakeFetch({ 'https://index.example/x': body('{}') });
    await findCandidates(SINTEL, { fetch, indexes: [sneaky] });
    expect(calls).toEqual([{ url: 'https://index.example/x', userAgent: TORRENT_INDEX_USER_AGENT }]);
  });

  it('asks the fallback only when the JSON indexes give no usable candidate', async () => {
    const asked: Array<string | null> = [];
    const fallback: TorrentIndex = {
      name: '1337x',
      async find(query) {
        asked.push(query.imdbId);
        const row = { infoHash: hash(9), name: 'Sintel.2010.1080p.WEB.x264-FB', seeds: 60, sizeBytes: 900 * 1024 * 1024 };
        return { outcome: 'ok', detail: '1 listed', candidates: [candidateFrom(row, '1337x', query)] };
      },
    };
    const lowSeeds: TorrentIndex = {
      name: 'torrentio',
      async find(query) {
        const row = { infoHash: hash(8), name: 'Sintel.2010.720p.WEB.x264', seeds: 2, sizeBytes: 500 * 1024 * 1024 };
        return { outcome: 'ok', detail: '1 listed', candidates: [candidateFrom(row, 'torrentio', query)] };
      },
    };
    const found = await findCandidates(SINTEL, { indexes: [lowSeeds], fallback: [fallback] });
    expect(asked).toEqual(['tt1727587']);
    expect(found.indexes.map((a) => a.index)).toEqual(['torrentio', '1337x']);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(9)]);

    asked.length = 0;
    const usable = await findCandidates(SINTEL, { indexes: [lowSeeds], fallback: [fallback], minSeeds: 1 });
    expect(asked).toEqual([]);
    expect(usable.candidates.map((c) => c.infoHash)).toEqual([hash(8)]);

    // Every kept candidate was tried on an earlier ask of the title: the fallback is asked for something new.
    const again = await findCandidates(SINTEL, { indexes: [lowSeeds], fallback: [fallback], minSeeds: 1, tried: new Set([hash(8)]) });
    expect(asked).toEqual(['tt1727587']);
    expect(again.candidates.map((c) => c.infoHash).sort()).toEqual([hash(8), hash(9)]);
  });

  it("gives a fallback index its own longer time limit, and a JSON index never more than timeoutMs", async () => {
    const slow = (name: string, ms: number, timeoutMs: number): TorrentIndex => ({
      name,
      timeoutMs,
      find: (query) => new Promise((resolve) => setTimeout(() => resolve({ outcome: 'ok', detail: '1 listed', candidates: [candidateFrom({ infoHash: hash(7), name: 'Sintel.2010.1080p.WEB.x264-FB', seeds: 60, sizeBytes: 1 }, name, query)] }), ms)),
    });
    const found = await findCandidates(SINTEL, { timeoutMs: 20, indexes: [slow('torrentio', 60, 200)], fallback: [slow('1337x', 60, 200)] });
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([['torrentio', 'error'], ['1337x', 'ok']]);
  });

  it('refuses a query that has no IMDb id', async () => {
    await expect(findCandidates({ kind: 'movie', imdbId: 'sintel' })).rejects.toBeInstanceOf(RangeError);
    const seen: Array<string | null> = [];
    const recorder: TorrentIndex = {
      name: 'recorder',
      async find(query) {
        seen.push(query.imdbId);
        return { outcome: 'empty', detail: 'nothing listed', candidates: [] };
      },
    };
    await findCandidates({ kind: 'movie', imdbId: '1727587' }, { indexes: [recorder] });
    expect(seen).toEqual(['tt1727587']);
  });
});

const PAN: TorrentQuery = { kind: 'movie', imdbId: 'tt0457430', title: "Pan's Labyrinth", originalTitle: 'El laberinto del fauno', year: 2006, originalLanguage: 'es' };
const PAN_URL = {
  torrentio: 'https://torrentio.strem.fun/stream/movie/tt0457430.json',
  apibay: 'https://apibay.org/q.php?q=tt0457430',
  torrentsdb: 'https://torrentsdb.com/stream/movie/tt0457430.json',
  peerflix: 'https://addon.peerflix.mov/stream/movie/tt0457430.json',
};
const PEERFLIX_PAN = JSON.stringify({
  streams: [
    {
      name: 'Peerflix 1080p',
      title: 'El.Laberinto.Del.Fauno.2006.1080p.BluRay.x264-GRP\nEl.Laberinto.Del.Fauno.2006.1080p.BluRay.x264-GRP.mkv\n🇪🇸\n  👤 30 💾 2.1 GB 🌐 Peerflix',
      infoHash: hash(6),
    },
  ],
});

describe('findCandidates with the Stremio add-on providers', () => {
  it("asks TorrentsDB and joins its listing of a torrent with the other indexes' by info hash", async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_FILM]: body(fixture('torrentio-movie-sintel.json')),
      [APIBAY_FILM]: body(fixture('apibay-empty.json')),
      [TORRENTSDB_FILM]: body(
        addonAnswer('TorrentsDB', [
          { title: 'Sintel 2010 720p BluRay', seeds: 45, hash: 'A779FA758F2229586EEBC2E5960EB32FE5659596', site: 'knaben' },
          { title: 'Sintel.2010.1080p.WEB-DL.x264.AAC-TDB', seeds: 12, hash: hash(5), site: 'rargb' },
        ]),
      ),
    });
    const found = await findCandidates(SINTEL, { fetch });
    expect(calls.map((c) => c.url)).toContain(TORRENTSDB_FILM);
    expect(found.indexes.find((a) => a.index === 'torrentsdb')).toMatchObject({ outcome: 'ok', listed: 2 });
    const shared = found.candidates.filter((c) => c.infoHash === 'a779fa758f2229586eebc2e5960eb32fe5659596');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.listedBy).toEqual(['torrentio', 'torrentsdb']);
    expect(shared[0]?.seeds).toBeGreaterThanOrEqual(45);
    expect(found.candidates.find((c) => c.infoHash === hash(5))).toMatchObject({ index: 'torrentsdb', listedBy: ['torrentsdb'], site: 'rargb' });
  });

  it('asks Peerflix for a title made in Spanish and keeps what it lists', async () => {
    const { fetch, calls } = fakeFetch({
      [PAN_URL.torrentio]: body(NO_STREAMS),
      [PAN_URL.apibay]: body(fixture('apibay-empty.json')),
      [PAN_URL.torrentsdb]: body(NO_STREAMS),
      [PAN_URL.peerflix]: body(PEERFLIX_PAN),
    });
    const found = await findCandidates(PAN, { fetch });
    expect(calls.map((c) => c.url)).toContain(PAN_URL.peerflix);
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([
      ['torrentio', 'empty'],
      ['apibay', 'empty'],
      ['torrentsdb', 'empty'],
      ['peerflix', 'ok'],
      ['knaben', 'error'],
      ['bitsearch', 'error'],
      ['torrentscsv', 'error'],
    ]);
    expect(found.candidates).toEqual([expect.objectContaining({ infoHash: hash(6), index: 'peerflix', listedBy: ['peerflix'], site: 'Peerflix' })]);
  });

  it('sends Peerflix no request for a title made in any other language', async () => {
    for (const query of [SINTEL, { ...SINTEL, originalLanguage: null }]) {
      const { fetch, calls } = fakeFetch({
        [TORRENTIO_FILM]: body(NO_STREAMS),
        [APIBAY_FILM]: body(fixture('apibay-empty.json')),
        [TORRENTSDB_FILM]: body(NO_STREAMS),
      });
      const found = await findCandidates(query, { fetch });
      expect(calls.some((c) => c.url.includes('peerflix'))).toBe(false);
      expect(found.indexes.find((a) => a.index === 'peerflix')).toMatchObject({ outcome: 'empty', detail: expect.stringMatching(/^not asked: /), listed: 0 });
    }
  });

  it("records an add-on provider's bot check, timeout or failure and still answers the other indexes' candidates", async () => {
    const torrentio = body(torrentioAnswer([{ title: 'El.Laberinto.Del.Fauno.2006.1080p.BluRay.x264-GRP', seeds: 50, hash: hash(1) }]));
    const blocked = fakeFetch({
      [PAN_URL.torrentio]: torrentio,
      [PAN_URL.apibay]: body(fixture('apibay-empty.json')),
      [PAN_URL.torrentsdb]: body(fixture('cloudflare-challenge.html'), 403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
      [PAN_URL.peerflix]: () => new Promise<Response>(() => {}),
    });
    const found = await findCandidates(PAN, { fetch: blocked.fetch, timeoutMs: 50 });
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'ok', listed: 1 }),
      expect.objectContaining({ index: 'apibay', outcome: 'empty' }),
      expect.objectContaining({ index: 'torrentsdb', outcome: 'bot_check', listed: 0 }),
      expect.objectContaining({ index: 'peerflix', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
      expect.objectContaining({ index: 'knaben', outcome: 'error', listed: 0 }),
      expect.objectContaining({ index: 'bitsearch', outcome: 'error', listed: 0 }),
      expect.objectContaining({ index: 'torrentscsv', outcome: 'error', listed: 0 }),
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1)]);

    const failing = fakeFetch({
      [PAN_URL.torrentio]: torrentio,
      [PAN_URL.apibay]: body(fixture('apibay-empty.json')),
      [PAN_URL.torrentsdb]: body('', 500),
    });
    const again = await findCandidates(PAN, { fetch: failing.fetch });
    expect(again.indexes.find((a) => a.index === 'torrentsdb')).toMatchObject({ outcome: 'error', detail: 'HTTP 500' });
    expect(again.indexes.find((a) => a.index === 'peerflix')).toMatchObject({ outcome: 'error', detail: expect.stringContaining('fetch failed') });
    expect(again.candidates.map((c) => c.infoHash)).toEqual([hash(1)]);
  });
});
