# Brief: a torrent play (TM, TS) that starts fast, survives, and answers

**Worktree:** `/home/miftah/.worktrees/mcp-notes/torrent-play-speed`, branch `feature/torrent-play-speed` (base `origin/main` at `b326f9e`)
**Asked by the owner on 2026-11-17**, after "play looking through your window TM" took three tries. Their words: "this is a problem. what took you so long to play it?", then, shown the five fixes below: "fix them all".

## What happened

Note C-A0R has the whole account; the evidence folder is `/home/miftah/mcp-notes-data/movies/stream-reports/20261116-205927-5_-yR-` (`summary.txt`, `session.json`, `notesd.log`, `torrent.jsonl`). Times are WIB.

- **03:46, try 1 failed.** A Claude session had left a loop that ran `scripts/install.sh` once `GET /api/movies/player` showed no `stream` and no VLC play. It fired at 03:47:04 while this play was still resolving: every torrent answered "The daemon is stopping". A play that is still being started shows nothing on that route.
- **03:49, try 2 failed.** Six torrents were tried in the 90 s budget and none played (`torrent: TMDB movie 818647: 6 candidate(s), none played`). The MCP tool call timed out on the client before the daemon answered, so the attempts were lost.
- **03:54, try 3 played after about 66 s:** 6 s for the YTS index, which timed out (as on try 1); 37.5 s for the torrent's file list and header; 22 s for subtitles (15.2 s looking for subtitle files in the torrent, none; then 6.8 s for the service, which had one).
- **Then it stalled** at 179 s and 283 s: 3 peers delivering 1.74 Mbps for a 2.64 Mbps film, though the index listed 16 seeds. The connection gave 83 to 121 Mbps.

## The five fixes

Read `CLAUDE.md` and `docs/guide/streaming.md` ("Torrents", "Playing from a torrent", "Subtitles for a torrent") first. Decide the forks yourself and write down what you decided at the end of this file.

1. **A play that is being started counts as busy.** Nothing should be able to restart the daemon under a play in flight because it "looked idle". Make the in-flight state visible where the landing rule looks (`GET /api/movies/player`, e.g. a `starting` entry with the title and since when, covering a cloud resolve, a torrent resolve and the subtitle chain), and give `scripts/install.sh` a guard: when something is playing or starting it does not restart, says so, and exits with a distinct code, unless told to (`--force`, and whatever the existing unattended callers need). Update the Landing wording other briefs copy (`CLAUDE.md` if it states the rule) so it names the one check to run.
2. **An index that keeps timing out is skipped for a while.** YTS cost 6 s on every play. Remember an index's consecutive timeouts or errors in memory (per daemon run is enough) and leave it out for a cool-down after a few in a row, with an attempt line that says it was skipped and why; ask it again after the cool-down. Never for a `bot_check` workaround: a bot check stays what it is.
3. **The film starts before the subtitle search finishes.** Today the subtitle chain (kept, files, embedded, service, borrow, Whisper) runs before the session is answered. Start the session as soon as a torrent's file passes the probe, run the chain after, and have the player page pick the track up when it arrives (the page already polls the session and the torrent). The cheap tiers that answer at once may still run first if that is simpler, with a small time cap. `wyzie-synced` landed just before this (`96bcfa6`): read its subtitle code before changing the order.
4. **The tool answers before the client gives up.** `direct_stream_play` over MCP timed out with nothing. Find the client's limit (Claude Code's MCP tool timeout; the chat bar's) and keep the daemon's worst case under it: bound the whole play, and when the bound is near answer what is known (`started: false` with the attempts so far and what is still being tried, or a pending answer the caller can ask again), never silence. The attempts of a failed play must not be lost: also write them to the daemon's log or the stream evidence log, so `/report-stream-bug` can read a play that never made a session.
5. **Choose a torrent by what its swarm delivers.** The index's seed count is not the swarm (16 listed, 3 connected). Options to weigh: open the top candidates side by side and take the first whose header arrives; prefer the one with more connected peers or a download rate above the film's bitrate; move on by itself (or offer to) when the swarm delivers under the bitrate for a while. The guide says "No automatic move" for a torrent that buffers: keep that unless you can say why not, but the choice at the start should use real peers and rate. The 30 s probe limit and the five-torrents-in-90-s budget are yours to retune with evidence.

## Rules

