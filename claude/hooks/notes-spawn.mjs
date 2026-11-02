#!/usr/bin/env node
/**
 * notes-spawn: Claude Code PreToolUse hook on Bash for mcp-notes (the session graph).
 *
 * When this session's Bash command launches Claude Code in tmux by hand (tmux new-window /
 * split-window / new-session / respawn-* running `claude`, or send-keys typing `claude`), it records
 * a pending spawn {parent: this session, cwd, name, host} at notesd (POST /api/sessions/hook/spawn).
 * The child's SessionStart hook (notes-session) claims it within 30 s, which links child -> this
 * session as 'hook'.
 *
 * Skipped: anything that is not a Bash call; a command without both a `tmux` and a `claude` word
 * (no I/O at all); a command that goes through swarm.py or already passes CC_PARENT_SESSION (those
 * children carry an exact 'env' link); `claude -p/--print` and `claude --resume/--continue` (no new
 * interactive session to link); non-`cli` sessions.
 *
 * It never decides anything: it prints nothing, so Claude Code's normal permission flow runs, and
 * it always exits 0. Problems go to ${XDG_STATE_HOME:-~/.local/state}/notes-capture/spawn.log.
 * Node >= 22 built-ins only.
 */
import os from 'node:os';
import path from 'node:path';
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';
import { cleanName, isClaudeWord, isCliSession, sessionIdOf } from './notes-session.mjs';

export const TOOL_NAME = 'Bash';
export const SPAWN_PATH = '/api/sessions/hook/spawn';
export const POST_TIMEOUT_MS = 1500;
export const LOG_FILE = 'spawn.log';

