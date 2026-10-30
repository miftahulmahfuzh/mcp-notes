> Adopted from `/home/miftah/mcp-notes/.workflows/orchestration/chat-bar-brain/PLAN.md` phase 3. Source: `.workflows/plan/chat-bar-brain/phase-3.md`.
> Written and reconciled by /analyze — edit the source, not this copy.

# Phase 3: Panel: status caption, brain label, thread reset on dismiss

**Plan set:** `docs/plans/CHAT_BAR_BRAIN_PLAN.md`
**Analysis:** `docs/analyzer/20261030-105357-UWUH_code_analyzer.md`
**Satisfies:** R2, R3, R4. Dismissing the panel starts a new thread and a pinned panel keeps its thread (R2). The panel says which brain answered (R3). Tool progress shows as a terse caption (R4).
**Depends on:** Phase 1 (the wire contract only: `event: status {"text"}` with `""` clearing it, and `done {"thread_id", "brain"?}`). Nothing here imports server code, so this phase can be built and tested in parallel with Phase 2, and before Phase 1 lands, against fake SSE streams.
**Difficulty:** NORMAL
**Package:** `web/src`

---

## Goal

The answer panel's header line shows one Geist Mono caption after the query. While the answer streams, it shows the latest `status` text (cleared by `""`). Once the turn is done, it shows `done.brain` (`claude` / `glm`), or nothing when the server sent no brain (the stub). `useChat.close()` forgets the thread id, so the next message after a dismiss starts a new thread. A panel that stays open, pinned or not, keeps the thread for follow-ups. No new buttons, no spinners. The `▍` cursor stays.

## Interface Contract

**Deletes:** nothing
**Renames:** nothing
**Creates:**
- `ChatState.status: string` and `ChatState.brain: string | null` (`web/src/hooks/useChat.ts`). They are visible on the `Chat` object returned by `useChat()`.
- `AnswerPanelProps.status: string` and `AnswerPanelProps.brain: string | null` (`web/src/components/AnswerPanel.tsx`)
- CSS class `.answer-status` (`web/src/styles.css`)
- New test file `web/src/hooks/useChat.test.tsx`
**Signature changes:**
- `useChat().close()` now also clears the thread id (behaviour change, same signature).
- `<AnswerPanel>` gains two required props. Its only caller, `App.tsx`, is updated in this phase.
**Requires (from earlier phases):** the SSE wire format of Phase 1: `event: status` with data `{"text": string}`, where `""` clears; `event: done` with data `{"thread_id": string, "brain"?: "claude" | "glm"}`. `delta` and `error` stay unchanged. This phase only reads that format through fakes in tests, so it does not need Phase 1's code to compile or pass.
**Leaves alone (owned by others):** `src/**` and `tests/**` (Phases 1, 2), `deploy/`, `scripts/`, `vitest.config.ts`, `package.json`, `docs/INSTALL.md` (Phase 4). Within `web/`, it does not touch `web/src/lib/sse.ts` (no bug found), `web/src/api.ts` (`postChat` already omits `thread_id` when it is `undefined`), or `ChatBar.tsx`.

## Files

| File | Action | What changes |
|---|---|---|
| `web/src/hooks/useChat.ts` | modify (whole file, 88 lines) | `status`/`brain` state; handles `event: status`; `done` stores `brain`; `close()` clears `threadId`; a new `ask` and `close` reset status/brain; `finish` clears status |
| `web/src/components/AnswerPanel.tsx` | modify (lines 3-13 props, 15 destructure, 20 head) | two new props; one `<span className="answer-status">` after `.answer-q` |
| `web/src/App.tsx` | modify (lines 182-192) | passes `status={chat.status}` and `brain={chat.brain}` to `AnswerPanel` (two lines; required, or typecheck fails) |
| `web/src/styles.css` | modify (insert after line 100, `.answer-q`) | `.answer-status` rule: the `.answer-q` caption look plus a `·` separator |
| `web/src/hooks/useChat.test.tsx` | create | hook tests: status set/clear, brain stored or null, error clears status, dismiss drops thread, pin and open panel keep thread, new ask resets |
| `web/src/App.test.tsx` | modify (append one `it` inside `describe('App')`, after line 97) | end-to-end: caption shows the status mid-stream with the `▍` cursor, then the brain label once done |

