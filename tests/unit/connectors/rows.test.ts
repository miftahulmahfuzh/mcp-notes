import { describe, expect, it } from 'vitest';
import { capRows, clampMaxRows, int8Value, stripTrailingSemicolons, toObjects, wrapWithLimit } from '../../../src/connectors/rows.js';

describe('row cap', () => {
  it('clamps max rows to 1..1000 with a default of 200', () => {
    expect(clampMaxRows(undefined)).toBe(200);
    expect(clampMaxRows(0)).toBe(1);
    expect(clampMaxRows(-5)).toBe(1);
    expect(clampMaxRows(5000)).toBe(1000);
    expect(clampMaxRows(12.7)).toBe(12);
    expect(clampMaxRows(Number.NaN)).toBe(200);
  });

  it('wraps the query with LIMIT cap+1 on its own lines', () => {
    expect(wrapWithLimit('select 1 -- c', 5)).toBe('SELECT * FROM (\nselect 1 -- c\n) AS q LIMIT 6');
  });

  it('keeps at most cap rows and flags truncation', () => {
    const rows = [[1], [2], [3]];
    expect(capRows(['x'], rows, 2)).toEqual({ columns: ['x'], rows: [[1], [2]], row_count: 2, truncated: true });
    expect(capRows(['x'], rows, 3)).toEqual({ columns: ['x'], rows, row_count: 3, truncated: false });
    expect(capRows(['x'], [], 3)).toEqual({ columns: ['x'], rows: [], row_count: 0, truncated: false });
  });

  it('int8 is a number when exact, else text; trailing semicolons go; rows become objects', () => {
    expect(int8Value('42')).toBe(42);
    expect(int8Value('9007199254740993')).toBe('9007199254740993');
    expect(stripTrailingSemicolons('select 1 ;; \n')).toBe('select 1');
    expect(toObjects({ columns: ['a', 'b'], rows: [[1, 'x']], row_count: 1, truncated: false })).toEqual([{ a: 1, b: 'x' }]);
  });
});
