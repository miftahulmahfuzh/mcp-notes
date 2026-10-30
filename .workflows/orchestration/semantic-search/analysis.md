# Code Analysis: Semantic search (mcp-notes iteration 6)

**Type:** Feature Implementation
**Date:** 2026-10-30T14:05:13+07:00
**Session ID:** 20261030-140513-S6EM
**Plan:** `docs/plans/SEMANTIC_SEARCH_PLAN.md` (6 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/semantic-search`, branch `feature/semantic-search` (base `origin/main` @ `66b8e98`)

---

## User Input

### Original User Request

Source: `docs/iterations/06-semantic.md`, everything below its `---` line, verbatim:

```

Build mcp-notes iteration 6 ("Semantic") from docs/ROADMAP.md. The "Fixed decisions" table in
docs/ROADMAP.md is binding: do not re-decide anything in it, in particular the "Semantic search"
row (pgvector on the notes DB, embeddings via OpenRouter as run-insights does, hybrid ranking:
full-text + tags + recency + vector). Iterations 1–5 are on main (plans in docs/plans/).

The usage examples this iteration exists for:
  /n check our notes, have we met this kind of accidents before? maybe we already have a solution for this
  /n find a relevant notes that talks about ArangoDB credentials
Today `search` is Postgres full text ('simple' config) plus tags and dates, so a note only comes
back when it shares words with the question. A note saying "arango root password is in the
vault" must come back for "ArangoDB credentials", and "the login broke after the laptop slept"
must come back for "have we seen auth failures after resume before?".

R1 — Embeddings. Follow how ~/run-insights does it (read its lib/ for the embedding module:
OpenRouter's /embeddings endpoint, `openai/text-embedding-3-small`, 1536 dimensions, its input
cap and its error handling); do not import its code. The key is `OPENROUTER_API_KEY` in this
repo's .env.local. Every note's body is embedded on create, update, append and revert, after the
write commits, so a slow or failing embedding call never blocks or fails a note write: the note is
saved, marked as needing an embedding, and retried later. A note's embedding always matches its
current body (store which body it was made from, e.g. a hash, so a stale vector is detectable).
Image notes embed their text; a photo note with no text has no embedding. Deleted notes keep
their vector (restore must not need a new call) but never appear in results.

R2 — Schema. pgvector on the notes database: `create extension vector`, a vector column (or a
side table, planner's choice) with an HNSW index for cosine distance. This is the first migration
since iteration 1. It must apply cleanly to the live Neon database (pgvector 0.8.6 is available
there) and to the test Postgres; the integration test container needs an image that ships
pgvector (e.g. pgvector/pgvector:pg16) instead of plain postgres:16.

R3 — Backfill. Notes that existed before this iteration, and notes whose embedding failed, get
embedded by a background job inside notesd (same lifecycle as the inbox watcher): batched,
rate-limited, resumable, logged, and quiet when there is nothing to do. Plus a one-shot command
(`npm run embed:backfill`) that does the same and prints progress, for the first run and for a
model change.

R4 — Hybrid search. `search` ranks by a blend of full-text rank, vector similarity, tag match and
recency, with the existing filters (tags any/all, date ranges, has_image, taken dates) applied
before ranking. A query with no word overlap still finds semantically close notes; an exact id
or a rare code token still ranks first (full text must not be drowned by the vector side). If
the embedding call for the query fails, search falls back to today's full-text ranking and says
so in the result, instead of erroring. The weights live in one place with a short comment on
why each is what it is; tune them against a small labelled set of example notes and queries
kept in the tests (include the two usage examples above in the set, in spirit).
The MCP `search` tool keeps its name and inputs (optionally a `mode`: hybrid by default,
`text` for exact-word search); its description and the server instructions say it now
understands meaning, not only words. `/n` and the chat bar need no change beyond that, but the
chat bar's status caption for search stays "searching notes".

R5 — Related notes. A `related` MCP tool: given a note id, the nearest notes by meaning, with a
similarity score, excluding the note itself. In the web UI, nothing changes in this iteration
(no new buttons), so the design stays as it is.

R6 — Tests. Unit tests for the blending and the stale-embedding logic with a fake embedder.
Integration tests on the pgvector container with a deterministic fake embedder (no network in
`npm test` or `test:int`): write paths enqueue and fill embeddings, a failed embedding does not
fail the write and is retried, backfill is resumable, hybrid search beats text-only on the
labelled set, query-embedding failure falls back to text. One opt-in live test
(`EMBEDDINGS_LIVE_TEST=1`, excluded by default) calls OpenRouter for real once.

Acceptance (with a handful of real notes written first, through `/n` in Claude Code and the
chat bar):
  /n check our notes, have we met this kind of accidents before? maybe we already have a solution for this
  /n find a relevant notes that talks about ArangoDB credentials
  /n what other notes are related to <id>?
  (chat bar) anything in my notes about sleep and tiredness?

Out of scope: any UI change, semantic search over the connector systems (expenses, runs, Seer),
image embeddings (pictures are found by their text and dates), a separate vector database,
re-ranking with an LLM.
```

### User-Provided Context
- `docs/ROADMAP.md` "Fixed decisions" table is binding. Its "Semantic search" row: *pgvector on the notes DB, embeddings via OpenRouter (as run-insights does), hybrid ranking: full-text + tags + recency + vector.*
- Iterations 1–5 are on main; their plans are in `docs/plans/`.
- Neon has pgvector 0.8.6 available.

### User-Provided Files
None marked with `@`. Named in prose: `docs/ROADMAP.md`, `~/run-insights/lib/` (embedding module), `.env.local` (`OPENROUTER_API_KEY`).

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Embeddings: OpenRouter `/embeddings`, `openai/text-embedding-3-small`, 1536 dims, run-insights' input cap and error handling (not its code); embed on create/update/append/revert after commit, never blocking or failing a write; failed → marked and retried; embedding tied to the body it was made from (hash) so staleness is detectable; image notes embed their text, textless photo has none; deleted notes keep their vector and never appear |
| R2 | Schema: `create extension vector`, vector column or side table, HNSW cosine index; first migration since iteration 1; applies cleanly to live Neon and test Postgres; integration container image ships pgvector |
| R3 | Backfill: background job in notesd (inbox-watcher lifecycle), batched, rate-limited, resumable, logged, quiet when idle; plus `npm run embed:backfill` one-shot with progress (first run, model change) |
| R4 | Hybrid search: blend of full-text rank, vector similarity, tag match, recency; existing filters applied before ranking; no-overlap queries find close notes; exact id / rare code token still first; query-embedding failure → text ranking and the result says so; weights in one place with comments, tuned against a labelled set in the tests (incl. the two usage examples); `search` keeps name and inputs, optional `mode` (`hybrid` default, `text`); description and server instructions say it understands meaning; chat caption stays "searching notes" |
| R5 | `related` MCP tool: note id → nearest notes by meaning with a similarity score, excluding itself; no web UI change |
| R6 | Tests: unit (blending, stale logic, fake embedder); integration on the pgvector container with a deterministic fake embedder (write paths enqueue+fill, failed embedding retried without failing the write, backfill resumable, hybrid beats text-only on the labelled set, query-embedding failure falls back); one opt-in live test `EMBEDDINGS_LIVE_TEST=1` |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** `search` today is `websearch_to_tsquery('simple', q)` matched against `to_tsvector('simple', body)` (`src/notes/repo.ts:159-173`). A note is returned only when it shares a literal token with the query. The iteration adds a vector representation of every note body, a way to keep it current without touching the write path's latency or failure modes, and a ranking that blends four signals so meaning-only matches surface while literal matches (ids, code tokens) stay on top.

**Success Criteria.**
- "arango root password is in the vault" is returned for "ArangoDB credentials"; "the login broke after the laptop slept" is returned for "have we seen auth failures after resume before?" (real model; asserted by the opt-in live test and by the acceptance prompts).
- With the fake embedder, the integration labelled set scores strictly better under `hybrid` than under `text`, and an exact id / rare code token query returns that note at rank 1 in both modes.
- A note write succeeds and returns in the same time whether OpenRouter is up, slow or down; the note is embedded later.
- `search` with an unreachable embedder returns the full-text ranking plus a field saying it degraded.
- `related(id)` returns other live notes with a similarity in [−1, 1], never the note itself, never a deleted note.
- `npm test` and `npm run test:int` make no network call; `npm run test:int` runs on `pgvector/pgvector:pg16`.
- `drizzle/0001_*.sql` applies to Neon and to the test DB with `drizzle-kit migrate` / the vitest globalSetup.

**Key Considerations.**
- Two daemons (Lenovo, GPD) share one Neon DB. Both may run the worker. Upserts keyed by note id and guarded by the body hash make double work harmless.
- `NoteEvents` is in-process only; a note written by the *other* machine is never seen as an event here, so a periodic sweep is required, not optional.
- `db.select().from(notes)` is used everywhere (`repo.ts` list/search/get). A 1536-float column on `notes` would ride along on every list and every `NoteRow`. A side table avoids that.
- The MCP `search` result shape `{ notes, next_cursor }` is consumed by Claude only; adding fields is non-breaking.
- `Config` literals are constructed in tests (`tests/integration/helpers/api-harness.ts:46`, and others) — a new required `Config` field breaks them.
- `.env.local` is gitignored; a fresh worktree has none. `drizzle.config.ts` throws without a direct URL even for `generate`, and the live test needs `OPENROUTER_API_KEY`.
- `scripts/test-int.sh` reuses an existing container by name (`mcp-notes-pg-test`, image `postgres:16`); simply changing `NOTES_IMAGE` would keep running the old image.
- The chat agent's tool allow list is exact (`src/chat/status.ts:48`, test asserts 13 + 15 + 2).

**Assumptions (stated, planned against).**
- A1. Side table `note_embeddings`, not a column on `notes` (brief leaves it to the planner; chosen for the `select()` reason above).
- A2. Staleness = stored `body_sha256` (hex sha256 of the UTF-8 body) or stored `model` differs from the current body/model. A model change therefore re-queues everything automatically.
- A3. The worker is driven by `NoteEvents` (fast path, this machine's writes) plus a periodic sweep (other machine's writes, retries, backfill). Same lifecycle as the inbox watcher in `src/background.ts`.
- A4. Hybrid blending happens in TypeScript over a bounded candidate set (full-text matches ∪ vector top-K, both under the same filters), so the blend is a pure, unit-testable function.
- A5. Without `OPENROUTER_API_KEY` the embedder is null: writes are unaffected, the worker logs once and idles, `search` reports text fallback, `related` returns a clear error.
- A6. The fake embedder for tests is a deterministic "concept bag": words map to concept axes through a lexicon, so meaning-without-word-overlap is testable offline.

---

## Analysis Scope

### Explicitly Mentioned Files
- `docs/ROADMAP.md`
- `~/run-insights/lib/nina/embedding.ts`, `~/run-insights/lib/nina/openrouter.ts` (reference only, not imported)

### Discovered Related Files
- `src/db/schema.ts` — notes + note_revisions; header says "no later phase adds a migration" (iteration 1–3 rule; this iteration is the first new migration)
- `drizzle/0000_init.sql`, `drizzle/meta/_journal.json`, `drizzle/meta/0000_snapshot.json`, `drizzle.config.ts`
- `src/db/client.ts` — `createDb` (Neon websocket pool vs node-postgres)
- `src/notes/service.ts` — the only writer; `finish()` emits events after commit (`:267-270`)
- `src/notes/repo.ts` — `filterConditions` (`:111-138`), `searchNotes` (`:159-173`), cursor = offset
- `src/notes/events.ts` — `NoteEvents` ('created' | 'updated' | 'deleted' | 'restored')
- `src/notes/types.ts` — `Note`, `NotePage`, `NoteError`
- `src/background.ts` — `startBackground(deps)` starts the inbox watcher, returns a stop fn
- `src/daemon.ts` — wiring: db → events → service → app → listen → background
- `src/deps.ts` — `AppDeps { config, db, events, service }`
- `src/config.ts` — `loadConfig`; `OPENROUTER_API_KEY` explicitly ignored today (`:196`)
- `src/mcp/tools.ts` — `search` tool (`:255-269`), `ToolDeps`, `noteFilterShape`, `toFilter`
- `src/mcp/instructions.ts` — "Reading." paragraph describes search as full text only (`:329`)
- `src/mcp/server.ts`, `src/http/app.ts:46` — ToolDeps built from AppDeps
- `src/chat/status.ts` — `NOTES_TOOL_NAMES` (13), `allowedChatTools`, captions (`search` → "searching notes")
- `src/images/ingest.ts`, `src/images/inbox.ts` — image notes are created through `service.create` (event fires)
- `src/http/api.ts:139,154` — web create/update through the service (events fire)
- `scripts/test-int.sh`, `vitest.config.ts`, `tests/integration/setup.ts`, `tests/integration/globalSetup.ts`
- `tests/integration/helpers/api-harness.ts` — builds a `Config` literal
- `tests/unit/chat-status.test.ts`, `tests/unit/mcp.instructions.test.ts`, `tests/unit/config.test.ts`
- `claude/skills/n/SKILL.md` — describes `search` as full text
- `README.md` (`:433`, `:481`, `:503`), `docs/INSTALL.md`, `docs/ROADMAP.md`

---

## Current Dataflow

### Entry Point: MCP `search`
**Location:** `src/mcp/tools.ts:255-269`
**Trigger:** POST `/mcp` (stateless streamable HTTP, `src/mcp/server.ts:28`) → tool call `search`
**Input Schema:** `{ query: string(min 1), tags_any?, tags_all?, date_field?, from?, to?, has_image?, taken_from?, taken_to?, deleted?, limit?(1-200, default 50), cursor? }`
**Validation:** zod; `toFilter` maps snake_case → `NoteFilter`
**Next Step:** `service.search(query, filter)` (`src/notes/service.ts:165`)

### Processing Chain
1. `NotesService.search` — rejects blank query (`NoteError('invalid_input')`), calls `repo.searchNotes`, maps rows with `rowToNote`.
2. `repo.searchNotes` (`src/notes/repo.ts:159`) — `WHERE to_tsvector('simple', body) @@ websearch_to_tsquery('simple', q) AND <filterConditions>` `ORDER BY ts_rank DESC, updated_at DESC, id DESC LIMIT limit+1 OFFSET cursor`. Uses `notes_body_fts_gin`.
3. `filterConditions` — deleted (default exclude), tags any/all (GIN), date range on created/updated, has_image, taken_at text range.
4. Result `{ notes: Note[], next_cursor: string|null }` → `jsonResult` (pretty JSON text).

### Entry Point: note writes
**Locations:** `NotesService.create/update/append/revert/delete/restore` (`src/notes/service.ts:98-256`). Callers: MCP tools (`src/mcp/tools.ts`), HTTP api (`src/http/api.ts:139,154`), image ingest (`src/images/ingest.ts` via `ImageNotes`).
**Transform:** body → `parseTags(body)`; previous body → `note_revisions` in the same transaction.
**Exit:** `finish()` emits `NoteEvents.emit(op, id)` **after** the transaction resolves; returns `Note`. No-op writes (same body) emit nothing.

### Background
`startBackground(deps)` (`src/background.ts:13`) — ensures data dirs, starts chokidar inbox watcher, returns `async () => inbox.close()`. Called from `startDaemon` after `listen` (`src/daemon.ts:95`), stopped first in `stop()`.

### Data Persistence
- `notes` (id text PK, body, tags text[], image_path, image_meta jsonb, origin jsonb, created_at, updated_at, deleted_at). Indexes: tags GIN, `to_tsvector('simple', body)` GIN, created/updated btree, live sha256 unique, taken_at.
- `note_revisions` (bigserial id, note_id FK cascade, body, saved_at).
- Migrations: drizzle-kit, `drizzle/0000_init.sql` only; applied to Neon via `npm run db:migrate` (direct host), to tests via `migrate()` in `tests/integration/setup.ts:45`.

### Exit Points
- MCP JSON text results; errors via `errorResult` (`isError: true`, `code: message`).
- SSE `/api/events` from `NoteEvents` (web UI).

---

## Key Data Structures

### `NoteFilter` — `src/notes/repo.ts:19-42`
Shared by list and search; `limit` (clamped 1..5000), `cursor` (base64url `{o: offset}`).

### `NotePage` — `src/notes/types.ts:58`
`{ notes: Note[]; next_cursor: string | null }`.

### `AppDeps` — `src/deps.ts:7`
`{ config, db, events, service }`; built in `daemon.ts:65` and in test harnesses.

### `ToolDeps` — `src/mcp/tools.ts:10`
`{ service, dataDir, db, connectors? }`; built in `src/http/app.ts:46`.

### `Config` — `src/config.ts:56`
`{ databaseUrl, port, host, dataDir, chat }`. Test literals: `tests/integration/helpers/api-harness.ts:46` and wherever `DEFAULT_CHAT_CONFIG` is imported.

### Reference: run-insights embedding (not imported)
`~/run-insights/lib/nina/embedding.ts`: one `fetch` POST to `https://openrouter.ai/api/v1/embeddings`, body `{ model: 'openai/text-embedding-3-small', input, encoding_format: 'float' }`, `Authorization: Bearer`, `AbortSignal.timeout(15_000)`. Input: trim, clamp to 8 000 chars (truncate, no marker); empty input throws before any call. Response read as text then `JSON.parse`; errors (missing key, transport/timeout, non-JSON, non-2xx, no `data[0].embedding`, wrong width or non-finite element) each throw one error class with a ≤300-char response snippet. Width checked against the column's dimension constant (1536). Model + dimension change together with a migration and full re-embed. Query ordering `ORDER BY embedding <=> $q::vector` (HNSW `vector_cosine_ops`), similarity projected as `1 - distance`; vector bound as `JSON.stringify(v)` with `::vector` cast.

---

## Dependencies

- **Configuration / env:** `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (by host), `OPENROUTER_API_KEY` (present in `.env.local`, currently ignored), `NOTES_DATA_DIR`, `NOTESD_PORT`, chat keys.
- **External services:** Neon Postgres (pgvector 0.8.6 available); OpenRouter embeddings (new).
- **npm:** `drizzle-orm` 0.45.2 exports `vector` in `pg-core` and `cosineDistance`; `drizzle-kit` 0.31.10 generates `vector(n)` columns and `hnsw` indexes but not `CREATE EXTENSION` (run-insights hand-edits its migration for that).
- **Docker:** `pgvector/pgvector:pg16` is already used by the connectors container in `scripts/test-int.sh`.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `searchNotes` | `src/notes/repo.ts:159` | def | notes |
| `filterConditions` | `src/notes/repo.ts:111` | def (reused by hybrid) | notes |
| `NotesService.search` | `src/notes/service.ts:165` | def | notes |
| `NotesServiceDeps` | `src/notes/service.ts:22` | def | notes |
| `new NotesService(` | `src/daemon.ts:64`, `tests/integration/helpers/api-harness.ts:43`, `tests/integration/notes.service.int.test.ts:15`, other int tests | call | daemon, tests |
| `finish()` / `events.emit` | `src/notes/service.ts:267` | def (event after commit) | notes |
| `NoteEvents` | `src/notes/events.ts:57` | def | notes |
| `startBackground` | `src/background.ts:13`, `src/daemon.ts:95` | def, call | daemon |
| `AppDeps` | `src/deps.ts:7` | def | daemon |
| `Config`, `loadConfig` | `src/config.ts:56,200` | def | config |
| `OPENROUTER_API_KEY` | `src/config.ts:196` (comment), `.env.local` | config | config |
| `search` tool | `src/mcp/tools.ts:255` | def | mcp |
| `toolDeps` | `src/http/app.ts:46` | call | http |
| `buildInstructions` "Reading." | `src/mcp/instructions.ts:329` | doc string | mcp |
| `NOTES_TOOL_NAMES`, `allowedChatTools` | `src/chat/status.ts:17,48` | def | chat |
| chat-status count test | `tests/unit/chat-status.test.ts:8-12` | test | tests |
| `NOTES_IMAGE=postgres:16` | `scripts/test-int.sh:20` | config | scripts |
| `migrateTestDb` | `tests/integration/setup.ts:45` | test infra | tests |
| `truncateAll` | `tests/integration/setup.ts:55` | test infra | tests |
| `drizzle/meta/_journal.json` | — | migration meta | drizzle |
| search description | `claude/skills/n/SKILL.md:31,66` | doc | skill |
| search docs | `README.md:63,433,481,503`, `docs/INSTALL.md`, `docs/ROADMAP.md` | doc | docs |

---

## Impact Points (files that WILL need changes)

1. `src/db/schema.ts` — `note_embeddings` table + HNSW index — phase 1
2. `drizzle/0001_*.sql` + `drizzle/meta/*` — new migration, hand-prepended `CREATE EXTENSION IF NOT EXISTS vector` — phase 1
3. `scripts/test-int.sh` — notes container on `pgvector/pgvector:pg16`, recreate on image mismatch — phase 1
4. `tests/integration/setup.ts` — `truncateAll` includes `note_embeddings` — phase 1
5. `src/embeddings/state.ts`, `src/embeddings/repo.ts` (new) — body hash, staleness, upsert/failure/pending queries — phase 1
6. `src/embeddings/embedder.ts`, `src/embeddings/openrouter.ts` (new) — `Embedder` interface, OpenRouter client — phase 2
7. `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `src/notes/service.ts` (deps only) — embeddings config + embedder wiring — phase 2
8. `tests/helpers/fakeEmbedder.ts` (new) — deterministic concept-bag embedder — phase 2
9. `src/embeddings/worker.ts`, `src/embeddings/backfill.ts`, `src/background.ts`, `src/cli/embedBackfill.ts`, `package.json` — worker + one-shot — phase 3
10. `src/search/blend.ts` (new), `src/notes/repo.ts`, `src/notes/service.ts` (search), `src/notes/types.ts`, `src/mcp/tools.ts` (search), `src/mcp/instructions.ts` — hybrid search — phase 4
11. `src/embeddings/repo.ts` (nearest), `src/notes/service.ts` (related), `src/mcp/tools.ts` (related tool), `src/mcp/instructions.ts`, `src/chat/status.ts` — related — phase 5
12. `tests/live/embeddings.live.test.ts`, `vitest.config.ts`, `package.json`, `README.md`, `docs/INSTALL.md`, `docs/ROADMAP.md`, `claude/skills/n/SKILL.md`; Neon migration + first backfill — phase 6

**This document describes. The plan files prescribe.**
