# Plan: stream play log, stream health view, honest session search, reminders

**Slug:** stream-play-log
**Date:** 2026-11-27 08:17 WIB
**Analysis:** `.workflows/analyze/20261127-081756-PL7K_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/stream-play-log`
**Branch:** `feature/stream-play-log` (base: `origin/main` @ `7b2d61c`)
**Phases:** 5
**Status:** planned
**Coordinator:** —

---

## Why

The user's words:

> them . for no 3, make sure we add a hook reminder or something. after one week, you will automatically remind me about this feature

> the thing is, that 100 of 138 plays, it's because mostly i just play it for testing only. not because i really want to spend 2 hours watching . i want to see the capabilities of torrent, mostly. because torrent is the source that provides the best 1080p quality based on my observation

> i think we should say, successful short plays ARE "successful streaming attempt". whether it was from torrent (T) or cloud sources (NT) .
> over time, i still want to findout which the movies / series that we can't handle. maybe because there is no torrent / no cloud sources for it

"them" answers this proposal (Claude, one message earlier):

> 1. **A per-play record**, written once when the session ends: time to first frame, stall count and stalled seconds, source switches and their reason, subtitle outcome, and how it ended (closed by you, failed, switched, finished).
> 2. **A small health view** on the Stream side and one MCP tool, so "how did torrents do this week?" is a query instead of a soak.
> 3. **Later, not now:** letting real delivery feed the choice of provider or torrent. That changes ranking rules, so I'd want a week of data first.
>
> The runner-up: Session search has been matching on words only since the local database started on 17 Nov, and does not say so. [...] `sessions_search` still answers `mode: hybrid` with no `fallback` [...] I'd only fix the missing `fallback` flag, which is small.

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | "them" → proposal item 1: "**A per-play record**, written once when the session ends: time to first frame, stall count and stalled seconds, source switches and their reason, subtitle outcome, and how it ended (closed by you, failed, switched, finished)." Narrowed by: "mostly i just play it for testing only ... i want to see the capabilities of torrent, mostly. because torrent is the source that provides the best 1080p quality based on my observation" | 1, 2 |
| R2 | "them" → proposal item 2: "**A small health view** on the Stream side and one MCP tool, so "how did torrents do this week?" is a query instead of a soak." Extended by: "successful short plays ARE "successful streaming attempt" ... over time, i still want to findout which the movies / series that we can't handle. maybe because there is no torrent / no cloud sources for it" | 3 |
| R3 | "them" → the runner-up: "Session search has been matching on words only ... and does not say so. ... `sessions_search` still answers `mode: hybrid` with no `fallback` ... I'd only fix the missing `fallback` flag, which is small." | 4 |
| R4 | "for no 3, make sure we add a hook reminder or something. after one week, you will automatically remind me about this feature" | 5 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN a play ask that names exactly one title is answered with a player session THE SYSTEM SHALL store one `stream_play_log` row for that session with the ask's time, the title, how the source was named, the channel, the provider, the time from ask to answer and, for a torrent, its info hash, index, listed seeds and height | 1 | P1.J1, P1.J2 |
| R1.2 | unwanted | IF a play ask that names exactly one title ends without a player session THEN THE SYSTEM SHALL store one `stream_play_log` row with outcome `failed`, the failure's outcome word and its redacted detail | 1 | P1.J3 |
| R1.3 | event | WHEN the player page's position report carries a `stats` object THE SYSTEM SHALL keep on the session's row the first-frame time and the totals of playing time, stalls, stalled time, torrent waits, waited time and player errors, summed over every page load of that session | 1 | P1.J4 |
| R1.4 | event | WHEN a session's play is over (the film ended, the page closed, another play took the screen, the session expired, or the daemon starts and finds the row open) THE SYSTEM SHALL close its row with that reason, the provider it ended on, the count of automatic and owner-asked source switches and the English subtitle's source | 1 | P1.J4, P1.J6, P1.J7 |
| R1.5 | state | WHILE a page is paused and already the stream on screen THE SYSTEM SHALL write nothing to the database for its `beat` reports | 1 | P1.J5 |
| R1.6 | event | WHEN the player page reports a position THE SYSTEM SHALL include in the report its counters since page load (first-frame time, playing time, stalls, stalled time, torrent waits, waited time, errors) and an id of the page load | 2 | P2.J1, P2.J2 |
| R2.1 | event | WHEN `GET /api/stream/health?days=N` is asked THE SYSTEM SHALL answer, for this host and the last N days, per channel and per provider or torrent index: asks, failures by outcome word, sessions that showed no picture, median time from ask to answer, median first-frame time, stalls and stalled time per hour played, and the share of plays at 1080p or better | 3 | P3.J2 |
| R2.2 | event | WHEN the MCP tool `direct_stream_health` is called THE SYSTEM SHALL return the same figures as the route, and the chat bar SHALL be allowed to call it | 3 | P3.J3 |
| R2.3 | event | WHEN the owner clicks the health icon on the Stream side THE SYSTEM SHALL show a page at `/movies/health` with those figures and the latest plays, each naming its title, source, first-frame time, stalls and how it ended | 3 | P3.J4 |
| R2.4 | unwanted | IF no play is logged in the period THEN THE SYSTEM SHALL answer zero counts and null medians, and the page SHALL say that nothing was played | 3 | P3.J1 |
| R2.5 | state | WHILE a film or episode has failed play asks and no successful play after its last failure THE SYSTEM SHALL list it in the health answer, tool and page as a title that could not be played, with what the cloud providers and the torrents each last answered | 3 | P3.J5 |
| R3.1 | unwanted | IF sessions search runs with an embedder while no session of the store has a vector of that embedder's model THEN THE SYSTEM SHALL answer with `mode: "text"` and a `fallback` that says session vectors are not built yet | 4 | P4.J1, P4.J2 |
| R3.2 | state | WHILE at least one session has a vector of the embedder's model THE SYSTEM SHALL answer sessions search as it does today (`mode: "hybrid"`, no `fallback`) | 4 | P4.J3, P4.J4 |
| R4.1 | event | WHEN a Claude Code terminal session starts fresh in a repository that has a reminder due and not done THE SYSTEM SHALL put that reminder's text and id in the session's start context, with the instruction to tell the owner | 5 | P5.J3 |
| R4.2 | state | WHILE a reminder is not due, is done, or was shown less than 20 hours ago THE SYSTEM SHALL leave it out of every session's start context | 5 | P5.J4 |
| R4.3 | event | WHEN the daemon first starts with this change THE SYSTEM SHALL store, once, a reminder for repository `mcp-notes` due seven days later that names proposal item 3 (letting the play log feed the choice of provider or torrent) and where to read the data | 5 | P5.J1 |
| R4.4 | event | WHEN the MCP tool `remind` is called with `add`, `list` or `done` THE SYSTEM SHALL create a reminder with a due time, list the open ones, or mark one done so it is never shown again | 5 | P5.J2 |

