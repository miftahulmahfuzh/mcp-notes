// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { NoteRevealButton } from './NoteRevealButton';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/reveal') ? json({ ok: true }, 202) : json({ error: 'not_found' }, 404),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCapabilitiesForTests();
});

const local = { available: true };
const away = { available: false };

describe('NoteRevealButton', () => {
  it('renders for a note with a local file or a local image when caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const files = render(<NoteRevealButton note={{ id: 'A-B32', images: [], files: [local] }} />);
    expect(files.container.querySelector('[data-reveal-note="A-B32"]')).not.toBeNull();
    files.unmount();
    const images = render(<NoteRevealButton note={{ id: 'K-F07', images: [local] }} />);
    const btn = images.container.querySelector('[data-reveal-note="K-F07"]') as HTMLElement;
    expect(btn.getAttribute('aria-label')).toBe('Show in Explorer');
    expect(btn.className).toBe('copybtn');
  });

  it('renders nothing when nothing is local, for a text note, or without caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [away], files: [away] }} />).container.querySelector('button')).toBeNull();
    cleanup();
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [], files: [] }} />).container.querySelector('button')).toBeNull();
    cleanup();
    // Files decide when the note has any (the route opens the files folder): a local image does not help.
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [local], files: [away] }} />).container.querySelector('button')).toBeNull();
    cleanup();
    resetCapabilitiesForTests({ reveal: false });
    expect(render(<NoteRevealButton note={{ id: 'A-B32', images: [local], files: [local] }} />).container.querySelector('button')).toBeNull();
  });

  it('click POSTs /api/notes/<id>/reveal and does not reach the parent', async () => {
    resetCapabilitiesForTests({ reveal: true });
    const parent = vi.fn();
    const { container } = render(
      <div onClick={parent}>
        <NoteRevealButton note={{ id: 'C-D45', images: [], files: [local] }} className="ed-btn" />
      </div>,
    );
    const btn = container.querySelector('[data-reveal-note]') as HTMLElement;
    expect(btn.className).toBe('ed-btn');
    fireEvent.click(btn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notes/C-D45/reveal');
    expect(init.method).toBe('POST');
    expect(parent).not.toHaveBeenCalled();
  });

  it('a failed reveal only logs a quiet warning', async () => {
    resetCapabilitiesForTests({ reveal: true });
    fetchMock.mockImplementation(async () => json({ error: 'spawn_failed' }, 500));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(<NoteRevealButton note={{ id: 'C-D45', images: [local] }} />);
    fireEvent.click(container.querySelector('[data-reveal-note]') as HTMLElement);
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0][0])).toContain('C-D45');
    expect(String(warn.mock.calls[0][1])).toBe('spawn_failed');
  });
});
