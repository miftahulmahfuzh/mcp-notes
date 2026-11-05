import { describe, expect, it } from 'vitest';
import {
  BRACKET_HORIZON_SESSIONS,
  SAME_BAND,
  horizonReturn,
  outcomeOf,
  recordOf,
  scoreDuel,
  scoreObjections,
  summarize,
  type DuelInputRow,
  type HorizonRow,
} from '../../../src/adversary/scorecard.js';

const h = (over: Partial<HorizonRow> & { symbol: string }): HorizonRow => ({
  session_date: '2026-10-05',
  data_date: '2026-10-02',
  kind: 'bracket',
  rank: 1,
  verdict: null,
  next_session: null,
  entry_date: '2026-10-02',
  entry_close: 100,
  exit_date: '2026-10-09',
  exit_close: 100,
  exit_n: BRACKET_HORIZON_SESSIONS,
  ...over,
});

describe('objection scores', () => {
  it('compares the objected stock with the mean of the kept picks (unsure and agree are kept)', () => {
    const [s] = scoreObjections([
      h({ symbol: 'AAA', rank: 1, verdict: 'object', exit_close: 90 }),
      h({ symbol: 'BBB', rank: 2, verdict: 'agree', exit_close: 104 }),
      h({ symbol: 'CCC', rank: 3, verdict: 'unsure', exit_close: 102 }),
    ]);
    expect(s).toMatchObject({ symbol: 'AAA', stock_return: -0.1, kept: 2, outcome: 'worse', fell: true, from: '2026-10-02', to: '2026-10-09', sessions: 5 });
    expect(s!.kept_return).toBeCloseTo(0.03, 12);
    expect(s!.diff).toBeCloseTo(-0.13, 12);
  });

  it('is pending while a bracket horizon has fewer than 5 bars, or a book has no next decision', () => {
    expect(scoreObjections([h({ symbol: 'A', verdict: 'object', exit_n: 3 }), h({ symbol: 'B', rank: 2 })])[0]!.outcome).toBeNull();
    const book = (over: Partial<HorizonRow> & { symbol: string }): HorizonRow => h({ kind: 'book', exit_n: 2, ...over });
    expect(scoreObjections([book({ symbol: 'X', verdict: 'object' }), book({ symbol: 'Y', rank: 2 })])[0]!.outcome).toBeNull();
    const done = scoreObjections([
      book({ symbol: 'X', verdict: 'object', next_session: '2026-10-15', exit_close: 90 }),
      book({ symbol: 'Y', rank: 2, next_session: '2026-10-15', exit_close: 110 }),
    ])[0]!;
    expect(done.outcome).toBe('worse');
    expect(horizonReturn(book({ symbol: 'Y', next_session: '2026-10-15', exit_close: 110 }), BRACKET_HORIZON_SESSIONS).ret).toBeCloseTo(0.1, 12);
  });

  it('calls a gap within half a point "same"', () => {
    expect(outcomeOf(SAME_BAND - 0.0001)).toBe('same');
    expect(outcomeOf(-SAME_BAND + 0.0001)).toBe('same');
    expect(outcomeOf(SAME_BAND + 0.0001)).toBe('better');
    expect(outcomeOf(null)).toBeNull();
  });

  it('summarizes and builds the record (scored points, pending list)', () => {
    const scores = scoreObjections([
      h({ symbol: 'AAA', verdict: 'object', exit_close: 90 }),
      h({ symbol: 'BBB', rank: 2, verdict: 'object', exit_n: 2 }),
      h({ symbol: 'CCC', rank: 3, exit_close: 103 }),
    ]);
    expect(summarize(scores)).toEqual({ objections: 2, scored: 1, worse: 1, same: 0, better: 0, pending: 1, fell: 1, mean_gap_pts: -13 });
    const rec = recordOf('bracket', scores);
    expect(rec.horizon).toBe('the 5 sessions after the decision');
    expect(rec.points.map((p) => [p.symbol, p.gap_pts])).toEqual([['AAA', -13]]);
    expect(rec.pending).toEqual([{ symbol: 'BBB', session_date: '2026-10-05' }]);
    expect(recordOf('book', []).horizon).toBe('until the next rebalance');
  });
});

describe('Claude against C', () => {
  const d = (over: Partial<DuelInputRow> & { symbol: string; claude: DuelInputRow['claude']; c_verdict: DuelInputRow['c_verdict'] }): DuelInputRow => ({
    session_date: '2026-10-05',
    data_date: '2026-10-02',
    rank: 1,
    entry_date: '2026-10-02',
    entry_close: 100,
    exit_date: '2026-10-09',
    exit_close: 100,
    exit_n: BRACKET_HORIZON_SESSIONS,
    ...over,
  });

  it('credits exactly one side per disagreement, against the names neither blocked', () => {
    const duel = scoreDuel('C-GT', [
      d({ symbol: 'AAA', claude: 'object', c_verdict: 'allow', exit_close: 90 }),
      d({ symbol: 'BBB', rank: 2, claude: 'agree', c_verdict: 'veto', exit_close: 104 }),
      d({ symbol: 'CCC', rank: 3, claude: 'unsure', c_verdict: 'allow', exit_close: 102 }),
    ]);
    expect(duel).toMatchObject({ critic_id: 'C-GT', nights: 1, disagreements: 2, scored: 2, claude_right: 2, critic_right: 0, pending: 0 });
    expect(duel.rows.map((r) => [r.symbol, r.blocked_by, r.right])).toEqual([
      ['AAA', 'claude', 'claude'],
      ['BBB', 'critic', 'claude'],
    ]);
    expect(duel.rows[0]!.baseline).toBeCloseTo(0.02, 12);
  });

  it('falls back to every name of the night when each was blocked by someone, and waits for the horizon', () => {
    // CCC is blocked by both (no disagreement), so no name was blocked by neither: baseline = mean of all three = 0.
    const duel = scoreDuel('C-GT', [
      d({ symbol: 'AAA', claude: 'object', c_verdict: 'allow', exit_close: 90 }),
      d({ symbol: 'BBB', rank: 2, claude: 'agree', c_verdict: 'veto', exit_close: 80 }),
      d({ symbol: 'CCC', rank: 3, claude: 'object', c_verdict: 'veto', exit_close: 130 }),
      d({ symbol: 'DDD', rank: 1, session_date: '2026-10-06', claude: 'object', c_verdict: 'allow', exit_n: 2 }),
    ]);
    expect(duel.rows[0]!.baseline).toBeCloseTo(0, 12);
    expect(duel.rows.map((r) => [r.symbol, r.right])).toEqual([
      ['AAA', 'claude'],
      ['BBB', 'critic'],
      ['DDD', null],
    ]);
    expect(duel).toMatchObject({ nights: 2, disagreements: 3, scored: 2, claude_right: 1, critic_right: 1, pending: 1 });
  });
});
