/**
 * Go-live parity and money measures for Seer Adversarial, ported from Seer (read, never imported):
 *   ~/seer/web/lib/metrics.ts                     checklist(), gateItem() (phase 3 adds the twin's rule 5)
 *   ~/seer/web/lib/golive.ts                      MAX_DRAWDOWN, MIN_PAPER_MONTHS and their labels
 *   ~/seer/web/app/(app)/leaderboard/view.ts      spyOverSpan()
 *   ~/seer/engine/src/seer_engine/backtest/metrics.py  money_weighted_return(), flow_map(), and the
 *                                                 funded-run drawdown on the time-weighted index
 * strategyMetrics() itself is src/connectors/seer/ranking.ts sinceStartMetrics(), already a port.
 *
 * Seer's web checklist is NOT money-weighted: total return is raw last/first - 1 and the drawdown is on
 * raw equity, deposits included. It is reproduced exactly so the wall never disagrees with Seer; the
 * honest money measures (period money-weighted return, time-weighted drawdown) are separate functions.
 * tests/unit/adversary/golive.parity.test.ts reads Seer's files and fails when these constants drift.
 * Pure: no I/O.
 */
import { byDate, type SinceStart, type Snapshot, type TradeStats } from '../connectors/seer/ranking.js';
import { json } from '../connectors/seer/rows.js';
import type { CheckKey, CheckState, ChecklistItem, SeerCheck } from './readTypes.js';

export const MAX_DRAWDOWN = 0.25;
export const MIN_PAPER_MONTHS = 18;
export const MIN_PROFIT_FACTOR = 1.3;
export const CHECKLIST_RULES = 5;
export const YEAR_DAYS = 365.25;
export const MONTH_DAYS = 30.44;
const DAY_MS = 86_400_000;
const DASH = '—';
const MINUS = '−';

export const MIN_PAPER_MONTHS_LABEL = `≥ ${MIN_PAPER_MONTHS} months forward`;
export const MAX_DRAWDOWN_LABEL = `Max drawdown ≤ ${(Math.abs(MAX_DRAWDOWN) * 100).toFixed(0)}%`;

/** A deposit (or a fee), dated by the NYSE session it was applied on. */
export interface Flow {
  date: string;
  amount: number;
}

/** One closed trade: its exit session (null when Seer stored none) and its P/L in USD. */
export interface Trade {
  date: string | null;
  pnl: number;
}

/** strategies.params->'backtest_gate', plus whether the row is a Claude twin (strategies.twin_of). */
export interface Gate {
  passed: boolean;
  applicable: boolean;
  twin: boolean;
}

