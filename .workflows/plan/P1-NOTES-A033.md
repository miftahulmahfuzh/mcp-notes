> Adopted from `/home/miftah/.worktrees/mcp-notes/wall-editing/.workflows/orchestration/wall-editing/PLAN.md` phase 11. Source: `.workflows/plan/wall-editing/phase-11.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 11: Collapsible answer panel + multi-line chat bar

**Plan set:** `WALL_EDITING_PLAN.md`
**Analysis:** `docs/analyzer/20261030-153729-W7ED_code_analyzer.md`
**Satisfies:** R6, R7, R5 (this phase's own tests). R6: the answer panel can be collapsed to its header line and expanded again. R7: the chat bar is a multi-line textarea, and the panel header shows the query on one line.
**Depends on:** none (wave 1, runs alongside phases 1 and 6–9)
**Difficulty:** NORMAL
**Package:** `web/src`

---

## Goal

The answer panel gets a caret icon that collapses it to one header line ("query · status/brain" plus its icons) sitting above the chat bar. Clicking that line expands it again. Streaming, pin, dismiss, Esc and the wall highlight work as before. The chat bar becomes an auto-growing textarea: Enter sends, Shift+Enter adds a newline, and Enter during IME composition does nothing. It grows to 6 lines and then scrolls, shrinks back after sending, and publishes its height as `--chatbar-h` so the panel (and phase 8's UndoBar) always sit above it. The panel header shows the query on one line, cut with an ellipsis, with the full query in its tooltip.

## Interface Contract

**Deletes:** CSS rule `.chatbar input` (`web/src/styles.css:118`), replaced by `.chatbar textarea` in `web/src/components/ChatBar.css`. The `<input>` element inside `ChatBar` becomes a `<textarea>`.
**Renames:** none
**Creates:**
- `oneLine(s: string): string` (`web/src/lib/oneLine.ts`, new file; not `text.ts`, which phase 6 is editing)
- `web/src/lib/oneLine.test.tsx` (new)
- `web/src/components/ChatBar.css` (new; imported by `ChatBar.tsx`)
- `web/src/components/ChatBar.test.tsx` (new)
- exported constants `CHAT_LINE_PX = 20`, `CHAT_PAD_Y_PX = 20`, `CHAT_MAX_LINES = 6` (`web/src/components/ChatBar.tsx`)
- CSS custom property `--chatbar-h` on `document.documentElement`, set by `ChatBar`. Value is `"<n>px"`: 54px for one line, up to 154px at the 6-line cap. Unset until ChatBar mounts, so consumers must use `var(--chatbar-h, 54px)`. Phase 8's UndoBar reads it.
- `ChatState.collapsed: boolean`, `Chat.toggleCollapsed(): void` (`web/src/hooks/useChat.ts`)
- `AnswerPanelProps.collapsed: boolean`, `AnswerPanelProps.onToggleCollapse: () => void` (`web/src/components/AnswerPanel.tsx`)
- class `.answer.collapsed` on the panel root when collapsed

**Signature changes:**
- `AnswerPanel(props)` gains two **required** props, `collapsed` and `onToggleCollapse`. Its only call site is `App.tsx` (updated here).
- `ChatBarProps` unchanged: `{ left, value, onChange, onSubmit }`. The `<ChatBar>` JSX in `App.tsx` is **not** edited.
- `useChat()` return value gains `collapsed` and `toggleCollapsed`. `ask` and `close` keep their signatures. `ask` still trims only the ends of the message (`message.trim()`), so inner newlines reach `postChat` unchanged.

**Requires (from earlier phases):** nothing.
**Leaves alone (owned by others):** `web/src/types.ts`, `web/src/api.ts`, `NoteImage`, `NoteCard`, `Gallery`, `PhotoModal(.css)`, Fullscreen, `lib/filter.ts`, `lib/text.ts` (phase 6); `NoteEditor`, `DropOverlay` and App's expanded editor state (phase 7); `Bin`, `UndoBar`, Rail/Sidebar trash (phase 8); `RevealButton` (phase 9); `README.md` (phase 10); `Tooltip.tsx` and the `.tip` rule; every server file (`src/chat/**`: `chatSchema` already trims only the ends). In `App.tsx` this phase touches **only** the `<AnswerPanel …/>` element. `App.send`, the Esc effect, `highlight`/`used` and the `<ChatBar>` element stay byte-identical. In `styles.css` it touches only `.answer`, `.answer-q`, `.answer-status`, `.chatbar`, `.chatbar input` and `.sendbtn`. In `App.test.tsx` it changes exactly one assertion (line 125, the header button count goes from 2 to 3).

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/lib/oneLine.ts` | create | `oneLine()` puts the query on one line |
| `web/src/lib/oneLine.test.tsx` | create | unit tests for `oneLine` |
| `web/src/hooks/useChat.ts` | modify | `collapsed` state, `toggleCollapsed`, reset in `ask` (L55) and `close` (L105-111) |
| `web/src/hooks/useChat.test.tsx` | modify | two new tests appended inside `describe('useChat')` (before the final `});`, L197) |
| `web/src/components/AnswerPanel.tsx` | modify (whole file) | caret button, collapsed rendering, head-click expands, one-line query with `data-tip` |
| `web/src/components/AnswerPanel.test.tsx` | modify | `props()` gains the new props (L10-24); new `describe('AnswerPanel collapse')` appended at EOF (after L87) |
| `web/src/components/ChatBar.tsx` | modify (whole file) | textarea, Enter/Shift+Enter/IME handling, auto-grow, `--chatbar-h` |
| `web/src/components/ChatBar.css` | create | `.chatbar textarea` rules, `.answer.collapsed` rules |
| `web/src/components/ChatBar.test.tsx` | create | Enter, Shift+Enter, pasted newlines, IME, grow cap, shrink after submit, `--chatbar-h` |
| `web/src/styles.css` | modify | L99 `.answer`, L101 `.answer-q`, L102 `.answer-status`, L117 `.chatbar`, L118 `.chatbar input` (removed), L119 `.sendbtn` |
| `web/src/App.tsx` | modify | `<AnswerPanel>` element (L182-194): add `collapsed` and `onToggleCollapse` props |
| `web/src/App.test.tsx` | modify | L125: `toHaveLength(2)` -> `toHaveLength(3)` |

Line numbers are from `main` at `920b419`. Phase 6 edits `App.tsx`, `App.test.tsx` and `styles.css` concurrently, so locate hunks by the quoted anchor text and not by line number alone.

## Implementation Steps

### Step 1: `oneLine` helper
**File:** `web/src/lib/oneLine.ts` (new)
**Change:** A pure function that joins a multi-line query into one line. It lives in its own file because phase 6 owns `lib/text.ts` in this wave.
**Code:**
```ts
/**
 * The chat query on one line, for the answer panel header (R7): every run of line breaks,
 * together with the spaces and tabs around it, becomes a single space; the ends are trimmed.
 * Spaces inside a line are left as typed.
 */
