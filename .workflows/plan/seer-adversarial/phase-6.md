# Phase 6: Wall page `/adversary`

**Plan set:** `SEER_ADVERSARIAL_PLAN.md`
**Analysis:** `.workflows/analyze/20261105-084640-SA7K_code_analyzer.md`
**Satisfies:** R6, the wall page `/adversary`: a sword button between Chat history and Trash, Alt+Z focus as on Projects, an ON/OFF toggle, and the layout from the mock
**Depends on:** Phase 5 (the `/api/adversary/*` routes and the SSE `adversary` event). Phase 4 is reached only through phase 5.
**Difficulty:** HARD
**Package:** `web/` (mcp-notes), plus `.claude/skills/verify-notesd/features/`

---

## Goal

The wall gets a fourth page, **Seer Adversarial**, at `/adversary` and `/adversary/<strategy_id>`. It opens
from a Phosphor `Sword` button between Chat history and Trash, in both the rail and the sidebar. The
sidebar lists Seer's roster: Overview first, then active methods with a cadence chip, then retired methods
greyed out. The page has three layouts, picked from the API data and never from a hard-coded id:

- **Overview:** cause tiles, the methods table, latest objections.
- **Method page:** curves, stats, side-by-side checklist, decision verdict cards, record, revisions.
- **Daily three-way page:** for a bracket original whose detail carries a C sibling.

The toolbar holds the auto-runs Power toggle, Review now and Focus. Alt+Z and Esc work exactly as on
Projects, through a hook that both pages share. A chat pill asks about the page. SSE plus a 60 s poll keep
the page live. Every number on the page comes from phase 5's API. There are no "sample data" chips.

## Interface Contract

**Deletes:** the two focus `useEffect`s in `web/src/pages/ProjectsPage.tsx:84-107` (Esc-leaves-focus and
Alt+Z). Their behaviour moves unchanged into `useFocusShortcut`.
**Renames:** none
**Creates:**
- `View` member `'adversary'` (`web/src/types.ts:87`)
- `ADVERSARY_PATH`, `AdversaryRoute`, `NO_ADVERSARY_ROUTE`, `adversaryRouteFromLocation`, `adversaryHref` (`web/src/lib/route.ts`)
- `useFocusShortcut` (`web/src/hooks/useFocusShortcut.ts`)
- `ADVERSARY_TIP` (`web/src/components/Rail.tsx`)
- `web/src/adversaryApi.ts`: wire types plus `fetchOverview`, `fetchMethod`, `fetchToggle`, `saveToggle`, `postReviewNow`
- `web/src/hooks/useAdversary.ts` (`useAdversary`, `AdversaryStore`, `ADVERSARY_POLL_MS`)
- `web/src/lib/adversary.ts` (formatting, heading, count line, chat message)
- `web/src/pages/AdversaryPage.tsx`
- `web/src/components/adversary/{parts,CurvesChart,AdversaryOverview,AdversaryMethod,AdversaryDaily,AdversaryPill,RosterList}.tsx`
- `web/src/testing/adversaryFixtures.ts`
- a "Wall page (phase 6)" section appended to `.claude/skills/verify-notesd/features/adversary.md` (phase 4 creates the file)
**Signature changes:**
- `hrefForView(view, thread, loc, projects?)` -> `hrefForView(view, thread, loc, projects?, adversary?)` (new optional 5th parameter, default `NO_ADVERSARY_ROUTE`)
- `RailProps` gains a required `onToggleAdversary: () => void`
- `SidebarProps` gains a required `onToggleAdversary`, plus optional `roster`, `strategy`, `onPickStrategy`
- `HeaderProps` gains an optional `adversary?: boolean`
- `BIN_TIP: Record<View,string>` gains the key `adversary`
**Requires (from earlier phases):** phase 5 serves these routes, with the shapes of phase 5's Step 1
`src/adversary/readTypes.ts`, which Step 5 copies verbatim into `web/src/adversaryApi.ts` (reconciled:
the producer's plan is the authority; see **Interface (phase 5's wire types)** below).
- `GET /api/adversary/overview` -> `OverviewPayload`
- `GET /api/adversary/methods/:strategyId` -> `MethodPayload`
- `GET /api/adversary/toggle` -> `AdversaryToggle`
- `PUT /api/adversary/toggle {on}` -> `AdversaryToggle` (same-origin)
- `POST /api/adversary/review-now {strategy_id?}` -> 202 `ReviewNowResult` (same-origin), answered at once;
  the pass is not awaited, results arrive as SSE `adversary` events
- Phase 5 adds (reconciled) the `Adversary.` paragraph to `src/mcp/instructions.ts`, including the line
  that a chat message whose first line is `[Seer Adversarial · <strategy id|overview>]` is about that page
  of the wall; the pill (Step 13) sends that first line.
- `features/adversary.md` exists (phase 4 creates it with its `features/README.md` row; phase 5 appends
  the API / MCP / SSE section); this phase appends the wall section only.
- Errors are JSON `{ error: '<code>' }`, with 503 `seer_unavailable` and 404 `not_found`.
- The SSE event `adversary` is sent on `/api/events`.
- Phase 4 provides `NOTESD_ADVERSARY=off`, which disables the reviewer job (used by Proof).
**Leaves alone (owned by others):** all of `src/**` (phases 4, 5), `README.md` HTTP/MCP tables (phase 5),
`README.md` configuration table and install/restart (phase 7), Seer code (phases 1–3).

### Interface (phase 5's wire types)

The client types are phase 5's Step 1 `src/adversary/readTypes.ts`, verbatim (reconciled), plus local
mirrors of phase 4's `ToggleState` (`AdversaryToggle`) and `AdversaryStatus`. They live in
`web/src/adversaryApi.ts`, Step 5.

| Endpoint | Response | Notes |
|---|---|---|
| `GET /api/adversary/overview` | `OverviewPayload` | `roster` holds every non-twin, non-benchmark, non-critic original, active first in Seer `sort` order, then retired with the newest `paper_end` first. `methods` holds the active originals that have a twin. `latest` holds at most 8 `object`/`unsure` verdicts, newest `decided_at` first. |
| `GET /api/adversary/methods/:id` | `MethodPayload` | `three_way` is non-null only for a bracket original that has an active C sibling (a `NewsVeto` object reading the same candidate list). `decision` is the newest decision session with candidates or targets. |
| `GET /api/adversary/toggle` | `AdversaryToggle` | An absent row reads as `on: true`, `changed_at: null`. |
| `PUT /api/adversary/toggle` `{ "on": boolean }` | `AdversaryToggle` | Same-origin only. |
| `POST /api/adversary/review-now` `{ "strategy_id"?: string }` | `ReviewNowResult` (202) | Same-origin only. Starts one pass even while auto-runs are off and answers at once; the pass is not awaited. |

Field meanings the UI relies on:

- Returns (`Returns.*`, `BookFigures.return`) and `worst_drop` are fractions, so `0.054` is +5.4%. Returns are
  money-weighted with deposits included, over the twin's own window (`MethodRow.window`; the twin runs one
  session behind). `BookFigures.profit_factor` is a number, `'infinite'` (no losing trade) or `null`.
- `CoverageState` is `'reviewed' | 'absent' | 'paused' | 'pending'` (`pending`: the session has not opened).
  `Coverage` counts `decisions, reviewed, absent, late, paused, pending`.
- Nullable until the twin has a record: `MethodRow.window`, `MethodPayload.curves`, `stats.*`,
  `ThreeWay.books.*`, `ThreeWayRow.buys.*` (`null` = that book has not decided the session yet).
- `MethodPayload.lens_question` and `Revision.note` are always `null` (nothing stores them); the page shows
  neither. `AdversarySource.fetched_at` may be `null`.
- `Cause.extra_profit_usd` is in USD. `Cause.drawdown_delta_pts` is in percentage points, and negative means the
  twins dropped less.
- `ChecklistItem.value` is a display string that phase 5 formats from DB numbers (`"7.0 of 18 mo"`,
  `"+2.9 pts"`, `"2.04"`, `"11.2%"`). `progress` (0..1) is set for rule 1 only. Twin rule 5 has `state: 'na'`.
  Every item also carries `seer: {label, val, ok}`, Seer web's own row for the same rule (not money-weighted).
- `Curves.*` hold growth of 100 with deposits taken out, one value per entry of `dates`, and `null` before a
  series starts.
- `RecordPoint.gap_pts` is the objected stock's return over the method's horizon minus the average of the kept
  picks, in points. Below 0 means Claude was right.
- `AdversaryVerdict.late` is true when `decided_at >= session_open_utc(session_date)`, i.e. the verdict was
  kept but never used (D12). `weight` and `twin_weight` are fractions for books and `null` for brackets.
  `held` is set for books only.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/types.ts:86-87` | modify | `View` gains `'adversary'` |
| `web/src/lib/route.ts` | modify | adversary path, route parse/href, `hrefForView` 5th param |
| `web/src/lib/route.test.tsx` | modify | adversary route cases appended |
| `web/src/hooks/useFocusShortcut.ts` | create | shared Alt+Z / Esc focus hook |
| `web/src/hooks/useFocusShortcut.test.tsx` | create | hook behaviour |
| `web/src/pages/ProjectsPage.tsx:8,84-107` | modify | use the hook, drop the two effects |
| `web/src/adversaryApi.ts` | create | wire types (phase 5 `readTypes.ts` verbatim + phase 4 status/toggle mirrors) + fetchers |
| `web/src/lib/adversary.ts` | create | formatting, heading, count line, chat message |
| `web/src/lib/adversary.test.tsx` | create | formatting tests |
| `web/src/hooks/useAdversary.ts` | create | data store: overview, method, toggle, SSE, poll |
| `web/src/hooks/useAdversary.test.tsx` | create | loads, SSE refresh, toggle PUT |
| `web/src/components/adversary/parts.tsx` | create | chips, dots, coverage bar, verdict card, divider |
| `web/src/components/adversary/CurvesChart.tsx` | create | plain-SVG curves |
| `web/src/components/adversary/AdversaryOverview.tsx` | create | overview layout |
| `web/src/components/adversary/AdversaryOverview.test.tsx` | create | rendering from fixtures |
| `web/src/components/adversary/AdversaryMethod.tsx` | create | method layout |
| `web/src/components/adversary/AdversaryDaily.tsx` | create | A / C / Claude layout |
| `web/src/components/adversary/AdversaryPill.tsx` | create | "Ask about Seer Adversarial" pill |
| `web/src/components/adversary/RosterList.tsx` | create | sidebar roster |
| `web/src/pages/AdversaryPage.tsx` | create | toolbar, focus head, layout switch, pill |
| `web/src/pages/AdversaryPage.test.tsx` | create | toggle states, review now, focus keys, layout pick |
| `web/src/testing/adversaryFixtures.ts` | create | fixtures typed by phase 5's wire types |
| `web/src/components/Rail.tsx:1,9,17-31,62-83` | modify | Sword button, `ADVERSARY_TIP`, `BIN_TIP` key |
| `web/src/components/Sidebar.tsx:1-5,6-19,21-34,80-91` | modify | Sword button, roster list |
| `web/src/components/Rail.test.tsx:10-57` | modify | order tests, new prop, adversary icon + roster tests |
| `web/src/components/Header.tsx:1-26` | modify | `adversary` flag: hint, no "Last edited" |
| `web/src/App.tsx` (lines listed per step) | modify | view, route, URL sync, popstate, toggle, header, page, chat bar |
| `web/src/App.adversary.test.tsx` | create | end-to-end in jsdom |
| `web/src/styles.css:24,134` | modify | 3 tokens; `adv-*` and sidebar roster styles appended |
| `.claude/skills/verify-notesd/features/adversary.md` | modify (phase 4 creates it) | append the "Wall page (phase 6)" section |
| `.claude/skills/verify-notesd/features/README.md` | modify | append `, wall` to cells 1 and 3 of the existing Seer Adversarial row (phase 4's, widened by phase 5) |

## Implementation Steps

### Step 1: `View` gains `'adversary'`
**File:** `web/src/types.ts:86-87`
**Change:** replace the comment and union.
**Code:**
```ts
/** What the main area shows: the wall (text / images / all modes), the recycle bin, the chat history page (phase 9), the projects session graph (project-session-graph phase 10), or Seer Adversarial (seer-adversarial phase 6). */
export type View = 'wall' | 'bin' | 'history' | 'projects' | 'adversary';
```
**Impact:** `BIN_TIP: Record<View,string>` (Rail.tsx) no longer type-checks until Step 15 adds the key. Do Steps 1, 2 and 15 together before running `npm run typecheck`.

### Step 2: Adversary route
**File:** `web/src/lib/route.ts`
**Change:** replace the doc comment at lines 3-11, add the adversary block after `projectsHref` (line 75),
and replace `hrefForView` (lines 77-88).
**Code (doc comment, lines 3-13 become):**
```ts
/**
 * The history page's URL (phase 9): `/history`, or `/history?thread=<id>` to open it on one thread.
 * The projects view (project-session-graph phase 10): `/projects`, `/projects?repo=<repo>`, and
 * `/projects?repo=<repo>&node=<NODE-ID>` with one graph node selected. `&focus=1` is graph focus
 * mode: the page alone, without rail, sidebar and header. `/projects?node=<NODE-ID>` (no repo) is how
 * Claude Code links a node: the app looks up the node's repo.
 * Seer Adversarial (seer-adversarial phase 6): `/adversary` (overview) and `/adversary/<strategy_id>`
 * (one roster method, the id exactly as Seer stores it), each with `?focus=1` for focus mode.
 * The wall and the bin have no path of their own: they live at `/` (and `/?note=<id>` deep links,
 * lib/deepLink.ts), so leaving the history, projects or adversary page pushes `/` and nothing else is touched.
 */
export const HISTORY_PATH = '/history';
export const PROJECTS_PATH = '/projects';
export const ADVERSARY_PATH = '/adversary';
```
**Code (insert after `projectsHref`):**
```ts
/** What `/adversary` asks for. `strategy` null = the overview; else a Seer strategy id, never altered. */
export interface AdversaryRoute {
  strategy: string | null;
  /** Focus mode: the page alone, without rail, sidebar and header. */
  focus: boolean;
}

export const NO_ADVERSARY_ROUTE: AdversaryRoute = { strategy: null, focus: false };

/** The adversary route, or null when the URL is not `/adversary[/<id>]`. A deeper path is not this page. */
export function adversaryRouteFromLocation(loc: Loc): AdversaryRoute | null {
  const p = pathOf(loc);
  const focus = param(loc.search, 'focus') === '1';
  if (p === ADVERSARY_PATH) return { strategy: null, focus };
  if (!p.startsWith(`${ADVERSARY_PATH}/`)) return null;
  const rest = p.slice(ADVERSARY_PATH.length + 1);
  if (rest === '' || rest.includes('/')) return null;
  let id: string;
  try {
    id = decodeURIComponent(rest).trim();
  } catch {
    return null;
  }
  return { strategy: id === '' ? null : id, focus };
}

export function adversaryHref(r: AdversaryRoute): string {
  const base = r.strategy ? `${ADVERSARY_PATH}/${encodeURIComponent(r.strategy)}` : ADVERSARY_PATH;
  return r.focus ? `${base}?focus=1` : base;
}
```
**Code (`hrefForView` replacement):**
```ts
/**
 * The URL to push so the address bar matches `view`, or null when it already does. Wall and bin
 * accept any non-history, non-projects, non-adversary URL as it is (a `/?note=` link stays put); only
 * leaving `/history`, `/projects` or `/adversary` pushes `/`.
 */
export function hrefForView(
  view: View,
  thread: string | null,
  loc: Loc,
  projects: ProjectsRoute = NO_PROJECT_ROUTE,
  adversary: AdversaryRoute = NO_ADVERSARY_ROUTE,
): string | null {
  const r = routeFromLocation(loc);
  const p = projectsRouteFromLocation(loc);
  const a = adversaryRouteFromLocation(loc);
  if (view === 'history') return r.history && r.thread === thread ? null : historyHref(thread);
  if (view === 'projects') return p !== null && p.repo === projects.repo && p.node === projects.node && p.focus === projects.focus ? null : projectsHref(projects);
  if (view === 'adversary') return a !== null && a.strategy === adversary.strategy && a.focus === adversary.focus ? null : adversaryHref(adversary);
  return r.history || p !== null || a !== null ? '/' : null;
}
```
**Impact:** existing callers pass 4 arguments and keep their behaviour. The existing `route.test.tsx` cases still hold.

### Step 3: Shared focus hook
**File:** `web/src/hooks/useFocusShortcut.ts` (create)
**Code:**
```ts
import { useEffect } from 'react';

export interface FocusShortcutOptions {
  /** Focus mode is on: Esc may leave it. */
  focus: boolean;
  /**
   * Esc leaves focus mode only while this is true. Projects passes `node === null`, so with a node
   * selected Esc clears the node first. Default true.
   */
  escapeLeaves?: boolean;
}

/**
 * Focus mode's keyboard, shared by the Projects and Seer Adversarial pages.
 *
 * Alt+Z toggles focus mode from anywhere on the page. It listens in the capture phase and calls
 * preventDefault so the browser's own handling of the chord never runs. `z` as in vim's `zen`: no
 * browser binds Alt+Z, whereas Alt+F/E/D/H/S open menus or the address bar. `code` rather than `key`
 * because macOS Option turns Alt+Z into another character. Ctrl/Meta/Shift variants and key repeat
 * are not the chord.
 *
 * In focus mode, Esc leaves it (bubble phase, and only when nothing earlier handled the key).
 * Without `onToggle` the page has no focus mode and nothing is bound.
 */
