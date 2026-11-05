import type {
  AdversaryMethod,
  AdversaryRecord,
  AdversaryToggle,
  AdversaryVerdict,
  BookFigures,
  CheckKey,
  ChecklistItem,
  Coverage,
  CriticDuel,
  MethodPayload,
  MethodRow,
  OverviewPayload,
  ThreeWayRow,
} from '../adversaryApi';

// Every fixture is typed by phase 5's wire types (web/src/adversaryApi.ts = phase 5 readTypes.ts):
// a field phase 5 adds is a compile error here until the fixture carries it.

const LABELS = ['18 months on paper', 'beats SPY', 'wins ÷ losses ≥ 1.3', 'worst drop ≤ 25%', '10-year backtest'];
const KEYS: CheckKey[] = ['months', 'beats_spy', 'profit_factor', 'max_drawdown', 'backtest'];

export function checklist(states: Array<'pass' | 'fail' | 'na'>, values: Array<string | null> = []): ChecklistItem[] {
  return states.map((state, i) => ({
    rule: (i + 1) as ChecklistItem['rule'],
    key: KEYS[i] ?? 'months',
    label: LABELS[i] ?? `rule ${i + 1}`,
    state,
    value: values[i] ?? null,
    progress: i === 0 ? 0.39 : null,
    seer: { label: LABELS[i] ?? `rule ${i + 1}`, val: values[i] ?? (state === 'na' ? "Can't be run" : '—'), ok: state === 'pass' },
  }));
}

export function method(id: string, name: string, over: Partial<AdversaryMethod> = {}): AdversaryMethod {
  return {
    strategy_id: id,
    twin_id: `${id}-CX`,
    name,
    short: name.split(' · ')[0] ?? name,
    sub: null,
    engine: 'book',
    cadence: 'monthly',
    status: 'active',
    paper_start: '2026-10-14',
    paper_end: null,
    ...over,
  };
}

export function verdict(id: number, strategy: string, symbol: string, kind: AdversaryVerdict['verdict'], over: Partial<AdversaryVerdict> = {}): AdversaryVerdict {
  return {
    id,
    strategy_id: strategy,
    session_date: '2026-11-04',
    symbol,
    rank: null,
    verdict: kind,
    reason: `${symbol}: ${kind} reason in plain words.`,
    sources: kind === 'unsure' ? [] : [{ url: `https://www.benzinga.com/${symbol.toLowerCase()}`, title: `${symbol} headline`, publisher: 'benzinga.com', published_at: null, fetched_at: '2026-11-04T09:40:00Z' }],
    lens: 'lens@1',
    model: 'claude-opus-5-5',
    prompt_version: 'pv1',
    host: 'lenovo',
    started_at: '2026-11-04T09:30:00Z',
    decided_at: '2026-11-04T10:00:00Z',
    late: false,
    weight: null,
    twin_weight: null,
    twin_weight_source: null,
    held: null,
    action: kind === 'object' ? 'skip' : null,
    ...over,
  };
}

export function book(strategy: string, over: Partial<BookFigures> = {}): BookFigures {
  return {
    strategy_id: strategy,
    from: '2026-10-14',
    to: '2026-11-04',
    sessions: 16,
    return: null,
    mwr_annual: null,
    deposits_usd: 0,
    gain_usd: null,
    worst_drop: null,
    trades: 0,
    profit_factor: null,
    fees_usd: null,
    ...over,
  };
}

function coverage(reviewed: number, absent: number, paused: number, over: Partial<Coverage> = {}): Coverage {
  return { decisions: reviewed + absent + paused, reviewed, absent, late: 0, paused, pending: 0, ...over };
}

function row(m: AdversaryMethod, over: Omit<MethodRow, keyof AdversaryMethod | 'window' | 'figures' | 'beyond_original_usd'> & Partial<MethodRow>): MethodRow {
  return { ...m, window: { from: '2026-10-20', to: '2026-11-04', sessions: 12 }, figures: { original: null, twin: null, spy: null }, beyond_original_usd: null, ...over };
}

function emptyRecord(horizon: string, sessions: number | null): AdversaryRecord {
  return {
    horizon,
    horizon_sessions: sessions,
    same_band_pts: 0.5,
    points: [],
    pending: [],
    summary: { objections: 0, scored: 0, worse: 0, same: 0, better: 0, pending: 0, fell: 0, mean_gap_pts: null },
  };
}

const A = method('A-GT', 'A · Dip buy', { engine: 'bracket', cadence: 'daily', sub: 'Buys a sharp dip in a rising stock, out within 5 days.' });
const RAW = method('RAW35-FR-GT', 'RAW35 · Momentum', { sub: 'The 35 stocks that rose most beyond the market, re-picked each month.' });
const COSK = method('COSK-FR-GT', 'COSK · Crash-prone', { cadence: 'quarterly', paper_start: '2026-10-19' });
const MOM70 = method('MOM70-GT', 'MOM70 · Momentum + SPY', { status: 'retired', twin_id: null, paper_end: '2026-11-01' });
const FULL50 = method('FULL50-GT', 'FULL50 · Never aside', { status: 'retired', twin_id: null, paper_end: '2026-10-30' });
export const CRITIC = method('C-GT', 'C · News veto', { engine: 'bracket', cadence: 'daily', twin_id: null });

