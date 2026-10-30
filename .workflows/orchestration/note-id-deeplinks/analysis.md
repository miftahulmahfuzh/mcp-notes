# Code Analysis: clickable note ids (wall deep link, skill links, Claude Code mod)

**Type:** Feature Implementation
**Date:** 2026-10-30 18:09 WIB
**Session ID:** 20261030-180927-N8LK
**Plan:** `docs/plans/NOTE_ID_DEEPLINKS_PLAN.md` (3 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/note-id-deeplinks`, branch `feature/note-id-deeplinks` (base `main` @ 2a8530e; `origin/main` does not exist locally, checkout was clean)

---

## User Input

### Original User Request

Make note ids clickable so that clicking one opens the browser on the mcp-notes wall (http://localhost:7317/) with that note selected. Do all three parts, and look for anything related that makes this more robust.

Context from the previous session (repo: ~/mcp-notes):
- The wall (web/src/App.tsx) has scrollToNote(id), which finds [data-note="<id>"] and scrolls to it. Today it is only triggered by chat citations. Nothing reads the URL: the only deep link is /full/<imageId> (or ?id=) for the fullscreen image viewer (web/src/fullscreen/FullscreenApp.tsx).
- Note ids look like A-B32 (one char, dash, three chars, 0-9A-Z). Server lookup is case-insensitive and tolerates a missing dash, so the deep link should normalise the same way.

Part 1 - wall deep link (required): on load, and on hashchange/popstate, read ?note=<id> or #<id>, find the note, scroll to it and give it a brief highlight. Handle: note not in the currently loaded/filtered list (active tags, search, text/other mode, Bin view, pagination), note deleted (offer the Bin), id with different case or missing dash, and a note that is expanded or being edited. Add tests next to the existing App/Wall tests.

Part 2 - clickable ids without a mod: the /n skill (~/.claude/skills/n/SKILL.md) should tell Claude to write every note id as a markdown link, e.g. [F-ZH5](http://localhost:7317/?note=F-ZH5), so a supporting terminal makes it a Ctrl/Cmd-click hyperlink. Check whether the user's terminal (WSL2 under Windows, inside tmux) actually passes OSC 8 hyperlinks through, and what tmux config is needed (e.g. allow-passthrough / terminal-features hyperlinks). Update the skill source in ~/mcp-notes/claude if it is kept there and re-run the install so ~/.claude/skills/n is in sync. The wall port may not always be 7317: find where it is configured and avoid hard-coding it if there is a clean way.

Part 3 - a Claude Code mod (optional layer, build it only if it adds value after parts 1 and 2): a mod that redraws messages so any note-id-shaped token becomes a link to the wall, plus an /open <id> slash command that opens the browser from the WSL side (check how a browser is opened from WSL here, e.g. wslview or explorer.exe). Beware of false positives (ids inside code spans, paths, hashes). Use the plugin-authoring skill; mods live under ~/.claude/dev-mods/<session-id>/<mod-name>/ and are validated with `claude plugin validate` and `claude plugin test`. Docs: https://code.claude.com/docs/en/plugins/mods/interface

Follow the repo's conventions (docs, tests, install script). Note that notes O-5KD and V-UM6 contain plaintext secrets: do not copy their contents anywhere.

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Wall deep link: `?note=<id>` / `#<id>` on load and on hashchange/popstate, scroll + brief highlight, with the listed edge cases, plus tests beside App/Wall tests |
| R2 | Clickable ids without a mod: `/n` skill writes every id as a markdown link; check OSC 8 through WSL2 + tmux and the tmux config needed; skill source in repo and install in sync; no hard-coded port where a clean way exists |
| R3 | Optional Claude Code mod: linkify id-shaped tokens when messages are drawn, `/open <id>` opening the browser from WSL; avoid false positives; build only if it adds value |
| R4 | "Anything related that makes this more robust" (open-ended; owned by the phases below as stated in the index) |

---

## Detailed Requirements Understanding

**Problem.** A note id (`F-ZH5`) shown in the terminal is inert text. The wall at `http://localhost:7317/` can already scroll to a note, but only from inside the page (chat citation chips call `jump(id)`); the URL is never read.

**Success.** Ctrl/Cmd-click on a note id in a Claude Code reply opens the wall in the Windows browser with that note scrolled into view and briefly highlighted, for any state the wall might be in.

**Assumptions.**
- The wall is reached from Windows at `localhost:<NOTESD_PORT>` via WSL2 localhost forwarding (README, "Install on WSL").
- `/analyze` cannot edit source; the plans carry complete code.
- An unattended session cannot answer the "Turn on the mods" prompt, so the mod can be written and validated, but turned on only by the person (see Decisions in the index).
- `scripts/install.sh` runs the daemon from the checkout it lives in. It must never be run from this worktree (it would re-point the user unit at the worktree). The instructions change needs a daemon restart, which the owner does from `~/mcp-notes` after merge.

---

## Analysis Scope

### Explicitly mentioned
- `web/src/App.tsx`, `web/src/fullscreen/FullscreenApp.tsx`, `~/.claude/skills/n/SKILL.md`

### Discovered related files
- `web/src/components/DropOverlay.tsx:39` `flashNote(id, delayMs)`: scrolls `[data-note]` into view (`block: center`) and plays a 1.6 s outline animation. Already the "brief highlight"; used for dedupe hits. Reusable for R1.
- `web/src/components/NoteCard.tsx:72` `data-note={note.id}` on the wall card; `web/src/components/Gallery.tsx:52` `data-note` on gallery tiles (images mode); `web/src/components/Bin.tsx:61` `data-bin-note={id}` on bin cards (a different attribute).
- `web/src/lib/filter.ts` `visibleOnWall`, `matchesTags`, `isHiddenByMode`: the wall's filtering rules.
- `web/src/hooks/useNotes.ts`: loads `GET /api/notes?limit=2000` once (no paging in the UI), refetches on SSE `note` events; `upsertLocal`, `removeLocal`.
- `web/src/hooks/useBin.ts` + `web/src/api.ts` `fetchBin(tags)`: deleted notes list, only fetched while `view === 'bin'`.
- `src/http/api.ts:127` `GET /api/notes/:id`: normalises the id (`normalizeId`), returns the live note or 404 (a deleted note is also 404, `service.getOne` returns null).
- `src/notes/ids.ts` `normalizeId`: `/^([0-9A-Z])-?([0-9A-Z]{3})$/` after trim + upper-case.
- `src/http/static.ts`: `/` (any query/hash) serves `index.html`; `/full/<id>` serves `fullscreen.html`.
- `src/mcp/instructions.ts` `buildInstructions(timeZone)`, called from `src/mcp/server.ts:14` `createMcpServer(deps)` with no config; `ToolDeps` has no port. `Config.port` (`src/config.ts`, default 7317, env `NOTESD_PORT`) is known to the daemon (`src/daemon.ts`, `src/http/app.ts`) but not to the MCP server factory.
- `tests/unit/mcp.instructions.test.ts`: instruction wording tests.
- `scripts/install.sh`: `PORT=7317` hard-coded at the top (health URL, MCP URL); symlinks `claude/skills/n` into `~/.claude/skills/n`. `~/.claude/skills/n` is already a symlink to the repo source, so editing the repo skill is the sync; no re-install is needed for the skill, only for the daemon (instructions).
- README: wall URL at lines 5, 463, 545; "Using it from Claude Code" at 256; Configuration table at 522 (`NOTESD_PORT`); "Repository layout" at 700. `docs/INSTALL.md` mentions 7317 at lines 3, 42, 44, 51.
- Existing wall tests: `web/src/App.test.tsx` (383 lines, stubs `fetch`, uses `makeNote` from `web/src/testing/fixtures.ts`), `web/src/App.bin.test.tsx`, component tests beside components.

---

## Current Dataflow

### Wall: how a note gets scrolled to today

1. Chat answer streams into `useChat`; `extractUsedIds(chat.text, ids)` yields cited ids.
2. `AnswerPanel` renders a `.usedchip` per id, `onClick={() => onJump(id)}` (`App.tsx:76` `jump`).
3. `jump(id)`: finds the note in `notes`; if the view is the Bin, sets `view='wall'`; if the note is hidden by mode (`text` mode and the note has images, or `images` mode) sets `mode='all'`; calls `scrollToNote(id)` (immediately, or after 50 ms when the DOM must change first).
4. `scrollToNote` (`App.tsx:33`): `document.querySelector('[data-note="<id>"]')` then `window.scrollTo({ top: rect.top + scrollY - 140, smooth })`. **No highlight, no escaping of the id, no handling of "not found".**

Gaps in `jump` relevant to a URL entry point: it does not clear `active` tags or the search; it does not know about a note that is not in `notes`; it never highlights; it does not close the big editor; it cannot run before the first fetch resolves.

### Wall: what can hide a note that exists

| Cause | Where | Visible after |
|---|---|---|
| Mode `text` hides notes with images | `visibleOnWall` | `mode='all'` |
| Mode `images` shows the gallery, tiles carry `data-note` per image | `Gallery.tsx` | a tile exists only for notes with images |
| Active tag filter (AND) | `visibleOnWall`/`matchesTags` | `setActive([])` (or clear only if non-matching) |
| View `bin` | `App.tsx` ternary | `view='wall'` |
| Note being edited / expanded is always kept (`keep` list) | `visibleOnWall` | n/a |
| Not in the first 2000 notes | `fetchNotes` limit | `GET /api/notes/:id` then `upsertLocal` |
| Deleted | server 404 on `/api/notes/:id` | listed by `GET /api/bin` |
| Never existed / malformed id | 404 / 400 `invalid_id` | no note |
| Not yet loaded | `useNotes().loaded === false` | wait for `loaded` |

`search` (`q`) is the chat bar's question box, not a wall filter; the wall has no text-search filter. The request's "search" case therefore reduces to the chat answer panel being open (it highlights/dims cards via `usedIds`; opening a deep link should not leave unrelated dimming that hides the target: `dim` cards stay visible, so no action).

### Skill / MCP: how Claude learns what to write

1. `claude/skills/n/SKILL.md` (219 lines) tells Claude to quote ids as `A-B32`; port 7317 appears in the Deleting and failure sections as a literal.
2. The MCP server `instructions` string (built at each POST /mcp, stateless) repeats the id rules; it has no mention of the wall URL.
3. Nothing gives Claude the wall's base URL except the literal in the skill; `claude mcp get notes` shows the MCP URL (`http://localhost:<port>/mcp`), from which the base derives.

### Terminal: OSC 8 path (measured on this machine, 2026-10-30)

- Windows Terminal (`WT_SESSION` set) under WSL2, `tmux 3.4`, `TERM=tmux-256color`, `TERM_PROGRAM=tmux`, `allow-passthrough off`.
- `tmux list-clients -F '#{client_termname} #{client_termfeatures}'` → `xterm-256color bpaste,ccolour,clipboard,cstyle,focus,title`: **no `hyperlinks`**. tmux 3.4 drops OSC 8 from panes for a client whose terminal features lack `hyperlinks`.
- `terminal-features` (global, server) has `xterm*:clipboard:ccolour:cstyle:focus:title`, `screen*:title`, `rxvt*:ignorefkeys`; neither `~/.tmux.conf` (Oh my tmux) nor `~/.tmux.conf.local` mentions `hyperlinks`.
- Windows Terminal supports OSC 8 (Ctrl+click); tmux needs `set -as terminal-features ',xterm*:hyperlinks'` (tmux >= 3.4). `allow-passthrough` is not needed for OSC 8 (it is for raw DCS passthrough); the setting takes effect for clients attached after it is set.
- Claude Code draws markdown links as OSC 8 spans on the terminal (types: `LinkProps` "an OSC 8 span on the terminal, else its text then the URL in dim"), so a markdown link in a reply is Ctrl-clickable once tmux forwards it.
- Browser from WSL: `wslview` and `xdg-open` are absent; `/mnt/c/WINDOWS/explorer.exe`, `powershell.exe`, `cmd.exe` and `wslpath` exist. `explorer.exe <url>` opens the default browser (exit code is 1 even on success). Existing precedent: `src/http/reveal.ts` ("Open file location") spawns `explorer.exe` from the daemon.

### Claude Code mod surface (from this build's types)

- `ui.render` hook on `{ component: 'AssistantMessage' }` receives `{ text (markdown), isFirstOfReply, isSummary, ... }`; `next({ ...e, text })` rewrites the drawing only; the stored message is unchanged. `UserMessage` is the same for the person's own rows.
- `$.command.register({ name, description })` in `session.start`, answered by a `command.run` hook returning `{ text }`.
- `$.process.run(argv)` reaches `explorer.exe`; `$.fs` reads files; `Link` element is an OSC 8 span.
- Writing a mod folder under `~/.claude/dev-mods/<session-id>/` raises a per-session yes/no prompt answered only by a person. A one-shot unattended session cannot enable it.

---

## Key Data Structures

- `Note` (`web/src/types.ts`): `{ id, body, tags, created_at, updated_at, deleted_at?, origin, images[] }`.
- `Mode = 'text' | 'images' | 'all'`, `View = 'wall' | 'bin'`.
- `Config` (`src/config.ts`): `port`, `host`, `dataDir`, ...
- `ToolDeps` (`src/mcp/tools.ts:10`): `service, dataDir, db, connectors?`.

## Dependencies

- Env `NOTESD_PORT` (daemon port), `scripts/install.sh` `PORT=7317` (install-time checks only).
- Windows browser reached through WSL2 localhost forwarding.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `scrollToNote` | web/src/App.tsx:33 | def | web |
| `jump` | web/src/App.tsx:76 | def + call (AnswerPanel `onJump`, Header `onJumpLast`) | web |
| `flashNote` | web/src/components/DropOverlay.tsx:39 | def (+ call line 90) | web |
| `data-note` | NoteCard.tsx:72, Gallery.tsx:52 | def | web |
| `data-bin-note` | Bin.tsx:61 | def | web |
| `fetchNotes` limit 2000 | web/src/api.ts:30 | def | web |
| `GET /api/notes/:id` | src/http/api.ts:127 | def | server |
| `normalizeId` | src/notes/ids.ts | def | server |
| `buildInstructions` | src/mcp/instructions.ts, src/mcp/server.ts:14, tests/unit/mcp.instructions.test.ts | def, call, test | server |
| `PORT=7317` | scripts/install.sh | config | scripts |
| `7317` literals | README.md:5,458,463,491,545; docs/INSTALL.md:3,42,44,51; claude/skills/n/SKILL.md (Deleting, failure section) | doc | docs |
| `reveal` spawn of explorer.exe | src/http/reveal.ts | precedent | server |

---

## Impact Points (files that WILL need changes)

1. `web/src/lib/deepLink.ts` (+ test) new: parse `?note=`/`#`, normalise ids. (P1)
2. `web/src/App.tsx`, `web/src/components/DropOverlay.tsx` or a new `web/src/lib/flash.ts` (extract `flashNote`), `web/src/hooks/useDeepLink.ts` new, `web/src/api.ts` (`fetchNote`), `web/src/App.deeplink.test.tsx` new. (P1)
3. `src/mcp/instructions.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts` (`ToolDeps.wallUrl?`), the daemon/app wiring that builds `ToolDeps`, `tests/unit/mcp.instructions.test.ts`. (P2)
4. `claude/skills/n/SKILL.md`, `README.md`, `docs/INSTALL.md` (tmux + links). (P2)
5. `claude/mods/note-links/**` new (source of truth), README pointer. (P3)

**This document describes. The plan files prescribe.**
