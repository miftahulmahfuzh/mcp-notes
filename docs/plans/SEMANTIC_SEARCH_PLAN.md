# Plan: Semantic search (mcp-notes iteration 6)

**Slug:** semantic-search
**Date:** 2026-10-30T14:05:13+07:00
**Analysis:** `docs/analyzer/20261030-140513-S6EM_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/semantic-search`
**Branch:** `feature/semantic-search` (base: `origin/main` @ `66b8e98`)
**Phases:** 6
**Status:** phase 2/6 complete
**Coordinator:** —

---

## Why

Verbatim from `docs/iterations/06-semantic.md` (the full text is in the analysis document under "Original User Request"). The parts that set what may and may not change:

> Build mcp-notes iteration 6 ("Semantic") from docs/ROADMAP.md. The "Fixed decisions" table in
> docs/ROADMAP.md is binding: do not re-decide anything in it, in particular the "Semantic search"
> row (pgvector on the notes DB, embeddings via OpenRouter as run-insights does, hybrid ranking:
> full-text + tags + recency + vector). Iterations 1–5 are on main (plans in docs/plans/).

> Today `search` is Postgres full text ('simple' config) plus tags and dates, so a note only comes
> back when it shares words with the question. A note saying "arango root password is in the
> vault" must come back for "ArangoDB credentials", and "the login broke after the laptop slept"
> must come back for "have we seen auth failures after resume before?".

> Out of scope: any UI change, semantic search over the connector systems (expenses, runs, Seer),
> image embeddings (pictures are found by their text and dates), a separate vector database,
> re-ranking with an LLM.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Embeddings via OpenRouter (`openai/text-embedding-3-small`, 1536), run-insights' cap and error handling; embedded after every body write without blocking/failing it; failures marked and retried; vector tied to its body hash; textless photos have none; deleted notes keep vectors, never appear | 1, 2, 3 |
| R2 | pgvector schema: extension, side table, HNSW cosine index; first migration since iteration 1; applies to Neon and test DB; test container ships pgvector | 1 |
| R3 | Background backfill inside notesd (batched, rate-limited, resumable, logged, quiet when idle) + `npm run embed:backfill` with progress | 3 |
| R4 | Hybrid `search`: text + vector + tags + recency, filters before ranking, ids/code tokens still first, fallback to text that says so, weights in one commented place tuned on a labelled set, optional `mode`, description + instructions updated, caption unchanged | 4 |
| R5 | `related` MCP tool: nearest notes by meaning with similarity, excluding the note itself; no UI change | 5 |
| R6 | Unit + integration tests with a deterministic fake embedder on the pgvector container; opt-in live test `EMBEDDINGS_LIVE_TEST=1` | 1, 2, 3, 4, 5, 6 |

R1 spans three phases by construction: the hash/staleness rules live with the schema (1), the OpenRouter client with the config (2), the write-path trigger and retry loop with the worker (3). R1's "deleted notes never appear" is enforced by the default `deleted` filter in R4's search (4) and by `related`'s live-only query (5); those steps are counted under R4 / R5. R6 is each phase's own tests (every phase lists it on its **Satisfies** line) plus the live test in 6.

## Scope

