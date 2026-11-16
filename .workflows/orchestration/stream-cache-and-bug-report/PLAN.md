# Plan: Stream cache and stream bug reporting

**Slug:** stream-cache-and-bug-report
**Date:** 2026-11-16 12:58 WIB
**Analysis:** `.workflows/analyze/20261116-125845-K7QM_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report`
**Branch:** `feature/stream-cache-and-bug-report` (base: `origin/main` @ `e7c978c`)
**Phases:** 6
**Status:** planned
**Coordinator:** —

---

## Why

Build both, robustly, for mcp-notes direct streaming (src/directStream/*, web/src/stream/*, docs/guide/streaming.md "Direct streaming").

Trigger: One Piece S18E787 from HyperLink (22nd provider tried) was very laggy and then died for good with "Playback stopped, (Network Error, fragloadError)". Causes suspected by the owner: bad office internet, or a distant/slow stream host. The daemon log holds only "resolved" and "playing", so the cause could not be determined afterwards.

Findings so far: web/src/stream/hlsEngine.ts caps the buffer at 30 s (maxMaxBufferLength: 30) and a fatal network error ends the play with no retry; every player request already goes through the daemon pass-through (src/directStream/passThrough.ts, /api/stream/sessions/<id>/p), sessions live in memory and tokens expire.

The owner's words: "can we implement some kind of "caching" method, so i can cache an episode first before streaming it? later on we will add a clear cache button for each episode item." and "i got a feeling that there would be a lot of problems with our streaming in the future. it's fine, but we need a formalized report skill for it. let's call it "/report-stream-bug" ... even better if we add a "report" button in the playback UI, so clicking this when there's a streaming failure like this will automatically spawn a new tmux session that trace this bug and document it in a note." and "just build both. /analyze them so we can ship it robustly".

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | A. Episode/film caching: cache an episode (or film) to disk on this host before or while streaming it, so playback comes from the local copy. The daemon downloads one rendition with retries and token refresh; a lower quality can be chosen to cache; the cache is per machine (other host reports not_on_this_machine / available: false); later a "clear cache" button per episode item (design the data model and route for it now). Include the small player fix: recover from a fatal network error (retry) instead of stopping, and let the buffer grow more than 30 s where safe. | 2, 5, 6 |
| R2 | 1. Evidence recording: the pass-through logs each segment's upstream status, time and throughput; the player page posts its error log (window.notesdStream errors/log) to the daemon; kept on disk per host like the vlc health log. | 1 |
| R3 | 2. A new skill /report-stream-bug (in claude/skills, modelled on claude/skills/trace-vlc-bug): collects the evidence into one folder, tells "my internet" from "this host/provider" (e.g. a reference download comparison), matches against known causes, and saves the finding as a note. | 3 |
| R4 | 3. A "report" button in the playback UI (icon only, Phosphor), shown in the error state: a click snapshots the evidence immediately (sessions are in memory, tokens expire), then spawns a new tmux Claude Code session that runs /report-stream-bug and documents the bug in a note. One report per failed session; repeat clicks are ignored. tmux and the claude binary must be injectable, tests never touch the real ones. | 4 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN a cache is requested for a film or an episode (`POST /api/stream/cache`, or the `direct_stream_cache` tool) THE SYSTEM SHALL resolve it and download one rendition's playlist, segments, keys and English subtitle into this host's cache directory, recording the cache and its progress in the database | 5 | P5.J1, P5.J2, P5.J7 |
| R1.2 | unwanted | IF a segment download fails or the stream host refuses the token during a cache download THEN THE SYSTEM SHALL retry with backoff, resolve the title again when refused, and continue from the segments already on disk | 5 | P5.J3, P5.J6, P5.J7 |
| R1.3 | optional | WHERE a maximum height is given with the cache request THE SYSTEM SHALL cache the highest rendition that is not above it | 5 | P5.J1, P5.J6 |
| R1.4 | event | WHEN a play is asked for a film or an episode that has a cache on this host THE SYSTEM SHALL play it from the local copy through the player page, without resolving a provider when the cache is complete, and fetching a segment not yet on disk on demand when it is not | 6 | P6.J1, P6.J2, P6.J3, P6.J4, P6.J5 |
| R1.5 | state | WHILE a cache was made on the other machine THE SYSTEM SHALL list it with `available: false` and answer 404 `not_on_this_machine` for its files and for a play from it | 5, 6 | P5.J4, P5.J7, P6.J4 |
| R1.6 | event | WHEN `DELETE /api/stream/cache/:id` is called on the owning host THE SYSTEM SHALL stop its download, remove its files from disk and remove the cache from every listing | 5 | P5.J5, P5.J7 |
| R1.7 | unwanted | IF a fatal network error (hls.js `fragLoadError` and its kin) happens during a play THEN THE SYSTEM SHALL keep the page on the film and retry loading with backoff from the position it stopped at, and stop with the error message only after the retries are spent | 2 | P2.J1, P2.J2, P2.J3 |
| R1.8 | state | WHILE a stream plays through the pass-through THE SYSTEM SHALL keep buffering ahead of the play up to 120 seconds, where it stopped at 30 | 2 | P2.J4, P2.J5 |
| R2.1 | event | WHEN the pass-through answers a player request THE SYSTEM SHALL append one record to this host's stream evidence log with the session id, the stream host and path without its query, the upstream status, the time to the first byte, the bytes sent, the duration and the throughput, or the error that ended it | 1 | P1.J1, P1.J2 |
| R2.2 | event | WHEN the player page meets an error, a refresh or a recovery THE SYSTEM SHALL post its log lines to the daemon, which appends them to the same evidence log under the session id | 1 | P1.J2, P1.J3, P1.J4 |
| R2.3 | event | WHEN a snapshot is asked for a session THE SYSTEM SHALL write that session's source (provider, attempts, hosts, refreshes), its evidence records and the player's posted log into one new folder on this host and answer the folder's path | 1 | P1.J5 |
| R2.4 | unwanted | IF the evidence log passes its size cap THEN THE SYSTEM SHALL rotate it the way the VLC health log does, and a failure to write evidence SHALL never fail or slow a pass-through answer | 1 | P1.J6, P1.J7 |
| R3.1 | event | WHEN `/report-stream-bug` runs its collect script THE SYSTEM SHALL gather the snapshot folder (the one handed to it, or a new one for the stream on screen or the last session), the daemon's direct-stream log lines, and a download-speed measurement of a reference host beside one of the stream host into one evidence folder | 3 | P3.J1, P3.J2, P3.J7 |
| R3.2 | event | WHEN the evidence is collected THE SYSTEM SHALL name the cause from the skill's known-causes table (this connection is slow, the stream host is slow or far, the token expired, the provider's stream is broken, the session ended, or new) and save the finding as a note tagged `#stream-bug` | 3 | P3.J1, P3.J5, P3.J6, P3.J7 |
| R3.3 | unwanted | IF the daemon does not answer or the session has ended THEN THE SYSTEM SHALL still write what can be collected (the log tail, the network measurement) and say in the summary what is missing | 3 | P3.J3, P3.J4, P3.J7 |
| R4.1 | state | WHILE the player page is in its error stage THE SYSTEM SHALL show an icon-only report button beside the error message | 4 | P4.J1, P4.J4 |
| R4.2 | event | WHEN the report button is clicked THE SYSTEM SHALL write the evidence snapshot at once and open a new tmux window running Claude Code with `/report-stream-bug <snapshot folder>` | 4 | P4.J1, P4.J4 |
| R4.3 | unwanted | IF a report was already made for that stream session THEN THE SYSTEM SHALL open no second window and answer `already_reported` with the first report's folder | 4 | P4.J2, P4.J4 |
| R4.4 | unwanted | IF no tmux server is running or the claude binary cannot be started THEN THE SYSTEM SHALL keep the snapshot, answer `no_tmux` or `spawn_failed` with the folder's path, and the page SHALL say the report was saved but not opened | 4 | P4.J3, P4.J4 |

## Scope

**In scope:** the stream evidence log and snapshot; the player's network recovery and longer buffer; the `/report-stream-bug` skill; the report button and its tmux spawn; the per-host stream cache (table, downloader, routes, MCP tool); playing from a cache; the docs, generated references and the verify-notesd feature map for each.

**Out of scope:**
- A button on the Movies page (episode rows, title page) to start or clear a cache. The owner said the clear button comes later; this set ships `GET /api/stream/cache` and `DELETE /api/stream/cache/:id` so that button is only UI.
- Caching DASH sources (`cache_unsupported`).
- Any change to the resolver CLI, the provider order or the prober.
- The streaming sites (`/idlix`, `/lk21`) and VLC playback.

## Invariants

1. The tree typechecks and `npm test`, `npm run test:int` and `npm run docs:check` pass at the end of every phase.
2. The pass-through stays a stream: a media body is never buffered whole, and recording evidence never fails, delays or changes an answer.
3. No signed address, token, cookie or captured header value is written to the evidence log, a snapshot, a note or the daemon log: stream addresses are recorded as host and path only.
4. A play without a cache behaves as today except for R1.7 and R1.8. The `?muted=1` playback checks (`playcheck.mjs`, its expiry journey) keep passing.
5. Tests never touch the real tmux, claude binary, `~/.claude`, the streaming Chrome or a real stream host: every one is injected (`CommandRunner`, `FetchLike`, `DirectStreamRunner`).
6. Two machines share the database, not the disk: every cache row carries its host; evidence, snapshots and cache files exist only on the host that made them.
7. `MoviesRepo` stays the only writer of `movie_*` tables. The cache table is `stream_caches`, written only by `DirectStreamRepo`.
8. A stream plays in the title's original language only; a cache takes the audio track the session names.
9. New routes that write or start something are same-origin only. Generated reference files are never hand-edited (`npm run docs:gen`).
10. Each phase puts its new code in its own new files (service class, routes file) and touches shared files (`service.ts`, `directStreamApi.ts`, `deps.ts`, `daemon.ts`, `config.ts`, `streaming.md`) only to wire them, so phases that run side by side merge cleanly.

## Contracts between phases

- **Evidence (phase 1):** `StreamEvidence` in `src/directStream/evidence.ts`, held on `AppDeps.streamEvidence`. `record(...)` queues a line for `<dataDir>/movies/stream-evidence-<host>.jsonl` (5 MB, rotated to `.1.jsonl`); `snapshot(sessionId | null)` writes `<dataDir>/movies/stream-reports/<YYYYMMDD-HHMMSS UTC>-<session id first 6, or none>[-N]/` (`STREAM_REPORTS_SUBDIR`, `StreamEvidence.reportsDir`) holding `session.json` `{session_id, host, taken_at, live, source, sessions}`, `evidence.jsonl`, `player.json` `{session_id, lines}`, and answers `{ dir, session_id, complete, records, player_lines }`; for a session it no longer holds it answers `complete: false` (it throws only when the folder cannot be written). Records: `request` `{type, at, session, provider, stream_host, path, range, kind, status, answer, ttfb_ms, bytes, duration_ms, kbps, redirects, outcome, error}`, `player` `{type, at, session, text, page_at, stage, position_s, buffer_s}`, `session` `{type, at, session, ref, event, provider, manifest_kind, stream_host, attempts, refreshes, error}`. Routes: `POST /api/stream/sessions/:id/events` (same-origin), `POST /api/stream/evidence/snapshot` (same-origin: a script sends `Origin` equal to the origin it calls; 200 `{ok, dir, session_id, complete, records, player_lines}`), `GET /api/stream/evidence?session=&limit=` (`{host, file, records}`). `DirectStreamService.evidenceSource(id)` peeks a live session without marking it used.
- **Skill invocation (phases 3 and 4):** the spawned prompt is exactly `/report-stream-bug <absolute snapshot folder>`, run by `claude --permission-mode auto` in a tmux window with the mcp-notes checkout as its folder. With a folder argument the skill's collect script adds to that folder and takes no new snapshot; it reads phase 4's `report.json` in it when present.
- **Engine recovery (phase 2):** `EngineHandlers` gains `onRecovering(attempt, message)` and `onRecovered()`; the controller's stages are `loading | ready | refreshing | recovering | error`. Buffer: `EngineRequest.bufferAheadS` with `BUFFER_AHEAD_S` (120) and `MUTED_BUFFER_AHEAD_S` (30) in `web/src/stream/engine.ts`, read by the HLS engine only.
- **Report (phase 4):** `StreamReporter` in `src/directStream/report.ts` on `AppDeps.streamReporter`; `POST /api/stream/sessions/:id/report`; `report.json` (`session_id`, `complete`, `page {stage, error, errors, log, title, position_s}`, `result`) in the snapshot folder.
- **Cache (phase 5):** `StreamCache` in `src/directStream/cache/`, held on `AppDeps.streamCache`; `player()` → `{ find(ref), get(id) }` answering `CachePlayData` (= phase 6's `CachePlayView`) for phase 6; `CACHE_ID_PATTERN` in `cache/types.ts`; files under `<dataDir>/movies/stream-cache/<cache id>/` (`master.m3u8`, `video.m3u8`, segments, `subtitle.vtt`); routes under `/api/stream/cache`. The file route fetches on demand for a `downloading` cache (starting its download in this process if none runs) and answers 502 `upstream_error` for a refused fetch, never a forwarded 401/403/410.
- **Play from the cache (phase 6):** `caches: () => deps.streamCache?.player() ?? null` in the service wiring; `SessionInfo.cached`; `POST /api/stream/cache/:id/play`; `CACHED_BUFFER_AHEAD_S` (600) set through phase 2's `bufferAheadS`; `SessionSource.cache` in phase 1's snapshot.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Stream evidence log and snapshot | R2 | `src/directStream`, `src/http`, `web/src/stream` | 21 | — | NORMAL | `.workflows/plan/stream-cache-and-bug-report/phase-1.md` | — | — |
| 2 | Player recovers from network errors and buffers further | R1 | `web/src/stream` | 15 | 1 | NORMAL | `.workflows/plan/stream-cache-and-bug-report/phase-2.md` | — | — |
| 3 | The `/report-stream-bug` skill | R3 | `claude/skills/report-stream-bug` | 12 (+24 fixture files) | 1 | NORMAL | `.workflows/plan/stream-cache-and-bug-report/phase-3.md` | — | — |
| 4 | Report button and its tmux session | R4 | `src/directStream`, `src/http`, `web/src/stream` | 22 | 1, 2 | NORMAL | `.workflows/plan/stream-cache-and-bug-report/phase-4.md` | — | — |
| 5 | Stream cache: table, downloader, routes, tool | R1 | `src/directStream/cache`, `src/db` | 42 | 1 | HARD | `.workflows/plan/stream-cache-and-bug-report/phase-5.md` | — | — |
| 6 | Play from the cache | R1 | `src/directStream`, `web/src/stream`, `claude/skills` | 26 | 2, 3, 4, 5 | HARD | `.workflows/plan/stream-cache-and-bug-report/phase-6.md` | — | — |

Phase 2 follows phase 1 because both edit `web/src/stream/controller.ts` (phase 1 posts the log, phase 2 adds lines to it). Phase 4 follows phase 2 because both edit the controller's stages and `StreamApp.tsx`'s overlay. Phase 6 follows phase 4 for the same files, phase 5 for the cache, and phase 3 because it edits the "What to do" cells of phase 3's `claude/skills/report-stream-bug/SKILL.md` (decision D5). Phases 2, 3 and 5 run side by side after phase 1, and phase 4 may run beside phase 5 (each follows only phase 1, and phase 4 phase 2): the files they share (`src/deps.ts`, `src/daemon.ts`, `src/http/app.ts`, `scripts/docs/httpRoutes.ts`, `docs/guide/streaming.md`, `docs/guide/architecture.md`, the verify-notesd feature map, `SKILL.md` and `verify.sh`) take additive edits anchored by text, as each plan's "Shared files" note says. Phases 4 and 6 quote every shared file as the earlier phases leave it. `docs/guide/reference/http-api.md` and `mcp-tools.md` are only regenerated (`npm run docs:gen`), never merged by hand.

### Phase 1 — Stream evidence log and snapshot
**Satisfies:** R2
**Owns:** `src/directStream/evidence.ts` (the per-host JSONL log with rotation, modelled on `HealthLog`; the snapshot writer); observing each pass-through answer in `forward()` / `DirectStreamService.passThrough` (status, time to first byte, bytes, duration, throughput, error, host and path without query; a counting transform over the streamed body, recorded when the body ends or is aborted); the routes `POST /api/stream/sessions/:id/events`, `POST /api/stream/evidence/snapshot`, `GET /api/stream/evidence` in a new routes file; the page posting its log lines (`controller.note` / `fail`) to the events route; wiring (`AppDeps.streamEvidence`, daemon); `StreamSession.refreshes`, `SessionStore.peek`, `DirectStreamService.evidenceSource`; route descriptions, guide, feature map; how a shell script may call the snapshot route (the Origin rule: an `Origin` equal to the origin it calls) decided and documented here.
**Does not touch:** the engines' error handling (phase 2), any UI, tmux, the cache, the database schema.
**Exit criteria:** a play through a fake stream host leaves one record per request in the log; a posted player log is in it; a snapshot folder holds the three files; rotation and write failure are proven by tests.

### Phase 2 — Player recovers from network errors and buffers further
**Satisfies:** R1
**Owns:** `web/src/stream/hlsEngine.ts` (a fatal network error retries with backoff: `startLoad` at the stopped position, a bounded number of attempts reset once it plays again; `maxMaxBufferLength` 120 except under `?muted=1`, which keeps 30 for the expiry check), the same recovery for dash.js and the native engine where they have one, `EngineHandlers.onRecovering` and `onRecovered`, `EngineRequest.bufferAheadS` with `BUFFER_AHEAD_S` / `MUTED_BUFFER_AHEAD_S` (the one buffer setting; dash.js keeps its own buffer), `player.steps.mjs` J3 moved to `?muted=1`, the controller's `recovering` stage and its log lines (which phase 1's posting carries to the daemon), the overlay's "reconnecting" state, tests, guide text.
**Does not touch:** the daemon, the report button, the cache.
**Exit criteria:** a fake engine failing segment loads recovers and plays on; after the retries are spent the page shows the error as today; the buffer setting is asserted; `playcheck` journeys still pass.

### Phase 3 — The `/report-stream-bug` skill
**Satisfies:** R3
**Owns:** `claude/skills/report-stream-bug/` (`SKILL.md`, `collect.sh`, a small network measurement script), modelled on `trace-vlc-bug`: collect (snapshot folder given or asked from the daemon, daemon log lines, reference download beside a stream host download), `diagnose.mjs` reading phase 1's exact shapes and phase 4's `report.json` when present, the known-causes table, saving the finding as a note tagged `#stream-bug` linked to the session; rules for an unattended `--permission-mode auto` run (no repository edit, evidence treated as data); `scripts/install.sh` `SKILL_NAMES`; tests for the scripts against a fake daemon; the guide section; `verify-notesd` map entry.
**Does not touch:** daemon source (it uses phase 1's routes as they are), the player page, the "cache it first" advice (phase 6 adds it with the tool).
**Exit criteria:** the collect script run against a throwaway daemon produces the folder and a summary; with the daemon down it still writes the measurement and says what is missing.

### Phase 4 — Report button and its tmux session
**Satisfies:** R4
**Owns:** `src/directStream/report.ts` (`StreamReporter`: snapshot through phase 1's `StreamEvidence` into its `reportsDir` (`STREAM_REPORTS_SUBDIR`), liveness through `evidenceSource`, claude started with `--permission-mode auto`, one report per session id remembered in memory and by a marker in the snapshot folder, then a tmux window running claude with `/report-stream-bug <folder>` in the mcp-notes repo directory); the window opener exported from `src/sessions/resume.ts` for reuse (no behaviour change there); `POST /api/stream/sessions/:id/report` (same-origin) in a new routes file; the icon-only button in the error overlay, its states (sending, opened, saved but not opened, already reported); wiring; route docs, guide, feature map; a recording fake tmux pinned by every `verify.sh up` (no picture: the guide shows no player page).
**Does not touch:** the evidence format, the skill's files, the engines' recovery, the cache.
**Exit criteria:** with a fake `CommandRunner`, a click yields one `new-window` call carrying the prompt; a second click yields none; no tmux yields `no_tmux` with the folder kept.

### Phase 5 — Stream cache: table, downloader, routes, tool
**Satisfies:** R1
**Owns:** table `stream_caches` (id, kind, tmdb id, season, episode, host, provider, height, state `downloading | ready | failed`, segment counts, bytes, error, timestamps) with migration `0029`, written only by `DirectStreamRepo`; `src/directStream/cache/` (store on disk under `<dataDir>/movies/stream-cache/<id>/`, HLS rendition and audio choice with an optional maximum height, the downloader with bounded parallel segment fetches, retries with backoff, a fresh resolve on a refused token, resume from disk after a restart, plain-file download by ranges, DASH answered `cache_unsupported`, a local playlist that lists every segment by index, the English subtitle saved as WebVTT); routes `POST /api/stream/cache`, `GET /api/stream/cache`, `GET /api/stream/cache/:id`, `DELETE /api/stream/cache/:id`, and the file route that serves a segment from disk or fetches it on demand; `available: false` / `not_on_this_machine` for the other host; the `direct_stream_cache` MCP tool (start, status, list, clear), kept out of the chat allow list; `StreamCache.player()` for phase 6; config (`NOTESD_STREAM_CACHE_DIR`), wiring, background resume of unfinished downloads; docs, feature map. The file route starts a `downloading` cache's download in this process when none runs, and answers 502 `upstream_error` (never a forwarded 401/403/410) for a refused on-demand fetch.
**Does not touch:** `DirectStreamService.play`, the player page, the Movies page, the evidence log (the cache's own fetches are not recorded), the text naming `direct_stream_cache` in `instructions.ts` and the skills (phase 6).
**Exit criteria:** against a fake stream host, a cache request ends `ready` with every segment on disk; failures and a refused token are retried; a maximum height picks the right rendition; the other host's cache is listed unavailable and its files and delete answer `not_on_this_machine`; delete removes files and row.

### Phase 6 — Play from the cache
**Satisfies:** R1 (R1.4, and R1.5's play-by-id part)
**Owns:** `DirectStreamService.play` / `resolve` using a cache on this host (a complete cache makes a session with no resolver run; a downloading one plays the local playlist while the file route fetches missing segments); `POST /api/stream/cache/:id/play` (404 `not_on_this_machine` for the other machine's cache); `SessionInfo.cached` and the page's reading of it; `CACHED_BUFFER_AHEAD_S` (600) through phase 2's `bufferAheadS` for a complete cache; the "from cache" mark beside the title on the player page; position reports and resume unchanged; `SessionSource.cache` in phase 1's snapshot and the `created` record of a session made from a cache; the `direct_stream_play` tool text, `src/mcp/instructions.ts`, `claude/skills/direct-stream/SKILL.md` ("cache it first", "play from the cache", what the answer says) and the "cache it first" advice in `claude/skills/report-stream-bug/SKILL.md`; docs, feature map.
**Does not touch:** the downloader's internals, the evidence format beyond the one `SessionSource.cache` field, the report flow, `hlsEngine.ts`.
**Exit criteria:** with a `ready` cache and a resolver that would fail, a play starts and the page plays local files; with a half-downloaded cache a segment not on disk is fetched on demand and plays; the other machine's cache is refused by id (404 `not_on_this_machine`) and ignored by title; without a cache nothing changes.

## Reconciliation Log

| # | Conflict | Kind | Phases | Resolution |
|---|---|---|---|---|
| 1 | Phase 3 read evidence in invented shapes (`ts`, `session_id`, `kind: pass/player`, `host`, `bytes_per_s`, `line`/`lines`, a wrapped `session.json`, a 2xx snapshot answer of three fields) | Unmet assumption / contract drift | 1, 3 | Phase 3 rewritten to phase 1's shapes: `diagnose.mjs` `FIELDS` and `readFolder` (records by `type`, `at`, `session`, `stream_host`, `kbps`, `outcome`; `session.json` `{session_id, host, taken_at, live, source, sessions}`; `player.json` `{session_id, lines}`), the `collect.sh` route block (Origin rule, 200 answer, `{host, file, records}`), all 24 fixture files, the fake daemon and test records; collect folder stamped in UTC like phase 1's. Failures now exclude `aborted` (a seek). |
| 2 | Phase 4 assumed `snapshot()` answers `complete:false` for an ended session and that `AppDeps.streamEvidence` is the field; it defined its own `stream-reports` path | Unmet assumption / duplicate work | 1, 4 | Confirmed against phase 1's code (it never throws for an unknown id). `report.ts` imports phase 1's `STREAM_REPORTS_SUBDIR`; the daemon passes `StreamEvidence.reportsDir`; liveness uses phase 1's `evidenceSource` (does not mark the session used) instead of `session(id)`. |
| 3 | Phase 4 writes `report.json` into the snapshot folder; phase 3 did not read it | Gap | 3, 4 | Phase 3's `FIELDS.report` and `readFolder` read `report.json` when present (page log, errors, title); new unit test; SKILL.md and guide list it. |
| 4 | Phase 2 added `EngineHandlers.onRecovered()` beyond the index's contract line, and reads R1.8's 120 s as HLS only | Contract drift | 2 | Accepted; "Contracts between phases" names both handlers and the buffer setting; HLS-only recorded as decision D2 (criterion text unchanged). |
| 5 | Phase 6 invented `web/src/stream/buffer.ts` (`hlsMaxBufferS`, 30/120/600) and assumed `EngineRequest.muted`; phase 2 owns `bufferAheadS`, `BUFFER_AHEAD_S`, `MUTED_BUFFER_AHEAD_S` | Duplicate work / unmet assumption | 2, 6 | One definition: phase 6 drops `buffer.ts`, `EngineRequest.cached` and its `hlsEngine.ts` edit; adds only `CACHED_BUFFER_AHEAD_S` (600) to `engine.ts` and chooses `bufferAheadS` in `controller.attach`; tests rewritten to read `req.bufferAheadS`. |
| 6 | Phase 6 assumed `deps.streamCache` itself fits `PlayableCaches` with `index.m3u8` / `en.vtt`; phase 5 exposes `player()` with `master.m3u8` / `subtitle.vtt` | Unmet assumption | 5, 6 | Phase 6 wiring is `caches: () => deps.streamCache?.player() ?? null`; names table, Requires, fakes and journeys use phase 5's names. |
| 7 | Phase 6 needs the file route to fetch on demand for a `downloading` row with no running job, and to answer 502 rather than a forwarded refusal | Unmet assumption | 5, 6 | Phase 5's code already does both (`launchNow`; `jsonError(502, 'upstream_error')` on any failure); stated explicitly in phase 5's Interface Contract and the index contract. Phase 6's J3 unchanged. |
| 8 | Both phases 5 and 6 defined `CACHE_ID_PATTERN` (a uuid vs a loose pattern) | Duplicate work | 5, 6 | Phase 6's `cachePlay.ts` re-exports phase 5's; its "unknown cache" test uses a well-formed uuid. |
| 9 | R1.5's "for a play from it" is only observable through phase 6's `POST /api/stream/cache/:id/play` | Untraced part of a criterion | 5, 6 | R1.5 owned by phases 5 and 6; phase 6's **Criteria** line gains R1.5 and J4 traces R1.4, R1.5. |
| 10 | `direct_stream_cache` named in `claude/skills/direct-stream/SKILL.md` and `src/mcp/instructions.ts`: phase 5 left it to phase 6, phase 6's Files lacked `instructions.ts`; phase 3 wanted "cache it first" in its known-causes rows before the tool exists | Gap / ordering | 3, 5, 6 | Phase 6 owns all three texts: Step 14 adds the `instructions.ts` sentence and the two "What to do" cells of phase 3's SKILL.md (decision D5). |
| 11 | Phase 6 rewrote `resolve` / `refresh` / `SessionStore.create` / `replaceSource` from today's code, dropping phase 1's evidence records, `refreshes` and the `created` record a cached session needs | File collision (later phase quoting pre-change code) | 1, 6 | Phase 6's Steps 2 and 3 quote and keep phase 1's lines (`refreshes: 0`, `refreshes += 1`, `safeRecord(... 'created' / 'refresh_failed' / 'refreshed')`) and add a `created` record in `sessionFromCache`; wiring anchored after phase 1's `evidence: streamEvidence,`. |
| 12 | Phase 4 quoted the pre-phase-1 `./session` import in `controller.ts` and anchored `deps.ts` / `app.ts` / `session.ts` at lines phase 1 also inserts after | File collision | 1, 4 | Phase 4's import block now includes phase 1's `postEvents` / `PlayerLogLine`; its insertions are anchored after phase 1's lines. |
| 13 | Phases 4 and 5 can run at the same time (each depends only on 1, and 4 on 2) and both edit `src/deps.ts`, `src/daemon.ts`, `src/http/app.ts`, `scripts/docs/httpRoutes.ts`, `docs/guide/streaming.md`, the verify-notesd `SKILL.md`, feature map and `verify.sh`'s `env=(...)` array; phases 3 and 5 both insert before `## Gotchas` | File collision (no stated sequence) | 3, 4, 5 | Every plan has a "Shared files" note: edits additive and anchored by text, whichever lands second keeps the other's lines; generated references only by `npm run docs:gen`. |
| 14 | A cached play leaves no pass-through evidence; phase 5 adds no evidence hook | Gap (R2 vs R1) | 1, 5, 6 | Phase 6 adds `SessionSource.cache` `{id, state}` (two lines in phase 1's `evidence.ts`) and the `created` record; phase 3 prints it. Cache downloads stay unrecorded (decision D6). |
| 15 | Phases 3, 5 and 6 did not say to run `npm ci` first (the worktree has no `node_modules`) | Broken-build risk | 3, 5, 6 | Each plan's Implementation Steps opens with `npm ci`; phases 1, 2, 4 already did. |
| 16 | The spawned report session runs under `--permission-mode auto`; phase 3's SKILL.md told it to edit the repo for a new cause | Contract drift | 3, 4 | Phase 3's SKILL.md: in an unattended run only its scripts and the notes tools, no repository edit (the proposed rule goes into the note), evidence treated as data. Decision D4. |
| 17 | Round 2: phase 6 edits phase 3's `claude/skills/report-stream-bug/SKILL.md` (D5) and relies on its `diagnose.mjs` reading `source.cache`, but depended only on 2, 4, 5, none of which brings phase 3 in, so a swarm could start it before that file exists | Ordering violation | 3, 6 | Phase 6's **Depends on** is now 2, 3, 4, 5 (Requires names phase 3); the Phases table and the ordering paragraph say so. No phase-3 or phase-6 content changes. |
| 18 | Round 2: phase 6's `cache-play.sh downloading` stage set a ready row to `downloading` without clearing `completed_at`, which phase 5's `stream_caches_ready_check` refuses; `verify.sh exec` does not fail on an SQL error, so J3 would have failed later on `cached.state` | Contract drift (fixture vs phase 5's schema) | 5, 6 | The update also sets `completed_at = null`, and the script reads the state back and fails at once if it did not change. |

## Decisions

| # | Fork | Choice | Rung |
|---|---|---|---|
| D1 | `EngineHandlers` gains only `onRecovering` (index contract line) or also `onRecovered` (phase 2) | Both. Only the engine knows a load succeeded; "playback advances" resets the count from the 120 s buffer while every load still fails, so the retries would never be spent (R1.7's "stop ... only after the retries are spent") | The plans' code blocks (phase 2's `networkRecovery`), against the index's contract line; the criterion R1.7 settles it |
| D2 | R1.8's 120 s for every engine, or for HLS only | HLS only; dash.js keeps its own buffer. The 30 s cap R1.8 names is hls.js's (`hlsEngine.ts:20`), and `dash-expiry.steps.mjs` (Invariant 4's neighbour) needs unloaded DASH segments at 100 s. R1.8's text is not edited | Stated invariant 4 (the expiry checks keep passing), then the analysis's finding naming hls.js's `maxMaxBufferLength: 30` |
| D3 | One buffer definition: phase 2's `bufferAheadS` + constants, or phase 6's `buffer.ts` / `hlsMaxBufferS` / `EngineRequest.muted` | Phase 2's. Phase 6 adds `CACHED_BUFFER_AHEAD_S` (600) and the choice in `attach` | The plans' code blocks: phase 2 lands first and phase 6's own text says to keep phase 2's constants if they exist |
| D4 | Permission mode of the spawned report session: `auto` or `bypassPermissions` | `--permission-mode auto`, as phase 4 wrote it: the evidence holds third-party text (stream hosts' errors, names, paths), so the classifier stays between it and the shell. Phase 3's skill is written to run unattended under it from the mcp-notes checkout (no repository edits, evidence as data) | The index's Why / R4 ("spawns a new tmux Claude Code session that runs /report-stream-bug") and invariant 3's intent (third-party data stays inert), then phase 4's code block |
| D5 | Where the "cache it first" advice for slow connections / hosts lands | Phase 6 adds it to `claude/skills/report-stream-bug/SKILL.md`'s `connection_slow` / `host_slow` rows, with the `instructions.ts` and `/direct-stream` texts, once `direct_stream_cache` exists. No rule or fixture changes | Ordering (phase 3 lands before the tool exists), then phase 5's handoff giving every `direct_stream_cache` text to phase 6 |
| D6 | Make a cached play visible in a stream bug report | Smallest correct: phase 6 adds `cache: {id, state} \| null` to phase 1's `SessionSource` (filled in `sessionSource()`) and writes the `created` session record for a session made from a cache. Not done: recording the cache's own downloads in the evidence log (phase 5: not a one-line hook) and a known-causes row for cached plays (no failure seen yet; `new` covers it) | R2.3 ("the session's source") and the surrounding convention (phase 1's handoff asked for the `created` record); scope kept small per the index's Invariant 10 |
| D7 | `direct_stream_cache` in the chat bar's allow list | Kept out (phase 5) | The plans' code blocks (phase 5's test `keeps direct_stream_cache out of the chat bar`); nothing in R1 asks for the chat bar |
| D8 | R1.5's "for a play from it" owned by phase 5 or phase 6 | Both: phase 5 the listing, files and delete; phase 6 the play by id (`POST /api/stream/cache/:id/play`, its J4) | Where the behaviour lands (rule 7: criterion ids follow the work) |
| D9 | Phase 3's `aborted` request records counted as failures or not | Not failures: `aborted` is the player going away (phase 1's definition, e.g. a seek); failures are `error` / `refused` outcomes or a 4xx/5xx status other than 416 | Phase 1's code block (`REQUEST_OUTCOMES` and `observeForward`'s comments) |
| D10 | Index status word | `planned`, as the caller asked | The caller's instruction |

## Open Questions

## Rollback

Each phase is one commit series on `feature/stream-cache-and-bug-report`; revert the phase's commits. Phase 5's migration only adds the table `stream_caches`; reverting it leaves an unused table, which is harmless, and its files live under `<dataDir>/movies/stream-cache/` and can be deleted. Evidence and report folders are plain files under `<dataDir>/movies/`. The whole set is backed out by not merging the branch.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/STREAM_CACHE_AND_BUG_REPORT_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows, resumable on any machine:

    /analyze-orchestrator -f .workflows/plan/STREAM_CACHE_AND_BUG_REPORT_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan .workflows/plan/STREAM_CACHE_AND_BUG_REPORT_PLAN.md
