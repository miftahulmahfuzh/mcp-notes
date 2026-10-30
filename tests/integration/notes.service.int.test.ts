import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { noteRevisions } from '../../src/db/schema.js';
import { NoteEvents, type NoteEvent } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { NoteError, type ImageMeta } from '../../src/notes/types.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const db = openTestDb();
const dataDir = mkdtempSync(join(tmpdir(), 'notes-svc-'));
const events = new NoteEvents();
const service = new NotesService({ db, dataDir, events });
const seen: NoteEvent[] = [];
events.on((e) => seen.push(e));

async function expectNoteError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NoteError);
  expect((err as NoteError).code).toBe(code);
}

async function revisionCount(id: string): Promise<number> {
  const rows = await db.select().from(noteRevisions).where(sql`${noteRevisions.noteId} = ${id}`);
  return rows.length;
}

/** Sets created_at and updated_at of a note directly, for date-filter tests. */
async function backdate(id: string, iso: string): Promise<void> {
  await db.execute(sql`update notes set created_at = ${iso}::timestamptz, updated_at = ${iso}::timestamptz where id = ${id}`);
}

const meta = (sha256: string): ImageMeta => ({
  sha256,
  mime: 'image/png',
  width: 2,
  height: 1,
  bytes: 70,
  taken_at: null,
  original_name: 'shot.png',
  host: 'lenovo',
});

beforeEach(async () => {
  await truncateAll(db);
  seen.length = 0;
});

