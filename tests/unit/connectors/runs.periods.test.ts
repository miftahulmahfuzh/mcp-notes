import { describe, expect, it } from 'vitest';
import {
  addDays,
  isRealDate,
  isoWeekKeyOf,
  isoWeekRange,
  monthRange,
  resolvePeriod,
  resolveRange,
  todayInWib,
} from '../../../src/connectors/runs/periods.js';

describe('runs period helpers', () => {
  it('validates real days', () => {
    expect(isRealDate('2026-10-28')).toBe(true);
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-10-28T00:00')).toBe(false);
    expect(isRealDate('yesterday')).toBe(false);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('gives today in WIB, not UTC', () => {
    expect(todayInWib(new Date('2026-10-31T17:30:00Z'))).toBe('2026-11-01');
    expect(todayInWib(new Date('2026-10-31T16:59:00Z'))).toBe('2026-10-31');
  });

  it('keys ISO weeks by the Thursday rule', () => {
    expect(isoWeekKeyOf('2025-12-29')).toBe('2026-W01');
    expect(isoWeekKeyOf('2027-01-03')).toBe('2026-W53');
    expect(isoWeekKeyOf('2026-10-28')).toBe('2026-W44');
    expect(isoWeekKeyOf('2026-09-30')).toBe('2026-W40');
    expect(isoWeekKeyOf('2026-10-01')).toBe('2026-W40');
  });

  it('ranges ISO weeks Monday to Sunday', () => {
    expect(isoWeekRange('2026-W01')).toEqual({ from: '2025-12-29', to: '2026-01-04' });
    expect(isoWeekRange('2026-W44')).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    expect(isoWeekRange('2026-W53')).toEqual({ from: '2026-12-28', to: '2027-01-03' });
    expect(() => isoWeekRange('2025-W53')).toThrow(RangeError);
    expect(() => isoWeekRange('2026-W54')).toThrow(RangeError);
  });

  it('ranges months', () => {
    expect(monthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(() => monthRange('2026-13')).toThrow(RangeError);
  });

  it('resolves a review period from a week key, month key or a day inside it', () => {
    expect(resolvePeriod('week', '2026-W44')).toEqual({ scope: 'week', key: '2026-W44', from: '2026-10-26', to: '2026-11-01' });
    expect(resolvePeriod('week', '2026-w44').key).toBe('2026-W44');
    expect(resolvePeriod('week', '2026-10-28').key).toBe('2026-W44');
    expect(resolvePeriod('month', '2026-10-15')).toEqual({ scope: 'month', key: '2026-10', from: '2026-10-01', to: '2026-10-31' });
    expect(resolvePeriod('month', '2026-09').to).toBe('2026-09-30');
  });

  it('defaults the period to the one containing today in WIB', () => {
    const now = new Date('2026-10-31T17:30:00Z'); // 2026-11-01 00:30 WIB
    expect(resolvePeriod('month', undefined, now).key).toBe('2026-11');
    expect(resolvePeriod('week', undefined, now).key).toBe('2026-W44');
  });

  it('rejects keys that are neither a period nor a day', () => {
    expect(() => resolvePeriod('week', 'banana')).toThrow(RangeError);
    expect(() => resolvePeriod('month', '2026-W44')).toThrow(RangeError);
    expect(() => resolvePeriod('week', '2025-W53')).toThrow(RangeError);
  });

  it('validates inclusive ranges and defaults to to today', () => {
    expect(resolveRange('2026-10-01', '2026-10-31')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveRange('2026-10-01', undefined, new Date('2026-10-30T03:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-30' });
    expect(() => resolveRange('2026-10-31', '2026-10-01')).toThrow(/after/);
    expect(() => resolveRange('2026-02-30', '2026-03-01')).toThrow(RangeError);
  });
});
