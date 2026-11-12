import { ApiError } from './api';
import { liveJobId, parseForkPoint, parseParentLinkSource } from './lib/parentLink';
import type { ForkPoint, ParentLinkSource } from './types';

export type { ParentLinkSource } from './types';

const enc = encodeURIComponent;
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Phase 2's server-computed reason for the Summary section. */
export type SummaryState = 'ready' | 'empty' | 'requested' | 'idle_wait' | 'other_host';

const SUMMARY_STATES: readonly SummaryState[] = ['ready', 'empty', 'requested', 'idle_wait', 'other_host'];

export interface SessionCommit {
  sha: string;
  subject: string;
  /** The commit's page on GitHub / GitLab, when the server could tell the repo's forge. */
  url: string | null;
}

/** How a note belongs to a session: saved from it (`origin.claude_session`), or linked to it with `link_note`. */
export type SessionNoteKind = 'made' | 'linked';

/** A note this session saved, or one linked to it (`kind`). */
export interface SessionNoteRef {
  id: string;
  /** First non-empty line of the body, clipped; '' when the server sent only the id. */
  preview: string;
  /** 'made' when the server did not say (older daemon, bare id). */
  kind: SessionNoteKind;
}

export interface SessionTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/** Phase 1/2's context band (server `contextBand`): green below 40 %, amber below 70 %, red from 70 %. */
export type ContextBand = 'green' | 'amber' | 'red';

const CONTEXT_BANDS: readonly ContextBand[] = ['green', 'amber', 'red'];

/** Where the window came from (server `contextWindowFor`). 'default': assumed, the model is unknown and nothing showed a 1M window. */
export type ContextWindowSource = 'model' | 'peak' | 'beta' | 'default';

const WINDOW_SOURCES: readonly ContextWindowSource[] = ['model', 'peak', 'beta', 'default'];

/** A session's current context: its latest main-chain assistant message against its inferred window. */
export interface SessionContext {
  tokens: number;
  window: number;
  /** tokens / window × 100 as the server computed it; not clamped. */
  percent: number;
  band: ContextBand;
  model: string | null;
  at: string | null;
  window_source: ContextWindowSource;
  peak_tokens: number | null;
}

/** `GET /api/sessions/:nodeId/context`, and the data of each `context` event of its stream. */
export interface SessionContextPayload {
  node_id: string;
  host: string;
  available: boolean;
  context: SessionContext | null;
}

/** Phase 3's `GET /api/sessions/:nodeId/handoff`: where a fresh spawn would start, and what it would carry. */
export interface HandoffEstimate {
  node_id: string;
  tokens: number;
  window: number;
  percent: number;
  baseline: number;
  exchanges_included: number;
  exchanges_total: number;
  truncated: boolean;
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
  /**
   * Why there is (no) summary. Always 'ready' when `summary` is set, never 'ready' without one.
   * Null: the daemon did not say (older daemon); the panel then shows "No summary yet".
   */
  summary_state: SummaryState | null;
  /** When someone pressed Summarize and the owning host has not served it yet. */
  summary_requested_at: string | null;
  prompts: string[];
  commits: SessionCommit[];
  notes: SessionNoteRef[];
  tokens: SessionTokens;
  cost_usd: number | null;
  /** `cost_usd` is the server's estimate from token counts (no recorded total in the transcript). */
  cost_estimated: boolean;
  /** Subagent transcripts folded into this session, and their estimated cost (part of `cost_usd`). */
  subagent_count: number;
  subagent_cost_usd: number | null;
  /** `repo` can differ from this session's: a session spawned from another project's session. */
  parent: { node_id: string; name: string | null; repo: string | null } | null;
  parent_link_source: ParentLinkSource | null;
  transcript_path: string | null;
  /** Set when this session is a fork: where it left its parent. */
  fork: ForkPoint | null;
  /** Claude Code background job id while the session is live as one; null otherwise. */
  job_id: string | null;
  /** Phase 2: the session's current context, or null when no main-chain assistant message with usage was seen. */
  context: SessionContext | null;
}

export interface ResumeOptions {
  /** Start a new session seeded with this node's context instead of `claude --resume`. */
  fresh?: boolean;
  prompt?: string;
}

/**
 * What the daemon did (`resumed`, `spawned`, `focused`, `messaged`, `attached`) and the tmux window.
 * `job_id`: the background job behind an `attached` (or a focused/messaged attach pane).
 * `prompt_delivered`: false when a prompt was given but no attach pane could take it yet.
 */
