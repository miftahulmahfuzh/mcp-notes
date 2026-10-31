import { readFileSync } from 'node:fs'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { noteEmbeddings, noteImages, noteRevisions, notes, type ImageMeta } from '../../src/db/schema.js'
import { MIGRATIONS_DIR, closeTestDb, migrateTestDb, openTestDb, truncateAll } from './setup.js'

function imageMeta(sha256: string, takenAt: string | null = null): ImageMeta {
  return {
    sha256,
    mime: 'image/jpeg',
    width: 10,
    height: 10,
    bytes: 100,
    taken_at: takenAt,
    original_name: 'x.jpg',
    host: 'test-host',
  }
}

function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err
  while (cur && typeof cur === 'object') {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string') return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

describe('schema (migrations 0000 + 0001 + 0002)', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
  })

  it('creates every index the plan set relies on', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' order by indexname`,
    )
    const names = res.rows.map((r) => r.indexname)
    expect(names).toEqual(
      expect.arrayContaining([
        'notes_pkey',
        'notes_tags_gin',
        'notes_body_fts_gin',
        'notes_created_at_idx',
        'notes_updated_at_idx',
        'notes_image_sha256_live_uniq',
        'notes_image_taken_at_idx',
        'note_revisions_pkey',
        'note_revisions_note_saved_idx',
        'note_embeddings_pkey',
        'note_embeddings_embedding_hnsw_idx',
        'note_embeddings_next_attempt_idx',
        'note_images_pkey',
        'note_images_path_uniq',
        'note_images_note_position_idx',
        'note_images_sha256_live_uniq',
        'note_images_taken_at_idx',
      ]),
    )
  })

  it('applies column defaults', async () => {
    const [row] = await db.insert(notes).values({ id: 'A-B32', body: 'hello' }).returning()
    expect(row).toBeDefined()
    expect(row?.tags).toEqual([])
    expect(row?.imagePath).toBeNull()
    expect(row?.imageMeta).toBeNull()
    expect(row?.origin).toBeNull()
    expect(row?.deletedAt).toBeNull()
    expect(row?.createdAt).toBeInstanceOf(Date)
    expect(row?.updatedAt).toBeInstanceOf(Date)
  })

  it('round-trips tags, origin and image_meta', async () => {
    await db.insert(notes).values({
      id: 'C-D45',
      body: '#seer #from_phone',
      tags: ['seer', 'from_phone'],
      origin: { cwd: '/home/x', repo: 'seer', source: 'mcp' },
      imagePath: 'images/2026/10/C-D45.jpg',
      imageMeta: imageMeta('abc', '2026-10-30T01:02:03.000Z'),
    })
    const [row] = await db.select().from(notes).where(eq(notes.id, 'C-D45'))
    expect(row?.tags).toEqual(['seer', 'from_phone'])
    expect(row?.origin).toEqual({ cwd: '/home/x', repo: 'seer', source: 'mcp' })
    expect(row?.imageMeta?.taken_at).toBe('2026-10-30T01:02:03.000Z')
  })

  it('stores revisions with an increasing id, linked to the note', async () => {
    await db.insert(notes).values({ id: 'E-F67', body: 'v3' })
    await db.insert(noteRevisions).values([
      { noteId: 'E-F67', body: 'v1' },
      { noteId: 'E-F67', body: 'v2' },
    ])
    const revs = await db.select().from(noteRevisions).where(eq(noteRevisions.noteId, 'E-F67'))
    expect(revs.map((r) => r.body)).toEqual(['v1', 'v2'])
    expect(revs[1]!.id).toBeGreaterThan(revs[0]!.id)
  })

  it('rejects a revision for a missing note', async () => {
    const err = await db
      .insert(noteRevisions)
      .values({ noteId: 'Z-ZZZ', body: 'x' })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(err)).toBe('23503')
  })

  it('keeps sha256 unique among live notes only', async () => {
    await db.insert(notes).values({ id: 'G-H89', body: '', imageMeta: imageMeta('same') })
    const dup = await db
      .insert(notes)
      .values({ id: 'J-K01', body: '', imageMeta: imageMeta('same') })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(dup)).toBe('23505')

    await db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, 'G-H89'))
    await db.insert(notes).values({ id: 'J-K01', body: '', imageMeta: imageMeta('same') })
    const live = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from notes where image_meta->>'sha256' = 'same' and deleted_at is null`,
    )
    expect(live.rows[0]?.n).toBe(1)
  })

  it('full-text matches code tokens with the simple config', async () => {
    await db.insert(notes).values([
      { id: 'L-M23', body: 'running createDb in src/db/client.ts' },
      { id: 'N-P45', body: 'nothing relevant' },
    ])
    const res = await db.execute<{ id: string }>(
      sql`select id from notes where to_tsvector('simple', body) @@ websearch_to_tsquery('simple', 'running') order by id`,
    )
    expect(res.rows.map((r) => r.id)).toEqual(['L-M23'])
  })

  it('filters tags with the array operators the GIN index serves', async () => {
    await db.insert(notes).values([
      { id: 'Q-R67', body: '', tags: ['seer', 'v250'] },
      { id: 'S-T89', body: '', tags: ['seer'] },
    ])
    const all = await db.select({ id: notes.id }).from(notes).where(sql`${notes.tags} @> array['seer','v250']::text[]`)
    const any = await db.select({ id: notes.id }).from(notes).where(sql`${notes.tags} && array['v250']::text[]`)
    expect(all.map((r) => r.id)).toEqual(['Q-R67'])
    expect(any.map((r) => r.id)).toEqual(['Q-R67'])
  })

  it('wraps a body change and its revision in one transaction', async () => {
    await db.insert(notes).values({ id: 'U-V01', body: 'before' })
    const failed = await db
      .transaction(async (tx) => {
        await tx.insert(noteRevisions).values({ noteId: 'U-V01', body: 'before' })
        await tx.update(notes).set({ body: 'after' }).where(eq(notes.id, 'U-V01'))
        throw new Error('abort')
      })
      .then(() => null, (e: unknown) => e)
    expect(failed).toBeInstanceOf(Error)
    const [row] = await db.select().from(notes).where(eq(notes.id, 'U-V01'))
    expect(row?.body).toBe('before')
    const revs = await db.select().from(noteRevisions)
    expect(revs).toHaveLength(0)
  })

  it('installs pgvector >= 0.8 and an HNSW cosine index on note_embeddings', async () => {
    const ext = await db.execute<{ extname: string; extversion: string }>(
      sql`select extname, extversion from pg_extension where extname = 'vector'`,
    )
    expect(ext.rows).toHaveLength(1)
    // Phases 4 and 5 use `set local hnsw.iterative_scan`, which exists from pgvector 0.8 (Neon: 0.8.6).
    const [major = 0, minor = 0] = (ext.rows[0]?.extversion ?? '0.0').split('.').map(Number)
    expect(major > 0 || minor >= 8).toBe(true)
    const idx = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'note_embeddings_embedding_hnsw_idx'`,
    )
    expect(idx.rows[0]?.indexdef).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/)
  })

  it('re-applying the migrations is a no-op', async () => {
    const count = async () =>
      (await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]?.n
    // One row per journal entry, so a new migration never needs this test touched.
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: unknown[] }
    expect(await count()).toBe(journal.entries.length)
    await migrateTestDb()
    expect(await count()).toBe(journal.entries.length)
  })

  it('applies note_embeddings defaults and enforces the vector width', async () => {
    await db.insert(notes).values({ id: 'W-X23', body: 'hello' })
    const [row] = await db
      .insert(noteEmbeddings)
      .values({ noteId: 'W-X23', bodySha256: 'abc', model: 'm' })
      .returning({
        attempts: noteEmbeddings.attempts,
        embeddedAt: noteEmbeddings.embeddedAt,
        updatedAt: noteEmbeddings.updatedAt,
      })
    expect(row).toMatchObject({ attempts: 0, embeddedAt: null })
    expect(row?.updatedAt).toBeInstanceOf(Date)

    const narrow = await db
      .execute(sql`update note_embeddings set embedding = '[1,2,3]'::vector where note_id = 'W-X23'`)
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(narrow)).toBe('22000')
  })

  it('cascades note_embeddings when a note row is removed', async () => {
    await db.insert(notes).values({ id: 'Y-Z45', body: 'x' })
    await db.insert(noteEmbeddings).values({ noteId: 'Y-Z45', bodySha256: 'abc', model: 'm' })
    await db.delete(notes).where(eq(notes.id, 'Y-Z45'))
    const left = await db.select().from(noteEmbeddings)
    expect(left).toHaveLength(0)
  })

  it('keeps note_images sha256 unique among live images, paths unique, and cascades on note removal', async () => {
    const def = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where indexname = 'note_images_sha256_live_uniq'`,
    )
    expect(def.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* USING btree \(sha256\) WHERE \(deleted_at IS NULL\)/)

    await db.insert(notes).values({ id: 'A-A01', body: '' })
    const base = { noteId: 'A-A01', sha256: 'same', mime: 'image/png', width: 1, height: 1, bytes: 1 }
    await db.insert(noteImages).values({ ...base, id: 'A-A01', path: 'images/2026/10/A-A01.png', position: 0 })
    const dupSha = await db
      .insert(noteImages)
      .values({ ...base, id: 'B-B01', path: 'images/2026/10/B-B01.png', position: 1 })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(dupSha)).toBe('23505')

    await db.insert(noteImages).values({
      ...base,
      id: 'B-B01',
      path: 'images/2026/10/B-B01.png',
      position: 1,
      deletedAt: new Date(),
    })
    const dupPath = await db
      .insert(noteImages)
      .values({ ...base, sha256: 'other', id: 'C-C01', path: 'images/2026/10/A-A01.png', position: 2 })
      .then(() => null, (e: unknown) => e)
    expect(pgErrorCode(dupPath)).toBe('23505')

    await db.delete(notes).where(eq(notes.id, 'A-A01'))
    expect(await db.select().from(noteImages)).toHaveLength(0)
  })
})
