import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import type { CacheSubtitleView } from '../../cachePlay.js';
import type { TorrentFileInfo } from '../types.js';
import { cleanAssVtt } from './assDrawing.js';
import type { SubtitleTier } from './chain.js';
import { vttFromBytes, vttFromText, type SubtitleShelf } from './disk.js';

/**
 * Subtitle files inside a torrent (TORRENT_STREAM_SOURCE phase 6, R3.1 and R3.2). A file's language
 * comes from its name and its folder (`Film.en.srt`, `Film.eng.srt`, `English.srt`, `2_English.srt`,
 * `Subs/<video name>/3_English.srt`, `Subs/English/1.srt`), once the words of the video's own name
 * are taken out (so "The.French.Dispatch.srt" names no language). Nothing here runs a file from
 * a torrent: SubRip and WebVTT are read as text, ASS/SSA are read by ffmpeg's ASS demuxer only.
 */

export type SubtitleLanguage = 'en' | 'other' | null;
export type SubtitleFlavor = 'plain' | 'sdh' | 'forced';

const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa)$/i;
const ENGLISH_CODES = new Set(['en', 'eng']);
const OTHER_NAMES = new Set([
  'french', 'francais', 'german', 'deutsch', 'spanish', 'espanol', 'castellano', 'latino', 'italian', 'portuguese', 'brazilian',
  'russian', 'polish', 'dutch', 'swedish', 'norwegian', 'danish', 'finnish', 'czech', 'slovak', 'hungarian', 'romanian',
  'bulgarian', 'greek', 'turkish', 'arabic', 'hebrew', 'persian', 'farsi', 'hindi', 'indonesian', 'malay', 'thai',
  'vietnamese', 'chinese', 'mandarin', 'cantonese', 'japanese', 'korean', 'ukrainian', 'croatian', 'serbian', 'slovenian',
  'estonian', 'latvian', 'lithuanian', 'icelandic', 'catalan', 'basque', 'galician', 'tagalog', 'filipino', 'bengali',
  'tamil', 'telugu', 'urdu',
]);
const OTHER_CODES = new Set([
  'fr', 'fre', 'fra', 'de', 'ger', 'deu', 'es', 'spa', 'it', 'ita', 'pt', 'por', 'pob', 'ru', 'rus', 'pl', 'pol', 'nl', 'dut',
  'nld', 'sv', 'swe', 'no', 'nor', 'nob', 'da', 'dan', 'fi', 'fin', 'cs', 'cze', 'ces', 'sk', 'slo', 'hu', 'hun', 'ro', 'rum',
  'ron', 'bg', 'bul', 'el', 'gre', 'ell', 'tr', 'tur', 'ar', 'ara', 'he', 'heb', 'fa', 'per', 'fas', 'hin', 'id', 'ind', 'ms',
  'may', 'msa', 'th', 'tha', 'vi', 'vie', 'zh', 'chi', 'zho', 'chs', 'cht', 'ja', 'jpn', 'ko', 'kor', 'uk', 'ukr', 'hr', 'hrv',
  'sr', 'srp', 'sl', 'slv', 'et', 'est', 'lv', 'lav', 'lt', 'lit', 'is', 'ice', 'isl', 'ca', 'cat',
]);
/** Words after the language that say what kind of track it is, never which language. */
const TAIL_WORDS = new Set(['sdh', 'hi', 'cc', 'forced', 'foreign', 'full', 'default', 'hearing', 'impaired', 'signs', 'songs', 'sign', 'song']);

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== '');
}

function baseOf(filePath: string): { base: string; folders: string[] } {
  const parts = filePath.split(/[\\/]/).filter((p) => p !== '');
  const last = parts.pop() ?? '';
  return { base: last.replace(SUBTITLE_EXT, ''), folders: parts.map((p) => p.toLowerCase().trim()) };
}

/**
 * The language a subtitle file's name gives: `en`, `other` (it names another language), or null
 * (it names none). `titleName` is the video's file name or the release name: its words are not
 * read as a language.
 */
