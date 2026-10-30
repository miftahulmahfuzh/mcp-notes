import { describe, expect, it } from 'vitest'

import {
  generateId,
  ID_ALPHABET,
  ID_PATTERN,
  ID_SPACE,
  InvalidIdError,
  isValidId,
  normalizeId,
  parseId,
} from '../../src/notes/ids.js'

describe('generateId', () => {
  it('produces the canonical X-XXX form', () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateId()).toMatch(ID_PATTERN)
    }
  })

  it('uses the injected random source', () => {
    const picks = [10, 11, 3, 2] // A, B, 3, 2
    let i = 0
    expect(generateId(() => picks[i++]!)).toBe('A-B32')
  })

  it('covers the whole alphabet in every position', () => {
    expect(generateId(() => 0)).toBe('0-000')
    expect(generateId(() => ID_ALPHABET.length - 1)).toBe('Z-ZZZ')
  })

  it('throws on an out-of-range random source', () => {
    expect(() => generateId(() => 36)).toThrow(RangeError)
  })

  it('reports the id space', () => {
    expect(ID_SPACE).toBe(1_679_616)
  })
})

describe('normalizeId', () => {
  it.each([
    ['A-B32', 'A-B32'],
    ['a-b32', 'A-B32'],
    ['ab32', 'A-B32'],
    ['AB32', 'A-B32'],
    ['  a-B32\n', 'A-B32'],
    ['0-000', '0-000'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeId(input)).toBe(expected)
  })

  it.each(['', 'A-B3', 'A-B321', 'AB-32', 'A--B32', 'A_B32', 'Ä-B32', 'A B32', '#A-B32'])(
    'rejects %j',
    (input) => {
      expect(normalizeId(input)).toBeNull()
    },
  )
})

describe('isValidId', () => {
  it('accepts only the canonical form', () => {
    expect(isValidId('A-B32')).toBe(true)
    expect(isValidId('a-b32')).toBe(false)
    expect(isValidId('AB32')).toBe(false)
  })
})

describe('parseId', () => {
  it('returns the canonical id', () => {
    expect(parseId('ab32')).toBe('A-B32')
  })

  it('throws InvalidIdError with the input attached', () => {
    try {
      parseId('not-an-id')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidIdError)
      expect((err as InvalidIdError).input).toBe('not-an-id')
    }
  })
})
