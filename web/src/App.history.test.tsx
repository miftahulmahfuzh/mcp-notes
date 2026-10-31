// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatPage, Note } from './types';
import { makeNote } from './testing/fixtures';
import { makeMessage } from './testing/chatFixtures';
import { App } from './App';

const iso = new Date().toISOString();
const notes: Note[] = [makeNote('A-B32', '#seer onboarding is long', { created: iso }), makeNote('C-D45', 'buy fennel #kitchen', { created: iso })];
const page: ChatPage = {
  messages: [
    makeMessage('Q001', { thread_id: 'T-1', text: 'what about seer?', created_at: iso }),
    makeMessage('A001', { thread_id: 'T-1', role: 'assistant', text: 'Seer is fine.', created_at: iso }),
  ],
  next_before: null,
};
const CHAT_SSE =
  'event: accepted\ndata: {"thread_id":"T-1","user_message_id":"Q001"}\n\n' +
  'event: delta\ndata: {"text":"Seer is fine."}\n\n' +
  'event: done\ndata: {"thread_id":"T-1","user_message_id":"Q001","assistant_message_id":"A001","reply_to":null,"brain":"claude"}\n\n';

let calls: string[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/notes/')) {
        const id = decodeURIComponent(url.slice('/api/notes/'.length));
        const hit = notes.find((n) => n.id === id);
        return hit ? json(hit) : json({ error: 'not_found' }, 404);
      }
      if (url.startsWith('/api/tags')) return json([]);
      if (url.startsWith('/api/chat/messages')) return json(page);
      if (method === 'POST' && url === '/api/chat') return new Response(CHAT_SSE, { headers: { 'content-type': 'text/event-stream' } });
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, writable: true, value: () => ({}) as Animation });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  window.history.replaceState(null, '', '/');
});

const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const at = (url: string) => window.history.replaceState(null, '', url);
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
const where = () => window.location.pathname + window.location.search;
const rail = () => document.querySelector('.rail') as HTMLElement;

describe('App: chat history page', () => {
  it('the rail icon opens /history with the timeline; a second press returns to the wall at /', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(rail().querySelector('[aria-label="Chat history"]') as HTMLElement);
    expect(h1()).toBe('History.');
    expect(where()).toBe('/history');
    await waitFor(() => expect(document.querySelector('[data-msg="A001"]')).not.toBeNull());
    expect(screen.getByText(/2 messages in 1 threads\./)).toBeTruthy();
    expect(document.querySelector('.sticker')).toBeNull();
    fireEvent.click(rail().querySelector('[aria-label="Chat history"]') as HTMLElement);
    expect(h1()).toBe('Notes.');
    expect(where()).toBe('/');
    // The notes store survived the round trip.
    expect(screen.getByText('onboarding is long')).toBeTruthy();
  });

  it('loads straight into the page from /history?thread=ID', async () => {
    at('/history?thread=T-1');
    render(<App />);
    expect(h1()).toBe('History.');
    await waitFor(() => expect(document.querySelector('[data-msg="Q001"]')?.className).toContain('focus'));
    expect(where()).toBe('/history?thread=T-1');
  });

  it('back and forward switch between the wall and the history page', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    pop('/history');
    expect(h1()).toBe('History.');
    pop('/');
    expect(h1()).toBe('Notes.');
    pop('/history?thread=T-1');
    expect(h1()).toBe('History.');
  });

  it('a /?note= link reached with back from the history page still opens the wall on the note', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    pop('/history');
    expect(h1()).toBe('History.');
    pop('/?note=c-d45');
    await waitFor(() => expect(h1()).not.toBe('History.'));
    expect(where()).toBe('/?note=c-d45');
    expect(document.querySelector('[data-note="C-D45"]')).not.toBeNull();
  });

  it('the answer panel "Chat in full screen" opens the page on the current thread and hides the panel', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'what about seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    await waitFor(() => expect(document.querySelector('.answer-body')?.textContent).toContain('Seer is fine.'));
    fireEvent.click(screen.getByRole('button', { name: 'Chat in full screen' }));
    expect(h1()).toBe('History.');
    expect(where()).toBe('/history?thread=T-1');
    expect(document.querySelector('.answer')).toBeNull();
    // Back on the wall the conversation is still there.
    fireEvent.click(rail().querySelector('[aria-label="Chat history"]') as HTMLElement);
    expect(document.querySelector('.answer')).not.toBeNull();
  });

  it('switching to the bin and back to the wall never rewrites a /?note= URL', async () => {
    at('/?note=c-d45');
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(rail().querySelector('[aria-label="Recycle bin"]') as HTMLElement);
    expect(where()).toBe('/?note=c-d45');
    fireEvent.click(rail().querySelector('[aria-label="Back to the wall"]') as HTMLElement);
    expect(h1()).toBe('Notes.');
    expect(where()).toBe('/?note=c-d45');
  });

  it('the history page renders only its own page-variant composer and sends into a new optimistic bubble', async () => {
    at('/history');
    render(<App />);
    await waitFor(() => expect(document.querySelector('[data-msg="A001"]')).not.toBeNull());
    expect(document.querySelectorAll('form.chatbar')).toHaveLength(1);
    expect(document.querySelector('form.chatbar')?.getAttribute('data-chatbar')).toBe('page');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'and kitchen?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    expect(Array.from(document.querySelectorAll('.bubble.mine')).some((b) => b.textContent?.includes('and kitchen?'))).toBe(true);
    await waitFor(() => expect(calls).toContain('POST /api/chat'));
    expect((screen.getByLabelText('Ask about your notes') as HTMLTextAreaElement).value).toBe('');
  });
});
