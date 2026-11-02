import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { createApp } from '../../src/http/app.js';
import { NoteEvents, type NoteEvent } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import type { Note } from '../../src/notes/types.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';
import { ChatService } from '../../src/chat/service.js';

const url = testDatabaseUrl();
const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-mcp-'));
const config: Config = { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG };
const events = new NoteEvents();
const service = new NotesService({ db, dataDir, events });
const deps: AppDeps = { config, db, events, service, embedder: null, imageEmbedder: null, chat: new ChatService({ db }) };
const app: Hono = createApp(deps);
const seen: NoteEvent[] = [];
events.on((e) => seen.push(e));

let client: Client;

/** The real /mcp route, in process: the SDK client's fetch goes straight to app.request. */
async function connect(): Promise<Client> {
  const c = new Client({ name: 'mcp-notes-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
    fetch: async (input, init) => app.request(String(input), init),
  });
  await c.connect(transport);
  return c;
}

function text(result: unknown): string {
  const r = result as CallToolResult;
  const first = r.content[0];
  if (!first || first.type !== 'text') throw new Error('expected text content');
  return first.text;
}

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(text(result));
  return JSON.parse(text(result)) as T;
}

async function callError(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(result.isError).toBe(true);
  return text(result);
}

beforeAll(async () => {
  client = await connect();
});

beforeEach(async () => {
  await truncateAll(db);
  seen.length = 0;
});

afterEach(() => {
  seen.length = 0;
});

afterAll(async () => {
  await client.close();
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('MCP over the real /mcp route', () => {
  it('exposes the eleven note tools and the server instructions', async () => {
    const { tools } = await client.listTools();
    // arrayContaining, not toEqual: phase 5 adds create_image and view_images to the same server.
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['append', 'create', 'delete', 'get', 'list', 'restore', 'revert', 'revisions', 'search', 'tags', 'update']),
    );
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(40);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('A-B32');
    expect(instructions).toContain('case-insensitive');
    expect(instructions).toMatch(/Comparisons/);
  });

  it('create -> get (case-insensitive, no dash) -> update -> append -> revisions -> revert', async () => {
    const { note } = await call<{ note: Note }>('create', {
      body: 'session insights #seer',
      origin: { cwd: '/home/m/seer', repo: 'seer' },
    });
    expect(note.origin).toEqual({ cwd: '/home/m/seer', repo: 'seer', source: 'mcp' });
    expect(seen).toEqual([{ type: 'note', op: 'created', id: note.id }]);

    const loose = note.id.toLowerCase().replace('-', '');
    const got = await call<{ notes: Note[]; missing: string[]; deleted: string[] }>('get', { ids: [loose] });
    expect(got.notes[0]?.id).toBe(note.id);

    const upd = await call<{ note: Note }>('update', { id: loose, body: 'plain text now #seer #agentic' });
    expect(upd.note.tags).toEqual(['seer', 'agentic']);
    const app2 = await call<{ note: Note }>('append', { id: note.id, text: 'one more line' });
    expect(app2.note.body).toBe('plain text now #seer #agentic\n\none more line');

    const { revisions } = await call<{ revisions: { revision: number; body: string }[] }>('revisions', { id: note.id });
    expect(revisions.map((r) => r.body)).toEqual(['plain text now #seer #agentic', 'session insights #seer']);
    const reverted = await call<{ note: Note }>('revert', { id: note.id, revision: revisions[1]!.revision });
    expect(reverted.note.body).toBe('session insights #seer');
  });

  it('delete, list deleted=only, restore', async () => {
    const { note } = await call<{ note: Note }>('create', { body: 'temp' });
    await call('delete', { id: note.id });
    expect((await call<{ notes: Note[] }>('list')).notes).toEqual([]);
    expect((await call<{ notes: Note[] }>('list', { deleted: 'only' })).notes.map((n) => n.id)).toEqual([note.id]);
    const got = await call<{ deleted: string[] }>('get', { ids: [note.id] });
    expect(got.deleted).toEqual([note.id]);
    await call('restore', { id: note.id });
    expect((await call<{ notes: Note[] }>('list')).notes.map((n) => n.id)).toEqual([note.id]);
  });

  it('list and search filter by tags; tags counts them', async () => {
    await call('create', { body: 'first #v250' });
    await call('create', { body: 'second #v250 #seer pool' });
    await call('create', { body: 'third #seer' });
    const v = await call<{ notes: Note[]; next_cursor: string | null }>('list', { tags_any: ['#v250'], limit: 1 });
    expect(v.notes[0]?.body).toBe('second #v250 #seer pool');
    expect(v.next_cursor).not.toBeNull();
    const s = await call<{ notes: Note[] }>('search', { query: 'pool', tags_all: ['seer', 'v250'] });
    expect(s.notes).toHaveLength(1);
    const { tags } = await call<{ tags: { tag: string; count: number; last_used: string }[] }>('tags');
    expect(tags.map((t) => [t.tag, t.count])).toEqual([
      ['seer', 2],
      ['v250', 2],
    ]);
  });

  it('returns readable errors', async () => {
    expect(await callError('get', { ids: [] })).toMatch(/ids/);
    expect(await callError('create', { body: '' })).toMatch(/body/);
    expect(await callError('update', { id: 'Z-ZZZ', body: 'x' })).toMatch(/^not_found:/);
    expect(await callError('update', { id: '!!', body: 'x' })).toMatch(/^invalid_id:/);
    expect(await callError('list', { from: 'yesterday' })).toMatch(/^invalid_input:/);
  });
});

describe('/mcp HTTP guard and methods', () => {
  it('rejects GET and DELETE with 405', async () => {
    expect((await app.request('http://localhost/mcp', { method: 'GET' })).status).toBe(405);
    expect((await app.request('http://localhost/mcp', { method: 'DELETE' })).status).toBe(405);
  });

  it('rejects a non-loopback Host or Origin with 403', async () => {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    expect((await app.request('http://evil.example/mcp', init)).status).toBe(403);
    expect((await app.request('http://127.0.0.1:7399/mcp', init)).status).toBe(200);
    const withOrigin = { ...init, headers: { ...init.headers, origin: 'https://evil.example' } };
    expect((await app.request('http://localhost/mcp', withOrigin)).status).toBe(403);
  });

  it('serves /health', async () => {
    const res = await app.request('http://localhost/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'notesd' });
  });
});
