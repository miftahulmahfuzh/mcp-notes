import { describe, expect, it } from 'vitest'

import { isQuotaError, QuotaBreaker, QuotaExceededError, QUOTA_COOLDOWN_MS } from '../../src/db/quota.js'

describe('isQuotaError', () => {
  it('is true for Neon quota answers', () => {
    expect(isQuotaError({ code: '53000', message: 'Your account or project has exceeded the quota. Upgrade your plan' })).toBe(true)
    expect(isQuotaError(new Error('Your account or project has exceeded the quota'))).toBe(true)
  })
  it('is false for other 53xxx and other errors', () => {
    expect(isQuotaError({ code: '53200', message: 'out of memory' })).toBe(false)
    expect(isQuotaError({ code: '53000', message: 'insufficient resources' })).toBe(false)
    expect(isQuotaError(new Error('connection refused'))).toBe(false)
    expect(isQuotaError(null)).toBe(false)
    expect(isQuotaError('boom')).toBe(false)
  })
})

describe('QuotaBreaker', () => {
  it('passes until tripped, throws while tripped, passes after the cool-down', () => {
    let t = 1_000
    const b = new QuotaBreaker(() => t)
    expect(() => b.check()).not.toThrow()
    expect(b.resumesAt).toBeNull()
    b.trip()
    expect(b.tripped).toBe(true)
    expect(b.resumesAt).toBe(new Date(1_000 + QUOTA_COOLDOWN_MS).toISOString())
    expect(() => b.check()).toThrow(QuotaExceededError)
    t += QUOTA_COOLDOWN_MS - 1
    expect(() => b.check()).toThrow(/not querying/)
    t += 1
    expect(() => b.check()).not.toThrow()
    expect(b.tripped).toBe(false)
  })
})
