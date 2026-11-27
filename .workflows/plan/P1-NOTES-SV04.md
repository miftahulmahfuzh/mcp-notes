> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/stream-play-log/PLAN.md` phase 4. Source: `.workflows/plan/stream-play-log/phase-4.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 4: Sessions search says when it has no vectors

**Plan set:** `STREAM_PLAY_LOG_PLAN.md`
**Analysis:** `.workflows/analyze/20261127-081756-PL7K_code_analyzer.md`
**Satisfies:** R3 — `sessions_search` stops answering `mode: "hybrid"` with no `fallback` while it is in fact matching on words only
**Criteria:** R3.1, R3.2
**Depends on:** none
**Difficulty:** EASY
**Package:** `src/sessions`

---

## Goal

Today `searchSessions` answers `mode: "hybrid"` with no `fallback` whenever an embedder is
configured, even though `cc_session_embeddings` holds no vector (the live store: 1,117 sessions,
0 vectors, because the summary worker waits for the Neon copy). After this phase, a hybrid
search whose embedder's model has no session vector at all answers through the text ranking with
`mode: "text"` and a new `fallback` sentence saying session vectors are not built yet. The check is
one `EXISTS` query made before the query is embedded, so no embedding call is paid for. Once a
single session has a vector of that model, search behaves exactly as today.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `SESSIONS_NO_VECTORS_FALLBACK` (exported string constant, `src/sessions/search.ts`, after `sessionEmbedFailedFallback`)
- `hasSessionVectors(db, model)` (module-private async function, `src/sessions/search.ts`, just above `searchSessions`)
**Signature changes:** none. `searchSessions`, `SessionSearchDeps`, `SessionSearchPage` keep their shapes; `fallback` gains one more possible value.
**Behaviour change:** `searchSessions` with `embedder !== null`, `opts.mode !== 'text'` and no row of `cc_session_embeddings` with `model = embedder.model and embedding is not null` → `textSearch(... SESSIONS_NO_VECTORS_FALLBACK)`, no embedder call. Reaches `GET /api/sessions/search` and MCP `sessions_search` (and the chat's use of it) through `phase6Search` in `src/sessions/readModel.ts:166` unchanged.
**Requires (from earlier phases):** nothing.
**Leaves alone (owned by others):** `src/background.ts` (the vector/summary wait for the import stays); notes search (`src/notes/service.ts`, `src/search/*`, including `src/search/blend.ts` weights); `src/mcp/sessionTools.ts` (its description already says "fallback set means meaning search was unavailable and only word matches came back", which covers the new case, so no `docs:gen`); `web/` (no web surface shows a sessions-search fallback, see Handoffs); everything stream (Phases 1–3) and reminders (Phase 5).

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/search.ts` | modify | new `SESSIONS_NO_VECTORS_FALLBACK` after line 36; new `hasSessionVectors` above `searchSessions` (line ~782); one early return in `searchSessions` after line 808; doc comment lines 789–792 |
| `tests/integration/sessions.search.int.test.ts` | modify | import line 5 (+ new import of `QueryVectorCache`); new `describe` block appended at the end of the file |
| `docs/guide/sessions.md` | modify | the paragraph at lines 203–206 ("Without `OPENROUTER_API_KEY` ...") gains the no-vectors case |
| `.claude/skills/verify-notesd/features/projects.md` | modify | one sub-feature bullet after line 27; one proof paragraph after line 220 |

## Implementation Steps

### Step 1: The fallback sentence
**File:** `src/sessions/search.ts:36` (insert after the closing `}` of `sessionEmbedFailedFallback`, before `export interface SessionSearchDeps`)
**Change:** add the exported constant. Its wording follows the two existing sentences ("..., so these are full-text results only: sessions that share words with the query.") so every fallback reads the same.
**Code:**
```ts

/**
 * Hybrid search asked for, an embedder configured, but no session has a vector of its model yet:
 * the summary worker waits for the copy of the old shared database (src/background.ts), or has
 * not reached any session. Matching would be on words only while saying `hybrid`, so say so.
 */
export const SESSIONS_NO_VECTORS_FALLBACK =
  'Session vectors are not built yet (they wait for the copy of the old shared database, or have not been made), so these are full-text results only: sessions that share words with the query.';
