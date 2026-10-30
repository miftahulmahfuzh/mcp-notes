# Phase 4: Hybrid search + labelled set

**Plan set:** `docs/plans/SEMANTIC_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261030-140513-S6EM_code_analyzer.md`
**Satisfies:** R4. `search` ranks by a blend of full-text rank, vector similarity, tag match and recency. Filters apply before ranking. Ids and rare code tokens still come first. It falls back to text and says so. The weights sit in one commented place, tuned on a labelled set. It takes an optional `mode`. The description and server instructions are updated, and the caption is unchanged. This phase also writes its own R6 tests (blend unit tests and the hybrid-vs-text integration test).
**Depends on:** Phase 1 (schema `noteEmbeddings`, `isCurrentEmbeddingSql`, `toVectorLiteral`, `saveEmbedding`, `bodySha256`, `embedInput`, `EMBEDDING_DIMENSIONS`), Phase 2 (`Embedder`, `NotesService.embedder` private field, `createFakeEmbedder`/`FakeEmbedder` with `vectorFor`, `calls`, `delayMs`, `failNext`, `reset`, `type Lexicon`)
**Difficulty:** HARD
**Package:** `src/search`, `src/notes`, `src/mcp`

---

## Goal

After this phase, `search` runs in hybrid mode by default. It ranks a bounded candidate set in TypeScript, using one commented weights object (`BLEND` in `src/search/blend.ts`). The candidate set is the full-text matches, plus the nearest current vectors, plus any note whose id the query names, all under the same filters. When there is no embedder, or the query can't be embedded within about 5 s, `search` returns today's full-text ranking with `mode: 'text'` and a `fallback` sentence. `mode: 'text'` is exactly today's `repo.searchNotes`. A labelled set of notes and queries in `tests/fixtures/semantic/labelled.ts` shows that hybrid strictly beats text on MRR and on recall@3. Phase 6 reuses that set against the real model.

## Interface Contract

**Deletes:** none

**Renames:** none

**Creates:**
- `src/search/blend.ts` (new):
  - `interface BlendTuning`, `const BLEND: BlendTuning` (every weight and threshold, with a comment on each)
  - `interface QueryTerms { hashtags; words; ids; excluded }`, `queryTerms(query)`
  - `tagMatch(tags, terms, tuning?)`, `recencyScore(updatedAt, now, tuning?)`, `similarityScore(similarity, tuning?)`
  - `interface BlendInput`, `blendScore(input, tuning?)`, `isEligible(input, tuning?)`
  - `interface BlendCandidate { id; textRank; similarity; tagMatch; updatedAt; exactId? }`, `type Ranked<T>`
  - `rankCandidates<T extends BlendCandidate>(candidates, opts: { now: Date; tuning?: BlendTuning }): Ranked<T>[]`
- `src/search/queryVector.ts` (new):
  - `QUERY_EMBED_TIMEOUT_MS = 5_000`, `QUERY_CACHE_SIZE = 64`
  - `class QueryVectorCache` (LRU)
  - `embedQuery(embedder, cache, query, timeoutMs?)`
  - `SEMANTIC_OFF_FALLBACK`, `embedFailedFallback(err)`
- `src/notes/repo.ts`: `interface CandidateQuery`, `interface CandidateRow`, `searchCandidates(db: Db, q, filter)`
- `src/notes/types.ts`: `type SearchMode = 'hybrid' | 'text'`, `interface SearchPage extends NotePage { mode; fallback? }`
- `src/notes/service.ts`:
  - `interface SearchOptions { mode?; queryTimeoutMs? }`
  - private field `queryVectors: QueryVectorCache`
  - private method `textSearch(query, filter, fallback?)`
- MCP `search` tool: optional input `mode: 'hybrid' | 'text'`. The result gains `mode` and an optional `fallback`.
- `tests/fixtures/semantic/labelled.ts` (new):
  - `LabelledNote`, `LabelledQuery`, `LABELLED_NOTES`, `LABELLED_QUERIES`, `SEMANTIC_LEXICON`
  - `RankingRun`, `RankingScore`, `evaluateRanking(runs)`
- Tests:
  - `tests/unit/search.blend.test.ts` (new)
  - `tests/unit/search.queryVector.test.ts` (new)
  - `tests/integration/search.hybrid.int.test.ts` (new)
  - one new `it` in `tests/unit/mcp.instructions.test.ts`

**Signature changes:**
- `NotesService.search(query: string, filter?: NoteFilter): Promise<NotePage>` -> `NotesService.search(query: string, filter?: NoteFilter, opts?: SearchOptions): Promise<SearchPage>`. `SearchPage` is a superset of `NotePage`, so every existing caller and test still compiles.
- The `search` description string in `src/mcp/tools.ts`, and the `Reading.` paragraph in `src/mcp/instructions.ts`.

**Requires (from earlier phases):**
- Phase 1:
  - `noteEmbeddings` in `src/db/schema.ts` (columns `noteId`, `embedding`, `bodySha256`, `model`).
  - In `src/embeddings/repo.ts`:
    - `isCurrentEmbeddingSql(model): SQL`. It references the tables unaliased as `"notes"` and `"note_embeddings"`, and is parenthesised.
    - `toVectorLiteral(v): string`
    - `saveEmbedding(db, { noteId, bodySha256, model, embedding }): Promise<boolean>`
  - In `src/embeddings/state.ts`: `bodySha256(body)` and `embedInput(body)`.
  - In `src/embeddings/constants.ts`: `EMBEDDING_DIMENSIONS`.
  - `truncateAll` also empties `note_embeddings`, or the FK cascade does it.
  - The test container runs `pgvector/pgvector:pg16` with pgvector ≥ 0.8 (needed for `hnsw.iterative_scan`).
- Phase 2:
  - `Embedder` and `EmbedOptions` in `src/embeddings/embedder.ts`.
  - `NotesServiceDeps.embedder?: Embedder | null`, stored as `private readonly embedder: Embedder | null`, which this phase reads as `this.embedder`.
  - In `tests/helpers/fakeEmbedder.ts`:
    - `createFakeEmbedder({ lexicon })`, returning a `FakeEmbedder`
    - the members `vectorFor(text)`, `calls: string[][]`, `delayMs` (mutable), `failNext(n?, error?)` and `reset()`
    - `type Lexicon = readonly (readonly string[])[]`, where `*` marks a prefix match
    - the tokenizer: lower-case, split on non-letter/digit, `DEFAULT_STOPWORDS` dropped
    - `model` defaults to `EMBEDDING_MODEL`

