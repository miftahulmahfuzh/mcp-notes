# Phase 4: Context Rot view in the node panel

**Plan set:** `SESSION_CONTEXT_ROT_PLAN.md`
**Analysis:** `.workflows/analyze/20261112-093143-CR7T_code_analyzer.md`
**Satisfies:** R1, R3, R4 (the user sees how full a session's context is, live, and what a fresh spawn would start at)
**Criteria:** R1.1, R1.6, R1.7, R3.1, R3.4, R4.8
**Depends on:** Phase 2, Phase 3 (and through them Phase 1)
**Difficulty:** NORMAL
**Package:** `web/`

---

## Goal

The node panel's Subtree toggle gains an icon-only "Context Rot" button left of Tree. It shows a
bar of the session's current context over its window, coloured by the server's band, with an
"Unknown" state when there is no context. The bar stays live over the per-node SSE stream for a
running local session and polls every 60 s for another host's session. A second bar shows the
dry-run estimate of where "Spawn fresh with this context" would start. README and the
verify-notesd feature map describe the three new routes and the new fresh-spawn carry-over.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `web/src/sessionDetailApi.ts`: types `ContextBand`, `ContextWindowSource`, `SessionContext`, `SessionContextPayload`, `HandoffEstimate`; functions `normalizeSessionContext`, `normalizeContextPayload`, `parseContextEvent`, `fetchSessionContext`, `normalizeHandoffEstimate`, `fetchHandoffEstimate`; field `SessionDetail.context: SessionContext | null`
- `web/src/hooks/useSessionContext.ts`: `ContextFeed`, `CONTEXT_POLL_MS`, `contextFeed`, `newerContext`, `UseSessionContextArgs`, `useSessionContext`, `useHandoffEstimate`
- `web/src/components/graph/ContextRot.tsx`: `ContextRot`, `ContextBars`, `fillPercent`, `percentLabel`
- `web/src/components/graph/ContextRot.css`
- `web/src/components/graph/NodePanel.tsx`: `PANEL_VIEW_KEY` (localStorage key `mcp-notes:projects:panel-view`)
- CSS tokens `--band-green`, `--band-amber`, `--band-red` on `:root` (`web/src/styles.css`)
- tests: `web/src/components/graph/ContextRot.test.tsx`, `web/src/hooks/useSessionContext.test.tsx`
**Signature changes:** `export type SubtreeView = 'tree' | 'timeline'` -> `'context' | 'tree' | 'timeline'` (only `NodePanel.tsx` uses it)
**Requires (from earlier phases):**
- Phase 2: session detail wire carries `session.context` = `{tokens, window, percent, band, model, at, window_source, peak_tokens}` or `null`; `percent` is Phase 1's `contextPercent(tokens, window)`: 0..100 scale, one decimal, not clamped (settled by the reconciler), and `band` is `contextBand` of that same percent; `band` is `'green'|'amber'|'red'`; `window_source` is `'model'|'peak'|'beta'|'default'`; `at` is an ISO string or null.
- Phase 2: `GET /api/sessions/:nodeId/context` -> `{node_id, host, available, context}` (any host; 404 `not_found`); `GET /api/sessions/:nodeId/context/stream` SSE with events named `context` whose `data` is that same JSON, an initial event on connect.
- Phase 3: `GET /api/sessions/:nodeId/handoff` -> `{node_id, tokens, window, percent, baseline, exchanges_included, exchanges_total, truncated}`, dry run, any host; `percent` = `contextPercent(baseline + tokens, window)`, 0..100, one decimal. The estimate carries no `host` / `available` (those are on the context payload). Constants (Phase 3 `handoff.ts`): `HANDOFF_WINDOW_SHARE = 0.5`, `DEFAULT_BASELINE_TOKENS = 48_000`, `BASELINE_SAMPLE_SESSIONS = 20` (forks excluded), `CHARS_PER_TOKEN = 4`, `HANDOFF_MAX_AGE_MS` = 14 days, `HANDOFF_MARKER = '[notesd handoff]'`.
- Phase 1: `cc_sessions.context_tokens`, `context_at`, `context_peak_tokens`, `context_model` columns (used only by the Proof's seeding SQL); window table maps `claude-opus-5-5` to 1,000,000.
**Leaves alone (owned by others):** everything under `src/` and `claude/` (Phases 1–3), `drizzle/`, `tests/unit/**`, `tests/integration/**`. No server file is edited. This phase is the only one that edits `README.md`, `CLAUDE.md` and `.claude/skills/verify-notesd/features/projects.md`; phases 2 and 3 handed it their rows and proof recipes.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/sessionDetailApi.ts` | modify | context/estimate types, normalizers, fetchers (after L39 and L257); `SessionDetail.context` (L84, L245) |
| `web/src/hooks/useSessionContext.ts` | create | stream / poll / detail feed for the context; handoff estimate loader |
| `web/src/components/graph/ContextRot.tsx` | create | the two bars |
| `web/src/components/graph/ContextRot.css` | create | bar styles, band fills |
| `web/src/styles.css` | modify | `--band-*` tokens in `:root` (L26) |
| `web/src/components/graph/NodePanel.tsx` | modify | imports (L3, L24-28), `SubtreeView` + stored view (L30, L77), toggle + body (L445-476) |
| `web/src/components/graph/NodePanel.test.tsx` | modify | import (L5), `afterEach` clears localStorage (L125-129), new describe at end of file (after L536) |
| `web/src/components/graph/ContextRot.test.tsx` | create | bands 39/40/69/70, rounding, clamp, unknown, assumed window, estimate |
| `web/src/hooks/useSessionContext.test.tsx` | create | fake EventSource + fake timers: stream, poll, close |
| `web/src/sessionDetailApi.test.tsx` | modify | normalizer tests appended at end of file |
| `README.md` | modify | Projects tour paragraph (after L633), Resume paragraph (L727-728), MCP `session_resume` row (L1083), HTTP API rows (L1164, after L1167, `POST …/resume` L1173) |
| `.claude/skills/verify-notesd/features/projects.md` | modify | sub-features Context Rot + Spawn fresh handoff (after L121), L6 resume note, user POV (L124-126), driving sections "Context Rot" and "Spawn fresh handoff (fake tmux, safety-gated)" (before `## Gotchas`, L365), the resume gotcha |
| `CLAUDE.md` | modify | one sentence in the Claude Code sessions bullet (L41): context columns, `contextWindow.ts`, context stream, handoff |

## Implementation Steps

### Step 1: Wire types, normalizers and fetchers
**File:** `web/src/sessionDetailApi.ts:39` (insert after the `SessionTokens` interface, which ends at L39)
**Change:** add the context and estimate types plus their normalizers. Normalization happens here once (boundary); the hook and components trust the typed values. A context whose `band` is not one of the three, or whose window is not positive, normalizes to `null` (shown as Unknown) instead of a half-valid object.
**Code:**
```ts
/** Phase 1/2's context band (server `contextBand`): green below 40 %, amber below 70 %, red from 70 %. */
export type ContextBand = 'green' | 'amber' | 'red';

const CONTEXT_BANDS: readonly ContextBand[] = ['green', 'amber', 'red'];

/** Where the window came from (server `contextWindowFor`). 'default': assumed, the model is unknown and nothing showed a 1M window. */
export type ContextWindowSource = 'model' | 'peak' | 'beta' | 'default';

const WINDOW_SOURCES: readonly ContextWindowSource[] = ['model', 'peak', 'beta', 'default'];

/** A session's current context: its latest main-chain assistant message against its inferred window. */
export interface SessionContext {
  tokens: number;
  window: number;
  /** tokens / window × 100 as the server computed it; not clamped. */
  percent: number;
  band: ContextBand;
  model: string | null;
  at: string | null;
  window_source: ContextWindowSource;
  peak_tokens: number | null;
}

/** `GET /api/sessions/:nodeId/context`, and the data of each `context` event of its stream. */
export interface SessionContextPayload {
  node_id: string;
  host: string;
  available: boolean;
  context: SessionContext | null;
}

/** Phase 3's `GET /api/sessions/:nodeId/handoff`: where a fresh spawn would start, and what it would carry. */
export interface HandoffEstimate {
  node_id: string;
  tokens: number;
  window: number;
  percent: number;
  baseline: number;
  exchanges_included: number;
  exchanges_total: number;
  truncated: boolean;
}
```

**File:** `web/src/sessionDetailApi.ts` — insert after `function noteRef` (ends at L194), before the `normalizeSessionDetail` doc comment (L196):
```ts
/** A wire context, or null when there is none or it is not a complete one (shown as Unknown). */
export function normalizeSessionContext(v: unknown): SessionContext | null {
  if (!isObj(v)) return null;
  const tokens = numOrNull(v.tokens);
  const win = numOrNull(v.window);
  const percent = numOrNull(v.percent);
  const band = typeof v.band === 'string' && (CONTEXT_BANDS as readonly string[]).includes(v.band) ? (v.band as ContextBand) : null;
  if (tokens === null || win === null || win <= 0 || percent === null || band === null) return null;
  const source =
    typeof v.window_source === 'string' && (WINDOW_SOURCES as readonly string[]).includes(v.window_source)
      ? (v.window_source as ContextWindowSource)
      : 'default';
  return { tokens, window: win, percent, band, model: str(v.model), at: str(v.at), window_source: source, peak_tokens: numOrNull(v.peak_tokens) };
}

/** `{node_id, host, available, context}`, or null when it has no node id. */
export function normalizeContextPayload(v: unknown): SessionContextPayload | null {
  if (!isObj(v)) return null;
  const nodeId = str(v.node_id);
  if (nodeId === null) return null;
  return { node_id: nodeId, host: str(v.host) ?? '', available: v.available !== false, context: normalizeSessionContext(v.context) };
}

/** One `context` event's `data` (a JSON string), or null when it is not a context payload. */
export function parseContextEvent(data: unknown): SessionContextPayload | null {
  if (typeof data !== 'string') return null;
  try {
    return normalizeContextPayload(JSON.parse(data));
  } catch {
    return null;
  }
}

/** A wire estimate, or null when a field the bar needs is missing. */
export function normalizeHandoffEstimate(v: unknown): HandoffEstimate | null {
  if (!isObj(v)) return null;
  const nodeId = str(v.node_id);
  const tokens = numOrNull(v.tokens);
  const win = numOrNull(v.window);
  const percent = numOrNull(v.percent);
  const included = numOrNull(v.exchanges_included);
  const total = numOrNull(v.exchanges_total);
  if (nodeId === null || tokens === null || win === null || win <= 0 || percent === null || included === null || total === null) return null;
  return {
    node_id: nodeId,
    tokens,
    window: win,
    percent,
    baseline: num(v.baseline),
    exchanges_included: included,
    exchanges_total: total,
    truncated: v.truncated === true,
  };
}
```

**File:** `web/src/sessionDetailApi.ts:84` — in `interface SessionDetail`, after `job_id: string | null;` add:
```ts
  /** Phase 2: the session's current context, or null when no main-chain assistant message with usage was seen. */
  context: SessionContext | null;
```

**File:** `web/src/sessionDetailApi.ts:245` — in `normalizeSessionDetail`'s returned object, after `job_id: liveJobId(w.job_id ?? raw.job_id, live),` add:
```ts
    context: normalizeSessionContext(w.context),
```

**File:** `web/src/sessionDetailApi.ts:257` — insert after `fetchSessionDetail`:
```ts
/** `GET /api/sessions/:nodeId/context` -> the node's context payload, or null on 404. Works for either machine's sessions. */
export async function fetchSessionContext(nodeId: string, signal?: AbortSignal): Promise<SessionContextPayload | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/context`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const p = normalizeContextPayload(await res.json());
  if (p === null) throw new ApiError(500, 'bad context payload');
  return p;
}

/** `GET /api/sessions/:nodeId/handoff` -> the fresh-spawn estimate (a dry run, nothing written), or null on 404. */
export async function fetchHandoffEstimate(nodeId: string, signal?: AbortSignal): Promise<HandoffEstimate | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/handoff`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const e = normalizeHandoffEstimate(await res.json());
  if (e === null) throw new ApiError(500, 'bad handoff estimate');
  return e;
}
```
**Impact:** `SessionDetail` gains a required field. It is only ever built by `normalizeSessionDetail` (checked: no other literal in `web/src`), so nothing else breaks. Old daemons without `context` give `context: null`.

### Step 2: The context feed hook
**File:** `web/src/hooks/useSessionContext.ts` (new)
**Change:** one hook that keeps a node's context current. The view mounts it only while the Context Rot view is open, so "leaving the view" is an unmount. Feed choice:
- live and available -> one `EventSource` on the stream;
- available, not live -> no extra request: it follows `initial`, the detail's `context`, which `NodePanel` already re-fetches whenever the graph's stamp (`last_active_at|summarized`) changes;
- not available (other host) -> `GET /context` now and every 60 s, never a stream.
Every source goes through `newerContext`, so an older value (a detail fetched before the latest stream event) never overwrites a newer one.
**Code:**
```ts
import { useEffect, useState } from 'react';
import {
  fetchHandoffEstimate,
  fetchSessionContext,
  parseContextEvent,
  type HandoffEstimate,
  type SessionContext,
} from '../sessionDetailApi';

/**
 * How the Context Rot view keeps a session's context current:
 * - `stream`: live on this machine, so ingest feeds `GET /api/sessions/:nodeId/context/stream`.
 * - `poll`: the other machine's session; its ingest never reaches this daemon, so `GET .../context` every 60 s.
 * - `detail`: idle on this machine; the panel's detail (re-fetched on the graph's stamp) carries it.
 */
export type ContextFeed = 'stream' | 'poll' | 'detail';

/** Poll period for another machine's session. */
export const CONTEXT_POLL_MS = 60_000;

export function contextFeed(live: boolean, available: boolean): ContextFeed {
  if (!available) return 'poll';
  return live ? 'stream' : 'detail';
}

/** The later of two readings by `at`; a known context never goes back to null. Equal or unknown times take `next`. */
export function newerContext(cur: SessionContext | null, next: SessionContext | null): SessionContext | null {
  if (next === null) return cur;
  if (cur === null) return next;
  const a = Date.parse(cur.at ?? '');
  const b = Date.parse(next.at ?? '');
  if (Number.isFinite(a) && Number.isFinite(b) && b < a) return cur;
  return next;
}

export interface UseSessionContextArgs {
  nodeId: string;
  live: boolean;
  available: boolean;
  /** The session detail's `context`; it changes whenever the panel re-fetches the detail. */
  initial: SessionContext | null;
}

interface Held {
  key: string;
  ctx: SessionContext | null;
}

/** The node's current context while the view is mounted. Closes its stream or poll on unmount and on node change. */
export function useSessionContext({ nodeId, live, available, initial }: UseSessionContextArgs): SessionContext | null {
  const key = nodeId.toUpperCase();
  const [held, setHeld] = useState<Held>(() => ({ key, ctx: initial }));

  useEffect(() => {
    setHeld((h) => {
      if (h.key !== key) return { key, ctx: initial };
      const ctx = newerContext(h.ctx, initial);
      return ctx === h.ctx ? h : { key, ctx };
    });
  }, [key, initial]);

  const feed = contextFeed(live, available);

  useEffect(() => {
    if (feed === 'detail') return undefined;
    const take = (ctx: SessionContext | null): void => {
      setHeld((h) => {
        if (h.key !== key) return h;
        const next = newerContext(h.ctx, ctx);
        return next === h.ctx ? h : { key, ctx: next };
      });
    };

    if (feed === 'stream') {
      if (typeof EventSource === 'undefined') return undefined;
      const es = new EventSource(`/api/sessions/${encodeURIComponent(key)}/context/stream`);
      es.addEventListener('context', (e: Event) => {
        const p = parseContextEvent((e as MessageEvent).data);
        if (p !== null) take(p.context);
      });
      return () => es.close();
    }

    const ac = new AbortController();
    const load = (): void => {
      fetchSessionContext(key, ac.signal).then(
        (p) => {
          if (p !== null && !ac.signal.aborted) take(p.context);
        },
        () => {
          // a failed poll keeps the last reading; the next tick tries again
        },
      );
    };
    load();
    const timer = window.setInterval(load, CONTEXT_POLL_MS);
    return () => {
      ac.abort();
      window.clearInterval(timer);
    };
  }, [key, feed]);

  return held.key === key ? held.ctx : initial;
}

interface HeldEstimate {
  key: string;
  est: HandoffEstimate | null;
}

/**
 * Phase 3's dry-run estimate for "Spawn fresh with this context", loaded on mount and again whenever
 * `refreshKey` changes (the view passes the current context's tokens and time). Null while loading
 * and when the route fails: the view hides the bar quietly.
 */
export function useHandoffEstimate(nodeId: string, refreshKey: string): HandoffEstimate | null {
  const key = nodeId.toUpperCase();
  const [held, setHeld] = useState<HeldEstimate>({ key, est: null });

  useEffect(() => {
    const ac = new AbortController();
    fetchHandoffEstimate(key, ac.signal).then(
      (est) => {
        if (!ac.signal.aborted) setHeld({ key, est });
      },
      () => {
        if (!ac.signal.aborted) setHeld({ key, est: null });
      },
    );
    return () => ac.abort();
  }, [key, refreshKey]);

  return held.key === key ? held.est : null;
}
```
**Impact:** new file; nothing imports it until Step 4.

### Step 3: The bars
**File:** `web/src/components/graph/ContextRot.tsx` (new)
**Change:** `ContextRot` wires the hooks; `ContextBars` is the pure view (tested directly). The colour is the server's `band` (one rule, Phase 1's `contextBand`; the client never re-derives thresholds). The label's percent rounds down so 39.9 % never reads "40%" in green. The estimate bar has a neutral fill: the estimate payload has no band and the client does not re-implement the thresholds.
**Code:**
```tsx
import type { HandoffEstimate, SessionContext } from '../../sessionDetailApi';
import { useHandoffEstimate, useSessionContext } from '../../hooks/useSessionContext';
import { formatCount } from '../../lib/sessionFormat';
import './ContextRot.css';

/** Fill width in percent of the track: 0..100 whatever the server's percent. */
export function fillPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** Whole percent for the label, rounded down so it never reads as the next band (39.9 % shows "39%", green). */
export function percentLabel(percent: number): string {
  return `${Math.floor(Number.isFinite(percent) ? Math.max(0, percent) : 0)}%`;
}

export interface ContextRotProps {
  nodeId: string;
  live: boolean;
  available: boolean;
  /** The session detail's `context`. */
  initial: SessionContext | null;
}

/** The node panel's Context Rot view: mounted only while the view is open. */
export function ContextRot({ nodeId, live, available, initial }: ContextRotProps) {
  const context = useSessionContext({ nodeId, live, available, initial });
  const estimate = useHandoffEstimate(nodeId, context === null ? '' : `${context.tokens}|${context.at ?? ''}`);
  return <ContextBars context={context} estimate={estimate} />;
}

export interface ContextBarsProps {
  context: SessionContext | null;
  estimate: HandoffEstimate | null;
}

export function ContextBars({ context, estimate }: ContextBarsProps) {
  return (
    <div className="cr">
      {context === null ? (
        <div className="cr-row">
          <div className="cr-track cr-unknown" aria-hidden="true" />
          <p className="cr-text">
            <span className="cr-main">Unknown</span>
            <span className="cr-note">no reply with token usage yet</span>
          </p>
        </div>
      ) : (
        <div className="cr-row">
          <div
            className="cr-track"
            role="meter"
            aria-label="Current context"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fillPercent(context.percent))}
            aria-valuetext={`${percentLabel(context.percent)} of the context window`}
            data-band={context.band}
          >
            <div className={`cr-fill cr-${context.band}`} style={{ width: `${fillPercent(context.percent)}%` }} />
          </div>
          <p className="cr-text">
            <span className="cr-main">{`${formatCount(context.tokens)} / ${formatCount(context.window)} · ${percentLabel(context.percent)}`}</span>
            {context.model !== null && <span className="cr-note">{context.model}</span>}
            {context.window_source === 'default' && (
              <span className="cr-note" data-tip="Unknown model and no sign of a 1M window: 200k assumed">
                window assumed
              </span>
            )}
          </p>
        </div>
      )}
      {estimate !== null && (
        <div className="cr-row">
          <div
            className="cr-track"
            role="meter"
            aria-label="Fresh session estimate"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fillPercent(estimate.percent))}
          >
            <div className="cr-fill cr-fresh" style={{ width: `${fillPercent(estimate.percent)}%` }} />
          </div>
          <p className="cr-text">
            <span className="cr-main">{`Fresh session would start at ~${Math.round(fillPercent(estimate.percent))}%`}</span>
            <span className="cr-note">{`carries ${estimate.exchanges_included} of ${estimate.exchanges_total} exchanges`}</span>
            {estimate.truncated && (
              <span className="cr-note" data-tip="The first prompt and the newest exchanges that fit; the handoff points at the transcript for the rest">
                older ones left out
              </span>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
```

