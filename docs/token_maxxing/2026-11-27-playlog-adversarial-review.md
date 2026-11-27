# Token-Maxxing Session — 2026-11-27: Playlog Adversarial Review

## 🎯 Achievement / End Result
- **Goal of the burn:** independently review and re-prove the stream-play-log set that landed at `ec89d99` (play log, stream health route/tool/page, reminders, the sessions-search no-vectors fallback). Every real defect gets a failing test first, then the fix. Also do the owner's post-landing ask: a `health.png` step in `scripts/docs/shots/movies.mjs` on a `--live` run, plus the guide line.
- **Concrete changes:** ten commits on this branch:
  - `2c49a09` play log: expired plays are closed when they expire, and a folded page load is never counted twice
  - `579ee77` reminders: spawned sessions never use up a reminder, the due date is printed in local time, and impossible or past due dates are refused
  - `50c0aa9` stream health: an unhandled title's channel words come only from failures after its last play (R2.5)
  - `de2bf21` docs(movies): rewrap a guide line
  - `5fe7e9f` sessions search: hybrid stays on while replies or notes have vectors
  - `6d8e1ca` health page: no stale period, worded tips, and the figures R2.3 asks for
  - `5343789` docs(shots): `health.png` from `/movies/health` on a `--live` movies run
  - `bec545c` stream health: an outage never lists a title as could-not-be-played
  - `567df8f` health page: an all-errored channel is worded `unreachable`
  - `f6fc086` play log: an ask the daemon's stop cuts short is logged `error` on every channel it asked, never `no_stream`
- **Real value delivered:**
  - Seven real defects found and fixed in the newest and least-proven code in the repo. Two of its five phases had only been verified after a fix, and nothing independent had checked any of them.
  - The owner's own terminal now gets its due reminders. Before, a swarm worker or any other spawned session used them up silently for 20 h.
  - Health figures are now accurate. A crashed page is closed as `expired` (not `restart`) with the right `ended_at`, a reload never double-counts, an outage no longer lists a title as could-not-be-played, and channel words no longer come from failures that happened before the title last played successfully.
  - Meaning search over sessions works again when only notes and replies have vectors.
  - The health page answers for the period on screen. It shows the `no picture` and `stood still` shares the contract asked for, and its tips are in words.
  - `health.png` is taken on the next `--live` movies run, and the guide line appears on its own (no step left to the owner).
- **Branch:** token-maxxing-2026-11-27-playlog-adversarial-review
- **Merge status:** merged (commit dc8de55, landed by coordinator orch-stream-play-log)
- **Approx token burn:** high. One main session plus four Opus reviewer runs (two of them repeats after Fable usage-limit deaths) and a throwaway-daemon verification 🔥

## Context & Motivation
This is a worker session of coordinator `orch-stream-play-log`. The coordinator assigned the idea, so there was no menu. The stream-play-log set (five phases, merged at `ec89d99`) added:
- a play log (`stream_play_log`, written only through `PlayLog`)
- a stream health route, MCP tool and `/movies/health` page
- reminders shown by the session-start hook
- a no-vectors fallback for sessions search

Two of the five phases were verified only after a fix, and no reviewer independent of the authors had read any of it. That made it the newest and least-proven code in the repo, and the play log and health page feed decisions the owner makes about which channel to trust. After the set landed, the owner also asked for the health page's picture in the movies guide.

