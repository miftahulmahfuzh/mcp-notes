import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { DEFAULT_CHAT_CONFIG } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { createApp } from '../../src/http/app.js';
import { dbImageRecords } from '../../src/images/records.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

export interface Harness {
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  dataDir: string;
  /** Start a real HTTP server on 127.0.0.1:0 (needed for the MCP client). */
  listen(): Promise<string>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-p5-'));
  for (const sub of ['images', 'cache', 'inbox', 'inbox/failed']) {
    await mkdir(path.join(dataDir, sub), { recursive: true });
  }
  const db = openTestDb();
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir, events });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG },
    db,
    events,
    service,
  };
  const app = createApp(deps);
  let server: ServerType | undefined;

  return {
    deps,
    app,
    dataDir,
    async listen() {
      if (server) {
        const addr = server.address();
        if (addr && typeof addr === 'object') return `http://127.0.0.1:${addr.port}`;
      }
      const port = await new Promise<number>((resolve) => {
        server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
      });
      return `http://127.0.0.1:${port}`;
    },
    async reset() {
      await truncateAll(db);
      await rm(path.join(dataDir, 'images'), { recursive: true, force: true });
      await rm(path.join(dataDir, 'cache'), { recursive: true, force: true });
      await mkdir(path.join(dataDir, 'images'), { recursive: true });
      await mkdir(path.join(dataDir, 'cache'), { recursive: true });
    },
    async close() {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await closeTestDb(db);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A solid-colour image. Different colours give different bytes, so they do not dedupe. */
export async function makeImage(
  format: 'png' | 'jpeg' | 'tiff',
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  const img = sharp({ create: { width, height, channels: 3, background: rgb } });
  if (format === 'png') return img.png().toBuffer();
  if (format === 'jpeg') return img.jpeg({ quality: 90 }).toBuffer();
  return img.tiff().toBuffer();
}

/** Insert a plain text note directly (no image). */
export async function insertTextNote(h: Harness, id: string, body: string): Promise<void> {
  await h.deps.db.execute(
    sql`insert into notes (id, body, tags, created_at, updated_at)
        values (${id}, ${body}, '{}'::text[], now(), now())`,
  );
}

/** Set image_meta.taken_at directly (the EXIF path itself is P4's test subject). */
export async function setTakenAt(h: Harness, id: string, takenAtIso: string | null): Promise<void> {
  await h.deps.db.execute(
    sql`update notes
        set image_meta = jsonb_set(image_meta, '{taken_at}', ${takenAtIso === null ? sql`'null'::jsonb` : sql`to_jsonb(${takenAtIso}::text)`})
        where id = ${id}`,
  );
}

/** Absolute path of a note's original on disk. */
export async function originalPathOf(h: Harness, id: string): Promise<string> {
  const rec = await dbImageRecords(h.deps.db).byId(id);
  if (!rec) throw new Error(`note ${id} has no image_path`);
  return path.join(h.dataDir, rec.image_path);
}

export function cacheDirOf(h: Harness, id: string): string {
  return path.join(h.dataDir, 'cache', id);
}
