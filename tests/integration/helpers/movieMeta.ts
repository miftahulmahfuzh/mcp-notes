import type { TitleMetadata } from '../../../src/movies/types.js';

/** A film with a studio, a cast member with a character name, a director, a writer and a producer. */
export function movieMeta(tmdbId: number): TitleMetadata {
  return {
    kind: 'movie',
    tmdbId,
    title: `Film ${tmdbId}`,
    originalTitle: `Film ${tmdbId}`,
    year: 2026,
    releaseDate: '2026-02-20',
    overview: `Synopsis of film ${tmdbId}.`,
    posterPath: `/poster-${tmdbId}.jpg`,
    backdropPath: null,
    runtimeMin: 110,
    genres: ['Thriller'],
    seasonCount: null,
    episodeCount: null,
    companies: [{ id: 3172, name: 'Blumhouse Productions', logoPath: null, originCountry: 'US' }],
    credits: [
      { personId: 9001, name: 'Glen Powell', profilePath: null, role: 'cast', character: 'Becket', job: null },
      { personId: 9002, name: 'John Patton Ford', profilePath: null, role: 'director', character: null, job: 'Director' },
      { personId: 9002, name: 'John Patton Ford', profilePath: null, role: 'writer', character: null, job: 'Screenplay' },
      { personId: 9003, name: 'Jason Blum', profilePath: null, role: 'producer', character: null, job: 'Producer' },
    ],
    episodes: [],
  };
}

/** A one-season series with three named episodes. */
export function tvMeta(tmdbId: number): TitleMetadata {
  return {
    kind: 'tv',
    tmdbId,
    title: `Series ${tmdbId}`,
    originalTitle: `Series ${tmdbId}`,
    year: 2025,
    releaseDate: '2025-03-30',
    overview: `Synopsis of series ${tmdbId}.`,
    posterPath: `/poster-${tmdbId}.jpg`,
    backdropPath: null,
    runtimeMin: 58,
    genres: ['Crime'],
    seasonCount: 1,
    episodeCount: 3,
    companies: [{ id: 4000, name: 'Paramount+', logoPath: null, originCountry: 'US' }],
    credits: [
      { personId: 9101, name: 'Ronan Bennett', profilePath: null, role: 'creator', character: null, job: 'Creator' },
      { personId: 9102, name: 'Tom Hardy', profilePath: null, role: 'cast', character: 'Harry Da Souza', job: null },
    ],
    episodes: [
      { season: 1, episode: 1, name: 'Stick or Twist', airDate: '2025-03-30', runtimeMin: 58, overview: null, stillPath: null },
      { season: 1, episode: 2, name: 'Alpha Male', airDate: '2025-04-06', runtimeMin: 55, overview: null, stillPath: null },
      { season: 1, episode: 3, name: 'Sweet Dreams', airDate: '2025-04-13', runtimeMin: 56, overview: null, stillPath: null },
    ],
  };
}
