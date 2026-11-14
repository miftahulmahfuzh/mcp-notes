# Configuration

Every environment variable the code reads. `npm test` fails when the code reads one that has no row
here, or when a row names one nothing reads (`scripts/docs/reference.ts` scans `src/`, `claude/`,
`scripts/` and the two root configs; names that are not settings, such as `HOME` and `PATH`, are
listed with a reason in `scripts/docs/envVars.ts`).

The daemon reads `.env.local` at the root of the checkout it runs from, then the process
environment, and the process environment wins. Settings are read once at start unless a row says
otherwise, so after a change run `systemctl --user restart notesd`. A bad value (a port out of
range, a relative path where an absolute one is needed, `CHAT_BRAIN=glm` without the `LLM_*` keys)
stops the daemon at start with a `ConfigError` that names the variable. Switches take `on` / `off`
(also `1` / `0`, `true` / `false`, `yes` / `no`).

The systemd unit sets only `NOTES_DATA_DIR`, `NOTESD_CLAUDE_BIN`, `HOME`, `PATH` and
`NODE_ENV`; everything else belongs in `.env.local`. Secrets are never written into the unit.

## Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | required | The Postgres URLs. The daemon takes the pooled Neon host and migrations (`npm run db:migrate`) the direct one, chosen by host name (`-pooler`), not by which key holds it. A `DATABASE_URL` exported in the real environment wins outright. A URL that is not a Neon host goes through `node-postgres`. See [architecture.md](../architecture.md#neon). |
| `NOTESD_PORT` | `7317` | HTTP port. The MCP instructions give Claude `http://localhost:<port>` as the wall URL, and the hooks post to it. `scripts/install.sh` registers the MCP server and checks health on 7317 only. `0` means any free port (tests). |
| `NOTESD_HOST` | `127.0.0.1` | Not a setting: any other value stops the daemon. notesd has no authentication and binds loopback only. |
| `NOTES_DATA_DIR` | `~/mcp-notes-data` | Photos, files, derived images, the inbox, handoff files and the VLC health log. The layout is in [architecture.md](../architecture.md#on-disk). Also read by `scripts/install.sh`, which writes it into the unit. |
| `NOTESD_EXPLORER_BIN` | `explorer.exe` on `PATH`, else `/mnt/c/Windows/explorer.exe` | The Windows Explorer that "open file location" starts. The unit's `PATH` has no `/mnt/c`, so the fallback is what normally runs. A wrong value turns the feature off. |
| `NOTESD_EGRESS_METER` | on | `off` disables the query meter (`GET /api/debug/egress`, the hourly `[notesd] egress` log line) and the Neon quota breaker. Read from the process environment only. |

## Chat

The chat bar is described in [chat.md](../chat.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAT_BRAIN` | `claude` | `claude` or `glm`. `glm` runs the chat bar on GLM only and needs the three `LLM_*` keys. |
| `CHAT_MAX_TURNS` | `24` | Agent turn cap per chat message. |
| `CHAT_TIMEOUT_MS` | `180000` | Wall clock per chat message; the run is aborted after it. |
| `NOTESD_CLAUDE_BIN` | `claude` | The Claude Code executable every Claude run starts: the chat bar, session summaries, the Seer Adversarial reviewer, the movie title fallback, and resume from the wall. A bare name is looked up on `PATH`. The unit sets it to the real path of `claude`; to change it re-run `CLAUDE_BIN=/path/to/claude scripts/install.sh`. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | unset | The GLM endpoint (z.ai), key and model. All three set: a Claude run that fails on a usage limit or the login before any text is retried once on GLM. Unset: no fallback. |

## Search and embeddings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | unset | OpenRouter key for note, photo, session and reply embeddings. Unset: notes save as usual, `search` is full text only and says so in `fallback`, `related` answers only for notes that already have a vector, and `similar_images` cannot compare pictures. See [search.md](../search.md). |

## Connectors

Read on every call, from the process environment and then `.env.local`, so a change needs no
restart. See [connectors.md](../connectors.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXPENSE_TRACKING_DIR` | `~/expense-tracking` | The expense-tracking repo. Its `.env.local` gives the database the `expenses_*` tools read. |
| `RUN_INSIGHTS_DIR` | `~/run-insights` | The run-insights repo, for the `runs_*` tools. |
| `SEER_DIR` | `~/seer` | The Seer repo, for the `seer_*` tools, the Seer Adversarial reviewer and its nightly dispatch. |
| `DAILY_WORDS_DIR` | `~/daily-words` | The daily-words repo, for the `dword_*` tools. |
| `CONNECTOR_TIMEOUT_MS` | `10000` | Statement timeout per connector query, 100 to 300000. A value outside that range is ignored. |
| `DWORD_USER_EMAIL` | unset | The owner's `users.email` in daily-words, resolved to a user id on every write. Unset or no matching row: `dword_vocab_add` and `dword_journal_add` refuse and write nothing; `dword_schema` and `dword_sql` still work. Read at start. |

## Sessions

The project session graph is described in [sessions.md](../sessions.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTESD_SESSIONS` | on | `off` stops this daemon reading Claude Code transcripts and summarizing sessions. The graph then shows only what is already in the database. |
| `CLAUDE_HOME` | `~/.claude` | Where Claude Code keeps `projects/` (transcripts), `sessions/` (which sessions are running) and `jobs/` (background jobs). Read, never written. |
| `NOTES_WORKTREES_DIR` | `~/.worktrees` | Root of the `<repo>/<slug>` worktrees. A session run in one is filed under its repo, even after the worktree is deleted. |
| `NOTESD_SWARM_SCRIPT` | `skills/swarm/swarm.py` under `CLAUDE_HOME` | The swarm script asked whether an orchestrator still has phases to do (the "unfinished" badge). Missing file: no badge. |
| `NOTESD_TMUX_BIN` | `tmux` | The tmux binary that resume from the wall runs. Read from the process environment only. |
| `NOTESD_TMUX_SOCKET` | unset | A tmux socket path for resume (`tmux -S`). Unset: the default socket, which the systemd user unit reaches. Read from the process environment only. |
| `CC_PARENT_SESSION` | set by the spawner | Not for `.env.local`. The session id of the session that starts a child, put in the child's environment by "Spawn fresh" and by the swarm script. The notes-session hook reads it and reports the parent, which links the two with source `env`. |

## Seer Adversarial

The reviewer is described in [adversary.md](../adversary.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTESD_ADVERSARY` | on | `off` stops the reviewer on this machine: no reviews, no `paused` marks, no leases. The ON/OFF toggle on `/adversary` is a different switch, kept in the shared database and obeyed by both machines. |
| `ADVERSARY_DAILY_CAP` | `15` | Deep reviews (one per stock) per WIB day, counted across both machines. A pick over the cap is left unreviewed and logged as `skipped_budget`. |
| `ADVERSARY_GATHER_MODEL` | `sonnet` | Claude model alias or id for the gathering stage (news, filings, prices). |
| `ADVERSARY_VERDICT_MODEL` | `opus` | Claude model alias or id that writes the verdict. Its exact id is stored on every verdict. |
| `ADVERSARY_GATHER_MAX_TURNS` | `20` | Turn cap of the gathering stage for one stock. A stock that runs out is judged on what was gathered. |
| `ADVERSARY_STOCK_TIMEOUT_MS` | `420000` | Wall clock for one stock, both stages together. A stock that times out gets no verdict. |
| `ADVERSARY_POLL_MS` | `600000` | Pause between automatic review passes. "Review now" starts a pass at once. |
| `NOTESD_SEER_DISPATCH` | on | Each automatic pass starts Seer's GitHub nightly (`gh workflow run`) once it is due and none has succeeded, because GitHub's own cron fires after the US open. Needs `gh` logged in on this machine; a no-op without it. `off` leaves the nightly to GitHub's cron. |
| `NOTESD_GH_BIN` | `gh` on `PATH`, then `~/.local/bin`, `/usr/local/bin`, `/usr/bin` | The `gh` binary the dispatch runs. Read from the process environment only. |

## Movies and VLC

The library and playback are described in [movies.md](../movies.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOTESD_MOVIES` | on | `off` stops the Movies library on this machine: no scan, no TMDB call, no VLC, and every `/api/movies` route answers 503 `movies_off`. |
| `NOTESD_MOVIES_ROOTS` | unset | The folders scanned for films and series: absolute paths separated by `:`, searched recursively. Spaces are fine. Unset: nothing is scanned, but the library, playback and the routes still work. |
| `NOTESD_MOVIES_DONE_DIRS` | `Done` | Folder names (not paths) separated by `:`, any case. A file found in or moved into one, at any depth below a root, counts as finished. |
| `NOTESD_MOVIES_SCAN_MS` | `120000` | Pause between library passes. The folders are polled, never watched: `/mnt/c` sends WSL no file events. |
| `NOTESD_MOVIES_MIN_SECONDS` | `900` | Videos shorter than this go to the unmatched list as `too_short`, without a TMDB lookup. |
| `NOTESD_MOVIES_FALLBACK_MODEL` | `haiku` | Claude model asked for a title and year when a file name has no confident TMDB match: one short call per such file. `off`: no fallback. |
| `TMDB_API_READ_ACCESS_TOKEN` | unset | TMDB v4 read access token, sent as a Bearer header. Preferred. |
| `TMDB_API_KEY` | unset | TMDB v3 API key, used only when there is no token. With neither, files are registered but all unmatched as `no_tmdb_credentials`. |
| `TMDB_API_BASE` | `https://api.themoviedb.org/3` | TMDB API root. Tests and `verify.sh up --movies` point it at a fake. |
| `TMDB_IMAGE_BASE` | `https://image.tmdb.org/t/p` | Where poster URLs point. Posters are linked, never stored. |
| `NOTESD_FFPROBE_BIN` | `ffprobe` | Reads each video's duration. |
| `NOTESD_VLC_BIN` | `/mnt/c/Program Files/VideoLAN/VLC/vlc.exe` | The Windows VLC that Play starts. |
| `NOTESD_VLC_HTTP_PORT` | `47318` | First port of the HTTP interface notesd turns on in a VLC it starts (Windows loopback, a new password each launch). |
| `NOTESD_VLC_POLL_MS` | `5000` | How often a playing VLC's position is read into its play event. |
| `NOTESD_VLC_INI` | unset | Absolute path of VLC's `vlc-qt-interface.ini`, read on every pass for its recent files list, so films opened from Explorer count too. Unset: only plays started from notesd are recorded. |
| `NOTESD_VLC_HEALTH_MS` | `30000` | How often every `vlc.exe` is sampled into the health log. `0` turns the log, crash incidents and hang detection off; 1 to 4999 is rejected. |
| `NOTESD_VLC_EXTRA_ARGS` | unset | Extra `vlc.exe` arguments for every VLC notesd starts, split on whitespace, for example `--avcodec-hw=none`. `--http-*`, `--extraintf`, `--intf` and `-I` are rejected. |
| `NOTESD_CURL_EXE` | `/mnt/c/Windows/System32/curl.exe` | The Windows `curl.exe` that reads VLC's status. WSL's NAT networking cannot reach Windows loopback, so the request is made from the Windows side. |
| `NOTESD_TASKLIST_EXE` | `/mnt/c/Windows/System32/tasklist.exe` | The Windows tasklist the health log runs each interval. Missing: the health log is off. Read from the process environment only. |
| `NOTESD_POWERSHELL_EXE` | `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` | Reads each `vlc.exe`'s memory and handles and the Windows events for a crash incident, and puts a VLC that notesd starts in front. Missing: thinner samples, and VLC opens behind the window in use. Read from the process environment only. |

## Install script and hooks

Read by `scripts/install.sh`, `scripts/uninstall.sh` and the Claude Code hooks, not by the daemon.
See [install.md](../install.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_BIN` | `node` on `PATH`, then `~/tools/node-v22.23.1-linux-x64/bin/node` | The Node 22 binary the unit and the hooks run with. |
| `CLAUDE_BIN` | `claude` on `PATH`, then next to node | The `claude` CLI used to register the MCP server. Its real path becomes the unit's `NOTESD_CLAUDE_BIN`. |
| `SKIP_CHAT_CHECK` | unset | `1` skips the one real chat message in the installer's verification (offline runs). |
| `NOTES_SKIP_HOOKS` | `0` | `1` leaves `~/.claude/settings.json` alone: no hooks, no `cleanupPeriodDays`. Same as `--skip-hooks`. |
| `NOTES_PASTE_STRATEGY` | `updatedInput` | `deny` registers the notes-paste hook in its fallback mode (see `claude/hooks/notes-paste.mjs`). The installer writes it into the hook's command; the hook reads it. |
| `NOTES_CLAUDE_RETENTION_DAYS` | `3650` | The minimum `cleanupPeriodDays` the installer writes to `~/.claude/settings.json`, so Claude Code keeps the transcripts the session graph reads. A higher value already there is kept. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's own setting. When it is an absolute path the notes-session hook looks for the running-session registry there. The daemon passes it through to the Claude children it starts, because the login lives there. |

## Tests

None of these belong in `.env.local`. See [install.md](../install.md#tests).

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITEST_INTEGRATION` | set by `test:int` | `1` switches the single `vitest.config.ts` from the unit suite to `tests/integration/**`. |
| `TEST_DATABASE_URL` | set by `test:int` | The notes test database in the `mcp-notes-pg-test` container. |
| `TEST_CONNECTORS_URL` | set by `test:int` | The admin URL of the `mcp-notes-pg-connectors` container, where one database per connector is rebuilt. Not set for `test:live`. |
| `TEST_DB_SUFFIX` | none in the main checkout, `_wt_<hash>` in a worktree | Appended to the test database names, so two checkouts can run `test:int` at once. Set it to override. |
| `CHAT_LIVE_TEST` | set by `test:live` | `1` runs only the live chat suite: real, billed Claude and GLM calls. |
| `CONNECTORS_LIVE_TEST` | set by `test:live:connectors` | `1` runs only the live connector suite: each `*_schema` tool against the real databases, read-only. |
| `EMBEDDINGS_LIVE_TEST` | set by `test:live:embeddings` | `1` runs only the live embeddings suite: one real, billed OpenRouter call. |
| `IMAGE_EMBEDDINGS_LIVE_TEST` | set by `test:live:imageEmbeddings` | `1` runs only the live image embeddings suite: a few real, billed calls. |

## Docs tooling

Read by the picture scripts under `scripts/docs/shots/` (`npm run docs:shots`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCS_CHAT_BILLED` | unset | `1` lets the chat guide's shots send real chat messages (a billed Claude agent). Unset: those pictures are kept as they are. |
| `DOCS_CHAT_STEPS` | `answer,image,reply` | Which of the billed chat steps run when `DOCS_CHAT_BILLED=1`. |
| `DOCS_SHOTS_CHAT` | unset | `1` lets the movies guide's shots retake the one picture that needs a real chat answer. |
| `VERIFY_HOME` | `~/.local/state/notesd-verify` | Where the verify-notesd skill keeps the state of its throwaway instances; the sessions shots find their instance's `CLAUDE_HOME` there. |
