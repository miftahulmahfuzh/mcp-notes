import path from 'node:path';
import type { StreamSession } from '../sessions.js';

/**
 * Seek previews (SEEK_PREVIEW_THUMBNAILS): the frames the player page shows over its timeline. PreviewCue,
 * PreviewList, PreviewSource and LocalVideo are the plan's fixed interface contract, shared with the player page
 * (phase 4) and the torrent (phase 2) and provider (phase 3) sources: they never change without the plan.
 */

export interface PreviewCue { start_s: number; end_s: number; url: string; x: number; y: number; w: number; h: number }
export interface PreviewList { state: 'none' | 'partial' | 'ready'; source: 'provider' | 'local' | null; cues: PreviewCue[] }

/** One source of frames. Asked in the order: provider, torrent, cache. The first that answers
 *  a list whose state is not 'none' is the session's list. */
export interface PreviewSource {
  readonly name: 'provider' | 'torrent' | 'cache';
  /** The frames this source has for the session now. Never throws; 'none' when it has nothing. */
  list(session: StreamSession): Promise<PreviewList>;
}

/** Video on this machine that sheets can be made from. Phase 1 builds from it; the cache source
 *  (phase 1) and the torrent source (phase 2) each describe their own. */
export interface LocalVideo {
  /** Stable for the same bytes across restarts; a folder name. */
  readonly key: string;
  /** Where the sheets and their index live (beside the video; made when missing). */
  readonly dir: string;
  readonly durationS: number;
  /** The stretches of the film that can be read now without any network: seconds. */
  coverage(): Promise<Array<[number, number]>>;
  /** ffmpeg input (and input arguments) for one stretch that coverage() said is there. Reading it
   *  must never fetch, select or wait for anything. */
  input(startS: number, endS: number): Promise<PreviewInput>;
}

/**
 * One stretch's ffmpeg input. `args` is the whole input section: input options, the seek to `startS` (`-ss`) and the
 * length `endS - startS` (`-t`), then `-i <address>`; the builder adds no seek of its own, so frame k of the sheet is
 * `startS + k × PREVIEW_INTERVAL_S`. `cleanup` runs after ffmpeg ended (it may throw PreviewNotYet). `loopback`: the
 * input reads this daemon's own 127.0.0.1 gate over http (a torrent file partly on disk, phase 2); only then does the
 * builder add `http,tcp` to the whitelist, and it refuses the input if any address is not `http://127.0.0.1`.
 */
export interface PreviewInput {
  args: string[];
  cleanup?: () => Promise<void>;
  loopback?: true;
}

/** A list with no frame: `cues` empty and `source` null, always together. A fresh object each call. */
export function noPreviews(): PreviewList {
  return { state: 'none', source: null, cues: [] };
}

/**
 * Thrown by LocalVideo.input(), or by the `cleanup` it returned (after ffmpeg ended), when the stretch cannot be
 * read yet: a torrent piece that is not on disk (phase 2's gate refused or cut short a read). The sheet is left for a
 * later look, is never counted against its tries, and keeps nothing. From `cleanup` it counts only when ffmpeg failed:
 * a sheet ffmpeg made from the bytes it was served is kept. Any other error from `input()`, and every other failed
 * ffmpeg, counts against the sheet's tries.
 */
export class PreviewNotYet extends Error {
  override readonly name = 'PreviewNotYet';
}

/**
 * The only protocols a preview ffmpeg may open: files on this machine, the AES-128 layer over them, an inline key and
 * a `concat:` of files (a remux's init and segments, phase 2). The builder puts `-protocol_whitelist` before every
 * input, so whatever an input names, a build can never reach the network, a torrent's swarm or a route of this daemon.
 */
export const PREVIEW_INPUT_PROTOCOLS = 'file,crypto,data,concat';
/** Added only for an input with `loopback: true`; the builder then refuses every address that is not http://127.0.0.1. */
export const PREVIEW_LOOPBACK_PROTOCOLS = 'http,tcp';

/**
 * A LocalVideo may also name its `home`: the folder whose existence means its video is still on this machine (a
 * torrent's `<hash>/` folder). The builder makes `dir` inside it and never makes `home` itself, and it keeps a sheet
 * only while `home` and `dir` are still there, so a delete racing a build never brings a preview folder back.
 */
export interface PreviewHome {
  readonly home: string;
}

/** The video's home: the one it names, else the folder its `dir` is in (a cache's folder for `<cache>/previews`). */
export function homeOf(video: LocalVideo): string {
  const home = (video as Partial<PreviewHome>).home;
  return typeof home === 'string' ? home : path.dirname(video.dir);
}
