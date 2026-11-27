import { round1, type Stage } from './playerState';
import { postEvents, type PlayerLogLine } from './session';

/** The daemon refuses a longer line or a bigger batch (src/http/streamEvidenceApi.ts). */
export const EVENT_TEXT_MAX = 2_000;
export const EVENTS_PER_POST = 50;

/** The film's position for a log line, to a tenth of a second; null when the browser has none. */
export function positionOf(video: Pick<HTMLVideoElement, 'currentTime'>): number | null {
  const t = video.currentTime;
  return Number.isFinite(t) && t >= 0 ? round1(t) : null;
}

/** Seconds buffered ahead of the position: the end of the range holding it, else 0; null when the browser cannot say. */
export function bufferAheadOf(video: Pick<HTMLVideoElement, 'currentTime' | 'buffered'>): number | null {
  try {
    const ranges = video.buffered;
    const t = video.currentTime;
    if (ranges === undefined || ranges === null || !Number.isFinite(t)) return null;
    for (let i = 0; i < ranges.length; i += 1) {
      if (ranges.start(i) <= t + 0.5 && t <= ranges.end(i)) return round1(Math.max(0, ranges.end(i) - t));
    }
    return 0;
  } catch {
    return null;
  }
}

/**
 * Every log line also goes to the daemon's stream evidence log (R2.2): errors, refreshes, subtitle
 * failures, and whatever else the controller's note() is given. Lines are batched per tick, so an
 * error travels with the line before it, each under the session it was written in. Fire and forget:
 * nothing here waits or throws.
 */
export class EvidenceLog {
  /** Log lines waiting for this tick's post to the daemon, each under the session it was written in. */
  private unsent: { sessionId: string; line: PlayerLogLine }[] = [];

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** `sessionId` and `stage` as they are when the line is written, not when it is posted. */
  send(sessionId: string, stage: Stage, text: string): void {
    this.unsent.push({
      sessionId,
      line: {
        text: text.slice(0, EVENT_TEXT_MAX),
        at: new Date().toISOString(),
        stage,
        position_s: positionOf(this.video),
        buffer_s: bufferAheadOf(this.video),
      },
    });
    if (this.unsent.length === 1) queueMicrotask(this.flush);
  }

  private readonly flush = (): void => {
    const batch = this.unsent.splice(0);
    const bySession = new Map<string, PlayerLogLine[]>();
    for (const { sessionId, line } of batch) {
      const lines = bySession.get(sessionId) ?? [];
      lines.push(line);
      bySession.set(sessionId, lines);
    }
    for (const [sessionId, lines] of bySession) {
      for (let i = 0; i < lines.length; i += EVENTS_PER_POST) void postEvents(sessionId, lines.slice(i, i + EVENTS_PER_POST), this.fetchImpl);
    }
  };
}