- Unit tests for each fix; `npm run typecheck` and `npm test` pass. Prove on a throwaway daemon with `.claude/skills/verify-notesd` (`verify.sh up --torrent`, `--discovery --torrent` for `direct-stream/codenames.sh`, which must still pass); extend the fake index and the loopback seeder where a fix needs a slow or dead index or swarm. Update the feature map and the guide in the same change; `npm run docs:gen` after a tool or route change.
- Never the live daemon on 7317 for proof, never a real swarm from a throwaway daemon.
- The main checkout (`/home/miftah/mcp-notes`) is on branch `fix/report-stream-bug-torrent` with uncommitted work on the `/report-stream-bug` skill (torrent sessions, the cause `torrent_swarm_slow`). Leave it alone. If fix 4 changes what the evidence holds, note in this file what that skill should read next; do not edit `claude/skills/report-stream-bug/` here, to avoid a conflict.
- After each fix that changes what "what is known" says, keep the facts in the guide, not in a skill.

## Landing

When it is proven: commit on `feature/torrent-play-speed` (this brief included), rebase onto the current `origin/main`, merge to `main` with `git merge --no-ff` **from this worktree's branch without checking `main` out in the main checkout** (it is on another branch with uncommitted work: use `git push origin feature/torrent-play-speed:main` after a local fast-forwardable merge commit, or a temporary worktree of `main`), push, remove this worktree and branch. Then run `scripts/install.sh` from a checkout of the new `main` only if nothing is playing **or starting** (your own fix 1 is the check). If the main checkout is still on the other branch, say so in the last message instead of switching it: the daemon runs from that checkout's `dist`, so the owner's `p` there decides when the new code goes live.

## What was decided (2026-11-17, session F8-QK)

### 1. A play that is being started counts as busy
- `DirectStreamService` keeps every play in flight (`begin`): one per title and named provider, so a second ask of
  the same play joins the first. `starting()` lists them with the title, since when and a `stage` in words; a play
  whose page was opened stays listed until the page reports (it is then `stream`), says it closed, or 30 s pass.
- `GET /api/movies/player` answers `starting` and one boolean, `busy` (a VLC play, a stream on screen, or a play
  being started). `busy` is the one check.
- `scripts/install.sh` reads it before the build (the build rewrites `dist/` under the running daemon) and again
  right before the restart. Busy: nothing is changed, it says what plays or starts, exit **75**. `--force`
  (`NOTES_INSTALL_FORCE=1`) restarts anyway; `--wait` asks every 20 s for up to 6 hours
  (`NOTES_INSTALL_WAIT_SECONDS`) and then installs: that is the one for unattended callers; `--check-idle` only
  asks. No daemon counts as idle. A daemon from before this change lists no `starting`: a plain run trusts its
  `stream` and `current`, and `--wait` goes on only after nine idle readings in a row (three minutes, longer than a
  play takes to resolve), so the first install after this lands does not repeat the incident.
- The Landing wording to copy is in `CLAUDE.md` ("Restarting the live daemon") and `docs/guide/install.md`
  ("It never restarts under a film"): run `scripts/install.sh` (or `--wait`), never a reading of `stream`.
- The owner's `p` rule (commit, push, rebuild, restart) now gets exit 75 while a film plays. That is meant: say so
  and use `--wait`, or `--force` when the owner says restart now.

### 2. An index that keeps timing out is skipped
- `IndexHealth` (`find/find.ts`), one per daemon run, in memory: 3 `error` answers in a row (a timeout or a
  failure) leave an index out for 30 minutes; its attempt is `Index: <name>` `skipped` with the reason. After the
  cool-down it is asked again and one more failure leaves it out again. `ok` and `empty` reset the count; a caller
  that gave up counts nothing; `bot_check` is never counted and never skipped. The fallback sites go through the
  same health (they have no special case), but they are asked only when the indexes leave nothing.

### 3. The film starts before the subtitle search ends
- The chain is started when a torrent is chosen and may hold the answer for 1.5 s
  (`NOTESD_TORRENT_SUBTITLE_WAIT_MS`): a kept file (every replay) still arrives in the answer. After that the
  play answers `Subtitles: pending` and the chain goes on behind it; when it ends the track is put on the session,
  `subtitleRev` goes up and the open page loads it through the path Wyzie Synced already uses (no web change).
  Wyzie Synced starts after the chain, as before. The order of the tiers and their 40 s budget are unchanged.
- The verify harness sets the wait to 40 s on `--torrent` runs, because the subtitle journeys read the subtitle in
  the play's answer; `speed.sh` runs with the daemon's own 1.5 s.

### 4. The tool answers before the client gives up
- The client's limit: Claude Code gives an MCP request over HTTP 60 s, and `/mcp` answers plain JSON
  (`enableJsonResponse`), so nothing reaches the client before the tool is done. The failed call was answered
  "The operation timed out." 66 s after it was made. The chat bar reaches the same tool over the same `/mcp`.
