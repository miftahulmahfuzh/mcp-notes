# Package: claude/streaming/direct

**Location**: `claude/streaming/direct`
**Last Updated**: 2026-11-15 (P1-NOTES-A116, phase 6 of direct streaming)
**Language**: Node ESM scripts (`.mjs`) plus one PowerShell script (`sniff.ps1`). No `package.json`; modules import each other and `../chrome.mjs` by relative path.

## Overview


**Key Responsibilities:**
- Order providers (English subtitle first, then health, quality, speed) and try them until one yields a stream (`order.mjs`, `resolve.mjs`).
- Sniff one embed in a background Chrome tab through PowerShell/CDP, never audible, never a disguised client, never clicking past a bot check (`sniff.mjs`, `sniff.ps1`).
- Be the CLI the daemon runs (`NOTESD_DIRECT_STREAM_CLI`, default `cli.mjs`): `resolve`, `providers`, `open`.
- Hold the provider registry data: `providers.seed.json` (loaded into `stream_providers` at every daemon start) and `known-titles.json` (control film, recent film, series episode).

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

## Internal Architecture

### Data Flow

Daemon play request -> `src/directStream/runner.ts` spawns `node cli.mjs resolve ...` with the stored health -> `orderProviders` -> per provider `embedUrl` -> `sniffEmbed` (PowerShell `sniff.ps1` opens a background, muted tab over CDP on port 9333, records manifests, media, subtitles and their request headers) -> `pickSource` -> first stream wins -> JSON source back to the daemon, which records health and creates a stream session -> daemon runs `cli.mjs open http://localhost:<port>/stream/<id> --fullscreen` -> player page starts via `window.notesdStream.start()`.


### Key internal pieces
- `sniff.ps1` - the Windows half (WSL cannot reach Windows loopback). Background tab, minimized Chrome when it has to start one, `-Inspect` for read-only page diagnosis, stops clicking once a bot check is seen.

## Dependencies

### External Packages
None. Node built-ins only.

### Internal
- `../chrome.mjs` - `ChromeError`, `evaluateInChrome`, `sleep` (streaming Chrome over `cdp.ps1`, its own profile).

### Standard Library
`node:fs`, `node:fs/promises`, `node:path`, `node:url`, `node:util` (`parseArgs`, `promisify`), `node:child_process` (`execFile` for PowerShell and the wrapped CLI), `node:http` (gate server), `node:stream` (`Readable.fromWeb`), `node:crypto` (gate tokens), `node:os`.

## Reverse Dependencies

### Primary Consumers
- `src/directStream/runner.ts` - spawns `cli.mjs` (path from `NOTESD_DIRECT_STREAM_CLI`, default in `src/config.ts`) and parses its JSON; `src/directStream/types.ts` mirrors its outcomes.
- `src/directStream/repo.ts` - loads and checks `providers.seed.json` into `stream_providers` at every start.

### Test and tooling consumers
- `tests/unit/scripts/directResolve.test.ts` - cli, order, resolve, sniff (including `sniff.ps1` text checks).
- `tests/fixtures/direct-stream/fake-cli.mjs` - stands in for `cli.mjs` in tests and `verify.sh up --direct-stream`.
- `.claude/skills/verify-notesd` (features `streaming.md`, `direct-streaming.md`, `scripts/direct-stream/journey.sh`).

## Concurrency


## Error Handling

- `ChromeError` from `../chrome.mjs`; `no_chrome` / `chrome_not_reachable` abort a resolve, any other sniff error is recorded as that provider's `error` outcome and the next provider is tried.
- Gate: unknown token 404, expired first token 410, upstream failure 502 `gate_fetch_failed`.

## Performance

- A resolve costs 3 to 40 s live (`sniff` default 35 s window per provider plus 4 s linger); `--deadline-s` caps it.
- `fetchHead` reads only the first 512 bytes of a segment.

## Usage

### Gotchas
- `--check vidnest` requires `--provider VidNest`; `--check dash` is inconclusive when the provider served HLS.
- The gate only wraps HLS sources; DASH sources pass through unchanged, so `expiry` is an HLS check.
- Never stored or forged: the user agent and headers are Chrome's own, only read and replayed.

## Notes

- Phase 6 playback results (2026-11-15, findings `## Playback`): `play`/VidFast, `dash`/VidLink, `vidnest`/VidNest and `subtitle` (HyperLink, NexaStream) all `plays`; see the findings file for `expiry` and the full table.
- The same phase made the web player retry a failed subtitle file fetch once (`web/src/stream/controller.ts`, `loadFileSubtitles`), so one flaky stream host no longer drops the English track for the whole film.
- User-facing behaviour is described in `docs/guide/streaming.md`; this file is the package-level map only.

Documentation Created: 2026-11-15
