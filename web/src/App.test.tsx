// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Note, NoteFile } from './types';
import { App } from './App';
import { makeFile, makeImage, makeNote } from './testing/fixtures';

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
    expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at a-b32 and Z-Z99.');
    expect([...document.querySelectorAll('.answer-body a.note-link')].map((a) => a.textContent)).toEqual(['a-b32', 'Z-Z99']);
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
    expect(document.querySelectorAll('.answer-head button')).toHaveLength(4);

    send('event: status\ndata: {"text":""}\n\nevent: delta\ndata: {"text":"Look at A-B32."}\n\n');
    await waitFor(() => expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at A-B32. ▍'));
    expect(document.querySelector('.answer-status')).toBeNull();

    send('event: done\ndata: {"thread_id":"s-1","brain":"glm"}\n\n');
    ctl.close();
    await waitFor(() => expect(document.querySelector('.answer-head .answer-status')?.textContent).toBe('glm'));
    expect(document.querySelector('.answer-body p')?.textContent).toBe('Look at A-B32.');
  });
});

describe('App big editor (R2)', () => {
  type Call = { method: string; url: string; body?: unknown };
  let calls: Call[];
  let server: Note[];
  let attachReply: (noteId: string) => { status: number; body: { note: Note; attached: boolean } };

  const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const img = (id: string, noteId: string, position = 0) =>
    makeImage(id, { note_id: noteId, position, mime: 'image/png', bytes: 10, original_name: 'shot.png' });
  const pasteImage = () => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files: [png] } });
    document.dispatchEvent(e);
  };
  const card = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement;
  const editor = () => document.querySelector('[data-modal="editor"]') as HTMLElement | null;
  const edText = () => within(editor()!).getByLabelText('Note text') as HTMLTextAreaElement;
  const expandCard = (id: string) => {
    const btn = within(card(id)).getByLabelText('Expand note');
    fireEvent.mouseDown(btn);
    fireEvent.click(btn);
  };
  const of = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);

  beforeEach(() => {
    calls = [];
    server = [
      makeNote('A-B32', '#seer onboarding is long', { created: iso }),
      makeNote('C-D45', 'buy fennel #kitchen', { created: iso }),
    ];
    attachReply = (noteId) => {
      const n = server.find((x) => x.id === noteId)!;
      return { status: 201, body: { note: { ...n, images: [...n.images, img('P-IC1', noteId, n.images.length)] }, attached: true } };
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (method === 'GET' && url.startsWith('/api/notes')) return reply({ notes: server, next_cursor: null });
        if (method === 'GET' && url.startsWith('/api/tags')) return reply([]);
        if (method === 'POST' && url === '/api/notes') {
          const n: Note = { id: 'N-EW1', body: '', tags: [], created_at: iso, updated_at: iso, origin: null, images: [] };
          server = [n, ...server];
          return reply(n, 201);
        }
        const one = url.match(/^\/api\/notes\/([^/]+)$/);
        if (one && method === 'PATCH') {
          const body = (JSON.parse(String(init?.body)) as { body: string }).body;
          server = server.map((n) => (n.id === one[1] ? { ...n, body } : n));
          return reply(server.find((n) => n.id === one[1]));
        }
        if (one && method === 'DELETE') {
          server = server.filter((n) => n.id !== one[1]);
          return reply({ ok: true });
        }
        const att = url.match(/^\/api\/notes\/([^/]+)\/images$/);
        if (att && method === 'POST') {
          const r = attachReply(att[1]!);
          if (r.body.attached) server = server.map((n) => (n.id === r.body.note.id ? r.body.note : n));
          return reply(r.body, r.status);
        }
        const rm = url.match(/^\/api\/images\/([^/]+)$/);
        if (rm && method === 'DELETE') {
          const owner = server.find((n) => n.images.some((i) => i.id === rm[1]))!;
          const next = { ...owner, images: owner.images.filter((i) => i.id !== rm[1]) };
          server = server.map((n) => (n.id === owner.id ? next : n));
          return reply(next);
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  it('the expand icon opens the editor on that note; Esc closes and saves only if changed', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    expect(editor()).not.toBeNull();
    expect(edText().value).toBe('#seer onboarding is long');
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(editor()).toBeNull();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);

    expandCard('A-B32');
    fireEvent.change(edText(), { target: { value: 'para one\n\npara two #seer' } });
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(editor()).toBeNull();
    await waitFor(() => expect(of('PATCH', '/api/notes/A-B32')).toHaveLength(1));
    expect(of('PATCH', '/api/notes/A-B32')[0]!.body).toEqual({ body: 'para one\n\npara two #seer' });
    expect(card('A-B32').querySelector('.card-text')?.textContent).toContain('para two');
  });

  it('saves on blur while open and the card reflects it at once', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    fireEvent.change(edText(), { target: { value: 'rewritten #seer' } });
    fireEvent.blur(edText());
    expect(card('A-B32').querySelector('.card-text')?.textContent).toContain('rewritten');
    expect(editor()).not.toBeNull();
    await waitFor(() => expect(of('PATCH', '/api/notes/A-B32')).toHaveLength(1));
    fireEvent.click(within(editor()!).getByLabelText('Close'));
    await waitFor(() => expect(editor()).toBeNull());
    expect(of('PATCH', '/api/notes/A-B32')).toHaveLength(1);
  });

  it('"+" then expand: the empty new note survives while open and is soft-deleted on close', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.click(screen.getAllByLabelText('New note')[0]!);
    await waitFor(() => expect(card('N-EW1')?.querySelector('textarea')).not.toBeNull());
    expandCard('N-EW1');
    expect(editor()).not.toBeNull();
    expect(of('DELETE', '/api/notes/N-EW1')).toHaveLength(0);
    fireEvent.blur(edText());
    expect(of('DELETE', '/api/notes/N-EW1')).toHaveLength(0);
    expect(card('N-EW1')).not.toBeNull();
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('DELETE', '/api/notes/N-EW1')).toHaveLength(1));
    expect(card('N-EW1')).toBeNull();
  });

  it('an emptied note is not deleted while open; on close the empty rule deletes it', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('C-D45');
    fireEvent.change(edText(), { target: { value: '' } });
    fireEvent.blur(edText());
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
    expect(card('C-D45')).not.toBeNull();
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(1));
    expect(card('C-D45')).toBeNull();
  });

  it('pasting an image while open attaches it to the edited note; Notes. switches to Everything. on close', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
    expandCard('A-B32');
    pasteImage();
    await waitFor(() => expect(editor()!.querySelector('.ed-thumb[data-image="P-IC1"]')).not.toBeNull());
    expect(of('POST', '/api/notes/A-B32/images')).toHaveLength(1);
    expect(calls.some((c) => c.url === '/api/images')).toBe(false);
    // Still on the wall behind the editor, though it now has an image in text mode.
    expect(card('A-B32')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Notes.');
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Everything.');
    expect(card('A-B32')).not.toBeNull();
  });

  it('an emptied note that gained an image is kept on close', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('C-D45');
    fireEvent.change(edText(), { target: { value: '' } });
    pasteImage();
    await waitFor(() => expect(editor()!.querySelector('.ed-thumb')).not.toBeNull());
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
  });

  it('the drop overlay shows the attach state while the editor is open', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    const over = () => {
      const e = new Event('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { types: ['Files'], files: [] } });
      document.dispatchEvent(e);
    };
    over();
    await waitFor(() => expect(document.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('new'));
    document.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expandCard('A-B32');
    over();
    await waitFor(() => expect(document.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('attach'));
  });

  it('a dedupe hit says so quietly in the editor and attaches nothing', async () => {
    attachReply = () => ({
      status: 200,
      body: { note: { id: 'K-F07', body: 'River', tags: [], created_at: iso, updated_at: iso, origin: null, images: [img('K-F07', 'K-F07')] }, attached: false },
    });
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    pasteImage();
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('already in K-F07'));
    expect(editor()!.querySelector('[data-notice]')?.className).toContain('on');
    expect(editor()!.querySelector('.ed-thumb')).toBeNull();
  });

  it('the strip remove icon soft-removes one image', async () => {
    server = server.map((n) => (n.id === 'A-B32' ? { ...n, images: [img('A-B32', 'A-B32', 0), img('Q-RS1', 'A-B32', 1)] } : n));
    render(<App />);
    await screen.findByText('buy fennel');
    fireEvent.click(screen.getByLabelText('Text notes only (click to switch)'));
    fireEvent.click(screen.getByLabelText('Image notes only (click to switch)'));
    expandCard('A-B32');
    expect(editor()!.querySelectorAll('.ed-thumb')).toHaveLength(2);
    fireEvent.click(within(editor()!.querySelector('[data-image="Q-RS1"]') as HTMLElement).getByLabelText('Remove image'));
    expect(editor()!.querySelectorAll('.ed-thumb')).toHaveLength(1);
    await waitFor(() => expect(of('DELETE', '/api/images/Q-RS1')).toHaveLength(1));
    expect(editor()!.querySelector('[data-image="A-B32"]')).not.toBeNull();
  });

  it('Esc in the editor leaves an open chat answer alone', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith('/api/chat')
          ? new Response('event: delta\ndata: {"text":"Look at A-B32."}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
          : base(input, init),
      ),
    );
    render(<App />);
    await screen.findByText('onboarding is long');
    fireEvent.change(screen.getByLabelText('Ask about your notes'), { target: { value: 'seer?' } });
    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    await waitFor(() => expect(document.querySelector('.answer')).not.toBeNull());
    expandCard('C-D45');
    fireEvent.keyDown(edText(), { key: 'Escape' });
    expect(editor()).toBeNull();
    expect(document.querySelector('.answer')).not.toBeNull();
  });
});

