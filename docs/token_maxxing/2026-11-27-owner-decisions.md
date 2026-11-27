# Token-Maxxing Session — 2026-11-27: Owner Decisions

## 🎯 Achievement / End Result
- **Goal of the burn:** carry out the seven decisions the owner made on 2026-11-27 ("all recommended") on the open questions from the guide audit (`docs/plans/2026-11-27-guide-audit-findings.md`) and the torrent-ranking evidence (`docs/plans/2026-11-27-torrent-ranking-evidence.md`). Five were code changes, each written test-first. Two were live-database writes the owner approved.
- **Concrete changes:**
  - **Provider rests** (`a95849d`): `src/directStream/repo.ts` (`countsTowardRest`), `src/directStream/service.ts`, `src/directStream/canary.ts`, `src/directStream/start.ts`, `src/movies/streams.ts` (`MovieStreams.titleStreamed`), `src/movies/repo.ts` (`MoviesRepo.streamedOnHost`); tests `tests/unit/directStream/restCount.test.ts` (new), `tests/unit/directStream/canary.test.ts`, `tests/integration/movies.channels.int.test.ts`; `docs/guide/streaming.md`.
  - **Clearing rests** (`63eed97`): `DirectStreamRepo.clearRests(host, names)`, int-tested in `tests/integration/directStream.repo.int.test.ts`, plus `tests/unit/scripts/directRest.test.ts`.
  - **Seer Adversarial "Review now"** (`43aec92`): `src/adversary/plan.ts` (`PlanInput.retryFailed`), `src/adversary/service.ts`, `tests/unit/adversary/plan.test.ts`, `docs/guide/adversary.md`.
  - **dword limit** (`927d2d4`): `src/mcp/dwordVocabTools.ts`, `tests/integration/connectors/dword.vocab.curated.int.test.ts`, `docs/guide/connectors.md`, regenerated `docs/guide/reference/mcp-tools.md`.
  - **Wall drop/paste** (`b921342`): `web/src/components/DropOverlay.tsx`, `web/src/lib/files.ts` and their tests.
  - **Torrent ranking** (`111c001`): `src/directStream/torrent/source/delivery.ts` (`RATIO_MARGIN`, `chooseOrder`, `chosenText`), `src/directStream/torrent/source/race.ts`, `claude/streaming/direct/order.mjs`, `tests/unit/directStream/torrent/source/pure.test.ts`, `tests/unit/directStream/torrentSource.test.ts`, `docs/guide/streaming.md`, and the evidence plan marked decided.
  - **Wrap-up** (`36e6840`): `tests/integration/directStream.api.int.test.ts` moved to the new rest rule; verify-notesd feature-map entries in `features/direct-streaming.md`, `features/adversary.md`, `features/wall.md`.
  - 35 files, +514 / −51 across the seven commits.
