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

  it('orders well seeded first, then 1080p > 720p > 2160p > 480p, then a release Chrome plays as is, then more seeds', () => {
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
    expect(ranked.kept.map((c) => c.name.slice(-1))).toEqual(['F', 'B', 'E', 'A', 'G', 'D', 'C']);
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

  it('offers a dub-named release that otherwise fits as a last resort, down to a thin swarm but not a dead one', () => {
    const proper = candidateFrom(row('Sintel.2010.1080p.WEB-DL.x264', 40), 'torrentio', FILM);
    const dub = candidateFrom(row('Sintel.2010.1080p.Hindi.Dubbed.WEB-DL', 30), 'torrentio', FILM);
    // Below the normal seed floor (5) but alive: a last resort, since in that tier there is nothing better.
    const dubThin = candidateFrom(row('Sintel.2010.720p.Hindi.Dubbed.WEB-DL', 3), 'torrentio', FILM);
    // A dead swarm (0 seeds) is never a last resort.
    const dubDead = candidateFrom(row('Sintel.2010.480p.Hindi.Dubbed.WEB-DL', 0), 'torrentio', FILM);
    const otherTitle = candidateFrom(row('Tangled.2010.1080p.Hindi.Dubbed', 50), 'torrentio', FILM);
    const ranked = rankCandidates([proper, dub, dubThin, dubDead, otherTitle], FILM);
    expect(ranked.kept.map((c) => c.name)).toEqual(['Sintel.2010.1080p.WEB-DL.x264']);
    // Both the well- and thin-seeded dubs are last resorts (best first); the dead one and the wrong title are not.
    expect(ranked.lastResort.map((c) => c.name)).toEqual(['Sintel.2010.1080p.Hindi.Dubbed.WEB-DL', 'Sintel.2010.720p.Hindi.Dubbed.WEB-DL']);
    expect(ranked.excluded.map((e) => e.reason).sort()).toEqual(['dubbed', 'dubbed', 'dubbed', 'other_title']);
  });

  it('leaves out a release named as a program or an archive (a fake), whatever its seeds', () => {
    const fake = candidateFrom(row('Breaking Bad S01E01 Pilot 1080p WEB H264-FLUX.exe', 900), 'torrentio', EPISODE, true);
    const fakeFile = candidateFrom(row('Breaking Bad S01E01 1080p WEB H264-GRP', 800, { fileName: 'Breaking.Bad.S01E01.1080p.mkv.scr' }), 'torrentio', EPISODE, true);
    const zipped = candidateFrom(row('Sintel 2010 1080p BluRay.rar', 700), 'apibay', FILM);
    const site = candidateFrom(row('Sintel 2010 1080p BluRay x264 - www.example.com', 700), 'apibay', FILM);
    expect(rankCandidates([site], FILM).kept).toHaveLength(1);
    const real = candidateFrom(row('Breaking.Bad.S01E01.1080p.WEB.H264-REAL', 12), 'torrentio', EPISODE, true);
    const ranked = rankCandidates([fake, fakeFile, real], EPISODE);
    expect(ranked.kept.map((c) => c.name)).toEqual([real.name]);
    expect(ranked.excluded.map((x) => x.reason)).toEqual(['not_video', 'not_video']);
    expect(rankCandidates([zipped], FILM).excluded.map((x) => x.reason)).toEqual(['not_video']);
    // A group tag that only looks like an extension in the middle of a name is not one.
    expect(rankCandidates([candidateFrom(row('Sintel.2010.1080p.WEB.x264-EXE.GROUP', 30), 'apibay', FILM)], FILM).kept).toHaveLength(1);
  });

  it('leaves out a trailer, a teaser and a sample, but not a title that holds the word', () => {
    const names = ['sintel-2010-trailer-1-4k-uhd-lossless', 'Sintel_IMAX_TLR-1_3840x2160_HEVC', 'Sintel 2010 Teaser 1080p', 'Sintel.2010.1080p.WEB.x264-GRP.sample'];
    const ranked = rankCandidates(names.map((n) => candidateFrom(row(n, 50), 'bitsearch', FILM)), FILM);
    expect(ranked.kept).toEqual([]);
    expect(ranked.excluded.map((x) => x.reason)).toEqual(['trailer', 'trailer', 'trailer', 'trailer']);
    const byFile = candidateFrom(row('Sintel (2010)', 50, { fileName: 'Sintel-Trailer.mkv' }), 'torrentio', FILM);
    expect(rankCandidates([byFile], FILM).excluded.map((x) => x.reason)).toEqual(['trailer']);
    const PARK: TorrentQuery = { kind: 'movie', imdbId: 'tt1343727', title: 'Trailer Park Boys: The Movie', originalLanguage: 'en' };
    expect(rankCandidates([candidateFrom(row('Trailer.Park.Boys.The.Movie.2006.1080p.BluRay.x264', 40), 'apibay', PARK)], PARK).kept).toHaveLength(1);
    // "Sampler" and "Teaserama" are words of their own, not the marker.
    expect(rankCandidates([candidateFrom(row('Sintel.2010.Samplerip.1080p.WEB.x264', 40), 'apibay', FILM)], FILM).kept).toHaveLength(1);
  });

  it('leaves out a malformed or all-zero info hash and a release of another title', () => {
    const zero = candidateFrom(row('Sintel.2010.1080p.WEB', 50, { infoHash: '0'.repeat(40) }), 'apibay', FILM);
    const short = candidateFrom(row('Sintel.2010.720p.WEB', 50, { infoHash: 'abc123' }), 'apibay', FILM);
    const other = candidateFrom(row('Breaking.In.S01E01.Pilot.1080p', 50), 'torrentio', EPISODE, true);
    expect(rankCandidates([zero, short], FILM).excluded.map((e) => e.reason)).toEqual(['bad_hash', 'bad_hash']);
    expect(rankCandidates([other], EPISODE).excluded.map((e) => e.reason)).toEqual(['other_title']);
  });
});
