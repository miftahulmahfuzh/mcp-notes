# Plan: Direct streaming

**Slug:** direct-streaming
**Date:** 2026-11-15 18:29 WIB
**Analysis:** `.workflows/analyze/20261115-182932-Z85Y_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/direct-streaming`
**Branch:** `feature/direct-streaming` (base: `origin/main` @ `d996abb`)
**Phases:** 10
**Status:** all 10 phases complete (1-10)
**Coordinator:** orch-direct-streaming

---

## Why

From the brief, `docs/plans/2026-11-15-direct-streaming-design.md` (read it in full; the spike is in
`docs/plans/direct-streaming-spike/`). The owner's words:

> i kept thinking, what if we try to reverse-engineer what's inside idlix or lk21, because i am
> sure these streaming sites basically just an aggregator that fetch streaming data from
> somewhere. can we cut through the loops and stream DIRECTLY from our local laptop here.
>
> running "/idlix" honestly doesn't feel perfect yet. i have to watch around 30s of ads in total
> before the movie streaming starts. besides if we can achieve direct streaming (we implement the
> aggregator from our side without relying on these sites), it will be faster, simpler, and much
> much more customizable.

> what if we provide 2 major sources there: 1. the ones that you sync from my local directories
> (my downloaded ones) 2. the ones that you can FOR SURE provide through our new direct streaming
> architecture
>
> maybe we add one more button at the top, to change the page to streaming homepage (i would
> prefer we dont add one more buttons in the sidepanel though, because i think this direct
> streaming and movies are kinda similar in UI/UX). opening this page, mcp-notes will provide me
> with similar grid collections where i can directly click and play the movies / series' episode.
>
> each of the item there is GUARANTEED to be able to be fetched from one of our streaming sources
> (i just don't want mcp-notes recommending something that can't be streamed)

> i just want to click the play button, and see the fullscreen in which the movie starts playing

> english subtitle is very important to me. worst case scenario is that we can get a direct cloud
> source, but this source can't provide subtitle, well, i can accept it, but maybe prioritize the
> cloud source that has subtitle? just english subtitle is enough

> we need to really build this as clean and robust as possible. no need to rush.

The end state, from Claude Code:

```text
/direct-stream saltburn
this is a LOTR night. let's /direct-stream the first one
/update-cloud-source https://ww6-fmovies.com/
```

The request that started this plan:

> Plan the direct streaming feature from the design brief [...]. D1-D4 are the owner's and binding
> (English subtitle sources first; one click to a full-screen film; Stream is a switch at the top
> of /movies, not a side-panel entry; the Stream grid shows only verified titles). D5 and D6 are
> proposed and not yet confirmed by the owner: plan them as late phases behind a setting, and list
> them as the owner's to confirm. Follow D7 for build order: resolver, provider registry, daemon
> proxy and player page, and the /direct-stream and /update-cloud-source skills first; the Stream
> page and background prober after. The brief's untested list (token lifetime, DASH and VidNest
> playback, series episodes, subtitles in our player, the other 18 providers, why three providers
> returned nothing) should become explicit early work, not assumptions.

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | "Follow D7 for build order: resolver, provider registry, [...] first" with "D1-D4 are the owner's and binding (English subtitle sources first; [...])" | 1, 3 |
| R2 | "daemon proxy and player page" with "one click to a full-screen film" | 3, 4, 5 |
| R3 | "the /direct-stream [...] skills first" | 7 |
| R4 | "and /update-cloud-source skills first" | 8 |
| R5 | "the Stream page [...] after" with "Stream is a switch at the top of /movies, not a side-panel entry; the Stream grid shows only verified titles" | 5, 9 |
| R6 | "background prober after" with "D5 and D6 are proposed and not yet confirmed by the owner: plan them as late phases behind a setting, and list them as the owner's to confirm" | 10 |
| R7 | "The brief's untested list (token lifetime, DASH and VidNest playback, series episodes, subtitles in our player, the other 18 providers, why three providers returned nothing) should become explicit early work, not assumptions." | 2, 6 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN `node claude/streaming/direct/cli.mjs resolve <movie or tv> <tmdb id> [season episode]` is run THE SYSTEM SHALL print one JSON object naming the provider that resolved, the manifest address and kind, the request headers the manifest request carried, and the subtitle tracks seen | 1 | P1.J1, P1.J3, P1.J4 |
| R1.2 | ubiquitous | THE SYSTEM SHALL try providers known to offer an English subtitle before those that do not, then by health, then by best quality | 1 | P1.J1, P1.J2 |
| R1.3 | unwanted | IF a provider's embed answers with a bot check THEN THE SYSTEM SHALL skip that provider, record `bot_check` as its outcome, and try the next one without changing the client | 1 | P1.J1, P1.J3 |
| R1.4 | ubiquitous | THE SYSTEM SHALL keep providers as data (a checked-in seed file loaded into a shared table) with health recorded per host | 3 | P3.J1, P3.J2 |
| R2.1 | event | WHEN the player requests a playlist through the daemon's stream route THE SYSTEM SHALL fetch it with the headers the resolve captured and rewrite every address in it to come back through the route | 3 | P3.J3, P3.J4 |
| R2.2 | unwanted | IF a stream-route request names a session that is unknown or expired, or a host that session's resolve did not return, THEN THE SYSTEM SHALL answer 403 and fetch nothing | 3 | P3.J5, P3.J6 |
| R2.3 | event | WHEN the player page opens for a resolved session THE SYSTEM SHALL play the stream with the English subtitle shown by default when one exists and offer a quality choice | 4 | P4.J1, P4.J2, P4.J4 |
| R2.4 | event | WHEN the player page reports a position THE SYSTEM SHALL record it on one `movie_plays` row for that play so the title's watch state derives from it as it does from a VLC play | 5 | P5.J1, P5.J2 |
| R2.5 | unwanted | IF the stream route answers 401, 403 or 410 from the stream host mid-film THEN THE SYSTEM SHALL resolve again and continue from the last position | 4 | P4.J3, P4.J4 |
| R2.6 | state | WHILE `NOTESD_MOVIES=off`, `NOTESD_DIRECT_STREAM=off` or `deps.directStream` is unset THE SYSTEM SHALL answer `direct_stream_off` on every direct-stream route and tool and start no Chrome | 3 | P3.J7, P3.J8 |
| R3.1 | event | WHEN the owner types `/direct-stream <title>` and exactly one film matches THE SYSTEM SHALL resolve it and open the player page full screen in the streaming Chrome | 7 | P7.J1, P7.J2, P7.J5 |
| R3.2 | unwanted | IF several titles match, or the title is a series and no episode can be chosen, THEN THE SYSTEM SHALL list the candidates and start nothing | 7 | P7.J2, P7.J3, P7.J5 |
| R3.3 | unwanted | IF no provider resolves the title THEN THE SYSTEM SHALL answer `no_source` with each provider's outcome and start nothing | 7 | P7.J4 |
| R4.1 | event | WHEN the owner types `/update-cloud-source <site url>` THE SYSTEM SHALL read the site's provider templates, add the ones the registry lacks, probe each new one against the known titles and report the outcome per provider | 8 | P8.J1, P8.J2, P8.J3, P8.J6 |
| R4.2 | unwanted | IF the site's templates cannot be read THEN THE SYSTEM SHALL say so and leave the registry unchanged | 8 | P8.J4, P8.J5 |
| R5.1 | event | WHEN the owner presses the Stream side of the switch at the top of `/movies` THE SYSTEM SHALL show the Stream grid in the same page, with no new entry in the rail or sidebar | 9 | P9.J1, P9.J6 |
| R5.2 | ubiquitous | THE SYSTEM SHALL list on the Stream grid only titles with a source verified on this host inside the freshness window | 9 | P9.J2, P9.J6 |
| R5.3 | event | WHEN Play is pressed on a title opened from the Stream grid THE SYSTEM SHALL start the stream player full screen with no further click | 9 | P9.J3, P9.J6 |
| R5.4 | unwanted | IF a Stream title fails to resolve when Play is pressed THEN THE SYSTEM SHALL mark its source stale and the title SHALL leave the Stream grid | 5, 9 | P5.J3, P9.J4, P9.J6 |
| R5.5 | optional | WHERE a title has both a file on this host and a verified stream THE SYSTEM SHALL play the local file by default | 9 | P9.J5, P9.J6 |
| R6.1 | optional | WHERE `NOTESD_STREAM_PROBER=on` THE SYSTEM SHALL turn TMDB candidates into verified titles up to the catalog size and re-check each inside the freshness window, within its per-pass budget | 10 | P10.J4, P10.J5, P10.J6 |
| R6.2 | state | WHILE `NOTESD_STREAM_PROBER` is unset or `off` THE SYSTEM SHALL open no Chrome tab that was not asked for | 10 | P10.J1, P10.J2 |
| R6.3 | complex | WHERE `NOTESD_STREAM_PROBER=on` WHILE the laptop is not idle THE SYSTEM SHALL start no probe | 10 | P10.J3, P10.J4 |
| R7.1 | event | WHEN the probe campaign command is run THE SYSTEM SHALL write, for each of the 24 seed providers, either what it resolved (manifest kind, best quality, English subtitle, seconds) or the named cause of the failure | 2 | P2.J1, P2.J2, P2.J3 |
| R7.2 | ubiquitous | THE SYSTEM SHALL record in the findings file the measured token lifetime and the episode template of every provider that resolves a series episode | 2 | P2.J1, P2.J2, P2.J4, P2.J5 |
| R7.3 | ubiquitous | THE SYSTEM SHALL record in the findings file, for DASH playback, VidNest playback and subtitles in our player, whether each plays in the daemon's player page, and mark a provider that does not as `browser_only` in the seed | 6 | P6.J1, P6.J2, P6.J3, P6.J4 |

