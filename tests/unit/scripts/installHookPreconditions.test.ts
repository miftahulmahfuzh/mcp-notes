import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_SCRIPTS } from '../../../scripts/claude-hooks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL = path.join(REPO, 'scripts', 'install.sh');

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notesd-install-hooks-'));
  // systemctl and curl stand-ins: check_preconditions only asks whether they exist and answer.
  const bin = path.join(tmp, 'bin');
  await mkdir(bin);
  for (const name of ['systemctl', 'curl']) {
    await writeFile(path.join(bin, name), '#!/usr/bin/env bash\nexit 0\n');
    await chmod(path.join(bin, name), 0o755);
  }
  await mkdir(path.join(tmp, 'hooks'));
  await mkdir(path.join(tmp, 'skills'));
  for (const script of HOOK_SCRIPTS) await writeFile(path.join(tmp, 'hooks', script), '// hook\n');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/**
 * install.sh's check_preconditions alone: the script is sourced, so nothing is built, changed or
 * restarted, and HOME, the hooks and skills directories and the tools it asks for are all stand-ins.
 */
function preconditions(): { code: number; stderr: string; stdout: string } {
  const script = [
    'source "$1"',
    'PATH="$2/bin:$PATH"',
    'HOOKS_DIR="$2/hooks"',
    'SKILLS_DIR="$2/skills"',
    'NODE_BIN="$3"',
    'NODE_DIR="$(dirname "$3")"',
    'DATA_DIR="$2/data"',
    'CLAUDE_REAL="$2/claude"',
    'check_preconditions',
    'echo preconditions-passed',
  ].join('; ');
  const r = spawnSync('bash', ['-c', script, '_', INSTALL, tmp, process.execPath], { encoding: 'utf8', env: { ...process.env, HOME: tmp } });
  return { code: r.status ?? 1, stderr: r.stderr, stdout: r.stdout };
}

describe('install.sh checks every hook script before it changes anything', () => {
  it('passes with every hook the settings merge installs', () => {
    const r = preconditions();
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('preconditions-passed');
  });

  // The hook merge (claude-hooks.mjs install) checks HOOK_SCRIPTS too, but only after the daemon was
  // rebuilt and restarted: install.sh must refuse first, for each of them.
  it.each(HOOK_SCRIPTS)('refuses when %s is missing', async (script) => {
    await rm(path.join(tmp, 'hooks', script));
    const r = preconditions();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`missing ${path.join(tmp, 'hooks', script)}.`);
    expect(r.stdout).not.toContain('preconditions-passed');
  });
});
