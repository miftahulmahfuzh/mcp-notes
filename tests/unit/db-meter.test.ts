import { describe, expect, it } from 'vitest'

import { EgressMeter, sqlLabel } from '../../src/db/meter.js'

describe('sqlLabel', () => {
  it('collapses whitespace and trims', () => {
    expect(sqlLabel('  select  *\n from   notes\twhere id = $1 ')).toBe('select * from notes where id = $1')
  })
  it('cuts at 100 characters', () => {
    expect(sqlLabel('x'.repeat(300))).toHaveLength(100)
  })
})

describe('EgressMeter', () => {
  it('counts calls, rows and bytes per label and orders by bytes', () => {
    const m = new EgressMeter(() => 42)
    m.record('select a from small', [{ a: 1 }])
    m.record('select b from big', [{ b: 'x'.repeat(500) }, { b: 'y'.repeat(500) }])
    m.record('select b from big', [{ b: 'z'.repeat(500) }])
    const s = m.snapshot()
    expect(s.top.map((t) => t.label)).toEqual(['select b from big', 'select a from small'])
    expect(s.top[0]).toMatchObject({ calls: 2, rows: 3, lastAt: 42 })
    expect(s.totalCalls).toBe(3)
    expect(s.totalRows).toBe(4)
    expect(s.totalBytes).toBe(s.top[0]!.bytes + s.top[1]!.bytes)
  })

  it('counts a call with no rows as zero bytes', () => {
    const m = new EgressMeter()
    m.record('update t set a = 1', [])
    m.record('update t set a = 1', undefined)
    expect(m.snapshot().top[0]).toMatchObject({ calls: 2, rows: 0, bytes: 0 })
  })

  it('limits the snapshot', () => {
    const m = new EgressMeter()
    for (let i = 0; i < 5; i++) m.record(`select ${i}`, [{ i }])
    expect(m.snapshot(2).top).toHaveLength(2)
  })

  it('formats a summary line', () => {
    const m = new EgressMeter()
    m.record('select 1', [{ a: 1 }])
    expect(m.summaryLine()).toMatch(/^\[notesd\] egress since \S+: 0\.0 MB in 1 calls; top: select 1 0\.0 MB \(1 calls\)$/)
  })
})
