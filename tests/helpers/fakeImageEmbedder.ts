import sharp from 'sharp';
import { EmbeddingError, type EmbedOptions } from '../../src/embeddings/embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from '../../src/embeddings/imageConstants.js';
import type { ImageEmbedder } from '../../src/embeddings/imageEmbedder.js';
import { isPng } from '../../src/embeddings/openrouterImage.js';

export type Rgb = { r: number; g: number; b: number };

/** Colour words embedText maps onto the colour axes; any other text is hashed. */
export const COLOUR_WORDS: Readonly<Record<string, Rgb>> = {
  red: { r: 220, g: 20, b: 20 },
  green: { r: 20, g: 200, b: 20 },
  blue: { r: 20, g: 20, b: 220 },
  yellow: { r: 230, g: 220, b: 20 },
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
};

/** Keeps black off the zero vector and lets brightness matter a little. */
const BIAS = 0.05;
const COLOUR_AXES = 4;

function normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Unit vector on the colour axes: (r, g, b)/255 plus BIAS, everything else 0. */
export function vectorForColour(rgb: Rgb, dimensions: number = IMAGE_EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dimensions).fill(0);
  v[0] = rgb.r / 255;
  v[1] = rgb.g / 255;
  v[2] = rgb.b / 255;
  v[3] = BIAS;
  return normalise(v);
}

/** Unit vector on 8 hash-chosen non-colour axes: deterministic, near-orthogonal to every colour. */
export function vectorForHash(key: string, dimensions: number = IMAGE_EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dimensions).fill(0);
  let h = fnv1a(key);
  for (let k = 0; k < 8; k += 1) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    const axis = COLOUR_AXES + (h % (dimensions - COLOUR_AXES));
    v[axis] = (v[axis] ?? 0) + 1;
  }
  return normalise(v);
}

export interface FakeImageCall {
  kind: 'image' | 'text';
  /** PNG size for an image call. */
  bytes?: number;
  /** Trimmed query for a text call. */
  text?: string;
}

function scriptedFailure(): EmbeddingError {
  return new EmbeddingError('fake image embedder: scripted failure');
}

/**
 * Deterministic offline ImageEmbedder for unit and integration tests. Same validation as the
 * real client (non-PNG bytes or empty text throw before anything is recorded), same model id and
 * width by default, so stored rows count as current.
 */
export class FakeImageEmbedder implements ImageEmbedder {
  readonly model: string;
  readonly dimensions: number;
  /** Every call that would have reached the network, in order (failed ones included). */
  readonly calls: FakeImageCall[] = [];
  delayMs: number;
  /** While set, a recorded call rejects when it matches. */
  failWhen: ((call: FakeImageCall) => boolean) | null = null;
  private failuresLeft = 0;
  private failure: Error = scriptedFailure();

  constructor(opts: { model?: string; dimensions?: number; delayMs?: number } = {}) {
    this.model = opts.model ?? IMAGE_EMBEDDING_MODEL;
    this.dimensions = opts.dimensions ?? IMAGE_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(this.dimensions) || this.dimensions < COLOUR_AXES + 8) {
      throw new Error(`fake image embedder: ${this.dimensions} dimensions is too narrow (need >= ${COLOUR_AXES + 8})`);
    }
    this.delayMs = opts.delayMs ?? 0;
  }

  /** The next `n` recorded calls reject with `error` (default: an EmbeddingError). */
  failNext(n = 1, error?: Error): void {
    this.failuresLeft = n;
    this.failure = error ?? scriptedFailure();
  }

  /** Clears calls, scripted failures and the delay. */
  reset(): void {
    this.calls.length = 0;
    this.failuresLeft = 0;
    this.failWhen = null;
    this.delayMs = 0;
  }

  /** The vector embedImage would return. Records nothing; never fails on a decodable PNG. */
  async vectorForPng(png: Uint8Array): Promise<number[]> {
    const stats = await sharp(Buffer.from(png.buffer, png.byteOffset, png.byteLength)).stats();
    const [r, g, b] = stats.channels;
    const mean = (c: { mean: number } | undefined, fallback: number): number => c?.mean ?? fallback;
    const red = mean(r, 0);
    return vectorForColour({ r: red, g: mean(g, red), b: mean(b, red) }, this.dimensions);
  }

  /** The vector embedText would return: the first colour word's colour, else a hash of the text. */
  vectorForText(text: string): number[] {
    const words = text.toLowerCase().split(/[^a-z]+/);
    for (const word of words) {
      if (Object.hasOwn(COLOUR_WORDS, word)) return vectorForColour(COLOUR_WORDS[word]!, this.dimensions);
    }
    return vectorForHash(text.trim().toLowerCase(), this.dimensions);
  }

  private async record(call: FakeImageCall): Promise<void> {
    this.calls.push(call);
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw this.failure;
    }
    const pred = this.failWhen;
    if (pred !== null && pred(call)) throw scriptedFailure();
  }

  async embedImage(png: Uint8Array, _opts?: EmbedOptions): Promise<number[]> {
    if (!isPng(png)) throw new EmbeddingError('image embedding needs PNG bytes (re-encode with toEmbeddingPng first)');
    await this.record({ kind: 'image', bytes: png.byteLength });
    return this.vectorForPng(png);
  }

  async embedText(query: string, _opts?: EmbedOptions): Promise<number[]> {
    const text = query.trim();
    if (text === '') throw new EmbeddingError('image search query is empty');
    await this.record({ kind: 'text', text });
    return this.vectorForText(text);
  }
}
