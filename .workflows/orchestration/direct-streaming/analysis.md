# Code Analysis: direct-streaming

**Type:** Feature Implementation
**Date:** 2026-11-15 18:29 WIB
**Session ID:** 20261115-182932-Z85Y (session node Z8-5Y, spawned by Z2-QN)
**Plan:** `.workflows/plan/DIRECT_STREAMING_PLAN.md` (10 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/direct-streaming`, branch `feature/direct-streaming` (base `origin/main` @ `d996abb`)

---

## User Input

### Original User Request

> direct-streaming feature --no-orchestrate
> Plan the direct streaming feature from the design brief at /home/miftah/mcp-notes/docs/plans/2026-11-15-direct-streaming-design.md. Read it in full first: it holds the owner's words, what the spike proved, the intended shape, and decisions D1-D7. The working spike (network sniffer, header-adding proxy, player driver, and the fmovies chunk with 24 provider templates) is in /home/miftah/mcp-notes/docs/plans/direct-streaming-spike/. Both are untracked in the main checkout for now, so read them by these absolute paths and do not add copies to your branch. Also read docs/guide/streaming.md, docs/guide/movies.md and docs/guide/architecture.md before planning. D1-D4 are the owner's and binding (English subtitle sources first; one click to a full-screen film; Stream is a switch at the top of /movies, not a side-panel entry; the Stream grid shows only verified titles). D5 and D6 are proposed and not yet confirmed by the owner: plan them as late phases behind a setting, and list them as the owner's to confirm. Follow D7 for build order: resolver, provider registry, daemon proxy and player page, and the /direct-stream and /update-cloud-source skills first; the Stream page and background prober after. The brief's untested list (token lifetime, DASH and VidNest playback, series episodes, subtitles in our player, the other 18 providers, why three providers returned nothing) should become explicit early work, not assumptions. This came out of session Z2-QN.

### User-Provided Context

- The brief, `docs/plans/2026-11-15-direct-streaming-design.md`, is the specification. Its **Why**
  section holds the owner's words and is copied verbatim into the plan index.
- **Change during this analysis.** While this session was reading, session Z2-QN committed the
  brief and the spike to `main` (`d996abb`, pushed) and sent a message: the owner has confirmed D5
  and D6. The brief at `d996abb` shows both with source "Owner, 2026-11-15". This was relayed by a
  peer session, not typed by the owner in this session. The plan treats D5 and D6 as confirmed
  (the brief is the document the request names as holding the decisions), keeps them in the late
  phases behind a setting as both the request and the message say, and records the provenance in
  the index's Decisions so the owner can overturn it.
- Because the brief and spike are now tracked in the base commit, the worktree contains them at
  `docs/plans/`. No copy was added by this branch.

### User-Provided Files

- `docs/plans/2026-11-15-direct-streaming-design.md`
- `docs/plans/direct-streaming-spike/{sniff.ps1,proxy.mjs,play.mjs,fmovies-movie-details-chunk.js}`
- `docs/guide/streaming.md`, `docs/guide/movies.md`, `docs/guide/architecture.md`

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | "Follow D7 for build order: resolver, provider registry, [...] first" with "D1-D4 are the owner's and binding (English subtitle sources first; [...])" |
| R2 | "daemon proxy and player page" with "one click to a full-screen film" |
| R3 | "the /direct-stream [...] skills first" |
| R4 | "and /update-cloud-source skills first" |
| R5 | "the Stream page [...] after" with "Stream is a switch at the top of /movies, not a side-panel entry; the Stream grid shows only verified titles" |
| R6 | "background prober after" with "D5 and D6 are proposed and not yet confirmed by the owner: plan them as late phases behind a setting, and list them as the owner's to confirm" |
| R7 | "The brief's untested list (token lifetime, DASH and VidNest playback, series episodes, subtitles in our player, the other 18 providers, why three providers returned nothing) should become explicit early work, not assumptions." |

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN `node claude/streaming/direct/cli.mjs resolve <movie\|tv> <tmdb id> [season episode]` is run THE SYSTEM SHALL print one JSON object naming the provider that resolved, the manifest address and kind, the request headers the manifest request carried, and the subtitle tracks seen |
| R1.2 | ubiquitous | THE SYSTEM SHALL try providers known to offer an English subtitle before those that do not, then by health, then by best quality |
| R1.3 | unwanted | IF a provider's embed answers with a bot check THEN THE SYSTEM SHALL skip that provider, record `bot_check` as its outcome, and try the next one without changing the client |
| R1.4 | ubiquitous | THE SYSTEM SHALL keep providers as data (a checked-in seed file loaded into a shared table) with health recorded per host |
| R2.1 | event | WHEN the player requests a playlist through the daemon's stream route THE SYSTEM SHALL fetch it with the headers the resolve captured and rewrite every address in it to come back through the route |
| R2.2 | unwanted | IF a stream-route request names a session that is unknown or expired, or a host that session's resolve did not return, THEN THE SYSTEM SHALL answer 403 and fetch nothing |
| R2.3 | event | WHEN the player page opens for a resolved session THE SYSTEM SHALL play the stream with the English subtitle shown by default when one exists and offer a quality choice |
| R2.4 | event | WHEN the player page reports a position THE SYSTEM SHALL record it on one `movie_plays` row for that play so the title's watch state derives from it as it does from a VLC play |
| R2.5 | unwanted | IF the stream route answers 401, 403 or 410 from the stream host mid-film THEN THE SYSTEM SHALL resolve again and continue from the last position |
| R2.6 | state | WHILE `NOTESD_MOVIES=off`, `NOTESD_DIRECT_STREAM=off` or `deps.directStream` is unset THE SYSTEM SHALL answer `direct_stream_off` on every direct-stream route and tool and start no Chrome |
| R3.1 | event | WHEN the owner types `/direct-stream <title>` and exactly one film matches THE SYSTEM SHALL resolve it and open the player page full screen in the streaming Chrome |
| R3.2 | unwanted | IF several titles match, or the title is a series and no episode can be chosen, THEN THE SYSTEM SHALL list the candidates and start nothing |
| R3.3 | unwanted | IF no provider resolves the title THEN THE SYSTEM SHALL answer `no_source` with each provider's outcome and start nothing |
| R4.1 | event | WHEN the owner types `/update-cloud-source <site url>` THE SYSTEM SHALL read the site's provider templates, add the ones the registry lacks, probe each new one against the known titles and report the outcome per provider |
| R4.2 | unwanted | IF the site's templates cannot be read THEN THE SYSTEM SHALL say so and leave the registry unchanged |
| R5.1 | event | WHEN the owner presses the Stream side of the switch at the top of `/movies` THE SYSTEM SHALL show the Stream grid in the same page, with no new entry in the rail or sidebar |
| R5.2 | ubiquitous | THE SYSTEM SHALL list on the Stream grid only titles with a source verified on this host inside the freshness window |
| R5.3 | event | WHEN Play is pressed on a title opened from the Stream grid THE SYSTEM SHALL start the stream player full screen with no further click |
| R5.4 | unwanted | IF a Stream title fails to resolve when Play is pressed THEN THE SYSTEM SHALL mark its source stale and the title SHALL leave the Stream grid |
| R5.5 | optional | WHERE a title has both a file on this host and a verified stream THE SYSTEM SHALL play the local file by default |
| R6.1 | optional | WHERE `NOTESD_STREAM_PROBER=on` THE SYSTEM SHALL turn TMDB candidates into verified titles up to the catalog size and re-check each inside the freshness window, within its per-pass budget |
| R6.2 | state | WHILE `NOTESD_STREAM_PROBER` is unset or `off` THE SYSTEM SHALL open no Chrome tab that was not asked for |
| R6.3 | complex | WHERE `NOTESD_STREAM_PROBER=on` WHILE the laptop is not idle THE SYSTEM SHALL start no probe |
| R7.1 | event | WHEN the probe campaign command is run THE SYSTEM SHALL write, for each of the 24 seed providers, either what it resolved (manifest kind, best quality, English subtitle, seconds) or the named cause of the failure |
| R7.2 | ubiquitous | THE SYSTEM SHALL record in the findings file the measured token lifetime and the episode template of every provider that resolves a series episode |
| R7.3 | ubiquitous | THE SYSTEM SHALL record in the findings file, for DASH playback, VidNest playback and subtitles in our player, whether each plays in the daemon's player page, and mark a provider that does not as `browser_only` in the seed |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement.** Today a film the library lacks is watched through `/idlix` or
`/lk21`: a real Chrome is driven through the site's page, adverts included (about 25 s on idlix).
The spike showed that aggregator sites are lists of embed URL templates keyed by TMDB id, that one
CDP network sniffer captures the manifest of an embed, that the stream host checks `Referer`, and
that a bare `<video>` page fed through a header-adding pass-through plays 2160p in about 9 s with
no adverts. The feature turns that into a subsystem: a provider registry, a resolver, a daemon
pass-through and player page, two skills, a Stream side of `/movies` that shows only verified
titles, and a background prober that fills it.

**Success Criteria.** The 24 criteria above. In the owner's terms: `/direct-stream saltburn`
ends in a full-screen film with an English subtitle when any provider has one; the Stream switch
on `/movies` shows a grid where every poster plays; a streamed play appears in history and moves
watch state like a VLC play; nothing new starts when the subsystem is off.

**Key Considerations.**

- `movie_plays.file_id` is `NOT NULL` and references `movie_files`, and the source check allows
  only `live` and `vlc_recents`. A streamed play has no file. Recording one "the same" needs a
  schema change, and `state.ts` and `read.ts` derive title state from files and their last plays.
- Chrome is reached only from Windows PowerShell (WSL cannot reach Windows loopback). The Windows
  Chrome does reach the daemon at `http://localhost:7317` (the wall is used that way; the spike
  page was served from WSL on 7399).
