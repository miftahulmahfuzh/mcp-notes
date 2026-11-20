# Code Analysis: seek preview thumbnails on the direct-stream player

**Type:** Feature Implementation
**Date:** 2026-11-20 19:24 WIB
**Session ID:** 20261120-192436-K7QP
**Plan:** `.workflows/plan/SEEK_PREVIEW_THUMBNAILS_PLAN.md` (5 phases)
**Worktree:** `/home/miftah/.worktrees/mcp-notes/seek-preview-thumbnails`, branch `feature/seek-preview-thumbnails` (base `origin/main` @ `77051ca`)

---

## User Input

### Original User Request

```
/analyze this so we ship a robust feature
```

"this" is the feature discussed in the two messages before it, in the same session. The owner's
first message, verbatim:

```
let's discuss this with me.
usually in some streaming website, where there is a forward-caching where the system will download the movie ahead of the user watch position,
user hover on the timeline and see miniscreen showing the scene of that timestamp. what do we call this feature?

can we build it here?
```

### User-Provided Context

The answer the owner then ran `/analyze` on (it is the proposal "this" points at; nothing in it was
objected to):

- The feature's name is seek preview thumbnails. The frames do not come from the player's buffer:
  they are made once per film as sprite sheets plus a list that maps a time range to a rectangle.
- Where the pictures would come from, by source:
  1. a provider that ships its own preview track (the resolver recognises and discards it today);
  2. a film on disk (a cached film, a finished torrent, a whole remux): one ffmpeg job, kept beside
     the file;
  3. a torrent still downloading: only over what is there, following the grey bar;
  4. a cloud stream with no provider track and no cache: slow and hundreds of extra requests to the
     stream host. Recommended: skip.
- Recommended: build 1 to 3, skip 4; where nothing is available the hover shows the timestamp alone.
- Two points were left for the owner and were not answered before `/analyze`: partial previews
  (recommended: show pictures for the part on disk, a plain timestamp for the rest) and when to
  generate (recommended: in the background at low priority as soon as the file is whole).
- A rule named in the answer: on a torrent the job reads only the video file.

### User-Provided Files

None.

### Requirement IDs

| ID | What the user asked for (verbatim) |
|---|---|
| R1 | user hover on the timeline and see miniscreen showing the scene of that timestamp. [...] can we build it here? |
| R2 | this so we ship a robust feature |

#### Acceptance Criteria

| ID | Pattern | Criterion |
|---|---|---|
| R1.1 | event | WHEN the pointer is over the timeline of the direct-stream player page THE SYSTEM SHALL show a box above the pointer with the timestamp of that position and, where the session's previews hold a frame for that position, that frame |
| R1.2 | state | WHILE a stretch of a cloud stream's cache is on this machine THE SYSTEM SHALL list preview frames for that stretch in `GET /api/stream/sessions/:id/previews` of a session playing that title |
| R1.3 | state | WHILE a stretch of a torrent's video file (the file as downloaded, or its remux) is on this machine THE SYSTEM SHALL list preview frames for that stretch in `GET /api/stream/sessions/:id/previews` of a session playing that file |
| R1.4 | optional | WHERE a cloud provider's page loaded a seek-preview WebVTT track THE SYSTEM SHALL list that track's frames in `GET /api/stream/sessions/:id/previews`, each fetched through the pass-through |
| R1.5 | event | WHEN the preview frames of the session on screen change THE SYSTEM SHALL have the open player page use the new frames without a reload |
| R1.6 | complex | WHILE a film whose video is on this machine plays in the player WHEN the pointer rests on the timeline at a position on disk THE SYSTEM SHALL show a frame taken within one preview interval of that position |
| R2.1 | unwanted | IF the session's previews hold no frame for the hovered position, or a frame's picture fails to load, THEN THE SYSTEM SHALL show the timestamp alone and no broken picture |
| R2.2 | unwanted | IF ffmpeg is missing, fails or runs past its time limit while making a sheet THEN THE SYSTEM SHALL keep no part of that sheet, leave the play untouched and try that sheet again at most a fixed number of times |
| R2.3 | ubiquitous | THE SYSTEM SHALL run at most one preview ffmpeg at a time, at lowered CPU priority |
| R2.4 | state | WHILE a torrent is not whole on disk THE SYSTEM SHALL make its previews without selecting, waiting for or fetching any piece and without holding the torrent in the swarm |
| R2.5 | event | WHEN a stream cache or a torrent download (whole, or one episode of it) is deleted THE SYSTEM SHALL delete its preview files with it, and count them in that item's size on disk until then |
| R2.6 | unwanted | IF a provider's preview track cannot be fetched, is over the size limit or holds no picture cue THEN THE SYSTEM SHALL list no frame from it and record nothing against that provider's delivery |
| R2.7 | optional | WHERE `NOTESD_STREAM_PREVIEWS=off` THE SYSTEM SHALL start no preview build and answer the previews route with no frame |
| R2.8 | event | WHEN the daemon restarts while previews of a film are partly made THE SYSTEM SHALL keep the finished sheets and make only the missing ones |

