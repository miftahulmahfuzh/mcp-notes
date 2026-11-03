# Plan: Session ↔ note links, and opening a session's notes in the big editor

**Slug:** session-note-links
**Date:** 2026-11-03 14:26 (Asia/Jakarta)
**Analysis:** `docs/analyzer/20261103-142651-L7NK_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-note-links`
**Branch:** `feature/session-note-links` (base: `origin/main` @ `287b1c4`)
**Phases:** 2
**Status:** planned
**Coordinator:** —

---

## Why

User request (verbatim): "can you link 5-BW7 into 5U-I7 ? so in 5U-I7 Notes Made field we can click 5-BW7 , and clicking it will pop up this note in bigger-view modal? if we haven't implement this feature , we should implement it at once."

Decided design (do not re-litigate):
1. New table note_session_links(note_id -> notes.id on delete cascade, session_id -> cc_sessions.session_id, linked_at; PK(note_id, session_id)) via a new drizzle migration (next is 0009; update src/db/schema.ts, drizzle/meta, and truncateAll in tests/integration/setup.ts). Never rewrite a note's origin. Link writes go through a repo/service, not ad-hoc SQL.
2. MCP tools link_note({note_id, node_id}) and unlink_note({note_id, node_id}); case-insensitive ids like the other tools; clear errors for unknown note / unknown node / deleted note; linking twice is idempotent. Update the /n skill docs (claude/skills/n) so "/n link 5-BW7 into 5U-I7" maps to link_note. No UI link button.
3. Session detail notes = made (origin.claude_session) ∪ linked, deduped, newest first; each NoteRef gains a kind/how field ("made" | "linked"); linked items show a Phosphor link icon in NodePanel. MCP session_get notes reflect the same.
4. Clicking a note in "Notes made" opens the existing NoteEditor (codename bigger-view-on-note) as a modal over the Projects page instead of navigating to the wall; edits/deletes there behave as on the wall; closing returns to the graph with the node panel intact.
5. Update the verify-notesd feature map (.claude/skills/verify-notesd/features/projects.md, notes.md if relevant) per the Proof rules. Proof must use .claude/skills/verify-notesd (up --sessions --web; link via mcp; drive the click in Playwright).

Out of scope: session_get commit URL pointing at the wrong repo for commits made in other repos.

After it lands: rebuild + restart the live daemon, then link 5-BW7 to 5U-I7 with link_note on the live daemon and confirm it shows in session_get.

## Requirements

