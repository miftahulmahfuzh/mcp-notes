# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Image lightbox**: click a photo in the big editor's strip to see it large; arrows (click or
  keys) move between the note's photos without closing, Esc closes only the photo (R4).

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
