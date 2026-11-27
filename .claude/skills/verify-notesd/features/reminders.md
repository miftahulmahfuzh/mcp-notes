# Reminders: the `remind` tool and the SessionStart hook

## Sub-features
- MCP `remind`: `add` ({body, due | in_days, repo?} → {reminder}), `list` (open ones, soonest first → {reminders}),
  `done` ({id} → {reminder, changed}; `not_found` for an unknown id). Invalid input answers `invalid_input: ...`.
- The start route `POST /api/sessions/hook/start` answers `reminders: [{id, body, due_at}]` on `startup` and `clear`
  only: due, not done, for the session's repository or for every repository, not shown in the last 20 h; at most 5.
  Answering stamps `last_shown_at`.
- `claude/hooks/notes-session.mjs` appends them to `additionalContext` after the node id sentences, with the
  instruction to tell the owner and to mark it done with `remind`.
- The seed `play-log-ranking` (repository `mcp-notes`) is stored once at daemon start, due 7 days after that start.

## How to get to it (user POV)
Ask Claude Code "remind me in a week to ...", or just start a session after a seeded reminder came due: the first
reply opens with the reminder and its number. "That's handled" marks it done.

## Driving it with verify.sh
```sh
V=.claude/skills/verify-notesd/scripts/verify.sh
$V up                                    # RUN, URL
PORT=${URL##*:}; T=$(mktemp -d); TOP=$(git rev-parse --show-toplevel)
$V sql RUN "select seed_key, repo, round(extract(epoch from due_at - created_at)/86400) as days, done_at from reminders"
ID=$($V mcp RUN remind '{"action":"add","body":"verify: the kettle is on","in_days":0,"repo":"mcp-notes"}' | sed 1d | jq -r .reminder.id)
hook() { printf '{"session_id":"%s","cwd":"%s","source":"%s","hook_event_name":"SessionStart"}' "$1" "$TOP" "$2" \
  | env -i PATH="$PATH" HOME="$T" XDG_STATE_HOME="$T/state" NOTESD_PORT="$PORT" CLAUDE_CODE_ENTRYPOINT=cli node "$TOP/claude/hooks/notes-session.mjs"; }
hook 11111111-1111-4111-8111-000000000001 startup | jq -r .hookSpecificOutput.additionalContext
$V mcp RUN remind "{\"action\":\"done\",\"id\":$ID}"
```
`$V exec RUN "update reminders set last_shown_at = now() - interval '21 hours' where id = $ID"` ages a reminder past
the 20 h window; `... set due_at = now() - interval '1 minute' where seed_key = 'play-log-ranking'` makes the seed due.

## Gotchas
- The repository key comes from the hook's `cwd`, resolved like the session graph (a worktree under
  `NOTES_WORKTREES_DIR`, else the git main checkout's directory name). Run the hook with `cwd` inside a checkout of
  mcp-notes whose main checkout directory is named `mcp-notes`, or add the reminder without `repo`.
- `HOME` and `XDG_STATE_HOME` point at a temp dir so the hook never reads the real `~/.claude`.
- `resume` and `compact` never show reminders; a new `session_id` per fresh start.
- Proof in tests: `tests/integration/reminders.int.test.ts`, `tests/unit/hooks/notesSession.test.ts`,
  `tests/unit/mcp.remindTool.test.ts`, `tests/integration/daemon.int.test.ts` (the seed).