export function subtitleLanguage(filePath: string, titleName = ''): SubtitleLanguage {
  const { base, folders } = baseOf(filePath);
  const title = new Set(tokensOf(titleName.replace(/\.[a-z0-9]{2,4}$/i, '')));
  const tokens = tokensOf(base).filter((t) => !title.has(t) || ENGLISH_CODES.has(t) || t === 'english');
  const core = [...tokens];
  while (core.length > 0 && (TAIL_WORDS.has(core[core.length - 1]!) || /^\d+$/.test(core[core.length - 1]!))) core.pop();
  const last = core.length === 0 ? null : core[core.length - 1]!;
  const near = folders.slice(-2);
  if (tokens.includes('english') || (last !== null && ENGLISH_CODES.has(last)) || near.some((f) => f === 'english' || ENGLISH_CODES.has(f))) return 'en';
  if (tokens.some((t) => OTHER_NAMES.has(t)) || (last !== null && OTHER_CODES.has(last)) || near.some((f) => OTHER_NAMES.has(f) || OTHER_CODES.has(f))) return 'other';
  return null;
}

/**
 * `forced` (only the lines in another language, or a signs-and-songs file: on-screen text and lyrics,
 * never the dialogue), `sdh` (with sounds and speakers) or `plain`.
 */
export function subtitleFlavor(filePath: string, titleName = ''): SubtitleFlavor {
  const tokens = tokensOf(baseOf(filePath).base);
  if (tokens.includes('forced') || tokens.includes('foreign')) return 'forced';
  // The video's own name is not read as signs: "Signs.2002.en.srt", "Song.of.the.Sea.en.srt".
  const title = new Set(tokensOf(titleName.replace(/\.[a-z0-9]{2,4}$/i, '')));
  const own = tokens.filter((t) => !title.has(t));
  if (['signs', 'sign', 'songs', 'song'].some((w) => own.includes(w)) && !own.includes('full') && !own.includes('dialogue')) return 'forced';
  if (tokens.includes('sdh') || tokens.includes('cc') || tokens.includes('hi') || (tokens.includes('hearing') && tokens.includes('impaired'))) return 'sdh';
  return 'plain';
}

/** One subtitle file worth showing, with the language and label the session gives it. */
export interface SubtitleFilePick {
  file: TorrentFileInfo;
  /** `en`, or null for the torrent's one subtitle file that names no language. */
  lang: 'en' | null;
  /** `English`, `English SDH`, or '' (the page shows a lone unnamed track by default). */
  label: string;
}

const FLAVOR_ORDER: Readonly<Record<SubtitleFlavor, number>> = { plain: 0, sdh: 1, forced: 2 };

function formatRank(name: string): number {
  if (/\.srt$/i.test(name)) return 0;
  if (/\.vtt$/i.test(name)) return 1;
  return 2;
}

/**
 * The torrent's subtitle files worth showing, best first. English files (never a forced one) come
 * first: plain before SDH, SubRip before WebVTT before ASS/SSA, then the larger. With no English
 * file, the torrent's one subtitle file when it names no language. Otherwise [].
 * `subtitleIndexes` is pickFile's `subtitles`.
 */
export function rankSubtitleFiles(files: readonly TorrentFileInfo[], subtitleIndexes: readonly number[], videoName: string): SubtitleFilePick[] {
  const wanted = new Set(subtitleIndexes);
  const subs = files.filter((f) => wanted.has(f.index) && SUBTITLE_EXT.test(f.name));
  const english = subs.filter((f) => subtitleLanguage(f.path, videoName) === 'en' && subtitleFlavor(f.path, videoName) !== 'forced');
  if (english.length > 0) {
    return english
      .map((file) => ({ file, flavor: subtitleFlavor(file.path, videoName), format: formatRank(file.name) }))
      .sort((a, b) => FLAVOR_ORDER[a.flavor] - FLAVOR_ORDER[b.flavor] || a.format - b.format || b.file.length - a.file.length)
      .map(({ file, flavor }) => ({ file, lang: 'en' as const, label: flavor === 'sdh' ? 'English SDH' : 'English' }));
  }
  const [only] = subs;
  if (subs.length === 1 && only !== undefined && subtitleLanguage(only.path, videoName) === null && subtitleFlavor(only.path, videoName) !== 'forced') {
    return [{ file: only, lang: null, label: '' }];
  }
  return [];
}

/** True when the torrent's subtitle files hold an English one (R3.2). A lone unnamed file does not count. */
export function hasEnglishSubtitleFile(files: readonly TorrentFileInfo[], subtitleIndexes: readonly number[], videoName: string): boolean {
  return rankSubtitleFiles(files, subtitleIndexes, videoName).some((pick) => pick.lang === 'en');
}

/** Phase 1's TorrentStreams as this phase reads it: a file's absolute path once it is complete, else null. */
export interface TorrentFilePaths {
  filePath(infoHash: string, index: number): string | null | Promise<string | null>;
  /**
   * The download's own record of its chosen files (the video and the subtitle files beside it), read on a replay from
   * disk, which joins no swarm and has no file list; null when there is no such download here.
   */
  chosenFiles?(infoHash: string): Promise<{ video: number | null; files: TorrentFileInfo[] } | null>;
}

