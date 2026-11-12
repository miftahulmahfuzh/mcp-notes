# Plan: Session Context Rot and a fuller "Spawn fresh" carry-over

**Slug:** session-context-rot
**Date:** 2026-11-12 09:31 WIB
**Analysis:** `.workflows/analyze/20261112-093143-CR7T_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-context-rot`
**Branch:** `feature/session-context-rot` (base: `origin/main` @ `81fd619`)
**Phases:** 4
**Status:** phase 1/4 complete
**Coordinator:** —

---

## Why

> can we put a "Context Rot" button on the left of Tree button?
> Context Rot button basically track the session token consumption against the maximum tokens a session can receive (maybe 1M tokens max?)
> maybe we show a horizontal bar, and it will progrees to full seiring dengan banyaknya token yang dikonsumsi over the session life.
> the hard part is, i want this Context Rot bar to be able to show live usage increase on a running session. can we do that?
>
> this Context Rot is useful in that it can show me whether i should simply "Resume in tmux" , or if that session has consumed too many tokens, then maybe i should choose "Spawn fresh with this context" .
>
> - what are the contexts that got carried over when user choose "Spawn fresh with this context" ?
> there is a balance to be considered here: the more context we carry over, the more accurate the new session will perform, but we still need to pay attention to the Context Rot of the new session. the lesser context we carry over, the more "fresh" the new session will be, but there is a chance the new session will miss some important information from the old session.
>
> answer: it would be more robust if we infer it automatically instead of setting a static value.
> the truth is, i always use Opus 5.5 (1M) and Sonnet 5.5 (1M) anyway, but i prefer us to be able to handle special circumstances as well.
>
> answer: you know what, for 1M models, i think they could handle ALL prompt-reply pairs from the old session. honestly, i want the new session to be able to carry over as much as information as it needs.
>
> alright, other than these, just take all your preference. /analyze this so we can implement it robustly

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | can we put a "Context Rot" button on the left of Tree button? Context Rot button basically track the session token consumption against the maximum tokens a session can receive (maybe 1M tokens max?) maybe we show a horizontal bar, and it will progrees to full seiring dengan banyaknya token yang dikonsumsi over the session life. | 1, 4 |
| R2 | it would be more robust if we infer it automatically instead of setting a static value. the truth is, i always use Opus 5.5 (1M) and Sonnet 5.5 (1M) anyway, but i prefer us to be able to handle special circumstances as well. | 1 |
| R3 | the hard part is, i want this Context Rot bar to be able to show live usage increase on a running session. can we do that? | 2, 4 |
| R4 | what are the contexts that got carried over when user choose "Spawn fresh with this context" ? there is a balance to be considered here: the more context we carry over, the more accurate the new session will perform, but we still need to pay attention to the Context Rot of the new session. [...] for 1M models, i think they could handle ALL prompt-reply pairs from the old session. honestly, i want the new session to be able to carry over as much as information as it needs. | 3, 4 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN the user clicks the icon-only "Context Rot" button, placed left of the Tree button in the node panel's Subtree section toggle, THE SYSTEM SHALL show a horizontal bar filled to the session's context tokens divided by its context window, with the tokens, the window and the percent as text | 4 | P4.J1 |
| R1.2 | ubiquitous | THE SYSTEM SHALL measure a session's context as input + cache read + cache write + output tokens of its latest main-chain assistant message, ignoring sidechain records and subagent transcripts | 1 | P1.J1 |
| R1.3 | event | WHEN a later main-chain assistant message reports a smaller context than an earlier one (compaction) THE SYSTEM SHALL store the later, smaller value | 1 | P1.J2 |
| R1.4 | event | WHEN a fork has no own assistant message yet THE SYSTEM SHALL report the context of the last assistant message it copied from its parent | 1 | P1.J6 |
| R1.5 | event | WHEN the daemon starts on a host whose sessions were ingested before context capture existed THE SYSTEM SHALL fill each of that host's sessions' context once from its transcript | 1 | P1.J7 |
| R1.6 | state | WHILE the bar is shown THE SYSTEM SHALL colour it green below 40%, amber from 40% to below 70%, and red from 70% | 4 | P4.J1 |
| R1.7 | unwanted | IF a session has no main-chain assistant message with usage THEN THE SYSTEM SHALL show its context as unknown, not as 0% | 4 | P4.J5 |
| R2.1 | ubiquitous | THE SYSTEM SHALL infer each session's context window from the model of its latest assistant message, a per-model table and transcript evidence, with no user setting | 1 | P1.J3, P1.J4, P1.J5 |
| R2.2 | event | WHEN a session's context has ever exceeded 200,000 tokens THE SYSTEM SHALL infer a 1,000,000-token window | 1 | P1.J4 |
| R2.3 | event | WHEN a main-thread `api-request` record of the session lists a `context-1m-*` beta THE SYSTEM SHALL infer a 1,000,000-token window | 1 | P1.J3 |
| R2.4 | unwanted | IF the model is not in the table and no evidence says 1M THEN THE SYSTEM SHALL use a 200,000-token window and report `window_source: "default"` | 1 | P1.J5 |
| R3.1 | complex | WHILE the Context Rot view is open on a live session of this host WHEN the session's transcript gets a new main-chain assistant message THE SYSTEM SHALL update the bar without a reload, within 5 seconds | 4 | P4.J3 |
| R3.2 | event | WHEN ingest commits a write that changes a session's stored context THE SYSTEM SHALL send a `context` event to every open `GET /api/sessions/:nodeId/context/stream` of that node | 2 | P2.J3 |
| R3.3 | ubiquitous | THE SYSTEM SHALL answer `GET /api/sessions/:nodeId/context` with the node's context (tokens, window, percent, band, model, at, window_source) or `context: null`, and carry the same object in session detail | 2 | P2.J1, P2.J2 |
| R3.4 | unwanted | IF the shown session belongs to another host THEN THE SYSTEM SHALL refresh the bar by polling `GET /api/sessions/:nodeId/context` every 60 s while the view is open, and open no stream | 4 | P4.J4 |
| R4.1 | event | WHEN the user spawns fresh from a node whose inferred window is 1,000,000 tokens and whose exchanges fit the budget THE SYSTEM SHALL carry every stored prompt and Claude's reply to it into the new session | 3 | P3.J2, P3.J7 |
| R4.2 | event | WHEN the node's exchanges exceed the handoff budget for its window THE SYSTEM SHALL carry the first prompt and the newest exchanges that fit, and say in the handoff how many were left out and where the transcript is | 3 | P3.J3, P3.J7 |
| R4.3 | ubiquitous | THE SYSTEM SHALL put in every handoff the node id, title, cwd and repo, transcript path, the stored summary with its age, plan docs, commits, and the cwd's `git status` and `git diff --stat` | 3 | P3.J2, P3.J7 |
| R4.4 | event | WHEN the user spawns fresh THE SYSTEM SHALL write the handoff under `<dataDir>/handoffs/` and start claude with `--append-system-prompt-file <handoff>` and a short first prompt that names the node and the file | 3 | P3.J2, P3.J7 |
| R4.5 | event | WHEN that first prompt reaches the notes-prompt hook THE SYSTEM SHALL add no node-id context block for it | 3 | P3.J5 |
| R4.6 | unwanted | IF a git command fails or times out THEN THE SYSTEM SHALL write the handoff without git state and say so in it | 3 | P3.J4, P3.J6, P3.J7 |
| R4.7 | event | WHEN `GET /api/sessions/:nodeId/handoff` is called THE SYSTEM SHALL answer the dry-run estimate (tokens, window, percent, exchanges included and total) without writing a file | 3 | P3.J1, P3.J7 |
| R4.8 | state | WHILE the Context Rot view is open THE SYSTEM SHALL show a second bar with the estimated starting context of a fresh spawn and how many exchanges it would carry | 4 | P4.J2 |

