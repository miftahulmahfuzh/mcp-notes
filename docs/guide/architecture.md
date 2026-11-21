# Architecture

How `notesd` is built, for someone about to change it: the process, how it is wired, the rule
that keeps writes consistent, what lives in the database and what lives on disk, how two machines
share it, and what it does not do. What each subsystem does for the user is in the other guides;
this file is about structure.

## The process

One Node process, `notesd`: a Hono app on `127.0.0.1:7317` that serves one Postgres-backed store
three ways, plus background jobs.

```
 Claude Code (/n, any repo) ──MCP──┐
 Claude Code hooks ────────────────┤     ┌──────────────────────────────┐     ┌──────────────────┐
 Browser http://localhost:7317 ────┼────▶│ notesd  (Hono, 127.0.0.1)    │────▶│ Postgres (Neon)  │
   wall · projects · movies · chat │     │  /mcp   MCP, streamable HTTP │     │ shared by both   │
                                   │     │  /api   JSON, SSE, uploads   │     │ machines         │
 ~/mcp-notes-data/inbox ──watch────┘     │  /      the web app          │     └──────────────────┘
                                         │  one NotesService + events   │────▶ ~/mcp-notes-data
                                         │  background jobs             │      (this machine only)
                                         └──────────────────────────────┘
        reads ~/.claude/projects (sessions) · sibling repos' databases (connectors) · Windows VLC
```

