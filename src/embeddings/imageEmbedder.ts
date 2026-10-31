import type { EmbedOptions } from './embedder.js';

/**
 * The seam between mcp-notes and an image embedding provider. Separate from `Embedder`
 * (./embedder.ts): another model, another vector space, another table. Production uses
 * `createOpenRouterImageEmbedder` (./openrouterImage.ts); tests use
 * tests/helpers/fakeImageEmbedder.ts. A null `ImageEmbedder` everywhere means "image search
 * off" (no OPENROUTER_API_KEY): writes are unaffected, the image worker does not start,
 * `similar_images` says so.
 *
 * Every failure is an `EmbeddingError` (./embedder.ts) that never carries the API key.
 */
export interface ImageEmbedder {
  /** Model id the vectors come from; stored in note_image_embeddings.model. */
  readonly model: string;
  /** Width of every returned vector; equals the vector(n) column. */
  readonly dimensions: number;
  /**
   * One unit-length vector for one PNG (make it with ./imageInput.ts). Throws EmbeddingError,
   * without a request, when the bytes are not a PNG or are over MAX_EMBED_PNG_BYTES.
   */
  embedImage(png: Uint8Array, opts?: EmbedOptions): Promise<number[]>;
  /**
   * One unit-length vector for a text query, in the same space as embedImage ("red top in a
   * car"). Trimmed and clamped like note text (embedInput); empty throws EmbeddingError without
   * a request.
   */
  embedText(query: string, opts?: EmbedOptions): Promise<number[]>;
}
