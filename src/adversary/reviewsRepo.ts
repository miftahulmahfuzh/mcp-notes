import { and, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { adversaryReviews, type AdversaryStoredVerdict } from '../db/schema.js';
import { attemptKey, draftKey, type DraftRef } from './plan.js';
import type { ReviewStage } from './types.js';

export type ReviewStatus = 'ok' | 'failed' | 'skipped_budget' | 'late';

/** Statuses that spent a deep review (counted against the daily cap unless reused). */
const DEEP: ReviewStatus[] = ['ok', 'failed', 'late'];

export interface NewReview {
  strategyId: string;
  sessionDate: string;
  symbol: string;
  stage: ReviewStage;
  status: ReviewStatus;
  verdict: AdversaryStoredVerdict | null;
  promptVersion: string;
  gatherModel: string | null;
  verdictModel: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  error: string | null;
  host: string;
  reusedFrom: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface RecentReviews {
  /** draftKey -> latest ok draft. */
  drafts: Map<string, DraftRef>;
  /** attemptKey -> failed attempts. */
  failures: Map<string, number>;
  /** attemptKey of skipped_budget rows since the start of today (WIB). */
  skippedToday: Set<string>;
  /** Deep reviews since the start of today (WIB). */
  usedToday: number;
}

/** The only writer of adversary_reviews: the reviewer's attempt log, usage log and draft store. */
export class ReviewsRepo {
  constructor(private readonly db: Db) {}

  async insert(row: NewReview): Promise<number> {
    const inserted = await this.db
      .insert(adversaryReviews)
      .values({
        strategyId: row.strategyId,
        sessionDate: row.sessionDate,
        symbol: row.symbol,
        stage: row.stage,
        status: row.status,
        verdict: row.verdict,
        promptVersion: row.promptVersion,
        gatherModel: row.gatherModel,
        verdictModel: row.verdictModel,
        inputTokens: Math.round(row.inputTokens),
        outputTokens: Math.round(row.outputTokens),
        costUsd: row.costUsd,
        turns: Math.round(row.turns),
        error: row.error,
        host: row.host,
        reusedFrom: row.reusedFrom,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      })
      .returning({ id: adversaryReviews.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error('adversary_reviews insert returned no id');
    return id;
  }

  /** Deep reviews started at or after `since`, both machines. */
  async countDeepSince(since: Date): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(adversaryReviews)
      .where(and(gte(adversaryReviews.startedAt, since), inArray(adversaryReviews.status, DEEP), isNull(adversaryReviews.reusedFrom)));
    return rows[0]?.n ?? 0;
  }

  /** Everything the planner needs from rows started at or after `since` (dayStart >= since). */
  async recent(since: Date, dayStart: Date): Promise<RecentReviews> {
    const rows = await this.db.select().from(adversaryReviews).where(gte(adversaryReviews.startedAt, since)).orderBy(adversaryReviews.startedAt, adversaryReviews.id);
    const out: RecentReviews = { drafts: new Map(), failures: new Map(), skippedToday: new Set(), usedToday: 0 };
    for (const row of rows) {
      const stage = row.stage as ReviewStage;
      const attempt = attemptKey(row.strategyId, row.sessionDate, row.symbol, stage);
      const today = row.startedAt.getTime() >= dayStart.getTime();
      if (row.status === 'failed') out.failures.set(attempt, (out.failures.get(attempt) ?? 0) + 1);
      if (row.status === 'skipped_budget' && today) out.skippedToday.add(attempt);
      if (today && (DEEP as string[]).includes(row.status) && row.reusedFrom === null) out.usedToday += 1;
      if (stage === 'draft' && row.status === 'ok' && row.verdict !== null) {
        out.drafts.set(draftKey(row.strategyId, row.sessionDate, row.symbol, row.promptVersion), {
          id: row.id,
          startedAt: row.startedAt,
          verdict: row.verdict,
          gatherModel: row.gatherModel,
          verdictModel: row.verdictModel,
        });
      }
    }
    return out;
  }
}
