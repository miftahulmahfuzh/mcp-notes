// Pictures for docs/guide/adversary.md: the wall's Seer Adversarial page (/adversary).
//
//   node scripts/docs/capture.mjs adversary
//
// Nothing here is billed and nothing reads the owner's Seer. `up --adversary` builds a throwaway
// Seer database from the Seer checkout's migrations (${SEER_DIR:-~/seer}/db/migrations); the seed
// below empties it and fills it with an invented roster, picks, verdicts, twin books and prices.
// The tickers are real symbols; every verdict, source, price and return is made up.
//
// A real review is a billed Agent SDK run, so this file never starts one:
//   - the shared ON/OFF toggle is written OFF before anything else (the first pass runs 30 s after start),
//   - every seeded session is in the past, so no decision is due even for a manual pass,
//   - "Review now" is never clicked (and is stubbed in the browser), the Power button is never
//     clicked, and the chat pill is never used.

// The capture runner starts the instance after importing this file, and the daemon inherits this
// environment: one slow poll, a cap of one, and no `gh workflow run` against anybody's repository.
process.env.ADVERSARY_POLL_MS = '3600000';
process.env.ADVERSARY_DAILY_CAP = '1';
process.env.NOTESD_SEER_DISPATCH = 'off';

export const up = ['--adversary'];

// ------------------------------------------------------------------------------------ helpers

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const n = (x, d = 4) => Number(x).toFixed(d);

/** Deterministic noise, so a rerun draws the same curves. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weekdays(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const DAYS = weekdays('2026-09-21', '2026-11-06');
const START = '2026-09-28';
const TWIN_START = '2026-09-29';
const LAST = '2026-11-06';
const DEPOSIT = '2026-10-26';
const dayAt = (date, offset) => DAYS[DAYS.indexOf(date) + offset];
const iso = (date, hour, minute) => new Date(Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60_000).toISOString();

const HOSTS = ['office-laptop', 'home-laptop'];
const PUBLISHERS = [
  ['streetledger.example', 'Street Ledger'],
  ['filingsdesk.example', 'Filings Desk'],
  ['marketwire.example', 'Market Wire'],
  ['thedailytape.example', 'The Daily Tape'],
];

/** One invented source. `fetchedAt` is when the review opened the page. */
function source(k, symbol, title, fetchedAt) {
  const [host, publisher] = PUBLISHERS[k % PUBLISHERS.length];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    url: `https://${host}/${symbol.toLowerCase()}/${slug}`,
    title,
    publisher,
    published_at: new Date(Date.parse(fetchedAt) - 20 * 3_600_000).toISOString(),
    fetched_at: fetchedAt,
  };
}

// ------------------------------------------------------------------------------------ the roster

const TWIN_NOTE = 'Claude twin: no backtest is possible, Claude already knows how the past turned out.';
const gate = (passed) => JSON.stringify({ backtest_gate: { passed, applicable: true } });

//            id                name                                   sub                                                                    icon        bench  params        sort engine       rules                        status     start        end           object        twin_of
const ROSTER = [
  ['SPY-GT', 'SPY', 'S&P 500, buy and hold, real Gotrade fees', 'landmark', true, '{}', 1, 'benchmark', null, 'active', START, null, null, null],
  ['C-GT', 'C · News veto', "A's picks, a news model can veto them, daily", 'gavel', false, '{}', 2, 'bracket', 'design-v0-gotrade', 'active', START, null, 'STRATEGY_C', null],
  ['A-GT', 'A · Dip buy', 'Buys a sharp dip in a rising stock, out within 5 days', 'sigma', false, gate(false), 3, 'bracket', 'design-v0-gotrade', 'active', START, null, 'STRATEGY_A', null],
  ['A-GT-CX', 'A+Claude · Dip buy', 'Buys a sharp dip in a rising stock, out within 5 days', 'sigma', false, '{}', 4, 'bracket', 'design-v0-gotrade', 'active', TWIN_START, null, 'STRATEGY_A', 'A-GT'],
  ['RAW35-FR-GT', 'RAW35 · Momentum', 'The 35 stocks that rose most beyond the market, re-picked each month', 'zap', false, gate(true), 5, 'book', 'monthly-hold-frac-gotrade', 'active', START, null, 'RESIDMOM35', null],
  ['RAW35-FR-GT-CX', 'RAW35+Claude · Momentum', 'The 35 stocks that rose most beyond the market, re-picked each month', 'zap', false, '{}', 6, 'book', 'monthly-hold-frac-gotrade', 'active', TWIN_START, null, 'RESIDMOM35', 'RAW35-FR-GT'],
  ['COSK-FR-GT', 'COSK · Crash premium', 'The 20 stocks that fall hardest when the market does, held for the extra return, re-picked each quarter', 'waves', false, gate(true), 7, 'book', 'monthly-hold-frac-gotrade', 'active', START, null, 'COSKEW', null],
  ['COSK-FR-GT-CX', 'COSK+Claude · Crash premium', 'The 20 stocks that fall hardest when the market does, held for the extra return, re-picked each quarter', 'waves', false, '{}', 8, 'book', 'monthly-hold-frac-gotrade', 'active', TWIN_START, null, 'COSKEW', 'COSK-FR-GT'],
  ['MOM70-FR-GT', 'MOM70 · Momentum beside SPY', '70% in the 30 strongest names, 30% in SPY, monthly', 'trending-up', false, '{}', 9, 'book', 'monthly-hold-frac-gotrade', 'retired', '2026-07-01', '2026-09-25', 'MOMBLEND70', null],
  ['MVW-FR-GT', 'MVW · Low swings', 'The 40 calmest large stocks, weighted to swing least, monthly', 'anchor', false, '{}', 10, 'book', 'monthly-hold-frac-gotrade', 'retired', '2026-06-01', '2026-08-28', 'MINVOL', null],
];

