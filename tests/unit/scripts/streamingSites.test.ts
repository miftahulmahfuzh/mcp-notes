import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { pathOnSite, pickMatches } from '../../../claude/streaming/match.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { fillScreenExpression } from '../../../claude/streaming/play.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import idlix, { CLICK_PLAY_EXPRESSION, WAIT_FOR_FILM_EXPRESSION, episodeExpression, searchExpression, seriesSlug, toResult as idlixResult } from '../../../claude/streaming/sites/idlix.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { findEpisode, readEpisodeFlags } from '../../../claude/streaming/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import lk21, { START_PLAYER_EXPRESSION, searchHost, splitTitle, toResult as lk21Result } from '../../../claude/streaming/sites/lk21.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import flicksy, { startPlayerExpression, toResult as flicksyResult } from '../../../claude/streaming/sites/flicksy.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { SITES } from '../../../claude/streaming/sites/index.mjs';

const parses = (expression: string): void => {
  expect(() => new Function(`return ${expression}`)).not.toThrow();
};

describe('streaming sites: what every site module provides', () => {
  it.each(Object.entries(SITES) as Array<[string, any]>)('%s has the whole contract', (name, site) => {
    expect(site.name).toBe(name);
    expect(site.origin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    expect(site.originEnv).toMatch(/^[A-Z0-9]+_ORIGIN$/);
    expect(typeof site.label).toBe('string');
    expect(typeof site.playerSelector).toBe('string');
    for (const fn of ['titlePath', 'search', 'start']) expect(typeof site[fn]).toBe('function');
    expect(site.titlePath('https://example.com/movie/x-2020')).toBeNull();
    expect(site.titlePath('javascript:alert(1)')).toBeNull();
    expect(site.titlePath('not a url')).toBeNull();
  });

  it('the fill-screen expression parses and names the player it stretches', () => {
    const expression = fillScreenExpression('#main-player');
    parses(expression);
    expect(expression).toContain('#main-player{position:fixed!important');
    expect(expression).toContain("e.key === 'Escape'");
  });

  it('pathOnSite accepts only the site itself and the given shape of path', () => {
    const shape = /^\/movie\/[a-z0-9-]+$/;
    expect(pathOnSite('https://a.example/movie/x?next=1', 'https://a.example', shape)).toBe('/movie/x');
    expect(pathOnSite('https://a.example/auth/login', 'https://a.example', shape)).toBeNull();
    expect(pathOnSite('https://b.example/movie/x', 'https://a.example', shape)).toBeNull();
  });
});

describe('idlix', () => {
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
  const results = API_RESULTS.map((item) => idlixResult(item, ORIGIN)).filter(Boolean);

  it('asks the search API the way the site does, with the title safely quoted', () => {
    expect(searchExpression('no other choice')).toContain('"/api/search?q=no+other+choice&page=1&limit=20"');
    expect(searchExpression('it\'s "a" test')).toContain('"/api/search?q=it\'s+%22a%22+test&page=1&limit=20"');
  });

  it('builds a film page under /movie and a series page under /series', () => {
    expect(idlixResult(API_RESULTS[0], ORIGIN)).toEqual({
      title: 'No Other Choice (2025)',
      name: 'No Other Choice',
      original_name: '어쩔수가없다',
      year: 2025,
      kind: 'movie',
      quality: 'WEB-DL',
      seasons: null,
      url: 'https://z2.idlixku.com/movie/no-other-choice-2025',
    });
    expect(idlixResult(API_RESULTS[1], ORIGIN)).toMatchObject({ title: 'La Brea (2021)', kind: 'series', seasons: 3, url: 'https://z2.idlixku.com/series/la-brea-2021' });
  });

  it('drops a result with no known page or no slug', () => {
    expect(idlixResult(API_RESULTS[4], ORIGIN)).toBeNull();
    expect(idlixResult(API_RESULTS[5], ORIGIN)).toBeNull();
    expect(results).toHaveLength(4);
  });

  it('matches on the name past case and punctuation, and on the original-language name', () => {
    expect(pickMatches(results, { name: 'no other choice', year: null }).matches.map((r: { url: string }) => r.url)).toEqual(['https://z2.idlixku.com/movie/no-other-choice-2025']);
    expect(pickMatches(results, { name: '어쩔수가없다', year: null }).matches.map((r: { name: string }) => r.name)).toEqual(['No Other Choice']);
  });

  it('keeps every year without one asked, and only the asked year with one', () => {
    expect(pickMatches(results, { name: 'pilot', year: null }).matches.map((r: { year: number }) => r.year)).toEqual([2024, 1998]);
    expect(pickMatches(results, { name: 'pilot', year: 1998 }).matches.map((r: { year: number }) => r.year)).toEqual([1998]);
  });

  it('plays only a title page on the site itself', () => {
    expect(idlix.titlePath(`${idlix.origin}/movie/no-other-choice-2025`)).toBe('/movie/no-other-choice-2025');
    expect(idlix.titlePath(`${idlix.origin}/series/la-brea-2021`)).toBe('/series/la-brea-2021');
    expect(idlix.titlePath(`${idlix.origin}/auth/login`)).toBeNull();
  });

  it('plays an episode page, and nothing else under a series', () => {
    expect(idlix.titlePath(`${idlix.origin}/series/one-piece-1999/season/18/episode/787`)).toBe('/series/one-piece-1999/season/18/episode/787');
    expect(idlix.titlePath(`${idlix.origin}/series/one-piece-1999/season/18`)).toBeNull();
    expect(idlix.titlePath(`${idlix.origin}/movie/x-2020/season/1/episode/1`)).toBeNull();
    expect(seriesSlug(`${idlix.origin}/series/one-piece-1999`)).toBe('one-piece-1999');
    expect(seriesSlug(`${idlix.origin}/movie/one-piece-film-red-2022`)).toBeNull();
    expect(seriesSlug('https://elsewhere.example/series/one-piece-1999')).toBeNull();
  });

  it("asks the site's own episode API: the named season, or every season the series lists", () => {
    const every = episodeExpression('one-piece-1999', null, 787);
    parses(every);
    expect(every).toContain("'/api/series/' + slug");
    expect(every).toContain("'/season/' + s + '/episode/' + 787");
    expect(every).toContain('let seasons = null;');
    const one = episodeExpression('la-brea-2021', 2, 3);
    parses(one);
    expect(one).toContain('let seasons = [2];');
    // Read only: nothing is pressed and nothing is posted.
    expect(`${every}${one}`).not.toMatch(/\.click\(|method:/);
  });
});

describe('an episode of a series (cli.mjs)', () => {
  const OP = { title: 'One Piece (1999)', kind: 'series', url: 'https://site.example/series/one-piece-1999' };
  const LIVE = { title: 'ONE PIECE (2023)', kind: 'series', url: 'https://site.example/series/one-piece-2023' };
  const FILM = { title: 'One Piece Film: Red (2022)', kind: 'movie', url: 'https://site.example/movie/red' };
  const hit = (url: string, season: number, episode: number, has_video = true) => ({ season, episode, name: `S${season}E${episode}`, has_video, url: `${url}/season/${season}/episode/${episode}` });
  /** A site whose series have the episodes listed per series url. */
  const site = (have: Record<string, [number, number, boolean?][]>) => {
    const asked: unknown[] = [];
    return {
      asked,
      episodes: async (url: string, want: { season: number | null; episode: number }) => {
        asked.push([url, want]);
        return (have[url] ?? []).filter(([s, e]) => e === want.episode && (want.season === null || s === want.season)).map(([s, e, v]) => hit(url, s, e, v));
      },
    };
  };

  it('reads --episode and --season out of the words, in any place', () => {
    expect(readEpisodeFlags(['one', 'piece', '--episode', '787'])).toEqual({ words: ['one', 'piece'], season: null, episode: 787, bad: null });
    expect(readEpisodeFlags(['--season', '2', 'la', 'brea', '2021', '--episode', '3'])).toEqual({ words: ['la', 'brea', '2021'], season: 2, episode: 3, bad: null });
    expect(readEpisodeFlags(['la', 'brea'])).toEqual({ words: ['la', 'brea'], season: null, episode: null, bad: null });
    expect(readEpisodeFlags(['x', '--episode', 'three']).bad).toBe('--episode takes a whole number');
    expect(readEpisodeFlags(['x', '--episode']).bad).toBe('--episode takes a whole number');
    expect(readEpisodeFlags(['x', '--season', '2']).bad).toBe('--season needs --episode');
  });

  it('finds the one series that has the episode, in the season the site names', async () => {
    const s = site({ [OP.url]: [[18, 787]], [LIVE.url]: [[1, 1], [2, 1]] });
    const found = await findEpisode(s, [OP, LIVE, FILM], { season: null, episode: 787 });
    expect(found).toEqual({ episode: { ...hit(OP.url, 18, 787), title: 'One Piece (1999)' } });
    // Only series are asked, never a film.
    expect(s.asked).toEqual([[OP.url, { season: null, episode: 787 }], [LIVE.url, { season: null, episode: 787 }]]);
  });

  it('starts nothing when several episodes fit, none does, the episode has no video, or there is no series', async () => {
    const s = site({ [OP.url]: [[1, 1], [18, 788, false]], [LIVE.url]: [[1, 1], [2, 1]] });
    const several = await findEpisode(s, [OP, LIVE], { season: null, episode: 1 });
    expect(several).toMatchObject({ episode: null, skipped: 'several_episodes' });
    expect(several.candidates.map((c: { title: string; season: number }) => [c.title, c.season])).toEqual([['One Piece (1999)', 1], ['ONE PIECE (2023)', 1], ['ONE PIECE (2023)', 2]]);
    // A season narrows it, but two series still have season 1 episode 1.
    expect((await findEpisode(s, [OP, LIVE], { season: 2, episode: 1 })).episode).toMatchObject({ title: 'ONE PIECE (2023)', season: 2 });
    expect(await findEpisode(s, [OP, LIVE], { season: null, episode: 5000 })).toEqual({ episode: null, skipped: 'no_episode' });
    expect(await findEpisode(s, [OP], { season: null, episode: 788 })).toMatchObject({ episode: null, skipped: 'no_video' });
    expect(await findEpisode(s, [FILM], { season: null, episode: 1 })).toEqual({ episode: null, skipped: 'no_match' });
  });

  it('says so when the site plays no episodes, or could not be asked', async () => {
    expect(await findEpisode({}, [OP], { season: null, episode: 1 })).toEqual({ episode: null, skipped: 'no_episodes' });
    const down = { episodes: async () => { throw new Error('the site answered HTTP 403'); } };
    expect(await findEpisode(down, [OP], { season: null, episode: 1 })).toEqual({ episode: null, skipped: 'episode_lookup_failed', error: 'the site answered HTTP 403' });
    expect(typeof idlix.episodes).toBe('function');
    expect(lk21.episodes).toBeUndefined();
  });

  it("ships page expressions that parse, and presses nothing but play and the site's own Skip Ad", () => {
    for (const expression of [CLICK_PLAY_EXPRESSION, WAIT_FOR_FILM_EXPRESSION]) parses(expression);
    const clicks = [CLICK_PLAY_EXPRESSION, WAIT_FOR_FILM_EXPRESSION].join('\n').match(/\w+\.click\(\)/g);
    expect(clicks).toEqual(['hero.click()', 'skip.click()']);
    expect(WAIT_FOR_FILM_EXPRESSION).toContain('/^skip ad$/i');
  });
});

describe('lk21', () => {
  const ORIGIN = 'https://tv12.lk21official.cc';
  // The shape search.php answered with on 2026-11-15.
  const DATA = [
    { episode: '', is_complete: 0, quality: 'HD', season: '', slug: 'love-your-life-2026', title: 'Love of Your Life (2026)', type: 'movie', year: 2026 },
    { episode: 6, is_complete: 1, quality: '', season: 3, slug: 'la-brea-2021', title: 'La Brea (2021) - Series', type: 'series', year: 2021 },
    { episode: 0, is_complete: 0, quality: 'HD', season: 0, slug: 'just-a-breath-away-dans-la-brume-2018', title: 'Just a Breath Away (Dans la brume) (2018)', type: 'movie', year: 2018 },
    { title: 'No Slug (2020)', type: 'movie', year: 2020 },
  ];
  const results = DATA.map((item) => lk21Result(item, ORIGIN)).filter(Boolean);

  it('reads the search host off the home page body', () => {
    expect(searchHost("<body data-thumbnail_url='https://p.example/' data-search_url='https://gudangvape.com/' data-web_type='movie'>")).toBe('https://gudangvape.com');
    expect(searchHost('<body data-search_url="https://s.example">')).toBe('https://s.example');
    expect(searchHost('<body class="home">')).toBeNull();
  });

  it('splits a title into its name and the other name in brackets', () => {
    expect(splitTitle('Love of Your Life (2026)')).toEqual({ name: 'Love of Your Life', original_name: null });
    expect(splitTitle('La Brea (2021) - Series')).toEqual({ name: 'La Brea', original_name: null });
    expect(splitTitle('Just a Breath Away (Dans la brume) (2018)')).toEqual({ name: 'Just a Breath Away', original_name: 'Dans la brume' });
  });

  it('builds results with the page at the site root', () => {
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: 'Love of Your Life (2026)',
      name: 'Love of Your Life',
      original_name: null,
      year: 2026,
      kind: 'movie',
      quality: 'HD',
      seasons: null,
      url: 'https://tv12.lk21official.cc/love-your-life-2026',
    });
    expect(results[1]).toMatchObject({ title: 'La Brea (2021)', kind: 'series', quality: null, seasons: 3 });
  });

  it('matches on either name of a title', () => {
    expect(pickMatches(results, { name: 'dans la brume', year: null }).matches.map((r: { name: string }) => r.name)).toEqual(['Just a Breath Away']);
    expect(pickMatches(results, { name: 'love of your life', year: 2026 }).matches).toHaveLength(1);
    expect(pickMatches(results, { name: 'love of your life', year: 2020 }).matches).toHaveLength(0);
  });

  it('plays only a title page on the site itself', () => {
    expect(lk21.titlePath(`${lk21.origin}/love-your-life-2026`)).toBe('/love-your-life-2026');
    expect(lk21.titlePath(`${lk21.origin}/search?s=x`)).toBeNull();
    expect(lk21.titlePath(`${lk21.origin}/genre/action`)).toBeNull();
  });

  it("ships a player expression that parses and presses only the player's own play", () => {
    parses(START_PLAYER_EXPRESSION);
    expect(START_PLAYER_EXPRESSION.match(/\w+\.click\(\)/g)).toEqual(['button.click()']);
    expect(START_PLAYER_EXPRESSION).toContain('.custom-play-btn');
  });
});

