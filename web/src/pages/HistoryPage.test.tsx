// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ChatMessage } from '../types';
import type { HistoryStore } from '../hooks/useHistory';
import type { LocalBubble, TimelineItem } from '../lib/timeline';
import { localToMessage } from '../lib/timeline';
import { makeMessage } from '../testing/chatFixtures';
import { HistoryPage } from './HistoryPage';

// 2026-10-31 12:00 in Jakarta.
const NOW = new Date('2026-10-31T05:00:00Z');

const item = (m: ChatMessage): TimelineItem => ({ key: m.id, msg: m, local: null });
const localItem = (l: LocalBubble): TimelineItem => ({ key: l.key, msg: localToMessage(l), local: l });

function store(items: TimelineItem[], over: Partial<HistoryStore> = {}): HistoryStore {
  return {
    items,
    messages: items.filter((i) => i.local === null).map((i) => i.msg),
    loaded: true,
    error: null,
    hasMore: false,
    loadingOlder: false,
    sending: false,
    loadOlder: vi.fn(async () => []),
    refresh: vi.fn(),
    mutate: vi.fn(),
    send: vi.fn(() => true),
    ...over,
  };
}

const q1 = makeMessage('Q001', { thread_id: 'T1', text: 'what about seer?', created_at: '2026-10-30T17:30:00Z' });
const a1 = makeMessage('A001', { thread_id: 'T1', role: 'assistant', text: 'Seer is fine.', brain: 'claude', created_at: '2026-10-30T17:31:00Z' });
const q2 = makeMessage('Q002', {
  thread_id: 'T2',
  source: 'claude_code',
  text: '/n find photos like this',
  created_at: '2026-10-29T03:00:00Z',
  attachments: [
    { kind: 'chat_image', id: 'U-AA1', url: '/api/chat/images/U-AA1/display', thumb_url: '/api/chat/images/U-AA1/thumb' },
    { kind: 'chat_image', id: 'U-BB2', url: '/api/chat/images/U-BB2/display', thumb_url: '/api/chat/images/U-BB2/thumb' },
    { kind: 'note_image', id: 'K-F07', url: '/api/images/K-F07/display', thumb_url: '/api/images/K-F07/thumb' },
    { kind: 'note_file', id: 'F-Z11', url: '/api/files/F-Z11/download', thumb_url: null },
  ],
});

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

const bubble = (id: string) => document.querySelector(`[data-msg="${id}"]`) as HTMLElement;