export function useFocusShortcut(onToggle: (() => void) | undefined, { focus, escapeLeaves = true }: FocusShortcutOptions): void {
  useEffect(() => {
    if (!focus || !escapeLeaves || !onToggle) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') onToggle();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focus, escapeLeaves, onToggle]);

  useEffect(() => {
    if (!onToggle) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyZ' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      e.preventDefault();
      onToggle();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onToggle]);
}
```

### Step 4: ProjectsPage uses the hook
**File:** `web/src/pages/ProjectsPage.tsx`
**Change:**
- Add `import { useFocusShortcut } from '../hooks/useFocusShortcut';` after line 8 (`import { useSessionGraph } ...`).
- Replace the two effects from `// In focus mode, Esc with no node selected leaves it ...` through the end of the
  Alt+Z effect (lines 84-107 in the current file) with the block below. The node-Esc effect above it stays
  where it is, so the listeners register in the same order as before.
**Code:**
```tsx
  // In focus mode, Esc with no node selected leaves it (with a node selected, Esc clears that first);
  // Alt+Z toggles focus mode on either view. Shared with the Seer Adversarial page.
  useFocusShortcut(onToggleFocus, { focus, escapeLeaves: node === null });
```
**Impact:** none on behaviour. `App.projects.test.tsx` ("Alt+Z toggles focus mode both ways…", "a focus deep link…
Esc clears the node first") must pass unchanged. `useEffect` is still imported and used (node reveal, node Esc).

### Step 5: API client and wire types
**File:** `web/src/adversaryApi.ts` (create)
**Code:**
```ts
import { ApiError } from './api';

/**
 * Seer Adversarial wire types and fetchers. The types are phase 5's `src/adversary/readTypes.ts`
 * (SEER_ADVERSARIAL_PLAN phase 5, Step 1) copied verbatim -- same names, fields, nullability and doc
 * comments (reconciled: the producer's plan is the authority). The only differences: phase 4's
 * `AdversaryStatus` / `ToggleState` are mirrored here because the web cannot import server code, and
 * `MethodStats` / `ThreeWayBook` are aliases of `BookFigures` kept for the components' readability.
 * Every number on the page comes from these payloads, which phase 5 reads from Seer's DB; the page
 * never parses model prose for a number (honesty rule, brief §5).
 * Fractions: 0.054 = +5.4%. Points: percentage points. Money: USD. Dates: YYYY-MM-DD NYSE sessions.
 * Times: ISO 8601 UTC with milliseconds.
 */

/** Phase 4's `ToggleState` (`src/adversary/toggle.ts`): absent row = on, never changed. */
export interface AdversaryToggle {
  on: boolean;
  /** ISO 8601 of the last change, null when never set. */
  changed_at: string | null;
  /** Host that made the last change, null when never set. */
  host: string | null;
}

/** Mirrors of phase 4's `src/adversary/service.ts` status types (the web cannot import server code). */
export type RunTrigger = 'auto' | 'manual';
export type SchemaState = 'unknown' | 'ready' | 'missing' | 'unreachable';

export interface RunSummary {
  trigger: RunTrigger;
  host: string;
  started_at: string;
  finished_at: string | null;
  /** Final verdicts written to Seer after a deep review. */
  reviewed: number;
  /** Final verdicts written to Seer from an earlier draft (no tokens). */
  reused: number;
  /** Draft reviews of a book's next rebalance (never written to Seer). */
  drafted: number;
  failed: number;
  /** Written, but decided after the session opened (the engine ignores them). */
  late: number;
  skipped_budget: number;
  /** Paused marks written while auto runs were off. */
  marks: number;
  /** Decisions another host was reviewing. */
  leases_lost: number;
  error: string | null;
}

export interface AdversaryStatus {
  host: string;
  auto: AdversaryToggle;
  running: RunTrigger | null;
  schema: SchemaState;
  daily_cap: number;
  used_today: number;
  next_poll_at: string | null;
  last_run: RunSummary | null;
  models: { gather: string; verdict: string };
}

export type Engine = 'bracket' | 'book' | 'benchmark';
export type VerdictKind = 'agree' | 'object' | 'unsure';
/** C's own verdicts (news_vetoes.verdict). `failed` means no trade for C and is not a call. */
export type CVerdict = 'allow' | 'veto' | 'failed';
/** 'na': the rule cannot apply (a twin's backtest, or C's). Never counts as passed. */
export type CheckState = 'pass' | 'fail' | 'na';
export type CheckKey = 'months' | 'beats_spy' | 'profit_factor' | 'max_drawdown' | 'backtest';
/**
 * One decision (strategy, session): 'pending' until the session opens; then 'reviewed' when at least
 * one verdict was decided before the open, else 'paused' when the owner's toggle was off
 * (adversary_marks), else 'absent'. A late verdict leaves the decision absent (D12).
 */
export type CoverageState = 'reviewed' | 'absent' | 'paused' | 'pending';
export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly';
export type ScoreOutcome = 'worse' | 'same' | 'better';

export interface AdversarySource {
  url: string;
  title: string | null;
  publisher: string | null;
  published_at: string | null;
  fetched_at: string | null;
}

export interface AdversaryVerdict {
  id: number;
  /** The ORIGINAL strategy id, never the twin's. */
  strategy_id: string;
  session_date: string;
  symbol: string;
  /** Rank in the decision's candidate list; null when the symbol is not on it. */
  rank: number | null;
  verdict: VerdictKind;
  reason: string;
  sources: AdversarySource[];
  lens: string;
  model: string;
  prompt_version: string;
  host: string;
  started_at: string;
  decided_at: string;
  /** Decided at or after the session's open: kept for the record, never used by the twin. */
  late: boolean;
  /** In a decision of a book: the original's target weight. Null outside a decision and for brackets. */
  weight: number | null;
  /** In a decision of a book: the twin's weight (its own book_targets once it decided, else the pro-rata expectation). */
  twin_weight: number | null;
  twin_weight_source: 'twin_book' | 'expected' | null;
  /** In a decision of a book: the original held it before, so an objection is a sale. Null otherwise. */
  held: boolean | null;
  /** A counted objection only: 'sell' (a held book name) or 'skip' (a new name, or any bracket pick). */
  action: 'sell' | 'skip' | null;
}

/** One original on Seer's roster (never a twin, the benchmark or C). */
export interface AdversaryMethod {
  strategy_id: string;
  /** Its Claude twin: the active one, else the newest retired one; null before phase 2 creates it. */
  twin_id: string | null;
  name: string;
  /** The name's head, 'RAW35 · Momentum' -> 'RAW35' (Seer web shortLabel). */
  short: string;
  sub: string | null;
  engine: 'bracket' | 'book';
  cadence: Cadence | null;
  status: 'active' | 'retired';
  paper_start: string | null;
  paper_end: string | null;
}

/** Seer web's CheckItem for the same rule, byte for byte (web/lib/metrics.ts checklist + gateItem). */
export interface SeerCheck {
  label: string;
  val: string;
  ok: boolean;
}

export interface ChecklistItem {
  rule: 1 | 2 | 3 | 4 | 5;
  key: CheckKey;
  /** Plain words for the page: '18 months on paper', 'beats SPY', 'wins ÷ losses ≥ 1.3', 'worst drop ≤ 25%', '10-year backtest'. */
  label: string;
  state: CheckState;
  /** Display value from DB numbers: '7.0 of 18 mo', '+2.9 pts', '2.04', '11.2%', 'failed', "can't be run". */
  value: string | null;
  /** Rule 1 only: share of the 18 months done, 0..1. */
  progress: number | null;
  seer: SeerCheck;
}

export interface Checklists {
  original: ChecklistItem[];
  /** Empty when the method has no twin yet. */
  twin: ChecklistItem[];
}

/** One book over a window: the twin's record for originals and SPY, or the book's own record. */
export interface BookFigures {
  strategy_id: string;
  from: string;
  to: string;
  sessions: number;
  /** Money-weighted return over the window, deposits included (the period form of Seer's IRR). */
  return: number | null;
  /** Seer's money_weighted_return (annualised IRR) over the same window; null when it overflows. */
  mwr_annual: number | null;
  /** Deposits credited inside (from, to]. */
  deposits_usd: number;
  /** End equity - start equity - deposits. */
  gain_usd: number | null;
  /** Deepest fall of the time-weighted index (deposits taken out), as a fraction. */
  worst_drop: number | null;
  /** Closed trades that exited inside (from, to]. */
  trades: number;
  /** Gross win / gross loss of those trades; 'infinite' with no losing trade; null with none. */
  profit_factor: number | 'infinite' | null;
  /** book_fills.cost_usd inside (from, to]; null for brackets (Seer stores no per-order fee). */
  fees_usd: number | null;
}

/** Money-weighted returns since the twin started. */
export interface Returns {
  original: number | null;
  twin: number | null;
  spy: number | null;
}

export interface Objections {
  /** Counted objections on settled (reviewed) decisions. */
  objected: number;
  /** Counted verdicts on settled decisions (stocks reviewed). */
  reviewed: number;
  /** Objections whose stock did worse than the kept picks over the horizon; null before any is scored. */
  fell_after: number | null;
  scored: number;
  pending: number;
}

export interface Coverage {
  decisions: number;
  reviewed: number;
  absent: number;
  /** Absent decisions that do have a verdict, decided after the open. */
  late: number;
  paused: number;
  pending: number;
}

export interface TwinWindow {
  from: string;
  to: string;
  sessions: number;
}

export interface MethodRow extends AdversaryMethod {
  /** The twin's record; every figure below is over it. Null before the twin has a snapshot. */
  window: TwinWindow | null;
  returns: Returns;
  figures: { original: BookFigures | null; twin: BookFigures | null; spy: BookFigures | null };
  /** Twin's end equity minus what its own money would have made at the original's time-weighted growth. */
  beyond_original_usd: number | null;
  objections: Objections;
  coverage: Coverage;
  checklist: Checklists;
}

export interface Cause {
  twins: number;
  twins_beat_spy: string[];
  originals_beat_spy: string[];
  /** Sum of beyond_original_usd over the active twins. */
  extra_profit_usd: number | null;
  /** Mean of (twin worst drop - original worst drop) x 100; negative = the twins fell less. */
  drawdown_delta_pts: number | null;
}

export interface LastReview {
  strategy_id: string;
  session_date: string;
  /** Distinct symbols with a verdict for that decision. */
  picks: number;
  finished_at: string;
}

export interface OverviewPayload {
  generated_at: string;
  /** Earliest first snapshot among active twins: month N of 18 counts from here. */
  started_on: string | null;
  months_on_paper: number | null;
  spy_id: string | null;
  /** Every original: active in Seer sort order, then retired, newest paper_end first. */
  roster: AdversaryMethod[];
  /** Active originals that have a twin. */
  methods: MethodRow[];
  cause: Cause;
  /** At most 8 counted object/unsure verdicts, newest decided_at first. */
  latest: AdversaryVerdict[];
  last_review: LastReview | null;
  /** Phase 4's reviewer status on this machine; null when NOTESD_ADVERSARY=off. */
  reviewer: AdversaryStatus | null;
}

/** Growth of 100, deposits taken out, one value per date (null where a series has no snapshot). */
export interface Curves {
  dates: string[];
  original: (number | null)[];
  twin: (number | null)[];
  spy: (number | null)[];
}

export interface DecisionSummary {
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  open_utc: string;
  coverage: CoverageState;
  picks: number;
  object: number;
  unsure: number;
  agree: number;
  late: number;
}

export interface DecisionPick {
  rank: number;
  symbol: string;
  weight: number | null;
  held: boolean | null;
  twin_weight: number | null;
  twin_weight_source: 'twin_book' | 'expected' | null;
  /** The counted verdict, else the latest late one, else null (nobody reviewed it). */
  verdict: AdversaryVerdict | null;
}

export interface AdversaryDecision {
  strategy_id: string;
  twin_id: string | null;
  session_date: string;
  data_date: string;
  kind: 'bracket' | 'book';
  open_utc: string;
  coverage: CoverageState;
  /** Over counted verdicts only. */
  first_started_at: string | null;
  last_decided_at: string | null;
  models: string[];
  prompt_versions: string[];
  lenses: string[];
  hosts: string[];
  counts: { object: number; unsure: number; agree: number; none: number; late: number };
  /** A book decision whose every target was objected (D6: the twin then does what the original does for an empty decision). */
  all_objected: boolean;
  /** Each pick's shown verdict, in rank order. */
  verdicts: AdversaryVerdict[];
  picks: DecisionPick[];
}

export interface RecordPoint {
  symbol: string;
  session_date: string;
  rank: number;
  /** (stock return - kept picks' mean return) x 100 over the horizon; below 0 means Claude was right. */
  gap_pts: number;
  outcome: ScoreOutcome;
  stock_return: number;
  kept_return: number;
  kept: number;
  horizon_from: string | null;
  horizon_to: string | null;
  sessions: number | null;
  fell: boolean;
}

export interface RecordSummary {
  objections: number;
  scored: number;
  worse: number;
  same: number;
  better: number;
  pending: number;
  /** Scored objections whose stock lost money over the horizon. */
  fell: number;
  mean_gap_pts: number | null;
}

export interface AdversaryRecord {
  /** Plain words: 'the 5 sessions after the decision', 'until the next rebalance'. */
  horizon: string;
  horizon_sessions: number | null;
  same_band_pts: number;
  /** Scored objections, oldest first. */
  points: RecordPoint[];
  /** Objections whose horizon has not passed yet. */
  pending: { symbol: string; session_date: string }[];
  summary: RecordSummary;
}

export interface Revision {
  /** First decided_at with this prompt_version, model and lens. */
  since: string;
  /** Last decided_at of a revision a newer one replaced; null for the newest. */
  until: string | null;
  prompt_version: string;
  model: string;
  lens: string;
  verdicts: number;
  /** No change note is stored anywhere yet (see Handoffs); always null. */
  note: string | null;
}

export interface DuelRow {
  session_date: string;
  symbol: string;
  rank: number;
  c: 'allow' | 'veto';
  claude: VerdictKind;
  blocked_by: 'critic' | 'claude';
  stock_return: number | null;
  baseline: number | null;
  right: 'critic' | 'claude' | null;
}

export interface CriticDuel {
  critic_id: string;
  nights: number;
  disagreements: number;
  scored: number;
  claude_right: number;
  critic_right: number;
  pending: number;
  rows: DuelRow[];
}

export interface ThreeWayRow {
  rank: number;
  symbol: string;
  c: { verdict: CVerdict; reason: string; decided_at: string } | null;
  /** The counted verdict, else the latest late one (late: true). */
  claude: AdversaryVerdict | null;
  /** Did each book place an order for this name for this session? null = that book has not decided it yet (the twin decides one night late). */
  buys: { original: boolean | null; critic: boolean | null; twin: boolean | null };
}

export interface DailyGrid {
  c_veto_claude_object: string[];
  c_veto_claude_keep: string[];
  c_allow_claude_object: string[];
  c_allow_claude_keep: string[];
}

export interface ThreeWay {
  original: AdversaryMethod;
  critic: AdversaryMethod;
  twin_id: string | null;
  /** Each book over its own whole record. */
  books: { original: BookFigures | null; critic: BookFigures | null; twin: BookFigures | null };
  /** Decision sessions with candidates, newest first. */
  sessions: string[];
  session_date: string | null;
  open_utc: string | null;
  coverage: CoverageState | null;
  rows: ThreeWayRow[];
  grid: DailyGrid;
  /** Null until at least one disagreement's horizon has passed. */
  settled: { claude_right: number; critic_right: number; disagreements: number; scored: number; pending: number; nights: number } | null;
  duel: CriticDuel;
}

export interface MethodPayload {
  method: AdversaryMethod;
  row: MethodRow;
  /** The lens is built by phase 4 and not stored in Seer; always null in this phase (see Handoffs). */
  lens_question: string | null;
  curves: Curves | null;
  stats: { original: BookFigures | null; twin: BookFigures | null; spy: BookFigures | null };
  checklist: Checklists;
  /** The newest pending or reviewed decision, else the newest decision. */
  decision: AdversaryDecision | null;
  /** Every decision, newest first. */
  decisions: DecisionSummary[];
  record: AdversaryRecord;
  revisions: Revision[];
  /** Bracket originals with a C sibling only. */
  three_way: ThreeWay | null;
}

export interface ScorecardPayload {
  strategy_id: string;
  engine: 'bracket' | 'book';
  record: AdversaryRecord;
  duel: CriticDuel | null;
}

export interface VerdictList {
  sessions: { strategy_id: string; session_date: string; coverage: CoverageState }[];
  verdicts: AdversaryVerdict[];
}

export interface ReviewNowResult {
  started: boolean;
  reason: string | null;
}

/** Aliases for the components: a method's side-by-side stats and a three-way book are BookFigures. */
export type MethodStats = BookFigures;
export type ThreeWayBook = BookFigures;

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') msg = (j as { error: string }).error;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg);
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, signal ? { signal } : undefined);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

/** Arrays the page maps over are always arrays, whatever an older server omits. */
function normalizeOverview(o: OverviewPayload): OverviewPayload {
  return { ...o, roster: o.roster ?? [], methods: o.methods ?? [], latest: o.latest ?? [] };
}

export async function fetchOverview(signal?: AbortSignal): Promise<OverviewPayload> {
  return normalizeOverview(await getJson<OverviewPayload>('/api/adversary/overview', signal));
}

export async function fetchMethod(strategyId: string, signal?: AbortSignal): Promise<MethodPayload> {
  const d = await getJson<MethodPayload>(`/api/adversary/methods/${enc(strategyId)}`, signal);
  return { ...d, revisions: d.revisions ?? [], decisions: d.decisions ?? [], record: d.record ?? EMPTY_RECORD };
}

/** What a method with no scored objection shows (phase 5 always sends one; this guards an older server). */
const EMPTY_RECORD: AdversaryRecord = {
  horizon: '',
  horizon_sessions: null,
  same_band_pts: 0.5,
  points: [],
  pending: [],
  summary: { objections: 0, scored: 0, worse: 0, same: 0, better: 0, pending: 0, fell: 0, mean_gap_pts: null },
};

export function fetchToggle(signal?: AbortSignal): Promise<AdversaryToggle> {
  return getJson<AdversaryToggle>('/api/adversary/toggle', signal);
}

/** PUT `{on}` only: the server passes its own host to phase 4's `setToggle(on, host)`; the web never sends one. */
export async function saveToggle(on: boolean): Promise<AdversaryToggle> {
  const res = await fetch('/api/adversary/toggle', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ on }) });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as AdversaryToggle;
}

/**
 * Starts one review pass. Phase 5 answers 202 `{started, reason}` immediately and does NOT await the
 * pass; the page learns of its results from SSE `adversary` events and the next refresh, never by
 * awaiting this POST. 202 is `res.ok`.
 */
export async function postReviewNow(strategyId: string | null): Promise<ReviewNowResult> {
  const body = strategyId ? { strategy_id: strategyId } : {};
  const res = await fetch('/api/adversary/review-now', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as Partial<ReviewNowResult>;
  return { started: j.started === true, reason: typeof j.reason === 'string' ? j.reason : null };
}
```

### Step 6: Formatting and page text
**File:** `web/src/lib/adversary.ts` (create)
**Code:**
```ts
import type { AdversaryMethod, AdversarySource, AdversaryToggle, AdversaryVerdict, Cause, CheckState, ChecklistItem, Coverage, MethodPayload, Objections, OverviewPayload, ThreeWayRow } from '../adversaryApi';

/** Seer's real-money bar: 18 months on paper (Seer web/lib/golive.ts MIN_PAPER_MONTHS). Display only. */
export const PAPER_MONTHS = 18;
export const ADVERSARY_HEADING = 'Adversary.';
export const ADVERSARY_HINT = 'Claude reviews each pick before the market opens. A missing, late or paused review copies the original.';
export const TWIN_BACKTEST_NOTE = 'Claude already knows how the past turned out, so a twin can never be backtested.';
export const PILL_PLACEHOLDER = 'Ask about Seer Adversarial';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUS = '−';

const sign = (v: number) => (v > 0 ? '+' : v < 0 ? MINUS : '');
const pad = (n: number) => String(n).padStart(2, '0');

/** `RAW35 · Momentum` -> `RAW35`. */
export function shortName(name: string): string {
  const i = name.indexOf(' · ');
  return (i < 0 ? name : name.slice(0, i)).trim();
}

/** `RAW35 · Momentum` -> `Momentum`; '' when the name has no ` · `. */
export function plainName(name: string): string {
  const i = name.indexOf(' · ');
  return i < 0 ? '' : name.slice(i + 3).trim();
}

/** The big heading of a method page: its code (`RAW35.`); a one- or two-letter code reads badly huge, so its plain name (`Dip buy.`). */
export function methodHeading(name: string): string {
  const head = shortName(name);
  const tail = plainName(name);
  return `${head.length >= 3 || tail === '' ? head : tail}.`;
}

/** Fraction -> `+5.4%` / `−1.0%` / `0.0%`; null -> `—`. */
export function pct(v: number | null): string {
  if (v === null) return '—';
  return `${sign(v)}${Math.abs(v * 100).toFixed(1)}%`;
}

/** Points -> `+3.6 pts` / `−1.9 pts`. */
export function pts(v: number | null): string {
  if (v === null) return '—';
  return `${sign(v)}${Math.abs(v).toFixed(1)} pts`;
}

/** USD -> `+$38.20`. */
export function usd(v: number | null): string {
  if (v === null) return '—';
  return `${sign(v)}$${Math.abs(v).toFixed(2)}`;
}

/** Worst drop fraction -> `11.2%`. */
export function dropPct(v: number | null): string {
  return v === null ? '—' : `${Math.abs(v * 100).toFixed(1)}%`;
}

/** Profit factor: `2.04`; `'infinite'` (no losing trade) -> `∞`; null (no closed trade) -> `n/a`. */
export function ratio(v: number | 'infinite' | null): string {
  if (v === null) return 'n/a';
  return v === 'infinite' ? '∞' : v.toFixed(2);
}

export function count(v: number): string {
  return v.toLocaleString('en-US');
}

/** `2026-11-04` -> `Nov 4` (calendar date, no time zone shift); an ISO datetime -> its local date. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** ISO datetime -> local `Nov 4, 17:12`. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sourceHost(s: AdversarySource): string {
  try {
    return new URL(s.url).hostname.replace(/^www\./, '');
  } catch {
    return s.url;
  }
}

/** Numbered source line: `benzinga.com · crude analyst calls end of the run`. */
export function sourceLabel(s: AdversarySource): string {
  return [s.publisher ?? sourceHost(s), s.title].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
}

/** Book verdict footer: `weight 2.9% → 0` (object) or `weight 2.9% → 3.2%`; '' for brackets. */
export function weightChange(v: AdversaryVerdict): string {
  if (v.weight === null) return '';
  const to = v.twin_weight === null || v.twin_weight === 0 ? '0' : `${(v.twin_weight * 100).toFixed(1)}%`;
  return `weight ${(v.weight * 100).toFixed(1)}% → ${to}`;
}

/** Book verdict tag: `held · sell` / `new · skip` for objections, `held` / `new` otherwise; '' for brackets. */
export function heldTag(v: AdversaryVerdict): string {
  if (v.held === null) return '';
  if (v.verdict !== 'object') return v.held ? 'held' : 'new';
  return v.held ? 'held · sell' : 'new · skip';
}

/** Decisions whose session has opened (reviewed, absent or paused); `pending` ones are not settled yet. */
export function coverageTotal(c: Coverage): number {
  return c.reviewed + c.absent + c.paused;
}

/** `rebalances` for monthly books, `re-picks` for quarterly ones. */
export function cadenceUnit(cadence: string | null): string {
  return cadence === 'quarterly' ? 're-picks' : 'rebalances';
}

/** Daily brackets: `78% · 17% · 5%`. Books: `7 of 7 rebalances`, `6 of 7 rebalances · 1 paused`. */
export function coverageLabel(c: Coverage, engine: 'bracket' | 'book', cadence: string | null): string {
  const total = coverageTotal(c);
  const pending = c.pending > 0 ? ` · ${c.pending} pending` : '';
  if (total === 0) return c.pending > 0 ? `${c.pending} pending` : 'no decisions yet';
  if (engine === 'bracket') {
    const share = (n: number) => `${Math.round((n / total) * 100)}%`;
    return `${share(c.reviewed)} · ${share(c.absent)} · ${share(c.paused)}${pending}`;
  }
  let s = `${c.reviewed} of ${total} ${cadenceUnit(cadence)}`;
  if (c.paused > 0) s += ` · ${c.paused} paused`;
  if (c.absent > 0) s += ` · ${c.absent} absent`;
  return s + pending;
}

export function objectionsLine(o: Objections): string {
  return `${count(o.objected)} / ${count(o.reviewed)}`;
}

/** Month N of 18 since `startedOn` (calendar months, counted on UTC dates). */
export function paperMonth(startedOn: string | null, now: Date): number | null {
  if (startedOn === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startedOn);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - mo) - (now.getUTCDate() < d ? 1 : 0);
  return Math.max(1, months + 1);
}

export function rosterNames(roster: readonly AdversaryMethod[]): Map<string, string> {
  return new Map(roster.map((r) => [r.strategy_id, shortName(r.name)]));
}

/** `A`, `A and B`, `A, B and C`. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface CauseTile {
  key: 'spy' | 'profit' | 'drops';
  label: string;
  value: string;
  text: string;
}

/** Seer's cause, in order: 1 beat SPY, 2 most profit, 3 smaller drops. */
export function causeTiles(cause: Cause, names: ReadonlyMap<string, string>): CauseTile[] {
  const name = (id: string) => names.get(id) ?? id;
  const twins = cause.twins_beat_spy.map((id) => `${name(id)}'s`);
  const originals = cause.originals_beat_spy.map(name);
  const twinText =
    twins.length === 0 ? 'No twin is ahead of SPY yet.' : `${joinNames(twins)} ${twins.length === 1 ? 'twin is' : 'twins are'} ahead of SPY.`;
  const origText =
    originals.length === 0
      ? ' No original is.'
      : ` Of the originals, ${joinNames(originals)} ${originals.length === 1 ? 'is' : 'are'}.`;
  return [
    { key: 'spy', label: '1 · beat SPY', value: `${cause.twins_beat_spy.length} of ${cause.twins} twins`, text: twinText + origText },
    { key: 'profit', label: '2 · most profit', value: usd(cause.extra_profit_usd), text: 'What the twins made beyond their originals, together, after fees.' },
    { key: 'drops', label: '3 · smaller drops', value: pts(cause.drawdown_delta_pts), text: "The twins' worst fall from a high, on average, against their originals'." },
  ];
}

export function stateWord(item: ChecklistItem): string {
  if (item.state === 'na') return "can't be run";
  if (item.state === 'pass') return 'pass';
  return item.rule === 1 ? 'not yet' : 'failed';
}

/** A checklist cell: `+2.9 pts · pass`, `7.0 of 18 mo`, `failed`, `can't be run`. */
export function checkValue(item: ChecklistItem): string {
  if (item.state === 'na' || item.value === null) return stateWord(item);
  return item.rule === 1 ? item.value : `${item.value} · ${stateWord(item)}`;
}

export const CHECK_WORD: Record<CheckState, string> = { pass: 'passed', fail: 'not yet / failed', na: 'no backtest possible for Claude' };

/** Messages for the server's error codes. */
export function errorText(code: string, strategy: string | null = null): string {
  if (code === 'seer_unavailable') return "Seer's database can't be reached from this machine, so there is nothing to show.";
  if (code === 'not_found') return strategy ? `No method ${strategy} on Seer's roster.` : 'Not found.';
  return `Could not load Seer Adversarial (${code}).`;
}

export function overviewCountLine(o: OverviewPayload | null, error: string | null, now: Date): string {
  if (error !== null) return errorText(error);
  if (o === null) return 'Loading Seer Adversarial.';
  const n = o.methods.length;
  if (n === 0) return "No method on Seer's roster has a Claude twin yet.";
  let s = `${n === 1 ? '1 method' : `${n} methods`} on Seer's roster, each with a Claude twin that drops the picks Claude objects to.`;
  const month = paperMonth(o.started_on, now);
  if (month !== null) s += ` Month ${month} of ${PAPER_MONTHS}.`;
  const last = o.last_review;
  if (last !== null) {
    const who = rosterNames(o.roster).get(last.strategy_id) ?? last.strategy_id;
    s += ` Last review: ${who}'s ${last.picks} ${last.picks === 1 ? 'pick' : 'picks'} for ${shortDate(last.session_date)}, on ${shortDate(last.finished_at)}.`;
  }
  return s;
}

export function decisionSummary(d: MethodPayload['decision']): string {
  if (d === null) return 'No verdicts yet.';
  const day = shortDate(d.session_date);
  if (d.coverage === 'paused') return `${day} decision: paused, the twin copies the original.`;
  if (d.coverage === 'absent' && d.verdicts.every((v) => v.late)) return `${day} decision: not reviewed in time, the twin copies the original.`;
  const n = (k: AdversaryVerdict['verdict']) => d.verdicts.filter((v) => v.verdict === k && !v.late).length;
  const obj = n('object');
  const unsure = n('unsure');
  return `${day} decision: ${d.verdicts.length} picks, ${obj} ${obj === 1 ? 'objection' : 'objections'}, ${unsure} can't tell.`;
}

export function methodCountLine(d: MethodPayload): string {
  const parts: string[] = [];
  if (d.method.sub) parts.push(d.method.sub.endsWith('.') ? d.method.sub : `${d.method.sub}.`);
  // No lens sentence: phase 5 always sends lens_question null (nothing stores the lens's question).
  parts.push(decisionSummary(d.decision));
  return parts.join(' ');
}

export interface AdversaryView {
  overview: OverviewPayload | null;
  overviewError: string | null;
  method: MethodPayload | null;
  methodError: string | null;
}

/** The wall header's heading for /adversary[/<id>]. */
export function adversaryHeading(s: AdversaryView, strategy: string | null): string {
  if (strategy === null) return ADVERSARY_HEADING;
  const m = s.method !== null && s.method.method.strategy_id === strategy ? s.method.method : s.overview?.roster.find((r) => r.strategy_id === strategy);
  return m ? methodHeading(m.name) : ADVERSARY_HEADING;
}

/** The wall header's count line for /adversary[/<id>]. */
export function adversaryCountLine(s: AdversaryView, strategy: string | null, now: Date): string {
  if (strategy === null) return overviewCountLine(s.overview, s.overviewError, now);
  if (s.methodError !== null) return errorText(s.methodError, strategy);
  if (s.method === null || s.method.method.strategy_id !== strategy) return `Loading ${strategy}.`;
  return methodCountLine(s.method);
}

/** Focus mode's one-line status beside the small heading. */
export function focusLine(toggle: AdversaryToggle | null, overview: OverviewPayload | null): string {
  if (toggle === null) return '';
  if (toggle.on) return 'auto-runs on';
  const paused = (overview?.methods ?? []).reduce((n, m) => n + m.coverage.paused, 0);
  const since = toggle.changed_at ? ` since ${clockTime(toggle.changed_at)}` : '';
  return `auto-runs off${since} · twins copy their originals until it is back on · ${paused} ${paused === 1 ? 'decision' : 'decisions'} paused`;
}

/**
 * The chat bar has no page field (POST /api/chat carries message, thread_id, image_ids and a repo
 * `project`, which means a Claude Code repository). The page's context rides on the message's first
 * line instead, where the chat agent reads it together with the adversary_* MCP tools (phase 5).
 */
export function adversaryChatMessage(text: string, strategy: string | null): string {
  return `[Seer Adversarial · ${strategy ?? 'overview'}]\n${text}`;
}

/** A row's two critics: Claude blocks on a timely objection; C blocks on a veto or a failed check (no trade). */
export function claudeBlocks(r: ThreeWayRow): boolean {
  return r.claude !== null && r.claude.verdict === 'object' && !r.claude.late;
}

export function criticBlocks(r: ThreeWayRow): boolean {
  return r.c !== null && r.c.verdict !== 'allow';
}

export interface Disagreement {
  bothBlock: string[];
  claudeOnly: string[];
  criticOnly: string[];
  bothKeep: string[];
}

export function disagreement(rows: readonly ThreeWayRow[]): Disagreement {
  const out: Disagreement = { bothBlock: [], claudeOnly: [], criticOnly: [], bothKeep: [] };
  for (const r of rows) {
    const a = claudeBlocks(r);
    const c = criticBlocks(r);
    if (a && c) out.bothBlock.push(r.symbol);
    else if (a) out.claudeOnly.push(r.symbol);
    else if (c) out.criticOnly.push(r.symbol);
    else out.bothKeep.push(r.symbol);
  }
  return out;
}
```

### Step 7: Data store hook
**File:** `web/src/hooks/useAdversary.ts` (create)
**Code:**
```ts
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
import { fetchMethod, fetchOverview, fetchToggle, postReviewNow, saveToggle, type AdversaryToggle, type MethodPayload, type OverviewPayload, type ReviewNowResult } from '../adversaryApi';
import { subscribeEvents } from '../lib/events';

/** Same cadence as the wall: picks up a verdict or toggle written by the daemon on the other laptop. */
export const ADVERSARY_POLL_MS = 60_000;

export interface AdversaryStore {
  overview: OverviewPayload | null;
  overviewError: string | null;
  /** The detail of the strategy asked for (null while loading or on the overview). */
  method: MethodPayload | null;
  methodError: string | null;
  /** null until the first GET answers. */
  toggle: AdversaryToggle | null;
  /** PUT the auto-runs switch. False when the server refused (the old state is kept). */
  setAuto: (on: boolean) => Promise<boolean>;
  /**
   * Starts one review pass, even while auto-runs are off. Resolves as soon as phase 5 answers 202
   * `{started, reason}`; the pass itself is never awaited (its verdicts arrive as SSE `adversary`
   * events, which refresh this store). Throws ApiError on refusal.
   */
  reviewNow: (strategyId: string | null) => Promise<ReviewNowResult>;
  refresh: () => void;
}

function codeOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Seer Adversarial's data. Fetches only while `enabled` (the page is shown): the overview (the
 * sidebar roster and the header need it on every sub-page), the toggle, and the method of `strategy`.
 * Refreshes on the SSE `adversary` event (phase 5) and every 60 s.
 */
export function useAdversary(enabled: boolean, strategy: string | null): AdversaryStore {
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [method, setMethod] = useState<MethodPayload | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  const [toggle, setToggle] = useState<AdversaryToggle | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const off = subscribeEvents('adversary', () => refresh());
    const poll = window.setInterval(refresh, ADVERSARY_POLL_MS);
    return () => {
      off();
      window.clearInterval(poll);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetchOverview(ac.signal).then(
      (o) => {
        if (ac.signal.aborted) return;
        setOverview(o);
        setOverviewError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setOverviewError(codeOf(e));
      },
    );
    fetchToggle(ac.signal).then(
      (t) => {
        if (!ac.signal.aborted) setToggle(t);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) console.error('adversary: toggle GET failed', e);
      },
    );
    return () => ac.abort();
  }, [enabled, tick]);

  // A switch to another method drops the old detail at once, so its numbers never show under the new heading.
  useEffect(() => {
    setMethod((m) => (m !== null && m.method.strategy_id === strategy ? m : null));
    setMethodError(null);
  }, [strategy]);

  useEffect(() => {
    if (!enabled || strategy === null) return;
    const ac = new AbortController();
    fetchMethod(strategy, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        setMethod(d);
        setMethodError(null);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setMethodError(codeOf(e));
      },
    );
    return () => ac.abort();
  }, [enabled, strategy, tick]);

  const setAuto = useCallback(async (on: boolean): Promise<boolean> => {
    try {
      setToggle(await saveToggle(on));
      return true;
    } catch (e) {
      console.error('adversary: toggle PUT failed', e);
      return false;
    }
  }, []);

  const reviewNow = useCallback((strategyId: string | null) => postReviewNow(strategyId), []);

  return { overview, overviewError, method, methodError, toggle, setAuto, reviewNow, refresh };
}
```

### Step 8: Shared parts
**File:** `web/src/components/adversary/parts.tsx` (create)
**Code:**
```tsx
import type { ReactNode } from 'react';
import type { AdversarySource, AdversaryVerdict, ChecklistItem, Coverage, VerdictKind } from '../../adversaryApi';
import { CHECK_WORD, clockTime, coverageLabel, coverageTotal, sourceHost, sourceLabel, weightChange } from '../../lib/adversary';

