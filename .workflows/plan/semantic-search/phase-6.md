# Phase 6: Live test, docs, Neon migration + first backfill

**Plan set:** `SEMANTIC_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261030-140513-S6EM_code_analyzer.md`
**Satisfies:** R6 (the opt-in live test `EMBEDDINGS_LIVE_TEST=1`), plus the set's acceptance steps: docs, migration 0001 on Neon, the first backfill
**Depends on:** Phase 3, 4, 5 (and through them 1, 2)
**Difficulty:** NORMAL
**Package:** `tests/live`, docs, operations

---

## Goal

One opt-in test (`npm run test:live:embeddings`) makes a single batched OpenRouter call. It
proves the real model puts both usage-example notes first, and it checks that phase 4's blend
weights and minimum similarity still hold on real vectors. The README, INSTALL guide and `/n`
skill describe search by meaning and the `related` tool. Migration 0001 is applied to the live
Neon database, and the first backfill leaves 0 notes pending.

## Interface Contract

**Deletes:** none. Doc text only: the README limitation "No semantic search yet".
**Renames:** none
**Creates:**
- `tests/live/embeddings.live.test.ts` (new file)
- npm script `test:live:embeddings` = `EMBEDDINGS_LIVE_TEST=1 vitest run` (`package.json`)
- env switch `EMBEDDINGS_LIVE_TEST=1` in `vitest.config.ts` (includes only the new file, no globalSetup, never part of `npm test` / `test:int`)
- A new README subsection "Search by meaning" (under "How it works") and a new INSTALL section "6. Semantic search"

**Signature changes:** none
**May change (only if the live run fails):** the numeric values inside phase 4's weights object in `src/search/blend.ts`. No names, no types, no logic, no other file.

**Requires (from earlier phases):** every name below is used verbatim; the reconciler checked each against the phase plans' code blocks.
- Phase 1: `embedInput(body: string): string | null` in `src/embeddings/state.ts`; `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` in `src/embeddings/constants.ts`; table `note_embeddings` with the columns in the index contract; migration `drizzle/0001_*.sql` starts with `CREATE EXTENSION IF NOT EXISTS vector`.
- Phase 1: the README test-container sentence (`README.md:384`, today "`mcp-notes-pg-test` (Postgres 16, port 55433)") already reads pgvector. Phase 6 only checks it (Verification) and does not edit it.
- Phase 2: `createOpenRouterEmbedder({ apiKey, fetch?, timeoutMs?, maxBatch? }): Embedder` and `OPENROUTER_EMBED_MAX_BATCH = 64` in `src/embeddings/openrouter.ts`. `embed()` sends one HTTP request per 64 inputs, in order. The live test sends 26 inputs (16 labelled notes + 10 distinct queries; the two headline queries are among the 10), so `fetchCalls === 1`; the test asserts the input count stays within `OPENROUTER_EMBED_MAX_BATCH`.
- Phase 3: `npm run embed:backfill` (`package.json`, `src/cli/embedBackfill.ts`). First line `embed:backfill: <model>; <N> notes with text, <C> current, <P> pending (<F> failing)`, one `embedded <n>/<total>, failed <f>` line per batch of 16, one stderr `failed <id>: <error>` per failed note, last line `done: embedded <n>, failed <f>; <P> pending`. Exit codes: 0 nothing failed, 1 a note failed / config or database error / no key, 2 bad argument, 130 interrupted. Failed notes wait for their backoff unless `-- --retry-failed` is passed.
- Phase 4: `src/search/blend.ts` exports
  - `BLEND`: the weights/thresholds object, with a numeric `minSimilarity` field (the cosine floor below which a vector-only candidate is dropped)
  - `interface BlendCandidate { id: string; textRank: number | null; similarity: number | null; tagMatch: number; updatedAt: Date }`
  - `function rankCandidates<T extends BlendCandidate>(candidates: readonly T[], opts: { now: Date; tuning?: BlendTuning }): Ranked<T>[]` (`Ranked<T> = T & { score: number }`), sorted best first. Candidates below the floor with no text match are already removed. `BlendCandidate` also has an optional `exactId?: boolean`, which this test leaves unset.
- Phase 4: `tests/fixtures/semantic/labelled.ts` exports
  - `LABELLED_NOTES: ReadonlyArray<{ key: string; body: string; ageDays?: number }>`
  - `LABELLED_QUERIES: ReadonlyArray<{ query: string; relevant: readonly string[] }>`. `relevant` holds note keys.
  - One note whose body contains `arango root password is in the vault`, and one whose body contains `the login broke after the laptop slept`.
- Phase 5: MCP tool `related` `{ id, limit? }` exists (documented here, not touched).
- Phase 3 adds `embed:backfill` to `package.json` `scripts`. This phase adds its own line to the same object (merge point, see Step 2).

**Leaves alone (owned by others):** every `src/**` file except the constants inside `src/search/blend.ts` (Phase 4, conditional retune only); `tests/fixtures/semantic/labelled.ts` and every unit/integration test (Phases 1–5); `scripts/test-int.sh` and the README test-container sentence (Phase 1); `web/**` (nobody); `docs/ROADMAP.md` (checked: it has no per-iteration status column, so it needs no change).

