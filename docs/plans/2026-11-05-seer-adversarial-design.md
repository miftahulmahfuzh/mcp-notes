# Seer Adversarial: design brief

Date: 2026-11-05. Author: session H7-OA, with the owner. Status: brainstorm and UI design agreed;
ready for `/analyze` to plan. This brief spans two repos: `~/mcp-notes` (this one) and `~/seer`.

UI mock (agreed): https://claude.ai/artifact/TLXjXa9jgqGTzMJ5q7osDE (four boards: overview, monthly
method, daily three-way, focus mode with auto-runs off). Numbers on it marked "sample data" are
illustrative; the Daily board's A list and C verdicts are real, from Seer's DB for session 2026-11-04.

## 1. What and why

Seer's lab has tried 508 methods in 1,716 trials and spent 5 test-window looks, all failed (read from
`~/seer/lab/lab.sqlite` on 2026-11-05). The owner is not giving up, but instead of a method that relies
entirely on Claude, Claude becomes the **adversary** of every method on Seer's roster: before a pick is
bought, Claude researches it on the web, critiques it like an investment manager, and says **agree**,
**object** or **can't tell**, concisely, in plain words (no trading jargon), with links for every claim.

Each roster method gets a **Claude twin**: a paper book that runs the same method but drops what Claude
objects to. Over ~18 months the owner sees whether the twins do better than the originals on Seer's
cause, in order: 1. beat SPY, 2. make the most money, 3. smaller drawdowns. The wall gets a new page,
**Seer Adversarial**, that shows all of it.

## 2. Owner decisions (2026-11-05, binding)

1. **Objection semantics.** An objected stock is dropped. In a book (monthly/quarterly), its weight is
   spread pro rata over the remaining targets. In a bracket strategy (A), the next-ranked candidate
   takes the slot, exactly as C does. No up-weighting. *Can't tell* = keep (follow the method).
2. **Architecture.** Seer may be changed freely (it is a personal toy, written entirely by Claude). The
   twins live in **Seer's engine** as roster rows, simulated by Seer's one simulator with real Gotrade
   fees and the shared deposit schedule, so the leaderboard, go-live checklist and `paper_check` apply
   unchanged. mcp-notes writes Claude's verdicts into **one narrow table in Seer's DB**.
3. **Re-add plain A** (`A-GT`) as a paper book, so A, C and A+Claude can be compared three ways.
4. **Missing verdict = copy the original.** If no laptop had WSL up (or the review failed), the twin
   does exactly what the original does, and the decision is recorded as **absent**.
5. **Which methods.** Every method on the current **and future** roster. Sera keeps changing the roster,
   so twins must appear when a method is admitted and retire when it retires, with no manual step.
6. **Books: review every target at every rebalance**, not only new names. Objecting to a held name means
   selling it, and those fees count against Claude.
7. **Model and budget.** About 10 to 15 deep reviews per weekday are acceptable: Opus for the verdict,
   a cheaper model for gathering. **An ON/OFF toggle** pauses automatic runs (the owner sometimes needs
   the week's tokens elsewhere). Decisions skipped while off are recorded as **paused**, distinct from
   absent; the twin copies the original in both cases.
8. **seertrade.site.** Twins appear on Seer's Leaderboard, labelled Paper, and **never** on Today.
9. **Alt+Z** toggles focus mode on the Seer Adversarial page, exactly like the Projects page.

## 3. Verified facts (read 2026-11-05 from Seer's Neon DB and code)

- Active roster: `SPY-GT` (benchmark), `C-GT` (bracket, daily, since 2026-10-07), `RAW35-FR-GT` (book,
  monthly, 35 names, since 2026-10-14), `COSK-FR-GT` (book, 20 names, re-picked quarterly, since
  2026-10-19). Retired with history kept: RAW, RMW, MVW, MOM, FULL50, MOM70 (retired 2026-11-01).
- **No plain A book is active.** `A` was retired by migration 017; `C-GT` is A's only descendant.
- C = A's top 10 ranked candidates for the next session; `commands/veto.py` reads ≤20 Finnhub headlines
  from the last 3 days plus earnings dates and asks GLM-5.3 under the frozen prompt `c-veto-v1`
  (`engine/src/seer_engine/strategies/c.py`). Verdicts in `news_vetoes` (172 so far: 86 veto, 86 allow);
  `failed`/missing = no trade. `news_vetoes` keeps A's whole ranked top 10 every night, vetoed or not.
- A (`strategies/a.py`): close > SMA200, RSI(2) < 10, 20-day dollar volume > $20M; limit = last − 0.5 ATR,
  TP = limit + 1 ATR, SL = limit − 1.5 ATR; 5-session time stop; 4 slots.
- Equity includes deposits (IDR 5,000,000 a month from 2026-10-26, `paper_contributions`), so any
  return comparison must be money-weighted, as the go-live checklist already is.
- `book_targets` holds each book's targets for a decision session (RAW35 and COSK: 2026-10-14/19 and
  2026-11-02). `book_previews` is refreshed nightly with "what the book would buy if it rebalanced today"
  (per strategy, keyed by rank), which gives days of warning before a monthly rebalance.
