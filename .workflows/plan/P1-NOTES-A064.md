> Adopted from `/home/miftah/.worktrees/mcp-notes/session-note-links/.workflows/orchestration/session-note-links/PLAN.md` phase 2. Source: `.workflows/plan/session-note-links/phase-2.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 2: Web: open session notes in the big editor, link icon; feature map

**Plan set:** `docs/plans/SESSION_NOTE_LINKS_PLAN.md`
**Analysis:** `docs/analyzer/20261103-142651-L7NK_code_analyzer.md`
**Satisfies:** R2 — clicking a note in a session's "Notes made" pops it up in the bigger-view modal (NoteEditor), and linked notes carry a link icon
**Depends on:** Phase 1 (the session detail wire carries `notes[].kind: "made" | "linked"`, and MCP `link_note` exists for the Proof)
**Difficulty:** NORMAL
**Package:** `web/src`, `.claude/skills/verify-notesd/features`

---

## Goal

On `/projects` (the node panel beside the graph) and in the chat node pop-up (`NodeModal`), a plain
click on a note id in "Notes made" opens that note in the existing big editor (`NoteEditor`, codename
bigger-view-on-note) over the current page instead of navigating to the wall. Esc, X or a backdrop
click closes only the editor; the node panel or pop-up stays open. Linked notes (`kind: "linked"`)
show a Phosphor `LinkSimple` icon with a "Linked note" label. The verify-notesd feature map says how
to link a note and how to drive the click.

## Interface Contract

**Deletes:** nothing.
**Renames:** nothing.
**Creates:**
- `SessionNoteKind` type (`web/src/sessionDetailApi.ts`) = `'made' | 'linked'`.
- `isEditorOpen(doc?: Document): boolean` and `EDITOR_SELECTOR = '[data-modal="editor"]'` (`web/src/components/NoteEditor.tsx`).
- `web/src/components/graph/NodeModal.test.tsx`, `web/src/App.projectnotes.test.tsx` (new test files).
**Signature changes:**
- `SessionNoteRef { id; preview }` -> `SessionNoteRef { id; preview; kind: SessionNoteKind }`.
- `NodePanelProps` gains optional `onOpenNote?: (noteId: string) => void`.
- `ProjectsPageProps` gains optional `onOpenNote?: (noteId: string) => void`.
- `NodeModalProps` gains optional `onOpenNote?: (noteId: string) => void`.
**Requires (from earlier phases):**
- Phase 1: `GET /api/sessions/:nodeId` (and MCP `session_get`) returns `notes: [{ id, excerpt, tags, created_at, kind }]` with `kind` exactly `"made"` or `"linked"` (plan invariant 5). The web parser defaults to `"made"` when `kind` is absent or unknown, so this phase builds and its unit tests pass even if the field is missing; only the Proof needs Phase 1.
- Phase 1: MCP tool `link_note({ note_id, node_id })` (used only by the Proof and the feature-map entry).
- Phase 1: the link table is named `note_session_links` (used by one read-only `$V sql` in the Proof).
- Phase 1: MCP `link_note` / `unlink_note` return `{ note_id, node_id, session_id, linked, changed, made }` (Proof asserts `.linked` / `.changed`); MCP `create` returns `{ note: { id, … } }` (Proof reads `.note.id`); `GET /api/sessions/:nodeId` serves `sessionDetail()` unchanged (`src/http/sessionsApi.ts:206-213`), so `kind` reaches the wall.
- Phase 1 handoff: Phase 1 may not touch `.claude/skills/verify-notesd/`, so this phase's Step 12 carries Phase 1's feature-map lines too (`link_note` / `unlink_note` and session notes = made ∪ linked).
**Leaves alone (owned by others):** `src/**`, `drizzle/**`, `tests/integration/**`, `claude/skills/n/**`, `README.md` (Phase 1). `.claude/skills/verify-notesd/features/notes.md` is left unchanged (linking is a Projects feature; see Step 12).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/sessionDetailApi.ts:15-20, 142-150` | modify | `SessionNoteKind`; `SessionNoteRef.kind`; `noteRef()` reads wire `kind` |
| `web/src/sessionDetailApi.test.tsx:54, 85-88` | modify | expected note refs carry `kind: 'made'`; new case for `kind: 'linked'` and an unknown kind |
| `web/src/components/NoteEditor.tsx:44` | modify | add `EDITOR_SELECTOR` + `isEditorOpen()` after `const stop` |
| `web/src/components/graph/NodePanel.tsx:1-3, 22-34, 49, 274-288` | modify | `onOpenNote` prop; plain left click opens in place; `LinkSimple` icon on linked notes |
| `web/src/components/graph/NodePanel.css:42-43` | modify | style for `.np-linked` icon |
| `web/src/components/graph/NodePanel.test.tsx:84-88, 268` | modify | click/modified-click tests; link-icon test |
| `web/src/components/graph/NodeModal.tsx` (whole file, 57 lines) | modify | forward `onOpenNote`; Esc yields while the editor is open |
| `web/src/components/graph/NodeModal.test.tsx` | create | editor over the pop-up: Esc and backdrop close only the editor |
| `web/src/pages/ProjectsPage.tsx:14-30, 39, 104-108` | modify | `onOpenNote` prop forwarded into the default `NodePanel` |
| `web/src/App.tsx:717, 833-841, 937-943` | modify | `openNote` callback; pass it to `ProjectsPage` and `NodeModal` |
| `web/src/App.projectnotes.test.tsx` | create | App-level: click on `/projects` opens the editor, Esc closes only it, edits save, linked note fetched |
| `.claude/skills/verify-notesd/features/projects.md` | modify | session notes sub-feature (made ∪ linked, `kind`), `link_note` / `unlink_note` drive (Phase 1's handoff), Playwright selectors |

## Implementation Steps

### Step 1: `kind` on the client note ref
**File:** `web/src/sessionDetailApi.ts:15-20` (interface) and `:142-150` (`noteRef`)
**Change:** add the kind type and field; parse it from the wire with a `'made'` default, so an older
daemon (or a string-only note list) still renders.
**Code:** replace lines 15-20:
```ts
/** How a note belongs to a session: saved from it (`origin.claude_session`), or linked to it with `link_note`. */
export type SessionNoteKind = 'made' | 'linked';

