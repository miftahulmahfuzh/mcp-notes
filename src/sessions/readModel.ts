import os from 'node:os';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { ModelUsage } from '../db/schema.js';
import type { AppDeps } from '../deps.js';
import type { Embedder } from '../embeddings/embedder.js';
import { DEFAULT_WALL_URL, localTimeZone, wallUrlForPort } from '../mcp/instructions.js';
import { createCommitLinker, type CommitLinker } from './commitLinks.js';
import { normalizeNodeId } from './ids.js';
import { mergeModels } from './merge.js';
import { estimateCostUsd } from './pricing.js';
import { readLiveSessions } from './registry.js';
import { SessionsRepo } from './repo.js';
import { searchSessions } from './search.js';
import { searchTranscript } from './transcriptSearch.js';
import {
  CONTEXT_HEADER,
  DETAIL_MAX_CHILDREN,
  DETAIL_MAX_NOTES,
  formatContext,
  iso,
  normalizeCommits,
  normalizePaths,
  normalizePrompts,
  num,
  numOrNull,
  summaryState,
  toGraphNode,
  toNodeRef,
  toNoteRef,
  toPromptsPayload,
  toSessionInfo,
  type ContextNode,
  type ContextPayload,
  type DetailRow,
  type GraphPayload,
  type LiveEntry,
  type NodeContext,
  type NodeRow,
  type NoteRefRow,
  type ProjectsPayload,
  type PromptsPayload,
  type SearchPayload,
  type SessionDetail,
  type StoredPromptImageRow,
  type StoredPromptRow,
  type SummaryRequestPayload,
  type TranscriptPayload,
  type UsageMonthRow,
  type UsageNodeRow,
  type UsagePayload,
  type UsageTotals,
} from './view.js';

import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS, SELECTED_PROJECT_KEY } from './types.js';

export { SELECTED_PROJECT_KEY };
export const CONTEXT_MAX_IDS = 10;
/** Ids checked per `knownNodes` call (the wall's chat linkifier batches what one render shows). */
export const KNOWN_MAX_IDS = 100;
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

/** Records a summary request for one session: SessionsRepo.requestSummary (invariant 2). */
export type SummaryRequestWriter = (sessionId: string) => Promise<void>;

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
  /** Forge links for a session's commits (src/sessions/commitLinks.ts). */
  commitLinks: CommitLinker;
  /** The one session write this API makes (POST /api/sessions/:nodeId/summarize). */
  requestSummary: SummaryRequestWriter;
}

