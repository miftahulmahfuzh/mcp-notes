import type { SessionTorrent } from '../../sessions.js';
import type { MediaProbe } from '../probe.js';
import type { TorrentPick, TorrentStats } from '../types.js';
import { TORRENT_OPEN_TIMEOUT_MS } from './constants.js';
import { filmKbpsOf, type Delivery } from './delivery.js';
import { mbps, messageOf, plural } from './text.js';
import type { Passed, TorrentSwarm } from './types.js';

/**
 * The torrent source's hands on the swarm (phase 1's TorrentStreams): letting a torrent go the right way (a hold given
 * back, or nobody's hold touched), recording a length, and reading what a swarm received and delivers. Every call is
 * safe: a swarm that throws is logged or read as "cannot say", never thrown into a play.
 */
export class SwarmHands {
  constructor(
    private readonly swarm: TorrentSwarm,
    private readonly log: (line: string) => void,
  ) {}

  /** `release`, behind the caller: one user fewer, and with none left the daemon leaves its swarm. */
  letGo(infoHash: string): void {
    void Promise.resolve()
      .then(() => this.swarm.release(infoHash))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not release ${infoHash}: ${messageOf(err)}`));
  }

  /**
   * Lets go of a torrent that will not play, leaving its swarm at once where the swarm can. `held`: this caller's
   * `use` took a hold, which is given back (`drop`); without one nobody's hold is touched (`discard`).
   */
  dropNow(infoHash: string, held: boolean): void {
    const swarm = this.swarm;
    const letGo = held ? swarm.drop : swarm.discard;
    void Promise.resolve()
      .then(() => (letGo === undefined ? swarm.release(infoHash) : letGo.call(swarm, infoHash)))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not release ${infoHash}: ${messageOf(err)}`));
  }

  /** Phase 1's map turns bytes into seconds once it knows the length (the page's grey bar). */
  noteDuration(infoHash: string, probe: MediaProbe, fileIndex: number): void {
    if (probe.durationS === null) return;
    const seconds = probe.durationS;
    void Promise.resolve()
      .then(() => this.swarm.setDuration(infoHash, seconds, fileIndex))
      .catch((err: unknown) => this.log(`[notesd] torrent: could not record the length of ${infoHash}: ${messageOf(err)}`));
  }

  /** The bytes a torrent received so far; null when the swarm cannot say or the torrent is gone. */
  receivedBytes(infoHash: string): number | null {
    try {
      return this.swarm.received?.(infoHash) ?? null;
    } catch {
      return null;
    }
  }

  /** What a torrent received so far, for a log line: `4.1 MB, 5 peers, 1.3 Mbps`; empty words when the swarm cannot say. */
  receivedText(infoHash: string): string {
    let bytes: number | null = null;
    let stats: Pick<TorrentStats, 'peers' | 'down_kbps'> | null = null;
    try {
      bytes = this.swarm.received?.(infoHash) ?? null;
      stats = this.swarm.stats?.(infoHash) ?? null;
    } catch {
      // A torrent that is gone says nothing.
    }
    const parts = [bytes === null ? null : `${(bytes / 1e6).toFixed(1)} MB received`, stats === null ? null : `${plural(stats.peers, 'peer')}, ${mbps(stats.down_kbps)} Mbps`].filter((x) => x !== null);
    return parts.length === 0 ? 'nothing known of its swarm' : parts.join(', ');
  }

  /** The peers and rate of a torrent now; null when it is not in the swarm, the swarm cannot say, or it throws. */
  private statsOf(infoHash: string): Pick<TorrentStats, 'peers' | 'down_kbps'> | null {
    try {
      return this.swarm.stats?.(infoHash) ?? null;
    } catch {
      return null;
    }
  }

  /** What a racer's swarm delivers now, with the film's bitrate from its file's length and the probe's duration. */
  deliveryOf(p: Pick<Passed, 'c' | 'opened' | 'video' | 'probe'>): Delivery | null {
    const stats = this.statsOf(p.c.infoHash);
    if (stats === null) return null;
    const filmKbps = filmKbpsOf(p.opened.files.find((f) => f.index === p.video)?.length ?? null, p.probe.durationS);
    return { peers: stats.peers, downKbps: stats.down_kbps, filmKbps };
  }

  /**
   * What the session's swarm delivers now: the peers, the rate and the film's own bitrate (null when unknown). Null
   * when the torrent is not in the swarm or the engine cannot say.
   */
  delivery(torrent: SessionTorrent): { peers: number; downKbps: number; filmKbps: number | null } | null {
    const stats = this.statsOf(torrent.infoHash);
    return stats === null ? null : { peers: stats.peers, downKbps: stats.down_kbps, filmKbps: torrent.filmKbps ?? null };
  }

  /** `use` for one named episode of a torrent opened before (TorrentStreams.useSlot); a swarm without it is opened again for the episode. */
  async useSlotOf(pick: TorrentPick, fileIndexes: readonly number[]): Promise<void> {
    const swarm = this.swarm;
    if (swarm.useSlot !== undefined) {
      await swarm.useSlot(pick, fileIndexes);
      return;
    }
    await swarm.open(pick, { timeoutMs: TORRENT_OPEN_TIMEOUT_MS });
    await swarm.use(pick.infoHash, fileIndexes);
  }
}
