/**
 * Opt-in live probe of image embeddings: a handful of real, billed OpenRouter calls to
 * google/gemini-embedding-2 (well under a cent). Run with `npm run test:live:imageEmbeddings`
 * (IMAGE_EMBEDDINGS_LIVE_TEST=1; no Docker, no database). Never part of `npm test`,
 * `npm run test:int` or the other live suites.
 *
 * It documents the request shapes src/embeddings/openrouterImage.ts sends (printed as a
 * "[live] ... request shapes" block) and checks what the fakes cannot: an image-only content item
 * with a PNG data URL comes back as a vector we can fit to vector(1536); a text-only content item
 * lands in the same space (a "red" query is nearer a red square than a blue one); and a
 * provider-shortened vector (`dimensions: 1536`) agrees with a client-shortened one (first 1536 of
 * the default 3072, renormalised). When a shape here starts failing, fix imageRequestBody /
 * textRequestBody first (for example drop `dimensions` from the image body: fitVector truncates).
 *
 * Needs OPENROUTER_API_KEY in the environment or in .env.local (a worktree carries a symlink to
 * ~/mcp-notes/.env.local). The key is never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../src/embeddings/imageConstants.js';
import type { ImageEmbedder } from '../../src/embeddings/imageEmbedder.js';
import { postOpenRouterEmbeddings } from '../../src/embeddings/openrouter.js';
import {
  createOpenRouterImageEmbedder,
  fitVector,
  imageRequestBody,
  textRequestBody,
} from '../../src/embeddings/openrouterImage.js';

const TIMEOUT_MS = 30_000;

function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = path.resolve(import.meta.dirname, '../../.env.local');
  if (existsSync(file)) {
    const fromFile = parse(readFileSync(file)).OPENROUTER_API_KEY?.trim();
    if (fromFile) return fromFile;
  }
  throw new Error(
    'OPENROUTER_API_KEY is not set. Export it or put it in .env.local ' +
      '(in a worktree: ln -sf /home/miftah/mcp-notes/.env.local .env.local).',
  );
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function embeddingOf(json: unknown): number[] {
  const first = (json as { data?: Array<{ embedding?: unknown }> }).data?.[0]?.embedding;
  if (!Array.isArray(first)) throw new Error('no data[0].embedding in the response');
  return first as number[];
}

async function solid(rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: rgb } }).png().toBuffer();
}

let key: string;
let embedder: ImageEmbedder;
let red: Buffer;
let blue: Buffer;

beforeAll(async () => {
  key = apiKey();
  embedder = createOpenRouterImageEmbedder({ apiKey: key });
  red = await solid({ r: 220, g: 20, b: 20 });
  blue = await solid({ r: 20, g: 20, b: 220 });
});

describe(`${IMAGE_EMBEDDING_MODEL} on OpenRouter (live, billed)`, () => {
  it('embeds a PNG data URL with the verified shape, fitted to 1536 unit-length values', async () => {
    const v = await embedder.embedImage(red);
    expect(v).toHaveLength(IMAGE_EMBEDDING_DIMENSIONS);
    expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-6);
  });

  it('puts a text query in the same space: "red" is nearer the red square than the blue one', async () => {
    const [vr, vb, q] = await Promise.all([
      embedder.embedImage(red),
      embedder.embedImage(blue),
      embedder.embedText('a plain solid red square'),
    ]);
    expect(cosine(q, vr)).toBeGreaterThan(cosine(q, vb));
  });

  it('documents the raw request shapes and their widths', async () => {
    const report: Record<string, string> = {};
    const probe = async (label: string, body: unknown): Promise<number> => {
      try {
        const { json } = await postOpenRouterEmbeddings(fetch, key, body, TIMEOUT_MS);
        const width = embeddingOf(json).length;
        report[label] = `ok, ${width} values`;
        return width;
      } catch (err) {
        report[label] = `refused: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
        return -1;
      }
    };
    const withDims = imageRequestBody(red);
    const { dimensions: _imageDims, ...imageDefault } = withDims;
    const imageSent = await probe('image item + dimensions 1536 (what we send)', withDims);
    const imageWide = await probe('image item, no dimensions', imageDefault);
    const textSent = await probe('text item as content array (what we send)', textRequestBody('red top in a car'));
    await probe('text as a plain string input', {
      model: IMAGE_EMBEDDING_MODEL,
      input: ['red top in a car'],
      encoding_format: 'float',
      dimensions: IMAGE_EMBEDDING_DIMENSIONS,
    });
    console.log(
      `[live] ${IMAGE_EMBEDDING_MODEL} request shapes:\n` +
        Object.entries(report)
          .map(([label, outcome]) => `  ${label}: ${outcome}`)
          .join('\n'),
    );
    expect(imageSent, JSON.stringify(report)).toBeGreaterThanOrEqual(IMAGE_EMBEDDING_DIMENSIONS);
    expect(imageWide, JSON.stringify(report)).toBeGreaterThanOrEqual(IMAGE_EMBEDDING_DIMENSIONS);
    expect(textSent, JSON.stringify(report)).toBeGreaterThanOrEqual(IMAGE_EMBEDDING_DIMENSIONS);
  });

  it('a provider-shortened vector agrees with a client-shortened one (Matryoshka prefix)', async () => {
    const body = textRequestBody('red top in a car');
    const { dimensions: _textDims, ...full } = body;
    const [short, wide] = await Promise.all([
      postOpenRouterEmbeddings(fetch, key, body, TIMEOUT_MS),
      postOpenRouterEmbeddings(fetch, key, full, TIMEOUT_MS),
    ]);
    const a = fitVector(embeddingOf(short.json));
    const b = fitVector(embeddingOf(wide.json));
    expect(cosine(a, b)).toBeGreaterThan(0.99);
  });
});
