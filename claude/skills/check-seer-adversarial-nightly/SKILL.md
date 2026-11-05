---
name: check-seer-adversarial-nightly
description: Use when the user types "/check-seer-adversarial-nightly", or asks whether Seer's GitHub nightly is healthy, whether Seer Adversarial will have results today, or when (in WIB) the Adversarial verdicts will show up. Checks the Seer nightly workflow for problems (Seer Adversarial depends on it), saves one concise note per problem linked to the current Claude Code session, and tells the user the WIB time to expect today's Adversarial results, or why there will be none.
model: claude-sonnet-4-6
---

# /check-seer-adversarial-nightly

Two jobs: (1) find problems in Seer's GitHub nightly, (2) say when today's Seer Adversarial results
will land, in WIB (Asia/Jakarta, UTC+7), or why they won't. Read-only on Seer and on the notes
daemon; the only write is a note per problem.

## How the pieces fit (verify, do not assume)

- Seer repo: `~/seer`, workflow `.github/workflows/nightly.yml`. Cron slots 06:17, 09:41, 12:41 UTC,
  Tue-Sat. **GitHub fires them hours late** (seen: 14:21, 17:19, 19:45 UTC) and sometimes not at all,
  so always read the real run times with `gh`, never quote the cron. Steps: Nightly (writes the
  picks for the next US session) -> Veto -> Paper -> Paper check -> Explain -> Sean marks. A later
  slot logs "session ... already succeeded; nothing to do". A red run whose Nightly/Veto/Paper steps
  passed still wrote the picks; Paper check failing is a real problem but does not block them.
- Seer Adversarial is **not event-driven**. notesd (a systemd user unit in WSL) polls Seer's
  database every 10 minutes (`ADVERSARY_POLL_MS`, first pass 30 s after start) and reviews decisions
  whose session has not opened. Nothing from GitHub triggers it.
- A verdict counts only if decided before the US open, 09:30 New York: 14:30 UTC = 21:30 WIB in US
  winter, 13:30 UTC = 20:30 WIB in US summer. After that the twin copies the original.
- It reviews only originals that have an **active twin** (`strategies.twin_of`), needs Seer
  migration 027 applied, the toggle on, and stays under `ADVERSARY_DAILY_CAP` (15 deep reviews per
  WIB day). A review takes up to `ADVERSARY_STOCK_TIMEOUT_MS` (7 min) per stock.

## Step 1: check the nightly

1. `cd ~/seer && git fetch -q`, then `gh run list --workflow=nightly.yml --limit 12 --json databaseId,createdAt,conclusion,event,status`. Convert times to WIB.
2. Compare to what should have happened. Today's WIB date and weekday decide it: the nightly runs
   Tue-Sat UTC. Has a run started today? Is the newest run green? When was the last green run?
   Is a run `in_progress` or `queued`?
3. For each red run in the last 3 days: `gh run view <id> --json jobs --jq '.jobs[].steps[]|select(.conclusion=="failure")|.name'`
   and read the cause from `gh run view <id> --log` (grep the failing step's ERROR/mismatch lines).
   Check `git log origin/main --since=<failing day>` in ~/seer for a commit that already fixes it, and
   whether a run after that commit exists.
4. Check Adversarial's own preconditions:
   - `systemctl --user is-active notesd` and `journalctl --user -u notesd --since -24h | grep -i adversary | tail`
   - toggle: `curl -s localhost:7317/api/adversary/toggle`
   - twins: `mcp__notes__adversary_overview` (a roster row with `twin_id: null` for every method
     means no twin exists yet), or `seer_sql` on `strategies` (`twin_of`).
   - migration 027 in `~/seer/db/migrations` and applied (a pass logs "no adversary tables yet" if not).
   - candidates for the next session: `seer_sql` on `strategy_candidates` (latest `session_date`,
     row count per strategy). No rows for today's session means the nightly has not written picks yet.
5. A **problem** is any of: today's expected run missing or late past the open, a red run, a failed
   step, no twins, 027 not applied, notesd down, toggle off, nightly stale for a trading day. Not a
   problem: a retry slot that skipped because the session already succeeded.

## Step 2: save a note per problem

For each distinct problem (not one note per red run), unless an existing note already says the same
(`search` for the failing step name and "seer nightly" first; if found, say so and skip):

1. `create` a short plain-text note following the `n` skill's rules (no markdown, hashtags on the last
   line, no secrets): what failed, since when, the run id or log line that proves it, and the likely
   cause or the commit that may fix it. Tags: `#seer #seer_adversarial #nightly_problem`.
2. Pass `origin` `{cwd, repo, claude_session}` (only the parts you know). Then link it to this
   session's node: find the node with `sessions_search`/`session_get`, and if the note is not already
   listed there as made, `link_note` with the note id and that node id. Never invent a node id; if you
   cannot identify the node, say so and leave the note unlinked.

## Step 3: when will today's results land (WIB)

Work out the answer from facts, show the arithmetic in one line, and give one time or one reason.

- Today's session: the next US session that has not opened. Open time = 21:30 WIB (winter) or 20:30 WIB (summer);
  check with `sessionOpenUtc` logic (09:30 America/New_York). No US session today (weekend/holiday, or
  the nightly does not run) means no results today.
- **Picks already written** (nightly green for that session, candidates present, twins exist, toggle on, notesd up):
  results start at the next 10-minute poll, so within 10 minutes of now, then trickle in: roughly
  (number of unreviewed picks, capped by what is left of 15) x a few minutes each. Give the expected
  first and last time, in WIB.
- **Picks not written yet, nightly still due**: earliest picks = next run's expected finish. Use the
  actual lateness seen in recent runs (not the cron time), add about 20 minutes for the run, then up to 10 for the poll.
  If that lands after the open, say there will be **no results today** and the twin copies the original.
- **No results today** because of a problem from step 1: name the one blocking cause first (no twins,
  027 not applied, nightly red or not run, notesd off, toggle off, over the cap, past the open).
  Say what must change and whether it can still be fixed before the open.
- State clearly that WSL/notesd only needs to be up from when the picks land until the open, not all
  night, and flag if the laptop is likely to sleep inside that window.

## Reply

Short, in this order: nightly verdict (healthy / problem, one line each), the notes created or
reused (as wall links `[A-B32](http://localhost:7317/?note=A-B32)` and the session link from `session_get`),
then the WIB answer for today in bold. Times in WIB with the UTC time in brackets once. Do not
trigger reviews, "Review now", toggles or workflow runs; suggest them instead.
