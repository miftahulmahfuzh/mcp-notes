import { createHash } from 'node:crypto';

import { EMBEDDING_MAX_CHARS } from './constants.js';

/**
 * Pure rules for "does this note's embedding match its body?". No I/O.
 *
 * A note's embedding is tied to the body it was made from by `body_sha256`. The SQL side
 * (src/embeddings/repo.ts `currentBodySha256Sql`) computes the same hex digest with
 * `encode(sha256(convert_to(body, 'UTF8')), 'hex')`; the integration tests assert the two agree.
 */

/** Hex sha256 of the UTF-8 encoding of `body`. Equal to `currentBodySha256Sql()` for the same body. */
export function bodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * What gets sent to the embedder: the body trimmed (JS `String.prototype.trim`) and cut to
 * EMBEDDING_MAX_CHARS without a marker. Null when nothing is left: such a note (e.g. a photo
 * with no text) has no embedding. A cut that would split a surrogate pair drops the lone half.
 */
export function embedInput(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;
  if (trimmed.length <= EMBEDDING_MAX_CHARS) return trimmed;
  let cut = trimmed.slice(0, EMBEDDING_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * - `none`: the body is empty after trim; no embedding is needed.
 * - `missing`: no stored row.
 * - `stale`: a row exists but for another body hash or another model (re-embed, no backoff).
 * - `failed`: the row is for this body and model but holds no vector (last attempt failed).
 * - `current`: the row holds a vector for this body and model.
 */
export type EmbeddingState = 'current' | 'stale' | 'missing' | 'failed' | 'none';

/** The parts of a `note_embeddings` row the state depends on. */
export interface StoredEmbedding {
  bodySha256: string;
  model: string;
  hasVector: boolean;
  attempts: number;
}

export function embeddingState(body: string, stored: StoredEmbedding | null, model: string): EmbeddingState {
  if (embedInput(body) === null) return 'none';
  if (stored === null) return 'missing';
  if (stored.bodySha256 !== bodySha256(body) || stored.model !== model) return 'stale';
  return stored.hasVector ? 'current' : 'failed';
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60_000;

/**
 * Wait before the next attempt after `attempts` consecutive failures for the same body:
 * 30 s, 1 min, 2 min, ... doubling, capped at 1 h. `attempts` below 1 is treated as 1.
 */
export function retryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.trunc(Number.isFinite(attempts) ? attempts : 1));
  // 2^7 * 30 s already exceeds the cap; stop the exponent there so huge counts cannot overflow.
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(n - 1, 7));
}

const MAX_ERROR_CHARS = 500;

/**
 * An error message fit for `note_embeddings.last_error`: OpenRouter keys (`sk-or-...`) and
 * `Bearer ...` tokens replaced with `[redacted]`, whitespace collapsed, at most 500 chars.
 */
export function clampError(message: string): string {
  const cleaned = message
    .replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= MAX_ERROR_CHARS ? cleaned : cleaned.slice(0, MAX_ERROR_CHARS);
}
