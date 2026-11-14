/**
 * Video file names -> what to look up on TMDB. Pure string work: no fs, no network, never throws.
 *
 * The input is a path relative to a library root, `/` or `\` separated
 * ("Done/Nezha (2019)/Ne.Zha.2.2025.1080p.WEB-DL.x265.6CH-Pahe.in.mkv"). Only the file name and its
 * parent folder are read, so a folder above them (a done folder such as "Done", a collection such
 * as "Pak Bernard") is never part of the title. The parent folder only lends what the file name
 * lacks:
 * - its title, when the file name has none ("Mobland S01 .../S01E07.mkv");
 * - its year, when it names the same film ("Oldboy (2003)/Oldboy.mkv"). A folder that holds two
 *   films ("Nezha (2019)/Ne.Zha.2.2025...") lends nothing: the file carries its own year, or its
 *   title differs from the folder's;
 * - its season ("Person of Interest Season 1 .../Person.of.Interest.E04...").
 *
 * The six shapes on disk: Pahe dots, Pahe spaces/underscores, year only in the folder, SxxEyy in a
 * season folder, absolute numbering ("One Piece - 405 720p ..."), two films in one folder. The
 * table in tests/fixtures/movies/filenames.ts is the spec.
 */

export const VIDEO_EXTENSIONS: readonly string[] = ['mkv', 'mp4', 'avi', 'm4v', 'webm'];

/** What the name says the file is: a film, an episode, or no clue. */
export type KindHint = 'movie' | 'tv' | null;

export interface ParsedName {
  /** Readable title, release tags removed ("Ne Zha 2", "E.T. the Extra-Terrestrial"); '' when nothing is left. */
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** "One Piece - 405": the episode counted from the first, no season. */
  absoluteEpisode: number | null;
  kindHint: KindHint;
  /** The file's base name, extension included: the Haiku fallback's input. */
  fileName: string;
  /** The parent folder's name; null for a file directly under the root. */
  dirName: string | null;
}

const MIN_YEAR = 1900;
/** A 4-digit token above this is not a year ("Blade Runner 2049" without its own year stays whole). */
const MAX_YEAR = new Date().getFullYear() + 1;

const BRACKETED = /\[[^\]]*\]|\{[^}]*\}/g;
const RELEASE_GROUP_SUFFIX = /[-_. ]+pahe[._ ]in$/i;
const SXXEYY = /^s(\d{1,2})e(\d{1,4})(?:-?e\d{1,4})*$/i;
const SEASON_TOKEN = /^s(\d{1,2})$/i;
const SEASON_WORD = /^season$/i;
const EPISODE_TOKEN = /^ep?(\d{1,4})$/i;
const YEAR_TOKEN = /^\(?(\d{4})\)?$/;
const NUMBER_TOKEN = /^\d{1,4}$/;
const DASH_TOKEN = /^[-–—]$/;
const PUNCT_TOKEN = /^[-–—:,.+]+$/;
/** Release tags: resolution, source, codec, bit depth, audio. Never title words, so the title ends before the first one. */
const QUALITY_TOKEN =
  /^(?:\d{3,4}[pi]|4k|uhd|hdr(?:10)?\+?|dv|dovi|web-?dl|web-?rip|blu-?ray|bdrip|brrip|dvdrip|hdtv|hdrip|remux|x26[45]|h\.?26[45]|hevc|avc|xvid|\d{1,2}-?bit|\d(?:\.\d)?ch|aac(?:\d(?:\.\d)?)?|e?ac-?3|ddp?\+?(?:\d(?:\.\d)?)?|atmos|truehd|dts(?:-?hd)?)$/i;

export function isVideoFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return false;
  return VIDEO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** Lower case, accents and punctuation gone, single spaces: "WALL·E" and "WALL-E" both give "wall e". */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** normalizeTitle without spaces: "Nezha" and "Ne Zha" are the same film. */
export function compactTitle(text: string): string {
  return normalizeTitle(text).replace(/ /g, '');
}

interface SegmentParse {
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** "E04" / "EP04" with no season in this segment: an episode when the folder names a season, else absolute. */
  bareEpisode: number | null;
  absoluteEpisode: number | null;
}

