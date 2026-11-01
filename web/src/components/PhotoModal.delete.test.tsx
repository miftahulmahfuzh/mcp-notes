// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Note, PhotoItem } from '../types';
import { makeNote } from '../testing/fixtures';
import { PhotoModal } from './PhotoModal';

afterEach(cleanup);

const note: Note = makeNote('K-F07', 'River #walks', { images: ['K-F07'] });
const image = note.images[0]!;
const items: PhotoItem[] = [{ note, image, k: 1, n: 1 }];

const base = { items, index: 0, onIndex: () => {}, copiedId: null, onCopy: () => {} };

describe('PhotoModal trash', () => {
  it("deletes only the shown image and closes", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<PhotoModal {...base} onClose={onClose} onDelete={onDelete} />);
    const btn = screen.getByRole('button', { name: 'Delete image' });
    expect(btn.getAttribute('data-tip')).toBe('Delete image');
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledWith(image);
    expect(onClose).toHaveBeenCalled();
  });

  it('has no trash icon without onDelete', () => {
    render(<PhotoModal {...base} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Delete image' })).toBeNull();
  });
});
