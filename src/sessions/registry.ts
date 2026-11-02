import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Claude Code's live-session registry: one `~/.claude/sessions/<pid>.json` per running (or
 * crashed) session, e.g.
 * `{"pid":173606,"sessionId":"d5c2...","cwd":"/home/miftah/mcp-notes","startedAt":1793585571866,
 *   "procStart":"303782","version":"2.1.311","kind":"interactive","entrypoint":"cli",
 *   "tmux":"note:@0.%7","messagingSocketPath":"/run/user/1000/cc-socks/173606.sock",
 *   "name":"...","nameSource":"derived","status":"busy","updatedAt":1793585600000}`.
 * Files of dead processes stay behind (34 of 39 on 2026-11-02), so an entry counts as live only
 * when its pid is alive AND, where `/proc` exists, that pid's start time equals `procStart`
 * (field 22 of `/proc/<pid>/stat`; a recycled pid fails this). `<pid>.<hash>.key` files are skipped.
 * Read-only; nothing here writes to the database. Phase 7 serves `live` from it.
 */

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string | null;
  /** `busy` | `idle` as Claude Code writes it; null when absent. */
  status: string | null;
  /** `session:@window.%pane`, e.g. `note:@0.%7`; null outside tmux. */
  tmux: string | null;
  name: string | null;
  nameSource: string | null;
  entrypoint: string | null;
  version: string | null;
  startedAt: Date | null;
  updatedAt: Date | null;
  messagingSocketPath: string | null;
}

export type PidAliveCheck = (pid: number, procStart: string | null) => boolean;

export interface RegistryOptions {
  /** The Claude home (`config.sessions.claudeHome`); entries are read from `<claudeHome>/sessions`. */
  claudeHome: string;
  /** Default `isPidAlive`. Tests inject one. */
  isAlive?: PidAliveCheck;
}

const ENTRY_FILE = /^\d+\.json$/;
export const DEFAULT_REGISTRY_TTL_MS = 2_000;

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function msDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value) : null;
}

/** Field 22 (starttime, clock ticks since boot) of `/proc/<pid>/stat`, or null without /proc. */
export function procStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    // Fields after the parenthesised comm start at field 3; field 22 is index 19.
    return stat.slice(close + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/** True when `pid` exists and, where /proc can tell, started at `procStart`. */
export function isPidAlive(pid: number, procStart: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (procStart === null) return true;
  const actual = procStartTime(pid);
  return actual === null || actual === procStart;
}

/** One registry file's JSON to an entry plus its `procStart`; null when it is not a session entry. */
export function parseLiveEntry(raw: unknown): { session: LiveSession; procStart: string | null } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const pid = r.pid;
  const sessionId = str(r.sessionId);
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || sessionId === null) return null;
  return {
    procStart: typeof r.procStart === 'string' ? r.procStart : typeof r.procStart === 'number' ? String(r.procStart) : null,
    session: {
      sessionId,
      pid,
      cwd: str(r.cwd),
      status: str(r.status),
      tmux: str(r.tmux),
      name: str(r.name),
      nameSource: str(r.nameSource),
      entrypoint: str(r.entrypoint),
      version: str(r.version),
      startedAt: msDate(r.startedAt),
      updatedAt: msDate(r.updatedAt),
      messagingSocketPath: str(r.messagingSocketPath),
    },
  };
}

/** Live sessions on this machine by session id. A missing registry dir is an empty map. */
export async function readLiveRegistry(options: RegistryOptions): Promise<Map<string, LiveSession>> {
  const dir = path.join(options.claudeHome, 'sessions');
  const isAlive = options.isAlive ?? isPidAlive;
  const live = new Map<string, LiveSession>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return live;
  }
  for (const name of names) {
    if (!ENTRY_FILE.test(name)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue; // being rewritten, or not JSON
    }
    const entry = parseLiveEntry(raw);
    if (entry === null || !isAlive(entry.session.pid, entry.procStart)) continue;
    const existing = live.get(entry.session.sessionId);
    const newer = (entry.session.updatedAt?.getTime() ?? 0) >= (existing?.updatedAt?.getTime() ?? 0);
    if (existing === undefined || newer) live.set(entry.session.sessionId, entry.session);
  }
  return live;
}

export interface LiveRegistry {
  /** The live map, re-read at most once per `ttlMs`; concurrent callers share one read. */
  get(): Promise<Map<string, LiveSession>>;
  /** Forget the cached map; the next `get` re-reads. */
  invalidate(): void;
}

export function createLiveRegistry(options: RegistryOptions & { ttlMs?: number; now?: () => number }): LiveRegistry {
  const ttlMs = options.ttlMs ?? DEFAULT_REGISTRY_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { at: number; value: Promise<Map<string, LiveSession>> } | null = null;
  return {
    get() {
      const t = now();
      if (cached !== null && t - cached.at < ttlMs) return cached.value;
      const value = readLiveRegistry(options);
      cached = { at: t, value };
      value.catch(() => {
        if (cached?.value === value) cached = null;
      });
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}

/** Live sessions on this machine as a list. The summary worker's "is it still running" check (phase 6). */
export async function readLiveSessions(claudeHome: string, isAlive?: PidAliveCheck): Promise<LiveSession[]> {
  return [...(await readLiveRegistry({ claudeHome, ...(isAlive !== undefined ? { isAlive } : {}) })).values()];
}
