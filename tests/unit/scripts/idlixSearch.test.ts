import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs skill script without type declarations
import { CLICK_PLAY_EXPRESSION, FILL_SCREEN_EXPRESSION, WAIT_FOR_FILM_EXPRESSION, pickMatches, searchExpression, titlePath, toResult } from '../../../claude/skills/idlix/search.mjs';

const ORIGIN = 'https://z2.idlixku.com';

// The shape /api/search answered with on 2026-11-15, cut to the fields the script reads.
const API_RESULTS = [
  { contentType: 'movie', title: 'No Other Choice', originalTitle: '어쩔수가없다', releaseDate: '2025-09-24', quality: 'WEB-DL', slug: 'no-other-choice-2025' },
  { contentType: 'tv_series', title: 'La Brea', originalTitle: 'La Brea', firstAirDate: '2021-09-28', numberOfSeasons: 3, slug: 'la-brea-2021' },
  { contentType: 'movie', title: 'Pilot', originalTitle: '파일럿', releaseDate: '2024-07-31', quality: 'WEB-DL', slug: 'pilot-2024' },
  { contentType: 'movie', title: 'Pilot', originalTitle: 'Pilot', releaseDate: '1998-01-01', quality: 'BLU-RAY', slug: 'pilot-1998' },
  { contentType: 'person', title: 'Park Chan-wook', slug: 'park-chan-wook' },
  { contentType: 'movie', title: 'No Slug' },
];

const results = API_RESULTS.map((item) => toResult(item, ORIGIN)).filter(Boolean);

describe('idlix search script', () => {
  it('asks the search API the way the site does, with the title safely quoted', () => {
    expect(searchExpression('no other choice')).toContain('"/api/search?q=no+other+choice&page=1&limit=20"');
    expect(searchExpression('it\'s "a" test')).toContain('"/api/search?q=it\'s+%22a%22+test&page=1&limit=20"');
  });

  it('builds a film page under /movie and a series page under /series', () => {
    expect(toResult(API_RESULTS[0], ORIGIN)).toEqual({
      title: 'No Other Choice (2025)',
      name: 'No Other Choice',
      original_name: '어쩔수가없다',
      year: 2025,
      kind: 'movie',
      quality: 'WEB-DL',
      seasons: null,
      url: 'https://z2.idlixku.com/movie/no-other-choice-2025',
    });
    expect(toResult(API_RESULTS[1], ORIGIN)).toMatchObject({
      title: 'La Brea (2021)',
      kind: 'series',
      seasons: 3,
      url: 'https://z2.idlixku.com/series/la-brea-2021',
    });
  });

  it('drops a result with no known page or no slug', () => {
    expect(toResult(API_RESULTS[4], ORIGIN)).toBeNull();
    expect(toResult(API_RESULTS[5], ORIGIN)).toBeNull();
    expect(results).toHaveLength(4);
  });

  it('matches on the name, past case and punctuation', () => {
    const { matches, others } = pickMatches(results, { name: 'no other choice', year: null });
    expect(matches.map((r: { url: string }) => r.url)).toEqual(['https://z2.idlixku.com/movie/no-other-choice-2025']);
    expect(others).toHaveLength(3);
  });

  it('matches on the original-language name too', () => {
    const { matches } = pickMatches(results, { name: '어쩔수가없다', year: null });
    expect(matches.map((r: { name: string }) => r.name)).toEqual(['No Other Choice']);
  });

  it('keeps every year without one asked, and only the asked year with one', () => {
    expect(pickMatches(results, { name: 'pilot', year: null }).matches.map((r: { year: number }) => r.year)).toEqual([2024, 1998]);
    expect(pickMatches(results, { name: 'pilot', year: 1998 }).matches.map((r: { year: number }) => r.year)).toEqual([1998]);
  });

  it('plays only a title page on the site itself', () => {
    expect(titlePath('https://z2.idlixku.com/movie/no-other-choice-2025', ORIGIN)).toBe('/movie/no-other-choice-2025');
    expect(titlePath('https://z2.idlixku.com/series/la-brea-2021', ORIGIN)).toBe('/series/la-brea-2021');
    expect(titlePath('https://example.com/movie/no-other-choice-2025', ORIGIN)).toBeNull();
    expect(titlePath('https://z2.idlixku.com/auth/login', ORIGIN)).toBeNull();
    expect(titlePath('https://z2.idlixku.com/movie/x?next=1', ORIGIN)).toBe('/movie/x');
    expect(titlePath('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(titlePath('not a url', ORIGIN)).toBeNull();
  });

  it('ships page expressions that parse, and presses nothing but play and the site\'s own Skip Ad', () => {
    for (const expression of [CLICK_PLAY_EXPRESSION, WAIT_FOR_FILM_EXPRESSION, FILL_SCREEN_EXPRESSION]) {
      expect(() => new Function(`return ${expression}`)).not.toThrow();
    }
    const clicks = [CLICK_PLAY_EXPRESSION, WAIT_FOR_FILM_EXPRESSION, FILL_SCREEN_EXPRESSION].join('\n').match(/\w+\.click\(\)/g);
    expect(clicks).toEqual(['hero.click()', 'skip.click()']);
    expect(WAIT_FOR_FILM_EXPRESSION).toContain('/^skip ad$/i');
  });
});
