# Phase 3: Seer web: twins on Leaderboard as Paper, never Today, rule 5 can't be run

**Plan set:** `SEER_ADVERSARIAL_PLAN.md`
**Analysis:** `/home/miftah/.worktrees/mcp-notes/seer-adversarial/.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Satisfies:** R3 — the owner sees every Claude twin on seertrade.site's Leaderboard, labelled Paper, right next to its original and in its colour; Today never shows one; the go-live checklist's fifth rule says a twin's backtest "Can't be run".
**Depends on:** Phase 1 (migration 027 adds `strategies.twin_of`). The web reads the column defensively, so it also works on a DB that has no 027 yet.
**Difficulty:** NORMAL
**Package:** seer `web/` (code root `/home/miftah/.worktrees/seer/seer-adversarial`, branch `feature/seer-adversarial`)

All paths below are relative to `/home/miftah/.worktrees/seer/seer-adversarial` unless they are absolute.
Line numbers are from seer `a6322d7`. Phase 1 does not touch `web/`, so they still hold after it lands.

---

## Goal

After this phase the Seer web app knows what a Claude twin is: a `strategies` row with `twin_of` set
(contract C2). The Leaderboard lists each twin right after its original. The twin's card uses the
original's colour, its chart line has its own dash, and it carries a Paper chip. Every card after it
keeps the colour it had before. The checklist's rule 5 reads "Backtest gate · Can't be run", and the
score lines explain why. A twin can never be the champion, so it never reaches Today, and its method
link goes to its original's Sera page. The demo seed has one twin (`F4-MOM12-N20-TREND-CX`), so
`verify-seer` can show all of this.

## Interface Contract

**Deletes:** none.
**Renames:** none.
**Creates:**
- `TwinIn`, `twinOfRow(raw)`, `attachedOriginal(st, byId)`, `orderTwins(rows)`, `TWIN_GATE`, `gateOf(raw, twinOf)` (`web/lib/strategy.ts`)
- `Gate.twin?: true` (optional field on the existing `Gate` type, `web/lib/strategy.ts`)
- `Strategy.twinOf: string | null` (`web/lib/data.ts`)
- `TWIN_DASHES`, `twinChipTip(originalShort)` (`web/app/(app)/leaderboard/view.ts`); `RosterIn.twinOf?: string | null`, `GateIn.twin?: true`
- `PaperChip` prop `tip?: string` (`web/components/PaperChip.tsx`)
- test files `web/components/PaperChip.test.tsx`; steps file `.claude/skills/verify-seer/features/steps/leaderboard-twin.mjs`
- demo row `F4-MOM12-N20-TREND-CX` (twin of `F4-MOM12-N20-TREND`) in `web/scripts/seed-demo.mjs`

**Signature changes:**
- `checksNews(id, specObject)` -> `checksNews(id, specObject, twinOf: string | null = null)` (the old two-argument calls still compile)
- `gateItem(gate)` and `scoreOf(items, gate)`: the signatures stay the same. A gate with `twin: true` gives new output.

**Requires (from earlier phases):**
- Phase 1: `strategies.twin_of text NULL REFERENCES strategies(id)` exists (C1). `seed-demo.mjs` inserts into it, so `verify-seer up` (which applies every migration and then seeds) needs 027. The app's SELECTs read it through `to_jsonb(s) ->> 'twin_of'`, so pages keep working on a DB that has no 027.
- Contract C2 (Phase 2 writes the rows): twin id `<ORIG>-CX`, `twin_of = <ORIG>`, name head `+Claude`, `is_champion = false`, `gate_applicable = false`, same `icon` as the original. The web does not depend on the id suffix or the name. It reads only `twin_of`.

**Leaves alone (owned by others):** `db/migrations/*` (Phase 1), `engine/**` including `paper/roster.py` `LAB_PROVENANCE` and `paper/compare.py` (Phases 1–2), `web/data/lab.json`, `web/lib/sera/*` (no change: the method link is chosen in the page), every mcp-notes file (Phases 4–7).

## Files

| File | Action | What changes |
|---|---|---|
| `web/lib/strategy.ts` | modify | `Gate.twin`, `TWIN_GATE`, `gateOf`, `twinOfRow`, `attachedOriginal`, `orderTwins`. `checksNews` returns false for a twin |
| `web/lib/strategy.test.ts` | modify | tests for the new helpers and for `checksNews` on a twin |
| `web/lib/data.ts` | modify | both `strategies` SELECTs read `twin_of` defensively. `Strategy.twinOf`. `toStrategy` makes a twin never champion, always paper, and gives it `TWIN_GATE`. Twins are ordered after their originals. `champion()` doc |
| `web/lib/metrics.ts` | modify | `gateItem`: a twin's rule 5 reads "Can't be run" |
| `web/lib/metrics.test.ts` | modify | twin rule-5 tests |
| `web/app/(app)/leaderboard/view.ts` | modify | `RosterIn.twinOf`, `TWIN_DASHES`, `looks()` gives a twin its original's colour, `GateIn.twin`, `scoreOf` twin lines, `twinChipTip` |
| `web/app/(app)/leaderboard/view.test.ts` | modify | tests for twin looks, scoreOf and chip tip |
| `web/app/(app)/leaderboard/page.tsx` | modify | Paper chip on twin cards (:250-265). Method link goes to the original (:74) |
| `web/components/PaperChip.tsx` | modify | optional `tip` prop |
| `web/components/PaperChip.test.tsx` | create | default and custom tip |
| `web/scripts/seed-demo.mjs` | modify | demo twin `F4-MOM12-N20-TREND-CX`, built last. `twin_of` in the INSERT |
| `.claude/skills/verify-seer/features/leaderboard.md` | modify | twin sub-feature and journeys |
| `.claude/skills/verify-seer/features/today.md` | modify | "a twin never reaches Today" journey |
| `.claude/skills/verify-seer/features/positions-history.md` | modify | switcher list includes the twin |
| `.claude/skills/verify-seer/features/steps/leaderboard-twin.mjs` | create | Playwright journey: order, colour, dash, chip, rule 5 |
| `.claude/skills/verify-seer/SKILL.md` | modify | one line: demo data now has a twin |

## Implementation Steps

Before the first web edit, run `cd web && npm ci` in the worktree (it has no `node_modules`). Then read
`web/node_modules/next/dist/docs/` as `web/AGENTS.md` requires. This phase uses no Next API that
the code does not already use (server components, `next/link`), so the read is a check, not a redesign.

### Step 1: Pure twin helpers and the twin gate
**File:** `web/lib/strategy.ts:7-51`
**Change:** Add an optional `twin` flag to `Gate` and add the twin helpers. `checksNews` gains a
third parameter that defaults to null. The whole file after the change:
**Code:**
```ts
// Pure helpers for `strategies` rows: engine, backtest gate, short label and Claude twins. No
// database access, so pages, metrics and tests can import them without a connection.

/** How a strategy trades (migration 003, `strategies.engine`). */
export type Engine = 'bracket' | 'book' | 'benchmark';

/**
 * `strategies.params->'backtest_gate'` (contract C2): did the strategy pass its backtest gate?
 * `applicable` is false only for a strategy the backtest item does not apply to (design §1 item 5:
 * C, an LLM strategy, cannot be backtested without look-ahead). Not applicable never counts as passed.
 *
 * `twin` marks the other reason a backtest cannot apply: a Claude twin (Seer Adversarial, contract
 * C2). Claude already knows how the past turned out, so no backtest of a twin can be honest. It is
 * only ever set by `TWIN_GATE`, which `gateOf` hands every row with `twin_of`. The stored jsonb is
 * never read for it, so a twin cannot carry a pass from anywhere.
 *
 * The verdict only. The prose `note` the engine used to ship alongside it is deliberately dropped
 * here and never reaches a payload or a page (owner, 2026-10-07): the checklist states the verdict,
 * and the reasoning behind it belongs on the method's own Sera page, one click from the pick's name.
 */
export type Gate = { passed: boolean; applicable: boolean; twin?: true };

const ENGINES: readonly string[] = ['bracket', 'book', 'benchmark'];

