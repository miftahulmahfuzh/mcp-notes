# Connectors: expense-tracking, run-insights and Seer (read-only)

daily-words, the one connector that writes, is in `dword.md`.

## Sub-features
- Each system's three layers: `<system>_schema`, the curated tools (`expenses_spending`,
  `expenses_months`, `expenses_get`; `runs_list`, `runs_get`, `runs_review`; `seer_leaderboard`,
  `seer_positions`, `seer_sera_best`), and `<system>_sql` for one read-only `SELECT`. `seer_schema`
  and `seer_sql` also read the lab (`source: "lab"`, `lab.sqlite`).
- The guard (`src/connectors/guard.ts`, `sql.ts`): one `SELECT` or `WITH ... SELECT`, no writing
  word or effectful function, refused before the query reaches the database; underneath, a
  read-only transaction. 200 rows by default, 1,000 at most (`max_rows`), `truncated` when more
  existed.
- Finding a database: each app's own `.env.local`, found through `EXPENSE_TRACKING_DIR`,
  `RUN_INSIGHTS_DIR`, `SEER_DIR` (default: the app's folder in the home directory), read on every
  call. A missing repository or file fails soft: "<label> is not reachable: ...".
- The chat bar has the same tools (`ALL_CONNECTOR_TOOL_NAMES` on its allow list).

## How to get to it (user POV)
Claude Code: `/n how is my spending this week`, `/n how did yesterday's run go`, `/n what's on the
Seer leaderboard`. The wall's chat bar answers the same questions.

## Driving it with verify.sh
```sh
$V up
$V mcp RUN expenses_sql '{"sql":"delete from transactions"}'   # refused before reaching the database
$V mcp RUN expenses_sql '{"sql":"select 1; select 2"}'         # refused: one statement only
$V down RUN
EXPENSE_TRACKING_DIR=/nonexistent $V up
$V mcp RUN2 expenses_months '{}'          # "expense-tracking is not reachable: no repository at /nonexistent"
```
The curated maths and the guard against real schemas: `npm run test:int`, whose
`tests/integration/connectors/{expenses,runs,seer}.curated.int.test.ts`, `core.int.test.ts`,
`generic.int.test.ts` and `mcp.int.test.ts` rebuild each schema from the sibling repository's
migrations (a missing repository skips with that reason). Unit: `tests/unit/connectors/`
(`guard.test.ts`, `failsoft.test.ts`, `env.test.ts`, the per-system tests).

## Gotchas
- A plain `$V up` does not pin `EXPENSE_TRACKING_DIR`, `RUN_INSIGHTS_DIR` or `SEER_DIR` (only
  `--adversary` points `SEER_DIR` at a scratch copy), so its connector tools read the owner's real
  databases, read-only. Prefer the refusal and fail-soft journeys above, and never paste the
  owner's real rows into evidence or a report.
- No pictures of connectors exist in the guides, on purpose: the only data they could show is real.
