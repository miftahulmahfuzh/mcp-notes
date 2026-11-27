import { describe, expect, it } from 'vitest';
import { StatsTally } from '../../../../src/directStream/playLog/tally.js';
import { PLAY_LOG_MAX_LOADS, type PageStats } from '../../../../src/directStream/playLog/types.js';

const s = (load: string, playedMs: number, extra: Partial<PageStats> = {}): PageStats => ({ load, firstFrameMs: null, playedMs, stalls: 0, stalledMs: 0, waits: 0, waitedMs: 0, errors: 0, ...extra });

describe('the page counters of one session', () => {
  it('count each load once, at its latest, and sum the loads', () => {
    const t = new StatsTally();
    t.add(s('loadAAAA', 10_000, { stalls: 1, stalledMs: 2_000, firstFrameMs: 1_200 }));
    t.add(s('loadAAAA', 20_000, { stalls: 2, stalledMs: 3_000, firstFrameMs: 1_200 }));
    t.add(s('loadBBBB', 5_000, { waits: 1, waitedMs: 4_000, errors: 1, firstFrameMs: 900 }));
    expect(t.totals()).toEqual({ playedMs: 25_000, stalls: 2, stalledMs: 3_000, waits: 1, waitedMs: 4_000, errors: 1 });
    expect(t.firstFrameMs).toBe(1_200);
  });

  it('a late report of a load never lowers what that load said', () => {
    const t = new StatsTally();
    t.add(s('loadAAAA', 20_000, { stalls: 2 }));
    t.add(s('loadAAAA', 15_000, { stalls: 1 }));
    expect(t.totals()).toMatchObject({ playedMs: 20_000, stalls: 2 });
  });

  it('keeps the totals when loads past the limit are folded together', () => {
    const t = new StatsTally();
    for (let i = 0; i < PLAY_LOG_MAX_LOADS + 4; i += 1) t.add(s(`load${String(i).padStart(4, '0')}`, 1_000));
    expect(t.totals().playedMs).toBe((PLAY_LOG_MAX_LOADS + 4) * 1_000);
  });
});

describe('a folded page load that reports again', () => {
  it('is not counted twice', async () => {
    const { StatsTally } = await import('../../../../src/directStream/playLog/tally.js');
    const { PLAY_LOG_MAX_LOADS } = await import('../../../../src/directStream/playLog/types.js');
    const tally = new StatsTally();
    const at = (load: string, playedMs: number) => ({ load, firstFrameMs: null, playedMs, stalls: 0, stalledMs: 0, waits: 0, waitedMs: 0, errors: 0 });
    tally.add(at('oldest00', 1_000));
    for (let i = 0; i < PLAY_LOG_MAX_LOADS; i += 1) tally.add(at(`load${String(i).padStart(4, '0')}`, 100));
    // 'oldest00' is folded now; its page is still open and reports its counters since its load again.
    tally.add(at('oldest00', 1_500));
    expect(tally.totals().playedMs).toBe(1_500 + PLAY_LOG_MAX_LOADS * 100);
  });
});
