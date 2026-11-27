import { join } from 'node:path';
import { DEFAULT_FFMPEG_BIN, type Config } from '../config.js';
import type { MovieStreams } from '../movies/streams.js';
import { buildCloudWhisper, titleCueFeeds, type BuildCloudWhisperOptions, type CloudWhisper } from './cloudWhisper.js';
import { sweepAudioLeftovers } from './leftovers.js';
import { OutsideSubtitles } from './outsideSubtitles.js';
import { TITLE_SUBS_SUBDIR, TitleSubtitleShelf } from './titleSubtitles.js';
import type { CueFeeds } from './torrent/subtitles/feed.js';
import { buildSubtitleSync, type SubtitleSync } from './torrent/subtitles/synced.js';
import { sharedTranscriber, type WorkerTranscriber } from './torrent/subtitles/whisper.js';

/** Wyzie Subs' address and key; null when either is missing, and the services then end at the OpenSubtitles add-on. */
export type WyzieAccess = { baseUrl: string; key: string } | null;

/** The subtitles a stream session gets from outside its own stream: the services, Wyzie Synced and the cloud transcript. */
export interface StreamSubtitles {
  wyzie: WyzieAccess;
  /** Wyzie Synced: null with NOTESD_TORRENT_WYZIE_SYNC=off or no key. */
  subtitleSync: SubtitleSync | null;
  /** `<dataDir>/movies/stream-subs`: a title's outside subtitle on this machine. */
  titleSubtitles: TitleSubtitleShelf;
  /** The growing cue feeds of the cloud transcripts. */
  titleCues: CueFeeds;
  /** A cloud stream's Whisper transcript: null with Whisper off, not installed, without the library or the torrent settings. */
  cloudWhisper: CloudWhisper | null;
  /** A cloud session whose stream has no English subtitle: the services, then the transcript. */
  outsideSubtitles: OutsideSubtitles | null;
}

export interface StreamSubtitlesIo {
  fetch?: typeof fetch;
  cloudWhisper?: (options: BuildCloudWhisperOptions) => Promise<CloudWhisper | null>;
  /** The background sweep of what a stretch in progress left when notesd last stopped (leftovers.ts). */
  sweep?: (roots: { perItem: readonly string[]; flat: readonly string[] }, log: (line: string) => void) => Promise<unknown>;
  log?: (line: string) => void;
}

/** The Wyzie address and key of the torrent settings, read whether or not torrents are on. */
export function wyzieAccess(config: Pick<Config, 'torrent'>): WyzieAccess {
  const t = config.torrent;
  return t === undefined || t.wyzieKey === null || t.wyzieUrl === null ? null : { baseUrl: t.wyzieUrl, key: t.wyzieKey };
}

/**
 * The subtitle services (Wyzie Subs with a key, then the OpenSubtitles add-on) and Wyzie Synced serve every stream
 * session: a torrent's `service` tier, and a cloud session whose stream has no English subtitle. Their settings are the
 * torrent ones, read whether or not torrents are on. The last resort of a cloud stream the services have nothing for is
 * a Whisper transcript of its own audio, as a torrent has (cloudWhisper.ts), heard through the shared worker.
 */
export async function buildStreamSubtitles(
  config: Config,
  movieStreams: Pick<MovieStreams, 'imdbId'> | null,
  sharedWhisper: WorkerTranscriber | null,
  io: StreamSubtitlesIo = {},
): Promise<StreamSubtitles> {
  const log = io.log ?? ((line: string) => console.log(line));
  // Global fetch is looked up at each call, as before (a test may stub it after the start).
  const fetchFn: typeof fetch = io.fetch ?? ((url, init) => fetch(url, init));
  const wyzie = wyzieAccess(config);
  const subtitleSync = buildSubtitleSync({
    sync: config.torrent?.wyzieSync,
    wyzie,
    ffmpegBin: config.torrent?.ffmpegBin ?? DEFAULT_FFMPEG_BIN,
    fetch: (url, init) => fetchFn(url, init),
    log,
  });
  const titleSubtitles = new TitleSubtitleShelf(join(config.dataDir, TITLE_SUBS_SUBDIR));
  // The WAVs and empty work folders a stretch in progress left when notesd last stopped (leftovers.ts); in the background.
  void (io.sweep ?? sweepAudioLeftovers)(
    { perItem: [join(config.dataDir, TITLE_SUBS_SUBDIR), ...(config.torrent?.dir === undefined ? [] : [config.torrent.dir])], flat: [join(config.dataDir, 'movies', 'subtitle-check')] },
    log,
  );
  const titleCues = titleCueFeeds(titleSubtitles);
  const torrent = config.torrent;
  if (movieStreams === null || torrent === undefined) return { wyzie, subtitleSync, titleSubtitles, titleCues, cloudWhisper: null, outsideSubtitles: null };
  const cloudWhisper = await (io.cloudWhisper ?? buildCloudWhisper)({
    whisper: torrent.whisper,
    shelf: titleSubtitles,
    feeds: titleCues,
    ffmpegBin: torrent.ffmpegBin ?? DEFAULT_FFMPEG_BIN,
    ...(sharedWhisper === null ? {} : { transcriber: sharedTranscriber(sharedWhisper) }),
  });
  const outsideSubtitles = new OutsideSubtitles({
    whisper: cloudWhisper,
    shelf: titleSubtitles,
    services: { baseUrl: torrent.subtitleUrl, wyzie, fetch: (url, init) => fetchFn(url, init), log },
    sync: subtitleSync,
    imdbId: (ref) => movieStreams.imdbId(ref),
  });
  return { wyzie, subtitleSync, titleSubtitles, titleCues, cloudWhisper, outsideSubtitles };
}
