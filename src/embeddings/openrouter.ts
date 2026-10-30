import type { EmbeddingsConfig } from '../config.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, OPENROUTER_EMBEDDINGS_URL } from './constants.js';
import { EmbeddingError, type EmbedOptions, type Embedder } from './embedder.js';
import { embedInput } from './state.js';

/**
 * Per request. An embedding is one forward pass with no decode; run-insights measured it well
 * under a second and settled on 15 s as a ceiling with room. Search passes a shorter one per call.
 */
export const OPENROUTER_EMBED_TIMEOUT_MS = 15_000;

/**
 * Inputs per request. 64 notes at the 8 000-char clamp is ~128k tokens, inside the provider's
 * per-request limit; larger `embed()` calls are split into sequential requests.
 */
export const OPENROUTER_EMBED_MAX_BATCH = 64;

/** How much of a bad response body an error message carries (run-insights' 300). */
export const RESPONSE_SNIPPET_CHARS = 300;

export interface OpenRouterEmbedderOptions {
  /** OPENROUTER_API_KEY. Never logged, never put in an error. Blank throws EmbeddingError. */
  apiKey: string;
  /** Injected by unit tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Default per-request timeout; `embed(.., { timeoutMs })` overrides it per call. */
  timeoutMs?: number;
  /** Inputs per request; default OPENROUTER_EMBED_MAX_BATCH. Integer >= 1. */
  maxBatch?: number;
}

function snippet(raw: string): string {
  return raw.slice(0, RESPONSE_SNIPPET_CHARS);
}

/**
 * Trim + clamp each input with phase 1's embedInput (truncate at EMBEDDING_MAX_CHARS, no marker:
 * the marker would be embedded too; never ends on half a surrogate pair). Input the worker already
 * passed through embedInput comes out unchanged.
 */
function prepareInputs(inputs: readonly string[]): string[] {
  if (inputs.length === 0) throw new EmbeddingError('embedding needs at least one input');
  return inputs.map((text, i) => {
    const input = embedInput(text);
    if (input === null) throw new EmbeddingError(`embedding input ${i} is empty`);
    return input;
  });
}

function errorName(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined;
}

/**
 * `data` must hold exactly one vector per input. Each item's `index` (or its position when the
 * provider omits it) places it; a repeated or out-of-range index is an error, never a silent
 * reorder. Width and finiteness are checked here, against the same constant as the column, so a
 * model swap fails with both numbers named instead of as an opaque pgvector INSERT error.
 */
function parseVectors(json: unknown, expected: number, raw: string): number[][] {
  const data =
    typeof json === 'object' && json !== null ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) {
    throw new EmbeddingError(`embedding response carried no data array: ${snippet(raw)}`);
  }
  if (data.length !== expected) {
    throw new EmbeddingError(
      `embedding response has ${data.length} vector(s) for ${expected} input(s): ${snippet(raw)}`,
    );
  }
  const out: Array<number[] | undefined> = new Array<number[] | undefined>(expected).fill(undefined);
  data.forEach((item: unknown, position: number) => {
    const entry =
      typeof item === 'object' && item !== null
        ? (item as { index?: unknown; embedding?: unknown })
        : {};
    const index = entry.index === undefined ? position : entry.index;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected ||
      out[index] !== undefined
    ) {
      throw new EmbeddingError(
        `embedding response has a bad or repeated index ${String(index)} at data[${position}]: ${snippet(raw)}`,
      );
    }
    const embedding = entry.embedding;
    if (!Array.isArray(embedding)) {
      throw new EmbeddingError(
        `embedding response carried no vector at data[${position}].embedding: ${snippet(raw)}`,
      );
    }
    if (
      embedding.length !== EMBEDDING_DIMENSIONS ||
      !embedding.every((n: unknown) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new EmbeddingError(
        `embedding returned ${embedding.length} value(s) (or a non-finite one) for model ${EMBEDDING_MODEL}; ` +
          `note_embeddings.embedding is vector(${EMBEDDING_DIMENSIONS}). The model id and ` +
          'EMBEDDING_DIMENSIONS must change together, in one migration, with a full re-embed.',
      );
    }
    out[index] = embedding as number[];
  });
  return out as number[][];
}

/**
 * OpenRouter's OpenAI-shaped /embeddings endpoint, one `fetch` per batch, no SDK.
 * Construction never touches the network; a blank key throws here so a misconfigured daemon
 * fails loudly at startup instead of on the first note.
 */
export function createOpenRouterEmbedder(opts: OpenRouterEmbedderOptions): Embedder {
  const apiKey = opts.apiKey.trim();
  if (apiKey === '') {
    throw new EmbeddingError('embeddings are not configured (OPENROUTER_API_KEY is empty)');
  }
  const fetchImpl: typeof fetch = opts.fetch ?? fetch;
  const defaultTimeoutMs = opts.timeoutMs ?? OPENROUTER_EMBED_TIMEOUT_MS;
  const maxBatch = opts.maxBatch ?? OPENROUTER_EMBED_MAX_BATCH;
  if (!Number.isInteger(maxBatch) || maxBatch < 1) {
    throw new RangeError(`maxBatch must be an integer >= 1, got ${maxBatch}`);
  }

  async function request(batch: string[], timeoutMs: number): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetchImpl(OPENROUTER_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        // encoding_format explicit: some providers behind the broker default to base64, which
        // would arrive as a string and fail the array check with a confusing message.
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch, encoding_format: 'float' }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const name = errorName(cause);
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new EmbeddingError(
        timedOut ? `embedding request timed out after ${timeoutMs} ms` : 'embedding request failed',
        cause,
      );
    }

    // Text first, then parse: a broker's error body is often HTML or a bare string, and the raw
    // snippet is the most useful thing an error can carry.
    let raw: string;
    try {
      raw = await res.text();
    } catch (cause) {
      const timedOut = errorName(cause) === 'TimeoutError' || errorName(cause) === 'AbortError';
      throw new EmbeddingError(
        timedOut
          ? `embedding response timed out after ${timeoutMs} ms`
          : 'embedding response body could not be read',
        cause,
      );
    }

    if (!res.ok) {
      throw new EmbeddingError(`embedding endpoint returned ${res.status}: ${snippet(raw)}`, {
        status: res.status,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (cause) {
      throw new EmbeddingError(`embedding response was not valid JSON: ${snippet(raw)}`, cause);
    }
    return parseVectors(json, batch.length, raw);
  }

  return {
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(inputs: readonly string[], callOpts: EmbedOptions = {}): Promise<number[][]> {
      const prepared = prepareInputs(inputs);
      const timeoutMs = callOpts.timeoutMs ?? defaultTimeoutMs;
      const out: number[][] = [];
      for (let start = 0; start < prepared.length; start += maxBatch) {
        const vectors = await request(prepared.slice(start, start + maxBatch), timeoutMs);
        out.push(...vectors);
      }
      return out;
    },
  };
}

/**
 * The daemon's and the CLI's (phase 3) way to get an embedder: null without a key, which turns
 * semantic features off without affecting writes.
 */
export function embedderFromConfig(
  config: EmbeddingsConfig,
  opts: { fetch?: typeof fetch } = {},
): Embedder | null {
  if (config.apiKey === null) return null;
  return createOpenRouterEmbedder({ apiKey: config.apiKey, fetch: opts.fetch });
}
