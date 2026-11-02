#!/usr/bin/env node
/**
 * notes-session: Claude Code SessionStart hook for mcp-notes (the session graph).
 *
 * Tells notesd that a Claude Code session started, resumed, cleared or compacted on this machine,
 * so the graph learns the session's exact parent and its tmux pane before the transcript ingester
 * has read a byte, and tells the session its own node id and its parent's:
 *
 * 1. A non-`cli` session (CLAUDE_CODE_ENTRYPOINT sdk-ts / sdk-cli: the wall chat agent, `claude -p`
 *    helper runs) returns at once: no I/O, no output.
 * 2. It gathers {session, parent, cwd, name, tmux, host, started_at, source, transcript_path}.
 *    parent is CC_PARENT_SESSION (swarm.py spawn_argv sets it on the tmux child). name and tmux come
 *    from Claude Code's live registry (<claude home>/sessions/<CLAUDE_PID>.json) when it already
 *    lists this session, else name from the claude process's `-n/--name` argv and tmux from
 *    `tmux display-message` on TMUX_PANE.
 * 3. It POSTs that to /api/sessions/hook/start (loopback, X-Notes-Capture: 1) within
 *    POST_TIMEOUT_MS. The daemon links the parent ('env'), or claims a pending spawn recorded by the
 *    notes-spawn hook ('hook'); only a fresh start does that, never resume or compact.
 * 4. It prints {hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}} naming the node
 *    id and the parent's node id. Daemon down, an error, or no node id in the reply: no output.
 *
 * Always exits 0; stdout carries only the hook JSON (or nothing). Problems go to
 * ${XDG_STATE_HOME:-~/.local/state}/notes-capture/session.log. Node >= 22 built-ins only.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { daemonBaseUrl, errorText, isMainModule, readStdin, stateDir, writeLog } from './lib/state.mjs';

export const HOOK_EVENT = 'SessionStart';
export const START_PATH = '/api/sessions/hook/start';
export const POST_TIMEOUT_MS = 3000;
export const TMUX_TIMEOUT_MS = 1000;
export const LOG_FILE = 'session.log';
export const PARENT_ENV = 'CC_PARENT_SESSION';
/** Sources that begin a new session id: the only ones that send started_at. */
export const FRESH_SOURCES = ['startup', 'clear'];
/** Same shape as the registry's `tmux` field: `iter1:@127.%255`. */
export const TMUX_TARGET_FORMAT = '#{session_name}:#{window_id}.#{pane_id}';

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,99}$/;
const NODE_ID = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/;
const PID = /^[1-9]\d{0,9}$/;
const PANE = /^%\d{1,9}$/;
const MAX_NAME = 200;
const MAX_TMUX = 200;

/** True for a terminal session: CLAUDE_CODE_ENTRYPOINT unset or `cli`. */
export function isCliSession(env) {
  const entry = typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' ? env.CLAUDE_CODE_ENTRYPOINT.trim() : '';
  return entry === '' || entry === 'cli';
}

/** The hook input's session_id when it looks like a Claude Code session id, else null. */
export function sessionIdOf(input) {
  if (input === null || typeof input !== 'object') return null;
  const id = typeof input.session_id === 'string' ? input.session_id.trim() : '';
  return SESSION_ID.test(id) ? id : null;
}

/** CC_PARENT_SESSION when it is a session id other than this session's own, else null. */
export function parentFrom(env, sessionId) {
  const raw = typeof env[PARENT_ENV] === 'string' ? env[PARENT_ENV].trim() : '';
  if (!SESSION_ID.test(raw) || raw === sessionId) return null;
  return raw;
}

/** CLAUDE_CONFIG_DIR when absolute, else $HOME/.claude. */
export function claudeHome(env) {
  const configured = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (configured !== '' && path.isAbsolute(configured)) return configured;
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : os.homedir();
  return path.join(home, '.claude');
}

/** The pids that may be the claude process: CLAUDE_PID first, then this hook's parent. Distinct. */
export function candidatePids(env, ppid) {
  const out = [];
  const raws = [env.CLAUDE_PID, ppid === undefined || ppid === null ? '' : String(ppid)];
  for (const raw of raws) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (PID.test(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Whitespace collapsed, at most MAX_NAME chars; null when empty or not a string. */
export function cleanName(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return text === '' ? null : text;
}

function cleanTmux(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > MAX_TMUX || /\s/.test(text)) return null;
  return text;
}

/** True for a word that runs Claude Code: `claude`, `/x/bin/claude`, `claude.exe`, `.../claude-code/cli.js`. */
export function isClaudeWord(word) {
  if (typeof word !== 'string' || word === '') return false;
  const base = path.basename(word);
  return base === 'claude' || base === 'claude.exe' || /claude-code\/cli\.m?js$/.test(word);
}

/** The `-n X` / `--name X` / `--name=X` value of a claude argv; null when argv is not claude's or has none. */
export function nameFromArgv(argv) {
  if (!Array.isArray(argv) || !argv.some(isClaudeWord)) return null;
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i];
    if (typeof word !== 'string') continue;
    if ((word === '-n' || word === '--name') && typeof argv[i + 1] === 'string') return cleanName(argv[i + 1]);
    if (word.startsWith('--name=')) return cleanName(word.slice('--name='.length));
  }
  return null;
}

