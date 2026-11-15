import { describe, expect, it } from 'vitest';
import { gatherCandidates, pickSeeds, rankKind, roundRobin, topGenres, type SeedTitle } from '../../../src/directStream/candidates.js';
import { TmdbError, type TitleKind, type TmdbCatalog, type TmdbSearchHit } from '../../../src/movies/tmdb.js';

const TODAY = '2026-11-15';
function hit(kind: TitleKind, tmdbId: number, releaseDate: string | null = '2020-01-01'): TmdbSearchHit {
  return { kind, tmdbId, title: `T${tmdbId}`, originalTitle: `T${tmdbId}`, releaseDate, year: 2020, overview: '', posterPath: null, popularity: 1 };
}
function seed(tmdbId: number, rating: number | null, finishedAt: string, genres: string[] = [], kind: TitleKind = 'movie'): SeedTitle {
  return { kind, tmdbId, rating, finishedAt, genres };
}

describe('candidates', () => {
  it('seeds: rated 4-5 first, then unrated by newest finish; 0-3 is no seed', () => {
    const seeds = pickSeeds([
      seed(1, null, '2026-01-01'),
      seed(2, 5, '2025-01-01'),
      seed(3, 3, '2026-06-01'),
      seed(4, null, '2026-09-01'),
      seed(5, 4, '2026-02-01'),
    ]);
    expect(seeds.map((s) => s.tmdbId)).toEqual([2, 5, 4, 1]);
    expect(topGenres([seed(1, null, '', ['Drama', 'Crime']), seed(2, null, '', ['Drama'])])).toEqual(['Drama', 'Crime']);
  });

  it('merges round-robin and keeps each title once', () => {
    expect(roundRobin([[1, 2, 3], [9, 2], [4]], String)).toEqual([1, 9, 4, 2, 3]);
  });

  it('ranks one kind across sources, dropping unreleased titles and the other kind', () => {
    const ranked = rankKind(
      'movie',
      {
        recommended: [[hit('movie', 10), hit('movie', 11)]],
        genre: [[hit('movie', 20, '2027-01-01')]],
        trending: [[hit('movie', 30), hit('tv', 31), hit('movie', 10)]],
        popular: [[hit('movie', 40, null)]],
      },
      TODAY,
    );
    expect(ranked).toEqual([
      { kind: 'movie', tmdbId: 10, source: 'recommended', rank: 0 },
      { kind: 'movie', tmdbId: 30, source: 'trending', rank: 1 },
      { kind: 'movie', tmdbId: 11, source: 'recommended', rank: 2 },
    ]);
  });

  it('reads recommendations per seed and the seeds\' genres, and survives one failing list', async () => {
    const calls: string[] = [];
    const tmdb: TmdbCatalog = {
      async list(name, kind, page = 1) {
        calls.push(`${name}:${kind}:${page}`);
        if (name === 'popular' && kind === 'tv') throw new TmdbError('http', 'TMDB /tv/popular returned 500', 500);
        return page === 1 ? [hit(kind, kind === 'movie' ? 100 : 200)] : [];
      },
      async genres(kind) {
        calls.push(`genres:${kind}`);
        return [{ id: 18, name: 'Drama' }];
      },
      async discoverByGenre(kind, id) {
        calls.push(`discover:${kind}:${id}`);
        return [hit(kind, kind === 'movie' ? 101 : 201)];
      },
      async recommendations(kind, id) {
        calls.push(`rec:${kind}:${id}`);
        return [hit(kind, 102)];
      },
    };
    const got = await gatherCandidates(tmdb, [seed(7, 5, '2026-01-01', ['Drama'])], TODAY);
    expect(calls).toContain('rec:movie:7');
    expect(calls).not.toContain('rec:tv:7');
    expect(calls).toContain('discover:movie:18');
    expect(got.entries.filter((e) => e.kind === 'movie').map((e) => [e.tmdbId, e.source])).toEqual([
      [102, 'recommended'],
      [101, 'genre'],
      [100, 'trending'],
    ]);
    expect(got.entries.filter((e) => e.kind === 'tv').map((e) => e.tmdbId)).toEqual([201, 200]);
    expect(got.errors).toHaveLength(2);
    expect(got.errors[0]).toContain('tv popular page 1');
  });
});