| ID | What the user asked for | Phases |
|---|---|---|
| R1 | Link an existing note into a session so it shows in "Notes made" (table, `link_note`/`unlink_note`, `/n link`, made ∪ linked with `kind`), then link 5-BW7 into 5U-I7 live | 1 (+ After landing; its feature-map lines are written by 2, see Reconciliation Log #1) |
| R2 | Clicking a note in "Notes made" pops it up in the bigger-view modal; linked items show a link icon | 2 |

## Scope

**In scope:** link table + migration 0009; link/unlink writes on the notes service; MCP `link_note`/`unlink_note`; session detail union with `kind`; /n skill, MCP instructions and README docs; web NoteRef `kind`, link icon, click → NoteEditor over `/projects` and inside NodeModal; verify-notesd feature map; post-landing live deploy and the 5-BW7 → 5U-I7 link.
**Out of scope:** a UI link/unlink button; rewriting `notes.origin`; the session_get commit-URL-in-other-repos bug; any SSE event for link changes.

## Invariants

1. The tree builds, `npm run typecheck` and `npm test` pass at the end of each phase; `npm run test:int` passes at the end of phase 1.
2. A note's `origin` is never written by link/unlink.
3. Link writes go only through `NotesService` (backed by a repo module); no ad-hoc SQL in tools or routes.
4. Ids: note ids and node ids are accepted case-insensitively, dash optional; ids are never invented.
5. Wire field name is `kind`, values exactly `"made" | "linked"`; a note both made and linked is reported once as `"made"`.
6. Esc with the big editor open closes only the editor — never the Projects node panel nor NodeModal.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Server: link table, link_note/unlink_note, made ∪ linked detail | R1 | `src/` (db, notes, sessions, mcp), `drizzle/`, `claude/skills/n`, `README.md`, `tests/` | 17 | — | NORMAL | `.workflows/plan/session-note-links/phase-1.md` | — | — |
| 2 | Web: open session notes in the big editor, link icon; feature map | R2 | `web/src`, `.claude/skills/verify-notesd/features` | 12 | 1 | NORMAL | `.workflows/plan/session-note-links/phase-2.md` | — | — |

### Phase 1 — Server: link table, link_note/unlink_note, made ∪ linked detail
**Satisfies:** R1
**Owns:** `src/db/schema.ts` (`noteSessionLinks`), `drizzle/0009_note_session_links.sql` + `drizzle/meta/0009_snapshot.json` + `_journal.json` (generated), `tests/integration/setup.ts` truncateAll, `src/notes/sessionLinks.ts` (new: `findSessionByNodeId`, `insertLink`, `deleteLink`), `NotesService.linkSession` / `unlinkSession` + `SessionLinkResult` in `src/notes/service.ts`, `NoteRefKind` / `NoteRef.kind` / `NoteRefRow` / `toNoteRef` in `src/sessions/view.ts`, union query in `src/sessions/readModel.ts` (drops local `NoteRow`), MCP `link_note`/`unlink_note` and `session_get` description in `src/mcp/sessionTools.ts`, `src/mcp/instructions.ts`, `README.md`, `claude/skills/n/SKILL.md`, tests `tests/unit/sessions.view.test.ts`, `tests/unit/sessions/linkNoteTool.test.ts` (new), `tests/unit/mcp.instructions.test.ts`, `tests/integration/sessions.noteLinks.int.test.ts` (new).
**Does not touch:** anything under `web/`, `.claude/skills/verify-notesd/` (its feature-map lines go to Phase 2), `src/chat/status.ts` (`SESSION_TOOL_NAMES` stays at five read-only tools).
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run test:int` green; the verify-notesd Proof script (`up --sessions`) prints `RESULT: PASS` (link, idempotent link, the four errors, made-wins dedupe, unlink twice, purge cascade, neighbor check); `drizzle/` gains exactly the three generated 0009 files.

### Phase 2 — Web: open session notes in the big editor, link icon; feature map
**Satisfies:** R2
**Owns:** `web/src/sessionDetailApi.ts` (`SessionNoteKind`, `SessionNoteRef.kind`) + its test, `web/src/components/NoteEditor.tsx` (`EDITOR_SELECTOR`, `isEditorOpen`), `web/src/components/graph/NodePanel.tsx` (+ css, test), `web/src/components/graph/NodeModal.tsx` (+ new test), `web/src/pages/ProjectsPage.tsx`, `web/src/App.tsx` (`openNote` wrapper over `openNoteModal`) + new `web/src/App.projectnotes.test.tsx`, `.claude/skills/verify-notesd/features/projects.md` (including Phase 1's handed-off lines for `link_note`/`unlink_note` and made ∪ linked). `notes.md` is left unchanged.
**Does not touch:** `src/`, `drizzle/`, `tests/`, `claude/skills/n/`, `README.md`.
**Exit criteria:** typecheck and `npm test` green; Journey 1 (`link_note` over MCP; `session_get` shows both kinds; one `note_session_links` row); Journey 2 (Playwright on `up --sessions --web`: plain click on a note in "Notes made" opens NoteEditor over `/projects` with the URL unchanged, Esc / X closes only the editor, the edit reads back over MCP, linked note has the icon and the made note does not); `features/projects.md` documents the link and click drive.

## Reconciliation Log

Round 1. Ledger: no symbol is deleted by one phase and used by another (Phase 1 deletes only the file-local `type NoteRow` in `readModel.ts`, replaced in the same step by `NoteRefRow`); no file is touched by both phases; every Phase 2 `Requires` is created by Phase 1; all 13 analysis impact points have an owner; R1 → 1, R2 → 2. Every Phase 2 change also builds with Phase 1 absent (the parser defaults `kind` to `"made"`), so each phase is build-green on its own.

| # | Conflict | Class | Resolution |
|---|---|---|---|
| 1 | Phase 1 may not touch `.claude/skills/verify-notesd/` but its user-facing change (`link_note`/`unlink_note`, made ∪ linked) needs feature-map lines | Gap | Assigned to Phase 2 (owner of `features/projects.md`). Phase 2 Step 12 now lists the link sub-feature with the dedupe rule, `unlink_note` and `$V sql` drive lines, the result shape and the error codes; the unlink line is placed after the UI steps so it does not remove the note the UI checks. Phase 2 Files row and Requires updated |
| 2 | Phase 2's Proof read `.note.id` from `create`, `.linked`/`.changed` from `link_note`, `notes[].kind` from `GET /api/sessions/:nodeId`, and table `note_session_links`, with a hedge ("adjust the jq path") | Unmet assumption (unconfirmed) | Confirmed against code and Phase 1: `create` returns `{ note }` (`src/mcp/tools.ts:184`), the HTTP route returns `sessionDetail()` unchanged (`src/http/sessionsApi.ts:206-213`), link result `{ note_id, node_id, session_id, linked, changed, made }`, table `note_session_links`. Hedge removed; Journey 1 now asserts the `link_note` result with `jq -e`; the shapes are written into Phase 2's Requires |
| 3 | Phase 2 Journey 2 hard-coded the planner's own session scratchpad path | Contract drift (non-portable step) | Replaced with `$SCRATCH`, the executing session's scratchpad |
| 4 | Phase 2 header pointed at `SESSION_NOTE_LINKS_PLAN.md` without its path, and its Package omitted the feature-map directory it edits | Contract drift | Fixed to `docs/plans/SESSION_NOTE_LINKS_PLAN.md`; Package now lists `.claude/skills/verify-notesd/features` |
| 5 | Index file counts were estimates (~14, ~10) and Owns/Exit criteria predated the plans | Drift (index vs plans) | Phases table set from the plans' Files tables (17, 12); Owns / Does not touch / Exit criteria rewritten to match |
| 6 | Index "After landing" and "Rollback" were empty | Gap | Filled from Phase 1's After landing and both phases' Rollback |

Also checked and found clean: no existing test enumerates every MCP tool in a way the two new tools would break (`chat-status.test.ts` counts the chat allowlist, unchanged; `sessions.mcp.int.test.ts:68-71` checks only `SESSION_TOOL_NAMES`; `bin.int.test.ts:411` only bans purge/forever names); `schema.int.test.ts:51` uses `arrayContaining`, so the new index needs no edit there.

## Decisions

| # | Fork | Choice | Rung |
|---|---|---|---|
| D1 | Wire field name: design said "kind/how" | `kind`, values exactly `"made" \| "linked"` | Stated invariant 5 |
| D2 | Where link writes live: `SessionsRepo` (session tables) or the notes service | `NotesService.linkSession` / `unlinkSession` backed by `src/notes/sessionLinks.ts`; `SessionsRepo` untouched | Stated invariant 3 (also the index Why item 1, "through a repo/service") |
| D3 | `unlink_note` on a soft-deleted note: refuse like `link_note`, or allow | Allowed (removing a link is always allowed); `link_note` refuses with `deleted: … Call restore(…) first.` | Phase 1's code blocks and integration test (`a deleted note cannot be linked … and can still be unlinked`) |
| D4 | Emit an SSE event on link/unlink | No event: the note's body/tags do not change; the panel re-fetches detail when opened | Index Scope (Out of scope: "any SSE event for link changes") |
| D5 | A note both made in and linked to a session | Listed once, as `"made"` (one row per note in an `or exists` query) | Stated invariant 5 |
| D6 | What a click on a note in "Notes made" does: always open the editor, or keep the link for modified clicks | Plain left click (button 0, no modifier) opens NoteEditor in place; Ctrl/Cmd/Shift/Alt and middle click keep the `href="/?note=ID"` and go to the wall, like chat note links | Phase 2's code blocks (Step 4) following the surrounding code's convention (`ChatText.tsx:84-91`) |
| D7 | Esc while the editor is open over NodeModal (NodeModal's capture listener runs first) | NodeModal returns early while `isEditorOpen()` (new export of `NoteEditor.tsx`, DOM check on `[data-modal="editor"]`), as it already does for lightbox and confirm | Stated invariant 6 |
| D8 | `DETAIL_MAX_NOTES` (50) per half or over the union | Over the union, newest first | Phase 1's code blocks and integration test (`DETAIL_MAX_NOTES caps the union, not each half`), matching the analysis' Key Considerations |
| D9 | Phase 1's feature-map lines, which Phase 1 may not write | Written by Phase 2 in `features/projects.md` | Phase 1's Leaves alone and Handoffs (plans' code blocks) |
| D10 | Add `link_note`/`unlink_note` to the chat bar allowlist | No; the chat keeps its five read-only session tools | Phase 1's Interface Contract (Leaves alone) |

## Open Questions

None.

## After landing

Run on the live machine once both phases are merged to `main` in `/home/miftah/mcp-notes`. This touches the live Neon DB and the live daemon on 7317; per the user's standing instruction (memory "No human in the loop"; CLAUDE.md: a commit/push also means rebuild and restart the daemon), run it without asking.

```sh
cd /home/miftah/mcp-notes
git checkout main && git pull --ff-only        # or merge feature/session-note-links into main first

# 1. Migration 0009 on the live DB, BEFORE the restart. install.sh does not migrate and the daemon
#    does not migrate on boot. The table is additive, so the old daemon keeps working meanwhile.
npm ci
npm run db:migrate                             # applies 0009_note_session_links (direct, unpooled URL)

# 2. Rebuild + restart (server + web build, systemd unit, restart notesd, /n skill links, health check).
scripts/install.sh
systemctl --user is-active notesd.service      # -> active
curl -fsS http://127.0.0.1:7317/health         # -> {"ok":true}

# 3. The user's request: link 5-BW7 into 5U-I7 on the live daemon (fresh MCP client, so the new tools are listed).
M=.claude/skills/verify-notesd/scripts/mcp.mjs
node $M http://127.0.0.1:7317/mcp --list | grep -x -e link_note -e unlink_note    # both present
node $M http://127.0.0.1:7317/mcp link_note '{"note_id":"5-BW7","node_id":"5U-I7"}'
#    -> {"note_id":"5-BW7","node_id":"5U-I7","session_id":"90906f13-cc88-40c5-8e60-64ef3191e204","linked":true,"changed":true,"made":false}

# 4. Confirm.
node $M http://127.0.0.1:7317/mcp session_get '{"node_id":"5U-I7"}' | sed 1d \
  | jq -e '[.notes[] | select(.id=="5-BW7")] | length==1 and .[0].kind=="linked"'    # -> true
```

If step 1 says "No direct (unpooled) Postgres URL", `.env.local` is missing (it lives at `/home/miftah/mcp-notes/.env.local`). If step 3 says `not_found: no session 5U-I7`, check the ingester (`journalctl --user -u notesd.service -n 50`); the planner confirmed on 2026-11-03 that 5U-I7 exists live (session `90906f13-cc88-40c5-8e60-64ef3191e204`). `made: true` with `kind: "made"` in step 4 also satisfies the request. Then open `http://localhost:7317/projects?node=5U-I7` and click 5-BW7: the big editor opens over the graph.

## Rollback

- **Phase 2:** revert its commit. It touches only `web/src/**` and `features/projects.md`; the old parser ignores `kind` and note ids go back to linking to the wall.
- **Phase 1:** revert its commit(s) (after Phase 2, or together). On a DB where 0009 was applied (the live Neon DB only after "After landing"), the leftover `note_session_links` table is harmless to the reverted code, which never reads it. To remove it fully, on the direct URL: `drop table note_session_links;` and delete the 0009 row from `drizzle.__drizzle_migrations` (the row with the highest `created_at`), so a later re-apply is not skipped. Links recorded in it are lost by the drop; the notes themselves are untouched (origin was never rewritten).

## Next

    /implement -f docs/plans/SESSION_NOTE_LINKS_PLAN.md --phase 1

Or run the whole set as a swarm:

    /analyze-orchestrator -f docs/plans/SESSION_NOTE_LINKS_PLAN.md
