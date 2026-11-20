import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CacheSubtitleView } from '../../cachePlay.js';
import { DIALOGUE_MIN_CUES, parseCues } from '../../dialogue.js';
import { srtToVtt } from '../../rewrite.js';
import type { SubtitleTier } from './chain.js';

/**
 * Where a torrent's subtitles are kept (TORRENT_STREAM_SOURCE phase 6): one folder per info hash,
 * `<torrent folder>/<info hash>/.notesd-subs/`, beside the torrent's own files, so clearing the
 * download clears them and a replay from disk finds them. Every file there is WebVTT, written by a
 * tier and served by GET /api/stream/torrent/:hash/sub/:name. `chosen.json` names the track the
 * last play chose, so the next play of the same torrent answers it without asking a service.
 *
 * A choice has a rank (`subtitleRank`): the file /sync-subtitle checked against the film's audio, then a subtitle
 * file of the release itself, then the track inside the video, then anything from outside (a subtitle service, a
 * cloud provider, Wyzie Synced's re-timing of one, a Whisper transcript). A save never replaces a chosen file of a
 * higher rank, so a service's answer or a sync that ends late cannot take the place of the release's own subtitle
 * or of a checked one.
 */

export const SUBTITLE_DIR_NAME = '.notesd-subs';
/** A file the route serves: lower-case letters, digits and dashes, then `.vtt`. No other name is ever opened. */
export const SUBTITLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.vtt$/;
/** A BitTorrent v1 info hash as the engine names torrents: 40 lower-case hex characters. */
export const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/;
const CHOSEN_FILE = 'chosen.json';

/** How far a subtitle is trusted to be this film's, in step, by where it came from. */
export const SUBTITLE_RANK = { none: 0, outside: 1, embedded: 2, file: 3, checked: 4 } as const;

/**
 * The rank of a session's subtitle, read from its address (or of a kept file, from its name): `checked-*` is what
 * /sync-subtitle chose, `file-*` a subtitle file of the release, a `cues/embedded-*` feed the track inside the video.
 * Everything else came from outside the release.
 */
export function subtitleRank(url: string): number {
  const name = url.slice(url.lastIndexOf('/') + 1);
  if (name.startsWith('checked-')) return SUBTITLE_RANK.checked;
  if (name.startsWith('file-')) return SUBTITLE_RANK.file;
  if (name.startsWith('embedded-') && /\/cues\/[^/]+$/.test(url)) return SUBTITLE_RANK.embedded;
  return SUBTITLE_RANK.outside;
}

/** The best rank among a session's subtitles; `none` for no subtitle. */
export function rankOf(subtitles: ReadonlyArray<{ url: string }>): number {
  return subtitles.reduce<number>((best, t) => Math.max(best, subtitleRank(t.url)), SUBTITLE_RANK.none);
}

/** One line of chosen.json. */
export interface KeptSubtitle {
  name: string;
  lang: string | null;
  label: string;
}

/** The route's address of one subtitle file, relative to the daemon's origin. */
export function subtitleUrl(infoHash: string, name: string): string {
  return `/api/stream/torrent/${infoHash}/sub/${name}`;
}

/** True when `file` is a regular file on disk. */
export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Each Windows-1252 character, by the byte it stands for: the way back from a UTF-8 text read as Windows-1252. */
const CP1252_BYTE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  const decoded = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 256 }, (_, i) => i));
  [...decoded].forEach((ch, i) => {
    if (!map.has(ch)) map.set(ch, i);
  });
  return map;
})();

