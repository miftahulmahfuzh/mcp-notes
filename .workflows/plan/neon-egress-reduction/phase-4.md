# Phase 4 — Summary worker: scan only when something may have changed, stop relisting settled rows

**Satisfies:** R4 · **Depends on:** — · **Package:** `src/sessions/summaryWorker.ts` (+ its unit tests) · **Difficulty:** NORMAL
**Does not touch:** the note / image / reply embedding workers (their `listPending` already uses DB-side `next_attempt_at` backoff and an idle sweep returns 0 rows; verified in the analysis), `src/embeddings/*`, the schema (no migration: see Decisions in the index).

## Goal
`drainOnce` (`src/sessions/summaryWorker.ts:428`) runs `listRequested` and `listIdle` (limit 5000) every 60 s. Sessions whose summary input and embed text are null stay in the SQL result forever (the `seen` map only stops processing, not the relist), and after each restart every such row is `load`ed again (full prompts, commits, summary) before being skipped. This phase makes the idle scan conditional and removes settled rows from it.

## Design
1. **Scan gating.** Keep the 60 s interval timer as the trigger, but `drainOnce` performs the idle scan only when one of these holds: (a) the host's session fingerprint changed since the last scan, (b) `SCAN_FLOOR_MS = 5 * 60_000` passed since the last scan (idleness crosses the 15 min boundary with no row change), (c) a `retryAt` entry is due, (d) it is the first drain, (e) `kick()` was called. `listRequested` (limit 100, only rows with a pending Summarize request) keeps running every sweep; it returns nothing when no request is pending.
2. **Fingerprint.** New store method `fingerprint(host)`: `select count(*)::int as n, max(updated_at) as u, max(last_active_at) as a from cc_sessions where host = $1` → string. Cost ~100 B. Add to `SummaryStore` as optional (`fingerprint?(host): Promise<string>`); a store without it (test fakes) scans every sweep as today.
3. **Exclude settled ids.** `listIdle` gains `excludeIds: readonly string[]` — SQL `and s.session_id <> all(array(select jsonb_array_elements_text(${json}::jsonb)))` (same `textArray` idiom as `readModel.ts:204`; an empty list adds nothing). The worker keeps `settledAt: Map<string, number>` (set wherever `seen.set` is called today, deleted in `fail`) and passes the ids settled within `SUMMARY_SETTLED_TTL_MS = 30 * 60_000` (newest first, cap 2000). A settled session that later changes must get back in before the TTL: on every scan after the first, call `changedSince({ host, since: lastScanAt })` (`select session_id from cc_sessions where host = $1 and updated_at > $2`, a handful of ids) and delete those ids from `settledAt` before building the exclude list.
4. **Restart cost.** After a restart `seen`/`settledAt` are empty, so the first scan lists stuck rows once and loads them once. Cut that load: `load()` is only called for rows that survive the `dueIdle` filter; add a second cheap pre-filter for rows with no embedding text possibility — not derivable without the body, so accept one `load` per stuck row per restart and bound it with the existing batch size. Documented trade-off; a persisted marker would need a migration.

## Edits in `summaryWorker.ts`
- Constants: `export const SUMMARY_SCAN_FLOOR_MS = 5 * 60_000; export const SUMMARY_SETTLED_TTL_MS = 30 * 60_000; const SETTLED_EXCLUDE_MAX = 2000;`.
- `SummaryStore`: add `fingerprint?(host: string): Promise<string>`, `changedSince?(opts: { host: string; since: Date }): Promise<string[]>`, and `excludeIds?: readonly string[]` in the `listIdle` options.
- `dbSummaryStore`: implement both (SQL above) and thread `excludeIds` into `listIdle`'s WHERE:
```ts
const exclude = o.excludeIds && o.excludeIds.length > 0
  ? sql`and s.session_id <> all(array(select jsonb_array_elements_text(${JSON.stringify(o.excludeIds)}::jsonb)))`
  : sql``;
// … where s.host = ${o.host} … ${exclude} order by …
```
- `startSummaryWorker`: new state `let lastScanAt = 0; let lastFingerprint: string | null = null; let forceScan = true; const settledAt = new Map<string, number>();`. In `drainOnce`, before `listIdle`:
```ts
const nowMs = clock.now();
let scan = forceScan || nowMs - lastScanAt >= SUMMARY_SCAN_FLOOR_MS || [...retryAt.values()].some((t) => t <= nowMs);
if (!scan && store.fingerprint) {
  const fp = await store.fingerprint(host);
  if (fp !== lastFingerprint) { scan = true; lastFingerprint = fp; }
}
```
  (when `scan` became true by another reason, still refresh `lastFingerprint` once after the scan). When `scan` is false: `candidates = []`. When true: if `store.changedSince && lastScanAt > 0`, delete returned ids from `settledAt`; build `excludeIds` from `settledAt` (TTL filter, newest, cap); call `listIdle`; set `lastScanAt = nowMs; forceScan = false`. `kick()` sets `forceScan = true` before `drain()`. Where `seen.set(id, …)` is called (end of `processOne`), also `settledAt.set(id, clock.now())`; where `fail(...)` runs, `settledAt.delete(id)`.
- Log nothing new except a debug-free single line when a scan is skipped repeatedly? No — silence is correct.

## Tests (`tests/unit/sessions/summaryWorker*.test.ts`, memory store + fake clock)
- Scan gating: with `fingerprint` returning a constant, over 10 simulated minutes `listIdle` is called at t=0 and t=5, 10 min (floor) only; when the fingerprint changes at t=2 it is called at the next sweep.
- Exclude: a row processed once and unchanged is passed in `excludeIds` on the next scan and never re-`load`ed; after `SUMMARY_SETTLED_TTL_MS` it is re-checked; a row returned by `changedSince` drops out of the exclude list.
- Retry due forces a scan; `kick()` forces a scan; a store without `fingerprint` scans every sweep (back-compat).
- Existing tests that assume a scan per sweep: set `forceScan` via `kick()` or provide a store without `fingerprint`.
- Integration (`tests/integration/sessions.summaries.int.test.ts` or the existing summary int test): `listIdle` with `excludeIds` returns the expected subset on real Postgres.

## Verification
```sh
npm run typecheck
npm test
npm run test:int
```

## Exit criteria
Idle scans run at most every 5 minutes unless the host's sessions changed, a retry is due, or a kick arrived; settled sessions are excluded from the SQL result for 30 minutes; summaries and embeddings are produced exactly as before (integration tests green); tree builds.
