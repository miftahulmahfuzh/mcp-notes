// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note } from './types';
import { makeNote } from './testing/fixtures';
import { METHOD_BOOK, METHOD_DAILY, OVERVIEW, TOGGLE_ON } from './testing/adversaryFixtures';
import { App } from './App';

const notes: Note[] = [makeNote('A-B32', 'buy fennel #kitchen', { created: new Date().toISOString() })];
let calls: string[];
let toggle = { ...TOGGLE_ON };
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  toggle = { ...TOGGLE_ON };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/notes?')) return json({ notes, next_cursor: null });
      if (url.startsWith('/api/tags')) return json([]);
      if (url === '/api/adversary/overview') return json(OVERVIEW);
      if (url === '/api/adversary/methods/RAW35-FR-GT') return json(METHOD_BOOK);
      if (url === '/api/adversary/methods/A-GT') return json(METHOD_DAILY);
      if (url === '/api/adversary/toggle') {
        if (method === 'PUT') toggle = { on: (JSON.parse(String(init?.body)) as { on: boolean }).on, changed_at: '2026-11-05T02:00:00Z', host: 'lenovo' };
        return json(toggle);
      }
      return new Response('not found', { status: 404 });
    }),
  );
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  window.history.replaceState(null, '', '/');
});

const h1 = () => screen.queryByRole('heading', { level: 1 })?.textContent ?? null;
const at = (url: string) => window.history.replaceState(null, '', url);
const where = () => window.location.pathname + window.location.search;
const rail = () => document.querySelector('.rail') as HTMLElement;
const pop = (url: string) =>
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

describe('App: Seer Adversarial', () => {
  it('the sword opens /adversary with the roster in the sidebar; a second press returns to the wall', async () => {
    render(<App />);
    expect(calls.some((c) => c.includes('/api/adversary'))).toBe(false);
    fireEvent.click(within(rail()).getByRole('button', { name: 'Seer Adversarial' }));
    await waitFor(() => expect(where()).toBe('/adversary'));
    expect(h1()).toBe('Adversary.');
    const list = await screen.findByRole('list', { name: 'Seer roster' });
    expect(within(list).getAllByRole('listitem').map((r) => r.getAttribute('data-strategy'))).toEqual(['', 'A-GT', 'RAW35-FR-GT', 'COSK-FR-GT']);
    expect(within(screen.getByRole('list', { name: 'Retired methods' })).getAllByRole('listitem')).toHaveLength(2);
    await screen.findByText(/3 methods on Seer's roster/);
    // The page's own pill replaces the wall chat bar.
    expect(screen.getByPlaceholderText('Ask about Seer Adversarial')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Ask about your notes')).toBeNull();
    fireEvent.click(within(rail()).getByRole('button', { name: 'Seer Adversarial' }));
    await waitFor(() => expect(where()).toBe('/'));
  });

  it('a roster row opens the method page; Back returns to the overview', async () => {
    at('/adversary');
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Seer roster' });
    fireEvent.click(within(list).getByText('RAW35 · Momentum'));
    await waitFor(() => expect(where()).toBe('/adversary/RAW35-FR-GT'));
    await screen.findByRole('region', { name: 'Go-live checklist' });
    expect(h1()).toBe('RAW35.');
    pop('/adversary');
    await waitFor(() => expect(h1()).toBe('Adversary.'));
    await screen.findByRole('region', { name: 'Methods' });
  });

  it('a deep link to a bracket method with a C sibling opens the three-way page', async () => {
    at('/adversary/A-GT');
    render(<App />);
    await screen.findByRole('region', { name: 'A, C and Claude compared' });
    expect(h1()).toBe('Dip buy.');
    expect(document.querySelector('.side')).not.toBeNull();
  });

  it('Alt+Z enters focus mode (no rail, sidebar or header) and Esc leaves it', async () => {
    at('/adversary');
    render(<App />);
    await screen.findByRole('region', { name: 'Methods' });
    const e = new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', altKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(where()).toBe('/adversary?focus=1'));
    expect(document.querySelector('.rail')).toBeNull();
    expect(document.querySelector('.side')).toBeNull();
    expect(h1()).toBeNull();
    expect(screen.getByText('Adversary.')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(where()).toBe('/adversary'));
    expect(document.querySelector('.rail')).not.toBeNull();
  });

  it('the Power toggle PUTs and flips to the dashed off state', async () => {
    at('/adversary');
    render(<App />);
    const on = await screen.findByRole('button', { name: 'Auto-runs on (click to pause)' });
    await waitFor(() => expect((on as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(on);
    const off = await screen.findByRole('button', { name: 'Auto-runs off (click to turn on)' });
    expect(off.className).toBe('ibtn adv-off');
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(calls).toContain('PUT /api/adversary/toggle');
  });
});
