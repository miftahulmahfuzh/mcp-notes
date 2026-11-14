# Install and run

`notesd` runs inside WSL as a systemd user service on `127.0.0.1:7317`. `scripts/install.sh` builds
it, installs the unit, registers the `notes` MCP server with Claude Code, links the skills and
merges the hooks. A Windows logon task keeps WSL itself running. This guide covers that, a second
machine, running by hand, the test suites and the docs tooling. Settings are in
[reference/configuration.md](reference/configuration.md).

## Requirements

- WSL 2 with systemd: `/etc/wsl.conf` has `[boot]` / `systemd=true`, and `systemctl --user
  is-system-running` answers. Other Linux setups work too: skip the Windows part, and skip the
  unit if you would rather run it by hand.
- Node 22.22 or later (`.nvmrc`). The installer takes `node` from `PATH`, else
  `~/tools/node-v22.23.1-linux-x64/bin/node`, else `NODE_BIN=/abs/path/to/node`.
- The `claude` CLI, logged in. The chat bar, session summaries and the other Claude runs use
  your Claude Code login (`~/.claude/.credentials.json`). No API key goes in this repo.
- A Postgres database with pgvector. The project uses Neon; any Postgres URL that is not a Neon
  host goes through `node-postgres`.
- `.env.local` at the repo root with `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (the pooled and
  the direct Neon host; they are told apart by host name, so the key names do not have to be
  right). Optional: `OPENROUTER_API_KEY` for search by meaning, `LLM_*` for the chat bar's GLM
  fallback, `TMDB_*` and `NOTESD_MOVIES_ROOTS` for Movies.
- `curl`. Docker only for the integration tests. `tmux` for resume from the wall, `ffprobe`
  and Windows VLC for Movies, `gh` for the Seer nightly dispatch.

## Install on WSL

```sh
git clone git@github.com:miftahulmahfuzh/mcp-notes.git ~/mcp-notes
cd ~/mcp-notes
cp /path/to/your/.env.local .env.local
npm ci
npm run db:migrate          # against the direct host; again after a pull that adds drizzle/*.sql
npm run embed:backfill      # optional: embed existing notes now (notesd also does it in the background)
scripts/install.sh
```

Then open `http://localhost:7317` in the Windows browser. Logs: `journalctl --user -u notesd -f`.

`install.sh` is idempotent. Run it again after every pull; that is also how the daemon is rebuilt
and restarted. Each run:

| Step | What it does |
| --- | --- |
| Checks | Finds node (22 or later) and `claude`, checks `curl`, the systemd user manager, the unit template, the skills and the hook scripts. Stops before changing anything when a skill path in `~/.claude/skills` is a real directory. Warns, without stopping, when the Claude login, `.env.local` or a complete `LLM_*` set is missing. |
| Build | `npm ci` when `node_modules` is missing or older than `package-lock.json`, then `npm run build` (the server with `tsc`, the web app with Vite). |
| Data dir | Creates `~/mcp-notes-data`, or `NOTES_DATA_DIR`. |
| systemd user unit | Renders `deploy/notesd.service` with absolute paths (node, this checkout, the data dir, `HOME`, and the real path of `claude` as `NOTESD_CLAUDE_BIN`) into `~/.config/systemd/user/notesd.service`, then `daemon-reload`, `enable` and `restart`. The absolute paths matter: the user manager's `PATH` has no `~/tools/...`. |
| Linger | `loginctl enable-linger $USER`, so the unit starts when the distro boots, not when you first open a shell. When that needs a password the script says so: run `sudo loginctl enable-linger $USER` once. |
| Health | Waits up to 30 s for `GET http://127.0.0.1:7317/health`, and prints the journal when it does not answer. |
| MCP registration | `claude mcp remove --scope user notes`, then `claude mcp add --scope user --transport http notes http://localhost:7317/mcp`. |
| Skills | Symlinks `n`, `migrate`, `v`, `j`, `redo` and `check-seer-adversarial-nightly` from `claude/skills/` into `~/.claude/skills/`. |
| Hooks | `scripts/claude-hooks.mjs` merges six hooks into `~/.claude/settings.json` (user scope, so every repo), keeping everything else: notes-capture, notes-link, notes-paste, notes-prompt, notes-session, notes-spawn. A copy of the original file is kept once as `settings.json.bak-notes-hooks`. What each hook does is in [claude-code.md](claude-code.md). |
| Transcript retention | Raises `cleanupPeriodDays` in the same file to at least 3650 (`NOTES_CLAUDE_RETENTION_DAYS`), so Claude Code keeps the transcripts the session graph reads. A higher value is kept. |
| Verification | Prints each check and exits non-zero unless the unit is active, `/health` answers, `claude mcp list` shows `notes` connected, and one real chat message through the daemon ends with `event: done`. |

