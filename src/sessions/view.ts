/**
 * Pure shaping of cc_sessions rows into the JSON the sessions read API, the MCP session tools
 * and the prompt hook's context endpoint return (iteration 8, phase 7). No I/O here: the SQL is in
 * readModel.ts, the transcript scan in transcriptSearch.ts. These types are the published
 * contract the web (phases 10-13) and the prompt hook (phase 8) plan against.
 */

export type ParentLinkSource = 'env' | 'hook' | 'heuristic';

export const SUMMARY_EXCERPT_CHARS = 280;
export const FIRST_PROMPT_EXCERPT_CHARS = 200;
export const TITLE_PROMPT_CHARS = 80;
export const DETAIL_TEXT_CHARS = 4000;
export const DETAIL_PROMPT_CHARS = 2000;
export const DETAIL_MAX_PROMPTS = 200;
export const DETAIL_MAX_CHILDREN = 500;
export const DETAIL_MAX_NOTES = 50;
export const NOTE_EXCERPT_CHARS = 200;
export const CONTEXT_NODE_MAX_CHARS = 4000;
export const CONTEXT_MAX_COMMITS = 10;
export const CONTEXT_MAX_PLAN_DOCS = 10;
export const CONTEXT_MAX_CHILDREN = 20;
export const CONTEXT_PROMPT_CHARS = 500;

/** First line of ContextPayload.context: tells the reading model where the blocks come from. */
export const CONTEXT_HEADER =
  'Claude Code session nodes mentioned in this prompt (from mcp-notes; node ids look like A0-3G):';

export interface TokenCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  total: number;
}

export interface GraphNode {
  session_id: string;
  node_id: string;
  repo: string | null;
  parent_session_id: string | null;
  parent_node_id: string | null;
  parent_link_source: ParentLinkSource | null;
  title: string;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  branch: string | null;
  cwd: string | null;
  started_at: string | null;
  last_active_at: string | null;
  host: string;
  available: boolean;
  live: boolean;
  status: string | null;
  tmux: string | null;
  tokens: TokenCounts;
  cost_usd: number | null;
  summary_excerpt: string | null;
  child_count: number;
  /** Phase 13 fills it; null until then. */
  unfinished: boolean | null;
}

export interface GraphPayload {
  repo: string;
  host: string;
  generated_at: string;
  total: number;
  truncated: boolean;
  next_before: string | null;
  nodes: GraphNode[];
}

export interface ProjectSummary {
  repo: string;
  sessions: number;
  live: number;
  last_active_at: string | null;
  first_started_at: string | null;
  hosts: string[];
}

export interface ProjectsPayload {
  host: string;
  selected: string | null;
  projects: ProjectSummary[];
}

export interface SelectedProject {
  repo: string | null;
}

export interface SessionPrompt {
  text: string;
  at: string | null;
}

export interface SessionCommit {
  sha: string | null;
  subject: string | null;
}

export interface NoteRef {
  id: string;
  excerpt: string;
  tags: string[];
  created_at: string | null;
}

export interface NodeRef {
  session_id: string;
  node_id: string;
  repo: string | null;
  title: string;
  started_at: string | null;
  last_active_at: string | null;
  host: string;
  available: boolean;
  live: boolean;
  status: string | null;
  parent_link_source: ParentLinkSource | null;
}

export interface SessionInfo extends GraphNode {
  entrypoint: string | null;
  version: string | null;
  models: unknown;
  transcript_path: string | null;
  last_prompt: string | null;
  summary: string | null;
  summarized_at: string | null;
  final_message: string | null;
}

export interface SessionDetail {
  session: SessionInfo;
  prompts: SessionPrompt[];
  commits: SessionCommit[];
  files_edited: string[];
  plan_docs: string[];
  notes: NoteRef[];
  parent: NodeRef | null;
  children: NodeRef[];
}

export interface ContextNode {
  node_id: string;
  session_id: string;
  text: string;
}

export interface ContextPayload {
  nodes: ContextNode[];
  missing: string[];
  context: string;
}

export interface SearchHit extends GraphNode {
  score: number;
}

export interface SearchPayload {
  query: string;
  mode: 'hybrid' | 'text';
  fallback: string | null;
  hits: SearchHit[];
}

export interface UsageTotals {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
}

