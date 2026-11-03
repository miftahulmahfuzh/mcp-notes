> Adopted from `/home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts/docs/plans/NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md` phase 5. Source: `.workflows/plan/node-panel-summarize-prompts/phase-5.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 5: Prompts read API + Expand prompts modal with copy

**Plan set:** `NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md`
**Analysis:** `docs/analyzer/20261103-150033-K7Q2_code_analyzer.md`
**Satisfies:** R2. The node panel's Prompts section gets an "Expand prompts" button. It opens a large modal that lists every stored prompt with per-prompt copy and copy-all.
**Depends on:** Phase 2, 3, 4. Phase 1 lands before all three.
**Difficulty:** NORMAL. It is a read path plus one modal. The hard part of R2 (ingest, redaction, backfill) is Phase 3's.
**Package:** `src/sessions` + `src/http` (read API), `web/src/components/graph` (modal)

---

## Goal

`GET /api/sessions/:nodeId/prompts` returns every stored prompt of a node from the shared DB. A fully backfilled row (`prompts_version >= PROMPTS_VERSION`, i.e. 2) is served from `cc_session_prompts`, numbered in typed order, with text exactly as stored, `complete: true`. A row redacted in place because its transcript was pruned (`PROMPTS_VERSION_EXCERPTS`, 1) is also served from `cc_session_prompts` (the redacted excerpts) but with `complete: false, incomplete_reason: 'transcript_pruned'`. A legacy row (0) falls back to the excerpt list on `cc_sessions` with `complete: false, incomplete_reason: 'not_backfilled'`. The modal says which, in one dim line. In the wall, the Prompts section has an icon-only "Expand prompts" button. It opens a portal modal with each prompt numbered, timed and shown in full (whitespace kept), a "Copy prompt N" button per prompt and "Copy all prompts" at the top right. Esc or a backdrop click closes only the modal. The node panel, the projects page selection and the chat node pop-up all stay open.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `sessionPrompts(rd: SessionsReadDeps, nodeId: string): Promise<PromptsPayload | null>` (`src/sessions/readModel.ts`, right after `sessionDetail`; after Phase 2's `requestSummaryFor` if that sits there)
- `type PromptsIncompleteReason = 'not_backfilled' | 'transcript_pruned'`, `interface NumberedPrompt { n: number; text: string; at: string | null; truncated: boolean }`, `interface PromptsPayload { node_id: string; host: string; available: boolean; complete: boolean; incomplete_reason: PromptsIncompleteReason | null; prompts: NumberedPrompt[] }`, `type StoredPromptRow`, `type PromptsSource`, `function toPromptsPayload(head, thisHost, source)` (`src/sessions/view.ts`, right after `normalizePrompts`)
- Route `GET /api/sessions/:nodeId/prompts`: 200 `PromptsPayload`, 400 `{error:'invalid_node_id'}`, 404 `{error:'not_found', node_id}`. No same-origin guard, because it is a read like `GET /api/sessions/:nodeId`, which already returns prompt excerpts (`src/http/sessionsApi.ts`, registered before `GET /api/sessions/:nodeId`)
- `type PromptsIncompleteReason`, `interface SessionPromptItem`, `interface SessionPrompts` (with `incomplete_reason`), `normalizeSessionPrompts(raw)`, `fetchSessionPrompts(nodeId, signal?): Promise<SessionPrompts | null>` (`web/src/sessionDetailApi.ts`, end of file)
- `PromptsModal`, `isPromptsOpen(doc?)`, `PROMPTS_SELECTOR = '[data-modal="prompts"]'`, `promptsCopyText(prompts)` (`web/src/components/graph/PromptsModal.tsx`, new); CSS prefix `prm-` (`PromptsModal.css`, new). `pm-` is taken by PhotoModal.

**Signature changes:**
- `useCopied(ms?)` returns `{ copied: string | null; copy: (key: string, text?: string) => void }` (was `copy: (id: string) => void`). `copy(key)` behaves exactly as before, copying the key itself. `copy(key, text)` copies `text` and flags `key`. All existing callers pass one argument and stay unchanged.

**Requires (from earlier phases):**
- Phase 1: `cc_sessions.prompts_version integer not null default 0`; table `cc_session_prompts(session_id text references cc_sessions on delete cascade, seq integer, at timestamptz null, text text not null, truncated boolean not null default false, primary key(session_id, seq))`; `tests/integration/setup.ts` truncates `cc_session_prompts`.
- Phase 3: `export const PROMPTS_VERSION_EXCERPTS = 1` and `export const PROMPTS_VERSION = 2` in `src/sessions/types.ts`; ingest writes redacted full prompts to `cc_session_prompts` and sets `prompts_version = PROMPTS_VERSION` on a from-offset-0 write (so the fixture is at 2 right after `up`, before any backfill); `redactStoredPrompts` leaves a pruned-transcript row at `PROMPTS_VERSION_EXCERPTS` with its side rows rebuilt from the redacted excerpts; the fixture session in `tests/fixtures/claude-home/projects/-home-u-mcp-notes/` (repo `mcp-notes`) with at least 105 prompts, one over 2000 chars, one containing a fake `sk-ant-…` key. The key is stored as `[redacted]`.
- Phase 4: `NodePanel.tsx` Summary section already uses `np-sec-head`; `NodePanel.css` has `.np-sec-head > .ibtn { width: 32px; height: 32px; font-size: 17px; }`, which sizes this phase's header button, so this phase adds no NodePanel CSS. NodePanel's phosphor import line and `sessionDetailApi` import list already carry Phase 4's names (`MagicWand`, `requestSummary`, …). `SubtreeNode` has the required `summarized` field, and the `n()` helper in `NodePanel.test.tsx` sets it (this phase builds no `SubtreeNode` literal). `projects.md` has the merged "Summary on demand" bullet and the "Summarize in the wall." block.
- Phase 2: `sessionsApi.ts` already has `POST /api/sessions/:nodeId/summarize` and its doc-comment line; `readModel.ts`/`view.ts` carry the summary-state additions. This phase only adds next to them.

**Leaves alone (owned by others):** `src/sessions/{ingest,transcript,merge,repo,summaryWorker}.ts`, `src/db/*`, `drizzle/*` (Phases 1–3); NodePanel's Summary section, `requestSummary`, `summary_state` (Phase 4); `DETAIL_SELECT`, `SessionInfo` summary fields (Phase 2); `tests/fixtures/**` (Phase 3). The panel keeps its excerpt list and `PROMPTS_SHOWN` as is.

## Files

| File | Action | What changes |
|---|---|---|
| `src/sessions/view.ts` | modify | `NumberedPrompt`, `PromptsPayload`, `StoredPromptRow`, `PromptsSource`, `toPromptsPayload` after `normalizePrompts` (L497-514 today) |
| `src/sessions/readModel.ts` | modify | import `PROMPTS_VERSION` (L50) and the new view names (L17-48); `sessionPrompts` after `sessionDetail` (ends L360 today) |
| `src/http/sessionsApi.ts` | modify | import `sessionPrompts` (L6-20); doc line (L123); route before `GET /api/sessions/:nodeId` (L206 today) |
| `web/src/hooks/useCopied.ts` | modify | `copy(key, text?)` (L21-36) |
| `web/src/sessionDetailApi.ts` | modify | prompt-list types, `normalizeSessionPrompts`, `fetchSessionPrompts` at end of file (after L256 today) |
| `web/src/components/graph/PromptsModal.tsx` | create | the modal |
| `web/src/components/graph/PromptsModal.css` | create | modal styles (`prm-` prefix) |
| `web/src/components/graph/NodePanel.tsx` | modify | import `ArrowsOut` + `PromptsModal` (L3, L11-13); `promptsOpen` state (after L67); reset on node change (L90-93); Prompts section header (L243-257 today); render modal after the confirm portal (L393-408) |
| `web/src/components/graph/NodeModal.tsx` | modify | import `isPromptsOpen` (L3-5); Esc guard (L40) |
| `tests/unit/sessions/promptsPayload.test.ts` | create | `toPromptsPayload` both sources |
| `tests/integration/sessions.api.int.test.ts` | modify | imports (L1-17); new `describe('GET /api/sessions/:nodeId/prompts')` after the transcript describe (ends L272 today) |
| `web/src/sessionDetailApi.test.tsx` | modify | import (L4); `describe('fetchSessionPrompts')` at end |
| `web/src/components/graph/PromptsModal.test.tsx` | create | numbering, whitespace, per-prompt copy, copy-all join, fallback line, Esc, backdrop, load states |
| `web/src/components/graph/NodePanel.test.tsx` | modify | `describe('NodePanel: Expand prompts')` at end |
| `web/src/components/graph/NodeModal.test.tsx` | modify | `describe('NodeModal: the prompts modal over the pop-up')` at end |
| `.claude/skills/verify-notesd/features/projects.md` | modify | R2 sub-feature (after the merged "Summary on demand" bullet), driving block and selectors (after Phase 4's "Summarize in the wall." block), gotchas |

## Implementation Steps

### Step 1: Payload types and pure shaping
**File:** `src/sessions/view.ts`, right after `normalizePrompts` (L497-514 today, before `const SHA_THEN_SUBJECT`)
**Change:** Add the payload types and one pure shaper. `source` is a discriminated union on `kind`, so "complete but shaped from excerpts" cannot be built, and `complete` / `incomplete_reason` are derived from it in one place. Side-table text is passed through untouched (no `clip`, no trim), so whitespace survives byte for byte. The legacy fallback reuses `normalizePrompts`.
**Code:**
```ts
/** Why a prompt list is not complete: not backfilled by its owning host yet, or its transcript was pruned before the backfill. */
export type PromptsIncompleteReason = 'not_backfilled' | 'transcript_pruned';

