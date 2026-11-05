# Seer Adversarial

## Sub-features
- Reviewer (phase 4). A background job in notesd (`NOTESD_ADVERSARY`, default on) polls Seer's DB
  every `ADVERSARY_POLL_MS` for decisions of every active original that has an active `-CX` twin:
  bracket candidates and book rank/kickoff targets in `strategy_candidates`, and early looks at a
  book's next rebalance in `book_previews.next_decision_session` (within 7 days). It never reads a
  hard-coded strategy id.
- One host per decision: a lease row in Seer's `adversary_leases` (expiry by the Seer DB clock);
  a second daemon skips a leased decision and takes over an expired lease.
- Each stock: a gathering run (default `sonnet`) with Seer price context (no network), Finnhub,
  Massive news, SEC filings, WebSearch and `fetch_url`; then a verdict run (default `opus`, no
  tools, structured output). agree/object must cite a page `fetch_url` opened, else it is stored as
  `unsure`. The verdict lands in Seer's `adversary_verdicts` with `decided_at` = Seer DB time; one
  that lands after the session's 09:30 New York open is kept but logged `late` (the engine ignores it).
- Every attempt is a row in mcp-notes `adversary_reviews` (tokens, cost, turns, models, host,
  status `ok`/`failed`/`skipped_budget`/`late`, stage `draft`/`final`). A daily cap
  (`ADVERSARY_DAILY_CAP`, default 15 per WIB day, both machines) reviews bracket picks first, then
  books by earliest open, previews last; picks over the cap get one `skipped_budget` row a day and
  stay absent. A draft from a preview is reused, at no cost, when the real targets appear.
- ON/OFF toggle: `app_settings` key `adversary.auto` `{on, changed_at, host}`, absent = on. While
  off, automatic passes write one `paused` mark per due decision (Seer `adversary_marks`) and review
  nothing; "review now" (`AdversaryService.reviewNow`, phase 5's API) still reviews.
- Before Seer migration 027 exists the job logs "Seer's database has no adversary tables yet" and idles.

## How to get to it (user POV)
- Nothing on the wall yet (phase 6). The owner sees it in Seer: verdict rows for tonight's picks,
  and twins that skip objected stocks. The daemon log says `adversary reviewer on as <host>`.

## Driving it with verify.sh
- `SEER_DIR=<seer checkout with migration 027> $V up --adversary` builds a throwaway Seer DB and
  turns the reviewer on against it. Seed with `$V exec RUN --seer "..."` (a twinned original in
  `strategies` + its `strategy_candidates`), read results with `$V exec RUN --seer "select ..."` and
  `$V sql RUN "select ... from adversary_reviews"`.
- Free journey (no model call): set the toggle off FIRST with
  `$V exec RUN "insert into app_settings (key, value) values ('adversary.auto', '{\"on\": false, \"changed_at\": \"2026-11-05T00:00:00Z\", \"host\": \"verify\"}'::jsonb)"`,
  then seed; within a few polls Seer's `adversary_marks` has one `paused` row per due decision.
- Paid journey: leave the toggle absent, seed one twinned bracket original with two real symbols
  for a session a few days ahead, start with `ADVERSARY_DAILY_CAP=1`; expect one verdict row and one
  `skipped_budget` row. Costs one Sonnet gathering run plus one Opus verdict.

## Gotchas
- A plain `$V up` pins `NOTESD_ADVERSARY=off`; only `--adversary` turns it on, and only against the
  throwaway Seer DB.
- Seed the toggle before the roster: the first poll runs within `ADVERSARY_POLL_MS` of `up`.
- `strategy_candidates` rows for a session whose open has passed are never reviewed (cutoff).
- The integration tests (`tests/integration/adversary`) need `SEER_DIR` pointing at a Seer checkout
  with migration 027, else they skip with that reason.
