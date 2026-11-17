import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { candidateFrom } from '../../../../../src/directStream/torrent/find/candidate.js';
import { rankCandidates } from '../../../../../src/directStream/torrent/find/rank.js';
import type { IndexRow, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const FILM: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587', title: 'Sintel', originalLanguage: 'en' };
const EPISODE: TorrentQuery = { kind: 'tv', imdbId: 'tt0903747', season: 1, episode: 1, title: 'Breaking Bad', originalLanguage: 'en' };
const MB = 1024 * 1024;
const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex');
function row(name: string, seeds: number, extra: Partial<IndexRow> = {}): IndexRow {
  return { infoHash: hashOf(name), name, seeds, sizeBytes: 500 * MB, ...extra };
}

describe('rankCandidates', () => {
  it('never keeps a candidate under the seed floor', () => {
    const four = candidateFrom(row('Sintel.2010.1080p.WEB.H264-FOUR', 4), 'apibay', FILM);
    const five = candidateFrom(row('Sintel.2010.1080p.WEB.H264-FIVE', 5), 'apibay', FILM);
    const ranked = rankCandidates([four, five], FILM);
    expect(ranked.kept.map((c) => c.name)).toEqual(['Sintel.2010.1080p.WEB.H264-FIVE']);
    expect(ranked.excluded).toEqual([{ infoHash: four.infoHash, name: four.name, index: 'apibay', seeds: 4, reason: 'few_seeds' }]);
    expect(rankCandidates([four, five], FILM, { minSeeds: 0, goodSeeds: 20, maxSizeBytes: 25 * 1024 ** 3 }).kept).toHaveLength(2);
  });

  it('orders a direct release first, then well seeded, then 1080p > 720p > 2160p > 480p, then more seeds', () => {
    const rows = [
      row('Sintel.2010.2160p.WEB.x265-A', 900),
      row('Sintel.2010.1080p.WEB.x264-B', 30),
      row('Sintel.2010.720p.WEB.x264.AAC-C', 6, { fileName: 'Sintel.2010.720p.WEB.x264.AAC-C.mp4' }),
      row('Sintel.2010.1080p.WEB.x264.AAC-D', 8, { fileName: 'Sintel.2010.1080p.WEB.x264.AAC-D.mp4' }),
      row('Sintel.2010.720p.WEB.x264-E', 300),
      row('Sintel.2010.1080p.WEB.x264-F', 31),
      row('Sintel.2010.480p.WEB.x264-G', 25),
    ];
    const ranked = rankCandidates(
      rows.map((r) => candidateFrom(r, 'apibay', FILM)),
      FILM,
    );
    expect(ranked.kept.map((c) => c.name.slice(-1))).toEqual(['D', 'C', 'F', 'B', 'E', 'A', 'G']);
  });

  it('joins one torrent listed by several indexes into one candidate with the most seeds', () => {
    const hash = hashOf('shared');
    const fromTorrentio = candidateFrom(
      row('Sintel 2010 720p BluRay', 30, { infoHash: hash.toUpperCase(), fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4', fileIdx: 0, trackers: ['udp://a.example:1/announce'] }),
      'torrentio',
      FILM,
    );
    const fromYts = candidateFrom(row('Sintel (2010) [720p] [bluray] [x264] [YTS]', 41, { infoHash: hash, trackers: ['udp://b.example:1/announce'] }), 'yts', FILM);
    const ranked = rankCandidates([fromTorrentio, fromYts], FILM);
    expect(ranked.kept).toHaveLength(1);
    expect(ranked.kept[0]).toMatchObject({ infoHash: hash, seeds: 41, index: 'torrentio', listedBy: ['torrentio', 'yts'], fileName: 'Sintel.2010.720p.BluRay.x264.AAC-[YTS.MX].mp4', fileIdx: 0 });
    expect(ranked.kept[0]?.trackers).toEqual(expect.arrayContaining(['udp://a.example:1/announce', 'udp://b.example:1/announce']));
  });

  it('leaves out a single file over the size ceiling, never a pack for it', () => {
    const single = candidateFrom(row('Breaking.Bad.S01E01.2160p.REMUX', 50, { sizeBytes: 30 * 1024 ** 3 }), 'apibay', EPISODE);
    const pack = candidateFrom(row('Breaking.Bad.S01-S05.2160p.REMUX', 50, { sizeBytes: 600 * 1024 ** 3 }), 'apibay', EPISODE);
    const ranked = rankCandidates([single, pack], EPISODE);
    expect(ranked.kept.map((c) => c.infoHash)).toEqual([pack.infoHash]);
    expect(ranked.excluded.map((e) => e.reason)).toEqual(['too_big']);
  });

  it('offers a dub-named release that otherwise fits as a last resort, but not one left out for another reason', () => {
    const proper = candidateFrom(row('Sintel.2010.1080p.WEB-DL.x264', 40), 'torrentio', FILM);
    const dub = candidateFrom(row('Sintel.2010.1080p.Hindi.Dubbed.WEB-DL', 30), 'torrentio', FILM);
    const dubFewSeeds = candidateFrom(row('Sintel.2010.720p.Hindi.Dubbed.WEB-DL', 0), 'torrentio', FILM);
    const otherTitle = candidateFrom(row('Tangled.2010.1080p.Hindi.Dubbed', 50), 'torrentio', FILM);
    const ranked = rankCandidates([proper, dub, dubFewSeeds, otherTitle], FILM);
    expect(ranked.kept.map((c) => c.name)).toEqual(['Sintel.2010.1080p.WEB-DL.x264']);
    // Only the dub that otherwise passes (right title, enough seeds) is a last resort; the thin one and the wrong title are not.
    expect(ranked.lastResort.map((c) => c.name)).toEqual(['Sintel.2010.1080p.Hindi.Dubbed.WEB-DL']);
    expect(ranked.excluded.map((e) => e.reason).sort()).toEqual(['dubbed', 'dubbed', 'other_title']);
  });

  it('leaves out a malformed or all-zero info hash and a release of another title', () => {
    const zero = candidateFrom(row('Sintel.2010.1080p.WEB', 50, { infoHash: '0'.repeat(40) }), 'apibay', FILM);
    const short = candidateFrom(row('Sintel.2010.720p.WEB', 50, { infoHash: 'abc123' }), 'apibay', FILM);
    const other = candidateFrom(row('Breaking.In.S01E01.Pilot.1080p', 50), 'torrentio', EPISODE, true);
    expect(rankCandidates([zero, short], FILM).excluded.map((e) => e.reason)).toEqual(['bad_hash', 'bad_hash']);
    expect(rankCandidates([other], EPISODE).excluded.map((e) => e.reason)).toEqual(['other_title']);
  });
});