/** One prompt as the wall's Expand prompts modal shows it: numbered from 1 in typed order. */
export interface NumberedPrompt {
  n: number;
  /** Exactly as stored (redacted at ingest); whitespace kept. */
  text: string;
  at: string | null;
  /**
   * Cut when it was written: at the storage ceiling (MAX_PROMPT_STORE_CHARS) on a complete list,
   * to an excerpt (ends in `…`) on a `transcript_pruned` one.
   */
  truncated: boolean;
}

/**
 * GET /api/sessions/:nodeId/prompts. Read from the DB only, so every host's nodes answer.
 * `complete` false, `incomplete_reason`:
 * - `not_backfilled`: the owning host has not backfilled this row yet; `prompts` are the bounded
 *   excerpts (newest 100, each at most 2000 chars) kept on cc_sessions.
 * - `transcript_pruned`: the transcript was gone when the owning host backfilled; `prompts` are the
 *   redacted excerpts it kept, and the older prompts and full text are lost for good.
 */
export interface PromptsPayload {
  node_id: string;
  host: string;
  available: boolean;
  complete: boolean;
  incomplete_reason: PromptsIncompleteReason | null;
  prompts: NumberedPrompt[];
}

/** One cc_session_prompts row, as readModel selects them (ordered by seq). */
export type StoredPromptRow = {
  text: string;
  at: Date | string | null;
  truncated: boolean | null;
};

/**
 * Where a node's prompt list comes from: the full side table (prompts_version >= PROMPTS_VERSION),
 * the side table rebuilt from excerpts (PROMPTS_VERSION_EXCERPTS), or the cc_sessions excerpts (0).
 */
export type PromptsSource =
  | { kind: 'full'; rows: readonly StoredPromptRow[] }
  | { kind: 'pruned'; rows: readonly StoredPromptRow[] }
  | { kind: 'legacy'; excerpts: unknown };

export function toPromptsPayload(head: { node_id: string; host: string }, thisHost: string, source: PromptsSource): PromptsPayload {
  const prompts: NumberedPrompt[] =
    source.kind === 'legacy'
      ? normalizePrompts(source.excerpts).map((p, i) => ({ n: i + 1, text: p.text, at: p.at, truncated: false }))
      : source.rows.map((r, i) => ({ n: i + 1, text: r.text, at: iso(r.at), truncated: r.truncated === true }));
  return {
    node_id: head.node_id,
    host: head.host,
    available: head.host === thisHost,
    complete: source.kind === 'full',
    incomplete_reason: source.kind === 'full' ? null : source.kind === 'pruned' ? 'transcript_pruned' : 'not_backfilled',
    prompts,
  };
}
```
**Impact:** additive; no existing caller changes.

### Step 2: `sessionPrompts` read
**File:** `src/sessions/readModel.ts`
**Change (a), L50:** replace
```ts
import { SELECTED_PROJECT_KEY } from './types.js';
```
with
```ts
import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS, SELECTED_PROJECT_KEY } from './types.js';
```
**Change (b), view import list (as Phase 2 leaves it; Phase 2 added `summaryState,` and `type SummaryRequestPayload,`):** add `toPromptsPayload,` after `toNoteRef,`, add `type PromptsPayload,` after `type ProjectsPayload,`, and add `type StoredPromptRow,` after `type SessionDetail,`. Keep Phase 2's names.
**Change (c):** insert right after Phase 2's `requestSummaryFor` block, which Phase 2 placed directly after `sessionDetail`:
**Code:**
```ts
type PromptsHeadRow = {
  session_id: string;
  node_id: string;
  host: string;
  prompts_version: number;
  excerpts: unknown;
};

/**
 * Every stored prompt of one node, for the wall's Expand prompts modal. DB only, never the
 * transcript, so it answers for every host's nodes. A row at PROMPTS_VERSION reads the full
 * redacted list from cc_session_prompts (seq order), complete. A row at PROMPTS_VERSION_EXCERPTS
 * (transcript pruned before the backfill) reads the same table, which then holds the redacted
 * excerpts, with complete: false. A legacy row, which its owning host has not backfilled yet, falls
 * back to the excerpts on cc_sessions with complete: false; its side-table rows, if the tail
 * ingester appended some, are partial and ignored. Null when the node does not exist. Never part of
 * the graph or detail queries (invariant 5).
 */
export async function sessionPrompts(rd: SessionsReadDeps, nodeId: string): Promise<PromptsPayload | null> {
  const head = await rd.db.execute<PromptsHeadRow>(sql`
    select session_id, node_id, host, prompts_version,
      case when prompts_version >= ${PROMPTS_VERSION_EXCERPTS} then null else prompts end as excerpts
    from cc_sessions where node_id = ${nodeId} limit 1`);
  const row = head.rows[0];
  if (row === undefined) return null;
  const version = Number(row.prompts_version);
  if (version < PROMPTS_VERSION_EXCERPTS) return toPromptsPayload(row, rd.host, { kind: 'legacy', excerpts: row.excerpts });
  const rows = await rd.db.execute<StoredPromptRow>(sql`
    select text, at, truncated from cc_session_prompts where session_id = ${row.session_id} order by seq`);
  return toPromptsPayload(row, rd.host, { kind: version >= PROMPTS_VERSION ? 'full' : 'pruned', rows: rows.rows });
}
```
**Impact:** new read only. The excerpt jsonb is not loaded for rows that read the side table (the `case`). There is no paging: the largest measured session is a few hundred KB of prompts (4.8 MB over 660 sessions), well within one JSON response.

### Step 3: The route
**File:** `src/http/sessionsApi.ts`
**Change (a), import list L6-20:** add `sessionPrompts,` after `sessionDetail,` (keep Phase 2's additions).
**Change (b), doc comment:** after the line ` * GET  /api/sessions/:nodeId/transcript?query=&limit=   owning host only` (L123), insert
```ts
 * GET  /api/sessions/:nodeId/prompts      every stored prompt (full when backfilled), from the DB, any host
```
**Change (c):** insert right before `r.get('/api/sessions/:nodeId', …)` (L206 today), and after Phase 2's `POST /api/sessions/:nodeId/summarize`:
**Code:**
```ts
  r.get('/api/sessions/:nodeId/prompts', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const payload = await sessionPrompts(rd, nodeId);
    if (payload === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    return c.json(payload);
  });
