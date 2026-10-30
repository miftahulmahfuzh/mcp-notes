// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhotoModal, stepIndex, stripTags } from './PhotoModal';
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
  vi.restoreAllMocks();
});

const photo = (id: string, body: string, tags: string[]): ImageNote => ({
  id,
  body,
  tags,
  created_at: '2026-10-30T01:00:00.000Z',
  image: { width: 600, height: 400, available: true, host: null },
});
const photos = [
  photo('K-F07', 'River below the old bridge, 6:40am. Fog lifting. #walks #film', ['walks', 'film']),
  photo('D-P90', 'Pug on the tram again. #walks', ['walks']),
  photo('B-Y66', '#film #kitchen', ['film', 'kitchen']),
];

function key(k: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

describe('stepIndex / stripTags', () => {
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
});

describe('PhotoModal', () => {
  it('shows text without tags, tag chips, id and meta', () => {
    render(<PhotoModal photos={photos} index={0} onIndex={() => {}} onClose={() => {}} copiedId={null} onCopy={() => {}} />);
    const modal = document.querySelector('[data-modal="photo"]')!;
    expect(modal.querySelector('p')!.textContent).toBe('River below the old bridge, 6:40am. Fog lifting.');
    expect(modal.textContent).toContain('#walks');
    expect(modal.textContent).toContain('#film');
    expect(modal.textContent).toContain('K-F07');
    expect(modal.querySelector('[data-meta]')!.textContent).toBe('1 / 3  Today');
    expect(modal.querySelector('img')!.getAttribute('src')).toBe('/api/notes/K-F07/display');
  });

  it('arrow keys step with wraparound; Escape closes and does not reach document listeners', () => {
    const onIndex = vi.fn();
    const onClose = vi.fn();
    const docEsc = vi.fn();
    document.addEventListener('keydown', docEsc);
    render(<PhotoModal photos={photos} index={0} onIndex={onIndex} onClose={onClose} copiedId={null} onCopy={() => {}} />);
    key('ArrowLeft');
    expect(onIndex).toHaveBeenLastCalledWith(2);
    key('ArrowRight');
    expect(onIndex).toHaveBeenLastCalledWith(1);
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(docEsc).not.toHaveBeenCalled();
    key('a');
    expect(docEsc).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', docEsc);
  });

  it('wraps forward from the last photo via the Next button', () => {
    const onIndex = vi.fn();
    render(<PhotoModal photos={photos} index={2} onIndex={onIndex} onClose={() => {}} copiedId={null} onCopy={() => {}} />);
    act(() => {
      (document.querySelector('[data-tip="Next"]') as HTMLElement).click();
    });
    expect(onIndex).toHaveBeenCalledWith(0);
  });

  it('backdrop click closes; clicks on the image, panel and prev do not', () => {
    const onClose = vi.fn();
    render(<PhotoModal photos={photos} index={1} onIndex={() => {}} onClose={onClose} copiedId={null} onCopy={() => {}} />);
    const modal = document.querySelector('[data-modal="photo"]') as HTMLElement;
    act(() => (modal.querySelector('img') as HTMLElement).click());
    act(() => (modal.querySelector('p') as HTMLElement).click());
    act(() => (modal.querySelector('[data-tip="Previous"]') as HTMLElement).click());
    expect(onClose).not.toHaveBeenCalled();
    act(() => modal.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copy calls onCopy, "copied" follows copiedId, and full screen opens /full/<id>', () => {
    const onCopy = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<PhotoModal photos={photos} index={1} onIndex={() => {}} onClose={() => {}} copiedId={'D-P90'} onCopy={onCopy} />);
    act(() => (document.querySelector('[data-tip="Copy ID"]') as HTMLElement).click());
    expect(onCopy).toHaveBeenCalledWith('D-P90');
    expect(document.querySelector('[data-modal="photo"]')!.textContent).toContain('copied');
    act(() => (document.querySelector('[data-tip="Show full screen"]') as HTMLElement).click());
    expect(open).toHaveBeenCalledWith('/full/D-P90', '_blank', 'noopener');
  });
});
