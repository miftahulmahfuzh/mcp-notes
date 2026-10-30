// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note } from '../types';
import { NoteCard } from './NoteCard';
import type { NoteCardProps } from './NoteCard';
import { makeNote } from '../testing/fixtures';

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
});
