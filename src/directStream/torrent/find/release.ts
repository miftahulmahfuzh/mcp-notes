import { normalizeName } from '../../match.js';
import type { AudioCodec, Container, ReleaseHeight, ReleaseHints, ReleaseInfo, ReleaseSource, VideoCodec } from './types.js';

/**
 * Reads what a torrent's release name (and the file name, when the index gave one) says: picture
 * height, codecs, container, source, the languages named as audio, dub and multi-audio marks, cinema
 * recordings, 3D, the season and the episode. Pure. A word counts as a marker only after the title:
 * after the asked title's words when they start the name, else from the first year, quality, codec or
 * season word on, so "The French Dispatch" is never a French dub and "Cam (2018)" never a camera copy.
 */

export const VIDEO_EXTENSIONS: readonly string[] = ['mp4', 'm4v', 'mkv', 'avi', 'webm', 'mov', 'ts', 'm2ts', 'mpg', 'mpeg', 'wmv', 'flv', '3gp'];
export const SUBTITLE_EXTENSIONS: readonly string[] = ['srt', 'vtt', 'ass', 'ssa'];

export interface ReleaseContext {
  /** ISO 639-1. Null or absent: only an explicit dub marker makes a release `dubbed`. */
  originalLanguage?: string | null;
  title?: string | null;
  originalTitle?: string | null;
  /** The video file the index named inside the torrent (a pack's episode file). */
  fileName?: string | null;
  hints?: ReleaseHints;
}

export interface EpisodeRef {
  season: number | null;
  /** Last season of a multi-season pack; null for one season. */
  seasonTo: number | null;
  episode: number | null;
  /** Last episode of a range (S01E01-07); null for one episode. */
  episodeTo: number | null;
  complete: boolean;
}

/** `match`: names the episode; `pack`: holds its season; `other`: names something else; `unknown`: names nothing. */
export type EpisodeFit = 'match' | 'pack' | 'other' | 'unknown';

const LANGUAGE_TOKENS: ReadonlyMap<string, string> = new Map([
  ['english', 'en'], ['eng', 'en'], ['ingles', 'en'],
  ['french', 'fr'], ['truefrench', 'fr'], ['fre', 'fr'], ['fra', 'fr'], ['vf', 'fr'], ['vff', 'fr'], ['vfq', 'fr'], ['vfi', 'fr'], ['vf2', 'fr'],
  ['italian', 'it'], ['italiano', 'it'], ['ita', 'it'],
  ['german', 'de'], ['ger', 'de'], ['deu', 'de'], ['deutsch', 'de'],
  ['spanish', 'es'], ['spa', 'es'], ['esp', 'es'], ['espanol', 'es'], ['castellano', 'es'], ['latino', 'es'],
  ['portuguese', 'pt'], ['portugues', 'pt'], ['por', 'pt'], ['ptbr', 'pt'],
  ['russian', 'ru'], ['rus', 'ru'],
  ['ukrainian', 'uk'], ['ukr', 'uk'],
  ['hindi', 'hi'], ['hin', 'hi'],
  ['tamil', 'ta'], ['telugu', 'te'], ['malayalam', 'ml'], ['kannada', 'kn'],
  ['japanese', 'ja'], ['jpn', 'ja'],
  ['korean', 'ko'], ['kor', 'ko'],
  ['chinese', 'zh'], ['mandarin', 'zh'], ['cantonese', 'zh'],
  ['polish', 'pl'], ['turkish', 'tr'], ['thai', 'th'], ['hungarian', 'hu'], ['swedish', 'sv'], ['dutch', 'nl'],
]);
/** A dub or a voice-over track (Russian MVO/DVO/AVO, Polish lektor). */
const DUB_TOKENS: ReadonlySet<string> = new Set(['dub', 'dubbed', 'dubbing', 'dublado', 'doblado', 'dublaj', 'mvo', 'dvo', 'avo', 'lektor']);
/** The original track is there (VO: version originale; VOSTFR: original with French subtitles). */
const ORIGINAL_TOKENS: ReadonlySet<string> = new Set(['original', 'orig', 'vo', 'vost', 'vostfr', 'vosta']);
/** Several audio tracks, the original among them. DL: German "dual language". */
const MULTI_TOKENS: ReadonlySet<string> = new Set(['multi', 'multiaudio', 'dualaudio', 'multilang', 'dl']);
const SUB_WORD = /^(?:[a-z]{0,6}subs?|subtitles?|subtitled|subbed|legendado|legendas)$/;
const SUB_PLURAL = /^(?:[a-z]{0,6}subs|subtitles|subtitled|legendado|legendas)$/;
const THREE_D_TOKENS: ReadonlySet<string> = new Set(['3d', 'sbs', 'hsbs', 'hou']);
const CAM_SOURCES: ReadonlyMap<string, ReleaseSource> = new Map([
  ['cam', 'cam'], ['camrip', 'cam'], ['hdcam', 'cam'],
  ['ts', 'telesync'], ['hdts', 'telesync'], ['tsrip', 'telesync'], ['telesync', 'telesync'], ['pdvd', 'telesync'],
  ['tc', 'telecine'], ['hdtc', 'telecine'], ['telecine', 'telecine'],
]);
const SOURCES: ReadonlyMap<string, ReleaseSource> = new Map([
  ['webdl', 'web'], ['webrip', 'web'], ['web', 'web'], ['hdrip', 'web'],
  ['bluray', 'bluray'], ['bdrip', 'bluray'], ['brrip', 'bluray'], ['bdremux', 'bluray'], ['remux', 'bluray'], ['bdmux', 'bluray'],
  ['hdtv', 'hdtv'], ['pdtv', 'hdtv'],
  ['dvdrip', 'dvd'], ['dvd', 'dvd'], ['dvd5', 'dvd'], ['dvd9', 'dvd'], ['dvdr', 'dvd'],
]);
const VIDEO_CODECS: ReadonlyMap<string, VideoCodec> = new Map([
  ['x264', 'h264'], ['h264', 'h264'], ['avc', 'h264'],
  ['x265', 'hevc'], ['h265', 'hevc'], ['hevc', 'hevc'],
  ['av1', 'av1'], ['vp9', 'vp9'], ['xvid', 'xvid'], ['divx', 'xvid'],
]);
const CONTAINER_TOKENS: ReadonlyMap<string, Container> = new Map([
  ['mp4', 'mp4'], ['m4v', 'mp4'], ['mkv', 'mkv'], ['avi', 'avi'], ['webm', 'webm'],
]);
/** Where the markers start when the title is not found at the start of the name. */
const ANCHOR =
  /^(?:19[2-9]\d|20[0-4]\d|\d{3,4}[pi]|[248]k|uhd|s\d{1,2}(?:e\d{1,4})?|\d{1,2}x\d{2,3}|seasons?|saison|stagion[ei]|temporadas?|complete|completa|integrale|bluray|bdrip|brrip|bdremux|remux|webdl|webrip|web|hdtv|hdrip|dvdrip|x264|x265|h264|h265|hevc|xvid|cam|camrip|hdcam|ts|hdts|telesync|tc|hdtc|telecine)$/;
