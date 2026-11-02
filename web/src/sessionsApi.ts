import { ApiError } from './api';
import type { ProjectSummary, SessionGraphPayload, SessionNode } from './types';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Upper bound asked of the graph endpoint. The SVG graph is virtualized for ~1000 nodes. */
export const GRAPH_LIMIT = 2000;

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') msg = (j as { error: string }).error;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Defensive copy of a phase 7 `GraphNode`: the layout never sees `undefined`. */
export function normalizeSessionNode(n: SessionNode): SessionNode {
  const src = n.parent_link_source;
  const t: Partial<SessionNode['tokens']> = n.tokens ?? {};
  return {
    session_id: n.session_id,
    node_id: n.node_id,
    repo: str(n.repo),
    parent_session_id: str(n.parent_session_id),
    parent_node_id: str(n.parent_node_id),
    parent_link_source: src === 'env' || src === 'hook' || src === 'heuristic' ? src : null,
    title: typeof n.title === 'string' && n.title !== '' ? n.title : n.node_id,
    name: str(n.name),
    custom_title: str(n.custom_title),
    ai_title: str(n.ai_title),
    first_prompt: str(n.first_prompt),
    branch: str(n.branch),
    cwd: str(n.cwd),
    started_at: str(n.started_at),
    last_active_at: str(n.last_active_at),
    host: typeof n.host === 'string' ? n.host : '',
    available: n.available !== false,
    live: n.live === true,
    status: str(n.status),
    tmux: str(n.tmux),
    tokens: { input: num(t.input), output: num(t.output), cache_read: num(t.cache_read), cache_write: num(t.cache_write), total: num(t.total) },
    cost_usd: typeof n.cost_usd === 'number' ? n.cost_usd : null,
    summary_excerpt: str(n.summary_excerpt),
    child_count: num(n.child_count),
    unfinished: typeof n.unfinished === 'boolean' ? n.unfinished : null,
  };
}

/** One graph poll: `payload` null means 304 (unchanged since `etag`). */
export interface SessionGraphFetch {
  payload: SessionGraphPayload | null;
  etag: string | null;
}

/** `GET /api/projects` → every repo with sessions. */
export async function fetchProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const res = await fetch('/api/projects', { signal });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { projects?: unknown };
  return Array.isArray(j.projects) ? (j.projects as ProjectSummary[]) : [];
}

/** `GET /api/projects/selected` → the repo both laptops last picked, or null. */
export async function fetchSelectedProject(signal?: AbortSignal): Promise<string | null> {
  const res = await fetch('/api/projects/selected', { signal });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { repo?: unknown };
  return str(j.repo);
}

/** `PUT /api/projects/selected` `{ repo }` → the stored value. */
export async function saveSelectedProject(repo: string | null): Promise<string | null> {
  const res = await fetch('/api/projects/selected', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ repo }) });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { repo?: unknown };
  return str(j.repo);
}

/**
 * `GET /api/projects/:repo/sessions?limit=` → the repo's graph. Sends `If-None-Match: etag` when
 * given; a 304 answers `{ payload: null, etag }` so the caller keeps what it has (phase 7 decided
 * on ETag polling instead of an SSE event).
 */
export async function fetchSessionGraph(
  repo: string,
  opts: { signal?: AbortSignal; etag?: string | null } = {},
): Promise<SessionGraphFetch> {
  const headers: Record<string, string> = opts.etag ? { 'if-none-match': opts.etag } : {};
  const res = await fetch(`/api/projects/${enc(repo)}/sessions?limit=${GRAPH_LIMIT}`, { signal: opts.signal, headers });
  if (res.status === 304) return { payload: null, etag: opts.etag ?? null };
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as Partial<SessionGraphPayload> & { nodes?: unknown };
  const nodes = Array.isArray(j.nodes) ? (j.nodes as SessionNode[]).map(normalizeSessionNode) : [];
  return {
    payload: {
      repo: typeof j.repo === 'string' ? j.repo : repo,
      host: typeof j.host === 'string' ? j.host : '',
      generated_at: typeof j.generated_at === 'string' ? j.generated_at : '',
      total: typeof j.total === 'number' ? j.total : nodes.length,
      truncated: j.truncated === true,
      next_before: str(j.next_before),
      nodes,
    },
    etag: res.headers.get('etag'),
  };
}
