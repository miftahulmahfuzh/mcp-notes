# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Project session graph** (`/projects`): every Claude Code session on both laptops, per repo, as a git-graph of lanes on a time axis, newest at the top. Hand-started sessions form the trunk; sessions they spawned branch off, folded into a `+N` chip. Running sessions pulse, the other laptop's are marked, and only visible nodes are drawn (smooth at ~1000). A rail icon opens the repo list in the sidebar; the picked repo is stored server-side (`app_settings`), so both laptops agree. The graph polls every 10 s with `If-None-Match` (`304` when unchanged).
- **Session ingest**: a background job reads `~/.claude/projects/**/*.jsonl` into `cc_sessions` (migration 0007): repo (worktree paths resolved even after the worktree is gone), branch, name, titles, prompts, times, tokens and cost, commits, files and plan docs. It backfills everything on disk on first start and then reads only appended bytes. `sdk-ts` / `sdk-cli` sessions are skipped. `CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SESSIONS=off`.
- **Node ids** like `A0-3G` for every session, generated server-side. Typing one (upper case, with the dash) into any Claude Code prompt makes the `notes-prompt` hook add that session's summary, plan docs, commits and transcript path via `GET /api/sessions/context`; a prompt with no id still costs one regex test.
- **Exact parent links**: new `notes-session` (SessionStart) and `notes-spawn` (Bash PreToolUse) hooks and `POST /api/sessions/hook/start|spawn`. A session reports its parent from `CC_PARENT_SESSION` and learns its own and its parent's node id; a `claude` launched by hand in a tmux window claims the pending spawn its parent left (30 s window). Older sessions get `heuristic` links from their parents' transcripts (`swarm.py launch|spawn --name`, `SendMessage {to}`).
- **Session summaries and search**: sessions idle for 15 minutes are summarized once with Claude Haiku (secrets redacted first), embedded, and searched with the same hybrid blend as notes; the backlog is summarized in the background.
- **Session tools** for MCP and the chat bar: `sessions_search`, `session_get`, `session_transcript` (owning machine only, else `not_on_this_machine`), `sessions_usage` (tokens and cost per session or month) and `session_resume`. Read API under `/api/projects` and `/api/sessions`.
- **Node panel**: summary, prompts, commits, notes made, tokens; Tree / Timeline (Gantt) toggle for the subtree; resume (or spawn fresh) into a new tmux window with no confirm, except for a session on the other laptop. A live session is focused or messaged instead of resumed twice. A deleted worktree falls back to the repo's main checkout, then `~/<repo>`, then `$HOME`, and the answer carries `original_cwd`. `POST /api/sessions/:nodeId/resume`, same-origin only; `NOTESD_TMUX_SOCKET`, `NOTESD_TMUX_BIN`.
- **Per-project chat**: a chat pill under the graph keeps its threads to that repo (`project` on `POST /api/chat`, stored as `chat_threads.project`), and the project header toggles between the graph and that project's chat history (`GET /api/chat/messages?project=`).
- **"unfinished" badge** on orchestrator nodes whose swarm still has pending phases and no live session, from `swarm.py verify` (`NOTESD_SWARM_SCRIPT`, cached 60 s).

### Changed

- `scripts/install.sh` registers five Claude Code hooks instead of three and raises `cleanupPeriodDays` in `~/.claude/settings.json` (to `NOTES_CLAUDE_RETENTION_DAYS`, default 3650) so Claude Code keeps the transcripts the graph reads; `scripts/uninstall.sh` removes all five and leaves `cleanupPeriodDays` alone. Re-run `scripts/install.sh` after updating, and `npm run db:migrate` once.
- `notes-prompt` now looks at every prompt for a node id, not only `/n` prompts. Without one it still does no I/O.
- In `~/claude-commands`, `swarm.py`'s `spawn_argv` passes `-e CC_PARENT_SESSION=<CLAUDE_CODE_SESSION_ID>` to every session it spawns (a tmux child does not inherit its parent's environment). Pull that repo and run its `./sync.sh` to get exact links for swarm children.