**File:** `web/src/components/graph/ContextRot.css` (new)
```css
/* Context Rot view (session-context-rot phase 4): hairline bars in the panel's mono language, no
   rounded or shadowed chrome. Band fills use the --band-* tokens on :root (styles.css). The wall is
   dark-only (index.html color-scheme: dark, one :root palette), so there is no light variant. */
.cr { display: flex; flex-direction: column; gap: 14px; }
.cr-row { display: flex; flex-direction: column; gap: 6px; }
.cr-track { position: relative; height: 8px; border: 1px solid var(--line-25); box-sizing: border-box; background: transparent; overflow: hidden; }
.cr-unknown { border-style: dashed; }
.cr-fill { height: 100%; transition: width .4s ease; }
.cr-green { background: var(--band-green); }
.cr-amber { background: var(--band-amber); }
.cr-red { background: var(--band-red); }
.cr-fresh { background: var(--muted); }
.cr-text { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.cr-main { font-size: 13px; color: var(--fg); }
.cr-note { color: var(--dim); }
@media (prefers-reduced-motion: reduce) {
  .cr-fill { transition: none; }
}
```

**File:** `web/src/styles.css:26` — replace
```css
  --line-45: rgba(236, 235, 228, .45);
}
```
with
```css
  --line-45: rgba(236, 235, 228, .45);
  /* Context Rot bands: amber and red are the hues the unfinished badge and failed chat thumbs already use. */
  --band-green: #7fb069;
  --band-amber: #e8b04a;
  --band-red: #c0473a;
}
```
**Impact:** new component and CSS; the tokens are new names, nothing else changes colour.

