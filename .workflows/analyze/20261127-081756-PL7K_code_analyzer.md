# Code Analysis: stream play log, stream health view, honest session search, reminders

**Type:** Feature Implementation
**Date:** 2026-11-27 08:17 WIB
**Session ID:** 20261127-081756-PL7K
**Plan:** `.workflows/plan/STREAM_PLAY_LOG_PLAN.md` (5 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/stream-play-log`, branch `feature/stream-play-log` (base `origin/main` @ `7b2d61c`)

---

## User Input

### Original User Request

> them . for no 3, make sure we add a hook reminder or something. after one week, you will automatically remind me about this feature

Sent mid-analysis, same turn:

> the thing is, that 100 of 138 plays, it's because mostly i just play it for testing only. not because i really want to spend 2 hours watching . i want to see the capabilities of torrent, mostly. because torrent is the source that provides the best 1080p quality based on my observation

Sent while the phase plans were being written:

> i think we should say, successful short plays ARE "successful streaming attempt". whether it was from torrent (T) or cloud sources (NT) .
> over time, i still want to findout which the movies / series that we can't handle. maybe because there is no torrent / no cloud sources for it

### User-Provided Context

"them" answers the proposal Claude made one message earlier in the same session, which closed with
"Shall I go ahead with the play record (steps 1 and 2), or would you rather spend the quota on
session search?". The proposal, verbatim:

> I'd spend it on one thing: **make each stream play remember how it went.** The player already counts stalls and waits in memory, but the database keeps only a position, so nothing can say why a play ended.
>
> ## What I would build
>
> 1. **A per-play record**, written once when the session ends: time to first frame, stall count and stalled seconds, source switches and their reason, subtitle outcome, and how it ended (closed by you, failed, switched, finished).
> 2. **A small health view** on the Stream side and one MCP tool, so "how did torrents do this week?" is a query instead of a soak.
> 3. **Later, not now:** letting real delivery feed the choice of provider or torrent. That changes ranking rules, so I'd want a week of data first.
>
> ## The runner-up
>
> Session search has been matching on words only since the local database started on 17 Nov, and does not say so. All 1,117 sessions have no summary and no vector, because the daemon waits for the Neon copy and Neon's quota is exceeded. `sessions_search` still answers `mode: hybrid` with no `fallback`; a test query about subtitle drift returned three torrent sessions. It probably heals itself when Neon's quota resets around 1 Dec, so I'd only fix the missing `fallback` flag, which is small.

### User-Provided Files

None.

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | "them" → proposal item 1: "**A per-play record**, written once when the session ends: time to first frame, stall count and stalled seconds, source switches and their reason, subtitle outcome, and how it ended (closed by you, failed, switched, finished)." Narrowed by: "mostly i just play it for testing only ... i want to see the capabilities of torrent, mostly. because torrent is the source that provides the best 1080p quality based on my observation" |
| R2 | "them" → proposal item 2: "**A small health view** on the Stream side and one MCP tool, so "how did torrents do this week?" is a query instead of a soak." Extended by: "successful short plays ARE "successful streaming attempt" ... over time, i still want to findout which the movies / series that we can't handle. maybe because there is no torrent / no cloud sources for it" |
| R3 | "them" → the runner-up: "Session search has been matching on words only ... and does not say so. ... `sessions_search` still answers `mode: hybrid` with no `fallback` ... I'd only fix the missing `fallback` flag, which is small." |
| R4 | "for no 3, make sure we add a hook reminder or something. after one week, you will automatically remind me about this feature" |

Proposal item 3 (real delivery feeding the choice of provider or torrent) is **not** a requirement
of this set: the user asked for a reminder about it, not for it.

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN a play ask that names exactly one title is answered with a player session THE SYSTEM SHALL store one `stream_play_log` row for that session with the ask's time, the title, how the source was named, the channel, the provider, the time from ask to answer and, for a torrent, its info hash, index, listed seeds and height |
| R1.2 | unwanted | IF a play ask that names exactly one title ends without a player session THEN THE SYSTEM SHALL store one `stream_play_log` row with outcome `failed`, the failure's outcome word and its redacted detail |
| R1.3 | event | WHEN the player page's position report carries a `stats` object THE SYSTEM SHALL keep on the session's row the first-frame time and the totals of playing time, stalls, stalled time, torrent waits, waited time and player errors, summed over every page load of that session |
| R1.4 | event | WHEN a session's play is over (the film ended, the page closed, another play took the screen, the session expired, or the daemon starts and finds the row open) THE SYSTEM SHALL close its row with that reason, the provider it ended on, the count of automatic and owner-asked source switches and the English subtitle's source |
| R1.5 | state | WHILE a page is paused and already the stream on screen THE SYSTEM SHALL write nothing to the database for its `beat` reports |
| R1.6 | event | WHEN the player page reports a position THE SYSTEM SHALL include in the report its counters since page load (first-frame time, playing time, stalls, stalled time, torrent waits, waited time, errors) and an id of the page load |
| R2.1 | event | WHEN `GET /api/stream/health?days=N` is asked THE SYSTEM SHALL answer, for this host and the last N days, per channel and per provider or torrent index: asks, failures by outcome word, sessions that showed no picture, median time from ask to answer, median first-frame time, stalls and stalled time per hour played, and the share of plays at 1080p or better |
| R2.2 | event | WHEN the MCP tool `direct_stream_health` is called THE SYSTEM SHALL return the same figures as the route, and the chat bar SHALL be allowed to call it |
| R2.3 | event | WHEN the owner clicks the health icon on the Stream side THE SYSTEM SHALL show a page at `/movies/health` with those figures and the latest plays, each naming its title, source, first-frame time, stalls and how it ended |
| R2.4 | unwanted | IF no play is logged in the period THEN THE SYSTEM SHALL answer zero counts and null medians, and the page SHALL say that nothing was played |
| R2.5 | state | WHILE a film or episode has failed play asks and no successful play after its last failure THE SYSTEM SHALL list it in the health answer, tool and page as a title that could not be played, with what the cloud providers and the torrents each last answered |
| R3.1 | unwanted | IF sessions search runs with an embedder while no session of the store has a vector of that embedder's model THEN THE SYSTEM SHALL answer with `mode: "text"` and a `fallback` that says session vectors are not built yet |
| R3.2 | state | WHILE at least one session has a vector of the embedder's model THE SYSTEM SHALL answer sessions search as it does today (`mode: "hybrid"`, no `fallback`) |
| R4.1 | event | WHEN a Claude Code terminal session starts fresh in a repository that has a reminder due and not done THE SYSTEM SHALL put that reminder's text and id in the session's start context, with the instruction to tell the owner |
| R4.2 | state | WHILE a reminder is not due, is done, or was shown less than 20 hours ago THE SYSTEM SHALL leave it out of every session's start context |
| R4.3 | event | WHEN the daemon first starts with this change THE SYSTEM SHALL store, once, a reminder for repository `mcp-notes` due seven days later that names proposal item 3 (letting the play log feed the choice of provider or torrent) and where to read the data |
| R4.4 | event | WHEN the MCP tool `remind` is called with `add`, `list` or `done` THE SYSTEM SHALL create a reminder with a due time, list the open ones, or mark one done so it is never shown again |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** A stream play leaves two traces today. `movie_plays` keeps a
position per session (`MoviesRepo.recordStreamPosition`, `src/movies/repo.ts:797`). The stream
evidence log (`src/directStream/evidence.ts`) keeps a line per pass-through request, per player
line and per session event in a 5 MB rotating file; `delivery.ts` reads its last three days to
judge a cloud provider. Neither keeps, per play: how long the ask took, how long the first frame
took, how long the film stood still, what height played, or why an ask failed when no session was
made (those failures are only in `notesd.log`, as note Y-A9N records). A torrent's bytes go through
the local file route, not the pass-through, so a torrent play has no request records at all. The
owner tests torrents by hand to see what they can do; each test's measurements are lost.

**Success Criteria.** After a play, one database row says what the play measured. A route, an MCP
tool and a page read those rows per channel, provider and index. Session search says when it has
no session vectors. A reminder appears by itself in a Claude Code session one week after the
daemon first runs the change.

**Key Considerations.**
- The owner's short plays are tests. Watched minutes are not a quality signal and are not a headline figure; start success, first-frame time, stalls and delivered height are.
- "A paused page's `beat` never writes the database" (CLAUDE.md, Single writers) holds for the new row too.
- "`several_matches` and a nameless play are left unrecorded": only an ask whose title is known is logged.
- Secrets: a failure detail goes through `redactQueries`; no magnet `tok`, Wyzie key or signed address is stored.
- The new tables never existed on Neon: they stay out of `SHARED_IMPORT_TABLES`.
- Tests inject everything; no test touches the network or the streaming Chrome.
- Session vectors and summaries deliberately wait for the Neon copy (`src/background.ts:119`, `:145`). R3 does not change that wait; it only reports it.

**Assumptions (inferences, stated).**
- "them" means both things the question offered: the play record with its health view, and the session-search flag.
- "a hook reminder" means the existing SessionStart hook (`claude/hooks/notes-session.mjs`), which already prints `additionalContext` from the daemon's reply. A general reminders store is built rather than a one-off, because the hook needs somewhere to read from and the owner said "or something".
- "after one week" counts from the daemon's first start with the change, which is when the log begins to fill.

---

## Analysis Scope

### Discovered Related Files

- `src/directStream/service.ts` (2575 lines): `play` :660, `playWithin` :669, `playCache` :1324, `switchSource` :1530, `switchEpisode` :1744, `continueSession` :1775, `DirectStreamHooks` :68, `sessions.onEnd` :527, `MAX_AUTO_SWITCHES` :439
- `src/directStream/sessions.ts`: `StreamSession`, `SessionTorrent`, `SessionLock`, `SessionStore.onEnd`
- `src/directStream/evidence.ts`, `delivery.ts`: the evidence log and the provider verdict read from it
- `src/http/directStreamApi.ts`: `positionBody` :287, `streamPositionRoutes` :336 (the `beat` early return :365)
- `src/http/streamEvidenceApi.ts`: `POST /api/stream/sessions/:id/events`
- `src/movies/streams.ts`: `MovieStreams.recordPosition` :400, `closeOpenStreamPlays` :520
- `src/movies/repo.ts`: `recordStreamPosition` :797
- `web/src/stream/controller.ts` (1631 lines): stall timer :891-922, torrent wait note :1334, `report` :1464, `STALL_MIN_MS` :51
- `web/src/stream/session.ts`: the page's fetch helpers (`postEvents`, the position post)
- `src/db/schema.ts`: `moviePlays` :1288; `drizzle/` ends at `0043_stream_downloads_stories.sql`
- `src/db/sharedImport.ts`: `SHARED_IMPORT_TABLES` :58
- `src/sessions/search.ts`: `searchSessions` :794, `textSearch` :758, fallback texts :29-36
- `src/mcp/sessionTools.ts` :59-89, `src/http/sessionsApi.ts` :208
- `src/background.ts` :119 and :145 (the import wait)
- `claude/hooks/notes-session.mjs`: `buildContext` :181, output :254; `src/http/sessionHooks.ts`: reply shape :93, start handler :149
- `src/mcp/directStreamTools.ts`, `src/mcp/streamDiskTool.ts` (the pattern of a small stream tool), `src/chat/status.ts` (`allowedChatTools`)
- `web/src/components/movies/CachePage.tsx` and `.css` (the pattern of a Stream-side page), `MoviesGrid.tsx` (the drive icon that opens it), `web/src/lib/route.ts`
- `scripts/docs/httpRoutes.ts`, `docs/guide/streaming.md`, `docs/guide/movies.md`, `docs/guide/sessions.md`, `docs/guide/claude-code.md`, `.claude/skills/verify-notesd/features/*.md`

---

## Current Dataflow

### Entry Point: a play ask

**Location:** `src/directStream/service.ts:660` (`play`), `:669` (`playWithin`)
**Trigger:** `POST /api/stream/play` (`src/http/directStreamApi.ts:103`), the MCP tool `direct_stream_play`, the play menu, `site-play`.
**Input:** a `StreamRefInput`, `{ resumeS, provider, magnet }`.
**Output:** a `PlayAnswer`: a `PlayResult` (a session) or a `SitePlayResult` (a streaming site took it); a failure is thrown or carried as an outcome word (`RESOLVE_OUTCOMES`, `src/directStream/types.ts:73`). `playWithin` keeps a pending play's outcome for the next ask (`PLAY_OUTCOME_KEEP_MS`).

Other ways a session is made: `playCache` :1324 (the Cache page), `continueSession` :1775 (a page whose session the daemon no longer holds), `switchEpisode` :1744 (the player's previous and next buttons).

### Processing Chain

1. **Session made.** `SessionStore.create` / `createTorrent` (`src/directStream/sessions.ts:177`, `:223`). The session holds `source.provider`, `source.best_height`, `lock`, `autoSwitches`, `refreshes`, `avoid`, `pastedTorrent`, and for a torrent `infoHash`, `index`, `seeds`, `height`, `filmKbps`, `subtitles`. A `session` evidence line (`created`) is written.
2. **Page loads.** `web/src/stream/controller.ts` reads the session, starts the engine, and posts log lines to `POST /api/stream/sessions/:id/events`, which appends `player` records to the evidence log. Stall detection: a wait longer than `STALL_MIN_MS` (1.5 s) while the film should play writes `stalled at N s` and is counted again every `STALL_REPEAT_MS` (10 s); a torrent's wait for a missing part writes `waiting for the torrent at N s` (:1334). The page knows when a stall begins and when the film moves again, but posts no duration: the log holds 430 `stalled` lines against 10 `recovered`.
3. **Position reports.** Every `POSITION_INTERVAL_MS` (5 s) the page posts `{ position_s, duration_s, ended?, paused?, beat?, closed? }` to `POST /api/stream/sessions/:id/position`. Unknown keys are dropped by `positionBody` (zod object, :287). The route calls `service.letGo`, `watched`, `reported`, then, unless it is a paused page's beat for the stream on screen (early return :365), `MovieStreams.recordPosition`, which upserts the session's open `movie_plays` row and, on the first report, records the title's channel.
4. **End.** A report with `ended` or `closed` closes the `movie_plays` row. A session dropped by the store (idle 4 h, older than 24 h, more than 32 live) calls the `onEnd` listeners (one today: `letGoTorrent`). At daemon start `closeOpenStreamPlays` closes rows the last process left open.

### Data Persistence

**Database:** `movie_plays` (one open row per session; position only). `movie_title_channels`, `movie_title_methods`, `movie_stream_sources`, `stream_provider_health` (resolve outcomes, not delivery).
**File:** `<dataDir>/movies/stream-evidence-<host>.jsonl`, 5 MB, one rotation. On 2026-11-26 it held 7,981 request, 1,345 player and 661 session records from 16 Nov on: 644 sessions created (398 cloud, 246 torrent) against about 306 `movie_plays` stream rows, so about half the sessions never reported a position.

### Entry Point: sessions search

**Location:** `src/sessions/search.ts:794` (`searchSessions`), called by `GET /api/sessions/search` (`src/http/sessionsApi.ts:208`) and the MCP tool `sessions_search` (`src/mcp/sessionTools.ts:59`).
**Chain:** no embedder → `textSearch` with `SESSIONS_SEMANTIC_OFF_FALLBACK`; the query cannot be embedded → `textSearch` with `sessionEmbedFailedFallback`; otherwise candidates from `HYBRID_SOURCES` (:535), and the page is `mode: 'hybrid'` with no `fallback`, whether or not `cc_session_embeddings` holds any vector.
**State on 2026-11-27:** `cc_sessions` 1,117 rows, `summary` null on all; `cc_session_embeddings` 0 rows; `cc_session_reply_embeddings` 0 rows. `src/background.ts:119` and `:145` start neither the reply-vector worker nor the summary worker while `deps.importPending` is true, and the import waits on Neon's quota ("shared import: the old database cannot be read yet", hourly in the journal).

### Entry Point: the SessionStart hook

**Location:** `claude/hooks/notes-session.mjs`. A `cli` session posts `{session, parent, cwd, name, tmux, host, started_at, source, transcript_path}` to `POST /api/sessions/hook/start` (`src/http/sessionHooks.ts:149`) within 3 s and prints `{hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}}` built by `buildContext` (:181) from the reply's `node_id` and `parent_node_id`. Daemon down or no node id: no output. `FRESH_SOURCES` are `startup` and `clear`.
No reminder store exists. `app_settings` (key, jsonb value) is written only by `src/sessions/repo.ts`.

---

## Key Data Structures

### `StreamSession` — `src/directStream/sessions.ts:81`
Fields used by the log: `id`, `ref`, `source.provider`, `source.best_height`, `source.subtitles`, `cache`, `torrent`, `outside.subtitles`, `refreshes`, `avoid`, `lock`, `autoSwitches`, `sourceNote`, `pastedTorrent`, `createdAt`.

### `SessionTorrent` — `src/directStream/sessions.ts:21`
`infoHash`, `name`, `index`, `seeds`, `height`, `filmKbps`, `manifestKind`, `subtitles`, `state`.

### `positionBody` — `src/http/directStreamApi.ts:287`
`position_s`, `duration_s?`, `ended?`, `paused?`, `beat?`, `closed?`.

### `SessionSearchPage` — `src/sessions/search.ts` (:119 `fallback?: string`)
`sessions`, `next_cursor`, `mode: 'hybrid' | 'text'`, `fallback?`.

---

## Dependencies

### Configuration / Environment / External Services
- No new environment variable is needed by any of the four requirements.
- `drizzle/` migrations are numbered in sequence (`0043` is the last); two phases that each add a table must not generate migrations at the same time.
- `npm run docs:gen` after a new MCP tool or HTTP route (a route also needs a row in `scripts/docs/httpRoutes.ts`); `tests/unit/docs/reference.test.ts` fails on drift.
- The movies guide shows real-library pictures (`docs:shots -- --live movies`), which need the live daemon to run the new code.

---

## Impact Points (files that WILL need changes)

1. `src/db/schema.ts`, `drizzle/0044_*` — `stream_play_log` (phase 1)
2. `src/directStream/playLog/*` (new: repo, tally, types) — phase 1
3. `src/directStream/service.ts`, `src/daemon.ts`, `src/deps.ts` — hooking the log to asks, session ends and daemon start (phase 1)
4. `src/http/directStreamApi.ts` — `positionBody.stats`, feeding the log (phase 1)
5. `web/src/stream/controller.ts`, `web/src/stream/session.ts` and their tests — the page's counters (phase 2)
6. `src/http/streamHealthApi.ts` (new), `src/http/app.ts`, `scripts/docs/httpRoutes.ts` — the route (phase 3)
7. `src/mcp/streamHealthTool.ts` (new), `src/mcp/server.ts`, `src/chat/status.ts`, `src/mcp/instructions.ts` — the tool (phase 3)
8. `web/src/components/movies/HealthPage.tsx` and `.css` (new), `MoviesGrid.tsx`, `web/src/lib/route.ts`, `web/src/App.tsx` — the page (phase 3)
9. `src/sessions/search.ts`, `src/mcp/sessionTools.ts`, their tests — the fallback (phase 4)
10. `src/db/schema.ts`, `drizzle/0045_*`, `src/reminders/*` (new), `src/http/sessionHooks.ts`, `claude/hooks/notes-session.mjs`, `src/mcp/remindTool.ts` (new), `src/daemon.ts` — reminders (phase 5)
11. `CLAUDE.md` (single writers), `docs/guide/streaming.md`, `docs/guide/movies.md`, `docs/guide/sessions.md`, `docs/guide/claude-code.md`, generated references, `.claude/skills/verify-notesd/features/*` — with the phase that changes the behaviour

**This document describes. The plan files prescribe.**
