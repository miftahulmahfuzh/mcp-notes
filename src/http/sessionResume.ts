import os from 'node:os';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { normalizeNodeId } from '../sessions/ids.js';
import { readLiveSessions } from '../sessions/registry.js';
import { SessionsRepo } from '../sessions/repo.js';
import {
  createSessionResumer,
  defaultResumeDeps,
  RESUME_PROMPT_MAX_CHARS,
  toResumeNode,
  type ResumeNode,
  type SessionResumer,
} from '../sessions/resume.js';
import { describeIssues } from './api.js';
import { sameOriginOnly } from './sameOrigin.js';

/** `{prompt?, fresh?}`; unknown keys are refused so a typo never silently resumes instead of spawning. */
export const resumeBodySchema = z.strictObject({
  prompt: z.string().max(RESUME_PROMPT_MAX_CHARS).optional(),
  fresh: z.boolean().optional(),
});

export interface SessionResumeRoutesOptions {
  /** Defaults to defaultSessionResumer(deps). createApp passes the one it shares with the MCP tool. */
  resumer?: SessionResumer;
}

/** Node id -> ResumeNode through Phase 1's repo (getByNodeId is case/dash tolerant). */
export function sessionLookup(repo: Pick<SessionsRepo, 'getByNodeId'>): (nodeId: string) => Promise<ResumeNode | null> {
  return async (nodeId) => {
    const row = await repo.getByNodeId(nodeId);
    return row === null ? null : toResumeNode(row);
  };
}

/** The daemon's resumer: cc_sessions via SessionsRepo, live status via the registry, real tmux. */
export function defaultSessionResumer(deps: AppDeps): SessionResumer {
  let sessions: SessionsRepo | undefined;
  const repo = (): SessionsRepo => {
    sessions ??= new SessionsRepo(deps.db);
    return sessions;
  };
  const host = os.hostname();
  return createSessionResumer({
    normalize: normalizeNodeId,
    lookup: (nodeId) => sessionLookup(repo())(nodeId),
    deps: () =>
      defaultResumeDeps({
        claudeBin: deps.config.chat.claudeBin,
        worktreesDir: deps.config.sessions.worktreesDir,
        live: async (sessionId) => {
          const entry = (await readLiveSessions(deps.config.sessions.claudeHome)).find((s) => s.sessionId === sessionId);
          return entry === undefined ? null : { pid: entry.pid, tmux: entry.tmux ?? null };
        },
        repoCwds: async (name) =>
          (await repo().listForRepo(name, { limit: 200 }))
            .filter((item) => item.host === host && item.cwd !== null)
            .map((item) => item.cwd as string),
      }),
  });
}

/** An empty body is `{}`; anything else must be JSON. */
async function readBody(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const text = await c.req.text();
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * POST /api/sessions/:nodeId/resume {prompt?, fresh?} (own Origin only)
 * -> 200 {action: focused|messaged|resumed|spawned, window?, cwd?, original_cwd?}
 * | 404 not_found | 404 not_on_this_machine {host} | 409 no_tmux | 409 live_outside_tmux {pid}
 * | 500 spawn_failed {message} | 400 invalid_json | 400 invalid_body {message} | 403 forbidden_origin.
 */
export function sessionResumeRoutes(deps: AppDeps, opts: SessionResumeRoutesOptions = {}): Hono {
  let resumer = opts.resumer;
  const getResumer = (): SessionResumer => {
    resumer ??= defaultSessionResumer(deps);
    return resumer;
  };
  const r = new Hono();

  r.post('/api/sessions/:nodeId/resume', sameOriginOnly, async (c) => {
    const body = await readBody(c);
    if (!body.ok) return c.json({ error: 'invalid_json' }, 400);
    const parsed = resumeBodySchema.safeParse(body.value);
    if (!parsed.success) return c.json({ error: 'invalid_body', message: describeIssues(parsed.error) }, 400);
    const out = await getResumer().resume(c.req.param('nodeId'), parsed.data);
    return c.json(out.body, out.status);
  });

  return r;
}
