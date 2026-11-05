import { ApiError } from './api';

/**
 * Seer Adversarial wire types and fetchers. The types are phase 5's `src/adversary/readTypes.ts`
 * (SEER_ADVERSARIAL_PLAN phase 5, Step 1) copied verbatim -- same names, fields, nullability and doc
 * comments (reconciled: the producer's plan is the authority). The only differences: phase 4's
 * `AdversaryStatus` / `ToggleState` are mirrored here because the web cannot import server code, and
 * `MethodStats` / `ThreeWayBook` are aliases of `BookFigures` kept for the components' readability.
 * Every number on the page comes from these payloads, which phase 5 reads from Seer's DB; the page
 * never parses model prose for a number (honesty rule, brief §5).
 * Fractions: 0.054 = +5.4%. Points: percentage points. Money: USD. Dates: YYYY-MM-DD NYSE sessions.
 * Times: ISO 8601 UTC with milliseconds.
 */

/** Phase 4's `ToggleState` (`src/adversary/toggle.ts`): absent row = on, never changed. */
export interface AdversaryToggle {
  on: boolean;
  /** ISO 8601 of the last change, null when never set. */
  changed_at: string | null;
  /** Host that made the last change, null when never set. */
  host: string | null;
}

/** Mirrors of phase 4's `src/adversary/service.ts` status types (the web cannot import server code). */
export type RunTrigger = 'auto' | 'manual';
export type SchemaState = 'unknown' | 'ready' | 'missing' | 'unreachable';

export interface RunSummary {
  trigger: RunTrigger;
  host: string;
  started_at: string;
  finished_at: string | null;
  /** Final verdicts written to Seer after a deep review. */
  reviewed: number;
  /** Final verdicts written to Seer from an earlier draft (no tokens). */
  reused: number;
  /** Draft reviews of a book's next rebalance (never written to Seer). */
  drafted: number;
  failed: number;
  /** Written, but decided after the session opened (the engine ignores them). */
  late: number;
  skipped_budget: number;
  /** Paused marks written while auto runs were off. */
  marks: number;
  /** Decisions another host was reviewing. */
  leases_lost: number;
  error: string | null;
}

export interface AdversaryStatus {
  host: string;
  auto: AdversaryToggle;
  running: RunTrigger | null;
  schema: SchemaState;
  daily_cap: number;
  used_today: number;
  next_poll_at: string | null;
  last_run: RunSummary | null;
  models: { gather: string; verdict: string };
}

export type Engine = 'bracket' | 'book' | 'benchmark';
export type VerdictKind = 'agree' | 'object' | 'unsure';
/** C's own verdicts (news_vetoes.verdict). `failed` means no trade for C and is not a call. */
export type CVerdict = 'allow' | 'veto' | 'failed';
/** 'na': the rule cannot apply (a twin's backtest, or C's). Never counts as passed. */
export type CheckState = 'pass' | 'fail' | 'na';
export type CheckKey = 'months' | 'beats_spy' | 'profit_factor' | 'max_drawdown' | 'backtest';
/**
 * One decision (strategy, session): 'pending' until the session opens; then 'reviewed' when at least
 * one verdict was decided before the open, else 'paused' when the owner's toggle was off
 * (adversary_marks), else 'absent'. A late verdict leaves the decision absent (D12).
 */
export type CoverageState = 'reviewed' | 'absent' | 'paused' | 'pending';
export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly';
export type ScoreOutcome = 'worse' | 'same' | 'better';

export interface AdversarySource {
  url: string;
  title: string | null;
  publisher: string | null;
  published_at: string | null;
  fetched_at: string | null;
}

export interface AdversaryVerdict {
  id: number;
  /** The ORIGINAL strategy id, never the twin's. */
  strategy_id: string;
  session_date: string;
  symbol: string;
  /** Rank in the decision's candidate list; null when the symbol is not on it. */
  rank: number | null;
  verdict: VerdictKind;
  reason: string;
  sources: AdversarySource[];
  lens: string;
  model: string;
  prompt_version: string;
  host: string;
  started_at: string;
  decided_at: string;
  /** Decided at or after the session's open: kept for the record, never used by the twin. */
  late: boolean;
  /** In a decision of a book: the original's target weight. Null outside a decision and for brackets. */
  weight: number | null;
  /** In a decision of a book: the twin's weight (its own book_targets once it decided, else the pro-rata expectation). */
  twin_weight: number | null;
  twin_weight_source: 'twin_book' | 'expected' | null;
  /** In a decision of a book: the original held it before, so an objection is a sale. Null otherwise. */
  held: boolean | null;
  /** A counted objection only: 'sell' (a held book name) or 'skip' (a new name, or any bracket pick). */
  action: 'sell' | 'skip' | null;
}

