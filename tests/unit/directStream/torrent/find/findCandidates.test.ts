import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { candidateFrom } from '../../../../../src/directStream/torrent/find/candidate.js';
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
const YTS_FILM = 'https://yts.mx/api/v2/list_movies.json?query_term=tt1727587';

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
const NO_YTS = '{"status":"ok","data":{"movie_count":0}}';

describe('findCandidates', () => {
  it('asks Torrentio, apibay and YTS for a film by its IMDb id and answers ranked candidates', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_FILM]: body(fixture('torrentio-movie-sintel.json')),
      [APIBAY_FILM]: body(fixture('apibay-sintel.json')),
      [YTS_FILM]: body(fixture('yts-sintel.json')),
    });
    const found = await findCandidates(SINTEL, { fetch });
    expect(calls.map((c) => c.url).sort()).toEqual([APIBAY_FILM, TORRENTIO_FILM, YTS_FILM].sort());
    expect(calls.every((c) => c.userAgent === TORRENT_INDEX_USER_AGENT)).toBe(true);
    expect(found.indexes.map((a) => [a.index, a.outcome, a.listed])).toEqual([
      ['torrentio', 'ok', 32],
      ['apibay', 'ok', 19],
      ['yts', 'ok', 3],
    ]);
    expect(found.candidates.map((c) => c.infoHash)).toEqual([
      'a779fa758f2229586eebc2e5960eb32fe5659596',
      'b9c4e2d4c0f43a5d1e8f7a6b5c4d3e2f1a0b9c8d',
      '43f4001de4ab25d521c63684e2b69804193ed9d9',
      '150922bce30a1091e347741ebbf96072593a69b4',
    ]);
    for (const c of found.candidates) {
      expect(c.infoHash).toMatch(/^[0-9a-f]{40}$/);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.seeds).toBeGreaterThanOrEqual(5);
      expect(c.sizeBytes).toBeGreaterThan(0);
    }
    expect(found.candidates[0]).toMatchObject({ listedBy: ['torrentio', 'yts'], fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4' });
    expect(found.candidates[0]?.release.direct).toBe(true);
    const mitzep = found.excluded.filter((e) => e.infoHash === 'afb2c3f4ee0901947219e69997e95cd7280ca2d7');
    expect(mitzep).toEqual([expect.objectContaining({ seeds: 1, reason: 'few_seeds' })]);
    expect(found.excluded.find((e) => e.infoHash === '3d0000000000000000000000000000000000ab3d')?.reason).toBe('three_d');
  });

  it('asks Torrentio, apibay and EZTV for an episode and keeps only that episode or a pack that holds it', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_EPISODE]: body(fixture('torrentio-series-bb-s01e01.json')),
      [APIBAY_SERIES]: body(fixture('apibay-empty.json')),
      [EZTV_SERIES]: body(fixture('eztv-page.json')),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch });
    expect(calls.some((c) => c.url.includes('yts'))).toBe(false);
    expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual([
      ['torrentio', 'ok'],
      ['apibay', 'empty'],
      ['eztv', 'empty'],
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
      [YTS_FILM]: body(NO_YTS),
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
      [YTS_FILM]: () => new Promise<Response>(() => {}),
    });
    const found = await findCandidates(SINTEL, { fetch, timeoutMs: 50 });
    expect(found.indexes).toEqual([
      expect.objectContaining({ index: 'torrentio', outcome: 'bot_check', listed: 0 }),
      expect.objectContaining({ index: 'apibay', outcome: 'ok', listed: 19 }),
      expect.objectContaining({ index: 'yts', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
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
    const asked: string[] = [];
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
    const seen: string[] = [];
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