## Scope

**In scope:** a `stream_play_log` table with its single writer; the player page's counters in its position report; a health route, MCP tool and page; a `fallback` on sessions search when no session vector exists; a `reminders` table, the `remind` MCP tool, the SessionStart hook showing due reminders, and one seeded reminder.

**Out of scope:**
- Proposal item 3: real delivery feeding the choice of provider or torrent. No ranking, finder, shuffle or auto-switch rule changes in this set. The reminder exists so this is decided with a week of data.
- Backfilling the log from the evidence file. The file has no stall durations and no first-frame times.
- Starting session summaries or vectors before the Neon copy (`src/background.ts:119`, `:145` stay as they are).
- Reminders on the wall. They are shown by the hook and listed by the tool only.
- Retaking the movies guide's live pictures (`stream.png` gains one icon; a `health.png`). They need the live daemon on the new code and a page with data: the seeded reminder's text asks for it.

## Contracts (every phase plans against these; do not rename)

### Table `stream_play_log` (phase 1 owns the schema and migration `0044`)

One row per play ask on this host whose title is known. Writer: `PlayLogRepo` only (`src/directStream/playLog/repo.ts`). Never in `SHARED_IMPORT_TABLES`.

| Column | Type | Meaning |
|---|---|---|
| `id` | bigserial pk | |
| `host` | text not null | this machine |
| `asked_at` | timestamptz not null | when the ask began |
| `via` | text not null | `play`, `cache`, `continue`, `episode` (which service entry made it) |
| `kind`, `tmdb_id`, `season`, `episode` | text, int, int null, int null | the title; a film has null season and episode |
| `asked` | text null | how the source was named: `provider`, `cloud`, `torrent`, or null (none named) |
| `outcome` | text not null | `failed` (no session), `no_picture` (a session, never a position report), `played` (at least one position report), `site` (a streaming site took it) |
| `failure`, `failure_detail` | text null | the outcome word (`no_source`, `bot_check`, ...) and its detail through `redactQueries`, at most 500 characters |
| `cloud_failure`, `torrent_failure` | text null | on a `failed` row: the outcome word each channel ended with (`no_source`, `no_stream`, `bot_check`, `dubbed`, ...); null: that channel was not asked |
| `resolve_ms` | int null | ask → answer |
| `session` | text null, unique where not null | the stream session id |
| `channel` | text null | `cloud`, `torrent`, `cache` (a session row), `site` (exactly the `site` rows); always null on a `failed` row (CHECK) |
| `provider_first`, `provider_last` | text null | provider at the start and at the end |
| `info_hash`, `torrent_index`, `seeds`, `film_kbps` | text, text, int, int, all null | a torrent's |
| `height` | int null | the height that played (`torrent.height`, else `source.best_height`) |
| `first_frame_ms` | int null | page load → first frame, from the first page load that reported one |
| `played_ms`, `stalls`, `stalled_ms`, `waits`, `waited_ms`, `errors` | int not null default 0 | totals over every page load |
| `auto_switches`, `owner_switches`, `refreshes` | int not null default 0 | |
| `switch_note` | text null | why the daemon last moved the play (`session.sourceNote`) |
| `subtitle_source` | text null | the English subtitle's source at the end; null when none |
| `ended` | text null | `finished`, `closed`, `replaced`, `expired`, `restart`; null while open |
| `ended_at`, `updated_at` | timestamptz | `ended_at` is set exactly when `ended` is (CHECK) |

