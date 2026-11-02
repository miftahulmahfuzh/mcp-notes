import { describe, expect, it } from 'vitest'

import {
  findNodeIdCandidates,
  generateNodeId,
  InvalidNodeIdError,
  isValidNodeId,
  MAX_NODE_ID_CANDIDATES,
  NODE_ID_ALPHABET,
  NODE_ID_PATTERN,
  NODE_ID_SPACE,
  normalizeNodeId,
  parseNodeId,
} from '../../../src/sessions/ids.js'
import { ID_PATTERN } from '../../../src/notes/ids.js'

describe('generateNodeId', () => {
  it('produces the canonical XX-XX form', () => {
    for (let i = 0; i < 2000; i++) expect(generateNodeId()).toMatch(NODE_ID_PATTERN)
  })

  it('uses the injected random source', () => {
    const picks = [10, 0, 3, 16] // A 0 3 G
    let i = 0
    expect(generateNodeId(() => picks[i++]!)).toBe('A0-3G')
  })

  it('covers the whole alphabet', () => {
    expect(generateNodeId(() => 10)).toBe('AA-AA')
    expect(generateNodeId(() => NODE_ID_ALPHABET.length - 1)).toBe('ZZ-ZZ')
  })

  it('redraws all-digit ids', () => {
    const picks = [0, 1, 2, 3, 0, 1, 2, 35] // 01-23 (redrawn), then 01-2Z
    let i = 0
    expect(generateNodeId(() => picks[i++]!)).toBe('01-2Z')
    expect(() => generateNodeId(() => 0)).toThrow(RangeError)
  })

  it('never produces an all-digit id', () => {
    for (let i = 0; i < 2000; i++) expect(generateNodeId()).toMatch(/[A-Z]/)
  })

  it('throws on an out-of-range random source', () => {
    expect(() => generateNodeId(() => 36)).toThrow(RangeError)
  })

  it('reports the id space', () => {
    expect(NODE_ID_SPACE).toBe(1_679_616)
  })

  it('never has the note id shape', () => {
    for (let i = 0; i < 200; i++) expect(generateNodeId()).not.toMatch(ID_PATTERN)
  })
})

describe('normalizeNodeId / parseNodeId / isValidNodeId', () => {
  it('accepts any case, with or without the dash, trimmed', () => {
    expect(normalizeNodeId('a03g')).toBe('A0-3G')
    expect(normalizeNodeId('a0-3g')).toBe('A0-3G')
    expect(normalizeNodeId('  A0-3G ')).toBe('A0-3G')
  })

  it('rejects other shapes', () => {
    for (const bad of ['', 'A-B32', 'A0-3G1', 'A0--3G', 'A0_3G', 'Ä0-3G', 'A03']) {
      expect(normalizeNodeId(bad)).toBeNull()
    }
  })

  it('parseNodeId throws InvalidNodeIdError', () => {
    expect(parseNodeId('a03g')).toBe('A0-3G')
    // 'nope' would parse as NO-PE: case and the dash are optional in lookups.
    expect(() => parseNodeId('not-an-id')).toThrow(InvalidNodeIdError)
  })

  it('isValidNodeId accepts only the canonical form', () => {
    expect(isValidNodeId('A0-3G')).toBe(true)
    expect(isValidNodeId('a0-3g')).toBe(false)
    expect(isValidNodeId('A03G')).toBe(false)
  })
})

describe('findNodeIdCandidates', () => {
  it('finds upper-case ids in prose, deduped, in order', () => {
    expect(findNodeIdCandidates('compare A0-3G with B7-K2, then A0-3G again')).toEqual(['A0-3G', 'B7-K2'])
  })

  it('ignores lower case, all-digit pairs and ordinary hyphenated words', () => {
    expect(findNodeIdCandidates('see AB-CD')).toEqual(['AB-CD'])
    expect(findNodeIdCandidates('b7-k2, re-do the go-to step, pages 10-15')).toEqual([])
  })

  it('ignores paths, files, versions, times and ticket keys', () => {
    expect(findNodeIdCandidates('a/A0-3G A0-3G.md 1.12-RC1 10:30-11:00 UATP-2960')).toEqual([])
    expect(findNodeIdCandidates('done with A0-3G.')).toEqual(['A0-3G'])
  })

  it('ignores note ids, uuids, dates and longer hyphenated tokens', () => {
    const text = 'note A-B32, session d5c27d87-c38b-4fb8-83b5-1b1afaa5991f, on 2026-11-02, branch fix-ab-cd-ef'
    expect(findNodeIdCandidates(text)).toEqual([])
  })

  it('needs the dash in free text', () => {
    expect(findNodeIdCandidates('A03G')).toEqual([])
  })

  it('accepts punctuation and brackets around an id', () => {
    expect(findNodeIdCandidates('(A0-3G), "B1-C2". [C3-D4]')).toEqual(['A0-3G', 'B1-C2', 'C3-D4'])
  })

  it('returns at most MAX_NODE_ID_CANDIDATES (5)', () => {
    const many = Array.from({ length: 20 }, (_, i) => `A${i % 10}-${String.fromCharCode(65 + i)}1`).join(' ')
    expect(MAX_NODE_ID_CANDIDATES).toBe(5)
    expect(findNodeIdCandidates(many)).toHaveLength(MAX_NODE_ID_CANDIDATES)
  })

  it('returns [] for text without a candidate', () => {
    expect(findNodeIdCandidates('what did I do yesterday?')).toEqual([])
  })
})