describe('flicksy', () => {
  const ORIGIN = 'https://flicksy.pro';
  // The shape /api/tmdb/search/multi answered with on 2026-11-17.
  const DATA = [
    { id: 572468, title: 'Impetigore', original_title: 'Perempuan Tanah Jahanam', original_language: 'id', release_date: '2019-10-17', media_type: 'movie' },
    { id: 128839, name: 'La Brea', original_name: 'La Brea', first_air_date: '2021-09-28', media_type: 'tv', origin_country: ['US'] },
    { id: 1234387, title: 'La Bréa', original_title: 'La Bréa', release_date: '', media_type: 'movie' },
    { id: 121798, name: 'Joko Anwar', media_type: 'person', known_for_department: 'Directing' },
    { title: 'No Id', release_date: '2020-01-01', media_type: 'movie' },
  ];
  const results = DATA.map((item) => flicksyResult(item, ORIGIN)).filter(Boolean);

  it("builds results with the page named by the title's TMDB id, and leaves people out", () => {
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: 'Impetigore (2019)',
      name: 'Impetigore',
      original_name: 'Perempuan Tanah Jahanam',
      year: 2019,
      kind: 'movie',
      quality: null,
      seasons: null,
      url: 'https://flicksy.pro/watch/movie/572468',
    });
    expect(results[1]).toMatchObject({ title: 'La Brea (2021)', original_name: null, kind: 'series', url: 'https://flicksy.pro/series/128839' });
    expect(results[2]).toMatchObject({ title: 'La Bréa', year: null, kind: 'movie' });
  });

  it('matches on either name of a title', () => {
    expect(pickMatches(results, { name: 'perempuan tanah jahanam', year: null }).matches.map((r: { name: string }) => r.name)).toEqual(['Impetigore']);
    expect(pickMatches(results, { name: 'impetigore', year: 2019 }).matches).toHaveLength(1);
    expect(pickMatches(results, { name: 'impetigore', year: 2020 }).matches).toHaveLength(0);
  });

  it("plays only a film's player page on the site itself", () => {
    expect(flicksy.titlePath(`${flicksy.origin}/watch/movie/572468`)).toBe('/watch/movie/572468');
    expect(flicksy.titlePath(`${flicksy.origin}/watch/movie/572468?server=vidlink`)).toBe('/watch/movie/572468');
    expect(flicksy.titlePath(`${flicksy.origin}/series/128839`)).toBeNull();
    expect(flicksy.titlePath(`${flicksy.origin}/watch/series/128839`)).toBeNull();
    expect(flicksy.titlePath(`${flicksy.origin}/movie/572468`)).toBeNull();
    expect(flicksy.episodes).toBeUndefined();
  });

  it("ships a player expression that parses, checks the film's id and presses only the player's own play", () => {
    const expression = startPlayerExpression('572468');
    parses(expression);
    expect(expression.match(/\w+\.click\(\)/g)).toEqual(['button.click()']);
    expect(expression).toContain('button[aria-label="Play Stream"]');
    expect(expression).toContain('"/embed/572468"');
  });
});
