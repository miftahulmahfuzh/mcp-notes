import { describe, expect, it, vi } from 'vitest';
import {
  LOOKUP_MAX_CANDIDATES,
  LOOKUP_MAX_NEAR_MISSES,
  lookupTitle,
  parseTitleRequest,
  shorterName,
  type LookupTmdb,
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

/** A TMDB whose series search answers by query (anything else: nothing) and that knows alternative titles by TMDB id. */
function namedTmdb(tvByQuery: Record<string, TmdbSearchHit[]>, alternatives: Record<number, string[]> = {}) {
  return {
    searchMovie: vi.fn(async () => []),
    searchTv: vi.fn(async (query: string) => tvByQuery[query] ?? []),
    alternativeTitles: vi.fn(async (_kind: 'movie' | 'tv', id: number) => alternatives[id] ?? []),
  } satisfies LookupTmdb;
}

const MICHIKO = hit({ kind: 'tv', title: 'Doctor-X: Surgeon Michiko Daimon', tmdbId: 46052, year: 2012, popularity: 9 });
const MAFIA = hit({ kind: 'tv', title: 'Doctor X: Mafia in White', originalTitle: '닥터X: 하얀 마피아의 시대', tmdbId: 293610, year: 2026, popularity: 5 });

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
    expect(await lookupTitle(words('saltburn'), { library: fakeLibrary([]), tmdb: fakeTmdb([hit({ title: 'Saltburn 2', tmdbId: 9 })]) })).toEqual({
      status: 'none',
      nearMisses: [expect.objectContaining({ title: 'Saltburn 2', tmdbId: 9 })],
    });
    const many = Array.from({ length: LOOKUP_MAX_CANDIDATES + 3 }, (_, i) => hit({ title: 'Pilot', tmdbId: i + 1 }));
    const r = await lookupTitle(words('pilot'), { library: fakeLibrary([]), tmdb: fakeTmdb(many) });
    expect(r.status === 'several' ? r.candidates.length : 0).toBe(LOOKUP_MAX_CANDIDATES);
  });

  it("matches a hit by one of TMDB's alternative titles when no name matches, reading only the top hits", async () => {
    const tmdb = namedTmdb({ 'doctor x': [MICHIKO, MAFIA] }, { 293610: ['Doctora X', 'Doctor X'], 46052: ['Doctor-X'] });
    const r = await lookupTitle(parseTitleRequest('doctor x', 2026, 'tv'), { library: fakeLibrary([]), tmdb });
    expect(r).toEqual({ status: 'one', candidate: expect.objectContaining({ tmdbId: 293610, title: 'Doctor X: Mafia in White' }), episode: null });
    // The 2012 series is outside the asked year: its alternative titles are never read.
    expect(tmdb.alternativeTitles.mock.calls).toEqual([['tv', 293610]]);
    // Without a year both series are called "Doctor X" somewhere: several, most popular first.
    const both = await lookupTitle(parseTitleRequest('doctor x', null, 'tv'), { library: fakeLibrary([]), tmdb });
    expect(both.status === 'several' ? both.candidates.map((c) => c.tmdbId) : []).toEqual([46052, 293610]);
  });

  it('never reads alternative titles when a name matches', async () => {
    const tmdb = namedTmdb({ 'doctor x: mafia in white': [MAFIA, MICHIKO] }, { 46052: ['Doctor X: Mafia in White'] });
    const r = await lookupTitle(parseTitleRequest('doctor x: mafia in white', null, 'tv'), { library: fakeLibrary([]), tmdb });
    expect(r.status === 'one' ? r.candidate.tmdbId : 0).toBe(293610);
    expect(tmdb.alternativeTitles).not.toHaveBeenCalled();
  });

  it('answers none with the search\'s other hits as near misses, carrying a stored title\'s movie id', async () => {
    const tmdb = namedTmdb({ 'doctor x mafia': [MAFIA, MICHIKO] });
    const library = fakeLibrary([stored({ kind: 'tv', title: 'Doctor X: Mafia in White', tmdbId: 293610, year: 2026, movieId: 'M-0DRX' })]);
    const r = await lookupTitle(parseTitleRequest('doctor x mafia', null, 'tv'), { library, tmdb });
    expect(r.status).toBe('none');
    if (r.status !== 'none') return;
    expect(r.nearMisses.map((c) => [c.tmdbId, c.movieId])).toEqual([[46052, null], [293610, 'M-0DRX']]);
  });

  it('searches a shorter form of the name for near misses when the full name finds nothing', async () => {
    const tmdb = namedTmdb({ 'Doctor X': [MICHIKO, MAFIA], doctor: [MICHIKO] });
    const r = await lookupTitle(parseTitleRequest('Doctor X: Age of the White Mafia', 2026, 'tv'), { library: fakeLibrary([]), tmdb });
    expect(r).toEqual({ status: 'none', nearMisses: [expect.objectContaining({ tmdbId: 293610 })] });
    expect(tmdb.searchTv.mock.calls.map(([q]) => q)).toEqual(['Doctor X: Age of the White Mafia', 'Doctor X']);
    // A near miss is never promoted to a match, whatever its alternative titles say.
    expect(tmdb.alternativeTitles).not.toHaveBeenCalled();
    const many = Array.from({ length: LOOKUP_MAX_NEAR_MISSES + 4 }, (_, i) => hit({ kind: 'tv', title: `Pilot ${i}`, tmdbId: i + 1 }));
    const capped = await lookupTitle(parseTitleRequest('pilot', null, 'tv'), { library: fakeLibrary([]), tmdb: namedTmdb({ pilot: many }) });
    expect(capped.status === 'none' ? capped.nearMisses.length : 0).toBe(LOOKUP_MAX_NEAR_MISSES);
  });

  it('shortens a name to the part before its subtitle, else to its first two words when it has four or more', () => {
    expect(shorterName('Doctor X: Age of the White Mafia')).toBe('Doctor X');
    expect(shorterName('Mission Impossible - Dead Reckoning')).toBe('Mission Impossible');
    expect(shorterName('doctor x age of the white mafia')).toBe('doctor x');
    expect(shorterName('Spider-Man')).toBeNull();
    expect(shorterName('the bear')).toBeNull();
  });

  it('finds a stored title by a name the owner gave it, without asking TMDB, and keeps the year rule', async () => {
    const library = fakeLibrary([stored({ kind: 'tv', title: 'Doctor X: Mafia in White', tmdbId: 293610, year: 2026, movieId: 'M-0DRX', aliases: ['doctorxageofthewhitemafia'] })]);
    const tmdb = namedTmdb({});
    const r = await lookupTitle(words('Doctor X: Age of the White Mafia'), { library, tmdb });
    expect(r).toEqual({ status: 'one', candidate: expect.objectContaining({ tmdbId: 293610, movieId: 'M-0DRX' }), episode: null });
    expect(tmdb.searchTv).not.toHaveBeenCalled();
    const wrongYear = await lookupTitle(words('doctor x age of the white mafia', 2012), { library, tmdb });
    expect(wrongYear.status).toBe('none');
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
