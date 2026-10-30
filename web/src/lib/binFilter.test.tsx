import { describe, expect, it } from 'vitest';
import type { Bin } from '../types';
import { BIN_HEADING, binCountLine } from './filter';

const bin = (notes: number, images: number): Bin => ({
  notes: Array.from({ length: notes }, () => ({}) as Bin['notes'][number]),
  images: Array.from({ length: images }, () => ({}) as Bin['images'][number]),
});

describe('bin heading and count line', () => {
  it('heads the bin "Deleted."', () => {
    expect(BIN_HEADING).toBe('Deleted.');
  });
  it('counts deleted notes and images', () => {
    expect(binCountLine(bin(3, 5), [])).toBe('3 deleted notes, 5 images.');
  });
  it('names the active tags', () => {
    expect(binCountLine(bin(1, 0), ['seer', 'ux'])).toBe('1 deleted notes, 0 images, tagged #seer #ux.');
  });
});
