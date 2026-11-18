import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CacheSubtitleView } from './cachePlay.js';
import { SUBTITLE_NAME_PATTERN, isFile } from './torrent/subtitles/disk.js';
import type { StreamRef } from './types.js';

/**
 * Where a title's outside subtitle is kept on this machine (WYZIE_SYNCED_BRIEF, addendum): the English subtitle the
 * subtitle services gave a cloud stream that had none (outsideSubtitles.ts). One folder per title,
 * `<data dir>/movies/stream-subs/<movie-550 | tv-1396-s1e2>/`, so a later play of the title here, from any provider
 * or from the stream cache, uses it with no request. Every file there is WebVTT, served by
 * GET /api/stream/subs/:title/:name; `chosen.json` names the one a session shows (the file as the service gave it,
 * or the one Wyzie Synced re-timed). A per-host file: the other machine asks for its own.
 */

export const TITLE_SUBS_SUBDIR = path.join('movies', 'stream-subs');
/** `movie-<tmdb id>` or `tv-<tmdb id>-s<season>e<episode>`: the only folder names ever opened. */
export const TITLE_KEY_PATTERN = /^(?:movie-\d{1,10}|tv-\d{1,10}-s\d{1,4}e\d{1,5})$/;
/** The file as a subtitle service gave it. */
export const TITLE_OUTSIDE_NAME = 'outside.vtt';
/** The file Wyzie Synced re-timed against the stream's audio. */
export const TITLE_SYNCED_NAME = 'synced.vtt';
/** The file /sync-subtitle chose and checked against the stream's audio (subtitleCheck/): `checked-<tag>.vtt`, the tag from its text, so a new choice is a new address. */
export const titleCheckedName = (tag: string): string => `checked-${tag}.vtt`;
const CHOSEN_FILE = 'chosen.json';

export function titleKey(ref: StreamRef): string {
  return ref.kind === 'movie' ? `movie-${ref.tmdbId}` : `tv-${ref.tmdbId}-s${ref.season}e${ref.episode}`;
}

/** The route's address of one of a title's subtitle files, relative to the daemon's origin. */
export function titleSubtitleUrl(key: string, name: string): string {
  return `/api/stream/subs/${key}/${name}`;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

export class TitleSubtitleShelf {
  /** `dir`: `<data dir>/movies/stream-subs`. */
  constructor(private readonly root: string) {}

  /** The folder of one title's subtitles. Throws RangeError for anything that is not a title key. */
  dir(key: string): string {
    if (!TITLE_KEY_PATTERN.test(key)) throw new RangeError(`not a title key: ${key}`);
    return path.join(this.root, key);
  }

  /** The absolute path of one subtitle file, or null for a key or a name the route never serves. Does not look at the disk. */
  file(key: string, name: string): string | null {
    if (!TITLE_KEY_PATTERN.test(key) || !SUBTITLE_NAME_PATTERN.test(name)) return null;
    return path.join(this.dir(key), name);
  }

  /**
   * Writes one WebVTT file and makes it the title's chosen subtitle, each through a temporary file and a rename.
   * `replaces`: the provider whose own English track this file stands in for (/sync-subtitle found that track wrong
   * or out of step); a session of that provider then shows this file and not the provider's.
   */
  async save(ref: StreamRef, name: string, vtt: string, label: string, replaces: string | null = null): Promise<CacheSubtitleView> {
    const key = titleKey(ref);
    const target = this.file(key, name);
    if (target === null) throw new RangeError(`not a subtitle file name: ${name}`);
    await mkdir(this.dir(key), { recursive: true });
    await writeAtomic(target, vtt);
    await writeAtomic(path.join(this.dir(key), CHOSEN_FILE), `${JSON.stringify({ name, label, ...(replaces === null ? {} : { replaces }) })}\n`);
    return { url: titleSubtitleUrl(key, name), lang: 'en', label };
  }

  /** The title's chosen subtitle when its file is still on disk, else null. */
  async kept(ref: StreamRef): Promise<CacheSubtitleView | null> {
    const key = titleKey(ref);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(this.dir(key), CHOSEN_FILE), 'utf8'));
    } catch {
      return null;
    }
    if (typeof raw !== 'object' || raw === null) return null;
    const { name, label } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || typeof label !== 'string') return null;
    const file = this.file(key, name);
    if (file === null || !(await isFile(file))) return null;
    return { url: titleSubtitleUrl(key, name), lang: 'en', label };
  }

  /** The provider whose own English track the title's chosen subtitle stands in for, or null: it only fills a gap. */
  async replaces(ref: StreamRef): Promise<string | null> {
    try {
      const raw = JSON.parse(await readFile(path.join(this.dir(titleKey(ref)), CHOSEN_FILE), 'utf8')) as { replaces?: unknown } | null;
      return typeof raw?.replaces === 'string' && raw.replaces !== '' && (await this.kept(ref)) !== null ? raw.replaces : null;
    } catch {
      return null;
    }
  }

  /** The text of the title's chosen subtitle, or null. */
  async text(ref: StreamRef): Promise<{ label: string; vtt: string } | null> {
    const kept = await this.kept(ref);
    const file = kept === null ? null : this.file(titleKey(ref), kept.url.slice(kept.url.lastIndexOf('/') + 1));
    if (kept === null || file === null) return null;
    try {
      return { label: kept.label, vtt: await readFile(file, 'utf8') };
    } catch {
      return null;
    }
  }
}
