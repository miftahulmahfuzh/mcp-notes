import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { EMBEDDING_MODEL } from '../../src/embeddings/constants.js';
import { saveEmbedding } from '../../src/embeddings/repo.js';
import { bodySha256, embedInput } from '../../src/embeddings/state.js';
import { createApp } from '../../src/http/app.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { NoteError, type ImageMeta, type Note, type RelatedResult } from '../../src/notes/types.js';
import { createFakeEmbedder, type Lexicon } from '../helpers/fakeEmbedder.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';
import { ChatService } from '../../src/chat/service.js';

/** Synonym groups: each group is one concept axis in the fake embedder. */
const LEXICON: Lexicon = [
  ['arango', 'arangodb', 'database', 'postgres'],
  ['password', 'credentials', 'secret', 'vault'],
  ['login', 'auth', 'signin'],
  ['sleep', 'slept', 'resume', 'suspend'],
];

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-related-'));
const events = new NoteEvents();
const fake = createFakeEmbedder({ lexicon: LEXICON });
const service = new NotesService({ db, dataDir, events, embedder: fake });
const noEmbedder = new NotesService({ db, dataDir, events, embedder: null });

const config: Config = {
  databaseUrl: testDatabaseUrl(),
  port: 0,
  host: '127.0.0.1',
  dataDir,
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
  sessions: DEFAULT_SESSIONS_CONFIG,
};
const deps: AppDeps = { config, db, events, service, embedder: fake, imageEmbedder: null, chat: new ChatService({ db }) };
const app = createApp(deps);
let client: Client;

async function expectNoteError(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NoteError);
  expect((err as NoteError).code).toBe(code);
  if (message) expect((err as NoteError).message).toMatch(message);
}

/** Writes a current vector for the note's body, as the worker would. */
async function embed(note: Note, model: string = fake.model): Promise<void> {
  const input = embedInput(note.body);
  if (input === null) throw new Error(`note ${note.id} has no text`);
  const [vector] = await fake.embed([input]);
  const saved = await saveEmbedding(db, { noteId: note.id, bodySha256: bodySha256(note.body), model, embedding: vector! });
  expect(saved).toBe(true);
}

async function hasCurrentRow(id: string): Promise<boolean> {
  const res = await db.execute(sql`select 1 from note_embeddings where note_id = ${id} and embedding is not null`);
  return res.rows.length > 0;
}

const ids = (r: RelatedResult): string[] => r.related.map((x) => x.note.id);

const photoMeta: ImageMeta = {
  sha256: 'f'.repeat(64),
  mime: 'image/png',
  width: 2,
  height: 1,
  bytes: 70,
  taken_at: null,
  original_name: 'shot.png',
  host: 'lenovo',
};

/** Source + three neighbours at decreasing closeness (2 shared concepts, 1, 0). */
async function seed(): Promise<{ src: Note; a: Note; b: Note; c: Note }> {
  const src = await service.create({ body: 'where are the arangodb credentials kept' });
  const a = await service.create({ body: 'arango root password is in the vault' });
  const c = await service.create({ body: 'postgres backup runs nightly' });
  const b = await service.create({ body: 'the login broke after the laptop slept' });
  for (const n of [src, a, b, c]) await embed(n);
  return { src, a, b, c };
}