/** The row's engine. Rows written before migration 003 have none: benchmark when flagged, else bracket. */
export function engineOf(engine: unknown, isBenchmark: boolean): Engine {
  if (typeof engine === 'string' && ENGINES.includes(engine)) return engine as Engine;
  return isBenchmark ? 'benchmark' : 'bracket';
}

/**
 * Reads the gate from params. Missing or malformed reads as not passed and applicable: a pass is
 * never assumed, and only an explicit `applicable: false` marks the backtest item not applicable.
 * A `note` on the stored jsonb is ignored: rows written before 2026-10-07 still carry one, and
 * this is the boundary where it stops — nothing downstream can render what it never receives.
 */
export function parseGate(raw: unknown): Gate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { passed: false, applicable: true };
  const g = raw as Record<string, unknown>;
  const applicable = g.applicable !== false;
  return { passed: applicable && g.passed === true, applicable };
}

/** A Claude twin's gate: never passed, never applicable, and saying why. Frozen so no caller edits it. */
export const TWIN_GATE: Gate = Object.freeze({ passed: false, applicable: false, twin: true as const });

/**
 * The gate a row shows. For a twin it is `TWIN_GATE`, whatever `params` holds. A twin's params is
 * `'{}'` until its first paper night freezes the spec, and `parseGate('{}')` would read
 * "applicable, not passed", so for that one night the sheet would claim a backtest could still pass.
 */
export function gateOf(raw: unknown, twinOf: string | null): Gate {
  return twinOf !== null ? TWIN_GATE : parseGate(raw);
}

/** 'F4 · Momentum' -> 'F4', 'A · Quant' -> 'A', 'SPY' -> 'SPY'; the id when the name has no head. */
export function shortLabel(name: string, id: string): string {
  const head = name.split('·')[0].trim();
  return head === '' ? id : head;
}

/**
 * Does this strategy run the nightly news check (strategy C, handover D1/D6)? True when its frozen
 * spec names the C object, or for the roster id 'C' before `paper` has written a spec. Never for a
 * Claude twin: a twin's filter is Claude's verdicts, not C's news check, so Positions must not show
 * news-check rows under its orders even if its spec names an object C also uses.
 */
export function checksNews(id: string, specObject: unknown, twinOf: string | null = null): boolean {
  if (twinOf !== null) return false;
  return specObject === 'STRATEGY_C' || id === 'C';
}

/**
 * `strategies.twin_of` (migration 027): the ORIGINAL's id for a Claude twin, null for every other
 * row. Anything that is not a non-empty string reads as null. That includes the missing key on a
 * DB that has not applied 027 yet, so a bad read gives a plain strategy and never a phantom twin.
 */
