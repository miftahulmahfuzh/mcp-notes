import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ChatBackend } from '../../../src/chat/backend.js';
import { ChatService } from '../../../src/chat/service.js';
import { createStubChatBackend } from '../../../src/chat/stub.js';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG } from '../../../src/config.js';
import type { AppDeps } from '../../../src/deps.js';
import { apiRoutes } from '../../../src/http/api.js';
import { chatHistoryRoutes } from '../../../src/http/chatApi.js';
import { NoteEvents } from '../../../src/notes/events.js';
import { generateId } from '../../../src/notes/ids.js';
import { NotesService } from '../../../src/notes/service.js';
import { closeTestDb, openTestDb, testDatabaseUrl } from '../setup.js';

/** The Origin `app.request('/api/...')` counts as same-origin (its URL is http://localhost/...). */
export const SAME_ORIGIN = { origin: 'http://localhost' } as const;

export interface ApiHarness {
  app: Hono;
  deps: AppDeps;
  notes: NotesService;
  events: NoteEvents;
  chat: ChatService;
  request(pathname: string, init?: RequestInit): Promise<Response>;
  sendJson(method: string, pathname: string, payload: unknown, headers?: Record<string, string>): Promise<Response>;
  insertImageNote(tag: string): Promise<string>;
  close(): Promise<void>;
}

export interface ApiHarnessOptions {
  sseHeartbeatMs?: number;
  /** The chat backend behind /api/chat. Default: the stub with no delay. */
  chat?: ChatBackend;
}

/** A tag no other test uses, e.g. `t3f9a1c2e`. */
export function uniqueTag(): string {
  return `t${randomBytes(5).toString('hex')}`;
}

export async function createApiHarness(options: ApiHarnessOptions = {}): Promise<ApiHarness> {
  const url = testDatabaseUrl();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-api-'));
  const db = openTestDb();
  const events = new NoteEvents();
  const notes = new NotesService({ db, events, dataDir });
  const chat = new ChatService({ db });
  const deps: AppDeps = {
    config: { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG },
    db,
    events,
    service: notes,
    embedder: null,
    imageEmbedder: null,
    chat,
  };
  const app = new Hono();
  app.route(
    '/',
    apiRoutes(deps, {
      chat: options.chat ?? createStubChatBackend({ delayMs: 0 }),
      ...(options.sseHeartbeatMs !== undefined ? { sseHeartbeatMs: options.sseHeartbeatMs } : {}),
    }),
  );
  app.route('/', chatHistoryRoutes(deps));

  return {
    app,
    deps,
    notes,
    events,
    chat,
    request: (pathname, init) => Promise.resolve(app.request(pathname, init)),
    sendJson: (method, pathname, payload, headers = {}) =>
      Promise.resolve(
        app.request(pathname, {
          method,
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(payload),
        }),
      ),
    async insertImageNote(tag: string): Promise<string> {
      const id = generateId();
      const meta = {
        sha256: randomBytes(32).toString('hex'),
        mime: 'image/jpeg',
        width: 10,
        height: 10,
        bytes: 100,
        taken_at: null,
        original_name: 'x.jpg',
        host: 'test-host',
      };
      await db.execute(sql`
        INSERT INTO notes (id, body, tags, origin, created_at, updated_at)
        VALUES (${id}, ${`photo #${tag}`}, ARRAY[${tag}]::text[], ${JSON.stringify({ source: 'test' })}::jsonb, now(), now())
      `);
      await db.execute(sql`
        INSERT INTO note_images (id, note_id, path, sha256, mime, width, height, bytes, taken_at, original_name, host, position, created_at)
        VALUES (${id}, ${id}, ${`images/2026/10/${id}.jpg`}, ${meta.sha256}, ${meta.mime}, ${meta.width}, ${meta.height},
                ${meta.bytes}, null, ${meta.original_name}, ${meta.host}, 0, now())
      `);
      return id;
    },
    async close(): Promise<void> {
      await closeTestDb(db);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