Note on scope: `App.tsx` is not in the phase_scope list, but `AnswerPanel`'s new required props have exactly one caller. Leaving `App.tsx` out would break `npm run typecheck`. The change is two prop lines. No other phase touches `web/`.

## Implementation Steps

### Step 1: `useChat`: status, brain, thread reset on dismiss
**File:** `web/src/hooks/useChat.ts:1-88` (replace the whole file)
**Change:**
- `ChatState` gains `status` and `brain`.
- `ask` resets `status: ''` and `brain: null` with the rest of the per-turn state.
- `status` events set `status` to the event's `text`, which may be `''` and so clears it.
- `done` passes `brain` into `finish`. `finish` always clears `status`, because a finished turn shows no tool caption.
- `error`, transport failures and a non-OK response finish with `brain: null`.
- `close()` sets `threadId.current = undefined` and resets status/brain.
- `togglePin` leaves the thread alone. A pinned panel cannot be closed with Escape (`App.tsx:133`), so it keeps its thread until the X button is pressed. The X button is a dismiss, and it starts a new thread.

A stale stream cannot write the thread id back after a dismiss: `close()` sets `ctrl.current = null`, and every SSE callback returns early when `ctrl.current !== c`, so a late `done` from the aborted stream is ignored.

**Code:**
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { postChat } from '../api';
import { readSSE } from '../lib/sse';

export interface ChatState {
  open: boolean;
  pinned: boolean;
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
    query: '',
    text: '',
    done: false,
    status: '',
    brain: null,
  });
  const threadId = useRef<string | undefined>(undefined);
  const ctrl = useRef<AbortController | null>(null);

  const ask = useCallback(async (message: string) => {
    const q = message.trim();
    if (!q) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setSt((s) => ({ ...s, open: true, query: q, text: '', done: false, status: '', brain: null }));

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
    setSt((s) => ({ ...s, open: false, pinned: false, text: '', done: false, status: '', brain: null }));
  }, []);

  const togglePin = useCallback(() => setSt((s) => ({ ...s, pinned: !s.pinned })), []);

  useEffect(() => () => ctrl.current?.abort(), []);

  return { ...st, ask, close, togglePin };
}
```
**Impact:**
- Behaviour change: after a dismiss, by the X button or by Escape, the next `POST /api/chat` carries no `thread_id`.
- Follow-ups while the panel stays open still carry the last `thread_id`, as they do today.
- Unknown SSE events are still ignored.
- `brain` accepts any non-empty string, so the panel shows whatever the server names. Phase 1 restricts the server to `claude | glm`.

### Step 2: `AnswerPanel`: one caption span
**File:** `web/src/components/AnswerPanel.tsx:3-13` (props), `:15` (destructure), `:20` (head)
**Change:** add `status` and `brain` props. Compute `caption = done ? (brain ?? '') : status` and render `<span className="answer-status">` right after `.answer-q`, only when `caption` is non-empty. The body, the `▍` cursor, pin, dismiss and the used-row stay as they are.
**Code:** (whole file)
```tsx
import { PushPin, X } from '@phosphor-icons/react';

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
  usedIds: string[];
  onTogglePin: () => void;
  onClose: () => void;
  onJump: (id: string) => void;
}

