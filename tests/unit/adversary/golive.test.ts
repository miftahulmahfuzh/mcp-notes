import { describe, expect, it } from 'vitest';
import * as gl from '../../../src/adversary/golive.js';
import { sinceStartMetrics } from '../../../src/connectors/seer/ranking.js';

const snap = (date: string, equity: number): { date: string; equity: number } => ({ date, equity });
const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const GATE_PASSED: gl.Gate = { passed: true, applicable: true, twin: false };

describe('Seer checklist parity (web/lib/metrics.ts)', () => {
  it('has the five rules with Seer labels and values, months floored to one decimal', () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2027-07-01', 150)], gl.tradeStats([30, -10]));
    const items = gl.checklistItems(m, 0.2, GATE_PASSED);
    expect(items).toHaveLength(gl.CHECKLIST_RULES);
    expect(items.map((i) => i.seer.label)).toEqual(['≥ 18 months forward', 'Beats SPY', 'Profit factor ≥ 1.3', 'Max drawdown ≤ 25%', 'Backtest gate passed']);
    expect(items.map((i) => i.seer.val)).toEqual(['17.9 mo', '+50.0 vs +20.0', '3.00', '0.0%', 'Passed']);
    expect(items.map((i) => i.state)).toEqual(['fail', 'pass', 'pass', 'pass', 'pass']);
    expect(items[0]!.value).toBe('17.9 of 18 mo');
    expect(items[0]!.progress).toBeCloseTo(m.months / 18, 10);
    expect(items[1]!.value).toBe('+30.0 pts');
  });

  it('writes a loss with the Unicode minus, an empty PF as a dash, no losses as ∞', () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-02-01', 95)], gl.tradeStats([]));
    const seer = gl.seerChecklist(m, 0.02, GATE_PASSED);
    expect(seer[1]).toEqual({ label: 'Beats SPY', val: '−5.0 vs +2.0', ok: false });
    expect(seer[2]).toEqual({ label: 'Profit factor ≥ 1.3', val: '—', ok: false });
    const noLoss = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-02-01', 101)], gl.tradeStats([5, 7]));
    expect(gl.seerChecklist(noLoss, null, GATE_PASSED)[2]).toEqual({ label: 'Profit factor ≥ 1.3', val: '∞', ok: true });
    expect(gl.seerChecklist(noLoss, null, GATE_PASSED)[1]).toEqual({ label: 'Beats SPY', val: '—', ok: false });
  });

  it('passes a drawdown of exactly 25% (≤), measured on raw equity like Seer', () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-01-02', 75), snap('2026-01-05', 100)], gl.tradeStats([]));
    expect(gl.seerChecklist(m, null, GATE_PASSED)[3]).toEqual({ label: 'Max drawdown ≤ 25%', val: '25.0%', ok: true });
  });

  it("rule 5: not passed, not applicable (C), and a twin's backtest that can never be run", () => {
    const m = sinceStartMetrics([snap('2026-01-01', 100), snap('2026-02-01', 110)], gl.tradeStats([]));
    const notPassed = gl.checklistItems(m, null, { passed: false, applicable: true, twin: false })[4]!;
    expect(notPassed).toMatchObject({ state: 'fail', value: 'failed', seer: { label: 'Backtest gate passed', val: 'Not passed', ok: false } });
    const na = gl.checklistItems(m, null, { passed: false, applicable: false, twin: false })[4]!;
    expect(na).toMatchObject({ state: 'na', value: 'not applicable', seer: { label: 'Backtest gate', val: 'Not applicable', ok: false } });
    const twin = gl.checklistItems(m, null, gl.parseGate({ passed: true, applicable: true }, true))[4]!;
    expect(twin).toMatchObject({ state: 'na', value: "can't be run", seer: { label: 'Backtest gate', val: "Can't be run", ok: false } });
  });

  it('parseGate never assumes a pass', () => {
    expect(gl.parseGate(null, false)).toEqual({ passed: false, applicable: true, twin: false });
    expect(gl.parseGate('[1]', false)).toEqual({ passed: false, applicable: true, twin: false });
    expect(gl.parseGate({ applicable: false, passed: true }, false)).toEqual({ passed: false, applicable: false, twin: false });
    expect(gl.parseGate('{"passed": true}', false)).toEqual({ passed: true, applicable: true, twin: false });
  });

  it("spyOverSpan reads SPY on the curve's own first and last dates", () => {
    const spy = [snap('2026-01-01', 100), snap('2026-01-02', 104), snap('2026-01-05', 110)];
    expect(gl.spyOverSpan(spy, [snap('2026-01-02', 1), snap('2026-01-05', 2)])).toBeCloseTo(110 / 104 - 1, 12);
    expect(gl.spyOverSpan(spy, [snap('2026-01-03', 1), snap('2026-01-05', 2)])).toBeNull();
    expect(gl.spyOverSpan(spy, [snap('2026-01-05', 2)])).toBeNull();
  });
});

