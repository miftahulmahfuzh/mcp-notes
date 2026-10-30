import { Pool as NeonPool } from '@neondatabase/serverless'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { closeDb, createDb, isNeonUrl } from '../../src/db/client.js'

describe('isNeonUrl', () => {
  it.each([
    ['postgresql://u:p@ep-x-123.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require', true],
    ['postgresql://u:p@ep-x-123-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb', true],
    ['postgres://postgres:pw@127.0.0.1:55433/mcp_notes_test', false],
    ['postgres://u:p@localhost/db', false],
    ['postgres://u:p@neon.tech.evil.example/db', false],
  ])('%s -> %s', (url, expected) => {
    expect(isNeonUrl(url)).toBe(expected)
  })
})

describe('createDb', () => {
  it('uses node-postgres for a non-Neon url, without connecting', async () => {
    const db = createDb('postgres://postgres:pw@127.0.0.1:1/none')
    expect(db.$client).toBeInstanceOf(pg.Pool)
    await closeDb(db)
  })

  it('uses the Neon websocket Pool for a Neon url, without connecting', async () => {
    const db = createDb('postgresql://u:p@ep-x-123.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require')
    expect(db.$client).toBeInstanceOf(NeonPool)
    await closeDb(db)
  })
})
