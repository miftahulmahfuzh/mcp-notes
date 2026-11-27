# Token-Maxxing Session — 2026-11-27: Split Player Controller

## 🎯 Achievement / End Result
- **Goal of the burn:** Break `web/src/stream/controller.ts` (1669 lines, the player page's whole brain) into cohesive modules with behaviour unchanged: same public surface, same rules (`STALLS_TO_SWITCH`, the stall windows, the cooldowns, the evidence log lines, the play counters in `playStats.ts`), with tests per module, proven on the real page build by the verify-notesd stream journeys.
- **Concrete changes:**
  - Commit 24dae9b `refactor(stream): split the player controller into one module per concern`: `controller.ts` 1669 -> 658 lines; new `playerState.ts`, `evidenceLog.ts`, `captions.ts`, `subtitleTracks.ts`, `stallWatch.ts`, `sourceSwitch.ts`, `reconnect.ts`, `pauseCache.ts`, `torrentWait.ts`, `previewFrames.ts`, `positionReports.ts` (all under `web/src/stream/`).
  - Commit 6944d9d `test(stream): one test file per player module; keys as a pure function`: StreamApp's key map moved into a pure `keys.ts` (`keyAction`); a fake host `fakeHost.ts`; eleven new test files (one per module plus `keys`); the pure `cueText`/`scaleRanges`/`onDisk` checks moved next to their modules; one row of `docs/guide/streaming.md`'s file map updated.
  - Scope stayed inside `web/src/stream/**` plus that one guide row. `claude/streaming/play.mjs` (the 2 px rule) was not touched.
- **Real value delivered:**
  - The most fragile client code is now eleven small files, each owning one rule, each behind a small `PlayerHost` interface, so an agent changing (say) the stall count reads 104 lines instead of 1669.
  - Every module has its own unit test against a fake host; the player suite went from 203 to 240 tests, and the 203 existing ones passed unchanged after the split (the behaviour-unchanged proof at unit level).
  - Proven on the real page build: verify-notesd journeys play-stats, torrent-player, player, recovery, preview-caption, source-switch, report-button, pause-cache and restart all PASS on throwaway daemons built from this worktree.
  - Found that the direct-stream journeys leak state into each other when run on one throwaway daemon (see Decisions).
- **Branch:** token-maxxing-2026-11-27-split-player-controller
- **Merge status:** on branch, NOT merged — this is a worker session; the coordinator owns landing worker branches
- **Approx token burn:** several million tokens (refactor, 11 test files, full unit + integration suites, four verify-notesd runs) 🔥

## Context & Motivation

This is a worker session of coordinator `orch-stream-play-log` (slug `split-player-controller`). The coordinator picked the idea; there was no menu.

The player page (`/stream/<session>`) is the most fragile client code in the repo. It juggles three engines (hls, dash, native), torrent waits, a pause cache, a carry-on after a daemon restart, source switching on repeated stalls, subtitle feeds that grow while a torrent downloads, seek previews and the position reports that feed `MovieStreams` and the play counters. All of it lived in one 1669-line `controller.ts`. Each change there meant reading the whole file to be sure a rule elsewhere was not broken, and the recent stream-play-log set had just added counters to it. Splitting it was the cheapest way to make future player work safe for an agent.

## What We Did (blow-by-blow)

1. **Read the controller end to end** and listed its concerns: state, engine wiring, the five "load another stream" flows, and ten independent rules that each touched state through a handful of fields and callbacks.
2. **Defined the seam.** `playerState.ts` holds `StreamState`, `INITIAL_STATE`, `ControllerDeps`, the `PlayerHost` interface (what a module may read and call on the controller: state, set, deps, log, the engine, the video element) and `TorrentView`, plus a comment map of which module owns what.
3. **Moved each rule into its own module**, text for text:
   - `evidenceLog.ts`: log lines batched to the daemon, 2000-character cap per line, 50 per post.
   - `captions.ts`: reading the caption, the G/H delay keys' effect, `cueText`.
   - `subtitleTracks.ts`: subtitle files, the 3 s hold, growing feeds, the menu's choice, subtitles the daemon replaced (`/sync-subtitle`).
   - `stallWatch.ts`: `STALL_MIN_MS`, the seek grace, `STALL_REPEAT_MS`, the window, 3 stalls to switch (4 for a torrent).
   - `sourceSwitch.ts`: `MAX_SOURCE_SWITCHES`, the cooldown, the owner's asks, a broken stream, daemon-made moves.
   - `reconnect.ts`: play memory, the carry-on after a daemon restart, retry and give-up.
   - `pauseCache.ts`: caching while paused and the cache map.
   - `torrentWait.ts`: torrent numbers and map, `onDisk`, `scaleRanges`, the "waiting for the torrent" mark.
   - `previewFrames.ts`: seek-preview reads keyed by rev.
   - `positionReports.ts`: 5 s reports, beats, end, close, with the `playStats.ts` counters.
4. **Kept the controller as the orchestrator** (658 lines): state, engine, and the five flows (open/goToEpisode, moveTo another source, moveOntoCache, swapTo after a daemon restart, refresh). It re-exports every constant and type that `StreamApp.tsx` and the tests import, so no import outside `web/src/stream/` changed.
5. **Ran the 203 existing player tests untouched** after the split: all green. Committed as 24dae9b.
6. **Added per-module tests.** Wrote `fakeHost.ts` (a `PlayerHost` with a fake clock, recorded log lines and recorded daemon calls), then one test file per module. Pulled StreamApp's key handling into a pure `keyAction` in `keys.ts` (same keys) so it could be tested without React. Moved the pure helper checks out of `controller.test.tsx`. 240 tests. Updated the guide's file-map row. Committed as 6944d9d.
7. **Proved it.** `npm run typecheck` clean; `npm test` 426 files / 4781 tests; `npm run docs:check` current; `npm run test:int` 108 files / 1083 tests. Then verify-notesd with `up --web` and `up --web --direct-stream` on throwaway daemons built from this worktree, running the stream journeys listed below. The live daemon on 7317 was never touched.
8. **Hit one flake and explained it.** pause-cache and restart timed out the first time, when they ran on the same throwaway run right after source-switch. The daemon had carried source-switch's "kept stalling" move for TMDB 550 into the next play. Each passed on a fresh `verify.sh up`.

## Code / Design Details

- **Before:** one `StreamController` class of 1669 lines, every rule reading and writing the same state directly.
- **After:** `StreamController` builds a `PlayerHost` view of itself and hands it to one object per concern (for example `SourceSwitcher` in `sourceSwitch.ts`, whose `SourceHost extends PlayerHost` adds only the calls it needs). Modules reach each other only through the controller, which keeps call ordering (which log line comes first, when a stall triggers a switch) exactly as it was.
- **Public surface unchanged:** `controller.ts` re-exports `INITIAL_STATE`, the state types, `cueText`, `onDisk`, `scaleRanges` and every timing constant (`STALLS_TO_SWITCH`, `TORRENT_STALLS_TO_SWITCH`, `STALL_MIN_MS`, `STALL_REPEAT_MS`, `STALL_WINDOW_MS`, `SEEK_GRACE_MS`, `MAX_SOURCE_SWITCHES`, `SOURCE_SWITCH_COOLDOWN_MS`, `RECONNECT_*`, `PAUSE_CACHE_DELAY_MS`, `POSITION_INTERVAL_MS`, ...) from the module that now owns it.
- **Log line texts** were copied verbatim; the evidence lines are what `/report-stream-bug` and the verify journeys grep for, so a reworded line would be a behaviour change.
- **`keys.ts`:** `keyAction(e) -> KeyAction | null` over the key and its modifiers; `StreamApp.tsx` now maps the action to a call, so the key table is testable without jsdom focus handling.
- **The 2 px rule** lives in `claude/streaming/play.mjs`, outside this scope, and was not touched.

## Decisions & Trade-offs

- **A narrow host interface.** Each module sees the controller only through `PlayerHost` (or a small extension of it), never the whole class; this lets tests drive a module with a fake host without spinning up an engine.
- **Controller keeps the five load flows.** They each touch nearly every module (reset stall count, reset switches, reload subtitles, restart reports), so splitting them out would only have moved the coupling.
- **`controller.test.tsx` stays large (about 2050 lines) on purpose:** those are the wiring tests through the whole controller and they are the proof the split changed nothing. The new per-module tests sit beside them, not instead of them.
- **Journey isolation finding:** direct-stream journeys share daemon state (a source-switch move for a title is remembered), so running several on one `verify.sh up` can fail a later one. Each needs its own run.

## Follow-ups & YAGNI notes

1. The seek-bar pointer/drag handling in `StreamApp.tsx` was left alone: React state, already small.
2. `controller.test.tsx` could later be split by describe block into files per concern; not done, since it guards the wiring as one piece.
3. Document in the verify-notesd feature map (`features/direct-streaming.md`) that the direct-stream journeys each need a fresh `verify.sh up`.

## Appendix

Commands run:

```sh
npm run typecheck
npm test                 # 426 files / 4781 tests
npm run docs:check
npm run test:int         # 108 files / 1083 tests
# verify-notesd, throwaway daemons from this worktree
verify.sh up --web
verify.sh up --web --direct-stream
```

Journeys that passed:

- play-stats.steps.mjs: FIRST FRAME, STALL, GRACE, BEAT, NEW LOAD, TORRENT WAIT
- torrent-player.steps.mjs: TORRENT STATUS, HIDDEN, TORRENT WAIT, NO AUTO MOVE, TORRENT READY, SHUFFLE
- player: J1, API, BUFFER, J3, J2, MUTED, CDN
- recovery: RECOVER, SPENT
- preview-caption
- source-switch: SWITCH, SWITCH SESSION, DELIVERY, ORDER
- report-button
- pause-cache: BAR, PAUSE CACHE, CACHE BAR, CACHE PLAY
- restart: RESTART, RELOAD, CACHE LEAVE

Evidence: `~/.local/state/notesd-verify/1127-130826-3356965`, `1127-131245-3386918`, `1127-131453-3403066`, `1127-131514-3404967`.

Commits: 24dae9b (split), 6944d9d (tests, keys, guide row).
