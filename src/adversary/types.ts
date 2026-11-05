import type { AdversarySource } from '../db/schema.js';

/**
 * Types shared by the Seer Adversarial reviewer. A "decision" is one original strategy's choice for
 * one US session (Seer contract C1: strategy_candidates keyed by strategy_id + session_date); a
 * "pick" is one stock in it. Ids always name the ORIGINAL strategy, never its `-CX` twin.
 */

export type DecisionKind = 'bracket' | 'book';
/** 'draft' = an early look at a book's next rebalance (book_previews); 'final' = a real decision. */
export type ReviewStage = 'draft' | 'final';
export type Verdict = 'agree' | 'object' | 'unsure';
export const VERDICTS: readonly Verdict[] = ['agree', 'object', 'unsure'];

/** One row of Seer's `strategies`, as the reviewer reads it. */
export interface RosterRow {
  id: string;
  name: string;
  sub: string;
  /** 'bracket' | 'book' | 'benchmark' | null */
  engine: string | null;
  rulesId: string | null;
  /** paper.roster.RESOLVER key, e.g. STRATEGY_A; names the override brief file. */
  objectName: string | null;
  gateNote: string | null;
  /** lab.sqlite methods.id this row came from. */
  promotedFrom: string | null;
  /** 'active' | 'retired' */
  status: string;
  twinOf: string | null;
  isBenchmark: boolean;
}

export interface CandidateRow {
  strategyId: string;
  sessionDate: string;
  dataDate: string;
  kind: DecisionKind;
  rank: number;
  symbol: string;
  weight: number | null;
  evidence: unknown;
}

export interface PreviewRow {
  strategyId: string;
  dataDate: string;
  rank: number;
  symbol: string;
  weight: number;
  nextDecisionSession: string;
}

/** A non-superseded Seer verdict. */
export interface VerdictRef {
  id: number;
  strategyId: string;
  sessionDate: string;
  symbol: string;
  verdict: Verdict;
  /** ISO 8601 UTC. */
  decidedAt: string;
}

export interface MarkRef {
  strategyId: string;
  sessionDate: string;
}

/** One daily bar, newest first in every list. Raw (not split-adjusted) closes. */
export interface Bar {
  date: string;
  close: number;
  volume: number;
}

export interface LabMethod {
  id: string;
  name: string;
  family: string;
  hypothesis: string;
}

export interface Pick {
  symbol: string;
  rank: number;
  /** Book target weight (fraction); null for bracket candidates. */
  weight: number | null;
  evidence: unknown;
}

export interface Decision {
  strategyId: string;
  sessionDate: string;
  /** The night whose prices decided it (prev_session(sessionDate)); the data tools never read past it. */
  dataDate: string;
  kind: DecisionKind;
  stage: ReviewStage;
  /** 09:30 New York on sessionDate. A verdict counts only if decided before this. */
  openUtc: Date;
  /** Sorted by rank. */
  picks: Pick[];
}

export type Source = AdversarySource;

export interface ReviewVerdict {
  verdict: Verdict;
  reason: string;
  sources: Source[];
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  /** Exact model id when the SDK reported one, else the configured alias. */
  gatherModel: string;
  verdictModel: string;
}

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  usage: ReviewUsage;
  /** True when an agree/object without a fetched source became unsure. */
  downgraded: boolean;
}

/** The method brief: what Claude judges a pick through. */
export interface Lens {
  /** `<object_name or id>@<8 hex of text>`, stored as adversary_verdicts.lens. */
  id: string;
  text: string;
}

export interface ReviewContext {
  strategy: RosterRow;
  lens: Lens;
  promptVersion: string;
  decision: Decision;
  pick: Pick;
  /** Book only: whether the original holds the stock now; null for bracket decisions. */
  held: boolean | null;
  now: Date;
}

/** A review that produced no verdict. `usage` is what it spent before failing, when known. */
export class ReviewFailure extends Error {
  override name = 'ReviewFailure';
  constructor(
    message: string,
    readonly usage: ReviewUsage | null,
  ) {
    super(message);
  }
}

/** The seam between the job and a model. Production: createAgentReviewer; tests: tests/helpers/fakeReviewer.ts. Rejects with ReviewFailure. */
export interface StockReviewer {
  /** Configured aliases; they feed prompt_version. */
  readonly gatherModel: string;
  readonly verdictModel: string;
  review(ctx: ReviewContext, signal: AbortSignal): Promise<ReviewOutcome>;
}
