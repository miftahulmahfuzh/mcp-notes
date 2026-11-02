import { describe, expect, it } from 'vitest'

import { clip, earliest, latest, mergeTranscriptPatch, normalizeCwd } from '../../../src/sessions/merge.js'
import { MAX_PROMPTS, type SessionRow, type TranscriptPatch } from '../../../src/sessions/types.js'

const T = (m: number) => new Date(Date.UTC(2026, 10, 1, 10, m))

function blankRow(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 's-1',
    nodeId: 'A0-3G',
    host: 'h',
    repo: null,
    cwd: null,
    branch: null,
    name: null,
    customTitle: null,
    aiTitle: null,
    firstPrompt: null,
    lastPrompt: null,
    entrypoint: null,
    version: null,
    startedAt: null,
    lastActiveAt: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    models: {},
    parentSessionId: null,
    parentLinkSource: null,
    tmux: null,
    transcriptPath: null,
    transcriptOffset: 0,
    transcriptSize: null,
    prompts: [],
    commits: [],
    filesEdited: [],
    planDocs: [],
    finalMessage: null,
    summary: null,
    summarySha: null,
    summarizedAt: null,
    createdAt: T(0),
    updatedAt: T(0),
    ...over,
  }
}

function patch(over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return { sessionId: 's-1', host: 'h', transcriptPath: '/t.jsonl', fromOffset: 0, toOffset: 10, size: 10, ...over }
}

describe('mergeTranscriptPatch', () => {
  it('adds deltas when appending', () => {
    const row = blankRow({ transcriptOffset: 10, inputTokens: 5, models: { m: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } })
    const set = mergeTranscriptPatch(row, patch({ fromOffset: 10, toOffset: 20, tokens: { inputTokens: 3 }, models: { m: { inputTokens: 3 }, n: { outputTokens: 2 } } }))
    expect(set.inputTokens).toBe(8)
    expect(set.models).toEqual({
      m: { inputTokens: 8, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      n: { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    expect(set.transcriptOffset).toBe(20)
  })

  it('replaces accumulators on a patch from offset 0', () => {
    const row = blankRow({ transcriptOffset: 50, inputTokens: 99, prompts: [{ text: 'old', at: null }], filesEdited: ['a'] })
    const set = mergeTranscriptPatch(row, patch({ tokens: { inputTokens: 4 }, prompts: [{ text: 'new', at: null }] }))
    expect(set.inputTokens).toBe(4)
    expect(set.prompts).toEqual([{ text: 'new', at: null }])
    expect(set.filesEdited).toEqual([])
  })

  it('never clobbers a scalar with null or undefined', () => {
    const row = blankRow({ name: 'impl-x-p1', cwd: '/w', repo: 'r' })
    const set = mergeTranscriptPatch(row, patch({ name: null, cwd: undefined }))
    expect(set).toMatchObject({ name: 'impl-x-p1', cwd: '/w', repo: 'r' })
  })

  it('keeps the earliest first prompt when appending, and the min/max times', () => {
    const row = blankRow({ transcriptOffset: 10, firstPrompt: 'first', startedAt: T(5), lastActiveAt: T(6) })
    const set = mergeTranscriptPatch(row, patch({ fromOffset: 10, firstPrompt: 'later', startedAt: T(1), lastActiveAt: T(9) }))
    expect(set.firstPrompt).toBe('first')
    expect(set.startedAt).toEqual(T(1))
    expect(set.lastActiveAt).toEqual(T(9))
  })

  it('treats costUsd as an absolute total', () => {
    const row = blankRow({ transcriptOffset: 10, costUsd: 1.5 })
    expect(mergeTranscriptPatch(row, patch({ fromOffset: 10, costUsd: 2.25 })).costUsd).toBe(2.25)
    expect(mergeTranscriptPatch(row, patch({ fromOffset: 10 })).costUsd).toBe(1.5)
  })

  it('caps prompts to the newest MAX_PROMPTS and drops blank ones', () => {
    const prompts = Array.from({ length: MAX_PROMPTS + 5 }, (_, i) => ({ text: `p${i}`, at: null }))
    const set = mergeTranscriptPatch(blankRow(), patch({ prompts: [...prompts, { text: '  ', at: null }] }))
    expect(set.prompts).toHaveLength(MAX_PROMPTS)
    expect(set.prompts[0]?.text).toBe('p5')
  })

  it('dedupes commits by sha and unions files', () => {
    const row = blankRow({ transcriptOffset: 10, commits: [{ sha: 'a', subject: 's', at: null }], filesEdited: ['x'] })
    const set = mergeTranscriptPatch(
      row,
      patch({ fromOffset: 10, commits: [{ sha: 'a', subject: 's2', at: null }, { sha: 'b', subject: 't', at: null }], filesEdited: ['x', 'y'] }),
    )
    expect(set.commits.map((c) => c.sha)).toEqual(['a', 'b'])
    expect(set.filesEdited).toEqual(['x', 'y'])
  })

  it('ignores negative or non-finite token deltas', () => {
    const set = mergeTranscriptPatch(blankRow(), patch({ tokens: { inputTokens: -3, outputTokens: Number.NaN } }))
    expect(set.inputTokens).toBe(0)
    expect(set.outputTokens).toBe(0)
  })
})

describe('helpers', () => {
  it('clip', () => {
    expect(clip('abc', 5)).toBe('abc')
    expect(clip('abcdef', 4)).toBe('abc…')
  })

  it('earliest / latest ignore missing values', () => {
    expect(earliest(null, T(1))).toEqual(T(1))
    expect(earliest(T(1), null)).toEqual(T(1))
    expect(latest(T(1), T(2))).toEqual(T(2))
  })

  it('normalizeCwd strips trailing slashes', () => {
    expect(normalizeCwd('/a/b/')).toBe('/a/b')
    expect(normalizeCwd('/a/b//')).toBe('/a/b')
    expect(normalizeCwd('/')).toBe('/')
    expect(normalizeCwd('///')).toBe('/')
  })
})
