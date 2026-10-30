import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageRoutes } from '../../src/http/images.js';
import type { NoteEvent } from '../../src/notes/events.js';
import type { Note } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

type AttachBody = { note: Note; attached: boolean };
type ImageRow = { id: string; position: number; deleted_at: Date | null; path: string; sha256: string };
type ToolResult = {
  isError?: boolean;
  content: Array<{ type: 'text'; text: string } | { type: string }>;
};

const ID = /^[0-9A-Z]-[0-9A-Z]{3}$/;

async function filesUnder(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out.sort();
}

function solid(r: number, g: number, b: number): Promise<Buffer> {
  return makeImage('png', 32, 32, { r, g, b });
}

async function imageRows(h: Harness, noteId: string): Promise<ImageRow[]> {
  const res = await h.deps.db.execute<ImageRow>(
    sql`select id, position, deleted_at, path, sha256 from note_images where note_id = ${noteId} order by position`,
  );
  return res.rows;
}

describe('HTTP attach / remove / restore one image', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
  });

  async function upload(bytes: Buffer, name = 'shot.png'): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name, { type: 'image/png' }));
    const res = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  async function attach(noteId: string, bytes: Buffer, name = 'more.png', app: Hono = h.app): Promise<Response> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name, { type: 'image/png' }));
    return app.request(`/api/notes/${noteId}/images`, { method: 'POST', body: fd });
  }

  async function attachOk(noteId: string, bytes: Buffer, name = 'more.png'): Promise<AttachBody> {
    const res = await attach(noteId, bytes, name);
    expect(res.status).toBe(201);
    return (await res.json()) as AttachBody;
  }

  async function removeImg(imageId: string): Promise<Response> {
    return h.app.request(`/api/images/${imageId}`, { method: 'DELETE' });
  }

  async function restoreImg(imageId: string): Promise<Response> {
    return h.app.request(`/api/images/${imageId}/restore`, { method: 'POST' });
  }

  it('attaches more images to a note that already has one, in order, as new files', async () => {
    const first = await upload(await solid(10, 20, 30));
    expect(first.images.map((i) => i.id)).toEqual([first.id]);

    const bytes2 = await solid(40, 50, 60);
    const res = await attach(first.id, bytes2, 'second.png');
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(true);
    expect(body.note.id).toBe(first.id);
    expect(body.note.images).toHaveLength(2);
    expect(body.note.images[0]!.id).toBe(first.id);
    const second = body.note.images[1]!;
    expect(second.id).toMatch(ID);
    expect(second.id).not.toBe(first.id);
    expect(second.position).toBe(1);
    expect(second.note_id).toBe(first.id);
    expect(second.original_name).toBe('second.png');
    expect(second.available).toBe(true);
    expect(second.urls.thumb).toBe(`/api/images/${second.id}/thumb`);
    // A fresh image id is never also a note id.
    expect(await h.deps.service.getOne(second.id, { includeDeleted: true })).toBeNull();

    const rows = await imageRows(h, first.id);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[1]!.path).toMatch(new RegExp(`^images/\\d{4}/\\d{2}/${second.id}\\.png$`));
    expect(await readFile(path.join(h.dataDir, rows[1]!.path))).toEqual(bytes2);
    expect((await h.app.request(`/api/images/${second.id}/thumb`)).status).toBe(200);

    const third = await attachOk(first.id, await solid(70, 80, 90), 'third.png');
    expect(third.note.images.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it('attaches to a text note and accepts any id spelling', async () => {
    await insertTextNote(h, 'T-XT1', 'just words');
    const res = await attach('txt1', await solid(1, 200, 1));
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.note.id).toBe('T-XT1');
    expect(body.note.body).toBe('just words');
    expect(body.note.images).toHaveLength(1);
    expect(body.note.images[0]!.position).toBe(0);
  });

  it('dedupes per live image across notes: the holder comes back and nothing is copied', async () => {
    const bytes = await solid(1, 2, 3);
    const holder = await upload(bytes);
    await insertTextNote(h, 'T-XT1', 'another note');
    const before = await filesUnder(path.join(h.dataDir, 'images'));

    const res = await attach('T-XT1', bytes, 'copy.png');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(false);
    expect(body.note.id).toBe(holder.id);
    expect(await imageRows(h, 'T-XT1')).toEqual([]);
    expect(await filesUnder(path.join(h.dataDir, 'images'))).toEqual(before);
  });

  it('dedupes within the same note', async () => {
    const n = await upload(await solid(9, 9, 9));
    const bytes = await solid(8, 8, 8);
    await attachOk(n.id, bytes);
    const again = await attach(n.id, bytes, 'same-again.png');
    expect(again.status).toBe(200);
    const body = (await again.json()) as AttachBody;
    expect(body.attached).toBe(false);
    expect(body.note.id).toBe(n.id);
    expect(body.note.images).toHaveLength(2);
    expect(await imageRows(h, n.id)).toHaveLength(2);
  });

  it('a deleted holder note is restored and returned', async () => {
    const bytes = await solid(11, 12, 13);
    const holder = await upload(bytes);
    await h.deps.service.delete(holder.id);
    await insertTextNote(h, 'T-XT1', 'target');

    const res = await attach('T-XT1', bytes);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(false);
    expect(body.note.id).toBe(holder.id);
    expect(body.note.deleted_at).toBeUndefined();
    expect(await h.deps.service.getOne(holder.id)).not.toBeNull();
  });

  it('a removed image does not count for dedupe', async () => {
    const n = await upload(await solid(20, 21, 22));
    const bytes = await solid(23, 24, 25);
    const b = (await attachOk(n.id, bytes)).note.images[1]!;
    expect((await removeImg(b.id)).status).toBe(200);
    await insertTextNote(h, 'T-XT1', 'target');

    const body = await attachOk('T-XT1', bytes);
    expect(body.attached).toBe(true);
    expect(body.note.id).toBe('T-XT1');
    expect(body.note.images[0]!.id).not.toBe(b.id);
  });

  it('refuses unknown, deleted and malformed note ids, non-images, oversized uploads and a missing file', async () => {
    const png = await solid(30, 31, 32);

    const unknown = await attach('Z-ZZZ', png);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe('not_found');

    const gone = await h.deps.service.create({ body: 'soon deleted' });
    await h.deps.service.delete(gone.id);
    expect((await attach(gone.id, png)).status).toBe(404);

    const bad = await attach('not-an-id', png);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_id');

    await insertTextNote(h, 'T-XT1', 'target');
    const notImage = await attach('T-XT1', Buffer.from('hello, not a picture'), 'a.txt');
    expect(notImage.status).toBe(415);
    expect(((await notImage.json()) as { error: string }).error).toBe('not_an_image');

    const small = new Hono().route('/', imageRoutes(h.deps, { maxUploadBytes: 1024 }));
    const big = Buffer.concat([await makeImage('png', 300, 300, { r: 250, g: 1, b: 250 }), Buffer.alloc(4096, 7)]);
    const tooBig = await attach('T-XT1', big, 'big.png', small);
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { error: string }).error).toBe('too_large');

    const fd = new FormData();
    fd.append('body', 'no file');
    const noFile = await h.app.request('/api/notes/T-XT1/images', { method: 'POST', body: fd });
    expect(noFile.status).toBe(400);
    expect(((await noFile.json()) as { error: string }).error).toBe('file_required');

    expect(await filesUnder(path.join(h.dataDir, 'images'))).toEqual([]);
    expect(await imageRows(h, 'T-XT1')).toEqual([]);
  });

  it('remove keeps the file and the slot; restore puts the image back at its old position', async () => {
    const n = await upload(await solid(40, 41, 42));
    const b = (await attachOk(n.id, await solid(43, 44, 45))).note.images[1]!;
    const c = (await attachOk(n.id, await solid(46, 47, 48))).note.images[2]!;

    const removed = await removeImg(b.id);
    expect(removed.status).toBe(200);
    const afterRemove = (await removed.json()) as Note;
    expect(afterRemove.id).toBe(n.id);
    expect(afterRemove.images.map((i) => i.id)).toEqual([n.id, c.id]);

    // Idempotent.
    const again = await removeImg(b.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Note).images.map((i) => i.id)).toEqual([n.id, c.id]);

    const rowB = (await imageRows(h, n.id)).find((r) => r.id === b.id)!;
    expect(rowB.deleted_at).not.toBeNull();
    await access(path.join(h.dataDir, rowB.path)); // the original stays on disk
    // The bin still serves its thumbnail (phase 2: any existing row is served).
    expect((await h.app.request(`/api/images/${b.id}/thumb`)).status).toBe(200);

    // A later attach goes after every slot, removed ones included.
    const d = (await attachOk(n.id, await solid(49, 50, 51))).note.images[2]!;
    expect(d.position).toBe(3);

    const restored = await restoreImg(b.id);
    expect(restored.status).toBe(200);
    const afterRestore = (await restored.json()) as Note;
    expect(afterRestore.images.map((i) => i.id)).toEqual([n.id, b.id, c.id, d.id]);
    expect(afterRestore.images.map((i) => i.position)).toEqual([0, 1, 2, 3]);

    // Restoring a live image of a live note changes nothing.
    const noop = await restoreImg(b.id);
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as Note).images.map((i) => i.id)).toEqual([n.id, b.id, c.id, d.id]);
  });

  it('restoring an image whose bytes are live elsewhere is a 409 naming the holder', async () => {
    const bytes = await solid(60, 61, 62);
    const n1 = await upload(bytes);
    expect((await removeImg(n1.id)).status).toBe(200);
    const n2 = await upload(bytes); // the removed image does not dedupe, so this is a new note
    expect(n2.id).not.toBe(n1.id);

    const res = await restoreImg(n1.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; note_id: string | null };
    expect(body.error).toBe('duplicate_image');
    expect(body.note_id).toBe(n2.id);
    expect((await imageRows(h, n1.id))[0]!.deleted_at).not.toBeNull();
  });

  it('restoring a removed image of a deleted note restores the note too', async () => {
    const n = await upload(await solid(70, 71, 72));
    const b = (await attachOk(n.id, await solid(73, 74, 75))).note.images[1]!;
    expect((await removeImg(b.id)).status).toBe(200);
    await h.deps.service.delete(n.id);

    const res = await restoreImg(b.id);
    expect(res.status).toBe(200);
    const note = (await res.json()) as Note;
    expect(note.id).toBe(n.id);
    expect(note.deleted_at).toBeUndefined();
    expect(note.images.map((i) => i.id)).toEqual([n.id, b.id]);
  });

  it('answers 404 for unknown image ids and 400 for malformed ones', async () => {
    expect((await removeImg('Z-ZZZ')).status).toBe(404);
    expect((await restoreImg('Z-ZZZ')).status).toBe(404);
    const bad = await removeImg('nope!!');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_id');
    expect((await restoreImg('nope!!')).status).toBe(400);
  });

  it('emits one updated event with the note id per change, none for a no-op', async () => {
    const n = await upload(await solid(80, 81, 82));
    const seen: NoteEvent[] = [];
    const off = h.deps.events.on((e) => seen.push(e));
    try {
      const b = (await attachOk(n.id, await solid(83, 84, 85))).note.images[1]!;
      await removeImg(b.id);
      await removeImg(b.id);
      await restoreImg(b.id);
    } finally {
      off();
    }
    const updated = { type: 'note', op: 'updated', id: n.id };
    expect(seen).toEqual([updated, updated, updated]);
  });

  it('two concurrent attaches of the same bytes leave exactly one live image', async () => {
    await insertTextNote(h, 'T-XT1', 'one');
    await insertTextNote(h, 'T-XT2', 'two');
    const bytes = await solid(90, 91, 92);
    const [r1, r2] = await Promise.all([attach('T-XT1', bytes), attach('T-XT2', bytes)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const b1 = (await r1.json()) as AttachBody;
    const b2 = (await r2.json()) as AttachBody;
    expect(b1.note.id).toBe(b2.note.id);
    const sha = (await imageRows(h, b1.note.id))[0]!.sha256;
    const live = await h.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from note_images where sha256 = ${sha} and deleted_at is null`,
    );
    expect(live.rows[0]?.n).toBe(1);
  });
});

describe('MCP attach_image / remove_image / restore_image', () => {
  let h: Harness;
  let client: Client;
  let srcDir: string;

  beforeAll(async () => {
    h = await startHarness();
    const base = await h.listen();
    client = new Client({ name: 'p3-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    srcDir = path.join(h.dataDir, '..', `p3-src-${process.pid}`);
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

  function textOf(r: ToolResult): string {
    return r.content.flatMap((c) => (c.type === 'text' ? [(c as { text: string }).text] : [])).join('\n');
  }

  async function file(name: string, bytes: Buffer): Promise<string> {
    const p = path.join(srcDir, name);
    await writeFile(p, bytes);
    return p;
  }

  async function attachTool(id: string, p: string): Promise<AttachBody> {
    const r = await call('attach_image', { id, path: p });
    expect(r.isError, textOf(r)).toBeFalsy();
    return JSON.parse(textOf(r)) as AttachBody;
  }

  it('lists the three tools and no tool that deletes permanently', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['attach_image', 'remove_image', 'restore_image']));
    expect(names.filter((n) => /purge|forever|destroy/.test(n))).toEqual([]);
  });

  it('attach_image copies the file into the note, dedupes, and leaves the source in place', async () => {
    const n = await h.deps.service.create({ body: 'words #seer' });
    const p = await file('shot.png', await solid(100, 101, 102));

    const r = await call('attach_image', { id: n.id.toLowerCase().replace('-', ''), path: p, origin: { cwd: '/tmp' } });
    expect(r.isError, textOf(r)).toBeFalsy();
    const first = JSON.parse(textOf(r)) as AttachBody;
    expect(first.attached).toBe(true);
    expect(first.note.id).toBe(n.id);
    expect(first.note.body).toBe('words #seer');
    expect(first.note.images).toHaveLength(1);
    expect(first.note.images[0]!.original_name).toBe('shot.png');
    await access(p);

    const again = await attachTool(n.id, p);
    expect(again.attached).toBe(false);
    expect(again.note.id).toBe(n.id);
    expect(again.note.images).toHaveLength(1);
  });

  it('remove_image and restore_image round-trip and keep the position', async () => {
    const n = await h.deps.service.create({ body: 'two pictures' });
    const a = (await attachTool(n.id, await file('a.png', await solid(110, 0, 0)))).note.images[0]!;
    const b = (await attachTool(n.id, await file('b.png', await solid(0, 110, 0)))).note.images[1]!;

    const removed = await call('remove_image', { image_id: a.id });
    expect(removed.isError, textOf(removed)).toBeFalsy();
    expect((JSON.parse(textOf(removed)) as { note: Note }).note.images.map((i) => i.id)).toEqual([b.id]);

    const restored = await call('restore_image', { image_id: a.id.toLowerCase() });
    expect(restored.isError, textOf(restored)).toBeFalsy();
    const note = (JSON.parse(textOf(restored)) as { note: Note }).note;
    expect(note.images.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(note.images.map((i) => i.position)).toEqual([0, 1]);
  });

  it('reports clashes, deleted notes, relative paths and unknown image ids as tool errors', async () => {
    const bytes = await solid(120, 121, 122);
    const n1 = await h.deps.service.create({ body: 'first holder' });
    const x1 = (await attachTool(n1.id, await file('x.png', bytes))).note.images[0]!;
    expect((await call('remove_image', { image_id: x1.id })).isError).toBeFalsy();
    const n2 = await h.deps.service.create({ body: 'second holder' });
    expect((await attachTool(n2.id, await file('x-again.png', bytes))).attached).toBe(true);

    const clash = await call('restore_image', { image_id: x1.id });
    expect(clash.isError).toBe(true);
    expect(textOf(clash)).toMatch(/^duplicate_image: /);
    expect(textOf(clash)).toContain(`already in note ${n2.id}`);

    const n3 = await h.deps.service.create({ body: 'deleted target' });
    await h.deps.service.delete(n3.id);
    const deleted = await call('attach_image', { id: n3.id, path: await file('y.png', await solid(1, 1, 1)) });
    expect(deleted.isError).toBe(true);
    expect(textOf(deleted)).toMatch(/^deleted: /);

    const relative = await call('attach_image', { id: n2.id, path: 'relative/shot.png' });
    expect(relative.isError).toBe(true);
    expect(textOf(relative)).toContain('not_absolute');

    const unknown = await call('remove_image', { image_id: 'Z-ZZZ' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toMatch(/^not_found: /);
  });
});
