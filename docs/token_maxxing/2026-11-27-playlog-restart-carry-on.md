# Token-Maxxing Session — 2026-11-27: Play Log Restart Carry-On

## 🎯 Achievement / End Result
- **Goal of the burn:** fix the play-log defect today's torrent soak found: a stream carried on by the player page after a daemon restart was written to `stream_play_log` as a brand-new ask (`via: 'continue'`), and a torrent carry-on even as an invented pasted-magnet play (`torrent_index: 'magnet'`).
- **Concrete changes:**
  - `src/directStream/playLog/repo.ts`: new `PlayLogRepo.reattach(host, to, session, follow, now)`, one guarded UPDATE that reopens the row this start closed as `restart`.
  - `src/directStream/playLog/log.ts`: new `PlayLog.carriedOn(ref, was, session)`, an immediate tally plus a queued reattach; later writes fold the row's prior counters in (`withBase`); `closeLeftOpen` remembers when this start closed the rows (`restartClosedAt`).
  - `src/directStream/service.ts`: `continueSession` calls `playLog.carriedOn(ref, was, made)` instead of `answered`/`failed` with `via: 'continue'`.
  - Tests: 7 new unit tests in `tests/unit/directStream/playLog/log.test.ts`, 4 in `tests/unit/directStream/playLogService.test.ts`, 3 integration tests in `tests/integration/directStream.playLog.int.test.ts`; `tests/helpers/memoryPlayLog.ts` gained `reattach`.
  - Proof tooling: `.claude/skills/verify-notesd/scripts/direct-stream/playlog.sh` restart stage, `features/direct-streaming.md`.
  - Docs: `docs/guide/streaming.md` ("The play log", "What makes a row").
- **Real value delivered:**
  - A restart no longer inflates the ask count: the carried-on play stays on the one row of the ask that started it.
  - No invented magnet plays: a torrent carry-on keeps its real `torrent_index` (e.g. `torrentio`), never `magnet`.
  - A carry-on replaced seconds later is no longer counted as `no_picture`, so the health view's "could not be played" list stops reporting plays that played.
  - The row's counters stay whole across the restart: played time, stalls, waits and switches add up, the first frame stays the first load's, `refreshes` goes up by one.
- **Branch:** token-maxxing-2026-11-27-playlog-restart-carry-on (commits `6328fe3`, `ff15afd`)
- **Merge status:** merged (commit 871271d, landed by coordinator orch-stream-play-log)
- **Approx token burn:** ~1.5–2.5M tokens (test-first unit, service and integration work, two full suites, a throwaway-daemon verify run) 🔥

## Context & Motivation
This was a worker session of the coordinator `orch-stream-play-log`. The coordinator assigned one idea, with no menu to choose from.

Today's torrent soak read the live play log and found two rows that should not exist:

- **Row 22:** a cloud VidRock play, outcome `no_picture`, `via: 'continue'`.
- **Row 51:** *Revenge* (movie 467938), `torrent_index: 'magnet'`, `via: 'continue'`. The real ask was row 50.

Both came from the same path. On start the daemon closes every session row it left open with `ended: 'restart'`, which is correct because sessions live in memory. The player page then notices its session is gone and carries the play on in a new session ("carries on at N s after a restart") through `POST /api/stream/continue`. `DirectStreamService.continueSession` logged that as a new ask with `via: 'continue'`. A torrent carry-on goes through the pasted-magnet path, so the new row also claimed the owner had pasted a magnet. When the page replaced that session seconds later, the new row was left with no first frame and counted as `no_picture`. The health view's "could not be played" list reads that outcome.

So one restart produced three false facts: an extra ask, a magnet play nobody made, and a failed play that had in fact played. The coordinator ruled that a restart carry-on is not an ask: it reattaches to the row that was closed as `restart`.

