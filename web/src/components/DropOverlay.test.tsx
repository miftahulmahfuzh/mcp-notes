// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DropOverlay, chatBarHasFocus, firstImageFile, hasFiles, imageFiles } from './DropOverlay';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function render(ui: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui));
  return host;
}

const txt = new File(['hello'], 'a.txt', { type: 'text/plain' });
const png = new File(['png'], 'b.png', { type: 'image/png' });
const jpg = new File(['jpg'], 'c.jpg', { type: 'image/jpeg' });

function eventWith(type: string, prop: 'clipboardData' | 'dataTransfer', value: unknown): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, prop, { value });
  return e;
}

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const flush = async () => {
  for (let i = 0; i < 10; i++) await act(async () => {});
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('file helpers', () => {
  it('firstImageFile picks the first image file', () => {
    expect(firstImageFile([txt, png, jpg])).toBe(png);
    expect(firstImageFile([txt])).toBeNull();
    expect(firstImageFile(null)).toBeNull();
    expect(imageFiles([txt, png, jpg])).toEqual([png, jpg]);
  });
  it('hasFiles only for Files drags', () => {
    expect(hasFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(hasFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
    expect(hasFiles(null)).toBe(false);
  });
});

describe('DropOverlay', () => {
  it('paste uploads only the first image file and prevents default', async () => {
    fetchMock.mockResolvedValue(okResponse({ note: { id: 'A-B32', body: '', tags: [], created_at: '', images: [] }, created: true }));
    const onImageAdded = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} />);
    const e = eventWith('paste', 'clipboardData', { files: [txt, png, jpg] });
    act(() => {
      document.dispatchEvent(e);
    });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/images');
    expect(init.method).toBe('POST');
    expect(((init.body as FormData).get('file') as File).name).toBe('b.png');
    expect(onImageAdded).toHaveBeenCalledTimes(1);
    expect(onImageAdded.mock.calls[0]![0]).toMatchObject({ id: 'A-B32' });
  });

  it('a text-only paste is left alone', () => {
    render(<DropOverlay onImageAdded={() => {}} />);
    const e = eventWith('paste', 'clipboardData', { files: [txt] });
    act(() => {
      document.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a dedupe hit is handed to onImageAdded like any upload', async () => {
    fetchMock.mockResolvedValue(okResponse({ note: { id: 'K-F07', body: '', tags: [], created_at: '', images: [] }, created: false }));
    const onImageAdded = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} />);
    act(() => {
      document.dispatchEvent(eventWith('paste', 'clipboardData', { files: [png] }));
    });
    await flush();
    // A dedupe hit goes through the same seam (App switches text -> all); flashNote then scrolls to it.
    expect(onImageAdded).toHaveBeenCalledTimes(1);
    expect(onImageAdded.mock.calls[0]![0]).toMatchObject({ id: 'K-F07' });
  });

  it('shows the overlay only for Files drags and uploads dropped images one at a time', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((res) => resolvers.push(res)));
    const el = render(<DropOverlay onImageAdded={() => {}} />);

    act(() => {
      document.dispatchEvent(eventWith('dragover', 'dataTransfer', { types: ['text/plain'], files: [] }));
    });
    expect(el.querySelector('[data-drop-overlay]')).toBeNull();

    const over = eventWith('dragover', 'dataTransfer', { types: ['Files'], files: [] });
    act(() => {
      document.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    expect(el.querySelector('[data-drop-overlay]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [png, txt, jpg] }));
    });
    expect(el.querySelector('[data-drop-overlay]')).toBeNull();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvers[0](okResponse({ note: { id: 'A-B32', body: '', tags: [], created_at: '', images: [] }, created: true }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData).get('file') as File).name).toBe('c.jpg');
  });

  it('dragleave with no relatedTarget hides the overlay', () => {
    const el = render(<DropOverlay onImageAdded={() => {}} />);
    act(() => {
      document.dispatchEvent(eventWith('dragover', 'dataTransfer', { types: ['Files'], files: [] }));
    });
    act(() => {
      document.dispatchEvent(new Event('dragleave', { bubbles: true }));
    });
    expect(el.querySelector('[data-drop-overlay]')).toBeNull();
  });

  it('with a target, a paste attaches to that note instead of making a new one', async () => {
    const attached = { note: { id: 'A-B32', body: 'long', tags: [], created_at: '', updated_at: '', origin: null, images: [] }, attached: true };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(attached), { status: 201, headers: { 'content-type': 'application/json' } }));
    const onImageAdded = vi.fn();
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} target="A-B32" onAttached={onAttached} />);
    const e = eventWith('paste', 'clipboardData', { files: [png] });
    act(() => {
      document.dispatchEvent(e);
    });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notes/A-B32/images');
    expect(init.method).toBe('POST');
    expect(((init.body as FormData).get('file') as File).name).toBe('b.png');
    expect(onAttached).toHaveBeenCalledWith(attached, 'A-B32');
    expect(onImageAdded).not.toHaveBeenCalled();
  });

  it('with a target, dropped files attach one at a time in order: images to /images, others to /files; a dedupe result is passed through', async () => {
    const dup = { note: { id: 'K-F07', body: '', tags: [], created_at: '', updated_at: '', origin: null, images: [], files: [] }, attached: false };
    fetchMock.mockImplementation(async () => okResponse(dup));
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={onAttached} />);
    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [png, txt, jpg] }));
    });
    await flush();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/notes/A-B32/images', '/api/notes/A-B32/files', '/api/notes/A-B32/images']);
    expect((((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as FormData).get('file') as File).name).toBe('a.txt');
    expect(onAttached).toHaveBeenCalledTimes(3);
    expect(onAttached.mock.calls[0]![0]).toMatchObject({ attached: false, note: { id: 'K-F07' } });
  });

  it('the overlay shows the attach icon while a target is set, the new-note icon otherwise', () => {
    const el = render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={() => {}} />);
    act(() => {
      document.dispatchEvent(eventWith('dragover', 'dataTransfer', { types: ['Files'], files: [] }));
    });
    expect(el.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('attach');
    act(() => root!.render(<DropOverlay onImageAdded={() => {}} target={null} />));
    expect(el.querySelector('[data-drop-overlay]')?.getAttribute('data-drop-overlay')).toBe('new');
  });

  it('with a target, a pasted non-image file attaches to that note as a file', async () => {
    const attached = { note: { id: 'A-B32', body: '', tags: [], created_at: '', updated_at: '', origin: null, images: [], files: [] }, attached: true, kind: 'file' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(attached), { status: 201, headers: { 'content-type': 'application/json' } }));
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={onAttached} />);
    const e = eventWith('paste', 'clipboardData', { files: [txt] });
    act(() => {
      document.dispatchEvent(e);
    });
    await flush();
    expect(e.defaultPrevented).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notes/A-B32/files');
    expect(init.method).toBe('POST');
    expect(((init.body as FormData).get('file') as File).name).toBe('a.txt');
    expect(onAttached).toHaveBeenCalledWith(attached, 'A-B32');
  });

  it('with a target, a text-only paste (no files) is left to the focused field', () => {
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={() => {}} />);
    const e = eventWith('paste', 'clipboardData', { files: [] });
    act(() => {
      document.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('without a target, a dropped non-image file is ignored', async () => {
    render(<DropOverlay onImageAdded={() => {}} />);
    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [txt] }));
    });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed attach is reported through onAttachFailed and the queue keeps going', async () => {
    const ok = { note: { id: 'A-B32', body: '', tags: [], created_at: '', updated_at: '', origin: null, images: [], files: [] }, attached: true };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'too_large' }), { status: 413, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 201, headers: { 'content-type': 'application/json' } }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onAttachFailed = vi.fn();
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={() => {}} target="A-B32" onAttached={onAttached} onAttachFailed={onAttachFailed} />);
    act(() => {
      document.dispatchEvent(eventWith('drop', 'dataTransfer', { types: ['Files'], files: [txt, png] }));
    });
    await flush();
    expect(onAttachFailed).toHaveBeenCalledTimes(1);
    expect(onAttachFailed.mock.calls[0]![0]).toBe(txt);
    expect((onAttachFailed.mock.calls[0]![1] as { status?: number }).status).toBe(413);
    expect(onAttached).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

