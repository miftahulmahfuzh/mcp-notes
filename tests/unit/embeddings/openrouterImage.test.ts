import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_EMBEDDINGS_URL } from '../../../src/embeddings/constants.js';
import { EmbeddingError, embeddingErrorText } from '../../../src/embeddings/embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../../src/embeddings/imageConstants.js';
import {
  MAX_EMBED_PNG_BYTES,
  OPENROUTER_IMAGE_EMBED_TIMEOUT_MS,
  createOpenRouterImageEmbedder,
  fitVector,
  imageEmbedderFromConfig,
  isPng,
} from '../../../src/embeddings/openrouterImage.js';

const KEY = 'sk-or-v1-TEST-SECRET-0123456789';
let PNG: Buffer;

beforeAll(async () => {
  PNG = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .png()
    .toBuffer();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Seen = { url: string; init: RequestInit; body: unknown };

function fakeFetch(answer: (body: unknown) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as unknown;
    seen.push({ url: String(url), init: init ?? {}, body });
    return answer(body);
  });
  return { f, seen };
}

function vectorOf(width: number, value = 1): number[] {
  return new Array<number>(width).fill(value);
}

function embedder(f: unknown, timeoutMs?: number) {
  return createOpenRouterImageEmbedder({
    apiKey: KEY,
    fetch: f as unknown as typeof fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

async function failure(p: Promise<unknown>): Promise<EmbeddingError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(embeddingErrorText(err)).not.toContain(KEY);
    expect((err as Error).message).not.toContain(KEY);
    return err as EmbeddingError;
  }
  throw new Error('expected a rejection');
}

describe('createOpenRouterImageEmbedder', () => {
  it('exposes the model and width, and refuses a blank key without a request', () => {
    const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding: vectorOf(1536) }] }));
    const e = embedder(f);
    expect(e.model).toBe(IMAGE_EMBEDDING_MODEL);
    expect(e.dimensions).toBe(IMAGE_EMBEDDING_DIMENSIONS);
    expect(OPENROUTER_IMAGE_EMBED_TIMEOUT_MS).toBe(30_000);
    expect(() => createOpenRouterImageEmbedder({ apiKey: '  ', fetch: f as unknown as typeof fetch })).toThrow(EmbeddingError);
    expect(f).not.toHaveBeenCalled();
  });

  it('sends one image as an image-only content item with a PNG data URL', async () => {
    const { f, seen } = fakeFetch(() => json({ data: [{ index: 0, embedding: vectorOf(1536) }] }));
    await embedder(f).embedImage(PNG);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(OPENROUTER_EMBEDDINGS_URL);
    expect(seen[0]!.init.method).toBe('POST');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body).toEqual({
      model: 'google/gemini-embedding-2',
      input: [{ content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] }],
      encoding_format: 'float',
      dimensions: 1536,
    });
  });

  it('sends a query as a text-only content item, trimmed', async () => {
    const { f, seen } = fakeFetch(() => json({ data: [{ embedding: vectorOf(1536) }] }));
    await embedder(f).embedText('  red top in a car \n');
    expect(seen[0]!.body).toEqual({
      model: 'google/gemini-embedding-2',
      input: [{ content: [{ type: 'text', text: 'red top in a car' }] }],
      encoding_format: 'float',
      dimensions: 1536,
    });
  });

  it('returns a 1536-wide answer L2-normalised', async () => {
    const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding: vectorOf(1536, 3) }] }));
    const v = await embedder(f).embedImage(PNG);
    expect(v).toHaveLength(1536);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    expect(v[0]).toBeCloseTo(1 / Math.sqrt(1536), 12);
  });

  it('cuts a 3072-wide answer to its first 1536 values and renormalises them', async () => {
    const wide = [...vectorOf(1536, 2), ...vectorOf(1536, 1000)];
    const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding: wide }] }));
    const v = await embedder(f).embedText('red');
    expect(v).toHaveLength(1536);
    expect(v.every((x) => Math.abs(x - 1 / Math.sqrt(1536)) < 1e-12)).toBe(true);
  });

  it('refuses a narrower vector, a non-number value and a zero vector', async () => {
    const cases: Array<[unknown[], RegExp]> = [
      [vectorOf(1000), /1000 value\(s\).*vector\(1536\)/],
      // JSON cannot carry NaN; a null element is what a broken provider would send instead.
      [[...vectorOf(1535), null], /non-finite/],
      [vectorOf(1536, 0), /zero length/],
    ];
    for (const [embedding, pattern] of cases) {
      const { f } = fakeFetch(() => json({ data: [{ index: 0, embedding }] }));
      const err = await failure(embedder(f).embedImage(PNG));
      expect(err.message).toMatch(pattern);
    }
    expect(() => fitVector([...vectorOf(1535), Number.NaN])).toThrow(/non-finite/);
  });

  it('refuses non-PNG bytes, an oversized PNG and an empty query without a request', async () => {
    const { f } = fakeFetch(() => json({ data: [{ embedding: vectorOf(1536) }] }));
    const e = embedder(f);
    await failure(e.embedImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5])));
    const big = new Uint8Array(MAX_EMBED_PNG_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    await failure(e.embedImage(big));
    await failure(e.embedText('   '));
    expect(f).not.toHaveBeenCalled();
  });

  it('turns transport, status, JSON and shape problems into EmbeddingError without the key', async () => {
    const cases: Array<[() => Promise<Response>, RegExp]> = [
      [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, /timed out after 5 ms/],
      [async () => { throw new TypeError('fetch failed'); }, /embedding request failed/],
      [async () => new Response(`upstream says no; key ${KEY}`.replace(KEY, 'xxx'), { status: 502 }), /returned 502/],
      [async () => new Response('<html>', { status: 200 }), /not valid JSON/],
      [async () => json({ nope: true }), /no data array/],
      [async () => json({ data: [{ embedding: vectorOf(1536) }, { embedding: vectorOf(1536) }] }), /2 vector\(s\) for 1 input/],
      [async () => json({ data: [{ index: 3, embedding: vectorOf(1536) }] }), /bad index 3/],
      [async () => json({ data: [{ index: 0, embedding: 'AAAA' }] }), /no vector at data\[0\]\.embedding/],
    ];
    for (const [answer, pattern] of cases) {
      const f = vi.fn(answer);
      const err = await failure(embedder(f, 5).embedImage(PNG));
      expect(err.message).toMatch(pattern);
    }
  });

  it('imageEmbedderFromConfig is null without a key', () => {
    expect(imageEmbedderFromConfig({ apiKey: null })).toBeNull();
    expect(imageEmbedderFromConfig({ apiKey: KEY })?.model).toBe(IMAGE_EMBEDDING_MODEL);
  });
});

describe('fitVector and isPng', () => {
  it('keeps the first width values, normalised, and asserts the width', () => {
    expect(fitVector([3, 4, 99], 2)).toEqual([0.6, 0.8]);
    expect(() => fitVector([1], 2)).toThrow(EmbeddingError);
  });

  it('recognises the PNG signature', () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(PNG.subarray(0, 8))).toBe(false);
    expect(isPng(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
