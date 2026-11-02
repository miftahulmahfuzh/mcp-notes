import os from 'node:os';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { AppDeps } from '../deps.js';
import type { Embedder } from '../embeddings/embedder.js';
import { DEFAULT_WALL_URL, localTimeZone, wallUrlForPort } from '../mcp/instructions.js';
import { normalizeNodeId } from './ids.js';
import { readLiveSessions } from './registry.js';
import { SessionsRepo } from './repo.js';
import { searchSessions } from './search.js';
import { searchTranscript } from './transcriptSearch.js';
import {
  CONTEXT_HEADER,
  DETAIL_MAX_CHILDREN,
  DETAIL_MAX_NOTES,
  NOTE_EXCERPT_CHARS,
  excerpt,
  formatContext,
  iso,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  num,
  numOrNull,
  toGraphNode,
  toNodeRef,
  toSessionInfo,
  type ContextNode,
  type ContextPayload,
  type DetailRow,
  type GraphPayload,
  type LiveEntry,
  type NodeContext,
  type NodeRow,
  type ProjectsPayload,
  type SearchPayload,
  type SessionDetail,
  type TranscriptPayload,
  type UsageMonthRow,
  type UsageNodeRow,
  type UsagePayload,
  type UsageTotals,
} from './view.js';

import { SELECTED_PROJECT_KEY } from './types.js';

export { SELECTED_PROJECT_KEY };
export const CONTEXT_MAX_IDS = 10;
const USAGE_MAX_MONTHS = 120;

export type LiveSource = () => Promise<LiveEntry[]>;

export interface SettingsStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface SessionSearchHit {
  sessionId: string;
  score: number;
}

export interface SessionSearchOutcome {
  mode: 'hybrid' | 'text';
  fallback: string | null;
  hits: SessionSearchHit[];
}

export type SessionSearchFn = (args: { query: string; repo: string | null; limit: number }) => Promise<SessionSearchOutcome>;

/** Everything the sessions read API and MCP session tools read through. */
export interface SessionsReadDeps {
  db: Db;
  /** os.hostname() of this daemon: decides `available` and which rows can be `live`. */
  host: string;
  /** IANA zone for usage months and context times (the daemon's local zone). */
  timeZone: string;
  /** Wall base URL for node links. */
  wallUrl: string;
  live: LiveSource;
  settings: SettingsStore;
  search: SessionSearchFn;
}

/** Test seams; production passes none. */
export interface SessionsReadOverrides {
  host?: string;
  timeZone?: string;
  live?: LiveSource;
  settings?: SettingsStore;
  search?: SessionSearchFn;
}

// ---- Cross-phase seams: the only places this phase calls phase 1/3/6 runtime code. ----

/** Phase 3's live registry reduced to {sessionId, status, tmux}. A missing or unreadable registry means nothing is live. */
async function liveFromRegistry(claudeHome: string): Promise<LiveEntry[]> {
  try {
    const entries = await readLiveSessions(claudeHome);
    return entries.map((e) => ({ sessionId: e.sessionId, status: e.status ?? null, tmux: e.tmux ?? null }));
  } catch {
    return [];
  }
}

/** Phase 1's app_settings accessors. The repo is created on first use, so building deps does no I/O. */
function repoSettings(db: Db): SettingsStore {
  let repo: SessionsRepo | null = null;
  const get = (): SessionsRepo => (repo ??= new SessionsRepo(db));
  return {
    get: (key) => get().getSetting(key),
    put: (key, value) => get().putSetting(key, value),
  };
}

/** Phase 6's hybrid session search. */
function phase6Search(db: Db, embedder: Embedder | null): SessionSearchFn {
  return async ({ query, repo, limit }) => {
    const res = await searchSessions({ db, embedder }, query, { limit, ...(repo !== null ? { repo } : {}) });
    return {
      mode: res.mode,
      fallback: res.fallback ?? null,
      hits: res.sessions.map((h) => ({ sessionId: h.session_id, score: h.score })),
    };
  };
}

// ---------------------------------------------------------------------------------------------

