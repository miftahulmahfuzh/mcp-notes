# Installing mcp-notes

`notesd` runs inside WSL as a systemd **user** service, on `127.0.0.1:7317`. Claude Code reaches
it as the `notes` MCP server (user scope), and `/n` is a user-level skill symlinked from this
repo. A Windows logon task keeps WSL itself running.

## Prerequisites

- WSL 2 with systemd: `/etc/wsl.conf` has `[boot]` / `systemd=true`, and
  `systemctl --user is-system-running` answers (`running` or `degraded`).
- Node 22. The installer finds `node` on your PATH, else
  `~/tools/node-v22.23.1-linux-x64/bin/node`, or set `NODE_BIN=/abs/path/to/node`.
- The `claude` CLI (on PATH, or next to node, or `CLAUDE_BIN=...`), **logged in**: the chat bar's
  brain runs headless Claude Code on your existing login (`~/.claude/.credentials.json`). No API
  key goes in this repo.
- Optional, for the chat bar's GLM fallback: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in
  `.env.local` (see "4. Chat bar brain").
- `.env.local` at the repo root with `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (the Neon pooled and direct hosts; the daemon picks the pooled one by host name, so the key names do not have to be right).
- The Neon schema migrated once: `npm run db:migrate`.

## 1. Install (WSL)

```sh
cd ~/mcp-notes
scripts/install.sh
```

What it does, every run (it is idempotent, re-run it after every pull):

1. `npm ci` when `node_modules` is missing or older than `package-lock.json`.
2. `npm run build` (server, and the web UI once it exists).
3. Creates the data dir, `~/mcp-notes-data` (or `$NOTES_DATA_DIR`).
4. Renders `deploy/notesd.service` with absolute paths (node, this checkout, data dir, `HOME`,
   and the real path of `claude` as `NOTESD_CLAUDE_BIN`) into
   `~/.config/systemd/user/notesd.service`, then `daemon-reload`, `enable` and `restart`.
   The absolute node and claude paths matter: the user manager's PATH does not include `~/tools/...`.
   Before that it warns (it does not stop) when `~/.claude/.credentials.json` is missing, when
   `.env.local` is missing, or when `.env.local` has no complete `LLM_*` set (GLM fallback off).
5. `loginctl enable-linger $USER`, so your user manager, and with it `notesd`, starts when the
   distro boots rather than when you first open a shell. If that needs a password the script
   says so; run `sudo loginctl enable-linger $USER` once.
6. Waits up to 30 s for `GET http://127.0.0.1:7317/health`.
7. `claude mcp remove --scope user notes` (ignored if absent), then
   `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`.
8. Symlinks `~/.claude/skills/n` -> `<this checkout>/claude/skills/n`. An existing symlink is
   replaced; a real directory there stops the script before it changes anything.
9. Prints the verification and exits non-zero unless all four checks pass:

```sh
systemctl --user is-active notesd           # active
curl -s http://127.0.0.1:7317/health        # HTTP 200
claude mcp list | grep '^notes:'            # notes: http://localhost:7317/mcp (HTTP) - ✔ Connected
# chat: one real message through the installed daemon; the stream must end with `event: done`
curl -sN -H 'content-type: application/json' \
  -d '{"message":"Install check. Call the notes tags tool once, then reply with only the number of tags it returned. Use no other tool."}' \
  http://127.0.0.1:7317/api/chat | tail -n 3  # event: done / data: {"thread_id":"…","brain":"claude"}
```

The chat check prints which brain answered. `brain=glm` is a warning: Claude failed (login or
usage limit) and the fallback answered. `SKIP_CHAT_CHECK=1 scripts/install.sh` skips it (offline).

Logs: `journalctl --user -u notesd -f`.

The unit and the skill point at **the checkout that ran the script**. Run it from `~/mcp-notes`.

## 2. Keep WSL running (Windows)

### Why this is needed

WSL stops an idle distro, and stopping the distro stops `notesd` with it.

What Microsoft documents (Learn, "Advanced settings configuration in WSL", updated 2026-10-16):

- `%UserProfile%\.wslconfig`, `[general]` `instanceIdleTimeout`, default `15000`: "The number of
  milliseconds that a distro is idle, before it is shut down. Set to -1 to disable auto
  shutdown."
- `[wsl2]` `vmIdleTimeout`, default `60000` (Windows 11): "The number of milliseconds that a VM
  is idle, before it is shut down." This applies to the whole VM after its distros have stopped.
- The "8 second rule": the distro stops shortly "after closing ALL instances of the distribution
  shell".