The words phase 1 writes: `failure` is a `DirectStreamErrorCode` (`no_source`, `resolve_failed`, `open_failed`, `unknown_session`, `no_episode`, `no_subtitle`, `torrent_off`, `bad_info_hash`), a `CachePlayErrorCode` (`not_on_this_machine`, `cache_failed`, `cache_language`) or `error`; `cloud_failure`/`torrent_failure` are a `ResolveOutcome` (`resolved`, `no_stream`, `bot_check`, `error`, `dubbed`, `unplayable`, `skipped`, `skipped_browser_only`, `skipped_no_template`) or `no_source`, `resolve_failed`, `torrent_off`. The health page words every one.

### Position report (`POST /api/stream/sessions/:id/position`), added optional key

```json
"stats": { "load": "<random id of this page load, 8-32 chars [A-Za-z0-9_-]>",
           "first_frame_ms": 1234, "played_ms": 60000,
           "stalls": 2, "stalled_ms": 4100, "waits": 1, "waited_ms": 9000, "errors": 0 }
```

All numbers are since this page load; `first_frame_ms` is null until the first frame. Phase 2 sends it; phase 1 parses it (optional, so an old page still reports) and sums across `load` ids in memory. A stall here is the page's own stall (`STALL_MIN_MS`); `stalled_ms` runs from the moment the film stood still until it moves again. A torrent wait (`waiting for the torrent`) is counted in `waits`/`waited_ms` and not as a stall.

### Health answer (`GET /api/stream/health?days=N`, default 7, 1-90), phase 3

```json
{ "host": "pc", "days": 7, "since": "<iso>", "first_logged_at": "<iso|null>",
  "totals": { "<channel>": Figures }, "by_source": [ { "channel": "torrent", "source": "Torrentio", ...Figures } ],
  "failures": [ { "channel": "torrent", "failure": "no_stream", "count": 3 } ],
  "recent": [ { "id", "asked_at", "title", "movie_id", "season", "episode", "channel", "source", "outcome", "failure", "height", "resolve_ms", "first_frame_ms", "stalls", "stalled_ms", "waits", "waited_ms", "ended" } ] }
```

