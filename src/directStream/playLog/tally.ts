import { PLAY_LOG_MAX_LOADS, type PageStats, type PlayTotals } from './types.js';

export const NO_TOTALS: PlayTotals = { playedMs: 0, stalls: 0, stalledMs: 0, waits: 0, waitedMs: 0, errors: 0 };

function totalsOf(s: PageStats): PlayTotals {
  return { playedMs: s.playedMs, stalls: s.stalls, stalledMs: s.stalledMs, waits: s.waits, waitedMs: s.waitedMs, errors: s.errors };
}

function plus(a: PlayTotals, b: PlayTotals): PlayTotals {
  return { playedMs: a.playedMs + b.playedMs, stalls: a.stalls + b.stalls, stalledMs: a.stalledMs + b.stalledMs, waits: a.waits + b.waits, waitedMs: a.waitedMs + b.waitedMs, errors: a.errors + b.errors };
}

/** A load's counters only grow: a late report that arrives after a newer one keeps the larger figures. */
function most(a: PlayTotals, b: PlayTotals): PlayTotals {
  return {
    playedMs: Math.max(a.playedMs, b.playedMs),
    stalls: Math.max(a.stalls, b.stalls),
    stalledMs: Math.max(a.stalledMs, b.stalledMs),
    waits: Math.max(a.waits, b.waits),
    waitedMs: Math.max(a.waitedMs, b.waitedMs),
    errors: Math.max(a.errors, b.errors),
  };
}

/**
 * One session's page counters, in memory. Each report carries its load's figures since that load, so the latest of
 * each load counts once and the session's totals are their sum. The first frame is the first load's that had one.
 */
export class StatsTally {
  private readonly loads = new Map<string, PlayTotals>();
  private folded: PlayTotals = NO_TOTALS;
  private first: number | null = null;

  add(stats: PageStats): void {
    if (this.first === null && stats.firstFrameMs !== null) this.first = stats.firstFrameMs;
    const now = totalsOf(stats);
    const before = this.loads.get(stats.load);
    // Kept in the order loads last reported: the oldest is folded first.
    this.loads.delete(stats.load);
    this.loads.set(stats.load, before === undefined ? now : most(before, now));
    while (this.loads.size > PLAY_LOG_MAX_LOADS) {
      const oldest = this.loads.keys().next().value;
      if (oldest === undefined) break;
      this.folded = plus(this.folded, this.loads.get(oldest) ?? NO_TOTALS);
      this.loads.delete(oldest);
    }
  }

  get firstFrameMs(): number | null {
    return this.first;
  }

  totals(): PlayTotals {
    let sum = this.folded;
    for (const t of this.loads.values()) sum = plus(sum, t);
    return sum;
  }
}
