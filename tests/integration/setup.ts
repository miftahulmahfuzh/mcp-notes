import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { closeDb, createDb, isNeonUrl, type Db } from '../../src/db/client.js'

/**
 * Integration-test helpers. Every integration file imports from here; nothing in
 * tests/integration opens its own connection.
 *
 * TEST_DATABASE_URL is set by scripts/test-int.sh to the Docker container
 * mcp-notes-pg-test (127.0.0.1:55433). It must never be the Neon database.
 */

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle')

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set. Run integration tests with `npm run test:int`.')
  }
  if (isNeonUrl(url)) {
    throw new Error('TEST_DATABASE_URL points at Neon. Integration tests truncate tables; use the Docker Postgres.')
  }
  return url
}

/** A Drizzle instance on the test database. Close it with `closeTestDb` in `afterAll`. */
export function openTestDb(): Db {
  return createDb(testDatabaseUrl())
}

export async function closeTestDb(db: Db): Promise<void> {
  await closeDb(db)
}

/** Applies drizzle/*.sql (idempotent: already-applied migrations are skipped). */
export async function migrateTestDb(): Promise<void> {
  const db = openTestDb()
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await closeDb(db)
  }
}

/** Empties every app table. Call in `beforeEach` of any file that writes. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table chat_message_attachments, chat_message_revisions, chat_messages, chat_threads, note_image_embeddings, chat_images, note_files, note_images, note_embeddings, note_revisions, notes restart identity cascade`)
}
