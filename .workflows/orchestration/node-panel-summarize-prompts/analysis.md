# Code Analysis: Projects node panel — Summarize on demand + Prompts modal

**Type:** Feature Implementation
**Date:** 2026-11-03 15:00 (Asia/Jakarta)
**Session ID:** 20261103-150033-K7Q2
**Plan:** `docs/plans/NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md` (5 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts`, branch `feature/node-panel-summarize-prompts` (base `origin/main` @ `5c21bad`)

---

## User Input

### Original User Request

```
feature
Two Projects-page node-panel features. Plan them as one set (both touch web/src/components/graph/NodePanel.tsx and src/sessions/readModel.ts); split phases by feature where the build allows. Decided design below — do not re-litigate.

## R1 — Summarize on demand (user, verbatim): "the summary in node details, many nodes still said 'Summary / No summary yet' ... can we theoretically skim the whole session (if this session is in the same machine) using Haiku and get the summary of it? if we can, i think we need to add a "Summarize" icon button there. so user can click it in case user wants the summary of this node."

Measured 2026-11-03 (1200 sessions, 209 without summary): 200 ran on the other laptop (host GPD; only the owning host can read the transcript; newest unsummarized one 2026-11-02, so GPD's summary worker may be paused/off — out of scope here, diagnose on GPD), 6 are empty (0 tokens), 2 are live (summaries wait for 15 min idle, src/sessions/summaryWorker.ts DEFAULT_SUMMARY_IDLE_MS), 1 was idle under 15 min.
Design:
1. A Summarize icon button (Phosphor, icon-only with aria-label "Summarize") in the node panel's Summary section. Clicking it records a request in the shared DB (column or small table, e.g. cc_sessions.summary_requested_at, via SessionsRepo — the only writer of session tables). It never calls Haiku in the HTTP request.
2. The summary worker on the OWNING host picks requested sessions up on its next sweep, ahead of the idle backlog, ignoring the idle wait (a live session gets a "summary so far"; it is re-summarized normally once idle). So the button works for GPD nodes too, whenever that daemon runs. Respect the existing rate limiter and failure pause.
3. Replace the bare "No summary yet" with the reason: "Empty session" (0 tokens; no button), "Summarizes once idle", "Summary requested", "Will be summarized on <host>". The panel refreshes when the summary lands (existing refresh/SSE path).
4. Same-origin POST route next to the other session routes (src/http/sessionsApi.ts); MCP not needed.

## R2 — Prompts modal (user, verbatim): "this the Prompts field, add an "expand" icon button so user can see the whole Prompts of this node in a bigger-view modal, please add a copy icon button for every prompt number. and also "copy whole prompts" icon button maybe at the top right of the bigger-view modal"

Facts: stored prompts are capped (src/sessions/types.ts MAX_PROMPTS = 100 newest, MAX_PROMPT_CHARS = 2000; long prompts end in "…"). NodePanel shows the first PROMPTS_SHOWN = 20 then "+N more" (NodePanel.tsx ~L233).
Measured 2026-11-03 on host pc: 660 local transcripts hold 2371 typed prompts, 4.8 MB total, average 2 KB, largest 46 KB, and 648 of them (27%) are over 2000 chars. So truncation is common, and storing everything costs megabytes.
Design (decided by the user: store complete prompts in the shared DB, so GPD nodes show full prompts on any machine too):
1. Ingest stores every typed prompt in full: drop the MAX_PROMPT_CHARS cut and the MAX_PROMPTS cap for storage (keep a sanity ceiling per prompt, e.g. 256 KB, marked truncated if ever hit). If the prompts jsonb column on cc_sessions makes detail/graph queries heavy, move prompts to a side table (e.g. cc_session_prompts(session_id, seq, at, text)) and keep cc_sessions light. The graph list and any query that does not need prompt text must not load it. SessionsRepo stays the only writer.
1b. Redaction (decided by the user): every prompt passes through the existing redactor in src/sessions/redact.ts (the one the Haiku summaries already use) before it is written, so secrets pasted into a prompt (API keys, tokens, passwords, connection strings) never reach the shared DB. Store only the redacted text. Do not keep a raw copy anywhere in the DB. Redacted spans keep the redactor's visible placeholder, so the modal and copy show where something was removed. Unit-test a prompt containing a fake key: the key must not be stored, and the rest of the prompt must be stored byte for byte.
2. Backfill: existing sessions hold truncated, unredacted prompts. The backfill also replaces them with the redacted text, so no unredacted prompt is left behind on this host. Each host re-reads its OWN transcripts once to fill the full text (a one-time, idempotent backfill, e.g. a stored "prompts_full" version per session, so the GPD daemon backfills GPD's sessions the next time it runs). Never re-ingest anything else as a side effect (tokens, commits, parent links stay as they are).
3. The node panel keeps its short list (excerpts). An expand icon button (aria-label "Expand prompts") in the Prompts section header opens a large modal listing every prompt, numbered, with its time, full text and whitespace preserved. It loads from the DB, so it works for every node on every host. It never reads the transcript.
4. A copy icon button per prompt (aria-label "Copy prompt N") and a "Copy all prompts" icon button at the modal's top right; copy-all joins as "1. <text>\n\n2. <text>…". Brief check-mark feedback like the existing "Copy ID" button. Copy copies exactly what is shown.
5. Esc / backdrop close the modal only, never the node panel underneath (ProjectsPage.tsx ~L75 closes the panel on Escape unless e.defaultPrevented).

## Both
UI taste: icon-only Phosphor buttons, existing panel styling, not the Claude-default look. Update the verify-notesd feature map (.claude/skills/verify-notesd/features/projects.md); Proof uses .claude/skills/verify-notesd (up --sessions --web; tests/fixtures/claude-home needs a fixture session with a >2000-char prompt and more than 100 prompts). After landing: rebuild + restart the live daemon.
```

### User-Provided Context
Measurements above (2026-11-03): 209 unsummarized sessions of 1200; 660 local transcripts, 2371 prompts, 4.8 MB, largest prompt 46 KB, 27% over 2000 chars.

### User-Provided Files
None marked with `@`. Named: `web/src/components/graph/NodePanel.tsx`, `src/sessions/readModel.ts`, `src/sessions/summaryWorker.ts`, `src/sessions/types.ts`, `src/sessions/redact.ts`, `src/http/sessionsApi.ts`, `web/src/pages/ProjectsPage.tsx`, `.claude/skills/verify-notesd/features/projects.md`, `tests/fixtures/claude-home`.

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Summarize on demand: a "Summarize" icon button in the node panel's Summary section records a request in the shared DB; the owning host's summary worker summarizes requested sessions first (ignoring the idle wait); the bare "No summary yet" is replaced by the reason |
| R2 | Prompts modal: store every prompt in full and redacted (with a one-time per-host backfill), and an "Expand prompts" button opening a large modal listing every prompt with per-prompt copy and copy-all |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.**
R1: summaries are produced only by the owning host's background worker, and only for sessions idle ≥ 15 min and not live. There is no way to ask for one, and the panel says "No summary yet" without saying why. A request flag in `cc_sessions` (written through `SessionsRepo`), a same-origin POST to set it, a worker change that treats requested rows as first-priority candidates regardless of idleness/liveness, and a panel state label + button close it.
R2: the ingest stores at most the newest 100 prompts, each cut to 2000 chars, unredacted, inside the `cc_sessions.prompts` jsonb (which also feeds the generated `search_tsv`, the Haiku summarizer input and the embed text). The user wants every prompt in full, redacted, in the shared DB, readable from any host in a modal, with copy buttons.

**Success Criteria.**
- R1: clicking Summarize on a summarizable node records `summary_requested_at`; the owning host's worker summarizes it on its next drain (live or not), through the same rate limiter and failure pause, and clears the request; the panel shows the summary once it lands (graph poll), and shows one of the four reason strings while there is none. Empty sessions (0 tokens) show "Empty session" with no button.
- R2: after ingest, a session's full prompt list is in a side table, redacted, in order, with times; a fake API key in a prompt is never stored and the rest of the prompt is byte-identical; existing rows on this host are backfilled once (version marker), no other column changes during backfill; the modal lists every prompt with copy buttons; Esc/backdrop closes only the modal.

**Key Considerations.**
- `search_tsv` is a GENERATED column over `prompts` jsonb text. Putting full prompts (session totals up to hundreds of KB) into the jsonb risks Postgres' 1 MB tsvector limit ("string is too long for tsvector") which would fail the whole ingest write. The side table keeps `cc_sessions` and its tsvector bounded.
- `first_prompt` and `last_prompt` columns also hold typed prompt text (cut to 2000) and are shown and indexed; "secrets pasted into a prompt never reach the shared DB" covers them too.
- Ingest writes are a compare-and-set on `transcript_offset`; a backfill that replaces prompt rows must not race the tail ingester appending new prompts (it must replace exactly the prompts up to a known offset, under the row lock, and only if the offset still matches).
- Transcripts can be gone (Claude Code prunes old ones). The backfill must still redact the stored truncated prompts in place for those rows so that "no unredacted prompt is left behind on this host".
- The summary worker's candidate query is `last_active_at < idleBefore`; live sessions are filtered in JS; a `seen` map skips rows already handled at the same `last_active_at`. Requested rows must bypass all three.
- `buildSummaryInput` returns null when a session has no prompts and no final message; a request on such a row must be cleared rather than retried forever.
- NodePanel re-fetches detail only when the graph node's `last_active_at` changes (`stamp`); a summary landing does not change it. The graph poll (10 s, ETag over nodes incl. `summary_excerpt`) does pick it up, so the stamp must include the summary state.
- `useCopied` copies the key it is given as text; per-prompt copy needs "copy this text, flag this key".
- ProjectsPage closes the node panel on Escape unless `e.defaultPrevented`; NodeModal (chat pop-up) has its own Escape handler that checks `isEditorOpen() || isLightboxOpen() || isConfirmOpen()`.

**Assumptions** (inferred, stated, planned against):
- "Will be summarized on <host>" is shown for a node on another host with no summary and no pending request; once requested it shows "Summary requested" (with the host in the tooltip). The button is shown for any non-empty node without a summary, on any host (the request is served by the owning host).
- The button is offered only where a summary is missing (that is where the user asked for it); a node that has a summary shows it and no button.
- "Summarizes once idle" = live, or last active < 15 min ago, on this host, not requested.

---

## Analysis Scope

### Explicitly Mentioned Files
- `web/src/components/graph/NodePanel.tsx`, `src/sessions/readModel.ts`, `src/sessions/summaryWorker.ts`, `src/sessions/types.ts`, `src/sessions/redact.ts`, `src/http/sessionsApi.ts`, `web/src/pages/ProjectsPage.tsx`, `.claude/skills/verify-notesd/features/projects.md`, `tests/fixtures/claude-home/`

### Discovered Related Files
- `src/db/schema.ts:486-545` — `ccSessions` table, `prompts` jsonb, generated `search_tsv`
- `drizzle/0009_note_session_links.sql`, `drizzle/meta/_journal.json` — last migration is 0009
- `src/sessions/transcript.ts:285-320, 370-460, 500-520, 620-645` — `isHumanPrompt`, `promptText`, `TranscriptAccumulator` (prompt cut + cap), `buildTranscriptPatch`
- `src/sessions/merge.ts:87-93, 139-170` — `mergePrompts` (clip + cap), `firstPrompt`/`lastPrompt` clip
- `src/sessions/repo.ts:206-235` — `upsertFromTranscript` (row lock, CAS, single update), `598-607` `setSummary`
- `src/sessions/ingest.ts` — `startSessionIngest`, `readFile` (per-file serialized via `runFile`), backfill pass
- `src/sessions/summarize.ts:121-160, 193-210` — summarizer input / embed text from `prompts` jsonb (own caps 40 × 1500)
- `src/sessions/view.ts:18, 98, 160-175, 421-450, 497-514` — `DETAIL_MAX_PROMPTS = 200`, `SessionPrompt`, `SessionInfo`, `toGraphNode`, `normalizePrompts`
- `src/background.ts:85-120` — ingest + summary worker wiring (same `hostname()`)
- `src/daemon.ts:118-128` — real summarizer (`createAgentSummarizer`), null when no claude binary
- `web/src/sessionDetailApi.ts:35-60, 160-230` — `SessionDetail`, `normalizeSessionDetail`, `fetchSessionDetail`, `resumeSession` (POST pattern)
- `web/src/hooks/useCopied.ts` — `copyText`, `useCopied`
- `web/src/hooks/useSessionGraph.ts:9` — `GRAPH_POLL_MS = 10_000`, ETag poll
- `web/src/components/NoteEditor.tsx:~100`, `web/src/components/graph/NodeModal.tsx:~40` — modal/Escape precedents
- `web/src/components/graph/NodePanel.css` — panel styles (`.np-sec`, `.np-sec-head`, `.np-prompts`, `.ibtn`)
- `web/src/components/graph/NodePanel.test.tsx`, `web/src/sessionDetailApi.test.tsx` — existing UI tests
- `.claude/skills/verify-notesd/scripts/verify.sh` — `up --sessions` copies `tests/fixtures/claude-home` into the run's CLAUDE_HOME

---

## Current Dataflow

### Entry Point A: transcript ingest
**Location:** `src/sessions/ingest.ts` `startSessionIngest` → `readFile` (≈ L370)
**Trigger:** startup backfill pass, 60 s sweep, chokidar watch.
1. `readJsonlFrom(file, fromOffset)` streams lines → `parseRecord` → `TranscriptAccumulator.add`.
2. `transcript.ts:509-516`: for a human prompt, `cut(text, MAX_PROMPT_CHARS)` → `firstPrompt ??=`, `prompts.push({text, at})`, keeps ≤ 2×MAX_PROMPTS in memory; `delta()` returns `prompts.slice(-MAX_PROMPTS)`. `last-prompt` records also cut to 2000.
3. `buildTranscriptPatch` → `TranscriptPatch` (`prompts`, `firstPrompt`, `lastPrompt`, tokens, commits …).
4. `SessionsRepo.upsertFromTranscript` (`repo.ts:212`): `ensureSession`, tx, `lock` (select … for update), host check (`other_host`), CAS on `transcript_offset` (`offset_mismatch`), `mergeTranscriptPatch` (pure; `mergePrompts` clips each to 2000 and keeps newest 100, `reset` on fromOffset 0), one `update cc_sessions set …`.
5. Ingest updates its in-memory offsets/carries and notifies observers (heuristic linker).

### Entry Point B: summary worker
**Location:** `src/sessions/summaryWorker.ts` `startSummaryWorker` → `drainOnce`
**Trigger:** immediate drain at start, then every 60 s (`sweep`), `kick()`.
1. Skip whole drain while `summariesPaused()` (3 consecutive failures → backoff).
2. `store.listIdle({host, idleBefore: now-15min, limit 5000, wantSummary, embeddingModel})` — raw SQL: `host = $host and last_active_at < idleBefore and (summarized_at is null or summarized_at < last_active_at or <embedding stale>)`, newest first.
3. JS filter: not live (registry), not `seen` at same `last_active_at`, `retryAt` passed.
4. Batches of 20: `store.load(ids)` (selects `prompts` jsonb etc.) → `processOne`: `buildSummaryInput` (null → skip), sha compare, `summaryLimiter.acquire` (5 s spacing), `summarizer.summarize`, `cleanSummary`, `store.saveSummary` → `SessionsRepo.setSummary` (sets `summary, summary_sha, summarized_at, updated_at`). Then embedding.
5. Failures → `fail()` with per-session backoff; global pause after 3 consecutive.

### Entry Point C: session detail read
**Location:** `GET /api/sessions/:nodeId` (`sessionsApi.ts`) → `sessionDetail` (`readModel.ts:270`)
`select NODE_SELECT, DETAIL_SELECT` (includes `s.prompts`, `s.summary`, `s.summarized_at`, tokens, host) → `toSessionInfo` (`available = host === rd.host`, `live` from registry) → `normalizePrompts(row.prompts)` (clip `DETAIL_PROMPT_CHARS`, last 200) → JSON. Graph list (`graphForRepo`) uses `NODE_SELECT` only (no prompts; `left(summary,600)` as `summary_head`).

### Entry Point D: web panel
`ProjectsPage` → `NodePanel` → `fetchSessionDetail` → `normalizeSessionDetail` (prompts flattened to `string[]`, times dropped) → Summary section (`detail.summary` or "No summary yet") and Prompts section (first 20, "+N more"). Re-fetch only when graph node `last_active_at` (`stamp`) changes; graph polls every 10 s with ETag.

### Data Persistence
- `cc_sessions` (Postgres, shared by both hosts): `prompts` jsonb `[{text, at}]` (≤100 × ≤2000 chars, unredacted), `first_prompt`, `last_prompt` (≤2000, unredacted), `summary*`, generated `search_tsv` (GIN).
- No prompt side table; no request column.

### Exit Points
- HTTP JSON; MCP `session_get` (uses `sessionDetail`) also returns prompts; Haiku summarizer (input redacted in `summarize.ts`); OpenRouter embedder (redacted).

---

## Key Data Structures

- `SessionPrompt` (`src/db/schema.ts:452`): `{ text: string; at: string | null }` — jsonb element.
- `TranscriptPatch` (`src/sessions/types.ts:79-121`): `prompts?: SessionPrompt[]`, `firstPrompt`, `lastPrompt`, offsets.
- `TranscriptSet` (`types.ts:124-151`): columns a patch writes; includes `prompts`.
- `SummaryCandidate` / `SummaryStore` (`summaryWorker.ts:35-63`): `listIdle`, `load`, `saveSummary`, `saveEmbedding`.
- `SessionInfo` / `SessionDetail` (`src/sessions/view.ts:146-176`): server detail payload.
- Web `SessionDetail` (`web/src/sessionDetailApi.ts:35`): `prompts: string[]`, `summary`, `available`, `live`, `host`, `tokens`.

---

## Dependencies

- **Config / env:** `NOTESD_SESSIONS`, `CLAUDE_HOME`, `NOTESD_CLAUDE_BIN` (summarizer off when missing), `OPENROUTER_API_KEY` (embedder).
- **DB:** Drizzle schema + SQL migrations (`npm run db:generate`), next is `0010`.
- **External:** Claude Agent SDK Haiku summarizer (`createAgentSummarizer`) — called only from the worker.
- **Hosts:** `os.hostname()` (`pc`, `GPD`); `available` is `host === this host`.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `MAX_PROMPTS`, `MAX_PROMPT_CHARS` | `src/sessions/types.ts:60-61` | def | sessions |
| `MAX_PROMPTS`/`MAX_PROMPT_CHARS` import + cut | `src/sessions/transcript.ts:7-8, 425, 459, 512-515` | call | sessions |
| `mergePrompts`, `clipOrKeep(firstPrompt/lastPrompt)` | `src/sessions/merge.ts:87-93, 141, 150, 165` | call | sessions |
| `upsertFromTranscript` | `src/sessions/repo.ts:212` | def | sessions |
| `setSummary` | `src/sessions/repo.ts:598` | def | sessions |
| `redactSecrets`, `REDACTED` | `src/sessions/redact.ts` | def | sessions |
| `redactSecrets` callers | `src/sessions/summarize.ts` | call | sessions |
| `ccSessions.prompts`, `searchTsv` | `src/db/schema.ts:524, 534` | def | db |
| `listIdle`, `load`, `drainOnce`, `processOne` | `src/sessions/summaryWorker.ts:117-170, 268-385` | def | sessions |
| `DEFAULT_SUMMARY_IDLE_MS` | `src/sessions/summaryWorker.ts:20` | def | sessions |
| `DETAIL_SELECT`, `sessionDetail` | `src/sessions/readModel.ts:190-196, 270` | def | sessions |
| `normalizePrompts`, `DETAIL_MAX_PROMPTS` | `src/sessions/view.ts:18, 498` | def | sessions |
| `sessionsApiRoutes` | `src/http/sessionsApi.ts:120` | def | http |
| `sameOriginOnly` | `src/http/sameOrigin.ts` | def | http |
| `normalizeSessionDetail`, `fetchSessionDetail` | `web/src/sessionDetailApi.ts:168, 210` | def | web |
| Summary / Prompts sections, `PROMPTS_SHOWN` | `web/src/components/graph/NodePanel.tsx:19, 239-257` | def | web |
| Escape closes panel | `web/src/pages/ProjectsPage.tsx:75-83` | call | web |
| `useCopied`, `copyText` | `web/src/hooks/useCopied.ts` | def | web |
| prompt tests | `web/src/components/graph/NodePanel.test.tsx:25,115`, `web/src/sessionDetailApi.test.tsx:44-133` | test | web |
| ingest/merge/worker tests | `tests/unit/sessions/*`, `tests/integration/sessions*.int.test.ts` | test | tests |
| fixtures | `tests/fixtures/claude-home/projects/-home-u-mcp-notes/*.jsonl` | test | tests |
| feature map | `.claude/skills/verify-notesd/features/projects.md` | doc | skill |

---

## Impact Points (files that WILL need changes)

1. `src/db/schema.ts` + `drizzle/0010_*.sql` + `drizzle/meta/*` — `summary_requested_at`, `prompts_version`, `cc_session_prompts` table — Phase 1
2. `src/sessions/repo.ts` — `requestSummary`, `setSummary` clears request (Phase 1); side-table writes in `upsertFromTranscript`, `replacePrompts`, backfill reads (Phase 3)
3. `src/sessions/types.ts` — new constants/types (Phase 1 request types; Phase 3 prompt ceiling and patch shape)
4. `src/sessions/summaryWorker.ts` — requested candidates first, bypass idle/live/seen, clear request on null input — Phase 2
5. `src/sessions/readModel.ts`, `src/sessions/view.ts`, `src/http/sessionsApi.ts` — summary state in detail + POST route (Phase 2); full prompt list read + GET route (Phase 5)
6. `src/sessions/transcript.ts`, `src/sessions/merge.ts`, `src/sessions/ingest.ts`, `src/background.ts` — full + redacted prompts, backfill — Phase 3
7. `tests/fixtures/claude-home/…` — fixture session with >100 prompts and a >2000-char prompt (and a fake key) — Phase 3
8. `web/src/sessionDetailApi.ts`, `web/src/components/graph/NodePanel.tsx`, `NodePanel.css`, tests — Summary reason + button (Phase 4); Prompts expand + modal + copy (Phase 5)
9. `web/src/hooks/useCopied.ts` — copy text under a key — Phase 5
10. `.claude/skills/verify-notesd/features/projects.md` — R1 entry (Phase 4), R2 entry (Phase 5)

**This document describes. The plan files prescribe.**