/** {pid, name, tmux} from <home>/sessions/<pid>.json for the first pid whose entry names this session. */
export async function registryEntry(home, pids, sessionId, readText) {
  for (const pid of pids) {
    let parsed;
    try {
      parsed = JSON.parse(await readText(path.join(home, 'sessions', `${pid}.json`)));
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.sessionId === sessionId) {
      return { pid, name: cleanName(parsed.name), tmux: cleanTmux(parsed.tmux) };
    }
  }
  return null;
}

/** The `-n/--name` of the first candidate pid that is a claude process, from /proc/<pid>/cmdline. */
export async function nameFromProcesses(pids, readText) {
  for (const pid of pids) {
    let text;
    try {
      text = await readText(`/proc/${pid}/cmdline`);
    } catch {
      continue;
    }
    const name = nameFromArgv(text.split('\0').filter((word) => word !== ''));
    if (name !== null) return name;
  }
  return null;
}

/** `session:@window.%pane` for TMUX_PANE; the bare pane id when tmux cannot say; null outside tmux. */
export async function tmuxTarget(env, runTmux) {
  const pane = typeof env.TMUX_PANE === 'string' ? env.TMUX_PANE.trim() : '';
  if (typeof env.TMUX !== 'string' || env.TMUX === '' || !PANE.test(pane)) return null;
  try {
    const target = cleanTmux(await runTmux(['display-message', '-p', '-t', pane, TMUX_TARGET_FORMAT]));
    if (target !== null) return target;
  } catch {
    // tmux gone or slow: the pane id is still worth having.
  }
  return pane;
}

function defaultRunTmux(args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: TMUX_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function linkPhrase(source) {
  if (source === 'env') return ' (exact link: it was launched by swarm.py)';
  if (source === 'hook') return ' (linked from the tmux launch it ran)';
  if (source === 'heuristic') return ' (inferred from its transcript)';
  return '';
}

/** The additionalContext for a reply carrying this session's node id. */
export function buildContext(reply) {
  const node = reply.node_id;
  const lines = [
    `This Claude Code session is node ${node} in the user's session graph (the Projects page of the mcp-notes wall). ` +
      `Quote ${node} when the user or another session needs to refer to this session.`,
  ];
  const parentNode = typeof reply.parent_node_id === 'string' && NODE_ID.test(reply.parent_node_id) ? reply.parent_node_id : null;
  const parentSession = typeof reply.parent_session_id === 'string' && reply.parent_session_id !== '' ? reply.parent_session_id : null;
  const source = typeof reply.parent_link_source === 'string' ? reply.parent_link_source : null;
  if (parentNode !== null) {
    lines.push(`It was spawned by node ${parentNode}${linkPhrase(source)}.`);
  } else if (parentSession !== null) {
    lines.push(`It was spawned by Claude Code session ${parentSession}${linkPhrase(source)}, which has no node id yet.`);
  } else {
    lines.push('No parent session is recorded for it.');
  }
  return lines.join(' ');
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The hook output for one SessionStart input, or null to add nothing. Never throws. */
export async function runSession({
  input,
  env,
  fetchImpl = globalThis.fetch,
  readText = (file) => readFile(file, 'utf8'),
  runTmux = defaultRunTmux,
  now = Date.now,
  ppid = process.ppid,
  hostname = os.hostname,
}) {
  if (!isCliSession(env)) return null;
  const sessionId = sessionIdOf(input);
  if (sessionId === null) return null;
  const log = (message) => writeLog(stateDir(env), LOG_FILE, message);
  try {
    const rawSource = typeof input.source === 'string' ? input.source.trim().slice(0, 32) : '';
    const source = rawSource === '' ? 'startup' : rawSource;
    const pids = candidatePids(env, ppid);
    const entry = await registryEntry(claudeHome(env), pids, sessionId, readText);
    const name = entry !== null && entry.name !== null ? entry.name : await nameFromProcesses(pids, readText);
    const tmux = entry !== null && entry.tmux !== null ? entry.tmux : await tmuxTarget(env, runTmux);
    const payload = {
      session: sessionId,
      parent: parentFrom(env, sessionId),
      cwd: textOrNull(input.cwd),
      name,
      tmux,
      host: hostname(),
      started_at: FRESH_SOURCES.includes(source) ? new Date(now()).toISOString() : null,
      source,
      transcript_path: textOrNull(input.transcript_path),
    };
    const res = await fetchImpl(`${daemonBaseUrl(env)}${START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await log(`start ${sessionId}: HTTP ${res.status} ${detail.slice(0, 200)}`);
      return null;
    }
    const reply = await res.json();
    if (reply === null || typeof reply !== 'object' || typeof reply.node_id !== 'string' || !NODE_ID.test(reply.node_id)) {
      await log(`start ${sessionId}: reply without a node id`);
      return null;
    }
    return { hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: buildContext(reply) } };
  } catch (err) {
    await log(`hook: ${errorText(err)}`);
    return null;
  }
}

async function main() {
  let output = null;
  try {
    const input = JSON.parse(await readStdin());
    output = await runSession({ input, env: process.env });
  } catch (err) {
    await writeLog(stateDir(process.env), LOG_FILE, `hook: ${errorText(err)}`);
  }
  if (output !== null) process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

if (isMainModule(import.meta.url)) void main();
