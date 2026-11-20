import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CachePreviewRow, CachePreviewView } from '../cache/service.js';
import type { StreamSession } from '../sessions.js';
import { ffprobeFile } from '../torrent/probe.js';
import { isFile, keyTag, LocalSource, type LocalVideos } from './local.js';
import type { PreviewSourceDeps } from './sources.js';
import { PreviewNotYet, type LocalVideo, type PreviewSource } from './types.js';

/** A cache's sheets and their index: `<cache folder>/previews/`. Deleted with the folder. */
export const CACHE_PREVIEWS_SUBDIR = 'previews';
const PROBE_TIMEOUT_MS = 30_000;
/** A file name inside the cache's folder: never a path, never an address. */
const LOCAL_NAME = /^[A-Za-z0-9._-]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** One segment of the cache's video playlist. */
export interface CacheSegment {
  name: string;
  startS: number;
  endS: number;
  /** Its media sequence number (a key without IV is derived from it). */
  seq: number;
  /** The #EXT-X-KEY line in force, or null (none, or METHOD=NONE). */
  key: string | null;
  /** The EXT-X-MAP URI in force, or null. */
  map: string | null;
  discontinuity: boolean;
  /** The local files it needs besides itself: its init section and its key. */
  needs: string[];
}

export interface CachePlaylist {
  version: number;
  targetDuration: number;
  segments: CacheSegment[];
  durationS: number;
}

const uriOf = (line: string): string | null => /URI="([^"]*)"/.exec(line)?.[1] ?? null;

/** The cache's `video.m3u8` (cache/hls.ts localMediaPlaylist); null when it names no local segment. */
export function parseCachePlaylist(text: string): CachePlaylist | null {
  let version = 3;
  let targetDuration = 10;
  let sequence = 0;
  let key: string | null = null;
  let map: string | null = null;
  let discontinuity = false;
  let length: number | null = null;
  let at = 0;
  let position = 0;
  const segments: CacheSegment[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const tag = /^(#EXT[A-Z0-9-]*):?(.*)$/.exec(line);
    if (tag !== null) {
      const name = tag[1] ?? '';
      const value = tag[2] ?? '';
      if (name === '#EXT-X-VERSION') version = Number(value) || version;
      else if (name === '#EXT-X-TARGETDURATION') targetDuration = Number(value) || targetDuration;
      else if (name === '#EXT-X-MEDIA-SEQUENCE') sequence = Number(value) || 0;
      else if (name === '#EXT-X-KEY') key = /METHOD=NONE/.test(value) ? null : line;
      else if (name === '#EXT-X-MAP') map = uriOf(value);
      else if (name === '#EXT-X-DISCONTINUITY') discontinuity = true;
      else if (name === '#EXTINF') {
        const d = Number.parseFloat(value);
        length = Number.isFinite(d) && d >= 0 ? d : null;
      }
      continue;
    }
    if (line.startsWith('#') || length === null) continue;
    const end = at + length;
    if (LOCAL_NAME.test(line)) {
      const needs = [map, key === null ? null : uriOf(key)].filter((n): n is string => n !== null && LOCAL_NAME.test(n));
      segments.push({ name: line, startS: at, endS: end, seq: sequence + position, key, map, discontinuity, needs });
    }
    at = end;
    position += 1;
    length = null;
    discontinuity = false;
  }
  return segments.length === 0 ? null : { version, targetDuration, segments, durationS: Math.round(at * 1000) / 1000 };
}

/** The stretches whose segments, init sections and keys are all in `names`, merged where they touch. */
export function segmentCoverage(segments: readonly CacheSegment[], names: ReadonlySet<string>): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const s of segments) {
    if (!names.has(s.name) || !s.needs.every((n) => names.has(n))) continue;
    const last = ranges.at(-1);
    if (last !== undefined && Math.abs(last[1] - s.startS) < 0.01) last[1] = s.endS;
    else ranges.push([s.startS, s.endS]);
  }
  return ranges;
}

const inFolder = (uri: string, folder: string): string => (SCHEME.test(uri) || path.isAbsolute(uri) ? uri : path.join(folder, uri));

/**
 * A VOD playlist of only the segments of [startS, endS), every file named by its absolute path, with the key and
 * init lines in force and the media sequence of its first segment; `offsetS` is where the stretch starts in it.
 * Null when no segment falls in the stretch.
 */
