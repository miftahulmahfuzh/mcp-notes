import { describe, expect, it } from 'vitest'

import { FINISHED_RATIO, fileState, reachedEnd, resumePosition, titleState } from '../../../src/movies/state.js'
import { WATCH_STATES, type FileStateInput, type PlayStateInput, type WatchState } from '../../../src/movies/types.js'

const DAY = new Date('2026-11-01T00:00:00.000Z')

function file(over: Partial<FileStateInput> = {}): FileStateInput {
  return { deletedAt: null, doneAt: null, watchedAt: null, durationS: 6000, ...over }
}

function play(positionS: number | null, durationS: number | null = null): PlayStateInput {
  return { positionS, durationS }
}

const CASES: Array<[string, FileStateInput, PlayStateInput | null, WatchState]> = [
  ['present, never played', file(), null, 'unwatched'],
  ['present, opened and left at 0', file(), play(0), 'unwatched'],
  ['present, partway', file(), play(1200), 'in_progress'],
  ['present, opened with the position unknown', file(), play(null), 'in_progress'],
  ['present, at exactly 90% of the file duration', file(), play(5400), 'finished'],
  ['present, just under 90%', file(), play(5399), 'in_progress'],
  ['the player duration wins over the file duration', file({ durationS: 6000 }), play(4500, 5000), 'finished'],
  ['no duration anywhere: a position never finishes the file', file({ durationS: null }), play(99_999), 'in_progress'],
  ['manual watched flag', file({ watchedAt: DAY }), null, 'finished'],
  ['done signal', file({ doneAt: DAY }), play(10), 'finished'],
  ['deleted at >= 90%', file({ deletedAt: DAY }), play(5900), 'finished'],
  ['deleted, manually flagged', file({ deletedAt: DAY, watchedAt: DAY }), play(100), 'finished'],
  ['deleted after a done signal', file({ deletedAt: DAY, doneAt: DAY }), null, 'finished'],
  ['deleted partway', file({ deletedAt: DAY }), play(3000), 'dropped'],
  ['deleted, never played', file({ deletedAt: DAY }), null, 'removed_unwatched'],
  ['deleted at 0%', file({ deletedAt: DAY }), play(0), 'removed_unwatched'],
  ['deleted, only opened with the position unknown', file({ deletedAt: DAY }), play(null), 'seen'],
]

describe('fileState (R3.4)', () => {
  it.each(CASES)('%s', (_name, f, p, expected) => {
    expect(fileState(f, p)).toBe(expected)
  })

  it('the table reaches every watch state', () => {
    expect(new Set(CASES.map((c) => c[3]))).toEqual(new Set(WATCH_STATES))
  })

  it('finishes at 90%', () => {
    expect(FINISHED_RATIO).toBe(0.9)
    expect(reachedEnd(file({ durationS: 1000 }), play(900))).toBe(true)
    expect(reachedEnd(file({ durationS: 1000 }), play(899.9))).toBe(false)
    expect(reachedEnd(file({ durationS: 0 }), play(10))).toBe(false)
  })
})

describe('resumePosition', () => {
  it('resumes a partway file at its last position', () => {
    expect(resumePosition(file(), play(1234.5))).toBe(1234.5)
  })

  it('starts from 0 when there is no position or the file is finished', () => {
    expect(resumePosition(file(), null)).toBe(0)
    expect(resumePosition(file(), play(null))).toBe(0)
    expect(resumePosition(file(), play(0))).toBe(0)
    expect(resumePosition(file(), play(5800))).toBe(0)
    expect(resumePosition(file({ watchedAt: DAY }), play(1200))).toBe(0)
  })
})

describe('titleState', () => {
  it('a movie takes the most-watched state of its files', () => {
    expect(titleState('movie', ['removed_unwatched', 'in_progress'])).toBe('in_progress')
    expect(titleState('movie', ['dropped', 'finished'])).toBe('finished')
    expect(titleState('movie', ['seen'])).toBe('seen')
    expect(titleState('movie', [])).toBe('unwatched')
  })

  it.each<[WatchState[], WatchState]>([
    [['finished', 'finished'], 'finished'],
    [['finished', 'unwatched'], 'in_progress'],
    [['dropped', 'unwatched'], 'in_progress'],
    [['in_progress', 'removed_unwatched'], 'in_progress'],
    [['unwatched', 'unwatched'], 'unwatched'],
    [['unwatched', 'removed_unwatched'], 'unwatched'],
    [['removed_unwatched'], 'removed_unwatched'],
    [['finished', 'removed_unwatched'], 'dropped'],
    [['finished', 'dropped'], 'dropped'],
    [['finished', 'seen'], 'seen'],
  ])('a series with episodes %j is %s', (states, expected) => {
    expect(titleState('tv', states)).toBe(expected)
  })

  it("the title's own watched flag finishes it", () => {
    expect(titleState('tv', ['unwatched'], true)).toBe('finished')
    expect(titleState('movie', [], true)).toBe('finished')
  })
})
