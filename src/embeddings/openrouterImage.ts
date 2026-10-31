import type { EmbeddingsConfig } from '../config.js';
import { EmbeddingError, type EmbedOptions } from './embedder.js';
import { IMAGE_EMBEDDING_DIMENSIONS, IMAGE_EMBEDDING_MODEL } from './imageConstants.js';
import type { ImageEmbedder } from './imageEmbedder.js';
import { postOpenRouterEmbeddings, snippet } from './openrouter.js';
import { embedInput } from './state.js';

/** Per request: an image input is larger than a note, so the ceiling is twice the text one. */
export const OPENROUTER_IMAGE_EMBED_TIMEOUT_MS = 30_000;

/**
 * Most PNG bytes one request carries. A 1024 px PNG of a photo is ~1-2 MB; base64 adds a third.
 * Refused before any request, so a pathological PNG never reaches the provider.
 */
export const MAX_EMBED_PNG_BYTES = 8 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** True when `bytes` start with the PNG signature and carry more than it. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.byteLength <= PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export type EmbeddingContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** The JSON body POSTed to /api/v1/embeddings for one image or one query. */
export interface ImageEmbeddingRequestBody {
  model: string;
  input: Array<{ content: EmbeddingContentPart[] }>;
  encoding_format: 'float';
  dimensions: number;
}

export interface OpenRouterImageEmbedderOptions {
  /** OPENROUTER_API_KEY. Never logged, never put in an error. Blank throws EmbeddingError. */
  apiKey: string;
  /** Injected by unit tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Default per-request timeout; `embedImage/embedText(.., { timeoutMs })` overrides it. */
  timeoutMs?: number;
}

export function pngDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64')}`;
}

/** An image-only input item: a content array holding just the image_url part. */
export function imageRequestBody(png: Uint8Array): ImageEmbeddingRequestBody {
  return {
    model: IMAGE_EMBEDDING_MODEL,
    input: [{ content: [{ type: 'image_url', image_url: { url: pngDataUrl(png) } }] }],
    encoding_format: 'float',
    dimensions: IMAGE_EMBEDDING_DIMENSIONS,
  };
}

/**
 * A text-only input item: a content array holding just the text part (the multimodal item shape,
 * which the live probe confirms; it also reports whether a plain string input works).
 */
export function textRequestBody(text: string): ImageEmbeddingRequestBody {
  return {
    model: IMAGE_EMBEDDING_MODEL,
    input: [{ content: [{ type: 'text', text }] }],
    encoding_format: 'float',
    dimensions: IMAGE_EMBEDDING_DIMENSIONS,
  };
}

/**
 * The vector we store: the first `width` values (a Matryoshka prefix) of `values`, divided by
 * their L2 norm. Always normalised, so a provider-shortened vector and a client-shortened one
 * compare the same way. Throws EmbeddingError for a narrower vector, a non-finite value or a
 * zero-length prefix; the result's width is asserted.
 */
export function fitVector(values: readonly number[], width: number = IMAGE_EMBEDDING_DIMENSIONS): number[] {
  if (values.length < width) {
    throw new EmbeddingError(
      `image embedding returned ${values.length} value(s) for model ${IMAGE_EMBEDDING_MODEL}; ` +
        `note_image_embeddings.embedding is vector(${width}). The model id and ` +
        'IMAGE_EMBEDDING_DIMENSIONS must change together, in one migration, with a full re-embed ' +
        '(npm run embed:images:backfill).',
    );
  }
  const head = values.slice(0, width);
  let sumSq = 0;
  for (const x of head) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new EmbeddingError(`image embedding returned a non-finite value for model ${IMAGE_EMBEDDING_MODEL}`);
    }
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    throw new EmbeddingError(`image embedding from ${IMAGE_EMBEDDING_MODEL} has zero length; there is nothing to compare`);
  }
  const out = head.map((x) => x / norm);
  if (out.length !== width) {
    throw new EmbeddingError(`image embedding has ${out.length} dimensions after fitting, expected ${width}`);
  }
  return out;
}

/** `data` must hold exactly one vector (index 0 or absent). */
function parseOne(json: unknown, raw: string): number[] {
  const data =
    typeof json === 'object' && json !== null ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    throw new EmbeddingError(`image embedding response carried no data array: ${snippet(raw)}`);
  }
  if (data.length !== 1) {
    throw new EmbeddingError(`image embedding response has ${data.length} vector(s) for 1 input: ${snippet(raw)}`);
  }
  const first: unknown = data[0];
  const entry =
    typeof first === 'object' && first !== null ? (first as { index?: unknown; embedding?: unknown }) : {};
  if (entry.index !== undefined && entry.index !== 0) {
    throw new EmbeddingError(
      `image embedding response has a bad index ${String(entry.index)} at data[0]: ${snippet(raw)}`,
    );
  }
  const embedding = entry.embedding;
  if (!Array.isArray(embedding)) {
    throw new EmbeddingError(`image embedding response carried no vector at data[0].embedding: ${snippet(raw)}`);
  }
  if (!embedding.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))) {
    throw new EmbeddingError(`image embedding returned a non-finite value for model ${IMAGE_EMBEDDING_MODEL}`);
  }
  return fitVector(embedding as number[], IMAGE_EMBEDDING_DIMENSIONS);
}

/**
 * Gemini Embedding 2 through OpenRouter: one `fetch` per image or query, no SDK. Construction
 * never touches the network; a blank key throws here.
 */
export function createOpenRouterImageEmbedder(opts: OpenRouterImageEmbedderOptions): ImageEmbedder {
  const apiKey = opts.apiKey.trim();
  if (apiKey === '') {
    throw new EmbeddingError('image embeddings are not configured (OPENROUTER_API_KEY is empty)');
  }
  const fetchImpl: typeof fetch = opts.fetch ?? fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? OPENROUTER_IMAGE_EMBED_TIMEOUT_MS;

  async function send(body: ImageEmbeddingRequestBody, timeoutMs: number): Promise<number[]> {
    const { json, raw } = await postOpenRouterEmbeddings(fetchImpl, apiKey, body, timeoutMs);
    return parseOne(json, raw);
  }

  return {
    model: IMAGE_EMBEDDING_MODEL,
    dimensions: IMAGE_EMBEDDING_DIMENSIONS,
    async embedImage(png: Uint8Array, callOpts: EmbedOptions = {}): Promise<number[]> {
      if (!isPng(png)) {
        throw new EmbeddingError('image embedding needs PNG bytes (re-encode with toEmbeddingPng first)');
      }
      if (png.byteLength > MAX_EMBED_PNG_BYTES) {
        throw new EmbeddingError(
          `image embedding input is ${png.byteLength} bytes, over the ${MAX_EMBED_PNG_BYTES}-byte cap`,
        );
      }
      return send(imageRequestBody(png), callOpts.timeoutMs ?? defaultTimeoutMs);
    },
    async embedText(query: string, callOpts: EmbedOptions = {}): Promise<number[]> {
      const text = embedInput(query);
      if (text === null) throw new EmbeddingError('image search query is empty');
      return send(textRequestBody(text), callOpts.timeoutMs ?? defaultTimeoutMs);
    },
  };
}

/** The daemon's and the CLI's way to get one: null without a key (image search off). */
export function imageEmbedderFromConfig(
  config: EmbeddingsConfig,
  opts: { fetch?: typeof fetch } = {},
): ImageEmbedder | null {
  if (config.apiKey === null) return null;
  return createOpenRouterImageEmbedder({ apiKey: config.apiKey, fetch: opts.fetch });
}