- **Real value delivered:**
  - A cloud provider no longer goes into a rest because it had no stream for a title that may not exist anywhere. Rests now follow real provider failures, not the catalogue gaps every provider has.
  - MovieVault, NexaStream, Smashy and VidRock, all four resting on the live host `pc` (5 consecutive failures each), were put back in rotation. No other column changed.
  - Revenge (2017, M-VFXW) now plays its English audio, as the owner asked, without starting a play.
  - "Review now" in Seer Adversarial can retry a pick whose review failed twice. Before, a manual retry did nothing for it.
  - `/v` on a word already saved works past the 50-a-day limit and attaches the new origin sentence. It is no longer refused.
  - Dropping or pasting SVG/BMP on the wall with no editor open no longer posts files the server will reject.
  - Torrent racing picks a racer with clearly better delivery (≥1.5× the other's rate-to-bitrate ratio) over one that only has an English subtitle file. Every "was chosen" log line now names the step that decided.
- **Branch:** token-maxxing-2026-11-27-owner-decisions
- **Merge status:** merged (commit 8685030)
- **Approx token burn:** ~2–3M tokens (seven changes test-first, two live writes, full unit and integration suites, four throwaway-daemon verify journeys) 🔥

## Context & Motivation
Earlier sessions today left open questions in two plan files. The guide audit found places where the code and the guides disagreed and the right answer was a policy call. The torrent-ranking evidence collected real cases where the race picked a slow racer because it had an English subtitle file. The owner answered all of them with "all recommended". Coordinator `orch-stream-play-log` assigned the implementation to this worker session. There was no idea menu: the work was the owner's list.

## What We Did (blow-by-blow)
1. **Provider rests (a95849d).** The old rule: a cloud provider's `no_stream` from a page that loaded counted toward `consecutive_failures` the same way as an outage. A provider asked about an obscure title it simply does not carry would build up failures and go into a rest. New rule, in `countsTowardRest` in `src/directStream/repo.ts`: such a `no_stream` counts only when the title demonstrably exists. That means one of three things:
   - another provider resolved it in the same resolve;
   - this host has a verified `movie_stream_sources` row, or a cloud or torrent stream play of that film or episode, through a new `titleStreamed` hook (`MovieStreams.titleStreamed` → `MoviesRepo.streamedOnHost`);
   - the canary or the `/update-cloud-source` probe resolved a title from `known-titles.json` (`runResolve({known: true})`).

   Otherwise nothing is recorded. Unreachable pages, `bot_check` and `error` count as before, and rest lengths are unchanged. The unit tests in `restCount.test.ts` were written first.
2. **Clearing the live rests (63eed97 + one live write).** Added `DirectStreamRepo.clearRests(host, names)` with an integration test. A one-shot script (not committed) called it against the live DB for the four providers resting on `pc`:

   | Provider | consecutive_failures | failures / successes | last outcome |
   |---|---|---|---|
   | MovieVault | 5 → 0 | 23 / 18 | bot_check 2026-11-27T06:45Z |
   | NexaStream | 5 → 0 | 42 / 14 | no_stream 06:17Z |
   | Smashy | 5 → 0 | 35 / 17 | bot_check 06:17Z |
   | VidRock | 5 → 0 | 22 / 41 | no_stream 07:18Z |

   Every other column was unchanged.
3. **Revenge audio (live write, no commit).** Revenge (2017, `movie-467938`, M-VFXW) has TMDB original language `fr`. No route sets `audio_language` without playing, so a one-shot script called `MoviesRepo.setAudioLanguage(..., 'en')`. `movies_get` confirmed `audio_language: "en"`. No play started.
4. **Seer Adversarial (43aec92).** `PlanInput.retryFailed` is set only for `trigger: manual`. With it set, the planner includes picks whose review failed twice. Automatic passes still skip them, so a pick that keeps failing doesn't burn a model call on every scheduled pass.
5. **dword (927d2d4).** Past the 50-a-day limit, `dword_vocab_add` for a word already held now takes the collision path, which attaches the origin sentence, and is no longer refused. A new word past the limit is still refused. The tool text and the generated MCP reference were updated.
6. **Wall (b921342).** With no editor open, dropped and pasted files go through the same `ATTACHABLE_IMAGE_TYPES` filter `routeFiles` uses. SVG and BMP are dropped on the client and never reach `/api/images`.
7. **Torrent ranking (111c001).** When no racer delivers, the race now compares delivery ratios (rate ÷ film bitrate) before the English-subtitle-file step. A ratio at least 1.5× the other's wins. A margin is not a total order, so `chooseOrder` takes racers one at a time and does not sort. `chosenText` names the deciding step in every "was chosen" log line and attempt detail. The tests use the live cases from the evidence file: Miracle in Cell No. 7 now goes to NOMA (4.1×), and Confessions stays with ArtymKo (YTS only 1.2×). The plan file is marked "Decided 2026-11-27: option 2 with a 1.5x margin".
8. **Wrap-up (36e6840).** The full integration run had one failure: `directStream.api.int.test.ts` still asserted the old counting. It was updated and now passes. Verify-notesd feature-map entries were added for each user-facing change.

## Code / Design Details
- **Rest counting** is one pure predicate (`countsTowardRest`) fed by the outcome, whether the page loaded, and a `titleExists` answer computed by the service. The repo stays the single writer of `stream_provider_health`. When the predicate says no, no write happens at all, so successes and failures totals don't move either.
- **`titleStreamed`** is injected into the stream service like every other dependency. Tests pass a fake, and the live wiring goes through `MovieStreams` to `MoviesRepo`, which keeps `MoviesRepo` the only reader and writer of the `movie_*` tables.
- **Ratio margin:** with a 1.5× margin, A beats B and B beats C does not imply A beats C. Sorting with such a comparator is undefined, so the choice is made by repeatedly picking the best remaining racer against the current one.

## Decisions & Trade-offs
- **`known-titles.json` counts as existing.** The canary and the probe use titles chosen because they stream everywhere, so a `no_stream` on one of them is real evidence that the provider is broken.
- **The no-editor paste path uses the attachable set too**, not only drop. Both paths ended in the same server rejection.
- **A held word past the dword limit is exempt whether or not an origin is passed.** The limit is about new words, and re-adding a held word creates none.
- The live writes went through one-shot scripts that call the repos' own methods, never raw SQL, so each table's single-writer rule still held. The scripts are not committed, since they are one-off.

## Follow-ups & YAGNI notes
- The live daemon runs the old code until the coordinator lands and rebuilds this branch. Until then, the four providers can build up failures again under the old rule.
- `verify.sh restart` drops the `ADVERSARY_*` env keys (noted in the adversary feature map). It was not fixed here.
- No route was added to set `audio_language` outside a play. The one-off script was enough for one title, and the owner can still set it through `direct_stream_play`'s `audio_lang`.
- Rest lengths and the bot_check counting were left alone on purpose, because the owner's decision covered only `no_stream`.

## Appendix
- **Proof:** `npm run typecheck` clean. `npm test`: 449 files, 5109 tests passed. `npm run test:int`: one stale assertion, fixed and passing. `docs:check` current.
- **verify-notesd journeys** (throwaway daemons):
  - (1) A `no_source` for a never-streamed stored title left `stream_provider_health` unchanged. After a resolve, the next `no_source` added 1 (run `1127-153129-4072952`).
  - (6) A Playwright drop of svg+bmp+png with no editor made exactly 1 `POST /api/images`, and only `plain.png` was stored.
  - (7) A real loopback torrent race logged "WITHSUB was chosen: it delivers".
  - (4) A run with deliberately invalid models, so nothing was billed (`1127-153443-4091529`): the automatic pass left a twice-failed pick alone, and Review now wrote a third attempt row.
- **Commits:** `a95849d`, `63eed97`, `43aec92`, `927d2d4`, `b921342`, `111c001`, `36e6840`.