```
**Impact:** new export only; nothing reads it until Step 2.

### Step 2: The check and the early return
**File:** `src/sessions/search.ts:782` (insert directly above the doc comment of `searchSessions`, i.e. after the closing `}` of `textSearch`), and `src/sessions/search.ts:789-808` (doc comment and body of `searchSessions`)
**Change:**
1. Add `hasSessionVectors`. Same predicate as `currentEmbeddingOn` (line ~307: `e.model = ... and e.embedding is not null`), so "has a vector" means exactly "the session-vector source could return a similarity". No in-process cache (see Principles applied).
2. In `searchSessions`, after the `embedder === null` return and before `embedQuery`, return the text ranking with `SESSIONS_NO_VECTORS_FALLBACK` when the check is false.
3. Update the doc comment to list the new case.

**Code** (the new function, inserted above the `/** Hybrid search over cc_sessions. ...` comment):
```ts
/**
 * True when at least one session has a vector of `model` (the same test as currentEmbeddingOn).
 * One EXISTS, asked before the query is embedded so a store with no session vectors costs no
 * embedding call. Not cached: it is a single cheap query, and a cached answer could outlive a
 * truncate (tests) or a model change.
 */
async function hasSessionVectors(db: Db, model: string): Promise<boolean> {
  const res = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from cc_session_embeddings where model = ${model} and embedding is not null
    ) as found
  `);
  return res.rows[0]?.found === true;
}
```

**Code** (the full replacement of the doc comment and the head of `searchSessions`, from `/**` at line 782 through the line `let vector: number[];` at line 810; everything after `let vector: number[];` stays byte for byte):
```ts
/**
 * Hybrid search over cc_sessions. Signals: full-text rank on the generated tsvector, closeness
 * in meaning from cc_session_embeddings, the repo as a tag, recency of last activity, and an
 * exact node id. Candidates come from HYBRID_SOURCES. The notes saved from or linked to a
 * session, and Claude's replies in it, count as related evidence: the session competes with the
 * better of its own signal and its related items' best times BLEND.related, per signal. Hits
 * list the notes in via_notes and the replies in via_replies. Everything is blended by
 * src/search/blend.ts. Falls back to full text (TEXT_SOURCES, same weighting), with `fallback`
 * saying why, when there is no embedder, when no session has a vector of the embedder's model
 * yet (checked before the query is embedded, so nothing is paid for), or when the query cannot be
 * embedded in time. The cursor is an offset into whichever ranking produced the page.
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
  // No session vector of this model: hybrid would match on words only while saying hybrid.
  if (!(await hasSessionVectors(deps.db, embedder.model))) {
    return textSearch(deps, query, filter, offset, limit, tuning, SESSIONS_NO_VECTORS_FALLBACK);
  }

  let vector: number[];
```
**Impact:** with an embedder and no current session vector, `GET /api/sessions/search`, MCP `sessions_search` and the chat's sessions search answer `mode: "text"` with the new `fallback`, and no query embedding is made. With at least one vector, one extra `EXISTS` per hybrid search and otherwise no change. `opts.mode === 'text'` and `embedder === null` keep their earlier returns, so the order of checks is: text asked → no embedder → no vectors → embed fails. Every existing test still passes (audit below).

**Existing tests that call `searchSessions` with an embedder and expect `mode: "hybrid"` — audit (none needs a change):**

| Test | Why it still passes |
|---|---|
| `tests/integration/sessions.search.int.test.ts` (every hybrid case) | `beforeEach` seeds three sessions with `insertSession`, which inserts a `cc_session_embeddings` row of `embedder.model` (`embed` defaults to true) |
| `tests/integration/sessions.search.golden.int.test.ts` (snapshot) | `seed()` embeds every session except `g-noemb`; the hybrid snapshot keeps `mode: "hybrid"`, `fallback: null`. The snapshot file is unchanged |
| `tests/integration/sessions.relatedEvidence.int.test.ts` | `seed()` embeds every labelled session |
| `tests/integration/sessions.commitSearch.int.test.ts` (both hybrid cases) | each calls `embedAll(embedder)` (the summary worker, which writes vectors of `embedder.model`) before searching; the text cases pass `embedder: null` |
| `tests/integration/sessions.api.int.test.ts:563` and `:587` | the first injects `search`; the second runs the real search with the API harness's `embedder: null` (`tests/integration/helpers/api-harness.ts:57`), so it still gets `SESSIONS_SEMANTIC_OFF_FALLBACK` |
| `tests/integration/sessions.mcp.int.test.ts:77`, `sessions.forkWording.int.test.ts:33` | inject `search` through `SessionsReadOverrides`; `searchSessions` is not called |
| `tests/unit/sessions/searchMerge.test.ts` | pure functions only (`mergeCandidates`, `compareTextRanked`, `relatedSourceRows`) |

