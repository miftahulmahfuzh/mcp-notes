// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Note } from './types';
import { App } from './App';

const iso = new Date().toISOString();
const notes: Note[] = [
  { id: 'A-B32', body: '#seer onboarding is long', tags: ['seer'], created_at: iso, updated_at: iso, origin: null, image: null },
  { id: 'C-D45', body: 'buy fennel #kitchen', tags: ['kitchen'], created_at: iso, updated_at: iso, origin: null, image: null },
  {
    id: 'K-F07',
    body: 'River #walks',
    tags: ['walks'],
    created_at: iso,
    updated_at: iso,
    origin: null,
    image: { mime: 'image/jpeg', width: 600, height: 400, bytes: 10, taken_at: null, original_name: 'r.jpg', host: 'lenovo', available: true },
  },
];
const tags = [
  { tag: 'seer', count: 1, last_used: iso },
  { tag: 'kitchen', count: 1, last_used: iso },
  { tag: 'walks', count: 1, last_used: iso },
];

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/notes')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json(tags);
      if (url.startsWith('/api/chat')) {
        return new Response('event: delta\ndata: {"text":"Look at a-b32"}\n\nevent: delta\ndata: {"text":" and Z-Z99."}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders real notes in text mode by default, hiding image notes', async () => {
    render(<App />);
    expect(await screen.findByText('onboarding is long')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
    expect(screen.getByText(/2 notes, 1 photo notes hidden\./)).toBeTruthy();
    expect(document.querySelector('[data-note="K-F07"]')).toBeNull();
  });

  it('cycles modes text → images → all and shows image cards as thumbs in all', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Photos.');
    expect(document.querySelector('.gallery')).not.toBeNull();
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Everything.');
    expect(document.querySelector('[data-note="K-F07"] img')?.getAttribute('src')).toBe('/api/notes/K-F07/thumb');
  });

  it('filters by a tag chip and shows it as an active rail chip', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(document.querySelector('[data-note="A-B32"] .tagchip') as HTMLElement);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('#seer');
    expect(document.querySelector('[data-note="C-D45"]')).toBeNull();
    expect(document.querySelector('.rail-chip')?.textContent).toBe('#seer');
    fireEvent.click(screen.getByLabelText('Clear filters'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
  });

  it('streams the chat answer, shows used-note chips, and dims non-used cards', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'what about seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    expect(await screen.findByRole('button', { name: 'A-B32' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Z-Z99' })).toBeNull();
    expect(screen.getByText('what about seer?')).toBeTruthy();
    expect(screen.getByText('Look at a-b32 and Z-Z99.')).toBeTruthy();
    await waitFor(() => {
      expect(document.querySelector('[data-note="A-B32"]')?.className).toContain('used');
      expect(document.querySelector('[data-note="C-D45"]')?.className).toContain('dim');
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.answer')).toBeNull();
  });
});
