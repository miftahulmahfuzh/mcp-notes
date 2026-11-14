import { describe, expect, it } from 'vitest';
import {
  TmdbError,
  absoluteToSeasonEpisode,
  createTmdbClient,
  crewRole,
  posterUrl,
  type CreditMeta,
  type TmdbClientConfig,
} from '../../../src/movies/tmdb.js';
import { FIXTURE_API_BASE, fixtureFetch } from '../../helpers/tmdbFixtures.js';

const TOKEN_CONFIG: TmdbClientConfig = { token: 'test-token', apiKey: null, apiBase: FIXTURE_API_BASE };

function names(credits: CreditMeta[], role: CreditMeta['role']): string[] {
  return credits.filter((c) => c.role === role).map((c) => c.name);
}

function failingFetch(make: () => Promise<Response>): typeof fetch {
  return (() => make()) as typeof fetch;
}

describe('createTmdbClient: auth and search', () => {
  it('sends the read access token as a Bearer header and the year as a filter', async () => {
    const f = fixtureFetch();
    const hits = await createTmdbClient(TOKEN_CONFIG, f.fetch).searchMovie('How to Make a Killing', 2026);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.pathname).toBe('/search/movie');
    expect(f.calls[0]?.authorization).toBe('Bearer test-token');
    expect(f.calls[0]?.params.get('query')).toBe('How to Make a Killing');
    expect(f.calls[0]?.params.get('year')).toBe('2026');
    expect(f.calls[0]?.params.has('api_key')).toBe(false);
    expect(hits.map((h) => [h.kind, h.tmdbId, h.year, h.originalTitle])).toEqual([
      ['movie', 467905, 2026, 'How to Make a Killing'],
      ['movie', 1210732, 2025, 'Un ours dans le Jura'],
    ]);
    expect(hits[0]?.posterPath).toBe('/vxMeKC7o5Gi8IHMi6lUgsdprTqv.jpg');
  });

  it('falls back to the v3 api_key query parameter without a token', async () => {
    const f = fixtureFetch();
    await createTmdbClient({ token: null, apiKey: 'k3', apiBase: FIXTURE_API_BASE }, f.fetch).searchTv('MobLand');
    expect(f.calls[0]?.authorization).toBeNull();
    expect(f.calls[0]?.params.get('api_key')).toBe('k3');
    expect(f.calls[0]?.params.has('first_air_date_year')).toBe(false);
  });

  it('maps a series hit and answers [] for an unknown or empty query', async () => {
    const f = fixtureFetch();
    const client = createTmdbClient(TOKEN_CONFIG, f.fetch);
    const hits = await client.searchTv('MobLand', 2025);
    expect(hits).toEqual([
      expect.objectContaining({ kind: 'tv', tmdbId: 247718, title: 'MobLand', releaseDate: '2025-03-30', year: 2025 }),
    ]);
    expect(f.calls[0]?.params.get('first_air_date_year')).toBe('2025');
    expect(await client.searchMovie('No Such Film Anywhere')).toEqual([]);
    const before = f.calls.length;
    expect(await client.searchMovie('   ')).toEqual([]);
    expect(f.calls.length).toBe(before);
  });
});

describe('movieDetails', () => {
  it('returns poster, release date, synopsis, companies and every credit role', async () => {
    const meta = await createTmdbClient(TOKEN_CONFIG, fixtureFetch().fetch).movieDetails(467905);
    expect(meta).toMatchObject({
      kind: 'movie',
      tmdbId: 467905,
      title: 'How to Make a Killing',
      year: 2026,
      releaseDate: '2026-02-16',
      posterPath: '/vxMeKC7o5Gi8IHMi6lUgsdprTqv.jpg',
      runtimeMin: 105,
      genres: ['Comedy', 'Thriller', 'Crime'],
      seasonCount: null,
      episodes: [],
    });
    expect(meta.overview).toMatch(/^Disowned at birth/);
    expect(meta.companies.map((c, i) => [c.name, c.originCountry, i])).toEqual([
      ['StudioCanal', 'FR', 0],
      ['Blueprint Pictures', 'GB', 1],
    ]);
    expect(meta.credits.filter((c) => c.role === 'cast').map((c, i) => [c.name, c.character, i])).toEqual([
      ['Glen Powell', 'Becket Redfellow', 0],
      ['Margaret Qualley', 'Julia', 1],
      ['Jessica Henwick', 'Ruth', 2],
    ]);
    expect(names(meta.credits, 'director')).toEqual(['John Patton Ford']);
    expect(meta.credits.filter((c) => c.role === 'writer').map((c) => [c.name, c.job])).toEqual([
      ['Robert Hamer', 'Original Film Writer'],
      ['John Patton Ford', 'Writer, Screenplay'],
    ]);
    expect(meta.credits.filter((c) => c.role === 'producer').map((c) => [c.name, c.job])).toEqual([
      ['Graham Broadbent', 'Producer'],
      ['Peter Czernin', 'Producer'],
      ['Glen Powell', 'Executive Producer'],
    ]);
    expect(meta.credits.some((c) => c.name === 'Sam Grip')).toBe(false);
  });
});

