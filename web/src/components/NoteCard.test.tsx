// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note } from '../types';
import { NoteCard } from './NoteCard';
import type { NoteCardProps } from './NoteCard';
import { makeFile, makeNote } from '../testing/fixtures';
import { resetCapabilitiesForTests } from '../hooks/useCapabilities';

afterEach(cleanup);

const now = new Date();
function note(body: string, images: string[] = []): Note {
  return makeNote('A-B32', body, { images, tags: [], created: now.toISOString() });
}

function renderCard(n: Note, over: Partial<NoteCardProps> = {}) {
  const props = {
    note: n,
    now,
    editing: false,
    dim: false,
    used: false,
    copied: false,
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onCommit: vi.fn(),
    onToggleTag: vi.fn(),
    onExpand: vi.fn(),
    ...over,
  };
  return { ...render(<NoteCard {...props} />), props };
}

describe('NoteCard', () => {
  it('renders the font size by text length', () => {
    const cases: Array<[string, string[], string]> = [
      ['short #a', [], '26px'],
      ['a'.repeat(50), [], '17px'],
      ['a'.repeat(120), [], '13.5px'],
      ['a'.repeat(10), ['A-B32'], '13px'],
      ['a'.repeat(10), ['A-B32', 'M-N11'], '13px'],
    ];
    for (const [body, images, fs] of cases) {
      const { container, unmount } = renderCard(note(body, images));
      expect((container.querySelector('.card-text') as HTMLElement).style.fontSize).toBe(fs);
      unmount();
    }
  });

  it('renders tag chips; clicking one toggles the filter without entering edit', () => {
    const { container, props } = renderCard(note('#seer onboarding'));
    const chip = container.querySelector('.tagchip') as HTMLElement;
    expect(chip.textContent).toBe('#seer');
    fireEvent.click(chip);
    expect(props.onToggleTag).toHaveBeenCalledWith('seer');
    expect(props.onEdit).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.card-text') as HTMLElement);
    expect(props.onEdit).toHaveBeenCalledWith('A-B32');
  });

  it('ctrl/cmd+click on the text opens the big editor instead of editing inline', () => {
    const { container, props } = renderCard(note('hello'));
    const text = container.querySelector('.card-text') as HTMLElement;
    fireEvent.click(text, { ctrlKey: true });
    fireEvent.click(text, { metaKey: true });
    expect(props.onExpand).toHaveBeenCalledTimes(2);
    expect(props.onExpand).toHaveBeenCalledWith(props.note, null);
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('shows id, copy button, relative date; marks copied', () => {
    const { container, getByLabelText, props } = renderCard(note('x'), { copied: true });
    expect(container.querySelector('.card-id')?.textContent).toBe('A-B32');
    expect(container.querySelector('.card-date')?.textContent).toBe('just now');
    expect(container.querySelector('.copied')?.className).toContain('on');
    fireEvent.click(getByLabelText('Copy ID'));
    expect(props.onCopy).toHaveBeenCalledWith('A-B32');
  });

  it('commits the draft on blur while editing', () => {
    const n = note('old');
    const { container, props } = renderCard(n, { editing: true });
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('old');
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.blur(ta);
    expect(props.onCommit).toHaveBeenCalledWith(n, '');
  });

  it('a text note has no cover', () => {
    const { container } = renderCard(note('just text'));
    expect(container.querySelector('.card-cover')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('article')!.className).not.toContain('img');
  });

  it('a one-image note shows that image as the cover with no count', () => {
    const { container } = renderCard(note('pic', ['A-B32']));
    const img = container.querySelector('.card-cover img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/images/A-B32/thumb');
    expect(img.style.aspectRatio).toBe('600 / 400');
    expect(container.querySelector('.card-count')).toBeNull();
    expect(container.querySelector('article')!.className).toContain('img');
  });

  it('a multi-image note shows images[0] as the cover and the count on it, as plain text', () => {
    const { container } = renderCard(note('pics', ['A-B32', 'M-N11', 'P-Q22']));
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/api/images/A-B32/thumb');
    const count = container.querySelector('.card-cover .card-count') as HTMLElement;
    expect(count.textContent).toBe('3');
    expect(count.tagName).toBe('SPAN');
    expect(container.querySelector('.card-cover button')).toBeNull();
  });

  it('has an Expand note icon in the meta row that opens the big editor', () => {
    const n = note('x');
    const { getByLabelText, props } = renderCard(n);
    const btn = getByLabelText('Expand note');
    expect(btn.getAttribute('data-tip')).toBe('Expand note');
    expect(btn.closest('.card-meta')).not.toBeNull();
    fireEvent.click(btn);
    expect(props.onExpand).toHaveBeenCalledWith(n, null);
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('expanding while editing keeps the inline editor focused and hands over the unsaved draft', () => {
    const n = note('');
    const { container, getByLabelText, props } = renderCard(n, { editing: true });
    const ta = container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'typed inline' } });
    const btn = getByLabelText('Expand note');
    expect(fireEvent.mouseDown(btn)).toBe(false);
    fireEvent.click(btn);
    expect(props.onExpand).toHaveBeenCalledWith(n, 'typed inline');
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it('the trash icon deletes the note without entering edit', () => {
    const onDelete = vi.fn();
    const n = note('hello');
    const { container, props } = renderCard(n, { onDelete });
    const btn = container.querySelector('[aria-label="Delete note"]') as HTMLButtonElement;
    expect(btn.getAttribute('data-tip')).toBe('Delete note');
    expect(btn.textContent).toBe('');
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith(n);
    expect(props.onEdit).not.toHaveBeenCalled();
  });

  it('has no trash icon without onDelete', () => {
    const { container } = renderCard(note('hello'));
    expect(container.querySelector('[aria-label="Delete note"]')).toBeNull();
  });
});

/** The footer's children in order: aria-label for buttons, first class name for spans. */
function footerSequence(container: HTMLElement): string[] {
  const meta = container.querySelector('.card-meta') as HTMLElement;
  return Array.from(meta.children).map((el) => el.getAttribute('aria-label') ?? el.className.split(' ')[0]);
}

describe('NoteCard footer order', () => {
  afterEach(() => resetCapabilitiesForTests());

  it('puts Show in Explorer right after Copy ID, before the copied label, with the date on the right', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('pic', ['A-B32']), { onDelete: vi.fn() });
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'Show in Explorer', 'copied', 'card-date', 'Expand note', 'Delete note']);
  });

  it('keeps the reveal button in place while the copied label is showing', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { getByLabelText } = renderCard(note('pic', ['A-B32']), { copied: true });
    const reveal = getByLabelText('Show in Explorer');
    expect(reveal.previousElementSibling?.getAttribute('aria-label')).toBe('Copy ID');
    const label = reveal.nextElementSibling as HTMLElement;
    expect(label.className).toBe('copied on');
    expect(label.nextElementSibling?.className).toBe('card-date');
  });

  it('a text note has no reveal button and keeps id, copy, copied, date', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(note('just text'));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'copied', 'card-date', 'Expand note']);
  });

  it('without the reveal capability the footer is id, copy, copied, date', () => {
    resetCapabilitiesForTests({ reveal: false });
    const { container } = renderCard(note('pic', ['A-B32']));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'copied', 'card-date', 'Expand note']);
  });
});