## [v0.2.0] - 2026-10-31

Chat history, note files, image similarity search, and Claude Code hooks that turn
pasted pictures into notes.

### Added

- **Same-prompt pasted image to note**: `create_image` and `attach_image` accept `pasted_image` (the N of `[Image #N]`); the `notes-paste` PreToolUse hook now also covers them, uploads that picture and hands the call on with `image_id`. Needed because Claude Code writes a prompt to the transcript only after UserPromptSubmit hooks finish (measured live), so the `notes-prompt` hook cannot name an image pasted in the same `/n` prompt; it now tells Claude to use `pasted_image N` for it. Without the hook the server refuses with `pasted_image_unresolved` and a pointer. Re-run `scripts/install.sh` to widen the installed matcher.
- **Pasted image to note**: `create_image` and `attach_image` take `image_id`, the id of an image pasted into the wall chat or a Claude Code `/n` prompt (like `G-0NC`, any case, dash optional), as an alternative to `path` (exactly one of the two). Same copy and sha256 dedupe (`created: false` / `attached: false` for a known picture); an unknown id is refused as "no pasted image". The wall agent and `/n` now use it for "make that image a note" instead of asking for a file path.
- **Claude Code prompt hook** (`notes-prompt`, UserPromptSubmit, `/n` prompts only): stores the session's pasted images (newest 8, 20 MB each, every turn of the session) in the chat image store before Claude answers and tells it their ids, latest marked, so "that image" resolves. Other prompts are untouched. Logs to `~/.local/state/notes-capture/prompt.log`; `npm run verify:prompt-hook` checks it live.
- **Note-id links in chat**: ids in answers and history bubbles open the big editor in place (fetched, deleted and unknown ids handled quietly); the editor's "Show on wall" icon goes to `/?note=<id>` and flashes the card.
- **Chat history bubble actions**: reply to any bubble (quote chip above the composer, `reply_to` sent, quoted header jumps to the original), edit your questions in place (kept as a revision, marked "edited"; the answer is not regenerated), delete any bubble with a 6 s undo and an option to drop its answer, and a "Show deleted" toggle with restore.
- **Claude Code capture**: a Stop hook saves every `/n` exchange (prompt, final answer, pasted images) to the chat history as a `claude_code` thread through `POST /api/capture/claude-code` (loopback, header-guarded, idempotent, with an outbox when the daemon is down); a PreToolUse hook lets `/n` search with a pasted image via `similar_images({pasted_image: 1})`; `install.sh` merges both hooks into `~/.claude/settings.json` (`--skip-hooks`), `uninstall.sh` removes them.
- **Image lightbox**: click a photo in the big editor's strip to see it large; arrows (click or
  keys) move between the note's photos without closing, Esc closes only the photo (R4).
- **Paste images into the chat bar**: with the bar focused, a pasted image uploads to a separate chat image store (`chat_images`, sha256-deduped, never a note) and shows as a removable thumbnail; the question goes out with up to four images, even with no text, and the agent receives them as image blocks named `[image upload:ID]`.
- Note files on the wall: a paperclip picker, drop and ctrl-v in the note editor attach any file. Files show as chips with download, reveal and undoable remove. Cards show a file count. The note-level "Show in Explorer" opens the note's files folder.
- **Note files (server)**: `note_files` table (migration 0004), `files/<noteId>/` store with sha256 dedupe, attach/remove/restore/download routes, per-file and note-level reveal, and `files` on every note for MCP and the chat agent.
- **Chat history (backend)**: wall chat turns are stored in our own tables (migration 0006) and each turn's context is rebuilt from them; Agent SDK `resume` and session files are gone, so Claude and GLM see the same prompt. `[msg:ID]` labels, a leading `[msg:ID]` in an answer becomes `reply_to`, edit/delete/restore and a paged timeline API, `event: chat` on `/api/events`.
- **Image similarity search**: Gemini Embedding 2 image vectors in `note_image_embeddings`, a background worker, `npm run embed:images:backfill` (`--dry-run`, `--limit`, `--retry-failed`) and the `similar_images` MCP tool (by image id, wall-chat upload or text query), on the wall chat's allow list.
- **Chat history page** (`/history`): every wall chat and captured `/n` exchange on one timeline in Jakarta time, with thread dividers, a "claude code" badge, image thumbnails that open the lightbox, live updates, and a pill at the bottom to keep chatting (paste images there too). It opens from a new sidebar icon above the recycle bin and from a "Chat in full screen" button on the answer panel.

