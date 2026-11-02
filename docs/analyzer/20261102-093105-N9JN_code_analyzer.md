# Code Analysis: project-session-graph

**Type:** Feature Implementation
**Date:** 2026-11-02 09:31 WIB
**Session ID:** 20261102-093105-N9JN
**Plan:** `docs/plans/PROJECT_SESSION_GRAPH_PLAN.md` (14 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/project-session-graph` on `feature/project-session-graph` (base `origin/main` @ `8c259df`)

---

## User Input

### Original User Request

```
project-session-graph feature
Read the brief at /home/miftah/mcp-notes/docs/iterations/08-project-session-graph.md (written in the parent session; it is untracked on main, so copy it into your worktree and commit it with the plan). The 'Decisions already made' section is settled; do not reopen it. Plan the whole scope as a multi-phase DAG. One phase touches the sibling repo ~/claude-commands (swarm.py spawn_argv adds CC_PARENT_SESSION); plan it as its own phase with its own commit and push in that repo. Parent session id: d5c27d87-c38b-4fb8-83b5-1b1afaa5991f.
```

The brief it points at is the specification and is committed alongside this file, verbatim, at
`docs/iterations/08-project-session-graph.md`. Its "Decisions already made", "Facts measured" and
"Scope" sections are the requirements; they are not repeated here so there is one copy.

### User-Provided Context

- Parent session (where the brief was written): `d5c27d87-c38b-4fb8-83b5-1b1afaa5991f`
  (`custom-title` `session-graph-discussion`). Its transcript is a good real fixture for the
  ingester and the heuristic linker.
- Settled decisions (do not reopen): newest at the top / thick upward trunk; backfill everything at
  landing; resume/spawn without confirm except cross-host; node id `[A-Z0-9]{2}-[A-Z0-9]{2}`
  generated server-side; custom SVG renderer with git-graph lanes, no graph library.

### User-Provided Files
- `docs/iterations/08-project-session-graph.md`

### Requirement IDs

The brief's Scope list is already the split; its numbering is kept.

| ID | What the user asked for |
|---|---|
| R1 | Ingest: daemon background job tails `~/.claude/projects/**/*.jsonl`, upserts one `cc_sessions` row per session (node id, host, resolved repo, cwd, branch, name, titles, first prompt, times, tokens/cost, entrypoint, parent + link source, transcript path), backfills everything on first run, both machines write with their host |
| R2 | Exact parent links going forward: `swarm.py spawn_argv` passes `CC_PARENT_SESSION` (sibling repo `~/claude-commands`, own phase, own commit + push); SessionStart hook posts to the daemon and tells the session its node id and its parent's; Bash PreToolUse hook records pending spawns for non-swarm tmux `claude` launches, claimed by the child within ~30s; `install.sh` registers the hooks (and raises `cleanupPeriodDays`) |
| R3 | Heuristic backfill of parent links from parent transcripts (swarm launch/spawn `--name X`, `SendMessage {to: X}`), matched by name + time window + cwd, marked `heuristic` |
| R4 | Summaries + search: summarize an idle session with Haiku (prompts, commits, files edited, plan docs, final message), redact secrets, embed with the existing embedder, search via the hybrid blend, backfill summaries |
| R5 | Node-id resolution in prompts: `notes-prompt.mjs` adds a node's summary, plan docs, commits and transcript path as context for ANY prompt containing an existing node id, near-zero cost when none matches |
| R6 | MCP + chat agent tools: `sessions_search`, `session_get`, `session_transcript` (owning host only), `session_resume`, plus usage questions (tokens per node / month) |
| R7 | Web: sidebar icon + repo list with the selection persisted server-side; graph view (trunk, lanes, `+N` collapse, pulsing live nodes, node ids, other-host marking, virtualized ~1000 nodes); node detail panel with Tree/Timeline toggle; per-project chat (`project-pill-query-input`, `project` column on chat threads, graph <-> `project-chat-history` toggle) |
| R8 | Resume/spawn from the wall: daemon opens `tmux new-window -c <cwd> "claude --resume <sid> [prompt]"` (or a fresh session with the node as context) in the most recently attached tmux session; same-origin only; focus/message a live node instead; handle a deleted worktree cwd by measurement; confirm only cross-host |
| R9 | Badge: an orch node whose swarm ledger still has pending phases and no live session shows "unfinished" (via `swarm.py verify`) |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** Every Claude Code session on both laptops becomes a row in the
shared Postgres (`cc_sessions`), grouped by repository, linked parent -> child, summarized and
searchable, addressable by a short node id (`A0-3G`) from any prompt, any MCP client and the wall,
and resumable from the wall into a tmux window. The wall gets a per-repo graph page.

**Success Criteria.**
- After the daemon starts on a machine with existing transcripts, every `cli` session on disk has a
  `cc_sessions` row with a node id and a resolved repo; `sdk-ts` / `sdk-cli` sessions have none.
- A session spawned by `swarm.py` after landing has `parent_link_source = 'env'`; a hand-rolled
  `tmux new-window ... claude` gets `hook`; historical swarm children get `heuristic`.
- Typing a node id into any Claude Code prompt injects that node's summary/commits/plan docs.
- `sessions_search("wall editing photo delete")` returns the matching sessions ranked by the blend.
- The wall shows a repo list, a graph of ~1000 nodes that scrolls smoothly, a detail panel, a
  per-project chat, and a resume action that opens a tmux window.
- `npm test`, `npm run typecheck`, `npm run test:int` pass at the end of every phase.

**Key Considerations.**
- Volume: 628 transcripts, ~895 MB on this machine. Backfill must stream files and persist byte
  offsets so restarts and appends are O(new bytes), never a re-read of the corpus.
- Transcripts are append-only JSONL; the last line may be partial while Claude Code is writing.
- Two daemons (Lenovo, GPD) ingest their own `~/.claude` into one DB. A session id is a UUID and
  globally unique; `host` says where the transcript lives. Transcript reads, resume and
  `session_transcript` work only on the owning host (`not_on_this_machine`, same as images/files).
- Worktree sessions live in project dirs like `-home-miftah--worktrees-mcp-notes-wall-editing`;
  the worktree is usually deleted, so repo resolution must work from the path convention
  `~/.worktrees/<repo>/<slug>` alone, falling back to the `cwd` git toplevel, then the cwd basename.
- `CLAUDE_CODE_SESSION_ID` is set in a session's tool environment (verified in this session), so a
  Bash PreToolUse hook and `swarm.py` can read the caller's id directly.
- The summarizer must never block ingest, and must not run on the wall-chat SDK sessions.
- Node ids share the `[0-9A-Z]` alphabet with note ids but have a different shape (2-2 vs 1-3),
  so the existing note-id linkify (`note-links` mod, `web/src/lib/links.ts`) does not collide.

**Assumptions (stated, planned against).**
- Haiku is reached the same way the chat brain reaches Claude: the Agent SDK `query()` with
  `model: 'haiku'`, no tools, one turn, using `config.chat.claudeBin`. No new API key.
- `host` is `os.hostname()`, as for images and files.
- "Live" = present in `~/.claude/sessions/<pid>.json` with a live pid on this host.

---

## Analysis Scope

### Explicitly Mentioned Files
- `docs/iterations/08-project-session-graph.md`
- `~/claude-commands/skills/swarm/swarm.py` (`spawn_argv`)

### Discovered Related Files
- `src/db/schema.ts`, `drizzle/0000..0006*.sql`, `drizzle/meta/_journal.json` — schema; next migration is `0007`
- `src/deps.ts`, `src/daemon.ts`, `src/background.ts`, `src/main.ts` — wiring and background jobs
- `src/config.ts` — env parsing (`loadConfig`), `DEFAULT_CHAT_CONFIG`, `REPO_ROOT`
- `src/notes/ids.ts` — note id generation, the model for node ids
- `src/notes/events.ts`, `src/notes/service.ts` — event bus and the single-writer pattern
- `src/embeddings/embedder.ts`, `src/embeddings/worker.ts`, `src/embeddings/backfill.ts` — embedder interface, debounced worker + sweep
- `src/search/blend.ts`, `src/search/queryVector.ts` — hybrid weights, query vector cache, fallback text
- `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/instructions.ts` — MCP registration and instructions
- `src/chat/agent.ts`, `src/chat/status.ts` (`allowedChatTools`), `src/chat/service.ts`, `src/chat/repo.ts` — chat brain and chat threads
- `src/http/app.ts`, `src/http/api.ts`, `src/http/chatApi.ts`, `src/http/sameOrigin.ts`, `src/http/reveal.ts`, `src/http/capture.ts` — route mounting, same-origin guard, existing spawn-a-process route (reveal)
- `claude/hooks/notes-prompt.mjs`, `claude/hooks/lib/state.mjs`, `claude/hooks/lib/transcript.mjs` — UserPromptSubmit hook, daemon URL/state dir helpers, transcript parser
- `scripts/claude-hooks.mjs` (`ourGroups`, `mergeHooks`, `OUR_SCRIPT`), `scripts/install.sh`, `scripts/uninstall.sh`
- `web/src/App.tsx`, `web/src/components/Rail.tsx`, `Sidebar.tsx`, `ChatBar.tsx`, `web/src/pages/HistoryPage.tsx`, `web/src/lib/route.ts`, `web/src/lib/remote.ts`, `web/src/types.ts`, `web/src/api.ts`, `web/src/chatHistoryApi.ts`
- `tests/unit/hooks/*`, `tests/unit/scripts/claudeHooks.test.ts`, `tests/integration/*` harnesses

---

## Current Dataflow

### Entry Point: daemon start

**Location:** `src/main.ts:5` -> `startDaemon` `src/daemon.ts:78`
**Chain:** `loadConfig` -> `ensureDataDirs` -> embedders -> `createDb` -> `NoteEvents` -> `NotesService`
-> `ChatService` -> `AppDeps` -> `createApp(deps, {chat})` -> `serve` on 127.0.0.1 -> `startBackground(deps)`
(`src/background.ts:23`) which starts the inbox watcher, the note embedding worker and the image
embedding worker, and returns one `StopBackground` closing them in parallel.

`AppDeps` (`src/deps.ts:10`): `config, db, events, service, embedder|null, imageEmbedder|null, chat`.
New background work is added inside `startBackground` and closed in its returned function.

### Entry Point: HTTP

`createApp` (`src/http/app.ts:76`) mounts `/health`, `/mcp` (loopback-only), then routers that each
return a `Hono`: `apiRoutes`, `chatHistoryRoutes`, `imageRoutes`, `chatImageRoutes`, `fileRoutes`,
`revealRoutes`, `captureRoutes`, `staticRoutes` (last, SPA fallback; reserves `/api`).
Guards: `sameOriginOnly` (`src/http/sameOrigin.ts:33`) for wall-only mutating routes (purge,
reveal); `captureRoutes` is loopback + `X-Notes-Capture` header for hooks.

### Entry Point: MCP

`POST /mcp` -> `handleMcpRequest(req, mcpToolDeps(deps))`; `createMcpServer` (`src/mcp/server.ts:12`)
registers note tools (`registerNoteTools`, `src/mcp/tools.ts:163`), image tools, similar tools and
connector tools. The chat agent reaches the same tools over the daemon's own `/mcp`, filtered by
`allowedChatTools()` (`src/chat/status.ts:57`): `NOTES_TOOL_NAMES` + connector names + web tools. A
new MCP tool is invisible to the chat brain until it is added to that list.

### Entry Point: Claude Code hooks

`scripts/claude-hooks.mjs` `ourGroups()` (`:67`) defines three groups (Stop -> `notes-capture.mjs`
async, PreToolUse matcher `mcp__notes__(...)` -> `notes-paste.mjs`, UserPromptSubmit ->
`notes-prompt.mjs`); `mergeHooks` strips ours (by `OUR_SCRIPT` regex `notes-(capture|paste|prompt)\.mjs`)
and re-appends. `install.sh` calls it with the node binary and hooks dir.
`notes-prompt.mjs` `runPrompt` (`:282`) returns null at once for any non-`/n` prompt (no I/O),
which is the cost model R5 must preserve. Hooks share `lib/state.mjs` (`daemonBaseUrl`, `stateDir`,
`writeLog`, `readStdin`, `isMainModule`), always exit 0 and log to
`${XDG_STATE_HOME:-~/.local/state}/notes-capture/*.log`.

### Entry Point: swarm spawn (sibling repo)

`~/claude-commands/skills/swarm/swarm.py:596` `spawn_argv(name, cwd, prompt, permission_mode,
model, keep_open, environ, slug, phase, coordinator)` builds
`tmux new-window -d -n NAME -c CWD [thread caps -e] [identity -e] -P -F ... "claude -n NAME ..."`.
Callers: `cmd_spawn` (`:895`) and `cmd_launch` (`:1790`). `-e` pairs are the established way to
carry env into a tmux child (`thread_cap_env`, `identity_env`). Self-tests are inline
(`swarm.py selftest`, `:1851`; spawn_argv assertions at `:1976-2005`).

### Data on disk (measured 2026-11-02, this machine)

- `~/.claude/projects/<dir>/<uuid>.jsonl`: 628 files, ~895 MB, 166 project dirs (126 contain
  `worktrees`). Record types by count: `assistant`, `attachment`, `user`, `last-prompt`,
  `atis-latch`, `mode`, `permission-mode`, `custom-title`, `agent-name`, `queue-operation`,
  `api-request*`, `system`, `file-history-*`, `ai-title`, `cost-state`, `tools-used`, `frame-link`.
- Entry points in a 200-file sample: `cli` 39 810 records, `sdk-cli` 510, `sdk-ts` 425.
- Shapes: `{"type":"custom-title","customTitle":...,"sessionId":...}`, `agent-name.agentName`,
  `ai-title.aiTitle`, `last-prompt.lastPrompt`, `cost-state.{totalCostUSD,totalDuration,startTime,
  modelUsage:{<model>:{inputTokens,outputTokens,...}}}`. Assistant records carry `message.usage`.
- `~/.claude/sessions/<pid>.json`: `{pid, sessionId, cwd, startedAt, version, kind, entrypoint,
  status, updatedAt, ...}`; `tmux`, `name`, `nameSource`, `messagingSocketPath` when present.
- `CLAUDE_CODE_SESSION_ID` is in the tool env of a session.

### Data Persistence (today)

Postgres via Drizzle (`src/db/schema.ts`): `notes`, `note_images`, `note_files`, `note_revisions`,
`note_embeddings` (vector keyed to body sha256), `note_image_embeddings`, `chat_images`,
`chat_threads` (`id, source, brain, external_key, created_at, updated_at`), `chat_messages`,
`chat_message_revisions`, `chat_message_attachments`. Host-bound rows carry `host text`
(`os.hostname()`). Migrations are hand-checked SQL in `drizzle/` with snapshots in `drizzle/meta`.
There is no key/value settings table yet.

### Exit Points
- Web app polls/streams `/api/events` (SSE) and re-fetches; also polls every 60s.

---

## Key Data Structures

### `chatThreads` — `src/db/schema.ts:340`
`id text pk, source ('wall'|'claude_code'), brain, external_key unique, created_at, updated_at`.
R7 adds a nullable `project text` (repo key) to scope threads to a project.

### `AppDeps` — `src/deps.ts:10` (above).

### `BLEND` — `src/search/blend.ts:37`
Single home of hybrid weights (text, vector, tag, recency) and thresholds. Session search reuses
the blend function with its own candidate SQL; it must not fork the weights.

### Note id helpers — `src/notes/ids.ts`
`ID_ALPHABET`, `generateId(random)`, `normalizeId`, `parseId`, `InvalidIdError`. Node ids get a
sibling module with the 2-2 shape and the same injectable-random, retry-on-conflict contract.

---

## Dependencies

- **Env/config:** `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `OPENROUTER_API_KEY` (embedder),
  `NOTES_DATA_DIR`, `NOTESD_CLAUDE_BIN`, `CHAT_*`. New: the Claude home dir (default `~/.claude`),
  the worktree root (default `~/.worktrees`), and the swarm script path (default
  `~/.claude/skills/swarm/swarm.py`) for R9.
- **External:** `tmux` (resume/spawn), `claude` CLI (resume, summarizer via Agent SDK),
  `git` (worktree resolution when the dir still exists), `swarm.py` (R9).

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `startBackground` | `src/background.ts:23` | def (ingest, linker, summarizer wired here) | daemon |
| `AppDeps` | `src/deps.ts:10` | def | daemon |
| `createApp` | `src/http/app.ts:76` | def (route mounting) | http |
| `sameOriginOnly` | `src/http/sameOrigin.ts:33` | def (resume route guard) | http |
| `createMcpServer` | `src/mcp/server.ts:12` | def (tool registration) | mcp |
| `allowedChatTools` | `src/chat/status.ts:57` | def (chat brain tool allowlist) | chat |
| `chatThreads` | `src/db/schema.ts:340` | def (+ `project`) | db |
| `generateId` | `src/notes/ids.ts:20` | model for node ids | notes |
| `BLEND` | `src/search/blend.ts:37` | def | search |
| `Embedder` | `src/embeddings/embedder.ts:13` | def | embeddings |
| `runPrompt` | `claude/hooks/notes-prompt.mjs:282` | def (R5) | hooks |
| `ourGroups` / `OUR_SCRIPT` | `scripts/claude-hooks.mjs:67,22` | def (new hook groups) | scripts |
| `spawn_argv` | `~/claude-commands/skills/swarm/swarm.py:596` | def (R2) | claude-commands |
| `Rail` | `web/src/components/Rail.tsx:27` | def (new icon) | web |
| `routeFromLocation` | `web/src/lib/route.ts:16` | def (new `/projects` route) | web |

---

## Impact Points (files that WILL need changes)

1. `src/db/schema.ts`, `drizzle/0007_*.sql`, `drizzle/meta/*` — `cc_sessions`, `cc_session_embeddings`, `cc_pending_spawns`, `app_settings`, `chat_threads.project` (phase 1)
2. `src/sessions/ids.ts`, `src/sessions/repo.ts`, `src/sessions/types.ts` — node ids and the single writer of session rows (phase 1)
3. `~/claude-commands/skills/swarm/swarm.py` — `CC_PARENT_SESSION` in `spawn_argv` (phase 2)
4. `src/sessions/transcript.ts`, `repoResolve.ts`, `registry.ts`, `ingest.ts`, `src/config.ts`, `src/background.ts` — ingest + backfill + live registry (phase 3)
5. `src/sessions/links.ts`, `src/sessions/ingest.ts` — heuristic linker (phase 4)
6. `claude/hooks/notes-session.mjs`, `claude/hooks/notes-spawn.mjs`, `src/http/sessionHooks.ts`, `src/http/app.ts`, `scripts/claude-hooks.mjs`, `scripts/install.sh`, `scripts/uninstall.sh` — exact links (phase 5)
7. `src/sessions/summarize.ts`, `redact.ts`, `embed.ts`, `search.ts`, `src/background.ts` — summaries + embeddings + search (phase 6)
8. `src/http/sessionsApi.ts`, `src/mcp/sessionTools.ts`, `src/mcp/server.ts`, `src/chat/status.ts`, `src/mcp/instructions.ts`, `src/http/app.ts` — read API, settings, MCP/chat tools, usage (phase 7)
9. `claude/hooks/notes-prompt.mjs` — node-id context (phase 8)
10. `src/sessions/resume.ts`, `src/http/sessionResume.ts`, `src/mcp/sessionTools.ts`, `src/http/app.ts` — resume/spawn (phase 9)
11. `web/src/components/Rail.tsx`, `web/src/App.tsx`, `web/src/lib/route.ts`, `web/src/pages/ProjectsPage.tsx`, `web/src/components/graph/*`, `web/src/lib/sessionGraph.ts`, `web/src/sessionsApi.ts`, `web/src/types.ts` — repo list + graph (phase 10)
12. `web/src/components/graph/NodePanel.tsx`, `Timeline.tsx` — detail panel + resume button (phase 11)
13. `src/chat/*`, `src/http/api.ts`, `src/http/chatApi.ts`, `web/src/components/ChatBar.tsx`, `web/src/pages/ProjectsPage.tsx` — per-project chat (phase 12)
14. `src/sessions/unfinished.ts`, `src/http/sessionsApi.ts`, `web/src/components/graph/GraphNode.tsx` — unfinished badge (phase 13)
15. `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/ROADMAP.md` — docs (phase 14)

**This document describes. The plan files prescribe.**
