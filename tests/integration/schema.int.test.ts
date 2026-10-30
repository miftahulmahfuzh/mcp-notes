import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { noteRevisions, notes, type ImageMeta } from '../../src/db/schema.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

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

describe('schema (migration 0000)', () => {
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
})
