# Plan: Seek preview thumbnails on the direct-stream player

**Slug:** seek-preview-thumbnails
**Date:** 2026-11-20 19:24 WIB
**Analysis:** `.workflows/analyze/20261120-192436-K7QP_code_analyzer.md`
**Worktree:** `/home/miftah/.worktrees/mcp-notes/seek-preview-thumbnails`
**Branch:** `feature/seek-preview-thumbnails` (base: `origin/main` @ `77051ca`)
**Phases:** 5
**Status:** planned
**Coordinator:** —

---

## Why

The owner's words, verbatim:

> usually in some streaming website, where there is a forward-caching where the system will download the movie ahead of the user watch position,
> user hover on the timeline and see miniscreen showing the scene of that timestamp. what do we call this feature?
>
> can we build it here?

and, on the proposal that answered it (sources: a provider's own preview track, a film on disk, a
torrent still downloading; not a cloud stream with neither; a timestamp alone where there is no
picture; pictures for the part on disk; made in the background at low priority):

> /analyze this so we ship a robust feature

## Requirements

| ID | What the user asked for (verbatim) | Phases |
|---|---|---|
| R1 | user hover on the timeline and see miniscreen showing the scene of that timestamp. [...] can we build it here? | 1, 2, 3, 4, 5 |
| R2 | this so we ship a robust feature | 1, 2, 3, 4 |

### Acceptance Criteria

| ID | Pattern | Criterion | Phases | Journeys |
|---|---|---|---|---|
| R1.1 | event | WHEN the pointer is over the timeline of the direct-stream player page THE SYSTEM SHALL show a box above the pointer with the timestamp of that position and, where the session's previews hold a frame for that position, that frame | 4 | P4.J1, P4.J4 |
| R1.2 | state | WHILE a stretch of a cloud stream's cache is on this machine THE SYSTEM SHALL list preview frames for that stretch in `GET /api/stream/sessions/:id/previews` of a session playing that title | 1 | P1.J1, P1.J2 |
| R1.3 | state | WHILE a stretch of a torrent's video file (the file as downloaded, or its remux) is on this machine THE SYSTEM SHALL list preview frames for that stretch in `GET /api/stream/sessions/:id/previews` of a session playing that file | 2 | P2.J1, P2.J2, P2.J4 |
| R1.4 | optional | WHERE a cloud provider's page loaded a seek-preview WebVTT track THE SYSTEM SHALL list that track's frames in `GET /api/stream/sessions/:id/previews`, each fetched through the pass-through | 3 | P3.J1 |
| R1.5 | event | WHEN the preview frames of the session on screen change THE SYSTEM SHALL have the open player page use the new frames without a reload | 1, 4 | P1.J3, P4.J2 |
| R1.6 | complex | WHILE a film whose video is on this machine plays in the player WHEN the pointer rests on the timeline at a position on disk THE SYSTEM SHALL show a frame taken within one preview interval of that position | 5 | P5.J1, P5.J2 |
| R2.1 | unwanted | IF the session's previews hold no frame for the hovered position, or a frame's picture fails to load, THEN THE SYSTEM SHALL show the timestamp alone and no broken picture | 4 | P4.J3 |
| R2.2 | unwanted | IF ffmpeg is missing, fails or runs past its time limit while making a sheet THEN THE SYSTEM SHALL keep no part of that sheet, leave the play untouched and try that sheet again at most a fixed number of times | 1 | P1.J7 |
| R2.3 | ubiquitous | THE SYSTEM SHALL run at most one preview ffmpeg at a time, at lowered CPU priority | 1 | P1.J1, P1.J2 |
| R2.4 | state | WHILE a torrent is not whole on disk THE SYSTEM SHALL make its previews without selecting, waiting for or fetching any piece and without holding the torrent in the swarm | 2 | P2.J2, P2.J3 |
| R2.5 | event | WHEN a stream cache or a torrent download (whole, or one episode of it) is deleted THE SYSTEM SHALL delete its preview files with it, and count them in that item's size on disk until then | 1, 2 | P1.J5, P2.J5 |
| R2.6 | unwanted | IF a provider's preview track cannot be fetched, is over the size limit or holds no picture cue THEN THE SYSTEM SHALL list no frame from it and record nothing against that provider's delivery | 3 | P3.J2, P3.J3 |
| R2.7 | optional | WHERE `NOTESD_STREAM_PREVIEWS=off` THE SYSTEM SHALL start no preview build and answer the previews route with no frame | 1 | P1.J6 |
| R2.8 | event | WHEN the daemon restarts while previews of a film are partly made THE SYSTEM SHALL keep the finished sheets and make only the missing ones | 1 | P1.J1, P1.J4 |

## Scope

**In scope**

