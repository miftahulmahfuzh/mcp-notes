> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/project-session-graph/PLAN.md` phase 14. Source: `.workflows/plan/project-session-graph/phase-14.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 14: Docs: README, CHANGELOG, CLAUDE.md, ROADMAP

**Plan set:** `PROJECT_SESSION_GRAPH_PLAN.md`
**Analysis:** `docs/analyzer/20261102-093105-N9JN_code_analyzer.md`
**Satisfies:** R1, R2, R3, R4, R5, R6, R7, R8, R9 (documentation only: the user can read how the session graph works, what it costs, what it touches in `~/.claude`, and every route, tool, hook and env var it adds)
**Depends on:** Phase 2, 8, 13 (and through them every phase 1-13)
**Difficulty:** EASY
**Package:** repo root docs (`README.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/ROADMAP.md`)

---

## Goal

After this phase the four docs describe the project session graph as it actually shipped: a README
tour section, every new HTTP route, MCP tool, hook and env var in the README's tables, an
`[Unreleased]` CHANGELOG entry, one CLAUDE.md architecture bullet, and a ROADMAP row. No code,
test, script or config file changes.

## The one rule for the executor: names come from the code, not from this plan

This plan was written before phases 1-13 landed (`src/sessions/` did not exist at `8c259df`).
Every route, tool name, env var, default, window and table name below is taken from the plan
index's interface contract. **Before pasting any block, run the name check in Step 0 and
correct each name to what the landed code says.** Where the code and this plan disagree, the
code wins, every time. The prose around the names is final; only names, defaults and the few
measured facts marked **FILL** should need adjusting.

The **FILL** markers are written as `«FILL: what to put here»`. None may survive into the
committed docs (Verification checks this).

## Interface Contract