export function AnswerPanel({ left, query, text, done, status, brain, pinned, usedIds, onTogglePin, onClose, onJump }: AnswerPanelProps) {
  const parts = text.split('\n\n');
  const caption = done ? (brain ?? '') : status;
  return (
    <div className="answer" style={{ left, width: `min(680px, calc(100vw - ${left}px - 16px))` }}>
      <div className="answer-head">
        <span className="answer-q">{query}</span>
        {caption && <span className="answer-status">{caption}</span>}
        <span className="spacer" />
        <button type="button" className={pinned ? 'pbtn on' : 'pbtn'} data-tip={pinned ? 'Unpin' : 'Pin'} aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onTogglePin}>
          <PushPin weight="duotone" />
        </button>
        <button type="button" className="pbtn hov" data-tip="Dismiss" aria-label="Dismiss" onClick={onClose}>
          <X weight="duotone" />
        </button>
      </div>
      <div className="answer-body">
        {parts.map((t, i) => (
          <p key={i}>{t + (!done && i === parts.length - 1 ? ' ▍' : '')}</p>
        ))}
      </div>
      {done && usedIds.length > 0 && (
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
**Impact:** `AnswerPanel` has a new required prop pair. Step 3 updates its only caller in the same commit.

### Step 3: `App` passes the new props
**File:** `web/src/App.tsx:182-192`
**Change:** add two props to the `<AnswerPanel>` element. Nothing else in `App.tsx` changes. The Escape rule `!pinned` at line 133 is what makes "a pinned panel keeps its thread", and it stays as is.
**Code:** (replacement for lines 181-193)
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
            usedIds={used}
            onTogglePin={chat.togglePin}
            onClose={chat.close}
            onJump={jump}
          />
        )}
```
**Impact:** none beyond the wiring.

### Step 4: `.answer-status` style
**File:** `web/src/styles.css:100`. Insert one new line directly after the `.answer-q` rule, before `.spacer` at line 101. `.answer-q` itself is unchanged.
**Change:** same mono 10.5px dim caption as `.answer-q`. It does not wrap, and it has a `·` separator so the caption reads apart from the query. The header's `gap: 6px` already spaces it.
**Code:**
```css
.answer-status { font-family: var(--mono); font-size: 10.5px; color: var(--dim); white-space: nowrap; }
.answer-status::before { content: "·"; margin-right: 6px; }
```
**Impact:** visual only. It adds no new colors, sizes or fonts.

### Step 5: hook tests
**File:** `web/src/hooks/useChat.test.tsx` (new)
**Change:** jsdom pragma as the first line, following the repo convention. `vitest.config.ts` already includes `web/src/**/*.test.tsx`. `fetch` is stubbed per test. Bodies are either whole SSE strings or a hand-driven `ReadableStream` when a test needs to see state in the middle of a stream.
**Code:**
```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useChat } from './useChat';

interface Frame {
  event: string;
  data: unknown;
}
interface Posted {
  message: string;
  thread_id?: string;
}

const enc = new TextEncoder();
const sse = (frames: Frame[]): string => frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
const sseHeaders = { 'content-type': 'text/event-stream' };

/** Stubs fetch with one queued body per POST /api/chat and records what each POST sent. */
function stubChat(...bodies: Array<string | ReadableStream<Uint8Array>>): Posted[] {
  const posted: Posted[] = [];
  const queue = [...bodies];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)) as Posted);
      return new Response(queue.shift() ?? '', { headers: sseHeaders });
    }),
  );
  return posted;
}