export const VERDICT_WORD: Record<VerdictKind, string> = { object: 'object', agree: 'agree', unsure: "can't tell" };
const VERDICT_CLASS: Record<VerdictKind, string> = { object: 'adv-chip obj', agree: 'adv-chip ok', unsure: 'adv-chip unsure' };

export function VerdictChip({ verdict }: { verdict: VerdictKind }) {
  return <span className={VERDICT_CLASS[verdict]}>{VERDICT_WORD[verdict]}</span>;
}

/** A section label with a hairline running to the right edge. */
export function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="adv-divider">
      <span>{children}</span>
    </div>
  );
}

function SourceLink({ s, children }: { s: AdversarySource; children: ReactNode }) {
  return (
    <a href={s.url} target="_blank" rel="noreferrer" data-tip={s.fetched_at === null ? 'fetched' : `fetched ${clockTime(s.fetched_at)}`}>
      {children}
    </a>
  );
}

/** Compact sources: one domain per link. */
export function SourceLinks({ sources }: { sources: readonly AdversarySource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="adv-src">
      {sources.map((s, i) => (
        <SourceLink key={`${i}-${s.url}`} s={s}>
          {sourceHost(s)}
        </SourceLink>
      ))}
    </div>
  );
}

/** Numbered sources: `publisher · title`. */
export function NumberedSources({ sources }: { sources: readonly AdversarySource[] }) {
  if (sources.length === 0) return null;
  return (
    <ol className="adv-srcs">
      {sources.map((s, i) => (
        <li key={`${i}-${s.url}`}>
          <SourceLink s={s}>{sourceLabel(s)}</SourceLink>
        </li>
      ))}
    </ol>
  );
}

export interface VerdictCardProps {
  v: AdversaryVerdict;
  /** Right of the chip: `A · Nov 4` on the overview, `held · sell` on a method page. */
  tag: string;
  /** Method page: numbered sources and the weight / time / host footer. */
  detailed?: boolean;
}

export function VerdictCard({ v, tag, detailed = false }: VerdictCardProps) {
  return (
    <article className={v.late ? 'adv-card late' : 'adv-card'} data-verdict={v.verdict} data-symbol={v.symbol}>
      <div className="adv-card-head">
        <span className="adv-sym">{v.symbol}</span>
        <VerdictChip verdict={v.verdict} />
        <span className="adv-push adv-meta">{tag}</span>
      </div>
      <p className="adv-reason">{v.reason}</p>
      {detailed ? <NumberedSources sources={v.sources} /> : <SourceLinks sources={v.sources} />}
      {detailed && (
        <div className="adv-card-foot">
          <span>{weightChange(v)}</span>
          <span className="adv-push">
            {v.late ? 'late · not used · ' : ''}
            {clockTime(v.decided_at)} · {v.host}
          </span>
        </div>
      )}
    </article>
  );
}

/** reviewed · absent · paused · pending (session not open yet), as one bar with its label under it. */
export function CoverageBar({ coverage, engine, cadence }: { coverage: Coverage; engine: 'bracket' | 'book'; cadence: string | null }) {
  const total = coverageTotal(coverage) + coverage.pending;
  const label = coverageLabel(coverage, engine, cadence);
  return (
    <span className="adv-cov">
      <span className="adv-cov-bar" role="img" aria-label={`reviewed ${coverage.reviewed}, absent ${coverage.absent}, paused ${coverage.paused}, pending ${coverage.pending}`}>
        {total === 0 ? (
          <span className="adv-cov-empty" />
        ) : (
          <>
            {coverage.reviewed > 0 && <span className="adv-cov-reviewed" style={{ flex: coverage.reviewed }} />}
            {coverage.absent > 0 && <span className="adv-cov-absent" style={{ flex: coverage.absent }} />}
            {coverage.paused > 0 && <span className="adv-cov-paused" style={{ flex: coverage.paused }} />}
            {coverage.pending > 0 && <span className="adv-cov-pending" style={{ flex: coverage.pending }} />}
          </>
        )}
      </span>
      <span className="adv-meta">{label}</span>
    </span>
  );
}

/** Five go-live rules as dots, in rule order. */
export function ChecklistDots({ items, who }: { items: readonly ChecklistItem[]; who: string }) {
  const sorted = items.slice().sort((a, b) => a.rule - b.rule);
  const passed = sorted.filter((i) => i.state === 'pass').length;
  return (
    <span className="adv-dots" role="img" aria-label={`${who}: ${passed} of ${sorted.length} go-live rules passed`} data-who={who}>
      {sorted.map((i) => (
        <span key={i.rule} className={`adv-dot ${i.state}`} data-tip={`${i.rule} · ${i.label}: ${CHECK_WORD[i.state]}`} />
      ))}
    </span>
  );
}

export function DotLegend() {
  return (
    <>
      <span className="adv-key-row">
        <span className="adv-dot pass" />
        passed
      </span>
      <span className="adv-key-row">
        <span className="adv-dot fail" />
        not yet / failed
      </span>
      <span className="adv-key-row">
        <span className="adv-dot na" />
        no backtest possible for Claude
      </span>
    </>
  );
}

export function CoverageLegend() {
  return (
    <>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-reviewed" />
        reviewed
      </span>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-absent" />
        absent: no laptop had WSL up
      </span>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-paused" />
        paused: you turned auto-runs off
      </span>
      <span className="adv-key-row">
        <span className="adv-swatch adv-cov-pending" />
        pending: the session has not opened yet
      </span>
    </>
  );
}
```

### Step 9: Curves chart (plain SVG)
**File:** `web/src/components/adversary/CurvesChart.tsx` (create)
**Code:**
```tsx
import type { Curves } from '../../adversaryApi';
import { shortDate } from '../../lib/adversary';

const W = 800;
const H = 220;
const TOP = 12;
const BOTTOM = 208;