**Provides to later phases (names Phase 6 already uses; reconciler checked Phase 6's live-test adapter against the code blocks below, they match):**
- `BLEND` with numeric `minSimilarity`
- `BlendCandidate { id; textRank: number | null; similarity: number | null; tagMatch: number; updatedAt: Date; exactId?: boolean }`. `textRank` is raw, and `rankCandidates` normalizes it by the best candidate.
- `rankCandidates(candidates, { now })`, which returns the candidates with `score`, best first, with ineligible ones removed
- `LABELLED_NOTES: ReadonlyArray<{ key; body; ageDays? }>`
- `LABELLED_QUERIES: ReadonlyArray<{ query; relevant: readonly string[] (note keys); usage?: boolean; why: string }>`
- the bodies `arango root password is in the vault` and `the login broke after the laptop slept` are present verbatim

**Leaves alone (owned by others):**
- `src/embeddings/**` (Phases 1, 2, 3, 5), including `nearestNotes` (Phase 5)
- `src/embeddings/worker.ts`, `src/background.ts`, `src/cli/**` (Phase 3)
- the `related` tool, the `Related.` instructions paragraph and `NotesService.related` (Phase 5)
- `src/chat/**`. The `search` caption stays "searching notes".
- `web/**`
- `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, and `NotesServiceDeps`/the constructor (Phase 2)
- README, `docs/**`, `claude/skills/n/SKILL.md` (Phase 6)
- `tests/live/**` (Phase 6)

## Files

| File | Action | What changes |
|---|---|---|
| `src/search/blend.ts` | create | `BLEND` weights plus the pure scoring and ranking |
| `src/search/queryVector.ts` | create | LRU cache of query vectors, `embedQuery` with timeout and width check, fallback messages |
| `src/notes/types.ts:58-61` | modify (append after `NotePage`) | `SearchMode`, `SearchPage` |
| `src/notes/repo.ts:1-5, after 173` | modify | imports; `CandidateQuery`, `CandidateRow`, `searchCandidates` after `searchNotes` (`searchNotes` itself unchanged) |
| `src/notes/service.ts:1-18, fields, 165-169` | modify | imports, `SearchOptions`, `queryVectors` field, new `search`, private `textSearch` |
| `src/mcp/tools.ts:255-269` | modify | `search` registration: `mode` input, new description, passes `{ mode }` |
| `src/mcp/instructions.ts:22` | modify | `Reading.` paragraph |
| `tests/unit/mcp.instructions.test.ts:31` | modify (append inside `describe('buildInstructions')`) | Reading-paragraph test |
| `tests/fixtures/semantic/labelled.ts` | create | labelled notes and queries, lexicon, `evaluateRanking` |
| `tests/unit/search.blend.test.ts` | create | blend unit tests |
| `tests/unit/search.queryVector.test.ts` | create | cache, timeout and fallback-message unit tests |
| `tests/integration/search.hybrid.int.test.ts` | create | labelled metric, id and code token at rank 1, filters, fallbacks, paging/LRU, `mode: 'text'` parity, MCP surface |

Line numbers are for `main` at `66b8e98`. Phase 2 adds about 10 lines near the top of `service.ts` (an import, the `embedder` dep, the field and the constructor line), so `search()` will be around `:175` after Phase 2. Anchor on the method text, not the number.

## Implementation Steps

### Step 1: The blend: weights and pure ranking
**File:** `src/search/blend.ts` (new)
**Change:** The single home of every weight and threshold, and the pure functions that turn candidate signals into one ordered list. The class has no I/O. `now` is passed in.

Design:
- **Text floor.** A full-text match gets `textFloor + text × (rank / best rank)`. The invariant `textFloor + text > vector + tag + recency` means the best literal hit always beats every meaning-only candidate, so a rare code token is never drowned. Weaker literal hits can still be passed by strong meaning matches.
- **Exact id.** `exactId` is larger than the sum of every other weight, so a note whose id appears in the query is always first.
- **Similarity.** Similarity counts only above `minSimilarity`, rescaled to 0..1. Candidates that match only by meaning and fall below the floor are dropped, so hybrid does not return the K nearest notes for every query.

**Code:**
```ts
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
```
**Impact:** New module, imported only by `service.ts` (and later by Phase 6's live test).

### Step 2: Query vector: cache, timeout, fallback text
**File:** `src/search/queryVector.ts` (new)
**Change:** This step embeds a query within a deadline, checks the vector's width, and caches it in a small LRU. Paging with `next_cursor` re-runs `search` with the same query, and the cache keeps it from paying for a second embedding call. Failed calls are not cached. The step also holds the two user-facing fallback sentences.
**Code:**
```ts
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
```
**Impact:** New module. Nothing outside `service.ts` and its unit test imports it.

### Step 3: `SearchMode` and `SearchPage`
**File:** `src/notes/types.ts`, append directly after `NotePage` (`:58-61`)
**Code:**
```ts
/** 'hybrid': full text + meaning + tags + recency. 'text': full-text ranking only (pre-iteration-6). */
export type SearchMode = 'hybrid' | 'text';

/** `search` result: a NotePage plus which ranking produced it. */
export interface SearchPage extends NotePage {
  /** The ranking actually used. 'text' when asked for, or when hybrid had to fall back. */
  mode: SearchMode;
  /** Present only when hybrid was asked for but could not run; says why, in a sentence for the user. */
  fallback?: string;
}
```
**Impact:** Additive. `SearchPage` is assignable to `NotePage`.

### Step 4: Hybrid candidate query in the repo
**File:** `src/notes/repo.ts`

(a) Imports, replacing lines 1-5:
```ts
import { and, arrayContains, arrayOverlaps, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { noteEmbeddings, noteRevisions, notes } from '../db/schema.js';
import { isCurrentEmbeddingSql, toVectorLiteral } from '../embeddings/repo.js';
import { parseDateBound } from './dates.js';
import { NoteError, type ImageMeta, type NoteRow, type Origin } from './types.js';
```
`src/embeddings/repo.ts` imports only the *type* `Executor` from this file (Phase 1 refinement), so this import creates no runtime cycle.

(b) Insert after `searchNotes` (after `:173`), leaving `searchNotes` byte-for-byte unchanged:
```ts
/** Input of the hybrid candidate query. */
export interface CandidateQuery {
  /** The raw query, for websearch_to_tsquery (same as text mode). */
  query: string;
  /** The query's embedding (EMBEDDING_DIMENSIONS wide). */
  vector: readonly number[];
  /** Model whose vectors count as current (the embedder's). */
  model: string;
  /** Note ids named in the query: always candidates, if they pass the filter. */
  ids: readonly string[];
  /** websearch "-word" exclusions; also applied to the meaning-only side. */
  excluded: readonly string[];
  /** Max full-text matches, best ts_rank first. */
  textLimit: number;
  /** Max nearest notes by meaning. */
  vectorLimit: number;
}

export interface CandidateRow {
  row: NoteRow;
  /** Raw ts_rank; null when the note does not match the full-text query. */
  textRank: number | null;
  /** 1 - cosine distance of the note's current vector; null when it has none. */
  similarity: number | null;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Candidates for hybrid search: full-text matches ∪ nearest current vectors ∪ notes named by
 * id, every source under the same filterConditions, so filters apply before ranking. Each row
 * carries both signals (text rank and similarity) whichever source found it. Unordered;
 * src/search/blend.ts ranks. `notes` and `note_embeddings` are never aliased, because
 * isCurrentEmbeddingSql interpolates their columns by real name.
 */
export async function searchCandidates(db: Db, q: CandidateQuery, filter: NoteFilter): Promise<CandidateRow[]> {
  const filters = filterConditions(filter);
  // Same expressions as searchNotes / the GIN index.
  const tsv = sql`to_tsvector('simple', ${notes.body})`;
  const tsq = sql`websearch_to_tsquery('simple', ${q.query})`;
  const qvec = sql`${toVectorLiteral(q.vector)}::vector`;
  const distance = sql`(${noteEmbeddings.embedding} <=> ${qvec})`;
  const joinCurrent = sql`${noteEmbeddings.noteId} = ${notes.id} and ${isCurrentEmbeddingSql(q.model)}`;
  const fields = {
    note: notes,
    textRank: sql<number | null>`(case when ${tsv} @@ ${tsq} then ts_rank(${tsv}, ${tsq}) end)::float8`,
    similarity: sql<number | null>`(1 - ${distance})::float8`,
  };

  // 1. Full-text matches, in text mode's order, with their similarity when they have a current vector.
  const textRows = await db
    .select(fields)
    .from(notes)
    .leftJoin(noteEmbeddings, joinCurrent)
    .where(and(sql`${tsv} @@ ${tsq}`, ...filters))
    .orderBy(desc(sql`ts_rank(${tsv}, ${tsq})`), desc(notes.updatedAt), desc(notes.id))
    .limit(q.textLimit);

  // 2. Nearest current vectors. ORDER BY <distance> LIMIT is the shape the HNSW cosine index
  // serves; iterative_scan keeps walking the index when filters drop rows (pgvector >= 0.8,
  // same setting phase 5's nearestNotes uses), so selective filters still get up to K rows.
  const excludedConds: SQL[] =
    q.excluded.length > 0 ? [sql`not (${tsv} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`] : [];
  const vectorRows = await db.transaction(async (tx) => {
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
    return tx
      .select(fields)
      .from(notes)
      .innerJoin(noteEmbeddings, joinCurrent)
      .where(and(...filters, ...excludedConds))
      .orderBy(distance)
      .limit(q.vectorLimit);
  });

  // 3. Notes the query names by id.
  const idRows =
    q.ids.length > 0
      ? await db
          .select(fields)
          .from(notes)
          .leftJoin(noteEmbeddings, joinCurrent)
          .where(and(inArray(notes.id, [...q.ids]), ...filters))
      : [];

  const byId = new Map<string, CandidateRow>();
  for (const r of [...textRows, ...vectorRows, ...idRows]) {
    if (byId.has(r.note.id)) continue;
    byId.set(r.note.id, { row: r.note, textRank: toNumberOrNull(r.textRank), similarity: toNumberOrNull(r.similarity) });
  }
  return [...byId.values()];
}
```
**Impact:** Additive. `searchNotes`, `filterConditions` and the cursor helpers are unchanged. This phase uses `decodeCursor`, `encodeCursor` and `clampLimit`, which are already exported.

### Step 5: `NotesService.search` with mode, fallback and paging
**File:** `src/notes/service.ts`

(a) Imports. After Phase 2 the block is today's `:1-18` plus `import type { Embedder } from '../embeddings/embedder.js';` on line 2. Replace the whole block with this one (Phase 2's line kept, the two `../search/*` imports added after it, `type SearchMode` / `type SearchPage` added to the `./types.js` list; nothing else changes):
```ts
import type { Db } from '../db/client.js';
import type { Embedder } from '../embeddings/embedder.js';
import { BLEND, queryTerms, rankCandidates, tagMatch } from '../search/blend.js';
import {
  QUERY_EMBED_TIMEOUT_MS,
  QueryVectorCache,
  SEMANTIC_OFF_FALLBACK,
  embedFailedFallback,
  embedQuery,
} from '../search/queryVector.js';
import type { NoteEvents, NoteOp } from './events.js';
import { generateId, normalizeId } from './ids.js';
import * as repo from './repo.js';
import type { NoteFilter } from './repo.js';
import { parseTags } from './tags.js';
import {
  NoteError,
  cleanOrigin,
  rowToNote,
  type ImageMeta,
  type Note,
  type NotePage,
  type NoteRow,
  type Origin,
  type Revision,
  type SearchMode,
  type SearchPage,
  type TagCount,
} from './types.js';
```
Phase 5 later adds three `../embeddings/*` imports and `type RelatedResult` to this block (its plan quotes the merged result).

(b) After `GetOptions` (`:50-52`), add:
```ts
export interface SearchOptions {
  /** 'hybrid' (default): full text + meaning + tags + recency. 'text': today's full-text ranking only. */
  mode?: SearchMode | undefined;
  /** Ceiling for the query embedding call. Default QUERY_EMBED_TIMEOUT_MS; tests shorten it. */
  queryTimeoutMs?: number | undefined;
}
```

(c) Class fields. Directly after Phase 2's `private readonly embedder: Embedder | null;`, add:
```ts
  /** Query vectors, so paging through one search embeds its query once. */
  private readonly queryVectors = new QueryVectorCache();
```

(d) Replace `search` (today `:165-169`) with the two methods below:
```ts
  /**
   * Hybrid by default: full-text rank, closeness in meaning, tag match and recency, blended by
   * src/search/blend.ts over candidates that already passed the filter. Falls back to the
   * full-text ranking, with `fallback` saying why, when there is no embedder or the query
   * cannot be embedded in time. mode 'text' is exactly the pre-iteration-6 ranking. The cursor
   * is an offset into whichever ranking produced the page.
   */
  async search(query: string, filter: NoteFilter = {}, opts: SearchOptions = {}): Promise<SearchPage> {
    if (query.trim() === '') throw new NoteError('invalid_input', 'search needs a non-empty query.');
    if (opts.mode === 'text') return this.textSearch(query, filter);
    // Reject a bad cursor before spending an embedding call on it.
    const offset = repo.decodeCursor(filter.cursor);
    const limit = repo.clampLimit(filter.limit);
    const embedder = this.embedder;
    if (embedder === null) return this.textSearch(query, filter, SEMANTIC_OFF_FALLBACK);

    let vector: number[];
    try {
      vector = await embedQuery(embedder, this.queryVectors, query, opts.queryTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS);
    } catch (err) {
      return this.textSearch(query, filter, embedFailedFallback(err));
    }

    const terms = queryTerms(query);
    const rows = await repo.searchCandidates(
      this.db,
      {
        query,
        vector,
        model: embedder.model,
        ids: terms.ids,
        excluded: terms.excluded,
        textLimit: BLEND.textCandidates,
        vectorLimit: BLEND.vectorCandidates,
      },
      filter,
    );
    const ranked = rankCandidates(
      rows.map((r) => ({
        id: r.row.id,
        textRank: r.textRank,
        similarity: r.similarity,
        tagMatch: tagMatch(r.row.tags, terms),
        updatedAt: r.row.updatedAt,
        exactId: terms.ids.includes(r.row.id),
        row: r.row,
      })),
      { now: new Date() },
    );
    const end = offset + limit;
    return {
      notes: ranked.slice(offset, end).map((c) => this.toNote(c.row)),
      next_cursor: ranked.length > end ? repo.encodeCursor(end) : null,
      mode: 'hybrid',
    };
  }

  /** Today's full-text ranking (repo.searchNotes, unchanged), optionally marked as a fallback. */
  private async textSearch(query: string, filter: NoteFilter, fallback?: string): Promise<SearchPage> {
    const page = await repo.searchNotes(this.db, query, filter);
    const result: SearchPage = { notes: page.rows.map((r) => this.toNote(r)), next_cursor: page.nextCursor, mode: 'text' };
    if (fallback !== undefined) result.fallback = fallback;
    return result;
  }
```
**Impact:**
- Existing service tests construct `NotesService` without an embedder. Their default-mode searches now return text results with `mode: 'text'` and a `fallback`. Their `.notes` assertions are unchanged.
- The ranked list is capped by `textCandidates + vectorCandidates + ids`, so hybrid paging stops there. Text mode stays exhaustive.
- Invalid `from`/`to` still throw `NoteError('invalid_input')` from `filterConditions` in both paths.

### Step 6: MCP `search` tool
**File:** `src/mcp/tools.ts`, replace the `search` registration (`:255-269`)
**Code:**
```ts
  server.registerTool(
    'search',
    {
      title: 'Search notes',
      description:
        'Search notes by meaning as well as by words, with the same tag and date filters as list. By default (mode "hybrid") it understands what the query means, not only its words: "ArangoDB credentials" finds a note saying "arango root password is in the vault", so pass the question in plain words. Results blend word matches, closeness in meaning, matching tags and recency; a note id, code identifier or version string that appears word for word still ranks first. mode "text" is exact-word full-text search only: no stemming; supports "quoted phrases", OR, and -word to exclude; ranked by relevance, then recency. Returns { notes, next_cursor, mode, fallback? }: mode is the ranking actually used; fallback is present when meaning search was unavailable and the results are word matches only - tell the user.' +
        IMAGE_FILTER_HINT,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'What to look for: a plain question ("have we seen auth failures after resume?") or exact terms ("retry backoff", "\\"connection pool\\" -redis").',
          ),
        mode: z
          .enum(['hybrid', 'text'])
          .optional()
          .describe('"hybrid" (default): meaning + words + tags + recency. "text": exact-word full-text search only.'),
        ...noteFilterShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, mode, ...filter }) => run(() => service.search(query, toFilter(filter), { mode })),
  );
