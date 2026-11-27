# Token-Maxxing Session — 2026-11-27: Split Torrent Source

## 🎯 Achievement / End Result
- **Goal of the burn:** Break `src/directStream/torrent/source.ts` (1899 lines) and `src/directStream/torrent/service.ts` (1248 lines, `TorrentStreams`) into cohesive single-purpose modules with behaviour unchanged. Every export had to stay importable from the old paths, seams with no tests had to get tests, and the guide's citations had to follow the code.
- **Concrete changes:**
  - Commit 6c11be1 `refactor(torrent): split source.ts into single-purpose modules under source/`: `source.ts` is now an 81-line barrel over `src/directStream/torrent/source/`. The new modules are `constants`, `types`, `torrentSource` (the facade), `resolve`, `race`, `delivery`, `refusal`, `probeWhileDelivering`, `page`, `subtitles`, `kept`, `pack`, `pasted`, `learnMagnet`, `listing`, `disk`, `hearing`, `failures`, `hands`, `trackers`, `query`, `text`, `context` and `build`. The largest is `race.ts` at 278 lines.
  - Commit 7dc19a5 `refactor(torrent): split service.ts (TorrentStreams) into modules under streams/`: `service.ts` is now a 20-line barrel over `src/directStream/torrent/streams/`. `torrentStreams.ts` (592 lines) keeps the swarm lifecycle, next to `core`, `leave`, `files`, `views`, `originals`, `prune`, `types`, `util` and `build`.
  - Commit 568ec76 `test(torrent): cover the seams the split opened; cite the new modules in the guide`: 33 new tests in `tests/unit/directStream/torrent/source/` (`failures`, `pure`, `trackersAndListings`), `tests/unit/directStream/torrent/streams/pure.test.ts`, and `tests/unit/directStream/torrent/barrels.test.ts`, which pins both barrels' export lists. `docs/guide/streaming.md` now cites the new modules where the code it pointed at moved.
  - Pure seams pulled out so they can be tested on their own: `budgetOrder`, `lastActivity`, `secondsOf` and `FailureMemory`.
  - Scope stayed inside `src/directStream/torrent/**`, its tests, and the moved citations in the streaming guide.
- **Real value delivered:**
  - Two of the largest files in the repo, which hold the never-loosen torrent rules (title search exclusion, only video and subtitle files selected, a torrent in the swarm only while something uses it), are now small files that each own one job. An agent changing one rule reads one module of a few hundred lines at most, not 1899 lines.
  - Every caller still imports from `torrent/source.js` and `torrent/service.js`. A test pins both export lists, so a later change cannot drop an export from a barrel without a test failing.
  - Seams that had no tests now have them, including the prune order, the activity clock and the failure memory.
  - Proven unchanged three ways: unit and integration suites, a fresh-context reviewer comparing every method line by line, and verify-notesd torrent journeys on throwaway daemons.
- **Branch:** token-maxxing-2026-11-27-split-torrent-source
- **Merge status:** on branch, NOT merged — this is a worker session; the coordinator owns landing worker branches
- **Approx token burn:** several million tokens (two large refactors, a line-by-line review agent, full unit and integration suites, three verify-notesd journeys and a cacheShelf stress comparison) 🔥

## Context & Motivation

This is a worker session of coordinator `orch-stream-play-log` (slug `split-torrent-source`). The coordinator assigned the idea, so there was no menu.

The owner's stated goal is a codebase an agent can maintain safely. The torrent side of direct streaming was the weakest spot for that. `source.ts` held everything about finding and choosing a torrent: building the query, racing the indexes, ranking, refusing, probing delivery, pasted magnets, packs, kept torrents, subtitles, trackers, the disk view and the failure memory. `service.ts` held the whole `TorrentStreams` class, which manages the swarm lifecycle, files, views, originals and the prune. Several of CLAUDE.md's never-loosen rules live in these two files, so any change meant reading thousands of lines to be sure no other rule broke. Splitting them by concern was the cheapest way to make future torrent work safe.

## What We Did (blow-by-blow)

1. **Read `source.ts` end to end** and grouped its functions by concern. The groups were query building and text, the index race, delivery and refusal, probing while delivering, the page and subtitle helpers, the kept, pack and pasted flows, learning a magnet's index, listings, disk and hearing, the failure memory, hands, trackers, and the shared constants, types and context.
2. **Moved each group into its own module under `source/`** text for text, with `torrentSource.ts` as the facade that wires them together and `build.ts` constructing it. `source.ts` became a barrel that re-exports the same names.
3. **Captured the runtime export list of `source.ts` before and after** and compared them. They were identical.
4. **Did the same for `service.ts`.** The `TorrentStreams` class kept the swarm lifecycle (open, use, release) in `streams/torrentStreams.ts`. Its helpers moved to `core`, `leave`, `files`, `views`, `originals`, `prune`, `util` and `types`, and `build.ts` constructs it. `service.ts` became a 20-line barrel, and its export list was again identical before and after.
5. **Pulled out pure seams** that had been buried in methods: `budgetOrder` and `lastActivity` (the prune order), `secondsOf`, and `FailureMemory`.
6. **Wrote tests for the seams** that had none, plus `barrels.test.ts`, which pins both barrels' export lists so the compatibility promise is enforced and not just observed.
7. **Updated `docs/guide/streaming.md`** where it cited code that moved, so its "rules in the code" pointers name the new modules.
8. **Ran the gates:** `npm run typecheck` (exit 0), `npm run docs:check` (current), `npm run test:int` (108 files, 1083 tests, all pass) and `npm test` (4777/4777 on a clean run).
9. **Ran an independent review.** A fresh-context reviewer agent was given the originals and the new modules, not my conclusions, and compared every method line by line. It found no behavioural difference. Its only notes were:
   - facade wrappers add extra microtask turns, and nothing races on them;
   - internal calls no longer go through `this`, and nothing subclasses or spies on these classes;
   - the swarm is captured once at construction and never reassigned.