## Files

| File | Action | What changes |
|---|---|---|
| `tests/live/embeddings.live.test.ts` | create | one batched real call; headline assertions; blend check + report |
| `vitest.config.ts:3-50` | modify | `EMBEDDINGS_LIVE_TEST` branch + header comment |
| `package.json:63` (scripts) | modify | add `test:live:embeddings` |
| `README.md` (63, 317-322, 353-358, 377-388, 395-404, 433, after 442, 458-461, 481-482, 503) | modify | search by meaning, `related`, env key, backfill, live test, limitation, roadmap row |
| `docs/INSTALL.md:16-19`, new section before `## Uninstall` (227) | modify | `OPENROUTER_API_KEY` prerequisite, migrate + backfill section |
| `claude/skills/n/SKILL.md:29-36, 66-67` | modify | search understands meaning, `mode: "text"`, `related` |
| `docs/ROADMAP.md` | no change | checked: no status column to update |
| `src/search/blend.ts` (weights object only) | conditional | retune numbers only if Step 8 fails |
| `.env.local` | symlink (gitignored) | operational, not committed |

## Implementation Steps

### Step 1: vitest config branch
**File:** `vitest.config.ts:1-50` (whole file replaced; today's content is unchanged by phases 1–5)
**Change:** add `EMBEDDINGS_LIVE_TEST`. It runs only the new file, needs no Docker and no globalSetup, and has a 60 s timeout. It is excluded from integration mode the same way `CONNECTORS_LIVE_TEST` is.
**Code:**
```ts
import { defineConfig } from 'vitest/config'

/**
 * The single Vitest config for the repo.
 *
 * - `npm test` (unit): `tests/unit/**` in node, plus `web/src/**\/*.test.tsx`, which opt
 *   into jsdom per file with a `// @vitest-environment jsdom` first-line pragma.
 * - `npm run test:int` (scripts/test-int.sh) sets VITEST_INTEGRATION=1, TEST_DATABASE_URL and
 *   TEST_CONNECTORS_URL, which switches the run to `tests/integration/**` only, against the
 *   Docker Postgres `mcp-notes-pg-test` (notes, pgvector image) and `mcp-notes-pg-connectors`
 *   (the three connector schemas, rebuilt from the sibling repos' migrations by
 *   tests/integration/connectors/globalSetup.ts). Integration files run one at a time because
 *   they share databases and truncate them. Embeddings there come from the deterministic fake
 *   embedder; no network.
 * - `npm run test:live` sets CHAT_LIVE_TEST=1 on top of scripts/test-int.sh, which switches the
 *   run to `tests/live/chat.live.test.ts` only: real Claude and real GLM calls through the Agent
 *   SDK, on the notes Docker Postgres. Opt-in, slow and billed.
 * - `npm run test:live:connectors` sets CONNECTORS_LIVE_TEST=1 (no Docker), which runs only
 *   `tests/live/connectors.live.test.ts`: each <system>_schema tool against the real databases,
 *   read-only. Opt-in.
 * - `npm run test:live:embeddings` sets EMBEDDINGS_LIVE_TEST=1 (no Docker, no database), which
 *   runs only `tests/live/embeddings.live.test.ts`: one real, billed OpenRouter embeddings call
 *   (OPENROUTER_API_KEY from .env.local) over the labelled search set. Opt-in.
 * None of the live files is ever part of `npm test` or `test:int`.
 *
 * Do not add a second config file.
 */
const chatLive = process.env.CHAT_LIVE_TEST === '1'
const connectorsLive = process.env.CONNECTORS_LIVE_TEST === '1'
const embeddingsLive = process.env.EMBEDDINGS_LIVE_TEST === '1'
const integration =
  !connectorsLive && !embeddingsLive && (chatLive || process.env.VITEST_INTEGRATION === '1')

function includeFor(): string[] {
  if (embeddingsLive) return ['tests/live/embeddings.live.test.ts']
  if (connectorsLive) return ['tests/live/connectors.live.test.ts']
  if (chatLive) return ['tests/live/chat.live.test.ts']
  if (integration) return ['tests/integration/**/*.int.test.ts']
  return ['tests/unit/**/*.test.ts', 'web/src/**/*.test.tsx']
}

function globalSetupFor(): string[] {
  if (embeddingsLive || connectorsLive) return []
  if (chatLive) return ['tests/integration/globalSetup.ts']
  if (integration) return ['tests/integration/globalSetup.ts', 'tests/integration/connectors/globalSetup.ts']
  return []
}

function testTimeoutFor(): number {
  if (chatLive) return 300_000
  if (connectorsLive || embeddingsLive) return 60_000
  if (integration) return 30_000
  return 5_000
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: includeFor(),
    exclude: ['node_modules/**', 'dist/**', 'web/dist/**'],
    globalSetup: globalSetupFor(),
    fileParallelism: !integration,
    testTimeout: testTimeoutFor(),
    hookTimeout: chatLive || connectorsLive || embeddingsLive || integration ? 60_000 : 10_000,
  },
})
```
**Impact:** none on `npm test` / `test:int`. The default include globs (`tests/unit/**`, `tests/integration/**`) never match `tests/live/**`. If phase 1 changed this header comment's container wording, keep the comment above (it already says "pgvector image").

### Step 2: npm script
**File:** `package.json:63` (the `scripts` object; insert directly after `"test:live:connectors"`)
**Change:** add one line. Phase 3 adds `"embed:backfill"` to the same object. Keep both, so the merged block is:
```json
    "test:live": "CHAT_LIVE_TEST=1 bash scripts/test-int.sh",
    "test:live:connectors": "CONNECTORS_LIVE_TEST=1 vitest run",
    "test:live:embeddings": "EMBEDDINGS_LIVE_TEST=1 vitest run",
```
(`embed:backfill` stays wherever phase 3 put it.)
**Impact:** none.

### Step 3: the live test
**File:** `tests/live/embeddings.live.test.ts` (new)
**Change:** one batched real call over every labelled note, every labelled query and the two headline queries. The test asserts width and finiteness, the two headline nearest-neighbours, and that the blend keeps both headline notes at rank 1. It also checks that `BLEND.minSimilarity` does not drop any relevant note that has no word overlap with its query, and it prints a per-query report. The adapter block (marked) is the only code that depends on phase 4's export names.
**Code:**
```ts
/**
 * Opt-in live check of the embedding side of search: ONE real OpenRouter /embeddings call
 * (openai/text-embedding-3-small, 1536 dims) over phase 4's labelled set plus the two usage
 * examples. Run with `npm run test:live:embeddings` (EMBEDDINGS_LIVE_TEST=1, no Docker, no
 * database). Never part of `npm test`, `npm run test:int` or the other live suites. Billed, but a
 * few cents of a cent.
 *
 * It asserts what the fake embedder cannot: that the real model puts "arango root password is in
 * the vault" nearest to "ArangoDB credentials", and "the login broke after the laptop slept"
 * nearest to "have we seen auth failures after resume before?". It then runs the real vectors
 * through src/search/blend.ts in memory (text rank = simple word overlap) to see whether the
 * weights and the minimum similarity tuned on the fake hold for the real model. When this fails,
 * retune ONLY the numbers in BLEND, then re-run `npm test`, `npm run test:int` and this file.
 *
 * Needs OPENROUTER_API_KEY in the environment or in .env.local (a worktree carries a symlink to
 * ~/mcp-notes/.env.local). The key is never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../src/embeddings/constants.js';
import { OPENROUTER_EMBED_MAX_BATCH, createOpenRouterEmbedder } from '../../src/embeddings/openrouter.js';
import { embedInput } from '../../src/embeddings/state.js';
// ---- adapter: the only lines that depend on phase 4's export names ----
import { BLEND, rankCandidates, type BlendCandidate } from '../../src/search/blend.js';
import { LABELLED_NOTES, LABELLED_QUERIES } from '../fixtures/semantic/labelled.js';
// -----------------------------------------------------------------------

const ARANGO_NOTE = 'arango root password is in the vault';
const ARANGO_QUERY = 'ArangoDB credentials';
const LOGIN_NOTE = 'the login broke after the laptop slept';
const LOGIN_QUERY = 'have we seen auth failures after resume before?';

const NOW = new Date('2026-10-30T07:00:00Z');
const DAY_MS = 86_400_000;

interface LiveNote {
  key: string;
  body: string;
  ageDays: number;
  vector: number[];
}

function apiKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = path.resolve(import.meta.dirname, '../../.env.local');
  if (existsSync(file)) {
    const fromFile = parse(readFileSync(file)).OPENROUTER_API_KEY?.trim();
    if (fromFile) return fromFile;
  }
  throw new Error(
    'OPENROUTER_API_KEY is not set. Export it or put it in .env.local ' +
      '(in a worktree: ln -sf /home/miftah/mcp-notes/.env.local .env.local).',
  );
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((w) => w.length > 0),
  );
}

/** Stand-in for ts_rank: the share of query words found in the body; null when none (no FTS match). */
function textRank(query: string, body: string): number | null {
  const q = words(query);
  if (q.size === 0) return null;
  const b = words(body);
  let hits = 0;
  for (const w of q) if (b.has(w)) hits += 1;
  return hits === 0 ? null : hits / q.size;
}