export interface UsageMonthRow extends UsageTotals {
  month: string;
}

export interface UsageNodeRow {
  node_id: string;
  session_id: string;
  repo: string | null;
  title: string;
  started_at: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
}

export type UsagePayload =
  | { by: 'month'; repo: string | null; month: string | null; time_zone: string; rows: UsageMonthRow[]; totals: UsageTotals }
  | { by: 'node'; repo: string | null; month: string | null; time_zone: string; rows: UsageNodeRow[]; totals: UsageTotals };

export interface TranscriptPayload {
  node_id: string;
  session_id: string;
  query: string | null;
  transcript_path: string;
  matches: Array<{ line: number; at: string | null; role: 'user' | 'assistant'; excerpt: string }>;
  total_matches: number;
  truncated: boolean;
  scanned_bytes: number;
}

/**
 * One row of readModel's NODE_SELECT (snake_case SQL names; token columns already cast to float8).
 * A type alias, not an interface: db.execute<T> needs T assignable to Record<string, unknown>.
 */
export type NodeRow = {
  session_id: string;
  node_id: string;
  host: string;
  repo: string | null;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  started_at: Date | string | null;
  last_active_at: Date | string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
  parent_session_id: string | null;
  parent_link_source: string | null;
  tmux: string | null;
  summary_head: string | null;
  parent_node_id: string | null;
  child_count: number | string | null;
};

/** NODE_SELECT + DETAIL_SELECT. */
export type DetailRow = NodeRow & {
  entrypoint: string | null;
  version: string | null;
  models: unknown;
  transcript_path: string | null;
  first_prompt_full: string | null;
  last_prompt: string | null;
  summary: string | null;
  summarized_at: Date | string | null;
  final_message: string | null;
  prompts: unknown;
  commits: unknown;
  files_edited: unknown;
  plan_docs: unknown;
};

/** One live session from phase 3's registry, as the read model needs it. */
export interface LiveEntry {
  sessionId: string;
  status: string | null;
  tmux: string | null;
}

export interface NodeContext {
  /** os.hostname() of this daemon. */
  host: string;
  /** This host's live sessions, by session id. */
  live: ReadonlyMap<string, LiveEntry>;
}

export interface ContextInput {
  session: SessionInfo;
  commits: SessionCommit[];
  plan_docs: string[];
  children_node_ids: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/** Date or date-like string -> ISO 8601 UTC; anything else (or an invalid date) -> null. */
export function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** pg numeric/bigint may come back as strings; null/NaN -> 0. */
export function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed string, or null when empty / not a string. */
export function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

function dropTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** Whitespace collapsed to single spaces, at most `max` chars, an ellipsis when cut; null when empty. */
export function excerpt(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const flat = text.trim().replace(/\s+/g, ' ');
  if (flat === '') return null;
  if (flat.length <= max) return flat;
  return `${dropTrailingHighSurrogate(flat.slice(0, Math.max(0, max - 1)))}…`;
}

/** Like excerpt but keeps line breaks (multi-line text such as a summary or the context block). */
export function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const t = text.trim();
  if (t === '') return null;
  if (t.length <= max) return t;
  return `${dropTrailingHighSurrogate(t.slice(0, Math.max(0, max - 1)))}…`;
}

export function sessionTitle(row: {
  node_id: string;
  custom_title: string | null;
  name: string | null;
  ai_title: string | null;
  first_prompt: string | null;
}): string {
  return (
    nonEmpty(row.custom_title) ??
    nonEmpty(row.name) ??
    nonEmpty(row.ai_title) ??
    excerpt(row.first_prompt, TITLE_PROMPT_CHARS) ??
    row.node_id
  );
}

export function linkSource(value: unknown): ParentLinkSource | null {
  return value === 'env' || value === 'hook' || value === 'heuristic' ? value : null;
}