```
**Impact:**
- The tool name, `query` and every filter input stay as they were. `mode` is new and optional.
- `images.mcp.int.test.ts:72` (filter fields present) still passes.
- `mcp.tools.int.test.ts:133` reads only `.notes` and still passes.
- `src/chat/status.ts` is untouched. The caption stays "searching notes".

### Step 7: Server instructions, `Reading.` paragraph
**File:** `src/mcp/instructions.ts:22`, replace the whole `Reading.` element
**Code:**
```ts
    `Reading. get takes one or several ids. list returns notes newest first, filtered by tags (tags_any: at least one; tags_all: every one) and a date range (from/to, on the created or updated date), with paging via limit and next_cursor. search understands meaning, not only words: by default (mode "hybrid") it blends word matches, closeness in meaning, matching tags and recency, so "ArangoDB credentials" finds a note that says "arango root password is in the vault" and "have we seen auth failures after resume?" finds "the login broke after the laptop slept". Pass the user's question in plain words; a note id or code token that appears word for word still ranks first. For exact-word search pass mode "text": the "simple" configuration, exact words and code tokens, no stemming, "quoted phrases", OR and -exclusions, ranked by relevance, then recency. Every search result says which mode it used; when it carries a fallback, meaning search was unavailable and only word matches came back, so tell the user. tags lists every tag with its note count and the time it was last used.`,
