import type { AdversarySource } from '../db/schema.js';
import { REASON_MAX_CHARS } from './prompt.js';
import { WIB_OFFSET_MS, sessionOpenUtc } from './sessions.js';
import type { CandidateRow, Decision, Pick, RosterRow, Verdict } from './types.js';

/**
 * /redo (a Claude Code session redoes one pick's review with real web search). The pure part:
 * which method and decision a request means, whether redoing is still "fresh", and what a
 * submitted verdict must look like. The service does the reads and the one write.
 */

/** Do not start a redo closer than this to the open: a web-search review takes minutes. */
export const REDO_START_MARGIN_MS = 10 * 60_000;

export type RedoClockState = 'fresh' | 'closing' | 'closed';

export interface RedoClock {
  state: RedoClockState;
  open_utc: string;
  /** The open as a WIB wall time, "YYYY-MM-DD HH:mm". */
  open_wib: string;
  /** The last moment to START a redo (open minus the margin), as a WIB wall time. */
  start_by_wib: string;
  /** Whole minutes until the open; 0 once it has passed. */
  minutes_to_open: number;
}

function wibWallTime(at: Date): string {
  return new Date(at.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * fresh: more than the margin before the open. closing: before the open but inside the margin
 * (too tight to start, a verdict could still land in time). closed: the session has opened, so a
 * verdict now is kept for the record but the twin ignores it.
 */
export function redoClock(openUtc: Date, now: Date): RedoClock {
  const left = openUtc.getTime() - now.getTime();
  const state: RedoClockState = left <= 0 ? 'closed' : left <= REDO_START_MARGIN_MS ? 'closing' : 'fresh';
  return {
    state,
    open_utc: openUtc.toISOString(),
    open_wib: wibWallTime(openUtc),
    start_by_wib: wibWallTime(new Date(openUtc.getTime() - REDO_START_MARGIN_MS)),
    minutes_to_open: Math.max(0, Math.floor(left / 60_000)),
  };
}

export type OriginalMatch = { kind: 'ok'; row: RosterRow } | { kind: 'none' } | { kind: 'ambiguous'; ids: string[] };

/**
 * "A-GT" matches that id exactly (any case); a short form like "A" matches the one original whose
 * id starts with "A-". A twin's id ('A-GT-CX') means its original.
 */
export function resolveOriginal(originals: readonly RosterRow[], input: string): OriginalMatch {
  const want = input.trim().toUpperCase();
  if (want === '') return { kind: 'none' };
  const exact = originals.find((r) => r.id.toUpperCase() === want);
  if (exact !== undefined) return { kind: 'ok', row: exact };
  const twin = originals.find((r) => `${r.id.toUpperCase()}-CX` === want);
  if (twin !== undefined) return { kind: 'ok', row: twin };
  const byPrefix = originals.filter((r) => r.id.toUpperCase().startsWith(`${want}-`));
  if (byPrefix.length === 1 && byPrefix[0] !== undefined) return { kind: 'ok', row: byPrefix[0] };
  if (byPrefix.length > 1) return { kind: 'ambiguous', ids: byPrefix.map((r) => r.id) };
  return { kind: 'none' };
}

/** One strategy's candidate rows -> its decisions (every session, open or not), sessions ascending. */
export function decisionsOf(rows: readonly CandidateRow[], strategyId: string): Decision[] {
  const groups = new Map<string, Decision>();
  for (const row of rows) {
    if (row.strategyId !== strategyId) continue;
    let d = groups.get(row.sessionDate);
    if (d === undefined) {
      d = {
        strategyId,
        sessionDate: row.sessionDate,
        dataDate: row.dataDate,
        kind: row.kind,
        stage: 'final',
        openUtc: sessionOpenUtc(row.sessionDate),
        picks: [],
      };
      groups.set(row.sessionDate, d);
    }
    d.picks.push({ symbol: row.symbol, rank: row.rank, weight: row.weight, evidence: row.evidence });
  }
  const out = [...groups.values()];
  for (const d of out) d.picks.sort((a, b) => a.rank - b.rank || a.symbol.localeCompare(b.symbol));
  return out.sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}

export interface PickedDecision {
  decision: Decision;
  pick: Pick;
}

/**
 * The decision a redo of `symbol` means: the one for `sessionDate` when given, else the earliest
 * session that has not opened, else the newest one that has (so the caller can say it is too late).
 * Null when the symbol is in none of them.
 */
export function pickDecision(decisions: readonly Decision[], symbol: string, now: Date, sessionDate?: string): PickedDecision | null {
  const sym = symbol.trim().toUpperCase();
  const withSymbol = decisions
    .filter((d) => sessionDate === undefined || d.sessionDate === sessionDate)
    .map((decision) => ({ decision, pick: decision.picks.find((p) => p.symbol.toUpperCase() === sym) }))
    .filter((x): x is PickedDecision => x.pick !== undefined);
  if (withSymbol.length === 0) return null;
  const upcoming = withSymbol.find((x) => x.decision.openUtc.getTime() > now.getTime());
  return upcoming ?? withSymbol[withSymbol.length - 1] ?? null;
}

export interface SubmittedSource {
  url: string;
  title?: string | undefined;
  publisher?: string | undefined;
  published_at?: string | undefined;
}

export interface CheckedVerdict {
  verdict: Verdict;
  reason: string;
  sources: AdversarySource[];
  /** True when an agree/object that cited no page became unsure. */
  downgraded: boolean;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/** A published-at claim is kept only when it parses as a date. */
function isoOrNull(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Same honesty rule as the automatic reviewer: agree and object must cite a page; without one the
 * pick is kept as unsure. `fetchedAt` is the server's clock, not the caller's.
 */
export function checkSubmitted(input: { verdict: Verdict; reason: string; sources: readonly SubmittedSource[] }, fetchedAt: Date): CheckedVerdict {
  const reason = input.reason.trim();
  if (reason === '') throw new TypeError('the reason is empty');
  if (reason.length > REASON_MAX_CHARS) throw new TypeError(`the reason is ${reason.length} characters; the limit is ${REASON_MAX_CHARS}`);
  const seen = new Set<string>();
  const sources: AdversarySource[] = [];
  for (const s of input.sources) {
    const url = s.url.trim();
    if (!HTTP_URL.test(url)) throw new TypeError(`not an http(s) url: ${url}`);
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      title: s.title?.trim() ? s.title.trim() : null,
      publisher: s.publisher?.trim() ? s.publisher.trim() : null,
      published_at: isoOrNull(s.published_at),
      fetched_at: fetchedAt.toISOString(),
    });
  }
  const downgraded = input.verdict !== 'unsure' && sources.length === 0;
  return { verdict: downgraded ? 'unsure' : input.verdict, reason, sources, downgraded };
}

/** What the session doing the redo must follow; the same rules the automatic reviewer works under. */
export const REDO_RULES = [
  "Judge the pick only through the method's lens and what you find: agree when the method's own reason stands, object when something the method cannot see makes this pick a mistake under its own lens, unsure when the evidence is thin, mixed or could not be checked (unsure keeps the pick).",
  'Search the web (WebSearch) and open every page you rely on (WebFetch): only pages you opened may be cited, never a search snippet alone. Open about 8 pages at most.',
  'Use only what was published before now. Nothing about how the stock traded after the decision night.',
  `Write the reason for an owner who is not a trader: at most ${REASON_MAX_CHARS} characters, plain everyday words, name the company rather than its ticker, and never write RSI, oversold, overbought, momentum, mean reversion, alpha, beta or support level.`,
  'agree and object must cite at least one opened page; with none, the pick is kept as unsure.',
].join(' ');