`--skip-hooks` (or `NOTES_SKIP_HOOKS=1`) leaves `~/.claude/settings.json` alone: no hooks and no
retention change. `SKIP_CHAT_CHECK=1` skips the chat message (offline runs). The chat check prints
which brain answered; `brain=glm` is a warning that Claude failed and the fallback answered.

The unit, the skills and the hooks all point at the checkout that ran the script, so run it from
`~/mcp-notes`. After work done in a worktree lands on `main`, run it again from the main checkout
(`cd ~/mcp-notes && git pull && scripts/install.sh`); the worktree is deleted when its branch
lands, which would leave the unit failing and the skills dangling. A worktree has no `.env.local`
of its own: `ln -s ~/mcp-notes/.env.local .env.local` before installing from one. The installer
always uses port 7317.

The verification by hand:

```sh
systemctl --user is-active notesd           # active
curl -s http://127.0.0.1:7317/health        # {"ok":true,"service":"notesd"}
claude mcp list | grep '^notes:'            # notes: http://localhost:7317/mcp (HTTP) - Connected
```

## Keep WSL running from Windows

WSL shuts an idle distro down about 15 seconds after its last terminal closes
(`instanceIdleTimeout` in `.wslconfig`, default 15000 ms), and `notesd` stops with it. "Idle" is
about Windows-side `wsl.exe` sessions: a systemd service does not keep the distro up, and linger
only decides that `notesd` starts when the distro boots. So without a terminal open the wall at
`http://localhost:7317` is unreachable.

