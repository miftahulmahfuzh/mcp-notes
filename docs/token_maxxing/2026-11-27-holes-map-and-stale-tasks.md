# Token-Maxxing Session — 2026-11-27: Holes Map and Stale Tasks

## 🎯 Achievement / End Result
- **Goal of the burn:** Answer the owner's three questions: which loose ends are not tied, which modules need refactoring, which parts need docs. Tie the bookkeeping loose ends found along the way.
- **Concrete changes:**
  - `.workflows/todos.md` audited and corrected (commit 1b2638e).
  - `docs/plans/2026-11-27-holes-map.md` written, sections 0-4 (703212f), then env vars, CLAUDE.md citations, verify coverage and liftable limitations plus an ordered phase list (28258dd).
  - No source code and no guide changed.
- **Real value delivered:**
  - All 21 "active" tasks had already landed. 16 were finished swarm phases flipped in place and are now under Completed. Of the 5 open ones, A073 (Seer go-live, landed 2026-11-05: ledger phase 7 done, mcp-notes d197bc1, seer 917f04e) and A087/A089 (landed 2026-11-08: 127ebd4, 23247b0, merged 36ddcbb) were closed with their evidence. A086 and A088 duplicated completed entries (E202 and a second `A085`, renamed to A088). A050 got its Completed date. Counters now read 0 active, 0 blocked, 158 completed.
  - Root cause of the stale board: swarm ledger phases were recorded with null or wrong TaskIDs (neon-egress, note-id-deeplinks, seer-adversarial, torrent-stream-source and others), so their entries never flipped. 17 non-canonical TaskIDs (SD01..., SP03...) were left alone.
  - A measured holes map (TypeScript-parser import graph over 1,197 files plus git numstat over 720 commits; 110k production lines, 91k test lines). Refactor ranking: `src/directStream/service.ts` (2486 loc, 54 commits), `src/db/schema.ts` (2011 loc, fan-in 64), `src/daemon.ts` (78 commits, test ratio 0.38), `web/src/lib/movies.ts`, `src/config.ts`, `directStreamTools.ts`, `moviesApi.ts`.
  - Thin tests: web components at 33 % lines with no direct test; MoviesPage and MovieDetail have none; also `src/files/ingest.ts`, `chat/repo.ts`, `connectors/runs/queries.ts`.
  - Dead code: about 30 exports used nowhere (each checked with git grep), including dword `exampleContainsTerm`, a validation rule never wired in; 11 production functions only tests call; 1,670 exports needlessly exported.
  - Env vars: `docs:check` already enforces both directions. One gap: `NOTESD_WALL_URL` in skill `.sh` scripts, which the check does not scan.
  - CLAUDE.md: 268 citations checked, none stale. One rule's stated reason (the 5-minute poll picks up other-machine edits) is moot since the per-machine databases.
  - Verify coverage gaps: `similar_images`, the connectors, the paste and spawn hooks, the one-time Neon import.
  - Liftable limitations: "Text needs the network / Neon" is stale; polling cadences were tuned for Neon egress; the quota breaker and meter can go after the import (~2026-12-01).
- **Branch:** token-maxxing-2026-11-27-holes-map-and-stale-tasks
- **Merge status:** on branch, NOT merged — this is a worker session; the coordinator owns landing worker branches
- **Approx token burn:** ~1.5M 🔥 (estimate)

## Context & Motivation
The owner asked which loose ends are not tied, which modules need refactoring and which parts need docs. The coordinator (orch-stream-play-log) picked this idea directly, with no menu. The work was one of five parallel workers; this one only touched `.workflows/todos.md` and `docs/plans/`.

## What We Did (blow-by-blow)
1. Audited every "active" entry in `.workflows/todos.md` against git history and the swarm ledger. Every one had landed. Moved the 16 finished phases under Completed, closed the five open tasks with their commits, resolved the duplicate IDs, fixed the counters. Commit 1b2638e.
2. Wrote throwaway scripts (kept out of the tree) that parse all 1,197 TypeScript files into an import graph and join it with git numstat over 720 commits, giving size, churn, fan-in and test ratio per module.
3. Used that data for the refactor ranking, thin-test list and dead-code list, checking each unused export with `git grep`. Commit 703212f.
4. Compared env vars, CLAUDE.md citations and the verify-notesd feature map against the code, and listed limitations that Neon-era design left behind. Ended with an ordered list of suggested phases. Commit 28258dd.
5. Gates: `npm run docs:check` green, `tests/unit/docs/reference.test.ts` green.

## Code / Design Details
No source changed. The map lives in `docs/plans/2026-11-27-holes-map.md`. The ranking weighs lines, commits touching the file, fan-in and test ratio together, so a large but stable file ranks below a smaller churning one. The dead-code check counts an export as unused only when `git grep` finds no import in production or tests.

## Decisions & Trade-offs
- Left the 17 non-canonical TaskIDs alone: renaming them needs per-case judgement and was out of scope.
- Reported findings rather than fixing them: the sibling workers edit other parts of the tree, and a refactor would conflict.
- Treated the stale CLAUDE.md rationale as a note for the owner rather than editing CLAUDE.md here.

## Follow-ups & YAGNI notes
- YAGNI sweep of the unused and test-only exports.
- Split the wiring in `src/daemon.ts`.
- Split `src/directStream/service.ts`.
- Split `src/db/schema.ts`.
- Add web tests for MoviesPage and MovieDetail.
- Add the missing feature-map entries (`similar_images`, connectors, paste and spawn hooks, Neon import).
- Remove the Neon code paths after the import (~2026-12-01).
- Enforce a TaskID in the swarm executor's ledger so phases can no longer be recorded with a null one.

## Appendix
- Commits: 1b2638e, 703212f, 28258dd.
- Main artifact: `docs/plans/2026-11-27-holes-map.md`.
- Gates: `npm run docs:check`, `npx vitest run tests/unit/docs/reference.test.ts`.
