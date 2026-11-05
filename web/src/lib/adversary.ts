import type { AdversaryMethod, AdversarySource, AdversaryToggle, AdversaryVerdict, Cause, CheckState, ChecklistItem, Coverage, MethodPayload, Objections, OverviewPayload, ThreeWayRow } from '../adversaryApi';

/** Seer's real-money bar: 18 months on paper (Seer web/lib/golive.ts MIN_PAPER_MONTHS). Display only. */
export const PAPER_MONTHS = 18;
export const ADVERSARY_HEADING = 'Adversary.';
export const ADVERSARY_HINT = 'Claude reviews each pick before the market opens. A missing, late or paused review copies the original.';
export const TWIN_BACKTEST_NOTE = 'Claude already knows how the past turned out, so a twin can never be backtested.';
export const PILL_PLACEHOLDER = 'Ask about Seer Adversarial';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUS = '−';

const sign = (v: number) => (v > 0 ? '+' : v < 0 ? MINUS : '');
const pad = (n: number) => String(n).padStart(2, '0');

/** `RAW35 · Momentum` -> `RAW35`. */
export function shortName(name: string): string {
  const i = name.indexOf(' · ');
  return (i < 0 ? name : name.slice(0, i)).trim();
}

/** `RAW35 · Momentum` -> `Momentum`; '' when the name has no ` · `. */
export function plainName(name: string): string {
  const i = name.indexOf(' · ');
  return i < 0 ? '' : name.slice(i + 3).trim();
}

/** The big heading of a method page: its code (`RAW35.`); a one- or two-letter code reads badly huge, so its plain name (`Dip buy.`). */
export function methodHeading(name: string): string {
  const head = shortName(name);
  const tail = plainName(name);
  return `${head.length >= 3 || tail === '' ? head : tail}.`;
}

/** Fraction -> `+5.4%` / `−1.0%` / `0.0%`; null -> `—`. */
export function pct(v: number | null): string {
  if (v === null) return '—';
  return `${sign(v)}${Math.abs(v * 100).toFixed(1)}%`;
}

/** Points -> `+3.6 pts` / `−1.9 pts`. */
export function pts(v: number | null): string {
  if (v === null) return '—';
  return `${sign(v)}${Math.abs(v).toFixed(1)} pts`;
}

/** USD -> `+$38.20`. */
export function usd(v: number | null): string {
  if (v === null) return '—';
  return `${sign(v)}$${Math.abs(v).toFixed(2)}`;
}

/** Worst drop fraction -> `11.2%`. */
export function dropPct(v: number | null): string {
  return v === null ? '—' : `${Math.abs(v * 100).toFixed(1)}%`;
}

/** Profit factor: `2.04`; `'infinite'` (no losing trade) -> `∞`; null (no closed trade) -> `n/a`. */
export function ratio(v: number | 'infinite' | null): string {
  if (v === null) return 'n/a';
  return v === 'infinite' ? '∞' : v.toFixed(2);
}

export function count(v: number): string {
  return v.toLocaleString('en-US');
}

/** `2026-11-04` -> `Nov 4` (calendar date, no time zone shift); an ISO datetime -> its local date. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** ISO datetime -> local `Nov 4, 17:12`. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sourceHost(s: AdversarySource): string {
  try {
    return new URL(s.url).hostname.replace(/^www\./, '');
  } catch {
    return s.url;
  }
}

/** Numbered source line: `benzinga.com · crude analyst calls end of the run`. */
export function sourceLabel(s: AdversarySource): string {
  return [s.publisher ?? sourceHost(s), s.title].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
}

/** Book verdict footer: `weight 2.9% → 0` (object) or `weight 2.9% → 3.2%`; '' for brackets. */
export function weightChange(v: AdversaryVerdict): string {
  if (v.weight === null) return '';
  const to = v.twin_weight === null || v.twin_weight === 0 ? '0' : `${(v.twin_weight * 100).toFixed(1)}%`;
  return `weight ${(v.weight * 100).toFixed(1)}% → ${to}`;
}

/** Book verdict tag: `held · sell` / `new · skip` for objections, `held` / `new` otherwise; '' for brackets. */
export function heldTag(v: AdversaryVerdict): string {
  if (v.held === null) return '';
  if (v.verdict !== 'object') return v.held ? 'held' : 'new';
  return v.held ? 'held · sell' : 'new · skip';
}

/** Decisions whose session has opened (reviewed, absent or paused); `pending` ones are not settled yet. */
export function coverageTotal(c: Coverage): number {
  return c.reviewed + c.absent + c.paused;
}

/** `rebalances` for monthly books, `re-picks` for quarterly ones. */
export function cadenceUnit(cadence: string | null): string {
  return cadence === 'quarterly' ? 're-picks' : 'rebalances';
}