---

## Detailed Requirements Understanding

**Problem/Requirement Statement**: the direct-stream player page (`/stream/<session id>`) has a
timeline that is a bare range input. Nothing happens on hover. The owner wants the hover picture
streaming sites show. No part of the daemon makes, keeps, serves or lists such pictures today, and
the one place that meets a provider's own preview track throws it away.

**Success Criteria**: the fourteen criteria above. In short: a hover shows a time and, where the
machine or the provider has it, a frame; frames grow with what is on disk; nothing about making
them can disturb a play, the swarm, the stream host's health record or the disk accounting.

**Key Considerations**

- Three kinds of session carry different things: a pass-through session (a remote manifest, maybe a
  cache being filled beside it), a cache session (all local), a torrent session (a file route or a
  remux playlist).
- A session carries no duration. The page reads `video.duration`; a remux carries `total_s` in its
  address; `SessionTorrent.durationS` exists server-side only.
- No completion event exists for a torrent file or a cloud cache becoming whole. A remux has
  `whenDone` with one listener.
- No ffmpeg run in the daemon has a queue or a lowered priority today.
- Disk accounting and deletion differ per store and both have blind spots for a new subfolder (see
  Data Persistence).
- `tests/unit/docs/reference.test.ts` fails `npm test` on an undocumented route or env var, so the
  phase that adds one documents it.

**Assumptions**

- "this" means the recommendation as given: sources 1 to 3, not 4; partial previews shown;
  generation in the background at low priority.
- The player meant is notesd's own page. VLC plays (DM, DS) and the streaming sites' own players
  are not part of the ask.
- Preview state can live on disk beside the bytes; no database table is needed. Nothing found
  contradicts this: every store already keeps derived files beside its bytes (`notesd-remux/`,
  `notesd-cues/`, `subtitle.vtt`).

---

## Analysis Scope

### Explicitly Mentioned Files

None.

### Discovered Related Files

Player page: `web/stream.html`, `web/src/stream/StreamApp.tsx`, `controller.ts`, `session.ts`,
`hlsEngine.ts`, `subtitles.ts`, `stream.css`, `web/src/testing/streamFakes.ts`, the six
`web/src/stream/*.test.tsx`.

Resolver: `claude/streaming/direct/resolve.mjs`, `sniff.mjs`, `sniff.ps1`,
`tests/unit/scripts/directResolve.test.ts`.

Daemon, sessions and pass-through: `src/directStream/runner.ts`, `types.ts`, `sessions.ts`,
`service.ts`, `passThrough.ts`, `rewrite.ts`, `evidence.ts`, `delivery.ts`, `picture.ts`,
`src/http/directStreamApi.ts`, `streamEvidenceApi.ts`.

Cloud cache: `src/directStream/cache/{types,store,plan,hls,job,service,serve}.ts`, `cachePlay.ts`,
`cacheShelf.ts`, `src/http/streamCacheApi.ts`, `streamCachePlayApi.ts`, `streamDiskApi.ts`.

Torrents: `src/directStream/torrent/{types,store,usage,service,source,remux,remuxOnly,probe,repo,engine}.ts`,
`src/http/streamTorrentApi.ts`, `streamTorrentRemuxApi.ts`.

