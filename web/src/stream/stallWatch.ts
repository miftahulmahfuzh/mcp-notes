import { round1, type PlayerHost } from './playerState';

/** The film waiting for data this long is a stall; a shorter wait is not counted. */
export const STALL_MIN_MS = 1_500;
/** This many stalls (or network recoveries) within the window, and the page asks for another source. */
export const STALLS_TO_SWITCH = 3;
/**
 * A torrent session asks only after this many stalls within the window: a torrent buffers while it fills, so the
 * daemon also checks that its swarm delivers less than the film's bitrate before it moves the play (autoSwitch).
 */
export const TORRENT_STALLS_TO_SWITCH = 4;
export const STALL_WINDOW_MS = 120_000;
/** A film still waiting is counted again this often. */
export const STALL_REPEAT_MS = 10_000;
/** A wait this soon after a seek is the seek's own. */
export const SEEK_GRACE_MS = 5_000;

/**
 * What counts as a stall, and when stalls ask for another source. The film ran out of data while it
 * should be playing: a wait that outlasts STALL_MIN_MS is a stall; a seek's own wait (within
 * SEEK_GRACE_MS of it), a pause and the first load are not. A film that stays frozen is counted again
 * every STALL_REPEAT_MS, so one long freeze moves the source as three short ones do. A network
 * recovery counts as a stall too (add()). STALLS_TO_SWITCH stalls within STALL_WINDOW_MS (a torrent:
 * TORRENT_STALLS_TO_SWITCH) call `tooMany`. The play's counters (playStats.ts) hear every freeze.
 * Stall times are on Date.now(), as the window and cooldowns have always been.
 */
export class StallWatch {
  private readonly host: PlayerHost;
  private readonly tooMany: () => void;
  /** When the film stalled lately (ms), for the move to another source. */
  private stalls: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSeekAt = 0;

  constructor(host: PlayerHost, tooMany: () => void) {
    this.host = host;
    this.tooMany = tooMany;
  }

  /** The stalls within the window when last counted. */
  get count(): number {
    return this.stalls.length;
  }

  /** The stalls counted so far are forgotten: an ask for another source, a new stream. */
  reset(): void {
    this.stalls = [];
  }

  clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** `seeking`: a seek ends a freeze; the wait it starts is timed afresh. */
  seeked(): void {
    this.lastSeekAt = Date.now();
    this.clearTimer();
    this.host.stats().moved();
  }

  /** `waiting`: the film ran out of data. Counted only while it is ready and not paused. */
  waiting(): void {
    if (this.host.state().stage !== 'ready' || this.host.video.paused) return;
    this.host.stats().standingStill();
    // A seek's own wait is not a stall, unless it outlasts the grace.
    this.arm(STALL_MIN_MS + Math.max(0, this.lastSeekAt + SEEK_GRACE_MS - Date.now()));
  }

  /** `playing`: the film moves again, and the first frame is counted. */
  moving(): void {
    this.clearTimer();
    this.host.stats().moved();
    if (this.host.onFilm() && !this.host.video.paused) this.host.stats().firstFrame();
  }

  /** `pause`: a pause is not a stall; a freeze in progress ends here. */
  paused(): void {
    this.clearTimer();
    this.host.stats().moved();
  }

  /** One stall (or a network recovery), within the window; enough of them ask for another source. */
  add(): void {
    const now = Date.now();
    this.stalls = [...this.stalls.filter((at) => now - at < STALL_WINDOW_MS), now];
    if (this.stalls.length >= (this.host.session()?.torrent != null ? TORRENT_STALLS_TO_SWITCH : STALLS_TO_SWITCH)) this.tooMany();
  }

  // `playing`, a seek and a pause end the wait.
  private arm(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      const { host } = this;
      if (host.disposed() || host.state().stage !== 'ready' || host.video.paused) return;
      host.note(`stalled at ${round1(host.video.currentTime)} s`);
      // The play log counts the freeze once, and not at all when it is a torrent's wait.
      host.stats().stalled(host.state().torrent?.fetching === true);
      this.add();
      if (host.state().stage === 'ready') this.arm(STALL_REPEAT_MS);
    }, delayMs);
  }
}
