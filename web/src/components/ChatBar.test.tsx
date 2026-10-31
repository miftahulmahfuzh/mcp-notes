// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { CHAT_LINE_PX, CHAT_MAX_LINES, CHAT_PAD_Y_PX, CHAT_THUMBS_PX, ChatBar, type ChatBarImage } from './ChatBar';

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

describe('ChatBar images (R1)', () => {
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const txt = new File(['t'], 'a.txt', { type: 'text/plain' });
  const ready: ChatBarImage = { key: 'k2', label: 'b.png', state: 'ready', thumbUrl: '/api/chat/images/U-PL1/thumb', error: null };

  it('marks the form with data-chatbar', () => {
    render(<Harness onSend={vi.fn()} />);
    expect(document.querySelector('form.chatbar')?.getAttribute('data-chatbar')).toBe('wall');
  });

  it('hands pasted image files over and keeps them out of the textarea', () => {
    const onPasteFiles = vi.fn();
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} onPasteFiles={onPasteFiles} />);
    const notCancelled = fireEvent.paste(textarea(), { clipboardData: { files: [txt, png] } });
    expect(notCancelled).toBe(false);
    expect(onPasteFiles).toHaveBeenCalledWith([png]);
  });

  it('leaves a paste without images to the browser', () => {
    const onPasteFiles = vi.fn();
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} onPasteFiles={onPasteFiles} />);
    expect(fireEvent.paste(textarea(), { clipboardData: { files: [txt] } })).toBe(true);
    expect(fireEvent.paste(textarea(), { clipboardData: { files: [] } })).toBe(true);
    expect(onPasteFiles).not.toHaveBeenCalled();
  });

  it('takes no images when it has no onPasteFiles', () => {
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(fireEvent.paste(textarea(), { clipboardData: { files: [png] } })).toBe(true);
  });

  it('shows uploading, ready and failed thumbnails, each removable, and keeps focus in the bar', () => {
    const onRemove = vi.fn();
    const images: ChatBarImage[] = [
      { key: 'k1', label: 'a.png', state: 'uploading', thumbUrl: null, error: null },
      ready,
      { key: 'k3', label: 'c.png', state: 'failed', thumbUrl: null, error: 'too_large' },
    ];
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} images={images} onRemoveImage={onRemove} />);
    const items = [...document.querySelectorAll('.chatbar-thumb')];
    expect(items.map((li) => li.getAttribute('data-image-state'))).toEqual(['uploading', 'ready', 'failed']);
    expect(items[1]?.querySelector('img')?.getAttribute('src')).toBe('/api/chat/images/U-PL1/thumb');
    expect(items[2]?.getAttribute('data-tip')).toBe('too_large');
    fireEvent.click(screen.getByLabelText('Remove b.png'));
    expect(onRemove).toHaveBeenCalledWith('k2');
    expect(document.activeElement).toBe(textarea());
  });

  it('adds the thumbnail row to the published bar height', () => {
    render(<ChatBar left={0} value="" onChange={vi.fn()} onSubmit={vi.fn()} images={[ready]} />);
    expect(barH()).toBe(`${54 + CHAT_THUMBS_PX}px`);
  });

  it('sendBlocked disables the button and Enter does not submit', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(<ChatBar left={0} value="hi" onChange={vi.fn()} onSubmit={onSubmit} sendBlocked />);
    expect((screen.getByLabelText('Send') as HTMLButtonElement).disabled).toBe(true);
    expect(fireEvent.keyDown(textarea(), { key: 'Enter' })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('the page variant is marked as such and does not publish --chatbar-h', () => {
    render(<ChatBar variant="page" value="" onChange={vi.fn()} onSubmit={vi.fn()} images={[ready]} />);
    const form = document.querySelector('form.chatbar');
    expect(form?.getAttribute('data-chatbar')).toBe('page');
    expect(form?.className).toContain('chatbar-page');
    expect(barH()).toBe('');
  });
});
