> Adopted from `/home/miftah/.worktrees/mcp-notes/session-search-context/.workflows/plan/SESSION_SEARCH_CONTEXT_PLAN.md` phase 5. Source: `.workflows/plan/session-search-context/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Replies as a search source, related-evidence weight, wiring and docs

**Plan set:** `SESSION_SEARCH_CONTEXT_PLAN.md`
**Analysis:** `.workflows/analyze/20261106-145826-SSC7_code_analyzer.md`
**Satisfies:** R3 (Claude's persisted replies are search context, by words and by meaning), R4 (a related-evidence weight proven by a labelled fixture; the new evidence is wired into MCP, HTTP and the Projects chat)
**Depends on:** Phase 1 (candidate sources), Phase 3 (reply tables), Phase 4 (`isCurrentReplyEmbeddingSql` import). Phase 2 lands before it transitively (4 → 3 → 2); the docs quote phase 2's commit wording and describe phase 4's worker.
**Difficulty:** HARD
**Package:** `src/sessions` (+ `src/search/blend.ts`, `src/mcp`, `src/chat`, docs)

---

## Goal

`searchSessions` gets a fifth candidate source, Claude's replies (`cc_session_replies`). It matches them by words through the reply's own `search_tsv` and by meaning through current `cc_session_reply_embeddings` rows. Every hit carries `via_replies: [{ seq, excerpt }]`: at most 3 entries, best first, `[]` when none matched. `seq` is the number of the prompt the reply answered, and `excerpt` is the passage around the match.

Evidence a session borrows from a related item (a note or a reply) now counts `BLEND.related` (0.6) times the same evidence in its own text. The value comes from a labelled fixture: with no discount, a chatty reply outranks a session whose own summary answers the query; with too strong a discount, the only session that answers in a reply gets buried.

MCP, HTTP, the Projects chat prompt and the docs all describe `via_replies`. Nothing under `web/` changes (R5).

## Assumptions (what earlier / parallel phases must have landed)

- **Phase 1** (plan read: `phase-1.md`): `src/sessions/search.ts` is the file in phase 1's Step 2. It exports `EvidenceKind = 'own' | 'note'`, `RelatedKind`, `Signal`, `SessionRow`, `RelatedDbRow`, `RelatedEvidence`, `MergedCandidate` (`row`, `text`, `similarity`, `related`), `SourceRows`, `QueryVector`, `SourceQuery`, `CandidateSource`, `sessionTextSource`, `sessionVectorSource`, `nodeIdSource`, `notesSource`, `HYBRID_SOURCES`, `TEXT_SOURCES`, `mergeCandidates`, `collectCandidates`, `compareTextRanked` and `relatedSourceRows`. It has the private `toHit(c, thisHost, score)`, `textSearch(deps, query, filter, offset, limit, fallback?)` and `tsQuery(query)`. It also has the golden test `tests/integration/sessions.search.golden.int.test.ts` with its committed snapshot, plus `tests/unit/sessions/searchMerge.test.ts`. Line numbers below are inside phase 1's new file. Each edit is anchored on a quoted line from it.
- **Phase 3**: migration `drizzle/0014_*` creates two tables. `cc_session_replies(session_id text not null fk -> cc_sessions on delete cascade, seq integer not null, at timestamptz, text text not null, truncated boolean not null default false, search_tsv tsvector generated always as (to_tsvector('simple', text)) stored + GIN)` has primary key `(session_id, seq)`. `seq` equals the `cc_session_prompts.seq` (1-based) of the prompt the reply answers. `cc_session_reply_embeddings(session_id, seq, embedding vector(1536) null, sha text not null, model text not null, attempts int not null default 0, last_error, next_attempt_at, embedded_at, updated_at not null default now())` has primary key `(session_id, seq)`, no `created_at`, and FK `cc_session_reply_embeddings_reply_fk (session_id, seq)` → `cc_session_replies` on delete cascade, so every test inserts the reply row before its embedding row (the seeds below do). Every column not written by the tests below has a default or is nullable. The phase-3 ingester fills replies redacted.
- **Phase 4** (plan read: `phase-4.md`): `src/sessions/replyEmbeddings.ts` exports `isCurrentReplyEmbeddingSql(model: string): SQL`. It renders a predicate on the **unaliased** `cc_session_replies` / `cc_session_reply_embeddings`: embedding not null, `sha = encode(sha256(convert_to(text,'UTF8')),'hex')`, and `model = $model`. The worker is `startReplyEmbeddingWorker`, started in `src/background.ts`. Reconciled: phase 5 depends on phase 4 and imports the predicate; it never inlines a copy.
- **Phase 2**: `README.md:686-692` and `:1039`, `CLAUDE.md:41` and `features/projects.md` already carry phase 2's commit sentences. Phase 5 *adds* sentences next to them. Where phase 5 rewrites a whole line (the README `sessions_search` row), the line keeps phase 2's "commit messages" wording, as phase-2.md's handoff asks.

## Interface Contract

**Deletes:** none.
**Renames:** none.
**Creates:**
- `src/search/blend.ts`:
  - `BlendTuning.related: number` and `BLEND.related = 0.6`.
  - `export interface RelatedSignals { textRank: number | null; similarity: number | null }`.
  - Optional `related?: RelatedSignals` on both `BlendInput` and `BlendCandidate`.
  - `export function literalRank(own: number | null, related: number | null, tuning?: BlendTuning): number | null`.
- `src/sessions/view.ts`: `export const REPLY_EXCERPT_CHARS = 300`, `export interface SearchReplyMatch { seq: number; excerpt: string }`, and `SearchHit.via_replies: SearchReplyMatch[]`.
- `src/sessions/search.ts`:
  - `export const VIA_REPLIES_MAX = 3` and `export const repliesSource: CandidateSource`.
  - `SessionSearchHit.via_replies: SearchReplyMatch[]` and `SessionSearchOptions.tuning?: BlendTuning`.
  - Private helpers: `replyTsv`, `repliesOfSessions`, `replyEmbeddingOn`, `sessionsOfRepliesSql`, `repliesTextOnlySql`, `repliesHybridSql`, `replyKey`, `viaReplySeqs`, `replyExcerpts`, `toViaReplies`, `maxOrNull`, `relatedSignals` and `withWeightedText`.
- `src/sessions/readModel.ts`: `SessionSearchHit.viaReplies?: SearchReplyMatch[]`.
- New tests and fixture: `tests/fixtures/semantic/sessionsLabelled.ts` and `tests/integration/sessions.relatedEvidence.int.test.ts`.

**Signature changes:**
- `EvidenceKind`: `'own' | 'note'` -> `'own' | 'note' | 'reply'`.
- `HYBRID_SOURCES` and `TEXT_SOURCES` both gain `repliesSource` (appended).
- Private `toHit(c, thisHost, score)` -> `toHit(c, thisHost, score, replyExcerpts: ReadonlyMap<string, string>)`.
- Private `textSearch(deps, query, filter, offset, limit, fallback?)` -> `textSearch(deps, query, filter, offset, limit, tuning, fallback?)`.
- `blendScore`, `isEligible` and `rankCandidates` read the optional `related` field. A candidate without it scores exactly as before, so note search is unchanged.

**Requires (from earlier phases):** see Assumptions: phase 1's exports, phase 3's tables, phase 4's `isCurrentReplyEmbeddingSql`.

**Wire (additive):**
- MCP `sessions_search` hits gain `via_replies`.
- `GET /api/sessions/search` hits gain `via_replies`.
- `via_notes`, `score`, `mode` and `fallback` keep their names and shapes.
- Scores of hits that matched through a note change, because the 0.6 weight now applies. This is intended (R4).

**Leaves alone (owned by others):**
- ingest/transcript (`src/sessions/transcript.ts`, `ingest.ts`, `merge.ts`, `repo.ts`, `types.ts`): phase 3.
- `src/sessions/replyEmbeddings.ts` and `src/background.ts`: phase 4. Phase 5 only imports one function.
- `src/db/schema.ts` and `drizzle/*`: phases 2 and 3.
- `src/sessions/summarize.ts` and `summaryWorker.ts`: phase 2.
- **Everything under `web/`** (R5).
- Phase 1's `mergeCandidates`, `collectCandidates` and `compareTextRanked` are used as they are.

## Files

| File | Action | What changes |
|---|---|---|
| `src/search/blend.ts:1-231` | modify (whole file) | `related` weight, `RelatedSignals`, `literalRank`; `blendScore`/`isEligible`/`rankCandidates` take related evidence |
| `tests/unit/search.blend.test.ts:23-163` | modify | new `describe('related evidence')` block; existing invariants untouched |
| `src/sessions/view.ts:21, 212-221` | modify | `REPLY_EXCERPT_CHARS`, `SearchReplyMatch`, `SearchHit.via_replies` |
| `src/sessions/search.ts` (phase 1's file) | modify | imports, constants, `tuning` option, `via_replies`, `EvidenceKind`, replies source, excerpts, `toHit`, `textSearch`, `searchSessions` |
| `tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap` | regenerate | note-matched scores change by the weight (identity at `related: 1` proven first) |
| `tests/fixtures/semantic/sessionsLabelled.ts` | create | labelled sessions, replies, queries, lexicon |
| `tests/integration/sessions.relatedEvidence.int.test.ts` | create | the weight's proof: shipped value passes, 1 and 0.3 fail, sweep range |
| `tests/integration/sessions.search.int.test.ts:166` | modify (append) | `describe` block for replies as a source |
| `src/sessions/readModel.ts:44, 72-77, 151-160, 585` | modify | `viaReplies` through `phase6Search` and `searchNodes` |
| `src/http/sessionsApi.ts:123` | modify (doc comment only) | route list says hits carry `via_notes`/`via_replies`; handler passes `searchNodes` through unchanged |
| `src/mcp/sessionTools.ts:52-56, 97` | modify | tool description + `via_replies` in the output |
| `src/mcp/instructions.ts:59` | modify | one clause: what `sessions_search` searches, `via_notes`/`via_replies` |
| `src/chat/context.ts:107-115` | modify | `renderProjectBlock` text mentions `via_replies` and quoting |
| `src/chat/prompt.ts:41` | modify | project paragraph: quote reply excerpts with node id + prompt number |
| `tests/unit/chat-project.test.ts:33-38, 61-67` | modify | assert `via_replies` in block and prompt |
| `tests/integration/sessions.mcp.int.test.ts:76-82` | modify | hit carries `via_replies` array |
| `tests/integration/sessions.api.int.test.ts:540-545` | modify | hit carries `via_replies` array |
| `README.md:692, 1039, 1130` | modify | search prose paragraph, MCP row, HTTP row |
| `CLAUDE.md:41` | modify | sessions paragraph: reply embedding worker, search sources, `BLEND.related` |
| `.claude/skills/verify-notesd/features/projects.md` | modify | sub-feature bullets + "Replies in search" driving block |

## Implementation Steps

### Step 0: Install dependencies if the worktree has none
**File:** none (worktree root)
**Change:** the worktree has no `node_modules` until a phase installs them. Run once, before anything else:
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
[ -d node_modules ] || npm ci
```
**Impact:** none on the tree.

### Step 1: The related-evidence weight in `src/search/blend.ts`
**File:** `src/search/blend.ts:1-231` (replace the whole file)
**Change:** Add `related` to the tuning. Add an optional `related` signal pair to candidates and inputs. A candidate's literal rank becomes `max(own, related × related-rank)`, and the best-rank normalization runs on that value. Its meaning part becomes `max(score(own), related × score(related))`. A related literal match keeps the whole `textFloor`, so the documented invariants (`textFloor + text > vector + tag + recency`, `exactId > …`) are untouched. A candidate without `related` scores exactly as before, so note search does not change.

Why own and related are kept apart, instead of discounting whichever won phase 1's raw max: the session must compete with `max(own, w × related)`. Discounting the raw winner gives the wrong answer when the own rank is below the raw related rank but above the weighted one. Example: own 0.35, related 0.5, w 0.6. The right value is 0.35 (own). Discounting the raw winner gives 0.3. Phase 1's `MergedCandidate` keeps both (`row.text_rank`/`row.similarity` and `related.*`), so nothing in phase 1 changes.

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
  related: number;
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
 * A candidate with related items (a session's notes and Claude's replies in it) competes with
 * the better of its own evidence and `related` times its related items' best, per signal: rank =
 * max(own rank, related * related rank) before the best-rank normalization; meaning =
 * max(score(own similarity), related * score(related similarity)). A related literal match keeps
 * the whole textFloor.
 *
 * Two invariants are asserted in tests/unit/search.blend.test.ts and must survive any retune:
 *   textFloor + text > vector + tag + recency          the best literal hit beats every meaning-only note
 *   exactId > textFloor + text + vector + tag + recency a named id beats everything
 *
 * Tuned on tests/fixtures/semantic/labelled.ts with the concept-bag fake embedder; phase 6's
 * live test re-checks them against openai/text-embedding-3-small and may change the numbers
 * (never the names). `related` is tuned on tests/fixtures/semantic/sessionsLabelled.ts.
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
  // Cosine floor for meaning-only notes; below it a meaning-only candidate is noise and is
  // dropped instead of padding every result with the K nearest notes. Tuned on the real model,
  // 2026-10-30 (tests/live/embeddings.live.test.ts): the lowest labelled positive with no shared
  // word scored 0.240 (seer-incident for "have we met this kind of accidents before?"), so 0.3
  // dropped it; 0.22 keeps it. Live blend MRR 0.708 at 0.3, 0.733 at 0.22.
  minSimilarity: 0.22,
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
  // Evidence a session borrows from an item related to it (a note saved from or linked to it,
  // a reply Claude wrote in it) counts this many times the same evidence in the session's own
  // text and vector. Below 1: a long reply repeats words and wanders into side topics the session
  // was not about. Above 0: a reply is often the only place a session's fix is written down.
  // Tuned on tests/fixtures/semantic/sessionsLabelled.ts (real ts_rank, fake vectors;
  // tests/integration/sessions.relatedEvidence.int.test.ts): every answer ranks first for
  // 0.46..0.76. At 1, a chatty reply beats the session whose own summary answers ("photo
  // delete"). At 0.45 and below, a loosely related session beats the only one whose reply
  // answers ("connection problems after waking the laptop"). 0.6 sits inside with room on both sides.
  related: 0.6,
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

/**
 * The best of a candidate's related items (a session's notes and Claude's replies in it), on the
 * same scales as its own textRank and similarity. Null when no related item had that signal.
 */
