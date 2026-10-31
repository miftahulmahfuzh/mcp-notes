# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Fixed

- **Note modal off-screen for image-heavy notes**: the editor overlay's single grid column stretched to the thumbnail strip's width (a 58-image note), pushing the panel off the right edge; the column is now `minmax(0, 1fr)`.
- **Image ids in chat open their note**: ids of images quoted in an answer ("image 5-RI4 in note B-SMK") were linked as notes and answered "no note"; they now open the note that holds the image.
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

[v0.1.0]: https://github.com/miftahulmahfuzh/mcp-notes/releases/tag/v0.1.0
