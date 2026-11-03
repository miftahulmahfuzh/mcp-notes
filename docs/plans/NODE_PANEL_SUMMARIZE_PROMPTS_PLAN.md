# Plan: Node panel — Summarize on demand + Prompts modal

**Slug:** node-panel-summarize-prompts
**Date:** 2026-11-03 15:00 (Asia/Jakarta)
**Analysis:** `docs/analyzer/20261103-150033-K7Q2_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts`
**Branch:** `feature/node-panel-summarize-prompts` (base: `origin/main` @ `5c21bad`)
**Phases:** 5
**Status:** planned
**Coordinator:** —

---

## Why

R1 (user, verbatim): "the summary in node details, many nodes still said 'Summary / No summary yet' ... can we theoretically skim the whole session (if this session is in the same machine) using Haiku and get the summary of it? if we can, i think we need to add a "Summarize" icon button there. so user can click it in case user wants the summary of this node."

R2 (user, verbatim): "this the Prompts field, add an "expand" icon button so user can see the whole Prompts of this node in a bigger-view modal, please add a copy icon button for every prompt number. and also "copy whole prompts" icon button maybe at the top right of the bigger-view modal"

The decided design (do not re-litigate) is quoted in full in the analysis document's "Original User Request". Its load-bearing points:

- R1: request recorded in the shared DB through SessionsRepo; never call Haiku in the HTTP request; the OWNING host's worker serves requests first, ignoring the idle wait (live session gets a "summary so far"), respecting the rate limiter and failure pause; reason labels "Empty session" (0 tokens; no button), "Summarizes once idle", "Summary requested", "Will be summarized on <host>"; same-origin POST next to the session routes; no MCP.
- R2: store every typed prompt in full (sanity ceiling ~256 KB, marked truncated), redacted with `src/sessions/redact.ts` before it is written, no raw copy anywhere in the DB; one-time idempotent per-host backfill that also replaces the old truncated unredacted prompts, touching nothing else; graph list and other queries never load prompt text; modal loads from the DB, never the transcript; per-prompt copy ("Copy prompt N") and "Copy all prompts" (`1. <text>\n\n2. <text>…`); Esc/backdrop close only the modal.
- Both: icon-only Phosphor buttons in existing panel styling; update `.claude/skills/verify-notesd/features/projects.md`; prove with verify-notesd (`up --sessions --web`) using a fixture with a >2000-char prompt and >100 prompts; after landing rebuild + restart the live daemon.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Summarize on demand: Summarize button records a request; the owning host's worker summarizes requested sessions first; reason labels replace "No summary yet" | 1, 2, 4 |
| R2 | Full, redacted prompts in the shared DB (with per-host backfill) and an "Expand prompts" modal with per-prompt copy and copy-all | 1, 3, 5 |

## Scope

**In scope:** schema/migration 0010; SessionsRepo writers; summary worker request handling; ingest storing full redacted prompts in a side table plus a once-per-host backfill; read API for summary state and the full prompt list; NodePanel Summary and Prompts sections, the prompts modal; fixtures; unit + integration tests; verify-notesd feature map.

**Out of scope:** diagnosing GPD's paused summary worker (user: "out of scope here, diagnose on GPD"); MCP tools for either feature (user: "MCP not needed"); changing the summarizer's own input caps (`summarize.ts` 40 × 1500) or the embedding text; redacting other hosts' rows from this host (each host backfills its own, per the design).

## Invariants

