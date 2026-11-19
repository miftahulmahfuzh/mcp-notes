import { describe, expect, it } from 'vitest';
import { pickFile } from '../../../../../src/directStream/torrent/find/pickFile.js';
import type { TorrentFileLike, TorrentQuery } from '../../../../../src/directStream/torrent/find/types.js';

const MB = 1024 * 1024;
const FILM: TorrentQuery = { kind: 'movie', imdbId: 'tt1727587' };
function episode(season: number, ep: number, absoluteEpisode: number | null = null): TorrentQuery {
  return { kind: 'tv', imdbId: 'tt0903747', season, episode: ep, absoluteEpisode };
}
function files(...entries: Array<[string, number]>): TorrentFileLike[] {
  return entries.map(([path, length], index) => ({ index, path, length }));
}

describe('pickFile', () => {
  it("picks a film's largest video and the subtitles beside it or in Subs, never a sample or a trailer", () => {
    const list = files(
      ['Sintel (2010)/Sintel.2010.720p.mp4', 140 * MB],
      ['Sintel (2010)/Sample/sample.mp4', 60 * MB],
      ['Sintel (2010)/Sintel.Trailer.mp4', 200 * MB],
      ['Sintel (2010)/Subs/English.srt', 1],
      ['Sintel (2010)/Sintel.2010.720p.en.srt', 1],
      ['Sintel (2010)/WWW.YTS.MX.jpg', 1],
      ['Sintel (2010)/Other/notes.srt', 1],
    );
    expect(pickFile(list, FILM)).toEqual({ video: 0, subtitles: [3, 4] });
  });

  it('plays a lone small video', () => {
    expect(pickFile(files(['Short/Short.2019.mkv', 30 * MB]), FILM)).toEqual({ video: 0, subtitles: [] });
  });

  it("picks the episode inside a multi-season pack and only that episode's subtitles", () => {
    const root = 'Breaking Bad (2008) Season 1-5 S01-S05 (1080p BluRay x265 HEVC 10bit AAC 5.1 Silence) [QxR]';
    const list = files(
      [`${root}/Season 1/Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).mkv`, 900 * MB],
      [`${root}/Season 1/Breaking Bad (2008) - S01E02 - Cat's in the Bag (1080p BluRay x265 Silence).mkv`, 800 * MB],
      [`${root}/Season 2/Breaking Bad (2008) - S02E02 - Grilled (1080p BluRay x265 Silence).mkv`, 850 * MB],
      [`${root}/Season 1/Breaking Bad (2008) - S01E02 - Cat's in the Bag (1080p BluRay x265 Silence).en.srt`, 1],
      [`${root}/Season 1/Breaking Bad (2008) - S01E01 - Pilot (1080p BluRay x265 Silence).en.srt`, 1],
      [`${root}/Featurettes/Breaking Bad S01E02 Inside.mkv`, 300 * MB],
    );
    expect(pickFile(list, episode(1, 2))).toEqual({ video: 1, subtitles: [3] });
  });

  it('reads Subs folders named after the episode file', () => {
    const list = files(
      ['Show.S01.1080p/Show.S01E01.1080p.mkv', 900 * MB],
      ['Show.S01.1080p/Show.S01E02.1080p.mkv', 900 * MB],
      ['Show.S01.1080p/Subs/Show.S01E02.1080p/2_English.srt', 1],
      ['Show.S01.1080p/Subs/Show.S01E01.1080p/2_English.srt', 1],
    );
    expect(pickFile(list, episode(1, 2))).toEqual({ video: 1, subtitles: [2] });
  });

  it('reads "Ep 02" under a season folder, 1x02, and an anime\'s absolute number', () => {
    expect(pickFile(files(['Breaking Bad S01/Ep 01 - Pilot.mkv', 700 * MB], ['Breaking Bad S01/Ep 02 - Cat in the Bag.mkv', 700 * MB]), episode(1, 2))?.video).toBe(1);
    expect(pickFile(files(['BB/BB 1x01 Pilot.mkv', 700 * MB], ['BB/BB 1x02 Cat.mkv', 700 * MB]), episode(1, 2))?.video).toBe(1);
    const anime = files(['One Piece/[SubsPlease] One Piece - 1070 (1080p).mkv', 1400 * MB], ['One Piece/[SubsPlease] One Piece - 1071 (1080p).mkv', 1400 * MB]);
    expect(pickFile(anime, episode(21, 179, 1071))).toEqual({ video: 1, subtitles: [] });
  });

  it("picks a first season's bare-numbered file, as fansub packs name them, when exactly one file names the number", () => {
    const pack = (name: (n: string) => string): TorrentFileLike[] => files(...Array.from({ length: 28 }, (_, i): [string, number] => [`Pack/${name(String(i + 1).padStart(2, '0'))}`, 1400 * MB]));
    for (const name of [(n: string) => `Frieren - Beyond Journey's End ${n}.mkv`, (n: string) => `Sousou no Frieren ${n}.mkv`, (n: string) => `[SubsPlease] Sousou no Frieren - ${n} [WEB-DL 1080p x264 DDP].mkv`]) {
      expect(pickFile(pack(name), episode(1, 14))?.video).toBe(13);
      expect(pickFile(pack(name), episode(1, 1))?.video).toBe(0);
      // The pack does not hold episode 40.
      expect(pickFile(pack(name), episode(1, 40))).toBeNull();
    }
    // Not for a later season: there a bare number is the running one, which this query does not know.
    expect(pickFile(pack((n) => `Show ${n}.mkv`), episode(2, 14))).toBeNull();
    // Not when the number is in every name ("5.1" sound): nothing says which file is episode 5.
    expect(pickFile(pack((n) => `Show ${n} [DD 5.1].mkv`), episode(1, 5))).toBeNull();
    // A name with a marker still wins over a bare number elsewhere in the pack.
    expect(pickFile(files(['P/Show 14.mkv', 900 * MB], ['P/Show S01E14.mkv', 800 * MB]), episode(1, 14))?.video).toBe(1);
  });

  it('answers null when the torrent does not hold the episode', () => {
    expect(pickFile(files(['Show S01/Show.S01E01.mkv', 700 * MB], ['Show S01/Show.S01E02.mkv', 700 * MB]), episode(1, 5))).toBeNull();
    expect(pickFile(files(['Breaking.Bad.S01E02.720p.mkv', 400 * MB]), episode(1, 1))).toBeNull();
    expect(pickFile(files(['Film/sample.mkv', 30 * MB]), FILM)).toBeNull();
    expect(pickFile(files(['Breaking.Bad.S01E01.720p.mkv', 400 * MB], ['Breaking.Bad.S01E01.720p.srt', 1]), episode(1, 1))).toEqual({ video: 0, subtitles: [1] });
  });
});

describe('pickFile with an episode numbered two ways', () => {
  // One Piece: TMDB's season 21, episode 1000 is the 109th of that season.
  const query: TorrentQuery = { kind: 'tv', imdbId: 'tt0388629', season: 21, episode: 1000, absoluteEpisode: 1000, alt: { season: 21, episode: 109 } };

  it('finds the file by its number within the season when the name says the season', () => {
    const list = files(['One Piece S21/One.Piece.S21E108.mkv', 300 * MB], ['One Piece S21/One.Piece.S21E109.mkv', 300 * MB], ['One Piece S21/One.Piece.S21E110.mkv', 300 * MB]);
    expect(pickFile(list, query)?.video).toBe(1);
  });

  it('finds the file by the running number when the name says no season, and never takes that number for the one within the season', () => {
    const list = files(['One Piece/One Piece - 0109.mkv', 300 * MB], ['One Piece/One Piece - 1000.mkv', 300 * MB]);
    expect(pickFile(list, query)?.video).toBe(1);
  });
});