### Step 4: The toggle button and remembered view in NodePanel
**File:** `web/src/components/graph/NodePanel.tsx:3`
**Change:** replace the icon import line with:
```tsx
import { ArrowsOut, ChartBarHorizontal, Check, CloudSlash, Copy, Gauge, GitFork, Graph, LinkSimple, MagicWand, Play, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
```

**File:** `web/src/components/graph/NodePanel.tsx:24` — after `import { SubtreeTimeline } from './SubtreeTimeline';` add:
```tsx
import { ContextRot } from './ContextRot';
```

**File:** `web/src/components/graph/NodePanel.tsx:30` — replace `export type SubtreeView = 'tree' | 'timeline';` with:
```tsx
export type SubtreeView = 'context' | 'tree' | 'timeline';

const SUBTREE_VIEWS: readonly SubtreeView[] = ['context', 'tree', 'timeline'];

/** localStorage key: the panel's last view (Context Rot, Tree or Timeline), kept across reloads and tabs. */
export const PANEL_VIEW_KEY = 'mcp-notes:projects:panel-view';

/** The stored view, or Tree when there is none, it is unknown, or storage is blocked. */
function readView(): SubtreeView {
  try {
    const v = window.localStorage.getItem(PANEL_VIEW_KEY);
    return v !== null && (SUBTREE_VIEWS as readonly string[]).includes(v) ? (v as SubtreeView) : 'tree';
  } catch {
    return 'tree';
  }
}

function storeView(v: SubtreeView): void {
  try {
    window.localStorage.setItem(PANEL_VIEW_KEY, v);
  } catch {
    // storage unavailable (private mode, blocked): the toggle still works for this page
  }
}

/** The section's toggle, left to right. Icon-only, labels in the tooltip and aria-label. */
const VIEW_BUTTONS: ReadonlyArray<{ view: SubtreeView; label: string; Icon: Icon }> = [
  { view: 'context', label: 'Context Rot', Icon: Gauge },
  { view: 'tree', label: 'Tree', Icon: TreeStructure },
  { view: 'timeline', label: 'Timeline', Icon: ChartBarHorizontal },
];

/** The section heading follows the view. */
const VIEW_TITLE: Record<SubtreeView, string> = { context: 'Context Rot', tree: 'Subtree', timeline: 'Subtree' };
```

**File:** `web/src/components/graph/NodePanel.tsx:77` — replace `const [view, setView] = useState<SubtreeView>('tree');` with:
```tsx
  const [view, setViewState] = useState<SubtreeView>(readView);
  const setView = (v: SubtreeView): void => {
    setViewState(v);
    storeView(v);
  };
```

**File:** `web/src/components/graph/NodePanel.tsx:445-476` — replace the whole `<section className="np-sec" aria-label="Subtree"> … </section>` block with:
```tsx
          <section className="np-sec" aria-label={VIEW_TITLE[view]}>
            <div className="np-sec-head">
              <h3>{VIEW_TITLE[view]}</h3>
              <div className="np-toggle">
                {VIEW_BUTTONS.map(({ view: v, label, Icon: ViewIcon }) => (
                  <button
                    key={v}
                    type="button"
                    className={`ibtn hov${view === v ? ' on' : ''}`}
                    data-tip={label}
                    aria-label={label}
                    aria-pressed={view === v}
                    onClick={() => setView(v)}
                  >
                    <ViewIcon weight="duotone" />
                  </button>
                ))}
              </div>
            </div>
            {view === 'context' ? (
              <ContextRot
                key={detail.node_id}
                nodeId={detail.node_id}
                live={detail.live}
                available={detail.available}
                initial={detail.context}
              />
            ) : view === 'tree' ? (
              <SubtreeTree rows={rows} current={shownId} onSelect={onSelectNode} />
            ) : (
              <SubtreeTimeline rows={rows} current={shownId} now={now} onSelect={onSelectNode} />
            )}
          </section>
```
**Impact:** the Tree/Timeline buttons keep their labels, classes and `aria-pressed`, so the existing toggle test and every Playwright selector still match. `key={detail.node_id}` remounts the view on node change, which closes its stream or poll. `NodeModal` renders `NodePanel` too and gets the same view (same key; intended).

### Step 5: Tests — NodePanel
**File:** `web/src/components/graph/NodePanel.test.tsx:5` — replace `import { NodePanel } from './NodePanel';` with:
```tsx
import { NodePanel, PANEL_VIEW_KEY } from './NodePanel';
```

**File:** `web/src/components/graph/NodePanel.test.tsx:125-129` — replace the `afterEach` with:
```tsx
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  window.localStorage.clear();
});
```

**File:** `web/src/components/graph/NodePanel.test.tsx` — append at the end of the file (after L536):
```tsx
describe('NodePanel Context Rot', () => {
  const CTX = {
    tokens: 390_000,
    window: 1_000_000,
    percent: 39,
    band: 'green',
    model: 'claude-opus-5-5',
    at: '2026-11-01T03:00:00.000Z',
    window_source: 'model',
    peak_tokens: 390_000,
  };
  const EST = { node_id: 'A0-3G', tokens: 120_000, window: 1_000_000, percent: 12, baseline: 48_000, exchanges_included: 2, exchanges_total: 2, truncated: false };

  function stubRoutes(context: unknown = CTX): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith('/handoff')) return json(200, EST);
        return json(200, { ...WIRE, context });
      }),
    );
    return urls;
  }

  const toggleLabels = (): Array<string | null> =>
    Array.from(screen.getByRole('button', { name: 'Tree' }).parentElement?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('aria-label'));

  it('puts Context Rot left of Tree and shows the bars when clicked', async () => {
    const urls = stubRoutes();
    renderPanel();
    await screen.findByText('Orchestrated the wall editing phases.');
    expect(toggleLabels()).toEqual(['Context Rot', 'Tree', 'Timeline']);
    expect(screen.getByRole('heading', { name: 'Subtree' })).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Context Rot' }));
    expect(screen.getByRole('button', { name: 'Context Rot' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Tree' }).getAttribute('aria-pressed')).toBe('false');
    const region = screen.getByRole('region', { name: 'Context Rot' });
    expect(within(region).getByRole('heading', { name: 'Context Rot' })).toBeTruthy();
    expect(within(region).getByText('390k / 1M · 39%')).toBeTruthy();
    expect(within(region).getByRole('meter', { name: 'Current context' }).getAttribute('data-band')).toBe('green');
    expect(await within(region).findByText('carries 2 of 2 exchanges')).toBeTruthy();
    expect(urls).toContain('/api/sessions/A0-3G/handoff');
    expect(document.querySelector('.np-tree')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    expect(screen.getByRole('heading', { name: 'Subtree' })).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(document.querySelector('.np-tree')).not.toBeNull();
  });

  it('remembers the view across a remount', async () => {
    stubRoutes();
    const first = renderPanel();
    await screen.findByText('Orchestrated the wall editing phases.');
    fireEvent.click(screen.getByRole('button', { name: 'Context Rot' }));
    expect(window.localStorage.getItem(PANEL_VIEW_KEY)).toBe('context');
    first.unmount();
    renderPanel();
    expect((await screen.findByRole('button', { name: 'Context Rot' })).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('390k / 1M · 39%')).toBeTruthy();
  });

  it('opens on Tree when the stored view is unknown', async () => {
    window.localStorage.setItem(PANEL_VIEW_KEY, 'gantt');
    stubRoutes();
    renderPanel();
    expect((await screen.findByRole('button', { name: 'Tree' })).getAttribute('aria-pressed')).toBe('true');
  });

  it('still toggles when localStorage throws', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      stubRoutes();
      renderPanel();
      expect((await screen.findByRole('button', { name: 'Tree' })).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(screen.getByRole('button', { name: 'Context Rot' }));
      expect(screen.getByRole('button', { name: 'Context Rot' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByText('390k / 1M · 39%')).toBeTruthy();
      expect(set).toHaveBeenCalled();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('shows Unknown for a session with no context', async () => {
    stubRoutes(null);
    renderPanel();
    await screen.findByText('Orchestrated the wall editing phases.');
    fireEvent.click(screen.getByRole('button', { name: 'Context Rot' }));
    const region = screen.getByRole('region', { name: 'Context Rot' });
    expect(within(region).getByText('Unknown')).toBeTruthy();
    expect(within(region).queryByRole('meter', { name: 'Current context' })).toBeNull();
  });
});
```
**Impact:** the existing "toggles the subtree between Tree and Timeline" test keeps passing unchanged (default Tree, localStorage cleared after every test).