describe('NoteCard files (R2)', () => {
  afterEach(() => resetCapabilitiesForTests());

  const withFiles = (body: string, available = true) =>
    makeNote('A-B32', body, {
      tags: [],
      created: now.toISOString(),
      files: [
        makeFile('F-IL1', { note_id: 'A-B32', available }),
        makeFile('F-IL2', { note_id: 'A-B32', position: 1, available }),
      ],
    });

  it('a note with files: note-level reveal right after Copy ID, paperclip count before the date', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(withFiles('contract'));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'Show in Explorer', 'copied', 'card-files', 'card-date', 'Expand note']);
    const count = container.querySelector('.card-files') as HTMLElement;
    expect(count.textContent).toBe('2');
    expect(count.dataset.files).toBe('2');
    expect(count.getAttribute('data-tip')).toBe('2 files');
    expect(container.querySelector('[data-reveal-note="A-B32"]')).not.toBeNull();
  });

  it('files all on another machine: the count stays, no reveal', () => {
    resetCapabilitiesForTests({ reveal: true });
    const { container } = renderCard(withFiles('far', false));
    expect(footerSequence(container)).toEqual(['card-id', 'Copy ID', 'copied', 'card-files', 'card-date', 'Expand note']);
  });

  it('a text note has no paperclip count', () => {
    const { container } = renderCard(note('plain'));
    expect(container.querySelector('.card-files')).toBeNull();
  });
});
