import { describe, expect, it } from 'vitest';
import type { FallbackAnswer, NameFallback } from '../../../src/movies/fallback.js';
import { CONFIDENT_SCORE, matchTitle, scoreHit, searchQuery, titleSimilarity } from '../../../src/movies/match.js';
import { parseVideoPath } from '../../../src/movies/parse.js';
import { TmdbError, type TitleKind, type TmdbClient, type TmdbSearchHit } from '../../../src/movies/tmdb.js';

function hit(kind: TitleKind, tmdbId: number, title: string, year: number | null, originalTitle = title): TmdbSearchHit {
  return {
    kind,
    tmdbId,
    title,
    originalTitle,
    releaseDate: year === null ? null : `${year}-06-01`,
    year,
    overview: '',
    posterPath: null,
    popularity: 1,
  };
}

/** Search answers keyed "query|year" ("query|" without a year); anything else answers []. */
function fakeClient(table: { movie?: Record<string, TmdbSearchHit[]>; tv?: Record<string, TmdbSearchHit[]> }) {
  const calls: string[] = [];
  const unused = (): Promise<never> => Promise.reject(new Error('not used by matchTitle'));
  const client: TmdbClient = {
    async searchMovie(query, year = null) {
      calls.push(`movie:${query}|${year ?? ''}`);
      return table.movie?.[`${query}|${year ?? ''}`] ?? [];
    },
    async searchTv(query, year = null) {
      calls.push(`tv:${query}|${year ?? ''}`);
      return table.tv?.[`${query}|${year ?? ''}`] ?? [];
    },
    movieDetails: unused,
    tvDetails: unused,
    searchPerson: unused,
    personCredits: unused,
  };
  return { client, calls };
}

function fakeFallback(answer: FallbackAnswer | null) {
  const asked: Array<[string, string | null]> = [];
  const fallback: NameFallback = {
    model: 'fake',
    async resolve(fileName, dirName) {
      asked.push([fileName, dirName]);
      return answer;
    },
  };
  return { fallback, asked };
}

describe('the confidence rule', () => {
  it('titleSimilarity: equal after normalizing, equal without spaces, else word overlap', () => {
    expect(titleSimilarity('WALL-E', 'WALL·E')).toBe(1);
    expect(titleSimilarity('Nezha', 'Ne Zha')).toBe(0.95);
    expect(titleSimilarity('Rivals of Amziah King', 'The Rivals of Amziah King')).toBeCloseTo(0.889, 3);
    expect(titleSimilarity('Oldboy', 'Wall Street')).toBe(0);
    expect(titleSimilarity('', 'x')).toBe(0);
  });

  it('scoreHit: same year 1, a year off 0.9, further 0.5, a later season year free', () => {
    expect(scoreHit('Oldboy', 2003, hit('movie', 1, 'Oldboy', 2003))).toBe(1);
    expect(scoreHit('Oldboy', 2004, hit('movie', 1, 'Oldboy', 2003))).toBe(0.9);
    expect(scoreHit('Oldboy', 2013, hit('movie', 1, 'Oldboy', 2003))).toBe(0.5);
    expect(scoreHit('MobLand', 2026, hit('tv', 1, 'MobLand', 2025))).toBe(1);
    expect(scoreHit('Oldboy', null, hit('movie', 1, 'Oldboy', 2003))).toBe(1);
    expect(scoreHit('Oldboy', 2003, hit('movie', 1, 'Oldboy', null))).toBe(0.9);
    expect(scoreHit('Ne Zha', 2019, hit('movie', 1, 'Nezha 2019 dub', 2019, 'Ne Zha'))).toBe(1);
  });

  it('searchQuery drops stand-alone dashes', () => {
    expect(searchQuery('Batman - The Killing Joke')).toBe('Batman The Killing Joke');
    expect(searchQuery('WALL-E')).toBe('WALL-E');
  });
});