export function tokenCounts(row: Pick<NodeRow, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): TokenCounts {
  const input = num(row.input_tokens);
  const output = num(row.output_tokens);
  const cacheRead = num(row.cache_read_tokens);
  const cacheWrite = num(row.cache_write_tokens);
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/** A row becomes a graph node. `available`/`live` are relative to `ctx.host`; `unfinished` stays null (phase 13). */
export function toGraphNode(row: NodeRow, ctx: NodeContext): GraphNode {
  const available = row.host === ctx.host;
  const live = available ? ctx.live.get(row.session_id) : undefined;
  return {
    session_id: row.session_id,
    node_id: row.node_id,
    repo: nonEmpty(row.repo),
    parent_session_id: nonEmpty(row.parent_session_id),
    parent_node_id: nonEmpty(row.parent_node_id),
    parent_link_source: linkSource(row.parent_link_source),
    title: sessionTitle(row),
    name: nonEmpty(row.name),
    custom_title: nonEmpty(row.custom_title),
    ai_title: nonEmpty(row.ai_title),
    first_prompt: excerpt(row.first_prompt, FIRST_PROMPT_EXCERPT_CHARS),
    branch: nonEmpty(row.branch),
    cwd: nonEmpty(row.cwd),
    started_at: iso(row.started_at),
    last_active_at: iso(row.last_active_at),
    host: row.host,
    available,
    live: live !== undefined,
    status: live?.status ?? null,
    tmux: live?.tmux ?? nonEmpty(row.tmux),
    tokens: tokenCounts(row),
    cost_usd: numOrNull(row.cost_usd),
    summary_excerpt: excerpt(row.summary_head, SUMMARY_EXCERPT_CHARS),
    child_count: num(row.child_count),
    unfinished: null,
  };
}

export function toNodeRef(node: GraphNode): NodeRef {
  return {
    session_id: node.session_id,
    node_id: node.node_id,
    repo: node.repo,
    title: node.title,
    started_at: node.started_at,
    last_active_at: node.last_active_at,
    host: node.host,
    available: node.available,
    live: node.live,
    status: node.status,
    parent_link_source: node.parent_link_source,
  };
}

export function toSessionInfo(row: DetailRow, ctx: NodeContext): SessionInfo {
  return {
    ...toGraphNode(row, ctx),
    first_prompt: clip(row.first_prompt_full, DETAIL_TEXT_CHARS),
    entrypoint: nonEmpty(row.entrypoint),
    version: nonEmpty(row.version),
    models: row.models ?? null,
    transcript_path: nonEmpty(row.transcript_path),
    last_prompt: clip(row.last_prompt, DETAIL_TEXT_CHARS),
    summary: clip(row.summary, Number.MAX_SAFE_INTEGER),
    summarized_at: iso(row.summarized_at),
    final_message: clip(row.final_message, DETAIL_TEXT_CHARS),
  };
}

/** cc_sessions.prompts -> [{text, at}], oldest first, the last DETAIL_MAX_PROMPTS. Strings or {text|prompt|content, at|timestamp|ts}. */
export function normalizePrompts(value: unknown): SessionPrompt[] {
  if (!Array.isArray(value)) return [];
  const out: SessionPrompt[] = [];
  for (const item of value) {
    let text: string | null = null;
    let at: string | null = null;
    if (typeof item === 'string') {
      text = item;
    } else if (isRecord(item)) {
      text = firstString(item, ['text', 'prompt', 'content']);
      at = iso(firstString(item, ['at', 'timestamp', 'ts']));
    }
    const t = clip(text, DETAIL_PROMPT_CHARS);
    if (t !== null) out.push({ text: t, at });
  }
  return out.slice(-DETAIL_MAX_PROMPTS);
}

const SHA_THEN_SUBJECT = /^([0-9a-f]{7,40})(?:\s+(.*))?$/i;

/** cc_sessions.commits -> [{sha, subject}]. Strings "sha subject" or {sha|hash|commit, subject|message|title}. */
export function normalizeCommits(value: unknown): SessionCommit[] {
  if (!Array.isArray(value)) return [];
  const out: SessionCommit[] = [];
  for (const item of value) {
    let sha: string | null = null;
    let subject: string | null = null;
    if (typeof item === 'string') {
      const t = item.trim();
      const m = SHA_THEN_SUBJECT.exec(t);
      if (m) {
        sha = m[1] ?? null;
        subject = nonEmpty(m[2]);
      } else {
        subject = nonEmpty(t);
      }
    } else if (isRecord(item)) {
      sha = nonEmpty(firstString(item, ['sha', 'hash', 'commit']));
      const message = firstString(item, ['subject', 'message', 'title']);
      subject = message === null ? null : nonEmpty(message.split('\n')[0]);
    }
    if (sha !== null || subject !== null) out.push({ sha, subject });
  }
  return out;
}

/** cc_sessions.files_edited / plan_docs -> unique paths in first-seen order. Strings or {path|file|file_path}. */
export function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const p = typeof item === 'string' ? nonEmpty(item) : isRecord(item) ? nonEmpty(firstString(item, ['path', 'file', 'file_path'])) : null;
    if (p !== null) seen.add(p);
  }
  return [...seen];
}

