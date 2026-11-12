import { createHash } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppDeps } from '../deps.js';
import { normalizeNodeId } from '../sessions/ids.js';
import {
  contextFor,
  graphForRepo,
  knownNodes,
  listProjects,
  readSelected,
  readSessionContext,
  readTranscript,
  repoExists,
  requestSummaryFor,
  searchNodes,
  sessionDetail,
  sessionPrompts,
  sessionsReadDeps,
  usage,
  writeSelected,
  type SessionsReadOverrides,
} from '../sessions/readModel.js';
import { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from '../sessions/transcriptSearch.js';
import { createUnfinishedChecker, type UnfinishedChecker } from '../sessions/unfinished.js';
import type { GraphPayload, SelectedProject, SessionContext, SessionContextPayload } from '../sessions/view.js';
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
export const MAX_KNOWN_IDS_CHARS = 1000;
/** A burst of ingest writes (one per watcher read) becomes one re-read per stream. */
export const CONTEXT_STREAM_DEBOUNCE_MS = 250;
/** Same cadence as /api/events (SSE_HEARTBEAT_MS in api.ts), kept here so this module does not load api.ts. */
export const CONTEXT_STREAM_HEARTBEAT_MS = 25_000;

export interface SessionsApiOptions extends SessionsReadOverrides {
  /** The orch "unfinished" check (phase 13). Omitted: built from config.sessions.swarmScript. */
  unfinished?: UnfinishedChecker;
  /** Context stream debounce. Defaults to CONTEXT_STREAM_DEBOUNCE_MS. Tests pass a small value. */
  contextDebounceMs?: number;
  /** Context stream heartbeat. Defaults to CONTEXT_STREAM_HEARTBEAT_MS. Tests pass a small value. */
  sseHeartbeatMs?: number;
}

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

/** What makes a context event worth sending: tokens, model or window moved (percent and band follow). */
function contextKey(context: SessionContext | null): string {
  return context === null ? 'null' : `${context.tokens}|${context.model ?? ''}|${context.window}`;
}

/**
 * The sessions read API (iteration 8, phase 7). The web polls GET /api/projects/:repo/sessions
 * (ETag + If-None-Match) for the graph: session rows change on every transcript append, and the
 * other laptop's ingest never reaches this daemon. The one session SSE is the per-node context
 * stream: this host's ingest emits on SessionEvents (src/sessions/events.ts) after a write that
 * can move a session's context, and each open stream re-reads that node's row (debounced) and
 * sends a `context` event when tokens, model or window changed. Another host's node gets its
 * first event and heartbeats only, so the web polls GET /api/sessions/:nodeId/context for those.
 *
 * GET  /api/projects                       repo list, counts, live counts, selected repo
 * GET  /api/projects/selected              { repo }
 * PUT  /api/projects/selected              { repo | null }   same-origin only
 * GET  /api/projects/:repo/sessions        graph payload
 * GET  /api/sessions/context?ids=          prompt-hook context   loopback only
 * GET  /api/sessions/known?ids=            which ids exist, with their repo (chat node links)
 * GET  /api/sessions/search?q=&repo=&limit=    hits carry via_notes and via_replies
 * GET  /api/sessions/usage?by=&repo=&month=&limit=
 * GET  /api/sessions/:nodeId/transcript?query=&limit=   owning host only
 * GET  /api/sessions/:nodeId/prompts      every stored prompt (full when backfilled), from the DB, any host
 * GET  /api/sessions/:nodeId/context      { node_id, host, available, context | null }, any host
 * GET  /api/sessions/:nodeId/context/stream   SSE: `context` on connect, then one per change; heartbeat
 * POST /api/sessions/:nodeId/summarize     records a summary request   same-origin only
 * GET  /api/sessions/:nodeId               detail; session.context is the same object as above
 */
export function sessionsApiRoutes(deps: AppDeps, options: SessionsApiOptions = {}): Hono {
  const rd = sessionsReadDeps(deps, options);
  const unfinished =
    options.unfinished ?? createUnfinishedChecker({ swarmScript: deps.config.sessions?.swarmScript ?? null, host: rd.host });
  const r = new Hono();
  const debounceMs = options.contextDebounceMs ?? CONTEXT_STREAM_DEBOUNCE_MS;
  const heartbeatMs = options.sseHeartbeatMs ?? CONTEXT_STREAM_HEARTBEAT_MS;

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
    await unfinished.annotate(payload.nodes);
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

  r.get('/api/sessions/known', async (c) => {
    const raw = c.req.query('ids') ?? '';
    if (raw.length > MAX_KNOWN_IDS_CHARS) return c.json({ error: 'ids: too long' }, 400);
    return c.json({ nodes: await knownNodes(rd, parseIdList(raw)) });
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

  // Records the request only; the owning host's summary worker serves it (never Haiku here).
  r.post('/api/sessions/:nodeId/summarize', sameOriginOnly, async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const out = await requestSummaryFor(rd, nodeId);
    if (out.ok) return c.json(out.payload);
    if (out.error === 'empty_session') return c.json({ error: out.error, node_id: out.node_id }, 409);
    return c.json({ error: out.error, node_id: out.node_id }, 404);
  });

  r.get('/api/sessions/:nodeId/prompts', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const payload = await sessionPrompts(rd, nodeId);
    if (payload === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    return c.json(payload);
  });

  r.get('/api/sessions/:nodeId/context', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const read = await readSessionContext(rd, nodeId);
    if (read === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    return c.json(read.payload);
  });

  // One `context` event on connect, then one per change of tokens / model / window. Changes come
  // from this host's ingest through deps.sessionEvents; without a bus (sessions off, tests) the
  // stream sends its first event and heartbeats only.
  r.get('/api/sessions/:nodeId/context/stream', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const first = await readSessionContext(rd, nodeId);
    if (first === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    const bus = deps.sessionEvents ?? null;
    return streamSSE(c, async (stream) => {
      let closed = false;
      let lastKey = contextKey(first.payload.context);
      let timer: ReturnType<typeof setTimeout> | null = null;
      let reading = false;
      let pending = false;
      const send = (payload: SessionContextPayload): Promise<void> =>
        stream.writeSSE({ event: 'context', data: JSON.stringify(payload) }).catch(() => undefined);
      const schedule = (): void => {
        if (closed || timer !== null) return;
        timer = setTimeout(() => void refresh(), debounceMs);
      };
      const refresh = async (): Promise<void> => {
        timer = null;
        if (closed) return;
        if (reading) {
          pending = true;
          return;
        }
        reading = true;
        try {
          const next = await readSessionContext(rd, nodeId);
          if (!closed && next !== null) {
            const key = contextKey(next.payload.context);
            if (key !== lastKey) {
              lastKey = key;
              await send(next.payload);
            }
          }
        } catch {
          // A failed read sends nothing; the next change re-reads.
        } finally {
          reading = false;
          if (pending) {
            pending = false;
            schedule();
          }
        }
      };
      const unsubscribe =
        bus === null
          ? (): void => undefined
          : bus.on((event) => {
              if (event.sessionId === first.sessionId) schedule();
            });
      await new Promise<void>((resolve) => {
        const beat = setInterval(() => {
          if (!closed) void stream.write(': heartbeat\n\n').catch(() => undefined);
        }, heartbeatMs);
        stream.onAbort(() => {
          closed = true;
          clearInterval(beat);
          if (timer !== null) clearTimeout(timer);
          unsubscribe();
          resolve();
        });
        void send(first.payload);
        // A write committed between the read above and the subscription is caught by this re-read.
        schedule();
      });
    });
  });

  r.get('/api/sessions/:nodeId', async (c) => {
    const nodeId = normalizeNodeId(c.req.param('nodeId'));
    if (nodeId === null) return c.json({ error: 'invalid_node_id' }, 400);
    const detail = await sessionDetail(rd, nodeId);
    if (detail === null) return c.json({ error: 'not_found', node_id: nodeId }, 404);
    await unfinished.annotate([detail.session]);
    return c.json(detail);
  });

  return r;
}
