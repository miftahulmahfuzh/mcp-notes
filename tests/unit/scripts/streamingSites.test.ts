import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { SEEN_MAX, recall, remember, seenFile } from '../../../claude/streaming/seen.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { pathOnSite, pickMatches } from '../../../claude/streaming/match.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { fillScreenExpression } from '../../../claude/streaming/play.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import idlix, { CLICK_PLAY_EXPRESSION, WAIT_FOR_FILM_EXPRESSION, episodeExpression, searchExpression, seriesSlug, toResult as idlixResult } from '../../../claude/streaming/sites/idlix.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import { findEpisode, playReport, readEpisodeFlags, reportPlay } from '../../../claude/streaming/cli.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import lk21, { START_PLAYER_EXPRESSION, searchHost, splitTitle, toResult as lk21Result } from '../../../claude/streaming/sites/lk21.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import flicksy, { startPlayerExpression, toResult as flicksyResult } from '../../../claude/streaming/sites/flicksy.mjs';
// @ts-expect-error -- plain .mjs scripts without type declarations
import dramacool, { FIND_FRAME_EXPRESSION, decodeEntities, frameMatchOf, parseDetails, parseEpisodes, parseSearch, seasonOfPage, splitTitle as dramacoolTitle, startPlayerExpression as dramacoolPlayer, toResult as dramacoolResult } from '../../../claude/streaming/sites/dramacool.mjs';
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
    expect(found).toEqual({ episode: { ...hit(OP.url, 18, 787), title: 'One Piece (1999)', series_url: OP.url } });
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

describe('a play that started is reported to the daemon', () => {
  const MATCH = { title: 'Summer Vacation (2026)', name: 'Summer Vacation', original_name: null, year: 2026, kind: 'series', quality: null, seasons: null, url: 'https://dramacool9.com.ro/summer-vacation-2026' };

  it("reports the title's page and what the search said of it, with the episode's numbers", () => {
    expect(playReport('dramacool', MATCH, { season: 1, episode: 3, url: 'https://dramacool9.com.ro/summer-vacation-2026-episode-3.html' })).toEqual({
      site: 'dramacool',
      url: 'https://dramacool9.com.ro/summer-vacation-2026',
      name: 'Summer Vacation',
      original_name: null,
      year: 2026,
      kind: 'series',
      season: 1,
      episode: 3,
    });
    expect(playReport('lk21', { ...MATCH, kind: 'movie' })).toMatchObject({ site: 'lk21', kind: 'movie', season: null, episode: null });
  });

  it("posts to this machine's daemon and answers what it kept; a daemon that is down never fails the play", async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fetchOk = async (url: string, init: never) => {
      calls.push({ url, init });
      return { json: async () => ({ recorded: true, title_id: 'tv-335951', season: 1, episode: 3 }) };
    };
    expect(await reportPlay(playReport('dramacool', MATCH), fetchOk)).toEqual({ recorded: true, title_id: 'tv-335951', season: 1, episode: 3 });
    expect(calls[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/movies\/site-play$/);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers['x-notes-site-play']).toBe('1');
    expect(JSON.parse(calls[0]!.init.body).name).toBe('Summer Vacation');
    expect(await reportPlay(playReport('dramacool', MATCH), async () => { throw new Error('ECONNREFUSED'); })).toBeNull();
    expect(await reportPlay(playReport('dramacool', MATCH), async () => ({ json: async () => ({ error: 'movies_off' }) }))).toBeNull();
  });
});

describe('what the searches returned lately', () => {
  it('reads back what a search said of an address, keeps the newest answer and forgets the oldest', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'seen-')), 'state', 'seen.json');
    expect(recall('https://a.example/x', file)).toBeNull();
    remember([{ url: 'https://a.example/x', report: { site: 'lk21', url: 'https://a.example/x', name: 'X', year: 2020 } }], file);
    remember([{ url: 'https://a.example/y', report: { site: 'lk21', url: 'https://a.example/y', name: 'Y' } }, { url: '', report: {} }], file);
    expect(recall('https://a.example/x', file)).toMatchObject({ name: 'X', year: 2020 });
    remember([{ url: 'https://a.example/x', report: { site: 'lk21', url: 'https://a.example/x', name: 'X again' } }], file);
    expect(recall('https://a.example/x', file)).toMatchObject({ name: 'X again' });
    remember(Array.from({ length: SEEN_MAX }, (_, i) => ({ url: `https://a.example/n${i}`, report: { site: 'lk21', url: `https://a.example/n${i}` } })), file);
    expect(recall('https://a.example/x', file)).toBeNull();
    expect(recall(`https://a.example/n${SEEN_MAX - 1}`, file)).not.toBeNull();
    // A file that is not what was written reads as nothing, and a folder that cannot be made is no error.
    writeFileSync(file, 'not json');
    expect(recall('https://a.example/y', file)).toBeNull();
    expect(() => remember([{ url: 'https://a.example/z', report: {} }], '/proc/nope/seen.json')).not.toThrow();
    expect(seenFile({ XDG_STATE_HOME: '/s', HOME: '/h' })).toBe('/s/notesd-streaming/seen.json');
    expect(seenFile({ HOME: '/h' })).toBe('/h/.local/state/notesd-streaming/seen.json');
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

