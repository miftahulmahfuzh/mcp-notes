# Token-Maxxing Session — 2026-11-27: Daemon Start Wiring

## 🎯 Achievement / End Result
- **Goal of the burn:** break up `src/daemon.ts`, the most edited file in the repo (67 commits in 14 days, test ratio 0.38), so each subsystem's start/stop wiring lives beside the subsystem and is unit-tested with injected deps, with behaviour and start order unchanged. Mid-session the owner asked for `src/background.ts` to be split the same way.
- **Concrete changes:**
  - `src/daemon.ts` 794 -> 189 lines; it now holds only the start order (and re-exports `CHAT_SUBDIR` and `IMPORT_RESTART_CHECK_MS`).
  - `src/background.ts` 328 -> 49 lines; it holds only the start and stop order.
  - New start files: `src/db/sharedImportStart.ts`, `src/db/egressStart.ts`, `src/reminders/start.ts`, `src/adversary/start.ts`, `src/sessions/start.ts`, `src/chat/start.ts`, `src/movies/start.ts`, `src/images/start.ts`, `src/embeddings/start.ts`, `src/directStream/start.ts`, `startChecks.ts`, `startSubtitles.ts`, `startTorrents.ts`, `startExtras.ts`, `startJobs.ts`.
  - 92 new unit tests in `tests/unit/start/` (7 files) plus `tests/helpers/startConfig.ts`.
  - Commits: `0a45e90` refactor(daemon), `1fcaaaa`, `c72756b`, `0a07911` test(daemon), `5b536cf` refactor(background). 25 files, +2988 / -965.
- **Real value delivered:**
  - The repo's hottest file stops being a merge-conflict magnet: a change to one subsystem's start now touches that subsystem's own `start.ts`, not a 650-line shared function.
  - Start wiring that had no direct test (closures, late-bound `deps.*` references, the movies/stream hooks, the shared-import restart loop) now has 92 unit tests driving it with injected deps.
  - Proven equivalent: start/stop logs of a throwaway daemon match the pre-refactor baseline, and the restart, direct-stream, torrent and subtitle journeys pass.
- **Branch:** token-maxxing-2026-11-27-daemon-start-wiring
- **Merge status:** on branch, NOT merged — this is a worker session; the coordinator owns landing worker branches
- **Approx token burn:** several million (two full-file refactors, 92 tests, repeated full-suite, integration and throwaway-daemon runs) 🔥

