# Code Analysis: Projects session search context (sessions_search)

**Type:** Feature Implementation (with a refactor of the candidate-source code)
**Date:** 2026-11-06 14:58 WIB
**Session ID:** 20261106-145826-SSC7
**Plan:** `.workflows/plan/SESSION_SEARCH_CONTEXT_PLAN.md` (5 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-search-context`, branch `feature/session-search-context` (base `origin/main` @ `b41ae04`)

---

## User Input

### Original User Request

Conversation leading here (verbatim, user's words):

> there is another idea that popped up in my mind.
> the main objective is still the same: improving semantic search accuracy in Projects as much as possible.
> AFAIK, right now, the context of Projects semantic search is in each node is: my prompts and the linked notes.
> there are 2 more entities that we can exploit as the node's search context:
> 1. commit message (we saved commits in each node)
> 2. claude output in that whole session
> in regards to no 2, can you check whether we can "pass" some parts of claude output in a session into the node as well?
> right now we have successfully persist the node's prompts. what about claude's outputs in that session? can we persist some of them as well?
>
> ---
>
> i said "persist some of them" because i think for now, we only need to "save" the things that claude said to user in a session.
> as you know, a claude session is like a chat room, where a user say something (instructions/context/query/requirements) -> claude say something back to user.
> from my experience, usually claude can say a lot longer texts to respond to user's query.
> and i think if we can save these claude's answers in a session into its resepective node and utilize it into search context, then it definitely can improve semantic search accuracy.
>
> ---
>
> wdyt?

Then: "yes, do both. we might as well spawn analyze tmux to improve and refactor Projects semantic search feature robustly"

/analyze arguments (written by the session from the above and the measurements it took):

> sessions_search feature
> Improve and refactor the Projects semantic search (src/sessions/search.ts, sessions_search MCP tool, GET /api/sessions/search, the Projects chat) so it is as accurate as possible. Robust, not a quick hack.
>
> Already landed (b41ae04): a session's notes (origin.claude_session or note_session_links) are a 4th candidate source in searchSessions (hybrid + text mode); a session takes the better of its own and its best note's text rank / similarity; hits carry via_notes [{id, excerpt}] (max 3). Build on that, and refactor the candidate-source code so adding sources is clean (it is currently inline in hybridCandidates/textSearch).
>
> Add two more sources of search context per session node:
>
> 1. Commit messages. cc_sessions.commits (jsonb SessionCommit {sha, subject, at}) is stored per node but today reaches search only indirectly through the Haiku summary input (src/sessions/summarize.ts). Put commit subjects into the full-text index (search_tsv is a GENERATED column defined in src/db/schema.ts and drizzle/0007 -> needs a migration) and into buildEmbedText, so every session re-embeds once (embed sha changes).
>
> 2. Claude's answers to the user. Persist, per session, the assistant's reply to each human prompt: the LAST assistant text block(s) segment before the next human prompt (what Claude said to the user), NOT the in-between narration ("Now let me check..."), NOT tool calls, NOT subagent/sidechain transcripts. Mirror cc_session_prompts: new table (e.g. cc_session_replies: session_id, seq, at, text, truncated), redacted with the same redactSecrets as prompts, capped per reply, written only by SessionsRepo during normal tail ingestion (src/sessions/transcript.ts already tracks the assistant text `segment` used for finalMessage), plus a one-time from-byte-0 backfill versioned like PROMPTS_VERSION for sessions ingested before (transcripts already pruned by Claude Code just keep nothing; say so). Each reply gets its own embedding (the session's single vector clamps input at 8000 chars, so replies cannot go into it) and full-text tsvector, embedded in the background after commit, keyed by sha256 like note_embeddings, never blocking ingest; without OPENROUTER_API_KEY it degrades to text. Replies become a 5th candidate source in searchSessions mapped back to the session exactly like notes, and hits carry via_replies [{seq, excerpt}]. Replies live in the shared DB so they are searchable from both machines.
>
> Measured on this laptop: 738 sessions, 2681 prompts, 2511 replies; reply length median 1.4k chars, p90 3.2k, max 20k; 3.9M reply chars total (~1M tokens, ~$0.02 to embed with text-embedding-3-small); narration another 2.9M chars (excluded).
>
> Also: decide whether note/reply evidence should be discounted vs a session's own text (a session with many long replies may over-match); keep weights in src/search/blend.ts and prove the choice with a labelled fixture test. Surface via_notes/via_replies in the /projects web search results (Phosphor icons, icon-only buttons, never the Claude-default look) and in the Projects chat block so the agent quotes them. Update tool descriptions, README tables, CLAUDE.md sessions paragraph, and .claude/skills/verify-notesd/features/projects.md. Every phase proves itself with verify-notesd. Unit tests use fake embedders, no network.

Then, mid-analysis (verbatim, overrides the "Surface ... in the /projects web search results" part of the arguments above):

> important : DO NOT CHANGE the UI. we dont need a new session search box. query pill bar is enough for any kinds of query including searching something

### User-Provided Context
- Earlier in the same conversation the user's example query (Projects chat, repo mcp-notes): "can you check for me which nodes are related to the bug possibility that Seer Adversarial is showing 0 trades? after waiting for several days, i still see the Adversarial not doing any trades. is it truly not a bug?"
- Owner preferences (memory): icon-only buttons, Phosphor icons, never the Claude-default look; no human in the loop (run install/rebuild/restart yourself).

### User-Provided Files
- none marked with `@`.

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Commit messages of a session become part of its search context |
| R2 | Claude's answers to the user in a session are persisted per node |
| R3 | Those persisted answers are used as search context (semantic + words) |
| R4 | Improve and refactor Projects semantic search robustly (clean candidate sources, evidence weighting proven by a labelled test, surfaced in chat/MCP/HTTP/docs) |
| R5 | Do NOT change the UI: no new search box, no web changes; the query pill bar (Projects chat) is the way to search |

---

## Detailed Requirements Understanding

**Problem statement.** `searchSessions` (src/sessions/search.ts) ranks a session on: its generated `search_tsv` (node id, repo, name, custom/ai title, first/last prompt, prompts excerpts `$[*].text`, summary), one embedding per session (`cc_session_embeddings`, built by `buildEmbedText` = title|name|repo, summary, prompts, clamped to 8000 chars by `embedInput`), repo-as-tag, recency, exact node id, and since b41ae04 the session's notes. Commits and Claude's replies reach ranking only through the Haiku summary (whose input includes commits and the *final* assistant message only). Facts said by Claude mid-session (diagnoses, explanations, decisions) are therefore invisible to search unless the summary happened to keep them.

**Success criteria.**
1. A word or meaning that appears only in a session's commit subjects finds that session (text and hybrid).
2. Every human prompt's reply (the final assistant text segment of that turn) is stored, redacted, in a new table, on the owning host's ingest, incrementally, and once for already-ingested sessions whose transcripts still exist.
3. Each reply is embedded in the background (sha256-keyed, model-keyed, retry/backoff like note embeddings); ingest never waits for or fails on it; no key -> text-only.
4. A word or meaning that appears only in a reply finds its session; hits list `via_replies [{seq, excerpt}]`.
5. Candidate sources (session-own text, session vector, node id, notes, replies) are a clean, testable structure; the blend weights for "evidence via a related item" live in `src/search/blend.ts` with a labelled fixture test that proves the chosen discount.
6. Chat, MCP, HTTP, README, CLAUDE.md and the verify-notesd feature map all reflect it. **No file under `web/` changes** (R5).

**Key considerations.**
- `search_tsv` is `GENERATED ALWAYS AS (...) STORED` (drizzle/0007 line 67) with GIN index `cc_sessions_search_gin`; changing it means drop index, drop column, add column, recreate index in one migration. Postgres rewrites the table (738 rows; fine).
- The embed text is clamped at 8000 chars and prompts come last, so commit subjects must be placed before prompts in `buildEmbedText` or they are cut off for long sessions. `embedTextSha` of the new text differs, so the summary worker's `needEmbedding` condition must also see a stale sha; today it checks `e.embedded_at < s.last_active_at` etc., not the sha (see summaryWorker.ts:142). A version bump or sha comparison is needed to re-embed every session once.
- Replies: `TranscriptAccumulator.segment` (transcript.ts:453) collects assistant text blocks, is cleared on every `tool_use` block (line 658) and on every recorded prompt (`recordPrompt`, line 609). So at the moment a new prompt is recorded, `segment` holds exactly "the text after the last tool call of the previous turn" = the reply. At the end of a read it is the final message.
- Ingest is incremental: each read builds a new accumulator from the stored byte offset with a `TranscriptCarry` (recentMessageIds, pendingCommitIds); `segment` is NOT carried. A turn can straddle two reads (and a daemon restart). Reply rows must therefore be keyed to the prompt they answer (`seq` = that prompt's seq in `cc_session_prompts`) and a read must be able to (a) replace the reply of the last stored prompt when a tool_use happened in this read before any new prompt, or (b) append to it when only text arrived. Reads from byte 0 replace everything.
- Sidechain/subagent transcripts (`sidechain: true` accumulators) must not produce replies.
- Redaction: prompts use `redactSecrets` in `src/sessions/redact.ts` via merge.ts; replies must use the same.
- Size: 2511 replies, median 1.4k, max 20k chars. Per reply store cap ~16k chars (truncated flag); embed input clamps at 8000 (embedInput) — acceptable, or chunk; a single vector per reply is the decided baseline.
- Two machines share the DB; transcripts live on the owning host. Only the owning host writes its sessions' replies; search reads them from either host.
- Search blending: `rankCandidates` normalizes text rank by the best candidate. A session with many long replies may over-match generic queries; hence a discount weight for evidence that came through a related item (note/reply), tuned on a labelled fixture.
- There is **no session search box on `/projects` today**: `GET /api/sessions/search` has no web caller (grep of web/src finds none). The web surfaces that exist: the Projects chat (`web/src/components/projectChat/*`, renders node and note links), the node panel (`aside.np`) with its "Prompts" modal (`GET /api/sessions/:nodeId/prompts`).

**Assumptions.** Embedding model is the note model (`openai/text-embedding-3-small`, 1536 dims, `EMBEDDING_DIMENSIONS`). `redactSecrets` is adequate for replies. The Projects chat is the primary consumer.

---

## Analysis Scope

### Discovered Related Files
- `src/sessions/search.ts` — searchSessions, textSearch, hybridCandidates, notes source (b41ae04), toHit, SessionSearchHit/SessionNoteMatch.
- `src/search/blend.ts` — BLEND weights, rankCandidates, blendScore, isEligible.
- `src/search/queryVector.ts` — embedQuery, QueryVectorCache.
- `src/sessions/readModel.ts` — SessionSearchFn/phase6Search (maps hits, carries viaNotes), searchNodes (SearchPayload), session detail notes query (made ∪ linked), prompts payload (`cc_session_prompts`, PROMPTS_VERSION logic, line ~470-495).
- `src/sessions/view.ts` — SearchHit/SearchNoteMatch/SearchPayload, excerpt(), NOTE_EXCERPT_CHARS, toPromptsPayload.
- `src/mcp/sessionTools.ts` — sessions_search (description + output mapping incl. via_notes), session_get, session_transcript.
- `src/http/sessionsApi.ts` — `GET /api/sessions/search` (line ~185), `GET /api/sessions/:nodeId/prompts`.
- `src/chat/context.ts` — renderProjectBlock (mentions via_notes), `src/chat/prompt.ts:41` system prompt text for project threads.
- `src/sessions/transcript.ts` — TranscriptAccumulator (segment, addUser, recordPrompt, addAssistant, delta, buildTranscriptPatch), TranscriptCarry.
- `src/sessions/ingest.ts` — tail loop (accumulators at lines ~426, ~490, ~614), promptsBackfill (PROMPTS_VERSION, from-byte-0 re-read, redactStoredPrompts when transcript is gone).
- `src/sessions/repo.ts` — SessionsRepo: only writer; upsertFromTranscript (line 342, writes prompts in the same tx, sets prompts_version), replacePrompts (415), prompt rows writer (~292-330), backfill candidates (~392).
- `src/sessions/merge.ts` — patch merge, prompt rows building and redaction, MAX_FINAL_MESSAGE_CHARS clip.
- `src/sessions/types.ts` — PROMPTS_VERSION(=3), PROMPTS_VERSION_EXCERPTS(=1), MAX_* caps, TranscriptPatch.
- `src/sessions/redact.ts` — redactSecrets.
- `src/sessions/summarize.ts` — buildSummaryInput (commits included), buildEmbedText (no commits), embedTextSha, SUMMARY_PROMPT_VERSION.
- `src/sessions/summaryWorker.ts` — session summary + session embedding worker; needEmbedding SQL (line ~142), saveEmbedding.
- `src/embeddings/worker.ts`, `backfill.ts`, `state.ts`, `repo.ts` — note embedding worker pattern (sweep 60s, debounce, RateLimiter, retryDelayMs, clampError, isCurrentEmbeddingSql, currentBodySha256Sql).
- `src/background.ts` — starts embedding, image embedding, session ingest, link worker, summary worker; the place a reply-embedding worker starts.
- `src/db/schema.ts` — ccSessions (searchTsv generated column, line ~555), ccSessionPrompts (620), ccSessionPromptImages (643), noteSessionLinks (672), ccSessionEmbeddings (692).
- `drizzle/0007_cc_sessions.sql` (search_tsv definition), latest migration `drizzle/0012_session_prompt_images.sql`, `drizzle/meta/_journal.json`.
- `tests/integration/sessions.search.int.test.ts` (search + notes tests), `sessions.ingest.int.test.ts`, `sessions.prompts.int.test.ts`, `sessions.summaries.int.test.ts`, `sessions.mcp.int.test.ts`, `sessions.api.int.test.ts`; unit `tests/unit/search.blend.test.ts`, `tests/unit/sessions/*`; fixtures `tests/fixtures/claude-home`, `tests/fixtures/semantic/labelled.ts`; `tests/helpers/fakeEmbedder.ts`; `tests/integration/setup.ts` (truncateAll must include new tables).
- Web: `web/src/pages/ProjectsPage.tsx`, `web/src/components/graph/*` (node panel, Prompts modal), `web/src/components/projectChat/*`, `web/src/sessionDetailApi.ts`, `web/src/sessionsApi.ts`.
- Docs: `README.md` (HTTP + MCP tables), `CLAUDE.md` (Claude Code sessions paragraph), `.claude/skills/verify-notesd/features/projects.md`.

---

## Current Dataflow

### Entry: sessions_search (MCP) / GET /api/sessions/search / Projects chat
`registerSessionTools` (src/mcp/sessionTools.ts:48) and the HTTP route call `searchNodes(rd, {query, repo, limit})` (readModel.ts:~567) -> `rd.search` = `phase6Search` -> `searchSessions({db, embedder}, query, {limit, repo})`. The Projects chat agent reaches the MCP tool through the daemon's own `/mcp` (src/chat/agent.ts, allowedChatTools).

### Processing chain (searchSessions)
1. Empty query -> NoteError invalid_input. filterSql validates dates.
2. mode text or no embedder -> textSearch: CTE `via` = sessionsOfNotesSql(notes text match) ; sessions where own tsv matches or via exists; rank = greatest(own ts_rank, best note rank); returns via_notes.
3. hybrid: embedQuery (cache, timeout -> text fallback) -> hybridCandidates:
   1. session full-text rows (<= BLEND.textCandidates), with similarity from cc_session_embeddings
   2. nearest session vectors (<= BLEND.vectorCandidates), exclusions applied
   3. node-id rows
   4. notes source: matched notes (text <= textCandidates ∪ vector <= vectorCandidates, live, owned by a session) -> owners (origin ∪ links) -> per session max(text_rank), max(similarity), jsonb_agg via_notes; sessions not yet present fetched; merge by per-signal max.
4. rankCandidates (blend.ts) with tagMatch(repo), recency(last_active_at), exactId; slice by offset cursor; toHit adds available/title/via_notes.
5. searchNodes joins NODE_SELECT rows, rounds score, adds via_notes; MCP maps to wire output (summary excerpt, via_notes, url).

### Ingest chain (where replies come from)
`startSessionIngest` (ingest.ts) tails `~/.claude/projects/**/*.jsonl` from `transcript_offset`; per read a `TranscriptAccumulator` folds records; `buildTranscriptPatch` -> `SessionsRepo.upsertFromTranscript(patch)` writes cc_sessions (merge.ts) and, in the same transaction, appends `cc_session_prompts` rows (or replaces on fromOffset 0). One-time `promptsBackfill` re-reads rows below PROMPTS_VERSION from byte 0 (`replacePrompts`) or redacts excerpts in place when the transcript is gone.

### Summary / session-embedding chain
`startSummaryWorker` (summaryWorker.ts) selects sessions needing a summary (summary_sha differs) or an embedding (no row, other model, embedded_at older than last_active_at or summarized_at); builds `buildEmbedText` and stores `cc_session_embeddings {sha, model, embedding}`.

### Data persistence
- `cc_sessions` (search_tsv generated), `cc_session_prompts (session_id, seq, at, text, truncated)`, `cc_session_prompt_images`, `cc_session_embeddings (session_id, sha, model, embedding vector(1536), attempts?, embedded_at...)`, `note_session_links`, `notes`, `note_embeddings`.

### Exit points
- MCP JSON `{query, mode, fallback, hits:[{node_id,..., summary, via_notes, score, url}], next}`; HTTP SearchPayload; chat agent text citing node ids / note ids.

---

## Key Data Structures
- `SessionSearchHit` (search.ts) — wire hit incl. `via_notes: SessionNoteMatch[]`.
- `HitDbRow`, `NoteVia` (search.ts, internal).
- `BlendCandidate`, `BlendTuning`, `BLEND` (blend.ts).
- `SessionSearchHit`/`SessionSearchOutcome` (readModel.ts) — `{sessionId, score, viaNotes?}`.
- `SearchHit`/`SearchNoteMatch`/`SearchPayload` (view.ts).
- `TranscriptDelta`, `TranscriptPatch`, `PatchPrompt`, `TranscriptCarry` (transcript.ts / types.ts).
- `SessionCommit {sha, subject, at}` (schema.ts:468).

## Dependencies
- Env: `OPENROUTER_API_KEY` (embedder; null -> text fallback), `CLAUDE_HOME`, `NOTESD_*` toggles. Tests: fake embedder (`tests/helpers/fakeEmbedder.ts`, concept-bag), Docker pgvector (scripts/test-int.sh).
- External: OpenRouter embeddings (billed; ~$0.02 one-off for all replies).

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| search_tsv definition | src/db/schema.ts:~555, drizzle/0007_cc_sessions.sql:67 | def/config | db |
| SESSION_TSV_COLUMN | src/sessions/search.ts:16 | def | sessions |
| hybridCandidates / textSearch / sessionsOfNotesSql | src/sessions/search.ts | def | sessions |
| BLEND / rankCandidates | src/search/blend.ts | def | search |
| buildEmbedText / embedTextSha | src/sessions/summarize.ts:196 | def | sessions |
| needEmbedding SQL | src/sessions/summaryWorker.ts:142 | call | sessions |
| segment / recordPrompt / addAssistant | src/sessions/transcript.ts:453,605,638 | def | sessions |
| upsertFromTranscript / replacePrompts | src/sessions/repo.ts:342,415 | def | sessions |
| promptsBackfill | src/sessions/ingest.ts:~48-140 | def | sessions |
| PROMPTS_VERSION | src/sessions/types.ts:99 | config | sessions |
| via_notes | search.ts, readModel.ts, view.ts, sessionTools.ts, context.ts | def/call | sessions/mcp/chat |
| renderProjectBlock | src/chat/context.ts:107 | def | chat |
| project system prompt | src/chat/prompt.ts:41 | doc | chat |
| GET /api/sessions/search | src/http/sessionsApi.ts:185 | def | http |
| GET /api/sessions/:nodeId/prompts | src/http/sessionsApi.ts, readModel.ts ~470 | def | http |
| truncateAll | tests/integration/setup.ts | test | tests |
| features/projects.md | .claude/skills/verify-notesd/features/projects.md | doc | skill |

## Impact Points (files that WILL need changes)
1. `src/sessions/search.ts` — candidate-source refactor (P1), replies source + via_replies (P5).
2. `src/search/blend.ts` + `tests/unit/search.blend.test.ts` + labelled fixture — related-evidence discount (P5).
3. `src/db/schema.ts`, new `drizzle/0013_*` — search_tsv with commit subjects (P2); new `drizzle/0014_*` — cc_session_replies (+ generated tsv) and cc_session_reply_embeddings (P3).
4. `src/sessions/summarize.ts`, `summaryWorker.ts` — commits in embed text + forced re-embed (P2).
5. `src/sessions/transcript.ts`, `types.ts`, `merge.ts`, `repo.ts`, `ingest.ts` — reply capture, storage, backfill (P3).
6. New `src/sessions/replyEmbeddings*.ts` (worker + store), `src/background.ts` — reply embedding worker (P4).
7. `src/sessions/readModel.ts`, `view.ts`, `src/mcp/sessionTools.ts`, `src/http/sessionsApi.ts`, `src/chat/context.ts`, `src/chat/prompt.ts` — via_replies wiring (P5); no prompts-payload change (R5: nothing in the web needs it).
8. `web/` — NOT changed (R5, user instruction).
9. `README.md`, `CLAUDE.md`, `.claude/skills/verify-notesd/features/projects.md` — docs (each phase documents its own part; P5 final pass).
10. `tests/integration/setup.ts` truncateAll — new tables (P3).

**This document describes. The plan files prescribe.**
