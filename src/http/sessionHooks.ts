import os from 'node:os';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { SessionsRepo } from '../sessions/repo.js';
import { PENDING_SPAWN_WINDOW_MS } from '../sessions/types.js';
import { captureGuard } from './capture.js';

/** Phase 1's constant (brief: "within ~30s"), re-exported for the tests; never redefined here. */
export { PENDING_SPAWN_WINDOW_MS };
export const SESSION_HOOK_START_PATH = '/api/sessions/hook/start';
export const SESSION_HOOK_SPAWN_PATH = '/api/sessions/hook/spawn';
export const MAX_SESSION_HOOK_BODY_BYTES = 64 * 1024;
/** Pending spawns older than this are deleted when a new one is recorded (claimed or not). */
export const PENDING_SPAWN_RETAIN_MS = 24 * 60 * 60 * 1000;
/** Sources that begin a new session id and may set its parent. */
export const FRESH_START_SOURCES: ReadonlySet<string> = new Set(['startup', 'clear']);
/** Sources that may claim a pending spawn: only the first start of a process. */
export const CLAIMING_SOURCES: ReadonlySet<string> = new Set(['startup']);

const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,99}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const sessionIdField = z.string().trim().regex(SESSION_ID, 'expected a Claude Code session id');

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value));
}

const startSchema = z.object({
  session: sessionIdField,
  parent: sessionIdField
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  cwd: optionalText(4096),
  name: optionalText(200),
  tmux: optionalText(200),
  host: optionalText(255),
  started_at: z
    .string()
    .regex(ISO_INSTANT, 'expected an ISO 8601 UTC or offset datetime')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'not a valid datetime')
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  source: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((value) => (value === undefined || value === '' ? 'startup' : value)),
  transcript_path: optionalText(4096),
});

const spawnSchema = z.object({
  parent: sessionIdField,
  cwd: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith('/'), 'cwd must be an absolute path'),
  name: optionalText(200),
  host: optionalText(255),
});

export interface SessionHookOptions {
  /** Host recorded when the hook sends none. Defaults to os.hostname(). */
  hostname?: () => string;
  /** Pending-spawn claim window. Defaults to PENDING_SPAWN_WINDOW_MS. */
  windowMs?: number;
  /** Clock for the prune cutoff. Defaults to Date.now. */
  now?: () => number;
}

export interface SessionHookStartReply {
  session_id: string;
  node_id: string;
  parent_session_id: string | null;
  parent_node_id: string | null;
  parent_link_source: string | null;
  /** True when this call linked the parent by claiming a pending spawn. */
  claimed: boolean;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

/**
 * The Claude Code session hooks (loopback + X-Notes-Capture only, like the capture route):
 *
 * POST /api/sessions/hook/start — notes-session (SessionStart). Upserts the session row (node id
 * assigned on first sight), then on a fresh start (`startup`, `clear`) links `parent` as 'env', or
 * (`startup` only, tmux and cwd known, no env/hook parent yet) claims a pending spawn as 'hook'.
 * `resume` / `compact` only refresh the row. 200 SessionHookStartReply.
 *
 * POST /api/sessions/hook/spawn — notes-spawn (Bash PreToolUse). Records a pending spawn
 * {parent, cwd, name, host}, then prunes spawns older than PENDING_SPAWN_RETAIN_MS (the only
 * scheduler cc_pending_spawns has: a cheap indexed delete on the write path). 201 {recorded: true}.
 *
 * 400 bad JSON / validation, 403 guard, 413 too large, 415 not JSON.
 */
export function sessionHookRoutes(deps: AppDeps, options: SessionHookOptions = {}): Hono {
  const r = new Hono();
  const repo = new SessionsRepo(deps.db);
  const hostname = options.hostname ?? os.hostname;
  const windowMs = options.windowMs ?? PENDING_SPAWN_WINDOW_MS;
  const now = options.now ?? Date.now;
  const limit = bodyLimit({
    maxSize: MAX_SESSION_HOOK_BODY_BYTES,
    onError: (c) => c.json({ error: 'too_large', max_bytes: MAX_SESSION_HOOK_BODY_BYTES }, 413),
  });

  r.post(SESSION_HOOK_START_PATH, captureGuard, limit, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = startSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const body = parsed.data;
    const host = body.host ?? hostname();

    const fresh = FRESH_START_SOURCES.has(body.source);
    const envParent = fresh && body.parent !== null && body.parent !== body.session ? body.parent : null;
    // Phase 1: ensures the child row (node id on first sight) and, with a parent, the parent's row
    // too, links it as 'env' (env > hook > heuristic), and never clobbers a non-null column with null.
    // transcript_path is not sent: ingest (phase 3) records it on its first read of the file.
    const started = await repo.upsertFromHook({
      sessionId: body.session,
      host,
      cwd: body.cwd,
      name: body.name,
      tmux: body.tmux,
      startedAt: body.started_at === null ? null : new Date(body.started_at),
      parentSessionId: envParent,
      parentSource: 'env',
    });

    let claimed = false;
    if (fresh && envParent === null && CLAIMING_SOURCES.has(body.source) && body.tmux !== null && body.cwd !== null) {
      const source = started.session.parentLinkSource;
      if (source !== 'env' && source !== 'hook') {
        // Phase 1: atomic (for update skip locked), at most once, and sets the parent as 'hook'
        // in the same transaction.
        const claim = await repo.claimPendingSpawn({
          childSessionId: body.session,
          host,
          cwd: body.cwd,
          name: body.name,
          windowMs,
        });
        claimed = claim !== null && claim.parentLink === 'set';
      }
    }

    const row = claimed ? await repo.getBySessionId(body.session) : started.session;
    if (row === null) return c.json({ error: 'not_stored' }, 500);
    const parentRow =
      row.parentSessionId === null
        ? null
        : started.parent !== null && started.parent.sessionId === row.parentSessionId
          ? started.parent
          : await repo.getBySessionId(row.parentSessionId);
    const reply: SessionHookStartReply = {
      session_id: row.sessionId,
      node_id: row.nodeId,
      parent_session_id: row.parentSessionId,
      parent_node_id: parentRow?.nodeId ?? null,
      parent_link_source: row.parentLinkSource ?? null,
      claimed,
    };
    return c.json(reply, 200);
  });

  r.post(SESSION_HOOK_SPAWN_PATH, captureGuard, limit, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = spawnSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const body = parsed.data;
    await repo.recordPendingSpawn({
      parentSessionId: body.parent,
      cwd: body.cwd,
      name: body.name,
      host: body.host ?? hostname(),
    });
    await repo.prunePendingSpawns(new Date(now() - PENDING_SPAWN_RETAIN_MS));
    return c.json({ recorded: true }, 201);
  });

  return r;
}
