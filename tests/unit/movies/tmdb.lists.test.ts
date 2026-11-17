import { describe, expect, it } from 'vitest';
import { createTmdbClient, DISCOVER_MIN_VOTES, type TmdbClientConfig } from '../../../src/movies/tmdb.js';

const CONFIG: TmdbClientConfig = { token: 't', apiKey: null, apiBase: 'http://tmdb.lists' };

/** Answers by pathname; records every URL. A path not in `routes` answers 404. */
function routedFetch(routes: Record<string, unknown>): { fetch: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    const body = routes[url.pathname];
    return body === undefined
      ? new Response('{"status_code":34}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch: impl as typeof fetch, urls };
}

const MOVIES = { results: [{ id: 550, title: 'Fight Club', original_title: 'Fight Club', release_date: '1999-10-15', overview: '', poster_path: '/fc.jpg', popularity: 60, media_type: 'movie' }] };
const SHOWS = { results: [{ id: 1399, name: 'Game of Thrones', original_name: 'Game of Thrones', first_air_date: '2011-04-17', overview: '', poster_path: null, popularity: 90 }] };

describe('TmdbCatalog', () => {
  it('reads this week\'s trending films and the popular series, one page at a time', async () => {
    const f = routedFetch({ '/trending/movie/week': MOVIES, '/tv/popular': SHOWS });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.list('trending', 'movie', 2)).toEqual([
      { kind: 'movie', tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club', releaseDate: '1999-10-15', year: 1999, overview: '', posterPath: '/fc.jpg', popularity: 60, originalLanguage: null },
    ]);
    expect(f.urls[0]?.searchParams.get('page')).toBe('2');
    const [show] = await client.list('popular', 'tv');
    expect(show).toMatchObject({ kind: 'tv', tmdbId: 1399, title: 'Game of Thrones', year: 2011 });
    expect(f.urls[1]?.searchParams.get('page')).toBe('1');
  });

  it('lists genres and discovers one genre by popularity with a vote floor and no adult titles', async () => {
    const f = routedFetch({ '/genre/movie/list': { genres: [{ id: 18, name: 'Drama' }] }, '/discover/movie': MOVIES });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.genres('movie')).toEqual([{ id: 18, name: 'Drama' }]);
    await client.discoverByGenre('movie', 18);
    const q = f.urls[1]!.searchParams;
    expect([q.get('with_genres'), q.get('sort_by'), q.get('vote_count.gte'), q.get('include_adult')]).toEqual([
      '18',
      'popularity.desc',
      String(DISCOVER_MIN_VOTES),
      'false',
    ]);
  });

  it('answers [] for the recommendations of a title TMDB does not know', async () => {
    const f = routedFetch({ '/movie/550/recommendations': MOVIES });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect((await client.recommendations('movie', 550)).map((h) => h.tmdbId)).toEqual([550]);
    expect(await client.recommendations('tv', 42)).toEqual([]);
  });

  it('rejects a list of the wrong shape as bad_response', async () => {
    const f = routedFetch({ '/trending/tv/week': { results: [{ id: 'x' }] } });
    await expect(createTmdbClient(CONFIG, f.fetch).list('trending', 'tv')).rejects.toMatchObject({ name: 'TmdbError', code: 'bad_response' });
  });
});

describe('TmdbTitleNames', () => {
  it("reads a film's and a series' alternative titles, leaving blanks out", async () => {
    const f = routedFetch({
      '/movie/550/alternative_titles': { id: 550, titles: [{ iso_3166_1: 'DE', title: 'Fight Club' }, { iso_3166_1: 'FR', title: '' }] },
      '/tv/293610/alternative_titles': { id: 293610, results: [{ iso_3166_1: 'US', title: 'Doctor X', type: '' }, { iso_3166_1: 'ES', title: 'Doctora X', type: '' }] },
    });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.alternativeTitles('movie', 550)).toEqual(['Fight Club']);
    expect(await client.alternativeTitles('tv', 293610)).toEqual(['Doctor X', 'Doctora X']);
  });

  it("reads a title's original language in one request, null when TMDB does not know it", async () => {
    const f = routedFetch({ '/tv/293610': { id: 293610, name: 'Doctor X: Mafia in White', original_language: 'ko' }, '/movie/1': { id: 1, title: 'X', original_language: '' } });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.originalLanguage('tv', 293610)).toBe('ko');
    expect(await client.originalLanguage('movie', 1)).toBeNull();
    expect(await client.originalLanguage('movie', 404)).toBeNull();
    expect(f.urls.map((u) => u.pathname)).toEqual(['/tv/293610', '/movie/1', '/movie/404']);
  });

  it("reads a title's IMDb id from its external ids, null when TMDB has none, a malformed one or does not know it", async () => {
    const f = routedFetch({
      '/movie/550/external_ids': { id: 550, imdb_id: 'tt0137523' },
      '/tv/1399/external_ids': { id: 1399, imdb_id: 'tt0944947', tvdb_id: 121361 },
      '/movie/1/external_ids': { id: 1, imdb_id: null },
      '/movie/2/external_ids': { id: 2, imdb_id: 'nm0000093' },
    });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.imdbId('movie', 550)).toBe('tt0137523');
    expect(await client.imdbId('tv', 1399)).toBe('tt0944947');
    expect(await client.imdbId('movie', 1)).toBeNull();
    expect(await client.imdbId('movie', 2)).toBeNull();
    expect(await client.imdbId('movie', 404)).toBeNull();
  });

  it('answers no names for a title TMDB does not know', async () => {
    expect(await createTmdbClient(CONFIG, routedFetch({}).fetch).alternativeTitles('tv', 1)).toEqual([]);
  });
});

