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
 * Among racers that do not deliver, a racer whose delivery ratio (rate / the film's bitrate) is at least this many times
 * another's is played before it, ahead of the English subtitle file (decided 2026-11-27, option 2 of
 * docs/plans/2026-11-27-torrent-ranking-evidence.md): Miracle in Cell No. 7's Russian release (1.5 of 6.6 Mbps, an
 * English file) was chosen over NOMA (2.9 of 3.1 Mbps), stalled 97 s in 169 s, and the play switched to NOMA itself.
 * The margin keeps a ratio measured over a few seconds from a few peers from overturning the subtitle file on noise.
 */
export const RATIO_MARGIN = 1.5;

/** The rate over the film's bitrate; null when either is unknown. */
export function deliveryRatio(d: Delivery | null): number | null {
  return d !== null && d.filmKbps !== null && d.filmKbps > 0 ? d.downKbps / d.filmKbps : null;
}

type Racer = { position: number; english: boolean; height?: ReleaseHeight | null };

/** How many times `a`'s ratio is `b`'s, when `a` wins on it: neither delivers, same height, both known, `a` above zero and at least RATIO_MARGIN times `b`. Else null. */
function ratioWin<T extends Racer>(a: { p: T; d: Delivery | null }, b: { p: T; d: Delivery | null }): number | null {
  if (delivers(a.d) || delivers(b.d) || heightRank(a.p.height ?? null) !== heightRank(b.p.height ?? null)) return null;
  const ra = deliveryRatio(a.d);
  const rb = deliveryRatio(b.d);
  if (ra === null || rb === null || ra <= 0 || ra < RATIO_MARGIN * rb) return null;
  return rb === 0 ? Number.POSITIVE_INFINITY : ra / rb;
}

/**
 * The torrents whose headers arrived, best first: one whose swarm delivers before one that does not, then the
 * preferred height (1080p, then 720p, 2160p, 480p: HEIGHT_PREFERENCE), then, when neither delivers, one whose delivery
 * ratio is at least RATIO_MARGIN times the other's, then one whose files hold an English subtitle file (R3.2), then
 * the one with more peers connected, then the finder's order. The margin is not an order of its own (1.0, 1.4 and 1.6
 * do not sort), so the racers are taken one at a time: the first by the other steps, unless a racer still left beats
 * it on the ratio, in which case that one (and so on along the list).
 */
export function chooseOrder<T extends Racer>(passed: readonly T[], deliveryOf: (p: T) => Delivery | null): T[] {
  const rest = passed
    .map((p) => ({ p, d: deliveryOf(p) }))
    .sort(
      (a, b) =>
        Number(delivers(b.d)) - Number(delivers(a.d)) ||
        heightRank(a.p.height ?? null) - heightRank(b.p.height ?? null) ||
        Number(b.p.english) - Number(a.p.english) ||
        (b.d?.peers ?? 0) - (a.d?.peers ?? 0) ||
        a.p.position - b.p.position,
    );
  const out: T[] = [];
  while (rest.length > 0) {
    let pick = 0;
    for (let i = 1; i < rest.length; i++) if (ratioWin(rest[i]!, rest[pick]!) !== null) pick = i;
    out.push(rest.splice(pick, 1)[0]!.p);
  }
  return out;
}

/**
 * Which step of chooseOrder put `best` before `next` (the racer after it), for the "was chosen" log line and attempt
 * detail: `chosen: it delivers`, `chosen for its height`, `chosen: 4.1x the delivery of the next`, `chosen for its
 * English subtitle file`, `chosen for more peers`, `chosen in the finder's order`; plain `chosen` with no rival.
 */
export function chosenText<T extends Racer>(best: T, next: T | null, deliveryOf: (p: T) => Delivery | null): string {
  if (next === null) return 'chosen';
  const a = { p: best, d: deliveryOf(best) };
  const b = { p: next, d: deliveryOf(next) };
  if (delivers(a.d) !== delivers(b.d)) return 'chosen: it delivers';
  if (heightRank(best.height ?? null) !== heightRank(next.height ?? null)) return 'chosen for its height';
  const times = ratioWin(a, b);
  if (times !== null) return Number.isFinite(times) ? `chosen: ${times.toFixed(1)}x the delivery of the next` : 'chosen: the next delivers nothing';
  if (best.english !== next.english) return 'chosen for its English subtitle file';
  if ((a.d?.peers ?? 0) !== (b.d?.peers ?? 0)) return 'chosen for more peers';
  return "chosen in the finder's order";
}

/** A delivery for an attempt's detail and a log line: ` listed; 5 peers connected, 3.2 Mbps for a 2.1 Mbps film`; empty when unknown. */
export function deliveryText(d: Delivery | null): string {
  if (d === null) return '';
  return ` listed; ${d.peers} peer${d.peers === 1 ? '' : 's'} connected, ${mbps(d.downKbps)} Mbps${d.filmKbps === null ? '' : ` for a ${mbps(d.filmKbps)} Mbps film`}`;
}
