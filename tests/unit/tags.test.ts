import { describe, expect, it } from 'vitest'

import { normalizeTag, parseTags, tagSpans } from '../../src/notes/tags.js'

describe('parseTags', () => {
  it('finds the brief examples', () => {
    expect(parseTags('#v250 #from_phone #ai_image #seer')).toEqual(['v250', 'from_phone', 'ai_image', 'seer'])
  })

  it('lower-cases, dedupes, keeps first-appearance order', () => {
    expect(parseTags('#Seer then #v250 and #SEER again, #seer')).toEqual(['seer', 'v250'])
  })

  it('accepts hyphens and digits', () => {
    expect(parseTags('#mcp-notes #2026')).toEqual(['mcp-notes', '2026'])
  })

  it('stops at punctuation', () => {
    expect(parseTags('see #seer. and (#v250), #agentic!')).toEqual(['seer', 'v250', 'agentic'])
  })

  it('ignores a # inside a word', () => {
    expect(parseTags('C# and a#b and x_#y and 9#z')).toEqual([])
  })

  it('accepts a tag at the very start and after newlines or brackets', () => {
    expect(parseTags('#first\n#second\t(#third) [#fourth]')).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('ignores a bare # and markdown headings', () => {
    expect(parseTags('# Heading\n## Sub\n#')).toEqual([])
  })

  it('returns [] for an empty body', () => {
    expect(parseTags('')).toEqual([])
  })
})

describe('tagSpans', () => {
  it('reports every occurrence with offsets', () => {
    const body = 'x #Seer y #seer'
    expect(tagSpans(body)).toEqual([
      { start: 2, end: 7, tag: 'seer' },
      { start: 10, end: 15, tag: 'seer' },
    ])
    expect(body.slice(2, 7)).toBe('#Seer')
  })
})

describe('normalizeTag', () => {
  it.each([
    ['#Seer', 'seer'],
    ['seer', 'seer'],
    ['  V250 ', 'v250'],
    ['from_phone', 'from_phone'],
  ])('%j -> %s', (input, expected) => {
    expect(normalizeTag(input)).toBe(expected)
  })

  it.each(['', '#', 'two words', 'a.b'])('rejects %j', (input) => {
    expect(normalizeTag(input)).toBeNull()
  })
})