```
**Impact:** new GET; the node id is validated once here (boundary).

### Step 4: `useCopied` copies a text under a key
**File:** `web/src/hooks/useCopied.ts:21-36`
**Change:** replace `useCopied` (keep `copyText` as is).
**Code:**
```ts
/**
 * The key last copied, cleared after `ms` (design: 1.4 s "copied" fade). `copy(id)` copies the id
 * itself; `copy(key, text)` copies `text` and flags `key` (a prompt's text under "prompt-3").
 */
export function useCopied(ms = 1400): { copied: string | null; copy: (key: string, text?: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const copy = useCallback(
    (key: string, text?: string) => {
      copyText(text ?? key);
      setCopied(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), ms);
    },
    [ms],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { copied, copy };
}
```
**Impact:** App (`onCopy={copy}` into Gallery/Wall/NoteEditor, each calling `onCopy(note.id)`) and NodePanel (`copy(shownId)`) keep their behavior.

### Step 5: Web client for the route
**File:** `web/src/sessionDetailApi.ts`, append at end of file (after `resumeErrorNotice`, L256 today; after Phase 4's additions if they are at the end)
**Change:** The wire is normalized once here. Text is kept raw (`str()` would drop whitespace-only text). An item without a string text is dropped.
**Code:**
```ts
/** One prompt of `GET /api/sessions/:nodeId/prompts`: numbered from 1, text exactly as stored. */
export interface SessionPromptItem {
  n: number;
  text: string;
  at: string | null;
  truncated: boolean;
}

/** Why a prompt list is not complete (server `PromptsIncompleteReason`). */
export type PromptsIncompleteReason = 'not_backfilled' | 'transcript_pruned';

/**
 * `GET /api/sessions/:nodeId/prompts`, normalised. `complete` false: excerpts only, either until
 * `host` backfills (`not_backfilled`) or for good, its transcript was pruned (`transcript_pruned`).
 * `incomplete_reason` is null exactly when `complete` is true.
 */
export interface SessionPrompts {
  node_id: string;
  host: string;
  available: boolean;
  complete: boolean;
  incomplete_reason: PromptsIncompleteReason | null;
  prompts: SessionPromptItem[];
}

function promptItem(v: unknown, i: number): SessionPromptItem | null {
  if (!isObj(v) || typeof v.text !== 'string' || v.text === '') return null;
  const n = typeof v.n === 'number' && Number.isInteger(v.n) && v.n > 0 ? v.n : i + 1;
  return { n, text: v.text, at: str(v.at), truncated: v.truncated === true };
}

export function normalizeSessionPrompts(raw: Wire): SessionPrompts {
  const complete = raw.complete !== false;
  return {
    node_id: str(raw.node_id) ?? '',
    host: str(raw.host) ?? '',
    available: raw.available !== false,
    complete,
    incomplete_reason: complete ? null : raw.incomplete_reason === 'transcript_pruned' ? 'transcript_pruned' : 'not_backfilled',
    prompts: compact(list(raw.prompts).map(promptItem)),
  };
}

/** `GET /api/sessions/:nodeId/prompts` -> every stored prompt, or null on 404. The server normalises the id. */
export async function fetchSessionPrompts(nodeId: string, signal?: AbortSignal): Promise<SessionPrompts | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/prompts`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  if (!isObj(j)) throw new ApiError(500, 'bad prompts payload');
  return normalizeSessionPrompts(j);
}
```

### Step 6: `PromptsModal`
**File:** `web/src/components/graph/PromptsModal.tsx` (new)
**Change:** A portal modal in the shape of the big editor. Its Esc listener is a window capture listener that calls `preventDefault` + `stopPropagation` + `stopImmediatePropagation`, the Lightbox/ConfirmDialog seam. ProjectsPage's and App's document listeners never see the key. NodeModal's window capture listener was registered earlier, so it yields through `isPromptsOpen()` (Step 9). The backdrop click stops propagation, so the React tree (`.nm` in NodeModal) never sees it. Focus goes to the dialog and comes back to the opener. The close button is labelled "Close prompts" so it never collides with the panel's "Close".
**Code:**
```tsx
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X } from '@phosphor-icons/react';
import { useCopied } from '../../hooks/useCopied';
import { chatTime, chatTimeTitle } from '../../lib/chatTime';
import { hostsLabel } from '../../lib/remote';
import { fetchSessionPrompts, type SessionPromptItem, type SessionPrompts } from '../../sessionDetailApi';
import './PromptsModal.css';

/** The modal root carries `data-modal="prompts"`; its presence in the DOM means "the prompts modal is open". */
export const PROMPTS_SELECTOR = '[data-modal="prompts"]';

/**
 * True while the prompts modal is mounted. A window capture Esc listener registered before it
 * (NodeModal's) must return early when this is true: the modal's stopPropagation cannot stop a
 * listener on the same target that already ran.
 */
export function isPromptsOpen(doc: Document = document): boolean {
  return doc.querySelector(PROMPTS_SELECTOR) !== null;
}

/** "Copy all prompts": `1. <text>\n\n2. <text>…`, each text exactly as shown. */
export function promptsCopyText(prompts: readonly SessionPromptItem[]): string {
  return prompts.map((p) => `${p.n}. ${p.text}`).join('\n\n');
}

export interface PromptsModalProps {
  /** Canonical node id (the panel's loaded detail). */
  nodeId: string;
  /** The panel's clock, for prompt times. */
  now: Date;
  onClose: () => void;
}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: SessionPrompts }
  | { state: 'missing' }
  | { state: 'error'; message: string };

const stop = (e: MouseEvent) => e.stopPropagation();
const ALL_KEY = 'all';
const promptKey = (n: number): string => `prompt-${n}`;

/**
 * Expand prompts (R2): every stored prompt of a node over the page, numbered, timed, in full with
 * whitespace kept, each with its own copy button and "Copy all prompts" at the top right. Loads
 * from the DB (`GET /api/sessions/:nodeId/prompts`), never the transcript. Esc, the X and the
 * backdrop close only this modal; the node panel (and the chat pop-up) stay.
 */
export function PromptsModal({ nodeId, now, onClose }: PromptsModalProps) {
  const { copied, copy } = useCopied();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const panelRef = useRef<HTMLDivElement>(null);
  const live = useRef(onClose);
  live.current = onClose;

  useEffect(() => {
    const ac = new AbortController();
    setLoad({ state: 'loading' });
    fetchSessionPrompts(nodeId, ac.signal).then(
      (d) => {
        if (!ac.signal.aborted) setLoad(d ? { state: 'ready', data: d } : { state: 'missing' });
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setLoad({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => ac.abort();
  }, [nodeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Capture phase + preventDefault + stopPropagation (the Lightbox seam): the page's document
      // listeners (ProjectsPage clears the node, App closes the chat) never see this Esc, and
      // stopImmediatePropagation stops window capture listeners registered after this one.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      live.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    // Keyboard users land in the modal; focus goes back to the expand button on close.
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const data = load.state === 'ready' ? load.data : null;
  const prompts = data?.prompts ?? [];
  const allDone = copied === ALL_KEY;

  return createPortal(
    <div
      className="prm"
      data-modal="prompts"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={panelRef}
        className="prm-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Prompts of ${nodeId}`}
        tabIndex={-1}
        onClick={stop}
      >
        <header className="prm-head">
          <span className="prm-id">{nodeId}</span>
          <h2 className="prm-title">Prompts</h2>
          {data && <span className="prm-count">{prompts.length}</span>}
          <span className="prm-spacer" />
          <button
            type="button"
            className="ibtn hov"
            data-tip={allDone ? 'Copied' : 'Copy all prompts'}
            data-tip-side="below"
            aria-label="Copy all prompts"
            disabled={prompts.length === 0}
            onClick={() => copy(ALL_KEY, promptsCopyText(prompts))}
          >
            {allDone ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          <button type="button" className="ibtn hov" data-tip="Close" data-tip-side="below" aria-label="Close prompts" onClick={onClose}>
            <X weight="duotone" />
          </button>
        </header>

        {load.state === 'loading' && <p className="prm-dim">Loading prompts</p>}
        {load.state === 'missing' && <p className="prm-dim">No session {nodeId}</p>}
        {load.state === 'error' && <p className="prm-dim">Could not load prompts: {load.message}</p>}
        {data && data.incomplete_reason === 'not_backfilled' && (
          <p className="prm-dim">Full prompts arrive once {hostsLabel(data.host ? [data.host] : [])} backfills</p>
        )}
        {data && data.incomplete_reason === 'transcript_pruned' && (
          <p className="prm-dim">Older prompts were cut; the full text is no longer on {hostsLabel(data.host ? [data.host] : [])}</p>
        )}
        {data && prompts.length === 0 && <p className="prm-dim">None</p>}

        {prompts.length > 0 && (
          <ol className="prm-list">
            {prompts.map((p) => {
              const key = promptKey(p.n);
              const done = copied === key;
              return (
                <li key={p.n} className="prm-item" data-n={p.n}>
                  <div className="prm-item-head">
                    <span className="prm-n">{p.n}</span>
                    {p.at && (
                      <time dateTime={p.at} title={chatTimeTitle(p.at)}>
                        {chatTime(p.at, now)}
                      </time>
                    )}
                    {p.truncated && (
                      <span className="prm-cut" data-tip={data?.complete ? 'Cut at the storage limit' : 'Only an excerpt was kept'}>
                        truncated
                      </span>
                    )}
                    <button
                      type="button"
                      className="ibtn hov"
                      data-tip={done ? 'Copied' : `Copy prompt ${p.n}`}
                      aria-label={`Copy prompt ${p.n}`}
                      onClick={() => copy(key, p.text)}
                    >
                      {done ? <Check weight="duotone" /> : <Copy weight="duotone" />}
                    </button>
                  </div>
                  <div className="prm-text">{p.text}</div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

### Step 7: Modal styles
**File:** `web/src/components/graph/PromptsModal.css` (new)
**Change:** The editor's scrim and box (`NoteEditor.css` `.ed`/`.ed-panel`), the panel's mono meta and hairlines. No shadows, no rounded cards. z-index 60 like the editor over NodeModal: the later portal stacks on top.
**Code:**
```css
/* Expand prompts (R2): the big editor's scrim and box; one prompt per row, its text as typed. */
.prm { position: fixed; inset: 0; z-index: 60; background: rgba(10, 10, 9, .94); display: grid; grid-template-columns: minmax(0, 1fr); place-items: center; padding: 24px 16px; box-sizing: border-box; }
.prm-panel { width: min(1080px, 100%); height: min(880px, calc(100vh - 48px)); display: flex; flex-direction: column; gap: 10px; background: var(--bg); border: 1px solid var(--line-14); padding: 12px 18px 0; box-sizing: border-box; color: var(--text); font-family: var(--sans); outline: none; }
.prm-head { display: flex; align-items: center; gap: 10px; min-height: 40px; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.prm-id { color: var(--id); letter-spacing: .03em; }
.prm-title { margin: 0; font-family: var(--mono); font-size: 10.5px; font-weight: 400; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
.prm-count { color: var(--muted); }
.prm-spacer { flex: 1; }
.prm-head .ibtn { font-size: 19px; }
.prm-head .ibtn:disabled { opacity: .35; cursor: default; }
.prm-head .ibtn:disabled:hover { background: transparent; }
.prm-dim { margin: 0; font-family: var(--mono); font-size: 11px; color: var(--dim); }

.prm-list { flex: 1; min-height: 0; overflow-y: auto; list-style: none; margin: 0; padding: 0 0 24px; border-top: 1px solid var(--line); }
.prm-item { display: flex; flex-direction: column; gap: 8px; padding: 14px 0 16px; border-bottom: 1px solid var(--line-12); }
.prm-item:last-child { border-bottom: 0; }
.prm-item-head { display: flex; align-items: center; gap: 10px; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.prm-item-head time { cursor: default; }
.prm-n { min-width: 2.5ch; color: var(--id); }
.prm-cut { padding: 1px 7px 2px; border-radius: 999px; background: var(--chip-bg); color: var(--chip); }
.prm-item-head .ibtn { margin-left: auto; width: 30px; height: 30px; font-size: 16px; }
.prm-text { margin: 0; font-size: 14.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; color: var(--text); }
```

### Step 8: NodePanel: Expand prompts button and the modal
**File:** `web/src/components/graph/NodePanel.tsx` (as it is after Phase 4)
**Change (a), phosphor import (L3):** add `ArrowsOut` to the existing `@phosphor-icons/react` import list (it already carries Phase 4's `MagicWand`). Keep the list alphabetical, with `ArrowsOut` first.
**Change (b), local imports:** after `import { UnfinishedPill } from './UnfinishedBadge';` add
```ts
import { PromptsModal } from './PromptsModal';
```
**Change (c), state:** after `const [confirm, setConfirm] = useState<{ fresh: boolean } | null>(null);` (L67 today) add
```ts
  const [promptsOpen, setPromptsOpen] = useState(false);
```
**Change (d), node-change reset (L90-93 today):** the effect keyed on `[nodeId]` that calls `setNotice(null); setConfirm(null);` gains one line, so that moving to another node closes the modal:
```ts
  useEffect(() => {
    setNotice(null);
    setConfirm(null);
    setPromptsOpen(false);
  }, [nodeId]);
```
If Phase 4 added lines to this effect, keep them and add only `setPromptsOpen(false);`.
**Change (e), the Prompts section (L243-257 today; Phase 4 does not touch it):** replace the whole section with
```tsx
          <section className="np-sec" aria-label="Prompts">
            <div className="np-sec-head">
              <h3>Prompts</h3>
              {detail.prompts.length > 0 && (
                <button
                  type="button"
                  className="ibtn hov"
                  data-tip="Expand prompts"
                  aria-label="Expand prompts"
                  aria-haspopup="dialog"
                  onClick={() => setPromptsOpen(true)}
                >
                  <ArrowsOut weight="duotone" />
                </button>
              )}
            </div>
            {detail.prompts.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ol className="np-prompts">
                {detail.prompts.slice(0, PROMPTS_SHOWN).map((p, i) => (
                  <li key={i}>
                    <span className="np-clamp">{p}</span>
                  </li>
                ))}
              </ol>
            )}
            {detail.prompts.length > PROMPTS_SHOWN && <p className="np-dim">+{detail.prompts.length - PROMPTS_SHOWN} more</p>}
          </section>
```
**Change (f), render the modal:** right after the `{confirm && detail && createPortal(<ConfirmDialog …/>, document.body)}` block (L393-408 today), before `</aside>`, add
```tsx
      {promptsOpen && detail && <PromptsModal nodeId={detail.node_id} now={now} onClose={() => setPromptsOpen(false)} />}
```
**Impact:** The button is sized by Phase 4's `.np-sec-head > .ibtn`, so no CSS change is needed. The modal portals itself to `document.body`.

### Step 9: NodeModal yields Esc to the prompts modal
**File:** `web/src/components/graph/NodeModal.tsx`
**Change (a), imports (L3-5):** after `import { isEditorOpen } from '../NoteEditor';` add
```ts
import { isPromptsOpen } from './PromptsModal';
```
**Change (b), the Esc effect (L36-48):** replace with
```ts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The big editor (opened from "Notes made") and the prompts modal (Expand prompts) register
      // their Esc listeners after this one: yield to them, or one Esc would close both. Same for a
      // lightbox or confirm.
      if (e.key !== 'Escape' || isEditorOpen() || isLightboxOpen() || isConfirmOpen() || isPromptsOpen()) return;
      // Capture phase + preventDefault + stopPropagation (the editor's seam): Esc closes only the pop-up.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
```
**Impact:** with the prompts modal open over the chat pop-up, one Esc closes the modal and the next one closes the pop-up. The backdrop click is already contained: `.nm-panel` stops propagation in the React tree, and the modal's backdrop stops it too.

### Step 10: Unit test for the shaper
**File:** `tests/unit/sessions/promptsPayload.test.ts` (new)
**Code:**
```ts
import { describe, expect, it } from 'vitest';
import { toPromptsPayload } from '../../../src/sessions/view.js';

const HEAD = { node_id: 'A0-3G', host: 'pc' };

describe('toPromptsPayload', () => {
  it('numbers side-table rows from 1 in the given order and keeps text byte for byte', () => {
    const spaced = '  indented\n\n\tcode  block\n[redacted] kept  ';
    const out = toPromptsPayload(HEAD, 'pc', {
      kind: 'full',
      rows: [
        { text: spaced, at: new Date('2026-11-01T01:00:00Z'), truncated: false },
        { text: 'cut', at: null, truncated: true },
      ],
    });
    expect(out).toEqual({
      node_id: 'A0-3G',
      host: 'pc',
      available: true,
      complete: true,
      incomplete_reason: null,
      prompts: [
        { n: 1, text: spaced, at: '2026-11-01T01:00:00.000Z', truncated: false },
        { n: 2, text: 'cut', at: null, truncated: true },
      ],
    });
  });

  it('falls back to the excerpt jsonb, not_backfilled, on another host', () => {
    const out = toPromptsPayload(HEAD, 'lenovo', {
      kind: 'legacy',
      excerpts: [{ text: 'old excerpt…', at: '2026-11-01T02:00:00Z' }, { text: '   ' }, 'bare string'],
    });
    expect(out).toEqual({
      node_id: 'A0-3G',
      host: 'pc',
      available: false,
      complete: false,
      incomplete_reason: 'not_backfilled',
      prompts: [
        { n: 1, text: 'old excerpt…', at: '2026-11-01T02:00:00.000Z', truncated: false },
        { n: 2, text: 'bare string', at: null, truncated: false },
      ],
    });
  });

  it('a row rebuilt from excerpts (transcript pruned) is never complete', () => {
    const out = toPromptsPayload(HEAD, 'pc', { kind: 'pruned', rows: [{ text: 'kept excerpt…', at: null, truncated: true }] });
    expect(out).toMatchObject({
      complete: false,
      incomplete_reason: 'transcript_pruned',
      prompts: [{ n: 1, text: 'kept excerpt…', at: null, truncated: true }],
    });
  });
});
```

### Step 11: Route + readModel integration test
**File:** `tests/integration/sessions.api.int.test.ts`
**Change (a), imports:** add `import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS } from '../../src/sessions/types.js';` after the `readModel.js` type import (L6), and add `PromptsPayload,` to the `view.js` type import list (L7-15).
**Change (b):** insert a new describe right after `describe('GET /api/sessions/:nodeId/transcript', …)` (ends L272 today). `sql` is already imported (L1). Rows are written with raw SQL, the way `seedSession` seeds `cc_sessions`. `beforeEach` → `clearSessions` deletes `cc_sessions`, and the FK cascade removes the side rows.
**Code:**
```ts
describe('GET /api/sessions/:nodeId/prompts', () => {
  const LONG = `${'x'.repeat(2500)}\n  tail kept`;
  const SPACED = '  indented\n\n\tkeep [redacted] spacing  ';

  async function storePrompts(sessionId: string, version: number, rows: Array<{ seq: number; at: string | null; text: string; truncated?: boolean }>): Promise<void> {
    await h.deps.db.execute(sql`update cc_sessions set prompts_version = ${version} where session_id = ${sessionId}`);
    for (const r of rows) {
      await h.deps.db.execute(sql`
        insert into cc_session_prompts (session_id, seq, at, text, truncated)
        values (${sessionId}, ${r.seq}, ${r.at}::timestamptz, ${r.text}, ${r.truncated ?? false})`);
    }
  }

  it('lists every stored prompt of a backfilled row in seq order, numbered from 1, text byte for byte', async () => {
    await storePrompts('sess-root', PROMPTS_VERSION, [
      { seq: 2, at: '2026-10-31T18:05:00Z', text: LONG },
      { seq: 1, at: '2026-10-31T18:00:00Z', text: SPACED },
      { seq: 3, at: null, text: 'cut here', truncated: true },
    ]);
    const { status, body } = await get<PromptsPayload>('/api/sessions/a03g/prompts');
    expect(status).toBe(200);
    expect(body).toEqual({
      node_id: 'A0-3G',
      host: THIS_HOST,
      available: true,
      complete: true,
      incomplete_reason: null,
      prompts: [
        { n: 1, text: SPACED, at: '2026-10-31T18:00:00.000Z', truncated: false },
        { n: 2, text: LONG, at: '2026-10-31T18:05:00.000Z', truncated: false },
        { n: 3, text: 'cut here', at: null, truncated: true },
      ],
    });
  });

  it('a backfilled row with no prompts answers an empty list', async () => {
    await storePrompts('sess-b1', PROMPTS_VERSION, []);
    const { body } = await get<PromptsPayload>('/api/sessions/B1-22/prompts');
    expect(body).toMatchObject({ node_id: 'B1-22', complete: true, prompts: [] });
  });

  it('falls back to the cc_sessions excerpts, complete false, until the owning host backfills', async () => {
    await h.deps.db.execute(sql`
      update cc_sessions set prompts = ${JSON.stringify([{ text: 'old excerpt…', at: '2026-11-01T02:00:00Z' }])}::jsonb
      where session_id = 'sess-c2'`);
    // A tail append on a legacy row may already have written side rows; they are partial and ignored.
    await storePrompts('sess-c2', 0, [{ seq: 1, at: null, text: 'partial side row' }]);
    const { status, body } = await get<PromptsPayload>('/api/sessions/C2-33/prompts');
    expect(status).toBe(200);
    expect(body).toEqual({
      node_id: 'C2-33',
      host: OTHER_HOST,
      available: false,
      complete: false,
      incomplete_reason: 'not_backfilled',
      prompts: [{ n: 1, text: 'old excerpt…', at: '2026-11-01T02:00:00.000Z', truncated: false }],
    });
  });

  it('a row redacted in place from excerpts (transcript pruned) lists its side rows, never complete', async () => {
    await storePrompts('sess-d4', PROMPTS_VERSION_EXCERPTS, [
      { seq: 1, at: '2026-10-01T00:00:00Z', text: 'old one' },
      { seq: 2, at: null, text: 'deploy with [redacted] and more…', truncated: true },
    ]);
    const { status, body } = await get<PromptsPayload>('/api/sessions/D4-44/prompts');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      node_id: 'D4-44',
      complete: false,
      incomplete_reason: 'transcript_pruned',
      prompts: [
        { n: 1, text: 'old one', at: '2026-10-01T00:00:00.000Z', truncated: false },
        { n: 2, text: 'deploy with [redacted] and more…', at: null, truncated: true },
      ],
    });
  });

  it('400 invalid_node_id, 404 not_found', async () => {
    const bad = await get<{ error: string }>('/api/sessions/A-B32/prompts');
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_node_id' });
    const missing = await get<{ error: string }>('/api/sessions/ZZ-ZZ/prompts');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', node_id: 'ZZ-ZZ' });
  });

  it('the graph and detail payloads do not carry the side-table text', async () => {
    await storePrompts('sess-root', PROMPTS_VERSION, [{ seq: 1, at: null, text: 'only-in-side-table-7f3' }]);
    const graph = await app.request('/api/projects/mcp-notes/sessions');
    expect(await graph.text()).not.toContain('only-in-side-table-7f3');
    const detail = await app.request('/api/sessions/A0-3G');
    expect(await detail.text()).not.toContain('only-in-side-table-7f3');
  });
});
```

### Step 12: Web client test
**File:** `web/src/sessionDetailApi.test.tsx`
**Change (a), L4:** add `fetchSessionPrompts` to the import from `./sessionDetailApi`.
**Change (b):** append at end of file:
**Code:**
```ts
describe('fetchSessionPrompts', () => {
  it('GETs /api/sessions/:id/prompts and keeps each text exactly as sent', async () => {
    const seen = stub(200, {
      node_id: 'A0-3G',
      host: 'GPD',
      available: false,
      complete: false,
      prompts: [
        { n: 1, text: '  a\n\tb  ', at: '2026-11-01T01:00:00.000Z', truncated: false },
        { n: 2, text: 'cut', at: null, truncated: true },
        { n: 3, text: 42 },
      ],
    });
    const p = await fetchSessionPrompts('A0-3G');
    expect(seen[0]).toEqual({ url: '/api/sessions/A0-3G/prompts', method: 'GET', body: null });
    expect(p).toEqual({
      node_id: 'A0-3G',
      host: 'GPD',
      available: false,
      complete: false,
      incomplete_reason: 'not_backfilled',
      prompts: [
        { n: 1, text: '  a\n\tb  ', at: '2026-11-01T01:00:00.000Z', truncated: false },
        { n: 2, text: 'cut', at: null, truncated: true },
      ],
    });
  });

  it('keeps transcript_pruned, and has no reason when complete', async () => {
    stub(200, { node_id: 'A0-3G', host: 'pc', complete: false, incomplete_reason: 'transcript_pruned', prompts: [] });
    expect((await fetchSessionPrompts('A0-3G'))?.incomplete_reason).toBe('transcript_pruned');
    stub(200, { node_id: 'A0-3G', host: 'pc', complete: true, incomplete_reason: 'transcript_pruned', prompts: [] });
    expect((await fetchSessionPrompts('A0-3G'))?.incomplete_reason).toBeNull();
  });

  it('null on 404, ApiError with the server error otherwise', async () => {
    stub(404, { error: 'not_found' });
    expect(await fetchSessionPrompts('ZZ-ZZ')).toBeNull();
    stub(500, { error: 'boom' });
    await expect(fetchSessionPrompts('A0-3G')).rejects.toMatchObject({ status: 500, message: 'boom' });
  });
});
```

### Step 13: PromptsModal tests
**File:** `web/src/components/graph/PromptsModal.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PromptsModal, isPromptsOpen, promptsCopyText } from './PromptsModal';

// 2026-11-01 11:00 in Jakarta.
const NOW = new Date('2026-11-01T04:00:00Z');
const SPACED = '  indented line\n\n\tcode  block\nkey [redacted] kept  ';
const LONG = 'x'.repeat(2500);
const PAYLOAD = {
  node_id: 'A0-3G',
  host: 'lenovo',
  available: true,
  complete: true,
  incomplete_reason: null,
  prompts: [
    { n: 1, text: 'run the swarm', at: '2026-11-01T01:00:00.000Z', truncated: false },
    { n: 2, text: SPACED, at: '2026-11-01T01:05:00.000Z', truncated: false },
    { n: 3, text: LONG, at: null, truncated: true },
  ],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let writeText: ReturnType<typeof vi.fn>;

function stub(status: number, body: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json(status, body);
    }),
  );
  return urls;
}

function open(): ReturnType<typeof vi.fn> {
  const onClose = vi.fn();
  render(<PromptsModal nodeId="A0-3G" now={NOW} onClose={onClose} />);
  return onClose;
}

async function ready(): Promise<HTMLElement> {
  await screen.findByText('run the swarm');
  return screen.getByRole('dialog', { name: 'Prompts of A0-3G' });
}

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('PromptsModal', () => {
  it('lists every prompt numbered from 1 with its time, the text exactly as typed', async () => {
    const urls = stub(200, PAYLOAD);
    open();
    const d = await ready();
    expect(urls).toEqual(['/api/sessions/A0-3G/prompts']);
    const items = within(d).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-n'))).toEqual(['1', '2', '3']);
    expect(items.map((li) => li.querySelector('.prm-n')?.textContent)).toEqual(['1', '2', '3']);
    expect(items[1]!.querySelector('.prm-text')?.textContent).toBe(SPACED);
    expect(items[2]!.querySelector('.prm-text')?.textContent).toBe(LONG);
    expect(within(items[2]!).getByText('truncated')).toBeTruthy();
    expect(within(items[0]!).queryByText('truncated')).toBeNull();
    expect(items[0]!.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-01T01:00:00.000Z');
    expect(items[2]!.querySelector('time')).toBeNull();
    expect(d.querySelector('.prm-count')?.textContent).toBe('3');
    expect(screen.queryByText(/backfills/)).toBeNull();
    expect(screen.queryByText(/no longer on/)).toBeNull();
  });

  it('"Copy prompt N" copies that prompt exactly as shown, with a brief check mark', async () => {
    stub(200, PAYLOAD);
    open();
    const d = await ready();
    const two = within(d).getByRole('button', { name: 'Copy prompt 2' });
    fireEvent.click(two);
    expect(writeText).toHaveBeenLastCalledWith(SPACED);
    expect(two.getAttribute('data-tip')).toBe('Copied');
    expect(within(d).getByRole('button', { name: 'Copy prompt 1' }).getAttribute('data-tip')).toBe('Copy prompt 1');
  });

  it('"Copy all prompts" joins them as "1. <text>\\n\\n2. <text>…"', async () => {
    stub(200, PAYLOAD);
    open();
    const d = await ready();
    const all = within(d).getByRole('button', { name: 'Copy all prompts' });
    fireEvent.click(all);
    const expected = `1. run the swarm\n\n2. ${SPACED}\n\n3. ${LONG}`;
    expect(writeText).toHaveBeenLastCalledWith(expected);
    expect(promptsCopyText(PAYLOAD.prompts)).toBe(expected);
    expect(all.getAttribute('data-tip')).toBe('Copied');
  });

  it('says the full prompts are still to come while the owning host has not backfilled', async () => {
    stub(200, { ...PAYLOAD, host: 'GPD', available: false, complete: false, incomplete_reason: 'not_backfilled', prompts: [PAYLOAD.prompts[0]] });
    open();
    await ready();
    expect(screen.getByText('Full prompts arrive once GPD backfills')).toBeTruthy();
    expect(screen.queryByText(/no longer on/)).toBeNull();
  });

  it('says older prompts were cut when the transcript was pruned before the backfill', async () => {
    stub(200, { ...PAYLOAD, host: 'GPD', available: false, complete: false, incomplete_reason: 'transcript_pruned', prompts: [PAYLOAD.prompts[0]] });
    open();
    await ready();
    expect(screen.getByText('Older prompts were cut; the full text is no longer on GPD')).toBeTruthy();
    expect(screen.queryByText(/backfills/)).toBeNull();
  });

  it('Esc closes the modal and never reaches the page under it', async () => {
    stub(200, PAYLOAD);
    const page = vi.fn();
    const onDocKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') page();
    };
    document.addEventListener('keydown', onDocKey);
    try {
      const onClose = open();
      const d = await ready();
      expect(isPromptsOpen()).toBe(true);
      fireEvent.keyDown(d, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(page).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDocKey);
    }
  });

  it('a backdrop click closes it; a click inside does not', async () => {
    stub(200, PAYLOAD);
    const onClose = open();
    const d = await ready();
    fireEvent.click(within(d).getByText('run the swarm'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('[data-modal="prompts"]') as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows loading, then a missing node, or the error with copy-all disabled', async () => {
    stub(404, { error: 'not_found' });
    open();
    expect(screen.getByText('Loading prompts')).toBeTruthy();
    expect(await screen.findByText('No session A0-3G')).toBeTruthy();
    cleanup();
    stub(500, { error: 'boom' });
    open();
    expect(await screen.findByText('Could not load prompts: boom')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Copy all prompts' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

### Step 14: NodePanel test for the expand button
**File:** `web/src/components/graph/NodePanel.test.tsx`, append at end of file. It uses the file's `WIRE`, `json`, `renderPanel`, and `within`/`waitFor`, which are already imported. It stubs fetch itself, so it does not depend on Phase 4's `stubFetch` signature.
**Code:**
```tsx
describe('NodePanel: Expand prompts', () => {
  const PROMPTS = {
    node_id: 'A0-3G',
    host: 'lenovo',
    available: true,
    complete: true,
    prompts: [
      { n: 1, text: 'run the swarm', at: '2026-11-01T01:00:00.000Z', truncated: false },
      { n: 2, text: 'merge phase 3', at: null, truncated: false },
    ],
  };

  function stubRoutes(detail: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/prompts') ? json(200, PROMPTS) : json(200, detail))),
    );
  }

  it('offers no expand button for a session without prompts', async () => {
    stubRoutes({ ...WIRE, prompts: [] });
    renderPanel();
    await screen.findByRole('heading', { name: 'orch-wall-editing' });
    expect(screen.queryByRole('button', { name: 'Expand prompts' })).toBeNull();
  });

  it('opens the prompts modal; Esc closes only the modal, the next Esc reaches the page', async () => {
    stubRoutes(WIRE);
    const pageEsc = vi.fn();
    // ProjectsPage's listener: clears the node unless the Esc was already handled.
    const onDocKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'Escape') pageEsc();
    };
    document.addEventListener('keydown', onDocKey);
    try {
      const { props } = renderPanel();
      fireEvent.click(await screen.findByRole('button', { name: 'Expand prompts' }));
      const dialog = await screen.findByRole('dialog', { name: 'Prompts of A0-3G' });
      expect(await within(dialog).findByText('merge phase 3')).toBeTruthy();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompts of A0-3G' })).toBeNull());
      expect(pageEsc).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('complementary', { name: 'Session A0-3G' })).toBeTruthy();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(pageEsc).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onDocKey);
    }
  });
});
```

### Step 15: NodeModal test: prompts modal over the chat pop-up
**File:** `web/src/components/graph/NodeModal.test.tsx`, append at end of file. It overrides the file's `beforeEach` fetch stub inside the test.
**Code:**
```tsx
describe('NodeModal: the prompts modal over the pop-up', () => {
  it('Esc closes only the prompts modal, a second Esc the pop-up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/sessions/BE-XU/prompts') {
          return json({ node_id: 'BE-XU', host: 'pc', available: true, complete: true, prompts: [{ n: 1, text: 'hello prompts', at: null, truncated: false }] });
        }
        if (url.startsWith('/api/sessions/BE-XU')) {
          return json({ session: { session_id: 's1', node_id: 'BE-XU', repo: null, host: 'pc', name: 'orch-project-session-graph' }, prompts: [{ text: 'hello prompts', at: null }] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const onClose = vi.fn();
    render(<NodeModal nodeId="BE-XU" repo={null} onClose={onClose} onShowOnGraph={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand prompts' }));
    await screen.findByRole('dialog', { name: 'Prompts of BE-XU' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompts of BE-XU' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(popup()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

### Step 16: Feature map
**File:** `.claude/skills/verify-notesd/features/projects.md` (as Phase 4 leaves it: one merged "Summary on demand (R1, …)" bullet, Phase 2's "Summary requests." driving block, Phase 4's "Summarize in the wall." block, one merged summary Gotcha)
**Change (a), `## Sub-features`:** append this bullet after the "Summary on demand (R1, …)" bullet:
```markdown
- Expand prompts (R2): the node panel's Prompts section has an icon-only "Expand prompts" button
  (shown when the session has a prompt). It opens a large modal (`role=dialog`, "Prompts of <NODE>")
  listing every stored prompt, numbered from 1, with its time and the full text, whitespace kept.
  Secrets are shown as `[redacted]`, and a prompt cut at the 256 KB storage ceiling is marked
  "truncated". "Copy prompt N" copies that prompt's text. "Copy all prompts" (top right) copies
  `1. <text>\n\n2. <text>…`. Both show a brief check mark. Esc, X ("Close prompts") or a backdrop
  click closes only the modal; the node panel, `?node=` and the chat node pop-up stay. The modal
  reads `GET /api/sessions/:nodeId/prompts` (DB only, any host). A row its owning host has not
  backfilled yet shows its excerpts and the line "Full prompts arrive once <host> backfills"
  (`complete: false`, `incomplete_reason: not_backfilled`). A row whose transcript was pruned
  before the backfill shows its redacted excerpts and "Older prompts were cut; the full text is no
  longer on <host>" (`prompts_version` 1, `incomplete_reason: transcript_pruned`). Fixture:
  session `5e55a001-…-000000000005` (106 prompts, #50 over 2000 chars, #60 with a fake key shown
  as `[redacted]`); it adds a third node to the mcp-notes graph.
```
**Change (b), `## Driving it with verify.sh`:** append after Phase 4's "Summarize in the wall." block:
````markdown
Expand prompts. The fixture session with more than 100 prompts (one over 2000 chars, one with a fake
`sk-ant-` key) is in repo `mcp-notes`; find it by its prompt count, never by a typed id:
```sh
BIG=""; for i in $(seq 30); do
  for n in $(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r '.nodes[].node_id'); do
    [ "$(curl -sf "$URL/api/sessions/$n/prompts" | jq '.prompts | length')" -gt 100 ] && BIG=$n
  done; [ -n "$BIG" ] && break; sleep 1; done; echo "BIG=$BIG"
$V api RUN GET /api/sessions/$BIG/prompts      # complete:true, n = 1..N, one text > 2000 chars, "[redacted]", no "sk-ant-"
$V sql RUN "select count(*) from cc_session_prompts p join cc_sessions s using (session_id) where s.node_id = '$BIG'"
$V api RUN GET /api/sessions/ZZ-ZZ/prompts     # 404 not_found; A-B32 -> 400 invalid_node_id
```
UI selectors (pass ids through the environment: `NODE=$BIG PROMPTS_JSON=<file> $V ui RUN steps.mjs`):
- expand: `panel.getByRole('region', { name: 'Prompts' }).getByRole('button', { name: 'Expand prompts' })`
- modal: `page.getByRole('dialog', { name: 'Prompts of ' + NODE })`; rows `li.prm-item[data-n="N"]`, text `.prm-text`
- copy: `getByRole('button', { name: 'Copy prompt 1', exact: true })` (exact, or it also matches 10, 11, …), `'Copy all prompts'`
- backdrop: `page.locator('[data-modal="prompts"]').dispatchEvent('click')`
````
**Change (c), `## Gotchas`:** append:
```markdown
- Headless chromium has no clipboard permission: to check what a copy button copied, stub
  `navigator.clipboard.writeText` with `page.addInitScript` before `goto` and read the stub back.
- Compare a prompt with `.prm-text` `textContent()`, not `innerText()`: textContent keeps the
  prompt's whitespace byte for byte.
```

## Principles applied

- Laziness protocol: `useCopied` gets an optional `text` argument instead of a second hook. The `complete: false` fallback reuses `normalizePrompts`. The header button reuses Phase 4's `.np-sec-head > .ibtn` (no new NodePanel CSS). There is no paging on the prompts route, because the measured largest session fits in one response.
- Make illegal states unrepresentable: `toPromptsPayload` takes `PromptsSource`, a union of `{kind: 'full'; rows}`, `{kind: 'pruned'; rows}` and `{kind: 'legacy'; excerpts}`, and derives `complete` and `incomplete_reason` from `kind` in one place, so a "complete" payload shaped from excerpts, or a complete one with a reason, cannot be built. The excerpt jsonb is selected only when it is used.
- Boundary discipline: the node id is normalized once in the route (`normalizeNodeId`). The wire is normalized once in `normalizeSessionPrompts`. Prompt text is never trimmed or clipped on the way to the modal (side-table text is passed raw), so "copy copies exactly what is shown" holds by construction.
- Test behavior, not implementation: tests assert the clipboard payload, DOM text (`textContent` equality for whitespace), what a document-level Esc listener sees, and the HTTP body. They do not assert internal calls.
- Prove it works: the Proof drives the real daemon with the Phase 3 fixture through verify-notesd (API, SQL and Playwright).

## Verification

If the worktree has no `node_modules`, run `npm ci` in `/home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts` first.

**Build:** `npm run typecheck`
**Tests:** `npm test` (includes `npx vitest run tests/unit/sessions/promptsPayload.test.ts web/src/components/graph/PromptsModal.test.tsx web/src/components/graph/NodePanel.test.tsx web/src/components/graph/NodeModal.test.tsx web/src/sessionDetailApi.test.tsx`), then `npm run test:int` (or only this phase's file: `npm run test:int -- tests/integration/sessions.api.int.test.ts`)
**Proof:**
- Harness: `.claude/skills/verify-notesd`
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md` (Expand prompts; neighbor: node panel Esc)
- Journeys (run from the worktree root; `SP` is the scratchpad dir):

**J1: API serves every stored prompt of the fixture session, redacted and complete.**
```sh
cd /home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts
V=.claude/skills/verify-notesd/scripts/verify.sh
$V up --sessions --web            # note RUN=<id> and URL=<url>
BIG=""; for i in $(seq 30); do
  for n in $(curl -sf "$URL/api/projects/mcp-notes/sessions" | jq -r '.nodes[].node_id'); do
    [ "$(curl -sf "$URL/api/sessions/$n/prompts" | jq '.prompts | length')" -gt 100 ] && BIG=$n
  done; [ -n "$BIG" ] && break; sleep 1; done; echo "BIG=$BIG"
$V api RUN GET /api/sessions/$BIG/prompts
curl -sf "$URL/api/sessions/$BIG/prompts" > "$SP/prompts.json"
jq -e '.complete == true
  and (.prompts | length) > 100
  and ([.prompts[].n] == [range(1; (.prompts | length) + 1)])
  and ([.prompts[].text | length] | max) > 2000
  and ([.prompts[].text | select(test("sk-ant-"))] | length) == 0
  and ([.prompts[].text | select(contains("[redacted]"))] | length) >= 1' "$SP/prompts.json"
$V sql RUN "select count(*) from cc_session_prompts p join cc_sessions s using (session_id) where s.node_id = '$BIG'"
```
Pass: `BIG` is non-empty; `jq -e` prints `true` and exits 0; the SQL count equals `jq '.prompts|length' "$SP/prompts.json"`.

**J2: route errors.**
```sh
$V api RUN GET /api/sessions/ZZ-ZZ/prompts
$V api RUN GET /api/sessions/A-B32/prompts
```
Pass: the first shows status 404 and body `{"error":"not_found","node_id":"ZZ-ZZ"}`; the second shows 400 and `{"error":"invalid_node_id"}`.

**J3: the wall modal (open, full list, long prompt in full, whitespace kept, redaction shown, per-prompt copy, copy-all, Esc and backdrop close only the modal, then the neighbor: Esc closes the panel).** Write `$SP/prompts-modal.mjs`:
```js
import { readFileSync } from 'node:fs'

export default async ({ page, base, shot, log }) => {
  const NODE = process.env.NODE
  const data = JSON.parse(readFileSync(process.env.PROMPTS_JSON, 'utf8'))
  await page.addInitScript(() => {
    window.__copied = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => { window.__copied.push(t) } },
    })
  })
  await page.goto(`${base}/projects?repo=mcp-notes&node=${NODE}`)
  const panel = page.locator(`aside.np[data-node="${NODE}"]`)
  const expand = panel.getByRole('region', { name: 'Prompts' }).getByRole('button', { name: 'Expand prompts' })
  await expand.click()
  const dialog = page.getByRole('dialog', { name: `Prompts of ${NODE}` })
  await dialog.waitFor()
  const items = dialog.locator('li.prm-item')
  await items.nth(data.prompts.length - 1).waitFor()
  const count = await items.count()
  if (count !== data.prompts.length || count <= 100) throw new Error(`modal lists ${count}, API has ${data.prompts.length}`)
  log(`modal lists all ${count} prompts (> 100)`)

  const longest = data.prompts.reduce((a, b) => (b.text.length > a.text.length ? b : a))
  if (longest.text.length <= 2000) throw new Error(`longest prompt is only ${longest.text.length} chars`)
  const longText = dialog.locator(`li.prm-item[data-n="${longest.n}"] .prm-text`)
  if ((await longText.textContent()) !== longest.text) throw new Error(`prompt ${longest.n} not shown in full`)
  const ws = await longText.evaluate((el) => getComputedStyle(el).whiteSpace)
  if (ws !== 'pre-wrap') throw new Error(`white-space is ${ws}`)
  log(`prompt ${longest.n} shown in full (${longest.text.length} chars), white-space ${ws}`)

  await dialog.getByText('[redacted]').first().waitFor()
  if ((await dialog.getByText('sk-ant-').count()) !== 0) throw new Error('raw sk-ant- key visible')
  log('fake key shown as [redacted], no sk-ant- text in the modal')
  await shot('prompts-modal')

  await dialog.getByRole('button', { name: 'Copy prompt 1', exact: true }).click()
  let copied = await page.evaluate(() => window.__copied.at(-1))
  if (copied !== data.prompts[0].text) throw new Error('Copy prompt 1 copied something else')
  await dialog.getByRole('button', { name: 'Copy prompt 1', exact: true }).and(page.locator('[data-tip="Copied"]')).waitFor()
  log('Copy prompt 1 copied prompt 1 exactly, check-mark tip shown')

  await dialog.getByRole('button', { name: 'Copy all prompts' }).click()
  copied = await page.evaluate(() => window.__copied.at(-1))
  const expected = data.prompts.map((p) => `${p.n}. ${p.text}`).join('\n\n')
  if (copied !== expected) throw new Error('Copy all prompts copied something else')
  log(`Copy all prompts copied ${expected.length} chars in the "1. <text>\\n\\n2. <text>" shape`)

  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached' })
  await panel.waitFor()
  if (!page.url().includes(`node=${NODE}`)) throw new Error('Esc cleared the node selection')
  log('Esc closed only the modal; panel and ?node= stay')

  await expand.click()
  await dialog.waitFor()
  await page.locator('[data-modal="prompts"]').dispatchEvent('click')
  await dialog.waitFor({ state: 'detached' })
  await panel.waitFor()
  log('backdrop click closed only the modal')

  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  log('neighbor: Esc with no modal still closes the node panel')
}
```
Run:
```sh
NODE=$BIG PROMPTS_JSON="$SP/prompts.json" $V ui RUN "$SP/prompts-modal.mjs"
$V note RUN "Expand prompts: API complete list (J1), errors (J2), modal + copy + Esc/backdrop (J3)"
$V down RUN
```
Pass: the ui transcript ends `result: PASS`, with each `log` line above present and no `console.error`/`pageerror` line. The `prompts-modal` screenshot shows the modal over the projects page.

- Neighbor check: the existing node panel Esc behavior (ProjectsPage clears `?node=` on Esc), driven by the last step of J3 and asserted in `NodePanel.test.tsx` ("the next Esc reaches the page"). The chat node pop-up's Esc order (editor, prompts modal, pop-up) is covered by `NodeModal.test.tsx`.

**Exit criteria:** typecheck, `npm test` and `npm run test:int` are green. A `prompts_version` 1 row (transcript pruned) answers `complete: false, incomplete_reason: 'transcript_pruned'` and a version 0 row `complete: false, incomplete_reason: 'not_backfilled'` (int test), each with its own modal line (jsdom). `GET /api/sessions/<fixture>/prompts` returns `complete: true` with more than 100 prompts numbered 1..N, one over 2000 chars, `[redacted]` present and no `sk-ant-`. The wall modal lists all of them, copy buttons copy exactly the shown text (copy-all in the `N. text` + blank-line shape), and Esc or the backdrop closes only the modal. `features/projects.md` lists Expand prompts.

## Handoffs

- Phase 3 (confirmed by the reconciler): `upsertFromTranscript` sets `prompts_version = PROMPTS_VERSION` (2) on the from-offset-0 write that ingests the fixture at `up`, so J1 does not wait on the backfill. Rows redacted in place sit at `PROMPTS_VERSION_EXCERPTS` (1) and are served as `transcript_pruned`.
- Phase 4 (confirmed by the reconciler): `.np-sec-head > .ibtn` is in Phase 4's Step 3, so this phase adds no NodePanel CSS.
- Not done (no requirement asks for it): NodeModal's Esc guard list (`isEditorOpen || isLightboxOpen || isConfirmOpen || isPromptsOpen`) grows by one with each new modal. A single "any foreign modal open" check (`[data-modal]:not([data-modal="node"]), [data-lightbox]`) would remove that footgun. It is left as a follow-up card, not this phase's scope.
- Landing (set level, not this phase): rebuild and restart the live daemon after the set merges, per the plan index.

## Rollback

Revert this phase's commit. The change is read path plus UI only: no migration, no writer, and no data touched. Phases 1–4 keep working, and the panel goes back to its excerpt list without the expand button.
