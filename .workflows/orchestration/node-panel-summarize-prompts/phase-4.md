# Phase 4: Node panel Summary: reason labels + Summarize button

**Plan set:** `NODE_PANEL_SUMMARIZE_PROMPTS_PLAN.md`
**Analysis:** `docs/analyzer/20261103-150033-K7Q2_code_analyzer.md`
**Satisfies:** R1, the node panel's Summary section says why a session has no summary and offers an icon-only "Summarize" button that records a request
**Depends on:** Phase 2 (detail carries `summary_state` / `summary_requested_at`; `POST /api/sessions/:nodeId/summarize` exists)
**Difficulty:** NORMAL
**Package:** `web/`

---

## Goal

The node panel's Summary section no longer says a bare "No summary yet". It names the reason ("Empty session", "Summarizes once idle", "Summary requested", "Will be summarized on <host>") and, where a summary can still be made, shows an icon-only Phosphor `MagicWand` button (aria-label "Summarize") that POSTs a request and flips the label to "Summary requested" straight away. When the owning host's worker writes the summary, the panel picks it up through the graph poll it already has: the refresh stamp now also changes when the graph node gains a summary.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:**
- `SummaryState` type (`'ready' | 'empty' | 'requested' | 'idle_wait' | 'other_host'`), `SummaryRequest` interface, `requestSummary(nodeId)`, `summarizeErrorNotice(err, d)` (`web/src/sessionDetailApi.ts`)
- `SessionDetail.summary_state: SummaryState | null`, `SessionDetail.summary_requested_at: string | null` (`web/src/sessionDetailApi.ts`)
- `SubtreeNode.summarized: boolean` and `GraphLikeNode.summary_excerpt?: string | null` (`web/src/lib/subtree.ts`)
- `SummaryLine` component (file-local, `web/src/components/graph/NodePanel.tsx`)
- CSS rule `.np-sec-head > .ibtn` (`web/src/components/graph/NodePanel.css`), sized like `.np-toggle .ibtn`; phase 5's "Expand prompts" header button gets it for free
**Signature changes:** none (new fields only; `normalizeSessionDetail` returns the two extra fields)
**Requires (from earlier phases):**
- Phase 2: `GET /api/sessions/:nodeId` returns `session.summary_state` (one of the five strings) and `session.summary_requested_at` (ISO or null)
- Phase 2: `POST /api/sessions/:nodeId/summarize` (same-origin) -> 200 `{node_id, summary_state, summary_requested_at}`, 409 `{error:'empty_session'}`, 404 `{error:'not_found'}`, 400 `{error:'invalid_node_id'}`
- Phase 2: `summary_requested_at` is persisted in `cc_sessions` (Phase 1 column) and survives a reload
**Leaves alone (owned by others):**
- NodePanel's Prompts section, `PROMPTS_SHOWN`, `PromptsModal.tsx`, `web/src/hooks/useCopied.ts` (Phase 5)
- `fetchSessionPrompts` in `sessionDetailApi.ts` (Phase 5 adds it after this phase)
- every server file (`src/**`), fixtures (Phases 1-3)

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/sessionDetailApi.ts` | modify | `SummaryState` type, two `SessionDetail` fields (after L52), normalisation (L167-205), `requestSummary` + `summarizeErrorNotice` (after L256) |
| `web/src/lib/subtree.ts` | modify | `SubtreeNode.summarized` (L4-13), `GraphLikeNode.summary_excerpt` (L25-38), `toSubtreeNodes` fills it (L40-53) |
| `web/src/components/graph/NodePanel.tsx` | modify | imports (L3, L11), stamp (L71-74), fallback row (L101-112), `patchDetail` + `summarize` (after L127), Summary section (L238-241), `SummaryLine` (after `ParentLine`, L432) |
| `web/src/components/graph/NodePanel.css` | modify | `.np-sec-head > .ibtn` after L28 |
| `web/src/sessionDetailApi.test.tsx` | modify | normalisation, `requestSummary`, `summarizeErrorNotice` tests |
| `web/src/lib/subtree.test.tsx` | modify | helper gets `summarized: false`; `toSubtreeNodes` test asserts `summarized` |
| `web/src/components/graph/NodePanel.test.tsx` | modify | helper gets `summarized: false`; stub routes POST by URL; Summary label/button/refresh tests |
| `.claude/skills/verify-notesd/features/projects.md` | modify | replaces Phase 2's "Summary on demand" bullet and its Gotcha line with merged API + UI versions; UI block after Phase 2's driving block |

## Implementation Steps

### Step 1: Summary state and the request call in the detail API
**File:** `web/src/sessionDetailApi.ts:35-66`, `:167-205`, after `:256`
**Change:** Normalise the two new wire fields once, at the boundary, so the component never sees a contradiction: a non-null `summary` always means `'ready'`, and `'ready'` without a summary becomes `null` (shown as the old "No summary yet"). An unknown or missing state (older daemon, tests) is `null`. Add the POST and its error text next to `resumeSession` / `resumeErrorNotice`.

1a. After the imports/constants block (insert after L6, `export type ParentLinkSource ...`):
```ts
/** Phase 2's server-computed reason for the Summary section. */
export type SummaryState = 'ready' | 'empty' | 'requested' | 'idle_wait' | 'other_host';

