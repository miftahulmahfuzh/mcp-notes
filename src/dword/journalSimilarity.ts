import { createHash } from 'node:crypto';

/**
 * Ported, not imported (D1), from ~/daily-words/src/lib/journal/similarity.ts. Keep this file
 * byte-for-byte in sync with that source's GLYPH_FOLDS / EDGE_NOISE regexes and the
 * NFKD-strip-marks-collapse-whitespace-trim-lowercase pipeline: the sha256 hex this produces
 * must equal what dword's own app would compute and already stores in `norm_sha`, or Layer 1
 * (the free, no-network duplicate check) silently stops working for any entry dword itself wrote.
 */
const GLYPH_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′´`]/gu, "'"],
  [/[“”„‟″«»]/gu, '"'],
  [/[‐‑‒–—―−]/gu, '-'],
  [/…/gu, '...'],
];

const EDGE_NOISE_LEADING = /^[\p{P}\p{S}\s]+/u;
const EDGE_NOISE_TRAILING = /[\p{P}\p{S}\s]+$/u;

/** Layer 1's fold: two copies of the same line normalize to the same string. */
export function normalizeForCompare(raw: string): string {
  let out = raw;
  for (const [pattern, replacement] of GLYPH_FOLDS) out = out.replace(pattern, replacement);

  return out
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(EDGE_NOISE_LEADING, '')
    .replace(EDGE_NOISE_TRAILING, '')
    .toLowerCase();
}

/** Lowercase hex, matching Postgres `encode(sha256(...), 'hex')`. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Layer 1's stored key: journal_entry_embeddings.norm_sha. */
export function normShaFor(text: string): string {
  return sha256Hex(normalizeForCompare(text));
}

/** journal_entry_embeddings.text_sha: sha256 of the exact (unnormalized) text. */
export function textShaFor(text: string): string {
  return sha256Hex(text);
}

/**
 * dword `src/lib/journal/similarity.ts:176` (`NEAR_DUPLICATE_MAX_DISTANCE`). Cosine distance below
 * which two journal lines are treated as the same saying — a dedup-algorithm threshold, not a
 * form-validation ceiling, which is why it lives alongside this file's other similarity.ts port
 * rather than in src/dword/rules.ts (see DWORD_CONNECTOR_PLAN.md's Reconciliation Log). Measured,
 * not guessed — dword's own comment on this constant documents the corpus run that produced it;
 * re-run that measurement before ever changing this number, never edit the digit directly.
 */
export const NEAR_DUPLICATE_MAX_DISTANCE = 0.25;
