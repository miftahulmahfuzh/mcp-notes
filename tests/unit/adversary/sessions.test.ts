import { describe, expect, it } from 'vitest';
import { addDays, assertSessionDate, sessionOpenUtc, utcDate, wibDay, wibDayStartUtc } from '../../../src/adversary/sessions.js';

describe('sessionOpenUtc (mirror of seer_engine.dates.session_open_utc, contract C3)', () => {
  it('pins the contract examples', () => {
    expect(sessionOpenUtc('2026-11-04').toISOString()).toBe('2026-11-04T14:30:00.000Z');
    expect(sessionOpenUtc('2026-07-01').toISOString()).toBe('2026-07-01T13:30:00.000Z');
  });

  it('follows New York daylight saving on both sides of each 2026 switch', () => {
    // US DST 2026: starts Sunday 2026-03-08, ends Sunday 2026-11-01.
    expect(sessionOpenUtc('2026-03-06').toISOString()).toBe('2026-03-06T14:30:00.000Z');
    expect(sessionOpenUtc('2026-03-09').toISOString()).toBe('2026-03-09T13:30:00.000Z');
    expect(sessionOpenUtc('2026-10-30').toISOString()).toBe('2026-10-30T13:30:00.000Z');
    expect(sessionOpenUtc('2026-11-02').toISOString()).toBe('2026-11-02T14:30:00.000Z');
  });

  it.each(['2026-13-01', '2026-02-30', '20261104', ''])('refuses %j', (value) => {
    expect(() => sessionOpenUtc(value)).toThrow(TypeError);
  });
});

describe('WIB days and date helpers', () => {
  it('starts a WIB day at 17:00 UTC the day before', () => {
    const lateEvening = new Date('2026-11-05T16:59:00Z'); // 23:59 WIB, 5 Nov
    expect(wibDay(lateEvening)).toBe('2026-11-05');
    expect(wibDayStartUtc(lateEvening).toISOString()).toBe('2026-11-04T17:00:00.000Z');
    expect(wibDay(new Date('2026-11-05T17:00:00Z'))).toBe('2026-11-06');
  });

  it('adds calendar days and reads the UTC date', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(utcDate(new Date('2026-11-05T23:00:00Z'))).toBe('2026-11-05');
    expect(() => assertSessionDate('yesterday')).toThrow(TypeError);
  });
});
