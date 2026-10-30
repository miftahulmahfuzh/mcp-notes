import { ConnectorError, type ReadOnlySource } from '../types.js';
import { bool, clip, num, numOrNull, round, str, toObjects, type Row } from './rows.js';

/** lab.sqlite methods.status values (store.py schema CHECK). */
export const METHOD_STATUSES = [
  'idea',
  'registered',
  'rejected',
  'dev-eligible',
  'promoted',
  'test-passed',
  'test-failed',
  'paper',
  'blocked-data',
] as const;
export type MethodStatus = (typeof METHOD_STATUSES)[number];

/** seer_engine.backtest.tuning.MIN_PROFIT_FACTOR. */
export const MIN_PROFIT_FACTOR = 1.3;
/** seer_engine.backtest.dev._MIN_TRADES. */
export const MIN_TRADES = 100;
export const HYPOTHESIS_MAX = 280;
export const SERA_DEFAULT_LIMIT = 25;
export const SERA_MAX_LIMIT = 200;

/** Params: [only_eligible 0|1, status|null, status|null, limit]. */
export const BEST_SQL = `SELECT m.id, m.name, m.family, m.status, m.hypothesis,
  (SELECT count(*) FROM trials d WHERE d.method_id = m.id AND d."window" = 'dev') AS dev_trials,
  r.n, r.candidate_id, r.run_at, r.start, r.end_date, r.total_return, r.cagr, r.max_drawdown,
  r.profit_factor, r.trades, r.sharpe, r.mar, r.dsr, r.n_trials_at_run, r.spy_tr_return,
  r.eligible, r.failed, f.trial_n AS funding_n, f.mwr, f.spy_tr_mwr
FROM (
  SELECT t.n, t.method_id, t.candidate_id, t.run_at, t.start, t."end" AS end_date, t.total_return, t.cagr,
    t.max_drawdown, t.profit_factor, t.trades, t.sharpe, t.mar, t.dsr, t.n_trials_at_run, t.spy_tr_return,
    t.eligible, t.failed,
    ROW_NUMBER() OVER (PARTITION BY t.method_id ORDER BY t.mar DESC, t.n ASC) AS rk
  FROM trials t
  WHERE t."window" = 'dev' AND t.mar IS NOT NULL AND (? = 0 OR t.eligible = 1)
) r
JOIN methods m ON m.id = r.method_id
LEFT JOIN trial_funding f ON f.trial_n = r.n
WHERE r.rk = 1 AND (? IS NULL OR m.status = ?)
ORDER BY r.mar DESC, r.n ASC
LIMIT ?`;

/** Test-window trials of `count` methods (params: the method ids). */
export function testTrialsSql(count: number): string {
  const marks = Array.from({ length: count }, () => '?').join(', ');
  return `SELECT t.method_id, t.n, t.candidate_id, t.run_at, t.start, t."end" AS end_date, t.total_return, t.cagr,
  t.max_drawdown, t.profit_factor, t.trades, t.sharpe, t.mar, t.dsr, t.n_trials_at_run, t.spy_tr_return,
  t.eligible, t.failed
FROM trials t
WHERE t."window" = 'test' AND t.method_id IN (${marks})
ORDER BY t.method_id, t.n`;
}

export interface SeraHurdles {
  beats_spy: boolean;
  beats_spy_basis: 'money-weighted' | 'total return';
  profit_factor_ge_1_3: boolean;
  trades_ge_100: boolean;
}

/** Recomputes three of the lab's hurdles from stored numbers (store.py owner_failures, dev.beats_spy_tr). */
export function seraHurdles(t: {
  total_return: number | null;
  spy_tr_return: number | null;
  profit_factor: number | null;
  trades: number | null;
  mwr: number | null;
  spy_tr_mwr: number | null;
}): SeraHurdles {
  let beats: boolean;
  let basis: SeraHurdles['beats_spy_basis'];
  if (t.mwr !== null && t.spy_tr_mwr !== null) {
    beats = t.mwr > t.spy_tr_mwr;
    basis = 'money-weighted';
  } else {
    beats = t.total_return !== null && t.spy_tr_return !== null && t.total_return > t.spy_tr_return;
    basis = 'total return';
  }
  return {
    beats_spy: beats,
    beats_spy_basis: basis,
    profit_factor_ge_1_3: t.profit_factor !== null && t.profit_factor >= MIN_PROFIT_FACTOR,
    trades_ge_100: t.trades !== null && t.trades >= MIN_TRADES,
  };
}

export interface SeraTrial {
  n: number;
  candidate_id: string;
  run_at: string;
  start: string;
  end: string;
  total_return: number | null;
  cagr: number | null;
  max_drawdown: number | null;
  profit_factor: number | null;
  trades: number;
  sharpe: number | null;
  mar: number | null;
  dsr: number | null;
  n_trials_at_run: number;
  spy_tr_return: number | null;
  /** The lab's stored verdict, judged against the bar and trial count in force on run_at. */
  eligible_at_run: boolean;
  /** The lab's stored failure labels at run time ('' when none). */
  failed_at_run: string;
}