```
**Impact:** The paragraph count is unchanged. Phase 5 adds its own `Related.` element before `Dates.` and does not edit this string.

### Step 8: Instructions unit test
**File:** `tests/unit/mcp.instructions.test.ts`, inside `describe('buildInstructions', ...)`, after the connectors test (after `:31`)
**Code:**
```ts
  it('says search understands meaning, offers mode "text" and explains the fallback', () => {
    const paragraphs = buildInstructions('Asia/Jakarta')
      .split('\n\n')
      .filter((p) => p.startsWith('Reading.'));
    expect(paragraphs).toHaveLength(1);
    const p = paragraphs[0]!;
    expect(p).toContain('search understands meaning, not only words');
    expect(p).toContain('mode "hybrid"');
    expect(p).toContain('mode "text"');
    expect(p).toContain('fallback');
    expect(p).toContain('ArangoDB credentials');
    expect(p).toMatch(/no stemming/);
  });
```

### Step 9: Labelled set, lexicon and metric
**File:** `tests/fixtures/semantic/labelled.ts` (new)
**Change:** 16 notes and 10 queries, with a lexicon for Phase 2's concept-bag fake. The three usage examples are marked `usage: true`: the ArangoDB example, auth after resume, and the accidents/solution question. The chat-bar acceptance question ("sleep and tiredness") is included too. Three queries also match word for word (`pgx pool`, `#running`, `backup`). They check that hybrid does not lose literal hits. Every other query shares no full word sequence with its note, so text mode scores 0 on it. `evaluateRanking` computes MRR and recall@3 over keys or ids. Phase 6's live test imports `LABELLED_NOTES`/`LABELLED_QUERIES`.

If the fake's arithmetic turns out different from the margins worked out below, tune **this file** (lexicon entries, distractor wording), not the assertions or `BLEND`.
**Code:**
```ts
import type { Lexicon } from '../../helpers/fakeEmbedder.js';

/**
 * A small labelled set for tuning and checking hybrid search (src/search/blend.ts).
 *
 * Integration tests (tests/integration/search.hybrid.int.test.ts) embed it with the
 * concept-bag fake embedder and SEMANTIC_LEXICON; phase 6's live test embeds the same notes
 * and queries with openai/text-embedding-3-small. Keys are stable names; tests map them to
 * the generated note ids. ageDays backdates created_at/updated_at so recency is realistic.
 */
export interface LabelledNote {
  key: string;
  body: string;
  ageDays?: number;
}

export interface LabelledQuery {
  query: string;
  /** Keys of the notes that answer the query. */
  relevant: readonly string[];
  /** One of the brief's usage examples: its best relevant note must rank first in hybrid. */
  usage?: boolean;
  why: string;
}

export const LABELLED_NOTES: ReadonlyArray<LabelledNote> = [
  { key: 'arango-vault', body: 'arango root password is in the vault #infra', ageDays: 420 },
  { key: 'arango-backup', body: 'ArangoDB nightly backup goes out at 02:00 via arangodump to the NAS #infra', ageDays: 15 },
  { key: 'vault-unseal', body: 'vault unseal keys are split between the two yubikeys #infra', ageDays: 60 },
  { key: 'k8s-secret', body: 'rotate the postgres password secret in k8s after offboarding #infra', ageDays: 5 },
  { key: 'ssh-key', body: 'ssh key for the build box lives in ~/.ssh/id_ed25519, passphrase in bitwarden #infra', ageDays: 120 },
  { key: 'login-sleep', body: 'the login broke after the laptop slept; logging out and back in fixed it', ageDays: 200 },
  { key: 'wifi-resume', body: 'wifi drops after resume from suspend on the GPD, fixed by reloading the driver #gpd', ageDays: 3 },
  { key: 'resume-docker', body: 'docker loses its network after the laptop wakes up; fixed with wsl --shutdown #wsl', ageDays: 40 },
  {
    key: 'seer-incident',
    body: 'postmortem: seer order router double-submitted orders after the broker timeout; fix was an idempotency key #seer',
    ageDays: 300,
  },
  {
    key: 'neon-outage',
    body: 'Neon outage took notesd down for an hour; workaround: retry with backoff and keep the pooled url #notes',
    ageDays: 30,
  },
  { key: 'pgx-pool', body: 'pgx connection pool tuning for seer: MaxConns 20 and a 5s acquire timeout #seer', ageDays: 10 },
  { key: 'db-pool', body: 'notesd connection pool: neon pooled url with max 10 clients #notes', ageDays: 2 },
  {
    key: 'sleep-tired',
    body: 'sleep has been bad all week, exhausted on every run; coach says drop the intervals #running',
    ageDays: 7,
  },
  { key: 'run-pr', body: 'new 10k PR 52:10, negative split #running', ageDays: 1 },
  { key: 'groceries', body: 'buy oat milk, eggs and coffee beans', ageDays: 0 },
  { key: 'react-memo', body: 'useMemo did nothing because the deps array changed every render #web', ageDays: 20 },
];

export const LABELLED_QUERIES: ReadonlyArray<LabelledQuery> = [
  {
    query: 'ArangoDB credentials',
    relevant: ['arango-vault'],
    usage: true,
    why: 'brief usage example: no word in common with "arango root password is in the vault"',
  },
  {
    query: 'have we seen auth failures after resume before?',
    relevant: ['login-sleep'],
    usage: true,
    why: 'brief usage example: login/auth, broke/failures, slept/resume',
  },
  {
    query: 'have we met this kind of accidents before? maybe we already have a solution for this',
    relevant: ['seer-incident', 'neon-outage'],
    usage: true,
    why: 'brief usage example: incident notes that record a fix or workaround',
  },
  {
    query: 'anything in my notes about sleep and tiredness?',
    relevant: ['sleep-tired'],
    why: 'chat-bar acceptance question',
  },
  { query: 'where is the ssh passphrase', relevant: ['ssh-key'], why: 'meaning query; "where" defeats the full-text AND' },
  { query: 'pgx pool', relevant: ['pgx-pool'], why: 'literal query: hybrid must keep the word match first' },
  {
    query: 'connection problems after waking the laptop',
    relevant: ['wifi-resume', 'resume-docker'],
    why: 'two paraphrased answers, neither sharing the query wording',
  },
  { query: 'database password rotation', relevant: ['k8s-secret'], why: 'postgres/database, rotate/rotation' },
  { query: '#running', relevant: ['run-pr', 'sleep-tired'], why: 'tag query: both modes find it' },
  { query: 'backup', relevant: ['arango-backup'], why: 'single literal word' },
];

/**
 * Concept groups for tests/helpers/fakeEmbedder.ts: each group is one axis; `*` is a prefix.
 * A stand-in for the real model's sense of "same meaning", only as rich as this set needs.
 * Exact entries beat prefixes (arangodump is backup, not arango).
 */
export const SEMANTIC_LEXICON: Lexicon = [
  ['arango*'],
  ['credential*', 'password*', 'passphrase*', 'secret*', 'vault*', 'bitwarden', 'keys'],
  ['auth*', 'login*', 'logging', 'logon', 'signin'],
  ['fail*', 'broke', 'broken', 'drops', 'dies', 'error*', 'problem*', 'timeout*', 'loses'],
  ['resume*', 'suspend*', 'slept', 'wake*', 'waking', 'woke', 'hibernat*'],
  ['accident*', 'incident*', 'postmortem*', 'outage*'],
  ['solution*', 'fix', 'fixed', 'fixes', 'workaround*', 'resolved'],
  ['sleep', 'sleeping', 'tired*', 'exhaust*', 'fatigue*', 'insomnia'],
  ['run', 'runs', 'running', 'interval*', '10k', 'pace'],
  ['network*', 'connection*', 'wifi', 'internet', 'reconnect*'],
  ['database*', 'postgres*', 'neon', 'pgx', 'pool', 'pooled', 'db'],
  ['rotate', 'rotation', 'rotating', 'offboarding'],
  ['backup*', 'arangodump', 'dump'],
  ['laptop*', 'gpd', 'lenovo'],
  ['ssh', 'sshd', 'ed25519'],
];

export interface RankingRun {
  /** Result ids (or keys), best first. */
  ranked: readonly string[];
  /** Ids (or keys) that answer the query. */
  relevant: readonly string[];
}

export interface RankingScore {
  /** Mean reciprocal rank of the first relevant result (0 when none is returned). */
  mrr: number;
  /** Mean share of the relevant notes found in the top 3. */
  recallAt3: number;
}

export function evaluateRanking(runs: readonly RankingRun[]): RankingScore {
  if (runs.length === 0) return { mrr: 0, recallAt3: 0 };
  let rr = 0;
  let recall = 0;
  for (const run of runs) {
    const first = run.ranked.findIndex((id) => run.relevant.includes(id));
    rr += first === -1 ? 0 : 1 / (first + 1);
    const top3 = run.ranked.slice(0, 3);
    recall += run.relevant.length === 0 ? 0 : run.relevant.filter((id) => top3.includes(id)).length / run.relevant.length;
  }
  return { mrr: rr / runs.length, recallAt3: recall / runs.length };
}
```
Margins worked out by hand from Phase 2's fake (tail weight 0.25, stopwords dropped). Hybrid cosine of the relevant note compared with the best distractor:
- "ArangoDB credentials": 0.94 vs 0.71 (vault-unseal)
- auth/resume: 0.79 vs 0.51 (wifi-resume)
- accidents: 0.67/0.68 vs about 0.3
- ssh: 0.95 vs 0.66
- waking laptop: 0.90/0.86 vs 0.53