function lastValue(vals: readonly (number | null)[]): number | null {
  for (let i = vals.length - 1; i >= 0; i--) {
    const v = vals[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Original (dashed), Claude twin (solid) and SPY (dotted), growth of 100 with deposits taken out. */
export function CurvesChart({ curves }: { curves: Curves | null }) {
  // Phase 5 sends null until the twin has a snapshot.
  if (curves === null) return <p className="adv-empty">The curves start once the twin has two sessions on paper.</p>;
  const n = curves.dates.length;
  const values = [...curves.twin, ...curves.original, ...curves.spy].filter((v): v is number => v !== null);
  if (n < 2 || values.length === 0) return <p className="adv-empty">The curves start once the twin has two sessions on paper.</p>;
  const lo = Math.min(100, ...values);
  const hi = Math.max(100, ...values);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => BOTTOM - ((v - lo) / span) * (BOTTOM - TOP);
  const points = (vals: readonly (number | null)[]) =>
    vals.flatMap((v, i) => (v === null ? [] : [`${x(i).toFixed(1)},${y(v).toFixed(1)}`])).join(' ');
  const fmt = (v: number | null) => (v === null ? 'no value' : v.toFixed(1));
  const label = `Claude twin ends at ${fmt(lastValue(curves.twin))}, original at ${fmt(lastValue(curves.original))}, SPY at ${fmt(lastValue(curves.spy))}`;
  const first = curves.dates[0] ?? '';
  const mid = curves.dates[Math.floor((n - 1) / 2)] ?? '';
  const last = curves.dates[n - 1] ?? '';
  return (
    <figure className="adv-chart">
      <div className="adv-legend">
        <span className="adv-key-row">
          <span className="adv-key twin" />
          Claude twin
        </span>
        <span className="adv-key-row">
          <span className="adv-key orig" />
          original
        </span>
        <span className="adv-key-row">
          <span className="adv-key spy" />
          SPY
        </span>
        <span className="adv-push">
          growth of 100, deposits taken out · {shortDate(first)} → {shortDate(last)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <line className="adv-base" x1="0" x2={W} y1={y(100)} y2={y(100)} vectorEffect="non-scaling-stroke" />
        <polyline className="adv-line spy" points={points(curves.spy)} vectorEffect="non-scaling-stroke" />
        <polyline className="adv-line orig" points={points(curves.original)} vectorEffect="non-scaling-stroke" />
        <polyline className="adv-line twin" points={points(curves.twin)} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="adv-axis">
        <span>{shortDate(first)}</span>
        <span>{shortDate(mid)}</span>
        <span>{shortDate(last)}</span>
      </div>
    </figure>
  );
}
```

### Step 10: Overview layout
**File:** `web/src/components/adversary/AdversaryOverview.tsx` (create)
**Code:**
```tsx
import type { MouseEvent } from 'react';
import type { MethodRow, OverviewPayload } from '../../adversaryApi';
import { causeTiles, objectionsLine, pct, rosterNames, shortDate } from '../../lib/adversary';
import { adversaryHref } from '../../lib/route';
import { ChecklistDots, CoverageBar, CoverageLegend, Divider, DotLegend, VerdictCard } from './parts';

export interface AdversaryOverviewProps {
  overview: OverviewPayload;
  onPick: (strategyId: string) => void;
}

/** A plain click opens the method in place; Ctrl/Meta/Shift/middle click keeps the browser's own link behaviour. */
function pickHandler(id: string, onPick: (strategyId: string) => void) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onPick(id);
  };
}

function twinClass(m: MethodRow): string {
  const { original, twin } = m.returns;
  return original !== null && twin !== null && twin > original ? 'adv-num hi' : 'adv-num lo';
}

export function AdversaryOverview({ overview, onPick }: AdversaryOverviewProps) {
  const names = rosterNames(overview.roster);
  const tiles = causeTiles(overview.cause, names);
  return (
    <div className="adv-overview">
      <section className="adv-cause" aria-label="Seer's cause">
        {tiles.map((t) => (
          <div key={t.key} className="adv-tile" data-tile={t.key}>
            <span className="adv-meta">{t.label}</span>
            <span className="adv-big">{t.value}</span>
            <span className="adv-text">{t.text}</span>
          </div>
        ))}
      </section>

      <section className="adv-methods" aria-label="Methods">
        <div className="adv-thead adv-grid7">
          <span>method</span>
          <span>original</span>
          <span>Claude twin</span>
          <span>SPY</span>
          <span>objections</span>
          <span>reviewed · absent · paused · pending</span>
          <span>go-live, orig / twin</span>
        </div>
        {overview.methods.length === 0 ? (
          <p className="adv-empty">No method on Seer's roster has a Claude twin yet. A twin appears the night after a method is admitted.</p>
        ) : (
          overview.methods.map((m) => (
            <a
              key={m.strategy_id}
              className="adv-row adv-grid7"
              href={adversaryHref({ strategy: m.strategy_id, focus: false })}
              data-strategy={m.strategy_id}
              onClick={pickHandler(m.strategy_id, onPick)}
            >
              <span className="adv-name">
                <span className="adv-title">
                  {m.name}
                  {m.cadence && <span className="adv-chip ok">{m.cadence}</span>}
                </span>
                {m.sub && <span className="adv-sub">{m.sub}</span>}
              </span>
              <span className="adv-num">{pct(m.returns.original)}</span>
              <span className={twinClass(m)}>{pct(m.returns.twin)}</span>
              <span className="adv-num lo">{pct(m.returns.spy)}</span>
              <span className="adv-obj">
                {objectionsLine(m.objections)}
                {m.objections.fell_after !== null && <span className="adv-meta">{m.objections.fell_after} fell after</span>}
              </span>
              <CoverageBar coverage={m.coverage} engine={m.engine} cadence={m.cadence} />
              <span className="adv-checks2">
                <ChecklistDots items={m.checklist.original} who="original" />
                <ChecklistDots items={m.checklist.twin} who="Claude twin" />
              </span>
            </a>
          ))
        )}
        <div className="adv-legend">
          <span>returns are money-weighted, deposits included, over each twin's own record</span>
          <DotLegend />
        </div>
        <div className="adv-legend">
          <CoverageLegend />
        </div>
      </section>

      <section className="adv-latest" aria-label="Latest objections">
        <Divider>latest objections</Divider>
        {overview.latest.length === 0 ? (
          <p className="adv-empty">No objections yet.</p>
        ) : (
          <div className="adv-cards">
            {overview.latest.map((v) => (
              <VerdictCard key={v.id} v={v} tag={`${names.get(v.strategy_id) ?? v.strategy_id} · ${shortDate(v.session_date)}`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
```

### Step 11: Method layout
**File:** `web/src/components/adversary/AdversaryMethod.tsx` (create)
**Code:**
```tsx
import { useState } from 'react';
import type { AdversaryDecision, ChecklistItem, MethodPayload, MethodStats, VerdictKind } from '../../adversaryApi';
import { checkValue, clockTime, dropPct, heldTag, pct, ratio, shortDate, shortName, TWIN_BACKTEST_NOTE, usd } from '../../lib/adversary';
import { CurvesChart } from './CurvesChart';
import { Divider, VERDICT_WORD, VerdictCard } from './parts';

const FILTER_ORDER: VerdictKind[] = ['object', 'unsure', 'agree'];
const AGREE_CHIPS = 15;

function StatsTable({ stats }: { stats: MethodPayload['stats'] }) {
  // Each column is null until that book has a record over the twin's window (phase 5): it reads '—'.
  const cell = (s: MethodStats | null, f: (s: MethodStats) => string) => (s === null ? '—' : f(s));
  const row = (label: string, f: (s: MethodStats) => string) => (
    <div className="adv-stat">
      <span className="adv-stat-l">{label}</span>
      <span>{cell(stats.original, f)}</span>
      <span className="hi">{cell(stats.twin, f)}</span>
      <span className="lo">{cell(stats.spy, f)}</span>
    </div>
  );
  const fees = (s: MethodStats) => (s.fees_usd === null ? '—' : usd(s.fees_usd).replace(/^\+/, ''));
  const twinFees = stats.twin?.fees_usd ?? null;
  const origFees = stats.original?.fees_usd ?? null;
  const moreFees = twinFees !== null && origFees !== null && twinFees > origFees;
  return (
    <div className="adv-stats">
      <div className="adv-stat adv-stat-h">
        <span />
        <span>original</span>
        <span>twin</span>
        <span>SPY</span>
      </div>
      {row('return', (s) => pct(s.return))}
      {row('worst drop', (s) => dropPct(s.worst_drop))}
      {row('wins ÷ losses', (s) => ratio(s.profit_factor))}
      {row('fees paid', fees)}
      {moreFees && <p className="adv-note-p">The twin pays more in fees: every objection to a stock the book already holds is a sale.</p>}
    </div>
  );
}

function CheckCard({ original, twin }: { original: ChecklistItem; twin: ChecklistItem | undefined }) {
  return (
    <div className="adv-check" data-rule={original.rule}>
      <span className="adv-meta">
        {original.rule} · {original.label}
      </span>
      <div className="adv-check-row">
        <span>original</span>
        <span className="adv-mono">{checkValue(original)}</span>
      </div>
      {twin && (
        <div className="adv-check-row">
          <span>twin</span>
          <span className="adv-mono">{checkValue(twin)}</span>
        </div>
      )}
      {original.progress !== null && (
        <div className="adv-progress">
          <div style={{ width: `${Math.round(Math.min(1, Math.max(0, original.progress)) * 100)}%` }} />
        </div>
      )}
      {twin?.state === 'na' && <span className="adv-check-note">{TWIN_BACKTEST_NOTE}</span>}
    </div>
  );
}

function decisionLine(d: AdversaryDecision): string {
  const parts = [`${shortDate(d.session_date).toLowerCase()} decision`];
  if (d.first_started_at && d.last_decided_at) parts.push(`reviewed ${clockTime(d.first_started_at).toLowerCase()} – ${clockTime(d.last_decided_at).toLowerCase()}`);
  if (d.models.length > 0) parts.push(d.models.join(', '));
  if (d.prompt_versions.length > 0) parts.push(`prompt ${d.prompt_versions.join(', ')}`);
  return parts.join(' · ');
}

function initialFilter(d: AdversaryDecision): VerdictKind {
  return FILTER_ORDER.find((k) => d.verdicts.some((v) => v.verdict === k)) ?? 'object';
}

function Decision({ d }: { d: AdversaryDecision }) {
  const [filter, setFilter] = useState<VerdictKind>(() => initialFilter(d));
  const shown = d.verdicts.filter((v) => v.verdict === filter);
  const agree = d.verdicts.filter((v) => v.verdict === 'agree');
  const weights = new Set(agree.map((v) => v.twin_weight).filter((w): w is number => w !== null));
  const each = weights.size === 1 ? `, each to ${(([...weights][0] ?? 0) * 100).toFixed(1)}%` : '';
  return (
    <section className="adv-decision" aria-label={`${shortDate(d.session_date)} decision`}>
      <Divider>{decisionLine(d)}</Divider>
      {d.verdicts.length === 0 ? (
        <p className="adv-empty">
          {d.coverage === 'paused'
            ? 'Paused: auto-runs were off, so the twin copies the original.'
            : d.coverage === 'pending'
              ? 'Not reviewed yet. Claude has until the session opens.'
              : 'No review before the open, so the twin copies the original.'}
        </p>
      ) : (
        <>
          <div className="adv-filter" role="group" aria-label="Filter verdicts">
            {FILTER_ORDER.map((k) => (
              <button key={k} type="button" className={filter === k ? 'adv-fpill on' : 'adv-fpill'} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {VERDICT_WORD[k]} {d.verdicts.filter((v) => v.verdict === k).length}
              </button>
            ))}
          </div>
          <div className="adv-verdicts">
            {shown.map((v) => (
              <VerdictCard key={v.id} v={v} tag={heldTag(v)} detailed />
            ))}
          </div>
          {filter !== 'agree' && agree.length > 0 && (
            <div className="adv-agree">
              <span className="adv-meta">agree{each}</span>
              {agree.slice(0, AGREE_CHIPS).map((v) => (
                <span key={v.id} className="adv-chip ok">
                  {v.symbol}
                </span>
              ))}
              {agree.length > AGREE_CHIPS && <span className="adv-chip ok">+{agree.length - AGREE_CHIPS}</span>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RecordDots({ record, name }: { record: MethodPayload['record']; name: string }) {
  const pts = record.points;
  if (pts.length === 0) {
    return (
      <section className="adv-record" aria-label="Claude's record">
        <Divider>claude's record on {name.toLowerCase()} · each dot is one objection</Divider>
        <p className="adv-empty">No objection has run its course yet.</p>
      </section>
    );
  }
  const right = pts.filter((p) => p.gap_pts < 0).length;
  const avg = pts.reduce((s, p) => s + p.gap_pts, 0) / pts.length;
  const maxAbs = Math.max(1, ...pts.map((p) => Math.abs(p.gap_pts)));
  const cx = (gap: number) => 400 + (Math.max(-maxAbs, Math.min(maxAbs, gap)) / maxAbs) * 380;
  return (
    <section className="adv-record" aria-label="Claude's record">
      <Divider>claude's record on {name.toLowerCase()} · each dot is one objection</Divider>
      <div className="adv-record-body">
        <div className="adv-record-plot">
          <svg viewBox="0 0 800 70" role="img" aria-label={`${right} of ${pts.length} objected stocks did worse than the picks that were kept`}>
            <line x1="400" y1="6" x2="400" y2="64" className="adv-mid" />
            {pts.map((p, i) => (
              <circle key={`${p.symbol}-${p.session_date}-${i}`} cx={cx(p.gap_pts)} cy="35" r="5" className={p.gap_pts < 0 ? 'adv-hit' : 'adv-miss'}>
                <title>{`${p.symbol} · ${shortDate(p.session_date)} · ${p.gap_pts.toFixed(1)} pts`}</title>
              </circle>
            ))}
          </svg>
          <div className="adv-axis">
            <span>did worse than the kept picks</span>
            <span>same</span>
            <span>did better</span>
          </div>
        </div>
        <div className="adv-record-sum">
          <span className="adv-big">
            {right} of {pts.length} right
          </span>
          <span className="adv-text">
            Over {record.horizon || 'the horizon'} after each objection, the stocks Claude dropped {avg <= 0 ? 'trailed' : 'beat'} the ones it kept by {Math.abs(avg).toFixed(1)} points on average.
            {pts.length < 30 ? ` ${pts.length} calls is still too few to tell skill from luck.` : ''}
          </span>
        </div>
      </div>
    </section>
  );
}

export function Revisions({ revisions }: { revisions: MethodPayload['revisions'] }) {
  return (
    <section className="adv-revs" aria-label="Prompt and model revisions">
      <Divider>revisions · a new line starts whenever the model or the instructions change</Divider>
      {revisions.length === 0 ? (
        <p className="adv-empty">No review has run yet.</p>
      ) : (
        revisions.map((r, i) => (
          <div key={`${r.prompt_version}-${r.since}`} className={i === 0 ? 'adv-rev' : 'adv-rev old'}>
            <span className="adv-dim">{r.until ? `${shortDate(r.since)} – ${shortDate(r.until)}` : `since ${shortDate(r.since)}`}</span>
            <span>
              {r.prompt_version} · {r.model}
            </span>
            {/* Revision.note is always null (phase 5 stores no change note); show what is stored instead. */}
            <span className="adv-rev-note">
              lens {r.lens} · {r.verdicts} {r.verdicts === 1 ? 'verdict' : 'verdicts'}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

export function AdversaryMethod({ detail }: { detail: MethodPayload }) {
  const name = shortName(detail.method.name);
  const twinItems = new Map(detail.checklist.twin.map((i) => [i.rule, i]));
  const original = detail.checklist.original.slice().sort((a, b) => a.rule - b.rule);
  return (
    <div className="adv-method">
      <section className="adv-h2h" aria-label="Original against Claude twin">
        <CurvesChart curves={detail.curves} />
        <StatsTable stats={detail.stats} />
      </section>
      <section className="adv-checklist" aria-label="Go-live checklist">
        <Divider>go-live checklist · Seer's bar for real money</Divider>
        <div className="adv-checks">
          {original.map((item) => (
            <CheckCard key={item.rule} original={item} twin={twinItems.get(item.rule)} />
          ))}
        </div>
      </section>
      {detail.decision === null ? (
        <section className="adv-decision" aria-label="Decision">
          <Divider>decision</Divider>
          <p className="adv-empty">No verdicts yet. Claude reviews this method's next decision after Seer's nightly.</p>
        </section>
      ) : (
        <Decision key={detail.decision.session_date} d={detail.decision} />
      )}
      <RecordDots record={detail.record} name={name} />
      <Revisions revisions={detail.revisions} />
    </div>
  );
}
```

### Step 12: Daily three-way layout
**File:** `web/src/components/adversary/AdversaryDaily.tsx` (create)
**Code:**
```tsx
import type { CVerdict, MethodPayload, ThreeWay, ThreeWayBook } from '../../adversaryApi';
import { claudeBlocks, criticBlocks, disagreement, dropPct, pct, plainName, ratio, shortDate, shortName } from '../../lib/adversary';
import { Revisions } from './AdversaryMethod';
import { Divider, SourceLinks, VerdictChip } from './parts';

const C_CLASS: Record<CVerdict, string> = { veto: 'adv-chip obj', allow: 'adv-chip ok', failed: 'adv-chip unsure' };

/** One of the three books. `book` is null until that book has a record (the twin decides a night late). */
function Book({ id, title, sub, book, inverted = false }: { id: string | null; title: string; sub: string; book: ThreeWayBook | null; inverted?: boolean }) {
  return (
    <div className={inverted ? 'adv-book inv' : 'adv-book'} data-strategy={book?.strategy_id ?? id ?? ''}>
      <div className="adv-book-head">
        <span className="adv-book-t">{title}</span>
        <span className="adv-book-s">{sub}</span>
      </div>
      {book === null ? (
        <span className="adv-meta">no record yet</span>
      ) : (
        <>
          <span className="adv-book-n">{pct(book.return)}</span>
          <div className="adv-book-stats">
            <span>trades</span>
            <span>{book.trades}</span>
            <span>wins ÷ losses</span>
            <span>{ratio(book.profit_factor)}</span>
            <span>worst drop</span>
            <span>{dropPct(book.worst_drop)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** A book's order for this name: true buys, false does not, null has not decided the session yet. */
function BuyDot({ who, buys }: { who: string; buys: boolean | null }) {
  if (buys === null) return <span className="adv-buy-pending" data-tip={`${who} has not decided yet`} />;
  return <span className={buys ? 'adv-buy' : 'adv-nobuy'} data-tip={`${who} ${buys ? 'buys' : 'does not buy'}`} />;
}

function Cell({ n, symbols, inverted }: { n: number; symbols: string[]; inverted: boolean }) {
  return (
    <div className={inverted ? 'adv-cell inv' : 'adv-cell'}>
      <span className="adv-cell-n">{n}</span>
      <span className="adv-cell-s">{symbols.join(' ')}</span>
    </div>
  );
}

function Grid({ tw }: { tw: ThreeWay }) {
  const d = disagreement(tw.rows);
  const critic = shortName(tw.critic.name);
  return (
    <div className="adv-grid-wrap">
      <Divider>tonight · where they disagree</Divider>
      <div className="adv-grid" role="table" aria-label="Where the critics disagree">
        <span />
        <span className="adv-meta">{critic} vetoes</span>
        <span className="adv-meta">{critic} allows</span>
        <span className="adv-meta adv-grid-l">Claude objects</span>
        <Cell n={d.bothBlock.length} symbols={d.bothBlock} inverted={false} />
        <Cell n={d.claudeOnly.length} symbols={d.claudeOnly} inverted />
        <span className="adv-meta adv-grid-l">Claude lets it in</span>
        <Cell n={d.criticOnly.length} symbols={d.criticOnly} inverted />
        <Cell n={d.bothKeep.length} symbols={d.bothKeep} inverted={false} />
      </div>
    </div>
  );
}

function WhoWasRight({ tw, horizon }: { tw: ThreeWay; horizon: string }) {
  const critic = shortName(tw.critic.name);
  const s = tw.settled;
  return (
    <div className="adv-right">
      <Divider>after {horizon || 'the horizon'} · who was right when they disagreed</Divider>
      {s === null || s.disagreements === 0 ? (
        <p className="adv-empty">No disagreement has run its course yet.</p>
      ) : (
        <>
          <div className="adv-bar-row">
            <div className="adv-bar-l">
              <span>Claude's calls against {critic}</span>
              <span className="adv-mono">
                {s.claude_right} of {s.disagreements}
              </span>
            </div>
            <div className="adv-meter">
              <div style={{ width: `${Math.round((s.claude_right / s.disagreements) * 100)}%` }} />
            </div>
          </div>
          <div className="adv-bar-row">
            <div className="adv-bar-l">
              <span>
                {critic}'s calls against Claude
              </span>
              <span className="adv-mono">
                {s.critic_right} of {s.disagreements}
              </span>
            </div>
            <div className="adv-meter dim">
              <div style={{ width: `${Math.round((s.critic_right / s.disagreements) * 100)}%` }} />
            </div>
          </div>
        </>
      )}
      <p className="adv-note-p">Only the nights they disagree can tell them apart. A stock counts as rightly blocked if it did worse over {horizon || 'the horizon'} than the picks that were bought.</p>
    </div>
  );
}

/** A bracket original with a C sibling: three books, one ranked list, two critics side by side. */
export function AdversaryDaily({ detail, tw }: { detail: MethodPayload; tw: ThreeWay }) {
  const name = shortName(detail.method.name);
  const critic = shortName(tw.critic.name);
  const criticSub = plainName(tw.critic.name).toLowerCase() || 'vetoes';
  return (
    <div className="adv-daily">
      <section className="adv-three" aria-label={`${name}, ${critic} and Claude compared`}>
        <Divider>three books, one list · money-weighted over each book's own record</Divider>
        <div className="adv-books">
          <Book id={tw.original.strategy_id} title={name} sub="buys the list as ranked" book={tw.books.original} />
          <Book id={tw.critic.strategy_id} title={critic} sub={criticSub} book={tw.books.critic} />
          <Book id={tw.twin_id} title={`${name} + Claude`} sub="Claude objects" book={tw.books.twin} inverted />
        </div>
      </section>

      <section className="adv-list" aria-label={tw.session_date ? `Ranked list for ${shortDate(tw.session_date)}` : 'Ranked list'}>
        <Divider>
          {tw.session_date ? `${shortDate(tw.session_date).toLowerCase()} · ` : ''}
          {name.toLowerCase()}'s ranked {tw.rows.length} · decided before the open
        </Divider>
        {tw.rows.length === 0 ? (
          <p className="adv-empty">No candidates yet. They arrive with Seer's nightly.</p>
        ) : (
          <>
            <div className="adv-cand adv-cand-h">
              <span>#</span>
              <span>stock</span>
              <span>{critic} · its checks</span>
              <span>Claude</span>
              <span>buys · {name} {critic} +</span>
            </div>
            {tw.rows.map((r) => (
              <div key={r.symbol} className="adv-cand" data-symbol={r.symbol} data-claude-blocks={claudeBlocks(r)} data-critic-blocks={criticBlocks(r)}>
                <span className="adv-meta">{r.rank}</span>
                <span className="adv-cand-sym">{r.symbol}</span>
                <div className="adv-cand-v">
                  {r.c === null ? (
                    <span className="adv-meta">no verdict</span>
                  ) : (
                    <>
                      <span className={C_CLASS[r.c.verdict]}>{r.c.verdict}</span>
                      <span className="adv-cand-r dim">{r.c.reason}</span>
                    </>
                  )}
                </div>
                <div className="adv-cand-v">
                  {r.claude === null ? (
                    <span className="adv-meta">absent</span>
                  ) : (
                    <>
                      <VerdictChip verdict={r.claude.verdict} />
                      <span className="adv-cand-r">{r.claude.reason}</span>
                      <SourceLinks sources={r.claude.sources} />
                      {r.claude.late && <span className="adv-meta">late · not used</span>}
                    </>
                  )}
                </div>
                <span className="adv-buys">
                  <BuyDot who={name} buys={r.buys.original} />
                  <BuyDot who={critic} buys={r.buys.critic} />
                  <BuyDot who={`${name} + Claude`} buys={r.buys.twin} />
                </span>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="adv-split" aria-label="Where the critics disagree">
        <Grid tw={tw} />
        <WhoWasRight tw={tw} horizon={detail.record.horizon} />
      </section>
      <Revisions revisions={detail.revisions} />
    </div>
  );
}
```

### Step 13: Chat pill
**File:** `web/src/components/adversary/AdversaryPill.tsx` (create)
**Code:**
```tsx
import { useState, type FormEvent } from 'react';
import { useChatImages } from '../../hooks/useChatImages';
import { PILL_PLACEHOLDER } from '../../lib/adversary';
import { ChatBar } from '../ChatBar';

export interface AdversaryPillProps {
  /** Sends one question through the wall's chat (App wraps it with the page context). */
  onAsk: (text: string, imageIds: string[]) => void;
}

/**
 * "Ask about Seer Adversarial": the dark pill pinned to the bottom of the page, ChatBar's page
 * variant with its own draft (the pattern of projectChat/ProjectPillQueryInput). The answer shows in
 * the wall's answer panel, which stays visible on this page.
 */
export function AdversaryPill({ onAsk }: AdversaryPillProps) {
  const images = useChatImages();
  const [draft, setDraft] = useState('');
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (images.blocked) return;
    const ids = images.readyIds;
    if (!draft.trim() && ids.length === 0) return;
    onAsk(draft, ids);
    setDraft('');
    images.clear();
  };
  return (
    <div className="adv-pill" data-testid="adversary-pill">
      <ChatBar
        variant="page"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        images={images.images}
        onPasteFiles={images.add}
        onRemoveImage={images.remove}
        sendBlocked={images.blocked}
        placeholder={PILL_PLACEHOLDER}
      />
    </div>
  );
}
```

### Step 14: Sidebar roster list
**File:** `web/src/components/adversary/RosterList.tsx` (create)
**Code:**
```tsx
import type { AdversaryMethod } from '../../adversaryApi';
import { shortDate } from '../../lib/adversary';

export interface RosterListProps {
  /** null while loading. */
  roster: AdversaryMethod[] | null;
  /** The method shown; null = Overview. */
  strategy: string | null;
  onPick: (strategyId: string | null) => void;
}

/** Seer's roster in the sidebar, as Projects lists repos: Overview first, active methods, retired greyed below. */
export function RosterList({ roster, strategy, onPick }: RosterListProps) {
  if (roster === null) return <span className="side-note">loading</span>;
  const active = roster.filter((r) => r.status === 'active');
  const retired = roster
    .filter((r) => r.status === 'retired')
    .slice()
    .sort((a, b) => (b.paper_end ?? '').localeCompare(a.paper_end ?? ''));
  const row = (r: AdversaryMethod, right: string) => (
    <div
      key={r.strategy_id}
      role="listitem"
      data-strategy={r.strategy_id}
      className={r.strategy_id === strategy ? 'tagrow on' : 'tagrow'}
      aria-current={r.strategy_id === strategy ? 'true' : undefined}
      onClick={() => onPick(r.strategy_id)}
    >
      <span className="repo-name">{r.name}</span>
      <span className="n">{right}</span>
    </div>
  );
  return (
    <>
      <div className="side-repos" role="list" aria-label="Seer roster">
        <div role="listitem" data-strategy="" className={strategy === null ? 'tagrow on' : 'tagrow'} aria-current={strategy === null ? 'true' : undefined} onClick={() => onPick(null)}>
          <span>Overview</span>
          <span className="n">{active.length}</span>
        </div>
        {active.map((r) => row(r, r.cadence ?? ''))}
      </div>
      {retired.length > 0 && (
        <div className="side-retired">
          <span className="side-note">retired</span>
          <div className="side-repos" role="list" aria-label="Retired methods">
            {retired.map((r) => row(r, r.paper_end ? shortDate(r.paper_end) : ''))}
          </div>
        </div>
      )}
    </>
  );
}
```

### Step 15: Rail
**File:** `web/src/components/Rail.tsx`
**Change:**
- Line 1: the import gains `Sword`:
  `import { ChatsCircle, Images, NotePencil, SidebarSimple, SquaresFour, Sword, TextAa, Trash, TreeStructure, XCircle } from '@phosphor-icons/react';`
- Line 9: `BIN_TIP` becomes
  `export const BIN_TIP: Record<View, string> = { wall: 'Recycle bin', bin: 'Back to the wall', history: 'Recycle bin', projects: 'Recycle bin', adversary: 'Recycle bin' };`
- After `PROJECTS_TIP` (line 15), add the tooltip constant (code below).
- `RailProps` gains `onToggleAdversary: () => void;` after `onToggleHistory`, and the destructuring in
  `Rail(...)` gains `onToggleAdversary`.
- Between the Chat history button (ends at line 71) and the Trash button (starts at line 72), insert the Sword button.
**Code (constant):**
```ts
/** Tooltip / label of the Seer Adversarial toggle (seer-adversarial phase 6): Claude's twins of Seer's roster, with the roster in the sidebar. */
export const ADVERSARY_TIP = 'Seer Adversarial';
```
**Code (props + signature):**
```tsx
export interface RailProps {
  mode: Mode;
  view: View;
  active: string[];
  onToggleSide: () => void;
  onAdd: () => void;
  onCycleMode: () => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleAdversary: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  onClear: () => void;
}

export function Rail({ mode, view, active, onToggleSide, onAdd, onCycleMode, onToggleProjects, onToggleHistory, onToggleAdversary, onToggleBin, onToggleTag, onClear }: RailProps) {
```
**Code (button):**
```tsx
      <button
        type="button"
        className={view === 'adversary' ? 'ibtn on' : 'ibtn hov'}
        data-tip={ADVERSARY_TIP}
        data-tip-side="right"
        aria-label={ADVERSARY_TIP}
        aria-pressed={view === 'adversary'}
        onClick={onToggleAdversary}
      >
        <Sword weight="duotone" />
      </button>
```

### Step 16: Sidebar
**File:** `web/src/components/Sidebar.tsx`
**Change:** replace lines 1-34 (imports, props, signature) and add the Sword button and roster branch.
**Code (lines 1-34 become):**
```tsx
import { ChatsCircle, Sword, Trash, TreeStructure } from '@phosphor-icons/react';
import type { Mode, ProjectSummary, TagCount, View } from '../types';
import type { AdversaryMethod } from '../adversaryApi';
import { MODE_ORDER, MODE_TIP } from '../lib/filter';
import { sortProjects } from '../lib/projects';
import { ADVERSARY_TIP, BIN_TIP, HISTORY_TIP, MODE_ICON, PROJECTS_TIP } from './Rail';
import { RosterList } from './adversary/RosterList';

export interface SidebarProps {
  mode: Mode;
  view: View;
  tags: TagCount[];
  active: string[];
  onMode: (m: Mode) => void;
  onToggleProjects: () => void;
  onToggleHistory: () => void;
  onToggleAdversary: () => void;
  onToggleBin: () => void;
  onToggleTag: (tag: string) => void;
  /** Projects view: repos with sessions (null while loading). */
  projects?: ProjectSummary[] | null;
  /** Projects view: the repo shown. */
  repo?: string | null;
  onPickRepo?: (repo: string) => void;
  /** Adversary view: Seer's roster (null while loading). */
  roster?: AdversaryMethod[] | null;
  /** Adversary view: the method shown; null = Overview. */
  strategy?: string | null;
  onPickStrategy?: (strategyId: string | null) => void;
}

export function Sidebar({
  mode,
  view,
  tags,
  active,
  onMode,
  onToggleProjects,
  onToggleHistory,
  onToggleAdversary,
  onToggleBin,
  onToggleTag,
  projects = null,
  repo = null,
  onPickRepo,
  roster = null,
  strategy = null,
  onPickStrategy,
}: SidebarProps) {
  const sorted = tags.slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const inProjects = view === 'projects';
  const inAdversary = view === 'adversary';
```
**Code (insert between the Chat history button and the Trash button in `.side-modes`):**
```tsx
        <button
          type="button"
          className={inAdversary ? 'ibtn on' : 'ibtn'}
          data-tip={ADVERSARY_TIP}
          data-tip-side="below"
          aria-label={ADVERSARY_TIP}
          aria-pressed={inAdversary}
          onClick={onToggleAdversary}
        >
          <Sword weight="duotone" />
        </button>
```
**Code (the list area after `<div className="side-sep" />` becomes):**
```tsx
      {inAdversary ? (
        <RosterList roster={roster} strategy={strategy} onPick={(id) => onPickStrategy?.(id)} />
      ) : inProjects ? (
        <div className="side-repos" role="list" aria-label="Projects">
          {projects === null ? (
            <span className="side-note">loading</span>
          ) : projects.length === 0 ? (
            <span className="side-note">no sessions yet</span>
          ) : (
            sortProjects(projects).map((p) => (
              <div
                key={p.repo}
                role="listitem"
                data-repo={p.repo}
                className={p.repo === repo ? 'tagrow on' : 'tagrow'}
                aria-current={p.repo === repo ? 'true' : undefined}
                onClick={() => onPickRepo?.(p.repo)}
              >
                <span className="repo-name">
                  {p.live > 0 && <span className="repo-live" data-tip={`${p.live} running`} aria-label={`${p.live} running`} />}
                  {p.repo}
                </span>
                <span className="n">{p.sessions}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="side-tags">
          {sorted.map((t) => (
            <div key={t.tag} className={active.includes(t.tag) ? 'tagrow on' : 'tagrow'} onClick={() => onToggleTag(t.tag)}>
              <span>#{t.tag}</span>
              <span className="n">{t.count}</span>
            </div>
          ))}
        </div>
      )}
```

### Step 17: Header knows the adversary page
**File:** `web/src/components/Header.tsx:1-31`
**Change:** add the import, the prop and the hint.
**Code (lines 1-31 become):**
```tsx
import { Plus } from '@phosphor-icons/react';
import type { Note } from '../types';
import { HISTORY_HINT } from '../lib/timeline';
import { PROJECTS_HINT } from '../lib/projects';
import { ADVERSARY_HINT } from '../lib/adversary';

export interface HeaderProps {
  heading: string;
  countLine: string;
  last: Note | null;
  lastWhen: string;
  showSticker: boolean;
  /** The recycle bin is showing: no "Last edited" link, and the hint explains the bin. */
  bin?: boolean;
  /** The chat history page is showing (phase 9): no "Last edited" link, and the hint explains the page. */
  history?: boolean;
  /** The projects view is showing (project-session-graph phase 10): no "Last edited" link, and the hint explains the graph. */
  projects?: boolean;
  /** Seer Adversarial is showing (seer-adversarial phase 6): no "Last edited" link, and the hint explains the twins. */
  adversary?: boolean;
  onJumpLast: () => void;
  onAdd: () => void;
}

const WALL_HINT = 'Drop or paste an image anywhere to make a photo note.';
const BIN_HINT = 'Restore brings a note or an image back. Delete forever removes it and its files.';

export function Header({ heading, countLine, last, lastWhen, showSticker, bin = false, history = false, projects = false, adversary = false, onJumpLast, onAdd }: HeaderProps) {
  const hint = bin ? BIN_HINT : history ? HISTORY_HINT : projects ? PROJECTS_HINT : adversary ? ADVERSARY_HINT : WALL_HINT;
  return (
    <header className="hdr">
      <p className="hdr-p">
        {countLine}
        {!bin && !history && !projects && !adversary && last && (
```
(The rest of the component, from the `<>` inside that condition to the end, is unchanged.)

### Step 18: The page
**File:** `web/src/pages/AdversaryPage.tsx` (create)
**Code:**
```tsx
import { useState, type ReactNode } from 'react';
import { ArrowsClockwise, CornersIn, CornersOut, Power } from '@phosphor-icons/react';
import { AdversaryDaily } from '../components/adversary/AdversaryDaily';
import { AdversaryMethod } from '../components/adversary/AdversaryMethod';
import { AdversaryOverview } from '../components/adversary/AdversaryOverview';
import { AdversaryPill } from '../components/adversary/AdversaryPill';
import { useFocusShortcut } from '../hooks/useFocusShortcut';
import { useNotice } from '../hooks/useNotice';
import type { AdversaryStore } from '../hooks/useAdversary';
import { ApiError } from '../api';
import { adversaryHeading, errorText, focusLine } from '../lib/adversary';

export interface AdversaryPageProps {
  store: AdversaryStore;
  /** `/adversary/<id>`: the method shown; null = the overview. */
  strategy: string | null;
  /** Focus mode (`?focus=1`): App hides the rail, sidebar and header; the page shows a small heading. */
  focus: boolean;
  onToggleFocus: () => void;
  /** Esc leaves focus mode only while nothing else wants Esc (App: the answer panel is closed). */
  escapeLeavesFocus: boolean;
  onPickStrategy: (strategyId: string | null) => void;
  onAsk: (text: string, imageIds: string[]) => void;
}

export const POWER_ON_TIP = 'Auto-runs on (click to pause)';
export const POWER_OFF_TIP = 'Auto-runs off (click to turn on)';

/**
 * Seer Adversarial's main area:
 *   .adv-bar   toolbar, icon-only: auto-runs Power toggle, Review now, Focus (Alt+Z)
 *   focus head (focus mode only: App's header is hidden)
 *   content    overview / method / daily three-way, picked by the API data (three_way present = daily)
 *   pill       "Ask about Seer Adversarial"
 */
export function AdversaryPage({ store, strategy, focus, onToggleFocus, escapeLeavesFocus, onPickStrategy, onAsk }: AdversaryPageProps) {
  useFocusShortcut(onToggleFocus, { focus, escapeLeaves: escapeLeavesFocus });
  const { notice, show } = useNotice(6000);
  const [busy, setBusy] = useState(false);
  const auto = store.toggle?.on ?? null;

  const flip = async () => {
    if (auto === null) return;
    setBusy(true);
    const ok = await store.setAuto(!auto);
    setBusy(false);
    if (!ok) show('could not change auto-runs');
  };

  // Awaits only phase 5's immediate 202 `{started, reason}`; the pass runs on in the daemon and its
  // verdicts reach the page through SSE `adversary` events and the store's refresh.
  const review = async () => {
    setBusy(true);
    try {
      const r = await store.reviewNow(strategy);
      show(r.started ? 'review started' : (r.reason ?? 'nothing to review'));
    } catch (e) {
      show(`review refused: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const powerTip = auto === false ? POWER_OFF_TIP : POWER_ON_TIP;
  const reviewLabel = strategy === null ? 'Review now' : 'Review this method now';
  const reviewTip = auto === false ? `${reviewLabel} (runs once, even while auto-runs are off)` : reviewLabel;
  const focusTip = focus ? 'Exit focus (Alt+Z)' : 'Focus (Alt+Z)';

  let content: ReactNode;
  if (strategy === null) {
    if (store.overviewError !== null) content = <p className="adv-empty">{errorText(store.overviewError)}</p>;
    else if (store.overview === null) content = <p className="adv-empty">loading Seer Adversarial</p>;
    else content = <AdversaryOverview overview={store.overview} onPick={(id) => onPickStrategy(id)} />;
  } else if (store.methodError !== null) {
    content = <p className="adv-empty">{errorText(store.methodError, strategy)}</p>;
  } else if (store.method === null || store.method.method.strategy_id !== strategy) {
    content = <p className="adv-empty">loading {strategy}</p>;
  } else if (store.method.three_way !== null) {
    content = <AdversaryDaily detail={store.method} tw={store.method.three_way} />;
  } else {
    content = <AdversaryMethod detail={store.method} />;
  }

  return (
    <section className="adv" aria-label="Seer Adversarial">
      <div className="adv-bar">
        {notice && (
          <span className="adv-note" role="status">
            {notice}
          </span>
        )}
        <button
          type="button"
          className={auto === null ? 'ibtn' : auto ? 'ibtn on' : 'ibtn adv-off'}
          data-tip={powerTip}
          data-tip-side="below"
          aria-label={powerTip}
          aria-pressed={auto !== false}
          disabled={auto === null || busy}
          onClick={() => void flip()}
        >
          <Power weight="duotone" />
        </button>
        <button type="button" className="ibtn hov" data-tip={reviewTip} data-tip-side="below" aria-label={reviewLabel} disabled={busy} onClick={() => void review()}>
          <ArrowsClockwise weight="duotone" />
        </button>
        <button type="button" className={focus ? 'ibtn on' : 'ibtn hov'} data-tip={focusTip} data-tip-side="below" aria-label={focusTip} aria-pressed={focus} onClick={onToggleFocus}>
          {focus ? <CornersIn weight="duotone" /> : <CornersOut weight="duotone" />}
        </button>
      </div>
      {focus && (
        <>
          <div className="adv-focus-head">
            <span className="adv-focus-h">{adversaryHeading(store, strategy)}</span>
            <span className="adv-meta">{focusLine(store.toggle, store.overview)}</span>
          </div>
          <div className="rule" />
        </>
      )}
      {content}
      <AdversaryPill onAsk={onAsk} />
    </section>
  );
}
```
**Impact:** the Review button gets the aria-label `Review now` / `Review this method now`. Proof and tests select by these labels.

### Step 19: App wiring
**File:** `web/src/App.tsx`
**Change 19a, imports.** Line 18 becomes the first line below. Insert the other three lines after line 23 (`import { projectHeading, ... } from './lib/projects';`).
```tsx
import { adversaryRouteFromLocation, hrefForView, NO_ADVERSARY_ROUTE, NO_PROJECT_ROUTE, projectsHref, projectsRouteFromLocation, routeFromLocation, type AdversaryRoute, type ProjectsRoute } from './lib/route';
import { AdversaryPage } from './pages/AdversaryPage';
import { useAdversary } from './hooks/useAdversary';
import { adversaryChatMessage, adversaryCountLine, adversaryHeading } from './lib/adversary';
```
**Change 19b, sidebar starts open on a deep link** (lines 69-70):
```tsx
  // Opening the projects or adversary view expands the sidebar with its list; a deep link starts that way.
  const [side, setSide] = useState(() => projectsRouteFromLocation(window.location) !== null || adversaryRouteFromLocation(window.location) !== null);
```
**Change 19c, view from the URL** (lines 77-84). Replace from the comment through `const [projectsRoute, setProjectsRoute] = …;`:
```tsx
  // `/history[?thread=ID]` opens straight into the chat history page, `/projects[?repo=&node=]`
  // into the session graph, `/adversary[/<id>]` into Seer Adversarial (all served by the SPA fallback).
  const [view, setView] = useState<View>(() => {
    if (routeFromLocation(window.location).history) return 'history';
    if (projectsRouteFromLocation(window.location) !== null) return 'projects';
    return adversaryRouteFromLocation(window.location) !== null ? 'adversary' : 'wall';
  });
  const [historyThread, setHistoryThread] = useState<string | null>(() => routeFromLocation(window.location).thread);
  const [projectsRoute, setProjectsRoute] = useState<ProjectsRoute>(() => projectsRouteFromLocation(window.location) ?? NO_PROJECT_ROUTE);
  const [adversaryRoute, setAdversaryRoute] = useState<AdversaryRoute>(() => adversaryRouteFromLocation(window.location) ?? NO_ADVERSARY_ROUTE);
  // Fetches only while the adversary view is shown (overview for the sidebar and header, plus the method shown).
  const adversary = useAdversary(view === 'adversary', adversaryRoute.strategy);
```
**Change 19d, focus covers both pages** (lines 98-99):
```tsx
  // Focus mode: the projects or adversary page alone, no rail, sidebar or header.
  const focus = (view === 'projects' && projectsRoute.focus) || (view === 'adversary' && adversaryRoute.focus);
```
**Change 19e, toggles.** Insert after `toggleFocus` (line 332):
```tsx
  /** Rail / sidebar sword icon: open Seer Adversarial and expand the sidebar with the roster; a second press returns to the wall. */
  const toggleAdversary = useCallback(() => {
    const opening = wallRef.current.view !== 'adversary';
    setView(opening ? 'adversary' : 'wall');
    if (opening) {
      setSide(true);
      setAdversaryRoute((r) => (r.focus ? { ...r, focus: false } : r));
    }
  }, []);

  /** Sidebar roster row or overview table row: `/adversary/<id>` (null = the overview), keeping focus mode. */
  const pickStrategy = useCallback((strategy: string | null) => setAdversaryRoute((r) => ({ strategy, focus: r.focus })), []);

  /** The adversary toolbar's focus icon, Alt+Z, and Esc in focus mode. */
  const toggleAdversaryFocus = useCallback(() => setAdversaryRoute((r) => ({ ...r, focus: !r.focus })), []);

  /** The page's pill: the wall chat, with the page named on the message's first line (lib/adversary adversaryChatMessage). */
  const { ask: askChat } = chat;
  const askAdversary = useCallback(
    (text: string, imageIds: string[]) => {
      void askChat(adversaryChatMessage(text, adversaryRoute.strategy), imageIds);
    },
    [askChat, adversaryRoute.strategy],
  );
```
**Change 19f, URL sync** (lines 382-390). Replace the effect and its comment:
```tsx
  // The address bar follows the view (pathname guard, lib/route.ts hrefForView): entering the
  // history page pushes /history[?thread=], the projects view /projects[?repo=&node=], Seer
  // Adversarial /adversary[/<id>][?focus=1]; leaving any of them pushes / only when the path is
  // theirs. Wall and bin never rewrite another URL, so /?note=ID survives a switch to the wall
  // (Phase 11's show-on-wall relies on this). This is the one URL-sync owner; no other phase adds one.
  useEffect(() => {
    const href = hrefForView(view, historyThread, window.location, projectsRoute, adversaryRoute);
    if (href !== null) window.history.pushState(null, '', href);
  }, [view, historyThread, projectsRoute, adversaryRoute]);
```
**Change 19g, popstate** (lines 392-404). Replace the effect:
```tsx
  // Back / forward between /history, /projects, /adversary and the wall. A /?note= target is handled by
  // useDeepLink's own popstate listener (planReveal moves the view to the wall).
  useEffect(() => {
    const onPop = () => {
      const r = routeFromLocation(window.location);
      const p = projectsRouteFromLocation(window.location);
      const a = adversaryRouteFromLocation(window.location);
      setHistoryThread(r.thread);
      if (p !== null) setProjectsRoute(p);
      if (a !== null) setAdversaryRoute(a);
      setView((v) =>
        r.history ? 'history' : p !== null ? 'projects' : a !== null ? 'adversary' : v === 'history' || v === 'projects' || v === 'adversary' ? 'wall' : v,
      );
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
```
**Change 19h, Rail props** (lines 776-791): add `onToggleAdversary={toggleAdversary}` after `onToggleHistory={toggleHistory}`.
**Change 19i, Sidebar props** (lines 794-807). The element becomes:
```tsx
              <Sidebar
                mode={mode}
                view={view}
                tags={tags}
                active={active}
                onMode={pickMode}
                onToggleProjects={toggleProjects}
                onToggleHistory={toggleHistory}
                onToggleAdversary={toggleAdversary}
                onToggleBin={toggleBin}
                onToggleTag={toggleTag}
                projects={projectsStore.projects}
                repo={projectRepo}
                onPickRepo={pickRepo}
                roster={adversary.overview?.roster ?? null}
                strategy={adversaryRoute.strategy}
                onPickStrategy={pickStrategy}
              />
```
**Change 19j, Header** (lines 812-839). The `<Header … />` element becomes:
```tsx
                  <Header
                    heading={
                      view === 'adversary'
                        ? adversaryHeading(adversary, adversaryRoute.strategy)
                        : view === 'projects'
                          ? projectHeading(projectRepo)
                          : view === 'history'
                            ? HISTORY_HEADING
                            : view === 'bin'
                              ? BIN_HEADING
                              : headingFor(mode, active)
                    }
                    countLine={
                      view === 'adversary'
                        ? adversaryCountLine(adversary, adversaryRoute.strategy, now)
                        : view === 'projects'
                          ? projectsCountLine(projectsStore.projects, projectRepo)
                          : view === 'history'
                            ? historyCountLine(history.items, history.hasMore)
                            : view === 'bin'
                              ? binCountLine(binStore.bin, active)
                              : countLineFor(mode, active, notes, visible, photos)
                    }
                    last={last}
                    lastWhen={last ? relativeDate(last.updated_at, now, true) : ''}
                    showSticker={view === 'wall' && mode !== 'images'}
                    bin={view === 'bin'}
                    history={view === 'history'}
                    projects={view === 'projects'}
                    adversary={view === 'adversary'}
                    onJumpLast={() => last && jump(last.id)}
                    onAdd={() => void addNote()}
                  />
```
**Change 19k, page switch** (line 843). Put the adversary branch first, so `{view === 'projects' ? (` becomes:
```tsx
              {view === 'adversary' ? (
                <AdversaryPage
                  store={adversary}
                  strategy={adversaryRoute.strategy}
                  focus={focus}
                  onToggleFocus={toggleAdversaryFocus}
                  escapeLeavesFocus={!chat.open}
                  onPickStrategy={pickStrategy}
                  onAsk={askAdversary}
                />
              ) : view === 'projects' ? (
```
(The rest of the chain is unchanged.)
**Change 19l, the wall chat bar is hidden on the page, which has its own pill** (line 896):
```tsx
            {view !== 'history' && view !== 'projects' && view !== 'adversary' && (
```
The AnswerPanel condition at line 877 stays as it is, so the answer to a pill question shows over the adversary
page. The Esc-closes-chat effect at lines 760-768 also stays as it is: Esc there closes the answer panel. In
focus mode, `escapeLeavesFocus={!chat.open}` stops that same Esc from also leaving focus.
**Impact:** existing App tests are unaffected, because the adversary fetches run only on the adversary view.

### Step 20: Styles
**File:** `web/src/styles.css`
**Change:** add three tokens in `:root` after line 23 (`--col-w`), and append the block below after line 134.
**Code (tokens):**
```css
  --soft: #a9a89f;
  --deep: #55544e;
  --line-45: rgba(236, 235, 228, .45);
```
**Code (append):**
```css
/* Seer Adversarial (/adversary, seer-adversarial phase 6). Monochrome, hairlines, no shadows. */
.side-retired { display: flex; flex-direction: column; gap: 2px; opacity: .55; }
.adv { min-width: 0; }
.adv-bar { position: sticky; top: 0; z-index: 42; display: flex; align-items: center; justify-content: flex-end; gap: 4px; height: 44px; padding-top: 10px; pointer-events: none; }
.adv-bar > * { pointer-events: auto; }
.adv-bar .ibtn { font-size: 19px; }
.adv-bar .ibtn:not(:hover):not(.on) { background: var(--bg); }
.adv-bar .ibtn:disabled { opacity: .35; cursor: default; }
.ibtn.adv-off { border: 1px dashed var(--line-45); color: var(--soft); box-sizing: border-box; }
.adv-note { font-family: var(--mono); font-size: 10.5px; color: var(--dim); letter-spacing: .03em; margin-right: 8px; }
.adv-empty { margin: 32px 0; font-family: var(--mono); font-size: 12px; color: var(--dim); letter-spacing: .03em; }
.adv-focus-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 14px; padding-top: 6px; }
.adv-focus-h { font-size: 64px; letter-spacing: -.05em; line-height: .9; }
.adv-meta { font-family: var(--mono); font-size: 10.5px; color: var(--dim); letter-spacing: .03em; }
.adv-mono { font-family: var(--mono); letter-spacing: .03em; }
.adv-dim { color: var(--dim); }
.adv-push { margin-left: auto; }
.adv-text { font-size: 13px; line-height: 1.4; color: var(--muted); text-wrap: pretty; }
.adv-big { font-size: 30px; letter-spacing: -.03em; line-height: 1; }
.adv-note-p { margin: 12px 0 0; font-size: 12px; line-height: 1.5; color: var(--soft); }
.adv-divider { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); white-space: nowrap; letter-spacing: .03em; }
.adv-divider > span { overflow: hidden; text-overflow: ellipsis; }
.adv-divider::after { content: ""; flex: 1; min-width: 24px; height: 1px; background: var(--line-12); }
.adv-overview > section, .adv-method > section, .adv-daily > section { padding-top: 34px; }
.adv-chip { display: inline-block; font-family: var(--mono); font-size: 10.5px; line-height: 1; padding: 3px 8px 4px; border-radius: 999px; letter-spacing: .02em; white-space: nowrap; align-self: flex-start; }
.adv-chip.obj { background: var(--fg); color: var(--bg); }
.adv-chip.ok { border: 1px solid var(--line-25); color: var(--chip); }
.adv-chip.unsure { border: 1px dashed var(--line-45); color: var(--soft); }
.adv-title .adv-chip { margin-left: 6px; vertical-align: .15em; }
.adv-dot { display: inline-block; width: 8px; height: 8px; border-radius: 999px; box-sizing: border-box; }
.adv-dot.pass { background: var(--fg); }
.adv-dot.fail { border: 1px solid var(--line-45); }
.adv-dot.na { border: 1px dashed var(--line-45); }
.adv-dots { display: flex; gap: 4px; }
.adv-checks2 { display: flex; flex-direction: column; gap: 6px; }
.adv-cause { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.adv-tile { background: var(--card); padding: 16px 16px 14px; display: flex; flex-direction: column; gap: 10px; }
.adv-grid7 { display: grid; grid-template-columns: minmax(0, 2.2fr) repeat(4, minmax(0, 1fr)) minmax(0, 1.3fr) minmax(0, 1.1fr); gap: 16px; align-items: center; }
.adv-thead { padding: 0 12px 10px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); border-bottom: 1px solid var(--line-12); letter-spacing: .03em; }
.adv-row { padding: 16px 12px; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; cursor: pointer; }
.adv-row:hover { background: var(--card); color: inherit; }
.adv-row:focus-visible { outline: 1px solid var(--ring); outline-offset: -1px; }
.adv-name { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.adv-title { font-size: 17px; }
.adv-sub { font-size: 12px; color: var(--soft); line-height: 1.4; }
.adv-num { font-family: var(--mono); font-size: 14px; letter-spacing: .03em; }
.adv-num.hi { color: #fff; }
.adv-num.lo { color: var(--soft); }
.adv-obj { display: flex; flex-direction: column; gap: 2px; font-family: var(--mono); font-size: 12px; color: var(--muted); }
.adv-cov { display: flex; flex-direction: column; gap: 6px; }
.adv-cov-bar { display: flex; height: 6px; gap: 2px; }
.adv-cov-reviewed { background: var(--fg); }
.adv-cov-absent { background: var(--deep); }
.adv-cov-paused { border: 1px dashed var(--dim); box-sizing: border-box; }
.adv-cov-empty { flex: 1; border: 1px solid var(--line-12); box-sizing: border-box; }
.adv-cov-pending { border: 1px solid var(--line-12); box-sizing: border-box; } /* session not open yet */
.adv-swatch { display: inline-block; width: 14px; height: 6px; }
.adv-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; padding: 14px 12px 0; font-family: var(--mono); font-size: 10.5px; color: var(--dim); letter-spacing: .03em; }
.adv-chart .adv-legend { padding: 0; }
.adv-key-row { display: inline-flex; align-items: center; gap: 6px; }
.adv-key { display: inline-block; width: 18px; height: 0; }
.adv-key.twin { border-top: 2px solid var(--fg); }
.adv-key.orig { border-top: 2px dashed var(--soft); }
.adv-key.spy { border-top: 2px dotted #6d6c65; }
.adv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.adv-card { break-inside: avoid; margin: 0 0 10px; background: var(--card); padding: 13px 14px 10px; display: flex; flex-direction: column; gap: 10px; }
.adv-cards .adv-card { margin: 0; }
.adv-card.late { opacity: .6; }
.adv-card-head { display: flex; align-items: center; gap: 8px; }
.adv-sym { font-size: 20px; letter-spacing: -.02em; }
.adv-reason { margin: 0; font-size: 14px; line-height: 1.38; color: var(--text); text-wrap: pretty; }
.adv-src { display: flex; flex-wrap: wrap; gap: 10px; font-family: var(--mono); font-size: 10.5px; color: var(--id); }
.adv-srcs { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; font-family: var(--mono); font-size: 10.5px; color: var(--id); }
.adv-card-foot { display: flex; gap: 8px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.adv-h2h { display: flex; flex-wrap: wrap; gap: 28px; }
.adv-chart { margin: 0; flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.adv-chart svg { width: 100%; height: 240px; display: block; }
.adv-base { stroke: var(--line-12); stroke-width: 1; }
.adv-line { fill: none; stroke-width: 1.5; }
.adv-line.twin { stroke: var(--fg); stroke-width: 2; }
.adv-line.orig { stroke: var(--soft); stroke-dasharray: 5 4; }
.adv-line.spy { stroke: #6d6c65; stroke-dasharray: 1 4; stroke-linecap: round; }
.adv-axis { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.adv-stats { flex: 1 1 300px; display: flex; flex-direction: column; }
.adv-stat { display: grid; grid-template-columns: minmax(0, 1.4fr) repeat(3, minmax(0, 1fr)); gap: 8px; padding: 10px 0; font-family: var(--mono); font-size: 13px; border-bottom: 1px solid rgba(236, 235, 228, .08); }
.adv-stat-h { padding: 0 0 8px; font-size: 10.5px; color: var(--dim); border-bottom-color: var(--line-12); }
.adv-stat-l { font-family: var(--sans); color: var(--muted); }
.adv-stat .hi { color: #fff; }
.adv-stat .lo { color: var(--soft); }
.adv-checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.adv-check { background: var(--card); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.adv-check-row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
.adv-check-row > span:first-child { color: var(--soft); }
.adv-check-row > span:last-child { text-align: right; }
.adv-check-note { font-size: 12px; line-height: 1.4; color: var(--dim); }
.adv-progress { height: 3px; background: var(--chip-bg); }
.adv-progress > div { height: 3px; background: var(--fg); }
.adv-filter { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.adv-fpill { font-family: var(--mono); font-size: 10.5px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line-25); background: transparent; color: var(--fg); cursor: pointer; }
.adv-fpill.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.adv-verdicts { columns: 300px; column-gap: 10px; }
.adv-verdicts .adv-sym { font-size: 22px; }
.adv-agree { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
.adv-agree > .adv-meta { margin-right: 6px; }
.adv-record-body { display: flex; flex-wrap: wrap; gap: 28px; align-items: center; }
.adv-record-plot { flex: 999 1 480px; min-width: 0; }
.adv-record-plot svg { width: 100%; height: 70px; display: block; }
.adv-mid { stroke: rgba(236, 235, 228, .35); stroke-width: 1; }
.adv-hit { fill: var(--fg); }
.adv-miss { fill: none; stroke: var(--fg); stroke-width: 1.5; }
.adv-record-sum { flex: 1 1 260px; display: flex; flex-direction: column; gap: 6px; }
.adv-rev { display: grid; grid-template-columns: 110px 170px minmax(0, 1fr); gap: 16px; padding: 8px 0; border-bottom: 1px solid rgba(236, 235, 228, .08); font-family: var(--mono); font-size: 11px; color: var(--muted); }
.adv-rev.old { color: var(--dim); border-bottom: 0; }
.adv-rev-note { font-family: var(--sans); font-size: 12.5px; }
.adv-books { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.adv-book { background: var(--card); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.adv-book.inv { background: var(--fg); color: var(--bg); }
.adv-book-head { display: flex; align-items: baseline; gap: 8px; }
.adv-book-t { font-size: 20px; }
.adv-book-s { font-size: 12px; color: var(--soft); }
.adv-book.inv .adv-book-s { color: var(--deep); }
.adv-book-n { font-size: 36px; letter-spacing: -.03em; line-height: 1; }
.adv-book-stats { display: grid; grid-template-columns: 1fr auto; gap: 4px 12px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.adv-book-stats > span:nth-child(odd) { color: var(--dim); }
.adv-book.inv .adv-book-stats { color: var(--chip-bg); }
.adv-book.inv .adv-book-stats > span:nth-child(odd) { color: var(--deep); }
.adv-cand { display: grid; grid-template-columns: 32px 72px minmax(0, 1fr) minmax(0, 1fr) 84px; gap: 16px; padding: 14px 12px; border-bottom: 1px solid rgba(236, 235, 228, .08); align-items: start; }
.adv-cand:hover { background: var(--card); }
.adv-cand-h { padding: 0 12px 10px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); border-bottom-color: var(--line-12); }
.adv-cand-h:hover { background: transparent; }
.adv-cand-sym { font-size: 16px; }
.adv-cand-v { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.adv-cand-r { font-size: 13px; line-height: 1.4; color: var(--text); }
.adv-cand-r.dim { color: var(--muted); }
.adv-buys { display: flex; gap: 6px; padding-top: 4px; }
.adv-buy { display: inline-block; width: 9px; height: 9px; border-radius: 999px; background: var(--fg); }
.adv-nobuy { display: inline-block; width: 9px; height: 9px; border-radius: 999px; border: 1px solid rgba(236, 235, 228, .18); box-sizing: border-box; }
.adv-buy-pending { display: inline-block; width: 9px; height: 9px; border-radius: 999px; border: 1px dashed rgba(236, 235, 228, .3); box-sizing: border-box; } /* null: that book has not decided yet */
.adv-split { display: flex; flex-wrap: wrap; gap: 28px; }
.adv-grid-wrap, .adv-right { flex: 1 1 340px; min-width: 0; }
.adv-grid { display: grid; grid-template-columns: 90px repeat(2, minmax(0, 1fr)); gap: 2px; font-size: 13px; }
.adv-grid > .adv-meta { padding: 6px 10px; }
.adv-grid > .adv-grid-l { padding: 14px 0; }
.adv-cell { background: var(--card); padding: 12px 10px; }
.adv-cell.inv { background: var(--fg); color: var(--bg); }
.adv-cell-n { font-size: 24px; display: block; }
.adv-cell-s { display: block; margin-top: 4px; font-family: var(--mono); font-size: 10.5px; color: var(--dim); }
.adv-cell.inv .adv-cell-s { color: var(--deep); }
.adv-right { display: flex; flex-direction: column; gap: 14px; }
.adv-bar-l { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 6px; }
.adv-meter { height: 6px; background: var(--chip-bg); }
.adv-meter > div { height: 6px; background: var(--fg); }
.adv-meter.dim > div { background: var(--soft); }
.adv-pill { position: sticky; bottom: 16px; z-index: 41; max-width: 760px; margin: 48px auto 0; }
.adv-pill .chatbar.chatbar-page { position: relative; left: auto; right: auto; bottom: auto; width: 100%; }
@media (max-width: 900px) {
  .adv-cause { grid-template-columns: minmax(0, 1fr); }
  .adv-grid7 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .adv-thead { display: none; }
  .adv-cand { grid-template-columns: 24px 56px minmax(0, 1fr); }
  .adv-cand > :nth-child(n + 4) { grid-column: 3; }
  .adv-rev { grid-template-columns: minmax(0, 1fr); gap: 4px; }
}
```

### Step 21: Fixtures
**File:** `web/src/testing/adversaryFixtures.ts` (create)
**Code:**
```ts
import type {
  AdversaryMethod,
  AdversaryRecord,
  AdversaryToggle,
  AdversaryVerdict,
  BookFigures,
  CheckKey,
  ChecklistItem,
  Coverage,
  CriticDuel,
  MethodPayload,
  MethodRow,
  OverviewPayload,
  ThreeWayRow,
} from '../adversaryApi';

// Every fixture is typed by phase 5's wire types (web/src/adversaryApi.ts = phase 5 readTypes.ts):
// a field phase 5 adds is a compile error here until the fixture carries it.

const LABELS = ['18 months on paper', 'beats SPY', 'wins ÷ losses ≥ 1.3', 'worst drop ≤ 25%', '10-year backtest'];
const KEYS: CheckKey[] = ['months', 'beats_spy', 'profit_factor', 'max_drawdown', 'backtest'];

export function checklist(states: Array<'pass' | 'fail' | 'na'>, values: Array<string | null> = []): ChecklistItem[] {
  return states.map((state, i) => ({
    rule: (i + 1) as ChecklistItem['rule'],
    key: KEYS[i] ?? 'months',
    label: LABELS[i] ?? `rule ${i + 1}`,
    state,
    value: values[i] ?? null,
    progress: i === 0 ? 0.39 : null,
    seer: { label: LABELS[i] ?? `rule ${i + 1}`, val: values[i] ?? (state === 'na' ? "Can't be run" : '—'), ok: state === 'pass' },
  }));
}

export function method(id: string, name: string, over: Partial<AdversaryMethod> = {}): AdversaryMethod {
  return {
    strategy_id: id,
    twin_id: `${id}-CX`,
    name,
    short: name.split(' · ')[0] ?? name,
    sub: null,
    engine: 'book',
    cadence: 'monthly',
    status: 'active',
    paper_start: '2026-10-14',
    paper_end: null,
    ...over,
  };
}

export function verdict(id: number, strategy: string, symbol: string, kind: AdversaryVerdict['verdict'], over: Partial<AdversaryVerdict> = {}): AdversaryVerdict {
  return {
    id,
    strategy_id: strategy,
    session_date: '2026-11-04',
    symbol,
    rank: null,
    verdict: kind,
    reason: `${symbol}: ${kind} reason in plain words.`,
    sources: kind === 'unsure' ? [] : [{ url: `https://www.benzinga.com/${symbol.toLowerCase()}`, title: `${symbol} headline`, publisher: 'benzinga.com', published_at: null, fetched_at: '2026-11-04T09:40:00Z' }],
    lens: 'lens@1',
    model: 'claude-opus-5-5',
    prompt_version: 'pv1',
    host: 'lenovo',
    started_at: '2026-11-04T09:30:00Z',
    decided_at: '2026-11-04T10:00:00Z',
    late: false,
    weight: null,
    twin_weight: null,
    twin_weight_source: null,
    held: null,
    action: kind === 'object' ? 'skip' : null,
    ...over,
  };
}

export function book(strategy: string, over: Partial<BookFigures> = {}): BookFigures {
  return {
    strategy_id: strategy,
    from: '2026-10-14',
    to: '2026-11-04',
    sessions: 16,
    return: null,
    mwr_annual: null,
    deposits_usd: 0,
    gain_usd: null,
    worst_drop: null,
    trades: 0,
    profit_factor: null,
    fees_usd: null,
    ...over,
  };
}

function coverage(reviewed: number, absent: number, paused: number, over: Partial<Coverage> = {}): Coverage {
  return { decisions: reviewed + absent + paused, reviewed, absent, late: 0, paused, pending: 0, ...over };
}

function row(m: AdversaryMethod, over: Omit<MethodRow, keyof AdversaryMethod | 'window' | 'figures' | 'beyond_original_usd'> & Partial<MethodRow>): MethodRow {
  return { ...m, window: { from: '2026-10-20', to: '2026-11-04', sessions: 12 }, figures: { original: null, twin: null, spy: null }, beyond_original_usd: null, ...over };
}

function emptyRecord(horizon: string, sessions: number | null): AdversaryRecord {
  return {
    horizon,
    horizon_sessions: sessions,
    same_band_pts: 0.5,
    points: [],
    pending: [],
    summary: { objections: 0, scored: 0, worse: 0, same: 0, better: 0, pending: 0, fell: 0, mean_gap_pts: null },
  };
}

const A = method('A-GT', 'A · Dip buy', { engine: 'bracket', cadence: 'daily', sub: 'Buys a sharp dip in a rising stock, out within 5 days.' });
const RAW = method('RAW35-FR-GT', 'RAW35 · Momentum', { sub: 'The 35 stocks that rose most beyond the market, re-picked each month.' });
const COSK = method('COSK-FR-GT', 'COSK · Crash-prone', { cadence: 'quarterly', paper_start: '2026-10-19' });
const MOM70 = method('MOM70-GT', 'MOM70 · Momentum + SPY', { status: 'retired', twin_id: null, paper_end: '2026-11-01' });
const FULL50 = method('FULL50-GT', 'FULL50 · Never aside', { status: 'retired', twin_id: null, paper_end: '2026-10-30' });
export const CRITIC = method('C-GT', 'C · News veto', { engine: 'bracket', cadence: 'daily', twin_id: null });

const A_ROW = row(A, {
  returns: { original: 0.031, twin: 0.054, spy: 0.06 },
  objections: { objected: 61, reviewed: 1190, fell_after: 39, scored: 55, pending: 6 },
  coverage: coverage(78, 17, 5),
  checklist: { original: checklist(['fail', 'fail', 'fail', 'fail', 'fail']), twin: checklist(['fail', 'fail', 'pass', 'pass', 'na']) },
});
const RAW_ROW = row(RAW, {
  returns: { original: 0.089, twin: 0.096, spy: 0.06 },
  objections: { objected: 23, reviewed: 245, fell_after: 14, scored: 21, pending: 2 },
  coverage: coverage(7, 0, 0),
  checklist: { original: checklist(['fail', 'pass', 'pass', 'pass', 'fail']), twin: checklist(['fail', 'pass', 'pass', 'pass', 'na']) },
});
const COSK_ROW = row(COSK, {
  returns: { original: 0.044, twin: 0.041, spy: 0.06 },
  objections: { objected: 6, reviewed: 140, fell_after: 2, scored: 4, pending: 2 },
  coverage: coverage(3, 0, 0),
  checklist: { original: checklist(['fail', 'fail', 'pass', 'fail', 'fail']), twin: checklist(['fail', 'fail', 'pass', 'fail', 'na']) },
});

export const OVERVIEW: OverviewPayload = {
  generated_at: '2026-11-05T01:00:00Z',
  started_on: '2026-10-20',
  months_on_paper: 1,
  spy_id: 'SPY-GT',
  roster: [A, RAW, COSK, FULL50, MOM70],
  methods: [A_ROW, RAW_ROW, COSK_ROW],
  cause: { twins: 3, twins_beat_spy: [], originals_beat_spy: [], extra_profit_usd: 38.2, drawdown_delta_pts: -1.9 },
  latest: [
    verdict(1, 'A-GT', 'SLB', 'object', { reason: 'The dip follows oil, not SLB.' }),
    verdict(2, 'A-GT', 'ZBRA', 'object', { reason: 'It fell on a weaker outlook in yesterday’s results.' }),
    verdict(3, 'COSK-FR-GT', 'APA', 'unsure', { session_date: '2026-10-19' }),
  ],
  last_review: { strategy_id: 'RAW35-FR-GT', session_date: '2026-11-02', picks: 35, finished_at: '2026-11-01T10:55:00Z' },
  reviewer: null,
};

const DATES = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];

const BOOK_VERDICTS = [
  verdict(10, 'RAW35-FR-GT', 'SLB', 'object', { session_date: '2026-11-02', rank: 1, weight: 0.029, twin_weight: 0, twin_weight_source: 'expected', held: true, action: 'sell', reason: 'Its rise is the oil price’s rise.' }),
  verdict(11, 'RAW35-FR-GT', 'MRNA', 'agree', { session_date: '2026-11-02', rank: 2, weight: 0.029, twin_weight: 0.032, twin_weight_source: 'expected', held: false }),
  verdict(12, 'RAW35-FR-GT', 'CNC', 'agree', { session_date: '2026-11-02', rank: 3, weight: 0.029, twin_weight: 0.032, twin_weight_source: 'expected', held: true }),
  verdict(13, 'RAW35-FR-GT', 'MU', 'unsure', { session_date: '2026-11-02', rank: 4, weight: 0.029, twin_weight: 0.032, twin_weight_source: 'expected', held: false }),
];

export const METHOD_BOOK: MethodPayload = {
  method: RAW,
  row: RAW_ROW,
  lens_question: null,
  curves: { dates: DATES, original: [100, 101, 102, 108.9], twin: [100, 101.5, 103, 109.6], spy: [100, 100.5, 101, 106] },
  stats: {
    original: book('RAW35-FR-GT', { return: 0.089, worst_drop: 0.112, profit_factor: 2.04, fees_usd: 6.12, trades: 80 }),
    twin: book('RAW35-FR-GT-CX', { return: 0.096, worst_drop: 0.098, profit_factor: 2.11, fees_usd: 6.71, trades: 84 }),
    spy: book('SPY-GT', { return: 0.06, worst_drop: 0.074, profit_factor: null, fees_usd: 0.4, trades: 1 }),
  },
  checklist: {
    original: checklist(['fail', 'pass', 'pass', 'pass', 'fail'], ['7.0 of 18 mo', '+2.9 pts', '2.04', '11.2%', null]),
    twin: checklist(['fail', 'pass', 'pass', 'pass', 'na'], ['7.0 of 18 mo', '+3.6 pts', '2.11', '9.8%', null]),
  },
  decision: {
    strategy_id: 'RAW35-FR-GT',
    twin_id: 'RAW35-FR-GT-CX',
    session_date: '2026-11-02',
    data_date: '2026-10-30',
    kind: 'book',
    open_utc: '2026-11-02T14:30:00.000Z',
    coverage: 'reviewed',
    first_started_at: '2026-11-01T09:40:00Z',
    last_decided_at: '2026-11-01T10:55:00Z',
    models: ['claude-opus-5-5'],
    prompt_versions: ['raw35-v2'],
    lenses: ['raw35@2'],
    hosts: ['lenovo'],
    counts: { object: 1, unsure: 1, agree: 2, none: 0, late: 0 },
    all_objected: false,
    verdicts: BOOK_VERDICTS,
    picks: BOOK_VERDICTS.map((v) => ({ rank: v.rank ?? 0, symbol: v.symbol, weight: v.weight, held: v.held, twin_weight: v.twin_weight, twin_weight_source: v.twin_weight_source, verdict: v })),
  },
  decisions: [
    { session_date: '2026-11-02', data_date: '2026-10-30', kind: 'book', open_utc: '2026-11-02T14:30:00.000Z', coverage: 'reviewed', picks: 4, object: 1, unsure: 1, agree: 2, late: 0 },
  ],
  record: {
    ...emptyRecord('the month', null),
    points: [
      { symbol: 'SLB', session_date: '2026-10-14', rank: 1, gap_pts: -2.1, outcome: 'worse', stock_return: -0.012, kept_return: 0.009, kept: 34, horizon_from: '2026-10-13', horizon_to: '2026-10-30', sessions: 13, fell: true },
      { symbol: 'XOM', session_date: '2026-10-14', rank: 5, gap_pts: 1.0, outcome: 'better', stock_return: 0.019, kept_return: 0.009, kept: 34, horizon_from: '2026-10-13', horizon_to: '2026-10-30', sessions: 13, fell: false },
    ],
    summary: { objections: 2, scored: 2, worse: 1, same: 0, better: 1, pending: 0, fell: 1, mean_gap_pts: -0.55 },
  },
  // Revision.note is always null from phase 5; the page shows lens and verdict count instead.
  revisions: [
    { since: '2026-11-01', until: null, prompt_version: 'raw35-v2', model: 'opus-5-5', lens: 'raw35@2', verdicts: 35, note: null },
    { since: '2026-10-14', until: '2026-10-31', prompt_version: 'raw35-v1', model: 'opus-5-5', lens: 'raw35@1', verdicts: 210, note: null },
  ],
  three_way: null,
};

const NO_DUEL: CriticDuel = { critic_id: 'C-GT', nights: 0, disagreements: 0, scored: 0, claude_right: 0, critic_right: 0, pending: 0, rows: [] };

const DAILY_ROWS: ThreeWayRow[] = [
  { rank: 1, symbol: 'ZBRA', c: { verdict: 'veto', reason: 'Q3 earnings released November 3.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(20, 'A-GT', 'ZBRA', 'object', { rank: 1 }), buys: { original: true, critic: false, twin: false } },
  { rank: 4, symbol: 'HPQ', c: { verdict: 'veto', reason: 'HP announced a new CEO.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(21, 'A-GT', 'HPQ', 'agree', { rank: 4 }), buys: { original: false, critic: false, twin: true } },
  { rank: 9, symbol: 'SLB', c: { verdict: 'allow', reason: 'Only routine ETF flow recaps.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(22, 'A-GT', 'SLB', 'object', { rank: 9 }), buys: { original: false, critic: true, twin: false } },
  { rank: 6, symbol: 'PANW', c: { verdict: 'allow', reason: 'No company-specific event risk.', decided_at: '2026-11-04T07:00:00Z' }, claude: verdict(23, 'A-GT', 'PANW', 'agree', { rank: 6 }), buys: { original: false, critic: false, twin: null } },
];

export const METHOD_DAILY: MethodPayload = {
  ...METHOD_BOOK,
  method: A,
  row: A_ROW,
  lens_question: null,
  decision: null,
  decisions: [],
  record: emptyRecord('the 5 sessions', 5),
  three_way: {
    original: A,
    critic: CRITIC,
    twin_id: 'A-GT-CX',
    books: {
      original: book('A-GT', { return: 0.031, trades: 212, profit_factor: 1.06, worst_drop: 0.148 }),
      critic: book('C-GT', { return: 0.022, trades: 176, profit_factor: 1.02, worst_drop: 0.131 }),
      twin: book('A-GT-CX', { return: 0.054, trades: 198, profit_factor: 1.21, worst_drop: 0.116 }),
    },
    sessions: ['2026-11-04'],
    session_date: '2026-11-04',
    open_utc: '2026-11-04T14:30:00.000Z',
    coverage: 'reviewed',
    rows: DAILY_ROWS,
    grid: { c_veto_claude_object: ['ZBRA'], c_veto_claude_keep: ['HPQ'], c_allow_claude_object: ['SLB'], c_allow_claude_keep: ['PANW'] },
    settled: { claude_right: 31, critic_right: 17, disagreements: 48, scored: 48, pending: 0, nights: 40 },
    duel: NO_DUEL,
  },
};

export const TOGGLE_ON: AdversaryToggle = { on: true, changed_at: null, host: null };
export const TOGGLE_OFF: AdversaryToggle = { on: false, changed_at: '2026-11-04T02:12:00Z', host: 'lenovo' };
```

### Step 22: Tests
**File:** `web/src/lib/route.test.tsx`. Add `adversaryHref, adversaryRouteFromLocation` to the import on line 2,
and append this `describe` at the end of the file:
```tsx
describe('adversary route', () => {
  it('reads /adversary, /adversary/<id> and focus', () => {
    expect(adversaryRouteFromLocation(loc('/adversary'))).toEqual({ strategy: null, focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/'))).toEqual({ strategy: null, focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/RAW35-FR-GT'))).toEqual({ strategy: 'RAW35-FR-GT', focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/A-GT?focus=1'))).toEqual({ strategy: 'A-GT', focus: true });
    expect(adversaryRouteFromLocation(loc('/adversary/a%20b'))).toEqual({ strategy: 'a b', focus: false });
    expect(adversaryRouteFromLocation(loc('/adversary/a/b'))).toBeNull();
    expect(adversaryRouteFromLocation(loc('/adversaryx'))).toBeNull();
    expect(adversaryRouteFromLocation(loc('/'))).toBeNull();
    expect(adversaryRouteFromLocation(loc('/projects'))).toBeNull();
  });

  it('keeps the strategy id exactly (no case change)', () => {
    expect(adversaryRouteFromLocation(loc('/adversary/raw35-fr-gt'))?.strategy).toBe('raw35-fr-gt');
  });

  it('builds the href', () => {
    expect(adversaryHref({ strategy: null, focus: false })).toBe('/adversary');
    expect(adversaryHref({ strategy: 'RAW35-FR-GT', focus: false })).toBe('/adversary/RAW35-FR-GT');
    expect(adversaryHref({ strategy: 'A-GT', focus: true })).toBe('/adversary/A-GT?focus=1');
    expect(adversaryHref({ strategy: 'a b', focus: false })).toBe('/adversary/a%20b');
  });

  it('syncs the adversary view and leaves it for /', () => {
    expect(hrefForView('adversary', null, loc('/'), undefined, { strategy: null, focus: false })).toBe('/adversary');
    expect(hrefForView('adversary', null, loc('/adversary'), undefined, { strategy: null, focus: false })).toBeNull();
    expect(hrefForView('adversary', null, loc('/adversary'), undefined, { strategy: 'A-GT', focus: false })).toBe('/adversary/A-GT');
    expect(hrefForView('adversary', null, loc('/adversary/A-GT'), undefined, { strategy: 'A-GT', focus: true })).toBe('/adversary/A-GT?focus=1');
    expect(hrefForView('wall', null, loc('/adversary/A-GT'))).toBe('/');
    expect(hrefForView('bin', null, loc('/adversary'))).toBe('/');
    expect(hrefForView('projects', null, loc('/adversary'), { repo: 'a', node: null, focus: false })).toBe('/projects?repo=a');
    expect(hrefForView('wall', null, loc('/?note=A-B32'))).toBeNull();
  });
});
```

**File:** `web/src/hooks/useFocusShortcut.test.tsx` (create)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useFocusShortcut } from './useFocusShortcut';

afterEach(cleanup);

function Harness({ onToggle, focus, escapeLeaves }: { onToggle?: () => void; focus: boolean; escapeLeaves?: boolean }) {
  useFocusShortcut(onToggle, { focus, escapeLeaves });
  return null;
}

const key = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(e);
  return e;
};

describe('useFocusShortcut', () => {
  it('Alt+Z toggles and is cancelled; other chords are not', () => {
    const t = vi.fn();
    render(<Harness onToggle={t} focus={false} />);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true }).defaultPrevented).toBe(true);
    expect(t).toHaveBeenCalledTimes(1);
    expect(key({ code: 'KeyZ', key: 'z' }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true, repeat: true }).defaultPrevented).toBe(false);
    expect(t).toHaveBeenCalledTimes(1);
  });

  it('Esc leaves focus mode only in focus and only while escapeLeaves', () => {
    const t = vi.fn();
    const { rerender } = render(<Harness onToggle={t} focus={false} />);
    key({ key: 'Escape' });
    expect(t).not.toHaveBeenCalled();
    rerender(<Harness onToggle={t} focus escapeLeaves={false} />);
    key({ key: 'Escape' });
    expect(t).not.toHaveBeenCalled();
    rerender(<Harness onToggle={t} focus />);
    key({ key: 'Escape' });
    expect(t).toHaveBeenCalledTimes(1);
  });

  it('binds nothing without a toggle', () => {
    render(<Harness focus />);
    expect(key({ code: 'KeyZ', key: 'z', altKey: true }).defaultPrevented).toBe(false);
  });
});
```

**File:** `web/src/lib/adversary.test.tsx` (create)
```tsx
import { describe, expect, it } from 'vitest';
import { OVERVIEW, METHOD_BOOK, METHOD_DAILY } from '../testing/adversaryFixtures';
import {
  adversaryChatMessage,
  adversaryCountLine,
  adversaryHeading,
  causeTiles,
  checkValue,
  coverageLabel,
  decisionSummary,
  disagreement,
  methodHeading,
  overviewCountLine,
  paperMonth,
  pct,
  pts,
  ratio,
  rosterNames,
  shortDate,
  usd,
} from './adversary';

const NOW = new Date('2026-11-05T03:00:00Z');

describe('adversary formatting', () => {
  it('signs numbers with a real minus', () => {
    expect(pct(0.054)).toBe('+5.4%');
    expect(pct(-0.01)).toBe('−1.0%');
    expect(pct(0)).toBe('0.0%');
    expect(pct(null)).toBe('—');
    expect(pts(-1.9)).toBe('−1.9 pts');
    expect(usd(38.2)).toBe('+$38.20');
  });

  it('formats calendar dates without a time zone shift', () => {
    expect(shortDate('2026-11-04')).toBe('Nov 4');
    expect(shortDate('2026-01-31')).toBe('Jan 31');
  });

  it('labels coverage per engine', () => {
    // Phase 5's Coverage: decisions, reviewed, absent, late, paused, pending.
    const cov = (reviewed: number, absent: number, paused: number, pending = 0) => ({ decisions: reviewed + absent + paused + pending, reviewed, absent, late: 0, paused, pending });
    expect(coverageLabel(cov(78, 17, 5), 'bracket', 'daily')).toBe('78% · 17% · 5%');
    expect(coverageLabel(cov(7, 0, 0), 'book', 'monthly')).toBe('7 of 7 rebalances');
    expect(coverageLabel(cov(6, 0, 1), 'book', 'monthly')).toBe('6 of 7 rebalances · 1 paused');
    expect(coverageLabel(cov(3, 0, 0), 'book', 'quarterly')).toBe('3 of 3 re-picks');
    expect(coverageLabel(cov(0, 0, 0), 'book', 'monthly')).toBe('no decisions yet');
    expect(coverageLabel(cov(0, 0, 0, 1), 'book', 'monthly')).toBe('1 pending');
    expect(coverageLabel(cov(7, 0, 0, 1), 'book', 'monthly')).toBe('7 of 7 rebalances · 1 pending');
  });

  it("renders phase 5's profit factor, including no losing trade", () => {
    expect(ratio(2.04)).toBe('2.04');
    expect(ratio('infinite')).toBe('∞');
    expect(ratio(null)).toBe('n/a');
  });

  it('heads a method page with its code, or its plain name when the code is one or two letters', () => {
    expect(methodHeading('RAW35 · Momentum')).toBe('RAW35.');
    expect(methodHeading('A · Dip buy')).toBe('Dip buy.');
    expect(methodHeading('SOLO')).toBe('SOLO.');
  });

  it('counts paper months from the earliest twin start', () => {
    expect(paperMonth('2026-10-20', NOW)).toBe(1);
    expect(paperMonth('2026-05-05', NOW)).toBe(7);
    expect(paperMonth(null, NOW)).toBeNull();
  });

  it('writes the overview count line from the payload', () => {
    expect(overviewCountLine(OVERVIEW, null, NOW)).toBe(
      "3 methods on Seer's roster, each with a Claude twin that drops the picks Claude objects to. Month 1 of 18. Last review: RAW35's 35 picks for Nov 2, on Nov 1.",
    );
    expect(overviewCountLine(null, 'seer_unavailable', NOW)).toContain("can't be reached");
    expect(overviewCountLine(null, null, NOW)).toBe('Loading Seer Adversarial.');
  });

  it('heads and counts each sub-page', () => {
    const s = { overview: OVERVIEW, overviewError: null, method: METHOD_BOOK, methodError: null };
    expect(adversaryHeading(s, null)).toBe('Adversary.');
    expect(adversaryHeading(s, 'RAW35-FR-GT')).toBe('RAW35.');
    expect(adversaryHeading(s, 'A-GT')).toBe('Dip buy.');
    expect(adversaryHeading(s, 'NOPE')).toBe('Adversary.');
    expect(adversaryCountLine(s, 'RAW35-FR-GT', NOW)).toBe(
      'The 35 stocks that rose most beyond the market, re-picked each month. Nov 2 decision: 4 picks, 1 objection, 1 can\'t tell.',
    );
    expect(adversaryCountLine({ ...s, methodError: 'not_found' }, 'NOPE', NOW)).toBe("No method NOPE on Seer's roster.");
    expect(decisionSummary(null)).toBe('No verdicts yet.');
  });

  it('builds the cause tiles from ids, naming methods from the roster', () => {
    const tiles = causeTiles({ ...OVERVIEW.cause, twins_beat_spy: ['A-GT', 'RAW35-FR-GT'], originals_beat_spy: ['RAW35-FR-GT'] }, rosterNames(OVERVIEW.roster));
    expect(tiles.map((t) => t.value)).toEqual(['2 of 3 twins', '+$38.20', '−1.9 pts']);
    expect(tiles[0]?.text).toBe("A's and RAW35's twins are ahead of SPY. Of the originals, RAW35 is.");
  });

  it('writes checklist cells', () => {
    const [r1, r2, , , r5] = METHOD_BOOK.checklist.twin;
    expect(checkValue(r1!)).toBe('7.0 of 18 mo');
    expect(checkValue(r2!)).toBe('+3.6 pts · pass');
    expect(checkValue(r5!)).toBe("can't be run");
    expect(checkValue(METHOD_BOOK.checklist.original[4]!)).toBe('failed');
  });

  it('sorts the disagreement grid', () => {
    expect(disagreement(METHOD_DAILY.three_way!.rows)).toEqual({ bothBlock: ['ZBRA'], claudeOnly: ['SLB'], criticOnly: ['HPQ'], bothKeep: ['PANW'] });
  });

  it('names the page on the chat message first line', () => {
    expect(adversaryChatMessage('why ZBRA?', null)).toBe('[Seer Adversarial · overview]\nwhy ZBRA?');
    expect(adversaryChatMessage('why?', 'A-GT')).toBe('[Seer Adversarial · A-GT]\nwhy?');
  });
});
```

**File:** `web/src/hooks/useAdversary.test.tsx` (create)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { METHOD_BOOK, OVERVIEW, TOGGLE_ON } from '../testing/adversaryFixtures';
import { useAdversary } from './useAdversary';

class FakeES {
  static all: FakeES[] = [];
  private l = new Map<string, Array<(e?: unknown) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data: '{}' });
  }
}

let calls: string[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/adversary/overview') return json(OVERVIEW);
      if (url === '/api/adversary/toggle') return method === 'PUT' ? json({ ...TOGGLE_ON, ...(JSON.parse(String(init?.body)) as object) }) : json(TOGGLE_ON);
      if (url === '/api/adversary/methods/RAW35-FR-GT') return json(METHOD_BOOK);
      if (url === '/api/adversary/methods/GONE') return json({ error: 'not_found' }, 404);
      return json({ error: 'seer_unavailable' }, 503);
    }),
  );
});

afterEach(() => {
  FakeES.all = [];
  vi.unstubAllGlobals();
});

describe('useAdversary', () => {
  it('fetches nothing while disabled', async () => {
    renderHook(() => useAdversary(false, null));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
  });

  it('loads the overview, the toggle and the method', async () => {
    const { result } = renderHook(() => useAdversary(true, 'RAW35-FR-GT'));
    await waitFor(() => expect(result.current.method?.method.strategy_id).toBe('RAW35-FR-GT'));
    expect(result.current.overview?.methods).toHaveLength(3);
    expect(result.current.toggle?.on).toBe(true);
  });

  it('reports an unknown method by its code', async () => {
    const { result } = renderHook(() => useAdversary(true, 'GONE'));
    await waitFor(() => expect(result.current.methodError).toBe('not_found'));
  });

  it('refetches on the SSE adversary event', async () => {
    renderHook(() => useAdversary(true, null));
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/adversary/overview')).toHaveLength(1));
    act(() => FakeES.all[0]?.emit('adversary'));
    await waitFor(() => expect(calls.filter((c) => c === 'GET /api/adversary/overview')).toHaveLength(2));
  });

  it('PUTs the toggle and keeps the server answer', async () => {
    const { result } = renderHook(() => useAdversary(true, null));
    await waitFor(() => expect(result.current.toggle?.on).toBe(true));
    let ok = false;
    await act(async () => {
      ok = await result.current.setAuto(false);
    });
    expect(ok).toBe(true);
    expect(calls).toContain('PUT /api/adversary/toggle');
    expect(result.current.toggle?.on).toBe(false);
  });
});
```

**File:** `web/src/components/adversary/AdversaryOverview.test.tsx` (create)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { OVERVIEW } from '../../testing/adversaryFixtures';
import { AdversaryOverview } from './AdversaryOverview';

afterEach(cleanup);

describe('AdversaryOverview', () => {
  it('shows the cause tiles in order', () => {
    const { container } = render(<AdversaryOverview overview={OVERVIEW} onPick={vi.fn()} />);
    const tiles = Array.from(container.querySelectorAll('.adv-tile'));
    expect(tiles.map((t) => t.getAttribute('data-tile'))).toEqual(['spy', 'profit', 'drops']);
    expect(tiles[0]?.textContent).toContain('0 of 3 twins');
    expect(tiles[1]?.textContent).toContain('+$38.20');
    expect(tiles[2]?.textContent).toContain('−1.9 pts');
  });

  it('lists one row per method with returns, objections, coverage and both checklists', () => {
    const { container } = render(<AdversaryOverview overview={OVERVIEW} onPick={vi.fn()} />);
    const rows = Array.from(container.querySelectorAll('a.adv-row'));
    expect(rows.map((r) => r.getAttribute('data-strategy'))).toEqual(['A-GT', 'RAW35-FR-GT', 'COSK-FR-GT']);
    const a = rows[0] as HTMLElement;
    expect(a.getAttribute('href')).toBe('/adversary/A-GT');
    expect(a.textContent).toContain('+3.1%');
    expect(a.textContent).toContain('+5.4%');
    expect(a.textContent).toContain('61 / 1,190');
    expect(a.textContent).toContain('39 fell after');
    expect(a.textContent).toContain('78% · 17% · 5%');
    expect(within(a).getByRole('img', { name: 'original: 0 of 5 go-live rules passed' })).toBeTruthy();
    const twinDots = within(a).getByRole('img', { name: 'Claude twin: 2 of 5 go-live rules passed' });
    expect(twinDots.querySelectorAll('.adv-dot.na')).toHaveLength(1);
    expect(rows[1]?.textContent).toContain('7 of 7 rebalances');
    expect(rows[2]?.textContent).toContain('3 of 3 re-picks');
    // COSK's twin is behind its original: not highlighted.
    expect(rows[2]?.querySelectorAll('.adv-num.hi')).toHaveLength(0);
  });

  it('opens a method on a plain click', () => {
    const pick = vi.fn();
    const { container } = render(<AdversaryOverview overview={OVERVIEW} onPick={pick} />);
    fireEvent.click(container.querySelector('a[data-strategy="RAW35-FR-GT"]') as Element);
    expect(pick).toHaveBeenCalledWith('RAW35-FR-GT');
  });

  it('shows the latest objections with their method and sources', () => {
    render(<AdversaryOverview overview={OVERVIEW} onPick={vi.fn()} />);
    const latest = screen.getByRole('region', { name: 'Latest objections' });
    const cards = latest.querySelectorAll('article');
    expect(cards).toHaveLength(3);
    expect(cards[0]?.textContent).toContain('The dip follows oil, not SLB.');
    expect(cards[0]?.textContent).toContain('A · Nov 4');
    expect(within(cards[0] as HTMLElement).getByRole('link', { name: 'benzinga.com' }).getAttribute('href')).toBe('https://www.benzinga.com/slb');
    expect(cards[2]?.textContent).toContain("can't tell");
  });

  it('never shows a sample-data chip, and says so when there are no methods', () => {
    const { container } = render(<AdversaryOverview overview={{ ...OVERVIEW, methods: [], latest: [] }} onPick={vi.fn()} />);
    expect(container.textContent).not.toContain('sample data');
    expect(container.textContent).toContain("No method on Seer's roster has a Claude twin yet.");
    expect(container.textContent).toContain('No objections yet.');
  });
});
```

**File:** `web/src/pages/AdversaryPage.test.tsx` (create)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdversaryStore } from '../hooks/useAdversary';
import { METHOD_BOOK, METHOD_DAILY, OVERVIEW, TOGGLE_OFF, TOGGLE_ON } from '../testing/adversaryFixtures';
import { AdversaryPage, type AdversaryPageProps } from './AdversaryPage';

afterEach(cleanup);

const store = (over: Partial<AdversaryStore> = {}): AdversaryStore => ({
  overview: OVERVIEW,
  overviewError: null,
  method: null,
  methodError: null,
  toggle: TOGGLE_ON,
  setAuto: vi.fn(async () => true),
  reviewNow: vi.fn(async () => ({ started: true, reason: null })),
  refresh: vi.fn(),
  ...over,
});

const page = (over: Partial<AdversaryPageProps> = {}) =>
  render(
    <AdversaryPage
      store={store()}
      strategy={null}
      focus={false}
      onToggleFocus={vi.fn()}
      escapeLeavesFocus
      onPickStrategy={vi.fn()}
      onAsk={vi.fn()}
      {...over}
    />,
  );

describe('AdversaryPage toolbar', () => {
  it('auto-runs on: inverted, pressed, and a click pauses', () => {
    const s = store();
    page({ store: s });
    const btn = screen.getByRole('button', { name: 'Auto-runs on (click to pause)' });
    expect(btn.className).toBe('ibtn on');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.textContent).toBe('');
    fireEvent.click(btn);
    expect(s.setAuto).toHaveBeenCalledWith(false);
  });

  it('auto-runs off: dashed ring, not pressed, and a click turns it on', () => {
    const s = store({ toggle: TOGGLE_OFF });
    page({ store: s });
    const btn = screen.getByRole('button', { name: 'Auto-runs off (click to turn on)' });
    expect(btn.className).toBe('ibtn adv-off');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Review now' }).getAttribute('data-tip')).toBe('Review now (runs once, even while auto-runs are off)');
    fireEvent.click(btn);
    expect(s.setAuto).toHaveBeenCalledWith(true);
  });

  it('is disabled until the toggle has loaded', () => {
    page({ store: store({ toggle: null }) });
    expect((screen.getByRole('button', { name: 'Auto-runs on (click to pause)' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Review now asks for the overview or this method, and says what happened', async () => {
    const s = store({ method: METHOD_BOOK });
    page({ store: s, strategy: 'RAW35-FR-GT' });
    fireEvent.click(screen.getByRole('button', { name: 'Review this method now' }));
    await screen.findByText('review started');
    expect(s.reviewNow).toHaveBeenCalledWith('RAW35-FR-GT');
  });

  it('Focus: the button and Alt+Z both toggle; Esc leaves only while allowed', () => {
    const t = vi.fn();
    const { rerender } = page({ onToggleFocus: t });
    fireEvent.click(screen.getByRole('button', { name: 'Focus (Alt+Z)' }));
    expect(t).toHaveBeenCalledTimes(1);
    const e = new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(t).toHaveBeenCalledTimes(2);
    const props = { store: store(), strategy: null, onPickStrategy: vi.fn(), onAsk: vi.fn(), onToggleFocus: t };
    rerender(<AdversaryPage {...props} focus escapeLeavesFocus={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(t).toHaveBeenCalledTimes(2);
    rerender(<AdversaryPage {...props} focus escapeLeavesFocus />);
    expect(screen.getByRole('button', { name: 'Exit focus (Alt+Z)' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('auto-runs on')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(t).toHaveBeenCalledTimes(3);
  });
});

describe('AdversaryPage content', () => {
  it('picks the method layout for a book and the daily layout when the API sends a three-way', () => {
    const { rerender } = page({ store: store({ method: METHOD_BOOK }), strategy: 'RAW35-FR-GT' });
    expect(screen.getByRole('region', { name: 'Go-live checklist' })).toBeTruthy();
    expect(screen.getByText("can't be run")).toBeTruthy();
    expect(screen.getByText('Claude already knows how the past turned out, so a twin can never be backtested.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'object 1' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('held · sell')).toBeTruthy();
    expect(screen.getByText('weight 2.9% → 0')).toBeTruthy();
    rerender(
      <AdversaryPage store={store({ method: METHOD_DAILY })} strategy="A-GT" focus={false} onToggleFocus={vi.fn()} escapeLeavesFocus onPickStrategy={vi.fn()} onAsk={vi.fn()} />,
    );
    expect(screen.getByRole('region', { name: 'A, C and Claude compared' })).toBeTruthy();
    expect(document.querySelector('.adv-cand[data-symbol="SLB"]')?.getAttribute('data-claude-blocks')).toBe('true');
    expect(screen.getByText('31 of 48')).toBeTruthy();
  });

  it('shows the empty states', () => {
    const { rerender } = page({ store: store({ overview: null, overviewError: 'seer_unavailable' }) });
    expect(screen.getByText("Seer's database can't be reached from this machine, so there is nothing to show.")).toBeTruthy();
    rerender(
      <AdversaryPage
        store={store({ method: { ...METHOD_BOOK, decision: null } })}
        strategy="RAW35-FR-GT"
        focus={false}
        onToggleFocus={vi.fn()}
        escapeLeavesFocus
        onPickStrategy={vi.fn()}
        onAsk={vi.fn()}
      />,
    );
    expect(screen.getByText("No verdicts yet. Claude reviews this method's next decision after Seer's nightly.")).toBeTruthy();
  });

  it('the pill sends the question', async () => {
    const ask = vi.fn();
    page({ onAsk: ask });
    const box = screen.getByPlaceholderText('Ask about Seer Adversarial');
    fireEvent.change(box, { target: { value: 'why ZBRA?' } });
    fireEvent.submit(box.closest('form') as HTMLFormElement);
    await waitFor(() => expect(ask).toHaveBeenCalledWith('why ZBRA?', []));
  });
});
```

**File:** `web/src/components/Rail.test.tsx`. Replace lines 10-57 (both helpers and the first two "chat-history
icon" tests) with the block below. The remaining tests stay as they are, and two new `describe`s are appended at
the end.
```tsx
const rail = (view: View, onToggleHistory = vi.fn(), onToggleProjects = vi.fn(), onToggleAdversary = vi.fn()) =>
  render(
    <Rail
      mode="text"
      view={view}
      active={[]}
      onToggleSide={vi.fn()}
      onAdd={vi.fn()}
      onCycleMode={vi.fn()}
      onToggleProjects={onToggleProjects}
      onToggleHistory={onToggleHistory}
      onToggleAdversary={onToggleAdversary}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      onClear={vi.fn()}
    />,
  );

const side = (view: View, onToggleHistory = vi.fn(), extra: Partial<SidebarProps> = {}) =>
  render(
    <Sidebar
      mode="text"
      view={view}
      tags={[]}
      active={[]}
      onMode={vi.fn()}
      onToggleProjects={vi.fn()}
      onToggleHistory={onToggleHistory}
      onToggleAdversary={vi.fn()}
      onToggleBin={vi.fn()}
      onToggleTag={vi.fn()}
      {...extra}
    />,
  );

/** Labels of the icon buttons in DOM order. */
const order = (root: Element) => Array.from(root.querySelectorAll('button.ibtn')).map((b) => b.getAttribute('aria-label'));

describe('chat-history icon', () => {
  it('sits directly above Seer Adversarial, which sits directly above the recycle bin, in the rail', () => {
    const { container } = rail('wall');
    const labels = order(container.querySelector('.rail') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Seer Adversarial') - 1);
    expect(labels.indexOf('Seer Adversarial')).toBe(labels.indexOf('Recycle bin') - 1);
  });

  it('keeps the same order in the sidebar', () => {
    const { container } = side('wall');
    const labels = order(container.querySelector('.side-modes') as Element);
    expect(labels.indexOf('Chat history')).toBe(labels.indexOf('Seer Adversarial') - 1);
    expect(labels.indexOf('Seer Adversarial')).toBe(labels.indexOf('Recycle bin') - 1);
  });
```
Append at the end of the file. Also add `import type { AdversaryMethod } from '../adversaryApi';` below line 4.
```tsx
describe('Seer Adversarial icon', () => {
  it('is an icon-only Sword, pressed on the adversary view, and calls its toggle', () => {
    const toggle = vi.fn();
    rail('adversary', vi.fn(), vi.fn(), toggle);
    const btn = screen.getByRole('button', { name: 'Seer Adversarial' });
    expect(btn.textContent).toBe('');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.getAttribute('data-tip')).toBe('Seer Adversarial');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.className).toBe('ibtn on');
    expect(screen.getByRole('button', { name: 'Recycle bin' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(1);
    cleanup();
    rail('wall');
    expect(screen.getByRole('button', { name: 'Seer Adversarial' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('sidebar roster list', () => {
  const m = (id: string, name: string, over: Partial<AdversaryMethod> = {}): AdversaryMethod => ({
    strategy_id: id,
    twin_id: `${id}-CX`,
    name,
    short: name.split(' · ')[0] ?? name,
    sub: null,
    engine: 'book',
    cadence: 'monthly',
    status: 'active',
    paper_start: '2026-10-14',
    paper_end: null,
    ...over,
  });
  const roster = [
    m('A-GT', 'A · Dip buy', { engine: 'bracket', cadence: 'daily' }),
    m('RAW35-FR-GT', 'RAW35 · Momentum'),
    m('FULL50-GT', 'FULL50 · Never aside', { status: 'retired', paper_end: '2026-10-30' }),
    m('MOM70-GT', 'MOM70 · Momentum + SPY', { status: 'retired', paper_end: '2026-11-01' }),
  ];

  it('lists Overview first, active methods with cadence, retired greyed below, newest retirement first', () => {
    const pick = vi.fn();
    const { container } = side('adversary', vi.fn(), { roster, strategy: 'RAW35-FR-GT', onPickStrategy: pick, tags: [{ tag: 'kitchen', count: 3, last_used: null }] });
    expect(container.querySelector('.side-tags')).toBeNull();
    const rows = within(screen.getByRole('list', { name: 'Seer roster' })).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['Overview2', 'A · Dip buydaily', 'RAW35 · Momentummonthly']);
    expect(rows[2]!.className).toBe('tagrow on');
    const retired = within(screen.getByRole('list', { name: 'Retired methods' })).getAllByRole('listitem');
    expect(retired.map((r) => r.textContent)).toEqual(['MOM70 · Momentum + SPYNov 1', 'FULL50 · Never asideOct 30']);
    expect(container.querySelector('.side-retired')).not.toBeNull();
    fireEvent.click(rows[0]!);
    expect(pick).toHaveBeenCalledWith(null);
    fireEvent.click(rows[1]!);
    expect(pick).toHaveBeenCalledWith('A-GT');
  });

  it('says loading before the roster arrives', () => {
    side('adversary', vi.fn(), { roster: null });
    expect(screen.getByText('loading')).toBeTruthy();
  });
});
```

**File:** `web/src/App.adversary.test.tsx` (create)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note } from './types';
import { makeNote } from './testing/fixtures';
import { METHOD_BOOK, METHOD_DAILY, OVERVIEW, TOGGLE_ON } from './testing/adversaryFixtures';
import { App } from './App';

const notes: Note[] = [makeNote('A-B32', 'buy fennel #kitchen', { created: new Date().toISOString() })];
let calls: string[];
let toggle = { ...TOGGLE_ON };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  toggle = { ...TOGGLE_ON };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (url === '/api/adversary/overview') return json(OVERVIEW);
      if (url === '/api/adversary/methods/RAW35-FR-GT') return json(METHOD_BOOK);
      if (url === '/api/adversary/methods/A-GT') return json(METHOD_DAILY);
      if (url === '/api/adversary/toggle') {
        if (method === 'PUT') toggle = { on: (JSON.parse(String(init?.body)) as { on: boolean }).on, changed_at: '2026-11-05T02:00:00Z', host: 'lenovo' };
        return json(toggle);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  window.history.replaceState(null, '', '/');
});

const h1 = () => screen.queryByRole('heading', { level: 1 })?.textContent ?? null;
const at = (url: string) => window.history.replaceState(null, '', url);
const where = () => window.location.pathname + window.location.search;
const rail = () => document.querySelector('.rail') as HTMLElement;
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

describe('App: Seer Adversarial', () => {
  it('the sword opens /adversary with the roster in the sidebar; a second press returns to the wall', async () => {
    render(<App />);
    expect(calls.some((c) => c.includes('/api/adversary'))).toBe(false);
    fireEvent.click(within(rail()).getByRole('button', { name: 'Seer Adversarial' }));
    await waitFor(() => expect(where()).toBe('/adversary'));
    expect(h1()).toBe('Adversary.');
    const list = await screen.findByRole('list', { name: 'Seer roster' });
    expect(within(list).getAllByRole('listitem').map((r) => r.getAttribute('data-strategy'))).toEqual(['', 'A-GT', 'RAW35-FR-GT', 'COSK-FR-GT']);
    expect(within(screen.getByRole('list', { name: 'Retired methods' })).getAllByRole('listitem')).toHaveLength(2);
    await screen.findByText(/3 methods on Seer's roster/);
    // The page's own pill replaces the wall chat bar.
    expect(screen.getByPlaceholderText('Ask about Seer Adversarial')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Ask about your notes')).toBeNull();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Seer Adversarial' }));
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('a roster row opens the method page; Back returns to the overview', async () => {
    at('/adversary');
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Seer roster' });
    fireEvent.click(within(list).getByText('RAW35 · Momentum'));
    await waitFor(() => expect(where()).toBe('/adversary/RAW35-FR-GT'));
    await screen.findByRole('region', { name: 'Go-live checklist' });
    expect(h1()).toBe('RAW35.');
    pop('/adversary');
    await waitFor(() => expect(h1()).toBe('Adversary.'));
    await screen.findByRole('region', { name: 'Methods' });
  });

  it('a deep link to a bracket method with a C sibling opens the three-way page', async () => {
    at('/adversary/A-GT');
    render(<App />);
    await screen.findByRole('region', { name: 'A, C and Claude compared' });
    expect(h1()).toBe('Dip buy.');
    expect(document.querySelector('.side')).not.toBeNull();
  });

  it('Alt+Z enters focus mode (no rail, sidebar or header) and Esc leaves it', async () => {
    at('/adversary');
    render(<App />);
    await screen.findByRole('region', { name: 'Methods' });
    const e = new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(where()).toBe('/adversary?focus=1'));
    expect(document.querySelector('.rail')).toBeNull();
    expect(document.querySelector('.side')).toBeNull();
    expect(h1()).toBeNull();
    expect(screen.getByText('Adversary.')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(where()).toBe('/adversary'));
    expect(document.querySelector('.rail')).not.toBeNull();
  });

  it('the Power toggle PUTs and flips to the dashed off state', async () => {
    at('/adversary');
    render(<App />);
    const on = await screen.findByRole('button', { name: 'Auto-runs on (click to pause)' });
    await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(on);
    const off = await screen.findByRole('button', { name: 'Auto-runs off (click to turn on)' });
    expect(off.className).toBe('ibtn adv-off');
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(calls).toContain('PUT /api/adversary/toggle');
  });
});
```

### Step 23: Feature map
`.claude/skills/verify-notesd/features/adversary.md` and its `features/README.md` row already exist when this
phase starts: phase 4 creates both and phase 5 appends its API / MCP / SSE section and widens the row
(reconciled). This phase never creates or replaces either file: it edits the one row and appends one section.

**File:** `.claude/skills/verify-notesd/features/README.md` (the Seer Adversarial row, as phase 5 leaves it)
**Change:** append `, wall` to the first and third cells, nothing else. The row becomes:
```markdown
| Seer Adversarial: reviewer, verdicts in Seer, toggle, budget, read API, MCP, SSE, wall | [adversary.md](adversary.md) | background job (`up --adversary`), Seer DB, API, MCP, SSE, wall |
```
If the row on disk differs from phase 5's text, keep its words and still only append `, wall` to cells 1 and 3.

**File:** `.claude/skills/verify-notesd/features/adversary.md` (modify: append at the end, after phase 5's section)
````markdown
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
````

## Principles applied

- Subtract before you add: the two focus `useEffect`s are deleted from `ProjectsPage.tsx`, and the new page and
  Projects both call `useFocusShortcut` (Steps 3–4). There is no second copy of the Alt+Z logic.
- Laziness protocol: the chat context rides on the message's first line (`adversaryChatMessage`). There is no
  new `/api/chat` field and no server change. The pill reuses ChatBar's page variant and the wall's
  AnswerPanel, not a new answer surface. The roster list reuses the `.tagrow`/`.side-repos` styles.
- Boundary discipline: the wire is normalised once, in `adversaryApi.ts` (arrays default to `[]`, and error
  bodies become `ApiError` carrying the server's code). Components trust the typed payload. Error codes become
  user text in one function (`errorText`).
- Make illegal states unrepresentable: which layout to show is decided by `three_way !== null` in the payload,
  not by a separate flag that could disagree with the data and not by an id list. `AdversaryRoute` holds the
  strategy and focus only, so the overview cannot carry a stale method.
- Prove it works: Proof drives a real daemon against a throwaway Seer schema built from Seer's own migrations
  (Step "Verification"). Billed paths (Review now, chat) are stubbed at the route or not driven, and Proof says
  which.
- Test behavior, not implementation: the tests assert the DOM a user sees (labels, aria-pressed, URLs, region
  names, row text) and the requests sent, not hook internals.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/seer-adversarial && ( [ -d node_modules ] || npm ci ) && npm run typecheck && npm run build`
**Tests:** `npm test` (the whole suite). Focused: `npx vitest run web/src/lib/route.test.tsx web/src/hooks/useFocusShortcut.test.tsx web/src/lib/adversary.test.tsx web/src/hooks/useAdversary.test.tsx web/src/components/adversary web/src/pages/AdversaryPage.test.tsx web/src/components/Rail.test.tsx web/src/App.adversary.test.tsx web/src/App.projects.test.tsx`
**Proof:** a throwaway notesd built from this worktree reads a throwaway Seer schema that was built from the Seer
checkout's migrations (001..027) and seeded. The wall page is driven with Playwright.
- Harness: `.claude/skills/verify-notesd` (`verify.sh up --web --sessions`, `api`, `ui`, `sql`, `note`, `down`).
  The Seer schema is seeded with `docker exec mcp-notes-pg-verify psql` (the same container). Route-level
  stubbing is used **only** for `POST /api/adversary/review-now` (J6), so that no billed review starts.
- Feature-map entries: `features/adversary.md` (its "Wall page (phase 6)" section; file created by phase 4) and `features/projects.md` (neighbor).
- Setup (run once, from the worktree; `SCR` is the verifier's scratchpad):
```sh
cd /home/miftah/.worktrees/mcp-notes/seer-adversarial
[ -d node_modules ] || npm ci
V=.claude/skills/verify-notesd/scripts/verify.sh
SEER_SRC=/home/miftah/.worktrees/seer/seer-adversarial     # /home/miftah/seer once phase 7 landed it
test -f "$SEER_SRC/db/migrations/027_adversary.sql" || { echo "phase 1 not landed: no 027"; exit 1; }
SCR=${SCR:-$(mktemp -d)}; mkdir -p "$SCR/seer"; SEERDB=seer_v6_$$
echo "DATABASE_URL=postgres://postgres:mcpnotes@127.0.0.1:55436/$SEERDB" > "$SCR/seer/.env.local"
SEER_DIR="$SCR/seer" NOTESD_ADVERSARY=off $V up --web --sessions | tee "$SCR/up.txt"
RUN=$(sed -n 's/^RUN=//p' "$SCR/up.txt"); URL=$(sed -n 's/^URL=//p' "$SCR/up.txt")
P() { docker exec -i mcp-notes-pg-verify psql -v ON_ERROR_STOP=1 -X -q -U postgres "$@"; }
P -c "create database $SEERDB"
for f in "$SEER_SRC"/db/migrations/*.sql; do P -d "$SEERDB" < "$f" || { echo "FAIL $f"; exit 1; }; done
cat > "$SCR/seer-seed.sql" <<'SQL'
-- Every active original starts on paper (A-GT arrives with paper_start NULL in 027).
UPDATE strategies SET paper_start = DATE '2026-10-20' WHERE status = 'active' AND paper_start IS NULL;
-- Twins, as store.ensure_twins (phase 2) creates them (contract C2), for every eligible original.
INSERT INTO strategies (id, name, sub, icon, is_champion, is_benchmark, params, sort, engine, rules_id, paper_start, status,
                        object_name, gate_note, gate_applicable, twin_of)
SELECT s.id || '-CX', regexp_replace(s.name, '^(.*?) · ', '\1+Claude · '), s.sub, s.icon, false, false, s.params, s.sort,
       s.engine, s.rules_id, GREATEST(s.paper_start, DATE '2026-10-20'), 'active', s.object_name,
       'Claude twin: no backtest is possible, Claude already knows how the past turned out.', false, s.id
FROM strategies s
WHERE s.status = 'active' AND s.twin_of IS NULL AND NOT s.is_benchmark AND coalesce(s.object_name, '') <> 'STRATEGY_C'
  AND NOT EXISTS (SELECT 1 FROM strategies t WHERE t.twin_of = s.id AND t.status = 'active');
-- Equity for every active row (benchmark, originals, twins, C) over 12 sessions.
INSERT INTO equity_snapshots (strategy_id, date, cash_usd, equity_usd)
SELECT s.id, d::date, 0, 10000 + (d::date - DATE '2026-10-20') * (5 + (length(s.id) % 7) * 3)
FROM strategies s, generate_series(DATE '2026-10-20', DATE '2026-11-04', INTERVAL '1 day') d
WHERE s.status = 'active' AND extract(isodow FROM d) < 6
ON CONFLICT DO NOTHING;
INSERT INTO paper_state (strategy_id, last_session, cash_usd, equity_usd, initial_cash_usd, usd_idr, pending_session, pending_decision)
SELECT s.id, DATE '2026-11-04', 0, 10000 + 15 * (5 + (length(s.id) % 7) * 3), 10000, 16300, DATE '2026-11-05', false
FROM strategies s WHERE s.status = 'active'
ON CONFLICT DO NOTHING;
-- Bracket candidates for Nov 5 (every active bracket original, C included: contract C1).
INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence)
SELECT s.id, DATE '2026-11-05', DATE '2026-11-04', 'bracket', v.rank, v.symbol, NULL, NULL
FROM strategies s, (VALUES (1, 'ZBRA'), (2, 'PLTR'), (3, 'HPQ'), (4, 'SLB')) AS v(rank, symbol)
WHERE s.status = 'active' AND s.engine = 'bracket' AND s.twin_of IS NULL;
-- C's own verdicts for the same list.
INSERT INTO news_vetoes (strategy_id, session_date, rank, symbol, verdict, reason, model, prompt_version, decided_at)
SELECT s.id, DATE '2026-11-05', v.rank, v.symbol, v.verdict, v.reason, 'glm-verify', 'c-veto-v1', TIMESTAMPTZ '2026-11-04T07:00:00Z'
FROM strategies s, (VALUES (1, 'ZBRA', 'veto', 'VERIFY-C-ZBRA earnings inside the window.'), (2, 'PLTR', 'veto', 'VERIFY-C-PLTR earnings the day before.'),
                           (3, 'HPQ', 'veto', 'VERIFY-C-HPQ new chief executive named.'), (4, 'SLB', 'allow', 'VERIFY-C-SLB routine news only.')) AS v(rank, symbol, verdict, reason)
WHERE s.status = 'active' AND s.object_name = 'STRATEGY_C' AND s.twin_of IS NULL;
-- Claude's verdicts for every bracket original that is not C, decided before the Nov 5 open (14:30Z).
INSERT INTO adversary_verdicts (strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version, host, started_at, decided_at)
SELECT s.id, DATE '2026-11-05', v.symbol, v.verdict, v.reason, v.sources::jsonb, 'dip@1', 'claude-opus-verify', 'pv-verify-1', 'verify-host',
       TIMESTAMPTZ '2026-11-04T09:30:00Z', TIMESTAMPTZ '2026-11-04T10:00:00Z'
FROM strategies s, (VALUES
  ('ZBRA', 'object', 'VERIFY-ZBRA fell on a lower forecast, a re-pricing rather than a dip.', '[{"url":"https://www.sec.gov/verify-zbra","title":"8-K","publisher":"sec.gov","published_at":null,"fetched_at":"2026-11-04T09:40:00Z"}]'),
  ('PLTR', 'unsure', 'VERIFY-PLTR could not find why it dipped, so the pick stands.', '[]'),
  ('HPQ',  'agree',  'VERIFY-HPQ a planned handover, the dip matches its group.', '[{"url":"https://www.hp.com/verify-hpq","title":"press release","publisher":"hp.com","published_at":null,"fetched_at":"2026-11-04T09:45:00Z"}]'),
  ('SLB',  'object', 'VERIFY-SLB the dip follows oil and the trend may be turning.', '[{"url":"https://www.eia.gov/verify-slb","title":"weekly petroleum status","publisher":"eia.gov","published_at":null,"fetched_at":"2026-11-04T09:50:00Z"}]')
) AS v(symbol, verdict, reason, sources)
WHERE s.status = 'active' AND s.engine = 'bracket' AND s.twin_of IS NULL AND coalesce(s.object_name, '') <> 'STRATEGY_C';
-- Book targets + candidates for the Nov 2 rank decision, and Claude's verdicts on them (before the 14:30Z open).
INSERT INTO book_targets (strategy_id, session_date, rank, symbol, weight, last_price)
SELECT s.id, DATE '2026-11-02', v.rank, v.symbol, v.weight, 10
FROM strategies s, (VALUES (1, 'AAA', 0.34), (2, 'BBB', 0.33), (3, 'CCC', 0.33)) AS v(rank, symbol, weight)
WHERE s.status = 'active' AND s.engine = 'book' AND s.twin_of IS NULL AND NOT s.is_benchmark
ON CONFLICT DO NOTHING;
INSERT INTO strategy_candidates (strategy_id, session_date, data_date, kind, rank, symbol, weight, evidence)
SELECT s.id, DATE '2026-11-02', DATE '2026-10-30', 'book', v.rank, v.symbol, v.weight, NULL
FROM strategies s, (VALUES (1, 'AAA', 0.34), (2, 'BBB', 0.33), (3, 'CCC', 0.33)) AS v(rank, symbol, weight)
WHERE s.status = 'active' AND s.engine = 'book' AND s.twin_of IS NULL AND NOT s.is_benchmark;
INSERT INTO adversary_verdicts (strategy_id, session_date, symbol, verdict, reason, sources, lens, model, prompt_version, host, started_at, decided_at)
SELECT s.id, DATE '2026-11-02', v.symbol, v.verdict, 'VERIFY-BOOK ' || s.id || ' ' || v.reason, v.sources::jsonb, 'book@1', 'claude-opus-verify', 'pv-verify-1', 'verify-host',
       TIMESTAMPTZ '2026-11-01T11:00:00Z', TIMESTAMPTZ '2026-11-01T12:00:00Z'
FROM strategies s, (VALUES
  ('AAA', 'agree',  'the rise rests on steady results.', '[{"url":"https://www.sec.gov/verify-aaa","title":"10-Q","publisher":"sec.gov","published_at":null,"fetched_at":"2026-11-01T11:10:00Z"}]'),
  ('BBB', 'object', 'one takeover rumour drove the rise.', '[{"url":"https://www.benzinga.com/verify-bbb","title":"rumour","publisher":"benzinga.com","published_at":null,"fetched_at":"2026-11-01T11:20:00Z"}]'),
  ('CCC', 'agree',  'nothing breaks the thesis.', '[{"url":"https://www.sec.gov/verify-ccc","title":"8-K","publisher":"sec.gov","published_at":null,"fetched_at":"2026-11-01T11:30:00Z"}]')
) AS v(symbol, verdict, reason, sources)
WHERE s.status = 'active' AND s.engine = 'book' AND s.twin_of IS NULL AND NOT s.is_benchmark;
SQL
P -d "$SEERDB" < "$SCR/seer-seed.sql"
P -d "$SEERDB" -tAc "select id, twin_of from strategies where twin_of is not null order by id"   # one -CX per eligible original
O=$(curl -fsS "$URL/api/adversary/overview"); echo "$O" > "$SCR/overview.json"
export BOOK=$(jq -r '[.methods[] | select(.engine=="book")][0].strategy_id' <<<"$O")
export BOOK_NAME=$(jq -r --arg id "$BOOK" '.roster[] | select(.strategy_id==$id) | .name' <<<"$O")
export BRACKET=$(jq -r '[.methods[] | select(.engine=="bracket")][0].strategy_id' <<<"$O")
export BRACKET_NAME=$(jq -r --arg id "$BRACKET" '.roster[] | select(.strategy_id==$id) | .name' <<<"$O")
export NAMES_JSON=$(jq -c '[.roster[] | select(.status=="active") | .name]' <<<"$O")
heading() { local h="${1%% · *}" t="${1#* · }"; [ "$t" = "$1" ] && t=""; if [ ${#h} -ge 3 ] || [ -z "$t" ]; then echo "$h."; else echo "$t."; fi; }
export BOOK_HEAD=$(heading "$BOOK_NAME") BRACKET_HEAD=$(heading "$BRACKET_NAME")
```
- Journeys (one per claim; each `steps-*.mjs` is written to `$SCR`, and the content is given in full):

**J1, the API carries the seeded Seer data (contract check against phase 5).**
`$V api RUN GET /api/adversary/overview`
Passes when the commands below show: `methods[].twin_id` equals `<strategy_id>-CX` for every row; `methods[]`
holds one book and one bracket method; `latest[].reason` contains `VERIFY-ZBRA` and `VERIFY-SLB`; there is no
`sample` anywhere in the body.
`jq -e '[.methods[] | .twin_id == (.strategy_id + "-CX")] | all' "$SCR/overview.json"`
`jq -e '[.latest[].reason] | any(test("VERIFY-ZBRA"))' "$SCR/overview.json"`
`! grep -qi sample "$SCR/overview.json"`
`$V api RUN GET /api/adversary/methods/$BRACKET` passes when `.three_way.rows` has 4 rows and `.three_way.critic.strategy_id` is C's id.

**J2, overview page, sword placement, sidebar roster (Main mock).** `$SCR/steps-overview.mjs`:
```js
export default async ({ page, base, shot, log }) => {
  const names = JSON.parse(process.env.NAMES_JSON)
  await page.goto(base + '/')
  const rail = page.locator('nav.rail')
  const labels = await rail.locator('button.ibtn').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')))
  const i = labels.indexOf('Seer Adversarial')
  if (i < 1 || labels[i - 1] !== 'Chat history' || labels[i + 1] !== 'Recycle bin') throw new Error('rail order: ' + labels.join(','))
  await rail.getByRole('button', { name: 'Seer Adversarial' }).click()
  await page.waitForURL(base + '/adversary')
  if ((await page.getByRole('heading', { level: 1 }).textContent()) !== 'Adversary.') throw new Error('heading')
  if ((await rail.getByRole('button', { name: 'Seer Adversarial' }).getAttribute('aria-pressed')) !== 'true') throw new Error('not pressed')
  const roster = page.getByRole('list', { name: 'Seer roster' })
  const rows = await roster.getByRole('listitem').allTextContents()
  if (!rows[0].startsWith('Overview')) throw new Error('Overview not first: ' + rows[0])
  for (const n of names) if (!rows.some((r) => r.startsWith(n))) throw new Error('missing roster row ' + n)
  await page.getByRole('region', { name: 'Methods' }).waitFor()
  await page.getByText('VERIFY-ZBRA', { exact: false }).first().waitFor()
  if ((await page.content()).toLowerCase().includes('sample data')) throw new Error('sample data chip shown')
  log('overview: sword between Chat history and Recycle bin, heading Adversary., roster from Seer DB, seeded objection shown')
  await shot('overview')
}
```
`BOOK=$BOOK BRACKET=$BRACKET NAMES_JSON="$NAMES_JSON" $V ui RUN "$SCR/steps-overview.mjs"` passes when the transcript
says `result: PASS` and has a screenshot `…-overview.png`.

**J3, book method page (Method mock).** `$SCR/steps-method.mjs`:
```js
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/adversary')
  await page.getByRole('list', { name: 'Seer roster' }).getByText(process.env.BOOK_NAME, { exact: true }).click()
  await page.waitForURL(base + '/adversary/' + encodeURIComponent(process.env.BOOK))
  await page.getByRole('heading', { level: 1, name: process.env.BOOK_HEAD }).waitFor()
  const checklist = page.getByRole('region', { name: 'Go-live checklist' })
  await checklist.getByText("can't be run").waitFor()
  await page.getByText('VERIFY-BOOK ' + process.env.BOOK, { exact: false }).first().waitFor()
  await page.getByRole('button', { name: /^object \d+$/ }).waitFor()
  await page.getByRole('region', { name: 'Prompt and model revisions' }).waitFor()
  log('method page: heading ' + process.env.BOOK_HEAD + ', twin rule 5 cannot be run, seeded objection card shown')
  await shot('method')
}
```
`BOOK=$BOOK BOOK_NAME="$BOOK_NAME" BOOK_HEAD="$BOOK_HEAD" $V ui RUN "$SCR/steps-method.mjs"` passes with `result: PASS`.

**J4, three-way page for the bracket original with a C sibling (Daily mock).** `$SCR/steps-daily.mjs`:
```js
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/adversary/' + encodeURIComponent(process.env.BRACKET))
  await page.getByRole('heading', { level: 1, name: process.env.BRACKET_HEAD }).waitFor()
  await page.getByRole('region', { name: / and Claude compared$/ }).waitFor()
  const zbra = page.locator('.adv-cand[data-symbol="ZBRA"]')
  await zbra.getByText('VERIFY-C-ZBRA', { exact: false }).waitFor()
  await zbra.getByText('VERIFY-ZBRA', { exact: false }).waitFor()
  if ((await page.locator('.adv-cand[data-symbol="SLB"]').getAttribute('data-claude-blocks')) !== 'true') throw new Error('SLB should be blocked by Claude')
  if ((await page.locator('.adv-cand[data-symbol="SLB"]').getAttribute('data-critic-blocks')) !== 'false') throw new Error('SLB should be allowed by C')
  await page.getByRole('table', { name: 'Where the critics disagree' }).waitFor()
  log('daily: C and Claude verdicts side by side from the seeded DB; SLB is Claude-only, the grid is shown')
  await shot('daily')
}
```
`BRACKET=$BRACKET BRACKET_HEAD="$BRACKET_HEAD" $V ui RUN "$SCR/steps-daily.mjs"` passes with `result: PASS`.

**J5, auto-runs off plus focus mode (Focus mock), and the toggle is persisted.** `$SCR/steps-focus-off.mjs`:
```js
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/adversary')
  const on = page.getByRole('button', { name: 'Auto-runs on (click to pause)' })
  await on.waitFor()
  if ((await on.getAttribute('aria-pressed')) !== 'true') throw new Error('on not pressed')
  await on.click()
  const off = page.getByRole('button', { name: 'Auto-runs off (click to turn on)' })
  await off.waitFor()
  if ((await off.getAttribute('aria-pressed')) !== 'false' || !(await off.getAttribute('class')).includes('adv-off')) throw new Error('off state')
  await page.keyboard.press('Alt+KeyZ')
  await page.waitForURL(base + '/adversary?focus=1')
  if (await page.locator('nav.rail').count()) throw new Error('rail visible in focus')
  if (await page.locator('aside.side').count()) throw new Error('sidebar visible in focus')
  await page.getByText(/^auto-runs off since /).waitFor()
  await page.getByRole('button', { name: 'Exit focus (Alt+Z)' }).waitFor()
  log('focus mode with auto-runs off: chrome hidden, status line shown')
  await shot('focus-off')
  await page.keyboard.press('Escape')
  await page.waitForURL(base + '/adversary')
  await page.locator('nav.rail').waitFor()
  log('Esc left focus mode')
}
```
`$V ui RUN "$SCR/steps-focus-off.mjs"` passes, and then the state is read back:
`$V api RUN GET /api/adversary/toggle` returns `"on":false`.
`$V sql RUN "select value from app_settings where key = 'adversary.auto'"` returns a value with `"on": false`.

**J6, live SSE update and Review now, with no billing.** `$SCR/steps-live.mjs`:
```js
export default async ({ page, base, shot, log }) => {
  let body = null
  await page.route('**/api/adversary/review-now', async (route) => {
    body = route.request().postData()
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{"started":true,"reason":null}' })
  })
  await page.goto(base + '/adversary')
  await page.getByRole('button', { name: 'Auto-runs off (click to turn on)' }).waitFor()
  // Another laptop turns it back on: the page follows over SSE, well inside the 60 s poll.
  const res = await fetch(base + '/api/adversary/toggle', { method: 'PUT', headers: { 'content-type': 'application/json', origin: base }, body: '{"on":true}' })
  if (res.status !== 200) throw new Error('PUT ' + res.status)
  await page.getByRole('button', { name: 'Auto-runs on (click to pause)' }).waitFor({ timeout: 10000 })
  log('SSE: toggle written elsewhere reached the page within 10 s')
  await page.getByRole('button', { name: 'Review now' }).click()
  await page.getByRole('status').getByText('review started').waitFor()
  if (body !== '{}') throw new Error('review-now body ' + body)
  log('Review now posted {} (overview) and showed the server answer; the route was stubbed so nothing was billed')
  await shot('live')
}
```
`$V ui RUN "$SCR/steps-live.mjs"` passes with `result: PASS`.

**J7, empty state when Seer is unreachable.** `.env.local` is read on every call, so it is moved away and then put back:
`mv "$SCR/seer/.env.local" "$SCR/seer/env.off"`, then `$V ui RUN "$SCR/steps-unavailable.mjs"`:
```js
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/adversary')
  await page.getByText("Seer's database can't be reached from this machine, so there is nothing to show.").waitFor()
  log('seer_unavailable empty state shown')
  await shot('unavailable')
}
```
Then `mv "$SCR/seer/env.off" "$SCR/seer/.env.local"`. Passes with `result: PASS`. Before that, `$V api RUN GET /api/adversary/overview`
shows the 503 `seer_unavailable` body.

- Neighbor check: Projects focus mode still works with the shared hook. First, `npx vitest run web/src/App.projects.test.tsx`
  is green. Then `$SCR/steps-projects-focus.mjs` (the run was started with `--sessions`):
```js
export default async ({ page, base, shot, log }) => {
  await page.goto(base + '/projects?repo=mcp-notes')
  await page.getByTestId('graph').waitFor()
  await page.keyboard.press('Alt+KeyZ')
  await page.waitForURL(base + '/projects?repo=mcp-notes&focus=1')
  if (await page.locator('nav.rail').count()) throw new Error('rail visible in projects focus')
  await page.keyboard.press('Escape')
  await page.waitForURL(base + '/projects?repo=mcp-notes')
  log('projects: Alt+Z and Esc unchanged')
  await shot('projects-focus')
}
```
  Passes with `result: PASS`.
- Cleanup: `$V down $RUN; P -c "drop database $SEERDB with (force)"`.
- Cost: none. The reviewer is off (`NOTESD_ADVERSARY=off`), Review now is route-stubbed, and the chat pill is
  not driven.
- `$V note RUN "<claim>"` one line per journey.

**Exit criteria:** `npm run typecheck`, `npm test` and `npm run build` are green, and `App.projects.test.tsx` is
unchanged and passing. J1–J7 and the neighbor journey pass on one verify run against a seeded Seer schema, with
screenshots `overview`, `method`, `daily` and `focus-off` saved in the run's evidence directory.

## Handoffs

- **Phase 5 (reconciled):** `web/src/adversaryApi.ts` is phase 5's Step 1 `readTypes.ts` verbatim. If phase 5's
  implementation changes a wire type, copy the change into `web/src/adversaryApi.ts` and the fixtures in the same
  set; components read the types. `MethodPayload.lens_question` and `Revision.note` are always null, so the page
  shows neither (a follow-up would need phase 4 to persist a lens summary and change note per prompt_version).
  Review-now is 202 and not awaited; the toggle PUT sends `{on}` only and phase 5 passes its own host to phase
  4's `setToggle(on, host)`.
- **Phase 5 (R5, MCP instructions):** phase 5 adds (reconciled) the sentence to its `Adversary.` instructions
  paragraph (`src/mcp/instructions.ts`): a turn whose first line is `[Seer Adversarial · <strategy_id|overview>]`
  was asked from that page of the wall, answered with the adversary_* tools. This phase sends the line
  (`adversaryChatMessage`) and owns no server prompt text.
- **Phase 7 (R7):** after the restart, open `http://127.0.0.1:7317/adversary` once to confirm the live page reads
  Neon's Seer. `verify-notesd` never touches the live daemon.
- **Follow-up (not in this set):** a first-class `page` field on `POST /api/chat`, which would replace the
  first-line context. It is a server change, so it is out of scope here.

## Rollback

Revert this phase's commit. It touches only `web/` and `.claude/skills/verify-notesd/features/`. The server's
`/api/adversary/*` (phase 5) stays and nothing else depends on the page. If only the shared hook misbehaves,
restore the two effects in `ProjectsPage.tsx` from git (`git show HEAD~:web/src/pages/ProjectsPage.tsx`).
