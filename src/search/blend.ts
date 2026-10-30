import { normalizeId } from '../notes/ids.js';
import { parseTags } from '../notes/tags.js';

/** Every weight and threshold of hybrid search. See BLEND for what each one is for. */
export interface BlendTuning {
  textFloor: number;
  text: number;
  vector: number;
  minSimilarity: number;
  tag: number;
  hashtagHit: number;
  wordTagHit: number;
  recency: number;
  recencyHalfLifeDays: number;
  exactId: number;
  textCandidates: number;
  vectorCandidates: number;
}

/**
 * Hybrid search weights: the one place they live.
 *
 * score = exactId?                    (exactId)
 *       + full-text match?            (textFloor + text * rank / best rank among candidates)
 *       + vector * clamp((similarity - minSimilarity) / (1 - minSimilarity))
 *       + tag * tagMatch              (0..1)
 *       + recency * 0.5^(age / half-life)
 *
 * Two invariants are asserted in tests/unit/search.blend.test.ts and must survive any retune:
 *   textFloor + text > vector + tag + recency          the best literal hit beats every meaning-only note
 *   exactId > textFloor + text + vector + tag + recency a named id beats everything
 *
 * Tuned on tests/fixtures/semantic/labelled.ts with the concept-bag fake embedder; phase 6's
 * live test re-checks them against openai/text-embedding-3-small and may change the numbers
 * (never the names).
 */
export const BLEND: BlendTuning = {
  // Any full-text match starts here. Together with `text` it outweighs everything a
  // meaning-only note can collect, so an exact word, code token or version string the user
  // typed is never pushed down by notes that are merely about the same topic.
  textFloor: 0.6,
  // On top of the floor, scaled by ts_rank / best ts_rank among the candidates: orders the
  // literal hits among themselves the same way text mode does.
  text: 0.4,
  // Closeness in meaning, the main signal for notes that share no word with the query. Equal
  // to the floor, so a very close meaning match can pass a weak literal hit but never the best one.
  vector: 0.6,
  // Cosine floor for meaning-only notes. text-embedding-3-small scores unrelated short notes
  // around 0.1-0.25 and paraphrases above ~0.35; below this a meaning-only candidate is noise
  // and is dropped instead of padding every result with the K nearest notes.
  minSimilarity: 0.3,
  // The note carries a tag the query names. Smaller than `vector`: a tag is shared by many
  // notes, so it says "same area", not "same thing".
  tag: 0.25,
  // An explicit #hashtag in the query is a clear request for that tag: one hit fills tagMatch.
  hashtagHit: 1,
  // A bare query word that happens to be a tag ("seer") is weaker evidence: two such hits fill it.
  wordTagHit: 0.5,
  // Newer notes win near-ties. Small on purpose: an old note that answers the question beats
  // a new near-miss ("have we seen this before?" is usually about old notes).
  recency: 0.1,
  // A note this many days old gets half the recency bonus; about one project cycle here.
  recencyHalfLifeDays: 90,
  // The note whose id appears in the query goes first, above any sum of the other signals.
  exactId: 2,
  // Full-text matches considered per query, best ts_rank first (text mode's order). Bounds the
  // work per search; text mode stays the exhaustive option.
  textCandidates: 500,
  // Nearest notes by meaning considered per query. A personal store rarely holds more than a
  // few dozen notes on one topic, and most of these fall under minSimilarity anyway.
  vectorCandidates: 100,
};

const DAY_MS = 86_400_000;

/** What hybrid search reads out of the query text (besides its vector). */
export interface QueryTerms {
  /** #hashtags in the query, lower-cased, first-appearance order. */
  hashtags: string[];
  /** Other bare words, lower-cased, deduped, at least 2 chars; no exclusions, hashtags or ids. */
  words: string[];
  /** Canonical note ids named in the query ("A-B32", "a-b32"; a lone "ab32" when it has a digit). */
  ids: string[];
  /** Words after a leading "-" (websearch exclusions), lower-cased. */
  excluded: string[];
}