Wiring and config: `src/config.ts`, `src/deps.ts`, `src/daemon.ts`, `src/background.ts`,
`src/directStream/ahead.ts`.

Docs and proof: `scripts/docs/httpRoutes.ts`, `scripts/docs/reference.ts`, `scripts/docs/envVars.ts`,
`docs/guide/reference/configuration.md`, `docs/guide/streaming.md`, `docs/guide/movies.md`,
`scripts/docs/shots/streaming.mjs`, `.claude/skills/verify-notesd/{SKILL.md,scripts/verify.sh,features/direct-streaming.md}`,
`.claude/skills/verify-notesd/scripts/stream/*`.

---

## Current Dataflow

### Entry Point: the timeline on the player page

**Location:** `web/src/stream/StreamApp.tsx:651-663`, inside `<div className="st-bar">` (`:623`).
**Trigger:** the browser's range behaviour.

```tsx
<input className="st-seek" type="range" aria-label="Position" min={0} max={view.duration} step={1}
  value={Math.min(view.time, view.duration)}
  onChange={(e) => { if (video !== null) video.currentTime = Number(e.currentTarget.value); }}
  style={{ ['--st-fill']: `${fill}%`, ['--st-loaded-bar']: loadedGradient([...view.buffered, ...state.cachedRanges], view.duration) }} />
<span className="st-clock">{formatClock(view.time)} / {formatClock(view.duration)}</span>
```

- No pointer, mouse or hover handler on the input; the only mouse handler near it is
  `onMouseMove={wake}` on `.st-stage` (`:583`). No tooltip, no `title`.
- `formatClock(seconds)` (`:76-82`, exported) formats a time.
- Keyboard: a window `keydown` handler (`:547-569`) seeks by `SEEK_STEP_S` = 10 (`:64`, `:488-495`).
- `useMediaView` (`:277-296`) re-reads `time`, `duration`, `buffered` on media events (`:246`).
- The grey bar: `loadedGradient(ranges, duration)` (`:257-275`) into `--st-loaded-bar`; CSS draws
  three layered backgrounds on `::-webkit-slider-runnable-track` (`stream.css:164-177`). The input
  is `flex:1; height:20px; margin:0 10px` (`:156-163`), track 7 px, thumb 11×11 px.
- Grey-bar data: `video.buffered`; `state.cachedRanges` filled by `followCache`
  (`controller.ts:1240-1261`, `GET /api/stream/cache/:id/map` every `CACHE_POLL_MS` 4000) and by
  `followTorrent` / `readTorrent` (`controller.ts:1268-1301`, `GET /api/stream/torrent/:hash/map`
  every 2 s while visible). Map shape `{duration_s, ranges}` parsed by `fetchDiskMap`
  (`session.ts:312-329`).

### Processing Chain: page state

1. `StreamState` (`controller.ts:149-203`), `INITIAL_STATE` (`:205-234`), updated by
   `this.set(patch)` (`:631-634`), read with `useSyncExternalStore` (`StreamApp.tsx:449`),
   published whole on `window.notesdStream` (`:474-481`).
2. `ControllerDeps` (`controller.ts:236-250`): `fetch`, `createEngine`, `textUrl`,
   `revokeTextUrl`, `muted`, `onSession`, `storage`, `memory`. No injected clock; tests use
   `vi.useFakeTimers`.
3. Position: every `POSITION_INTERVAL_MS` 5000 `onTick` (`:1417-1420`) calls `report()`
   (`:1442-1469`), which posts `{position_s, duration_s, ended, paused, beat?, closed?}` to
   `POST /api/stream/sessions/:id/position` (schema `directStreamApi.ts:288-295`). The answer's
   `subtitle_rev` / `source_rev` drive `followSubtitleRev` / `followSourceRev`. A paused page's
   `beat` never writes the database (`directStreamApi.ts:331-337`).
4. Player log lines: `note()` (`:636-639`) → `POST /api/stream/sessions/:id/events`
   (`session.ts:538-567`, `streamEvidenceApi.ts:40`).