const SUMMARY_STATES: readonly SummaryState[] = ['ready', 'empty', 'requested', 'idle_wait', 'other_host'];
```

1b. In `interface SessionDetail`, replace L52 (`summary: string | null;`) with:
```ts
  summary: string | null;
  /**
   * Why there is (no) summary. Always 'ready' when `summary` is set, never 'ready' without one.
   * Null: the daemon did not say (older daemon); the panel then shows "No summary yet".
   */
  summary_state: SummaryState | null;
  /** When someone pressed Summarize and the owning host has not served it yet. */
  summary_requested_at: string | null;
```

1c. After `interface ResumeResult` (L75-78) add:
```ts
/** `POST /api/sessions/:nodeId/summarize`'s answer. */
export interface SummaryRequest {
  summary_state: SummaryState;
  summary_requested_at: string | null;
}
```

1d. After `function str(...)` (L99-101) add:
```ts
function summaryState(v: unknown): SummaryState | null {
  return typeof v === 'string' && (SUMMARY_STATES as readonly string[]).includes(v) ? (v as SummaryState) : null;
}
```

1e. Replace `normalizeSessionDetail` (L167-205) with:
```ts
export function normalizeSessionDetail(raw: Wire): SessionDetail {
  const w = isObj(raw.session) ? raw.session : raw;
  const t = isObj(w.tokens) ? w.tokens : null;
  const parentObj = isObj(raw.parent) ? raw.parent : isObj(w.parent) ? w.parent : null;
  const parentId = str(parentObj?.node_id) ?? str(w.parent_node_id);
  const src = w.parent_link_source;
  const summary = str(w.summary);
  const state = summaryState(w.summary_state);
  return {
    session_id: str(w.session_id) ?? '',
    node_id: str(w.node_id) ?? '',
    repo: str(w.repo),
    host: str(w.host) ?? '',
    available: w.available !== false,
    live: w.live === true,
    unfinished: typeof w.unfinished === 'boolean' ? w.unfinished : null,
    cwd: str(w.cwd),
    branch: str(w.branch),
    name: str(w.name),
    title: str(w.custom_title) ?? str(w.ai_title) ?? str(w.title),
    started_at: str(w.started_at),
    last_active_at: str(w.last_active_at),
    summary,
    summary_state: summary !== null ? 'ready' : state === 'ready' ? null : state,
    summary_requested_at: str(w.summary_requested_at),
    prompts: compact(list(raw.prompts ?? w.prompts).map(prompt)),
    commits: compact(list(raw.commits ?? w.commits).map(commit)),
    notes: compact(list(raw.notes ?? w.notes).map(noteRef)),
    tokens: {
      input: num(t ? t.input : w.input_tokens),
      output: num(t ? t.output : w.output_tokens),
      cache_read: num(t ? t.cache_read : w.cache_read_tokens),
      cache_write: num(t ? t.cache_write : w.cache_write_tokens),
    },
    cost_usd: numOrNull(w.cost_usd),
    cost_estimated: w.cost_estimated === true,
    subagent_count: num(w.subagent_count),
    subagent_cost_usd: numOrNull(w.subagent_cost_usd),
    parent: parentId === null ? null : { node_id: parentId, name: str(parentObj?.title) ?? str(parentObj?.name) },
    parent_link_source: src === 'env' || src === 'hook' || src === 'heuristic' ? src : null,
    transcript_path: str(w.transcript_path),
  };
}
```

1f. Append at the end of the file (after `resumeErrorNotice`, L256):
```ts
/**
 * Phase 2: `POST /api/sessions/:nodeId/summarize` records a summary request (the owning host's worker
 * serves it; no model call happens in the request). Idempotent. Throws `ApiError`
 * (`empty_session` 409, `not_found` 404, 403 from the same-origin guard, ...).
 */
export async function requestSummary(nodeId: string): Promise<SummaryRequest> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/summarize`, { method: 'POST' });
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  const o = isObj(j) ? j : {};
  // A 200 means the request is recorded; a state this build does not know still reads as requested.
  return { summary_state: summaryState(o.summary_state) ?? 'requested', summary_requested_at: str(o.summary_requested_at) };
}

/** The panel's one-line report of a failed Summarize. */
export function summarizeErrorNotice(err: unknown, d: Pick<SessionDetail, 'node_id'>): string {
  if (err instanceof ApiError) {
    if (err.message === 'empty_session') return `${d.node_id} is an empty session, nothing to summarize`;
    if (err.status === 403) return 'Summarize only works from the wall on this machine';
    if (err.status === 404) return `No session ${d.node_id}`;
    return `Could not request a summary of ${d.node_id}: ${err.message}`;
  }
  return `Could not request a summary of ${d.node_id}`;
}
```
**Impact:** `SessionDetail` gains two required fields. The only constructor is `normalizeSessionDetail` (checked: `grep -rn "SessionDetail = {\|: SessionDetail = " web/src` finds no object literals; tests build details through the wire). Phase 5 later appends `fetchSessionPrompts` to this file.