/** An ASS/SSA file on disk to WebVTT text, or null when it cannot be converted. */
export type AssConverter = (file: string) => Promise<string | null>;

const ASS_TIMEOUT_MS = 20_000;

/** ffmpeg reading the file with its ASS demuxer only (no other format, no protocol but `file`), writing WebVTT to stdout. */
export function ffmpegAssConverter(ffmpegBin = 'ffmpeg'): AssConverter {
  return (file) =>
    new Promise((resolve) => {
      execFile(
        ffmpegBin,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file', '-f', 'ass', '-i', file, '-f', 'webvtt', 'pipe:1'],
        { timeout: ASS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err ? null : stdout),
      );
    });
}

/**
 * The tier waits this long in total for the subtitle files it wants to complete. It is asked aside (chain.ts), so the
 * wait holds nothing back: a file that arrives within it takes the place of what the session shows.
 */
export const SUBTITLE_FILE_WAIT_MS = 5 * 60_000;
const SUBTITLE_FILE_POLL_MS = 250;
/** A subtitle file larger than this is not a subtitle. */
export const SUBTITLE_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface FilesTierDeps {
  torrents: TorrentFilePaths;
  shelf: SubtitleShelf;
  convertAss: AssConverter;
  waitMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The second tier (R3.1): the best subtitle file inside the torrent, waited for (bounded, and never past the session's
 * end) and converted to WebVTT, kept as `file-<index>.vtt`. A file that does not complete in time, or that holds no
 * cue, is passed over. It is the release's own subtitle and is asked aside: the tiers after it do not wait for it, and
 * its answer takes the place of theirs whenever it arrives (chain.ts). On a replay from disk the download's record
 * names the files.
 */
export function filesTier(deps: FilesTierDeps): SubtitleTier {
  const waitMs = deps.waitMs ?? SUBTITLE_FILE_WAIT_MS;
  const pollMs = deps.pollMs ?? SUBTITLE_FILE_POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  const waitFor = async (infoHash: string, index: number, deadline: number, signal: AbortSignal): Promise<string | null> => {
    for (;;) {
      const file = await deps.torrents.filePath(infoHash, index);
      if (file !== null) return file;
      if (now() >= deadline || signal.aborted) return null;
      await sleep(pollMs);
    }
  };

  /** The files and the subtitle files beside the video: the play's, else (a replay) the download's record. */
  const filesOf = async (ctx: Parameters<SubtitleTier['find']>[0]): Promise<{ files: readonly TorrentFileInfo[]; subtitles: readonly number[] }> => {
    if (ctx.files.length > 0 || deps.torrents.chosenFiles === undefined) return { files: ctx.files, subtitles: ctx.subtitleIndexes };
    const record = await deps.torrents.chosenFiles(ctx.infoHash);
    if (record === null) return { files: [], subtitles: [] };
    return { files: record.files, subtitles: record.files.filter((f) => f.index !== ctx.fileIndex && f.index !== record.video).map((f) => f.index) };
  };

  const readVtt = async (file: string, name: string): Promise<string | null> => {
    if ((await stat(file)).size > SUBTITLE_FILE_MAX_BYTES) return null;
    if (/\.(ass|ssa)$/i.test(name)) {
      const converted = await deps.convertAss(file);
      return converted === null ? null : vttFromText(cleanAssVtt(converted));
    }
    return vttFromBytes(await readFile(file));
  };

  return {
    name: 'files',
    blocks: false,
    release: true,
    aside: true,
    async find(ctx): Promise<CacheSubtitleView[]> {
      const { files, subtitles } = await filesOf(ctx);
      const videoName = files.find((f) => f.index === ctx.fileIndex)?.name ?? '';
      const picks = rankSubtitleFiles(files, subtitles, videoName);
      if (picks.length === 0) return [];
      const deadline = now() + waitMs;
      for (const pick of picks) {
        const file = await waitFor(ctx.infoHash, pick.file.index, deadline, ctx.signal);
        if (file === null) continue;
        const vtt = await readVtt(file, pick.file.name).catch(() => null);
        if (vtt === null) continue;
        return [await deps.shelf.save(ctx.infoHash, `file-${pick.file.index}.vtt`, vtt, { lang: pick.lang, label: pick.label })];
      }
      return [];
    },
  };
}
