# Plan: torrent as a direct-stream source

**Slug:** torrent-stream-source
**Date:** 2026-11-16 19:23 (WIB)
**Analysis:** `.workflows/analyze/20261116-192341-T7QK_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/torrent-stream-source`
**Branch:** `feature/torrent-stream-source` (base: `origin/main` @ `4792920`)
**Phases:** 9
**Status:** planned
**Coordinator:** —

---

## Why

> my idea is that, we use torrent as a source to live streaming.. is this possible?
> we can choose a torrent that has high seeds? (i don't understand much myself)
> anyway, i think the problem is subtitle..
>
> so from mcp-notes, agent will access these sites and search for relevant movies/series..
> then agent will download the top torrent file with a high seeds number
> then we stream it..
>
> major requirements:
> 1. finding the relevant torrent file
> 2. streaming video using that torrent file
> 3. making sure we have english subtitle by any means necessary..
> i think i've seen that one torrent file can have several files inside, so it has the movie file and the subtitle file.. maybe we can make use of this?
>
> i accept the catch. let's do it
> (a new source inside /direct-stream, not a separate command) let's do it as you say
> just accept the exposure for this first iteration.. our main objective tonight is to see a streaming movie FROM TORRENT..
> /analyze this shit so we build the best and ship the best of the best

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | "1. finding the relevant torrent file" — "so from mcp-notes, agent will access these sites and search for relevant movies/series.. then agent will download the top torrent file with a high seeds number" — "we can choose a torrent that has high seeds?" | 2, 3, 9 |
| R2 | "2. streaming video using that torrent file" — "we use torrent as a source to live streaming" — "our main objective tonight is to see a streaming movie FROM TORRENT" — (a new source inside /direct-stream) "let's do it as you say" — "just accept the exposure for this first iteration" | 1, 3, 4, 5 |
| R3 | "3. making sure we have english subtitle by any means necessary.. i think i've seen that one torrent file can have several files inside, so it has the movie file and the subtitle file.. maybe we can make use of this?" | 6, 7, 8 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN the torrent finder is asked for a film or an episode THE SYSTEM SHALL ask the JSON torrent indexes (Torrentio, apibay, EZTV for a series, YTS for a film) by the title's IMDb id and answer candidates that each carry an info hash, a release name, a seed count and a size | 2 | P2.J1, P2.J6 |
| R1.2 | ubiquitous | THE SYSTEM SHALL order candidates so that none under the minimum seed count is ever picked, a release Chrome plays as is comes before one that needs a remux, and among equals the one with more seeds comes first | 2 | P2.J2 |
| R1.3 | unwanted | IF a release name marks a dub, a cinema recording (CAM, TS, TELESYNC, HDCAM) or 3D THEN THE SYSTEM SHALL leave that candidate out | 2 | P2.J3 |
| R1.4 | event | WHEN an episode of a series is asked for THE SYSTEM SHALL keep only candidates that name that season and episode or a pack that holds it, and SHALL choose the file of that episode inside a pack | 2, 3 | P2.J4, P3.J5 |
| R1.5 | unwanted | IF an index does not answer, answers an error or answers a bot check THEN THE SYSTEM SHALL record that index's outcome, go on with the others, and send no request that poses as another client | 2 | P2.J5, P2.J6 |
| R1.6 | unwanted | IF the audio streams of the chosen file name languages and none is the title's original language THEN THE SYSTEM SHALL record the candidate as `dubbed` and try the next one | 3 | P3.J4 |
| R1.7 | optional | WHERE the JSON indexes answer no usable candidate THE SYSTEM SHALL search 1337x and ext.to through the streaming Chrome and add what they list as candidates | 9 | P9.J1, P9.J2, P9.J3, P9.J4, P9.J5 |
| R2.1 | event | WHEN a byte range of a torrent's chosen file is requested from the daemon THE SYSTEM SHALL answer 206 with exactly those bytes, fetching the pieces of that range before the rest of the file | 1 | P1.J1, P1.J6 |
| R2.2 | ubiquitous | THE SYSTEM SHALL download from a torrent only the chosen video file and its subtitle files, write them only under the torrent folder, and never execute a file from a torrent | 1 | P1.J2, P1.J6 |
| R2.3 | ubiquitous | THE SYSTEM SHALL cap the upload rate at the configured limit and leave the swarm once no stream session uses the torrent | 1 | P1.J3, P1.J6 |
| R2.4 | event | WHEN `direct_stream_play` is called with the provider `torrent` THE SYSTEM SHALL make a stream session whose manifest is the torrent's video file on this daemon and open the player page on it | 3 | P3.J2 |
| R2.5 | unwanted | IF no cloud provider resolves the title THEN THE SYSTEM SHALL try the torrent source before it answers `no_source`, and the answer's attempts SHALL list each torrent tried with its outcome | 3 | P3.J1 |
| R2.6 | optional | WHERE torrents are off (`NOTESD_TORRENT=off`) THE SYSTEM SHALL join no swarm, ask no index, and answer `torrent_off` to a play that names the torrent provider | 1, 3 | P1.J5, P1.J7, P3.J6 |
| R2.7 | state | WHILE a torrent session plays THE SYSTEM SHALL show on the player page the peers, the download speed and the stretches of the film that are on disk | 4 | P4.J1, P4.J2 |
| R2.8 | optional | WHERE the chosen file is not one Chrome plays as is THE SYSTEM SHALL play an ffmpeg remux of it (video copied, audio converted to AAC) instead of the file | 5 | P5.J1, P5.J2, P5.J3, P5.J4, P5.J5, P5.J6, P5.J7 |
| R2.9 | event | WHEN a title whose torrent download is complete on this machine is played again THE SYSTEM SHALL play it from disk without asking an index or joining a swarm | 1, 3 | P1.J4, P1.J7, P3.J3 |
| R3.1 | event | WHEN the torrent holds an English subtitle file (or exactly one subtitle file that names no language) THE SYSTEM SHALL serve it as WebVTT in the session's subtitles and the player SHALL show it by default | 6 | P6.J1, P6.J2, P6.J3, P6.J4 |
| R3.2 | event | WHEN several of the best candidates' file lists are known THE SYSTEM SHALL prefer the one that holds an English subtitle file | 6 | P6.J9 |
| R3.3 | event | WHEN the torrent holds no usable subtitle file THE SYSTEM SHALL fetch an English subtitle from a subtitle service, matched to the file by its hash and else by the IMDb id, and when that fails take one from a cloud provider | 6 | P6.J5, P6.J6, P6.J7, P6.J8 |
| R3.4 | event | WHEN the chosen file carries an English text subtitle track and no subtitle file was found THE SYSTEM SHALL extract it with ffmpeg and the player SHALL show its cues as they are extracted | 7 | P7.J1, P7.J2, P7.J3 |
| R3.5 | unwanted | IF the only embedded subtitle tracks are pictures (PGS, VobSub) THEN THE SYSTEM SHALL ignore them and go on to the next subtitle tier | 7 | P7.J4, P7.J5 |
| R3.6 | event | WHEN no other tier gives an English subtitle THE SYSTEM SHALL transcribe the audio with Whisper (translating to English when the title's original language is not English) and the player SHALL show the cues as they are produced | 8 | P8.J1, P8.J2, P8.J3 |

## Scope

**In scope:** a torrent source inside direct streaming: finding torrents by IMDb id, the WebTorrent engine in the daemon, the local file route, torrent sessions in the existing player page, the remux for files Chrome cannot play, four subtitle tiers, the 1337x / ext.to fallback, docs, tests and the verify-notesd feature map.

**Out of scope:**

- A VPN or any other way to hide the IP from the swarm (the owner accepted the exposure for this iteration).
- A separate command, skill or MCP tool for torrents: it is `direct_stream_play` with `provider: "torrent"`, and the fallback after `no_source`.
- Putting torrent downloads into `stream_caches` / `direct_stream_cache`: the stream cache is built around a resolved HLS source. Torrent downloads have their own record and replay from disk by themselves.
- The prober and the Stream side's "verified" marks for torrent sources.
- A move to the torrent source from the page's automatic stall handling.
- Seeding after a film ends, port forwarding, incoming connections.

## Invariants

1. The tree builds, `npm run typecheck` and `npm test` pass at the end of every phase.
2. With `NOTESD_TORRENT=off`, and in every test that does not ask for torrents (`DEFAULT_TORRENT_CONFIG` is off), no swarm is joined, no index is asked, and direct streaming behaves exactly as before this plan.
3. Unit and integration tests never touch the network or a real swarm: the engine, the indexes, the subtitle service, `ffmpeg`/`ffprobe` and Whisper are all injected, and a real-engine test seeds its own fixture over loopback with trackers and DHT off.
4. From a torrent the daemon reads only video and subtitle files, writes only under the torrent folder (a path from a torrent that leaves it is refused), and never runs anything.
5. Original language only: a release named as a dub is never a candidate, and a file whose audio streams name only other languages is `dubbed` and skipped, never played.
6. No request poses as another client: a plain request says it is notesd, and a bot check is the outcome `bot_check`, never worked around. 1337x and ext.to are asked only through the streaming Chrome.
7. A torrent download belongs to the machine that made it; the other machine sees `available: false` and its routes answer 404 `not_on_this_machine`.
8. `MoviesRepo`, `DirectStreamRepo` and `SessionsRepo` stay the only writers of their tables; the new table has one writer, in `src/directStream/torrent/`.
9. A cloud play is untouched: the torrent source is asked only for `provider: "torrent"` and after a cloud `no_source`.
10. Docs change with the code (phase 2, which may touch nothing outside `find/`, hands its guide part and feature-map line to phase 3): each phase documents its own routes (`scripts/docs/httpRoutes.ts`, `npm run docs:gen`), its own environment variables (`docs/guide/reference/configuration.md`) and its own behaviour (a subsection of its own under "Torrents" in `docs/guide/streaming.md`), and adds what proves it to `.claude/skills/verify-notesd/features/direct-streaming.md`.

### Shared contracts (reconciled: what the phase plans now say)

All new server code lives under `src/directStream/torrent/`. Phases 1 and 2 are the ground truth for their exports;
the later phases were bent to them.

- **Phase 1 exports** (`types.ts`, `store.ts`, `engine.ts`, `repo.ts`, `serve.ts`, `service.ts`, `src/http/streamTorrentApi.ts`):
  - `TorrentConfig` in `src/config.ts` (`config.torrent`, `DEFAULT_TORRENT_CONFIG` off): `enabled` (`NOTESD_TORRENT`), `dir` (resolved absolute, `NOTESD_TORRENT_DIR`, default `<dataDir>/movies/torrents`), `uploadKbps` (`NOTESD_TORRENT_UPLOAD_KBPS`, kB/s, default 100), `keepDays` (`NOTESD_TORRENT_KEEP_DAYS`, 7), `discovery` (`NOTESD_TORRENT_DISCOVERY`), `peers` (`NOTESD_TORRENT_PEERS`). Later phases append their fields in this order: `finder`, `ffmpegBin` (3), `remux` (5), `subtitleUrl` (6), `sites` (9), `whisper` (8).
  - `TorrentEngine` (`add`, `get`, `remove`, `port`, `close`; `WebTorrentEngine`), `TorrentHandle` (`infoHash`, `name`, `files`, `live`, `select`, `read(index, { start, end })` with `end` **inclusive**, `stats() → { peers, down_kbps, up_kbps }` in **kilobits** per second, `ranges` `[from, to)`, `done`), `TorrentPick { infoHash, trackers, name, ref, release? }`, `TorrentDownload` (camelCase: `infoHash, host, name, release, fileIndex, fileLength, state, durationS`), `TorrentDownloadView`, `TorrentMap { duration_s, ranges (seconds), length, byte_ranges }`, `mediaOf`, `normalizeInfoHash`.
  - `TorrentStreams` (`AppDeps.torrents`, null when off): `open(pick, { timeoutMs }) → TorrentHandle` (idempotent per hash; a `ready` download of the same title answers a `DiskHandle` with no engine), `use(infoHash, fileIndexes)`, `release(infoHash)` (counted; drops an opened-never-used torrent at once; ignores an unknown hash), `find(ref) → TorrentDownload | null`, `view`, `list`, `status`, `filePath(infoHash, index) → Promise<string | null>`, `serve`, `map`, `setDuration(infoHash, seconds)` (phase 3 calls it after every probe), `localUrl(infoHash, index)`.
  - The swarm is left once nothing uses a torrent (at once when finished, three minutes after the last request otherwise). After that the file route answers **409 `not_in_swarm`** for an unfinished file and **never rejoins** by itself: every reader (phase 3's probe, phase 5's ffmpeg, phase 6's hash read, phase 7's extraction, phase 8's cutter) reads only while its session holds the torrent, or a whole file from disk.
  - Sidecar folders live under `<dir>/<info hash>/`: `.notesd-subs/` (6), `notesd-remux/` (5), `notesd-cues/` (7), `notesd-whisper/` (8). Leaving the swarm deletes only the torrent's own unchosen file paths, so they survive it; pruning a download removes the whole folder, so they go with it.
  - `stream_torrents`: one row per host and info hash, written only by `TorrentsRepo`.
  - Routes: `GET/POST /api/stream/torrent`, `POST .../:hash/release`, `GET .../:hash`, `GET .../:hash/map`, `GET .../:hash/f/:index`; 503 `torrent_off`, 404 `not_on_this_machine` (with `host`), 404 `not_selected`, 409 `not_in_swarm`.
  - npm: `webtorrent@3.0.21` and `package.json` `allowScripts` (`node-datachannel` approved, `ip-set`, `bufferutil`, `utf-8-validate`, `utp-native` denied). No other phase runs an npm install step; `scripts/install.sh`'s `npm ci` honours `allowScripts`.
- **Phase 2 exports** (`src/directStream/torrent/find/`, through the barrel `find/index.ts`; no file outside `find/`, no config):
  - `TorrentQuery`: a union, `{ kind: 'movie', imdbId, title?, originalTitle?, year?, originalLanguage? }` | `{ kind: 'tv', …, season, episode, absoluteEpisode? }`.
  - `findCandidates(query, FindOptions) → FoundCandidates { candidates, indexes: IndexAttempt[], excluded }`; `FindOptions`: `minSeeds`, `goodSeeds`, `maxSizeBytes`, `timeoutMs`, `bases`, `yts`, `indexes`, `maxCandidates`, `userAgent`, `fallback`, `fetch`, `signal`. `IndexAttempt { index, outcome, detail, took_s, listed }`; index names are lower case (`torrentio`, `apibay`, `eztv`, `yts`; phase 9's `1337x`, `ext`). A fallback index keeps its own `timeoutMs` even when longer than `timeoutMs`.
  - `TorrentCandidate` (`infoHash, name, fileName, fileIdx, seeds, sizeBytes, index, listedBy, site, trackers, scoped, release`), built only by `candidateFrom(row, index, query)`; `ReleaseInfo` (with `multiAudio`: never `direct`); `parseRelease(name, context?)`; `pickFile(files, query) → { video, subtitles } | null`; `defaultIndexes`.
  - A release that names neither the asked `title` nor `originalTitle` is left out (`other_title`), so every fake that hands out releases names them after the asked title.
- **Phase 3 exports**:
  - `TorrentSource` (`source.ts`): `resolve(ref, { audioLang, imdbId, names?, resumeS?, cloudTried?, skip? })`, `next`, `fromDisk(ref, { audioLang, resumeS? }) → { torrent, source, attempts } | null`, `hold`, `release` (aborts `torrent.stop`), `state`; `TorrentSwarm` (the narrow view of `TorrentStreams`: `open, use, release, find, filePath, localUrl, setDuration`); `buildTorrentSource(config, torrents, wiring: { localBase, log?, tiers?, fallback? })` (phase 5 adds `remux`). It never runs inside `DirectStreamService.serial()`.
  - `probe.ts`: `MediaProbe` (`container`, `video`, `audio` in stream order, `subtitles: { index, codec, lang, text, title, forced, hearingImpaired }[]`, `durationS`, `direct`), `ffprobeFile({ ffprobeBin })` (the existing `NOTESD_FFPROBE_BIN`).
  - `subtitles/chain.ts`: one `SubtitleContext` (`ref, imdbId, infoHash, release, files, fileIndex, subtitleIndexes, handle, probe, audioLang, resumeS, cloudTried, localBase, signal, deadline`), `SubtitleTier { name, blocks, skip?, find }`, `runSubtitleChain(tiers, ctx) → { subtitles, attempts }` (stops at the first **non-empty** answer; one `Subtitles: <tier>` attempt per tier; the blocking tiers share **40 s** from the chain's start, `SUBTITLE_BUDGET_MS`), `SubtitleTierDeps { torrentDir, torrents, log, … }` and `buildSubtitleTiers(deps)` with a marked place per phase. Tier order: `kept`, `files` (6), `embedded` (7), `service`, `borrow` (6), `whisper` (8).
  - `StreamSession.torrent: SessionTorrent` (`infoHash, fileIndex, selected, name, index, seeds, state, height, manifestUrl, manifestKind, subtitles, candidates, durationS, candidate, held, imdbId, query, stop`) and `SessionInfo.torrent: { info_hash, file_index, name, index, state, seeds } | null` (`index`, `seeds` null on a replay); provider `Torrent`.
  - Hooks `DirectStreamHooks.imdbId` (TMDB `external_ids`) and `DirectStreamHooks.titleNames` (the stored title's names and year).
  - `DEFAULT_FFMPEG_BIN` and `TorrentConfig.ffmpegBin` (`NOTESD_FFMPEG_BIN`): the one ffmpeg phases 5, 7 and 8 run. Main's picture check (commit `53806be`, not in this branch's base) already defines the same constant and reads the same variable into `DirectStreamConfig.ffmpegBin`: when the branch meets main, keep one `DEFAULT_FFMPEG_BIN` and one `configuration.md` row, and let both fields read the variable.
  - `docs/guide/streaming.md`'s "Finding a torrent" and the finder's feature-map line (handed over by phase 2).
  - A file that is not `direct` is `unplayable` in `refusalOf`; phase 5 replaces that branch with the remux (`manifest_kind: "hls"`, `?remux=1&total_s=` on the playlist address).
- **Phase 7 exports** the growing cue feed: `CueFeeds.get(infoHash, track)` / `start(infoHash, track)`, `CueFeed.append(cues)` (any time order: reads go by count, the page's TextTrack orders cues), `complete()`, `cueFeedUrl`, track ids `embedded-<file index>-<stream index>` and `whisperTrackId(fileIndex)` = `whisper-<file index>` (a pack's episodes share one hash), `CacheSubtitleView.growing?: true` (always set for a cue feed, finished or not), the daemon local `torrentCues`.
- **Names, one spelling everywhere:** outcomes `resolved`, `no_stream`, `bot_check`, `error`, `dubbed`, `unplayable`, `skipped`; errors 503 `torrent_off`, 409 `not_in_swarm`, 404 `not_on_this_machine`; attempts `Index: <name>`, `Torrent: <release>`, `Subtitles: <tier>`; provider `Torrent`.
- **Verify harness (one owner per knob):** `verify.sh up --torrent` (phase 1; flag variable `torrent`, implies `--direct-stream` and `--movies`) writes `<run>/torrent/fixture.json` and `pack.json` (`trackers: []`; the daemon gets the seeder through `NOTESD_TORRENT_PEERS`), takes `TORRENT_FIXTURE_FILE`, and seeds any folder moved into `<run>/torrent/seed/<name>/`, describing it in `<run>/torrent/seeded/<name>.json` (phase 1). The fake Torrentio (`scripts/torrent/fake-index.mjs`, phase 3) names every release `<Title>.<Year>.<tail>` from the fake TMDB's `tmdb.json`, switches on `<run>/torrent/index-mode` (`ok` | `empty` | `error`) and answers every query from `<run>/torrent/candidates.json` when it exists; the fake TMDB answers `external_ids` (phase 3). Phase 5's `scripts/torrent/offer-remux.sh`, phase 6's fixtures and fake subtitle service (`<run>/torrent/subs/`, `mode`), and phase 9's fake sites (`<run>/torrent-sites/mode`) use those knobs. Journeys play titles of the fake TMDB (467905, 990001-990004, tv 247718), never TMDB 550 or Sintel.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | The torrent engine and its file route | R2 | `src/directStream/torrent` | 39 | — | HARD | `.workflows/plan/torrent-stream-source/phase-1.md` | — | — |
| 2 | Finding and ranking torrents | R1 | `src/directStream/torrent/find` | 24 | — | NORMAL | `.workflows/plan/torrent-stream-source/phase-2.md` | — | — |
| 3 | A torrent session in direct streaming | R1, R2 | `src/directStream` | 33 | 1, 2 | HARD | `.workflows/plan/torrent-stream-source/phase-3.md` | — | — |
| 4 | The player page on a torrent | R2 | `web/src/stream` | 11 | 3 | NORMAL | `.workflows/plan/torrent-stream-source/phase-4.md` | — | — |
| 5 | The remux for files Chrome cannot play | R2 | `src/directStream/torrent` | 25 | 3, 7 | HARD | `.workflows/plan/torrent-stream-source/phase-5.md` | — | — |
| 6 | Subtitle files: in the torrent, from a subtitle service, from a cloud provider | R3 | `src/directStream/torrent/subtitles` | 30 | 3 | NORMAL | `.workflows/plan/torrent-stream-source/phase-6.md` | — | — |
| 7 | The embedded subtitle track and the growing cue feed | R3 | `src/directStream/torrent/subtitles` | 24 | 4, 6 | HARD | `.workflows/plan/torrent-stream-source/phase-7.md` | — | — |
| 8 | Whisper, the last resort | R3 | `src/directStream/torrent/subtitles` | 17 | 7 | HARD | `.workflows/plan/torrent-stream-source/phase-8.md` | — | — |
| 9 | 1337x and ext.to through the streaming Chrome | R1 | `claude/streaming/torrent` | 21 | 3 | HARD | `.workflows/plan/torrent-stream-source/phase-9.md` | — | — |

Waves: phases 1 and 2 together; then 3; then 4, 6 and 9 together; then 7; then 5 and 8 together. (Coordinator, write-set gate: phase 5 waits for 7 because 5, 6 and 7 each regenerate `docs/guide/reference/http-api.md`; a generated file is regenerated, not merged, so no two of them may share a wave. Phase 5 quotes phase 3's code; phases 6 and 7 edit other places of the shared files, as listed below.)

**Files several phases touch, and how they meet** (each later phase quotes the file as the earlier one leaves it; the
edits below are additions at separate, marked places, so a merge is a union of lines):
- `src/config.ts`: `TorrentConfig` / `DEFAULT_TORRENT_CONFIG` / `parseTorrent` fields in the order 1, 3 (`finder`, `ffmpegBin`), 5 (`remux`), 6 (`subtitleUrl`), 9 (`sites`), 8 (`whisper`); phase 6 renames `parseAnimeMapUrl` to `parseUrlOrOff`, and phase 9's parsers sit after phase 1's `parseTorrent`, not after it.
- `src/daemon.ts`: phase 1 builds `torrents`; phase 7 builds `torrentCues` / `embeddedSubtitles` right after it, phase 8 `whisperTier` after those; phase 3's `torrentSourceOf` closure has one marked line each for phase 5 (`remux`), phase 9 (`fallback`) and fields in its `buildSubtitleTiers({...})` object for phases 6, 7 and 8.
- `src/directStream/torrent/source.ts` (phase 3): phase 5 replaces `refusalOf` and edits `tryOne`/`fromDisk`/`hold`/`release`/`buildTorrentSource`; phase 6 inserts one call at the `// Phase 6 (R3.2)` line of `resolve`.
- `src/directStream/torrent/subtitles/chain.ts` (phase 3): phases 6, 7, 8 insert tiers at their comments and add `SubtitleTierDeps` fields; phase 8 also sets `whisperCovers` on phase 6's borrow line.
- `src/http/streamTorrentApi.ts` (phase 1): phase 5 at the top of the map handler, phase 6 a route after the file route. `src/http/app.ts` / `src/deps.ts`: phases 5 and 7 each add one mount and one field.
- `web/src/stream/session.ts`, `controller.ts`: phase 4, then phase 7 (which depends on phase 4). `hlsEngine.ts`: phase 5 only.
- `scripts/docs/httpRoutes.ts`, `docs/guide/reference/configuration.md`, `.claude/skills/verify-notesd/scripts/verify.sh`, `features/direct-streaming.md`: each phase adds its own rows, blocks and section. `docs/guide/streaming.md`: phase 1 makes `## Torrents`; each phase adds its own `###` subsection in phase order (1, 3 with "Finding a torrent", 4, 5, 6, 7, 8, 9).

### Phase 1 — The torrent engine and its file route
**Satisfies:** R2 (R2.1, R2.2, R2.3, R2.6, R2.9)
**Owns:** the `webtorrent` dependency and `allowScripts`; `src/directStream/torrent/{types,webtorrent.d,store,engine,repo,serve,service}.ts`; `TorrentConfig` in `src/config.ts`; the `stream_torrents` table, its migration and `TorrentsRepo`; `src/http/streamTorrentApi.ts` and its mount; `AppDeps.torrents`, building it in `src/daemon.ts`, starting and closing it in `src/background.ts`; leaving the swarm when nothing uses a torrent (and the 409 `not_in_swarm` afterwards); clearing downloads not played for `keepDays`; a real-engine test over loopback; `verify.sh up --torrent` with `scripts/torrent/{make-fixture.sh,seed.mjs,torrent.sh}`, the seeder's `seed/<name>/` → `seeded/<name>.json` folder for later phases' fixtures.
**Does not touch:** `src/directStream/service.ts`, `sessions.ts`, `types.ts`; anything under `web/`; finding torrents.
**Exit criteria:** on `verify.sh up --torrent`, `torrent.sh RUN` ends `torrent: PASS (idle files refuse range cap leave only disk)`; on `verify.sh up --direct-stream`, `torrent.sh RUN off` prints `OFF PASS`; `npm run typecheck`, `npm test` and the new integration test pass.

### Phase 2 — Finding and ranking torrents
**Satisfies:** R1 (R1.1, R1.2, R1.3, R1.4, R1.5)
**Owns:** `src/directStream/torrent/find/` only: the four JSON indexes (Torrentio, apibay, EZTV, YTS), `parseRelease`, `candidateFrom`, the filter and ranking (the title check included), `pickFile`, `findCandidates` with its `fallback` option (a fallback index keeps its own longer limit); fixtures in `tests/fixtures/torrent/`.
**Does not touch:** any file outside `src/directStream/torrent/find/`, its tests and fixtures: no config, no daemon wiring, no docs (its guide part and feature-map line are phase 3's).
**Exit criteria:** `npm run typecheck` and `npm test` pass; J1-J5 pass over the fixtures; J6 answers a ranked Sintel list from the live indexes with each index's outcome; nothing outside the three folders changed.

### Phase 3 — A torrent session in direct streaming
**Satisfies:** R1 (R1.4, R1.6), R2 (R2.4, R2.5, R2.6, R2.9)
**Owns:** `src/directStream/torrent/source.ts`, `probe.ts`, `subtitles/chain.ts` (the context, the runner with its non-empty stop rule and 40 s budget, `buildSubtitleTiers` with no tier); `StreamSession.torrent` and `SessionInfo.torrent`; the torrent branches of `play`, `refresh`, `switchSource`, `cacheSession`, `switchEpisode`, `info` and `sessionInfo`; the outcomes `unplayable` and `skipped`; the `imdbId` and `titleNames` hooks and TMDB `external_ids`; the finder's settings and `NOTESD_FFMPEG_BIN`; wiring in `src/daemon.ts`; `direct_stream_play`'s `provider: "torrent"`, the MCP instructions, the chat prompt and the `/direct-stream` skill; replay from disk (R2.9); the evidence snapshot's view; the guide's "Playing from a torrent" with "Finding a torrent"; the fake index (with `index-mode` and `candidates.json`) and the fake TMDB's `external_ids`.
**Does not touch:** `web/`; the engine's internals; the index modules; remuxing; any subtitle tier.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; J1-J6 pass on the throwaway daemons (the torrent fall-through after `no_source`, a named torrent play in the real page, replay from disk with no index or torrent attempt, a dub skipped, a pack's episode, `torrent_off`) and the neighbor check passes.

### Phase 4 — The player page on a torrent
**Satisfies:** R2 (R2.7)
**Owns:** `web/src/stream/session.ts` (parsing `torrent`), `StreamApp.tsx`, `controller.ts`, `stream.css`: the torrent mark and status line (peers, speed), the loaded bar fed by `/map`, the wait for a part not on disk, the automatic stall move off for a torrent session, the shuffle button's messages, `window.notesdStream.torrent`; `scripts/stream/torrent-player.steps.mjs` and `torrent-live.steps.mjs`.
**Does not touch:** `hlsEngine.ts`, `subtitles.ts`, anything under `src/`; phase 3's `torrent-play.steps.mjs`.
**Exit criteria:** `npm run typecheck` and `npm test` pass; J2's transcript holds all six PASS lines; J1's holds `TORRENT LIVE PASS` and `TORRENT DISK PASS` on a `--torrent` run; the neighbor journeys still pass.

### Phase 5 — The remux for files Chrome cannot play
**Satisfies:** R2 (R2.8)
**Owns:** `src/directStream/torrent/remux.ts` (ffmpeg reading the file route or the whole file, video copied, the original-language audio to AAC, a growing HLS EVENT playlist under `<dir>/<hash>/notesd-remux/`), `src/http/streamTorrentRemuxApi.ts`, `NOTESD_TORRENT_REMUX`, replacing phase 3's `unplayable` branch, the map answering the remux's stretch, `web/src/stream/hlsEngine.ts` for a growing playlist, stopping ffmpeg with the session; `scripts/stream/make-mkv-fixture.sh`, `scripts/torrent/offer-remux.sh`, `scripts/stream/torrent-remux.steps.mjs`.
**Does not touch:** `StreamApp.tsx`, `controller.ts`, `nativeEngine.ts`, `session.ts`, `subtitles.ts`; the subtitle tiers; `fake-index.mjs`; the ffmpeg setting (phase 3's).
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; J1-J7 and the neighbor check pass (the MKV plays through the remux, seeks, replays from disk, holds a seek past a growing edge; with the remux off it is `unplayable`).

### Phase 6 — Subtitle files: in the torrent, from a subtitle service, from a cloud provider
**Satisfies:** R3 (R3.1, R3.2, R3.3)
**Owns:** `src/directStream/torrent/subtitles/{disk,files,service,borrow}.ts` and the `kept`, `files`, `service`, `borrow` tiers in phase 3's chain (all blocking, the borrow within the shared budget and skipped when Whisper covers an English original); R3.2's reordering at phase 3's marked line; the `/api/stream/torrent/:hash/sub/:name` route; the OpenSubtitles hash; `NOTESD_TORRENT_SUBTITLE_URL`; `parseUrlOrOff` (replacing `parseAnimeMapUrl`); `subtitleText`'s `deadlineS`; the fake subtitle service and its fixtures.
**Does not touch:** `web/`; `SubtitleContext`, `SubtitleTier`, `runSubtitleChain`; the embedded track; Whisper.
**Exit criteria:** `npm run typecheck`, `npm test` and `npm run docs:check` pass; `subtitles.sh RUN` ends `subtitles: PASS (files replay lone ass service byid borrow quiet prefer)`.

### Phase 7 — The embedded subtitle track and the growing cue feed
**Satisfies:** R3 (R3.4, R3.5)
**Owns:** `src/directStream/torrent/subtitles/feed.ts` (the growing cue feed, any append order) and `embedded.ts` (the growing `embedded` tier, ffmpeg extracting an English text track to WebVTT as the file downloads), `src/http/streamTorrentCuesApi.ts`, `AppDeps.torrentCues`, `CacheSubtitleView.growing`, `SessionSubtitle.growing` and `localSubtitle`, and `web/src/stream/subtitles.ts` plus its edits to phase 4's `session.ts` and `controller.ts` reading a growing track until it is complete.
**Does not touch:** `StreamApp.tsx`, `hlsEngine.ts`, the remux; phase 6's tiers; the ffmpeg setting (phase 3's).
**Exit criteria:** on a throwaway daemon, a torrent whose file carries an English text track and no subtitle file plays with that track's cues on screen, read from a feed that grows and ends complete; a file with picture tracks only gets no feed and the chain asks the next tier; `npm run typecheck` and `npm test` pass.

### Phase 8 — Whisper, the last resort
**Satisfies:** R3 (R3.6)
**Owns:** `src/directStream/torrent/subtitles/whisper.ts` (the growing `whisper` tier, last; audio cut with ffmpeg, a CPU Whisper per stretch, cues appended to phase 7's `whisper-<file index>` feed, progress under `<dir>/<hash>/notesd-whisper/`), `whisperCovers` on phase 6's borrow line, `claude/streaming/torrent/whisper.py`, the Whisper install in `scripts/install.sh`, its settings (`NOTESD_TORRENT_WHISPER*`), `AppDeps.torrentWhisper`.
**Does not touch:** the other tiers' code, `web/`, `verify.sh`.
**Exit criteria:** `npm run typecheck` and `npm test` pass; J1 shows a growing `English (Whisper)` track filled stretch by stretch and completed (the borrow `skipped`), J2 shows its cue drawn in the player, J3 shows the real model's timed English cues for Sintel; with `NOTESD_TORRENT_WHISPER=off` no tier is built.

### Phase 9 — 1337x and ext.to through the streaming Chrome
**Satisfies:** R1 (R1.7)
**Owns:** `claude/streaming/torrent/` (`cli.mjs`, `match.mjs`, `page.mjs`, `browser.mjs`, `tab.ps1`, one module per site), `src/directStream/torrent/find-sites.ts` (a `TorrentIndex` per site with a 40 s limit, candidates through phase 2's `candidateFrom`), the settings `NOTESD_TORRENT_1337X_ORIGIN`, `NOTESD_TORRENT_EXT_ORIGIN`, `NOTESD_TORRENT_SITES_CLI`, the `fallback` line in phase 3's wiring, the fake sites script for throwaway daemons.
**Does not touch:** the JSON indexes, the engine, `web/`, `cdp.ps1`, `chrome.mjs`, the play sites.
**Exit criteria:** with every JSON index empty, a torrent play takes its candidate from the fake 1337x row through the same filter and ranking (J1); a bot check from either site is `bot_check` and stops that site (J2); the sites are not asked when an index answered (J3); live, `cli.mjs 1337x sintel 2010` lists releases with seeds and magnets (J4); `npm run typecheck` and `npm test` pass.

## Reconciliation Log

| # | Conflict | Kind | Resolution |
|---|---|---|---|
| 1 | Phase 3 called phase 2 with an optional-episode query, `indexes` as a record of addresses, attempts by `a.name`, and `TorrentCandidate` literals missing `listedBy`/`site`/`scoped` (phases 3, 5 tests) | Contract drift | Phase 3 builds phase 2's `TorrentQuery` union (with `title`, `originalTitle`, `year`, `originalLanguage`), maps settings onto `bases`/`yts`/`indexes`, reads `IndexAttempt.index`; every test candidate and `FindAnswer` literal in phases 3 and 5 takes phase 2's shape |
| 2 | Phase 3's query carried no title, so phase 9's sites (no IMDb search) had nothing to search by and phase 2's title check never ran | Unmet assumption | New `titleNames` hook (`MovieStreams.titleNames`, the stored title row) in phase 3; `SessionTorrent.query` keeps the query for the shuffle button |
| 3 | Phase 2's title check would drop every fake release (`Verify.Fixture...`, phase 6's `bare-hi`, the fake 1337x row) once the title is passed | Broken journeys | The fake index (phase 3) names releases `<Title>.<Year>.<tail>` from `tmdb.json`; the fake 1337x (phase 9) names its row from `--title`/`--year`; journey expectations updated (`Torrent: How.to.Make.a.Killing.2026...`) |
| 4 | Phase 2's docs subsection and feature-map line had no owner (phase 2 may touch no file outside `find/`) | Gap | Moved to phase 3 ("Finding a torrent" in its guide subsection, a finder line in its feature-map section) |
| 5 | Phase 3 redefined `TorrentPick` and expected `trackers` to reach a loopback tracker; phase 1 ships `trackers: []` and peers from `NOTESD_TORRENT_PEERS` | Contract drift | Phase 3 imports phase 1's `TorrentPick`; its Requires and Handoffs say `trackers: []` |
| 6 | Phase 1 needs `setDuration` after the probe for `/map`'s seconds (phase 4's bar); phase 3 never called it | Unmet assumption | `TorrentSwarm.setDuration`; `TorrentSource` calls it after every probe (play and replay); a test asserts it |
| 7 | 409 `not_in_swarm` and no rejoin: readers in phases 5, 6, 7, 8 assumed reads simply block or 404 | Contract drift | Each reader reads only while the session holds the torrent or a whole file from disk; phase 7's handoff says 409; phase 5 and 8 state the remux/cut stops and restarts on the next play |
| 8 | Sidecars: phase 8 kept progress and WAVs in `<dir>/whisper/`, outside the torrent folder, so they survived prune | Gap | Moved to `<dir>/<hash>/notesd-whisper/` (`workDirOf`); phase 1's handoff lists all four sidecar folders |
| 9 | Harness knobs: phase 3 asked for a loopback tracker, phase 5 for phase 1 to seed `remux.json` and a `movie-fixture` switch in the fake index, phase 6 for a seed folder and `candidates.json`, phase 9 for a fake TMDB "Sintel", phases 4/7 played TMDB 550 (not in the fake TMDB) | Gap / collision | Phase 1's seeder seeds `<run>/torrent/seed/<name>/` into `seeded/<name>.json`; phase 3's fake index owns `index-mode` and `candidates.json`; phase 5's `offer-remux.sh` uses them (no `movie-fixture`); phase 6's seed copy made atomic; phases 4, 7 play 467905 and phase 9 plays `movie-990003` |
| 10 | Phase 3 and phase 4 both created `scripts/stream/torrent-play.steps.mjs` | Duplicate work | Phase 3 keeps it; phase 4's live journey is `torrent-live.steps.mjs` |
| 11 | Subtitle chain stop rule: phase 3 stopped at the first English answer, phase 6 needs the first non-empty one, phase 8 assumed English | Behavioral fork | Decided (Decisions): first non-empty answer; phase 3's runner implements it, phases 6 and 8 edited to it |
| 12 | `SubtitleContext` field names differed (phase 6 `videoIndex`, `handle`, `cloudTried`; phase 7 `probe` nullable; phase 8 `resumeS`, `signal`) and phase 6 redefined phase 3's runner and context | Contract drift | One context in phase 3 (`fileIndex`, `handle`, `probe`, `resumeS`, `cloudTried`, `signal`, `deadline`, ...); phase 6 only inserts tiers; phases 6, 7, 8 read it by those names; a shared test helper `REST_OF_CONTEXT` |
| 13 | Worst-case subtitle wait 15 + 15 + 45 + 85 s held up a play | Behavioral fork | Decided (Decisions): one 40 s budget for the blocking tiers (`SubtitleTier.blocks`, `ctx.deadline`, `skipped` attempt); the borrow capped by it and skipped when Whisper covers an English original; growing tiers never counted |
| 14 | Borrow deadlock risk: `resolve` inside `DirectStreamService.serial()` | Unmet assumption | Checked: phase 3's `torrentSession` calls `resolve` after the cloud resolve returned, outside `serial()`; stated in source.ts, service.ts and the Handoffs |
| 15 | Phase 8 called `cueFeeds.open(infoHash, fileIndex, name)` and phase 7's feed only had `start`/`get`; out-of-order appends | Contract drift | Phase 8 uses `torrentCues.get` / `start(infoHash, whisperTrackId(fileIndex))`; phase 7's feed accepts any order (reads by count, the page's TextTrack orders cues) |
| 16 | Feed track ids `embedded-<stream>` / `whisper` collide between the episodes of a season pack (one info hash) | Gap | `embedded-<file>-<stream>` and `whisper-<file>`; phase 7's tests and J1 updated |
| 17 | Phase 8 answered a finished Whisper track with `growing: false`, which phase 7's page would fetch as WebVTT (it is a JSON cue feed) | Contract drift | A cue feed is always `growing: true`; the page reads a finished feed once |
| 18 | `ffmpegBin` / `NOTESD_FFMPEG_BIN` added conditionally by phases 5, 7 and 8 | Duplicate work | Given to phase 3 (beside the probe's existing `NOTESD_FFPROBE_BIN`); removed from 5, 7, 8; phase 6's ASS converter gets it too; merge note for main's `53806be` |
| 19 | Phase 5's edits quoted phase 3's pre-reconciliation `fromDisk`/`tryOne`/`buildTorrentSource`/daemon closure | File collision | Phase 5's Step 5 and 6 quote phase 3's code as it now stands (`noteDuration`, `stop`, `subtitleAttempts`, the wiring comment) |
| 20 | Phase 7 replaced `cache.subtitles.map(...)` at `service.ts:752`, but phase 3 merged cache and torrent into `local.subtitles.map(...)` | File collision | Phase 7 quotes phase 3's `local` branch |
| 21 | Phase 7 and phase 4 edit `web/src/stream/session.ts` and `controller.ts`; the DAG let them run at once | File collision | `Depends on` edge 7 → 4 (phase 7 already waited for 6) |
| 22 | Phase 9 anchored its parsers after `parseAnimeMapUrl`, which phase 6 deletes; both phases plus 5 append to `TorrentConfig` in parallel | File collision | Phase 9's parsers go after phase 1's `parseTorrent`; field order stated in the index |
| 23 | Phase 9 built `TorrentCandidate` literals without phase 2's fields, read `query.season` on the union, and its 40 s sites were cut to the JSON indexes' 10 s by phase 2's `min` | Contract drift | Phase 9 uses `candidateFrom` and narrows on `kind`; phase 2 gives a fallback index its own longer `timeoutMs` (one line, one test); phase 9 sets `timeoutMs` |
| 24 | Phase 9 added `fallback` to options it assumed live in `src/daemon.ts`; phase 3 builds them in `buildTorrentSource` | Unmet assumption | Phase 3's `buildTorrentSource` takes `wiring.fallback`; phase 9 adds one line in phase 3's wiring object |
| 25 | Phase 3's J3 and texts said a replay answers `attempts: []`; after phase 6 a replay carries `Subtitles: kept` | Contract drift | A replay answers no `Index:`/`Torrent:` attempt (only `Subtitles: <tier>`); J3, `torrent.sh`, MCP text, skill and guide updated |
| 26 | Phase 7 needs the probe's subtitle `title`, `forced`, `hearingImpaired` | Unmet assumption | Added to phase 3's `parseProbe` (cheap, one place) |
| 27 | Guide subsection heading levels (`####` in phases 3, 4, 6, 7, 8, 9 under phase 1's `## Torrents`) | Contract drift | All `###` |
| 28 | Outcome and error spellings (`Index: Torrentio` vs phase 2's lower-case names) | Contract drift | One spelling: `Index: torrentio`, `Torrent: <release>`, `Subtitles: <tier>`, `unplayable`, `skipped`, 503 `torrent_off`, 409 `not_in_swarm`, 404 `not_on_this_machine` |
| 29 | npm 12 `allowScripts` (phase 1) vs install steps | Checked | No other phase runs `npm install`/`npm ci`; phase 8's `install.sh` change is pip only, and the existing `npm ci` honours `allowScripts` |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Separate command or a source inside direct streaming | a source inside `direct_stream_play` (`provider: "torrent"`, and after a cloud `no_source`) | 5: the owner's answer |
| VPN or accept the exposure | cap upload (100 kB/s), leave the swarm when nothing plays, no VPN | 5: the owner's answer |
| Scrape 1337x / ext.to first, or JSON indexes first | JSON indexes first; the two sites only as a fallback through the streaming Chrome | 1: invariant 6 (CLAUDE.md: never a disguised client past a bot check) |
| Torrent downloads in `stream_caches`, or their own record | their own table `stream_torrents`; replay from disk without the stream cache | 6: the stream cache is built around a resolved HLS source |
| Subtitle service | Stremio's OpenSubtitles add-on (no key); Wyzie needs a key claimed by hand and is left out | 6: zero manual steps for the owner |
| Torrents on or off by default | on when direct streaming is on; `NOTESD_TORRENT=off` turns them off; tests default to off | 5: the owner asked for it and accepted the catch |
| The subtitle chain stops at the first English answer (phase 3) or the first non-empty one (phase 6) | the first **non-empty** answer: every tier answers only English tracks or the torrent's one unnamed subtitle file, which R3.1 counts | 2: R3.1's criterion (the lone unnamed file is shown by default and ends the chain); decided by the analyst |
| How long subtitles may hold up a play (worst case 15 + 15 + 45 + 85 s) | the tiers that block a play (kept, files, service, borrow) share one 40 s budget from the chain's start; a tier that would start after it is `skipped`, one still running when it ends is `error`; the growing tiers (embedded, whisper) never block and are not counted; the borrow is skipped when Whisper is on and the original language is English | 4: the Why ("our main objective tonight is to see a streaming movie") over completeness; decided by the analyst |
| Who owns `NOTESD_FFMPEG_BIN` (phases 5, 7, 8 each "if not there") | phase 3, beside the probe's existing ffprobe setting; one `DEFAULT_FFMPEG_BIN` and one row when the branch meets main's picture check | 6: one owner per setting, the same name main already reads |
| How later phases add fixture torrents (phase 5 wanted phase 1 to seed its MKV, phase 6 a seed folder) | phase 1's seeder seeds any folder moved into `<run>/torrent/seed/<name>/`; phase 3's fake index answers `candidates.json`; each phase brings its own fixture | 6: one owner per harness knob, the existing seeder |
| The order of cues in a feed (phase 8 appends out of time order) | the feed keeps append order and is read by count; the page adds each cue to a TextTrack, which orders them; nobody sorts | 3: phase 7's code blocks (index-based reads, TextTrack) |
| Feed track names for a season pack, whose episodes share one hash | `embedded-<file>-<stream>` and `whisper-<file>` | 2: R1.4 (an episode's file inside a pack) with R3.4/R3.6 |
| A finished Whisper track's `growing` mark (phase 8 said false) | always `growing: true`: the address is a JSON cue feed, which the page reads once when complete | 3: phase 7's code (`format: "cues"` only when `growing`) |
| The fake index's release names (the title check would drop `Verify.Fixture...`) | `<Title>.<Year>.<tail>` from the fake TMDB, and the fake 1337x row from `--title`/`--year` | 3: phase 2's `exclusionOf` code (`other_title`) |
| A fallback index's time limit (phase 2's `min` cut phase 9's 40 s to 10 s) | a fallback index keeps its own `timeoutMs` in the fallback round; the JSON indexes keep the shorter limit | 2: R1.7's exit criterion (the sites must be able to answer) over phase 2's comment |
| Phase 7 against phase 4 (same web files) | phase 7 depends on phase 4 | 1: invariant 1 (build green, no blind merge of the same functions) |
| Write-set gate: `http-api.md` (generated) written by phases 5 and 6 in one wave, and by 7 in the next | phase 5 depends on phase 7 (waves `[1,2] → [3] → [4,6,9] → [7] → [5,8]`), not 6 on 5: the subtitle chain 6 → 7 → 8 is the longest path and must not wait for the remux; the other concurrent writes are ordinary files, one worktree per phase | 6: the swarm's ORDER remedy (a generated file has one writer per wave); decided by the coordinator |

## Open Questions

_None._

## Rollback

Each phase is one merge on `feature/torrent-stream-source`; reverting a phase's merge backs it out, in reverse order of the table. Phase 1's migration only adds the table `stream_torrents`: dropping it loses nothing but the list of downloads, whose files can be deleted from `<data dir>/movies/torrents/`. As a whole: `NOTESD_TORRENT=off` turns the feature off without a revert.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/TORRENT_STREAM_SOURCE_PLAN.md --phase 1

Or run the whole set as a swarm — a session per phase, concurrent wherever `Depends on` allows, resumable on any machine:

    /analyze-orchestrator -f .workflows/plan/TORRENT_STREAM_SOURCE_PLAN.md

Or put them on the board first (GitHub repos only):

    /create-task --from-plan .workflows/plan/TORRENT_STREAM_SOURCE_PLAN.md
