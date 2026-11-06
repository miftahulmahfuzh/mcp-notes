# Code Analysis: dword-connector (connect mcp-notes to daily-words)

**Type:** Feature Implementation
**Date:** 2026-11-06T07:01:15+07:00
**Session ID:** 20261106-070115-DW6C
**Plan:** `.workflows/plan/DWORD_CONNECTOR_PLAN.md` (6 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/dword-connector`, branch `feature/dword-connector` (base `origin/main` @ `2df19b9`)

---

## User Input

### Original User Request

Retrieved from mcp-notes note [G-NPQ](http://localhost:7317/?note=G-NPQ), verbatim (the note's own
header line, "paste into the analyze tmux session", is the note author's handling instruction, not
part of the request):

> /analyze dword-connector feature --phases 6
> Read docs/plans/2026-11-05-dword-connector-design.md first. It is an agreed design from a
> discussion, so do not re-run the discussion. Decisions D1 to D5 in section 2 are closed: direct
> allow-listed SQL writer (like src/adversary/seerWriter.ts), Claude writes the explanation itself,
> a near-duplicate journal entry is shown and nothing is inserted unless "save anyway", a sentence
> is attached to a known word only when it has no origin, wall chat is in the same plan as the last
> phase.
>
> Separator: /v uses a single ">" between the term and the sentence (not "->"). Split on the first
> ">", trim both sides.
>
> Goal: connect mcp-notes to ~/daily-words (dword) so /v <word or phrase> [> <sentence>] looks up or
> adds a vocab_entries row, and /j <wise words> looks up or adds a journal_entries row, from Claude
> Code and from the wall chat. No UI.
>
> Do these in the analysis, and record evidence for each in the plan:
> 1. Verify every fact in section 3 of the design against ~/daily-words (schema, limits, constants,
>    queries, migrations) and section 4 against this repo. Correct the design where a fact is wrong.
> 2. Settle the open items in sections 5.3 and 5.7. For 5.3 (journal similarity), measure on the real
>    journal READ-ONLY: is OpenRouter's text-embedding-3-small comparable to the vectors dword stored
>    (check journal_entry_embeddings.model), what distances do real near-duplicates give, and is the
>    0.25 threshold usable from mcp-notes. If not, specify the lexical shortlist fallback. For 5.7,
>    read dword's own add path to decide what an English term with a "> sentence" stores (the CHECK
>    needs origin_term when origin_context is set).
> 3. Decide how the dword users row is resolved from DWORD_USER_EMAIL, and what the tools do when it
>    is missing or unknown.
> 4. Specify the exact SQL for every write and the assertWritable allow-list rules, parameterised
>    only.
> 5. Specify how tests run against a throwaway Postgres rebuilt from dword's drizzle/ migrations
>    (follow the existing connector integration tests, skip when ~/daily-words is missing). No test
>    may touch the production Neon database or ~/.claude.
> 6. Specify the /v and /j skill texts, the wall chat prompt and allow-list changes in src/chat/, and
>    the verify-notesd feature-map entries.
>
> Hard rules: do not edit source code in either repo during analysis; do not write to dword's
> database, only read it; do not change anything in ~/daily-words; ids are never invented; keep
> dword limits in one module (src/dword/rules.ts) with a drift test.
>
> Output: a phased implementation plan (the design's section 6 phases, refined), each phase with
> files, tests and a Proof section naming verify-notesd entries. Update
> docs/plans/2026-11-05-dword-connector-design.md with a short "Analysis results" section if any
> fact changed.

### User-Provided Context

- The note referenced `docs/plans/2026-11-05-dword-connector-design.md` as already existing
  ("do not re-run the discussion"). At the moment this `/analyze` session started, that file did
  **not** exist anywhere in the mcp-notes repo (checked: working tree, `git log --all`, every
  worktree, `git stash list`, filesystem-wide `find`, and an mcp-notes notes-store search by tag
  and full text — all came back empty). The user then said "the file is there. i just pulled the
  remote. check it" — the design doc had in fact been pushed to `origin/main` between this
  session's initial checks and the user's `git pull`; a subsequent `git fetch`/`git pull` surfaced
  it at exactly the path the note named. No inference was needed in the end; this is recorded
  because the apparent gap shaped the first half of this session's research approach (two
  independent read-only research agents were dispatched before the doc was confirmed present, then
  re-briefed once it was found, which cost no correctness — their general-exploration findings
  remained valid and were simply re-targeted at the design doc's specific claims).
- Economy-mode notice was active for this session (Claude Code weekly quota at 98%): no
  independent verifier agent for proof runs, no extra review/research agents beyond what a step
  explicitly requires, and `--model sonnet` on any `swarm.py launch`.

### User-Provided Files

- `docs/plans/2026-11-05-dword-connector-design.md` (full text read; summarized under "Current
  Dataflow" / "Key Data Structures" below, and quoted directly where a specific line is load-bearing).

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Verify every fact in design section 3 against `~/daily-words` and section 4 against mcp-notes; correct the design where a fact is wrong |
| R2 | Settle 5.3 (journal similarity: is OpenRouter's `text-embedding-3-small` comparable to dword's stored vectors, is 0.25 usable, else specify a lexical fallback) and 5.7 (what an English term with a `> sentence` stores, given the CHECK) by measurement/reading, not guesswork |
| R3 | Decide how the dword user row is resolved from `DWORD_USER_EMAIL`, and the tools' behavior when it is missing or unknown |
| R4 | Specify the exact parameterised SQL for every write and the `assertWritable` allow-list rules |
| R5 | Specify how tests run against a throwaway Postgres rebuilt from dword's `drizzle/` migrations, skipping when `~/daily-words` is missing, never touching production Neon or `~/.claude` |
| R6 | Specify the `/v` and `/j` skill texts, the wall chat prompt/allow-list changes in `src/chat/`, and the `verify-notesd` feature-map entries |

Cross-cutting, binding on every phase (not separately numbered by the user, carried as plan
invariants rather than a requirement row): the five closed decisions D1–D5 (design §2) are never
reopened; the `>` separator rule (split on the first `>`, trim both sides) is exact; source code in
neither repo is edited during analysis (already honored — this document and the plan files are the
only artifacts this session wrote); dword's database is never written, only read; nothing in
`~/daily-words` changes; ids are never invented; dword's limits live in one module
(`src/dword/rules.ts`) with a drift test.

---

## Detailed Requirements Understanding

**Problem/Requirement Statement:** mcp-notes needs two new capabilities reachable from Claude Code
skills (`/v`, `/j`) and from the wall chat bar: look up or add a vocabulary entry, and look up or
add a journal entry, in the user's separate `daily-words` (dword) application's Postgres database.
Unlike the three existing connectors (expenses, runs, seer), which are read-only, this one needs a
narrow, allow-listed **writer** into dword's database — the same shape as
`src/adversary/seerWriter.ts` already uses for Seer's database. No web UI is in scope.

**Success Criteria:** A fourth connector system (`dword`) exists with read-only `dword_schema` /
`dword_sql` plus four curated tools (`dword_vocab_lookup`, `dword_vocab_add`,
`dword_journal_find_similar`, `dword_journal_add`) that correctly mirror dword's own validation,
dedup and near-duplicate rules; a narrow SQL writer (`src/dword/writer.ts`) enforces an allow-list
of exactly the statements the feature needs; `/v` and `/j` skills exist and work from Claude Code;
the wall chat bar can run the same flow from natural language; `verify-notesd` has proof-map
entries for all of it; and every test that exercises dword runs against a throwaway Postgres
rebuilt from dword's own migrations, never the production Neon database.

**Key Considerations / Resolved in this analysis (R2, R3):**
- **5.3 resolved empirically (R2):** OpenRouter's `openai/text-embedding-3-small` and dword's own
  OpenAI-native `text-embedding-3-small` are the *same* vector space to measurable precision: a
  live, read-only measurement (below, "Verified Facts — Embedding Comparability") against dword's
  two real `ready` journal embeddings found **cosine distance 0.000000** between the OpenRouter
  vector and dword's stored vector for the same text, and the cross-entry distance was preserved
  within 0.00006 (0.799019 stored vs. 0.799077 fresh). **Decision: use Layer 2 (embedding
  comparison) with the existing 0.25 threshold as-is; the lexical fallback (design's option 3) is
  not needed for the happy path**, though it is worth keeping as a defensive fallback for the one
  case this measurement cannot cover: a missing/failed OpenRouter call (treated as "no Layer 2
  verdict available", matching dword's own "never block a save on a failed embedding call" rule).
- **5.7 resolved by reading dword's route code (R2):** an English term with a `> sentence` is a
  case dword's own UI structurally never produces (its origin columns are only ever written inside
  the non-English `lookup`-token branch of `POST /api/vocab`). The CHECK constraint
  (`vocab_entries_origin_context_needs_term`) only ties `origin_context` to `origin_term`;
  `origin_language` is unconstrained and nullable. Decision: mcp-notes sets `origin_term = term`
  (satisfies the CHECK) and `origin_context = sentence`; `origin_language` is set to the literal
  `'English'`, matching the design document's own stated instinct (§5.7) and giving a
  self-documenting, non-null value with no dword precedent to contradict it.
- **R3 (user resolution):** `DWORD_USER_EMAIL` is a new single optional string setting in
  mcp-notes' own `.env.local`, parsed the same shape as `parseEmbeddings()` (`src/config.ts:279`)
  — trimmed, `null` when blank/unset. It is **not** resolved to `users.id` at config-load time;
  every dword tool call resolves it fresh with `SELECT id FROM users WHERE email = $1` (email is
  `UNIQUE NOT NULL` in dword's `users` table, confirmed below), mirroring `loadDatabaseTarget`
  being re-read per call rather than cached in `Config`. Missing/unset `DWORD_USER_EMAIL`, or an
  email with no matching row, is a `ConnectorError`-shaped refusal with no write attempted and no
  partial state — surfaced the same way `seerWriter` surfaces "not reachable" errors.
- **Edge cases:** daily add limit of 50 (rolling 24h window, not calendar day); dedup must check
  `listTermsForDedup` (no status filter — a `mastered` word still blocks a re-add); phrase/idiom
  terms must pass `MAX_TERM_WORDS = 6`; journal duplicate check is two-layered (`norm_sha` exact
  match, then embedding distance) and must never block a save on a failed embedding call; the
  Seer-pattern writer must use `BEGIN`/`COMMIT`/`ROLLBACK` only where two statements must be atomic
  (the conditional `origin_context` attach on an add is a single statement, not a transaction).

---

## Analysis Scope

### Explicitly Mentioned Files
- `docs/plans/2026-11-05-dword-connector-design.md`

### Discovered Related Files (mcp-notes)
- `src/connectors/names.ts`, `env.ts`, `register.ts`, `guard.ts`, `sql.ts`, `schema.ts`, `types.ts`,
  `pg.ts`, `errors.ts` — the connector core.
- `src/connectors/seer/index.ts`, `src/connectors/expenses/*`, `src/connectors/runs/*` — per-system
  precedent for a new `src/connectors/dword/` directory.
- `src/adversary/seerWriter.ts`, `src/adversary/reviewsRepo.ts` — the direct-writer precedent.
- `src/mcp/adversaryTools.ts`, `src/mcp/sessionTools.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts` —
  MCP tool registration precedent.
- `src/chat/status.ts` (`allowedChatTools()`, `ALL_CONNECTOR_TOOL_NAMES` consumption),
  `src/chat/prompt.ts` (`buildChatSystemPrompt`), `src/chat/agent.ts` (`settingSources: []`, no
  skill loading), `src/http/capture.ts` (`POST /api/capture/claude-code`).
- `src/config.ts` (`parseEmbeddings`, `parseSwitch`, `loadConfig` shape) for the `DWORD_USER_EMAIL`
  setting's precedent.
- `src/embeddings/constants.ts`, `openrouter.ts` — `EMBEDDING_MODEL = 'openai/text-embedding-3-small'`,
  `EMBEDDING_DIMENSIONS = 1536`, the OpenRouter embedder mcp-notes already has.
- `claude/skills/check-seer-adversarial-nightly/SKILL.md`, `claude/skills/n/SKILL.md` — skill-file
  format precedent (frontmatter: `name`, `description`, optional `argument-hint`, optional `model`).
- `.claude/skills/verify-notesd/features/README.md`, `features/adversary.md` — proof-map format
  precedent (four sections per feature: Sub-features / How to get to it / Driving it with
  verify.sh / Gotchas).
- `tests/integration/connectors/harness.ts` + `siblings.ts` — the integration test harness; a 4th
  system slots in by adding an id to `SystemId`/`CONNECTOR_SYSTEMS`, with no new code in
  `migrationsMarker()`/`migrationFiles()`/`buildSystemDb()` because dword's migrations already use
  the same drizzle-journal layout as expenses/runs.
- `docs/plans/CONNECTORS_PLAN.md` — iteration-5 precedent plan (contract shape, harness functions,
  invariants) used as a structural model for this plan.
- `scripts/install.sh` — symlinks `claude/skills/*` into `~/.claude/skills`; the exact loop
  (glob vs. hard-coded list) was **not independently confirmed** by either research pass and must
  be checked by phase 5 before assuming a new `claude/skills/v/` and `claude/skills/j/` directory
  are picked up automatically.

### Discovered Related Files (`~/daily-words`, read-only — never edited)
- `src/lib/db/schema.ts` — `users`, `vocab_entries`, `journal_entries`, `journal_entry_embeddings`.
- `src/lib/db/queries/vocab.ts` — `createVocabEntry`, `createLookedUpVocabEntry`, `attachOrigin`,
  `findEntryByNormalizedTerm`, `listTermsForDedup`, `DAILY_ADD_LIMIT`.
- `src/lib/vocab/normalize.ts` (`MAX_TERM_CHARS`, `MAX_TERM_WORDS`, `validateContext`,
  `MAX_CONTEXT_CHARS`), `src/lib/vocab/dedup.ts` (`normalizeForDedup`, `foldMorphology`,
  `dedupKey`), `src/lib/vocab/near-duplicate.ts` (`findNearDuplicate`).
- `src/lib/llm/prompts/vocab-enrich.ts` (`PART_OF_SPEECH_VALUES`, `DEFINITION_MAX`,
  `DEFINITION_TARGET`, the Zod schema for an enrichment response).
- `src/app/api/vocab/route.ts` (`POST /api/vocab`, the add path — resolves 5.7),
  `src/app/api/vocab/[id]/origin/route.ts` (`attachOrigin`'s HTTP caller).
- `src/lib/journal/schemas.ts` (`insightSchema`), `src/lib/journal/duplicate-check.ts`
  (`findByNormSha`, `embed()` + `findNearest()`), `src/lib/journal/similarity.ts`
  (`NEAR_DUPLICATE_MAX_DISTANCE = 0.25`, the measured-corpus comment block).
- `src/lib/db/queries/journal-embeddings.ts` (`selectPendingForBackfill`).
- `src/lib/llm/embed.ts`, `src/lib/env.ts` (`EMBEDDING_BASE_URL` default
  `https://api.openai.com/v1`, `EMBEDDING_MODEL` default `text-embedding-3-small`,
  `EMBEDDING_API_KEY` optional, **separate from `OPENROUTER_API_KEY`**).
- `.claude/skills/verify-daily-words/SKILL.md` — the throwaway-Postgres verification model this
  plan's integration tests and `verify-notesd` entries should mirror.
- `drizzle/0008_strange_proemial_gods.sql` — the literal CHECK constraint SQL for
  `vocab_entries_origin_context_needs_term`.

---

## Current Dataflow

### Entry points (today: none — this is new)

Today, nothing in mcp-notes talks to `~/daily-words`. The two entry points this feature adds:

1. **Claude Code skill trigger** — a user types `/v <term>[> <sentence>]` or `/j <text>` in any
   Claude Code session. A new skill (`claude/skills/v/SKILL.md`, `claude/skills/j/SKILL.md`)
   is loaded, instructs Claude to call the new MCP tools in order (lookup/find-similar first, then
   add on a miss), and the existing `notes-capture` Stop hook (`claude/hooks/notes-capture.mjs` →
   `POST /api/capture/claude-code`, `src/http/capture.ts`) already captures the whole exchange —
   no new capture-path code is needed for the Claude Code side.
2. **Wall chat trigger** — a user types a message in the wall's chat bar that the chat agent
   (`src/chat/agent.ts`) recognizes (per a new paragraph in `buildChatSystemPrompt`,
   `src/chat/prompt.ts`) as a vocab or journal request. The chat agent has **no skill-loading
   mechanism** (`agent.ts` sets `settingSources: []`) and **no slash-command parsing** — it must be
   told entirely through the system prompt and must have the four new tool names added to its
   allow-list (`allowedChatTools()`, `src/chat/status.ts`).

### Processing chain (proposed, per design §5 — this plan's job is to make it concrete)

1. **`dword_vocab_lookup { term }`** (read-only) — normalize per dword's rules, then match in
   order: exact `lower(term)`; `origin_term` match; dedup-key (`foldMorphology`) match;
   near-duplicate. Returns `{ found, entry | candidates }`.
2. **`dword_vocab_add { term, part_of_speech, pronunciation, definition, examples[3], origin?,
   context? }`** (write) — validates against `src/dword/rules.ts` (mirrored limits), resolves the
   dword user id from `DWORD_USER_EMAIL`, inserts with `source = 'manual'`,
   `enrichment_status = 'ready'`; on a unique-index collision returns the existing row instead of
   failing; applies D4's conditional `origin_context` attach (one `UPDATE ... WHERE origin_term IS
   NULL`) when the row already exists and has no origin.
3. **`dword_journal_find_similar { text }`** (read-only) — Layer 1 `norm_sha` equality; Layer 2
   cosine distance via a fresh OpenRouter embedding of `text`, threshold 0.25 (now confirmed usable,
   see "Verified Facts" below). Returns `{ verdict: 'duplicate' | 'none', entries }`.
4. **`dword_journal_add { text, source_note?, insight, force? }`** (write) — re-runs the same
   duplicate check; if a duplicate is found and `force` is not `true`, returns the match and writes
   nothing (D3); otherwise inserts with `insight_status = 'ready'`.

### Data persistence

**dword's Postgres (`~/daily-words/.env.local`'s `DATABASE_URL`/`DATABASE_URL_UNPOOLED`, Neon,
`ap-southeast-1`), written only through `src/dword/writer.ts`'s allow-list:**
- `INSERT INTO vocab_entries (...)` — new word.
- `UPDATE vocab_entries SET origin_term = $.., origin_language = $.., origin_context = $.. WHERE id
  = $.. AND user_id = $.. AND origin_term IS NULL` — D4's conditional attach.
- `INSERT INTO journal_entries (...)` — new journal entry.
- `INSERT INTO journal_entry_embeddings (...)` — only if the embedding call succeeded; a failed
  embedding call must not block the journal insert (dword's own rule, confirmed in
  `selectPendingForBackfill`'s existence — dword expects some rows to lack embeddings and backfills
  them later).

**mcp-notes' own Postgres:** no new table is required by this feature. `DWORD_USER_EMAIL` lives in
config, not a row; nothing about dword is cached in mcp-notes' own DB (matches how the other three
connectors work — re-resolved per call, nothing persisted locally).

### Exit points
- MCP tool JSON results (`jsonResult`/`run`/`errorResult` from `src/mcp/tools.ts`, the same helpers
  every connector and adversary tool already uses).
- Skill replies in the Claude Code session (the stored entry, and whether it was found or newly
  added).
- Wall chat bar replies (same content, through the chat agent's normal response path) and chat
  history capture.
- Error conditions: missing `~/daily-words` or its `.env.local` (`ConnectorError`, "not reachable"),
  missing/unknown `DWORD_USER_EMAIL` (refusal, no write), daily limit of 50 reached (clear error,
  no write), a non-English `/v` input the model judges "already English" or "not a word" (told to
  the user, not inserted), a failed OpenRouter embedding call during `/j` (journal insert proceeds
  without Layer 2 — matches dword's own "never block a save" rule; `journal_entry_embeddings`
  simply gets no row, to be picked up by dword's own backfill later, same as today).

---

## Key Data Structures

### `vocab_entries` (dword, `src/lib/db/schema.ts:145-243`)
| Column | Type / rule | Verified |
|---|---|---|
| `id` | uuid PK | confirmed |
| `user_id` | uuid, FK `users.id`, cascade delete | confirmed |
| `term` | text, not null | confirmed |
| `source` | text, `'manual'\|'suggested'\|'shared'` (TS union, not a DB enum) | confirmed |
| `status` | text, `'active'\|'mastered'` | confirmed |
| `part_of_speech` | text, unconstrained at the DB; app-level enum of 14 values (`PART_OF_SPEECH_VALUES`, `vocab-enrich.ts:13-28`) | confirmed |
| `pronunciation` | text, unconstrained at the DB; Zod ceiling 60 chars (`vocab-enrich.ts:54`) | confirmed |
| `definition` | text, unconstrained at the DB; Zod ceiling 80 chars, prompt target 60 (`DEFINITION_MAX`/`DEFINITION_TARGET`, `vocab-enrich.ts:44-45`) | confirmed |
| `examples` | jsonb, unconstrained at the DB; Zod: array of exactly 3 (when status is not "unknown"), each 1-120 chars, **model is instructed to aim for ≤100** (`vocab-enrich.ts:56,76-81,179`) | confirmed, one nuance (120 is the ceiling, 100 is the aim — design doc said only "max 120") |
| `enrichment_status` | text, `'ready'` for complete rows | confirmed |
| `origin_term`, `origin_language`, `origin_context` | all nullable text; `origin_language` is **not** tied to the CHECK | confirmed |
| unique index | `(user_id, lower(term))` named `vocab_entries_user_term_uniq` | confirmed |
| CHECK | `vocab_entries_origin_context_needs_term`: `origin_context IS NULL OR origin_term IS NOT NULL` (exact SQL in `drizzle/0008_strange_proemial_gods.sql:4`) | confirmed |
| rolling limit | `DAILY_ADD_LIMIT = 50` over a rolling 24h window (`vocab.ts:20`, enforced `src/app/api/vocab/route.ts:174-177`) | confirmed |

### `journal_entries` (dword, `src/lib/db/schema.ts:371-391`)
| Column | Type / rule |
|---|---|
| `id` | uuid PK |
| `user_id` | uuid, FK `users.id` |
| `text` | text |
| `source_note` | text, nullable |
| `insight` | jsonb `{ meaning: string (20-220 chars), whenItApplies: string[2-3] (8-120 chars each) }` (`src/lib/journal/schemas.ts:115-118`) |
| `insight_status` | text, `'none'\|'pending'\|'ready'\|'failed'` |
| `insight_requested_at` | timestamptz, nullable |

### `journal_entry_embeddings` (dword, `src/lib/db/schema.ts:416-455`)
| Column | Type / rule |
|---|---|
| `entry_id` | uuid, PK + FK `journal_entries.id` |
| `user_id` | uuid, denormalized FK |
| `status` | text, `'ready'\|'failed'` |
| `text_sha` | sha256 of exact text |
| `norm_sha` | sha256 of `normalizeForCompare(text)` |
| `embedding` | `vector(1536)`, nullable; HNSW index, `vector_cosine_ops` |
| `model` | text, nullable — holds the literal string the embedding API reported |
| `attempts`, `failed_reason` | retry bookkeeping for `selectPendingForBackfill` |

### `users` (dword, `src/lib/db/schema.ts:36-42`)
| Column | Type / rule |
|---|---|
| `id` | uuid PK, default random |
| `email` | text, **not null, unique** — the `DWORD_USER_EMAIL` join key |
| `name`, `image` | text, nullable |
| `emailVerified` | timestamptz, nullable |

---

## Dependencies

### Configuration / Environment
- mcp-notes `.env.local`: new `DAILY_WORDS_DIR` (connector dir override, default `~/daily-words`,
  joins `src/connectors/env.ts`'s `SETTING_KEYS`), new `DWORD_USER_EMAIL` (single optional string,
  parsed like `parseEmbeddings()`).
- `~/daily-words/.env.local` (read-only, every call, never cached): `DATABASE_URL` /
  `DATABASE_URL_UNPOOLED` (same `pickDirectUrl`/`prepareUrl` logic every other connector uses).
- mcp-notes' existing `OPENROUTER_API_KEY` is reused for the journal-similarity embedding call —
  **confirmed comparable** to dword's own embeddings (see below), so no new embeddings credential
  is needed.
- No new database, no new systemd unit, no new port.

### External Services
- OpenRouter `/embeddings` (`openai/text-embedding-3-small`) — already used elsewhere in mcp-notes
  (`src/embeddings/openrouter.ts`); the journal-similarity feature is a new *caller* of the same
  embedder, not a new integration.
- dword's Neon Postgres — read today by nothing in mcp-notes; written today by nothing in
  mcp-notes. This feature is the first writer.

---

## Verified Facts — Embedding Comparability (resolves design §5.3, R2)

Measured directly against dword's **production** Neon database, read-only, in a single
`BEGIN READ ONLY … ROLLBACK` transaction, 2026-11-06. Script and full output kept in this session's
scratchpad (not committed; reproducible by any future session with the same two `.env.local`
files). No journal text was ever printed or logged — only lengths, hashes and distances.

- dword currently has exactly 2 rows with `journal_entry_embeddings.status = 'ready'`, both with
  `model = 'text-embedding-3-small'`; the other 95 rows are `status = 'failed'`, `model = NULL`
  (consistent with dword's dev/CI environment lacking `EMBEDDING_API_KEY`, confirmed separately in
  `src/lib/env.ts`).
- For both `ready` rows: `sha256(text) == journal_entry_embeddings.text_sha` (confirms the row read
  matches the text the vector was computed from), and re-embedding that exact text through
  **OpenRouter** with `model: 'openai/text-embedding-3-small'` produced a vector with
  **cosine distance 0.000000** (6 decimal places) against the vector dword itself stored (computed
  via OpenAI's native endpoint, per `src/lib/llm/embed.ts`'s `EMBEDDING_BASE_URL =
  https://api.openai.com/v1`). OpenRouter's response also echoed `model: "text-embedding-3-small"`.
- The cross-entry cosine distance between the two *different* real entries was **0.799019** using
  dword's stored vectors and **0.799077** using freshly-generated OpenRouter vectors — a difference
  of 0.000058, i.e. relative ordering and absolute distance are both preserved well inside any
  threshold granularity dword's own 0.25 cutoff cares about.

**Conclusion:** OpenRouter's `openai/text-embedding-3-small` and dword's own OpenAI-native
`text-embedding-3-small` are the same vector space for mcp-notes' purposes. Design §5.3's option 2
is correct as written: use Layer 2 with the existing `NEAR_DUPLICATE_MAX_DISTANCE = 0.25`. The
lexical fallback (option 3) is retained in the plan only as a graceful degrade for a failed/timed
out embedding call (never block the save — dword's own rule), not as a routine comparability
workaround.

## Verified Facts — 5.7 (English term with a sentence)

`POST /api/vocab/route.ts:91-172`: `origin` starts `null` and is populated **only** inside
`if (lookup) { … }` (lines 137-151), where `lookup` requires an HMAC-signed token minted by the
separate non-English `POST /api/vocab/lookup` endpoint. A typed (non-lookup) add calls
`createVocabEntry(userId, term)` (`queries/vocab.ts:29-39`), whose `.values()` object has no origin
keys at all — the columns stay `NULL` by absence of a default, not by explicit nulling.
`attachOrigin` (the other writer of these columns) also requires a decoded `lookup` token
(`src/app/api/vocab/[id]/origin/route.ts:59-63`). **This means an English term entered with a `>
sentence` is a case dword's own code never produces** — there is no existing value to copy. The
CHECK constraint only requires `origin_term IS NOT NULL` when `origin_context IS NOT NULL`;
`origin_language` is a plain nullable column with no constraint. Decision (recorded under
"Decisions" in the plan index): `origin_term = term`, `origin_context = sentence`,
`origin_language = 'English'` (a literal mcp-notes chooses, since dword sets no precedent either
way, and the design document's own §5.7 already leaned toward this value).

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `CONNECTOR_SYSTEMS`, `CONNECTOR_TOOL_NAMES`, `SYSTEM_META`, `ALL_CONNECTOR_TOOL_NAMES` | `src/connectors/names.ts:7,10,37,19` | def | mcp-notes |
| `connectorSettings`, `SETTING_KEYS`, `pickDirectUrl`, `prepareUrl`, `loadDatabaseTarget`, `resolveRepoDir` | `src/connectors/env.ts:25,13,74,86,130,56` | def | mcp-notes |
| `registerConnectorTools`, `defaultConnectors`, `ABOUT` | `src/connectors/register.ts:29,20,13` | def | mcp-notes |
| `CONNECTOR_PG_TYPES` | `src/connectors/pg.ts:47-51` | def | mcp-notes |
| `scrub`, `reasonOf`, `unreachable` | `src/connectors/errors.ts:8-15` | def | mcp-notes |
| `createSeerConnector` (pattern for `createDwordConnector`) | `src/connectors/seer/index.ts:17-19` | def | mcp-notes |
| `assertWritable`, `WRITABLE_TABLES`, `SeerWriter`, `AdversaryWriteError` | `src/adversary/seerWriter.ts:25,9,103,16` | def | mcp-notes |
| `ReviewsRepo` (own-DB attempt log — not a pattern dword needs to copy; see Decisions) | `src/adversary/reviewsRepo.ts:48-108` | def | mcp-notes |
| `registerAdversaryTools` (precedent for `registerDwordTools`) | `src/mcp/adversaryTools.ts:46` | def | mcp-notes |
| `run`, `jsonResult`, `errorResult` | `src/mcp/tools.ts` | def | mcp-notes |
| `allowedChatTools`, `ADVERSARY_TOOL_NAMES` | `src/chat/status.ts:76-84,54` | def | mcp-notes |
| `buildChatSystemPrompt` | `src/chat/prompt.ts:13-41` | def | mcp-notes |
| chat agent options (`settingSources: []`, `allowedTools`) | `src/chat/agent.ts:320,331-342` | call | mcp-notes |
| `CAPTURE_PATH`, `captureSchema` | `src/http/capture.ts:8,26-42` | def | mcp-notes |
| `parseEmbeddings`, `parseSwitch` (config precedent) | `src/config.ts:279-282,284-289` | def | mcp-notes |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` | `src/embeddings/constants.ts:10-11` | def | mcp-notes |
| `check-seer-adversarial-nightly/SKILL.md` frontmatter | `claude/skills/check-seer-adversarial-nightly/SKILL.md:1-5` | doc | mcp-notes |
| `features/README.md` four-section contract | `.claude/skills/verify-notesd/features/README.md:4,7-16,18-20` | doc | mcp-notes |
| harness: `cleanupHarness`, `describeWithRepo`, `truncateSystem`, `seedSystem`, `connectorFor`, `makeLab`, `connectorClient` | `tests/integration/connectors/harness.ts:31,36,46,57,76,183,222` | def (test) | mcp-notes |
| harness: `connectorsAdminUrl`, `siblingRepo`, `systemDbName`, `systemDbUrl`, `withAdmin`, `migrationFiles`, `buildSystemDb` | `tests/integration/connectors/siblings.ts:15,27,32,37,44,56,86` | def (test) | mcp-notes |
| `users` (`email` unique not null) | `src/lib/db/schema.ts:36-42` | def | daily-words |
| `vocab_entries` | `src/lib/db/schema.ts:145-243` | def | daily-words |
| `vocab_entries_origin_context_needs_term` CHECK | `drizzle/0008_strange_proemial_gods.sql:4` | def (migration) | daily-words |
| `createVocabEntry`, `createLookedUpVocabEntry`, `attachOrigin`, `findEntryByNormalizedTerm`, `listTermsForDedup`, `DAILY_ADD_LIMIT` | `src/lib/db/queries/vocab.ts:29,124,168,191,229,20` | def | daily-words |
| `MAX_TERM_CHARS`, `MAX_TERM_WORDS`, `validateContext`, `MAX_CONTEXT_CHARS` | `src/lib/vocab/normalize.ts:14,17,149,104` | def | daily-words |
| `normalizeForDedup`, `foldMorphology`, `dedupKey` | `src/lib/vocab/dedup.ts:56,184,203` | def | daily-words |
| `findNearDuplicate` | `src/lib/vocab/near-duplicate.ts:46` | def | daily-words |
| `PART_OF_SPEECH_VALUES`, `DEFINITION_MAX`, `DEFINITION_TARGET` | `src/lib/llm/prompts/vocab-enrich.ts:13-28,45,44` | def | daily-words |
| `POST /api/vocab` route (resolves 5.7) | `src/app/api/vocab/route.ts:91-172` | call | daily-words |
| `journal_entries`, `journal_entry_embeddings` | `src/lib/db/schema.ts:371-391,416-455` | def | daily-words |
| `insightSchema` | `src/lib/journal/schemas.ts:115-118` | def | daily-words |
| `findByNormSha`, duplicate-check layers | `src/lib/journal/duplicate-check.ts` | def | daily-words |
| `NEAR_DUPLICATE_MAX_DISTANCE`, measured-corpus comment | `src/lib/journal/similarity.ts:176,120-176` | def | daily-words |
| `selectPendingForBackfill` | `src/lib/db/queries/journal-embeddings.ts:229-255` | def | daily-words |
| embeddings transport (`EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`) | `src/lib/llm/embed.ts`, `src/lib/env.ts:85-97` | def | daily-words |
| `.claude/skills/verify-daily-words/SKILL.md` | — | doc | daily-words |

---

## Impact Points (files that WILL need changes)

1. `src/connectors/names.ts` — add `'dword'` to `CONNECTOR_SYSTEMS`, a `dword` entry to
   `CONNECTOR_TOOL_NAMES` and `SYSTEM_META`. **Phase 1.**
2. `src/connectors/env.ts` — add `DAILY_WORDS_DIR` to `SETTING_KEYS`. **Phase 1.**
3. `src/connectors/register.ts` — add `DWORD_ABOUT` to `ABOUT`, a `dword: createDwordConnector()`
   case to `defaultConnectors()`, and (once curated tools exist) a
   `registerDwordCurated(server, connectors.dword)` call. **Phase 1 (plumbing) + phase 3/4 (curated
   call), per the existing per-phase split `CONNECTORS_PLAN.md` used.**
4. `src/connectors/dword/index.ts` (+ `curated.ts`) — new, mirrors `seer/index.ts`. **Phase 1
   (index.ts as a thin wrapper) + phases 3-4 (curated.ts).**
5. `src/config.ts` — `DWORD_USER_EMAIL` parsing, added to `loadConfig()`. **Phase 1.**
6. `README.md` — env var table row(s) for `DAILY_WORDS_DIR` and `DWORD_USER_EMAIL`. **Phase 1.**
7. `src/dword/rules.ts` (new) — the one module holding every mirrored dword limit, plus its drift
   test. **Phase 2.**
8. `src/dword/writer.ts` (new) — the narrow allow-listed SQL writer. **Phase 2.**
9. `src/mcp/dwordTools.ts` (new) — the four curated MCP tools. **Phases 3 (vocab) and 4 (journal).**
10. `src/chat/status.ts` — `DWORD_TOOL_NAMES` spliced into `allowedChatTools()`. **Phase 6.**
11. `src/chat/prompt.ts` — a new paragraph in `buildChatSystemPrompt`'s sections. **Phase 6.**
12. `claude/skills/v/SKILL.md`, `claude/skills/j/SKILL.md` (new) — the two skills. **Phase 5.**
13. `scripts/install.sh` — confirm (phase 5 must check, not assume) whether the symlink loop over
    `claude/skills/*` is glob-based; if not, add the two new directories explicitly.
14. `.claude/skills/verify-notesd/features/` — a new `dword.md` (or an extension of an existing
    file) plus a `features/README.md` table row. **Phases 3-6, incrementally, per the feature
    surfaced in each.**
15. `tests/integration/connectors/siblings.ts` / `harness.ts` — add `'dword'` to the `SystemId`
    union consumed by `migrationsMarker`/`migrationFiles`/`buildSystemDb`/`connectorFor`; expected
    to need **no new branches**, only the new id, because dword's migrations already match the
    drizzle-journal layout `migrationFiles` already handles. **Phase 1 (harness plumbing) + phases
    3-4 (the actual integration test files, following the existing one-file-per-system pattern).**
16. `docs/plans/2026-11-05-dword-connector-design.md` — "Analysis results" addendum (this session
    writes it; see below), recording the corrections found in R1 and the resolutions found in R2.

**This document describes. The plan files prescribe.**
