// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note, NoteImage as NoteImageData } from '../types';
import { makeImage, makeNote } from '../testing/fixtures';
import { NoteEditor, type NoteEditorProps } from './NoteEditor';

afterEach(cleanup);

const iso = new Date().toISOString();

// Phase 6's shared fixtures (web/src/testing/fixtures.ts), with this file's PNG defaults.
function img(id: string, noteId: string, position = 0): NoteImageData {
  return makeImage(id, { note_id: noteId, position, mime: 'image/png', bytes: 10, original_name: 'shot.png' });
}

function note(body: string, images: NoteImageData[] = []): Note {
  return makeNote('A-B32', body, { images, tags: [], created: iso });
}

function renderEditor(n: Note, over: Partial<NoteEditorProps> = {}) {
  const props: NoteEditorProps = {
    note: n,
    copied: false,
    notice: null,
    onCopy: vi.fn(),
    onSave: vi.fn(),
    onClose: vi.fn(),
    onRemoveImage: vi.fn(),
    ...over,
  };
  const r = render(<NoteEditor {...props} />);
  const ta = r.getByLabelText('Note text') as HTMLTextAreaElement;
  return { ...r, props, ta };
}

describe('NoteEditor', () => {
  it('opens on the note: wide textarea with the body, focused, id and copy-id', () => {
    const { ta, container, getByLabelText, props, rerender } = renderEditor(note('first line'));
    expect(ta.value).toBe('first line');
    expect(document.activeElement).toBe(ta);
    expect(container.querySelector('.ed-id')?.textContent).toBe('A-B32');
    fireEvent.click(getByLabelText('Copy ID'));
    expect(props.onCopy).toHaveBeenCalledWith('A-B32');
    rerender(<NoteEditor {...props} copied />);
    expect(container.querySelector('.ed-top .copied')?.className).toContain('on');
  });

  it('shows tag chips from the live draft', () => {
    const { ta, container } = renderEditor(note('plain'));
    expect(container.querySelector('.ed-tags')).toBeNull();
    fireEvent.change(ta, { target: { value: 'now #seer and #UX' } });
    expect(Array.from(container.querySelectorAll('.ed-tag')).map((e) => e.textContent)).toEqual(['#seer', '#ux']);
  });

  it('saves on blur only when the text changed, once per change', () => {
    const n = note('old');
    const { ta, props } = renderEditor(n);
    fireEvent.blur(ta);
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.change(ta, { target: { value: 'new text' } });
    fireEvent.blur(ta);
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledWith(n, 'new text');
    fireEvent.blur(ta);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it('an emptied note is saved empty on blur and never closed or deleted while open', () => {
    const n = note('soon gone');
    const { ta, props, container } = renderEditor(n);
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.blur(ta);
    expect(props.onSave).toHaveBeenCalledWith(n, '');
    expect(props.onClose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-modal="editor"]')).not.toBeNull();
  });

  it('Esc closes in the capture phase without reaching the chat panel handler', () => {
    const chatEsc = vi.fn();
    document.addEventListener('keydown', chatEsc);
    try {
      const n = note('x');
      const { ta, props } = renderEditor(n);
      fireEvent.change(ta, { target: { value: 'x y' } });
      const notPrevented = fireEvent.keyDown(ta, { key: 'Escape' });
      expect(notPrevented).toBe(false);
      expect(chatEsc).not.toHaveBeenCalled();
      expect(props.onClose).toHaveBeenCalledTimes(1);
      expect(props.onClose).toHaveBeenCalledWith(n, 'x y', true);
    } finally {
      document.removeEventListener('keydown', chatEsc);
    }
  });

  it('close reports dirty=false after a blur save, and fires only once; a blur after close is ignored', () => {
    const n = note('a');
    const { ta, props, getByLabelText } = renderEditor(n);
    fireEvent.change(ta, { target: { value: 'ab' } });
    fireEvent.blur(ta);
    fireEvent.click(getByLabelText('Close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.blur(ta);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledWith(n, 'ab', false);
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it('a backdrop click closes; a click inside the panel does not', () => {
    const { container, props } = renderEditor(note('x'));
    fireEvent.click(container.querySelector('.ed-panel') as HTMLElement);
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('[data-modal="editor"]') as HTMLElement);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the images as a strip in order with a remove icon each', () => {
    const a = img('A-B32', 'A-B32', 0);
    const b = img('Q-RS1', 'A-B32', 1);
    const { container, getAllByLabelText, props } = renderEditor(note('pics', [a, b]));
    const tiles = Array.from(container.querySelectorAll('.ed-strip .ed-thumb'));
    expect(tiles.map((t) => t.getAttribute('data-image'))).toEqual(['A-B32', 'Q-RS1']);
    expect((tiles[0] as HTMLElement).style.aspectRatio).toBe('600 / 400');
    fireEvent.click(getAllByLabelText('Remove image')[1]!);
    expect(props.onRemoveImage).toHaveBeenCalledWith(b);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('renders no strip for a text note', () => {
    const { container } = renderEditor(note('text only'));
    expect(container.querySelector('.ed-strip')).toBeNull();
  });

  it('says a dedupe hit quietly in a Geist Mono label', () => {
    const { container, rerender, props } = renderEditor(note('x'));
    const label = () => container.querySelector('[data-notice]') as HTMLElement;
    expect(label().className).toBe('ed-notice');
    rerender(<NoteEditor {...props} notice="already in K-F07" />);
    expect(label().className).toBe('ed-notice on');
    expect(label().textContent).toBe('already in K-F07');
  });

  it('the trash icon deletes the note with the current draft', () => {
    const onDelete = vi.fn();
    const { container, props, ta } = renderEditor(note('first line'), { onDelete });
    fireEvent.change(ta, { target: { value: 'three paragraphs later' } });
    const btn = container.ownerDocument.querySelector('[aria-label="Delete note"]') as HTMLButtonElement;
    expect(btn.getAttribute('data-tip')).toBe('Delete note');
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith(props.note, 'three paragraphs later');
  });

  it('has no trash icon without onDelete', () => {
    const { container } = renderEditor(note('first line'));
    expect(container.ownerDocument.querySelector('[aria-label="Delete note"]')).toBeNull();
  });

  describe('tag autocomplete', () => {
    const known = [
      { tag: 'seer', count: 5, last_used: null },
      { tag: 'sera', count: 2, last_used: null },
      { tag: 'run', count: 9, last_used: null },
    ];
    const type = (ta: HTMLTextAreaElement, value: string) => {
      ta.setSelectionRange(value.length, value.length);
      fireEvent.change(ta, { target: { value, selectionStart: value.length } });
    };

    it('suggests existing tags by prefix, most used first, and Enter completes', () => {
      const { ta, getAllByRole, queryByRole } = renderEditor(note(''), { tags: known });
      type(ta, 'hi #se');
      expect(getAllByRole('option').map((o) => o.textContent)).toEqual(['#seer5', '#sera2']);
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(ta.value).toBe('hi #seer ');
      expect(queryByRole('listbox')).toBeNull();
    });

    it('arrow keys move, a click picks, Esc closes only the popup', () => {
      const onClose = vi.fn();
      const { ta, getAllByRole, queryByRole } = renderEditor(note(''), { tags: known, onClose });
      type(ta, '#s');
      fireEvent.keyDown(ta, { key: 'ArrowDown' });
      expect(getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(queryByRole('listbox')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      type(ta, 'x #r');
      fireEvent.mouseDown(getAllByRole('option')[0]);
      expect(ta.value).toBe('x #run ');
    });

    it('stays quiet without a # token', () => {
      const { ta, queryByRole } = renderEditor(note(''), { tags: known });
      type(ta, 'plain se');
      expect(queryByRole('listbox')).toBeNull();
      type(ta, 'a#se');
      expect(queryByRole('listbox')).toBeNull();
    });
  });
});