export function twinOfRow(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** The fields the twin helpers read: a structural subset of `lib/data`'s `Strategy`. */
export type TwinIn = { id: string; twinOf?: string | null };

/**
 * The original `st` hangs off on this list, or null. It is null when `st` is not a twin, when its
 * original is not on the list (a twin shown without its original stands on its own), or when the
 * original is itself a twin. Contract C2 never makes a twin of a twin, and treating one as a plain
 * row keeps every list finite and every row in it.
 */
export function attachedOriginal<T extends TwinIn>(st: T, byId: Map<string, T>): T | null {
  if (st.twinOf === null || st.twinOf === undefined) return null;
  const o = byId.get(st.twinOf);
  return o !== undefined && (o.twinOf === null || o.twinOf === undefined) ? o : null;
}

/**
 * `rows` with each attached twin moved to sit directly after its original. Everything else keeps
 * its order, and nothing is added or dropped. Twins of the same original keep their own relative
 * order. Phase 2 gives a twin whatever `sort` it gives it, and the board must not depend on that:
 * "next to its original" is the owner's rule (decision 8), so the order is set here, once.
 */
export function orderTwins<T extends TwinIn>(rows: T[]): T[] {
  const byId = new Map(rows.map(r => [r.id, r]));
  const twinsOf = new Map<string, T[]>();
  for (const r of rows) {
    const o = attachedOriginal(r, byId);
    if (o) twinsOf.set(o.id, [...(twinsOf.get(o.id) ?? []), r]);
  }
  const out: T[] = [];
  for (const r of rows) {
    if (attachedOriginal(r, byId)) continue;
    out.push(r, ...(twinsOf.get(r.id) ?? []));
  }
  return out;
}
```
**Impact:** Additive. `parseGate` behaves the same, so its tests still pass. Existing two-argument
`checksNews` calls compile and give the same result.

### Step 2: Tests for the helpers
**File:** `web/lib/strategy.test.ts:2` (import) and new `describe` blocks after `:72` (end of the file)
**Change:** Widen the import, add one `checksNews` case to its existing describe, and append new describes.
**Code:** replace line 2 with:
```ts
import { attachedOriginal, checksNews, engineOf, gateOf, orderTwins, parseGate, shortLabel, TWIN_GATE, twinOfRow } from './strategy';
```
Inside `describe('checksNews', …)`, after the `'is false for every other strategy'` case, add:
```ts
  it('is never true for a Claude twin, whatever its spec names', () => {
    expect(checksNews('C-CX', 'STRATEGY_C', 'C')).toBe(false);
    expect(checksNews('A-GT-CX', 'STRATEGY_A', 'A-GT')).toBe(false);
    expect(checksNews('C', 'STRATEGY_C', null)).toBe(true);
  });
```
At the end of the file:
```ts
describe('twinOfRow', () => {
  it('reads the original id of a Claude twin', () => {
    expect(twinOfRow('RAW35-FR-GT')).toBe('RAW35-FR-GT');
  });
  it('reads anything else as not a twin, including a DB without migration 027', () => {
    expect(twinOfRow(null)).toBeNull();
    expect(twinOfRow(undefined)).toBeNull();
    expect(twinOfRow('')).toBeNull();
    expect(twinOfRow(42)).toBeNull();
  });
});

describe('gateOf', () => {
  it("gives a twin the twin gate, even when params say it passed or params are still '{}'", () => {
    expect(gateOf({ passed: true }, 'A-GT')).toEqual({ passed: false, applicable: false, twin: true });
    expect(gateOf(null, 'A-GT')).toBe(TWIN_GATE);
  });
  it('reads every other row exactly as parseGate does', () => {
    expect(gateOf({ passed: true }, null)).toEqual(parseGate({ passed: true }));
    expect(gateOf({ passed: false, applicable: false }, null)).toEqual({ passed: false, applicable: false });
    expect('twin' in gateOf({ passed: false }, null)).toBe(false);
  });
  it('cannot be edited by a caller', () => {
    expect(Object.isFrozen(TWIN_GATE)).toBe(true);
  });
});

describe('orderTwins', () => {
  const row = (id: string, twinOf: string | null = null) => ({ id, twinOf });

  it('puts each twin directly after its original, wherever the twin started', () => {
    const rows = [row('SPY'), row('A-GT-CX', 'A-GT'), row('A-GT'), row('RAW35'), row('C'), row('RAW35-CX', 'RAW35')];
    expect(orderTwins(rows).map(r => r.id)).toEqual(['SPY', 'A-GT', 'A-GT-CX', 'RAW35', 'RAW35-CX', 'C']);
  });
  it('leaves a list without twins exactly as it was', () => {
    const rows = [row('SPY'), row('A'), row('F4'), row('C')];
    expect(orderTwins(rows)).toEqual(rows);
  });
  it('keeps a twin whose original is not on the list where it was', () => {
    const rows = [row('SPY'), row('X-CX', 'X'), row('C')];
    expect(orderTwins(rows).map(r => r.id)).toEqual(['SPY', 'X-CX', 'C']);
  });
  it('never drops or duplicates a row, even for a twin of a twin', () => {
    const rows = [row('B-CX-CX', 'B-CX'), row('B'), row('B-CX', 'B')];
    const out = orderTwins(rows).map(r => r.id);
    expect(out).toHaveLength(3);
    expect(new Set(out)).toEqual(new Set(['B', 'B-CX', 'B-CX-CX']));
    expect(out.indexOf('B-CX')).toBe(out.indexOf('B') + 1);
  });
});

describe('attachedOriginal', () => {
  it('finds the original on the list, and nothing for a plain row', () => {
    const a = { id: 'A', twinOf: null }, t = { id: 'A-CX', twinOf: 'A' };
    const byId = new Map([[a.id, a], [t.id, t]]);
    expect(attachedOriginal(t, byId)).toBe(a);
    expect(attachedOriginal(a, byId)).toBeNull();
  });
});
```
**Impact:** Tests only. They run in `npm test`.

### Step 3: Read `twin_of`, and make the twin rules hold at the boundary
**File:** `web/lib/data.ts:5` (import), `:37-65` (`Strategy`), `:67-87` (`toStrategy`), `:89-109` (`strategies`), `:122-134` (`boardStrategies`), `:136-138` (`champion`)
**Change:** One row parser decides everything twin-related. A twin is never champion, is always
paper, gets `TWIN_GATE`, and never runs the news check. Each list is re-ordered so a twin follows its
original. Both SELECTs read `twin_of` through `to_jsonb(s) ->> 'twin_of'` so the app keeps working on
a DB without 027. This is the same trick `picks()` uses for migration 009's `evidence`, and it
matters because phase 7 pushes the web, which Vercel deploys at once, before it migrates Neon.
**Code:** line 5 becomes:
```ts
import { checksNews, engineOf, gateOf, orderTwins, shortLabel, twinOfRow, type Engine, type Gate } from '@/lib/strategy';
```
(`parseGate` is no longer imported here. `gateOf` calls it.)

Replace `:37-138` (from `export type Strategy = {` through the end of `champion()`) with:
```ts
export type Strategy = {
  id: string;
  name: string;
  sub: string;
  icon: string;
  /** Never true for a Claude twin, whatever the column says (see `toStrategy`). */
  isChampion: boolean;
  isBenchmark: boolean;
  /** 'bracket' (A, C), 'book' (F4, F1) or 'benchmark' (SPY). */
  engine: Engine;
  /** 'design-v0', 'monthly-hold'; null for SPY. */
  rulesId: string | null;
  /** First paper session; null until the engine's `paper` command starts the clock. */
  paperStart: string | null;
  /**
   * 'active' or 'retired' (migration 006). Retirement stops trading and keeps every snapshot,
   * order and trade: a retired strategy stays on the board, marked, and is never ranked.
   */
  status: StrategyStatus;
  /** Last paper session a retired strategy traded (migration 006); null while it is active. */
  paperEnd: string | null;
  /**
   * params->'backtest_gate', verdict only; { passed: false, applicable: true } until `paper` writes
   * the frozen spec. `TWIN_GATE` for a Claude twin, always.
   */
  gate: Gate;
  /** A research strategy: its orders and positions are paper only and never a buy recommendation. */
  isPaper: boolean;
  /** 'A', 'C', 'F4', 'F1', 'SPY': the part of the name before the middle dot. */
  short: string;
  /** Runs the nightly news check (C): Positions shows its verdicts under the paper orders. */
  checksNews: boolean;
  /**
   * The original's id when this row is a Claude twin (Seer Adversarial, migration 027, contract
   * C2): the same method, minus the picks Claude objected to before the session opened. Null for
   * every other row.
   */
  twinOf: string | null;
};

/**
 * The one place a `strategies` row becomes a `Strategy`, so the one place the twin rules are
 * enforced (owner decision 8: twins are Paper and never on Today). C2 already writes
 * `is_champion = false` for a twin. `isChampion` refuses one anyway, because Today shows whatever
 * `champion()` returns, and a hand edit or a bad promotion must not be able to put Claude's book in
 * front of real money. Everything downstream (Today, the crown, the Paper labels) trusts these
 * fields and checks nothing again.
 */
function toStrategy(r: Row): Strategy {
  const twinOf = twinOfRow(r.twin_of);
  const isBenchmark = r.is_benchmark === true;
  const isChampion = r.is_champion === true && twinOf === null;
  return {
    id: r.id,
    name: r.name,
    sub: r.sub,
    icon: r.icon,
    isChampion,
    isBenchmark,
    engine: engineOf(r.engine, isBenchmark),
    rulesId: r.rules_id ?? null,
    paperStart: ymdOrNull(r.paper_start),
    status: parseStatus(r.status),
    paperEnd: ymdOrNull(r.paper_end),
    gate: gateOf(r.gate, twinOf),
    isPaper: !isBenchmark && !isChampion,
    short: shortLabel(r.name, r.id),
    checksNews: checksNews(r.id, r.spec_object, twinOf),
    twinOf,
  };
}

export async function strategies(): Promise<Strategy[]> {
  // spec_object: the frozen spec wins where it exists, and `object_name` (migration 006) answers
  // for a strategy that has not been frozen yet — a just-promoted row has `params = '{}'` until
  // its first paper night, and without the COALESCE it would lose a display fact for a night.
  // twin_of: read through `to_jsonb(s)` rather than named, so the app keeps working on a DB that
  // has not applied migration 027. The key is then absent, the value is NULL and the row reads as
  // no twin. Naming the column would fail every page until the migration ran.
  const rows = await sql`SELECT id, name, sub, icon, is_champion, is_benchmark, engine, rules_id,
      paper_start::text AS paper_start, paper_end::text AS paper_end, status,
      params->'backtest_gate' AS gate,
      COALESCE(params->'spec'->>'object', object_name) AS spec_object,
      to_jsonb(s) ->> 'twin_of' AS twin_of
    FROM strategies s
    -- A retired strategy is not part of the app. The old rule kept one that had a paper_start,
    -- on the reasoning that its paper record was the evidence -- but paper_start marks the night
    -- an entry was CREATED, not a night it traded. Six entries retired by 017 had a start date and
    -- zero stepped sessions, so all they held was the day-0 snapshot; the leaderboard computed a
    -- return from that single unchanged point and rendered "+0.0% Total return" on 0 trades, which
    -- reads as a result and means "never ran". Owner's call, 2026-10-08: purge them.
    -- 018 deletes the rows as well, so this is the second of two locks: a future retirement can
    -- never put a stale card back on the board.
    WHERE status <> 'retired'
    ORDER BY sort, id`;
  // A twin sits right after its original in every list (owner decision 8: "next to their
  // originals"), whatever `sort` the engine gave it.
  return orderTwins(rows.map(toStrategy));
}

/**
 * The leaderboard's roster: every live strategy, then every retired one that actually TRADED.
 *
 * `strategies()` keeps a retired strategy out of the app, and for the rest of it that is right:
 * nothing retired has positions to place or picks to show. The leaderboard is the exception,
 * because a retired strategy that stepped paper sessions has a record, and the record is the
 * evidence (owner, 2026-10-17: keep each one reachable, folded away below the live ones).
 * `paper_end` is the test of "traded": the paper night stamps it with the last session the entry
 * stepped, and leaves it NULL for one that never started -- the day-0-only rows 018 purged, whose
 * "+0.0% on 0 trades" read as a result and meant "never ran". So that lock still holds.
 * Retiring an original retires its twin (C2), so on the shelf too a twin follows its original.
 */
export async function boardStrategies(): Promise<Strategy[]> {
  const [live, retired] = await Promise.all([
    strategies(),
    sql`SELECT id, name, sub, icon, is_champion, is_benchmark, engine, rules_id,
        paper_start::text AS paper_start, paper_end::text AS paper_end, status,
        params->'backtest_gate' AS gate,
        COALESCE(params->'spec'->>'object', object_name) AS spec_object,
        to_jsonb(s) ->> 'twin_of' AS twin_of
      FROM strategies s
      WHERE status = 'retired' AND paper_end IS NOT NULL
      ORDER BY sort, id`,
  ]);
  return [...live, ...orderTwins(retired.map(toStrategy))];
}

/** The champion Today shows. Never a Claude twin: `toStrategy` makes a twin's `isChampion` false. */
export async function champion(): Promise<Strategy | null> {
  return (await strategies()).find(s => s.isChampion) ?? null;
}
```
**Impact:** Every consumer of `Strategy` now gets `twinOf` (a required field). No other code or test
builds a `Strategy` literal (checked with `grep -rn "isPaper:\|checksNews:" web/app web/lib web/components`:
the only hits are in `data.ts`), so `tsc` stays green. Positions and History switchers also list a twin
after its original, and their existing `isPaper` Paper chips already label it.

### Step 4: Rule 5 for a twin
**File:** `web/lib/metrics.ts:44-52`
**Change:** `gateItem` returns "Can't be run" for a twin. It is still a verdict only, with exactly the
keys `label`, `val` and `ok` (the owner's 2026-10-07 rule). The explanation lives in the score lines
(Step 6), where a sheet already explains its score.
**Code:**
```ts
/**
 * The fifth rule: "Backtest gate passed", "Not applicable" for C (design §1 item 5), or "Can't be
 * run" for a Claude twin (Seer Adversarial: Claude already knows how the past turned out, so no
 * backtest of a twin is honest). Neither of the last two ever counts as passed. The verdict stands
 * alone: why a gate failed is the method's Sera page to tell, and why a twin's cannot run is the
 * score line's (`leaderboard/view.ts` `scoreOf`).
 */
export function gateItem(gate: Gate): CheckItem {
  if (gate.twin) return { label: 'Backtest gate', val: "Can't be run", ok: false };
  return gate.applicable
    ? { label: 'Backtest gate passed', val: gate.passed ? 'Passed' : 'Not passed', ok: gate.passed }
    : { label: 'Backtest gate', val: 'Not applicable', ok: false };
}
```
**Impact:** Changes output only for a gate with `twin: true`. The engine parity test
(`engine/tests/test_backtest_metrics.py:125`) compares only the four forward items and is not affected.

### Step 5: Rule-5 tests
**File:** `web/lib/metrics.test.ts:10` (after `NOT_APPLICABLE`) and inside the checklist describe after the `'builds the fifth rule on its own'` case (`:85-88`), and the `'carries no prose'` loop (`:93`)
**Code:** after line 9 (`const NOT_APPLICABLE = …`), add:
```ts
const TWIN = { passed: false, applicable: false, twin: true as const };
```
After the `'builds the fifth rule on its own'` case, add:
```ts
  it("reads \"Can't be run\" for a Claude twin and never counts it as passed", () => {
    expect(gateItem(TWIN)).toEqual({ label: 'Backtest gate', val: "Can't be run", ok: false });
    const items = checklist({ ...base, months: 18 }, 0.046, TWIN);
    expect(items).toHaveLength(CHECKLIST_RULES);
    expect(items[4]).toEqual({ label: 'Backtest gate', val: "Can't be run", ok: false });
    expect(items.filter(i => i.ok)).toHaveLength(4);
  });
  it('even a twin gate that claims a pass is not a pass', () => {
    expect(gateItem({ passed: true, applicable: true, twin: true }).ok).toBe(false);
  });
```
In `'carries no prose on any item…'`, change `for (const gate of [PASSED, FAILED, NOT_APPLICABLE])` to:
```ts
    for (const gate of [PASSED, FAILED, NOT_APPLICABLE, TWIN]) {
```
**Impact:** Tests only. `CHECKLIST_RULES` is already imported on line 2.

### Step 6: Leaderboard looks, score lines and chip tip for twins
**File:** `web/app/(app)/leaderboard/view.ts:16-21` (imports, `RosterIn`), `:47-87` (dashes, `looks`), `:400-426` (`GateIn`, `scoreOf`)
**Change:**
- `RosterIn` gains an optional `twinOf`.
- `looks()` gives palette colours only to originals. A twin takes its original's sheet, tint and line,
  with a dash from `TWIN_DASHES` for the original's lap, and never moves the palette index. So every
  later card keeps the colour it had before twins existed.
- `scoreOf` explains a twin's score.
- `twinChipTip` is the Paper chip's tooltip.
**Code:** add after line 18 (`import type { MonthlyTable } …`):
```ts
import { attachedOriginal } from '../../../lib/strategy';
```
Replace line 21:
```ts
/**
 * The roster fields these helpers read (a structural subset of lib/data's Strategy). `twinOf` is
 * optional so a fixture without twins still type-checks; lib/data always sets it.
 */
export type RosterIn = { id: string; isChampion: boolean; isBenchmark: boolean; twinOf?: string | null };
```
Replace `:47-87` (from the `LAP_DASHES` doc comment through the end of `looks`) with:
```ts
/** Stroke patterns per lap of the palette: solid, then dashed. SPY's dotted '1 4' is not among them. */
export const LAP_DASHES = [null, '7 5'] as const;

/**
 * A Claude twin's stroke, by its original's lap: short even dashes, then dash-dot. Neither is a
 * lap dash or SPY's dotted '1 4', so a twin's line never equals any original's, and the pair
 * "same colour, different dash" reads as "this one, with Claude".
 */
export const TWIN_DASHES = ['3 3', '10 3 2 3'] as const;

/** Research strategies before any line repeats. */
export const LOOK_PERIOD = CARD_BGS.length * LAP_DASHES.length;

/**
 * `bg` is the sheet class; `tint` is the same colour as a CSS value, for surfaces that borrow it;
 * `dash` is the line's stroke-dasharray, null for a solid line.
 */
export type Look = { bg: string; tint: string; line: string; width: number; dash: string | null };

/** 'bg-lav' -> 'lav': every sheet class in globals.css is a one-token background. */
const tokenOf = (bg: string): string => bg.slice(3);

export const LOOK_FALLBACK: Look = { bg: 'bg-sheet', tint: 'var(--sheet)', line: 'var(--ink-2)', width: 2, dash: null };

/** SPY's stroke: the benchmark is the dotted line on a plain sheet. */
export const BENCHMARK_DASH = '1 4';

/**
 * Card sheet and chart line per strategy id, by roster order.
 *
 * A Claude twin whose original is on the roster takes no palette slot. It wears its original's
 * sheet, tint and line, with a `TWIN_DASHES` stroke and the ordinary width (a twin is never
 * champion). Because it takes no slot, adding twins moves no other strategy's colour: the owner
 * keeps reading F1 as sage and C as rose. The result does not depend on where the twin sits in
 * `roster`. A twin whose original is absent is coloured like any other strategy.
 */
export function looks(roster: RosterIn[]): Map<string, Look> {
  const out = new Map<string, Look>();
  const byId = new Map(roster.map(st => [st.id, st]));
  const originalOf = (st: RosterIn): RosterIn | null => {
    const o = attachedOriginal(st, byId);
    return o && !o.isBenchmark ? o : null;
  };
  const lapOf = new Map<string, number>();
  let i = 0;
  for (const st of roster) {
    if (st.isBenchmark) {
      out.set(st.id, { bg: 'bg-sheet', tint: 'var(--sheet)', line: 'var(--ink-3)', width: 1.75, dash: BENCHMARK_DASH });
      continue;
    }
    if (originalOf(st)) continue;
    const t = tokenOf(CARD_BGS[i % CARD_BGS.length]);
    const lap = Math.floor(i / CARD_BGS.length) % LAP_DASHES.length;
    out.set(st.id, {
      bg: `bg-${t}`,
      tint: `var(--${t})`,
      line: `var(--${t}-line)`,
      width: st.isChampion ? 2.75 : 2,
      dash: LAP_DASHES[lap],
    });
    lapOf.set(st.id, lap);
    i += 1;
  }
  for (const st of roster) {
    const o = st.isBenchmark ? null : originalOf(st);
    const base = o ? out.get(o.id) : undefined;
    if (!o || !base) continue;
    out.set(st.id, { ...base, width: 2, dash: TWIN_DASHES[lapOf.get(o.id) ?? 0] });
  }
  return out;
}
```
Replace `:400-426` (from `/** The gate fields the score reads …` through the end of `scoreOf`) with:
```ts
/** The gate fields the score reads (a structural subset of lib/strategy's Gate). */
/** `twin?: true`, exactly as `Gate`, so a GateIn still passes where `checklist` wants a Gate. */
export type GateIn = { passed: boolean; applicable: boolean; twin?: true };

/** A strategy with no checklist yet: not passed, applicable. */
export const NO_GATE: GateIn = { passed: false, applicable: true };

/**
 * The checklist score and its two-line verdict. Never "Ready for real money" unless every rule
 * passes, and never for a strategy whose backtest item is not applicable (C, handover D9, or a
 * Claude twin): real money for it would need an explicit owner decision even if the four forward
 * rules pass. A twin's lines say why its backtest cannot run, in the owner's words (brief §4.1):
 * Claude already knows how the past turned out.
 *
 * `items.length === CHECKS` is load-bearing and stays. `page.tsx` passes `items = []` for a
 * strategy with no gate row at all; a denominator of `items.length` would render that as 0/0 and
 * let a missing checklist read like a passing one. A fixed denominator makes it 0/5, "Paper only".
 */
export function scoreOf(items: { ok: boolean }[], gate: GateIn): Score {
  const passed = items.filter(i => i.ok).length;
  const ready = !gate.twin && gate.applicable && items.length === CHECKS && passed === CHECKS;
  const lines: [string, string] = gate.twin
    ? ['Paper only. No backtest possible.', 'Claude knows how the past turned out']
    : !gate.applicable
      ? ['Paper only. No backtest gate.', 'Real money needs an owner decision']
      : ready
        ? [`${ALL_CAP} pass.`, 'Ready for real money']
        : gate.passed
          ? ['Paper trading until', `${ALL} pass`]
          : ['Paper only.', 'Backtest gate not passed'];
  return { passed, total: CHECKS, ready, lines };
}

/**
 * The Paper chip's tooltip on a twin's card: which method it shadows, and what it is, in plain
 * words (CLAUDE.md: no ids or code in owner-facing text). `originalShort` is the original's short
 * label, or null when the original is not on the board.
 */
export function twinChipTip(originalShort: string | null): string {
  const of = originalShort ? `${originalShort}'s method` : 'the same method';
  return `Claude twin: ${of}, minus the picks Claude objected to. Paper only, no real money.`;
}
```
**Impact:** Without twins, `looks` gives exactly the same output as before (the existing `looks`
tests pin that). `scoreOf` changes only for `twin: true`. `TWIN_DASHES` and `twinChipTip` are new exports.

### Step 7: View tests for twins
**File:** `web/app/(app)/leaderboard/view.test.ts:4-8` (import) and new cases at the end of `describe('looks', …)` (`:68`) and `describe('scoreOf', …)` (`:341`)
**Code:** in the import from `'./view'`, add `TWIN_DASHES` and `twinChipTip` to the list:
```ts
import {
  CHECKS, compare, LOOK_PERIOD, looks, MIN_COMMON_SESSIONS, MIN_RANKED, monthLabel, monthLines,
  NO_GATE, pickResearch, researchOf, retiredLabel, scoreOf, sinceStartLine, spyOverSpan,
  TWIN_DASHES, twinChipTip, windowLine, type GateIn, type RankIn, type RosterIn,
} from './view';
```
At the end of `describe('looks', …)` (before its closing `});`), add:
```ts
  // Seer Adversarial: a Claude twin wears its original's colour with its own dash, and takes no
  // palette slot, so every card after it keeps the colour it had before twins existed.
  const F4_TWIN: RosterIn = { id: 'F4-MOM12-N20-TREND-CX', isChampion: false, isBenchmark: false, twinOf: 'F4-MOM12-N20-TREND' };
  const withTwin: RosterIn[] = [roster[0], roster[1], roster[2], F4_TWIN, roster[3], roster[4]];

  it("gives a twin its original's sheet, tint and line, with a twin dash", () => {
    const l = looks(withTwin);
    const f4 = l.get('F4-MOM12-N20-TREND')!;
    expect(l.get(F4_TWIN.id)).toEqual({ ...f4, dash: TWIN_DASHES[0] });
    expect(f4.dash).toBeNull();
  });
  it('moves no other strategy: later cards keep their colours', () => {
    const before = looks(roster), after = looks(withTwin);
    for (const id of RESEARCH) expect(after.get(id)).toEqual(before.get(id));
    expect(after.get('SPY')).toEqual(before.get('SPY'));
  });
  it('does not depend on where the twin sits in the roster', () => {
    const first = looks([F4_TWIN, ...roster]);
    expect(first.get(F4_TWIN.id)).toEqual(looks(withTwin).get(F4_TWIN.id));
    expect(first.get('A')!.bg).toBe('bg-lav');
  });
  it('colours a twin whose original is not on the roster like any other strategy', () => {
    const l = looks([roster[0], { id: 'X-CX', isChampion: false, isBenchmark: false, twinOf: 'X' }]);
    expect(l.get('X-CX')).toEqual({ bg: 'bg-lav', tint: 'var(--lav)', line: 'var(--lav-line)', width: 2, dash: null });
  });
  it("never emphasises a twin, even when its original is champion", () => {
    const l = looks([{ ...roster[1], isChampion: true }, { id: 'A-CX', isChampion: false, isBenchmark: false, twinOf: 'A' }]);
    expect(l.get('A')!.width).toBe(2.75);
    expect(l.get('A-CX')!.width).toBe(2);
  });
  it('never gives a twin the line of any original or of SPY, up to LOOK_PERIOD originals each with a twin', () => {
    const originals: RosterIn[] = Array.from({ length: LOOK_PERIOD }, (_, i) => ({ id: `S${i}`, isChampion: false, isBenchmark: false }));
    const twins: RosterIn[] = originals.map(o => ({ id: `${o.id}-CX`, isChampion: false, isBenchmark: false, twinOf: o.id }));
    const l = looks([roster[0], ...originals, ...twins]);
    const all = [...originals, ...twins].map(st => `${l.get(st.id)!.line}|${l.get(st.id)!.dash}`);
    expect(new Set(all).size).toBe(LOOK_PERIOD * 2);
    expect(l.get('S6-CX')!.dash).toBe(TWIN_DASHES[1]);
    for (const t of twins) expect(l.get(t.id)!.dash).not.toBe('1 4');
  });
```
At the end of `describe('scoreOf', …)` (before its closing `});`), add:
```ts
  it("says a twin's backtest cannot be run, and why, and is never ready", () => {
    const TWIN = { passed: false, applicable: false, twin: true as const };
    const sc = scoreOf(checks(STRONG, TWIN), TWIN);
    expect(sc).toEqual({
      passed: 4, total: CHECKS, ready: false,
      lines: ['Paper only. No backtest possible.', 'Claude knows how the past turned out'],
    });
    // A malformed twin gate that claims a pass is still not ready.
    expect(scoreOf(checks(STRONG, PASSED), { passed: true, applicable: true, twin: true }).ready).toBe(false);
  });
