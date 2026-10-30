import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { noteImages, notes, type NewNoteImageRow } from '../../src/db/schema.js'
import {
  findImageById,
  findLiveImageBySha256,
  imageIdTaken,
  imagesForNotes,
  insertImage,
  isLiveShaClash,
  nextPosition,
  setImageDeleted,
} from '../../src/notes/imageRepo.js'
import { NoteError } from '../../src/notes/types.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

function image(id: string, noteId: string, sha256: string, position: number, extra: Partial<NewNoteImageRow> = {}): NewNoteImageRow {
  return {
    id,
    noteId,
    path: `images/2026/10/${id}.png`,
    sha256,
    mime: 'image/png',
    width: 10,
    height: 20,
    bytes: 300,
    position,
    ...extra,
  }
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  )
}

async function expectNoteError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await caught(p)
  expect(err).toBeInstanceOf(NoteError)
  expect((err as NoteError).code).toBe(code)
}

describe('imageRepo', () => {
  let db: Db

  beforeAll(() => {
    db = openTestDb()
  })
  afterAll(async () => {
    await closeTestDb(db)
  })
  beforeEach(async () => {
    await truncateAll(db)
    await db.insert(notes).values([
      { id: 'N-001', body: 'first' },
      { id: 'N-002', body: 'second' },
      { id: 'N-003', body: 'no images' },
    ])
  })

  it('inserts a row with defaults and finds it by id', async () => {
    const row = await insertImage(
      db,
      image('N-001', 'N-001', 'sha-a', 0, { takenAt: new Date('2026-08-14T09:30:00.000Z'), originalName: 'a.png', host: 'h' }),
    )
    expect(row).toMatchObject({ id: 'N-001', noteId: 'N-001', position: 0, deletedAt: null, originalName: 'a.png', host: 'h' })
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.takenAt?.toISOString()).toBe('2026-08-14T09:30:00.000Z')
    expect(await findImageById(db, 'N-001')).toEqual(row)
    expect(await findImageById(db, 'Z-ZZZ')).toBeNull()
  })

  it('refuses a second live image with the same bytes, in any note, as duplicate_image', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await expectNoteError(insertImage(db, image('X-001', 'N-002', 'sha-a', 0)), 'duplicate_image')
    await expectNoteError(insertImage(db, image('X-002', 'N-001', 'sha-a', 1)), 'duplicate_image')
  })

  it('lets a removed image release its sha256', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await setImageDeleted(db, 'N-001', true)
    const again = await insertImage(db, image('X-001', 'N-002', 'sha-a', 0))
    expect(again.deletedAt).toBeNull()
  })

  it('rethrows a taken path or id unchanged (not duplicate_image)', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    const pathClash = await caught(insertImage(db, image('X-001', 'N-002', 'sha-b', 0, { path: 'images/2026/10/N-001.png' })))
    expect(pathClash).not.toBeInstanceOf(NoteError)
    expect(isLiveShaClash(pathClash)).toBe(false)
    const idClash = await caught(insertImage(db, image('N-001', 'N-002', 'sha-c', 0, { path: 'images/2026/10/other.png' })))
    expect(idClash).not.toBeInstanceOf(NoteError)
  })

  it('finds the live holder of a sha256 with its note deleted time', async () => {
    expect(await findLiveImageBySha256(db, 'sha-a')).toBeNull()
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    const live = await findLiveImageBySha256(db, 'sha-a')
    expect(live?.image.id).toBe('N-001')
    expect(live?.noteDeletedAt).toBeNull()

    await db.update(notes).set({ deletedAt: new Date('2026-10-30T00:00:00.000Z') }).where(eq(notes.id, 'N-001'))
    const inDeletedNote = await findLiveImageBySha256(db, 'sha-a')
    expect(inDeletedNote?.image.id).toBe('N-001')
    expect(inDeletedNote?.noteDeletedAt?.toISOString()).toBe('2026-10-30T00:00:00.000Z')

    await setImageDeleted(db, 'N-001', true)
    expect(await findLiveImageBySha256(db, 'sha-a')).toBeNull()
  })

  it('computes the next position over every row of the note, removed included', async () => {
    expect(await nextPosition(db, 'N-001')).toBe(0)
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await insertImage(db, image('X-001', 'N-001', 'sha-b', 1))
    await insertImage(db, image('X-002', 'N-001', 'sha-c', 2))
    expect(await nextPosition(db, 'N-001')).toBe(3)
    await setImageDeleted(db, 'X-002', true)
    expect(await nextPosition(db, 'N-001')).toBe(3)
    expect(await nextPosition(db, 'N-002')).toBe(0)
  })

  it('treats an id as taken when it is a note id or an image id', async () => {
    await insertImage(db, image('X-001', 'N-001', 'sha-a', 0))
    expect(await imageIdTaken(db, 'N-003')).toBe(true)
    expect(await imageIdTaken(db, 'X-001')).toBe(true)
    expect(await imageIdTaken(db, 'Q-999')).toBe(false)
    await setImageDeleted(db, 'X-001', true)
    expect(await imageIdTaken(db, 'X-001')).toBe(true)
  })

  it('removes idempotently (keeping the first time), restores, and reports unknown ids', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    const removed = await setImageDeleted(db, 'N-001', true)
    expect(removed.deletedAt).toBeInstanceOf(Date)
    const again = await setImageDeleted(db, 'N-001', true)
    expect(again.deletedAt?.getTime()).toBe(removed.deletedAt?.getTime())
    const restored = await setImageDeleted(db, 'N-001', false)
    expect(restored.deletedAt).toBeNull()
    expect(restored.position).toBe(0)
    await expectNoteError(setImageDeleted(db, 'Z-ZZZ', true), 'not_found')
  })

  it('refuses to restore an image whose bytes now live elsewhere', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await setImageDeleted(db, 'N-001', true)
    await insertImage(db, image('X-001', 'N-002', 'sha-a', 0))
    await expectNoteError(setImageDeleted(db, 'N-001', false), 'duplicate_image')
    expect((await findImageById(db, 'N-001'))?.deletedAt).toBeInstanceOf(Date)
  })

  it('loads images per note in position order, with a key for every requested note', async () => {
    await insertImage(db, image('X-003', 'N-001', 'sha-c', 2))
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await insertImage(db, image('X-001', 'N-001', 'sha-b', 1))
    await insertImage(db, image('N-002', 'N-002', 'sha-d', 0))
    await setImageDeleted(db, 'X-001', true)

    const live = await imagesForNotes(db, ['N-001', 'N-002', 'N-003', 'N-001'])
    expect([...live.keys()]).toEqual(['N-001', 'N-002', 'N-003'])
    expect(live.get('N-001')?.map((r) => r.id)).toEqual(['N-001', 'X-003'])
    expect(live.get('N-002')?.map((r) => r.id)).toEqual(['N-002'])
    expect(live.get('N-003')).toEqual([])

    const all = await imagesForNotes(db, ['N-001'], { includeRemoved: true })
    expect(all.get('N-001')?.map((r) => r.id)).toEqual(['N-001', 'X-001', 'X-003'])

    expect((await imagesForNotes(db, [])).size).toBe(0)
  })

  it('cascades a note row removal to its images', async () => {
    await insertImage(db, image('N-001', 'N-001', 'sha-a', 0))
    await insertImage(db, image('X-001', 'N-001', 'sha-b', 1))
    await db.delete(notes).where(eq(notes.id, 'N-001'))
    expect(await db.select().from(noteImages)).toHaveLength(0)
  })
})
