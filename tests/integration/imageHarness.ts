import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { ChatBackend } from '../../src/chat/backend.js';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import type { ImageEmbedder } from '../../src/embeddings/imageEmbedder.js';
import { createApp } from '../../src/http/app.js';
import { sha256Hex } from '../../src/images/probe.js';
import { dbImageRecords } from '../../src/images/records.js';
import { NoteEvents } from '../../src/notes/events.js';
import { insertImage } from '../../src/notes/imageRepo.js';
import { NotesService } from '../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';
import { ChatService } from '../../src/chat/service.js';

export interface Harness {
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  dataDir: string;
  /** Start a real HTTP server on 127.0.0.1:0 (needed for the MCP client). */
  listen(): Promise<string>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** The brain behind POST /api/chat. Omitted: createApp's default (the stub). */
  chat?: ChatBackend;
  /** Image embedder for similar_images over /mcp. Default null (image search off). */
  imageEmbedder?: ImageEmbedder | null;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-p5-'));
  for (const sub of ['images', 'cache', 'inbox', 'inbox/failed', 'chat-images', 'files']) {
    await mkdir(path.join(dataDir, sub), { recursive: true });
  }
  const db = openTestDb();
  const events = new NoteEvents();
  const service = new NotesService({ db, dataDir, events });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG },
    db,
    events,
    service,
    embedder: null,
    imageEmbedder: options.imageEmbedder ?? null,
    chat: new ChatService({ db }),
  };
  const app = createApp(deps, options.chat !== undefined ? { chat: options.chat } : {});
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
      for (const sub of ['images', 'cache', 'chat-images', 'files']) {
        await rm(path.join(dataDir, sub), { recursive: true, force: true });
        await mkdir(path.join(dataDir, sub), { recursive: true });
      }
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

/** Set taken_at on every image of a note directly (the EXIF path itself is the ingest tests' subject). */
export async function setTakenAt(h: Harness, noteId: string, takenAtIso: string | null): Promise<void> {
  await h.deps.db.execute(
    sql`update note_images
        set taken_at = ${takenAtIso === null ? sql`null` : sql`${takenAtIso}::timestamptz`}
        where note_id = ${noteId}`,
  );
}

/** Absolute path of an image's original on disk, by image id (a note's first image has the note's id). */
export async function originalPathOf(h: Harness, imageId: string): Promise<string> {
  const rec = await dbImageRecords(h.deps.db).byImageId(imageId);
  if (!rec) throw new Error(`no image ${imageId}`);
  return path.join(h.dataDir, rec.path);
}

export function cacheDirOf(h: Harness, imageId: string): string {
  return path.join(h.dataDir, 'cache', imageId);
}

/**
 * Add one more image to an existing note directly (attach is phase 3): a 12x12 PNG of colour
 * `rgb` written to images/2026/10/<imageId>.png plus its note_images row. Returns the image id.
 */
export async function addImage(
  h: Harness,
  noteId: string,
  imageId: string,
  position: number,
  rgb: { r: number; g: number; b: number },
): Promise<string> {
  const bytes = await makeImage('png', 12, 12, rgb);
  const rel = `images/2026/10/${imageId}.png`;
  await mkdir(path.join(h.dataDir, 'images/2026/10'), { recursive: true });
  await writeFile(path.join(h.dataDir, rel), bytes);
  await insertImage(h.deps.db, {
    id: imageId,
    noteId,
    path: rel,
    sha256: sha256Hex(bytes),
    mime: 'image/png',
    width: 12,
    height: 12,
    bytes: bytes.byteLength,
    takenAt: null,
    originalName: `${imageId}.png`,
    host: os.hostname(),
    position,
  });
  return imageId;
}