```
At the end of the file:
```ts
describe('twinChipTip', () => {
  it("names the original's method in plain words", () => {
    expect(twinChipTip('F4')).toBe("Claude twin: F4's method, minus the picks Claude objected to. Paper only, no real money.");
  });
  it('still reads when the original is not on the board', () => {
    expect(twinChipTip(null)).toBe('Claude twin: the same method, minus the picks Claude objected to. Paper only, no real money.');
  });
});
```
**Impact:** Tests only.

### Step 8: PaperChip takes a tooltip
**File:** `web/components/PaperChip.tsx:1-17`
**Code:** the whole file:
```tsx
import { FlaskConical } from 'lucide-react';
import s from './PaperChip.module.css';

const TIP = 'Paper trade: simulated, no real money';

/**
 * Marks a research strategy's position, order or trade as paper (D3). A data label, not a
 * button. Dashed like the design's empty slots: it is not a real holding. `tip` replaces the
 * default tooltip where the chip has more to say. On a Leaderboard card it marks a Claude twin
 * and names the method the twin shadows.
 */
export function PaperChip({ size = 'md', tip = TIP }: { size?: 'sm' | 'md'; tip?: string }) {
  return (
    <span className={size === 'sm' ? s.sm : s.md} data-tip={tip}>
      <FlaskConical size={size === 'sm' ? 12 : 15} strokeWidth={1.75} aria-hidden="true" />
      Paper
    </span>
  );
}
```
**File:** `web/components/PaperChip.test.tsx` (create)
```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaperChip } from './PaperChip';