/** A response body the test writes frames into by hand. */
function handStream(): { body: ReadableStream<Uint8Array>; send: (frames: Frame[]) => void; end: () => void } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  return { body, send: (frames) => ctl.enqueue(enc.encode(sse(frames))), end: () => ctl.close() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useChat', () => {
  it('shows status captions while streaming, clears on "", and stores the brain on done', async () => {
    const s = handStream();
    stubChat(s.body);
    const { result } = renderHook(() => useChat());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('what did I note about seer?');
    });

    s.send([{ event: 'status', data: { text: 'searching notes' } }]);
    await waitFor(() => expect(result.current.status).toBe('searching notes'));
    expect(result.current.done).toBe(false);
    expect(result.current.brain).toBeNull();

    s.send([
      { event: 'status', data: { text: '' } },
      { event: 'delta', data: { text: 'Found it.' } },
    ]);
    await waitFor(() => expect(result.current.text).toBe('Found it.'));
    expect(result.current.status).toBe('');

    s.send([
      { event: 'status', data: { text: 'reading 3 notes' } },
      { event: 'done', data: { thread_id: 's-1', brain: 'glm' } },
    ]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.done).toBe(true);
    expect(result.current.status).toBe('');
    expect(result.current.brain).toBe('glm');
  });

  it('leaves brain null when done names none (the stub)', async () => {
    stubChat(sse([{ event: 'delta', data: { text: 'hi' } }, { event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('hi');
    });
    expect(result.current.done).toBe(true);
    expect(result.current.brain).toBeNull();
  });

  it('clears the status and shows no brain when the turn errors', async () => {
    stubChat(sse([{ event: 'status', data: { text: 'searching the web' } }, { event: 'error', data: { error: 'boom' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('news?');
    });
    expect(result.current.done).toBe(true);
    expect(result.current.status).toBe('');
    expect(result.current.brain).toBeNull();
    expect(result.current.text).toBe('Chat failed: boom');
  });

  it('continues the thread on a follow-up while the panel stays open', async () => {
    const posted = stubChat(
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
      sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]),
    );
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    await act(async () => {
      await result.current.ask('and compare it to last month');
    });
    expect(posted[0].thread_id).toBeUndefined();
    expect(posted[1].thread_id).toBe('t1');
  });

  it('a pinned panel keeps its thread', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1' } }]), sse([{ event: 'done', data: { thread_id: 't1' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    act(() => result.current.togglePin());
    expect(result.current.pinned).toBe(true);
    await act(async () => {
      await result.current.ask('second');
    });
    expect(posted[1].thread_id).toBe('t1');
  });

  it('dismissing the panel starts a new thread on the next message', async () => {
    const posted = stubChat(sse([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]), sse([{ event: 'done', data: { thread_id: 't2' } }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.brain).toBeNull();
    await act(async () => {
      await result.current.ask('unrelated');
    });
    expect(posted[1].thread_id).toBeUndefined();
  });

  it('a late done from a dismissed stream does not restore the old thread', async () => {
    const s = handStream();
    const posted = stubChat(s.body, sse([{ event: 'done', data: { thread_id: 't2' } }]));
    const { result } = renderHook(() => useChat());
    act(() => {
      void result.current.ask('first');
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    act(() => result.current.close());
    await act(async () => {
      await result.current.ask('second');
    });
    expect(posted[1].thread_id).toBeUndefined();
  });

  it('a new ask clears the previous brain and status', async () => {
    const s = handStream();
    stubChat(sse([{ event: 'done', data: { thread_id: 't1', brain: 'glm' } }]), s.body);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.ask('first');
    });
    expect(result.current.brain).toBe('glm');
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.ask('second');
    });
    expect(result.current.brain).toBeNull();
    expect(result.current.status).toBe('');
    expect(result.current.done).toBe(false);
    s.send([{ event: 'done', data: { thread_id: 't1', brain: 'claude' } }]);
    s.end();
    await act(async () => {
      await pending;
    });
    expect(result.current.brain).toBe('claude');
  });
});
```
**Impact:** test-only. If `close()` aborts the in-flight `handStream` fetch, `readSSE` rejects inside `ask`, and the `c.signal.aborted` guard swallows it. The test intentionally does not await that first promise.

### Step 6: App-level caption test
**File:** `web/src/App.test.tsx:97`. Insert one `it` inside `describe('App')`, after the existing chat test that ends at line 97, before the closing `});` on line 98. The imports at line 2-3 are unchanged: `waitFor`, `screen`, `fireEvent`, `vi` are already imported.
**Change:** wraps the `beforeEach` fetch stub so that only `/api/chat` returns a hand-driven stream. It then asserts the caption mid-stream, with the `▍` cursor still present, and the brain label after `done`.
**Code:**
```tsx
  it('shows the tool status in the header while streaming, then the brain label', async () => {
    const enc = new TextEncoder();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
      },
    });
    const send = (s: string) => ctl.enqueue(enc.encode(s));
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith('/api/chat') ? new Response(body, { headers: { 'content-type': 'text/event-stream' } }) : base(input, init),
      ),
    );

    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'what about seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);

    send('event: status\ndata: {"text":"searching notes"}\n\n');
    await waitFor(() => expect(document.querySelector('.answer-head .answer-status')?.textContent).toBe('searching notes'));
    expect(document.querySelector('.answer-head .answer-q')?.textContent).toBe('what about seer?');
    expect(document.querySelector('.answer-head button')).not.toBeNull();
    expect(document.querySelectorAll('.answer-head button')).toHaveLength(2);

    send('event: status\ndata: {"text":""}\n\nevent: delta\ndata: {"text":"Look at A-B32."}\n\n');
    await waitFor(() => expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at A-B32. ▍'));
    expect(document.querySelector('.answer-status')).toBeNull();

    send('event: done\ndata: {"thread_id":"s-1","brain":"glm"}\n\n');
    ctl.close();
    await waitFor(() => expect(document.querySelector('.answer-head .answer-status')?.textContent).toBe('glm'));
    expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at A-B32.');
  });
