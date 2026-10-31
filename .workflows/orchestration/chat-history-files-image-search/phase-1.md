# Phase 1: Card footer: reveal button left

**Plan set:** `CHAT_HISTORY_FILES_IMAGE_SEARCH_PLAN.md`
**Analysis:** `docs/analyzer/20261031-081555-Q4TD_code_analyzer.md`
**Satisfies:** R6 — "Show in explorer" sits on the left of the note card footer, right after the copy-ID button
**Depends on:** none
**Difficulty:** EASY
**Package:** `web`

---

## Goal

Today the card footer renders `id, copy, .copied, reveal, date(margin-left:auto), expand, trash`.
`.copied` is an opacity-only span (`styles.css:98-99`), so even while invisible it still takes up the
width of the word "copied" between the copy button and the reveal button. That gap makes the folder
icon look centered. After this phase the footer DOM order is `id, copy, reveal, copied, date, expand, trash`.
The reveal button sits right after the copy button (4px flex gap), and the "copied" label
appears after it without moving it. What the button does is unchanged.

## Interface Contract

**Deletes:** none
**Renames:** none
**Creates:** none (test cases only)
**Signature changes:** none. `NoteCardProps` and `RevealButtonProps` are unchanged.
**Requires (from earlier phases):** nothing
**Leaves alone (owned by others):**
- `RevealButton` behavior and props (`web/src/components/RevealButton.tsx`). The note-level reveal route/behavior belongs to Phase 5.
- The card still passes `note.images[0]` to `RevealButton`. Phase 5 replaces this with the note-level reveal. Phase 1 only moves the JSX element.
- PhotoModal and NoteEditor reveal buttons (Phase 2 / Phase 5).
- `web/src/styles.css`: **no change.** Moving the element is enough, because `.card-date { margin-left: auto }` still pushes date/expand/trash to the right, and `.copied` keeps reserving its own width *after* the reveal button, where that width does no harm. The index listed `styles.css` among this phase's files, but no edit is needed. The reconciler can drop it from the file count.

**Contract for Phase 5 (it edits the same footer):** in the `.card-meta` element the reveal button is the
third child, right after the `Copy ID` button and before `span.copied`. Phase 5 should put its note-level
reveal button in that same slot (and its paperclip count, if it goes in the footer, after the reveal button or
next to the date, but **not** between copy and reveal). The new `NoteCard.test.tsx` order test will tell
Phase 5 if it gets this wrong. Phase 5 must update that test's expected sequence if it changes the label or adds a child.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/components/NoteCard.tsx` | modify (lines 122-123) | render `<RevealButton>` before `<span className="copied">` |
| `web/src/components/NoteCard.test.tsx` | modify (imports lines 1-7, new `describe` after line 146) | add DOM-order tests with reveal on/off |
| `web/src/components/RevealMounts.test.tsx` | modify (lines 52-57) | wall-card test also checks the reveal button comes right after Copy ID |
| `CHANGELOG.md` | modify (insert before line 8) | `## [Unreleased]` / `### Fixed` line (Invariant 9) |

`web/src/App.test.tsx`, `App.bin.test.tsx`, `App.deeplink.test.tsx` and `RevealButton.test.tsx` do not check footer order, `.copied` placement or reveal placement (checked with grep for `copied|card-meta|Show in Explorer|card-date`). They need no change.

## Implementation Steps

