import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestImage, locateImage, type ImageDeps } from '../../../src/images/ingest.js';
import { sha256Hex, UnsupportedImageError } from '../../../src/images/probe.js';
import { fileExists } from '../../../src/images/store.js';
import { FakeNotes } from '../../helpers/fakeNotes.js';
import { fixtureBytes, HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN, tempDir } from '../../helpers/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
let notes: FakeNotes;
let deps: ImageDeps;
const SAVED = new Date(2026, 9, 30, 9, 0, 0);

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  notes = new FakeNotes();
  deps = { dataDir: dir, notes, records: notes, hostname: () => 'lenovo', now: () => SAVED };
});
afterEach(async () => cleanup());

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.relative(root, path.join(e.parentPath, e.name)));
  }
  return out.sort();
}

describe('ingestImage', () => {
  it('stores the original byte for byte and records the metadata', async () => {
    const bytes = await fixtureBytes(JPEG_EXIF);
    const { note, created } = await ingestImage(deps, { bytes, originalName: 'IMG_0001.JPG', body: 'hello #cat' });
    expect(created).toBe(true);
    const rec = (await notes.byImageId(note.id))!;
    expect(rec.path).toBe(`images/2026/10/${note.id}.jpg`);
    expect(Buffer.compare(await readFile(path.join(dir, rec.path)), bytes)).toBe(0);
    expect(rec.meta).toMatchObject({
      mime: 'image/jpeg',
      width: 64,
      height: 48,
      bytes: bytes.byteLength,
      original_name: 'IMG_0001.JPG',
      host: 'lenovo',
    });
    expect(rec.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.meta.taken_at).toBe(new Date(2024, 9, 30, 14, 5, 9).toISOString());
    expect(note.body).toBe('hello #cat');
    expect(note.images.map((i) => i.id)).toEqual([note.id]);
    expect(rec).toMatchObject({ id: note.id, note_id: note.id, position: 0, deleted_at: null, note_deleted_at: null });
  });

  it('the same bytes twice return the same note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes, originalName: 'a.png' });
    const b = await ingestImage(deps, { bytes, originalName: 'b.png' });
    expect(b).toEqual({ note: a.note, created: false });
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(1);
  });

  it('concurrent ingests of the same bytes create one note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const results = await Promise.all(Array.from({ length: 5 }, () => ingestImage(deps, { bytes })));
    expect(new Set(results.map((r) => r.note.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(1);
  });

  it('a soft-deleted duplicate is restored and returned', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    notes.softDelete(first.note.id);
    const again = await ingestImage(deps, { bytes });
    expect(again.created).toBe(false);
    expect(again.note.id).toBe(first.note.id);
    expect(again.note.deleted_at).toBeUndefined();
  });

  it('a duplicate whose original is missing here gets the bytes put back', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    const rec = (await notes.byImageId(first.note.id))!;
    await rm(path.join(dir, rec.path));
    const again = await ingestImage(deps, { bytes });
    expect(again.created).toBe(false);
    expect(Buffer.compare(await readFile(path.join(dir, rec.path)), bytes)).toBe(0);
  });

  it('path + move: renames the source into the store', async () => {
    const src = path.join(dir, 'drop', 'IMG_9.HEIC');
    await mkdir(path.dirname(src), { recursive: true });
    await copyFile(HEIC_PHOTO, src);
    const { note } = await ingestImage(deps, { path: src, move: true, origin: { source: 'inbox' } });
    expect(await fileExists(src)).toBe(false);
    const rec = (await notes.byImageId(note.id))!;
    expect(rec.path).toBe(`images/2026/10/${note.id}.heic`);
    expect(rec.meta.mime).toBe('image/heic');
    expect(rec.meta.original_name).toBe('IMG_9.HEIC');
    expect(note.origin).toEqual({ source: 'inbox' });
    expect(Buffer.compare(await readFile(path.join(dir, rec.path)), await fixtureBytes(HEIC_PHOTO))).toBe(0);
  });

  it('path without move: copies, source untouched', async () => {
    const src = path.join(dir, 'shot.png');
    await copyFile(PNG_PLAIN, src);
    await ingestImage(deps, { path: src });
    expect(await fileExists(src)).toBe(true);
  });

  it('path + move on a duplicate consumes the source', async () => {
    await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const src = path.join(dir, 'dup.png');
    await copyFile(PNG_PLAIN, src);
    const r = await ingestImage(deps, { path: src, move: true });
    expect(r.created).toBe(false);
    expect(await fileExists(src)).toBe(false);
  });

  it('rejects non-images and writes nothing', async () => {
    await expect(ingestImage(deps, { bytes: Buffer.from('not an image'), originalName: 'x.jpg' })).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
    expect(notes.rows.size).toBe(0);
    expect(await fileExists(path.join(dir, 'images'))).toBe(false);
  });

  it('removes the written file when the insert fails', async () => {
    notes.failNextCreate = new Error('connection reset');
    await expect(ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) })).rejects.toThrow('connection reset');
    expect(await listFiles(dir)).toEqual([]);
  });

  it('moves the source back when the insert fails after a move', async () => {
    const src = path.join(dir, 'keep.png');
    await copyFile(PNG_PLAIN, src);
    notes.failNextCreate = new Error('db down');
    await expect(ingestImage(deps, { path: src, move: true })).rejects.toThrow('db down');
    expect(await fileExists(src)).toBe(true);
    expect(await listFiles(path.join(dir, 'images')).catch(() => [])).toEqual([]);
  });

  it('a concurrent insert of the same bytes by another host resolves to that note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    // Another host inserts the same bytes between our lookup and our insert.
    notes.beforeInsert = async () => {
      notes.beforeInsert = null;
      const relPath = 'images/2026/10/G-PD1.png';
      notes.seed({
        id: 'G-PD1',
        image: {
          path: relPath,
          meta: {
            sha256: sha256Hex(bytes),
            mime: 'image/png',
            width: 40,
            height: 30,
            bytes: bytes.byteLength,
            taken_at: null,
            original_name: null,
            host: 'gpd',
          },
        },
      });
    };
    const r = await ingestImage(deps, { bytes });
    expect(r).toMatchObject({ created: false, note: { id: 'G-PD1' } });
    // the loser's file is gone; the winner's original was missing here, so the bytes were placed at its path
    expect(await listFiles(path.join(dir, 'images'))).toEqual(['2026/10/G-PD1.png']);
  });

  it('retries with a new id when the id is taken', async () => {
    let calls = 0;
    notes.beforeInsert = (id) => {
      calls++;
      if (calls === 1) {
        notes.seed({ id, body: 'squatter' });
      }
    };
    const r = await ingestImage(deps, { bytes: await fixtureBytes(JPEG_EXIF) });
    expect(r.created).toBe(true);
    expect(calls).toBe(2);
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(1);
  });

  it('a removed image does not dedupe: the same bytes become a new note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    notes.removeImage(first.note.id);
    const again = await ingestImage(deps, { bytes });
    expect(again.created).toBe(true);
    expect(again.note.id).not.toBe(first.note.id);
    expect(await listFiles(path.join(dir, 'images'))).toHaveLength(2);
  });

  it('a live image in a deleted note restores that note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const first = await ingestImage(deps, { bytes });
    notes.softDelete(first.note.id);
    expect((await notes.bySha256Live(sha256Hex(bytes)))!.note_deleted_at).not.toBeNull();
    const again = await ingestImage(deps, { bytes });
    expect(again).toMatchObject({ created: false, note: { id: first.note.id } });
    expect(again.note.deleted_at).toBeUndefined();
  });
});

describe('locateImage', () => {
  it('reports availability and host', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const loc = (await locateImage(deps, note.id))!;
    expect(loc).toMatchObject({ id: note.id, mime: 'image/png', available: true, host: 'lenovo', deleted: false });
    expect(loc).toMatchObject({ noteId: note.id, position: 0, imageDeleted: false, noteDeleted: false });
    notes.removeImage(note.id);
    expect((await locateImage(deps, note.id))!).toMatchObject({ imageDeleted: true, deleted: true });
    await rm(loc.originalPath);
    expect((await locateImage(deps, note.id))!.available).toBe(false);
    expect(await locateImage(deps, 'X-XXX')).toBeNull();
  });
});
