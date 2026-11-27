import { join } from 'node:path';
import { DEFAULT_TORRENT_SITES_CONFIG, type Config } from '../config.js';
import type { Db } from '../db/client.js';
import { MOVIES_SUBDIR, type MoviesService } from '../movies/service.js';
import { StreamLive } from '../movies/streamLive.js';
import type { MovieStreams } from '../movies/streams.js';
import { siteFallback } from '../streaming/fallback.js';
import { scriptRunner, type StreamingRunner } from '../streaming/service.js';
import { scriptWarp, type WarpSwitch } from '../streaming/warp.js';
import { createAnimeMapper } from './anime.js';
import { buildStreamCache, type StreamCache } from './cache/service.js';
import type { CloudWhisper } from './cloudWhisper.js';
import { StreamEvidence } from './evidence.js';
import { PlayLog } from './playLog/log.js';
import { PlayLogRepo } from './playLog/repo.js';
import { DirectStreamRepo } from './repo.js';
import { buildDirectStreamService, type DirectStreamService } from './service.js';
import { buildStreamChecks, buildTorrentHearer, type StreamChecksIo } from './startChecks.js';
import { buildStreamSubtitles, type StreamSubtitlesIo, type WyzieAccess } from './startSubtitles.js';
import { buildTorrentSubtitles, torrentSourceFactory, type TorrentSubtitlesIo } from './startTorrents.js';
import type { TitleSubtitleShelf } from './titleSubtitles.js';
import { torrentSiteIndexes, torrentSitesScriptRunner } from './torrent/find-sites.js';
import { TorrentMarksRepo } from './torrent/marks.js';
import { buildTorrentRemux, type TorrentRemux } from './torrent/remux.js';
import { buildTorrentStreams, type TorrentStreams } from './torrent/service.js';
import type { TorrentSource } from './torrent/source.js';
import type { CueFeeds } from './torrent/subtitles/feed.js';
import type { SubtitleSync } from './torrent/subtitles/synced.js';
import type { WhisperTier, WorkerTranscriber } from './torrent/subtitles/whisper.js';
import { buildTrackerLists, type TrackerListsBuild } from './torrent/trackerLists.js';

/** Everything the Stream side is at start, before the parts that read AppDeps (startExtras.ts). Each part null when off. */
export interface DirectStreamWiring {
  /** One stream_play_log row per play ask on this host; the rows the previous run left open are closed as `restart`. */
  playLog: PlayLog | null;
  /** Runs claude/streaming/cli.mjs for the streaming sites; builds nothing until a streaming tool is called. */
  streaming: StreamingRunner | null;
  /** Cloudflare WARP on the Windows side (claude/streaming/warp.mjs); runs nothing until asked. */
  warp: WarpSwitch;
  /** The stream on screen in the player page; null without the library. */
  streamLive: StreamLive | null;
  streamEvidence: StreamEvidence | null;
  directStream: DirectStreamService | null;
  streamCache: StreamCache | null;
  torrents: TorrentStreams | null;
  torrentRemux: TorrentRemux | null;
  trackerLists: TrackerListsBuild;
  torrentCues: CueFeeds | null;
  whisperTier: WhisperTier | null;
  sharedWhisper: WorkerTranscriber | null;
  wyzie: WyzieAccess;
  subtitleSync: SubtitleSync | null;
  titleSubtitles: TitleSubtitleShelf;
  titleCues: CueFeeds;
  cloudWhisper: CloudWhisper | null;
  /** Built on the first torrent play (or download), never at boot. */
  torrentSourceOf: () => TorrentSource | null;
}

export interface DirectStreamStartInput {
  config: Config;
  db: Db;
  movies: MoviesService | null;
  movieStreams: MovieStreams | null;
  /**
   * While the old shared database is still to be merged, this host's cache and torrent rows may yet arrive: no folder
   * of the stream cache or the torrents is swept.
   */
  importPending: boolean;
  /** The bound port, known only after listen() (config.port may be 0): a play opens this daemon's player page. */
  boundPort: () => number | null;
}

