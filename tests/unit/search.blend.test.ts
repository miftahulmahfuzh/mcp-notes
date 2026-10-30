import { describe, expect, it } from 'vitest';
import {
  BLEND,
  blendScore,
  isEligible,
  queryTerms,
  rankCandidates,
  recencyScore,
  similarityScore,
  tagMatch,
  type BlendCandidate,
} from '../../src/search/blend.js';

const NOW = new Date('2026-10-30T00:00:00Z');
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

function cand(id: string, over: Partial<BlendCandidate> = {}): BlendCandidate {
  return { id, textRank: null, similarity: null, tagMatch: 0, updatedAt: NOW, ...over };
}

const order = (cs: readonly BlendCandidate[]): string[] => rankCandidates(cs, { now: NOW }).map((r) => r.id);

describe('BLEND', () => {
  it('lets the best full-text match beat any meaning-only match', () => {
    expect(BLEND.textFloor + BLEND.text).toBeGreaterThan(BLEND.vector + BLEND.tag + BLEND.recency);
  });

  it('puts an exact id above any sum of the other signals', () => {
    expect(BLEND.exactId).toBeGreaterThan(BLEND.textFloor + BLEND.text + BLEND.vector + BLEND.tag + BLEND.recency);
  });

  it('keeps thresholds and limits in range', () => {
    expect(BLEND.minSimilarity).toBeGreaterThan(0);
    expect(BLEND.minSimilarity).toBeLessThan(1);
    expect(BLEND.recencyHalfLifeDays).toBeGreaterThan(0);
    expect(Number.isInteger(BLEND.textCandidates) && BLEND.textCandidates > 0).toBe(true);
    expect(Number.isInteger(BLEND.vectorCandidates) && BLEND.vectorCandidates > 0).toBe(true);
    for (const w of [BLEND.textFloor, BLEND.text, BLEND.vector, BLEND.tag, BLEND.recency, BLEND.hashtagHit, BLEND.wordTagHit]) {
      expect(w).toBeGreaterThan(0);
    }
  });
});

describe('queryTerms', () => {
  it('splits hashtags, bare words, exclusions and ids', () => {
    expect(queryTerms('#Seer retry "connection pool" -redis A-B32')).toEqual({
      hashtags: ['seer'],
      words: ['retry', 'connection', 'pool'],
      ids: ['A-B32'],
      excluded: ['redis'],
    });
  });

  it('reads a lower-case dashed id and a lone four-character id with a digit', () => {
    expect(queryTerms('what did a-b32 say').ids).toEqual(['A-B32']);
    expect(queryTerms(' ab32 ').ids).toEqual(['A-B32']);
    expect(queryTerms('ab32').words).toEqual([]);
  });

  it('does not take ordinary words for ids', () => {
    expect(queryTerms('pool').ids).toEqual([]);
    expect(queryTerms('ab32 pool').ids).toEqual([]);
    expect(queryTerms('e-mail the team').ids).toEqual([]);
  });

  it('drops one-letter words and the OR operator', () => {
    expect(queryTerms('a pool OR redis').words).toEqual(['pool', 'redis']);
  });
});

