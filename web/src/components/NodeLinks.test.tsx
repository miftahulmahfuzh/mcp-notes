// @vitest-environment jsdom
import { useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatInline, NodeLinkContext, type NodeLinks } from './ChatText';
import { NodeModal } from './graph/NodeModal';
import { useKnownNodes } from '../hooks/useKnownNodes';

let calls: string[];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('/api/sessions/known?')) {
        const ids = decodeURIComponent(url.split('ids=')[1] ?? '').split(',');
        return json({ nodes: ids.filter((id) => id === 'BE-XU').map((node_id) => ({ node_id, repo: 'mcp-notes' })) });
      }
      if (url.startsWith('/api/sessions/BE-XU')) {
        return json({ session: { session_id: 's1', node_id: 'BE-XU', repo: 'mcp-notes', host: 'pc', name: 'orch-project-session-graph' } });
      }
      if (url.startsWith('/api/projects/mcp-notes/sessions')) return json({ repo: 'mcp-notes', nodes: [] });
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ text, onShow }: { text: string; onShow: (id: string, repo: string) => void }) {
  const known = useKnownNodes();
  const [open, setOpen] = useState<string | null>(null);
  const links = useMemo<NodeLinks>(() => ({ lookup: known.lookup, request: known.request, open: setOpen }), [known.lookup, known.request]);
  return (
    <NodeLinkContext.Provider value={links}>
      <p>
        <ChatInline text={text} />
      </p>
      {open !== null && <NodeModal nodeId={open} repo={known.lookup(open)?.repo ?? null} onClose={() => setOpen(null)} onShowOnGraph={onShow} />}
    </NodeLinkContext.Provider>
  );
}

describe('node links in chat', () => {
  it('links only ids the server knows, asking once', async () => {
    render(<Harness text="The orchestrator is BE-XU, not CI-CD." onShow={() => {}} />);
    const link = await screen.findByRole('link', { name: 'BE-XU' });
    expect(link.getAttribute('href')).toBe('/projects?repo=mcp-notes&node=BE-XU');
    expect(screen.queryByRole('link', { name: 'CI-CD' })).toBeNull();
    expect(calls.filter((u) => u.startsWith('/api/sessions/known'))).toEqual(['/api/sessions/known?ids=BE-XU%2CCI-CD']);
  });

  it('a click opens the node pop-up; Show on graph hands back the node and its repo', async () => {
    const onShow = vi.fn();
    render(<Harness text="The orchestrator is BE-XU." onShow={onShow} />);
    fireEvent.click(await screen.findByRole('link', { name: 'BE-XU' }));
    await screen.findByRole('dialog', { name: 'Session BE-XU' });
    await screen.findByRole('heading', { name: 'orch-project-session-graph' });
    const show = screen.getByRole('button', { name: 'Show on graph' });
    await waitFor(() => expect((show as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(show);
    expect(onShow).toHaveBeenCalledWith('BE-XU', 'mcp-notes');
  });

  it('Esc closes the pop-up', async () => {
    render(<Harness text="BE-XU" onShow={() => {}} />);
    fireEvent.click(await screen.findByRole('link', { name: 'BE-XU' }));
    await screen.findByRole('dialog', { name: 'Session BE-XU' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
