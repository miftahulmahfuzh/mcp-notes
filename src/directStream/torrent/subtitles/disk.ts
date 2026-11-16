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
 * last play chose, so the next play of the same torrent answers it without asking anything.
 */

export const SUBTITLE_DIR_NAME = '.notesd-subs';
/** A file the route serves: lower-case letters, digits and dashes, then `.vtt`. No other name is ever opened. */
export const SUBTITLE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.vtt$/;
/** A BitTorrent v1 info hash as the engine names torrents: 40 lower-case hex characters. */
export const INFO_HASH_PATTERN = /^[0-9a-f]{40}$/;
const CHOSEN_FILE = 'chosen.json';

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

/** WebVTT from a subtitle's text (SubRip converted, WebVTT kept), or null when it holds no cue. */
export function vttFromText(text: string): string | null {
  const vtt = srtToVtt(text);
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
   */
  async save(infoHash: string, name: string, vtt: string, meta: { lang: string | null; label: string }): Promise<CacheSubtitleView> {
    const target = this.file(infoHash, name);
    if (target === null) throw new RangeError(`not a subtitle file name: ${name}`);
    const dir = this.dir(infoHash);
    await mkdir(dir, { recursive: true });
    await writeAtomic(target, vtt);
    const kept: KeptSubtitle[] = [{ name, lang: meta.lang, label: meta.label }];
    await writeAtomic(path.join(dir, CHOSEN_FILE), `${JSON.stringify(kept)}\n`);
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

/** The first tier: what an earlier play of this torrent chose, from disk. A replay asks nothing. */
export function keptTier(shelf: SubtitleShelf): SubtitleTier {
  return { name: 'kept', blocks: true, find: (ctx) => shelf.kept(ctx.infoHash) };
}
