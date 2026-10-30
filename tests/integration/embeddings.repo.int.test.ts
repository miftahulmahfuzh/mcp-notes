import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Db } from '../../src/db/client.js'
import { noteEmbeddings, notes } from '../../src/db/schema.js'
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../src/embeddings/constants.js'
import {
  currentBodySha256Sql,
  embeddingStats,
  isCurrentEmbeddingSql,
  listPending,
  recordFailure,
  saveEmbedding,
} from '../../src/embeddings/repo.js'
import { bodySha256, retryDelayMs } from '../../src/embeddings/state.js'
import { closeTestDb, openTestDb, truncateAll } from './setup.js'

const M = EMBEDDING_MODEL

/** A unit vector along axis `i`. */
function axis(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  v[i] = 1
  return v
}

async function insertNote(
  db: Db,
  id: string,
  body: string,
  opts: { updatedAt?: Date; deleted?: boolean } = {},
): Promise<void> {
  await db.insert(notes).values({
    id,
    body,
    updatedAt: opts.updatedAt ?? new Date(),
    deletedAt: opts.deleted ? new Date() : null,
  })
}

async function row(db: Db, id: string) {
  const [r] = await db
    .select({
      bodySha256: noteEmbeddings.bodySha256,
      model: noteEmbeddings.model,
      attempts: noteEmbeddings.attempts,
      lastError: noteEmbeddings.lastError,
      nextAttemptAt: noteEmbeddings.nextAttemptAt,
      embeddedAt: noteEmbeddings.embeddedAt,
      hasVector: sql<boolean>`${noteEmbeddings.embedding} is not null`,
    })
    .from(noteEmbeddings)
    .where(eq(noteEmbeddings.noteId, id))
  return r
}

async function pendingIds(db: Db, opts: { ignoreBackoff?: boolean; model?: string } = {}): Promise<string[]> {
  const rows = await listPending(db, { model: opts.model ?? M, limit: 100, ignoreBackoff: opts.ignoreBackoff })
  return rows.map((r) => r.id)
}

