// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AnswerPanel } from './AnswerPanel';
import type { AnswerPanelProps } from './AnswerPanel';

afterEach(cleanup);

function props(over: Partial<AnswerPanelProps> = {}): AnswerPanelProps {
  return {
    left: 0,
    query: 'what did I read',
    text: '',
    done: true,
    status: '',
    brain: null,
    pinned: false,
    usedIds: [],
    onTogglePin: vi.fn(),
    onClose: vi.fn(),
    onJump: vi.fn(),
    ...over,
  };
}

function renderPanel(over: Partial<AnswerPanelProps> = {}) {
  return render(<AnswerPanel {...props(over)} />);
}

function body(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.answer-body');
  if (!(el instanceof HTMLElement)) throw new Error('no .answer-body');
  return el;
}

describe('AnswerPanel links', () => {
  it('renders markdown links and bare URLs as real anchors that open in a new tab', () => {
    const { container } = renderPanel({
      text: 'Try the [BookBrowse summary](https://www.bookbrowse.com/x).\n\nAlso https://example.com/a, which helps.',
    });
    const links = [...body(container).querySelectorAll('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['BookBrowse summary', 'https://www.bookbrowse.com/x'],
      ['https://example.com/a', 'https://example.com/a'],
    ]);
    for (const a of links) {
      expect(a.className).toBe('answer-link');
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noreferrer noopener');
    }
    expect(body(container).querySelectorAll('p')).toHaveLength(2);
    expect(body(container).textContent).not.toContain('](');
  });

  it('keeps a javascript: link as text, with no anchor', () => {
    const { container } = renderPanel({ text: 'bad [x](javascript:alert(1)) here' });
    expect(body(container).querySelector('a')).toBeNull();
  });

  it('shows an unfinished link as plain label text while streaming, with the cursor', () => {
    const { container, rerender } = renderPanel({ text: 'See the [BookBrowse summ', done: false });
    expect(body(container).querySelector('a')).toBeNull();
    expect(body(container).textContent).toBe('See the BookBrowse summ ▍');

    rerender(<AnswerPanel {...props({ text: 'See the [BookBrowse summary](https://bo', done: false })} />);
    expect(body(container).querySelector('a')).toBeNull();
    expect(body(container).textContent).toBe('See the BookBrowse summary ▍');

    rerender(<AnswerPanel {...props({ text: 'See the [BookBrowse summary](https://bookbrowse.com/s).', done: true })} />);
    const a = body(container).querySelector('a');
    expect(a?.textContent).toBe('BookBrowse summary');
    expect(a?.getAttribute('href')).toBe('https://bookbrowse.com/s');
    expect(body(container).textContent).toBe('See the BookBrowse summary.');
  });

  it('puts the cursor only on the last paragraph while streaming', () => {
    const { container } = renderPanel({ text: 'one https://a.com\n\ntwo', done: false });
    const ps = [...body(container).querySelectorAll('p')].map((p) => p.textContent);
    expect(ps).toEqual(['one https://a.com', 'two ▍']);
  });
});
