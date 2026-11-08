import { Pool as NeonPool } from '@neondatabase/serverless'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { closeDb, createDb, dbInstruments, isNeonUrl } from '../../src/db/client.js'

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

/* eslint-disable @typescript-eslint/no-explicit-any -- the stubs replace pg.Pool methods before createDb wraps them */
describe('createDb instrumentation', () => {
  const url = 'postgres://postgres:pw@127.0.0.1:1/none'

  it('attaches a meter and breaker, unless NOTESD_EGRESS_METER=off', async () => {
    const db = createDb(url)
    expect(dbInstruments(db)?.meter).toBeDefined()
    await closeDb(db)
    process.env.NOTESD_EGRESS_METER = 'off'
    try {
      const off = createDb(url)
      expect(dbInstruments(off)).toBeUndefined()
      await closeDb(off)
    } finally {
      delete process.env.NOTESD_EGRESS_METER
    }
  })

  it('records a query, trips on a quota answer and then rejects without querying', async () => {
    const calls: string[] = []
    const quota = Object.assign(new Error('Your account or project has exceeded the quota'), { code: '53000' })
    const origQuery = pg.Pool.prototype.query
    ;(pg.Pool.prototype as any).query = function (text: string) {
      calls.push(text)
      return text.startsWith('boom') ? Promise.reject(quota) : Promise.resolve({ rows: [{ a: 1 }, { a: 2 }] })
    }
    try {
      const db = createDb(url)
      const ins = dbInstruments(db)!
      await db.$client.query('select a from t')
      expect(ins.meter.snapshot().top[0]).toMatchObject({ label: 'select a from t', calls: 1, rows: 2 })
      await expect(db.$client.query('boom')).rejects.toBe(quota)
      expect(ins.breaker.tripped).toBe(true)
      await expect(db.$client.query('select a from t')).rejects.toThrow(/not querying/)
      expect(calls).toEqual(['select a from t', 'boom'])
      await closeDb(db)
    } finally {
      ;(pg.Pool.prototype as any).query = origQuery
    }
  })

  it('instruments a checked-out client once', async () => {
    let queries = 0
    const stubClient = {
      query: () => {
        queries += 1
        return Promise.resolve({ rows: [{ a: 1 }] })
      },
    }
    const origConnect = pg.Pool.prototype.connect
    ;(pg.Pool.prototype as any).connect = () => Promise.resolve(stubClient)
    try {
      const db = createDb(url)
      const ins = dbInstruments(db)!
      const c1 = (await db.$client.connect()) as any
      const c2 = (await db.$client.connect()) as any
      expect(c1).toBe(c2)
      await c1.query('select 1')
      expect(queries).toBe(1)
      expect(ins.meter.snapshot().top[0]).toMatchObject({ calls: 1, rows: 1 })
      await closeDb(db)
    } finally {
      ;(pg.Pool.prototype as any).connect = origConnect
    }
  })
})
