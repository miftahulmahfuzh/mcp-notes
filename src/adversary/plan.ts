import type { AdversaryStoredVerdict } from '../db/schema.js';
import { sessionOpenUtc } from './sessions.js';
import type { CandidateRow, Decision, Pick, PreviewRow, ReviewStage, RosterRow } from './types.js';

/** Previews are drafted only for a rebalance this close, and a draft is reused only if this recent. */
export const DRAFT_WINDOW_MS = 7 * 86_400_000;
/** A (decision, symbol, stage) that failed this often in the draft window is not retried automatically. */
export const MAX_FAILED_ATTEMPTS = 2;

export function decisionKey(strategyId: string, sessionDate: string): string {
  return `${strategyId}|${sessionDate}`;
}

export function attemptKey(strategyId: string, sessionDate: string, symbol: string, stage: ReviewStage): string {
  return `${strategyId}|${sessionDate}|${symbol}|${stage}`;
}

export function draftKey(strategyId: string, sessionDate: string, symbol: string, promptVersion: string): string {
  return `${strategyId}|${sessionDate}|${symbol}|${promptVersion}`;
}

/**
 * Active originals that have an active twin (contract C2), are not benchmarks and trade as a
 * bracket or a book. C has no twin, so it never shows up here.
 */
export function reviewableOriginals(roster: readonly RosterRow[]): RosterRow[] {
  const twinned = new Set<string>();
  for (const row of roster) if (row.twinOf !== null && row.status === 'active') twinned.add(row.twinOf);
  return roster.filter(
    (row) =>
      row.status === 'active' &&
      row.twinOf === null &&
      !row.isBenchmark &&
      (row.engine === 'bracket' || row.engine === 'book') &&
      twinned.has(row.id),
  );
}

function byRank(a: Pick, b: Pick): number {
  return a.rank - b.rank || a.symbol.localeCompare(b.symbol);
}

/** strategy_candidates rows -> final decisions whose session has not opened yet. */
export function toDecisions(rows: readonly CandidateRow[], now: Date): Decision[] {
  const groups = new Map<string, Decision>();
  for (const row of rows) {
    const key = decisionKey(row.strategyId, row.sessionDate);
    let decision = groups.get(key);
    if (decision === undefined) {
      decision = {
        strategyId: row.strategyId,
        sessionDate: row.sessionDate,
        dataDate: row.dataDate,
        kind: row.kind,
        stage: 'final',
        openUtc: sessionOpenUtc(row.sessionDate),
        picks: [],
      };
      groups.set(key, decision);
    }
    decision.picks.push({ symbol: row.symbol, rank: row.rank, weight: row.weight, evidence: row.evidence });
  }
  const out: Decision[] = [];
  for (const decision of groups.values()) {
    if (decision.openUtc.getTime() <= now.getTime()) continue;
    decision.picks.sort(byRank);
    out.push(decision);
  }
  return out;
}

/**
 * book_previews rows -> draft decisions for the book's next rank session, when that session's real
 * targets are not written yet (`decided` holds decisionKey of every candidate row read) and it opens
 * within DRAFT_WINDOW_MS.
 */
export function toPreviewDecisions(rows: readonly PreviewRow[], decided: ReadonlySet<string>, now: Date): Decision[] {
  const groups = new Map<string, Decision>();
  for (const row of rows) {
    const key = decisionKey(row.strategyId, row.nextDecisionSession);
    if (decided.has(key)) continue;
    let decision = groups.get(key);
    if (decision === undefined) {
      decision = {
        strategyId: row.strategyId,
        sessionDate: row.nextDecisionSession,
        dataDate: row.dataDate,
        kind: 'book',
        stage: 'draft',
        openUtc: sessionOpenUtc(row.nextDecisionSession),
        picks: [],
      };
      groups.set(key, decision);
    }
    decision.picks.push({ symbol: row.symbol, rank: row.rank, weight: row.weight, evidence: null });
  }
  const out: Decision[] = [];
  for (const decision of groups.values()) {
    const ahead = decision.openUtc.getTime() - now.getTime();
    if (ahead <= 0 || ahead > DRAFT_WINDOW_MS) continue;
    decision.picks.sort(byRank);
    out.push(decision);
  }
  return out;
}

