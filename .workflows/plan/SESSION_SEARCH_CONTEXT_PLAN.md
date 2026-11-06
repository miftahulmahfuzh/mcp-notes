# Plan: Projects session search context (commits + Claude's replies)

**Slug:** session-search-context
**Date:** 2026-11-06 14:58 WIB
**Analysis:** `.workflows/analyze/20261106-145826-SSC7_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-search-context`
**Branch:** `feature/session-search-context` (base: `origin/main` @ `b41ae04`)
**Phases:** 5
**Status:** complete
**Coordinator:** —

---

## Why

> the main objective is still the same: improving semantic search accuracy in Projects as much as possible.
> AFAIK, right now, the context of Projects semantic search is in each node is: my prompts and the linked notes.
> there are 2 more entities that we can exploit as the node's search context:
> 1. commit message (we saved commits in each node)
> 2. claude output in that whole session
> ...
> i said "persist some of them" because i think for now, we only need to "save" the things that claude said to user in a session.
> as you know, a claude session is like a chat room, where a user say something (instructions/context/query/requirements) -> claude say something back to user.
> from my experience, usually claude can say a lot longer texts to respond to user's query.
> and i think if we can save these claude's answers in a session into its resepective node and utilize it into search context, then it definitely can improve semantic search accuracy.

> yes, do both. we might as well spawn analyze tmux to improve and refactor Projects semantic search feature robustly

> important : DO NOT CHANGE the UI. we dont need a new session search box. query pill bar is enough for any kinds of query including searching something

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Commit messages of a session become part of its search context | 2 |
| R2 | Claude's answers to the user in a session are persisted per node | 3 |
| R3 | Those persisted answers are used as search context (semantic + words) | 4, 5 |
| R4 | Improve and refactor Projects semantic search robustly | 1, 5 |
| R5 | Do NOT change the UI (no new search box; the query pill bar is the way to search) | all (invariant) |

## Scope

**In scope:** `searchSessions` candidate-source refactor; commit subjects in `search_tsv` and the session embed text (one forced re-embed); a `cc_session_replies` table filled by the ingester (tail + one-time backfill), with a generated tsvector and a sha-keyed `cc_session_reply_embeddings` table filled by a background worker; replies as a search source with `via_replies`; a related-evidence weight in `src/search/blend.ts` proven by a labelled fixture; MCP/HTTP/chat-block wiring; README, CLAUDE.md, verify-notesd feature map.

**Out of scope:** anything under `web/` (R5, explicit user instruction); assistant narration between tool calls; subagent/sidechain replies; chunking a reply into several vectors (one vector per reply, embed input clamped by `embedInput` at 8000 chars); changing note search.

## Invariants

1. **No file under `web/` changes** in any phase (R5). The Projects chat (query pill bar) and MCP are the consumers.
2. The tree typechecks (`npm run typecheck`), `npm test` and `npm run test:int` pass at the end of every phase.
3. `SessionsRepo` stays the only writer of every `cc_session*` table; ingest never blocks on or fails because of embeddings; without `OPENROUTER_API_KEY` everything degrades to text and reports `fallback`.
4. Replies are redacted with the same `redactSecrets` as prompts before they are stored; nothing unredacted reaches the DB.
5. Existing wire fields keep their names and shapes (`via_notes`, `score`, `mode`, `fallback`); new fields are additive.
6. Only the owning host writes a session's replies; transcripts are never read for another host's session.
7. Unit and integration tests use fake embedders; no network.
8. Every phase proves itself with `.claude/skills/verify-notesd` and saves evidence.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Candidate-source refactor of searchSessions | R4 | `src/sessions` | 4 | — | NORMAL | `.workflows/plan/session-search-context/phase-1.md` | P1-NOTES-A080 | — |
| 2 | Commit subjects in search_tsv and the session embedding | R1 | `src/db`, `src/sessions`, `drizzle` | 17 | — | NORMAL | `.workflows/plan/session-search-context/phase-2.md` | P1-NOTES-A081 | — |
| 3 | Persist Claude's replies (cc_session_replies), tail + backfill | R2 | `src/sessions`, `src/db`, `drizzle` | 16 | 2 | HARD | `.workflows/plan/session-search-context/phase-3.md` | P1-NOTES-A082 | — |
| 4 | Reply embedding worker | R3 | `src/sessions`, `src/embeddings`, `src/background.ts` | 8 | 3 | NORMAL | `.workflows/plan/session-search-context/phase-4.md` | P1-NOTES-A083 | — |
| 5 | Replies as a search source, related-evidence weight, wiring and docs | R3, R4 | `src/sessions`, `src/search`, `src/mcp`, `src/chat`, `src/http`, docs | 20 | 1, 3, 4 | HARD | `.workflows/plan/session-search-context/phase-5.md` | P1-NOTES-A084 | — |

