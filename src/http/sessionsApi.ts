import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { normalizeNodeId } from '../sessions/ids.js';
import {
  contextFor,
  graphForRepo,
  listProjects,
  readSelected,
  readTranscript,
  repoExists,
  searchNodes,
  sessionDetail,
  sessionsReadDeps,
  usage,
  writeSelected,
  type SessionsReadOverrides,
} from '../sessions/readModel.js';
import { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from '../sessions/transcriptSearch.js';
import type { GraphPayload, SelectedProject } from '../sessions/view.js';
import { isLoopbackUrl, sameOriginOnly } from './sameOrigin.js';

export const GRAPH_DEFAULT_LIMIT = 2000;
export const GRAPH_MAX_LIMIT = 5000;
export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;
export const USAGE_DEFAULT_LIMIT = 20;
export const USAGE_MAX_LIMIT = 200;
export const MAX_REPO_CHARS = 200;
export const MAX_QUERY_CHARS = 500;
export const MAX_CONTEXT_IDS_CHARS = 2000;

export type SessionsApiOptions = SessionsReadOverrides;

const repoField = z.string().trim().min(1).max(MAX_REPO_CHARS);

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GRAPH_MAX_LIMIT).default(GRAPH_DEFAULT_LIMIT),
  before: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'before: not a valid datetime')
    .optional(),
});

const selectedBodySchema = z.object({ repo: repoField.nullable() });

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'q is empty').max(MAX_QUERY_CHARS),
  repo: repoField.optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
});

const usageQuerySchema = z.object({
  by: z.enum(['node', 'month']).default('month'),
  repo: repoField.optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM')
    .optional(),
  limit: z.coerce.number().int().min(1).max(USAGE_MAX_LIMIT).default(USAGE_DEFAULT_LIMIT),
});

const transcriptQuerySchema = z.object({
  query: z.string().max(MAX_QUERY_CHARS).optional(),
  limit: z.coerce.number().int().min(1).max(TRANSCRIPT_MAX_LIMIT).default(TRANSCRIPT_DEFAULT_LIMIT),
});

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'request'}: ${issue.message}`)
    .join('; ');
}

/**
 * Loopback-only reads (the prompt hook's context lookup): the request URL must name loopback
 * (DNS-rebinding guard) and a browser Origin, when present, must be loopback too.
 */
export const loopbackReadGuard: MiddlewareHandler = async (c, next) => {
  if (!isLoopbackUrl(c.req.url)) return c.json({ error: 'forbidden_host' }, 403);
  const origin = c.req.header('origin');
  if (origin !== undefined && !isLoopbackUrl(origin)) return c.json({ error: 'forbidden_origin' }, 403);
  await next();
};

/** Weak ETag over everything but generated_at, so an unchanged graph polls as 304. */
export function graphEtag(payload: GraphPayload): string {
  const digest = createHash('sha1')
    .update(JSON.stringify([payload.repo, payload.total, payload.next_before, payload.nodes]))
    .digest('hex');
  return `W/"${digest}"`;
}

/** "A0-3G, b122  zz-zz" -> ['A0-3G', 'b122', 'zz-zz'] (raw, trimmed, deduped, in order). */
export function parseIdList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const t = part.trim();
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The sessions read API (iteration 8, phase 7). The web polls GET /api/projects/:repo/sessions
 * (ETag + If-None-Match) instead of an SSE event: session rows change on every transcript append,
 * and the other laptop's ingest never reaches this daemon's event bus anyway.
 *
 * GET  /api/projects                       repo list, counts, live counts, selected repo
 * GET  /api/projects/selected              { repo }
 * PUT  /api/projects/selected              { repo | null }   same-origin only
 * GET  /api/projects/:repo/sessions        graph payload
 * GET  /api/sessions/context?ids=          prompt-hook context   loopback only
 * GET  /api/sessions/search?q=&repo=&limit=
 * GET  /api/sessions/usage?by=&repo=&month=&limit=
 * GET  /api/sessions/:nodeId/transcript?query=&limit=   owning host only
 * GET  /api/sessions/:nodeId
 */
export function sessionsApiRoutes(deps: AppDeps, options: SessionsApiOptions = {}): Hono {
  const rd = sessionsReadDeps(deps, options);
  const r = new Hono();

  r.get('/api/projects', async (c) => c.json(await listProjects(rd)));

  r.get('/api/projects/selected', async (c) => {
    const body: SelectedProject = { repo: await readSelected(rd) };
    return c.json(body);
  });

  r.put('/api/projects/selected', sameOriginOnly, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = selectedBodySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const repo = parsed.data.repo;
    if (repo !== null && !(await repoExists(rd, repo))) return c.json({ error: 'unknown_repo', repo }, 404);
    await writeSelected(rd, repo);
    const body: SelectedProject = { repo };
    return c.json(body);
  });

  r.get('/api/projects/:repo/sessions', async (c) => {
    const repo = c.req.param('repo');
    const parsed = graphQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const payload = await graphForRepo(rd, repo, { before: parsed.data.before ?? null, limit: parsed.data.limit });
    if (payload.total === 0) return c.json({ error: 'unknown_repo', repo }, 404);
    const etag = graphEtag(payload);
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.json(payload);
  });

  r.get('/api/sessions/context', loopbackReadGuard, async (c) => {
    const raw = c.req.query('ids') ?? '';
    if (raw.length > MAX_CONTEXT_IDS_CHARS) return c.json({ error: 'ids: too long' }, 400);
    return c.json(await contextFor(rd, parseIdList(raw)));
  });

  r.get('/api/sessions/search', async (c) => {
    const parsed = searchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const { q, repo, limit } = parsed.data;
    return c.json(await searchNodes(rd, { query: q, repo: repo ?? null, limit }));
  });

  r.get('/api/sessions/usage', async (c) => {
    const parsed = usageQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const { by, repo, month, limit } = parsed.data;
    return c.json(await usage(rd, { by, repo: repo ?? null, month: month ?? null, limit }));
  });

  r.get('/api/sessions/:nodeId/transcript', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const parsed = transcriptQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: describeIssues(parsed.error) }, 400);
    const out = await readTranscript(rd, nodeId, { query: parsed.data.query ?? null, limit: parsed.data.limit });
    if (out.ok) return c.json(out.payload);
    if (out.error === 'not_on_this_machine') return c.json({ error: out.error, node_id: out.node_id, host: out.host }, 404);
    return c.json({ error: out.error, node_id: out.node_id }, 404);
  });

  r.get('/api/sessions/:nodeId', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const detail = await sessionDetail(rd, nodeId);
    return detail === null ? c.json({ error: 'not_found', node_id: nodeId }, 404) : c.json(detail);
  });

  return r;
}
