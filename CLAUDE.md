# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`notesd`, a local daemon (Hono on `127.0.0.1:7317`) that serves one Postgres-backed notes store three ways: an MCP server at `/mcp` for Claude Code, a JSON/SSE API at `/api`, and the React "wall" web app at `/`. `README.md` is the short overview; the detail lives in one guide per subsystem under `docs/guide/`. Read the guide before changing a subsystem:

| Changing | Read first |
| --- | --- |
| The wall, notes, photos, files, recycle bin | `docs/guide/wall.md` |
| MCP server, `/n`, hooks, the `note-links` mod | `docs/guide/claude-code.md` |
| Search, embeddings, `similar_images` | `docs/guide/search.md` |
| Chat bar, chat history | `docs/guide/chat.md` |
| Session graph (`/projects`), ingest, context rot | `docs/guide/sessions.md` |
| Connectors, daily-words (`/v`, `/j`) | `docs/guide/connectors.md` |
| Seer Adversarial (`/adversary`) | `docs/guide/adversary.md` |
| Movies (`/movies`), VLC | `docs/guide/movies.md` |
| Streaming and download sites (`/pahe`, `/idlix`, `/lk21`, `/flicksy`, `/dramacool`) | `docs/guide/streaming.md` |
| Wiring, data model, disk layout, limitations | `docs/guide/architecture.md` |
| Install, tests, docs tooling | `docs/guide/install.md` |
| Tools, routes, settings | `docs/guide/reference/{mcp-tools,http-api,configuration}.md` |

## Commands

```sh
npm run dev                  # daemon with reload (tsx watch src/main.ts)
npm run dev:web              # Vite dev server for web/, proxied to the daemon
npm run build && npm start   # tsc server build + vite build, then node dist/main.js
npm run typecheck            # server (tsconfig.json) AND web (tsconfig.web.json)
npm test                     # unit tests: tests/unit/** (node) + web/src/**/*.test.tsx (jsdom)
npx vitest run tests/unit/path/file.test.ts         # one file
npx vitest run -t "name fragment"                   # one test by name
npm run test:int             # integration tests against pgvector Postgres in Docker (scripts/test-int.sh)
npm run db:generate          # new drizzle migration after editing src/db/schema.ts
npm run db:migrate           # apply migrations by hand (the daemon applies them at every start)
npm run docs:gen             # regenerate docs/guide/reference/{mcp-tools,http-api}.md from the code
npm run docs:check           # stale reference, undocumented route or env var, broken link, unused picture
npm run docs:shots -- wall   # retake a guide's pictures from a throwaway daemon (scripts/docs/shots/<guide>.mjs)
scripts/install.sh           # idempotent: build, systemd user unit, MCP registration, skills, hooks
scripts/install.sh --check-idle   # exit 0: nothing plays or is being started; 75: busy (nothing is changed)
```

- **Restarting the live daemon** ends every stream session and every play being started. `scripts/install.sh` refuses to (exit 75, nothing changed) while `GET /api/movies/player` says `busy`: a VLC play, a stream on screen, or a play still being started (`starting`). That is the one check: never read `stream` or `current` yourself to decide, and never restart with `systemctl` directly. The owner gave standing consent on 2026-11-19 to restart whenever the work needs it: on exit 75 run `scripts/install.sh --force` and say that a play was ended; do not wait for a playback to finish (`--wait` is for a job nobody is waiting on).

- There is a single `vitest.config.ts`; env flags switch which suite runs (integration, `test:live*`). Do not add a second config. Live tests are opt-in, billed, and never part of `npm test` or `test:int`.
- Web test files opt into jsdom with a `// @vitest-environment jsdom` first-line pragma.
- Embeddings in `npm test` / `test:int` come from deterministic fakes, with no network calls.
- Config lives in `.env.local` (`DATABASE_URL`, written by `scripts/install.sh`; `OPENROUTER_API_KEY`). Every variable is in `docs/guide/reference/configuration.md`.
- Node >= 22.22 (`.nvmrc`). ESM throughout; server imports use `.js` suffixes.

