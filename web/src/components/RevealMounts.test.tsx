// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Note, NoteImage as NoteImageData, PhotoItem } from '../types';
import { makeImage, makeNote } from '../testing/fixtures';
import { NoteCard, type NoteCardProps } from './NoteCard';
import { PhotoModal, type PhotoModalProps } from './PhotoModal';
import { NoteEditor, type NoteEditorProps } from './NoteEditor';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

const iso = '2026-10-30T01:00:00.000Z';

// Phase 6's shared fixtures (web/src/testing/fixtures.ts).
function img(id: string, noteId: string, position: number, available = true): NoteImageData {
  return makeImage(id, { note_id: noteId, position, bytes: 10, original_name: `${id}.jpg`, host: available ? 'lenovo' : 'thinkpad', available });
}

function note(id: string, images: NoteImageData[]): Note {
  return makeNote(id, 'River #walks', { images, created: iso });
}

const reveals = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]')).map((b) => b.dataset.reveal);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCapabilitiesForTests();
});

function renderCard(n: Note) {
  const props = {
    note: n,
    now: new Date(iso),
    editing: false,
    dim: false,
    used: false,
    copied: false,
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onCommit: vi.fn(),
    onToggleTag: vi.fn(),
    onExpand: vi.fn(),
  } as NoteCardProps;
  return render(<NoteCard {...props} />);
}

describe('reveal mount points', () => {
  it('wall card: one icon in the meta row, for the cover image, when caps.reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1)]));
    const meta = container.querySelector('.card-meta') as HTMLElement;
    expect(reveals(meta)).toEqual(['K-F07']);
  });

  it('wall card: none for a text note, none when caps.reveal is false, none when the cover is elsewhere', () => {
    resetCapabilitiesForTests({ reveal: true });
    const text = renderCard(note('A-B32', []));
    expect(reveals(text.container)).toEqual([]);
    text.unmount();

    const away = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0, false)]));
    expect(reveals(away.container)).toEqual([]);
    away.unmount();

    resetCapabilitiesForTests({ reveal: false });
    const off = renderCard(note('K-F07', [img('K-F07', 'K-F07', 0)]));
    expect(reveals(off.container)).toEqual([]);
  });

  it('photo modal: the toolbar reveals the current image, not the note cover', () => {
    resetCapabilitiesForTests({ reveal: true });
    const n = note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1)]);
    const items: PhotoItem[] = [
      { note: n, image: n.images[0], k: 1, n: 2 },
      { note: n, image: n.images[1], k: 2, n: 2 },
    ];
    const props = {
      items,
      index: 1,
      onIndex: vi.fn(),
      onClose: vi.fn(),
      copiedId: null,
      onCopy: vi.fn(),
    } as PhotoModalProps;
    render(<PhotoModal {...props} />);
    const btn = document.querySelector('[data-modal="photo"] [data-reveal]') as HTMLElement;
    expect(btn.dataset.reveal).toBe('M-Q11');
    expect(btn.className).toBe('pm-btn');
    expect(btn.getAttribute('data-tip')).toBe('Show in Explorer');
  });

  it('editor strip: one icon per local image, none for an image on another machine', () => {
    resetCapabilitiesForTests({ reveal: true });
    const n = note('K-F07', [img('K-F07', 'K-F07', 0), img('M-Q11', 'K-F07', 1, false), img('P-R22', 'K-F07', 2)]);
    const props = { note: n } as NoteEditorProps;
    render(<NoteEditor {...props} />);
    expect(reveals(document.body)).toEqual(['K-F07', 'P-R22']);
  });

  it('editor strip: no icons when caps.reveal is false', () => {
    resetCapabilitiesForTests({ reveal: false });
    const n = note('K-F07', [img('K-F07', 'K-F07', 0), img('P-R22', 'K-F07', 1)]);
    const props = { note: n } as NoteEditorProps;
    render(<NoteEditor {...props} />);
    expect(reveals(document.body)).toEqual([]);
  });
});
