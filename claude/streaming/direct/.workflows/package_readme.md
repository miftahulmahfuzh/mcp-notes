# Package: claude/streaming/direct

**Location**: `claude/streaming/direct`
**Last Updated**: 2026-11-15 (P1-NOTES-A116, phase 6 of direct streaming)
**Language**: Node ESM scripts (`.mjs`) plus one PowerShell script (`sniff.ps1`). No `package.json`; modules import each other and `../chrome.mjs` by relative path.

## Overview

The direct-streaming resolver and its probe tooling. For a TMDB film or episode it opens provider embed pages in the streaming Chrome on Windows (out of sight, muted), captures the stream the page loads (HLS or DASH manifest, request headers, subtitle tracks) and hands it to the notesd daemon, which plays it in its own `/stream/<id>` player page. Around that resolver sit two offline-to-live probe tools: `campaign.mjs` (resolve campaign, phase 2) and `playcheck.mjs` + `playgate.mjs` (playback campaign, phase 6), both of which write generated blocks into `docs/plans/2026-11-15-direct-streaming-findings.md`.

**Key Responsibilities:**
- Order providers (English subtitle first, then health, quality, speed) and try them until one yields a stream (`order.mjs`, `resolve.mjs`).
- Sniff one embed in a background Chrome tab through PowerShell/CDP, never audible, never a disguised client, never clicking past a bot check (`sniff.mjs`, `sniff.ps1`).
- Be the CLI the daemon runs (`NOTESD_DIRECT_STREAM_CLI`, default `cli.mjs`): `resolve`, `providers`, `open`.
- Hold the provider registry data: `providers.seed.json` (loaded into `stream_providers` at every daemon start) and `known-titles.json` (control film, recent film, series episode).
- Measure providers: resolve outcomes, failure causes, episode templates and token lifetime (`campaign.mjs`); real playback through the daemon's player for the `play`, `dash`, `vidnest`, `subtitle` and `expiry` checks (`playcheck.mjs`).

## Exported API

### cli.mjs (the daemon's resolver)

Commands, each printing one JSON object; exit 0 ok, 1 not ok, 2 usage/input error:
- `resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>]` - the `resolveTitle` result.
- `providers [--providers <file>] [--health <file>]` - the seed in resolve order, each with its health.
- `open <http://localhost:<port>/...> [--fullscreen]` - opens a daemon page in the streaming Chrome; with `--fullscreen` on a `/stream/` page it then evaluates `START_EXPRESSION` (up to `START_TRIES` x `START_WAIT_MS`) so the film starts with sound under a user gesture.

Exports: `SEED_PATH`, `USAGE`, `START_EXPRESSION`, `START_TRIES` (30), `START_WAIT_MS` (500), `InputError` (`code`: `usage`, `bad_providers`, `bad_health`), `parseArgs(argv)`, `readProviders(text)`, `readHealth(text)`, `wantsStart(url, fullscreen)`, `openInChrome(url, { fullscreen }, deps)`, `main(argv, io)` (io injects `sniff`, `open`, `readText`, `print`).

### resolve.mjs

```js
resolveTitle(ref, { providers, health = {}, sniff, only = null, sniffOptions, clock, deadlineS = null })
  -> { ok, kind, tmdb_id, season, episode, source | null, error?, detail?, attempts: [{ provider, outcome, took_s, detail }] }
```
- `ref`: `{ kind: 'movie'|'tv', tmdbId, season?, episode? }`, already validated.
- `source` on success: `{ provider, embed_url, manifest_url, manifest_kind: 'hls'|'dash'|..., headers: { referer, origin, user_agent }, subtitles, best_height, en_subtitle, took_s }`.
- Errors: `unknown_provider` (bad `only`), `deadline`, `no_chrome` / `chrome_not_reachable` (abort the whole resolve), `no_source`.
- Skips `browser_only` providers and providers with no template for the kind without sniffing.

Also: `OUTCOMES` (`resolved`, `no_stream`, `bot_check`, `error`, `skipped_browser_only`, `skipped_no_template`), `embedUrl(provider, ref)` (fills `{id}`, `{season}`, `{episode}`), `manifestKind(hit)`, `isEnglish(track)`, `pickSource(sniff)` (best manifest of one capture, with in-manifest and request-seen subtitles).

### order.mjs