## Scope

**In scope:** the provider seed and registry, the resolver, the daemon pass-through and sessions,
the player page, stream plays and verified sources in the movies store, `/direct-stream` and
`/update-cloud-source` with their MCP tools, the Library / Stream switch and Stream grid on
`/movies`, the background prober behind a default-off setting, two live probe campaigns that
settle the brief's untested list, and the guides, reference docs, README line and feature-map
entries that go with each.

**Out of scope** (the brief): downloading streams to disk, casting, provider accounts, anything
that defeats a bot check or DRM, and removing `/idlix` and `/lk21`. Also not built here: fetching
English subtitles from a subtitle service when no provider has one (see Decisions), the
Chrome-frames template reader for sites whose scripts hold no template, and edits to `CLAUDE.md`
(see Follow-ups for the owner).

## Invariants

1. The tree builds and `npm run typecheck`, `npm test` and `npm run docs:check` pass at the end of
   every phase. A phase that adds a route, tool or env var updates `scripts/docs/httpRoutes.ts` /
   `docs/guide/reference/configuration.md` and runs `npm run docs:gen` in the same phase.
2. Chrome is driven only through the `notesd-stream-chrome` profile on port 9333, from PowerShell.
   Never the owner's everyday Chrome, never a Chrome notesd did not start, never a disguised client
   to get past a bot check. A bot check is an outcome (`bot_check`), not an obstacle.
3. The pass-through forwards only to hosts a live session's resolve returned, and sends the
   headers the real Chrome's request carried (`Referer`, `Origin`, `User-Agent`), nothing invented.
4. `MoviesRepo` is the only writer of `movie_*` tables. `src/directStream/repo.ts` is the only
   writer of `stream_*` tables. Play events are never deleted. Watch state is derived only in
   `src/movies/state.ts` and never stored.
5. Verification and provider health are per host. The other machine never shows this host's
   verified titles as playable.
6. Off means nothing starts: `NOTESD_MOVIES=off`, `NOTESD_DIRECT_STREAM=off` or `deps.directStream`
   unset answer `direct_stream_off`; the prober runs only with `NOTESD_STREAM_PROBER=on`. Tests use
   a fake runner and never open Chrome, reach a provider or reach TMDB.
7. Resolving shows no window and makes no sound. Only an asked-for play brings the streaming
   Chrome to the front.
8. `/idlix`, `/lk21`, `streaming_find` and `streaming_play` keep working unchanged.
9. Movies guide pictures come from the real library (`docs:shots -- --live movies`), never a
   fixture, and a picture that plays something is taken only when the owner asks.
10. A title that only ever had a stream source never appears in the Library grid, and a title is
    never shown on the Stream grid without a fresh verified source on this host.

## Shared contracts

The reconciled contract: every phase plan now uses these names. Phase 3's plan is the daemon
contract.

**Script side, `claude/streaming/direct/` (phases 1, 2, 6, 8).**

- `providers.seed.json` (phase 1; values filled by phases 2 and 6): an array of
  `{ "name", "id_kind": "tmdb", "movie": "<url with {id}>", "tv": "<url with {id} {season} {episode}>" | null, "browser_only": false, "en_subtitle": true | false | null, "notes": "" }`.
  The 24 fmovies entries; `tv` is null until phase 2 proves one.
- `known-titles.json` (phase 2 creates; phase 2's `campaign.mjs` and phase 8's `loadKnownTitles`
  read it): `[{ label, kind: "movie" | "tv", tmdb_id, season?, episode? }]`: Fight Club 550,
  Sinners 1233413, Breaking Bad S02E03.
