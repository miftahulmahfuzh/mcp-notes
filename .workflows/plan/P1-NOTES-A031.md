> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 9. Source: `.workflows/plan/wall-editing/phase-9.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 9: Web reveal button + capabilities

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R4 (folder icon on photo cards, photo modal and editor image strip that asks notesd to open Explorer with the original selected), R5 (the reveal visibility tests)
**Depends on:** Phase 5 (server: `GET /api/capabilities`, `POST /api/images/:imageId/reveal`), Phase 8 (and through it 6 and 7: `images[]`, `PhotoItem`, `NoteEditor` with its image strip, Trash/expand icons in the same toolbars)
**Difficulty:** NORMAL
**Package:** `web/src`

---

## Goal

When notesd says it can reveal files (`GET /api/capabilities` → `{ reveal: true }`) and an image's original is on this machine (`image.available`), a Phosphor `FolderOpen` duotone icon (`data-tip="Show in Explorer"`) appears on the wall's photo cards (for the cover image), in the photo modal's toolbar (current image) and next to each image in the editor's image strip. Clicking it POSTs `/api/images/<imageId>/reveal`. Off WSL, or for an image stored on another laptop, nothing is rendered. Capabilities are fetched once per page load, and any error counts as `{ reveal: false }`.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `web/src/api.ts`: `interface Capabilities { reveal: boolean }`, `fetchCapabilities(): Promise<Capabilities>`, `revealImage(imageId: string): Promise<void>`
- `web/src/hooks/useCapabilities.ts`: `useCapabilities(): Capabilities`, `loadCapabilities(): void`, `NO_CAPABILITIES`, `resetCapabilitiesForTests(next?: Capabilities): void`
- `web/src/components/RevealButton.tsx`: `RevealButton({ image, className?, style? })`, `RevealButtonProps`
- CSS `.ed-reveal { right: 34px; }` appended to `web/src/components/NoteEditor.css` (phase 7's file)
- Tests: `web/src/components/RevealButton.test.tsx`, `web/src/hooks/useCapabilities.test.tsx`, `web/src/components/RevealMounts.test.tsx`

**Signature changes:** none. No props are added to `NoteCard`, `PhotoModal`, `NoteEditor` or `App`. `RevealButton` reads capabilities from a module-level store, so nothing has to be threaded through `App.tsx`.
**Requires (from earlier phases):**
- Phase 5: `GET /api/capabilities` → `{ reveal: boolean }`; `POST /api/images/:imageId/reveal` behind `sameOriginOnly` → 202 `{ ok: true }` or a 4xx/5xx `{ error }`.
- Phase 6: `Note.images: NoteImage[]` (wire type in `web/src/types.ts`, fields `id` and `available`); `NoteCard` renders the cover from `note.images[0]` and keeps the `.card-meta` row; `PhotoModal` takes `items: PhotoItem[]` (`PhotoItem = { note; image; k; n }`), keeps its toolbar `<div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>` with `pm-btn` buttons styled by `toolBtn`, and keeps the `Copy ID` button.
- Phase 7 (names confirmed against phase-7.md Step 4): `NoteEditor` (`web/src/components/NoteEditor.tsx`, exporting `NoteEditor` and `NoteEditorProps`) renders `<div className="ed-strip">` with `note.images.map((img) => <div key={img.id} className="ed-thumb" data-image={img.id} …>…<button className="ed-rm" aria-label="Remove image" …/></div>)`; `.ed-rm` is absolutely positioned (`top: 4px; right: 4px`) in `NoteEditor.css` and shown on `.ed-thumb:hover`. `NoteCard`'s meta row is: id, Copy, `copied` span, `.card-date`, then the `ArrowsOutSimple` button (`Expand note`).
- Phase 8: `Trash` buttons in the NoteCard meta row, the NoteEditor toolbar and the PhotoModal toolbar. Phase 9 does not touch them; it only places its button next to them.
**Leaves alone (owned by others):** all of `src/**` (server, phases 1–5); `web/src/types.ts` (phase 6; `Capabilities` lives in `api.ts` so phase 9 never edits `types.ts`); `App.tsx` entirely (phases 6–8, and the chat JSX belongs to phase 11 under invariant 7); `ChatBar.tsx`, `AnswerPanel.tsx`, `useChat.ts`, `ChatBar.css` and the `.answer*`/`.chatbar`/`.sendbtn` rules (phase 11); `Gallery.tsx` (the contract mounts the button on wall cards, the modal and the editor strip only, not on gallery tiles; index Decisions); `styles.css` and `PhotoModal.css` (the button reuses the existing `copybtn` / `pm-btn` classes). The only CSS this phase adds is one rule appended to phase 7's `NoteEditor.css` (Step 6), because `.ed-rm` is absolutely positioned and a second button with that class alone would sit on top of the remove icon.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/api.ts` | modify (append after the URL helpers at the end of the file, today line 71; phases 6–8 append before this) | `Capabilities`, `fetchCapabilities`, `revealImage` |
| `web/src/hooks/useCapabilities.ts` | create | module-level store, one fetch per page, `{ reveal: false }` on error |
| `web/src/components/RevealButton.tsx` | create | `FolderOpen` button, visible only when `caps.reveal && image.available` |
| `web/src/components/NoteCard.tsx` | modify (import block lines 1–6; `.card-meta` row, today lines 76–92, after phase 7/8 it also holds expand + Trash) | one `<RevealButton>` for `note.images[0]` when the note has images |
| `web/src/components/PhotoModal.tsx` | modify (import block lines 1–5; toolbar, today lines 119–129, after phase 8 it also holds Trash) | one `<RevealButton>` for the current item's image, right after `Copy ID` |
| `web/src/components/NoteEditor.tsx` | modify (import block; the `.ed-thumb` strip item that phase 7 created) | one `<RevealButton>` per strip image, right before that image's `.ed-rm` remove icon |
| `web/src/components/NoteEditor.css` | modify (append one rule) | `.ed-reveal { right: 34px; }`: the reveal icon sits left of the remove icon |
| `web/src/hooks/useCapabilities.test.tsx` | create | fetch once per page, error → false, non-`true` payload → false |
| `web/src/components/RevealButton.test.tsx` | create | visibility rules and click behaviour |
| `web/src/components/RevealMounts.test.tsx` | create | the button shows up in the card meta row, the modal toolbar and the editor strip |

## Implementation Steps

### Step 1: API calls
**File:** `web/src/api.ts`, appended at the end of the file (today after line 71, the `originalUrl` helper; phases 6–8 replace the URL helpers and add `attachImage`, `removeImage`, `fetchBin` and so on, and these go after all of that).
**Change:** add the capabilities type and two calls. Both go through the existing `check()` so non-2xx responses throw `ApiError`. `revealImage` does not read the 202 body. The browser adds the `Origin` header to a same-origin POST, which is what phase 5's `sameOriginOnly` checks.
**Code:**
```ts
/** Phase 9: what this notesd can do on this machine (`GET /api/capabilities`). */
export interface Capabilities {
  /** True only when notesd runs under WSL with interop and can launch explorer.exe. */
  reveal: boolean;
}

