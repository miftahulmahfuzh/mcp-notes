import { describe, expect, it } from 'vitest';
import { guardSelect, maskSql, SqlRefused } from '../../../src/connectors/guard.js';

const accepted = [
  'select 1',
  'SELECT 1;',
  '  with x as (select 1) select * from x  ;  ',
  "select 'insert; drop' as s",
  'select "update" from t',
  'select $$ delete ; $$',
  'select $tag$ ; drop $tag$',
  'select 1 -- drop table x',
  'select /* insert */ 1',
  'select /* outer /* nested */ insert */ 1',
  '(select 1) union (select 2)',
  "select nextval('s')",
  "select replace(name, 'a', 'b') from t",
  "select e'it\\'s; insert'",
  'select x from t where id = $1',
  'select updated_at, deleted_at, created_at from t',
];

const refused: [string, RegExp][] = [
  ['insert into t values (1)', /only SELECT/],
  ['update t set x = 1', /only SELECT/],
  ['delete from t', /only SELECT/],
  ['drop table t', /only SELECT/],
  ['explain analyze select 1', /only SELECT/],
  ['set statement_timeout = 0', /only SELECT/],
  ['begin', /only SELECT/],
  ['vacuum', /only SELECT/],
  ['select 1; select 2', /only one statement/],
  ['select 1; drop table t', /only one statement/],
  ['with x as (insert into t values (1) returning *) select * from x', /INSERT is not allowed/],
  ['with x as (delete from t returning *) select * from x', /DELETE is not allowed/],
  ['select * into newt from t', /INTO is not allowed/],
  ['select * from t for update', /UPDATE is not allowed/],
  ['select * from t for share', /row locks/],
  ['select pg_terminate_backend(123)', /pg_terminate_backend\(\) is not allowed/],
  ["select set_config('a', 'b', false)", /set_config\(\) is not allowed/],
  ['select pg_advisory_lock(1)', /pg_advisory_lock\(\) is not allowed/],
  ["select 'unterminated", /unterminated string/],
  ['select /* open', /unterminated \/\* comment/],
  ['select $a$ open', /unterminated dollar/],
  ['', /empty/],
  ['  ;  ', /empty/],
];

describe('guardSelect (postgres)', () => {
  it.each(accepted)('accepts %s', (sql) => {
    expect(() => guardSelect(sql, 'postgres')).not.toThrow();
  });

  it.each(refused)('refuses %s', (sql, reason) => {
    expect(() => guardSelect(sql, 'postgres')).toThrow(SqlRefused);
    expect(() => guardSelect(sql, 'postgres')).toThrow(reason);
  });

  it('returns the query without trailing semicolons or trailing comments', () => {
    expect(guardSelect('select 1 ; -- bye', 'postgres')).toBe('select 1');
    expect(guardSelect('  select 2;;  ', 'postgres')).toBe('select 2');
  });

  it('keeps a literal or quoted identifier that ends the query', () => {
    expect(guardSelect("select x from t where id = 'a-b' ;", 'postgres')).toBe("select x from t where id = 'a-b'");
    expect(guardSelect("select 1 where 'x' like '24%'", 'postgres')).toBe("select 1 where 'x' like '24%'");
    expect(guardSelect('select x from t order by "Name"', 'postgres')).toBe('select x from t order by "Name"');
    expect(guardSelect('select $$ a $$', 'postgres')).toBe('select $$ a $$');
    expect(guardSelect("select x from t where id = 'a' -- why", 'postgres')).toBe("select x from t where id = 'a'");
    expect(guardSelect('select x from t order by [Name]', 'sqlite')).toBe('select x from t order by [Name]');
  });
});

describe('guardSelect (sqlite)', () => {
  it('accepts sqlite quoting and pragma table functions', () => {
    expect(() => guardSelect('select [insert], `drop` from t', 'sqlite')).not.toThrow();
    expect(() => guardSelect("select * from pragma_table_info('methods')", 'sqlite')).not.toThrow();
  });

  it('refuses attach, pragma and writes', () => {
    expect(() => guardSelect("attach database 'x' as y", 'sqlite')).toThrow(/only SELECT/);
    expect(() => guardSelect('pragma writable_schema = 1', 'sqlite')).toThrow(/only SELECT/);
    expect(() => guardSelect('with a as (select 1) insert into t select * from a', 'sqlite')).toThrow(/INSERT is not allowed/);
  });
});

describe('maskSql', () => {
  it('keeps the length and blanks literals and comments', () => {
    const sql = "select 'x;y' -- c\n, \"q\" /* d */";
    const masked = maskSql(sql, 'postgres');
    expect(masked).toHaveLength(sql.length);
    expect(masked).not.toMatch(/[;'"]|--|\/\*/);
  });
});
