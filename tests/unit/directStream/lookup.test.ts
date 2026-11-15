import { describe, expect, it, vi } from 'vitest';
import {
  LOOKUP_MAX_CANDIDATES,
  lookupTitle,
  parseTitleRequest,
  type SeasonCount,
  type TitleCandidate,
  type TitleLibrary,
} from '../../../src/directStream/lookup.js';
import type { TmdbClient, TmdbSearchHit } from '../../../src/movies/tmdb.js';

const stored = (over: Partial<TitleCandidate> & Pick<TitleCandidate, 'title'>): TitleCandidate => ({
  kind: 'movie',
  tmdbId: 1,
  originalTitle: over.title,
  year: null,
  movieId: null,
  ...over,
});

function fakeLibrary(titles: TitleCandidate[], movieIds: Record<string, { kind: 'movie' | 'tv'; tmdbId: number; episode: { season: number; episode: number } | null }> = {}, seasons: SeasonCount[] = []): TitleLibrary {
  return {
    search: vi.fn(async (_name: string, kind: 'movie' | 'tv' | null) => titles.filter((t) => kind === null || t.kind === kind)),
    byKey: vi.fn(async (kind: 'movie' | 'tv', tmdbId: number) => titles.find((t) => t.kind === kind && t.tmdbId === tmdbId) ?? null),
    byMovieId: vi.fn(async (id: string) => movieIds[id] ?? null),
    seasons: vi.fn(async () => seasons),
  };
}

const hit = (over: Partial<TmdbSearchHit> & Pick<TmdbSearchHit, 'title' | 'tmdbId'>): TmdbSearchHit => ({
  kind: 'movie',
  originalTitle: over.title,
  releaseDate: null,
  year: null,
  overview: '',
  posterPath: null,
  popularity: 1,
  ...over,
});

function fakeTmdb(movies: TmdbSearchHit[], tv: TmdbSearchHit[] = []) {
  return {
    searchMovie: vi.fn(async () => movies),
    searchTv: vi.fn(async () => tv),
  } as unknown as TmdbClient & { searchMovie: ReturnType<typeof vi.fn>; searchTv: ReturnType<typeof vi.fn> };
}

const words = (title: string, year: number | null = null) => parseTitleRequest(title, year, null);

describe('lookupTitle', () => {
  it('reads a movie id and a title key as ids, and anything else as words', () => {
    expect(parseTitleRequest(' m-23t4 ', null, null)).toEqual({ by: 'id', text: 'm-23t4' });
    expect(parseTitleRequest('TV-1399', null, null)).toEqual({ by: 'id', text: 'TV-1399' });
    expect(parseTitleRequest('M3GAN', 2022, null)).toEqual({ by: 'words', name: 'M3GAN', year: 2022, kind: null });
  });

  it('answers from the stored titles without asking TMDB when one matches exactly', async () => {
    const tmdb = fakeTmdb([hit({ title: 'Saltburn', tmdbId: 930564, year: 2023 })]);
    const library = fakeLibrary([stored({ title: 'Saltburn', tmdbId: 930564, year: 2023, movieId: 'M-23T4' }), stored({ title: 'Saltburn Road', tmdbId: 5 })]);
    const r = await lookupTitle(words('saltburn'), { library, tmdb });
    expect(r).toEqual({ status: 'one', candidate: expect.objectContaining({ tmdbId: 930564, movieId: 'M-23T4' }), episode: null });
    expect(tmdb.searchMovie).not.toHaveBeenCalled();
  });

  it('asks TMDB for films and series when nothing stored matches, keeping exact names, most popular first', async () => {
    const tmdb = fakeTmdb(
      [hit({ title: 'Dune', tmdbId: 841, year: 1984, popularity: 10 }), hit({ title: 'Dune', tmdbId: 438631, year: 2021, popularity: 90 }), hit({ title: 'Dune: Part Two', tmdbId: 693134, year: 2024 })],
      [hit({ kind: 'tv', title: 'Dune', tmdbId: 1000, year: 2000, popularity: 5 })],
    );
    const r = await lookupTitle(words('dune'), { library: fakeLibrary([]), tmdb });
    expect(r.status).toBe('several');
    if (r.status !== 'several') return;
    expect(r.source).toBe('tmdb');
    expect(r.candidates.map((c) => [c.kind, c.tmdbId])).toEqual([['movie', 438631], ['movie', 841], ['tv', 1000]]);
  });

  it('narrows by year and kind', async () => {
    const tmdb = fakeTmdb([hit({ title: 'Dune', tmdbId: 841, year: 1984 }), hit({ title: 'Dune', tmdbId: 438631, year: 2021 })]);
    const r = await lookupTitle(parseTitleRequest('dune', 2021, 'movie'), { library: fakeLibrary([]), tmdb });
    expect(r).toEqual({ status: 'one', candidate: expect.objectContaining({ tmdbId: 438631, year: 2021, movieId: null }), episode: null });
    expect(tmdb.searchTv).not.toHaveBeenCalled();
  });

  it('answers none when no result has the name, and caps several at the limit', async () => {
    expect(await lookupTitle(words('saltburn'), { library: fakeLibrary([]), tmdb: fakeTmdb([hit({ title: 'Saltburn 2', tmdbId: 9 })]) })).toEqual({ status: 'none' });
    const many = Array.from({ length: LOOKUP_MAX_CANDIDATES + 3 }, (_, i) => hit({ title: 'Pilot', tmdbId: i + 1 }));
    const r = await lookupTitle(words('pilot'), { library: fakeLibrary([]), tmdb: fakeTmdb(many) });
    expect(r.status === 'several' ? r.candidates.length : 0).toBe(LOOKUP_MAX_CANDIDATES);
  });

  it('says tmdb_unavailable when nothing stored matches and there is no TMDB', async () => {
    await expect(lookupTitle(words('saltburn'), { library: fakeLibrary([]), tmdb: null })).rejects.toMatchObject({ code: 'tmdb_unavailable' });
  });

  it("takes an episode's movie id as that series and episode, and refuses an unknown one", async () => {
    const library = fakeLibrary([stored({ kind: 'tv', title: 'The Bear', tmdbId: 136315, movieId: 'M-0BEA' })], { 'M-0E23': { kind: 'tv', tmdbId: 136315, episode: { season: 2, episode: 3 } } });
    expect(await lookupTitle(parseTitleRequest('m-0e23', null, null), { library, tmdb: null })).toEqual({
      status: 'one',
      candidate: expect.objectContaining({ title: 'The Bear', kind: 'tv' }),
      episode: { season: 2, episode: 3 },
    });
    await expect(lookupTitle(parseTitleRequest('M-ZZZZ', null, null), { library, tmdb: null })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('takes a title key that is not stored as that TMDB title', async () => {
    const r = await lookupTitle(parseTitleRequest('movie-550', null, null), { library: fakeLibrary([]), tmdb: null });
    expect(r).toEqual({ status: 'one', candidate: { kind: 'movie', tmdbId: 550, title: 'movie-550', originalTitle: 'movie-550', year: null, movieId: null }, episode: null });
  });
});