## Docs are checked against the code

`tests/unit/docs/reference.test.ts` (same checks as `npm run docs:check`) fails `npm test` on drift. In the same change as the code:

- **New or changed MCP tool:** `npm run docs:gen`.
- **New or changed HTTP route:** describe it in `scripts/docs/httpRoutes.ts`, then `npm run docs:gen`.
- **New environment variable:** add a row to `docs/guide/reference/configuration.md` (a name that is not a setting goes in `scripts/docs/envVars.ts` with a reason).
- **Changed behaviour:** update the subsystem's guide. Never hand-edit the two generated reference files, and never copy tool, route or env tables into a guide or the README.
- **Changed UI:** retake the pictures with `npm run docs:shots -- <guide>`. Pictures come from the throwaway daemon with seeded data (the streaming guide's player pictures too: `docs:shots -- streaming`, faked stream routes and the Sintel trailer). The one exception is the movies guide, which the owner wants to show their real library: its pictures are retaken with `npm run docs:shots -- --live movies` (read-only against the live daemon; `DOCS_SHOTS_CHAT=1` adds the billed chat picture, `DOCS_SHOTS_NAMES=1` retakes only `person.png`, `studio.png`, `genre.png` and `play-menu.png`, `DOCS_SHOTS_PLAY=1` retakes only `play.gif` and `playing.png` and `DOCS_SHOTS_PLAY=popup` only `chat-movie-id.png`, each with one real play, so ask first), and plain `docs:shots -- movies` retakes only `unmatched.png` and `assign.png`. Never replace a real-library picture with a fixture one. A picture nothing shows fails the test.
- Keep `README.md` short: one line per subsystem and a link. Detail goes in the guide.

## Architecture

The rules that are easy to break. The guides have the rest.

- **One notes service is the only writer.** `src/notes/service.ts` writes the revision in the same transaction as every body change and emits an event on `src/notes/events.ts`. HTTP routes (`src/http/*`), MCP tools (`src/mcp/*`) and the chat agent all go through it. The web app listens on `/api/events` (SSE) and re-fetches; it also polls every 5 minutes while visible, and on focus when the last load is older than 60 s, to pick up edits from the other machine.
- **Wiring:** `src/main.ts` / `src/daemon.ts` build `AppDeps` (`src/deps.ts`) and hand it to routes and background jobs (`src/background.ts`).
- **Notes are one plain-text body.** No title or fields. Tags are `#hashtags` re-parsed from the body on every write (`src/notes/tags.ts`). Deletes (notes, images, files) are soft; hard delete exists only in the wall's recycle bin (`src/notes/binRepo.ts`, same-origin-only routes).
- **notesd runs on a Postgres on this machine.** `scripts/install.sh` creates the `mcp-notes-pg` Docker container (127.0.0.1:55437, database `mcp_notes`) and points `DATABASE_URL` at it; the daemon waits for it and applies `drizzle/` at every start (`src/db/localDb.ts`). Nothing at run time may depend on a hosted database. The old Neon address stays as `IMPORT_DATABASE_URL` and is read once (`src/db/sharedImport.ts`): staged into the `import_stage` schema behind the daemon as soon as Neon answers, merged at the next start, and the daemon restarts itself for that when nothing plays. A new table goes into `SHARED_IMPORT_TABLES` with a merge rule only if Neon could hold rows of it. A `DATABASE_URL` from the real environment (tests, the throwaway daemon) is never migrated, waited for or copied into.
- **Rows that point at bytes record their host.** Each machine has its own database now, but two daemons on one Postgres still work, and the copied-in rows of the other laptop are here: photos, files, transcripts and videos live on one host and are recorded with it. Anything made on the other machine reports `available: false` / 404 `not_on_this_machine`. Handle that in new image, file, session or movie code, and in the UI.
- **Images are never re-encoded.** Originals stay byte for byte; thumb/display/preview are derived copies (`src/images/derive.ts`). HEIC is kept as HEIC with a JPEG made for viewing.
- **Search is hybrid** (`src/search/blend.ts` holds the weights). Embedding happens in the background after a write commits and never blocks or fails a save. Vectors are keyed to the sha256 of the body they came from. Without `OPENROUTER_API_KEY`, search degrades to full text and reports `fallback`.
- **Chat bar** (`src/chat/*`) runs on the Claude Agent SDK, with GLM as fallback (`CHAT_BRAIN`). Its tool allow list is `allowedChatTools` in `src/chat/status.ts`. Threads and messages are persisted, and `/n` exchanges are saved by the capture hook via `POST /api/capture/claude-code`.
- **Connectors** (`src/connectors/*`: expenses, runs, seer, dword) find the owner's other apps through sibling repos' `.env.local` (`EXPENSE_TRACKING_DIR`, `RUN_INSIGHTS_DIR`, `SEER_DIR`, `DAILY_WORDS_DIR`). `guard.ts`/`sql.ts` enforce read-only SQL; daily-words alone has a narrow write path (`src/dword/*`). Their integration tests rebuild each schema from the sibling repos' migrations and skip a repo that is missing.
- **Claude Code sessions** (`src/sessions/*`): a background ingester tails `~/.claude/projects/**/*.jsonl` from stored byte offsets. `SessionsRepo` (`src/sessions/repo.ts`) is the only writer of the session tables.
  - Parent links have a source, `fork` > `env` > `hook` > `heuristic`; a worse source never overwrites a better one.
  - A fork starts with a copy of its parent's records. Every reader of a transcript skips records that have a uuid and start before `fork_cut_offset` (`isCopiedRecord`); records without a uuid are always read.
  - Stored replies are the assistant text after a turn's last tool call only, redacted and capped; a turn split across reads must store what one read would.
  - Backfills run once per host behind a version constant (`REPLIES_VERSION`, `FORK_BACKFILL_VERSION`). A session vector is current only at `SESSION_EMBED_TEXT_VERSION`: bump it when `buildEmbedText` changes.
  - To add search context, write one `CandidateSource` (`src/sessions/search.ts`).
  - Transcripts, `session_transcript` and resume work only on the owning host. Every path (`CLAUDE_HOME`, `NOTES_WORKTREES_DIR`, `NOTESD_SWARM_SCRIPT`, tmux, claude bin) is injectable, and tests never touch the real `~/.claude`.
- **Seer Adversarial** (`src/adversary/*`) writes Claude's verdicts, `paused` marks and leases into Seer's DB through `seerWriter.ts` only (a table allow-list; the connector guard stays read-only). `adversary_reviews` is written only by `reviewsRepo.ts`. Only verdicts decided before the session's open count. `NOTESD_ADVERSARY=off` starts nothing; tests use `DEFAULT_ADVERSARY_CONFIG` (off).
- **Movies** (`src/movies/*`): `MoviesRepo` (`src/movies/repo.ts`) is the only writer of the `movie_*` tables; the review is a normal note written through `NotesService`.
  - Titles are shared and never deleted with their files; files are per host and soft-deleted; play events are never deleted.
  - Watch state is derived at read time by `state.ts` only. Never store it.
  - The roots are polled, never watched (`/mnt/c` is drvfs and sends no inotify events).
  - Play starts the Windows `vlc.exe` and reads its status with Windows `curl.exe` (WSL NAT cannot reach Windows loopback). Never reuse or kill a VLC notesd did not start.
  - `NOTESD_MOVIES=off` or no roots starts nothing; tests use `DEFAULT_MOVIES_CONFIG` (off) and inject every path and binary.
- **Names and the play menu** (`src/movies/guides.ts`, `src/http/moviesGuideApi.ts`, `web/src/components/movies/EntityModal.tsx`, `PlayMenu.tsx`): a person, a studio or a genre clicked on a title's page opens a pop-up with its titles; a character still asks the chat.
  - A person and a studio are read from TMDB at each request. A genre's guide is per (title, genre): Claude collates it once with WebSearch (`NOTESD_MOVIES_STORY_MODEL`) and `MoviesRepo.saveGenreGuide` keeps it in `movie_genre_guides`. A title the model names is resolved on TMDB by name and year or left out, never guessed.
  - No list holds watch state: the tags (watched, started, interested, not interested, file here) are read from the titles at each request (`markedTitles`), as Trending does. The three mark buttons of a listed title write through `POST /api/movies/:id/user` like the grid's, after `ensure` for a title not stored.
  - "Interested" (`movie_titles.interested_at`) is the Stream side's watch list and never stands with "not interested" (`MoviesRepo.setTitleUser` clears the other). `listStreamTitles` lists an interested title with no verified source as `interested_only` (shown under that filter alone), and a title last played from a torrent, which verifies no source.
  - A listed title the library does not hold is stored by `POST /api/movies/ensure` before its pop-up opens.
  - The play menu names the source by hand. A site row goes through `POST /api/movies/:id/site-play`: the remembered page of that site first, else the streaming command's own search, which plays only on exactly one match. The pahe row only opens a page the `/pahe` search returned.
- **Streaming** (the Stream side of `/movies`; `src/directStream/*`, `claude/streaming/*`): a cloud provider, a torrent, or one of the four streaming sites (idlix, lk21, flicksy, dramacool). The sites and `create-streaming-skill` are kept: a play with no source named falls back to a site only after every cloud provider and every torrent found nothing, and a named provider, codename or magnet never asks a site. How each part works, and where each rule lives in the code, is `docs/guide/streaming.md` ("The rules in the code"). What must never change:
  - **No disguise, no forged challenge.** Every request says it is notesd. A bot check (Cloudflare, a Turnstile, a login) is the owner's to clear by hand in the streaming Chrome (`cli.mjs ext gate`, `cli.mjs rutracker gate`, `direct/cli.mjs gate <site>`); a script never forges a token, spoofs a fingerprint, clicks the widget, or types a login, and an index is never skipped for a `bot_check`. Scripts never remove or click through an advert: the flow must work with and without the uBlock Origin Lite the owner installed by hand.
  - **Only what notesd started.** Chrome is driven through `cdp.ps1` with its own profile (`notesd-stream-chrome`), VLC through `vlc.exe`. Never the owner's everyday Chrome, and never a Chrome or a VLC notesd did not start.
  - **Original language only.** Every resolve carries the title's `original_language`; a stream that is a dub is `dubbed` (never provider health) and never chosen over one that serves the original. The original audio track is the one that plays. The original language is TMDB's unless the owner set the title's audio language (`movie_titles.audio_language`, `direct_stream_play`'s `audio_lang`, written by `MoviesRepo.setAudioLanguage`), which `MovieStreams.originalLanguage` answers instead; a dub is still never chosen on our own.
  - **Nothing is guessed, nothing starts unasked.** A film starts only when asked and only when exactly one title matches; a link counts only when a site's search returned it; `several_matches` and a nameless play are left unrecorded; a pasted magnet plays exactly that torrent. The daily canary writes provider health only, and the Trending list joins no swarm.
  - **Single writers.** `MoviesRepo` writes every `movie_*` table (the channel a title last played through only once the play is known to run: the player page's first position report or a site's player running, never at resolve time); `TorrentsRepo` writes `stream_torrents`; `TrendingRepo` writes `stream_trending`. The stream on screen is in memory, fed by the player page alone; a paused page's `beat` never writes the database.
  - **Secrets.** The Wyzie key and a download `tok` are never logged, thrown or kept.
  - **Never loosen.** `titleSearchExclusion` (`torrent/find/rank.ts`: the title, then the year ±1 or the episode's marker; never a substring test). `/sync-subtitle`'s rounds: a candidate is never judged on the short round, and a subtitle is replaced or re-timed only when it passed both the text and the timing check.
  - **2 px.** `play.mjs`'s fill-screen style leaves the player 2 px short of the screen; never `100vh` (a full-screen video hides the player's subtitles and controls).
  - **WARP carries the whole machine's traffic.** It is switched only by the owner (the `warp` tool, `/warp`), by a streaming site's one retry, and by a torrent play that found no peer at all on SSID `Employee` (`src/directStream/torrentWarp.ts`); never for a cloud stream, and put back whenever switching did not help. `claude/streaming/warp.mjs` is the one place `warp-cli` and `netsh` run.
  - **Torrents.** A torrent is in the swarm only while something uses it; only its video and subtitle files are selected, read or served, and nothing from a torrent is ever run.
  - **Tests.** Every path, binary, fetch, clock, transcriber and engine is injected; no test touches the network, the real `~/.claude` or the streaming Chrome. `verify.sh` pins `NOTESD_STREAM_CANARY`, `NOTESD_TRENDING`, `NOTESD_STREAM_WARP`, the torrent indexes and the tracker lists off or to fakes. A new torrent index goes into `TORRENT_INDEX_NAMES`, `TORRENT_INDEX_URL_KEYS` (with a configuration row) and both of `verify.sh`'s index lines; a new streaming site into `sites/index.mjs` and `STREAMING_SITES` together (tests compare them).