export function oneLine(s: string): string {
  return s.replace(/[ \t]*(?:\r\n|\r|\n)+[ \t]*/g, ' ').trim();
}
```
**Impact:** none; new file.

### Step 2: `oneLine` tests
**File:** `web/src/lib/oneLine.test.tsx` (new)
**Code:**
```tsx
import { describe, expect, it } from 'vitest';
import { oneLine } from './oneLine';

describe('oneLine', () => {
  it('leaves a single-line query unchanged', () => {
    expect(oneLine('cari notes yang membahas fitur')).toBe('cari notes yang membahas fitur');
  });

  it('turns each run of newlines into one space', () => {
    expect(oneLine('cari notes\nyang membahas\n\nfitur')).toBe('cari notes yang membahas fitur');
  });

  it('handles CRLF and CR line breaks and the spaces around them', () => {
    expect(oneLine('one  \r\n\r\n  two\rthree')).toBe('one two three');
  });

  it('trims leading and trailing breaks', () => {
    expect(oneLine('\n\nhello\n')).toBe('hello');
  });

  it('keeps inner spacing within a line', () => {
    expect(oneLine('a  b\nc')).toBe('a  b c');
  });
});
```

### Step 3: `useChat` gains `collapsed`
**File:** `web/src/hooks/useChat.ts`
**Change:** Four hunks:
- (a) The `ChatState` interface (L5-15) gains `collapsed`.
- (b) The `Chat` interface (L17-21) gains `toggleCollapsed`.
- (c) The initial state (L34-42) gets `collapsed: false`, and the `ask` reset (L55) sets `collapsed: false` so every new answer opens expanded.
- (d) `close` (L105-111) resets `collapsed`. Add `toggleCollapsed` next to `togglePin` and return it.

Streaming is unaffected: the reader never looks at `collapsed`.

**Code:** the full file after the change:
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { postChat } from '../api';
import { readSSE } from '../lib/sse';

export interface ChatState {
  open: boolean;
  pinned: boolean;
  /** Panel folded to its header line (R6). Every new answer and every dismiss reset it to false. */
  collapsed: boolean;
  query: string;
  text: string;
  done: boolean;
  /** Terse tool caption while the brain works ("searching notes"); '' when there is none. */
  status: string;
  /** Which brain answered ('claude' | 'glm'), from `done.brain`; null when the server named none. */
  brain: string | null;
}

export interface Chat extends ChatState {
  ask: (message: string) => Promise<void>;
  close: () => void;
  togglePin: () => void;
  toggleCollapsed: () => void;
}

function parse(data: string): Record<string, unknown> {
  try {
    const j: unknown = JSON.parse(data);
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function useChat(): Chat {
  const [st, setSt] = useState<ChatState>({
    open: false,
    pinned: false,
    collapsed: false,
    query: '',
    text: '',
    done: false,
    status: '',
    brain: null,
  });
  const threadId = useRef<string | undefined>(undefined);
  const ctrl = useRef<AbortController | null>(null);

  const ask = useCallback(async (message: string) => {
    // Only the ends are trimmed: newlines inside a multi-line message (R7) reach /api/chat intact.
    const q = message.trim();
    if (!q) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setSt((s) => ({ ...s, open: true, collapsed: false, query: q, text: '', done: false, status: '', brain: null }));

    const finish = (extra?: string, brain: string | null = null) => {
      if (ctrl.current !== c) return;
      setSt((s) => ({
        ...s,
        done: true,
        status: '',
        brain,
        text: extra ? (s.text ? `${s.text}\n\n${extra}` : extra) : s.text,
      }));
    };

    try {
      const res = await postChat(q, threadId.current, c.signal);
      if (!res.ok || !res.body) {
        finish(`Chat failed: ${res.status} ${res.statusText}`.trim());
        return;
      }
      let ended = false;
      await readSSE(res.body, (ev) => {
        if (ctrl.current !== c) return;
        if (ev.event === 'delta') {
          const t = parse(ev.data).text;
          if (typeof t === 'string' && t) setSt((s) => ({ ...s, text: s.text + t }));
        } else if (ev.event === 'status') {
          const t = parse(ev.data).text;
          if (typeof t === 'string') setSt((s) => ({ ...s, status: t }));
        } else if (ev.event === 'done') {
          const d = parse(ev.data);
          if (typeof d.thread_id === 'string' && d.thread_id) threadId.current = d.thread_id;
          ended = true;
          finish(undefined, typeof d.brain === 'string' && d.brain ? d.brain : null);
        } else if (ev.event === 'error') {
          const d = parse(ev.data);
          const m = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : ev.data;
          ended = true;
          finish(`Chat failed: ${m}`);
        }
      });
      if (!ended) finish();
    } catch (e) {
      if (c.signal.aborted) return;
      finish(`Chat failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const close = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    // Dismissing ends the conversation: the next message starts a new thread.
    threadId.current = undefined;
    setSt((s) => ({ ...s, open: false, pinned: false, collapsed: false, text: '', done: false, status: '', brain: null }));
  }, []);

  const togglePin = useCallback(() => setSt((s) => ({ ...s, pinned: !s.pinned })), []);

  const toggleCollapsed = useCallback(() => setSt((s) => ({ ...s, collapsed: !s.collapsed })), []);

  useEffect(() => () => ctrl.current?.abort(), []);

  return { ...st, ask, close, togglePin, toggleCollapsed };
}
```
**Impact:** `Chat` has two new members. No caller breaks: App only reads fields by name.

### Step 4: `useChat` tests
**File:** `web/src/hooks/useChat.test.tsx`: append inside `describe('useChat', …)`, just before its closing `});` (after the test `'a new ask clears the previous brain and status'`, L197). The helpers `stubChat`, `sse` and `handStream` already exist in the file.
**Code:**
```tsx
  it('every new answer opens expanded, and dismissing resets the collapse', async () => {
    stubChat(
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
    );
    const { result } = renderHook(() => useChat());
    expect(result.current.collapsed).toBe(false);
    await act(async () => {
      await result.current.ask('first');
    });
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);
    await act(async () => {
      await result.current.ask('second');
    });
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.collapsed).toBe(false);
  });

  it('collapsing does not stop a streaming answer', async () => {
    const s = handStream();
    stubChat(s.body);
    const { result } = renderHook(() => useChat());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('line one\nline two');
    });
    expect(result.current.query).toBe('line one\nline two');
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);

    s.send([{ event: 'status', data: { text: 'searching notes' } }]);
    await waitFor(() => expect(result.current.status).toBe('searching notes'));
    s.send([{ event: 'delta', data: { text: 'Found it.' } }]);
    await waitFor(() => expect(result.current.text).toBe('Found it.'));
    s.send([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.collapsed).toBe(true);
    expect(result.current.done).toBe(true);
    expect(result.current.brain).toBe('claude');
  });

  it('sends a multi-line message with its inner newlines, trimming only the ends', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('  first line\nsecond line\n\n');
    });
    expect(posted[0].message).toBe('first line\nsecond line');
  });
