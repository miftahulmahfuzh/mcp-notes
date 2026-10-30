// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { Bin as BinData, Note, NoteImage as NoteImageInfo } from '../types';
import { makeImage, makeNote } from '../testing/fixtures';
import { useBin } from '../hooks/useBin';
import { Bin } from './Bin';

const iso = '2026-10-30T01:00:00.000Z';

// Phase 6's shared fixtures (web/src/testing/fixtures.ts).
function img(id: string, noteId: string, position = 0): NoteImageInfo {
  return makeImage(id, { note_id: noteId, position, bytes: 10, original_name: `${id}.jpg` });
}

function note(id: string, body: string, tags: string[], images: NoteImageInfo[] = [], deleted = true): Note {
  const n = makeNote(id, body, { images, tags, created: iso });
  return deleted ? { ...n, deleted_at: iso } : n;
}

function fixture(): BinData {
  return {
    notes: [note('A-B32', '#seer onboarding is long', ['seer']), note('K-F07', 'River #walks', ['walks'], [img('K-F07', 'K-F07'), img('M-Q11', 'K-F07', 1)])],
    images: [
      { image: { ...img('R-T22', 'C-D45', 2), deleted_at: iso }, note_id: 'C-D45', kind: 'image', deleted_at: iso },
      { image: img('K-F07', 'K-F07'), note_id: 'K-F07', kind: 'note', deleted_at: iso },
      { image: img('M-Q11', 'K-F07', 1), note_id: 'K-F07', kind: 'note', deleted_at: iso },
    ],
  };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

let current: BinData;
let calls: Array<{ url: string; method: string }>;
let override: ((url: string, method: string) => Response | undefined) | null;

function dropNoteFromCurrent(id: string) {
  current = { notes: current.notes.filter((n) => n.id !== id), images: current.images.filter((b) => !(b.kind === 'note' && b.note_id === id)) };
}
function dropImageFromCurrent(id: string) {
  current = { ...current, images: current.images.filter((b) => b.image.id !== id) };
}

beforeEach(() => {
  current = fixture();
  calls = [];
  override = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const o = override?.(url, method);
      if (o) return o;
      const id = decodeURIComponent(url.split('/')[3] ?? '');
      if (method === 'GET' && url.startsWith('/api/bin')) return json(current);
      if (method === 'POST' && /^\/api\/notes\/[^/]+\/restore$/.test(url)) {
        const n = current.notes.find((x) => x.id === id) ?? note(id, '', []);
        dropNoteFromCurrent(id);
        return json({ ...n, deleted_at: undefined });
      }
      if (method === 'POST' && /^\/api\/images\/[^/]+\/restore$/.test(url)) {
        dropImageFromCurrent(id);
        return json(note('C-D45', 'kitchen shelf', [], [img(id, 'C-D45', 2)], false));
      }
      if (method === 'DELETE' && url.startsWith('/api/bin/notes/')) {
        const nid = decodeURIComponent(url.split('/')[4] ?? '');
        dropNoteFromCurrent(nid);
        return json({ purged: nid, files: 2 });
      }
      if (method === 'DELETE' && url.startsWith('/api/bin/images/')) {
        const iid = decodeURIComponent(url.split('/')[4] ?? '');
        dropImageFromCurrent(iid);
        return json({ purged: iid, files: 1 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness({ active = [], onRestored = () => {} }: { active?: string[]; onRestored?: (n: Note) => void }) {
  const store = useBin(active, true);
  return <Bin store={store} now={new Date('2026-10-30T02:00:00.000Z')} onRestored={onRestored} />;
}

const tile = (id: string) => document.querySelector(`[data-bin-image="${id}"]`) as HTMLElement;
const card = (id: string) => document.querySelector(`[data-bin-note="${id}"]`) as HTMLElement;
const sent = (method: string, url: string) => calls.some((c) => c.method === method && c.url === url);

describe('Bin', () => {
  it('shows the image grid on top and deleted-note cards below, in the order served', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    const tiles = Array.from(document.querySelectorAll('[data-bin-image]')).map((e) => e.getAttribute('data-bin-image'));
    expect(tiles).toEqual(['R-T22', 'K-F07', 'M-Q11']);
    const cards = Array.from(document.querySelectorAll('[data-bin-note]')).map((e) => e.getAttribute('data-bin-note'));
    expect(cards).toEqual(['A-B32', 'K-F07']);
    const grid = document.querySelector('.bin-grid') as HTMLElement;
    expect(grid.compareDocumentPosition(card('A-B32')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tile('R-T22').querySelector('img')?.getAttribute('src')).toBe('/api/images/R-T22/thumb');
    expect(card('K-F07').querySelector('.card-count')?.textContent).toBe('2');
  });

  it("a deleted note's tile speaks of the note; a removed image's tile speaks of the image", async () => {
    render(<Harness />);
    await waitFor(() => expect(tile('K-F07')).not.toBeNull());
    expect(within(tile('K-F07')).getByRole('button', { name: 'Restore note' }).getAttribute('data-tip')).toBe('Restore note');
    expect(within(tile('K-F07')).getByRole('button', { name: 'Delete note forever' })).toBeTruthy();
    expect(within(tile('R-T22')).getByRole('button', { name: 'Restore image' })).toBeTruthy();
    expect(within(tile('R-T22')).getByRole('button', { name: 'Delete image forever' })).toBeTruthy();
    for (const b of Array.from(document.querySelectorAll('[data-bin] button'))) expect(b.textContent).toBe('');
  });

  it('restores a deleted note: POST restore, card gone, note handed to the wall', async () => {
    const onRestored = vi.fn();
    render(<Harness onRestored={onRestored} />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Restore note' }));
    expect(card('A-B32')).toBeNull();
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({ id: 'A-B32' })));
    expect(sent('POST', '/api/notes/A-B32/restore')).toBe(true);
  });

  it("a deleted note's tile restores the whole note: its tiles and its card go", async () => {
    render(<Harness />);
    await waitFor(() => expect(tile('M-Q11')).not.toBeNull());
    fireEvent.click(within(tile('M-Q11')).getByRole('button', { name: 'Restore note' }));
    expect(tile('K-F07')).toBeNull();
    expect(tile('M-Q11')).toBeNull();
    expect(card('K-F07')).toBeNull();
    await waitFor(() => expect(sent('POST', '/api/notes/K-F07/restore')).toBe(true));
    expect(calls.some((c) => c.url.startsWith('/api/images/'))).toBe(false);
  });

  it('restores a removed image into its note', async () => {
    const onRestored = vi.fn();
    render(<Harness onRestored={onRestored} />);
    await waitFor(() => expect(tile('R-T22')).not.toBeNull());
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Restore image' }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(expect.objectContaining({ id: 'C-D45' })));
    expect(sent('POST', '/api/images/R-T22/restore')).toBe(true);
    expect(tile('R-T22')).toBeNull();
  });

  it('says quietly where the image already lives when restore is refused (409 duplicate_image)', async () => {
    override = (url, method) =>
      method === 'POST' && url === '/api/images/R-T22/restore' ? json({ error: 'duplicate_image', note_id: 'Z-Z99' }, 409) : undefined;
    const onRestored = vi.fn();
    render(<Harness onRestored={onRestored} />);
    await waitFor(() => expect(tile('R-T22')).not.toBeNull());
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Restore image' }));
    await waitFor(() => expect(tile('R-T22').textContent).toContain('already in Z-Z99'));
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('delete forever asks inline with Check + X; cancel puts restore/trash back and sends nothing', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete note forever' }));
    const confirm = within(card('A-B32')).getByRole('button', { name: 'Delete forever' });
    const cancel = within(card('A-B32')).getByRole('button', { name: 'Cancel' });
    expect(confirm.getAttribute('data-tip')).toBe('Delete forever');
    expect(cancel.getAttribute('data-tip')).toBe('Cancel');
    expect(confirm.textContent).toBe('');
    expect(within(card('A-B32')).queryByRole('button', { name: 'Restore note' })).toBeNull();
    fireEvent.click(cancel);
    expect(within(card('A-B32')).getByRole('button', { name: 'Restore note' })).toBeTruthy();
    expect(within(card('A-B32')).queryByRole('button', { name: 'Delete forever' })).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('confirming deletes a note forever', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete note forever' }));
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete forever' }));
    expect(card('A-B32')).toBeNull();
    await waitFor(() => expect(sent('DELETE', '/api/bin/notes/A-B32')).toBe(true));
  });

  it('confirming on a removed image deletes only that image forever', async () => {
    render(<Harness />);
    await waitFor(() => expect(tile('R-T22')).not.toBeNull());
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Delete image forever' }));
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(sent('DELETE', '/api/bin/images/R-T22')).toBe(true));
    expect(tile('R-T22')).toBeNull();
    expect(card('A-B32')).not.toBeNull();
  });

  it('only one entry asks at a time', async () => {
    render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    fireEvent.click(within(card('A-B32')).getByRole('button', { name: 'Delete note forever' }));
    fireEvent.click(within(tile('R-T22')).getByRole('button', { name: 'Delete image forever' }));
    expect(within(card('A-B32')).getByRole('button', { name: 'Restore note' })).toBeTruthy();
    expect(within(tile('R-T22')).getByRole('button', { name: 'Delete forever' })).toBeTruthy();
  });

  it('sends the active tag filters to GET /api/bin and refetches when they change', async () => {
    const { rerender } = render(<Harness active={['seer']} />);
    await waitFor(() => expect(sent('GET', '/api/bin?tag=seer')).toBe(true));
    rerender(<Harness active={['seer', 'walks']} />);
    await waitFor(() => expect(sent('GET', '/api/bin?tag=seer&tag=walks')).toBe(true));
    rerender(<Harness active={[]} />);
    await waitFor(() => expect(sent('GET', '/api/bin')).toBe(true));
  });

  it('refetches on SSE note events and closes its EventSource when unmounted', async () => {
    class FakeES {
      static last: FakeES | null = null;
      closed = false;
      private l = new Map<string, Array<() => void>>();
      constructor(public url: string) {
        FakeES.last = this;
      }
      addEventListener(type: string, fn: () => void) {
        this.l.set(type, [...(this.l.get(type) ?? []), fn]);
      }
      close() {
        this.closed = true;
      }
      emit(type: string) {
        for (const fn of this.l.get(type) ?? []) fn();
      }
    }
    vi.stubGlobal('EventSource', FakeES);
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(card('A-B32')).not.toBeNull());
    expect(FakeES.last?.url).toBe('/api/events');
    current = { notes: [], images: [] };
    act(() => FakeES.last?.emit('note'));
    await waitFor(() => expect(document.querySelector('[data-bin-note]')).toBeNull(), { timeout: 2000 });
    expect(document.querySelector('.bin-empty')?.textContent).toBe('Nothing deleted.');
    unmount();
    expect(FakeES.last?.closed).toBe(true);
  });
});