function nearest(queryVector: readonly number[], notes: readonly LiveNote[]): Array<{ note: LiveNote; similarity: number }> {
  return notes
    .map((note) => ({ note, similarity: cosine(queryVector, note.vector) }))
    .sort((x, y) => y.similarity - x.similarity);
}

function blendRanking(query: string, queryVector: readonly number[], notes: readonly LiveNote[]): string[] {
  const candidates: BlendCandidate[] = notes.map((note) => ({
    id: note.key,
    textRank: textRank(query, note.body),
    similarity: cosine(queryVector, note.vector),
    tagMatch: 0,
    updatedAt: new Date(NOW.getTime() - note.ageDays * DAY_MS),
  }));
  return rankCandidates(candidates, { now: NOW }).map((r) => r.id);
}

function noteContaining(notes: readonly LiveNote[], text: string): LiveNote {
  const found = notes.find((n) => n.body.includes(text));
  if (!found) throw new Error(`labelled set has no note containing "${text}"`);
  return found;
}

let notes: LiveNote[] = [];
let queryVectors = new Map<string, number[]>();
let allVectors: number[][] = [];
let fetchCalls = 0;

beforeAll(async () => {
  const countingFetch: typeof fetch = (input, init) => {
    fetchCalls += 1;
    return fetch(input, init);
  };
  const embedder = createOpenRouterEmbedder({ apiKey: apiKey(), fetch: countingFetch, timeoutMs: 30_000 });

  const noteInputs = LABELLED_NOTES.map((n) => {
    const input = embedInput(n.body);
    if (input === null) throw new Error(`labelled note ${n.key} has an empty body`);
    return input;
  });
  const queryTexts = [...new Set([ARANGO_QUERY, LOGIN_QUERY, ...LABELLED_QUERIES.map((q) => q.query)])];
  const queryInputs = queryTexts.map((q) => embedInput(q) ?? q);

  allVectors = await embedder.embed([...noteInputs, ...queryInputs], { timeoutMs: 30_000 });

  notes = LABELLED_NOTES.map((n, i) => ({
    key: n.key,
    body: n.body,
    ageDays: n.ageDays ?? 0,
    vector: allVectors[i] ?? [],
  }));
  queryVectors = new Map(queryTexts.map((q, i) => [q, allVectors[noteInputs.length + i] ?? []]));
});