Text mode returns a relevant note only for `pgx pool`, `#running` and `backup`, which gives MRR 0.3 and recall@3 0.3.

### Step 10: Blend unit tests
**File:** `tests/unit/search.blend.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import {
  BLEND,
  blendScore,
  isEligible,
  queryTerms,
  rankCandidates,
  recencyScore,
  similarityScore,
  tagMatch,
  type BlendCandidate,
} from '../../src/search/blend.js';

const NOW = new Date('2026-10-30T00:00:00Z');
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

function cand(id: string, over: Partial<BlendCandidate> = {}): BlendCandidate {
  return { id, textRank: null, similarity: null, tagMatch: 0, updatedAt: NOW, ...over };
}

const order = (cs: readonly BlendCandidate[]): string[] => rankCandidates(cs, { now: NOW }).map((r) => r.id);

describe('BLEND', () => {
  it('lets the best full-text match beat any meaning-only match', () => {
    expect(BLEND.textFloor + BLEND.text).toBeGreaterThan(BLEND.vector + BLEND.tag + BLEND.recency);
  });

  it('puts an exact id above any sum of the other signals', () => {
    expect(BLEND.exactId).toBeGreaterThan(BLEND.textFloor + BLEND.text + BLEND.vector + BLEND.tag + BLEND.recency);
  });

  it('keeps thresholds and limits in range', () => {
    expect(BLEND.minSimilarity).toBeGreaterThan(0);
    expect(BLEND.minSimilarity).toBeLessThan(1);
    expect(BLEND.recencyHalfLifeDays).toBeGreaterThan(0);
    expect(Number.isInteger(BLEND.textCandidates) && BLEND.textCandidates > 0).toBe(true);
    expect(Number.isInteger(BLEND.vectorCandidates) && BLEND.vectorCandidates > 0).toBe(true);
    for (const w of [BLEND.textFloor, BLEND.text, BLEND.vector, BLEND.tag, BLEND.recency, BLEND.hashtagHit, BLEND.wordTagHit]) {
      expect(w).toBeGreaterThan(0);
    }
  });
});

describe('queryTerms', () => {
  it('splits hashtags, bare words, exclusions and ids', () => {
    expect(queryTerms('#Seer retry "connection pool" -redis A-B32')).toEqual({
      hashtags: ['seer'],
      words: ['retry', 'connection', 'pool'],
      ids: ['A-B32'],
      excluded: ['redis'],
    });
  });

  it('reads a lower-case dashed id and a lone four-character id with a digit', () => {
    expect(queryTerms('what did a-b32 say').ids).toEqual(['A-B32']);
    expect(queryTerms(' ab32 ').ids).toEqual(['A-B32']);
    expect(queryTerms('ab32').words).toEqual([]);
  });

  it('does not take ordinary words for ids', () => {
    expect(queryTerms('pool').ids).toEqual([]);
    expect(queryTerms('ab32 pool').ids).toEqual([]);
    expect(queryTerms('e-mail the team').ids).toEqual([]);
  });

  it('drops one-letter words and the OR operator', () => {
    expect(queryTerms('a pool OR redis').words).toEqual(['pool', 'redis']);
  });
});

describe('signals', () => {
  it('tagMatch: a #hashtag fills it, a bare word counts half, capped at 1', () => {
    const terms = queryTerms('#seer pool notes');
    expect(tagMatch(['seer'], terms)).toBe(1);
    expect(tagMatch(['pool'], terms)).toBe(BLEND.wordTagHit);
    expect(tagMatch(['pool', 'notes', 'seer'], terms)).toBe(1);
    expect(tagMatch(['other'], terms)).toBe(0);
  });

  it('recencyScore halves every half-life and treats future dates as now', () => {
    expect(recencyScore(NOW, NOW)).toBe(1);
    expect(recencyScore(daysAgo(BLEND.recencyHalfLifeDays), NOW)).toBeCloseTo(0.5, 10);
    expect(recencyScore(daysAgo(2 * BLEND.recencyHalfLifeDays), NOW)).toBeCloseTo(0.25, 10);
    expect(recencyScore(new Date(NOW.getTime() + 86_400_000), NOW)).toBe(1);
  });

  it('similarityScore rescales from minSimilarity and ignores null and NaN', () => {
    expect(similarityScore(null)).toBe(0);
    expect(similarityScore(Number.NaN)).toBe(0);
    expect(similarityScore(BLEND.minSimilarity)).toBe(0);
    expect(similarityScore(1)).toBe(1);
    expect(similarityScore(0.1)).toBe(0);
  });

  it('isEligible keeps literal and id matches, drops weak meaning-only ones', () => {
    const base = { exactId: false, textRank: null, similarity: null, tagMatch: 0, recency: 1 };
    expect(isEligible({ ...base, textRank: 0 })).toBe(true);
    expect(isEligible({ ...base, exactId: true })).toBe(true);
    expect(isEligible({ ...base, similarity: BLEND.minSimilarity })).toBe(true);
    expect(isEligible({ ...base, similarity: BLEND.minSimilarity - 0.01 })).toBe(false);
    expect(isEligible(base)).toBe(false);
  });

  it('blendScore adds the parts', () => {
    const s = blendScore({ exactId: false, textRank: 1, similarity: 1, tagMatch: 1, recency: 1 });
    expect(s).toBeCloseTo(BLEND.textFloor + BLEND.text + BLEND.vector + BLEND.tag + BLEND.recency, 10);
    expect(blendScore({ exactId: true, textRank: null, similarity: null, tagMatch: 0, recency: 0 })).toBe(BLEND.exactId);
  });
});

describe('rankCandidates', () => {
  it('keeps a lone, old, low-ranked full-text match above a perfect, fresh, tagged meaning match', () => {
    const rare = cand('rare', { textRank: 0.0001, updatedAt: daysAgo(900) });
    const rival = cand('rival', { similarity: 1, tagMatch: 1, updatedAt: NOW });
    expect(order([rival, rare])).toEqual(['rare', 'rival']);
  });

  it('puts the named id first, even above the best text and meaning match', () => {
    const named = cand('named', { exactId: true, updatedAt: daysAgo(2000) });
    const best = cand('best', { textRank: 0.5, similarity: 1, tagMatch: 1 });
    expect(order([best, named])).toEqual(['named', 'best']);
  });

  it('drops meaning-only candidates under minSimilarity and keeps the rest', () => {
    const near = cand('near', { similarity: 0.8 });
    const far = cand('far', { similarity: BLEND.minSimilarity / 2 });
    const none = cand('none');
    expect(order([far, near, none])).toEqual(['near']);
  });

  it('normalizes text rank by the best candidate', () => {
    const [a, b] = rankCandidates([cand('a', { textRank: 0.002 }), cand('b', { textRank: 0.001 })], { now: NOW });
    expect(a!.score).toBeCloseTo(BLEND.textFloor + BLEND.text + BLEND.recency, 10);
    expect(b!.score).toBeCloseTo(BLEND.textFloor + BLEND.text * 0.5 + BLEND.recency, 10);
  });

  it('lets meaning reorder literal hits of equal rank', () => {
    const plain = cand('plain', { textRank: 0.1, similarity: 0.2 });
    const close = cand('close', { textRank: 0.1, similarity: 0.9 });
    expect(order([plain, close])).toEqual(['close', 'plain']);
  });

  it('lets a strong meaning match pass a weak literal hit', () => {
    const top = cand('top', { textRank: 1 });
    const weak = cand('weak', { textRank: 0.01, updatedAt: daysAgo(720) });
    const meaning = cand('meaning', { similarity: 0.95, tagMatch: 1 });
    expect(order([weak, meaning, top])).toEqual(['top', 'meaning', 'weak']);
  });

  it('breaks score ties by updated_at desc, then id desc', () => {
    const older = cand('A-AAA', { textRank: 1, updatedAt: daysAgo(1) });
    const newer = cand('B-BBB', { textRank: 1, updatedAt: NOW });
    const sameTimeLowId = cand('C-CCC', { textRank: 1, updatedAt: NOW });
    expect(order([older, newer, sameTimeLowId])).toEqual(['C-CCC', 'B-BBB', 'A-AAA']);
  });

  it('returns the caller objects with a score attached', () => {
    const c = { ...cand('x', { textRank: 1 }), extra: 42 };
    const [r] = rankCandidates([c], { now: NOW });
    expect(r!.extra).toBe(42);
    expect(typeof r!.score).toBe('number');
  });
});
```
Check of the "strong meaning passes weak literal" case:
- `top` = 0.6 + 0.4 + 0.1 = 1.1
- `meaning` = 0.6 × (0.65/0.7) + 0.25 + 0.1 ≈ 0.907
- `weak` = 0.6 + 0.004 + 0.1 × 0.5^8 ≈ 0.604

