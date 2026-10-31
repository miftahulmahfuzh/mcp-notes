import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookCommand, mergeHooks, ourGroups, removeHooks, shQuote } from '../../../scripts/claude-hooks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const HELPER = path.join(REPO, 'scripts', 'claude-hooks.mjs');
const HOOKS_DIR = path.join(REPO, 'claude', 'hooks');
const NODE = process.execPath;

const EXISTING = {
  model: 'opus',
  env: { CLAUDE_CODE_PLUGIN_DIRS: '/home/u/mods' },
  enabledPlugins: { 'superpowers@market': true },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/u/guard.sh' }] }],
  },
};

let home: string;
let settings: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'notes-hooks-home-'));
  settings = path.join(home, '.claude', 'settings.json');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeSettings(value: unknown): Promise<string> {
  await mkdir(path.dirname(settings), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(settings, text, { mode: 0o644 });
  return text;
}

function cli(...args: string[]): string {
  return execFileSync(NODE, [HELPER, ...args], { encoding: 'utf8' });
}

function sourced(script: 'install.sh' | 'uninstall.sh', body: string, extraEnv: Record<string, string> = {}): void {
  execFileSync('bash', ['-c', `source "$1"; ${body}`, '_', path.join(REPO, 'scripts', script)], {
    env: { ...process.env, HOME: home, NODE_BIN: NODE, ...extraEnv },
    encoding: 'utf8',
  });
}

describe('mergeHooks / removeHooks', () => {
  const opts = { nodeBin: '/opt/node/bin/node', hooksDir: '/home/u/mcp-notes/claude/hooks' };

  it('adds our three groups and keeps everything else', () => {
    const merged = mergeHooks(EXISTING, opts) as typeof EXISTING & { hooks: { UserPromptSubmit: unknown[] } };
    expect(merged.env).toEqual(EXISTING.env);
    expect(merged.enabledPlugins).toEqual(EXISTING.enabledPlugins);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop[0]).toEqual(EXISTING.hooks.Stop[0]);
    expect(merged.hooks.Stop[1]).toEqual({
      hooks: [{ type: 'command', command: "'/opt/node/bin/node' '/home/u/mcp-notes/claude/hooks/notes-capture.mjs'", async: true, timeout: 60 }],
    });
    expect(merged.hooks.PreToolUse[1]).toEqual({
      matcher: 'mcp__notes__similar_images',
      hooks: [{ type: 'command', command: "'/opt/node/bin/node' '/home/u/mcp-notes/claude/hooks/notes-paste.mjs'", timeout: 30 }],
    });
    expect(merged.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: "'/opt/node/bin/node' '/home/u/mcp-notes/claude/hooks/notes-prompt.mjs'", timeout: 20 }] },
    ]);
    expect(Object.keys(ourGroups(opts))).toEqual(['Stop', 'PreToolUse', 'UserPromptSubmit']);
  });

  it('keeps a user UserPromptSubmit hook and upgrades a two-hook install in place', () => {
    const userHook = { hooks: [{ type: 'command', command: '/home/u/prompt-guard.sh' }] };
    const twoHookInstall = {
      ...EXISTING,
      hooks: {
        Stop: [...EXISTING.hooks.Stop, { hooks: [{ type: 'command', command: "'/old/node' '/old/claude/hooks/notes-capture.mjs'", async: true, timeout: 60 }] }],
        PreToolUse: [
          ...EXISTING.hooks.PreToolUse,
          { matcher: 'mcp__notes__similar_images', hooks: [{ type: 'command', command: "'/old/node' '/old/claude/hooks/notes-paste.mjs'", timeout: 30 }] },
        ],
        UserPromptSubmit: [userHook],
      },
    };
    const merged = mergeHooks(twoHookInstall, opts) as { hooks: Record<string, unknown[]> };
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.UserPromptSubmit).toHaveLength(2);
    expect(merged.hooks.UserPromptSubmit![0]).toEqual(userHook);
    expect(JSON.stringify(merged)).not.toContain('/old/');
    expect(mergeHooks(merged, opts)).toEqual(merged);
    const removed = removeHooks(merged) as { hooks: Record<string, unknown[]> };
    expect(removed.hooks.UserPromptSubmit).toEqual([userHook]);
    expect(removed.hooks.Stop).toEqual(EXISTING.hooks.Stop);
  });

  it('is idempotent and replaces an entry left by another checkout', () => {
    const once = mergeHooks(EXISTING, { nodeBin: '/old/node', hooksDir: '/old/checkout/claude/hooks' });
    const twice = mergeHooks(once, opts);
    expect(mergeHooks(twice, opts)).toEqual(twice);
    expect(JSON.stringify(twice)).not.toContain('/old/checkout');
    expect((twice as typeof EXISTING).hooks.Stop).toHaveLength(2);
  });

  it('works without a hooks key and removeHooks restores the original exactly', () => {
    const plain = { model: 'opus', env: { A: '1' } };
    const merged = mergeHooks(plain, opts);
    expect(Object.keys(merged)).toEqual(['model', 'env', 'hooks']);
    expect(removeHooks(merged)).toEqual(plain);
    expect(removeHooks(mergeHooks(EXISTING, opts))).toEqual(EXISTING);
    expect(removeHooks(EXISTING)).toBe(EXISTING);
  });

  it('the deny strategy bakes the env prefix into the paste command only', () => {
    const merged = mergeHooks({}, { ...opts, pasteStrategy: 'deny' }) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(merged.hooks.PreToolUse![0]!.hooks[0]!.command.startsWith("NOTES_PASTE_STRATEGY='deny' ")).toBe(true);
    expect(merged.hooks.Stop![0]!.hooks[0]!.command.startsWith("'/opt/node")).toBe(true);
  });

  it('quotes paths with single quotes safely', () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(hookCommand('/n', "/x y/notes-capture.mjs")).toBe(`'/n' '/x y/notes-capture.mjs'`);
  });
});