function chatBarFixture(): { form: HTMLFormElement; ta: HTMLTextAreaElement } {
  const form = document.createElement('form');
  form.setAttribute('data-chatbar', 'wall');
  const ta = document.createElement('textarea');
  form.appendChild(ta);
  document.body.appendChild(form);
  return { form, ta };
}

describe('chatBarHasFocus', () => {
  it('is true only for an element inside [data-chatbar]', () => {
    const { form, ta } = chatBarFixture();
    const other = document.createElement('textarea');
    document.body.appendChild(other);
    try {
      expect(chatBarHasFocus(ta)).toBe(true);
      expect(chatBarHasFocus(form)).toBe(true);
      expect(chatBarHasFocus(other)).toBe(false);
      expect(chatBarHasFocus(document.body)).toBe(false);
      expect(chatBarHasFocus(null)).toBe(false);
      ta.focus();
      expect(chatBarHasFocus()).toBe(true);
      other.focus();
      expect(chatBarHasFocus()).toBe(false);
    } finally {
      form.remove();
      other.remove();
    }
  });
});

describe('DropOverlay and the chat bar', () => {
  it('a paste while the chat bar is focused is left to the chat bar', async () => {
    const onImageAdded = vi.fn();
    render(<DropOverlay onImageAdded={onImageAdded} />);
    const { form, ta } = chatBarFixture();
    try {
      ta.focus();
      const e = eventWith('paste', 'clipboardData', { files: [png] });
      ta.dispatchEvent(e);
      await flush();
      expect(e.defaultPrevented).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onImageAdded).not.toHaveBeenCalled();
    } finally {
      form.remove();
    }
  });

  it('with an editor target, a paste in the focused chat bar does not attach either', async () => {
    const onAttached = vi.fn();
    render(<DropOverlay onImageAdded={vi.fn()} target="A-B32" onAttached={onAttached} />);
    const { form, ta } = chatBarFixture();
    try {
      ta.focus();
      ta.dispatchEvent(eventWith('paste', 'clipboardData', { files: [png] }));
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onAttached).not.toHaveBeenCalled();
    } finally {
      form.remove();
    }
  });
});
