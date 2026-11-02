// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatCost, formatCount } from './sessionFormat';

describe('formatCount', () => {
  it('shortens token counts', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(-5)).toBe('0');
    expect(formatCount(Number.NaN)).toBe('0');
    expect(formatCount(950)).toBe('950');
    expect(formatCount(2000)).toBe('2k');
    expect(formatCount(12_345)).toBe('12.3k');
    expect(formatCount(250_000)).toBe('250k');
    expect(formatCount(1_500_000)).toBe('1.5M');
    expect(formatCount(3_200_000_000)).toBe('3.2B');
  });
});

describe('formatCost', () => {
  it('prints dollars with cents', () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});
