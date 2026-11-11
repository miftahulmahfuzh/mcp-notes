# Plan: Claude Code session forks in the session graph

**Slug:** session-fork-awareness
**Date:** 2026-11-11 09:33 Asia/Jakarta
**Analysis:** `.workflows/analyze/20261111-093332-K7F2_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-fork-awareness`
**Branch:** `feature/session-fork-awareness` (base: `origin/main` @ `8040a46`)
**Phases:** 6
**Status:** phase 1/6 complete
**Coordinator:** —

---

## Why

> sorry . our workflow and mcp-notes must keep up with claude code features. so we must handle this fork feature accordingly. i think it is correct that a fork is considered a new node. "notesd has no fork handling at all" needs to be fixed. /analyze it so notesd can complement CC fork feature robustly

The full `/analyze` arguments, with the measured findings (job `state.json`, 104 of 109 shared uuids, registry `kind: "bg"`), are verbatim in the analysis document's User Input section.

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | "i think it is correct that a fork is considered a new node." / "(1) the fork has no parent link (needs a `fork` parent source, placed in the env > hook > heuristic precedence; detect it from the job state.json and also from shared-uuid prefix for forks not made as bg jobs, e.g. `claude --resume X --fork-session` in a terminal)" / "Also check when a fork is forked or resumed" | 1, 2 |
| R2 | "(2) the copied prefix is double counted in the fork: tokens, commits (d1b23dc showed on both), prompts, replies, embed text, summary, and first-prompt title; ingest should count only what the fork added past the boundary" | 1, 2, 3, 5 |
| R3 | "(3) resume/focus returns an unhelpful 409 live_outside_tmux for a live bg job. It should recognise `kind: "bg"` and give an actionable result (e.g. live_background_job with jobId, and messaging via the registry's messaging socket if feasible)." | 4, 6 |
| R4 | "(4) the wall /projects UI should show a fork as a child of its parent with a fork badge/edge and the fork point, and MCP session tools (session_get, sessions_search, hook context lines) should say "fork of <node>"." | 5, 6 |
| R5 | "Existing data needs a backfill (already-ingested forks get re-linked and their copied prefix removed from their counts)." | 3 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN the ingester reads a session transcript from byte 0 and `<claudeHome>/jobs/<short id>/state.json` names that session with a `forkParentSessionId` THE SYSTEM SHALL link the session to that parent with parent link source `fork` | 2 | P2.J1, P2.J6, P2.J7 |
| R1.2 | event | WHEN the ingester reads a session transcript from byte 0 that has no job state and whose leading message uuids are copied from another session's transcript on this host THE SYSTEM SHALL link it, with source `fork`, to the session it shares the longest copied prefix with | 2 | P2.J2, P2.J6, P2.J7 |
| R1.3 | ubiquitous | THE SYSTEM SHALL rank a `fork` parent link above `env`, `hook` and `heuristic`, so no other source replaces it and a fork link replaces any of them | 1 | P1.J1, P1.J2, P1.J3 |
| R1.4 | event | WHEN a fork is forked again THE SYSTEM SHALL link the new fork to the fork it was copied from, not to the original session | 2 | P2.J3, P2.J6, P2.J7 |
| R1.5 | unwanted | IF a session's fork source cannot be determined (no job state, no matching transcript readable) THEN THE SYSTEM SHALL ingest it as an ordinary unlinked node and the ingest pass SHALL not fail | 2 | P2.J5, P2.J6, P2.J7 |
| R2.1 | event | WHEN a fork is ingested THE SYSTEM SHALL leave the records copied from its parent out of its tokens, models, commits, files edited, plan docs, prompts, replies, first prompt, final message and started_at | 2 | P2.J1, P2.J2, P2.J6, P2.J7 |
| R2.2 | event | WHEN the prompts backfill or the link worker re-reads a fork's transcript THE SYSTEM SHALL skip the copied records, so the fork gets no prompts, replies or heuristic child links from its parent's history | 3 | P3.J1, P3.J2, P3.J3 |
| R2.3 | state | WHILE a fork's transcript holds only records copied from its parent THE SYSTEM SHALL report zero tokens, no prompts and no commits for it, and SHALL count its own records once they arrive | 2 | P2.J4, P2.J6, P2.J7 |
| R2.4 | event | WHEN `session_transcript` searches a fork THE SYSTEM SHALL search only the records after the fork point | 5 | P5.J2, P5.J3, P5.J4 |
| R3.1 | event | WHEN resume or focus is asked for a node that is live as a Claude Code background job (registry `kind: "bg"` with a `jobId`) and no attach pane for it is alive THE SYSTEM SHALL open a tmux window running `claude attach <jobId>` and answer `action: "attached"` | 4 | P4.J1 |
| R3.2 | event | WHEN resume or focus is asked again for that background job while its attach pane is alive THE SYSTEM SHALL focus that pane (and type the prompt into it when one is given) instead of opening another window | 4 | P4.J2 |
| R3.3 | unwanted | IF a prompt is given for a background job that has no live attach pane THEN THE SYSTEM SHALL open the attach window and answer `prompt_delivered: false` rather than drop the prompt silently | 4 | P4.J3 |
| R3.4 | unwanted | IF a live session is outside tmux and is not a background job THEN THE SYSTEM SHALL keep answering 409 `live_outside_tmux` | 4 | P4.J4 |
| R3.5 | event | WHEN the wall's resume button gets `attached` or a background-job answer THE SYSTEM SHALL show a notice naming the job (`claude attach <jobId>`) instead of a raw error code | 6 | P6.J2, P6.J4 |
| R4.1 | event | WHEN `session_get`, `sessions_search` or the prompt hook context describes a fork THE SYSTEM SHALL say `fork of <parent node id>` with the fork point (parent prompts copied and the fork time) | 5 | P5.J1, P5.J3, P5.J5 |
| R4.2 | event | WHEN the wall `/projects` graph shows a fork THE SYSTEM SHALL draw it as a child of its parent with a distinct fork edge and a fork badge, and the node panel SHALL say `forked from <node> after prompt N` | 6 | P6.J1, P6.J3 |
| R4.3 | event | WHEN the prompt hook context or `session_get` describes a session that is live as a background job THE SYSTEM SHALL give `claude attach <jobId>` as the way back in instead of `claude --resume` | 5 | P5.J1, P5.J3, P5.J6 |
| R5.1 | event | WHEN the daemon starts after this change THE SYSTEM SHALL once detect every already-ingested fork on this host, link it with source `fork`, and re-ingest it from byte 0 with the copied prefix cut (JM-UJ gets DM-OV as parent and no longer lists `d1b23dc`) | 3 | P3.J4, P3.J6 |
| R5.2 | unwanted | IF an already-ingested session's transcript is gone when the fork backfill reaches it THEN THE SYSTEM SHALL skip it without a write and still mark the backfill done | 3 | P3.J5 |

