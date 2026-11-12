# Code Analysis: Session Context Rot (Projects node panel) and "Spawn fresh" carry-over

**Type:** Feature Implementation
**Date:** 2026-11-12 09:31 WIB
**Session ID:** 20261112-093143-CR7T
**Plan:** `.workflows/plan/SESSION_CONTEXT_ROT_PLAN.md` (4 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-context-rot`, branch `feature/session-context-rot` (base `origin/main` @ `81fd619`)

---

## User Input

### Original User Request

First message (discussion, session WL-RT):

> let's discuss about an improvement:
> i in Projects , if we click a node, the node details can already provide us with various information.
> there are 2 buttons in there , side by side: Tree button and Timeline button.
> can we put a "Context Rot" button on the left of Tree button?
> Context Rot button basically track the session token consumption against the maximum tokens a session can receive (maybe 1M tokens max?)
> maybe we show a horizontal bar, and it will progrees to full seiring dengan banyaknya token yang dikonsumsi over the session life.
> the hard part is, i want this Context Rot bar to be able to show live usage increase on a running session. can we do that?
>
> this Context Rot is useful in that it can show me whether i should simply "Resume in tmux" , or if that session has consumed too many tokens, then maybe i should choose "Spawn fresh with this context" .
>
> ---
>
> with this idea, comes a second question:
> - what are the contexts that got carried over when user choose "Spawn fresh with this context" ?
> there is a balance to be considered here: the more context we carry over, the more accurate the new session will perform, but we still need to pay attention to the Context Rot of the new session. the lesser context we carry over, the more "fresh" the new session will be, but there is a chance the new session will miss some important information from the old session.
>
> ---
>
> wdyt

Second message (answers to the two questions, then `/analyze`):

> Questions for you:
> - Should the window size be per-model and inferred, or do you want a setting where you say "my sessions are always 1M"?
> answer: it would be more robust if we infer it automatically instead of setting a static value.
> the truth is, i always use Opus 5.5 (1M) and Sonnet 5.5 (1M) anyway, but i prefer us to be able to handle special circumstances as well.
> - For tier 2, are 3 prompt→reply pairs about right? Or would you rather choose the depth in the dialog (a slider that updates the "new session starts at" estimate)?
> answer: you know what, for 1M models, i think they could handle ALL prompt-reply pairs from the old session. honestly, i want the new session to be able to carry over as much as information as it needs.
>
> alright, other than these, just take all your preference. /analyze this so we can implement it robustly

### User-Provided Context

- The assistant's earlier reply (same session) proposed: occupancy = latest main-chain assistant usage, not cumulative tokens; a per-model window table plus "ever above 200k means 1M"; colour bands; live updates through an ingest-fed SSE stream with a polling fallback for the other laptop; a carry-over made of a pointer layer, recent prompt→reply pairs, git state and a fresh summary, with an estimate of the new session's start. The user accepted it and said "other than these, just take all your preference".
- CLAUDE.md constraints: one writer per table (SessionsRepo for session tables); transcripts / resume only on the owning host (`not_on_this_machine`); every path injectable and tests never touch the real `~/.claude`; prove with `.claude/skills/verify-notesd` and update its `features/` map; icon-only Phosphor buttons (memory: ui-taste).

### User-Provided Files

None (no `@` files).

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | can we put a "Context Rot" button on the left of Tree button? Context Rot button basically track the session token consumption against the maximum tokens a session can receive (maybe 1M tokens max?) maybe we show a horizontal bar, and it will progrees to full seiring dengan banyaknya token yang dikonsumsi over the session life. |
| R2 | it would be more robust if we infer it automatically instead of setting a static value. the truth is, i always use Opus 5.5 (1M) and Sonnet 5.5 (1M) anyway, but i prefer us to be able to handle special circumstances as well. |
| R3 | the hard part is, i want this Context Rot bar to be able to show live usage increase on a running session. can we do that? |
| R4 | what are the contexts that got carried over when user choose "Spawn fresh with this context" ? there is a balance to be considered here: the more context we carry over, the more accurate the new session will perform, but we still need to pay attention to the Context Rot of the new session. [...] for 1M models, i think they could handle ALL prompt-reply pairs from the old session. honestly, i want the new session to be able to carry over as much as information as it needs. |

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN the user clicks the icon-only "Context Rot" button, placed left of the Tree button in the node panel's Subtree section toggle, THE SYSTEM SHALL show a horizontal bar filled to the session's context tokens divided by its context window, with the tokens, the window and the percent as text |
| R1.2 | ubiquitous | THE SYSTEM SHALL measure a session's context as input + cache read + cache write + output tokens of its latest main-chain assistant message, ignoring sidechain records and subagent transcripts |
| R1.3 | event | WHEN a later main-chain assistant message reports a smaller context than an earlier one (compaction) THE SYSTEM SHALL store the later, smaller value |
| R1.4 | event | WHEN a fork has no own assistant message yet THE SYSTEM SHALL report the context of the last assistant message it copied from its parent |
| R1.5 | event | WHEN the daemon starts on a host whose sessions were ingested before context capture existed THE SYSTEM SHALL fill each of that host's sessions' context once from its transcript |
| R1.6 | state | WHILE the bar is shown THE SYSTEM SHALL colour it green below 40%, amber from 40% to below 70%, and red from 70% |
| R1.7 | unwanted | IF a session has no main-chain assistant message with usage THEN THE SYSTEM SHALL show its context as unknown, not as 0% |
| R2.1 | ubiquitous | THE SYSTEM SHALL infer each session's context window from the model of its latest assistant message, a per-model table and transcript evidence, with no user setting |
| R2.2 | event | WHEN a session's context has ever exceeded 200,000 tokens THE SYSTEM SHALL infer a 1,000,000-token window |
| R2.3 | event | WHEN a main-thread `api-request` record of the session lists a `context-1m-*` beta THE SYSTEM SHALL infer a 1,000,000-token window |
| R2.4 | unwanted | IF the model is not in the table and no evidence says 1M THEN THE SYSTEM SHALL use a 200,000-token window and report `window_source: "default"` |
| R3.1 | complex | WHILE the Context Rot view is open on a live session of this host WHEN the session's transcript gets a new main-chain assistant message THE SYSTEM SHALL update the bar without a reload, within 5 seconds |
| R3.2 | event | WHEN ingest commits a write that changes a session's stored context THE SYSTEM SHALL send a `context` event to every open `GET /api/sessions/:nodeId/context/stream` of that node |
| R3.3 | ubiquitous | THE SYSTEM SHALL answer `GET /api/sessions/:nodeId/context` with the node's context (tokens, window, percent, band, model, at, window_source) or `context: null`, and carry the same object in session detail |
| R3.4 | unwanted | IF the shown session belongs to another host THEN THE SYSTEM SHALL refresh the bar by polling `GET /api/sessions/:nodeId/context` every 60 s while the view is open, and open no stream |
| R4.1 | event | WHEN the user spawns fresh from a node whose inferred window is 1,000,000 tokens and whose exchanges fit the budget THE SYSTEM SHALL carry every stored prompt and Claude's reply to it into the new session |
| R4.2 | event | WHEN the node's exchanges exceed the handoff budget for its window THE SYSTEM SHALL carry the first prompt and the newest exchanges that fit, and say in the handoff how many were left out and where the transcript is |
| R4.3 | ubiquitous | THE SYSTEM SHALL put in every handoff the node id, title, cwd and repo, transcript path, the stored summary with its age, plan docs, commits, and the cwd's `git status` and `git diff --stat` |
| R4.4 | event | WHEN the user spawns fresh THE SYSTEM SHALL write the handoff under `<dataDir>/handoffs/` and start claude with `--append-system-prompt-file <handoff>` and a short first prompt that names the node and the file |
| R4.5 | event | WHEN that first prompt reaches the notes-prompt hook THE SYSTEM SHALL add no node-id context block for it |
| R4.6 | unwanted | IF a git command fails or times out THEN THE SYSTEM SHALL write the handoff without git state and say so in it |
| R4.7 | event | WHEN `GET /api/sessions/:nodeId/handoff` is called THE SYSTEM SHALL answer the dry-run estimate (tokens, window, percent, exchanges included and total) without writing a file |
| R4.8 | state | WHILE the Context Rot view is open THE SYSTEM SHALL show a second bar with the estimated starting context of a fresh spawn and how many exchanges it would carry |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** The node panel shows cumulative token counts (`tokens.total`, `src/sessions/view.ts:483-488`), which add cache reads across every turn and pass 1M long before a session's context is full. The user needs the *current* context fill of a session against its window, live for a running session, to choose between "Resume in tmux" and "Spawn fresh with this context". The fresh spawn today carries a 12 KB prompt (`freshPrompt`, `src/sessions/resume.ts:260-279`) built from a summary that is often missing for a running session; the user wants it to carry everything a 1M window can hold, all prompt→reply pairs included.

**Measured facts (2026-11-12, this machine, last 400 transcripts):**
- Main-chain assistant `message.usage` holds `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`. Their sum is the context the next turn starts from. Records of one message repeat the same usage (`transcript.ts:36-38`), so "latest wins" needs no dedupe.
- Peak occupancy observed: claude-opus-5-5 498,459; claude-opus-5 468,712; claude-sonnet-5 455,641; claude-sonnet-5-5 267,387 (all above 200k, i.e. 1M windows in use); claude-sonnet-4-6 92,484; claude-haiku-5-5 49,400; `glm-5.3` 6,335 (a non-Claude model appears).
- Transcript `message.model` never carries a `[1m]` suffix.
- `api-request` records (`querySource: "repl_main_thread"`) carry `params.model` and `params.betas`. `context-1m-2025-08-07` appears only on claude-sonnet-4-6 requests (18 of 12,516); the 5.x models run 1M without it. Lines are up to ~17 KB. `api-request` is in `IGNORED_RECORD_TYPES` (`transcript.ts:56-73`) and is dropped by `parseRecord` before `JSON.parse`.
- Model context windows (claude-api skill, cached 2026-10-06): 1M for fable-5/5-1, mythos-5/5-1, opus-5-5, opus-5, opus-4-8/4-7/4-6, sonnet-5-5, sonnet-5, sonnet-4-6, haiku-5-5; 200K for haiku-4-5. Claude Code sends the 1M beta for the 4.6 models only when the user picks the 1M variant, so the default for `claude-opus-4-6`/`claude-sonnet-4-6` without the beta is 200K.
- No `compact_boundary` system record exists in any transcript on this machine; compaction is handled by "latest message wins" alone, with no record-type dependence.
- First main-chain assistant occupancy of the last 56 mcp-notes sessions: median 48,815, min 30,778, max 72,947 (system prompt + tools + CLAUDE.md + memory). A fresh session's start estimate needs this baseline.
- `claude --append-system-prompt-file <file>` loads the file verbatim into the system prompt (tested with `--model haiku -p`: the model answered a word only that file held). `claude --help` lists `--append-system-prompt[-file]` and `--add-dir`.
- The Read tool cannot take a whole 100k+ token file in one call, and reading outside the cwd can raise a permission prompt; `--append-system-prompt-file` avoids both.

**Success Criteria.** The Acceptance Criteria above.

**Key Considerations / assumptions.**
- "Token consumption over the session life" is read as *context fill*: the number that actually decides context rot. Cumulative totals stay in the Tokens section unchanged.
- Window inference rule (stated assumption): a model-prefix table (longest prefix wins, like `pricing.ts`); 1M if the table says 1M natively, or the session ever exceeded 200,000 tokens, or a main-thread request carried `context-1m-*`; else the table's value; unknown model → 200,000 with `window_source: "default"`. Inference is computed at read time from stored evidence (model, peak, beta flag) so a rule change needs no migration.
- Bands: green < 40%, amber 40–70%, red ≥ 70% (the user's earlier stated preference).
- Live: an assistant message is the unit of change; the bar steps per message.
- Forks: the copied history really is in the fork's context, so copied assistant records set the context until the fork's own first message replaces it; they never count toward the cumulative tokens (unchanged).
- Carry-over target window: the old session's inferred window (the fresh session runs the user's default model, which is the model they ran; a smaller window is still handled by the budget).
- The handoff never calls Haiku at spawn time (Decision in the plan index): the full exchange log is fresher than any summary, and spawn stays fast.

---

## Analysis Scope

### Explicitly Mentioned Files
None.

### Discovered Related Files
- `src/sessions/transcript.ts` — record parsing, `TranscriptAccumulator` (usage, sidechain skip, `addCopied` for forks), `buildTranscriptPatch`.
- `src/sessions/types.ts` — `TranscriptPatch`, `TokenCounts`, `ModelUsage`, version constants.
- `src/sessions/merge.ts` — `mergeTranscriptPatch` (pure; reset vs append rules).
- `src/sessions/repo.ts` — `SessionsRepo.upsertFromTranscript` (only writer of `cc_sessions`), settings get/put (backfill markers).
- `src/sessions/ingest.ts` — chokidar watcher (debounce 500 ms), sweep 60 s, read loop (`readFile` around L590-680), fork cut, backfills, `IngestObserver.onBatch`.
- `src/db/schema.ts` — `ccSessions` (L521-633), `ccSessionPrompts`, `ccSessionReplies`.
- `drizzle/0015_session_forks.sql` — latest migration; next is `0016`.
- `src/sessions/pricing.ts` — model-prefix table pattern (`priceOf`).
- `src/sessions/view.ts` — `GraphNode`, `SessionInfo`, `SessionDetail`, `NodeRow`/`DetailRow`, `tokenCounts`.
- `src/sessions/readModel.ts` — `sessionDetail` (L393), `sessionPrompts` (L520), `contextFor` (L558), `sessionsReadDeps`.
- `src/http/sessionsApi.ts` — sessions read routes; documents why sessions have no SSE (L112-116).
- `src/http/api.ts` — the notes SSE (`/api/events`, `streamSSE`, heartbeat, L295-330): the pattern to copy.
- `src/notes/events.ts` — `NoteEvents` in-process bus: the pattern for a session bus.
- `src/deps.ts`, `src/daemon.ts`, `src/background.ts` — `AppDeps` wiring; ingest started at `background.ts:101` with `observers: [sessionLinks]`.
- `src/sessions/resume.ts` — `freshPrompt`, `resumeNode`, `openClaudeWindow`, `claudeCommand`, `ResumeDeps` (injectable `run`, `homeDir`), `TMUX_TEXT_MAX_BYTES = 12_000`.
- `src/http/sessionResume.ts` — POST `/api/sessions/:nodeId/resume`, `defaultSessionResumer`, `sessionLookup`.
- `src/mcp/sessionTools.ts` — `session_resume` tool (description mentions what fresh carries), `session_get`.
- `claude/hooks/notes-prompt.mjs` — node-id context injection (`nodeIdCandidates`, `runPrompt`), must stay I/O-free when nothing matches.
- `src/sessions/summarize.ts` — Haiku summarizer (Agent SDK), `SUMMARY_MODEL = 'haiku'`.
- `web/src/components/graph/NodePanel.tsx` (+ `.css`, `.test.tsx`) — node panel; Subtree toggle (L444-470), spawn button (L207-217), "No confirm click (settled)" (L172-177).
- `web/src/sessionDetailApi.ts` — `fetchSessionDetail`, `resumeSession`, `SessionDetail` web type.
- `web/src/hooks/useSessionGraph.ts` — graph poll 30–120 s with ETag; `startAdaptivePoll`.
- `.claude/skills/verify-notesd/features/projects.md` — feature map for Projects.

---

## Current Dataflow

### Entry Point A: transcript append → `cc_sessions`

**Location:** `src/sessions/ingest.ts:590-680` (`readFile`)
**Trigger:** chokidar change (debounced `DEFAULT_WATCH_DEBOUNCE_MS = 500`), or the 60 s sweep, or the startup backfill.
**Input:** bytes `[storedOffset, size)` of `<claudeHome>/projects/<dir>/<uuid>.jsonl`.
**Processing chain:**
1. Fork scan on a read from byte 0 (`scanForkSafely`) gives `cutOffset`.
2. `readJsonlFrom(file, fromOffset, (line, lineStart) => …)` hands each raw line; `parseRecord(line)` drops ignored types (`api-request*` included) before `JSON.parse`.
3. `isCopiedRecord(record, lineStart, cutOffset)` → `acc.addCopied(record)` (cwd/entrypoint/branch/version only) else `acc.add(record)`.
4. `TranscriptAccumulator.add` (`transcript.ts:524-555`): `isSidechain` records return early in a main accumulator; `addAssistant` (`transcript.ts:734-765`) adds `message.usage` to cumulative `tokens` and per-model `models`, once per `message.id` (`recentMessageIds`). `<synthetic>` model is excluded from `models`.
5. `acc.delta()` → `buildTranscriptPatch(delta, ctx)` (`transcript.ts:801-833`) → `TranscriptPatch`.
6. `SessionsRepo.upsertFromTranscript(patch)` (`repo.ts:461-506`): compare-and-set on `transcript_offset`; `mergeTranscriptPatch` (`merge.ts:297-355`) computes columns (reset on `fromOffset === 0` replaces cumulative values; append adds).
7. On `applied`: offsets/carries updated, `notifyBatch({sessionId, host, transcriptPath, fromOffset, toOffset, records})` calls every observer's `onBatch` synchronously after commit (throws logged and dropped).

Subagent files (`<uuid>/subagents/agent-*.jsonl`) use a `sidechain: true` accumulator and `upsertFromSubagentTranscript`; observers do not see them.

**Data persistence:** `cc_sessions` columns updated in one transaction with `cc_session_prompts` / `cc_session_replies`.

### Entry Point B: node panel detail

**Location:** `web/src/components/graph/NodePanel.tsx:96-109` → `fetchSessionDetail` → `GET /api/sessions/:nodeId` (`sessionsApi.ts:226-233`) → `sessionDetail(rd, nodeId)` (`readModel.ts:393`).
**Refresh:** the panel re-fetches when the graph node's `last_active_at|summarized` stamp changes; the graph polls every 30 s backing off to 120 s (`useSessionGraph.ts:11-12,54`). There is no session SSE (`sessionsApi.ts:112-116`).
**Subtree section:** `view: 'tree' | 'timeline'` state, toggle of two icon-only buttons (`TreeStructure`, `ChartBarHorizontal`) in `.np-toggle`.

### Entry Point C: "Spawn fresh with this context"

**Location:** `NodePanel.tsx:207-217` (`Sparkle` button) → `ask(true)`: on an available node it runs at once (no confirm, marked settled at L172), on another host's node a `ConfirmDialog` asks first → `resumeSession(node_id, {fresh: true})` → `POST /api/sessions/:nodeId/resume` (`sessionResume.ts`, same-origin, `resumeBodySchema {prompt?, fresh?}`) → `SessionResumer.resume` → `resumeNode(deps, node, req)` (`resume.ts:586-650`).
**Processing:**
1. Other host → 404 `not_on_this_machine`.
2. `pickTmuxSession`, `resolveCwd(deps, node)` (falls back to the repo checkout when the cwd is gone).
3. `openClaudeWindow(deps, session, cwd, "<nodeId>-new", promptArgs(freshPrompt(node, prompt)), {CC_PARENT_SESSION: sessionId})`: `tmux new-window … env -u <markers> PATH=… CC_PARENT_SESSION=<sid> <claude> <first prompt>`.
4. `freshPrompt` (`resume.ts:260-279`): "Continue the work of Claude Code session <id> ("<title>")", cwd/repo, transcript path, summary (else first prompt clipped to 2,000 chars), up to 20 plan docs, last 20 commits, task line; clipped to `TMUX_TEXT_MAX_BYTES` (12,000) because one tmux command is capped near 16 KB.
5. In the new session, `notes-prompt.mjs` sees the node id in the first prompt and adds `/api/sessions/context` text (summary, plan docs, commits, transcript path; up to `MAX_NODE_CONTEXT_CHARS = 9000`), repeating most of the prompt. `notes-session` links the child through `CC_PARENT_SESSION` (`env` source).

`ResumeNode` (`resume.ts:51-65`) carries `sessionId, nodeId, host, repo, cwd, name, title, summary, firstPrompt, transcriptPath, commits, planDocs` from `toResumeNode(row)`. It has no prompts, replies, summary age or context.

### Stored prompt / reply data available for a handoff
- `cc_session_prompts(session_id, seq, at, text, truncated)`: every human prompt, redacted, full (cut at `MAX_PROMPT_STORE_CHARS`) when `prompts_version >= PROMPTS_VERSION`.
- `cc_session_replies(session_id, seq, …)`: Claude's reply per prompt seq (text after the turn's last tool call), redacted, capped at `MAX_REPLY_STORE_CHARS`.
- `sessionPrompts(rd, nodeId)` (`readModel.ts:520-537`) reads prompts by version (`legacy` excerpts / `pruned` / `full`); there is no reader that pairs prompts with replies.

---

## Key Data Structures

- `TranscriptAccumulator` (`transcript.ts:466`) — per-read state; `sidechain` flag; `delta(): TranscriptDelta`.
- `TranscriptDelta` (`transcript.ts:124-170`), `TranscriptPatch` (`types.ts:172-240`) — per-read values; null scalars keep stored values.
- `ccSessions` (`schema.ts:521-633`) — no context columns today.
- `IngestBatch` / `IngestObserver` (`ingest.ts:150-180`) — post-commit extension point.
- `SessionInfo` / `SessionDetail` (`view.ts:~140-219`) — detail payload; `GraphNode` (`view.ts:55-86`).
- `ResumeNode`, `ResumeDeps`, `ResumeOutcome` (`resume.ts`).
- `NoteEvents` (`events.ts`) — EventEmitter wrapper with `setMaxListeners(0)`.

## Dependencies

- Env/config: `NOTES_DATA_DIR` (`deps.config.dataDir`), `CLAUDE_HOME` (`config.sessions.claudeHome`), `NOTES_WORKTREES_DIR`, `NOTESD_CLAUDE_BIN` (`config.chat.claudeBin`), `NOTESD_TMUX_*`, `NOTESD_SESSIONS=off`.
- External: `git` (handoff git state, via `ResumeDeps.run`), `tmux`, `claude` CLI (`--append-system-prompt-file`).

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `IGNORED_RECORD_TYPES` (`api-request`) | src/sessions/transcript.ts:56 | def | sessions |
| `parseRecord` | src/sessions/transcript.ts:230 | def | sessions |
| `TranscriptAccumulator.add/addCopied/addAssistant/delta` | src/sessions/transcript.ts:524,563,734,575 | def | sessions |
| `buildTranscriptPatch` | src/sessions/transcript.ts:801 | def | sessions |
| `TranscriptPatch` | src/sessions/types.ts:172 | def | sessions |
| `mergeTranscriptPatch` | src/sessions/merge.ts:297 | def | sessions |
| `upsertFromTranscript` | src/sessions/repo.ts:461 | def | sessions |
| `readFile` (ingest read loop) | src/sessions/ingest.ts:590-680 | def | sessions |
| `forkBackfill` / `promptsBackfill` (one-time per-host pattern) | src/sessions/ingest.ts:~700-980 | def | sessions |
| `ccSessions` | src/db/schema.ts:521 | def | db |
| `priceOf` / `MODEL_PRICES` | src/sessions/pricing.ts:18-42 | def (pattern) | sessions |
| `tokenCounts`, `toGraphNode`, `SessionInfo`, `SessionDetail` | src/sessions/view.ts:483,505,~140,210 | def | sessions |
| `sessionDetail`, `sessionPrompts` | src/sessions/readModel.ts:393,520 | def | sessions |
| `sessionsApiRoutes` | src/http/sessionsApi.ts:129 | def | http |
| `/api/events` SSE | src/http/api.ts:295 | def (pattern) | http |
| `NoteEvents` | src/notes/events.ts:17 | def (pattern) | notes |
| `AppDeps` | src/deps.ts:11 | def | root |
| `startSessionIngest({... observers})` | src/background.ts:101 | call | root |
| `createApp` / `startBackground` | src/daemon.ts:122,143 | call | root |
| `freshPrompt` | src/sessions/resume.ts:260 | def | sessions |
| `resumeNode` fresh branch | src/sessions/resume.ts:630-636 | call | sessions |
| `ResumeNode`, `toResumeNode` | src/sessions/resume.ts:51,~330 | def | sessions |
| `sessionResumeRoutes`, `sessionLookup` | src/http/sessionResume.ts | def | http |
| `session_resume` description | src/mcp/sessionTools.ts:329 | doc | mcp |
| `runPrompt`, `nodeIdCandidates` | claude/hooks/notes-prompt.mjs:317,470 | def | hooks |
| Subtree toggle, Sparkle button, `ask` | web/src/components/graph/NodePanel.tsx:444-470,207-217,172 | def | web |
| `fetchSessionDetail`, `resumeSession`, web `SessionDetail` | web/src/sessionDetailApi.ts:250,260,42 | def | web |
| Tests: transcript, merge, ingest, ingestForks, resume, sessionResumeRoute, sessionResumeTool, NodePanel | tests/unit/sessions/*, web/src/components/graph/NodePanel.test.tsx | test | — |
| Integration: sessions.ingest, sessions.api, sessions.resume, sessions.forks | tests/integration/sessions.*.int.test.ts | test | — |
| Feature map | .claude/skills/verify-notesd/features/projects.md | doc | — |
| README session API / MCP tables | README.md | doc | — |

## Impact Points (files that WILL need changes)

1. `drizzle/0016_session_context.sql` (+ drizzle meta) and `src/db/schema.ts` — context columns on `cc_sessions`. Phase 1.
2. `src/sessions/transcript.ts`, `src/sessions/types.ts`, `src/sessions/merge.ts`, `src/sessions/repo.ts` — capture and store the context snapshot, peak, first-message baseline, long-context beta flag. Phase 1.
3. `src/sessions/ingest.ts` — detect `context-1m-*` on raw `api-request` lines; one-time per-host context backfill. Phase 1.
4. `src/sessions/contextWindow.ts` (new) — window inference and band, pure. Phase 1.
5. `src/sessions/events.ts` (new), `src/deps.ts`, `src/daemon.ts`, `src/background.ts`, test deps builders — session context bus fed by an ingest observer. Phase 2.
6. `src/sessions/view.ts`, `src/sessions/readModel.ts`, `src/http/sessionsApi.ts` — context in detail; JSON and SSE routes. Phase 2.
7. `src/sessions/handoff.ts` (new), `src/sessions/resume.ts`, `src/http/sessionResume.ts`, `src/mcp/sessionTools.ts`, `claude/hooks/notes-prompt.mjs` — handoff build/write, spawn with `--append-system-prompt-file`, estimate route, hook marker skip. Phase 3.
8. `web/src/components/graph/NodePanel.tsx` (+ new `ContextRot.tsx`, CSS, tests), `web/src/sessionDetailApi.ts`, new `web/src/hooks/useSessionContext.ts` — the button, bars, live stream and poll. Phase 4.
9. `README.md`, `.claude/skills/verify-notesd/features/projects.md` — docs and proof map. Phase 4 (README API rows by the phase that adds each route).

**This document describes. The plan files prescribe.**
