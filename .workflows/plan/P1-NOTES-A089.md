> Adopted from `/home/miftah/.worktrees/mcp-notes/neon-egress-reduction/.workflows/orchestration/neon-egress-reduction/PLAN.md` phase 5. Source: `.workflows/plan/neon-egress-reduction/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.
# Phase 5 — Egress meter and quota circuit breaker

**Satisfies:** R5 · **Depends on:** — · **Package:** `src/db`, `src/http`, `src/config.ts` · **Difficulty:** NORMAL
**Does not touch:** query sites in `src/notes`, `src/sessions`, `src/embeddings`, `src/adversary` (they are measured, not edited), `web/`.

## Goal
Nothing today records how many rows or bytes a query returns, so the 5.54 GB could not be attributed. This phase (a) counts rows and approximate bytes per query shape at the single choke point (`createDb`, `src/db/client.ts:33`), exposes the counters at a loopback-only endpoint and logs the top spenders hourly; (b) adds a circuit breaker so that once Neon answers `53000 … exceeded the quota`, notesd stops sending queries for a cool-down instead of hammering the database from every 60 s loop on both machines.

## New file `src/db/meter.ts`
```ts
export interface QueryStat { label: string; calls: number; rows: number; bytes: number; lastAt: number }
export interface EgressSnapshot { since: string; totalBytes: number; totalRows: number; totalCalls: number; top: QueryStat[] }

/** Normalises SQL to a stable label: collapse whitespace, cut at 100 chars. Parameters stay as $n, so values never reach the label. */
export function sqlLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

export class EgressMeter {
  private readonly stats = new Map<string, QueryStat>();
  private readonly startedAt = new Date();
  constructor(private readonly now: () => number = Date.now) {}

  record(text: string, rows: readonly unknown[] | undefined): void {
    const label = sqlLabel(text);
    const n = rows?.length ?? 0;
    // JSON length approximates the wire payload within ~±30 %; computed only for non-empty results.
    const bytes = n === 0 ? 0 : Buffer.byteLength(JSON.stringify(rows));
    const s = this.stats.get(label) ?? { label, calls: 0, rows: 0, bytes: 0, lastAt: 0 };
    s.calls += 1; s.rows += n; s.bytes += bytes; s.lastAt = this.now();
    this.stats.set(label, s);
  }

  snapshot(limit = 25): EgressSnapshot {
    const all = [...this.stats.values()];
    return {
      since: this.startedAt.toISOString(),
      totalBytes: all.reduce((a, s) => a + s.bytes, 0),
      totalRows: all.reduce((a, s) => a + s.rows, 0),
      totalCalls: all.reduce((a, s) => a + s.calls, 0),
      top: all.sort((a, b) => b.bytes - a.bytes).slice(0, limit),
    };
  }

  /** `[notesd] egress 1h: 41.2 MB in 3120 calls; top: <label> 30.1 MB (120 calls), …` */
  summaryLine(top = 5): string {
    const s = this.snapshot(top);
    const mb = (b: number): string => `${(b / 1_048_576).toFixed(1)} MB`;
    return `[notesd] egress since ${s.since}: ${mb(s.totalBytes)} in ${s.totalCalls} calls; top: ${s.top.map((t) => `${t.label} ${mb(t.bytes)} (${t.calls} calls)`).join('; ')}`;
  }
}
```

## New file `src/db/quota.ts`
```ts
export class QuotaExceededError extends Error {
  readonly code = '53000';
  constructor(readonly until: Date) {
    super(`Neon quota exceeded; notesd is not querying until ${until.toISOString()}`);
    this.name = 'QuotaExceededError';
  }
}

export function isQuotaError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  return (e?.code === '53000' && /exceeded the quota/i.test(message)) || /project has exceeded the quota/i.test(message);
}

export const QUOTA_COOLDOWN_MS = 30 * 60_000;

