import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TORRENT_WHISPER_SCRIPT, type TorrentWhisperConfig } from '../config.js';
import type { CacheSubtitleView } from './cachePlay.js';
import { withHlsSegments } from './hlsCut.js';
import { TITLE_KEY_PATTERN, titleKey, type TitleSubtitleShelf } from './titleSubtitles.js';
import { CueFeeds } from './torrent/subtitles/feed.js';
import type { SyncInput } from './torrent/subtitles/synced.js';
import { ffmpegCutter, WHISPER_DIR, WhisperTier, WorkerTranscriber, type AudioCutter, type Transcriber } from './torrent/subtitles/whisper.js';
import type { StreamRef } from './types.js';

/**
 * Whisper for a cloud stream: the last resort when the stream has no English subtitle and the subtitle services have
 * none for the title either (outsideSubtitles.ts). A torrent has had this since its phase 8; a cloud stream ended at
 * the services, and in the subtitle soak of 2026-11-20 that left three of fourteen such plays with nothing to read,
 * the owner's own among them: Chasing the Moon, a Chinese film TMDB lists without an IMDb id, which Wyzie cannot map
 * and the OpenSubtitles add-on cannot be asked about.
 *
 * It is the torrent tier itself (WhisperTier: five-minute stretches, the one on screen first, a growing cue feed the
 * page reads again every few seconds, progress kept so a replay carries on), fed from the stream instead of a file:
 *
 * - **The audio** is what Wyzie Synced reads (DirectStreamService.audioInput): this machine's cache of the stream,
 *   else the provider's stream, an HLS one segment by segment (hlsCut.ts). The session that asked last names it, so a
 *   title that moved to another source is read from there.
 * - **Kept per title**, beside its other subtitles (titleSubtitles.ts): the feed in `<title>/notesd-cues/whisper.jsonl`,
 *   the progress in `<title>/notesd-whisper/`. It is never the title's *chosen* subtitle: a later play asks the
 *   services first again and comes back here only when they still have nothing.
 * - **A transcript, not a subtitle**: an English film is transcribed, any other translated, and the track is named
 *   `English (Whisper)`. It is never re-timed (it is cut from this audio) and never read as a dialogue file.
 */

/** A title's Whisper feed: `GET /api/stream/subs/:title/cues/whisper`. */
export const CLOUD_WHISPER_TRACK = 'whisper';
export function titleCueFeedUrl(key: string, track: string): string {
  return `/api/stream/subs/${key}/cues/${track}`;
}
/** What the tier is handed in place of a torrent's file route: it only names the title for the cutter below. */
const PLACE = 'notesd-title:';

/** The part of a stream session the transcript needs. */
export interface TranscriptSession {
  ref: StreamRef;
  /** The title's original language (TMDB's code); null: Whisper finds it out. */
  audioLang?: string | null;
  /** Where the play starts, in seconds. */
  resumeS?: number | null;
  outside: { stop: AbortController };
}

export interface CloudWhisperOptions {
  stretchS: number;
  shelf: Pick<TitleSubtitleShelf, 'dir'>;
  feeds: CueFeeds;
  /** Cuts a stretch from a SyncInput (an address, its arguments, an HLS source). */
  cutter: AudioCutter;
  transcriber: Transcriber;
  log?: (line: string) => void;
}

export class CloudWhisper {
  private readonly tier: WhisperTier;
  /** What each title's audio is read from now: the session that asked last. */
  private readonly inputs = new Map<string, () => SyncInput | Promise<SyncInput>>();

  constructor(private readonly opts: CloudWhisperOptions) {
    this.tier = new WhisperTier({
      stretchS: opts.stretchS,
      workDirOf: (key) => path.join(opts.shelf.dir(key), WHISPER_DIR),
      fileUrl: (key) => `${PLACE}${key}`,
      openFeed: async (key) => {
        const feed = (await opts.feeds.get(key, CLOUD_WHISPER_TRACK)) ?? (await opts.feeds.start(key, CLOUD_WHISPER_TRACK));
        return { url: titleCueFeedUrl(key, CLOUD_WHISPER_TRACK), append: (cues) => feed.append(cues), complete: () => feed.complete() };
      },
      cutter: async (request, signal) => {
        const input = this.inputs.get(request.url.slice(PLACE.length));
        if (input === undefined) return { ok: false, reason: 'no stream session of the title is open' };
        try {
          return await opts.cutter({ ...request, ...(await input()) }, signal);
        } catch (err) {
          // The session ended between two stretches: its audio is gone with it.
          return { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      },
      transcriber: opts.transcriber,
      logTag: '[notesd] cloud whisper:',
      releasedText: 'the stream session ended',
      ...(opts.log === undefined ? {} : { log: opts.log }),
    });
  }

  /**
   * The title's growing Whisper track for this session, at once; the transcription runs behind it while a session of
   * the title is open. Null when no feed can be opened. Never throws.
   */
  async track(session: TranscriptSession, input: () => SyncInput | Promise<SyncInput>): Promise<CacheSubtitleView | null> {
    const key = titleKey(session.ref);
    if (!TITLE_KEY_PATTERN.test(key)) return null;
    this.inputs.set(key, input);
    const found = await this.tier.find({ infoHash: key, fileIndex: 0, audioLang: session.audioLang ?? null, resumeS: session.resumeS ?? null, probe: { durationS: null }, signal: session.outside.stop.signal });
    return found[0] ?? null;
  }

  /** Stops every transcription and the worker: notesd is stopping. */
  close(): Promise<void> {
    return this.tier.close();
  }
}

export interface BuildCloudWhisperOptions {
  /** config.torrent.whisper: the one switch (`NOTESD_TORRENT_WHISPER`) and the one installation both Whisper tiers use. */
  whisper: TorrentWhisperConfig | undefined;
  shelf: Pick<TitleSubtitleShelf, 'dir'>;
  feeds: CueFeeds;
  ffmpegBin: string;
  log?: (line: string) => void;
}

/** The cloud transcript, or null: Whisper is off, or install.sh has not made its Python. A worker of its own, started by the first stretch. */
export async function buildCloudWhisper(options: BuildCloudWhisperOptions): Promise<CloudWhisper | null> {
  const whisper = options.whisper;
  if (whisper === undefined || !whisper.enabled) return null;
  try {
    await access(whisper.python, constants.X_OK);
  } catch {
    return null;
  }
  const log = options.log ?? ((line: string) => console.log(line));
  return new CloudWhisper({
    stretchS: whisper.stretchS,
    shelf: options.shelf,
    feeds: options.feeds,
    cutter: withHlsSegments(ffmpegCutter({ ffmpegBin: options.ffmpegBin }), { ffmpegBin: options.ffmpegBin }),
    transcriber: new WorkerTranscriber({ python: whisper.python, script: DEFAULT_TORRENT_WHISPER_SCRIPT, model: whisper.model, threads: whisper.threads, modelsDir: path.join(whisper.dir, 'models'), hfHome: path.join(whisper.dir, 'hf'), log }),
    log,
  });
}

/** The title feeds' store: `<stream-subs>/<title key>/notesd-cues/<track>.jsonl`. */
export function titleCueFeeds(shelf: Pick<TitleSubtitleShelf, 'dir'>, log?: (line: string) => void): CueFeeds {
  return new CueFeeds({ folderOf: (key) => shelf.dir(key), ...(log === undefined ? {} : { log }) });
}
