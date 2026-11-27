import { join } from 'node:path';
import type { Config } from '../config.js';
import type { AudioLangCheck } from './audioLang.js';
import type { DirectStreamService } from './service.js';
import type { WyzieAccess } from './startSubtitles.js';
import type { TorrentIndex } from './torrent/find/types.js';
import type { TorrentMarksRepo } from './torrent/marks.js';
import { remuxAudioInput, type TorrentRemux } from './torrent/remux.js';
import type { TorrentStreams } from './torrent/service.js';
import { buildTorrentSource, type TorrentSource } from './torrent/source.js';
import { buildSubtitleTiers } from './torrent/subtitles/chain.js';
import { SubtitleShelf } from './torrent/subtitles/disk.js';
import { EmbeddedSubtitles } from './torrent/subtitles/embedded.js';
import { CueFeeds, cueFeedUrl, whisperTrackId } from './torrent/subtitles/feed.js';
import { ffmpegAssConverter } from './torrent/subtitles/files.js';
import { torrentSyncPlace, type SubtitleSync } from './torrent/subtitles/synced.js';
import { buildWhisperTier, sharedTranscriber, type BuildWhisperTierOptions, type WhisperTier, type WorkerTranscriber } from './torrent/subtitles/whisper.js';
import type { TrackerLists } from './torrent/trackerLists.js';

/** `http://127.0.0.1:<port>`: this daemon's own routes on loopback, at the bound port once it listens. */
export function loopbackBase(boundPort: () => number | null, configPort: number): string {
  return `http://127.0.0.1:${boundPort() ?? configPort}`;
}

/** The parts of the torrent wiring built before the torrent source is first asked for, and read when it is. */
export interface TorrentSourceWiring {
  config: Config;
  boundPort: () => number | null;
  /** Built after the source's factory: each is read when the source is first built (at a play, never at boot). */
  late: () => {
    torrents: TorrentStreams | null;
    directStream: DirectStreamService | null;
    embedded: EmbeddedSubtitles | null;
    whisper: WhisperTier | null;
    lists: Pick<TrackerLists, 'list'> | null;
  };
  wyzie: WyzieAccess;
  fallback: readonly TorrentIndex[];
  remux: TorrentRemux | null;
  marks: TorrentMarksRepo;
  hear: AudioLangCheck | null;
  sync: SubtitleSync | null;
  build?: typeof buildTorrentSource;
}

/**
 * Torrent phase 3: the torrent source, built on first use from the TorrentStreams of phase 1 (null with
 * NOTESD_TORRENT=off). ffprobe reads a torrent's file through this daemon's own route on loopback. While no source can
 * be built (no torrents yet, or torrents off), each ask answers null and the next one tries again.
 */
export function torrentSourceFactory(w: TorrentSourceWiring): () => TorrentSource | null {
  let torrentSource: TorrentSource | null = null;
  const build = w.build ?? buildTorrentSource;
  const { config } = w;
  return () => {
    const late = w.late();
    const torrents = late.torrents;
    if (torrentSource === null && torrents !== null && config.torrent?.enabled === true) {
      const base = (): string => loopbackBase(w.boundPort, config.port);
      const place = {
        torrentDir: config.torrent.dir,
        shelf: new SubtitleShelf(config.torrent.dir),
        input: async (infoHash: string, fileIndex: number) => {
          const onDisk = await torrents.filePath(infoHash, fileIndex);
          if (onDisk !== null) return onDisk;
          // A film that lives as its remux (its original deleted) is heard from the remux's segments.
          return (await torrents.remuxOnly(infoHash, fileIndex)) ? remuxAudioInput(base(), infoHash, fileIndex) : `${base()}${torrents.localUrl(infoHash, fileIndex)}`;
        },
      };
      const directStream = late.directStream;
      const sync = w.sync;
      torrentSource = build(config, torrents, {
        localBase: base,
        tiers: buildSubtitleTiers({
          torrentDir: config.torrent.dir,
          torrents,
          log: (line) => console.log(line),
          subtitleUrl: config.torrent.subtitleUrl,
          wyzie: w.wyzie,
          fetch: (url, init) => fetch(url, init),
          // The borrow reads the title's English subtitle from a cloud provider, out of sight.
          lend: () => (directStream === null ? null : (ref, options) => directStream.subtitleText(ref, options)),
          convertAss: ffmpegAssConverter(config.torrent.ffmpegBin),
          embedded: late.embedded,
          whisper: late.whisper,
        }),
        remux: w.remux,
        fallback: w.fallback,
        // The public tracker lists' store, filled by startBackground's daily refresh; null when it is off.
        lists: late.lists,
        marks: w.marks,
        hear: w.hear,
        sync: sync === null ? null : { start: ({ infoHash, fileIndex, ...rest }) => sync.start({ ...rest, key: `${infoHash}-${fileIndex}`, place: torrentSyncPlace(place, infoHash, fileIndex) }) },
      });
    }
    return torrentSource;
  };
}