- `sniff.ps1` + `sniff.mjs`: `sniffEmbed(url, { seconds, linger, botGraceS, port, inspect? })`
  returns the spike's capture plus `user_agent`, `bot_check`, `bot_check_reason`, `media`, hit
  bodies, and (phase 2's `-Inspect`) `inspect`.
- `order.mjs`: `orderProviders(providers, health)`: the one place the D1 order lives.
- `resolve.mjs`: `resolveTitle(ref, { providers, health, sniff, only, sniffOptions, clock, deadlineS })`.
- `cli.mjs` (phase 1; phase 8 adds `templates`):
  `resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>]`,
  `providers [--providers <file>] [--health <file>]`, `open <http://localhost|127.0.0.1 url> [--fullscreen]`,
  `templates <site url>`. Prints one JSON object; exit 0 ok, 1 not, 2 usage / bad input (stdout
  still holds the answer).

  ```json
  { "ok": true, "kind": "movie", "tmdb_id": 550, "season": null, "episode": null,
    "source": { "provider": "VidFast", "embed_url": "", "manifest_url": "", "manifest_kind": "hls",
                "headers": { "referer": "", "origin": null, "user_agent": "" },
                "subtitles": [{ "url": "", "lang": "en", "label": "", "format": "vtt", "source": "request" }],
                "best_height": 2160, "en_subtitle": true, "took_s": 2.3 },
    "attempts": [{ "provider": "VidFast", "outcome": "resolved", "took_s": 2.3, "detail": "" }] }
  ```

  `manifest_kind` is `hls | dash | mp4`; a header the request did not carry is `null`. `outcome`
  is one of `resolved`, `no_stream`, `bot_check`, `error`, `skipped_browser_only`,
  `skipped_no_template`. `ok: false` has `source: null` and `error`: `no_source` (the only one
  that says the title has no source), `no_chrome`, `chrome_not_reachable`, `unknown_provider`,
  or `deadline` (`--deadline-s` passed: no further provider was tried).
  `--health <file>` is `name -> { en_subtitle, best_height, median_s, last_success_at, last_failure_at, consecutive_failures }`.
- `open <url> --fullscreen` puts the page full screen in the streaming Chrome, then evaluates
  `window.notesdStream.start()` in it through `cdp.ps1` (whose `Runtime.evaluate` passes
  `userGesture: true`), retrying while the page loads, so the film starts with sound. Never when
  the address carries `muted=1`. Answer: `{ ok: true, url, fullscreen, started: true | false | null }`.

**Daemon, `src/directStream/` and `src/http/directStreamApi.ts` (phase 3).**

- Config: `DirectStreamConfig { enabled, freshDays, cli, prober }` (`prober` added by phase 10),
  `DEFAULT_DIRECT_STREAM_CONFIG` (off), `parseDirectStream(env)`. Env: `NOTESD_DIRECT_STREAM`
  (default on), `NOTESD_STREAM_FRESH_DAYS` (7), `NOTESD_DIRECT_STREAM_CLI` (absolute path of the
  resolver; default `claude/streaming/direct/cli.mjs`); phase 10 adds the `NOTESD_STREAM_PROBER*`
  settings.
- `AppDeps.directStream?: DirectStreamService | null`; built only with movies on.
- Tables (migration `0020`): `stream_providers` (shared: the seed's fields plus `origin_site`,
  null for the seed, `added_at`, `updated_at`), `stream_provider_health` (pk `name, host`).
  Seed load at every start: insert missing seed rows, update seed rows (`origin_site` null) whose
  fields changed; a row with `origin_site` set is never touched; nothing is deleted.
- Types (`types.ts`): `StreamRef` (`{kind:'movie', tmdbId} | {kind:'tv', tmdbId, season, episode}`),
  `StreamRefInput` (`{kind, tmdbId, season?, episode?}`), `ResolveOutput`, `ResolvedSource`,
  `ResolveAttempt`, `SubtitleTrack`, `DirectStreamError { code: 'no_source' | 'resolve_failed' | 'open_failed' | 'unknown_session', reason, attempts, sessionId, pageUrl }`.
- `DirectStreamRunner = (args: string[]) => Promise<unknown>`; tests and `verify.sh up --direct-stream` use a fake.
- `DirectStreamService`: `resolve(input, { resumeS?, deadlineS? })` -> `StreamSession`;
  `play(input, { resumeS? })` -> `PlayResult { page_url, session: SessionInfo, attempts }`
  (resolve, then `open http://localhost:<port>/stream/<id> --fullscreen`); `session(id)` (sync,
  raw `StreamSession`); `info(id)` -> `SessionInfo | null`; `refresh(id)` -> `SessionInfo` (same
  id); `passThrough(id, req)`; `providers()` -> `ProviderView[]`;
  `runResolve(ref, { only?, deadlineS? })` -> `ResolveOutput` (serialized with plays, records
  health, never calls `recordResolve`, never throws for a failed resolve); `updateSource(site)`
  (phase 8). Sessions are in memory: 32-character random id, 4 h idle, 24 h at most, 32 at most.
- `DirectStreamHooks` (phase 5 implements, passed as `hooks` to `buildDirectStreamService`):
  `recordResolve?(ref, result: ResolveOutput)`, **awaited** after every resolve that `resolve()`,
  `play()` or `refresh()` makes, before the caller is answered; `resumeS?(ref)`; `titleLabel?(ref)`.
- `SessionInfo` (`GET /api/stream/sessions/:id`): `{ session_id, kind, tmdb_id, season, episode, title, provider, manifest_kind, manifest_url, subtitles: [{ url, lang, label, format, source, english }], best_height, resume_s, created_at, refreshed_at, expires_at }`;
  every address is a pass-through address; an `.srt` track is served as WebVTT (`&vtt=1`).
- Routes: `POST /api/stream/play` (same-origin) `{ kind, tmdb_id, season?, episode?, resume_s? }`;
  `GET /api/stream/sessions/:id`; `GET /api/stream/sessions/:id/p?u=<url>[&vtt=1]` (the
  pass-through: forwarded answers carry the host's status and `X-Notesd-Upstream: <status>`;
  notesd's own refusals do not); `POST /api/stream/sessions/:id/refresh` (same-origin); phase 5's
  `POST /api/stream/sessions/:id/position`; phase 10's `GET /api/stream/prober`.
- Error codes: `direct_stream_off` 503 (every route, before the Origin guard), `no_source` 502
  with `attempts`, `resolve_failed` 502 with `reason` (`no_chrome`, `chrome_not_reachable`,
  `script_failed`, `bad_output`, `deadline`, ...), `open_failed` 502, `unknown_session` 403,
  `forbidden_host` 403, `upstream_error` 502.
- Harness: `verify.sh up --direct-stream` (implies `--movies`; fake resolver and fixture stream
  host; a caller's `NOTESD_DIRECT_STREAM_CLI` passes through, which phase 6's playcheck wrapper
  uses); every other run pins `NOTESD_DIRECT_STREAM=off`. Phase 10 adds `--prober` on top of
  `--direct-stream`. verify.sh is edited by phase 3, then phase 10 (phase 5 does not edit it).

**Player page (phase 4).** `web/stream.html` + `web/src/stream/*`, a third Vite input, served by
`src/http/static.ts` for `/stream/<sessionId>`. hls.js and dash.js are pinned npm packages bundled
into it. It reads `SessionInfo` (only `source: "request"` tracks are loaded as files), posts
`{ position_s, duration_s, ended }` to `POST /api/stream/sessions/:id/position` every 5 s and on
pause/end from the daemon's own origin and ignores every answer (404 included). It refreshes only
on a 401/403/410 that carries `X-Notesd-Upstream`; a 403 without it ends the play as
`session_over`, with no refresh and no loop. `?muted=1`: muted before any `play()`, never
unmuted, never full screen. `window.notesdStream` = the state plus `{ kind, levels, level, errors, refreshes, start() }`;
`start()` unmutes and plays (nothing under `?muted=1`). The `<title>` is never empty and never the
address or host (phase 1's `open` needs it).

**Movies store (phase 5).** Migration `0021`: `movie_plays.file_id` becomes nullable and the row
gains `title_id`, `season`, `episode`, `provider` and `stream_session` (the player session; one
open row per session is a unique partial index); source gains `stream`; a check keeps "file play
has a file, stream play has a title, provider and session". `movie_stream_sources` (pk
`title_id, season, episode, host`; `provider`, `manifest_kind`, `best_height`, `en_subtitle`,
`verified_at`, `stale_at`, `failure` set exactly when `stale_at` is; a film uses season 0,
episode 0). The one freshness rule, `src/movies/repo.ts`: `freshStreamSourceSql(host, since)`,
`isFreshStreamSource(row, host, since)`, `streamFreshSince(now, freshDays)` (verified on this host
at or after `since` and not stale); phases 7, 9 and 10 use it and define none. `MoviesRepo.streamSourcesOfTitle(titleId, host)`;
`listStreamTitles(db, filter, ctx, freshSince)`; `listTitles` leaves out stream-only titles unless
`filter.scope === 'all'`; `TitleDetail.stream_sources` (this host's verified rows). `MovieStreams`
implements the hooks: `recordResolve` marks verified, or stale on `no_source` only; it ensures the
title row first, and a TMDB miss logs, writes nothing and never throws, so a play still answers
200. The position route (same-origin) answers 404 `unknown_session` or `unknown_title`.

**Tools (phases 7 and 8).** `src/mcp/directStreamTools.ts`: `direct_stream_find`,
`direct_stream_play` (phase 7); `direct_stream_sources`, `direct_stream_update_source` (phase 8).
Tool deps are `DirectStreamToolDeps` (`library`, `tmdb`, `play`, `freshSource`; phase 8 adds
`providers`, `updateSource`), built by `directStreamToolDeps(appDeps)`. Names live in
`src/chat/status.ts` as `DIRECT_STREAM_TOOL_NAMES`; `CLAUDE_CODE_ONLY_TOOL_NAMES` keeps
`direct_stream_update_source` out of the chat bar. `scripts/install.sh`'s `SKILL_NAMES` gains
`direct-stream` (phase 7), then `update-cloud-source` (phase 8). `docs/guide/chat.md` gets a
caption row and an allow-list row (phase 7), which phase 8 extends.

**Stream page (phase 9).** `GET /api/movies/stream` answers
`{ enabled: true, titles, fresh_days } | { enabled: false, reason: 'direct_stream_off', titles: [] }`
in the `TitleListItem` shape; title answers mark each `stream_sources` row `fresh`; the title page
gets a stream line and Play calls `POST /api/stream/play`. The web wire types gain stream plays
(`PlayView.file_id` / `file_name` nullable, `source: 'stream'`, `provider`) and change reason `stream`.

**Prober (phase 10).** `NOTESD_STREAM_PROBER` (default off), `NOTESD_STREAM_CATALOG_SIZE` (300),
`NOTESD_STREAM_PROBE_BUDGET`, `NOTESD_STREAM_IDLE_SECONDS` (600), `NOTESD_STREAM_PROBE_MS`;
`stream_probe_titles` (migration `0022`, per host); each probe is `resolve(ref, { deadlineS })`
with the seconds left in the pass; defaults from phase 2's timings block (`resolve_s.p50`,
`fail_s.p50`).

**Findings.** `docs/plans/2026-11-15-direct-streaming-findings.md`: phase 2 creates it (with the
`campaign:timings` block, schema 1: `resolve_s`, `fail_s`, `providers.<name>`, `token_lifetime`),
phase 6 fills its `## Playback` section.

**Guides and READMEs.** `docs/guide/streaming.md`: phase 3 creates the "Direct streaming" section,
with "The resolver" written from phase 1's draft (phase 1 does not edit the guide); phases 4 ("The
player"), 7 ("`/direct-stream`"), 8 ("`/update-cloud-source`") and 10 ("The prober") append their
own subsections. `docs/guide/movies.md` is edited by 5 (stored data, state, two machines) and 9
(the page). `docs/guide/reference/configuration.md` and `scripts/docs/httpRoutes.ts` are edited
by phases 3, 5, 9 and 10, each adding only its own rows; the `GET /api/movies/:id` sentence about
`stream_sources` is phase 5's alone. `README.md` gets one Direct streaming line in phase 3.
`CLAUDE.md` is edited by no phase (Follow-ups for the owner).

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Provider seed, sniffer and resolver CLI | R1 | `claude/streaming/direct` | 12 | — | HARD | `.workflows/plan/direct-streaming/phase-1.md` | P1-NOTES-A111 | — |
| 2 | Resolve probe campaign: 24 providers, failures, episodes, token lifetime | R7 | `claude/streaming/direct` | 7 | 1 | HARD | `.workflows/plan/direct-streaming/phase-2.md` | P1-NOTES-A112 | — |
| 3 | Registry tables, DirectStreamService, sessions and the pass-through | R1, R2 | `src/directStream`, `src/http` | 40 | 1 | HARD | `.workflows/plan/direct-streaming/phase-3.md` | P1-NOTES-A113 | — |
| 4 | The player page | R2 | `web/src/stream` | 26 | 3 | HARD | `.workflows/plan/direct-streaming/phase-4.md` | P1-NOTES-A114 | — |
| 5 | Streams in the movies store: plays, verified sources, state | R2, R5 | `src/movies`, `src/db` | 22 | 3 | HARD | `.workflows/plan/direct-streaming/phase-5.md` | P1-NOTES-A115 | — |
| 6 | Playback probe campaign: DASH, VidNest, subtitles, expiry | R7 | `claude/streaming/direct`, `web/src/stream` | 7 | 2, 4 | HARD | `.workflows/plan/direct-streaming/phase-6.md` | P1-NOTES-A116 | — |
| 7 | `/direct-stream`: title lookup, tools, skill, chat bar | R3 | `src/mcp`, `src/directStream`, `claude/skills` | 23 | 4, 5 | NORMAL | `.workflows/plan/direct-streaming/phase-7.md` | P1-NOTES-A117 | — |
| 8 | `/update-cloud-source`: template reader, registry tools, skill | R4 | `claude/streaming/direct`, `src/directStream`, `src/mcp` | 19 | 2, 7 | NORMAL | `.workflows/plan/direct-streaming/phase-8.md` | P1-NOTES-A118 | — |
| 9 | The Stream side of `/movies` | R5 | `web/src`, `src/http` | 24 | 4, 5 | HARD | `.workflows/plan/direct-streaming/phase-9.md` | P1-NOTES-A119 | — |
| 10 | Candidates and the background prober, behind a setting | R6 | `src/directStream` | 33 | 2, 5, 8, 9 | HARD | `.workflows/plan/direct-streaming/phase-10.md` | P1-NOTES-A120 | — |

Phase 3 serves R1 and R2 and phase 5 serves R2 and R5. Both couplings are real: the registry
table and the pass-through share one migration and one service, and the stream play row and the
verified-source row share one migration and one repo change. Migrations are ordered by the
table: `0020` (phase 3) < `0021` (phase 5, depends on 3) < `0022` (phase 10, depends on 5).

### Phase 1 — Provider seed, sniffer and resolver CLI
**Satisfies:** R1 (R1.1, R1.2, R1.3)
**Owns:** `claude/streaming/direct/{providers.seed.json,sniff.ps1,sniff.mjs,order.mjs,resolve.mjs,cli.mjs}` (with `resolve --deadline-s` and the full-screen `open` that calls the page's `window.notesdStream.start()` as a user gesture); unit tests under `tests/unit/scripts/` with a fake sniffer; fixtures under `tests/fixtures/direct-stream/`; the resolver entry in `.claude/skills/verify-notesd/features/streaming.md`. The sniffer keeps the spike's behaviour and adds: the tab's user agent, a bot-check flag, a background tab, muted pages.
**Does not touch:** `src/`, `web/`, `docs/guide/streaming.md` (phase 3 writes "The resolver" from this phase's draft), the existing `cli.mjs`, `cdp.ps1`, `chrome.mjs`, `play.mjs`, `sites/`; the spike folder.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; J1 to J3 pass; J4 prints a `resolved` source for Fight Club on the owner's machine with no window brought forward and nothing heard.

### Phase 2 — Resolve probe campaign
**Satisfies:** R7 (R7.1, R7.2)
**Owns:** `claude/streaming/direct/known-titles.json` (the one known-titles list), `claude/streaming/direct/campaign.mjs`, `docs/plans/2026-11-15-direct-streaming-findings.md` (its tables, the `campaign:timings` block, the `## Playback` heading for phase 6), the seed fields the findings fill (`tv`, `en_subtitle`, `browser_only`, `notes`), and the `-Inspect` switch in phase 1's `sniff.ps1` / `sniff.mjs` (quoted as phase 1 writes them). Diagnoses Videasy, VidKing and CloudPlay by name.
**Does not touch:** `src/`, `web/`, `docs/guide/`. No playback: nothing is shown and nothing makes a sound.
**Exit criteria:** `campaign.mjs check` prints `"ok": true`; the findings file has a row for each of the 24 providers and the sections "Why three returned nothing" (each with a named cause), "Series episodes" and "Token lifetime" with measured data; the seed carries the measured values; `npm run typecheck`, `npm test` and `npm run docs:check` pass.

### Phase 3 — Registry tables, DirectStreamService, sessions and the pass-through
**Satisfies:** R1 (R1.4), R2 (R2.1, R2.2, R2.6)
**Owns:** everything under "Daemon" in Shared contracts; `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `src/http/app.ts` wiring; migration `0020`; the "Direct streaming" section of `docs/guide/streaming.md` (heading, "The resolver" from phase 1's draft, providers, sessions and the pass-through, answers), `docs/guide/architecture.md` rows, the configuration section, the `scripts/docs/httpRoutes.ts` group, the `README.md` line; `verify.sh up --direct-stream`, `scripts/direct-stream/journey.sh`, `features/direct-streaming.md` and its README row.
**Does not touch:** `movie_*` tables, `src/movies/*`, `web/`, MCP tools, `claude/streaming/direct/*` (reads the seed, runs the CLI), `CLAUDE.md`.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the two integration files pass; migration `0020_stream_providers` applies on a fresh database; J1-J8 pass and the neighbor check passes.

### Phase 4 — The player page
**Satisfies:** R2 (R2.3, R2.5)
**Owns:** `web/stream.html`, `web/src/stream/*`, `web/src/testing/streamFakes.ts`, the Vite input, `src/http/static.ts` for `/stream/<id>`, `package.json` (hls.js, dash.js); `?muted=1`, `window.notesdStream` (with `start()`), the refresh rule on `X-Notesd-Upstream`; jsdom tests; the "The player" subsection of `docs/guide/streaming.md`; architecture's Pages row; the player lines of `features/direct-streaming.md`; `scripts/stream/{make-hls-fixture.sh,player.steps.mjs}`.
**Does not touch:** `src/directStream/*` beyond reading its route shapes, `web/src/pages`, `web/src/components/movies`, `CLAUDE.md`.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and `npm run build` pass; `web/dist/stream.html` exists and loads `/assets/stream-*.js`; the `player.steps.mjs` transcript has `J1 PASS`, `API PASS`, `J3 PASS`, `J2 PASS`, `MUTED PASS` and `CDN PASS`.

### Phase 5 — Streams in the movies store
**Satisfies:** R2 (R2.4), R5 (R5.4, store half)
**Owns:** everything under "Movies store" in Shared contracts; `src/db/schema.ts` + migration `0021`; `src/movies/{repo,types,state,read,service,streams}.ts` (including `TitleDetail.stream_sources` and the one freshness rule); the position route in `src/http/directStreamApi.ts`; the hooks passed to phase 3's builder in `src/daemon.ts`; the position route and the `GET /api/movies/:id` `stream_sources` sentence in `scripts/docs/httpRoutes.ts`; `docs/guide/movies.md` ("What is stored", "Watch state", "Two machines", "Where the code is"); integration tests.
**Does not touch:** `web/`, MCP tools (`src/mcp/movieTools.ts` is phase 7's edit), the Stream list route (phase 9), `src/directStream/*`, `verify.sh`.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run test:int` and `npm run docs:check` pass; J1, J2 and J3 pass; the movies journey still passes.

### Phase 6 — Playback probe campaign
**Satisfies:** R7 (R7.3)
**Owns:** `claude/streaming/direct/{playcheck.mjs,playgate.mjs}` (the wrapper runs under `verify.sh up --web --direct-stream` with `NOTESD_DIRECT_STREAM_CLI`; pages open as `/stream/<id>?muted=1` in a normal window, never full screen), the findings file's "Playback" section, `browser_only` in the seed, and fixes in `web/src/stream/*` that a finding demands.
**Does not touch:** `src/movies/*`, tools, `/movies`, `verify.sh`. Does not depend on phase 5: a TMDB miss on verify's fake TMDB still plays (phase 5's rule).
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; the findings Playback section says, with measured numbers, whether DASH (VidLink), VidNest and an English subtitle play in our page, and records the forced-expiry refresh-and-continue result; `playcheck.mjs audit` passes, so every provider that cannot play outside its own page is `browser_only`.

### Phase 7 — `/direct-stream`
**Satisfies:** R3 (R3.1, R3.2, R3.3)
**Owns:** title lookup from words (`src/directStream/{match,lookup}.ts`; `StreamTarget` is phase 3's `StreamRef`), `direct_stream_find` and `direct_stream_play` in `src/mcp/directStreamTools.ts` (with `DirectStreamToolDeps`, `playFailure` reading `DirectStreamError`), `DIRECT_STREAM_TOOL_NAMES` and captions in `src/chat/status.ts`, `src/chat/prompt.ts`, `src/mcp/instructions.ts`, `scope: 'all'` and the stream play source in `src/mcp/movieTools.ts`, `claude/skills/direct-stream/SKILL.md`, `SKILL_NAMES` in `scripts/install.sh`, the caption, allow-list and behaviour lines in `docs/guide/chat.md`, `npm run docs:gen`, the `/direct-stream` lines of `docs/guide/streaming.md`.
**Does not touch:** the registry tools (phase 8), `web/`, `src/movies/{repo,state,read,types}.ts`.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the integration file pass; J1 to J5 and the neighbor check pass; `scripts/install.sh` links `~/.claude/skills/direct-stream`. The full-screen play with sound is the owner's to run (Follow-ups).

### Phase 8 — `/update-cloud-source`
**Satisfies:** R4 (R4.1, R4.2)
**Owns:** `claude/streaming/direct/templates.mjs` + the `templates <site url>` CLI command (a `parseArgs` case and a `main` branch quoted against phase 1), `src/directStream/updateSource.ts` (reads phase 2's `known-titles.json`), `DirectStreamRepo.insertProviders`, `DirectStreamService.updateSource(site)`, `direct_stream_sources` and `direct_stream_update_source` (through `DirectStreamToolDeps.providers` / `updateSource`), `CLAUDE_CODE_ONLY_TOOL_NAMES`, `claude/skills/update-cloud-source/SKILL.md`, `update-cloud-source` in `SKILL_NAMES`, the `/update-cloud-source` subsection and the chat.md row edits.
**Does not touch:** the seed file's entries, `web/`, phase 3's seed loading.
**Exit criteria:** the reader prints the 24 fmovies providers from the real chunk and the live site; with a fake runner against real Postgres, new providers are inserted once with `origin_site`, existing rows read back unchanged, each new one is probed against the known titles, and every unreadable-site case leaves the table identical; the two tools are registered and the chat bar's allow list has `direct_stream_sources` and not `direct_stream_update_source`; `npm test`, `npm run typecheck` and `npm run docs:check` pass.

### Phase 9 — The Stream side of `/movies`
**Satisfies:** R5 (R5.1, R5.2, R5.3, R5.4 page half, R5.5)
**Owns:** `GET /api/movies/stream` (through phase 5's `listStreamTitles`, `streamFreshSince`, `isFreshStreamSource`), the `fresh` flag on title answers, the Library / Stream switch in `MoviesPage`'s toolbar (icon-only, Phosphor), the Stream grid, the title page's stream line and Play, episode rows that verify on click, the stale answer, `web/src/lib/{movies,route}.ts`, `web/src/hooks/useMovies.ts`, `web/src/moviesApi.ts` (stream types, widened `PlayView`, change reason `stream`), web tests, `docs/guide/movies.md` ("The Movies page", "The Stream side"), `scripts/docs/shots/movies.mjs` (a read-only live picture), the movies feature map. Its Proof runs `verify.sh up --web --direct-stream`.
**Does not touch:** the rail and sidebar, `src/movies/*`, the `GET /api/movies/:id` sentence in `httpRoutes.ts` (phase 5's), the prober.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the two integration files pass; J1-J6 pass on a throwaway daemon; `/movies` has a Library / Stream switch whose Stream side lists only this host's fresh verified titles, streams on Play with one request, drops a title that failed, and keeps a local file as the default Play.

### Phase 10 — Candidates and the background prober
**Satisfies:** R6 (R6.1, R6.2, R6.3)
**Owns:** TMDB list calls in `src/movies/tmdb.ts`, candidates, `src/directStream/{prober,idle,candidates}.ts`, `ProbeRepo` in `src/directStream/repo.ts` (freshness through phase 5's `freshStreamSourceSql`), migration `0022`, the prober settings (in phase 3's `DirectStreamConfig`), `GET /api/stream/prober`, `src/background.ts`, `verify.sh --prober` on top of `--direct-stream`, the fake TMDB's lists, "The prober" subsection, configuration rows.
**Does not touch:** `web/`, tools, phase 3's `DirectStreamRepo` / `DirectStreamService` bodies, `src/movies/{repo,state,read,types}.ts`.
**Exit criteria:** `npm run typecheck`, `npm test`, `npm run docs:check` and the new integration file pass. A `--direct-stream` throwaway daemon with the prober setting unset reports `off_reason: "setting_off"` and writes no probe row; with `--direct-stream --prober` it lists the fake TMDB's titles as ranked candidates and holds every pass at `not_idle` with zero probes. Unit tests prove off, not-idle, budget (probes, seconds and each resolve's deadline), catalog size and re-check order.

## Reconciliation Log

| # | Conflict | Kind | Resolution |
|---|---|---|---|
| 1 | Phases 4-10 planned against guessed daemon names (`id`, `ResolveAnswer`, `freshStreamSource`, `code: 'no_chrome'`, `requireService`) | Contract drift | Phase 3's names are the contract: phases 4, 5, 6, 7, 8, 9, 10 rewritten to `StreamRefInput`, `StreamRef`, `ResolveOutput`, `DirectStreamError {code, reason, attempts}`, `SessionInfo.session_id`, `resolve`/`play`/`session`/`info`/`refresh`/`runResolve`, `DirectStreamHooks`, `parseDirectStream`, `NOTESD_DIRECT_STREAM_CLI` |
| 2 | Phase 7 read Chrome failures from `code`; phase 3 puts them in `reason` | Contract drift | Phase 7's `playFailure` reads `DirectStreamError`: `no_source` with attempts, else `error` + `reason`; skill, description and tests updated |
| 3 | Phase 4 refreshed on any 401/403/410, including notesd's own `unknown_session` 403 | Contract drift | Refresh only when `X-Notesd-Upstream` is present (`classifyRefusal`, engines read the header); a bare 403 ends as `session_over`, no refresh, no loop; harness fake sends the header |
| 4 | Phase 6 required `?muted=1`, `window.notesdStream {kind, levels, level, errors, refreshes}` and a real `<title>`; phase 4 had none of them | Unmet assumption | Added to phase 4's contract, controller, StreamApp, tests and Playwright harness (`API PASS`, `MUTED PASS`) |
| 5 | D2 "one click to a full-screen film" had no path to sound: phase 4 fell back to muted, phase 1's `open` only navigated | Gap | Phase 1's `open --fullscreen` evaluates `window.notesdStream.start()` as a user gesture (`START_EXPRESSION`, retried while loading, never with `muted=1`); phase 4 defines `start()` (`playWithSound`); the muted icon stays as the fallback |
| 6 | Known titles inline in phase 2 (`TITLES`), assumed in a file by phase 8 | Contract drift | `claude/streaming/direct/known-titles.json` created by phase 2; `campaign.mjs` loads it (`loadTitles`); phase 8 reads the same file |
| 7 | Phase 8 needs `known-titles.json` (phase 2) but did not depend on phase 2 | Ordering violation | Phase 8 now depends on 2 and 7 |
| 8 | Seed load: phase 3 updates changed seed rows; phase 8 assumed insert-only | Contract drift | Phase 3's rule kept; phase 8's Requires, guide text ("the seed only fills an empty database") and handoffs rewritten |
| 9 | Hooks on probes: phase 8 assumed `runResolve` without hooks, phase 10 assumed `resolve` with hooks, phase 5 listed "prober" among hooked resolves | Duplicate/ambiguous contract | Confirmed: `runResolve` (phase 8 probes) never calls `recordResolve`; `resolve`/`play`/`refresh` (plays, refreshes, prober) await it before answering; stated in phases 3, 5, 8, 10 |
| 10 | A TMDB miss in phase 5's `ensureTitle` vs phase 6's fake TMDB lacking 550 | Unmet assumption | Phase 5 states the rule (log, no row, never throws, play still 200, position route 404 `unknown_title`) and adds a test; phase 6's Requires updated; no 6 -> 5 edge |
| 11 | Freshness defined three times (phase 5 repo, phase 9 `DAY_MS` route math, phase 10 `freshSourceOn` with a different stale rule) | Duplicate work | Phase 5's `streamFreshSince` / `isFreshStreamSource` / `freshStreamSourceSql` used by phases 7, 9, 10; phase 10's dueRechecks and test store aligned to `stale_at is null` |
| 12 | Phase 9 called `listStreamTitles(db, {freshSince}, ctx)`; phase 5 defines `(db, filter, ctx, freshSince)` | Contract drift | Phase 9 calls phase 5's signature |
| 13 | `TitleDetail.stream_sources`: phase 9 assumed phase 5 adds it, phase 5 left it to phase 9, and `read.ts` is phase 5's file | Gap | Phase 5 adds `StreamSourceView` and `TitleDetail.stream_sources` (Step 6b, with a test); phase 9 adds `fresh` in its route |
| 14 | Phase 7 assumed `MoviesRepo.freshStreamSource(...)` | Unmet assumption | Phase 7 uses `streamSourcesOfTitle` + `isFreshStreamSource` + `streamFreshSince` |
| 15 | `movie_plays.stream_session` added by phase 5 outside the shared contract | Contract drift | Accepted; Shared contracts updated |
| 16 | Phase 5 passed `hooks: null` to phase 3's optional `hooks?: DirectStreamHooks` | Broken-build phase | `undefined` when movies is off; Step 10 quotes phase 3's post-change `buildDirectStreamService(...)` call |
| 17 | verify.sh: phase 3 hard-set the fake CLI; phase 6 needed its wrapper through `--movies`; phase 9 used `--movies` (direct streaming pinned off, so its J2 would read `enabled: false`); phase 10's `--prober` turned direct streaming on by itself | File collision / unmet assumption | Phase 3 passes a caller's `NOTESD_DIRECT_STREAM_CLI` under `--direct-stream`; phases 6 and 9 use `--direct-stream`; phase 10's `--prober` needs `--direct-stream` and quotes phase 3's verify.sh; sequence 3 then 10 |
| 18 | Phase 10 needed a resolve deadline nobody provided | Gap | Phase 1 `--deadline-s` (answer `deadline`), phase 3 `resolve`/`runResolve` `deadlineS`, phase 10 passes the seconds left in the pass and treats `deadline` as `time_budget`; tests added in 1, 3, 10 |
| 19 | Timings keys: phase 10 read `median_*`; phase 2 writes `resolve_s.p50`, `fail_s.p50` | Contract drift | Phase 2's schema 1 is the contract; phase 10's reader and drift test read the block's `p50`s; failed-before-resolve keeps the spike's 1 |
| 20 | Phase 2's `-Inspect` edits quoted the spike's `sniff.ps1` anchors and a `$script:frameSessions` list | File collision | Steps 4-5 rewritten against phase 1's `sniff.ps1` (`$pageSessions`, media block, `Close-Tab`, final `Write-Output`) and `parseSniffReply`; cancellation window widened under `-Inspect` |
| 21 | Phase 8's `templates` command assumed a `switch` in `main` and would be refused by phase 1's `parseArgs` and read the providers file | Broken-build phase | Phase 8 adds a `parseArgs` case and a `main` branch quoted against phase 1 (including `--deadline-s`), plus a dispatch test |
| 22 | Phase 8 assumed `ToolDeps.directStream` is a `DirectStreamService` with `requireService`/`run`; phase 7 made it `DirectStreamToolDeps` | Contract drift | Phase 8 extends `DirectStreamToolDeps` with `providers` / `updateSource`, binds them in `directStreamToolDeps`, uses phase 7's `respond`/`ok`/`off`, and updates phase 7's test `fakeDeps` |
| 23 | Phase 7's tool test asserted exactly two registered tools; phase 8 registers four from the same function | Broken-build phase | Phase 7's assertion compares with the whole `DIRECT_STREAM_TOOL_NAMES` |
| 24 | `scripts/install.sh` links only `SKILL_NAMES`; phase 8 assumed it links every folder | Gap | Phase 8 appends `update-cloud-source` after phase 7's `direct-stream`, quoting phase 7's line |
| 25 | Phase 8 edited "phase 7's chat.md caption row", which phase 7 never wrote | Gap | Phase 7 adds the caption row, allow-list row and behaviour bullet to `docs/guide/chat.md`; phase 8 quotes and extends both rows |
| 26 | Phase 8 quoted phase 7's chat-status test as `toHaveLength(2)` | File collision | Phase 8 quotes phase 7's actual lines and replaces them |
| 27 | Stale `movie_stream_sources` rows seeded without `failure` in phase 9 (integration test, Proof setup, J4 stub) and phase 10 (integration test) violate phase 5's `movie_stream_sources_failure_check` | Broken-build phase | Seeds and the stub set `failure = 'no_source'` with `stale_at` |
| 28 | Phase 10's `prober` field breaks phase 3's config test `toEqual({enabled, freshDays, cli})`; phase 10 quoted `DirectStreamConfig` without `cli`; `DEFAULT_DIRECT_STREAM_CONFIG` would read the prober default before it is declared | Broken-build phase | Phase 10 quotes phase 3's block with `cli`, updates that test line, and places its constants before phase 3's |
| 29 | Phase 4 loaded every session subtitle as a file, including `source: "manifest"` tracks (HLS playlists) | Contract drift | `parseSession` skips manifest tracks and uses phase 3's `english` |
| 30 | Phase 7 defined `StreamTarget` identical to phase 3's `StreamRef` | Duplicate work | `StreamTarget = StreamRef` alias |
| 31 | Stream-only titles hidden by phase 5's Library filter would break the MCP name lookup | Gap | Phase 7 Step 5b: `scope: 'all'` in `movieTools.ts`, `movies_get` / `movies_history` descriptions name `stream` and `provider`; `docs:gen` |
| 32 | Phase 5's widened wire types not mirrored in the web app | Gap | Phase 9 widens web `PlayView` and `MovieChangeWire.reason` |
| 33 | Phase 9 and phase 5 could both write the `GET /api/movies/:id` sentence about `stream_sources` | Duplicate work | Phase 5 alone writes it; phase 9 documents `fresh` in its own route's entry |
| 34 | Guide ownership: phase 1 was listed as adding a subsection under a heading phase 3 creates later | Ordering violation | Phase 3 creates the section and writes "The resolver" from phase 1's draft; phase 1 does not edit the guide; 4, 7, 8, 10 append |
| 35 | README and CLAUDE.md left to "the reconciler or phase 7" | Gap | Phase 3 adds the README line; CLAUDE.md listed under Follow-ups for the owner |
| 36 | Phase 3's verify-notesd gotcha forbade any real resolver on a throwaway daemon, which phase 6's wrapper needs | Contract drift | Gotcha names the playcheck wrapper as the one exception, run only when the owner expects it |
| 37 | Phase 10's route mount quoted the pre-phase-3 `app.ts` line | File collision | Mounted after phase 3's `directStreamRoutes` line |
| 38 | Phase 3's handoff asked phase 5 to add `movie_stream_sources` to `truncateAll` | Duplicate work | Not needed (`movie_titles ... cascade`); handoff corrected |
| 39 | The index's R1.1 row held `<movie\|tv>`, which `ears_trace.py` splits as a column, so R1.1 read as unowned | Misassigned criterion | Criterion text reads `<movie or tv>`; Phases cell `1` |
| 40 | Phase 8's probe result typed outcomes without phase 3's `skipped_no_template` | Broken-build phase | `ProbeOutcome` is phase 3's `ResolveOutcome` or `'not_probed'`; `en_subtitle` read from `source.en_subtitle` |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| D5 and D6: "not yet confirmed" in the request, "Owner, 2026-11-15" in the brief at `d996abb` | Confirmed, as relayed by session Z2-QN during this analysis; still late (phase 10) and behind `NOTESD_STREAM_PROBER`, default off | 4: the brief the request names as holding the decisions. Relayed by a peer session, not typed by the owner here: overturn by leaving the setting off |
| Where the registry lives (brief: "a table, a JSON file, or both") | Both: a checked-in seed file, loaded into a shared table; health in a per-host table | 4: brief, "health is per host" |
| A provider that cannot be played outside its own page (brief: "skipped or played as the bare embed") | Skipped, marked `browser_only` | 5: the owner's reason for the feature is no adverts |
| English subtitles from a subtitle service when no provider has one (brief: open) | Not built in this set | 5: D1, "a source without one is the fallback, not a failure" |
| The spike proxy's invented user agent vs "never a disguised client" | The pass-through replays the headers the real Chrome's request carried | 1: invariant 2 and 3 |
| Where a play pressed on the wall shows | The streaming Chrome, full screen, as `/direct-stream` does | 4: D2, the spike's page in the streaming Chrome is the baseline |
| A streamed play has no file but `movie_plays.file_id` is `NOT NULL` | `file_id` nullable, with title, season, episode, provider and `stream_session` on the row | 4: brief, "writes the same play events a VLC play does" |
| Live playback checks take over the screen with sound | Campaign playback is muted (`?muted=1`), in a normal window, never full screen; a full-screen play with sound is the owner's to run | 6: `features/streaming.md`, "run it only when the owner expects it" |
| A series named without an episode in `/direct-stream` | Lists seasons, starts nothing | 6: the existing rule, "a series is a link only" |
| Whose names are the daemon contract (phase 3 vs phases 4-10's guesses) | Phase 3's: `StreamRefInput`, `DirectStreamError {code, reason, attempts}`, `SessionInfo.session_id`, `subtitles[].english`, `resolve`/`play`/`session`/`info`/`refresh`/`runResolve(ref,{only})`, `DirectStreamHooks {recordResolve, resumeS, titleLabel}`, `parseDirectStream`, `NOTESD_DIRECT_STREAM_CLI` | 3: the plans' code blocks (phase 3 planned last, against phases 1, 5 and 8) |
| When the player refreshes (any 401/403/410 vs only the stream host's) | Only on 401/403/410 with `X-Notesd-Upstream`; a 403 without it ends the play as `session_over`, no loop | 3: phase 3's pass-through code marks forwarded answers; phase 6's expiry gate relies on it |
| How phase 6 checks playback without sound or full screen | `/stream/<id>?muted=1`; `window.notesdStream = {kind, levels, level, errors, refreshes, ...}`; a `<title>` that is neither empty nor the address | 2: phase 6's exit criteria; phase 1's `open` needs the title |
| How "one click to a full-screen film" starts with sound | Phase 1's `open --fullscreen` evaluates `window.notesdStream.start()` as a user gesture after the page loads (as the spike's `v.play()` through `cdp.ps1` did); never under `muted=1`; the muted icon stays as the fallback | 4: D2 in the index's Why ("see the fullscreen in which the movie starts playing") |
| Where the known titles live | One file, `claude/streaming/direct/known-titles.json`, `[{label, kind, tmdb_id, season?, episode?}]`, created by phase 2, read by `campaign.mjs` and phase 8 | 3: phase 8's code block named the file and shape |
| Seed loading: insert-only (phase 8) vs insert-and-update seed rows (phase 3) | Phase 3's: seed rows (`origin_site` null) inserted and updated when the file changes; rows with `origin_site` set never touched | 2: phase 2's and phase 6's exit criteria require their seed edits to reach the table |
| Which resolves mark verified/stale | Plays, refreshes and the prober (`resolve`/`play`) await `recordResolve`; phase 8's probes (`runResolve`) never do | 2: phase 9's failed-play exit criterion needs the await; phase 8's "existing untouched" needs probes to mark nothing |
| A TMDB miss while ensuring the title of a play | Logged; no verified/stale row; never throws; the play still answers 200; the position route answers 404 `unknown_title` (no play row: a stream play needs a title) | 2: phase 6's exit criteria run plays against a fake TMDB without 550 |
| Phase 10 writes `docs/guide/reference/http-api.md` (generated) and `scripts/docs/httpRoutes.ts` with phase 9, and appends to `docs/guide/streaming.md`, `features/direct-streaming.md` and `src/directStream/repo.ts` with phase 8 (write-set gate, exit 2) | Phase 10 depends on 8 and 9 too and runs last, alone: it regenerates `http-api.md` on top of phase 9's route and appends "The prober" after phase 8's `/update-cloud-source` subsection. Waves: [1] [2, 3] [4, 5] [6, 7, 9] [8] [10] | 6: the swarm's ORDER rule (a generated file is regenerated, not merged; the higher phase publishes last). Decided by the coordinator, orch-direct-streaming |
| Whether phase 6 depends on phase 5 | No: phase 6 needs nothing phase 5 lands; with or without phase 5 a play answers 200 | 2: phase 6's exit criteria; rule 1 (no edge that is only caution) |
| Where "fresh" is defined | Once, in phase 5 (`streamFreshSince`, `isFreshStreamSource`, `freshStreamSourceSql`); phases 7, 9, 10 use it | 1: invariant 10 (one rule keeps the grid, the tools and the prober in agreement) |
| `movie_plays.stream_session` (added by phase 5) | Accepted into Shared contracts | 3: phase 5's schema code |
| Who owns `TitleDetail.stream_sources` | Phase 5 (it owns `read.ts`); phase 9 adds `fresh` in its route | 6: one owner per file region |
| The `GET /api/movies/:id` `stream_sources` sentence | Phase 5's alone; phase 9 documents `fresh` in its own route entry | 6: CLAUDE.md docs rule, one description per behaviour |
| verify.sh flags | Phase 3 owns `up --direct-stream` (a caller's `NOTESD_DIRECT_STREAM_CLI` passes through); phases 6 and 9 use it; phase 10's `--prober` goes on top; the prober is pinned off everywhere else; edits in order 3, then 10 | 1: invariant 6 (tests never open Chrome) |
| A pass's seconds vs one long resolve | `cli.mjs resolve --deadline-s` (phase 1), `resolve(input, {deadlineS})` (phase 3); the prober passes the seconds left; a `deadline` answer blames no title and ends the pass at `time_budget` | 2: phase 10's exit criteria ("a pass stays inside its budget") |
| The timings block keys | Phase 2's schema 1 (`resolve_s.p50`, `fail_s.p50`, per-provider medians); phase 10 keeps the spike's failed-before-resolve count | 3: phase 2's code writes the block |
| How skills are installed | `scripts/install.sh`'s explicit `SKILL_NAMES`: `direct-stream` (phase 7), then `update-cloud-source` (phase 8) | 6: surrounding code convention |
| Who writes the guide's "Direct streaming" text | Phase 3 creates the section and "The resolver" from phase 1's draft; 4, 7, 8, 10 append their subsections; configuration and httpRoutes rows each by their own phase | 6: CLAUDE.md docs rule |
| README and CLAUDE.md | Phase 3 adds one README line with a link; no phase edits CLAUDE.md (Follow-ups) | 6: CLAUDE.md's "keep README short: one line per subsystem and a link" |
| Stream-only titles and the MCP movie tools | `scope: 'all'` in `movieTools.ts`'s name lookup; `movies_get` / `movies_history` describe source `stream` and `provider` (phase 7); the web `PlayView` and reason `stream` (phase 9) | 1: invariant 10 hides them from the Library only |
| The chat bar and `/update-cloud-source` | The chat bar may call `direct_stream_sources`, never `direct_stream_update_source` (`CLAUDE_CODE_ONLY_TOOL_NAMES`) | 4: R4 names `/update-cloud-source` as a Claude Code skill; it writes the shared registry and probes for minutes |
| An ETag on `GET /api/movies/stream` (asked in phase 9's scope) | Not built: `GET /api/movies` has none either | 6: surrounding code convention |
| Prober candidate order (planner's reading of D5, for the owner to see) | New candidates are probed three films then one series (`SERIES_EVERY = 4`), a series verified by S1E1; pure "films first" would never reach a series at a 300 catalog | 4: D5 in the brief; the owner may change `SERIES_EVERY` |
| What the idle gate covers (planner's reading of D6, for the owner to see) | The daily TMDB candidate refresh runs before the idle gate (HTTP only, no tab, no sound); only Chrome probes wait for idle | 4: D6 in the brief ("out-of-sight tabs only while the laptop is idle") |

## Follow-ups for the owner

- **CLAUDE.md lines** for direct streaming (an Architecture bullet: `DirectStreamRepo` is the only
  writer of `stream_*`, the pass-through host rule, the off switches `NOTESD_DIRECT_STREAM` /
  `NOTESD_STREAM_PROBER`) and for `web/stream.html` (the "Web app" line names only
  `web/fullscreen.html`). No phase edits CLAUDE.md.
- **The full-screen play with sound:** `/direct-stream saltburn` in Claude Code after
  `scripts/install.sh` has rebuilt and restarted the daemon on the merged branch. It takes over the
  screen with sound, so it is the owner's to run.
- **The Stream grid picture:** `npm run docs:shots -- --live movies` once 7317 serves the merged
  branch and at least one title is verified (one `/direct-stream` play is enough); add
  `img/movies/stream.png` under "The Stream side" in `docs/guide/movies.md` if phase 9 could not.
- **DASH expiry: done 2026-11-16** (`feature/stream-discovery`). dash.js's refresh on an expired
  token is proven in jsdom (`web/src/stream/dashEngine.test.tsx`) and end to end on a throwaway
  daemon (`scripts/stream/dash-expiry.steps.mjs`); the live gate takes a DASH source. Left for the
  owner: `playcheck.mjs run --check expiry --provider VidLink` against the real provider.
- **The Chrome-frames template reader: built 2026-11-16** (`claude/streaming/direct/frames.mjs`),
  tested with a fake sniffer. It reads the frames a watch page loads by itself; a site's other
  server buttons are still not pressed. Left for the owner: one live run against a real site.
- **D5 and D6 were confirmed through session Z2-QN's relay**, not typed by the owner in this
  session. The prober ships default off; turning it on (`NOTESD_STREAM_PROBER=on`), and the two
  readings recorded in Decisions (candidate order, refresh before the idle gate), are the owner's
  call.

## Open Questions

None.

## Rollback

Each phase is one commit range on `feature/direct-streaming`; revert the range. Migrations `0020`,
`0021` and `0022` only add tables and columns and relax one `NOT NULL`; rolling back the code
leaves them harmless. `NOTESD_DIRECT_STREAM=off` turns the whole subsystem off without a revert,
and the prober is off unless `NOTESD_STREAM_PROBER=on`.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/DIRECT_STREAMING_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows,
resumable on any machine:

    /analyze-orchestrator -f .workflows/plan/DIRECT_STREAMING_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan .workflows/plan/DIRECT_STREAMING_PLAN.md