describe('HistoryPage', () => {
  it('puts user bubbles right and answers left, with a Jakarta timestamp on every bubble', () => {
    render(<HistoryPage store={store([item(q2), item(q1), item(a1)])} focusThread={null} now={NOW} />);
    expect(bubble('Q001').className).toContain('mine');
    expect(bubble('A001').className).toContain('theirs');
    const times = Array.from(document.querySelectorAll('.bubble time'));
    expect(times).toHaveLength(3);
    // 17:30 UTC on the 30th is 00:30 on the 31st in Jakarta: today, so time only.
    expect(within(bubble('Q001')).getByText('00:30').getAttribute('data-tip')).toBe('2026-10-31T00:30:00+07:00 (UTC+7)');
    expect(within(bubble('Q002')).getByText('29 Oct 10:00')).toBeTruthy();
    expect(within(bubble('A001')).getByText('claude')).toBeTruthy();
  });

  it('badges claude code bubbles and draws a divider where the thread changes', () => {
    render(<HistoryPage store={store([item(q2), item(q1), item(a1)])} focusThread={null} now={NOW} />);
    expect(within(bubble('Q002')).getByText('claude code')).toBeTruthy();
    expect(within(bubble('Q001')).queryByText('claude code')).toBeNull();
    const seps = screen.getAllByRole('separator');
    expect(seps).toHaveLength(2);
    expect(seps[0]?.textContent).toContain('claude code');
    expect(seps[1]?.textContent).toContain('wall chat');
  });

  it('reserves a square thumbnail box per chat image (the wire has no dimensions) and shows note attachments as id chips', () => {
    render(<HistoryPage store={store([item(q2)])} focusThread={null} now={NOW} />);
    const imgs = Array.from(bubble('Q002').querySelectorAll('.bubble-thumb img')) as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/chat/images/U-AA1/thumb', '/api/chat/images/U-BB2/thumb']);
    expect([imgs[0]?.getAttribute('width'), imgs[0]?.getAttribute('height')]).toEqual(['96', '96']);
    expect([imgs[1]?.getAttribute('width'), imgs[1]?.getAttribute('height')]).toEqual(['96', '96']);
    const chips = Array.from(bubble('Q002').querySelectorAll('.bubble-chip')).map((c) => c.textContent);
    expect(chips).toEqual(['image K-F07', 'file F-Z11']);
  });

  it('a thumbnail opens the lightbox on it; arrows move across the message images', () => {
    render(<HistoryPage store={store([item(q2)])} focusThread={null} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'View image upload:U-BB2' }));
    const shown = () => document.querySelector('[data-lightbox] img')?.getAttribute('src');
    expect(shown()).toBe('/api/chat/images/U-BB2/display');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(shown()).toBe('/api/chat/images/U-AA1/display');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-lightbox]')).toBeNull();
  });

  it('streams into an optimistic bubble and shows an error bubble on failure', () => {
    const base: LocalBubble = {
      key: 'local-1-a',
      role: 'assistant',
      serverId: null,
      threadId: 'T1',
      text: '',
      createdAt: '2026-10-31T04:59:00Z',
      attachments: [],
      streaming: true,
      status: 'searching notes',
      brain: null,
      error: null,
    };
    const { rerender } = render(<HistoryPage store={store([item(q1), localItem(base)])} focusThread={null} now={NOW} />);
    const pending = document.querySelector('[data-msg-key="local-1-a"]') as HTMLElement;
    expect(pending.textContent).toContain('searching notes');
    rerender(<HistoryPage store={store([item(q1), localItem({ ...base, streaming: false, status: '', error: 'Chat failed: boom' })])} focusThread={null} now={NOW} />);
    const failed = document.querySelector('[data-msg-key="local-1-a"]') as HTMLElement;
    expect(failed.className).toContain('error');
    expect(failed.textContent).toContain('Chat failed: boom');
  });

  it('offers earlier messages when there are more', () => {
    const s = store([item(q1)], { hasMore: true });
    render(<HistoryPage store={s} focusThread={null} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Earlier messages' }));
    expect(s.loadOlder).toHaveBeenCalled();
  });

  it('opened on a thread, scrolls to it and outlines its bubbles', () => {
    render(<HistoryPage store={store([item(q2), item(q1), item(a1)])} focusThread="T1" now={NOW} />);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(bubble('A001').className).toContain('focus');
    expect(bubble('Q001').className).toContain('focus');
    expect(bubble('Q002').className).not.toContain('focus');
  });

  it('opened on a thread that is not loaded yet, pages older to find it', () => {
    const s = store([item(q1)], { hasMore: true });
    render(<HistoryPage store={s} focusThread="T-OLD" now={NOW} />);
    expect(s.loadOlder).toHaveBeenCalledTimes(1);
  });

  it('renders its own page-variant ChatBar; Enter sends through store.send and clears the draft', () => {
    const s = store([item(q1)]);
    render(<HistoryPage store={s} focusThread={null} now={NOW} />);
    const form = document.querySelector('form.chatbar') as HTMLFormElement;
    expect(form.className).toContain('chatbar-page');
    expect(form.getAttribute('data-chatbar')).toBe('page');
    const ta = screen.getByLabelText('Ask about your notes') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'and now?' } });
    fireEvent.submit(form);
    expect(s.send).toHaveBeenCalledWith('and now?', []);
    expect(ta.value).toBe('');
  });
});