### Step 1: Render the reveal button before the "copied" label
**File:** `web/src/components/NoteCard.tsx:122-123`
**Change:** swap the two lines. Current:
```tsx
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          {note.images.length > 0 && <RevealButton image={note.images[0]} />}
```
**Code:** replacement (the two lines become):
```tsx
          {/* Reveal sits right after copy: the "copied" label reserves its width even while hidden, so it goes after. */}
          {note.images.length > 0 && <RevealButton image={note.images[0]} />}
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
```
The resulting `.card-meta` block (lines 108-157), in full:
```tsx
        <div className="card-meta">
          <span className="card-id">{note.id}</span>
          <button
            type="button"
            className="copybtn"
            data-tip="Copy ID"
            aria-label="Copy ID"
            onClick={(e) => {
              e.stopPropagation();
              onCopy(note.id);
            }}
          >
            {copied ? <Check weight="duotone" /> : <Copy weight="duotone" />}
          </button>
          {/* Reveal sits right after copy: the "copied" label reserves its width even while hidden, so it goes after. */}
          {note.images.length > 0 && <RevealButton image={note.images[0]} />}
          <span className={copied ? 'copied on' : 'copied'}>copied</span>
          <span className="card-date">{relativeDate(note.created_at, now)}</span>
          <button
            type="button"
            className="copybtn"
            data-tip="Expand note"
            aria-label="Expand note"
            onMouseDown={(e) => {
              // Keep focus in the inline editor: a blur here would commit (and delete an empty new note).
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onExpand(note, editing ? draftRef.current : null);
            }}
          >
            <ArrowsOutSimple weight="duotone" />
          </button>
          {onDelete && (
            <button
              type="button"
              className="copybtn"
              data-tip="Delete note"
              aria-label="Delete note"
              // Keep focus where it is: an open inline editor must not blur-commit (or empty-delete) the note being deleted.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(note);
              }}
            >
              <Trash weight="duotone" />
            </button>
          )}
        </div>
```
**Impact:** visual only. For notes with images, the folder icon moves left next to the copy icon, and "copied" now shows after the folder icon. Text-only notes look exactly as before (`id, copy, copied, date, …`). The total footer width is unchanged, so cards do not reflow.

### Step 2: Add DOM-order tests to `NoteCard.test.tsx`
**File:** `web/src/components/NoteCard.test.tsx:1-7` (imports) and after line 146 (new `describe`)
**Change:** import `resetCapabilitiesForTests`. Add a `describe('NoteCard footer order')` block that turns reveal on (so `RevealButton` renders without fetching) and checks the full child sequence of `.card-meta`.

Imports (replace lines 1-7):
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note } from '../types';
import { NoteCard } from './NoteCard';
import type { NoteCardProps } from './NoteCard';
import { makeNote } from '../testing/fixtures';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';
```

Append after the closing `});` of `describe('NoteCard', …)` (current line 146):
```tsx
/** The footer's children in order: aria-label for buttons, first class name for spans. */
function footerSequence(container: HTMLElement): string[] {
  const meta = container.querySelector('.card-meta') as HTMLElement;
  return Array.from(meta.children).map((el) => el.getAttribute('aria-label') ?? el.className.split(' ')[0]);
}

describe('NoteCard footer order', () => {
  afterEach(() => resetCapabilitiesForTests());

  it('puts Show in Explorer right after Copy ID, before the copied label, with the date on the right', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('pic', ['A-B32']), { onDelete: vi.fn() });
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'Show in Explorer', 'copied', 'card-date', 'Expand note', 'Delete note']);
  });

  it('keeps the reveal button in place while the copied label is showing', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container, getByLabelText } = renderCard(note('pic', ['A-B32']), { copied: true });
    const reveal = getByLabelText('Show in Explorer');
    expect(reveal.previousElementSibling?.getAttribute('aria-label')).toBe('Copy ID');
    const label = reveal.nextElementSibling as HTMLElement;
    expect(label.className).toBe('copied on');
    expect(label.nextElementSibling?.className).toBe('card-date');
  });

  it('a text note has no reveal button and keeps id, copy, copied, date', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('just text'));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'copied', 'card-date', 'Expand note']);
  });

  it('without the reveal capability the footer is id, copy, copied, date', () => {
    resetCapabilitiesForTests({ reveal: false });
    const { container } = renderCard(note('pic', ['A-B32']));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'copied', 'card-date', 'Expand note']);
  });
});
```
Notes for the implementer: `renderCard`, `note` and `now` are the existing module-level helpers in this file
(lines 11-32). `makeNote` with string image ids builds `available: true` images (`testing/fixtures.ts:43`), so
`RevealButton` renders when `reveal: true`. `resetCapabilitiesForTests({ reveal })` marks the fetch done, so
these cases make no network call. The existing `afterEach(cleanup)` at line 9 still runs.
**Impact:** test-only. If you run these against the old `NoteCard.tsx`, the first two cases fail (sequence `…'Copy ID', 'copied', 'Show in Explorer'…`), so the test catches the bug.

### Step 3: Tighten the wall-card mount test
**File:** `web/src/components/RevealMounts.test.tsx:52-57`
**Change:** after the existing `reveals(meta)` assertion, also check the button's position.
**Code:** replace the whole `it` block:
```tsx
  it('wall card: one icon in the meta row, for the cover image, when caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1)]));
    const meta = container.querySelector('.card-meta') as HTMLElement;
    expect(reveals(meta)).toEqual(['K-F07']);
    // Left-aligned: right after the copy-ID button, ahead of the (width-reserving) copied label.
    const btn = meta.querySelector('[data-reveal]') as HTMLElement;
    expect(btn.previousElementSibling?.getAttribute('aria-label')).toBe('Copy ID');
    expect(btn.nextElementSibling?.classList.contains('copied')).toBe(true);
  });
