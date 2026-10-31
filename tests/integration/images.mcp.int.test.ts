import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ingestChatImage, locateChatImage } from '../../src/chat/images.js';
import { setImageDeleted } from '../../src/notes/imageRepo.js';
import type { Note } from '../../src/notes/types.js';
import {
  addImage,
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

  it('view_images on a note id shows every image in order, each labelled k of n', async () => {
    const { id } = await createFromFile('first.png', await makeImage('png', 30, 20, { r: 10, g: 20, b: 30 }), 'three shots');
    await addImage(h, id, 'S-EC2', 1, { r: 40, g: 50, b: 60 });
    await addImage(h, id, 'T-HR3', 2, { r: 70, g: 80, b: 90 });
    const r = await call('view_images', { ids: [id] });
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(3);
    const t = texts(r).join('\n');
    expect(t).toContain(`image: ${id} (image 1 of 3)`);
    expect(t).toContain('image: S-EC2 (image 2 of 3)');
    expect(t).toContain('image: T-HR3 (image 3 of 3)');
    expect(t.indexOf('S-EC2')).toBeLessThan(t.indexOf('T-HR3'));
  });

  it('view_images takes an image id', async () => {
    const { id } = await createFromFile('host.png', await makeImage('png', 30, 20, { r: 11, g: 21, b: 31 }), 'two shots');
    await addImage(h, id, 'S-EC2', 1, { r: 41, g: 51, b: 61 });
    const r = await call('view_images', { ids: ['s-ec2'] });
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(1);
    const t = texts(r).join('\n');
    expect(t).toContain(`id: ${id}`);
    expect(t).toContain('image: S-EC2 (image 2 of 2)');
  });

  it('view_images returns at most 8 images and lists the image ids it left out', async () => {
    const { id } = await createFromFile('many.png', await makeImage('png', 30, 20, { r: 12, g: 22, b: 32 }), 'ten shots');
    for (let i = 1; i <= 9; i += 1) await addImage(h, id, `M-00${i}`, i, { r: 20 * i, g: 7, b: 200 - 10 * i });
    const r = await call('view_images', { ids: [id] });
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(8);
    const t = texts(r).join('\n');
    expect(t).toContain('image: M-007 (image 8 of 10)');
    expect(t).not.toContain('image: M-008 (');
    expect(t).toContain('M-008, M-009');
    expect(t).toMatch(/call view_images again/i);
  });

  it('view_images says when an image was removed', async () => {
    const { id } = await createFromFile('keep.png', await makeImage('png', 30, 20, { r: 13, g: 23, b: 33 }), 'kept');
    await addImage(h, id, 'R-EM2', 1, { r: 43, g: 53, b: 63 });
    await setImageDeleted(h.deps.db, 'R-EM2', true);
    const r = await call('view_images', { ids: ['R-EM2'] });
    expect(r.content.some((c) => c.type === 'image')).toBe(false);
    expect(texts(r).join('\n')).toContain(`R-EM2: this image was removed from note ${id}`);
  });

  /** Stores bytes in chat_images as a wall paste would; returns the chat image id. */
  async function paste(bytes: Buffer, originalName: string | null = 'pasted.png'): Promise<string> {
    const r = await ingestChatImage({ db: h.deps.db, dataDir: h.dataDir }, { bytes, originalName, source: 'wall' });
    return r.image.id;
  }

  async function noteCount(): Promise<number> {
    const res = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from notes`);
    return res.rows[0]?.n ?? 0;
  }

  const BAD_ARGS = 'create_image refused (bad_arguments): give exactly one of path or image_id';

  it('publishes path and image_id on create_image, neither required', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'create_image');
    const schema = t!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(['path', 'image_id', 'body', 'origin']));
    expect(schema.required ?? []).not.toContain('path');
    expect(schema.required ?? []).not.toContain('image_id');
    expect(t!.description).toMatch(/CHAT image id/);
  });

  it('create_image takes a pasted chat image by image_id, copies it, and dedupes', async () => {
    const png = await makeImage('png', 40, 30, { r: 9, g: 99, b: 199 });
    const chatId = await paste(png);
    const loc = await locateChatImage({ db: h.deps.db, dataDir: h.dataDir }, chatId);

    const r = await call('create_image', { image_id: chatId.toLowerCase().replace('-', ''), body: 'from the chat #pasted' });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    const first = JSON.parse(texts(r)[0]!) as { note: Note; created: boolean };
    expect(first.created).toBe(true);
    expect(first.note.body).toBe('from the chat #pasted');
    expect(first.note.tags).toEqual(['pasted']);
    expect(first.note.origin?.source).toBe('mcp');
    expect(first.note.images).toHaveLength(1);
    expect(first.note.images[0]!.original_name).toBe('pasted.png');
    // The note image has its own id in the note-image space; the chat original stays where it was.
    expect(Buffer.compare(await readFile(await originalPathOf(h, first.note.id)), png)).toBe(0);
    await expect(access(loc!.source.originalPath)).resolves.toBeUndefined();

    const again = await call('create_image', { image_id: chatId });
    expect(again.isError, texts(again).join('\n')).toBeFalsy();
    expect(JSON.parse(texts(again)[0]!)).toMatchObject({ note: { id: first.note.id }, created: false });

    // Same bytes by path: the same note, no duplicate.
    expect(await createFromFile('same.png', png)).toEqual({ id: first.note.id, created: false });
    expect(await noteCount()).toBe(1);
  });

  it('create_image names a chat image without an original name by its stored file name', async () => {
    const chatId = await paste(await makeImage('png', 20, 20, { r: 77, g: 7, b: 177 }), null);
    const r = await call('create_image', { image_id: chatId });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    const j = JSON.parse(texts(r)[0]!) as { note: Note };
    expect(j.note.images[0]!.original_name).toBe(`${chatId}.png`);
  });

  it('create_image dedupes a pasted image against a note that already holds the bytes', async () => {
    const png = await makeImage('png', 24, 24, { r: 15, g: 25, b: 35 });
    const held = await createFromFile('held.png', png, 'saved earlier');
    const chatId = await paste(png);
    const r = await call('create_image', { image_id: chatId });
    expect(r.isError, texts(r).join('\n')).toBeFalsy();
    expect(JSON.parse(texts(r)[0]!)).toMatchObject({ note: { id: held.id }, created: false });
  });

  it('create_image refuses both, neither, unknown, note-image and other-machine image_ids', async () => {
    const png = await makeImage('png', 16, 16, { r: 200, g: 20, b: 2 });
    const p = path.join(srcDir, 'both.png');
    await writeFile(p, png);
    const chatId = await paste(png);

    const both = await call('create_image', { path: p, image_id: chatId });
    expect(both.isError).toBe(true);
    expect(texts(both).join('\n')).toBe(BAD_ARGS);

    const neither = await call('create_image', { body: 'no picture' });
    expect(neither.isError).toBe(true);
    expect(texts(neither).join('\n')).toBe(BAD_ARGS);

    const unknown = await call('create_image', { image_id: 'z-zzz' });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown).join('\n')).toBe(
      'create_image refused (unknown_chat_image): no pasted image Z-ZZZ. Pasted image ids look like G-0NC and appear as [image upload:ID] in chat or in the pasted-images note of a Claude Code /n prompt',
    );

    // A NOTE image id is a different id space: never matched as a pasted image.
    const noteImg = await createFromFile('note.png', await makeImage('png', 16, 16, { r: 2, g: 20, b: 200 }));
    const asChat = await call('create_image', { image_id: noteImg.id });
    expect(asChat.isError).toBe(true);
    expect(texts(asChat).join('\n')).toContain(`create_image refused (unknown_chat_image): no pasted image ${noteImg.id}.`);

    // Pasted on the other laptop: the row is here, the file is not.
    const loc = await locateChatImage({ db: h.deps.db, dataDir: h.dataDir }, chatId);
    await h.deps.db.execute(sql`update chat_images set host = 'other-laptop' where id = ${chatId}`);
    await rm(loc!.source.originalPath);
    const away = await call('create_image', { image_id: chatId });
    expect(away.isError).toBe(true);
    expect(texts(away).join('\n')).toBe(
      `create_image refused (not_on_this_machine): pasted image ${chatId} is stored on other-laptop, not on this machine`,
    );

    expect(await noteCount()).toBe(1); // only noteImg
  });
});
