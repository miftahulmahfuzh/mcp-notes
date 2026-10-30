export type SqlDialect = 'postgres' | 'sqlite';

/** The guard's refusal; the _sql tool turns it into "<label> query failed: refused before reaching the database: ...". */
export class SqlRefused extends Error {
  override name = 'SqlRefused';
}

/** Words that write, change schema, or control transactions. None belongs in one read-only SELECT. */
const FORBIDDEN_WORDS = new Set([
  'insert', 'update', 'delete', 'merge', 'upsert', 'into',
  'truncate', 'create', 'alter', 'drop', 'grant', 'revoke', 'copy',
  'vacuum', 'reindex', 'refresh', 'listen', 'unlisten', 'notify',
  'prepare', 'execute', 'deallocate',
  'attach', 'detach', 'pragma',
  'begin', 'commit', 'rollback', 'savepoint', 'checkpoint',
]);

/** Functions with effects outside the query that a read-only transaction does not stop. */
const FORBIDDEN_FUNCTIONS = new Set([
  'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf', 'pg_rotate_logfile',
  'set_config', 'pg_notify', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
  'lo_import', 'lo_export', 'load_extension',
]);
const FORBIDDEN_FUNCTION_PREFIXES = ['pg_advisory_', 'pg_try_advisory_', 'dblink'];

function isForbiddenFunction(word: string): boolean {
  return FORBIDDEN_FUNCTIONS.has(word) || FORBIDDEN_FUNCTION_PREFIXES.some((p) => word.startsWith(p));
}

/** Index just past the closing quote, or -1 when unterminated. Doubled quotes are escapes. */
function scanQuoted(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let j = start + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (backslashEscapes && c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return -1;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Same-length copy of `sql` with comments, literals and quoted identifiers blanked out. Comments
 * become spaces; literals and quoted identifiers become `literalFill` (spaces by default).
 */
export function maskSql(sql: string, dialect: SqlDialect, literalFill = ' '): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (dialect === 'postgres' && sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
          continue;
        }
        if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      if (depth > 0) throw new SqlRefused('unterminated /* comment');
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === "'") {
      const prev = sql[i - 1] ?? '';
      const beforePrev = sql[i - 2] ?? '';
      const escapeString = dialect === 'postgres' && /[eE]/.test(prev) && !IDENT_CHAR.test(beforePrev);
      const j = scanQuoted(sql, i, "'", escapeString);
      if (j === -1) throw new SqlRefused('unterminated string literal');
      out += literalFill.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '"' || (dialect === 'sqlite' && ch === '`')) {
      const j = scanQuoted(sql, i, ch, false);
      if (j === -1) throw new SqlRefused('unterminated quoted identifier');
      out += literalFill.repeat(j - i);
      i = j;
      continue;
    }
    if (dialect === 'sqlite' && ch === '[') {
      const close = sql.indexOf(']', i + 1);
      if (close === -1) throw new SqlRefused('unterminated [identifier]');
      out += literalFill.repeat(close + 1 - i);
      i = close + 1;
      continue;
    }
    if (dialect === 'postgres' && ch === '$' && !IDENT_CHAR.test(sql[i - 1] ?? '')) {
      const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new SqlRefused('unterminated dollar-quoted string');
        const stop = end + tag.length;
        out += literalFill.repeat(stop - i);
        i = stop;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Accepts exactly one read-only SELECT (or WITH ... SELECT) and returns it without trailing
 * semicolons. Throws SqlRefused otherwise. The database is still read-only underneath; this
 * only keeps obvious writes and multi-statements from reaching it.
 */
export function guardSelect(sql: string, dialect: SqlDialect): string {
  // Literals are filled with NUL rather than spaces so the trailing trim below stops at a query that
  // ends in one (`where id = 'x'`); a trailing comment is still trimmed.
  const masked = maskSql(sql, dialect, '\0');
  let end = masked.length;
  while (end > 0 && /[\s;]/.test(masked[end - 1]!)) end--;
  const body = masked.slice(0, end);
  if (body.trim() === '') throw new SqlRefused('the query is empty');
  if (body.includes(';')) throw new SqlRefused('only one statement is allowed; remove the extra ";"');
  const first = /^[\s(]*([A-Za-z_]+)/.exec(body)?.[1]?.toLowerCase();
  if (first !== 'select' && first !== 'with') {
    throw new SqlRefused(`only SELECT or WITH ... SELECT is allowed, not ${first ? first.toUpperCase() : 'this statement'}`);
  }
  for (const m of body.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)) {
    const word = m[0].toLowerCase();
    if (FORBIDDEN_WORDS.has(word)) {
      throw new SqlRefused(`${word.toUpperCase()} is not allowed: the connectors are read-only`);
    }
    const isCall = /^\s*\(/.test(body.slice((m.index ?? 0) + m[0].length));
    if (isCall && isForbiddenFunction(word)) {
      throw new SqlRefused(`${word}() is not allowed: it has effects outside a read-only query`);
    }
  }
  if (/\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i.test(body)) {
    throw new SqlRefused('row locks (FOR UPDATE / FOR SHARE) are not allowed');
  }
  return sql.slice(0, end).trim();
}
