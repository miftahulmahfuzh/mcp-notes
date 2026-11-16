import { describe, expect, it, vi } from 'vitest';
import { ANIME_MAP_RETRY_MS, ANIME_MAP_TTL_MS, ANIME_MAP_USER_AGENT, createAnimeMapper } from '../../../src/directStream/anime.js';

/** api.ani.zip's answer for One Piece, cut to what the mapper reads. */
const ONE_PIECE = {
  mappings: { anilist_id: 21, themoviedb_id: '37854', type: 'TV' },
  episodes: {
    '729': { airdate: '2016-02-14', absoluteEpisodeNumber: 729 },
    '730': { airdate: '2016-02-21', absoluteEpisodeNumber: 730 },
    S1: { airdate: '2016-02-21' },
    '787': { airdate: '2017-05-07' },
    '788': { airdate: '2017-05-14' },
    '900': { airdate: '2019-09-01' },
    '901': { airdate: '2019-09-01' },
  },
};
const FILM = { mappings: { anilist_id: 199, themoviedb_id: 129, type: 'MOVIE' }, episodes: { '1': { airdate: '2001-07-20' } } };

function fakeIndex(byId: Record<string, unknown>) {
  const asked: Array<{ url: string; userAgent: string | undefined }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, userAgent: (init?.headers as Record<string, string> | undefined)?.['user-agent'] });
    const id = new URL(url).searchParams.get('themoviedb_id') ?? '';
    const body = byId[id];
    if (body instanceof Error) throw body;
    if (typeof body === 'number') return new Response('nope', { status: body });
    return body === undefined ? new Response('"Not Found"', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  });
  return { fetch: impl as unknown as typeof fetch, asked, impl };
}

const quiet = { log: () => undefined };

describe('the anime mapper', () => {
  it('maps an episode by the day it aired to the AniList id and the episode counted through the series', async () => {
    const index = fakeIndex({ '37854': ONE_PIECE });
    const mapper = createAnimeMapper({ baseUrl: 'https://index.example/', fetch: index.fetch, ...quiet });
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2016-02-21' })).toEqual({ id: 21, episode: 730 });
    expect(index.asked).toEqual([{ url: 'https://index.example/mappings?themoviedb_id=37854', userAgent: ANIME_MAP_USER_AGENT }]);
    expect(ANIME_MAP_USER_AGENT).not.toMatch(/Mozilla|Chrome/);
  });

  it('takes the one episode that aired a day before or after when none aired on the day TMDB gives', async () => {
    const index = fakeIndex({ '37854': { ...ONE_PIECE, episodes: { ...ONE_PIECE.episodes, '10': { airdate: '2000-01-01' }, '11': { airdate: '2000-01-03' } } } });
    const mapper = createAnimeMapper({ baseUrl: 'https://index.example', fetch: index.fetch, ...quiet });
    // TMDB files One Piece 787 on Saturday 2017-05-06, the index on Sunday.
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2017-05-06' })).toEqual({ id: 21, episode: 787 });
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2017-05-15' })).toEqual({ id: 21, episode: 788 });
    // The exact day wins over a neighbour, two neighbours name no episode, and two days off is not a match.
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2017-05-07' })).toEqual({ id: 21, episode: 787 });
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2000-01-02' })).toBeNull();
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2017-05-09' })).toBeNull();
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: 'not a day' })).toBeNull();
  });

  it('maps nothing when no episode aired that day or the days beside it, or more than one did, and nothing without an air date', async () => {
    const mapper = createAnimeMapper({ baseUrl: 'https://index.example', fetch: fakeIndex({ '37854': ONE_PIECE }).fetch, ...quiet });
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2016-02-24' })).toBeNull();
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: '2019-09-01' })).toBeNull();
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 37854, airDate: null })).toBeNull();
  });

  it('maps a film to episode 1, and never a film to a series entry or a series to a film entry', async () => {
    const mapper = createAnimeMapper({ baseUrl: 'https://index.example', fetch: fakeIndex({ '129': FILM, '37854': ONE_PIECE }).fetch, ...quiet });
    expect(await mapper.lookup({ kind: 'movie', tmdbId: 129, airDate: null })).toEqual({ id: 199, episode: 1 });
    expect(await mapper.lookup({ kind: 'tv', tmdbId: 129, airDate: '2001-07-20' })).toBeNull();
    expect(await mapper.lookup({ kind: 'movie', tmdbId: 37854, airDate: null })).toBeNull();
  });

  it('answers null for a title the index does not know, another title\'s answer, or an answer in another shape', async () => {
    const index = fakeIndex({ '550': { mappings: { anilist_id: 21, themoviedb_id: '37854', type: 'TV' }, episodes: {} }, '551': { hello: 1 }, '552': { mappings: { themoviedb_id: '552' } } });
    const mapper = createAnimeMapper({ baseUrl: 'https://index.example', fetch: index.fetch, ...quiet });
    for (const tmdbId of [1396, 550, 551, 552]) expect(await mapper.lookup({ kind: 'tv', tmdbId, airDate: '2016-02-21' })).toBeNull();
  });

  it('asks once per title and keeps the answer, "not an anime" included; a failure is asked again sooner', async () => {
    let clock = 0;
    const index = fakeIndex({ '37854': ONE_PIECE, '9': new Error('socket hang up'), '10': 503 });
    const mapper = createAnimeMapper({ baseUrl: 'https://index.example', fetch: index.fetch, now: () => clock, ...quiet });
    const ask = async (tmdbId: number) => mapper.lookup({ kind: 'tv', tmdbId, airDate: '2016-02-21' });
    await ask(37854);
    await ask(37854);
    await ask(1396);
    await ask(1396);
    expect(index.impl).toHaveBeenCalledTimes(2);
    expect(await ask(9)).toBeNull();
    expect(await ask(10)).toBeNull();
    await ask(9);
    expect(index.impl).toHaveBeenCalledTimes(4);
    clock = ANIME_MAP_RETRY_MS + 1;
    await ask(9);
    await ask(10);
    await ask(37854);
    expect(index.impl).toHaveBeenCalledTimes(6);
    clock = ANIME_MAP_TTL_MS + 1;
    await ask(37854);
    expect(index.impl).toHaveBeenCalledTimes(7);
  });

  it('asks nothing when it is off', async () => {
    const index = fakeIndex({ '37854': ONE_PIECE });
    expect(await createAnimeMapper({ baseUrl: null, fetch: index.fetch }).lookup({ kind: 'tv', tmdbId: 37854, airDate: '2016-02-21' })).toBeNull();
    expect(index.impl).not.toHaveBeenCalled();
  });
});
