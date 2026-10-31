// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Bubble, type BubbleProps } from './Bubble';
import { NoteLinkContext } from './ChatText';
import { makeMessage } from '../testing/chatFixtures';

afterEach(cleanup);

const NOW = new Date('2026-10-31T05:00:00.000Z');

/** P9's Bubble props for a server row (P7 wire message via P9's fixture). */
function bubbleProps(text: string): BubbleProps {
  const msg = makeMessage('K7F2', { thread_id: 'T-HR1', role: 'assistant', text, brain: 'claude' });
  return { item: { key: msg.id, msg, local: null }, now: NOW, focused: false, onOpenImages: vi.fn() };
}

function renderBubble(text: string, open: (id: string) => void) {
  return render(
    <NoteLinkContext.Provider value={{ isKnown: () => false, open }}>
      <ol>
        <Bubble {...bubbleProps(text)} />
      </ol>
    </NoteLinkContext.Provider>,
  );
}

describe('Bubble note ids (phase 11)', () => {
  it('a plain click on an id opens the note through the page and does not navigate', () => {
    const open = vi.fn();
    const { container } = renderBubble('Saved as A-B32, see [it](http://localhost:7317/?note=C-D45).', open);
    const a = container.querySelector('[data-note-link="A-B32"]') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/?note=A-B32');
    expect(fireEvent.click(a)).toBe(false);
    expect(open).toHaveBeenCalledWith('A-B32');
    const wall = container.querySelector('[data-note-link="C-D45"]') as HTMLAnchorElement;
    expect(wall.textContent).toBe('it');
    expect(wall.getAttribute('href')).toBe('/?note=C-D45');
    expect(fireEvent.click(wall)).toBe(false);
    expect(open).toHaveBeenLastCalledWith('C-D45');
  });

  it('a ctrl-click is left to the browser', () => {
    const open = vi.fn();
    const { container } = renderBubble('Saved as A-B32.', open);
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop);
    try {
      fireEvent.click(container.querySelector('[data-note-link="A-B32"]') as HTMLElement, { ctrlKey: true });
    } finally {
      document.removeEventListener('click', stop);
    }
    expect(open).not.toHaveBeenCalled();
  });
});
