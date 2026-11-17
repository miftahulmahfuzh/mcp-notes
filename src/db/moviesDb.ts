import path from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { REPO_ROOT } from '../config.js'
import { createDb, isNeonUrl, type Db } from './client.js'

export const MOVIES_DB_WAIT_ATTEMPTS = 30
export const MOVIES_DB_WAIT_MS = 2_000
export const MOVIES_DB_RETRY_MS = 15_000

export interface OpenMoviesDbOptions {
  migrationsFolder?: string
  attempts?: number
  waitMs?: number
  retryMs?: number
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}

async function migrateOnce(db: Db, migrationsFolder: string): Promise<void> {
  await db.execute(sql`select 1`)
  await migrate(db, { migrationsFolder })
}

/**
 * Opens this machine's movies database and brings it to the current schema (the same drizzle
 * migrations as the notes database: its notes tables stay empty). The database may start after the
 * daemon (a container at boot), so this waits for it, and when it still does not answer hands back
 * the pool anyway and keeps trying to migrate behind it. `stop` ends that retry.
 */
export async function openMoviesDb(url: string, options: OpenMoviesDbOptions = {}): Promise<{ db: Db; stop: () => void }> {
  if (isNeonUrl(url)) throw new Error('MOVIES_DATABASE_URL names a Neon host; it must be a Postgres on this machine.')
  const migrationsFolder = options.migrationsFolder ?? path.join(REPO_ROOT, 'drizzle')
  const attempts = options.attempts ?? MOVIES_DB_WAIT_ATTEMPTS
  const waitMs = options.waitMs ?? MOVIES_DB_WAIT_MS
  const log = options.log ?? ((line: string) => console.log(line))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const db = createDb(url)
  let lastError: unknown = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      await migrateOnce(db, migrationsFolder)
      return { db, stop: () => {} }
    } catch (err) {
      lastError = err
      if (i < attempts - 1) await sleep(waitMs)
    }
  }
  log(`[notesd] movies database: not ready (${lastError instanceof Error ? lastError.message : String(lastError)}); retrying behind the daemon`)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const retry = (): void => {
    timer = setTimeout(() => {
      if (stopped) return
      migrateOnce(db, migrationsFolder).then(
        () => log('[notesd] movies database: ready'),
        () => {
          if (!stopped) retry()
        },
      )
    }, options.retryMs ?? MOVIES_DB_RETRY_MS)
    timer.unref()
  }
  retry()
  return {
    db,
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    },
  }
}
