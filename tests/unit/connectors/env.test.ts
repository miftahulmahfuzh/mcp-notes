import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectorSettings,
  connectorTimeoutMs,
  loadDatabaseTarget,
  pickDirectUrl,
  prepareUrl,
  resolveRepoDir,
  secretsOf,
} from '../../../src/connectors/env.js';
import { reasonOf, scrub } from '../../../src/connectors/errors.js';
import { ConnectorError } from '../../../src/connectors/types.js';

const POOLED = 'postgresql://owner:pw-secret@ep-cool-123-pooler.ap-southeast-1.aws.neon.tech/db?sslmode=require';
const DIRECT = 'postgresql://owner:pw-secret@ep-cool-123.ap-southeast-1.aws.neon.tech/db?sslmode=require';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'mcp-notes-conn-env-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('pickDirectUrl', () => {
  it('chooses the non-pooler host whatever the key names say', () => {
    expect(pickDirectUrl({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT })).toBe(DIRECT);
    expect(pickDirectUrl({ DATABASE_URL: DIRECT, DATABASE_URL_UNPOOLED: POOLED })).toBe(DIRECT);
    expect(pickDirectUrl({ DATABASE_URL: ` ${POOLED} ` })).toBe(POOLED);
    expect(pickDirectUrl({})).toBeUndefined();
  });
});

describe('prepareUrl', () => {
  it('spells sslmode=require as verify-full and drops options', () => {
    const out = new URL(prepareUrl(`${DIRECT}&options=-c%20default_transaction_read_only%3Doff`));
    expect(out.searchParams.get('sslmode')).toBe('verify-full');
    expect(out.searchParams.has('options')).toBe(false);
    expect(prepareUrl('postgres://u:p@127.0.0.1:5432/x')).toBe('postgres://u:p@127.0.0.1:5432/x');
    expect(prepareUrl('not a url')).toBe('not a url');
  });
});

describe('loadDatabaseTarget', () => {
  it('reads .env.local at call time, never touching process.env', () => {
    const repo = tempDir();
    writeFileSync(path.join(repo, '.env.local'), `DATABASE_URL=${POOLED}\nDATABASE_URL_UNPOOLED=${DIRECT}\n`);
    const before = { ...process.env };
    const target = loadDatabaseTarget('expenses', repo);
    expect(process.env).toEqual(before);
    expect(new URL(target.url).hostname).toBe('ep-cool-123.ap-southeast-1.aws.neon.tech');
    expect(target.secrets).toEqual(expect.arrayContaining(['pw-secret', 'owner', DIRECT]));
    writeFileSync(path.join(repo, '.env.local'), 'DATABASE_URL=postgres://u:rotated@127.0.0.1:1/x\n');
    expect(loadDatabaseTarget('expenses', repo).url).toContain('rotated');
  });

  it('missing repo, missing file and missing keys are "not reachable" errors', () => {
    const repo = tempDir();
    expect(() => loadDatabaseTarget('runs', path.join(repo, 'nope'))).toThrow(/^run-insights is not reachable: no repository at /);
    expect(() => loadDatabaseTarget('runs', repo)).toThrow(/^run-insights is not reachable: no \.env\.local in /);
    writeFileSync(path.join(repo, '.env.local'), 'OTHER=1\n');
    expect(() => loadDatabaseTarget('runs', repo)).toThrow(ConnectorError);
    expect(() => loadDatabaseTarget('runs', repo)).toThrow(/has no DATABASE_URL or DATABASE_URL_UNPOOLED/);
  });
});

describe('settings, read per call', () => {
  it('real env wins over the notes .env.local; only connector keys are read', () => {
    const dir = tempDir();
    const file = path.join(dir, '.env.local');
    writeFileSync(file, 'SEER_DIR=/from/file\nRUN_INSIGHTS_DIR=/runs/file\nDATABASE_URL=postgres://x\n');
    const s = connectorSettings({ env: { SEER_DIR: '/from/env' }, envFile: file });
    expect(s).toEqual({ SEER_DIR: '/from/env', RUN_INSIGHTS_DIR: '/runs/file' });
    expect(connectorSettings({ env: {}, envFile: false })).toEqual({});
  });

  it('resolves repo dirs with ~ and defaults', () => {
    expect(resolveRepoDir('expenses', {})).toBe(path.join(homedir(), 'expense-tracking'));
    expect(resolveRepoDir('seer', { SEER_DIR: '~/x/seer' })).toBe(path.join(homedir(), 'x/seer'));
    expect(resolveRepoDir('runs', { RUN_INSIGHTS_DIR: 'rel/dir' })).toBe(path.resolve('rel/dir'));
  });

  it('parses CONNECTOR_TIMEOUT_MS with a safe default', () => {
    expect(connectorTimeoutMs({})).toBe(10_000);
    expect(connectorTimeoutMs({ CONNECTOR_TIMEOUT_MS: '2500' })).toBe(2500);
    expect(connectorTimeoutMs({ CONNECTOR_TIMEOUT_MS: 'abc' })).toBe(10_000);
    expect(connectorTimeoutMs({ CONNECTOR_TIMEOUT_MS: '5' })).toBe(10_000);
  });
});

describe('scrubbing', () => {
  it('removes the URL, user, password and host from any message', () => {
    const msg = `password authentication failed for user "owner" at ep-cool-123.ap-southeast-1.aws.neon.tech using ${DIRECT} (pw-secret)`;
    const out = scrub(msg, secretsOf(DIRECT));
    for (const s of ['owner', 'pw-secret', 'ep-cool-123', 'postgresql://']) expect(out).not.toContain(s);
    expect(scrub('ab cd', ['ab'])).toBe('ab cd');
  });

  it('reasonOf unwraps AggregateError and falls back to the error code', () => {
    expect(reasonOf(new AggregateError([new Error('connect ECONNREFUSED ::1:1')], ''))).toBe('connect ECONNREFUSED ::1:1');
    expect(reasonOf(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(reasonOf(new Error('a\n  b'))).toBe('a b');
  });
});