describe('PaperChip', () => {
  it('reads Paper with the default tooltip', () => {
    const html = renderToStaticMarkup(<PaperChip size="sm" />);
    expect(html).toContain('>Paper</span>');
    expect(html).toContain('data-tip="Paper trade: simulated, no real money"');
    // The flask is decoration; the word carries the meaning.
    expect(html).toContain('aria-hidden="true"');
  });
  it('carries a caller tooltip instead, and still reads Paper', () => {
    const html = renderToStaticMarkup(<PaperChip size="sm" tip="Claude twin of F4" />);
    expect(html).toContain('data-tip="Claude twin of F4"');
    expect(html).toContain('>Paper</span>');
  });
});
```
**Impact:** Positions and History keep the default tip (they pass no `tip`).

### Step 9: Leaderboard page: Paper chip on twin cards, method link to the original
**File:** `web/app/(app)/leaderboard/page.tsx:6` (imports), `:16-20` (view import), `:74` (`seeMethod`), `:228-236` (card locals), `:250-265` (chips)
**Change:**
1. Imports: after line 6 (`import { strategyIcon } …`), add
   ```tsx
   import { PaperChip } from '@/components/PaperChip';
   ```
   and add `twinChipTip` to the `./view` import list (`:16-20`):
   ```tsx
   import {
     BENCHMARK_DASH, compare, LOOK_FALLBACK, looks, MIN_COMMON_SESSIONS, monthLines, NO_GATE, pickResearch,
     researchOf, retiredLabel, scoreOf, sinceStartLine, spyOverSpan, twinChipTip, windowLine,
     type CompareRow, type Look, type MonthLine,
   } from './view';
   ```
2. Line 74 becomes (a twin runs its original's method, so its name links to the original's Sera
   page. A twin is no lab method of its own, so `methodHref(twin id)` would always be null):
   ```tsx
     // A Claude twin runs its original's method with Claude's objections taken out, so its name
     // opens the original's method page; the twin has no lab method of its own.
     const seeMethod = pick && isSeraUser(user?.email) ? methodHref(pick.twinOf ?? pick.id) : null;
   ```
3. After line 40 (`const lookOf = …`), add the short-label lookup the chip tip needs:
   ```tsx
     const shortOf = new Map(roster.map(st => [st.id, st.short]));
   ```
4. Replace the chips span `:250-265` with:
   ```tsx
                 <span className={s.chips}>
                   {st.isChampion && <span data-tip="Champion" aria-label="Champion" role="img" className={`${s.crown} desk-only`}><Crown size={20} /></span>}
                   {st.twinOf !== null && <PaperChip size="sm" tip={twinChipTip(shortOf.get(st.twinOf) ?? null)} />}
                   {retired && (
                     <span className={`chip ${s.retired}`}
                       data-tip="Retired: it stopped trading and keeps its whole record">
                       <Archive size={14} strokeWidth={1.75} aria-hidden="true" />
                       {retiredLabel(st.paperEnd)}
                     </span>
                   )}
                   {cr?.status === 'insufficient' && (
                     <span className={`chip ${s.unranked}`}
                       data-tip={`Not ranked: fewer than ${MIN_COMMON_SESSIONS} sessions shared with the others`}>
                       Not ranked
                     </span>
                   )}
                 </span>
   ```
   The update to the comment on line 249 reads:
   `{/* Desktop: the status line under the code — champion, Claude twin (Paper), retired, not ranked. */}`
**Impact:** Only twin cards gain a chip. Card order, chart, legend and switch come from
`board.rows`, which is already twin-ordered (Step 3), and from `looks` (Step 6). The checklist sheet gets
`gate = TWIN_GATE` from the row, so Steps 4 and 6 render rule 5 and the score lines with no page
change. `compare()` is unchanged: a twin with enough shared sessions is ranked like any paper strategy,
as `python -m seer_engine compare` also does (see Handoffs).

### Step 10: Demo seed gets a twin
**File:** `web/scripts/seed-demo.mjs:1-10` (header), insert a block before `:326` (`const rows = …`), `:356-362` (strategies INSERT)
**Change:** Add F4's Claude twin. It is built **after every other row has drawn from `rnd()`**, so no
existing demo number moves (the feature map quotes them). It holds F4's book minus the two names
Claude "objected to" (BAC, CCL), re-weighted pro rata (12 names at 5% become 10 at 6%), on F4's own
clock. Its gate jsonb is C2's twin gate.
**Code:** in the header comment, replace lines 7-8
(`// Needs migrations through 009 applied first … (`evidence` on orders, book_targets and book_previews).`) with:
```js
// Needs every migration applied first (`npm run db:migrate`): 004 (news_vetoes, the C row's
// columns), 008 (book_previews), 009 (`evidence` on orders, book_targets and book_previews) and
// 027 (`strategies.twin_of`, for F4's Claude twin F4-MOM12-N20-TREND-CX, Seer Adversarial).
```
Insert immediately before `const rows = { strategies, …` (line 326):
```js
// --- F4+Claude: F4's Claude twin (Seer Adversarial, contract C2) -----------------
// Built last, after every other row has drawn from `rnd()`, so adding it moves no other strategy's
// demo numbers. The same book as F4 minus the two names Claude objected to at the last decision
// (BAC, CCL), the rest re-weighted pro rata (12 at 5% -> 10 at 6%), on F4's own clock. Paper only:
// the web never makes a twin champion, so it never reaches Today.
{
  const id = 'F4-MOM12-N20-TREND-CX';
  strategies.push({
    id, twinOf: 'F4-MOM12-N20-TREND', name: 'F4+Claude · Momentum', sub: 'Top 20 by 12-1 momentum, monthly', icon: 'trending-up',
    champion: false, benchmark: false, sort: 3, engine: 'book', rulesId: 'monthly-hold', paperStart: PAPER_START,
    params: { demo: true, spec: { engine: 'book', object: 'FACTOR', registry_id: 'F4-MOM12-N20-TREND', rules_id: 'monthly-hold' }, digest: null,
      backtest_gate: { passed: false, applicable: false, note: 'Claude twin: no backtest is possible, Claude already knows how the past turned out.' } },
  });
  const eq = curve(0.024, 3.1, FIRST_DECISION);
  const E = eq[LAST];
  // [symbol, mark, held since the first decision?]: F4's HELD without BAC and CCL.
  const HELD = [['INTC', 36.42, true], ['PFE', 25.08, false], ['F', 11.31, true], ['T', 27.64, true],
    ['WBD', 12.37, true], ['KMI', 27.93, false], ['HPE', 22.46, true], ['CMCSA', 32.81, false], ['CSX', 33.57, true],
    ['HBAN', 16.72, true]];
  let invested = 0;
  for (const [sym, mark, early] of HELD) {
    const from = early ? FIRST_DECISION : LAST_DECISION;
    const entry = r2(mark / (1 + (rnd() - 0.4) * 0.15));
    const shares = Math.max(1, Math.floor((0.06 * E) / mark));
    invested += shares * mark;
    bookPositions.push([id, sym, shares, mark, sessions[from], entry, LAST - from + 1, r4(shares * entry * (1 + FEE)), 0, null, null, false]);
  }
  const cashShare = Math.max(0, 1 - invested / E);
  eq.forEach((e, i) => snapshots.push([id, sessions[i], i < FIRST_DECISION ? e : r4(e * cashShare), e]));
  paperState.push([id, r4(E - invested), E, pendingDecision]);
}

```
Replace the strategies INSERT `:356-362` with (the twin is pushed last, so its original is already
inserted when the `twin_of` foreign key is checked):
```js
  for (const s of strategies)
    await c.query(`INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, sort, engine, rules_id, paper_start, params,
        object_name, registry_id, gate_note, gate_applicable, twin_of)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [s.id, s.name, s.sub, s.icon, s.champion, s.benchmark, s.sort, s.engine, s.rulesId, s.paperStart, JSON.stringify(s.params),
      s.engine === 'benchmark' ? 'buy_and_hold' : s.params.spec.object, s.params.spec.registry_id ?? null, s.params.backtest_gate.note,
      s.params.backtest_gate.applicable !== false, s.twinOf ?? null]);