export function sessionsReadDeps(deps: AppDeps, over: SessionsReadOverrides = {}): SessionsReadDeps {
  const claudeHome = deps.config.sessions?.claudeHome ?? path.join(os.homedir(), '.claude');
  const embedder = deps.embedder ?? null;
  return {
    db: deps.db,
    host: over.host ?? os.hostname(),
    timeZone: over.timeZone ?? localTimeZone(),
    wallUrl: wallUrlForPort(deps.config.port) ?? DEFAULT_WALL_URL,
    live: over.live ?? (() => liveFromRegistry(claudeHome)),
    settings: over.settings ?? repoSettings(deps.db),
    search: over.search ?? phase6Search(deps.db, embedder),
  };
}

/** `= any(<this>)` over a JS string list, as one jsonb parameter (works for an empty list). */
function textArray(ids: readonly string[]): SQL {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
}

async function liveMap(rd: SessionsReadDeps): Promise<Map<string, LiveEntry>> {
  let entries: LiveEntry[];
  try {
    entries = await rd.live();
  } catch {
    entries = [];
  }
  return new Map(entries.map((e) => [e.sessionId, e]));
}

async function nodeContext(rd: SessionsReadDeps): Promise<NodeContext> {
  return { host: rd.host, live: await liveMap(rd) };
}

/** Columns of a graph node. `s` is the row, `p` its parent (left join). */
const NODE_SELECT = sql.raw(`
  s.session_id, s.node_id, s.host, s.repo, s.cwd, s.branch, s.name, s.custom_title, s.ai_title,
  left(s.first_prompt, 400) as first_prompt, s.started_at, s.last_active_at,
  coalesce(s.input_tokens, 0)::float8 as input_tokens,
  coalesce(s.output_tokens, 0)::float8 as output_tokens,
  coalesce(s.cache_read_tokens, 0)::float8 as cache_read_tokens,
  coalesce(s.cache_write_tokens, 0)::float8 as cache_write_tokens,
  s.cost_usd::float8 as cost_usd,
  s.parent_session_id, s.parent_link_source, s.tmux,
  left(s.summary, 600) as summary_head,
  p.node_id as parent_node_id,
  (select count(*)::int from cc_sessions c where c.parent_session_id = s.session_id) as child_count`);

/** Extra columns for node detail and the context endpoint. */
const DETAIL_SELECT = sql.raw(`
  s.entrypoint, s.version, s.models, s.transcript_path,
  left(s.first_prompt, 4000) as first_prompt_full,
  left(s.last_prompt, 4000) as last_prompt,
  s.summary, s.summarized_at,
  left(s.final_message, 4000) as final_message,
  s.prompts, s.commits, s.files_edited, s.plan_docs`);

const NODE_FROM = sql.raw(`cc_sessions s left join cc_sessions p on p.session_id = s.parent_session_id`);

const TOTAL_TOKENS = sql.raw(
  `(coalesce(s.input_tokens, 0) + coalesce(s.output_tokens, 0) + coalesce(s.cache_read_tokens, 0) + coalesce(s.cache_write_tokens, 0))`,
);

const USAGE_SUMS = sql.raw(`
  count(*)::int as sessions,
  coalesce(sum(s.input_tokens), 0)::float8 as input_tokens,
  coalesce(sum(s.output_tokens), 0)::float8 as output_tokens,
  coalesce(sum(s.cache_read_tokens), 0)::float8 as cache_read_tokens,
  coalesce(sum(s.cache_write_tokens), 0)::float8 as cache_write_tokens,
  sum(s.cost_usd)::float8 as cost_usd`);

type ProjectRow = {
  repo: string;
  sessions: number | string;
  live: number | string;
  last_active_at: Date | string | null;
  first_started_at: Date | string | null;
  hosts: string[] | null;
};

type NoteRow = { id: string; body: string; tags: string[] | null; created_at: Date | string | null };