function rosterSql() {
  const row = (r) =>
    `(${q(r[0])}, ${q(r[1])}, ${q(r[2])}, ${q(r[3])}, false, ${r[4]}, ${q(r[5])}, ${r[6]}, ${q(r[7])}, ${r[8] === null ? 'NULL' : q(r[8])}, ${q(r[9])}, ${q(r[10])}, ${
      r[11] === null ? 'NULL' : q(r[11])
    }, ${r[12] === null ? 'NULL' : q(r[12])}, ${r[13] === null ? 'NULL' : q(TWIN_NOTE)}, ${r[13] === null && !r[4]}, ${r[13] === null ? 'NULL' : q(r[13])})`;
  const cols = 'id, name, sub, icon, is_champion, is_benchmark, params, sort, engine, rules_id, status, paper_start, paper_end, object_name, gate_note, gate_applicable, twin_of';
  // Originals first: a twin's twin_of references its original.
  const originals = ROSTER.filter((r) => r[13] === null).map(row).join(',\n');
  const twins = ROSTER.filter((r) => r[13] !== null).map(row).join(',\n');
  return `INSERT INTO strategies (${cols}) VALUES\n${originals};\nINSERT INTO strategies (${cols}) VALUES\n${twins}`;
}

// ------------------------------------------------------------------------------------ equity

/** [id, first day, drift over the whole record, daily swing, the book it shadows or null]. */
const BOOKS = [
  ['SPY-GT', START, 0.031, 0.004, null],
  ['C-GT', START, 0.024, 0.004, null],
  ['A-GT', START, 0.012, 0.005, null],
  ['A-GT-CX', TWIN_START, 0.041, 0.003, 'A-GT'],
  ['RAW35-FR-GT', START, 0.068, 0.011, null],
  ['RAW35-FR-GT-CX', TWIN_START, 0.083, 0.003, 'RAW35-FR-GT'],
  ['COSK-FR-GT', START, -0.024, 0.012, null],
  ['COSK-FR-GT-CX', TWIN_START, -0.009, 0.003, 'COSK-FR-GT'],
];

function equitySql() {
  const rows = [];
  const state = [];
  const contributions = [];
  const steps = new Map();
  BOOKS.forEach(([id, first, drift, swing, shadows], k) => {
    const rand = rng(101 + k * 17);
    const days = DAYS.filter((d) => d >= first);
    const base = shadows === null ? null : steps.get(shadows);
    const mine = new Map();
    let equity = 600;
    days.forEach((d, i) => {
      if (i > 0) {
        // A twin moves with its original, plus what the dropped picks changed.
        const own = drift / days.length + (rand() - 0.5) * 2 * swing;
        const step = base === null ? own : (base.get(d) ?? 0) + (drift - BOOKS.find((b) => b[0] === shadows)[2]) / days.length + (rand() - 0.5) * 2 * swing;
        mine.set(d, step);
        if (d === DEPOSIT) equity += 300;
        equity *= 1 + step;
      }
      rows.push(`(${q(id)}, ${q(d)}, 0, ${n(equity)})`);
    });
    steps.set(id, mine);
    state.push(`(${q(id)}, ${q(LAST)}, 0, ${n(equity)}, 600, 16666.6667, '2026-11-09', false)`);
    contributions.push(`(${q(id)}, '2026-10-25', ${q(DEPOSIT)}, 5000000, 16666.6667, 300, '2026-10-27T06:30:00Z')`);
  });
  return [
    `INSERT INTO equity_snapshots (strategy_id, date, cash_usd, equity_usd) VALUES\n${rows.join(',\n')}`,
    `INSERT INTO paper_state (strategy_id, last_session, cash_usd, equity_usd, initial_cash_usd, usd_idr, pending_session, pending_decision) VALUES\n${state.join(',\n')}`,
    `INSERT INTO paper_contributions (strategy_id, due_date, session_date, amount_idr, usd_idr, amount_usd, applied_at) VALUES\n${contributions.join(',\n')}`,
  ].join(';\n');
}

