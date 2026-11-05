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

## Read API, MCP tools and SSE (phase 5)

### Sub-features
- `GET /api/adversary/overview`: every Seer original (`roster`), each active one with a twin
  (`methods`) with returns since the twin started (money-weighted, deposits included), objections
  (`objected`, `reviewed`, `fell_after`), coverage (`reviewed`, `absent`, `late`, `paused`,
  `pending`), both checklists (Seer's five rules, Seer's own strings under `seer`; a twin's rule 5 is
  `state: "na"`, `seer.val: "Can't be run"`), `cause`, `latest` (≤ 8), `last_review`, `reviewer`.
- `GET /api/adversary/methods/:id`: curves (growth of 100, deposits taken out), stats, checklists,
  current decision, every decision, record of objections, revisions, three-way (daily methods).
- `GET /api/adversary/methods/:id/decisions/:session`: verdict cards with `late`, weights, `held`, `action`.
- `GET /api/adversary/daily/:id?session=`: A / C / A+Claude rows, `buys`, `grid`, `settled`.
- `GET /api/adversary/scorecard/:id`: horizon record, C-vs-Claude duel.
- `GET/PUT /api/adversary/toggle`, `POST /api/adversary/review-now` (same-origin, 202).
- SSE `event: adversary {op, strategy_id, session_date}` on `/api/events`.
- MCP `adversary_overview`, `adversary_verdicts`, `adversary_scorecard` (read-only; chat may use them).

### How to get to it (user POV)
- Claude Code: "/n what did Claude object to today?" (MCP `adversary_verdicts` with `verdict: "object"`).
- The wall's `/adversary` page (phase 6) reads these routes and refreshes on `event: adversary`.

### Driving it with verify.sh
- `SEER_DIR=<seer checkout with 027> $V up --adversary`, then
  `$V exec RUN --seer "$(cat tests/fixtures/adversary/seer-seed.sql)"`, then
  `$V api RUN GET /api/adversary/overview`, `$V mcp RUN adversary_verdicts '{"verdict":"object"}'`.
  The expected values for that fixture are phase 5's Proof (`.workflows/plan/seer-adversarial/phase-5.md`).
- Seeded sessions are all in the past, so a reviewer pointed at this DB finds nothing due and spends nothing.

### Gotchas
- 503 `seer_unavailable` with `detail: "not_migrated"` means Seer has no migration 027 yet.
- The checklist is Seer's own and is NOT money-weighted (raw equity, as seertrade.site shows it); the
  money-weighted figures are `returns.*` and `figures.*.return`.
- A twin decides one session late, so its `buys` read `null` on the decision night.
