import { heightRank, type ReleaseHeight } from '../find/index.js';
import { REMUX_SEGMENT_S } from '../remux.js';
import { HEALTHY_PEERS, PROBE_STALL_BYTES } from './constants.js';
import { mbps } from './text.js';

/**
 * Which racer plays: what a swarm delivers, read against the film's own bitrate. Pure: the race (race.ts) asks the
 * swarm for the numbers and hands them here.
 */

/** What a swarm delivers for a file, as far as it is known: the peers connected, the rate, and the film's own bitrate. */
export interface Delivery {
  peers: number;
  downKbps: number;
  /** The file's bytes over its length; null when the probe gave no length. */
  filmKbps: number | null;
}

/** A file's bitrate in kbit/s: its bytes over its length; null when either is unknown. */
export function filmKbpsOf(length: number | null, durationS: number | null): number | null {
  return length !== null && durationS !== null && durationS > 0 ? Math.round((length * 8) / 1000 / durationS) : null;
}

/** Without the film's bitrate, a remux that received less than this while it waited was starved, not refused by ffmpeg. */
export const REMUX_STARVED_BYTES = 8 * 1024 * 1024;

/**
 * A remux that wrote no segment in time, read against what the swarm delivered meanwhile: under two segments' worth of
 * the film (or REMUX_STARVED_BYTES) the swarm starved it (`no_stream`, like a probe that stalled); otherwise ffmpeg had
 * the bytes and still wrote nothing (`unplayable`). Common Side Effects (FLUX, h264/eac3) was called unplayable after
 * 59 s on a connection whose reference download timed out at the same moment.
 */
export function remuxTimeoutOutcome(receivedBytes: number | null, filmKbps: number | null): 'no_stream' | 'unplayable' {
  if (receivedBytes === null) return 'unplayable';
  const needed = filmKbps === null ? REMUX_STARVED_BYTES : Math.max(PROBE_STALL_BYTES, (filmKbps * 1000 * REMUX_SEGMENT_S * 2) / 8);
  return receivedBytes < needed ? 'no_stream' : 'unplayable';
}

/**
 * Above this bitrate many peers are no promise: this machine's link carries about 9 Mbps, and Amélie's 18.3 Mbps
 * BDRip (four audio tracks) was chosen for its 7 peers and never moved past its first frame.
 */
export const PEERS_ALONE_MAX_FILM_KBPS = 8_000;

/**
 * True when the swarm looks able to keep ahead of the picture: a rate at or above the film's bitrate, or enough peers
 * for a film whose bitrate this link can carry (PEERS_ALONE_MAX_FILM_KBPS; unknown counts as carried).
 */
export function delivers(d: Delivery | null): boolean {
  if (d === null) return false;
  if (d.filmKbps !== null && d.downKbps >= d.filmKbps) return true;
  return d.peers >= HEALTHY_PEERS && (d.filmKbps === null || d.filmKbps <= PEERS_ALONE_MAX_FILM_KBPS);
}

/**
 * The torrents whose headers arrived, best first: one whose swarm delivers before one that does not, then the
 * preferred height (1080p, then 720p, 2160p, 480p: HEIGHT_PREFERENCE), then one whose files hold an English subtitle
 * file (R3.2), then the one with more peers connected, then the finder's order.
 */
export function chooseOrder<T extends { position: number; english: boolean; height?: ReleaseHeight | null }>(passed: readonly T[], deliveryOf: (p: T) => Delivery | null): T[] {
  const scored = passed.map((p) => ({ p, d: deliveryOf(p) }));
  return scored
    .sort(
      (a, b) =>
        Number(delivers(b.d)) - Number(delivers(a.d)) ||
        heightRank(a.p.height ?? null) - heightRank(b.p.height ?? null) ||
        Number(b.p.english) - Number(a.p.english) ||
        (b.d?.peers ?? 0) - (a.d?.peers ?? 0) ||
        a.p.position - b.p.position,
    )
    .map((x) => x.p);
}

/** A delivery for an attempt's detail and a log line: ` listed; 5 peers connected, 3.2 Mbps for a 2.1 Mbps film`; empty when unknown. */
export function deliveryText(d: Delivery | null): string {
  if (d === null) return '';
  return ` listed; ${d.peers} peer${d.peers === 1 ? '' : 's'} connected, ${mbps(d.downKbps)} Mbps${d.filmKbps === null ? '' : ` for a ${mbps(d.filmKbps)} Mbps film`}`;
}
