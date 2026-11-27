import type { PlayStatsReport } from './session';

/** A gap between two time updates longer than this is the film standing still, not playing. */
export const PLAYED_GAP_MAX_MS = 1_000;
/** A move of the position larger than this between two time updates is a seek, not play. */
const PLAYED_JUMP_MAX_S = 2;
const LOAD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOAD_LENGTH = 16;

/** A random id of one page load of one session: 16 characters of [A-Za-z0-9_-]. */
export function newLoadId(random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)): string {
  let id = '';
  for (const byte of random(new Uint8Array(LOAD_LENGTH))) id += LOAD_ALPHABET[byte & 63];
  return id;
}

/**
 * The page's counters since it loaded a session (stream-play-log R1.6), sent as `stats` with every
 * position report. Intervals come from `now`, a monotonic clock (performance.now() in the browser):
 * this machine's wall clock steps.
 */
export class PlayStats {
  readonly load: string;
  private readonly now: () => number;
  private readonly loadedAt: number;
  private firstFrameMs: number | null = null;
  private playedMs = 0;
  private lastTick: { at: number; mediaS: number } | null = null;
  private stalls = 0;
  private stalledMs = 0;
  /** When the current freeze began (its first `waiting`); null while the film moves. */
  private stillSince: number | null = null;
  /** The current freeze was counted as a stall. */
  private stallOpen = false;
  private waits = 0;
  private waitedMs = 0;
  private waitSince: number | null = null;
  private errors = 0;

  constructor(now: () => number, load: string = newLoadId()) {
    this.now = now;
    this.load = load;
    this.loadedAt = now();
  }

  /** The film moves on the page for the first time. Later calls change nothing. */
  firstFrame(): void {
    if (this.firstFrameMs === null) this.firstFrameMs = Math.max(0, this.now() - this.loadedAt);
  }

  /**
   * A time update. `advancing`: the film is on the page, not paused and not ended. Play is counted
   * between two updates only when the position moved forward a little (not a seek), each gap at most
   * PLAYED_GAP_MAX_MS.
   */
  tick(mediaS: number, advancing: boolean): void {
    const at = this.now();
    const last = this.lastTick;
    if (advancing && last !== null && mediaS > last.mediaS && mediaS - last.mediaS <= PLAYED_JUMP_MAX_S) {
      this.playedMs += Math.min(Math.max(0, at - last.at), PLAYED_GAP_MAX_MS);
    }
    this.lastTick = advancing ? { at, mediaS } : null;
  }

  /** The film ran out of data while it should play: the moment it stood still (the first `waiting` of a freeze). */
  standingStill(): void {
    if (this.stillSince === null) this.stillSince = this.now();
    this.lastTick = null;
  }

  /**
   * The page's stall timer confirmed the freeze. One freeze is one stall, however often the timer
   * fires again; a freeze while the torrent fetches a missing part is a wait, not a stall.
   */
  stalled(torrentWait: boolean): void {
    if (this.stallOpen || torrentWait || this.stillSince === null) return;
    this.stalls += 1;
    this.stallOpen = true;
  }

  /** The film moves again, was sought or paused: the freeze is over. */
  moved(): void {
    if (this.stallOpen && this.stillSince !== null) this.stalledMs += Math.max(0, this.now() - this.stillSince);
    this.stillSince = null;
    this.stallOpen = false;
  }

  /** The page began waiting for a torrent's missing part ("waiting for the torrent"). */
  waitStarted(): void {
    if (this.waitSince !== null) return;
    this.waits += 1;
    this.waitSince = this.now();
  }

  /** The part arrived, the film moved, or the source changed. */
  waitEnded(): void {
    if (this.waitSince === null) return;
    this.waitedMs += Math.max(0, this.now() - this.waitSince);
    this.waitSince = null;
  }

  error(): void {
    this.errors += 1;
  }

  /** The counters now; a stall or a wait still open counts up to this moment. */
  report(): PlayStatsReport {
    const at = this.now();
    const openStall = this.stallOpen && this.stillSince !== null ? Math.max(0, at - this.stillSince) : 0;
    const openWait = this.waitSince !== null ? Math.max(0, at - this.waitSince) : 0;
    return {
      load: this.load,
      first_frame_ms: this.firstFrameMs === null ? null : Math.round(this.firstFrameMs),
      played_ms: Math.round(this.playedMs),
      stalls: this.stalls,
      stalled_ms: Math.round(this.stalledMs + openStall),
      waits: this.waits,
      waited_ms: Math.round(this.waitedMs + openWait),
      errors: this.errors,
    };
  }
}