describe(`live embeddings (${EMBEDDING_MODEL})`, () => {
  it('makes one request and returns one finite 1536-dim vector per input', () => {
    // One request only while every input fits one OpenRouter batch (phase 2 splits at 64).
    expect(allVectors.length).toBeLessThanOrEqual(OPENROUTER_EMBED_MAX_BATCH);
    expect(fetchCalls).toBe(1);
    expect(allVectors.length).toBe(notes.length + queryVectors.size);
    for (const v of allVectors) {
      expect(v.length).toBe(EMBEDDING_DIMENSIONS);
      expect(v.every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  it(`puts "${ARANGO_NOTE}" nearest to "${ARANGO_QUERY}"`, () => {
    const target = noteContaining(notes, ARANGO_NOTE);
    const ranked = nearest(queryVectors.get(ARANGO_QUERY) ?? [], notes);
    console.info(
      `[live] ${ARANGO_QUERY}: ` +
        ranked.slice(0, 3).map((r) => `${r.note.key}=${r.similarity.toFixed(3)}`).join(', '),
    );
    expect(ranked[0]?.note.key).toBe(target.key);
  });

  it(`puts "${LOGIN_NOTE}" nearest to "${LOGIN_QUERY}"`, () => {
    const target = noteContaining(notes, LOGIN_NOTE);
    const ranked = nearest(queryVectors.get(LOGIN_QUERY) ?? [], notes);
    console.info(
      `[live] ${LOGIN_QUERY}: ` +
        ranked.slice(0, 3).map((r) => `${r.note.key}=${r.similarity.toFixed(3)}`).join(', '),
    );
    expect(ranked[0]?.note.key).toBe(target.key);
  });

  it('keeps both usage examples at rank 1 through the blend', () => {
    const cases: Array<[string, string]> = [
      [ARANGO_QUERY, ARANGO_NOTE],
      [LOGIN_QUERY, LOGIN_NOTE],
    ];
    for (const [query, body] of cases) {
      const target = noteContaining(notes, body);
      const ranking = blendRanking(query, queryVectors.get(query) ?? [], notes);
      expect(ranking[0], `blend rank 1 for "${query}" (BLEND=${JSON.stringify(BLEND)})`).toBe(target.key);
    }
  });

  it('BLEND.minSimilarity keeps every relevant note that shares no word with its query', () => {
    const dropped: string[] = [];
    const rows: Array<{ query: string; firstRelevant: number | null; mrr: number }> = [];
    let mrrSum = 0;
    for (const q of LABELLED_QUERIES) {
      const qv = queryVectors.get(q.query) ?? [];
      for (const key of q.relevant) {
        const note = notes.find((n) => n.key === key);
        if (!note) throw new Error(`labelled query "${q.query}" names unknown note ${key}`);
        const sim = cosine(qv, note.vector);
        if (textRank(q.query, note.body) === null && sim < BLEND.minSimilarity) {
          dropped.push(`${key} for "${q.query}" (similarity ${sim.toFixed(3)} < ${BLEND.minSimilarity})`);
        }
      }
      const ranking = blendRanking(q.query, qv, notes);
      const positions = q.relevant.map((k) => ranking.indexOf(k)).filter((i) => i >= 0);
      const first = positions.length > 0 ? Math.min(...positions) + 1 : null;
      const rr = first === null ? 0 : 1 / first;
      mrrSum += rr;
      rows.push({ query: q.query, firstRelevant: first, mrr: Number(rr.toFixed(3)) });
    }
    const mrr = LABELLED_QUERIES.length === 0 ? 0 : mrrSum / LABELLED_QUERIES.length;
    console.table(rows);
    console.info(`[live] blend MRR over ${LABELLED_QUERIES.length} labelled queries: ${mrr.toFixed(3)}`);
    expect(dropped, dropped.join('\n')).toEqual([]);
  });
});
```
**Impact:** new file, run only under `EMBEDDINGS_LIVE_TEST=1`. It type-checks under `npm run typecheck` (tsconfig.json includes `tests/**`). So the adapter names **must** match phase 4's exports, or typecheck fails for the whole set. The reconciler aligns them.

### Step 4: README
**File:** `README.md`. Anchors are today's line numbers; anchor on the quoted text. Phases 1–5 change only the test-container sentence at lines 384–385 (phase 1 turns those 2 lines into 3), so every anchor after line 385 is one line lower once phase 1 has landed.

**4a. Line 63–65 ("Claude is the search engine.")**, replace with:
```markdown
- **Claude is the search engine.** There is no search bar. Claude Code reaches your notes through
  MCP with filters for tags, dates, full text and images, and search understands meaning, not
  only words: "ArangoDB credentials" finds "arango root password is in the vault". Claude does
  the reading, comparing and summarizing itself. The same tools work from any repo through `/n`.
```

**4b. Lines 317–322 (Install on WSL block)**, replace the fenced block with:
````markdown
```sh
git clone git@github.com:miftahulmahfuzh/mcp-notes.git ~/mcp-notes
cd ~/mcp-notes
cp /path/to/your/.env.local .env.local    # DATABASE_URL, DATABASE_URL_UNPOOLED, OPENROUTER_API_KEY
npm ci
npm run db:migrate                         # once, against the direct (unpooled) host
npm run embed:backfill                     # optional: embed existing notes now (notesd also does it in the background)
scripts/install.sh
```
````

**4c. Lines 353–358 (A second machine)**, replace the paragraph with:
```markdown
The text database is shared, so a second laptop can run its own `notesd` against it. Clone the
repo there, copy the same `.env.local`, and run `scripts/install.sh` (no `db:migrate` and no
`embed:backfill`: the schema and the embeddings are already there). Notes, tags, revisions,
search by meaning and the chat bar work the same. Photos do not move: a photo note made on one
machine shows "not on this machine" on the other, by design. The connectors need the three
sibling repos (or `*_DIR` pointing at them) on that machine too.
```

**4d. Lines 377–388 (Tests)**, replace the fenced block and the **last sentence only**. After phase 1 the paragraph under the block reads (change nothing before "`test:live` (chat)"):
```markdown
`test:int` starts or reuses two containers, both on `pgvector/pgvector:pg16` (one that runs another
image is recreated): `mcp-notes-pg-test` (port 55433) for the notes, and
`mcp-notes-pg-connectors` (port 55435), where it rebuilds one
database per connector from that repo's own migration files (read, never imported; a repo that is
not there is skipped with a message). Neither suite touches a Neon database. `test:live` (chat)
and `test:live:connectors` are opt-in and never part of `npm test` or `test:int`.
```
The new fenced block:
````markdown
```sh
npm run typecheck
npm test                       # unit tests, server and web (jsdom)
npm run test:int               # integration tests against real Postgres in Docker
npm run test:live:connectors   # opt-in: each *_schema tool against the real databases, read-only
npm run test:live:embeddings   # opt-in: one real OpenRouter embeddings call over the labelled search set
```
````
and the closing sentence ("`test:live` (chat) and `test:live:connectors` are opt-in …", today lines 387–388, 388–389 after phase 1) becomes:
```markdown
Embeddings in `npm test` and `test:int` come from a deterministic fake, so neither makes a network
call. `test:live` (chat), `test:live:connectors` and `test:live:embeddings` are opt-in and never
part of `npm test` or `test:int`.
```
The sentence "Neither suite touches a Neon database." stays where it is, at the end of phase 1's paragraph.

**4e. Configuration table, insert after line 400** (`LLM_BASE_URL…`):
```markdown
| `OPENROUTER_API_KEY` | — | OpenRouter key for note embeddings (`openai/text-embedding-3-small`). Unset: notes save as usual, `search` is full text only and says so, `related` answers only for notes that already have a vector. |
```

**4f. Line 433 (`search` row)**, replace it, and add `related` right after:
```markdown
| `search` | By meaning and by words: full text (Postgres `simple` config, so ids and code tokens still rank first) blended with vector similarity, tag match and recency, after the same filters. `mode: "text"` for exact words only |
| `related` | The notes nearest in meaning to a note `id`, each with a similarity score, never the note itself |
```

**4g. After line 442** (the paragraph ending "…the curated tools come first."), insert a new subsection:
```markdown
### Search by meaning

Every note body is embedded with OpenRouter (`openai/text-embedding-3-small`, 1536 dimensions)
into `note_embeddings` (pgvector, HNSW cosine index), next to the sha256 of the body it was made
from, so a vector that no longer matches its note is never used. Embedding happens in the
background after a write commits: a slow or failing OpenRouter never blocks or fails a save, the
note is retried with backoff, and a periodic sweep picks up notes written on the other machine.
Textless photo notes have no vector; deleted notes keep theirs, so a restore needs no new call.

`search` takes full-text matches and the nearest vectors under the same filters and blends four
signals: text rank, similarity, tag match and recency. The weights live in `src/search/blend.ts`,
each with a comment. If the query cannot be embedded, it returns today's full-text ranking and
says so in `fallback`. `npm run embed:backfill` embeds everything pending in one go and prints
progress (first run, or after a model change).
```

**4h. Lines 458–461 (Where things are stored)**, the Postgres lines become:
```
Postgres   notes(id, body, tags[], image_path, image_meta, origin, created_at, updated_at, deleted_at)
           note_revisions(note_id, body, saved_at)
           note_embeddings(note_id, embedding vector(1536), body_sha256, model, attempts, next_attempt_at, …)
```

**4i. Lines 481–482 (limitation)**, replace "No semantic search yet" with:
```markdown
- **Meaning needs OpenRouter.** A note becomes findable by meaning shortly after it is saved,
  not in the same instant. Without `OPENROUTER_API_KEY`, or while OpenRouter is down, `search`
  falls back to full text and says so, and `related` answers only for notes embedded earlier. Pictures are found by their
  text and dates, not by what is in them.
```

**4j. Line 503 (Roadmap row 6)**, replace with:
```markdown
| 6 | Semantic search: pgvector embeddings, hybrid ranking, `related` | done |
```
**Impact:** docs only.

### Step 5: INSTALL.md
**File:** `docs/INSTALL.md:16-19`
**Change:** replace the two last prerequisite bullets (lines 18–19) with:
```markdown
- `.env.local` at the repo root with `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (the Neon pooled and direct hosts; the daemon picks the pooled one by host name, so the key names do not have to be right), and `OPENROUTER_API_KEY` for search by meaning (see "6. Semantic search"; without it notes still save and search is full text only).
- The Neon schema migrated once: `npm run db:migrate` (again after a pull that adds a migration file under `drizzle/`).
```

**File:** `docs/INSTALL.md`, insert directly before `## Uninstall` (today line 227):
````markdown
## 6. Semantic search

`search` blends full text with vector similarity, tags and recency, and `related` finds the notes
nearest in meaning to a note. Embeddings come from OpenRouter (`openai/text-embedding-3-small`,
1536 dimensions) and live in the `note_embeddings` table (pgvector) on the same Neon database.

| Key | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | unset | OpenRouter key. Unset: notes save as usual, `search` answers with full text and says so, `related` answers from vectors already stored and returns a `not_embedded` error for a note that has none. |

Once per database (the second machine skips this, the schema and vectors are shared):

```sh
cd ~/mcp-notes
npm run db:migrate          # applies drizzle/0001_*: CREATE EXTENSION vector, note_embeddings, HNSW index
npm run embed:backfill      # embeds every note that has text; prints progress and ends with "done: … 0 pending"
scripts/install.sh          # restart notesd on the new code
```

The backfill is optional: `notesd` embeds pending notes in the background by itself (batched,
rate-limited, resumable), and logs only when it has work. Run it again after changing the model.
A note written while OpenRouter is down is saved normally, then retried with backoff.

`npm run embed:backfill -- --retry-failed` also retries failed notes whose backoff has not run
out yet. Ctrl-C stops after the current batch; running it again resumes. Exit codes: 0 done,
1 a note failed (or no key / config or database error), 2 bad argument, 130 interrupted.

`notesd` logs `[notesd] embedding notes with openai/text-embedding-3-small` at start (or
`[notesd] embeddings off: OPENROUTER_API_KEY is not set, search stays full text` without a key),
then one `[notesd] embeddings: …` line per batch that did work. Both laptops may run the worker
at once; the writes are idempotent.

Check it:

- `journalctl --user -u notesd | grep -i embed`: the background job's progress and any failure (never the key).
- `/n find a relevant notes that talks about ArangoDB credentials` should return the vault note
  even though it never says "credentials".
- Live check of the model itself (one billed call, no database): `npm run test:live:embeddings`.
````
**Impact:** docs only.

### Step 6: `/n` skill
**File:** `claude/skills/n/SKILL.md:29-36`
**Change:** the Tools paragraph becomes:
```markdown
The spine tools are `create`, `get` (one or several ids), `update` (full body replace),
`append`, `delete` (soft), `restore`, `list` (tag any/all filters, created/updated date range,
newest first, limit + cursor), `search` (ranked by meaning and by words, with tag and date
filters; `mode: "text"` for exact words only), `related` (the notes nearest in meaning to one
note id, with a similarity score), `tags` (every tag with count and last-used date),
`revisions` and `revert`. If the server also offers image tools (for example `create_image`
from a local file path, `view_images` to see a note's picture, and `has_image` / taken-date
filters on `list` and `search`), use them as described under Images. Always follow each tool's
own schema and description for parameter names and formats; they win over anything written
here.
```
**File:** `claude/skills/n/SKILL.md:66-67`
**Change:** replace the "Words or a topic" bullet with these three bullets:
```markdown
- Words, a topic or a question rather than a tag → `search` with the user's words as they are
  (it understands meaning, so "have we seen auth failures after resume before?" finds a note
  that says "the login broke after the laptop slept"), then `get` the best hits if you need full
  bodies. If `search` finds nothing, try `list` by a likely tag, or `tags` to see what exists.
- An exact id, code token, error string or command the note must contain → `search` with
  `mode: "text"`.
- "What else is related to A-B32", "anything similar to this note" → `related` with that id.
```
No other line of the skill changes (frontmatter `description` included).
**Impact:** the skill is symlinked into `~/.claude/skills/n`, so the next `/n` picks this up after the set lands and `install.sh` re-points the link.

### Step 7: link `.env.local` and run every suite
**Commands** (worktree root):
```sh
cd /home/miftah/.worktrees/mcp-notes/semantic-search
ln -sf /home/miftah/mcp-notes/.env.local .env.local
git check-ignore .env.local            # expected: .env.local
grep -c '^OPENROUTER_API_KEY=' .env.local   # expected: 1
npm run typecheck                      # expected: exit 0, no output from tsc
npm test                               # expected: all unit files pass; embeddings.live is NOT listed
npm run test:int                       # expected: all integration files pass on pgvector/pgvector:pg16
```
Never `cat` `.env.local` or echo the key.

### Step 8: the live test
**Command:**
```sh
npm run test:live:embeddings
```
**Expected output** (similarities are indicative):
```
 ✓ tests/live/embeddings.live.test.ts (5 tests)
[live] ArangoDB credentials: <arango-key>=0.5xx, …
[live] have we seen auth failures after resume before?: <login-key>=0.4xx, …
┌─────────┬──────────────────────────┬───────────────┬───────┐
│ (index) │ query                    │ firstRelevant │ mrr   │
…
[live] blend MRR over N labelled queries: 0.8xx
 Test Files  1 passed (1)
      Tests  5 passed (5)
```
**If it fails:**
- *test 1* (width, finiteness, one request): this is a phase 2 defect, not a tuning problem. Stop and report. Do not edit `src/embeddings/**`.
- *tests 2–3* (raw nearest neighbour): the model disagrees with the labelled set. Stop and report the printed top-3. Weights cannot fix raw similarity, and the fixture belongs to phase 4.
- *tests 4–5* (blend rank 1, `minSimilarity` drops a relevant note): retune **only numbers** in `BLEND` in `src/search/blend.ts`. Usually that means lowering `minSimilarity` to just under the smallest printed similarity of a dropped relevant note, or raising the vector weight relative to text. Then update each changed value's comment ("tuned on the real model, 2026-10-30, live MRR x.xx"), and re-run in this order:
  ```sh
  npm test && npm run test:int && npm run test:live:embeddings
  ```
  All three must pass. If no set of numbers satisfies both the fake-embedder tests (phase 4) and the live test, stop and report both failures. Do not edit phase 4's tests or fixture.

### Step 9: apply migration 0001 to Neon
Run only after Step 7 and Step 8 pass. `drizzle.config.ts` picks the direct (non-`-pooler`) host by itself.
**Command:**
```sh
npm run db:migrate
```
**Expected output:**
```
> mcp-notes@0.1.0 db:migrate
> drizzle-kit migrate

Reading config file '/home/miftah/.worktrees/mcp-notes/semantic-search/drizzle.config.ts'
Using 'pg' driver for database querying
[✓] migrations applied successfully!
```
(Running it a second time prints the same and changes nothing.)

**Verify** (read-only queries on the direct host; prints no secrets):
```sh
node --input-type=module -e "
import pg from 'pg'; import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
const url = [process.env.DATABASE_URL_UNPOOLED, process.env.DATABASE_URL].find((u) => u && !new URL(u).host.includes('-pooler'));
const c = new pg.Client({ connectionString: url }); await c.connect();
const q = async (s) => (await c.query(s)).rows;
console.log('vector', await q(\"select extversion from pg_extension where extname = 'vector'\"));
console.log('table', await q(\"select to_regclass('public.note_embeddings')::text as t\"));
console.log('indexes', (await q(\"select indexname from pg_indexes where tablename = 'note_embeddings' order by 1\")).map((r) => r.indexname));
console.log('migrations', (await q('select count(*)::int as n from drizzle.__drizzle_migrations'))[0].n);
await c.end();
"
```
**Expected:**
```
vector [ { extversion: '0.8.6' } ]
table [ { t: 'note_embeddings' } ]
indexes [ 'note_embeddings_embedding_hnsw_idx', 'note_embeddings_next_attempt_idx', 'note_embeddings_pkey' ]
migrations 2
```
The installed daemon (still on `main`'s code) keeps working. The migration only adds objects, and it never reads them.

### Step 10: first backfill on Neon
**Command:**
```sh
npm run embed:backfill
```
**Expected output** (phase 3's format strings; batches of 16):
```
> mcp-notes@0.1.0 embed:backfill
> tsx src/cli/embedBackfill.ts

embed:backfill: openai/text-embedding-3-small; <N> notes with text, 0 current, <N> pending (0 failing)
embedded 16/<N>, failed 0
embedded 32/<N>, failed 0
…
embedded <N>/<N>, failed 0
done: embedded <N>, failed 0; 0 pending
```
Exit code 0. If it exits 1 (stderr shows `failed <id>: <error>` lines and the summary `failed <f>`), run `npm run embed:backfill -- --retry-failed` once: without the flag a failed note waits for its backoff. If notes still fail, stop and report `last_error` from the query below. Never print the key.

**Confirm 0 pending independently** (same "current" predicate as the index contract):
```sh
node --input-type=module -e "
import pg from 'pg'; import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
const url = [process.env.DATABASE_URL_UNPOOLED, process.env.DATABASE_URL].find((u) => u && !new URL(u).host.includes('-pooler'));
const c = new pg.Client({ connectionString: url }); await c.connect();
const { rows } = await c.query(\`
  select count(*) filter (where n.body ~ '\\\\S')::int as with_text,
         count(*) filter (where n.body ~ '\\\\S' and e.embedding is not null
           and e.body_sha256 = encode(sha256(convert_to(n.body, 'UTF8')), 'hex')
           and e.model = 'openai/text-embedding-3-small')::int as current,
         count(*) filter (where e.last_error is not null)::int as failing
    from notes n left join note_embeddings e on e.note_id = n.id\`);
console.log(rows[0], 'pending', rows[0].with_text - rows[0].current);
const err = await c.query('select note_id, attempts, left(last_error, 120) as last_error from note_embeddings where last_error is not null limit 5');
if (err.rows.length) console.log(err.rows);
await c.end();
"
```
**Expected:** `{ with_text: N, current: N, failing: 0 } pending 0`.
A note written by a running daemon between the backfill and this query can show as pending 1. Re-run the CLI and the count returns to 0. The installed daemon embeds nothing until the set lands and `install.sh` runs on the new code.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` and `npm run test:int` (must not list `embeddings.live.test.ts`); then `npm run test:live:embeddings` (5 passed).
**Manual check:**
- `grep -n 'No semantic search yet' README.md` prints nothing. `grep -n 'pgvector' README.md` shows phase 1's test-container sentence. If it still says plain "Postgres 16" for `mcp-notes-pg-test`, report it to the reconciler as a phase 1 gap. Do not fix it here.
- `git diff --stat main -- web/` is empty. `git diff --name-only` for this phase lists only the files in the Files table (plus `src/search/blend.ts` if Step 8 retuned).
- After Steps 9–10: the two Node queries print the expected values.
**Exit criteria:** the live test passes against OpenRouter, and both usage examples rank first by raw similarity and through the blend. Typecheck, `npm test` and `test:int` pass. Neon has the `vector` extension, `note_embeddings` and its HNSW index, and 2 rows in `drizzle.__drizzle_migrations`. The backfill ends with pending 0 and the independent query agrees. The README, INSTALL and `/n` skill describe search by meaning, `mode: "text"` and `related`.

## Handoffs

- **Phase 1:** owns the README test-container sentence (`README.md:384-385`; its plan Step 8 rewrites it to name `pgvector/pgvector:pg16`). This phase edits only the sentence after it (Step 4d quotes the post-phase-1 paragraph).
- **Phase 4:** the adapter names in Step 3 (`BLEND.minSimilarity`, `BlendCandidate {id, textRank, similarity, tagMatch, updatedAt, exactId?}`, `rankCandidates(cands, { now })` → `Ranked<T>[]`, `LABELLED_NOTES {key, body, ageDays?}`, `LABELLED_QUERIES {query, relevant, usage?, why}`) match phase 4's code blocks (reconciled). Both headline bodies are in the fixture verbatim (`arango-vault`, `login-sleep`).
- **Phase 2:** `fetchCalls === 1` holds because 26 inputs ≤ `OPENROUTER_EMBED_MAX_BATCH` (64); the test asserts that bound first, so growing the labelled set past 64 inputs fails with a clear message instead of a confusing call count.
- **Phase 3:** Step 10's expected output and INSTALL's text use phase 3's real format strings and exit codes (reconciled).
- **Main checkout (after landing, not this phase):** `cd ~/mcp-notes && git pull && scripts/install.sh` (INSTALL §3) so the installed `notesd` runs the worker. The GPD needs only `install.sh`.

## Rollback

- Code and docs: revert this phase's commit. It touches only the new live test, `vitest.config.ts`, `package.json` (one script line), README, INSTALL and the skill, plus the `BLEND` numbers if they were retuned.
- Neon: `drop table note_embeddings;` on the direct host. That removes every vector and leaves `notes` untouched; the `vector` extension can stay. To let a later `db:migrate` re-apply 0001, also delete its row: `delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations);`.
- The backfill writes only `note_embeddings`. Dropping that table undoes it.
- `.env.local` is an untracked, gitignored symlink. `rm .env.local` removes it.