type SumsRow = {
  sessions: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readSelected(rd: SessionsReadDeps): Promise<string | null> {
  const value = await rd.settings.get(SELECTED_PROJECT_KEY);
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (isRecord(value) && typeof value.repo === 'string' && value.repo.trim() !== '') return value.repo;
  return null;
}

export async function writeSelected(rd: SessionsReadDeps, repo: string | null): Promise<void> {
  // Same format as SessionsRepo.setSelectedProject: a bare JSON string; null deletes the key.
  await rd.settings.put(SELECTED_PROJECT_KEY, repo);
}

export async function repoExists(rd: SessionsReadDeps, repo: string): Promise<boolean> {
  const res = await rd.db.execute<{ one: number }>(sql`select 1 as one from cc_sessions where repo = ${repo} limit 1`);
  return res.rows.length > 0;
}

export async function listProjects(rd: SessionsReadDeps): Promise<ProjectsPayload> {
  const live = await liveMap(rd);
  const res = await rd.db.execute<ProjectRow>(sql`
    select repo,
      count(*)::int as sessions,
      count(*) filter (where host = ${rd.host} and session_id = any(${textArray([...live.keys()])}))::int as live,
      max(coalesce(last_active_at, started_at)) as last_active_at,
      min(started_at) as first_started_at,
      array_agg(distinct host order by host) as hosts
    from cc_sessions
    where repo is not null
    group by repo
    order by max(coalesce(last_active_at, started_at)) desc nulls last, repo`);
  const selected = await readSelected(rd);
  return {
    host: rd.host,
    selected,
    projects: res.rows.map((r) => ({
      repo: r.repo,
      sessions: num(r.sessions),
      live: num(r.live),
      last_active_at: iso(r.last_active_at),
      first_started_at: iso(r.first_started_at),
      hosts: Array.isArray(r.hosts) ? r.hosts : [],
    })),
  };
}

export interface GraphQuery {
  /** ISO instant: only nodes that started strictly before it (keyset paging). */
  before: string | null;
  limit: number;
}

export async function graphForRepo(rd: SessionsReadDeps, repo: string, q: GraphQuery): Promise<GraphPayload> {
  const ctx = await nodeContext(rd);
  const beforeCond = q.before === null ? sql`` : sql`and s.started_at < ${q.before}::timestamptz`;
  const [rows, count] = await Promise.all([
    rd.db.execute<NodeRow>(sql`
      select ${NODE_SELECT} from ${NODE_FROM}
      where s.repo = ${repo} ${beforeCond}
      order by s.started_at desc nulls last, s.session_id desc
      limit ${q.limit + 1}`),
    rd.db.execute<{ n: number | string }>(sql`select count(*)::int as n from cc_sessions where repo = ${repo}`),
  ]);
  const more = rows.rows.length > q.limit;
  const nodes = rows.rows.slice(0, q.limit).map((r) => toGraphNode(r, ctx));
  const last = nodes.at(-1);
  return {
    repo,
    host: rd.host,
    generated_at: new Date().toISOString(),
    total: num(count.rows[0]?.n),
    truncated: more,
    next_before: more && last !== undefined ? last.started_at : null,
    nodes,
  };
}

export async function sessionDetail(rd: SessionsReadDeps, nodeId: string): Promise<SessionDetail | null> {
  const res = await rd.db.execute<DetailRow>(sql`
    select ${NODE_SELECT}, ${DETAIL_SELECT} from ${NODE_FROM} where s.node_id = ${nodeId} limit 1`);
  const row = res.rows[0];
  if (row === undefined) return null;
  const ctx = await nodeContext(rd);
  const [children, parent, notes] = await Promise.all([
    rd.db.execute<NodeRow>(sql`
      select ${NODE_SELECT} from ${NODE_FROM}
      where s.parent_session_id = ${row.session_id}
      order by s.started_at asc nulls last, s.session_id
      limit ${DETAIL_MAX_CHILDREN}`),
    row.parent_session_id === null
      ? Promise.resolve(null)
      : rd.db.execute<NodeRow>(sql`select ${NODE_SELECT} from ${NODE_FROM} where s.session_id = ${row.parent_session_id} limit 1`),
    rd.db.execute<NoteRow>(sql`
      select id, body, tags, created_at from notes
      where deleted_at is null and origin ->> 'claude_session' = ${row.session_id}
      order by created_at desc
      limit ${DETAIL_MAX_NOTES}`),
  ]);
  const parentRow = parent?.rows[0];
  return {
    session: toSessionInfo(row, ctx),
    prompts: normalizePrompts(row.prompts),
    commits: normalizeCommits(row.commits),
    files_edited: normalizePaths(row.files_edited),
    plan_docs: normalizePaths(row.plan_docs),
    notes: notes.rows.map((n) => ({
      id: n.id,
      excerpt: excerpt(n.body, NOTE_EXCERPT_CHARS) ?? '',
      tags: Array.isArray(n.tags) ? n.tags : [],
      created_at: iso(n.created_at),
    })),
    parent: parentRow === undefined ? null : toNodeRef(toGraphNode(parentRow, ctx)),
    children: children.rows.map((c) => toNodeRef(toGraphNode(c, ctx))),
  };
}

/**
 * Prompt-hook context for up to CONTEXT_MAX_IDS node ids: one indexed query on node_id, one on
 * parent_session_id, one registry read. Ids that are not node ids or do not exist go to `missing`.
 */
export async function contextFor(rd: SessionsReadDeps, rawIds: readonly string[]): Promise<ContextPayload> {
  const wanted: string[] = [];
  const missing: string[] = [];
  for (const raw of rawIds.slice(0, CONTEXT_MAX_IDS)) {
    const id = normalizeNodeId(raw);
    if (id === null) missing.push(raw);
    else if (!wanted.includes(id)) wanted.push(id);
  }
  if (wanted.length === 0) return { nodes: [], missing, context: '' };

  const res = await rd.db.execute<DetailRow>(sql`
    select ${NODE_SELECT}, ${DETAIL_SELECT} from ${NODE_FROM}
    where s.node_id = any(${textArray(wanted)})`);
  const byNode = new Map(res.rows.map((r) => [r.node_id, r]));
  const sessionIds = res.rows.map((r) => r.session_id);
  const kids =
    sessionIds.length === 0
      ? { rows: [] as Array<{ parent_session_id: string; node_id: string }> }
      : await rd.db.execute<{ parent_session_id: string; node_id: string }>(sql`
          select parent_session_id, node_id from cc_sessions
          where parent_session_id = any(${textArray(sessionIds)})
          order by started_at asc nulls last, node_id`);
  const childrenOf = new Map<string, string[]>();
  for (const k of kids.rows) {
    const list = childrenOf.get(k.parent_session_id) ?? [];
    list.push(k.node_id);
    childrenOf.set(k.parent_session_id, list);
  }
  const ctx = await nodeContext(rd);
  const nodes: ContextNode[] = [];
  for (const id of wanted) {
    const row = byNode.get(id);
    if (row === undefined) {
      missing.push(id);
      continue;
    }
    const text = formatContext(
      {
        session: toSessionInfo(row, ctx),
        commits: normalizeCommits(row.commits),
        plan_docs: normalizePaths(row.plan_docs),
        children_node_ids: childrenOf.get(row.session_id) ?? [],
      },
      { timeZone: rd.timeZone, wallUrl: rd.wallUrl },
    );
    nodes.push({ node_id: row.node_id, session_id: row.session_id, text });
  }
  const context = nodes.length === 0 ? '' : `${CONTEXT_HEADER}\n\n${nodes.map((n) => n.text).join('\n\n')}`;
  return { nodes, missing, context };
}

export async function searchNodes(
  rd: SessionsReadDeps,
  q: { query: string; repo: string | null; limit: number },
): Promise<SearchPayload> {
  const outcome = await rd.search(q);
  const ids = outcome.hits.map((h) => h.sessionId);
  if (ids.length === 0) return { query: q.query, mode: outcome.mode, fallback: outcome.fallback, hits: [] };
  const res = await rd.db.execute<NodeRow>(sql`
    select ${NODE_SELECT} from ${NODE_FROM} where s.session_id = any(${textArray(ids)})`);
  const bySession = new Map(res.rows.map((r) => [r.session_id, r]));
  const ctx = await nodeContext(rd);
  const hits = outcome.hits.flatMap((h) => {
    const row = bySession.get(h.sessionId);
    return row === undefined ? [] : [{ ...toGraphNode(row, ctx), score: Math.round(h.score * 10_000) / 10_000 }];
  });
  return { query: q.query, mode: outcome.mode, fallback: outcome.fallback, hits };
}

export interface UsageQuery {
  by: 'node' | 'month';
  repo: string | null;
  /** YYYY-MM in rd.timeZone, or null for all time. */
  month: string | null;
  /** by=node only. */
  limit: number;
}

function usageWhere(rd: SessionsReadDeps, q: UsageQuery): SQL {
  const conds: SQL[] = [sql`true`];
  if (q.repo !== null) conds.push(sql`s.repo = ${q.repo}`);
  if (q.month !== null) conds.push(sql`to_char(s.started_at at time zone ${rd.timeZone}, 'YYYY-MM') = ${q.month}`);
  return sql.join(conds, sql` and `);
}

function totalsOf(r: SumsRow): UsageTotals {
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  const cacheRead = num(r.cache_read_tokens);
  const cacheWrite = num(r.cache_write_tokens);
  return {
    sessions: num(r.sessions),
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    total_tokens: input + output + cacheRead + cacheWrite,
    cost_usd: numOrNull(r.cost_usd),
  };
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    sessions: a.sessions + b.sessions,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    cost_usd: a.cost_usd === null && b.cost_usd === null ? null : (a.cost_usd ?? 0) + (b.cost_usd ?? 0),
  };
}

