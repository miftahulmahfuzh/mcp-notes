/**
 * Embedding constants shared by the schema check, the embedder (phase 2), the worker (phase 3),
 * hybrid search (phase 4) and `related` (phase 5). Mirrors ~/run-insights/lib/nina/embedding.ts
 * (read for reference, never imported).
 *
 * EMBEDDING_DIMENSIONS must equal the `vector(1536)` width in src/db/schema.ts
 * (`noteEmbeddings.embedding`); tests/unit/embeddings.state.test.ts asserts it. Changing the
 * model or the width means a new migration plus a full re-embed (`npm run embed:backfill`).
 */
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
/** run-insights' clamp: input is trimmed then truncated to this many UTF-16 units, no marker. */
export const EMBEDDING_MAX_CHARS = 8_000;
export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