```

### Step 5: `AnswerPanel`: collapse, head-click expand, one-line query
**File:** `web/src/components/AnswerPanel.tsx` (whole file, currently 63 lines)
**Change:**
- New required props `collapsed` and `onToggleCollapse`.
- A caret button comes first in the header button group, before pin and dismiss: `CaretDown` with `data-tip="Collapse"` when expanded, `CaretUp` with `data-tip="Expand"` when collapsed. Duotone weight, class `pbtn hov`.
- When collapsed, the root gets class `answer collapsed` and renders only `.answer-head`: no body and no used-chips row. The caption logic stays as it is, so the status shows while streaming and the brain shows once done.
- Clicking anywhere in the head that is not a button calls `onToggleCollapse`, only while collapsed.
- The query span renders `oneLine(query)`, keeps class `answer-q` (App.test reads it), and carries `data-tip={query}` (the raw query; the custom tooltip renders it on one line). The contract reads "`data-tip`/`title`", and this plan uses `data-tip` only: a native `title` would show a second browser tooltip on top of the custom one.

**Code:**
```tsx
import { Fragment } from 'react';
import type { MouseEvent } from 'react';
import { CaretDown, CaretUp, PushPin, X } from '@phosphor-icons/react';
import { segmentLinks } from '../lib/links';
import { oneLine } from '../lib/oneLine';

