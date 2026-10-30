# Installing mcp-notes

`notesd` runs inside WSL as a systemd **user** service, on `127.0.0.1:7317`. Claude Code reaches
it as the `notes` MCP server (user scope), and `/n` is a user-level skill symlinked from this
repo. A Windows logon task keeps WSL itself running.

## Prerequisites

- WSL 2 with systemd: `/etc/wsl.conf` has `[boot]` / `systemd=true`, and
  `systemctl --user is-system-running` answers (`running` or `degraded`).
- Node 22. The installer finds `node` on your PATH, else
  `~/tools/node-v22.23.1-linux-x64/bin/node`, or set `NODE_BIN=/abs/path/to/node`.
- The `claude` CLI (on PATH, or next to node, or `CLAUDE_BIN=...`).
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
4. Renders `deploy/notesd.service` with absolute paths (node, this checkout, data dir) into
   `~/.config/systemd/user/notesd.service`, then `daemon-reload`, `enable` and `restart`.
   The absolute node path matters: the user manager's PATH does not include `~/tools/...`.
5. `loginctl enable-linger $USER`, so your user manager, and with it `notesd`, starts when the
   distro boots rather than when you first open a shell. If that needs a password the script
   says so; run `sudo loginctl enable-linger $USER` once.
6. Waits up to 30 s for `GET http://127.0.0.1:7317/health`.
7. `claude mcp remove --scope user notes` (ignored if absent), then
   `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`.
8. Symlinks `~/.claude/skills/n` -> `<this checkout>/claude/skills/n`. An existing symlink is
   replaced; a real directory there stops the script before it changes anything.
9. Prints the verification and exits non-zero unless all three checks pass:

```sh
systemctl --user is-active notesd           # active
curl -s http://127.0.0.1:7317/health        # HTTP 200
claude mcp list | grep '^notes:'            # notes: http://localhost:7317/mcp (HTTP) - ✔ Connected
```

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

## 3. After the plan set lands (re-run from the main checkout)

The set is built in a worktree (`~/.worktrees/mcp-notes/notes-spine-images-ui`) and its phase
ran `install.sh` from there, so the unit, `WorkingDirectory` and the skill symlink point into
the worktree. The worktree is deleted when the branch lands, which leaves the unit failing and
the skill dangling. Once the set is on `main`:

```sh
cd ~/mcp-notes && git pull && scripts/install.sh
```

It rewrites the unit to `~/mcp-notes`, re-points the symlink, rebuilds and restarts. Confirm
with `systemctl --user cat notesd | grep ExecStart`.

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