// ------------------------------------------------------------------------------------ prices

/** Where each stock ends against where it starts, over the whole seeded window. Unlisted: a small random drift. */
const DRIFT = {
  // RAW35's October objections: four that then fell, two that did not.
  CCL: -0.17, VST: -0.13, UAL: -0.11, COF: -0.07, MU: 0.13, PLTR: 0.19,
  // A's objections on the scored nights.
  TGT: -0.16, DE: -0.12, GM: -0.1, BA: -0.14, PFE: -0.09, EL: -0.15, F: 0.08, ORCL: 0.11,
};

const COMPANY = {
  ADBE: 'Adobe', NKE: 'Nike', PYPL: 'PayPal', SBUX: 'Starbucks', DIS: 'Disney', INTC: 'Intel', BA: 'Boeing', TGT: 'Target',
  PFE: 'Pfizer', CVS: 'CVS', F: 'Ford', GM: 'General Motors', UPS: 'UPS', FDX: 'FedEx', MMM: '3M', CAT: 'Caterpillar',
  DE: 'Deere', HON: 'Honeywell', LOW: "Lowe's", MDT: 'Medtronic', ABT: 'Abbott', TMO: 'Thermo Fisher', QCOM: 'Qualcomm',
  TXN: 'Texas Instruments', CSCO: 'Cisco', ORCL: 'Oracle', CRM: 'Salesforce', UBER: 'Uber', ABNB: 'Airbnb', EL: 'Estee Lauder',
};
const A_POOL = Object.keys(COMPANY);

const RAW_OCT = ['NVDA', 'AVGO', 'AMD', 'MU', 'ANET', 'LRCX', 'KLAC', 'AMAT', 'PLTR', 'CRWD', 'PANW', 'NOW', 'META', 'NFLX', 'GE', 'ETN', 'PH', 'TT',
  'VRT', 'CEG', 'VST', 'NRG', 'GEV', 'HWM', 'RCL', 'CCL', 'BKNG', 'UAL', 'DAL', 'GS', 'MS', 'JPM', 'AXP', 'COF', 'LLY'];
const RAW_OUT = ['CCL', 'UAL', 'DAL', 'COF', 'AMD', 'NRG'];
const RAW_IN = ['ISRG', 'BSX', 'COST', 'TMUS', 'ORLY', 'WELL'];
const RAW_NOV = [...RAW_OCT.filter((s) => !RAW_OUT.includes(s)), ...RAW_IN];
const COSK = ['APA', 'DVN', 'OXY', 'FANG', 'HAL', 'SLB', 'BKR', 'VLO', 'PSX', 'MPC', 'AAL', 'NCLH', 'MGM', 'WYNN', 'CZR', 'ALB', 'FCX', 'CLF', 'AA', 'WBD'];

function barsSql() {
  const symbols = [...new Set([...A_POOL, ...RAW_OCT, ...RAW_IN, ...COSK])];
  const chunks = [];
  let rows = [];
  symbols.forEach((symbol, k) => {
    const rand = rng(7000 + k * 31);
    const base = 40 + Math.floor(rand() * 360);
    const drift = DRIFT[symbol] ?? (rand() - 0.42) * 0.12;
    DAYS.forEach((d, i) => {
      const close = base * (1 + (drift * i) / (DAYS.length - 1)) * (1 + (rand() - 0.5) * 0.012);
      rows.push(`(${q(symbol)}, ${q(d)}, ${n(close)}, ${n(close * 1.006)}, ${n(close * 0.994)}, ${n(close)}, ${1_000_000 + Math.floor(rand() * 4_000_000)})`);
    });
    if (rows.length >= 700) {
      chunks.push(rows);
      rows = [];
    }
  });
  if (rows.length > 0) chunks.push(rows);
  return chunks.map((c) => `INSERT INTO bars (symbol, date, open, high, low, close, volume) VALUES\n${c.join(',\n')}`);
}

// ------------------------------------------------------------------------------------ the daily method (A, with C beside it)

