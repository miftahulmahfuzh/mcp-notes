import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { filterConditions } from '../../src/notes/repo.js';
import { NoteError } from '../../src/notes/types.js';

const dialect = new PgDialect();
const render = (f: Parameters<typeof filterConditions>[0]) =>
  filterConditions(f).map((c) => dialect.sqlToQuery(c));

describe('filterConditions: taken range', () => {
  it('adds nothing without bounds (beyond the default deleted filter)', () => {
    expect(render({}).some((q) => q.sql.includes('taken_at'))).toBe(false);
  });

  it('compares image_meta->>taken_at as text against UTC ISO bounds (whole local days)', () => {
    const qs = render({ takenFrom: '2026-10-30', takenTo: '2026-10-30' }).filter((q) => q.sql.includes('taken_at'));
    expect(qs).toHaveLength(2);
    expect(qs[0]!.sql).toContain(`("notes"."image_meta" ->> 'taken_at') >=`);
    expect(qs[1]!.sql).toContain(`("notes"."image_meta" ->> 'taken_at') <`);
    expect(qs[0]!.params).toEqual([new Date(2026, 9, 30).toISOString()]);
    expect(qs[1]!.params).toEqual([new Date(2026, 9, 31).toISOString()]);
  });

  it('rejects garbage with invalid_input', () => {
    expect(() => filterConditions({ takenFrom: 'yesterday' })).toThrow(NoteError);
  });
});