5. Layout: `.st-stage` fixed, `overflow:hidden` (`stream.css:1-9`); controls hide after
   `IDLE_MS` 2500 (`StreamApp.tsx:63`, `:575`; `.st-top`/`.st-bar` to `opacity:0;
   pointer-events:none`, `stream.css:53-64`); `.st-bar` is `position:absolute; bottom:0;
   padding:36px 20px 16px` (`:73-80`); pop-up precedent `.st-pop`/`.st-menu` (`:193-206`); no
   `z-index` anywhere; `.st-video` has `opacity:0.999` on purpose (`:20-26`); `.st-btn` radius 2px.

### Entry Point: the session the page reads

**Location:** `GET /api/stream/sessions/:id` (`src/http/directStreamApi.ts:147-151`), built by
`sessionInfo()` (`src/directStream/service.ts:2344-2403`), type `SessionInfo` (`:137-189`).
**Fields:** `session_id, kind, tmdb_id, season, episode, title, provider, manifest_kind,
manifest_url, subtitles, best_height, audio_lang, audio, resume_s, prev_episode, next_episode,
created_at, refreshed_at, expires_at, cached {id,state,height}|null, torrent
{info_hash,file_index,name,index,state,seeds}|null, subtitle_rev, source_rev, source_note`.
No duration, no preview field. 403 `UNKNOWN_SESSION` for an unknown id.

Web side: `StreamSession` (`web/src/stream/session.ts:17-43`), `parseSession` (`:158-203`); route
addresses listed at `session.ts:221-232`.

Where each kind is created:

- Pass-through: `sessions.create(...)` at `service.ts:610` and `:985`; `SessionStore.create`
  (`sessions.ts:171-213`). In memory only. A replay always resolves again (`service.ts:975-988`).
- Cache: `sessionFromCache` (`service.ts:1332-1337`), `playable()` and `cacheSource()`
  (`cachePlay.ts:101-128`), `SessionCache` (`cachePlay.ts:82-88`).
- Torrent: `sessions.createTorrent` at `service.ts:1085`, `:1118`, `:1134`; `SessionTorrent`
  (`sessions.ts:21-71`, holds `durationS`, `fileIndex`, `manifestKind`, `height`); from disk at
  `torrent/source.ts:1003-1024`.
- Remux: `fileForPage` (`torrent/source.ts:1076-1101`) gives `manifestKind:'hls'` and
  `remuxPlaylistUrl` (`remux.ts:104-108`:
  `/api/stream/torrent/<hash>/hls/<index>/index.m3u8?remux=1&total_s=<s>`).

### Entry Point: a provider's seek-preview track

**Location:** `claude/streaming/direct/resolve.mjs:203-212`

```js
export function isThumbnailTrack(hit) {
  if (typeof hit.body === 'string' && /#xywh=\d+,\d+,\d+,\d+/.test(hit.body)) return true;
  let path = pathOf(String(hit.url ?? '')); try { path = decodeURIComponent(path); } catch {}
  return /(?:^|[\/_.-])(?:thumbs?|thumbnails?|sprites?|storyboards?)(?:[\/_.-]|$)/i.test(path);
}
```

- Called only from `requestSubtitles` (`resolve.mjs:226`): `if (ext === 'vtt' && isThumbnailTrack(hit)) continue;`.
  The hit is skipped and recorded nowhere.
- The cue test rarely fires: `sniff.ps1` keeps a body only for manifest-like addresses, mpegurl or
  dash types, or a subtitle-index hit (`sniff.ps1:191`, `:452-462`); a plain `.vtt` hit has
  `body = $null` (`:261`). Detection is by name in practice.
- The sniffer records no `image/*` request (`sniff.ps1:189`, `:192`).
- Each hit carries `at_s, type, url, referer, origin, user_agent, document, status, mime, body`
  (`sniff.ps1:488-500`, `sniff.mjs:65-97`). Only the manifest hit's headers reach the source
  (`resolve.mjs:315`).
- Source shape (`pickSource`, `resolve.mjs:312-319`, extended `:611`): `{provider, embed_url,
  manifest_url, manifest_kind, headers:{referer, origin, user_agent}, subtitles:[{url, lang, label,
  format, source}], best_height, en_subtitle, audio, took_s}`. No thumbnail field.
