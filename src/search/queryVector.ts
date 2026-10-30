import { EMBEDDING_DIMENSIONS } from '../embeddings/constants.js';
import type { Embedder } from '../embeddings/embedder.js';
import { embedInput } from '../embeddings/state.js';

/** A search waits at most this long for the query vector, then answers with full text. */
export const QUERY_EMBED_TIMEOUT_MS = 5_000;
/** Query vectors kept per daemon; enough for paging and for a session's repeated questions. */
export const QUERY_CACHE_SIZE = 64;

/** Least-recently-used map from (model, query text) to its vector. */
export class QueryVectorCache {
  private readonly entries = new Map<string, number[]>();
  private readonly capacity: number;

  constructor(capacity: number = QUERY_CACHE_SIZE) {
    this.capacity = Math.max(1, Math.trunc(capacity));
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): number[] | undefined {
    const v = this.entries.get(key);
    if (v === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, v);
    return v;
  }

  set(key: string, vector: number[]): void {
    this.entries.delete(key);
    this.entries.set(key, vector);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The query's vector, from the cache or one embedder call bounded by `timeoutMs`. Throws on
 * failure, timeout or a vector that does not fit vector(EMBEDDING_DIMENSIONS); the caller
 * falls back to full text. Only successes are cached.
 */
export async function embedQuery(
  embedder: Embedder,
  cache: QueryVectorCache,
  query: string,
  timeoutMs: number = QUERY_EMBED_TIMEOUT_MS,
): Promise<number[]> {
  const input = embedInput(query);
  if (input === null) throw new Error('the query is empty');
  const key = `${embedder.model}\n${input}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const vectors = await withTimeout(embedder.embed([input], { timeoutMs }), timeoutMs);
  const vector = vectors[0];
  if (vector === undefined) throw new Error('the embedder returned no vector');
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`the embedder returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  }
  cache.set(key, vector);
  return vector;
}

/** `fallback` when the daemon has no embedder (no OPENROUTER_API_KEY). */
export const SEMANTIC_OFF_FALLBACK =
  'Meaning search is off on this server (OPENROUTER_API_KEY is not set), so these are full-text results only: notes that share words with the query.';

/** `fallback` when the query embedding failed or timed out. Never includes the key (embedder errors do not carry it). */
export function embedFailedFallback(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `The query could not be embedded (${reason}), so these are full-text results only: notes that share words with the query.`;
}
