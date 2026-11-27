# Token-Maxxing Session — 2026-11-27: Guide Audit Code Fixes

## 🎯 Achievement / End Result
- **Goal of the burn:** Fix everything `docs/plans/2026-11-27-guide-audit-findings.md` lists under "Doc right, code wrong", and every row of "Stale strings in source and scripts". Each code fix lands with a test that failed first, in the same commit. Also deflake `CachePage.test.tsx`'s timer test by finding the real race, not by loosening the test.
- **Concrete changes:** 34 files over 11 commits (440 insertions, 139 deletions). Code: `web/src/hooks/useAdversary.ts`, `web/src/lib/adversary.ts`, `web/src/pages/AdversaryPage.tsx`, `web/src/App.tsx`, `web/src/components/movies/CachePage.tsx`, `scripts/install.sh`, `src/adversary/reviewsRepo.ts`, `src/adversary/service.ts`, `src/db/schema.ts` (comment only, no migration), `src/http/reveal.ts`, `src/mcp/dwordVocabTools.ts`, `src/chat/status.ts`, `src/sessions/replyEmbeddings.ts`, `.claude/skills/verify-notesd/scripts/verify.sh`. New tests: `tests/unit/scripts/installHookPreconditions.test.ts`, `tests/unit/scripts/verifyPins.test.ts`. Extended tests: App.adversary, AdversaryPage, lib/adversary, useAdversary, CachePage, redoService, reviewer.int, files.reveal.int, dword.vocab.curated.int. Docs: `docs/guide/adversary.md`, `docs/guide/wall.md`, `docs/guide/reference/configuration.md`, regenerated `http-api.md` and `mcp-tools.md`, the adversary feature map, and the findings file (each item marked with its commit). Deleted: `.claude/skills/verify-notesd/scripts/movies/doc-check.sh`.
- **Real value delivered:**
  - `/adversary/<twin id>` and lower-case ids no longer sit on "loading" forever. They open the original's page, and the URL is rewritten in place to the canonical id.
  - A `/redo` no longer uses up the reviewer's daily cap (`ADVERSARY_DAILY_CAP`), so redoing one pick can't quietly stop the nightly review of the next.
  - The note-level "Show in Explorer" selects the first photo on this machine, the same one the client's button logic picks. Before, it could pick a photo stored on the other laptop.
  - `scripts/install.sh` checks `notes-link.mjs` with the other hooks before it changes anything.
  - The `dword_vocab_lookup` tool text Claude reads now matches what it does: a single word that differs only in accents or case is found, and only a phrase comes back as candidates.
  - Every verify-notesd throwaway daemon now pins `NOTESD_SEER_DISPATCH=off`.
  - Stale counts in `chat/status.ts` comments, the reply worker's sweep interval and the `DWORD_USER_EMAIL` config row are corrected. A broken script that nothing cited was removed.
  - The CachePage timer test is deflaked at the root: the interval moved to a layout effect, which closes a scheduler race that showed up under load. A second real race was fixed too: when reads overlapped, an older answer arriving last restored a stale view.
- **Branch:** token-maxxing-2026-11-27-guide-audit-code-fixes
- **Merge status:** on branch, NOT merged — this is a worker session; the coordinator owns landing worker branches
- **Approx token burn:** high (11 fix commits, the full unit and integration suites run more than once, a CPU-load flake repro of 48 runs, one verify-notesd throwaway) 🔥

## Context & Motivation
Coordinator `orch-stream-play-log` assigned this idea; there was no menu. It follows the earlier session today, "Guides vs Code Audit" (`2026-11-27-guides-vs-code-audit.md`). That session fixed about 60 drifted claims in the guides and wrote down the opposite case, where the guide states the intended behaviour and the code is wrong. Those were real user-facing bugs, or misleading tool text that Claude reads at every call. This session fixes them. The four "For the owner to decide" items in the findings file were left alone on purpose.

