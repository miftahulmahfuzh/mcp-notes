> Adopted from `/home/miftah/.worktrees/mcp-notes/neon-egress-reduction/.workflows/orchestration/neon-egress-reduction/PLAN.md` phase 1. Source: `.workflows/plan/neon-egress-reduction/phase-1.md`.
> Written and reconciled by /analyze — edit the source, not this copy.
# Phase 1 — Web pollers: poll only while visible, slower, back off when unchanged

**Satisfies:** R1 · **Depends on:** — · **Package:** `web/` only · **Difficulty:** NORMAL
**Does not touch:** anything under `src/` (phases 2-5), the ETag/SSE wire contracts, `web/src/api.ts` signatures.

## Goal
Hidden tabs and idle views stop reading Neon. Today `useNotes` polls every 60 s regardless of visibility and view, and refetches on every SSE `note` event even when hidden; `useSessionGraph` polls every 10 s; `useProjects` and `useAdversary` poll every 60 s. After this phase no poller fires while `document.visibilityState !== 'visible'`, cadences are slower, and an unchanged result doubles the interval up to a cap.

## Design (decided)
| Hook | Before | After |
|---|---|---|
| `useNotes` poll | 60 s always | 300 s, visible only; SSE `note`/`open` while hidden only mark stale, one refetch on becoming visible; a stale-on-show refetch when the last load is older than 60 s |
| `useSessionGraph` | 10 s visible | 30 s base, ×2 per unchanged answer (304 / identical etag) up to 120 s; reset to 30 s on a changed answer or on becoming visible |
| `useProjects` | 60 s | 120 s visible only; refetch on becoming visible when older than 60 s |
| `useAdversary` | 60 s (+ SSE `adversary`) | 120 s visible only; SSE `adversary` while hidden marks stale, refetch on show |

Exported constants keep their names so tests and docs still resolve them: `GRAPH_POLL_MS = 30_000`, add `GRAPH_POLL_MAX_MS = 120_000`; `PROJECTS_POLL_MS = 120_000`; `ADVERSARY_POLL_MS = 120_000`; `useNotes` gets `export const NOTES_POLL_MS = 300_000` and `NOTES_STALE_MS = 60_000`.

## New file `web/src/lib/pageActive.ts`
```ts
/** True while the tab is in front. In jsdom (tests) `visibilityState` is 'visible'. */
export function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** Calls `fn` each time the tab becomes visible. Returns the unsubscribe. */
export function onBecameVisible(fn: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const handler = (): void => {
    if (document.visibilityState === 'visible') fn();
  };
  document.addEventListener('visibilitychange', handler);
  return () => document.removeEventListener('visibilitychange', handler);
}

export interface AdaptivePoll {
  /** Cancel the timer and the visibility listener. */
  stop(): void;
  /** Reset the delay to `baseMs` and run `run` now (if visible). */
  poke(): void;
}

/**
 * Runs `run` repeatedly while the tab is visible. `run` resolves true when it saw a change (the
 * delay resets to `baseMs`) and false when nothing changed (the delay doubles up to `maxMs`).
 * Nothing is scheduled while hidden; becoming visible runs once when `staleMs` has passed since
 * the last run, then resumes.
 */
export function startAdaptivePoll(opts: {
  baseMs: number;
  maxMs?: number;
  staleMs?: number;
  run: () => Promise<boolean>;
}): AdaptivePoll {
  const maxMs = opts.maxMs ?? opts.baseMs;
  const staleMs = opts.staleMs ?? opts.baseMs;
  let delay = opts.baseMs;
  let timer: number | undefined;
  let stopped = false;
  let lastRun = 0;
  let running = false;

  const schedule = (): void => {
    window.clearTimeout(timer);
    if (stopped || !isPageVisible()) return;
    timer = window.setTimeout(() => void tick(), delay);
  };
  const tick = async (): Promise<void> => {
    if (stopped || running || !isPageVisible()) return;
    running = true;
    try {
      const changed = await opts.run();
      delay = changed ? opts.baseMs : Math.min(maxMs, delay * 2);
    } catch {
      delay = Math.min(maxMs, delay * 2);
    } finally {
      running = false;
      lastRun = Date.now();
      schedule();
    }
  };
  const off = onBecameVisible(() => {
    if (Date.now() - lastRun >= staleMs) {
      delay = opts.baseMs;
      void tick();
    } else {
      schedule();
    }
  });
  lastRun = Date.now(); // the caller loads once itself on mount
  schedule();
  return {
    stop() {
      stopped = true;
      window.clearTimeout(timer);
      off();
    },
    poke() {
      delay = opts.baseMs;
      void tick();
    },
  };
}
```