### Step 6: Tests — ContextRot
**File:** `web/src/components/graph/ContextRot.test.tsx` (new)
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { HandoffEstimate, SessionContext } from '../../sessionDetailApi';
import { ContextBars, ContextRot } from './ContextRot';

const ctx = (over: Partial<SessionContext> = {}): SessionContext => ({
  tokens: 390_000,
  window: 1_000_000,
  percent: 39,
  band: 'green',
  model: 'claude-opus-5-5',
  at: '2026-11-12T02:00:00.000Z',
  window_source: 'model',
  peak_tokens: 390_000,
  ...over,
});

const EST: HandoffEstimate = {
  node_id: 'A0-3G',
  tokens: 120_000,
  window: 1_000_000,
  percent: 12,
  baseline: 48_000,
  exchanges_included: 40,
  exchanges_total: 40,
  truncated: false,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const meter = () => screen.getByRole('meter', { name: 'Current context' });
const fill = () => meter().querySelector('.cr-fill') as HTMLElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ContextBars', () => {
  it.each([
    [390_000, 39, 'green', '390k / 1M · 39%'],
    [400_000, 40, 'amber', '400k / 1M · 40%'],
    [690_000, 69, 'amber', '690k / 1M · 69%'],
    [700_000, 70, 'red', '700k / 1M · 70%'],
  ] as const)('%i tokens at %i%% is %s', (tokens, percent, band, text) => {
    render(<ContextBars context={ctx({ tokens, percent, band })} estimate={null} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(meter().getAttribute('data-band')).toBe(band);
    expect(meter().getAttribute('aria-valuenow')).toBe(String(percent));
    expect(fill().className).toBe(`cr-fill cr-${band}`);
    expect(fill().style.width).toBe(`${percent}%`);
  });

  it('rounds the label down, so 39.9 % in green never reads 40 %', () => {
    render(<ContextBars context={ctx({ tokens: 399_000, percent: 39.9, band: 'green' })} estimate={null} />);
    expect(screen.getByText('399k / 1M · 39%')).toBeTruthy();
  });

  it('clamps the fill to the track', () => {
    render(<ContextBars context={ctx({ tokens: 260_000, window: 200_000, percent: 130, band: 'red' })} estimate={null} />);
    expect(screen.getByText('260k / 200k · 130%')).toBeTruthy();
    expect(fill().style.width).toBe('100%');
    expect(meter().getAttribute('aria-valuenow')).toBe('100');
  });

  it('shows Unknown, not 0 %, when there is no context', () => {
    const { container } = render(<ContextBars context={null} estimate={null} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.queryByRole('meter', { name: 'Current context' })).toBeNull();
    expect(container.querySelector('.cr-fill')).toBeNull();
    expect(container.textContent).not.toContain('%');
  });

  it('names the model and says when the window is assumed', () => {
    render(<ContextBars context={ctx({ tokens: 6_335, window: 200_000, percent: 3.1675, model: 'glm-5.3', window_source: 'default' })} estimate={null} />);
    expect(screen.getByText('6.3k / 200k · 3%')).toBeTruthy();
    expect(screen.getByText('glm-5.3')).toBeTruthy();
    expect(screen.getByText('window assumed')).toBeTruthy();
  });

  it('says nothing about the window when it came from the model table', () => {
    render(<ContextBars context={ctx()} estimate={null} />);
    expect(screen.getByText('claude-opus-5-5')).toBeTruthy();
    expect(screen.queryByText('window assumed')).toBeNull();
  });

  it('shows where a fresh session would start and how many exchanges it carries', () => {
    render(<ContextBars context={ctx()} estimate={EST} />);
    expect(screen.getByRole('meter', { name: 'Fresh session estimate' }).getAttribute('aria-valuenow')).toBe('12');
    expect(screen.getByText('Fresh session would start at ~12%')).toBeTruthy();
    expect(screen.getByText('carries 40 of 40 exchanges')).toBeTruthy();
    expect(screen.queryByText('older ones left out')).toBeNull();
  });

  it('says when the estimate leaves older exchanges out', () => {
    render(<ContextBars context={ctx()} estimate={{ ...EST, percent: 49.6, exchanges_included: 31, exchanges_total: 212, truncated: true }} />);
    expect(screen.getByText('Fresh session would start at ~50%')).toBeTruthy();
    expect(screen.getByText('carries 31 of 212 exchanges')).toBeTruthy();
    expect(screen.getByText('older ones left out')).toBeTruthy();
  });

  it('shows the estimate under an unknown context too', () => {
    render(<ContextBars context={null} estimate={EST} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('carries 40 of 40 exchanges')).toBeTruthy();
  });

  it('has no second bar without an estimate', () => {
    render(<ContextBars context={ctx()} estimate={null} />);
    expect(screen.queryByText(/Fresh session/)).toBeNull();
    expect(screen.queryByRole('meter', { name: 'Fresh session estimate' })).toBeNull();
  });
});

describe('ContextRot', () => {
  it('loads the estimate from the handoff route', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json(200, EST);
      }),
    );
    render(<ContextRot nodeId="A0-3G" live={false} available={true} initial={ctx()} />);
    expect(await screen.findByText('carries 40 of 40 exchanges')).toBeTruthy();
    expect(calls).toEqual(['/api/sessions/A0-3G/handoff']);
  });

  it('hides the estimate quietly when the handoff route fails', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json(500, { error: 'boom' });
      }),
    );
    render(<ContextRot nodeId="A0-3G" live={false} available={true} initial={ctx()} />);
    await waitFor(() => expect(calls).toEqual(['/api/sessions/A0-3G/handoff']));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('390k / 1M · 39%')).toBeTruthy();
    expect(screen.queryByText(/Fresh session/)).toBeNull();
    expect(screen.queryByText(/boom/)).toBeNull();
  });
});
```

### Step 7: Tests — the feed hook
**File:** `web/src/hooks/useSessionContext.test.tsx` (new; `.test.tsx` because `vitest.config.ts` only collects `web/src/**/*.test.tsx`)
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { SessionContext } from '../sessionDetailApi';
import { CONTEXT_POLL_MS, contextFeed, newerContext, useHandoffEstimate, useSessionContext } from './useSessionContext';

class FakeES {
  static all: FakeES[] = [];
  closed = false;
  private l = new Map<string, Array<(e: { data: string }) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emitRaw(type: string, data: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data });
  }
  emit(type: string, payload: unknown) {
    this.emitRaw(type, JSON.stringify(payload));
  }
}

const T0 = '2026-11-12T02:00:00.000Z';
const T1 = '2026-11-12T02:01:00.000Z';
const T2 = '2026-11-12T03:01:00.000Z';

const ctx = (tokens: number, at: string): SessionContext => ({
  tokens,
  window: 1_000_000,
  percent: tokens / 10_000,
  band: tokens >= 700_000 ? 'red' : tokens >= 400_000 ? 'amber' : 'green',
  model: 'claude-opus-5-5',
  at,
  window_source: 'model',
  peak_tokens: tokens,
});

const wire = (c: SessionContext | null, host = 'lenovo') => ({ node_id: 'A0-3G', host, available: host === 'lenovo', context: c });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const EST = { node_id: 'A0-3G', tokens: 120_000, window: 1_000_000, percent: 12, baseline: 48_000, exchanges_included: 40, exchanges_total: 40, truncated: false };

let calls: string[];
let contextReply: unknown;
let handoffReply: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  contextReply = wire(ctx(450_000, T1), 'GPD');
  handoffReply = { status: 200, body: EST };
  FakeES.all = [];
  vi.stubGlobal('EventSource', FakeES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/handoff')) return json(handoffReply.status, handoffReply.body);
      return json(200, contextReply);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('contextFeed', () => {
  it('streams a live session of this host, polls another host, follows the detail otherwise', () => {
    expect(contextFeed(true, true)).toBe('stream');
    expect(contextFeed(false, true)).toBe('detail');
    expect(contextFeed(true, false)).toBe('poll');
    expect(contextFeed(false, false)).toBe('poll');
  });
});

describe('newerContext', () => {
  it('keeps the later reading and never goes back to null', () => {
    expect(newerContext(ctx(1, T1), ctx(2, T0))?.tokens).toBe(1);
    expect(newerContext(ctx(1, T0), ctx(2, T1))?.tokens).toBe(2);
    expect(newerContext(ctx(1, T0), null)?.tokens).toBe(1);
    expect(newerContext(null, ctx(2, T0))?.tokens).toBe(2);
  });
});

describe('useSessionContext', () => {
  it('opens one stream for a live session of this host and takes its context events', () => {
    const { result } = renderHook(() => useSessionContext({ nodeId: 'a0-3g', live: true, available: true, initial: ctx(100_000, T0) }));
    expect(FakeES.all.map((e) => e.url)).toEqual(['/api/sessions/A0-3G/context/stream']);
    expect(result.current?.tokens).toBe(100_000);
    act(() => FakeES.all[0].emit('context', wire(ctx(420_000, T1))));
    expect(result.current).toMatchObject({ tokens: 420_000, band: 'amber' });
    expect(calls).toEqual([]);
  });

  it('keeps a newer context over an older or malformed event', () => {
    const { result } = renderHook(() => useSessionContext({ nodeId: 'A0-3G', live: true, available: true, initial: ctx(420_000, T1) }));
    act(() => FakeES.all[0].emit('context', wire(ctx(100_000, T0))));
    act(() => FakeES.all[0].emitRaw('context', 'not json'));
    act(() => FakeES.all[0].emit('context', wire(null)));
    expect(result.current?.tokens).toBe(420_000);
  });

  it('closes the stream on node change and on unmount', () => {
    const { rerender, unmount } = renderHook((p: { nodeId: string }) => useSessionContext({ nodeId: p.nodeId, live: true, available: true, initial: null }), {
      initialProps: { nodeId: 'A0-3G' },
    });
    rerender({ nodeId: 'B1-11' });
    expect(FakeES.all.map((e) => [e.url, e.closed])).toEqual([
      ['/api/sessions/A0-3G/context/stream', true],
      ['/api/sessions/B1-11/context/stream', false],
    ]);
    unmount();
    expect(FakeES.all[1].closed).toBe(true);
  });

  it('closes the stream when the session stops being live', () => {
    const { rerender } = renderHook((p: { live: boolean }) => useSessionContext({ nodeId: 'A0-3G', live: p.live, available: true, initial: null }), {
      initialProps: { live: true },
    });
    rerender({ live: false });
    expect(FakeES.all.map((e) => e.closed)).toEqual([true]);
  });

  it('polls GET /context every 60 s for another host and opens no stream', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { result, unmount } = renderHook(() => useSessionContext({ nodeId: 'A0-3G', live: false, available: false, initial: ctx(100_000, T0) }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toEqual(['/api/sessions/A0-3G/context']);
    expect(result.current?.tokens).toBe(450_000);

    contextReply = wire(ctx(720_000, T2), 'GPD');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS - 1);
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(calls).toHaveLength(2);
    expect(result.current).toMatchObject({ tokens: 720_000, band: 'red' });
    expect(FakeES.all).toEqual([]);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONTEXT_POLL_MS * 3);
    });
    expect(calls).toHaveLength(2);
  });

  it('follows the detail for an idle session of this host: no stream, no fetch', () => {
    const { result, rerender } = renderHook<SessionContext | null, { initial: SessionContext | null }>(
      (p) => useSessionContext({ nodeId: 'A0-3G', live: false, available: true, initial: p.initial }),
      { initialProps: { initial: null } },
    );
    expect(result.current).toBeNull();
    rerender({ initial: ctx(300_000, T1) });
    expect(result.current?.tokens).toBe(300_000);
    expect(FakeES.all).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('useHandoffEstimate', () => {
  it('loads the estimate and reloads it when the refresh key changes', async () => {
    const { result, rerender } = renderHook((p: { k: string }) => useHandoffEstimate('A0-3G', p.k), { initialProps: { k: 'a' } });
    await waitFor(() => expect(result.current?.exchanges_total).toBe(40));
    rerender({ k: 'b' });
    await waitFor(() => expect(calls.filter((u) => u === '/api/sessions/A0-3G/handoff')).toHaveLength(2));
  });

  it('is null when the route fails', async () => {
    handoffReply = { status: 500, body: { error: 'boom' } };
    const { result } = renderHook(() => useHandoffEstimate('A0-3G', 'a'));
    await waitFor(() => expect(calls).toEqual(['/api/sessions/A0-3G/handoff']));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toBeNull();
  });
});
```

