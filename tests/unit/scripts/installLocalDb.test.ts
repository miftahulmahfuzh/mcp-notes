import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL = path.join(REPO, 'scripts', 'install.sh');
const URL = 'postgres://postgres:mcpnotes@127.0.0.1:55437/mcp_notes';
const POOLED = 'postgresql://u:p@ep-x-123-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb';
const DIRECT = 'postgresql://u:p@ep-x-123.c-2.ap-southeast-1.aws.neon.tech/neondb';

// A docker that records each call. $FAKE/c.<name> holds a container's Running state, $FAKE/db.<name> marks a database.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE/log"
case "$1" in
  inspect) name="\${@: -1}"; [[ -f "$FAKE/c.$name" ]] || exit 1; cat "$FAKE/c.$name" ;;
  rename) mv "$FAKE/c.$2" "$FAKE/c.$3" ;;
  run)
    while [[ $# -gt 0 ]]; do
      [[ "$1" == --name ]] && name="$2"
      [[ "$1" == POSTGRES_DB=* ]] && db="\${1#POSTGRES_DB=}"
      shift
    done
    echo true > "$FAKE/c.$name"; touch "$FAKE/db.$db" ;;
  start) echo true > "$FAKE/c.$2" ;;
  exec)
    all="$*"
    if [[ "$all" == *"from pg_database where datname = '"* ]]; then
      db="\${all##*datname = \\'}"; db="\${db%%\\'*}"
      [[ -f "$FAKE/db.$db" ]] && echo 1
    elif [[ "$all" == *"alter database "* ]]; then
      rest="\${all##*alter database }"; from="\${rest%% *}"; to="\${rest##* rename to }"
      mv "$FAKE/db.$from" "$FAKE/db.$to"
    elif [[ "$all" == *"create database "* ]]; then
      touch "$FAKE/db.\${all##*create database }"
    fi ;;
esac
exit 0
`;

let root: string;
let envLocal: string;
let fake: string;
let data: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'notes-local-db-install-'));
  envLocal = path.join(root, '.env.local');
  fake = path.join(root, 'fake');
  data = path.join(root, 'data');
  bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(fake, { recursive: true });
  await writeFile(path.join(bin, 'docker'), FAKE_DOCKER);
  await chmod(path.join(bin, 'docker'), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runs install_local_db with this test's .env.local; answers the docker calls it made in this run. */
function install(): string[] {
  const log = path.join(fake, 'log');
  const before = existsSync(log) ? readFileSync(log, 'utf8').length : 0;
  execFileSync('bash', ['-c', 'source "$1"; ENV_LOCAL="$2"; install_local_db', '_', INSTALL, envLocal], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, NOTES_DATA_DIR: data },
    stdio: 'pipe',
  });
  return existsSync(log) ? readFileSync(log, 'utf8').slice(before).trim().split('\n').filter(Boolean) : [];
}

const env = (): string => readFileSync(envLocal, 'utf8');

describe('install.sh install_local_db', () => {
  it('creates the container, points DATABASE_URL at it and keeps the direct Neon address to copy from', () => {
    const original = `LLM_MODEL=x\nDATABASE_URL=${POOLED}\nDATABASE_URL_UNPOOLED=${DIRECT}\nTMDB_API_KEY=k\n`;
    writeFileSync(envLocal, original);
    const calls = install();
    const run = calls.find((c) => c.startsWith('run '));
    expect(run).toContain('--name mcp-notes-pg ');
    expect(run).toContain('--restart unless-stopped');
    expect(run).toContain('-p 127.0.0.1:55437:5432');
    expect(run).toContain('-v mcp-notes-pg:/var/lib/postgresql/data');
    expect(env()).toContain(`\nDATABASE_URL=${URL}\n`);
    expect(env()).toContain(`\nIMPORT_DATABASE_URL=${DIRECT}\n`);
    expect(env()).not.toContain('DATABASE_URL_UNPOOLED');
    expect(env()).not.toContain(POOLED);
    expect(env()).toContain('LLM_MODEL=x\n');
    expect(env()).toContain('TMDB_API_KEY=k\n');
    const backups = readdirSync(data).filter((f) => f.startsWith('env.local.backup-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(data, backups[0]!), 'utf8')).toBe(original);

    const settled = env();
    const again = install();
    expect(again.some((c) => c.startsWith('run ') || c.startsWith('rename '))).toBe(false);
    expect(env()).toBe(settled);
    expect(readdirSync(data).filter((f) => f.startsWith('env.local.backup-'))).toHaveLength(1);
  });

  it('takes over the container and database an earlier version made for the movie tables', () => {
    writeFileSync(envLocal, `DATABASE_URL=${POOLED}\n# The movie and stream tables live in a database on this machine (scripts/install.sh).\nMOVIES_DATABASE_URL=postgres://postgres:mcpnotes@127.0.0.1:55437/mcp_notes_movies\n`);
    writeFileSync(path.join(fake, 'c.mcp-notes-pg-movies'), 'true\n');
    writeFileSync(path.join(fake, 'db.mcp_notes_movies'), '');
    const calls = install();
    expect(calls).toContain('rename mcp-notes-pg-movies mcp-notes-pg');
    expect(calls.some((c) => c.startsWith('run '))).toBe(false);
    expect(calls.some((c) => c.includes('alter database mcp_notes_movies rename to mcp_notes'))).toBe(true);
    expect(existsSync(path.join(fake, 'db.mcp_notes'))).toBe(true);
    expect(env()).toContain(`\nDATABASE_URL=${URL}\n`);
    expect(env()).toContain(`\nIMPORT_DATABASE_URL=${POOLED}\n`);
    expect(env()).not.toContain('MOVIES_DATABASE_URL');
    expect(env()).not.toContain('The movie and stream tables');
  });

  it('starts a stopped container', () => {
    writeFileSync(envLocal, `DATABASE_URL=${URL}\n`);
    writeFileSync(path.join(fake, 'c.mcp-notes-pg'), 'false\n');
    writeFileSync(path.join(fake, 'db.mcp_notes'), '');
    expect(install()).toContain('start mcp-notes-pg');
    expect(env()).toBe(`DATABASE_URL=${URL}\n`);
  });

  it("leaves the owner's own Postgres alone, and does nothing without .env.local", () => {
    expect(install()).toEqual([]);
    writeFileSync(envLocal, 'DATABASE_URL=postgres://me@127.0.0.1:5432/notes\n');
    expect(install()).toEqual([]);
    expect(env()).toBe('DATABASE_URL=postgres://me@127.0.0.1:5432/notes\n');
  });
});
