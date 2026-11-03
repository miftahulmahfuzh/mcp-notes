# Projects: Claude Code session graph

## Sub-features
- Projects list (repo, session count, live count, last active), selected project.
- Per-project sessions: graph, tree, timeline views; node ids like `A0-3G`.
- Session search, usage (tokens), transcript (owning host only), resume (NOT driven here).

## How to get to it (user POV)
Wall sidebar `Projects` → `/projects`. Claude Code: MCP `sessions_search`, `session_get`,
`session_transcript`, `sessions_usage`.

## Driving it with verify.sh
```sh
$V up --sessions --web            # ingests tests/fixtures/claude-home: repos mcp-notes, wall-editing
$V api RUN GET /api/projects      # both repos listed
$V api RUN GET /api/projects/mcp-notes/sessions
$V mcp RUN sessions_usage '{}'
```
UI: `page.goto(base + '/projects')`, wait for `getByTestId('graph')`, toggle with `project-view-toggle`.

## Gotchas
- Ingest is a background tail; allow a few seconds after `up` before asserting.
- New ingest behavior needs a new fixture in `tests/fixtures/claude-home`, never the real `~/.claude`.
- Never drive `resume`: it spawns real Claude sessions.
