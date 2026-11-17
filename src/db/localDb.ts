import path from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { REPO_ROOT } from '../config.js'
import { closeDb, createDb, type Db } from './client.js'

export const LOCAL_DB_WAIT_ATTEMPTS = 30
export const LOCAL_DB_WAIT_MS = 2_000

export interface OpenLocalDbOptions {
  migrationsFolder?: string
  attempts?: number
  waitMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Opens this machine's own database and brings it to the current schema (drizzle/*.sql). The
 * database may come up after the daemon (a container at boot), so this waits for it; when it still
 * does not answer it throws, and systemd starts the daemon again: there is nothing to serve
 * without the database.
 */
export async function openLocalDb(url: string, options: OpenLocalDbOptions = {}): Promise<Db> {
  const migrationsFolder = options.migrationsFolder ?? path.join(REPO_ROOT, 'drizzle')
  const attempts = options.attempts ?? LOCAL_DB_WAIT_ATTEMPTS
  const waitMs = options.waitMs ?? LOCAL_DB_WAIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const db = createDb(url)
  let lastError: unknown = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      await db.execute(sql`select 1`)
      await migrate(db, { migrationsFolder })
      return db
    } catch (err) {
      lastError = err
      if (i < attempts - 1) await sleep(waitMs)
    }
  }
  await closeDb(db).catch(() => {})
  throw new Error(`the local database is not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}