### Step 8: Tests — wire normalizers
**File:** `web/src/sessionDetailApi.test.tsx` — append at the end of the file. Add `normalizeSessionContext`, `normalizeHandoffEstimate`, `parseContextEvent` to the existing import from `./sessionDetailApi` at the top of the file.
```tsx
describe('context wire', () => {
  const CTX = { tokens: 390_000, window: 1_000_000, percent: 39, band: 'green', model: 'claude-opus-5-5', at: '2026-11-12T02:00:00.000Z', window_source: 'peak', peak_tokens: 410_000 };

  it('carries the detail context and null without one', () => {
    expect(normalizeSessionDetail({ session: { node_id: 'A0-3G', context: CTX } }).context).toEqual(CTX);
    expect(normalizeSessionDetail({ session: { node_id: 'A0-3G', context: null } }).context).toBeNull();
    expect(normalizeSessionDetail({ node_id: 'A0-3G' }).context).toBeNull();
  });

  it('drops a context it cannot draw', () => {
    expect(normalizeSessionContext({ ...CTX, band: 'purple' })).toBeNull();
    expect(normalizeSessionContext({ ...CTX, window: 0 })).toBeNull();
    expect(normalizeSessionContext({ ...CTX, tokens: 'x' })).toBeNull();
    expect(normalizeSessionContext({ ...CTX, window_source: 'guess' })?.window_source).toBe('default');
  });

  it('parses a stream event and rejects anything else', () => {
    expect(parseContextEvent(JSON.stringify({ node_id: 'A0-3G', host: 'lenovo', available: true, context: CTX }))).toEqual({
      node_id: 'A0-3G',
      host: 'lenovo',
      available: true,
      context: CTX,
    });
    expect(parseContextEvent('not json')).toBeNull();
    expect(parseContextEvent(JSON.stringify({ context: CTX }))).toBeNull();
    expect(parseContextEvent(undefined)).toBeNull();
  });

  it('reads a handoff estimate and rejects an incomplete one', () => {
    const est = { node_id: 'A0-3G', tokens: 120_000, window: 1_000_000, percent: 12, baseline: 48_000, exchanges_included: 3, exchanges_total: 9, truncated: true };
    expect(normalizeHandoffEstimate(est)).toEqual(est);
    expect(normalizeHandoffEstimate({ ...est, exchanges_total: undefined })).toBeNull();
  });
});
```

### Step 9: README
**File:** `README.md:633` — after the paragraph that ends "`…which phases overlapped and which one ran long.`" (L629-633) and before the Timeline screenshot line, insert a blank line and:
```markdown
**Context Rot**, the gauge left of **Tree**, shows how full the session's context is. The bar is
filled to the latest context (what the next turn starts from: input, cache read, cache write and
output tokens of the latest main-chain reply, subagents left out; not the cumulative tokens above)
over the session's context window, which is inferred from the model, from a context that ever
passed 200k, or from a 1M beta in the transcript. It is green below 40 %, amber to 70 % and red
beyond, and reads `<tokens> / <window> · <percent>`, with the model and "window assumed" when the
model is unknown and nothing showed a 1M window (200k is used then). A session with no reply yet
reads "Unknown". On a session running on this machine the bar moves with each reply, over
`GET /api/sessions/:nodeId/context/stream`; a session of the other laptop refreshes every 60
seconds. A second bar estimates where "Spawn fresh with this context" would start and how many
prompt→reply exchanges it would carry, which is the choice between resuming and starting fresh.
The panel remembers the last view you picked.
```

**File:** `README.md:727-728` — replace the sentence
```markdown
The button beside it ("Spawn fresh with this context") starts a new session
instead, with the old one's summary as its context.
```
with
```markdown
The button beside it ("Spawn fresh with this context") starts a new session
instead and hands it the old one's work. The daemon writes a handoff file under
`<NOTES_DATA_DIR>/handoffs/<NODE>-<yyyymmddThhmmss>.md` and starts
`claude --append-system-prompt-file <handoff>` with a short first prompt whose first line is
`[notesd handoff]` and which names the node and the file (the prompt hook adds no node-id block for
that prompt). The
handoff holds the node id, title, directory and repo, the transcript path, the stored summary and
how old it is, plan docs, commits, the directory's `git status` and `git diff --stat` (or a line
saying git failed), and the stored prompt→reply exchanges: every one of them when they fit, which
on a 1M-token window is nearly always, otherwise the first prompt and the newest exchanges that
fit, with a line saying how many were left out and where the transcript is. The budget is
0.5 × the old session's inferred window minus a fresh session's usual start: the median
first-reply context of the repo's latest 20 sessions on either machine (forks left out, since a
fork's first reply already holds its parent's history), or 48,000 tokens when there is none. Tokens
are estimated as characters / 4. Handoff files older than 14 days are deleted when the next one is
written. The Context Rot view shows the estimate before you click.
```
Keep the rest of that paragraph ("If the session is still running, …") as it is.

