// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhotoModal } from './PhotoModal';
import { photosOf } from '../lib/filter';
import { makeNote } from '../testing/fixtures';

vi.mock('../lib/dates', () => ({ relativeDate: () => 'Today' }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const items = photosOf([makeNote('K-F07', 'River at dawn. #walks #film', { images: ['K-F07', 'M-N11'] })], []);

function mount(over: Partial<React.ComponentProps<typeof PhotoModal>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const props = { onIndex: vi.fn(), onClose: vi.fn(), onSave: vi.fn(), onChatAbout: vi.fn(), ...over };
  act(() => root!.render(<PhotoModal items={items} index={0} copiedId={null} onCopy={() => {}} {...props} />));
  return props;
}

const text = () => document.querySelector('[data-pm-text]') as HTMLElement;
const area = () => document.querySelector('textarea[data-pm-edit]') as HTMLTextAreaElement | null;
function key(k: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}
function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('PhotoModal click-to-edit', () => {
  it('click swaps in a textarea with the raw body (hashtags kept), focused', () => {
    mount();
    expect(text().textContent).toBe('River at dawn.');
    act(() => text().click());
    expect(area()!.value).toBe('River at dawn. #walks #film');
    expect(document.activeElement).toBe(area());
  });

  it('blur saves a changed draft once; an unchanged draft saves nothing', () => {
    const p = mount();
    act(() => text().click());
    act(() => area()!.blur());
    expect(p.onSave).not.toHaveBeenCalled();
    act(() => text().click());
    type(area()!, 'River at dusk. #walks');
    act(() => area()!.blur());
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect(p.onSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'K-F07' }), 'River at dusk. #walks');
    expect(area()).toBeNull();
  });

  it('Esc while editing saves and leaves edit mode without closing; arrows do not change photo', () => {
    const p = mount();
    act(() => text().click());
    type(area()!, 'new text');
    key('ArrowRight');
    expect(p.onIndex).not.toHaveBeenCalled();
    key('Escape');
    expect(p.onSave).toHaveBeenCalledWith(expect.anything(), 'new text');
    expect(p.onClose).not.toHaveBeenCalled();
    expect(area()).toBeNull();
    key('Escape');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('without onSave the text is not editable', () => {
    mount({ onSave: undefined });
    act(() => text().click());
    expect(area()).toBeNull();
  });

  it('shows the image id when it differs from the note id, and the chat button passes the image id', () => {
    const p = mount({ index: 1 });
    expect(document.querySelector('[data-image-id]')?.textContent).toContain('M-N11');
    act(() => (document.querySelector('[aria-label="Chat about this image"]') as HTMLElement).click());
    expect(p.onChatAbout).toHaveBeenCalledWith('M-N11');
  });
});