```
**Impact:** test-only.

### Step 4: Changelog line
**File:** `CHANGELOG.md:8` (insert above `## [v0.1.0] - 2026-10-30`)
**Code:**
```markdown
## [Unreleased]

### Fixed

- Wall card footer: the "Show in Explorer" icon now sits right after the copy-ID icon instead of floating mid-footer.

```
Create `## [Unreleased]` and `### Fixed` only if they are missing (Phases 2 and 3 run in the same wave and may have added `## [Unreleased]` first); otherwise add only the bullet under the existing heading. When the wave merges, the integrator keeps exactly one `## [Unreleased]` with one `### Added` and one `### Fixed`.
**Impact:** docs only. See Handoffs about the shared `## [Unreleased]` header.

## Verification

Worktree setup (Invariant 10), if not done: `cd /home/miftah/.worktrees/mcp-notes/chat-history-files-image-search && [ -d node_modules ] || npm ci; [ -e .env.local ] || ln -s ~/mcp-notes/.env.local .env.local`

**Build:** `npm run typecheck && npm run build`
**Tests:**
- `npx vitest run web/src/components/NoteCard.test.tsx web/src/components/RevealMounts.test.tsx web/src/components/RevealButton.test.tsx web/src/App.test.tsx`
- `npm test`
- `npm run test:int` (Invariant 1. Nothing server-side changes, so it should pass as-is.)

**Manual check:** `npm run dev` (or the running daemon at http://localhost:7317 after `npm run build`). On an image note whose original is on this machine, the footer reads `K-F07 [copy] [folder] … just now [expand] [trash]` with the folder icon right next to the copy icon. Click copy: "copied" fades in to the right of the folder icon and the folder icon does not move. Text notes look as before.
**Exit criteria:** footer order is id, copy, reveal, copied label, date-right. The new `NoteCard footer order` tests pass. The full `npm test`, `npm run test:int`, `npm run typecheck` and `npm run build` are green.

## Handoffs

- **Phase 5 (R2):** owns changing the card reveal from `note.images[0]` to the note-level reveal, and any paperclip count. Keep the reveal in the slot right after `Copy ID` and update `footerSequence` expectations in `NoteCard.test.tsx` if the footer gains children. Also, `NoteCard` passes `note.images[0]` while the cover uses the first *available* image (`shown[0]`). That mismatch is pre-existing and left alone here, because the reveal target is P5's to decide.
- **Reconciler / all phases (Invariant 9):** `CHANGELOG.md` has no `## [Unreleased]` section today. This phase creates `## [Unreleased]` + `### Fixed`. Phases in the same wave (2, 3) will probably also create the header. On merge, keep one `## [Unreleased]` and put each phase's line under the right `### Added/Fixed` subsection.
- **Reconciler:** the index row for Phase 1 says 3 files. The real set is 4 (`NoteCard.tsx`, `NoteCard.test.tsx`, `RevealMounts.test.tsx`, `CHANGELOG.md`), and `styles.css` is not touched.

## Rollback

`git revert <phase-1 commit>`. Or swap lines 122-123 of `web/src/components/NoteCard.tsx` back, delete the `NoteCard footer order` block and the `resetCapabilitiesForTests` import from `NoteCard.test.tsx`, drop the three added lines in the `RevealMounts.test.tsx` wall-card case, and remove the changelog entry. No data, schema or API is involved.
