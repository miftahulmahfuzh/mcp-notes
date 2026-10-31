/**
 * Shared plumbing for the mcp-notes Claude Code hooks: where the daemon is, where the hooks keep
 * their state (outbox, logs), and safe logging. Node >= 22 built-ins only. Nothing here throws.
 */
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 7317;
export const LOG_MAX_BYTES = 1024 * 1024;

/** `http://127.0.0.1:<NOTESD_PORT or 7317>`. The daemon only ever listens on 127.0.0.1. */
export function daemonBaseUrl(env) {
  const raw = typeof env.NOTESD_PORT === 'string' ? env.NOTESD_PORT.trim() : '';
  const port = /^\d{1,5}$/.test(raw) && Number(raw) > 0 && Number(raw) < 65536 ? Number(raw) : DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/** `${XDG_STATE_HOME:-$HOME/.local/state}/notes-capture` (a relative XDG_STATE_HOME is ignored, per the spec). */
export function stateDir(env) {
  const xdg = typeof env.XDG_STATE_HOME === 'string' ? env.XDG_STATE_HOME : '';
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir();
  const base = xdg !== '' && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'state');
  return path.join(base, 'notes-capture');
}

/** Appends one timestamped line to `<dir>/<file>`, rotating to `<file>.1` past 1 MB. Never throws. */
export async function writeLog(dir, file, message) {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, file);
    try {
      const info = await stat(target);
      if (info.size > LOG_MAX_BYTES) await rename(target, `${target}.1`);
    } catch {
      // No log yet.
    }
    const line = String(message).replace(/\s+/g, ' ').slice(0, 2000);
    await appendFile(target, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // Logging must never break a hook.
  }
}

export function errorText(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** The whole of stdin as UTF-8. */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** True when the module at `moduleUrl` is the script node was started with (symlinks resolved). */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}
