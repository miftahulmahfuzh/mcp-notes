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
      { kind: 'movie', tmdbId: 550, title: 'Fight Club', originalTitle: 'Fight Club', releaseDate: '1999-10-15', year: 1999, overview: '', posterPath: '/fc.jpg', popularity: 60 },
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

  it('answers no names for a title TMDB does not know', async () => {
    expect(await createTmdbClient(CONFIG, routedFetch({}).fetch).alternativeTitles('tv', 1)).toEqual([]);
  });
});
