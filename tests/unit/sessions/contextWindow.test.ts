import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BANDS,
  contextBand,
  contextPercent,
  contextWindowFor,
  LONG_CONTEXT_WINDOW,
  STANDARD_CONTEXT_WINDOW,
} from '../../../src/sessions/contextWindow.js';

const w = (model: string | null, peakTokens: number | null = null, longBeta = false) => contextWindowFor({ model, peakTokens, longBeta });
const LONG_MODEL = { window: LONG_CONTEXT_WINDOW, source: 'model' };
const STANDARD_MODEL = { window: STANDARD_CONTEXT_WINDOW, source: 'model' };
const DEFAULT = { window: STANDARD_CONTEXT_WINDOW, source: 'default' };

describe('contextWindowFor', () => {
  it('reads the window from the model table, longest prefix first, with no user setting (R2.1)', () => {
    for (const m of [
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-haiku-5-5',
    ]) {
      expect(w(m), m).toEqual(LONG_MODEL);
    }
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'CLAUDE-HAIKU-4-5']) {
      expect(w(m), m).toEqual(STANDARD_MODEL);
    }
  });

  it('infers 1M once the context has exceeded 200,000 tokens (R2.2)', () => {
    expect(w('claude-sonnet-4-6', 200_001)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'peak' });
    expect(w('claude-sonnet-4-6', 200_000)).toEqual(STANDARD_MODEL);
    expect(w('glm-5.3', 250_000)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'peak' });
  });

  it('infers 1M from a context-1m beta or a [1m] model id (R2.3)', () => {
    expect(w('claude-sonnet-4-6', 92_484, true)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'beta' });
    expect(w('claude-opus-4-6[1m]')).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'beta' });
    expect(w(null, null, true)).toEqual({ window: LONG_CONTEXT_WINDOW, source: 'beta' });
  });

  it('uses 200,000 with source default for a model not in the table and no 1M evidence (R2.4)', () => {
    expect(w('glm-5.3', 6_335)).toEqual(DEFAULT);
    expect(w('claude-opus-6')).toEqual(DEFAULT);
    expect(w(null)).toEqual(DEFAULT);
    expect(w('  ')).toEqual(DEFAULT);
  });

  it('a native 1M model reports source model even with other evidence', () => {
    expect(w('claude-opus-5-5', 500_000, true)).toEqual(LONG_MODEL);
  });
});

describe('contextBand', () => {
  it('is green below 40, amber from 40 to below 70, red from 70', () => {
    expect(CONTEXT_BANDS).toEqual({ amberFrom: 40, redFrom: 70 });
    expect(contextBand(0)).toBe('green');
    expect(contextBand(39.9)).toBe('green');
    expect(contextBand(40)).toBe('amber');
    expect(contextBand(69.9)).toBe('amber');
    expect(contextBand(70)).toBe('red');
    expect(contextBand(100)).toBe('red');
  });
});

describe('contextPercent', () => {
  it('rounds to one decimal and never divides by zero', () => {
    expect(contextPercent(32_021, LONG_CONTEXT_WINDOW)).toBe(3.2);
    expect(contextPercent(150_000, STANDARD_CONTEXT_WINDOW)).toBe(75);
    expect(contextPercent(10, 0)).toBe(0);
  });
});
