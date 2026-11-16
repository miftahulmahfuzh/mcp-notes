import { describe, expect, it } from 'vitest';
import { DISCOVER_OVERVIEW_CHARS, inWindow, languageCode, rankByName, releaseWindow, shortOverview } from '../../../src/directStream/discover.js';

describe('languageCode', () => {
  it('reads an English name or a two-letter code, in any case', () => {
    expect(languageCode('Spanish')).toBe('es');
    expect(languageCode(' korean ')).toBe('ko');
    expect(languageCode('Indonesian')).toBe('id');
    expect(languageCode('ES')).toBe('es');
    expect(languageCode('ja')).toBe('ja');
  });

  it('codes Mandarin and Cantonese the way TMDB does', () => {
    expect(languageCode('mandarin')).toBe('zh');
    expect(languageCode('Cantonese')).toBe('cn');
  });

  it('answers null for what is neither', () => {
    expect(languageCode('klingonese')).toBeNull();
    expect(languageCode('')).toBeNull();
  });
});

describe('rankByName', () => {
  const list = [{ name: 'Blumhouse Television' }, { name: 'Not Blumhouse' }, { name: 'Blumhouse Productions' }, { name: 'BLUMHOUSE' }, { name: 'A24' }];

  it('puts the exact name first, then names that start with it, then names that contain it', () => {
    expect(rankByName(list, 'blumhouse').map((x) => x.name)).toEqual(['BLUMHOUSE', 'Blumhouse Television', 'Blumhouse Productions', 'Not Blumhouse']);
    expect(rankByName(list, 'paramount')).toEqual([]);
    expect(rankByName(list, '  ')).toEqual([]);
  });
});

describe('releaseWindow', () => {
  const TODAY = '2026-11-16';

  it('is one year, a range, or everything, and never reaches past today', () => {
    expect(releaseWindow(2026, undefined, undefined, TODAY)).toEqual({ from: '2026-01-01', to: TODAY });
    expect(releaseWindow(2019, undefined, undefined, TODAY)).toEqual({ from: '2019-01-01', to: '2019-12-31' });
    expect(releaseWindow(undefined, 2020, 2024, TODAY)).toEqual({ from: '2020-01-01', to: '2024-12-31' });
    expect(releaseWindow(undefined, undefined, 2030, TODAY)).toEqual({ from: null, to: TODAY });
    expect(releaseWindow(undefined, undefined, undefined, TODAY)).toEqual({ from: null, to: TODAY });
  });

  it('keeps dated titles inside it and drops undated ones', () => {
    const window = { from: '2026-01-01', to: TODAY };
    expect(inWindow('2026-03-01', window)).toBe(true);
    expect(inWindow('2025-12-31', window)).toBe(false);
    expect(inWindow('2026-12-01', window)).toBe(false);
    expect(inWindow(null, window)).toBe(false);
  });
});

describe('shortOverview', () => {
  it('cuts a long synopsis at a word', () => {
    expect(shortOverview(' A short one. ')).toBe('A short one.');
    const long = shortOverview('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(DISCOVER_OVERVIEW_CHARS + 3);
    expect(long.endsWith('word...')).toBe(true);
  });
});