- Daemon side: `parseResolveOutput` (`src/directStream/runner.ts:95-125`) validates with zod
  (`subtitleSchema` `:43-49`, `sourceSchema` `:51-69`) and strips unknown keys. Types
  `CapturedHeaders`, `SubtitleTrack`, `ResolvedSource`, `ResolveOutput` (`types.ts:86-135`).
- Test: one case, `tests/unit/scripts/directResolve.test.ts:239-251`.
- HLS image tags: `rewriteHls` (`rewrite.ts:46-66`) rewrites every `URI="..."` on any `#` line and
  learns its host; nothing reads `EXT-X-IMAGE-STREAM-INF`.

### Processing Chain: the pass-through

1. Route `GET /api/stream/sessions/:id/p?u=<encoded>[&vtt=1]` (`directStreamApi.ts:153`), address
   built by `proxiedUrl` (`rewrite.ts:37-39`). The session id is the only token.
2. Headers sent upstream are the three captured ones and `range` (`passThrough.ts:61-69`); "No
   cookie, nothing invented."
3. Host allow-list: `sourceHosts` (`sessions.ts:139-146`) takes the manifest's and each subtitle's
   host; `forward` refuses others with 403 `forbidden_host` before fetching
   (`passThrough.ts:116-119`); `learn()` adds hosts from redirects (`:150`) and from rewritten
   playlists (`:183`, `:188`).
4. `textKind` (`passThrough.ts:73-81`) names a request `vtt`, `hls`, `dash`, else `media`, which
   streams through untouched (`:198-204`). So a JPEG on an allowed host passes today as `media`.
5. Evidence: `observeForward` (`evidence.ts:309`) writes one `request` record per answer with
   `kind (hls|dash|vtt|media)` (schema `:41-59`). `deliveryByProvider` keeps `r.kind === 'media'`
   (`delivery.ts:83`), so a failing JPEG fetched as `media` would count in a provider's delivery
   verdict.

### Processing Chain: ffmpeg in the daemon today

| Where | Seam | Input | Limit |
|---|---|---|---|
| `picture.ts:83` `ffmpegFrameGrabber` | `execFile`; tests inject a `FrameGrabber` | remote manifest with captured headers | 40 s, `SIGKILL` |
| `picture.ts:348` `hlsSegmentFrameGrabber` | `execFile` | one TS segment on stdin | 40 s |
| `torrent/remux.ts:174` `remuxArgs`, `ffmpegSpawner` `:220` | `SpawnFfmpeg` via `opts.spawn` (`:270`) | file path once whole, else the daemon's own file route (`source.ts:1098`) | first segment in 60 s; `SIGTERM` then `SIGKILL` after 5 s |
| `torrent/probe.ts:118` `ffprobeFile` | `ProbeFile` | file route address | caller's timeout |
| `subtitles/whisper.ts:193` `ffmpegCutter` | `AudioCutter` | file route, remux playlist or manifest | 30 min |
| `hlsCut.ts:36` `withHlsSegments` | `spawn`, stdin | fetched segments | 150 s |
| `subtitles/embedded.ts:118` | `opts.spawn` | path or file route | stall timer |

- Binary: `NOTESD_FFMPEG_BIN`, default `'ffmpeg'` (`src/config.ts:156`), read as
  `directStream.ffmpegBin` (`:964`) and `torrent.ffmpegBin` (`:1024`).
- No ffmpeg run has a niceness, a shared queue or a global limit. The only `setPriority` is the
  Whisper worker's (`WORKER_NICENESS = 10`, `subtitles/whisper.ts:48`, `:460-466`).
- Test fakes: `tests/unit/directStream/remuxFakes.ts` (`fakeFfmpeg()`), real-ffmpeg tests use
  `describe.skipIf` (`torrentRemux.ffmpeg.test.ts:13`, `embedded.ffmpeg.test.ts:32`).

### Data Persistence

**Cloud cache** (`src/directStream/cache/`)