/** Seer web lib/strategy.ts parseGate, plus the twin flag. A pass is never assumed. */
export function parseGate(raw: unknown, twin: boolean): Gate {
  const value = json(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { passed: false, applicable: true, twin };
  const g = value as Record<string, unknown>;
  const applicable = g.applicable !== false;
  return { passed: applicable && g.passed === true, applicable, twin };
}

/** Seer's wins / losses split: a win is pnl > 0, a loss pnl <= 0; sums left to right from 0. */
export function tradeStats(pnls: readonly number[]): TradeStats {
  let wins = 0;
  let grossWin = 0;
  let losses = 0;
  for (const p of pnls) {
    if (p > 0) {
      wins += 1;
      grossWin += p;
    } else {
      losses += p;
    }
  }
  return { trades: pnls.length, wins, grossWin, grossLoss: -losses };
}

/** view.ts spyOverSpan: SPY's raw return between the curve's first and last snapshot dates. */
export function spyOverSpan(spy: readonly Snapshot[], curve: readonly Snapshot[]): number | null {
  if (curve.length < 2) return null;
  const c = [...curve].sort(byDate);
  const on = new Map(spy.map((p) => [p.date, p.equity] as const));
  const a = on.get(c[0]!.date);
  const b = on.get(c[c.length - 1]!.date);
  return a === undefined || b === undefined || a === 0 ? null : b / a - 1;
}

/** metrics.ts gateItem with phase 3's twin rule: a twin's backtest can never be run. */
export function seerGateItem(gate: Gate): SeerCheck {
  if (gate.twin) return { label: 'Backtest gate', val: "Can't be run", ok: false };
  return gate.applicable
    ? { label: 'Backtest gate passed', val: gate.passed ? 'Passed' : 'Not passed', ok: gate.passed }
    : { label: 'Backtest gate', val: 'Not applicable', ok: false };
}

/** metrics.ts checklist, line for line: the five go-live rules with Seer's own strings. */
export function seerChecklist(m: SinceStart, spyReturn: number | null, gate: Gate): SeerCheck[] {
  const ret = m.totalReturn ?? 0;
  const p1 = (v: number): string => (v >= 0 ? '+' : MINUS) + Math.abs(v * 100).toFixed(1);
  const pf = m.profitFactor;
  return [
    {
      label: MIN_PAPER_MONTHS_LABEL,
      val: `${(Math.floor(m.months * 10) / 10).toFixed(1)} mo`,
      ok: m.months >= MIN_PAPER_MONTHS,
    },
    {
      label: 'Beats SPY',
      val: spyReturn === null ? DASH : `${p1(ret)} vs ${p1(spyReturn)}`,
      ok: m.totalReturn !== null && spyReturn !== null && ret > spyReturn,
    },
    {
      label: `Profit factor ≥ ${MIN_PROFIT_FACTOR}`,
      val: pf === null ? DASH : pf === Infinity ? '∞' : pf.toFixed(2),
      ok: (pf ?? 0) >= MIN_PROFIT_FACTOR,
    },
    {
      label: MAX_DRAWDOWN_LABEL,
      val: m.maxDrawdown === null ? DASH : `${(m.maxDrawdown * 100).toFixed(1)}%`,
      ok: m.maxDrawdown !== null && m.maxDrawdown <= MAX_DRAWDOWN,
    },
    seerGateItem(gate),
  ];
}

const KEYS: readonly CheckKey[] = ['months', 'beats_spy', 'profit_factor', 'max_drawdown', 'backtest'];

/** The page's checklist: Seer's verdicts (`seer`, `state`) with plain labels and display values. */
export function checklistItems(m: SinceStart, spyReturn: number | null, gate: Gate): ChecklistItem[] {
  const seer = seerChecklist(m, spyReturn, gate);
  const signed = (v: number, dp: number): string => `${v >= 0 ? '+' : MINUS}${Math.abs(v).toFixed(dp)}`;
  const pf = m.profitFactor;
  const page: { label: string; value: string | null; progress: number | null }[] = [
    {
      label: `${MIN_PAPER_MONTHS} months on paper`,
      value: `${(Math.floor(m.months * 10) / 10).toFixed(1)} of ${MIN_PAPER_MONTHS} mo`,
      progress: Math.max(0, Math.min(1, m.months / MIN_PAPER_MONTHS)),
    },
    {
      label: 'beats SPY',
      value: m.totalReturn === null || spyReturn === null ? null : `${signed((m.totalReturn - spyReturn) * 100, 1)} pts`,
      progress: null,
    },
    {
      label: `wins ÷ losses ≥ ${MIN_PROFIT_FACTOR}`,
      value: pf === null ? null : pf === Infinity ? '∞' : pf.toFixed(2),
      progress: null,
    },
    {
      label: `worst drop ≤ ${(MAX_DRAWDOWN * 100).toFixed(0)}%`,
      value: m.maxDrawdown === null ? null : `${(m.maxDrawdown * 100).toFixed(1)}%`,
      progress: null,
    },
    {
      label: '10-year backtest',
      value: gate.twin ? "can't be run" : !gate.applicable ? 'not applicable' : gate.passed ? 'passed' : 'failed',
      progress: null,
    },
  ];
  return seer.map((s, i) => {
    const notApplicable = i === 4 && (gate.twin || !gate.applicable);
    const state: CheckState = notApplicable ? 'na' : s.ok ? 'pass' : 'fail';
    const p = page[i]!;
    return { rule: (i + 1) as ChecklistItem['rule'], key: KEYS[i]!, label: p.label, state, value: p.value, progress: p.progress, seer: s };
  });
}

/** Whole calendar days from a to b (YYYY-MM-DD, parsed as UTC midnights). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
}

/** The snapshots dated inside [from, to], ascending. */
export function cutCurve(curve: readonly Snapshot[], from: string, to: string): Snapshot[] {
  return curve.filter((s) => s.date >= from && s.date <= to).sort(byDate);
}

/** metrics.py flow_map: total per session (several deposits on one session are summed). */
export function flowMap(flows: readonly Flow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of flows) out.set(f.date, (out.get(f.date) ?? 0) + f.amount);
  return out;
}

/**
 * metrics.py's time-weighted wealth index for a funded run: 1 on the first snapshot, then
 * index *= equity / (previous equity + the deposit credited that session). A session whose base is not
 * positive leaves the index where it was.
 */
