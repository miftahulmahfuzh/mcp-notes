import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { saveEmbedding } from '../../src/embeddings/repo.js';
import { bodySha256, embedInput } from '../../src/embeddings/state.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { NoteEvents } from '../../src/notes/events.js';
import { searchNotes } from '../../src/notes/repo.js';
import { NotesService } from '../../src/notes/service.js';
import type { ImageMeta, Note, SearchPage } from '../../src/notes/types.js';
import {
  LABELLED_NOTES,
  LABELLED_QUERIES,
  SEMANTIC_LEXICON,
  evaluateRanking,
  type RankingRun,
} from '../fixtures/semantic/labelled.js';
import { createFakeEmbedder } from '../helpers/fakeEmbedder.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-hybrid-'));
const events = new NoteEvents();
const embedder = createFakeEmbedder({ lexicon: SEMANTIC_LEXICON });
// Rebuilt per test: the service's query-vector cache must not carry a query's vector from one
// test into another (the fallback and paging tests count embedder calls).
let service = new NotesService({ db, dataDir, events, embedder });
const DAY_MS = 86_400_000;

const ids = (page: { notes: Note[] }): string[] => page.notes.map((n) => n.id);

const meta = (sha256: string): ImageMeta => ({
  sha256,
  mime: 'image/png',
  width: 2,
  height: 1,
  bytes: 70,
  taken_at: null,
  original_name: 'shot.png',
  host: 'lenovo',
});

async function setDates(id: string, at: Date): Promise<void> {
  const iso = at.toISOString();
  await db.execute(sql`update notes set created_at = ${iso}::timestamptz, updated_at = ${iso}::timestamptz where id = ${id}`);
}

/** Stores a current vector for the note: its own body's, or `vector` when given. */
async function embedNote(note: Note, vector?: number[]): Promise<void> {
  const input = embedInput(note.body);
  if (input === null) throw new Error(`note ${note.id} has no text to embed`);
  const saved = await saveEmbedding(db, {
    noteId: note.id,
    bodySha256: bodySha256(note.body),
    model: embedder.model,
    embedding: vector ?? embedder.vectorFor(input),
  });
  expect(saved).toBe(true);
}

/** Creates and embeds the labelled notes; returns key -> id. */
async function seedLabelled(): Promise<Map<string, string>> {
  const now = Date.now();
  const byKey = new Map<string, string>();
  for (const n of LABELLED_NOTES) {
    const note = await service.create({ body: n.body });
    await embedNote(note);
    await setDates(note.id, new Date(now - (n.ageDays ?? 0) * DAY_MS));
    byKey.set(n.key, note.id);
  }
  return byKey;
}

function idOf(byKey: Map<string, string>, key: string): string {
  const id = byKey.get(key);
  if (id === undefined) throw new Error(`no labelled note ${key}`);
  return id;
}

beforeEach(async () => {
  await truncateAll(db);
  embedder.reset();
  service = new NotesService({ db, dataDir, events, embedder });
});