describe('tvDetails', () => {
  it('returns creators, cast with characters, crew and the episodes of every season', async () => {
    const f = fixtureFetch();
    const meta = await createTmdbClient(TOKEN_CONFIG, f.fetch).tvDetails(247718);
    expect(meta).toMatchObject({
      kind: 'tv',
      tmdbId: 247718,
      title: 'MobLand',
      year: 2025,
      releaseDate: '2025-03-30',
      runtimeMin: null,
      seasonCount: 2,
      episodeCount: 5,
    });
    expect(meta.companies.map((c) => c.name)).toEqual(['MTV Entertainment Studios', 'Paramount Television Studios']);
    expect(meta.credits.filter((c) => c.role === 'cast').map((c) => [c.name, c.character])).toEqual([
      ['Tom Hardy', 'Harry Da Souza'],
      ['Pierce Brosnan', 'Conrad Harrigan'],
    ]);
    expect(names(meta.credits, 'creator')).toEqual(['Ronan Bennett']);
    expect(names(meta.credits, 'director')).toEqual(['Lawrence Gough', 'Guy Ritchie']);
    expect(names(meta.credits, 'writer')).toEqual(['Jez Butterworth']);
    expect(names(meta.credits, 'producer')).toEqual(['Guy Ritchie', 'Ron Burkle']);
    expect(meta.episodes.map((e) => [e.season, e.episode, e.name])).toEqual([
      [1, 1, 'Stick or Twist'],
      [1, 2, 'Jigsaw Puzzle'],
      [1, 3, 'Plan B'],
      [2, 1, 'I Wanna Be Your Dog'],
      [2, 2, 'Song 2'],
    ]);
    expect(meta.episodes[0]).toMatchObject({ airDate: '2025-03-30', runtimeMin: 60, stillPath: '/5IBWjTRedZgLgUEx5MYAq76FBZf.jpg' });
    expect(meta.episodes[2]?.overview).toBeNull();
    expect(f.calls.map((c) => c.pathname)).toEqual(['/tv/247718', '/tv/247718/season/1', '/tv/247718/season/2']);
    expect(f.calls[0]?.params.get('append_to_response')).toBe('aggregate_credits');
  });

  it('treats a listed season with no page (404) as empty', async () => {
    const base = fixtureFetch();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/tv/247718') {
        const res = await base.fetch(input, init);
        const json = (await res.json()) as { seasons: unknown[] };
        json.seasons.push({ season_number: 3, episode_count: 0 });
        return new Response(JSON.stringify(json), { status: 200 });
      }
      return base.fetch(input, init);
    }) as typeof fetch;
    const meta = await createTmdbClient(TOKEN_CONFIG, fetchImpl).tvDetails(247718);
    expect(meta.episodes).toHaveLength(5);
  });
});

describe('people', () => {
  it('searches a person and returns their films and series, cast and crew', async () => {
    const client = createTmdbClient(TOKEN_CONFIG, fixtureFetch().fetch);
    expect(await client.searchPerson('Margaret Qualley')).toEqual([
      { personId: 1392137, name: 'Margaret Qualley', knownFor: 'Acting', profilePath: '/r5WeMrU4YLJqRRE3joeOrBVicAH.jpg', popularity: 6.0101 },
    ]);
    const credits = await client.personCredits(1392137);
    expect(credits.map((c) => [c.kind, c.tmdbId, c.title, c.year, c.credit, c.character, c.job])).toEqual([
      ['movie', 933260, 'The Substance', 2024, 'cast', 'Sue', null],
      ['movie', 467905, 'How to Make a Killing', 2026, 'cast', 'Julia', null],
      ['tv', 59941, 'The Tonight Show Starring Jimmy Fallon', 2014, 'cast', 'Self - Guest', null],
      ['movie', 870518, 'Sanctuary', 2023, 'crew', null, 'Executive Producer'],
    ]);
    expect(credits[2]?.episodeCount).toBe(4);
  });
});