- **Claude Code integration lives in `claude/`:** skills (symlinked into `~/.claude/skills` by `install.sh`), six hooks (`claude/hooks/notes-capture|link|paste|prompt|session|spawn.mjs`, merged into `~/.claude/settings.json` by `scripts/claude-hooks.mjs`; `notes-prompt` must stay I/O-free when no node id matches), and the `note-links` mod (own tsconfig and tests).
- **Web app** (`web/`, Vite + React 19, Phosphor icons) is built to `web/dist` and served statically by the daemon; `web/fullscreen.html` is the separate full-screen photo page (`/full/:imageId`).
- **DB:** Drizzle schema in `src/db/schema.ts`, SQL migrations in `drizzle/`, applied to the local database by the daemon at start. A Neon URL goes through the websocket pool, any other through `node-postgres`.

## Watch codenames

The owner names where a title is watched from with one upper-case word, usually the last of a request and never part of a title. A request without one names no source: the title plays the way it last played on this machine (below, "What played last time plays first").

| Codename | Source | How it plays |
| --- | --- | --- |
| DM, DS | the library: a film, a series the owner downloaded | `movies_continue`, VLC |
| NTM, NTS | a cloud provider, never a torrent: a film, a series | `direct_stream_play` with `provider: "cloud"` |
| TM, TS | a torrent: a film, a series | `direct_stream_play` with `provider: "torrent"` |

The same words are told to every client in `src/mcp/instructions.ts`, `src/chat/prompt.ts` and the `direct-stream` and `n` skills: change them together. The ten requests they were written for are in `docs/guide/streaming.md` ("Codenames") and run in `verify.sh up --discovery --torrent` (`direct-stream/codenames.sh`).

## Conventions

- **Ids are generated, never invented.** Note ids (`A-B32`, `src/notes/ids.ts`) and session node ids (`A0-3G`, `src/sessions/ids.ts`) come from the server; movie ids (`M-23T4`) come from database triggers, never application code. Note lookup is case-insensitive and tolerates a missing dash.
- **Proving a change:** `.claude/skills/verify-notesd` launches a throwaway daemon (own DB, port, data dir) and drives it over HTTP, MCP and Playwright, saving evidence. Its `features/` map lists what proves each feature. Use it before calling a change done; update the map when a user-facing feature changes.
- `.workflows/` holds task/plan/orchestration records from the planning tooling, and `docs/plans/`, `docs/iterations/` hold design briefs. Check them for the intent behind a feature before changing it.

> [!IMPORTANT]

> when user type in "p" : you must commit and push your work in a new subagent. you also need to rebuild and restart daemon. USE haiku model for this task.
