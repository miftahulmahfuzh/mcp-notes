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

## Wall page (phase 6)

### Sub-features
- Wall page `/adversary` (overview) and `/adversary/<strategy_id>` (one method), opened by the Sword icon
  ("Seer Adversarial") between Chat history and the recycle bin, in the rail and the sidebar. A second press
  returns to the wall. Heading "Adversary." on the overview; a method page is headed by its code ("RAW35.")
  or, for a one- or two-letter code, its plain name ("Dip buy.").
- Sidebar: Seer's roster as Projects lists repos: "Overview" first (count of active methods), active
  methods with their cadence, then "retired" methods greyed with their retirement date (list names
  "Seer roster" and "Retired methods").
- Overview: cause tiles (1 · beat SPY, 2 · most profit, 3 · smaller drops), one row per method with
  original / twin / SPY money-weighted returns, objections, a reviewed · absent · paused · pending coverage bar,
  both go-live checklists as dots (twin rule 5 dashed: no backtest possible), latest objection cards with
  their sources.
- Method page: curves (growth of 100, deposits out), stats, side-by-side checklist with twin rule 5
  "can't be run", the latest decision's verdict cards (filter object / can't tell / agree; book cards
  show "held · sell" / "new · skip" and the weight change; host and time in each footer; a late
  verdict says "late · not used"), Claude's record (one dot per objection), revisions.
- Daily three-way page: chosen when the method's detail carries a C sibling (`three_way`): three books
  (original, C, original + Claude), the ranked list with C's and Claude's verdicts side by side, the
  disagreement grid, who was right.
- Toolbar: Power toggle (on = inverted, `aria-pressed=true`, "Auto-runs on (click to pause)"; off = dashed
  ring, "Auto-runs off (click to turn on)"; PUT `{on}` only, the server records its own host), "Review now" /
  "Review this method now" (starts one pass even while off; the 202 answers at once and the page shows
  "review started", the verdicts arrive later over SSE), Focus ("Focus (Alt+Z)"). Alt+Z toggles focus mode (`?focus=1`: no rail, sidebar or header) and Esc
  leaves it, exactly as on Projects (shared `useFocusShortcut`).
- Live: SSE `adversary` events and a 60 s poll re-fetch the page.
- Chat pill "Ask about Seer Adversarial": sends through the wall chat with `[Seer Adversarial · <id|overview>]`
  on the first line; the answer opens in the answer panel over the page.
- Empty states: Seer unreachable (`seer_unavailable`), no twins yet, no verdicts yet, no objections yet.
  No "sample data" anywhere: every number comes from `/api/adversary/*`.

### How to get to it (user POV)
Wall rail or sidebar → Sword "Seer Adversarial" → `/adversary`; click a method row (table or sidebar) →
`/adversary/<id>`. Alt+Z for focus. Power to pause automatic reviews.

### Driving it with verify.sh
Seer lives in another database. Give the run a throwaway Seer schema: a database in the verify container
built from the Seer checkout's migrations, seeded with twins, candidates and verdicts, and point the run's
`SEER_DIR` at a scratch directory whose `.env.local` names it. `NOTESD_ADVERSARY=off` keeps the reviewer
(billed agent) from running. Real env wins over `.env.local`, so both reach the daemon.
```sh
SEER_SRC=/home/miftah/seer                      # or the Seer worktree before it lands on main
S=$(mktemp -d); mkdir -p "$S/seer"; SEERDB=seer_v_$$
echo "DATABASE_URL=postgres://postgres:mcpnotes@127.0.0.1:55436/$SEERDB" > "$S/seer/.env.local"
SEER_DIR="$S/seer" NOTESD_ADVERSARY=off $V up --web --sessions
P() { docker exec -i mcp-notes-pg-verify psql -v ON_ERROR_STOP=1 -X -q -U postgres "$@"; }
P -c "create database $SEERDB"
for f in "$SEER_SRC"/db/migrations/*.sql; do P -d "$SEERDB" < "$f"; done
P -d "$SEERDB" < seer-seed.sql                  # the seed in .workflows/plan/seer-adversarial/phase-6.md (Proof)
$V api RUN GET /api/adversary/overview
```
UI selectors: rail `getByRole('button', { name: 'Seer Adversarial' })`; sidebar
`getByRole('list', { name: 'Seer roster' })`; table rows `a.adv-row[data-strategy="<id>"]`; regions
`'Methods'`, `'Latest objections'`, `'Go-live checklist'`, `'<A>, <C> and Claude compared'`; toolbar
`'Auto-runs on (click to pause)'` / `'Auto-runs off (click to turn on)'`, `'Review now'`, `'Focus (Alt+Z)'`;
pill `getByPlaceholder('Ask about Seer Adversarial')`.

### Gotchas
- Never click "Review now" on a run without `page.route` stubbing `/api/adversary/review-now`: it starts
  a real (billed) agent review when the reviewer is on.
- Never drive the pill: it is the chat bar (billed).
- Strategy ids and names come from the seeded Seer DB; read them from `/api/adversary/overview`, never type them.
- `$V sql` reads the notes DB, not Seer's; read Seer rows with `docker exec … psql -d $SEERDB`.
- Drop the Seer DB after `$V down`: `P -c "drop database $SEERDB with (force)"`.
- The connector tools (`seer_*`) read the same `SEER_DIR`; on a run they see the seeded schema only.
- The toggle needs the reviewer: with `NOTESD_ADVERSARY=off` the toggle GET/PUT answer 503 `reviewer_off` and the
  page shows the Power button disabled. Drive the toggle (and focus-with-auto-runs-off) on `up --adversary`; give
  it an empty Seer schema (nothing due, nothing billed) and `ADVERSARY_DAILY_CAP=1 ADVERSARY_POLL_MS=3600000`.
  The overview, method and three-way journeys run on `NOTESD_ADVERSARY=off` against the seeded Seer schema.
