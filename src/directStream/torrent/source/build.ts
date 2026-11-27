import { join } from 'node:path';
import { DEFAULT_TORRENT_FINDER_CONFIG, TORRENT_INDEX_NAMES, type Config, type TorrentIndexName } from '../../../config.js';
import { defaultIndexes, findCandidates, IndexHealth, udpScraper, type TorrentIndex } from '../find/index.js';
import { TRACKER_BOOK_FILE, TrackerBook } from '../origins.js';
import type { TrackerLists } from '../trackerLists.js';
import { ffprobeFile } from '../probe.js';
import type { TorrentRemux } from '../remux.js';
import type { SubtitleTier } from '../subtitles/chain.js';
import type { TorrentSyncRequest } from '../subtitles/synced.js';
import type { TorrentMarks } from '../marks.js';
import { TorrentSource } from './torrentSource.js';
import type { TorrentHearer, TorrentSwarm } from './types.js';

/** The finder's index list from the settings: the default indexes at their addresses, minus the ones set `off`. */
export function indexesOf(finder: NonNullable<Config['torrent']>['finder']): TorrentIndex[] {
  const set = finder?.indexes ?? {};
  const bases = Object.fromEntries(Object.entries(set).filter(([, v]) => v !== null && v !== undefined)) as Partial<Record<TorrentIndexName, string>>;
  const off = new Set(TORRENT_INDEX_NAMES.filter((name) => set[name] === null));
  return defaultIndexes({ bases }).filter((index) => !off.has(index.name as TorrentIndexName));
}

/** The daemon's torrent source, or null when torrents are off (`NOTESD_TORRENT=off`) or phase 1 built no TorrentStreams. */
export function buildTorrentSource(
  config: Config,
  torrents: TorrentSwarm | null,
  wiring: {
    localBase: () => string;
    log?: (line: string) => void;
    /** buildSubtitleTiers(...) in src/daemon.ts; none: a torrent session has no subtitle. */
    tiers?: readonly SubtitleTier[];
    /** 1337x and ext.to (phase 9), asked only when the JSON indexes leave no usable candidate. */
    fallback?: readonly TorrentIndex[];
    /** The remux of files Chrome cannot play as is (torrent phase 5); null or unset: such a file is `unplayable`. */
    remux?: TorrentRemux | null;
    /** Wyzie Synced (buildSubtitleSync); null or unset: no subtitle is re-timed. */
    sync?: { start(request: TorrentSyncRequest): unknown } | null;
    /** The public tracker lists (buildTrackerLists in src/daemon.ts, which reads the switches); null or unset: none. */
    lists?: Pick<TrackerLists, 'list'> | null;
    /** The torrent marks (marks.ts): the blacklist and heard languages; null or unset: none. */
    marks?: TorrentMarks | null;
    /** The torrent audio check's hearer (AudioLangCheck over the shared Whisper worker); null or unset: off. */
    hear?: TorrentHearer | null;
  },
): TorrentSource | null {
  if (config.torrent?.enabled !== true || torrents === null) return null;
  const finder = config.torrent.finder ?? DEFAULT_TORRENT_FINDER_CONFIG;
  const indexes = indexesOf(finder);
  // Per daemon run: an index that keeps timing out is left out of the next plays for a while.
  const health = new IndexHealth();
  return new TorrentSource({
    swarm: torrents,
    find: (query, signal, options) =>
      findCandidates(query, {
        signal,
        ...(options?.tried === undefined ? {} : { tried: options.tried }),
        indexes,
        health,
        ...(finder.minSeeds === undefined ? {} : { minSeeds: finder.minSeeds }),
        ...(finder.maxSizeBytes === undefined ? {} : { maxSizeBytes: finder.maxSizeBytes }),
        ...(finder.indexTimeoutMs === undefined ? {} : { timeoutMs: finder.indexTimeoutMs }),
        ...(wiring.fallback === undefined ? {} : { fallback: wiring.fallback }),
      }),
    probe: ffprobeFile({ ffprobeBin: config.movies.ffprobeBin }),
    tiers: wiring.tiers ?? [],
    remux: wiring.remux ?? null,
    sync: wiring.sync ?? null,
    // NOTESD_TORRENT_DISCOVERY=off asks no tracker at all, so nothing is scraped either.
    scrape: config.torrent.discovery ? udpScraper() : null,
    book: new TrackerBook(join(config.torrent.dir, TRACKER_BOOK_FILE)),
    lists: wiring.lists ?? null,
    marks: wiring.marks ?? null,
    hear: wiring.hear ?? null,
    ...(config.torrent.sites === undefined ? {} : { sites: config.torrent.sites.origins }),
    localBase: wiring.localBase,
    ...(config.torrent.subtitleWaitMs === undefined ? {} : { subtitleHeadMs: config.torrent.subtitleWaitMs }),
    ...(wiring.log === undefined ? {} : { log: wiring.log }),
  });
}