const CYRILLIC = /[Ѐ-ӿ]/;
/** Words a name splits that mean one thing joined. Applied to the prepared text, where `-` is kept. */
const JOINS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![a-z0-9])web ?-? ?dl(?![a-z0-9])/g, 'webdl'],
  [/(?<![a-z0-9])web ?-? ?rip(?![a-z0-9])/g, 'webrip'],
  [/(?<![a-z0-9])blu ?-? ?ray(?![a-z0-9])/g, 'bluray'],
  [/(?<![a-z0-9])dts ?-? ?hd(?![a-z0-9])/g, 'dtshd'],
  [/(?<![a-z0-9])e ?-? ?ac ?-? ?3(?![a-z0-9])/g, 'eac3'],
  [/(?<![a-z0-9])h ?-? ?26([45])(?![0-9])/g, 'h26$1'],
  [/(?<![a-z0-9])x ?-? ?26([45])(?![0-9])/g, 'x26$1'],
  [/(?<![a-z0-9])dual ?-? ?audio(?![a-z0-9])/g, 'dualaudio'],
  [/(?<![a-z0-9])multi ?-? ?audio(?![a-z0-9])/g, 'multiaudio'],
  [/(?<![a-z0-9])pt ?-? ?br(?![a-z0-9])/g, 'ptbr'],
  [/(?<![a-z0-9])(?:half ?-? ?|h ?-? ?)sbs(?![a-z0-9])/g, 'hsbs'],
  [/(?<![a-z0-9])full ?-? ?sbs(?![a-z0-9])/g, 'sbs'],
  [/(?<![a-z0-9])(?:half ?-? ?|h ?-? ?)ou(?![a-z0-9])/g, 'hou'],
  [/(?<![a-z0-9])hd ?-? ?(cam|ts|tc)(?![a-z0-9])/g, 'hd$1'],
  [/(?<![a-z0-9])tele ?-? ?(sync|cine)(?![a-z0-9])/g, 'tele$1'],
];
const SE = /(?<![a-z0-9])s(\d{1,2}) ?e(\d{1,4})(?:(?: ?- ?e?| ?e)(\d{1,4}))?(?![0-9a-z])/;
const NX = /(?<![a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9a-z])/;
const SEASON_RANGE = /(?<![a-z0-9])s(\d{1,2}) ?- ?s?(\d{1,2})(?![0-9])/g;
const SEASON_ALONE = /(?<![a-z0-9])s(\d{1,2})(?![0-9])(?! ?e\d)/g;
const SEASON_WORD = /(?<![a-z0-9])(?:seasons?|saison|stagion[ei]|temporadas?|сезон) ?(\d{1,2})(?: ?(?:-|to|a) ?(\d{1,2}))?(?![0-9])/g;
const SEASON_WORD_AFTER = /(?<![0-9])(\d{1,2})a? temporada(?![a-z])/g;
const EPISODE_ALONE = /(?<![a-z0-9])(?:episode|episodio|ep|e|capitulo|cap) ?(\d{1,4})(?![0-9])/;
const COMPLETE = /(?<![a-z])(?:complete|completa|completo|integrale|box ?set)(?![a-z])/;