export interface ResumeResult {
  action: string;
  window: string | null;
  job_id?: string;
  prompt_delivered?: boolean;
}

/** `POST /api/sessions/:nodeId/summarize`'s answer. */
export interface SummaryRequest {
  summary_state: SummaryState;
  summary_requested_at: string | null;
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

function summaryState(v: unknown): SummaryState | null {
  return typeof v === 'string' && (SUMMARY_STATES as readonly string[]).includes(v) ? (v as SummaryState) : null;
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
    return sp < 0 ? { sha: t, subject: '', url: null } : { sha: t.slice(0, sp), subject: t.slice(sp + 1).trim(), url: null };
  }
  if (isObj(v)) {
    const sha = str(v.sha) ?? str(v.hash);
    if (sha === null) return null;
    const url = str(v.url);
    return { sha, subject: str(v.subject) ?? str(v.message) ?? '', url: url !== null && /^https?:\/\//i.test(url) ? url : null };
  }
  return null;
}

function noteRef(v: unknown): SessionNoteRef | null {
  if (typeof v === 'string') return str(v) === null ? null : { id: v.trim(), preview: '', kind: 'made' };
  if (isObj(v)) {
    const id = str(v.id);
    if (id === null) return null;
    return {
      id,
      preview: firstLine(str(v.excerpt) ?? str(v.preview) ?? str(v.body) ?? ''),
      kind: v.kind === 'linked' ? 'linked' : 'made',
    };
  }
  return null;
}

/** A wire context, or null when there is none or it is not a complete one (shown as Unknown). */
export function normalizeSessionContext(v: unknown): SessionContext | null {
  if (!isObj(v)) return null;
  const tokens = numOrNull(v.tokens);
  const win = numOrNull(v.window);
  const percent = numOrNull(v.percent);
  const band = typeof v.band === 'string' && (CONTEXT_BANDS as readonly string[]).includes(v.band) ? (v.band as ContextBand) : null;
  if (tokens === null || win === null || win <= 0 || percent === null || band === null) return null;
  const source =
    typeof v.window_source === 'string' && (WINDOW_SOURCES as readonly string[]).includes(v.window_source)
      ? (v.window_source as ContextWindowSource)
      : 'default';
  return { tokens, window: win, percent, band, model: str(v.model), at: str(v.at), window_source: source, peak_tokens: numOrNull(v.peak_tokens) };
}

/** `{node_id, host, available, context}`, or null when it has no node id. */
export function normalizeContextPayload(v: unknown): SessionContextPayload | null {
  if (!isObj(v)) return null;
  const nodeId = str(v.node_id);
  if (nodeId === null) return null;
  return { node_id: nodeId, host: str(v.host) ?? '', available: v.available !== false, context: normalizeSessionContext(v.context) };
}

/** One `context` event's `data` (a JSON string), or null when it is not a context payload. */
export function parseContextEvent(data: unknown): SessionContextPayload | null {
  if (typeof data !== 'string') return null;
  try {
    return normalizeContextPayload(JSON.parse(data));
  } catch {
    return null;
  }
}

/** A wire estimate, or null when a field the bar needs is missing. */
export function normalizeHandoffEstimate(v: unknown): HandoffEstimate | null {
  if (!isObj(v)) return null;
  const nodeId = str(v.node_id);
  const tokens = numOrNull(v.tokens);
  const win = numOrNull(v.window);
  const percent = numOrNull(v.percent);
  const included = numOrNull(v.exchanges_included);
  const total = numOrNull(v.exchanges_total);
  if (nodeId === null || tokens === null || win === null || win <= 0 || percent === null || included === null || total === null) return null;
  return {
    node_id: nodeId,
    tokens,
    window: win,
    percent,
    baseline: num(v.baseline),
    exchanges_included: included,
    exchanges_total: total,
    truncated: v.truncated === true,
  };
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
  const fork = parseForkPoint(w.fork ?? raw.fork);
  const parentId = str(parentObj?.node_id) ?? str(w.parent_node_id) ?? fork?.parent_node_id ?? null;
  const live = w.live === true;
  const summary = str(w.summary);
  const state = summaryState(w.summary_state);
  return {
    session_id: str(w.session_id) ?? '',
    node_id: str(w.node_id) ?? '',
    repo: str(w.repo),
    host: str(w.host) ?? '',
    available: w.available !== false,
    live,
    unfinished: typeof w.unfinished === 'boolean' ? w.unfinished : null,
    cwd: str(w.cwd),
    branch: str(w.branch),
    name: str(w.name),
    title: str(w.custom_title) ?? str(w.ai_title) ?? str(w.title),
    started_at: str(w.started_at),
    last_active_at: str(w.last_active_at),
    summary,
    summary_state: summary !== null ? 'ready' : state === 'ready' ? null : state,
    summary_requested_at: str(w.summary_requested_at),
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
    cost_estimated: w.cost_estimated === true,
    subagent_count: num(w.subagent_count),
    subagent_cost_usd: numOrNull(w.subagent_cost_usd),
    parent: parentId === null ? null : { node_id: parentId, name: str(parentObj?.title) ?? str(parentObj?.name), repo: str(parentObj?.repo) },
    parent_link_source: parseParentLinkSource(w.parent_link_source),
    transcript_path: str(w.transcript_path),
    fork,
    job_id: liveJobId(w.job_id ?? raw.job_id, live),
    context: normalizeSessionContext(w.context),
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

/** `GET /api/sessions/:nodeId/context` -> the node's context payload, or null on 404. Works for either machine's sessions. */
export async function fetchSessionContext(nodeId: string, signal?: AbortSignal): Promise<SessionContextPayload | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/context`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const p = normalizeContextPayload(await res.json());
  if (p === null) throw new ApiError(500, 'bad context payload');
  return p;
}

/** `GET /api/sessions/:nodeId/handoff` -> the fresh-spawn estimate (a dry run, nothing written), or null on 404. */
export async function fetchHandoffEstimate(nodeId: string, signal?: AbortSignal): Promise<HandoffEstimate | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/handoff`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const e = normalizeHandoffEstimate(await res.json());
  if (e === null) throw new ApiError(500, 'bad handoff estimate');
  return e;
}

/** `POST /api/sessions/:nodeId/resume` `{fresh?, prompt?}` -> `{action, window?, job_id?, prompt_delivered?}`. Throws `ApiError` (`not_on_this_machine`, 403 from the same-origin guard, ...). */
export async function resumeSession(nodeId: string, opts: ResumeOptions = {}): Promise<ResumeResult> {
  const body: { fresh?: boolean; prompt?: string } = {};
  if (opts.fresh) body.fresh = true;
  const p = opts.prompt?.trim();
  if (p) body.prompt = p;
  const res = await fetch(`/api/sessions/${enc(nodeId)}/resume`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  const o = isObj(j) ? j : {};
  const jobId = str(o.job_id);
  return {
    action: str(o.action) ?? 'unknown',
    window: str(o.window),
    ...(jobId !== null ? { job_id: jobId } : {}),
    ...(typeof o.prompt_delivered === 'boolean' ? { prompt_delivered: o.prompt_delivered } : {}),
  };
}

/** The panel's one-line report of a successful resume / spawn / attach. */
export function resumeNotice(r: ResumeResult, fresh: boolean): string {
  const where = r.window ? ` in ${r.window}` : '';
  const attach = r.job_id ? `claude attach ${r.job_id}` : null;
  switch (r.action) {
    case 'resumed':
      return `Resumed${where}`;
    case 'spawned':
    case 'fresh':
      return `Fresh session started${where}`;
    case 'attached': {
      const opened = attach ? `Opened ${attach}${where}` : `Attached to the background session${where}`;
      return r.prompt_delivered === false ? `${opened}; prompt not sent, type it there` : opened;
    }
    case 'focused':
      return attach ? `Background job, focused ${attach}${where}` : `Already running, focused${where}`;
    case 'messaged':
      return attach ? `Background job, prompt sent to ${attach}${where}` : `Already running, prompt sent${where}`;
    default:
      return `${fresh ? 'Fresh session' : 'Resume'}: ${r.action}${where}`;
  }
}

/**
 * The panel's one-line report of a failed resume / spawn. A 409 for a live background job
 * (`no_tmux`, or `live_outside_tmux` from a daemon without phase 4) names the attach command.
 */
export function resumeErrorNotice(err: unknown, d: Pick<SessionDetail, 'node_id' | 'host'> & Partial<Pick<SessionDetail, 'job_id'>>): string {
  if (err instanceof ApiError) {
    if (err.message === 'not_on_this_machine') return `${d.node_id} is not on this machine${d.host ? ` (it ran on ${d.host})` : ''}`;
    if (err.status === 403) return 'Resume only works from the wall on this machine';
    if (err.status === 409 && d.job_id) return `${d.node_id} is background job ${d.job_id}: run claude attach ${d.job_id}`;
    return `Could not resume ${d.node_id}: ${err.message}`;
  }
  return `Could not resume ${d.node_id}`;
}

/**
 * Phase 2: `POST /api/sessions/:nodeId/summarize` records a summary request (the owning host's worker
 * serves it; no model call happens in the request). Idempotent. Throws `ApiError`
 * (`empty_session` 409, `not_found` 404, 403 from the same-origin guard, ...).
 */
export async function requestSummary(nodeId: string): Promise<SummaryRequest> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/summarize`, { method: 'POST' });
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  const o = isObj(j) ? j : {};
  // A 200 means the request is recorded; a state this build does not know still reads as requested.
  return { summary_state: summaryState(o.summary_state) ?? 'requested', summary_requested_at: str(o.summary_requested_at) };
}

/** The panel's one-line report of a failed Summarize. */
export function summarizeErrorNotice(err: unknown, d: Pick<SessionDetail, 'node_id'>): string {
  if (err instanceof ApiError) {
    if (err.message === 'empty_session') return `${d.node_id} is an empty session, nothing to summarize`;
    if (err.status === 403) return 'Summarize only works from the wall on this machine';
    if (err.status === 404) return `No session ${d.node_id}`;
    return `Could not request a summary of ${d.node_id}: ${err.message}`;
  }
  return `Could not request a summary of ${d.node_id}`;
}

/** One image pasted on a prompt: the same id, urls and host-availability a chat image has. */
export interface SessionPromptImage {
  id: string;
  width: number;
  height: number;
  available: boolean;
  urls: { thumb: string; display: string };
}

/** One prompt of `GET /api/sessions/:nodeId/prompts`: numbered from 1, text exactly as stored. */
export interface SessionPromptItem {
  n: number;
  text: string;
  at: string | null;
  truncated: boolean;
  images: SessionPromptImage[];
}

/** Why a prompt list is not complete (server `PromptsIncompleteReason`). */
export type PromptsIncompleteReason = 'not_backfilled' | 'transcript_pruned';

/**
 * `GET /api/sessions/:nodeId/prompts`, normalised. `complete` false: excerpts only, either until
 * `host` backfills (`not_backfilled`) or for good, its transcript was pruned (`transcript_pruned`).
 * `incomplete_reason` is null exactly when `complete` is true.
 */
export interface SessionPrompts {
  node_id: string;
  host: string;
  available: boolean;
  complete: boolean;
  incomplete_reason: PromptsIncompleteReason | null;
  prompts: SessionPromptItem[];
}

function promptImage(v: unknown): SessionPromptImage | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  if (id === null) return null;
  const urls = isObj(v.urls) ? v.urls : {};
  return {
    id,
    width: num(v.width),
    height: num(v.height),
    available: v.available !== false,
    urls: { thumb: str(urls.thumb) ?? `/api/chat/images/${id}/thumb`, display: str(urls.display) ?? `/api/chat/images/${id}/display` },
  };
}

function promptItem(v: unknown, i: number): SessionPromptItem | null {
  if (!isObj(v) || typeof v.text !== 'string' || v.text === '') return null;
  const n = typeof v.n === 'number' && Number.isInteger(v.n) && v.n > 0 ? v.n : i + 1;
  return { n, text: v.text, at: str(v.at), truncated: v.truncated === true, images: compact(list(v.images).map(promptImage)) };
}

export function normalizeSessionPrompts(raw: Wire): SessionPrompts {
  const complete = raw.complete !== false;
  return {
    node_id: str(raw.node_id) ?? '',
    host: str(raw.host) ?? '',
    available: raw.available !== false,
    complete,
    incomplete_reason: complete ? null : raw.incomplete_reason === 'transcript_pruned' ? 'transcript_pruned' : 'not_backfilled',
    prompts: compact(list(raw.prompts).map(promptItem)),
  };
}

/** `GET /api/sessions/:nodeId/prompts` -> every stored prompt, or null on 404. The server normalises the id. */
export async function fetchSessionPrompts(nodeId: string, signal?: AbortSignal): Promise<SessionPrompts | null> {
  const res = await fetch(`/api/sessions/${enc(nodeId)}/prompts`, signal ? { signal } : undefined);
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  if (!isObj(j)) throw new ApiError(500, 'bad prompts payload');
  return normalizeSessionPrompts(j);
}