```
**Impact:** The demo now has six strategies besides SPY's benchmark row: five research strategies plus
one twin. `npm run db:seed-demo` against a DB without 027 now fails on the unknown column. That is
intended, because the header says to migrate first, and `verify-seer up` always migrates before it seeds.

### Step 11: Feature map, steps file and skill line
**File:** `.claude/skills/verify-seer/features/steps/leaderboard-twin.mjs` (create)
```js
// Seer Adversarial (phase 3): F4's Claude twin sits right after F4, in F4's colour with its own
// dash, labelled Paper; F1 and C keep their colours; the twin's checklist says its backtest can't
// be run. Run on `up` demo data: `$V ui RUN .claude/skills/verify-seer/features/steps/leaderboard-twin.mjs`.
const TWIN = 'F4-MOM12-N20-TREND-CX';
const card = id => `a[href="/leaderboard?s=${encodeURIComponent(id)}"]`;

export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/leaderboard', { waitUntil: 'networkidle' });
  const order = await page.locator('a[href^="/leaderboard?s="][data-status]').evaluateAll(
    els => els.map(e => decodeURIComponent(new URL(e.href).searchParams.get('s'))));
  const at = order.indexOf('F4-MOM12-N20-TREND');
  if (at < 0 || order[at + 1] !== TWIN) throw new Error(`twin is not right after F4: ${order.join(', ')}`);
  log(`card order: ${order.join(', ')}`);

  const cls = async id => (await page.locator(card(id)).first().getAttribute('class')) ?? '';
  const want = { 'F4-MOM12-N20-TREND': 'bg-sky', [TWIN]: 'bg-sky', 'F1-SPY-SMA200-M': 'bg-sage', C: 'bg-rose', A: 'bg-lav' };
  for (const [id, bg] of Object.entries(want)) {
    if (!(await cls(id)).split(/\s+/).includes(bg)) throw new Error(`${id} card is not ${bg}: ${await cls(id)}`);
  }
  log('colours: A lav, F4 sky, F4+Claude sky, F1 sage, C rose (F1 and C unchanged by the twin)');

  const sky = await page.locator('svg path[stroke="var(--sky-line)"]').evaluateAll(
    els => els.map(e => e.getAttribute('stroke-dasharray')));
  if (sky.length !== 2 || !sky.includes(null) || !sky.includes('3 3')) throw new Error(`sky lines: ${JSON.stringify(sky)}`);
  log('chart: two sky lines, F4 solid and its twin dashed 3 3');

  const chip = page.locator(card(TWIN)).getByText('Paper', { exact: true });
  await chip.first().waitFor();
  if ((await page.locator(card('F4-MOM12-N20-TREND')).getByText('Paper', { exact: true }).count()) !== 0)
    throw new Error('the original carries a Paper chip; only twins do');
  log('Paper chip on the twin card only');
  await shot('board');

  await page.locator(card(TWIN)).first().click();
  await page.waitForURL(u => u.searchParams.get('s') === TWIN);
  await page.getByText("Can't be run").first().waitFor();
  await page.getByText('Paper only. No backtest possible.').first().waitFor();
  await page.getByText('Claude knows how the past turned out').first().waitFor();
  await shot('twin-checklist');
  log("picking the twin: checklist rule 5 reads Backtest gate · Can't be run, with the reason");
};
```
**File:** `.claude/skills/verify-seer/features/leaderboard.md` (replace the whole file)
```markdown
# Leaderboard

