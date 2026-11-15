import { describe, expect, it } from 'vitest'

import { classifyReason, parseTitleId, streamSlot, titleId } from '../../../src/movies/types.js'

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

describe('streamSlot', () => {
  it('records a film as null/null on a play and 0/0 on a source row', () => {
    expect(streamSlot({ kind: 'movie', tmdbId: 550 })).toEqual({
      titleId: 'movie-550',
      play: { season: null, episode: null },
      source: { season: 0, episode: 0 },
    })
  })

  it('keeps an episode, specials included', () => {
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 1, episode: 2 })).toEqual({
      titleId: 'tv-247718',
      play: { season: 1, episode: 2 },
      source: { season: 1, episode: 2 },
    })
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 0, episode: 3 })?.source).toEqual({ season: 0, episode: 3 })
  })

  it('has no slot for a series without a whole episode', () => {
    expect(streamSlot({ kind: 'tv', tmdbId: 247718 })).toBeNull()
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 1 })).toBeNull()
    expect(streamSlot({ kind: 'tv', tmdbId: 247718, season: 1, episode: 0 })).toBeNull()
  })

  it('refuses a bad TMDB id', () => {
    expect(() => streamSlot({ kind: 'movie', tmdbId: 0 })).toThrow(RangeError)
  })
})
