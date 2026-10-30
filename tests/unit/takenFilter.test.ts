import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { filterConditions } from '../../src/notes/repo.js';
import { NoteError } from '../../src/notes/types.js';

const dialect = new PgDialect();
const render = (f: Parameters<typeof filterConditions>[0]) =>
  filterConditions(f).map((c) => dialect.sqlToQuery(c));
const imageConds = (f: Parameters<typeof filterConditions>[0]) => render(f).filter((q) => q.sql.includes('note_images'));

describe('filterConditions: images', () => {
  it('adds nothing about images without image filters', () => {
    expect(imageConds({})).toEqual([]);
  });

  it('hasImage is an EXISTS over the note\'s live images', () => {
    const [yes] = imageConds({ hasImage: true });
    expect(yes!.sql).toContain('exists (select 1 from "note_images" where "note_images"."note_id" = "notes"."id"');
    expect(yes!.sql).toContain('"note_images"."deleted_at" is null');
    expect(yes!.sql.startsWith('not ')).toBe(false);
    const [no] = imageConds({ hasImage: false });
    expect(no!.sql.startsWith('not exists (select 1 from "note_images"')).toBe(true);
  });

  it('the taken range is one EXISTS with both bounds on the same image (whole local days, UTC params)', () => {
    const qs = imageConds({ takenFrom: '2026-10-30', takenTo: '2026-10-30' });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.sql).toContain('"note_images"."taken_at" >= $1::timestamptz');
    expect(qs[0]!.sql).toContain('"note_images"."taken_at" < $2::timestamptz');
    expect(qs[0]!.sql).toContain('"note_images"."deleted_at" is null');
    expect(qs[0]!.params).toEqual([new Date(2026, 9, 30).toISOString(), new Date(2026, 9, 31).toISOString()]);
  });

  it('a single bound still gives one EXISTS', () => {
    const qs = imageConds({ takenTo: '2026-10-29' });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.sql).toContain('"note_images"."taken_at" <');
  });

  it('rejects garbage with invalid_input', () => {
    expect(() => filterConditions({ takenFrom: 'yesterday' })).toThrow(NoteError);
  });
});