**Deletes:** nothing
**Renames:** nothing (README's roadmap row "10 A second machine…" becomes row 11, see Step 9; that is a table edit, not a symbol)
**Creates:** README sections `## The project session graph` (with subsections) and their Contents entries; CHANGELOG `[Unreleased]` entries; CLAUDE.md bullet "Claude Code sessions"; ROADMAP row 10.
**Signature changes:** none
**Requires (from earlier phases):**
- Phase 1: tables `cc_sessions`, `cc_session_embeddings`, `cc_pending_spawns`, `app_settings`, column `chat_threads.project`, migration `drizzle/0007_cc_sessions.sql`, node ids `[0-9A-Z]{2}-[0-9A-Z]{2}` from `src/sessions/ids.ts`.
- Phase 2: `~/claude-commands/skills/swarm/swarm.py` `spawn_argv` passes `-e CC_PARENT_SESSION=<CLAUDE_CODE_SESSION_ID>` (pushed in that repo).
- Phase 3: `config.sessions` from `CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SESSIONS`; ingest skips `sdk-ts`/`sdk-cli`.
- Phase 4: `heuristic` parent links.
- Phase 5: hooks `claude/hooks/notes-session.mjs` (SessionStart) and `claude/hooks/notes-spawn.mjs` (Bash PreToolUse); routes `POST /api/sessions/hook/start`, `POST /api/sessions/hook/spawn`; `install.sh` registers five hooks and raises `cleanupPeriodDays`; `uninstall.sh` removes them.
- Phase 6: Haiku summaries, redaction, `cc_session_embeddings`, hybrid session search with `fallback`.
- Phase 7: routes in `src/http/sessionsApi.ts`; MCP tools `sessions_search`, `session_get`, `session_transcript`, `sessions_usage` in `src/mcp/sessionTools.ts`, on the chat allow list; MCP instructions paragraph about sessions.
- Phase 8: `notes-prompt.mjs` resolves node ids in any prompt via `GET /api/sessions/context`.
- Phase 9: `POST /api/sessions/:nodeId/resume` (same-origin) in `src/http/sessionResume.ts`; MCP tool `session_resume`; the deleted-cwd measurement recorded in `src/sessions/resume.ts` / its tests.
- Phase 10: `/projects` route, rail icon, repo sidebar, SVG graph.
- Phase 11: node panel, Tree/Timeline toggle, resume button with cross-host confirm.
- Phase 12: `project` on chat threads, `project-pill-query-input`, `project-chat-history` toggle.
- Phase 13: `NOTESD_SWARM_SCRIPT` (`config.sessions.swarmScript`), "unfinished" badge from `swarm.py verify`.
**Leaves alone (owned by others):** all of `src/`, `web/`, `claude/`, `scripts/`, `drizzle/`, `tests/` (phases 1, 3-13); `~/claude-commands` (phase 2); `docs/INSTALL.md`, `docs/iterations/*`, `docs/plans/*`, `docs/readme/*` images.

## Files

| File | Action | What changes |
|---|---|---|
| `README.md:10-49` | modify | Contents: new section + subsections |
| `README.md:94-95` | modify | "Why it is different": one new bullet after "Notes remember where they came from" |
| `README.md:312-342` | modify | hooks list: "three" -> "five", notes-prompt bullet's last sentences, two new bullets |
| `README.md:535` (before `## Connectors: spending, runs, Seer`, line 536) | modify | insert `## The project session graph` and subsections |
| `README.md:620-627` | modify | install step 8 (five hooks + `cleanupPeriodDays`), uninstall sentence |
| `README.md:703` (after `TEST_CONNECTORS_URL` row) | modify | four env var rows |
| `README.md:741-751` | modify | five MCP tool rows, instructions sentence |
| `README.md:780-814` | modify | HTTP API rows (sessions, projects, hooks, resume, chat `project`), `/projects` page row |
| `README.md:827-841` | modify | storage block: new tables, `chat_threads.project`, `session.log`/`spawn.log` |
| `README.md:896` (after last Limitations bullet) | modify | three Limitations bullets |
| `README.md:910-911` | modify | Roadmap table: row 10 = session graph, "later" becomes 11 |
| `README.md:918,923` | modify | Repository layout `src/` and `claude/hooks` lines |
| `CHANGELOG.md:8` | modify | `[Unreleased]` gets `### Added` / `### Changed` |
| `CLAUDE.md:40-41` | modify | new "Claude Code sessions" bullet after Connectors; hooks list in the `claude/` bullet |
| `docs/ROADMAP.md:39-40` | modify | new row 10, `10+` becomes `11+` |

Line numbers are measured at `8c259df`. Phases 1-13 own no doc file, so they should still hold;
if a phase did touch one of these files, anchor on the quoted text instead. Apply the README edits
**bottom-up** (Step 11 first, Step 1 last) so earlier line numbers stay valid.

## Implementation Steps

### Step 0: Name check (do this first, write nothing yet)

Run from the worktree root and keep the output open while editing:

```sh
# HTTP routes as landed
grep -nE "\.(get|post|put|patch|delete)\(['\"\`]" src/http/sessionsApi.ts src/http/sessionHooks.ts src/http/sessionResume.ts
grep -nE "project" src/http/chatApi.ts src/http/api.ts | head -40
grep -nE "app\.route|\.route\(" src/http/app.ts
# MCP tools as landed (names, and whether chat can use them)
grep -nE "registerTool\(|name: ['\"]session" src/mcp/sessionTools.ts
grep -nE "session" src/chat/status.ts src/mcp/instructions.ts
# Env vars and defaults
grep -nE "CLAUDE_HOME|NOTES_WORKTREES_DIR|NOTESD_SESSIONS|NOTESD_SWARM_SCRIPT|sessions" src/config.ts
grep -rnoE "process\.env\.[A-Z_]+" src/sessions claude/hooks/notes-session.mjs claude/hooks/notes-spawn.mjs claude/hooks/notes-prompt.mjs | sort -u
# Hooks: names, events, matcher, log files, cleanupPeriodDays value
grep -nE "notes-(session|spawn)|OUR_SCRIPT|SessionStart|matcher" scripts/claude-hooks.mjs
grep -nE "cleanupPeriodDays" scripts/install.sh scripts/claude-hooks.mjs
grep -nE "writeLog\(|\.log['\"]" claude/hooks/notes-session.mjs claude/hooks/notes-spawn.mjs claude/hooks/notes-prompt.mjs
# Windows and timings
grep -rnE "30_?000|IDLE|idle|WINDOW|window" src/sessions/*.ts | grep -viE "test|window\.|new-window" | head -30
# Deleted worktree cwd: the measurement phase 9 recorded
grep -nE -i "deleted|measur|ENOENT|cwd" src/sessions/resume.ts tests/**/resume*.test.ts | head -30
# Web route and labels
grep -rnE "'/projects'|project-pill-query-input|project-chat-history|unfinished" web/src | head -20
# SSE: did any phase add a session event?
grep -nE "session" src/notes/events.ts src/http/api.ts | head
# Migration file name
ls drizzle/0007_*.sql
```

For each line of the table below, confirm or correct the name before Step 1.

| Contract name used in this plan | Where to confirm |
|---|---|
| `GET /api/projects`, `GET/PUT /api/projects/selected`, `GET /api/projects/:repo/sessions` | `sessionsApi.ts` |
| `GET /api/sessions/:nodeId`, `/transcript?query=`, `/context?ids=`, `/search?q=`, `/usage?by=&repo=` | `sessionsApi.ts` |
| `POST /api/sessions/hook/start`, `POST /api/sessions/hook/spawn` | `sessionHooks.ts` |
| `POST /api/sessions/:nodeId/resume` `{prompt?, fresh?}` | `sessionResume.ts` |
| `POST /api/chat` `project` field; how the project history is listed | `chatApi.ts`, `api.ts` |
| `sessions_search`, `session_get`, `session_transcript`, `sessions_usage`, `session_resume` | `sessionTools.ts` |
| `CLAUDE_HOME` (`~/.claude`), `NOTES_WORKTREES_DIR` (`~/.worktrees`), `NOTESD_SESSIONS` (`off`), `NOTESD_SWARM_SCRIPT` (`~/.claude/skills/swarm/swarm.py`) | `config.ts`; add a row for any other new env var found there |
| `notes-session` (SessionStart), `notes-spawn` (PreToolUse, matcher `Bash`) | `claude-hooks.mjs` |
| `cleanupPeriodDays` value | `install.sh` |
| `session.log`, `spawn.log` | the two hook files |
| pending-spawn window (~30 s), idle time before a summary | `src/sessions/*.ts` |
| `/projects`, `?repo=&node=` | `web/src/lib/route.ts` |
| `drizzle/0007_cc_sessions.sql` | `ls drizzle` |

### Step 1: Contents
**File:** `README.md:32-33`
**Change:** insert the new section and its subsections between the history-page entry (line 32) and the Connectors entry (line 33).
**Code:**
```markdown
  - [The history page](#the-history-page)
- [The project session graph](#the-project-session-graph)
  - [Node ids](#node-ids)
  - [Who started whom](#who-started-whom)
  - [Summaries and search](#summaries-and-search)
  - [Resume from the wall](#resume-from-the-wall)
  - [Asking about sessions](#asking-about-sessions)
  - [Chat about one project](#chat-about-one-project)
- [Connectors: spending, runs, Seer](#connectors-spending-runs-seer)
```
**Impact:** anchors must match the headings added in Step 4.

### Step 2: "Why it is different" bullet
**File:** `README.md:94-95` (after the bullet that starts `- **Notes remember where they came from.**`, which ends at line 95)
**Change:** insert one bullet.
**Code:**
```markdown
- **Every Claude Code session is on a map.** The daemon reads the transcripts Claude Code
  already writes and draws each repo's sessions as a graph: the ones you started by hand on a
  thick trunk, the ones they spawned on branches beside them. Every session gets a short id like
  `A0-3G` that you can type into any prompt, a summary you can search, and a resume button.
```

### Step 3: Hooks list under "Using it from Claude Code"
**File:** `README.md:312-342`
**Change (a):** line 312, replace
```markdown
`install.sh` also registers three Claude Code hooks in `~/.claude/settings.json` (every repo; pass
```
with
```markdown
`install.sh` also registers five Claude Code hooks in `~/.claude/settings.json` (every repo; pass
```
**Change (b):** lines 331-332, in the notes-prompt bullet, replace
```markdown
  `create_image` (or `attach_image`) with `image_id`. Every other prompt passes straight through:
  the hook reads nothing and sends nothing, so a session that never uses `/n` stores no images.
```
with
```markdown
  `create_image` (or `attach_image`) with `image_id`. The same hook also resolves session node
  ids in any prompt, `/n` or not (see [Node ids](#node-ids)). Every other prompt passes straight
  through: the hook runs one regular expression over it and reads and sends nothing else, so a
  session that never uses `/n` stores no images.
```
**Change (c):** after the notes-prompt bullet ends (line 341, `matching \`[Image #N]\`).`), before the blank line and `The recordings below…` (line 343), append two bullets:
```markdown
- **notes-session** (SessionStart): tells the daemon a session has started: its id, its parent
  (from `CC_PARENT_SESSION`, which `swarm.py` sets on the sessions it spawns), the working
  directory, the session name, the tmux pane and the host. It then tells Claude its own node id
  and its parent's, so "I am `A0-3G`, spawned by `7K-2Q`" is in the session from the first turn.
  If the daemon is down the session starts as usual and the link is recovered later from the
  transcripts. Logs to `~/.local/state/notes-capture/session.log`.
- **notes-spawn** (before every Bash command): when a command starts `claude` in a new tmux
  window without going through `swarm.py`, the hook records "this session is starting a child
  here". The child's notes-session hook claims that record if it starts within about 30 seconds,
  which links it to its parent exactly. Any other command passes through untouched, and the hook
  never blocks or changes a command. Logs to `~/.local/state/notes-capture/spawn.log`.

`install.sh` also raises Claude Code's `cleanupPeriodDays` to 3650 days (ten years;
`NOTES_CLAUDE_RETENTION_DAYS` changes it) in `~/.claude/settings.json` (only when it is lower;
a higher value is kept), so Claude Code stops deleting the transcripts the session graph reads. The daemon keeps what it has already read either way.
```

### Step 4: The tour section
**File:** `README.md:535`, i.e. insert after the last line of the history page section (the
`![History page: clicking a note id opens the editor in place](docs/readme/history-link.gif)`
line and its trailing blank line) and before `## Connectors: spending, runs, Seer` (line 536).
**Change:** insert this section verbatim, after the Step 0 name corrections. The deleted-cwd
paragraph states phase 9's recorded measurement (Measurements M1, M2 and "Decisions taken from the
measurements" in phase 9's plan); confirm it against the header comment of `src/sessions/resume.ts`.
**Code:**
````markdown
## The project session graph

Every Claude Code session you have run on this machine, grouped by repo, on one page. Open the
graph icon on the rail (or `/projects`); the sidebar opens with the list of repos, newest
activity first. Pick one and its sessions fill the page. The repo you picked is stored in the
database, so both laptops open on the same one.

Each node is one Claude Code session, not one prompt. Time runs upward: the newest session is at
the top. The sessions you started yourself sit on a thick trunk on the left. Sessions they started
(an `/analyze` that spawned an orchestrator, an orchestrator that spawned one session per phase,
or any `claude` you launched in a new tmux window from inside a session) branch off to the right
in lanes, git-graph style; phases of one wave stand side by side. A parent's children start
folded into a `+N` chip; click it to open them. A session that is running right now pulses. A
session from the other laptop is marked "on GPD" (or "on Lenovo"), like a photo stored there. The
page draws only what is on screen, so a repo with a thousand sessions scrolls as smoothly as one
with ten.

Click a node to open its panel: the summary, your prompts in order, the commits it made, the
notes it saved with `/n`, its token use and cost, and its node id with a copy button. **Tree** and
**Timeline** switch the view of everything below it: the tree of who started whom, or a Gantt
chart of when each one ran, which shows at a glance which phases overlapped and which one ran
long.

An orchestrator node whose swarm still has phases to do, and no live session working on them,
carries an "unfinished" badge. The daemon asks `swarm.py verify` for the answer (`NOTESD_SWARM_SCRIPT`
points at the script) and remembers it for a while, so the badge costs nothing per redraw.

When the daemon first starts with this feature it reads every transcript still under
`~/.claude/projects`, so the page is full from the first visit. After that it reads only the bytes
Claude Code appended since the last pass. Each laptop reads its own transcripts into the shared
database and records its host. The wall's own chat agent and the `/n` helper runs are Claude Code
sessions too, but they are left out.

### Node ids

A node id is two characters, a dash and two characters, like `A0-3G`: a different shape from a
note id (`A-B32`), so the two never get confused. The daemon makes them, the same way it makes note
ids. Type one into any Claude Code prompt, in any repo, and the notes-prompt hook adds that
session's summary, plan docs, commits and transcript path to what Claude sees before it answers:

```
what did A0-3G decide about the lane layout? keep going from there
compare 7K-2Q and A0-3G, which approach held up?
```

An id that does not belong to a session adds nothing, and so does a prompt with no id in it: the
hook checks the prompt with one regular expression and goes no further, so the cost to every other
prompt is close to nothing. In a prompt, write the id the way the wall shows it: upper case, with
the dash (so `to-do` or a page range like `10-15` never sets anything off). The MCP tools and the
HTTP routes also accept lower case and a missing dash (`a03g`).

### Who started whom

Links between sessions come from three places, best first, and a better one always wins:

1. **env:** `swarm.py` (in `~/claude-commands`) starts each child with
   `CC_PARENT_SESSION=<its own session id>` in the child's environment, and the notes-session hook
   reports it. A tmux child does not inherit its parent's environment, which is why this has to
   be passed by hand.
2. **hook:** a child started by a Bash command that runs `claude` in a new tmux window, without
   `swarm.py`, claims the record the notes-spawn hook left when its parent ran that command
   (within about 30 seconds, same directory).
3. **heuristic:** sessions from before these hooks existed are linked by reading the parent's
   transcript for `swarm.py launch|spawn --name X` and `SendMessage {to: X}`, and matching a
   child by name, time and directory. These links are marked as guesses in the panel.

Sessions in a git worktree (`~/.worktrees/<repo>/<slug>`, `NOTES_WORKTREES_DIR`) are filed under
their repo, even after the worktree has been deleted, from the path alone.

### Summaries and search

When a session has been idle for 15 minutes (and is not running), the
daemon writes it a short summary with Claude Haiku, through the same `claude` login the chat bar
uses; no new key. Haiku sees your prompts, the commits made, the files edited, the plan docs
touched and the final answer, with secrets (keys, tokens, passwords, connection strings) blanked
out first. A summary is written once per state of the session: a session that has not changed is
never summarized again. Sessions on disk when the feature lands get theirs in the background, a
few at a time.

Summaries are embedded like notes and searched the same way: words, meaning and recency blended
with the weights in `src/search/blend.ts`. Without `OPENROUTER_API_KEY` session search is words
only and says so.

### Resume from the wall

The panel's resume button opens a new tmux window, in the tmux session you used most recently, at
the session's directory, running `claude --resume <session>`. Type a prompt first and it goes in
as the first message. **Fresh** starts a new session instead, with the old one's summary as its
context. If the session is still running, the button switches to its window (or sends it the
prompt) rather than opening it a second time. A session whose transcript is on the other laptop
asks before doing anything, and usually can only say it is not on this machine; nothing else
asks for a confirm click.

`claude --resume` finds a transcript by its session id, not by its directory, so a session whose
worktree has been deleted still resumes (measured, not assumed). The daemon opens it in the
session's own directory if that still exists, otherwise in the repo's main checkout (the newest
directory another session of that repo used on this laptop outside `~/.worktrees`), then
`~/<repo>`, then your home folder; it never recreates the deleted directory, and Claude is told
where the session used to run.

The route answers only requests from the wall's own page, like "open file location".

### Asking about sessions

The MCP server and the chat bar have the same five tools for sessions (listed under
[MCP tools](#mcp-tools)), so from Claude Code or the wall:

```
/n which session added the recycle bin, and what did it change?
/n how many tokens did I spend on mcp-notes sessions in October?
/n show me the transcript of A0-3G around the migration error
/n resume A0-3G and ask it to rerun the integration tests
```

`session_transcript` reads the transcript file, so it works only on the laptop that holds it and
answers `not_on_this_machine` on the other.

### Chat about one project

The pill at the bottom of the graph page is a chat bar for that repo alone. Its conversations
are stored as threads of that project, and the agent starts from that repo's sessions. The icon in
the project header switches the page between the graph and the project's chat history. The wall's
own chat bar and `/history` are unchanged.
````
**Impact:** none on code. The rail-icon wording ("the graph icon") must match the Phosphor icon
phase 10 used; check `web/src/components/Rail.tsx` and its `aria-label`.

### Step 5: Install steps and uninstall
**File:** `README.md:620-627`
**Change:** replace step 8 (lines 620-622) with:
```markdown
8. merges the notes-capture, notes-paste, notes-prompt, notes-session and notes-spawn hooks into
   `~/.claude/settings.json`, keeping everything else, and raises `cleanupPeriodDays` so Claude
   Code keeps its transcripts for the session graph (a copy of the original is kept once as
   `settings.json.bak-notes-hooks`; `--skip-hooks` or `NOTES_SKIP_HOOKS=1` skips this),
```
and in line 627 replace `removes only our three hook entries` with `removes only our five hook entries; it leaves \`cleanupPeriodDays\` as it is`. Confirm the uninstall behaviour for `cleanupPeriodDays` against `scripts/uninstall.sh`; if phase 5 restores it, say "and puts `cleanupPeriodDays` back".

### Step 6: Configuration table
**File:** `README.md:703` (after the `TEST_CONNECTORS_URL` row, the last row)
**Change:** append these rows.
**Code:**
```markdown
| `NOTESD_SESSIONS` | on | `off` stops the daemon reading Claude Code transcripts. The session graph then shows only what is already in the database. |
| `CLAUDE_HOME` | `~/.claude` | Where Claude Code keeps `projects/` (transcripts) and `sessions/` (which sessions are running). |
| `NOTES_WORKTREES_DIR` | `~/.worktrees` | Root of the `<repo>/<slug>` worktrees; sessions run in one are filed under its repo, even after it is deleted. |
| `NOTESD_SWARM_SCRIPT` | `~/.claude/skills/swarm/swarm.py` (under `CLAUDE_HOME`) | The swarm script asked whether an orchestrator still has phases to do (the "unfinished" badge). Missing: no badge. |
| `NOTESD_TMUX_SOCKET` | unset | A tmux socket path for resume from the wall (`tmux -S`). Unset: the default socket, which the systemd user unit reaches. |
| `NOTESD_TMUX_BIN` | `tmux` | The tmux binary resume from the wall runs. |
| `NOTES_CLAUDE_RETENTION_DAYS` | 3650 | Read by `scripts/install.sh`, not the daemon: the minimum `cleanupPeriodDays` it writes to `~/.claude/settings.json`. |
```
Add a row for any other new env var Step 0 turns up in `src/config.ts` or `src/sessions/*`.
`CC_PARENT_SESSION` is not a daemon setting (swarm.py sets it for a child session) and stays out of
this table; it is described in Step 4.

### Step 7: MCP tools table and instructions
**File:** `README.md:741-751`
**Change (a):** after the `similar_images` row (line 741) append:
```markdown
| `sessions_search` | Claude Code sessions by meaning and by words over their summaries, names and prompts, blended like `search`; filter by `repo`. Each hit has its node id, repo, times and summary. Says `fallback` when only words were used |
| `session_get` | One session by node id (`A0-3G`, any case, dash optional): summary, prompts, commits, plan docs, files edited, notes saved from it, tokens and cost, parent and children, `host` and `available` |
| `session_transcript` | Passages of a session's transcript matching `query`. Only on the laptop that holds the transcript; elsewhere `not_on_this_machine` |
| `sessions_usage` | Tokens and cost per session or per month (`by: "node" \| "month"`), optionally for one `repo` |
| `session_resume` | Open a session again in a new tmux window (`claude --resume`), with an optional first `prompt`, or switch to it when it is still running. Same machine only |
```
**Change (b):** line 750-751, replace
```markdown
The server also sends Claude short instructions: what mcp-notes is, how ids look, that
comparisons are Claude's job, and that the connectors are read-only and the curated tools come first.
```
with
```markdown
The server also sends Claude short instructions: what mcp-notes is, how note and session ids look,
that comparisons are Claude's job, and that the connectors are read-only and the curated tools
come first. The chat bar can use the five session tools too.
```
If Step 0 shows `session_resume` is not on the chat allow list (`src/chat/status.ts`), write
"the four read-only session tools" instead.

### Step 8: HTTP API table
**File:** `README.md:780-814`
**Change (a):** in the `POST /api/chat` row (line 807) replace `` `{message, thread_id?, reply_to?, image_ids?}` `` with `` `{message, thread_id?, reply_to?, image_ids?, project?}` `` and append to the row's text: `` `project` (a repo) keeps the thread to that project ``. Use the field name phase 12 landed.
**Change (b):** after the `POST /api/chat/messages/:id/restore` row (line 813), before `/full/:imageId`, insert:
```markdown
| `GET /api/projects` | Repos that have Claude Code sessions, with session counts and last activity |
| `GET/PUT /api/projects/selected` | The repo picked in the sidebar, `{repo}`, stored in the database so both machines agree |
| `GET /api/projects/:repo/sessions?before=&limit=` | That repo's sessions for the graph: node id, parent and link source (`env`, `hook`, `heuristic`), times, name, `live`, `host`, `available`, `unfinished`. Sends a weak `ETag`; answers `304` to a matching `If-None-Match` (the wall polls it; there is no SSE event for sessions) |
| `GET /api/sessions/:nodeId` | One session in full: summary, prompts, commits, plan docs, files, notes saved from it, tokens, children |
| `GET /api/sessions/:nodeId/transcript?query=` | Matching passages of the transcript; 404 `not_on_this_machine` when it lives on the other machine |
| `GET /api/sessions/context?ids=A0-3G,7K-2Q` | Context for the notes-prompt hook; ids that do not exist are left out |
| `GET /api/sessions/search?q=&repo=` | Session search, blended like note search, with `fallback` |
| `GET /api/sessions/usage?by=node\|month&repo=` | Tokens and cost per session or per month |
| `POST /api/sessions/:nodeId/resume` | `{prompt?, fresh?}`: resume (or start fresh from) a session in a new tmux window, or switch to it when it is live. 404 `not_on_this_machine` for the other machine's sessions. Same-origin only |
| `POST /api/sessions/hook/start` · `/hook/spawn` | From the notes-session and notes-spawn hooks (JSON, header `X-Notes-Capture: 1`, loopback only): a session started, a session is about to start a child |
```
If phase 12 added a route or query parameter for a project's chat history (Step 0, `chatApi.ts`),
add a row for it here in the same style, or extend the `GET /api/chat/messages` row with the
parameter. No SSE event exists for sessions (phase 7 decided on polling): the wall polls
`GET /api/projects/:repo/sessions` every 10 s while the page is visible, with `If-None-Match`, and
an unchanged graph answers `304`. Say so in that row: append `` Sends a weak `ETag`; answers `304` to a matching `If-None-Match` ``.
**Change (c):** after `/full/:imageId` (line 814) append:
```markdown
| `/projects?repo=&node=` | The project session graph, opened on that repo and node |
```

### Step 9: Where things are stored
**File:** `README.md:827-841`
**Change (a):** replace line 827
```
           chat_threads(id, source, brain, external_key, created_at, updated_at)
```
with
```
           chat_threads(id, source, brain, external_key, project, created_at, updated_at)
```
**Change (b):** after line 831 (`chat_message_attachments(...)`) insert:
```
           cc_sessions(session_id, node_id [A0-3G], host, repo, cwd, branch, name, titles,
                       started_at, last_active_at, tokens, cost_usd, parent_session_id,
                       parent_link_source, tmux, transcript_path, transcript_offset, prompts,
                       commits, files_edited, plan_docs, summary, summary_sha, …)
           cc_session_embeddings(session_id, embedding vector(1536), sha, model)
           cc_pending_spawns(parent_session_id, cwd, name, host, created_at, claimed_by)
           app_settings(key, value)                    projects.selected: the repo picked on the wall
```
**Change (c):** replace lines 839-840 (the `~/.local/state/notes-capture/` entry) with:
```
~/.local/state/notes-capture/      the Claude Code hooks: outbox/ (captures waiting for the daemon), capture.log, paste.log,
                                   prompt.log, session.log, spawn.log, prompt-images/ (per session, which pasted images are already uploaded)
~/.claude/projects/*/<id>.jsonl    Claude Code's own transcripts, read (never written) by the session graph
```
**Change (d):** after the paragraph ending `removes a photo's original and its \`cache/<imageId>/\` folder, and nothing else.` (line 860), add:
```markdown
The session tables hold only what the daemon read from transcripts and hooks. Dropping them
loses summaries already paid for, nothing else: the next start reads the transcripts still on
disk again. Transcripts Claude Code has since deleted are gone from disk but kept in
`cc_sessions`.
```

### Step 10: Limitations
**File:** `README.md:896` (after `- **Edits from another machine** …`, the last bullet)
**Change:** append:
```markdown
- **Sessions are as good as the transcripts.** A session Claude Code deleted before the daemon
  read it is not on the graph. Links between old sessions are guesses from what the parent
  wrote (marked as such); only sessions started after install are linked for certain.
- **Summaries cost Claude usage.** Each idle session gets one Haiku call on your `claude` login,
  and the first start summarizes the whole backlog in the background. `NOTESD_SESSIONS=off`
  turns ingest off.
- **Resume needs tmux on the same machine.** The transcript of a session from the other laptop
  stays there; its node shows, but it cannot be resumed or read here.
- **The graph refreshes by polling.** Every 10 seconds while the page is open (a `304` when
  nothing changed), not live: session rows change on every transcript append, and the other
  laptop's writes never reach this daemon's event stream anyway.
```

### Step 11: Roadmap table and repository layout
**File:** `README.md:910-911` and `918`, `923`
**Change (a):** replace line 911
```markdown
| 10 | A second machine (the GPD), weekly digest, … | later |
```
with
```markdown
| 10 | Project session graph: every Claude Code session per repo, node ids, summaries, resume from the wall | done |
| 11 | A second machine (the GPD), weekly digest, … | later |
```
**Change (b):** replace line 918 with
```
src/            notesd: config, db (Drizzle), notes service, MCP server, HTTP routes, images, chat agent, connectors, Claude Code sessions
```
**Change (c):** replace line 923 with
```
claude/hooks    the Claude Code hooks (notes-capture: saves /n exchanges; notes-paste: pasted image -> similar_images; notes-prompt: /n prompt -> pasted image ids, node ids -> session context; notes-session: session start and parent link; notes-spawn: tmux child launched by hand)
```

### Step 12: CHANGELOG
**File:** `CHANGELOG.md:8` (`## [Unreleased]`, followed by a blank line and `## [v0.2.0]`)
**Change:** replace the empty `[Unreleased]` with the block below. Do not add a version or a link
reference; releases are cut separately.
**Code:**
```markdown
## [Unreleased]

### Added

- **Project session graph** (`/projects`): every Claude Code session on both laptops, per repo, as a git-graph of lanes on a time axis, newest at the top. Hand-started sessions form the trunk; sessions they spawned branch off, folded into a `+N` chip. Running sessions pulse, the other laptop's are marked, and only visible nodes are drawn (smooth at ~1000). A rail icon opens the repo list in the sidebar; the picked repo is stored server-side (`app_settings`), so both laptops agree.
- **Session ingest**: a background job reads `~/.claude/projects/**/*.jsonl` into `cc_sessions` (migration 0007): repo (worktree paths resolved even after the worktree is gone), branch, name, titles, prompts, times, tokens and cost, commits, files and plan docs. It backfills everything on disk on first start and then reads only appended bytes. `sdk-ts` / `sdk-cli` sessions are skipped. `CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SESSIONS=off`.
- **Node ids** like `A0-3G` for every session, generated server-side. Typing one into any Claude Code prompt makes the `notes-prompt` hook add that session's summary, plan docs, commits and transcript path; a prompt with no id still costs one regex test.
- **Exact parent links**: new `notes-session` (SessionStart) and `notes-spawn` (Bash PreToolUse) hooks and `POST /api/sessions/hook/start|spawn`. A session reports its parent from `CC_PARENT_SESSION` and learns its own and its parent's node id; a `claude` launched by hand in a tmux window claims the pending spawn its parent left. Older sessions get `heuristic` links from their parents' transcripts (`swarm.py launch|spawn --name`, `SendMessage {to}`).
- **Session summaries and search**: idle sessions are summarized once with Claude Haiku (secrets redacted first), embedded, and searched with the same hybrid blend as notes; the backlog is summarized in the background.
- **Session tools** for MCP and the chat bar: `sessions_search`, `session_get`, `session_transcript` (owning machine only, else `not_on_this_machine`), `sessions_usage` (tokens and cost per session or month) and `session_resume`. Read API under `/api/projects` and `/api/sessions`.
- **Node panel**: summary, prompts, commits, notes made, tokens; Tree / Timeline (Gantt) toggle for the subtree; resume (or start fresh) into a new tmux window with no confirm, except for a session on the other laptop. A live session is focused or messaged instead of resumed twice. `POST /api/sessions/:nodeId/resume`, same-origin only.
- **Per-project chat**: a chat pill under the graph keeps its threads to that repo (`chat_threads.project`), and the project header toggles between the graph and that project's chat history.
- **"unfinished" badge** on orchestrator nodes whose swarm still has pending phases and no live session, from `swarm.py verify` (`NOTESD_SWARM_SCRIPT`).

### Changed

- `scripts/install.sh` registers five Claude Code hooks instead of three and raises `cleanupPeriodDays` in `~/.claude/settings.json` so Claude Code keeps the transcripts the graph reads; `scripts/uninstall.sh` removes all five. Re-run `scripts/install.sh` after updating, and `npm run db:migrate` once.
- `notes-prompt` now looks at every prompt for a node id, not only `/n` prompts. Without one it still does no I/O.
- In `~/claude-commands`, `swarm.py`'s `spawn_argv` passes `-e CC_PARENT_SESSION=<CLAUDE_CODE_SESSION_ID>` to every session it spawns (a tmux child does not inherit its parent's environment). Pull that repo and run its `./sync.sh` to get exact links for swarm children.
```

### Step 13: CLAUDE.md
**File:** `CLAUDE.md:40-41`
**Change (a):** after the Connectors bullet (line 40), insert:
```markdown
- **Claude Code sessions** (`src/sessions/*`) are the project session graph. A background ingester tails `~/.claude/projects/**/*.jsonl` from stored byte offsets into `cc_sessions` (`drizzle/0007_cc_sessions.sql`); `SessionsRepo` (`src/sessions/repo.ts`) is the only writer of the session tables. Parent links have a source, `env` > `hook` > `heuristic`, and a worse source never overwrites a better one. Node ids (`A0-3G`, `src/sessions/ids.ts`) are generated server-side; never invent one. Idle sessions get Haiku summaries (redacted, embedded, searched with `src/search/blend.ts`). Transcripts, `session_transcript` and resume work only on the owning host (`not_on_this_machine`). Routes: `src/http/sessionsApi.ts`, `sessionHooks.ts`, `sessionResume.ts` (same-origin); MCP: `src/mcp/sessionTools.ts`; web: `/projects`. Every path (`CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SWARM_SCRIPT`, tmux, claude bin) is injectable, and tests never touch the real `~/.claude`.
```
**Change (b):** in line 41, replace
```
hooks (`claude/hooks/notes-capture|paste|prompt.mjs`, merged into `~/.claude/settings.json`)
```
with
```
hooks (`claude/hooks/notes-capture|paste|prompt|session|spawn.mjs`, merged into `~/.claude/settings.json` by `scripts/claude-hooks.mjs`; `notes-prompt` also resolves node ids in any prompt and must stay I/O-free when none matches)
```
Correct the file names in (a) to what Step 0 found (e.g. if phase 6 named the worker differently, that file is not named here anyway; only the ones quoted must exist: `ls` each path quoted in the bullet).

### Step 14: docs/ROADMAP.md
**File:** `docs/ROADMAP.md:39-40`
**Change:** the iterations table already uses 8 and 9 for the v0.2.0 work, while this feature's
brief is `iterations/08-project-session-graph.md`. Keep the table's numbering (it matches
README's roadmap table) and name the brief in the row. Replace line 40
```markdown
| 10+ | Later | GPD install, weekly digest, … | – |
```
with
```markdown
| 10 | Project session graph | Every Claude Code session per repo as a graph on the wall, node ids resolvable from any prompt, exact and heuristic parent links, Haiku summaries and session search, session MCP/chat tools, resume into tmux, per-project chat, "unfinished" orch badge. Brief: `iterations/08-project-session-graph.md` | – |
| 11+ | Later | GPD install, weekly digest, daily session digest note, fork-session UI, … | – |
```

## Verification

**Build:** none needed (docs only); `npm run typecheck` must still pass, unchanged.
**Tests:** `npm test` (unchanged; proves nothing else was touched).
**Checks:**
```sh
cd /home/miftah/.worktrees/mcp-notes/project-session-graph
git diff --stat                                   # only README.md, CHANGELOG.md, CLAUDE.md, docs/ROADMAP.md
! grep -n "«FILL" README.md CHANGELOG.md CLAUDE.md docs/ROADMAP.md
# every route the README names exists in code
for r in "/api/projects" "/api/projects/selected" "/sessions/context" "/sessions/search" "/sessions/usage" "/transcript" "/resume" "/hook/start" "/hook/spawn"; do
  grep -rq -- "$r\|${r#/api}" src/http || echo "MISSING route $r"; done
# every tool the README names exists in code
for t in sessions_search session_get session_transcript sessions_usage session_resume; do
  grep -q "$t" src/mcp/sessionTools.ts || echo "MISSING tool $t"; done
# every env var the README names is read by the code
for v in CLAUDE_HOME NOTES_WORKTREES_DIR NOTESD_SESSIONS NOTESD_SWARM_SCRIPT; do
  grep -rq "$v" src || echo "MISSING env $v"; done
# every path CLAUDE.md quotes exists
for p in src/sessions/repo.ts src/sessions/ids.ts src/http/sessionsApi.ts src/http/sessionHooks.ts src/http/sessionResume.ts src/mcp/sessionTools.ts claude/hooks/notes-session.mjs claude/hooks/notes-spawn.mjs; do
  test -e "$p" || echo "MISSING $p"; done
ls drizzle/0007_cc_sessions.sql
# Contents anchors resolve to headings
for a in the-project-session-graph node-ids who-started-whom summaries-and-search resume-from-the-wall asking-about-sessions chat-about-one-project; do
  grep -q "](#$a)" README.md && grep -qiE "^#+ $(echo $a | tr - ' ')$" README.md || echo "ANCHOR $a"; done
```
Every `MISSING`/`ANCHOR` line is either a name to fix in the docs, or (if the code genuinely lacks
the feature) a sentence to remove; never change code from this phase.
**Manual check:** read the new README section top to bottom against the running wall (`/projects`)
once: icon name, labels (Tree/Timeline, Fresh, "unfinished", "on GPD"), and the resume behaviour.
Run the README text through the user's `anti-ai-writing` skill's strict review if time allows; the
existing README avoids em dashes in prose and so does the drafted text.
**Exit criteria:** the four docs mention every route, tool, hook and env var phases 1-13 added, by
the names in the code; no `«FILL` marker remains; `git diff --stat` shows only the four doc files.

## Handoffs

- **README screenshots** for the graph page, node panel and project chat (`docs/readme/*.png|gif`,
  plus a line in "About the screenshots") are not in scope: they need a seeded throwaway instance
  and Playwright. Leave for a follow-up task (no phase owns it).
- **`docs/INSTALL.md`** does not mention hooks per name today; if phase 5 changed install flags
  (e.g. a flag to skip `cleanupPeriodDays`), that file and README step 8 need the flag. Phase 5 owns
  the flag; this phase only documents what Step 0 finds in `install.sh --help`/usage.
- **`~/claude-commands` docs**: phase 2 found `skills/swarm/SKILL.md` does not document spawn env, so
  nothing is written there; this phase only mentions the change from the mcp-notes side (README
  "Who started whom", CHANGELOG "Changed").
- **Version bump / release** (moving `[Unreleased]` to a version, tag, README roadmap "(vX)") is left
  to whoever cuts the next release (`/up-version`).
- Numbering clash: `docs/iterations/08-*` vs. roadmap rows 8/9. Resolved here by naming the brief
  in roadmap row 10; renaming the brief file is not done (other plan files cite its path).

## Rollback

`git revert` the phase-14 commit, or `git checkout <base> -- README.md CHANGELOG.md CLAUDE.md docs/ROADMAP.md`.
No code, data or config depends on these files.