10. **Drove throwaway daemons with verify-notesd:**
    - `torrent.sh` PASS: idle files, refuses, range cap, leave, only disk.
    - `codenames.sh` PASS: the ten codename requests, including a real loopback torrent play.
    - `downloads.sh` PASS: story; a title goes through `fetchKept`, a season through `fetchPack`; cache.
    The live daemon on 7317 was never touched.
11. **Investigated flakes** that showed up under the machine's heavy load (see Decisions & Trade-offs).

## Code / Design Details

Before:

```
src/directStream/torrent/source.ts    1899 lines
src/directStream/torrent/service.ts   1248 lines
```

After:

```
src/directStream/torrent/source.ts      81 lines  (barrel)
src/directStream/torrent/source/        24 files, largest race.ts at 278 lines
src/directStream/torrent/service.ts     20 lines  (barrel)
src/directStream/torrent/streams/       10 files, largest torrentStreams.ts at 592 lines
```

- **Barrels keep the old paths.** Nothing outside `torrent/**` changed its imports. `barrels.test.ts` asserts the exact sorted export list of each barrel, so dropping or renaming an export fails `npm test`.
- **Facade, not inheritance.** `torrentSource.ts` and `torrentStreams.ts` hold the state and delegate to free functions that take a context (`source/context.ts`, `streams/core.ts`). That is what made the pure seams testable without the swarm.
- **The never-loosen rules moved whole.** `titleSearchExclusion` stays in `torrent/find/rank.ts`, which was untouched. The rules about selecting only video and subtitle files, and keeping a torrent in the swarm only while it is used, each landed in one module (`streams/files.ts`, `streams/leave.ts`, the lifecycle in `torrentStreams.ts`) and were not reworded.

## Decisions & Trade-offs

- **Barrels over updating every importer.** Keeping `source.ts` and `service.ts` as barrels kept the change inside the scope the coordinator gave and avoided touching callers across `src/`. The cost is one indirection, and the barrel test keeps it honest.
- **Stopped `torrentStreams.ts` at 592 lines.** The lifecycle methods share private state tightly, and splitting them further would have meant inventing a second state holder. That is left as a follow-up, not forced.
- **Flakes are pre-existing, not caused by this work.** `installGuard.test.ts` (a 5 s timeout while shelling out to `install.sh`), `audioVet` and `cacheShelf.test.ts` failed now and then, but only under the machine's heavy load (load average about 35 with sibling workers running). To check, I stress-ran `cacheShelf` 36 times in parallel on each side. It failed 12/36 on the pre-refactor commit and 1/36 on this branch, so the refactor did not cause it. A clean run is 4777/4777.
- **Run `codenames.sh` on its own fresh daemon.** The first `codenames.sh` attempt failed because it ran after `torrent.sh` on the same throwaway run, and `torrent.sh`'s disk stage stops the loopback seeder. On a fresh `up --discovery --torrent` it passed. Lesson: never chain `codenames.sh` after `torrent.sh` on one run.

## Follow-ups & YAGNI notes

- `streams/torrentStreams.ts` (592 lines) could be split further, separating the open/use/release lifecycle from the reads such as `find`, `downloadsOf`, `view` and `list`.
- `src/config.ts` has a comment that cites `src/directStream/torrent/service.ts` for the prune, which now lives in `streams/prune.ts`. That file was out of this session's scope. The comment is still accurate through the barrel, but it should name the new module.
- The load-sensitive tests (`cacheShelf`, `installGuard`, `audioVet`) deserve their own deflake session.
- Deliberately not done: no rule was reworded or tightened, no caller import was changed, and nothing outside `src/directStream/torrent/**`, its tests and the guide's citations was touched.

## Appendix

Commands run (worktree root):

```sh
npm run typecheck
npm run docs:check
npm test
npm run test:int
npx vitest run tests/unit/directStream/torrent
# verify-notesd, each on a fresh throwaway daemon
.claude/skills/verify-notesd/scripts/verify.sh up --discovery --torrent
  .claude/skills/verify-notesd/scripts/direct-stream/torrent.sh
  .claude/skills/verify-notesd/scripts/direct-stream/codenames.sh
  .claude/skills/verify-notesd/scripts/direct-stream/downloads.sh
```

Commits on the branch: 6c11be1 (source split), 7dc19a5 (service split), 568ec76 (tests and guide citations).
