// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageItem } from './MessageItem';
import type { BubbleProps } from './Bubble';
import type { MessageItemWiring } from '../hooks/useHistoryActions';
import type { ChatMessage } from '../types';
import { makeMessage } from '../testing/chatFixtures';

afterEach(cleanup);

const NOW = new Date('2026-10-31T05:00:00.000Z');

function wiring(message: ChatMessage, over: Partial<MessageItemWiring> = {}): MessageItemWiring {
  return {
    message,
    reply: null,
    hasAnswer: false,
    onReply: vi.fn(),
    onJump: vi.fn(),
    onEdit: vi.fn(async () => true),
    onDelete: vi.fn(),
    onRestore: vi.fn(),
    ...over,
  };
}

const bubbleFor = (m: ChatMessage): BubbleProps => ({ item: { key: m.id, msg: m, local: null }, now: NOW, focused: false, onOpenImages: vi.fn() });

function renderItem(w: MessageItemWiring) {
  return render(
    <ol>
      <MessageItem {...w} bubble={bubbleFor(w.message)} />
    </ol>,
  );
}

describe('MessageItem', () => {
  it('is the bubble li itself ([data-msg], focusable) and offers Reply/Edit/Delete on a user bubble', () => {
    const w = wiring(makeMessage('Q001'));
    const { container } = renderItem(w);
    const li = container.querySelector('[data-msg="Q001"]') as HTMLElement;
    expect(li.tagName).toBe('LI');
    expect(li.classList.contains('bubble')).toBe(true);
    expect(li.tabIndex).toBe(-1);
    expect(container.querySelectorAll('ol > li')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reply to message [msg:Q001]' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit message [msg:Q001]' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reply to message [msg:Q001]' }));
    expect(w.onReply).toHaveBeenCalledWith(w.message);
  });

  it('an assistant bubble has no Edit', () => {
    renderItem(wiring(makeMessage('A001', { role: 'assistant' })));
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete message [msg:A001]' })).toBeTruthy();
  });

  it('edit: Enter saves, Shift+Enter is left to the textarea, the hint explains future-only', () => {
    const w = wiring(makeMessage('Q001', { text: 'old' }));
    const { container } = renderItem(w);
    fireEvent.click(screen.getByRole('button', { name: 'Edit message [msg:Q001]' }));
    const ta = screen.getByRole('textbox', { name: 'Edit message' }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(ta);
    expect((container.querySelector('.bubble-body') as HTMLElement).hidden).toBe(true);
    expect(screen.getByText(/only future replies see the edit/)).toBeTruthy();
    expect(fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.change(ta, { target: { value: 'new\nlines' } });
    expect(fireEvent.keyDown(ta, { key: 'Enter' })).toBe(false);
    expect(w.onEdit).toHaveBeenCalledWith('Q001', 'new\nlines');
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect((container.querySelector('.bubble-body') as HTMLElement).hidden).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit message [msg:Q001]' }));
  });

  it('edit: blank text is rejected client-side, Esc cancels', () => {
    const w = wiring(makeMessage('Q001', { text: 'old' }));
    renderItem(w);
    fireEvent.click(screen.getByRole('button', { name: 'Edit message [msg:Q001]' }));
    const ta = screen.getByRole('textbox', { name: 'Edit message' });
    fireEvent.change(ta, { target: { value: '   ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('a message cannot be empty');
    expect(w.onEdit).not.toHaveBeenCalled();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect(screen.getByText('old')).toBeTruthy();
    expect(w.onEdit).not.toHaveBeenCalled();
  });

  it('delete without an answer deletes at once', () => {
    const w = wiring(makeMessage('Q001'));
    renderItem(w);
    fireEvent.click(screen.getByRole('button', { name: 'Delete message [msg:Q001]' }));
    expect(w.onDelete).toHaveBeenCalledWith('Q001', false);
  });

  it('delete of a question with an answer asks first; both choices work; Esc cancels back to Delete', () => {
    const w = wiring(makeMessage('Q001'), { hasAnswer: true });
    renderItem(w);
    const del = screen.getByRole('button', { name: 'Delete message [msg:Q001]' });
    fireEvent.click(del);
    const group = screen.getByRole('group', { name: 'Delete the answer too?' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Question only' }));
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Delete the answer too?' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete message [msg:Q001]' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete message [msg:Q001]' }));
    fireEvent.click(screen.getByRole('button', { name: 'Question and answer' }));
    expect(w.onDelete).toHaveBeenCalledWith('Q001', true);
  });

  it('a deleted bubble is dimmed and offers only Restore', () => {
    const w = wiring(makeMessage('Q001', { deleted_at: '2026-10-31T02:00:00.000Z' }));
    const { container } = renderItem(w);
    const li = container.querySelector('[data-msg="Q001"]') as HTMLElement;
    expect(li.classList.contains('msg-deleted')).toBe(true);
    expect(li.getAttribute('aria-label')).toBe('deleted message [msg:Q001]');
    expect(screen.queryByRole('button', { name: /^Reply/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore message [msg:Q001]' }));
    expect(w.onRestore).toHaveBeenCalledWith('Q001');
  });

  it('reply header: live target is a button that jumps; deleted target reads "message deleted" and is not clickable', () => {
    const live = wiring(makeMessage('Q002'), { reply: { id: 'A001', author: 'claude', snippet: 'You noted v250.', deleted: false } });
    renderItem(live);
    fireEvent.click(screen.getByRole('button', { name: /Go to the quoted message from claude/ }));
    expect(live.onJump).toHaveBeenCalledWith('A001');
    cleanup();
    renderItem(wiring(makeMessage('Q003'), { reply: { id: 'A009', author: 'claude', snippet: 'gone', deleted: true } }));
    const dead = screen.getByText('message deleted');
    expect(dead.closest('button')).toBeNull();
  });

  it('an edited bubble shows "edited" with the edit time in its tip', () => {
    renderItem(wiring(makeMessage('Q001', { edited_at: '2026-10-31T02:00:00.000Z' })));
    const mark = screen.getByText('edited');
    expect(mark.getAttribute('data-tip')).toMatch(/^edited .+/);
  });
});