- `cdp.ps1` evaluates one expression in a tab chosen by origin host. The player page lives on the
  daemon's origin (`http://localhost:7317`); the spike drove it with `evaluateInChrome(ORIGIN, ...)`.
- The sniffer opens its own tab (`Target.createTarget`) and closes it; it does not bring the
  window forward. Sound is not muted by the spike.
- The spike proxy sends a hard-coded Chrome user agent from Node. The streaming rule is "never a
  disguised client to get past a site's bot check". The brief accepts the pass-through (finding 3
  and the Playing section); the header check is not a bot check. What the plan forwards is the
  header set the real Chrome's manifest request carried.
- The spike proxy listened on `0.0.0.0` and passed any URL. The daemon binds `127.0.0.1` only and
  must not be an open proxy.
- hls.js and dash.js came from a CDN in the spike. The web app has no such dependency; the
  full-screen photo page (`web/fullscreen.html`) is the precedent for a second small bundle.
- Docs are checked against the code (`tests/unit/docs/reference.test.ts`): a new route needs
  `scripts/docs/httpRoutes.ts` + `npm run docs:gen`; a new env var needs a configuration row; a
  new MCP tool needs `docs:gen`. Each phase carries its own.
- Live proof takes over the screen with sound (`features/streaming.md`: "Run it only when the
  owner expects it"). Resolving does not show a window.
- Drizzle migrations are numbered files plus `drizzle/meta`; two phases generating one at the same
  time collide.

**Assumptions.**

- A1. TMDB credentials are set on the owner's machine (the library already needs them).
- A2. Episode embed templates follow the film templates' shape (`/tv/<id>/<season>/<episode>`);
  this is unproven and is phase 2's work, not a premise of phase 1's code (phase 1 stores a
  nullable `tv` template per provider).
- A3. The header check on a stream host is not a bot check (see above).
- A4. D5 and D6 are confirmed (provenance above).

---

## Analysis Scope

### Explicitly Mentioned Files
- The brief and the four spike files; `docs/guide/{streaming,movies,architecture}.md`.

### Discovered Related Files
- `claude/streaming/{chrome.mjs,cdp.ps1,cli.mjs,play.mjs,match.mjs,sites/*}`: the existing Chrome path.
- `src/streaming/service.ts`, `src/mcp/streamingTools.ts`, `src/chat/status.ts` (`STREAMING_TOOL_NAMES`, `allowedChatTools`), `src/chat/prompt.ts`, `src/mcp/instructions.ts`.
- `src/deps.ts`, `src/daemon.ts`, `src/background.ts`, `src/config.ts`, `src/http/app.ts`, `src/http/static.ts`, `src/http/sameOrigin.ts`.
- `src/movies/{repo,read,state,types,tmdb,service,continue,player}.ts`, `src/http/{moviesApi,moviesPlayApi}.ts`, `src/mcp/movieTools.ts`.
- `src/db/schema.ts` (movie tables from line 968), `drizzle/0017..0019`.
- `web/src/pages/MoviesPage.tsx`, `web/src/components/movies/*`, `web/src/lib/{movies,route}.ts`, `web/src/hooks/useMovies.ts`, `web/src/moviesApi.ts`, `web/vite.config.ts`, `web/fullscreen.html`.
- `claude/skills/{idlix,lk21,create-streaming-skill}`, `scripts/install.sh` (links every folder of `claude/skills`).
- `scripts/docs/{httpRoutes.ts,envVars.ts,shots/movies.mjs}`, `docs/guide/reference/configuration.md`.
- `.claude/skills/verify-notesd/features/{streaming,movies}.md`, `scripts/verify.sh`.
- Tests: `tests/unit/streaming.test.ts`, `tests/unit/mcp.streamingTools.test.ts`, `tests/unit/scripts/streamingSites.test.ts`, `tests/unit/chat-status.test.ts`, `tests/unit/config.test.ts`, `tests/integration/movies.*.int.test.ts`, `web/src/App.movies.test.tsx`.

---

## Current Dataflow

### Entry point: `/idlix`, `/lk21`, `streaming_find`, `streaming_play`

**Location:** `claude/streaming/cli.mjs:15` (`main`), reached from the skills directly and from the
daemon through `scriptRunner` (`src/streaming/service.ts:37`), which `src/daemon.ts:144` builds
when `config.streaming?.enabled` and puts on `AppDeps.streaming` (`src/deps.ts:49`).
`mcpToolDeps` (`src/http/app.ts:69`) hands it to `registerStreamingTools`
(`src/mcp/streamingTools.ts:70`); without it both tools throw `STREAMING_OFF`.

**Processing chain**

1. `cli.mjs` picks the site module from `SITES` (`sites/index.mjs`), runs `site.search`,
   `pickMatches` (`match.mjs`), and with `--play` and exactly one film, `playTitle`.
2. `playTitle` (`claude/streaming/play.mjs:36`) calls `evaluateInChrome` to open the page with
   `show` and `closeOtherTabs`, runs the site's `start`, then `fillScreenExpression` with
   `windowState: 'fullscreen'`.
3. `evaluateInChrome` (`claude/streaming/chrome.mjs:32`) runs `cdp.ps1` through `powershell.exe`
   from `/mnt/c` and parses its last stdout line; a named failure becomes `ChromeError`.
4. `cdp.ps1` starts Chrome with the `notesd-stream-chrome` profile on port 9333 when it is not
   up (minimized, occlusion detection off), finds or opens a tab whose host equals `-Origin`'s,
   optionally shows the window and sets its state, evaluates one expression (optionally in a
   frame), and performs a real click when the value has `click: {x, y}`.

**Exit points:** one JSON object on stdout; the tools return it. Nothing is persisted.

### Entry point: VLC play (what a streamed play must match)

`POST /api/movies/files/:fileId/play` and `POST /api/movies/continue`
(`src/http/moviesPlayApi.ts:56,68`, both `sameOriginOnly`) and `movies_continue` end in
`MoviePlayer` (`src/movies/player.ts:230`). It writes through
`PlayerRepo = Pick<MoviesRepo, 'fileById' | 'lastPlay' | 'startPlay' | 'updatePlay' | 'endPlay' | 'closeOpenPlays' ...>`:
`startPlay` (`repo.ts:530`) inserts one `movie_plays` row, `updatePlay` (`repo.ts:549`) writes the
position on every poll, `endPlay` (`repo.ts:559`) closes it. `MovieEvents` emits `changed` with
reason `play`; the page listens on `/api/movies/events`.

**Read side:** `listTitles` / `getTitle` / `history` (`src/movies/read.ts:637,755,795`) join files
and plays; `fileState`, `resumePosition`, `titleState` (`src/movies/state.ts:34,47,63`) derive
state from `FileStateInput` and the last play. Nothing reads a play that has no file.

### The spike's flow (not in `src/`)

1. `sniff.ps1 -Url <embed>`: `Target.createTarget about:blank`, attach flat, `Network.enable` and
   `Target.setAutoAttach` on the page and every child session, navigate, collect requests whose URL
   matches `\.m3u8|\.mpd|\.mp4|\.vtt|\.srt|/playlist|/manifest|master\.` or whose response mime is
   media, with `Referer`, `Origin`, document, status and mime. Tabs opened by the page are closed.
   With no stream after 8 s it sends up to four real clicks at (400, 300). It lingers 4 s after the
   first manifest, closes the tab, prints one JSON object (`hits`, `frames`, `hosts`, `took_s`,
   `clicks`, `popups_closed`). Exit 3 with `{"error": ...}` for `no_chrome` / `chrome_not_reachable`.
2. `proxy.mjs`: `/play?src&ref&kind` serves a page with hls.js or dash.js; `/p?u&r` fetches `u`
   with `Referer` and `Origin` from `r`, forwards `Range`, rewrites `#EXTM3U` playlists (plain
   lines and `URI="..."` attributes) to come back through `/p`, pipes everything else.
3. `play.mjs`: `evaluateInChrome(ORIGIN, "location.assign(path)", { show: true, windowState: 'fullscreen' })`,
   then polls the `<video>` state.

### Data persistence today

- `movie_titles` (shared; `id = kind || '-' || tmdb_id`; no IMDb id column), `movie_episodes`,
  `movie_files` (per host, soft-deleted), `movie_plays` (`file_id NOT NULL`, source in
  `('live','vlc_recents')`), `movie_ids` (trigger-assigned). Only writer: `MoviesRepo`.
- `app_settings`: key and JSON value shared by both machines.
- `TmdbClient` (`src/movies/tmdb.ts:66`): `searchMovie`, `searchTv`, `movieDetails`, `tvDetails`,
  `trailers`, `searchPerson`, `personCredits`. No list endpoint (trending, popular, discover).

---

## Key Data Structures

### The 24 seed templates (`fmovies-movie-details-chunk.js`, object `$`)
All take the TMDB id. Films only; the chunk holds no episode template.

| Name | Template | Spike result |
|---|---|---|
| VidNest | `https://vidnest.fun/movie/${id}` | HLS behind `master.txt`, 2.9 s, 3 advert tabs |
| Videasy | `https://player.videasy.net/movie/${id}` | nothing in 35 s |
| VidKing | `https://www.vidking.net/embed/movie/${id}` | nothing in 35 s |
| Peachify | `https://peachify.top/embed/movie/${id}` | untested |
| Smashy | `https://player.smashystream.com/movie/${id}` | untested |
| VidUp | `https://vidup.to/movie/${id}?autoPlay=true` | untested |
| VidFast | `https://vidfast.pro/movie/${id}?autoPlay=true` | HLS 480p to 2160p, 2.3 s; `Referer: https://vidfast.vc/` required |
| VidLink | `https://vidlink.pro/movie/${id}?autoplay=true&title=true` | DASH, one `.srt`, 3.7 s |
| VidMov | `https://vidsrc.mov/embed/movie/${id}` | untested |
| VidFyi | `https://vidsrc.fyi/embed/movie/${id}` | untested |
| VidRock | `https://vidrock.net/movie/${id}` | untested |
| Movies111 | `https://111movies.com/movie/${id}` | untested |
| NonTongo | `https://www.nontongo.win/embed/movie/${id}` | untested |
| VidSrc | `https://vidsrc.me/embed/movie?tmdb=${id}` | untested |
| HyperLink | `https://vidsrc.wtf/api/1/movie/?id=${id}&color=215fb3` | untested |
| NexaStream | `https://vidsrc.wtf/api/2/movie/?id=${id}&color=215fb3` | untested |
| UltraBox | `https://player.vidplus.to/embed/movie/${id}` | untested |
| CloudBox | `https://vidify.top/embed/movie/${id}` | untested |
| UpCloud | `https://player.vidsrc.co/embed/movie/${id}` | untested |
| StreamVault | `https://hexa.watch/watch/movie/${id}` | untested |
| MediaHub | `https://spencerdevs.xyz/movie/${id}?theme=215fb3` | untested |
| CloudPlay | `https://vidsrc.cc/v2/embed/movie/${id}` | nothing in 35 s (the brief's "VidSrc (`vidsrc.cc`)") |
| StreamBoxHD | `https://test.autoembed.cc/embed/movie/${id}` | untested |
| MovieVault | `https://rivestream.org/embed?type=movie&id=${id}` | untested |

### `AppDeps` (`src/deps.ts:16`)
`streaming?: StreamingRunner | null` is the precedent for an optional, default-absent subsystem
handle; `movies: MoviesService | null` for a subsystem routes answer 503 without.

### `Config` (`src/config.ts:248`)
`movies: MoviesConfig` (`DEFAULT_MOVIES_CONFIG` off), `streaming?: StreamingConfig`
(`{ enabled }`, from `parseSwitch('NOTESD_STREAMING', ...)` at line 613).

---

## Dependencies

- **Configuration:** `NOTESD_MOVIES`, `NOTESD_STREAMING`, `TMDB_*`; `.env.local`.
- **Environment:** WSL with interop, `powershell.exe`, `wslpath`, Windows Chrome; Node >= 22.22
  (global `fetch`, `Readable.fromWeb`).
- **External services:** TMDB; the provider embed hosts and their stream hosts.
- **Web build:** Vite with two inputs (`index`, `fullscreen`); `src/http/static.ts:103` serves
  `fullscreen.html` for `/full/:imageId`.

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `evaluateInChrome`, `ChromeError`, `sleep` | `claude/streaming/chrome.mjs:15-32` | def | claude/streaming |
| Chrome start, profile, port 9333 | `claude/streaming/cdp.ps1:49-69` | def | claude/streaming |
| `SITES` | `claude/streaming/sites/index.mjs:5` | def | claude/streaming |
| `STREAMING_SITES`, `scriptRunner`, `StreamingRunner` | `src/streaming/service.ts:13,37,27` | def | src/streaming |
| `registerStreamingTools`, `STREAMING_OFF` | `src/mcp/streamingTools.ts:70,9` | def | src/mcp |
| `STREAMING_TOOL_NAMES`, `allowedChatTools` | `src/chat/status.ts:78,122` | def | src/chat |
| `AppDeps.streaming` | `src/deps.ts:49` | def | src |
| `streaming` built | `src/daemon.ts:144-145` | call | src |
| `mcpToolDeps`, `createApp` | `src/http/app.ts:69,104` | def | src/http |
| `StreamingConfig`, `parseSwitch('NOTESD_STREAMING')` | `src/config.ts:114,613` | config | src |
| `MOVIE_PLAY_SOURCES`, `moviePlays` | `src/db/schema.ts:970,1190-1215` | def | src/db |
| `MoviesRepo.startPlay/updatePlay/endPlay/lastPlay/latestPlay` | `src/movies/repo.ts:530-616` | def | src/movies |
| `fileState`, `titleState`, `resumePosition` | `src/movies/state.ts:34,63,47` | def | src/movies |
| `listTitles`, `getTitle`, `history` | `src/movies/read.ts:637,755,795` | def | src/movies |
| `TmdbClient` | `src/movies/tmdb.ts:66` | def | src/movies |
| `moviesPlayRoutes` | `src/http/moviesPlayApi.ts:46` | def | src/http |
| `MoviesPage`, toolbar `.mv-tools` | `web/src/pages/MoviesPage.tsx:46,100` | def | web |
| `MoviesRoute`, `moviesRouteFromLocation`, `moviesHref` | `web/src/lib/route.ts:121-148` | def | web |
| Vite inputs | `web/vite.config.ts:18-21` | config | web |
| `NOTESD_STREAMING`, `IDLIX_ORIGIN`, `LK21_ORIGIN` rows | `docs/guide/reference/configuration.md:124-126` | doc | docs |
| Streaming and movies feature maps | `.claude/skills/verify-notesd/features/{streaming,movies}.md` | doc | verify |
| `scriptRunner` tests, tool tests, site registry test | `tests/unit/streaming.test.ts`, `tests/unit/mcp.streamingTools.test.ts`, `tests/unit/scripts/streamingSites.test.ts` | test | tests |

---

## Impact Points (files that WILL need changes)

1. `claude/streaming/direct/*` (new): seed, sniffer, resolver, CLI. Phase 1; campaign scripts phases 2 and 6; template reader phase 8.
2. `src/directStream/*` (new), `src/deps.ts`, `src/daemon.ts`, `src/config.ts`, `src/http/app.ts`, `src/http/directStreamApi.ts` (new), `src/db/schema.ts` + one migration: provider tables, service, sessions, pass-through. Phase 3.
3. `web/stream.html`, `web/src/stream/*` (new), `web/vite.config.ts`, `src/http/static.ts`, `package.json` (hls.js, dash.js): the player page. Phase 4.
4. `src/db/schema.ts` + one migration, `src/movies/{repo,types,state,read}.ts`, position route: stream plays and verified sources. Phase 5.
5. `src/mcp/directStreamTools.ts` (new), `src/chat/{status,prompt}.ts`, `src/mcp/instructions.ts`, `src/movies/tmdb.ts` use, `claude/skills/direct-stream/` (new). Phase 7.
6. `claude/skills/update-cloud-source/` (new), template reader, registry tool. Phase 8.
7. `web/src/pages/MoviesPage.tsx`, `web/src/components/movies/*`, `web/src/lib/{movies,route}.ts`, `web/src/hooks/useMovies.ts`, `web/src/moviesApi.ts`, `src/http/moviesApi.ts`, `src/movies/read.ts`, `scripts/docs/shots/movies.mjs`. Phase 9.
8. `src/directStream/prober.ts` (new), `src/movies/tmdb.ts` (lists), `src/background.ts`, `src/config.ts`. Phase 10.
9. `docs/guide/{streaming,movies,architecture}.md`, `docs/guide/reference/*`, `scripts/docs/{httpRoutes,envVars}.ts`, `.claude/skills/verify-notesd/features/*`: with the phase that changes the behaviour.
10. `docs/plans/2026-11-15-direct-streaming-findings.md` (new): phases 2 and 6.

**This document describes. The plan files prescribe.**