- `orderProviders(providers, health = {})` - stable sort by `[englishTier, healthRank, -best_height, median_s, index]`. Drops nothing.
- `englishTier(provider, health)` - 0 English subtitle known, 1 unknown, 2 none; measured beats seed.
- `healthRank(health)` - 0 last success, 1 no verdict, 2+ consecutive failures (capped at 10).

### sniff.mjs

- `sniffEmbed(url, options)` - runs `sniff.ps1` through `powershell.exe` (absolute Windows path, since the systemd daemon lacks it on PATH) and returns the parsed capture `{ hits, requests, clicks, popups_closed, bot_check, bot_check_reason, user_agent, ... }`. Throws `ChromeError`.
- `SNIFF_DEFAULTS` (`seconds: 35, linger: 4, botGraceS: 5, port: 9333`), `MUTE_SCRIPT` (installed in the tab and every frame before page scripts; forces `muted` and suspends Web Audio), `MEDIA_EXPRESSION`, `parseSniffReply(stdout)`.
- CLI: `sniff.mjs <embed url> [--seconds n]` for diagnosis.

### campaign.mjs (resolve probe campaign)

Commands `run`, `lifetime`, `lifetime-status`, `report`, `apply-seed`, `check`. Resolving only; nothing is shown or heard. Key exports: `SEED_FILE`, `FINDINGS_FILE`, `KNOWN_TITLES_FILE`, `loadTitles`, `TITLES`, `CAUSES`, `LIFETIME_SCHEDULE_MIN`, `CampaignAbort`, `diagnose`, `episodeTemplates`, `runCampaign`, `watchLifetime`, `lifetimeReport`, `timings`, `renderFindings`, `applySeed`, `checkFindings`, `replaceBlock`, `readBlock`, `main(command, argv, io)`. Lifetime state lives under `~/.local/state/notesd-direct-campaign`.

### playcheck.mjs (playback probe, phase 6)

For one provider and one title: asks a **throwaway** daemon for a stream session (`POST /api/stream/play`), reads the session (`GET /api/stream/sessions/<id>`), inspects the manifest and first segment through the daemon's pass-through, opens `/stream/<id>?muted=1` in the streaming Chrome in a NORMAL window (never full screen, never with sound), samples the `<video>` every `SAMPLE_MS`, then pauses it.

```
playcheck.mjs setup --dir <state dir> [--gate-port 47399]
playcheck.mjs run --daemon http://127.0.0.1:<port> --dir <state dir>
     --check play|dash|vidnest|subtitle|expiry --provider <seed name> movie|tv <tmdbId> [season episode]
     [--watch-s 15] [--timeout-s 90] [--expire-after-s 45] [--gate-port 47399] [--host 127.0.0.1|localhost]
playcheck.mjs findings --dir <state dir> --file <findings.md>
playcheck.mjs audit --file <findings.md> --seed <providers.seed.json>
```
- `setup` writes `<dir>/cli.mjs` (a wrapper calling `playgate.wrapperMain`), `next.json`, `opened.jsonl`, and returns the env for the daemon: `NOTESD_DIRECT_STREAM=on`, `NOTESD_DIRECT_STREAM_CLI=<dir>/cli.mjs`.
- `run` appends one report to `<dir>/results.jsonl` and prints it.
- `findings` replaces the `<!-- playcheck:begin -->...<!-- playcheck:end -->` block under `## Playback` (latest result per check/provider, with run counts and a machine-readable `playcheck:rows` comment).
- `audit` lists what R7.3 still lacks: a decided row per `dash`, `vidnest`, `subtitle`, `expiry`; every `browser_only` provider marked so in the seed; every `needs_fix` row present in the findings' Fixes table as `| <check>/<provider> |`.

Verdicts (`decide(check, report)`):
- `inconclusive` - could not look (Chrome, tab, daemon, session, stopped for sound or full screen), the check did not apply (DASH check served HLS, no English offered), or expiry never reached. Decides nothing.
- `no_source` - the provider did not resolve this time (counts as decided after `NO_SOURCE_ATTEMPTS` = 3 runs).
- `plays` - advanced `MIN_ADVANCE_S` (10 s) at a real height and still playing; `subtitle` also needs an English track `showing` with cues; `expiry` needs the first source refused, a second resolve served, and playback continuing within `RESUME_TOLERANCE_S` (10 s) of where it stopped.
- `browser_only` - did not play and `browserOnlyCause` names `drm`, `encrypted_segments` or `obfuscated_segments` (segment head not ts/id3/fmp4/aac, e.g. a disguised PNG/JPEG/GIF).
- `needs_fix` - did not play (or subtitle/refresh failed) without such a cause: the fault is assumed ours.