describe('scripts/claude-hooks.mjs against a temp HOME', () => {
  it('creates the file (0600) when there is none, without a backup', async () => {
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const value = JSON.parse(await readFile(settings, 'utf8'));
    expect(Object.keys(value.hooks)).toEqual(['Stop', 'PreToolUse', 'UserPromptSubmit']);
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    expect(existsSync(`${settings}.bak-notes-hooks`)).toBe(false);
  });

  it('second run leaves the file byte-identical; backup kept once with the original', async () => {
    const original = await writeSettings(EXISTING);
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const first = await readFile(settings, 'utf8');
    expect(cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR)).toMatch(/^unchanged/);
    expect(await readFile(settings, 'utf8')).toBe(first);
    expect(await readFile(`${settings}.bak-notes-hooks`, 'utf8')).toBe(original);
    expect((await stat(settings)).mode & 0o777).toBe(0o644);
    cli('uninstall', '--settings', settings);
    expect(await readFile(settings, 'utf8')).toBe(original);
    expect(await readFile(`${settings}.bak-notes-hooks`, 'utf8')).toBe(original);
  });

  it('refuses invalid JSON and leaves the file alone', async () => {
    await mkdir(path.dirname(settings), { recursive: true });
    await writeFile(settings, '{ not json');
    const run = spawnSync(NODE, [HELPER, 'install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/cannot read/);
    expect(await readFile(settings, 'utf8')).toBe('{ not json');
  });

  it('status reports all three hooks', async () => {
    cli('install', '--settings', settings, '--node', NODE, '--hooks-dir', HOOKS_DIR);
    const out = cli('status', '--settings', settings);
    expect(out).toMatch(/Stop notes-capture: .*notes-capture\.mjs/);
    expect(out).toMatch(/PreToolUse notes-paste: .*notes-paste\.mjs/);
    expect(out).toMatch(/UserPromptSubmit notes-prompt: .*notes-prompt\.mjs/);
    cli('uninstall', '--settings', settings);
    expect(cli('status', '--settings', settings)).toMatch(/UserPromptSubmit notes-prompt: not registered/);
  });
});

describe('install.sh / uninstall.sh (sourced, temp HOME)', () => {
  it('register_hooks merges into ~/.claude/settings.json, twice = identical, uninstall restores', async () => {
    const original = await writeSettings(EXISTING);
    sourced('install.sh', 'register_hooks');
    const first = await readFile(settings, 'utf8');
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-capture.mjs'));
    expect(first).toContain(path.join(REPO, 'claude', 'hooks', 'notes-prompt.mjs'));
    expect(first).toContain(NODE);
    sourced('install.sh', 'register_hooks');
    expect(await readFile(settings, 'utf8')).toBe(first);
    sourced('uninstall.sh', 'unregister_hooks');
    expect(await readFile(settings, 'utf8')).toBe(original);
  });

  it('--skip-hooks and NOTES_SKIP_HOOKS=1 leave settings.json alone', async () => {
    sourced('install.sh', 'parse_args --skip-hooks; register_hooks');
    expect(existsSync(settings)).toBe(false);
    sourced('install.sh', 'register_hooks', { NOTES_SKIP_HOOKS: '1' });
    expect(existsSync(settings)).toBe(false);
  });

  it('sourcing does not run main', () => {
    expect(() => sourced('install.sh', 'true')).not.toThrow();
    expect(() => sourced('uninstall.sh', 'true')).not.toThrow();
  });
});