```
**Impact:** test-only. The existing chat test, whose stub `done` has no `brain`, keeps passing. No `.answer-status` is rendered for it, and `getByText('what about seer?')` still matches only `.answer-q`.

## Verification

**Build:** `cd /home/miftah/.worktrees/mcp-notes/chat-bar-brain && npm run typecheck && npm run build`
**Tests:** `npm test -- web/src` for focus, then the full `npm test` and `npm run test:int` (invariant 1; this phase changes nothing the int suite covers).
**Manual check (optional, after Phase 1 lands):** `npm run dev`, ask a question, and check four things:
- The header reads `query · <caption>` in the same dim mono.
- With the stub there is no label.
- Press X, ask again, and the request payload in the devtools Network tab has no `thread_id`.
- Pin, ask twice, and the second payload carries the first turn's `thread_id`.
**Exit criteria:**
- A fake SSE stream with `status` and then `done{brain}` renders the status caption, then the brain label, in `.answer-head`.
- After a dismiss, the next `POST /api/chat` body has no `thread_id`.
- With the panel pinned, a second ask posts the same `thread_id`.
- typecheck, `npm test` and `npm run test:int` are green.

## Handoffs

- **Phase 1:** must emit `status` data as `{"text": string}` and `done` data with `brain` as a plain string field. The panel reads `brain` only from `done`. A brain sent anywhere else, for example in a `status` event, would not be shown.
- **Phase 2 / Phase 1:** the caption shows the last `status` until a `""`, a `done` or an `error`. If the backend forgets to send `""` when text resumes, a stale caption stays visible until the turn ends. This is Phase 2's mapping (Decisions: "`""` when text resumes"). The panel deliberately does not clear status on `delta`, so that a server sending status while text is still flowing stays visible.
- **Phase 4:** the installed acceptance run should include the dismiss/pin thread checks above against the real backend. Resume across a dismiss is a server concern (R2, Phase 2). This phase only guarantees which `thread_id` is posted.
- No drive-by cleanups found. `web/src/lib/sse.ts` is correct for the new event, and `postChat` already drops an undefined `thread_id`.

## Rollback

`git revert <phase-3 commit>`. The change is entirely in `web/src`. Reverting restores the old behaviour: the panel ignores `status` and `brain`, and a dismiss keeps the thread. That old behaviour stays compatible with the Phase 1 server, since unknown SSE events and an extra `done` field are ignored.
