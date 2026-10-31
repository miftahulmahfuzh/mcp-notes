import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileRoutes } from '../../src/http/files.js';
import type { NoteEvent } from '../../src/notes/events.js';
import { imageIdTaken } from '../../src/notes/imageRepo.js';
import { NoteError, type Note, type NoteFile } from '../../src/notes/types.js';
import { insertTextNote, makeImage, startHarness, type Harness } from './imageHarness.js';

type AttachBody = { note: Note; attached: boolean; kind: 'file' | 'image' };
type Requester = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

const ID = /^[0-9A-Z]-[0-9A-Z]{3}$/;
const OWN_ORIGIN = 'http://localhost';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('note files over HTTP', () => {
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

  function upload(noteId: string, bytes: Buffer, name: string, app: Requester = h.app): Promise<Response> {
    const fd = new FormData();
    fd.append('file', new File([bytes], name));
    return Promise.resolve(app.request(`/api/notes/${noteId}/files`, { method: 'POST', body: fd }));
  }

  async function attach(noteId: string, bytes: Buffer, name: string): Promise<AttachBody> {
    const res = await upload(noteId, bytes, name);
    expect([200, 201]).toContain(res.status);
    return (await res.json()) as AttachBody;
  }

  async function getNote(id: string): Promise<Note> {
    const res = await h.app.request(`/api/notes/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Note;
  }

  async function fileCount(): Promise<number> {
    const res = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from note_files`);
    return res.rows[0]?.n ?? -1;
  }

  it('attaches a non-image file under files/<noteId>/ with its metadata', async () => {
    await insertTextNote(h, 'A-B32', 'report');
    const res = await upload('a-b32', Buffer.from('hello notes'), 'notes.txt');
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.attached).toBe(true);
    expect(body.kind).toBe('file');
    expect(body.note.id).toBe('A-B32');
    expect(body.note.images).toEqual([]);
    expect(body.note.files).toHaveLength(1);
    const f = body.note.files[0]!;
    expect(f.id).toMatch(ID);
    expect(f).toEqual({
      id: f.id,
      note_id: 'A-B32',
      position: 0,
      name: 'notes.txt',
      mime: 'text/plain',
      bytes: 11,
      host: os.hostname(),
      available: true,
      extraction_status: 'none',
      urls: { download: `/api/files/${f.id}/download` },
    });
    expect(await readFile(path.join(h.dataDir, 'files', 'A-B32', 'notes.txt'), 'utf8')).toBe('hello notes');
    const row = await h.deps.db.execute<{ path: string; extraction_status: string; extracted_text: string | null }>(
      sql`select path, extraction_status, extracted_text from note_files where id = ${f.id}`,
    );
    expect(row.rows[0]).toEqual({ path: 'files/A-B32/notes.txt', extraction_status: 'none', extracted_text: null });
    expect((await getNote('A-B32')).files.map((x) => x.id)).toEqual([f.id]);
  });

  it('shares the id space: a file id is taken for notes and images too', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attach('A-B32', Buffer.from('id space'), 'a.txt')).note.files[0]!;
    expect(await imageIdTaken(h.deps.db, f.id)).toBe(true);
    await expect(h.deps.service.create({ id: f.id, body: 'clash' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.deps.service.create({ id: f.id, body: 'clash' })).rejects.toBeInstanceOf(NoteError);
  });

  it('stores a Windows-safe name, keeps the user name for display, and suffixes a clash', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = await attach('A-B32', Buffer.from('first'), 're:port?.txt');
    const b = await attach('A-B32', Buffer.from('second'), 're:port?.txt');
    expect(a.note.files[0]!.name).toBe('re:port?.txt');
    expect(b.note.files.map((f) => [f.name, f.position])).toEqual([
      ['re:port?.txt', 0],
      ['re:port?.txt', 1],
    ]);
    expect((await readdir(path.join(h.dataDir, 'files', 'A-B32'))).sort()).toEqual(['re_port_ (2).txt', 're_port_.txt']);
  });

  it('skips a name another machine already used (row exists, file not here)', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = await attach('A-B32', Buffer.from('elsewhere'), 'same.txt');
    await rm(path.join(h.dataDir, 'files', 'A-B32', 'same.txt'));
    await attach('A-B32', Buffer.from('here'), 'same.txt');
    const rows = await h.deps.db.execute<{ id: string; path: string }>(sql`select id, path from note_files order by position`);
    expect(rows.rows).toEqual([
      { id: a.note.files[0]!.id, path: 'files/A-B32/same.txt' },
      { id: expect.stringMatching(ID), path: 'files/A-B32/same (2).txt' },
    ]);
  });

  it('returns the holder note for bytes that already live anywhere, restoring a deleted holder', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    await attach('A-B32', Buffer.from('same bytes'), 'a.txt');

    const res = await upload('C-D45', Buffer.from('same bytes'), 'b.txt');
    expect(res.status).toBe(200);
    const dup = (await res.json()) as AttachBody;
    expect(dup.attached).toBe(false);
    expect(dup.kind).toBe('file');
    expect(dup.note.id).toBe('A-B32');
    expect((await getNote('C-D45')).files).toEqual([]);

    expect((await h.app.request('/api/notes/A-B32', { method: 'DELETE' })).status).toBe(200);
    const again = await attach('C-D45', Buffer.from('same bytes'), 'b.txt');
    expect(again.attached).toBe(false);
    expect(again.note.id).toBe('A-B32');
    expect(again.note.deleted_at).toBeUndefined();
    expect(await fileCount()).toBe(1);
  });

  it('puts the bytes back at the holder path when this machine lacks them', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    await attach('A-B32', Buffer.from('travelled'), 'a.txt');
    const onDisk = path.join(h.dataDir, 'files', 'A-B32', 'a.txt');
    await rm(onDisk);
    const dup = await attach('C-D45', Buffer.from('travelled'), 'b.txt');
    expect(dup.attached).toBe(false);
    expect(await readFile(onDisk, 'utf8')).toBe('travelled');
    expect(dup.note.files[0]!.available).toBe(true);
  });

  it('stores concurrent uploads of the same bytes once', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    const bytes = Buffer.from('raced bytes');
    const [x, y] = await Promise.all([upload('A-B32', bytes, 'x.bin'), upload('C-D45', bytes, 'y.bin')]);
    const bodies = [(await x.json()) as AttachBody, (await y.json()) as AttachBody];
    expect(bodies.filter((b) => b.attached)).toHaveLength(1);
    expect(await fileCount()).toBe(1);
  });

  it('delegates bytes that sniff as a supported image to the image store', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const png = await makeImage('png', 16, 16, { r: 1, g: 2, b: 3 });
    const res = await upload('A-B32', png, 'screenshot.bin');
    expect(res.status).toBe(201);
    const body = (await res.json()) as AttachBody;
    expect(body.kind).toBe('image');
    expect(body.attached).toBe(true);
    expect(body.note.images).toHaveLength(1);
    expect(body.note.files).toEqual([]);
    expect(await exists(path.join(h.dataDir, 'files', 'A-B32'))).toBe(false);
    expect(await fileCount()).toBe(0);
  });

  it('stores a file named like an image whose bytes are not one', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const body = await attach('A-B32', Buffer.from('not really a png'), 'fake.png');
    expect(body.kind).toBe('file');
    expect(body.note.files[0]).toMatchObject({ name: 'fake.png', mime: 'application/octet-stream' });
  });

  it('refuses empty, missing, malformed, unknown, deleted and too large', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    await insertTextNote(h, 'C-D45', 'gone');
    await h.app.request('/api/notes/C-D45', { method: 'DELETE' });

    const empty = await upload('A-B32', Buffer.alloc(0), 'empty.txt');
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toBe('empty_file');

    const fd = new FormData();
    fd.append('other', 'x');
    const missing = await h.app.request('/api/notes/A-B32/files', { method: 'POST', body: fd });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'file_required' });

    expect((await upload('not-an-id', Buffer.from('x'), 'x.txt')).status).toBe(400);
    const unknown = await upload('Z-ZZZ', Buffer.from('x'), 'x.txt');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'not_found' });
    expect((await upload('C-D45', Buffer.from('x'), 'x.txt')).status).toBe(404);

    const small = new Hono().route('/', fileRoutes(h.deps, { maxUploadBytes: 1024 }));
    const big = await upload('A-B32', Buffer.alloc(2048, 7), 'big.bin', small);
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string; max_bytes: number })).toMatchObject({ error: 'too_large', max_bytes: 1024 });
    expect(await fileCount()).toBe(0);
  });

  it('removes and restores a file at its old position, one updated event each', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = (await attach('A-B32', Buffer.from('a'), 'a.txt')).note.files[0]!;
    const b = (await attach('A-B32', Buffer.from('b'), 'b.txt')).note.files[1]!;
    const seen: NoteEvent[] = [];
    const off = h.deps.events.on((e) => seen.push(e));

    const removed = await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as Note).files.map((f) => f.id)).toEqual([b.id]);
    const json = (await (await h.app.request(`/api/files/${a.id}`)).json()) as NoteFile;
    expect(json.deleted_at).toBeDefined();
    expect(json.position).toBe(0);
    expect(await exists(path.join(h.dataDir, 'files', 'A-B32', 'a.txt'))).toBe(true);

    expect((await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' })).status).toBe(200);

    const restored = await h.app.request(`/api/files/${a.id.toLowerCase().replace('-', '')}/restore`, { method: 'POST' });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as Note).files.map((f) => f.id)).toEqual([a.id, b.id]);
    off();
    expect(seen).toEqual([
      { type: 'note', op: 'updated', id: 'A-B32' },
      { type: 'note', op: 'updated', id: 'A-B32' },
    ]);
  });

  it('restoring a file of a deleted note restores the note', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const a = (await attach('A-B32', Buffer.from('a'), 'a.txt')).note.files[0]!;
    await h.app.request('/api/notes/A-B32', { method: 'DELETE' });
    const res = await h.app.request(`/api/files/${a.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const note = (await res.json()) as Note;
    expect(note.deleted_at).toBeUndefined();
    expect(note.files.map((f) => f.id)).toEqual([a.id]);
  });

  it('refuses to restore a file whose bytes now live in another note', async () => {
    await insertTextNote(h, 'A-B32', 'one');
    await insertTextNote(h, 'C-D45', 'two');
    const a = (await attach('A-B32', Buffer.from('moved'), 'a.txt')).note.files[0]!;
    await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' });
    const moved = await attach('C-D45', Buffer.from('moved'), 'a.txt');
    expect(moved.attached).toBe(true);
    const res = await h.app.request(`/api/files/${a.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'duplicate_file', note_id: 'C-D45' });
  });

  it('404s unknown file ids and 400s malformed ones on the write routes', async () => {
    expect((await h.app.request('/api/files/Z-ZZZ')).status).toBe(404);
    expect((await h.app.request('/api/files/nope')).status).toBe(404);
    expect((await h.app.request('/api/files/Z-ZZZ', { method: 'DELETE' })).status).toBe(404);
    expect((await h.app.request('/api/files/not-an-id', { method: 'DELETE' })).status).toBe(400);
    expect((await h.app.request('/api/files/Z-ZZZ/restore', { method: 'POST' })).status).toBe(404);
    expect((await h.app.request('/api/files/Z-ZZZ/download')).status).toBe(404);
  });

  it('downloads as an attachment, never inline, in any state', async () => {
    await insertTextNote(h, 'A-B32', 'x');
    const f = (await attach('A-B32', Buffer.from('%PDF-1.4\n%fake\n'), 'résumé final.pdf')).note.files[0]!;
    expect(f.mime).toBe('application/pdf');

    const res = await h.app.request(f.urls.download);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="r_sum_ final.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20final.pdf`,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const etag = res.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.4\n%fake\n');

    const cached = await h.app.request(f.urls.download, { headers: { 'If-None-Match': etag! } });
    expect(cached.status).toBe(304);

    await h.app.request(`/api/files/${f.id}`, { method: 'DELETE' });
    expect((await h.app.request(f.urls.download)).status).toBe(200);

    await rm(path.join(h.dataDir, 'files', 'A-B32', 'résumé final.pdf'));
    const gone = await h.app.request(f.urls.download);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: 'not_on_this_machine', host: os.hostname() });
  });

  it('purging a deleted note removes its files folder, removed files included, and nothing else', async () => {
    await insertTextNote(h, 'A-B32', 'doomed');
    await insertTextNote(h, 'C-D45', 'kept');
    const a = (await attach('A-B32', Buffer.from('a'), 'a.txt')).note.files[0]!;
    await attach('A-B32', Buffer.from('b'), 'b.txt');
    await attach('A-B32', await makeImage('png', 8, 8, { r: 9, g: 9, b: 9 }), 'pic.png');
    await attach('C-D45', Buffer.from('c'), 'c.txt');
    await h.app.request(`/api/files/${a.id}`, { method: 'DELETE' });
    await h.app.request('/api/notes/A-B32', { method: 'DELETE' });

    const res = await h.app.request('/api/bin/notes/A-B32', { method: 'DELETE', headers: { Origin: OWN_ORIGIN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: string; files: number };
    expect(body.purged).toBe('A-B32');
    expect(body.files).toBeGreaterThanOrEqual(3);
    expect(await exists(path.join(h.dataDir, 'files', 'A-B32'))).toBe(false);
    expect(await readFile(path.join(h.dataDir, 'files', 'C-D45', 'c.txt'), 'utf8')).toBe('c');
    expect(await fileCount()).toBe(1);
  });

  it('a purge that cannot remove a file still succeeds and keeps the leftover', async () => {
    await insertTextNote(h, 'A-B32', 'doomed');
    await attach('A-B32', Buffer.from('a'), 'a.txt');
    const target = path.join(h.dataDir, 'files', 'A-B32', 'a.txt');
    await rm(target);
    await mkdir(target);
    await writeFile(path.join(target, 'inner'), 'i');
    await h.app.request('/api/notes/A-B32', { method: 'DELETE' });

    const res = await h.app.request('/api/bin/notes/A-B32', { method: 'DELETE', headers: { Origin: OWN_ORIGIN } });
    expect(res.status).toBe(200);
    expect(await fileCount()).toBe(0);
    expect(await exists(path.join(target, 'inner'))).toBe(true);
  });
});