describe('embeddings repo', () => {
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

  describe('body hash', () => {
    const bodies: Array<[string, string]> = [
      ['ascii', 'arango root password is in the vault #ops'],
      ['emoji', 'deploy 🚀 done 👩🏽‍💻 ok'],
      ['crlf', 'line one\r\nline two\r\n'],
      ['lf', 'line one\nline two\n'],
      ['cjk + accents', 'café naïve 日本語 ünïcödé'],
      ['empty', ''],
      ['long', 'ab🚀'.repeat(5000)],
    ]

    it.each(bodies)('SQL and JS agree on %s', async (_name, body) => {
      await insertNote(db, 'A-B32', body)
      const res = await db.execute<{ h: string }>(
        sql`select ${currentBodySha256Sql()} as h from notes where id = 'A-B32'`,
      )
      expect(res.rows[0]?.h).toBe(bodySha256(body))
    })
  })

  describe('listPending', () => {
    it('returns notes with text and no row, live first, then newest updated', async () => {
      await insertNote(db, 'A-001', 'old live', { updatedAt: new Date('2026-01-01T00:00:00Z') })
      await insertNote(db, 'A-002', 'new live', { updatedAt: new Date('2026-06-01T00:00:00Z') })
      await insertNote(db, 'A-003', 'newest deleted', { updatedAt: new Date('2026-09-01T00:00:00Z'), deleted: true })
      await insertNote(db, 'A-004', '')
      await insertNote(db, 'A-005', ' \n\t ')
      await insertNote(db, 'A-006', ' 　﻿ ')

      const rows = await listPending(db, { model: M, limit: 10 })
      expect(rows.map((r) => r.id)).toEqual(['A-002', 'A-001', 'A-003'])
      expect(rows[0]).toEqual({ id: 'A-002', body: 'new live', bodySha256: bodySha256('new live') })
    })

    it('honours the limit', async () => {
      await insertNote(db, 'A-001', 'one')
      await insertNote(db, 'A-002', 'two')
      expect(await listPending(db, { model: M, limit: 1 })).toHaveLength(1)
    })

    it('drops a note once it has a current vector, brings it back when the body or model changes', async () => {
      await insertNote(db, 'A-001', 'first')
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('first'), model: M, embedding: axis(0) })).toBe(true)
      expect(await pendingIds(db)).toEqual([])

      expect(await pendingIds(db, { model: 'other/model' })).toEqual(['A-001'])

      await db.update(notes).set({ body: 'second' }).where(eq(notes.id, 'A-001'))
      const rows = await listPending(db, { model: M, limit: 10 })
      expect(rows).toEqual([{ id: 'A-001', body: 'second', bodySha256: bodySha256('second') }])
    })

    it('holds a failed note until next_attempt_at, unless ignoreBackoff', async () => {
      await insertNote(db, 'A-001', 'body')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, error: 'timeout' })
      expect(await pendingIds(db)).toEqual([])
      expect(await pendingIds(db, { ignoreBackoff: true })).toEqual(['A-001'])

      await db.update(noteEmbeddings).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(noteEmbeddings.noteId, 'A-001'))
      expect(await pendingIds(db)).toEqual(['A-001'])
    })

    it('makes a failed note due at once when its body changes', async () => {
      await insertNote(db, 'A-001', 'body')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, error: 'timeout' })
      await db.update(notes).set({ body: 'edited body' }).where(eq(notes.id, 'A-001'))
      expect(await pendingIds(db)).toEqual(['A-001'])
    })

    it('includes deleted notes so a restore needs no call', async () => {
      await insertNote(db, 'A-001', 'gone', { deleted: true })
      expect(await pendingIds(db)).toEqual(['A-001'])
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('gone'), model: M, embedding: axis(1) })
      expect(await pendingIds(db)).toEqual([])
      expect((await row(db, 'A-001'))?.hasVector).toBe(true)
    })
  })

  describe('saveEmbedding', () => {
    it('writes the vector and resets the failure fields', async () => {
      await insertNote(db, 'A-001', 'body')
      const h = bodySha256('body')
      await recordFailure(db, { noteId: 'A-001', bodySha256: h, model: M, error: 'boom' })
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: h, model: M, embedding: axis(2) })).toBe(true)
      const r = await row(db, 'A-001')
      expect(r).toMatchObject({ bodySha256: h, model: M, attempts: 0, lastError: null, nextAttemptAt: null, hasVector: true })
      expect(r?.embeddedAt).toBeInstanceOf(Date)
    })

    it('skips when the body changed while the call was in flight', async () => {
      await insertNote(db, 'A-001', 'v1')
      const h1 = bodySha256('v1')
      await db.update(notes).set({ body: 'v2' }).where(eq(notes.id, 'A-001'))
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: h1, model: M, embedding: axis(3) })).toBe(false)
      expect(await row(db, 'A-001')).toBeUndefined()
    })

    it('does not overwrite a newer vector with a stale one', async () => {
      await insertNote(db, 'A-001', 'v2')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('v2'), model: M, embedding: axis(4) })
      expect(await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, embedding: axis(5) })).toBe(false)
      expect((await row(db, 'A-001'))?.bodySha256).toBe(bodySha256('v2'))
    })

    it('returns false for an unknown note', async () => {
      expect(await saveEmbedding(db, { noteId: 'Z-ZZZ', bodySha256: bodySha256('x'), model: M, embedding: axis(0) })).toBe(false)
    })

    it('is idempotent', async () => {
      await insertNote(db, 'A-001', 'body')
      const v = { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, embedding: axis(6) }
      expect(await saveEmbedding(db, v)).toBe(true)
      expect(await saveEmbedding(db, v)).toBe(true)
      const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from note_embeddings`)
      expect(n.rows[0]?.n).toBe(1)
    })

    it('rejects a vector of the wrong width before touching the database', async () => {
      await insertNote(db, 'A-001', 'body')
      await expect(
        saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('body'), model: M, embedding: [1, 0, 0] }),
      ).rejects.toThrow(/expected 1536/)
    })
  })

  describe('recordFailure', () => {
    it('counts consecutive failures for one body and backs off', async () => {
      await insertNote(db, 'A-001', 'body')
      const h = bodySha256('body')
      for (const expected of [1, 2, 3]) {
        const before = Date.now()
        await recordFailure(db, { noteId: 'A-001', bodySha256: h, model: M, error: `fail ${expected}` })
        const r = await row(db, 'A-001')
        expect(r).toMatchObject({ attempts: expected, lastError: `fail ${expected}`, hasVector: false, embeddedAt: null })
        const wait = r!.nextAttemptAt!.getTime() - before
        expect(wait).toBeGreaterThan(retryDelayMs(expected) - 5_000)
        expect(wait).toBeLessThan(retryDelayMs(expected) + 5_000)
      }
    })

    it('restarts the count when the failure is for another body or model', async () => {
      await insertNote(db, 'A-001', 'v1')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, error: 'a' })
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, error: 'b' })
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: 'other/model', error: 'c' })
      expect((await row(db, 'A-001'))?.attempts).toBe(1)

      await db.update(notes).set({ body: 'v2' }).where(eq(notes.id, 'A-001'))
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v2'), model: M, error: 'd' })
      expect(await row(db, 'A-001')).toMatchObject({ attempts: 1, bodySha256: bodySha256('v2'), model: M })
    })

    it('replaces a stale vector with a failure row for the new body', async () => {
      await insertNote(db, 'A-001', 'v1')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, embedding: axis(7) })
      await db.update(notes).set({ body: 'v2' }).where(eq(notes.id, 'A-001'))
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v2'), model: M, error: 'down' })
      expect(await row(db, 'A-001')).toMatchObject({ hasVector: false, attempts: 1, bodySha256: bodySha256('v2'), embeddedAt: null })
    })

    it('never wipes a current vector (another daemon already succeeded)', async () => {
      await insertNote(db, 'A-001', 'body')
      const h = bodySha256('body')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: h, model: M, embedding: axis(8) })
      await recordFailure(db, { noteId: 'A-001', bodySha256: h, model: M, error: 'late failure' })
      expect(await row(db, 'A-001')).toMatchObject({ hasVector: true, attempts: 0, lastError: null })
    })

    it('ignores a failure for a body the note no longer has', async () => {
      await insertNote(db, 'A-001', 'v2')
      await recordFailure(db, { noteId: 'A-001', bodySha256: bodySha256('v1'), model: M, error: 'old' })
      expect(await row(db, 'A-001')).toBeUndefined()
    })

    it('ignores an unknown note instead of violating the foreign key', async () => {
      await expect(recordFailure(db, { noteId: 'Z-ZZZ', bodySha256: bodySha256('x'), model: M, error: 'x' })).resolves.toBeUndefined()
    })

    it('stores a redacted, clamped error', async () => {
      await insertNote(db, 'A-001', 'body')
      await recordFailure(db, {
        noteId: 'A-001',
        bodySha256: bodySha256('body'),
        model: M,
        error: `401 Bearer sk-or-v1-secret ${'z'.repeat(1000)}`,
      })
      const r = await row(db, 'A-001')
      expect(r?.lastError).not.toContain('sk-or-')
      expect(r?.lastError?.length).toBeLessThanOrEqual(500)
    })
  })

  describe('isCurrentEmbeddingSql', () => {
    it('is true only for a vector made from the current body by the given model', async () => {
      await insertNote(db, 'A-001', 'current')
      await insertNote(db, 'A-002', 'was v1')
      await insertNote(db, 'A-003', 'failed')
      await insertNote(db, 'A-004', 'no row')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('current'), model: M, embedding: axis(0) })
      await saveEmbedding(db, { noteId: 'A-002', bodySha256: bodySha256('was v1'), model: M, embedding: axis(1) })
      await db.update(notes).set({ body: 'now v2' }).where(eq(notes.id, 'A-002'))
      await recordFailure(db, { noteId: 'A-003', bodySha256: bodySha256('failed'), model: M, error: 'x' })

      const res = await db.execute<{ id: string; cur: boolean }>(sql`
        select notes.id, coalesce(${isCurrentEmbeddingSql(M)}, false) as cur
        from notes left join note_embeddings on note_embeddings.note_id = notes.id
        order by notes.id
      `)
      expect(res.rows).toEqual([
        { id: 'A-001', cur: true },
        { id: 'A-002', cur: false },
        { id: 'A-003', cur: false },
        { id: 'A-004', cur: false },
      ])
      const other = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from notes join note_embeddings on note_embeddings.note_id = notes.id
        where ${isCurrentEmbeddingSql('other/model')}
      `)
      expect(other.rows[0]?.n).toBe(0)
    })
  })

  describe('embeddingStats', () => {
    it('counts with-text, current, pending and failing over live and deleted notes', async () => {
      await insertNote(db, 'A-001', 'embedded')
      await insertNote(db, 'A-002', 'embedded then deleted', { deleted: true })
      await insertNote(db, 'A-003', 'failing')
      await insertNote(db, 'A-004', 'missing')
      await insertNote(db, 'A-005', '   ')
      await saveEmbedding(db, { noteId: 'A-001', bodySha256: bodySha256('embedded'), model: M, embedding: axis(0) })
      await saveEmbedding(db, { noteId: 'A-002', bodySha256: bodySha256('embedded then deleted'), model: M, embedding: axis(1) })
      await recordFailure(db, { noteId: 'A-003', bodySha256: bodySha256('failing'), model: M, error: 'x' })

      expect(await embeddingStats(db, M)).toEqual({ withText: 4, current: 2, pending: 2, failing: 1 })
      expect(await embeddingStats(db, 'other/model')).toEqual({ withText: 4, current: 0, pending: 4, failing: 0 })
    })

    it('is all zeros on an empty table', async () => {
      expect(await embeddingStats(db, M)).toEqual({ withText: 0, current: 0, pending: 0, failing: 0 })
    })
  })
})