## What We Did (blow-by-blow)
1. **Read the contracts.** `.workflows/orchestration/stream-play-log/PLAN.md`, requirements R1.1 to R4.4, served as the yardstick for every finding.
2. **Reviewed the play-log core myself.** I traced every write path of `PlayLog`, the per-page-load counters, `StatsTally` folding, and how open plays are closed (`expired` versus `restart`).
3. **Ran two independent Opus reviewers.** One took the reminders stack. The other took the health view and sessions search. Both first runs died on the Fable usage limit. After the owner switched models they were re-run on Opus, and those runs completed.
4. **Fixed each defect test first.** Each one got a failing test that reproduced it, then the fix, then a green run:
   1. **Play log (`2c49a09`).** A play whose page crashed or slept stayed open until something swept the session store. It was then closed as `restart` at the next daemon start, when R1.4 says `expired`, and its `ended_at` was wrong. `PlayLog` now checks its open plays every minute on an unref'd timer and closes an expired play at the time it expired. A second bug was in `StatsTally`: a page load folded away after 16 loads that reported again was counted twice. It now remembers what each folded load counted. Tests: `log.test.ts`, `tally.test.ts`.
   2. **Reminders (`579ee77`).** A spawned session (a swarm phase, a worker, any session with a parent) received the due reminders and stamped `last_shown_at`, so the owner's own terminal saw nothing for 20 h. Spawned sessions now get none (`reminders.int.test.ts`). The hook printed the due date in UTC, which is a day early in WIB (`notesSession.test.ts`). `remind add` accepted `2026-02-30T09:00Z`, `24:00` and due dates years in the past. It now refuses them (`mcp.remindTool.test.ts`).
   3. **Stream health, R2.5 (`50c0aa9`).** An unhandled title's cloud and torrent words could come from a failure that happened before its last successful play. The `array_agg` filters now skip those.
   4. **Sessions search (`5fe7e9f`).** Phase 4's no-vectors early return looked only at session vectors. That turned off meaning matches through notes and replies, which are embedded on write. The fallback now applies only when no session, reply or note has a vector of the current model.
   5. **Health page (`6d8e1ca`).** Changing the period while a read was in flight let the old answer or error land on the new period. Reads are now aborted per period. A chip's hover tip showed the raw word. Each channel row now shows the `no picture` and `stood still` shares that R2.3 asked for. An open `no_picture` play reads `no picture yet`.
   6. **Outage is not a miss (`bec545c`, `567df8f`).** The coordinator raised this from row 12 of the torrent soak's live log. A failed ask whose every asked channel only errored (a network outage) put the title on the could-not-be-played list. Such a title is now left out of `unhandled` but still counts as a failed ask. The page words `error` as `unreachable`.
   7. **A restart is not a miss (`f6fc086`).** The coordinator raised this from row 21 of the live log: `install.sh --force` restarted the daemon mid-torrent-try, and the ask was logged `no_source` / `no_stream`, as if no torrent existed (the title played a minute later). The daemon's stop now calls `PlayLog.stopping()` first; a failed ask from then on is `error`, detail `the daemon stopped during the ask`, `error` on every channel it asked, so the outage rule keeps it off the list. What the play answers is unchanged. The test was written after the fix but proven to fail with the stop flag disabled.
5. **Did the owner's ask (`5343789`).** `scripts/docs/shots/movies.mjs` saves `health.png` from `/movies/health` (last 30 days) on a `--live` movies run. When the log is empty it skips with a log line, the same as `cache.png`. A link to a missing picture fails `docs:check`, and the movies guide never shows a fixture picture. So `docs/guide/movies.md` holds an HTML-comment mark where the picture goes, and the first live run that takes `health.png` writes the picture line there. The live picture was not taken in this session, as instructed.
6. **Proved it** (see Appendix): typecheck, unit, integration, `docs:check`, and the verify-notesd throwaway daemon with Playwright.

## Code / Design Details
- **Expiry sweep in `PlayLog`.** A one-minute `setInterval` is `unref()`'d so it never holds the process open. It walks the in-memory open plays and closes any past its expiry, with `ended_at` set to the expiry instant (not "now", and not the next daemon start). Like every play-log write, it is guarded and caught, so it can never fail or delay a play.
- **`StatsTally` fold memory.** Once more than 16 page loads exist for a play, the oldest are folded into a running sum. The tally now keeps what each folded load had already contributed, so a later report from that load adds only its delta.
- **Spawned-session gate in reminders.** `POST /api/sessions/hook/start` answers due reminders only for a session with no parent. This happens in the same `UPDATE ... FOR UPDATE SKIP LOCKED`, so the concurrency guarantee of at most one showing per 20 h is unchanged.
- **Due-date validation.** A due date is parsed strictly and round-tripped, so a value like Feb 30 or `24:00` that normalizes to a different instant is refused. A due date too far in the past is refused too.
- **R2.5 filter.** The per-title `array_agg(channel words)` gets `FILTER (WHERE failed_at > last_success_at OR last_success_at IS NULL)`.
- **Hybrid gate in sessions search.** The early "no vectors" return checks for a vector of the current model across sessions, replies and notes together.
- **Health page period race.** Each period change gets its own `AbortController`. A stale response is dropped, never rendered.
- **Outage handling.** A failed ask is "unhandled" only if at least one asked channel answered with something other than `error`. An all-`error` ask is still a failed ask in the totals.
- **Picture mark.** `movies.mjs` writes the picture line at the HTML-comment mark in `docs/guide/movies.md` the first time a live run produces `health.png`.