/** Phase 9: `GET /api/capabilities` → `{ reveal }`. Anything other than `reveal: true` reads as false. */
export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await check(await fetch('/api/capabilities'));
  const j: unknown = await res.json();
  const reveal = !!j && typeof j === 'object' && (j as { reveal?: unknown }).reveal === true;
  return { reveal };
}

/** Phase 9: `POST /api/images/<imageId>/reveal` → 202. notesd spawns Explorer and does not wait for it. */
export async function revealImage(imageId: string): Promise<void> {
  await check(await fetch(`/api/images/${enc(imageId)}/reveal`, { method: 'POST' }));
}
```
**Impact:** additive only.

### Step 2: Capabilities store + hook
**File:** `web/src/hooks/useCapabilities.ts` (new)
**Change:** a tiny external store. The first component that mounts starts the one fetch for the page. Every `RevealButton` subscribes with `useSyncExternalStore`. Before the fetch resolves and after any failure, the value is `NO_CAPABILITIES` (`{ reveal: false }`). Listeners are only notified when the value actually changes, so the common failure in tests (a relative `fetch` with no server, or a stub that returns 404) causes no re-render and no `act()` warning.
**Code:**
```ts
import { useEffect, useSyncExternalStore } from 'react';
import { fetchCapabilities, type Capabilities } from '../api';