## Scope

**In scope:** context capture during ingest (snapshot, peak, first-message baseline, long-context beta flag) in new `cc_sessions` columns; a one-time per-host backfill of those columns; pure window inference and colour band; context in session detail, a JSON route and a per-node SSE stream fed by ingest; a handoff file for "Spawn fresh" that carries every prompt→reply pair a 1M window can hold, plus git state and the stored summary with its age, passed with `--append-system-prompt-file`; a dry-run estimate route; the notes-prompt hook skipping the node-id block for a handoff's first prompt; the node panel's Context Rot view (current bar, live updates, fresh-start estimate bar); README and verify-notesd feature map.

**Out of scope:** the graph's node cards (no bar on the canvas); the cumulative Tokens section (unchanged); a user setting for the window (R2 says infer); a confirm dialog before spawning (spawn stays one click, see Decisions); Haiku calls at spawn time; changing how `claude --resume` works; the other laptop's daemon (it runs the same code once deployed there).

## Invariants

1. The tree builds, `npm run typecheck` and `npm test` pass at the end of every phase; `npm run test:int` passes at the end of phases 1–3.
2. `SessionsRepo` stays the only writer of `cc_sessions`. Context capture never fails, blocks or slows a save: a malformed usage object is skipped, not thrown.
3. The cumulative token columns, `tokens.total`, cost and per-model usage keep their current meaning and values.
4. Every path stays injectable; tests never touch the real `~/.claude`, `~/mcp-notes-data`, tmux or the live daemon.
5. `claude/hooks/notes-prompt.mjs` stays I/O-free on a prompt with no node id and no `/n`.
6. Transcript-reading work (ingest, backfill, handoff git state, spawn) runs only on the owning host; context *reads* (detail, JSON route, estimate from stored rows) work on any host.
7. A context value of a fork honours `fork_cut_offset` exactly as the other readers do (`isCopiedRecord`); copied records never feed cumulative tokens.
8. UI: icon-only Phosphor buttons with `data-tip` + `aria-label`; no Claude-default look; works in light and dark themes.
9. Window inference is computed at read time from stored evidence (model, peak, beta flag), never stored as a number.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | [x] Context capture, window inference, backfill | R1, R2 | `src/sessions`, `src/db`, `drizzle` | 20 | — | HARD | `.workflows/plan/session-context-rot/phase-1.md` | P1-NOTES-A098 | — |
| 2 | Context read API and live stream | R3 | `src/http`, `src/sessions`, root wiring | 12 | 1 | NORMAL | `.workflows/plan/session-context-rot/phase-2.md` | P1-NOTES-A099 | — |
| 3 | Handoff carry-over for "Spawn fresh" | R4 | `src/sessions`, `src/http`, `src/mcp`, `claude/hooks` | 11 | 1 | HARD | `.workflows/plan/session-context-rot/phase-3.md` | P1-NOTES-A100 | — |
| 4 | Context Rot view in the node panel | R1, R3, R4 | `web/`, docs (`README.md`, `CLAUDE.md`, feature map) | 13 | 2, 3 | NORMAL | `.workflows/plan/session-context-rot/phase-4.md` | P1-NOTES-A101 | — |