export interface AnswerPanelProps {
  left: number;
  query: string;
  text: string;
  done: boolean;
  /** Tool caption while streaming; '' for none. */
  status: string;
  /** Brain that answered, shown once done; null for none. */
  brain: string | null;
  pinned: boolean;
  /** Folded to the header line alone (R6). */
  collapsed: boolean;
  usedIds: string[];
  onTogglePin: () => void;
  onToggleCollapse: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

export function AnswerPanel({
  left,
  query,
  text,
  done,
  status,
  brain,
  pinned,
  collapsed,
  usedIds,
  onTogglePin,
  onToggleCollapse,
  onClose,
  onJump,
}: AnswerPanelProps) {
  const parts = text.split('\n\n');
  const caption = done ? (brain ?? '') : status;

  // Collapsed, the whole line expands the panel; the icon buttons keep their own meaning.
  const onHeadClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!collapsed) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    onToggleCollapse();
  };

  return (
    <div className={collapsed ? 'answer collapsed' : 'answer'} style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head" onClick={onHeadClick}>
        <span className="answer-q" data-tip={query}>
          {oneLine(query)}
        </span>
        {caption && <span className="answer-status">{caption}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="pbtn hov"
          data-tip={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapse}
        >
          {collapsed ? <CaretUp weight="duotone" /> : <CaretDown weight="duotone" />}
        </button>
        <button type="button" className={pinned ? 'pbtn on' : 'pbtn'} data-tip={pinned ? 'Unpin' : 'Pin'} aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          <PushPin weight="duotone" />
        </button>
        <button type="button" className="pbtn hov" data-tip="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X weight="duotone" />
        </button>
      </div>
      {!collapsed && (
        <div className="answer-body">
          {parts.map((t, i) => {
            const streaming = !done && i === parts.length - 1;
            return (
              <p key={i}>
                {segmentLinks(t, { streaming }).map((s, j) =>
                  s.kind === 'link' ? (
                    <a key={j} className="answer-link" href={s.href} target="_blank" rel="noreferrer noopener">
                      {s.text}
                    </a>
                  ) : (
                    <Fragment key={j}>{s.text}</Fragment>
                  ),
                )}
                {streaming ? ' ▍' : ''}
              </p>
            );
          })}
        </div>
      )}
      {!collapsed && done && usedIds.length > 0 && (
        <div className="used-row">
          {usedIds.map((id) => (
            <button key={id} type="button" className="usedchip" data-tip="Show on wall" onClick={() => onJump(id)}>
              {id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```
**Impact:** `App.tsx` stops typechecking until Step 9 adds the two props, so land Steps 5 and 9 together. `App.test.tsx` L125 counts header buttons (2 -> 3) and is fixed in Step 10. Wall highlight is unchanged because App still derives it from `chat.open && chat.text` and `used`, and those don't depend on `collapsed`.

### Step 6: `AnswerPanel` tests
**File:** `web/src/components/AnswerPanel.test.tsx`
**Change (a):** L1-3 imports: add `fireEvent`, and `screen` for the role queries.
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AnswerPanel } from './AnswerPanel';
import type { AnswerPanelProps } from './AnswerPanel';
```
**Change (b):** replace `props()` (L10-24) so it supplies the new required props:
```tsx
function props(over: Partial<AnswerPanelProps> = {}): AnswerPanelProps {
  return {
    left: 0,
    query: 'what did I read',
    text: '',
    done: true,
    status: '',
    brain: null,
    pinned: false,
    collapsed: false,
    usedIds: [],
    onTogglePin: vi.fn(),
    onToggleCollapse: vi.fn(),
    onClose: vi.fn(),
    onJump: vi.fn(),
    ...over,
  };
}
```
**Change (c):** append at end of file (after the closing `});` of `describe('AnswerPanel links')`, L87):
```tsx
function head(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.answer-head');
  if (!(el instanceof HTMLElement)) throw new Error('no .answer-head');
  return el;
}

describe('AnswerPanel collapse', () => {
  it('shows a Collapse caret beside pin and dismiss while expanded', () => {
    const onToggleCollapse = vi.fn();
    const { container } = renderPanel({ text: 'An answer.', onToggleCollapse });
    const labels = [...head(container).querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Collapse', 'Pin', 'Dismiss']);
    const btn = screen.getByRole('button', { name: 'Collapse' });
    expect(btn.getAttribute('data-tip')).toBe('Collapse');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
    fireEvent.click(btn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.answer')?.className).toBe('answer');
    expect(container.querySelector('.answer-body')).not.toBeNull();
  });

  it('collapsed renders the header line only, with an Expand caret', () => {
    const { container } = renderPanel({ text: 'Look at A-B32.', usedIds: ['A-B32'], collapsed: true, brain: 'claude' });
    expect(container.querySelector('.answer')?.className).toBe('answer collapsed');
    expect(container.querySelector('.answer-body')).toBeNull();
    expect(container.querySelector('.used-row')).toBeNull();
    expect(head(container).querySelector('.answer-q')?.textContent).toBe('what did I read');
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('claude');
    const btn = screen.getByRole('button', { name: 'Expand' });
    expect(btn.getAttribute('data-tip')).toBe('Expand');
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
  });

  it('clicking the collapsed line outside the buttons expands it', () => {
    const onToggleCollapse = vi.fn();
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    const { container } = renderPanel({ collapsed: true, onToggleCollapse, onTogglePin, onClose });
    fireEvent.click(head(container).querySelector('.answer-q') as HTMLElement);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    fireEvent.click(head(container));
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(3);
  });

  it('clicking the header of an expanded panel does nothing', () => {
    const onToggleCollapse = vi.fn();
    const { container } = renderPanel({ onToggleCollapse });
    fireEvent.click(head(container).querySelector('.answer-q') as HTMLElement);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it('keeps the live status in the collapsed line while streaming, then the brain', () => {
    const { container, rerender } = renderPanel({ collapsed: true, done: false, status: 'searching notes', text: 'Partial' });
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('searching notes');
    expect(container.querySelector('.answer-body')).toBeNull();

    rerender(<AnswerPanel {...props({ collapsed: true, done: false, status: 'reading 3 notes', text: 'Partial answer' })} />);
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('reading 3 notes');

    rerender(<AnswerPanel {...props({ collapsed: true, done: true, brain: 'claude', text: 'Full answer.' })} />);
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('claude');

    rerender(<AnswerPanel {...props({ collapsed: false, done: true, brain: 'claude', text: 'Full answer.' })} />);
    expect(body(container).textContent).toBe('Full answer.');
  });

  it('shows a multi-line query on one line, with the full query in the tooltip', () => {
    const query = 'cari notes\nyang membahas\n\nfitur';
    const { container } = renderPanel({ query });
    const q = head(container).querySelector('.answer-q');
    expect(q?.textContent).toBe('cari notes yang membahas fitur');
    expect(q?.getAttribute('data-tip')).toBe(query);
  });
});
```

### Step 7: `ChatBar` becomes an auto-growing textarea
**File:** `web/src/components/ChatBar.tsx` (whole file, currently 20 lines)
**Change:**
- `<input>` becomes `<textarea rows={1}>` with the same `aria-label` and placeholder.
- Enter (no Shift, not composing, `keyCode !== 229`) calls `preventDefault()` and then `form.requestSubmit()`, so App's existing `onSubmit` (`App.send`) runs unchanged.
- Shift+Enter falls through to the browser default, which inserts a newline.
- A layout effect re-fits the height on every `value`/`left` change and on window resize. It sets the height to `auto` and reads `scrollHeight`. The height is clamped to `[1 line, 6 lines]` plus 20px vertical padding, and `overflow-y` switches to `auto` once the content passes the cap.
- The bar's height is computed from the fitted textarea height (+14px form padding, at least 54px) and not measured. That makes it deterministic in jsdom, where layout boxes are 0. It is written to `document.documentElement` as `--chatbar-h`.
- Shrinking after a send happens on its own: `App.send` sets `q` to `''`, which re-runs the fit.
- Pasted newlines are kept because the textarea value goes through `onChange` untouched.

**Code:**
```tsx
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import './ChatBar.css';

/** One text line in px; must match `.chatbar textarea { line-height }` in ChatBar.css. */
export const CHAT_LINE_PX = 20;
/** Textarea vertical padding, top + bottom, in px; must match ChatBar.css (10px + 10px). */
export const CHAT_PAD_Y_PX = 20;
/** Lines the bar grows to before it scrolls inside (R7: "about six"). */
export const CHAT_MAX_LINES = 6;
/** Form padding top + bottom around the textarea (7px + 7px in styles.css `.chatbar`). */
const BAR_PAD_Y_PX = 14;
/** The one-line pill: 40px textarea / send button + 14px padding. */
const BAR_MIN_PX = 54;

export interface ChatBarProps {
  left: number;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function ChatBar({ left, value, onChange, onSubmit }: ChatBarProps) {
  const ta = useRef<HTMLTextAreaElement>(null);

  // Grow with the content one line at a time up to CHAT_MAX_LINES, then scroll inside. The bar's
  // height is published as --chatbar-h so the answer panel (and the undo bar) sit above it.
  const fit = useCallback(() => {
    const el = ta.current;
    if (!el) return;
    const min = CHAT_LINE_PX + CHAT_PAD_Y_PX;
    const max = CHAT_LINE_PX * CHAT_MAX_LINES + CHAT_PAD_Y_PX;
    el.style.height = 'auto';
    const full = el.scrollHeight;
    const h = Math.min(Math.max(full, min), max);
    el.style.height = `${h}px`;
    el.style.overflowY = full > max ? 'auto' : 'hidden';
    document.documentElement.style.setProperty('--chatbar-h', `${Math.max(BAR_MIN_PX, h + BAR_PAD_Y_PX)}px`);
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [value, left, fit]);

  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      document.documentElement.style.removeProperty('--chatbar-h');
    };
  }, [fit]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Enter that confirms an IME candidate must not send (keyCode 229 covers Safari / older Chrome).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  };

  return (
    <form className="chatbar" style={{ left }} onSubmit={onSubmit}>
      <textarea
        ref={ta}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask about your notes"
        aria-label="Ask about your notes"
      />
      <button type="submit" className="sendbtn" data-tip="Send" aria-label="Send">
        <ArrowRight weight="duotone" />
      </button>
    </form>
  );
}
```
**Impact:** `App.test.tsx` already drives the bar with `getByLabelText('Ask about your notes')` + `fireEvent.change` + `fireEvent.submit(form.chatbar)`, and that works on a textarea unchanged. jsdom 30 implements `requestSubmit`: it fires a cancelable `submit`, and App's `send` calls `preventDefault()`, so jsdom's "not implemented navigation" branch is never reached.

### Step 8: `ChatBar.css`
**File:** `web/src/components/ChatBar.css` (new)
**Change:** The textarea rules plus the collapsed-panel rules. The collapsed-panel rules live here because invariant 7 keeps new chat CSS out of `styles.css`, and ChatBar is always mounted, so the file is always loaded. It is imported after `styles.css` (main.tsx imports `styles.css` before `App`), and the selectors are more specific in any case.
**Code:**
```css
/* chat bar textarea (R7): one 20px line + 10px padding top and bottom = the 40px send button. */
.chatbar textarea {
  flex: 1;
  min-width: 0;
  display: block;
  box-sizing: border-box;
  height: 40px;
  margin: 0;
  padding: 10px 12px 10px 0;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--bg);
  font: inherit;
  font-size: 14px;
  line-height: 20px;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.chatbar textarea::placeholder { color: var(--placeholder); }

/* collapsed answer panel (R6): the header line alone, just above the chat bar. */
.answer.collapsed { padding: 4px 8px 4px 20px; overflow: hidden; }
.answer.collapsed .answer-head { margin-bottom: 0; cursor: pointer; }
```

### Step 9: `App.tsx`: pass the new props to `<AnswerPanel>`
**File:** `web/src/App.tsx:182-194` (the `<AnswerPanel … />` element inside `{chat.open && ( … )}`)
**Change:** Add `collapsed={chat.collapsed}` after `pinned`, and `onToggleCollapse={chat.toggleCollapsed}` after `onTogglePin`. Nothing else in App changes. `send` (L121-127) still calls `chat.ask(q)` with the raw `q`, `highlight` (L48) still reads `chat.open && chat.text`, and the Esc effect (L129-137) is untouched. Esc therefore still closes an unpinned panel, collapsed or not.
**Code:** the replacement element:
```tsx
        {chat.open && (
          <AnswerPanel
            left={chatLeft}
            query={chat.query}
            text={chat.text}
            done={chat.done}
            status={chat.status}
            brain={chat.brain}
            pinned={chat.pinned}
            collapsed={chat.collapsed}
            usedIds={used}
            onTogglePin={chat.togglePin}
            onToggleCollapse={chat.toggleCollapsed}
            onClose={chat.close}
            onJump={jump}
          />
        )}
```
**Impact:** none beyond the panel. `<ChatBar left={chatLeft} value={q} onChange={setQ} onSubmit={send} />` (L196) stays byte-identical.

### Step 10: `App.test.tsx`: header button count
**File:** `web/src/App.test.tsx:125`
**Change:** The header now has three buttons (Collapse, Pin, Dismiss).
**Code:**
```tsx
    expect(document.querySelectorAll('.answer-head button')).toHaveLength(3);
```
**Impact:** a one-line hunk in a test file that phases 6–9 may also edit elsewhere. It does not overlap their hunks, which are photo, editor and bin tests.

### Step 11: `styles.css`: existing chat rules
**File:** `web/src/styles.css`
**Change:** Edit these rules in place and no others.

L99 `.answer`: replace with (the bottom follows the bar; max-height also stays clear of a tall bar):
```css
.answer { position: fixed; bottom: calc(var(--chatbar-h, 54px) + 32px); max-height: min(52vh, calc(100vh - var(--chatbar-h, 54px) - 48px)); overflow: auto; background: var(--panel); border: 1px solid var(--line-14); z-index: 40; padding: 16px 20px 20px; box-sizing: border-box; }
```
L101 `.answer-q`: replace with (one line, ellipsis):
```css
.answer-q { font-family: var(--mono); font-size: 10.5px; color: var(--dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```
L102 `.answer-status`: replace with (the caption never shrinks; the query is what gets cut):
```css
.answer-status { font-family: var(--mono); font-size: 10.5px; color: var(--dim); white-space: nowrap; flex-shrink: 0; }
```
L117 `.chatbar`: replace with (auto height from the textarea; pill radius = half of 54px, so the one-line look is identical and taller bars become a rounded rectangle instead of a lens; children are bottom-aligned so the send button stays at the bottom right):
```css
.chatbar { position: fixed; right: 16px; bottom: 16px; min-height: 54px; border-radius: 27px; background: var(--fg); display: flex; align-items: flex-end; padding: 7px 7px 7px 24px; z-index: 41; box-sizing: border-box; }
```
L118 `.chatbar input { … }`: **delete the line** (superseded by `.chatbar textarea` in ChatBar.css).

L119 `.sendbtn`: replace with (never squeezed by a long line):
```css
.sendbtn { width: 40px; height: 40px; flex-shrink: 0; border-radius: 999px; border: 0; background: var(--bg); color: var(--fg); font-size: 18px; cursor: pointer; display: grid; place-items: center; }
```
**Impact:** At one line the geometry matches today's: bar 54px tall with `--chatbar-h` 54px, so the panel sits at `bottom: 86px` as before.

### Step 12: `ChatBar` tests
**File:** `web/src/components/ChatBar.test.tsx` (new)
**Change:** A harness mimics App: it is controlled, and `onSubmit` prevents default, records the value and clears it. jsdom has no layout, so `scrollHeight` is stubbed on `HTMLTextAreaElement.prototype` to `20 * lines + 20`, which matches the CSS line height and padding.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CHAT_LINE_PX, CHAT_MAX_LINES, CHAT_PAD_Y_PX, ChatBar } from './ChatBar';

function Harness({ onSend }: { onSend: (q: string) => void }) {
  const [q, setQ] = useState('');
  return (
    <ChatBar
      left={0}
      value={q}
      onChange={setQ}
      onSubmit={(e) => {
        e.preventDefault();
        if (!q.trim()) return;
        onSend(q);
        setQ('');
      }}
    />
  );
}

function textarea(): HTMLTextAreaElement {
  const el = screen.getByLabelText('Ask about your notes');
  if (!(el instanceof HTMLTextAreaElement)) throw new Error('chat bar is not a textarea');
  return el;
}

const barH = () => document.documentElement.style.getPropertyValue('--chatbar-h');

beforeEach(() => {
  // jsdom has no layout: report the height the content would need, one CHAT_LINE_PX per line.
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return CHAT_LINE_PX * this.value.split('\n').length + CHAT_PAD_Y_PX;
    },
  });
});

afterEach(() => {
  cleanup();
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  document.documentElement.style.removeProperty('--chatbar-h');
});

describe('ChatBar', () => {
  it('is a one-row textarea that publishes the one-line bar height', () => {
    render(<Harness onSend={vi.fn()} />);
    expect(textarea().rows).toBe(1);
    expect(textarea().style.height).toBe('40px');
    expect(barH()).toBe('54px');
  });

  it('Enter sends the message', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: 'hello' } });
    const notCancelled = fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(notCancelled).toBe(false);
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(textarea().value).toBe('');
  });

  it('Shift+Enter does not send and leaves the newline to the browser', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: 'first' } });
    const notCancelled = fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true });
    expect(notCancelled).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends typed or pasted newlines intact', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: 'line one\nline two\n\nline four' } });
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('line one\nline two\n\nline four');
  });

  it('Enter during IME composition does not send', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: 'にほん' } });
    expect(fireEvent.keyDown(textarea(), { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(textarea(), { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('にほん');
  });

  it('grows one line at a time up to the cap, then scrolls inside', () => {
    render(<Harness onSend={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: 'a\nb' } });
    expect(textarea().style.height).toBe('60px');
    expect(textarea().style.overflowY).toBe('hidden');
    expect(barH()).toBe('74px');

    const max = CHAT_LINE_PX * CHAT_MAX_LINES + CHAT_PAD_Y_PX;
    fireEvent.change(textarea(), { target: { value: Array.from({ length: CHAT_MAX_LINES }, (_, i) => `l${i}`).join('\n') } });
    expect(textarea().style.height).toBe(`${max}px`);
    expect(textarea().style.overflowY).toBe('hidden');

    fireEvent.change(textarea(), { target: { value: Array.from({ length: 9 }, (_, i) => `l${i}`).join('\n') } });
    expect(textarea().style.height).toBe(`${max}px`);
    expect(textarea().style.overflowY).toBe('auto');
    expect(barH()).toBe(`${max + 14}px`);
  });

  it('shrinks back to one line after sending', () => {
    render(<Harness onSend={vi.fn()} />);
    fireEvent.change(textarea(), { target: { value: 'one\ntwo\nthree' } });
    expect(textarea().style.height).toBe('80px');
    fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(textarea().value).toBe('');
    expect(textarea().style.height).toBe('40px');
    expect(barH()).toBe('54px');
  });

  it('does not send an empty or whitespace-only message on Enter, and adds no newline', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    fireEvent.change(textarea(), { target: { value: '   ' } });
    expect(fireEvent.keyDown(textarea(), { key: 'Enter' })).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });
});
```
Note: `delete` on the prototype removes only the own property this test added, and `Element.prototype.scrollHeight` takes over again.

## Verification

**Build:** `npm run typecheck`
**Tests:** `npm test` (all of `web/src/**/*.test.tsx` included); target files: `npx vitest run web/src/components/ChatBar.test.tsx web/src/components/AnswerPanel.test.tsx web/src/hooks/useChat.test.tsx web/src/lib/oneLine.test.tsx web/src/App.test.tsx`. `npm run test:int` is unaffected (no server change) but must still pass (invariant 1).
**Manual check (http://localhost:7317 via `npm run dev` / the web dev server):**
- Ask something and collapse it while it streams. The panel folds to one line, "query · searching notes", which becomes "query · claude", sitting just above the bar. Click the line and the full answer is there.
- Pin while collapsed and the panel stays pinned. Esc on an unpinned collapsed panel closes it. Dismiss closes it, and the next question opens expanded on a new thread.
- Used-note outlines and dimming on the wall stay while collapsed.
- Type "a", Shift+Enter, "b": the bar grows to two lines with the send button at the bottom right and the panel moves up with it. Enter sends both lines (check the `/api/chat` request body in DevTools for `\n`), and the bar is back to one line.
- Paste 10 lines: the bar stops at 6 lines and scrolls inside.
- A long or multi-line query shows on one line in the header with an ellipsis, and hovering it shows the full query.
- With a Japanese/Chinese IME, Enter to confirm a candidate does not send.

**Exit criteria:** typecheck and `npm test` are green. Every R6 bullet (caret icon with tooltip, header-only collapse, new answers open expanded, streaming continues collapsed, line click expands, pin/dismiss/Esc and highlight unchanged) and every R7 bullet (textarea, Enter, Shift+Enter, IME, grow cap with scroll, shrink after send, panel above the bar, newlines intact, one-line query with ellipsis and tooltip) is covered by a test in `AnswerPanel.test.tsx`, `ChatBar.test.tsx`, `useChat.test.tsx` or `oneLine.test.tsx`, apart from purely visual geometry, which is a manual check.

## Handoffs

- **Phase 8 (UndoBar):** read the bar height as `var(--chatbar-h, 54px)` and use it when placing the UndoBar above the chat bar. The property is set on `document.documentElement` by `ChatBar` (`"<n>px"`, 54–154). The panel is at `bottom: calc(var(--chatbar-h, 54px) + 32px)`. Reconciled: phase 8 places the UndoBar at `right: 16px; bottom: calc(var(--chatbar-h, 54px) + 24px)`, i.e. above the bar's right end, while this panel stays anchored at the bar's left edge with `width: min(680px, …)` (unchanged in Step 5), so the two do not overlap on desktop widths. Keep the panel left-anchored and capped at 680px.
- **Phases 6–9 (reconciled):** none of their tests asserts the answer-panel header button count; only `App.test.tsx:125` does, and this phase owns it. Phase 7's card button is labelled `Expand note`, so this panel's collapsed-state `Expand` caret is the only control named plain "Expand".
- **Phase 10 (README, R5/R6/R7 docs):** one paragraph each for R6 (caret collapse, click line to expand, Esc/pin/dismiss unchanged) and R7 (Shift+Enter newline, Enter sends, grows to 6 lines).
- **Phase 6 / reconciler:** this phase edits `App.test.tsx:125` (one assertion) and the `<AnswerPanel>` element in `App.tsx`. Phase 6 also edits both files, in non-overlapping hunks. If phase 6 rewrites `App.test.tsx` wholesale, carry the `toHaveLength(3)` change over.
- **Not done (outside every phase's scope; possible follow-up card):** the custom `.tip` tooltip is `white-space: nowrap` with no max-width (`styles.css` `.tip`, `Tooltip.tsx`), so a very long query tooltip can run past the viewport edge. Capping it changes every tooltip in the app, so it is left alone here.

## Rollback

Revert this phase's commit(s). The changes are self-contained:
- delete `web/src/lib/oneLine.ts`, `web/src/lib/oneLine.test.tsx`, `web/src/components/ChatBar.css` and `web/src/components/ChatBar.test.tsx`
- restore `ChatBar.tsx`, `AnswerPanel.tsx`, `AnswerPanel.test.tsx`, `useChat.ts` and `useChat.test.tsx` from the base
- in `App.tsx`, drop the two props on `<AnswerPanel>`, and in `App.test.tsx` set `toHaveLength(2)` back
- in `styles.css`, restore `.answer`, `.answer-q`, `.answer-status`, `.chatbar`, `.chatbar input` and `.sendbtn`

If phase 8 has landed, its UndoBar's `var(--chatbar-h, 54px)` falls back to 54px, so nothing breaks.
