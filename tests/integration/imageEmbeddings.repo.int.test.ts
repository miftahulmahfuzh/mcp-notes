import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IMAGE_EMBEDDING_MODEL } from '../../src/embeddings/imageConstants.js';
import {
  imageEmbeddingStats,
  listPendingImages,
  nearestImages,
  recordImageFailure,
  saveImageEmbedding,
} from '../../src/embeddings/imageRepo.js';
import { setImageDeleted } from '../../src/notes/imageRepo.js';
import { vectorForColour, type Rgb } from '../helpers/fakeImageEmbedder.js';
import { addImage, startHarness, type Harness } from './imageHarness.js';

const M = IMAGE_EMBEDDING_MODEL;
const RED: Rgb = { r: 220, g: 20, b: 20 };
const RED2: Rgb = { r: 221, g: 20, b: 20 };
const RED3: Rgb = { r: 219, g: 21, b: 20 };
const DARK_RED: Rgb = { r: 110, g: 10, b: 10 };
const BLUE: Rgb = { r: 20, g: 20, b: 220 };
const GREEN: Rgb = { r: 20, g: 200, b: 20 };

type EmbRow = { image_sha256: string; model: string; has_vector: boolean; attempts: number; last_error: string | null; due: boolean };

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

/** A note created through the service (tags parsed) holding one image of colour `rgb`; returns the image id (= note id). */
async function photo(rgb: Rgb, body = 'a photo #pics'): Promise<string> {
  const note = await h.deps.service.create({ body });
  return addImage(h, note.id, note.id, 0, rgb);
}

async function shaOf(imageId: string): Promise<string> {
  const r = await h.deps.db.execute<{ sha256: string }>(sql`select sha256 from note_images where id = ${imageId}`);
  return r.rows[0]!.sha256;
}

async function embed(imageId: string, rgb: Rgb, model = M): Promise<boolean> {
  return saveImageEmbedding(h.deps.db, { imageId, imageSha256: await shaOf(imageId), model, embedding: vectorForColour(rgb) });
}

async function row(imageId: string): Promise<EmbRow | null> {
  const r = await h.deps.db.execute<EmbRow>(sql`
    select image_sha256, model, embedding is not null as has_vector, attempts, last_error,
           (next_attempt_at is null or next_attempt_at <= now()) as due
    from note_image_embeddings where image_id = ${imageId}
  `);
  return r.rows[0] ?? null;
}

describe('listPendingImages', () => {
  it('lists every image without a current vector, live ones of live notes first, and honours excludeIds', async () => {
    const a = await photo(RED);
    const b = await photo(BLUE);
    const c = await photo(GREEN);
    await setImageDeleted(h.deps.db, b, true);
    await h.deps.service.delete(c);
    const pending = await listPendingImages(h.deps.db, { model: M, limit: 10 });
    expect(pending.map((p) => p.id).sort()).toEqual([a, b, c].sort());
    expect(pending[0]).toMatchObject({ id: a, noteId: a, live: true, width: 12, height: 12, mime: 'image/png' });
    expect(pending.filter((p) => !p.live).map((p) => p.id).sort()).toEqual([b, c].sort());
    const excluded = await listPendingImages(h.deps.db, { model: M, limit: 10, excludeIds: [a, c] });
    expect(excluded.map((p) => p.id)).toEqual([b]);
  });

  it('a current vector leaves the list; another model or other bytes bring it back', async () => {
    const a = await photo(RED);
    expect(await embed(a, RED)).toBe(true);
    expect(await listPendingImages(h.deps.db, { model: M, limit: 10 })).toEqual([]);
    expect((await listPendingImages(h.deps.db, { model: 'other/model', limit: 10 })).map((p) => p.id)).toEqual([a]);
    await h.deps.db.execute(sql`update note_images set sha256 = ${'e'.repeat(64)} where id = ${a}`);
    expect((await listPendingImages(h.deps.db, { model: M, limit: 10 })).map((p) => p.id)).toEqual([a]);
  });
});