### Changed

- `notes-prompt` no longer waits 2.5 s for the current prompt to appear in the transcript (it never does while a hook blocks); it reads once.
- `scripts/install.sh` registers three Claude Code hooks (notes-capture, notes-paste, notes-prompt) instead of two; `scripts/uninstall.sh` removes all three.

### Fixed

- A picture pasted with a `/n` slash command was invisible to the prompt, paste and capture hooks: Claude Code writes it on the `isMeta` skill-body entry after the command, without `imagePasteIds`, and the hooks only read the command entry. They now count those meta pictures as the command's own.

- **Note modal off-screen for image-heavy notes**: the editor overlay's single grid column stretched to the thumbnail strip's width (a 58-image note), pushing the panel off the right edge; the column is now `minmax(0, 1fr)`.
- **Image ids in chat open that image**: ids of images quoted in an answer ("image 5-RI4 in note B-SMK") were linked as notes and answered "no note"; clicking one now opens that image in the lightbox (arrows walk the other images of its note), without leaving the page.
- Wall card footer: the "Show in Explorer" icon now sits right after the copy-ID icon instead of floating mid-footer.

## [v0.1.0] - 2026-10-30

First tagged release of mcp-notes: a personal plain-text note store in Postgres,
exposed to Claude Code over MCP and to the browser as "the wall".

### Added

- **Notes spine**: notes service, `notesd` daemon and MCP server with create, get, list,
  update, append, delete/restore, revisions/revert, tags (parsed from `#hashtags` in the body)
  and short ids (`A-B32`). Ships the `/n` skill, a systemd unit and install scripts.
- **Images**: image store with derivatives, ingest service, inbox watcher, HTTP routes and
  upload, per-image `note_images` table, and MCP tools to create, attach, remove, restore
  and view images. Image and date filters on list/search.
- **Web UI (the wall)**: wall, rail, sidebar, header, inline edit, live updates over SSE,
  gallery, photo modal, full-screen view, drag/paste upload, a big note editor modal,
  delete with undo, recycle bin, "reveal in Explorer", tag autocomplete while typing `#`,
  a collapsible answer panel, a multi-line chat bar, readable links in answers and a tab icon.
- **Chat bar brain**: Agent SDK backend (Claude with a GLM fallback), threads, guardrails,
  status captions and brain label in the panel.
- **Connectors**: read-only generic and curated tools for the user's own apps —
  expense-tracking, run-insights and Seer (leaderboard, positions, Sera methods) —
  wired into the chat bar allow list and the `/n` skill.
- **Semantic search**: pgvector schema, OpenRouter embedder, background embedding worker and
  `embed:backfill` CLI, hybrid search (words, meaning, tags, recency) and the `related` tool.
- **Clickable note ids**: Claude Code mod that links note ids to the wall, `/open <id>`,
  and wall deep links (`?note=<id>` / `#<id>`).
- **`/migrate` skill**: moves a folder of images into one image note, then deletes the folder.
- Pinned Node 22.23.4 via `.nvmrc`; README with screenshots and GIFs.

### Fixed

- Photo modal text fell back to a serif font.
- Long words no longer spill out of a note card.
- Connector `_sql` no longer cuts off a query that ends in a literal.
- Images whose files are not on this machine are hidden in the gallery, note cards,
  recycle bin and editor instead of showing broken tiles.

[v0.2.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.2.0
[v0.1.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.1.0