**File:** `README.md:1083` — in the MCP `session_resume` row, right after the sentence that ends "or switch to it when it is still running." insert:
```markdown
`fresh: true` starts a new session instead, carrying the node's handoff (summary and its age, plan docs, commits, git state and the stored prompt→reply exchanges that fit half its context window) through `--append-system-prompt-file`.
```
(Phase 3 Step 7's tool text is the source; this row says the same thing shorter.)

**File:** `README.md:1173` — in the `POST /api/sessions/:nodeId/resume` row, right after the sentence that ends "or switch to it when it is live." insert:
```markdown
`fresh: true` writes a handoff file under `<NOTES_DATA_DIR>/handoffs/` and starts `claude --append-system-prompt-file <handoff>` with a short `[notesd handoff]` first prompt (see "Resume from the wall"); `GET /api/sessions/:nodeId/handoff` is its dry run.
```

**File:** `README.md:1164` — in the `GET /api/projects/:repo/sessions` row, replace `(the wall polls it; there is no SSE event for sessions)` with `(the wall polls it; only a session's context has a stream, below)`.

**File:** `README.md:1167` — after the `GET /api/sessions/:nodeId/prompts` row, insert:
```markdown
| `GET /api/sessions/:nodeId/context` | A session's current context: `{ node_id, host, available, context }`, where `context` is `{ tokens, window, percent, band, model, at, window_source, peak_tokens }`, or `null` when no main-chain reply with token usage was seen. `tokens` is input + cache read + cache write + output of the latest main-chain reply (sidechains and subagents left out); `window` is inferred from the model, the peak and a 1M beta, `window_source: "default"` when assumed (200k); `band` is `green` below 40 %, `amber` below 70 %, `red` from 70 %. Read from the database, so it works for either machine's sessions. 400 `invalid_node_id`, 404 `not_found` |
| `GET /api/sessions/:nodeId/context/stream` | SSE: a `context` event carrying the same JSON on connect and again whenever ingest stores a new main-chain reply that changes it, plus heartbeats. Only this machine's ingest feeds it, so the wall polls the JSON route every 60 s for the other machine's sessions |
| `GET /api/sessions/:nodeId/handoff` | Dry run of "Spawn fresh with this context": `{ node_id, tokens, window, percent, baseline, exchanges_included, exchanges_total, truncated }`, the estimated starting context of the new session and how many prompt→reply exchanges it would carry. Writes no file and runs no git; works for either machine's sessions |
```

### Step 10: Feature map
**File:** `.claude/skills/verify-notesd/features/projects.md:121` — after the "Background jobs (R3.5)" bullet (ends at L121), add:
```markdown
- Context Rot (session-context-rot): the node panel's Subtree toggle has an icon-only `Context Rot`
  button (Gauge) left of `Tree`; the view is kept in `localStorage` (`mcp-notes:projects:panel-view`,
  default Tree) and the section (`region` named after its heading) reads `Context Rot`. Bar 1
  (`role="meter"`, name `Current context`, `data-band` green|amber|red, `aria-valuenow` = percent
  clamped to 0..100) is the latest main-chain reply's context over the inferred window; text
  `<tokens> / <window> · <pct>%` (e.g. `390k / 1M · 39%`, percent rounded down), the model, and
  `window assumed` when `window_source` is `default`. No reply with usage: `Unknown`, no meter.
  A live session of this host updates over `GET /api/sessions/:nodeId/context/stream` (events
  `context`, data `{node_id, host, available, context}`) within seconds; another host's session
  polls `GET /api/sessions/:nodeId/context` every 60 s and opens no stream; an idle local one follows
  the session detail. Bar 2 (`role="meter"`, name `Fresh session estimate`, neutral fill):
  `Fresh session would start at ~X%` and `carries N of M exchanges` (+ `older ones left out` when
  truncated) from `GET /api/sessions/:nodeId/handoff` (dry run); hidden when that route fails.
- Spawn fresh handoff (session-context-rot phase 3): `POST /api/sessions/:nodeId/resume
  {"fresh":true}` writes `<dataDir>/handoffs/<NODE>-<yyyymmddThhmmss>.md` (node id, title, cwd,
  repo, transcript path, summary + age, plan docs, commits, `git status --porcelain=v1 -b`,
  `git diff --stat` or "Git state unavailable for <cwd>: <reason>", then every stored prompt with
  Claude's reply when they fit `0.5 × window − baseline` (baseline = median `context_first_tokens`
  of the repo's latest 20 non-fork sessions, else 48,000; tokens ≈ chars / 4), otherwise prompt 1 plus
  the newest exchanges that fit and "N exchanges were left out"), prunes handoffs older than 14 days,
  and starts claude with `--append-system-prompt-file <file>` and a first prompt whose first line is
  `[notesd handoff]` (the notes-prompt hook adds no node-id block for it).
  `GET /api/sessions/:nodeId/handoff` is the dry run: `{node_id, tokens, window, percent, baseline,
  exchanges_included, exchanges_total, truncated}`, any host, no file, no git.
```

**File:** `.claude/skills/verify-notesd/features/projects.md:6` — in the first sub-feature bullet, replace
`resume (real tmux NOT driven here; background-job attach driven with a fake tmux, below)` with
`resume (real tmux NOT driven here; background-job attach and the fresh-spawn handoff driven with a fake tmux behind a safety gate, below)`.

**File:** `.claude/skills/verify-notesd/features/projects.md:124-126` — replace the user-POV paragraph with:
```markdown
Wall sidebar `Projects` → `/projects`, click a node → the node panel (`aside.np`), section
"Notes made"; the gauge button left of Tree opens the Context Rot view. Claude Code: MCP
`sessions_search`, `session_get`, `session_transcript`, `sessions_usage`; `/n link 5-BW7 into 5U-I7`
(MCP `link_note` / `unlink_note`).
```

**File:** `.claude/skills/verify-notesd/features/projects.md:365` — insert before `## Gotchas`:
````markdown
## Context Rot (fake transcript appends)
Fixture `…0001` (model `claude-opus-5-5`, a 1M window) ends at 32,021 tokens of context. Append
main-chain assistant records with known usage to the run's own transcript copy; never the real
`~/.claude`. Nothing is billed (`NOTESD_CLAUDE_BIN` points nowhere, no `--embed`):
```sh
NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --web     # note RUN and URL
CH="$HOME/.local/state/notesd-verify/$RUN/claude"; SID=5e55a001-0000-4000-8000-000000000001
T="$CH/projects/-home-u-mcp-notes/$SID.jsonl"
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r --arg s $SID '.nodes[]|select(.session_id==$s)|.node_id' <<<"$S")
asst() { printf '{"parentUuid":"as-5","isSidechain":false,"message":{"model":"claude-opus-5-5","id":"%s","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":%d,"output_tokens":100}},"type":"assistant","uuid":"%s-u","timestamp":"%s","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"%s","version":"2.1.311","gitBranch":"main"}\n' "$2" $(( $1 - 101 )) "$2" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$SID" >>"$T"; }
$V api RUN GET /api/sessions/$NODE/context        # context.tokens 32021, window 1000000, band green
asst 390000 msg_cr_1                              # usage sums to exactly 390,000
$V api RUN GET /api/sessions/$NODE/context        # within a few seconds: tokens 390000, percent 39, band green
curl -sN --max-time 8 "$URL/api/sessions/$NODE/context/stream" & sleep 2; asst 400000 msg_cr_2; wait   # initial event, then one with 400000 / amber
$V api RUN GET /api/sessions/$NODE/handoff         # {tokens, window, percent, exchanges_included, exchanges_total, truncated}; no file under the run's data dir/handoffs
```
UI: `page.goto(base + '/projects?repo=mcp-notes&node=' + NODE)`; panel `aside.np[data-node="<NODE>"]`;
button `getByRole('button', { name: 'Context Rot' })`; section `getByRole('region', { name: 'Context Rot' })`;
bars `getByRole('meter', { name: 'Current context' })` (`data-band`) and `getByRole('meter', { name: 'Fresh session estimate' })`;
text by exact string (`'390k / 1M · 39%'`, `'carries N of M exchanges'`, `'Unknown'`).
Live: make the session live with a registry file for a running `sleep`
(`{"pid":<pid>,"sessionId":"<SID>","cwd":"/home/u/mcp-notes","kind":"interactive","status":"busy"}` in
`$CH/sessions/<pid>.json`), open the view, append from the steps file (`node:fs` `appendFileSync`),
and wait at most 5 s for the new text with no reload. Other host: `$V exec RUN "update cc_sessions set host='GPD' where session_id='$SID'"`;
the page polls `GET /context` every 60 s and opens no stream; `page.clock.install()` before `goto` and
`page.clock.fastForward(60_000)` skip the wait. Unknown: a transcript holding only a user record
(entrypoint `cli`) ingests as a node whose context is `null`. The full steps files are in
`.workflows/plan/session-context-rot/phase-4.md` (Proof). The bands' thresholds themselves are
unit-tested server-side (Phase 1 `contextWindow` tests) and in `web/src/components/graph/ContextRot.test.tsx`.

## Spawn fresh handoff (fake tmux, safety-gated)
The one place a verify run drives `POST /resume` with `fresh: true`. Never against real tmux or a
real claude: the daemon must run with `NOTESD_TMUX_BIN` = a logging fake and
`NOTESD_CLAUDE_BIN=/bin/true` (`up` passes the caller's env through).
```sh
S=$(mktemp -d)
cat >"$S/fake-tmux" <<EOF
#!/usr/bin/env bash
{ echo "--- call"; printf '%s\n' "\$@"; } >> "$S/tmux.log"
case "\$1" in list-sessions) echo "100 verify" ;; new-window) echo "verify:1 %99" ;; esac
exit 0
EOF
chmod +x "$S/fake-tmux"
eval "$(NOTESD_TMUX_BIN="$S/fake-tmux" NOTESD_CLAUDE_BIN=/bin/true $V up | grep -E '^(RUN|URL|EVIDENCE)=')"
D="$HOME/.local/state/notesd-verify/$RUN"
# SAFETY GATE: both lines must print. If either prints nothing: $V down "$RUN" and stop; do not POST resume.
tr '\0' '\n' < /proc/$(cat "$D/pid")/environ | grep -x "NOTESD_TMUX_BIN=$S/fake-tmux"
tr '\0' '\n' < /proc/$(cat "$D/pid")/environ | grep -x "NOTESD_CLAUDE_BIN=/bin/true"
```
Seed nodes with `$V exec` (`cc_sessions` rows on this host with `context_model`,
`context_peak_tokens`, `context_first_tokens`, plus `cc_session_prompts` / `cc_session_replies`
rows), then `$V api RUN GET /api/sessions/<NODE>/handoff` (no `handoffs/` dir appears) and
`$V api RUN POST /api/sessions/<NODE>/resume '{"fresh":true}'` → `$D/data/handoffs/<NODE>-*.md`
exists and `$S/tmux.log` shows `--append-system-prompt-file <that file>` followed by a prompt whose
first line is `[notesd handoff]`. The hook check pipes a marker prompt into
`node claude/hooks/notes-prompt.mjs` with `NOTESD_PORT` set and expects no output. The full seed SQL
and journeys (1M node carries all 30 exchanges, 200k node truncates, `/tmp` cwd shows "Git state
unavailable", the hook skip) are in `.workflows/plan/session-context-rot/phase-3.md` (Proof).
Cleanup: `$V down "$RUN"; rm -rf "$S"`.
````

**File:** `.claude/skills/verify-notesd/features/projects.md` (`## Gotchas`) — replace
`- Never drive resume: it spawns real Claude sessions.` (the line reads ``- Never drive `resume`: it spawns real Claude sessions.``) with:
```markdown
- Never drive `resume` against real tmux or claude: it spawns real Claude sessions. The only exceptions are the two fake-tmux sections above, and the fresh-spawn one only after its safety gate printed both lines.
```
**Impact:** docs only.

### Step 11: CLAUDE.md
**File:** `CLAUDE.md:41` — in the **Claude Code sessions** bullet, right after the sentence that ends "which re-reads each from byte 0 inside the ingester." insert one sentence:
```markdown
Ingest also stores each session's context evidence (`context_*`, `drizzle/0016`, older rows filled once per host by the context backfill); `src/sessions/contextWindow.ts` infers window, percent and band from it at read time for the wall's Context Rot view (`/api/sessions/:nodeId/context` and `/stream`), and "Spawn fresh" passes a handoff file (`src/sessions/handoff.ts`, `<dataDir>/handoffs/`) with `--append-system-prompt-file`.
```
**Impact:** docs only. This is the CLAUDE.md addition the set had left unassigned (reconciler).

## Principles applied

- Boundary discipline: every wire shape (detail `context`, the JSON route, each SSE event's `data`, the handoff estimate) is validated once in `sessionDetailApi.ts` (`normalizeSessionContext`, `parseContextEvent`, `normalizeHandoffEstimate`); the hook and components take typed values and never re-check fields.
- Make illegal states unrepresentable: a context with an unknown `band` or a non-positive window normalizes to `null` (Unknown) rather than a `SessionContext` with optional fields; `SubtreeView` stays a closed union and a stored value outside it reads as Tree.
- Laziness protocol: the idle-local case adds no `GET /context` fetch. The panel already re-fetches the detail on the graph stamp and the detail carries the same `context`, so the hook follows `detail.context` instead of duplicating that fetch. The scope's "one fetch plus a refetch on the stamp" is met by the detail fetch the panel already does. Colours come from the server's `band` and the estimate bar has a neutral fill, so the thresholds live only in Phase 1's `contextBand`, not again in the client. "Leaving the view" is an unmount (`ContextRot` renders only in the context view, keyed by node), so the hook needs no `open` flag.
- Prove it works: Proof drives the throwaway daemon with real transcript appends (Playwright reads the bar, the stream and a 60 s poll under `page.clock`), not only jsdom.
- Test behavior, not implementation: the tests check what a user or caller sees (button order, `aria-pressed`, bar text, `data-band`, requests sent, stream closed). They do not inspect hook internals.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-context-rot && npm run typecheck && npm run build`
**Tests:** `npm test` (focused: `npx vitest run web/src/components/graph/NodePanel.test.tsx web/src/components/graph/ContextRot.test.tsx web/src/hooks/useSessionContext.test.tsx web/src/sessionDetailApi.test.tsx`)
**Proof:** the throwaway daemon, built from this tree with Phases 1–3 in it, shows the bar, colours it by band, updates it live from a transcript append, polls for another host, says Unknown, and shows the estimate.
- Harness: `.claude/skills/verify-notesd`
- Feature-map entries: `features/projects.md` (Context Rot sub-feature and the "Context Rot (fake transcript appends)" section)

Setup (run once, in order; `RUN`, `URL` come from `up`):
```sh
cd /home/miftah/.worktrees/mcp-notes/session-context-rot
export ROOT=$PWD V=$PWD/.claude/skills/verify-notesd/scripts/verify.sh
OUT=$(NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --web); echo "$OUT"
eval "$(grep -E '^(RUN|URL|EVIDENCE)=' <<<"$OUT")"; export RUN URL
$V doctor $RUN
export SID=5e55a001-0000-4000-8000-000000000001
export CH="$HOME/.local/state/notesd-verify/$RUN/claude"
export TRANSCRIPT="$CH/projects/-home-u-mcp-notes/$SID.jsonl"
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
export NODE=$(jq -r --arg s $SID '.nodes[]|select(.session_id==$s)|.node_id' <<<"$S"); echo "NODE=$NODE"
for i in $(seq 30); do curl -sf "$URL/api/sessions/$NODE/context" | jq -e '.context.tokens' && break; sleep 1; done   # 32021
export STEPS=$(mktemp -d)
```
Write these files into `$STEPS` (outside the repo):

`$STEPS/cr-lib.mjs`
```js
import { appendFileSync } from 'node:fs'

export const env = process.env

/** One main-chain assistant record of fixture …0001 whose usage sums to exactly `tokens`. */
export function appendAssistant(tokens, id) {
  const rec = {
    parentUuid: 'as-5',
    isSidechain: false,
    message: {
      model: 'claude-opus-5-5',
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: tokens - 101, output_tokens: 100 },
    },
    type: 'assistant',
    uuid: `${id}-u`,
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/home/u/mcp-notes',
    sessionId: env.SID,
    version: '2.1.311',
    gitBranch: 'main',
  }
  appendFileSync(env.TRANSCRIPT, JSON.stringify(rec) + '\n')
}

/** Wait until GET /context reports `tokens` (ingest is a background tail). */
export async function storedContext(page, base, node, tokens) {
  for (let i = 0; i < 40; i++) {
    const j = await (await page.request.get(`${base}/api/sessions/${node}/context`)).json()
    if (j.context && j.context.tokens === tokens) return j.context
    await page.waitForTimeout(500)
  }
  throw new Error(`context of ${node} never reached ${tokens}`)
}

/** Open the node's panel on the Context Rot view; returns the section. */
export async function openContextRot(page, base, node) {
  await page.goto(`${base}/projects?repo=mcp-notes&node=${node}`)
  const panel = page.locator(`aside.np[data-node="${node}"]`)
  const btn = panel.getByRole('button', { name: 'Context Rot' })
  await btn.waitFor()
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click()
  return { panel, region: panel.getByRole('region', { name: 'Context Rot' }) }
}

export function must(cond, msg) {
  if (!cond) throw new Error(msg)
}
```

`$STEPS/j1-bands.mjs`
```js
import { appendAssistant, env, must, openContextRot, storedContext } from './cr-lib.mjs'

const CASES = [
  [390000, '390k / 1M · 39%', 'green', '39'],
  [400000, '400k / 1M · 40%', 'amber', '40'],
  [690000, '690k / 1M · 69%', 'amber', '69'],
  [700000, '700k / 1M · 70%', 'red', '70'],
]

export default async ({ page, base, shot, log }) => {
  const node = env.NODE
  await page.goto(`${base}/projects?repo=mcp-notes&node=${node}`)
  const panel = page.locator(`aside.np[data-node="${node}"]`)
  await panel.getByRole('button', { name: 'Tree' }).waitFor()
  const order = await panel.locator('.np-toggle button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label')))
  must(order.join(',') === 'Context Rot,Tree,Timeline', `toggle order is ${order.join(',')}`)
  log('toggle reads Context Rot, Tree, Timeline (left to right)')
  const { region } = await openContextRot(page, base, node)
  await region.getByText('32k / 1M · 3%', { exact: true }).waitFor({ timeout: 5000 })
  await shot('context-initial')
  for (const [tokens, text, band, now] of CASES) {
    appendAssistant(tokens, `msg_cr_${tokens}`)
    await storedContext(page, base, node, tokens)
    await page.reload()
    const pressed = await panel.getByRole('button', { name: 'Context Rot' }).getAttribute('aria-pressed')
    must(pressed === 'true', 'the view was not remembered across the reload')
    await region.getByText(text, { exact: true }).waitFor({ timeout: 5000 })
    const meter = region.getByRole('meter', { name: 'Current context' })
    must((await meter.getAttribute('data-band')) === band, `band at ${tokens} is ${await meter.getAttribute('data-band')}, want ${band}`)
    must((await meter.getAttribute('aria-valuenow')) === now, `aria-valuenow at ${tokens} is ${await meter.getAttribute('aria-valuenow')}`)
    await shot(`context-${tokens}`)
    log(`${text} shown in ${band}`)
  }
}
```

`$STEPS/j2-estimate.mjs`
```js
import { env, must, openContextRot } from './cr-lib.mjs'

export default async ({ page, base, shot, log }) => {
  const node = env.NODE
  const e = await (await page.request.get(`${base}/api/sessions/${node}/handoff`)).json()
  must(typeof e.exchanges_total === 'number' && typeof e.percent === 'number', `bad estimate ${JSON.stringify(e)}`)
  const { region } = await openContextRot(page, base, node)
  await region.getByRole('meter', { name: 'Fresh session estimate' }).waitFor({ timeout: 5000 })
  const pct = Math.round(Math.min(100, Math.max(0, e.percent)))
  await region.getByText(`Fresh session would start at ~${pct}%`, { exact: true }).waitFor()
  await region.getByText(`carries ${e.exchanges_included} of ${e.exchanges_total} exchanges`, { exact: true }).waitFor()
  await shot('estimate')
  log(`estimate bar: ~${pct}%, carries ${e.exchanges_included} of ${e.exchanges_total} exchanges (route said the same)`)
}
```

`$STEPS/j3-live.mjs`
```js
import { appendAssistant, env, must, openContextRot } from './cr-lib.mjs'

export default async ({ page, base, shot, log }) => {
  const node = env.NODE
  const urls = []
  page.on('request', (r) => urls.push(new URL(r.url()).pathname))
  const { region } = await openContextRot(page, base, node)
  await region.getByText('700k / 1M · 70%', { exact: true }).waitFor({ timeout: 5000 })
  const streamPath = `/api/sessions/${node}/context/stream`
  for (let i = 0; i < 20 && !urls.includes(streamPath); i++) await page.waitForTimeout(250)
  must(urls.includes(streamPath), 'no context stream was opened for a live session')
  await page.waitForTimeout(1000)
  await page.evaluate(() => {
    window.__crMark = 'same-page'
  })
  const t0 = Date.now()
  appendAssistant(820000, 'msg_cr_live')
  await region.getByText('820k / 1M · 82%', { exact: true }).waitFor({ timeout: 5000 })
  const ms = Date.now() - t0
  must((await page.evaluate(() => window.__crMark)) === 'same-page', 'the page reloaded')
  must((await region.getByRole('meter', { name: 'Current context' }).getAttribute('data-band')) === 'red', 'band is not red')
  await shot('live-update')
  log(`bar went 700k -> 820k (red) ${ms} ms after the append, same page, over ${streamPath}`)
}
```

`$STEPS/j4-other-host.mjs`
```js
import { execFileSync } from 'node:child_process'
import { env, must, openContextRot } from './cr-lib.mjs'

export default async ({ page, base, shot, log }) => {
  const node = env.NODE
  const contextGets = []
  const streams = []
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname
    if (p === `/api/sessions/${node}/context`) contextGets.push(p)
    if (p === `/api/sessions/${node}/context/stream`) streams.push(p)
  })
  await page.clock.install()
  const { region } = await openContextRot(page, base, node)
  await region.getByText('820k / 1M · 82%', { exact: true }).waitFor({ timeout: 5000 })
  await page.waitForTimeout(500)
  const before = contextGets.length
  execFileSync(env.V, ['exec', env.RUN, `update cc_sessions set context_tokens = 450000, context_at = now() where session_id = '${env.SID}'`], {
    cwd: env.ROOT,
    stdio: 'inherit',
  })
  await page.waitForTimeout(1000)
  must((await region.getByText('820k / 1M · 82%', { exact: true }).count()) === 1, 'the bar changed before the poll was due')
  await page.clock.fastForward(60_000)
  await region.getByText('450k / 1M · 45%', { exact: true }).waitFor({ timeout: 5000 })
  must(contextGets.length > before, `no GET /context after 60 s (before ${before}, after ${contextGets.length})`)
  must(streams.length === 0, `a stream was opened for another host's session (${streams.length})`)
  must((await region.getByRole('meter', { name: 'Current context' }).getAttribute('data-band')) === 'amber', 'band is not amber')
  await shot('other-host-poll')
  log(`other host: ${contextGets.length} GET /context, 0 streams; bar 820k -> 450k after a 60 s poll`)
}
```

`$STEPS/j5-unknown.mjs`
```js
import { env, must, openContextRot } from './cr-lib.mjs'