const A_REV = [
  { lens: 'STRATEGY_A@5c1e09ab', model: 'claude-opus-4-5', pv: 'adv-v1-7c41e9a02b6d' },
  { lens: 'STRATEGY_A@5c1e09ab', model: 'claude-opus-4-6', pv: 'adv-v1-e2b8d5137f90' },
];

/** [symbol, C's verdict, C's sentence, Claude's verdict, Claude's reason, source titles]. */
const A_NOV5 = [
  ['CRM', 'allow', 'Routine headlines only.', 'agree', 'Salesforce slipped with the other software companies after one of them warned about slower orders. Nothing about Salesforce itself changed, and its own results are three weeks away.', ['Software shares slide together']],
  ['DE', 'allow', 'No company-specific event in the window.', 'object', 'Deere told investors on Tuesday that farmers are ordering fewer machines than it planned for. The fall is the market taking that in, not a dip that comes back in five days.', ['Deere trims its order outlook', 'Form 8-K: investor day remarks']],
  ['PYPL', 'veto', 'Several negative analyst headlines in the last 3 days.', 'agree', 'Two banks lowered their price targets, but neither changed what they expect PayPal to earn. The drop is small and matches the payment group that day.', ['Brokers trim PayPal targets']],
  ['ABT', 'allow', 'Routine headlines only.', 'unsure', 'A court ruling about one Abbott product is expected this week and I could not find when. Without the date I cannot say whether it lands inside the five days, so the pick stays.', []],
  ['LOW', 'allow', 'No company-specific event in the window.', 'agree', "Lowe's fell with every home improvement chain after a weak housing report. That is the group moving, the kind of drop this method is built to buy.", ['Housing starts miss forecasts']],
  ['QCOM', 'allow', 'Routine headlines only.', 'agree', 'Qualcomm gave back part of last week’s rise and no filing, forecast or scheduled event sits behind it.', ['Chip makers ease after rally']],
  ['GM', 'veto', 'Recall headline inside the window.', 'object', 'General Motors announced a recall of about 300,000 trucks on Wednesday and has not said what it will cost. That is news the price rule cannot see, and the bill could arrive within days.', ['GM recalls pickup trucks over brake fault']],
  ['EL', 'allow', 'Routine headlines only.', 'agree', 'Estee Lauder drifted lower on thin trading. I found no news about the company at all, which is what a plain dip looks like.', ['Consumer shares drift lower']],
];

const A_NOV6 = [
  ['NKE', 'allow', 'Routine headlines only.', 'agree', 'Nike fell with the whole clothing and shoe group after a weak retail sales report. Nothing about Nike itself changed, which is the kind of dip this method buys.', ['Retail sales disappoint in October']],
  ['TGT', 'veto', 'Guidance cut reported in the last 3 days.', 'object', 'Target lowered its profit forecast for the year on Wednesday. The drop is the market putting a new price on the company, not a dip that bounces back in five days.', ['Target cuts full-year profit forecast', 'Form 8-K: updated outlook']],
  ['UPS', 'allow', 'No company-specific event in the window.', 'object', 'UPS reports its quarterly results on Tuesday, inside the five days this trade is held. The result will decide the price, not the dip.', ['UPS sets date for third-quarter results']],
  ['INTC', 'veto', 'Analyst downgrade headline in the last 3 days.', 'agree', 'One bank lowered its rating on Intel, but nothing in the business changed and the fall matches the other chip makers that day.', ['Chip shares fall as one bank turns cautious']],
  ['SBUX', 'allow', 'Routine headlines only.', 'unsure', 'I could not find what moved Starbucks on Thursday. No filing and no news explains it, so the pick stays.', []],
  ['MDT', 'allow', 'No company-specific event in the window.', 'agree', 'Medtronic slipped after a rival reported weaker sales of a similar device. Medtronic’s own numbers are not due for a month.', ['Device makers dip on a rival’s report']],
  ['CSCO', 'allow', 'Routine headlines only.', 'agree', 'Cisco fell on a day when the whole market fell. I found nothing about the company itself.', ['Stocks close lower across the board']],
  ['FDX', 'allow', 'Routine headlines only.', 'late', 'FedEx fell after UPS set its results date, and its own update is due the same week. That is a scheduled event inside the holding window.', ['Parcel carriers line up results']],
];

