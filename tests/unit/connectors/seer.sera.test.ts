import { describe, expect, it } from 'vitest';
import { seraHurdles, testTrialsSql } from '../../../src/connectors/seer/sera.js';

describe('seraHurdles', () => {
  it('judges SPY money-weighted when both funding rates exist', () => {
    expect(
      seraHurdles({ total_return: 0.2, spy_tr_return: 0.3, profit_factor: 1.1, trades: 50, mwr: 0.1, spy_tr_mwr: 0.05 }),
    ).toEqual({ beats_spy: true, beats_spy_basis: 'money-weighted', profit_factor_ge_1_3: false, trades_ge_100: false });
  });

  it('falls back to total return, with the bars inclusive', () => {
    expect(
      seraHurdles({ total_return: 0.5, spy_tr_return: 0.3, profit_factor: 1.3, trades: 100, mwr: null, spy_tr_mwr: null }),
    ).toEqual({ beats_spy: true, beats_spy_basis: 'total return', profit_factor_ge_1_3: true, trades_ge_100: true });
  });

  it('does not beat SPY on a tie, a missing benchmark, or one funding side only', () => {
    const base = { profit_factor: 2, trades: 200, mwr: null, spy_tr_mwr: null };
    expect(seraHurdles({ ...base, total_return: 0.3, spy_tr_return: 0.3 }).beats_spy).toBe(false);
    expect(seraHurdles({ ...base, total_return: 0.3, spy_tr_return: null }).beats_spy).toBe(false);
    const half = seraHurdles({ ...base, total_return: 0.1, spy_tr_return: 0.3, mwr: 0.5 });
    expect(half).toMatchObject({ beats_spy: false, beats_spy_basis: 'total return' });
  });
});

describe('testTrialsSql', () => {
  it('binds one placeholder per method id', () => {
    expect(testTrialsSql(3)).toContain('IN (?, ?, ?)');
    expect(testTrialsSql(1)).toContain(`t."window" = 'test'`);
  });
});