export default async ({ page, base, shot, log }) => {
  const node = env.UNODE
  const { region } = await openContextRot(page, base, node)
  await region.getByText('Unknown', { exact: true }).waitFor({ timeout: 5000 })
  must((await region.getByRole('meter', { name: 'Current context' }).count()) === 0, 'a context meter is shown for an unknown context')
  const firstRow = await region.locator('.cr-row').first().textContent()
  must(!/%/.test(firstRow ?? ''), `the unknown row shows a percent: ${firstRow}`)
  await shot('unknown')
  log(`unknown context: "${firstRow}", no meter, no percent`)
}
```

`$STEPS/neighbor.mjs`
```js
import { env, must } from './cr-lib.mjs'

export default async ({ page, base, shot, log }) => {
  const node = env.NODE
  await page.goto(`${base}/projects?repo=mcp-notes&node=${node}`)
  const panel = page.locator(`aside.np[data-node="${node}"]`)
  await panel.getByRole('button', { name: 'Tree' }).click()
  await panel.getByRole('region', { name: 'Subtree' }).locator('.np-tree').waitFor()
  await panel.getByRole('button', { name: 'Timeline' }).click()
  await panel.locator('[data-bar]').first().waitFor()
  must((await panel.getByRole('meter').count()) === 0, 'a meter is shown outside the Context Rot view')
  await panel.getByRole('region', { name: 'Tokens' }).waitFor()
  await shot('tree-timeline')
  log('Tree and Timeline still render under the Subtree heading; Tokens section intact')
}
```

- Journeys:
  - **J1** · traces R1.1, R1.6 — `$V ui $RUN $STEPS/j1-bands.mjs` (appends records summing to 390k, 400k, 690k, 700k to fixture …0001's transcript, waits for `GET /context` to report each, reloads) → passes when the toggle's buttons read `Context Rot,Tree,Timeline` left to right, the view opens with `32k / 1M · 3%`, and after each append the `Current context` meter shows exactly `390k / 1M · 39%` green, `400k / 1M · 40%` amber, `690k / 1M · 69%` amber, `700k / 1M · 70%` red (`data-band` and `aria-valuenow` match), with Context Rot still pressed after every reload; evidence `NN-ui-j1-bands.{txt,png,webm}`
  - **J2** · traces R4.8 — `$V api $RUN GET /api/sessions/$NODE/handoff` then `$V ui $RUN $STEPS/j2-estimate.mjs` → passes when the `Fresh session estimate` meter is visible and the view reads exactly `Fresh session would start at ~<round(percent)>%` and `carries <exchanges_included> of <exchanges_total> exchanges` with the numbers the route returned
  - **J3** · traces R3.1 — `sleep 900 & JP=$!; printf '{"pid":%d,"sessionId":"%s","cwd":"/home/u/mcp-notes","kind":"interactive","status":"busy"}\n' $JP $SID > "$CH/sessions/$JP.json"; for i in $(seq 20); do curl -sf "$URL/api/sessions/$NODE" | jq -e '.session.live == true' && break; sleep 1; done; $V ui $RUN $STEPS/j3-live.mjs; kill $JP; rm "$CH/sessions/$JP.json"` → passes when the page opens `GET /api/sessions/$NODE/context/stream`, and after the steps file appends an 820k record the meter reads `820k / 1M · 82%` in red within 5 s of the append with `window.__crMark` still set (no reload); the log line gives the measured ms
  - **J4** · traces R3.4 — `$V exec $RUN "update cc_sessions set host='GPD' where session_id='$SID'"; curl -sf "$URL/api/sessions/$NODE/context" | jq -c '{available, t: .context.tokens}'` (prints `{"available":false,"t":820000}`) then `$V ui $RUN $STEPS/j4-other-host.mjs` → passes when the bar still reads `820k / 1M · 82%` one second after the database row changed to 450k, then after `page.clock.fastForward(60_000)` reads `450k / 1M · 45%` in amber, at least one more `GET /api/sessions/$NODE/context` was sent, and zero requests went to `/context/stream`
  - **J5** · traces R1.7 — `U=5e55a0ff-0000-4000-8000-0000000000ff; printf '{"parentUuid":null,"isSidechain":false,"promptId":"p-z","type":"user","message":{"role":"user","content":"context rot unknown probe"},"uuid":"uz-0","timestamp":"%s","userType":"external","entrypoint":"cli","cwd":"/home/u/mcp-notes","sessionId":"%s","version":"2.1.311","gitBranch":"main"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" $U > "$CH/projects/-home-u-mcp-notes/$U.jsonl"; for i in $(seq 30); do export UNODE=$(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r --arg s $U '.nodes[]|select(.session_id==$s)|.node_id'); [ -n "$UNODE" ] && break; sleep 1; done; curl -sf "$URL/api/sessions/$UNODE/context" | jq -c .context; $V ui $RUN $STEPS/j5-unknown.mjs` → passes when the route prints `null` and the view shows `Unknown` with no `Current context` meter and no `%` in that row
