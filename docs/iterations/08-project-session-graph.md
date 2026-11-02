# Iteration 8: project-session-graph

A per-repo graph of every Claude Code session the user has run, in the wall. Each node is one
Claude Code session (not one prompt). The trunk is the sessions the user started by hand; the
sessions those spawned (analyze -> orchestrator -> impl phases, or any ad-hoc tmux child) hang
off them as branches. Nodes have ids the user can quote anywhere, a summary, and a resume action.

## Decisions already made (do not reopen)

- **Newest at the top.** The trunk is a thick vertical line growing upward.
- **Backfill everything still on disk** at landing, so the page is never empty.
- **Resume/spawn from the wall needs no confirm click**, except for a node whose transcript lives
  on the other machine (then confirm, and usually it is just unavailable).
- **Node id format `[A-Z0-9]{2}-[A-Z0-9]{2}`** (e.g. `A0-3G`), generated server-side like note
  ids. Distinct in shape from note ids (`A-B32`); resolve only ids that exist.
- **Custom SVG renderer**, no graph library. Git-graph-style lanes on a time axis; React Flow and
  the gitgraph packages were considered and rejected (free canvas / commit-shaped / low adoption).

## Facts measured on this machine (2026-11-02)

- Every session is `~/.claude/projects/<dir>/<uuid>.jsonl` (627 on the Lenovo). Records carry
  `sessionId`, `cwd`, `gitBranch`, `timestamp`, `entrypoint`, `version`; record types include
  `agent-name`, `custom-title`, `ai-title`, `last-prompt`, `cost-state`, and assistant messages
  with token usage.
- `entrypoint` is `cli` for terminal sessions; `sdk-ts` (wall chat agent, project dirs ending
  `-data-chat`) and `sdk-cli` (`/n` helper runs) are noise and must be excluded.
- Worktree sessions get their own project dir (`-home-miftah--worktrees-mcp-notes-wall-editing`).
  Map them to the repo via `git worktree` / the `~/.worktrees/<repo>/<slug>` convention; the
  worktree is usually deleted after landing, so the path convention must work without it.
- `~/.claude/history.jsonl` does NOT separate manual from spawned sessions: argv prompts from
  `swarm.py launch` are logged there too.
- `~/.claude/sessions/<pid>.json` is a live registry: `sessionId`, `cwd`, `tmux` (`note:@0.%7`),
  `name`, `nameSource`, `status` (busy/idle), `messagingSocketPath`. Use it for live node status.
- Children are launched by `~/claude-commands/skills/swarm/swarm.py` (`spawn_argv`:
  `tmux new-window -d -n NAME -c CWD [-e ...] "claude -n NAME ..."`). A tmux child does NOT
  inherit the caller's env. Children rename themselves (`session.py rename`) to `analyze-*`,
  `orch-*`, `impl-<slug>-pN`. Names are reused over time (see the comment in swarm.py `init`).
- Historical parent links are recoverable from the parent's transcript: Bash tool_use running
  `swarm.py launch|spawn --name X`, and `SendMessage {to: X}`. Verified: session `cc6491fc...`
  (orch-wall-editing) messaged `impl-wall-editing-p3`. Match by name + time window + cwd.
- Claude Code prunes old transcripts (`cleanupPeriodDays`), so ingesting into Postgres is also
  preservation. Recommend raising that setting in `install.sh`.
- Notes saved via `/n` already carry `origin.claude_session`: a node can list the notes it made.

## Scope

1. **Ingest** (daemon, background job): watch `~/.claude/projects/**/*.jsonl`, tail incrementally,
   upsert one `cc_sessions` row per session: id, node id, host, repo (resolved), cwd, branch,
   name, titles, first prompt, started/last-active, tokens/cost, entrypoint, parent session id,
   parent-link source (`env` | `hook` | `heuristic`), transcript path. Backfill all on first run.
   Both machines write to the shared DB with their `host`.
2. **Exact parent links going forward:**
   - `swarm.py spawn_argv` (repo `~/claude-commands`, cross-repo change) adds
     `-e CC_PARENT_SESSION=$CLAUDE_CODE_SESSION_ID`.
   - New SessionStart hook in `claude/hooks/` posts `{session, parent, cwd, name, tmux, host,
     started_at}` to the daemon, and returns additionalContext telling the session its own node
     id and its parent's.
   - Bash PreToolUse hook: a command that launches `claude` inside tmux without going through
     swarm.py records a pending spawn (parent, cwd, name); the child's SessionStart claims it
     within ~30s.
   - `install.sh` registers the hooks.
3. **Heuristic backfill of parent links** from transcripts as above. Mark them `heuristic`.
4. **Summaries + search:** after a session goes idle, summarize it (Haiku; input = human prompts,
   commits made, files edited, plan docs touched, final assistant message). Redact secrets. Embed
   via the existing embedder, search via the existing hybrid blend. Backfill summaries too.
5. **Node-id resolution in prompts:** extend `claude/hooks/notes-prompt.mjs` so ANY prompt
   containing an existing node id gets that node's summary, plan docs, commits and transcript
   path as additionalContext. Must stay near-zero cost when no id matches.
6. **MCP tools + chat agent tools:** `sessions_search`, `session_get(node_id)`,
   `session_transcript(node_id, query)` (owning host only, else `not_on_this_machine`),
   `session_resume(node_id, prompt?)`. Also usage questions (tokens per node/month).
7. **Web:**
   - New sidebar icon (Phosphor, icon-only). Opening it expands the sidebar with the repo list;
     the selected repo is persisted server-side (both laptops agree).
   - Graph view: trunk lane, children branching right in lanes (impl phases of one wave side by
     side), collapsed to a `+N` chip by default, running nodes pulse (live registry), node id on
     every node, other-host nodes marked like "uploaded on GPD". Virtualized for ~1000 nodes.
   - Node detail panel: summary, prompts, commits, notes made, tokens; Tree / Timeline (Gantt)
     toggle for its subtree.
   - Per-project chat: `project-pill-query-input` at the bottom of the graph; threads scoped to
     the project (`project` column on existing chat threads); an icon-only toggle in the project
     header switches graph <-> `project-chat-history`.
8. **Resume/spawn from the wall:** daemon runs `tmux new-window -c <cwd> "claude --resume <sid>
   [prompt]"` (or a fresh session with the node as context) on the user's tmux server, choosing
   the most recently attached tmux session. Same-origin-only route. If the node is live, focus or
   message it instead of resuming twice. Handle a deleted worktree cwd (measure what `--resume`
   needs; do not guess). No confirm except cross-host.
9. **Badge:** an orch node whose swarm ledger still has pending phases and no live session shows
   "unfinished" (use `swarm.py verify`).

## Out of scope for now

Daily digest note, fork-session UI. Keep the data model ready for them.