## Edits

### `web/src/hooks/useSessionGraph.ts`
Replace the `setInterval`/`visibilitychange` block. `load()` must return whether anything changed: a 304 (`res.payload === null`) is "unchanged".
```ts
export const GRAPH_POLL_MS = 30_000;
export const GRAPH_POLL_MAX_MS = 120_000;
```
Inside the effect:
```ts
const load = async (): Promise<boolean> => {
  if (inFlight) return false;
  inFlight = true;
  try {
    const res = await fetchSessionGraph(repo, { signal: ctrl.signal, etag });
    const changed = res.payload !== null && res.etag !== etag;
    etag = res.etag;
    if (alive && res.payload !== null) setState({ nodes: res.payload.nodes, loaded: true, error: null });
    return changed;
  } catch (e) {
    if (alive && !ctrl.signal.aborted) setState((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) }));
    return false;
  } finally {
    inFlight = false;
  }
};
void load();
const poll = startAdaptivePoll({ baseMs: GRAPH_POLL_MS, maxMs: GRAPH_POLL_MAX_MS, staleMs: GRAPH_POLL_MS, run: load });
return () => { alive = false; ctrl.abort(); poll.stop(); };
```
(Keep the `etag` local `let`; compare before overwriting.) Update the doc comment: "Phase 7's suggested poll" → this phase's cadence.

### `web/src/hooks/useNotes.ts`
```ts
export const NOTES_POLL_MS = 300_000;
export const NOTES_STALE_MS = 60_000;
```
- `load()` records `lastLoad = Date.now()` on success and returns `true` when `notes`/`tags` JSON changed (cheap compare: `notes.length` + first/last `updated_at` + `JSON.stringify(tags)` length is not required; return `true` always is acceptable because the interval is fixed here — use `startAdaptivePoll({ baseMs: NOTES_POLL_MS, staleMs: NOTES_STALE_MS, run: async () => { await load(); return true; } })`).
- `schedule` becomes visibility-aware: when `!isPageVisible()` set `staleWhileHidden = true` and return without arming the timer; `onBecameVisible(() => { if (staleWhileHidden) { staleWhileHidden = false; schedule(); } })` (the adaptive poll's own stale-on-show covers the poll; this covers events).
- Keep the 250 ms debounce for visible tabs and the `gen` race logic untouched. `refetchRef.current = schedule` stays (user actions refetch even if the tab just lost focus — a hidden tab cannot act, so the guard is safe).
- Cleanup: `poll.stop()`, `offVisible()`, existing offs.

### `web/src/hooks/useProjects.ts`
`PROJECTS_POLL_MS = 120_000`. Replace `setInterval` with `startAdaptivePoll({ baseMs: PROJECTS_POLL_MS, staleMs: 60_000, run: async () => { await loadList(); return true; } })`; `stop()` in cleanup. Initial `void loadList()` stays.

### `web/src/hooks/useAdversary.ts`
`ADVERSARY_POLL_MS = 120_000`. Replace the interval with `startAdaptivePoll({ baseMs: ADVERSARY_POLL_MS, staleMs: 60_000, run: async () => { refresh(); return true; } })`. The SSE handler: `subscribeEvents('adversary', () => (isPageVisible() ? refresh() : (staleRef.current = true)))` with `onBecameVisible(() => { if (staleRef.current) { staleRef.current = false; refresh(); } })`. Update the doc comments ("every 60 s" → "every 2 min while visible").

## Tests (jsdom, existing patterns under `web/src/**/*.test.tsx`)
1. `web/src/lib/pageActive.test.ts`: with `vi.useFakeTimers()` and a stubbed `document.visibilityState` getter — (a) visible: `run` fires after `baseMs`; (b) hidden: no fire after 10×`baseMs`; (c) becoming visible after `staleMs` fires once immediately; (d) `run` resolving false doubles the delay to `maxMs` and no further; resolving true resets to `baseMs`; (e) `stop()` clears everything.
2. Update the existing tests of the four hooks that advance fake timers by 10 s / 60 s: use the exported constants instead of literals, and add one hidden-tab case per hook asserting zero fetches while hidden and exactly one on becoming visible (notes: after an SSE event while hidden).

## Verification
```sh
npm run typecheck
npx vitest run web/src
npm test
```
Manual (verify-notesd feature map, projects + wall): open the wall, switch to another tab for 6 minutes, confirm no `/api/notes` requests in the daemon log or devtools; return, confirm one request.

## Exit criteria
No `setInterval` remains in the four hooks; all pollers go through `startAdaptivePoll`; constants as above; `npm test` and `npm run typecheck` green; the tree builds.