## Sub-features

- Equity curves of every active strategy against SPY over the window they share, with the champion crowned.
- The go-live checklist (design §1): 18 months forward, beats SPY, profit factor ≥ 1.3, max drawdown ≤ 25%, backtest gate. Each row shows Passed / Not yet with the measured number.
- Per-strategy cards and the month-by-month table.
- Claude twins (Seer Adversarial): a twin's card sits right after its original's, in the original's colour, with a `Paper` chip; its chart line is the original's colour with its own dash (`3 3`). Cards after it keep their colours. The twin's checklist reads rule 5 as `Backtest gate · Can't be run`, with "Paper only. No backtest possible. Claude knows how the past turned out". Its name links to the original's Sera method page.
- The same ranking from the engine: `compare`.

## How to get to it (user POV)

Third icon (trophy). The checklist switches strategy with its own icon row. A twin is the card named `<original>+Claude`, e.g. `F4+Claude`.

## Driving it with verify.sh

```sh
$V up
$V api RUN GET /leaderboard     # "Forward test Aug 3 – Nov 2", "+5.3% SPY , champion", "+2.6% Best · F1",
                                # "66 Sessions", "Go-live checklist · A · Quant", "1 / 5 Paper only.",
                                # "[Not yet] Profit factor ≥ 1.3 0.78", "[Passed] Max drawdown ≤ 25% 7.9%";
                                # the cards read "F4 · Momentum" then "F4+Claude · Momentum Paper" then "F1 · Trend"
$V api RUN GET '/leaderboard?s=F4-MOM12-N20-TREND-CX'
                                # "Go-live checklist · F4+Claude · Momentum", "Paper only. No backtest possible.",
                                # "Claude knows how the past turned out", "[Not yet] Backtest gate Can't be run"
$V ui RUN .claude/skills/verify-seer/features/steps/leaderboard-twin.mjs   # order, colours, dash, chip, rule 5; result: PASS
$V sql RUN "select id, twin_of, is_champion from strategies where twin_of is not null"
                                # F4-MOM12-N20-TREND-CX | F4-MOM12-N20-TREND | f
$V engine RUN compare           # common window 2026-08-03..2026-11-02, 66 sessions; ranks by Sharpe, the twin among them;
                                # C "not ranked: 29 sessions of its own"
$V shoot RUN --theme light --width 1280 /leaderboard
$V shoot RUN --theme dark --width 390 /leaderboard '/leaderboard?s=F4-MOM12-N20-TREND-CX'
```

The page and `compare` must agree on the order: both rank by Sharpe, which is why F1 (+2.6%) is "best" ahead of F4 (+3.1%).

## Gotchas

- The checklist's drawdown bar (25%) is mirrored from the engine and pinned by a test. A change to it is a dated owner revision (CLAUDE.md), never something a verify run should "fix".
- `compare` reads the run's DB, so it works on demo data. `paper_check` runs on demo data but cannot replay it (see engine-night.md).
- A twin is ranked like any paper strategy once it shares enough sessions; it is never crowned (the web refuses `is_champion` on a row with `twin_of`).
- The demo twin is built after every other demo row, so it moves none of the numbers above. Read the PNGs: F4 and F4+Claude are both sky; F1 sage and C rose, as before twins.
- A twin's legend swatch is dashed like a second-lap original's. Its label (`F4+Claude`) is what tells them apart.
```
**File:** `.claude/skills/verify-seer/features/today.md`
Add this bullet at the end of `## Sub-features`:
```markdown
- A Claude twin (Seer Adversarial) is never the champion, so it never shows on Today, even if its row is flagged champion.
```
Add this block after the `$V sql RUN "select o.symbol, d.order_id …"` line pair, inside the sh fence:
```sh

$V up --champion=F4-MOM12-N20-TREND-CX   # flags F4's Claude twin as champion in the demo DB
$V api RUN GET /                          # "No champion yet." "Seer recommends no buys." — never "F4+Claude"
$V sql RUN "select id from strategies where is_champion"   # F4-MOM12-N20-TREND-CX (the row says champion; the web refuses it)
```
Add this bullet under `## Gotchas`:
```markdown
- `--champion=<twin id>` is the only way to test the twin guard: the engine never writes `is_champion` on a twin (contract C2), and the web refuses it anyway.
```
**File:** `.claude/skills/verify-seer/features/positions-history.md:5`
Replace the switcher list `(`SPY`, `A · Quant`, `F4 · Momentum`, `F1 · Trend`, `C · News veto` on demo data)` with
``(`SPY`, `A · Quant`, `F4 · Momentum`, `F4+Claude · Momentum`, `F1 · Trend`, `C · News veto` on demo data; a Claude twin sits right after its original and carries the `Paper` label)``.
In `## Driving it with verify.sh`, after the `'/positions?s=F4-MOM12-N20-TREND'` line, add:
```sh
$V api RUN GET '/positions?s=F4-MOM12-N20-TREND-CX'   # "Unrealized P/L F4+Claude · Momentum", "10 Open", "Paper"
```
In `## Gotchas`, add `F4-MOM12-N20-TREND-CX` to the `?s=` id list.
**File:** `.claude/skills/verify-seer/SKILL.md`, under "What a run is", in the Postgres bullet:
replace `five paper strategies over 66 sessions` with
`five paper strategies and F4's Claude twin (F4-MOM12-N20-TREND-CX) over 66 sessions`.
**Impact:** Documentation and a reusable journey. The README index rows stay correct (same files, same surfaces).

