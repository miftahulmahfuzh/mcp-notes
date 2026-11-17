import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL = path.join(REPO, 'scripts', 'install.sh');
const URL = 'postgres://postgres:mcpnotes@127.0.0.1:55437/mcp_notes_movies';

// A docker that records each call; a container exists once `run` made its marker.
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) [[ -f "$FAKE_DOCKER_LOG.container" ]] || exit 1; cat "$FAKE_DOCKER_LOG.container" ;;
  run) echo true > "$FAKE_DOCKER_LOG.container" ;;
  start) echo true > "$FAKE_DOCKER_LOG.container" ;;
esac
exit 0
`;

let root: string;
let envLocal: string;
let log: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'notes-movies-db-install-'));
  envLocal = path.join(root, '.env.local');
  log = path.join(root, 'docker.log');
  bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'docker'), FAKE_DOCKER);
  await chmod(path.join(bin, 'docker'), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runs install_movies_db with this test's .env.local; answers the docker calls it made. */
function install(pathEnv = `${bin}:${process.env.PATH}`): string[] {
  execFileSync('bash', ['-c', 'source "$1"; ENV_LOCAL="$2"; install_movies_db', '_', INSTALL, envLocal], {
    env: { ...process.env, PATH: pathEnv, FAKE_DOCKER_LOG: log },
    stdio: 'pipe',
  });
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

describe('install.sh install_movies_db', () => {
  it('creates the container once and names it in .env.local once', () => {
    writeFileSync(envLocal, 'DATABASE_URL=postgres://neon/db\n');
    const calls = install();
    const run = calls.find((c) => c.startsWith('run '));
    expect(run).toContain('--name mcp-notes-pg-movies');
    expect(run).toContain('--restart unless-stopped');
    expect(run).toContain('-p 127.0.0.1:55437:5432');
    expect(run).toContain('-v mcp-notes-pg-movies:/var/lib/postgresql/data');
    expect(readFileSync(envLocal, 'utf8')).toContain(`MOVIES_DATABASE_URL=${URL}\n`);

    const again = install().slice(calls.length);
    expect(again.some((c) => c.startsWith('run '))).toBe(false);
    expect(readFileSync(envLocal, 'utf8').match(/MOVIES_DATABASE_URL=/g)).toHaveLength(1);
  });

  it('starts a stopped container', () => {
    writeFileSync(envLocal, `MOVIES_DATABASE_URL=${URL}\n`);
    writeFileSync(`${log}.container`, 'false\n');
    expect(install()).toContain('start mcp-notes-pg-movies');
  });

  it("leaves the owner's own movies database alone", () => {
    writeFileSync(envLocal, 'MOVIES_DATABASE_URL=postgres://me@127.0.0.1:5432/films\n');
    expect(install()).toEqual([]);
    expect(readFileSync(envLocal, 'utf8')).toBe('MOVIES_DATABASE_URL=postgres://me@127.0.0.1:5432/films\n');
  });

  it('does nothing with the movie library off or without .env.local', () => {
    expect(install()).toEqual([]);
    writeFileSync(envLocal, 'NOTESD_MOVIES=off\n');
    expect(install()).toEqual([]);
    expect(readFileSync(envLocal, 'utf8')).toBe('NOTESD_MOVIES=off\n');
  });
});