const TMUX_WORD = /\btmux\b/;
const CLAUDE_WORD = /\bclaude\b/;
const LAUNCH_COMMANDS = new Set([
  'new-window', 'neww', 'split-window', 'splitw', 'new-session', 'new',
  'respawn-pane', 'respawnp', 'respawn-window', 'respawnw',
]);
const SEND_COMMANDS = new Set(['send-keys', 'send']);
/** tmux's own flags that take a value (`tmux -L sock new-window ...`). */
const TMUX_GLOBAL_ARG_LETTERS = 'LSfcT';
/** Flags taking a value across new-window, split-window, new-session and respawn-*. */
const LAUNCH_ARG_LETTERS = 'ceFflnpstxy';
const SEND_ARG_LETTERS = 'cNt';
const KEY_NAME = /^(Enter|C-m|C-j|KPEnter|Escape|Space|Tab|BSpace)$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const WRAPPERS = new Set(['exec', 'command', 'nohup', 'env', 'time']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SKIP = Symbol('skip');

/** Cheap pre-check, no I/O: both words present and not a swarm.py / CC_PARENT_SESSION launch. */
export function mayLaunchClaude(command) {
  if (typeof command !== 'string') return false;
  if (!TMUX_WORD.test(command) || !CLAUDE_WORD.test(command)) return false;
  return !command.includes('swarm.py') && !command.includes('CC_PARENT_SESSION');
}

/**
 * A small POSIX-shell tokenizer: words with quotes and backslashes removed, and operator tokens
 * for ; && || | & newline and bare ( ). `$( ... )` stays inside its word; `2>&1` stays a word.
 * Good enough to find commands; it is not a shell.
 */
export function shellTokens(text) {
  const tokens = [];
  let word = '';
  let inWord = false;
  let depth = 0;
  const push = () => {
    if (inWord) tokens.push({ word });
    word = '';
    inWord = false;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      if (i + 1 < text.length && text[i + 1] !== '\n') {
        word += text[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (ch === '"') {
      inWord = true;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
          if (text[i + 1] !== '\n') word += text[i + 1];
          i += 2;
          continue;
        }
        word += text[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      word += '$(';
      inWord = true;
      depth += 1;
      i += 2;
      continue;
    }
    if (ch === ')' && depth > 0) {
      word += ')';
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth > 0) {
      word += ch;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      push();
      i += 1;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      push();
      tokens.push({ op: ';' });
      i += 1;
      continue;
    }
    if (ch === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
      word += ch;
      inWord = true;
      i += 1;
      continue;
    }
    if (ch === '&' || ch === '|') {
      push();
      const two = text.slice(i, i + 2);
      if (two === '&&' || two === '||') {
        tokens.push({ op: two });
        i += 2;
      } else {
        tokens.push({ op: ch });
        i += 1;
      }
      continue;
    }
    word += ch;
    inWord = true;
    i += 1;
  }
  push();
  return tokens;
}

/** The simple commands of a token list: arrays of words between operators, empty ones dropped. */
export function segmentsOf(tokens) {
  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token.op !== undefined) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token.word);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** getopt-style flag parsing: `-dP`, `-c dir`, `-cdir`, `--` ends options. */
export function parseFlags(words, argLetters) {
  const values = new Map();
  const flags = new Set();
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (word === '--') {
      i += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    let step = 1;
    for (let j = 1; j < word.length; j += 1) {
      const letter = word[j];
      if (argLetters.includes(letter)) {
        const attached = word.slice(j + 1);
        const value = attached !== '' ? attached : words[i + 1];
        if (attached === '') step = 2;
        if (typeof value === 'string') {
          const list = values.get(letter) ?? [];
          list.push(value);
          values.set(letter, list);
        }
        break;
      }
      flags.add(letter);
    }
    i += step;
  }
  return { values, flags, rest: words.slice(i) };
}

/** An absolute dir for a `-c` / `cd` value, relative to `base`; null when it depends on shell expansion. */
export function resolveDir(value, base, ctx) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;
  if (v === '.' || v === '$PWD' || v === '${PWD}' || v === '$(pwd)' || v === '`pwd`' || v.startsWith('#{')) return base;
  if (v === '~' || v === '$HOME' || v === '${HOME}') return ctx.home;
  if (v.startsWith('~/')) return path.join(ctx.home, v.slice(2));
  if (v.startsWith('$HOME/')) return path.join(ctx.home, v.slice('$HOME/'.length));
  if (v.startsWith('${HOME}/')) return path.join(ctx.home, v.slice('${HOME}/'.length));
  if (/[$`*?]/.test(v)) return null;
  return path.resolve(base, v);
}

function commandWords(words) {
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i]))) i += 1;
  return words.slice(i);
}

function claudeArgs(args, cwd) {
  let name = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-p' || arg === '--print' || arg === '-r' || arg === '--resume' || arg === '-c' || arg === '--continue') return SKIP;
    if (arg.startsWith('--resume=')) return SKIP;
    if ((arg === '-n' || arg === '--name') && i + 1 < args.length) {
      name = cleanName(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--name=')) name = cleanName(arg.slice('--name='.length));
  }
  return { cwd, name };
}

/** {cwd, name} of the first interactive `claude` the shell text starts (following `cd`), SKIP, or null. */
export function claudeLaunchIn(text, cwd, ctx) {
  let dir = cwd;
  for (const words of segmentsOf(shellTokens(text))) {
    const argv = commandWords(words);
    if (argv.length === 0) continue;
    if (argv[0] === 'cd') {
      dir = resolveDir(argv[1] ?? '~', dir, ctx) ?? dir;
      continue;
    }
    if (isClaudeWord(argv[0])) return claudeArgs(argv.slice(1), dir);
    if (SHELLS.has(path.basename(argv[0]))) {
      const opts = parseFlags(argv.slice(1), '');
      if ((opts.flags.has('c')) && opts.rest.length > 0) {
        const inner = claudeLaunchIn(opts.rest[0], dir, ctx);
        if (inner !== null) return inner;
      }
    }
  }
  return null;
}

function launchFromArgv(rest, base, ctx) {
  if (rest.length === 0) return null;
  if (rest.length === 1) return claudeLaunchIn(rest[0], base, ctx);
  if (isClaudeWord(rest[0])) return claudeArgs(rest.slice(1), base);
  return claudeLaunchIn(rest.map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(' '), base, ctx);
}

/**
 * {cwd, name} when `command` launches an interactive Claude Code session in tmux by hand, else
 * null. `ctx` = {cwd: the hook's cwd (absolute), home}. A `-c` that needs shell expansion falls
 * back to the hook's cwd; a wrong guess only means the child's claim misses (no link), never a
 * wrong link.
 */
export function detectSpawn(command, ctx) {
  if (!mayLaunchClaude(command)) return null;
  let dir = ctx.cwd;
  for (const words of segmentsOf(shellTokens(command))) {
    const argv = commandWords(words);
    if (argv.length === 0) continue;
    if (argv[0] === 'cd') {
      dir = resolveDir(argv[1] ?? '~', dir, ctx) ?? dir;
      continue;
    }
    if (path.basename(argv[0]) !== 'tmux') continue;
    const global = parseFlags(argv.slice(1), TMUX_GLOBAL_ARG_LETTERS);
    const sub = global.rest[0];
    let found = null;
    if (LAUNCH_COMMANDS.has(sub)) {
      const opts = parseFlags(global.rest.slice(1), LAUNCH_ARG_LETTERS);
      if ((opts.values.get('e') ?? []).some((value) => value.startsWith('CC_PARENT_SESSION='))) return null;
      const cValues = opts.values.get('c') ?? [];
      const base = cValues.length > 0 ? (resolveDir(cValues[cValues.length - 1], dir, ctx) ?? dir) : dir;
      found = launchFromArgv(opts.rest, base, ctx);
    } else if (SEND_COMMANDS.has(sub)) {
      const opts = parseFlags(global.rest.slice(1), SEND_ARG_LETTERS);
      const typed = opts.rest.filter((key) => !KEY_NAME.test(key)).join(' ');
      found = claudeLaunchIn(typed, dir, ctx);
    }
    if (found === SKIP) return null;
    if (found !== null) return found;
  }
  return null;
}

/** Records a pending spawn for one PreToolUse input. Always resolves to null (no hook output). */
export async function runSpawn({ input, env, fetchImpl = globalThis.fetch, hostname = os.hostname }) {
  if (input === null || typeof input !== 'object' || input.tool_name !== TOOL_NAME) return null;
  const toolInput = input.tool_input;
  const command = toolInput !== null && typeof toolInput === 'object' ? toolInput.command : undefined;
  if (!mayLaunchClaude(command)) return null;
  if (!isCliSession(env)) return null;
  const parent = sessionIdOf(input);
  const cwd = typeof input.cwd === 'string' && path.isAbsolute(input.cwd) ? input.cwd : null;
  if (parent === null || cwd === null) return null;
  const log = (message) => writeLog(stateDir(env), LOG_FILE, message);
  try {
    const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : os.homedir();
    const spawn = detectSpawn(command, { cwd, home });
    if (spawn === null) return null;
    const res = await fetchImpl(`${daemonBaseUrl(env)}${SPAWN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify({ parent, cwd: spawn.cwd, name: spawn.name, host: hostname() }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await log(`spawn from ${parent}: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
  }
  return null;
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    await runSpawn({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
