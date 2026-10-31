// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { makeImage } from '../testing/fixtures';
import { FILM_FILTER } from './NoteImage';
import { Lightbox, adjacentIndex, isLightboxOpen, noteImageItems, type LightboxItem } from './Lightbox';

afterEach(cleanup);

const items: LightboxItem[] = [
  { id: 'A-B32', src: '/x/A-B32.png', label: 'first.png', width: 600, height: 400, film: true },
  { id: 'Q-RS1', src: '/x/Q-RS1.png', label: 'second.png', width: 400, height: 600 },
  { id: 'Z-ZZ9', src: '/x/Z-ZZ9.png' },
];

/** Controlled host: owns the index like NoteEditor does. */
function Host({ start = 0, onClose = () => {} }: { start?: number; onClose?: () => void }) {
  const [i, setI] = useState(start);
  return <Lightbox items={items} index={i} onIndex={setI} onClose={onClose} />;
}

/** Opener button + lightbox, unmounted on close: the real lifecycle. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open && <Lightbox items={items} index={1} onIndex={() => {}} onClose={() => setOpen(false)} />}
    </>
  );
}

const shown = () => document.querySelector('[data-lightbox] img') as HTMLImageElement | null;
const count = () => document.querySelector('[data-lightbox-count]')?.textContent;
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.body, { key: k, ...init });

describe('adjacentIndex', () => {
  it('steps inside the list and returns -1 past either end (no wrap)', () => {
    expect(adjacentIndex(0, 1, 3)).toBe(1);
    expect(adjacentIndex(2, -1, 3)).toBe(1);
    expect(adjacentIndex(2, 1, 3)).toBe(-1);
    expect(adjacentIndex(0, -1, 3)).toBe(-1);
    expect(adjacentIndex(0, 1, 0)).toBe(-1);
  });
});

describe('noteImageItems', () => {
  it('keeps available images in order, with the display url, the file name and the film tone', () => {
    const a = makeImage('A-B32', { original_name: 'a.jpg' });
    const gone = makeImage('C-DD4', { available: false });
    const b = makeImage('Q-RS1');
    expect(noteImageItems([a, gone, b])).toEqual([
      { id: 'A-B32', src: '/api/images/A-B32/display', label: 'a.jpg', width: 600, height: 400, film: true },
      { id: 'Q-RS1', src: '/api/images/Q-RS1/display', label: 'Q-RS1', width: 600, height: 400, film: true },
    ]);
  });
});

describe('Lightbox', () => {
  it('shows the item at index large, with its position, label and film tone only when asked', () => {
    render(<Host />);
    expect(shown()?.getAttribute('src')).toBe('/x/A-B32.png');
    expect(shown()?.alt).toBe('first.png');
    expect(shown()?.style.filter).toBe(FILM_FILTER);
    expect(shown()?.style.aspectRatio).toBe('600 / 400');
    expect(count()).toBe('1 / 3');
    expect(screen.getByText('first.png')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(shown()?.style.filter).toBe('');
    expect(screen.getByRole('dialog', { name: 'Image viewer' })).toBeTruthy();
  });

  it('the next and previous buttons move to the adjacent image without closing', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(shown()?.getAttribute('src')).toBe('/x/Q-RS1.png');
    expect(count()).toBe('2 / 3');
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(count()).toBe('3 / 3');
    fireEvent.click(screen.getByLabelText('Previous image'));
    expect(count()).toBe('2 / 3');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables the arrows at the ends; clicking a disabled arrow neither wraps nor closes', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const prev = screen.getByLabelText('Previous image') as HTMLButtonElement;
    const next = screen.getByLabelText('Next image') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(prev);
    expect(count()).toBe('1 / 3');
    fireEvent.click(next);
    fireEvent.click(next);
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
    fireEvent.click(next);
    expect(count()).toBe('3 / 3');
    // A click that lands on the nav cell around a disabled button is not a backdrop click.
    fireEvent.click(next.parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ArrowRight / ArrowLeft move between adjacent images and stop at the ends', () => {
    render(<Host />);
    expect(key('ArrowLeft')).toBe(false);
    expect(count()).toBe('1 / 3');
    key('ArrowRight');
    expect(count()).toBe('2 / 3');
    key('ArrowRight');
    key('ArrowRight');
    expect(count()).toBe('3 / 3');
    key('ArrowLeft');
    expect(count()).toBe('2 / 3');
  });

  it('leaves Alt/Ctrl/Meta + arrow to the browser', () => {
    render(<Host />);
    expect(key('ArrowRight', { altKey: true })).toBe(true);
    expect(key('ArrowRight', { ctrlKey: true })).toBe(true);
    expect(count()).toBe('1 / 3');
  });

  it('Esc closes in the capture phase and never reaches document listeners (the chat panel)', () => {
    const onClose = vi.fn();
    const docKey = vi.fn();
    document.addEventListener('keydown', docKey);
    try {
      render(<Host onClose={onClose} />);
      expect(key('Escape')).toBe(false);
      key('ArrowRight');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(docKey).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', docKey);
    }
  });

  it('a window capture listener registered after the lightbox does not see its keys', () => {
    render(<Host />);
    const later = vi.fn();
    window.addEventListener('keydown', later, true);
    try {
      key('Escape');
      key('ArrowRight');
      key('a');
      expect(later.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual(['a']);
    } finally {
      window.removeEventListener('keydown', later, true);
    }
  });

  it('a backdrop click or the X closes; a click on the image or the caption does not', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.click(shown() as HTMLImageElement);
    fireEvent.click(document.querySelector('.lb-meta') as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('.lb-stage') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Close image viewer'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a backdrop click does not bubble to a React ancestor of the host', () => {
    const outer = vi.fn();
    render(
      <div onClick={outer}>
        <Host />
      </div>,
    );
    fireEvent.click(document.querySelector('[data-lightbox]') as HTMLElement);
    fireEvent.click(screen.getByLabelText('Close image viewer'));
    fireEvent.click(screen.getByLabelText('Next image'));
    expect(outer).not.toHaveBeenCalled();
  });

  it('takes focus on open and gives it back to the opener on close', () => {
    render(<Opener />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(document.querySelector('[data-lightbox]'));
    key('Escape');
    expect(document.querySelector('[data-lightbox]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('isLightboxOpen follows the mounted lightbox', () => {
    expect(isLightboxOpen()).toBe(false);
    render(<Opener />);
    fireEvent.click(screen.getByText('open'));
    expect(isLightboxOpen()).toBe(true);
    key('Escape');
    expect(isLightboxOpen()).toBe(false);
  });

  it('an image that fails to load becomes the "unavailable" placeholder; the next image loads normally', () => {
    render(<Host />);
    fireEvent.error(shown() as HTMLImageElement);
    expect(shown()).toBeNull();
    expect(screen.getByRole('img', { name: 'unavailable' })).toBeTruthy();
    key('ArrowRight');
    expect(shown()?.getAttribute('src')).toBe('/x/Q-RS1.png');
  });

  it('renders nothing for an out-of-range index', () => {
    render(<Lightbox items={items} index={5} onIndex={() => {}} onClose={() => {}} />);
    expect(isLightboxOpen()).toBe(false);
  });
});