## Principles applied

- Boundary discipline: `twin_of` is parsed once (`twinOfRow`) in `toStrategy`. That is also where the twin rules live: never champion, always paper, `TWIN_GATE`, no news check. Today, the crown, `gateItem` and `scoreOf` trust those fields and re-check nothing. The scope suggested guarding `champion()` itself; the guard moved into `isChampion` instead, so the crown and the chart emphasis are covered too.
- Make illegal states unrepresentable: a twin's gate cannot come from stored params. `gateOf` returns the frozen `TWIN_GATE` for any row with `twin_of`, so a twin can never show "Backtest gate passed", not even on the night before its spec is frozen (`params = '{}'`, which `parseGate` reads as applicable). The full discriminated-union `Gate` was rejected because it would retype every existing test fixture. That trade-off is noted in the `Gate` doc.
- Laziness protocol: twin ordering is one pure helper (`orderTwins`) applied where the lists are built, not per page. `compare()` and `methodHref`/`lib/sera/paper.ts` are left unchanged. The method link is a one-line `pick.twinOf ?? pick.id` in the page, and `PaperChip` gains one prop instead of a new chip component.
- Prove it works: Proof drives the real pages on a throwaway demo DB (`verify-seer`). That includes `--champion=<twin>` to hit the real Today guard, and a Playwright journey that reads card classes and chart dash attributes instead of trusting the diff.
- Test behavior, not implementation: the new tests assert what the owner sees (rule-5 text, score lines, colours of the other cards, card order), not how the helpers do it.

## Verification

**Build:** `cd /home/miftah/.worktrees/seer/seer-adversarial/web && npm ci && npx tsc --noEmit`
**Tests:** `cd /home/miftah/.worktrees/seer/seer-adversarial/web && npm test` (all green, including the new cases in `lib/strategy.test.ts`, `lib/metrics.test.ts`, `app/(app)/leaderboard/view.test.ts` and `components/PaperChip.test.tsx`). Engine mirror tests are untouched; confirm with `engine/.venv/bin/pytest engine/tests/test_backtest_metrics.py engine/tests/test_dev_trades_bar.py -q` (`PG_TEST_URL` not needed for these).
**Proof:**
- Harness: `.claude/skills/verify-seer` (`V=.claude/skills/verify-seer/scripts/verify.sh`, run from `/home/miftah/.worktrees/seer/seer-adversarial`). It needs phase 1's `db/migrations/027_*.sql` in the checkout (`up` applies every migration, and the seed inserts `twin_of`).
- Feature-map entries: `features/leaderboard.md`, `features/today.md`, `features/positions-history.md`
- Journeys:
  1. **Twin on the Leaderboard, next to F4, as Paper, in F4's colour.** `$V up` (note `RUN=`), `$V doctor RUN`, then
     `$V ui RUN .claude/skills/verify-seer/features/steps/leaderboard-twin.mjs`. Passes when the log ends `result: PASS`. Along the way it logs the card order with `F4-MOM12-N20-TREND, F4-MOM12-N20-TREND-CX` adjacent, the colours (A lav, F4 sky, F4+Claude sky, F1 sage, C rose), the chart's two sky lines (`null` and `3 3`), and the Paper chip on the twin card only. Read `NN-ui-*-board.png`: the twin card sits right after F4's, in the same tint, with a dashed `Paper` chip.
  2. **Rule 5 for a twin.** `$V api RUN GET '/leaderboard?s=F4-MOM12-N20-TREND-CX'`. Passes when the text contains `Go-live checklist · F4+Claude · Momentum`, `Paper only. No backtest possible.`, `Claude knows how the past turned out` and `[Not yet] Backtest gate Can't be run`, and contains no `Backtest gate passed` row. The same journey's `NN-ui-*-twin-checklist.png` shows it.
  3. **Twin never on Today.** `$V down RUN`, `$V up --champion=F4-MOM12-N20-TREND-CX`, `$V api RUN GET /`. Passes when the text contains `No champion yet.` and `Seer recommends no buys.` and does not contain `F4+Claude`. Then `$V sql RUN "select id from strategies where is_champion"` returns `F4-MOM12-N20-TREND-CX`, which proves the row really was flagged and the web refused it.
  4. **Demo row is a real twin row.** `$V sql RUN "select id, twin_of, is_champion, gate_applicable from strategies where twin_of is not null"` returns exactly `F4-MOM12-N20-TREND-CX | F4-MOM12-N20-TREND | f | f`.
  5. **Phone layout holds.** `$V shoot RUN --theme dark --width 390 /leaderboard '/leaderboard?s=F4-MOM12-N20-TREND-CX'` exits 0 (no HTTP error, console error or horizontal scroll). Read the PNG: the twin's mobile title row shows `F4+Claude · Momentum` with the Paper chip beside it, not wrapped off the card.
- Neighbor check: the existing Leaderboard numbers must not move. On a fresh `$V up`, `$V api RUN GET /leaderboard` still shows `"Go-live checklist · A · Quant"`, `"[Not yet] Profit factor ≥ 1.3 0.78"`, `"[Passed] Max drawdown ≤ 25% 7.9%"` and `"66 Sessions"`. Also run `$V api RUN GET '/positions?s=C'`: it still shows C's news-check rows (`checksNews` is unchanged for a non-twin). If `"+2.6% Best · F1"` became the twin (its Sharpe outranked F1), record the observed line and the `$V engine RUN compare` output in `features/leaderboard.md`. That is a demo change made on purpose, not a product bug. Finish with `$V down --all`.
- Cost: none (offline, no `--llm`, no `--net`).
**Exit criteria:** `npx tsc --noEmit && npm test` are green in `web/`. Journeys 1–5 pass with evidence under `~/.local/state/seer-verify/<RUN>/evidence/`. The three feature-map files and `SKILL.md` are updated in the same commit as the code. The commit lists explicit paths only (Seer CLAUDE.md) and goes on `feature/seer-adversarial` of the Seer worktree. It is not pushed to main (phase 7 lands Seer).

## Handoffs

- **Phase 2 (engine compare/ranking):** Phase 2's lag (D1) gives a twin no snapshot for the original's newest session until the next night. Web `compare()` and `paper/compare.py` intersect snapshot dates, so once a twin is ranked, every ranked strategy's common window ends one session earlier. Both sides behave the same way (parity holds), and this phase does not change `compare()`. If the owner wants twins excluded from the ranking, change `compare.py` and its web port together in a later phase. Do not do it here alone.
- **Phase 2 (C2 rows):** the web expects only `twin_of`. The `+Claude` name head is display only, and the web neither parses it nor requires it. The icon should equal the original's (C2 says so). The web does not add a twin glyph.
- **Phase 7:** the defensive `to_jsonb(s) ->> 'twin_of'` read lets the web deploy before `migrate` runs on Neon. No ordering constraint for this phase.
- **Out of scope, noticed:** `components/StrategySwitch` on Positions and the Leaderboard shows the twin with the same icon as its original. Their tooltips differ (`F4+Claude · Momentum`). Telling them apart visually is a possible follow-up task; it is not part of R3.

## Rollback

Revert this phase's commit on `feature/seer-adversarial` (one commit: the `web/` files plus the four
`.claude/skills/verify-seer` files). Nothing here is schema or data. The demo seed change exists only in
throwaway verify DBs. With the revert in place and twin rows present (phase 2), twins would show as
ordinary research cards with their own colours and "Not applicable" on rule 5 (from their params gate).
That is wrong wording, but nothing unsafe: `is_champion` is false on them by C2.
