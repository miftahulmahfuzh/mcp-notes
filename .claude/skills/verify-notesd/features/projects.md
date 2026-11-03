# Projects: Claude Code session graph

## Sub-features
- Projects list (repo, session count, live count, last active), selected project.
- Per-project sessions: graph, tree, timeline views; node ids like `A0-3G`.
- Session search, usage (tokens), transcript (owning host only), resume (NOT driven here).
- Link an existing note to a session (MCP `link_note` / `unlink_note`; Phase 1). Session notes =
  made ∪ linked, deduped (a note both made and linked is listed once as `made`), newest first, at most 50.
  Links live in `note_session_links`; purging a note from the bin (hard delete) drops its link rows
  (`on delete cascade`), a soft delete keeps them.
- A session's "Notes made": notes saved from it (`kind: "made"`) plus notes linked to it with MCP
  `link_note` (`kind: "linked"`, shown with a link icon labelled "Linked note"). A plain click on a
  note id opens it in the big editor (bigger-view-on-note) over `/projects`, or over the chat node
  pop-up; Esc / X / backdrop closes only the editor and the node panel stays. Ctrl/middle click still
  opens the wall on that note in a new tab.

## How to get to it (user POV)
Wall sidebar `Projects` → `/projects`, click a node → the node panel (`aside.np`), section
"Notes made". Claude Code: MCP `sessions_search`, `session_get`, `session_transcript`,
`sessions_usage`; `/n link 5-BW7 into 5U-I7` (MCP `link_note` / `unlink_note`).

## Driving it with verify.sh
```sh
$V up --sessions --web            # ingests tests/fixtures/claude-home: repos mcp-notes, wall-editing
$V api RUN GET /api/projects      # both repos listed
$V api RUN GET /api/projects/mcp-notes/sessions
$V mcp RUN sessions_usage '{}'
```
UI: `page.goto(base + '/projects')`, wait for `getByTestId('graph')`, toggle with `project-view-toggle`.

Session notes. Node ids and session ids are generated at ingest, so read them from the run; never
type one in. `URL` is what `up` printed.
```sh
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '.nodes[0].node_id' <<<"$S"); SID=$(jq -r '.nodes[0].session_id' <<<"$S")
MADE=$($V mcp RUN create "{\"body\":\"made in a fixture session #verify\",\"origin\":{\"claude_session\":\"$SID\"}}" | sed 1d | jq -r .note.id)
LINKED=$($V mcp RUN create '{"body":"saved elsewhere #verify"}' | sed 1d | jq -r .note.id)
$V mcp RUN link_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}"
$V mcp RUN session_get "{\"node_id\":\"$NODE\"}"     # notes: MADE kind "made", LINKED kind "linked"
# Only after the UI steps below (it removes LINKED from the panel):
$V mcp RUN unlink_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}"   # {linked:false, changed:true}; again -> changed:false
$V sql RUN "select note_id, session_id from note_session_links"   # read-only check of the link table
```
Results: `link_note` / `unlink_note` → `{ note_id, node_id, session_id, linked, changed, made }`. Errors:
`not_found: Note …`, `not_found: no session …`, `invalid_node_id: …`, `deleted: Note … is deleted` (link only;
unlink works on a deleted note).
UI selectors (pass ids to the steps file through the environment: `NODE=$NODE LINKED=$LINKED $V ui RUN steps.mjs`):
- `page.goto(base + '/projects?repo=mcp-notes&node=' + NODE)`
- node panel: `page.locator('aside.np[data-node="' + NODE + '"]')`; its notes: `.getByRole('region', { name: 'Notes made' })`
- a note: `.getByRole('link', { name: LINKED, exact: true })`; the icon: `getByRole('img', { name: 'Linked note' })` inside that `li`
- the editor: `page.getByRole('dialog', { name: 'Edit note ' + LINKED })`, text box `getByLabel('Note text')`

## Gotchas
- Ingest is a background tail; allow a few seconds after `up` before asserting (the `curl --retry`
  above waits for it; `/api/projects/<repo>/sessions` is 404 until the repo has a session).
- New ingest behavior needs a new fixture in `tests/fixtures/claude-home`, never the real `~/.claude`.
- Never drive `resume`: it spawns real Claude sessions.
- The node panel loads session detail when it opens; after `link_note`, reload the page (or reopen
  the node) before asserting the new note is listed. A link change sends no SSE event.
- A note's row: `notes.locator('li').filter({ has: page.getByRole('link', { name: ID, exact: true }) })`. A `has`
  locator chained from `notes` never matches: Playwright resolves `has` inside each `li`.
- `$V mcp` prints a `> tool args` line first; strip it (`sed 1d`) before `jq`.
