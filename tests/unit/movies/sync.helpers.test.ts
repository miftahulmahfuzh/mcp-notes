import { describe, expect, it } from 'vitest';
import { episodeFor, inDoneDir, isUnder, pairMoves, rootOf, tmdbUnreachable } from '../../../src/movies/sync.js';
import { TmdbError } from '../../../src/movies/tmdb.js';

describe('tmdbUnreachable (R2.3 breaker)', () => {
  it('trips on network, timeout, auth, rate limit and server errors', () => {
    expect(tmdbUnreachable(new TmdbError('network', 'x'))).toBe(true);
    expect(tmdbUnreachable(new TmdbError('timeout', 'x'))).toBe(true);
    for (const status of [401, 403, 429, 500, 503]) expect(tmdbUnreachable(new TmdbError('http', 'x', status))).toBe(true);
  });
  it('does not trip on one title\'s 404 or a malformed body', () => {
    expect(tmdbUnreachable(new TmdbError('http', 'x', 404))).toBe(false);
    expect(tmdbUnreachable(new TmdbError('bad_response', 'x'))).toBe(false);
  });
});

describe('inDoneDir', () => {
  it('is true when any folder below the root is a done dir, in any case', () => {
    expect(inDoneDir('Done/Film.mkv', ['Done'])).toBe(true);
    expect(inDoneDir('done/docker_es/clip.mp4', ['Done'])).toBe(true);
    expect(inDoneDir('Series/Watched/E01.mkv', ['Done', 'Watched'])).toBe(true);
  });
  it('ignores the file name itself and folders that only contain the word', () => {
    expect(inDoneDir('Done.mkv', ['Done'])).toBe(false);
    expect(inDoneDir('Not Done Yet/Film.mkv', ['Done'])).toBe(false);
    expect(inDoneDir('Done/Film.mkv', [])).toBe(false);
  });
});

describe('pairMoves', () => {
  const appeared = [
    { path: '/lib/Videos/Done/A.mkv', name: 'A.mkv', size: 100 },
    { path: '/lib/Videos/B.mkv', name: 'B.mkv', size: 7 },
  ];
  it('pairs a missing file with a new one of the same name and size', () => {
    const pairs = pairMoves([{ id: 1, name: 'A.mkv', size: 100 }], appeared);
    expect(pairs.map((p) => [p.row.id, p.file.path])).toEqual([[1, '/lib/Videos/Done/A.mkv']]);
  });
  it('does not pair on name alone, on unknown size, or twice', () => {
    expect(pairMoves([{ id: 2, name: 'B.mkv', size: 8 }], appeared)).toEqual([]);
    expect(pairMoves([{ id: 3, name: 'A.mkv', size: null }], appeared)).toEqual([]);
    const twice = pairMoves(
      [
        { id: 4, name: 'A.mkv', size: 100 },
        { id: 5, name: 'A.mkv', size: 100 },
      ],
      appeared,
    );
    expect(twice.map((p) => p.row.id)).toEqual([4]);
  });
});

describe('rootOf / isUnder', () => {
  it('finds the deepest configured root and never matches a sibling prefix', () => {
    expect(rootOf('/lib/Videos/a.mkv', ['/lib', '/lib/Videos'])).toBe('/lib/Videos');
    expect(rootOf('/lib/Videos2/a.mkv', ['/lib/Videos'])).toBeNull();
    expect(isUnder('/lib/Videos', '/lib/Videos')).toBe(true);
  });
});

describe('episodeFor', () => {
  it('stores no season or episode on a film', () => {
    expect(episodeFor('movie', { season: 1, episode: 2, absoluteEpisode: null }, null)).toEqual({ season: null, episode: null });
  });
  it('keeps the parsed season and episode of a series file', () => {
    expect(episodeFor('tv', { season: 1, episode: 3, absoluteEpisode: null }, null)).toEqual({ season: 1, episode: 3 });
  });
  it('leaves an absolute number unmapped without an episode list', () => {
    expect(episodeFor('tv', { season: null, episode: null, absoluteEpisode: 405 }, null)).toEqual({ season: null, episode: null });
  });
});
