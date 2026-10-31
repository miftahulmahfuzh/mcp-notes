import { describe, expect, it } from 'vitest';
import { noteImageEmbeddings } from '../../../src/db/schema.js';
import {
  IMAGE_EMBEDDING_DIMENSIONS,
  IMAGE_EMBEDDING_MODEL,
  IMAGE_EMBED_LONG_EDGE,
  estimateImageCostUsd,
  estimateImageTokens,
} from '../../../src/embeddings/imageConstants.js';

describe('image embedding constants', () => {
  it('name the verified model and match the column width under the HNSW cap', () => {
    expect(IMAGE_EMBEDDING_MODEL).toBe('google/gemini-embedding-2');
    expect(IMAGE_EMBEDDING_DIMENSIONS).toBe(1536);
    expect(IMAGE_EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(2000);
    expect(noteImageEmbeddings.embedding.getSQLType()).toBe(`vector(${IMAGE_EMBEDDING_DIMENSIONS})`);
    expect(IMAGE_EMBED_LONG_EDGE).toBe(1024);
  });

  it.each([
    [12, 12, 258],
    [384, 384, 258],
    [385, 100, 258],
    [1024, 768, 516],
    [4000, 3000, 516],
    [3000, 4000, 516],
    [1024, 1024, 1032],
    [0, 0, 258],
  ])('estimateImageTokens(%i, %i) = %i', (w, h, tokens) => {
    expect(estimateImageTokens(w, h)).toBe(tokens);
  });

  it('prices image tokens at $0.45 per million', () => {
    expect(estimateImageCostUsd(1_000_000)).toBeCloseTo(0.45, 10);
    expect(estimateImageCostUsd(516)).toBeCloseTo(0.0002322, 10);
    expect(estimateImageCostUsd(-5)).toBe(0);
  });
});
