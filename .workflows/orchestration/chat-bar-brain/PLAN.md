# Plan: Chat bar brain (mcp-notes iteration 4)

**Slug:** chat-bar-brain
**Date:** 2026-10-30T10:53:57+07:00
**Analysis:** `docs/analyzer/20261030-105357-UWUH_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/chat-bar-brain`
**Branch:** `feature/chat-bar-brain` (base: `HEAD` of `main` @ `d60a707`)
**Phases:** 4
**Status:** complete
**Coordinator:** —

---

## Why

Verbatim from `docs/iterations/04-chat-brain.md`. The full text, including the acceptance list and the out-of-scope list, is in the analysis document under "Original User Request". The parts that set what may and may not change:

> Build mcp-notes iteration 4 ("Chat bar brain") from docs/ROADMAP.md. The "Fixed decisions"
> table in docs/ROADMAP.md is binding: do not re-decide anything in it. […] Today the endpoint
> streams a fixed stub reply from src/chat/stub.ts through the `ChatBackend` seam in
> src/chat/backend.ts. This iteration replaces the brain behind that seam and leaves the UI's
> look alone.

> Out of scope: connectors to expense-tracking / run-insights / seer (iteration 5), embeddings and
> semantic search (iteration 6), saving answers as notes, any redesign of the chat bar or the
> answer panel beyond the status line and the brain label, chat history UI, multi-user anything.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Claude brain: Agent SDK `ChatBackend`. One run per message, token streaming, notes MCP + WebSearch/WebFetch only (writes allowed), `view_images`, system prompt, no saved answers, max turns, timeout, abort | 2, 4 |
| R2 | Threads: `thread_id` = SDK session. Resume on follow-up, dismiss = new thread, pin keeps it, survives a daemon restart | 2, 3 |
| R3 | GLM fallback: `CHAT_BRAIN=claude\|glm` (default claude), one GLM retry after a Claude usage-limit/auth failure, brain label in the panel header | 1, 2, 3 |
| R4 | Progress: `event: status` in the SSE contract, terse tool captions in the panel header | 1, 2, 3 |
| R5 | Daemon fit: unit + install.sh give the SDK `claude` and the login, verified through the installed daemon | 4 |
| R6 | Tests: backend unit tests vs a fake `query`, `/api/chat` int tests with the fake injected, opt-in live suite `CHAT_LIVE_TEST=1` | 1, 2, 4 |

R3 and R4 each span three layers (SSE contract → backend → panel). That coupling is a real fact about the work. Each phase owns one layer of them, not a separate requirement.

## Scope

**In scope:** the `ChatBackend` seam and the `/api/chat` SSE contract (`status`, `done.brain`), a new Agent SDK backend under `src/chat/`, chat config, daemon wiring, `useChat`/`AnswerPanel` status + brain label + thread reset on dismiss, the systemd unit and install.sh, the live test suite, and INSTALL.md.

**Out of scope:** everything in the brief's out-of-scope list; any change to the MCP tools themselves; `/n`; the wall's SSE (`/api/events`); the look of the chat bar and panel beyond one caption-styled status/brain span.

## Contract (binding on every phase; phase 1 implements it)

```ts
// src/chat/backend.ts
export type ChatBrain = 'claude' | 'glm';
export type ChatEvent =
  | { type: 'delta'; text: string }      // -> event: delta  {"text": "..."}
  | { type: 'status'; text: string };    // -> event: status {"text": "searching notes"}
export interface ChatTurnEnd {
  threadId: string;                      // -> event: done {"thread_id": "...", "brain"?: "claude"|"glm"}
  brain?: ChatBrain;                     // stub leaves it undefined; done then omits "brain"
}
export interface ChatRequest { message: string; threadId: string | null; signal: AbortSignal }
export interface ChatTurn {
  /** Events in order. Ends normally, or throws (-> event: error). */
  events: AsyncIterable<ChatEvent>;
  /** Valid only after `events` finished without throwing. */
  end(): ChatTurnEnd;
}
export interface ChatBackend { reply(request: ChatRequest): Promise<ChatTurn> }
```