/** Wall deep link to a node in its project graph (phase 10's route); null without a repo. */
export function nodeUrl(wallUrl: string, repo: string | null, nodeId: string): string | null {
  if (repo === null) return null;
  const base = wallUrl.replace(/\/+$/, '');
  return `${base}/projects?repo=${encodeURIComponent(repo)}&node=${encodeURIComponent(nodeId)}`;
}

/** ISO instant -> "YYYY-MM-DD HH:mm" in `timeZone`; null for a missing or invalid instant. */
export function formatLocalTime(value: string | null, timeZone: string): string | null {
  if (value === null) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function span(start: string | null, end: string | null, timeZone: string): string | null {
  const a = formatLocalTime(start, timeZone);
  const b = formatLocalTime(end, timeZone);
  if (a !== null && b !== null) return `${a} to ${b} ${timeZone}`;
  if (a !== null) return `started ${a} ${timeZone}`;
  if (b !== null) return `last active ${b} ${timeZone}`;
  return null;
}

function listed(items: readonly string[], max: number, sep: string): string {
  const shown = items.slice(0, max).join(sep);
  return items.length > max ? `${shown}${sep}+${items.length - max} more` : shown;
}

/**
 * The block the prompt hook (phase 8) injects for one node id: who/where/when, parent and
 * children, summary (or first prompt), plan docs, commits, transcript path or the host that holds
 * it, and the wall link. At most CONTEXT_NODE_MAX_CHARS.
 */
export function formatContext(input: ContextInput, opts: { timeZone: string; wallUrl: string }): string {
  const s = input.session;
  const where = [s.repo !== null ? `repo ${s.repo}` : null, s.branch !== null ? `branch ${s.branch}` : null, `host ${s.host}`]
    .filter((x): x is string => x !== null)
    .join(', ');
  const when = span(s.started_at, s.last_active_at, opts.timeZone);
  const state = s.live ? `; running now${s.status !== null ? ` (${s.status})` : ''}` : '';
  const lines: string[] = [`Session ${s.node_id} "${s.title}" (${where}${when !== null ? `; ${when}` : ''}${state})`];
  if (s.parent_node_id !== null) {
    lines.push(`Parent: ${s.parent_node_id}${s.parent_link_source !== null ? ` (${s.parent_link_source} link)` : ''}`);
  }
  if (input.children_node_ids.length > 0) {
    lines.push(`Children: ${listed(input.children_node_ids, CONTEXT_MAX_CHILDREN, ', ')}`);
  }
  if (s.summary !== null) {
    lines.push(`Summary: ${s.summary}`);
  } else {
    const first = excerpt(s.first_prompt, CONTEXT_PROMPT_CHARS);
    lines.push(`Summary: not summarized yet.${first !== null ? ` First prompt: ${first}` : ''}`);
  }
  if (input.plan_docs.length > 0) lines.push(`Plan docs: ${listed(input.plan_docs, CONTEXT_MAX_PLAN_DOCS, ', ')}`);
  if (input.commits.length > 0) {
    const commits = input.commits.map((c) => [c.sha?.slice(0, 7) ?? null, c.subject].filter((x) => x !== null).join(' '));
    lines.push(`Commits: ${listed(commits, CONTEXT_MAX_COMMITS, '; ')}`);
  }
  if (!s.available) {
    lines.push(`Transcript: on ${s.host}, not readable from this machine.`);
  } else if (s.transcript_path !== null) {
    lines.push(`Transcript: ${s.transcript_path} (resume with: claude --resume ${s.session_id})`);
  } else {
    lines.push('Transcript: not recorded.');
  }
  const url = nodeUrl(opts.wallUrl, s.repo, s.node_id);
  if (url !== null) lines.push(`Wall: ${url}`);
  return clip(lines.join('\n'), CONTEXT_NODE_MAX_CHARS) ?? '';
}
