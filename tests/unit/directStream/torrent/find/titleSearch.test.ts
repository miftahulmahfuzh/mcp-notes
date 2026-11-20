import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bitsearchIndex } from '../../../../../src/directStream/torrent/find/bitsearch.js';
import { candidateFrom } from '../../../../../src/directStream/torrent/find/candidate.js';
import { defaultIndexes, findCandidates, TORRENT_INDEX_USER_AGENT } from '../../../../../src/directStream/torrent/find/find.js';
import { knabenIndex } from '../../../../../src/directStream/torrent/find/knaben.js';
import { rankCandidates } from '../../../../../src/directStream/torrent/find/rank.js';
import { titleSearchAnswer, titleSearchExclusion, titleSearchText } from '../../../../../src/directStream/torrent/find/titleSearch.js';
import { torrentscsvIndex } from '../../../../../src/directStream/torrent/find/torrentscsv.js';
import type { FetchLike, IndexContext, TorrentIndex, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/torrent');
const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

const SHAWSHANK: TorrentQuery = { kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: 1994, originalLanguage: 'en' };
const DUNE: TorrentQuery = { kind: 'movie', imdbId: 'tt1160419', title: 'Dune', year: 2021, originalLanguage: 'en' };
const BREAKING_BAD: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', year: 2008, originalLanguage: 'en' };

const KNABEN = 'https://api.knaben.org/v1';
const BITSEARCH = (q: string): string => `https://bitsearch.to/api/v1/search?q=${encodeURIComponent(q)}&sort=seeders`;
const TCSV = (q: string): string => `https://torrents-csv.com/service/search?q=${encodeURIComponent(q)}&size=50`;
const TORRENTIO_SHAWSHANK = 'https://torrentio.strem.fun/stream/movie/tt0111161.json';
const APIBAY_SHAWSHANK = 'https://apibay.org/q.php?q=tt0111161';
const TITLE_INDEX_NAMES = ['knaben', 'bitsearch', 'torrentscsv'];
const E0D0 = 'e0d00667650aba9ee05aacbbbd8b55ea8a51f534';
const YIFY_STREAM = { name: 'Torrentio\n1080p', title: 'The Shawshank Redemption 1994 1080p BrRip\n👤 700 💾 1.6 GB ⚙️ ThePirateBay', infoHash: E0D0.toUpperCase(), behaviorHints: {} };

interface Call {
  url: string;
  method: string;
  userAgent: string | null;
  body: string | null;
}
type Route = () => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET', userAgent: init.headers.get('user-agent'), body: init.body ?? null });
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fetch failed: no route for ${url}`);
    return route();
  };
  return { fetch, calls };
}
const body = (text: string, status = 200, headers: Record<string, string> = {}): Route => () => new Response(text, { status, headers });
const json = (value: unknown): Route => body(JSON.stringify(value));
const hash = (n: number): string => n.toString(16).padStart(40, 'b');
const titleIndexes = (): TorrentIndex[] => defaultIndexes().filter((i) => TITLE_INDEX_NAMES.includes(i.name));
const knabenHit = (title: string, h: string, seeders = 40): Record<string, unknown> => ({
  hash: h.toUpperCase(),
  title,
  bytes: 600_000_000,
  seeders,
  magnetUrl: `magnet:?xt=urn:btih:${h}&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce`,
  tracker: 'The Pirate Bay',
});
const bitsearchResult = (title: string, h: string, seeders = 40): Record<string, unknown> => ({ infohash: h, title, size: 600_000_000, seeders });
const ctxAnswering = (answer: string): IndexContext => ({ signal: new AbortController().signal, fetch: async () => new Response(answer, { status: 200 }) });

describe('the title-search query', () => {
  it('asks a film by title and year, an episode by title and SxxEyy within its season, and nothing without a name or a film year', () => {
    expect(titleSearchText(SHAWSHANK)).toBe('The Shawshank Redemption 1994');
    expect(titleSearchText(BREAKING_BAD)).toBe('Breaking Bad S01E01');
    expect(titleSearchText({ kind: 'tv', imdbId: 'tt0388629', title: 'One Piece', season: 21, episode: 1000, absoluteEpisode: 1000, alt: { season: 21, episode: 109 } })).toBe('One Piece S21E109');
    expect(titleSearchText({ kind: 'movie', imdbId: 'tt0111161', title: null, originalTitle: null, year: 1994 })).toBeNull();
    expect(titleSearchText({ kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: null })).toBeNull();
  });
});

describe('the title-search fit', () => {
  it('keeps the title followed by the year (one either way), after a group or site prefix, and leaves out another title or year', () => {
    expect(titleSearchExclusion('The Shawshank Redemption (1994) 1080p BrRip - 1.6GB -YIFY', SHAWSHANK)).toBeNull();
    expect(titleSearchExclusion('www.UIndex.org    -    The Shawshank Redemption 1994 REPACK 1080p BluRay x265-YAWNTiC', SHAWSHANK)).toBeNull();
    expect(titleSearchExclusion('[YTS.MX] Shawshank Redemption 1995 720p', SHAWSHANK)).toBeNull();
    expect(titleSearchExclusion('Dune Extended 2021 2160p', DUNE)).toBeNull();
    expect(titleSearchExclusion('Dune 1984 1080p BluRay x264', DUNE)).toBe('other_year');
    expect(titleSearchExclusion('Dune 1080p WEB-DL', DUNE)).toBe('other_year');
    expect(titleSearchExclusion('Dune Part Two 2024 1080p WEB-DL', DUNE)).toBe('other_title');
    expect(titleSearchExclusion('Children of Dune 2003 720p', DUNE)).toBe('other_title');
  });

  it('keeps a series title followed by its season or episode marker, and leaves out another show that starts with the same words', () => {
    expect(titleSearchExclusion('Breaking.Bad.S01E01.720p.HDTV.x264', BREAKING_BAD)).toBeNull();
    expect(titleSearchExclusion('Breaking Bad (2008) Season 1 Complete 1080p', BREAKING_BAD)).toBeNull();
    expect(titleSearchExclusion('Breaking Bad Insider Podcast S01E01', BREAKING_BAD)).toBe('other_title');
    expect(titleSearchExclusion('Breaking Bad 720p', BREAKING_BAD)).toBe('other_title');
  });

  it('applies only while no index asked by IMDb id lists the same torrent', () => {
    const wrongYear = { infoHash: hash(1), name: 'Dune 1984 1080p BluRay x264', seeds: 50, sizeBytes: 600_000_000 };
    const byTitle = titleSearchAnswer([wrongYear], 'bitsearch', DUNE).candidates;
    expect(rankCandidates(byTitle, DUNE).excluded.map((e) => e.reason)).toEqual(['other_year']);
    const both = rankCandidates([...byTitle, candidateFrom(wrongYear, 'torrentio', DUNE)], DUNE);
    expect(both.kept.map((c) => [c.infoHash, c.listedBy, c.titleSearch])).toEqual([[hash(1), ['bitsearch', 'torrentio'], undefined]]);
  });
});

describe('the title-search indexes', () => {
  it('asks Knaben, Bitsearch and torrents-csv by title side by side with the IMDb-keyed indexes, one attempt each, joined by info hash', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_SHAWSHANK]: json({ streams: [YIFY_STREAM] }),
      [APIBAY_SHAWSHANK]: body('[]'),
      [KNABEN]: body(fixture('knaben-shawshank.json')),
      [BITSEARCH('The Shawshank Redemption 1994')]: body(fixture('bitsearch-shawshank.json')),
      [TCSV('The Shawshank Redemption 1994')]: body(fixture('torrentscsv-shawshank.json')),
    });
    const found = await findCandidates(SHAWSHANK, { fetch });
    const names = found.indexes.map((a) => a.index);
    expect(new Set(names).size).toBe(names.length);
    expect(found.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 'torrentio', outcome: 'ok', listed: 1 }),
        expect.objectContaining({ index: 'knaben', outcome: 'ok', listed: 3 }),
        expect.objectContaining({ index: 'bitsearch', outcome: 'ok', listed: 3 }),
        expect.objectContaining({ index: 'torrentscsv', outcome: 'ok', listed: 3 }),
      ]),
    );
    const knaben = calls.filter((c) => c.url === KNABEN);
    expect(knaben).toHaveLength(1);
    expect(knaben[0]?.method).toBe('POST');
    expect(JSON.parse(knaben[0]?.body ?? '{}')).toMatchObject({ search_field: 'title', query: 'The Shawshank Redemption 1994', order_by: 'seeders' });
    expect(calls.every((c) => c.userAgent === TORRENT_INDEX_USER_AGENT)).toBe(true);
    expect(found.candidates.map((c) => c.infoHash).sort()).toEqual(
      ['9d03cb643f0a22c2aa7cf5479da2b81d19300362', 'b111a115d5d68e7ccbe10f1c160e64ffb702f15a', 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6', 'de45655f107904526620d21c3856ac29a5fd7e49', E0D0].sort(),
    );
    const yify = found.candidates.find((c) => c.infoHash === E0D0);
    expect([...(yify?.listedBy ?? [])].sort()).toEqual(['bitsearch', 'knaben', 'torrentio', 'torrentscsv']);
    expect(yify?.trackers).toEqual(expect.arrayContaining(['udp://vito-tracker.space:6969/announce']));
  });

  it('asks an episode by title and SxxEyy and keeps only that episode or its season pack', async () => {
    const { fetch, calls } = fakeFetch({
      [KNABEN]: json({
        hits: [
          knabenHit('Breaking.Bad.S01E01.720p.HDTV.x264', hash(1)),
          knabenHit('Breaking.Bad.S01E02.720p.HDTV.x264', hash(2), 90),
          knabenHit('Breaking Bad Season 1 Complete 1080p BluRay x264', hash(3)),
          knabenHit('Breaking Bad Insider Podcast S01E01', hash(4)),
        ],
        total: { relation: 'eq', value: 4 },
      }),
      [BITSEARCH('Breaking Bad S01E01')]: json({ success: true, results: [] }),
      [TCSV('Breaking Bad S01E01')]: json({ torrents: [] }),
    });
    const found = await findCandidates(BREAKING_BAD, { fetch, indexes: titleIndexes() });
    expect(JSON.parse(calls.find((c) => c.url === KNABEN)?.body ?? '{}')).toMatchObject({ query: 'Breaking Bad S01E01' });
    expect(found.candidates.map((c) => c.infoHash).sort()).toEqual([hash(1), hash(3)].sort());
    expect(Object.fromEntries(found.excluded.map((e) => [e.infoHash, e.reason]))).toEqual({ [hash(2)]: 'other_episode', [hash(4)]: 'other_title' });
  });

  it('sends no request by title for a title with no name or a film with no year', async () => {
    const { fetch, calls } = fakeFetch({});
    const noName = await findCandidates({ kind: 'movie', imdbId: 'tt0111161', title: null, originalTitle: null, year: 1994 }, { fetch, indexes: titleIndexes() });
    const noYear = await findCandidates({ kind: 'movie', imdbId: 'tt0111161', title: 'The Shawshank Redemption', year: null }, { fetch, indexes: titleIndexes() });
    expect(calls).toEqual([]);
    for (const found of [noName, noYear]) {
      expect(found.indexes.map((a) => [a.index, a.outcome])).toEqual(TITLE_INDEX_NAMES.map((n) => [n, 'empty']));
      expect(found.indexes.every((a) => a.detail.startsWith('not asked'))).toBe(true);
    }
  });

  it('leaves out another title and another year of a film by name, with the reason, and never offers them', async () => {
    const { fetch } = fakeFetch({
      [KNABEN]: json({ hits: [] }),
      [BITSEARCH('Dune 2021')]: json({
        success: true,
        results: [
          bitsearchResult('Dune.2021.1080p.WEB-DL.x264', hash(1)),
          bitsearchResult('Dune 1984 1080p BluRay x264', hash(2), 400),
          bitsearchResult('Dune Part Two 2024 1080p WEB-DL', hash(3), 900),
          bitsearchResult('Dune 1984 1080p BluRay Hindi Dubbed', hash(4), 300),
        ],
      }),
      [TCSV('Dune 2021')]: json({ torrents: [] }),
    });
    const found = await findCandidates(DUNE, { fetch, indexes: titleIndexes() });
    expect(found.candidates.map((c) => c.infoHash)).toEqual([hash(1)]);
    expect(found.lastResort).toEqual([]);
    expect(Object.fromEntries(found.excluded.map((e) => [e.infoHash, e.reason]))).toEqual({ [hash(2)]: 'other_year', [hash(3)]: 'other_title', [hash(4)]: 'other_year' });
  });

  it('records a bot check, a timeout and a failure per title-search index, asks each once as notesd, and still answers the others', async () => {
    const { fetch, calls } = fakeFetch({
      [TORRENTIO_SHAWSHANK]: json({ streams: [YIFY_STREAM] }),
      [APIBAY_SHAWSHANK]: body('[]'),
      [KNABEN]: body(fixture('cloudflare-challenge.html'), 403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }),
      [BITSEARCH('The Shawshank Redemption 1994')]: () => new Promise<Response>(() => {}),
      [TCSV('The Shawshank Redemption 1994')]: body('', 500),
    });
    const found = await findCandidates(SHAWSHANK, { fetch, timeoutMs: 50 });
    expect(found.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 'knaben', outcome: 'bot_check', listed: 0 }),
        expect.objectContaining({ index: 'bitsearch', outcome: 'error', detail: expect.stringMatching(/^timed out after /), listed: 0 }),
        expect.objectContaining({ index: 'torrentscsv', outcome: 'error', detail: 'HTTP 500', listed: 0 }),
      ]),
    );
    expect(found.candidates.map((c) => c.infoHash)).toEqual([E0D0]);
    const knaben = calls.filter((c) => c.url === KNABEN);
    expect(knaben).toHaveLength(1);
    expect(knaben[0]?.userAgent).toBe(TORRENT_INDEX_USER_AGENT);
  });

  it('reads each index on its own: the recorded answers and the error shapes', async () => {
    expect((await knabenIndex('https://k.example/').find(SHAWSHANK, ctxAnswering(fixture('knaben-shawshank.json')))).candidates.map((c) => c.site)).toEqual(['The Pirate Bay', 'The Pirate Bay', 'The Pirate Bay']);
    expect((await bitsearchIndex('https://b.example').find(SHAWSHANK, ctxAnswering(fixture('bitsearch-shawshank.json')))).candidates.every((c) => c.titleSearch === true && c.index === 'bitsearch')).toBe(true);
    expect((await torrentscsvIndex('https://t.example').find(SHAWSHANK, ctxAnswering(fixture('torrentscsv-shawshank.json')))).candidates.map((c) => c.seeds)).toEqual([627, 187, 153]);
    expect((await bitsearchIndex('https://b.example').find(SHAWSHANK, ctxAnswering('{"success":false}'))).outcome).toBe('error');
    expect((await knabenIndex('https://k.example').find(SHAWSHANK, ctxAnswering('{}'))).outcome).toBe('error');
    expect((await torrentscsvIndex('https://t.example').find(SHAWSHANK, ctxAnswering('{"torrents":[]}'))).outcome).toBe('empty');
  });
});
