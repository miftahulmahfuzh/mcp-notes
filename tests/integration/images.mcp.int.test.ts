import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cacheDirOf,
  insertTextNote,
  makeImage,
  originalPathOf,
  setTakenAt,
  startHarness,
  type Harness,
} from './imageHarness.js';

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | { type: string }>;
};

function texts(r: ToolResult): string[] {
  return r.content.flatMap((c) => (c.type === 'text' ? [(c as { text: string }).text] : []));
}

function noteIds(r: ToolResult): string[] {
  const parsed = JSON.parse(texts(r)[0] ?? '{"notes":[]}') as { notes: Array<{ id: string }> };
  return parsed.notes.map((n) => n.id).sort();
}

describe('MCP image tools and filters', () => {
  let h: Harness;
  let client: Client;
  let srcDir: string;

  beforeAll(async () => {
    h = await startHarness();
    const base = await h.listen();
    client = new Client({ name: 'p5-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    srcDir = path.join(h.dataDir, '..', `p5-src-${process.pid}`);
  });
  afterAll(async () => {
    await client.close();
    await rm(srcDir, { recursive: true, force: true });
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    await rm(srcDir, { recursive: true, force: true });
    await mkdir(srcDir, { recursive: true });
  });

  async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  }

  async function createFromFile(name: string, bytes: Buffer, body?: string): Promise<{ id: string; created: boolean }> {
    const p = path.join(srcDir, name);
    await writeFile(p, bytes);
    const r = await call('create_image', { path: p, ...(body !== undefined ? { body } : {}) });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    const j = JSON.parse(texts(r)[0]!) as { note: { id: string }; created: boolean };
    return { id: j.note.id, created: j.created };
  }

  it('lists the tools and the new filter fields', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['create_image', 'view_images', 'list', 'search']));
    for (const t of tools.filter((x) => x.name === 'list' || x.name === 'search')) {
      const props = Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      expect(props, t.name).toEqual(expect.arrayContaining(['has_image', 'taken_from', 'taken_to']));
    }
  });

  it('create_image copies (not moves) the file and dedupes', async () => {
    const png = await makeImage('png', 48, 48, { r: 3, g: 140, b: 3 });
    const first = await createFromFile('shot.png', png, 'screenshot of the bug #seer');
    expect(first.created).toBe(true);
    await expect(access(path.join(srcDir, 'shot.png'))).resolves.toBeUndefined();
    const stored = await originalPathOf(h, first.id);
    expect(Buffer.compare(await readFile(stored), png)).toBe(0);

    const second = await createFromFile('shot-copy.png', png);
    expect(second).toEqual({ id: first.id, created: false });
  });

  it('create_image refuses relative paths, missing files and non-images', async () => {
    const rel = await call('create_image', { path: 'relative/shot.png' });
    expect(rel.isError).toBe(true);
    expect(texts(rel).join(' ')).toContain('not_absolute');

    const missing = await call('create_image', { path: path.join(srcDir, 'nope.png') });
    expect(missing.isError).toBe(true);
    expect(texts(missing).join(' ')).toContain('not_found');

    const txt = path.join(srcDir, 'notes.txt');
    await writeFile(txt, 'plain text');
    const notImage = await call('create_image', { path: txt });
    expect(notImage.isError).toBe(true);
    expect(texts(notImage).join(' ')).toContain('not_an_image');
  });

  it('view_images returns the preview as MCP image content plus metadata', async () => {
    const jpg = await makeImage('jpeg', 2000, 1000, { r: 220, g: 180, b: 20 });
    const { id } = await createFromFile('photo.jpg', jpg, 'sunset #from_phone');
    const r = await call('view_images', { ids: [id.toLowerCase().replace('-', '')] });
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined;
    expect(img?.mimeType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(img!.data, 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1568);
    const t = texts(r).join('\n');
    expect(t).toContain(`id: ${id}`);
    expect(t).toContain('2000x1000');
    expect(t).toContain('#from_phone');
  });

  it('view_images explains text notes, unknown ids and missing files', async () => {
    await insertTextNote(h, 'T-XT2', 'only words');
    const png = await makeImage('png', 20, 20, { r: 100, g: 0, b: 100 });
    const { id: goneId } = await createFromFile('gone.png', png);
    await rm(await originalPathOf(h, goneId));
    await rm(cacheDirOf(h, goneId), { recursive: true, force: true });

    const r = await call('view_images', { ids: ['T-XT2', 'Q-QQQ', goneId] });
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
    const t = texts(r).join('\n');
    expect(t).toContain('text note');
    expect(t).toContain('Q-QQQ: no such note');
    expect(t).toContain('not on this machine');
    expect(t).toContain(os.hostname());
  });

  it('view_images caps a call at 8 ids', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `A-AA${i}`);
    let refused = false;
    try {
      const r = await call('view_images', { ids });
      refused = r.isError === true;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  it('list and search filter by has_image and taken range', async () => {
    // 'sunset', not 'sunsets': search uses the 'simple' config (no stemming).
    await insertTextNote(h, 'T-XT3', 'a text note about a sunset');
    const a = await createFromFile('a.png', await makeImage('png', 10, 10, { r: 1, g: 1, b: 1 }), 'sunset one');
    const b = await createFromFile('b.png', await makeImage('png', 10, 10, { r: 2, g: 2, b: 2 }), 'sunset two');
    const c = await createFromFile('c.png', await makeImage('png', 10, 10, { r: 3, g: 3, b: 3 }), 'no exif');
    await setTakenAt(h, a.id, new Date(2026, 9, 29, 23, 30).toISOString());
    await setTakenAt(h, b.id, new Date(2026, 9, 30, 10, 0).toISOString());
    await setTakenAt(h, c.id, null);

    expect(noteIds(await call('list', { has_image: true }))).toEqual([a.id, b.id, c.id].sort());
    expect(noteIds(await call('list', { has_image: false }))).toEqual(['T-XT3']);
    expect(noteIds(await call('list', {}))).toEqual([a.id, b.id, c.id, 'T-XT3'].sort());

    expect(noteIds(await call('list', { taken_from: '2026-10-30', taken_to: '2026-10-30' }))).toEqual([b.id]);
    expect(noteIds(await call('list', { taken_to: '2026-10-29' }))).toEqual([a.id]);
    expect(noteIds(await call('list', { taken_from: '2026-10-29' }))).toEqual([a.id, b.id].sort());

    expect(noteIds(await call('search', { query: 'sunset', has_image: true }))).toEqual([a.id, b.id].sort());
    expect(noteIds(await call('search', { query: 'sunset', has_image: false }))).toEqual(['T-XT3']);
    expect(noteIds(await call('search', { query: 'sunset', taken_from: '2026-10-30' }))).toEqual([b.id]);

    const bad = await call('list', { taken_from: 'yesterday' }).catch(() => ({ isError: true, content: [] }) as ToolResult);
    expect(bad.isError).toBe(true);
  });
});
