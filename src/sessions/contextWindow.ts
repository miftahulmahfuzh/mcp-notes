/**
 * Context window inference for a Claude Code session, and the colour band of its fill. Pure: no
 * I/O, no clock.
 *
 * The window is never stored (plan invariant 9). Readers derive it from the evidence ingest keeps
 * on `cc_sessions` (`context_model`, `context_peak_tokens`, `context_long_beta`, migration 0016),
 * so a rule change here needs no migration. First match wins:
 *   1. the model's table entry is 1M                                   -> 1M,   source `model`
 *   2. the session's context has ever exceeded 200,000 tokens (R2.2)   -> 1M,   source `peak`
 *   3. a main-thread request listed a `context-1m-*` beta, or the model
 *      id carries Claude Code's `[1m]` suffix (R2.3)                   -> 1M,   source `beta`
 *   4. the model's table entry (200K)                                  -> 200K, source `model`
 *   5. an unknown or missing model (R2.4)                              -> 200K, source `default`
 *
 * Windows from the claude-api skill (cached 2026-10-06). Claude Code sends the 1M beta for the 4.6
 * models only when the user picks their 1M variant, so they are 200K here unless evidence says
 * otherwise; the 5.x models, Opus 4.7 / 4.8 and Haiku 5.5 run 1M natively (measured 2026-11-12:
 * their sessions pass 200K with no beta). There is no user setting (R2.1).
 */

export const STANDARD_CONTEXT_WINDOW = 200_000;
export const LONG_CONTEXT_WINDOW = 1_000_000;
/** A context above this many tokens cannot fit a standard window: the session runs on 1M. */
export const LONG_CONTEXT_PEAK_THRESHOLD = STANDARD_CONTEXT_WINDOW;

/** Model id prefix -> window. Longest matching prefix wins (`claude-opus-5-5` matches `claude-opus-5`). */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  'claude-fable-5': LONG_CONTEXT_WINDOW,
  'claude-mythos-5': LONG_CONTEXT_WINDOW,
  'claude-opus-5': LONG_CONTEXT_WINDOW,
  'claude-opus-4-8': LONG_CONTEXT_WINDOW,
  'claude-opus-4-7': LONG_CONTEXT_WINDOW,
  'claude-opus-4-6': STANDARD_CONTEXT_WINDOW,
  'claude-sonnet-5': LONG_CONTEXT_WINDOW,
  'claude-sonnet-4-6': STANDARD_CONTEXT_WINDOW,
  'claude-haiku-5-5': LONG_CONTEXT_WINDOW,
  'claude-haiku-4-5': STANDARD_CONTEXT_WINDOW,
};

const PREFIXES = Object.keys(MODEL_CONTEXT_WINDOWS).sort((a, b) => b.length - a.length);
/** Claude Code's model-picker suffix for the 1M variant (`claude-opus-4-6[1m]`). */
const ONE_M_SUFFIX = /\[1m\]$/i;

export type ContextWindowSource = 'model' | 'peak' | 'beta' | 'default';

export interface ContextWindow {
  window: number;
  source: ContextWindowSource;
}

/** The stored evidence: `context_model`, `context_peak_tokens`, `context_long_beta`. */
export interface ContextWindowInput {
  model: string | null;
  peakTokens: number | null;
  longBeta: boolean;
}

/** The table window of a model id (`claude-haiku-4-5-20251001`, `claude-opus-4-6[1m]`), or null when no prefix matches. */
export function tableWindowOf(model: string): number | null {
  const id = model.toLowerCase();
  for (const prefix of PREFIXES) {
    if (id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}[`)) return MODEL_CONTEXT_WINDOWS[prefix] ?? null;
  }
  return null;
}

/** The session's context window and why (see the module comment for the rule order). */
export function contextWindowFor(input: ContextWindowInput): ContextWindow {
  const trimmed = input.model?.trim() ?? '';
  const model = trimmed === '' ? null : trimmed;
  const table = model === null ? null : tableWindowOf(model);
  if (table === LONG_CONTEXT_WINDOW) return { window: LONG_CONTEXT_WINDOW, source: 'model' };
  if (input.peakTokens !== null && input.peakTokens > LONG_CONTEXT_PEAK_THRESHOLD) return { window: LONG_CONTEXT_WINDOW, source: 'peak' };
  if (input.longBeta || (model !== null && ONE_M_SUFFIX.test(model))) return { window: LONG_CONTEXT_WINDOW, source: 'beta' };
  if (table !== null) return { window: table, source: 'model' };
  return { window: STANDARD_CONTEXT_WINDOW, source: 'default' };
}

export type ContextBand = 'green' | 'amber' | 'red';

/** Band thresholds in percent of the window: green below `amberFrom`, amber from it to below `redFrom`, red from `redFrom` (R1.6). */
export const CONTEXT_BANDS = { amberFrom: 40, redFrom: 70 } as const;

/** The band of a fill percent. Pass the same percent that is shown (contextPercent), so the colour and the number agree. */
export function contextBand(percent: number): ContextBand {
  if (percent >= CONTEXT_BANDS.redFrom) return 'red';
  if (percent >= CONTEXT_BANDS.amberFrom) return 'amber';
  return 'green';
}

/** `tokens` as a percent of `window`, one decimal (32,021 of 1M -> 3.2). 0 for a non-positive window or negative tokens. */
export function contextPercent(tokens: number, window: number): number {
  if (!(window > 0) || !(tokens >= 0)) return 0;
  return Math.round((tokens / window) * 1000) / 10;
}
