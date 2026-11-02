import { describe, expect, it } from 'vitest'

import { ccSessionEmbeddings, PARENT_LINK_SOURCES } from '../../../src/db/schema.js'
import { EMBEDDING_DIMENSIONS } from '../../../src/embeddings/constants.js'
import { PARENT_LINK_RANK } from '../../../src/sessions/types.js'

describe('session schema', () => {
  it('session vectors have the note embedding width', () => {
    expect(ccSessionEmbeddings.embedding.getSQLType()).toBe(`vector(${EMBEDDING_DIMENSIONS})`)
  })

  it('ranks every parent link source, env highest', () => {
    expect(Object.keys(PARENT_LINK_RANK).sort()).toEqual([...PARENT_LINK_SOURCES].sort())
    expect(PARENT_LINK_RANK.env).toBeGreaterThan(PARENT_LINK_RANK.hook)
    expect(PARENT_LINK_RANK.hook).toBeGreaterThan(PARENT_LINK_RANK.heuristic)
  })
})