/** What the page assumes until notesd answers, and keeps if it never does. */
export const NO_CAPABILITIES: Capabilities = Object.freeze({ reveal: false });

let current: Capabilities = NO_CAPABILITIES;
let started = false;
const listeners = new Set<() => void>();

function publish(next: Capabilities): void {
  if (next.reveal === current.reveal) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): Capabilities {
  return current;
}

/** Starts the single `GET /api/capabilities` of this page; later calls are no-ops. Errors leave `{ reveal: false }`. */
export function loadCapabilities(): void {
  if (started) return;
  started = true;
  fetchCapabilities().then(publish, () => {
    // Quiet by design: no capabilities endpoint (older daemon, offline) simply means no reveal icon.
  });
}

/** The daemon's capabilities, fetched once per page. `{ reveal: false }` until known and on any error. */
export function useCapabilities(): Capabilities {
  useEffect(() => {
    loadCapabilities();
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Tests only. With no argument: forget the fetch so the next mount fetches again, value back to false.
 * With a value: prime the store with it and mark the fetch as done, so nothing is fetched.
 */
export function resetCapabilitiesForTests(next?: Capabilities): void {
  started = next !== undefined;
  current = next ? { reveal: next.reveal } : NO_CAPABILITIES;
  for (const l of listeners) l();
}
```
**Impact:** new file. Any test that renders a `RevealButton` (through NoteCard, PhotoModal or NoteEditor) without priming the store makes one `fetch('/api/capabilities')` per test file. See Verification for what that means for tests that count fetch calls.

### Step 3: RevealButton
**File:** `web/src/components/RevealButton.tsx` (new)
**Change:** an icon-only button with no text (invariant 5). The hook runs before the early return so the hook order never changes. The default class is the wall card's `copybtn`; the modal passes `pm-btn` + `toolBtn`, and the editor strip passes its own icon class. `stopPropagation` keeps the click from reaching card-edit, modal-close or strip handlers. If the POST fails, one `console.warn` is logged and nothing shows in the UI, since the server judges success by the spawn alone (R4).
**Code:**
```tsx
import type { CSSProperties, MouseEvent } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import { revealImage } from '../api';
import { useCapabilities } from '../hooks/useCapabilities';

export interface RevealButtonProps {
  /** The image to reveal. Structural so the wire `NoteImage` (and test fixtures) fit. */
  image: { id: string; available: boolean };
  /** Icon-button class of the host toolbar: `copybtn` on cards (default), `pm-btn` in the modal. */
  className?: string;
  style?: CSSProperties;
}

/** "Show in Explorer": rendered only when notesd can reveal files and this image's original is on this machine. */
export function RevealButton({ image, className = 'copybtn', style }: RevealButtonProps) {
  const caps = useCapabilities();
  if (!caps.reveal || !image.available) return null;

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    revealImage(image.id).catch((err: unknown) => {
      console.warn(`reveal ${image.id} failed:`, err instanceof Error ? err.message : err);
    });
  };

  return (
    <button
      type="button"
      className={className}
      data-tip="Show in Explorer"
      aria-label="Show in Explorer"
      data-reveal={image.id}
      onClick={onClick}
      style={style}
    >
      <FolderOpen weight="duotone" />
    </button>
  );
}
```
**Impact:** new file. `FolderOpen` exists in `@phosphor-icons/react@2.1.10` (`dist/csr/FolderOpen.es.js`).

### Step 4: Mount on wall photo cards
**File:** `web/src/components/NoteCard.tsx`, import block (lines 1–6) and the `.card-meta` row (today lines 76–92). After phases 6–8 the row reads: id span, Copy button, `copied` span, the `card-date` span (`margin-left: auto`), phase 7's `ArrowsOutSimple` button (`Expand note`), then phase 8's `Trash` button (`Delete note`). The reveal button goes right after the `copied` span, so it stays with the id/copy group on the left and the date still pushes the expand/trash pair to the right.
**Change:** add one import line. Then insert one JSX expression right after `<span className={copied ? 'copied on' : 'copied'}>copied</span>`. The cover is `note.images[0]` (phase 6), so that is the image the card reveals. Text notes (`images.length === 0`) render nothing. Nothing else in the file changes.
**Code (import, added after `import { NoteImage } from './NoteImage';`):**
```tsx
import { RevealButton } from './RevealButton';
```
**Code (inserted on the line after the `copied` span inside `.card-meta`):**
```tsx
          {note.images.length > 0 && <RevealButton image={note.images[0]} />}
```
**Impact:** `NoteCard` is `memo`'d. The store subscription lives inside `RevealButton`, so a capabilities change re-renders only the buttons, not the cards.

### Step 5: Mount in the photo modal toolbar
**File:** `web/src/components/PhotoModal.tsx`, import block (lines 1–5) and the toolbar `<div style={{ display: 'flex', gap: 2, justifyContent: 'flex-end' }}>` (today lines 119–129). Phase 6 names the current `PhotoItem` `item` and, after the `if (!item) return null;` guard, destructures `const { note, image } = item;` (phase-6.md Step 8). `image` is the shown image.
**Change:** add one import line. Insert the button right after the `Copy ID` button and before `Show full screen`. Phase 8's `Trash` stays where phase 8 put it.
**Code (import, added after the `NoteImage` import line):**
```tsx
import { RevealButton } from './RevealButton';
```
**Code (inserted immediately after the closing `</button>` of the `Copy ID` button):**
```tsx
          <RevealButton image={image} className="pm-btn" style={toolBtn} />
```
**Impact:** the toolbar sits inside the `onClick={stop}` column. `RevealButton` also stops propagation itself, so the modal never closes on a reveal click. Stepping to an image on another machine (`available: false`) removes the icon.

### Step 6: Mount in the editor image strip
**File:** `web/src/components/NoteEditor.tsx` (created by phase 7, Trash added by phase 8): the import block, and the JSX that maps `note.images` to strip items, each with a remove-image icon button.
**Change:** add one import line. Inside each `.ed-thumb`, insert one `RevealButton` right after the `<NoteImage …/>` and before the `.ed-rm` remove button. It takes the remove button's class `ed-rm` (same size, hover reveal and colours) plus `ed-reveal`, which moves it one button to the left. `img` is phase 7's map variable.
**Code (import):**
```tsx
import { RevealButton } from './RevealButton';
```
**Code (inserted inside `<div className="ed-thumb" …>`, before `<button type="button" className="ed-rm" …>`):**
```tsx
                <RevealButton image={img} className="ed-rm ed-reveal" />
```
**File:** `web/src/components/NoteEditor.css`, append:
```css
/* Phase 9: "Show in Explorer" sits left of the remove icon (26px button + 4px gap). */
.ed-reveal { right: 34px; }
```
**Impact:** each strip image gets its own icon, and images that are not on this machine get none. Clicking it does not remove the image, because of `stopPropagation`, and it does not move focus out of the dialog in a way that matters: the editor saves on blur/close (R2), and a save from that blur is harmless.

### Step 7: Hook tests
**File:** `web/src/hooks/useCapabilities.test.tsx` (new; `.tsx` because the unit include glob is `web/src/**/*.test.tsx`)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { resetCapabilitiesForTests, useCapabilities } from './useCapabilities';

function Probe({ label }: { label: string }) {
  const caps = useCapabilities();
  return <span data-testid={label}>{caps.reveal ? 'yes' : 'no'}</span>;
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetCapabilitiesForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCapabilitiesForTests();
});

describe('useCapabilities', () => {
  it('fetches GET /api/capabilities once for the whole page, however many components ask', async () => {
    fetchMock.mockResolvedValue(json({ reveal: true }));
    const { getByTestId } = render(
      <>
        <Probe label="a" />
        <Probe label="b" />
      </>,
    );
    expect(getByTestId('a').textContent).toBe('no');
    await waitFor(() => expect(getByTestId('a').textContent).toBe('yes'));
    expect(getByTestId('b').textContent).toBe('yes');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/capabilities');

    render(<Probe label="c" />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays { reveal: false } when the request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    const { getByTestId } = render(<Probe label="a" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(getByTestId('a').textContent).toBe('no');
  });

  it('stays { reveal: false } on a non-2xx answer or a payload without reveal: true', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'not_found' }, 404));
    const first = render(<Probe label="a" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(first.getByTestId('a').textContent).toBe('no');
    cleanup();

    resetCapabilitiesForTests();
    fetchMock.mockResolvedValueOnce(json({ reveal: 'yes' }));
    const second = render(<Probe label="b" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(second.getByTestId('b').textContent).toBe('no');
  });

  it('a primed store does not fetch', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { getByTestId } = render(<Probe label="a" />);
    expect(getByTestId('a').textContent).toBe('yes');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

### Step 8: RevealButton tests (the contract's visibility rules)
**File:** `web/src/components/RevealButton.test.tsx` (new)
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { RevealButton } from './RevealButton';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

function stubServer(reveal: boolean, revealStatus = 202) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/capabilities') return json({ reveal });
    if (url.endsWith('/reveal')) return revealStatus === 202 ? json({ ok: true }, 202) : json({ error: 'spawn_failed', message: 'boom' }, revealStatus);
    return json({ error: 'not_found' }, 404);
  });
}

beforeEach(() => {
  resetCapabilitiesForTests();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

describe('RevealButton', () => {
  it('renders nothing when the daemon cannot reveal (caps.reveal false)', async () => {
    stubServer(false);
    const { container } = render(<RevealButton image={{ id: 'A-B32', available: true }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/capabilities'));
    await Promise.resolve();
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders nothing for an image whose original is not on this machine', async () => {
    stubServer(true);
    const { container } = render(<RevealButton image={{ id: 'A-B32', available: false }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/capabilities'));
    await Promise.resolve();
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the FolderOpen icon with the tooltip when both hold, no text', async () => {
    stubServer(true);
    const { findByLabelText } = render(<RevealButton image={{ id: 'A-B32', available: true }} />);
    const btn = await findByLabelText('Show in Explorer');
    expect(btn.getAttribute('data-tip')).toBe('Show in Explorer');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
    expect(btn.className).toBe('copybtn');
  });

  it('click POSTs /api/images/<id>/reveal and does not reach the parent', async () => {
    stubServer(true);
    const parent = vi.fn();
    const { findByLabelText } = render(
      <div onClick={parent}>
        <RevealButton image={{ id: 'C-D45', available: true }} className="pm-btn" />
      </div>,
    );
    const btn = await findByLabelText('Show in Explorer');
    expect(btn.className).toBe('pm-btn');
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/images/C-D45/reveal');
    expect(init.method).toBe('POST');
    expect(parent).not.toHaveBeenCalled();
  });

  it('a failed reveal only logs a quiet warning', async () => {
    stubServer(true, 500);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { findByLabelText } = render(<RevealButton image={{ id: 'C-D45', available: true }} />);
    fireEvent.click(await findByLabelText('Show in Explorer'));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0][0])).toContain('C-D45');
    expect(String(warn.mock.calls[0][1])).toBe('spawn_failed');
  });
});
```

### Step 9: Mount-point tests
**File:** `web/src/components/RevealMounts.test.tsx` (new). The fixtures follow the contract wire shape (`Note.images: NoteImage[]`, `PhotoItem`). Props for the three hosts are cast with `as`, because phases 6–8 add callbacks (`onExpand`, `onDelete`, …) that these tests never call. If phase 7/8 made a prop required that is *read during render* and is not a callback (e.g. a non-optional array), add it to the literal. Callbacks can stay missing. The store is primed, so no capabilities fetch happens. `fetch` is still stubbed, so `NoteImage` effects or anything else that touches it cannot reach the network.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Note, NoteImage as NoteImageData, PhotoItem } from '../types';
import { makeImage, makeNote } from '../testing/fixtures';
import { NoteCard, type NoteCardProps } from './NoteCard';
import { PhotoModal, type PhotoModalProps } from './PhotoModal';
import { NoteEditor, type NoteEditorProps } from './NoteEditor';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const iso = '2026-10-30T01:00:00.000Z';

// Phase 6's shared fixtures (web/src/testing/fixtures.ts).
function img(id: string, noteId: string, position: number, available = true): NoteImageData {
  return makeImage(id, { note_id: noteId, position, bytes: 10, original_name: `${id}.jpg`, host: available ? 'lenovo' : 'thinkpad', available });
}

function note(id: string, images: NoteImageData[]): Note {
  return makeNote(id, 'River #walks', { images, created: iso });
}

const reveals = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]')).map((b) => b.dataset.reveal);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCapabilitiesForTests();
});

