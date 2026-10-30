import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { noteEmbeddings } from '../../src/db/schema.js'
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_CHARS,
  EMBEDDING_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
} from '../../src/embeddings/constants.js'
import { toVectorLiteral } from '../../src/embeddings/repo.js'
import {
  bodySha256,
  clampError,
  embedInput,
  embeddingState,
  retryDelayMs,
  type StoredEmbedding,
} from '../../src/embeddings/state.js'

const M = EMBEDDING_MODEL

function stored(body: string, over: Partial<StoredEmbedding> = {}): StoredEmbedding {
  return { bodySha256: bodySha256(body), model: M, hasVector: true, attempts: 0, ...over }
}

describe('embedding constants', () => {
  it('match run-insights and the schema column width', () => {
    expect(EMBEDDING_MODEL).toBe('openai/text-embedding-3-small')
    expect(EMBEDDING_DIMENSIONS).toBe(1536)
    expect(EMBEDDING_MAX_CHARS).toBe(8000)
    expect(OPENROUTER_EMBEDDINGS_URL).toBe('https://openrouter.ai/api/v1/embeddings')
    expect(noteEmbeddings.embedding.getSQLType()).toBe(`vector(${EMBEDDING_DIMENSIONS})`)
  })
})

describe('bodySha256', () => {
  it('is the hex sha256 of the UTF-8 bytes', () => {
    expect(bodySha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(bodySha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const emoji = 'deploy 🚀 done'
    expect(bodySha256(emoji)).toBe(createHash('sha256').update(Buffer.from(emoji, 'utf8')).digest('hex'))
  })

  it('distinguishes CRLF from LF and trailing whitespace', () => {
    expect(bodySha256('a\r\nb')).not.toBe(bodySha256('a\nb'))
    expect(bodySha256('a ')).not.toBe(bodySha256('a'))
  })
})

describe('embedInput', () => {
  it('trims and returns null for blank bodies', () => {
    expect(embedInput('  hello \n')).toBe('hello')
    expect(embedInput('')).toBeNull()
    expect(embedInput(' \n\t\r ')).toBeNull()
    expect(embedInput(' 　﻿ ')).toBeNull()
  })

  it('clamps to EMBEDDING_MAX_CHARS without a marker', () => {
    const long = 'x'.repeat(EMBEDDING_MAX_CHARS + 50)
    expect(embedInput(long)).toBe('x'.repeat(EMBEDDING_MAX_CHARS))
    expect(embedInput(`  ${'y'.repeat(EMBEDDING_MAX_CHARS)}  `)).toBe('y'.repeat(EMBEDDING_MAX_CHARS))
  })

  it('never ends on half a surrogate pair', () => {
    const body = 'a'.repeat(EMBEDDING_MAX_CHARS - 1) + '🚀tail'
    const out = embedInput(body)
    expect(out).toBe('a'.repeat(EMBEDDING_MAX_CHARS - 1))
  })
})

describe('embeddingState', () => {
  it('is none for blank bodies whatever is stored', () => {
    expect(embeddingState('   ', null, M)).toBe('none')
    expect(embeddingState('', stored('old'), M)).toBe('none')
  })

  it('is missing without a row', () => {
    expect(embeddingState('hello', null, M)).toBe('missing')
  })

  it('is current when hash and model match and a vector exists', () => {
    expect(embeddingState('hello', stored('hello'), M)).toBe('current')
  })

  it('is stale on a body change, including whitespace-only changes', () => {
    expect(embeddingState('hello!', stored('hello'), M)).toBe('stale')
    expect(embeddingState('hello\r\n', stored('hello\n'), M)).toBe('stale')
  })

  it('is stale on a model change, even for a failed row', () => {
    expect(embeddingState('hello', stored('hello', { model: 'other/model' }), M)).toBe('stale')
    expect(embeddingState('hello', stored('hello', { model: 'other/model', hasVector: false }), M)).toBe('stale')
  })

  it('is failed when the row for this body has no vector', () => {
    expect(embeddingState('hello', stored('hello', { hasVector: false, attempts: 2 }), M)).toBe('failed')
  })

  it('prefers stale over failed when the body changed after a failure', () => {
    expect(embeddingState('new', stored('old', { hasVector: false, attempts: 3 }), M)).toBe('stale')
  })
})

describe('retryDelayMs', () => {
  it('doubles from 30 s and caps at 1 h', () => {
    expect(retryDelayMs(1)).toBe(30_000)
    expect(retryDelayMs(2)).toBe(60_000)
    expect(retryDelayMs(3)).toBe(120_000)
    expect(retryDelayMs(7)).toBe(1_920_000)
    expect(retryDelayMs(8)).toBe(3_600_000)
    expect(retryDelayMs(1000)).toBe(3_600_000)
  })

  it('treats 0, negatives and NaN as the first attempt', () => {
    expect(retryDelayMs(0)).toBe(30_000)
    expect(retryDelayMs(-5)).toBe(30_000)
    expect(retryDelayMs(Number.NaN)).toBe(30_000)
  })
})

describe('clampError', () => {
  it('redacts keys and bearer tokens', () => {
    const out = clampError('401 for Bearer sk-or-v1-abcDEF123 and key sk-or-v1-xyz_9')
    expect(out).not.toContain('sk-or-')
    expect(out).toContain('[redacted]')
  })

  it('collapses whitespace and caps at 500 chars', () => {
    expect(clampError('a\n\n  b\tc')).toBe('a b c')
    expect(clampError('e'.repeat(2000))).toHaveLength(500)
  })
})

describe('toVectorLiteral', () => {
  it('is JSON.stringify of the numbers', () => {
    expect(toVectorLiteral([0.5, -1, 0])).toBe('[0.5,-1,0]')
  })

  it('rejects non-finite values', () => {
    expect(() => toVectorLiteral([0, Number.NaN])).toThrow(/non-finite/)
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(/non-finite/)
  })
})
