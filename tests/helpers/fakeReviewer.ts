import { ReviewFailure, type ReviewContext, type ReviewUsage, type ReviewVerdict, type StockReviewer } from '../../src/adversary/types.js';

/** What every fake review reports having spent. */
export const FAKE_USAGE: ReviewUsage = {
  inputTokens: 1_200,
  outputTokens: 150,
  costUsd: 0.05,
  turns: 6,
  gatherModel: 'claude-sonnet-test',
  verdictModel: 'claude-opus-test',
};

export interface FakeReviewer extends StockReviewer {
  /** Every review asked for, in order. */
  readonly calls: ReviewContext[];
}

export interface FakeReviewerOptions {
  /** Each review waits for this before answering (lease tests). */
  gate?: Promise<void>;
  verdict?: (ctx: ReviewContext) => ReviewVerdict;
  /** A non-null message fails that review. */
  fail?: (ctx: ReviewContext) => string | null;
}

/** Default: object, citing one page "fetched" at ctx.now. */
export function fakeReviewer(options: FakeReviewerOptions = {}): FakeReviewer {
  const calls: ReviewContext[] = [];
  return {
    gatherModel: 'sonnet',
    verdictModel: 'opus',
    calls,
    async review(ctx, signal) {
      calls.push(ctx);
      if (options.gate !== undefined) await options.gate;
      if (signal.aborted) throw new ReviewFailure('review stopped', null);
      const failure = options.fail?.(ctx) ?? null;
      if (failure !== null) throw new ReviewFailure(failure, { ...FAKE_USAGE });
      const verdict: ReviewVerdict = options.verdict?.(ctx) ?? {
        verdict: 'object',
        reason: `Test objection to ${ctx.pick.symbol}.`,
        sources: [
          {
            url: `https://news.example.com/${ctx.pick.symbol.toLowerCase()}`,
            title: 'Test page',
            publisher: 'Example News',
            published_at: null,
            fetched_at: ctx.now.toISOString(),
          },
        ],
      };
      return { verdict, usage: { ...FAKE_USAGE }, downgraded: false };
    },
  };
}