### Step 11: Query-vector unit tests
**File:** `tests/unit/search.queryVector.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '../../src/embeddings/constants.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import {
  QueryVectorCache,
  SEMANTIC_OFF_FALLBACK,
  embedFailedFallback,
  embedQuery,
} from '../../src/search/queryVector.js';

interface Scripted {
  embedder: Embedder;
  calls: string[][];
}

function scripted(opts: { model?: string; fail?: Error; delayMs?: number; width?: number } = {}): Scripted {
  const calls: string[][] = [];
  const embedder: Embedder = {
    model: opts.model ?? 'test/model',
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(inputs: readonly string[]): Promise<number[][]> {
      calls.push([...inputs]);
      if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail !== undefined) throw opts.fail;
      return inputs.map(() => new Array<number>(opts.width ?? EMBEDDING_DIMENSIONS).fill(0.01));
    },
  };
  return { embedder, calls };
}

describe('QueryVectorCache', () => {
  it('evicts the least recently used entry', () => {
    const cache = new QueryVectorCache(2);
    cache.set('a', [1]);
    cache.set('b', [2]);
    expect(cache.get('a')).toEqual([1]); // a is now newest
    cache.set('c', [3]);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual([1]);
    expect(cache.get('c')).toEqual([3]);
    expect(cache.size).toBe(2);
  });
});

describe('embedQuery', () => {
  it('embeds the trimmed query once and serves repeats from the cache', async () => {
    const { embedder, calls } = scripted();
    const cache = new QueryVectorCache();
    const v1 = await embedQuery(embedder, cache, '  ArangoDB credentials ');
    const v2 = await embedQuery(embedder, cache, 'ArangoDB credentials');
    expect(v1).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(v2).toBe(v1);
    expect(calls).toEqual([['ArangoDB credentials']]);
  });

  it('keys the cache by model', async () => {
    const cache = new QueryVectorCache();
    const a = scripted({ model: 'm/a' });
    const b = scripted({ model: 'm/b' });
    await embedQuery(a.embedder, cache, 'q');
    await embedQuery(b.embedder, cache, 'q');
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('does not cache failures', async () => {
    const cache = new QueryVectorCache();
    const { embedder, calls } = scripted({ fail: new Error('boom') });
    await expect(embedQuery(embedder, cache, 'q')).rejects.toThrow('boom');
    await expect(embedQuery(embedder, cache, 'q')).rejects.toThrow('boom');
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(0);
  });

  it('times out a slow embedder', async () => {
    const { embedder } = scripted({ delayMs: 200 });
    await expect(embedQuery(embedder, new QueryVectorCache(), 'q', 20)).rejects.toThrow(/timed out after 20 ms/);
  });

  it('rejects a vector of the wrong width', async () => {
    const { embedder } = scripted({ width: 3 });
    await expect(embedQuery(embedder, new QueryVectorCache(), 'q')).rejects.toThrow(/3 dimensions/);
  });

  it('rejects an empty query without calling the embedder', async () => {
    const { embedder, calls } = scripted();
    await expect(embedQuery(embedder, new QueryVectorCache(), '   ')).rejects.toThrow(/empty/);
    expect(calls).toHaveLength(0);
  });
});

describe('fallback messages', () => {
  it('say the results are full-text only, and why', () => {
    expect(SEMANTIC_OFF_FALLBACK).toMatch(/OPENROUTER_API_KEY/);
    expect(SEMANTIC_OFF_FALLBACK).toMatch(/full-text results only/);
    const msg = embedFailedFallback(new Error('upstream 503'));
    expect(msg).toContain('upstream 503');
    expect(msg).toMatch(/full-text results only/);
  });

  it('clip a long reason', () => {
    const msg = embedFailedFallback(new Error('x'.repeat(1000)));
    expect(msg.length).toBeLessThan(400);
  });
});
```