const OBJECT_LINES = [
  (co) => `${co} cut its forecast for the year this week. The fall is a new price for the company, not a dip that recovers in five days.`,
  (co) => `${co} reports results inside the five days this trade is held, so the result decides the price, not the dip.`,
  (co) => `A regulator opened an inquiry into ${co} on the day it fell. That is news the price rule cannot see.`,
];
const AGREE_LINES = [
  (co) => `${co} fell with its whole group and nothing about the company itself changed.`,
  (co) => `No filing, forecast change or scheduled event explains the drop in ${co}. It looks like the ordinary noise this method buys.`,
  (co) => `${co} gave back part of a recent rise. I found no news behind it.`,
];

function dailySql() {
  const sessions = DAYS.filter((d) => d >= '2026-10-12');
  const rand = rng(4242);
  const candidates = [];
  const vetoes = [];
  const verdicts = [];
  const marks = [];
  sessions.forEach((session, si) => {
    const dataDate = dayAt(session, -1);
    const winter = session >= '2026-11-02';
    const rev = session <= '2026-10-23' ? A_REV[0] : A_REV[1];
    const host = HOSTS[si % 2];
    const written = session === '2026-11-05' ? A_NOV5 : session === LAST ? A_NOV6 : null;
    const picks =
      written ??
      Array.from({ length: 8 }, (_, i) => {
        const symbol = A_POOL[(si * 5 + i * 3) % A_POOL.length];
        const co = COMPANY[symbol];
        const falls = (DRIFT[symbol] ?? 0) < -0.05;
        const roll = rand();
        const claude = (falls && roll < 0.75) || roll < 0.05 ? 'object' : roll > 0.92 ? 'unsure' : 'agree';
        const c = rand() < 0.25 ? 'veto' : 'allow';
        const line = claude === 'object' ? OBJECT_LINES[(si + i) % 3](co) : claude === 'unsure' ? `I could not find what moved ${co}, so the pick stays.` : AGREE_LINES[(si + i) % 3](co);
        return [symbol, c, c === 'veto' ? 'Negative company headline inside the window.' : 'Routine headlines only.', claude, line, claude === 'unsure' ? [] : ['Market recap']];
      });
    // Two nights nobody reviewed: one while no machine was up (one verdict landed after the open), one while auto-runs were off.
    const absent = session === '2026-10-29';
    const paused = session === '2026-10-30';
    if (paused) marks.push(`('A-GT', ${q(session)}, 'paused', ${q(host)})`);
    picks.forEach(([symbol, c, cReason, claude, reason, titles], i) => {
      candidates.push(`('A-GT', ${q(session)}, ${q(dataDate)}, 'bracket', ${i + 1}, ${q(symbol)}, NULL, NULL)`);
      vetoes.push(`('C-GT', ${q(session)}, ${i + 1}, ${q(symbol)}, ${q(c)}, ${q(cReason)}, 'glm-5.3', 'c-veto-v1', '[]', NULL, ${q(iso(session, 6, 5))})`);
      if (paused || (absent && i !== 2)) return;
      const late = claude === 'late' || absent;
      const decided = late ? iso(session, winter ? 15 : 14, 5 + i) : iso(session, 6, 40 + i * 7);
      const started = new Date(Date.parse(decided) - 5 * 60_000).toISOString();
      const fetched = new Date(Date.parse(decided) - 2 * 60_000).toISOString();
      const kind = claude === 'late' ? 'object' : claude;
      const sources = titles.map((title, k) => source(si + i + k, symbol, title, fetched));
      verdicts.push(
        `('A-GT', ${q(session)}, ${q(symbol)}, ${q(kind)}, ${q(reason)}, ${q(JSON.stringify(sources))}::jsonb, ${q(rev.lens)}, ${q(rev.model)}, ${q(rev.pv)}, ${q(host)}, ${q(started)}, ${q(decided)})`,
      );
    });
  });

  // Closed trades behind each book's wins and losses, then what each book bought on the last night.
  const orders = [];
  const order = (id, session, slot, symbol, status, exit, pnl) =>
    orders.push(
      `(${q(id)}, ${q(session)}, ${slot}, ${q(symbol)}, ${q(COMPANY[symbol] ?? symbol)}, 100, 99, 104, 95, 1, ${q(status)}, ${q(session)}, 99, ${exit === null ? 1 : 3}, ${
        exit === null ? 'NULL' : q(exit)
      }, ${exit === null ? 'NULL' : n(99 + pnl)}, ${exit === null ? 'NULL' : "'time'"}, ${exit === null ? 'NULL' : n(pnl, 2)})`,
    );
  [['A-GT', -0.6], ['C-GT', 0.7], ['A-GT-CX', 0.3]].forEach(([id, lean], b) => {
    const r = rng(900 + b);
    DAYS.filter((d) => d >= '2026-09-30' && d <= '2026-10-30').forEach((session, i) => {
      if (i % 2 === b % 2) order(id, session, 1 + (i % 4), A_POOL[(i * 7 + b * 3) % A_POOL.length], 'closed', dayAt(session, 3), lean + (r() - 0.5) * 11);
    });
  });
  const bought = { 'A-GT': ['NKE', 'TGT', 'UPS', 'INTC'], 'C-GT': ['NKE', 'UPS', 'SBUX', 'MDT'], 'A-GT-CX': ['NKE', 'INTC', 'SBUX', 'MDT'] };
  for (const [id, symbols] of Object.entries(bought)) symbols.forEach((symbol, i) => order(id, LAST, i + 1, symbol, 'open', null, 0));

  return [
    `INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence) VALUES\n${candidates.join(',\n')}`,
    `INSERT INTO news_vetoes (strategy_id, session_date, rank, symbol, verdict, reason, model, prompt_version, headlines, earnings_date, decided_at) VALUES\n${vetoes.join(',\n')}`,
    `INSERT INTO adversary_verdicts (strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version, host, started_at, decided_at) VALUES\n${verdicts.join(',\n')}`,
    `INSERT INTO adversary_marks (strategy_id, session_date, mark, host) VALUES\n${marks.join(',\n')}`,
    `INSERT INTO orders (strategy_id, session_date, slot, symbol, company, last_price, limit_price, tp_price, sl_price, shares, status, fill_date, fill_price, days_held, exit_date, exit_price, exit_reason, pnl_usd) VALUES\n${orders.join(',\n')}`,
  ].join(';\n');
}

