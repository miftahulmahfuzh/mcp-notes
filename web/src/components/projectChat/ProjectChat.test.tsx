// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { ChatPage } from '../../types';
import { makeMessage } from '../../testing/chatFixtures';
import { ProjectChat } from './ProjectChat';
import { ProjectViewToggle, type ProjectView } from './ProjectViewToggle';

const sse = (frames: Array<{ event: string; data: unknown }>): string =>
  frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

let latest: ChatPage;
let gets: URL[];
let posted: Array<Record<string, unknown>>;

beforeEach(() => {
  latest = { messages: [], next_before: null };
  gets = [];
  posted = [];
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.startsWith('/api/chat/messages')) {
        gets.push(new URL(url, 'http://x'));
        return json(latest);
      }
      if (method === 'POST' && url === '/api/chat') {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          sse([
            { event: 'accepted', data: { thread_id: 'T-P', user_message_id: 'Q100' } },
            { event: 'delta', data: { text: 'It landed p3.' } },
            { event: 'done', data: { thread_id: 'T-P', user_message_id: 'Q100', assistant_message_id: 'A100', reply_to: null } },
          ]),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

/** Stands in for ProjectsPage: the header toggle, the graph, and the project chat. */
function Page({ repo }: { repo: string }) {
  const [view, setView] = useState<ProjectView>('graph');
  return (
    <div>
      <header>
        <ProjectViewToggle view={view} onToggle={setView} />
      </header>
      {view === 'graph' && <div data-testid="graph" />}
      <ProjectChat key={repo} repo={repo} view={view} onAsked={() => setView('chat')} />
    </div>
  );
}

describe('ProjectViewToggle + ProjectChat', () => {
  it('starts on the graph with the pill and fetches nothing', () => {
    render(<Page repo="mcp-notes" />);
    expect(screen.getByTestId('graph')).toBeTruthy();
    expect(screen.getByTestId('project-pill-query-input')).toBeTruthy();
    expect(screen.queryByTestId('project-chat-history')).toBeNull();
    const toggle = screen.getByTestId('project-view-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Project chat history');
    expect(toggle.textContent).toBe('');
    expect(gets).toEqual([]);
  });

  it("toggles to the project's chat history, scoped by ?project=, and back", async () => {
    latest = { messages: [makeMessage('Q001', { thread_id: 'T1', text: 'earlier project question' })], next_before: null };
    render(<Page repo="mcp-notes" />);
    fireEvent.click(screen.getByTestId('project-view-toggle'));
    expect(screen.getByTestId('project-chat-history')).toBeTruthy();
    expect(screen.queryByTestId('graph')).toBeNull();
    expect(screen.queryByTestId('project-pill-query-input')).toBeNull();
    expect(screen.getByLabelText('Ask about mcp-notes')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('earlier project question')).toBeTruthy());
    expect(gets.length).toBeGreaterThan(0);
    for (const u of gets) expect(u.searchParams.get('project')).toBe('mcp-notes');
    expect(screen.getByTestId('project-view-toggle').getAttribute('aria-label')).toBe('Session graph');

    fireEvent.click(screen.getByTestId('project-view-toggle'));
    expect(screen.getByTestId('graph')).toBeTruthy();
    expect(screen.getByTestId('project-pill-query-input')).toBeTruthy();
  });

  it('a question in the pill is sent with the project and opens the history with the answer', async () => {
    render(<Page repo="mcp-notes" />);
    const pill = screen.getByLabelText('Ask about mcp-notes');
    fireEvent.change(pill, { target: { value: 'what did the orch do?' } });
    fireEvent.keyDown(pill, { key: 'Enter' });
    expect(screen.getByTestId('project-chat-history')).toBeTruthy();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ message: 'what did the orch do?', project: 'mcp-notes' });
    await waitFor(() => expect(screen.getByText('It landed p3.')).toBeTruthy());
  });
});