Phase 1 serves R1 and R2 together: one accumulator change and one migration produce both the context value (R1) and the window evidence (R2); splitting them would edit the same lines twice. Phase 4 serves R1, R3 and R4: one view component shows the bar, keeps it live and shows the estimate. Phases 2 and 3 run in parallel after phase 1 and share no file (checked by the reconciler); every doc file (`README.md`, `CLAUDE.md`, `features/projects.md`) is phase 4's alone.

### Phase 1 — Context capture, window inference, backfill
**Satisfies:** R1, R2
**Owns:** migration `drizzle/0016_session_context.sql` (+ drizzle meta via `npm run db:generate`) and `src/db/schema.ts` columns on `cc_sessions`: `context_tokens bigint null`, `context_model text null`, `context_at timestamptz null`, `context_peak_tokens bigint null`, `context_first_tokens bigint null`, `context_long_beta boolean not null default false`; `TranscriptAccumulator` capture (main chain only, latest wins, `addCopied` sets the snapshot and peak but not `first`, output tokens included, zero-usage and `<synthetic>` messages skipped); raw-line `context-1m-` detection on main-thread `api-request` lines in the ingest read loop (no `JSON.parse` of those lines); `TranscriptPatch` / `buildTranscriptPatch` / `mergeTranscriptPatch` rules (reset replaces; append keeps stored values when the read had no assistant message, peak = max, beta = or, first kept once set); `SessionsRepo.upsertFromTranscript` writes them; a one-time per-host context backfill in ingest (marker `sessions.context_backfill.<host>`, `CONTEXT_BACKFILL_VERSION`, after `promptsBackfill`, under the per-file hold, skips copied records per fork cut except for the snapshot rule, skips missing files without a write); new pure module `src/sessions/contextWindow.ts` (`contextWindowFor({model, peakTokens, longBeta}) -> {window, source: 'model'|'peak'|'beta'|'default'}`, `contextBand(percent)`, `CONTEXT_BANDS`, `contextPercent(tokens, window)` one decimal, 0..100; types `ContextWindowInput`, `ContextBand`, `ContextWindowSource`), tests.
**Does not touch:** HTTP routes, view/readModel, web, resume, docs.
**Exit criteria:** ingesting a fixture transcript stores the latest main-chain context (sidechain/subagent ignored, compaction lowers it, a fork without own messages shows its copied context); window inference unit tests cover every R2 criterion; the backfill fills pre-existing rows once and writes its marker; unit + integration suites green.