// ------------------------------------------------------------------------------------ the books (RAW35 monthly, COSK quarterly)

/** symbol -> [verdict, reason, source titles]; every other target is an agree. */
const RAW_OCT_CALLS = {
  CCL: ['object', 'Carnival’s rise came in one week after a single upbeat booking update. A jump that rests on one report tends to give part of it back within the month.', ['Carnival lifts booking outlook']],
  VST: ['object', 'Vistra jumped on talk of one large power contract that has not been signed. If the talk fades, so does the reason for the rise.', ['Vistra said to be in contract talks']],
  UAL: ['object', 'United reports results in the middle of the month this book holds it, and fuel has become more expensive since its last forecast.', ['United sets results date', 'Jet fuel prices climb']],
  COF: ['object', 'Capital One’s rise followed one court ruling in its favour. The other side has said it will appeal, so the reason may not last the month.', ['Ruling favours card lenders']],
  MU: ['object', 'Micron rose on one strong quarter, and memory prices have already started to slip since. I do not think the push lasts the month.', ['Memory chip prices ease']],
  PLTR: ['object', 'Most of Palantir’s rise came in three days around one contract announcement. That looks like a one-off jump rather than a steady climb.', ['Palantir wins agency contract']],
  GEV: ['unsure', 'I could not open the pages about the turbine order behind this rise, so I cannot tell if it is a one-off. The pick stays.', []],
};

const RAW_NOV_CALLS = {
  RCL: ['object', 'Royal Caribbean’s climb came from one strong booking update in September. Nothing new has backed it since, and its results are due on the 12th, inside the month this book holds it.', ['Royal Caribbean sets results date', 'Cruise bookings: what changed since September']],
  ISRG: ['object', 'Most of Intuitive Surgical’s rise came in two days after one research note. A jump that rests on a single report tends to give part of it back within the month.', ['Research note lifts surgical robot maker']],
  TMUS: ['object', 'T-Mobile rose on talk of a deal that the company has since said is not happening. With the reason for the rise gone, I would not add it.', ['T-Mobile says it is not in deal talks', 'Form 8-K: statement on market rumours']],
  GE: ['unsure', 'GE’s rise looks steady, but an engine inspection order was reported last week and I could not find how many engines it covers. Not enough to object, so it stays.', []],
  BSX: ['unsure', 'I could not open the trial results that the rise is said to rest on, so I cannot tell whether they last. The pick stays.', []],
};

const COSK_CALLS = {
  CZR: ['object', 'Caesars has agreed to be bought at a fixed price. A stock with a fixed price ahead of it no longer falls hard or recovers hard with the market, which is the whole reason this book holds it.', ['Caesars agrees to be acquired', 'Form 8-K: merger agreement']],
  ALB: ['unsure', 'Albemarle may sell a large part of its business, according to one report I could not confirm. If true it changes what the stock is, but one unconfirmed report is not enough.', []],
};