describe('saveImageEmbedding / recordImageFailure', () => {
  it('saving is guarded by the image sha and rejects a wrong width', async () => {
    const a = await photo(RED);
    expect(
      await saveImageEmbedding(h.deps.db, { imageId: a, imageSha256: 'f'.repeat(64), model: M, embedding: vectorForColour(RED) }),
    ).toBe(false);
    expect(await row(a)).toBeNull();
    await expect(
      saveImageEmbedding(h.deps.db, { imageId: a, imageSha256: await shaOf(a), model: M, embedding: [1, 0, 0] }),
    ).rejects.toThrow(/3 dimensions, expected 1536/);
    expect(await embed(a, RED)).toBe(true);
    expect(await row(a)).toMatchObject({ has_vector: true, attempts: 0, model: M });
  });

  it('failures count attempts and back off, and never overwrite a current vector', async () => {
    const a = await photo(RED);
    const sha = await shaOf(a);
    await recordImageFailure(h.deps.db, { imageId: a, imageSha256: sha, model: M, error: 'boom Bearer sk-or-v1-SECRET' });
    expect(await row(a)).toMatchObject({ has_vector: false, attempts: 1, due: false });
    expect((await row(a))!.last_error).not.toContain('SECRET');
    expect(await listPendingImages(h.deps.db, { model: M, limit: 10 })).toEqual([]);
    expect((await listPendingImages(h.deps.db, { model: M, limit: 10, ignoreBackoff: true })).map((p) => p.id)).toEqual([a]);
    await recordImageFailure(h.deps.db, { imageId: a, imageSha256: sha, model: M, error: 'again' });
    expect(await row(a)).toMatchObject({ attempts: 2 });
    expect(await embed(a, RED)).toBe(true);
    await recordImageFailure(h.deps.db, { imageId: a, imageSha256: sha, model: M, error: 'late failure from the other laptop' });
    expect(await row(a)).toMatchObject({ has_vector: true, attempts: 0 });
  });
});

describe('nearestImages', () => {
  it('from an image: closest first, never the source, a removed image or a deleted note', async () => {
    const a = await photo(RED);
    const b = await photo(DARK_RED);
    const c = await photo(BLUE);
    const d = await photo(RED2);
    const e = await photo(RED3);
    for (const [id, rgb] of [[a, RED], [b, DARK_RED], [c, BLUE], [d, RED2], [e, RED3]] as const) await embed(id, rgb);
    await setImageDeleted(h.deps.db, d, true);
    await h.deps.service.delete(e);
    const hits = await nearestImages(h.deps.db, { source: { imageId: a }, model: M, limit: 10 });
    expect(hits!.map((x) => x.imageId)).toEqual([b, c]);
    expect(hits![0]!.noteId).toBe(b);
    expect(hits![0]!.similarity).toBeGreaterThan(0.99);
    expect(hits![1]!.similarity).toBeLessThan(0.5);
    expect(Number.isInteger(hits![0]!.similarity * 10_000)).toBe(true);
  });

  it('null for a source without a current vector; a raw vector source is never null', async () => {
    const a = await photo(RED);
    const b = await photo(DARK_RED);
    await embed(a, RED, 'other/model');
    await embed(b, DARK_RED);
    expect(await nearestImages(h.deps.db, { source: { imageId: a }, model: M, limit: 5 })).toBeNull();
    const fromVector = await nearestImages(h.deps.db, { source: { vector: vectorForColour(RED) }, model: M, limit: 5 });
    expect(fromVector!.map((x) => x.imageId)).toEqual([b]);
    await expect(nearestImages(h.deps.db, { source: { vector: [1, 2] }, model: M, limit: 5 })).rejects.toThrow(/2 dimensions/);
  });

  it('respects limit', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const rgb = { r: 200 + i, g: 20, b: 20 };
      const id = await photo(rgb);
      await embed(id, rgb);
      ids.push(id);
    }
    expect(await nearestImages(h.deps.db, { source: { imageId: ids[0]! }, model: M, limit: 2 })).toHaveLength(2);
  });
});

describe('imageEmbeddingStats and the migration', () => {
  it('counts images, current, pending and failing', async () => {
    const a = await photo(RED);
    const b = await photo(BLUE);
    await photo(GREEN);
    await embed(a, RED);
    await recordImageFailure(h.deps.db, { imageId: b, imageSha256: await shaOf(b), model: M, error: 'x' });
    expect(await imageEmbeddingStats(h.deps.db, M)).toEqual({ images: 3, current: 1, pending: 2, failing: 1 });
  });

  it('created the HNSW cosine index, and rows go away with their image', async () => {
    const idx = await h.deps.db.execute<{ indexname: string; indexdef: string }>(sql`
      select indexname, indexdef from pg_indexes where tablename = 'note_image_embeddings'
    `);
    const byName = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.get('note_image_embeddings_embedding_hnsw_idx')).toMatch(/hnsw .*vector_cosine_ops/);
    expect(byName.has('note_image_embeddings_next_attempt_idx')).toBe(true);
    const a = await photo(RED);
    await embed(a, RED);
    await h.deps.db.execute(sql`delete from notes where id = ${a}`);
    expect(await row(a)).toBeNull();
  });
});