- `direct_stream_play` waits 45 s (`PLAY_ANSWER_MS`), then answers `started: false, pending: true` with `stage`
  and the attempts so far. The play goes on and opens the player itself. The same call again joins it or reads its
  outcome (kept 10 minutes). I did not bound the play itself harder: a cloud resolve may rightly take two minutes,
  and killing it at 45 s would turn a slow success into a failure. `POST /api/stream/play` still waits.
- Every play that starts nothing writes its attempts to the daemon's log, whoever waited.
- **For `/report-stream-bug`** (not edited here): a play that never made a session is these journal lines.
  `collect.sh` should keep lines matching `direct stream: play of .* started nothing` and the
  `direct stream:   attempt <provider>: <outcome> after <n> s (<detail>)` lines that follow, and `diagnose.mjs`
  can list them beside "torrent play ... none played". A session's `attempts` may now hold `Subtitles: pending`
  for a few seconds (replaced by the tiers' attempts once the chain ends), a `Torrent:` attempt may be `skipped`
  ("its header arrived too", "still opening when"), an `Index:` attempt may be `skipped`, and a played torrent's
  detail carries `N seeds listed; P peers connected, X Mbps for a Y Mbps film`: the "slow step" lines should not
  count a `skipped` attempt, and can read the peers and rate at the start from that detail.

### 5. Choose a torrent by what its swarm delivers
- The best three candidates are opened side by side (file list, file choice, selection, header probe). When the
  first header arrives the others get 2 s; then, of those that passed: delivers (6 or more peers connected, or a
  rate at or above the film's bitrate) > an English subtitle file > more peers > the finder's order. The ones not
  chosen leave their swarms at once (`TorrentStreams.drop`, no three-minute linger) and lead the shuffle list.
- This replaces the old pre-step that read three file lists and waited for all of them (up to 15 s) before the
  first torrent was tried; the English-subtitle preference lives on as the second key of the choice.
- Budget: per torrent still 20 s for the file list and 30 s for the header; six torrents (two rounds of three)
  instead of five; 90 s in all. Evidence: on 2026-11-17 the one that played needed 37.5 s alone, and the 720p
  release gave no file list in 15 s and again in 20 s; in sequence that left the third candidate no time, side by
  side each of the first three has its full 50 s inside the first 50 s. On loopback a dead swarm listed first
  (900 seeds) no longer costs 20 s: the live one played after 3.8 s, 2 s of which is the settling time.
- "No automatic move" is kept: a move discards what is on disk and starts from nothing, a pause fills a slow
  torrent, and the shuffle button now offers first the torrents whose headers also arrived. The guide says so.
- Not done: comparing rate against bitrate over a longer window before choosing (2 s of rate is noise; peers is
  the steadier signal, so it comes first), and an offer on screen when a swarm delivers under the bitrate.

### Proof
- Unit: `torrentSource.test.ts` (race, choice, subtitles behind the play), `playInFlight.test.ts` (starting, the
  player route, playWithin, the failed play's log), `find/indexHealth.test.ts`, `scripts/installGuard.test.ts`,
  `mcp.directStreamTools.test.ts` (pending), `config.torrent.test.ts`.
- Throwaway daemon: `torrent/speed.sh` on `NOTESD_TORRENT_SUBTITLE_WAIT_MS=1500 verify.sh up --torrent`:
  `speed: PASS (race subtitles pending index)`; the earlier journeys (`torrent/torrent.sh`,
  `direct-stream/torrent.sh`, `torrent/subtitles.sh`, `torrent/synced.sh`, `direct-stream/codenames.sh`) still pass.

### Seen and left
- `web/src/App.movies.test.tsx` ("reaching for the page folds the answer panel") is flaky: it failed here and on
  an untouched `origin/main` at 04:25, and passed in the full run at 04:46. Not touched here.
- While proving, a step's time sometimes came out 2.93 s too long (a `Subtitles: pending` after 4.4 s instead of
  1.5 s, `/health` "answered" after 2953 ms). A lag monitor inside the daemon showed the daemon and its `tsx`
  parent both "stalling" by the same 2930 ms at the same instant, several times a minute apart: this WSL's wall
  clock is stepped forward by about 2.93 s now and then (time sync), and every duration here is measured with
  `Date.now()`. Nothing stalls; a `took_s` that lands on a step reads 2.9 s too high. `speed.sh` therefore does
  not assert on single durations under 3 s.