describe('money-weighted return (engine backtest/metrics.py money_weighted_return)', () => {
  it('equals CAGR with no deposits', () => {
    const s = [snap('2020-01-01', 100), snap('2022-01-01', 121)];
    const cagr = Math.pow(1.21, gl.YEAR_DAYS / gl.daysBetween('2020-01-01', '2022-01-01')) - 1;
    expect(gl.moneyWeightedReturn(s, [])).toBeCloseTo(cagr, 10);
  });

  it('is zero for a book that earns nothing on its deposits', () => {
    const s = [snap('2026-01-02', 100), snap('2026-12-31', 300)];
    const flows = [{ date: '2026-03-02', amount: 100 }, { date: '2026-06-01', amount: 100 }];
    expect(gl.moneyWeightedReturn(s, flows)).toBeCloseTo(0, 9);
    expect(gl.periodMoneyWeightedReturn(s, flows)).toBeCloseTo(0, 9);
  });

  it('recovers a known rate through a deposit (round trip)', () => {
    const r = 0.1;
    const start = '2024-01-01';
    const t1 = 200;
    const end = 730;
    const final = 100 * (1 + r) ** (end / gl.YEAR_DAYS) + 50 * (1 + r) ** ((end - t1) / gl.YEAR_DAYS);
    const got = gl.moneyWeightedReturn([snap(start, 100), snap(addDays(start, end), final)], [{ date: addDays(start, t1), amount: 50 }]);
    expect(got).toBeCloseTo(r, 9);
  });

  it('ignores deposits outside (first, last] and sums deposits on one session', () => {
    const s = [snap('2026-01-01', 100), snap('2026-03-01', 220)];
    const inside = [{ date: '2026-02-01', amount: 50 }, { date: '2026-02-01', amount: 50 }];
    const withNoise = [...inside, { date: '2026-01-01', amount: 999 }, { date: '2026-03-02', amount: 999 }];
    expect(gl.moneyWeightedReturn(s, withNoise)).toBeCloseTo(gl.moneyWeightedReturn(s, [{ date: '2026-02-01', amount: 100 }])!, 12);
  });

  it('is null when undefined: one snapshot, a zero window, no opening money, a wiped-out book', () => {
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 100)], [])).toBeNull();
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 100), snap('2026-01-01', 110)], [])).toBeNull();
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 0), snap('2026-02-01', 110)], [])).toBeNull();
    expect(gl.moneyWeightedReturn([snap('2026-01-01', 100), snap('2026-02-01', 0)], [])).toBeNull();
  });

  it('the period form is the same root over the window', () => {
    const s = [snap('2026-01-01', 100), snap('2026-03-01', 130)];
    const flows = [{ date: '2026-02-01', amount: 20 }];
    const annual = gl.moneyWeightedReturn(s, flows)!;
    const period = gl.periodMoneyWeightedReturn(s, flows)!;
    expect(period).toBeCloseTo((1 + annual) ** (gl.daysBetween('2026-01-01', '2026-03-01') / gl.YEAR_DAYS) - 1, 9);
  });

  it('the period form survives a short sharp window whose annual rate overflows Seer\'s 1e9 cap', () => {
    const s = [snap('2026-10-01', 100), snap('2026-10-05', 140)];
    expect(gl.moneyWeightedReturn(s, [])).toBeNull();
    expect(gl.periodMoneyWeightedReturn(s, [])).toBeCloseTo(0.4, 9);
  });
});

describe('time-weighted index and shadow growth', () => {
  it('takes the deposit out of the growth (deposit at the start of its session)', () => {
    const curve = [snap('2026-10-02', 606), snap('2026-10-05', 996.6), snap('2026-10-06', 896.94)];
    const idx = gl.twrIndex(curve, [{ date: '2026-10-05', amount: 300 }]);
    expect(idx[0]).toBe(1);
    expect(idx[1]).toBeCloseTo(1.1, 12);
    expect(idx[2]).toBeCloseTo(0.99, 12);
    expect(gl.drawdownOf(idx)).toBeCloseTo(0.1, 12);
    expect(gl.drawdownOf([])).toBeNull();
  });

  it("grows the twin's own money at the original's time-weighted rate", () => {
    const original = [snap('2026-10-02', 606), snap('2026-10-05', 996.6), snap('2026-10-06', 896.94)];
    const twin = [snap('2026-10-02', 600), snap('2026-10-05', 1080), snap('2026-10-06', 1080)];
    const flows = [{ date: '2026-10-05', amount: 300 }];
    expect(gl.shadowEnd(original, flows, twin, flows)).toBeCloseTo(891, 9);
    expect(gl.shadowEnd(original.slice(0, 2), flows, twin, flows)).toBeNull();
  });
});