describe('signals', () => {
  it('tagMatch: a #hashtag fills it, a bare word counts half, capped at 1', () => {
    const terms = queryTerms('#seer pool notes');
    expect(tagMatch(['seer'], terms)).toBe(1);
    expect(tagMatch(['pool'], terms)).toBe(BLEND.wordTagHit);
    expect(tagMatch(['pool', 'notes', 'seer'], terms)).toBe(1);
    expect(tagMatch(['other'], terms)).toBe(0);
  });

  it('recencyScore halves every half-life and treats future dates as now', () => {
    expect(recencyScore(NOW, NOW)).toBe(1);
    expect(recencyScore(daysAgo(BLEND.recencyHalfLifeDays), NOW)).toBeCloseTo(0.5, 10);
    expect(recencyScore(daysAgo(2 * BLEND.recencyHalfLifeDays), NOW)).toBeCloseTo(0.25, 10);
    expect(recencyScore(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(1);
  });

  it('similarityScore rescales from minSimilarity and ignores null and NaN', () => {
    expect(similarityScore(null)).toBe(0);
    expect(similarityScore(Number.NaN)).toBe(0);
    expect(similarityScore(BLEND.minSimilarity)).toBe(0);
    expect(similarityScore(1)).toBe(1);
    expect(similarityScore(0.1)).toBe(0);
  });

  it('isEligible keeps literal and id matches, drops weak meaning-only ones', () => {
    const base = { exactId: false, textRank: null, similarity: null, tagMatch: 0, recency: 1 };
    expect(isEligible({ ...base, textRank: 0 })).toBe(true);
    expect(isEligible({ ...base, exactId: true })).toBe(true);
    expect(isEligible({ ...base, similarity: BLEND.minSimilarity })).toBe(true);
    expect(isEligible({ ...base, similarity: BLEND.minSimilarity - 0.01 })).toBe(false);
    expect(isEligible(base)).toBe(false);
  });

  it('blendScore adds the parts', () => {
    const s = blendScore({ exactId: false, textRank: 1, similarity: 1, tagMatch: 1, recency: 1 });
    expect(s).toBeCloseTo(BLEND.textFloor + BLEND.text + BLEND.vector + BLEND.tag + BLEND.recency, 10);
    expect(blendScore({ exactId: true, textRank: null, similarity: null, tagMatch: 0, recency: 0 })).toBe(BLEND.exactId);
  });
});

describe('rankCandidates', () => {
  it('keeps a lone, old, low-ranked full-text match above a perfect, fresh, tagged meaning match', () => {
    const rare = cand('rare', { textRank: 0.0001, updatedAt: daysAgo(900) });
    const rival = cand('rival', { similarity: 1, tagMatch: 1, updatedAt: NOW });
    expect(order([rival, rare])).toEqual(['rare', 'rival']);
  });

  it('puts the named id first, even above the best text and meaning match', () => {
    const named = cand('named', { exactId: true, updatedAt: daysAgo(2000) });
    const best = cand('best', { textRank: 0.5, similarity: 1, tagMatch: 1 });
    expect(order([best, named])).toEqual(['named', 'best']);
  });

  it('drops meaning-only candidates under minSimilarity and keeps the rest', () => {
    const near = cand('near', { similarity: 0.8 });
    const far = cand('far', { similarity: BLEND.minSimilarity / 2 });
    const none = cand('none');
    expect(order([far, near, none])).toEqual(['near']);
  });

  it('normalizes text rank by the best candidate', () => {
    const [a, b] = rankCandidates([cand('a', { textRank: 0.002 }), cand('b', { textRank: 0.001 })], { now: NOW });
    expect(a!.score).toBeCloseTo(BLEND.textFloor + BLEND.text + BLEND.recency, 10);
    expect(b!.score).toBeCloseTo(BLEND.textFloor + BLEND.text * 0.5 + BLEND.recency, 10);
  });

  it('lets meaning reorder literal hits of equal rank', () => {
    const plain = cand('plain', { textRank: 0.1, similarity: 0.2 });
    const close = cand('close', { textRank: 0.1, similarity: 0.9 });
    expect(order([plain, close])).toEqual(['close', 'plain']);
  });

  it('lets a strong meaning match pass a weak literal hit', () => {
    const top = cand('top', { textRank: 1 });
    const weak = cand('weak', { textRank: 0.01, updatedAt: daysAgo(720) });
    const meaning = cand('meaning', { similarity: 0.95, tagMatch: 1 });
    expect(order([weak, meaning, top])).toEqual(['top', 'meaning', 'weak']);
  });

  it('breaks score ties by updated_at desc, then id desc', () => {
    const older = cand('A-AAA', { textRank: 1, updatedAt: daysAgo(1) });
    const newer = cand('B-BBB', { textRank: 1, updatedAt: NOW });
    const sameTimeLowId = cand('C-CCC', { textRank: 1, updatedAt: NOW });
    expect(order([older, newer, sameTimeLowId])).toEqual(['C-CCC', 'B-BBB', 'A-AAA']);
  });

  it('returns the caller objects with a score attached', () => {
    const c = { ...cand('x', { textRank: 1 }), extra: 42 };
    const [r] = rankCandidates([c], { now: NOW });
    expect(r!.extra).toBe(42);
    expect(typeof r!.score).toBe('number');
  });
});
