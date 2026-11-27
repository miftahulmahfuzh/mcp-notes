import { isPageVisible, startAdaptivePoll, type AdaptivePoll } from '../lib/pageActive';
import { round1, type PlayerHost } from './playerState';
import { fetchTorrentMap, fetchTorrentStatus, type TimeRange } from './session';

/** How often a torrent session asks for its peers, its speed and what is on disk, while it downloads and the tab shows. */
export const TORRENT_POLL_MS = 2_000;

/** The position is inside a stretch on disk, with the half second of slack loadedGradient joins stretches by. */
export function onDisk(ranges: readonly TimeRange[], t: number): boolean {
  return ranges.some(([from, to]) => t >= from - 0.5 && t < to);
}

/**
 * A map's seconds on the film's own clock. The daemon maps a torrent's bytes to seconds by
 * proportion of the duration it knows, which may not be the one the browser reads from the file.
 */
export function scaleRanges(ranges: readonly TimeRange[], mapDurationS: number | null, filmDurationS: number): TimeRange[] {
  if (mapDurationS === null || !(mapDurationS > 0) || !(filmDurationS > 0) || Math.abs(mapDurationS - filmDurationS) < 0.5) return [...ranges];
  const k = filmDurationS / mapDurationS;
  return ranges.map(([from, to]): TimeRange => [from * k, to * k]);
}

/**
 * A torrent session's live numbers, its map of what is on disk (`cachedRanges`), and the wait for a
 * part that is not on disk yet (`torrent.fetching`, counted as a wait, never a stall). Reads only.
 */
export class TorrentWait {
  private readonly host: PlayerHost;
  /** The torrent whose numbers and map are being read; null once it is complete, failed or left. */
  private hash: string | null = null;
  private poll: AdaptivePoll | null = null;

  constructor(host: PlayerHost) {
    this.host = host;
  }

  /**
   * Keeps a torrent session's numbers and `cachedRanges` current: now, then every TORRENT_POLL_MS
   * while the tab shows, until the download is complete or failed. A hidden tab asks nothing and
   * asks again as soon as it shows (startAdaptivePoll).
   */
  follow(infoHash: string): void {
    this.stop();
    this.hash = infoHash;
    const run = async (): Promise<boolean> => {
      const done = await this.read(infoHash);
      if (done && this.hash === infoHash) this.stop();
      return true;
    };
    if (isPageVisible()) void run();
    this.poll = startAdaptivePoll({ baseMs: TORRENT_POLL_MS, run });
  }

  stop(): void {
    this.poll?.stop();
    this.poll = null;
    this.hash = null;
  }

  /** One read of the torrent's status and map. True once there is nothing more to follow (complete or failed). */
  private async read(infoHash: string): Promise<boolean> {
    const { video, deps } = this.host;
    const [status, map] = await Promise.all([fetchTorrentStatus(infoHash, deps.fetch), fetchTorrentMap(infoHash, deps.fetch)]);
    const state = this.host.state();
    const torrent = state.torrent;
    if (this.host.disposed() || this.hash !== infoHash || torrent === null || torrent.infoHash !== infoHash) return false;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    this.host.set({
      // A map the daemon could not give leaves the bar as it was.
      cachedRanges: map === null ? state.cachedRanges : scaleRanges(map.ranges, map.durationS, duration),
      torrent: status === null ? torrent : { ...torrent, state: status.state, peers: status.peers, downKbps: status.downKbps, progress: status.progress },
    });
    const now = status?.state ?? torrent.state;
    if (now === 'downloading') return false;
    this.host.note(now === 'ready' ? `torrent ${infoHash.slice(0, 8)} on disk` : `torrent ${infoHash.slice(0, 8)} failed`);
    return true;
  }

  /**
   * A torrent's play or a seek reached a part that is not on disk yet (`on`), or that part arrived.
   * Only a torrent session waits this way, and a part on disk is never waited for.
   */
  markFetching(on: boolean): void {
    const state = this.host.state();
    const torrent = state.torrent;
    const video = this.host.video;
    if (torrent === null || torrent.fetching === on) return;
    if (on && (torrent.state === 'ready' || onDisk(state.cachedRanges, video.currentTime))) return;
    this.host.set({ torrent: { ...torrent, fetching: on } });
    if (on) {
      this.host.stats().waitStarted();
      this.host.note(`waiting for the torrent at ${round1(video.currentTime)} s`);
    } else {
      this.host.stats().waitEnded();
    }
  }

  /** The part a torrent's play waited for is here: the seek landed, or the film can play. */
  readonly arrived = (): void => {
    this.markFetching(false);
  };
}