**In scope:** `src/embeddings/**` (new), `src/search/**` (new), `src/cli/embedBackfill.ts` (new), the notes schema + migration 0001, `src/notes/{repo,service,types}.ts`, `src/mcp/{tools,instructions}.ts`, `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `src/background.ts`, `src/chat/status.ts` (allow list + caption for `related` only), `scripts/test-int.sh`, `vitest.config.ts`, `package.json`, tests, README / INSTALL / ROADMAP / `claude/skills/n/SKILL.md`. Applying migration 0001 to Neon and running the first backfill (phase 6).

**Out of scope:** everything in the brief's out-of-scope list; `web/**` (no UI change at all); `src/chat/prompt.ts`; the connector modules; `~/run-insights` (read for reference, never imported or edited).

## Contract (binding on every phase)

### Constants — `src/embeddings/constants.ts` (phase 1)
```ts
export const EMBEDDING_MODEL = 'openai/text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const EMBEDDING_MAX_CHARS = 8_000;          // run-insights' clamp: truncate, no marker
export const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';
```

### Table `note_embeddings` — `src/db/schema.ts` (phase 1)
| column | type | meaning |
|---|---|---|
| `note_id` | text PK, FK → notes.id ON DELETE CASCADE | one row per note |
| `embedding` | `vector(1536)` NULL | NULL while the latest attempt for `body_sha256` failed |
| `body_sha256` | text NOT NULL | hex sha256 of the UTF-8 body this row refers to (the embedded body, or the body whose embedding failed) |
| `model` | text NOT NULL | model id the vector came from |
| `attempts` | integer NOT NULL default 0 | consecutive failures for this `body_sha256`; 0 after success |
| `last_error` | text NULL | ≤ 500 chars, no secrets |
| `next_attempt_at` | timestamptz NULL | not before this time (failures only) |
| `embedded_at` | timestamptz NULL | when `embedding` was written |
| `updated_at` | timestamptz NOT NULL default now() | |

Indexes: `note_embeddings_embedding_hnsw_idx` USING hnsw (`embedding vector_cosine_ops`); `note_embeddings_next_attempt_idx` on `next_attempt_at`. Migration `drizzle/0001_*.sql` generated by `npm run db:generate`, with `CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint` hand-prepended.

**A vector is *current* iff** `embedding IS NOT NULL AND body_sha256 = encode(sha256(convert_to(notes.body, 'UTF8')), 'hex') AND model = EMBEDDING_MODEL`. Search and related use only current vectors; anything else is pending. A body that is empty after trim needs no embedding (state `none`).

### State helpers — `src/embeddings/state.ts` (phase 1, pure)
```ts
export function bodySha256(body: string): string;                  // hex, equals the SQL expression above
export function embedInput(body: string): string | null;           // trim, clamp to EMBEDDING_MAX_CHARS; null when empty
export type EmbeddingState = 'current' | 'stale' | 'missing' | 'failed' | 'none';
export interface StoredEmbedding { bodySha256: string; model: string; hasVector: boolean; attempts: number }
export function embeddingState(body: string, stored: StoredEmbedding | null, model: string): EmbeddingState;
export function retryDelayMs(attempts: number): number;            // 30s * 2^(attempts-1), capped at 1h
export function clampError(message: string): string;               // redacts sk-or-… / Bearer …, ≤ 500 chars; recordFailure applies it
```

### Embedding repo — `src/embeddings/repo.ts` (phase 1 creates; phase 5 adds `nearestNotes`)
```ts
export function currentBodySha256Sql(): SQL;                        // encode(sha256(convert_to(notes.body,'UTF8')),'hex')
export function isCurrentEmbeddingSql(model: string): SQL;           // the "current" predicate, for joins on note_embeddings
export interface PendingNote { id: string; body: string; bodySha256: string }
export function listPending(db: Executor, opts: { model: string; limit: number; ignoreBackoff?: boolean }): Promise<PendingNote[]>;
  // notes (live AND deleted) with non-empty trimmed body whose row is missing, stale (hash/model) or failed and due
  // (next_attempt_at <= now(), or the body changed since the failure); live first, then updated_at desc.
export function saveEmbedding(db: Executor, v: { noteId: string; bodySha256: string; model: string; embedding: number[] }): Promise<boolean>;
  // upsert ONLY if the note's current body still hashes to bodySha256; resets attempts/last_error/next_attempt_at; false when skipped.
export function recordFailure(db: Executor, v: { noteId: string; bodySha256: string; model: string; error: string }): Promise<void>;
  // embedding := NULL, attempts := same hash ? attempts+1 : 1, next_attempt_at := now() + retryDelayMs(attempts)
export interface EmbeddingStats { withText: number; current: number; pending: number; failing: number }
export function embeddingStats(db: Executor, model: string): Promise<EmbeddingStats>;
export function toVectorLiteral(v: readonly number[]): string;       // JSON.stringify, bound with ::vector
```

### Embedder — `src/embeddings/embedder.ts` + `src/embeddings/openrouter.ts` (phase 2)
```ts
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** One vector per input, in input order. Throws EmbeddingError. Inputs must be non-empty (use embedInput). */
  embed(inputs: readonly string[], opts?: { timeoutMs?: number }): Promise<number[][]>;
}
export class EmbeddingError extends Error { readonly detail?: unknown }
export function createOpenRouterEmbedder(opts: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; maxBatch?: number }): Embedder;
export function embedderFromConfig(config: EmbeddingsConfig, opts?: { fetch?: typeof fetch }): Embedder | null;
```
`Config.embeddings: { apiKey: string | null }` (from `OPENROUTER_API_KEY`), `DEFAULT_EMBEDDINGS_CONFIG = { apiKey: null }`. `AppDeps.embedder: Embedder | null`. `NotesServiceDeps.embedder?: Embedder | null`. `StartDaemonOptions.embedder?: Embedder | null` (tests inject). Null embedder = semantic features off, writes unaffected.

`embed()` clamps every input with phase 1's `embedInput` (one clamp rule in the code base), splits at `OPENROUTER_EMBED_MAX_BATCH = 64` inputs per request, default timeout `OPENROUTER_EMBED_TIMEOUT_MS = 15_000`. `embeddingErrorText(err)` is the one-line text for logs and `last_error`.

Fake: `tests/helpers/fakeEmbedder.ts` — `createFakeEmbedder({ lexicon?, dimensions?, model?, stopwords?, tailWeight?, delayMs? })` returns a `FakeEmbedder` (`Embedder` + `readonly calls: string[][]`, `failNext(n = 1, error?)`, `failWhen(pred | null, error?)`, mutable `delayMs`, `reset()`, `vectorFor(text)`); `type Lexicon = readonly (readonly string[])[]`, an entry ending in `*` is a prefix; `model` defaults to `EMBEDDING_MODEL`, `dimensions` to 1536. Deterministic "concept bag": tokens map to concept axes through `lexicon` (synonym groups), unknown tokens hash into a low-weight tail; L2-normalised.

### Worker — `src/embeddings/worker.ts`, `src/embeddings/backfill.ts` (phase 3)
`startEmbeddingWorker({ store, events, embedder, ... }) → { kick(): void; idle(): Promise<void>; close(): Promise<void> }`, started from `startBackground` when `deps.embedder` is non-null; `close()` waits for an in-flight batch at most `DEFAULT_CLOSE_GRACE_MS = 5_000` (under `main.ts`'s 10 s forced exit). `runBackfill(...)` is the shared drain loop used by the worker and by `src/cli/embedBackfill.ts` (`npm run embed:backfill [-- --retry-failed]`; batches of 16; output `embedded n/total, failed f` per batch, last line `done: embedded n, failed f; P pending`; exit 0 / 1 / 2 / 130).

### Search — `src/search/blend.ts` (phase 4)
All weights and thresholds in one exported object `BLEND` with a comment per value; `BlendCandidate { id; textRank; similarity; tagMatch; updatedAt; exactId? }`, `rankCandidates<T>(cands, { now, tuning? }) → Ranked<T>[]`. `NotesService.search(query, filter, opts?: { mode?: 'hybrid' | 'text'; queryTimeoutMs? })` returns `SearchPage = NotePage & { mode: 'hybrid' | 'text'; fallback?: string }`. `mode: 'text'` is exactly today's `repo.searchNotes` ranking. The vector candidate query and `related` use `set local hnsw.iterative_scan = strict_order`, so **pgvector >= 0.8 is required** (test image 0.8.7, Neon 0.8.6; phase 1's schema test asserts it). Labelled set: `tests/fixtures/semantic/labelled.ts` (`LABELLED_NOTES`, `LABELLED_QUERIES`, `SEMANTIC_LEXICON`, `evaluateRanking`).

### Related — (phase 5)
`NotesService.related(id, { limit? }) → { note_id: string; related: Array<{ note: Note; similarity: number }> }`; MCP tool `related` `{ id, limit? (1-50, default 10) }`; chat allow list gains `related` (14 notes tools), caption `finding related notes`. A source without a current vector is embedded on demand; without an embedder `related` still answers from stored vectors and returns `not_embedded` for a source that has none. `nearestNotes(db, { noteId, model, limit })` is appended to `src/embeddings/repo.ts`.

### Shared SQL rule
Phase 1's fragments (`currentBodySha256Sql`, `isCurrentEmbeddingSql`) render `"notes".…` / `"note_embeddings".…`; every query that uses them (phase 4 `searchCandidates`, phase 5 `nearestNotes`) references both tables unaliased.

## Invariants

1. At the end of every phase: `npm run typecheck`, `npm test` and `npm run test:int` pass.
2. No note write awaits an embedding call, and no write fails or slows because of embeddings. Writes are untouched; the worker reacts to `NoteEvents` after commit.
3. `npm test` and `npm run test:int` make no network call. OpenRouter is reached only by the live test (`EMBEDDINGS_LIVE_TEST=1`) and by the running daemon / CLI.
4. `search` keeps its name and every existing input. `mode: 'text'` reproduces today's ranking exactly. The chat caption for `search` stays "searching notes".
5. No file under `web/` changes.
6. The vector never enters `NoteRow`, the wire `Note`, or a log line. `OPENROUTER_API_KEY` is never logged.
7. Exactly one new migration (`drizzle/0001_*`), additive only.
8. A fresh worktree has no `.env.local` (gitignored). Phases that need it (`db:generate`, live test, Neon migrate, backfill) symlink it: `ln -sf /home/miftah/mcp-notes/.env.local .env.local`.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 ✓ | pgvector schema, migration, embedding state + repo | R2, R1, R6 | `src/db`, `src/embeddings`, `drizzle`, `scripts` | 13 | — | NORMAL | `.workflows/plan/semantic-search/phase-1.md` | P1-NOTES-A017 | — |
| 2 ✓ | OpenRouter embedder, config, deps wiring, fake embedder | R1, R6 | `src/embeddings`, `src/config.ts`, `src/daemon.ts` | 17 | 1 | NORMAL | `.workflows/plan/semantic-search/phase-2.md` | P1-NOTES-A018 | — |
| 3 | Embedding worker, background backfill, `embed:backfill` | R3, R1, R6 | `src/embeddings`, `src/background.ts`, `src/cli` | 10 | 1, 2 | HARD | `.workflows/plan/semantic-search/phase-3.md` | P1-NOTES-A019 | — |
| 4 | Hybrid search + labelled set | R4, R6 | `src/search`, `src/notes`, `src/mcp` | 12 | 1, 2 | HARD | `.workflows/plan/semantic-search/phase-4.md` | P1-NOTES-A020 | — |
| 5 | `related` tool | R5, R6 | `src/embeddings`, `src/notes`, `src/mcp`, `src/chat` | 9 | 1, 2, 4 | NORMAL | `.workflows/plan/semantic-search/phase-5.md` | P1-NOTES-A021 | — |
| 6 | Live test, docs, Neon migration + first backfill | R6 | `tests/live`, docs | 6 (+ `src/search/blend.ts` numbers, only if the live run demands it) | 3, 4, 5 | NORMAL | `.workflows/plan/semantic-search/phase-6.md` | P1-NOTES-A022 | — |

DAG: 1 → 2 → {3, 4}; 4 → 5; {3, 4, 5} → 6. Phases 3 and 4 can run in parallel; 5 can run in parallel with 3.

### Phase 1 — pgvector schema, migration, embedding state + repo
**Satisfies:** R2, R1 (hash and staleness rules), R6 (state unit tests, repo + migration integration tests)
**Owns:** `src/embeddings/constants.ts`, `src/embeddings/state.ts`, `src/embeddings/repo.ts` (all but `nearestNotes`), `src/db/schema.ts` (`noteEmbeddings`), `drizzle/0001_*.sql` + `drizzle/meta/*`, `scripts/test-int.sh` (notes container on `pgvector/pgvector:pg16`, recreated when the existing container runs another image), `tests/integration/setup.ts` (`truncateAll`), README's test-container sentence (`README.md:384-385`), unit tests for state, integration tests for the repo + migration (`tests/integration/schema.int.test.ts` extension, incl. pgvector >= 0.8).
**Does not touch:** config, embedder, worker, search, MCP.
**Exit criteria:** migration applies on a fresh pgvector container and re-applies as a no-op; the installed `vector` extension is >= 0.8; the JS and SQL hashes agree on ASCII, emoji and CRLF bodies; `listPending` / `saveEmbedding` / `recordFailure` / `embeddingStats` behave per the contract.

### Phase 2 — OpenRouter embedder, config, deps wiring, fake embedder
**Satisfies:** R1 (the client), R6 (fake-fetch, config and fake-embedder unit tests)
**Owns:** `src/embeddings/embedder.ts`, `src/embeddings/openrouter.ts`, `src/config.ts` (`embeddings`), `src/deps.ts`, `src/daemon.ts` (build embedder, `StartDaemonOptions.embedder`), `src/notes/service.ts` (constructor deps only), every existing test `Config` / `AppDeps` literal (6 integration files) and `tests/live/chat.live.test.ts` (`embedder: null`; no other phase touches it), `tests/helpers/fakeEmbedder.ts`, unit tests (fake fetch; config; fake embedder).
**Does not touch:** schema, background, search logic, MCP tools.
**Exit criteria:** every error path of run-insights' module has a unit test against a fake `fetch`; batching preserves order; the daemon starts with no key (`deps.embedder === null`) and with an injected fake.

### Phase 3 — Embedding worker, background backfill, `embed:backfill`
**Satisfies:** R3, R1 (write paths enqueue, retry), R6 (worker / backfill / CLI tests)
**Owns:** `src/embeddings/worker.ts`, `src/embeddings/backfill.ts`, `src/background.ts`, `src/cli/embedBackfill.ts`, `package.json` (`embed:backfill`), `tests/helpers/memoryEmbeddingStore.ts`, worker / backfill / CLI unit tests, integration tests (create/update/append/revert/image note get embedded; failure keeps the write and retries; backfill resumable; deleted notes keep vectors; restore makes no call).
**Does not touch:** `src/notes/service.ts`, `src/main.ts`, search, MCP.
**Exit criteria:** with the fake embedder, every write path ends with a current vector after `idle()`; a failing embedder leaves writes intact and the note retried after backoff; stopping mid-backfill and restarting finishes without re-embedding finished notes; idle worker logs nothing; `close()` returns within its 5 s grace even when a call hangs.

### Phase 4 — Hybrid search + labelled set
**Satisfies:** R4, R6 (blend unit tests, hybrid-vs-text and fallback integration tests)
**Owns:** `src/search/blend.ts`, `src/search/queryVector.ts`, `src/notes/repo.ts` (`searchCandidates`), `src/notes/service.ts` (`search`, `textSearch`, imports), `src/notes/types.ts` (`SearchMode`, `SearchPage`), `src/mcp/tools.ts` (`search` only), `src/mcp/instructions.ts` (`Reading.` paragraph), `tests/unit/mcp.instructions.test.ts` (one `it`), `tests/fixtures/semantic/labelled.ts`, unit + integration tests.
**Does not touch:** worker, `related`, chat files, web.
**Exit criteria:** hybrid beats text-only on the labelled set (stated metric); exact id and rare code token at rank 1; failing query embed → `mode: 'text'` + `fallback`; `mode: 'text'` matches today's ordering.

### Phase 5 — `related` tool
**Satisfies:** R5, R6 (related integration tests)
**Owns:** `nearestNotes` in `src/embeddings/repo.ts` (+ merged imports), `NotesService.related` / `embedNow` (+ merged imports), `src/notes/types.ts` (`RelatedNote`, `RelatedResult`, `not_embedded`), the `related` tool in `src/mcp/tools.ts`, the `Related.` element in `src/mcp/instructions.ts`, one `it` in `tests/unit/mcp.instructions.test.ts`, `src/chat/status.ts` + `tests/unit/chat-status.test.ts`, `tests/integration/related.int.test.ts`.
**Does not touch:** search ranking, web.
**Exit criteria:** related never returns the note itself or a deleted note; ignores stale and other-model vectors; embeds an unembedded source once on demand; `not_embedded` without an embedder or on embed failure; textless photo → `invalid_input`; chat allow list is 14 + 15 + 2.

### Phase 6 — Live test, docs, Neon migration + first backfill
**Satisfies:** R6 (live test), acceptance
**Owns:** `tests/live/embeddings.live.test.ts`, `vitest.config.ts`, `package.json` (`test:live:embeddings`), README (all but phase 1's test-container sentence), `docs/INSTALL.md`, `claude/skills/n/SKILL.md`; `docs/ROADMAP.md` checked, no change (it has no status column); may retune the constants in `src/search/blend.ts` if the live run demands it (keeping phase 4's tests green); runs `npm run db:migrate` against Neon and `npm run embed:backfill`.
**Does not touch:** any other source file.
**Exit criteria:** live test passes once against OpenRouter (one request) with both usage examples ranked first by raw similarity and through the blend; Neon has the `vector` extension (0.8.6), `note_embeddings` and its HNSW index; backfill ends with `done: … 0 pending` and the independent query agrees.

## Reconciliation Log

Round 1, 2026-10-30. 24 conflicts found, 24 resolved; no interface moved between phases.

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | Phase 2 imports `src/embeddings/constants.ts` (phase 1) but depended on nothing | Broken-build phase / unmet assumption | Phase 2 depends on phase 1 (already decided); its blocker section replaced by a build-order note. Phase 2 now also imports `embedInput` from phase 1's `state.ts` (row 2) |
| 2 | Phase 2 clamped inputs with a plain slice and its handoff said phase 1's `embedInput` was not surrogate-safe; phase 1's is | Contract drift | Phase 2 `prepareInputs` calls `embedInput`; handoff corrected; one clamp rule |
| 3 | Worker `close()` waits for an in-flight call (15 s OpenRouter timeout) but `src/main.ts` force-exits at 10 s | Contract drift (shutdown) | Phase 3: `close()` waits at most `DEFAULT_CLOSE_GRACE_MS = 5_000`, new `closeGraceMs` option + unit test; `main.ts` and phase 2's timeout unchanged |
| 4 | Phase 2 names `embeddingErrorText` as the `last_error` text; phase 3 stored `err.message`, dropping the transport cause | Contract drift | Phase 3 `errorMessage` uses `embeddingErrorText` for an `EmbeddingError` (minus the class prefix), plain message otherwise; phase 3 tests unchanged; phase 1 handoff updated |
| 5 | Phase 6's expected `embed:backfill` output (`pending 0`, batches of 32, "CLI ignores the backoff") did not match phase 3's format strings, batch size 16 or flag | Contract drift | Phase 6 Requires, Step 10 and INSTALL rewritten to phase 3's exact lines, exit codes and `-- --retry-failed` |
| 6 | Phase 6's live-test adapter written against assumed phase 4 names | Unmet assumption | Verified against phase 4's code blocks: `BLEND.minSimilarity`, `BlendCandidate`, `rankCandidates`, `LABELLED_NOTES/QUERIES` match; Requires text corrected (`Ranked<T>[]`, optional `exactId`) |
| 7 | Phase 6 assumed `embed()` makes one request | Unmet assumption | Pinned: 26 inputs ≤ `OPENROUTER_EMBED_MAX_BATCH` (64); live test asserts the bound before `fetchCalls === 1` |
| 8 | Phase 5 assumed the fake's lexicon is `string[][]` and that the fake's model may differ from `EMBEDDING_MODEL` | Unmet assumption | Phase 2's `Lexicon` is `readonly (readonly string[])[]` with `*` prefixes (compatible); phase 5's `LEXICON` typed as `Lexicon`; model comment corrected |
| 9 | `src/notes/service.ts` imports edited by phases 2, 4, 5 | File collision | Phase 4 Step 5a and phase 5 Step 3(a) quote the full merged import block in order |
| 10 | `src/embeddings/repo.ts` created by 1, extended by 5 with "merge whatever is there" | File collision | Phase 5 Step 1 quotes the full merged import block |
| 11 | `src/mcp/instructions.ts` and `tests/unit/mcp.instructions.test.ts` edited by 4 then 5; phase 5 anchored on wrong lines (`:331`, `:24`) | File collision | Phase 5 anchors corrected: `Related.` before `Dates.` (`:24`) after phase 4's `Reading.` (`:22`); its test after phase 4's |
| 12 | README edited by 1 (test-container sentence) then 6 (same paragraph) | File collision | Phase 6 Step 4d quotes the post-phase-1 paragraph and notes the +1 line shift after `:385` |
| 13 | `package.json` edited by 3 (`embed:backfill` after `db:check`) and 6 (`test:live:embeddings` after `test:live:connectors`) | File collision | Different lines; verified, no change needed |
| 14 | Phase 6 docs said `related` is off without a key; phase 5 answers from stored vectors and errors only for an unembedded source | Contract drift | Phase 6 README / INSTALL wording and phase 2's `loadConfig` comment follow phase 5 |
| 15 | Phase 3 asked for docs of `--retry-failed`, exit codes and daemon log lines; phase 6 had none | Gap | Added to phase 6's INSTALL section 6 |
| 16 | Phases 4 and 5 need pgvector >= 0.8 (`hnsw.iterative_scan`); nothing asserted it | Gap | Phase 1's schema test asserts `extversion` >= 0.8 (test image 0.8.7, Neon 0.8.6); recorded in the Contract |
| 17 | Phases 1 and 3 write R6 tests without R6 on their Satisfies line | Requirement creep | R6 added to phases 1 and 3 (and to the table for 2, 4, 5, which already said so in prose) |
| 18 | `tests/live/chat.live.test.ts` edited by phase 2 | File collision check | No other phase touches it; recorded in phase 2's Owns |
| 19 | `Config` / `AppDeps` literals added in phases 3–5 | Unmet assumption check | Phase 3 (`config()`, `deps()`, CLI `noKey`) and phase 5 (`config`, `deps`) carry `embeddings` / `embedder`; phase 4 builds none; phase 2's list matches a grep of the tree |
| 20 | Phase 1 fragments render real table names; phases 4/5 must not alias | Unmet assumption check | Phase 4 `searchCandidates` and phase 5 `nearestNotes` are unaliased (phase 5's `src` alias is inside a subquery with no fragment); phase 5 hedge removed |
| 21 | Phase 3 CLI asserts `20 pending` for notes with no row and a retry hint after a failure | Unmet assumption check | Matches phase 1: `pending = withText - current`, `failing` = failure rows for the current body + model |
| 22 | Phases 3, 4, 5 use the fake embedder's members | Unmet assumption check | Phase 3 wraps it in its own probe; phase 4 uses `vectorFor`, `calls`, mutable `delayMs`, `failNext`, `reset`; phase 5 uses `calls`, `failNext`; all exist in phase 2 |
| 23 | Index assigned `docs/ROADMAP.md` to phase 6; phase 6 found nothing to change | Gap check | Recorded as "checked, no change" (row 6 has no status column) |
| 24 | Index Owns lists missed files (phase 4 `queryVector.ts`, instructions test; phase 5 `types.ts`, instructions test) | Contract drift | Owns lists rewritten from the plans' Files tables |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Vector column on `notes` vs side table | side table `note_embeddings` — `db.select().from(notes)` is used by every list/get; a 1536-float column would ride on all of them | 6: surrounding convention (brief leaves it to the planner) |
| How "needs an embedding" is marked | derived: missing row, hash/model mismatch, or failure row due; no flag on `notes` | 5: user input ("store which body it was made from … so a stale vector is detectable") |
| What triggers embedding after a write | `NoteEvents` (fires after commit) kicks the worker; a periodic sweep catches the other machine's writes and retries | 2: exit criteria / invariant 2 (no write awaits an embedding) |
| Deleted-before-embedded notes | pending includes deleted notes, so restore never needs a call | 5: user input ("restore must not need a new call") |
| Model change | stale by `model` column, re-embedded automatically; `embed:backfill` drains it | 5: user input ("for the first run and for a model change") |
| Where blending happens | TypeScript over a bounded candidate set (FTS matches ∪ vector top-K, same filters) — pure, unit-testable | 5: user input (unit tests for the blending) |
| Tuning weights without network in tests | phase 4 tunes on the labelled set with the concept-bag fake; phase 6's live test runs the same set through the real model once and may retune the constants | 5: user input (no network in `npm test`/`test:int`; one live test) |
| Integration container switch | detect image mismatch and recreate `mcp-notes-pg-test` (test-only data) | 6: surrounding convention (`test-int.sh` reuses by name) |
| Apply 0001 to Neon unattended | yes, in phase 6, after all tests pass — additive (extension + new table), rollback is `drop table` | 5: user input ("must apply cleanly to the live Neon database") |
| Phase 2 imports `src/embeddings/constants.ts` owned by phase 1 | phase 2 depends on phase 1 (not byte-identical duplicate files) | 1: invariant 1 (every phase builds on its own) |
| `/n` skill text | update its search description and mention `related`; no other skill change | 5: user input ("`/n` … need no change beyond that") |
| Where the 8 000-char clamp lives (phase 2 slice vs phase 1 `embedInput`) | `embed()` calls phase 1's surrogate-safe `embedInput`; one rule | 3: plan code blocks (index contract defines `embedInput` as the clamp) |
| Worker shutdown vs `main.ts` 10 s forced exit (OpenRouter timeout 15 s) | `close()` waits at most 5 s for the in-flight batch, then abandons it (note stays pending); `main.ts` and the 15 s timeout unchanged | 6: surrounding convention (`main.ts`'s 10 s budget, `startDaemon` stop order) |
| Text stored in `last_error` | `errorMessage(err)`: `embeddingErrorText` for an `EmbeddingError` (keeps the transport cause), plain message otherwise; clamped/redacted by `recordFailure` | 3: plan code blocks (phase 2's contract names `embeddingErrorText` for `last_error`) |
| `related` without `OPENROUTER_API_KEY` (docs said "off", phase 5 answers from stored vectors) | phase 5's behavior; docs follow it | 2: phase 5 exit criteria + code block |
| pgvector version | >= 0.8 required and asserted in phase 1's schema test | 3: plan code blocks (phases 4 and 5 `set local hnsw.iterative_scan`); user input (Neon 0.8.6) |
| Phases 4 / 5 seeding vectors without phase 3 | both seed with phase 1's `saveEmbedding`; no 3 → 4/5 edge | 1: invariant 1 (each phase builds and tests on its own) |

## Open Questions

(none)

## Rollback

Per phase: revert the phase's commit. Whole set: revert the merge; on Neon `drop table note_embeddings;` (the `vector` extension may stay). No other table is altered.

## Next

    /implement -f docs/plans/SEMANTIC_SEARCH_PLAN.md --phase 1

Or run the whole set as a swarm:

    /analyze-orchestrator -f docs/plans/SEMANTIC_SEARCH_PLAN.md