A row with outcome `played` is a successful streaming attempt whatever its length (the owner's words: "successful short plays ARE successful streaming attempt", torrent or cloud). No figure counts a short play as a failure.

The answer also carries `"unhandled": [ { "title", "movie_id", "kind", "tmdb_id", "season", "episode", "asks", "last_asked_at", "cloud_failure", "torrent_failure" } ]`: every film or episode, over all time on this host (not only the last N days; newest first, at most 200), that has `failed` rows and no `played` or `site` row after its last failure. `cloud_failure` and `torrent_failure` are the words of its latest failed row that asked that channel (null: never asked there).

`Figures` = `{ asks, failed, no_picture, played, success_rate, median_resolve_ms, median_first_frame_ms, played_hours, stalls_per_hour, stalled_share, hd_share }`:
- `played` counts outcome `played` **and** `site` (a streaming site's player ran): every play that reached the screen, however short.
- `success_rate` = `played / asks` (3 places), null with no ask: the headline figure per channel and per source.
- `median_resolve_ms` over the asks that got a player (`no_picture`, `played`, `site`); `median_first_frame_ms` over the played rows that reported one.
- `stalls_per_hour` = stalls / (`played_ms` / 3.6e6) and `stalled_share` = `stalled_ms / played_ms`, both null when nothing played; `played_hours` is 0 then.
- `hd_share` is the share of played rows **whose height is known** with `height >= 1080`, null when none is known.

`totals` always carries `all`, `cloud` and `torrent` (zeros and nulls when empty), plus `cache`, `site` or `none` when a row has them. A `failed` row (its `channel` is always null) counts once under `all` and under each channel it asked (`cloud_failure` / `torrent_failure` set), else under the channel `asked` names, else `none`; it is in no `by_source` entry, and `failures` counts it per channel with that channel's own word. `source` is a cloud or cache play's `provider_first` and a torrent play's `torrent_index` (`disk` when null). The MCP tool answers the route's object plus `link` (`<wall>/movies/health`) and `next` (what to say first). Phase 3 adds the read functions it needs to `PlayLogRepo` (reads only; phase 1 owns every write).

### Table `reminders` (phase 5 owns the schema and migration `0045`)

`id` bigserial, `seed_key` text null unique, `body` text not null, `repo` text null (null: every repository), `due_at` timestamptz not null, `created_at`, `done_at` null, `last_shown_at` null. Writer: `RemindersRepo` only (`src/reminders/repo.ts`). Never in `SHARED_IMPORT_TABLES`. Ids are shown as the number (`#12`).

## Invariants

1. The tree typechecks and `npm test` passes at the end of every phase; `npm run docs:check` passes whenever a tool, route or guide changed.
2. A play is never failed, delayed or changed by the log: every log write is caught, logged in one line and dropped.
3. A paused page's `beat` writes nothing to the database.
4. Nothing new is logged, thrown or stored that grants access: details go through `redactQueries`; no magnet link, `tok`, key or header value.
5. Single writers: `PlayLogRepo` for `stream_play_log`, `RemindersRepo` for `reminders`, `MoviesRepo` still for every `movie_*` table.
6. No ranking, finder, shuffle or auto-switch behaviour changes.
7. No test touches the network, the real `~/.claude` or the streaming Chrome; every clock and repo is injected. The new tables stay out of `SHARED_IMPORT_TABLES`.
8. `notes-prompt` stays I/O-free when no node id matches; `notes-session` still prints nothing when the daemon is down.
9. UI: icon-only buttons, Phosphor icons, the look of the Cache page; never a default-styled table.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Play log: table, writer, daemon wiring | R1 | `src/directStream`, `src/db`, `src/http` | ~27 | — | HARD | `.workflows/plan/stream-play-log/phase-1.md` | — | — |
| 2 | Player page counters | R1 | `web/src/stream` | ~7 | — | NORMAL | `.workflows/plan/stream-play-log/phase-2.md` | P1-NOTES-PL02 | — |
| 3 | Stream health: route, MCP tool, page | R2 | `src/directStream/playLog`, `src/http`, `src/mcp`, `web/src/components/movies`, `web/src/pages` | ~30 | 1 | NORMAL | `.workflows/plan/stream-play-log/phase-3.md` | — | — |
| 4 | Sessions search says when it has no vectors | R3 | `src/sessions` | ~4 | — | EASY | `.workflows/plan/stream-play-log/phase-4.md` | — | — |
| 5 | Reminders: table, tool, hook, the one-week seed | R4 | `src/reminders`, `claude/hooks`, `src/mcp`, `src/http` | ~26 | 1 | NORMAL | `.workflows/plan/stream-play-log/phase-5.md` | — | — |

### Phase 1 — Play log: table, writer, daemon wiring
**Satisfies:** R1 (R1.1-R1.5)
**Owns:** `stream_play_log` in `src/db/schema.ts` and migration `0044`; `src/directStream/playLog/*` (repo, the in-memory tally per session, types); the calls from `DirectStreamService` (asks, sessions made by play/cache/continue/episode, source switches, session end), from the position route (`positionBody.stats`, the tally, the first report turning `no_picture` into `played`, `ended`/`closed`), from daemon start (rows left open → `restart`); `AppDeps` wiring; CLAUDE.md's single-writers line; `docs/guide/streaming.md` ("The play log", including what the page counts); `docs/guide/architecture.md` (the `stream_play_log` writer row and data-model entry); the verify feature map (`direct-streaming.md` section before Gotchas, the README's Direct streaming row) and `playlog.sh`; `tests/integration/setup.ts` `truncateAll`; unit and integration tests.
**Does not touch:** `web/`; any read for the health view beyond what its own tests need; `reminders`; `src/sessions`.
**Exit criteria:** an ask through the service with fakes writes the rows the criteria name; a position report with `stats` updates the row; typecheck, `npm test`, `npm run test:int`, `docs:check` green; `playlog.sh RUN` on a fresh `verify.sh up --direct-stream` run ends `playlog: PASS (ask stats failed beat replaced restart)`.

### Phase 2 — Player page counters
**Satisfies:** R1 (R1.6)
**Owns:** `web/src/stream/controller.ts`, `web/src/stream/session.ts`, the new `web/src/stream/playStats.ts` and their tests: the counters and the `stats` key of the position report, exactly as the contract above (a 16-character `load`, a new one when the page moves to another session); `play-stats.steps.mjs`; one bullet in `features/direct-streaming.md` (:55).
**Does not touch:** `src/`; the stall-to-switch rules (`STALLS_TO_SWITCH`, windows, cooldowns); the 2 px rule; any line the page writes to the evidence log; `docs/guide/streaming.md` (phase 1 describes the counters).
**Exit criteria:** controller tests show the counters for a stall that recovers, a torrent wait, a pause (not counted), a seek within the grace (not counted), and a report body carrying `stats`; the real page build's posted bodies carry `stats` (`play-stats.steps.mjs`).

### Phase 3 — Stream health: route, MCP tool, page
**Satisfies:** R2
**Owns:** read functions on `PlayLogRepo` (`healthRows`, `firstAskedAt`, `unhandled`) and the pure builder `src/directStream/playLog/health.ts`; `GET /api/stream/health` (`src/http/streamHealthApi.ts`, mounted in `app.ts`); the MCP tool `direct_stream_health` (`src/mcp/streamHealthTool.ts`, its register lines in `server.ts`), its chat allow-list entry and caption (`src/chat/status.ts`, the `chat-status` length `+ 1`) and the one sentence in `instructions.ts` and `chat/prompt.ts`; the `/movies/health` page (`HealthPage.tsx`/`.css`, `route.ts`, `lib/movies.ts`, `moviesApi.ts`) and its heartbeat icon beside the Cache drive icon, built in `web/src/pages/MoviesPage.tsx` and passed through `MoviesGrid`'s existing `afterKinds` prop (`MoviesGrid.tsx` and `App.tsx` are unchanged); the `Stream health` group in `scripts/docs/httpRoutes.ts`, generated references, `docs/guide/movies.md` and `streaming.md` ("Stream health"); `features/movies.md` and the README's Movies row.
**Does not touch:** any write to `stream_play_log`; the player page; ranking; `MoviesGrid.tsx`, `App.tsx`; phase 1's wiring (`AppDeps.playLog`, `daemon.ts`).
**Exit criteria:** the route, the tool and the page show seeded rows in a throwaway daemon (J1-J5); empty period handled; all gates green.

### Phase 4 — Sessions search says when it has no vectors
**Satisfies:** R3
**Owns:** `src/sessions/search.ts` (`SESSIONS_NO_VECTORS_FALLBACK`, `hasSessionVectors`, the early return), `tests/integration/sessions.search.int.test.ts`, `docs/guide/sessions.md`, `features/projects.md`. `src/mcp/sessionTools.ts` is unchanged (its description already covers a fallback), so no `docs:gen`.
**Does not touch:** `src/background.ts` (the import wait stays); notes search; the blend weights.
**Exit criteria:** R3.1 and R3.2 shown by integration tests against Postgres with the fake embedder.

### Phase 5 — Reminders: table, tool, hook, the one-week seed
**Satisfies:** R4
**Owns:** `reminders` in `src/db/schema.ts` and migration `0045` (generated after phase 1's `0044` is on the branch); `src/reminders/*` (repo, seeds); the start-hook reply's `reminders` array (`src/http/sessionHooks.ts`) and `claude/hooks/notes-session.mjs` printing them; the MCP tool `remind` (its register lines in `server.ts`; not on the chat allow-list); the seed at daemon start (`src/daemon.ts`: `now` option and one block after the import merge); the start-route text in `scripts/docs/httpRoutes.ts`; docs (`docs/guide/claude-code.md`, `architecture.md` rows after `adversary_reviews` and before `Settings`, one `CLAUDE.md` bullet), generated references, feature map (`reminders.md`, a README row); `truncateAll` (`reminders, ` at its head); tests.
**Does not touch:** the play log's code; the other five hooks; the wall; `src/chat/status.ts` and the `chat-status` test.
**Exit criteria:** R4.1-R4.4 shown with an injected clock; a fresh database's seed is not due, so no existing hook test changes its expected output.

### Shared files and merge order

Phases 1, 2 and 4 run first and independently; 3 and 5 run concurrently once 1 has landed.

| File | Phases, in order | Who owns what |
|---|---|---|
| `src/db/schema.ts`, `drizzle/meta/_journal.json`, snapshots | 1 → 5 | 1: `streamPlayLog` after `streamDownloads`, row types at the file's end, `0044`. 5: `reminders` after `NewStreamPlayLogRow` (the last line), `0045` generated only after `0044` is on the branch |
| `tests/integration/setup.ts` `truncateAll` | 1 → 5 | 1: `stream_play_log, ` at the head; 5: `reminders, ` in front of it |
| `src/daemon.ts` | 1 → 5 | 1: imports after `report.js`, the play-log block after `movieStreams`, `playLog,` in wiring and `deps`. 5: imports after `sessions/events.js`, `now` option, seed block after the import merge |
| `CLAUDE.md` | 1 → 5 | 1: the streaming Single writers line; 5: one bullet after the Claude Code integration bullet |
| `docs/guide/architecture.md` | 1 → 5 | 1: `stream_play_log` writer row after `stream_trending`, the Direct streaming data-model row; 5: `reminders` rows after `adversary_reviews` and before `Settings` |
| `src/directStream/playLog/repo.ts` | 1 → 3 | 1: the file and every write; 3: `sql` in the drizzle import, three reads after `bySession`, helpers at the end |
| `docs/guide/streaming.md` | 1 → 3 | 1: "### The play log" before "### Direct streaming answers"; 3: "### Stream health" before "### Reporting a stream bug" |
| `.claude/skills/verify-notesd/features/direct-streaming.md` | 1 ∥ 2 | 2: one bullet at :55; 1: a section before `## Gotchas` |
| `.claude/skills/verify-notesd/features/README.md` | 1 → 3 ∥ 5 | 1: Direct streaming row; 3: Movies row; 5: a new row after Projects |
| `src/mcp/server.ts` | 3 ∥ 5 | 3: import and register after `registerStreamDiskTool`; 5: import and register after `registerSubtitleCheckTools`. Keep both on a conflict |
| `scripts/docs/httpRoutes.ts` | 3 ∥ 5 | 3: the `Stream health` group after `Cache page`; 5: the `POST /api/sessions/hook/start` value |
| `docs/guide/reference/mcp-tools.md`, `http-api.md` | 3 ∥ 5 | generated: never merged by hand; the later of 3 and 5, and the integrator, rerun `npm run docs:gen` |
| `tests/unit/chat-status.test.ts`, `src/chat/status.ts` | 3 only | 5 keeps `remind` off the chat list |

## Reconciliation Log

| # | Conflict | Kind | Resolution |
|---|---|---|---|
| 1 | Phase 3 extended the Health answer (`success_rate`, `played` counting `played` and `site`, `hd_share` over known heights, `stalled_share` = stalled/played, `totals` always `all`/`cloud`/`torrent`, the failed-row channel rule, the tool's `link`/`next`); the index contract lacked them | Contract drift | Accepted; copied into the index's "Health answer" (`Figures` and the paragraph after it) |
| 2 | Phase 3's "Assumes from phase 1" were guesses (`sql` already imported, `channel` "may be" null on a failed row, `truncateAll` "or not", `iso` might collide) | Unmet assumption | Checked against phase 1's plan and rewritten as facts: the exact drizzle import line phase 3 edits, `channel` always null on a failed row (CHECK), `truncateAll` empties the table (phase 3's redundant truncate removed), no name collision, `host` = `movies.host` |
| 3 | Phase 3's seeds (integration test and Proof SQL) set `ended` without `ended_at`, which phase 1's `stream_play_log_ended_check` refuses | Broken-build phase (test:int and Proof would fail) | Phase 3's seeds now set `ended_at` on every ended row; the plan notes every seed satisfies phase 1's CHECKs |
| 4 | Phase 3's `failureText` worded 8 words (two, `no_peers*`, phase 1 never writes) and missed `resolved`, `error`, `skipped*`, `unknown_session`, `no_episode`, `no_subtitle`, `bad_info_hash`, `not_on_this_machine`, `cache_failed`, `cache_language` | Gap | `failureText` words every `failure` and channel word phase 1 can write (`no_peers*` dropped); its test loops over the full list. Phase 1's handoff and the index's table contract list the words |
| 5 | Phase 2's posted `stats` vs phase 1's `pageStatsBody`/`StatsTally` | (checked) | Compatible: 16-char `load` fits `^[A-Za-z0-9_-]{8,32}$`; integers (phase 1 also rounds); `first_frame_ms` nullish; `stats` on beat/closed/ended is kept in memory; per-load per-field max, summed over loads; a new load per session change. Both plans' handoffs now state it |
| 6 | Phase 2 asked phase 1's guide to describe what the page counts; phase 1's guide paragraph did not | Gap | Phase 1's "The play log" paragraph now carries the definitions (one stall per confirmed freeze, timed to moving; torrent wait not a stall; pause/seek grace/first load excluded; `performance.now()`; new load per session) |
| 7 | `docs/guide/architecture.md`'s one-writer table and data model had no `stream_play_log` entry (phase 5 adds `reminders` there) | Gap | Assigned to phase 1 (owns the table); phase 5 quotes the post-phase-1 rows |
| 8 | Phase 3 linked the play log as `streaming.md#direct-streaming` pending phase 1's heading | Contract drift (soft) | Phase 1's heading is fixed (`### The play log`), so phase 3 links `streaming.md#the-play-log` |
| 9 | `src/mcp/server.ts`, generated references, `httpRoutes.ts`, features README edited by concurrent phases 3 and 5 | File collision | Each plan names its own lines (table above); generated files are regenerated with `docs:gen`, never merged |
| 10 | `schema.ts`, journal, `truncateAll`, `daemon.ts`, `CLAUDE.md`, `architecture.md` edited by 1 then 5 | File collision | Phase 5 quotes each file as phase 1 leaves it (`NewStreamPlayLogRow` last, `truncate table reminders, stream_play_log, ...`, text anchors in `daemon.ts`, shifted architecture rows) |
| 11 | `features/direct-streaming.md` edited by concurrent phases 1 and 2 | File collision | Different lines (:55 vs before :821); both plans say so |
| 12 | Phase 5's seed body names `/movies/health` and `direct_stream_health` | (checked) | Phase 3 uses exactly those (`MOVIES_HEALTH_SEGMENT = 'health'`, `STREAM_HEALTH_TOOL_NAME = 'direct_stream_health'`); phase 5's handoff records it |
| 13 | Phase 3 puts the icon in `MoviesPage.tsx` (via `afterKinds`), not `MoviesGrid.tsx`/`App.tsx` as the index's Owns said | Contract drift | Accepted; index's phase 3 Owns rewritten |
| 14 | Invariant 3 / R1.5: does phase 1's route write on a paused beat? | (checked) | `quiet` equals the route's own early-return test (`live.has(id)` is `current()?.session_id === id`); `PlayLog.report` adds the stats to the in-memory tally and returns before queuing any write; `replaced` is not called (the on-screen session is the reporter). A comment in phase 1's Step 8e states it |
| 15 | Phase 1's `replaced` (from the live on-screen state) vs `MoviesRepo.recordStreamPosition` closing every other open `movie_plays` row | (checked) | No contradiction: both are triggered by the same report; a page that reports again reopens both. A play not on screen stays open in the log and ends `expired`. Recorded in phase 1 Step 8 and Decisions |
| 16 | Phase table file counts and packages were the draft's estimates | Contract drift | Updated from the plans' Files tables |

Ledger after the edits: dependencies point backward only (3 → 1, 5 → 1); nothing is deleted or renamed by any phase; every impact point of the analysis has an owner (1-4: phase 1; 5: phase 2; 6-8: phase 3, with `MoviesGrid.tsx`/`App.tsx` replaced by `MoviesPage.tsx`; 9: phase 4, `sessionTools.ts` deliberately unchanged; 10: phase 5; 11: split as above); every phase builds green on its own; R1-R4 each have an owner; `ears_trace.py` exits 0.

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| "them": the play record only, or also the session-search flag | both; the question offered the two and the answer was "them" | 5: the user's raw input |
| "written once when the session ends" vs a daemon restart losing an open play | the row is written at the ask and updated on position reports (never on a paused beat), closed at the end | 1: invariant 3 and the daemon-restart rule in CLAUDE.md |
| "why a play ended" as a headline figure | dropped; start success, first-frame time, stalls and height lead, because the short plays are tests | 5: the user's second message |
| the reminder's carrier | the SessionStart hook reading a `reminders` table; shown at most once per 20 h until marked done | 5: "a hook reminder or something" |
| "after one week" from when | from the daemon's first start with the change (the seed's `due_at`) | 5: the user's raw input |
| live movies pictures for the new icon and page | not retaken in this set; the seeded reminder asks for it once the page has data | 6: convention (never a fixture picture in the movies guide) |
| two new tables, two migrations | phase 5 depends on phase 1 so `0044` and `0045` are generated in order | 6: convention (sequential drizzle migrations) |
| `played` in the health figures: outcome `played` only, or `played` and `site` | both: a site's player ran, so the play reached the screen; `success_rate` = played / asks is the headline per channel | 4: the index's Why ("successful short plays ARE successful streaming attempt") |
| `hd_share` over every played row, or over the played rows whose height is known | known heights only, null when none (a site row has no height) | 3: phase 3's code block and its tests |
| a failed row (no channel) in the per-channel totals | counted under each channel it asked (`cloud_failure`/`torrent_failure`), once under `all`, in no source | 4: the index's Why ("which movies / series we can't handle ... no torrent / no cloud sources") |
| `channel` on a failed row: may be set, or always null | always null (phase 1's CHECK); phase 3's per-channel rule reads the two failure words | 3: phase 1's code block (`stream_play_log_channel_check`) |
| a failed row's channel word that says `resolved` (a stream was found, the ask still failed) | kept as phase 1 writes it; the page words it "found, did not play" | 3: phase 1's code block (`WORDS` puts `resolved` first) |
| `replaced` from the live on-screen state, or mirroring `movie_plays`' closing of every other open play | the live on-screen state only; a play not on screen ends `expired`, a page that reports again reopens its row | 3: phase 1's code block (Step 8e) and journey J6 |
| where the health icon lives | `MoviesPage.tsx` through `MoviesGrid`'s `afterKinds` prop, where the Cache icon is built | 6: the surrounding code's convention |
| who describes the page's counters in the guide | phase 1's "The play log" section (one owner of the section) | 3: phase 2's plan (Handoffs) |
| the `stream_play_log` rows of `architecture.md` | phase 1 (owner of the table), before phase 5's `reminders` rows | 6: convention (every writer and table is listed there) |
## Open Questions

None.

## Rollback

Each phase is its own commit(s) on `feature/stream-play-log`; revert the phase's commits. The tables are additive: a rollback of the code leaves `stream_play_log` and `reminders` unused and harmless; drop them with a follow-up migration only if wanted. Nothing in this set changes or deletes existing rows.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/STREAM_PLAY_LOG_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows:

    /analyze-orchestrator -f .workflows/plan/STREAM_PLAY_LOG_PLAN.md