/** The file name's extension when it is a video or subtitle one, lower case, without the dot. */
export function extensionOf(path: string): string | null {
  const ext = /\.([a-z0-9]{2,4})$/i.exec(path.trim())?.[1]?.toLowerCase() ?? null;
  return ext !== null && (VIDEO_EXTENSIONS.includes(ext) || SUBTITLE_EXTENSIONS.includes(ext)) ? ext : null;
}

/** The name without a video or subtitle extension. */
export function stripExtension(name: string): string {
  const ext = extensionOf(name);
  return ext === null ? name.trim() : name.trim().slice(0, -(ext.length + 1));
}

/** The last part of a `/` or `\` path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

function prepare(text: string): string {
  let s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ-]+/g, ' ');
  for (const [pattern, joined] of JOINS) s = s.replace(pattern, joined);
  return s.replace(/\s+/g, ' ').trim();
}

function tokensOf(prepared: string): string[] {
  return prepared.split(/[\s-]+/).filter((t) => t.length > 0);
}

/** How many leading tokens spell one of the titles (non-Latin tokens, which normalize to nothing, are passed over); 0 when none does. */
function titleEnd(tokens: readonly string[], titles: readonly string[]): number {
  let best = 0;
  for (const title of titles) {
    const target = normalizeName(title);
    if (target === '') continue;
    let spelled = '';
    for (let i = 0; i < tokens.length; i++) {
      spelled += normalizeName(tokens[i] ?? '');
      if (spelled === target) {
        best = Math.max(best, i + 1);
        break;
      }
      if (!target.startsWith(spelled)) break;
    }
  }
  return best;
}

function markerStart(tokens: readonly string[], titles: readonly string[]): number {
  const afterTitle = titleEnd(tokens, titles);
  if (afterTitle > 0) return afterTitle;
  const anchor = tokens.findIndex((t) => ANCHOR.test(t));
  return anchor < 0 ? 0 : anchor;
}

/** Positions in `tail` that are subtitle words or the languages of a subtitle word. */
function subtitleTokens(tail: readonly string[]): Set<number> {
  const marked = new Set<number>();
  tail.forEach((token, i) => {
    if (!SUB_WORD.test(token)) return;
    marked.add(i);
    const before = tail[i - 1];
    if (SUB_PLURAL.test(token) && before !== undefined && LANGUAGE_TOKENS.has(before)) marked.add(i - 1);
    for (let j = i + 1; j < tail.length && LANGUAGE_TOKENS.has(tail[j] ?? ''); j++) marked.add(j);
  });
  return marked;
}

function heightClass(n: number): ReleaseHeight {
  return n >= 1500 ? 2160 : n >= 900 ? 1080 : n >= 600 ? 720 : 480;
}

function widthClass(w: number): ReleaseHeight {
  return w >= 2500 ? 2160 : w >= 1700 ? 1080 : w >= 1100 ? 720 : 480;
}

function heightOf(token: string): ReleaseHeight | null {
  const lines = /^(\d{3,4})[pi]$/.exec(token)?.[1];
  if (lines !== undefined) return heightClass(Number(lines));
  const width = /^(\d{3,4})x\d{3,4}$/.exec(token)?.[1];
  if (width !== undefined) return widthClass(Number(width));
  if (token === '4k' || token === 'uhd') return 2160;
  if (token === '2k') return 1080;
  if (token === 'sd') return 480;
  return null;
}

