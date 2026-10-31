import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { EmbeddingError } from '../../../src/embeddings/embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../../src/embeddings/imageConstants.js';
import { cosine } from '../../helpers/fakeEmbedder.js';
import { FakeImageEmbedder, vectorForColour, vectorForHash } from '../../helpers/fakeImageEmbedder.js';

function solid(rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: rgb } }).png().toBuffer();
}

describe('FakeImageEmbedder', () => {
  it('uses the real model id and width, and returns unit vectors', async () => {
    const fake = new FakeImageEmbedder();
    expect(fake.model).toBe(IMAGE_EMBEDDING_MODEL);
    expect(fake.dimensions).toBe(IMAGE_EMBEDDING_DIMENSIONS);
    const v = await fake.embedImage(await solid({ r: 200, g: 10, b: 10 }));
    expect(v).toHaveLength(IMAGE_EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
  });

  it('is deterministic, and similar colours are close while different ones are far', async () => {
    const fake = new FakeImageEmbedder();
    const red = await fake.embedImage(await solid({ r: 220, g: 20, b: 20 }));
    const again = await fake.embedImage(await solid({ r: 220, g: 20, b: 20 }));
    const darkRed = await fake.embedImage(await solid({ r: 110, g: 10, b: 10 }));
    const blue = await fake.embedImage(await solid({ r: 20, g: 20, b: 220 }));
    expect(again).toEqual(red);
    expect(cosine(red, darkRed)).toBeGreaterThan(0.99);
    // red . blue = ~0.19 with the 0.05 bias axis; far enough apart for every ordering test.
    expect(cosine(red, blue)).toBeLessThan(0.5);
  });

  it('maps colour words into the image space and hashes other text', async () => {
    const fake = new FakeImageEmbedder();
    const red = await fake.embedImage(await solid({ r: 220, g: 20, b: 20 }));
    expect(cosine(await fake.embedText('red top in a car'), red)).toBeGreaterThan(0.99);
    expect(await fake.embedText('a whiteboard')).toEqual(vectorForHash('a whiteboard'));
    expect(cosine(vectorForHash('a whiteboard'), vectorForColour({ r: 0, g: 0, b: 0 }))).toBe(0);
  });

  it('validates like the real client, records calls and scripts failures', async () => {
    const fake = new FakeImageEmbedder();
    await expect(fake.embedImage(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(EmbeddingError);
    await expect(fake.embedText('  ')).rejects.toBeInstanceOf(EmbeddingError);
    expect(fake.calls).toEqual([]);
    fake.failNext(1);
    await expect(fake.embedText('red')).rejects.toThrow(/scripted failure/);
    await expect(fake.embedText('red')).resolves.toHaveLength(IMAGE_EMBEDDING_DIMENSIONS);
    expect(fake.calls).toEqual([
      { kind: 'text', text: 'red' },
      { kind: 'text', text: 'red' },
    ]);
  });
});