const ZERO_TOTALS: UsageTotals = {
  sessions: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  cost_usd: null,
};

export async function usage(rd: SessionsReadDeps, q: UsageQuery): Promise<UsagePayload> {
  const where = usageWhere(rd, q);
  if (q.by === 'month') {
    const res = await rd.db.execute<SumsRow & { month: string }>(sql`
      select to_char(s.started_at at time zone ${rd.timeZone}, 'YYYY-MM') as month, ${USAGE_SUMS}
      from cc_sessions s
      where s.started_at is not null and ${where}
      group by 1
      order by 1 desc
      limit ${USAGE_MAX_MONTHS}`);
    const rows: UsageMonthRow[] = res.rows.map((r) => ({ month: r.month, ...totalsOf(r) }));
    const totals = rows.reduce<UsageTotals>((acc, r) => addTotals(acc, r), ZERO_TOTALS);
    return { by: 'month', repo: q.repo, month: q.month, time_zone: rd.timeZone, rows, totals };
  }
  const [top, sums] = await Promise.all([
    rd.db.execute<NodeRow>(sql`
      select ${NODE_SELECT} from ${NODE_FROM}
      where ${where}
      order by ${TOTAL_TOKENS} desc, s.started_at desc nulls last
      limit ${q.limit}`),
    rd.db.execute<SumsRow>(sql`select ${USAGE_SUMS} from cc_sessions s where ${where}`),
  ]);
  const ctx: NodeContext = { host: rd.host, live: new Map() };
  const rows: UsageNodeRow[] = top.rows.map((r) => {
    const n = toGraphNode(r, ctx);
    return {
      node_id: n.node_id,
      session_id: n.session_id,
      repo: n.repo,
      title: n.title,
      started_at: n.started_at,
      input_tokens: n.tokens.input,
      output_tokens: n.tokens.output,
      cache_read_tokens: n.tokens.cache_read,
      cache_write_tokens: n.tokens.cache_write,
      total_tokens: n.tokens.total,
      cost_usd: n.cost_usd,
    };
  });
  const totalsRow = sums.rows[0];
  return {
    by: 'node',
    repo: q.repo,
    month: q.month,
    time_zone: rd.timeZone,
    rows,
    totals: totalsRow === undefined ? ZERO_TOTALS : totalsOf(totalsRow),
  };
}