- Root `NOTESD_STREAM_CACHE_DIR`, else `<dataDir>/movies/stream-cache` (`types.ts:10`,
  `service.ts:566`); one folder `<root>/<uuid>/` with `cache.json`, `master.m3u8`, `video.m3u8`,
  `audio.m3u8`, `v|a-init-N.mp4`, `v|a-key-N.key`, `v|a-00001.ts|m4s|aac`, `subtitle.vtt`; or for a
  plain file `c-00000.bin` chunks joined into `video.mp4` (`plan.ts:20`, `:103-105`,
  `hls.ts:387-406`, `job.ts:167`, `:513-516`). Writes go to `*.part` then rename (`store.ts:38-42`).
- The file route `GET /api/stream/cache/:id/f/:name` serves only names matching `SERVED_NAME`
  (`store.ts:6`, `streamCacheApi.ts:110`).
- Whole = the row `stream_caches.state = 'ready'` with `completed_at` (`db/schema.ts:1614-1646`),
  written by `settle` → `repo.cacheReady` (`cache/service.ts:472-481`). No marker on disk and no
  listener: one log line.
- Partial coverage: `map()` (`cache/service.ts:271-306`) walks `video.m3u8` and counts segments
  whose files exist, as ranges in seconds; a plain file counts only once ready.
- Jobs: one download at a time (`CACHE_JOBS = 1`), a pause starts one
  (`POST /api/stream/sessions/:id/cache`, `directStreamApi.ts:187`, `service.ts:1425`), ahead jobs
  give way (`cache/service.ts:424-468`).
- Deletion: `StreamCache.remove` (`:374`) deletes folder and row; the Cache page goes through
  `CacheShelf.remove/undo/execute` (`cacheShelf.ts:310`, `:361`, `:374`) with a 10 s undo window
  and `<dataDir>/movies/cache-deletions.json`; auto caches pruned after 3 days.
- Disk size: `CacheStore.diskSize` counts allocated blocks of **top-level files only**
  (`store.ts:110-126`).

**Torrents** (`src/directStream/torrent/`)

- Root `NOTESD_TORRENT_DIR`, default `<dataDir>/movies/torrents` (`config.ts:1013`);
  `<root>/<hash>/` holds the files at their torrent paths (`store.ts:19-31`), plus
  `notesd-remux/<index>/` (`index.m3u8`, `init.mp4`, `seg-NNNNN.m4s`, `done.json`, `probe.json`;
  `remux.ts:28-38`, `:100`), `notesd-cues/`, `notesd-whisper`, `notesd-sync`.
- Ownership for a partial delete: `ownersOf` (`usage.ts:18-36`) gives only `notesd-remux/<i>/…` and
  `notesd-cues/<embedded|whisper>-<i>…` to an episode; a file outside them has no owner and a
  partial `removeSlots` leaves it (`usage.ts:63-84`). `TorrentFolder.size` and `usage` walk the
  folder recursively (`store.ts:97-150`).
- File route `GET /api/stream/torrent/:hash/f/:index` (`streamTorrentApi.ts:91-189`, `serve`
  `service.ts:442`): from disk when whole, else through the swarm (a read waits for its pieces);
  410 `remuxed`; 409 `not_in_swarm`. Remux files at `GET …/hls/:index/:name`
  (`streamTorrentRemuxApi.ts:27`).
- Map `GET /api/stream/torrent/:hash/map`: the remux map `{duration_s, ranges:[[0,covered]]}` when
  a remux exists (`remux.ts:376-391`), else `TorrentMap {duration_s, ranges, length, byte_ranges}`
  with time ranges computed from bytes in proportion to the duration (`types.ts:204-212`,
  `service.ts:464-483`).
- Swarm holds: `use` (`service.ts:228`), `release` (`:263`), `drop`/`discard` (`:294`, `:307`),
  `settle` leaves the swarm when finished or after `TORRENT_LINGER_MS` 3 min idle (`:881-910`).
- Media only: `mediaOf` (`types.ts:63`), `mediaFiles` throws `not_media` (`service.ts:868`), the
  engine adds with `deselect: true` (`engine.ts:198`).
- Remux only: `RemuxOnly.blocker` (`remuxOnly.ts:26-100`), `dropNow` marks the row `remuxed` and
  deletes the original (`service.ts:652-694`).
- Clearing: every 6 h `pruneNow` (`service.ts:696`), `keepBudget` deletes whole hash folders above
  `budgetGb` 40 (`:747`, `config.ts:270`); `TorrentsRepo.deleteSlot` (`repo.ts:207`) for one episode.