export interface RelatedSignals {
  textRank: number | null;
  similarity: number | null;
}

/**
 * The literal rank a candidate competes with: its own, or its related items' best times
 * `tuning.related`, whichever is higher. Null when neither matched by words.
 */
export function literalRank(own: number | null, related: number | null, tuning: BlendTuning = BLEND): number | null {
  if (related === null) return own;
  const weighted = tuning.related * related;
  return own === null ? weighted : Math.max(own, weighted);
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
  /** Related items' best (textRank on the same normalized scale); absent for a candidate with none. */
  related?: RelatedSignals;
}

export function blendScore(x: BlendInput, tuning: BlendTuning = BLEND): number {
  const text = literalRank(x.textRank, x.related?.textRank ?? null, tuning);
  const meaning = Math.max(
    similarityScore(x.similarity, tuning),
    tuning.related * similarityScore(x.related?.similarity ?? null, tuning),
  );
  return (
    (x.exactId ? tuning.exactId : 0) +
    (text === null ? 0 : tuning.textFloor + tuning.text * clamp01(text)) +
    tuning.vector * meaning +
    tuning.tag * clamp01(x.tagMatch) +
    tuning.recency * clamp01(x.recency)
  );
}

function clearsSimilarityFloor(similarity: number | null, tuning: BlendTuning): boolean {
  return similarity !== null && Number.isFinite(similarity) && similarity >= tuning.minSimilarity;
}

/** A meaning-only candidate must clear minSimilarity (own or related); a literal or id match always stays. */
export function isEligible(x: BlendInput, tuning: BlendTuning = BLEND): boolean {
  if (x.exactId || x.textRank !== null || (x.related?.textRank ?? null) !== null) return true;
  return clearsSimilarityFloor(x.similarity, tuning) || clearsSimilarityFloor(x.related?.similarity ?? null, tuning);
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
  /** Raw best rank and similarity of the candidate's related items; absent when it has none (notes). */
  related?: RelatedSignals;
}

export type Ranked<T> = T & { score: number };

/**
 * Scores and orders candidates, best first: score desc, then updated_at desc, then id desc
 * (text mode's tie-break). Ineligible candidates are removed. The best rank that normalizes
 * text ranks is the best literalRank, so a related rank counts at its weighted value there too.
 */