/** Daily brackets: `78% · 17% · 5%`. Books: `7 of 7 rebalances`, `6 of 7 rebalances · 1 paused`. */
export function coverageLabel(c: Coverage, engine: 'bracket' | 'book', cadence: string | null): string {
  const total = coverageTotal(c);
  const pending = c.pending > 0 ? ` · ${c.pending} pending` : '';
  if (total === 0) return c.pending > 0 ? `${c.pending} pending` : 'no decisions yet';
  if (engine === 'bracket') {
    const share = (n: number) => `${Math.round((n / total) * 100)}%`;
    return `${share(c.reviewed)} · ${share(c.absent)} · ${share(c.paused)}${pending}`;
  }
  let s = `${c.reviewed} of ${total} ${cadenceUnit(cadence)}`;
  if (c.paused > 0) s += ` · ${c.paused} paused`;
  if (c.absent > 0) s += ` · ${c.absent} absent`;
  return s + pending;
}

export function objectionsLine(o: Objections): string {
  return `${count(o.objected)} / ${count(o.reviewed)}`;
}

/** Month N of 18 since `startedOn` (calendar months, counted on UTC dates). */
export function paperMonth(startedOn: string | null, now: Date): number | null {
  if (startedOn === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startedOn);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - mo) - (now.getUTCDate() < d ? 1 : 0);
  return Math.max(1, months + 1);
}

export function rosterNames(roster: readonly AdversaryMethod[]): Map<string, string> {
  return new Map(roster.map((r) => [r.strategy_id, shortName(r.name)]));
}

/** `A`, `A and B`, `A, B and C`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface CauseTile {
  key: 'spy' | 'profit' | 'drops';
  label: string;
  value: string;
  text: string;
}

/** Seer's cause, in order: 1 beat SPY, 2 most profit, 3 smaller drops. */
export function causeTiles(cause: Cause, names: ReadonlyMap<string, string>): CauseTile[] {
  const name = (id: string) => names.get(id) ?? id;
  const twins = cause.twins_beat_spy.map((id) => `${name(id)}'s`);
  const originals = cause.originals_beat_spy.map(name);
  const twinText =
    twins.length === 0 ? 'No twin is ahead of SPY yet.' : `${joinNames(twins)} ${twins.length === 1 ? 'twin is' : 'twins are'} ahead of SPY.`;
  const origText =
    originals.length === 0
      ? ' No original is.'
      : ` Of the originals, ${joinNames(originals)} ${originals.length === 1 ? 'is' : 'are'}.`;
  return [
    { key: 'spy', label: '1 · beat SPY', value: `${cause.twins_beat_spy.length} of ${cause.twins} twins`, text: twinText + origText },
    { key: 'profit', label: '2 · most profit', value: usd(cause.extra_profit_usd), text: 'What the twins made beyond their originals, together, after fees.' },
    { key: 'drops', label: '3 · smaller drops', value: pts(cause.drawdown_delta_pts), text: "The twins' worst fall from a high, on average, against their originals'." },
  ];
}

export function stateWord(item: ChecklistItem): string {
  if (item.state === 'na') return "can't be run";
  if (item.state === 'pass') return 'pass';
  return item.rule === 1 ? 'not yet' : 'failed';
}

/** A checklist cell: `+2.9 pts · pass`, `7.0 of 18 mo`, `failed`, `can't be run`. */
export function checkValue(item: ChecklistItem): string {
  if (item.state === 'na' || item.value === null) return stateWord(item);
  return item.rule === 1 ? item.value : `${item.value} · ${stateWord(item)}`;
}

export const CHECK_WORD: Record<CheckState, string> = { pass: 'passed', fail: 'not yet / failed', na: 'no backtest possible for Claude' };

/** Messages for the server's error codes. */
export function errorText(code: string, strategy: string | null = null): string {
  if (code === 'seer_unavailable') return "Seer's database can't be reached from this machine, so there is nothing to show.";
  if (code === 'not_found') return strategy ? `No method ${strategy} on Seer's roster.` : 'Not found.';
  return `Could not load Seer Adversarial (${code}).`;
}

export function overviewCountLine(o: OverviewPayload | null, error: string | null, now: Date): string {
  if (error !== null) return errorText(error);
  if (o === null) return 'Loading Seer Adversarial.';
  const n = o.methods.length;
  if (n === 0) return "No method on Seer's roster has a Claude twin yet.";
  let s = `${n === 1 ? '1 method' : `${n} methods`} on Seer's roster, each with a Claude twin that drops the picks Claude objects to.`;
  const month = paperMonth(o.started_on, now);
  if (month !== null) s += ` Month ${month} of ${PAPER_MONTHS}.`;
  const last = o.last_review;
  if (last !== null) {
    const who = rosterNames(o.roster).get(last.strategy_id) ?? last.strategy_id;
    s += ` Last review: ${who}'s ${last.picks} ${last.picks === 1 ? 'pick' : 'picks'} for ${shortDate(last.session_date)}, on ${shortDate(last.finished_at)}.`;
  }
  return s;
}