- The hover box on the timeline of notesd's own player page (`web/src/stream/`).
- A previews module in the daemon (`src/directStream/previews/`): sprite sheets made by ffmpeg
  from video that is on this machine, kept beside that video, listed and served per session.
- Three sources of frames: a cloud stream's cache, a torrent's file or remux, a provider's own
  seek-preview WebVTT track.
- Sizes, deletion, the switch (`NOTESD_STREAM_PREVIEWS`), docs, pictures, the feature map.

**Out of scope**

- Frames for a cloud stream that has no provider track and no cache on disk. Making them means
  hundreds of requests to the stream host per film; the hover shows the timestamp alone there.
- HLS image playlists (`EXT-X-IMAGE-STREAM-INF`) and DASH image adaptation sets as a source.
- A provider track's body in the sniffer: `sniff.ps1` is not changed. The track is told by its
  name in the resolver and proved by its cues in the daemon.
- VLC plays (DM, DS) and the streaming sites' own players.
- A database table. Preview state is files beside the video.
- Thumbnails on the Movies page or the Cache page.

## Interface contract (fixed; every phase builds against it)

Phases 1 and 4 are built at the same time by sessions that cannot see each other. This contract is
what both sides implement. A phase that needs it changed stops and reports; it does not change it.

**The previews of a session**

```
GET /api/stream/sessions/:id/previews
200 {
  "state": "none" | "partial" | "ready",
  "rev": <integer, the session's preview_rev>,
  "source": "provider" | "local" | null,
  "cues": [ { "start_s": 0, "end_s": 10, "url": "/api/stream/...", "x": 0, "y": 0, "w": 240, "h": 135 } ]
}
403 { "error": "unknown_session" }   (exactly as GET /api/stream/sessions/:id answers it)
```

- `cues` is sorted by `start_s`, never overlaps, and may have gaps (video not on disk yet). `none`
  always comes with `cues: []` and `source: null`. `ready` means the whole film is covered.
- `url` is a same-origin address the page uses as is: a sheet of this daemon
  (`GET /api/stream/sessions/:id/previews/:name`, phase 1) or the pass-through with the picture's
  address (`/api/stream/sessions/:id/p?u=...&img=1`, phase 3). The page never builds or changes it.
- `x, y, w, h` are the frame's rectangle inside the picture at `url`, in pixels.
- A frame's `[start_s, end_s)` is the stretch of the film it stands for.

**How the page learns of a change**

- `GET /api/stream/sessions/:id` carries `preview_rev` (integer, starts at 0).
- The answer of `POST /api/stream/sessions/:id/position` carries `preview_rev` beside
  `subtitle_rev` and `source_rev`.
- The page fetches the previews once after the session loads and again whenever a `preview_rev` it
  is given is higher than the one it holds. It never polls the previews route on a timer.
- The daemon raises a session's `preview_rev` whenever that session's cue list changes. One mechanism for every
  source: `StreamPreviews.list(session)` compares the list with the last one that session was given and raises
  `preview_rev` when it differs; a route read, a look on a position report, a made sheet and a source's
  `PreviewSourceDeps.changed(session)` all go through it. The position answer never awaits a source's `list()`.

**Inside the daemon (phase 1 defines, phases 2 and 3 implement one each)**

```ts
// src/directStream/previews/types.ts
export interface PreviewCue { start_s: number; end_s: number; url: string; x: number; y: number; w: number; h: number }
export interface PreviewList { state: 'none' | 'partial' | 'ready'; source: 'provider' | 'local' | null; cues: PreviewCue[] }

/** One source of frames. Asked in the order: provider, torrent, cache. The first that answers
 *  a list whose state is not 'none' is the session's list. */
export interface PreviewSource {
  readonly name: 'provider' | 'torrent' | 'cache';
  /** The frames this source has for the session now. Never throws; 'none' when it has nothing. */
  list(session: StreamSession): Promise<PreviewList>;
}

/** Video on this machine that sheets can be made from. Phase 1 builds from it; the cache source
 *  (phase 1) and the torrent source (phase 2) each describe their own. */
export interface LocalVideo {
  /** Stable for the same bytes across restarts; a folder name. */
  readonly key: string;
  /** Where the sheets and their index live (beside the video; made when missing). */
  readonly dir: string;
  readonly durationS: number;
  /** The stretches of the film that can be read now without any network: seconds. */
  coverage(): Promise<Array<[number, number]>>;
  /** ffmpeg input (and input arguments) for one stretch that coverage() said is there. Reading it
   *  must never fetch, select or wait for anything. `args` is the whole input section: input options,
   *  the seek to startS (`-ss`) and the length (`-t`), then `-i <address>`; the builder adds no seek of
   *  its own. `cleanup` runs after ffmpeg ended and may throw PreviewNotYet (not a failure). `loopback`:
   *  the input reads this daemon's own 127.0.0.1 gate over http (a torrent file partly on disk); only then
   *  does the builder allow http, and only to 127.0.0.1. */
  input(startS: number, endS: number): Promise<{ args: string[]; cleanup?: () => Promise<void>; loopback?: true }>;
}
```