What that means here, stated as inference rather than documentation: "idle" is about Windows-side
`wsl.exe` sessions, not Linux processes. systemd services, `notesd` among them, and a lingering
user manager do **not** keep the distro up. Linger only decides that `notesd` starts when the
distro boots; it does not boot the distro or keep it running. So with no terminal open, WSL
shuts the distro down about 15 s after the last terminal closes, and `notesd` goes with it.
During the working day an open Claude Code terminal keeps it up anyway; the gap is before the
first terminal of the day and after the last one closes (the web UI at `http://localhost:7317`
would be unreachable then).

Check it yourself (PowerShell, without the keepalive task): close every WSL terminal, wait 30 s,
run `wsl --list --running`. "There are no running distributions" confirms it.

This machine had no `.wslconfig` when this was written, so both timeouts are at their defaults.

### The fix: a logon task holding one `wsl.exe` open

`scripts/windows/install-wsl-keepalive.ps1` registers a Task Scheduler task, at your logon, that
runs `wsl.exe -d Ubuntu -- sleep infinity` with no window. That attached `wsl.exe` keeps the
distro non-idle all day; systemd starts `notesd` (linger) as the distro boots.

From Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\home\miftah\mcp-notes\scripts\windows\install-wsl-keepalive.ps1
```

or from WSL:

```sh
cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ~/mcp-notes/scripts/windows/install-wsl-keepalive.ps1)"
```

Parameters: `-Distro <name>` (default `Ubuntu`), `-TaskName <name>` (default
`mcp-notes WSL keepalive`), `-NoStart` (do not start it now), `-Uninstall`.

If it fails with "Access is denied", run it from an elevated PowerShell (Run as administrator).
The task still runs as you.

Details:

- The action is `conhost.exe --headless wsl.exe -d Ubuntu -- sleep infinity`. Task Scheduler's
  "hidden" setting only hides the task in its UI; a console program started at logon would
  otherwise open a visible console window.
- The default 3-day execution limit is removed, so Task Scheduler never kills it; it runs on
  battery and is restarted up to 3 times if `wsl.exe` exits.
- Check it: `Get-ScheduledTask -TaskName 'mcp-notes WSL keepalive'` (State `Running`), and in WSL
  `pgrep -af 'sleep infinity'`.

### Alternative: turn the idle shutdown off

Instead of the task, `%UserProfile%\.wslconfig`:

```ini
[general]
instanceIdleTimeout=-1
```

then `wsl --shutdown`. This keeps a started distro running, but nothing starts WSL at logon, so
`notesd` is down until you open a terminal once. The task covers both, which is why it is the
chosen setup.

## 3. After a plan set lands (re-run from the main checkout)

A plan set is built in a worktree (for example `~/.worktrees/mcp-notes/chat-bar-brain`), and its
last phase runs `install.sh` from there, so the unit's `ExecStart` and `WorkingDirectory`, the
`.env.local` the daemon reads, and the skill symlink all point into the worktree. The worktree is deleted
when the branch lands, which leaves the unit failing and the skill dangling. Once the set is on
`main`:

```sh
cd ~/mcp-notes && git pull && scripts/install.sh
```

It rewrites the unit to `~/mcp-notes`, re-points the symlink, rebuilds and restarts. Confirm
with `systemctl --user cat notesd | grep ExecStart`.

A worktree has no `.env.local` of its own (it is gitignored). Before running `install.sh` from
one, link the owner's: `ln -s ~/mcp-notes/.env.local .env.local`.

## 4. Chat bar brain

The chat bar (`POST /api/chat`) runs one headless Claude Code per message through the Claude
Agent SDK. notesd spawns the executable named by `NOTESD_CLAUDE_BIN` (the unit sets it to the
real path of `claude`, here `~/tools/node-v22.23.1-linux-x64/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`),
with `HOME` from the unit, so it uses your Claude Code login in `~/.claude/.credentials.json`.
The agent sees only the `notes` MCP server (`http://127.0.0.1:7317/mcp`, the same tools `/n`
uses) plus WebSearch and WebFetch. Your user settings, CLAUDE.md, hooks, plugins and other MCP
servers are not loaded. Answers are never saved as notes; edits the agent makes on request show
up on the wall like any other edit.

### Settings

All of these are read from the environment, merged over `.env.local` (the real environment
wins). Change `.env.local`, then `systemctl --user restart notesd`.