Exports: `CHECKS`, `MIN_ADVANCE_S`, `RESUME_TOLERANCE_S`, `SAMPLE_MS` (1500), `DEFAULT_GATE_PORT` (47399), `RESULTS_FILE`, `BLOCK_BEGIN`, `BLOCK_END`, `GUARD_EXPRESSION`, `STATE_EXPRESSION` (reads video state plus `window.notesdStream` kind/levels/errors/refreshes), `PAUSE_EXPRESSION`, `navigateExpression(url)`, `classifyManifest(text, kind)`, `segmentFormat(bytes)`, `inspectStream(deps, manifestUrl, kind)`, `isEnglish`, `browserOnlyCause`, `summarize(samples, t0)`, `decide`, `runCheck(opts, deps)`, `renderBlock`, `replaceBlock`, `auditFindings`, `setup`, `parseRunArgs`, `main(argv)`.

### playgate.mjs (helpers the throwaway daemon runs)

- `wrapperMain(config, argv, deps)` - the resolver CLI a playcheck daemon runs in place of `cli.mjs`. `open` is recorded to `opened.jsonl` and never performed (no screen, no sound); `resolve` is pinned to the provider in `next.json` (`withOnly`); when a gate answers, an HLS source's `manifest_url` is rewritten through it (`gateSource`). Other commands pass through to the real CLI.
- `startGate({ port, expireAfterS, now, fetchImpl })` -> `{ url, stats(), close() }` - loopback pass-through on 127.0.0.1. `POST /register` mints a token per source; `GET /g/<token>?u=<url>` fetches with the captured referer/origin/user-agent (and the client's range) and rewrites HLS playlists to come back through itself. The **first** registered token answers 410 `expired_by_playcheck` once older than `expireAfterS`, imitating a stream token running out; later tokens never expire, so the daemon's refresh can continue. `GET /stats` returns per-token `served`/`refused`.
- Also `OPENED_FILE`, `NEXT_FILE`, `gateUrl`, `rewriteHlsPlaylist(text, base, through)`, `withOnly(args, only)`, `gateSource(gate, source, fetchImpl)`.

## Internal Architecture

### Data Flow

Daemon play request -> `src/directStream/runner.ts` spawns `node cli.mjs resolve ...` with the stored health -> `orderProviders` -> per provider `embedUrl` -> `sniffEmbed` (PowerShell `sniff.ps1` opens a background, muted tab over CDP on port 9333, records manifests, media, subtitles and their request headers) -> `pickSource` -> first stream wins -> JSON source back to the daemon, which records health and creates a stream session -> daemon runs `cli.mjs open http://localhost:<port>/stream/<id> --fullscreen` -> player page starts via `window.notesdStream.start()`.

Playback probe: `playcheck run` -> throwaway daemon's `/api/stream/play` -> daemon runs `<dir>/cli.mjs` (= `wrapperMain`) -> real `cli.mjs resolve --only <provider>` -> optionally gated source -> `open` only recorded -> playcheck reads `opened.jsonl` for the session id, navigates the streaming Chrome itself, muted and windowed, and samples.

### Key internal pieces
- `sniff.ps1` - the Windows half (WSL cannot reach Windows loopback). Background tab, minimized Chrome when it has to start one, `-Inspect` for read-only page diagnosis, stops clicking once a bot check is seen.
- `watch` / `watchExpiry` in playcheck - sampling loops with safety stops (`not_muted`, `went_full_screen`); expiry runs phase A until token 1 is refused, phase B until token 2 serves and playback moves past the stop point.

## Dependencies

### External Packages
None. Node built-ins only.

### Internal
- `../chrome.mjs` - `ChromeError`, `evaluateInChrome`, `sleep` (streaming Chrome over `cdp.ps1`, its own profile).
- Daemon HTTP API (playcheck only): `/api/stream/play`, `/api/stream/sessions/<id>`, the session's manifest pass-through, `/stream/<id>?muted=1`.

### Standard Library
`node:fs`, `node:fs/promises`, `node:path`, `node:url`, `node:util` (`parseArgs`, `promisify`), `node:child_process` (`execFile` for PowerShell and the wrapped CLI), `node:http` (gate server), `node:stream` (`Readable.fromWeb`), `node:crypto` (gate tokens), `node:os`.

## Reverse Dependencies

### Primary Consumers
- `src/directStream/runner.ts` - spawns `cli.mjs` (path from `NOTESD_DIRECT_STREAM_CLI`, default in `src/config.ts`) and parses its JSON; `src/directStream/types.ts` mirrors its outcomes.
- `src/directStream/repo.ts` - loads and checks `providers.seed.json` into `stream_providers` at every start.
- `web/src/stream/controller.ts` - not an importer, but the player page the resolver's source feeds; it exposes `window.notesdStream` (read by `START_EXPRESSION` and playcheck's `STATE_EXPRESSION`).