If the implementer finds a test this table misses that expects `hybrid` with no `cc_session_embeddings` row of the fake model, seed one vector (copy `insertSession`'s insert) rather than expecting the fallback, unless the test is about an empty store.

### Step 3: Integration tests for R3.1 and R3.2
**File:** `tests/integration/sessions.search.int.test.ts:5` (imports) and end of file (after the last `});` at line 244)
**Change:** import the new constant and `QueryVectorCache`; append one `describe` block. Each test starts from the file's `beforeEach` (three sessions, each with a vector of the fake model) and removes vectors to reach the state it needs. A fresh `QueryVectorCache` and `embedder.reset()` make "no embedding call" observable through `embedder.calls`.
**Code** (line 5 replaced, one import line added after it):
```ts
import { SESSIONS_NO_VECTORS_FALLBACK, SESSIONS_SEMANTIC_OFF_FALLBACK, VIA_REPLIES_MAX, searchSessions } from '../../src/sessions/search.js';
import { QueryVectorCache } from '../../src/search/queryVector.js';
```
**Code** (appended at the end of the file):
```ts

describe('searchSessions: no session vector of the embedder\'s model yet', () => {
  it('with no session vector at all: text mode, the no-vectors fallback, and no embedding call', async () => {
    await db.execute(sql`delete from cc_session_embeddings`);
    embedder.reset();
    const page = await searchSessions({ db, embedder, host: HOST, queryVectors: new QueryVectorCache() }, 'photo delete');
    expect(page.mode).toBe('text');
    expect(page.fallback).toBe(SESSIONS_NO_VECTORS_FALLBACK);
    expect(page.sessions.map((s) => s.session_id)).toEqual(['s-literal']);
    expect(embedder.calls).toEqual([]);
  });

  it('vectors of another model, or rows still waiting for their vector, count as none', async () => {
    await db.execute(sql`update cc_session_embeddings set model = 'other/model' where session_id = 's-literal'`);
    await db.execute(sql`update cc_session_embeddings set embedding = null where session_id <> 's-literal'`);
    embedder.reset();
    const page = await searchSessions({ db, embedder, host: HOST, queryVectors: new QueryVectorCache() }, 'auth failures after resume');
    expect(page.mode).toBe('text');
    expect(page.fallback).toBe(SESSIONS_NO_VECTORS_FALLBACK);
    // Words only: no session shares a word with the query.
    expect(page.sessions).toEqual([]);
    expect(embedder.calls).toEqual([]);
  });

  it('one session with a vector of the model is enough: hybrid, no fallback, meaning still finds it', async () => {
    await db.execute(sql`delete from cc_session_embeddings where session_id <> 's-meaning'`);
    embedder.reset();
    const page = await searchSessions({ db, embedder, host: HOST, queryVectors: new QueryVectorCache() }, 'auth failures after resume');
    expect(page.mode).toBe('hybrid');
    expect(page.fallback).toBeUndefined();
    expect(page.sessions[0]?.session_id).toBe('s-meaning');
    expect(embedder.calls).toHaveLength(1);
  });

  it('becomes hybrid as soon as the first vector lands (the answer is not cached while false)', async () => {
    await db.execute(sql`delete from cc_session_embeddings`);
    const before = await searchSessions({ db, embedder, host: HOST }, 'photo delete');
    expect(before.fallback).toBe(SESSIONS_NO_VECTORS_FALLBACK);
    await db.execute(sql`
      insert into cc_session_embeddings (session_id, sha, model, embedding, embedded_at, created_at, updated_at)
      values ('s-literal', 'sha', ${embedder.model}, ${toVectorLiteral(embedder.vectorFor('Wall photo delete button added to the editor.'))}::vector, now(), now(), now())
    `);
    const after = await searchSessions({ db, embedder, host: HOST }, 'photo delete');
    expect(after.mode).toBe('hybrid');
    expect(after.fallback).toBeUndefined();
    expect(after.sessions[0]?.session_id).toBe('s-literal');
  });

  it('mode text and no embedder are unchanged by an empty vector table', async () => {
    await db.execute(sql`delete from cc_session_embeddings`);
    const text = await searchSessions({ db, embedder, host: HOST }, 'leaderboard', {}, { mode: 'text' });
    expect(text.mode).toBe('text');
    expect(text.fallback).toBeUndefined();
    const off = await searchSessions({ db, embedder: null, host: HOST }, 'leaderboard');
    expect(off.fallback).toBe(SESSIONS_SEMANTIC_OFF_FALLBACK);
  });
});
```
**Impact:** test-only. `FakeEmbedder.calls` (`tests/helpers/fakeEmbedder.ts:127`) records each `embed` call; `vectorFor` is a pure helper and records nothing, and `reset()` (`:170`) clears it anyway. The `embedding is not null` column is nullable (rows are inserted with only `session_id, sha, model` in `tests/integration/sessions.schema.int.test.ts:117`).

### Step 4: The guide
**File:** `docs/guide/sessions.md:203-206`
**Change:** replace the paragraph that starts "Without `OPENROUTER_API_KEY`, session search is words only" with one that names both word-only cases and the new sentence's meaning.
**Code** (the whole replacement paragraph):
```markdown
Session search is words only in two cases, and then every word must appear and the result carries
`mode: "text"` and a `fallback` sentence saying which case it is: without `OPENROUTER_API_KEY`, and
while no session has a vector of the embedder's model yet ("Session vectors are not built yet ...").
The second is the state of a new local database until the copy of the old shared database has run
(the summary worker waits for it, see [architecture.md](architecture.md)) and the worker has
embedded a first session; it is checked before the query is embedded, so it costs no embedding
call, and search is hybrid again from the first vector on. Replies and notes are still searched by
their words. Reply vectors are made one by one in the background on the machine that ran the
session.
```
**Impact:** docs only. `npm run docs:check` (and `tests/unit/docs/reference.test.ts`) checks the link `architecture.md`, which exists at `docs/guide/architecture.md`. No generated reference changes: the MCP tool description and the HTTP route are unchanged.

### Step 5: The feature map
**File:** `.claude/skills/verify-notesd/features/projects.md:27` (after the "commit messages" sub-feature bullet) and `:220` (after the paragraph ending "`tests/integration/sessions.relatedEvidence.int.test.ts`, not on a run.")
**Change:** one sub-feature bullet and one proof paragraph.
**Code** (bullet, inserted after line 27):
```markdown
- Session search says when it has no vectors: with a key but no session vector of the embedder's
  model (`cc_session_embeddings`, model match, `embedding is not null`), `sessions_search` and
  `GET /api/sessions/search` answer `mode: "text"` with the fallback "Session vectors are not built
  yet ...", and no query embedding is made. One vector of the model is enough for `hybrid` again.
```
**Code** (paragraph, inserted after line 220, before "Summary requests."):
```markdown
No session vectors yet. A run without `--embed` has no embedder, so it shows the
"Meaning search is off" fallback, not this one. The no-vectors case (embedder set, no session
vector of its model) is proven by `tests/integration/sessions.search.int.test.ts`
("no session vector of the embedder's model yet"), with the fake embedder and no billing:
`npm run test:int -- tests/integration/sessions.search.int.test.ts -t "no session vector"`.
```

## Principles applied

- Laziness protocol: no in-process cache for the "vectors exist" answer, although the scope allows one once true. The check is one `EXISTS` on a ~1k-row table, and a process-wide cache keyed only by model would survive a truncate between integration tests and turn R3.1's tests order-dependent; Step 2's `hasSessionVectors` queries every time and its comment says why.
- Laziness protocol: no change to `src/mcp/sessionTools.ts` and no `docs:gen`: the tool description already says "fallback set means meaning search was unavailable and only word matches came back", which is true of the new case; and no web change, because no web code calls `/api/sessions/search`.
- Boundary discipline: the check sits in `searchSessions`, the one function `phase6Search` (HTTP, MCP, chat) calls, so every surface gets the fallback from one place, and uses the same predicate as `currentEmbeddingOn` so "has a vector" cannot disagree with what the vector source would return.
- Test behavior, not implementation: the new tests assert what a caller sees (`mode`, `fallback`, the hits) and that no embedding call was made (`FakeEmbedder.calls`, the paid boundary), not that `hasSessionVectors` ran.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (unit, incl. `tests/unit/docs/reference.test.ts`) and `npm run test:int -- tests/integration/sessions.search.int.test.ts tests/integration/sessions.search.golden.int.test.ts tests/integration/sessions.relatedEvidence.int.test.ts tests/integration/sessions.commitSearch.int.test.ts tests/integration/sessions.api.int.test.ts tests/integration/sessions.mcp.int.test.ts`; `npm run docs:check`
**Proof:** the real search function against real pgvector Postgres (the `test:int` containers) with the deterministic fake embedder; the throwaway daemon cannot reach the no-vectors-with-embedder state without billing (`--embed` keeps the real key and its summary worker embeds the fixture sessions within moments), so the criteria are proven by the integration suite, as the index's exit criteria for this phase say, and the harness runs the neighbor check.
- Harness: `.claude/skills/verify-notesd` (neighbor check only); criteria journeys run `scripts/test-int.sh` (`npm run test:int`, Docker Postgres, extra args go to vitest)
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md`
- Journeys:
  - **J1** · traces R3.1 — `npm run test:int -- tests/integration/sessions.search.int.test.ts -t "with no session vector at all"` → passes when vitest reports that 1 test passed: the page has `mode` `"text"`, `fallback` equal to `SESSIONS_NO_VECTORS_FALLBACK` (starts "Session vectors are not built yet"), hits `['s-literal']`, and `embedder.calls` is empty. Before Step 2 it fails with `mode` `"hybrid"`.
  - **J2** · traces R3.1 — `npm run test:int -- tests/integration/sessions.search.int.test.ts -t "count as none"` → passes when vitest reports 1 test passed: vectors of another model plus rows with a null embedding still give `mode` `"text"` with the no-vectors fallback and no embedding call.
  - **J3** · traces R3.2 — `npm run test:int -- tests/integration/sessions.search.int.test.ts -t "is enough"` and `npm run test:int -- tests/integration/sessions.search.int.test.ts -t "first vector lands"` → passes when both report 1 test passed: with one vector of the model the page is `mode` `"hybrid"`, `fallback` undefined, `s-meaning` first for a meaning-only query, one embedding call; and a search that fell back becomes hybrid right after one vector row is inserted.
  - **J4** · traces R3.2 — `npm run test:int -- tests/integration/sessions.search.golden.int.test.ts tests/integration/sessions.relatedEvidence.int.test.ts tests/integration/sessions.commitSearch.int.test.ts` → passes when every test passes with the golden snapshot file `tests/integration/__snapshots__/sessions.search.golden.int.test.ts.snap` unchanged (`git diff --exit-code tests/integration/__snapshots__/` exits 0): hybrid ranking with vectors is exactly today's.
- Neighbor check: the no-key fallback on a real daemon. `NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions` (with `V=.claude/skills/verify-notesd/scripts/verify.sh`), then `$V mcp RUN sessions_search '{"query":"feat"}'` and `$V api RUN GET '/api/sessions/search?q=feat'` → passes when both answer `mode` `"text"` with a `fallback` starting "Meaning search is off on this server" (not "Session vectors are not built yet") and the hits are not empty; then `$V down`.
- Cost: none (fake embedder; the harness run is without `--embed`).
**Exit criteria:** J1–J4 pass, `npm test`, `npm run typecheck` and `npm run docs:check` pass, and the neighbor check shows the no-key fallback unchanged.

## Handoffs

- No web surface: `web/src` never calls `GET /api/sessions/search` (no search box on `/projects`; the Projects chat reaches search through the agent's `sessions_search`), and the wall shows no notes-search fallback either. Nothing is left for another phase; if a search box is ever added to `/projects`, it should show `fallback` the way the chat relays it.
- Reply and note vectors are not part of the check: the criterion and the scope name `cc_session_embeddings` only. With session vectors absent but note or reply vectors present, the answer is now `text` with the fallback, although hybrid could have found sessions through note meaning. Not a phase of this set; recorded for the owner if they want the check widened later.
- `src/background.ts` keeps waiting for the import before making session vectors (scope says it stays). Nothing handed off.

## Rollback

Revert the phase's commit: Steps 1–2 in `src/sessions/search.ts` are self-contained (one constant, one function, one early return), and Steps 3–5 are test and docs only. No migration, no config, no generated file changes.
