import type { ParsedName } from '../../../src/movies/parse.js';

/**
 * The real names on the owner's disk (2026-11-14), relative to a library root, and what
 * parseVideoPath must make of them. The spec of src/movies/parse.ts: the unit test and the phase 2
 * proof both run this table.
 */
export type FilenameShape =
  | 'pahe-dots'
  | 'pahe-underscores'
  | 'year-in-folder'
  | 'season-folder'
  | 'absolute'
  | 'two-films'
  | 'junk'
  | 'trap';

export interface FilenameCase {
  shape: FilenameShape;
  relPath: string;
  expected: Omit<ParsedName, 'fileName' | 'dirName'>;
}

function movie(title: string, year: number | null): FilenameCase['expected'] {
  return { title, year, season: null, episode: null, absoluteEpisode: null, kindHint: year === null ? null : 'movie' };
}

function episode(title: string, season: number, ep: number): FilenameCase['expected'] {
  return { title, year: null, season, episode: ep, absoluteEpisode: null, kindHint: 'tv' };
}

const MOBLAND_DIR = 'Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]';

export const FILENAME_CASES: readonly FilenameCase[] = [
  {
    shape: 'pahe-dots',
    relPath: 'How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
    expected: movie('How to Make a Killing', 2026),
  },
  {
    shape: 'pahe-dots',
    relPath: 'By Any Means 2026 1080p WEB-DL x265 6CH-Pahe.in.mkv',
    expected: movie('By Any Means', 2026),
  },
  {
    shape: 'pahe-underscores',
    relPath: 'The_Rivals_of_Amziah_King_2026_1080p_BluRay_x265_DD+5_1_Pahe_in.mkv',
    expected: movie('The Rivals of Amziah King', 2026),
  },
  { shape: 'year-in-folder', relPath: 'Pak Bernard/Oldboy (2003)/Oldboy.mkv', expected: movie('Oldboy', 2003) },
  {
    shape: 'year-in-folder',
    relPath: 'Pak Bernard/E.T. the Extra-Terrestrial (1982)/E.T. the Extra-Terrestrial.mkv',
    expected: movie('E.T. the Extra-Terrestrial', 1982),
  },
  {
    shape: 'year-in-folder',
    relPath: 'Pak Bernard/Batman - The Killing Joke (2016)/Batman - The Killing Joke.mkv',
    expected: movie('Batman - The Killing Joke', 2016),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/MobLand.S01E01.Stick.or.Twist.1080p.WEB-DL.x265.6CH-Pahe.in.mkv`,
    expected: episode('MobLand', 1, 1),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/MobLand.S01E05.Funeral.for.a.Friend.PROPER.1080p.WEB-DL.x265.6CH-Pahe.in.mkv`,
    expected: episode('MobLand', 1, 5),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/Mobland.S01E09.Beggars.Banquet.1080p.WEB-DL.x265.6CH-Pahe.in.mkv`,
    expected: episode('Mobland', 1, 9),
  },
  {
    shape: 'season-folder',
    relPath: `${MOBLAND_DIR}/MobLand.S01E02.Jigsaw.Puzzle.1080p.WEB-DL.x265.10Bit.6CH-Pahe.in.mkv`,
    expected: episode('MobLand', 1, 2),
  },
  {
    shape: 'season-folder',
    relPath: 'Person of Interest Season 1 x265 [Pahe.in]/Person.of.Interest.S01E01.Extended.720p.BluRay.x265.10Bit-Pahe.in.mkv',
    expected: episode('Person of Interest', 1, 1),
  },
  {
    shape: 'season-folder',
    relPath: 'Done/From S03 1080p x265 [Pahe.in]/From.S03E10.Revelations.Chapter.Two.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
    expected: episode('From', 3, 10),
  },
  {
    shape: 'absolute',
    relPath: 'Done/One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv',
    expected: { title: 'One Piece', year: null, season: null, episode: null, absoluteEpisode: 405, kindHint: 'tv' },
  },
  {
    shape: 'two-films',
    relPath: 'Done/Nezha (2019)/Ne.Zha.2019.1080p.UHD.BluRay.x265.HDR.DD5.1-Pahe.in.mkv',
    expected: movie('Ne Zha', 2019),
  },
  {
    shape: 'two-films',
    relPath: 'Done/Nezha (2019)/Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv',
    expected: movie('Ne Zha 2', 2025),
  },
  {
    shape: 'pahe-dots',
    relPath: 'Done/WALL-E.2008.1080p.UHD.BluRay.x265.HDR.DV.DD+5.1-Pahe.in.mkv',
    expected: movie('WALL-E', 2008),
  },
  {
    shape: 'pahe-dots',
    relPath: 'Done/Your.Eyes.Tell.2020.1080p.BluRay.x264.6CH-Pahe.in.mkv',
    expected: movie('Your Eyes Tell', 2020),
  },
  { shape: 'junk', relPath: 'Done/docker_es/VID-20220222-WA0011.mp4', expected: movie('VID-20220222-WA0011', null) },
  {
    shape: 'junk',
    relPath: 'Done/docker_es/s/Snapinsta_26084969_2014635765484161_3368348057538470914_n.mp4',
    expected: movie('Snapinsta 26084969 2014635765484161 3368348057538470914 n', null),
  },
  {
    shape: 'junk',
    relPath: 'Done/docker_es/WhatsApp Video 2021-11-21 at 08.58.22.mp4',
    expected: movie('WhatsApp Video 2021-11-21 at 08.58.22', null),
  },
  // Traps: a title that is a year, a folder that lends a year only to its own film, a season named only by the folder.
  { shape: 'trap', relPath: '1917.2019.1080p.BluRay.x265-Pahe.in.mkv', expected: movie('1917', 2019) },
  { shape: 'trap', relPath: 'Done/Nezha (2019)/Ne.Zha.2.mkv', expected: movie('Ne Zha 2', null) },
  { shape: 'trap', relPath: 'Done/Nezha (2019)/Nezha.mkv', expected: movie('Nezha', 2019) },
  {
    shape: 'trap',
    relPath: 'Person of Interest Season 1 x265 [Pahe.in]/Person.of.Interest.E04.720p.BluRay.x265.10Bit-Pahe.in.mkv',
    expected: episode('Person of Interest', 1, 4),
  },
  { shape: 'trap', relPath: `${MOBLAND_DIR}/S01E07.mkv`, expected: episode('Mobland', 1, 7) },
];
