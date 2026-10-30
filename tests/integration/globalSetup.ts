import { migrateTestDb } from './setup.js'

/** Vitest globalSetup for the integration run: migrate the Docker test DB once. */
export default async function setup(): Promise<void> {
  await migrateTestDb()
}