/** One original on Seer's roster (never a twin, the benchmark or C). */
export interface AdversaryMethod {
  strategy_id: string;
  /** Its Claude twin: the active one, else the newest retired one; null before phase 2 creates it. */
  twin_id: string | null;
  name: string;
  /** The name's head, 'RAW35 · Momentum' -> 'RAW35' (Seer web shortLabel). */
  short: string;
  sub: string | null;
  engine: 'bracket' | 'book';
  cadence: Cadence | null;
  status: 'active' | 'retired';
  paper_start: string | null;
  paper_end: string | null;
}

/** Seer web's CheckItem for the same rule, byte for byte (web/lib/metrics.ts checklist + gateItem). */
export interface SeerCheck {
  label: string;
  val: string;
  ok: boolean;
}

export interface ChecklistItem {
  rule: 1 | 2 | 3 | 4 | 5;
  key: CheckKey;
  /** Plain words for the page: '18 months on paper', 'beats SPY', 'wins ÷ losses ≥ 1.3', 'worst drop ≤ 25%', '10-year backtest'. */
  label: string;
  state: CheckState;
  /** Display value from DB numbers: '7.0 of 18 mo', '+2.9 pts', '2.04', '11.2%', 'failed', "can't be run". */
  value: string | null;
  /** Rule 1 only: share of the 18 months done, 0..1. */
  progress: number | null;
  seer: SeerCheck;
}

export interface Checklists {
  original: ChecklistItem[];
  /** Empty when the method has no twin yet. */
  twin: ChecklistItem[];
}

/** One book over a window: the twin's record for originals and SPY, or the book's own record. */
export interface BookFigures {
  strategy_id: string;
  from: string;
  to: string;
  sessions: number;
  /** Money-weighted return over the window, deposits included (the period form of Seer's IRR). */
  return: number | null;
  /** Seer's money_weighted_return (annualised IRR) over the same window; null when it overflows. */
  mwr_annual: number | null;
  /** Deposits credited inside (from, to]. */
  deposits_usd: number;
  /** End equity - start equity - deposits. */
  gain_usd: number | null;
  /** Deepest fall of the time-weighted index (deposits taken out), as a fraction. */
  worst_drop: number | null;
  /** Closed trades that exited inside (from, to]. */
  trades: number;
  /** Gross win / gross loss of those trades; 'infinite' with no losing trade; null with none. */
  profit_factor: number | 'infinite' | null;
  /** book_fills.cost_usd inside (from, to]; null for brackets (Seer stores no per-order fee). */
  fees_usd: number | null;
}

/** Money-weighted returns since the twin started. */
export interface Returns {
  original: number | null;
  twin: number | null;
  spy: number | null;
}

export interface Objections {
  /** Counted objections on settled (reviewed) decisions. */
  objected: number;
  /** Counted verdicts on settled decisions (stocks reviewed). */
  reviewed: number;
  /** Objections whose stock did worse than the kept picks over the horizon; null before any is scored. */
  fell_after: number | null;
  scored: number;
  pending: number;
}

export interface Coverage {
  decisions: number;
  reviewed: number;
  absent: number;
  /** Absent decisions that do have a verdict, decided after the open. */
  late: number;
  paused: number;
  pending: number;
}

export interface TwinWindow {
  from: string;
  to: string;
  sessions: number;
}

export interface MethodRow extends AdversaryMethod {
  /** The twin's record; every figure below is over it. Null before the twin has a snapshot. */
  window: TwinWindow | null;
  returns: Returns;
  figures: { original: BookFigures | null; twin: BookFigures | null; spy: BookFigures | null };
  /** Twin's end equity minus what its own money would have made at the original's time-weighted growth. */
  beyond_original_usd: number | null;
  objections: Objections;
  coverage: Coverage;
  checklist: Checklists;
}

export interface Cause {
  twins: number;
  twins_beat_spy: string[];
  originals_beat_spy: string[];
  /** Sum of beyond_original_usd over the active twins. */
  extra_profit_usd: number | null;
  /** Mean of (twin worst drop - original worst drop) x 100; negative = the twins fell less. */
  drawdown_delta_pts: number | null;
}

export interface LastReview {
  strategy_id: string;
  session_date: string;
  /** Distinct symbols with a verdict for that decision. */
  picks: number;
  finished_at: string;
}

