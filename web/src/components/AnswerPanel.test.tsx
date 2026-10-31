// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    collapsed: false,
    usedIds: [],
    onTogglePin: vi.fn(),
    onToggleCollapse: vi.fn(),
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

function head(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.answer-head');
  if (!(el instanceof HTMLElement)) throw new Error('no .answer-head');
  return el;
}

describe('AnswerPanel collapse', () => {
  it('shows a Collapse caret beside pin and dismiss while expanded', () => {
    const onToggleCollapse = vi.fn();
    const { container } = renderPanel({ text: 'An answer.', onToggleCollapse });
    const labels = [...head(container).querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Collapse', 'Pin', 'Dismiss']);
    const btn = screen.getByRole('button', { name: 'Collapse' });
    expect(btn.getAttribute('data-tip')).toBe('Collapse');
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
    fireEvent.click(btn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.answer')?.className).toBe('answer');
    expect(container.querySelector('.answer-body')).not.toBeNull();
  });

  it('collapsed renders the header line only, with an Expand caret', () => {
    const { container } = renderPanel({ text: 'Look at A-B32.', usedIds: ['A-B32'], collapsed: true, brain: 'claude' });
    expect(container.querySelector('.answer')?.className).toBe('answer collapsed');
    expect(container.querySelector('.answer-body')).toBeNull();
    expect(container.querySelector('.used-row')).toBeNull();
    expect(head(container).querySelector('.answer-q')?.textContent).toBe('what did I read');
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('claude');
    const btn = screen.getByRole('button', { name: 'Expand' });
    expect(btn.getAttribute('data-tip')).toBe('Expand');
    expect(screen.queryByRole('button', { name: 'Collapse' })).toBeNull();
  });

  it('clicking the collapsed line outside the buttons expands it', () => {
    const onToggleCollapse = vi.fn();
    const onTogglePin = vi.fn();
    const onClose = vi.fn();
    const { container } = renderPanel({ collapsed: true, onToggleCollapse, onTogglePin, onClose });
    fireEvent.click(head(container).querySelector('.answer-q') as HTMLElement);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    fireEvent.click(head(container));
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(3);
  });

  it('clicking the header of an expanded panel does nothing', () => {
    const onToggleCollapse = vi.fn();
    const { container } = renderPanel({ onToggleCollapse });
    fireEvent.click(head(container).querySelector('.answer-q') as HTMLElement);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it('keeps the live status in the collapsed line while streaming, then the brain', () => {
    const { container, rerender } = renderPanel({ collapsed: true, done: false, status: 'searching notes', text: 'Partial' });
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('searching notes');
    expect(container.querySelector('.answer-body')).toBeNull();

    rerender(<AnswerPanel {...props({ collapsed: true, done: false, status: 'reading 3 notes', text: 'Partial answer' })} />);
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('reading 3 notes');

    rerender(<AnswerPanel {...props({ collapsed: true, done: true, brain: 'claude', text: 'Full answer.' })} />);
    expect(head(container).querySelector('.answer-status')?.textContent).toBe('claude');

    rerender(<AnswerPanel {...props({ collapsed: false, done: true, brain: 'claude', text: 'Full answer.' })} />);
    expect(body(container).textContent).toBe('Full answer.');
  });

  it('shows a multi-line query on one line, with the full query in the tooltip', () => {
    const query = 'cari notes\nyang membahas\n\nfitur';
    const { container } = renderPanel({ query });
    const q = head(container).querySelector('.answer-q');
    expect(q?.textContent).toBe('cari notes yang membahas fitur');
    expect(q?.getAttribute('data-tip')).toBe(query);
  });
});

describe('AnswerPanel pasted images', () => {
  it('shows the thumbnails sent with the query', () => {
    const { container } = renderPanel({ images: ['U-PL1', 'V-QM2'] });
    const srcs = [...container.querySelectorAll('.answer-images img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual(['/api/chat/images/U-PL1/thumb', '/api/chat/images/V-QM2/thumb']);
  });

  it('labels an image-only question by its image count', () => {
    const { container } = renderPanel({ query: '', images: ['U-PL1'] });
    expect(container.querySelector('.answer-q')?.textContent).toBe('1 image');
  });

  it('hides the thumbnails when collapsed, and shows none without images', () => {
    const collapsed = renderPanel({ images: ['U-PL1'], collapsed: true });
    expect(collapsed.container.querySelector('.answer-images')).toBeNull();
    collapsed.unmount();
    const plain = renderPanel();
    expect(plain.container.querySelector('.answer-images')).toBeNull();
  });
});

describe('AnswerPanel full screen', () => {
  it('shows a "Chat in full screen" button only when the host passes onFullScreen', () => {
    const onFullScreen = vi.fn();
    const { rerender } = render(<AnswerPanel {...props()} />);
    expect(screen.queryByRole('button', { name: 'Chat in full screen' })).toBeNull();
    rerender(<AnswerPanel {...props({ onFullScreen })} />);
    const btn = screen.getByRole('button', { name: 'Chat in full screen' });
    expect(btn.getAttribute('data-tip')).toBe('Chat in full screen');
    fireEvent.click(btn);
    expect(onFullScreen).toHaveBeenCalledTimes(1);
  });

  it('works from the collapsed header without expanding it', () => {
    const onFullScreen = vi.fn();
    const onToggleCollapse = vi.fn();
    render(<AnswerPanel {...props({ collapsed: true, onFullScreen, onToggleCollapse })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat in full screen' }));
    expect(onFullScreen).toHaveBeenCalledTimes(1);
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});

describe('AnswerPanel sent thumbnails', () => {
  it('a thumbnail opens the shared Lightbox; Esc closes only the lightbox', () => {
    const onClose = vi.fn();
    render(<AnswerPanel {...props({ images: ['U-AA1', 'U-BB2'], onClose })} />);
    fireEvent.click(screen.getByRole('button', { name: 'View image upload:U-BB2' }));
    expect(document.querySelector('[data-lightbox] img')?.getAttribute('src')).toBe('/api/chat/images/U-BB2/display');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.querySelector('[data-lightbox]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