### Phase 2 — Context read API and live stream
**Satisfies:** R3
**Owns:** `SessionInfo.context` (`{tokens, window, percent, band, model, at, window_source, peak_tokens}` or null; `percent` = phase 1's `contextPercent`, `band` = `contextBand(percent)`, no local arithmetic) in `src/sessions/view.ts` + the detail SQL in `src/sessions/readModel.ts`; `GET /api/sessions/:nodeId/context` (any host; 400 `invalid_node_id`, 404 `not_found`) and `GET /api/sessions/:nodeId/context/stream` (SSE: an initial `context` event, then one per change, heartbeat, closes on abort) in `src/http/sessionsApi.ts`; new `src/sessions/events.ts` `SessionEvents` bus (`emitContext(sessionId)`, `on`), optional `AppDeps.sessionEvents`, created in `src/daemon.ts`, fed by an ingest `onBatch` observer in `src/background.ts` that emits when the batch holds a main-chain assistant record with usage or is a read from byte 0 (phase 1's backfill notifies no observer: accepted, in phase 2's Risks); stream debounce and change check (re-read the row, send only when tokens/model/window changed); tests.
**Does not touch:** ingest internals beyond adding the observer, resume/handoff, web, README, CLAUDE.md, feature map (its J1–J3 and route rows are handed to phase 4).
**Exit criteria:** detail and JSON route carry the context; an SSE client sees the initial event and a new event after an ingested append; unit + integration green.

### Phase 3 — Handoff carry-over for "Spawn fresh"
**Satisfies:** R4
**Owns:** new `src/sessions/handoff.ts`: `loadHandoffSource` (row + paired prompts/replies from `cc_session_prompts`/`cc_session_replies`, summary + `summarized_at`, plan docs, commits, context evidence, repo baseline = median `context_first_tokens` of the repo's latest 20 non-fork (`fork_detected_by is null`) cli sessions on any host, default 48,000), pure `buildHandoff(source, opts) -> {text, estimate:{tokens, window, percent, exchanges_included, exchanges_total, truncated}}` (budget = `HANDOFF_WINDOW_SHARE` 0.5 × window − baseline, tokens ≈ ceil(chars/4), `percent` = phase 1's `contextPercent(baseline + tokens, window)`; keeps the first prompt always, then newest exchanges that fit; header says what was left out and points at the transcript), `gitState(run, cwd)` (`git status --porcelain=v1 -b`, `git diff --stat`, timeout, failure noted in the text), `writeHandoff(dataDir, nodeId, text)` → `<dataDir>/handoffs/<NODE>-<yyyymmddThhmmss>.md`, prune files older than 14 days; `resume.ts` fresh branch: build + write the handoff, start claude with `['--append-system-prompt-file', file, firstPrompt]`, first prompt short, starts with the marker line `[notesd handoff]`, names node id, title and file, and appends the user's task; `freshPrompt` replaced or reduced to that first prompt; `ResumeDeps` gains `dataDir` (injectable); `GET /api/sessions/:nodeId/handoff` dry-run estimate in `src/http/sessionResume.ts` (any host, no file, no git); `session_resume` tool description in `src/mcp/sessionTools.ts` updated to say what fresh carries; `claude/hooks/notes-prompt.mjs` skips node-id resolution when the prompt's first line is the marker (pure string test); tests (unit for builder/budget/git failure/hook marker, resume argv, route; integration through `sessions.resume.int.test.ts`).
**Does not touch:** ingest, view/readModel/sessionsApi (phase 2), web, README, CLAUDE.md, feature map (its handoff sub-feature and fake-tmux recipe are handed to phase 4).
**Exit criteria:** a fresh spawn against a fake tmux writes a handoff holding every exchange for a 1M node and a budgeted tail for a 200k node, and the tmux argv carries `--append-system-prompt-file <that file>`; the estimate route answers without writing; the hook adds nothing for a marker prompt; suites green.

### Phase 4 — Context Rot view in the node panel
**Satisfies:** R1, R3, R4
**Owns:** `NodePanel.tsx` Subtree toggle becomes `'context' | 'tree' | 'timeline'` with an icon-only "Context Rot" button left of Tree (Phosphor icon, `data-tip="Context Rot"`), view remembered in `localStorage` (try/catch), default `tree`; new `web/src/components/graph/ContextRot.tsx` (+ CSS): current bar (fill = percent, band colour, text "<tokens> / <window> · <pct>%", model, "window assumed" note when `window_source` is `default`, "unknown" state for null), second bar "Fresh session would start at ~X%" with "carries N of M exchanges" from the estimate route; new `web/src/hooks/useSessionContext.ts`: live + available → `EventSource` on the stream (closed on unmount/node change/view change), available not live → one fetch and a refetch on the panel's stamp, other host → poll every 60 s; `web/src/sessionDetailApi.ts` types and fetchers (`fetchSessionContext`, `fetchHandoffEstimate`, `SessionDetail.context`; shapes field-for-field phase 2's `SessionContext` / `SessionContextPayload` and phase 3's `HandoffEstimateBody`); tests (`NodePanel.test.tsx`, `ContextRot.test.tsx`, hook test with a fake EventSource, normalizer tests); `README.md` Context Rot tour paragraph, fresh-spawn paragraph (numbers = phase 3's constants: 0.5 × window − baseline, latest 20 non-fork sessions, 48,000, chars/4, 14-day prune, `[notesd handoff]`), MCP `session_resume` row, `POST …/resume` row and HTTP API rows for the three new routes; `.claude/skills/verify-notesd/features/projects.md` sub-features Context Rot and Spawn fresh handoff with driving sections (the handoff one repeats phase 3's `NOTESD_TMUX_BIN` fake + `NOTESD_CLAUDE_BIN=/bin/true` safety gate) and the resume gotcha; `CLAUDE.md` one sentence in the Claude Code sessions bullet.
**Does not touch:** server code, `claude/`, tests outside `web/`.
**Exit criteria:** clicking Context Rot shows both bars; a fake stream event updates the bar; other-host node polls; band colours by threshold; verify-notesd drive (Playwright) shows the bar update after appending an assistant record to the throwaway daemon's fake transcript.

## Reconciliation Log

| # | Conflict | Phases | Resolution |
|---|---|---|---|
| 1 | Contract drift: phase 2 computed `percent` locally and banded the unrounded value; phase 1 exports `contextPercent` and documents "pass the same percent that is shown" to `contextBand` | 1, 2 | phase 2 Step 2 `toSessionContext` now calls `contextPercent(tokens, window)` and `contextBand(percent)`; its unit test expects 79,990 / 200k → 40.0 amber; Requires line names the exact phase 1 exports |
| 2 | Contract drift: phase 2 derived `ContextBand` / `ContextWindowSource` via `ReturnType` and hedged on `contextWindowFor`'s signature | 1, 2 | phase 2 imports and re-exports phase 1's types; signature `ContextWindowInput { model: string \| null; peakTokens: number \| null; longBeta: boolean }` confirmed; the "reconciler adjusts" handoff closed |
| 3 | Contract drift: phase 3 had its own `percentOf` | 1, 3 | phase 3 Step 1 imports `contextPercent` and drops `percentOf`; Requires line updated |
| 4 | Unmet assumption: phase 1's handoff says the repo baseline must leave out forks; phase 3's `repoBaseline` did not | 1, 3 | `repoBaseline` SQL adds `and fork_detected_by is null`; integration insert helper gains `fork`, and the estimate test seeds two 400k/500k forks that must not move the 40,000 median |
| 5 | Observer shape: phase 2's `batchMovesContext` fires on `fromOffset === 0`; checked against phase 1's ingest and `IngestBatch` | 1, 2 | agrees (byte-0 reads reset the six columns; `ContextBatchLike` is a structural subset of `IngestBatch`, `TranscriptRecord = Record<string, unknown>`); phase 2 gains a Risks section: silent backfill writes, byte-0 emits, beta-only writes emit nothing |
| 6 | Doc drift: phase 4's README fresh-spawn paragraph said "recent sessions, 48k", no marker, no fork exclusion | 3, 4 | phase 4 Step 9 now quotes phase 3's constants exactly: 0.5 × window − baseline, latest 20 sessions with forks left out, 48,000, chars / 4, 14-day prune, `[notesd handoff]`, `<NODE>-<yyyymmddThhmmss>.md` |
| 7 | Gap: phase 3 handed README's MCP `session_resume` row and the `POST …/resume` row to phase 4; phase 4 had no step | 3, 4 | phase 4 Step 9 edits README L1083 and L1173 |
| 8 | Gap: phase 3 handed a "Spawn fresh handoff" feature-map sub-feature (with its fake-tmux recipe) to phase 4; phase 4 omitted it and its gotcha still said "never drive resume" | 3, 4 | phase 4 Step 10 adds the sub-feature, a "Spawn fresh handoff (fake tmux, safety-gated)" section repeating phase 3's `/proc/<pid>/environ` gate for `NOTESD_TMUX_BIN` and `NOTESD_CLAUDE_BIN=/bin/true`, the L6 note and a narrowed gotcha |
| 9 | Gap: CLAUDE.md sentence on context columns / Context Rot / handoff unassigned (phase 1 handoff) | 4 | phase 4 Step 11 adds one sentence to the Claude Code sessions bullet; Files table and Owns updated |
| 10 | Wire-shape check: phase 4's `SessionContext`, `SessionContextPayload`, `HandoffEstimate` vs phases 2 and 3 | 2, 3, 4 | keys match field for field (`available`, `host` on the payload; `baseline` on the estimate, which has no host/available); web `peak_tokens: number \| null` kept as a tolerant superset; phase 4's open assumptions on the 0..100 scale closed |
| 11 | File collisions (`types.ts`, `view.ts`, `resume.ts`, `sessionTools.ts`, `README.md`, `features/projects.md`, `tests/helpers/*`, 2-vs-3 parallel edits) | all | none: every file is owned by exactly one phase (Files tables cross-checked); `tests/helpers/memoryIngestStore.ts` is phase 1 only; `tests/integration/helpers/sse.ts` is imported, not edited, by phase 2; phases 2 and 3 share no file |
| 12 | Index wording: phase 4 row said `SessionContext` on `SessionDetail.session`; the web type is flat | 4 | index now says `SessionDetail.context` (filled from the wire's `session.context`) |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Context = input + cache read + cache write, or + output too | + output: the reply is in the next turn's context | 6: surrounding convention (what the next request is billed as input) |
| Store the inferred window, or infer at read time | infer at read time from stored evidence (Invariant 9) | 1: stated invariant |
| Fresh summary via Haiku at spawn time | no: the full exchange log is fresher, spawn stays fast; the stored summary is included with its age | 5: user's raw input ("carry over as much information as it needs") + "take all your preference" |
| Pass the handoff by Read tool, or by system prompt | `--append-system-prompt-file` (measured working); the file path is also named in the first prompt | 6: measured behaviour (Read limits, outside-cwd permission prompts) |
| Where the fresh-start estimate shows | second bar in the Context Rot view; spawn keeps one click | 6: surrounding convention ("No confirm click (settled)", NodePanel.tsx:172) |
| Target window of the new session | the old session's inferred window | 5: user runs the same default models; the budget still handles smaller windows |
| Handoff budget | 0.5 × window − repo baseline (median first-message context, default 48,000), tokens ≈ chars/4 | 5: "as much as it needs" while keeping the new session well under the amber band |
| `AppDeps.sessionEvents` required or optional | optional; the daemon always sets it, tests that do not need it stay untouched | 6: surrounding convention (`adversary: … | null`, optional embedders) |
| Context backfill | one-time per host, marker in app_settings, after promptsBackfill | 6: surrounding convention (fork backfill, prompts backfill) |
| Band from the exact fill or from the shown one-decimal percent | the shown percent: `contextBand(contextPercent(tokens, window))`, so 39.96% reads 40.0 and is amber; phase 2's exact-value banding removed | 3: plans' code blocks (phase 1 `contextBand` doc: "pass the same percent that is shown, so the colour and the number agree") |
| Repo baseline counts forks or not | leaves forks out (`fork_detected_by is null`) | 1: stated invariant 7 (a fork's copied records are not its own; its first own message carries the parent's history) + phase 1's handoff |
| Stream event when only `context_long_beta` flips | none of its own; the reply that follows emits and the re-read shows the new window | 4: Requirements table (R3.2: a write that changes the stored context, i.e. a new main-chain assistant message, R3.1) |
| Backfill writes notify the stream | no (phase 1 behaviour kept); recorded in phase 2 Risks | 3: plans' code blocks (phase 1 ingest header: backfills never notify observers) |
| Verify run may drive fresh `POST /resume` | yes, only with a fake `NOTESD_TMUX_BIN`, `NOTESD_CLAUDE_BIN=/bin/true` and the `/proc/<pid>/environ` gate passing, repeated in the feature map | 1: stated invariant 4 (tests never touch real tmux or the live daemon) |

## Open Questions

(none)

## Rollback

Per phase: `git revert` the phase's merge commit. Phase 1's migration only adds nullable / defaulted columns; reverting the code leaves them unused and harmless (drop them with a follow-up migration if wanted). Phase 3's handoff files live under `<dataDir>/handoffs/` and can be deleted at any time. Whole set: revert the set's merge into main.

## Next

Run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows:

    /analyze-orchestrator -f .workflows/plan/SESSION_CONTEXT_ROT_PLAN.md

Or execute one phase at a time, starting at phase 1:

    /implement -f .workflows/plan/SESSION_CONTEXT_ROT_PLAN.md --phase 1