function audioCodecOf(token: string): AudioCodec | null {
  if (/^aac\d*$/.test(token)) return 'aac';
  if (/^(?:eac3|ddp\d*)$/.test(token)) return 'eac3';
  if (/^(?:ac3|dd\d*)$/.test(token)) return 'ac3';
  if (/^dts(?:hd|x|ma)?\d*$/.test(token)) return 'dts';
  if (/^(?:truehd|atmos)$/.test(token)) return 'truehd';
  if (/^flac\d*$/.test(token)) return 'flac';
  if (/^opus\d*$/.test(token)) return 'opus';
  if (token === 'mp3') return 'mp3';
  return null;
}

function containerOf(ext: string | null): Container | null {
  if (ext === null) return null;
  if (ext === 'mp4' || ext === 'm4v') return 'mp4';
  if (ext === 'mkv' || ext === 'avi' || ext === 'webm') return ext;
  return VIDEO_EXTENSIONS.includes(ext) ? 'other' : null;
}

interface Signals {
  height: ReleaseHeight | null;
  videoCodec: VideoCodec | null;
  audioCodecs: AudioCodec[];
  container: Container | null;
  source: ReleaseSource | null;
  languages: Set<string>;
  original: boolean;
  multi: boolean;
  dual: boolean;
  dub: boolean;
  cam: boolean;
  threeD: boolean;
}

function readSignals(text: string, titles: readonly string[]): Signals {
  const tokens = tokensOf(prepare(text));
  const tail = tokens.slice(markerStart(tokens, titles));
  const subtitles = subtitleTokens(tail);
  const signals: Signals = {
    height: null,
    videoCodec: null,
    audioCodecs: [],
    container: null,
    source: null,
    languages: new Set(),
    original: false,
    multi: false,
    dual: false,
    dub: false,
    cam: false,
    threeD: false,
  };
  if (CYRILLIC.test(text)) signals.languages.add('ru');
  for (const token of tokens) {
    signals.height ??= heightOf(token);
    signals.videoCodec ??= VIDEO_CODECS.get(token) ?? null;
    const audio = audioCodecOf(token);
    if (audio !== null && !signals.audioCodecs.includes(audio)) signals.audioCodecs.push(audio);
    signals.container ??= CONTAINER_TOKENS.get(token) ?? null;
    signals.source ??= SOURCES.get(token) ?? null;
  }
  tail.forEach((token, i) => {
    if (subtitles.has(i)) return;
    const language = LANGUAGE_TOKENS.get(token);
    if (language !== undefined) signals.languages.add(language);
    if (ORIGINAL_TOKENS.has(token)) signals.original = true;
    if (MULTI_TOKENS.has(token)) signals.multi = true;
    if (token === 'dual') signals.dual = true;
    if (DUB_TOKENS.has(token)) signals.dub = true;
    if (THREE_D_TOKENS.has(token)) signals.threeD = true;
    const cam = CAM_SOURCES.get(token);
    if (cam !== undefined && !signals.cam) {
      signals.cam = true;
      signals.source = cam;
    }
  });
  return signals;
}

/** The season, episode and pack words of a release or file name. */
export function parseEpisodeRef(text: string): EpisodeRef {
  const s = prepare(text);
  const seasons: number[] = [];
  let episode: number | null = null;
  let episodeTo: number | null = null;
  const se = SE.exec(s);
  const nx = se === null ? NX.exec(s) : null;
  if (se?.[1] !== undefined && se[2] !== undefined) {
    seasons.push(Number(se[1]));
    episode = Number(se[2]);
    episodeTo = se[3] !== undefined ? Number(se[3]) : null;
  } else if (nx?.[1] !== undefined && nx[2] !== undefined) {
    seasons.push(Number(nx[1]));
    episode = Number(nx[2]);
  }
  for (const m of s.matchAll(SEASON_RANGE)) seasons.push(Number(m[1]), Number(m[2]));
  for (const m of s.matchAll(SEASON_ALONE)) seasons.push(Number(m[1]));
  for (const m of s.matchAll(SEASON_WORD)) {
    seasons.push(Number(m[1]));
    if (m[2] !== undefined) seasons.push(Number(m[2]));
  }
  for (const m of s.matchAll(SEASON_WORD_AFTER)) seasons.push(Number(m[1]));
  if (episode === null) {
    const alone = EPISODE_ALONE.exec(s)?.[1];
    if (alone !== undefined) episode = Number(alone);
  }
  const season = seasons.length > 0 ? Math.min(...seasons) : null;
  const last = seasons.length > 0 ? Math.max(...seasons) : null;
  const seasonTo = season !== null && last !== null && last > season ? last : null;
  // A multi-season pack's episode numbers ("S01-05e01-62") count over the whole pack, not one season.
  if (seasonTo !== null) {
    episode = null;
    episodeTo = null;
  }
  if (episode !== null && episodeTo !== null && episodeTo <= episode) episodeTo = null;
  return { season, seasonTo, episode, episodeTo, complete: COMPLETE.test(s) };
}