const BOOK_AGREE = [
  'The rise has been steady for months and rests on orders and results, not on one event. Nothing scheduled this month looks able to undo it.',
  'Nothing one-off behind the move: the last results beat forecasts and the next ones come after this book rebalances.',
  'The climb matches its whole group, and I found no takeover talk, no single report and no results date inside the month.',
  'Several separate updates have pushed it up, each a little. That is the kind of rise that tends to carry on.',
];
const COSK_AGREE = [
  'Risky, which is the point of this book. Nothing breaks the reason to hold it: no takeover, no bankruptcy risk, no delisting.',
  'It falls hard when the market does and that has not changed. No deal or filing takes it out of the group.',
];

function bookSql() {
  const candidates = [];
  const verdicts = [];
  const targets = [];
  const fills = [];
  const trades = [];
  const decide = (id, twin, session, symbols, calls, agree, rev, host, hour) => {
    const weight = 1 / symbols.length;
    const kept = symbols.filter((s) => calls[s]?.[0] !== 'object');
    symbols.forEach((symbol, i) => {
      candidates.push(`(${q(id)}, ${q(session)}, ${q(dayAt(session, -1))}, 'book', ${i + 1}, ${q(symbol)}, ${n(weight, 6)}, NULL)`);
      targets.push(`(${q(id)}, ${q(session)}, ${i + 1}, ${q(symbol)}, ${n(weight, 6)}, 100)`);
      fills.push(`(${q(id)}, ${q(session)}, ${i + 1}, ${q(symbol)}, 'buy', 1, 100, -100, 0.11, 'entry')`);
      const [verdict, reason, titles] = calls[symbol] ?? ['agree', agree[i % agree.length], ['Monthly review of the movers']];
      const decided = iso(session, hour, 2 + i * 3);
      const fetched = new Date(Date.parse(decided) - 60_000).toISOString();
      const sources = titles.map((title, k) => source(i + k, symbol, title, fetched));
      verdicts.push(
        `(${q(id)}, ${q(session)}, ${q(symbol)}, ${q(verdict)}, ${q(reason)}, ${q(JSON.stringify(sources))}::jsonb, ${q(rev.lens)}, ${q(rev.model)}, ${q(rev.pv)}, ${q(host)}, ${q(
          new Date(Date.parse(decided) - 3 * 60_000).toISOString(),
        )}, ${q(decided)})`,
      );
    });
    kept.forEach((symbol, i) => {
      targets.push(`(${q(twin)}, ${q(session)}, ${i + 1}, ${q(symbol)}, ${n(1 / kept.length, 6)}, 100)`);
      // The twin trades a session later and pays for every sale an objection forces.
      fills.push(`(${q(twin)}, ${q(dayAt(session, 1))}, ${i + 1}, ${q(symbol)}, 'buy', 1, 100, -100, 0.13, 'entry')`);
    });
  };
  decide('RAW35-FR-GT', 'RAW35-FR-GT-CX', '2026-10-01', RAW_OCT, RAW_OCT_CALLS, BOOK_AGREE, { lens: 'RESIDMOM35@a81f33c0', model: 'claude-opus-4-5', pv: 'adv-v1-19aa04c7de53' }, HOSTS[1], 7);
  decide('RAW35-FR-GT', 'RAW35-FR-GT-CX', '2026-11-02', RAW_NOV, RAW_NOV_CALLS, BOOK_AGREE, { lens: 'RESIDMOM35@a81f33c0', model: 'claude-opus-4-6', pv: 'adv-v1-b60f2e8c4a17' }, HOSTS[0], 7);
  decide('COSK-FR-GT', 'COSK-FR-GT-CX', '2026-10-19', COSK, COSK_CALLS, COSK_AGREE, { lens: 'COSKEW@0d7be412', model: 'claude-opus-4-5', pv: 'adv-v1-4e90a1c6f2b8' }, HOSTS[0], 8);

  // What each momentum book closed at its November rebalance.
  const r = rng(555);
  [['RAW35-FR-GT', RAW_OUT, 2.0], ['RAW35-FR-GT-CX', ['DAL', 'AMD', 'NRG', 'RCL'], 1.6]].forEach(([id, symbols, lean]) => {
    symbols.forEach((symbol) => {
      const pnl = lean + (r() - 0.5) * 9;
      trades.push(`(${q(id)}, ${q(symbol)}, '2026-10-01', '2026-11-02', 100, ${n(100 + pnl)}, 22, 0.22, 0, ${n(pnl, 2)}, 'signal', false)`);
    });
  });

  return [
    `INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence) VALUES\n${candidates.join(',\n')}`,
    `INSERT INTO adversary_verdicts (strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version, host, started_at, decided_at) VALUES\n${verdicts.join(',\n')}`,
    `INSERT INTO book_targets (strategy_id, session_date, rank, symbol, weight, last_price) VALUES\n${targets.join(',\n')}`,
    `INSERT INTO book_fills (strategy_id, session_date, seq, symbol, side, shares, price, cash_usd, cost_usd, reason) VALUES\n${fills.join(',\n')}`,
    `INSERT INTO book_trades (strategy_id, symbol, entry_date, exit_date, entry_price, exit_price, days_held, cost_usd, income_usd, pnl_usd, exit_reason, idle) VALUES\n${trades.join(',\n')}`,
  ].join(';\n');
}

