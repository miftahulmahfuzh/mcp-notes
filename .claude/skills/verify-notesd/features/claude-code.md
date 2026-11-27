# Claude Code integration: the `/mcp` transport, the hooks, clickable ids

The note tools are in `notes.md`, pictures in `images-files.md`, search in `search.md`, the session
graph and its `link_note` / notes-link journey in `projects.md`, reminders and the notes-session
reminder block in `reminders.md`.

## Sub-features
- The `notes` MCP server at `/mcp`: stateless, `POST` only (`GET`/`DELETE` answer 405 with
  `Allow: POST`), loopback only (403 `Forbidden host.` / `Forbidden origin.`, `src/http/app.ts`).
  No test covers the host guard; drive it with curl as below.
- The `/n` capture (notes-capture, Stop hook): a `/n` turn's question and answer go to
  `POST /api/capture/claude-code` (header `X-Notes-Capture: 1`), through an outbox under
  `${XDG_STATE_HOME:-~/.local/state}/notes-capture` when the daemon is down; the same turn twice
  answers `duplicate`. Only `/n` turns are captured. Integration:
  `tests/integration/capture.hook.int.test.ts`, `tests/integration/capture.int.test.ts`; unit:
  `tests/unit/hooks/notesCapture.test.ts`, `tests/unit/captureGuard.test.ts`.
- Pasted pictures: notes-prompt saves a pasted image and notes-paste rewrites the prompt so `/n`
  sees its id; without them the server refuses `pasted_image` (`pasted_image_unresolved`).
  Integration: `tests/integration/prompt.hook.int.test.ts`; unit:
  `tests/unit/hooks/notesPaste.test.ts`, `tests/unit/hooks/notesPrompt.test.ts`. Billed, real
  `claude -p` checks: `npm run verify:paste-hook`, `npm run verify:prompt-hook`.
- notes-prompt's node-id context: up to five session node ids in any prompt are looked up
  (`GET /api/sessions/context`) and added as context. Unit: `tests/unit/hooks/notesPrompt.test.ts`.
- Parent links from hooks: notes-session posts `POST /api/sessions/hook/start` (`CC_PARENT_SESSION`
  links as `env`); notes-spawn posts `POST /api/sessions/hook/spawn`, and a fresh `startup` with the
  same tmux and cwd within 30 s (`PENDING_SPAWN_WINDOW_MS`) claims it as `hook`. Integration:
  `tests/integration/sessionHooks.int.test.ts`; unit: `tests/unit/hooks/notesSpawn.test.ts`,
  `tests/unit/hooks/notesSession.test.ts`.
- Clickable ids: the `note-links` mod turns note, session node and movie ids into links and adds
  `/open`; the daemon side is `GET /api/ids/known`. The mod's tests:
  `claude/mods/note-links/tests/` (`linkify.test.ts`, `open.test.ts`, `register.test.ts`).
- Hook install and merge (`scripts/claude-hooks.mjs install|uninstall|status|retention`). Unit:
  `tests/unit/scripts/claudeHooks.test.ts`.

## How to get to it (user POV)
Any Claude Code session: `/n <anything>`, a pasted screenshot with `/n`, a node id such as `A0-3G`
in a prompt, `/open A-B32`. The wall's Chat history shows captured `/n` exchanges.

## Driving it with verify.sh
```sh
$V up
PORT=$(cat <run dir>/port)
$V api RUN GET /mcp                                                   # 405, Allow: POST
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Host: evil.test' \
  -H 'content-type: application/json' --data '{}' "http://127.0.0.1:$PORT/mcp"   # 403
curl -s -X POST -H 'content-type: application/json' --data '{}' \
  "http://127.0.0.1:$PORT/api/capture/claude-code"                    # 403 capture_header_required

# A pending spawn, then a fresh start that claims it (both need the capture header)
H=(-H 'content-type: application/json' -H 'X-Notes-Capture: 1')
curl -s "${H[@]}" --data '{"session":"<parent uuid>","source":"startup","cwd":"/tmp/x"}' \
  "http://127.0.0.1:$PORT/api/sessions/hook/start"                    # the parent's own row first
curl -s "${H[@]}" --data '{"parent":"<parent uuid>","cwd":"/tmp/x"}' "http://127.0.0.1:$PORT/api/sessions/hook/spawn"   # 201 recorded
curl -s "${H[@]}" --data '{"session":"<new uuid>","source":"startup","cwd":"/tmp/x","tmux":"%1"}' \
  "http://127.0.0.1:$PORT/api/sessions/hook/start"                    # claimed:true, parent_link_source:"hook"
$V api RUN GET '/api/ids/known?ids=<a note id>'
```
The capture hook end to end: pipe a fixture transcript's Stop input into
`node claude/hooks/notes-capture.mjs` with `HOME` and `XDG_STATE_HOME` set to a temp folder and
`NOTESD_PORT` set to the run's port; `$V api RUN GET /api/chat/messages` then shows the turn with
source `claude_code`, and a second run is a `duplicate`. Shape the input after
`tests/integration/capture.hook.int.test.ts`.

The hook merge, on a scratch file only:
`node scripts/claude-hooks.mjs install --settings $T/s.json --node $(command -v node) --hooks-dir $PWD/claude/hooks`,
twice; the second run must leave the file byte for byte the same.

## Gotchas
- Never point a hook, `claude-hooks.mjs` or a capture journey at the real `~/.claude` or
  `~/.local/state`: always a temp `HOME` / `XDG_STATE_HOME` and a scratch settings file.
- `$V api` sends `Origin` and no custom header, so the guard and hook routes are driven with curl.
- The mod runs inside Claude Code, not the daemon: `verify.sh` cannot drive `/open`.