export function decisionSummary(d: MethodPayload['decision']): string {
  if (d === null) return 'No verdicts yet.';
  const day = shortDate(d.session_date);
  if (d.coverage === 'paused') return `${day} decision: paused, the twin copies the original.`;
  if (d.coverage === 'absent' && d.verdicts.every((v) => v.late)) return `${day} decision: not reviewed in time, the twin copies the original.`;
  const n = (k: AdversaryVerdict['verdict']) => d.verdicts.filter((v) => v.verdict === k && !v.late).length;
  const obj = n('object');
  const unsure = n('unsure');
  return `${day} decision: ${d.verdicts.length} picks, ${obj} ${obj === 1 ? 'objection' : 'objections'}, ${unsure} can't tell.`;
}

export function methodCountLine(d: MethodPayload): string {
  const parts: string[] = [];
  if (d.method.sub) parts.push(d.method.sub.endsWith('.') ? d.method.sub : `${d.method.sub}.`);
  // No lens sentence: phase 5 always sends lens_question null (nothing stores the lens's question).
  parts.push(decisionSummary(d.decision));
  return parts.join(' ');
}

export interface AdversaryView {
  overview: OverviewPayload | null;
  overviewError: string | null;
  method: MethodPayload | null;
  methodError: string | null;
}

/** The wall header's heading for /adversary[/<id>]. */
export function adversaryHeading(s: AdversaryView, strategy: string | null): string {
  if (strategy === null) return ADVERSARY_HEADING;
  const m = s.method !== null && s.method.method.strategy_id === strategy ? s.method.method : s.overview?.roster.find((r) => r.strategy_id === strategy);
  return m ? methodHeading(m.name) : ADVERSARY_HEADING;
}

/** The wall header's count line for /adversary[/<id>]. */
export function adversaryCountLine(s: AdversaryView, strategy: string | null, now: Date): string {
  if (strategy === null) return overviewCountLine(s.overview, s.overviewError, now);
  if (s.methodError !== null) return errorText(s.methodError, strategy);
  if (s.method === null || s.method.method.strategy_id !== strategy) return `Loading ${strategy}.`;
  return methodCountLine(s.method);
}

/** Focus mode's one-line status beside the small heading. */
export function focusLine(toggle: AdversaryToggle | null, overview: OverviewPayload | null): string {
  if (toggle === null) return '';
  if (toggle.on) return 'auto-runs on';
  const paused = (overview?.methods ?? []).reduce((n, m) => n + m.coverage.paused, 0);
  const since = toggle.changed_at ? ` since ${clockTime(toggle.changed_at)}` : '';
  return `auto-runs off${since} · twins copy their originals until it is back on · ${paused} ${paused === 1 ? 'decision' : 'decisions'} paused`;
}

/**
 * The chat bar has no page field (POST /api/chat carries message, thread_id, image_ids and a repo
 * `project`, which means a Claude Code repository). The page's context rides on the message's first
 * line instead, where the chat agent reads it together with the adversary_* MCP tools (phase 5).
 */
export function adversaryChatMessage(text: string, strategy: string | null): string {
  return `[Seer Adversarial · ${strategy ?? 'overview'}]\n${text}`;
}

/** A row's two critics: Claude blocks on a timely objection; C blocks on a veto or a failed check (no trade). */
export function claudeBlocks(r: ThreeWayRow): boolean {
  return r.claude !== null && r.claude.verdict === 'object' && !r.claude.late;
}

export function criticBlocks(r: ThreeWayRow): boolean {
  return r.c !== null && r.c.verdict !== 'allow';
}

export interface Disagreement {
  bothBlock: string[];
  claudeOnly: string[];
  criticOnly: string[];
  bothKeep: string[];
}

export function disagreement(rows: readonly ThreeWayRow[]): Disagreement {
  const out: Disagreement = { bothBlock: [], claudeOnly: [], criticOnly: [], bothKeep: [] };
  for (const r of rows) {
    const a = claudeBlocks(r);
    const c = criticBlocks(r);
    if (a && c) out.bothBlock.push(r.symbol);
    else if (a) out.claudeOnly.push(r.symbol);
    else if (c) out.criticOnly.push(r.symbol);
    else out.bothKeep.push(r.symbol);
  }
  return out;
}
