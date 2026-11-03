# Code Analysis: session ↔ note links, and opening a session's notes in the big editor

**Type:** Feature Implementation
**Date:** 2026-11-03 14:26 (Asia/Jakarta)
**Session ID:** 20261103-142651-L7NK
**Plan:** `docs/plans/SESSION_NOTE_LINKS_PLAN.md` (2 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/session-note-links`, branch `feature/session-note-links` (base `origin/main` @ `287b1c4`)

---

## User Input

### Original User Request

```
feature
Feature: link existing notes to Claude Code sessions, and open a session's notes in the bigger-view modal from the Projects page.

User request (verbatim): "can you link 5-BW7 into 5U-I7 ? so in 5U-I7 Notes Made field we can click 5-BW7 , and clicking it will pop up this note in bigger-view modal? if we haven't implement this feature , we should implement it at once."

Decided design (do not re-litigate):
1. New table note_session_links(note_id -> notes.id on delete cascade, session_id -> cc_sessions.session_id, linked_at; PK(note_id, session_id)) via a new drizzle migration (next is 0009; update src/db/schema.ts, drizzle/meta, and truncateAll in tests/integration/setup.ts). Never rewrite a note's origin. Link writes go through a repo/service, not ad-hoc SQL.
2. MCP tools link_note({note_id, node_id}) and unlink_note({note_id, node_id}); case-insensitive ids like the other tools; clear errors for unknown note / unknown node / deleted note; linking twice is idempotent. Update the /n skill docs (claude/skills/n) so "/n link 5-BW7 into 5U-I7" maps to link_note. No UI link button.
3. Session detail notes = made (origin.claude_session) ∪ linked, deduped, newest first; each NoteRef gains a kind/how field ("made" | "linked"); linked items show a Phosphor link icon in NodePanel. MCP session_get notes reflect the same.
4. Clicking a note in "Notes made" opens the existing NoteEditor (codename bigger-view-on-note) as a modal over the Projects page instead of navigating to the wall; edits/deletes there behave as on the wall; closing returns to the graph with the node panel intact.
5. Update the verify-notesd feature map (.claude/skills/verify-notesd/features/projects.md, notes.md if relevant) per the Proof rules. Proof must use .claude/skills/verify-notesd (up --sessions --web; link via mcp; drive the click in Playwright).

Findings already traced (verify, but don't re-explore from scratch):
- Server: src/sessions/readModel.ts ~L326 selects notes by origin ->> 'claude_session' (limit DETAIL_MAX_NOTES) and maps to NoteRef {id, excerpt, tags, created_at} at ~L350; NoteRef/SessionDetail in src/sessions/view.ts ~L113/L154. MCP session tools: src/mcp/sessionTools.ts. Notes MCP tools: src/mcp/tools.ts (idField, run()).
- Web: NodePanel.tsx ~L274 renders <a href="/?note=ID"> per note; client shape SessionNoteRef {id, preview} parsed in web/src/sessionDetailApi.ts noteRef() ~L142. NodePanel is rendered by ProjectsPage.tsx L107 and by NodeModal.tsx L51 (NodeModal used from App.tsx via NodeLinks).
- App.tsx owns the big editor: `expanded` state (L74), expandedNote derived from the notes store with a lastExpanded fallback (L126), expand() at ~L222, closeEditor ~L234, editor portal `{expandedNote && createPortal(<NoteEditor .../>)}` ~L896 sits outside the view switch. fetchNote(id) exists in web/src/api.ts:38 and App already uses it (~L550) for notes not in the store. ProjectsPage is rendered at App.tsx ~L833 with onSelectNode; thread an onOpenNote(id) prop App -> ProjectsPage -> NodePanel (and NodeModal).
- ProjectsPage.tsx ~L75 closes the node panel on Escape unless e.defaultPrevented: the editor's Esc must close only the editor, not the panel.

Out of scope: session_get commit URL pointing at the wrong repo for commits made in other repos.

After it lands: rebuild + restart the live daemon, then link 5-BW7 to 5U-I7 with link_note on the live daemon and confirm it shows in session_get.
```

### User-Provided Context
The design list above is fixed by the user; it is the specification.

### User-Provided Files
None (`@` files): the request names paths in prose only.

### Requirement IDs

| ID | What the user asked for |
|---|---|
| R1 | Link an existing note (5-BW7) into a session (5U-I7) so it shows in that session's "Notes made": a link table, `link_note`/`unlink_note` MCP tools, `/n link …` in the skill, session detail = made ∪ linked with a kind |
| R2 | Clicking a note in "Notes made" on the Projects page pops it up in the bigger-view modal (NoteEditor), with a link icon on linked items |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** Today a session's "Notes made" is derived only from `notes.origin->>'claude_session'`: a note saved elsewhere can never appear under a session, and rewriting `origin` is forbidden. A many-to-many link table adds explicit links. The web panel renders each note as `<a href="/?note=ID">`, which navigates away from `/projects` to the wall; the user wants it to open the big editor in place instead.

**Success Criteria.**
- `link_note({note_id:"5bw7", node_id:"5ui7"})` succeeds on the live daemon; calling it again is a no-op success; `session_get({node_id:"5U-I7"}).notes` contains `{id:"5-BW7", kind:"linked", …}`.
- `unlink_note` removes it; unlinking a non-link is a no-op success (idempotent, mirrors delete/restore).
- Unknown note → `not_found`; deleted note → a clear `deleted` error; unknown node → `not_found: no session …`; malformed node id → `invalid_node_id`.
- A note both made in and linked to a session appears once, as `made`.
- On `/projects?node=…`, clicking a note opens NoteEditor over the page; Esc / X / backdrop closes only the editor; the node panel stays open; edits and deletes persist exactly as on the wall.
- Linked notes show a Phosphor link icon.
- Same click behavior inside NodeModal (the chat pop-up of a node), where Esc with the editor open must close only the editor.

**Key Considerations.**
- Purging a note (bin "delete forever") hard-deletes `notes` rows: `on delete cascade` drops its links. Soft-deleted notes are already filtered out of detail by `deleted_at is null`.
- `cc_sessions` rows are not deleted in normal operation; the FK to `cc_sessions.session_id` uses `on delete cascade` too so a test truncate or future cleanup cannot strand rows.
- Both machines share the DB, so a link made on one host shows on the other with no disk concerns.
- `DETAIL_MAX_NOTES` caps the union, not each half.
- The note service is the documented single writer for note state; link writes are placed on `NotesService` (backed by a small repo module), not in `SessionsRepo`, whose contract is the ingester's session tables.
- NodeModal and NoteEditor both register window capture-phase Esc listeners; NodeModal registers first (mounted first) so today it would win. It must yield while the editor is open, as it already does for the lightbox and confirm dialog.

**Assumptions.**
- `kind` is the field name (the design says "kind/how"; `kind` chosen).
- No SSE event is emitted for a link change: the note's body/tags do not change, and NodePanel re-fetches session detail when opened.
- The live migration (`npm run db:migrate`, unpooled URL) is part of the post-landing deploy; the table is additive.

---

## Analysis Scope

### Explicitly Mentioned Files
- `src/sessions/readModel.ts`, `src/sessions/view.ts`, `src/mcp/sessionTools.ts`, `src/mcp/tools.ts`
- `web/src/components/graph/NodePanel.tsx`, `web/src/sessionDetailApi.ts`, `web/src/pages/ProjectsPage.tsx`, `web/src/components/graph/NodeModal.tsx`, `web/src/App.tsx`, `web/src/api.ts`
- `src/db/schema.ts`, `drizzle/`, `tests/integration/setup.ts`, `claude/skills/n/SKILL.md`, `.claude/skills/verify-notesd/features/projects.md`

### Discovered Related Files
- `src/notes/service.ts` — `NotesService`, single writer for notes; `NoteError` codes from `src/notes/types.ts`.
- `src/notes/events.ts` — `NoteEvents`, ops `created|updated|deleted|restored|purged`.
- `src/sessions/ids.ts` — `normalizeNodeId` (used by session tools).
- `src/mcp/server.ts:18-24` — registers note, image, similar, session, connector tools.
- `web/src/App.tsx:599` — `openNoteModal(raw)`: normalizes the id, closes an open editor through `closeSignal`/`pendingModal`, finds the note in the store or `fetchNote`s it, falls back to the bin ("is deleted") and image ids. Already used by chat note links (`noteLinks`, L709). This is the reusable "open in bigger view" entry point.
- `web/src/components/NoteEditor.tsx:89-112` — Esc on window capture phase, yields to `isLightboxOpen()`/`isConfirmOpen()`, then `preventDefault()+stopPropagation()` and closes.
- `web/src/components/Lightbox.tsx:51` — `isLightboxOpen(doc)`: DOM selector check; pattern for an `isEditorOpen()`.

---

## Current Dataflow

### Entry Point: MCP `session_get`
**Location:** `src/mcp/sessionTools.ts:104-133`
**Input:** `{ node_id }` → `normalizeNodeId` → `sessionDetail(rd, nodeId)`; unknown → `notFound`, bad → `badNodeId`.

### Processing Chain
1. `sessionDetail()` — `src/sessions/readModel.ts:311`
   - Loads the `cc_sessions` row by `node_id`, then in parallel: children, parent, notes, subagents.
   - Notes query (L326-330): `select id, body, tags, created_at from notes where deleted_at is null and origin ->> 'claude_session' = ${row.session_id} order by created_at desc limit ${DETAIL_MAX_NOTES}`.
   - Maps to `NoteRef { id, excerpt: excerpt(body, NOTE_EXCERPT_CHARS) ?? '', tags, created_at: iso() }` (L350-355).
2. HTTP: `src/http/sessionsApi.ts` serves the same `SessionDetail` to the wall.
3. Web: `web/src/sessionDetailApi.ts:142 noteRef()` → `SessionNoteRef { id, preview }`; `normalizeSessionDetail` L181.
4. `NodePanel.tsx:274-288` renders "Notes made": `<a href="/?note=ID">{id}</a><span>{preview}</span>` — a full navigation to the wall.

### Big editor (web)
- `App.tsx:74` `expanded` state; `expandedNote` (L126) from the store with `lastExpanded` fallback; `expand()` (~L222); `closeEditor` (~L234: empty rule, save on dirty); the NoteEditor portal (~L896) is outside the view switch, so it renders over `/projects` too.
- `openNoteModal` (L599) is the async open-by-id path; `noteLinks` (L709) wires it for chat text.
- `ProjectsPage` rendered at ~L833 with `repo, resolving, node, onSelectNode, focus, onToggleFocus`; it renders `NodePanel` by default via its `panel` fallback (L107) unless `renderPanel` is passed.
- `NodeModal` (App ~L938) renders `NodePanel` in a portal; its Esc listener (capture, window) closes the modal unless lightbox/confirm open.
- `ProjectsPage.tsx:73-80`: document keydown (bubble) clears the node selection on Esc unless `e.defaultPrevented` — NoteEditor's capture-phase `preventDefault` already protects it.

### Data Persistence
- `notes` (`src/db/schema.ts:66`), `cc_sessions` (`:486`, PK `session_id`, unique `node_id`). No link table exists.
- Migrations: `drizzle/0000…0008`, `drizzle/meta/_journal.json` (last idx 8, `0008_subagent_transcripts`) and per-migration snapshots.
- `tests/integration/setup.ts:49 truncateAll` lists every table explicitly.

### Exit Points
- MCP JSON results via `jsonResult`/`errorResult` (`src/mcp/tools.ts:141-152`); `NoteError` → `${code}: ${message}`.

---

## Key Data Structures

### `NoteRef` — `src/sessions/view.ts:113`
`{ id: string; excerpt: string; tags: string[]; created_at: string | null }`. Used in `SessionDetail.notes` (`view.ts:154`), built in `readModel.ts:350`.

### `SessionNoteRef` — `web/src/sessionDetailApi.ts:16`
`{ id: string; preview: string }`. Used by `NodePanel.tsx`.

### `ToolDeps` — `src/mcp/tools.ts:14`
`{ service: NotesService; db; sessions?: SessionsReadDeps; … }`. Session tools return `SESSIONS_OFF` when `sessions` is absent.

### `SessionsReadDeps` — `src/sessions/readModel.ts:79`
`{ db, host, timeZone, wallUrl, live, settings, search, commitLinks }`.

---

## Dependencies
- Postgres (pgvector image in tests); drizzle-kit for `db:generate`; `npm run db:migrate` uses `DATABASE_URL_UNPOOLED`.
- Phosphor icons (`@phosphor-icons/react`) in the web app.
- verify-notesd skill: `up --sessions --web` ingests `tests/fixtures/claude-home` (repos `mcp-notes`, `wall-editing`).

---

## Impact Points (files that WILL need changes)
1. `src/db/schema.ts` — `noteSessionLinks` table. Phase 1.
2. `drizzle/0009_*.sql`, `drizzle/meta/0009_snapshot.json`, `drizzle/meta/_journal.json` — migration. Phase 1.
3. `tests/integration/setup.ts` — `truncateAll` adds `note_session_links`. Phase 1.
4. `src/notes/` (service + a link repo module) — link/unlink writes with validation. Phase 1.
5. `src/sessions/view.ts`, `src/sessions/readModel.ts` — `NoteRef.kind`, union query. Phase 1.
6. `src/mcp/sessionTools.ts` — `link_note`, `unlink_note`; `session_get` description. Phase 1.
7. `src/mcp/instructions.ts`, `README.md` MCP table, `claude/skills/n/SKILL.md` — docs. Phase 1.
8. `tests/unit/**`, `tests/integration/**` — server tests. Phase 1.
9. `web/src/sessionDetailApi.ts` — `kind` on `SessionNoteRef`. Phase 2.
10. `web/src/components/graph/NodePanel.tsx` (+ css, test) — click opens editor, link icon. Phase 2.
11. `web/src/pages/ProjectsPage.tsx`, `web/src/components/graph/NodeModal.tsx` — `onOpenNote` threading; NodeModal yields Esc to the editor. Phase 2.
12. `web/src/App.tsx` (+ tests) — pass `openNoteModal`. Phase 2.
13. `.claude/skills/verify-notesd/features/projects.md` (and `notes.md` if relevant) — feature map. Phase 2.

**This document describes. The plan files prescribe.**
