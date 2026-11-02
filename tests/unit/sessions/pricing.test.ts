import { describe, expect, it } from 'vitest';
import { CACHE_WRITE_MULTIPLIER, estimateCostUsd, priceOf } from '../../../src/sessions/pricing.js';

describe('priceOf', () => {
  it('matches the longest prefix, with dated and [1m] ids', () => {
    expect(priceOf('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2 });
    expect(priceOf('claude-opus-5')).toEqual({ input: 5, output: 25, cacheRead: 0.5 });
    expect(priceOf('claude-opus-4-8[1m]')).toEqual({ input: 5, output: 25, cacheRead: 0.5 });
    expect(priceOf('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5, cacheRead: 0.1 });
    expect(priceOf('claude-fable-5-1')?.cacheRead).toBe(0.25);
    expect(priceOf('claude-fable-5')?.cacheRead).toBe(1);
  });

  it('knows nothing of other models, or of look-alike prefixes', () => {
    expect(priceOf('glm-4.6')).toBeNull();
    expect(priceOf('<synthetic>')).toBeNull();
    expect(priceOf('claude-opus-55')).toBeNull();
  });
});

describe('estimateCostUsd', () => {
  it('prices every counter, cache writes at the 1-hour rate', () => {
    const usd = estimateCostUsd({
      'claude-opus-5-5': { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
    });
    expect(usd).toBeCloseTo(4 + 20 + 0.2 + 4 * CACHE_WRITE_MULTIPLIER, 10);
  });

  it('sums models and skips unknown ones; null when nothing is priced', () => {
    expect(estimateCostUsd({ 'claude-haiku-5-5': { outputTokens: 2_000_000 }, 'glm-4.6': { outputTokens: 9_000_000 } })).toBeCloseTo(1, 10);
    expect(estimateCostUsd({ 'glm-4.6': { outputTokens: 1 } })).toBeNull();
    expect(estimateCostUsd({})).toBeNull();
    expect(estimateCostUsd(null)).toBeNull();
  });
});