/** A note this session saved, or one linked to it (`kind`). */
export interface SessionNoteRef {
  id: string;
  /** First non-empty line of the body, clipped; '' when the server sent only the id. */
  preview: string;
  /** 'made' when the server did not say (older daemon, bare id). */
  kind: SessionNoteKind;
}
```
replace the `noteRef` function (lines 142-150):
```ts
function noteRef(v: unknown): SessionNoteRef | null {
  if (typeof v === 'string') return str(v) === null ? null : { id: v.trim(), preview: '', kind: 'made' };
  if (isObj(v)) {
    const id = str(v.id);
    if (id === null) return null;
    return {
      id,
      preview: firstLine(str(v.excerpt) ?? str(v.preview) ?? str(v.body) ?? ''),
      kind: v.kind === 'linked' ? 'linked' : 'made',
    };
  }
  return null;
}
```
**Impact:** every `SessionNoteRef` now has `kind`. Only `NodePanel` consumes it. Two existing
expectations in `sessionDetailApi.test.tsx` change (Step 2).

### Step 2: update and extend the parser tests
**File:** `web/src/sessionDetailApi.test.tsx:54` and `:85-88`
**Change:** line 54 becomes
```ts
    expect(d.notes).toEqual([{ id: 'K-F07', preview: 'saved note', kind: 'made' }]);
```
lines 85-88 become
```ts
    expect(d.notes).toEqual([
      { id: 'K-F07', preview: '', kind: 'made' },
      { id: 'Z-Z01', preview: 'first line', kind: 'made' },
    ]);
```
and add this test inside `describe('normalizeSessionDetail', …)`, right after the test that ends at line 98 ("reads flat token columns…"):
```ts
  it('reads each note kind: linked stays linked, a missing or unknown kind is made', () => {
    const d = normalizeSessionDetail({
      session: { session_id: 'cc64', node_id: '5U-I7', host: 'lenovo' },
      notes: [
        { id: '5-BW7', excerpt: 'linked in later', kind: 'linked' },
        { id: 'K-F07', excerpt: 'saved here', kind: 'made' },
        { id: 'Z-Z01', excerpt: 'old daemon' },
        { id: 'Q-R88', excerpt: 'future kind', kind: 'pinned' },
      ],
    });
    expect(d.notes.map((n) => [n.id, n.kind])).toEqual([
      ['5-BW7', 'linked'],
      ['K-F07', 'made'],
      ['Z-Z01', 'made'],
      ['Q-R88', 'made'],
    ]);
  });
```
**Impact:** none outside the test file.

### Step 3: `isEditorOpen()` next to NoteEditor
**File:** `web/src/components/NoteEditor.tsx:44` (after `const stop = (e: MouseEvent) => e.stopPropagation();`)
**Change:** add a DOM-presence helper mirroring `isLightboxOpen` (`Lightbox.tsx:42-53`). The editor
root is `<div className="ed" data-modal="editor" …>` (`NoteEditor.tsx:181`, verified), and it is
mounted only while a note is expanded (`App.tsx:896`), so presence of the selector means "the big
editor is up".
**Code:** insert after line 44:
```ts

/** The editor root carries `data-modal="editor"`; its presence in the DOM means "the big editor is open". */
export const EDITOR_SELECTOR = '[data-modal="editor"]';

/**
 * True while the big editor is mounted. A modal key listener that runs before the editor's own
 * (an earlier-registered window capture listener, e.g. NodeModal's Esc) must return early when this
 * is true: the editor's stopPropagation cannot stop a listener on the same target that already ran.
 */