- Completion: `TorrentRemux.whenDone` (`remux.ts:340`, fired in `finish` `:478-497`), one listener
  at `daemon.ts:465`. A torrent file becoming whole has no listener (`service.ts:885-905`).

### Exit Points

- What the page gets today: the session, the two maps, subtitles through `/p`, cache and torrent
  file routes. Nothing about previews.
- `GET /api/stream/sessions/:id/p` records evidence per request.

---

## Key Data Structures

- `SessionInfo` — `src/directStream/service.ts:137-189`; `StreamSession` (server) —
  `sessions.ts:81-131`; `SessionTorrent` — `sessions.ts:21-71`; `SessionCache` — `cachePlay.ts:82-88`.
- `ResolvedSource`, `SubtitleTrack`, `CapturedHeaders` — `src/directStream/types.ts:86-135`.
- `StreamSession` (web), `SessionSubtitle` — `web/src/stream/session.ts:6-43`.
- `StreamState`, `ControllerDeps` — `web/src/stream/controller.ts:149-250`.
- `TorrentMap` — `src/directStream/torrent/types.ts:204-212`.
- Evidence `request` record — `src/directStream/evidence.ts:41-59`.

---

## Dependencies

### Configuration / Environment / External Services

- `src/config.ts`: `parseDirectStream` (`:953-971`) and the torrent block (`:1010-1030`);
  `DEFAULT_DIRECT_STREAM_CONFIG` (`:226`, off) and `DEFAULT_TORRENT_CONFIG` (`:438`, off) are what
  tests use.
- Wiring: `AppDeps` (`src/deps.ts:36`, stream fields `:85-163`); builders in `src/daemon.ts`
  (`buildTorrentRemux` `:306`, `buildStreamCache` `:458`, `buildTorrentStreams` `:463`, deps `:533`);
  `startBackground` (`src/background.ts:49`) starts `streamCache`, `torrents`, `cacheShelf`
  (`:247-271`) and closes `torrentRemux` before the torrents (`:291-300`).
- A model of a job that gives way: `src/directStream/ahead.ts`.
- Docs checks: `scripts/docs/httpRoutes.ts` (`HTTP_GROUPS`, one string per `'METHOD /path'`),
  `scripts/docs/reference.ts:219-253` scans env names against
  `docs/guide/reference/configuration.md`.
- Proof harness: `.claude/skills/verify-notesd` (`up --direct-stream`, `--discovery`, `--torrent`);
  `scripts/verify.sh` pins the cache and torrent dirs (`:252-254`), remux on (`:350-358`), and never
  pins `NOTESD_FFMPEG_BIN`; fixtures `scripts/stream/make-{hls-fixture,hls-film,mkv-fixture,dash-fixture}.sh`,
  `scripts/torrent/make-fixture.sh`; page steps `scripts/stream/*.steps.mjs`; feature map
  `features/direct-streaming.md` ("Stream cache" `:364`, "Playing from the cache" `:386`,
  "Torrents: engine and file route" `:406`, "Torrent remux" `:517`).
- Pictures: `scripts/docs/shots/streaming.mjs` fakes the stream routes with Playwright `page.route`
  (`:123-163`) and takes `player`, `player.gif`, `player-torrent`, `player-fetching` (`:186-243`).
- Guide sections: `docs/guide/streaming.md` "Where subtitles are found" (`:554-560`), "Sessions and
  the pass-through" (`:829`), "The player" (`:1018`), "Caching a film or an episode" (`:1649`),
  "The torrent engine and its file route" (`:1916`), "The remux for files Chrome cannot play"
  (`:2240`), "One copy on disk" (`:2270`); `docs/guide/movies.md` "The Cache page" (`:679`).

---

## Reference List