describe('App chat images (R1)', () => {
  type Call = { method: string; url: string; body?: unknown };
  let calls: Call[];
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const uploaded = {
    created: true,
    image: {
      id: 'U-PL1',
      mime: 'image/png',
      width: 10,
      height: 10,
      bytes: 3,
      original_name: 'shot.png',
      host: 'lenovo',
      source: 'wall',
      created_at: iso,
      available: true,
      urls: {
        thumb: '/api/chat/images/U-PL1/thumb',
        display: '/api/chat/images/U-PL1/display',
        original: '/api/chat/images/U-PL1/original',
        preview: '/api/chat/images/U-PL1/preview',
      },
    },
  };

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
        if (url === '/api/chat/images') {
          return new Response(JSON.stringify(uploaded), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        if (url.startsWith('/api/chat')) {
          return new Response('event: delta\ndata: {"text":"A red square."}\n\nevent: done\ndata: {"thread_id":"t1"}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        if (url.startsWith('/api/notes')) return json({ notes, next_cursor: null });
        if (url.startsWith('/api/tags')) return json(tags);
        return new Response('not found', { status: 404 });
      }),
    );
  });

  it('a paste into the focused chat bar uploads a chat image, never a note, and sends its id', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    const ta = screen.getByLabelText('Ask about your notes') as HTMLTextAreaElement;
    ta.focus();
    fireEvent.paste(ta, { clipboardData: { files: [png] } });
    await waitFor(() =>
      expect(document.querySelector('.chatbar-thumb img')?.getAttribute('src')).toBe('/api/chat/images/U-PL1/thumb'),
    );
    expect(calls.filter((c) => c.method === 'POST' && c.url === '/api/chat/images')).toHaveLength(1);
    expect(calls.some((c) => c.url === '/api/images')).toBe(false);

    fireEvent.submit(document.querySelector('form.chatbar') as HTMLFormElement);
    await screen.findByText('A red square.');
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/chat')?.body).toEqual({ message: '', image_ids: ['U-PL1'] });
    expect(document.querySelector('.chatbar-thumb')).toBeNull();
    expect(document.querySelector('.answer-images img')?.getAttribute('src')).toBe('/api/chat/images/U-PL1/thumb');
    expect(document.querySelector('.answer-q')?.textContent).toBe('1 image');
  });

  it('a paste with the chat bar not focused still makes a new photo note', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await screen.findByText('onboarding is long');
    (document.activeElement as HTMLElement | null)?.blur();
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files: [png] } });
    document.dispatchEvent(e);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/images')).toBe(true));
    expect(calls.some((c) => c.url === '/api/chat/images')).toBe(false);
    quiet.mockRestore();
  });
});