1. The tree builds (`npm run typecheck`), and `npm test` passes at the end of every phase; `npm run test:int` passes at the end of phases 1, 2, 3 and 5.
2. `SessionsRepo` (`src/sessions/repo.ts`) is the only writer of `cc_sessions` and `cc_session_prompts`. The summary worker and HTTP routes write only through it.
3. No HTTP request ever calls the summarizer (Haiku). The POST only records a request.
4. No prompt text reaches the DB unredacted: every write of `cc_session_prompts.text`, `cc_sessions.prompts[].text`, `cc_sessions.first_prompt` and `cc_sessions.last_prompt` passes through `redactSecrets` first, inside SessionsRepo (or `mergeTranscriptPatch`, which it calls). No raw copy is stored anywhere.
5. The graph list (`graphForRepo`, `NODE_SELECT`), the summary worker candidate query, and every other query that does not need full prompt text never read `cc_session_prompts`. `cc_sessions.prompts` stays the bounded excerpt list (newest 100, each ≤ 2000 chars, now redacted) that feeds `search_tsv`, the summarizer and the embed text.
6. The prompts backfill changes only `cc_session_prompts`, `cc_sessions.prompts`, `first_prompt`, `last_prompt`, `prompts_version` (and `updated_at`). Tokens, models, cost, commits, files, plan docs, parent links, offsets and summaries stay byte for byte as they were.
7. The backfill only ever reads transcripts of rows whose `host` is this host; other hosts' rows are left for their own daemon.
8. Only the owning host's worker summarizes a session; requested sessions still go through the existing `summaryLimiter` and the global failure pause.
9. Tests never touch the real `~/.claude`, the live daemon on 7317, Neon or `~/mcp-notes-data`; embeddings/summaries in tests are fakes.
10. UI: icon-only Phosphor buttons (`weight="duotone"`, `className="ibtn hov"`, `data-tip` + `aria-label`), existing panel styling.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Schema 0010 + SessionsRepo summary-request writer | R1, R2 | `src/db`, `src/sessions/repo.ts` | 11 | — | NORMAL | `.workflows/plan/node-panel-summarize-prompts/phase-1.md` | — | — |
| 2 | Summary requests: worker priority, POST route, summary state in detail | R1 | `src/sessions`, `src/http` | 10 | 1 | NORMAL | `.workflows/plan/node-panel-summarize-prompts/phase-2.md` | — | — |
| 3 | Full redacted prompts: ingest into `cc_session_prompts` + per-host backfill | R2 | `src/sessions`, `tests/fixtures` | 14 | 1 | HARD | `.workflows/plan/node-panel-summarize-prompts/phase-3.md` | — | — |
| 4 | Node panel Summary: reason labels + Summarize button | R1 | `web/` | 8 | 2 | NORMAL | `.workflows/plan/node-panel-summarize-prompts/phase-4.md` | — | — |
| 5 | Prompts read API + Expand prompts modal with copy | R2 | `src/sessions`, `src/http`, `web/` | 16 | 2, 3, 4 | NORMAL | `.workflows/plan/node-panel-summarize-prompts/phase-5.md` | — | — |

Plan: 5 phases, 59 file touches (some files touched by two sequential phases) across db, sessions, http, web and fixtures; one shared migration both features need. R1 -> 1,2,4 · R2 -> 1,3,5. Phases 2 and 3 run in parallel and share no file (checked: 2 owns summaryWorker/readModel/view/sessionsApi, their tests and `features/projects.md`; 3 owns types/transcript/merge/repo/ingest, fixtures, `claudeHome.ts`, `memoryIngestStore.ts` and their tests). 4 can run beside 3. Sequential shared files: `src/sessions/types.ts`, `src/sessions/repo.ts`, `tests/helpers/memoryIngestStore.ts`, `tests/unit/sessions/merge.test.ts` (1 then 3); `src/sessions/readModel.ts`, `view.ts`, `src/http/sessionsApi.ts`, `tests/integration/sessions.api.int.test.ts` (2 then 5); `web/src/sessionDetailApi.ts` (+ test), `NodePanel.tsx`, `NodePanel.test.tsx` (4 then 5); `.claude/skills/verify-notesd/features/projects.md` (2, then 4, then 5). Each later plan quotes these files as the earlier phase leaves them.

