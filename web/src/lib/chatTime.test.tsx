import { describe, expect, it } from 'vitest';
import { chatTime, chatTimeTitle, jakartaParts } from './chatTime';

// 2026-10-31 08:00 in Jakarta.
const NOW = Date.parse('2026-10-31T01:00:00Z');

describe('chatTime (Asia/Jakarta, UTC+7)', () => {
  it('17:30 UTC is 00:30 the next day in Jakarta, so it reads as today', () => {
    expect(chatTime('2026-10-30T17:30:00Z', NOW)).toBe('00:30');
  });

  it('the same instant seen late on the 30th (Jakarta) is tomorrow, so it shows the date', () => {
    const late30th = Date.parse('2026-10-30T16:00:00Z'); // 23:00 WIB on 30 Oct
    expect(chatTime('2026-10-30T17:30:00Z', late30th)).toBe('31 Oct 00:30');
  });

  it('16:59 UTC is still the previous Jakarta day', () => {
    expect(chatTime('2026-10-30T16:59:00Z', NOW)).toBe('30 Oct 23:59');
  });

  it('midnight prints as 00, never 24', () => {
    expect(chatTime('2026-10-30T17:00:00Z', NOW)).toBe('00:00');
  });

  it('a new year in Jakarta starts at 17:00 UTC on 31 Dec', () => {
    expect(chatTime('2025-12-31T17:00:00Z', NOW)).toBe('1 Jan 00:00');
    expect(chatTime('2025-12-31T16:59:00Z', NOW)).toBe('31 Dec 2025 23:59');
  });

  it('accepts a Date for now and returns empty for garbage', () => {
    expect(chatTime('2026-10-31T00:05:00Z', new Date(NOW))).toBe('07:05');
    expect(chatTime('not a time', NOW)).toBe('');
  });

  it('the tooltip is the full Jakarta wall time with its offset', () => {
    expect(chatTimeTitle('2026-10-30T17:30:00.000Z')).toBe('2026-10-31T00:30:00+07:00 (UTC+7)');
    expect(chatTimeTitle('nope')).toBe('nope');
  });

  it('jakartaParts reads the wall clock', () => {
    expect(jakartaParts('2026-10-30T17:30:45Z')).toEqual({ year: 2026, month: 10, day: 31, hour: 0, minute: 30, second: 45 });
  });
});
