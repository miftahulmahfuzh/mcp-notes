# Plan: Project session graph

**Slug:** project-session-graph
**Date:** 2026-11-02 09:31 WIB
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Brief:** `docs/iterations/08-project-session-graph.md` (the specification; committed with this plan)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/project-session-graph`
**Branch:** `feature/project-session-graph` (base: `origin/main` @ `8c259df`)
**Phases:** 14
**Status:** phase 1/14 complete (1)
**Coordinator:** —

---

## Why

Verbatim from the invocation:

> project-session-graph feature
> Read the brief at /home/miftah/mcp-notes/docs/iterations/08-project-session-graph.md (written in the parent session; it is untracked on main, so copy it into your worktree and commit it with the plan). The 'Decisions already made' section is settled; do not reopen it. Plan the whole scope as a multi-phase DAG. One phase touches the sibling repo ~/claude-commands (swarm.py spawn_argv adds CC_PARENT_SESSION); plan it as its own phase with its own commit and push in that repo. Parent session id: d5c27d87-c38b-4fb8-83b5-1b1afaa5991f.

And from the brief: "A per-repo graph of every Claude Code session the user has run, in the wall.
Each node is one Claude Code session (not one prompt). The trunk is the sessions the user started
by hand; the sessions those spawned ... hang off them as branches. Nodes have ids the user can
quote anywhere, a summary, and a resume action."

Settled, never reopened by any phase: newest at the top (thick trunk growing upward); backfill
everything on disk at landing; resume/spawn with no confirm click except a node whose transcript
is on the other machine; node id `[A-Z0-9]{2}-[A-Z0-9]{2}` generated server-side, resolving only
ids that exist; custom SVG renderer, git-graph lanes on a time axis, no graph library.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Ingest every Claude Code session into `cc_sessions` (incremental tail, backfill, both hosts) | 1, 3 |
| R2 | Exact parent links: `CC_PARENT_SESSION` from swarm.py, SessionStart hook, Bash PreToolUse pending spawns, install.sh registration | 2, 5 |
| R3 | Heuristic parent-link backfill from parent transcripts, marked `heuristic` | 4 |
| R4 | Haiku summaries of idle sessions, redacted, embedded, hybrid-searchable, backfilled | 6 |
| R5 | Node ids in any Claude Code prompt resolve to that node's context, near-zero cost otherwise | 8 |
| R6 | MCP + chat agent tools: `sessions_search`, `session_get`, `session_transcript`, `session_resume`, usage | 7, 9 |
| R7 | Web: repo sidebar (selection persisted server-side), graph view, node detail panel with Tree/Timeline, per-project chat | 10, 11, 12 |
| R8 | Resume/spawn from the wall into tmux; focus/message a live node; deleted-cwd handling measured; confirm only cross-host | 9, 11 |
| R9 | "unfinished" badge on orch nodes with pending ledger phases and no live session | 13 |

Phase 1 also lands the `chat_threads.project` column and the `app_settings` table that R7 needs,
so all schema change is one migration. That coupling (R1 phase carrying R7 schema) is deliberate:
one migration, one snapshot, no two phases racing on `drizzle/meta`.

## Scope

**In scope:** everything in the brief's Scope 1-9, both repos (`mcp-notes`, `~/claude-commands`).
**Out of scope:** daily digest note, fork-session UI (brief: keep the data model ready, which the
`parent_session_id` + `parent_link_source` columns already do); subagent (`Task`/`Agent` tool)
sidechains as nodes — a node is a Claude Code session, and sidechain records inside one transcript
belong to that session.

## Invariants

1. The tree builds, `npm run typecheck`, `npm test` and `npm run test:int` pass at the end of every phase.
2. `npm test` / `test:int` never touch the network or the real `~/.claude`: every path (Claude
   home, worktree root, swarm script, tmux, claude bin) is injectable, and tests use temp dirs and fakes.
3. One writer: `src/sessions/repo.ts` (`SessionsRepo`) is the only code that writes `cc_sessions`,
   `cc_session_embeddings` and `cc_pending_spawns`. Routes, hooks endpoints, ingester, linker,
   summarizer go through it.
4. Ingest never re-reads a whole transcript it has already read: it resumes from the stored byte
   offset, and treats a trailing partial line as not yet written.
5. A field written by a better source is never overwritten by a worse one: parent link precedence is
   `env` > `hook` > `heuristic`; a hook-reported name/tmux never gets clobbered by a null from the transcript.
6. Background session work (ingest, linking, summaries, embeddings) never blocks or fails a note
   write, the HTTP server, or daemon shutdown (each closes within 5 s like the embedding workers).
7. Anything bound to a transcript on another host reports `available: false` / 404 `not_on_this_machine`.
8. Hooks always exit 0, print only hook JSON on stdout, log to the existing state dir, and a hook
   that finds nothing to do does no I/O beyond reading stdin (and, for R5, a regex test).
9. Node ids are generated only in `src/sessions/ids.ts`; nothing invents one.
10. No graph library in `web/` (settled decision).

## Interface contracts (reconciled: the owning phase's plan is the source of truth)

- **Schema (phase 1, migration `drizzle/0007_cc_sessions.sql`):**
  - `cc_sessions`: `session_id text pk` (Claude Code UUID), `node_id text unique not null`
    (check `^[0-9A-Z]{2}-[0-9A-Z]{2}$`), `host text not null`, `repo`, `cwd`, `branch`, `name`,
    `custom_title`, `ai_title`, `first_prompt`, `last_prompt`, `entrypoint`, `version`,
    `started_at`, `last_active_at`, `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens`
    `bigint not null default 0`, `cost_usd numeric` (read as number), `models jsonb not null default '{}'`,
    `parent_session_id text` (no FK), `parent_link_source text check in ('env','hook','heuristic')`
    (both null or both set), `tmux`, `transcript_path`, `transcript_offset bigint not null default 0`,
    `transcript_size`, `prompts jsonb` (`{text, at}[]`), `commits jsonb` (`{sha, subject, at}[]`),
    `files_edited jsonb` (`string[]`), `plan_docs jsonb` (`string[]`) (all `not null default '[]'`),
    `final_message`, `summary`, `summary_sha`, `summarized_at`, `created_at`, `updated_at`;
    generated `search_tsv tsvector` (`simple`, GIN `cc_sessions_search_gin`) over node_id, repo,
    name, titles, first/last prompt, prompt texts, summary. Indexes incl. `(repo, started_at desc)`,
    `parent_session_id`, `host`, `name`, `cc_sessions_last_active_idx`.
  - `cc_session_embeddings`: `session_id pk fk`, `sha`, `model`, `embedding vector(1536) null`,
    `attempts`, `last_error`, `next_attempt_at`, `embedded_at` (refreshed on every save), `created_at`, `updated_at`.
  - `cc_pending_spawns`: `id bigserial`, `parent_session_id`, `cwd`, `name`, `host`, `created_at`, `claimed_by`, `claimed_at`.
  - `app_settings`: `key text pk`, `value jsonb`, `updated_at`. Key `projects.selected` holds a bare
    JSON string (the repo); `null` deletes the key.
  - `chat_threads.project text null` + `chat_threads_project_updated_idx (project, updated_at)`.
  - `tests/integration/setup.ts` `truncateAll` truncates the four new tables (phase 1); later phases call it.
- **Node ids (phase 1, `src/sessions/ids.ts`):** `NODE_ID_PATTERN = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/`;
  `generateNodeId(random?)` never returns an all-digit id; `normalizeNodeId(input)` (case-insensitive,
  dash optional, null for non-ids) for lookups; `NODE_ID_CANDIDATE_SOURCE` + `findNodeIdCandidates(text)`
  implement the one free-text rule (upper case as typed, dash required, whole token, at least one
  letter, at most `MAX_NODE_ID_CANDIDATES = 5`). Phase 8's hook copies the source verbatim
  (`NODE_ID_CANDIDATE.source === NODE_ID_CANDIDATE_SOURCE`, asserted by a test).
- **Repo (phase 1):** `new SessionsRepo(db, opts?)` (`{random?, now?}`) in `src/sessions/repo.ts`, the
  only writer of the `cc_*` tables and `app_settings`: `ensureSession`, `getBySessionId`, `getByNodeId`,
  `getManyByNodeIds`, `upsertFromTranscript(patch)` (offset compare-and-set), `upsertFromHook(HookStart)
  -> {session, parent, parentLink}` (creates the parent row too), `setParent(child, parent, source)`
  (`env 3 > hook 2 > heuristic 1`), `listChildren`, `listByName`, `listProjects`, `listForRepo`,
  `offsets(host)`, `recordPendingSpawn`, `claimPendingSpawn({childSessionId, host, cwd, name?, at?, windowMs?})
  -> {spawn, parentLink} | null` (sets the parent as `hook` itself), `prunePendingSpawns(before)`,
  `setSummary(sessionId, {summary, sha, at?})`, `saveEmbedding(sessionId, {sha, model, embedding})`,
  `recordEmbeddingFailure`, `getSetting`/`putSetting`, `getSelectedProject`/`setSelectedProject`.
  Types and constants (`PENDING_SPAWN_WINDOW_MS = 30_000`, `SELECTED_PROJECT_KEY`, caps) in `src/sessions/types.ts`.
- **Config (phase 3, `src/config.ts`):** required `Config.sessions: SessionsConfig = { claudeHome,
  worktreesDir, enabled }` from `CLAUDE_HOME` (`~/.claude`), `NOTES_WORKTREES_DIR` (`~/.worktrees`),
  `NOTESD_SESSIONS` (default on); `DEFAULT_SESSIONS_CONFIG` has `enabled: false` and every test
  `Config` literal uses it. Phase 13 adds `swarmScript: string | null` (`NOTESD_SWARM_SCRIPT`, default
  `<claudeHome>/skills/swarm/swarm.py`; `null` in `DEFAULT_SESSIONS_CONFIG`).
- **Ingest + registry (phase 3):** `startSessionIngest({claudeHome, worktreesDir, store, hostname?,
  observers?: IngestObserver[], ...})`; `IngestObserver { onBatch?(IngestBatch), onPassComplete?(IngestPass) }`;
  `readLiveSessions(claudeHome, isAlive?) -> LiveSession[]` with `sessionId, pid, cwd, status, tmux,
  name, nameSource, entrypoint, version, startedAt, updatedAt, messagingSocketPath`.
- **Background (phases 3, 4, 6, `src/background.ts`):** `startBackground(deps, options: BackgroundOptions = {})`
  with `BackgroundOptions.sessionSummarizer?: Summarizer | null` (phase 6). Omitted = summaries off;
  only `src/daemon.ts` builds the Agent SDK summarizer and passes it (phase 6).
- **Summaries + search (phase 6):** `searchSessions(deps: {db, embedder, host?}, query, filter?: {repo?,
  host?, from?, to?, limit?, cursor?}, opts?) -> {sessions: SessionSearchHit[] (snake_case, incl. score),
  next_cursor, mode, fallback?}`; `Summarizer`, `createAgentSummarizer`; idle = 15 min.
- **Hook endpoints (phase 5):** `POST /api/sessions/hook/start`, `POST /api/sessions/hook/spawn`
  (loopback + `X-Notes-Capture: 1`, `captureGuard`); the spawn route prunes pending spawns older than 24 h.
- **Read API (phase 7, `src/http/sessionsApi.ts`, `src/sessions/{readModel,view,transcriptSearch}.ts`):**
  `GET /api/projects` -> `{host, selected, projects: [{repo, sessions, live, last_active_at, first_started_at, hosts}]}`;
  `GET/PUT /api/projects/selected` `{repo}` (PUT same-origin); `GET /api/projects/:repo/sessions?limit&before`
  -> `GraphPayload {repo, host, generated_at, total, truncated, next_before, nodes: GraphNode[]}` with weak
  `ETag` / `304`; `GraphNode` = `session_id, node_id, repo, parent_session_id, parent_node_id,
  parent_link_source, title, name, custom_title, ai_title, first_prompt, branch, cwd, started_at,
  last_active_at, host, available, live, status, tmux, tokens{input,output,cache_read,cache_write,total},
  cost_usd, summary_excerpt, child_count, unfinished`; `GET /api/sessions/:nodeId` -> `{session, prompts,
  commits, files_edited, plan_docs, notes, parent, children}`; `/transcript?query=`;
  `GET /api/sessions/context?ids=` -> `{nodes: [{node_id, session_id, text}], missing, context}`
  (`loopbackReadGuard`, no Origin needed); `/search?q=&repo=&limit=`; `/usage?by=node|month&repo=&month=`.
  **No SSE event for sessions:** the wall polls with `If-None-Match`. MCP tools `sessions_search`
  (with `repo`), `session_get`, `session_transcript`, `sessions_usage`; `SESSION_TOOL_NAMES` in
  `src/chat/status.ts`. `mcpToolDeps(deps, sessionOverrides?)`, `CreateAppOptions.sessions?`.
- **Resume (phase 9):** `POST /api/sessions/:nodeId/resume` `{prompt?, fresh?}` (same-origin) ->
  `{action: focused|messaged|resumed|spawned, window?, cwd?, original_cwd?}` or 404 `not_found` /
  `not_on_this_machine`, 409 `no_tmux` / `live_outside_tmux`, 500 `spawn_failed`. MCP `session_resume`.
  `mcpToolDeps(deps, sessionOverrides?, extra?: {sessionResume?})`, `CreateAppOptions.sessionResume?`;
  env `NOTESD_TMUX_SOCKET`, `NOTESD_TMUX_BIN`. Fresh spawns set `CC_PARENT_SESSION=<node sid>`; resumes scrub it.
- **Web (phase 10):** `/projects?repo=&node=`; `web/src/types.ts` `SessionNode` mirrors `GraphNode`,
  `SessionGraphPayload` mirrors `GraphPayload`, `ProjectsPayload`; `fetchSessionGraph(repo, {signal, etag})
  -> {payload | null (304), etag}`; `GRAPH_POLL_MS = 10_000` while visible. `ProjectsPage` props `repo`,
  `resolving?`, `node`, `onSelectNode`, `renderPanel?(node, close)`, `renderBadge?(node)`; phase 11
  defaults `renderPanel` to `NodePanel`, phase 13 defaults `renderBadge` to the unfinished badge.
- **Unfinished (phase 13):** `SessionsApiOptions extends SessionsReadOverrides { unfinished? }`,
  `CreateAppOptions.unfinished?`; graph nodes annotated before the ETag, detail annotates `detail.session`.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 ✓ | Schema, node ids, SessionsRepo | R1 | `src/db`, `src/sessions` | 14 | — | NORMAL | `.workflows/plan/project-session-graph/phase-1.md` | P1-NOTES-A049 | — |
| 2 | swarm.py passes CC_PARENT_SESSION (~/claude-commands) | R2 | `~/claude-commands/skills/swarm` | 1 | — | EASY | `.workflows/plan/project-session-graph/phase-2.md` | P1-NOTES-A050 | — |
| 3 | Transcript ingest, repo resolution, live registry, backfill | R1 | `src/sessions`, `src/background.ts`, `src/config.ts` | 25 | 1 | HARD | `.workflows/plan/project-session-graph/phase-3.md` | P1-NOTES-A051 | — |
| 4 | Heuristic parent links from transcripts | R3 | `src/sessions` | 5 | 3 | NORMAL | `.workflows/plan/project-session-graph/phase-4.md` | P1-NOTES-A052 | — |
| 5 | SessionStart + Bash spawn hooks, hook endpoints, install | R2 | `claude/hooks`, `src/http`, `scripts` | 14 | 1 | HARD | `.workflows/plan/project-session-graph/phase-5.md` | P1-NOTES-A053 | — |
| 6 | Summaries (Haiku), redaction, embeddings, session search | R4 | `src/sessions`, `src/background.ts`, `src/daemon.ts` | 12 | 4 | HARD | `.workflows/plan/project-session-graph/phase-6.md` | P1-NOTES-A054 | — |
| 7 | Sessions read API, selected project, MCP + chat tools, usage | R6 | `src/http`, `src/mcp`, `src/chat`, `src/sessions` | 17 | 5, 6 | NORMAL | `.workflows/plan/project-session-graph/phase-7.md` | P1-NOTES-A055 | — |
| 8 | Node ids in prompts resolve to context | R5 | `claude/hooks` | 4 | 7 | NORMAL | `.workflows/plan/project-session-graph/phase-8.md` | P1-NOTES-A056 | — |
| 9 | Resume/spawn into tmux, `session_resume` tool | R8, R6 | `src/sessions`, `src/http`, `src/mcp` | 11 | 7 | HARD | `.workflows/plan/project-session-graph/phase-9.md` | P1-NOTES-A057 | — |
| 10 | Web: projects rail icon, repo sidebar, SVG graph | R7 | `web/` | 26 | 7 | HARD | `.workflows/plan/project-session-graph/phase-10.md` | P1-NOTES-A058 | — |
| 11 | Web: node detail panel, Tree/Timeline, resume action | R7, R8 | `web/` | 14 | 9, 10 | NORMAL | `.workflows/plan/project-session-graph/phase-11.md` | P1-NOTES-A059 | — |
| 12 | Per-project chat and project chat history | R7 | `src/chat`, `src/http`, `web/` | 23 | 11 | NORMAL | `.workflows/plan/project-session-graph/phase-12.md` | P1-NOTES-A060 | — |
| 13 | "unfinished" badge for orch nodes | R9 | `src/sessions`, `src/http`, `src/config.ts`, `web/` | 14 | 12 | NORMAL | `.workflows/plan/project-session-graph/phase-13.md` | P1-NOTES-A061 | — |
| 14 | Docs: README, CHANGELOG, CLAUDE.md, ROADMAP | R1-R9 | docs | 4 | 2, 8, 13 | EASY | `.workflows/plan/project-session-graph/phase-14.md` | P1-NOTES-A062 | — |

Edges beyond pure code dependency, stated so nobody removes them: 4 -> 6 (both edit
`src/background.ts`; phase 6 quotes phase 4's closer), 5 -> 7 (both edit `src/http/app.ts`),
7 -> 9 (`app.ts`, `src/mcp/sessionTools.ts`, `src/mcp/tools.ts`, `src/chat/status.ts`,
`tests/unit/chat-status.test.ts`), 9 -> 11 -> 12 -> 13 (13 edits `app.ts` as 9 left it, and
`ProjectsPage.tsx` / `NodePanel.tsx` / `sessionDetailApi.ts` as 10-12 left them), 3 -> ... -> 13
(13 edits `src/config.ts`, `tests/unit/config.test.ts` and `tests/integration/sessions.ingest.int.test.ts`
from phase 3). Phases 2 and 5 run alongside 3/4/6; 8, 9, 10 run concurrently after 7.

Phase 2 changes only `~/claude-commands`: its mcp-notes branch stays empty (no commit). Completion is
recorded in the swarm ledger with `swarm.py report --slug project-session-graph --phase 2 --status done
--note "landed in ~/claude-commands: <sha> ..."` (no `--commit`), as phase 2's Verification says; the
integrator has nothing to merge for it. Only phase 14 depends on it.

### Phase 1 — Schema, node ids, SessionsRepo
**Satisfies:** R1 (carries R7's `chat_threads.project` + `app_settings` schema)
**Owns:** `src/db/schema.ts` additions, `drizzle/0007_cc_sessions.sql` + `drizzle/meta`, `src/sessions/{ids,types,merge,repo}.ts`, `tests/integration/setup.ts` `truncateAll`, unit tests for ids/merge/schema, integration tests for repo + migration.
**Does not touch:** ingest, hooks, HTTP, web, background wiring, `AppDeps`.
**Exit criteria:** migration applies on the test DB; repo upserts are idempotent (replay = `offset_mismatch`), assign node ids (never all digits) with redraw on clash, honour `env > hook > heuristic`, refuse self/cycle links, and claim a pending spawn at most once within the window; `findNodeIdCandidates` implements the shared candidate rule.

### Phase 2 — swarm.py passes CC_PARENT_SESSION
**Satisfies:** R2
**Owns:** `~/claude-commands/skills/swarm/swarm.py` `parent_env` + `spawn_argv` + selftest assertions. Committed and pushed in `~/claude-commands`, deployed with `./sync.sh`.
**Does not touch:** anything in `mcp-notes` (its branch stays empty; completion recorded in the ledger note).
**Exit criteria:** `swarm.py selftest` passes; spawn_argv emits `-e CC_PARENT_SESSION=<id>` when `CLAUDE_CODE_SESSION_ID` is set, nothing when unset; pushed to `origin/main` of claude-commands.

### Phase 3 — Transcript ingest, repo resolution, live registry, backfill
**Satisfies:** R1
**Owns:** `src/sessions/{transcript,repoResolve,registry,ingest}.ts`, `config.sessions` (`SessionsConfig`, `DEFAULT_SESSIONS_CONFIG` off, `parseSessions`), the session-ingest block of `startBackground`, `sessions: DEFAULT_SESSIONS_CONFIG` in every hand-built test `Config`, fixture Claude home and tests.
**Does not touch:** parent links (4/5), summaries (6), HTTP, `swarmScript` (13).
**Exit criteria:** pointing the ingester at a fixture Claude home produces one row per `cli` session with repo resolved (incl. deleted worktree paths), sdk sessions skipped, appended bytes picked up incrementally, restart resumes from offsets; `IngestObserver` published.

### Phase 4 — Heuristic parent links
**Satisfies:** R3
**Owns:** `src/sessions/links.ts` (intents from `swarm.py launch|spawn --name X` and `SendMessage {to: X}`, matching by name + window + cwd/repo, once-per-host backfill marker via `SessionsRepo.getSetting/putSetting`), its observer registration and close in `startBackground`.
**Does not touch:** `src/sessions/ingest.ts` (phase 3's `IngestObserver` is used as published), hooks, HTTP.
**Exit criteria:** fixture where orch session launches a phase child links child -> orch as `heuristic`; an existing `env`/`hook` link is never replaced; backfill runs once per host.

### Phase 5 — SessionStart + Bash spawn hooks, hook endpoints, install
**Satisfies:** R2
**Owns:** `claude/hooks/notes-session.mjs` (cli sessions only), `claude/hooks/notes-spawn.mjs`, `src/http/sessionHooks.ts` + mount in `app.ts` (incl. pending-spawn pruning on the spawn route), `scripts/claude-hooks.mjs` groups + `OUR_SCRIPT`, `install.sh` (register + raise `cleanupPeriodDays` to `NOTES_CLAUDE_RETENTION_DAYS`, default 3650), `uninstall.sh`, `.d.mts` files, tests.
**Does not touch:** ingest internals, notes-prompt.mjs, `src/sessions/*`.
**Exit criteria:** hook unit tests; endpoint int tests (env link, hook claim once within the window, no claim on resume/compact/clear, prune); `claude-hooks.mjs` merge test includes the new groups.

### Phase 6 — Summaries, redaction, embeddings, session search
**Satisfies:** R4
**Owns:** `src/sessions/{redact,summarize,summaryWorker,search}.ts`, the summary block in `startBackground` (`BackgroundOptions.sessionSummarizer`), the summarizer construction in `src/daemon.ts`, `tests/helpers/fakeSummarizer.ts`, tests.
**Does not touch:** HTTP, MCP, web, `ingest.ts`, `src/search/blend.ts`.
**Exit criteria:** fake summarizer + fake embedder: idle session gets summary + vector once (not again after restart); secrets redacted before the model sees them; search returns hybrid-ranked sessions (with `score`) and `fallback` without an embedder; tests never build a real summarizer.

### Phase 7 — Sessions read API, selected project, MCP + chat tools, usage
**Satisfies:** R6
**Owns:** `src/sessions/{view,readModel,transcriptSearch}.ts`, `src/http/sessionsApi.ts` (all read endpoints incl. `/api/sessions/context`), mount in `app.ts`, `mcpToolDeps(deps, sessionOverrides?)`, `ToolDeps.sessions`, `src/mcp/sessionTools.ts` (four read tools), registration in `src/mcp/server.ts`, `SESSION_TOOL_NAMES` in `src/chat/status.ts`, MCP instructions paragraph, tests.
**Does not touch:** resume (9), web, `src/http/api.ts` SSE route, any `cc_*` write.
**Exit criteria:** int tests per endpoint and tool; `session_transcript` returns `not_on_this_machine` for other-host rows; graph ETag/304 works; `allowedChatTools()` has 40 entries.

### Phase 8 — Node ids in prompts resolve to context
**Satisfies:** R5
**Owns:** `claude/hooks/notes-prompt.mjs` (regex fast path copied from `NODE_ID_CANDIDATE_SOURCE`; only on a candidate does it call `/api/sessions/context` and use its `context`), `.d.mts`, unit tests (incl. equality with `src/sessions/ids.ts`), one integration test.
**Does not touch:** server code, `scripts/*`.
**Exit criteria:** a prompt with no candidate does no I/O (test asserts fetch/read not called); an existing node id adds context; a non-existent one adds nothing; `/n` behaviour unchanged.

### Phase 9 — Resume/spawn into tmux, `session_resume`
**Satisfies:** R8, R6
**Owns:** `src/sessions/resume.ts`, `src/http/sessionResume.ts` (same-origin), mount + `sessionResume` wiring in `app.ts` (`mcpToolDeps` third parameter), `ToolDeps.sessionResume`, `session_resume` in `src/mcp/sessionTools.ts`, `'session_resume'` in `SESSION_TOOL_NAMES`, tests.
**Does not touch:** web, `src/mcp/instructions.ts`.
**Exit criteria:** fake tmux runner tests for each branch; cross-host returns `not_on_this_machine`; the deleted-cwd measurement recorded in the plan/test comments; `allowedChatTools()` has 41 entries.

### Phase 10 — Web: projects icon, repo sidebar, SVG graph
**Satisfies:** R7
**Owns:** Rail icon, `/projects` route, `ProjectsPage` with `renderPanel`/`renderBadge` slots, repo list in the expanded sidebar with server-persisted selection, `web/src/lib/sessionGraph.ts`, `web/src/components/graph/{SessionGraph,GraphNode,GraphEdges}`, `web/src/sessionsApi.ts` (ETag polling), wire types mirroring phase 7, fixtures.
**Does not touch:** node panel (11), chat (12), badge content (13), any `src/` file.
**Exit criteria:** layout unit tests (lanes, wave side-by-side, collapse); 1000-node render test mounts only visible nodes; a 304 keeps the nodes; typecheck web.

### Phase 11 — Web: node detail panel, Tree/Timeline, resume action
**Satisfies:** R7, R8
**Owns:** `web/src/sessionDetailApi.ts` (reads phase 7's detail shape), `NodePanel`, `SubtreeTree`, `SubtreeTimeline`, `lib/subtree.ts`, `lib/sessionFormat.ts`, `ConfirmDialog` optional props, the `renderPanel` default in `ProjectsPage`.
**Does not touch:** chat, badge, graph layout.
**Exit criteria:** component tests for panel, toggle, resume with and without cross-host confirm; existing "Delete anyway" tests unchanged.

### Phase 12 — Per-project chat and project chat history
**Satisfies:** R7
**Owns:** `project` on chat threads through `ChatService`/`chatApi`/`POST /api/chat`, the `<project>` context block, `project-pill-query-input`, `project-chat-history`, the graph <-> history toggle in `.proj-bar`, `.graph-scroll` height in `SessionGraph.css`.
**Does not touch:** badge, graph layout, `App.tsx`, `src/http/app.ts`.
**Exit criteria:** threads created from the project view carry `project`; the history view lists only that project's threads; wall chat unchanged.

### Phase 13 — "unfinished" badge
**Satisfies:** R9
**Owns:** `src/sessions/unfinished.ts`, `SessionsConfig.swarmScript`, `SessionsApiOptions.unfinished` + annotation in `sessionsApi.ts`, `CreateAppOptions.unfinished`, `UnfinishedBadge.tsx`, the `renderBadge` default in `ProjectsPage`, `SessionDetail.unfinished` + pill in `NodePanel`, and the `swarmScript` additions to phase 3's config tests and ingest int test literal.
**Does not touch:** anything else in web; `GraphNode.tsx`.
**Exit criteria:** fake swarm runner tests; badge renders only for orch + pending + not live; tests never read the real `~/.claude`.

### Phase 14 — Docs
**Satisfies:** R1-R9
**Owns:** `README.md` (sessions section, HTTP API + MCP tool tables, env vars incl. `NOTESD_SWARM_SCRIPT`, `NOTESD_TMUX_SOCKET`, `NOTESD_TMUX_BIN`, `NOTES_CLAUDE_RETENTION_DAYS`), `CHANGELOG.md`, `CLAUDE.md` architecture bullet, `docs/ROADMAP.md`.
**Exit criteria:** docs match the shipped endpoints, tools and env vars; no `«FILL` marker remains.

## Reconciliation Log

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | Node-id candidate rule: phase 1 allowed lower case with a digit, max 10; phase 8 upper case only, whole token, >= 1 letter, max 5 | Contract drift | Phase 8's rule is canonical. Phase 1's `NODE_ID_CANDIDATE_SOURCE` is phase 8's regex source verbatim, `findNodeIdCandidates` applies it with the letter filter and max 5, tests rewritten; phase 8 asserts source equality and behavioural equality |
| 2 | Phase 8 asked that all-digit ids not be generated | Gap | `generateNodeId` redraws all-digit ids (64 tries); id and repo tests use letter draws |
| 3 | Phase 6 called `setSummary({sessionId, summary, summarySha})`, `upsertEmbedding(...)`, `new SessionsRepo(db)` vs phase 1 `setSummary(id, {summary, sha})`, `saveEmbedding(id, {...})` | Unmet assumption | `dbSummaryStore` adapters call phase 1's API; Requires rewritten |
| 4 | Phase 6 judged embedding staleness on `created_at`, which phase 1 does not refresh on replace | Contract drift | Phase 6 uses `embedded_at` (refreshed on every save); its int-test insert sets `embedded_at`; no phase 1 change |
| 5 | Phase 6 used `process.env.VITEST` in production code to keep tests off Haiku; phase 3's int test enables sessions | Contract drift | Summarizer injected via `BackgroundOptions`; omitted = off; `src/daemon.ts` builds the Agent SDK summarizer (phase 6 now owns that edit); no env sniffing |
| 6 | Phase 7 assumed `searchSessions(deps, {query, repo, limit}) -> {hits: [{sessionId, score}]}`; phase 6 publishes `(deps, query, filter, opts) -> {sessions, next_cursor, mode, fallback?}` with no `score` | Unmet assumption | Phase 7's `phase6Search` adapter rewritten; phase 6's `SessionSearchHit` gains `score` (blended score / ts_rank) |
| 7 | Phase 7 used `new SessionsRepo({ db })` | Unmet assumption | `new SessionsRepo(db)` |
| 8 | `projects.selected` stored as `{repo}` (phase 7) vs bare string (phase 1 `setSelectedProject`) | Contract drift | Bare JSON string, null deletes; phase 7's reader still tolerates the object; phase 7 re-exports phase 1's `SELECTED_PROJECT_KEY` instead of redefining it |
| 9 | Phase 7 jsonb shape list unpinned; registry shape assumed | Unmet assumption | Pinned to phase 1/3 published types (`SessionPrompt`, `SessionCommit`, `LiveSession`) |
| 10 | Phase 4 Step 3 would add `IngestObserver` to `ingest.ts`, which phase 3 already publishes | Duplicate work | Step removed; `ingest.ts` dropped from phase 4's Files; Requires quotes phase 3's types |
| 11 | Phase 4 marker written with raw SQL on `app_settings` | Contract drift (invariant 3) | `dbLinkStore` uses `SessionsRepo.getSetting/putSetting` through `HeuristicParentWriter` |
| 12 | Phase 4 quoted `background.ts` as `if (enabled)` with pre-phase-3 names | File collision | Step 2 quotes phase 3's `else` block (`sessionsRepo`, `sessionsHost`, no second `hostname` import) and gives the full closer |
| 13 | Phase 6 quoted `background.ts`'s closer without phase 4's linker and re-imported `SessionsRepo` | File collision | Step 5 quotes the post-phase-4 closer and adds only the summary block and imports |
| 14 | Phase 5 called `upsertFromHook({... transcriptPath})`, `claimPendingSpawn({sessionId, ...}) -> {parentSessionId}`, then `setParent(..., 'hook')` | Unmet assumption | Route rewritten to phase 1's API: env parent passed into `upsertFromHook`, `claimPendingSpawn({childSessionId, ...})` sets the hook link itself; `transcript_path` accepted but not stored (ingest records it) |
| 15 | Phase 5 redefined `PENDING_SPAWN_WINDOW_MS` | Duplicate work | Imported from `src/sessions/types.ts` and re-exported |
| 16 | Pending-spawn pruning had no owner (phase 1 published `prunePendingSpawns`, phase 5 deferred to 3 or 1) | Gap | Phase 5's spawn route prunes spawns older than 24 h (`PENDING_SPAWN_RETAIN_MS`) after each record; test added |
| 17 | Phase 5 test expected `parent_node_id: null` for an env parent with no row; phase 1 creates the parent row | Contract drift | Test now expects the parent's node id (both node ids known at SessionStart, as R2 asks) |
| 18 | Ad-hoc `truncate` lists in phases 4, 5, 6 tests | Duplicate work | Replaced by phase 1's `truncateAll` |
| 19 | Phase 8 parsed `{sessions: [{node_id, summary, plan_docs, commits, ...}]}`; phase 7 serves `{nodes: [{node_id, session_id, text}], missing, context}` | Unmet assumption | Phase 8 parser, renderer, types and tests rewritten: uses `context` when every returned row was asked for, else rebuilds from kept `nodes[].text`; header text equals phase 7's `CONTEXT_HEADER` (asserted) |
| 20 | Phase 8 needed a no-Origin loopback GET | Unmet assumption (verified) | Phase 7's `loopbackReadGuard` passes it; no change |
| 21 | `mcpToolDeps`: phase 7 `(deps, sessions?)` vs phase 9 `(deps, extra?)` | File collision | Phase 9 adds a third optional parameter and quotes phase 7's body and `createApp` line |
| 22 | Phase 9 hedged on `SESSION_TOOL_NAMES`, registry name and count assertions | Unmet assumption | Pinned to phase 7/3 as published; counts 19 + 5 + 15 + 2 |
| 23 | Phase 10 wire types and normalizer assumed a subset of phase 7's payloads | Unmet assumption | `SessionNode` / `SessionGraphPayload` / `ProjectSummary` / `ProjectsPayload` mirror phase 7; fixtures and literals updated |
| 24 | Phase 10 subscribed to an SSE `sessions` event + 15 s poll; phase 7 decided no SSE, ETag polling | Contract drift | SSE listeners and `SESSIONS_EVENT` dropped; `fetchSessionGraph` sends `If-None-Match`, 304 keeps nodes; poll 10 s while visible |
| 25 | Phase 11 assumed `selectedNode/selectNode/graph` names and a placeholder slot | Unmet assumption | Mount uses phase 10's `renderPanel` slot, defaulted inside `ProjectsPage` |
| 26 | Phase 11 normalizer read lists from inside `session` and `notes_made`/`preview` | Contract drift | Lists and `parent` read from the top level, notes `excerpt`, parent `title`; new test for phase 7's exact shape |
| 27 | Phase 12 used `nodeId` and an unnamed header | Unmet assumption | Bound to phase 10's `node` prop, `.proj-bar`, `.proj-body`; `.proj-tools` hidden in chat view; `.graph-scroll` height (phase 10 handoff, unowned) assigned to phase 12 |
| 28 | Phase 12 feared `sessions_search` lacked `repo` | Unmet assumption (verified) | Phase 7's tool has `repo`; no change |
| 29 | Phase 13 read camelCase `customTitle` from snake_case wire nodes | Contract drift | `custom_title` throughout `unfinished.ts` and tests |
| 30 | Phase 13 edited `GraphNode.tsx`; phase 10 published a `renderBadge` slot | Duplicate work | Default `renderBadge` in `ProjectsPage`; `GraphNode.tsx` untouched |
| 31 | Phase 13 annotated after the response was built (ETag already computed) and read `detail.unfinished` | Contract drift | Annotate `payload.nodes` before `graphEtag`; detail annotates `detail.session`; phase 11's `SessionDetail` gains `unfinished` (phase 13 edit) |
| 32 | Phase 13 quoted `app.ts` / `sessionsApi.ts` before phases 7/9 | File collision | Quotes post-phase-9 `createApp` mount and phase 7's `SessionsApiOptions` |
| 33 | Phase 13 int test would read the real `~/.claude/sessions` via the default live registry; wrong `upsertFromHook` return | Unmet assumption (invariant 2) | `createApp(..., { sessions: { live: async () => [] } })`; seed reads `session.nodeId` |
| 34 | Phase 13's `swarmScript` breaks phase 3's whole-object config expectations and the hand-built ingest-test literal | Broken-build phase | Phase 13 Step 9 edits both config tests and the int-test literal (`swarmScript: null`) |
| 35 | Phase 6 node-id exact hit used `findNodeIdCandidates` (now upper-case only) on deliberate search queries | Contract drift | `findNodeIdCandidates(query.toUpperCase())` |
| 36 | Phase 14 had `«FILL»` markers and missed env vars / poll note; claimed lower-case ids work in prompts | Gap | Filled 3650 days, 15 min idle, the deleted-cwd measurement; added `NOTESD_TMUX_SOCKET`, `NOTESD_TMUX_BIN`, `NOTES_CLAUDE_RETENTION_DAYS`, poll-not-SSE row note + limitation; prompt wording fixed |
| 37 | SessionStart from sdk entrypoints (phase 3 handoff) | Unmet assumption (verified) | Phase 5's `isCliSession` already skips them |
| 38 | `CC_PARENT_SESSION` across 2, 5, 9 | Unmet assumption (verified) | Fresh spawns set it, resumes scrub it, phase 5 links `env` only on `startup`/`clear`: consistent |
| 39 | Phase 2 completion has no mcp-notes commit | Gap (process) | Index states the ledger-note recording; only phase 14 depends on phase 2 |
| 40 | (round 2) Phase 10's Files table still described `useProjects`/`useSessionGraph` as "SSE/poll", and phase 11's `NodePanel` step said it re-fetches "after phase 10's SSE/poll refresh", after round 1 dropped SSE | Contract drift (stale prose) | Wording changed to "60 s poll (no SSE)" / "10 s ETag poll while visible (no SSE)" and "after phase 10's 10 s ETag poll"; no code change |
| 41 | (round 2) Phase 1's Phase 5 handoff told phases 5 and 7 to assume a `sessions: SessionsRepo` on `AppDeps` built by phase 3; no phase adds one, every consumer (3, 4, 5, 6, 7, 9, 13) constructs `new SessionsRepo(deps.db)` | Unmet assumption (stale handoff) | Handoff rewritten: each consumer constructs the stateless repo itself; nobody touches `AppDeps` |
| 42 | (round 2) Index `**Status:**` was still `planned` | Process | Set to `reconciled` |
| 43 | (round 2) Verified, no change: node-id rule consumers (6 upper-cases the query, 7/9/13 use `normalizeNodeId`, 8 copies the source with equality tests); phase 4 has no `ingest.ts` edit and writes the marker through `getSetting`/`putSetting`; phase 5 imports `PENDING_SPAWN_WINDOW_MS` and prunes with `PENDING_SPAWN_RETAIN_MS`; `background.ts` chain 3 -> 4 -> 6 quotes each predecessor's closer; `daemon.ts` edited only by 6; phase 7's adapter reads `score`; `app.ts` chain 5 -> 7 -> 9 -> 13 quotes each predecessor (`mcpToolDeps` 3-arg, `SessionsApiOptions extends SessionsReadOverrides`); `ProjectsPage.tsx` chain 10 -> 11 -> 12 -> 13 quotes post-change code (`panel(selectedNode, close)`, `renderBadge={badge}`); `SessionDetail.unfinished` anchors (`live: boolean;`, `live: w.live === true,`, `.np-meta`) exist in phase 11; no `SESSIONS_EVENT`, `upsertEmbedding`, `SessionsRepo({`, `process.env.VITEST` or `«FILL»` in any phase; every `claimPendingSpawn` call passes `childSessionId` | Verification | None needed |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Free-text node-id candidate rule (phase 1 vs phase 8) | Upper case as typed, dash, whole token, >= 1 letter, max 5; `generateNodeId` never yields all digits; lookups stay case/dash tolerant | 1 (Invariant 8: near-zero cost) + 4 (R5) |
| How tests avoid the real Haiku summarizer | Inject via `BackgroundOptions.sessionSummarizer`; omitted = off; only `src/daemon.ts` builds the real one; no `process.env.VITEST` | 1 (Invariant 2: everything injectable, tests use fakes) |
| Embedding freshness column | `embedded_at` (phase 1 refreshes it); `created_at` left alone | 3 (phase 1 code block, owner) |
| `projects.selected` storage format | Bare JSON string, `null` deletes; reader tolerates `{repo}` | 3 (phase 1 `setSelectedProject` code, owner of app_settings accessors) |
| Who prunes `cc_pending_spawns` | Phase 5's spawn route, rows older than 24 h, after each record | 3 (phase 1 published `prunePendingSpawns` with its handoff to phase 5) |
| Session refresh on the wall | No SSE; poll graph every 10 s while visible with `If-None-Match`/304; project list every 60 s | 3 (phase 7 decision and code, owner of the read API) |
| Score on session search hits | Phase 6 hits carry `score` (blended / ts_rank) | 3 (phase 7 published `score`; phase 6's `rankCandidates` already computes it) |
| Env parent with no row yet | Phase 1 creates the parent row; the SessionStart reply carries the parent's node id | 4 (R2: the session is told its own and its parent's node id) |
| `transcript_path` from the SessionStart hook | Not stored by the hook route; ingest records it | 3 (phase 1 `HookStart` has no such field) |
| `mcpToolDeps` shape after phases 7 and 9 | `(deps, sessionOverrides?, extra?: {sessionResume?})` | 3 (phase 7 owner signature kept; build-green) |
| Where the panel and badge mount | Defaults for phase 10's `renderPanel` / `renderBadge` inside `ProjectsPage`; `App.tsx` and `GraphNode.tsx` untouched | 3 (phase 10 published slots) |
| Prompt hook context text | Use phase 7's `context` verbatim unless a returned row was not asked for, then rebuild with the same header | 3 (phase 7 handoff) |
| Exact-id boost in session search | Upper-case the query before `findNodeIdCandidates` | 6 (id lookups are case-insensitive everywhere, CLAUDE.md conventions) |
| When `unfinished` is computed | Before the graph ETag; detail annotates `detail.session`; MCP `session_get` stays null | 3 (phase 7 handoff: `unfinished` is part of the ETag hash) + 2 (phase 13 exit criteria cover HTTP only) |
| Project chat toggle placement | In `.proj-bar` left of `.proj-tools`; `.proj-tools` hidden in chat view | 3 (phase 10 handoff) |

## Open Questions

## Rollback

Per phase: revert the phase's merge commit. Phase 1 additionally needs the migration rolled back
by hand (`drop table cc_session_embeddings, cc_pending_spawns, cc_sessions, app_settings; alter
table chat_threads drop column project;`) — the tables hold only derived data rebuilt by ingest.
Phase 2: revert the commit in `~/claude-commands`. Whole set: revert the merge of
`feature/project-session-graph`, run the rollback SQL, and `scripts/install.sh` to re-merge hooks
without the new groups.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f docs/plans/PROJECT_SESSION_GRAPH_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows:

    /analyze-orchestrator -f docs/plans/PROJECT_SESSION_GRAPH_PLAN.md
