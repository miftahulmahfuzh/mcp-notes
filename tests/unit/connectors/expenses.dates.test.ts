import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  daysInclusive,
  isValidDateIso,
  isValidMonthKey,
  isoWeekKey,
  isoWeekMonday,
  todayWib,
  weekdayOf,
} from '../../../src/connectors/expenses/dates.js';

describe('expenses dates', () => {
  it('validates real calendar days and months', () => {
    expect(isValidDateIso('2026-10-31')).toBe(true);
    expect(isValidDateIso('2028-02-29')).toBe(true);
    expect(isValidDateIso('2026-02-29')).toBe(false);
    expect(isValidDateIso('2026-02-30')).toBe(false);
    expect(isValidDateIso('2026-13-01')).toBe(false);
    expect(isValidDateIso('26-10-01')).toBe(false);
    expect(isValidDateIso(20261001)).toBe(false);
    expect(isValidMonthKey('2026-10')).toBe(true);
    expect(isValidMonthKey('2026-13')).toBe(false);
    expect(isValidMonthKey('2026-1')).toBe(false);
  });

  it('adds days across month and year ends and counts inclusive spans', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysInclusive('2026-10-01', '2026-10-31')).toBe(31);
    expect(daysInclusive('2026-10-06', '2026-10-06')).toBe(1);
    expect(daysInclusive('2026-01-01', '2026-12-31')).toBe(365);
  });

  it('names weekdays', () => {
    expect(weekdayOf('2026-10-05')).toBe('Mon');
    expect(weekdayOf('2026-10-01')).toBe('Thu');
    expect(weekdayOf('2026-11-01')).toBe('Sun');
  });

  it('finds the Monday of the ISO week (Monday–Sunday)', () => {
    expect(isoWeekMonday('2026-10-01')).toBe('2026-09-28');
    expect(isoWeekMonday('2026-10-05')).toBe('2026-10-05');
    expect(isoWeekMonday('2026-11-01')).toBe('2026-10-26');
  });

  it('labels ISO weeks by the year of their Thursday', () => {
    expect(isoWeekKey('2026-10-05')).toBe('2026-W41');
    expect(isoWeekKey('2026-10-01')).toBe('2026-W40');
    expect(isoWeekKey('2026-12-28')).toBe('2026-W53');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
    expect(isoWeekKey('2021-01-03')).toBe('2020-W53');
    expect(isoWeekKey('2024-12-30')).toBe('2025-W01');
  });

  it('reads today in Asia/Jakarta, not UTC', () => {
    // 2026-10-30T18:30Z is 2026-10-31 01:30 in Jakarta (UTC+7).
    expect(todayWib(new Date('2026-10-30T18:30:00Z'))).toBe('2026-10-31');
    expect(todayWib(new Date('2026-10-30T16:59:00Z'))).toBe('2026-10-30');
  });

  it('adds months with integer math', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', 3)).toBe('2027-01');
    expect(addMonths('2026-10', -21)).toBe('2025-01');
    expect(() => addMonths('2026-13', 1)).toThrow(RangeError);
  });
});