afterAll(async () => {
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('hybrid search on the labelled set', () => {
  it('beats text-only on MRR and recall@3', async () => {
    const byKey = await seedLabelled();
    const hybridRuns: RankingRun[] = [];
    const textRuns: RankingRun[] = [];
    for (const q of LABELLED_QUERIES) {
      const relevant = q.relevant.map((k) => idOf(byKey, k));
      const h = await service.search(q.query, { limit: 10 });
      expect(h.mode, q.query).toBe('hybrid');
      expect(h.fallback, q.query).toBeUndefined();
      hybridRuns.push({ ranked: ids(h), relevant });
      const t = await service.search(q.query, { limit: 10 }, { mode: 'text' });
      expect(t.mode).toBe('text');
      textRuns.push({ ranked: ids(t), relevant });
    }
    const hybrid = evaluateRanking(hybridRuns);
    const text = evaluateRanking(textRuns);
    expect(hybrid.mrr).toBeGreaterThan(text.mrr);
    expect(hybrid.recallAt3).toBeGreaterThan(text.recallAt3);
    expect(hybrid.mrr).toBeGreaterThanOrEqual(0.8);
    expect(hybrid.recallAt3).toBeGreaterThanOrEqual(0.8);
  });

  it('ranks a relevant note first for every usage example', async () => {
    const byKey = await seedLabelled();
    for (const q of LABELLED_QUERIES.filter((x) => x.usage === true)) {
      const page = await service.search(q.query);
      const relevant = q.relevant.map((k) => idOf(byKey, k));
      expect(relevant, q.query).toContain(page.notes[0]?.id);
    }
  });

  it('keeps literal queries first in hybrid', async () => {
    const byKey = await seedLabelled();
    expect((await service.search('pgx pool')).notes[0]?.id).toBe(idOf(byKey, 'pgx-pool'));
    expect((await service.search('backup')).notes[0]?.id).toBe(idOf(byKey, 'arango-backup'));
  });
});

describe('literal matches are never drowned', () => {
  it('puts an exact id first against a perfect meaning match, dashed or not', async () => {
    const target = await service.create({ id: 'Q-7K2', body: 'release checklist for the web app' });
    await embedNote(target);
    await setDates(target.id, new Date('2024-01-01T00:00:00Z'));
    for (const [i, query] of ['Q-7K2', 'q7k2', 'what did q-7k2 say'].entries()) {
      // The rival's body does not contain the id; its vector is the query's own (similarity 1).
      const rival = await service.create({ body: `rival note number ${i}` });
      await embedNote(rival, embedder.vectorFor(query));
      const page = await service.search(query);
      expect(page.mode).toBe('hybrid');
      expect(page.notes[0]?.id, query).toBe(target.id);
      expect(ids(page), query).toContain(rival.id);
    }
  });

  it('puts a rare code token first against a perfect, fresh meaning match', async () => {
    const rare = await service.create({
      body: 'seer feed dies with ECONNRESET every ~6h; the reconnect loop in feed.ts handles it #seer',
    });
    await embedNote(rare);
    await setDates(rare.id, new Date('2024-01-01T00:00:00Z'));
    const rival = await service.create({ body: 'flaky market data feed again #seer' });
    await embedNote(rival, embedder.vectorFor('ECONNRESET'));
    const page = await service.search('ECONNRESET');
    expect(page.notes[0]?.id).toBe(rare.id);
    expect(ids(page)).toContain(rival.id);
  });

  it('still returns full-text matches when no note has a vector yet', async () => {
    const a = await service.create({ body: 'pgx connection pool tuning #seer' });
    await service.create({ body: 'unrelated' });
    const page = await service.search('pool');
    expect(page.mode).toBe('hybrid');
    expect(ids(page)).toEqual([a.id]);
  });

  it('honours -exclusions on the meaning side too', async () => {
    const byKey = await seedLabelled();
    const page = await service.search('ArangoDB credentials -vault');
    expect(ids(page)).not.toContain(idOf(byKey, 'arango-vault'));
    expect(ids(page)).not.toContain(idOf(byKey, 'vault-unseal'));
  });
});

describe('filters apply before ranking', () => {
  const Q = 'ArangoDB credentials';

  it('tags_any / tags_all', async () => {
    const byKey = await seedLabelled();
    const infra = await service.search(Q, { tagsAny: ['infra'] });
    expect(infra.notes.length).toBeGreaterThan(0);
    expect(infra.notes.every((n) => n.tags.includes('infra'))).toBe(true);
    expect(infra.notes[0]?.id).toBe(idOf(byKey, 'arango-vault'));
    const running = await service.search(Q, { tagsAll: ['running'] });
    expect(running.notes.every((n) => n.tags.includes('running'))).toBe(true);
    expect(ids(running)).not.toContain(idOf(byKey, 'arango-vault'));
  });

  it('from / to', async () => {
    const byKey = await seedLabelled();
    const vault = idOf(byKey, 'arango-vault');
    await setDates(vault, new Date('2024-01-15T10:00:00Z'));
    const recent = await service.search(Q, { from: '2025-01-01' });
    expect(ids(recent)).not.toContain(vault);
    const old = await service.search(Q, { to: '2024-12-31' });
    expect(ids(old)).toEqual([vault]);
  });

  it('has_image', async () => {
    await seedLabelled();
    const img = await service.create({
      body: 'screenshot of the arango credentials page',
      image: { path: 'images/2026/10/arango.png', meta: meta('aa') },
    });
    await embedNote(img);
    expect(ids(await service.search(Q, { hasImage: true }))).toEqual([img.id]);
    expect(ids(await service.search(Q, { hasImage: false }))).not.toContain(img.id);
  });

  it('deleted', async () => {
    const byKey = await seedLabelled();
    const vault = idOf(byKey, 'arango-vault');
    await service.delete(vault);
    expect(ids(await service.search(Q))).not.toContain(vault);
    const only = await service.search(Q, { deleted: 'only' });
    expect(ids(only)).toEqual([vault]);
    expect(only.notes[0]?.deleted_at).toBeDefined();
  });
});

describe('fallback to full text', () => {
  it('says so when the query embedding fails, with the text ranking', async () => {
    await seedLabelled();
    embedder.failNext(1);
    const page = await service.search('backup');
    expect(page.mode).toBe('text');
    expect(page.fallback).toMatch(/could not be embedded/);
    expect(page.fallback).toMatch(/full-text results only/);
    const text = await service.search('backup', {}, { mode: 'text' });
    expect(ids(page)).toEqual(ids(text));
    expect(text.fallback).toBeUndefined();
  });

  it('says so when the query embedding times out', async () => {
    await seedLabelled();
    embedder.delayMs = 300;
    const page = await service.search('ArangoDB credentials', {}, { queryTimeoutMs: 25 });
    expect(page.mode).toBe('text');
    expect(page.fallback).toMatch(/timed out/);
  });

  it('says so when there is no embedder', async () => {
    const plain = new NotesService({ db, dataDir, events });
    await plain.create({ body: 'pgx connection pool tuning' });
    const page = await plain.search('pool');
    expect(page.mode).toBe('text');
    expect(page.fallback).toMatch(/OPENROUTER_API_KEY/);
    expect(page.notes).toHaveLength(1);
  });
});

describe('mode text', () => {
  it("is today's full-text ranking and makes no embedding call", async () => {
    await seedLabelled();
    for (const q of ['pool', 'backup', 'arango', '"root password"', 'connection -neon', '#running']) {
      const viaService = await service.search(q, { limit: 50 }, { mode: 'text' });
      const viaRepo = await searchNotes(db, q, { limit: 50 });
      expect(ids(viaService), q).toEqual(viaRepo.rows.map((r) => r.id));
      expect(viaService.mode).toBe('text');
      expect(viaService.fallback).toBeUndefined();
    }
    expect(embedder.calls).toHaveLength(0);
  });
});

describe('paging', () => {
  it('pages over the blended list and embeds the query once', async () => {
    await seedLabelled();
    const q = 'connection problems after waking the laptop';
    const all = await service.search(q, { limit: 50 });
    expect(all.notes.length).toBeGreaterThanOrEqual(2);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i += 1) {
      const page: SearchPage = await service.search(q, cursor === undefined ? { limit: 1 } : { limit: 1, cursor });
      expect(page.mode).toBe('hybrid');
      seen.push(...ids(page));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(ids(all));
    expect(embedder.calls).toHaveLength(1);
  });
});

describe('MCP search tool', () => {
  async function connect(svc: NotesService): Promise<Client> {
    const server = createMcpServer({ service: svc, dataDir, db });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'search-hybrid-int', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
  }

  function text(result: unknown): string {
    const first = (result as CallToolResult).content[0];
    if (!first || first.type !== 'text') throw new Error('expected text content');
    return first.text;
  }

  it('describes meaning search, takes an optional mode and reports it', async () => {
    const byKey = await seedLabelled();
    const client = await connect(service);
    try {
      const { tools } = await client.listTools();
      const search = tools.find((t) => t.name === 'search');
      expect(search?.description).toMatch(/by meaning/);
      const props = (search?.inputSchema as { properties?: Record<string, unknown>; required?: string[] }) ?? {};
      expect(Object.keys(props.properties ?? {})).toEqual(expect.arrayContaining(['query', 'mode', 'tags_any', 'has_image']));
      expect(props.required ?? []).not.toContain('mode');

      const hybrid = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'ArangoDB credentials' } }))) as SearchPage;
      expect(hybrid.mode).toBe('hybrid');
      expect(hybrid.notes[0]?.id).toBe(idOf(byKey, 'arango-vault'));

      const exact = JSON.parse(
        text(await client.callTool({ name: 'search', arguments: { query: 'ArangoDB credentials', mode: 'text' } })),
      ) as SearchPage;
      expect(exact.mode).toBe('text');
      expect(exact.notes).toEqual([]);
      expect(exact.fallback).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('carries the fallback when the server has no embedder', async () => {
    const plain = new NotesService({ db, dataDir, events });
    await plain.create({ body: 'pgx connection pool tuning' });
    const client = await connect(plain);
    try {
      const page = JSON.parse(text(await client.callTool({ name: 'search', arguments: { query: 'pool' } }))) as SearchPage;
      expect(page.mode).toBe('text');
      expect(page.fallback).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      await client.close();
    }
  });
});
