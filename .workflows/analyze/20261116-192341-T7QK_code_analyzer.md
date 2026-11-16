# Code Analysis: torrent as a direct-stream source

**Type:** Feature Implementation
**Date:** 2026-11-16 19:23 (WIB)
**Session ID:** 20261116-192341-T7QK
**Plan:** `.workflows/plan/TORRENT_STREAM_SOURCE_PLAN.md` (9 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/torrent-stream-source`, branch `feature/torrent-stream-source` (base `origin/main` @ `4792920`)

---

## User Input

### Original User Request

First message:

> work in a new worktree..
> look at this website: https://ext.to/
> https://1337x.la/popular-movies
>
> they are sites providing torrent movies..
> my idea is that, we use torrent as a source to live streaming.. is this possible?
> we can choose a torrent that has high seeds? (i don't understand much myself)
> anyway, i think the problem is subtitle..
>
> so from mcp-notes, agent will access these sites and search for relevant movies/series..
> then agent will download the top torrent file with a high seeds number
> then we stream it..
> i really have heard somewhere that there is a website or an app where people can stream but using torrent as the source.. i just can't remember what the website is..
>
> let's discuss this first. from your technical expertise. major requirements:
> 1. finding the relevant torrent file
> 2. streaming video using that torrent file
> 3. making sure we have english subtitle by any means necessary..
> i think i've seen that one torrent file can have several files inside, so it has the movie file and the subtitle file.. maybe we can make use of this?

Second message, after the discussion:

> YESS. stremio .. that's it..!!!
> i accept the catch. let's do it
>
> 1. Should this be a new source inside /direct-stream (same player, same subtitle drawing, torrent tried when cloud providers fail or on request), or a separate command? I'd make it a source inside direct-stream.
> answer: let's do it as you say
> 2. Do you have a VPN on this laptop, or should the first version just cap upload and accept the exposure?
> answer: just accept the exposure for this first iteration.. our main objective tonight is to see a streaming movie FROM TORRENT..
> holy shitt.. tonight we are creating our own stremio!!! HOLY FABLE!!!
>
> /analyze this shit so we build the best and ship the best of the best

### User-Provided Context

What the discussion settled (the assistant's proposal, accepted with "let's do it as you say"):

- Torrent is a source inside `/direct-stream`: same player page, same subtitle drawing, tried when the cloud providers fail or when asked for by name. Not a separate command.
- JSON indexes keyed by IMDb id come before scraping; 1337x and ext.to sit behind bot checks, so they go through the streaming Chrome, as a fallback only, and never with a disguised client.
- Magnet links: no `.torrent` file is needed, and the file list arrives from the swarm before any download.
- The picker weighs seeds, codec (H.264/AAC MP4 plays in Chrome as is; MKV, x265, AC3/DTS need an ffmpeg remux that copies the video and converts the audio), size, original language (skip `DUBBED`/`DUAL`), and prefers a torrent whose files include an English `.srt`.
- WebTorrent as a library inside notesd, sequential download, the file served over local HTTP with range requests; the download doubles as the cache.
- Subtitles in order: `.srt` in the torrent; an embedded text track (PGS unusable); a subtitle service matched to the release; Whisper as the last resort.
- The catch, accepted: a torrent client uploads to peers and the IP is visible to the swarm. First iteration: cap upload, no VPN. The daemon only ever opens video and subtitle files and never executes anything from a torrent.

### User-Provided Files

None.

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | "1. finding the relevant torrent file" — "so from mcp-notes, agent will access these sites and search for relevant movies/series.. then agent will download the top torrent file with a high seeds number" — "we can choose a torrent that has high seeds?" |
| R2 | "2. streaming video using that torrent file" — "we use torrent as a source to live streaming" — "our main objective tonight is to see a streaming movie FROM TORRENT" — (a new source inside /direct-stream) "let's do it as you say" — "just accept the exposure for this first iteration" |
| R3 | "3. making sure we have english subtitle by any means necessary.. i think i've seen that one torrent file can have several files inside, so it has the movie file and the subtitle file.. maybe we can make use of this?" |

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN the torrent finder is asked for a film or an episode THE SYSTEM SHALL ask the JSON torrent indexes (Torrentio, apibay, EZTV for a series, YTS for a film) by the title's IMDb id and answer candidates that each carry an info hash, a release name, a seed count and a size |
| R1.2 | ubiquitous | THE SYSTEM SHALL order candidates so that none under the minimum seed count is ever picked, a release Chrome plays as is comes before one that needs a remux, and among equals the one with more seeds comes first |
| R1.3 | unwanted | IF a release name marks a dub, a cinema recording (CAM, TS, TELESYNC, HDCAM) or 3D THEN THE SYSTEM SHALL leave that candidate out |
| R1.4 | event | WHEN an episode of a series is asked for THE SYSTEM SHALL keep only candidates that name that season and episode or a pack that holds it, and SHALL choose the file of that episode inside a pack |
| R1.5 | unwanted | IF an index does not answer, answers an error or answers a bot check THEN THE SYSTEM SHALL record that index's outcome, go on with the others, and send no request that poses as another client |
| R1.6 | unwanted | IF the audio streams of the chosen file name languages and none is the title's original language THEN THE SYSTEM SHALL record the candidate as `dubbed` and try the next one |
| R1.7 | optional | WHERE the JSON indexes answer no usable candidate THE SYSTEM SHALL search 1337x and ext.to through the streaming Chrome and add what they list as candidates |
| R2.1 | event | WHEN a byte range of a torrent's chosen file is requested from the daemon THE SYSTEM SHALL answer 206 with exactly those bytes, fetching the pieces of that range before the rest of the file |
| R2.2 | ubiquitous | THE SYSTEM SHALL download from a torrent only the chosen video file and its subtitle files, write them only under the torrent folder, and never execute a file from a torrent |
| R2.3 | ubiquitous | THE SYSTEM SHALL cap the upload rate at the configured limit and leave the swarm once no stream session uses the torrent |
| R2.4 | event | WHEN `direct_stream_play` is called with the provider `torrent` THE SYSTEM SHALL make a stream session whose manifest is the torrent's video file on this daemon and open the player page on it |
| R2.5 | unwanted | IF no cloud provider resolves the title THEN THE SYSTEM SHALL try the torrent source before it answers `no_source`, and the answer's attempts SHALL list each torrent tried with its outcome |
| R2.6 | optional | WHERE torrents are off (`NOTESD_TORRENT=off`) THE SYSTEM SHALL join no swarm, ask no index, and answer `torrent_off` to a play that names the torrent provider |
| R2.7 | state | WHILE a torrent session plays THE SYSTEM SHALL show on the player page the peers, the download speed and the stretches of the film that are on disk |
| R2.8 | optional | WHERE the chosen file is not one Chrome plays as is THE SYSTEM SHALL play an ffmpeg remux of it (video copied, audio converted to AAC) instead of the file |
| R2.9 | event | WHEN a title whose torrent download is complete on this machine is played again THE SYSTEM SHALL play it from disk without asking an index or joining a swarm |
| R3.1 | event | WHEN the torrent holds an English subtitle file (or exactly one subtitle file that names no language) THE SYSTEM SHALL serve it as WebVTT in the session's subtitles and the player SHALL show it by default |
| R3.2 | event | WHEN several of the best candidates' file lists are known THE SYSTEM SHALL prefer the one that holds an English subtitle file |
| R3.3 | event | WHEN the torrent holds no usable subtitle file THE SYSTEM SHALL fetch an English subtitle from a subtitle service, matched to the file by its hash and else by the IMDb id, and when that fails take one from a cloud provider |
| R3.4 | event | WHEN the chosen file carries an English text subtitle track and no subtitle file was found THE SYSTEM SHALL extract it with ffmpeg and the player SHALL show its cues as they are extracted |
| R3.5 | unwanted | IF the only embedded subtitle tracks are pictures (PGS, VobSub) THEN THE SYSTEM SHALL ignore them and go on to the next subtitle tier |
| R3.6 | event | WHEN no other tier gives an English subtitle THE SYSTEM SHALL transcribe the audio with Whisper (translating to English when the title's original language is not English) and the player SHALL show the cues as they are produced |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement**: Direct streaming today plays only what a cloud provider's embed page hands over: an HLS or DASH manifest or a plain file on a stream host, fetched through the pass-through with captured headers. A title no provider carries answers `no_source`. The request adds a second kind of source: a BitTorrent swarm. The daemon finds a torrent of the title, joins the swarm, downloads the one video file in playing order, and serves it to the same player page from its own disk. The player page, the session model, the resume position, the position reports, the Movies page marks and the history all stay as they are.

**Success Criteria**: `direct_stream_play` with `provider: "torrent"` (and any title whose cloud resolve ends in `no_source`) opens the existing player page full screen on a film that is downloading from a swarm, starts within about half a minute on a well-seeded torrent, seeks anywhere, and shows an English subtitle. A second play of the same title starts from disk.

**Key Considerations**:

- **Nothing stores an IMDb id.** Titles are keyed by TMDB id (`StreamRef`); the torrent indexes are keyed by IMDb id. TMDB's `external_ids` gives it; `src/movies/tmdb.ts` has no call for it yet.
- **What Chrome plays as is.** The page's native engine (`web/src/stream/nativeEngine.ts`) plays `manifest_kind: "mp4"` with a `<video src>`. H.264 with AAC in MP4 plays. MKV, HEVC, AC3, E-AC3 and DTS do not reliably. `ffmpeg` and `ffprobe` 6.1.1 are installed at `/usr/bin`.
- **An HLS engine exists** (`hlsEngine.ts`, hls.js 1.7.4) and plays local playlists from the stream cache's file route, so a remux to HLS has a player.
- **A session can already play from local files.** `StreamSession.cache` (`sessions.ts`) replaces the pass-through addresses with a local route's (`cachePlay.ts`: `cacheSource`, `SessionCache`); `refresh`, `switchSource` and `cacheSession` in `service.ts` each have a branch for it. A torrent session needs the same kind of branch in the same places.
- **The stream cache cannot hold a torrent.** `stream_caches` and `src/directStream/cache/` are built around a resolved HLS source: segment counts, token refreshes, a resolve per download. A plain file there is downloaded by byte ranges from a stream host. A torrent download has none of that, so it needs its own record.
- **Two machines share the database, not the disk.** A torrent download is on one host; the other must see `available: false` / 404 `not_on_this_machine`.
- **WSL2 NAT.** Peers cannot connect in; only outgoing connections work. Fine for well-seeded torrents.
- **Exposure.** The daemon uploads while it downloads. The owner accepted this for the first iteration; the upload rate is capped and the swarm is left when nothing plays.
- **Probed on 2026-11-16 from this machine** (samples in `.workflows/analyze/torrent-samples/`):
  - `https://torrentio.strem.fun/stream/movie/tt<id>.json` and `/stream/series/tt<id>:<s>:<e>.json`: 200, JSON, no key. Each stream has `infoHash`, `fileIdx`, `behaviorHints.filename`, and a `title` whose lines hold the release name, the file name (packs), and `👤 <seeds> 💾 <size> ⚙️ <index>`.
  - `https://apibay.org/q.php?q=tt<id>`: 200, JSON, no key: `name`, `info_hash`, `seeders`, `leechers`, `size`, `num_files`, `imdb`.
  - `https://eztvx.to/api/get-torrents?imdb_id=<digits>`: 200, JSON, no key: `hash`, `filename`, `magnet_url`, seeds, season, episode.
  - `https://yts.mx/api/v2/list_movies.json?query_term=tt<id>`: timed out after 20 s from this network. It must be optional and its address a setting.
  - `https://opensubtitles-v3.strem.io/subtitles/movie/tt<id>.json`: 200, JSON, no key: a list of `{id, url, lang: "eng", SubEncoding, subtitleFileName}` with direct `.srt` addresses. This is the subtitle service Stremio uses.
  - `https://sub.wyzie.io/search`: 401, an API key is required. Not usable without a manual step.
- **`webtorrent` on npm is 3.0.21**, `engines.node >= 22`. Its API must be read from the installed package, not from memory of version 1 or 2.
- **No Whisper, no GPU.** `whisper`, `whisper-cli` and `faster_whisper` are absent; no `nvidia-smi`. 22 cores, 23 GB RAM, Python 3 from miniconda. A CPU Whisper has to be installed by `scripts/install.sh`.
- **Disk:** 812 GB free on `/`.
- **A public-domain test film exists in the real indexes:** Sintel (2010), IMDb `tt1727587`. Torrentio, apibay and the subtitle service all answer for it, so live checks need no pirated title.

**Assumptions** (inferences, stated):

- "Asked for by name" means `direct_stream_play`'s existing `provider` argument with the value `torrent` ("stream it from a torrent").
- Torrents are on by default once direct streaming is on (the owner asked for the feature and accepted the exposure); `NOTESD_TORRENT=off` turns them off; tests use an off default.
- The by-hand shuffle button on a torrent session moves to the next torrent candidate; the page's automatic stall move is off for a torrent session, since a torrent that buffers is filling, not failing.
- The chat bar gets the torrent source through the same `direct_stream_play` tool and needs no tool of its own.
- A finished torrent download is kept for replay and cleared by itself after a week without a play.

---

## Analysis Scope

### Explicitly Mentioned Files

None.

### Discovered Related Files

- `docs/guide/streaming.md`: the direct streaming guide (resolver, sessions, pass-through, player, cache, picture check).
- `src/directStream/service.ts`: `DirectStreamService` (play, resolve, refresh, switchSource, cacheSession, switchEpisode, sessionInfo, runResolve).
- `src/directStream/sessions.ts`: `StreamSession`, `SessionStore`.
- `src/directStream/types.ts`: `StreamRef`, `ResolvedSource`, `ResolveAttempt`, `ResolveOutcome`, `DirectStreamError`.
- `src/directStream/cachePlay.ts`: the local-source precedent (`SessionCache`, `cacheSource`, `playable`).
- `src/directStream/cache/` (`types.ts`, `serve.ts`, `subtitle.ts`, `service.ts`): the file route with `Range`, SRT to WebVTT, the per-host cache rows.
- `src/directStream/runner.ts`, `claude/streaming/direct/cli.mjs`: running the resolver and `open --fullscreen`.
- `src/directStream/picture.ts`: reading frames with ffmpeg (how ffmpeg is spawned and injected here).
- `src/http/directStreamApi.ts`, `streamCacheApi.ts`, `streamCachePlayApi.ts`: the `/api/stream/*` routes.
- `src/mcp/directStreamTools.ts`: `direct_stream_play` (its `provider` argument, line 489).
- `src/config.ts` (`DirectStreamConfig`, `parseDirectStream`, lines 193 to 225 and 692 to 700).
- `src/daemon.ts` (lines 174 to 256), `src/deps.ts`, `src/background.ts` (lines 189 to 221): wiring, start and close.
- `src/movies/tmdb.ts`: the TMDB client (no `external_ids` call).
- `src/db/schema.ts` (`stream_caches`, line 1488; `STREAM_HEALTH_OUTCOMES`).
- `web/src/stream/`: `session.ts` (parseSession), `createEngine.ts`, `nativeEngine.ts`, `hlsEngine.ts`, `controller.ts`, `StreamApp.tsx`, `subtitles.ts`, `stream.css`.
- `claude/skills/direct-stream/SKILL.md`, `src/chat/prompt.ts`, `src/mcp/instructions.ts`.
- `claude/streaming/chrome.mjs`, `cdp.ps1`, `claude/streaming/sites/*.mjs`: how a site is asked inside the streaming Chrome.
- `.claude/skills/verify-notesd/` (`features/direct-streaming.md`, `scripts/verify.sh`, `scripts/direct-stream/`, `scripts/stream/`): the proof harness and its fixture stream host.
- `scripts/install.sh`, `scripts/docs/httpRoutes.ts`, `scripts/docs/envVars.ts`, `docs/guide/reference/configuration.md`.

---

## Current Dataflow

### Entry Point: `direct_stream_play`

**Location:** `src/mcp/directStreamTools.ts:478`
**Trigger:** the MCP tool, from Claude Code or the chat bar; also `POST /api/stream/play` (`src/http/directStreamApi.ts`) and the Movies page.
**Input Schema:** `{ title, kind?, year?, season?, episode?, absolute_episode?, provider?, asked_as? }`
**Validation:** the lookup (`lookup.ts`) turns words, a movie id or a title key into one TMDB title; a series picks an episode (`episodePick.ts`).
**Next Step:** `DirectStreamService.play(ref, { resumeS, provider })` at `src/directStream/service.ts:247`.

### Processing Chain

1. **`play()`** (`service.ts:247`)
   - With `provider`: `resolve(ref, { only })`, the cache passed over.
   - Without: `cachedSession(ref)` (this host's stream cache, when `playable`), else `resolve(ref)`.
   - Then `openPage(session)`.
2. **`resolve()`** (`service.ts:233`) calls `resolveSource()` (`:668`), which calls `runResolve()` (`:581`), runs the `recordResolve` hook, and throws `DirectStreamError('no_source', …, { attempts })` or `resolve_failed`.
3. **`runResolve()`** writes the provider registry and health to temp files and runs `node claude/streaming/direct/cli.mjs resolve <kind> <tmdb id> [season episode] --audio-lang <code> …` through `this.runner`, one at a time (`serial`, `:775`). The answer (`parseResolveOutput`) is a `ResolvedSource`: `provider`, `manifest_url`, `manifest_kind` (`hls`, `dash`, `mp4`), captured headers, `subtitles`, `best_height`, `audio`.
4. **`SessionStore.create()`** (`sessions.ts:76`) makes the in-memory `StreamSession` (32-character id, `source`, `attempts`, `allowedHosts`, `resumeS`, `audioLang`, `cache`).
5. **`openPage()`** (`service.ts:274`) runs `cli.mjs open <pageBase>/stream/<id> --fullscreen` and answers `PlayResult { page_url, session: SessionInfo, attempts }`.
6. **The player page** (`web/src/stream/`) reads `GET /api/stream/sessions/<id>` (`sessionInfo()`, `service.ts:723`), builds an engine by `manifest_kind` (`createEngine.ts`), and loads `manifest_url`: a pass-through address, or the cache's file route when `session.cache` is set.
7. **While it plays**: position reports (`POST …/position`), log lines (`POST …/events`), `refresh` on a refused token (`service.ts:367`), `switchSource` on stalls or the shuffle button (`:439`), `cacheSession` on a pause (`:400`), `switchEpisode` on previous/next (`:470`).

### Data Persistence

**Database:** provider health (`stream_provider_health`, by `recordHealth`, only for providers in the registry), plays (`movie_plays`, through the movies hooks, with `session.source.provider`), stream caches (`stream_caches`).
**Memory:** sessions (lost on restart).
**Disk:** `<data dir>/movies/stream-cache/<cache id>/`, the evidence log, `stream-pictures.json`.

### Exit Points

- `PlayResult`, or `DirectStreamError`: `no_source` (attempts listed), `resolve_failed`, `open_failed`, `unknown_session`, `no_episode`, `no_subtitle`.
- The player page full screen in the streaming Chrome.

---

## Key Data Structures

### `StreamSession` (`src/directStream/sessions.ts:17`)
`id`, `ref`, `source: ResolvedSource`, `attempts`, `allowedHosts`, `resumeS`, `audioLang`, `cache: SessionCache | null`, `refreshes`, `avoid`. Used by every method of `DirectStreamService`, `passThrough.ts`, `evidence.ts`.

### `ResolvedSource` (`src/directStream/types.ts:88`)
`provider`, `embed_url`, `manifest_url`, `manifest_kind`, `headers`, `subtitles: SubtitleTrack[]`, `best_height`, `en_subtitle`, `audio`, `took_s`. `cacheSource()` builds a stand-in for a local source.

### `ResolveAttempt` / `ResolveOutcome` (`types.ts:39`, `:44`)
`{ provider, outcome, took_s, detail }`; outcomes are the health outcomes (`resolved`, `no_stream`, `bot_check`, `error`) plus `dubbed`, `skipped_browser_only`, `skipped_no_template`.

### `SessionInfo` (`service.ts:92`) and the page's `StreamSession` (`web/src/stream/session.ts:15`)
What the page reads: `manifest_kind`, `manifest_url`, `subtitles[{url, lang, label, format, source, english}]`, `audio_lang`, `resume_s`, `prev_episode`, `next_episode`, `cached`.

### `SessionCache` / `CachePlayView` (`cachePlay.ts`)
The local-source precedent: `{ id, state, height, manifestUrl, subtitles }`.

---

## Dependencies

### Configuration / Environment
`NOTESD_DIRECT_STREAM`, `NOTESD_MOVIES`, `NOTESD_STREAM_CACHE_DIR`, `NOTES_DATA_DIR`, `TMDB` key (movies config). Every new variable needs a row in `docs/guide/reference/configuration.md` or `npm test` fails (`tests/unit/docs/reference.test.ts`).

### External Services
TMDB; the streaming Chrome on Windows (`cdp.ps1`); the stream hosts. New: the torrent indexes, the swarm (trackers, DHT, peers), the subtitle service, `ffmpeg`/`ffprobe`, a CPU Whisper.

---

## Impact Points (files that WILL need changes)

1. `package.json`, `package-lock.json`: the `webtorrent` dependency. Phase 1.
2. `src/directStream/torrent/` (new): the engine, the per-host download records, the file route's reads. Phase 1.
3. `src/db/schema.ts`, `drizzle/`: a table for torrent downloads per host. Phase 1.
4. `src/config.ts`: `TorrentConfig` (phase 1), the finder's settings (phase 3), remux, subtitle and Whisper settings (phases 5 to 8).
5. `src/http/` (new `streamTorrentApi.ts`), `src/http/app.ts`, `scripts/docs/httpRoutes.ts`: the torrent routes. Phase 1; later phases add their own routes.
6. `src/directStream/torrent/find/` (new): the indexes, the release-name reader, the picker. Phase 2.
7. `src/movies/tmdb.ts`: `external_ids` for the IMDb id. Phase 3.
8. `src/directStream/service.ts`, `sessions.ts`, `types.ts`: a torrent session and its branches in `play`, `refresh`, `switchSource`, `cacheSession`, `switchEpisode`, `sessionInfo`. Phase 3.
9. `src/daemon.ts`, `src/deps.ts`, `src/background.ts`: building, starting and closing the torrent service. Phases 1 and 3.
10. `src/mcp/directStreamTools.ts`, `src/mcp/instructions.ts`, `src/chat/prompt.ts`, `claude/skills/direct-stream/SKILL.md`: the provider `torrent`. Phase 3.
11. `web/src/stream/session.ts`, `StreamApp.tsx`, `controller.ts`, `nativeEngine.ts`, `stream.css`: the torrent status and the loaded bar. Phase 4.
12. `src/directStream/torrent/remux.ts` (new), `web/src/stream/hlsEngine.ts`: the ffmpeg remux and its growing playlist. Phase 5.
13. `src/directStream/torrent/subtitles/` (new): subtitle files in the torrent, the subtitle service, the cloud borrow (phase 6); the embedded track and the growing cue feed, with `web/src/stream/subtitles.ts` (phase 7); Whisper, with `scripts/install.sh` (phase 8).
14. `claude/streaming/torrent/` (new): 1337x and ext.to through the streaming Chrome. Phase 9.
15. `docs/guide/streaming.md`, `docs/guide/reference/configuration.md`, the generated references, `.claude/skills/verify-notesd/features/direct-streaming.md` and its scripts: every phase, for its own part.

**This document describes. The plan files prescribe.**
