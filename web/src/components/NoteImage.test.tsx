// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FILM_FILTER, NoteImage, aspectOf, imageUrl, type ImageNote } from './NoteImage';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const note = (over: Partial<NonNullable<ImageNote['image']>> = {}): ImageNote => ({
  id: 'K-F07',
  body: 'River #walks',
  tags: ['walks'],
  created_at: '2026-10-30T01:00:00.000Z',
  image: { width: 600, height: 400, available: true, host: 'lenovo', ...over },
});

describe('NoteImage', () => {
  it('renders the thumb with the film filter and aspect ratio', () => {
    const el = render(<NoteImage note={note()} variant="thumb" />);
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/notes/K-F07/thumb');
    expect(img.style.filter).toBe(FILM_FILTER);
    expect(img.style.aspectRatio).toBe('600 / 400');
  });

  it('uses the display derivative for the modal variant', () => {
    const el = render(<NoteImage note={note()} variant="display" />);
    expect(el.querySelector('img')!.getAttribute('src')).toBe('/api/notes/K-F07/display');
  });

  it('shows the placeholder with the host when the file is not on this machine', () => {
    const el = render(<NoteImage note={note({ available: false, host: 'lenovo' })} variant="thumb" />);
    expect(el.querySelector('img')).toBeNull();
    const ph = el.querySelector('[data-placeholder="image"]') as HTMLElement;
    expect(ph).not.toBeNull();
    expect(ph.textContent).toContain('not on this machine');
    expect(ph.textContent).toContain('lenovo');
    expect(ph.style.aspectRatio).toBe('600 / 400');
    expect(el.querySelector('button')).toBeNull();
  });

  it('omits the host line when the host is unknown', () => {
    const el = render(<NoteImage note={note({ available: false, host: null })} variant="display" />);
    const ph = el.querySelector('[data-placeholder="image"]')!;
    expect(ph.textContent).toBe('not on this machine');
  });

  it('falls back to an "unavailable" placeholder when the image errors', () => {
    const el = render(<NoteImage note={note()} variant="thumb" />);
    act(() => {
      el.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('unavailable');
  });

  it('renders nothing for a text note', () => {
    const el = render(<NoteImage note={{ ...note(), image: null }} variant="thumb" />);
    expect(el.innerHTML).toBe('');
  });

  it('helpers', () => {
    expect(imageUrl('A-B32', 'original')).toBe('/api/notes/A-B32/original');
    expect(aspectOf({ width: 0, height: 0 }).css).toBe('3 / 2');
  });
});
