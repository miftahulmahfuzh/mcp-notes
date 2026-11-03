// @vitest-environment jsdom
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { makeNote } from '../../testing/fixtures';
import { NoteEditor } from '../NoteEditor';
import { NodeModal } from './NodeModal';

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/sessions/BE-XU')) {
        return json({
          session: { session_id: 's1', node_id: 'BE-XU', repo: null, host: 'pc', name: 'orch-project-session-graph' },
          notes: [{ id: '5-BW7', excerpt: 'linked note body', tags: [], created_at: null, kind: 'linked' }],
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

/** App's shape: the editor is a sibling portal opened through onOpenNote, never a child of the pop-up. */
function Harness({ onModalClosed }: { onModalClosed: () => void }) {
  const [modal, setModal] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      {modal && (
        <NodeModal
          nodeId="BE-XU"
          repo={null}
          onClose={() => {
            setModal(false);
            onModalClosed();
          }}
          onShowOnGraph={() => {}}
          onOpenNote={setEditing}
        />
      )}
      {editing !== null &&
        createPortal(
          <NoteEditor
            note={makeNote(editing, 'linked note body')}
            copied={false}
            notice={null}
            onCopy={() => {}}
            onSave={() => {}}
            onClose={() => setEditing(null)}
            onRemoveImage={() => {}}
          />,
          document.body,
        )}
    </>
  );
}

const editor = () => screen.queryByRole('dialog', { name: 'Edit note 5-BW7' });
const popup = () => screen.queryByRole('dialog', { name: 'Session BE-XU' });

async function openEditor(): Promise<void> {
  fireEvent.click(await screen.findByRole('link', { name: '5-BW7' }));
  await waitFor(() => expect(editor()).not.toBeNull());
}

describe('NodeModal: a note opened from "Notes made"', () => {
  it('opens the big editor over the pop-up; Esc closes only the editor, a second Esc the pop-up', async () => {
    const onModalClosed = vi.fn();
    render(<Harness onModalClosed={onModalClosed} />);
    await openEditor();
    expect(popup()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(editor()).toBeNull());
    expect(popup()).not.toBeNull();
    expect(onModalClosed).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(popup()).toBeNull());
    expect(onModalClosed).toHaveBeenCalledTimes(1);
  });

  it('a click on the editor backdrop closes only the editor', async () => {
    const onModalClosed = vi.fn();
    render(<Harness onModalClosed={onModalClosed} />);
    await openEditor();
    fireEvent.click(document.querySelector('[data-modal="editor"]') as Element);
    await waitFor(() => expect(editor()).toBeNull());
    expect(popup()).not.toBeNull();
    expect(onModalClosed).not.toHaveBeenCalled();
  });
});

describe('NodeModal: the prompts modal over the pop-up', () => {
  it('Esc closes only the prompts modal, a second Esc the pop-up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/sessions/BE-XU/prompts') {
          return json({ node_id: 'BE-XU', host: 'pc', available: true, complete: true, prompts: [{ n: 1, text: 'hello prompts', at: null, truncated: false }] });
        }
        if (url.startsWith('/api/sessions/BE-XU')) {
          return json({ session: { session_id: 's1', node_id: 'BE-XU', repo: null, host: 'pc', name: 'orch-project-session-graph' }, prompts: [{ text: 'hello prompts', at: null }] });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    const onClose = vi.fn();
    render(<NodeModal nodeId="BE-XU" repo={null} onClose={onClose} onShowOnGraph={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand prompts' }));
    await screen.findByRole('dialog', { name: 'Prompts of BE-XU' });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Prompts of BE-XU' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(popup()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