- Neighbor check: `$V ui $RUN $STEPS/neighbor.mjs` (run after J1, before J4) → passes when Tree shows `.np-tree` and Timeline shows `[data-bar]` rows under the `Subtree` heading, no meter is rendered outside Context Rot, and the Tokens section is present. Then `$V down $RUN`.
- Cost: none. `NOTESD_CLAUDE_BIN=/nonexistent/claude` keeps the summarizer off, there is no `--embed`, and resume is never driven.

**Exit criteria:** `npm run typecheck` and `npm test` are green, and J1–J5 and the neighbor check pass on a `--web` throwaway daemon built from the tree with Phases 1–3 merged.

## Handoffs

- **R3.2, R3.3** (Phase 2): the stream's event on an ingested change and the JSON route's shape are Phase 2's criteria. The feature-map section's `curl` lines exercise them, but this plan traces neither. The README rows for both routes are written here (Step 9) because this phase owns README.
- **R4.1–R4.7** (Phase 3): the handoff content, file location, `--append-system-prompt-file` argv, hook skip and dry-run behaviour are Phase 3's. The README "Resume from the wall" paragraph (Step 9) and the feature-map entry (Step 10) quote Phase 3's constants; the reconciler checked them against `phase-3.md` Step 1 (0.5, 48,000, latest 20 non-fork sessions, chars / 4, 14 days, `[notesd handoff]`).
- **R1.6 thresholds** are computed server-side (Phase 1 `contextBand`). This phase renders the server's band and proves it end to end (J1). The exact threshold arithmetic is Phase 1's unit tests.
- Confirmed by the reconciler: `percent` is 0..100 with one decimal (Phase 1 `contextPercent`) in the detail, the JSON route, the stream and the handoff estimate. The estimate route answers for another host's node and for a node with no context (its window then comes from the default rule).
- Wire shapes are field-for-field Phase 2's `SessionContext` / `SessionContextPayload` (`view.ts`) and Phase 3's `HandoffEstimateBody` (`handoff.ts`). The only typing difference is deliberate: the web types `peak_tokens` as `number | null` (the server always sends a number); the normalizer accepts both.
- Not done here (no requirement asks): a light theme. The wall is dark-only (`web/index.html` `color-scheme: dark`, one `:root` palette), so the band tokens have one value each. If a light theme is ever added, the three `--band-*` tokens are where it would hook in.

## Rollback

`git revert` this phase's commit. It touches only `web/`, `README.md` and the feature map, and no server code or data depends on it. The `localStorage` key `mcp-notes:projects:panel-view` left in browsers is harmless: an older panel ignores it.
