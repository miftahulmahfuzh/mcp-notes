import { Hono } from 'hono'

import { dbInstruments } from '../db/client.js'
import type { AppDeps } from '../deps.js'
import { loopbackReadGuard } from './sessionsApi.js'

/** GET /api/debug/egress: rows and approximate bytes per query shape since the daemon started. Loopback only. */
export function debugApiRoutes(deps: AppDeps): Hono {
  const r = new Hono()
  r.get('/api/debug/egress', loopbackReadGuard, (c) => {
    const ins = dbInstruments(deps.db)
    if (!ins) return c.json({ enabled: false })
    return c.json({
      enabled: true,
      quota: { tripped: ins.breaker.tripped, resumes_at: ins.breaker.resumesAt },
      ...ins.meter.snapshot(),
    })
  })
  return r
}