export interface OverviewPayload {
  generated_at: string;
  /** Earliest first snapshot among active twins: month N of 18 counts from here. */
  started_on: string | null;
  months_on_paper: number | null;
  spy_id: string | null;
  /** Every original: active in Seer sort order, then retired, newest paper_end first. */
  roster: AdversaryMethod[];
  /** Active originals that have a twin. */
  methods: MethodRow[];
  cause: Cause;
  /** At most 8 counted object/unsure verdicts, newest decided_at first. */
  latest: AdversaryVerdict[];
  last_review: LastReview | null;
  /** Phase 4's reviewer status on this machine; null when NOTESD_ADVERSARY=off. */
  reviewer: AdversaryStatus | null;
}

/** Growth of 100, deposits taken out, one value per date (null where a series has no snapshot). */
export interface Curves {
  dates: string[];
  original: (number | null)[];
  twin: (number | null)[];
  spy: (number | null)[];
}

export interface DecisionSummary {
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  open_utc: string;
  coverage: CoverageState;
  picks: number;
  object: number;
  unsure: number;
  agree: number;
  late: number;
}

export interface DecisionPick {
  rank: number;
  symbol: string;
  weight: number | null;
  held: boolean | null;
  twin_weight: number | null;
  twin_weight_source: 'twin_book' | 'expected' | null;
  /** The counted verdict, else the latest late one, else null (nobody reviewed it). */
  verdict: AdversaryVerdict | null;
}

export interface AdversaryDecision {
  strategy_id: string;
  twin_id: string | null;
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  open_utc: string;
  coverage: CoverageState;
  /** Over counted verdicts only. */
  first_started_at: string | null;
  last_decided_at: string | null;
  models: string[];
  prompt_versions: string[];
  lenses: string[];
  hosts: string[];
  counts: { object: number; unsure: number; agree: number; none: number; late: number };
  /** A book decision whose every target was objected (D6: the twin then does what the original does for an empty decision). */
  all_objected: boolean;
  /** Each pick's shown verdict, in rank order. */
  verdicts: AdversaryVerdict[];
  picks: DecisionPick[];
}

export interface RecordPoint {
  symbol: string;
  session_date: string;
  rank: number;
  /** (stock return - kept picks' mean return) x 100 over the horizon; below 0 means Claude was right. */
  gap_pts: number;
  outcome: ScoreOutcome;
  stock_return: number;
  kept_return: number;
  kept: number;
  horizon_from: string | null;
  horizon_to: string | null;
  sessions: number | null;
  fell: boolean;
}

export interface RecordSummary {
  objections: number;
  scored: number;
  worse: number;
  same: number;
  better: number;
  pending: number;
  /** Scored objections whose stock lost money over the horizon. */
  fell: number;
  mean_gap_pts: number | null;
}

export interface AdversaryRecord {
  /** Plain words: 'the 5 sessions after the decision', 'until the next rebalance'. */
  horizon: string;
  horizon_sessions: number | null;
  same_band_pts: number;
  /** Scored objections, oldest first. */
  points: RecordPoint[];
  /** Objections whose horizon has not passed yet. */
  pending: { symbol: string; session_date: string }[];
  summary: RecordSummary;
}

export interface Revision {
  /** First decided_at with this prompt_version, model and lens. */
  since: string;
  /** Last decided_at of a revision a newer one replaced; null for the newest. */
  until: string | null;
  prompt_version: string;
  model: string;
  lens: string;
  verdicts: number;
  /** No change note is stored anywhere yet (see Handoffs); always null. */
  note: string | null;
}

export interface DuelRow {
  session_date: string;
  symbol: string;
  rank: number;
  c: 'allow' | 'veto';
  claude: VerdictKind;
  blocked_by: 'critic' | 'claude';
  stock_return: number | null;
  baseline: number | null;
  right: 'critic' | 'claude' | null;
}

export interface CriticDuel {
  critic_id: string;
  nights: number;
  disagreements: number;
  scored: number;
  claude_right: number;
  critic_right: number;
  pending: number;
  rows: DuelRow[];
}

export interface ThreeWayRow {
  rank: number;
  symbol: string;
  c: { verdict: CVerdict; reason: string; decided_at: string } | null;
  /** The counted verdict, else the latest late one (late: true). */
  claude: AdversaryVerdict | null;
  /** Did each book place an order for this name for this session? null = that book has not decided it yet (the twin decides one night late). */
  buys: { original: boolean | null; critic: boolean | null; twin: boolean | null };
}

