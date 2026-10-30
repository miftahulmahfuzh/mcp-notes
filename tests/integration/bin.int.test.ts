import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NOTES_TOOL_NAMES } from '../../src/chat/status.js';
import { reconcileLegacyImages } from '../../src/images/legacy.js';
import type { NoteEvent } from '../../src/notes/events.js';
import type { Bin, Note, PurgeResult, TagCount } from '../../src/notes/types.js';
import { makeImage, startHarness, type Harness } from './imageHarness.js';

/** app.request builds http://localhost/... URLs, so this is the page's own origin. */
const ORIGIN = 'http://localhost';

describe('recycle bin, restore and delete forever', () => {
  let h: Harness;
  const seen: NoteEvent[] = [];
  let unsubscribe: () => void = () => {};
  let colour = 0;

  beforeAll(async () => {
    h = await startHarness();
    unsubscribe = h.deps.events.on((e) => seen.push(e));
  });
  afterAll(async () => {
    unsubscribe();
    await h.close();
  });
  beforeEach(async () => {
    await h.reset();
    seen.length = 0;
  });

  // ---------- fixtures over the public HTTP surface ----------

  /** Distinct bytes on every call so nothing dedupes by accident. */
  async function png(): Promise<Buffer> {
    colour += 1;
    return makeImage('png', 16, 16, { r: colour % 256, g: Math.floor(colour / 256) % 256, b: 77 });
  }

  async function textNote(body: string): Promise<Note> {
    const res = await h.app.request('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Note;
  }

  async function upload(body: string): Promise<Note> {
    const fd = new FormData();
    fd.append('file', new File([await png()], 'shot.png', { type: 'image/png' }));
    fd.append('body', body);
    const res = await h.app.request('/api/images', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    return ((await res.json()) as { note: Note }).note;
  }

  /** Attaches a new image; returns the note and the new image's id (the last by position). */
  async function attach(noteId: string): Promise<{ note: Note; imageId: string }> {
    const fd = new FormData();
    fd.append('file', new File([await png()], 'more.png', { type: 'image/png' }));
    const res = await h.app.request(`/api/notes/${noteId}/images`, { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const { note } = (await res.json()) as { note: Note; attached: boolean };
    const last = note.images[note.images.length - 1];
    if (!last) throw new Error('attach returned a note without images');
    return { note, imageId: last.id };
  }

  function firstImageId(note: Note): string {
    const first = note.images[0];
    if (!first) throw new Error(`note ${note.id} has no image`);
    return first.id;
  }

  async function removeImage(imageId: string): Promise<void> {
    expect((await h.app.request(`/api/images/${imageId}`, { method: 'DELETE' })).status).toBe(200);
  }

  async function deleteNote(id: string): Promise<void> {
    expect((await h.app.request(`/api/notes/${id}`, { method: 'DELETE' })).status).toBe(200);
  }

  /** Builds cache/<imageId>/thumb.webp. */
  async function thumb(imageId: string): Promise<void> {
    const res = await h.app.request(`/api/images/${imageId}/thumb`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  }

  async function setNoteDeletedAt(id: string, iso: string): Promise<void> {
    await h.deps.db.execute(sql`update notes set deleted_at = ${iso}::timestamptz where id = ${id}`);
  }

  async function setImageDeletedAt(id: string, iso: string): Promise<void> {
    await h.deps.db.execute(sql`update note_images set deleted_at = ${iso}::timestamptz where id = ${id}`);
  }

  async function fetchBin(query = ''): Promise<Bin> {
    const res = await h.app.request(`/api/bin${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Bin;
  }

  async function purge(kind: 'notes' | 'images', id: string, origin: string | null = ORIGIN): Promise<Response> {
    const headers: Record<string, string> = origin === null ? {} : { origin };
    return h.app.request(`/api/bin/${kind}/${id}`, { method: 'DELETE', headers });
  }

  async function imageRow(id: string): Promise<{ id: string; note_id: string; path: string } | undefined> {
    const res = await h.deps.db.execute<{ id: string; note_id: string; path: string }>(
      sql`select id, note_id, path from note_images where id = ${id}`,
    );
    return res.rows[0];
  }

  async function countRows(table: 'notes' | 'note_images' | 'note_revisions', noteId: string): Promise<number> {
    const column = table === 'notes' ? sql.raw('id') : sql.raw('note_id');
    const res = await h.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.raw(table)} where ${column} = ${noteId}`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Every file (not dir) under the data dir's images/ and cache/, relative to the data dir. */
  async function dataFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else out.push(path.relative(h.dataDir, p));
      }
    };
    await walk(path.join(h.dataDir, 'images'));
    await walk(path.join(h.dataDir, 'cache'));
    return out.sort();
  }

  /** The files a purge of these images must remove: each original plus its cache dir's files. */
  function filesOf(before: string[], images: Array<{ id: string; path: string }>): string[] {
    return before.filter((f) => images.some((img) => f === img.path || f.startsWith(`cache/${img.id}/`))).sort();
  }

  // ---------- listing ----------

  /**
   * T  text note "first #a"                     deleted   2026-10-01
   * L  live note "live #a", image L1 live, L2 removed 2026-10-02
   * N  note "photo #a #b", image N1, N2 removed 2026-10-04, note deleted 2026-10-03
   */
  async function seedBin(): Promise<{ t: Note; l: Note; n: Note; l2: string; n1: string; n2: string }> {
    const t = await textNote('first #a');
    const l = await upload('live #a');
    const { imageId: l2 } = await attach(l.id);
    const n = await upload('photo #a #b');
    const { imageId: n2 } = await attach(n.id);
    await removeImage(l2);
    await removeImage(n2);
    await deleteNote(t.id);
    await deleteNote(n.id);
    await setNoteDeletedAt(t.id, '2026-10-01T00:00:00Z');
    await setImageDeletedAt(l2, '2026-10-02T00:00:00Z');
    await setNoteDeletedAt(n.id, '2026-10-03T00:00:00Z');
    await setImageDeletedAt(n2, '2026-10-04T00:00:00Z');
    return { t, l, n, l2, n1: firstImageId(n), n2 };
  }

  it('lists deleted notes and binned images newest-deleted first, each image once', async () => {
    const { t, n, l, l2, n1, n2 } = await seedBin();
    const bin = await fetchBin();

    expect(bin.notes.map((x) => x.id)).toEqual([n.id, t.id]);
    expect(bin.notes[0]?.deleted_at).toBe('2026-10-03T00:00:00.000Z');
    // A deleted note carries its non-removed images only.
    expect(bin.notes[0]?.images.map((i) => i.id)).toEqual([n1]);
    expect(bin.notes[1]?.images).toEqual([]);

    expect(bin.images.map((b) => [b.image.id, b.kind, b.note_id, b.deleted_at])).toEqual([
      [n2, 'image', n.id, '2026-10-04T00:00:00.000Z'],
      [n1, 'note', n.id, '2026-10-03T00:00:00.000Z'],
      [l2, 'image', l.id, '2026-10-02T00:00:00.000Z'],
    ]);
    // deleted_at on the image itself marks removed images only.
    expect(bin.images[0]?.image.deleted_at).toBe('2026-10-04T00:00:00.000Z');
    expect(bin.images[1]?.image.deleted_at).toBeUndefined();
    expect(new Set(bin.images.map((b) => b.image.id)).size).toBe(bin.images.length);
    // The live image of the live note is not in the bin.
    expect(bin.images.some((b) => b.image.id === firstImageId(l))).toBe(false);
  });

  it('applies tag filters as AND on the owning note', async () => {
    const { t, n, l2, n1, n2 } = await seedBin();

    const ab = await fetchBin('?tag=a&tag=%23B');
    expect(ab.notes.map((x) => x.id)).toEqual([n.id]);
    expect(ab.images.map((b) => b.image.id)).toEqual([n2, n1]);

    const a = await fetchBin('?tag=a');
    expect(a.notes.map((x) => x.id)).toEqual([n.id, t.id]);
    expect(a.images.map((b) => b.image.id)).toEqual([n2, n1, l2]);

    const none = await fetchBin('?tag=zzz');
    expect(none).toEqual({ notes: [], images: [] });
  });

  it('sidebar tags still count live notes only', async () => {
    await seedBin();
    const res = await h.app.request('/api/tags');
    const tags = (await res.json()) as TagCount[];
    expect(tags.map((x) => [x.tag, x.count])).toEqual([['a', 1]]);
  });

  it('an empty bin is two empty lists', async () => {
    await textNote('alive');
    expect(await fetchBin()).toEqual({ notes: [], images: [] });
  });

  // ---------- restore ----------

  it('POST /api/notes/:id/restore brings a deleted note back with its images', async () => {
    const note = await upload('two pictures');
    await attach(note.id);
    await deleteNote(note.id);
    expect((await h.app.request(`/api/notes/${note.id}`)).status).toBe(404);

    const res = await h.app.request(`/api/notes/${note.id.replace('-', '').toLowerCase()}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const back = (await res.json()) as Note;
    expect(back.id).toBe(note.id);
    expect(back.deleted_at).toBeUndefined();
    expect(back.images).toHaveLength(2);
    expect(seen).toContainEqual({ type: 'note', op: 'restored', id: note.id });
    expect((await h.app.request(`/api/notes/${note.id}`)).status).toBe(200);
    expect((await fetchBin()).notes).toEqual([]);

    // Restoring a live note is a no-op that returns it.
    const again = await h.app.request(`/api/notes/${note.id}/restore`, { method: 'POST' });
    expect(again.status).toBe(200);
  });

  it('restore answers 404 for an unknown note and 400 for a non-id', async () => {
    expect((await h.app.request('/api/notes/Z-ZZZ/restore', { method: 'POST' })).status).toBe(404);
    expect((await h.app.request('/api/notes/not-an-id/restore', { method: 'POST' })).status).toBe(400);
  });

  // ---------- delete forever ----------

  it('purging a deleted note removes its rows, originals and derived files, and nothing else', async () => {
    const doomed = await upload('doomed #x');
    const { imageId: doomed2 } = await attach(doomed.id);
    const doomed3 = (await attach(doomed.id)).imageId;
    await removeImage(doomed3); // a removed image goes with its note too
    const keep = await upload('keep');
    const keepRemoved = await attach(keep.id);
    await removeImage(keepRemoved.imageId);
    const deletedOther = await upload('also deleted');
    await deleteNote(deletedOther.id);

    const doomedIds = [firstImageId(doomed), doomed2, doomed3];
    const allIds = [...doomedIds, firstImageId(keep), keepRemoved.imageId, firstImageId(deletedOther)];
    for (const id of allIds) await thumb(id);
    const doomedRows = await Promise.all(doomedIds.map(async (id) => (await imageRow(id))!));

    await deleteNote(doomed.id);
    const before = await dataFiles();
    const expectedGone = filesOf(before, doomedRows);
    expect(expectedGone).toHaveLength(6); // 3 originals + 3 thumbs

    const res = await purge('notes', doomed.id);
    expect(res.status).toBe(200);
    expect((await res.json()) as PurgeResult).toEqual({ purged: doomed.id, files: 6 });

    const after = await dataFiles();
    expect(after).toEqual(before.filter((f) => !expectedGone.includes(f)));
    expect(await countRows('notes', doomed.id)).toBe(0);
    expect(await countRows('note_images', doomed.id)).toBe(0);
    expect(await countRows('note_revisions', doomed.id)).toBe(0);
    expect(seen).toContainEqual({ type: 'note', op: 'purged', id: doomed.id });

    // Everything else is still there and still served.
    expect((await h.app.request(`/api/notes/${keep.id}`)).status).toBe(200);
    expect((await h.app.request(`/api/images/${keepRemoved.imageId}/original`)).status).toBe(200);
    expect((await fetchBin()).notes.map((x) => x.id)).toEqual([deletedOther.id]);
  });

  it('purging a removed image deletes its row and files only; its note stays', async () => {
    const note = await upload('keeps one #y');
    const { imageId: gone } = await attach(note.id);
    const control = await upload('control');
    for (const id of [firstImageId(note), gone, firstImageId(control)]) await thumb(id);
    await removeImage(gone);
    const row = (await imageRow(gone))!;
    const before = await dataFiles();
    const expectedGone = filesOf(before, [row]);
    expect(expectedGone).toHaveLength(2);

    const res = await purge('images', gone);
    expect(res.status).toBe(200);
    expect((await res.json()) as PurgeResult).toEqual({ purged: gone, files: 2 });

    expect(await dataFiles()).toEqual(before.filter((f) => !expectedGone.includes(f)));
    expect(await imageRow(gone)).toBeUndefined();
    expect(seen).toContainEqual({ type: 'note', op: 'purged', id: note.id });
    const live = (await (await h.app.request(`/api/notes/${note.id}`)).json()) as Note;
    expect(live.images.map((i) => i.id)).toEqual([firstImageId(note)]);
    expect((await fetchBin()).images).toEqual([]);
  });

  it('purging the legacy image clears notes.image_path / image_meta so the reconcile cannot bring it back', async () => {
    const note = await upload('legacy');
    const legacyId = firstImageId(note);
    expect(legacyId).toBe(note.id);
    await attach(note.id);
    // Make the first image look like an iteration-6 image: the legacy columns name it too.
    await h.deps.db.execute(sql`
      update notes n set image_path = i.path,
        image_meta = jsonb_build_object('sha256', i.sha256, 'mime', i.mime, 'width', i.width, 'height', i.height,
          'bytes', i.bytes, 'taken_at', null, 'original_name', i.original_name, 'host', i.host)
      from note_images i where i.id = n.id and n.id = ${note.id}`);
    await removeImage(legacyId);

    const res = await purge('images', legacyId);
    expect(res.status).toBe(200);

    const legacy = await h.deps.db.execute<{ image_path: string | null; image_meta: unknown }>(
      sql`select image_path, image_meta from notes where id = ${note.id}`,
    );
    expect(legacy.rows[0]).toEqual({ image_path: null, image_meta: null });
    expect(await reconcileLegacyImages(h.deps.db)).toBe(0);
    expect(await imageRow(legacyId)).toBeUndefined();
  });

  it('refuses to purge live items with 409 not_deleted and touches nothing', async () => {
    const live = await upload('live');
    const liveImage = firstImageId(live);
    const deleted = await upload('deleted, image not removed');
    await deleteNote(deleted.id);
    for (const id of [liveImage, firstImageId(deleted)]) await thumb(id);
    const before = await dataFiles();

    for (const [kind, id] of [
      ['notes', live.id],
      ['images', liveImage],
      // An image of a deleted note that was never removed is purged with its note, not alone.
      ['images', firstImageId(deleted)],
    ] as const) {
      const res = await purge(kind, id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'not_deleted' });
    }
    expect(await dataFiles()).toEqual(before);
    expect(seen.some((e) => e.op === 'purged')).toBe(false);
  });

  it('answers 404 for unknown ids and 400 for non-ids', async () => {
    expect((await purge('notes', 'Z-ZZZ')).status).toBe(404);
    expect((await purge('images', 'Z-ZZZ')).status).toBe(404);
    expect((await purge('notes', 'not-an-id')).status).toBe(400);
    expect((await purge('images', 'not-an-id')).status).toBe(400);
  });

  // ---------- Origin guard ----------

  it('purge routes answer 403 without an Origin or with a foreign one, and 200 for the page itself', async () => {
    const note = await upload('guarded');
    const { imageId } = await attach(note.id);
    await removeImage(imageId);
    const other = await upload('guarded too');
    await deleteNote(other.id);
    const before = await dataFiles();

    for (const origin of [null, 'http://evil.example', 'http://localhost:9999', 'null']) {
      for (const [kind, id] of [
        ['notes', other.id],
        ['images', imageId],
      ] as const) {
        const res = await purge(kind, id, origin);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'forbidden_origin' });
      }
    }
    expect(await dataFiles()).toEqual(before);

    expect((await purge('images', imageId)).status).toBe(200);
    expect((await purge('notes', other.id)).status).toBe(200);
  });

  // ---------- MCP can never delete forever ----------

  it('no MCP tool, and no chat-allowed tool, can purge', async () => {
    const client = new Client({ name: 'bin-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: async (input, init) => h.app.request(String(input), init),
      }),
    );
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => /purge|forever/i.test(n))).toEqual([]);
    } finally {
      await client.close();
    }
    expect(NOTES_TOOL_NAMES.filter((n) => /purge|forever/i.test(n))).toEqual([]);
  });
});