### Phase 1 — Schema 0010 + SessionsRepo summary-request writer
**Satisfies:** R1, R2 (coupled on purpose: one drizzle migration and one `_journal.json` entry both features need; two parallel phases generating `0010` would collide).
**Owns:** `src/db/schema.ts` (`cc_sessions.summary_requested_at timestamptz null`, `cc_sessions.prompts_version integer not null default 0`, new table `cc_session_prompts(session_id text references cc_sessions on delete cascade, seq integer, at timestamptz null, text text not null, truncated boolean not null default false, primary key(session_id, seq))` with `seq` from 1; the `prompts` column comment now says "capped and redacted; the full list is `cc_session_prompts`"), `drizzle/0010_session_prompts_summary_requests.sql` + `drizzle/meta/0010_snapshot.json` + `_journal.json` (via `npm run db:generate`), `src/sessions/types.ts` (re-exports `CcSessionPromptRow`/`NewCcSessionPromptRow`; `SummaryRequest`), `src/sessions/repo.ts` (`requestSummary(sessionId)` sets `summary_requested_at` only when null and returns `{ requestedAt } | null`; `setSummary` also clears `summary_requested_at`; `clearSummaryRequest(sessionId): boolean`; class doc comment names `cc_session_prompts`), `blankSessionRow` / merge-test `blankRow` gain the two fields, `truncateAll` lists the table, `migration0010.int.test.ts`, repo int tests.
**Does not touch:** ingest, merge, transcript, summaryWorker, readModel, view, http, web, prompt constants in `types.ts`, `features/projects.md`.
**Exit criteria:** migration applies on a fresh DB and on an existing 0009 DB with data unchanged; generated SQL matches the plan and `db:check` is clean; `requestSummary`/`setSummary`/`clearSummaryRequest` covered by an int test; typecheck + unit + int green.

### Phase 2 — Summary requests: worker priority, POST route, summary state in detail
**Satisfies:** R1
**Owns:** `src/sessions/summaryWorker.ts` (`SUMMARY_REQUEST_LIMIT`; `SummaryStore.listRequested({host, limit})` + `clearRequest`; `dbSummaryStore` implements them; `drainOnce` serves requested candidates first through `processAll`, skipping the idle/live/`seen` filters for them but not `retryAt` nor the pause; same limiter; a request whose `buildSummaryInput` is null is cleared; an up-to-date summary is re-saved to clear the request; success clears it via `setSummary`), `src/sessions/view.ts` (`SummaryState`, pure `summaryState()`, `SummaryRequestPayload`, `SessionInfo.summary_requested_at` + `summary_state`, `DetailRow.summary_requested_at`), `src/sessions/readModel.ts` (`DETAIL_SELECT` adds `s.summary_requested_at`; `SessionsReadDeps.requestSummary` writer seam backed by `SessionsRepo.requestSummary`; `requestSummaryFor(rd, nodeId)`), `src/http/sessionsApi.ts` (`POST /api/sessions/:nodeId/summarize`, `sameOriginOnly`; 400 `invalid_node_id`, 404 `not_found`, 409 `empty_session`, 200 `{ node_id, summary_state, summary_requested_at }`, idempotent, `ready` writes nothing), worker/view/route unit tests, summaries + api int tests, `features/projects.md` (API half of the "Summary on demand" bullet, "Summary requests." driving block, one Gotcha line).
**Does not touch:** ingest/transcript/merge/types/repo, `cc_session_prompts`, web/, the prompts parts of readModel/view, fixtures.
**Exit criteria:** a requested live session on this host is summarized on the next drain and its request cleared; a request of another host is never summarized here; pause + limiter respected (tests); POST is same-origin only and never calls the summarizer; detail carries `summary_state` and `summary_requested_at`; 409 `empty_session` proven by the int test (no 0-token fixture node exists); typecheck + unit + int green.