export interface SeraBestTrial extends SeraTrial {
  /** Present when the trial was funded with deposits (trial_funding row). */
  funding: { mwr: number | null; spy_tr_mwr: number | null } | null;
  hurdles: SeraHurdles;
}

export interface SeraMethodBest {
  id: string;
  name: string;
  family: string;
  status: string;
  hypothesis: string;
  dev_trials: number;
  best: SeraBestTrial;
  test_trials: SeraTrial[];
}

export interface SeraBest {
  source: 'lab.sqlite';
  rule: string;
  eligibility_note: string;
  filters: { limit: number; status: MethodStatus | null; only_eligible: boolean };
  methods: SeraMethodBest[];
}

export interface SeraOptions {
  limit?: number;
  status?: MethodStatus;
  onlyEligible?: boolean;
}

const RULE =
  "Best variant per method = the dev-window trial with the highest MAR (CAGR / max drawdown), ties to the lower trial n " +
  "(the lab's own best_dev_eligible order); never chosen on DSR. Methods are listed best MAR first.";
const ELIGIBILITY_NOTE =
  'eligible_at_run is the lab verdict stored when the trial ran: DSR deflates for the number of trials run so far, ' +
  'so a variant eligible then may fail today at a larger trial count. DSR is not re-derived here. ' +
  'hurdles are recomputed from stored numbers against current bars (beats SPY, PF >= 1.3, trades >= 100).';

function trialOf(r: Row): SeraTrial {
  return {
    n: num(r.n),
    candidate_id: str(r.candidate_id),
    run_at: str(r.run_at),
    start: str(r.start),
    end: str(r.end_date),
    total_return: round(numOrNull(r.total_return), 4),
    cagr: round(numOrNull(r.cagr), 4),
    max_drawdown: round(numOrNull(r.max_drawdown), 4),
    profit_factor: round(numOrNull(r.profit_factor), 3),
    trades: num(r.trades),
    sharpe: round(numOrNull(r.sharpe), 3),
    mar: round(numOrNull(r.mar), 3),
    dsr: round(numOrNull(r.dsr), 3),
    n_trials_at_run: num(r.n_trials_at_run),
    spy_tr_return: round(numOrNull(r.spy_tr_return), 4),
    eligible_at_run: bool(r.eligible),
    failed_at_run: str(r.failed),
  };
}

/** seer_sera_best: the best dev variant per method from lab.sqlite, with its test-window trials. */
export async function seerSeraBest(lab: ReadOnlySource | undefined, opts: SeraOptions = {}): Promise<SeraBest> {
  if (lab === undefined) throw new ConnectorError('seer is not reachable: lab.sqlite is not available');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? SERA_DEFAULT_LIMIT), 1), SERA_MAX_LIMIT);
  const status = opts.status ?? null;
  const onlyEligible = opts.onlyEligible === true;

  const best = toObjects(
    await lab.query(BEST_SQL, [onlyEligible ? 1 : 0, status, status, limit], { maxRows: SERA_MAX_LIMIT }),
  );
  best.sort((a, b) => num(b.mar) - num(a.mar) || num(a.n) - num(b.n));

  const tests = new Map<string, SeraTrial[]>();
  const ids = best.map((r) => str(r.id));
  if (ids.length > 0) {
    const rows = toObjects(await lab.query(testTrialsSql(ids.length), ids, { maxRows: 1000 }));
    for (const r of rows) {
      const key = str(r.method_id);
      const list = tests.get(key) ?? [];
      list.push(trialOf(r));
      tests.set(key, list);
    }
  }

  const methods: SeraMethodBest[] = best.map((r) => {
    const funded = r.funding_n !== null && r.funding_n !== undefined;
    const mwr = funded ? numOrNull(r.mwr) : null;
    const spyMwr = funded ? numOrNull(r.spy_tr_mwr) : null;
    return {
      id: str(r.id),
      name: str(r.name),
      family: str(r.family),
      status: str(r.status),
      hypothesis: clip(str(r.hypothesis), HYPOTHESIS_MAX),
      dev_trials: num(r.dev_trials),
      best: {
        ...trialOf(r),
        funding: funded ? { mwr: round(mwr, 4), spy_tr_mwr: round(spyMwr, 4) } : null,
        hurdles: seraHurdles({
          total_return: numOrNull(r.total_return),
          spy_tr_return: numOrNull(r.spy_tr_return),
          profit_factor: numOrNull(r.profit_factor),
          trades: numOrNull(r.trades),
          mwr,
          spy_tr_mwr: spyMwr,
        }),
      },
      test_trials: tests.get(str(r.id)) ?? [],
    };
  });

  return {
    source: 'lab.sqlite',
    rule: RULE,
    eligibility_note: ELIGIBILITY_NOTE,
    filters: { limit, status, only_eligible: onlyEligible },
    methods,
  };
}
