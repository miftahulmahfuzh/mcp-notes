// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatMessage } from '../types';
import { useUndo } from '../hooks/useUndo';
import { useHistoryActions } from '../hooks/useHistoryActions';
import { SHOW_DELETED_KEY } from '../hooks/useShowDeleted';
import { chatTimeTitle } from '../lib/chatTime';
import type { BubbleProps } from './Bubble';
import { MessageItem } from './MessageItem';
import { ReplyChip } from './ReplyChip';
import { HistoryTools } from './HistoryTools';
import { UndoBar } from './UndoBar';
import { makeMessage } from '../testing/chatFixtures';

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[];
let fail: { method: string; status: number } | null;
let sent: Array<string | null>;
let scroll: ReturnType<typeof vi.fn>;
let animate: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  fail = null;
  sent = [];
  window.sessionStorage.clear();
  scroll = vi.fn();
  animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: animate });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });
      if (fail && fail.method === method) {
        const s = fail.status;
        fail = null;
        return json({ error: 'boom' }, s);
      }
      const path = url.split('?')[0] ?? url;
      if (method === 'PATCH') {
        const id = path.split('/').pop() ?? '';
        return json(makeMessage(id, { text: (body as { text: string }).text, edited_at: '2026-10-31T02:00:00.000Z' }));
      }
      if (method === 'DELETE') {
        // P7: `{deleted}` lists what this call changed, question first. In these tests Q001's answer is A001.
        const id = path.split('/').pop() ?? '';
        return json({ deleted: url.includes('with_answer=1') ? [id, 'A001'] : [id] });
      }
      if (method === 'POST' && path.endsWith('/restore')) {
        return json(makeMessage(path.split('/').at(-2) ?? ''));
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
});

const Q1 = makeMessage('Q001', { text: 'what did I note about seer?', created_at: '2026-10-31T01:00:00.000Z' });
const A1 = makeMessage('A001', { role: 'assistant', text: 'You noted the v250 run.', created_at: '2026-10-31T01:01:00.000Z' });
const Q2 = makeMessage('Q002', {
  text: 'and the leaderboard?',
  created_at: '2026-10-31T01:02:00.000Z',
  reply_to: { id: 'A001', role: 'assistant', text: 'You noted the v250 run.', deleted: false },
});

const NOW = new Date('2026-10-31T05:00:00.000Z');
const bubbleFor = (m: ChatMessage): BubbleProps => ({ item: { key: m.id, msg: m, local: null }, now: NOW, focused: false, onOpenImages: () => {} });

let loadOlderCalls = 0;

/** The page-level wiring P9's HistoryPage gets in Step 13, with a stand-in for P9's HistoryComposer form. */
function Harness({ initial, older = [] }: { initial: ChatMessage[]; older?: ChatMessage[][] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initial);
  const pages = useRef<ChatMessage[][]>([...older]);
  const loadOlder = useCallback(async () => {
    loadOlderCalls += 1;
    const page = pages.current.shift() ?? [];
    setMessages((ms) => [...page, ...ms]);
    return page;
  }, []);
  const undo = useUndo();
  const ha = useHistoryActions({ history: { messages, loadOlder, mutate: setMessages }, pushUndo: undo.push });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // HistoryComposer (Step 13): send with the reply target, then clear the chip.
    sent.push(ha.replyTo?.id ?? null);
    ha.cancelReply();
  };
  return (
    <>
      <HistoryTools showDeleted={ha.showDeleted} onToggleDeleted={ha.toggleShowDeleted} notice={ha.notice} />
      <ol className="hist-list">
        {messages.filter(ha.isShown).map((m) => (
          <MessageItem key={m.id} {...ha.itemProps(m)} bubble={bubbleFor(m)} />
        ))}
      </ol>
      <div className="hist-composer">
        {ha.replyTo && <ReplyChip target={ha.replyTo} onCancel={ha.cancelReply} />}
        <form className="chatbar" onSubmit={submit}>
          <textarea aria-label="Ask about your notes" />
          <button type="submit">Send</button>
        </form>
      </div>
      <UndoBar entry={undo.entry} onUndo={undo.undo} />
    </>
  );
}