/** The ref names `episode` (alone or inside its range). */
export function covers(ref: EpisodeRef, episode: number): boolean {
  return ref.episode !== null && episode >= ref.episode && episode <= (ref.episodeTo ?? ref.episode);
}

function holdsSeason(ref: EpisodeRef, season: number): boolean {
  return ref.season !== null && season >= ref.season && season <= (ref.seasonTo ?? ref.season);
}

/**
 * Whether a candidate holds one episode. The file name decides when it names an episode (it is the
 * file that would play); else the release name: the episode, or a season pack or complete series
 * that holds it.
 */
export function episodeFit(name: string, fileName: string | null, season: number, episode: number): EpisodeFit {
  const named = parseEpisodeRef(name);
  if (fileName !== null) {
    const file = parseEpisodeRef(stripExtension(baseName(fileName)));
    if (file.episode !== null) {
      const seasonFits = file.season !== null ? file.season === season : named.season === null || holdsSeason(named, season);
      return seasonFits && covers(file, episode) ? 'match' : 'other';
    }
  }
  if (named.episode !== null) return (named.season === null || named.season === season) && covers(named, episode) ? 'match' : 'other';
  if (named.season !== null) return holdsSeason(named, season) ? 'pack' : 'other';
  return named.complete ? 'pack' : 'unknown';
}

/** Reads a release name, and the named file inside it when there is one. */
export function parseRelease(name: string, context: ReleaseContext = {}): ReleaseInfo {
  const titles = [context.title, context.originalTitle].filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  const fileName = context.fileName?.trim() ? context.fileName.trim() : null;
  const fileStem = fileName === null ? null : stripExtension(baseName(fileName));
  const fromName = readSignals(name, titles);
  const fromFile = fileStem === null ? null : readSignals(fileStem, titles);
  const hints = context.hints ?? {};
  const original = context.originalLanguage?.trim().toLowerCase() || null;

  const languages = new Set([...fromName.languages, ...(fromFile?.languages ?? [])]);
  const originalNamed = fromName.original || (fromFile?.original ?? false) || (original !== null && languages.has(original));
  const multi = fromName.multi || (fromFile?.multi ?? false);
  const dual = fromName.dual || (fromFile?.dual ?? false);
  const dub = fromName.dub || (fromFile?.dub ?? false);
  const foreign = original === null ? [] : [...languages].filter((l) => l !== original);
  const dubbed = !originalNamed && !multi && (dub || foreign.length > 0);
  const audioCodecs = [...new Set([...(fromFile?.audioCodecs ?? []), ...fromName.audioCodecs])];
  const multiAudio = multi || dual || languages.size >= 2 || (dub && originalNamed) || (foreign.length > 0 && originalNamed) || audioCodecs.length >= 2;

  const videoCodec = hints.videoCodec ?? fromFile?.videoCodec ?? fromName.videoCodec;
  const audioCodec = hints.audioCodec ?? audioCodecs[0] ?? null;
  const container = hints.container ?? containerOf(fileName === null ? null : extensionOf(fileName)) ?? fromFile?.container ?? fromName.container;
  const height = hints.height ?? fromFile?.height ?? fromName.height;
  const cam = fromName.cam || (fromFile?.cam ?? false);
  const camSource = fromName.cam ? fromName.source : fromFile?.cam ? fromFile.source : null;
  const source = camSource ?? fromName.source ?? fromFile?.source ?? null;
  const threeD = hints.threeD === true || fromName.threeD || (fromFile?.threeD ?? false);

  const named = parseEpisodeRef(name);
  const file = fileStem === null ? null : parseEpisodeRef(fileStem);
  const ref = file !== null && file.episode !== null ? file : named;
  const pack = named.complete || named.seasonTo !== null || named.episodeTo !== null || (named.season !== null && named.episode === null);

  return {
    height,
    videoCodec,
    audioCodec,
    container,
    source,
    languages: [...languages].sort(),
    multiAudio,
    dubbed,
    cam,
    threeD,
    season: ref.season ?? named.season,
    seasonTo: named.seasonTo,
    episode: ref.episode,
    episodeTo: ref.episodeTo,
    complete: named.complete,
    pack,
    direct: !multiAudio && !dubbed && videoCodec === 'h264' && audioCodec === 'aac' && container === 'mp4',
  };
}
