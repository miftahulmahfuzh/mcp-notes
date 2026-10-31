/**
 * Image embedding constants (image similarity search). Separate from ./constants.ts: another
 * model, another vector space, another table (`note_image_embeddings`). Text-embedding vectors
 * (`openai/text-embedding-3-small`) and these are never compared with each other.
 *
 * Verified 2026-10-31 (OpenRouter model page and embeddings guide): `google/gemini-embedding-2`
 * on POST https://openrouter.ai/api/v1/embeddings takes input items
 * `{content: [{type: 'text', text} | {type: 'image_url', image_url: {url: 'data:image/png;base64,...'}}]}`,
 * returns 3072 floats by default, honours `dimensions` for text (Matryoshka), caps one input at
 * 8192 tokens, and costs $0.20 per million text tokens and $0.45 per million image tokens. PNG is
 * the verified image type. Its vectors are incompatible with every other model.
 *
 * pgvector's HNSW index takes at most 2000 dimensions on `vector`, so requests ask for 1536 and
 * the client keeps the first 1536 values (L2-renormalised) of any wider answer: a Matryoshka
 * prefix is a valid smaller embedding. IMAGE_EMBEDDING_DIMENSIONS must equal the `vector(1536)`
 * width of `note_image_embeddings.embedding`; tests/unit/embeddings/imageConstants.test.ts
 * asserts it. Changing the model or the width means a new migration plus
 * `npm run embed:images:backfill`.
 */
export const IMAGE_EMBEDDING_MODEL = 'google/gemini-embedding-2';
export const IMAGE_EMBEDDING_DIMENSIONS = 1536;

/** Long edge, in px, of the PNG sent for one image (bounds token cost; never enlarged). */
export const IMAGE_EMBED_LONG_EDGE = 1024;

export const IMAGE_PRICE_USD_PER_M_TOKENS = 0.45;
export const TEXT_PRICE_USD_PER_M_TOKENS = 0.2;

/**
 * Gemini's published image token rule, used only for the dry-run estimate: an image whose both
 * edges are <= 384 px costs 258 tokens; a larger one is cut into 768x768 tiles of 258 tokens each.
 * The provider's real count is on its invoice; this is an estimate and is labelled as one.
 */
export const IMAGE_TOKENS_PER_TILE = 258;
export const IMAGE_SMALL_EDGE = 384;
export const IMAGE_TILE_EDGE = 768;

/** Estimated tokens for one image of `width` x `height` after the IMAGE_EMBED_LONG_EDGE downscale. */
export function estimateImageTokens(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const scale = Math.min(1, IMAGE_EMBED_LONG_EDGE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  if (sw <= IMAGE_SMALL_EDGE && sh <= IMAGE_SMALL_EDGE) return IMAGE_TOKENS_PER_TILE;
  return IMAGE_TOKENS_PER_TILE * Math.ceil(sw / IMAGE_TILE_EDGE) * Math.ceil(sh / IMAGE_TILE_EDGE);
}

/** USD for `tokens` image tokens at IMAGE_PRICE_USD_PER_M_TOKENS. */
export function estimateImageCostUsd(tokens: number): number {
  return (Math.max(0, tokens) / 1_000_000) * IMAGE_PRICE_USD_PER_M_TOKENS;
}