afterAll(async () => {
  await closeTestDb(db);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('NotesService create/get', () => {
  it('creates a note with a canonical id, parsed tags and cleaned origin, and emits created', async () => {
    const note = await service.create({
      body: 'Fixed the #Seer retry loop, see #v250 and #seer',
      origin: { cwd: '/home/m/seer', repo: 'seer', claude_session: 'abc' },
    });
    expect(note.id).toMatch(/^[0-9A-Z]-[0-9A-Z]{3}$/);
    expect(note.tags).toEqual(['seer', 'v250']);
    expect(note.origin).toEqual({ cwd: '/home/m/seer', repo: 'seer', claude_session: 'abc' });
    expect(note.image).toBeNull();
    expect(note.deleted_at).toBeUndefined();
    expect(new Date(note.created_at).toISOString()).toBe(note.created_at);
    expect(seen).toEqual([{ type: 'note', op: 'created', id: note.id }]);
  });

  it('rejects an empty body unless allowEmpty', async () => {
    await expectNoteError(service.create({ body: '   ' }), 'empty_body');
    const empty = await service.create({ body: '', allowEmpty: true });
    expect(empty.body).toBe('');
    expect(empty.tags).toEqual([]);
  });

  it('uses a caller-chosen id from newId and refuses a taken one', async () => {
    const id = await service.newId();
    const note = await service.create({ id: id.toLowerCase().replace('-', ''), body: 'x' });
    expect(note.id).toBe(id);
    await expectNoteError(service.create({ id, body: 'y' }), 'conflict');
  });

  it('finds notes case-insensitively and without the dash, reporting missing and deleted ids', async () => {
    const a = await service.create({ body: 'alpha' });
    const b = await service.create({ body: 'beta' });
    await service.delete(b.id);
    const res = await service.get([a.id.toLowerCase().replace('-', ''), b.id, 'nope!', 'Z-ZZZ']);
    expect(res.notes.map((n) => n.id)).toEqual([a.id]);
    expect(res.deleted).toEqual([b.id]);
    expect(res.missing).toContain('nope!');
    const withDeleted = await service.get([b.id], { includeDeleted: true });
    expect(withDeleted.notes[0]?.deleted_at).toBeDefined();
    expect(await service.getOne(b.id)).toBeNull();
    expect((await service.getOne(b.id, { includeDeleted: true }))?.id).toBe(b.id);
  });
});

describe('NotesService body changes write revisions in the same transaction', () => {
  it('update keeps the previous body, re-parses tags and emits updated', async () => {
    const n = await service.create({ body: 'first #a' });
    seen.length = 0;
    const u = await service.update(n.id, 'second #b');
    expect(u.body).toBe('second #b');
    expect(u.tags).toEqual(['b']);
    const revs = await service.revisions(n.id);
    expect(revs.map((r) => r.body)).toEqual(['first #a']);
    expect(seen).toEqual([{ type: 'note', op: 'updated', id: n.id }]);
  });

  it('an unchanged update writes no revision and emits nothing', async () => {
    const n = await service.create({ body: 'same' });
    seen.length = 0;
    await service.update(n.id, 'same');
    expect(await revisionCount(n.id)).toBe(0);
    expect(seen).toEqual([]);
  });

  it('update refuses an empty body unless allowEmpty', async () => {
    const n = await service.create({ body: 'x' });
    await expectNoteError(service.update(n.id, ''), 'empty_body');
    const u = await service.update(n.id, '', { allowEmpty: true });
    expect(u.body).toBe('');
  });

  it('append adds after a blank line and keeps a revision', async () => {
    const n = await service.create({ body: 'line one\n' });
    const a = await service.append(n.id, 'line two #agentic');
    expect(a.body).toBe('line one\n\nline two #agentic');
    expect(a.tags).toEqual(['agentic']);
    expect(await revisionCount(n.id)).toBe(1);
  });

  it('delete is soft, keeps the body as a revision, and is idempotent', async () => {
    const n = await service.create({ body: 'to delete' });
    seen.length = 0;
    const d = await service.delete(n.id);
    expect(d.deleted_at).toBeDefined();
    expect(await revisionCount(n.id)).toBe(1);
    await service.delete(n.id);
    expect(await revisionCount(n.id)).toBe(1);
    expect(seen).toEqual([{ type: 'note', op: 'deleted', id: n.id }]);
    await expectNoteError(service.update(n.id, 'nope'), 'deleted');
    await expectNoteError(service.append(n.id, 'nope'), 'deleted');
  });

  it('restore brings a deleted note back and emits restored', async () => {
    const n = await service.create({ body: 'back' });
    await service.delete(n.id);
    seen.length = 0;
    const r = await service.restore(n.id);
    expect(r.deleted_at).toBeUndefined();
    expect(seen).toEqual([{ type: 'note', op: 'restored', id: n.id }]);
    await service.restore(n.id);
    expect(seen).toHaveLength(1);
  });

  it('revert restores a revision body and saves the replaced body as a new revision', async () => {
    const n = await service.create({ body: 'v1 #one' });
    await service.update(n.id, 'v2 #two');
    const [rev] = await service.revisions(n.id);
    expect(rev?.body).toBe('v1 #one');
    const r = await service.revert(n.id, rev!.revision);
    expect(r.body).toBe('v1 #one');
    expect(r.tags).toEqual(['one']);
    const revs = await service.revisions(n.id);
    expect(revs.map((x) => x.body)).toEqual(['v2 #two', 'v1 #one']);
    await expectNoteError(service.revert(n.id, 999999), 'invalid_revision');
  });

  it('a failed transaction leaves no revision behind', async () => {
    const n = await service.create({ body: 'atomic' });
    await expectNoteError(service.revert(n.id, 424242), 'invalid_revision');
    expect(await revisionCount(n.id)).toBe(0);
  });

  it('unknown and invalid ids give not_found and invalid_id', async () => {
    await expectNoteError(service.update('Z-ZZZ', 'x'), 'not_found');
    await expectNoteError(service.delete('Z-ZZZ'), 'not_found');
    await expectNoteError(service.revisions('Z-ZZZ'), 'not_found');
    await expectNoteError(service.update('???', 'x'), 'invalid_id');
  });
});

describe('NotesService list/search/tags', () => {
  it('lists newest first with tag any/all filters and paging', async () => {
    const a = await service.create({ body: 'a #seer #v250' });
    const b = await service.create({ body: 'b #seer' });
    const c = await service.create({ body: 'c #v250' });
    await backdate(a.id, '2026-10-01T10:00:00Z');
    await backdate(b.id, '2026-10-02T10:00:00Z');
    await backdate(c.id, '2026-10-03T10:00:00Z');

    const all = await service.list();
    expect(all.notes.map((n) => n.id)).toEqual([c.id, b.id, a.id]);
    expect(all.next_cursor).toBeNull();

    expect((await service.list({ tagsAny: ['#SEER'] })).notes.map((n) => n.id)).toEqual([b.id, a.id]);
    expect((await service.list({ tagsAll: ['seer', 'v250'] })).notes.map((n) => n.id)).toEqual([a.id]);

    const p1 = await service.list({ limit: 2 });
    expect(p1.notes.map((n) => n.id)).toEqual([c.id, b.id]);
    expect(p1.next_cursor).not.toBeNull();
    const p2 = await service.list({ limit: 2, cursor: p1.next_cursor! });
    expect(p2.notes.map((n) => n.id)).toEqual([a.id]);
    expect(p2.next_cursor).toBeNull();
  });

  it('filters by created or updated date range', async () => {
    const a = await service.create({ body: 'old' });
    const b = await service.create({ body: 'new' });
    await backdate(a.id, '2026-09-01T12:00:00Z');
    await backdate(b.id, '2026-10-20T12:00:00Z');
    const r = await service.list({ from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' });
    expect(r.notes.map((n) => n.id)).toEqual([b.id]);
    const upd = await service.list({ dateField: 'updated', to: '2026-09-02T00:00:00Z' });
    expect(upd.notes.map((n) => n.id)).toEqual([a.id]);
    await expectNoteError(service.list({ from: 'last tuesday' }), 'invalid_input');
  });

  it('filters by hasImage and by deleted state', async () => {
    const text = await service.create({ body: 'text note' });
    const img = await service.create({ body: '', allowEmpty: true, image: { path: 'images/2026/10/x.png', meta: meta('aa') } });
    const gone = await service.create({ body: 'gone' });
    await service.delete(gone.id);
    expect((await service.list({ hasImage: true })).notes.map((n) => n.id)).toEqual([img.id]);
    expect((await service.list({ hasImage: false })).notes.map((n) => n.id)).toEqual([text.id]);
    expect((await service.list({ deleted: 'only' })).notes.map((n) => n.id)).toEqual([gone.id]);
    expect((await service.list({ deleted: 'include' })).notes).toHaveLength(3);
  });

  it('searches with the simple config, ranked, with filters', async () => {
    const a = await service.create({ body: 'pgx connection pool tuning #seer' });
    const b = await service.create({ body: 'pool pool pool notes #v250' });
    await service.create({ body: 'unrelated' });
    const r = await service.search('pool');
    expect(r.notes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.notes[0]?.id).toBe(b.id);
    expect((await service.search('pool', { tagsAny: ['seer'] })).notes.map((n) => n.id)).toEqual([a.id]);
    expect((await service.search('pgx')).notes.map((n) => n.id)).toEqual([a.id]);
    expect((await service.search('"connection pool" -redis')).notes.map((n) => n.id)).toEqual([a.id]);
    expect((await service.search('pool', { hasImage: true })).notes).toEqual([]);
    await expectNoteError(service.search('  '), 'invalid_input');
  });

  it('counts tags on live notes with last_used', async () => {
    const a = await service.create({ body: '#seer one' });
    await service.create({ body: '#seer two #v250' });
    const d = await service.create({ body: '#gone' });
    await service.delete(d.id);
    await backdate(a.id, '2026-01-01T00:00:00Z');
    const tags = await service.tags();
    expect(tags.map((t) => [t.tag, t.count])).toEqual([
      ['seer', 2],
      ['v250', 1],
    ]);
    expect(new Date(tags[0]!.last_used).getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime());
  });
});

describe('NotesService image notes', () => {
  it('computes image.available from the file under dataDir', async () => {
    const rel = 'images/2026/10/present.png';
    mkdirSync(join(dataDir, 'images/2026/10'), { recursive: true });
    writeFileSync(join(dataDir, rel), 'png');
    const here = await service.create({ body: 'shot #ai_image', image: { path: rel, meta: meta('s1') } });
    const away = await service.create({ body: '', allowEmpty: true, image: { path: 'images/2026/10/absent.png', meta: meta('s2') } });
    expect(here.image).toMatchObject({ mime: 'image/png', width: 2, height: 1, host: 'lenovo', available: true });
    expect(away.image?.available).toBe(false);
  });

  it('findBySha256 sees live notes, and deleted ones only when asked', async () => {
    const n = await service.create({ body: '', allowEmpty: true, image: { path: 'images/a.png', meta: meta('dup') } });
    expect((await service.findBySha256('dup'))?.id).toBe(n.id);
    await expectNoteError(
      service.create({ body: '', allowEmpty: true, image: { path: 'images/b.png', meta: meta('dup') } }),
      'duplicate_image',
    );
    await service.delete(n.id);
    expect(await service.findBySha256('dup')).toBeNull();
    const deleted = await service.findBySha256('dup', { includeDeleted: true });
    expect(deleted?.id).toBe(n.id);
    expect(deleted?.deleted_at).toBeDefined();
  });
});