export interface DirectStreamStartIo {
  checks?: StreamChecksIo;
  subtitles?: StreamSubtitlesIo;
  torrentSubtitles?: TorrentSubtitlesIo;
  service?: typeof buildDirectStreamService;
  cache?: typeof buildStreamCache;
  torrents?: typeof buildTorrentStreams;
  /** Default: a PlayLog over PlayLogRepo on the database. */
  playLog?: (db: Db, host: string) => PlayLog;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Direct streaming: null with NOTESD_DIRECT_STREAM=off or NOTESD_MOVIES=off. The provider seed is loaded into the
 * shared registry here; the resolver and Chrome run only when a play or a tool asks. Built in the order the daemon
 * always used: the play log's close, the checks, the torrent sites and remux, the outside subtitles, the torrent source's
 * factory, the service and its seed, the stream cache, the torrents, the tracker lists, the torrent's own subtitles.
 */
export async function startDirectStreaming(input: DirectStreamStartInput, io: DirectStreamStartIo = {}): Promise<DirectStreamWiring> {
  const { config, db, movies, movieStreams, importPending, boundPort } = input;
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  const directOn = movies !== null && config.directStream?.enabled === true;
  // The play log (src/directStream/playLog/): one row per stream play ask on this host, written behind the play and
  // never failing it. Sessions live in memory, so the rows the previous run left open are closed as `restart`.
  const playLog = !directOn ? null : (io.playLog ?? ((d: Db, host: string) => new PlayLog({ repo: new PlayLogRepo(d), host })))(db, movies.host);
  if (playLog !== null) {
    const closed = await playLog.closeLeftOpen();
    if (closed > 0) log(`[notesd] play log: closed ${closed} play(s) left open by the previous run (restart)`);
  }
  const streaming = config.streaming?.enabled ? scriptRunner({ port: boundPort }) : null;
  const warp = scriptWarp();
  // null with NOTESD_ANIME_MAP_URL=off: no lookup is made and an anime resolves like any series.
  const animeMapper = createAnimeMapper({ baseUrl: config.directStream?.animeMapUrl ?? null });
  const streamLive = movies === null ? null : new StreamLive();
  // Read late by the closures below: each is built after them, and asked only once a play or a snapshot runs.
  let directStream: DirectStreamService | null = null;
  let torrents: TorrentStreams | null = null;
  let streamCache: StreamCache | null = null;
  // This machine's stream evidence log: every pass-through answer and session change. A snapshot reads the live
  // session back through the service and the stream on screen through streamLive.
  const streamEvidence = !directOn
    ? null
    : new StreamEvidence({
        dir: join(config.dataDir, MOVIES_SUBDIR),
        host: movies.host,
        source: (id) => directStream?.evidenceSource(id) ?? null,
        onScreen: () => streamLive?.current()?.session_id ?? null,
      });
  const { picture, sharedWhisper, audioCheck } = await buildStreamChecks(config, movies !== null, io.checks);
  // 1337x and ext.to through the streaming Chrome (torrent phase 9): asked only when the JSON indexes give nothing
  // usable; NOTESD_TORRENT_<SITE>_ORIGIN=off leaves a site out.
  const torrentSites = config.torrent?.sites ?? DEFAULT_TORRENT_SITES_CONFIG;
  const torrentSiteFallback = torrentSiteIndexes(torrentSites, torrentSitesScriptRunner({ cliPath: torrentSites.cli }));
  // Torrent phase 5: the remux of files Chrome cannot play as is; null with torrents or NOTESD_TORRENT_REMUX off.
  const torrentRemux = buildTorrentRemux(config.torrent);
  const subs = await buildStreamSubtitles(config, movieStreams, sharedWhisper, io.subtitles);
  let trackerLists: TrackerListsBuild | null = null;
  let embedded: Awaited<ReturnType<typeof buildTorrentSubtitles>>['embeddedSubtitles'] = null;
  let whisperTier: WhisperTier | null = null;
  const torrentSourceOf = torrentSourceFactory({
    config,
    boundPort,
    late: () => ({ torrents, directStream, embedded, whisper: whisperTier, lists: trackerLists?.lists ?? null }),
    wyzie: subs.wyzie,
    fallback: torrentSiteFallback,
    remux: torrentRemux,
    // What this machine knows of each torrent whatever the title: the owner's blacklist and the language heard in a file that tags none.
    marks: new TorrentMarksRepo(db),
    hear: buildTorrentHearer(config, sharedWhisper),
    sync: subs.subtitleSync,
  });
  directStream = (io.service ?? buildDirectStreamService)(config, db, {
    movies,
    picture,
    audioCheck,
    pageBase: () => `http://localhost:${boundPort() ?? config.port}`,
    evidence: streamEvidence,
    // A play reads this host's stream cache first; the cache is built after this service, so it is read at play time.
    caches: () => streamCache?.player() ?? null,
    torrent: torrentSourceOf,
    outside: () => subs.outsideSubtitles,
    // The streaming sites, asked only when a play with no source named found nothing through direct streaming.
    siteFallback:
      movieStreams === null || streaming === null
        ? null
        : siteFallback({ runner: streaming, remembered: (ref) => movieStreams.channel(ref), title: (ref) => movieStreams.titleNames(ref), streams: movieStreams }),
    warp,
    playLog,
    hooks: movieStreams === null ? undefined : movieStreamHooks(movieStreams, animeMapper),
  });
  if (directStream !== null) {
    try {
      const seeded = await directStream.syncSeed();
      log(
        `[notesd] direct stream: on, ${seeded.total} providers in the seed (${seeded.inserted} new, ${seeded.updated} updated${seeded.removed.length === 0 ? '' : `, ${seeded.removed.join(', ')} removed`}${seeded.reset.length === 0 ? '' : `, ${seeded.reset.join(', ')} asked again`})`,
      );
    } catch (err) {
      error(`[notesd] direct stream: could not load the provider seed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Stream cache (stream-cache phase 5): downloads start only when asked; startBackground carries unfinished ones on.
  streamCache = (io.cache ?? buildStreamCache)(config, directStream, new DirectStreamRepo(db), { sweepOrphans: !importPending });
  // Torrents (torrent-stream-source phase 1): building it joins nothing; the WebTorrent engine starts with the first torrent opened.
  torrents = (io.torrents ?? buildTorrentStreams)(config, directStream, db, { sweepOrphans: !importPending });
  // A remux that became whole: its original goes now when nothing uses the torrent, else when the torrent leaves the swarm.
  const ownTorrents = torrents;
  if (ownTorrents !== null) torrentRemux?.whenDone((infoHash, fileIndex) => void ownTorrents.dropOriginals(infoHash, { fileIndex }));
  // The public tracker lists: one store, read by every torrent opened and every scrape, and the job that refreshes it
  // once a day from startBackground. Off with NOTESD_TORRENT_TRACKER_LISTS, torrents or discovery off.
  trackerLists = buildTrackerLists(config.torrent, torrents !== null);
  const torrentSubs = await buildTorrentSubtitles(config, torrents, boundPort, sharedWhisper, io.torrentSubtitles);
  embedded = torrentSubs.embeddedSubtitles;
  whisperTier = torrentSubs.whisperTier;
  return {
    playLog,
    streaming,
    warp,
    streamLive,
    streamEvidence,
    directStream,
    streamCache,
    torrents,
    torrentRemux,
    trackerLists,
    torrentCues: torrentSubs.torrentCues,
    whisperTier,
    sharedWhisper,
    wyzie: subs.wyzie,
    subtitleSync: subs.subtitleSync,
    titleSubtitles: subs.titleSubtitles,
    titleCues: subs.titleCues,
    cloudWhisper: subs.cloudWhisper,
    torrentSourceOf,
  };
}

/** The direct-stream service's hooks into the movies store: every resolve recorded, every title read through MovieStreams. */
export function movieStreamHooks(movieStreams: MovieStreams, animeMapper: ReturnType<typeof createAnimeMapper>): NonNullable<Parameters<typeof buildDirectStreamService>[2]['hooks']> {
  return {
    recordResolve: (ref, result) => movieStreams.recordResolve(ref, result),
    resumeS: (ref) => movieStreams.resumeS(ref),
    originalLanguage: (ref) => movieStreams.originalLanguage(ref),
    setAudioLanguage: (ref, language) => movieStreams.setAudioLanguage(ref, language),
    titleLabel: (ref) => movieStreams.titleLabel(ref),
    anime: (ref) => movieStreams.animeRef(ref, animeMapper),
    neighbors: (ref) => movieStreams.neighbors(ref),
    imdbId: (ref) => movieStreams.imdbId(ref),
    titleNames: (ref) => movieStreams.titleNames(ref),
    channel: (ref) => movieStreams.channel(ref),
    channelFailed: (ref, kind) => movieStreams.channelFailed(ref, kind),
    forgetTorrent: (infoHash) => movieStreams.forgetTorrent(infoHash),
    releaseDate: (ref) => movieStreams.releaseDate(ref),
  };
}