`scripts/windows/install-wsl-keepalive.ps1` registers a Task Scheduler task that runs at your
logon and holds one hidden `wsl.exe -d Ubuntu -- sleep infinity` open (inside `conhost.exe
--headless`, so no window appears). From Windows PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\home\<you>\mcp-notes\scripts\windows\install-wsl-keepalive.ps1
```

or from WSL:

```sh
cd /mnt/c && powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w ~/mcp-notes/scripts/windows/install-wsl-keepalive.ps1)"
```

Parameters: `-Distro <name>` (default `Ubuntu`), `-TaskName <name>` (default `mcp-notes WSL
keepalive`), `-NoStart` (register it without starting it now), `-Uninstall`. If it fails with
"Access is denied", run it from an elevated PowerShell; the task still runs as you. The task has
no execution time limit, runs on battery and is restarted up to 3 times if `wsl.exe` exits.

Check it: `Get-ScheduledTask -TaskName 'mcp-notes WSL keepalive'` shows `Running`, and in WSL
`pgrep -af 'sleep infinity'` finds the process. To see the problem itself, remove the task, close
every WSL terminal, wait 30 s and run `wsl --list --running`.

The alternative is `instanceIdleTimeout=-1` under `[general]` in `%UserProfile%\.wslconfig`,
then `wsl --shutdown`. That keeps a started distro running, but nothing starts WSL at logon, so
`notesd` is down until you open a terminal once. The task covers both.

## A second machine

The database is shared, so a second laptop runs its own `notesd` against it. Clone the repo
there, copy the same `.env.local`, and run `scripts/install.sh`. Skip `db:migrate` and
`embed:backfill`: the schema and the vectors are already there.

Notes, tags, revisions, the recycle bin, search, chat history, the session graph and the movie
titles are the same on both. What stays on one machine:

- Photos and files. One made on the other machine shows "not on this machine" and its folder
  icon is hidden.
- Session transcripts, and with them `session_transcript` and resume.
- Movie files, plays and VLC.
- The connectors need the sibling repos on that machine too (or the `*_DIR` variables pointing
  at them), and `/v` and `/j` need `DWORD_USER_EMAIL` in that machine's `.env.local`.

After a pull that adds a migration, run `npm run db:migrate` once from either machine, then
`scripts/install.sh` on both. The model behind this is in
[architecture.md](architecture.md#two-machines).

## Run it by hand

```sh
npm run build && npm start       # notesd on 127.0.0.1:7317, from dist/
npm run dev                      # the daemon with reload (tsx watch src/main.ts)
npm run dev:web                  # Vite dev server for web/, proxied to the daemon
```

Stop the unit first (`systemctl --user stop notesd`), or use another port: two daemons cannot
share 7317. To try it without touching your real notes, point it at another database and data
dir:

```sh
DATABASE_URL=postgres://… NOTESD_PORT=7400 NOTES_DATA_DIR=/tmp/notes-demo NOTESD_SESSIONS=off npm start
claude --mcp-config demo-mcp.json --strict-mcp-config
# demo-mcp.json: {"mcpServers":{"notes":{"type":"http","url":"http://127.0.0.1:7400/mcp"}}}
```

For proving a change, the `verify-notesd` skill (`.claude/skills/verify-notesd`) does this for
you: a throwaway daemon with its own database, port, data dir and `CLAUDE_HOME`.

## npm commands

| Command | What it does |
| --- | --- |
| `npm run dev` | The daemon with reload. |
| `npm run dev:web` | Vite dev server for the web app, proxied to the daemon. |
| `npm run build` | `build:server` (`tsc -p tsconfig.server.json` into `dist/`) and `build:web` (Vite into `web/dist/`). |
| `npm start` | `node dist/main.js`. |
| `npm run typecheck` | The server (`tsconfig.json`) and the web app (`tsconfig.web.json`). |
| `npm run db:generate` | A new Drizzle migration after editing `src/db/schema.ts`. |
| `npm run db:migrate` | Apply the migrations in `drizzle/`, over the direct (unpooled) URL. |
| `npm run db:check` | Drizzle's consistency check of the migration files. |
| `npm run embed:backfill` | Embed every note that has text and no current vector, with progress. `-- --retry-failed` also retries notes still in backoff. Needs `OPENROUTER_API_KEY`. |
| `npm run embed:images:backfill` | Embed pending photos. `-- --dry-run` counts them and estimates the cost; `--limit N` for a trial. Never runs by itself. |
| `npm test`, `npm run test:watch` | The unit suite. |
| `npm run test:int` | The integration suite in Docker. |
| `npm run test:live*`, `npm run verify:*-hook` | Opt-in, billed checks (below). |
| `npm run docs:gen`, `docs:check`, `docs:shots` | The docs tooling (below). |

## Tests

There is one `vitest.config.ts`. Environment flags pick the suite, so do not add a second config.

| Command | Runs | Touches |
| --- | --- | --- |
| `npm test` | `tests/unit/**` in node, and `web/src/**/*.test.tsx`, which opt into jsdom with a `// @vitest-environment jsdom` first line | Nothing outside the process: fake embedders, no network, no database |
| `npm run test:int` | `tests/integration/**/*.int.test.ts`, one file at a time | Two Docker containers; never Neon |
| `npm run test:live` | `tests/live/chat.live.test.ts` | Real Claude and GLM calls through the Agent SDK, on the Docker notes database. Billed |
| `npm run test:live:connectors` | `tests/live/connectors.live.test.ts` | Each `*_schema` tool against the real connector databases, read-only |
| `npm run test:live:embeddings` | `tests/live/embeddings.live.test.ts` | One real OpenRouter embeddings call over the labelled search set. Billed |
| `npm run test:live:imageEmbeddings` | `tests/live/imageEmbeddings.live.test.ts` | A few real image embedding calls. Billed |
| `npm run verify:paste-hook` | `scripts/verify-paste-hook.mjs` | One real `claude -p` run that checks the paste hook's rewrite. Billed |
| `npm run verify:prompt-hook` | `scripts/verify-prompt-hook.mjs` | One real `claude -p` run that checks `/n` sees a pasted image's id. Billed |