describe('errors', () => {
  it('without credentials rejects with no_credentials and makes no request', async () => {
    const f = fixtureFetch();
    const client = createTmdbClient({ token: null, apiKey: '  ', apiBase: FIXTURE_API_BASE }, f.fetch);
    await expect(client.movieDetails(467905)).rejects.toMatchObject({ name: 'TmdbError', code: 'no_credentials' });
    expect(f.calls).toHaveLength(0);
  });

  it('an unreachable TMDB is a network TmdbError', async () => {
    const client = createTmdbClient(TOKEN_CONFIG, failingFetch(() => Promise.reject(new TypeError('fetch failed'))));
    const err = await client.searchMovie('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmdbError);
    expect(err).toMatchObject({ code: 'network', status: null });
  });

  it('a timeout is a timeout TmdbError', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const client = createTmdbClient(TOKEN_CONFIG, failingFetch(() => Promise.reject(timeout)), { timeoutMs: 5 });
    await expect(client.searchTv('x')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a non-2xx answer is an http TmdbError with the status, and never carries the key', async () => {
    const client = createTmdbClient(
      { token: null, apiKey: 'secret-key', apiBase: FIXTURE_API_BASE },
      failingFetch(async () => new Response('{"status_code":25}', { status: 429 })),
    );
    const err = (await client.searchMovie('x').catch((e: unknown) => e)) as TmdbError;
    expect(err).toMatchObject({ code: 'http', status: 429 });
    expect(err.message).not.toContain('secret-key');
  });

  it('a 404 for a title is an http TmdbError', async () => {
    await expect(createTmdbClient(TOKEN_CONFIG, fixtureFetch().fetch).movieDetails(999999999)).rejects.toMatchObject({
      code: 'http',
      status: 404,
    });
  });

  it('a body that is not JSON, or not the expected shape, is bad_response', async () => {
    const html = createTmdbClient(TOKEN_CONFIG, failingFetch(async () => new Response('<html>blocked</html>', { status: 200 })));
    await expect(html.searchMovie('x')).rejects.toMatchObject({ code: 'bad_response' });
    const shape = createTmdbClient(TOKEN_CONFIG, failingFetch(async () => new Response('{"id":"nope"}', { status: 200 })));
    await expect(shape.movieDetails(1)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('helpers', () => {
  it('posterUrl joins base, size and path, and is null without a path', () => {
    expect(posterUrl('https://image.tmdb.org/t/p/', '/abc.jpg')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
    expect(posterUrl('https://image.tmdb.org/t/p', 'abc.jpg', 'w500')).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
    expect(posterUrl('https://image.tmdb.org/t/p', null)).toBeNull();
  });

  it('absoluteToSeasonEpisode counts listed episodes over seasons >= 1 and keeps TMDB numbers', () => {
    const episodes = [
      { season: 0, episode: 1 },
      { season: 2, episode: 62 },
      { season: 1, episode: 2 },
      { season: 1, episode: 1 },
      { season: 2, episode: 63 },
    ];
    expect(absoluteToSeasonEpisode(episodes, 1)).toEqual({ season: 1, episode: 1 });
    expect(absoluteToSeasonEpisode(episodes, 3)).toEqual({ season: 2, episode: 62 });
    expect(absoluteToSeasonEpisode(episodes, 4)).toEqual({ season: 2, episode: 63 });
    expect(absoluteToSeasonEpisode(episodes, 5)).toBeNull();
    expect(absoluteToSeasonEpisode(episodes, 0)).toBeNull();
  });

  it('crewRole keeps directors, authors and producers only', () => {
    expect(crewRole('Director', 'Directing')).toBe('director');
    expect(crewRole('Screenplay', 'Writing')).toBe('writer');
    expect(crewRole('Script Editor', 'Writing')).toBeNull();
    expect(crewRole('Executive Producer', 'Production')).toBe('producer');
    expect(crewRole('Casting', 'Production')).toBeNull();
  });
});
