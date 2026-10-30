# Plan: Clickable note ids (wall deep link, skill links, Claude Code mod)

**Slug:** note-id-deeplinks
**Date:** 2026-10-30 18:09 WIB
**Analysis:** `docs/analyzer/20261030-180927-N8LK_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/note-id-deeplinks`
**Branch:** `feature/note-id-deeplinks` (base: `main` @ `2a8530e`)
**Phases:** 3
**Status:** planned
**Coordinator:** —

---

## Why

Make note ids clickable so that clicking one opens the browser on the mcp-notes wall (http://localhost:7317/) with that note selected. Do all three parts, and look for anything related that makes this more robust.

Part 1 - wall deep link (required): on load, and on hashchange/popstate, read ?note=<id> or #<id>, find the note, scroll to it and give it a brief highlight. Handle: note not in the currently loaded/filtered list (active tags, search, text/other mode, Bin view, pagination), note deleted (offer the Bin), id with different case or missing dash, and a note that is expanded or being edited. Add tests next to the existing App/Wall tests.

Part 2 - clickable ids without a mod: the /n skill (~/.claude/skills/n/SKILL.md) should tell Claude to write every note id as a markdown link, e.g. [F-ZH5](http://localhost:7317/?note=F-ZH5), so a supporting terminal makes it a Ctrl/Cmd-click hyperlink. Check whether the user's terminal (WSL2 under Windows, inside tmux) actually passes OSC 8 hyperlinks through, and what tmux config is needed (e.g. allow-passthrough / terminal-features hyperlinks). Update the skill source in ~/mcp-notes/claude if it is kept there and re-run the install so ~/.claude/skills/n is in sync. The wall port may not always be 7317: find where it is configured and avoid hard-coding it if there is a clean way.

Part 3 - a Claude Code mod (optional layer, build it only if it adds value after parts 1 and 2): a mod that redraws messages so any note-id-shaped token becomes a link to the wall, plus an /open <id> slash command that opens the browser from the WSL side (check how a browser is opened from WSL here, e.g. wslview or explorer.exe). Beware of false positives (ids inside code spans, paths, hashes). Use the plugin-authoring skill; mods live under ~/.claude/dev-mods/<session-id>/<mod-name>/ and are validated with `claude plugin validate` and `claude plugin test`. Docs: https://code.claude.com/docs/en/plugins/mods/interface

Follow the repo's conventions (docs, tests, install script). Note that notes O-5KD and V-UM6 contain plaintext secrets: do not copy their contents anywhere.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Wall deep link (`?note=` / `#id`, scroll, highlight, edge cases, tests) | 1 |
| R2 | Skill writes ids as markdown links; OSC 8 through WSL2 + tmux checked and documented; port not hard-coded | 2 |
| R3 | Mod: linkify id-shaped tokens + `/open <id>` from WSL | 3 |
| R4 | Anything related that makes it more robust | 1 (single-note fetch fallback past the 2000-note page, bin offer, SSE-safe), 2 (wall URL from `Config.port` into MCP instructions, tmux doc), 3 (false-positive guards) |

## Scope

**In scope:** the wall reading its URL; the MCP server instructions and `/n` skill telling Claude how to write wall links, with the wall base URL taken from the daemon's configured port; README and INSTALL docs including the tmux `hyperlinks` setting; a Claude Code mod kept in the repo.
**Out of scope:** a `/n/<id>` path route or server redirect; linkifying ids inside note bodies on the wall; editing the user's `~/.tmux.conf.local` (documented, not applied); changing `scripts/install.sh`'s own `PORT=7317` (install-time health check only); copying any note body, in particular O-5KD and V-UM6, into any file or test.

## Invariants

1. The tree builds, `npm run typecheck` and `npm test` pass at the end of each phase.
2. Never run `scripts/install.sh` from the worktree (it would point the user's systemd unit at the worktree). Never bind port 7317 in any run; tests use fakes/port 0.
3. No note content from live data in tests, docs or fixtures; fixtures use made-up ids/bodies. Notes O-5KD and V-UM6 are never read.
4. Link form, everywhere: `[<ID>](<wall>/?note=<ID>)` with `<ID>` canonical `A-B32` and `<wall>` without trailing slash. The wall accepts `?note=` and `#<id>`, any case, dash optional.
5. Existing behaviour is unchanged when the URL has no note target (`jump`, chat citations, `/full/<id>`).

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Wall deep link | R1, R4 | `web/src` | ~8 | — | HARD | `.workflows/plan/note-id-deeplinks/phase-1.md` | — | — |
| 2 | Wall URL into MCP instructions, skill link rule, tmux + docs | R2, R4 | `src/mcp`, `claude/skills/n`, docs | ~8 | — | NORMAL | `.workflows/plan/note-id-deeplinks/phase-2.md` | — | — |
| 3 | `note-links` Claude Code mod | R3 | `claude/mods/note-links` | ~7 | — | NORMAL | `.workflows/plan/note-id-deeplinks/phase-3.md` | — | — |

### Phase 1 — Wall deep link
**Satisfies:** R1, R4
**Owns:** everything under `web/` (lib/deepLink, hook, App wiring, `fetchNote`, extracting `flashNote` to a shared lib, tests), plus the README paragraph describing the deep link under "A tour of the wall".
**Does not touch:** `src/**`, `claude/**`, `docs/INSTALL.md`, any README section other than the deep-link paragraph.
**Exit criteria:** opening `/?note=f-zh5`, `/?note=FZH5` or `/#F-ZH5` selects the note whatever mode/tags/view/editor state the wall is in; hashchange and popstate re-resolve; a deleted id offers the Bin; an unknown id shows a quiet notice; tests pass.

### Phase 2 — Wall URL into MCP instructions, skill link rule, tmux + docs
**Satisfies:** R2, R4
**Owns:** `src/mcp/instructions.ts`, `src/mcp/server.ts`, `src/mcp/tools.ts` (`ToolDeps.wallUrl`), the wiring that builds `ToolDeps` from `Config`, `tests/unit/mcp.instructions.test.ts`, `claude/skills/n/SKILL.md`, README "Using it from Claude Code" subsection on clickable ids and Configuration note, `docs/INSTALL.md` (clickable ids, tmux).
**Does not touch:** `web/**`, `claude/mods/**`, `scripts/install.sh`, dotfiles outside the repo.
**Exit criteria:** instructions carry a Links paragraph whose URL uses the configured port; skill tells Claude to link every id; docs state the tmux line and how to verify; unit tests pass.

### Phase 3 — `note-links` mod
**Satisfies:** R3
**Owns:** `claude/mods/note-links/**` (manifest, hooks module, pure linkify function, tests, its README), one "Repository layout" line in the README.
**Does not touch:** everything else.
**Exit criteria:** `claude plugin validate` and `claude plugin test` pass; linkify has table-driven false-positive tests; `/open <id>` uses `explorer.exe`.

## Reconciliation Log

| Conflict | Phases | Resolution |
|---|---|---|
| README edited by all three phases | 1, 2, 3 | Distinct hunks: P1 Contents line after line 22 + `### Links to a note` before `## Using it from Claude Code`; P2 Contents line after line 26 + `### Clickable note ids` before `### Spending, runs and Seer` + NOTESD_PORT row; P3 one line in the Repository layout block anchored on the `claude/skills/n` line. Any textual conflict at merge: keep both sides |
| Plan files were written one directory above the worktree | 1, 2, 3 | Moved into `.workflows/plan/note-id-deeplinks/` inside the worktree; paths in the table are correct |
| "Build the mod" decision lists ids typed by the person, but P3 does not redraw `UserMessage` rows (drawn as plain text, brackets would show) | 3 | Value for typed ids is delivered by `/open <id>`; Decision reworded below |
| P2's Links paragraph also reaches the wall's chat-bar agent | 1, 2 | Accepted: `AnswerPanel` renders markdown links as `target=_blank` anchors and `extractUsedIds` dedupes repeated ids, so citation chips still work; clicking a link opens the wall in a new tab on that note |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Build the mod (R3 says "only if it adds value") | Build. It adds value parts 1+2 cannot: ids Claude writes without a link (any session, `/n` not loaded), and `/open <id>` for ids the person types or when the terminal does not forward OSC 8; the redraw covers assistant messages only when the terminal does not forward OSC 8 | 5: user's raw input |
| Where the mod lives | `claude/mods/note-links/` in the repo (source of truth, like `claude/skills/n`), optionally symlinked into `~/.claude/dev-mods/e30b4676-77de-4cec-91f5-c581ea53af4e/note-links`; turning it on stays a manual step because the per-session enable prompt can only be answered by a person | 6: surrounding convention |
| Edit `~/.tmux.conf.local` | No: document the exact line (`set -as terminal-features ',xterm*:hyperlinks'`), how to reload and verify; the user applies it. It is a dotfile outside the repo and the request says "check what config is needed" | 5: user's raw input |
| Re-run the install for the skill | Not needed: `~/.claude/skills/n` is a symlink to the repo source. The daemon restart (for new MCP instructions) is a post-merge step from `~/mcp-notes`, never from the worktree | 6: surrounding convention |
| Wall URL source for Claude | MCP server instructions, built from `Config.port` (single source), not a literal in the skill; the skill says "use the wall URL from the notes server's instructions" and falls back to `claude mcp get notes` | 6: surrounding convention |
| Deleted note target | Switch to the Bin view, filtered to nothing, scroll/flash its `data-bin-note` card; notice "deleted, restore it from the Bin" | 5: user's raw input ("offer the Bin") |
| Deleted target and tag filters | P1 drops only the active tags that exclude the deleted note (visible result same as clearing all); one-line flip if wanted | 3: exit criteria |
| Big editor open on another note when a link arrives | It closes through its own close path (draft saved as on Esc, via `closeSignal`); an editor already open on the linked note stays | 2: phase exit criteria |
| Mod tests | Run only under `claude plugin test`; root `vitest`/`tsc` do not include `claude/` | 6: surrounding convention |
| Phases 2 and 3 order | Independent; both add README text in different sections | 3: exit criteria |

## Open Questions

None.

## Rollback

Per phase: `git revert` its merge commit. P1 is web-only (rebuild `web/dist`); P2 needs a daemon restart to drop the instructions paragraph; P3 is files only (remove the symlink under `~/.claude/dev-mods`). As a whole: revert the three commits.

## Next

    /implement -f docs/plans/NOTE_ID_DEEPLINKS_PLAN.md --phase 1

Or run the whole set as a swarm:

    /analyze-orchestrator -f docs/plans/NOTE_ID_DEEPLINKS_PLAN.md
