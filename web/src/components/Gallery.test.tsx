// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gallery, galleryTile } from './Gallery';
import type { ImageNote } from './NoteImage';

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

const n = (id: string, w: number, h: number, tags: string[] = []): ImageNote => ({
  id,
  body: `photo ${tags.map((t) => '#' + t).join(' ')}`,
  tags,
  created_at: '2026-10-30T01:00:00.000Z',
  image: { width: w, height: h, available: true, host: null },
});

describe('galleryTile', () => {
  it('grow = w/h to 3 places, basis = round(w/h * 230)', () => {
    expect(galleryTile({ width: 600, height: 400 })).toEqual({ grow: '1.500', basis: 345, ar: '600 / 400' });
    expect(galleryTile({ width: 500, height: 700 })).toEqual({ grow: '0.714', basis: 164, ar: '500 / 700' });
    expect(galleryTile({ width: 600, height: 600 })).toEqual({ grow: '1.000', basis: 230, ar: '600 / 600' });
    expect(galleryTile({ width: 640, height: 427 }).basis).toBe(345);
  });
});

describe('Gallery', () => {
  it('renders one tile per photo, a trailing spacer, and opens the modal on click', () => {
    const photos = [n('K-F07', 600, 400), n('D-P90', 600, 800)];
    const el = render(<Gallery photos={photos} copiedId={null} onCopy={() => {}} />);
    const section = el.querySelector('[data-gallery]')!;
    expect(section.querySelectorAll('[data-photo]').length).toBe(2);
    expect(section.lastElementChild!.hasAttribute('data-gallery-spacer')).toBe(true);
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
    act(() => {
      (el.querySelector('[data-photo="D-P90"]') as HTMLElement).click();
    });
    const modal = document.querySelector('[data-modal="photo"]')!;
    expect(modal).not.toBeNull();
    expect(modal.querySelector('[data-meta]')!.textContent).toBe('2 / 2  Today');
  });

  it('closes the modal when the open photo leaves the list', () => {
    const photos = [n('K-F07', 600, 400), n('D-P90', 600, 800)];
    const el = render(<Gallery photos={photos} copiedId={null} onCopy={() => {}} />);
    act(() => {
      (el.querySelector('[data-photo="D-P90"]') as HTMLElement).click();
    });
    act(() => root!.render(<Gallery photos={[photos[0]]} copiedId={null} onCopy={() => {}} />));
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
  });
});