SSE on the wire: `delta` and `error` are unchanged. `status` is new, with data `{"text": string}`. The empty string `""` clears the caption (sent when text starts streaming again after a tool). `done` gains an optional `brain`.

## Invariants

1. `npm run typecheck`, `npm test` and `npm run test:int` are green at the end of every phase.
2. The ROADMAP "Fixed decisions" table is not re-decided.
3. No API key in the repo or in the unit file. A Claude run's child env never carries `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`. The GLM key is read from `.env.local` at runtime only.
4. The agent's tool surface is exactly the 13 `notes` MCP tools (`mcp__notes__*`) + `WebSearch` + `WebFetch`. No user settings, CLAUDE.md, hooks, plugins or other MCP servers are loaded into the SDK run.
5. Answers are never written as notes by the daemon.
6. The panel's look is unchanged except one Geist Mono caption span in `.answer-head` (status while working, brain label when done). No new buttons, no spinners.
7. notesd still binds 127.0.0.1 only.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 ✓ | Chat seam v2: status events, brain, config, daemon injection | R3, R4, R6 | `src/chat`, `src/http`, `src`, `tests` | 15 | — | NORMAL | `.workflows/plan/chat-bar-brain/phase-1.md` | P1-NOTES-A008 | — |
| 2 ✓ | Agent SDK backend: Claude, GLM, fallback, threads, guardrails | R1, R2, R3, R4, R6 | `src/chat`, `src`, `tests` | 12 | 1 | HARD | `.workflows/plan/chat-bar-brain/phase-2.md` | P1-NOTES-A009 | — |
| 3 ✓ | Panel: status caption, brain label, thread reset on dismiss | R2, R3, R4 | `web/src` | 6 | 1 | NORMAL | `.workflows/plan/chat-bar-brain/phase-3.md` | P1-NOTES-A010 | — |
| 4 ✓ | Daemon fit: unit, install.sh, live suite, installed acceptance | R1, R5, R6 | `deploy`, `scripts`, `tests/live`, root config | 6 | 2, 3 | HARD | `.workflows/plan/chat-bar-brain/phase-4.md` | P1-NOTES-A011 | — |

### Phase 1 — Chat seam v2
**Satisfies:** R3, R4, R6
**Owns:** `src/chat/backend.ts` (the contract above), `src/chat/stub.ts` + `tests/unit/chat-stub.test.ts` (stub yields `delta` events, no status, no brain), `src/http/api.ts` (`status` + `done.brain`), `src/http/app.ts` (`createApp(deps, options?)` passes `chat` to `apiRoutes`), `src/daemon.ts` (`CHAT_SUBDIR = 'chat'` in `DATA_SUBDIRS`, `StartDaemonOptions { chat?: ChatBackend }`, `startDaemon(config, options = {})` with `const chat = options.chat ?? createStubChatBackend(); const app = createApp(deps, { chat });`), `src/config.ts` + `tests/unit/config.test.ts` (`Config.chat: ChatConfig` required, `DEFAULT_CHAT_CONFIG`, see Decisions), new `tests/integration/helpers/scripted-chat.ts`, `tests/integration/api.int.test.ts` + `helpers/api-harness.ts` (harness accepts an injected `chat`; tests for status ordering, `brain` in done, error event, client-abort reaching `request.signal`, via the scripted fake), `tests/integration/daemon.int.test.ts` (chat subdir, stub-by-default, injected backend), and `chat: DEFAULT_CHAT_CONFIG` added to the `Config` literals in `imageHarness.ts`, `mcp.tools.int.test.ts`, `images.int.test.ts`. 15 files.
**Does not touch:** the SDK, `web/`, deploy/scripts.
**Exit criteria:** contract types compile, the stub passes, the int tests cover status/brain/error/abort through `/api/chat`, the daemon still serves the stub by default.