## Context & Motivation
This was a worker session under coordinator `orch-stream-play-log`, slug `daemon-start-wiring`. The idea came from `docs/plans/2026-11-27-holes-map.md` (section 1 #3, section 8 item 2): `src/daemon.ts` was 783 lines, edited in 67 commits over 14 days, with a test ratio of 0.38. One function of about 650 lines built every subsystem in turn: the shared Neon import merge and its restart loop, reminders, Seer Adversarial, the session ingester and summarizer, the chat backend, movies and their health check, direct streaming with its checks, subtitles, torrents, the canary, the cache shelf and the stream reporter. Every feature branch that touched any of those subsystems edited the same function.

The plan: move each subsystem's wiring into a start function beside it, keep behaviour and order unchanged, unit-test each start with injected deps, and leave `daemon.ts` holding only the order.

## What We Did (blow-by-blow)
1. **Chose to freehand rather than run `/analyze`.** The work was one file's wiring, read in full. The risk was in late-bound closures (references to `deps.torrents`, `deps.streamCache` and `directStream` captured inside callbacks that run after start), not in planning across phases, so a multi-phase plan would have added cost without catching that risk.
2. **Baseline proof on unchanged code first.** A verify-notesd throwaway daemon with `--discovery --torrent --adversary --sessions`: start, restart, and the start log saved as the reference. Then `--direct-stream` with `playlog.sh ask restart`: a restart closes 1 stream play and 2 play-log rows.
3. **refactor(daemon), `0a45e90`.** `daemon.ts` went from 794 to 189 lines. Each block moved into a named start function:
   - `src/db/sharedImportStart.ts`: `mergeSharedImportAtStart`, `startSharedImportRestart`, `IMPORT_RESTART_CHECK_MS`
   - `src/reminders/start.ts`
   - `src/adversary/start.ts`
   - `src/sessions/start.ts`: `buildSessionSummarizer`
   - `src/chat/start.ts`: `CHAT_SUBDIR`, `buildChatBackend`
   - `src/movies/start.ts`: `startMovies`, `startMoviesHealth`, `buildMovieWriters`
   - `src/directStream/start.ts`: `startDirectStreaming`, `movieStreamHooks`
   - `src/directStream/startChecks.ts`, `startSubtitles.ts`
   - `src/directStream/startTorrents.ts`: `torrentSourceFactory`, `buildTorrentSubtitles`, `loopbackBase`
   - `src/directStream/startExtras.ts`: `playingNow`, `buildCanary`, `buildCacheShelf`, `buildSubtitleCheck`, `buildStreamReporter`, `wireStreamExtras`
   
   `daemon.ts` re-exports `CHAT_SUBDIR` and `IMPORT_RESTART_CHECK_MS` so existing importers keep working.
4. **Tests, `1fcaaaa`, `c72756b`, `0a07911`.** 74 unit tests in `tests/unit/start/`: `sharedImportStart`, `smallStarts` (import, reminders, adversary, sessions, chat), `moviesStart`, `streamParts` (checks, subtitles, torrents), `directStreamStart`, `streamExtras`. The shared config builder is `tests/helpers/startConfig.ts`.
5. **The owner asked for `background.ts` too.** refactor(background), `5b536cf`: `background.ts` went from 328 to 49 lines. New `src/images/start.ts`, `src/embeddings/start.ts`, `src/db/egressStart.ts`, `src/directStream/startJobs.ts`, plus `startSessionsBackground` in `sessions/start.ts`, `startAdversary` in `adversary/start.ts` and `startMoviesSync` in `movies/start.ts`. 18 unit tests in `tests/unit/start/backgroundStarts.test.ts`. Stop order is unchanged: timers, inbox, previews and downloads first, then the rest in parallel in the original order.
6. **Proof after each split.** Details are in the Appendix. A throwaway daemon's start/stop logs matched the baseline, and the restart, direct-stream, torrent and subtitle journeys passed.
7. **The owner typed "p" (commit, push, rebuild, restart).** The commit and push went through a haiku subagent. The live daemon was not rebuilt or restarted, because an unbounded stream soak was running against 7317.

## Code / Design Details
- **Shape of a start function.** Each one takes the config and the already-built parts it needs (the `AppDeps` slices, the repos, the injected binaries and clocks) and returns what `daemon.ts` hands to the next step. No start function reads `process.env` or a global, which is why each one can be tested with fakes.
- **Late-bound references.** Some callbacks in the old function read `deps.torrents`, `deps.streamCache` or `directStream` when they *ran*, not when they were built. In the new code these closures read locals declared before the closures. That is equivalent only because `deps.*` was never reassigned after construction, which was checked before the change and then exercised by the direct-stream, torrent and subtitle journeys.
- **Order is the contract.** `daemon.ts` (189 lines) and `background.ts` (49 lines) now read as an ordered list of calls. The start log diff against the baseline is the check that nothing moved.
- **Connectors** have no start wiring in the daemon (`createApp` builds them), so nothing moved for them.

## Decisions & Trade-offs
- **Freehand over `/analyze`**: explained above. The cost of being wrong was covered by taking a runtime baseline before any change and diffing against it.
- **Re-exports kept in `daemon.ts`** for `CHAT_SUBDIR` and `IMPORT_RESTART_CHECK_MS`, so other modules and tests that import them did not need to change in this diff.
- **One haiku-authored trailer left as is.** `5b536cf` carries a `Claude Haiku 5.5` co-author line because the "p" push subagent wrote it. Fixing it would need a force-push, which this workflow does not allow.
- **No live restart.** The owner has standing consent for restarts, but a stream soak was running against 7317 and a restart would have ended it. The rebuild and restart are left for after the merge.
- **Timing flakes not chased.** Earlier `npm test` runs under load average ~42 had 2-3 timing failures in `audioVet`, `cacheShelf` and `installGuard`. Those files do not import the daemon, and each passed alone 3 times out of 3.

## Follow-ups & YAGNI notes
- Rebuild and restart the live daemon once the branch lands (`scripts/install.sh`, `--force` on exit 75).
- `docs/guide/architecture.md`'s file table does not list the new start files. `docs/**` belonged to a sibling worker, so add them after the merge.
- Mark the `daemon.ts` row of `docs/plans/2026-11-27-holes-map.md` done.
- Not done on purpose: renaming or reshaping the subsystems themselves, changing the start order, or adding start wiring for connectors. The goal was moving code with behaviour unchanged.

## Appendix
- **Typecheck:** `npm run typecheck` clean.
- **Unit:** `npm test` 4836/4836 (the timing-flake note is above).
- **Docs:** `npm run docs:check` current.
- **Integration:** `npm run test:int` 108 files / 1083 tests green after the daemon split. After the background split, the 6 integration files that drive `startBackground` ran 53/53.
- **Throwaway daemon (verify-notesd):** after each split, the start/stop logs matched the baseline except two background lines whose timing varies. `playlog.sh` restart journey PASS. Direct-stream journey (seed HLS evidence snapshot) PASS. `direct-stream/torrent.sh` (fallback named) PASS. Torrent `subtitles.sh` (files service borrow) PASS. A restart with torrent sessions open stopped cleanly on SIGTERM, closed 9 play-log rows as `restart`, and left nothing unhandled.
- **Diffstat** (`e6725a3..5b536cf`): 25 files changed, 2988 insertions, 965 deletions.
