/**
 * The one seam between mcp-notes and an embedding provider. Production uses
 * `createOpenRouterEmbedder` (./openrouter.ts); tests use `tests/helpers/fakeEmbedder.ts`.
 * A null `Embedder` everywhere means "semantic features off" (no OPENROUTER_API_KEY): writes are
 * unaffected, search reports its text fallback, the worker idles.
 */

export interface EmbedOptions {
  /** Per-request ceiling in ms, overriding the embedder's default (15 s for OpenRouter). */
  timeoutMs?: number;
}

export interface Embedder {
  /** Model id the vectors come from; stored in note_embeddings.model. */
  readonly model: string;
  /** Width of every returned vector; equals the vector(n) column. */
  readonly dimensions: number;
  /**
   * One vector per input, in input order. Each input is trimmed and clamped to
   * EMBEDDING_MAX_CHARS (phase 1's embedInput). Throws EmbeddingError, and makes no request at all, when `inputs` is
   * empty or any input is empty after trim (callers filter with phase 1's `embedInput`).
   */
  embed(inputs: readonly string[], opts?: EmbedOptions): Promise<number[][]>;
}

/**
 * Every embedding failure: missing key, empty input, transport error, timeout, non-2xx,
 * non-JSON, missing/miscounted/misindexed vectors, wrong width, non-finite element. One class,
 * as in run-insights: no caller branches on which; the worker records and retries, search falls
 * back to text. The response snippet or the thrown cause rides in `message` / `detail`.
 * Never carries the API key.
 */
export class EmbeddingError extends Error {
  override name = 'EmbeddingError';

  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

function detailText(detail: unknown): string {
  if (detail instanceof Error) {
    const inner = detail.cause instanceof Error ? ` (${detail.cause.message})` : '';
    return `${detail.name}: ${detail.message}${inner}`;
  }
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/**
 * One line for a log or note_embeddings.last_error. `String(err)` alone drops `detail`, which is
 * where the transport cause lives (e.g. "fetch failed (connect ECONNREFUSED ...)").
 */
export function embeddingErrorText(cause: unknown): string {
  if (cause instanceof EmbeddingError) {
    return cause.detail === undefined
      ? `${cause.name}: ${cause.message}`
      : `${cause.name}: ${cause.message} - detail: ${detailText(cause.detail)}`;
  }
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}
