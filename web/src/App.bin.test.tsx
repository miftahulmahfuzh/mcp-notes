// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Bin, Note } from './types';
import { makeFile, makeNote } from './testing/fixtures';
import { App } from './App';

const iso = new Date().toISOString();

// Phase 6's shared fixtures: makeNote builds images K-F07 (position 0) and M-Q11 (position 1) for note K-F07.
const textA: Note = makeNote('A-B32', '#seer onboarding is long', { created: iso });
const textC: Note = makeNote('C-D45', 'buy fennel #kitchen', { created: iso });
const photoK: Note = makeNote('K-F07', 'River #walks', { created: iso, images: ['K-F07', 'M-Q11'] });

// A note whose only file lives on the other laptop.
const remoteR: Note = { ...makeNote('R-E01', 'gpd report', { created: iso }), files: [makeFile('F-R01', { note_id: 'R-E01', host: 'GPD', available: false })] };

let extra: Note[];
let deleted: Set<string>;
let removedImages: Set<string>;
let calls: Array<{ url: string; method: string }>;

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const withImages = (n: Note): Note => ({ ...n, images: n.images.filter((i) => !removedImages.has(i.id)) });
const live = () => [textA, textC, photoK, ...extra].filter((n) => !deleted.has(n.id)).map(withImages);
const sent = (method: string, url: string) => calls.some((c) => c.method === method && c.url === url);

beforeEach(() => {
  extra = [];
  deleted = new Set();
  removedImages = new Set();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const seg = url.split('/');
      if (method === 'GET' && url.startsWith('/api/notes')) return json({ notes: live(), next_cursor: null });
      if (method === 'GET' && url.startsWith('/api/tags')) return json([]);
      if (method === 'GET' && url.startsWith('/api/bin')) {
        const bin: Bin = { notes: [textA, textC, photoK].filter((n) => deleted.has(n.id)).map((n) => ({ ...n, deleted_at: iso })), images: [] };
        return json(bin);
      }
      if (method === 'DELETE' && url.startsWith('/api/notes/')) {
        deleted.add(seg[3] ?? '');
        return json({ ok: true });
      }
      if (method === 'POST' && /^\/api\/notes\/[^/]+\/restore$/.test(url)) {
        deleted.delete(seg[3] ?? '');
        return json(withImages([textA, textC, photoK].find((n) => n.id === seg[3]) as Note));
      }
      if (method === 'DELETE' && url.startsWith('/api/images/')) {
        removedImages.add(seg[3] ?? '');
        return json(withImages(photoK));
      }
      if (method === 'POST' && /^\/api\/images\/[^/]+\/restore$/.test(url)) {
        removedImages.delete(seg[3] ?? '');
        return json(withImages(photoK));
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wallCard = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement | null;
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;

describe('App: delete, undo, bin', () => {
  it('deletes a note from its card without asking; undo brings it back', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(within(wallCard('A-B32') as HTMLElement).getByRole('button', { name: 'Delete note' }));
    expect(wallCard('A-B32')).toBeNull();
    await waitFor(() => expect(sent('DELETE', '/api/notes/A-B32')).toBe(true));
    expect(document.querySelector('.undo')?.textContent).toBe('deleted A-B32');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(wallCard('A-B32')).not.toBeNull());
    expect(sent('POST', '/api/notes/A-B32/restore')).toBe(true);
    expect(document.querySelector('.undo')).toBeNull();
  });

  it('a note with files on another machine asks before deleting from its card', async () => {
    extra = [remoteR];
    render(<App />);
    await screen.findByText('gpd report');
    const trash = () => within(wallCard('R-E01') as HTMLElement).getByRole('button', { name: 'Delete note' });
    fireEvent.click(trash());
    expect(screen.getByRole('alertdialog').textContent).toContain('R-E01 has 1 file on GPD. Delete it anyway?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(wallCard('R-E01')).not.toBeNull();
    expect(sent('DELETE', '/api/notes/R-E01')).toBe(false);
    fireEvent.click(trash());
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(wallCard('R-E01')).toBeNull();
    await waitFor(() => expect(sent('DELETE', '/api/notes/R-E01')).toBe(true));
  });

  it('the rail trash opens "Deleted." with the deleted note; restore puts it back on the wall', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(within(wallCard('A-B32') as HTMLElement).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(sent('DELETE', '/api/notes/A-B32')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    const binCard = await waitFor(() => {
      const el = document.querySelector('[data-bin-note="A-B32"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(screen.getByText(/1 deleted notes, 0 images\./)).toBeTruthy();
    expect(document.querySelector('.sticker')).toBeNull();
    fireEvent.click(within(binCard).getByRole('button', { name: 'Restore note' }));
    await waitFor(() => expect(sent('POST', '/api/notes/A-B32/restore')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Back to the wall' }));
    expect(h1()).toBe('Notes.');
    await waitFor(() => expect(wallCard('A-B32')).not.toBeNull());
  });

  it('the sidebar trash toggles the bin as well; the sidebar keeps its live counts', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getByLabelText('Toggle sidebar'));
    const side = document.querySelector('.side') as HTMLElement;
    const before = side.querySelector('.side-count')?.textContent;
    fireEvent.click(within(side).getByRole('button', { name: 'Recycle bin' }));
    expect(h1()).toBe('Deleted.');
    await waitFor(() => expect(sent('GET', '/api/bin')).toBe(true));
    expect(side.querySelector('.side-count')?.textContent).toBe(before);
    fireEvent.click(within(side).getByRole('button', { name: 'Back to the wall' }));
    expect(h1()).toBe('Notes.');
  });

  it('passes the active tag filter to the bin', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(document.querySelector('[data-note="A-B32"] .tagchip') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Recycle bin' }));
    await waitFor(() => expect(sent('GET', '/api/bin?tag=seer')).toBe(true));
    expect(screen.getByText(/tagged #seer\./)).toBeTruthy();
  });

  it("removing an image in the editor can be undone (phase 7's Expand note / Remove image labels)", async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    await waitFor(() => expect(wallCard('K-F07')).not.toBeNull());
    fireEvent.click(within(wallCard('K-F07') as HTMLElement).getByRole('button', { name: 'Expand note' }));
    const removes = await screen.findAllByRole('button', { name: 'Remove image' });
    fireEvent.click(removes[1] as HTMLElement);
    await waitFor(() => expect(sent('DELETE', '/api/images/M-Q11')).toBe(true));
    expect(document.querySelector('.undo')?.textContent).toBe('removed image');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sent('POST', '/api/images/M-Q11/restore')).toBe(true));
  });
});
