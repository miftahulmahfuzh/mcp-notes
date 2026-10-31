import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dbImageEmbeddingStore, runImageBackfill } from '../../src/embeddings/imageBackfill.js';
import { mcpToolDeps } from '../../src/http/app.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { PASTED_IMAGE_NEEDS_HOOK, type SimilarImagesResult } from '../../src/mcp/similarTools.js';
import type { ToolDeps } from '../../src/mcp/tools.js';
import { normalizeId } from '../../src/notes/ids.js';
import { setImageDeleted } from '../../src/notes/imageRepo.js';
import { FakeImageEmbedder, type Rgb } from '../helpers/fakeImageEmbedder.js';
import { addImage, makeImage, originalPathOf, startHarness, type Harness } from './imageHarness.js';

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

const RED: Rgb = { r: 220, g: 20, b: 20 };
const RED2: Rgb = { r: 221, g: 20, b: 20 };
const RED3: Rgb = { r: 219, g: 21, b: 20 };
const DARK_RED: Rgb = { r: 110, g: 10, b: 10 };
const BLUE: Rgb = { r: 20, g: 20, b: 220 };

function text(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

describe('similar_images over MCP', () => {
  const fake = new FakeImageEmbedder();
  let h: Harness;
  let client: Client;

  beforeAll(async () => {
    h = await startHarness({ imageEmbedder: fake });
    const base = await h.listen();
    client = new Client({ name: 'p6-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  });
  afterAll(async () => {
    await client.close();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    fake.reset();
  });

  async function call(args: Record<string, unknown>, c: Client = client): Promise<ToolResult> {
    return (await c.callTool({ name: 'similar_images', arguments: args })) as ToolResult;
  }

  async function ok(args: Record<string, unknown>, c: Client = client): Promise<SimilarImagesResult> {
    const r = await call(args, c);
    expect(r.isError, text(r)).toBeFalsy();
    return JSON.parse(text(r)) as SimilarImagesResult;
  }

  async function photo(rgb: Rgb, body = 'a photo #pics'): Promise<string> {
    const note = await h.deps.service.create({ body });
    return addImage(h, note.id, note.id, 0, rgb);
  }

  async function embedAll(): Promise<void> {
    await runImageBackfill({ store: dbImageEmbeddingStore(h.deps.db, h.dataDir), embedder: fake, minIntervalMs: 0 });
    fake.reset();
  }

  async function inProcess(overrides: Partial<ToolDeps>): Promise<Client> {
    const server = createMcpServer({ ...mcpToolDeps(h.deps), ...overrides });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const c = new Client({ name: 'p6-in-process', version: '0.0.0' });
    await c.connect(clientSide);
    return c;
  }

  async function rowCount(): Promise<number> {
    const r = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_image_embeddings`);
    return r.rows[0]!.n;
  }

  it('is listed, read-only, with the four sources and limit', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'similar_images');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    const props = Object.keys((tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props.sort()).toEqual(['image_id', 'limit', 'pasted_image', 'query', 'upload_id']);
    expect(tool!.description).toMatch(/view_images/);
  });

  it('image_id: nearest first, never the source, a removed image or an image of a deleted note', async () => {
    const a = await photo(RED, 'red top in the car #pics #car');
    const b = await photo(DARK_RED, `dark red ${'x'.repeat(300)}`);
    const c = await photo(BLUE);
    const d = await photo(RED2);
    const e = await photo(RED3);
    await embedAll();
    await setImageDeleted(h.deps.db, d, true);
    await h.deps.service.delete(e);
    const r = await ok({ image_id: a.toLowerCase().replace('-', '') });
    expect(r.source).toEqual({ image_id: a });
    expect(r.model).toBe(fake.model);
    expect(r.hits.map((x) => x.image_id)).toEqual([b, c]);
    expect(r.hits[0]).toMatchObject({ note_id: b, available: true, note: { tags: [] } });
    expect(r.hits[0]!.similarity).toBeGreaterThan(0.99);
    expect(r.hits[0]!.note.body.length).toBeLessThanOrEqual(200);
    expect(r.hits[0]!.note.body.endsWith('…')).toBe(true);
    expect(r.next).toMatch(/view_images/);
    expect(fake.calls).toEqual([]);
  });

  it('limit caps the hits', async () => {
    const first = await photo({ r: 200, g: 20, b: 20 });
    for (const red of [201, 202, 203, 204]) await photo({ r: red, g: 20, b: 20 });
    await embedAll();
    expect((await ok({ image_id: first, limit: 2 })).hits).toHaveLength(2);
  });

  it('query: words reach pictures through the same space', async () => {
    const red = await photo(RED);
    await photo(BLUE);
    await embedAll();
    const r = await ok({ query: 'red top in a car' });
    expect(r.source).toEqual({ query: 'red top in a car' });
    expect(r.hits[0]!.image_id).toBe(red);
    expect(fake.calls).toEqual([{ kind: 'text', text: 'red top in a car' }]);
  });

  it('an image with no vector yet is embedded on the spot, like related', async () => {
    await photo(RED);
    await embedAll();
    const fresh = await photo(DARK_RED);
    const r = await ok({ image_id: fresh });
    expect(r.hits).toHaveLength(1);
    expect(fake.calls).toEqual([{ kind: 'image', bytes: expect.any(Number) }]);
    const saved = await h.deps.db.execute<{ ok: boolean }>(sql`
      select embedding is not null as ok from note_image_embeddings where image_id = ${fresh}
    `);
    expect(saved.rows[0]?.ok).toBe(true);
  });

  it('an image with no vector whose file is on another machine gets a clear error', async () => {
    const away = await photo(RED);
    await rm(await originalPathOf(h, away));
    const r = await call({ image_id: away });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/has no image embedding yet and its file lives on /);
  });

  it('unknown ids and malformed ids are explained', async () => {
    expect(text(await call({ image_id: 'Z-ZZZ' }))).toMatch(/Z-ZZZ: no such image/);
    expect(text(await call({ image_id: 'not an id!' }))).toMatch(/not an image id/);
  });

  it('needs exactly one source', async () => {
    const none = await call({ limit: 3 });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/exactly one of image_id, upload_id, query or pasted_image \(got none\)/);
    const two = await call({ image_id: 'A-B32', query: 'red' });
    expect(text(two)).toMatch(/\(got 2\)/);
  });

  it('pasted_image that reached the server (the hook did not rewrite it) gets the final explanation', async () => {
    const r = await call({ pasted_image: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(PASTED_IMAGE_NEEDS_HOOK);
    expect(text(r)).toMatch(/notes-paste hook/);
    expect(text(r)).toMatch(/scripts\/install\.sh/);
  });

  it('upload_id embeds the chat upload on the fly and stores nothing', async () => {
    const red = await photo(RED);
    await photo(BLUE);
    await embedAll();
    const uploadPath = path.join(h.dataDir, 'upload-red.png');
    await writeFile(uploadPath, await makeImage('png', 40, 40, RED));
    const c = await inProcess({
      chatUploads: async (id) => {
        const canonical = normalizeId(id);
        if (canonical === 'U-P01') return { id: 'U-P01', absPath: uploadPath };
        if (canonical === 'U-P02') return { id: 'U-P02', absPath: path.join(h.dataDir, 'gone.png') };
        return null;
      },
    });
    try {
      const before = await rowCount();
      const r = await ok({ upload_id: 'up01' }, c);
      expect(r.source).toEqual({ upload_id: 'U-P01' });
      expect(r.hits[0]!.image_id).toBe(red);
      expect(await rowCount()).toBe(before);
      expect(text(await call({ upload_id: 'U-P09' }, c))).toMatch(/no such chat upload/);
      expect(text(await call({ upload_id: 'U-P02' }, c))).toMatch(/pasted on another machine/);
    } finally {
      await c.close();
    }
  });

  it('without an image embedder: query says image search is off; existing vectors still answer image_id', async () => {
    const a = await photo(RED);
    const b = await photo(DARK_RED);
    await embedAll();
    const c = await inProcess({ imageEmbedder: null });
    try {
      const off = await call({ query: 'red' }, c);
      expect(off.isError).toBe(true);
      expect(text(off)).toMatch(/semantic image search is off/);
      expect((await ok({ image_id: a }, c)).hits.map((x) => x.image_id)).toEqual([b]);
    } finally {
      await c.close();
    }
  });
});
