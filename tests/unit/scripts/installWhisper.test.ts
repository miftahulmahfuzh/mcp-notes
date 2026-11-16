import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INSTALL = path.join(REPO, 'scripts', 'install.sh');

// A python3 that records each call, passes the venv check, makes a "venv" by copying itself and
// remembers a pip install in a marker beside its own bin folder.
const FAKE_PYTHON = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_PY_LOG"
here="$(cd "$(dirname "$0")/.." && pwd)"
case "$1" in
  -c) exit 0 ;;
  -m)
    if [[ "$2" == venv ]]; then dir="\${@: -1}"; mkdir -p "$dir/bin"; cp "$0" "$dir/bin/python"; exit 0; fi
    if [[ "$2" == pip ]]; then touch "$here/installed"; exit 0; fi
    ;;
  -I)
    if [[ "$2" == -c ]]; then [[ -f "$here/installed" ]]; exit $?; fi
    printf '{"ready": true, "model": "fake"}\\n'
    exit 0
    ;;
esac
exit 0
`;

let root: string;
let data: string;
let envLocal: string;
let pyLog: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'notes-whisper-install-'));
  data = path.join(root, 'data');
  envLocal = path.join(root, '.env.local');
  pyLog = path.join(root, 'python.log');
  bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(root, 'home'), { recursive: true });
  await writeFile(path.join(bin, 'python3'), FAKE_PYTHON);
  await chmod(path.join(bin, 'python3'), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Runs install_whisper with this test's .env.local; answers the python calls it made. */
function installWhisper(envText: string | null): string[] {
  if (envText === null) rmSync(envLocal, { force: true });
  else writeFileSync(envLocal, envText);
  rmSync(pyLog, { force: true });
  execFileSync('bash', ['-c', 'source "$1"; ENV_LOCAL="$2"; install_whisper', '_', INSTALL, envLocal], {
    env: { ...process.env, HOME: path.join(root, 'home'), NOTES_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, FAKE_PY_LOG: pyLog },
    encoding: 'utf8',
  });
  return existsSync(pyLog) ? readFileSync(pyLog, 'utf8').trim().split('\n') : [];
}

describe('install.sh install_whisper (sourced, fake python3)', () => {
  it('makes the venv, installs the pinned faster-whisper and loads the model on the first run', () => {
    const calls = installWhisper(null);
    const venv = path.join(data, 'whisper', 'venv');
    expect(calls).toContain(`-m venv --clear ${venv}`);
    expect(calls.some((c) => /^-m pip install .*faster-whisper==1\.2\.1$/.test(c))).toBe(true);
    expect(calls.at(-1)).toBe(`-I ${path.join(REPO, 'claude', 'streaming', 'torrent', 'whisper.py')} --model small --threads 2 --models-dir ${path.join(data, 'whisper', 'models')} --download-only`);
  });

  it('a second run installs nothing and only checks the model', () => {
    installWhisper(null);
    const calls = installWhisper(null);
    expect(calls.some((c) => c.startsWith('-m venv') || c.startsWith('-m pip'))).toBe(false);
    expect(calls.at(-1)).toMatch(/--download-only$/);
  });

  it('takes the folder and the model from .env.local', () => {
    const dir = path.join(root, 'w');
    const calls = installWhisper(`NOTESD_TORRENT_WHISPER_MODEL="base.en"\nNOTESD_TORRENT_WHISPER_DIR=${dir}\n`);
    expect(calls).toContain(`-m venv --clear ${path.join(dir, 'venv')}`);
    expect(calls.at(-1)).toContain('--model base.en');
  });

  it('installs nothing when .env.local turns torrents or Whisper off', () => {
    expect(installWhisper('NOTESD_TORRENT_WHISPER=off\n')).toEqual([]);
    expect(installWhisper('NOTESD_TORRENT=OFF\n')).toEqual([]);
  });
});