## Scope

**In scope:** fork detection (job state and shared-uuid prefix), the `fork` parent link source and its rank, cutting the copied prefix from every reader of a fork transcript (ingest, prompts backfill, link worker, transcript search), fork metadata (`head_uuid`, `fork_cut_offset`, `forked_at`, `fork_prompt_count`, `fork_detected_by`), a one-time fork backfill, resume/focus of live background jobs through `claude attach`, fork and background-job wording in MCP tools, the hook context and the wall.

**Out of scope:** messaging a background job through its messaging socket. It needs `CLAUDE_CODE_MESSAGING_TOKEN`, which only the session itself inherits, so notesd cannot authenticate (analysis, "Measured"). Also out: managing background jobs (stop, rm, respawn); cross-host forks (a fork is always made on the host that holds the parent's transcript); changing the summary prompt or embed layout (both read DB columns and inherit the cut).

## Invariants

1. The tree builds (`npm run typecheck`) and `npm test` passes at the end of every phase. `npm run test:int` passes at the end of every phase that touches SQL.
2. Every filesystem path stays injectable (`claudeHome`, `jobsDir` derived from it, tmux bin/socket, claude bin). Tests never touch the real `~/.claude`, `~/mcp-notes-data`, Neon or the live daemon on 7317.
3. `SessionsRepo` stays the only writer of the session tables. Parent links still go through `setParentIn` (self and cycle checks kept).
4. A non-fork session ingests byte for byte as before: same patches, same counters, same observer batches.
5. Fork detection never blocks or fails an ingest pass. Any error in detection degrades to "not a fork" for that read and is logged once.
6. Rank order is exactly `fork 4 > env 3 > hook 2 > heuristic 1`, in `PARENT_LINK_RANK`, in the `STORED_RANK` SQL, and in the DB check.
7. Records with a uuid before `fork_cut_offset` are never counted by any reader. Records without a uuid are always read.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Fork schema, rank, detection and cut primitives | R1, R2 | `src/db`, `src/sessions` | 16 | — | NORMAL | `.workflows/plan/session-fork-awareness/phase-1.md` | P1-NOTES-A090 | — |
| 2 | Ingest detects forks and cuts the copied prefix | R1, R2 | `src/sessions` | 14 | 1 | HARD | `.workflows/plan/session-fork-awareness/phase-2.md` | — | — |
| 3 | Re-readers honour the cut, plus the one-time fork backfill | R2, R5 | `src/sessions`, `src/background.ts` | 12 | 2 | HARD | `.workflows/plan/session-fork-awareness/phase-3.md` | — | — |
| 4 | Resume and focus of live background jobs | R3 | `src/sessions`, `src/http`, `src/mcp` | 10 | — | NORMAL | `.workflows/plan/session-fork-awareness/phase-4.md` | — | — |
| 5 | Fork and background-job wording in API, MCP and hook context | R2, R4 | `src/sessions`, `src/mcp` | 11 | 1, 4 | NORMAL | `.workflows/plan/session-fork-awareness/phase-5.md` | — | — |
| 6 | Wall: fork edge, badge, fork point, attach notices | R3, R4 | `web/src` | 17 | 4, 5 | NORMAL | `.workflows/plan/session-fork-awareness/phase-6.md` | — | — |

### Phase 1 — Fork schema, rank, detection and cut primitives
**Satisfies:** R1, R2 (R2 only through the cut primitives; it owns criterion R1.3 alone)
**Owns:** migration `drizzle/0015_session_forks.sql` (+ drizzle meta snapshot/journal via `npm run db:generate`): `fork` in `cc_sessions_parent_link_source_check`, nullable `head_uuid`, `fork_cut_offset`, `forked_at`, `fork_prompt_count`, `fork_detected_by` (check `job|uuid|time`), `cc_sessions_fork_info_check` (detected_by, cut_offset, prompt_count all null or all set), index `(host, head_uuid)`. `src/db/schema.ts` (`PARENT_LINK_SOURCES` = `fork, env, hook, heuristic`, `FORK_DETECTED_BY`). `src/sessions/types.ts` (`PARENT_LINK_RANK.fork = 4`, `ForkInfo { parentSessionId, detectedBy, cutOffset, final, forkedAt, promptCount }`, list columns). `src/sessions/repo.ts`: `STORED_RANK` derived from `PARENT_LINK_RANK`, `LIST_COLUMNS`. `view.ts` `ParentLinkSource` re-exports the schema type and `linkSource` accepts `fork`; `search.ts` reuses `linkSource`. `src/sessions/transcript.ts`: `readJsonlFrom`'s `onLine(line, lineStart)` (raw byte offset) and `isCopiedRecord(record, lineStart, forkCutOffset)` (moved here from Phase 2). New `src/sessions/fork.ts`: `jobStateFor`, `headUuid`, `readUuidSet`, `readRecordsWithOffsets` (offsets from `lineStart`), `findForkCut(file, CopiedEvidence)` -> `{cutOffset, final, forkedAt, promptCount, copiedRecords}`, `rankForkCandidates` -> ranked list, best first. Fixture rows in `memoryIngestStore.ts`/`merge.test.ts` gain the fork columns.
**Does not touch:** `ingest.ts`, `merge.ts`, `TranscriptAccumulator`, `links.ts`, `src/http/sessionHooks.ts` (Decisions), resume, view wording, web.
**Exit criteria:** typecheck, `npm test`, `npm run test:int` green; `drizzle-kit check` no drift; R1.3 proven (J1-J3): a `fork` link survives env/hook/heuristic writes and replaces each; `fork.ts` unit tests pass on JM-UJ-shaped fixtures, including multi-byte text before the cut.

### Phase 2 — Ingest detects forks and cuts the copied prefix
**Satisfies:** R1, R2
**Owns:** new `src/sessions/forkDetect.ts` (`scanFork`, `isPendingCut`, `ForkScan { headUuid, fork, error }`); `TranscriptAccumulator.addCopied`; `ingest.ts` `readFile` 0-read path (`scanForkSafely(file, sid): Promise<ForkScan | null>` closure, never throws; copied records left out of counts and observer batches; pending cut re-read from 0; `IngestStore` gains `forkCandidates`); `repo.ts` `forkCandidates(host, headUuid, excludeSessionId)` (excludes descendants and rows created after the session), fork link + fork columns in the `upsertFromTranscript` transaction, `offsets` carries `forkCutOffset`; `merge.ts` (a fork's 0-read drops a copied `started_at`, first prompt, final message); `types.ts` (`TranscriptPatch.headUuid/fork`, `ForkCandidateRow`, `TranscriptSet`, `TranscriptUpsertResult.forkLink`, `TranscriptOffset.forkCutOffset`); `memoryIngestStore.ts` mirrors; fixture home `tests/fixtures/claude-home-forks` + generator; unit and int tests; "Forks at ingest" bullet and block in `features/projects.md`. Uses Phase 1's `readJsonlFrom` `lineStart` and `isCopiedRecord`; with a job boundary passes `{ boundaryAt, uuids }` together.
**Does not touch:** `readJsonlFrom`, `isCopiedRecord` (Phase 1), prompts backfill, link worker, transcript search, resume, wording, web, `sessionHooks.ts`.
**Exit criteria:** R1.1, R1.2, R1.4, R1.5, R2.1, R2.3 proven (J1-J7); non-fork ingest tests unchanged and green.

### Phase 3 — Re-readers honour the cut, plus the one-time fork backfill
**Satisfies:** R2, R5
**Owns:** `ingest.ts` `backfillSession` (applies the stored cut via `isCopiedRecord`), `rereadFromZero`, `backfillForks` (`FORK_BACKFILL_VERSION`, marker `sessions.forks.backfill.<host>`; fills `head_uuid`; detects with Phase 2's `scanForkSafely`, job-state candidates first, then shared-head-uuid candidates; re-reads only forks; a gone transcript is skipped without a write), `SessionIngester.forkBackfill`, prompts backfill after the fork backfill; `repo.ts` `forkBackfillRows`, `fillHeadUuids`, `promptsBackfillCandidates.forkCutOffset`; `links.ts` (`scanTranscriptForIntents` streams with `readJsonlFrom` and skips copied records; `transcriptsOnHost` carries `fork_cut_offset`; `LinkWorkerOptions.backfillAfter` gates the one-time scan); `src/background.ts` (`backfillAfter: () => sessionIngest?.forkBackfill`); README "Who started whom"; CLAUDE.md sessions paragraph (`fork > env > hook > heuristic`, the cut, the backfill); one sentence inside Phase 2's feature-map bullet.
**Does not touch:** `readFile`'s detection and cut logic, `transcript.ts`, resume, wording, web, README resume/tool rows.
**Exit criteria:** R2.2, R5.1, R5.2 proven (J1-J6), including a JM-UJ/DM-OV-shaped fixture where the fork loses the copied commit and gains the fork parent after one backfill, a fork of a fork linking to its source fork, the link scan waiting for the fork backfill, and a second start doing nothing.

### Phase 4 — Resume and focus of live background jobs
**Satisfies:** R3
**Owns:** `src/sessions/registry.ts` (`LiveSession.kind`, `jobId`; `backgroundJobId(session)`, the one background-job rule), `src/sessions/resume.ts` (`LiveEntry.jobId`; attach-pane lookup; `claude attach <jobId>` window -> `action: 'attached'`; `ResumeResult` union: `attached` always carries `job_id`, `prompt_delivered: false` only when a prompt was given; `focused`/`messaged` carry `job_id` on an attach pane; 409 `live_outside_tmux` kept for non-bg), `src/http/sessionResume.ts` (`registryLive`), `src/mcp/sessionTools.ts` line 5 import and `resumeToolResult` / `session_resume` description (from about line 276), README "Resume from the wall" and the two resume table rows, the feature-map line 6 and "Resume of a live background job (fake tmux)" section.
**Does not touch:** ingest, view/read model, other MCP tools' text, web.
**Exit criteria:** R3.1-R3.4 proven (J1-J4) with the fake `CommandRunner` and a fake `NOTESD_TMUX_BIN` on a verify run.

### Phase 5 — Fork and background-job wording in API, MCP and hook context
**Satisfies:** R2, R4
**Owns:** `src/sessions/view.ts` (`ForkPoint`, `GraphNode`/`NodeRef` gain `fork: {parent_node_id, forked_at, prompt_count} | null` and `job_id`, `TranscriptPayload.starts_at_fork_point`, `forkPointText`, `resumeCommand`, `formatContext` prints `Fork of <id> (after prompt N, <time>)` and `attach with: claude attach <jobId>`), `src/sessions/readModel.ts` (`liveFromRegistry` via Phase 4's `backgroundJobId`, `NODE_SELECT` fork columns, `readTranscript` passes `fork_cut_offset`), `src/sessions/transcriptSearch.ts` (`startOffset`, skips with Phase 1's `isCopiedRecord`), `src/mcp/sessionTools.ts` lines 8-186 as Phase 4 leaves the file (`sessions_search` `fork_of`, `session_get` `fork_of`/`resume_command`, `session_transcript` text), README rows `sessions_search`, `session_get`, `session_transcript` and the transcript HTTP row, its feature-map bullet and block. `src/http/sessionsApi.ts` and `search.ts` need no edit (payloads pass through).
**Does not touch:** ingest, resume decision logic, web, CLAUDE.md, README rows owned by Phases 3 and 4.
**Exit criteria:** R2.4, R4.1, R4.3 proven (J1-J6) by unit tests on `formatContext`/view mapping, an int test over the API and MCP, and a verify run whose seeded fork row satisfies `cc_sessions_fork_info_check`.

### Phase 6 — Wall: fork edge, badge, fork point, attach notices
**Satisfies:** R3, R4
**Owns:** `web/src/types.ts`, new `web/src/lib/parentLink.ts`, `web/src/sessionsApi.ts`, `web/src/sessionDetailApi.ts` (accept `fork`, map `fork`/`job_id` exactly as Phase 5 sends them, `attached` notice naming `claude attach <job_id>`, `prompt_delivered: false` wording, background-job 409 fallback), `web/src/lib/sessionGraph.ts` (`LaidEdge.style`), graph components (fork edge, Phosphor `GitFork` badge), `NodePanel.tsx` (`forked from <id> after prompt N`, "Attach to the background session"), `SessionGraph.css`, `NodePanel.css`, `web/src/testing/sessionFixtures.ts`, jsdom tests, its feature-map bullet and block. `web/src/styles.css` needs no change.
**Does not touch:** server code.
**Exit criteria:** R3.5, R4.2 proven by jsdom tests (J1, J2) and verify-notesd Playwright drives of a seeded fork (J3, J4).

## Reconciliation Log

Round 1. Ledger: 19 criteria, each owned and traced (`ears_trace.py` exit 0 before and after); every R1-R5 served; dependencies point backward only.

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | Phase 3 called a `detectFork(file, sid)` closure and assumed names Phase 2 does not expose | Unmet assumption | Phase 3's Requires rewritten to the real names: `scanForkSafely(file, sid): Promise<ForkScan \| null>`, `ForkScan.fork`, `isCopiedRecord`, `readJsonlFrom` `onLine(line, lineStart)`, `forkCandidates`, `ForkInfo.promptCount`, `rankForkCandidates` returning a sorted list. Step 4h calls `(await scanForkSafely(f, s))?.fork ?? null` inline; no wrapper. Phase 2 handoff updated. |
| 2 | Phase 1 `readRecordsWithOffsets` counted offsets from decoded text (UTF-8 bytes + 1); Phase 2 added raw byte `lineStart` to `readJsonlFrom` | Contract drift / file collision (`transcript.ts`) | The `lineStart` change moved into Phase 1 (new Step 7b) and `readRecordsWithOffsets` uses it, so `findForkCut`'s cut and every reader agree byte for byte. Phase 2's Steps 1-2 replaced by notes; its contract moved the item to Requires. |
| 3 | `isCopiedRecord` defined in Phase 2 but needed by Phase 5, which does not depend on Phase 2 (same wave) | Unmet assumption / duplicate work (Phase 5 had its own `hasUuid`) | `isCopiedRecord` moved to Phase 1 Step 7b with `lineStart`; Phases 2, 3 and 5 import it. Phase 5's `hasUuid` removed. Phase 1's Satisfies widened to R1, R2: its `findForkCut` already served R2, the predicate is a primitive, no R2 criterion moved. |
| 4 | Phase 1 handoff: with a job boundary the uuid set alone cuts one record early | Unmet assumption (check) | Verified: Phase 2 `jobFork` passes `{ boundaryAt, uuids }` together, `time` when no uuid set is readable. No edit. |
| 5 | `src/http/sessionHooks.ts:166` would let a `fork`-linked row consume a pending spawn | Gap (unowned reference) | Not changed by any phase; see Decisions. Phase 1 and 2 handoffs updated. |
| 6 | Fork backfill over rows ingested before the cut: parent and forks share a polluted `started_at`; an original could be ranked a fork of its fork | Ordering (behavioral) | Phase 3 Step 4h now detects job-state candidates first, then shared-head-uuid candidates; linked forks are then descendants that `forkCandidates` (Phase 2: no descendants, no rows created after the session) leaves out. See Decisions. |
| 7 | Link worker's one-time scan starts at the first `onPassComplete`, concurrently with the fork backfill, and could read copied intents before the cut is stored (R2.2) | Gap / ordering | Phase 3 adds `LinkWorkerOptions.backfillAfter` (awaited outside `enqueue`) and wires `backfillAfter: () => sessionIngest?.forkBackfill` in `background.ts`; new unit test in J1. `forkBackfill` never rejects and `notifyPass` does not await observers, so no deadlock. |
| 8 | Phase 5 re-checked `kind === 'bg'` instead of Phase 4's `backgroundJobId` | Contract drift | `liveFromRegistry` uses `backgroundJobId(e)`, so `job_id` on the wire is non-null exactly when resume would answer `attached`. |
| 9 | Phase 6 planned against assumed Phase 4/5 wire shapes | Contract drift (check) | Shapes match (`fork {parent_node_id, forked_at, prompt_count} \| null`, `job_id`, `attached` with `job_id`, `prompt_delivered: false` only with a prompt). Phase 6's Interface Contract now quotes the real shapes; its 409-with-job notice kept as a defensive fallback. |
| 10 | `src/mcp/sessionTools.ts` shared by Phases 4 (line 5, from ~276) and 5 (lines 8-186) | File collision | No overlap; Phase 5 Requires now states it edits the file as Phase 4 leaves it and keeps Phase 4's line 5. |
| 11 | README / CLAUDE.md: Phase 5 asked Phase 3 to document its fields, but Phase 3 is not ordered after Phase 5 | File collision / gap | Phase 5 owns its README rows (`sessions_search`, `session_get`, `session_transcript`, transcript HTTP row; new Step 11). CLAUDE.md stays Phase 3's alone (one-line paragraph). Phase 4 keeps "Resume from the wall" and the resume rows; Phase 3 "Who started whom". |
| 12 | `features/projects.md` appended by Phases 2, 4, 5, 6 at the same anchors; Phase 3 asked Phase 6 to add a backfill line | File collision | Fixed order (4, 2, 5, 6) noted in Phases 2, 5, 6; append-append merges keep both sides. Phase 3 adds its own backfill sentence inside Phase 2's bullet (a different region from Phase 6's append). |
| 13 | `tests/helpers/memoryIngestStore.ts` edited by Phases 1 (`blankSessionRow`), 2 (offsets, upsert, `forkCandidates`, `setParent`), 3 (`promptsBackfillCandidates`) | File collision (check) | Distinct regions, each anchored on its symbol; no edit. |
| 14 | Phase 5 seeds (int test and verify script) set `fork_cut_offset`/`fork_prompt_count` without `fork_detected_by`; Phase 6 seed set `fork_detected_by`/`fork_prompt_count` without `fork_cut_offset` | Broken proof (violates Phase 1's `cc_sessions_fork_info_check`) | Phase 5 seeds add `fork_detected_by = 'uuid'`; Phase 6 seed adds `fork_cut_offset = 0`. |
| 15 | Phase 5/6 proof seeds vs Phase 3's one-time backfill and Phase 2's fixtures | Ordering (proof) | Seeds stay on fixture `…0005` (Phase 2's fork fixtures are a separate home not loaded by `up --sessions`); both seeds now wait for the `sessions.forks.backfill.<host>` marker. `…0005` has no shared head uuid or job record, so the backfill never selects it, and a tail read keeps stored fork columns. |
| 16 | Phase 5 assumed Phase 1 might widen only `linkSource`, not the `ParentLinkSource` alias | Unmet assumption (check) | Phase 1 re-exports the schema type from `view.ts`; Phase 5's fallback is unneeded (handoff updated). |


## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Where `fork` ranks | above `env` (fork 4): a background fork's env comes from Claude Code's daemon, not its spawner, so `CC_PARENT_SESSION` can be wrong; the job record is ground truth | 5: user's raw input ("a fork is considered a new node", "placed in the env > hook > heuristic precedence") + analysis |
| Message a background job through its messaging socket | not done: the socket needs `CLAUDE_CODE_MESSAGING_TOKEN`, which only the session holds; a prompt goes to an attach pane, else `prompt_delivered: false` | 5: user's raw input ("if feasible") |
| Resume of a background fork that is not live | today's `claude --resume <sid>` path, unchanged | 6: convention |
| `sessionHooks.ts:166` lets a `fork`-linked row consume a pending spawn | not changed: no criterion needs it; R1.3 is met by `setParentIn` keeping the higher-ranked link (Phase 1 J1, J2), a fork's SessionStart precedes the ingest that links it, and a resumed start claims nothing | 2: the phases' exit criteria |
| Where the raw-byte line offset and the copied-record rule live | Phase 1 (`readJsonlFrom` `lineStart`, `isCopiedRecord`), used by `readRecordsWithOffsets`, ingest, prompts backfill, link scan and transcript search, so a stored cut and every reader agree byte for byte | 1: invariant 7 (one rule for every reader) |
| `transcriptSearch.ts` keeps its readline loop, counting `lineStart` from the decoded line | kept: identical to the raw offset for LF-terminated valid UTF-8 JSONL; switching to `readJsonlFrom` would drop a trailing line without `\n` and change the scan-cap semantics the existing tests pin. It calls the shared `isCopiedRecord` | 3: the plans' code blocks (Phase 5 Step 5) |
| Fork backfill order over pre-cut rows | job-state candidates first, then shared-head-uuid candidates (oldest first); a linked fork is then a descendant that `forkCandidates` leaves out when its original is examined | 3: the plans' code blocks (Phase 2 `forkCandidates`, Phase 1 `rankForkCandidates` doc) + Phase 1 handoff |
| When the link worker's one-time scan runs | after `forkBackfill` settles (`backfillAfter`), so it reads every stored cut | 2: exit criterion R2.2 ("the link worker re-reads a fork's transcript ... skips the copied records") |
| Background-job rule for `job_id` on the wire | Phase 4's `backgroundJobId` (kind `bg` + safe id), shared by resume and the read model | 1: invariant-style single rule; Phase 4 contract |
| Who documents Phase 5's fields | Phase 5, in its own README rows; CLAUDE.md stays Phase 3's | 6: convention (the phase whose feature it is documents it; analysis Impact Point 8) |
| Proof seeds for Phases 5/6 | keep the SQL seed on fixture `…0005` (with every `cc_sessions_fork_info_check` column), after the fork backfill marker | 2: the phases' exit criteria (journeys must run on `up --sessions`, which loads only `tests/fixtures/claude-home`) |

## Open Questions

(none)

## Rollback

Per phase: revert its commit. Phase 1's migration only adds nullable columns, an index and a wider check. Rolling it back needs a down migration that first rewrites `fork` links to `heuristic` (or nulls them), then restores the three-value check. The whole set: revert the merge, then run that down step. Re-ingest is not needed: rows written with a cut stay internally consistent, and a later full re-read (offset 0) rebuilds them either way.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/SESSION_FORK_AWARENESS_PLAN.md --phase 1

Or run the whole set as a swarm (a session per phase, concurrent wherever `Depends on` allows, resumable on any machine):

    /analyze-orchestrator -f .workflows/plan/SESSION_FORK_AWARENESS_PLAN.md
