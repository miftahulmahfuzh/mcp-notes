import { describe, expect, it } from 'vitest';
import { relativeDate } from './dates';

const now = new Date(2026, 9, 30, 15, 0, 0); // local time, Oct 30 2026 15:00
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).toISOString();

describe('relativeDate', () => {
  it('says just now under a minute and for small future skew', () => {
    expect(relativeDate(at(2026, 9, 30, 14, 59, 30), now)).toBe('just now');
    expect(relativeDate(at(2026, 9, 30, 15, 0, 5), now)).toBe('just now');
  });
  it('says N min ago under an hour', () => {
    expect(relativeDate(at(2026, 9, 30, 14, 46), now)).toBe('14 min ago');
    expect(relativeDate(at(2026, 9, 30, 14, 1), now)).toBe('59 min ago');
  });
  it('says Today, then Yesterday', () => {
    expect(relativeDate(at(2026, 9, 30, 9, 0), now)).toBe('Today');
    expect(relativeDate(at(2026, 9, 30, 0, 0), now)).toBe('Today');
    expect(relativeDate(at(2026, 9, 29, 23, 59), now)).toBe('Yesterday');
    expect(relativeDate(at(2026, 9, 29, 0, 0), now)).toBe('Yesterday');
  });
  it('lower-cases for mid-sentence use', () => {
    expect(relativeDate(at(2026, 9, 30, 9, 0), now, true)).toBe('today');
    expect(relativeDate(at(2026, 9, 29, 9, 0), now, true)).toBe('yesterday');
  });
  it('uses "Oct 28" this year and adds the year otherwise', () => {
    expect(relativeDate(at(2026, 9, 28), now)).toBe('Oct 28');
    expect(relativeDate(at(2026, 0, 3), now)).toBe('Jan 3');
    expect(relativeDate(at(2025, 11, 31), now)).toBe('Dec 31, 2025');
  });
  it('returns empty for an invalid date', () => {
    expect(relativeDate('nope', now)).toBe('');
  });
});