## What We Did (blow-by-blow)
1. **Read the play log module and the service's continue path.** `PlayLog` (`src/directStream/playLog/log.ts`) is the only route to `PlayLogRepo`, the single writer of `stream_play_log`, and every write is caught so it can never fail, delay or change a play. `continueSession` built `{ via: 'continue', ref, asked: null }` and called `answered`/`failed` like any other ask.
2. **Wrote the tests first and saw them fail.**
   - Unit, `log.test.ts`, new describe "a play carried on after a restart" with 7 tests: a carry-on reopens the restart row under the new session; the counters fold in; the outcome stays `played` once played; reports that arrive before the reattach resolves are still counted; no row means nothing is written; a reattach error means nothing is written; a carry-on before `closeLeftOpen` ran (or with the DB down at start) writes nothing.
   - Service, `playLogService.test.ts`, 4 tests: the restart is simulated with a second `DirectStreamService` on the same in-memory log. A torrent carry-on keeps `torrent_index: 'torrentio'` and never writes `magnet`. No restart row means no write. A failed carry-on writes no failed row.
   - Integration, `directStream.playLog.int.test.ts`, 3 tests against real Postgres: reattach semantics; it never touches another host's row, another title's, a row closed some other way, or a row an earlier start closed; and it picks the newest row when no old session id is given.
3. **Implemented `PlayLogRepo.reattach`.** It is a single UPDATE whose WHERE is `id = (subselect … FOR UPDATE)`. The subselect takes the newest row for host + kind + tmdb_id + season + episode with `ended = 'restart'`, `ended_at >=` this start's close time, and `session = was` when the page sent its old session id. The update sets the new session, clears `ended`/`ended_at`, adds one to `refreshes`, and takes `provider_last`, `switch_note` and `subtitle_source` from the new session. The outer WHERE checks `ended = 'restart'` again, so a second reattach of the same row returns null. It returns the row's prior counters.
4. **Implemented `PlayLog.carriedOn`.** It makes a tally for the new session at once, so player reports that arrive while the reattach query is still in flight are not lost, then queues the reattach. On null or an error it forgets the tally, and nothing is ever written for that session. Once attached, every later write goes through `withBase`, which folds the row's prior counters into the new tally.
5. **Recorded the close time.** `closeLeftOpen` now keeps `restartClosedAt`. A carry-on with no close time (it came before the close, or the DB was down at start) writes nothing.
6. **Switched the service.** `continueSession` calls `this.opts.playLog?.carriedOn(ref, was, made)` on success and logs nothing on failure, because the row already says `restart`.
7. **Updated the proof and the docs.** In `playlog.sh` the restart stage now POSTs `/api/stream/continue` the way the page does. It checks that the same row id is open under the new session with `refreshes + 1`, that the new page load's `played_ms` counts on it, that no new row appeared, that no `continue` or `magnet` row exists, and that the old session id names no row. The feature map and the streaming guide's "What makes a row" sentence were rewritten to match.
8. **Ran the proof.** Typecheck, `npm test`, `docs:check`, `test:int`, and `playlog.sh` on a throwaway daemon (details in the Appendix).

## Code / Design Details

**Before** (`src/directStream/service.ts`, `continueSession`):
```ts
const ask: PlayAsk = { at: entry.since, via: 'continue', ref, asked: null };
run = this.sessionAgain(ref, from).then(
  (made) => { this.opts.playLog?.answered(ask, made); return made; },
  (err: unknown) => { this.opts.playLog?.failed(ask, err); throw err; },
)
```

**After:**
```ts
// No new ask for the play log: the row its play was closed on as `restart` is open again under the new session
// (or nothing is written). A carry-on that finds nothing writes nothing either: that row already says `restart`.
run = this.sessionAgain(ref, from).then((made) => {
  this.opts.playLog?.carriedOn(ref, was, made);
  return made;
})
```

