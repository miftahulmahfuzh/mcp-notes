import type { ModelUsage } from '../db/schema.js';

/**
 * USD per million tokens, Anthropic first-party API rates (claude-api skill, cached 2026-10-06).
 * Cache writes are priced at 2x input: Claude Code writes 1-hour cache entries. Checked on
 * 2026-11-02 against sessions that carry Claude Code's own `cost-state` total: estimates at 2x land
 * within a few percent of it (e.g. $75.83 estimated vs $75.96 recorded); 1.25x (5-minute) falls short.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export const CACHE_WRITE_MULTIPLIER = 2;

/** Model id prefix -> price. Longest matching prefix wins, so dated ids (`claude-haiku-4-5-20251001`) match. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
};

const PREFIXES = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);

/** The price of a model id (`claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-opus-4-8[1m]`), or null when unknown. */
export function priceOf(model: string): ModelPrice | null {
  const id = model.toLowerCase();
  for (const prefix of PREFIXES) {
    if (id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}[`)) return MODEL_PRICES[prefix] ?? null;
  }
  return null;
}

/**
 * Estimated USD for per-model token counts; models without a known price are left out. Null when
 * nothing could be priced (no usage, or only unknown models).
 */
export function estimateCostUsd(models: Readonly<Record<string, Partial<ModelUsage>>> | null | undefined): number | null {
  let total = 0;
  let priced = false;
  for (const [model, u] of Object.entries(models ?? {})) {
    const p = priceOf(model);
    if (p === null) continue;
    priced = true;
    total +=
      ((u.inputTokens ?? 0) * p.input +
        (u.outputTokens ?? 0) * p.output +
        (u.cacheReadTokens ?? 0) * p.cacheRead +
        (u.cacheWriteTokens ?? 0) * p.input * CACHE_WRITE_MULTIPLIER) /
      1_000_000;
  }
  return priced ? total : null;
}