The `loopback` field is the one change made to this contract, by the reconciler (Decisions); the page-facing
contract above is unchanged.

Phase 1 owns these files and the registry the sources are listed in
(`src/directStream/previews/sources.ts`: `PREVIEW_SOURCES`, one factory `(deps: PreviewSourceDeps) =>
PreviewSource | null` per line; `PreviewSourceDeps` carries `config`, `directStream`, `streamCache`, `torrents`,
`fetch` (the pass-through's), `changed(session)` and `log`). Phases 2 and 3 each add one file there, one import and
one line to the registry, and neither edits `src/daemon.ts`.

**The sheets (phase 1 decides the numbers; the page does not depend on them)**

A frame every 10 s, 240 px wide, the height from the picture's shape; a sheet is one JPEG of at
most 6×6 frames (360 s of film) and is made only when its whole stretch is on disk. So previews
grow sheet by sheet with what is on disk, a finished sheet is never made again, and a film is
`ready` when its last sheet is.

## Invariants

1. The tree builds, `npm run typecheck` and `npm test` pass at the end of every phase (this
   includes the docs check: a phase that adds a route or an env var documents it in the same phase).
2. Making previews never changes a play: no change to what a session plays, to its manifest, to a
   remux or to a download's order. A failure of any preview code is a missing picture and one log
   line, never an error on the page or a failed route of the play.
3. A preview build makes no network request and joins no swarm. A torrent is never `use`d, held,
   selected or read through the swarm for a preview. Only the torrent's video file (or its remux)
   is read. A preview ffmpeg opens local files, or this daemon's own loopback gate for a partly
   downloaded torrent file; never another host.
4. Every request to a stream host for a provider's track goes through the pass-through with the
   headers the resolve captured: nothing invented, no host fetched that the track did not name.
5. One preview ffmpeg at a time, niced, binary from `NOTESD_FFMPEG_BIN`, spawn injected in tests.
6. No database change. No new writer of any `movie_*`, `stream_*` table.
7. Tests inject every path, binary, fetch and clock; none touches the network, the real
   `~/.claude` or the streaming Chrome. `DEFAULT_DIRECT_STREAM_CONFIG` has previews off.
8. The player's subtitles and controls stay visible; the hover box never takes pointer events and
   never keeps the controls from hiding.
9. `titleSearchExclusion`, `/sync-subtitle`'s rounds, the 2 px rule, WARP and the watch codenames
   are not touched.

## Phases

| # | Title | Satisfies | Package | Files | Depends on | Difficulty | Plan | TaskID | Card |
|---|-------|-----------|---------|-------|-----------|------------|------|--------|------|
| 1 | Preview core: builder, store, routes, the cloud-cache source | R1, R2 | `src/directStream/previews`, `src/http` | 33 | — | HARD | `.workflows/plan/seek-preview-thumbnails/phase-1.md` | P1-NOTES-A139 | — |
| 2 | Torrent previews: file, remux, partial download | R1, R2 | `src/directStream/torrent`, `src/directStream/previews` | 7 | 1 | HARD | `.workflows/plan/seek-preview-thumbnails/phase-2.md` | — | — |
| 3 | A provider's own preview track | R1, R2 | `claude/streaming/direct`, `src/directStream` | 20 | 1 | NORMAL | `.workflows/plan/seek-preview-thumbnails/phase-3.md` | P1-NOTES-SP03 | — |
| 4 | The hover box on the player page | R1, R2 | `web/src/stream` | 9 | — | NORMAL | `.workflows/plan/seek-preview-thumbnails/phase-4.md` | — | — |
| 5 | Guide, pictures, feature map and the end-to-end proof | R1 | `docs`, `scripts/docs`, `.claude/skills/verify-notesd` | 10 | 1, 2, 3, 4 | NORMAL | `.workflows/plan/seek-preview-thumbnails/phase-5.md` | — | — |

Phases 1 and 4 run at the same time; 2 and 3 after 1, at the same time as each other; 5 after all four.
Shared files, in landing order: `src/directStream/sessions.ts` (1: `previewRev`; then 3: `sourceHosts`, another
region), `src/http/directStreamApi.ts` (1: one import, the two previews routes after the session route, the position route;
then 3: the `/p` route, another region, found by its path below phase 1's routes), `scripts/docs/httpRoutes.ts` (1: the
session, position and two previews entries; then 3: the `/p` entry and the previews entry's `source` sentence, quoting
phase 1's), `docs/guide/reference/http-api.md` (generated: 1 then 3 run `npm run docs:gen`, never hand-edited), `src/directStream/previews/sources.ts` (1 creates it;
2 and 3 each add one import and one line, and whichever merges second keeps both: provider, torrent, cache),
`docs/guide/reference/configuration.md` (1: the row; then 5: its link). `src/daemon.ts` and `src/background.ts` are
phase 1's alone.

Every phase but the last serves both R1 and R2. That coupling is real: R2 ("robust") is a quality
of each part of R1, not a separate deliverable, so its criteria live in the phase that builds the
part they guard.

### Phase 1 — Preview core: builder, store, routes, the cloud-cache source
**Satisfies:** R1, R2
**Criteria:** R1.2, R1.5, R2.2, R2.3, R2.5, R2.7, R2.8
**Owns:**
- `src/directStream/previews/`: the types of the contract, the sheet plan (which stretches make
  which sheet), the ffmpeg sheet builder (spawn injected, niced, time limit, abort, `*.part` then
  rename, bounded retries), the one-at-a-time queue with the session on screen first, the on-disk
  index of finished sheets, the cue list from the index, the source registry, the cloud-cache
  source and its `LocalVideo` (HLS cache and plain-file cache; partial and whole). The builder runs `-xerror`,
  under `-protocol_whitelist file,crypto,data,concat` (plus `http,tcp` for a `loopback` input, refused unless every
  address is `http://127.0.0.1`), awaits `cleanup()`, treats `PreviewNotYet` as "not yet" (never a try), and never
  makes a video's home folder again: before a sheet is kept it re-checks that the video's folder still exists.
- The cache source answers only a session that plays from that cache (its `cached`); a pass-through session of a
  title cached here gets none from it.
- What starts a build: a session on screen whose title has video on disk (looked at again as
  coverage grows), and a sweep at start and on a timer for whole caches with no previews.
- `preview_rev` on the server session, in `SessionInfo` and in the position answer; `StreamPreviews.changed`;
  `DirectStreamService.passThroughFetch` and `PreviewSourceDeps` with `torrents`, `fetch`, `changed`, `log`.
- The two routes (`GET /api/stream/sessions/:id/previews`, `GET /api/stream/sessions/:id/previews/:name`),
  their entries in `scripts/docs/httpRoutes.ts`, `npm run docs:gen`.
- `NOTESD_STREAM_PREVIEWS` in `src/config.ts` (on by default, off in
  `DEFAULT_DIRECT_STREAM_CONFIG`), its row in `docs/guide/reference/configuration.md`, and in
  `.claude/skills/verify-notesd/scripts/verify.sh` the one rule every phase's proof uses: off by default, a
  caller's `NOTESD_STREAM_PREVIEWS=on` passed through.
- Wiring in `src/deps.ts`, `src/daemon.ts`, `src/background.ts` (start; close before every other closer).
- The cache's size on disk counting the previews folder, and its deletion taking it along.

**Does not touch:** `web/`, `claude/streaming/`, `src/directStream/torrent/`, `passThrough.ts`,
`evidence.ts`, `delivery.ts`, the guides' prose, `scripts/docs/shots/`.
**Exit criteria:** with a cache on disk (whole or partly), a session playing that title answers
the previews route with frames for exactly the stretches on disk; sheets survive a restart; a
failing ffmpeg leaves no file and stops after the retry limit; with the switch off nothing is
spawned.

### Phase 2 — Torrent previews: file, remux, partial download
**Satisfies:** R1, R2
**Criteria:** R1.3, R2.4, R2.5
**Owns:**
- `src/directStream/previews/torrentSource.ts` and its registry line: phase 1's `LocalSource('torrent', …)` over
  `TorrentVideos` (a `LocalVideos`), with a `LocalVideo` for a torrent file whole on disk (read from its path), for
  a remux (its init and segments through ffmpeg's `concat:`, whole or growing), and for a file partly on disk that
  plays as is; each names its home `<hash>/`.
- For the partly downloaded file: reading only what is on disk, through an in-process 127.0.0.1 gate
  (`loopback: true`) that serves verified pieces only and answers 416 for anything else. A read that would need a
  piece that is not there ends the sheet at once as `PreviewNotYet` (never a try used up) instead of waiting or
  reading a hole's zeros; the byte-to-time map is used only to decide when a sheet is worth trying.
- Sheets kept in `<hash>/notesd-previews/<file index>/`; `ownersOf` giving them to their episode so
  a one-episode delete takes them; sizes counting them; the budget clearing and whole-folder delete
  taking them (already recursive: prove it).
- Remux only: sheets made from the original stay valid when the original is deleted; a film that
  lives as its remux gets its sheets from the remux.
- The sweep for whole torrent files and whole remuxes with no previews (an episode fetched ahead
  has its previews before it is played).

**Does not touch:** `web/`, `claude/streaming/`, the cache source, the builder and queue of phase 1
(uses them as they are), `src/daemon.ts`, `src/background.ts`, `scripts/docs/httpRoutes.ts`, `passThrough.ts`, the
guides' prose.
**Exit criteria:** a torrent session's previews list frames for what is on disk, for all three
shapes; no preview code path calls `use`, selects a file or reads through the swarm (a test proves
the engine saw nothing); deleting one episode or the whole download leaves no preview file.

### Phase 3 — A provider's own preview track
**Satisfies:** R1, R2
**Criteria:** R1.4, R2.6
**Owns:**
- `claude/streaming/direct/resolve.mjs`: a `.vtt` hit that `isThumbnailTrack` names is no longer
  dropped without a trace; the source carries `thumbnails: {url, referer, origin, user_agent} | null`
  (the first such hit; still never a subtitle). Its test.
- `src/directStream/runner.ts`, `types.ts`: the field through zod into `ResolvedSource`.
- `src/directStream/previews/providerSource.ts` and its registry line: fetch the track once per
  session with the captured headers, a size limit and a time limit; parse its cues (a picture
  address with `#xywh=x,y,w,h`; a cue whose picture has no fragment is never listed, since the
  contract's cue needs a rectangle and only fetching every picture would tell it); resolve each
  picture against the track's address; allow the session to fetch the hosts the track named, and
  only those; list cues whose `url` is the pass-through with `img=1`. Its factory reads `deps.fetch`
  and calls `deps.changed`.
- `src/directStream/passThrough.ts`, `evidence.ts`, `delivery.ts`: a request with `img=1` is kind
  `image`: streamed through, its answer required to be an `image/*` type and under a size limit,
  recorded as `image` and never counted in a provider's delivery.
- The pass-through route's entry in `scripts/docs/httpRoutes.ts` (the `img` query) and the `source` sentence of
  phase 1's previews entry (`provider`), `docs:gen`.
- `claude/skills/report-stream-bug/diagnose.mjs`: a stream-bug report leaves evidence kind `image` out of the
  pass-through answers it judges, with its test.
- A cache made from a session with a provider track: the provider list is used while the stream
  host answers; nothing of the provider's pictures is saved.

**Does not touch:** `web/`, `sniff.ps1`, `sniff.mjs`, the builder, the torrent code, `rewrite.ts`,
`src/daemon.ts`, the guides' prose.
**Exit criteria:** a resolve whose page loaded `thumbs.vtt` gives a session whose previews are
`source: "provider"` with pass-through addresses; a track that is HTML, too big, unreachable or
without picture cues gives `none` and no evidence record of kind `media`; no request leaves for a
host the track did not name.

### Phase 4 — The hover box on the player page
**Satisfies:** R1, R2
**Criteria:** R1.1, R1.5, R2.1
**Owns:**
- `web/src/stream/session.ts`: `previewRev` parsed from the session, `fetchPreviews`, the address
  in the route list. `controller.ts`: `previews` in `StreamState`, fetched once after the session
  loads and again when a session or position answer carries a higher `preview_rev`; a failed fetch
  keeps the frames it had.
- `StreamApp.tsx` and `stream.css`: pointer position over `.st-seek` mapped to a time (the track's
  box, not the input's margins); a box above the pointer, clamped inside the stage, with the frame
  (a `div` with the sheet as background and the rectangle scaled to the box's width) and the
  timestamp under it; the timestamp alone when no cue covers the time or the picture failed to
  load; shown during a drag too; hidden on leave and when the controls hide; `pointer-events:none`.
- Sheets fetched only when hovered near them (the browser's cache does the rest); no preload of
  every sheet.
- `web/src/testing/streamFakes.ts` and the tests.

**Does not touch:** anything under `src/`, `claude/`, `docs/`, `scripts/`.
**Exit criteria:** against faked routes that follow the contract, a hover shows the right
rectangle and time, a hover over a gap shows the time alone, a higher `preview_rev` in a position
answer brings the new frames, and a 404 or a broken picture never shows an error or a broken image.

### Phase 5 — Guide, pictures, feature map and the end-to-end proof
**Satisfies:** R1
**Criteria:** R1.6
**Owns:**
- `docs/guide/streaming.md`: a "Seek previews" section (what is shown, the three sources and their
  order, what is never done, where the sheets live, the switch, the rules in the code), the line in
  "Where subtitles are found", the cache and torrent folder lists, "One copy on disk";
  `docs/guide/movies.md` (the Cache page's sizes include previews); the row in "What sets it apart"; the
  `NOTESD_STREAM_PREVIEWS` row's link in `docs/guide/reference/configuration.md` pointed at the new section.
- `CLAUDE.md`: the rules that must never change, in the Streaming list (no network and no swarm for
  a preview; one niced ffmpeg; a failure is a missing picture).
- `scripts/docs/shots/streaming.mjs`: the previews routes faked from the Sintel film, a
  `player-preview` picture, shown in the guide.
- `.claude/skills/verify-notesd/features/direct-streaming.md` (no other phase edits it): a "Seek previews" entry and its
  steps script under `scripts/stream/` that plays a cached film and a torrent film in the
  throwaway daemon with the machine's ffmpeg, hovers, and checks the frame shown against the frame
  ffmpeg gives for that time.
- Fixing what the end-to-end run finds in phases 1 to 4's code, each fix with its test.

**Does not touch:** the contract.
**Exit criteria:** the end-to-end steps pass for a cache play and a torrent play; `npm run
docs:check` is clean; the guide shows the new picture.

## Reconciliation Log

| # | Conflict | Kind | Resolution |
|---|---|---|---|
| 1 | Phase 1 put `-protocol_whitelist file,crypto,data` on every input and told phase 2 to read from disk; phase 2 reads a remux with `concat:` and a partial file through a 127.0.0.1 HTTP gate | contract drift | Phase 2's gate and `concat:` stand. Phase 1's whitelist is `file,crypto,data,concat`; an input answering the typed `loopback: true` gets `http,tcp`, and `refusedInput` refuses any `-i` address that is not `http://127.0.0.1` (test). Index invariant 3 and the contract's `input()` type updated |
| 2 | Who seeks: a double `-ss` would offset every frame | contract drift | One convention, in both plans' code and the contract comment: `input().args` carries `-ss`/`-t`, the builder adds no seek. Phase 1's builder test asserts exactly one `-ss` |
| 3 | Phase 1 `PreviewNotYet` vs phase 2 `PreviewBytesMissing` | duplicate work | One name, `PreviewNotYet`; `PreviewBytesMissing` removed from phase 2's code, tests and contract. The builder runs `-xerror`, awaits `cleanup()`, and treats `PreviewNotYet` as "not yet" when ffmpeg failed, keeping a sheet ffmpeg made (exit 0). Phase 2's gate also records an answer cut short at the end of the bytes on disk, so a gate miss never uses a try; phase 2's Risks rewritten |
| 4 | Phase 2 asked the builder not to bring back a deleted `<hash>/notesd-previews/<i>/` | gap | Phase 1: `PreviewHome`/`homeOf`; the builder makes `dir` one level at a time inside the home, never the home, and before keeping a sheet re-checks the home and `dir` exist (else `not_yet`, nothing kept, empty `dir` removed). Test "a delete racing the build". Phase 2's videos name `home: <root>/<hash>` |
| 5 | Registry context: phase 2 assumed a core `list(session, video)`, a `wholeVideos` hook and a `local` context member; phase 3 needed `fetch` and a change hook; `preview_rev` rose only on re-list | unmet assumption | `PreviewSourceDeps` = config, directStream, streamCache, torrents, `fetch` (new `DirectStreamService.passThroughFetch`), `changed`, log (unused `torrentRemux` dropped). One rev mechanism: only `StreamPreviews.list` raises it; `StreamPreviews.changed(session)` re-lists (test). Phase 2 rewritten as `LocalSource('torrent', TorrentVideos)` with `forSession`/`whole`, factory `torrentSource`; phase 3 exports factory `providerSource`. Neither edits `src/daemon.ts` |
| 6 | Index Phase 3 block let whole-picture cues be listed "with the page scaling it"; phase 3's plan drops them | contract drift | Phase 3 stands; index text fixed |
| 7 | Phase 1 pinned the switch on under `--direct-stream`; phases 2, 3, 5 pass `NOTESD_STREAM_PREVIEWS=on` | contract drift | One rule in phase 1's `verify.sh`: `NOTESD_STREAM_PREVIEWS=${NOTESD_STREAM_PREVIEWS:-off}` for every run. Phase 1's J2, J4, J7 and phase 3's J1/J2 setup now pass `=on`; phase 5's Step 9 candidate and A3 rewritten |
| 8 | Shared files: `sessions.ts` (1, 3), `httpRoutes.ts` (1, 3), `sources.ts` (2, 3), `background.ts` (1, 2), `configuration.md` (1, 5) | file collision | Sequence stated in the Phases section. `PREVIEW_SOURCES` one factory per line; phases 2 and 3 quote phase 1's list and the list after both. Phase 1's previews entry describes every local source so phase 2 never edits `httpRoutes.ts`; phase 3's new Step 11b replaces its `source` sentence, quoting it. `background.ts` is phase 1's alone |
| 9 | `report-stream-bug/diagnose.mjs` counts every pass-through answer, a failing preview picture included | gap | Phase 3 Step 15b: `isPass` leaves kind `image` out; test in `tests/unit/scripts/reportStreamBug.test.ts`; added to phase 3's J3 |
| 10 | Phase 5 assumed `window.notesdStream.previews` cues in the route's shape (`start_s`) or `null` | unmet assumption | Phase 4's real shape is camelCase (`startS`, `endS`) and `NO_PREVIEWS`, never null: phase 5's `judge()` and A1/A2 fixed. Selectors `.st-preview`, `.st-preview-frame`, `.st-preview-time`, `[data-testid="seek-preview"]` confirmed. Phase 1's `/api/stream/sessions/<id>/previews/<name>?k=<8hex>` and phase 3's `/api/stream/sessions/<id>/p?u=...&img=1` pass phase 4's `SAME_ORIGIN_PATH`; a 502 JSON from `img=1` fails phase 4's `Image()` probe (no change to phase 4) |
| 11 | Feature map ownership | duplicate work (checked) | Only phase 5 edits `features/direct-streaming.md`; phases 1 to 4 write their proof scripts to scratch or inline, none under phase 5's `scripts/stream/` names |
| 12 | Phase 1's cache source served a pass-through session from any cache of its title | contract drift | Cache source answers only `session.cache` (the session's `cached`); `CachePreviewView.find` removed; test "no other cache". Phase 3 rollback text and phase 5 guide and feature-map text updated |
| 13 | Phase 2's journeys read the previews route without position reports; phase 1 builds only for a session on screen (its reports) or in the half-hourly sweep | unmet assumption | Phase 2's setup gains `look` (one position report, then a read); J1, J2, J4, J5 use it; J2's after-close reads stay report-free |
| 14 | Phase 1's handoff asked phase 5 to point the `NOTESD_STREAM_PREVIEWS` row at `#seek-previews`; phase 5 did not | gap | Phase 5 Step 3b, its Files table and Leaves-alone line |
| 15 | Phase 1 closed the previews only before the cache, while phase 2's videos (and gate) read torrent files | ordering | Phase 1 closes the previews before every other closer in `startBackground` |
| 16 | Phase 3 had no step for the previews entry's `source: provider` that phase 1's handoff asked for | gap | Phase 3 Step 11b (row 8) |
| 17 | round 2: phase 2's tests named the sheet index `index.json` (and one sheet `sheet-0000.jpg`); phase 1's `sheetIndex.ts` writes `previews.json` (`PREVIEW_INDEX_FILE`) and `SHEET_NAME` is `sheet-NNNNN.jpg` | contract drift | Phase 2's `previewFiles.test.ts` and `torrentSource.test.ts` now seed `previews.json` and `sheet-00000.jpg`; J5's "E02 index" wording now names the file-index folder |
| 18 | round 2: phase 3 quoted `sessions.ts:138-146`/`:248-266`, `directStreamApi.ts:153-160` and `httpRoutes.ts:254-255` by today's lines, though phase 1 lands first and adds lines above each | file collision | Phase 3's Assumptions A6, Files row and Steps 5, 8, 10, 11 give both the line today and after phase 1 (`:143-151`, `:254-272`, the `/p` route below phase 1's previews routes, `:258-259`) |
| 19 | round 2: `src/http/directStreamApi.ts` (phases 1 and 3) and the generated `http-api.md` were missing from the shared-file landing order | file collision | Added to the Phases section's shared files |
| 20 | round 2: phase 1 Step 17 Change 3 quoted the position entry without the backticks it has in `httpRoutes.ts` (an exact replacement that would not match) | contract drift | Quoted verbatim in a fenced block |
| 21 | round 2: phase 1's `AppDeps.streamPreviews` comment still said the previews close before the stream cache (losing side of row 15) | contract drift | Comment says before every other closer |
| 22 | round 2: phase 5's "rules in the code" bullet said whoever changes a cue list raises `preview_rev` (pre-row-5 mechanism) | contract drift | Rewritten: `StreamPreviews.list` is the one place it rises; sources call `changed(session)` |

## Decisions

| Fork | Chosen | Rung |
|---|---|---|
| Partial previews: pictures for the part on disk, or none until the whole film is covered | pictures for the part on disk, sheet by sheet | 5: the proposal the owner ran `/analyze` on recommended it and nothing objected |
| When to make them: as soon as video is on disk, or on first hover | in the background as video is on disk, the session on screen first, one niced ffmpeg | 5: same |
| A cloud stream with no provider track and no cache | no frames, the timestamp alone | 5: same ("skip the fourth") |
| Where preview state lives | files beside the video, no table | 6: convention (`notesd-remux/`, `notesd-cues/`, `subtitle.vtt`) |
| How a provider's track is recognised, given `sniff.ps1` keeps no `.vtt` body | by name in the resolver, proved by its cues in the daemon; the sniffer is not changed | 6: the smallest change to a script that runs against live sites |
| Which source wins when two have frames | provider, then torrent, then cache: a provider's track covers the whole film at once | 4: R1.1 wants a frame wherever one exists |
| How the page learns of new frames | `preview_rev` in the position answer, as `subtitle_rev` and `source_rev` | 6: convention |
| ffmpeg's input protocols: phase 1 local files only, or phase 2's `concat:` and loopback gate | phase 2's gate and `concat:`; whitelist `file,crypto,data,concat`, widened to `http,tcp` only by the typed `loopback` field and only to `http://127.0.0.1` | 1: R2.4 and invariants 2/3 (a wrong frame is worse than no frame; the gate fetches nothing) |
| Who applies the stretch's seek | `input()`'s args (`-ss`/`-t`), never the builder | 3: both plans' code blocks already did this; the contract comment now says it |
| "Not yet" name, and whether a gate miss costs a try | `PreviewNotYet`, never a try; a sheet ffmpeg made (exit 0) is kept even if cleanup says not yet | 1: R2.2 counts failures of ffmpeg, and every byte an exit-0 run read was served from disk |
| What the gate counts as a miss | a 416 and an answer cut short at the end of the bytes on disk, recorded when served; the gap book holds the file back until that byte arrives | 1: R2.4 (nothing waited for or fetched) with invariant 2; the cost is only a short delay of the next partial sheet |
| A delete racing a build | the builder never makes a video's home and keeps a sheet only while home and `dir` exist | 1: R2.5 (a delete takes the previews with it) |
| How `preview_rev` rises for a source that learns of frames later | one mechanism: `StreamPreviews.list` compares; a source calls `deps.changed(session)` to have it re-listed | 3: phase 1's code (the signature compare) and phase 3's `onChange` |
| Phase 2's shape: its own `PreviewSource` over a core `list(session, video)`, or phase 1's `LocalSource` | `LocalSource('torrent', TorrentVideos)` | 3: phase 1's code blocks (the sheet route, look and sweep work only on `LocalSource`s); phase 1 is the ground truth for the core |
| Whole-picture provider cues | never listed | 1: R2.6 and "no frame is better than a wrong rectangle" |
| Previews in a verify run | off unless the caller sets `NOTESD_STREAM_PREVIEWS=on`, which passes through | 6: convention of `verify.sh` (canary, trending pinned off; opt-in features passed through) |
| Which cache a pass-through session's frames come from | only the cache the session plays from (its `cached`); none otherwise | 1: R1.6 (a frame within one interval of the position; another provider's copy may be offset) |
| Closing order | the previews close before every other closer | 6: convention of `startBackground` (a reader closes before what it reads, as `torrentRemux` before the torrents) |
| Previews entry in `httpRoutes.ts` for the torrent source | phase 1 writes it for every local source; phase 2 never edits the file; phase 3 adds `provider` | 6: one owner per file region, with phases 2 and 3 concurrent |
| The `NOTESD_STREAM_PREVIEWS` row's link to `#seek-previews` | phase 5 (Step 3b) | 4: the index gives the guide and its sections to phase 5 |
| The name of a video's sheet index (phase 2's tests used `index.json`) | `previews.json` (`PREVIEW_INDEX_FILE`) | 3: phase 1's code block (`sheetIndex.ts`) owns the file; phase 2 only seeds it in tests |

## Open Questions

None.

## Rollback

- As a whole: `NOTESD_STREAM_PREVIEWS=off` stops every build and empties the previews route, and
  the page then shows the timestamp alone. Reverting the merge removes the code; the
  `notesd-previews/` and cache `previews/` folders left on disk are deleted with their downloads.
- Per phase: each phase is one branch merged in order; reverting phase 2 or 3 removes one source
  and one registry line; reverting phase 4 removes the hover box and leaves the routes unused.
  Phase 3's resolver field is optional in zod, so an older daemon reads a newer resolver's answer.

## Next

Execute the phases one at a time, starting at phase 1:

    /implement -f .workflows/plan/SEEK_PREVIEW_THUMBNAILS_PLAN.md --phase 1

Or run the whole set as a swarm, a session per phase, concurrent wherever `Depends on` allows:

    /analyze-orchestrator -f .workflows/plan/SEEK_PREVIEW_THUMBNAILS_PLAN.md

Or put them on the board first:

    /create-task --from-plan .workflows/plan/SEEK_PREVIEW_THUMBNAILS_PLAN.md
