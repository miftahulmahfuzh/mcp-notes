import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless'
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless'
import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import ws from 'ws'

import * as schema from './schema.js'

/**
 * One Drizzle type for both drivers. The Neon websocket Pool is wire-compatible
 * with `pg.Pool` (same query/transaction API, `.rows` results), and both drizzle
 * adapters extend the same `PgDatabase`, so callers program against node-postgres
 * types regardless of which driver `createDb` picked. Both support `db.transaction`.
 */
export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }

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
    return drizzleNeon({ client: pool, schema }) as unknown as Db
  }
  const pool = new pg.Pool({ connectionString: url })
  return drizzleNodePg({ client: pool, schema })
}

/** Ends the underlying pool. Safe to call once per `createDb`. */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end()
}

export { schema }
