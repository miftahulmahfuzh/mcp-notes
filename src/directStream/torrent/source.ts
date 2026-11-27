/**
 * The torrent source of direct streaming (TorrentSource): every name it ever exported, from the modules under
 * source/ that now hold them. Import from here; the modules are split by concern so one can be changed alone:
 *
 * - constants.ts      every budget, width and label (TORRENT_DEADLINE_MS, TORRENT_RACE_WIDTH, NO_FILE_LIST, ...)
 * - types.ts          the public types (TorrentSwarm, TorrentSourceOptions, TorrentResolve, ...) and one play's own
 * - torrentSource.ts  the TorrentSource facade, which hands each call to the module below that owns it
 * - resolve.ts        a play (resolve: the indexes, the proper round, the dub-named round) and the shuffle (next)
 * - race.ts           the side-by-side race up to each header, and the chosen torrent made the session's (finish)
 * - delivery.ts       which racer plays: delivers, chooseOrder, remuxTimeoutOutcome (pure)
 * - refusal.ts        the never-a-dub rule on a probed file (refusalOf) and the session's stand-in source (pure)
 * - probeWhileDelivering.ts  the header probe, given as long as the swarm delivers
 * - page.ts           the address the page plays (file route or remux) and whether the file is whole
 * - subtitles.ts      the subtitle chain behind the play, and Wyzie Synced
 * - kept.ts           fetch ahead and a kept download (fetchKept: a dub is heard and never downloaded)
 * - pack.ts           a season download's pack
 * - pasted.ts         a pasted magnet played (playMagnet), and the magnets pasted per title
 * - learnMagnet.ts    /update-cloud-source <magnet>: the index a magnet came from, its trackers learned
 * - listing.ts        the candidates list
 * - disk.ts           a replay from this host's disk (fromDisk), onDisk, releaseHeight
 * - hearing.ts        the torrent marks and the audio check (hearAudio, hearAt)
 * - failures.ts       what failed lately per film or episode (in memory)
 * - hands.ts          letting a torrent go and reading what its swarm delivers
 * - trackers.ts       the trackers a torrent is opened and scraped with
 * - query.ts, text.ts the finder's query and attempts; log words
 * - build.ts          buildTorrentSource and indexesOf (the daemon's wiring)
 */

export {
  FILE_FAILURE_KEEP_MS,
  HEALTHY_PEERS,
  HEIGHT_SETTLE_MS,
  MAX_PACK_TRIES,
  MAX_TORRENT_TRIES,
  NO_FILE_LIST,
  PREFERRED_TORRENT_HEIGHT,
  PROBE_SAMPLE_MS,
  PROBE_STALL_BYTES,
  PROBE_STALL_MS,
  SUBTITLE_HEAD_MS,
  SUBTITLES_PENDING,
  SWARM_FAILURE_KEEP_MS,
  TORRENT_DEADLINE_MS,
  TORRENT_HEAR_AFTER_S,
  TORRENT_OPEN_TIMEOUT_MS,
  TORRENT_PROBE_TIMEOUT_MS,
  TORRENT_PROVIDER,
  TORRENT_RACE_WIDTH,
  TORRENT_SETTLE_MS,
  TORRENTS_LEFT,
  TRACKER_PROBE_MS,
  namesCloud,
  namesTorrent,
  torrentLabel,
} from './source/constants.js';
export type {
  DownloadOnDisk,
  FindAnswer,
  FindQuery,
  FindTorrents,
  KeptResolve,
  KeptState,
  MagnetReport,
  OpenedTorrent,
  PackFetch,
  PackHold,
  PackOptions,
  TitleNames,
  TorrentHearer,
  TorrentHearing,
  TorrentProgress,
  TorrentResolve,
  TorrentResolveOptions,
  TorrentSourceOptions,
  TorrentSwarm,
} from './source/types.js';
export { chooseOrder, delivers, PEERS_ALONE_MAX_FILM_KBPS, REMUX_STARVED_BYTES, remuxTimeoutOutcome } from './source/delivery.js';
export { hearAt } from './source/hearing.js';
export { keptFailure } from './source/kept.js';
export { TorrentSource } from './source/torrentSource.js';
export { buildTorrentSource, indexesOf } from './source/build.js';
