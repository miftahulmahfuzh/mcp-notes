import type { StreamTarget } from './types.js';

/** A stream counts as on screen for this long after its player page last reported (it reports every 5 s, paused too). */
export const STREAM_LIVE_TTL_MS = 20_000;

/** One report of the player page, as the live state reads it. */
export interface StreamLiveReport {
  sessionId: string;
  titleId: string;
  ref: StreamTarget;
  provider: string;
  positionS: number;
  durationS: number | null;
  paused: boolean;
}

/** The stream on screen now, as `GET /api/movies/player` answers it (`stream`). */
export interface StreamLiveSnapshot {
  session_id: string;
  title_id: string;
  /** Null for a film. */
  season: number | null;
  episode: number | null;
  provider: string;
  state: 'playing' | 'paused';
  /** Seconds. */
  position: number;
  duration: number | null;
  last_report_at: string;
}

/**
 * Which stream the player page shows right now, for the Movies page's "playing" and "paused" marks
 * (the stream twin of the followed VLC). In memory only, one stream at a time: the page that
 * reported last. It ends when that page says the film ended or the page closes, and by itself
 * STREAM_LIVE_TTL_MS after the last report (a closed tab whose last word was lost).
 */
export class StreamLive {
  private latest: { report: StreamLiveReport; at: Date } | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The page reported: it is the stream on screen. */
  report(report: StreamLiveReport): void {
    this.latest = { report, at: this.now() };
  }

  /** The page said its film ended or it is closing. Another session's stream is left alone. */
  end(sessionId: string): void {
    if (this.latest?.report.sessionId === sessionId) this.latest = null;
  }

  /** True while `sessionId` is the stream on screen. */
  has(sessionId: string): boolean {
    return this.current()?.session_id === sessionId;
  }

  current(): StreamLiveSnapshot | null {
    const latest = this.latest;
    if (latest === null) return null;
    if (this.now().getTime() - latest.at.getTime() > STREAM_LIVE_TTL_MS) {
      this.latest = null;
      return null;
    }
    const { report, at } = latest;
    return {
      session_id: report.sessionId,
      title_id: report.titleId,
      season: report.ref.kind === 'tv' ? (report.ref.season ?? null) : null,
      episode: report.ref.kind === 'tv' ? (report.ref.episode ?? null) : null,
      provider: report.provider,
      state: report.paused ? 'paused' : 'playing',
      position: report.positionS,
      duration: report.durationS,
      last_report_at: at.toISOString(),
    };
  }
}
