import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless'
import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import ws from 'ws'

import { EgressMeter } from './meter.js'
import { isQuotaError, QuotaBreaker } from './quota.js'
import * as schema from './schema.js'

/**
 * One Drizzle type for both drivers. The Neon websocket Pool is wire-compatible
 * with `pg.Pool` (same query/transaction API, `.rows` results), and both drizzle
 * adapters extend the same `PgDatabase`, so callers program against node-postgres
 * types regardless of which driver `createDb` picked. Both support `db.transaction`.
 */
export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }

export interface DbInstruments {
  meter: EgressMeter
  breaker: QuotaBreaker
}
const instruments = new WeakMap<object, DbInstruments>()
/** The egress meter and quota breaker attached to `db`; undefined when `NOTESD_EGRESS_METER=off`. */
export function dbInstruments(db: Db): DbInstruments | undefined {
  return instruments.get(db)
}

/**
 * Wraps `pool.query` and every client `pool.connect` hands out (transactions and drizzle sessions use
 * checked-out clients). `any` is confined here: pg and Neon pools only share this duck-typed surface.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function instrument(pool: pg.Pool | NeonPool, meter: EgressMeter, breaker: QuotaBreaker): void {
  const wrap = (target: { query: (...a: any[]) => any }): void => {
    const original = target.query.bind(target)
    target.query = (...args: any[]) => {
      if (typeof args[args.length - 1] === 'function') return original(...args) // callback style: untouched
      try {
        breaker.check()
      } catch (e) {
        return Promise.reject(e)
      }
      const text = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '')
      const out = original(...args)
      if (!out || typeof out.then !== 'function') return out
      return out.then(
        (res: { rows?: unknown[] }) => {
          meter.record(text, res?.rows)
          return res
        },
        (err: unknown) => {
          if (isQuotaError(err)) {
            if (!breaker.tripped) console.error('[notesd] Neon quota exceeded; pausing database queries for 30 min')
            breaker.trip()
          }
          throw err
        },
      )
    }
  }
  wrap(pool as never)
  const connect = (pool as any).connect.bind(pool)
  ;(pool as any).connect = (...a: any[]) => {
    if (typeof a[0] === 'function') return connect(...a)
    return connect().then((client: any) => {
      if (!client.__metered) {
        client.__metered = true
        wrap(client)
      }
      return client
    })
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Instruments `pool` unless `NOTESD_EGRESS_METER=off`; the pool must be wrapped before drizzle takes it. */
function meterPool(pool: pg.Pool | NeonPool): DbInstruments | undefined {
  if (process.env.NOTESD_EGRESS_METER === 'off') return undefined
  const ins = { meter: new EgressMeter(), breaker: new QuotaBreaker() }
  instrument(pool, ins.meter, ins.breaker)
  return ins
}

function register(db: Db, ins: DbInstruments | undefined): Db {
  if (ins) instruments.set(db, ins)
  return db
}

/** Postgres on a Neon host (`*.neon.tech`, pooled or direct). */
export function isNeonUrl(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase()
  return host === 'neon.tech' || host.endsWith('.neon.tech')
}

/**
 * Builds a Drizzle instance for `url`:
 * - `*.neon.tech` → `drizzle-orm/neon-serverless` over `@neondatabase/serverless`'s
 *   websocket Pool (`ws` as the WebSocket implementation). Interactive transactions work,
 *   unlike neon-http.
 * - anything else (the Docker Postgres used by `npm run test:int`) → `drizzle-orm/node-postgres`.
 *
 * No I/O happens here; the pool connects on the first query. Call `closeDb` on shutdown.
 */
export function createDb(url: string): Db {
  if (isNeonUrl(url)) {
    neonConfig.webSocketConstructor = ws
    const pool = new NeonPool({ connectionString: url })
    const ins = meterPool(pool)
    return register(drizzleNeon({ client: pool, schema }) as unknown as Db, ins)
  }
  const pool = new pg.Pool({ connectionString: url })
  const ins = meterPool(pool)
  return register(drizzleNodePg({ client: pool, schema }), ins)
}

/** Ends the underlying pool. Safe to call once per `createDb`. */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end()
}

export { schema }