const A_ROW = row(A, {
  returns: { original: 0.031, twin: 0.054, spy: 0.06 },
  objections: { objected: 61, reviewed: 1190, fell_after: 39, scored: 55, pending: 6 },
  coverage: coverage(78, 17, 5),
  checklist: { original: checklist(['fail', 'fail', 'fail', 'fail', 'fail']), twin: checklist(['fail', 'fail', 'pass', 'pass', 'na']) },
});
const RAW_ROW = row(RAW, {
  returns: { original: 0.089, twin: 0.096, spy: 0.06 },
  objections: { objected: 23, reviewed: 245, fell_after: 14, scored: 21, pending: 2 },
  coverage: coverage(7, 0, 0),
  checklist: { original: checklist(['fail', 'pass', 'pass', 'pass', 'fail']), twin: checklist(['fail', 'pass', 'pass', 'pass', 'na']) },
});
const COSK_ROW = row(COSK, {
  returns: { original: 0.044, twin: 0.041, spy: 0.06 },
  objections: { objected: 6, reviewed: 140, fell_after: 2, scored: 4, pending: 2 },
  coverage: coverage(3, 0, 0),
  checklist: { original: checklist(['fail', 'fail', 'pass', 'fail', 'fail']), twin: checklist(['fail', 'fail', 'pass', 'fail', 'na']) },
});

export const OVERVIEW: OverviewPayload = {
  generated_at: '2026-11-05T01:00:00Z',
  started_on: '2026-10-20',
  months_on_paper: 1,
  spy_id: 'SPY-GT',
  roster: [A, RAW, COSK, FULL50, MOM70],
  methods: [A_ROW, RAW_ROW, COSK_ROW],
  cause: { twins: 3, twins_beat_spy: [], originals_beat_spy: [], extra_profit_usd: 38.2, drawdown_delta_pts: -1.9 },
  latest: [
    verdict(1, 'A-GT', 'SLB', 'object', { reason: 'The dip follows oil, not SLB.' }),
    verdict(2, 'A-GT', 'ZBRA', 'object', { reason: 'It fell on a weaker outlook in yesterday’s results.' }),
    verdict(3, 'COSK-FR-GT', 'APA', 'unsure', { session_date: '2026-10-19' }),
  ],
  last_review: { strategy_id: 'RAW35-FR-GT', session_date: '2026-11-02', picks: 35, finished_at: '2026-11-01T10:55:00Z' },
  reviewer: null,
};

const DATES = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];

const BOOK_VERDICTS = [
  verdict(10, 'RAW35-FR-GT', 'SLB', 'object', { session_date: '2026-11-02', rank: 1, weight: 0.029, twin_weight: 0, twin_weight_source: 'expected', held: true, action: 'sell', reason: 'Its rise is the oil price’s rise.' }),
  verdict(11, 'RAW35-FR-GT', 'MRNA', 'agree', { session_date: '2026-11-02', rank: 2, weight: 0.029, twin_weight: 0.032, twin_weight_source: 'expected', held: false }),
  verdict(12, 'RAW35-FR-GT', 'CNC', 'agree', { session_date: '2026-11-02', rank: 3, weight: 0.029, twin_weight: 0.032, twin_weight_source: 'expected', held: true }),
  verdict(13, 'RAW35-FR-GT', 'MU', 'unsure', { session_date: '2026-11-02', rank: 4, weight: 0.029, twin_weight: 0.032, twin_weight_source: 'expected', held: false }),
];