/** A UTF-8 sequence read as Windows-1252: a lead byte (Â-ô) then one to three continuation characters ("Â ", "â€™", "Ã©"). */
const MOJIBAKE = /[\u00c2-\u00f4][\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/;

/** One line read back to its UTF-8, when every character is Windows-1252 and the bytes are valid UTF-8; else as it is. */
function repairLine(line: string): string {
  if (!MOJIBAKE.test(line)) return line;
  const bytes: number[] = [];
  for (const ch of line) {
    const b = CP1252_BYTE.get(ch);
    if (b === undefined) return line;
    bytes.push(b);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return line;
  }
}

/**
 * A subtitle's text with its mojibake undone, line by line: UTF-8 that was read as Windows-1252 somewhere ("Â (dealersÂ
 * chattingÂ indistinctly)", "itâ€™s"). A subtitle service's file often comes double-encoded so, and a UTF-8 file with one
 * bad byte falls back to Windows-1252 whole in vttFromBytes. A line that does not read back as UTF-8 is kept as it is.
 */
export function repairMojibake(text: string): string {
  return MOJIBAKE.test(text) ? text.split('\n').map(repairLine).join('\n') : text;
}

/** WebVTT from a subtitle's text (SubRip converted, WebVTT kept, mojibake undone), or null when it holds no cue. */
export function vttFromText(text: string): string | null {
  const vtt = srtToVtt(repairMojibake(text));
  return parseCues(vtt).length >= DIALOGUE_MIN_CUES ? vtt : null;
}

/** WebVTT from a subtitle file's bytes: UTF-8 when they are valid UTF-8, else Windows-1252 (old SubRip files). */
export function vttFromBytes(body: Buffer): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    text = new TextDecoder('windows-1252').decode(body);
  }
  return vttFromText(text);
}

function isKept(value: unknown): value is KeptSubtitle {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && SUBTITLE_NAME_PATTERN.test(v.name) && (v.lang === null || typeof v.lang === 'string') && typeof v.label === 'string';
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

export class SubtitleShelf {
  constructor(private readonly torrentDir: string) {}

  /** The folder of one torrent's subtitles. Throws RangeError for anything that is not an info hash. */
  dir(infoHash: string): string {
    if (!INFO_HASH_PATTERN.test(infoHash)) throw new RangeError(`not an info hash: ${infoHash}`);
    return path.join(this.torrentDir, infoHash, SUBTITLE_DIR_NAME);
  }

  /** The absolute path of one subtitle file, or null for a hash or a name the route never serves. Does not look at the disk. */
  file(infoHash: string, name: string): string | null {
    if (!INFO_HASH_PATTERN.test(infoHash) || !SUBTITLE_NAME_PATTERN.test(name)) return null;
    return path.join(this.dir(infoHash), name);
  }

  /**
   * Writes one WebVTT file and makes it the torrent's chosen track (chosen.json), each through a
   * temporary file and a rename, so no reader sees half a file. Answers the session's view of it.
   * The file is written either way, but it does not become the chosen track while a file of a higher
   * rank is (subtitleRank): the release's own subtitle or a checked one stays the choice.
   */
  async save(infoHash: string, name: string, vtt: string, meta: { lang: string | null; label: string }): Promise<CacheSubtitleView> {
    const target = this.file(infoHash, name);
    if (target === null) throw new RangeError(`not a subtitle file name: ${name}`);
    const dir = this.dir(infoHash);
    await mkdir(dir, { recursive: true });
    await writeAtomic(target, vtt);
    if (subtitleRank(name) >= rankOf(await this.kept(infoHash))) {
      const kept: KeptSubtitle[] = [{ name, lang: meta.lang, label: meta.label }];
      await writeAtomic(path.join(dir, CHOSEN_FILE), `${JSON.stringify(kept)}\n`);
    }
    return { url: subtitleUrl(infoHash, name), lang: meta.lang, label: meta.label };
  }

  /** The tracks the last play of this torrent chose whose files are still on disk; [] when there are none. */
  async kept(infoHash: string): Promise<CacheSubtitleView[]> {
    if (!INFO_HASH_PATTERN.test(infoHash)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(this.dir(infoHash), CHOSEN_FILE), 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    const views: CacheSubtitleView[] = [];
    for (const entry of raw) {
      if (!isKept(entry)) continue;
      const file = this.file(infoHash, entry.name);
      if (file === null || !(await isFile(file))) continue;
      views.push({ url: subtitleUrl(infoHash, entry.name), lang: entry.lang, label: entry.label });
    }
    return views;
  }
}

/**
 * The first tier: what an earlier play of this torrent chose, from disk. A choice from outside the release (a
 * service's file, a borrowed or re-timed one) is `provisional`: it is shown, and the release's own subtitle still
 * takes its place when the torrent has one (chain.ts). A checked file or a file of the release ends the chain.
 */
export function keptTier(shelf: SubtitleShelf): SubtitleTier {
  return { name: 'kept', blocks: true, find: (ctx) => shelf.kept(ctx.infoHash), provisional: (found) => rankOf(found) <= SUBTITLE_RANK.outside };
}