### Phase 2 — Agent SDK backend
**Satisfies:** R1, R2, R3, R4, R6
**Owns:** adds `@anthropic-ai/claude-agent-sdk@0.3.311` (pinned exactly; it declares `claudeCodeVersion 2.1.311`, the installed CLI) + its peer `@anthropic-ai/sdk@0.135.0` to `dependencies` (only that block of `package.json`, plus `package-lock.json`). New `src/chat/agent.ts` (`createAgentChatBackend(options: AgentChatOptions): AgentChatBackend`, `AgentChatOptions = { chat, cwd, mcpUrl: () => string, query?, now?, baseEnv?, log? }`, `AgentChatBackend extends ChatBackend { close(): void }`), `src/chat/prompt.ts` (system prompt with date/tz), `src/chat/status.ts` (tool_use → caption, allow-list), `src/chat/env.ts` (claude/glm child env, strips key/base-url/model overrides and every parent-session marker: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_*`), plus four unit test files under `tests/unit/` against a fake `query`. `src/daemon.ts`, edited from Phase 1's exact text: builds the real backend from `config.chat` when no `chat` option is passed, `cwd = join(dataDir, CHAT_SUBDIR)`, MCP url `http://127.0.0.1:<bound port>/mcp` read lazily, `agent.close()` on stop. `tests/integration/daemon.int.test.ts`: the shared daemon gets the stub injected, and the stub-by-default test becomes an agent-by-default start/stop test with no chat post. 12 files.
**Does not touch:** `web/`, deploy/scripts, the contract shape, `package.json` `scripts`.
**Exit criteria:** unit tests cover delta streaming, status mapping, ids passed through, resume, abort (client + supersede + timeout + close), max turns, fallback (pre-text auth/limit error → one GLM retry; post-text error → no retry; `CHAT_BRAIN=glm` → GLM only, no fallback), and session-marker stripping. No integration test spawns `claude`. `npm run build` succeeds.

### Phase 3 — Panel
**Satisfies:** R2, R3, R4
**Owns:** `web/src/hooks/useChat.ts` (state gains `status: string` and `brain: string | null`; `status` events set/clear it; `done` stores brain; `close()` clears `threadId.current`; a new `ask` clears status/brain), `web/src/components/AnswerPanel.tsx` (one `<span className="answer-status">` after `.answer-q`: the status while `!done`, else the brain), `web/src/styles.css` (`.answer-status` = the `.answer-q` caption style), `web/src/App.tsx` (two prop lines passing `status`/`brain` to `AnswerPanel`, its only caller; required or typecheck fails), `web/src/App.test.tsx` (one caption test), new `web/src/hooks/useChat.test.tsx`. 6 files.
**Does not touch:** the server.
**Exit criteria:** a fake SSE stream with `status` + `done{brain}` renders caption then label; dismiss → the next post has no `thread_id`; pinned + a second ask → same `thread_id`.

### Phase 4 — Daemon fit
**Satisfies:** R1, R5, R6
**Owns:** `deploy/notesd.service` (`Environment="NOTESD_CLAUDE_BIN=@CLAUDE_BIN@"`, `Environment="HOME=@HOME_DIR@"`), `scripts/install.sh` (renders `@CLAUDE_BIN@` as the resolved absolute real path, warns when `~/.claude/.credentials.json` or `.env.local`/`LLM_*` is missing, adds a chat smoke check to `verify`: `POST /api/chat` must end in `event: done`), `vitest.config.ts` + `package.json` `test:live` (only the `scripts` block, quoted as Phase 2 leaves it; `CHAT_LIVE_TEST=1` switches the include to `tests/live/**/*.live.test.ts`, excluded otherwise), `tests/live/chat.live.test.ts` (one real Claude message, one real GLM message, notes-only, via `createAgentChatBackend({ chat, cwd: join(dataDir, CHAT_SUBDIR), mcpUrl: () => url })` against an in-process daemon on port 0 with the stub injected; config from `loadConfig`, so a full `chat` block), `docs/INSTALL.md`. Before installing it links `.env.local` into the worktree idempotently (`[ -f .env.local ] || ln -sfn ~/mcp-notes/.env.local .env.local`; gitignored at `.gitignore:1`). 6 files. Runs `scripts/install.sh` from the worktree, then each acceptance prompt against `http://127.0.0.1:7317/api/chat` and records the outcome in the phase report. **Afterwards it re-runs install.sh from `~/mcp-notes`** only after landing, per install.sh's own worktree warning. The orchestrator's landing step handles that, and phase 4 states it in its report.
**Does not touch:** backend logic (bugs found get fixed in the backend files with a note in the report).
**Exit criteria:** the installed daemon answers each acceptance prompt for real, and the live suite passes.

## Reconciliation Log

| # | Conflict | Class | Phases | Resolution |
|---|---|---|---|---|
| 1 | Phase 2 replaced `src/daemon.ts` wholesale against a guessed post-phase-1 text: it dropped `CHAT_SUBDIR` and its doc, rewrote the `StartDaemonOptions` doc, used the literal `'chat'` for the cwd | File collision / later phase quotes pre-change state | 1 → 2 | Phase 2 Step 6 rewritten as four edits (6a–6d) that quote Phase 1 Step 6's exact lines as "before". `CHAT_SUBDIR` stays; cwd is `join(config.dataDir, CHAT_SUBDIR)`. A full resulting `startDaemon` is shown for reading |
| 2 | Phase 1's `daemon.int.test.ts` posts to `/api/chat` on a daemon started without `chat` ("serves the stub chat backend when none is injected"); Phase 2 makes that default the real agent, and Phase 2 claimed the file "never posts to /api/chat" | Broken-build phase (test would spawn real `claude`) / contract drift | 1 → 2 | Phase 2 owns it: new Step 6e with code. Shared `beforeAll` daemon gets `createStubChatBackend({ delayMs: 0 })`; the test becomes "serves an injected stub over real HTTP"; a new test starts/stops a daemon on the default agent backend with no post. Phase 2's Requires, Files, Verification, Exit criteria and Rollback updated; Phase 1's handoff points at Step 6e |
| 3 | Phase 2 adds `alwaysLoad: true` to the notes MCP server config, absent from the index isolation row | Contract drift (index vs plan code) | 2 | Folded into Decisions "SDK isolation" row; Phase 2 design note updated to say so |
| 4 | Phase 4's live test called `createAgentChatBackend` with `{ chat, mcpUrl: string, cwd, dataDir }` and `await`, never closed it | Unmet assumption / contract drift | 2 → 4 | Live test now passes exactly `{ chat, cwd: join(dataDir, CHAT_SUBDIR), mcpUrl: () => mcpUrl }`, calls it synchronously, and `backend.close()` in `finally`. Phase 4 Requires states Phase 2's `AgentChatOptions` verbatim |
| 5 | Phase 4 asked Phase 2 to drop `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` from the child env, and worked around it in the live test by deleting `CLAUDECODE` from `process.env` | Gap (handoff with no owner) + duplicate work | 2, 4 | Phase 2 `src/chat/env.ts` owns it: `STRIPPED_ENV_KEYS` gains `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`; new `STRIPPED_ENV_PREFIX = 'CLAUDE_CODE_'` drops every `CLAUDE_CODE_*` key; `CLAUDE_CONFIG_DIR` kept. New unit test in `chat-env.test.ts`. Phase 4's `process.env.CLAUDECODE` workaround removed |
| 6 | Phase 3 edits `web/src/App.tsx`, not in its index Owns | Scope record | 3 | Recorded in Phase 3 Owns (two prop lines; `AnswerPanel`'s only caller, required for typecheck). No other phase touches `web/` |
| 7 | Phase 1 makes `Config.chat` required; every hand-built `Config` must carry it | Unmet assumption check | 1, 2, 4 | Verified: the 5 literals found by `grep -rn "host: '127.0.0.1'" tests src` (api-harness, imageHarness, daemon.int, images.int, mcp.tools.int) are all patched in Phase 1; Phase 2's unit test builds a full `AgentChatConfig` literal (all five fields); Phase 4's live test uses `loadConfig(...)`. Nothing to change |
| 8 | Phase 4 needs `.env.local` in the worktree | Idempotency check | 4 | Confirmed gitignored (`.gitignore:1`, `git check-ignore` hits). Step 7 changed from `[ -e ] \|\| ln -s` (fails on a dangling link) to `[ -f .env.local ] \|\| ln -sfn …` plus a `git check-ignore -q .env.local` assertion |
| 9 | `package.json` touched by Phase 2 (`dependencies`) and Phase 4 (`scripts`) | File collision | 2 → 4 | Disjoint blocks. Phase 4 Step 4 now says it quotes the scripts block as Phase 2 leaves it (unchanged) and must leave Phase 2's `dependencies` alone; Files table updated |
| 10 | Index said `pathToClaudeCodeExecutable: config.chat.claudeBin`; Phase 2 passes `resolveExecutable(config.chat.claudeBin, PATH)`; Phase 4 Requires repeated the index | Contract drift | 2, 4 | Decided for Phase 2's code (see Decisions). Index row and Phase 4 Requires updated |
| 11 | Index "When thread id is known" cited `system/init`; Phase 2 takes the id from the successful attempt's `result.session_id` | Contract drift (rationale only) | 2 | Decisions row updated to Phase 2's source; the end-of-turn rule is unchanged |
| 12 | Index phase table had estimated file counts (~9/~8/~5/~6) and narrow packages | Stale draft | all | Counts set from the plans' Files tables: 15 / 12 / 6 / 6 |

Standard checks after the edits: no symbol is deleted by any phase (Phase 1 deletes only the `ChatTurn.threadId`/`deltas` fields and retires every reader in the same phase; `grep -rn "deltas\|turn.threadId" src tests` is its gate). Dependencies point backward only (1 → —, 2 → 1, 3 → 1, 4 → 2, 3). Every Impact Point 1–10 and Reference List entry has an owner (`src/main.ts`, `src/http/app.ts` caller sites, `scripts/test-int.sh` need no change). Every phase builds green alone: Phase 1 patches all `Config` literals and stub callers in-phase; Phase 2 fixes the one test its default change would break; Phase 3 updates `AnswerPanel`'s only caller; Phase 4's live file typechecks against Phase 2's real signature.

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Base ref: origin/main vs HEAD | `HEAD` (d60a707): main is one commit ahead with the brief | /analyze Step 4 rule |
| When thread id / brain are known | end of turn: `ChatTurn.end()` → `done`. The id is the `session_id` of the successful attempt's `result` message (every `result` carries it; a GLM retry can change it) | analysis: SDK dataflow; source per Phase 2 code block |
| Fallback window | retry on GLM only if no `delta` was emitted yet and the failure is auth/limit (`authentication_failed`, `oauth_org_not_allowed`, `billing_error`, `rate_limit`, or an error result whose text names a usage limit / auth). Never after text streamed; never when `CHAT_BRAIN=glm` | user input R3 + no duplicate output |
| GLM retry thread | the retry resumes the same `resume` id if the request had one; its session id becomes `thread_id` | user input R2/R3 |
| Brain label visibility | shown whenever `done.brain` is present (claude or glm). The stub sends none, so no label | user input R3 ("says which brain answered") |
| SDK run cwd | fixed `<dataDir>/chat` (created with the data subdirs), so sessions land in one `~/.claude/projects/<slug>` and resume survives restarts | user input R2 |
| SDK isolation | `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {notes: {type:'http', url, alwaysLoad: true}}` (`alwaysLoad` because `tools` leaves ToolSearch out of the base set, so deferred MCP tools would be unreachable), `tools: ['WebSearch','WebFetch']`, `allowedTools: [13 × mcp__notes__<name>, 'WebSearch', 'WebFetch']`, `permissionMode: 'dontAsk'`, `includePartialMessages: true`, `pathToClaudeCodeExecutable: resolveExecutable(config.chat.claudeBin, PATH)` | invariant 4; `alwaysLoad` and `resolveExecutable` from Phase 2 code blocks |
| Supersede ("user sends a new message") | backend keeps one in-flight run; a new `reply()` aborts the previous one (single user), in addition to client-disconnect abort | user input R1 |
| Streamed text between turns | only top-level (`parent_tool_use_id == null`) `text_delta`s stream. When a new assistant message's text starts after a tool call and text was already emitted, insert `"\n\n"` first (the panel splits paragraphs on blank lines) | panel convention (`AnswerPanel` splits on `\n\n`) |
| Status captions | from top-level `assistant` `tool_use` blocks: search/list/tags → `searching notes`; get → `reading N notes` (N = ids length; 1 → `reading a note`); view_images → `looking at N photos` (1 → `looking at a photo`); revisions → `reading history`; create/create_image → `saving a note`; update/append/revert → `editing a note`; delete → `deleting a note`; restore → `restoring a note`; WebSearch → `searching the web`; WebFetch → `reading a web page`; `""` when text resumes | user input R4 examples |
| Config names | `CHAT_BRAIN` (claude\|glm, default claude), `CHAT_MAX_TURNS` (default 24), `CHAT_TIMEOUT_MS` (default 180000), `NOTESD_CLAUDE_BIN` (default `claude` on PATH), `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (optional; `CHAT_BRAIN=glm` without them is a `ConfigError`; with claude and no LLM_* the fallback is just disabled). Shape: `config.chat = { brain, maxTurns, timeoutMs, claudeBin, glm: {baseUrl, apiKey, model} \| null }` | surrounding convention (`loadConfig`) |
| GLM model env | `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` all = `LLM_MODEL`, plus `options.model = LLM_MODEL` | user input R3 (swap base url/token, same code) |
| SDK version | `0.3.311` exact (matches CLI 2.1.311; 0.3.314 is <1 day old), peer `@anthropic-ai/sdk` `0.135.0` exact | surrounding convention (exact pins in package.json) |
| Child env: parent-session markers | Drop `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT` and every `CLAUDE_CODE_*` key from both Claude and GLM child envs; keep `CLAUDE_CONFIG_DIR`. Owner: Phase 2 `src/chat/env.ts`. Phase 4 keeps no workaround of its own | invariant 4 (`CLAUDE_CODE_PLUGIN_DIRS` would load plugins) and invariant 3 (`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX` would bypass the login) |
| `DISABLE_AUTOUPDATER=1` in the child env (Phase 4's optional suggestion) | Not set. No requirement asks for it, and the CLI is pinned by the unit's absolute path | index Requirements (nothing asks); rule against inventing behavior |
| Who fixes `daemon.int.test.ts` when the default backend becomes the agent | Phase 2 (Step 6e): inject the stub into the shared daemon; replace the stub-by-default test with an agent-by-default start/stop test that never posts | invariant 1 (green at every phase) + Phase 2 exit criteria (no test spawns `claude`) |
| Live suite's backend options | `{ chat, cwd: join(dataDir, CHAT_SUBDIR), mcpUrl: () => url }`, synchronous construction, `close()` in `finally` | Phase 2 code block (`AgentChatOptions`) |
| Live suite target | in-process daemon on port 0 with the stub injected (only its `/mcp` is used), Docker test DB; the installed daemon is covered by install.sh's chat smoke and the A1–A7 acceptance run | invariant 1 spirit (no test writes to the owner's Neon data); Phase 4 code block |
| `.env.local` in the worktree | `[ -f .env.local ] \|\| ln -sfn ~/mcp-notes/.env.local .env.local`, then `git check-ignore -q .env.local` | surrounding convention (`.gitignore:1`; INSTALL.md worktree note) |

## Open Questions

(none)

## Rollback

Per phase: `git revert` the phase commit. Phase 4 also: re-run `scripts/install.sh` from the previous checkout to restore the old unit. Whole set: do not merge `feature/chat-bar-brain`; the installed daemon is restored by `cd ~/mcp-notes && scripts/install.sh`.

## Next

Phases 2 and 3 can run in parallel once phase 1 lands; phase 4 waits for both. Execute the phases one at a time, starting at phase 1:

    /implement -f docs/plans/CHAT_BAR_BRAIN_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows,
resumable on any machine:

    /analyze-orchestrator -f docs/plans/CHAT_BAR_BRAIN_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan docs/plans/CHAT_BAR_BRAIN_PLAN.md
