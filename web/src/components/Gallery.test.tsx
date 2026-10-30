// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gallery, galleryTile } from './Gallery';
import { photosOf } from '../lib/filter';
import { makeImage, makeNote } from '../testing/fixtures';

vi.mock('../lib/dates', () => ({ relativeDate: () => 'Today' }));

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

const notes = [
  makeNote('K-F07', 'two photos #walks', {
    images: [makeImage('K-F07', { width: 600, height: 400 }), makeImage('M-N11', { note_id: 'K-F07', position: 1, width: 400, height: 600 })],
  }),
  makeNote('A-B32', 'text only'),
  makeNote('D-P90', 'one photo', { images: [makeImage('D-P90', { width: 600, height: 800 })] }),
];

describe('galleryTile', () => {
  it('grow = w/h to 3 places, basis = round(w/h * 230)', () => {
    expect(galleryTile({ width: 600, height: 400 })).toEqual({ grow: '1.500', basis: 345, ar: '600 / 400' });
    expect(galleryTile({ width: 500, height: 700 })).toEqual({ grow: '0.714', basis: 164, ar: '500 / 700' });
    expect(galleryTile({ width: 600, height: 600 })).toEqual({ grow: '1.000', basis: 230, ar: '600 / 600' });
    expect(galleryTile({ width: 640, height: 427 }).basis).toBe(345);
  });
});

describe('Gallery', () => {
  it('renders one tile per image in note order, a trailing spacer, and opens the modal on the clicked image', () => {
    const el = render(<Gallery items={photosOf(notes, [])} copiedId={null} onCopy={() => {}} />);
    const section = el.querySelector('[data-gallery]')!;
    const tiles = Array.from(section.querySelectorAll('[data-photo]'));
    expect(tiles.map((t) => t.getAttribute('data-photo'))).toEqual(['K-F07', 'M-N11', 'D-P90']);
    expect(tiles.map((t) => t.getAttribute('data-note'))).toEqual(['K-F07', 'K-F07', 'D-P90']);
    expect(tiles[1].querySelector('img')!.getAttribute('src')).toBe('/api/images/M-N11/thumb');
    expect(section.lastElementChild!.hasAttribute('data-gallery-spacer')).toBe(true);
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
    act(() => {
      (el.querySelector('[data-photo="M-N11"]') as HTMLElement).click();
    });
    const modal = document.querySelector('[data-modal="photo"]')!;
    expect(modal).not.toBeNull();
    expect(modal.querySelector('[data-meta]')!.textContent).toBe('2 / 3  2/2  Today');
    expect(modal.querySelector('img')!.getAttribute('src')).toBe('/api/images/M-N11/display');
  });

  it('closes the modal when the open image leaves the list', () => {
    const items = photosOf(notes, []);
    const el = render(<Gallery items={items} copiedId={null} onCopy={() => {}} />);
    act(() => {
      (el.querySelector('[data-photo="M-N11"]') as HTMLElement).click();
    });
    act(() => root!.render(<Gallery items={items.filter((it) => it.image.id !== 'M-N11')} copiedId={null} onCopy={() => {}} />));
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
  });
});
