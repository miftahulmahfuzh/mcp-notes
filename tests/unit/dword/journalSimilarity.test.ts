import { describe, expect, it } from 'vitest';
import { normalizeForCompare, normShaFor, sha256Hex, textShaFor } from '../../../src/dword/journalSimilarity.js';

describe('journalSimilarity (ported from daily-words)', () => {
  it('folds whitespace and punctuation the same way as a re-paste', () => {
    expect(normalizeForCompare('Nothing to be done.')).toBe('nothing to be done');
    expect(normalizeForCompare('  Nothing   to be\ndone. ')).toBe('nothing to be done');
  });

  it('folds smart quotes to ASCII', () => {
    expect(normalizeForCompare('one’s')).toBe("one's");
    expect(normalizeForCompare("one's")).toBe("one's");
  });

  it('folds diacritics via NFKD', () => {
    expect(normalizeForCompare('Naïve.')).toBe('naive');
    expect(normalizeForCompare('Naive')).toBe('naive');
  });

  it('leaves an ordinary sentence with interior punctuation alone', () => {
    const s = "most things in life don't go according to one's wishes";
    expect(normalizeForCompare(s)).toBe(s);
  });

  it('normShaFor is pinned to a known hash (computed from this exact port, 2026-11-06)', () => {
    expect(normShaFor('Nothing to be done.')).toBe(
      'bf1af3710cdb483d1bd8c91a2ce96b694d1e21aec1f127dd84905998ea36f844',
    );
    expect(normShaFor('  Nothing   to be\ndone. ')).toBe(
      'bf1af3710cdb483d1bd8c91a2ce96b694d1e21aec1f127dd84905998ea36f844',
    );
    expect(normShaFor('one’s')).toBe(
      '7ea7241388353df98bdc17b8d3e411a6ff230ee886aad294a8f5169365995e09',
    );
  });

  it('textShaFor hashes the exact text, unnormalized (two near-identical lines differ)', () => {
    expect(textShaFor('Nothing to be done.')).not.toBe(textShaFor('Nothing to be done!'));
    expect(textShaFor('same')).toBe(sha256Hex('same'));
  });
});