The live suites and the two `verify:` scripts are opt-in and are never part of `npm test` or
`test:int`. One file or one test: `npx vitest run tests/unit/path/file.test.ts`, `npx vitest run
-t "name fragment"`; `test:int` passes extra arguments to vitest the same way.

`test:int` (`scripts/test-int.sh`) starts or reuses two containers on `pgvector/pgvector:pg16`,
both with durability off because they hold test data only. A container made from another image
or without those settings is removed and recreated.

| Container | Port | Holds |
| --- | --- | --- |
| `mcp-notes-pg-test` | 55433 | The notes schema, built from `drizzle/*.sql` |
| `mcp-notes-pg-connectors` | 55435 | One database per connector, rebuilt from that sibling repo's own migration files. A repo that is not on this machine is skipped with a message |

Each git worktree gets its own databases in those containers (`mcp_notes_test_wt_<hash>`,
`connectors_<id>_wt_<hash>`; the main checkout keeps the plain names and `TEST_DB_SUFFIX`
overrides both), so two checkouts can run `test:int` at once. A worktree's databases are dropped
by the next run after the worktree is gone.

Unit and integration tests never read the real `~/.claude`, `~/mcp-notes-data` or Neon: every
path and binary is injected, and the config literals tests build have sessions, the adversary and
movies switched off.

## Docs tooling

The guides under `docs/guide/` are checked against the code.

| Command | What it does |
| --- | --- |
| `npm run docs:gen` | Writes `reference/mcp-tools.md` from the tools the MCP server registers and `reference/http-api.md` from the daemon's route table plus the descriptions in `scripts/docs/httpRoutes.ts`. Opens no database and no socket. |
| `npm run docs:check` | Reports every problem and exits 1 when there is one. |
| `npm run docs:shots -- <guide>...` | `scripts/docs/capture.mjs`: retakes that guide's pictures by running `scripts/docs/shots/<guide>.mjs` with Playwright against a throwaway verify-notesd instance, never the live daemon. `--all` for every guide, `--keep` to leave the instance up, `--no-build` to trust `web/dist`. |

`tests/unit/docs/reference.test.ts` runs the same checks as `docs:check`, so `npm test` fails when:

- `mcp-tools.md` or `http-api.md` differs from what the code generates (fix: `npm run docs:gen`);
- a route the daemon serves has no description in `scripts/docs/httpRoutes.ts`, or a described
  route is gone;
- the code reads an environment variable that has no row in
  [reference/configuration.md](reference/configuration.md), or a row names one nothing reads
  (names that are not settings go in `scripts/docs/envVars.ts` with a reason);
- a relative link or image path in `README.md`, `CLAUDE.md` or `docs/guide/` does not resolve;
- a picture under `docs/guide/img/` is shown by no document.

After adding a route, a tool or a setting: describe it in the file above, run `npm run docs:gen`,
then `npm test`.

## Clickable ids under tmux