/** Test seams; production passes none. */
export interface SessionsReadOverrides {
  host?: string;
  timeZone?: string;
  live?: LiveSource;
  settings?: SettingsStore;
  search?: SessionSearchFn;
  commitLinks?: CommitLinker;
  requestSummary?: SummaryRequestWriter;
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

/** Summary requests go through SessionsRepo, created on first use (building deps does no I/O). */
function repoSummaryRequests(db: Db): SummaryRequestWriter {
  let repo: SessionsRepo | null = null;
  return async (sessionId) => {
    repo ??= new SessionsRepo(db);
    await repo.requestSummary(sessionId);
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

/** How many of a repo's recent cwds the commit linker may try when the session's own clone is gone. */
const KNOWN_CLONES_MAX = 20;

/**
 * Where other sessions of `repo` ran on `host`, most recently active first: the commit linker's way
 * to the clone of a session whose worktree was removed (src/sessions/commitLinks.ts).
 */
function sessionClones(db: Db, host: string): (repo: string) => Promise<string[]> {
  return async (repo) => {
    const res = await db.execute<{ cwd: string }>(sql`
      select cwd from cc_sessions
      where repo = ${repo} and host = ${host} and cwd is not null and cwd <> ''
      group by cwd
      order by max(last_active_at) desc nulls last
      limit ${KNOWN_CLONES_MAX}`);
    return res.rows.map((r) => r.cwd);
  };
}

// ---------------------------------------------------------------------------------------------

export function sessionsReadDeps(deps: AppDeps, over: SessionsReadOverrides = {}): SessionsReadDeps {
  const claudeHome = deps.config.sessions?.claudeHome ?? path.join(os.homedir(), '.claude');
  const embedder = deps.embedder ?? null;
  const host = over.host ?? os.hostname();
  return {
    db: deps.db,
    host,
    timeZone: over.timeZone ?? localTimeZone(),
    wallUrl: wallUrlForPort(deps.config.port) ?? DEFAULT_WALL_URL,
    live: over.live ?? (() => liveFromRegistry(claudeHome)),
    settings: over.settings ?? repoSettings(deps.db),
    commitLinks: over.commitLinks ?? createCommitLinker({ homeDir: os.homedir(), knownClones: sessionClones(deps.db, host) }),
    search: over.search ?? phase6Search(deps.db, embedder),
    requestSummary: over.requestSummary ?? repoSummaryRequests(deps.db),
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
  s.summary, s.summarized_at, s.summary_requested_at,
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
  const [children, parent, notes, subagents] = await Promise.all([
    rd.db.execute<NodeRow>(sql`
      select ${NODE_SELECT} from ${NODE_FROM}
      where s.parent_session_id = ${row.session_id}
      order by s.started_at asc nulls last, s.session_id
      limit ${DETAIL_MAX_CHILDREN}`),
    row.parent_session_id === null
      ? Promise.resolve(null)
      : rd.db.execute<NodeRow>(sql`select ${NODE_SELECT} from ${NODE_FROM} where s.session_id = ${row.parent_session_id} limit 1`),
    // Made (origin.claude_session) or linked (note_session_links), each note once: one row per
    // note, so a note that is both comes back once with kind 'made'. The limit caps the union.
    rd.db.execute<NoteRefRow>(sql`
      select n.id, n.body, n.tags, n.created_at,
        case when n.origin ->> 'claude_session' = ${row.session_id} then 'made' else 'linked' end as kind
      from notes n
      where n.deleted_at is null
        and (
          n.origin ->> 'claude_session' = ${row.session_id}
          or exists (select 1 from note_session_links l where l.note_id = n.id and l.session_id = ${row.session_id})
        )
      order by n.created_at desc, n.id desc
      limit ${DETAIL_MAX_NOTES}`),
    rd.db.execute<{ models: unknown }>(sql`select models from cc_subagent_transcripts where session_id = ${row.session_id}`),
  ]);
  const parentRow = parent?.rows[0];
  const subModels = subagents.rows.reduce<Record<string, ModelUsage>>(
    (acc, r) => mergeModels(acc, isRecord(r.models) ? (r.models as Record<string, ModelUsage>) : {}, false),
    {},
  );
  const commits = normalizeCommits(row.commits);
  const links = await rd.commitLinks({
    repo: row.repo,
    cwd: row.cwd,
    shas: commits.flatMap((c) => (c.sha === null ? [] : [c.sha])),
  });
  return {
    session: toSessionInfo(row, ctx, { count: subagents.rows.length, costUsd: estimateCostUsd(subModels) }),
    prompts: normalizePrompts(row.prompts),
    commits: commits.map((c) => ({ ...c, url: c.sha === null ? null : (links.get(c.sha.toLowerCase()) ?? null) })),
    files_edited: normalizePaths(row.files_edited),
    plan_docs: normalizePaths(row.plan_docs),
    notes: notes.rows.map(toNoteRef),
    parent: parentRow === undefined ? null : toNodeRef(toGraphNode(parentRow, ctx)),
    children: children.rows.map((c) => toNodeRef(toGraphNode(c, ctx))),
  };
}

export type SummaryRequestOutcome =
  | { ok: true; payload: SummaryRequestPayload }
  | { ok: false; error: 'not_found'; node_id: string }
  | { ok: false; error: 'empty_session'; node_id: string };

type SummaryStateRow = {
  session_id: string;
  node_id: string;
  host: string;
  has_summary: boolean | null;
  total_tokens: number | string | null;
  summary_requested_at: Date | string | null;
};

/** The light columns summaryState needs; never loads the summary or prompt text. */
async function readSummaryStateRow(rd: SessionsReadDeps, nodeId: string): Promise<SummaryStateRow | null> {
  const res = await rd.db.execute<SummaryStateRow>(sql`
    select s.session_id, s.node_id, s.host,
      (s.summary is not null and btrim(s.summary) <> '') as has_summary,
      ${TOTAL_TOKENS}::float8 as total_tokens,
      s.summary_requested_at
    from cc_sessions s
    where s.node_id = ${nodeId}
    limit 1`);
  return res.rows[0] ?? null;
}

function summaryPayload(row: SummaryStateRow, thisHost: string): SummaryRequestPayload {
  const requestedAt = iso(row.summary_requested_at);
  return {
    node_id: row.node_id,
    summary_state: summaryState(
      { has_summary: row.has_summary === true, total_tokens: num(row.total_tokens), summary_requested_at: requestedAt, host: row.host },
      thisHost,
    ),
    summary_requested_at: requestedAt,
  };
}

/**
 * Records a summary request for a node (the Summarize button). Never calls the summarizer: the
 * owning host's summary worker serves the request on its next sweep. Idempotent: a node already
 * requested or already summarized is answered as it is, without a write. A session with no tokens
 * has nothing to summarize. `nodeId` is already normalized by the caller.
 */
export async function requestSummaryFor(rd: SessionsReadDeps, nodeId: string): Promise<SummaryRequestOutcome> {
  const before = await readSummaryStateRow(rd, nodeId);
  if (before === null) return { ok: false, error: 'not_found', node_id: nodeId };
  const current = summaryPayload(before, rd.host);
  if (current.summary_state === 'empty') return { ok: false, error: 'empty_session', node_id: before.node_id };
  if (current.summary_state === 'ready' || current.summary_state === 'requested') return { ok: true, payload: current };
  await rd.requestSummary(before.session_id);
  const after = await readSummaryStateRow(rd, nodeId);
  return { ok: true, payload: summaryPayload(after ?? before, rd.host) };
}

type PromptsHeadRow = {
  session_id: string;
  node_id: string;
  host: string;
  prompts_version: number;
  excerpts: unknown;
};

/**
 * Every stored prompt of one node, for the wall's Expand prompts modal. DB only, never the
 * transcript, so it answers for every host's nodes. A row at PROMPTS_VERSION reads the full
 * redacted list from cc_session_prompts (seq order), complete. A row at PROMPTS_VERSION_EXCERPTS
 * (transcript pruned before the backfill) reads the same table, which then holds the redacted
 * excerpts, with complete: false. A legacy row, which its owning host has not backfilled yet, falls
 * back to the excerpts on cc_sessions with complete: false; its side-table rows, if the tail
 * ingester appended some, are partial and ignored. Null when the node does not exist. Never part of
 * the graph or detail queries (invariant 5).
 */
export async function sessionPrompts(rd: SessionsReadDeps, nodeId: string): Promise<PromptsPayload | null> {
  const head = await rd.db.execute<PromptsHeadRow>(sql`
    select session_id, node_id, host, prompts_version,
      case when prompts_version >= ${PROMPTS_VERSION_EXCERPTS} then null else prompts end as excerpts
    from cc_sessions where node_id = ${nodeId} limit 1`);
  const row = head.rows[0];
  if (row === undefined) return null;
  const version = Number(row.prompts_version);
  if (version < PROMPTS_VERSION_EXCERPTS) return toPromptsPayload(row, rd.host, { kind: 'legacy', excerpts: row.excerpts });
  const rows = await rd.db.execute<StoredPromptRow>(sql`
    select seq, text, at, truncated from cc_session_prompts where session_id = ${row.session_id} order by seq`);
  if (version < PROMPTS_VERSION) return toPromptsPayload(row, rd.host, { kind: 'pruned', rows: rows.rows });
  const images = await rd.db.execute<StoredPromptImageRow>(sql`
    select pi.prompt_seq, ci.id, ci.width, ci.height, ci.host
    from cc_session_prompt_images pi join chat_images ci on ci.id = pi.image_id
    where pi.session_id = ${row.session_id} order by pi.prompt_seq, pi.position`);
  return toPromptsPayload(row, rd.host, { kind: 'full', rows: rows.rows, images: images.rows });
}

/** A node id that exists, with its repo: the wall links it in chat and opens its graph. */
export type KnownNode = {
  node_id: string;
  repo: string | null;
};

/** Which of up to KNOWN_MAX_IDS node ids exist (any case, dash optional). One indexed query; unknown and invalid ids are dropped. */
export async function knownNodes(rd: SessionsReadDeps, rawIds: readonly string[]): Promise<KnownNode[]> {
  const wanted = [...new Set(rawIds.slice(0, KNOWN_MAX_IDS).map(normalizeNodeId).filter((id): id is string => id !== null))];
  if (wanted.length === 0) return [];
  const res = await rd.db.execute<KnownNode>(sql`
    select node_id, repo from cc_sessions where node_id = any(${textArray(wanted)}) order by node_id`);
  return res.rows.map((r) => ({ node_id: r.node_id, repo: r.repo ?? null }));
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