function renderCard(n: Note) {
  const props = {
    note: n,
    now: new Date(iso),
    editing: false,
    dim: false,
    used: false,
    copied: false,
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onCommit: vi.fn(),
    onToggleTag: vi.fn(),
  } as NoteCardProps;
  return render(<NoteCard {...props} />);
}

describe('reveal mount points', () => {
  it('wall card: one icon in the meta row, for the cover image, when caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1)]));
    const meta = container.querySelector('.card-meta') as HTMLElement;
    expect(reveals(meta)).toEqual(['K-F07']);
  });

  it('wall card: none for a text note, none when caps.reveal is false, none when the cover is elsewhere', () => {
    resetCapabilitiesForTests({ reveal: true });
    const text = renderCard(note('A-B32', []));
    expect(reveals(text.container)).toEqual([]);
    text.unmount();

    const away = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0, false)]));
    expect(reveals(away.container)).toEqual([]);
    away.unmount();

    resetCapabilitiesForTests({ reveal: false });
    const off = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0)]));
    expect(reveals(off.container)).toEqual([]);
  });

  it('photo modal: the toolbar reveals the current image, not the note cover', () => {
    resetCapabilitiesForTests({ reveal: true });
    const n = note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1)]);
    const items: PhotoItem[] = [
      { note: n, image: n.images[0], k: 1, n: 2 },
      { note: n, image: n.images[1], k: 2, n: 2 },
    ];
    const props = {
      items,
      index: 1,
      onIndex: vi.fn(),
      onClose: vi.fn(),
      copiedId: null,
      onCopy: vi.fn(),
    } as PhotoModalProps;
    render(<PhotoModal {...props} />);
    const btn = document.querySelector('[data-modal="photo"] [data-reveal]') as HTMLElement;
    expect(btn.dataset.reveal).toBe('M-Q11');
    expect(btn.className).toBe('pm-btn');
    expect(btn.getAttribute('data-tip')).toBe('Show in Explorer');
  });

  it('editor strip: one icon per local image, none for an image on another machine', () => {
    resetCapabilitiesForTests({ reveal: true });
    const n = note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1, false), img('P-R22', 'K-F07', 2)]);
    const props = { note: n } as NoteEditorProps;
    render(<NoteEditor {...props} />);
    expect(reveals(document.body)).toEqual(['K-F07', 'P-R22']);
  });

  it('editor strip: no icons when caps.reveal is false', () => {
    resetCapabilitiesForTests({ reveal: false });
    const n = note('K-F07', [img('K-F07', 'K-F07', 0), img('P-R22', 'K-F07', 1)]);
    const props = { note: n } as NoteEditorProps;
    render(<NoteEditor {...props} />);
    expect(reveals(document.body)).toEqual([]);
  });
});
```
**Impact:** these tests depend on the export names phases 6–7 use (`PhotoItem` and `NoteImage` from `../types`, `NoteCardProps`, `PhotoModalProps`, `NoteEditorProps`), all confirmed in their plans. `NoteEditor` itself renders inline (App portals it), so the `document.body` queries cover it either way.

## Verification

**Build:** `npm run typecheck && npm run build:web`
**Tests:** `npm test`; also `npm run test:int` (invariant 1; this phase changes no server code, so it should stay green unchanged)
**Existing-test interaction:** every test that renders an image card, the modal or the editor without priming the store now makes one `fetch('/api/capabilities')` per test file, because the store is module-level and vitest isolates modules per file. If the URL hits nothing, the result is `{ reveal: false }`: a relative URL rejects under jsdom, and App.test's stub returns 404. So no button appears, button counts do not change, and no state update fires. The only test that could break is one that renders an *available* image in NoteCard/PhotoModal/NoteEditor **and** asserts an exact global `fetch` call count, most likely in phase 7's `NoteEditor.test.tsx` (attach) or phase 8's tests (delete/restore). If one fails that way, add `resetCapabilitiesForTests({ reveal: false })` to its `beforeEach` (import from `../hooks/useCapabilities`). That is a one-line, test-only change, and it should be named in the commit message. Do not loosen its assertions.
**Manual check:** with the daemon on WSL (`npm run build && npm start`, or the installed unit after `scripts/install.sh`), open `http://127.0.0.1:7317/` and switch to Everything or Photos. The folder icon shows on photo cards, in the modal toolbar and in the editor strip, and clicking it opens Explorer with the original selected. Images whose `host` is the other laptop show no icon. `curl -s 127.0.0.1:7317/api/capabilities` should print `{"reveal":true}` on WSL. `npm run dev:web` works too: its proxy has no `changeOrigin`, so notesd sees `Host` and `Origin` both as the Vite origin (`127.0.0.1:5173`) and `sameOriginOnly` passes (index Decisions; `web/vite.config.ts` is not changed).
**Exit criteria:** the RevealButton tests prove all four contract rules (caps false → none; unavailable → none; both true → `FolderOpen` with `data-tip="Show in Explorer"`; click → `POST /api/images/<id>/reveal`). The mount tests show the icon in the card meta row (cover image), the modal toolbar (current image) and the editor strip (per local image). The full unit suite, typecheck and web build are green.

## Handoffs

- **Phase 5 (R4, reconciled):** the Vite dev proxy keeps the browser's `Host` (no `changeOrigin`), so `Origin` and the request URL agree and reveal/purge work under `npm run dev:web` with no `web/vite.config.ts` change. Never add `changeOrigin: true` to that proxy.
- **Phase 10 (R5 docs):** the README should name the folder icon (photo cards, modal, editor strip), say it appears only on WSL with interop for images stored on this laptop, and list `GET /api/capabilities` and `POST /api/images/:id/reveal` in the API table.
- **Gallery tiles (reconciled, accepted):** no reveal icon on "Photos." gallery tiles. R4 names photo cards, the photo modal and the editor strip; a tile is itself the click target that opens the modal, whose toolbar has the icon. Recorded in the index Decisions.
- **Phase 7/8 tests:** see "Existing-test interaction" above. Only if a fetch-count assertion breaks, those tests get a one-line `beforeEach` prime.

## Rollback

Revert the phase 9 commit. That deletes `useCapabilities.ts`, `RevealButton.tsx` and the three new test files, and removes the three one-line mounts, three imports and the `api.ts` additions. No other phase depends on these symbols; phase 10 only documents them. Server endpoints from phase 5 stay and are harmless without a caller.
