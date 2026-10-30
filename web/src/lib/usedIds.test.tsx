import { describe, expect, it } from 'vitest';
import { extractUsedIds } from './usedIds';

describe('extractUsedIds', () => {
  const known = ['A-B32', 'K-F07', 'R-M14'];
  it('finds known ids case-insensitively, in first-mention order, deduped', () => {
    expect(extractUsedIds('see (k-f07), then A-B32 and again a-b32.', known)).toEqual(['K-F07', 'A-B32']);
  });
  it('ignores unknown ids, ids inside longer tokens, and dashless forms', () => {
    expect(extractUsedIds('Z-Z99 XA-B32 A-B32X AB32 R-M14-2', known)).toEqual([]);
  });
  it('returns nothing for empty text', () => {
    expect(extractUsedIds('', known)).toEqual([]);
  });
});