## What We Did (blow-by-blow)
1. **5c12d27 — adversary page for twin and lower-case ids.** The page compared `method.strategy_id` with the raw route id, so `/adversary/raw35-fr-gt` or a twin's id never matched and the page stayed on "loading". Now `useAdversary` keeps the id each detail answered and hands over a detail only when it answers the route id. The page, heading and count line trust that. The heading's roster fallback matches in any case and by `twin_id` (new `rosterRowFor`). `App` rewrites the URL with `replaceState` to the original's id. Tests failed first in App.adversary, AdversaryPage, lib/adversary and useAdversary. `adversary.md` updated.
2. **1dc5566 — install precondition for notes-link.mjs.** `check_preconditions` skipped `claude/hooks/notes-link.mjs`. The new `installHookPreconditions.test.ts` sources `install.sh` and runs `check_preconditions` once per `HOOK_SCRIPTS` entry, with stand-in tools and directories, so a hook missing from the check fails the test.
3. **df979f3 — a redo stops counting against the cap.** Redo review rows now carry `redo: true` in the verdict jsonb. `countDeepSince` (SQL) and `recent().usedToday` (new `spentReview` helper) leave those rows out. The integration test sets the cap to 1: after a redo, `used_today` stays 0 and the reviewer still reviews the next pick. Unit tests are in `redoService.test.ts`. Feature map and guide updated.
4. **a6c97cd — note-level reveal.** `noteRevealPlan` selects the first photo on this machine, matching the client's `noteRevealable`. Integration test in `files.reveal.int.test.ts`. `httpRoutes.ts`, the generated `http-api.md` and `wall.md` updated.
5. **ff38941 — dword_vocab_lookup wording.** The description now says a single word that differs in accents or case is found, and only a phrase (déjà vu / deja vu) comes back as candidates. An integration test pins both the behaviour and the wording. `mcp-tools.md` regenerated.
6. **7b4ecc0 — stale comments.** `chat/status.ts` counts corrected: five curated dword tools (seven names), eight movie tools, 22 connector tools, and `warp`, `stream_disk` and `direct_stream_health` named. The `replyEmbeddings` sweep comment now says 30 min, not 60 s.
7. **3d457d0 — deleted `movies/doc-check.sh`.** Nothing cited it, it failed when run, and `npm run docs:check` already covers every env var, route and tool.
8. **6c06315 — DWORD_USER_EMAIL config row.** It is read from `.env.local` on every call, and all five curated tools refuse without it.
9. **d05dd18 — verify.sh pins NOTESD_SEER_DISPATCH=off** in every throwaway daemon's base env. New `verifyPins.test.ts`.
10. **6b864bd — CachePage deflake plus a stale-read race.** Details below.
11. **1e9ada9 — findings file**: every item is marked with the commit that fixed it.

## Code / Design Details
- **The CachePage flake, root cause.** The disk-read interval (3 s while busy, 15 s idle) was set in a passive `useEffect`. RTL's `findByRole` drains with a real `setTimeout(0)`, but in Node React's scheduler flushes passive effects with `setImmediate`. Under CPU load the timeout can win, so the test advanced fake time while the old 15 s interval was still installed. Moving the interval to `useLayoutEffect` commits it together with the render the test waited for. Repro, under the same nice-19 CPU load on a 1-CPU machine (load average about 21): 2 failures in 12 runs before the fix, 0 in 36 after.
- **The second CachePage race.** `load()` calls were not awaited and could overlap, so an older answer landing last could restore a stale view. `load()` now tags each read with a sequence ref and applies only the newest. It has its own test, which failed first.
- **Adversary detail identity.** The hook stores the id the detail was fetched for. The page never compares strategy ids itself, so canonicalisation (twin id, case) has a single place to live.
- **Redo marker.** A `redo: true` flag in the existing verdict jsonb, read by both the SQL counter and the in-memory `spentReview` helper.

## Decisions & Trade-offs
- **jsonb flag instead of a new `redo` column.** This avoids a drizzle migration that could clash with sibling worker branches' migrations at landing time. The cost is one jsonb predicate in `countDeepSince`.
- **Deleted `doc-check.sh` rather than repairing it.** `docs:check` is the one checker, and keeping two invites drift.
- **The deflake changes production code, not the test.** The race was real: a layout effect is the right place for an interval that must be live as soon as the render shows the new state.
- **The four owner-decision items were not touched,** as assigned.

## Follow-ups & YAGNI notes
- The four "For the owner to decide" items in `docs/plans/2026-11-27-guide-audit-findings.md` stay open.
- `scripts/docs/shots/adversary.mjs` still sets `NOTESD_SEER_DISPATCH=off` itself. That is now redundant but harmless.
- Other web tests that move fake timers right after a `findBy*`, on a state that changes an interval set in a passive effect, could carry the same load-dependent race. A sweep might be worthwhile.
- The redo fix could not be shown on the throwaway daemon (`no_lens`: the scratch `SEER_DIR` has no Seer source), so the integration test is the proof. Reveal was not driven because it opens Windows Explorer. Its integration test covers it.

## Appendix
- **Proof:** `npm run typecheck` clean. `npm test`: 428 files, 4796 tests passed. `npm run docs:check`: current. `npm run test:int`: 108 files, 1087 tests passed.
- **verify-notesd** (`up --web --adversary`, run `1127-135643-3701000`, evidence in `~/.local/state/notesd-verify/1127-135643-3701000/evidence`): `/adversary/raw35-fr-gt-cx` and `/adversary/raw35-fr-gt` open RAW35's page, the URL is rewritten to `/adversary/RAW35-FR-GT`, and the roster row is current (PASS). The daemon's environ shows `NOTESD_SEER_DISPATCH=off` (PASS).
- **Commits (oldest first):** 5c12d27, 1dc5566, df979f3, a6c97cd, ff38941, 7b4ecc0, 3d457d0, 6c06315, d05dd18, 6b864bd, 1e9ada9.
- **References:** `docs/plans/2026-11-27-guide-audit-findings.md`, `docs/token_maxxing/2026-11-27-guides-vs-code-audit.md`.