export function twrIndex(snaps: readonly Snapshot[], flows: readonly Flow[]): number[] {
  const f = flowMap(flows);
  const out: number[] = [];
  let index = 1;
  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i]!;
    if (i > 0) {
      const base = snaps[i - 1]!.equity + (f.get(cur.date) ?? 0);
      if (base > 0) index *= cur.equity / base;
    }
    out.push(index);
  }
  return out;
}

/** Largest (peak - value) / peak; null for an empty series. */
export function drawdownOf(index: readonly number[]): number | null {
  if (index.length === 0) return null;
  let peak = -Infinity;
  let dd = 0;
  for (const v of index) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  return dd;
}

export const IRR_LOW = -0.9999;
const IRR_TOL = 1e-12;
const IRR_MAX_RATE = 1e9;
const IRR_MAX_STEPS = 200;

function npv(rate: number, times: readonly number[], amounts: readonly number[]): number {
  const base = 1 + rate;
  let total = 0;
  for (let i = 0; i < times.length; i++) total += amounts[i]! * base ** -times[i]!;
  return total;
}

/** metrics.py's bisection, constant for constant: null when the bracket does not close. */
export function solveIrr(times: readonly number[], amounts: readonly number[]): number | null {
  let low = IRR_LOW;
  if (!(npv(low, times, amounts) > 0)) return null;
  let high = 1;
  while (npv(high, times, amounts) >= 0) {
    high *= 2;
    if (high > IRR_MAX_RATE) return null;
  }
  let steps = 0;
  while (high - low > IRR_TOL * (1 + Math.abs(low)) && steps < IRR_MAX_STEPS) {
    const middle = (low + high) / 2;
    if (npv(middle, times, amounts) > 0) low = middle;
    else high = middle;
    steps += 1;
  }
  return (low + high) / 2;
}

interface Cashflows {
  days: number[];
  amounts: number[];
  span: number;
}

/**
 * The opening equity (money in), each positive deposit inside (first, last] (money in), the final mark.
 * Seer raises on a deposit outside the window; callers here pass every deposit of the strategy and
 * this keeps only the ones inside it.
 */
function cashflows(snaps: readonly Snapshot[], flows: readonly Flow[]): Cashflows | null {
  if (snaps.length < 2) return null;
  const first = snaps[0]!;
  const last = snaps[snaps.length - 1]!;
  const span = daysBetween(first.date, last.date);
  if (span <= 0 || !(first.equity > 0) || last.equity < 0) return null;
  const days: number[] = [0];
  const amounts: number[] = [-first.equity];
  const merged = [...flowMap(flows)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [date, amount] of merged) {
    if (!(date > first.date && date <= last.date)) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    days.push(daysBetween(first.date, date));
    amounts.push(-amount);
  }
  days.push(span);
  amounts.push(last.equity);
  return { days, amounts, span };
}

/** metrics.py money_weighted_return: the annual rate (Actual/365.25) a savings account would have paid. */
export function moneyWeightedReturn(snaps: readonly Snapshot[], flows: readonly Flow[]): number | null {
  const cf = cashflows(snaps, flows);
  return cf === null ? null : solveIrr(cf.days.map((d) => d / YEAR_DAYS), cf.amounts);
}

/**
 * The same root expressed over the window: (1 + annual)^(span / 365.25) - 1, solved directly with
 * exponents days / span so a short window never overflows the 1e9 cap the annual form hits.
 */
export function periodMoneyWeightedReturn(snaps: readonly Snapshot[], flows: readonly Flow[]): number | null {
  const cf = cashflows(snaps, flows);
  return cf === null ? null : solveIrr(cf.days.map((d) => d / cf.span), cf.amounts);
}

/**
 * What the twin's own money would have become at the original's time-weighted growth: start from the
 * twin's first equity, add the twin's deposits on each of its sessions, and grow by the original's
 * index step between the same two dates. Null when the original lacks a snapshot on a twin date.
 */
export function shadowEnd(
  original: readonly Snapshot[],
  originalFlows: readonly Flow[],
  twin: readonly Snapshot[],
  twinFlows: readonly Flow[],
): number | null {
  const start = twin[0];
  if (start === undefined) return null;
  const index = twrIndex(original, originalFlows);
  const at = new Map(original.map((s, i) => [s.date, index[i]!] as const));
  const tf = flowMap(twinFlows);
  let value = start.equity;
  for (let i = 1; i < twin.length; i++) {
    const a = at.get(twin[i - 1]!.date);
    const b = at.get(twin[i]!.date);
    if (a === undefined || b === undefined || a === 0) return null;
    value = (value + (tf.get(twin[i]!.date) ?? 0)) * (b / a);
  }
  return value;
}