/** A recent draft review whose verdict a final review may reuse. */
export interface DraftRef {
  id: number;
  startedAt: Date;
  verdict: AdversaryStoredVerdict;
  gatherModel: string | null;
  verdictModel: string | null;
}

/** What one pass will do, in order. Actions of one decision are contiguous. */
export type PlannedAction =
  | { type: 'review'; decision: Decision; pick: Pick; supersedes: number | null }
  | { type: 'reuse'; decision: Decision; pick: Pick; draft: DraftRef; supersedes: number | null }
  | { type: 'skip_budget'; decision: Decision; pick: Pick };

export interface PlanInput {
  decisions: readonly Decision[];
  previews: readonly Decision[];
  /** prompt_version per original; a strategy missing here is not reviewed this pass. */
  promptVersions: ReadonlyMap<string, string>;
  /** decisionKey -> symbol -> id of the non-superseded Seer verdict. */
  verdicts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** draftKey -> latest ok draft within DRAFT_WINDOW_MS. */
  drafts: ReadonlyMap<string, DraftRef>;
  /** attemptKey -> failed attempts within DRAFT_WINDOW_MS. */
  failures: ReadonlyMap<string, number>;
  /** attemptKey of skipped_budget rows already written today (WIB). */
  skippedToday: ReadonlySet<string>;
  /** Deep reviews already spent today (WIB), both machines. */
  used: number;
  cap: number;
  /** Review symbols that already have a verdict again, superseding it (manual review only). */
  rereview: boolean;
  only?: { strategyId?: string; sessionDate?: string };
}

/** 0 bracket, 1 book, 2 preview (D10). */
function priority(decision: Decision): number {
  if (decision.stage === 'draft') return 2;
  return decision.kind === 'bracket' ? 0 : 1;
}

export function orderDecisions(decisions: readonly Decision[]): Decision[] {
  return [...decisions].sort(
    (a, b) =>
      priority(a) - priority(b) ||
      a.openUtc.getTime() - b.openUtc.getTime() ||
      a.strategyId.localeCompare(b.strategyId),
  );
}

export function planWork(input: PlanInput): PlannedAction[] {
  const actions: PlannedAction[] = [];
  let budget = Math.max(0, input.cap - input.used);
  const { only } = input;
  const wanted = (d: Decision): boolean =>
    (only?.strategyId === undefined || d.strategyId === only.strategyId) &&
    (only?.sessionDate === undefined || d.sessionDate === only.sessionDate);

  for (const decision of orderDecisions([...input.decisions, ...input.previews])) {
    if (!wanted(decision)) continue;
    const promptVersion = input.promptVersions.get(decision.strategyId);
    if (promptVersion === undefined) continue;
    const reviewed = input.verdicts.get(decisionKey(decision.strategyId, decision.sessionDate));
    for (const pick of decision.picks) {
      const attempt = attemptKey(decision.strategyId, decision.sessionDate, pick.symbol, decision.stage);
      if (!input.rereview && (input.failures.get(attempt) ?? 0) >= MAX_FAILED_ATTEMPTS) continue;
      const draft = input.drafts.get(draftKey(decision.strategyId, decision.sessionDate, pick.symbol, promptVersion));

      if (decision.stage === 'draft') {
        // An early look is optional: only with leftover budget, never logged as skipped.
        if (draft !== undefined) continue;
        if (budget > 0) {
          budget -= 1;
          actions.push({ type: 'review', decision, pick, supersedes: null });
        }
        continue;
      }

      const existing = reviewed?.get(pick.symbol);
      if (existing !== undefined && !input.rereview) continue;
      const supersedes = existing ?? null;
      if (draft !== undefined && !input.rereview) {
        actions.push({ type: 'reuse', decision, pick, draft, supersedes });
        continue;
      }
      if (budget > 0) {
        budget -= 1;
        actions.push({ type: 'review', decision, pick, supersedes });
        continue;
      }
      if (!input.skippedToday.has(attempt)) actions.push({ type: 'skip_budget', decision, pick });
    }
  }
  return actions;
}
