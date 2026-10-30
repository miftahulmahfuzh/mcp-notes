import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../../src/embeddings/constants.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import {
  QueryVectorCache,
  SEMANTIC_OFF_FALLBACK,
  embedFailedFallback,
  embedQuery,
} from '../../src/search/queryVector.js';

interface Scripted {
  embedder: Embedder;
  calls: string[][];
}

function scripted(opts: { model?: string; fail?: Error; delayMs?: number; width?: number } = {}): Scripted {
  const calls: string[][] = [];
  const embedder: Embedder = {
    model: opts.model ?? 'test/model',
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(inputs: readonly string[]): Promise<number[][]> {
      calls.push([...inputs]);
      if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail !== undefined) throw opts.fail;
      return inputs.map(() => new Array<number>(opts.width ?? EMBEDDING_DIMENSIONS).fill(0.01));
    },
  };
  return { embedder, calls };
}

describe('QueryVectorCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new QueryVectorCache(2);
    cache.set('a', [1]);
    cache.set('b', [2]);
    expect(cache.get('a')).toEqual([1]); // a is now newest
    cache.set('c', [3]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual([1]);
    expect(cache.get('c')).toEqual([3]);
    expect(cache.size).toBe(2);
  });
});

describe('embedQuery', () => {
  it('embeds the trimmed query once and serves repeats from the cache', async () => {
    const { embedder, calls } = scripted();
    const cache = new QueryVectorCache();
    const v1 = await embedQuery(embedder, cache, '  ArangoDB credentials ');
    const v2 = await embedQuery(embedder, cache, 'ArangoDB credentials');
    expect(v1).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(v2).toBe(v1);
    expect(calls).toEqual([['ArangoDB credentials']]);
  });

  it('keys the cache by model', async () => {
    const cache = new QueryVectorCache();
    const a = scripted({ model: 'm/a' });
    const b = scripted({ model: 'm/b' });
    await embedQuery(a.embedder, cache, 'q');
    await embedQuery(b.embedder, cache, 'q');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('does not cache failures', async () => {
    const cache = new QueryVectorCache();
    const { embedder, calls } = scripted({ fail: new Error('boom') });
    await expect(embedQuery(embedder, cache, 'q')).rejects.toThrow('boom');
    await expect(embedQuery(embedder, cache, 'q')).rejects.toThrow('boom');
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(0);
  });

  it('times out a slow embedder', async () => {
    const { embedder } = scripted({ delayMs: 200 });
    await expect(embedQuery(embedder, new QueryVectorCache(), 'q', 20)).rejects.toThrow(/timed out after 20 ms/);
  });

  it('rejects a vector of the wrong width', async () => {
    const { embedder } = scripted({ width: 3 });
    await expect(embedQuery(embedder, new QueryVectorCache(), 'q')).rejects.toThrow(/3 dimensions/);
  });

  it('rejects an empty query without calling the embedder', async () => {
    const { embedder, calls } = scripted();
    await expect(embedQuery(embedder, new QueryVectorCache(), '   ')).rejects.toThrow(/empty/);
    expect(calls).toHaveLength(0);
  });
});

describe('fallback messages', () => {
  it('say the results are full-text only, and why', () => {
    expect(SEMANTIC_OFF_FALLBACK).toMatch(/OPENROUTER_API_KEY/);
    expect(SEMANTIC_OFF_FALLBACK).toMatch(/full-text results only/);
    const msg = embedFailedFallback(new Error('upstream 503'));
    expect(msg).toContain('upstream 503');
    expect(msg).toMatch(/full-text results only/);
  });

  it('clip a long reason', () => {
    const msg = embedFailedFallback(new Error('x'.repeat(1000)));
    expect(msg.length).toBeLessThan(400);
  });
});
