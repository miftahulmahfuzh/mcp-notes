# Code Analysis: Claude Code session forks in the session graph

**Type:** Feature Implementation
**Date:** 2026-11-11 09:33 Asia/Jakarta
**Session ID:** 20261111-093332-K7F2
**Plan:** `.workflows/plan/SESSION_FORK_AWARENESS_PLAN.md` (6 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-fork-awareness`, branch `feature/session-fork-awareness` (base `origin/main` @ `8040a46`)

---

## User Input

### Original User Request

The user's own message (verbatim):

> sorry . our workflow and mcp-notes must keep up with claude code features. so we must handle this fork feature accordingly. i think it is correct that a fork is considered a new node. "notesd has no fork handling at all" needs to be fixed. /analyze it so notesd can complement CC fork feature robustly

The `/analyze` arguments (verbatim):

> Make notesd handle Claude Code's fork feature robustly. A fork (e.g. a background job started with `--fork-session --resume <parent-transcript>`, or any `--fork-session`) is its own session node, but notesd currently has no fork handling at all. Findings from the investigation in this session (node 82-Y2), using fork JM-UJ (sid e3650501-2a9d-432a-b2c0-f2aeff23fdf8) of DM-OV (sid 662d31f3-8b12-4345-b9d6-f6fd48caa493):
> - `~/.claude/jobs/<sid>/state.json` records `forkParentSessionId`, `forkSessionId`, `forkBoundaryAt`, `backend: "daemon"`, `jobId`, `name` (auto-suffixed with ⑂), `forkSourceAlive`, `intent: "(forked)"`.
> - The fork transcript lives in the fork's own cwd project dir and begins with a copy of the parent's history up to the fork boundary: 104 of 109 message uuids are shared with the parent (same uuid and parentUuid, rewritten sessionId and cwd).
> - The live registry entry in `~/.claude/sessions/*.json` has `"kind":"bg"`, `"jobId":"e3650501"`, `messagingSocketPath`, and no tmux.
> Gaps to fix: (1) the fork has no parent link (needs a `fork` parent source, placed in the env > hook > heuristic precedence; detect it from the job state.json and also from shared-uuid prefix for forks not made as bg jobs, e.g. `claude --resume X --fork-session` in a terminal); (2) the copied prefix is double counted in the fork: tokens, commits (d1b23dc showed on both), prompts, replies, embed text, summary, and first-prompt title; ingest should count only what the fork added past the boundary; (3) resume/focus returns an unhelpful 409 live_outside_tmux for a live bg job. It should recognise `kind: "bg"` and give an actionable result (e.g. live_background_job with jobId, and messaging via the registry's messaging socket if feasible). Also check when a fork is forked or resumed; (4) the wall /projects UI should show a fork as a child of its parent with a fork badge/edge and the fork point, and MCP session tools (session_get, sessions_search, hook context lines) should say "fork of <node>". Existing data needs a backfill (already-ingested forks get re-linked and their copied prefix removed from their counts). Keep every path injectable; tests never touch the real ~/.claude.

### User-Provided Context

The bug that started it: clicking "Focus the running session" on JM-UJ answered `Could not resume JM-UJ: live_outside_tmux`. JM-UJ and DM-OV show the same first prompt and both list commit `d1b23dc`.

### User-Provided Files

None.

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | "i think it is correct that a fork is considered a new node." / "(1) the fork has no parent link (needs a `fork` parent source, placed in the env > hook > heuristic precedence; detect it from the job state.json and also from shared-uuid prefix for forks not made as bg jobs, e.g. `claude --resume X --fork-session` in a terminal)" / "Also check when a fork is forked or resumed" |
| R2 | "(2) the copied prefix is double counted in the fork: tokens, commits (d1b23dc showed on both), prompts, replies, embed text, summary, and first-prompt title; ingest should count only what the fork added past the boundary" |
| R3 | "(3) resume/focus returns an unhelpful 409 live_outside_tmux for a live bg job. It should recognise `kind: "bg"` and give an actionable result (e.g. live_background_job with jobId, and messaging via the registry's messaging socket if feasible)." |
| R4 | "(4) the wall /projects UI should show a fork as a child of its parent with a fork badge/edge and the fork point, and MCP session tools (session_get, sessions_search, hook context lines) should say "fork of <node>"." |
| R5 | "Existing data needs a backfill (already-ingested forks get re-linked and their copied prefix removed from their counts)." |

"Keep every path injectable; tests never touch the real ~/.claude" is a constraint on every phase and is carried as an invariant, not an R.

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN the ingester reads a session transcript from byte 0 and `<claudeHome>/jobs/<short id>/state.json` names that session with a `forkParentSessionId` THE SYSTEM SHALL link the session to that parent with parent link source `fork` |
| R1.2 | event | WHEN the ingester reads a session transcript from byte 0 that has no job state and whose leading message uuids are copied from another session's transcript on this host THE SYSTEM SHALL link it, with source `fork`, to the session it shares the longest copied prefix with |
| R1.3 | ubiquitous | THE SYSTEM SHALL rank a `fork` parent link above `env`, `hook` and `heuristic`, so no other source replaces it and a fork link replaces any of them |
| R1.4 | event | WHEN a fork is forked again THE SYSTEM SHALL link the new fork to the fork it was copied from, not to the original session |
| R1.5 | unwanted | IF a session's fork source cannot be determined (no job state, no matching transcript readable) THEN THE SYSTEM SHALL ingest it as an ordinary unlinked node and the ingest pass SHALL not fail |
| R2.1 | event | WHEN a fork is ingested THE SYSTEM SHALL leave the records copied from its parent out of its tokens, models, commits, files edited, plan docs, prompts, replies, first prompt, final message and started_at |
| R2.2 | event | WHEN the prompts backfill or the link worker re-reads a fork's transcript THE SYSTEM SHALL skip the copied records, so the fork gets no prompts, replies or heuristic child links from its parent's history |
| R2.3 | state | WHILE a fork's transcript holds only records copied from its parent THE SYSTEM SHALL report zero tokens, no prompts and no commits for it, and SHALL count its own records once they arrive |
| R2.4 | event | WHEN `session_transcript` searches a fork THE SYSTEM SHALL search only the records after the fork point |
| R3.1 | event | WHEN resume or focus is asked for a node that is live as a Claude Code background job (registry `kind: "bg"` with a `jobId`) and no attach pane for it is alive THE SYSTEM SHALL open a tmux window running `claude attach <jobId>` and answer `action: "attached"` |
| R3.2 | event | WHEN resume or focus is asked again for that background job while its attach pane is alive THE SYSTEM SHALL focus that pane (and type the prompt into it when one is given) instead of opening another window |
| R3.3 | unwanted | IF a prompt is given for a background job that has no live attach pane THEN THE SYSTEM SHALL open the attach window and answer `prompt_delivered: false` rather than drop the prompt silently |
| R3.4 | unwanted | IF a live session is outside tmux and is not a background job THEN THE SYSTEM SHALL keep answering 409 `live_outside_tmux` |
| R3.5 | event | WHEN the wall's resume button gets `attached` or a background-job answer THE SYSTEM SHALL show a notice naming the job (`claude attach <jobId>`) instead of a raw error code |
| R4.1 | event | WHEN `session_get`, `sessions_search` or the prompt hook context describes a fork THE SYSTEM SHALL say `fork of <parent node id>` with the fork point (parent prompts copied and the fork time) |
| R4.2 | event | WHEN the wall `/projects` graph shows a fork THE SYSTEM SHALL draw it as a child of its parent with a distinct fork edge and a fork badge, and the node panel SHALL say `forked from <node> after prompt N` |
| R4.3 | event | WHEN the prompt hook context or `session_get` describes a session that is live as a background job THE SYSTEM SHALL give `claude attach <jobId>` as the way back in instead of `claude --resume` |
| R5.1 | event | WHEN the daemon starts after this change THE SYSTEM SHALL once detect every already-ingested fork on this host, link it with source `fork`, and re-ingest it from byte 0 with the copied prefix cut (JM-UJ gets DM-OV as parent and no longer lists `d1b23dc`) |
| R5.2 | unwanted | IF an already-ingested session's transcript is gone when the fork backfill reaches it THEN THE SYSTEM SHALL skip it without a write and still mark the backfill done |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** Claude Code can fork a session: `claude --resume X --fork-session` in a terminal, and background jobs (`claude --bg`, the agent view) which run as `claude bg-pty-host … --session-id <new> --fork-session --resume <claudeHome>/jobs/<short>/parent-transcript.jsonl`. A fork gets a new session id and a new transcript in its own cwd's project dir, and that transcript begins with a copy of the parent's conversation chain (the records keep their `uuid`, `parentUuid`, `timestamp`, `message.id` and usage, with `sessionId`/`cwd` rewritten). notesd ingests the fork as an unrelated session: it has no parent, and every copied record counts again: tokens, commits, prompts, replies, first prompt, started_at, the summary and embedding built from those, and heuristic links found in copied spawn intents. Resume treats a live background job like any process outside tmux and answers 409 `live_outside_tmux`.

**Measured on this machine (2026-11-11):**
- JM-UJ = `e3650501-…`, transcript `-home-miftah-claude-commands/e3650501….jsonl` (123 lines). DM-OV = `662d31f3-…`, transcript in the worktree project dir (1243 lines).
- 104 of JM-UJ's 109 uuids are in DM-OV. The copied block is lines 4–112. Lines 1–3 (`ai-title`, `agent-name`, `mode`) carry no uuid. The last copied record (`system/away_summary`, line 112) has timestamp `2026-11-11T01:37:02.342Z`, exactly the job's `forkBoundaryAt`. The first own record is line 113 (`attachment`, 01:53:35Z). Copied timestamps are not strictly monotonic (line 103 is 1 ms later than line 104).
- No transcript on disk carries any `fork*` field. The only fork markers are the job's `state.json`, the fork's own `<task-notification><fork-source>…` user record (background forks only), and the shared uuids.
- `<claudeHome>/jobs/` holds one dir per job named by the short id (`e3650501`, `3fa61d8c`), each with `state.json`, `parent-transcript.jsonl` (the parent snapshot the fork was resumed from, 239 lines) and `tmp/`. `3fa61d8c` (state `done`) is an older background fork of `be1f52d8-…`.
- Registry entry of the live fork: `{"pid":3318108,"sessionId":"e3650501-…","kind":"bg","jobId":"e3650501","messagingSocketPath":"/run/user/1000/cc-socks/3318108.sock",…}`, no `tmux`.
- `claude attach <id|name>` opens a background session in the current terminal; `claude agents`, `logs`, `stop`, `respawn`, `rm` manage them. Claude Code offers no CLI to send a message into a background session. The messaging socket needs `CLAUDE_CODE_MESSAGING_TOKEN`, which only the session itself inherits (`~/.claude/skills/task/session.py` documents the protocol). notesd cannot authenticate to another session's socket, so socket messaging is **not feasible** and is not planned.
- The fork has no `<uuid>/subagents/` dir, so subagent rows are never copied.

**Success Criteria.** The R1–R5 criteria above, proved by unit tests on fixture transcripts and job dirs under a temp `claudeHome`, integration tests against the pgvector Postgres, and a verify-notesd run that drives a fixture fork through ingest, the API, MCP and the wall.

**Key Considerations / assumptions.**
- A fork is its own node (user's words). The parent link is the fork source, source `fork`, rank 4. Why above `env`: a background fork's process is started by Claude Code's background daemon. Its environment comes from whichever session started the daemon, so `CC_PARENT_SESSION` may name an unrelated session. Claude Code's own fork record is the ground truth. (Decided by rung 5, the user's raw input "a fork is considered a new node", plus what the dataflow shows.)
- **The cut is a byte offset.** The copied block is a contiguous prefix of the fork's records that carry a uuid. Records without a uuid (`ai-title`, `agent-name`, `custom-title`, `mode`, `last-prompt`, `cost-state`, …) before the cut belong to the fork (Claude Code writes them for the new session) and are still read. `fork_cut_offset` = byte offset of the first record whose uuid is **not** in the copied-uuid set. Every reader skips records with a uuid before that offset.
- **The copied-uuid set** comes, in order of preference, from: (a) the job's `parent-transcript.jsonl`; (b) the parent's own transcript (path from its `cc_sessions` row on this host); (c) when neither is readable but the job gives `forkBoundaryAt`, every leading uuid record with `timestamp <= forkBoundaryAt` up to the first one later than it.
- **Content detection (no job)** needs a cheap key: `cc_sessions.head_uuid` = uuid of the first record that has one. A new transcript whose head uuid equals another host row's head uuid is a fork candidate. Rank the candidates by the number of the fork's leading uuids they contain, read from their transcripts. On a tie, take the earliest-started one: the original holds the copied uuids first, and a fork-of-a-fork wins only when it shares uuids the original lacks. A plain `--resume` keeps its session id and file, so it never looks like a fork. `/clear` starts fresh uuids.
- **Pending cut.** While the fork's file holds only copied records (no own uuid record yet), the cut is not final. Such a row is re-read from byte 0 on every change (fork files at that stage are just the copy; cheap) until an own record appears. Its counters stay zero meanwhile.
- **Fork point for display** = `forked_at` (the job's `forkBoundaryAt`, else the timestamp of the last copied record) and `fork_prompt_count` (human prompts among the copied records, i.e. "after prompt N" of the parent).
- Resuming a fork that is not live keeps today's path (`claude --resume <fork sid>` in tmux). A non-live background job is resumable that way too. Only a **live** `kind: "bg"` entry takes the attach path.
- Version markers follow the existing pattern (`LINKS_BACKFILL_VERSION` + a settings key): a one-time fork backfill per host.

---

## Analysis Scope

### Discovered Related Files
- `src/sessions/ingest.ts` (856 lines): tail ingester, `readFile`, prompts backfill `backfillSession`, observers
- `src/sessions/transcript.ts` (800): `TranscriptAccumulator`, `readJsonlFrom`, `parseRecord`, `buildTranscriptPatch`
- `src/sessions/repo.ts` (1165): `SessionsRepo.upsertFromTranscript`, `setParent`/`setParentIn`, `STORED_RANK`, `offsets`, `replacePrompts`
- `src/sessions/merge.ts`: patch → row columns
- `src/sessions/types.ts`: `PARENT_LINK_RANK`, `TranscriptPatch`, `TranscriptSet`, `SessionListItem`, `HookStart`
- `src/db/schema.ts:465-593`: `PARENT_LINK_SOURCES`, `cc_sessions` columns and checks
- `src/sessions/links.ts`: heuristic link worker (`onBatch` records, `scanTranscriptForIntents` backfill, `dbLinkStore`)
- `src/sessions/registry.ts`: `parseLiveEntry`, `LiveSession`
- `src/sessions/resume.ts`: `LiveEntry`, `liveTarget`, `resumeNode`, `ResumeOutcome`
- `src/http/sessionResume.ts`, `src/mcp/sessionTools.ts`: resume route and tool, error text
- `src/sessions/view.ts`: `linkSource`, `toGraphNode`, `toNodeRef`, `formatContext` (hook lines)
- `src/sessions/readModel.ts`, `src/sessions/search.ts`: SQL projections and hit shapes (`parent_link_source` enum filters)
- `src/sessions/transcriptSearch.ts`: `searchTranscript` (session_transcript)
- `src/sessions/summarize.ts`: `buildSummaryInput`/`buildEmbedText` read DB columns only, so they inherit the cut
- `src/http/sessionHooks.ts`: SessionStart hook route (env parent link)
- `src/background.ts`: wires ingest, link worker, backfills
- `web/src/sessionsApi.ts`, `web/src/sessionDetailApi.ts`, `web/src/types.ts`, `web/src/lib/sessionGraph.ts`, `web/src/components/graph/NodePanel.tsx`, `web/src/testing/sessionFixtures.ts`
- `.claude/skills/verify-notesd/features/projects.md`: proof map for the session graph

---

## Current Dataflow

### Entry Point: transcript ingest
**Location:** `src/sessions/ingest.ts:337` `startSessionIngest` → `readFile` (`:477`)
**Trigger:** startup backfill pass, 60 s sweep, chokidar watch of `<claudeHome>/projects/**`.
1. `readFile(file)`: `sessionIdFromPath`; `known = offsets.get(sid)`; `fromOffset = size < known ? 0 : known`.
2. `new TranscriptAccumulator(sid, carry)`; `readJsonlFrom(file, fromOffset, line => acc.add(parseRecord(line)))`. Every record goes in; `isSidechain` is skipped for main files. The `records[]` copy is kept for observers.
3. `fromOffset === 0`: excluded entrypoints (`sdk-ts`, `sdk-cli`) → never read again. No entrypoint and no row → `deferred`. Repo resolved from `delta.cwd`.
4. `buildTranscriptPatch(delta, ctx)` → `store.upsertFromTranscript(patch)` (`repo.ts`). A 0-read replaces accumulators, a tail read adds. Compare-and-set on the stored offset.
5. On success: `offsets`, `carries` updated; `notifyBatch({records})` → link worker `onBatch` (`links.ts:869`) scans the records for spawn intents and writes `heuristic` parent links.

**Accumulator (`transcript.ts:451`)**: `observeEnvelope` keeps min/max timestamp (→ started_at / last_active_at), first cwd/entrypoint, last branch/version. `addUser` records human prompts (`isHumanPrompt`), images and commits from tool results. `addAssistant` adds usage once per `message.id` (`recentMessageIds` carry), reply segments, tool_use edits/plan docs. `custom-title`, `agent-name`, `ai-title`, `last-prompt`, `cost-state` set scalars.

### Entry Point: prompts backfill
`ingest.ts` `backfillSession` re-reads `0..transcript_offset` to rebuild prompts and replies (`replacePrompts`, compare-and-set). It goes through the same accumulator, with no cut.

### Entry Point: link worker backfill
`links.ts` `scanTranscriptForIntents(file, parentSessionId)` reads a whole transcript once per `LINKS_BACKFILL_VERSION` and plans `heuristic` links. No cut.

### Parent links
`repo.ts:847 setParentIn`: refuses self and cycles (recursive CTE, depth 64), and updates only where `STORED_RANK <= PARENT_LINK_RANK[source]`. `STORED_RANK` is a SQL `case` hard-coding env 3, hook 2, heuristic 1. DB check `cc_sessions_parent_link_source_check in ('env','hook','heuristic')`. Writers: SessionStart hook (`sessionHooks.ts`, `env`), spawn claims (`hook`), link worker (`heuristic`).

### Resume
`resume.ts:446 liveTarget`: `deps.live(sid)` → registry entry `{pid, tmux}`. A tmux pane alive → focus/message. Otherwise `{kind:'outside'}` → `resumeNode` answers 409 `live_outside_tmux`. Not live → `new-window … claude --resume <sid> [prompt]`. `recent` map holds just-spawned panes. `registry.ts:82 parseLiveEntry` drops `kind` and `jobId`.

### Read surfaces
- `view.ts:450 linkSource` accepts only the three sources. `toGraphNode`/`toNodeRef` emit `parent_link_source`. `formatContext` (`:778`) builds the hook block: `Parent: <id> (<source> link)` and `Transcript: … (resume with: claude --resume <sid>)`.
- `search.ts:732-748` maps `parent_link_source`, also limited to three values. `readModel.ts:232` selects the columns.
- `transcriptSearch.ts searchTranscript(file)` scans the whole file.
- Web: `sessionsApi.ts:26-34` and `sessionDetailApi.ts:195-229` normalise the source to the three values. `sessionGraph.ts:297` marks `heuristic` edges. `NodePanel.tsx` `ParentLine` says "from <id> (guessed)" for heuristic. `resumeErrorNotice` prints `Could not resume <id>: <code>`. The tip reads "Focus the running session" when `live`.

### Data Persistence
`cc_sessions` (single writer `SessionsRepo`), `cc_session_prompts`, `cc_session_replies`, `cc_session_embeddings`, settings markers for one-time backfills.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `PARENT_LINK_SOURCES` | `src/db/schema.ts:465` | def | db |
| `cc_sessions_parent_link_source_check` | `src/db/schema.ts:592` | config (check) | db |
| `PARENT_LINK_RANK` | `src/sessions/types.ts:64` | def | sessions |
| `STORED_RANK` | `src/sessions/repo.ts:139` | def | sessions |
| `setParentIn` | `src/sessions/repo.ts:847` | def | sessions |
| `linkSource` | `src/sessions/view.ts:450` | def | sessions |
| `parent_link_source` enum filter | `src/sessions/search.ts:91,748` | def | sessions |
| `parent_link_source` | `src/sessions/links.ts:682-704`, `src/http/sessionHooks.ts:96,166,194` | call | sessions/http |
| `parent_link_source` normalise | `web/src/sessionsApi.ts:26-34`, `web/src/sessionDetailApi.ts:77,195-229`, `web/src/types.ts:212` | def | web |
| `heuristic` edge | `web/src/lib/sessionGraph.ts:297` | call | web |
| `ParentLine` | `web/src/components/graph/NodePanel.tsx:279,498` | def | web |
| `resumeErrorNotice` | `web/src/sessionDetailApi.ts:276` | def | web |
| `live_outside_tmux` | `src/sessions/resume.ts:91,472,489`, `src/http/sessionResume.ts:79`, `src/mcp/sessionTools.ts:287` | def/call | sessions/http/mcp |
| `parseLiveEntry`, `LiveSession` | `src/sessions/registry.ts:18,82` | def | sessions |
| `readFile`, `backfillSession` | `src/sessions/ingest.ts:477, ~560` | def | sessions |
| `TranscriptAccumulator.add` | `src/sessions/transcript.ts:509` | def | sessions |
| `scanTranscriptForIntents` | `src/sessions/links.ts:639` | def | sessions |
| `searchTranscript` | `src/sessions/transcriptSearch.ts:117` | def | sessions |
| `formatContext` | `src/sessions/view.ts:778` | def | sessions |
| fixtures | `web/src/testing/sessionFixtures.ts:15,40` | test | web |

---

## Impact Points (files that WILL need changes)
1. `drizzle/0015_session_forks.sql`, `src/db/schema.ts`, `src/sessions/types.ts`, `src/sessions/repo.ts` (rank SQL, fork columns writer): Phase 1
2. `src/sessions/fork.ts` (new: job state reader, copied-uuid set, cut finder, candidate ranking): Phase 1
3. `src/sessions/ingest.ts`, `src/sessions/transcript.ts` (skip predicate), `src/sessions/repo.ts` (fork metadata write, head-uuid lookup): Phase 2
4. `src/sessions/ingest.ts` (prompts backfill cut, fork backfill), `src/sessions/links.ts` (cut in scan and batches), `src/background.ts`: Phase 3
5. `src/sessions/registry.ts`, `src/sessions/resume.ts`, `src/http/sessionResume.ts`, `src/mcp/sessionTools.ts`: Phase 4
6. `src/sessions/view.ts`, `src/sessions/readModel.ts`, `src/sessions/search.ts`, `src/sessions/transcriptSearch.ts`, `src/http/sessionsApi.ts`, `src/mcp/sessionTools.ts` (session_get/sessions_search/session_transcript text): Phase 5
7. `web/src/*` (types, APIs, graph, NodePanel, fixtures, styles): Phase 6
8. `README.md`, `CLAUDE.md` sessions paragraph, `.claude/skills/verify-notesd/features/projects.md`: owned by the phase whose feature they describe

**This document describes. The plan files prescribe.**