### Step 2: Carry "has a summary" onto the panel's graph nodes
**File:** `web/src/lib/subtree.ts:4-13`, `:25-38`, `:40-53`
**Change:** The panel's refresh key comes from `SubtreeNode`. The graph payload already carries `summary_excerpt`, and the graph poll's ETag covers it, so a landed summary changes the polled nodes. Expose that as a boolean.

Replace L4-13:
```ts
export interface SubtreeNode {
  node_id: string;
  parent: string | null;
  label: string;
  started_at: string | null;
  last_active_at: string | null;
  live: boolean;
  available: boolean;
  host: string | null;
  /** The graph has a summary for it. The node panel refetches its detail when this flips. */
  summarized: boolean;
}
```
In `GraphLikeNode` (L25-38), add after `host?: string | null;`:
```ts
  summary_excerpt?: string | null;
```
Replace `toSubtreeNodes` (L40-53):
```ts
export function toSubtreeNodes(nodes: readonly GraphLikeNode[]): SubtreeNode[] {
  const bySession = new Map<string, string>();
  for (const n of nodes) if (n.session_id) bySession.set(n.session_id, n.node_id);
  return nodes.map((n) => ({
    node_id: n.node_id,
    parent: n.parent_node_id ?? (n.parent_session_id ? bySession.get(n.parent_session_id) ?? null : null),
    label: n.name ?? n.custom_title ?? n.ai_title ?? '',
    started_at: n.started_at ?? null,
    last_active_at: n.last_active_at ?? null,
    live: n.live === true,
    available: n.available !== false,
    host: n.host ?? null,
    summarized: typeof n.summary_excerpt === 'string' && n.summary_excerpt.trim() !== '',
  }));
}
```
**Impact:** `SubtreeNode` / `SubtreeRow` literals must set `summarized`: NodePanel's fallback row (Step 4) and the two test helpers (Steps 6, 7). `SessionNode` (`web/src/types.ts:235`, `summary_excerpt: string | null`) stays assignable to `GraphLikeNode`. `NodeModal.tsx:34` and `ProjectsPage.tsx:105` call `toSubtreeNodes` unchanged and both get the new refresh.

### Step 3: Header button size
**File:** `web/src/components/graph/NodePanel.css:28` (after `.np-sec-head { ... }`)
**Change:** add one rule so a lone icon button in a section header matches the Tree/Timeline toggle:
```css
.np-sec-head > .ibtn { width: 32px; height: 32px; font-size: 17px; }
```

### Step 4: NodePanel: refresh stamp, request handler, imports
**File:** `web/src/components/graph/NodePanel.tsx`

4a. L3, replace the icon import:
```ts
import { ChartBarHorizontal, Check, CloudSlash, Copy, Graph, LinkSimple, MagicWand, Play, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
```
4b. L11, replace the detail-API import and add `ApiError` above it:
```ts
import { ApiError } from '../../api';
import {
  fetchSessionDetail,
  requestSummary,
  resumeErrorNotice,
  resumeNotice,
  resumeSession,
  summarizeErrorNotice,
  type SessionDetail,
  type SummaryRequest,
} from '../../sessionDetailApi';
```
4c. Replace the stamp (L71-74). Decision: refresh off the graph poll, not a second detail poll. The user asked for the "existing refresh/SSE path"; the graph already polls every 10 s with an ETag over `summary_excerpt`, so this costs no new request. The summary appearing is the only transition that needs a refetch (the request itself is applied locally from the POST answer). A request the worker drops without a summary (null summary input) leaves "Summary requested" until the node is reopened or becomes active; that is acceptable and noted in Handoffs.
```ts
  const stamp = useMemo(() => {
    const k = idKey(nodeId);
    const n = nodes.find((x) => idKey(x.node_id) === k);
    return n ? `${n.last_active_at ?? ''}|${n.summarized ? 'summarized' : ''}` : '';
  }, [nodes, nodeId]);
```
4d. In the fallback row (L101-112) add `summarized` after `host`:
```ts
    return [
      {
        node_id: detail.node_id,
        parent: detail.parent?.node_id ?? null,
        label: detail.name ?? detail.title ?? '',
        started_at: detail.started_at,
        last_active_at: detail.last_active_at,
        live: detail.live,
        available: detail.available,
        host: detail.host || null,
        summarized: detail.summary !== null,
        depth: 0,
      },
    ];
```
4e. After `run` (ends L127), add:
```ts
  /** Apply a summary-state change to the loaded detail, if that node is still the one shown. */
  const patchDetail = (key: string, patch: SummaryRequest | Pick<SessionDetail, 'summary_state' | 'summary_requested_at'>): void => {
    setLoad((prev) => (prev.state === 'ready' && idKey(prev.detail.node_id) === key ? { state: 'ready', detail: { ...prev.detail, ...patch } } : prev));
  };

  // Optimistic: the label flips to "Summary requested" (and the button goes) before the POST answers.
  const summarize = async (d: SessionDetail): Promise<void> => {
    const key = idKey(d.node_id);
    const before = { summary_state: d.summary_state, summary_requested_at: d.summary_requested_at };
    setNotice(null);
    patchDetail(key, { summary_state: 'requested', summary_requested_at: new Date().toISOString() });
    try {
      patchDetail(key, await requestSummary(d.node_id));
    } catch (e) {
      const empty = e instanceof ApiError && e.message === 'empty_session';
      patchDetail(key, empty ? { summary_state: 'empty', summary_requested_at: null } : before);
      if (currentKey.current === key) setNotice(summarizeErrorNotice(e, d));
    }
  };
```