- COSK's 2026-11-02 book: 15 of 20 names are energy (APA BKR COP CVX DVN EOG FANG HAL OKE OXY PSX SLB
  TRGP VLO XOM).
- Nightly (`.github/workflows/nightly.yml`): cron 06:17 UTC Tue–Sat (13:17 WIB), retries 09:41 and
  12:41 UTC; steps Nightly (bars) → Veto → Paper → Paper check → Explain → Sean marks. Decisions for
  session S read data only through `prev_session(S)`. US open is 14:30 UTC (21:30 WIB) in US winter,
  13:30 UTC in US summer. There is also `repick.yml`.
- Keys already in `~/seer/.env.local`: `FINNHUB_API_KEY`, `MASSIVE_API_KEY`, `EODHD_API_TOKEN` (bought
  for one month; may have lapsed), `OPENROUTER_API_KEY`, `SEC_CONTACT_EMAIL`. mcp-notes already finds
  Seer through `SEER_DIR` (`src/connectors/env.ts`) and reads it read-only (`src/connectors/seer/*`,
  which already ports the leaderboard ranking).
- The owner runs Claude Code in WSL about 10 hours on weekdays on the office Lenovo, and briefly on the
  GPD at home. Both run a notesd against the same mcp-notes DB.

## 4. The design

### 4.1 Seer side (engine, DB, web)

**Schema** (next migration, prose header like the others):

