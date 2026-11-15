import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs skill script without type declarations
import { normalizeName, parseQuery, parseResults, pickMatches, searchUrl, splitTitle } from '../../../claude/skills/pahe/search.mjs';

function post(url: string, title: string): string {
  return `<li class="timeline-post"><div class="timeline-content">
    <h2 class="post-box-title">
      <a href="${url}">${title}</a>
    </h2>
    <div class="post-thumbnail"><a href="${url}"><img src="x.jpg" /></a></div>
  </div></li>`;
}

const PAGE = `<html><body>
  <ul id="menu"><li><a href="https://pahe.ink/2025-movie-lists/">2025 Movie Lists</a></li></ul>
  <div class="timeline-contents timeline-archive"><ul class="timeline">
    ${post('https://pahe.ink/no-other-choice-2025-hdrip-480p-720p-1080p/', 'No Other Choice (2025) WEB-DL 480p, 720p &#038; 1080p')}
    ${post('https://pahe.ink/no-other-choice-2025-bluray-480p-720p-1080p/', 'No Other Choice (2025) BluRay 480p, 720p &#038; 1080p')}
    ${post('https://pahe.ink/norsemen-season-1-3-complete-nf-web-dl-720p/', 'Norsemen Season 1-3 Complete NF WEB-DL 720p')}
    ${post('https://pahe.ink/monster-2023-web-dl-480p-720p-1080p-2/', 'Monster (2023) WEB-DL 480p, 720p, &#038; 1080p')}
    ${post('https://pahe.ink/monster-2003-bluray-720p/', 'Monster (2003) BluRay 720p')}
  </ul></div>
  <div class="widget"><a href="https://pahe.ink/avengers-endgame-2019-bluray/">Avengers: Endgame (2019)</a></div>
</body></html>`;

describe('pahe search script', () => {
  const now = new Date('2026-11-15T00:00:00Z');

  it('reads a trailing plausible year off the query and leaves number titles whole', () => {
    expect(parseQuery(['no', 'other', 'choice'], now)).toEqual({ name: 'no other choice', year: null });
    expect(parseQuery(['ready', 'or', 'not', '2019'], now)).toEqual({ name: 'ready or not', year: 2019 });
    expect(parseQuery(['ready or not (2019)'], now)).toEqual({ name: 'ready or not', year: 2019 });
    expect(parseQuery(['1917'], now)).toEqual({ name: '1917', year: null });
    expect(parseQuery(['blade', 'runner', '2049'], now)).toEqual({ name: 'blade runner 2049', year: null });
  });

  it('builds the search url with plus signs', () => {
    expect(searchUrl('no other choice')).toBe('https://pahe.ink/?s=no+other+choice');
  });

  it('splits a result title into name, year and release', () => {
    expect(splitTitle('No Other Choice (2025) BluRay 480p, 720p & 1080p')).toEqual({
      name: 'No Other Choice',
      year: 2025,
      release: 'BluRay 480p, 720p & 1080p',
    });
    expect(splitTitle('Norsemen Season 1-3 Complete NF WEB-DL 720p')).toEqual({
      name: 'Norsemen',
      year: null,
      release: 'Season 1-3 Complete NF WEB-DL 720p',
    });
  });

  it('normalizes names past case, punctuation, accents and ampersands', () => {
    expect(normalizeName('Amélie')).toBe('amelie');
    expect(normalizeName('D.P.')).toBe('dp');
    expect(normalizeName('Fast & Furious')).toBe(normalizeName('fast and furious'));
  });

  it('reads only the search results, once each, with entities decoded', () => {
    const results = parseResults(PAGE);
    expect(results.map((r: { url: string }) => r.url)).toEqual([
      'https://pahe.ink/no-other-choice-2025-hdrip-480p-720p-1080p/',
      'https://pahe.ink/no-other-choice-2025-bluray-480p-720p-1080p/',
      'https://pahe.ink/norsemen-season-1-3-complete-nf-web-dl-720p/',
      'https://pahe.ink/monster-2023-web-dl-480p-720p-1080p-2/',
      'https://pahe.ink/monster-2003-bluray-720p/',
    ]);
    expect(results[0].title).toBe('No Other Choice (2025) WEB-DL 480p, 720p & 1080p');
  });

  it('matches on the name and puts BluRay first', () => {
    const { matches, others } = pickMatches(parseResults(PAGE), { name: 'no other choice', year: null });
    expect(matches.map((r: { release: string }) => r.release)).toEqual([
      'BluRay 480p, 720p & 1080p',
      'WEB-DL 480p, 720p & 1080p',
    ]);
    expect(others).toHaveLength(3);
  });

  it('keeps every year without one asked, and only the asked year with one', () => {
    const results = parseResults(PAGE);
    expect(pickMatches(results, { name: 'Monster', year: null }).matches.map((r: { year: number }) => r.year)).toEqual([2003, 2023]);
    expect(pickMatches(results, { name: 'Monster', year: 2023 }).matches.map((r: { year: number }) => r.year)).toEqual([2023]);
  });

  it('matches a series, whose title has no year, on the name alone', () => {
    const { matches } = pickMatches(parseResults(PAGE), { name: 'norsemen', year: 2016 });
    expect(matches.map((r: { name: string }) => r.name)).toEqual(['Norsemen']);
  });

  it('finds nothing on a page without results', () => {
    expect(parseResults('<html><body><a href="https://pahe.ink/x/">x</a></body></html>')).toEqual([]);
  });
});