export interface DailyGrid {
  c_veto_claude_object: string[];
  c_veto_claude_keep: string[];
  c_allow_claude_object: string[];
  c_allow_claude_keep: string[];
}

export interface ThreeWay {
  original: AdversaryMethod;
  critic: AdversaryMethod;
  twin_id: string | null;
  /** Each book over its own whole record. */
  books: { original: BookFigures | null; critic: BookFigures | null; twin: BookFigures | null };
  /** Decision sessions with candidates, newest first. */
  sessions: string[];
  session_date: string | null;
  open_utc: string | null;
  coverage: CoverageState | null;
  rows: ThreeWayRow[];
  grid: DailyGrid;
  /** Null until at least one disagreement's horizon has passed. */
  settled: { claude_right: number; critic_right: number; disagreements: number; scored: number; pending: number; nights: number } | null;
  duel: CriticDuel;
}

export interface MethodPayload {
  method: AdversaryMethod;
  row: MethodRow;
  /** The lens is built by phase 4 and not stored in Seer; always null in this phase (see Handoffs). */
  lens_question: string | null;
  curves: Curves | null;
  stats: { original: BookFigures | null; twin: BookFigures | null; spy: BookFigures | null };
  checklist: Checklists;
  /** The newest pending or reviewed decision, else the newest decision. */
  decision: AdversaryDecision | null;
  /** Every decision, newest first. */
  decisions: DecisionSummary[];
  record: AdversaryRecord;
  revisions: Revision[];
  /** Bracket originals with a C sibling only. */
  three_way: ThreeWay | null;
}

export interface ScorecardPayload {
  strategy_id: string;
  engine: 'bracket' | 'book';
  record: AdversaryRecord;
  duel: CriticDuel | null;
}

export interface VerdictList {
  sessions: { strategy_id: string; session_date: string; coverage: CoverageState }[];
  verdicts: AdversaryVerdict[];
}

export interface ReviewNowResult {
  started: boolean;
  reason: string | null;
}

/** Aliases for the components: a method's side-by-side stats and a three-way book are BookFigures. */
export type MethodStats = BookFigures;
export type ThreeWayBook = BookFigures;

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') msg = (j as { error: string }).error;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

/** Arrays the page maps over are always arrays, whatever an older server omits. */
function normalizeOverview(o: OverviewPayload): OverviewPayload {
  return { ...o, roster: o.roster ?? [], methods: o.methods ?? [], latest: o.latest ?? [] };
}

export async function fetchOverview(signal?: AbortSignal): Promise<OverviewPayload> {
  return normalizeOverview(await getJson<OverviewPayload>('/api/adversary/overview', signal));
}

export async function fetchMethod(strategyId: string, signal?: AbortSignal): Promise<MethodPayload> {
  const d = await getJson<MethodPayload>(`/api/adversary/methods/${enc(strategyId)}`, signal);
  return { ...d, revisions: d.revisions ?? [], decisions: d.decisions ?? [], record: d.record ?? EMPTY_RECORD };
}

/** What a method with no scored objection shows (phase 5 always sends one; this guards an older server). */
const EMPTY_RECORD: AdversaryRecord = {
  horizon: '',
  horizon_sessions: null,
  same_band_pts: 0.5,
  points: [],
  pending: [],
  summary: { objections: 0, scored: 0, worse: 0, same: 0, better: 0, pending: 0, fell: 0, mean_gap_pts: null },
};

export function fetchToggle(signal?: AbortSignal): Promise<AdversaryToggle> {
  return getJson<AdversaryToggle>('/api/adversary/toggle', signal);
}

/** PUT `{on}` only: the server passes its own host to phase 4's `setToggle(on, host)`; the web never sends one. */
export async function saveToggle(on: boolean): Promise<AdversaryToggle> {
  const res = await fetch('/api/adversary/toggle', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ on }) });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as AdversaryToggle;
}

/**
 * Starts one review pass. Phase 5 answers 202 `{started, reason}` immediately and does NOT await the
 * pass; the page learns of its results from SSE `adversary` events and the next refresh, never by
 * awaiting this POST. 202 is `res.ok`.
 */
export async function postReviewNow(strategyId: string | null): Promise<ReviewNowResult> {
  const body = strategyId ? { strategy_id: strategyId } : {};
  const res = await fetch('/api/adversary/review-now', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as Partial<ReviewNowResult>;
  return { started: j.started === true, reason: typeof j.reason === 'string' ? j.reason : null };
}