- `strategies.twin_of text NULL REFERENCES strategies(id)`: set on a twin row, naming its original.
- `adversary_verdicts`: one row per (original strategy, decision session, symbol). Columns: verdict
  (`agree`|`object`|`unsure`), reason (plain words, capped), sources jsonb
  (`[{url, title, publisher, published_at, fetched_at}]`, at least one for object/agree), lens (the
  method brief's id/version), model, prompt_version, host, started_at, decided_at. Append-only in
  spirit; a re-review before the cutoff supersedes (keep history, e.g. a `superseded_by` or a
  separate history table; the planner decides).
- `adversary_marks`: one row per (original, decision session) saying `paused` when the owner's toggle
  was off (written by the daemon). No verdicts and no mark = `absent`.
- A candidate list for **every bracket strategy** (not just C's top 10 in `news_vetoes`): the nightly
  writes A-GT's ranked candidates for S so Claude can review them (e.g. `strategy_candidates`, top 10,
  with the evidence the rule used).

**Twins in the roster.** A twin is a roster row `<ORIGINAL>-CX` (e.g. `RAW35-FR-GT-CX` or a cleaner
id; planner's call) whose object wraps the original's object with the verdict filter. Invariants, to
enforce in the roster builder and check in `paper_check`/tests:

- Every active, non-benchmark original that is not itself an LLM critic (C) has exactly one active twin.
  Admitting a method (Sera promotion path or a migration) creates its twin in the same transaction;
  retiring it retires the twin (`paper_end` set the same way). The twin starts on the original's
  `paper_start` or the day Adversarial goes live, whichever is later, with the same capital and deposits.
- `A-GT` comes back as a bracket book with real Gotrade fees, and gets a twin. C stays as it is.

**When a twin decides.** Claude reviews after the nightly writes S's picks (13:17 WIB) and must finish
before S opens. Two options:

- *Recommended:* the twin decides S **in the next nightly**, before settling S, from verdicts whose
  `decided_at` is before S's open; anything decided later is ignored (= absent). Fills come from stored
  bars, so the result is identical to deciding on time, there is no second cron and no race with the
  12:41 UTC retry, and Claude's window runs to the US open (21:30 WIB in winter). Cost: the twin's
  pending orders appear a day late (they are paper and never on Today anyway). The planner must
  confirm the paper runner, `paper_check` replay and the book engine can decide-then-settle in one
  night without breaking the one-transaction-per-night rule.
- *Fallback:* a second workflow before the earliest open (it must be after the 12:41 UTC retry and
  before 13:30 UTC in US summer) that steps only twins.

**Verdict application.** Bracket twin: walk the original's ranked candidates, skip `object`, keep the
rest, fill free slots as the original does. Book twin: drop `object` targets, renormalise the rest pro
rata; if every target is objected, hold cash (decide and document). Objected held names are sold
through the normal book mechanics, paying fees.

**Seer web.** Leaderboard lists twins as Paper next to their originals (the go-live checklist shows
rule 5 as "can't be run" for a twin: Claude already knows how the past turned out). Today never shows
a twin. Read `web/AGENTS.md` and `node_modules/next/dist/docs/` first (Next.js 16).

### 4.2 mcp-notes side (daemon, API, MCP, web)

**Reviewer** (`src/adversary/*`, a background job in `src/background.ts`, gated by config):

- *Discovery:* poll Seer's DB for decisions that need a verdict: bracket candidates for the next session,
  book targets for a pending decision session, and `book_previews` for an early look before a monthly
  rebalance (review early, then only re-review what changed). Read the roster dynamically; never
  hard-code strategy ids.
- *Lease:* two daemons (Lenovo, GPD) may be up at once. Claim each (strategy, session) with a lease row
  (host, expires) so only one reviews it; a crashed host's lease expires.
- *Method brief (the lens):* per original strategy, built automatically from its roster row (`sub`,
  engine, horizon, `gate_note`) and its lab method's hypothesis (`promoted_from` → `lab.sqlite`
  `methods`), plus an optional hand-written override per `object_name` (e.g. `claude/adversary/briefs/`).
  A new roster method therefore gets a usable lens with no code change. Lens and system prompt are
  hashed into `prompt_version`; any change becomes a dated revision line on the page.
  - A (5-day dip buy): is this dip noise or news? Anything scheduled inside 5 sessions? A drop on a
    lowered forecast is a re-pricing, not a dip. Fundamentals barely matter.
  - RAW35 (monthly momentum beyond the market): will what drove the rise last the month? One-off jumps
    (takeover rumour, squeeze, single report) tend to give back; a fixed-price pending takeover can't
    rise; results due inside the month?
  - COSK (crash-prone, held for a premium): never object because a stock is risky (that is the thesis).
    Object only when the thesis breaks: pending acquisition, bankruptcy, delisting. Book-level notes
    (such as the energy concentration) are display-only.
- *Agent:* Claude Agent SDK as in `src/chat/agent.ts`. Gathering with a cheaper model, verdict with Opus;
  structured JSON output validated with zod. Tools (in-process MCP): Seer price context from the bars
  table (no network), Finnhub (company news, earnings calendar, recommendation trends, basic financials,
  insider transactions; check which endpoints the free tier allows), Massive/Polygon news, SEC EDGAR
  (8-K, 10-Q, Form 4; needs a User-Agent with `SEC_CONTACT_EMAIL`), plus WebSearch/WebFetch. Every
  object/agree must cite at least one URL it actually fetched; unverifiable claims become *can't tell*.
  Plain words: no tickers-as-jargon, no "RSI", no "oversold".
- *Budget:* per-stock turn/token caps, a daily cap, and a usage log; failures never block other stocks.
- *Writer:* a narrow module that writes only `adversary_verdicts`, `adversary_marks` (and lease rows)
  to Seer's DB, using the unpooled URL from `SEER_DIR/.env.local`. It is separate from the read-only
  connector guard, which stays read-only.
- *Toggle:* the ON/OFF state lives in the shared mcp-notes DB (both machines obey it). While off, the
  daemon writes `paused` marks for decisions that fall due. "Review now" runs once even while off.

**Scorecard** (computed in mcp-notes from Seer's bars, read-only): for each objection, the stock's
return over the method's own horizon (5 sessions for A; until the next rebalance for books) against the
average of the picks that were kept. For A, also C-vs-Claude on the nights they disagree. This answers
"is Claude useful?" long before 18 months of equity curves can. Go-live checklist and money-weighted
returns: reuse/extend `src/connectors/seer/leaderboard.ts` and `ranking.ts`, and keep parity with
Seer's own checklist rules (drawdown bar 25%, PF ≥ 1.3, 18 months, beat SPY, 10-year backtest).

**HTTP / SSE / MCP.** `/api/adversary/*` (overview, method detail, decision verdicts, scorecard,
toggle, review-now) with SSE events so the page updates live; MCP tools (e.g. `adversary_overview`,
`adversary_verdicts`) so the chat bar and `/n` can answer "what did Claude object to today?". Update
the README tables.

**Wall page** (`web/`): a sword icon (Phosphor `Sword`, duotone) between Chat history and Trash in both
`Rail.tsx` and `Sidebar.tsx`; route `/adversary`; heading "Adversary." in the wall header; the sidebar
lists the roster like Projects lists repos (Overview first, retired greyed below); toolbar on the right:
Power toggle (on = inverted `ibtn`, off = dashed ring), Review now, Focus. **Alt+Z** focus mode as on
Projects (`web/src/pages/ProjectsPage.tsx` lines ~94–110: capture phase, `e.code === 'KeyZ'`, Esc
leaves); consider extracting a shared hook. Monochrome only, icon-only buttons with tooltips and
`aria-label`, Geist Mono for meta, hairlines, no shadows (see memory `ui-taste`). Overview rows show
original / twin / SPY returns, objections, coverage bar (reviewed · absent · paused), both checklists as
dots; method page shows curves, side-by-side checklist, the decision's verdict cards (reason, numbered
sources, weight change, "held · sell" or "new · skip"), the record (one dot per objection), and the
revisions log; the A page shows the ranked list with C and Claude side by side and the disagreement
grid. A chat pill "Ask about Seer Adversarial" like the other pages. Handle `not_on_this_machine`
nowhere new (no local files are involved), but show which host made each review.

## 5. Honesty rules (do not trade these away)

- Forward only. Claude cannot be backtested; never present a twin backtest.
- Information cutoff: a verdict counts only if decided before its session opens; store `decided_at`
  and every source's `fetched_at`.
- Missing/failed/late = copy the original, recorded as absent or paused, never as Claude's call.
- Every prompt/model change is a dated revision; never rewrite past verdicts.
- Numbers on the page come from the DB, never from the model's prose.
- Seer's own rules still bind Seer changes: migrations with prose headers, closed records frozen,
  tests never reach production, TS/Python mirrored constants kept equal, `verify-seer` proof, commit
  explicit paths only.

## 6. Suggested phases (the planner decides the final cut)

1. Seer schema + twin machinery + `A-GT` re-admission + candidate list for bracket strategies +
   roster invariants + `paper_check` (engine, Python). Proof: `verify-seer`.
2. Seer web: twins on the Leaderboard as Paper, never on Today; checklist rule 5 wording for twins.
3. mcp-notes reviewer: discovery, lease, briefs, data tools, agent, writer, toggle, budget, marks.
4. mcp-notes API + SSE + MCP tools + scorecard + go-live parity.
5. Wall page `/adversary`, rail/sidebar button, Alt+Z focus, toggle UI. Proof: `verify-notesd`, update
   its `features/` map.
6. Install/ops: config keys (README env table), `scripts/install.sh` if needed, rebuild/restart notesd,
   first live review of tonight's decisions.

Phases 1–2 (seer) and 3–5 (mcp-notes) can run in parallel once the verdict table's shape is fixed.

## 7. Risks and open points for the planner

- Statistical power: monthly books give ~18 decisions in 18 months; the per-objection scorecard and A's
  ~10 candidates a night are where signal appears first. Say so on the page.
- Decide-late twins: confirm it fits the paper runner and replay; otherwise use the fallback cron.
- Finnhub free-tier limits (60 calls/min; some endpoints premium) and EODHD's lapsed token.
- Two daemons: lease correctness across hosts and clocks.
- Token cost: caps and the toggle; record usage per review.
- COSK concentration cannot be fixed by per-stock vetoes; show it as a note, not an action.
