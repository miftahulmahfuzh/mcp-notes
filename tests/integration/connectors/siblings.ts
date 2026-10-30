import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { connectorSettings, resolveRepoDir } from '../../../src/connectors/env.js';
import { SYSTEM_META, type SystemId } from '../../../src/connectors/names.js';
import { isNeonUrl } from '../../../src/db/client.js';

/**
 * Connector test databases live in the Docker container mcp-notes-pg-connectors
 * (pgvector/pgvector:pg16, 127.0.0.1:55435), one database per system, rebuilt by globalSetup
 * from the sibling repo's own migration files. The sibling repos are only read, never imported.
 */

/** Admin (superuser) URL of the connectors container. Never Neon. */
export function connectorsAdminUrl(): string {
  const url = process.env.TEST_CONNECTORS_URL;
  if (!url) throw new Error('TEST_CONNECTORS_URL is not set. Run integration tests with `npm run test:int`.');
  if (isNeonUrl(url)) throw new Error('TEST_CONNECTORS_URL points at Neon. Connector tests rebuild databases; use the Docker Postgres.');
  return url;
}

function migrationsMarker(id: SystemId, repo: string): string {
  return id === 'seer' ? path.join(repo, 'db', 'migrations') : path.join(repo, 'drizzle', 'meta', '_journal.json');
}

/** The sibling repo's path when its migrations are there, else null. Honours EXPENSE_TRACKING_DIR etc. */
export function siblingRepo(id: SystemId): string | null {
  const repo = resolveRepoDir(id, connectorSettings({ envFile: false }));
  return existsSync(migrationsMarker(id, repo)) ? repo : null;
}

export function systemDbName(id: SystemId): string {
  return `connectors_${id}`;
}

/** WRITABLE admin URL of that system's database: seed with it. Only the connector's own client is read-only. */
export function systemDbUrl(id: SystemId): string {
  const url = new URL(connectorsAdminUrl());
  url.pathname = `/${systemDbName(id)}`;
  return url.toString();
}

/** A writable admin client for setup and seeding. Refuses Neon. */
export async function withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  if (isNeonUrl(url)) throw new Error('refusing to open an admin connection to Neon');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Migration files in apply order: drizzle _journal.json order, or file-name order of db/migrations/*.sql (seer). */
export function migrationFiles(id: SystemId, repo: string): string[] {
  if (id === 'seer') {
    const dir = path.join(repo, 'db', 'migrations');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => path.join(dir, f));
  }
  const journal = JSON.parse(readFileSync(path.join(repo, 'drizzle', 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const file = path.join(repo, 'drizzle', `${e.tag}.sql`);
      if (!existsSync(file)) throw new Error(`${SYSTEM_META[id].label}: the journal lists ${e.tag} but ${file} is missing`);
      return file;
    });
}

/** Drizzle files split on `--> statement-breakpoint`; seer files run whole (simple protocol, several statements). */
export function migrationStatements(id: SystemId, text: string): string[] {
  if (id === 'seer') return [text];
  return text
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Drops and recreates connectors_<id>, then applies every migration. Returns the file count. */
export async function buildSystemDb(id: SystemId, repo: string): Promise<number> {
  const name = systemDbName(id);
  await withAdmin(connectorsAdminUrl(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name}`);
  });
  const files = migrationFiles(id, repo);
  await withAdmin(systemDbUrl(id), async (c) => {
    for (const file of files) {
      for (const statement of migrationStatements(id, readFileSync(file, 'utf8'))) {
        try {
          await c.query(statement);
        } catch (err) {
          throw new Error(`${SYSTEM_META[id].label}: ${path.basename(file)} failed: ${(err as Error).message}`);
        }
      }
    }
  });
  return files.length;
}
