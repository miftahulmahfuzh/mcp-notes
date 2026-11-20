import { describe, expect, it } from 'vitest';
import { parseTorrentFinder } from '../../../../../src/config.js';
import { findCandidates } from '../../../../../src/directStream/torrent/find/find.js';
import type { FetchLike, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';
import { indexesOf } from '../../../../../src/directStream/torrent/source.js';

const PAN: TorrentQuery = { kind: 'movie', imdbId: 'tt0457430', title: "Pan's Labyrinth", originalTitle: 'El laberinto del fauno', year: 2006, originalLanguage: 'es' };

function recording(): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return new Response('{"streams":[]}', { status: 200 });
  };
  return { fetch, urls };
}

describe('the Stremio add-on providers and their address settings', () => {
  it('are among the default indexes, in the order they are asked', () => {
    expect(indexesOf(parseTorrentFinder({})).map((i) => i.name)).toEqual(['torrentio', 'apibay', 'eztv', 'torrentsdb', 'peerflix', 'knaben', 'bitsearch', 'torrentscsv']);
  });

  it('are asked at the addresses the settings give', async () => {
    const finder = parseTorrentFinder({ NOTESD_TORRENT_TORRENTSDB_URL: 'http://127.0.0.1:4601/', NOTESD_TORRENT_PEERFLIX_URL: 'http://127.0.0.1:4602' });
    expect(finder.indexes).toEqual({ torrentsdb: 'http://127.0.0.1:4601', peerflix: 'http://127.0.0.1:4602' });
    const { fetch, urls } = recording();
    await findCandidates(PAN, { fetch, indexes: indexesOf(finder) });
    expect(urls).toEqual(expect.arrayContaining(['http://127.0.0.1:4601/stream/movie/tt0457430.json', 'http://127.0.0.1:4602/stream/movie/tt0457430.json']));
  });

  it('get no request when set off, even for a title made in Spanish', async () => {
    const finder = parseTorrentFinder({ NOTESD_TORRENT_TORRENTSDB_URL: 'off', NOTESD_TORRENT_PEERFLIX_URL: 'OFF' });
    expect(finder.indexes).toEqual({ torrentsdb: null, peerflix: null });
    const indexes = indexesOf(finder);
    expect(indexes.map((i) => i.name)).toEqual(['torrentio', 'apibay', 'eztv', 'knaben', 'bitsearch', 'torrentscsv']);
    const { fetch, urls } = recording();
    const found = await findCandidates(PAN, { fetch, indexes });
    expect(urls.filter((u) => u.includes('torrentsdb') || u.includes('peerflix'))).toEqual([]);
    expect(found.indexes.map((a) => a.index)).toEqual(['torrentio', 'apibay', 'knaben', 'bitsearch', 'torrentscsv']);
  });
});