describe('TmdbDiscovery', () => {
  it('discovers films by release window, language, company and service, newest first', async () => {
    const f = routedFetch({ '/discover/movie': { results: [{ ...MOVIES.results[0], original_language: 'en' }] }, '/discover/tv': SHOWS });
    const client = createTmdbClient(CONFIG, f.fetch);
    const [film] = await client.discover('movie', { dateFrom: '2026-01-01', dateTo: '2026-11-16', originalLanguage: 'es', companyIds: [3172, 68884], providerId: 99, watchRegion: 'US', sort: 'newest' });
    expect(film).toMatchObject({ kind: 'movie', tmdbId: 550, originalLanguage: 'en' });
    const q = f.urls[0]!.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      'primary_release_date.gte': '2026-01-01',
      'primary_release_date.lte': '2026-11-16',
      with_original_language: 'es',
      with_companies: '3172|68884',
      with_watch_providers: '99',
      watch_region: 'US',
      sort_by: 'primary_release_date.desc',
      include_adult: 'false',
      page: '1',
    });
  });

  it('discovers by genres that must all fit, keywords any of which may fit, and several original languages', async () => {
    const f = routedFetch({ '/discover/movie': MOVIES, '/search/keyword': { results: [{ id: 10391, name: 'mafia' }, { id: 155538, name: 'sicilian mafia' }] } });
    const client = createTmdbClient(CONFIG, f.fetch);
    await client.discover('movie', { originalLanguage: 'zh|cn', genreIds: [28, 35], keywordIds: [10391, 155538], companyIds: [] });
    expect(Object.fromEntries(f.urls[0]!.searchParams)).toEqual({
      with_original_language: 'zh|cn',
      with_genres: '28,35',
      with_keywords: '10391|155538',
      sort_by: 'popularity.desc',
      include_adult: 'false',
      page: '1',
    });
    expect(await client.searchKeyword(' mafia ')).toEqual([{ id: 10391, name: 'mafia', country: null }, { id: 155538, name: 'sicilian mafia', country: null }]);
    expect(f.urls[1]!.searchParams.get('query')).toBe('mafia');
    expect(await client.searchKeyword(' ')).toEqual([]);
  });

  it('discovers series by first air date and popularity, and sends no region without a service', async () => {
    const f = routedFetch({ '/discover/tv': SHOWS });
    const client = createTmdbClient(CONFIG, f.fetch);
    await client.discover('tv', { dateFrom: '2026-01-01', dateTo: null, originalLanguage: 'es', watchRegion: 'US' });
    expect(Object.fromEntries(f.urls[0]!.searchParams)).toEqual({
      'first_air_date.gte': '2026-01-01',
      with_original_language: 'es',
      sort_by: 'popularity.desc',
      include_adult: 'false',
      page: '1',
    });
  });

  it('searches companies and lists a region\'s streaming services, most prominent first', async () => {
    const f = routedFetch({
      '/search/company': { results: [{ id: 3172, name: 'Blumhouse Productions', origin_country: 'US', logo_path: null }, { id: 9, name: 'Blumhouse Television', origin_country: '' }] },
      '/watch/providers/movie': { results: [{ provider_id: 99, provider_name: 'Shudder', display_priority: 30 }, { provider_id: 8, provider_name: 'Netflix', display_priority: 1 }] },
    });
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.searchCompany(' blumhouse ')).toEqual([
      { id: 3172, name: 'Blumhouse Productions', country: 'US' },
      { id: 9, name: 'Blumhouse Television', country: null },
    ]);
    expect(f.urls[0]!.searchParams.get('query')).toBe('blumhouse');
    expect(await client.searchCompany('  ')).toEqual([]);
    expect(await client.watchProviders('movie', 'US')).toEqual([
      { id: 8, name: 'Netflix', country: null },
      { id: 99, name: 'Shudder', country: null },
    ]);
    expect(f.urls[1]!.searchParams.get('watch_region')).toBe('US');
    expect(f.urls).toHaveLength(2);
  });
});

describe('TmdbImdbLookup', () => {
  const find = (body: unknown) => createTmdbClient(CONFIG, routedFetch({ '/find/tt0137523': body }).fetch);

  it('finds a film, a series, and the series of an episode id, by IMDb id', async () => {
    expect(await find({ movie_results: [{ id: 550 }], tv_results: [], tv_episode_results: [] }).findByImdb('tt0137523')).toEqual({ kind: 'movie', tmdbId: 550 });
    expect(await find({ movie_results: [], tv_results: [{ id: 1399 }] }).findByImdb('tt0137523')).toEqual({ kind: 'tv', tmdbId: 1399 });
    expect(await find({ movie_results: [], tv_results: [], tv_episode_results: [{ show_id: 7 }] }).findByImdb('tt0137523')).toEqual({ kind: 'tv', tmdbId: 7 });
  });

  it('answers null for an id TMDB does not hold, a 404 and a malformed id (asked of nobody)', async () => {
    expect(await find({ movie_results: [], tv_results: [], tv_episode_results: [] }).findByImdb('tt0137523')).toBeNull();
    const f = routedFetch({});
    const client = createTmdbClient(CONFIG, f.fetch);
    expect(await client.findByImdb('tt0000001')).toBeNull();
    expect(await client.findByImdb('not-an-id')).toBeNull();
    expect(f.urls.map((u) => u.pathname)).toEqual(['/find/tt0000001']);
  });

  it('asks with external_source=imdb_id', async () => {
    const f = routedFetch({ '/find/tt0137523': { movie_results: [] } });
    await createTmdbClient(CONFIG, f.fetch).findByImdb('tt0137523');
    expect(f.urls[0]?.searchParams.get('external_source')).toBe('imdb_id');
  });
});
