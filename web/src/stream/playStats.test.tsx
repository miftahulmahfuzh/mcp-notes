import { describe, expect, it } from 'vitest';
import { PLAYED_GAP_MAX_MS, PlayStats, newLoadId } from './playStats';

describe('newLoadId', () => {
  it('is 16 characters of [A-Za-z0-9_-], random each time', () => {
    const a = newLoadId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newLoadId()).not.toBe(a);
    expect(newLoadId((bytes) => bytes.fill(0))).toBe('AAAAAAAAAAAAAAAA');
    expect(newLoadId((bytes) => bytes.fill(255))).toBe('________________');
  });
});

describe('PlayStats', () => {
  function counters() {
    const clock = { ms: 100 };
    const stats = new PlayStats(() => clock.ms, 'load-0001');
    return { clock, stats };
  }

  it('starts at zero with no first frame, and times the first frame from the load once', () => {
    const { clock, stats } = counters();
    expect(stats.report()).toEqual({ load: 'load-0001', first_frame_ms: null, played_ms: 0, stalls: 0, stalled_ms: 0, waits: 0, waited_ms: 0, errors: 0 });
    clock.ms += 2_345;
    stats.firstFrame();
    clock.ms += 5_000;
    stats.firstFrame();
    expect(stats.report().first_frame_ms).toBe(2_345);
  });

  it('counts play only between close updates while the film advances, never across a seek or a long gap', () => {
    const { clock, stats } = counters();
    stats.tick(10, true);
    clock.ms += 250;
    stats.tick(10.25, true);
    clock.ms += 250;
    stats.tick(60, true); // a seek
    clock.ms += 5_000;
    stats.tick(60.25, true); // a long gap: capped
    clock.ms += 250;
    stats.tick(60.5, false); // paused
    clock.ms += 250;
    stats.tick(60.75, true); // the first update after a pause only starts the count
    expect(stats.report().played_ms).toBe(250 + PLAYED_GAP_MAX_MS);
  });

  it('counts one stall per confirmed freeze, open ones up to now, and none for a torrent wait', () => {
    const { clock, stats } = counters();
    stats.standingStill();
    clock.ms += 1_500;
    stats.stalled(false);
    clock.ms += 1_000;
    stats.stalled(false); // the timer again: same freeze
    expect(stats.report()).toMatchObject({ stalls: 1, stalled_ms: 2_500 });
    clock.ms += 500;
    stats.moved();
    clock.ms += 9_000;
    expect(stats.report()).toMatchObject({ stalls: 1, stalled_ms: 3_000 });
    // A freeze the timer never confirmed, and one that was a torrent's wait.
    stats.standingStill();
    clock.ms += 1_000;
    stats.moved();
    stats.waitStarted();
    stats.standingStill();
    clock.ms += 7_000;
    stats.stalled(true);
    stats.waitEnded();
    stats.moved();
    expect(stats.report()).toMatchObject({ stalls: 1, stalled_ms: 3_000, waits: 1, waited_ms: 7_000 });
  });

  it('never goes down from one report to the next', () => {
    const { clock, stats } = counters();
    stats.standingStill();
    clock.ms += 1_500;
    stats.stalled(false);
    stats.waitStarted();
    const seen: number[][] = [];
    for (let i = 0; i < 5; i++) {
      clock.ms += 333;
      if (i === 2) stats.moved();
      if (i === 3) stats.waitEnded();
      const r = stats.report();
      seen.push([r.stalled_ms, r.waited_ms]);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);
      expect(seen[i][1]).toBeGreaterThanOrEqual(seen[i - 1][1]);
    }
  });
});
