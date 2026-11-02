import { ApiError } from './api';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

export type ParentLinkSource = 'env' | 'hook' | 'heuristic';

export interface SessionCommit {
  sha: string;
  subject: string;
}

/** A note this session saved (its `origin.claude_session` is this session). */
export interface SessionNoteRef {
  id: string;
  /** First non-empty line of the body, clipped; '' when the server sent only the id. */
  preview: string;
}

export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** Phase 7's `GET /api/sessions/:nodeId`, normalised. */
export interface SessionDetail {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  /** False: the transcript lives on another machine (resume there, not here). */
  available: boolean;
  live: boolean;
  /** Phase 13: orch node with pending ledger phases and no live session; null = unknown / not orch. */
  unfinished: boolean | null;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  /** `custom_title`, else `ai_title`. */
  title: string | null;
  started_at: string | null;
  last_active_at: string | null;
  summary: string | null;
  prompts: string[];
  commits: SessionCommit[];
  notes: SessionNoteRef[];
  tokens: SessionTokens;
  cost_usd: number | null;
  parent: { node_id: string; name: string | null } | null;
  parent_link_source: ParentLinkSource | null;
  transcript_path: string | null;
}

export interface ResumeOptions {
  /** Start a new session seeded with this node's context instead of `claude --resume`. */
  fresh?: boolean;
  prompt?: string;
}

/** Phase 9's answer: what the daemon did (`resumed`, `spawned`, `focused`, `messaged`) and the tmux window. */
export interface ResumeResult {
  action: string;
  window: string | null;
}

type Wire = Record<string, unknown>;

const PREVIEW_MAX = 120;

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

function isObj(v: unknown): v is Wire {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const num = (v: unknown): number => numOrNull(v) ?? 0;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function compact<T>(xs: Array<T | null>): T[] {
  return xs.filter((x): x is T => x !== null);
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX - 1)}…` : line;
}

function prompt(v: unknown): string | null {
  if (typeof v === 'string') return str(v);
  if (isObj(v)) return str(v.text) ?? str(v.prompt);
  return null;
}

function commit(v: unknown): SessionCommit | null {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const sp = t.indexOf(' ');
    return sp < 0 ? { sha: t, subject: '' } : { sha: t.slice(0, sp), subject: t.slice(sp + 1).trim() };
  }
  if (isObj(v)) {
    const sha = str(v.sha) ?? str(v.hash);
    if (sha === null) return null;
    return { sha, subject: str(v.subject) ?? str(v.message) ?? '' };
  }
  return null;
}

function noteRef(v: unknown): SessionNoteRef | null {
  if (typeof v === 'string') return str(v) === null ? null : { id: v.trim(), preview: '' };
  if (isObj(v)) {
    const id = str(v.id);
    if (id === null) return null;
    return { id, preview: firstLine(str(v.excerpt) ?? str(v.preview) ?? str(v.body) ?? '') };
  }
  return null;
}

/**
 * Phase 7's `SessionDetail` wire into `SessionDetail`. Phase 7 sends
 * `{session: GraphNode & {summary, transcript_path, ...}, prompts, commits, files_edited, plan_docs, notes, parent, children}`:
 * the session's own fields sit under `session`, the lists and `parent` (a NodeRef: node_id, title, ...)
 * at the top level. A bare object (everything at the top level) is also read, for tests.
 */
export function normalizeSessionDetail(raw: Wire): SessionDetail {
  const w = isObj(raw.session) ? raw.session : raw;
  const t = isObj(w.tokens) ? w.tokens : null;
  const parentObj = isObj(raw.parent) ? raw.parent : isObj(w.parent) ? w.parent : null;
  const parentId = str(parentObj?.node_id) ?? str(w.parent_node_id);
  const src = w.parent_link_source;
  return {
    session_id: str(w.session_id) ?? '',
    node_id: str(w.node_id) ?? '',
    repo: str(w.repo),
    host: str(w.host) ?? '',
    available: w.available !== false,
    live: w.live === true,
    unfinished: typeof w.unfinished === 'boolean' ? w.unfinished : null,
    cwd: str(w.cwd),
    branch: str(w.branch),
    name: str(w.name),
    title: str(w.custom_title) ?? str(w.ai_title) ?? str(w.title),
    started_at: str(w.started_at),
    last_active_at: str(w.last_active_at),
    summary: str(w.summary),
    prompts: compact(list(raw.prompts ?? w.prompts).map(prompt)),
    commits: compact(list(raw.commits ?? w.commits).map(commit)),
    notes: compact(list(raw.notes ?? w.notes).map(noteRef)),
    tokens: {
      input: num(t ? t.input : w.input_tokens),
      output: num(t ? t.output : w.output_tokens),
      cache_read: num(t ? t.cache_read : w.cache_read_tokens),
      cache_write: num(t ? t.cache_write : w.cache_write_tokens),
    },
    cost_usd: numOrNull(w.cost_usd),
    parent: parentId === null ? null : { node_id: parentId, name: str(parentObj?.title) ?? str(parentObj?.name) },
    parent_link_source: src === 'env' || src === 'hook' || src === 'heuristic' ? src : null,
    transcript_path: str(w.transcript_path),
  };
}

/** `GET /api/sessions/:nodeId` -> the session, or null on 404. The server normalises the id. */
export async function fetchSessionDetail(nodeId: string, signal?: AbortSignal): Promise<SessionDetail | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  if (!isObj(j)) throw new ApiError(500, 'bad session detail');
  return normalizeSessionDetail(j);
}

/** Phase 9: `POST /api/sessions/:nodeId/resume` `{fresh?, prompt?}` -> `{action, window?}`. Throws `ApiError` (`not_on_this_machine`, 403 from the same-origin guard, ...). */
export async function resumeSession(nodeId: string, opts: ResumeOptions = {}): Promise<ResumeResult> {
  const body: { fresh?: boolean; prompt?: string } = {};
  if (opts.fresh) body.fresh = true;
  const p = opts.prompt?.trim();
  if (p) body.prompt = p;
  const res = await fetch(`/api/sessions/${enc(nodeId)}/resume`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  const o = isObj(j) ? j : {};
  return { action: str(o.action) ?? 'unknown', window: str(o.window) };
}

/** The panel's one-line report of a successful resume / spawn. */
export function resumeNotice(r: ResumeResult, fresh: boolean): string {
  const where = r.window ? ` in ${r.window}` : '';
  switch (r.action) {
    case 'resumed':
      return `Resumed${where}`;
    case 'spawned':
    case 'fresh':
      return `Fresh session started${where}`;
    case 'focused':
      return `Already running, focused${where}`;
    case 'messaged':
      return `Already running, prompt sent${where}`;
    default:
      return `${fresh ? 'Fresh session' : 'Resume'}: ${r.action}${where}`;
  }
}

/** The panel's one-line report of a failed resume / spawn. */
export function resumeErrorNotice(err: unknown, d: Pick<SessionDetail, 'node_id' | 'host'>): string {
  if (err instanceof ApiError) {
    if (err.message === 'not_on_this_machine') return `${d.node_id} is not on this machine${d.host ? ` (it ran on ${d.host})` : ''}`;
    if (err.status === 403) return 'Resume only works from the wall on this machine';
    return `Could not resume ${d.node_id}: ${err.message}`;
  }
  return `Could not resume ${d.node_id}`;
}