### Test and tooling consumers
- `tests/unit/scripts/directResolve.test.ts` - cli, order, resolve, sniff (including `sniff.ps1` text checks).
- `tests/unit/scripts/directCampaign.test.ts` - campaign.
- `tests/unit/scripts/playcheck.test.ts` - playcheck and playgate (fake deps, real loopback gate).
- `tests/fixtures/direct-stream/fake-cli.mjs` - stands in for `cli.mjs` in tests and `verify.sh up --direct-stream`.
- `.claude/skills/verify-notesd` (features `streaming.md`, `direct-streaming.md`, `scripts/direct-stream/journey.sh`).

## Concurrency

Single-run scripts; one resolve tries providers sequentially. The gate is one `http.Server` handling requests concurrently with per-token counters in a `Map` (single-threaded event loop, no locks). Not designed for several resolves or playchecks sharing one streaming Chrome at once.

## Error Handling

- `InputError` (cli: exit 2 with `{ ok: false, error, detail }`), `UsageError` (playcheck, unexported), `CampaignAbort` (campaign).
- `ChromeError` from `../chrome.mjs`; `no_chrome` / `chrome_not_reachable` abort a resolve, any other sniff error is recorded as that provider's `error` outcome and the next provider is tried.
- playcheck never throws out of `runCheck`: every failure becomes `report.error` + an `inconclusive` verdict; the page is always paused and the gate closed in `finally`.
- Gate: unknown token 404, expired first token 410, upstream failure 502 `gate_fetch_failed`.

## Performance

- A resolve costs 3 to 40 s live (`sniff` default 35 s window per provider plus 4 s linger); `--deadline-s` caps it.
- playcheck runs take `--timeout-s` (90 s default) per check, `expiry` up to `expire-after-s + 90 + 120` s.
- `fetchHead` reads only the first 512 bytes of a segment.

## Usage

### Gotchas
- Never give a throwaway daemon the real `cli.mjs`: it opens tabs in the owner's streaming Chrome. Use `playcheck.mjs setup`'s wrapper (records `open`) or the test fake.
- `playcheck run` refuses the live daemon port 7317 and only accepts `http://127.0.0.1|localhost:<port>`.
- `playcheck` brings the streaming Chrome to the front in a normal window, muted; tell the owner before running it. It aborts with `foreign_tab_playing` if another origin is playing in that Chrome.
- `--check vidnest` requires `--provider VidNest`; `--check dash` is inconclusive when the provider served HLS.
- The gate only wraps HLS sources; DASH sources pass through unchanged, so `expiry` is an HLS check.
- Never stored or forged: the user agent and headers are Chrome's own, only read and replayed.
- A new provider is a seed row, not code. `browser_only: true` in the seed must match a `browser_only` playcheck verdict (`audit` enforces it).

## Notes

- Phase 6 playback results (2026-11-15, findings `## Playback`): `play`/VidFast, `dash`/VidLink, `vidnest`/VidNest and `subtitle` (HyperLink, NexaStream) all `plays`; see the findings file for `expiry` and the full table.
- The same phase made the web player retry a failed subtitle file fetch once (`web/src/stream/controller.ts`, `loadFileSubtitles`), so one flaky stream host no longer drops the English track for the whole film.
- User-facing behaviour is described in `docs/guide/streaming.md`; this file is the package-level map only.

Documentation Created: 2026-11-15
