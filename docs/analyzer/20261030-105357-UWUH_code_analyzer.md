# Code Analysis: chat bar brain (`ChatBackend` seam, `POST /api/chat`)

**Type:** Feature Implementation
**Date:** 2026-10-30T10:53:57+07:00
**Session ID:** 20261030-105357-UWUH
**Plan:** `docs/plans/CHAT_BAR_BRAIN_PLAN.md` (4 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/chat-bar-brain`, branch `feature/chat-bar-brain` (base `HEAD` @ `d60a707`. `main` is one commit ahead of `origin/main` with the brief itself, so `HEAD` is the tree that was read.)

---

## User Input

### Original User Request

Invocation: `/analyze feature The request is the file docs/iterations/04-chat-brain.md: read it and take everything below its line as the verbatim user input for Step 0.`

Verbatim from `docs/iterations/04-chat-brain.md`, below the `---`:

```
Build mcp-notes iteration 4 ("Chat bar brain") from docs/ROADMAP.md. The "Fixed decisions"
table in docs/ROADMAP.md is binding: do not re-decide anything in it. Iterations 1–3 are on main
(plan: docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md). The chat bar, the answer panel, the used-note
highlighting and the `POST /api/chat` SSE contract already exist. Today the endpoint streams a
fixed stub reply from src/chat/stub.ts through the `ChatBackend` seam in src/chat/backend.ts.
This iteration replaces the brain behind that seam and leaves the UI's look alone.

R1 — Claude brain. A `ChatBackend` built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`): headless Claude Code on the owner's existing login, with no
API key in this repo.
  - One SDK run per chat message. The reply streams token by token as `event: delta`, so the
    panel fills while Claude works (partial assistant messages, not one block at the end).
  - The agent reaches notes through the same `notes` MCP server Claude Code uses
    (http://127.0.0.1:7317/mcp), so the chat bar and `/n` share one set of tools and one
    behaviour. Allowed tools: the `notes` MCP tools plus WebSearch and WebFetch (usage example:
    "when did i watch Verity? can you do some web search to see what is it about?"). Nothing
    else: no Bash, no file reads or edits, no other MCP servers from the owner's user config.
    Write tools stay allowed ("remove the markdown formatting in A-B32 and add #agentic" must work
    from the chat bar), and edits show up on the wall through the existing SSE.
  - It can look at pictures through `view_images` ("show me some pictures that i saved on
    30 oct. give your comments on them").
  - The system prompt says what mcp-notes is, that the person typing is the notes' owner, that
    note ids must be quoted in the answer exactly as A-B32 whenever a note is used (the wall's
    highlighting finds ids in the answer text), that answers are plain prose suited to the panel
    (short paragraphs, no markdown headings or tables), and today's date and timezone, so "this
    week" and "30 oct" resolve correctly.
  - Answers are not saved as notes (fixed decision).
  - Guardrails: a max-turns cap, a wall-clock timeout, and an abort that stops the SDK run when
    the HTTP client disconnects or the user sends a new message.

R2 — Threads. A follow-up in the chat bar continues the same conversation ("and compare it to
last month") by resuming the SDK session: `thread_id` in the existing contract is that session.
Dismissing the panel starts a new thread on the next message. A pinned panel keeps its thread.
Resume must survive a daemon restart, as long as the SDK session still exists on disk.

R3 — GLM fallback. The same code runs on GLM by swapping `ANTHROPIC_BASE_URL` /
`ANTHROPIC_AUTH_TOKEN` in the SDK child's environment, taken from .env.local's `LLM_BASE_URL`,
`LLM_API_KEY`, `LLM_MODEL` (z.ai, glm-5.3). A config switch, `CHAT_BRAIN=claude|glm`, defaults to
claude. On top of the switch, when a Claude run fails because of a usage limit or authentication,
the same message is retried once on GLM. The panel then says which brain answered, as a tiny
Geist Mono label in its existing header line, not as a button. GLM is a fallback only: the
daemon never prefers it on its own.

R4 — Progress in the panel. While the agent is calling tools, the panel's header line shows a
terse status in the design's Geist Mono caption style ("searching notes", "reading 3 notes",
"looking at 4 photos", "searching the web"). Add an `event: status` to the SSE contract; the
stub backend may ignore it. No tool-call transcript, no spinners beyond the existing ▍ cursor.

R5 — Daemon fit. notesd runs as a systemd user unit (see deploy/notesd.service and
scripts/install.sh). The SDK has to find the `claude` executable and the owner's login from
inside that unit: Claude Code lives at ~/tools/node-v22.23.1-linux-x64/bin/claude, and
credentials are under ~/.claude. Make install.sh and the unit provide whatever the SDK needs, and
verify through the installed daemon (not only in tests) that a chat message gets a real answer.

R6 — Tests. Unit tests for the backend against a fake SDK `query` (streaming deltas, status
mapping, ids passed through, abort, the fallback path, thread resume), integration tests for
`/api/chat` with the fake injected, and an opt-in live suite (`CHAT_LIVE_TEST=1`, excluded by
default like test:int) that runs one real Claude message and one real GLM message.

Acceptance (typed into the chat bar at http://localhost:7317 once installed):
  summarize our notes on #seer this week. compare it to last week
  check note A-B32 . i just copy paste it in a markdown format. please remove the markdown formatting in it. also add tag #agentic to it
  show me some pictures that i saved on 30 oct . give your comments on them
  when did i watch Verity? can you do some web search to see what is it about?
  (follow-up in the same thread) and what did i write about it the week after?

Out of scope: connectors to expense-tracking / run-insights / seer (iteration 5), embeddings and
semantic search (iteration 6), saving answers as notes, any redesign of the chat bar or the
answer panel beyond the status line and the brain label, chat history UI, multi-user anything.
```

### User-Provided Context

Binding: the "Fixed decisions" table in `docs/ROADMAP.md`. The relevant rows say: the chat bar brain is the Claude Agent SDK (headless Claude Code, existing login), one run per message, resumable thread, streamed, and the same code runs on GLM by swapping `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, as a fallback only. Answers are not saved as notes. The UI is icon-only with Phosphor icons, dark first, no Claude-default look. notesd binds 127.0.0.1:7317 only and has no auth.

### User-Provided Files

None marked with `@`. Named in the prose: `docs/ROADMAP.md`, `docs/plans/NOTES_SPINE_IMAGES_UI_PLAN.md`, `src/chat/stub.ts`, `src/chat/backend.ts`, `deploy/notesd.service`, `scripts/install.sh`, `.env.local`.

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Claude brain: a `ChatBackend` on the Claude Agent SDK. One run per message, token streaming, notes MCP plus WebSearch/WebFetch only (writes allowed), `view_images`, the system prompt, no saved answers, max turns, timeout and abort |
| R2 | Threads: `thread_id` is the SDK session id. Follow-ups resume it, dismissing the panel starts a new thread, pinning keeps it, and resume survives a daemon restart |
| R3 | GLM fallback: `CHAT_BRAIN=claude\|glm` (default claude), one retry on GLM after a Claude usage-limit or auth failure, and a brain label in the panel header |
| R4 | Progress: `event: status` in the SSE contract, terse tool-progress captions in the panel header |
| R5 | Daemon fit: the systemd unit and install.sh give the SDK the `claude` binary and the login, verified through the installed daemon |
| R6 | Tests: backend unit tests against a fake `query`, `/api/chat` integration tests with the fake injected, and an opt-in live suite (`CHAT_LIVE_TEST=1`) |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** `POST /api/chat` already streams SSE (`delta`, `done`, `error`) from whatever `ChatBackend.reply()` returns. The only backend is a stub that word-splits a fixed sentence. This iteration does four things:
1. It adds a real backend that drives `query()` from `@anthropic-ai/claude-agent-sdk` against the daemon's own `/mcp`.
2. It extends the seam and the SSE contract with tool-progress `status` events and with the brain that answered.
3. It teaches the web client to show both in the existing `.answer-head` line and to drop the thread when the panel is dismissed.
4. It makes the installed systemd unit able to spawn `claude` with the owner's login.

**Success Criteria.**
- Each acceptance prompt typed into the installed daemon's chat bar gets a real streamed answer that quotes the ids of the notes it used. The edit prompt changes A-B32 on the wall live, the photo prompt comments on images it actually viewed, and the Verity prompt cites web results.
- The follow-up keeps context.
- With Claude made unusable (bad credentials), the same message is answered by GLM and the panel shows `glm`.
- `npm test`, `npm run typecheck` and `npm run test:int` are green, and `CHAT_LIVE_TEST=1 npm run test:live` passes on this machine.

**Key Considerations.**
- *Isolation.* The SDK by default loads the owner's user settings, CLAUDE.md, hooks and MCP servers. The run must use `settingSources: []`, `strictMcpConfig: true` and `mcpServers: { notes: http }`, `tools: ['WebSearch','WebFetch']` (the built-in base set), and an explicit `allowedTools` list. A permission mode of `dontAsk` makes anything outside the allow-list deny instead of prompt. OAuth credentials (`~/.claude/.credentials.json`) are not "settings", so the login still works.
- *Session storage is keyed by cwd.* `resume` finds a session under `~/.claude/projects/<cwd-slug>/`, so every run must use one fixed cwd. Otherwise resume after a restart fails.
- *thread id timing.* For a new thread the session id is known only after the SDK's first `system/init` message, and a GLM retry may produce a different id. So the id must be reported at the end of the turn, in `done`, not when `reply()` resolves.
- *Fallback window.* Usage-limit and auth failures surface before any text, as an `assistant` message with `error` in `authentication_failed | billing_error | rate_limit | oauth_org_not_allowed …`, or as an error `result`. Retrying after text has already streamed would duplicate output.
- *Env.* `options.env` replaces the child environment wholesale. Claude runs must strip `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, so no key is used and the OAuth login is. GLM runs set `ANTHROPIC_BASE_URL=LLM_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=LLM_API_KEY` and model `LLM_MODEL`.
- *systemd.* User units get `HOME`. The unit's PATH already holds the node dir, and `claude` there is a native ELF (`.../claude-code/bin/claude.exe`), passed as `pathToClaudeCodeExecutable`.
- *SDK version.* `@anthropic-ai/claude-agent-sdk@0.3.311` declares `claudeCodeVersion: 2.1.311`, which matches the installed CLI exactly (latest is 0.3.314, published today). Peers: `zod ^4` (repo 4.4.3), `@modelcontextprotocol/sdk ^1.29` (repo 1.32.2), `@anthropic-ai/sdk >=0.93.0` (not in the repo yet).
- *Assumption.* WebSearch is a server tool and may not work on GLM. This is accepted: GLM is a fallback, and the live GLM test uses a notes-only message.

---

## Analysis Scope

### Explicitly Mentioned Files
- `src/chat/backend.ts`, `src/chat/stub.ts`, `deploy/notesd.service`, `scripts/install.sh`, `docs/ROADMAP.md`, `.env.local` (keys only: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPENROUTER_API_KEY`)

### Discovered Related Files
- `src/http/api.ts`: `apiRoutes(deps, { chat? })` and the `POST /api/chat` handler (lines 191–222)
- `src/http/app.ts`: `createApp(deps)` calls `apiRoutes(deps)` with **no options**, so the daemon cannot inject a backend today (line 51)
- `src/daemon.ts`: `startDaemon(config)` wires deps → `createApp`, and creates the data subdirs
- `src/deps.ts`: `AppDeps`
- `src/config.ts`: `loadConfig()`. Its comment notes that `LLM_*` keys are ignored today
- `src/main.ts`: entry point
- `src/mcp/tools.ts`, `src/mcp/imageTools.ts`: MCP tool names `create get update append delete restore list search tags revisions revert create_image view_images` (Claude sees them as `mcp__notes__<name>`)
- `src/mcp/instructions.ts`: `localTimeZone()` helper (IANA tz of the daemon, Asia/Jakarta)
- `web/src/hooks/useChat.ts`: SSE consumer. `threadId` ref, `close()` does **not** clear `threadId`
- `web/src/components/AnswerPanel.tsx`: `.answer-head` = query · spacer · pin · dismiss
- `web/src/App.tsx`: wires `useChat` → `AnswerPanel`, Escape closes unless pinned
- `web/src/api.ts`: `postChat(message, threadId, signal)`
- `web/src/lib/sse.ts`: generic SSE parser, needs no change
- `web/src/styles.css`: `.answer-head`, `.answer-q` (mono 10.5px dim) is the caption style to reuse
- `tests/unit/chat-stub.test.ts`, `tests/integration/api.int.test.ts` (lines 202–231), `tests/integration/helpers/api-harness.ts` (injects the stub), `web/src/App.test.tsx` (fake SSE fetch)
- `vitest.config.ts`: single config, include switch on `VITEST_INTEGRATION`
- `scripts/test-int.sh`, `docs/INSTALL.md`, `package.json`

---

## Current Dataflow

### Entry Point: `POST /api/chat`

**Location:** `src/http/api.ts:191`
**Trigger:** `fetch('/api/chat')` from `web/src/api.ts:58 postChat`
**Input Schema:** `{ "message": string (trimmed, ≥1), "thread_id"?: string (trimmed, 1..200) }`
**Validation:** zod `chatSchema` (api.ts:33). Bad JSON or schema → 400 JSON `{error}` before streaming
**Next Step:** `streamSSE` → `chat.reply({ message, threadId, signal })`

### Processing Chain

1. **`streamSSE` callback** (api.ts:200). It creates an `AbortController`, and `stream.onAbort` aborts it (client disconnect).
2. **`chat.reply()`** → `ChatTurn { threadId, deltas }`. The stub's threadId is `request.threadId ?? 'stub-<uuid>'` and its deltas are words with a 40 ms delay.
3. **Loop**: each delta → `event: delta` `{"text": …}`. Then `event: done` `{"thread_id": turn.threadId}`.
4. **Errors**: any throw → `event: error` `{"error": message}`, unless aborted (then silent return).

### Client chain

`App.send` → `useChat.ask(q)`:
1. It aborts the previous controller, which cancels the previous fetch. The server sees the abort.
2. It posts with `threadId.current`.
3. `readSSE` handles `delta` (append text), `done` (store `thread_id`, finish) and `error` (append "Chat failed: …").

`close()` aborts, resets open/pinned/text, but keeps `threadId.current`, so a dismissed panel continues the old thread today. `App` computes used ids with `extractUsedIds(chat.text, noteIds)`, which drives chips and wall highlighting.

### Data Persistence

None for chat. Note writes made by the agent go through `/mcp` → `NotesService` → `NoteEvents` → `GET /api/events` SSE → the wall refreshes (existing path, unchanged). SDK sessions are persisted by Claude Code under `~/.claude/projects/<slug-of-cwd>/<session-id>.jsonl`.

### Exit Points
- SSE `delta`/`done`/`error`. Heartbeat is only on `/api/events`, not chat.

---

## Key Data Structures

### `ChatRequest` / `ChatTurn` / `ChatBackend`
**Location:** `src/chat/backend.ts:6-24`
**Fields:** `ChatRequest { message; threadId: string|null; signal: AbortSignal }`, `ChatTurn { threadId: string; deltas: AsyncIterable<string> }`, `ChatBackend { reply(req): Promise<ChatTurn> }`
**Used In:** `src/http/api.ts:202`, `src/chat/stub.ts:46`, `tests/unit/chat-stub.test.ts`, `tests/integration/helpers/api-harness.ts:43`

### `Config`
**Location:** `src/config.ts:19`. Fields `databaseUrl, port, host, dataDir`. No chat fields.

### `ChatState` (web)
**Location:** `web/src/hooks/useChat.ts:5`. Fields `open, pinned, query, text, done`.

### Agent SDK (to be added)
`query({ prompt, options }) → Query` (an AsyncGenerator of `SDKMessage`). The options this work needs are `abortController, cwd, env, includePartialMessages, maxTurns, mcpServers, pathToClaudeCodeExecutable, permissionMode, resume, settingSources, strictMcpConfig, systemPrompt, tools, allowedTools, disallowedTools, model`. Messages:
- `system` (subtype `init`, `session_id`)
- `stream_event` (`SDKPartialAssistantMessage`: `event.type === 'content_block_delta'` with `delta.type === 'text_delta'`; `parent_tool_use_id`)
- `assistant` (`message.content[]` with `tool_use` blocks `{name, input}`; optional `error: SDKAssistantMessageError`)
- `result` (`subtype: 'success' | 'error_max_turns' | 'error_during_execution' …`, `is_error`, `session_id`)

Types: `sdk.d.ts` in the package. A copy of 0.3.311 is unpacked at `/tmp/claude-1000/-home-miftah-mcp-notes/b0435798-c9ea-40df-9e92-ab69c726329b/scratchpad/sdk/package/sdk.d.ts`. `SDKAssistantMessageError` (line ~3785) is `'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' | 'verification_required' | 'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens' | 'cloud_credential_error'`.

---

## Dependencies

### Configuration / Environment / External Services
- `.env.local`: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (present, unused today).
- New: `CHAT_BRAIN` (claude|glm), plus the chat guardrail knobs and the claude path (named in the plan).
- systemd unit env: `NODE_ENV`, `NOTES_DATA_DIR`, `PATH=<node dir>:/usr/local/bin:/usr/bin:/bin`. `HOME` is provided by the user manager.
- The installed CLI is `~/tools/node-v22.23.1-linux-x64/bin/claude` → native ELF 2.1.311. Credentials are at `~/.claude/.credentials.json`.
- The running unit (`systemctl --user cat notesd`) runs `/home/miftah/mcp-notes/dist/main.js`.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `ChatBackend`, `ChatTurn`, `ChatRequest` | src/chat/backend.ts:6-24 | def | src/chat |
| `createStubChatBackend`, `STUB_REPLY`, `splitIntoDeltas` | src/chat/stub.ts | impl | src/chat |
| `ApiOptions.chat`, `chat.reply` | src/http/api.ts:16-21, 90, 202 | call | src/http |
| `apiRoutes(deps)` | src/http/app.ts:51 | call | src/http |
| `createApp(deps)` | src/daemon.ts:56 | call | src |
| `Config` / `loadConfig` | src/config.ts:19,111 | def | src |
| `localTimeZone` | src/mcp/instructions.ts:1 | def | src/mcp |
| chat stub tests | tests/unit/chat-stub.test.ts | test | tests |
| `/api/chat` int tests | tests/integration/api.int.test.ts:202-231 | test | tests |
| stub injection | tests/integration/helpers/api-harness.ts:43 | test | tests |
| `useChat` | web/src/hooks/useChat.ts | impl | web |
| `AnswerPanel` | web/src/components/AnswerPanel.tsx | impl | web |
| `.answer-head`, `.answer-q` | web/src/styles.css:99-100 | css | web |
| App chat test | web/src/App.test.tsx:36,82 | test | web |
| unit template | deploy/notesd.service | config | deploy |
| `resolve_claude`, `install_unit`, `verify` | scripts/install.sh:50,98,166 | script | scripts |
| include switch | vitest.config.ts:21 | config | root |
| install doc | docs/INSTALL.md | doc | docs |

---

## Impact Points (files that WILL need changes)
1. `src/chat/backend.ts`: the seam gains status events and an end-of-turn `{threadId, brain}` (phase 1)
2. `src/chat/stub.ts` + `tests/unit/chat-stub.test.ts`: follow the new seam (phase 1)
3. `src/http/api.ts`: emits `event: status` and `done.brain` (phase 1)
4. `src/http/app.ts`, `src/daemon.ts`: let the daemon inject a backend (phase 1). `daemon.ts` builds the real one (phase 2)
5. `src/config.ts` + `tests/unit/config.test.ts`: chat config (phase 1)
6. `tests/integration/api.int.test.ts`, `helpers/api-harness.ts`: fake backend injection, status/brain (phase 1)
7. `package.json`/`package-lock.json`: Agent SDK dependency (phase 2). `test:live` script (phase 4)
8. new `src/chat/agent*.ts` (backend, prompt, status mapping, env), `tests/unit/chat-agent*.test.ts` (phase 2)
9. `web/src/hooks/useChat.ts`, `web/src/components/AnswerPanel.tsx`, `web/src/styles.css`, `web/src/App.test.tsx` (phase 3)
10. `deploy/notesd.service`, `scripts/install.sh`, `docs/INSTALL.md`, `vitest.config.ts`, new `tests/live/*` (phase 4)

**This document describes. The plan files prescribe.**
