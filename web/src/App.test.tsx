// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Note } from './types';
import { App } from './App';
import { makeNote } from './testing/fixtures';

const iso = new Date().toISOString();
const notes: Note[] = [
  makeNote('A-B32', '#seer onboarding is long', { created: iso }),
  makeNote('C-D45', 'buy fennel #kitchen', { created: iso }),
  makeNote('K-F07', 'River #walks', { created: iso, images: ['K-F07', 'M-N11'] }),
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
    expect(document.querySelector('[data-note="K-F07"] img')?.getAttribute('src')).toBe('/api/images/K-F07/thumb');
  });

  it('counts images, shows one gallery tile per image, steps the modal within a note, and puts the count on the cover', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expect(screen.getByText(/2 notes, 1 photo notes hidden\./)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    expect(screen.getByText(/2 photos\./)).toBeTruthy();
    const tiles = Array.from(document.querySelectorAll('.gallery [data-photo]')).map((t) => t.getAttribute('data-photo'));
    expect(tiles).toEqual(['K-F07', 'M-N11']);
    fireEvent.click(document.querySelector('[data-photo="K-F07"]') as HTMLElement);
    expect(document.querySelector('[data-modal="photo"] [data-meta]')?.textContent).toContain('1 / 2  1/2');
    fireEvent.click(screen.getByLabelText('Next'));
    expect(document.querySelector('[data-modal="photo"] [data-meta]')?.textContent).toContain('2 / 2  2/2');
    expect(document.querySelector('[data-modal="photo"] img')?.getAttribute('src')).toBe('/api/images/M-N11/display');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(document.querySelector('[data-modal="photo"]')).toBeNull();
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    expect(document.querySelectorAll('[data-note="K-F07"] img')).toHaveLength(1);
    expect(document.querySelector('[data-note="K-F07"] .card-count')?.textContent).toBe('2');
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

  it('shows the tool status in the header while streaming, then the brain label', async () => {
    const enc = new TextEncoder();
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
      },
    });
    const send = (s: string) => ctl.enqueue(enc.encode(s));
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith('/api/chat') ? new Response(body, { headers: { 'content-type': 'text/event-stream' } }) : base(input, init),
      ),
    );

    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'what about seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);

    send('event: status\ndata: {"text":"searching notes"}\n\n');
    await waitFor(() => expect(document.querySelector('.answer-head .answer-status')?.textContent).toBe('searching notes'));
    expect(document.querySelector('.answer-head .answer-q')?.textContent).toBe('what about seer?');
    expect(document.querySelector('.answer-head button')).not.toBeNull();
    expect(document.querySelectorAll('.answer-head button')).toHaveLength(3);

    send('event: status\ndata: {"text":""}\n\nevent: delta\ndata: {"text":"Look at A-B32."}\n\n');
    await waitFor(() => expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at A-B32. ▍'));
    expect(document.querySelector('.answer-status')).toBeNull();

    send('event: done\ndata: {"thread_id":"s-1","brain":"glm"}\n\n');
    ctl.close();
    await waitFor(() => expect(document.querySelector('.answer-head .answer-status')?.textContent).toBe('glm'));
    expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at A-B32.');
  });
});