export class QuotaBreaker {
  private until = 0;
  constructor(private readonly now: () => number = Date.now, private readonly cooldownMs = QUOTA_COOLDOWN_MS) {}
  trip(): void { this.until = this.now() + this.cooldownMs; }
  /** Throws QuotaExceededError while tripped; the first query after the cool-down is the probe. */
  check(): void { if (this.now() < this.until) throw new QuotaExceededError(new Date(this.until)); }
  get tripped(): boolean { return this.now() < this.until; }
  get resumesAt(): string | null { return this.tripped ? new Date(this.until).toISOString() : null; }
}
```

## Edits in `src/db/client.ts`
Add optional instrumentation without changing `createDb(url)`'s signature or the `Db` type:
```ts
export interface DbInstruments { meter: EgressMeter; breaker: QuotaBreaker }
const instruments = new WeakMap<object, DbInstruments>();
export function dbInstruments(db: Db): DbInstruments | undefined { return instruments.get(db); }
```
In `createDb`, after building the pool and before `drizzle(...)`, instrument `pool.query` and each client from `pool.connect` (transactions and drizzle's sessions use checked-out clients, not `pool.query`):
```ts
function instrument(pool: pg.Pool | NeonPool, meter: EgressMeter, breaker: QuotaBreaker): void {
  const wrap = (target: { query: (...a: any[]) => any }): void => {
    const original = target.query.bind(target);
    target.query = (...args: any[]) => {
      if (typeof args[args.length - 1] === 'function') return original(...args); // callback style: untouched
      try { breaker.check(); } catch (e) { return Promise.reject(e); }
      const text = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
      const out = original(...args);
      if (!out || typeof out.then !== 'function') return out;
      return out.then(
        (res: { rows?: unknown[] }) => { meter.record(text, res?.rows); return res; },
        (err: unknown) => { if (isQuotaError(err)) breaker.trip(); throw err; },
      );
    };
  };
  wrap(pool as never);
  const connect = (pool as any).connect.bind(pool);
  (pool as any).connect = (...a: any[]) => {
    if (typeof a[0] === 'function') return connect(...a);
    return connect().then((client: any) => { if (!client.__metered) { client.__metered = true; wrap(client); } return client; });
  };
}
```
Call it only when `process.env.NOTESD_EGRESS_METER !== 'off'` (`off` keeps today's behaviour exactly, including no breaker). Register `instruments.set(db, { meter, breaker })` on the returned `db`. Clients are pooled and reused; the `__metered` flag prevents double wrapping. For the Neon websocket pool, `pool.connect()` returns a promise-style client; confirm in `tests/unit/db-client.test.ts` by extending it (a stub pool with `query` and `connect`). Keep type escapes (`any`) local to this function with a one-line comment; `Db` stays unchanged.

## Endpoint and logging
New `src/http/debugApi.ts`:
```ts
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import { dbInstruments } from '../db/client.js';
import { loopbackReadGuard } from './sessionsApi.js';

/** GET /api/debug/egress — rows and approximate bytes per query shape since the daemon started. Loopback only. */
export function debugApiRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.get('/api/debug/egress', loopbackReadGuard, (c) => {
    const ins = dbInstruments(deps.db);
    if (!ins) return c.json({ enabled: false });
    return c.json({ enabled: true, quota: { tripped: ins.breaker.tripped, resumes_at: ins.breaker.resumesAt }, ...ins.meter.snapshot() });
  });
  return r;
}
```
Mount in `src/http/app.ts` next to `sessionsApiRoutes` (`app.route('/', debugApiRoutes(deps))`, line ~117). In `src/background.ts` (end of `startBackground`) start `const egressTimer = setInterval(() => console.log(ins.meter.summaryLine()), 60 * 60_000); egressTimer.unref();` when instruments exist, and clear it in the returned stop function. Log the breaker transition once: in `QuotaBreaker.trip` callers' wrapper, `console.error('[notesd] Neon quota exceeded; pausing database queries for 30 min')` (log only when not already tripped).

Config: no new required env. Document `NOTESD_EGRESS_METER` (`off` disables meter and breaker) in `src/config.ts`'s env table comment block and `README.md` (HTTP API table row for `GET /api/debug/egress`, env table row, one paragraph "When Neon says quota exceeded").

## Tests
- `tests/unit/db-meter.test.ts`: `sqlLabel` truncation and whitespace, `record`/`snapshot` ordering by bytes, 0-row result costs 0 bytes, `summaryLine` format.
- `tests/unit/db-quota.test.ts`: `isQuotaError` true for `{ code: '53000', message: 'Your account or project has exceeded the quota…' }`, false for other 53xxx and for other errors; breaker trips, throws `QuotaExceededError` while tripped, passes after the cool-down (fake clock).
- Extend `tests/unit/db-client.test.ts`: instrumented stub pool — a successful query is recorded; a quota rejection trips the breaker and the next call rejects without invoking the underlying `query`; a transaction client from `connect()` is instrumented once.
- `tests/integration/egress.debug.int.test.ts`: run a few queries through the real app (`pg.Pool`), `GET /api/debug/egress` with a loopback Host returns `enabled: true` and a non-empty `top`; with a non-loopback Host header returns 403.

## Verification
```sh
npm run typecheck
npm test
npm run test:int
```
verify-notesd: start the throwaway daemon, load the wall and projects page, `curl http://127.0.0.1:<port>/api/debug/egress`, confirm the notes list query leads `top` by bytes.

## Exit criteria
Per-query rows/bytes visible at `/api/debug/egress` and in an hourly log line; a `53000` answer stops all further queries for 30 minutes with one log line; `NOTESD_EGRESS_METER=off` restores today's behaviour; all suites green; tree builds.