describe('dramacool', () => {
  const ORIGIN = 'https://dramacool9.com.ro';
  // Cut from the search page (/?s=) and a title's page as the site answered on 2026-11-18.
  const SEARCH_HTML = `
    <ul class="box">
      <li><a class="mask" href="https://dramacool9.com.ro/summer-vacation-2026" title="Summer Vacation (2026)"><img data-original="x.jpg" class="lazy wp-post-image" alt="" /><h3>Summer Vacation (2026)</h3><span class="time">3 weeks ago</span></a></li>
      <li><a class="mask" href="https://dramacool9.com.ro/love-wins-all-season-2-2026" title="Love Wins All Season 2 (2026)"><h3>Love Wins All Season 2 (2026)</h3></a></li>
      <li><a class="mask" href="https://dramacool9.com.ro/love-wins-all-2025" title="Love Wins All (2025)"><h3>Love Wins All (2025)</h3></a></li>
      <li><a class="mask" href="https://dramacool9.com.ro/lovers-gangsters-2026" title="Lovers &#038; Gangsters (2026)"><h3>Lovers &#038; Gangsters (2026)</h3></a></li>
      <li><a class="mask" href="https://dramacool9.com.ro/concrete-market-movie-2025" title="Concrete Market (Movie) (2025)"><h3>Concrete Market (Movie) (2025)</h3></a></li>
      <li><a class="mask" href="https://dramacool9.com.ro/devils-stay-un" title="Devils Stay"><h3>Devils Stay</h3></a></li>
      <li><a class="mask" href="https://elsewhere.example/summer-vacation-2026" title="Elsewhere (2026)"><h3>Elsewhere (2026)</h3></a></li>
      <li><a class="mask" href="https://dramacool9.com.ro/genre/youth" title="Youth"><h3>Youth</h3></a></li>
    </ul>
    <a title="Youth" href="https://dramacool9.com.ro/genre/youth">Youth</a>`;
  const TITLE_HTML = `
    <div id="episode-list" class="block"><div id="all-episodes"><ul class="list">
      <li><span class="sub subbed">SUB</span><h3><a href='https://dramacool9.com.ro/summer-vacation-2026-episode-8.html' title='Summer Vacation (2026) Episode 8'>Summer Vacation (2026) Episode 8</a></h3></li>
      <li><h3><a href='https://dramacool9.com.ro/summer-vacation-2026-episode-3.html' title='Summer Vacation (2026) Episode 3'>Summer Vacation (2026) Episode 3</a></h3></li>
      <li><h3><a href='https://elsewhere.example/summer-vacation-2026-episode-4.html' title='Summer Vacation (2026) Episode 4'>x</a></h3></li>
      <li><h3><a href='https://dramacool9.com.ro/summer-vacation-2026' title='Summer Vacation (2026)'>x</a></h3></li>
    </ul></div><!--all-episodes--></div>
    <li><a href="https://dramacool9.com.ro/god-of-eternity-2026-episode-35.html" title="God of Eternity (2026) Episode 35">God of Eternity (2026) Episode 35</a></li>`;
  const results = parseSearch(SEARCH_HTML).map((item: unknown) => dramacoolResult(item, ORIGIN)).filter(Boolean);

  it('reads the result cards, and keeps only title pages on the site itself', () => {
    expect(parseSearch(SEARCH_HTML)).toHaveLength(8);
    expect(results.map((r: { url: string }) => r.url)).toEqual([
      'https://dramacool9.com.ro/summer-vacation-2026',
      'https://dramacool9.com.ro/love-wins-all-season-2-2026',
      'https://dramacool9.com.ro/love-wins-all-2025',
      'https://dramacool9.com.ro/lovers-gangsters-2026',
      'https://dramacool9.com.ro/concrete-market-movie-2025',
      'https://dramacool9.com.ro/devils-stay-un',
    ]);
    expect(results[0]).toEqual({
      title: 'Summer Vacation (2026)',
      name: 'Summer Vacation',
      original_name: null,
      year: 2026,
      kind: 'series',
      quality: null,
      seasons: null,
      url: 'https://dramacool9.com.ro/summer-vacation-2026',
    });
    expect(results[3]).toMatchObject({ title: 'Lovers & Gangsters (2026)', name: 'Lovers & Gangsters' });
    expect(results[4]).toMatchObject({ name: 'Concrete Market', original_name: 'Movie', year: 2025 });
    expect(results[5]).toMatchObject({ title: 'Devils Stay', year: null });
    expect(dramacoolResult({ title: 'No Address' }, ORIGIN)).toBeNull();
    expect(parseSearch('<p>Sorry, but nothing matched your search terms.</p>')).toEqual([]);
  });

  it('finds a later season under the series name and under its full name', () => {
    expect(dramacoolTitle('Love Wins All Season 2 (2026)')).toEqual({ name: 'Love Wins All', full_name: 'Love Wins All Season 2', other_name: null, year: 2026, season: 2 });
    expect(pickMatches(results, { name: 'love wins all', year: null }).matches.map((r: { year: number }) => r.year)).toEqual([2026, 2025]);
    expect(pickMatches(results, { name: 'love wins all season 2', year: null }).matches.map((r: { year: number }) => r.year)).toEqual([2026]);
    expect(pickMatches(results, { name: 'summer vacation', year: 2025 }).matches).toHaveLength(0);
    expect(seasonOfPage('https://dramacool9.com.ro/love-wins-all-season-2-2026')).toBe(2);
    expect(seasonOfPage('https://dramacool9.com.ro/love-wins-all-2025')).toBe(1);
    expect(decodeEntities('Iroha&#8217;s &amp; &#x41; &unknown;')).toBe('Iroha’s & A &unknown;');
  });

  it("lists only the episodes a title's own page links, on the site itself", () => {
    expect(parseEpisodes(TITLE_HTML, ORIGIN)).toEqual([
      { episode: 8, url: 'https://dramacool9.com.ro/summer-vacation-2026-episode-8.html' },
      { episode: 3, url: 'https://dramacool9.com.ro/summer-vacation-2026-episode-3.html' },
    ]);
    expect(parseEpisodes('<div id="all-episodes"></div><!--all-episodes-->', ORIGIN)).toEqual([]);
    expect(parseEpisodes('<p>no list</p>', ORIGIN)).toEqual([]);
  });

  it('asks for no page when the season is not the title\'s, and refuses a page that is not a title', async () => {
    expect(await dramacool.episodes(`${dramacool.origin}/love-wins-all-2025`, { season: 2, episode: 1 })).toEqual([]);
    await expect(dramacool.episodes('https://elsewhere.example/x-2025', { season: null, episode: 1 })).rejects.toThrow(/not a title page/);
    await expect(dramacool.episodes(`${dramacool.origin}/genre/youth`, { season: null, episode: 1 })).rejects.toThrow(/not a title page/);
  });

  it("reads what a title's own page says of it, for a title TMDB does not list", async () => {
    const PAGE = `
      <figure class="drama-thumbnail"><a href="https://dramacool9.com.ro/summer-vacation-2026" rel="bookmark" title="Summer Vacation (2026)">
        <img width="220" height="320" data-original="https://dramacool9.com.ro/wp-content/uploads/2026/10/PeXjdX_4f-220x320.jpg" class="lazy wp-post-image" alt="" /></a></figure>
      <div class="drama-details"><header class="entry-header"><h1>Summer Vacation (2026)</h1></header>
        <div class="synopsis"><span>Synopsis:</span><p></p><p>An ordinary girl &amp; her summer.</p></div>
        <p></p>
        <p><span>Also known as: </span><a href="https://dramacool9.com.ro/summer-vacation-2026" title="Yeoreumbanghak ">Yeoreumbanghak </a></p>
        <p class="country"><span>Country: </span> <a href="https://dramacool9.com.ro/country/south-korea" rel="tag">South Korea</a></p>
        <p class="status"><span>Status: </span>Ongoing</p>
        <p class="release-year"><span>Release Year: </span><a href="https://dramacool9.com.ro/release-year/2026" rel="tag">2026</a></p>
        <p class="genres"><span>Genres: </span><a href="/genre/drama" rel="tag">Drama</a>, <a href="/genre/sci-fi-fantasy" rel="tag">Sci-Fi &amp; Fantasy</a></p>
        <p class="starring"></p>
      </div>`;
    expect(parseDetails(PAGE, ORIGIN)).toEqual({
      poster_url: 'https://dramacool9.com.ro/wp-content/uploads/2026/10/PeXjdX_4f-220x320.jpg',
      overview: 'An ordinary girl & her summer.',
      country: 'South Korea',
      status: 'Ongoing',
      year: 2026,
      genres: ['Drama', 'Sci-Fi & Fantasy'],
      also_known: 'Yeoreumbanghak',
    });
    expect(parseDetails('<h1>Nothing here</h1>', ORIGIN)).toEqual({ poster_url: null, overview: null, country: null, status: null, year: null, genres: [], also_known: null });
    // A poster that is not an https address is not kept: the wall would load it.
    expect(parseDetails('<figure class="drama-thumbnail"><img data-original="javascript:alert(1)"></figure>', ORIGIN).poster_url).toBeNull();
    await expect(dramacool.details('https://elsewhere.example/x-2025')).rejects.toThrow(/not a title page/);
    await expect(dramacool.details(`${dramacool.origin}/x-2025-episode-1.html`)).rejects.toThrow(/not a title page/);
  });

  it("plays only an episode's page on the site itself", () => {
    expect(dramacool.titlePath(`${dramacool.origin}/summer-vacation-2026-episode-3.html`)).toBe('/summer-vacation-2026-episode-3.html');
    expect(dramacool.titlePath(`${dramacool.origin}/summer-vacation-2026`)).toBeNull();
    expect(dramacool.titlePath(`${dramacool.origin}/genre/x-episode-3.html`)).toBeNull();
    expect(dramacool.titlePath('https://elsewhere.example/summer-vacation-2026-episode-3.html')).toBeNull();
  });

  it('asks for the episode again when an advert took the tab, then starts the player in its frame', async () => {
    const pathname = '/summer-vacation-2026-episode-3.html';
    const frame = 'https://vidbasic.top/embed/e3meaiw4vgk';
    // The site's tab as each look finds it: a fresh tab on the home page twice, then the episode.
    const looks = [`${dramacool.origin}/`, `${dramacool.origin}/`, `${dramacool.origin}${pathname}`];
    const calls: string[] = [];
    const evalPage = async (expression: string, options: { frameMatch?: string; closeOtherTabs?: boolean } = {}) => {
      if (expression.startsWith('location.assign')) {
        calls.push(`assign ${expression.includes(JSON.stringify(pathname)) ? 'episode' : 'other'}${options.closeOtherTabs ? ' closing other tabs' : ''}`);
        return 'ok';
      }
      if (expression === FIND_FRAME_EXPRESSION) {
        const url = looks.shift() ?? `${dramacool.origin}${pathname}`;
        calls.push('look');
        return { url, frame: url.endsWith(pathname) ? frame : null, visible: true };
      }
      calls.push(`player in ${options.frameMatch}`);
      return { playing: true, position_s: 0, duration_s: 3530, muted: false };
    };
    const played = await dramacool.start({ evalPage, sleep: async () => undefined, pathname });
    expect(played).toMatchObject({ playing: true, duration_s: 3530 });
    expect(calls).toEqual(['look', 'look', 'assign episode closing other tabs', 'look', 'player in vidbasic\\.top']);

    // A page that never becomes the episode gives up and says where.
    const lost = await dramacool.start({ evalPage: async (e: string) => (e === FIND_FRAME_EXPRESSION ? { url: `${dramacool.origin}/`, frame: null, visible: true } : 'ok'), sleep: async () => undefined, pathname });
    expect(lost).toEqual({ playing: false, stage: 'no_player' });
  });

  it("ships expressions that parse, check the frame's address and press only the player's own play", () => {
    parses(FIND_FRAME_EXPRESSION);
    expect(FIND_FRAME_EXPRESSION).toContain('#video-frame');
    expect(FIND_FRAME_EXPRESSION).not.toMatch(/\.click\(\)/);
    const expression = dramacoolPlayer('https://vidbasic.top/embed/e3meaiw4vgk');
    parses(expression);
    expect(expression.match(/\w+\.click\(\)/g)).toEqual(['button.click()']);
    expect(expression).toContain('.jw-icon-display');
    expect(expression).toContain('"https://vidbasic.top/embed/e3meaiw4vgk"');
    expect(frameMatchOf('https://vidbasic.top/embed/e3meaiw4vgk')).toBe('vidbasic\\.top');
  });
});
