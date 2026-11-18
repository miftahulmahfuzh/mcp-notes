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
npm run db:migrate           # apply migrations (uses the unpooled URL)
npm run docs:gen             # regenerate docs/guide/reference/{mcp-tools,http-api}.md from the code
npm run docs:check           # stale reference, undocumented route or env var, broken link, unused picture
npm run docs:shots -- wall   # retake a guide's pictures from a throwaway daemon (scripts/docs/shots/<guide>.mjs)
scripts/install.sh           # idempotent: build, systemd user unit, MCP registration, skills, hooks
scripts/install.sh --check-idle   # exit 0: nothing plays or is being started; 75: busy (nothing is changed)
```

- **Restarting the live daemon** ends every stream session and every play being started. `scripts/install.sh` refuses to (exit 75, nothing changed) while `GET /api/movies/player` says `busy`: a VLC play, a stream on screen, or a play still being started (`starting`). That is the one check: never read `stream` or `current` yourself to decide, and never restart with `systemctl` directly. Unattended: `scripts/install.sh --wait` installs once the daemon is idle. `--force` only when the owner said to restart now.

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
- **Changed UI:** retake the pictures with `npm run docs:shots -- <guide>`. Pictures come from the throwaway daemon with seeded data. The one exception is the movies guide, which the owner wants to show their real library: its pictures are retaken with `npm run docs:shots -- --live movies` (read-only against the live daemon; `DOCS_SHOTS_CHAT=1` adds the billed chat pictures, `DOCS_SHOTS_PLAY=1` retakes only `play.gif` and `DOCS_SHOTS_PLAY=popup` only `chat-movie-id.png`, each with one real play, so ask first), and plain `docs:shots -- movies` retakes only `unmatched.png` and `assign.png`. Never replace a real-library picture with a fixture one. A picture nothing shows fails the test.
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
- **Trending** (`src/directStream/trending/`): a daily list on the Stream side of the most seeded films and series on the torrent indexes' own top lists, with a swarm probe per title.
  - `TrendingRepo` is the only writer of `stream_trending`, per host; a build replaces the host's rows. The list holds no watch state: `GET /api/movies/trending` reads seen, started, watched and not-interested from `movie_titles` at each request (`isFreshForTrending`), so a mark takes a title off at once. Never copy a mark into the list.
  - A probe is `TorrentStreams.peek`: join the swarm for its file list only, select nothing, write no `stream_torrents` row, leave. "Confirmed" means a peer sent a file list with a video, never that it plays; the seed count is the index's claim. Nothing is probed while a play exists (`busy`).
  - Plain requests that say they are notesd, like the finder's; never a disguised client for a bot check. `NOTESD_TRENDING=off` (or a missing movie library, direct streaming, torrents or TMDB) is a `DisabledTrending`: nothing is asked. Tests use `TrendingJob` with injected sources, TMDB, peek and clock.
- **Streaming sites** (`claude/streaming/*`): one command, `cli.mjs`, with a module per site in `sites/`. The `/idlix`, `/lk21`, `/flicksy` and `/dramacool` skills and the daemon's `streaming_find` / `streaming_play` tools (`src/mcp/streamingTools.ts`, through `scriptRunner` in `src/streaming/service.ts`) all run it; nothing else talks to a site.
  - Playing drives a real Chrome on Windows through `cdp.ps1` (PowerShell, because WSL cannot reach Windows loopback), with its own profile folder. Never the owner's everyday Chrome, never a Chrome it did not start, and never a disguised client to get past a site's bot check.
  - A link counts only when a site's search returned it; a film starts only when asked, and only when exactly one film matches.
  - A new site follows `claude/skills/create-streaming-skill`, and is added to `sites/index.mjs` and `STREAMING_SITES` together (a test compares them). Tests use a fake runner; `deps.streaming` unset answers `streaming_off`.
- **Direct streaming** (`src/directStream/*`, resolver in `claude/streaming/direct/*`) plays a title in its original language only.
  - Every resolve carries the title's `original_language` (`--audio-lang`); a stream that names other languages only is `dubbed` and skipped, never played. `dubbed` is not provider health.
  - A cloud `.mp4` often has no audio-language tags, so a dub passes the resolver's check. The cloud audio-language check (`src/directStream/audioLang.ts`, run in `vetted`) passes ~30 s of a cloud stream's audio through Whisper's `detect` to hear the spoken language, and a provider heard dubbing a foreign film is passed over for one serving the original. Cloud-only, only when the original language is known and not English; verdict kept per title+provider; `unsure` plays; a dub still plays when nothing else does. `NOTESD_STREAM_AUDIO_CHECK=off`.
  - The stream on screen (`src/movies/streamLive.ts`, `GET /api/movies/player` `stream`) is in memory and fed only by the player page's position reports; a paused page's `beat` must not write to the database.
  - A subtitle from outside the stream (a torrent's `service` / `borrow` file; a cloud stream with no English track gets one per title, `src/directStream/outsideSubtitles.ts`) is re-timed behind the play by Wyzie Synced (`torrent/subtitles/synced.ts`), never in the play's way. Whoever replaces a session's subtitle bumps its `subtitleRev`; the page reloads on the number in the position answer. The Wyzie key and a download `tok` are never logged, thrown or kept; tests inject the fetch, the cutter and the speech detector.
  - The next episode is fetched while one plays (`ahead.ts`, fed by the position route through `DirectStreamService.watched`): a cloud play into the stream cache (`auto`), a torrent play from a torrent. The episode on screen comes first: a download fetched ahead gives way to every other, is `gentle` while the play still streams, and stops when the player reports stalls. A film fetches nothing; `NOTESD_STREAM_AHEAD=off` or a service built without `ahead` (every test's default) starts nothing.
  - A play is in flight from the ask until its page reports (`DirectStreamService.begin`, `starting()`): one per title and named provider, a second ask joins it. Anything that answers a caller with a time limit goes through `playWithin` (`direct_stream_play` answers `pending` after `PLAY_ANSWER_MS`, under the MCP client's 60 s) and never cuts the play short; a play that starts nothing logs every attempt.
  - A torrent is chosen by its swarm, not by the index's seed count: the best three are opened side by side and `chooseOrder` (`torrent/source.ts`) picks among those whose headers arrived; the losers leave at once (`TorrentStreams.drop`). The subtitle chain holds the play for at most `SUBTITLE_HEAD_MS`, then runs behind it and bumps `subtitleRev`. An index is skipped only through `IndexHealth`, never for a `bot_check`.
  - ext.to (a torrent index via the streaming Chrome, `claude/streaming/torrent/sites/ext.mjs`) sits behind a Cloudflare Turnstile that cannot complete in a background tab, so an automated search answers `bot_check`. The owner clears it by hand: `cli.mjs ext gate` foregrounds ext's tab (`tab.ps1 -Activate`), the owner solves the widget, and the `cf_clearance` cookie the `notesd-stream-chrome` profile keeps lets later background searches through. Never forge the challenge token, spoof a fingerprint or click the widget for the owner — the human solves it in their own browser (same rule as the streaming sites: "never a disguised client to get past a site's bot check").
  - `/update-cloud-source`'s frame reader has the same gate: a site whose fresh navigation re-triggers its Cloudflare challenge every time is read instead from a tab the owner already solved by hand (`claude/streaming/direct/cli.mjs gate <site>`, reusing `torrent/tab.ps1` and `torrent/browser.mjs` — origin-agnostic despite living under `torrent/`). `templates --from-tab` (or `direct_stream_update_source`'s `from_tab: true`) then reads that SAME tab's current `<iframe>` addresses with a JS expression (`readFrameTemplatesFromTab`, `claude/streaming/direct/frames.mjs`), never a new navigation — so it sees only the top page's own frames, not one nested inside another cross-origin frame, which the sniffer's fresh-navigation path still sees when the site has no challenge. `no_tab`: no gated tab answered; gate it again.
  - A magnet the owner pasted plays that exact torrent with no index asked: `direct_stream_play`'s `magnet` arg → `DirectStreamService.magnetSession` → `TorrentSource.playMagnet`, which builds one candidate with `candidateFromMagnet` (info hash + `tr=` trackers + `dn` name) and runs it through the same open/probe/remux path. The owner still names the title (ref, poster, resume, original-language check); the original-language rule still refuses a dub or a non-video torrent (an OST). Only a pasted magnet is ever played — nothing is built or guessed.
  - A release whose index name reads as a dub is kept out of normal ranking but offered as `ranked.lastResort` (`find/rank.ts`): `TorrentSource.resolve` tries these in their own round only after every proper candidate fails, and the header probe decides by the real audio (a dual-audio file carrying the original plays; a true dub stays `dubbed`). The original audio track is always the one that plays: the remux maps it (`pickAudioStream`), and a directly-playable dual-audio file whose original is not the default is remuxed, or refused as `dubbed` when no remux can force it (`playsOriginalDirect` in `torrent/source.ts`).
  - Torrents (`src/directStream/torrent/*`): `TorrentsRepo` is the only writer of `stream_torrents`. A torrent is in the swarm only while something uses it, and only its video and subtitle files are selected, read or served; nothing from a torrent is ever run. Tests use `DEFAULT_TORRENT_CONFIG` (off) or a fake engine; the real-engine test seeds over loopback with DHT and trackers off.
- **Claude Code integration lives in `claude/`:** skills (symlinked into `~/.claude/skills` by `install.sh`), six hooks (`claude/hooks/notes-capture|link|paste|prompt|session|spawn.mjs`, merged into `~/.claude/settings.json` by `scripts/claude-hooks.mjs`; `notes-prompt` must stay I/O-free when no node id matches), and the `note-links` mod (own tsconfig and tests).
- **Web app** (`web/`, Vite + React 19, Phosphor icons) is built to `web/dist` and served statically by the daemon; `web/fullscreen.html` is the separate full-screen photo page (`/full/:imageId`).
- **DB:** Drizzle schema in `src/db/schema.ts`, SQL migrations in `drizzle/`, applied to the local database by the daemon at start. A Neon URL goes through the websocket pool, any other through `node-postgres`.

## Watch codenames

The owner names where a title is watched from with one upper-case word, usually the last of a request and never part of a title. A request without one behaves as it always did.

| Codename | Source | How it plays |
| --- | --- | --- |
| DM, DS | the library: a film, a series the owner downloaded | `movies_continue`, VLC |
| NTM, NTS | a cloud provider, never a torrent: a film, a series | `direct_stream_play` with `provider: "cloud"` |
| TM, TS | a torrent: a film, a series | `direct_stream_play` with `provider: "torrent"` |

The same words are told to every client in `src/mcp/instructions.ts`, `src/chat/prompt.ts` and the `direct-stream` and `n` skills: change them together. The ten requests they were written for are in `docs/guide/streaming.md` ("Codenames") and run in `verify.sh up --discovery` (`direct-stream/codenames.sh`).

## Conventions

- **Ids are generated, never invented.** Note ids (`A-B32`, `src/notes/ids.ts`) and session node ids (`A0-3G`, `src/sessions/ids.ts`) come from the server; movie ids (`M-23T4`) come from database triggers, never application code. Note lookup is case-insensitive and tolerates a missing dash.
- **Proving a change:** `.claude/skills/verify-notesd` launches a throwaway daemon (own DB, port, data dir) and drives it over HTTP, MCP and Playwright, saving evidence. Its `features/` map lists what proves each feature. Use it before calling a change done; update the map when a user-facing feature changes.
- `.workflows/` holds task/plan/orchestration records from the planning tooling, and `docs/plans/`, `docs/iterations/` hold design briefs. Check them for the intent behind a feature before changing it.

> [!IMPORTANT]

> when user type in "p" : you must commit and push your work in a new subagent. you also need to rebuild and restart daemon. USE haiku model for this task.