Claude writes note, session and movie ids as links to the wall, and Claude Code prints each as an
OSC 8 hyperlink. Windows Terminal supports those (Ctrl+click opens the Windows browser, which
reaches `notesd` through WSL's localhost forwarding), but tmux drops them unless it knows the
outer terminal can show them. With tmux 3.4 or later, add to `~/.tmux.conf.local` (or
`~/.tmux.conf`):

```tmux
set -as terminal-features ',xterm*:hyperlinks'
```

Reload (`tmux source ~/.tmux.conf`), then detach and attach again: terminal features are worked
out per client when it attaches. `tmux list-clients -F '#{client_termfeatures}'` should now
include `hyperlinks`. Test the whole path in a pane:

```sh
printf '\e]8;;http://localhost:7317/\e\\notes wall\e]8;;\e\\\n'
```

`allow-passthrough` is not needed. Outside tmux nothing is needed.

## Uninstall

```sh
scripts/uninstall.sh
```

It stops and removes the unit, runs `claude mcp remove --scope user notes`, removes the
`~/.claude/skills/n` symlink and takes the six hook entries out of `~/.claude/settings.json`,
keeping every other setting. It keeps:

- the data dir (`~/mcp-notes-data`) and the database;
- the other skill symlinks (`migrate`, `v`, `j`, `redo`, `check-seer-adversarial-nightly`):
  remove them from `~/.claude/skills/` by hand;
- the hooks' state in `~/.local/state/notes-capture` and `settings.json.bak-notes-hooks`;
- the raised `cleanupPeriodDays` (lowering it would let Claude Code delete old transcripts);
- linger (`sudo loginctl disable-linger $USER` to undo).

On Windows, run the keepalive script with `-Uninstall`.

## Troubleshooting

- **`notes` shows "Failed to connect" in Claude Code.** `systemctl --user status notesd`, then
  `journalctl --user -u notesd -n 50`. A `ConfigError` names the bad variable.
- **Port 7317 is taken by a dev run.** Stop it; the installer's health check would otherwise pass
  against the wrong process. `ss -ltnp 'sport = :7317'` shows the owner.
- **`/n` is not found.** `ls -l ~/.claude/skills/n` must point at an existing `claude/skills/n`.
  Re-run `scripts/install.sh` from the main checkout.
- **Chat answers "Chat failed", or the installer's chat check fails.** Check the login with
  `claude -p hi`; if it asks you to log in, run `claude` and `/login`. `systemctl --user cat
  notesd | grep NOTESD_CLAUDE_BIN` must name an existing file; a Claude Code reinstall into
  another directory needs `scripts/install.sh` again.
- **The chat panel says `glm` when you expected `claude`.** Claude hit a usage limit or the
  login failed, and the fallback answered. The journal has the Claude error.
- **No folder icon on photos.** `curl -s http://127.0.0.1:7317/api/capabilities`: `"reveal":
  false` means WSL interop, `wslpath` or Explorer was not found when the daemon first looked. On
  a machine that does not hold the original the icon is hidden by design.
- **`/n make that image a new note` has no id for the picture.** `tail
  ~/.local/state/notes-capture/prompt.log`, check that `jq .hooks.UserPromptSubmit
  ~/.claude/settings.json` names `notes-prompt.mjs`, and run `npm run verify:prompt-hook`.
- **The database answers "exceeded the quota".** See
  [architecture.md](architecture.md#neon).

## Where the code is

| Path | What it holds |
| --- | --- |
| `scripts/install.sh`, `scripts/uninstall.sh` | The installer and its undo |
| `scripts/claude-hooks.mjs` | Merges, removes and reports the hook entries and `cleanupPeriodDays` in `~/.claude/settings.json` |
| `deploy/notesd.service` | The systemd user unit template |
| `scripts/windows/install-wsl-keepalive.ps1` | The Windows logon task |
| `scripts/test-int.sh` | The integration test runner (containers, per-worktree databases) |
| `vitest.config.ts` | The single test config |
| `drizzle.config.ts`, `drizzle/` | Migration config (direct URL) and the SQL migrations |
| `scripts/docs/` | `reference.ts` (generate and check), `httpRoutes.ts`, `envVars.ts`, `capture.mjs`, `shots/` |
| `.claude/skills/verify-notesd/` | The throwaway instance used to prove changes and take pictures |
