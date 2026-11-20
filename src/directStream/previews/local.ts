import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { StreamSession } from '../sessions.js';
import { cuesOf, planSheets } from './plan.js';
import { readSheets } from './sheetIndex.js';
import { noPreviews, type LocalVideo, type PreviewList, type PreviewSource } from './types.js';

/** Where a local source finds video on this machine. Phase 1: the stream cache (cacheSource.ts); phase 2: torrents. */
export interface LocalVideos {
  /** The video a session's film can be previewed from, or null. */
  forSession(session: StreamSession): Promise<LocalVideo | null>;
  /** The videos whole on this machine, whatever plays: the sweep makes what sheets they lack. */
  whole(): Promise<LocalVideo[]>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A source whose frames are sheets made on this machine. Never throws. */
export class LocalSource implements PreviewSource {
  constructor(
    readonly name: 'torrent' | 'cache',
    private readonly videos: LocalVideos,
    private readonly log: (line: string) => void,
  ) {}

  async list(session: StreamSession): Promise<PreviewList> {
    const video = await this.video(session);
    if (video === null) return noPreviews();
    try {
      return await localList(session.id, video);
    } catch (err) {
      this.log(`[notesd] previews: the ${this.name} sheets of ${video.key} could not be read: ${messageOf(err)}`);
      return noPreviews();
    }
  }

  async video(session: StreamSession): Promise<LocalVideo | null> {
    try {
      return await this.videos.forSession(session);
    } catch (err) {
      this.log(`[notesd] previews: could not look for ${this.name} video of session ${session.id.slice(0, 6)}: ${messageOf(err)}`);
      return null;
    }
  }

  async whole(): Promise<LocalVideo[]> {
    try {
      return await this.videos.whole();
    } catch (err) {
      this.log(`[notesd] previews: could not list the ${this.name} videos on disk: ${messageOf(err)}`);
      return [];
    }
  }
}

/** 8 hex characters naming a video in a sheet's address (`k=`). */
export function keyTag(key: string): string {
  return createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/** A sheet's same-origin address: the route GET /api/stream/sessions/:id/previews/:name. */
export function sheetUrl(sessionId: string, name: string, tag: string): string {
  return `/api/stream/sessions/${sessionId}/previews/${name}?k=${tag}`;
}

/** The list of a video's finished sheets: `ready` once every sheet of the film is made. */
export async function localList(sessionId: string, video: LocalVideo): Promise<PreviewList> {
  const sheets = await readSheets(video);
  if (sheets.length === 0) return noPreviews();
  const tag = keyTag(video.key);
  return {
    state: sheets.length >= planSheets(video.durationS).length ? 'ready' : 'partial',
    source: 'local',
    cues: cuesOf(sheets, (name) => sheetUrl(sessionId, name, tag)),
  };
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