describe('matchTitle', () => {
  it('matches the file name title and year without asking the fallback', async () => {
    const { client, calls } = fakeClient({
      movie: {
        'How to Make a Killing|2026': [hit('movie', 467905, 'How to Make a Killing', 2026), hit('movie', 1210732, 'How to Make a Killing', 2025)],
      },
    });
    const { fallback, asked } = fakeFallback({ title: 'wrong', year: null, kind: null });
    const parsed = parseVideoPath('How.to.Make.a.Killing.2026.1080p.WEB-DL.x265.6CH-Pahe.in.mkv');
    expect(await matchTitle(parsed, client, fallback)).toEqual({
      kind: 'matched',
      tmdbKind: 'movie',
      tmdbId: 467905,
      confidence: 1,
      source: 'filename',
      matchedTitle: 'How to Make a Killing',
    });
    expect(calls).toEqual(['movie:How to Make a Killing|2026']);
    expect(asked).toEqual([]);
  });

  it('matches WALL-E to WALL·E and a dashed title to a colon title', async () => {
    const { client } = fakeClient({
      movie: {
        'WALL-E|2008': [hit('movie', 10681, 'WALL·E', 2008), hit('movie', 10673, 'Wall Street', 1987)],
        'Batman The Killing Joke|2016': [hit('movie', 382322, 'Batman: The Killing Joke', 2016)],
      },
    });
    expect(await matchTitle(parseVideoPath('Done/WALL-E.2008.1080p.UHD.BluRay.x265-Pahe.in.mkv'), client)).toMatchObject({
      kind: 'matched',
      tmdbId: 10681,
    });
    expect(
      await matchTitle(parseVideoPath('Pak Bernard/Batman - The Killing Joke (2016)/Batman - The Killing Joke.mkv'), client),
    ).toMatchObject({ kind: 'matched', tmdbId: 382322 });
  });

  it('searches series only for an episode', async () => {
    const { client, calls } = fakeClient({ tv: { 'MobLand|': [hit('tv', 247718, 'MobLand', 2025)] } });
    const parsed = parseVideoPath('Mobland S01 WEB-DL 1080p x265 6CH [Pahe.in]/MobLand.S01E05.Funeral.for.a.Friend.mkv');
    expect(await matchTitle(parsed, client)).toMatchObject({ kind: 'matched', tmdbKind: 'tv', tmdbId: 247718 });
    expect(calls).toEqual(['tv:MobLand|']);
  });

  it('searches again without the year when the year finds nothing', async () => {
    const { client, calls } = fakeClient({ movie: { 'Oldboy|': [hit('movie', 670, 'Oldboy', 2003)] } });
    expect(await matchTitle(parseVideoPath('Pak Bernard/Oldboy (2003)/Oldboy.mkv'), client)).toMatchObject({ tmdbId: 670 });
    expect(calls).toEqual(['movie:Oldboy|2003', 'movie:Oldboy|']);
  });

  it('takes TMDB order on a tie', async () => {
    const { client } = fakeClient({
      tv: { 'One Piece|': [hit('tv', 37854, 'One Piece', 1999), hit('tv', 111110, 'ONE PIECE', 2023)] },
    });
    expect(await matchTitle(parseVideoPath('Done/One Piece - 405 720p WEB-DL x264 2CH [Pahe.in].mkv'), client)).toMatchObject({
      tmdbKind: 'tv',
      tmdbId: 37854,
    });
  });

  it('with no hint tries films, then series', async () => {
    const { client, calls } = fakeClient({ tv: { 'Severance|': [hit('tv', 95396, 'Severance', 2022)] } });
    expect(await matchTitle(parseVideoPath('Severance.mkv'), client)).toMatchObject({ tmdbKind: 'tv', tmdbId: 95396 });
    expect(calls).toEqual(['movie:Severance|', 'tv:Severance|']);
  });

  it('asks the fallback when the best candidate is not confident, and matches its title', async () => {
    const { client } = fakeClient({
      movie: {
        'By Any Means|2026': [hit('movie', 1, 'By Any Means', 2008)],
        'Any Means Necessary|2026': [hit('movie', 2, 'Any Means Necessary', 2026)],
      },
    });
    const { fallback, asked } = fakeFallback({ title: 'Any Means Necessary', year: 2026, kind: 'movie' });
    const parsed = parseVideoPath('Done/By Any Means 2026 1080p WEB-DL x265 6CH-Pahe.in.mkv');
    expect(scoreHit(parsed.title, parsed.year, hit('movie', 1, 'By Any Means', 2008))).toBeLessThan(CONFIDENT_SCORE);
    expect(await matchTitle(parsed, client, fallback)).toMatchObject({
      kind: 'matched',
      tmdbId: 2,
      source: 'fallback',
    });
    expect(asked).toEqual([['By Any Means 2026 1080p WEB-DL x265 6CH-Pahe.in.mkv', 'Done']]);
  });

  it('asks the fallback when TMDB has no candidate at all', async () => {
    const { client } = fakeClient({ movie: { 'How to Make a Killing|2026': [hit('movie', 467905, 'How to Make a Killing', 2026)] } });
    const { fallback } = fakeFallback({ title: 'How to Make a Killing', year: 2026, kind: 'movie' });
    expect(await matchTitle(parseVideoPath('Hw.2.Mk.Killng.2026.1080p.mkv'), client, fallback)).toMatchObject({
      kind: 'matched',
      tmdbId: 467905,
      source: 'fallback',
    });
  });

  it('leaves the file unmatched when the fallback has no answer', async () => {
    const { client } = fakeClient({ movie: { 'By Any Means|2026': [hit('movie', 1, 'By Any Means', 2008)] } });
    const { fallback, asked } = fakeFallback(null);
    expect(await matchTitle(parseVideoPath('By Any Means 2026 1080p.mkv'), client, fallback)).toEqual({
      kind: 'none',
      reason: 'low_confidence',
    });
    expect(asked).toHaveLength(1);
  });

  it('leaves the file unmatched when the fallback title is not confident either', async () => {
    const { client } = fakeClient({});
    const { fallback } = fakeFallback({ title: 'Nothing Like It', year: 1999, kind: 'movie' });
    expect(await matchTitle(parseVideoPath('Done/docker_es/VID-20220222-WA0011.mp4'), client, fallback)).toEqual({
      kind: 'none',
      reason: 'no_match',
    });
  });

  it('without a fallback reports no_match and asks nothing more', async () => {
    const { client, calls } = fakeClient({});
    expect(await matchTitle(parseVideoPath('Done/docker_es/VID-20220222-WA0011.mp4'), client, null)).toEqual({
      kind: 'none',
      reason: 'no_match',
    });
    expect(calls).toEqual(['movie:VID-20220222-WA0011|', 'tv:VID-20220222-WA0011|']);
  });

  it('an empty title skips TMDB and goes straight to the fallback', async () => {
    const { client, calls } = fakeClient({});
    const { fallback, asked } = fakeFallback(null);
    expect(await matchTitle(parseVideoPath('[Pahe.in].mkv'), client, fallback)).toEqual({ kind: 'none', reason: 'no_match' });
    expect(calls).toEqual([]);
    expect(asked).toEqual([['[Pahe.in].mkv', null]]);
  });

  it('lets a TmdbError through without asking the fallback (the sync retries the file)', async () => {
    const { fallback, asked } = fakeFallback({ title: 'x', year: null, kind: null });
    const down: TmdbClient = {
      ...fakeClient({}).client,
      searchMovie: () => Promise.reject(new TmdbError('network', 'TMDB /search/movie could not be reached')),
    };
    await expect(matchTitle(parseVideoPath('Oldboy (2003)/Oldboy.mkv'), down, fallback)).rejects.toMatchObject({
      name: 'TmdbError',
      code: 'network',
    });
    expect(asked).toEqual([]);
  });
});
