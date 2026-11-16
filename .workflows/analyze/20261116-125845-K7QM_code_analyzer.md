# Code Analysis: direct streaming — episode cache and stream bug reporting

**Type:** Feature Implementation
**Date:** 2026-11-16 12:58 WIB
**Session ID:** 20261116-125845-K7QM
**Plan:** `.workflows/plan/STREAM_CACHE_AND_BUG_REPORT_PLAN.md` (6 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/stream-cache-and-bug-report`, branch `feature/stream-cache-and-bug-report` (base `origin/main` @ `e7c978c`)

---

## User Input

### Original User Request

Build both, robustly, for mcp-notes direct streaming (src/directStream/*, web/src/stream/*, docs/guide/streaming.md "Direct streaming").

Trigger: One Piece S18E787 from HyperLink (22nd provider tried) was very laggy and then died for good with "Playback stopped, (Network Error, fragloadError)". Causes suspected by the owner: bad office internet, or a distant/slow stream host. The daemon log holds only "resolved" and "playing", so the cause could not be determined afterwards.

Findings so far: web/src/stream/hlsEngine.ts caps the buffer at 30 s (maxMaxBufferLength: 30) and a fatal network error ends the play with no retry; every player request already goes through the daemon pass-through (src/directStream/passThrough.ts, /api/stream/sessions/<id>/p), sessions live in memory and tokens expire.

A. Episode/film caching: cache an episode (or film) to disk on this host before or while streaming it, so playback comes from the local copy. The daemon downloads one rendition with retries and token refresh; a lower quality can be chosen to cache; the cache is per machine (other host reports not_on_this_machine / available: false); later a "clear cache" button per episode item (design the data model and route for it now). Include the small player fix: recover from a fatal network error (retry) instead of stopping, and let the buffer grow more than 30 s where safe.

B. Stream bug reporting:
 1. Evidence recording: the pass-through logs each segment's upstream status, time and throughput; the player page posts its error log (window.notesdStream errors/log) to the daemon; kept on disk per host like the vlc health log.
 2. A new skill /report-stream-bug (in claude/skills, modelled on claude/skills/trace-vlc-bug): collects the evidence into one folder, tells "my internet" from "this host/provider" (e.g. a reference download comparison), matches against known causes, and saves the finding as a note.
 3. A "report" button in the playback UI (icon only, Phosphor), shown in the error state: a click snapshots the evidence immediately (sessions are in memory, tokens expire), then spawns a new tmux Claude Code session that runs /report-stream-bug and documents the bug in a note. One report per failed session; repeat clicks are ignored. tmux and the claude binary must be injectable, tests never touch the real ones.

Suggested order: evidence recording + retry fix, the skill, the report button, then caching. Follow CLAUDE.md: docs:gen for new routes/tools, configuration.md for new env vars, the streaming guide, docs:shots for changed UI, and the verify-notesd feature map.

### User-Provided Context

The owner's own words, from the conversation that led to this run:

> first of all, the streaming experience for this episode is trash. it is very laggy. can we implement some kind of "caching" method, so i can cache an episode first before streaming it? later on we will add a clear cache button for each episode item. there are 2 causes for this laggy stream: a. my office internet is trash b. the cloud source is too "far" or smth
>
> right now, the streaming won't continue anymore and just print out "Playback stopped, (Network Error, fragloadError)"
>
> i got a feeling that there would be a lot of problems with our streaming in the future. it's fine, but we need a formalized report skill for it. let's call it "/report-stream-bug". let's create this skill. even better if we add a "report" button in the playback UI, so clicking this when there's a streaming failure like this will automatically spawn a new tmux session that trace this bug and document it in a note.
>
> just build both. /analyze them so we can ship it robustly

Daemon log of the failing play: `TMDB tv 37854 S18E787 resolved by HyperLink (hls) after 22 tries`, `playing ... from HyperLink`, nothing else.

### User-Provided Files

None marked with `@`. Named: `src/directStream/*`, `web/src/stream/*`, `docs/guide/streaming.md`, `claude/skills/trace-vlc-bug`.

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | A. Episode/film caching: cache an episode (or film) to disk on this host before or while streaming it, so playback comes from the local copy. The daemon downloads one rendition with retries and token refresh; a lower quality can be chosen to cache; the cache is per machine (other host reports not_on_this_machine / available: false); later a "clear cache" button per episode item (design the data model and route for it now). Include the small player fix: recover from a fatal network error (retry) instead of stopping, and let the buffer grow more than 30 s where safe. |
| R2 | 1. Evidence recording: the pass-through logs each segment's upstream status, time and throughput; the player page posts its error log (window.notesdStream errors/log) to the daemon; kept on disk per host like the vlc health log. |
| R3 | 2. A new skill /report-stream-bug (in claude/skills, modelled on claude/skills/trace-vlc-bug): collects the evidence into one folder, tells "my internet" from "this host/provider" (e.g. a reference download comparison), matches against known causes, and saves the finding as a note. |
| R4 | 3. A "report" button in the playback UI (icon only, Phosphor), shown in the error state: a click snapshots the evidence immediately (sessions are in memory, tokens expire), then spawns a new tmux Claude Code session that runs /report-stream-bug and documents the bug in a note. One report per failed session; repeat clicks are ignored. tmux and the claude binary must be injectable, tests never touch the real ones. |

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN a cache is requested for a film or an episode (`POST /api/stream/cache`, or the `direct_stream_cache` tool) THE SYSTEM SHALL resolve it and download one rendition's playlist, segments, keys and English subtitle into this host's cache directory, recording the cache and its progress in the database |
| R1.2 | unwanted | IF a segment download fails or the stream host refuses the token during a cache download THEN THE SYSTEM SHALL retry with backoff, resolve the title again when refused, and continue from the segments already on disk |
| R1.3 | optional | WHERE a maximum height is given with the cache request THE SYSTEM SHALL cache the highest rendition that is not above it |
| R1.4 | event | WHEN a play is asked for a film or an episode that has a cache on this host THE SYSTEM SHALL play it from the local copy through the player page, without resolving a provider when the cache is complete, and fetching a segment not yet on disk on demand when it is not |
| R1.5 | state | WHILE a cache was made on the other machine THE SYSTEM SHALL list it with `available: false` and answer 404 `not_on_this_machine` for its files and for a play from it |
| R1.6 | event | WHEN `DELETE /api/stream/cache/:id` is called on the owning host THE SYSTEM SHALL stop its download, remove its files from disk and remove the cache from every listing |
| R1.7 | unwanted | IF a fatal network error (hls.js `fragLoadError` and its kin) happens during a play THEN THE SYSTEM SHALL keep the page on the film and retry loading with backoff from the position it stopped at, and stop with the error message only after the retries are spent |
| R1.8 | state | WHILE a stream plays through the pass-through THE SYSTEM SHALL keep buffering ahead of the play up to 120 seconds, where it stopped at 30 |
| R2.1 | event | WHEN the pass-through answers a player request THE SYSTEM SHALL append one record to this host's stream evidence log with the session id, the stream host and path without its query, the upstream status, the time to the first byte, the bytes sent, the duration and the throughput, or the error that ended it |
| R2.2 | event | WHEN the player page meets an error, a refresh or a recovery THE SYSTEM SHALL post its log lines to the daemon, which appends them to the same evidence log under the session id |
| R2.3 | event | WHEN a snapshot is asked for a session THE SYSTEM SHALL write that session's source (provider, attempts, hosts, refreshes), its evidence records and the player's posted log into one new folder on this host and answer the folder's path |
| R2.4 | unwanted | IF the evidence log passes its size cap THEN THE SYSTEM SHALL rotate it the way the VLC health log does, and a failure to write evidence SHALL never fail or slow a pass-through answer |
| R3.1 | event | WHEN `/report-stream-bug` runs its collect script THE SYSTEM SHALL gather the snapshot folder (the one handed to it, or a new one for the stream on screen or the last session), the daemon's direct-stream log lines, and a download-speed measurement of a reference host beside one of the stream host into one evidence folder |
| R3.2 | event | WHEN the evidence is collected THE SYSTEM SHALL name the cause from the skill's known-causes table (this connection is slow, the stream host is slow or far, the token expired, the provider's stream is broken, the session ended, or new) and save the finding as a note tagged `#stream-bug` |
| R3.3 | unwanted | IF the daemon does not answer or the session has ended THEN THE SYSTEM SHALL still write what can be collected (the log tail, the network measurement) and say in the summary what is missing |
| R4.1 | state | WHILE the player page is in its error stage THE SYSTEM SHALL show an icon-only report button beside the error message |
| R4.2 | event | WHEN the report button is clicked THE SYSTEM SHALL write the evidence snapshot at once and open a new tmux window running Claude Code with `/report-stream-bug <snapshot folder>` |
| R4.3 | unwanted | IF a report was already made for that stream session THEN THE SYSTEM SHALL open no second window and answer `already_reported` with the first report's folder |
| R4.4 | unwanted | IF no tmux server is running or the claude binary cannot be started THEN THE SYSTEM SHALL keep the snapshot, answer `no_tmux` or `spawn_failed` with the folder's path, and the page SHALL say the report was saved but not opened |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement**: A direct-stream play pulls every byte from a third-party host through the daemon's pass-through as the player asks for it, with 30 s of buffer and no recovery from a failed segment load. On a slow link or a slow host the play stutters and then ends. Nothing about the failure is kept: the pass-through logs nothing, and the player's log lives only in the page. Two additions are asked for. (A) A per-host disk cache of one rendition of a film or episode, downloaded by the daemon with retries and token refresh, which the player plays from; and a player that retries a failed load and buffers further ahead. (B) A recorded trail of every pass-through request and of the page's own errors, a skill that turns that trail into a diagnosed note, and a button in the player's error state that snapshots the trail and starts that skill in a new tmux Claude Code session.

**Success Criteria**: the acceptance criteria above; `npm run typecheck`, `npm test`, `npm run test:int` and `npm run docs:check` pass at the end of every phase; nothing changes for a play without a cache except the retry and the longer buffer.

**Key Considerations**:

- The pass-through must stay a stream: evidence is recorded by observing the body as it passes (a counting transform), never by buffering it.
- Evidence must not hold secrets. Stream addresses carry signed tokens in their query; only host and path are recorded.
- Sessions are in memory (`SessionStore`), end on restart, and hold the attempts and hosts a report needs. A snapshot must be taken while the session is alive, and the evidence log (on disk) must be useful after it is gone.
- The two machines share the database, not the disk. A cache row carries its host; files exist only there.
- `MoviesRepo` is the only writer of `movie_*` tables. The cache table is a direct-stream table (`stream_*` prefix, written by `DirectStreamRepo`, like `stream_providers`), so that rule is not touched.
- Movie ids come from database triggers; a cache id is its own generated id (uuid), not a movie id.
- A stream always plays in the original language: the cached rendition must take the audio track the session's `audio.track` names, as the player does.
- The player's `?muted=1` checks (`claude/streaming/direct/playcheck.mjs`, journey J3 "expiry") rely on the 30 s cap so that unloaded segments exist when a token is expired; the cap may only be raised where that check still holds.
- tmux: `src/sessions/resume.ts` already opens Claude Code windows in the owner's tmux (`openClaudeWindow`, `tmuxGlobalPath`, `claudeCommand`, `pickTmuxSession`), with `NOTESD_TMUX_BIN`, `NOTESD_TMUX_SOCKET` and `NOTESD_CLAUDE_BIN` injectable. `openClaudeWindow` is not exported.
- `sameOriginOnly` refuses a request without a matching `Origin`. A skill's `curl` has none, so a route the skill calls from the shell cannot be same-origin-only unless the script sends the daemon's own origin (the pattern other scripts use must be checked by the planner).

**Assumptions** (inferred, stated):

- "Cache first" is started through Claude (`direct_stream_cache` tool, `/direct-stream` wording) and `POST /api/stream/cache`. A button on the Movies page for starting or clearing a cache is the "later" the owner named; this set ships the data model and the routes (`GET`, `DELETE`) that button needs, not the button.
- HLS and plain-file (mp4) sources are cached. DASH answers `cache_unsupported`: no provider in the registry that matters today serves DASH only.
- 120 s is "more than 30 s where safe" for a pass-through play; a play from a complete cache may buffer without that cap.
- The report note is written by the spawned Claude Code session through the `notes` MCP server, as `trace-vlc-bug` does; the daemon writes no note itself.

---

## Analysis Scope

### Explicitly Mentioned Files

- `src/directStream/*` (service, sessions, passThrough, rewrite, repo, runner, types)
- `web/src/stream/*` (controller, engines, session, StreamApp)
- `docs/guide/streaming.md` ("Direct streaming")
- `claude/skills/trace-vlc-bug/` (`SKILL.md`, `trace.sh`, `collect.ps1`)

### Discovered Related Files

- `src/http/directStreamApi.ts` — every `/api/stream/*` route
- `src/movies/streamLive.ts`, `src/movies/streams.ts` — the stream on screen, position reports to `movie_plays`
- `src/movies/vlc/health.ts` — `HealthLog`: per-host fsync'd JSONL with rotation (`vlc-health-<host>.jsonl`, 5 MB, `.1.jsonl`)
- `src/sessions/resume.ts`, `src/http/sessionResume.ts` — tmux spawn of Claude Code
- `src/config.ts` (`DirectStreamConfig`, `parseDirectStream`, `claudeBin`), `src/deps.ts`, `src/daemon.ts`, `src/main.ts`, `src/background.ts`, `src/http/app.ts`
- `src/db/schema.ts` (`movieStreamSources`, `streamProviders`, `streamProviderHealth`, `streamProbeTitles`), `drizzle/` (last migration `0028_dialogue_story.sql`)
- `src/mcp/*` direct-stream tools (`direct_stream_play`, `_find`, ...), `src/chat/status.ts` (`allowedChatTools`)
- `claude/skills/direct-stream/SKILL.md`, `claude/streaming/direct/playcheck.mjs`
- `scripts/docs/httpRoutes.ts`, `docs/guide/reference/configuration.md`, `scripts/install.sh` (links every folder of `claude/skills`)
- `.claude/skills/verify-notesd/features/direct-streaming.md`
- Tests: `tests/unit/directStream/*`, `tests/integration/directStream.*.int.test.ts`, `tests/integration/movies.stream*.int.test.ts`, `web/src/stream/*.test.tsx`, `tests/integration/sessions.resume.int.test.ts`

---

## Current Dataflow

### Entry Point: a play

**Location:** `src/http/directStreamApi.ts:82` (`POST /api/stream/play`, same-origin) and the `direct_stream_play` MCP tool
**Next Step:** `DirectStreamService.play()` at `src/directStream/service.ts:205`

### Processing Chain

1. **`DirectStreamService.resolve()`** — `service.ts:195`. Runs the resolver CLI (one at a time through `serial`), calls the `recordResolve` hook, creates a `StreamSession` in `SessionStore` (`sessions.ts:64`): id, ref, source (manifest url, captured headers, subtitles, audio), attempts, allowed hosts, resume position.
2. **`play()`** — runs `open <pageBase>/stream/<id> --fullscreen` in the streaming Chrome, logs `direct stream: playing <ref> from <provider>`.
3. **Player page** — `web/src/stream/controller.ts`. `start()` reads `GET /api/stream/sessions/:id` (`SessionInfo`, `service.ts:89`), loads subtitle files, `attach()` creates an engine (`createEngine.ts`: hls.js, dash.js or native) on `manifest_url`, which is a pass-through address.
4. **Pass-through** — `GET /api/stream/sessions/:id/p?u=` → `service.passThrough()` (`service.ts:310`) → `forward()` (`passThrough.ts:84`). Checks the host against `allowedHosts`, sends only the captured `Referer`/`Origin`/`User-Agent` and the player's `Range`, follows redirects itself, rewrites HLS and DASH text so every address comes back through it (`rewrite.ts`), streams media bodies through untouched with `X-Notesd-Upstream`. Errors answer 502 `upstream_error`, 403 `forbidden_host` / `unknown_session`. **Nothing is logged or recorded here.**
5. **Engine errors** — `hlsEngine.ts:39`. A 401/403/410 goes to `onAuthError` (refresh, at most 3) or `onSessionOver`. A non-fatal error is ignored (hls.js retries a fragment on its own a few times). A fatal media error is recovered once. **Any other fatal error, network errors included, calls `onFatal("<type> <details>")`**, and `controller.fail()` sets stage `error`: the page shows `Playback stopped (networkError fragLoadError).` and nothing more happens.
6. **Buffer** — `hlsEngine.ts:20`: `new Hls({ startPosition, maxMaxBufferLength: 30 })`.
7. **Position reports** — `controller.report()` → `POST /api/stream/sessions/:id/position` every 5 s → `MovieStreams.recordPosition` (one `movie_plays` row per session) and `StreamLive` (in memory).
8. **Refresh** — `POST /api/stream/sessions/:id/refresh` → `service.refresh()` resolves again and `replaceSource` keeps the id.

### Data Persistence

**Database:** `movie_plays` (position), `movie_stream_sources` (verified source per title and host), `stream_provider_health` (per provider and host). No table knows about bytes on disk for a stream.
**Memory:** `SessionStore` (32 sessions, 4 h idle, 24 h max), `StreamLive`.
**Disk:** nothing from direct streaming. The VLC side keeps `<dataDir>/movies/vlc-health-<host>.jsonl` through `HealthLog`.

### Exit Points

- The page's state on `window.notesdStream` (`stage`, `errors`, `log` capped at 20 lines, `refreshes`) — read only by scripts that drive the page.
- Daemon log lines: `resolved by`, `did not resolve`, `playing`, episode switch.

### The tmux spawn that exists

`src/sessions/resume.ts`: `resumeNode()` picks the tmux session (`pickTmuxSession`), builds `claudeCommand(claudeBin, args, env)` and opens a window with `openClaudeWindow()` (private), shows it on the most recent client. `ResumeDeps` carries `run`, `tmuxBin`, `tmuxSocket`, `claudeBin`; `defaultResumeDeps()` reads `NOTESD_TMUX_BIN`, `NOTESD_TMUX_SOCKET`, `NOTESD_CLAUDE_BIN`. Errors: 409 `no_tmux`, 500 `spawn_failed`. A prompt is passed as claude's argument (`promptArgs`).

### The skill this one is modelled on

`claude/skills/trace-vlc-bug`: `trace.sh` collects into `~/mcp-notes-data/movies/vlc-traces/<stamp>/`, `SKILL.md` has "Collect", "Match the evidence" (a table of signature → cause → where proven), "What is known about this machine", and saving the finding as a note. `scripts/install.sh` symlinks each folder under `claude/skills` into `~/.claude/skills`.

---

## Key Data Structures

### `StreamSession` — `src/directStream/sessions.ts:15`
`id`, `ref` (`StreamRef`: movie tmdbId, or tv tmdbId + season + episode), `source` (`ResolvedSource`: `provider`, `manifest_url`, `manifest_kind`, `headers`, `subtitles`, `audio`, `best_height`), `attempts`, `allowedHosts`, `resumeS`, `audioLang`, timestamps. Used by `service.ts`, `passThrough.ts`, `directStreamApi.ts`, `movies/streams.ts`.

### `SessionInfo` — `src/directStream/service.ts:89`
What the page reads; mirrored by `StreamSession` in `web/src/stream/session.ts:15` (`parseSession`).

### `StreamState` — `web/src/stream/controller.ts:21`
`stage` (`loading | ready | refreshing | error`), `error`, `errors[]`, `log[]`, `refreshes`, qualities, subtitles.

### `EngineHandlers` — `web/src/stream/engine.ts:21`
`onReady`, `onAuthError`, `onSessionOver`, `onFatal`.

### `HealthLog` — `src/movies/vlc/health.ts:251`
`append(record)` (rotate at `maxBytes`, repair a torn last line, fsync), `readTail(maxBytes)`.

---

## Dependencies

### Configuration / Environment
`NOTESD_DIRECT_STREAM`, `NOTESD_MOVIES`, `NOTES_DATA_DIR`, `NOTESD_CLAUDE_BIN`, `NOTESD_TMUX_BIN`, `NOTESD_TMUX_SOCKET`. Every variable has a row in `docs/guide/reference/configuration.md` and `docs:check` fails on one that has none.

### External
Stream hosts (through `fetch`, injectable as `FetchLike`), the streaming Chrome (through `DirectStreamRunner`, injectable), tmux and the claude binary (through `CommandRunner`, injectable), hls.js / dash.js in the page.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `forward` | `src/directStream/passThrough.ts:84` | def | directStream |
| `forward` | `src/directStream/service.ts:294`, `:313` | call | directStream |
| `DirectStreamService.passThrough` | `src/http/directStreamApi.ts:107` | call | http |
| `SessionStore`, `StreamSession` | `src/directStream/sessions.ts` | def | directStream |
| `SessionInfo`, `sessionInfo()` | `src/directStream/service.ts:89` | def | directStream |
| `parseSession` | `web/src/stream/session.ts:78` | def | web/stream |
| `maxMaxBufferLength: 30` | `web/src/stream/hlsEngine.ts:20` | config | web/stream |
| `handlers.onFatal` | `web/src/stream/hlsEngine.ts:47`, `dashEngine.ts`, `nativeEngine.ts` | call | web/stream |
| `StreamController.fail`, `.note` | `web/src/stream/controller.ts:271`, `:267` | def | web/stream |
| `StageOverlay` (error) | `web/src/stream/StreamApp.tsx:230` | def | web/stream |
| `window.notesdStream` | `web/src/stream/StreamApp.tsx` | def | web/stream |
| J3 expiry check | `claude/streaming/direct/playcheck.mjs`, `player.steps.mjs` | test | streaming |
| `openClaudeWindow`, `claudeCommand`, `pickTmuxSession`, `tmuxGlobalPath` | `src/sessions/resume.ts:521`, `:241`, `:340`, `:364` | def | sessions |
| `HealthLog` | `src/movies/vlc/health.ts:251` | def | movies |
| `buildDirectStreamService` | `src/directStream/service.ts:545` | def | directStream |
| `AppDeps.directStream` | `src/deps.ts` | def | root |
| `directStreamRoutes` | `src/http/directStreamApi.ts:68` | def | http |
| route descriptions | `scripts/docs/httpRoutes.ts` | doc | docs tooling |
| direct streaming guide | `docs/guide/streaming.md:299` | doc | docs |
| feature map | `.claude/skills/verify-notesd/features/direct-streaming.md` | doc | verify |

---

## Impact Points (files that WILL need changes)

1. `src/directStream/passThrough.ts`, `service.ts` — record each forwarded answer (phase 1)
2. new `src/directStream/evidence.ts` (log + snapshot), new routes for player events and snapshot (phase 1)
3. `web/src/stream/controller.ts`, `session.ts` — post the page's log (phase 1)
4. `web/src/stream/hlsEngine.ts`, `engine.ts`, `dashEngine.ts`, `controller.ts`, `StreamApp.tsx` — network recovery, buffer (phase 2)
5. new `claude/skills/report-stream-bug/` (phase 3)
6. new `src/directStream/report.ts` + route, `src/sessions/resume.ts` (export the window opener), `StreamApp.tsx`, `controller.ts`, `session.ts`, `stream.css` (phase 4)
7. `src/db/schema.ts` + migration `0029`, `src/directStream/repo.ts`, new `src/directStream/cache/*`, new cache routes, MCP tool, config (phase 5)
8. `src/directStream/service.ts` (`play`, `sessionInfo`), `web/src/stream/session.ts`, engines, `claude/skills/direct-stream/SKILL.md`, MCP play tool text (phase 6)
9. Every phase: `scripts/docs/httpRoutes.ts` + `npm run docs:gen`, `docs/guide/streaming.md`, `docs/guide/reference/configuration.md` for a new variable, `.claude/skills/verify-notesd/features/direct-streaming.md`, `src/deps.ts` / `src/daemon.ts` wiring

**This document describes. The plan files prescribe.**
