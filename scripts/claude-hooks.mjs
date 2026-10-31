#!/usr/bin/env node
/**
 * Adds, removes or reports the three mcp-notes Claude Code hooks in a settings.json
 * (normally ~/.claude/settings.json), leaving every other key and every other hook as it was.
 *
 *   node scripts/claude-hooks.mjs install   --settings FILE --node /abs/node --hooks-dir /abs/repo/claude/hooks [--paste-strategy updatedInput|deny]
 *   node scripts/claude-hooks.mjs uninstall --settings FILE
 *   node scripts/claude-hooks.mjs status    --settings FILE
 *
 * Our handlers are recognised by the script name in their command (notes-capture.mjs,
 * notes-paste.mjs, notes-prompt.mjs), so an entry left by another checkout is replaced, never duplicated. install is
 * idempotent: a second run leaves the file byte-identical. Before the first change to an existing
 * file a copy is kept at FILE.bak-notes-hooks (once; never overwritten). Writes are atomic
 * (temp file + rename) on the symlink target, keeping the file's mode.
 */
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const OUR_SCRIPT = /notes-(?:capture|paste|prompt)\.mjs(?=['"\s]|$)/;
export const PASTE_MATCHER = 'mcp__notes__(similar_images|create_image|attach_image)';
export const BACKUP_SUFFIX = '.bak-notes-hooks';
export const STOP_TIMEOUT_S = 60;
export const PASTE_TIMEOUT_S = 30;
export const PROMPT_TIMEOUT_S = 20;
export const PASTE_STRATEGIES = ['updatedInput', 'deny'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** POSIX single-quoting: safe for any path. */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(nodeBin, script, env = {}) {
  const prefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shQuote(value)} `)
    .join('');
  return `${prefix}${shQuote(nodeBin)} ${shQuote(script)}`;
}

export function isOurHandler(handler) {
  return isPlainObject(handler) && typeof handler.command === 'string' && OUR_SCRIPT.test(handler.command);
}

function stripOurs(groups) {
  const kept = [];
  let removed = 0;
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = group.hooks.filter((handler) => !isOurHandler(handler));
    removed += group.hooks.length - handlers.length;
    if (handlers.length === group.hooks.length) kept.push(group);
    else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
  }
  return { groups: kept, removed };
}

/** The three matcher groups this repo installs. */
export function ourGroups({ nodeBin, hooksDir, pasteStrategy = 'updatedInput' }) {
  const pasteEnv = pasteStrategy === 'deny' ? { NOTES_PASTE_STRATEGY: 'deny' } : {};
  return {
    Stop: {
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodeBin, path.join(hooksDir, 'notes-capture.mjs')),
          async: true,
          timeout: STOP_TIMEOUT_S,
        },
      ],
    },
    PreToolUse: {
      matcher: PASTE_MATCHER,
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodeBin, path.join(hooksDir, 'notes-paste.mjs'), pasteEnv),
          timeout: PASTE_TIMEOUT_S,
        },
      ],
    },
    UserPromptSubmit: {
      hooks: [
        {
          type: 'command',
          command: hookCommand(nodeBin, path.join(hooksDir, 'notes-prompt.mjs')),
          timeout: PROMPT_TIMEOUT_S,
        },
      ],
    },
  };
}

/** `settings` with our handlers removed from every event and our groups appended last. */
export function mergeHooks(settings, options) {
  const base = isPlainObject(settings) ? settings : {};
  const hooks = isPlainObject(base.hooks) ? { ...base.hooks } : {};
  for (const [event, group] of Object.entries(ourGroups(options))) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [...stripOurs(existing).groups, group];
  }
  return { ...base, hooks };
}

/** `settings` without our handlers; events and `hooks` emptied by the removal are dropped. Same object when nothing is ours. */
export function removeHooks(settings) {
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return settings;
  const hooks = { ...settings.hooks };
  let touched = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const { groups, removed } = stripOurs(hooks[event]);
    if (removed === 0) continue;
    touched = true;
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }
  if (!touched) return settings;
  const out = { ...settings };
  if (Object.keys(hooks).length === 0) delete out.hooks;
  else out.hooks = hooks;
  return out;
}

/** `{event: command}` for each of our handlers present. */
export function ourHandlers(settings) {
  const found = {};
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return found;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      for (const handler of group.hooks) {
        if (isOurHandler(handler)) found[event] = handler.command;
      }
    }
  }
  return found;
}

export async function readSettings(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, text: null, value: {} };
    throw err;
  }
  if (text.trim() === '') return { exists: true, text, value: {} };
  const value = JSON.parse(text);
  if (!isPlainObject(value)) throw new Error(`${file} does not hold a JSON object`);
  return { exists: true, text, value };
}

export function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** 'unchanged' when `next` equals what is there; otherwise backs up once, writes atomically, 'written'. */
export async function writeSettings(file, current, next) {
  if (current.exists && JSON.stringify(current.value) === JSON.stringify(next)) return 'unchanged';
  const target = current.exists ? await realpath(file).catch(() => file) : file;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  if (current.exists) {
    mode = (await stat(target)).mode & 0o777;
    const backup = `${file}${BACKUP_SUFFIX}`;
    if (!existsSync(backup)) await copyFile(target, backup);
  }
  const tmp = `${target}.tmp-notes-hooks-${process.pid}`;
  await writeFile(tmp, serialize(next), { mode });
  await rename(tmp, target);
  return 'written';
}

function fail(message) {
  process.stderr.write(`claude-hooks: ${message}\n`);
  process.exit(1);
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      settings: { type: 'string' },
      node: { type: 'string' },
      'hooks-dir': { type: 'string' },
      'paste-strategy': { type: 'string' },
    },
  });
  const command = positionals[0];
  const file = values.settings;
  if (file === undefined || file === '') fail('--settings is required');
  let current;
  try {
    current = await readSettings(file);
  } catch (err) {
    fail(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (command === 'install') {
    const nodeBin = values.node;
    const hooksDir = values['hooks-dir'];
    const pasteStrategy = values['paste-strategy'] ?? 'updatedInput';
    if (nodeBin === undefined || !path.isAbsolute(nodeBin)) fail('--node must be an absolute path');
    if (hooksDir === undefined || !path.isAbsolute(hooksDir)) fail('--hooks-dir must be an absolute path');
    if (!PASTE_STRATEGIES.includes(pasteStrategy)) fail(`--paste-strategy must be one of ${PASTE_STRATEGIES.join(', ')}`);
    for (const script of ['notes-capture.mjs', 'notes-paste.mjs', 'notes-prompt.mjs']) {
      if (!existsSync(path.join(hooksDir, script))) fail(`missing ${path.join(hooksDir, script)}`);
    }
    const result = await writeSettings(file, current, mergeHooks(current.value, { nodeBin, hooksDir, pasteStrategy }));
    process.stdout.write(`${result}: ${file}\n`);
    return;
  }
  if (command === 'uninstall') {
    if (!current.exists) {
      process.stdout.write(`unchanged: ${file} (absent)\n`);
      return;
    }
    const result = await writeSettings(file, current, removeHooks(current.value));
    process.stdout.write(`${result}: ${file}\n`);
    return;
  }
  if (command === 'status') {
    const found = ourHandlers(current.value);
    process.stdout.write(`Stop notes-capture: ${found.Stop ?? 'not registered'}\n`);
    process.stdout.write(`PreToolUse notes-paste: ${found.PreToolUse ?? 'not registered'}\n`);
    process.stdout.write(`UserPromptSubmit notes-prompt: ${found.UserPromptSubmit ?? 'not registered'}\n`);
    return;
  }
  fail('usage: claude-hooks.mjs install|uninstall|status --settings FILE [--node ABS --hooks-dir ABS --paste-strategy updatedInput|deny]');
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
