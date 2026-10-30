import { describe, expect, it } from 'vitest';
import {
  avgPaceSecPerKm,
  formatDuration,
  formatPace,
  formatZoneRange,
  hrDrop1Min,
  metresToKm,
  percentOf,
  toNumber,
  toText,
} from '../../../src/connectors/runs/format.js';

describe('runs format helpers', () => {
  it('formats pace as m:ss /km', () => {
    expect(formatPace(344)).toBe('5:44 /km');
    expect(formatPace(360)).toBe('6:00 /km');
    expect(formatPace(605)).toBe('10:05 /km');
    expect(formatPace(343.6)).toBe('5:44 /km');
    expect(formatPace(null)).toBeNull();
    expect(formatPace(0)).toBeNull();
  });

  it('formats duration as h:mm:ss', () => {
    expect(formatDuration(1800)).toBe('0:30:00');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(59.6)).toBe('0:01:00');
    expect(formatDuration(0)).toBe('0:00:00');
    expect(formatDuration(null)).toBeNull();
  });

  it('converts metres to km with two decimals', () => {
    expect(metresToKm(5230)).toBe(5.23);
    expect(metresToKm(16234)).toBe(16.23);
    expect(metresToKm(10000)).toBe(10);
    expect(metresToKm(null)).toBeNull();
  });

  it('computes period pace as summed duration over summed distance', () => {
    expect(avgPaceSecPerKm(16230, 5880)).toBe(362);
    expect(avgPaceSecPerKm(10000, 3600)).toBe(360);
    expect(avgPaceSecPerKm(0, 100)).toBeNull();
  });

  it('computes the 1-minute HR drop', () => {
    expect(hrDrop1Min(165, 130)).toBe(35);
    expect(hrDrop1Min(null, 130)).toBeNull();
    expect(hrDrop1Min(165, null)).toBeNull();
  });

  it('formats zone bounds like Apple prints them', () => {
    expect(formatZoneRange(null, 129)).toBe('< 129 bpm');
    expect(formatZoneRange(130, 145)).toBe('130-145 bpm');
    expect(formatZoneRange(174, null)).toBe('> 174 bpm');
    expect(formatZoneRange(null, null)).toBeNull();
  });

  it('computes one-decimal percentages', () => {
    expect(percentOf(900, 1800)).toBe(50);
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(5, 0)).toBeNull();
  });

  it('coerces driver values', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber('42')).toBe(42);
    expect(toNumber('146.5')).toBe(146.5);
    expect(toNumber(10n)).toBe(10);
    expect(toNumber('x')).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toText(null)).toBeNull();
    expect(toText('06:00:00')).toBe('06:00:00');
  });
});