const ID_TOKEN = /(?<![0-9A-Za-z_-])([0-9A-Za-z]-[0-9A-Za-z]{3})(?![0-9A-Za-z_-])/g;
const BARE_ID = /^[0-9A-Za-z]{4}$/;
const EXCLUDED = /(?:^|\s)-([0-9A-Za-z_][0-9A-Za-z_-]*)/g;
const WORD = /(?<![#0-9A-Za-z_-])([0-9A-Za-z_][0-9A-Za-z_-]*)/g;

export function queryTerms(query: string): QueryTerms {
  const hashtags = parseTags(query);

  const excluded: string[] = [];
  for (const m of query.matchAll(EXCLUDED)) {
    const w = (m[1] ?? '').toLowerCase();
    if (w !== '' && !excluded.includes(w)) excluded.push(w);
  }

  const ids: string[] = [];
  for (const m of query.matchAll(ID_TOKEN)) {
    const id = normalizeId(m[1] ?? '');
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  // "ab32" alone is an id; "pool" alone is a word. Requiring a digit keeps ordinary
  // four-letter words out (an all-letter id must be written with its dash).
  const trimmed = query.trim();
  if (ids.length === 0 && BARE_ID.test(trimmed) && /\d/.test(trimmed)) {
    const id = normalizeId(trimmed);
    if (id !== null) ids.push(id);
  }

  const words: string[] = [];
  for (const m of query.matchAll(WORD)) {
    const w = (m[1] ?? '').toLowerCase();
    if (w.length < 2 || w === 'or') continue;
    if (excluded.includes(w) || hashtags.includes(w) || words.includes(w)) continue;
    const asId = normalizeId(w);
    if (asId !== null && ids.includes(asId)) continue;
    words.push(w);
  }
  return { hashtags, words, ids, excluded };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/** 0..1: how strongly the note's tags match what the query names. */
export function tagMatch(tags: readonly string[], terms: QueryTerms, tuning: BlendTuning = BLEND): number {
  let s = 0;
  for (const tag of tags) {
    if (terms.hashtags.includes(tag)) s += tuning.hashtagHit;
    else if (terms.words.includes(tag)) s += tuning.wordTagHit;
  }
  return clamp01(s);
}

/** 1 for a note updated at `now`, 0.5 at one half-life, towards 0 for old notes. Future dates count as now. */
export function recencyScore(updatedAt: Date, now: Date, tuning: BlendTuning = BLEND): number {
  const ageDays = Math.max(0, now.getTime() - updatedAt.getTime()) / DAY_MS;
  return clamp01(0.5 ** (ageDays / tuning.recencyHalfLifeDays));
}

/** Cosine similarity rescaled so minSimilarity -> 0 and 1 -> 1. Null (no current vector) -> 0. */
export function similarityScore(similarity: number | null, tuning: BlendTuning = BLEND): number {
  if (similarity === null) return 0;
  return clamp01((similarity - tuning.minSimilarity) / (1 - tuning.minSimilarity));
}

/** One candidate's signals, every one already on its 0..1 scale (except similarity, raw cosine). */
export interface BlendInput {
  exactId: boolean;
  /** ts_rank / best ts_rank among the candidates; null when the note did not match the full-text query. */
  textRank: number | null;
  /** Raw cosine similarity of the current vector; null when the note has none. */
  similarity: number | null;
  tagMatch: number;
  recency: number;
}

export function blendScore(x: BlendInput, tuning: BlendTuning = BLEND): number {
  return (
    (x.exactId ? tuning.exactId : 0) +
    (x.textRank === null ? 0 : tuning.textFloor + tuning.text * clamp01(x.textRank)) +
    tuning.vector * similarityScore(x.similarity, tuning) +
    tuning.tag * clamp01(x.tagMatch) +
    tuning.recency * clamp01(x.recency)
  );
}

/** A meaning-only candidate must clear minSimilarity; a literal or id match always stays. */
export function isEligible(x: BlendInput, tuning: BlendTuning = BLEND): boolean {
  if (x.exactId || x.textRank !== null) return true;
  return x.similarity !== null && Number.isFinite(x.similarity) && x.similarity >= tuning.minSimilarity;
}

/** A candidate as the repo (or phase 6's live test) hands it over. */
export interface BlendCandidate {
  id: string;
  /** Raw ts_rank (any non-negative scale; normalized by the best candidate); null = no full-text match. */
  textRank: number | null;
  /** Cosine similarity of the note's current vector to the query vector; null = no current vector. */
  similarity: number | null;
  /** 0..1, from tagMatch(). */
  tagMatch: number;
  updatedAt: Date;
  /** The query names this note's id. */
  exactId?: boolean;
}

export type Ranked<T> = T & { score: number };

/**
 * Scores and orders candidates, best first: score desc, then updated_at desc, then id desc
 * (text mode's tie-break). Ineligible candidates are removed.
 */
export function rankCandidates<T extends BlendCandidate>(
  candidates: readonly T[],
  opts: { now: Date; tuning?: BlendTuning },
): Ranked<T>[] {
  const tuning = opts.tuning ?? BLEND;
  let best = 0;
  for (const c of candidates) {
    if (c.textRank !== null && Number.isFinite(c.textRank) && c.textRank > best) best = c.textRank;
  }
  const out: Ranked<T>[] = [];
  for (const c of candidates) {
    const input: BlendInput = {
      exactId: c.exactId === true,
      textRank: c.textRank === null ? null : best > 0 ? c.textRank / best : 1,
      similarity: c.similarity,
      tagMatch: c.tagMatch,
      recency: recencyScore(c.updatedAt, opts.now, tuning),
    };
    if (!isEligible(input, tuning)) continue;
    out.push({ ...c, score: blendScore(input, tuning) });
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  return out;
}