export const METHOD_BOOK: MethodPayload = {
  method: RAW,
  row: RAW_ROW,
  lens_question: null,
  curves: { dates: DATES, original: [100, 101, 102, 108.9], twin: [100, 101.5, 103, 109.6], spy: [100, 100.5, 101, 106] },
  stats: {
    original: book('RAW35-FR-GT', { return: 0.089, worst_drop: 0.112, profit_factor: 2.04, fees_usd: 6.12, trades: 80 }),
    twin: book('RAW35-FR-GT-CX', { return: 0.096, worst_drop: 0.098, profit_factor: 2.11, fees_usd: 6.71, trades: 84 }),
    spy: book('SPY-GT', { return: 0.06, worst_drop: 0.074, profit_factor: null, fees_usd: 0.4, trades: 1 }),
  },
  checklist: {
    original: checklist(['fail', 'pass', 'pass', 'pass', 'fail'], ['7.0 of 18 mo', '+2.9 pts', '2.04', '11.2%', null]),
    twin: checklist(['fail', 'pass', 'pass', 'pass', 'na'], ['7.0 of 18 mo', '+3.6 pts', '2.11', '9.8%', null]),
  },
  decision: {
    strategy_id: 'RAW35-FR-GT',
    twin_id: 'RAW35-FR-GT-CX',
    session_date: '2026-11-02',
    data_date: '2026-10-30',
    kind: 'book',
    open_utc: '2026-11-02T14:30:00.000Z',
    coverage: 'reviewed',
    first_started_at: '2026-11-01T09:40:00Z',
    last_decided_at: '2026-11-01T10:55:00Z',
    models: ['claude-opus-5-5'],
    prompt_versions: ['raw35-v2'],
    lenses: ['raw35@2'],
    hosts: ['lenovo'],
    counts: { object: 1, unsure: 1, agree: 2, none: 0, late: 0 },
    all_objected: false,
    verdicts: BOOK_VERDICTS,
    picks: BOOK_VERDICTS.map((v) => ({ rank: v.rank ?? 0, symbol: v.symbol, weight: v.weight, held: v.held, twin_weight: v.twin_weight, twin_weight_source: v.twin_weight_source, verdict: v })),
  },
  decisions: [
    { session_date: '2026-11-02', data_date: '2026-10-30', kind: 'book', open_utc: '2026-11-02T14:30:00.000Z', coverage: 'reviewed', picks: 4, object: 1, unsure: 1, agree: 2, late: 0 },
  ],
  record: {
    ...emptyRecord('the month', null),
    points: [
      { symbol: 'SLB', session_date: '2026-10-14', rank: 1, gap_pts: -2.1, outcome: 'worse', stock_return: -0.012, kept_return: 0.009, kept: 34, horizon_from: '2026-10-13', horizon_to: '2026-10-30', sessions: 13, fell: true },
      { symbol: 'XOM', session_date: '2026-10-14', rank: 5, gap_pts: 1.0, outcome: 'better', stock_return: 0.019, kept_return: 0.009, kept: 34, horizon_from: '2026-10-13', horizon_to: '2026-10-30', sessions: 13, fell: false },
    ],
    summary: { objections: 2, scored: 2, worse: 1, same: 0, better: 1, pending: 0, fell: 1, mean_gap_pts: -0.55 },
  },
  // Revision.note is always null from phase 5; the page shows lens and verdict count instead.
  revisions: [
    { since: '2026-11-01', until: null, prompt_version: 'raw35-v2', model: 'opus-5-5', lens: 'raw35@2', verdicts: 35, note: null },
    { since: '2026-10-14', until: '2026-10-31', prompt_version: 'raw35-v1', model: 'opus-5-5', lens: 'raw35@1', verdicts: 210, note: null },
  ],
  three_way: null,
};

const NO_DUEL: CriticDuel = { critic_id: 'C-GT', nights: 0, disagreements: 0, scored: 0, claude_right: 0, critic_right: 0, pending: 0, rows: [] };

const DAILY_ROWS: ThreeWayRow[] = [
  { rank: 1, symbol: 'ZBRA', c: { verdict: 'veto', reason: 'Q3 earnings released November 3.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(20, 'A-GT', 'ZBRA', 'object', { rank: 1 }), buys: { original: true, critic: false, twin: false } },
  { rank: 4, symbol: 'HPQ', c: { verdict: 'veto', reason: 'HP announced a new CEO.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(21, 'A-GT', 'HPQ', 'agree', { rank: 4 }), buys: { original: false, critic: false, twin: true } },
  { rank: 9, symbol: 'SLB', c: { verdict: 'allow', reason: 'Only routine ETF flow recaps.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(22, 'A-GT', 'SLB', 'object', { rank: 9 }), buys: { original: false, critic: true, twin: false } },
  { rank: 6, symbol: 'PANW', c: { verdict: 'allow', reason: 'No company-specific event risk.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(23, 'A-GT', 'PANW', 'agree', { rank: 6 }), buys: { original: false, critic: false, twin: null } },
];

export const METHOD_DAILY: MethodPayload = {
  ...METHOD_BOOK,
  method: A,
  row: A_ROW,
  lens_question: null,
  decision: null,
  decisions: [],
  record: emptyRecord('the 5 sessions', 5),
  three_way: {
    original: A,
    critic: CRITIC,
    twin_id: 'A-GT-CX',
    books: {
      original: book('A-GT', { return: 0.031, trades: 212, profit_factor: 1.06, worst_drop: 0.148 }),
      critic: book('C-GT', { return: 0.022, trades: 176, profit_factor: 1.02, worst_drop: 0.131 }),
      twin: book('A-GT-CX', { return: 0.054, trades: 198, profit_factor: 1.21, worst_drop: 0.116 }),
    },
    sessions: ['2026-11-04'],
    session_date: '2026-11-04',
    open_utc: '2026-11-04T14:30:00.000Z',
    coverage: 'reviewed',
    rows: DAILY_ROWS,
    grid: { c_veto_claude_object: ['ZBRA'], c_veto_claude_keep: ['HPQ'], c_allow_claude_object: ['SLB'], c_allow_claude_keep: ['PANW'] },
    settled: { claude_right: 31, critic_right: 17, disagreements: 48, scored: 48, pending: 0, nights: 40 },
    duel: NO_DUEL,
  },
};

export const TOGGLE_ON: AdversaryToggle = { on: true, changed_at: null, host: null };
export const TOGGLE_OFF: AdversaryToggle = { on: false, changed_at: '2026-11-04T02:12:00Z', host: 'lenovo' };