| Surface | Served by | Reference |
| --- | --- | --- |
| `/mcp` | `src/mcp/server.ts`, one stateless JSON-RPC exchange per `POST` | [reference/mcp-tools.md](reference/mcp-tools.md) |
| `/api/*` | The routers in `src/http/*.ts`, mounted by `src/http/app.ts` | [reference/http-api.md](reference/http-api.md) |
| `/`, pages and assets | `src/http/static.ts` from `web/dist` | [Pages](#pages) below |

## Wiring

| File | Role |
| --- | --- |
| `src/main.ts` | Entry point: `loadConfig()`, `startDaemon()`, and a shutdown on `SIGINT` / `SIGTERM` that is forced after 10 s. |
| `src/config.ts` | Builds `Config` from `.env.local` under the process environment (the environment wins). Every bad value throws `ConfigError` here, so nothing downstream re-validates. The `DEFAULT_*_CONFIG` literals have sessions, the adversary, movies and direct streaming off, so a test that builds a `Config` by hand starts none of them. |
| `src/daemon.ts` | `startDaemon`: data dirs, embedders, `createDb`, `NotesService`, `ChatService`, the adversary, movies, player and health monitor, direct streaming (each null when off; direct streaming loads the provider seed), `createApp`, listen on loopback, then `startBackground`. Returns `stop()`, which closes them in the reverse order. |
| `src/deps.ts` | `AppDeps`: what `startDaemon` hands to every router and job (`config`, `db`, `events`, `service`, `embedder`, `imageEmbedder`, `chat`, `adversary`, `movies`, `moviesPlayer`, `moviesHealth`, `sessionEvents`, and the streaming parts, `streaming`, `warp`, `directStream`, `streamCache`, `torrents`, `streamDownloads`, `cacheShelf`, `streamLive`, `streamPreviews`, `streamCanary`, `trending`, `trackerLists`, `streamEvidence` and `subtitleCheck` among them). A subsystem that is off is `null` there, and its routes answer 503. |
| `src/http/app.ts` | `createApp(deps, options)`: mounts `/health`, `/mcp` and each router. `options` are the test seams (chat backend, reveal, sessions, resumer, Seer source). `mcpToolDeps` builds what the MCP tools get from the same `deps`. |
| `src/background.ts` | `startBackground(deps)`: starts the jobs below and returns one stop function. |

Routers and tools take `deps` and never build their own services. To add a subsystem: a config
section with a default-off literal, a field on `AppDeps`, a router mounted in `createApp`, tools
registered in `src/mcp/`, and a job in `startBackground` if it needs one.

## One writer

`NotesService` (`src/notes/service.ts`) is the only code that writes notes, photos, files, tags
and revisions. HTTP routes, MCP tools, the inbox watcher and the chat agent (through `/mcp`) all
call it.

- Every body change writes the previous body to `note_revisions` in the same transaction.
- Tags are re-parsed from the body on every write (`src/notes/tags.ts`); nothing sets them
  directly.
- After the transaction commits, the service emits on `NoteEvents` (`src/notes/events.ts`).
  `GET /api/events` forwards each event to the wall, which re-fetches.
- Embedding is queued after the commit and runs in the background. It never blocks or fails a
  save.
- Deletes are soft (`deleted_at`). Hard delete exists only in `src/notes/binRepo.ts`, behind the
  recycle bin's same-origin routes.

The other stores follow the same pattern, one writer each:

| Tables | Only writer |
| --- | --- |
| `chat_*` | `ChatService` (`src/chat/service.ts`) |
| `cc_*` session tables | `SessionsRepo` (`src/sessions/repo.ts`) |
| `movie_*` | `MoviesRepo` (`src/movies/repo.ts`); a review is a normal note written through `NotesService` |
| `stream_providers`, `stream_provider_health`, `stream_caches` | `DirectStreamRepo` (`src/directStream/repo.ts`) |
| `stream_torrents` | `TorrentsRepo` (`src/directStream/torrent/repo.ts`) |
| `stream_torrent_marks` | `TorrentMarksRepo` (`src/directStream/torrent/marks.ts`) |
| `stream_downloads` | `DownloadsRepo` (`src/directStream/downloads/repo.ts`) |
| `stream_trending` | `TrendingRepo` (`src/directStream/trending/repo.ts`) |
| `adversary_reviews` | `src/adversary/reviewsRepo.ts` |
| Seer's own database | `src/adversary/seerWriter.ts`, behind a table allow-list. The connector guard stays read-only |
| daily-words | `src/dword/writer.ts`, additions only |

Ids are generated on the server and never invented by a caller: note, photo and file ids
(`A-B32`, `src/notes/ids.ts`), node ids (`A0-3G`, `src/sessions/ids.ts`), and movie ids
(`M-23T4`), which the database itself assigns through triggers.

## Data model

The schema is `src/db/schema.ts` (Drizzle); the migrations are the SQL files in `drizzle/`.
After editing the schema run `npm run db:generate`; the daemon applies the new migration at its
next start (`npm run db:migrate` applies it by hand).

| Subsystem | Tables | Notes |
| --- | --- | --- |
| Notes | `notes`, `note_revisions` | One plain-text body per note, `tags[]` derived from it, `origin`, `deleted_at`. A GIN full-text index over the body on the `simple` configuration. The `image_path` / `image_meta` columns are the old one-photo layout: read once at start to copy any stragglers into `note_images`, never written. |
| Photos and files | `note_images`, `note_files` | One row per photo or file with its own id, `sha256`, `host`, `position`, `deleted_at`. A note's first photo carries the note's id. Dedupe is by `sha256` among rows not removed. `note_files.extracted_text` is reserved; nothing fills it. |
| Embeddings | `note_embeddings`, `note_image_embeddings` | pgvector, 1536 dimensions, HNSW cosine. A note vector is keyed to the sha256 of the body it came from, so a stale one is never used. |
| Chat | `chat_threads`, `chat_messages`, `chat_message_revisions`, `chat_message_attachments`, `chat_images` | Threads from the wall and from `/n` captures; soft-deleted messages; pasted images. |
| Sessions | `cc_sessions`, `cc_subagent_transcripts`, `cc_session_prompts`, `cc_session_prompt_images`, `cc_session_replies`, `cc_session_reply_embeddings`, `cc_session_embeddings`, `cc_pending_spawns`, `note_session_links` | What ingest read from Claude Code's transcripts and hooks: byte offsets, tokens, commits, prompts, redacted replies, summaries, fork and context evidence, and the links between notes and sessions. |
| Seer Adversarial | `adversary_reviews` | The attempt and usage log. Verdicts, `paused` marks and leases live in Seer's database. |
| Movies | `movie_titles`, `movie_episodes`, `movie_companies`, `movie_title_companies`, `movie_people`, `movie_credits`, `movie_files`, `movie_plays`, `movie_ids`, `movie_stream_sources`, `movie_title_channels`, `movie_title_methods`, `movie_site_titles`, `movie_dialogues`, `movie_stories`, `movie_genre_guides`, `movie_episode_marks` | Titles are shared and never deleted with their files; files are per host and soft-deleted; play events are never deleted (a stream play names its title instead of a file). Stream sources are per host: what each machine verified or found stale. Watch state is derived at read time, never stored. Stories (film, episode, season) are kept in `movie_stories`, one row each, with their web sources. |
| Direct streaming | `stream_providers`, `stream_provider_health`, `stream_caches`, `stream_torrents`, `stream_torrent_marks`, `stream_downloads`, `stream_trending` | The provider registry is loaded from `claude/streaming/direct/providers.seed.json` at every start; health is one row per provider and host. Stream sessions are in memory, never stored. A stream cache is one film or episode downloaded on one host: one row per title and host, its files only on that host. A torrent download is one per host and info hash: the title it was opened for, its chosen files, its state; the files only on that host. A torrent's marks are per info hash, whatever the title: the languages its file tags, the language heard in it, and the owner's blacklist. A download is one film or episode the owner asked for on one host (a season click makes one per episode under one batch); it ends on a torrent download, kept by the owner (`stream_torrents.kept_at`: both prunes skip it), or on the owner's stream cache. |
| Settings | `app_settings` | Key and JSON value: the selected project, the adversary toggle, the nightly dispatch state. |

Dropping the session tables loses summaries already paid for and the rows of transcripts Claude
Code has since deleted; everything else is read again from the transcripts still on disk.

## On disk

Only text and metadata are in Postgres. Bytes live under `NOTES_DATA_DIR` (default
`~/mcp-notes-data`) on the machine that took them in.

```
~/mcp-notes-data/
  images/YYYY/MM/<imageId>.<ext>     photo originals, byte for byte, never re-encoded
  files/<noteId>/<name>              a note's other files, byte for byte, Windows-safe names
  cache/<imageId>/thumb.webp         480 px wide, for the wall and the gallery
  cache/<imageId>/preview.jpg        long edge 1568 px, what Claude is shown
  cache/<imageId>/display.jpg        full resolution, only for HEIC, HEIF and TIFF
  cache/c_<id>/                      the same derived copies for pasted chat images
  inbox/                             drop pictures here to ingest them; failures move to inbox/failed/
  chat-images/YYYY/MM/<id>.<ext>     pictures pasted into the chat bar or a /n prompt
  chat/                              working directory of chat agent runs (nothing is kept there)
  session-summaries/, adversary/     working directories of the summary and reviewer runs
  handoffs/                          "Spawn fresh" handoff files, deleted after 14 days
  movies/vlc-health-<host>.jsonl     the VLC health log, fsync'd, 5 MB plus one previous file
  movies/stream-cache/<id>/          a stream cache: local playlists, segments, keys, subtitle (NOTESD_STREAM_CACHE_DIR)
  movies/torrents/<info hash>/       a torrent download: the chosen video and subtitle files (NOTESD_TORRENT_DIR)
  movies/stream-subs/<title>/        a title's English subtitle from a subtitle service, for cloud streams that have none
```

`cache/` can be deleted at any time; everything in it is rebuilt on request
(`src/images/derive.ts`). Delete forever removes a photo's original and its `cache/<imageId>/`
folder, or a note's `files/<noteId>/` folder, and nothing else. Back up `images/` and `files/`
yourself: they exist nowhere else.

Outside the data dir:

| Path | What |
| --- | --- |
| `~/.local/state/notes-capture/` | The hooks' state: `outbox/` (captures waiting for the daemon), `prompt-images/` (which pasted images a session already uploaded) and one log per hook. |
| `~/.claude/projects/**/*.jsonl` | Claude Code's transcripts. Read by the session ingester, never written. |
| `~/.claude/settings.json`, `~/.claude/skills/` | The hook entries and skill symlinks `scripts/install.sh` adds. |
| `~/.config/systemd/user/notesd.service` | The unit. |

## Two machines

Each machine runs its own `notesd` on [its own database](#the-local-database), so two laptops
share nothing: each got the old shared database once and has gone its own way since. What follows
still holds for two daemons pointed at one Postgres (`DATABASE_URL` set by hand on both), which is
how notesd ran on Neon. They then share the database, not the disk.

- Everything in a shared Postgres is the same on both: notes, tags, revisions, the bin, vectors,
  chat history, session rows, movie titles, ratings and reviews, `app_settings`.
- Every row that points at bytes records a `host`: photos, files, chat images, session
  transcripts, movie files and plays. On the other machine such a row reports `available: false`,
  and asking for the bytes answers 404 `not_on_this_machine` with the host. New photo, file or
  transcript code has to handle that, and so does the UI (a placeholder, a hidden folder icon, a
  disabled Play).
- Work that needs the bytes is done by the owning host only: image embedding, reply embedding,
  session summaries, the transcript reads behind `session_transcript`, resume.
- Events do not cross machines. `GET /api/events` carries this daemon's writes only, so the wall
  also polls while its tab is visible: notes every 5 minutes (and on focus when the last load is
  older than 60 s), the session graph every 30 to 120 s, the project list and the adversary page
  every 2 minutes, movies every minute. The list routes send an `ETag`, so an unchanged poll is a
  304 that costs one aggregate query.
- Background work that both daemons may do (note embedding, the adversary's leases) is
  idempotent or claimed in the database.

## The local database

notesd runs on a Postgres on the machine itself. Nothing it does while running depends on a
hosted database.

- **Where it is.** `scripts/install.sh` creates the Docker container `mcp-notes-pg`
  (pgvector/pgvector:pg16, 127.0.0.1:55437, database `mcp_notes`, a named volume, restarted by
  Docker after a reboot) and points `DATABASE_URL` in `.env.local` at it. The file as it was is
  copied to the data dir first (`env.local.backup-<time>`). A `DATABASE_URL` that already names
  another Postgres that is not Neon is left alone, and without Docker nothing is changed.
- **Schema.** The daemon applies `drizzle/` to it at every start (`src/db/localDb.ts`), after
  waiting up to a minute for a container that is still coming up; when it does not answer the
  daemon exits and systemd starts it again. `npm run db:migrate` goes to the same database.
- **One database.** Notes, chat, sessions, movies and streaming all live in it. Only one link
  crosses subsystems without a foreign key: `movie_titles.review_note_id`, the review note.
- **Backups are yours.** The volume is the only copy. `docker exec mcp-notes-pg pg_dump -U
  postgres mcp_notes` writes one.

### The one-time copy

Before this, notesd ran on Neon. `scripts/install.sh` keeps that address as `IMPORT_DATABASE_URL`,
and what it holds is copied in once (`src/db/sharedImport.ts`), in two steps, because Neon may be
unreadable for weeks (a used-up free plan) while the machine already works on its own database:

1. **Staging**, behind the running daemon: at start and then hourly, each table is read page by
   page into the `import_stage` schema of the local database. A table that is done is never read
   again, so an interrupted run carries on.
2. **Merging**, at the daemon's start, before anything else uses the database: one transaction
   moves the staged rows into the real tables, drops the stage and writes the `shared_import` row
   of `app_settings`. Once staging completes the daemon restarts itself for this, waiting while
   something plays.

What the merge does with rows written here meanwhile:

- A note, chat thread or session written here stays. A local note or session whose random id the
  shared side also uses gets a new id; the shared ids are the ones notes quote.
- A session both sides know comes from the shared side with its prompts, replies, summary and
  node id, and the ingester reads on from that row's offset.
- Chat messages keep their order, the local ones numbered after the shared ones.
- Movies: the owner's marks and plays arrive, a file already scanned here keeps its row and takes
  the shared plays, the shared movie ids (`M-23T4`) win and a local one that collides is issued
  again.
- Session and reply vectors are not copied; the workers make them again.

Until the merge has run, session summaries and reply vectors wait (the copy brings the old ones,
and making them twice is paid for twice), and the session graph holds only what this machine
re-read from its transcripts.

## Neon

Neon is only the source of the one-time copy now. What follows describes a daemon whose
`DATABASE_URL` still names a Neon host.

Nothing asks the database on a timer shorter than 30 minutes while the machine is idle. The
embedding workers (notes, pictures, session replies) and the summary worker are woken by what
this daemon writes: a note event, a session read (replies drain at most once a minute; summaries
are checked once a session has been quiet for the idle time) and the summarize route. Their
30-minute sweeps only catch what no event announced (and, on a shared Postgres, a second daemon's
writes). The session
ingest's own 60-second sweep reads files, not the database.

On Neon the database is Postgres with pgvector.

- **Two URLs.** `.env.local` holds a pooled host (`-pooler` in the name) and a direct one. The
  daemon uses the pooled host through `@neondatabase/serverless` over a websocket pool, which
  supports interactive transactions. Migrations (`drizzle.config.ts`) need the direct host. Both
  are picked by host name, not by which key holds them. A URL that is not `*.neon.tech` (the
  Docker Postgres in tests) goes through `node-postgres`; both drivers sit behind one `Db` type
  (`src/db/client.ts`).
- **The egress meter.** Every query result is counted per query shape (`src/db/meter.ts`): calls,
  rows and approximate bytes, estimated from the row JSON. `GET /api/debug/egress` (loopback only)
  and an hourly `[notesd] egress` log line list the shapes that returned the most bytes.
- **The quota breaker.** When Neon answers `53000 ... exceeded the quota` (the free plan's
  monthly network transfer), `src/db/quota.ts` stops sending queries for 30 minutes and logs
  `[notesd] Neon quota exceeded; pausing database queries for 30 min` once, instead of retrying
  from every background loop on both machines. The first query after the pause is the probe.
  Nothing is lost; the wall and the tools report the database error meanwhile.
  While it is tripped no connection is opened either (a transaction starts with one), and a
  connection Neon hangs up on after refusing it is dropped quietly: it used to end the daemon,
  and with it every stream session, on each chat message sent while over quota.
- `NOTESD_EGRESS_METER=off` disables both. The `ETag` / 304 answers stay on.

Keeping transfer low is why the wall polls slowly and only while visible, and why list routes
answer 304 from one aggregate fingerprint query (`src/notes/fingerprint.ts`).

## Security posture

Single user, no authentication. The protections are about where a request comes from.

| Guard | Where | Rule |
| --- | --- | --- |
| Loopback bind | `src/config.ts`, `src/daemon.ts` | The daemon listens on `127.0.0.1` only. `NOTESD_HOST` set to anything else stops it at start. |
| DNS-rebinding guard | `loopbackOnly` in `src/http/app.ts`, on `/mcp` | The request URL (from the `Host` header) must name loopback, and an `Origin`, when present, must be loopback. Claude Code sends no `Origin`. |
| Same-origin routes | `sameOriginOnly` in `src/http/sameOrigin.ts` | The `Origin` must equal the request's own loopback origin, so only the wall's page can call them: delete forever, reveal in Explorer, chat edits and deletes, resume and summarize, the selected project, the adversary toggle and "Review now", every movie write and play, a direct-stream play or refresh. A `curl` without `Origin` gets 403 `forbidden_origin`. |
| Capture header | `captureGuard` in `src/http/capture.ts` | The hook routes need loopback, a JSON body and `X-Notes-Capture: 1`. A custom header forces a CORS preflight, which notesd never answers, so a page on another origin cannot post. |
| Loopback reads | `loopbackReadGuard` in `src/http/sessionsApi.ts` | `GET /api/sessions/context` and `GET /api/debug/egress`. |
| Served files | `src/http/images.ts`, `files.ts` | Photos go out with `nosniff` and a sandbox CSP; other files always as attachments. Routes take ids, never paths. |
| Stream pass-through | `src/directStream/passThrough.ts`, `GET /api/stream/sessions/:id/p` | Works only for a live session (a 32-character random id held in memory) and only towards hosts that session's resolve returned or that a playlist, manifest or redirect fetched through it named; anything else is refused before a request is made. It sends only the captured `Referer`, `Origin` and `User-Agent` and the player's `Range`. Not an open proxy. |
| Read-only connectors | `src/connectors/guard.ts`, `sql.ts` | The `*_sql` tools accept a single read-only statement with a statement timeout. |
| Claude children | `src/chat/env.ts` | Every Claude run notesd starts has API keys, base-URL and model overrides and the parent session's markers stripped from its environment, so it uses the owner's login. Session replies and summaries are redacted before they are stored (`src/sessions/redact.ts`). |

Anyone with a shell on the machine can read everything. Other read routes are open to any local
process and, through the browser, to any page that can reach `localhost`; they return data only.

## Background jobs

Started by `startBackground` after the server listens. Each logs one line at start saying whether
it is on.

| Job | Runs when | What it does | Code |
| --- | --- | --- | --- |
| Legacy photo copy | Always, once at start | Copies photos an older daemon left in `notes.image_path` into `note_images`. | `src/images/legacy.ts` |
| Inbox watcher | Always | Watches `inbox/` and turns each picture into a photo note; failures move to `inbox/failed/`. | `src/images/inbox.ts` |
| Note embedding worker | `OPENROUTER_API_KEY` set | Embeds pending note bodies in batches, with backoff, and sweeps for notes no event announced. | `src/embeddings/worker.ts` |
| Image embedding worker | `OPENROUTER_API_KEY` set | Embeds this machine's photos for `similar_images`. | `src/embeddings/imageWorker.ts` |
| Session ingest | `NOTESD_SESSIONS` on | Runs the one-time backfills, then tails `<CLAUDE_HOME>/projects` from stored byte offsets. | `src/sessions/ingest.ts` |
| Parent link worker | `NOTESD_SESSIONS` on | Links sessions to their parents from what the parent wrote. | `src/sessions/links.ts` |
| Summary worker | `NOTESD_SESSIONS` on and `claude` found | One Haiku summary per idle session, then its embedding. | `src/sessions/summaryWorker.ts` |
| Reply embedding worker | Sessions on and an embedder | One vector per stored reply of this host's sessions. | `src/sessions/replyEmbeddings.ts` |
| Adversary reviewer | `NOTESD_ADVERSARY` on and `claude` found | Polls Seer's candidates, writes verdicts, starts Seer's nightly. | `src/adversary/service.ts`, `dispatch.ts` |
| Movies sync | `NOTESD_MOVIES` on | Polls the roots, probes, matches against TMDB, reads VLC's recent list. | `src/movies/service.ts` |
| VLC play tracking and health log | Movies on | Follows the VLC notesd started; samples every `vlc.exe` into the health log. | `src/movies/player.ts`, `src/movies/vlc/` |
| Stream canary | `NOTESD_STREAM_CANARY` on (the default), with direct streaming | A few minutes after start and once a day, while nothing plays: every cloud provider asked for one known film out of sight, for its health only. | `src/directStream/canary.ts` |
| Stream cache | Direct streaming on | Downloads the films and episodes asked for, one at a time; carries unfinished ones on after a restart. | `src/directStream/cache/` |
| Trending list | `NOTESD_TRENDING` on | Two minutes after start, then once a day: the torrent indexes' top lists into `stream_trending`. No swarm is joined. | `src/directStream/trending/job.ts` |
| Public tracker lists | Torrents and discovery on | A minute after start, then once a day: the public tracker lists read, up to 20 trackers kept. | `src/directStream/torrent/trackerLists.ts` |
| Stream downloads | `NOTESD_STREAM_DOWNLOADS` on | Carries on the queued, running and paused downloads the owner asked for. | `src/directStream/downloads/service.ts` |
| Egress summary | Meter on | One log line an hour. | `src/db/meter.ts` |

A job never blocks a save or a request: it works from rows already committed.

## Pages

The web app is one Vite and React bundle in `web/dist`. `src/http/static.ts` serves it last, as
the fallback for every `GET` that is not under `/api`, `/mcp` or `/health`, so these addresses are
not in the route table: the app reads the URL itself (`web/src/lib/route.ts`,
`web/src/lib/deepLink.ts`).

| Address | Shows |
| --- | --- |
| `/` | The wall. The recycle bin is a view of the same page. |
| `/?note=A-B32` | The wall scrolled to that note. This is the link form Claude writes for a note id. |
| `/history`, `/history?thread=<id>` | The chat history page, optionally opened on one thread. |
| `/projects?repo=<repo>&node=<node id>&focus=1` | The project session graph on that repo with that node selected. `focus=1` shows the page alone, without rail, sidebar and header. With `node` and no `repo` (how Claude Code links a session) the app looks up the node's repo. |
| `/adversary`, `/adversary/<strategy id>` | Seer Adversarial: the overview, or one method. `?focus=1` works here too. |
| `/movies`, `/movies/<id>`, `/movies/unmatched` | The library, one title (a movie id such as `M-23T4`, or a title key such as `movie-467905`; an episode's id opens its series at that episode), and the files that matched no title. |
| `/full/<imageId>` | The full-screen photo page, a separate small bundle (`web/fullscreen.html`). |
| `/stream/<sessionId>` | The direct-streaming player, a separate small bundle (`web/stream.html`) with hls.js and dash.js built in. A play opens it in the streaming Chrome: see [The player](streaming.md#the-player). |
| `/assets/*` | Hashed build output, cached as immutable. |

Without a build the fallback answers 503 `web UI not built: run npm run build`.

## Repository layout

```
src/
  main.ts, daemon.ts, deps.ts, config.ts, background.ts   start-up and wiring
  db/           Drizzle schema, the client for both drivers, egress meter, quota breaker
  notes/        NotesService, repos, ids, tags, events, the recycle bin
  images/       ingest, derived copies, the inbox watcher        files/   note files
  search/       the blend weights and the query vector
  embeddings/   note and image embedders, workers, backfills
  chat/         the chat agent (Claude Agent SDK, GLM fallback), history, pasted images, capture
  connectors/   expenses, runs, Seer, daily-words: read-only SQL behind a guard
  dword/        the daily-words writer (additions only)
  sessions/     ingest, forks, links, summaries, search, context window, resume, handoff
  adversary/    the Seer Adversarial reviewer and its read model
  movies/       scan, parse, match, TMDB, state, player, vlc/
  directStream/ provider registry, resolves, sessions, the pass-through, the stream cache, torrents, downloads, seek previews, trending
  streaming/    running the streaming sites' command, site plays, the site fallback, the WARP switch
  mcp/          the MCP server, its instructions and every tool
  http/         one router per area, the guards, the static fallback
  cli/          embed:backfill and embed:images:backfill
web/            the Vite + React app (web/src) and the full-screen page
drizzle/        SQL migrations
claude/         skills/ (n, migrate, v, j, redo, check-seer-adversarial-nightly, trace-vlc-bug, pahe, idlix, lk21, flicksy, dramacool, create-streaming-skill, direct-stream, update-cloud-source, report-stream-bug, sync-subtitle, warp), streaming/ (the streaming sites), hooks/, mods/note-links
deploy/         the systemd user unit template
scripts/        install, uninstall, hook settings merge, test-int, windows/ keepalive, docs/ tooling
tests/          unit/, integration/, live/, fixtures/, helpers/
docs/guide/     these guides, reference/ and img/
docs/           ROADMAP.md, plans/, iterations/, design/: intent and history
.claude/skills/verify-notesd/   the throwaway-instance harness and its feature map
.workflows/     task, plan and orchestration records from the planning tooling
```

Server code is ESM with `.js` import suffixes. The web app has its own tsconfig
(`tsconfig.web.json`) and its tests sit next to the code as `*.test.tsx`.

## Limitations

- **Photos and files are local only, by design.** An original lives on the one machine that took
  it in and is never synced. The other machine shows the text with a "not on this machine"
  placeholder.
- **Full size costs disk.** Originals are kept exactly as they arrive, so a phone's 4 MB HEIC
  stays 4 MB, plus a full-resolution JPEG for viewing.
- **Pasted images are kept.** Pictures pasted into the wall chat, and the pasted pictures of a
  Claude Code session once `/n` is used in it, are copied to `chat-images/` and never deleted.
  The same picture is stored once (by sha256). They never appear on the wall unless one is made a
  note.
- **Text needs the network.** Notes live in Neon. With no connection nothing loads, and a spent
  transfer quota pauses the database for 30 minutes at a time.
- **Meaning needs OpenRouter.** A note becomes findable by meaning shortly after it is saved, not
  in the same instant. Without `OPENROUTER_API_KEY`, or while OpenRouter is down, `search` falls
  back to full text and says so, `related` answers only for notes embedded earlier, and
  `similar_images` cannot compare pictures.
- **Connectors are read-only, and daily-words takes only additions.** Nothing in
  expense-tracking, run-insights or Seer can be changed through the connectors. daily-words only
  gains vocabulary and journal entries; fix a wrong entry in daily-words itself. The one writer
  into Seer is the adversary, behind its table allow-list.
- **Delete forever is final.** It removes the rows and the files, with no undo. Everything else
  waits in the recycle bin until restored or deleted forever. Nothing is purged on a timer.
- **Open file location is for Windows.** It needs `notesd` under WSL with interop, and the
  original on this machine. Anywhere else the folder icon is not shown.
- **Photo order is the order they were added.** There is no drag to reorder, no cropping and no
  image editing.
- **Single user, no auth.** It binds to `127.0.0.1` only. Anyone with a shell on the machine can
  read it.
- **Built for WSL.** The installer assumes a systemd user session, and the Windows keepalive task
  may need an elevated PowerShell once.
- **Desktop first.** There is no phone layout. Phone photos come in through the inbox folder or
  an upload.
- **HEIC colour.** The HEIC display copy has no Display-P3 conversion, so wide-gamut photos can
  look a little flat in the browser. The original is untouched.
- **Tag syntax is loose.** Any `#word` of letters, digits, `_` and `-` becomes a tag, `#123`
  included.
- **Edits made by a second daemon on the same Postgres are not instant.** They reach an open wall at the next poll: up
  to 5 minutes, or at once when the tab regains focus after a minute away.
- **The session graph refreshes by polling.** Every 30 s while the page is visible, backing off
  to 2 minutes while nothing changes. Only a session's context has a live stream, and only for
  this machine's sessions.
- **Sessions are as good as the transcripts.** A session Claude Code deleted before the daemon
  read it is not on the graph. Links between old sessions are guesses from what the parent wrote
  (marked `heuristic`); only sessions started after install are linked for certain.
- **Summaries cost Claude usage.** Each idle session gets one Haiku call on the owner's login,
  and the first start summarizes the backlog in the background. `NOTESD_SESSIONS=off` turns
  ingest off.
- **Resume needs tmux on the same machine.** A session from the other laptop shows on the graph
  but cannot be resumed or read here.
- **Movies play where the file is.** Titles, ratings and reviews are shared; files, plays and VLC
  belong to one machine. A film opened from Explorer reaches the history only when VLC exits and
  writes its recent list, which keeps the last 30. Playback needs Windows VLC under WSL.

## Proving a change

`.claude/skills/verify-notesd` starts a throwaway daemon with its own database, port, data dir
and `CLAUDE_HOME`, and drives it over HTTP, MCP and Playwright. Its `features/` map says what
proves each feature; `features/egress.md` covers the meter, the breaker and the 304 answers. For
a structural change, run `npm run typecheck`, `npm test` and `npm run test:int` as well: the
integration suite builds the app with `createApp` against a real Postgres. Commands are in
[install.md](install.md#tests).