### Step 5: NodePanel: the Summary section
**File:** `web/src/components/graph/NodePanel.tsx:238-241` (Summary section) and after `ParentLine` (L413-432)
**Change:** Replace the section:
```tsx
          <section className="np-sec" aria-label="Summary">
            <div className="np-sec-head">
              <h3>Summary</h3>
              {detail.summary === null && detail.summary_state !== 'empty' && detail.summary_state !== 'requested' && (
                <button
                  type="button"
                  className="ibtn hov"
                  data-tip="Summarize"
                  aria-label="Summarize"
                  onClick={() => void summarize(detail)}
                >
                  <MagicWand weight="duotone" />
                </button>
              )}
            </div>
            {detail.summary ? <p className="np-summary">{detail.summary}</p> : <SummaryLine detail={detail} />}
          </section>
```
Append after `ParentLine` at the end of the file:
```tsx
/** The Summary section's line when there is no summary: the reason, from phase 2's `summary_state`. */
function SummaryLine({ detail }: { detail: SessionDetail }) {
  const where = placeLabel(detail.host);
  switch (detail.summary_state) {
    case 'empty':
      return <p className="np-dim">Empty session</p>;
    case 'requested':
      return (
        <p className="np-dim" data-tip={detail.available ? undefined : `${where} summarizes it the next time its daemon runs`}>
          Summary requested
        </p>
      );
    case 'other_host':
      return <p className="np-dim">{`Will be summarized on ${where}`}</p>;
    case 'idle_wait':
      return <p className="np-dim">Summarizes once idle</p>;
    default:
      return <p className="np-dim">No summary yet</p>;
  }
}
```
The `other_host` line is one template string so the whole label is a single text node (`getByText('Will be summarized on GPD')` matches it).
**Impact:** "No summary yet" stays only for a null state. The button is icon-only (`MagicWand`, distinct from the header's `Sparkle` "Spawn fresh"), `weight="duotone"`, `className="ibtn hov"`, `data-tip` + `aria-label` "Summarize". It shows on any host when there is no summary and the state is not `empty`/`requested`, including `null` (the web bundle ships with its own daemon, so a null state only comes from a mismatched build; the POST then reports its error on the notice line).

### Step 6: Tests: detail API
**File:** `web/src/sessionDetailApi.test.tsx`
**Change:** extend the import (L4) and add three describes at the end of the file.
L4:
```ts
import {
  fetchSessionDetail,
  normalizeSessionDetail,
  requestSummary,
  resumeErrorNotice,
  resumeNotice,
  resumeSession,
  summarizeErrorNotice,
} from './sessionDetailApi';
```
Append:
```ts
describe('summary state', () => {
  it('reads summary_state and summary_requested_at from the session object', () => {
    const d = normalizeSessionDetail({
      session: { node_id: 'A0-3G', host: 'GPD', summary: null, summary_state: 'requested', summary_requested_at: '2026-11-03T08:00:00.000Z' },
    });
    expect(d.summary_state).toBe('requested');
    expect(d.summary_requested_at).toBe('2026-11-03T08:00:00.000Z');
  });

  it('is ready whenever there is a summary, and never ready without one', () => {
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary: 'Did it.', summary_state: 'idle_wait' }).summary_state).toBe('ready');
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary: 'Did it.' }).summary_state).toBe('ready');
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary: null, summary_state: 'ready' }).summary_state).toBeNull();
  });

  it('is null for a missing or unknown state (older daemon)', () => {
    const old = normalizeSessionDetail({ node_id: 'A0-3G' });
    expect(old.summary_state).toBeNull();
    expect(old.summary_requested_at).toBeNull();
    expect(normalizeSessionDetail({ node_id: 'A0-3G', summary_state: 'queued' }).summary_state).toBeNull();
    for (const s of ['empty', 'requested', 'idle_wait', 'other_host'] as const) {
      expect(normalizeSessionDetail({ node_id: 'A0-3G', summary_state: s }).summary_state).toBe(s);
    }
  });
});

describe('requestSummary', () => {
  it('POSTs to the node and returns the recorded state', async () => {
    const seen = stub(200, { node_id: 'A0-3G', summary_state: 'requested', summary_requested_at: '2026-11-03T08:00:00.000Z' });
    expect(await requestSummary('A0-3G')).toEqual({ summary_state: 'requested', summary_requested_at: '2026-11-03T08:00:00.000Z' });
    expect(seen).toEqual([{ url: '/api/sessions/A0-3G/summarize', method: 'POST', body: null }]);
  });

  it('reads an unknown state in a 200 as requested', async () => {
    stub(200, { node_id: 'A0-3G' });
    expect(await requestSummary('A0-3G')).toEqual({ summary_state: 'requested', summary_requested_at: null });
  });

  it('throws the error code as an ApiError', async () => {
    stub(409, { error: 'empty_session' });
    const err = await requestSummary('A0-3G').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'empty_session' });
  });
});

describe('summarizeErrorNotice', () => {
  it('explains failures', () => {
    const d = { node_id: 'A0-3G' };
    expect(summarizeErrorNotice(new ApiError(409, 'empty_session'), d)).toBe('A0-3G is an empty session, nothing to summarize');
    expect(summarizeErrorNotice(new ApiError(403, 'forbidden'), d)).toBe('Summarize only works from the wall on this machine');
    expect(summarizeErrorNotice(new ApiError(404, 'not_found'), d)).toBe('No session A0-3G');
    expect(summarizeErrorNotice(new ApiError(500, 'boom'), d)).toBe('Could not request a summary of A0-3G: boom');
    expect(summarizeErrorNotice(new Error('x'), d)).toBe('Could not request a summary of A0-3G');
  });
});
```

### Step 7: Tests: subtree
**File:** `web/src/lib/subtree.test.tsx:5-15` and the `toSubtreeNodes` case (L19-34)
**Change:** the `node` helper gains `summarized: false` before `...over`:
```ts
const node = (node_id: string, parent: string | null, over: Partial<SubtreeNode> = {}): SubtreeNode => ({
  node_id,
  parent,
  label: `s-${node_id}`,
  started_at: null,
  last_active_at: null,
  live: false,
  available: true,
  host: 'lenovo',
  summarized: false,
  ...over,
});
```
(Keep any further fields the current helper has after `host`; the read at L5-15 shows exactly these.)
Add a case inside `describe('toSubtreeNodes', ...)`:
```ts
  it('marks a node summarized when the graph carries a summary excerpt', () => {
    const out = toSubtreeNodes([
      { node_id: 'A0-00', summary_excerpt: 'Did the thing.' },
      { node_id: 'B1-11', summary_excerpt: null },
      { node_id: 'C2-22' },
      { node_id: 'D3-33', summary_excerpt: '  ' },
    ]);
    expect(out.map((n) => n.summarized)).toEqual([true, false, false, false]);
  });
```

### Step 8: Tests: NodePanel
**File:** `web/src/components/graph/NodePanel.test.tsx`
8a. L38-48 helper gains `summarized: false`:
```ts
const n = (node_id: string, parent: string | null, over: Partial<SubtreeNode> = {}): SubtreeNode => ({
  node_id,
  parent,
  label: `s-${node_id}`,
  started_at: '2026-11-01T01:00:00.000Z',
  last_active_at: '2026-11-01T02:00:00.000Z',
  live: false,
  available: true,
  host: 'lenovo',
  summarized: false,
  ...over,
});
```
8b. Replace `stubFetch` (L66-78) so a POST answers by route; existing callers keep their two-argument form:
```ts
interface Reply {
  status: number;
  body: unknown;
}

const REQUESTED: Reply = { status: 200, body: { node_id: 'A0-3G', summary_state: 'requested', summary_requested_at: '2026-11-01T04:00:00.000Z' } };

function stubFetch(detail: unknown, resume: Reply = { status: 200, body: { action: 'resumed', window: 'note:4' } }, summarize: Reply = REQUESTED): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'POST') {
        const r = url.endsWith('/summarize') ? summarize : resume;
        return json(r.status, r.body);
      }
      return detail === null ? json(404, { error: 'not_found' }) : json(200, detail);
    }),
  );
  return calls;
}
```
8c. After `const posts = ...` (L80) add:
```ts
const UNSUMMARIZED = { ...WIRE, summary: null };

const summarySection = () => screen.getByRole('region', { name: 'Summary' });
```
8d. Append a new describe at the end of the file:
```tsx
describe('NodePanel summary', () => {
  it.each([
    ['empty', 'lenovo', true, 'Empty session'],
    ['idle_wait', 'lenovo', true, 'Summarizes once idle'],
    ['requested', 'lenovo', true, 'Summary requested'],
    ['other_host', 'GPD', false, 'Will be summarized on GPD'],
    [undefined, 'lenovo', true, 'No summary yet'],
  ])('says why there is no summary (state %s)', async (summary_state, host, available, label) => {
    stubFetch({ ...UNSUMMARIZED, summary_state, host, available });
    renderPanel();
    await screen.findByRole('region', { name: 'Summary' });
    expect(within(summarySection()).getByText(label)).toBeTruthy();
    if (label !== 'No summary yet') expect(within(summarySection()).queryByText('No summary yet')).toBeNull();
  });

  it.each([
    ['idle_wait', true],
    ['other_host', true],
    [undefined, true],
    ['empty', false],
    ['requested', false],
  ])('offers Summarize only where a summary can still be made (state %s)', async (summary_state, shown) => {
    stubFetch({ ...UNSUMMARIZED, summary_state });
    renderPanel();
    await screen.findByRole('region', { name: 'Summary' });
    expect(within(summarySection()).queryByRole('button', { name: 'Summarize' }) !== null).toBe(shown);
  });

  it('offers no Summarize when there is a summary', async () => {
    stubFetch({ ...WIRE, summary_state: 'ready' });
    renderPanel();
    await screen.findByText('Orchestrated the wall editing phases.');
    expect(screen.queryByRole('button', { name: 'Summarize' })).toBeNull();
  });

  it('names the host in the tooltip of a request for another machine', async () => {
    stubFetch({ ...UNSUMMARIZED, summary_state: 'requested', host: 'GPD', available: false });
    renderPanel();
    const line = await screen.findByText('Summary requested');
    expect(line.getAttribute('data-tip')).toContain('GPD');
  });

  it('posts once on click and flips the label to Summary requested', async () => {
    const calls = stubFetch({ ...UNSUMMARIZED, summary_state: 'idle_wait' });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(within(summarySection()).getByText('Summary requested')).toBeTruthy();
    expect(within(summarySection()).queryByRole('button', { name: 'Summarize' })).toBeNull();
    await waitFor(() => expect(posts(calls)).toEqual([{ url: '/api/sessions/A0-3G/summarize', method: 'POST', body: null }]));
    expect(within(summarySection()).getByText('Summary requested')).toBeTruthy();
  });

  it('puts the label back and reports a failed request on the notice line', async () => {
    stubFetch({ ...UNSUMMARIZED, summary_state: 'idle_wait' }, undefined, { status: 500, body: { error: 'boom' } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('Could not request a summary of A0-3G: boom')).toBeTruthy();
    expect(within(summarySection()).getByText('Summarizes once idle')).toBeTruthy();
    expect(within(summarySection()).getByRole('button', { name: 'Summarize' })).toBeTruthy();
  });

  it('turns an empty_session answer into Empty session, without the button', async () => {
    stubFetch({ ...UNSUMMARIZED, summary_state: 'idle_wait' }, undefined, { status: 409, body: { error: 'empty_session' } });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('A0-3G is an empty session, nothing to summarize')).toBeTruthy();
    expect(within(summarySection()).getByText('Empty session')).toBeTruthy();
    expect(within(summarySection()).queryByRole('button', { name: 'Summarize' })).toBeNull();
  });

  it('refetches and shows the summary when the graph reports one for the node', async () => {
    const first = stubFetch({ ...UNSUMMARIZED, summary_state: 'requested' });
    const { rerender, props } = renderPanel();
    expect(await screen.findByText('Summary requested')).toBeTruthy();
    expect(first.filter((c) => c.method === 'GET')).toHaveLength(1);
    const second = stubFetch({ ...WIRE, summary_state: 'ready' });
    rerender(<NodePanel {...props} nodes={NODES.map((x) => ({ ...x }))} />);
    expect(second).toHaveLength(0);
    const summarized = NODES.map((x) => (x.node_id === 'A0-3G' ? { ...x, summarized: true } : x));
    rerender(<NodePanel {...props} nodes={summarized} />);
    expect(await screen.findByText('Orchestrated the wall editing phases.')).toBeTruthy();
    expect(second.filter((c) => c.method === 'GET')).toHaveLength(1);
    expect(screen.queryByText('Summary requested')).toBeNull();
  });
});
```
Note on the `second` length-0 assertion: the rerender with structurally equal nodes keeps the same stamp string, so the effect does not run; check it synchronously right after `rerender` (React flushes effects inside `rerender`'s `act`).

### Step 9: Feature map
**File:** `.claude/skills/verify-notesd/features/projects.md`, as Phase 2 leaves it. Phase 2 already added the "Summary on demand (R1)" Sub-features bullet (API half), a "Summary requests." driving block before `## Gotchas`, and one Gotcha line ("Do not prove \"the worker serves a request\" on a run with a real `claude` binary …"). This phase owns the merged entry: it replaces Phase 2's bullet and Gotcha line rather than adding second copies, and adds a UI block after Phase 2's driving block.
**Change:**
9a. In `## Sub-features`, replace Phase 2's whole "- Summary on demand (R1). Session detail carries `summary_state` …" bullet with:
```markdown
- Summary on demand (R1, node panel section "Summary"). With no summary the section says why:
  "Empty session" (0 tokens), "Summarizes once idle" (this machine, waiting for 15 min idle),
  "Summary requested", "Will be summarized on <host>" (another machine), or "No summary yet"
  (older daemon). Where a summary can still be made (not empty, not already requested) an
  icon-only button "Summarize" records a request; the label flips to "Summary requested" at once
  and survives a reload (`cc_sessions.summary_requested_at`). API: session detail carries
  `summary_state` (`ready` | `empty` | `requested` | `idle_wait` | `other_host`) and
  `summary_requested_at`; same-origin `POST /api/sessions/:nodeId/summarize` answers 200
  `{ node_id, summary_state, summary_requested_at }`, idempotent; 409 `empty_session` for a
  0-token session; 403 `forbidden_origin` without the page's Origin; a summarized node answers
  `ready` and records nothing. It never calls the model: the summary worker on the host that owns
  the session serves requests first on its next sweep (within 60 s), live sessions included, and
  the request clears when the summary is saved; the panel shows the summary when the graph poll
  sees it.
```
9b. Directly after Phase 2's "Summary requests." driving block (still before `## Gotchas`), add a block:
````markdown
Summarize in the wall. Start the run with the summarizer off, so nothing summarizes the fixtures
behind the check (and nothing bills): `NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --web`
(real env wins over `.env.local`; `daemon.log` then says `session summaries off`). Pick a node
with tokens and no summary, read its state, drive the click, read the row back:
```sh
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '[.nodes[] | select(.summary_excerpt == null and (.tokens.input + .tokens.output + .tokens.cache_read + .tokens.cache_write) > 0)][0].node_id' <<<"$S")
curl -sf "$URL/api/sessions/$NODE" | jq -r '.session.summary_state'        # idle_wait
NODE=$NODE $V ui RUN summarize-steps.mjs
curl -sf "$URL/api/sessions/$NODE" | jq -r '.session.summary_state'        # requested
$V sql RUN "select node_id, summary_requested_at from cc_sessions where node_id = '$NODE'"   # timestamp, not null
```
UI selectors: panel `page.locator('aside.np[data-node="' + NODE + '"]')`; section
`.getByRole('region', { name: 'Summary' })`; button `.getByRole('button', { name: 'Summarize' })`;
labels by text (`'Summarizes once idle'`, `'Summary requested'`, `'Empty session'`,
`'Will be summarized on GPD'`).
````
9c. In `## Gotchas`, replace Phase 2's line "- Do not prove \"the worker serves a request\" on a run with a real `claude` binary: …" (two lines) with:
```markdown
- The verify daemon finds the real `claude` binary unless `NOTESD_CLAUDE_BIN` points nowhere; then
  its summary worker runs Haiku on the fixtures (billed, nondeterministic). Assert the request
  (label, `summary_state`, `summary_requested_at`), never the Haiku output. "The worker serves a
  request" is proven by `tests/unit/sessions/summaryWorker.test.ts` and
  `tests/integration/sessions.summaries.int.test.ts`; "Empty session" and "Will be summarized on
  <host>" need a 0-token row and a row of another host, which the fixtures do not have: cover them
  in `tests/integration/sessions.api.int.test.ts` and the jsdom tests, not on a run.
```

## Principles applied

- Boundary discipline: `summary_state` is validated once in `normalizeSessionDetail` / `requestSummary` (unknown strings -> `null` or `'requested'`); NodePanel switches on the typed value and never re-checks wire strings.
- Make illegal states unrepresentable: the normaliser forces `'ready'` iff `summary` is set, so "summary shown but state says requested" or "state ready, no summary" cannot reach the component; the button condition is then just `summary === null && state not in {empty, requested}`.
- Laziness protocol: the refresh rides the existing 10 s graph poll (one boolean added to `SubtreeNode`, stamp string widened) instead of a second per-panel detail poll; the request's own result is patched locally from the POST answer, no refetch.
- Test behavior, not implementation: tests assert visible labels, button presence, the POST on the wire and the refetch count, not internal state or `patchDetail` calls.
- Prove it works: the Proof drives the real button in the wall against a throwaway daemon and reads `cc_sessions.summary_requested_at` back with `$V sql`, with the summarizer pinned off so the check is deterministic.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/node-panel-summarize-prompts && npm ci && npm run typecheck`
**Tests:** `npx vitest run web/src/sessionDetailApi.test.tsx web/src/lib/subtree.test.tsx web/src/components/graph/NodePanel.test.tsx web/src/components/graph/NodeModal.test.tsx` then `npm test`
**Proof:**
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree root, with Phase 2 landed)
- Feature-map entries: `.claude/skills/verify-notesd/features/projects.md`
- Journeys:
  1. **Launch, summarizer off.**
     `NOTESD_CLAUDE_BIN=/nonexistent/claude $V up --sessions --web` -> prints `RUN=...`, `URL=...`.
     Pass: `grep -q 'session summaries off' ~/.local/state/notesd-verify/$RUN/daemon.log`, and `$V doctor $RUN` shows no FAIL.
  2. **The reason label before any click.**
     ```sh
     S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
     NODE=$(jq -r '[.nodes[] | select(.summary_excerpt == null and (.tokens.input + .tokens.output + .tokens.cache_read + .tokens.cache_write) > 0)][0].node_id' <<<"$S")
     curl -sf "$URL/api/sessions/$NODE" | jq -r '.session.summary_state, .session.summary_requested_at'
     ```
     Pass: `NODE` is a node id (not `null`); output is `idle_wait` then `null`.
  3. **Click Summarize in the wall; label flips and survives reload.** Write `summarize-steps.mjs` in the scratchpad:
     ```js
     export default async ({ page, base, shot, log }) => {
       const NODE = process.env.NODE
       const summary = () => page.locator('aside.np[data-node="' + NODE + '"]').getByRole('region', { name: 'Summary' })
       await page.goto(base + '/projects?repo=mcp-notes&node=' + NODE)
       await summary().getByText('Summarizes once idle').waitFor()
       await shot('summary-before')
       await summary().getByRole('button', { name: 'Summarize' }).click()
       await summary().getByText('Summary requested').waitFor()
       if ((await summary().getByRole('button', { name: 'Summarize' }).count()) !== 0) throw new Error('Summarize still offered after the request')
       await page.reload()
       await summary().getByText('Summary requested').waitFor()
       if ((await summary().getByRole('button', { name: 'Summarize' }).count()) !== 0) throw new Error('Summarize offered again after reload')
       await shot('summary-requested-after-reload')
       log('Summarize recorded a request; label is "Summary requested" after reload, button gone')
     }
     ```
     Run `NODE=$NODE $V ui RUN <scratchpad>/summarize-steps.mjs`. Pass: exit 0, no console errors in the `NN-ui-*.txt` evidence, both screenshots saved.
  4. **The request is in the shared DB.**
     `$V sql RUN "select node_id, summary_requested_at from cc_sessions where node_id = '$NODE'"` -> one row with a non-null timestamp; and `curl -sf "$URL/api/sessions/$NODE" | jq -r '.session.summary_state'` -> `requested`.
     `$V note $RUN "R1 Summarize: click recorded summary_requested_at for $NODE; label persists"`.
  5. `$V down $RUN`.
- Neighbor check: the Summary section shares the panel with "Notes made" and the header actions. In the same steps file run after the reload, assert `page.locator('aside.np[data-node="' + NODE + '"]').getByRole('region', { name: 'Prompts' })` and `getByRole('button', { name: 'Resume in tmux' })` are visible (do not click Resume). Pass: both visible. Unit side: the existing `NodePanel.test.tsx` cases ("shows the session...", "refetches when the graph reports new activity") stay green.
**Exit criteria:** typecheck and `npm test` green; the five labels render for their states in jsdom; Summarize is shown only with no summary and state not empty/requested; one click sends exactly one `POST /api/sessions/A0-3G/summarize` and flips the label; a graph node gaining a summary triggers exactly one detail refetch; on a real verify daemon the click leaves `cc_sessions.summary_requested_at` set and "Summary requested" after reload; `features/projects.md` has exactly one "Summary on demand" bullet (API + UI) and one summary Gotcha line.

## Handoffs

- Phase 5: `NodePanel.tsx` now imports `ApiError`, `requestSummary`, `summarizeErrorNotice`, `SummaryRequest`, `MagicWand`; add your imports to the same lists. The Prompts section (L243-257 before this phase) is untouched. `.np-sec-head > .ibtn` (NodePanel.css) already sizes a lone header icon button, so the "Expand prompts" button can reuse `np-sec-head` with no extra CSS. `stubFetch` in `NodePanel.test.tsx` now takes `(detail, resume?, summarize?)` and routes POSTs by URL; GETs of other paths (your `/prompts`) still return `detail`, so route `/prompts` GETs there too. `projects.md`: append your R2 Sub-features bullet after the merged "Summary on demand" bullet and your driving block after the "Summarize in the wall." block.
- Phase 2 (contract check, no work expected): the web treats an unknown `summary_state` as `null` and a 200 POST answer with an unknown state as `'requested'`; the POST is sent with no body and no content-type.
- Follow-up (not in this set): a request the worker clears without writing a summary (null summary input) keeps showing "Summary requested" in an open panel until the node is reopened or becomes active, because nothing in the graph changes. If that matters, the graph payload could carry `summary_requested_at` so the stamp sees it clear.

## Rollback

Revert this phase's commit. It touches only `web/` and the feature map; the server keeps answering `summary_state` and the POST, which an older web bundle ignores. Rebuild `web/dist` (`npm run build`) after reverting.