beforeAll(async () => {
  client = new Client({ name: 'mcp-notes-related-test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: async (input, init) => app.request(String(input), init),
    }),
  );
});

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.close();
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('NotesService.related', () => {
  it('orders live notes by meaning, excludes the note itself, similarity = 1 - distance', async () => {
    const { src, a, b, c } = await seed();
    const r = await service.related(src.id.toLowerCase().replace('-', ''));
    expect(r.note_id).toBe(src.id);
    expect(ids(r)).toEqual([a.id, c.id, b.id]);
    expect(ids(r)).not.toContain(src.id);
    const sims = r.related.map((x) => x.similarity);
    for (const s of sims) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect([...sims].sort((x, y) => y - x)).toEqual(sims);
    expect(sims[0]!).toBeGreaterThan(sims[2]!);
  });

  it('honours limit and clamps it to 1..50', async () => {
    const { src, a } = await seed();
    expect(ids(await service.related(src.id, { limit: 1 }))).toEqual([a.id]);
    expect((await service.related(src.id, { limit: 0 })).related).toHaveLength(1);
    expect((await service.related(src.id, { limit: 500 })).related).toHaveLength(3);
  });

  it('never returns a deleted note, even though its vector is kept', async () => {
    const { src, a, b, c } = await seed();
    await service.delete(a.id);
    expect(await hasCurrentRow(a.id)).toBe(true);
    expect(ids(await service.related(src.id))).toEqual([c.id, b.id]);
  });

  it('ignores stale vectors (body changed) and vectors from another model', async () => {
    const { src, a, b, c } = await seed();
    const a2 = await service.update(a.id, 'arango root password moved to bitwarden');
    const d = await service.create({ body: 'arangodb credentials rotated' });
    await embed(d, 'other/model');
    const r = await service.related(src.id);
    expect(ids(r)).not.toContain(a2.id);
    expect(ids(r)).not.toContain(d.id);
    expect(ids(r)).toEqual([c.id, b.id]);
  });

  it('embeds a source with no current vector on demand, once', async () => {
    const { src, a, b } = await seed();
    const fresh = await service.create({ body: 'vault holds the arangodb secret' });
    expect(await hasCurrentRow(fresh.id)).toBe(false);
    const before = fake.calls.length;
    const r = await service.related(fresh.id);
    expect(fake.calls.length).toBe(before + 1);
    expect(await hasCurrentRow(fresh.id)).toBe(true);
    // src and a both share two concepts with fresh; their mutual order is up to the hash tail.
    expect(ids(r).slice(0, 2)).toEqual(expect.arrayContaining([src.id, a.id]));
    expect(ids(r).at(-1)).toBe(b.id);
    await service.related(fresh.id);
    expect(fake.calls.length).toBe(before + 1);
  });

  it('re-embeds a source whose body changed since its vector was made', async () => {
    const { src } = await seed();
    await service.append(src.id, 'and the vault password');
    const before = fake.calls.length;
    await service.related(src.id);
    expect(fake.calls.length).toBe(before + 1);
  });

  it('without an embedder: answers from existing vectors, clear error for an unembedded source', async () => {
    const { src, a } = await seed();
    // With no embedder, "current" means model = EMBEDDING_MODEL. The fake already uses that id
    // (Phase 2 default), so these re-saves are no-ops kept to make the precondition explicit.
    await embed(src, EMBEDDING_MODEL);
    await embed(a, EMBEDDING_MODEL);
    expect(ids(await noEmbedder.related(src.id))[0]).toBe(a.id);
    const fresh = await service.create({ body: 'arangodb credentials again' });
    await expectNoteError(noEmbedder.related(fresh.id), 'not_embedded', /semantic search is off/);
  });

  it('a failing on-demand embed is a not_embedded error and stores nothing', async () => {
    await seed();
    const fresh = await service.create({ body: 'arangodb credentials again' });
    fake.failNext(1);
    await expectNoteError(service.related(fresh.id), 'not_embedded', /embedding it now failed/);
    expect(await hasCurrentRow(fresh.id)).toBe(false);
  });

  it('rejects bad, unknown and deleted ids, and a photo with no text', async () => {
    const { src } = await seed();
    await expectNoteError(service.related('not an id'), 'invalid_id');
    await expectNoteError(service.related('Z-ZZZ'), 'not_found');
    await service.delete(src.id);
    await expectNoteError(service.related(src.id), 'deleted', /restore/);
    const photo = await service.create({
      body: '',
      allowEmpty: true,
      image: { path: 'images/2026/10/photo.png', meta: photoMeta },
    });
    const before = fake.calls.length;
    await expectNoteError(service.related(photo.id), 'invalid_input', /photo with no text/);
    expect(fake.calls.length).toBe(before);
  });
});

describe('MCP related tool', () => {
  async function callTool(args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client.callTool({ name: 'related', arguments: args })) as CallToolResult;
  }
  function text(r: CallToolResult): string {
    const first = r.content[0];
    if (!first || first.type !== 'text') throw new Error('expected text content');
    return first.text;
  }

  it('is listed, read-only, and returns { note_id, related: [{ note, similarity }] }', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'related');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);

    const { src, a } = await seed();
    const r = await callTool({ id: src.id, limit: 2 });
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(text(r)) as RelatedResult;
    expect(body.note_id).toBe(src.id);
    expect(body.related).toHaveLength(2);
    expect(body.related[0]!.note.id).toBe(a.id);
    expect(typeof body.related[0]!.similarity).toBe('number');
    expect(Object.keys(body.related[0]!.note)).not.toContain('embedding');
  });

  it('rejects limit outside 1-50 and reports service errors as code: message', async () => {
    const { src } = await seed();
    expect((await callTool({ id: src.id, limit: 51 })).isError).toBe(true);
    expect((await callTool({ id: src.id, limit: 0 })).isError).toBe(true);
    const missing = await callTool({ id: 'Z-ZZZ' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/^not_found: /);
  });
});
