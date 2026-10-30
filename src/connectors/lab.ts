import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { displayPath } from './env.js';
import { queryFailed, reasonOf, unreachable } from './errors.js';
import { capRows, wrapWithLimit } from './rows.js';
import type { QueryResult } from './types.js';

/**
 * Plain CommonJS, run with `node --no-warnings -e`. Opens the file with readOnly: true (no
 * write lock, safe while Seer's own processes use it), runs one statement, replies on stdout.
 */
export const LAB_CHILD_SOURCE = String.raw`
const chunks = [];
const reply = (v) => process.stdout.write(JSON.stringify(v));
function norm(v) {
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (v instanceof Uint8Array) return '<blob ' + v.length + ' bytes>';
  return v;
}
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let req;
  try {
    req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    reply({ ok: false, stage: 'query', message: 'bad request to the lab reader' });
    return;
  }
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    reply({ ok: false, stage: 'open', message: 'node:sqlite is not available: ' + String((e && e.message) || e) });
    return;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(req.path, { readOnly: true });
  } catch (e) {
    reply({ ok: false, stage: 'open', message: String((e && e.message) || e) });
    return;
  }
  try {
    const stmt = db.prepare(req.sql);
    stmt.setReadBigInts(true);
    stmt.setReturnArrays(true);
    const columns = stmt.columns().map((c) => c.name);
    const rows = stmt.all(...req.params).map((row) => row.map(norm));
    reply({ ok: true, columns, rows });
  } catch (e) {
    reply({ ok: false, stage: 'query', message: String((e && e.message) || e) });
  } finally {
    try { db.close(); } catch (e) {}
  }
});
`;

interface LabReply {
  ok: boolean;
  stage?: 'open' | 'query';
  message?: string;
  columns?: string[];
  rows?: unknown[][];
}

export interface LabRunOptions {
  cap: number;
  timeoutMs: number;
  /** false runs `sql` as given (tests prove the file refuses writes). Default true. */
  wrap?: boolean;
}

export function runLabQuery(
  label: string,
  labPath: string,
  sql: string,
  params: readonly unknown[],
  opts: LabRunOptions,
): Promise<QueryResult> {
  if (!existsSync(labPath)) {
    return Promise.reject(unreachable(label, `no lab database at ${displayPath(labPath)}`));
  }
  return new Promise<QueryResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '-e', LAB_CHILD_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {},
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(queryFailed(label, `lab query timed out after ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) =>
      finish(() => reject(unreachable(label, `cannot start the lab reader: ${reasonOf(err)}`))),
    );
    child.on('close', (code) =>
      finish(() => {
        let msg: LabReply;
        try {
          msg = JSON.parse(stdout) as LabReply;
        } catch {
          reject(queryFailed(label, `lab reader exited with ${code}: ${reasonOf(stderr.slice(0, 300))}`));
          return;
        }
        if (!msg.ok) {
          const reason = msg.message ?? 'unknown error';
          reject(
            msg.stage === 'open'
              ? unreachable(label, `cannot open ${displayPath(labPath)}: ${reason}`)
              : queryFailed(label, reason),
          );
          return;
        }
        resolve(capRows(msg.columns ?? [], msg.rows ?? [], opts.cap));
      }),
    );
    // The child may exit before reading stdin (killed): ignore EPIPE.
    child.stdin.on('error', () => {});
    const text = opts.wrap === false ? sql : wrapWithLimit(sql, opts.cap);
    child.stdin.end(JSON.stringify({ path: labPath, sql: text, params: [...params] }));
  });
}