// ------------------------------------------------------------------------------------ seed

const TOGGLE_OFF = `insert into app_settings (key, value) values ('adversary.auto', '{"on": false, "changed_at": "2026-11-06T16:40:00Z", "host": "office-laptop"}'::jsonb)`;

// The Seer migrations insert the owner's roster rows; the pictures show only what is written below.
const EMPTY_SEER = `DO $$
DECLARE t text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') INTO t FROM pg_tables WHERE schemaname = 'public';
  IF t IS NOT NULL THEN EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE'; END IF;
END $$`;

export async function seed({ v, fetchJson }) {
  // First, before the reviewer's first pass: automatic reviews off.
  await v('exec', TOGGLE_OFF);
  const toggle = await fetchJson('GET', '/api/adversary/toggle');
  if (toggle.on !== false) throw new Error('the auto-runs toggle is not off; refusing to seed decisions');

  await v('exec', '--seer', EMPTY_SEER);
  await v('exec', '--seer', rosterSql());
  await v('exec', '--seer', equitySql());
  for (const chunk of barsSql()) await v('exec', '--seer', chunk);
  await v('exec', '--seer', dailySql());
  await v('exec', '--seer', bookSql());

  const overview = await fetchJson('GET', '/api/adversary/overview');
  if (overview.methods.length !== 3) throw new Error(`expected 3 twinned methods, the overview has ${overview.methods.length}`);
  const pending = overview.methods.reduce((sum, m) => sum + m.coverage.pending, 0);
  if (pending !== 0) throw new Error('a seeded decision is still pending; every session must be in the past');
}

// ------------------------------------------------------------------------------------ pictures

/** "Review now" starts a billed pass when anything is due. Nothing here clicks it; this makes a slip harmless. */
async function guard(page) {
  await page.route('**/api/adversary/review-now', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: '{"started":false,"reason":"stubbed"}' }));
  await page.route('**/api/chat', (route) => route.abort());
}

/** The chat pill and the toolbar float over the page; an element picture is clearer without them. */
const bare = (page) => page.addStyleTag({ content: '.adv-pill, .adv-bar { visibility: hidden !important; }' });

export default async ({ page, base, shot }) => {
  await guard(page);

  // 1. The overview: the roster in the sidebar, cause tiles, one row per method.
  await page.goto(`${base}/adversary`);
  await page.getByRole('region', { name: 'Methods' }).locator('a.adv-row').first().waitFor();
  await page.getByRole('region', { name: 'Latest objections' }).locator('article').first().waitFor();
  await shot('overview');

  // 2. Focus mode while auto-runs are off (the seed turned them off): the small heading says what that means.
  await page.goto(`${base}/adversary?focus=1`);
  await page.locator('.adv-focus-head').waitFor();
  await page.getByRole('region', { name: 'Methods' }).locator('a.adv-row').first().waitFor();
  await shot('focus-paused');

  // 3, 4 and 5. A monthly book: curves, stats and checklist; the decision's verdict cards; the record.
  await page.goto(`${base}/adversary/RAW35-FR-GT`);
  const versus = page.getByRole('region', { name: 'Original against Claude twin' });
  await versus.locator('svg').first().waitFor();
  await page.getByRole('region', { name: 'Go-live checklist' }).waitFor();
  await bare(page);
  await versus.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot('method');
  const decision = page.locator('section.adv-decision');
  await decision.locator('article[data-verdict="object"]').first().waitFor();
  await shot('verdict-cards', { locator: decision });
  const record = page.getByRole('region', { name: "Claude's record" });
  await record.locator('circle').first().waitFor();
  await shot('record', { locator: record });

  // 6. A daily method that has a C sibling: the three-way.
  await page.goto(`${base}/adversary/A-GT`);
  const three = page.locator('.adv-daily');
  await three.locator('.adv-cand[data-symbol]').first().waitFor();
  await page.getByRole('table', { name: 'Where the critics disagree' }).waitFor();
  await bare(page);
  await shot('three-way', { locator: three });
};
