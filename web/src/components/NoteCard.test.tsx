// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { Note } from '../types';
import { NoteCard } from './NoteCard';
import type { NoteCardProps } from './NoteCard';

afterEach(cleanup);

const now = new Date();
function note(body: string, image = false): Note {
  return {
    id: 'A-B32',
    body,
    tags: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    origin: null,
    image: image ? { mime: 'image/jpeg', width: 600, height: 400, bytes: 1, taken_at: null, original_name: null, host: 'lenovo', available: true } : null,
  };
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
    ...over,
  };
  return { ...render(<NoteCard {...props} />), props };
}

describe('NoteCard', () => {
  it('renders the font size by text length', () => {
    const cases: Array<[string, boolean, string]> = [
      ['short #a', false, '26px'],
      ['a'.repeat(50), false, '17px'],
      ['a'.repeat(120), false, '13.5px'],
      ['a'.repeat(10), true, '13px'],
    ];
    for (const [body, image, fs] of cases) {
      const { container, unmount } = renderCard(note(body, image));
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

  it('renders the thumbnail for image notes with the image aspect ratio', () => {
    const { container } = renderCard(note('pic', true));
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/notes/A-B32/thumb');
    expect(img.style.aspectRatio).toBe('600 / 400');
  });
});