const btn = (name: string | RegExp) => screen.getByRole('button', { name });
const bubble = (id: string) => document.querySelector(`[data-msg="${id}"]`);

describe('bubble actions (history page wiring, mocked API)', () => {
  it('reply: chip with author and snippet, composer focused, X and Esc clear it, send takes the target', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Reply to message [msg:A001]'));
    const chip = screen.getByRole('group', { name: /^Replying to claude/ });
    expect(chip.textContent).toContain('You noted the v250 run.');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask about your notes')));
    fireEvent.click(within(chip).getByRole('button', { name: 'Cancel reply' }));
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull();

    fireEvent.click(btn('Reply to message [msg:Q001]'));
    expect(screen.getByRole('group', { name: /^Replying to you/ })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull();

    fireEvent.click(btn('Reply to message [msg:A001]'));
    fireEvent.click(btn('Send'));
    expect(sent).toEqual(['A001']);
    expect(screen.queryByRole('group', { name: /^Replying to/ })).toBeNull();
  });

  it('edit: optimistic text, PATCH {text}, "edited" mark with the UTC+7 time', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Edit message [msg:Q001]'));
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(ta, { target: { value: 'what about seer v250?' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(screen.getByText('what about seer v250?')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toEqual({ method: 'PATCH', url: '/api/chat/messages/Q001', body: { text: 'what about seer v250?' } });
    await waitFor(() =>
      expect(screen.getByText('edited').getAttribute('data-tip')).toBe(`edited ${chatTimeTitle('2026-10-31T02:00:00.000Z')}`),
    );
  });

  it('edit rollback: a failed PATCH puts the old text back and says so', async () => {
    fail = { method: 'PATCH', status: 500 };
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Edit message [msg:Q001]'));
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(ta, { target: { value: 'changed' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.history-notice')?.textContent).toBe('edit failed: boom'));
    expect(screen.getByText('what did I note about seer?')).toBeTruthy();
    expect(screen.queryByText('edited')).toBeNull();
  });

  it('delete an answer: gone at once, DELETE without with_answer, Undo restores it', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:A001]'));
    expect(bubble('A001')).toBeNull();
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('DELETE /api/chat/messages/A001'));
    expect(document.querySelector('.undo')?.textContent).toBe('deleted [msg:A001]');
    fireEvent.click(btn('Undo'));
    await waitFor(() => expect(bubble('A001')).not.toBeNull());
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('POST /api/chat/messages/A001/restore');
  });

  it('delete a question with its answer: confirm, DELETE ?with_answer=1, Undo restores both', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:Q001]'));
    fireEvent.click(btn('Question and answer'));
    expect(bubble('Q001')).toBeNull();
    expect(bubble('A001')).toBeNull();
    await waitFor(() =>
      expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('DELETE /api/chat/messages/Q001?with_answer=1'),
    );
    expect(document.querySelector('.undo')?.textContent).toBe('deleted [msg:Q001] and its answer');
    fireEvent.click(btn('Undo'));
    await waitFor(() => expect(bubble('Q001')).not.toBeNull());
    expect(bubble('A001')).not.toBeNull();
    const restores = calls.filter((c) => c.method === 'POST').map((c) => c.url);
    expect(restores).toEqual(['/api/chat/messages/Q001/restore', '/api/chat/messages/A001/restore']);
  });

  it('delete "Question only" keeps the answer', async () => {
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:Q001]'));
    fireEvent.click(btn('Question only'));
    expect(bubble('Q001')).toBeNull();
    expect(bubble('A001')).not.toBeNull();
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('DELETE /api/chat/messages/Q001'));
  });

  it('delete rollback: a failed DELETE brings the bubble back and says so', async () => {
    fail = { method: 'DELETE', status: 500 };
    render(<Harness initial={[Q1, A1]} />);
    fireEvent.click(btn('Delete message [msg:A001]'));
    expect(bubble('A001')).toBeNull();
    await waitFor(() => expect(bubble('A001')).not.toBeNull());
    expect(document.querySelector('.history-notice')?.textContent).toBe('delete failed: boom');
  });

  it('a reply whose target gets deleted reads "message deleted" and is not clickable', async () => {
    render(<Harness initial={[Q1, A1, Q2]} />);
    expect(btn(/Go to the quoted message from claude/)).toBeTruthy();
    fireEvent.click(btn('Delete message [msg:A001]'));
    const dead = screen.getByText('message deleted');
    expect(dead.closest('button')).toBeNull();
  });

  it('show deleted: lists deleted bubbles dimmed with Restore, persists in sessionStorage', async () => {
    const D = makeMessage('D001', { text: 'deleted one', deleted_at: '2026-10-31T03:00:00.000Z' });
    const { unmount } = render(<Harness initial={[Q1, D]} />);
    expect(bubble('D001')).toBeNull();
    const toggle = btn('Show deleted');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(bubble('D001')?.classList.contains('msg-deleted')).toBe(true);
    expect(window.sessionStorage.getItem(SHOW_DELETED_KEY)).toBe('1');
    fireEvent.click(btn('Restore message [msg:D001]'));
    expect(bubble('D001')?.classList.contains('msg-deleted')).toBe(false);
    await waitFor(() => expect(calls.map((c) => `${c.method} ${c.url}`)).toContain('POST /api/chat/messages/D001/restore'));
    unmount();
    render(<Harness initial={[Q1, makeMessage('D002', { deleted_at: '2026-10-31T03:00:00.000Z' })]} />);
    expect(bubble('D002')).not.toBeNull();
  });

  it('jump: clicking a quote loads older pages until the target is there, then scrolls to and pulses it', async () => {
    loadOlderCalls = 0;
    const far = makeMessage('Z001', { text: 'a far older question', created_at: '2026-10-01T01:00:00.000Z' });
    const mid = makeMessage('Y001', { text: 'somewhat older', created_at: '2026-10-20T01:00:00.000Z' });
    const q = makeMessage('Q009', { reply_to: { id: 'Z001', role: 'user', text: 'a far older question', deleted: false } });
    render(<Harness initial={[q]} older={[[mid], [far]]} />);
    fireEvent.click(btn(/Go to the quoted message from you/));
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    expect(loadOlderCalls).toBe(2);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(animate.mock.contexts[0]).toBe(bubble('Z001'));
    expect(document.activeElement).toBe(bubble('Z001'));
  });

  it('jump gives up quietly when the target never turns up', async () => {
    const q = makeMessage('Q009', { reply_to: { id: 'Z999', role: null, text: 'lost', deleted: false } });
    render(<Harness initial={[q]} older={[[makeMessage('Y001')]]} />);
    fireEvent.click(btn(/Go to the quoted message from message/));
    await waitFor(() => expect(document.querySelector('.history-notice')?.textContent).toBe('original message not found'));
    expect(animate).not.toHaveBeenCalled();
  });

  it('keyboard: actions are reachable with Tab, the confirm is keyboard-driven, focus moves to the next bubble after delete', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[Q1, A1]} />);
    await user.tab(); // Show deleted
    await user.tab();
    expect(document.activeElement).toBe(btn('Reply to message [msg:Q001]'));
    await user.tab();
    expect(document.activeElement).toBe(btn('Edit message [msg:Q001]'));
    await user.tab();
    expect(document.activeElement).toBe(btn('Delete message [msg:Q001]'));
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(btn('Question only'));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(btn('Delete message [msg:Q001]'));
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}'); // "Question only"
    await waitFor(() => expect(document.activeElement).toBe(bubble('A001')));

    btn('Delete message [msg:A001]').focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ask about your notes')));
  });

  it('keyboard: Edit by Enter, save by Enter, focus returns to Edit', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[Q1, A1]} />);
    btn('Edit message [msg:Q001]').focus();
    await user.keyboard('{Enter}');
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    expect(document.activeElement).toBe(ta);
    await user.keyboard(' now{Enter}');
    expect(screen.getByText('what did I note about seer? now')).toBeTruthy();
    expect(document.activeElement).toBe(btn('Edit message [msg:Q001]'));
  });
});