| Symbol / key | File:line | Kind | Package |
|---|---|---|---|
| `.st-seek` range input | `web/src/stream/StreamApp.tsx:651-663` | def | web/stream |
| `formatClock` | `web/src/stream/StreamApp.tsx:76-82` | def | web/stream |
| `StreamState` / `INITIAL_STATE` | `web/src/stream/controller.ts:149-234` | def | web/stream |
| `report()` and rev following | `web/src/stream/controller.ts:1442-1469` | call | web/stream |
| `parseSession` | `web/src/stream/session.ts:158-203` | def | web/stream |
| `streamSessionJson`, `routeFetch` | `web/src/testing/streamFakes.ts` | test | web/testing |
| `isThumbnailTrack` | `claude/streaming/direct/resolve.mjs:203-212`, call `:226` | def · call | claude/streaming |
| `pickSource` | `claude/streaming/direct/resolve.mjs:312-319` | def | claude/streaming |
| thumbnail test | `tests/unit/scripts/directResolve.test.ts:239-251` | test | tests |
| `sourceSchema` | `src/directStream/runner.ts:51-69` | def | directStream |
| `ResolvedSource` | `src/directStream/types.ts:117-130` | def | directStream |
| `sourceHosts`, `allows` | `src/directStream/sessions.ts:139-152` | def | directStream |
| `textKind`, `forward` | `src/directStream/passThrough.ts:73-81`, `:116-204` | def | directStream |
| evidence `kind` | `src/directStream/evidence.ts:41-59`, `:309` | def | directStream |
| `deliveryByProvider` | `src/directStream/delivery.ts:83` | call | directStream |
| `SessionInfo`, `sessionInfo()` | `src/directStream/service.ts:137-189`, `:2344-2403` | def | directStream |
| position route | `src/http/directStreamApi.ts:288-337` | def | http |
| `CacheStore.diskSize`, `SERVED_NAME` | `src/directStream/cache/store.ts:6`, `:110-126` | def | directStream/cache |
| `StreamCache.map`, `remove` | `src/directStream/cache/service.ts:271-306`, `:374` | def | directStream/cache |
| `ownersOf` | `src/directStream/torrent/usage.ts:18-36` | def | directStream/torrent |
| `TorrentRemux.whenDone` | `src/directStream/torrent/remux.ts:340` | def | directStream/torrent |
| torrent `serve`, map | `src/directStream/torrent/service.ts:442-483` | def | directStream/torrent |
| `parseDirectStream` | `src/config.ts:953-971` | config | config |
| `HTTP_GROUPS` | `scripts/docs/httpRoutes.ts` | doc | scripts/docs |
| configuration rows | `docs/guide/reference/configuration.md` | doc | docs |
| player pictures | `scripts/docs/shots/streaming.mjs:123-243` | doc | scripts/docs |
| feature map | `.claude/skills/verify-notesd/features/direct-streaming.md` | doc | verify-notesd |

---

## Impact Points (files that WILL need changes)

1. `web/src/stream/StreamApp.tsx`, `controller.ts`, `session.ts`, `stream.css`, their tests and
   `web/src/testing/streamFakes.ts` — the hover box and the page's preview state (phase 4).
2. A new `src/directStream/previews/` module, `src/config.ts`, `src/deps.ts`, `src/daemon.ts`,
   `src/background.ts`, `src/directStream/service.ts` (`SessionInfo`), `src/http/directStreamApi.ts`
   (previews routes, the position answer), `src/directStream/cache/{store,service}.ts` (sizes,
   coverage), `scripts/docs/httpRoutes.ts`, `docs/guide/reference/*` — the builder, the store, the
   routes and the cloud-cache source (phase 1).
3. `src/directStream/torrent/{usage,service,store,remux,remuxOnly}.ts`, a torrent source in the
   previews module, `src/daemon.ts` wiring — torrent previews (phase 2).
4. `claude/streaming/direct/resolve.mjs`, `src/directStream/{runner,types,sessions,passThrough,evidence,delivery}.ts`,
   a provider source in the previews module, `tests/unit/scripts/directResolve.test.ts` — the
   provider's track (phase 3).
5. `docs/guide/streaming.md`, `docs/guide/movies.md`, `CLAUDE.md`,
   `scripts/docs/shots/streaming.mjs`, `.claude/skills/verify-notesd/features/direct-streaming.md`
   and its `scripts/stream/` steps — guide, pictures, feature map, the end-to-end proof (phase 5).

**This document describes. The plan files prescribe.**
