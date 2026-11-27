/**
 * The torrent source's numbers and names (TorrentSource, ../source.ts re-exports every exported one). Every other
 * module of the torrent source reads its limits from here, so a budget or a width is changed in one place.
 */

/** The provider every torrent session carries (movie_plays, the stream on screen, the player). */
export const TORRENT_PROVIDER = 'Torrent';
/** Seconds after where a play starts that a torrent's audio is heard (torrent audio check): its pieces are fetched soon anyway. */
export const TORRENT_HEAR_AFTER_S = 300;
/** How a torrent attempt whose swarm sent no file list in time begins (no peer answered): torrentWarp.ts reads it. */
export const NO_FILE_LIST = 'no file list from the swarm in time';
/** Torrents opened per play (and per shuffle) before the answer is no_source: two rounds of TORRENT_RACE_WIDTH. */
export const MAX_TORRENT_TRIES = 6;
/** A torrent whose swarm did not deliver is left out of the next plays of the title for this long: swarms wake up. */
export const SWARM_FAILURE_KEEP_MS = 30 * 60_000;
/** A torrent whose file will not change (a dub, a file Chrome cannot play, no file of the episode) is left out this long. */
export const FILE_FAILURE_KEEP_MS = 24 * 60 * 60_000;
/** The attempt a failed play ends with: how many torrents were found and not tried, so asking again tries those. */
export const TORRENTS_LEFT = 'Torrents: not tried yet';
/** A new tracker from a pasted magnet must answer a scrape within this to be kept (learnMagnet). */
export const TRACKER_PROBE_MS = 2_500;
/** The height a torrent play prefers (HEIGHT_PREFERENCE's first): a remembered torrent of another height goes after the indexes. */
export const PREFERRED_TORRENT_HEIGHT = 1080;
/** Torrents opened side by side: the index's seed count is not the swarm, so the swarms themselves are asked. */
export const TORRENT_RACE_WIDTH = 3;
/** Once one torrent's header has arrived, the others still opening get this long to arrive too before one is chosen. */
export const TORRENT_SETTLE_MS = 2_000;
/** A swarm with at least this many peers connected is not thin (/report-stream-bug calls 5 or fewer thin). */
export const HEALTHY_PEERS = 6;
/** The subtitle chain may hold the play's answer this long (a kept file answers at once); after it the chain goes on behind the play. */
export const SUBTITLE_HEAD_MS = 1_500;
/** The attempt a play answers while its subtitle chain is still running. */
export const SUBTITLES_PENDING = 'Subtitles: pending';
/** A torrent play's whole budget: finding, opening and probing (the subtitle chain has its own, SUBTITLE_BUDGET_MS). */
export const TORRENT_DEADLINE_MS = 90_000;
/** One torrent's file list must arrive within this. */
export const TORRENT_OPEN_TIMEOUT_MS = 20_000;
/** ffprobe must have read the file's header within this when the swarm cannot say what it received (tests' fakes). */
export const TORRENT_PROBE_TIMEOUT_MS = 30_000;
/**
 * A header probe goes on while the swarm delivers, up to the play's budget: it is given up only when the torrent
 * received less than PROBE_STALL_BYTES in the last PROBE_STALL_MS. A flat 30 s dropped three well seeded 1080p
 * torrents racing on a 9 Mbps link (a YTS MP4's header is ~10 MB, so each needed ~35 s with the link split three ways).
 */
export const PROBE_STALL_MS = 15_000;
export const PROBE_STALL_BYTES = 512 * 1024;
/** How often a probe's swarm is looked at. */
export const PROBE_SAMPLE_MS = 1_000;
/** Once a header of a less preferred height arrived, a racer of a preferred height (1080p) still opening gets up to this long to arrive too. */
export const HEIGHT_SETTLE_MS = 20_000;
/** The least time a probe is given, even late in the budget. Internal: not re-exported by ../source.ts. */
export const PROBE_MIN_MS = 5_000;
/** Season packs opened per season download before the answer is no_pack (downloads/season.ts then downloads each episode alone). */
export const MAX_PACK_TRIES = 3;

/** True for the provider name that asks the torrent source ("torrent", any case). */
export const namesTorrent = (provider: string | null | undefined): boolean => (provider ?? '').trim().toLowerCase() === 'torrent';

/** True for the provider name that asks the cloud providers and never a torrent ("cloud", any case). */
export const namesCloud = (provider: string | null | undefined): boolean => (provider ?? '').trim().toLowerCase() === 'cloud';

/** An attempt's provider for one torrent: `Torrent: <release name>`. */
export const torrentLabel = (name: string): string => `${TORRENT_PROVIDER}: ${name}`;