/** The subtitles found inside a torrent's own file, and Whisper's transcript of it: both null with torrents off. */
export interface TorrentSubtitles {
  /** The growing cue feeds (phase 7: the subtitle track inside the file; phase 8: Whisper). */
  torrentCues: CueFeeds | null;
  /** The ffmpeg extraction that fills phase 7's feeds. */
  embeddedSubtitles: EmbeddedSubtitles | null;
  /** Phase 8, the last tier: null with NOTESD_TORRENT_WHISPER=off or before install.sh has made its Python. */
  whisperTier: WhisperTier | null;
}

export interface TorrentSubtitlesIo {
  whisperTier?: (options: BuildWhisperTierOptions) => Promise<WhisperTier | null>;
}

/**
 * Phase 7's feeds and extraction: ffmpeg reads the file from disk once it is complete, else through this daemon's own
 * file route, which waits for the pieces as the torrent downloads. Phase 8's Whisper: its worker starts on the first
 * stretch, never at boot, and its cues go into the feed `whisper-<file index>` of the torrent.
 */
export async function buildTorrentSubtitles(
  config: Config,
  torrents: TorrentStreams | null,
  boundPort: () => number | null,
  sharedWhisper: WorkerTranscriber | null,
  io: TorrentSubtitlesIo = {},
): Promise<TorrentSubtitles> {
  const torrent = config.torrent;
  const torrentDir = torrent?.dir ?? null;
  const torrentCues = torrents === null || torrentDir === null ? null : new CueFeeds({ folderOf: (infoHash) => join(torrentDir, infoHash) });
  if (torrents === null || torrentCues === null || torrent === undefined) return { torrentCues, embeddedSubtitles: null, whisperTier: null };
  const base = (): string => loopbackBase(boundPort, config.port);
  const embeddedSubtitles = new EmbeddedSubtitles({
    ffmpegBin: torrent.ffmpegBin,
    feeds: torrentCues,
    input: async (infoHash, fileIndex) => {
      const onDisk = await torrents.filePath(infoHash, fileIndex);
      if (onDisk !== null) return onDisk;
      // The remux holds no subtitle stream; the original went only once this track's cue feed was complete.
      if (await torrents.remuxOnly(infoHash, fileIndex)) throw new Error('it lives as its remux, which holds no subtitle track');
      return `${base()}${torrents.localUrl(infoHash, fileIndex)}`;
    },
  });
  const whisperTier = await (io.whisperTier ?? buildWhisperTier)({
    whisper: torrent.whisper,
    torrentDir: torrent.dir,
    ffmpegBin: torrent.ffmpegBin,
    // Asked for every stretch: a film whose original was deleted beside its whole remux is heard from the remux.
    fileUrl: async (infoHash, fileIndex) => ((await torrents.remuxOnly(infoHash, fileIndex)) ? remuxAudioInput(base(), infoHash, fileIndex) : `${base()}${torrents.localUrl(infoHash, fileIndex)}`),
    ...(sharedWhisper === null ? {} : { transcriber: sharedTranscriber(sharedWhisper) }),
    openFeed: async (infoHash, fileIndex) => {
      const track = whisperTrackId(fileIndex);
      // A feed a stopped run left carries on (the progress file says which stretches are in it); else a new one.
      const feed = (await torrentCues.get(infoHash, track)) ?? (await torrentCues.start(infoHash, track));
      return { url: cueFeedUrl(infoHash, track), append: (cues) => feed.append(cues), complete: () => feed.complete() };
    },
  });
  return { torrentCues, embeddedSubtitles, whisperTier };
}