### Phase 3 — Full redacted prompts: ingest into `cc_session_prompts` + per-host backfill
**Satisfies:** R2
**Owns:** `src/sessions/types.ts` (`MAX_PROMPT_STORE_CHARS = 256 * 1024`, `PROMPTS_VERSION_EXCERPTS = 1`, `PROMPTS_VERSION = 2`, `PatchPrompt`, `StoredPrompt`, backfill types; `TranscriptPatch.prompts: PatchPrompt[]`), `src/sessions/transcript.ts` (accumulator keeps every prompt, cut only at the ceiling with `truncated`; `readJsonlFrom` `until`), `src/sessions/merge.ts` (redact then clip excerpts, `first_prompt`, `last_prompt`; pure side-row and backfill helpers), `src/sessions/repo.ts` (`upsertFromTranscript` writes side rows in the same tx — append after max seq, or replace on `fromOffset 0` — redacted, and sets `prompts_version = 2` only on a `fromOffset 0` write; `promptsBackfillCandidates(host)` = rows of host with `prompts_version < 2`; `replacePrompts` CAS on `transcript_offset` + host under the row lock, writes only invariant-6 columns, sets 2; `redactStoredPrompts` for a missing transcript sets 1 and answers `current` without writing for a row already at 1 or above), `src/sessions/ingest.ts` (one-time backfill after the startup pass through the per-file hold; missing file → `redactStoredPrompts`; one log line only when a row was filled, redacted, deferred or failed), fixture `5e55a001-…-000000000005.jsonl` + generator (106 prompts, #50 > 2000 chars, #60 with a fake `sk-ant-…` key), `tests/helpers/claudeHome.ts`, `memoryIngestStore.ts` class body, unit tests (accumulator, merge, redaction byte for byte, backfill incl. version 1 skip and upgrade), int tests (`sessions.prompts.int.test.ts`, ingest counts).
**Does not touch:** `src/db/schema.ts`, drizzle, Phase 1's repo methods and `blankSessionRow`/`blankRow`, summaryWorker, readModel/view/http, web, `features/projects.md`.
**Exit criteria:** the fake key never appears in any table; the rest of that prompt is byte-identical in `cc_session_prompts`; the backfill fills a legacy row to version 2 with every other column unchanged (int test compares rows) and a second run is a no-op; other hosts untouched; a row whose transcript is gone is redacted in place at version 1 (never 2), skipped without a write on the next start, and upgraded to 2 once its transcript is readable; graph query unchanged (no join to the side table).

### Phase 4 — Node panel Summary: reason labels + Summarize button
**Satisfies:** R1
**Owns:** `web/src/sessionDetailApi.ts` (`SummaryState`, `summary_state` / `summary_requested_at` in `SessionDetail`, `requestSummary(nodeId)` POST, `summarizeErrorNotice`), `web/src/lib/subtree.ts` (`SubtreeNode.summarized`, `GraphLikeNode.summary_excerpt`), `web/src/components/graph/NodePanel.tsx` (Summary section `np-sec-head` with icon-only `MagicWand` "Summarize" button when no summary and state not `empty`/`requested`; `SummaryLine` reason text; optimistic "Summary requested"; refetch stamp includes `summarized`), `NodePanel.css` (`.np-sec-head > .ibtn`), tests (`NodePanel.test.tsx`, `sessionDetailApi.test.tsx`, `subtree.test.tsx`), `features/projects.md` (replaces Phase 2's bullet and Gotcha with merged API + UI versions; "Summarize in the wall." block).
**Does not touch:** the Prompts section, `useCopied`, server code, fixtures.
**Exit criteria:** the four reason strings (plus "No summary yet" for a null state) render for their states; the button posts once and the label flips to "Summary requested"; no button for "Empty session", "Summary requested" or when a summary exists; a graph node gaining a summary triggers one detail refetch; jsdom tests green; one merged "Summary on demand" entry in the feature map.

### Phase 5 — Prompts read API + Expand prompts modal with copy
**Satisfies:** R2
**Owns:** `src/sessions/view.ts` (`PromptsIncompleteReason`, `NumberedPrompt`, `PromptsPayload { node_id, host, available, complete, incomplete_reason, prompts }`, `PromptsSource` `full | pruned | legacy`, `toPromptsPayload`), `src/sessions/readModel.ts` (`sessionPrompts(rd, nodeId)`: `prompts_version >= 2` → side rows, complete; `= 1` → side rows, `complete: false, incomplete_reason: 'transcript_pruned'`; `0` → `cc_sessions.prompts` excerpts, `complete: false, incomplete_reason: 'not_backfilled'`), `src/http/sessionsApi.ts` (`GET /api/sessions/:nodeId/prompts`), `web/src/sessionDetailApi.ts` (`fetchSessionPrompts`, `normalizeSessionPrompts`), `web/src/hooks/useCopied.ts` (`copy(key, text?)`, backward compatible), new `PromptsModal.tsx` + `PromptsModal.css` (`prm-`), `NodePanel.tsx` (Prompts section `np-sec-head` with icon-only `ArrowsOut` "Expand prompts"), `NodeModal.tsx` (Esc yields to the prompts modal), tests (shaper unit, route int incl. version 1 and 0, modal jsdom: numbering, whitespace, "Copy prompt N", "Copy all prompts" join, both incomplete lines, Esc and backdrop close only the modal), `features/projects.md` (R2 bullet, driving block, gotchas).
**Does not touch:** ingest/merge/transcript/repo writers, summary worker, NodePanel's Summary section, `DETAIL_SELECT`, fixtures.
**Exit criteria:** modal lists every stored prompt of the fixture session (>100), the >2000-char prompt in full, the fake key shown as `[redacted]`; copy buttons copy exactly the shown text; Esc/backdrop close only the modal; a version 1 row is never reported complete and shows "Older prompts were cut; the full text is no longer on <host>", a version 0 row shows "Full prompts arrive once <host> backfills"; feature map updated; verify-notesd proof captured.

## Reconciliation Log

| # | Conflict | Class | Phases | Resolution |
|---|---|---|---|---|
| 1 | Phase 3 marked rows redacted in place from excerpts (transcript pruned) with the same `prompts_version` as fully backfilled rows, so Phase 5's `complete = prompts_version >= PROMPTS_VERSION` reported a ≤100-excerpt list as complete | Contract drift / behavioral fork | 3, 5 (1 wording) | Two constants in `types.ts`: `PROMPTS_VERSION_EXCERPTS = 1`, `PROMPTS_VERSION = 2`. Candidates stay `< 2`; `redactStoredPrompts` writes 1 and answers `current` for a row at ≥ 1; a readable transcript upgrades 1 → 2. Phase 5 serves version 1 from the side rows with `complete: false, incomplete_reason: 'transcript_pruned'` and its own modal line. Tests added in both phases (unit + int skip/upgrade; int, unit, web, jsdom for the reason). Phase 1's column wording updated |
| 2 | Version-1 rows stay candidates, so every daemon start would print the backfill line | Gap (side effect of 1) | 3 | Log only when a row was filled, redacted, deferred or failed |
| 3 | Phase 2's proof used fixture `…0003` as the 0-token "EMPTY" node, but it is an `sdk-cli` transcript that ingest excludes, so the node id resolves to nothing | Unmet assumption | 2 | Live-run journeys drop EMPTY; 409 `empty_session` proven by `sessions.api.int.test.ts`; a 404 check added on the run; driving block notes it |
| 4 | Phases 2 and 4 each added a "Summary on demand"/"Summarize on demand" Sub-features bullet and an overlapping Gotcha to `features/projects.md` | Duplicate work | 2, 4, 5 | Phase 2 writes the API half first; Phase 4 replaces that bullet and Gotcha with merged versions and adds its UI block after Phase 2's driving block; Phase 5 quotes the merged state |
| 5 | Phase 1's `cc_session_prompts` doc said `seq` from 0; Phase 3 writes 1..n and Phase 5 numbers from 1 | Contract drift | 1, 3 | Phase 1 doc says "from 1, no gaps" |
| 6 | Phase 3 asked Phase 1 to update the `prompts` column comment in `schema.ts`; no phase owned it | Gap | 1 | Assigned to Phase 1 (Step 1g; comment only, generated SQL unchanged) |
| 7 | Phases 1 and 3 both rewrote the `repo.ts` class doc comment | Duplicate work | 1, 3 | Phase 1 owns it (already names `cc_session_prompts`); Phase 3's step removed |
| 8 | Phase 3 quoted `types.ts`, `repo.ts` and `memoryIngestStore.ts` line numbers and the `repo.ts` import list as they are before Phase 1 | File collision | 1, 3 | Phase 3 now cites post-Phase-1 lines (+7 in `types.ts`, +1/+2 in `repo.ts`, +2 in `memoryIngestStore.ts`) and its import block keeps Phase 1's `type SummaryRequest` |
| 9 | Phase 5 left two conditional handoffs (fixture version set only by backfill?; Phase 4 CSS rule dropped?) and quoted readModel's insertion point conditionally | Unmet assumption (open) | 3, 4, 5 | Confirmed: Phase 3 sets version 2 on the offset-0 ingest; Phase 4 Step 3 has `.np-sec-head > .ibtn`; Phase 5 inserts after Phase 2's `requestSummaryFor` and keeps Phase 2's view imports |
| 10 | Index listed Phase 5 as HARD and file counts as ~N; the plans differ | Index drift | 1-5 | Phase table uses the plans' difficulty (Phase 5 NORMAL) and exact Files-table counts |
| 11 | Concurrency check, Phases 2 and 3: no shared file. Phase 3 does not touch `features/projects.md` | Check, no conflict | 2, 3 | None needed |
| 12 | Contract checks: `ccSessionPrompts` names (1) match Phase 3/5 usage; Phase 2 relies on `setSummary` clearing the request (1 does); Phase 4 uses Phase 2's wire names exactly; Phase 5 relies on `.np-sec-head > .ibtn` (4 has it); `SubtreeNode.summarized` (4) has no Phase 5 literal to break; `useCopied` change (5) is backward compatible and Phase 4 does not call it | Check, no conflict | 1-5 | None needed |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Full prompts in `cc_sessions.prompts` jsonb vs a side table | Side table `cc_session_prompts`; jsonb stays the bounded, redacted excerpt list | 5: user raw input ("If the prompts jsonb column … makes detail/graph queries heavy, move prompts to a side table"), plus the generated `search_tsv` over that jsonb would hit Postgres' 1 MB tsvector limit on big sessions and fail ingest |
| Redact only the side table vs also `first_prompt`, `last_prompt`, jsonb excerpts | Redact every stored prompt text (all four) | 5: user raw input ("secrets pasted into a prompt … never reach the shared DB", "no unredacted prompt is left behind on this host") |
| Backfill version marker | `cc_sessions.prompts_version int`: 0 legacy, 1 = `PROMPTS_VERSION_EXCERPTS` (transcript gone, excerpts redacted in place), 2 = `PROMPTS_VERSION` (full + redacted) | 5: user raw input ("e.g. a stored 'prompts_full' version per session"); the split of 1 and 2 is the next row |
| Rows on this host whose transcript was pruned: same version as full rows (Phase 3 draft) vs a distinct one | Redact in place and mark `PROMPTS_VERSION_EXCERPTS` (1), never complete; still a backfill candidate, skipped without a write while the file is missing, upgraded to 2 if it is readable again | 2: Phase 5's exit criterion ("modal lists every stored prompt") and code block (`complete = prompts_version >= PROMPTS_VERSION`) cannot hold for an excerpt list marked full; 5: user raw input keeps the redact-in-place ("no unredacted prompt is left behind on this host") and "a one-time, idempotent backfill" (no repeat writes) |
| How the modal tells "not backfilled yet" from "transcript pruned" | Server-computed `incomplete_reason: 'not_backfilled' \| 'transcript_pruned' \| null` on the prompts payload, derived from one `PromptsSource` union; two distinct dim lines | 6: convention — the set already computes display state on the server (`summary_state`, Phase 2) so the web maps an enum to a label |
| Backfill log line on every start once version-1 rows exist | Log only when a row was filled, redacted, deferred or failed | 6: convention — `formatSummaryReport` logs only when something happened |
| Other hosts' legacy rows | Left for their own daemon's backfill | 5: user raw input ("Each host re-reads its OWN transcripts once") |
| One migration for both features | Phase 1 owns the single 0010 migration (R1 + R2) | 6: convention (drizzle journal is linear; two parallel generators collide) |
| Modal for a row not backfilled yet (other host offline) | Show the stored excerpts with a dim line saying the full prompts arrive once `<host>` backfills (`incomplete_reason: not_backfilled`) | 5: "It loads from the DB, so it works for every node on every host. It never reads the transcript." |
| Where the Summarize button shows | Only when there is no summary and the state is not `empty` or `requested`; on every host | 5: user raw input (button where "No summary yet" was; "works for GPD nodes too") |
| One feature-map entry for R1 vs one per phase | One merged "Summary on demand" bullet and one summary Gotcha; Phase 2 writes the API half, Phase 4 replaces it with the merged text | 6: convention — `features/*.md` has one bullet per user-facing feature |

## Open Questions

(none)

## Rollback

- Per phase: revert its commit. Phase 1's migration is additive (new nullable/defaulted columns, new table); rolling back code leaves them unused and harmless.
- Phase 3's backfill overwrites the old unredacted, truncated prompt excerpts with redacted ones; that is the user's explicit intent and is not rolled back (the full text stays recoverable from the owning host's transcripts by re-running the backfill).
- Whole set: revert the merge commit; `drop table cc_session_prompts; alter table cc_sessions drop column summary_requested_at, drop column prompts_version;` only if the columns must go.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f docs/plans/NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows, resumable on any machine:

    /analyze-orchestrator -f docs/plans/NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan docs/plans/NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md
