// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ChatInline, NoteLinkContext, type NoteLinks } from './ChatText';

afterEach(cleanup);

/**
 * Click `el`. True when the page cancelled the click (no navigation). A bubbling document listener
 * records whether it was cancelled before it got there, then cancels it so jsdom does not try to
 * navigate a click the page left alone. A click the page stopped never reaches it: then the
 * dispatch result says whether it was cancelled.
 */
function press(el: Element, init: MouseEventInit = {}): boolean {
  const box: { seen: boolean | null } = { seen: null };
  const stop = (e: Event) => {
    box.seen = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', stop);
  try {
    const notCancelled = fireEvent.click(el, init);
    return box.seen ?? !notCancelled;
  } finally {
    document.removeEventListener('click', stop);
  }
}

function renderWith(text: string, links: NoteLinks | null, streaming = false) {
  return render(
    <NoteLinkContext.Provider value={links}>
      <p>
        <ChatInline text={text} streaming={streaming} />
      </p>
    </NoteLinkContext.Provider>,
  );
}

const linkOf = (c: HTMLElement, id: string) => c.querySelector(`[data-note-link="${id}"]`) as HTMLAnchorElement;

describe('ChatInline note links', () => {
  it('renders a real /?note= link with no new-tab target and no data-note', () => {
    const { container } = renderWith('see a-b32 and https://e.com', { isKnown: (id) => id === 'A-B32', open: vi.fn() });
    const a = linkOf(container, 'A-B32');
    expect(a.textContent).toBe('a-b32');
    expect(a.getAttribute('href')).toBe('/?note=A-B32');
    expect(a.className).toBe('answer-link note-link');
    expect(a.getAttribute('target')).toBeNull();
    expect(container.querySelector('[data-note]')).toBeNull();
    expect(container.querySelector('a[target="_blank"]')?.getAttribute('href')).toBe('https://e.com');
    expect(container.textContent).toBe('see a-b32 and https://e.com');
  });

  it('a plain click opens the note in place and cancels navigation', () => {
    const open = vi.fn();
    const { container } = renderWith('see A-B32 now', { isKnown: () => false, open });
    expect(press(linkOf(container, 'A-B32'))).toBe(true);
    expect(open).toHaveBeenCalledWith('A-B32');
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])('a modified click %j is left to the browser', (init) => {
    const open = vi.fn();
    const { container } = renderWith('see A-B32 now', { isKnown: () => false, open });
    expect(press(linkOf(container, 'A-B32'), init)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('a wall deep link keeps a real same-origin /?note= href; only a plain click is intercepted', () => {
    const open = vi.fn();
    const { container } = renderWith('see [that note](http://localhost:7317/?note=A-B32)', { isKnown: () => false, open });
    const a = linkOf(container, 'A-B32');
    expect(a.textContent).toBe('that note');
    expect(a.getAttribute('href')).toBe('/?note=A-B32');
    expect(a.getAttribute('target')).toBeNull();
    expect(press(a, { ctrlKey: true })).toBe(false);
    expect(press(a, { button: 1 })).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(press(a)).toBe(true);
    expect(open).toHaveBeenCalledWith('A-B32');
  });

  it('without a provider an id is a plain link and a click is not intercepted', () => {
    const { container } = renderWith('see A-B32 now', null);
    expect(linkOf(container, 'A-B32').getAttribute('href')).toBe('/?note=A-B32');
    expect(press(linkOf(container, 'A-B32'))).toBe(false);
  });

  it('without a provider a lower-case id is not linked (nothing is known)', () => {
    const { container } = renderWith('see a-b32 now', null);
    expect(container.querySelector('a')).toBeNull();
  });

  it('a code span is not linked', () => {
    const { container } = renderWith('run `notes get A-B32` first', { isKnown: () => true, open: vi.fn() });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('run `notes get A-B32` first');
  });

  it('a streaming id at the end is not linked until the next character', () => {
    const links: NoteLinks = { isKnown: () => true, open: vi.fn() };
    const { container, rerender } = renderWith('see A-B32', links, true);
    expect(container.querySelector('a')).toBeNull();
    rerender(
      <NoteLinkContext.Provider value={links}>
        <p>
          <ChatInline text="see A-B32." streaming />
        </p>
      </NoteLinkContext.Provider>,
    );
    expect(linkOf(container, 'A-B32')).not.toBeNull();
  });
});
