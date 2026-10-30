import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDateBound } from '../../src/notes/dates.js';
import { NoteEvents, type NoteEvent } from '../../src/notes/events.js';
import { clampLimit, decodeCursor, encodeCursor, MAX_LIMIT, normalizeTagInput } from '../../src/notes/repo.js';
import { cleanOrigin, imageAvailable, NoteError, rowToNote, type NoteRow } from '../../src/notes/types.js';

const dataDir = mkdtempSync(join(tmpdir(), 'notes-unit-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function row(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    id: 'A-B32',
    body: 'hello #seer',
    tags: ['seer'],
    imagePath: null,
    imageMeta: null,
    origin: null,
    createdAt: new Date('2026-10-30T01:02:03.004Z'),
    updatedAt: new Date('2026-10-30T02:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('parseDateBound', () => {
  it('treats YYYY-MM-DD as a whole local day', () => {
    expect(parseDateBound('2026-10-30', 'from').getTime()).toBe(new Date(2026, 9, 30).getTime());
    expect(parseDateBound('2026-10-30', 'to').getTime()).toBe(new Date(2026, 9, 31).getTime());
    expect(parseDateBound('2026-12-31', 'to').getTime()).toBe(new Date(2027, 0, 1).getTime());
  });

  it('treats datetimes as exact, with an inclusive upper bound', () => {
    expect(parseDateBound('2026-10-30T10:00:00Z', 'from').toISOString()).toBe('2026-10-30T10:00:00.000Z');
    expect(parseDateBound('2026-10-30T10:00:00Z', 'to').toISOString()).toBe('2026-10-30T10:00:00.001Z');
    expect(parseDateBound('2026-10-30T17:00:00+07:00', 'from').toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });

  it('rejects anything else', () => {
    for (const bad of ['yesterday', '2026-02-30', '30/10/2026', '2026-10', '']) {
      expect(() => parseDateBound(bad, 'from')).toThrow(NoteError);
    }
  });
});

describe('repo helpers', () => {
  it('normalises tag filter input', () => {
    expect(normalizeTagInput(['#Seer', ' seer ', 'V250', '##x', '', '#'])).toEqual(['seer', 'v250', 'x']);
    expect(normalizeTagInput(undefined)).toEqual([]);
  });

  it('round-trips cursors and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(150))).toBe(150);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor('')).toBe(0);
    expect(() => decodeCursor('not-a-cursor')).toThrow(NoteError);
    expect(() => decodeCursor(Buffer.from('{"o":-1}').toString('base64url'))).toThrow(NoteError);
  });

  it('clamps limits', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10.7)).toBe(10);
    expect(clampLimit(1e9)).toBe(MAX_LIMIT);
  });
});

describe('wire mapping', () => {
  it('keeps only known origin string fields', () => {
    expect(cleanOrigin({ cwd: '/x', repo: '', extra: 'y', claude_session: 3 })).toEqual({ cwd: '/x' });
    expect(cleanOrigin({})).toBeNull();
    expect(cleanOrigin('nope')).toBeNull();
    expect(cleanOrigin(null)).toBeNull();
  });

  it('maps a text note', () => {
    expect(rowToNote(row({ origin: { repo: 'seer' } }), dataDir)).toEqual({
      id: 'A-B32',
      body: 'hello #seer',
      tags: ['seer'],
      created_at: '2026-10-30T01:02:03.004Z',
      updated_at: '2026-10-30T02:00:00.000Z',
      origin: { repo: 'seer' },
      image: null,
    });
  });

  it('adds deleted_at only for deleted notes', () => {
    const n = rowToNote(row({ deletedAt: new Date('2026-10-31T00:00:00Z') }), dataDir);
    expect(n.deleted_at).toBe('2026-10-31T00:00:00.000Z');
  });

  it('maps image meta and checks the file under dataDir', () => {
    mkdirSync(join(dataDir, 'images/2026/10'), { recursive: true });
    writeFileSync(join(dataDir, 'images/2026/10/A-B32.jpg'), 'x');
    const meta = { sha256: 'h', mime: 'image/jpeg', width: 4, height: 3, bytes: 1, taken_at: '2026-10-29T08:00:00.000Z', original_name: 'IMG_1.jpg', host: 'lenovo' };
    const here = rowToNote(row({ imagePath: 'images/2026/10/A-B32.jpg', imageMeta: meta }), dataDir);
    expect(here.image).toEqual({ mime: 'image/jpeg', width: 4, height: 3, bytes: 1, taken_at: '2026-10-29T08:00:00.000Z', original_name: 'IMG_1.jpg', host: 'lenovo', available: true });
    const away = rowToNote(row({ imagePath: 'images/2026/10/missing.jpg', imageMeta: meta }), dataDir);
    expect(away.image?.available).toBe(false);
  });

  it('never reports a path outside dataDir as available', () => {
    expect(imageAvailable(dataDir, '../../etc/passwd')).toBe(false);
    expect(imageAvailable(dataDir, '/etc/passwd')).toBe(false);
    expect(imageAvailable(dataDir, '')).toBe(false);
  });
});

describe('NoteEvents', () => {
  it('delivers events and unsubscribes', () => {
    const events = new NoteEvents();
    const got: NoteEvent[] = [];
    const off = events.on((e) => got.push(e));
    events.emit('created', 'A-B32');
    off();
    events.emit('deleted', 'A-B32');
    expect(got).toEqual([{ type: 'note', op: 'created', id: 'A-B32' }]);
    expect(events.listenerCount()).toBe(0);
  });
});