## Decisions & Trade-offs
- **Failing test before every fix.** Every finding was reproduced by a test before any code changed. This kept the reviewers' "confident but wrong" findings out. A finding that could not be reproduced was recorded under "checked and found sound" and not fixed.
- **Reviewers did not get my conclusions.** The two Opus reviewers were given the code and the contracts, not my hypotheses, so their reads were not anchored on mine.
- **No live daemon.** The live daemon on 7317 was never touched. All proof ran on a throwaway daemon.
- **No fixture picture for the movies guide.** The owner wants real-library pictures there. The guide therefore carries a mark that the first live run fills in, rather than a placeholder image or a manual step left to the owner.
- **Outage still counts as a failed ask.** Dropping outage-only asks from the totals would hide real downtime. They are kept out of the "could not be played" list only, because that list is about titles, not networks.

### Checked and found sound (no change)
- Play-log writes never delay or fail a play: they are sync, guarded, queued and caught.
- Counters per page load are summed without double counting across reloads (beyond the folded-load bug above).
- A paused beat on screen writes nothing (R1.5).
- Every play entry (play, cache, continue, episode) is logged.
- `failure_detail` strips queries and magnets, and the only key (Wyzie) lives in a URL query.
- A reminder is shown at most once under concurrent starts (one `UPDATE ... FOR UPDATE SKIP LOCKED`).
- A seed is stored once by its key.
- The health maths matches the contract.
- `days` parsing answers 400 for `abc`, `0`, `91` and `7.5`.

## Follow-ups & YAGNI notes
- **Reminder ack.** `last_shown_at` is stamped when the daemon answers, before the hook prints. If the hook times out (3 s) or loses the reply, the reminder is gone for 20 h. The fix needs an ack from the hook after printing, which is a protocol change, so it was left open.
- **`cache` channel.** A failed cache play with no channel words is filed under channel `none` ("No source named") on the page. A `cache` channel for failed cache asks would read better, but that is a contract change.
- **Stall rate on short plays.** `stalls_per_hour` is dominated by very short test plays: one stall in a 5 s play is 720/h. Consider a minimum played time before the rate is shown.
- **Live picture.** The owner should run `npm run docs:shots -- --live movies` once the log has data, to take `health.png`. The guide line then appears by itself.

## Appendix
**Proof**
- `npm run typecheck`: clean.
- `npm test`: 415 files, 4754 tests pass. One install-guard timing test outside this scope failed once and passed on rerun.
- `npm run docs:check`: current.
- `npm run test:int`: 108 files, 1087 tests pass.
- verify-notesd throwaway daemon (`verify.sh up --web --direct-stream`):
  - `playlog.sh`: `playlog: PASS (ask stats failed beat replaced restart)`.
  - Health route with seeded rows: the outage-only title is absent, the real miss is listed with `no_stream`, the outage still counts as a failed ask, and the stall rate is 6/h for one stall in 10 min.
  - The page was driven in Playwright: the new figures show, the tips are in words, and quick period changes end on the right period.
- Evidence: `~/.local/state/notesd-verify/1127-132408-3475707/evidence`.

**References**
- Plan contracts: `.workflows/orchestration/stream-play-log/PLAN.md` (R1.1 to R4.4)
- Landed set: `ec89d99 merge(stream-play-log): 5 phases`
- Coordinator: `orch-stream-play-log`