| Key | Default | Meaning |
|---|---|---|
| `CHAT_BRAIN` | `claude` | `claude` or `glm`. `glm` needs the three `LLM_*` keys (the daemon refuses to start without them). |
| `CHAT_MAX_TURNS` | `24` | Agent turn cap per message. |
| `CHAT_TIMEOUT_MS` | `180000` | Wall clock per message; the run is aborted after it. |
| `NOTESD_CLAUDE_BIN` | `claude` on PATH | Set by the unit; to change it, re-run `CLAUDE_BIN=/path/to/claude scripts/install.sh`. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | unset | z.ai GLM endpoint, key and model (glm-5.3). Set: a Claude run that fails on a usage limit or authentication before any text is retried once on GLM. Unset: no fallback. |

The GLM key stays in `.env.local`; it is never written into the unit. A Claude run's child
environment never carries `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`,
so it always uses the login.

The panel's header shows which brain answered (`claude` / `glm`) in small mono type, and what
the agent is doing while it works (`searching notes`, `reading 3 notes`, `searching the web`).

### Threads

A follow-up in an open (or pinned) panel continues the same Claude Code session; dismissing the
panel starts a new one. Sessions are stored by Claude Code under
`~/.claude/projects/-home-miftah-mcp-notes-data-chat/` (the slug of the fixed run directory
`~/mcp-notes-data/chat`), so a thread survives a daemon restart for as long as its `.jsonl` is
there. Each `.jsonl` is also the full transcript of that thread, tool calls included: the place
to look when an answer is wrong.

### Logs and checks

- Daemon output and chat failures: `journalctl --user -u notesd -f`.
- One message by hand: `curl -sN -H 'content-type: application/json' -d '{"message":"how many notes do i have tagged #seer?"}' http://127.0.0.1:7317/api/chat`
  (events: `status`, `delta`, then `done` with `thread_id` and `brain`, or `error`).
- Live suite (real Claude + real GLM, against the Docker test database, not your notes):
  `npm run test:live`. Opt-in; `npm test` and `npm run test:int` never run it.

## 5. Connectors

notesd reads expense-tracking, run-insights and Seer read-only (tools `expenses_*`, `runs_*`,
`seer_*`). Nothing to install: each call reads `~/expense-tracking/.env.local`,
`~/run-insights/.env.local` and `~/seer/.env.local` (the direct `DATABASE_URL*` host) and
`~/seer/lab/lab.sqlite`. Credentials are never copied into the unit or this repo.

| Key | Default | Meaning |
|---|---|---|
| `EXPENSE_TRACKING_DIR` | `~/expense-tracking` | Repo dir of expense-tracking. |
| `RUN_INSIGHTS_DIR` | `~/run-insights` | Repo dir of run-insights. |
| `SEER_DIR` | `~/seer` | Repo dir of Seer; the lab is `<dir>/lab/lab.sqlite`. |
| `CONNECTOR_TIMEOUT_MS` | `10000` | Statement timeout per query. |

They are read on every call from the environment, merged over this repo's `.env.local`, so a change
needs no restart. Check the real databases (read-only, schema only) with
`npm run test:live:connectors`.

## Uninstall

```sh
scripts/uninstall.sh
```

Stops and removes the unit, runs `claude mcp remove --scope user notes`, removes the skill
symlink. It keeps `~/mcp-notes-data` and linger (`sudo loginctl disable-linger $USER` to undo).
Windows: run the keepalive script with `-Uninstall`.

## Troubleshooting

- `notes` shows "Failed to connect": `systemctl --user status notesd`, then
  `journalctl --user -u notesd -n 50`. The daemon binds `127.0.0.1` only; Claude Code connects to
  `localhost`, which resolves to IPv4 first or falls back to it.
- `/n` not found in Claude Code: `ls -l ~/.claude/skills/n` must point at an existing
  `claude/skills/n`; re-run `scripts/install.sh`.
- Port 7317 taken by a dev run: stop it; the installer's health check would otherwise pass
  against the wrong process. `ss -ltnp 'sport = :7317'` shows the owner.
- Chat answers `Chat failed: …` or the installer's chat check fails: `journalctl --user -u notesd -n 50`.
  Check the login with `claude -p hi` in a terminal; if that asks you to log in, run `claude` and
  `/login`. `systemctl --user cat notesd | grep NOTESD_CLAUDE_BIN` must name an existing file
  (a Claude Code reinstall into a different directory needs `scripts/install.sh` again).
- The panel says `glm` when you expected `claude`: Claude hit a usage limit or the login failed,
  and the fallback answered. The journal has the Claude error.