export function rankCandidates<T extends BlendCandidate>(
  candidates: readonly T[],
  opts: { now: Date; tuning?: BlendTuning },
): Ranked<T>[] {
  const tuning = opts.tuning ?? BLEND;
  let best = 0;
  for (const c of candidates) {
    const r = literalRank(c.textRank, c.related?.textRank ?? null, tuning);
    if (r !== null && Number.isFinite(r) && r > best) best = r;
  }
  const normalize = (rank: number | null): number | null => (rank === null ? null : best > 0 ? rank / best : 1);
  const out: Ranked<T>[] = [];
  for (const c of candidates) {
    const input: BlendInput = {
      exactId: c.exactId === true,
      textRank: normalize(c.textRank),
      similarity: c.similarity,
      tagMatch: c.tagMatch,
      recency: recencyScore(c.updatedAt, opts.now, tuning),
    };
    if (c.related !== undefined) {
      input.related = { textRank: normalize(c.related.textRank), similarity: c.related.similarity };
    }
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
**Impact:** Note search (`src/notes/*`, `tests/integration/search.hybrid.int.test.ts`, `tests/live/embeddings.live.test.ts`) passes no `related`, so its scores are byte-identical. `BlendTuning` gains a required field. Nothing outside this file builds a `BlendTuning` literal (`grep -rn "BlendTuning\|\.\.\.BLEND" src tests` returns only blend.ts today).

### Step 2: Unit tests for the weight's mechanics
**File:** `tests/unit/search.blend.test.ts` (import list at lines 2-12; append a block after line 163)
**Change:** Add `literalRank` to the import list. Append the block below. The existing `describe('BLEND')` invariants stay as they are.
**Code (import list replacement, lines 2-12):**
```ts
import {
  BLEND,
  blendScore,
  isEligible,
  literalRank,
  queryTerms,
  rankCandidates,
  recencyScore,
  similarityScore,
  tagMatch,
  type BlendCandidate,
} from '../../src/search/blend.js';
```
**Code (append at end of file):**
```ts
describe('related evidence (a session\'s notes and replies)', () => {
  it('weighs related evidence below own and above nothing', () => {
    expect(BLEND.related).toBeGreaterThan(0);
    expect(BLEND.related).toBeLessThan(1);
  });

  it('literalRank takes the better of own and weighted related', () => {
    expect(literalRank(null, null)).toBeNull();
    expect(literalRank(0.3, null)).toBe(0.3);
    expect(literalRank(null, 0.5)).toBeCloseTo(BLEND.related * 0.5, 10);
    expect(literalRank(0.35, 0.5, { ...BLEND, related: 0.6 })).toBe(0.35);
    expect(literalRank(0.1, 0.5, { ...BLEND, related: 0.6 })).toBeCloseTo(0.3, 10);
  });

  it('a related literal match keeps the text floor, so it still beats any meaning-only match', () => {
    const viaReply = cand('reply', { related: { textRank: 0.0001, similarity: null }, updatedAt: daysAgo(900) });
    const rival = cand('rival', { similarity: 1, tagMatch: 1 });
    expect(order([rival, viaReply])).toEqual(['reply', 'rival']);
  });

  it('the same evidence counts more as own text than through a related item', () => {
    const own = cand('own', { textRank: 0.1, similarity: 0.8 });
    const related = cand('related', { related: { textRank: 0.1, similarity: 0.8 } });
    expect(order([related, own])).toEqual(['own', 'related']);
  });

  it('a related rank is weighted before the best-rank normalization', () => {
    const [a, b] = rankCandidates([cand('own', { textRank: 0.1 }), cand('rel', { related: { textRank: 0.1, similarity: null } })], { now: NOW });
    expect(a!.id).toBe('own');
    expect(a!.score).toBeCloseTo(BLEND.textFloor + BLEND.text + BLEND.recency, 10);
    expect(b!.score).toBeCloseTo(BLEND.textFloor + BLEND.text * BLEND.related + BLEND.recency, 10);
  });

  it('meaning: the better of own and weighted related', () => {
    const s = blendScore({ exactId: false, textRank: null, similarity: 0.5, tagMatch: 0, recency: 0, related: { textRank: null, similarity: 1 } });
    expect(s).toBeCloseTo(BLEND.vector * Math.max(similarityScore(0.5), BLEND.related * similarityScore(1)), 10);
  });

  it('related meaning alone is eligible once it clears minSimilarity; a related word match always is', () => {
    const base = { exactId: false, textRank: null, similarity: null, tagMatch: 0, recency: 1 };
    expect(isEligible({ ...base, related: { textRank: null, similarity: BLEND.minSimilarity } })).toBe(true);
    expect(isEligible({ ...base, related: { textRank: null, similarity: BLEND.minSimilarity - 0.01 } })).toBe(false);
    expect(isEligible({ ...base, related: { textRank: 0, similarity: null } })).toBe(true);
  });

  it('a candidate without related evidence scores exactly as before', () => {
    const plain = { exactId: false, textRank: 0.5, similarity: 0.7, tagMatch: 0.5, recency: 0.5 };
    expect(blendScore(plain)).toBeCloseTo(
      BLEND.textFloor + BLEND.text * 0.5 + BLEND.vector * similarityScore(0.7) + BLEND.tag * 0.5 + BLEND.recency * 0.5,
      10,
    );
  });
});
```
**Impact:** `npx vitest run tests/unit/search.blend.test.ts` should pass (the 20 existing tests plus 8 new).

### Step 3: Reply match type and excerpt size in `src/sessions/view.ts`
**File:** `src/sessions/view.ts:21` (after `export const NOTE_EXCERPT_CHARS = 200;`) and `:212-221` (`SearchNoteMatch` / `SearchHit`)
**Code (insert after line 21):**
```ts
/** A reply excerpt in search hits (via_replies) is cut to this many characters. */
export const REPLY_EXCERPT_CHARS = 300;
```
**Code (replace lines 211-221, from the `SearchNoteMatch` doc comment through the end of `SearchHit`):**
```ts
/** A note saved from or linked to a search hit's session that matched the query. */
export interface SearchNoteMatch {
  id: string;
  excerpt: string;
}

/** One of Claude's replies in a search hit's session that matched the query. */
export interface SearchReplyMatch {
  /** The number of the prompt the reply answered (cc_session_prompts.seq, 1-based). */
  seq: number;
  /** The passage of the reply around the match (its start for a meaning-only match). */
  excerpt: string;
}

export interface SearchHit extends GraphNode {
  score: number;
  /** The session's notes that matched the query, best first; empty when it matched on its own text. */
  via_notes: SearchNoteMatch[];
  /** Claude's replies in the session that matched the query, best first, at most 3; empty when none did. */
  via_replies: SearchReplyMatch[];
}
```
**Impact:** `searchNodes` must now set `via_replies` (Step 9). The typecheck fails until then, so Steps 3, 4 and 9 land in one commit.

### Step 4: Replies source, weighted ranking and `via_replies` in `src/sessions/search.ts`
**File:** `src/sessions/search.ts` (phase 1's file). Every edit below is anchored on a line quoted from phase-1.md Step 2.

**4a. Imports.** Replace the three lines
`import { BLEND, queryTerms, rankCandidates, tagMatch } from '../search/blend.js';` … `import { NOTE_EXCERPT_CHARS, excerpt } from './view.js';` (phase 1's lines 356-359) with:
```ts
import { BLEND, queryTerms, rankCandidates, tagMatch, type BlendTuning, type RelatedSignals } from '../search/blend.js';
import { QUERY_EMBED_TIMEOUT_MS, QueryVectorCache, embedQuery } from '../search/queryVector.js';
import { findNodeIdCandidates } from './ids.js';
import { isCurrentReplyEmbeddingSql } from './replyEmbeddings.js';
import { NOTE_EXCERPT_CHARS, REPLY_EXCERPT_CHARS, excerpt, type SearchReplyMatch } from './view.js';
```

**4b. Constants.** After `export const VIA_NOTES_MAX = 3;` insert:
```ts
/** At most this many matching replies are listed in a hit's via_replies. */
export const VIA_REPLIES_MAX = 3;
/** ts_headline options for a reply excerpt: one plain fragment around the match (the reply's start when none). */
const REPLY_HEADLINE_OPTIONS = 'MaxWords=45, MinWords=20, StartSel="", StopSel="", MaxFragments=1';
```

**4c. Options.** Replace `interface SessionSearchOptions { … }` with:
```ts
export interface SessionSearchOptions {
  /** Default 'hybrid'. 'text' is the full-text ranking only. */
  mode?: SearchMode;
  queryTimeoutMs?: number;
  /** Recency reference. Default new Date(). */
  now?: Date;
  /** Weights to rank with. Default BLEND; tests/integration/sessions.relatedEvidence.int.test.ts sweeps `related`. */
  tuning?: BlendTuning;
}
```

**4d. Hit.** In `interface SessionSearchHit`, between the `via_notes` field and the `score` doc comment, insert:
```ts
  /**
   * Claude's replies in this session that matched the query, best first, at most VIA_REPLIES_MAX:
   * `seq` is the number of the prompt the reply answered, `excerpt` the passage around the match.
   * Empty when no reply matched.
   */
  via_replies: SearchReplyMatch[];
```

**4e. Evidence kind.** Replace `export type EvidenceKind = 'own' | 'note';` with:
```ts
export type EvidenceKind = 'own' | 'note' | 'reply';
```

**4f. The replies source.** Replace phase 1's two list lines
`export const HYBRID_SOURCES … = [sessionTextSource, sessionVectorSource, nodeIdSource, notesSource];` and
`export const TEXT_SOURCES … = [sessionTextSource, notesSource];` (and their doc comments) with:
```ts
/** A reply's generated 'simple' tsvector (migration 0014). Tables stay unaliased: isCurrentReplyEmbeddingSql names them. */
function replyTsv(): SQL {
  return sql.raw('cc_session_replies.search_tsv');
}

/** Replies joined to their session as `s`, so filterSql applies. */
function repliesOfSessions(): SQL {
  return sql.raw('cc_session_replies join cc_sessions s on s.session_id = cc_session_replies.session_id');
}

/** The reply's embedding row, when it holds a vector made from the reply's current text by `v.model`. */
function replyEmbeddingOn(v: QueryVector): SQL {
  return sql`cc_session_reply_embeddings.session_id = cc_session_replies.session_id
    and cc_session_reply_embeddings.seq = cc_session_replies.seq
    and ${isCurrentReplyEmbeddingSql(v.model)}`;
}

/**
 * `matched(session_id, seq, text_rank, similarity)` -> per session: `(session_id, text_rank,
 * similarity, items)`, the best of its matching replies, with `items` = jsonb `[{ seq }]` best
 * first. Reply text is not aggregated (a reply is up to 16k characters and up to 600 match):
 * toHit gets each shown reply's passage from replyExcerpts. `matched` has already applied the filter.
 */
function sessionsOfRepliesSql(matched: SQL): SQL {
  return sql`
    with matched as (${matched})
    select m.session_id,
      max(m.text_rank)::float8 as text_rank,
      max(m.similarity)::float8 as similarity,
      jsonb_agg(jsonb_build_object('seq', m.seq)
        order by m.text_rank desc nulls last, m.similarity desc nulls last, m.seq) as items
    from matched m
    group by m.session_id
  `;
}

/** Text mode: every reply of a filtered session that matches by words. */
function repliesTextOnlySql(q: SourceQuery): SQL {
  return sql`select cc_session_replies.session_id, cc_session_replies.seq,
      ts_rank(${replyTsv()}, ${q.tsq})::float8 as text_rank, null::float8 as similarity
    from ${repliesOfSessions()}
    where ${replyTsv()} @@ ${q.tsq} and ${filterSql(q.filter)}`;
}

/** Hybrid: the best word matches (at most textLimit) and the nearest current reply vectors, filtered sessions only. */
function repliesHybridSql(q: SourceQuery, v: QueryVector): SQL {
  const fields = sql`cc_session_replies.session_id, cc_session_replies.seq,
    (case when ${replyTsv()} @@ ${q.tsq} then ts_rank(${replyTsv()}, ${q.tsq}) end)::float8 as text_rank,
    (1 - (cc_session_reply_embeddings.embedding <=> ${v.qvec}))::float8 as similarity`;
  const excluded =
    q.excluded.length > 0
      ? sql`not (${replyTsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
      : sql`true`;
  const textLimit = q.textLimit === null ? sql.empty() : sql`limit ${q.textLimit}`;
  return sql`(select ${fields}
      from ${repliesOfSessions()}
      left join cc_session_reply_embeddings on ${replyEmbeddingOn(v)}
      where ${replyTsv()} @@ ${q.tsq} and ${filterSql(q.filter)}
      order by ts_rank(${replyTsv()}, ${q.tsq}) desc, cc_session_replies.session_id, cc_session_replies.seq
      ${textLimit})
    union
    (select ${fields}
      from ${repliesOfSessions()}
      join cc_session_reply_embeddings on ${replyEmbeddingOn(v)}
      where ${filterSql(q.filter)} and ${excluded}
      order by cc_session_reply_embeddings.embedding <=> ${v.qvec}
      limit ${BLEND.vectorCandidates})`;
}

/**
 * Sessions whose replies (what Claude said after each turn's last tool call, cc_session_replies)
 * match, by words (the reply's own search_tsv) or meaning (its current vector). Read from the
 * shared database, so it works for both machines' sessions.
 */
export const repliesSource: CandidateSource = {
  name: 'replies',
  async run(db, q) {
    const matched = q.vector === null ? repliesTextOnlySql(q) : repliesHybridSql(q, q.vector);
    const res = await db.execute<RelatedDbRow>(sessionsOfRepliesSql(matched));
    return relatedSourceRows('reply', res.rows);
  },
};

/** Hybrid mode's sources, in the order their rows are merged. */
export const HYBRID_SOURCES: readonly CandidateSource[] = [
  sessionTextSource,
  sessionVectorSource,
  nodeIdSource,
  notesSource,
  repliesSource,
];
/** Text mode's sources: the full-text part of every source that has one. */
export const TEXT_SOURCES: readonly CandidateSource[] = [sessionTextSource, notesSource, repliesSource];
```
(`sql.empty()`: as phase 1 notes, use `` sql`` `` if the installed drizzle lacks it.)

**4g. Reply excerpts, related signals, weighted text.** Insert right after phase 1's `function toViaNotes(…) { … }`:
```ts
function replyKey(sessionId: string, seq: number): string {
  return `${sessionId}#${seq}`;
}

/** The reply seqs of a replies source's `items`, deduped, best first, at most VIA_REPLIES_MAX. */
function viaReplySeqs(items: unknown): number[] {
  if (!Array.isArray(items)) return [];
  const out: number[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const seq = (item as { seq?: unknown }).seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || out.includes(seq)) continue;
    out.push(seq);
    if (out.length === VIA_REPLIES_MAX) break;
  }
  return out;
}

/**
 * The passage around the match of every reply the shown hits list, keyed by replyKey: one
 * ts_headline query per page, so only the replies a user sees are cut (not every matching one).
 */
async function replyExcerpts(db: Db, query: string, shown: readonly MergedCandidate[]): Promise<Map<string, string>> {
  const pairs = shown.flatMap((c) => viaReplySeqs(c.related.reply?.items).map((seq) => sql`(${c.row.session_id}, ${seq}::int)`));
  const out = new Map<string, string>();
  if (pairs.length === 0) return out;
  const res = await db.execute<{ session_id: string; seq: number | string; headline: string | null }>(sql`
    select cc_session_replies.session_id, cc_session_replies.seq,
      ts_headline('simple', cc_session_replies.text, websearch_to_tsquery('simple', ${query}), ${REPLY_HEADLINE_OPTIONS}) as headline
    from cc_session_replies
    where (cc_session_replies.session_id, cc_session_replies.seq) in (values ${sql.join(pairs, sql`, `)})
  `);
  for (const row of res.rows) {
    const text = excerpt(row.headline, REPLY_EXCERPT_CHARS);
    if (text !== null) out.set(replyKey(row.session_id, Number(row.seq)), text);
  }
  return out;
}

/** via_replies of one hit: its best seqs with their passages; a reply gone since the search is dropped. */
function toViaReplies(sessionId: string, items: unknown, excerpts: ReadonlyMap<string, string>): SearchReplyMatch[] {
  return viaReplySeqs(items).flatMap((seq) => {
    const text = excerpts.get(replyKey(sessionId, seq));
    return text === undefined ? [] : [{ seq, excerpt: text }];
  });
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** The best raw rank and similarity over every related kind of a candidate; undefined when it has none. */
function relatedSignals(c: MergedCandidate): RelatedSignals | undefined {
  let found = false;
  let textRank: number | null = null;
  let similarity: number | null = null;
  for (const ev of Object.values(c.related)) {
    if (ev === undefined) continue;
    found = true;
    textRank = maxOrNull(textRank, ev.text_rank);
    similarity = maxOrNull(similarity, ev.similarity);
  }
  return found ? { textRank, similarity } : undefined;
}

/**
 * Text mode's view of a candidate: its text signal is the better of its own rank and each
 * related kind's rank times `tuning.related` (blend.ts literalRank), so text mode weighs a
 * note's or reply's words the way hybrid does. compareTextRanked then orders it unchanged.
 */
function withWeightedText(c: MergedCandidate, tuning: BlendTuning): MergedCandidate {
  let text: Signal | null = c.row.text_rank === null ? null : { value: c.row.text_rank, from: 'own' };
  for (const ev of Object.values(c.related)) {
    if (ev === undefined || ev.text_rank === null) continue;
    const value = tuning.related * ev.text_rank;
    if (text === null || value > text.value) text = { value, from: ev.kind };
  }
  return { ...c, text };
}
```

**4h. `toHit`.** Replace phase 1's `function toHit(c: MergedCandidate, thisHost: string, score: number): SessionSearchHit { … }` with:
```ts
function toHit(c: MergedCandidate, thisHost: string, score: number, replyExcerpts: ReadonlyMap<string, string>): SessionSearchHit {
  const r = c.row;
  const source = r.parent_link_source;
  return {
    session_id: r.session_id,
    node_id: r.node_id,
    repo: r.repo,
    host: r.host,
    available: r.host === thisHost,
    cwd: r.cwd,
    branch: r.branch,
    name: r.name,
    title: r.custom_title ?? r.ai_title ?? r.name,
    first_prompt: r.first_prompt,
    summary: r.summary,
    started_at: toDate(r.started_at)?.toISOString() ?? null,
    last_active_at: toDate(r.last_active_at)?.toISOString() ?? null,
    parent_session_id: r.parent_session_id,
    parent_link_source: source === 'env' || source === 'hook' || source === 'heuristic' ? source : null,
    via_notes: toViaNotes(c.related.note?.items),
    via_replies: toViaReplies(r.session_id, c.related.reply?.items, replyExcerpts),
    score,
  };
}
```

**4i. `textSearch` and `searchSessions`.** Replace phase 1's `async function textSearch(…) { … }` through the end of the file with:
```ts
async function textSearch(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter,
  offset: number,
  limit: number,
  tuning: BlendTuning,
  fallback?: string,
): Promise<SessionSearchPage> {
  const q: SourceQuery = { tsq: tsQuery(query), vector: null, nodeIds: [], excluded: [], filter, textLimit: null };
  // A session ranks by the better of its own text rank and its related items' best, weighted by tuning.related.
  const ranked = (await collectCandidates(deps.db, q, TEXT_SOURCES)).map((c) => withWeightedText(c, tuning)).sort(compareTextRanked);
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  const shown = ranked.slice(offset, end);
  const excerpts = await replyExcerpts(deps.db, query, shown);
  const page: SessionSearchPage = {
    sessions: shown.map((c) => toHit(c, thisHost, c.text?.value ?? 0, excerpts)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'text',
  };
  if (fallback !== undefined) page.fallback = fallback;
  return page;
}

/**
 * Hybrid search over cc_sessions. Signals: full-text rank on the generated tsvector, closeness
 * in meaning from cc_session_embeddings, the repo as a tag, recency of last activity, and an
 * exact node id. Candidates come from HYBRID_SOURCES. The notes saved from or linked to a
 * session, and Claude's replies in it, count as related evidence: the session competes with the
 * better of its own signal and its related items' best times BLEND.related, per signal. Hits
 * list the notes in via_notes and the replies in via_replies. Everything is blended by
 * src/search/blend.ts. Falls back to full text (TEXT_SOURCES, same weighting), with `fallback`
 * saying why, when there is no embedder or the query cannot be embedded in time. The cursor is
 * an offset into whichever ranking produced the page.
 */
export async function searchSessions(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter = {},
  opts: SessionSearchOptions = {},
): Promise<SessionSearchPage> {
  if (query.trim() === '') throw new NoteError('invalid_input', 'sessions search needs a non-empty query.');
  const offset = decodeCursor(filter.cursor);
  const limit = clampSessionLimit(filter.limit);
  const tuning = opts.tuning ?? BLEND;
  // Validate dates before spending an embedding call.
  filterSql(filter);
  if (opts.mode === 'text') return textSearch(deps, query, filter, offset, limit, tuning);
  const embedder = deps.embedder;
  if (embedder === null) return textSearch(deps, query, filter, offset, limit, tuning, SESSIONS_SEMANTIC_OFF_FALLBACK);

  let vector: number[];
  try {
    vector = await embedQuery(
      embedder,
      deps.queryVectors ?? defaultQueryVectors,
      query,
      opts.queryTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS,
    );
  } catch (err) {
    return textSearch(deps, query, filter, offset, limit, tuning, sessionEmbedFailedFallback(err));
  }

  const terms = queryTerms(query);
  const nodeIds = findNodeIdCandidates(query.toUpperCase());
  const candidates = await collectCandidates(
    deps.db,
    {
      tsq: tsQuery(query),
      vector: { qvec: sql`${toVectorLiteral(vector)}::vector`, model: embedder.model },
      nodeIds,
      excluded: terms.excluded,
      filter,
      textLimit: BLEND.textCandidates,
    },
    HYBRID_SOURCES,
  );
  const epoch = new Date(0);
  // Own and related signals go to the blend separately: the weight decides which one wins.
  const ranked = rankCandidates(
    candidates.map((c) => ({
      id: c.row.session_id,
      textRank: c.row.text_rank,
      similarity: c.row.similarity,
      related: relatedSignals(c),
      tagMatch: tagMatch(c.row.repo !== null ? [c.row.repo.toLowerCase()] : [], terms),
      updatedAt: toDate(c.row.last_active_at) ?? toDate(c.row.started_at) ?? epoch,
      exactId: nodeIds.includes(c.row.node_id),
      candidate: c,
    })),
    { now: opts.now ?? new Date(), tuning },
  );
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  const shown = ranked.slice(offset, end);
  const excerpts = await replyExcerpts(
    deps.db,
    query,
    shown.map((r) => r.candidate),
  );
  return {
    sessions: shown.map((r) => toHit(r.candidate, thisHost, r.score, excerpts)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'hybrid',
  };
}
```
**Impact:**
- `c.text` / `c.similarity` (phase 1's merged maxima with `from`) are no longer read by hybrid ranking, which reads `c.row.*` and `c.related.*`. Text mode recomputes `c.text` via `withWeightedText`. Phase 1's `mergeCandidates` and its unit tests stay valid and unchanged.
- At `related: 1` the output equals phase 1's exactly, which Step 5 proves.
- The hybrid/text SQL above was dry-run against pgvector Postgres 16 in a rolled-back transaction during planning, with the column layout from Assumptions: per-session `max`, `jsonb_agg` `[{"seq":1},{"seq":2}]`, a stale-sha vector excluded, `ts_headline` with empty `StartSel` accepted, and `greatest(real, float8)` fine.

### Step 5: Golden snapshot: prove the weight is the only change, then regenerate
**File:** `tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap`
**Change:** Phase 1's golden seed has no replies, and its `observable` omits `via_replies`. At `related: 1` the blend reduces to phase 1's raw per-signal max, so the old snapshot must still pass. Prove that, put 0.6 back, and only then regenerate. Commit the regenerated snapshot on its own (`test(sessions): golden scores with BLEND.related 0.6`).
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
sed -i 's/^  related: 0\.6,$/  related: 1,/' src/search/blend.ts && grep -n '^  related: 1,$' src/search/blend.ts
npm run test:int -- tests/integration/sessions.search.golden.int.test.ts      # MUST PASS against phase 1's snapshot
sed -i 's/^  related: 1,$/  related: 0.6,/' src/search/blend.ts && grep -n '^  related: 0.6,$' src/search/blend.ts
npm run test:int -- tests/integration/sessions.search.golden.int.test.ts --update
git diff --stat tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap
```
If the `related: 1` run fails, the replies source or the ranking changed something besides the weight. Stop and fix it before `--update`.
**Impact:** In the regenerated snapshot, only the scores (and possibly the order) of pages where a note matched change: `adversarial trades`, `quokka*`, `vault credentials`, `leaderboard ranking tweaks`, and the filtered/paged `quokka` queries.

### Step 6: The labelled fixture
**File:** `tests/fixtures/semantic/sessionsLabelled.ts` (new)
**Code:**
```ts
import type { Lexicon } from '../../helpers/fakeEmbedder.js';
import { SEMANTIC_LEXICON } from './labelled.js';

/**
 * A labelled set for the related-evidence weight (BLEND.related in src/search/blend.ts): Claude
 * Code sessions with their own summary and prompts, and Claude's replies in them.
 * tests/integration/sessions.relatedEvidence.int.test.ts loads it into cc_sessions /
 * cc_session_replies with fake-embedder vectors (SESSION_LEXICON, SESSION_STOPWORDS) and runs
 * the real searchSessions, so text ranks are Postgres's own ts_rank.
 *
 * The query kinds pull BLEND.related in opposite directions:
 *   over-match  a session whose own summary answers, against one that only repeats the words in
 *               long replies: too high a weight lets the chatty one win.
 *   reply-only  the only session that answers does so in a reply, against a session whose own
 *               text is loosely related: too low a weight buries the answer.
 *   own         the answer is in the session's own text only (a sanity check).
 */
export interface LabelledSession {
  key: string;
  summary: string;
  prompts: readonly string[];
  /** Claude's reply to prompts[i] (seq i + 1). */
  replies: readonly string[];
  ageDays: number;
}

export interface LabelledSessionQuery {
  query: string;
  /** Key of the session that must rank first in hybrid mode. */
  answer: string;
  kind: 'over-match' | 'reply-only' | 'own';
  why: string;
}

const SCORECARD_REPLIES = [
  'The scorecard now has one row per method. The trades column shows zero when a method has no closed trades yet, and the adversarial book gets its own column beside the twin book. Zero trades is not an error there: it only means nothing closed in the window. I narrowed the trades column, right-aligned the numbers and moved the adversarial win rate next to it so the two books line up.',
  'I checked the layout at 1400 px. The adversarial columns wrap when the method name is long, so I gave the name column a max width. Rows with zero trades are greyed so they do not compete with methods that traded. The trades header now has a tooltip that says closed trades only.',
  'Last pass on the scorecard: zero trades rows sort to the bottom, the adversarial and twin trades counts share one header, and the page keeps its scroll position on refresh.',
];

const PURGE_REPLIES = [
  'A photo delete from the editor is soft: the photo goes to the recycle bin with its note. The purge job hard-deletes photo rows older than 30 days and removes the derived copies. A photo delete that was restored keeps its position. I made the purge skip any photo delete that is younger than the grace period, and logged every photo it removes.',
];

export const LABELLED_SESSIONS: ReadonlyArray<LabelledSession> = [
  {
    key: 'adv-cutoff',
    ageDays: 10,
    summary: 'Seer Adversarial showed zero trades: verdicts were dated after the session open, so the cutoff dropped every pick. Fixed by comparing against session_open_utc.',
    prompts: ['why does adversarial show zero trades?'],
    replies: ['The cutoff now compares against session_open_utc, and a regression test covers it.'],
  },
  {
    key: 'adv-scorecard',
    ageDays: 2,
    summary: 'Scorecard page layout for the Adversarial view.',
    prompts: ['make the scorecard columns narrower', 'check it at 1400 px', 'one more pass'],
    replies: SCORECARD_REPLIES,
  },
  {
    key: 'wifi-ingest',
    ageDays: 30,
    summary: 'Refactored the session ingest tail loop and its byte offsets.',
    prompts: ['clean up the tail loop'],
    replies: ['Separate from the ingest work: the wifi drops after resume were the GPD driver; reloading it fixed the connection.'],
  },
  {
    key: 'laptop-battery',
    ageDays: 1,
    summary: 'Laptop battery report script for the GPD.',
    prompts: ['write a battery report script'],
    replies: [],
  },
  {
    key: 'quokka-reply',
    ageDays: 60,
    summary: 'Drizzle migration cleanup.',
    prompts: ['tidy the migrations'],
    replies: ['The quokka flag is gone; nothing reads it now.'],
  },
  {
    key: 'photo-own',
    ageDays: 20,
    summary: 'Wall photo delete button added to the editor.',
    prompts: ['add a delete button for photos'],
    replies: [],
  },
  {
    key: 'photo-chatty',
    ageDays: 3,
    summary: 'Recycle bin purge job.',
    prompts: ['purge the bin nightly'],
    replies: PURGE_REPLIES,
  },
];

export const LABELLED_SESSION_QUERIES: ReadonlyArray<LabelledSessionQuery> = [
  {
    query: 'adversarial zero trades',
    answer: 'adv-cutoff',
    kind: 'over-match',
    why: 'the cutoff fix says it in its summary; the scorecard session repeats every word in three long replies',
  },
  {
    query: 'why did adversarial show no trades',
    answer: 'adv-cutoff',
    kind: 'own',
    why: 'no literal match anywhere (websearch AND); the fix wins on its own vector',
  },
  {
    query: 'connection problems after waking the laptop',
    answer: 'wifi-ingest',
    kind: 'reply-only',
    why: 'only a reply holds the wifi-after-resume fix; the battery session is a loose own match (laptop, GPD)',
  },
  {
    query: 'quokka',
    answer: 'quokka-reply',
    kind: 'reply-only',
    why: 'a word that only one reply has',
  },
  {
    query: 'photo delete',
    answer: 'photo-own',
    kind: 'over-match',
    why: 'the delete-button session says it in its summary; the purge session repeats "photo delete" in a long reply',
  },
];

/** SEMANTIC_LEXICON plus the concepts these sessions need. */
export const SESSION_LEXICON: Lexicon = [
  ...SEMANTIC_LEXICON,
  ['trade', 'trades', 'trading', 'pick*', 'position*'],
  ['adversar*', 'verdict*', 'critic*', 'review*'],
  ['zero', 'none', 'no', 'empty', 'nothing', 'missing'],
  ['cutoff*', 'deadline*', 'late'],
  ['photo*', 'image*', 'picture*'],
  ['delete*', 'remov*', 'purge*', 'bin'],
  ['scorecard*', 'column*', 'layout*', 'page'],
];

/** Function words dropped before embedding (replaces the fake embedder's default list). */
export const SESSION_STOPWORDS: readonly string[] = [
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'in', 'on', 'at', 'of', 'to', 'for', 'and',
  'or', 'it', 'this', 'that', 'with', 'we', 'have', 'has', 'my', 'me', 'i', 'you', 'do', 'did',
  'does', 'any', 'about', 'what', 'which', 'so', 'as', 'by', 'from', 'if', 'not', 'why', 'show',
  'showed', 'after', 'when', 'each', 'its', 'their', 'them', 'they', 'one', 'now', 'yet', 'every',
];
```
**Impact:** Test data only. During planning, a scratch prototype computed the measured range (0.46..0.76): real `ts_rank` from pgvector Postgres 16 and the fake embedder with exactly this lexicon and these stopwords. Step 7 re-measures it through the real `searchSessions`.

### Step 7: The labelled proof of `BLEND.related`
**File:** `tests/integration/sessions.relatedEvidence.int.test.ts` (new)
**Code:**
```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { toVectorLiteral } from '../../src/embeddings/repo.js';
import { BLEND, type BlendTuning } from '../../src/search/blend.js';
import { QueryVectorCache } from '../../src/search/queryVector.js';
import { searchSessions, type SessionSearchPage } from '../../src/sessions/search.js';
import {
  LABELLED_SESSIONS,
  LABELLED_SESSION_QUERIES,
  SESSION_LEXICON,
  SESSION_STOPWORDS,
  type LabelledSessionQuery,
} from '../fixtures/semantic/sessionsLabelled.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'int-host';
const NOW = new Date('2026-11-01T00:00:00.000Z');
let db: Db;
let embedder: FakeEmbedder;

const sessionId = (key: string): string => `lab-${key}`;
const daysBefore = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

async function seed(): Promise<void> {
  for (const [i, s] of LABELLED_SESSIONS.entries()) {
    const id = sessionId(s.key);
    const last = daysBefore(s.ageDays);
    const started = daysBefore(s.ageDays + 1 / 24);
    await db.execute(sql`
      insert into cc_sessions (session_id, node_id, host, repo, cwd, name, first_prompt, last_prompt, prompts, summary,
        started_at, last_active_at, created_at, updated_at)
      values (${id}, ${`L${i}-0${i}`}, ${HOST}, 'mcp-notes', '/tmp', null, ${s.prompts[0] ?? null}, ${s.prompts[s.prompts.length - 1] ?? null},
        ${JSON.stringify(s.prompts.map((text) => ({ text, at: null })))}::jsonb, ${s.summary},
        ${started}::timestamptz, ${last}::timestamptz, ${last}::timestamptz, ${last}::timestamptz)
    `);
    await db.execute(sql`
      insert into cc_session_embeddings (session_id, sha, model, embedding, embedded_at, created_at, updated_at)
      values (${id}, 'sha', ${embedder.model}, ${toVectorLiteral(embedder.vectorFor(s.summary))}::vector,
        ${last}::timestamptz, ${last}::timestamptz, ${last}::timestamptz)
    `);
    for (const [n, text] of s.replies.entries()) {
      const seq = n + 1;
      await db.execute(sql`
        insert into cc_session_prompts (session_id, seq, at, text, truncated)
        values (${id}, ${seq}, ${last}::timestamptz, ${s.prompts[n] ?? 'go on'}, false)
      `);
      await db.execute(sql`
        insert into cc_session_replies (session_id, seq, at, text, truncated)
        values (${id}, ${seq}, ${last}::timestamptz, ${text}, false)
      `);
      await db.execute(sql`
        insert into cc_session_reply_embeddings (session_id, seq, sha, model, embedding, embedded_at, updated_at)
        values (${id}, ${seq}, encode(sha256(convert_to(${text}, 'UTF8')), 'hex'), ${embedder.model},
          ${toVectorLiteral(embedder.vectorFor(text))}::vector, ${last}::timestamptz, ${last}::timestamptz)
      `);
    }
  }
}

beforeAll(async () => {
  await migrateTestDb();
  db = openTestDb();
  embedder = createFakeEmbedder({ lexicon: SESSION_LEXICON, stopwords: SESSION_STOPWORDS });
  await truncateAll(db);
  await seed();
});

afterAll(async () => {
  await truncateAll(db);
  await closeTestDb(db);
});

async function search(query: string, tuning: BlendTuning = BLEND): Promise<SessionSearchPage> {
  return searchSessions({ db, embedder, host: HOST, queryVectors: new QueryVectorCache() }, query, {}, { now: NOW, tuning });
}

/** Labelled queries whose answer does not rank first under `tuning`. */
async function failures(tuning: BlendTuning): Promise<LabelledSessionQuery[]> {
  const out: LabelledSessionQuery[] = [];
  for (const q of LABELLED_SESSION_QUERIES) {
    const page = await search(q.query, tuning);
    if (page.sessions[0]?.session_id !== sessionId(q.answer)) out.push(q);
  }
  return out;
}

describe('BLEND.related on the labelled sessions (hybrid; real ts_rank, fake vectors)', () => {
  it('ranks every query\'s answer first with BLEND as shipped', async () => {
    expect((await failures(BLEND)).map((q) => q.query)).toEqual([]);
  });

  it('without a discount (related = 1) a chatty reply beats a session whose own summary answers', async () => {
    const failed = await failures({ ...BLEND, related: 1 });
    expect(failed.filter((q) => q.kind === 'over-match').length).toBeGreaterThan(0);
  });

  it('with too strong a discount (related = 0.3) the only session whose reply answers is buried', async () => {
    const failed = await failures({ ...BLEND, related: 0.3 });
    expect(failed.filter((q) => q.kind === 'reply-only').length).toBeGreaterThan(0);
  });

  it('BLEND.related sits strictly inside one contiguous passing range', async () => {
    const passing: number[] = [];
    for (let i = 0; i <= 20; i += 1) {
      const related = i / 20;
      if ((await failures({ ...BLEND, related })).length === 0) passing.push(i);
    }
    expect(passing.length, 'no value of related passes every labelled query').toBeGreaterThan(0);
    const lo = passing[0]!;
    const hi = passing[passing.length - 1]!;
    expect(passing, `passing related values (x/20): ${passing.join(', ')}`).toEqual(
      Array.from({ length: hi - lo + 1 }, (_, k) => lo + k),
    );
    expect(BLEND.related).toBeGreaterThan(lo / 20);
    expect(BLEND.related).toBeLessThan(hi / 20);
  });

  it('lists the replies a hit matched through, with the passage around the match', async () => {
    const quokka = await search('quokka');
    expect(quokka.sessions[0]?.session_id).toBe(sessionId('quokka-reply'));
    expect(quokka.sessions[0]?.via_replies).toEqual([{ seq: 1, excerpt: expect.stringContaining('quokka') }]);

    const wifi = await search('connection problems after waking the laptop');
    expect(wifi.sessions[0]?.via_replies.map((r) => r.seq)).toEqual([1]);

    const photo = await search('photo delete');
    expect(photo.sessions[0]?.session_id).toBe(sessionId('photo-own'));
    expect(photo.sessions[0]?.via_replies).toEqual([]);
    expect(photo.sessions.find((s) => s.session_id === sessionId('photo-chatty'))?.via_replies.map((r) => r.seq)).toEqual([1]);

    const scorecard = await search('adversarial zero trades');
    const chatty = scorecard.sessions.find((s) => s.session_id === sessionId('adv-scorecard'));
    expect(chatty?.via_replies.length).toBe(3);
    expect(chatty?.via_replies.every((r) => /trades/i.test(r.excerpt))).toBe(true);
  });
});
```
**Impact:**
- The test runs about 115 searches against the local Docker DB, which takes a few seconds.
- If the sweep's measured range differs from the 0.46..0.76 written in `BLEND`'s comment, update the comment to the measured `lo/20..hi/20` from the assertion message. Never move 0.6 outside the measured range.
- If the measured range does not contain 0.6, stop. Re-tune within it and write down why.

### Step 8: Replies in the existing search integration test
**File:** `tests/integration/sessions.search.int.test.ts` (append after the last `});` at line 166; phase 1 kept the file byte for byte). Extend the existing import on line 5 to `import { SESSIONS_SEMANTIC_OFF_FALLBACK, VIA_REPLIES_MAX, searchSessions } from '../../src/sessions/search.js';`.
**Code (append):**
```ts
describe('searchSessions: Claude\'s replies count as related text', () => {
  async function insertReply(v: { sessionId: string; seq: number; text: string; embed?: boolean; embedText?: string; model?: string }): Promise<void> {
    await db.execute(sql`
      insert into cc_session_prompts (session_id, seq, at, text, truncated)
      values (${v.sessionId}, ${v.seq}, now(), ${`prompt ${v.seq}`}, false)
    `);
    await db.execute(sql`
      insert into cc_session_replies (session_id, seq, at, text, truncated)
      values (${v.sessionId}, ${v.seq}, now(), ${v.text}, false)
    `);
    if (v.embed !== false) {
      const made = v.embedText ?? v.text;
      await db.execute(sql`
        insert into cc_session_reply_embeddings (session_id, seq, sha, model, embedding, embedded_at, updated_at)
        values (${v.sessionId}, ${v.seq}, encode(sha256(convert_to(${made}, 'UTF8')), 'hex'), ${v.model ?? embedder.model},
          ${toVectorLiteral(embedder.vectorFor(made))}::vector, now(), now())
      `);
    }
  }

  it('hybrid: a word only a reply has finds its session, listed in via_replies with the passage', async () => {
    await insertReply({ sessionId: 's-other', seq: 1, text: 'The wombat cache was stale because its key ignored the repo; it is keyed by repo now.' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'wombat');
    expect(page.mode).toBe('hybrid');
    expect(page.sessions[0]?.session_id).toBe('s-other');
    expect(page.sessions[0]?.via_replies).toEqual([{ seq: 1, excerpt: expect.stringContaining('wombat') }]);
    expect(page.sessions[0]?.via_notes).toEqual([]);
  });

  it('text mode and no embedder: reply words rank the session too', async () => {
    await insertReply({ sessionId: 's-meaning', seq: 1, text: 'wombat flag removed', embed: false });
    const text = await searchSessions({ db, embedder, host: HOST }, 'wombat', {}, { mode: 'text' });
    expect(text.sessions.map((s) => s.session_id)).toEqual(['s-meaning']);
    expect(text.sessions[0]?.via_replies.map((r) => r.seq)).toEqual([1]);
    const fallback = await searchSessions({ db, embedder: null, host: HOST }, 'wombat');
    expect(fallback.fallback).toBe(SESSIONS_SEMANTIC_OFF_FALLBACK);
    expect(fallback.sessions[0]?.via_replies.map((r) => r.seq)).toEqual([1]);
  });

  it('text mode: a session whose own text matches stays above one whose reply says the same', async () => {
    await insertReply({ sessionId: 's-other', seq: 1, text: 'Wall photo delete button added to the editor.', embed: false });
    const page = await searchSessions({ db, embedder, host: HOST }, 'photo delete', {}, { mode: 'text' });
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-literal', 's-other']);
  });

  it('hybrid: meaning only a reply has finds its session; the session whose own text answers stays first', async () => {
    await insertReply({ sessionId: 's-literal', seq: 1, text: 'authentication failed again after suspend on the thinkpad' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'auth failures after resume');
    expect(page.sessions[0]?.session_id).toBe('s-meaning');
    expect(page.sessions.find((s) => s.session_id === 's-literal')?.via_replies.map((r) => r.seq)).toEqual([1]);
  });

  it('ignores a reply vector made from older text or by another model', async () => {
    await insertReply({ sessionId: 's-other', seq: 1, text: 'leaderboard copy tweaks', embedText: 'authentication failed after suspend' });
    await insertReply({ sessionId: 's-other', seq: 2, text: 'authentication failed after suspend', model: 'other/model' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'auth failures after resume');
    expect(page.sessions.map((s) => s.session_id)).not.toContain('s-other');
  });

  it('respects the repo filter and lists at most VIA_REPLIES_MAX replies, best first', async () => {
    await insertReply({ sessionId: 's-meaning', seq: 1, text: 'quokka' });
    await insertReply({ sessionId: 's-meaning', seq: 2, text: 'quokka quokka quokka' });
    await insertReply({ sessionId: 's-meaning', seq: 3, text: 'quokka quokka' });
    await insertReply({ sessionId: 's-meaning', seq: 4, text: 'quokka again' });
    const page = await searchSessions({ db, embedder, host: HOST }, 'quokka');
    const via = page.sessions[0]?.via_replies ?? [];
    expect(via).toHaveLength(VIA_REPLIES_MAX);
    expect(via[0]?.seq).toBe(2);
    expect(via.every((r) => r.excerpt.includes('quokka'))).toBe(true);
    expect((await searchSessions({ db, embedder, host: HOST }, 'quokka', { repo: 'seer' })).sessions).toEqual([]);
  });

  it('own-text hits keep an empty via_replies', async () => {
    const page = await searchSessions({ db, embedder, host: HOST }, 'photo delete');
    expect(page.sessions[0]?.via_replies).toEqual([]);
  });
});
```
**Impact:** None of the existing tests in the file change. `truncateAll` in `beforeEach` clears the replies through phase 3's `truncateAll` (and `cc_sessions … cascade` clears them anyway).

### Step 9: `via_replies` through the read model
**File:** `src/sessions/readModel.ts:44` (import list), `:72-77`, `:151-160`, `:585`
**Code (line 44, inside the `from './view.js'` import list, after `type SearchNoteMatch,`):**
```ts
  type SearchReplyMatch,
```
**Code (replace lines 72-77):**
```ts
export interface SessionSearchHit {
  sessionId: string;
  score: number;
  /** The session's notes that matched the query (src/sessions/search.ts via_notes). Absent: none. */
  viaNotes?: SearchNoteMatch[];
  /** Claude's replies in the session that matched the query (src/sessions/search.ts via_replies). Absent: none. */
  viaReplies?: SearchReplyMatch[];
}
```
**Code (replace lines 150-160, `phase6Search`):**
```ts
/** Phase 6's hybrid session search. */
function phase6Search(db: Db, embedder: Embedder | null): SessionSearchFn {
  return async ({ query, repo, limit }) => {
    const res = await searchSessions({ db, embedder }, query, { limit, ...(repo !== null ? { repo } : {}) });
    return {
      mode: res.mode,
      fallback: res.fallback ?? null,
      hits: res.sessions.map((h) => ({ sessionId: h.session_id, score: h.score, viaNotes: h.via_notes, viaReplies: h.via_replies })),
    };
  };
}
```
**Code (replace the `flatMap` body's return, line 585):**
```ts
      : [
          {
            ...toGraphNode(row, ctx),
            score: Math.round(h.score * 10_000) / 10_000,
            via_notes: h.viaNotes ?? [],
            via_replies: h.viaReplies ?? [],
          },
        ];
```
**Impact:** `SearchPayload` hits gain `via_replies`. The injected-search API test ("hydrates the search hits") gets `[]`.

### Step 10: HTTP route doc (handler unchanged)
**File:** `src/http/sessionsApi.ts:123`
**Change:** The handler at `:185-190` already returns `searchNodes(...)` as it is, so `via_replies` reaches the wire with no code change. Only the route list comment changes. Replace line 123:
```ts
 * GET  /api/sessions/search?q=&repo=&limit=    hits carry via_notes and via_replies
```

### Step 11: MCP tool description, output, server instructions
**File:** `src/mcp/sessionTools.ts:52-56` (the `description:` string) and `:97`
**Code (replace the `description:` value):**
```ts
      description:
        "Find the user's past Claude Code sessions (both laptops) by meaning and words in their summaries, names, titles, prompts and commit messages, in the notes saved from or linked to each session, and in what Claude replied to each prompt, e.g. \"when did I fix photo delete in the wall?\". " +
        'Optional repo narrows to one repository (e.g. "mcp-notes"). Returns { query, mode, fallback, hits: [{ node_id, repo, title, started_at, last_active_at, host, available, live, status, parent_node_id, summary, via_notes, via_replies, score, url }] }, best first. ' +
        'via_notes lists the session\'s notes that matched ({ id, excerpt }, note ids like A-B32). via_replies lists Claude\'s replies in that session that matched ({ seq, excerpt }: seq is the number of the prompt the reply answered, excerpt the passage around the match). Both are best first, at most 3, and empty when the session matched on its own text. A match through a note or a reply counts a little less than the same match in the session\'s own summary or prompts. ' +
        'fallback set means meaning search was unavailable and only word matches came back. Then call session_get(node_id) for the full record.',
```
**Code (line 97, after `via_notes: h.via_notes,`):**
```ts
              via_replies: h.via_replies,
```
**File:** `src/mcp/instructions.ts:59`
**Change:** inside the template string, replace exactly
`sessions_search(query, repo?) finds sessions by meaning and words in their summaries, names, titles and prompts ("when did I work on photo delete in the wall?").`
with
`sessions_search(query, repo?) finds sessions by meaning and words in their summaries, names, titles, prompts and commit messages, in the notes saved from or linked to them (listed per hit in via_notes) and in what Claude replied to each prompt (via_replies: { seq, excerpt }, seq being the number of the prompt the reply answered) ("when did I work on photo delete in the wall?").`
**Impact:** The MCP test that asserts `getInstructions()` contains `'Sessions.'` still passes.

### Step 12: Projects chat block and system prompt
**File:** `src/chat/context.ts:107-115`
**Code (replace `renderProjectBlock`):**
```ts
export function renderProjectBlock(project: string): string {
  const repo = neutralize(project);
  return [
    '<project>',
    `repo: ${repo}`,
    `The owner is asking from the page of the repository "${repo}" in the wall's Projects view. Their questions are about the Claude Code sessions run in that repository: find them with sessions_search restricted to repo "${repo}" (it also matches the notes saved from or linked to each session, listed in via_notes, and what Claude replied to each prompt in it, listed in via_replies with the number of the prompt each reply answered), read one with session_get before you describe it, and quote each session by its node id (like A0-3G) and each note you rely on by its note id (like A-B32). When a reply excerpt is your evidence, quote it and say which session and prompt it came from (for example "A0-3G, prompt 4").`,
    '</project>',
  ].join('\n');
}
```
**File:** `src/chat/prompt.ts:41`
**Change:** In the `<project>` paragraph, after the sentence `Find sessions with sessions_search, passing that repository as repo, and read the ones you rely on with session_get before you describe them.`, insert:
` A hit may have matched on a note of that session (via_notes) or on what Claude replied in it (via_replies, { seq, excerpt }, seq being the number of the prompt the reply answered) rather than on its summary or prompts. When you rely on a reply, quote its excerpt and name its session and prompt (A0-3G, prompt 4); a session whose own summary answers the question is stronger evidence than one that only mentions it in a reply or a note, so say which it was.`
**File:** `tests/unit/chat-project.test.ts:38` and `:66`
**Code (after line 38, `expect(block).toContain('repo "mcp-notes"');`):**
```ts
    expect(block).toContain('via_notes');
    expect(block).toContain('via_replies');
```
**Code (after line 66, `expect(prompt).toContain('A0-3G');`):**
```ts
    expect(prompt).toContain('via_replies');
    expect(prompt).toContain('prompt 4');
```
**Impact:** The project system prompt grows by about 450 characters. No test pins its length.

### Step 13: MCP and HTTP integration assertions
**File:** `tests/integration/sessions.mcp.int.test.ts:77-82`
**Change:** Widen the `callJson` type in `'sessions_search returns hits with wall links'` to `{ mode: string; hits: Array<{ node_id: string; url: string; summary: string; via_notes: unknown[]; via_replies: unknown[] }> }`, and after the `summary` assertion add:
```ts
    expect(res.hits[0]!.via_notes).toEqual([]);
    expect(Array.isArray(res.hits[0]!.via_replies)).toBe(true);
```
**File:** `tests/integration/sessions.api.int.test.ts:540-545` (`'uses phase 6 search for real …'`)
**Change:** after `expect(body.hits.map((x) => x.node_id)).toContain('A0-3G');` add:
```ts
    expect(body.hits.every((x) => Array.isArray(x.via_notes) && Array.isArray(x.via_replies))).toBe(true);
```
and in `'hydrates the search hits in rank order (injected search)'`, after the score assertion, add:
```ts
    expect(body.hits.map((x) => x.via_replies)).toEqual([[], []]);
```
(Phase 3 may make the seeded transcript produce replies, so the MCP test asserts the shape of `via_replies`, not its contents.)

### Step 14: Docs
**File:** `README.md`. Phase 2's paragraph under "### Summaries and search" (it ends `Without OPENROUTER_API_KEY session search is words only and says so.`, around line 692 after phase 2). Insert this new paragraph after it, before `### Resume from the wall`:
```markdown
Claude's replies are search context too. For each prompt the daemon keeps what Claude answered:
the text after the turn's last tool call, not the narration between tool calls and not subagents.
Replies are redacted like prompts, get their own full-text index, and are embedded one by one in
the background on the machine that ran the session. Both machines can search them. A session's
notes and replies count as related evidence: a session is ranked by the better of its own
summary, prompts and commits and of its notes' and replies' best, which counts `BLEND.related`
(0.6) times as much. A session whose own summary answers the question therefore stays above one
that only repeats its words in a long reply. Each hit lists what it matched through in
`via_notes` and `via_replies`. The Projects chat quotes those excerpts with the session's node id
and the prompt number. There is no separate search box: ask in the Projects chat.
```
**File:** `README.md:1039` (MCP table row; keeps phase 2's wording). Replace the whole row with:
```markdown
| `sessions_search` | Claude Code sessions by meaning and by words over their summaries, names, prompts and commit messages, and over the notes saved from or linked to each session and Claude's replies in it, blended like `search`; filter by `repo`. Each hit has its node id, repo, times, summary, `via_notes` (`[{ id, excerpt }]`) and `via_replies` (`[{ seq, excerpt }]`, `seq` = the prompt the reply answered), each best first, at most 3, `[]` when none matched. Says `fallback` when only words were used |
```
**File:** `README.md:1130` (HTTP table row). Replace with:
```markdown
| `GET /api/sessions/search?q=&repo=` | Session search, blended like note search, with `fallback`; each hit carries `via_notes` and `via_replies` like the MCP tool |
```
**File:** `CLAUDE.md:41`. Insert this sentence immediately before ``Transcripts, `session_transcript` and resume work only on the owning host`` (after phase 2's commit sentence and phase 3's `cc_session_replies` sentence):
```markdown
`src/sessions/replyEmbeddings.ts` embeds each reply in the background into `cc_session_reply_embeddings` (current = sha256 of the stored text + model; owning host only; never blocks ingest). `searchSessions` (`src/sessions/search.ts`) gathers candidates from `HYBRID_SOURCES` / `TEXT_SOURCES` (session text, session vector, node id, notes, replies) and merges them in `mergeCandidates`. Note and reply evidence counts `BLEND.related` times the session's own (`src/search/blend.ts`, proven by `tests/fixtures/semantic/sessionsLabelled.ts` in `tests/integration/sessions.relatedEvidence.int.test.ts`). Hits list it in `via_notes` / `via_replies`. To add search context, write one `CandidateSource`.
```
**File:** `.claude/skills/verify-notesd/features/projects.md`
**Change 1 (Sub-features):** replace the bullet that starts `- Session search matches a session's notes too` (5 lines) with the two bullets below. Phase 2's commit bullet, inserted after the notes bullet, stays where it is, after these two.
```markdown
- Session search matches a session's notes too (made ∪ linked, live notes only): a word or meaning
  only a session's note has finds that session, and the hit lists those notes in `via_notes`
  (`[{ id, excerpt }]`, best first, at most 3; `[]` when no note matched). Same in text mode. MCP
  `sessions_search` and `GET /api/sessions/search` both carry `via_notes`.
- Session search matches Claude's replies too (`cc_session_replies`, one per prompt: what Claude
  said after the turn's last tool call). A word or meaning only a reply has finds that session, and
  the hit lists those replies in `via_replies` (`[{ seq, excerpt }]`, where `seq` is the number of the
  prompt the reply answered and `excerpt` is the passage around the match; best first, at most 3;
  `[]` when none matched). Words work in every mode, including without a key. Meaning needs the reply's
  current vector (`cc_session_reply_embeddings`, filled in the background by the owning host). Note
  and reply evidence counts `BLEND.related` (0.6) times the session's own, so a session whose own
  summary or prompts answer ranks above one that only repeats the words in a long reply. MCP
  `sessions_search` and `GET /api/sessions/search` carry `via_replies`; the Projects chat agent is
  told to quote a reply excerpt with its node id and prompt number. No UI change (R5): there is no
  search box on `/projects`; the Projects chat (query pill bar) is the way in.
```
**Change 2 (Driving it with verify.sh):** add this block just before `Summary requests.` (after phase 2's "Commit messages in search." block):
````markdown
Replies in search. Seed one reply with a word nothing else has (fixture replies are real ingest
output, but a seeded row keeps the word unique). Prompt 9001 is far past any fixture prompt:
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions
SID=5e55a001-0000-4000-8000-000000000001
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r --arg s "$SID" '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S")
$V exec RUN "insert into cc_session_prompts (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'why is the cache stale?', false) on conflict do nothing"
$V exec RUN "insert into cc_session_replies (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'The wombat cache was stale because its key ignored the repo. I keyed it by repo and node id, and the stale entries are gone.', false)"
$V mcp RUN sessions_search '{"query":"wombat"}'     # hits[0].node_id NODE, via_replies [{seq: 9001, excerpt "…wombat…"}], mode "text"
$V api RUN GET '/api/sessions/search?q=wombat'      # same via_replies
$V sql RUN "select session_id, seq, left(text, 60) from cc_session_replies order by session_id, seq"
```
With `--embed` (billed, a few embeddings) the reply worker gives row 9001 a vector within about a
minute (`select embedding is not null from cc_session_reply_embeddings where seq = 9001`). A
meaning-only query such as `"why did lookups return outdated data for another project"` then lists
NODE with `via_replies` seq 9001 in `mode: "hybrid"`. The weight itself is proven by
`tests/integration/sessions.relatedEvidence.int.test.ts`, not on a run.
````
**Impact:** Docs only. Phase 2 and phase 3 edit the same paragraphs at other anchors (reconciled: disjoint; keep their sentences as they are).

### Step 15: Run everything, then commit
```sh
cd /home/miftah/.worktrees/mcp-notes/session-search-context
npm run typecheck
npm test
npm run test:int
git diff --stat origin/main -- web/ | tail -1    # must print nothing (R5)
```
Commit the code, tests and docs together (`feat(sessions): Claude's replies as session search context, weighted related evidence`). Commit the regenerated golden snapshot separately (Step 5).

## Principles applied

- **Make illegal states unrepresentable:** related evidence reaches the blend as one optional `related: { textRank, similarity }` object, with no `viaRelated` flags. So there is no "flagged as related but carrying no value" state, and a candidate without related items (note search) cannot be discounted by accident.
- **Laziness protocol / reuse:**
  - Phase 1's `collectCandidates`, `mergeCandidates`, `relatedSourceRows` and `compareTextRanked` are used unchanged. Text mode gets the weight through one pure `withWeightedText` instead of a second comparator.
  - The "current reply vector" predicate is phase 4's `isCurrentReplyEmbeddingSql`, not a copy, which is why the SQL leaves the reply tables unaliased.
  - No prompts-payload or web change.
- **Build the lever:**
  - The weight's value comes from a sweep over `related` = 0..1 through the real `searchSessions`, with assertions at 1 and 0.3, instead of a number a reviewer has to trust.
  - The golden snapshot is first re-run at `related: 1` against phase 1's committed snapshot (Step 5). That proves the weight is the only behavior change before the snapshot is regenerated.
- **Boundary discipline:** a replies source's `items` jsonb is parsed once (`viaReplySeqs`). Excerpts are produced once per page in SQL (`ts_headline`) and normalized by the existing `excerpt()`. Nothing downstream re-validates them.
- **Test behavior, not implementation:** the labelled test and the new search tests assert only first hits, `via_replies` and the passage, through the public `searchSessions`. The blend tests use the exported pure functions.
- **Sequence into verifiable units:**
  - blend + its unit tests (Step 1-2) can fail on their own.
  - search + golden identity (Step 4-5) fails if anything but the weight moved.
  - the labelled proof (Step 6-7) fails if the value is wrong.
  - the wiring tests (Step 9-13) fail if `via_replies` does not reach MCP, HTTP or the chat prompt.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-search-context && npm run typecheck`
**Tests:** `npm test && npm run test:int`. The new and changed test files are:
- `tests/unit/search.blend.test.ts`
- `tests/unit/chat-project.test.ts`
- `tests/integration/sessions.relatedEvidence.int.test.ts`
- `tests/integration/sessions.search.int.test.ts`
- `tests/integration/sessions.search.golden.int.test.ts` (regenerated snapshot)
- `tests/integration/sessions.mcp.int.test.ts`
- `tests/integration/sessions.api.int.test.ts`

**Proof:** a real throwaway daemon finds a session by a word only one of Claude's replies has, over MCP and HTTP, and lists the reply in `via_replies`. With real embeddings it finds the session by meaning. The labelled fixture fixes the weight.
- Harness: `.claude/skills/verify-notesd` (`scripts/verify.sh`), run from `/home/miftah/.worktrees/mcp-notes/session-search-context`. `V=.claude/skills/verify-notesd/scripts/verify.sh`.
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md` (updated in Step 14: replies bullet, notes bullet, "Replies in search").
- Journeys:
  1. **A word only a reply has finds its session (text mode, no billing).**
     ```sh
     cd /home/miftah/.worktrees/mcp-notes/session-search-context; V=.claude/skills/verify-notesd/scripts/verify.sh
     eval "$(NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions | grep -E '^(RUN|URL|EVIDENCE)=')"
     SID=5e55a001-0000-4000-8000-000000000001
     S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
     NODE=$(jq -r --arg s "$SID" '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S"); echo "NODE=$NODE"
     $V exec "$RUN" "insert into cc_session_prompts (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'why is the cache stale?', false) on conflict do nothing"
     $V exec "$RUN" "insert into cc_session_replies (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'The wombat cache was stale because its key ignored the repo. I keyed it by repo and node id, and the stale entries are gone.', false)"
     $V mcp "$RUN" sessions_search '{"query":"wombat"}' | sed 1d | jq -e --arg n "$NODE" '.mode == "text" and .fallback != null and .hits[0].node_id == $n and (.hits[0].via_replies | length) == 1 and .hits[0].via_replies[0].seq == 9001 and (.hits[0].via_replies[0].excerpt | contains("wombat")) and .hits[0].via_notes == []'
     $V api "$RUN" GET '/api/sessions/search?q=wombat'
     curl -sf "$URL/api/sessions/search?q=wombat" | jq -e --arg n "$NODE" '.hits[0].node_id == $n and .hits[0].via_replies[0].seq == 9001 and (.hits[0].via_replies[0].excerpt | contains("wombat"))'
     $V sql "$RUN" "select session_id, seq, left(text, 60) from cc_session_replies order by session_id, seq"
     $V note "$RUN" "phase 5: a word only in Claude's reply finds its session over MCP and HTTP; via_replies seq 9001"
     ```
     Passes when both `jq -e` lines print `true` (exit 0). The `sql` evidence lists row 9001 next to the rows phase 3's ingest wrote for the fixtures. Keep the run up for the neighbor check.
  2. **Neighbor: notes still reach `via_notes`; an own- or note-only match has `via_replies: []`.** On the same run:
     ```sh
     LINKED=$($V mcp "$RUN" create '{"body":"saved elsewhere #verify"}' | sed 1d | jq -r .note.id)
     $V mcp "$RUN" link_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}"
     $V mcp "$RUN" sessions_search '{"query":"saved elsewhere"}' | sed 1d | jq -e --arg n "$NODE" --arg id "$LINKED" '.hits[0].node_id == $n and ([.hits[0].via_notes[].id] | index($id)) != null and .hits[0].via_replies == []'
     $V down "$RUN"
     ```
     Passes when `jq -e` prints `true`.
  3. **By meaning, with real embeddings (billed: OpenRouter embeddings for the fixture replies plus 1 query, well under $0.01).**
     ```sh
     eval "$(NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --embed | grep -E '^(RUN|URL|EVIDENCE)=')"
     SID=5e55a001-0000-4000-8000-000000000001
     S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
     NODE=$(jq -r --arg s "$SID" '.nodes[] | select(.session_id==$s) | .node_id' <<<"$S")
     $V exec "$RUN" "insert into cc_session_prompts (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'why is the cache stale?', false) on conflict do nothing"
     $V exec "$RUN" "insert into cc_session_replies (session_id, seq, at, text, truncated) values ('$SID', 9001, now(), 'The wombat cache was stale because its key ignored the repo. I keyed it by repo and node id, and the stale entries are gone.', false)"
     for i in $(seq 36); do $V sql "$RUN" "select 'EMBEDDED' as state from cc_session_reply_embeddings where session_id = '$SID' and seq = 9001 and embedding is not null" | grep -q EMBEDDED && break; sleep 5; done
     $V mcp "$RUN" sessions_search '{"query":"why did lookups return outdated data for another project"}' | sed 1d | jq -e --arg n "$NODE" '.mode == "hybrid" and .fallback == null and any(.hits[]; .node_id == $n and ([.via_replies[].seq] | index(9001)) != null)'
     $V note "$RUN" "phase 5: meaning-only query reaches the session through its reply vector"
     $V down "$RUN"
     ```
     Passes when the `EMBEDDED` loop ends early and `jq -e` prints `true`. If the reply never gets a vector within 3 minutes, report `inconclusive (phase 4 worker did not embed)`, not a fail of this phase. Hybrid by meaning is also proven unbilled by `tests/integration/sessions.search.int.test.ts` ("meaning only a reply has").
  4. **The weight is proven, and is the only behavior change.**
     ```sh
     cd /home/miftah/.worktrees/mcp-notes/session-search-context
     npm run test:int -- tests/integration/sessions.relatedEvidence.int.test.ts       # 5 passed
     SNAP=tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap
     OLD=$(git log --format=%H -- "$SNAP" | sed -n 2p)        # phase 1's snapshot commit
     cp "$SNAP" "${TMPDIR:-/tmp}/golden.new.snap" && git show "$OLD:$SNAP" > "$SNAP"
     sed -i 's/^  related: 0\.6,$/  related: 1,/' src/search/blend.ts
     npm run test:int -- tests/integration/sessions.search.golden.int.test.ts; rc=$?
     sed -i 's/^  related: 1,$/  related: 0.6,/' src/search/blend.ts
     cp "${TMPDIR:-/tmp}/golden.new.snap" "$SNAP"
     git diff --quiet -- src/search/blend.ts "$SNAP" && echo RESTORED; echo "golden-at-1 rc=$rc"
     ```
     Passes when the labelled file reports 5 passed, `golden-at-1 rc=0`, and `RESTORED` prints. The last two together show that phase 1's snapshot still holds at `related: 1`, so the replies source and wiring changed nothing else.
  5. **The chat is told to quote replies (not driven: chat bills a Claude run).** `npx vitest run tests/unit/chat-project.test.ts` passes, including `toContain('via_replies')` on both the `<project>` block and the system prompt.
- Neighbor check:
  - Note search shares `blend.ts`: `npx vitest run tests/unit/search.blend.test.ts` and `npm run test:int -- tests/integration/search.hybrid.int.test.ts` pass unchanged.
  - Session notes: journey 2.
  - UI untouched (R5): `git diff --stat origin/main -- web/` prints nothing.
- Cost: journey 3 only (OpenRouter embeddings, under $0.01). No chat and no Haiku (`NOTESD_CLAUDE_BIN=/nonexistent/claude`).

**Exit criteria:**
- A word or meaning only in a reply finds its session with `via_replies` (journeys 1 and 3, `sessions.search.int.test.ts`).
- The labelled fixture passes at `BLEND.related = 0.6` and fails at 1 (over-match) and at 0.3 (reply-only). 0.6 lies strictly inside the measured passing range.
- Phase 1's golden snapshot holds at `related: 1`.
- MCP and HTTP carry `via_replies`. The chat block and prompt mention it.
- README, CLAUDE.md and `features/projects.md` are updated.
- `typecheck`, `npm test` and `npm run test:int` pass.
- No file under `web/` changed.

## Handoffs

- **Reconciler / Phase 1:**
  - Phase 5 does not read `MergedCandidate.text.from` / `.similarity.from` for the hybrid weight, as phase 1's handoff suggested. It reads `c.row.*` (own) and `c.related.*` separately, because the right comparison is `max(own, w × related)`, not a discount on the raw winner (Step 1). Phase 1 needs no change. `from` stays as diagnostic data, and text mode overwrites `text` via `withWeightedText`.
  - Reply `items` are `[{ seq }]`; excerpts are fetched for the shown page only (a reply is up to 16k characters and hundreds can match). Reconciled: phase-1.md's contract and handoff now say the same.
- **Phase 4:** phase 5 imports `isCurrentReplyEmbeddingSql` from `src/sessions/replyEmbeddings.ts`; reconciled as a dependency (`Depends on: 1, 3, 4`).
- **Reconciler / Phases 2 and 3 docs:** `README.md:686-692`, `CLAUDE.md:41` and `features/projects.md` get sentences from phases 2, 3 and 5. Phase 5 inserts next to theirs and does not rewrite them. The README `sessions_search` row is rewritten whole and keeps phase 2's "commit messages". Phase 5's sessionTools description and `instructions.ts` clause also say "commit messages": that is a doc string for R1, written here because phase 5 owns that sentence. Drop the two words if phase 2 is dropped.
- **Phase 3 (R2):** the Proof journeys seed reply row 9001 because the current fixture transcripts' final assistant texts are short ("Done: the plan is written."). If phase 3 adds a fixture with a distinctive reply, journey 1 could use it instead of seeding. Left to phase 3.
- **Later (not in this set):** re-check `BLEND.related` against `openai/text-embedding-3-small` in `tests/live/embeddings.live.test.ts`, the way `minSimilarity` was. It is billed, so it is not done here.
- **Known limit, documented, not fixed:** in text mode (no key, or `mode: "text"`) the purge session's long reply still edges past the delete-button session for "photo delete" (0.6 × 0.371 = 0.223 > 0.209). Text mode has no meaning signal to separate them. The labelled proof covers hybrid, the default.

## Rollback

`git revert` phase 5's feature commit and its golden-snapshot commit. That restores phase 1's `searchSessions` (no replies source, no weight), `blend.ts` without `related`, and the wire without `via_replies`. No schema, migration or data is touched (the reply tables are phase 3's). The docs revert with the commit.