Waves: {1, 2} run concurrently, then 3, then 4, then 5. Every phase's Step 0 is `[ -d node_modules ] || npm ci` (the worktree starts without `node_modules`).

### Phase 1 — Candidate-source refactor of searchSessions
**Satisfies:** R4
**Owns:** `src/sessions/search.ts` structure only: named `CandidateSource`s (session text, session vector, node id, notes), `HYBRID_SOURCES` / `TEXT_SOURCES`, one pure `mergeCandidates` (per-signal max, `via_*` lists, `Signal.from` = `own` | `note`), `collectCandidates`, `compareTextRanked`, `relatedSourceRows`. The golden test `tests/integration/sessions.search.golden.int.test.ts` + snapshot (written on the unchanged code first) and `tests/unit/sessions/searchMerge.test.ts`.
**Does not touch:** `src/search/blend.ts`, schema, migrations, readModel/view/MCP/HTTP/chat, README/CLAUDE.md/feature map, `tests/integration/sessions.search.int.test.ts` (byte for byte), `web/`.
**Exit criteria:** `sessions.search.int.test.ts` passes unchanged; the golden snapshot passes unchanged after the refactor; `searchMerge.test.ts` passes; the A/B script (base = parent of this phase's Step 1 commit) prints `A/B IDENTICAL`; only the four files in its Files table change in its commits.

### Phase 2 — Commit subjects in search_tsv and the session embedding
**Satisfies:** R1
**Owns:** `src/db/schema.ts` (`ccSessions.searchTsv` + header sentence for 0013, `ccSessionEmbeddings.textVersion`); `drizzle/0013_session_commit_search.sql` (generated, GIN index drop/recreate hand-added) + `meta/0013_snapshot.json` + journal; `src/sessions/summarize.ts` (`SESSION_EMBED_TEXT_VERSION = 1`, `MAX_EMBED_COMMITS`, `commitSubjects`, commits before prompts in `buildEmbedText`); `src/sessions/types.ts` `SessionEmbeddingInput.textVersion` (required); `src/sessions/repo.ts` `saveEmbedding` only; `src/sessions/summaryWorker.ts` (re-embed rule: `text_version < SESSION_EMBED_TEXT_VERSION`); tests (`sessions.commitSearch.int`, `migration0013.int`, summarize/summaryWorker unit, repo int); docs: README search paragraph + `sessions_search` row ("commit messages"), CLAUDE.md:41 "Idle sessions…" sentence, `features/projects.md` commit bullet + driving block.
**Does not touch:** `src/sessions/search.ts`, transcript/ingest/merge, reply writers, `drizzle/0014`, the golden snapshot, `web/`.
**Exit criteria:** a commit-only word finds its session in text and hybrid mode; every pre-0013 vector is rebuilt exactly once (text_version 0 → 1) and not again; 0013 applies on a fresh DB and on a 0012 DB with data; the golden test (if phase 1 is in the tree) passes without `--update`.

### Phase 3 — Persist Claude's replies (cc_session_replies), tail + backfill
**Satisfies:** R2
**Owns:** `drizzle/0014_session_replies.sql` (generated on top of 0013) + snapshot + journal; `schema.ts`: `ccSessionReplies` (`session_id` FK cascade, `seq`, `at`, `text`, `truncated`, generated `search_tsv` + GIN), `ccSessionReplyEmbeddings` (`session_id`, `seq`, `embedding vector(1536)`, `sha`, `model`, `attempts`, `last_error`, `next_attempt_at`, `embedded_at`, `updated_at`; **no `created_at`**; PK `(session_id, seq)`; FK `cc_session_reply_embeddings_reply_fk` → replies on delete cascade; hnsw + next_attempt indexes), `ccSessions.repliesVersion`; `types.ts` (`REPLIES_VERSION = 1`, `MAX_REPLY_STORE_CHARS = 16 KiB`, reply types); reply capture in `TranscriptAccumulator` (final text after the last tool_use; no sidechains; straddle append/replace); `merge.ts` helpers (redaction, cap); `SessionsRepo` writes replies in the prompts transaction (class doc lists `cc_session_replies`; `ccSessionReplies` in the schema import); backfill via `promptsBackfill` + `replies_version`; `tests/helpers/memoryIngestStore.ts`; `tests/integration/setup.ts` truncateAll; unit + int tests; CLAUDE.md:41 replies sentence (after "…only writer of the session tables.").
**Does not touch:** `search.ts`, `blend.ts`, any write to `cc_session_reply_embeddings`, `replyEmbeddings.ts`, `background.ts`, readModel/view/MCP/HTTP/chat, README, feature map, `summarize.ts`/`summaryWorker.ts`, `ccSessions.searchTsv`/`ccSessionEmbeddings`, `web/`.
**Exit criteria:** each fixture prompt Claude answered has one redacted row with the turn's final text; split reads and a restart mid-turn equal a from-0 read; a `replies_version 0` row is backfilled exactly once.

### Phase 4 — Reply embedding worker
**Satisfies:** R3 (semantic half)
**Owns:** new `src/sessions/replyEmbeddings.ts` (`currentReplySha256Sql`, `isCurrentReplyEmbeddingSql(model)` — the one "current reply vector" predicate, `dbReplyEmbeddingStore`, `startReplyEmbeddingWorker`, `REPLY_EMBEDDINGS_LABEL`); `src/embeddings/worker.ts` (`events?` optional, `label` / `itemNoun`, `formatBatch` defaults byte-identical); `src/embeddings/repo.ts` (`export NON_BLANK_PATTERN`, visibility only); `SessionsRepo.saveReplyEmbedding(sessionId, seq, Omit<SessionEmbeddingInput, 'textVersion'>)` and `recordReplyEmbeddingFailure` (+ `ccSessionReplyEmbeddings` in the schema import, class doc extended); `src/background.ts` (start with session ingest when an embedder exists, kick on `onPassComplete`, close in parallel); tests.
**Does not touch:** `search.ts`, `blend.ts`, schema/migrations, `types.ts`, transcript/ingest/merge, `summarize.ts`/`summaryWorker.ts`, README/CLAUDE.md/feature map (phase 5 documents the worker), `web/`.
**Exit criteria:** every non-blank reply of this host gets a current vector; an edited reply is re-embedded under its new sha; failures back off and retry; `close()` returns within its grace; without a key nothing new starts and ingest is unaffected.

### Phase 5 — Replies as a search source, related-evidence weight, wiring and docs
**Satisfies:** R3, R4
**Owns:** `src/search/blend.ts` (`BLEND.related = 0.6`, `RelatedSignals`, `literalRank`, optional `related` on candidates — note search unchanged); `tests/unit/search.blend.test.ts`; `src/sessions/view.ts` (`REPLY_EXCERPT_CHARS`, `SearchReplyMatch`, `SearchHit.via_replies`); `src/sessions/search.ts` (`EvidenceKind` += `'reply'`, `repliesSource` with `items` = `[{ seq }]`, per-page `ts_headline` excerpts, `via_replies` max 3, weighted ranking from own vs related kept apart, `tuning` option; imports phase 4's `isCurrentReplyEmbeddingSql`); golden snapshot regenerated in its own commit after proving identity at `related: 1`; `tests/fixtures/semantic/sessionsLabelled.ts` + `sessions.relatedEvidence.int.test.ts`; `sessions.search.int.test.ts` (append); `readModel.ts`, `sessionsApi.ts` (doc comment only), `sessionTools.ts`, `src/mcp/instructions.ts`, `src/chat/context.ts`, `src/chat/prompt.ts`, chat/MCP/API tests; README (new replies paragraph after phase 2's, `sessions_search` row rewritten keeping "commit messages", HTTP row), CLAUDE.md:41 (worker + sources + `BLEND.related` sentence before "Transcripts, …"), `features/projects.md` (notes + replies bullets, "Replies in search" block after phase 2's).
**Does not touch:** ingest/transcript/merge/repo/types, `replyEmbeddings.ts`, `background.ts`, schema/migrations, `summarize.ts`/`summaryWorker.ts`, `web/`.
**Exit criteria:** a word or meaning only in a reply finds its session with `via_replies`; the labelled fixture passes at 0.6 and fails at 1 and 0.3; the golden snapshot holds at `related: 1`; MCP and HTTP carry `via_replies`; docs updated; `git diff --stat origin/main -- web/` prints nothing.

## Reconciliation Log

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | Phase 5 imports `isCurrentReplyEmbeddingSql` from phase 4's new `src/sessions/replyEmbeddings.ts`, but the draft had phase 5 depend on 1, 3 only | Unmet assumption / ordering | Phase 5 `Depends on: 1, 3, 4`; the "or inline the predicate" alternative removed from phase-5.md (one definition of a current reply vector) |
| 2 | Phase 4's `saveReplyEmbedding` takes `SessionEmbeddingInput`, which phase 2 made require `textVersion`; phase 4's store passes `{ sha, model, embedding }` | Broken-build phase | Phase 4 signature is `Omit<SessionEmbeddingInput, 'textVersion'>` (contract, Step 4, Principles edited); `types.ts` stays phase 2/3's |
| 3 | Phase 4 hedged on phase 3's names/columns (assumed maybe `created_at`, maybe no FK, "rename if different") | Contract drift | Phase 4 Requires rewritten to phase 3's actual contract: no `created_at`, FK `cc_session_reply_embeddings_reply_fk` with cascade, exports `ccSessionReplies` / `ccSessionReplyEmbeddings`. Its SQL and test seeds already insert the reply row before any vector and never name `created_at`; no code change needed. Phase 5's Assumptions updated the same way |
| 4 | `repo.ts:6` schema import and `:174-178` class doc: phase 3 and phase 4 both edit; phase 4 quoted the pre-phase-3 text | File collision | Phase 4 Step 4 now quotes phase 3's import (`ccSessionReplies`) and class doc (`cc_session_replies`) and adds `ccSessionReplyEmbeddings` / `cc_session_reply_embeddings` / "the reply embedding worker" |
| 5 | Reply `items` shape: phase 1 contract/handoff said `[{ seq, text }]`, phase 5's code uses `[{ seq }]` + per-page `ts_headline` excerpts; phase 1 also said phase 5 would weight via `Signal.from` and call `toViaReplies(items)` | Contract drift | Phase 5's code wins (see Decisions); phase-1.md "What phase 5 does" and Handoffs rewritten: `[{ seq }]`, `toHit(c, host, score, replyExcerpts)`, weight from `c.row.*` vs `c.related.*` |
| 6 | Golden snapshot: phase 1 creates it, phase 5 regenerates it; phase 2 (concurrent with 1) changes `search_tsv` | File collision | Phase 2 never regenerates it (seed has no commits; the new term adds no lexemes for `[]`); phase 2 Verification runs the golden test without `--update` when it exists. Phase 5 alone regenerates, after proving identity at `related: 1` |
| 7 | Phase 1's A/B base (`merge-base HEAD origin/main`) and its "no other file changed" check (`git diff --stat origin/main`) break when phase 2 lands first on the set branch (commit subjects change fixture ranks) | Broken check / ordering | Base and diff are now the parent of phase 1's Step 1 commit (`STEP1^`) |
| 8 | `src/db/schema.ts` edited by 2 (header 0013, `searchTsv`, `ccSessionEmbeddings`) and 3 (header 0014, `repliesVersion`, two new tables, row types) | File collision | Disjoint regions; phase 3 depends on 2 and already quotes post-phase-2 state (0014 generated on 0013's snapshot). No edit |
| 9 | `src/sessions/types.ts`: 2 (`SessionEmbeddingInput.textVersion`), 3 (reply types, constants); phase 4 reuses `SessionEmbeddingInput` | File collision | Disjoint regions; phase 4 does not edit the file (see #2) |
| 10 | `CLAUDE.md:41` sessions paragraph: 2 replaces the "Idle sessions…" sentence, 3 inserts after "…only writer of the session tables.", 5 inserts before "Transcripts, …" | File collision | Three disjoint anchors in that order; each phase keeps the others' sentences. No edit |
| 11 | README: 2 replaces the search paragraph and the `sessions_search` row; 5 adds a paragraph after it and rewrites the row | File collision | Phase 5 quotes phase 2's post-change paragraph end and keeps "commit messages" in the row. No edit |
| 12 | `features/projects.md`: 2 adds a commit bullet + driving block; 5 replaces the notes bullet and adds a block after phase 2's | File collision | Disjoint anchors, phase 5 quotes phase 2's state; phase 3 does not touch it. No edit |
| 13 | `src/sessions/search.ts`: 1 rewrites, 5 extends | File collision | Phase 5 anchors every edit on phase 1's Step 2 text and depends on 1. No edit |
| 14 | `src/embeddings/worker.ts`, `src/embeddings/repo.ts` (`NON_BLANK_PATTERN` export) edited by phase 4 only | Ownership check | Confirmed: no other phase touches them; added to phase 4's Owns and package list |
| 15 | Phase 1 deletes private `maxOrNull`; phase 5 defines a private `maxOrNull` | Deleted-then-used check | Not a conflict: phase 5 creates its own (listed in its Creates); phase 5 uses none of `HitDbRow`, `NoteVia`, `hybridCandidates`, `HybridQuery` |
| 16 | Step 0 differed (phase 1 unconditional `npm ci`, phase 2 guarded, phases 3–5 none) | Consistency | Every phase now has the same Step 0: `[ -d node_modules ] || npm ci` |
| 17 | Phase 5's tool description / `instructions.ts` / README row mention "commit messages" (R1 wording) | Requirement creep check | Kept in phase 5 as the single owner of those strings (rule 3); doc text only, serves no R1 behavior, phase 5's Satisfies unchanged |
| 18 | `web/` (R5) | Invariant | Checked every plan's Files table: no file under `web/` in any phase; phase 5 asserts `git diff --stat origin/main -- web/` is empty |
| 19 | Analysis Impact Points 1–10 and Reference List | Gap check | All owned: 1→P1/P5, 2→P5, 3→P2/P3, 4→P2, 5→P3, 6→P4, 7→P5, 8→none (R5), 9→P2/P3/P5 (P4's worker documented by P5), 10→P3. No gap |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Arguments asked to surface via_notes/via_replies in "/projects web search results" vs user's later "DO NOT CHANGE the UI" | no web changes at all; surfaced through the Projects chat (query pill bar), MCP and HTTP only | 5: user's raw input (later, explicit instruction) |
| What counts as "what Claude said to the user" | the assistant text segment after the last tool_use of each turn (what `finalMessage` already captures), keyed to the prompt seq it answers; narration and sidechains excluded | 4: Why/Requirements ("only ... the things that claude said to user") |
| One vector per reply vs chunking long replies | one vector per reply, embed input clamped at 8000 chars by `embedInput` (p90 reply 3.2k chars) | 6: surrounding convention (note embeddings) |
| Discount related evidence (notes/replies) vs treat as own text | discount via a BLEND weight, value set by the labelled fixture in phase 5 | 4: Why/Requirements (accuracy "as much as possible"; over-match risk) |
| Migration numbering between phases 2 and 3 | phase 2 = 0013, phase 3 = 0014; phase 3 depends on phase 2 (shared drizzle journal/snapshot and schema.ts) | 6: convention (drizzle journal is linear) |
| Reply `items` in the replies source: `[{ seq, text }]` (phase 1 handoff) vs `[{ seq }]` with per-page `ts_headline` excerpts (phase 5 code) | `[{ seq }]`; excerpts fetched only for the shown page | 3: the plans' code blocks (phase 5's implementation; phase 1's was handoff prose) |
| How phase 5 applies the related weight: discount the raw winner via `Signal.from` (phase 1 handoff) vs compare `max(own, w × related)` from `c.row.*` / `c.related.*` | `max(own, w × related)`, own and related kept apart | 3: the plans' code blocks (phase 5 Step 1, with its worked counter-example) |
| Phase 5's dependency on phase 4's predicate: depend on 4 vs inline a copy | depend on 4; single definition in `replyEmbeddings.ts` | 6: surrounding convention (`isCurrentEmbeddingSql` is the one predicate for notes) |
| Reply vectors and phase 2's required `textVersion`: add a reply version column, pass a fake value, or omit | omit: `Omit<SessionEmbeddingInput, 'textVersion'>`; the sha of the stored text already detects every change | 2: phase 4's exit criteria ("an edited reply (new sha) is re-embedded"; nothing else re-embeds) |
| Golden snapshot after phase 2: may phase 2 regenerate it? | no; it must pass unchanged, only phase 5 regenerates | 2: phase 1's exit criteria (snapshot unchanged) and phase 5's (identity at `related: 1` against phase 1's snapshot) |
| Index `Status` value | `planned` (as the caller asked) | caller instruction |

## Open Questions

(none)

## Rollback

Per phase: revert its commit(s) (phase 5 has two: the feature and the regenerated golden snapshot). Migrations: 0013 regenerates a derived column and adds `text_version` (hand-down SQL in phase-2.md Rollback); 0014 is additive (phase-3.md Rollback drops `cc_session_reply_embeddings`, `cc_session_replies`, `cc_sessions.replies_version`; the data is derived and rebuilt by the backfill on re-apply). Roll back in reverse order: 5 → 4 → 3 → 2 (0014 sits on 0013); phase 1 is independent of 2–4 but must be reverted after 5. Whole set: revert the merge commit, then run phase 3's and phase 2's rollback SQL.

## Landing notes

- **`npm run db:migrate` (0013 + 0014) must run before the rebuilt daemon restarts.** `SessionsRepo`'s `SESSION_COLUMNS` selects `replies_version`, so new code against an unmigrated DB fails every session read and write. Order: `npm run build` → `npm run db:migrate` → restart the daemon. The other laptop's older daemon is safe against the migrated DB.
- After the restart each host backfills its own replies once (re-read of its transcripts, seconds), re-embeds every session once (`text_version` 0 → 1, ~738 embed calls, ~$0.005), and embeds every reply once (~2.5k replies, ~$0.02, ~3 min at 1 call/s). Without `OPENROUTER_API_KEY` only the backfill runs.
- Every phase's Step 0 is `[ -d node_modules ] || npm ci` (the worktree starts without `node_modules`).

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f /home/miftah/.worktrees/mcp-notes/session-search-context/.workflows/plan/SESSION_SEARCH_CONTEXT_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows, resumable on any machine:

    /analyze-orchestrator -f /home/miftah/.worktrees/mcp-notes/session-search-context/.workflows/plan/SESSION_SEARCH_CONTEXT_PLAN.md