### Step 12: Integration tests
**File:** `tests/integration/search.hybrid.int.test.ts` (new)
**Change:** Runs on the pgvector container with Phase 2's fake. Vectors are seeded with `vectorFor`, which records no calls, plus Phase 1's `saveEmbedding`. No worker runs. The MCP part uses an in-memory transport to `createMcpServer`, the same pattern as the connector tests, so the existing `mcp.tools.int.test.ts` harness is untouched.
**Code:**
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { saveEmbedding } from '../../src/embeddings/repo.js';
import { bodySha256, embedInput } from '../../src/embeddings/state.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { NoteEvents } from '../../src/notes/events.js';
import { searchNotes } from '../../src/notes/repo.js';
import { NotesService } from '../../src/notes/service.js';
import type { ImageMeta, Note, SearchPage } from '../../src/notes/types.js';
import {
  LABELLED_NOTES,
  LABELLED_QUERIES,
  SEMANTIC_LEXICON,
  evaluateRanking,
  type RankingRun,
} from '../fixtures/semantic/labelled.js';
import { createFakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-hybrid-'));
const events = new NoteEvents();
const embedder = createFakeEmbedder({ lexicon: SEMANTIC_LEXICON });
const service = new NotesService({ db, dataDir, events, embedder });
const DAY_MS = 86_400_000;

const ids = (page: { notes: Note[] }): string[] => page.notes.map((n) => n.id);

const meta = (sha256: string): ImageMeta => ({
  sha256,
  mime: 'image/png',
  width: 2,
  height: 1,
  bytes: 70,
  taken_at: null,
  original_name: 'shot.png',
  host: 'lenovo',
});

async function setDates(id: string, at: Date): Promise<void> {
  const iso = at.toISOString();
  await db.execute(sql`update notes set created_at = ${iso}::timestamptz, updated_at = ${iso}::timestamptz where id = ${id}`);
}

/** Stores a current vector for the note: its own body's, or `vector` when given. */
async function embedNote(note: Note, vector?: number[]): Promise<void> {
  const input = embedInput(note.body);
  if (input === null) throw new Error(`note ${note.id} has no text to embed`);
  const saved = await saveEmbedding(db, {
    noteId: note.id,
    bodySha256: bodySha256(note.body),
    model: embedder.model,
    embedding: vector ?? embedder.vectorFor(input),
  });
  expect(saved).toBe(true);
}

/** Creates and embeds the labelled notes; returns key -> id. */
async function seedLabelled(): Promise<Map<string, string>> {
  const now = Date.now();
  const byKey = new Map<string, string>();
  for (const n of LABELLED_NOTES) {
    const note = await service.create({ body: n.body });
    await embedNote(note);
    await setDates(note.id, new Date(now - (n.ageDays ?? 0) * DAY_MS));
    byKey.set(n.key, note.id);
  }
  return byKey;
}

function idOf(byKey: Map<string, string>, key: string): string {
  const id = byKey.get(key);
  if (id === undefined) throw new Error(`no labelled note ${key}`);
  return id;
}

beforeEach(async () => {
  await truncateAll(db);
  embedder.reset();
});

afterAll(async () => {
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('hybrid search on the labelled set', () => {
  it('beats text-only on MRR and recall@3', async () => {
    const byKey = await seedLabelled();
    const hybridRuns: RankingRun[] = [];
    const textRuns: RankingRun[] = [];
    for (const q of LABELLED_QUERIES) {
      const relevant = q.relevant.map((k) => idOf(byKey, k));
      const h = await service.search(q.query, { limit: 10 });
      expect(h.mode, q.query).toBe('hybrid');
      expect(h.fallback, q.query).toBeUndefined();
      hybridRuns.push({ ranked: ids(h), relevant });
      const t = await service.search(q.query, { limit: 10 }, { mode: 'text' });
      expect(t.mode).toBe('text');
      textRuns.push({ ranked: ids(t), relevant });
    }
    const hybrid = evaluateRanking(hybridRuns);
    const text = evaluateRanking(textRuns);
    expect(hybrid.mrr).toBeGreaterThan(text.mrr);
    expect(hybrid.recallAt3).toBeGreaterThan(text.recallAt3);
    expect(hybrid.mrr).toBeGreaterThanOrEqual(0.8);
    expect(hybrid.recallAt3).toBeGreaterThanOrEqual(0.8);
  });

  it('ranks a relevant note first for every usage example', async () => {
    const byKey = await seedLabelled();
    for (const q of LABELLED_QUERIES.filter((x) => x.usage === true)) {
      const page = await service.search(q.query);
      const relevant = q.relevant.map((k) => idOf(byKey, k));
      expect(relevant, q.query).toContain(page.notes[0]?.id);
    }
  });

  it('keeps literal queries first in hybrid', async () => {
    const byKey = await seedLabelled();
    expect((await service.search('pgx pool')).notes[0]?.id).toBe(idOf(byKey, 'pgx-pool'));
    expect((await service.search('backup')).notes[0]?.id).toBe(idOf(byKey, 'arango-backup'));
  });
});

describe('literal matches are never drowned', () => {
  it('puts an exact id first against a perfect meaning match, dashed or not', async () => {
    const target = await service.create({ id: 'Q-7K2', body: 'release checklist for the web app' });
    await embedNote(target);
    await setDates(target.id, new Date('2024-01-01T00:00:00Z'));
    for (const [i, query] of ['Q-7K2', 'q7k2', 'what did q-7k2 say'].entries()) {
      // The rival's body does not contain the id; its vector is the query's own (similarity 1).
      const rival = await service.create({ body: `rival note number ${i}` });
      await embedNote(rival, embedder.vectorFor(query));
      const page = await service.search(query);
      expect(page.mode).toBe('hybrid');
      expect(page.notes[0]?.id, query).toBe(target.id);
      expect(ids(page), query).toContain(rival.id);
    }
  });

  it('puts a rare code token first against a perfect, fresh meaning match', async () => {
    const rare = await service.create({
      body: 'seer feed dies with ECONNRESET every ~6h; the reconnect loop in feed.ts handles it #seer',
    });
    await embedNote(rare);
    await setDates(rare.id, new Date('2024-01-01T00:00:00Z'));
    const rival = await service.create({ body: 'flaky market data feed again #seer' });
    await embedNote(rival, embedder.vectorFor('ECONNRESET'));
    const page = await service.search('ECONNRESET');
    expect(page.notes[0]?.id).toBe(rare.id);
    expect(ids(page)).toContain(rival.id);
  });

  it('still returns full-text matches when no note has a vector yet', async () => {
    const a = await service.create({ body: 'pgx connection pool tuning #seer' });
    await service.create({ body: 'unrelated' });
    const page = await service.search('pool');
    expect(page.mode).toBe('hybrid');
    expect(ids(page)).toEqual([a.id]);
  });

  it('honours -exclusions on the meaning side too', async () => {
    const byKey = await seedLabelled();
    const page = await service.search('ArangoDB credentials -vault');
    expect(ids(page)).not.toContain(idOf(byKey, 'arango-vault'));
    expect(ids(page)).not.toContain(idOf(byKey, 'vault-unseal'));
  });
});

describe('filters apply before ranking', () => {
  const Q = 'ArangoDB credentials';

  it('tags_any / tags_all', async () => {
    const byKey = await seedLabelled();
    const infra = await service.search(Q, { tagsAny: ['infra'] });
    expect(infra.notes.length).toBeGreaterThan(0);
    expect(infra.notes.every((n) => n.tags.includes('infra'))).toBe(true);
    expect(infra.notes[0]?.id).toBe(idOf(byKey, 'arango-vault'));
    const running = await service.search(Q, { tagsAll: ['running'] });
    expect(running.notes.every((n) => n.tags.includes('running'))).toBe(true);
    expect(ids(running)).not.toContain(idOf(byKey, 'arango-vault'));
  });

  it('from / to', async () => {
    const byKey = await seedLabelled();
    const vault = idOf(byKey, 'arango-vault');
    await setDates(vault, new Date('2024-01-15T10:00:00Z'));
    const recent = await service.search(Q, { from: '2025-01-01' });
    expect(ids(recent)).not.toContain(vault);
    const old = await service.search(Q, { to: '2024-12-31' });
    expect(ids(old)).toEqual([vault]);
  });

  it('has_image', async () => {
    await seedLabelled();
    const img = await service.create({
      body: 'screenshot of the arango credentials page',
      image: { path: 'images/2026/10/arango.png', meta: meta('aa') },
    });
    await embedNote(img);
    expect(ids(await service.search(Q, { hasImage: true }))).toEqual([img.id]);
    expect(ids(await service.search(Q, { hasImage: false }))).not.toContain(img.id);
  });

  it('deleted', async () => {
    const byKey = await seedLabelled();
    const vault = idOf(byKey, 'arango-vault');
    await service.delete(vault);
    expect(ids(await service.search(Q))).not.toContain(vault);
    const only = await service.search(Q, { deleted: 'only' });
    expect(ids(only)).toEqual([vault]);
    expect(only.notes[0]?.deleted_at).toBeDefined();
  });
});

describe('fallback to full text', () => {
  it('says so when the query embedding fails, with the text ranking', async () => {
    await seedLabelled();
    embedder.failNext(1);
    const page = await service.search('backup');
    expect(page.mode).toBe('text');
    expect(page.fallback).toMatch(/could not be embedded/);
    expect(page.fallback).toMatch(/full-text results only/);
    const text = await service.search('backup', {}, { mode: 'text' });
    expect(ids(page)).toEqual(ids(text));
    expect(text.fallback).toBeUndefined();
  });

  it('says so when the query embedding times out', async () => {
    await seedLabelled();
    embedder.delayMs = 300;
    const page = await service.search('ArangoDB credentials', {}, { queryTimeoutMs: 25 });
    expect(page.mode).toBe('text');
    expect(page.fallback).toMatch(/timed out/);
  });

  it('says so when there is no embedder', async () => {
    const plain = new NotesService({ db, dataDir, events });
    await plain.create({ body: 'pgx connection pool tuning' });
    const page = await plain.search('pool');
    expect(page.mode).toBe('text');
    expect(page.fallback).toMatch(/OPENROUTER_API_KEY/);
    expect(page.notes).toHaveLength(1);
  });
});

describe('mode text', () => {
  it("is today's full-text ranking and makes no embedding call", async () => {
    await seedLabelled();
    for (const q of ['pool', 'backup', 'arango', '"root password"', 'connection -neon', '#running']) {
      const viaService = await service.search(q, { limit: 50 }, { mode: 'text' });
      const viaRepo = await searchNotes(db, q, { limit: 50 });
      expect(ids(viaService), q).toEqual(viaRepo.rows.map((r) => r.id));
      expect(viaService.mode).toBe('text');
      expect(viaService.fallback).toBeUndefined();
    }
    expect(embedder.calls).toHaveLength(0);
  });
});

describe('paging', () => {
  it('pages over the blended list and embeds the query once', async () => {
    await seedLabelled();
    const q = 'connection problems after waking the laptop';
    const all = await service.search(q, { limit: 50 });
    expect(all.notes.length).toBeGreaterThanOrEqual(2);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page: SearchPage = await service.search(q, cursor === undefined ? { limit: 1 } : { limit: 1, cursor });
      expect(page.mode).toBe('hybrid');
      seen.push(...ids(page));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(ids(all));
    expect(embedder.calls).toHaveLength(1);
  });
});

describe('MCP search tool', () => {
  async function connect(svc: NotesService): Promise<Client> {
    const server = createMcpServer({ service: svc, dataDir, db });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'search-hybrid-int', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  function text(result: unknown): string {
    const first = (result as CallToolResult).content[0];
    if (!first || first.type !== 'text') throw new Error('expected text content');
    return first.text;
  }

  it('describes meaning search, takes an optional mode and reports it', async () => {
    const byKey = await seedLabelled();
    const client = await connect(service);
    try {
      const { tools } = await client.listTools();
      const search = tools.find((t) => t.name === 'search');
      expect(search?.description).toMatch(/by meaning/);
      const props = (search?.inputSchema as { properties?: Record<string, unknown>; required?: string[] }) ?? {};
      expect(Object.keys(props.properties ?? {})).toEqual(expect.arrayContaining(['query', 'mode', 'tags_any', 'has_image']));
      expect(props.required ?? []).not.toContain('mode');

      const hybrid = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'ArangoDB credentials' } }))) as SearchPage;
      expect(hybrid.mode).toBe('hybrid');
      expect(hybrid.notes[0]?.id).toBe(idOf(byKey, 'arango-vault'));

      const exact = JSON.parse(
        text(await client.callTool({ name: 'search', arguments: { query: 'ArangoDB credentials', mode: 'text' } })),
      ) as SearchPage;
      expect(exact.mode).toBe('text');
      expect(exact.notes).toEqual([]);
      expect(exact.fallback).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('carries the fallback when the server has no embedder', async () => {
    const plain = new NotesService({ db, dataDir, events });
    await plain.create({ body: 'pgx connection pool tuning' });
    const client = await connect(plain);
    try {
      const page = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'pool' } }))) as SearchPage;
      expect(page.mode).toBe('text');
      expect(page.fallback).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      await client.close();
    }
  });
});
```
**Notes for the implementer:**
- `'from / to'` assumes no labelled note other than the backdated vault falls before 2024-12-31. The ageDays maximum is 420, so with `Date.now()` in 2026 or later this holds.
- In `'deleted'`, `deleted: 'only'` returns exactly the vault, because it is the only deleted note and it matches "ArangoDB credentials" well above `minSimilarity`.
- In `-exclusions`, both vault notes contain `vault`. The text side has no match ("arangodb" & "credentials" & !"vault"), and the meaning side applies the exclusion, so neither note may appear.
- If a labelled-set assertion fails only because of the fake's arithmetic, tune `SEMANTIC_LEXICON` or the distractor wording in the fixture. Do not loosen the strict `>` assertions, and do not change `BLEND` to fit the fake.

## Verification

**Build:** `npm run typecheck`

**Tests:**
- `npm test` covers `search.blend`, `search.queryVector`, `mcp.instructions` and every existing unit test.
- `npm run test:int` covers `search.hybrid.int.test.ts` and every existing integration file, unchanged: `notes.service.int`, `mcp.tools.int` and `images.mcp.int` keep passing with a null embedder, through the text fallback.

**Manual check:** This is optional and needs a daemon with a key and Phase 3's backfill done, so in practice Phase 6.
- Call MCP `search` with `{ "query": "ArangoDB credentials" }`. The result should show `"mode": "hybrid"`.
- Call it with `mode: "text"`. It should be today's result.
- Stop the network. The next new query should come back within about 5 s with `mode: "text"` and a `fallback`.

**Exit criteria:**
- On the labelled set with the fake embedder, hybrid MRR and recall@3 are both strictly greater than text-only (with hybrid ≥ 0.8 on both).
- Each of the three usage examples has a relevant note at rank 1.
- An exact id, dashed or dashless, ranks 1 against a similarity-1.0 rival, and so does a rare code token.
- The tags, dates, has_image and deleted filters hold in hybrid.
- A failing, slow or missing embedder returns `mode: 'text'` with a `fallback`, and results equal to text mode.
- `mode: 'text'` equals `repo.searchNotes` and makes no embedding call.
- Paging embeds once.
- typecheck, `npm test` and `npm run test:int` all pass.

## Handoffs

- **Phase 6 (R6/acceptance):**
  - Run `LABELLED_NOTES`/`LABELLED_QUERIES` through the real model. Retune only the numbers in `BLEND`, especially `minSimilarity`, and keep both invariants tested in `search.blend.test.ts`.
  - Phase 6's plan imports `BLEND`, `rankCandidates` and `BlendCandidate` exactly as this phase defines them. `textRank` may be any non-negative scale, because `rankCandidates` normalizes by the best candidate.
  - Update the `search` wording in `README.md` and `claude/skills/n/SKILL.md` ("understands meaning", `mode: "text"`) and docs. This phase does not touch them.
- **Phase 5 (R5):**
  - `src/mcp/tools.ts`: add the `related` registration after `tags`. This phase changes only the `search` block above it.
  - `src/mcp/instructions.ts`: add the `Related.` element before `Dates.`. This phase rewrites only `Reading.`.
  - `src/notes/service.ts`: this phase adds imports from `../search/*.js` and the `queryVectors` field. Phase 5 should merge imports, not duplicate them.
  - Phase 5's `related` could reuse `QueryVectorCache`/`embedQuery` for its embed-now path, but that is optional and Phase 5's call.
- **Phase 1 (R2):**
  - The vector candidate query uses `set local hnsw.iterative_scan = strict_order`, which needs pgvector ≥ 0.8. Phase 5 needs the same. Keep the test image's pgvector at 0.8.x or later.
- **Not done here, by design:**
  - No change to `src/chat/status.ts` (the caption stays "searching notes") or to `src/chat/prompt.ts`.
  - The HTTP API exposes no search endpoint (the web UI filters client-side and was not touched).

## Rollback

Revert this phase's commit. That removes `src/search/**`, `searchCandidates` and the new test files, and restores `search(query, filter) → NotePage`, the old tool description and the old `Reading.` paragraph. No schema or data change is involved: hybrid search only reads `note_embeddings`. Phases 1–3 keep working, because nothing they own imports `src/search/**`. Phase 5 must be reverted first if it has landed, but only for the `service.ts`/`tools.ts` merge context. It has no code dependency on this phase.