function yearOfToken(token: string): number | null {
  const m = YEAR_TOKEN.exec(token);
  if (m === null) return null;
  const year = Number(m[1]);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

/**
 * Words of one path segment. Brackets ("[Pahe.in]") and the Pahe suffix go first. A segment with
 * spaces keeps its dots ("E.T. the Extra-Terrestrial"); one without splits on dots and underscores.
 */
function tokenize(segment: string): string[] {
  const stripped = segment.replace(BRACKETED, '').trim().replace(RELEASE_GROUP_SUFFIX, '');
  const words = stripped.includes(' ') ? stripped.replace(/_/g, ' ') : stripped.replace(/[._]+/g, ' ');
  return words.split(/\s+/).filter((t) => t !== '');
}

function trimPunctuation(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  while (start < end && PUNCT_TOKEN.test(tokens[start] ?? '')) start++;
  while (end > start && PUNCT_TOKEN.test(tokens[end - 1] ?? '')) end--;
  return tokens.slice(start, end);
}

function parseSegment(segment: string): SegmentParse {
  const tokens = tokenize(segment);
  let season: number | null = null;
  let episode: number | null = null;
  let bareEpisode: number | null = null;
  // The title ends at the first marker. Only SxxEyy may stand first ("S01E07.mkv"): any other
  // marker in first place is the title itself.
  let bound = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    const se = SXXEYY.exec(token);
    if (se !== null) {
      season = Number(se[1]);
      episode = Number(se[2]);
      bound = i;
      break;
    }
    if (i === 0) continue;
    const seasonOnly = SEASON_TOKEN.exec(token);
    if (seasonOnly !== null) {
      season = Number(seasonOnly[1]);
      bound = i;
      break;
    }
    const next = tokens[i + 1];
    if (SEASON_WORD.test(token) && next !== undefined && NUMBER_TOKEN.test(next)) {
      season = Number(next);
      bound = i;
      break;
    }
    const ep = EPISODE_TOKEN.exec(token);
    if (ep !== null) {
      bareEpisode = Number(ep[1]);
      bound = i;
      break;
    }
    if (QUALITY_TOKEN.test(token)) {
      bound = i;
      break;
    }
  }
  // The year is the LAST year-like token before the bound, never the first token: "1917 2019"
  // is 1917 from 2019, "Ne Zha 2 2025" is "Ne Zha 2" from 2025.
  let year: number | null = null;
  let cut = bound;
  for (let i = bound - 1; i >= 1; i--) {
    const y = yearOfToken(tokens[i] ?? '');
    if (y !== null) {
      year = y;
      cut = i;
      break;
    }
  }
  let titleTokens = trimPunctuation(tokens.slice(0, cut));
  // "One Piece - 405": a dash then a bare number closes the title of an absolutely numbered episode.
  let absoluteEpisode: number | null = null;
  const last = titleTokens[titleTokens.length - 1];
  const beforeLast = titleTokens[titleTokens.length - 2];
  if (
    season === null &&
    titleTokens.length >= 3 &&
    last !== undefined &&
    beforeLast !== undefined &&
    NUMBER_TOKEN.test(last) &&
    DASH_TOKEN.test(beforeLast)
  ) {
    absoluteEpisode = Number(last);
    titleTokens = trimPunctuation(titleTokens.slice(0, -2));
  }
  return { title: titleTokens.join(' '), year, season, episode, bareEpisode, absoluteEpisode };
}

/** Title, year, season, episode and absolute episode of one video path. Never throws. */
export function parseVideoPath(relPath: string): ParsedName {
  const segments = relPath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  const fileName = segments[segments.length - 1] ?? '';
  const dirName = segments.length >= 2 ? (segments[segments.length - 2] ?? null) : null;
  const stem = isVideoFile(fileName) ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;

  const file = parseSegment(stem);
  const dir = dirName === null ? null : parseSegment(dirName);

  const title = file.title !== '' ? file.title : (dir?.title ?? '');
  const sameFilm = dir !== null && (file.title === '' || compactTitle(file.title) === compactTitle(dir.title));
  const year = file.year ?? (sameFilm && dir !== null ? dir.year : null);
  const season = file.season ?? dir?.season ?? null;
  let episode = file.episode;
  let absoluteEpisode = file.absoluteEpisode;
  if (file.bareEpisode !== null) {
    if (season !== null) episode = file.bareEpisode;
    else absoluteEpisode = file.bareEpisode;
  }
  const kindHint: KindHint =
    season !== null || episode !== null || absoluteEpisode !== null ? 'tv' : year !== null ? 'movie' : null;
  return { title, year, season, episode, absoluteEpisode, kindHint, fileName, dirName };
}
