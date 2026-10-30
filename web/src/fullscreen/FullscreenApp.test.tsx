// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FullscreenApp, idFromLocation } from './FullscreenApp';
import { initialView, viewReducer } from './view';

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
  vi.unstubAllGlobals();
});

function mouse(el: Element, type: string, x: number, y: number) {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  });
}

describe('viewReducer', () => {
  it('a click (no move) toggles fit and resets the pan', () => {
    let s = viewReducer(initialView, { type: 'down', x: 10, y: 10 });
    s = viewReducer(s, { type: 'up' });
    expect(s).toEqual({ fit: false, x: 0, y: 0, drag: null });
    s = viewReducer(s, { type: 'down', x: 0, y: 0 });
    s = viewReducer(s, { type: 'up' });
    expect(s.fit).toBe(true);
  });
  it('moves within the 4px threshold still count as a click', () => {
    let s = viewReducer({ ...initialView, fit: false }, { type: 'down', x: 0, y: 0 });
    s = viewReducer(s, { type: 'move', x: 2, y: 2 });
    expect(s.x).toBe(0);
    s = viewReducer(s, { type: 'up' });
    expect(s.fit).toBe(true);
  });
  it('a drag past the threshold pans and does not toggle', () => {
    let s = viewReducer({ fit: false, x: 5, y: 5, drag: null }, { type: 'down', x: 100, y: 100 });
    s = viewReducer(s, { type: 'move', x: 130, y: 90 });
    expect([s.x, s.y]).toEqual([35, -5]);
    s = viewReducer(s, { type: 'move', x: 101, y: 100 });
    expect([s.x, s.y]).toEqual([6, 5]);
    s = viewReducer(s, { type: 'up' });
    expect(s.fit).toBe(false);
    expect([s.x, s.y]).toEqual([6, 5]);
  });
  it('dragging does nothing in fit mode; leave cancels a drag', () => {
    let s = viewReducer(initialView, { type: 'down', x: 0, y: 0 });
    s = viewReducer(s, { type: 'move', x: 50, y: 50 });
    expect([s.x, s.y, s.drag?.moved]).toEqual([0, 0, false]);
    s = viewReducer(s, { type: 'leave' });
    expect(s.drag).toBeNull();
  });
});

describe('idFromLocation', () => {
  it('reads /full/<id> and falls back to ?id=', () => {
    expect(idFromLocation({ pathname: '/full/A-B32', search: '' })).toBe('A-B32');
    expect(idFromLocation({ pathname: '/full/A-B32/', search: '' })).toBe('A-B32');
    expect(idFromLocation({ pathname: '/fullscreen.html', search: '?id=K-F07' })).toBe('K-F07');
    expect(idFromLocation({ pathname: '/', search: '' })).toBeNull();
  });
});

describe('FullscreenApp', () => {
  it('sets the title, shows the unfiltered display image, click toggles fit, drag does not', () => {
    const el = render(<FullscreenApp id="A-B32" />);
    expect(document.title).toBe('A-B32');
    const img = el.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/notes/A-B32/display');
    expect(img.style.filter).toBe('');
    expect(img.dataset.fit).toBe('fit');
    const stage = el.querySelector('[data-fullscreen]')!;

    mouse(stage, 'mousedown', 100, 100);
    mouse(stage, 'mouseup', 100, 100);
    expect(el.querySelector('img')!.dataset.fit).toBe('actual');
    expect((stage as HTMLElement).style.cursor).toBe('grab');

    mouse(stage, 'mousedown', 100, 100);
    mouse(stage, 'mousemove', 140, 100);
    expect((stage as HTMLElement).style.cursor).toBe('grabbing');
    mouse(stage, 'mouseup', 140, 100);
    expect(el.querySelector('img')!.dataset.fit).toBe('actual');

    mouse(stage, 'mousedown', 10, 10);
    mouse(stage, 'mouseup', 10, 10);
    expect(el.querySelector('img')!.dataset.fit).toBe('fit');
  });

  it('shows the placeholder with the host when the display endpoint 404s not_on_this_machine', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/notes/K-F07/display') {
        return new Response(JSON.stringify({ error: 'not_on_this_machine', host: 'lenovo' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'K-F07', image: { width: 600, height: 400 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const el = render(<FullscreenApp id="K-F07" />);
    act(() => {
      el.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    for (let i = 0; i < 10; i++) await act(async () => {});
    expect(el.querySelector('img')).toBeNull();
    const ph = el.querySelector('[data-placeholder="image"]') as HTMLElement;
    expect(ph.textContent).toContain('not on this machine');
    expect(ph.textContent).toContain('lenovo');
    expect(ph.style.aspectRatio).toBe('600 / 400');
  });
});