**The reattach** (`PlayLogRepo.reattach`, abridged):
```sql
update stream_play_log
   set session = $new, ended = null, ended_at = null, refreshes = refreshes + 1,
       provider_last = $p, switch_note = $s, subtitle_source = $sub, updated_at = $now
 where ended = 'restart' and host = $host
   and id = (
     select id from stream_play_log
      where host = $host and kind = $kind and tmdb_id = $tmdb
        and season is not distinct from $season and episode is not distinct from $episode
        and ended = 'restart' and session is not null
        and ended_at >= $closedSince
        [and session = $was]
      order by asked_at desc, id desc
      limit 1
      for update)
returning id, outcome, info_hash, first_frame_ms, played_ms, stalls, ..., refreshes
```

**How counters fold (`withBase`).** Counters sum. The outcome stays `played` if the row had already played. `first_frame_ms` stays the first load's. Switches and refreshes add. Columns that describe the ask (`via`, `torrent_index`, `asked`, `asked_at`) are never touched, which is why a torrent carry-on can no longer become a `magnet` row.

**Invariants kept.** `PlayLogRepo` is still the only writer of `stream_play_log`, and it is still reached only through `PlayLog`. Every write is still caught and never fails, delays or changes a play: a carry-on whose reattach fails plays normally with nothing logged.

## Decisions & Trade-offs
- **Match on the page's old session id (`was`) as well as host/title/episode.** This is narrower than the brief's rule and picks exactly "the row its play was closed on". Without `was` (an older page), the newest matching restart row is taken.
- **Reopen only rows this start closed** (`ended_at >= restartClosedAt`). A weeks-old restart row of the same title is never reopened, even if the owner watches the film again.
- **A failed carry-on writes nothing.** This follows from "a carry-on is not an ask". The row already reads `restart`, and a failed row would put a phantom failure back into the health view.
- **Tally first, reattach second.** The player's first position report can arrive before the reattach query returns. Counting at once and dropping the tally on a null result keeps the numbers right without blocking the play on the database.
- **`via: 'continue'` enum kept.** Rows the old code wrote (22, 51) still carry it, so readers must still parse it. New code no longer writes it.

## Follow-ups & YAGNI notes
- **Live rows 22 and 51 are left as they are.** They are still `continue` rows in the live DB. This session was not allowed to write to the live daemon, so cleaning them up (delete row 51, fold 22 back into its ask) is the coordinator's or owner's call.
- **The health view could show `refreshes` from restarts** (e.g. "carried on through N restarts"). Not built: nothing asks for it yet.
- **Flaky test noticed:** `rememberedChannel` "a pending play that fails later…" failed once under a `-t` filter and passes in file runs. It also passes on the base commit, so this change did not cause it.
- **Load flakes while `test:int` ran at the same time:** installGuard `--wait`, cacheShelf, audioVet/rememberedChannel, and `sessions.replies` in the integration run. Each passes alone.

## Appendix
- **Commits:** `6328fe3` fix(play log): a play carried on after a restart reopens its row, never a new ask. `ff15afd` docs+verify(play log): a restart carry-on reopens its row; playlog.sh proves no new row.
- **Proof:**
  - `npm run typecheck`: clean.
  - `npm test`: 5081 tests. 3 load flakes during the concurrent `test:int` run; each passes alone.
  - `npm run docs:check`: current.
  - `npm run test:int`: 1095 tests. 1 flake (`sessions.replies`) that passes alone.
  - verify-notesd `playlog.sh`: all six stages PASS on throwaway daemon run `1127-141557-3791458` (port 41357).
- **Live daemon:** 7317 was never touched, rebuilt or restarted.
- **Files:** `src/directStream/playLog/{log,repo}.ts`, `src/directStream/service.ts`, `tests/helpers/memoryPlayLog.ts`, `tests/unit/directStream/playLog/log.test.ts`, `tests/unit/directStream/playLogService.test.ts`, `tests/integration/directStream.playLog.int.test.ts`, `.claude/skills/verify-notesd/{features/direct-streaming.md,scripts/direct-stream/playlog.sh}`, `docs/guide/streaming.md`.
