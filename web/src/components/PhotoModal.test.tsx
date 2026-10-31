// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhotoModal, metaLine, stepIndex, stripTags } from './PhotoModal';
import { photosOf } from '../lib/filter';
import { makeNote } from '../testing/fixtures';

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
  vi.restoreAllMocks();
});

// 4 items: K-F07 (2 images: K-F07, M-N11), D-P90 (1), B-Y66 (1).
const items = photosOf(
  [
    makeNote('K-F07', 'River below the old bridge, 6:40am. Fog lifting. #walks #film', { images: ['K-F07', 'M-N11'] }),
    makeNote('D-P90', 'Pug on the tram again. #walks', { images: ['D-P90'] }),
    makeNote('B-Y66', '#film #kitchen', { images: ['B-Y66'] }),
  ],
  [],
);

function key(k: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

function modal(index: number, over: Partial<React.ComponentProps<typeof PhotoModal>> = {}) {
  render(<PhotoModal items={items} index={index} onIndex={() => {}} onClose={() => {}} copiedId={null} onCopy={() => {}} {...over} />);
  return document.querySelector('[data-modal="photo"]') as HTMLElement;
}

describe('PhotoModal layout (long descriptions)', () => {
  it('bounds the grid to one viewport-tall row so a long description cannot push the photo off-screen', () => {
    const el = modal(0);
    expect(el.style.gridTemplateRows).toBe('minmax(0,1fr)');
  });

  it('puts the description, tags and id row in the scrolling region and keeps the toolbar outside it', () => {
    const el = modal(0);
    const scroll = el.querySelector('[data-pm-scroll]') as HTMLElement;
    expect(scroll).not.toBeNull();
    expect(scroll.textContent).toContain('River below the old bridge');
    expect(scroll.querySelector('[data-meta]')).not.toBeNull();
    expect(scroll.querySelector('button')).toBeNull();
    expect(el.querySelector('[aria-label="Close"]')).not.toBeNull();
  });
});

describe('stepIndex / stripTags / metaLine', () => {
  it('wraps both ways', () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(1, 1, 3)).toBe(2);
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
  it('strips hashtags and collapses whitespace, keeping C# and a#b', () => {
    expect(stripTags('River below the old bridge, 6:40am. Fog lifting. #walks #film')).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(stripTags('#film #kitchen')).toBe('');
    expect(stripTags('learn C# and a#b #todo')).toBe('learn C# and a#b');
  });
  it('shows k/n only for multi-image notes', () => {
    expect(metaLine(2, 7, { k: 2, n: 3 }, 'Today')).toBe('3 / 7  2/3  Today');
    expect(metaLine(0, 1, { k: 1, n: 1 }, 'Today')).toBe('1 / 1  Today');
  });
});

describe('PhotoModal', () => {
  it('shows the note text without tags, tag chips, the note id, and meta with k/n', () => {
    const m = modal(0);
    expect(m.querySelector('p')!.textContent).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(m.textContent).toContain('#walks');
    expect(m.textContent).toContain('#film');
    expect(m.textContent).toContain('K-F07');
    expect(m.querySelector('[data-meta]')!.textContent).toBe('1 / 4  1/2  Today');
    expect(m.querySelector('img')!.getAttribute('src')).toBe('/api/images/K-F07/display');
  });

  it('the second image of a note shows that image, the same note, and 2/2', () => {
    const m = modal(1);
    expect(m.querySelector('img')!.getAttribute('src')).toBe('/api/images/M-N11/display');
    expect(m.querySelector('p')!.textContent).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(m.querySelector('[data-meta]')!.textContent).toBe('2 / 4  2/2  Today');
  });

  it('a single-image note has no k/n', () => {
    const m = modal(2);
    expect(m.querySelector('[data-meta]')!.textContent).toBe('3 / 4  Today');
    expect(m.textContent).toContain('D-P90');
  });

  it('arrow keys step image by image with wraparound; Escape closes and does not reach document listeners', () => {
    const onIndex = vi.fn();
    const onClose = vi.fn();
    const docEsc = vi.fn();
    document.addEventListener('keydown', docEsc);
    modal(0, { onIndex, onClose });
    key('ArrowLeft');
    expect(onIndex).toHaveBeenLastCalledWith(3);
    key('ArrowRight');
    expect(onIndex).toHaveBeenLastCalledWith(1);
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(docEsc).not.toHaveBeenCalled();
    key('a');
    expect(docEsc).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', docEsc);
  });

  it('Next steps from the last image of a note to the next note, and wraps from the end', () => {
    const onIndex = vi.fn();
    modal(1, { onIndex });
    act(() => (document.querySelector('[data-tip="Next"]') as HTMLElement).click());
    expect(onIndex).toHaveBeenLastCalledWith(2);
    act(() => root!.render(<PhotoModal items={items} index={3} onIndex={onIndex} onClose={() => {}} copiedId={null} onCopy={() => {}} />));
    act(() => (document.querySelector('[data-tip="Next"]') as HTMLElement).click());
    expect(onIndex).toHaveBeenLastCalledWith(0);
  });

  it('backdrop click closes; clicks on the image, panel and prev do not', () => {
    const onClose = vi.fn();
    const m = modal(1, { onClose });
    act(() => (m.querySelector('img') as HTMLElement).click());
    act(() => (m.querySelector('p') as HTMLElement).click());
    act(() => (m.querySelector('[data-tip="Previous"]') as HTMLElement).click());
    expect(onClose).not.toHaveBeenCalled();
    act(() => m.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copy copies the note id, "copied" follows copiedId, and full screen opens /full/<imageId>', () => {
    const onCopy = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const m = modal(1, { copiedId: 'K-F07', onCopy });
    act(() => (document.querySelector('[data-tip="Copy ID"]') as HTMLElement).click());
    expect(onCopy).toHaveBeenCalledWith('K-F07');
    expect(m.textContent).toContain('copied');
    act(() => (document.querySelector('[data-tip="Show full screen"]') as HTMLElement).click());
    expect(open).toHaveBeenCalledWith('/full/M-N11', '_blank', 'noopener');
  });
});