export function stretchPlaylist(playlist: CachePlaylist, folder: string, startS: number, endS: number): { text: string; offsetS: number } | null {
  const chosen = playlist.segments.filter((s) => s.endS > startS + 0.01 && s.startS < endS - 0.01);
  const first = chosen[0];
  if (first === undefined) return null;
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${playlist.version}`, `#EXT-X-TARGETDURATION:${playlist.targetDuration}`, `#EXT-X-MEDIA-SEQUENCE:${first.seq}`, '#EXT-X-PLAYLIST-TYPE:VOD'];
  let key: string | null = null;
  let map: string | null = null;
  chosen.forEach((s, i) => {
    if (i > 0 && s.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    if (s.key !== key) {
      lines.push(s.key === null ? '#EXT-X-KEY:METHOD=NONE' : s.key.replace(/URI="([^"]*)"/, (_m, uri: string) => `URI="${inFolder(uri, folder)}"`));
      key = s.key;
    }
    if (s.map !== null && s.map !== map) lines.push(`#EXT-X-MAP:URI="${inFolder(s.map, folder)}"`);
    map = s.map;
    lines.push(`#EXTINF:${(s.endS - s.startS).toFixed(6)},`, path.join(folder, s.name));
  });
  lines.push('#EXT-X-ENDLIST', '');
  return { text: lines.join('\n'), offsetS: Math.max(0, startS - first.startS) };
}

const seconds = (n: number): string => n.toFixed(3);

/** An HLS cache: its segments on disk, read one stretch at a time. */
class HlsCacheVideo implements LocalVideo {
  readonly durationS: number;

  constructor(
    readonly key: string,
    readonly dir: string,
    private readonly folder: string,
    private readonly playlist: CachePlaylist,
  ) {
    this.durationS = playlist.durationS;
  }

  async coverage(): Promise<Array<[number, number]>> {
    let names: Set<string>;
    try {
      names = new Set(await readdir(this.folder));
    } catch {
      return [];
    }
    return segmentCoverage(this.playlist.segments, names);
  }

  async input(startS: number, endS: number): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
    const stretch = stretchPlaylist(this.playlist, this.folder, startS, endS);
    if (stretch === null) throw new PreviewNotYet('no segment of the cache falls in that stretch');
    const file = path.join(this.dir, `stretch-${randomBytes(4).toString('hex')}.m3u8.part`);
    // `previews/` one level only, never the cache's folder (a deleted cache is not made again; the write below then fails).
    // The builder has made it already; a caller that asks for an input on its own has not.
    await mkdir(this.dir).catch(() => undefined);
    await writeFile(file, stretch.text);
    return {
      args: ['-f', 'hls', '-allowed_extensions', 'ALL', '-ss', seconds(stretch.offsetS), '-t', seconds(endS - startS), '-i', file],
      cleanup: () => rm(file, { force: true }),
    };
  }
}

/** A plain-file cache once joined into `video.mp4`. */
class Mp4CacheVideo implements LocalVideo {
  constructor(
    readonly key: string,
    readonly dir: string,
    private readonly file: string,
    readonly durationS: number,
  ) {}

  async coverage(): Promise<Array<[number, number]>> {
    return (await isFile(this.file)) ? [[0, this.durationS]] : [];
  }

  async input(startS: number, endS: number): Promise<{ args: string[] }> {
    return { args: ['-ss', seconds(startS), '-t', seconds(endS - startS), '-i', this.file] };
  }
}

export interface CacheVideosOptions {
  /** A plain file's length in seconds; null when it cannot be read. */
  probeDuration: (file: string) => Promise<number | null>;
  log: (line: string) => void;
}

/** The stream caches of this host as previewable video. */
export class CacheVideos implements LocalVideos {
  private readonly durations = new Map<string, number>();
  private readonly unreadable = new Set<string>();

  constructor(
    private readonly caches: CachePreviewView,
    private readonly opts: CacheVideosOptions,
  ) {}

  /**
   * The cache the session plays from (its `cached`), and no other: none for a pass-through or a torrent session, so a
   * frame never comes from a copy of the film whose timeline may be offset from the one on screen.
   */
  async forSession(session: StreamSession): Promise<LocalVideo | null> {
    if (session.cache === null) return null;
    const row = await this.caches.get(session.cache.id);
    return row === null ? null : this.videoOf(row);
  }

  async whole(): Promise<LocalVideo[]> {
    const out: LocalVideo[] = [];
    for (const row of await this.caches.ready()) {
      const video = await this.videoOf(row);
      if (video !== null) out.push(video);
    }
    return out;
  }

  private async videoOf(row: CachePreviewRow): Promise<LocalVideo | null> {
    const folder = this.caches.folder(row.id);
    const key = `cache-${row.id}-${keyTag((await this.caches.signature(row.id)) ?? 'unsigned')}`;
    const dir = path.join(folder, CACHE_PREVIEWS_SUBDIR);
    if (row.manifestKind === 'hls') {
      let text: string;
      try {
        text = await readFile(path.join(folder, 'video.m3u8'), 'utf8');
      } catch {
        return null;
      }
      const playlist = parseCachePlaylist(text);
      return playlist === null || playlist.durationS <= 0 ? null : new HlsCacheVideo(key, dir, folder, playlist);
    }
    const file = path.join(folder, 'video.mp4');
    if (row.state !== 'ready' || !(await isFile(file))) return null;
    const durationS = await this.mp4Duration(row.id, file);
    return durationS === null ? null : new Mp4CacheVideo(key, dir, file, durationS);
  }

  private async mp4Duration(id: string, file: string): Promise<number | null> {
    const known = this.durations.get(id);
    if (known !== undefined) return known;
    if (this.unreadable.has(id)) return null;
    const durationS = await this.opts.probeDuration(file);
    if (durationS !== null && durationS > 0) {
      this.durations.set(id, durationS);
      return durationS;
    }
    this.unreadable.add(id);
    this.opts.log(`[notesd] previews: the length of the cached file ${id} could not be read; it gets no previews this run`);
    return null;
  }
}

/** ffprobe's length of a file on disk; null when it cannot say. */
export function ffprobeDuration(ffprobeBin: string): (file: string) => Promise<number | null> {
  const probe = ffprobeFile({ ffprobeBin });
  return async (file) => {
    try {
      return (await probe(file, PROBE_TIMEOUT_MS)).durationS;
    } catch {
      return null;
    }
  };
}

/** The registry's cache source (sources.ts); null without a stream cache. */
export function cacheSource(deps: PreviewSourceDeps): PreviewSource | null {
  const view = deps.streamCache?.previewView() ?? null;
  if (view === null) return null;
  const videos = new CacheVideos(view, { probeDuration: deps.probeDuration ?? ffprobeDuration(deps.config.movies.ffprobeBin), log: deps.log });
  return new LocalSource('cache', videos, deps.log);
}
