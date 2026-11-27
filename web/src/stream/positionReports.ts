import { round1, type PlayerHost } from './playerState';
import { postPosition, type PositionAnswer, type PositionReport } from './session';

export const POSITION_INTERVAL_MS = 5_000;

/** What reporting positions needs of the controller besides the host. */
export interface ReportHost extends PlayerHost {
  /** A position reported for `sessionId` (not the end): kept for a carry-on after a daemon restart. */
  rememberPosition(sessionId: string, positionS: number): void;
  /** The daemon's answer to a report sent for `asked`: what changed behind the play. */
  onAnswer(asked: string, answer: PositionAnswer): void;
}

/** The kinds of report beyond a plain position. */
export interface ReportExtra {
  ended?: boolean;
  beat?: boolean;
  closed?: boolean;
}

/** The body of a position report, or null when the film has no position to report yet. */
export function positionReport(video: Pick<HTMLVideoElement, 'currentTime' | 'duration' | 'paused'>, extra: ReportExtra, stats: PositionReport['stats']): PositionReport | null {
  const ended = extra.ended === true;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  const position = ended && duration !== null ? duration : video.currentTime;
  if (!(position > 0)) return null;
  return {
    position_s: round1(position),
    duration_s: duration === null ? null : round1(duration),
    ended,
    paused: !ended && video.paused,
    ...(extra.beat === true ? { beat: true } : {}),
    ...(extra.closed === true ? { closed: true } : {}),
    stats,
  };
}

/**
 * The position reports: every POSITION_INTERVAL_MS while the film is on the page (a beat while it is
 * paused, so the Movies page knows the film is still on screen: src/movies/streamLive.ts), at once on
 * play and pause, at the end, and when the page closes. Each carries the play's counters
 * (playStats.ts). A recovery is still the film on screen: it plays on from its buffer.
 */
export class PositionReports {
  private readonly host: ReportHost;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(host: ReportHost) {
    this.host = host;
  }

  start(): void {
    this.timer = setInterval(this.tick, POSITION_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  send(extra: ReportExtra = {}): void {
    const { host } = this;
    if (host.session() === null) return;
    const report = positionReport(host.video, extra, host.stats().report());
    if (report === null) return;
    host.set({ reportedS: report.position_s });
    const asked = host.sessionId();
    if (!report.ended) host.rememberPosition(asked, report.position_s);
    void postPosition(asked, report, host.deps.fetch).then((answer) => host.onAnswer(asked, answer));
  }

  // Every 5 s while the page is open: the position while it plays, and a beat while it is paused.
  private readonly tick = (): void => {
    if (!this.host.onFilm() || this.host.video.ended) return;
    this.send(this.host.video.paused ? { beat: true } : {});
  };

  /** Play after a pause: say so at once, not at the next tick. */
  readonly played = (): void => {
    if (this.host.onFilm() && !this.host.video.ended) this.send();
  };

  readonly ended = (): void => {
    if (this.host.onFilm()) this.send({ ended: true });
  };

  /** The tab or the window closes: the last position, and the film is no longer on screen. */
  readonly closed = (): void => {
    if (this.host.onFilm() && !this.host.video.ended) this.send({ closed: true });
  };
}