export function isEditorOpen(doc: Document = document): boolean {
  return doc.querySelector(EDITOR_SELECTOR) !== null;
}
```
**Impact:** new exports only; no behavior change.

### Step 4: NodePanel opens notes in place and marks linked ones
**File:** `web/src/components/graph/NodePanel.tsx`

**Decision: keep the `<a href="/?note=ID">` and cancel only a plain primary click.** With
`onOpenNote` present, a click with button 0 and no modifier calls `preventDefault()` and
`onOpenNote(id)`; middle-click and Ctrl/Cmd/Shift/Alt-click fall through to the browser, which opens
the wall on that note in a new tab or window. This is exactly what chat note links already do
(`ChatText.tsx:84-91`), the element stays a real link for screen readers ("link, A-B32"), and the
existing NodePanel test that asserts `getByRole('link', { name: 'K-F07' })` and its `href` keeps
passing. Without `onOpenNote` the anchor behaves as today.

**4a — imports, line 1 and line 3:**
```ts
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
```
```ts
import { ChartBarHorizontal, Check, CloudSlash, Copy, Graph, LinkSimple, Play, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
```

**4b — props, replace lines 22-34:**
```ts
export interface NodePanelProps {
  /** The selected node from `?node=` (any case, dash optional; the server normalises). */
  nodeId: string;
  /** The project graph's nodes (phase 10's payload through `toSubtreeNodes`), for the subtree views and refresh. */
  nodes: readonly SubtreeNode[];
  /** Select another node (pushes `?node=`). */
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  /** The chat pop-up's "Show on graph": open this node on its project's graph. Absent on the graph page itself. */
  onShowOnGraph?: (detail: SessionDetail) => void;
  /**
   * Open a note from "Notes made" in the big editor over this page. A plain primary click calls it;
   * a modified or middle click still follows the link to the wall. Absent: every click follows the link.
   */
  onOpenNote?: (noteId: string) => void;
  /** Tests pin the clock; the page uses a minute tick. */
  now?: Date;
}
```

**4c — helper, insert after `function placeLabel` (after line 47):**
```ts

/** A plain primary click: no modifier, left button. Anything else is left to the browser (new tab or window). */
function isPlainClick(e: ReactMouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}
```

**4d — signature, line 49:**
```ts
export function NodePanel({ nodeId, nodes, onSelectNode, onClose, onShowOnGraph, onOpenNote, now: nowProp }: NodePanelProps) {
```

**4e — the "Notes made" section, replace lines 274-288:**
```tsx
          <section className="np-sec" aria-label="Notes made">
            <h3>Notes made</h3>
            {detail.notes.length === 0 ? (
              <p className="np-dim">None</p>
            ) : (
              <ul className="np-notes">
                {detail.notes.map((n) => (
                  <li key={n.id}>
                    <a
                      href={`/?note=${encodeURIComponent(n.id)}`}
                      data-tip={onOpenNote ? 'Open note' : undefined}
                      onClick={
                        onOpenNote
                          ? (e) => {
                              if (!isPlainClick(e)) return;
                              e.preventDefault();
                              onOpenNote(n.id);
                            }
                          : undefined
                      }
                    >
                      {n.id}
                    </a>
                    {n.kind === 'linked' && (
                      <span className="np-linked" role="img" aria-label="Linked note" data-tip="Linked to this session">
                        <LinkSimple weight="duotone" />
                      </span>
                    )}
                    {n.preview && <span>{n.preview}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
```
The section heading stays "Notes made" (the user's own name for it); the icon is what tells a linked
note apart. The icon sits outside the anchor, so the link's accessible name stays the bare id.
**Impact:** NodePanel callers that pass nothing new behave as today.

### Step 5: icon style
**File:** `web/src/components/graph/NodePanel.css:43` (after `.np-notes span { color: var(--muted); }`)
**Code:**
```css
/* A note linked to the session (not saved from it): a small muted link glyph between id and preview. */
.np-notes .np-linked { display: inline-flex; vertical-align: -2px; margin-right: 6px; font-size: 13px; }
```
**Impact:** visual only.

### Step 6: NodePanel tests
**File:** `web/src/components/graph/NodePanel.test.tsx`
**Change:** add a `press` helper after `renderPanel` (after line 88) and two tests at the end of the
`describe` block (before the final `});` at line 269). `press` records whether the page cancelled the
click and then cancels it itself, so jsdom never attempts a navigation (same helper as
`App.notelinks.test.tsx:105-117`).
**Code:** helper:
```ts

/** Click; true when the page cancelled it (it opened the note in place instead of following the link). */
function press(el: Element, init: MouseEventInit = {}): boolean {
  const box: { seen: boolean | null } = { seen: null };
  const stop = (e: Event) => {
    box.seen = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', stop);
  try {
    const notCancelled = fireEvent.click(el, init);
    return box.seen ?? !notCancelled;
  } finally {
    document.removeEventListener('click', stop);
  }
}
```
tests:
```ts
  it('a plain click on a note opens it in place; a modified click follows the link to the wall', async () => {
    stubFetch(WIRE);
    const onOpenNote = vi.fn();
    renderPanel({ onOpenNote });
    const a = await screen.findByRole('link', { name: 'K-F07' });
    expect(a.getAttribute('href')).toBe('/?note=K-F07');
    expect(press(a)).toBe(true);
    expect(onOpenNote).toHaveBeenCalledWith('K-F07');
    onOpenNote.mockClear();
    expect(press(a, { ctrlKey: true })).toBe(false);
    expect(press(a, { metaKey: true })).toBe(false);
    expect(press(a, { button: 1 })).toBe(false);
    expect(onOpenNote).not.toHaveBeenCalled();
  });

  it('without onOpenNote a note click is an ordinary link', async () => {
    stubFetch(WIRE);
    renderPanel();
    const a = await screen.findByRole('link', { name: 'K-F07' });
    expect(press(a)).toBe(false);
  });

  it('marks a linked note with a link icon, and a note made in the session without one', async () => {
    stubFetch({
      ...WIRE,
      notes: [
        { id: '5-BW7', excerpt: 'linked in later', kind: 'linked' },
        { id: 'K-F07', excerpt: 'wall editing notes', kind: 'made' },
      ],
    });
    renderPanel();
    const linked = (await screen.findByRole('link', { name: '5-BW7' })).closest('li') as HTMLElement;
    const made = screen.getByRole('link', { name: 'K-F07' }).closest('li') as HTMLElement;
    expect(within(linked).getByRole('img', { name: 'Linked note' })).toBeTruthy();
    expect(within(made).queryByRole('img', { name: 'Linked note' })).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Linked note' })).toHaveLength(1);
  });
```
and change the testing-library import on line 3 to include `within`:
```ts
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
```
**Impact:** test-only.

### Step 7: NodeModal forwards `onOpenNote` and yields Esc to the editor
**File:** `web/src/components/graph/NodeModal.tsx` (whole file)
**Change:** new optional prop forwarded to `NodePanel`; the window capture Esc listener returns early
while `isEditorOpen()`. Why it is needed: NodeModal mounts first, so its window capture listener is
registered before NoteEditor's and runs first on the same target; NoteEditor's `stopPropagation`
cannot stop it. Without the guard one Esc closes both.

Backdrop: no change needed. App renders the editor as its own `createPortal(…, document.body)`
sibling (`App.tsx:896-917`), not inside NodeModal, so a click on the editor's backdrop neither
bubbles through `.nm` in the DOM nor through NodeModal in the React tree; the editor closes alone.
Stacking: both scrims are `z-index: 60` (`NoteEditor.css:2`, `NodeModal.css:2`); the editor portal
is appended to `body` when it mounts, after the already-open pop-up, so it paints on top. The new
`NodeModal.test.tsx` (Step 8) proves the backdrop behavior.
**Code:**
```tsx
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { isConfirmOpen } from '../ConfirmDialog';
import { isLightboxOpen } from '../Lightbox';
import { isEditorOpen } from '../NoteEditor';
import { useSessionGraph } from '../../hooks/useSessionGraph';
import { toSubtreeNodes } from '../../lib/subtree';
import type { SessionDetail } from '../../sessionDetailApi';
import { NodePanel } from './NodePanel';
import './NodeModal.css';

export interface NodeModalProps {
  /** The node id clicked in chat text, canonical. */
  nodeId: string;
  /** Its repo, when known: loads that project's graph for the subtree views. */
  repo: string | null;
  onClose: () => void;
  /** "Show on graph": the projects page on this node. */
  onShowOnGraph: (nodeId: string, repo: string) => void;
  /** A note in "Notes made": App opens it in the big editor over this pop-up. Absent: the note link goes to the wall. */
  onOpenNote?: (noteId: string) => void;
}

/**
 * A node id clicked in chat (`BE-XU`): the graph page's node panel as a pop-up over the current
 * page, the way a note id opens the big editor. Parent and subtree clicks move the pop-up to that
 * node; "Show on graph" leaves for the projects page; a note opens in the big editor above it.
 * Esc and a click outside close it, except while the editor, a lightbox or a confirm is up.
 */
export function NodeModal({ nodeId, repo, onClose, onShowOnGraph, onOpenNote }: NodeModalProps) {
  const [current, setCurrent] = useState(nodeId);
  useEffect(() => setCurrent(nodeId), [nodeId]);
  const graph = useSessionGraph(repo);
  const nodes = useMemo(() => toSubtreeNodes(graph.nodes), [graph.nodes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The big editor (opened from "Notes made") registers its Esc listener after this one: yield
      // to it, or one Esc would close both. Same for a lightbox or confirm.
      if (e.key !== 'Escape' || isEditorOpen() || isLightboxOpen() || isConfirmOpen()) return;
      // Capture phase + preventDefault + stopPropagation (the editor's seam): Esc closes only the pop-up.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const show = (d: SessionDetail) => {
    if (d.repo !== null) onShowOnGraph(d.node_id, d.repo);
  };

  return createPortal(
    <div className="nm" data-modal="node" onClick={onClose}>
      <div className="nm-panel" role="dialog" aria-label={`Session ${current}`} onClick={(e) => e.stopPropagation()}>
        <NodePanel nodeId={current} nodes={nodes} onSelectNode={setCurrent} onClose={onClose} onShowOnGraph={show} onOpenNote={onOpenNote} />
      </div>
    </div>,
    document.body,
  );
}
```
**Impact:** NodeModal callers without `onOpenNote` are unchanged except the Esc guard, which only
matters while an editor is mounted (today the editor and the pop-up cannot both be up from a click
path, so no current behavior changes).

### Step 8: NodeModal test (editor over the pop-up)
**File:** `web/src/components/graph/NodeModal.test.tsx` (new)
**Change:** a harness shaped like App: the pop-up's `onOpenNote` mounts a real `NoteEditor` as a
sibling portal. Before Step 7's guard, the Esc test fails (both close).
**Code:**
```tsx
// @vitest-environment jsdom
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeNote } from '../../testing/fixtures';
import { NoteEditor } from '../NoteEditor';
import { NodeModal } from './NodeModal';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/sessions/BE-XU')) {
        return json({
          session: { session_id: 's1', node_id: 'BE-XU', repo: null, host: 'pc', name: 'orch-project-session-graph' },
          notes: [{ id: '5-BW7', excerpt: 'linked note body', tags: [], created_at: null, kind: 'linked' }],
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** App's shape: the editor is a sibling portal opened through onOpenNote, never a child of the pop-up. */
function Harness({ onModalClosed }: { onModalClosed: () => void }) {
  const [modal, setModal] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      {modal && (
        <NodeModal
          nodeId="BE-XU"
          repo={null}
          onClose={() => {
            setModal(false);
            onModalClosed();
          }}
          onShowOnGraph={() => {}}
          onOpenNote={setEditing}
        />
      )}
      {editing !== null &&
        createPortal(
          <NoteEditor
            note={makeNote(editing, 'linked note body')}
            copied={false}
            notice={null}
            onCopy={() => {}}
            onSave={() => {}}
            onClose={() => setEditing(null)}
            onRemoveImage={() => {}}
          />,
          document.body,
        )}
    </>
  );
}

const editor = () => screen.queryByRole('dialog', { name: 'Edit note 5-BW7' });
const popup = () => screen.queryByRole('dialog', { name: 'Session BE-XU' });

async function openEditor(): Promise<void> {
  fireEvent.click(await screen.findByRole('link', { name: '5-BW7' }));
  await waitFor(() => expect(editor()).not.toBeNull());
}

describe('NodeModal: a note opened from "Notes made"', () => {
  it('opens the big editor over the pop-up; Esc closes only the editor, a second Esc the pop-up', async () => {
    const onModalClosed = vi.fn();
    render(<Harness onModalClosed={onModalClosed} />);
    await openEditor();
    expect(popup()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(editor()).toBeNull());
    expect(popup()).not.toBeNull();
    expect(onModalClosed).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(popup()).toBeNull());
    expect(onModalClosed).toHaveBeenCalledTimes(1);
  });

  it('a click on the editor backdrop closes only the editor', async () => {
    const onModalClosed = vi.fn();
    render(<Harness onModalClosed={onModalClosed} />);
    await openEditor();
    fireEvent.click(document.querySelector('[data-modal="editor"]') as Element);
    await waitFor(() => expect(editor()).toBeNull());
    expect(popup()).not.toBeNull();
    expect(onModalClosed).not.toHaveBeenCalled();
  });
});
```
**Impact:** test-only. `makeNote(id, body)` is `web/src/testing/fixtures.ts:60`.

### Step 9: ProjectsPage forwards `onOpenNote`
**File:** `web/src/pages/ProjectsPage.tsx`
**Change:** add the prop (after `renderBadge`, line 29), destructure it (line 39), forward it into the
default panel (lines 104-108). A caller's own `renderPanel` is untouched (it builds its own panel).
**Code:** props interface, insert before the closing `}` at line 30:
```ts
  /** "Notes made" in the default node panel: open a note in the big editor over this page. */
  onOpenNote?: (noteId: string) => void;
```
line 39:
```ts
export function ProjectsPage({ repo, resolving = false, node, onSelectNode, focus = false, onToggleFocus, renderPanel, renderBadge, onOpenNote }: ProjectsPageProps) {
```
lines 104-108:
```tsx
  const panel =
    renderPanel ??
    ((n: SessionNode, closePanel: () => void) => (
      <NodePanel nodeId={n.node_id} nodes={panelNodes} onSelectNode={(id) => onSelectNode(id)} onClose={closePanel} onOpenNote={onOpenNote} />
    ));
```
The Esc-clears-the-node listener (lines 72-79) needs no change: it is a `document` bubble listener
that returns when `e.defaultPrevented`, and NoteEditor's window capture listener both
`preventDefault()`s and `stopPropagation()`s, so the panel survives the editor's Esc. Step 10's App
test proves it.
**Impact:** none for callers that do not pass the prop.

### Step 10: App wires `openNoteModal` into both
**File:** `web/src/App.tsx`
**Change:** a stable void wrapper over the existing `openNoteModal` (App.tsx:599 — normalizes the id,
closes an open editor first via `closeSignal`/`pendingModal`, uses the store or `fetchNote`, says
"is deleted" for a binned note, never changes view or URL). Reused as-is, no new open path.
**Code:** insert after line 717 (the `);` closing `noteLinks`):
```ts

  /** A note in a session's "Notes made" (projects node panel, node pop-up): the big editor in place, like a chat note link. */
  const openNote = useCallback(
    (id: string) => {
      void openNoteModal(id);
    },
    [openNoteModal],
  );
```
lines 833-841 (`ProjectsPage`) become:
```tsx
                <ProjectsPage
                  key={projectRepo ?? ''}
                  repo={projectRepo}
                  resolving={resolvingRepo}
                  node={projectsRoute.node}
                  onSelectNode={selectNode}
                  focus={focus}
                  onToggleFocus={toggleFocus}
                  onOpenNote={openNote}
                />
```
lines 937-944 (`NodeModal`) become:
```tsx
            {nodeModal !== null && (
              <NodeModal
                nodeId={nodeModal}
                repo={knownNodes.lookup(nodeModal)?.repo ?? null}
                onClose={closeNodeModal}
                onShowOnGraph={showNodeOnGraph}
                onOpenNote={openNote}
              />
            )}
```
(Line numbers are pre-insertion; after the 8-line `openNote` insert they shift by +8.)
Verified behavior over `/projects`: the editor portal (`App.tsx:896`) is outside the view switch, so it
renders on any view. Its X / backdrop / Esc run `closeEditor` (empty rule, save on dirty); Delete runs
`removeNote`; "Show on wall" runs `showOnWall` -> `revealLinked` -> `planReveal`, which always returns
`view: 'wall'` (`lib/reveal.ts:37`), so it leaves `/projects` for the wall, same as from history/bin.
**Impact:** App-only wiring.

### Step 11: App-level test
**File:** `web/src/App.projectnotes.test.tsx` (new; a separate file so `App.projects.test.tsx`'s shared
fetch stub, which 404s `/api/sessions/A0-3G`, stays as is)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note, ProjectSummary } from './types';
import { makeNote } from './testing/fixtures';
import { makeSession } from './testing/sessionFixtures';
import { App } from './App';

const iso = new Date().toISOString();
const older = new Date(Date.now() - 3_600_000).toISOString();
// Made-up ids. A-B32 is on the wall's page; Q-R88 is past it (fetched on open) and linked, not made.
const made = makeNote('A-B32', 'buy fennel #kitchen', { created: iso });
const far = makeNote('Q-R88', 'an old note past the first page', { created: older });
const notes: Note[] = [made];
const projects: ProjectSummary[] = [
  { repo: 'mcp-notes', sessions: 1, live: 0, last_active_at: '2026-11-01T00:00:00Z', first_started_at: null, hosts: ['lenovo'] },
];
const root = makeSession('A0-3G', 0, { custom_title: 'session-note-links' });
const DETAIL = {
  session: { session_id: 's-A0-3G', node_id: 'A0-3G', repo: 'mcp-notes', host: 'lenovo', available: true, live: false, name: 'session-note-links' },
  prompts: [],
  commits: [],
  notes: [
    { id: 'A-B32', excerpt: 'buy fennel #kitchen', tags: ['kitchen'], created_at: iso, kind: 'made' },
    { id: 'Q-R88', excerpt: 'an old note past the first page', tags: [], created_at: older, kind: 'linked' },
  ],
  parent: null,
  children: [],
};

let calls: string[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (url === '/api/projects') return json({ projects });
      if (url === '/api/projects/selected') return json({ repo: 'mcp-notes' });
      if (url.startsWith('/api/sessions/known?')) return json({ nodes: [] });
      if (url === '/api/sessions/A0-3G') return json(DETAIL);
      if (url.startsWith('/api/projects/mcp-notes/sessions')) return json({ repo: 'mcp-notes', nodes: [root] });
      const one = /^\/api\/notes\/([^/?]+)$/.exec(url);
      if (one && method === 'GET') {
        const hit = [made, far].find((n) => n.id === decodeURIComponent(one[1]!));
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
      }
      if (one && method === 'PATCH') {
        const base = [made, far].find((n) => n.id === decodeURIComponent(one[1]!)) as Note;
        return json({ ...base, body: (JSON.parse(String(init?.body)) as { body: string }).body });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: () => ({}) as Animation });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  window.history.replaceState(null, '', '/');
});

const at = (url: string) => window.history.replaceState(null, '', url);
const where = () => window.location.pathname + window.location.search;
const dialog = (id: string) => screen.queryByRole('dialog', { name: `Edit note ${id}` });
const panel = () => document.querySelector<HTMLElement>('aside.np[data-node="A0-3G"]');

/** Click; true when the page cancelled it (see App.notelinks.test.tsx `press`). */
function press(el: Element, init: MouseEventInit = {}): boolean {
  const box: { seen: boolean | null } = { seen: null };
  const stop = (e: Event) => {
    box.seen = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', stop);
  try {
    const notCancelled = fireEvent.click(el, init);
    return box.seen ?? !notCancelled;
  } finally {
    document.removeEventListener('click', stop);
  }
}

async function openPanel(): Promise<HTMLElement> {
  at('/projects?repo=mcp-notes&node=A0-3G');
  render(<App />);
  return waitFor(() => {
    const el = panel();
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
}

describe('App: a session note opens the big editor over /projects', () => {
  it('a click opens the editor in place; Esc closes only the editor (draft saved), the node panel stays', async () => {
    const p = await openPanel();
    const a = await within(p).findByRole('link', { name: 'A-B32' });
    expect(press(a)).toBe(true);
    await waitFor(() => expect(dialog('A-B32')).not.toBeNull());
    expect(where()).toBe('/projects?repo=mcp-notes&node=A0-3G');
    fireEvent.change(screen.getByLabelText('Note text'), { target: { value: 'buy fennel and dill #kitchen' } });
    // On document, where ProjectsPage listens: the editor's window capture listener must stop it there.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(dialog('A-B32')).toBeNull());
    await waitFor(() => expect(calls).toContain('PATCH /api/notes/A-B32'));
    expect(panel()).not.toBeNull();
    expect(where()).toBe('/projects?repo=mcp-notes&node=A0-3G');
    // With the editor gone, Esc is the page's again: it clears the node.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(where()).toBe('/projects?repo=mcp-notes'));
  });

  it('a linked note past the wall page is fetched and opened; only it carries the link icon', async () => {
    const p = await openPanel();
    const linked = await within(p).findByRole('link', { name: 'Q-R88' });
    const madeRow = within(p).getByRole('link', { name: 'A-B32' }).closest('li') as HTMLElement;
    expect(within(linked.closest('li') as HTMLElement).getByRole('img', { name: 'Linked note' })).toBeTruthy();
    expect(within(madeRow).queryByRole('img', { name: 'Linked note' })).toBeNull();
    expect(press(linked)).toBe(true);
    await waitFor(() => expect(dialog('Q-R88')).not.toBeNull());
    expect(calls).toContain('GET /api/notes/Q-R88');
    expect(where()).toBe('/projects?repo=mcp-notes&node=A0-3G');
  });
});
```
**Impact:** test-only. If `makeSession`'s `custom_title` option shape differs, it is the same call
`App.projects.test.tsx:15` makes, so it typechecks.

### Step 12: feature map
**File:** `.claude/skills/verify-notesd/features/projects.md` (whole file)
**Change:** add the session-notes sub-feature, how a user reaches it, how to link a note over MCP
with ids taken from the run (never invented), and the Playwright selectors. `notes.md` is not
changed: note CRUD did not change, and linking only shows up on the Projects surface.
**Code:**
````markdown
# Projects: Claude Code session graph

## Sub-features
- Projects list (repo, session count, live count, last active), selected project.
- Per-project sessions: graph, tree, timeline views; node ids like `A0-3G`.
- Session search, usage (tokens), transcript (owning host only), resume (NOT driven here).
- Link an existing note to a session (MCP `link_note` / `unlink_note`; Phase 1). Session notes =
  made ∪ linked, deduped (a note both made and linked is listed once as `made`), newest first, at most 50.
- A session's "Notes made": notes saved from it (`kind: "made"`) plus notes linked to it with MCP
  `link_note` (`kind: "linked"`, shown with a link icon labelled "Linked note"). A plain click on a
  note id opens it in the big editor (bigger-view-on-note) over `/projects`, or over the chat node
  pop-up; Esc / X / backdrop closes only the editor and the node panel stays. Ctrl/middle click still
  opens the wall on that note in a new tab.

## How to get to it (user POV)
Wall sidebar `Projects` → `/projects`, click a node → the node panel (`aside.np`), section
"Notes made". Claude Code: MCP `sessions_search`, `session_get`, `session_transcript`,
`sessions_usage`; `/n link 5-BW7 into 5U-I7` (MCP `link_note` / `unlink_note`).

## Driving it with verify.sh
```sh
$V up --sessions --web            # ingests tests/fixtures/claude-home: repos mcp-notes, wall-editing
$V api RUN GET /api/projects      # both repos listed
$V api RUN GET /api/projects/mcp-notes/sessions
$V mcp RUN sessions_usage '{}'
```
UI: `page.goto(base + '/projects')`, wait for `getByTestId('graph')`, toggle with `project-view-toggle`.

Session notes. Node ids and session ids are generated at ingest, so read them from the run; never
type one in. `URL` is what `up` printed.
```sh
S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
NODE=$(jq -r '.nodes[0].node_id' <<<"$S"); SID=$(jq -r '.nodes[0].session_id' <<<"$S")
MADE=$($V mcp RUN create "{\"body\":\"made in a fixture session #verify\",\"origin\":{\"claude_session\":\"$SID\"}}" | sed 1d | jq -r .note.id)
LINKED=$($V mcp RUN create '{"body":"saved elsewhere #verify"}' | sed 1d | jq -r .note.id)
$V mcp RUN link_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}"
$V mcp RUN session_get "{\"node_id\":\"$NODE\"}"     # notes: MADE kind "made", LINKED kind "linked"
# Only after the UI steps below (it removes LINKED from the panel):
$V mcp RUN unlink_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}"   # {linked:false, changed:true}; again -> changed:false
$V sql RUN "select note_id, session_id from note_session_links"   # read-only check of the link table
```
Results: `link_note` / `unlink_note` → `{ note_id, node_id, session_id, linked, changed, made }`. Errors:
`not_found: Note …`, `not_found: no session …`, `invalid_node_id: …`, `deleted: Note … is deleted` (link only;
unlink works on a deleted note).
UI selectors (pass ids to the steps file through the environment: `NODE=$NODE LINKED=$LINKED $V ui RUN steps.mjs`):
- `page.goto(base + '/projects?repo=mcp-notes&node=' + NODE)`
- node panel: `page.locator('aside.np[data-node="' + NODE + '"]')`; its notes: `.getByRole('region', { name: 'Notes made' })`
- a note: `.getByRole('link', { name: LINKED, exact: true })`; the icon: `getByRole('img', { name: 'Linked note' })` inside that `li`
- the editor: `page.getByRole('dialog', { name: 'Edit note ' + LINKED })`, text box `getByLabel('Note text')`

## Gotchas
- Ingest is a background tail; allow a few seconds after `up` before asserting (the `curl --retry`
  above waits for it; `/api/projects/<repo>/sessions` is 404 until the repo has a session).
- New ingest behavior needs a new fixture in `tests/fixtures/claude-home`, never the real `~/.claude`.
- Never drive `resume`: it spawns real Claude sessions.
- The node panel loads session detail when it opens; after `link_note`, reload the page (or reopen
  the node) before asserting the new note is listed. A link change sends no SSE event.
- `$V mcp` prints a `> tool args` line first; strip it (`sed 1d`) before `jq`.
````
**Impact:** docs for verifiers only.

## Principles applied

- Laziness protocol: the click reuses App's existing `openNoteModal` (chat note links' open-by-id path, with store lookup, fetch, deleted notice and editor swap) through a 3-line `openNote` wrapper, instead of a new open path; `isPlainClick` stays a private helper in NodePanel rather than a shared util for two callers.
- Boundary discipline: the wire `kind` is validated once in `noteRef()` (`'linked'` or else `'made'`) and NodePanel trusts the typed `SessionNoteKind`; no string checks in the component.
- Make illegal states unrepresentable: `kind` is a two-value union, not an optional string or an `isLinked` boolean next to a possibly absent field, so a ref cannot be "neither".
- Test behavior, not implementation: the NodeModal test mounts a real `NoteEditor` as a sibling portal the way App does and asserts on dialogs a user sees, so it fails without the Esc guard; the App test dispatches Esc on `document` (where ProjectsPage listens) and checks the URL and the PATCH, not internal state.
- Prove it works: Proof drives the real daemon with verify-notesd (`up --sessions --web`, `link_note` over MCP, Playwright click), and reads the edited body back over MCP.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/session-note-links && (test -d node_modules || npm ci) && npm run typecheck && npm run build`
**Tests:** `npx vitest run web/src/sessionDetailApi.test.tsx web/src/components/graph/NodePanel.test.tsx web/src/components/graph/NodeModal.test.tsx web/src/App.projectnotes.test.tsx web/src/App.projects.test.tsx web/src/App.notelinks.test.tsx web/src/components/NodeLinks.test.tsx web/src/components/NoteEditor.test.tsx`, then the full `npm test`.
**Proof:** the real daemon from this worktree, with Phase 1 landed.
- Harness: `.claude/skills/verify-notesd` (`V=.claude/skills/verify-notesd/scripts/verify.sh`, run from the worktree root).
- Feature-map entries: `features/projects.md` (updated in Step 12).
- Setup (ids come from the run, never typed in):
  ```sh
  cd /home/miftah/.worktrees/mcp-notes/session-note-links
  V=.claude/skills/verify-notesd/scripts/verify.sh
  OUT=$($V up --sessions --web); echo "$OUT"
  RUN=$(sed -n 's/^RUN=//p' <<<"$OUT"); URL=$(sed -n 's/^URL=//p' <<<"$OUT")
  $V doctor $RUN
  S=$(curl -sf --retry 30 --retry-delay 1 --retry-all-errors "$URL/api/projects/mcp-notes/sessions")
  NODE=$(jq -r '.nodes[0].node_id' <<<"$S"); SID=$(jq -r '.nodes[0].session_id' <<<"$S"); echo "NODE=$NODE SID=$SID"
  MADE=$($V mcp $RUN create "{\"body\":\"made in a fixture session #verify\",\"origin\":{\"claude_session\":\"$SID\"}}" | sed 1d | jq -r .note.id)
  LINKED=$($V mcp $RUN create '{"body":"saved elsewhere #verify"}' | sed 1d | jq -r .note.id)
  echo "MADE=$MADE LINKED=$LINKED"
  ```
  Each id must look like `X-XXX` (MCP `create` returns `{ note: { id, … } }`, confirmed in `src/mcp/tools.ts:184`, so `.note.id` is the path).
- Journey 1 — link over MCP, detail carries both kinds:
  ```sh
  $V mcp $RUN link_note "{\"note_id\":\"$LINKED\",\"node_id\":\"$NODE\"}" | sed 1d | jq -e --arg n "$LINKED" --arg s "$NODE" '.note_id==$n and .node_id==$s and .linked==true and .changed==true and .made==false'
  $V mcp $RUN session_get "{\"node_id\":\"$NODE\"}" | sed 1d | jq -c '[.notes[] | {id, kind}]'
  $V sql $RUN "select note_id, session_id from note_session_links"
  ```
  Passes when the `jq` output contains `{"id":"<MADE>","kind":"made"}` and `{"id":"<LINKED>","kind":"linked"}`, and the sql shows one row `<LINKED> | <SID>`.
- Journey 2 — click in the node panel opens the big editor in place; Esc closes only the editor; edit persists. Write `$SCRATCH/session-notes.mjs`, where `$SCRATCH` is the executing session's own scratchpad directory (any directory outside the repo works):
  ```js
  export default async ({ page, base, shot, log }) => {
    const { NODE, LINKED, MADE } = process.env
    if (!NODE || !LINKED || !MADE) throw new Error('set NODE, LINKED, MADE')
    await page.goto(`${base}/projects?repo=mcp-notes&node=${NODE}`)
    const panel = page.locator(`aside.np[data-node="${NODE}"]`)
    await panel.waitFor()
    const notes = panel.getByRole('region', { name: 'Notes made' })
    const linkedA = notes.getByRole('link', { name: LINKED, exact: true })
    const madeA = notes.getByRole('link', { name: MADE, exact: true })
    await linkedA.waitFor()
    await madeA.waitFor()
    const icon = (a) => notes.locator('li', { has: a }).getByRole('img', { name: 'Linked note' })
    if ((await icon(linkedA).count()) !== 1) throw new Error('linked note has no link icon')
    if ((await icon(madeA).count()) !== 0) throw new Error('made note shows a link icon')
    log('linked note shows the link icon; made note does not')
    await shot('panel-notes')

    const before = page.url()
    await linkedA.click()
    const editor = page.getByRole('dialog', { name: `Edit note ${LINKED}` })
    await editor.waitFor()
    if (page.url() !== before) throw new Error(`navigated to ${page.url()}`)
    await shot('editor-over-projects')
    log('plain click opened the big editor over /projects, URL unchanged')

    await editor.getByLabel('Note text').fill('saved elsewhere, edited from projects #verify')
    await page.keyboard.press('Escape')
    await editor.waitFor({ state: 'detached' })
    await panel.waitFor()
    if (!page.url().includes(`node=${NODE}`)) throw new Error(`node dropped from URL: ${page.url()}`)
    await shot('editor-closed-panel-open')
    log('Esc closed only the editor; node panel still open')

    await madeA.click()
    const ed2 = page.getByRole('dialog', { name: `Edit note ${MADE}` })
    await ed2.waitFor()
    await ed2.getByRole('button', { name: 'Close' }).click()
    await ed2.waitFor({ state: 'detached' })
    await panel.waitFor()
    log('made note opens and X closes only the editor')

    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'detached' })
    log('with no editor up, Esc clears the node as before')
  }
  ```
  Run: `NODE=$NODE LINKED=$LINKED MADE=$MADE $V ui $RUN $SCRATCH/session-notes.mjs`
  Passes when the ui transcript ends `result: PASS` with no `console.error`/`pageerror` lines, and then
  `$V mcp $RUN get "{\"ids\":[\"$LINKED\"]}" | sed 1d | jq -r '.notes[0].body'` prints exactly
  `saved elsewhere, edited from projects #verify` (the edit made in the editor over `/projects` was saved).
- Journey 3 — the same note before this phase navigates (shows the change is real): on `main` (or with this phase stashed) the same steps file fails at `navigated to …/?note=<LINKED>`. Optional for the verifier; the unit test in Step 6 already fails on the old anchor.
- Neighbor check: the wall's own big editor and chat note links. `npx vitest run web/src/App.notelinks.test.tsx web/src/components/NodeLinks.test.tsx web/src/App.projects.test.tsx` green; on the real daemon, Journey 2's last step shows Esc on `/projects` with no editor still clears the node.
- Cleanup: `$V down $RUN`.
**Exit criteria:** typecheck and `npm test` green; Journey 1 shows both kinds; Journey 2 passes and the edited body reads back over MCP; `features/projects.md` documents the link + click drive.

## Handoffs

- Phase 1 (R1): `kind` on the session detail wire (HTTP and MCP `session_get`), `link_note`/`unlink_note`, the `note_session_links` table, `/n link …` docs and README. This phase only reads `kind` and defaults it to `"made"`.
- Phase 1 / After landing: the live rebuild, restart and the `5-BW7` → `5U-I7` link on the live daemon. Once both phases land, the user's original click (5U-I7's panel → 5-BW7 in the big editor) needs no further web work.
- Not done (out of scope, no requirement id): refreshing the node panel when a note is deleted from the editor opened over it. The panel keeps listing the deleted note until it reloads; clicking it again shows the existing "<id> is deleted. Restore it from the bin." notice. Same for a link change (no SSE event, per the index's Out of scope).

## Rollback

Revert this phase's commit. It touches only `web/src/**` and `features/projects.md`; no schema or
server change. Without it, Phase 1's `kind` field is ignored by the old parser and note ids go back
to linking to the wall.
