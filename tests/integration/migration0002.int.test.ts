import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { asc, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { closeDb, createDb, type Db } from '../../src/db/client.js'
import { noteImages, notes, type ImageMeta, type NoteImageRow } from '../../src/db/schema.js'
import { LEGACY_COPY_SQL, reconcileLegacyImages } from '../../src/images/legacy.js'
import { insertImage } from '../../src/notes/imageRepo.js'
import { MIGRATIONS_DIR, testDatabaseUrl } from './setup.js'

/**
 * Migration 0002 on an iteration-6-shaped database: every legacy image (live notes, soft-deleted
 * notes, sha256 clashes) gets exactly one identical `note_images` row, nothing else changes, and
 * the image files are untouched. Runs in its own database inside the Docker container so the
 * shared test DB (already at 0002) is not disturbed.
 */

const DB_PREFIX = 'mcp_notes_mig0002_'

interface LegacyImage {
  bytes: Buffer
  ext: string
  mime: string
  width: number
  height: number
  takenAt: string | null
  originalName: string | null
  host: string | null
}

interface LegacyNote {
  id: string
  body: string
  createdAt: string
  deletedAt: string | null
  image: LegacyImage | null
}

interface FileFacts {
  sha256: string
  size: number
  mtimeMs: number
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function imagePathOf(n: LegacyNote): string | null {
  return n.image ? `images/2026/09/${n.id}.${n.image.ext}` : null
}

function metaOf(n: LegacyNote): ImageMeta | null {
  if (!n.image) return null
  return {
    sha256: sha256Hex(n.image.bytes),
    mime: n.image.mime,
    width: n.image.width,
    height: n.image.height,
    bytes: n.image.bytes.length,
    taken_at: n.image.takenAt,
    original_name: n.image.originalName,
    host: n.image.host,
  }
}

const SAME_D = Buffer.from('legacy photo D, uploaded three times')
const SAME_E = Buffer.from('legacy photo E, uploaded twice, both deleted')

function jpeg(bytes: Buffer): LegacyImage {
  return { bytes, ext: 'jpg', mime: 'image/jpeg', width: 640, height: 480, takenAt: null, originalName: 'dup.jpg', host: 'laptop-a' }
}

const FIXTURES: LegacyNote[] = [
  {
    id: 'A-001',
    body: 'live photo with exif #trip',
    createdAt: '2026-09-01T10:00:00.123Z',
    deletedAt: null,
    image: {
      bytes: Buffer.from('legacy photo A-001'),
      ext: 'heic',
      mime: 'image/heic',
      width: 4032,
      height: 3024,
      takenAt: '2026-08-14T09:30:00.000Z',
      originalName: 'IMG_0001.HEIC',
      host: 'laptop-a',
    },
  },
  {
    id: 'A-002',
    body: '',
    createdAt: '2026-09-02T11:00:00.000Z',
    deletedAt: null,
    image: {
      bytes: Buffer.from('legacy screenshot A-002'),
      ext: 'png',
      mime: 'image/png',
      width: 1920,
      height: 1080,
      takenAt: null,
      originalName: null,
      host: null,
    },
  },
  {
    id: 'B-001',
    body: 'deleted photo',
    createdAt: '2026-09-03T12:00:00.000Z',
    deletedAt: '2026-10-10T08:00:00.000Z',
    image: jpeg(Buffer.from('legacy photo B-001')),
  },
  { id: 'C-001', body: 'a text note #seer', createdAt: '2026-09-04T13:00:00.000Z', deletedAt: null, image: null },
  { id: 'C-002', body: 'a deleted text note', createdAt: '2026-09-05T14:00:00.000Z', deletedAt: '2026-10-11T09:00:00.000Z', image: null },
  { id: 'D-001', body: 'live holder of D', createdAt: '2026-09-06T15:00:00.000Z', deletedAt: null, image: jpeg(SAME_D) },
  { id: 'D-002', body: 'older deleted copy of D', createdAt: '2026-09-07T16:00:00.000Z', deletedAt: '2026-10-01T10:00:00.000Z', image: jpeg(SAME_D) },
  { id: 'D-003', body: 'newer deleted copy of D', createdAt: '2026-09-08T17:00:00.000Z', deletedAt: '2026-10-20T10:00:00.000Z', image: jpeg(SAME_D) },
  { id: 'E-001', body: 'older deleted copy of E', createdAt: '2026-09-09T18:00:00.000Z', deletedAt: '2026-10-05T10:00:00.000Z', image: jpeg(SAME_E) },
  { id: 'E-002', body: 'newer deleted copy of E', createdAt: '2026-09-10T19:00:00.000Z', deletedAt: '2026-10-25T10:00:00.000Z', image: jpeg(SAME_E) },
]

/** The image row's expected deleted_at (ISO) per note id; null = part of its note. */
const EXPECTED_IMAGE_DELETED_AT: Record<string, string | null> = {
  'A-001': null,
  'A-002': null,
  'B-001': null,
  'D-001': null,
  'D-002': '2026-10-01T10:00:00.000Z',
  'D-003': '2026-10-20T10:00:00.000Z',
  'E-001': '2026-10-05T10:00:00.000Z',
  'E-002': null,
}

function urlForDatabase(name: string): string {
  const u = new URL(testDatabaseUrl())
  u.pathname = `/${name}`
  return u.toString()
}

async function dropStaleDatabases(admin: Db): Promise<void> {
  const res = await admin.execute<{ datname: string }>(
    sql`select datname from pg_database where starts_with(datname, ${DB_PREFIX})`,
  )
  for (const row of res.rows) {
    await admin.execute(sql.raw(`drop database if exists "${row.datname}" with (force)`))
  }
}

/** A migrations folder holding only 0000 and 0001: the iteration-6 schema. */
async function iteration6MigrationsFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-mig0002-migrations-'))
  await mkdir(path.join(dir, 'meta'))
  const journal = JSON.parse(await readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[]
  } & Record<string, unknown>
  const kept = journal.entries.filter((e) => e.tag === '0000_init' || e.tag === '0001_note_embeddings')
  if (kept.length !== 2) throw new Error('drizzle/meta/_journal.json lost 0000_init or 0001_note_embeddings')
  await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2))
  for (const e of kept) {
    await copyFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`))
  }
  return dir
}

async function snapshotFiles(root: string): Promise<Record<string, FileFacts>> {
  const out: Record<string, FileFacts> = {}
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else {
        const buf = await readFile(abs)
        const st = await stat(abs)
        out[path.relative(root, abs)] = { sha256: sha256Hex(buf), size: st.size, mtimeMs: st.mtimeMs }
      }
    }
  }
  await walk(root)
  return out
}

async function insertLegacyNote(db: Db, n: LegacyNote): Promise<void> {
  await db.insert(notes).values({
    id: n.id,
    body: n.body,
    imagePath: imagePathOf(n),
    imageMeta: metaOf(n),
    createdAt: new Date(n.createdAt),
    updatedAt: new Date(n.deletedAt ?? n.createdAt),
    deletedAt: n.deletedAt === null ? null : new Date(n.deletedAt),
  })
}

async function writeOriginal(dataDir: string, n: LegacyNote): Promise<void> {
  const rel = imagePathOf(n)
  if (!rel || !n.image) return
  const abs = path.join(dataDir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, n.image.bytes)
}

function expectedRow(n: LegacyNote, deletedAt: Date | null): NoteImageRow {
  const meta = metaOf(n)
  const rel = imagePathOf(n)
  if (!meta || !rel) throw new Error(`${n.id} is not an image note`)
  return {
    id: n.id,
    noteId: n.id,
    path: rel,
    sha256: meta.sha256,
    mime: meta.mime,
    width: meta.width,
    height: meta.height,
    bytes: meta.bytes,
    takenAt: meta.taken_at === null ? null : new Date(meta.taken_at),
    originalName: meta.original_name,
    host: meta.host,
    position: 0,
    createdAt: new Date(n.createdAt),
    deletedAt,
  }
}

async function notesSnapshot(db: Db) {
  return db.select().from(notes).orderBy(asc(notes.id))
}

describe('migration 0002 on an iteration-6 database', () => {
  const dbName = `${DB_PREFIX}${process.pid}_${randomBytes(4).toString('hex')}`
  let admin: Db
  let mig: Db
  let migrationsDir: string
  let dataDir: string
  let notesBefore: Awaited<ReturnType<typeof notesSnapshot>>
  let filesBefore: Record<string, FileFacts>

  beforeAll(async () => {
    admin = createDb(testDatabaseUrl())
    await dropStaleDatabases(admin)
    await admin.execute(sql.raw(`create database "${dbName}"`))
    mig = createDb(urlForDatabase(dbName))

    migrationsDir = await iteration6MigrationsFolder()
    await migrate(mig, { migrationsFolder: migrationsDir })
    const tables = await mig.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'note_images'`,
    )
    expect(tables.rows[0]?.n).toBe(0)

    dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-mig0002-data-'))
    for (const n of FIXTURES) {
      await insertLegacyNote(mig, n)
      await writeOriginal(dataDir, n)
    }
    notesBefore = await notesSnapshot(mig)
    filesBefore = await snapshotFiles(dataDir)

    await migrate(mig, { migrationsFolder: MIGRATIONS_DIR })
  })

  afterAll(async () => {
    if (mig) await closeDb(mig)
    if (admin) {
      await admin.execute(sql.raw(`drop database if exists "${dbName}" with (force)`))
      await closeDb(admin)
    }
    if (migrationsDir) await rm(migrationsDir, { recursive: true, force: true })
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
  })

  it('applies only 0002 on top of 0000 + 0001', async () => {
    const res = await mig.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
    expect(res.rows[0]?.n).toBe(3)
  })

  it('copies every legacy image into exactly one identical note_images row', async () => {
    const rows = await mig.select().from(noteImages).orderBy(asc(noteImages.id))
    const imageNotes = FIXTURES.filter((n) => n.image !== null)
    expect(rows.map((r) => r.id)).toEqual(imageNotes.map((n) => n.id).sort())
    for (const n of imageNotes) {
      const row = rows.find((r) => r.id === n.id)
      const iso = EXPECTED_IMAGE_DELETED_AT[n.id]
      if (iso === undefined) throw new Error(`no expectation for ${n.id}`)
      expect(row).toEqual(expectedRow(n, iso === null ? null : new Date(iso)))
    }
  })

  it('gives text notes no image rows', async () => {
    const rows = await mig.select().from(noteImages).where(sql`${noteImages.noteId} in ('C-001', 'C-002')`)
    expect(rows).toHaveLength(0)
  })

  it('leaves at most one live row per sha256, the live note first, else the most recently deleted', async () => {
    const res = await mig.execute<{ sha256: string; ids: string }>(
      sql`select sha256, string_agg(id, ',' order by id) as ids from note_images where deleted_at is null group by sha256 having count(*) > 0 order by ids`,
    )
    expect(res.rows.map((r) => r.ids)).toEqual(['A-001', 'A-002', 'B-001', 'D-001', 'E-002'])
  })

  it('leaves every notes row, the legacy columns and their indexes unchanged', async () => {
    expect(await notesSnapshot(mig)).toEqual(notesBefore)
    const idx = await mig.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where tablename = 'notes' order by indexname`,
    )
    expect(idx.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['notes_image_sha256_live_uniq', 'notes_image_taken_at_idx']),
    )
  })

  it('does not touch the image files', async () => {
    expect(await snapshotFiles(dataDir)).toEqual(filesBefore)
    expect(Object.keys(filesBefore)).toHaveLength(FIXTURES.filter((n) => n.image !== null).length)
  })

  it('ends with the exact reconcileLegacyImages statement and alters nothing that existed', async () => {
    const text = await readFile(path.join(MIGRATIONS_DIR, '0002_note_images.sql'), 'utf8')
    const chunks = text.split('--> statement-breakpoint')
    const last = (chunks[chunks.length - 1] ?? '').trim().replace(/;\s*$/, '')
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
    expect(norm(last)).toBe(norm(LEGACY_COPY_SQL))
    expect(text).not.toMatch(/\bdrop\b/i)
    expect(text).not.toMatch(/alter table "(notes|note_revisions|note_embeddings)"/i)
  })

  it('reconcile after the migration inserts nothing', async () => {
    const before = await mig.select().from(noteImages).orderBy(asc(noteImages.id))
    expect(await reconcileLegacyImages(mig)).toBe(0)
    expect(await mig.select().from(noteImages).orderBy(asc(noteImages.id))).toEqual(before)
  })

  it('reconcile picks up an image the old daemon ingested after the migration, once', async () => {
    const late: LegacyNote = {
      id: 'F-001',
      body: 'ingested by the old daemon after the Neon migration',
      createdAt: '2026-10-29T10:00:00.000Z',
      deletedAt: null,
      image: { ...jpeg(Buffer.from('legacy photo F-001')), takenAt: '2026-10-28T07:15:00.000Z' },
    }
    await insertLegacyNote(mig, late)
    expect(await reconcileLegacyImages(mig)).toBe(1)
    const [row] = await mig.select().from(noteImages).where(eq(noteImages.id, 'F-001'))
    expect(row).toEqual(expectedRow(late, null))
    expect(await reconcileLegacyImages(mig)).toBe(0)
  })

  it('reconcile bins a late legacy image whose bytes already live in note_images', async () => {
    const bytes = Buffer.from('attached by the new daemon, then ingested by the old one')
    await mig.insert(notes).values({ id: 'G-001', body: 'new-daemon note' })
    await insertImage(mig, {
      id: 'G-001',
      noteId: 'G-001',
      path: 'images/2026/10/G-001.jpg',
      sha256: sha256Hex(bytes),
      mime: 'image/jpeg',
      width: 640,
      height: 480,
      bytes: bytes.length,
      position: 0,
    })
    const late: LegacyNote = {
      id: 'G-002',
      body: 'same bytes through the old daemon',
      createdAt: '2026-10-29T11:00:00.000Z',
      deletedAt: null,
      image: jpeg(bytes),
    }
    await insertLegacyNote(mig, late)
    expect(await reconcileLegacyImages(mig)).toBe(1)
    const [row] = await mig.select().from(noteImages).where(eq(noteImages.id, 'G-002'))
    expect(row).toEqual(expectedRow(late, expect.any(Date) as unknown as Date))
    const [holder] = await mig.select().from(noteImages).where(eq(noteImages.id, 'G-001'))
    expect(holder?.deletedAt).toBeNull()
  })
})
