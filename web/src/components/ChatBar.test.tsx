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