export type TranscriptOutcome =
  | { ok: true; payload: TranscriptPayload }
  | { ok: false; error: 'not_found'; node_id: string }
  | { ok: false; error: 'not_on_this_machine'; node_id: string; host: string }
  | { ok: false; error: 'transcript_missing'; node_id: string };

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** Transcript search on the owning host only (invariant 7). */
export async function readTranscript(
  rd: SessionsReadDeps,
  nodeId: string,
  opts: { query: string | null; limit: number },
): Promise<TranscriptOutcome> {
  const res = await rd.db.execute<{ session_id: string; node_id: string; host: string; transcript_path: string | null }>(sql`
    select session_id, node_id, host, transcript_path from cc_sessions where node_id = ${nodeId} limit 1`);
  const row = res.rows[0];
  if (row === undefined) return { ok: false, error: 'not_found', node_id: nodeId };
  if (row.host !== rd.host) return { ok: false, error: 'not_on_this_machine', node_id: row.node_id, host: row.host };
  const file = row.transcript_path;
  if (file === null || file.trim() === '') return { ok: false, error: 'transcript_missing', node_id: row.node_id };
  const query = opts.query === null || opts.query.trim() === '' ? null : opts.query.trim();
  try {
    const r = await searchTranscript(file, { query, limit: opts.limit });
    return {
      ok: true,
      payload: {
        node_id: row.node_id,
        session_id: row.session_id,
        query,
        transcript_path: file,
        matches: r.matches,
        total_matches: r.total_matches,
        truncated: r.truncated,
        scanned_bytes: r.scanned_bytes,
      },
    };
  } catch (err) {
    if (isNotFound(err)) return { ok: false, error: 'transcript_missing', node_id: row.node_id };
    throw err;
  }
}
