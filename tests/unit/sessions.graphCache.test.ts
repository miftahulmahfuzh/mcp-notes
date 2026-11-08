import { describe, expect, it } from 'vitest';
import { GRAPH_CACHE_MAX_AGE_MS, GRAPH_CACHE_MAX_ENTRIES, GraphCache } from '../../src/sessions/graphCache.js';

const snap = (fingerprint: string, at = 0) => ({ fingerprint, at, rows: [1], more: false, total: 1 });

describe('GraphCache', () => {
  it('hits on the same fingerprint, misses on a changed one', () => {
    const c = new GraphCache<number>();
    c.set('k', snap('a'));
    expect(c.get('k', 'a', 1)).not.toBeNull();
    expect(c.get('k', 'b', 1)).toBeNull();
  });
  it('misses after the max age', () => {
    const c = new GraphCache<number>();
    c.set('k', snap('a', 0));
    expect(c.get('k', 'a', GRAPH_CACHE_MAX_AGE_MS)).not.toBeNull();
    expect(c.get('k', 'a', GRAPH_CACHE_MAX_AGE_MS + 1)).toBeNull();
  });
  it('evicts the least recently used entry past the cap', () => {
    const c = new GraphCache<number>();
    for (let i = 0; i < GRAPH_CACHE_MAX_ENTRIES; i++) c.set(`k${i}`, snap('a'));
    c.get('k0', 'a', 1); // touch k0, so k1 is now oldest
    c.set('extra', snap('a'));
    expect(c.get('k1', 'a', 1)).toBeNull();
    expect(c.get('k0', 'a', 1)).not.toBeNull();
    expect(c.get('extra', 'a', 1)).not.toBeNull();
  });
});