describe('App note files (R2)', () => {
  type Call = { method: string; url: string; file: string | null };
  let calls: Call[];
  let server: Note[];
  let removed: Map<string, NoteFile>;
  let fileReply: (noteId: string, name: string) => { status: number; body: unknown };

  const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const png = new File(['png'], 'shot.png', { type: 'image/png' });
  const paste = (files: File[]) => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { files } });
    document.dispatchEvent(e);
  };
  const card = (id: string) => document.querySelector(`[data-note="${id}"]`) as HTMLElement;
  const editor = () => document.querySelector('[data-modal="editor"]') as HTMLElement | null;
  const edText = () => within(editor()!).getByLabelText('Note text') as HTMLTextAreaElement;
  const expandCard = (id: string) => {
    const btn = within(card(id)).getByLabelText('Expand note');
    fireEvent.mouseDown(btn);
    fireEvent.click(btn);
  };
  const of = (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    calls = [];
    removed = new Map();
    server = [
      makeNote('A-B32', '#seer onboarding is long', { created: iso }),
      makeNote('C-D45', 'buy fennel #kitchen', { created: iso, files: [makeFile('F-IL1', { note_id: 'C-D45', name: 'receipt.pdf' })] }),
    ];
    let seq = 0;
    fileReply = (noteId, name) => {
      const n = server.find((x) => x.id === noteId)!;
      const files = n.files ?? [];
      seq += 1;
      const f = makeFile(`F-NW${seq}`, { note_id: noteId, name, mime: 'text/plain', bytes: 5, position: files.length });
      return { status: 201, body: { note: { ...n, files: [...files, f] }, attached: true, kind: 'file' } };
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        const file = init?.body instanceof FormData ? ((init.body.get('file') as File | null)?.name ?? null) : null;
        calls.push({ method, url, file });
        if (method === 'GET' && url.startsWith('/api/notes')) return reply({ notes: server, next_cursor: null });
        if (method === 'GET' && url.startsWith('/api/tags')) return reply([]);
        const one = url.match(/^\/api\/notes\/([^/]+)$/);
        if (one && method === 'PATCH') {
          const body = (JSON.parse(String(init?.body)) as { body: string }).body;
          server = server.map((n) => (n.id === one[1] ? { ...n, body } : n));
          return reply(server.find((n) => n.id === one[1]));
        }
        if (one && method === 'DELETE') {
          server = server.filter((n) => n.id !== one[1]);
          return reply({ ok: true });
        }
        const files = url.match(/^\/api\/notes\/([^/]+)\/files$/);
        if (files && method === 'POST') {
          const r = fileReply(files[1]!, file ?? 'file');
          if (r.status === 201) {
            const next = (r.body as { note: Note }).note;
            server = server.map((n) => (n.id === next.id ? next : n));
          }
          return reply(r.body, r.status);
        }
        const images = url.match(/^\/api\/notes\/([^/]+)\/images$/);
        if (images && method === 'POST') {
          const n = server.find((x) => x.id === images[1])!;
          const next = { ...n, images: [...n.images, makeImage('P-IC1', { note_id: n.id, mime: 'image/png' })] };
          server = server.map((x) => (x.id === n.id ? next : x));
          return reply({ note: next, attached: true }, 201);
        }
        const rm = url.match(/^\/api\/files\/([^/]+)$/);
        if (rm && method === 'DELETE') {
          const owner = server.find((n) => (n.files ?? []).some((f) => f.id === rm[1]))!;
          const gone = (owner.files ?? []).find((f) => f.id === rm[1])!;
          removed.set(gone.id, gone);
          const next = { ...owner, files: (owner.files ?? []).filter((f) => f.id !== rm[1]) };
          server = server.map((n) => (n.id === owner.id ? next : n));
          return reply(next);
        }
        const rs = url.match(/^\/api\/files\/([^/]+)\/restore$/);
        if (rs && method === 'POST') {
          const f = removed.get(rs[1]!)!;
          const owner = server.find((n) => n.id === f.note_id)!;
          const next = { ...owner, files: [...(owner.files ?? []), f].sort((a, b) => a.position - b.position) };
          server = server.map((n) => (n.id === owner.id ? next : n));
          return reply(next);
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  it('pasting a non-image file while the editor is open attaches it to that note as a chip', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('.fchip[data-file="F-NW1"]')).not.toBeNull());
    expect(of('POST', '/api/notes/A-B32/files')).toHaveLength(1);
    expect(of('POST', '/api/notes/A-B32/files')[0]!.file).toBe('notes.txt');
    expect(calls.some((c) => c.url.endsWith('/images'))).toBe(false);
  });

  it('outside the editor a non-image paste is ignored', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    paste([txt]);
    await tick();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('the paperclip picker routes files to /files and images to /images, in pick order', async () => {
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    fireEvent.click(within(editor()!).getByLabelText('Attach files'));
    const input = editor()!.querySelector('input[data-picker]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [txt, png], configurable: true });
    fireEvent.change(input);
    await waitFor(() => expect(of('POST', '/api/notes/A-B32/images')).toHaveLength(1));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/notes/A-B32/files', '/api/notes/A-B32/images']);
    await waitFor(() => expect(editor()!.querySelector('.fchip[data-file="F-NW1"]')).not.toBeNull());
  });

  it('a file dedupe hit says quietly which note holds it', async () => {
    fileReply = () => ({ status: 200, body: { note: server.find((n) => n.id === 'C-D45')!, attached: false, kind: 'file' } });
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('already in C-D45'));
    expect(editor()!.querySelector('.fchip')).toBeNull();
  });

  it('a failed attach says so in the editor', async () => {
    fileReply = () => ({ status: 413, body: { error: 'too_large' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('could not attach notes.txt (too large)'));
    vi.mocked(console.error).mockRestore();
  });

  it('a 409 duplicate_file on attach says which note holds the bytes', async () => {
    fileReply = () => ({ status: 409, body: { error: 'duplicate_file', note_id: 'C-D45', message: 'already attached' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />);
    await screen.findByText('onboarding is long');
    expandCard('A-B32');
    paste([txt]);
    await waitFor(() => expect(editor()!.querySelector('[data-notice]')?.textContent).toBe('already in C-D45'));
    vi.mocked(console.error).mockRestore();
  });

  it('a note holding only files is kept when emptied in the editor and closed', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    expandCard('C-D45');
    fireEvent.change(edText(), { target: { value: '' } });
    fireEvent.keyDown(edText(), { key: 'Escape' });
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    await tick();
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
    expect(card('C-D45')).not.toBeNull();
  });

  it('a note holding only files is kept when emptied inline on the card', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    fireEvent.click(card('C-D45').querySelector('.card-text') as HTMLElement);
    const ta = card('C-D45').querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.blur(ta);
    await waitFor(() => expect(of('PATCH', '/api/notes/C-D45')).toHaveLength(1));
    await tick();
    expect(of('DELETE', '/api/notes/C-D45')).toHaveLength(0);
    expect(card('C-D45')).not.toBeNull();
  });

  it('the card shows a paperclip count for a note with files', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    expect(card('C-D45').querySelector('.card-files')?.textContent).toBe('1');
    expect(card('A-B32').querySelector('.card-files')).toBeNull();
  });

  it('removing a file chip soft-removes it; Undo restores it', async () => {
    render(<App />);
    await screen.findByText('buy fennel');
    expandCard('C-D45');
    const chip = () => editor()!.querySelector('.fchip[data-file="F-IL1"]') as HTMLElement | null;
    expect(chip()).not.toBeNull();
    fireEvent.click(within(chip()!).getByLabelText('Remove file'));
    expect(chip()).toBeNull();
    await waitFor(() => expect(of('DELETE', '/api/files/F-IL1')).toHaveLength(1));
    expect(document.querySelector('[data-undo] .undo-label')?.textContent).toBe('removed file');
    fireEvent.click(screen.getByLabelText('Undo'));
    await waitFor(() => expect(of('POST', '/api/files/F-IL1/restore')).toHaveLength(1));
    await waitFor(() => expect(chip()).not.toBeNull());
  });
});
