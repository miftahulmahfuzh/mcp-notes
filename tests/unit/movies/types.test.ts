import { describe, expect, it } from 'vitest'

import { classifyReason, parseTitleId, titleId } from '../../../src/movies/types.js'

describe('title ids', () => {
  it('builds movie-<tmdb id> and tv-<tmdb id>', () => {
    expect(titleId('movie', 467905)).toBe('movie-467905')
    expect(titleId('tv', 247718)).toBe('tv-247718')
  })

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])('refuses TMDB id %s', (id) => {
    expect(() => titleId('movie', id)).toThrow(RangeError)
  })

  it('parses only ids titleId could have made', () => {
    expect(parseTitleId('tv-247718')).toEqual({ kind: 'tv', tmdbId: 247718 })
    for (const bad of ['movie-0', 'movie-01', 'film-1', 'tv-', 'TV-1', 'movie-1x', 'movie-2147483648']) {
      expect(parseTitleId(bad)).toBeNull()
    }
  })
})

describe('classifyReason', () => {
  it('leaves a TMDB outage pending and every other reason unmatched', () => {
    expect(classifyReason('tmdb_error')).toEqual({ status: 'pending', reason: 'tmdb_error' })
    expect(classifyReason('too_short')).toEqual({ status: 'unmatched', reason: 'too_short' })
    expect(classifyReason('no_tmdb_credentials')).toEqual({ status: 'unmatched', reason: 'no_tmdb_credentials' })
  })
})
