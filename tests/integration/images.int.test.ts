import { existsSync } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startBackground, type StopBackground } from '../../src/background.js';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG } from '../../src/config.js';
import type { AppDeps } from '../../src/deps.js';
import { derivativePaths, getDisplay, getPreview, getThumb } from '../../src/images/derive.js';
import { ingestImage, locateImage, type ImageDeps } from '../../src/images/ingest.js';
import { sha256Hex } from '../../src/images/probe.js';
import { dbImageRecords } from '../../src/images/records.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { setImageDeleted } from '../../src/notes/imageRepo.js';
import { NoteError } from '../../src/notes/types.js';
import { fixtureBytes, HEIC_PHOTO, JPEG_EXIF, PNG_PLAIN, tempDir } from '../helpers/fixtures.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';
import { ChatService } from '../../src/chat/service.js';

const db = openTestDb();
let dir: string;
let cleanup: () => Promise<void>;
let notes: NotesService;
let deps: ImageDeps;
let stop: StopBackground | null;

beforeEach(async () => {
  await truncateAll(db);
  ({ dir, cleanup } = await tempDir('mcp-notes-int-img-'));
  notes = new NotesService({ db, dataDir: dir, events: new NoteEvents() });
  deps = { dataDir: dir, notes, records: dbImageRecords(db), hostname: () => 'lenovo' };
  stop = null;
});
afterEach(async () => {
  await stop?.();
  await cleanup();
});
afterAll(async () => {
  await closeTestDb(db);
});

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

describe('image ingest against Postgres', () => {
  it('stores bytes exactly and the note carries the image shape', async () => {
    const bytes = await fixtureBytes(JPEG_EXIF);
    const { note, created } = await ingestImage(deps, { bytes, originalName: 'IMG_1.JPG', body: 'first #photo' });
    expect(created).toBe(true);
    expect(note.tags).toEqual(['photo']);
    expect(note.images[0]).toMatchObject({
      id: note.id,
      note_id: note.id,
      position: 0,
      mime: 'image/jpeg',
      width: 64,
      height: 48,
      bytes: bytes.byteLength,
      original_name: 'IMG_1.JPG',
      host: 'lenovo',
      available: true,
      taken_at: new Date(2024, 9, 30, 14, 5, 9).toISOString(),
    });
    const loc = (await locateImage(deps, note.id))!;
    expect(Buffer.compare(await readFile(loc.originalPath), bytes)).toBe(0);
    expect(loc.relPath).toMatch(new RegExp(`^images/\\d{4}/\\d{2}/${note.id}\\.jpg$`));
  });

  it('ingesting the same bytes twice returns one note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes, originalName: 'a.png' });
    const b = await ingestImage(deps, { bytes, originalName: 'b.png' });
    expect(b.created).toBe(false);
    expect(b.note.id).toBe(a.note.id);
  });

  it('a soft-deleted duplicate is restored', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes });
    await notes.delete(a.note.id);
    const b = await ingestImage(deps, { bytes });
    expect(b).toMatchObject({ created: false, note: { id: a.note.id } });
    expect(b.note.deleted_at ?? null).toBeNull();
  });

  it('the live-image sha256 index rejects a second note with the same bytes, and leaves no note behind', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const rec = (await deps.records.byImageId(note.id))!;
    const before = (await notes.list({ limit: 100, deleted: 'include' })).notes.map((n) => n.id);
    const err = await notes
      .create({ body: '', image: { path: 'images/2000/01/X-XXX.png', meta: rec.meta }, allowEmpty: true })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(NoteError);
    expect((err as NoteError).code).toBe('duplicate_image');
    expect((await notes.list({ limit: 100, deleted: 'include' })).notes.map((n) => n.id)).toEqual(before);
  });

  it('a removed image does not dedupe: the same bytes make a new note', async () => {
    const bytes = await fixtureBytes(PNG_PLAIN);
    const a = await ingestImage(deps, { bytes });
    await setImageDeleted(db, a.note.id, true);
    const b = await ingestImage(deps, { bytes });
    expect(b.created).toBe(true);
    expect(b.note.id).not.toBe(a.note.id);
    expect(b.note.images.map((i) => i.id)).toEqual([b.note.id]);
  });

  it('HEIC gets a display derivative; thumb and preview follow', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(HEIC_PHOTO), originalName: 'IMG_2.HEIC' });
    const loc = (await locateImage(deps, note.id))!;
    expect(loc.relPath.endsWith('.heic')).toBe(true);
    const display = await getDisplay(dir, loc);
    expect(display).toEqual({ path: derivativePaths(dir, note.id).display, mime: 'image/jpeg' });
    expect((await sharp(display.path).metadata()).format).toBe('jpeg');
    expect((await sharp(await getThumb(dir, loc)).metadata()).format).toBe('webp');
    expect((await sharp(await getPreview(dir, loc)).metadata()).format).toBe('jpeg');
  });

  it('a missing original is reported, the note still loads', async () => {
    const { note } = await ingestImage(deps, { bytes: await fixtureBytes(PNG_PLAIN) });
    const loc = (await locateImage(deps, note.id))!;
    await rm(loc.originalPath);
    expect((await locateImage(deps, note.id))!.available).toBe(false);
    expect((await notes.getOne(note.id))!.images[0]!.available).toBe(false);
  });
});

describe('inbox via startBackground', () => {
  it('a file dropped in <dataDir>/inbox becomes an image note', async () => {
    const app: AppDeps = {
      config: { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG },
      db,
      events: new NoteEvents(),
      service: notes,
      embedder: null,
      imageEmbedder: null,
      chat: new ChatService({ db }),
    };
    stop = await startBackground(app);
    const dropped = path.join(dir, 'inbox', 'phone.jpg');
    await copyFile(JPEG_EXIF, dropped);
    const sha = sha256Hex(await fixtureBytes(JPEG_EXIF));
    let found = null as string | null;
    await until(async () => {
      found = (await notes.findBySha256(sha))?.id ?? null;
      return found !== null;
    });
    const note = (await notes.getOne(found!))!;
    expect(note.origin).toEqual({ source: 'inbox' });
    expect(note.images[0]!.original_name).toBe('phone.jpg');
    await until(async () => !existsSync(dropped));
  });

  it('startBackground copies a legacy image (old columns only) into note_images', async () => {
    const legacyMeta = { sha256: 'f'.repeat(64), mime: 'image/png', width: 1, height: 1, bytes: 1, taken_at: null, original_name: 'old.png', host: 'lenovo' };
    await db.execute(sql`
      insert into notes (id, body, tags, image_path, image_meta, created_at, updated_at)
      values ('L-EG1', 'old photo', '{}'::text[], 'images/2026/09/L-EG1.png', ${JSON.stringify(legacyMeta)}::jsonb, now(), now())
    `);
    expect((await notes.getOne('L-EG1'))!.images).toEqual([]);
    const app: AppDeps = {
      config: { databaseUrl: testDatabaseUrl(), port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG, embeddings: DEFAULT_EMBEDDINGS_CONFIG, sessions: DEFAULT_SESSIONS_CONFIG },
      db,
      events: new NoteEvents(),
      service: notes,
      embedder: null,
      imageEmbedder: null,
      chat: new ChatService({ db }),
    };
    stop = await startBackground(app);
    const note = (await notes.getOne('L-EG1'))!;
    expect(note.images).toHaveLength(1);
    expect(note.images[0]).toMatchObject({ id: 'L-EG1', note_id: 'L-EG1', position: 0, mime: 'image/png', original_name: 'old.png' });
  });
});
