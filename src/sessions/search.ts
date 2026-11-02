import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Embedder } from '../embeddings/embedder.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import { parseDateBound } from '../notes/dates.js';
import { decodeCursor, encodeCursor } from '../notes/repo.js';
import { NoteError, type SearchMode } from '../notes/types.js';
import { BLEND, queryTerms, rankCandidates, tagMatch } from '../search/blend.js';
import { QUERY_EMBED_TIMEOUT_MS, QueryVectorCache, embedQuery } from '../search/queryVector.js';
import { findNodeIdCandidates } from './ids.js';

export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
export const SESSION_SEARCH_MAX_LIMIT = 200;
/** Phase 1's generated tsvector column on cc_sessions (name, titles, prompts, summary; 'simple'). */
export const SESSION_TSV_COLUMN = 'search_tsv';
/** first_prompt is cut to this many characters in hits. */
const HIT_PROMPT_CHARS = 500;

export const SESSIONS_SEMANTIC_OFF_FALLBACK =
  'Meaning search is off on this server (OPENROUTER_API_KEY is not set), so these are full-text results only: sessions that share words with the query.';

export function sessionEmbedFailedFallback(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return `The query could not be embedded (${reason}), so these are full-text results only: sessions that share words with the query.`;
}

export interface SessionSearchDeps {
  db: Db;
  embedder: Embedder | null;
  /** Default: one cache shared by every caller in the process. */
  queryVectors?: QueryVectorCache;
  /** This machine; `available` is `host === thisHost`. Default os.hostname(). */
  host?: string;
}

export interface SessionSearchFilter {
  /** Resolved repo key, e.g. `mcp-notes`. */
  repo?: string;
  /** Only sessions whose transcript lives on this host. */
  host?: string;
  /** Inclusive lower bound on the session's activity: YYYY-MM-DD (local day) or ISO datetime. */
  from?: string;
  /** Inclusive upper bound: YYYY-MM-DD (whole local day) or ISO datetime. */
  to?: string;
  /** 1..SESSION_SEARCH_MAX_LIMIT, default SESSION_SEARCH_DEFAULT_LIMIT. */
  limit?: number;
  /** Opaque value from a previous page's next_cursor. */
  cursor?: string;
}

export interface SessionSearchOptions {
  /** Default 'hybrid'. 'text' is the full-text ranking only. */
  mode?: SearchMode;
  queryTimeoutMs?: number;
  /** Recency reference. Default new Date(). */
  now?: Date;
}

/** One search result, wire-ready (snake_case, ISO strings). */
export interface SessionSearchHit {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  /** False when the transcript lives on another machine (invariant 7). */
  available: boolean;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  /** custom title, else AI title, else name. */
  title: string | null;
  /** Cut to 500 characters. */
  first_prompt: string | null;
  summary: string | null;
  started_at: string | null;
  last_active_at: string | null;
  parent_session_id: string | null;
  parent_link_source: 'env' | 'hook' | 'heuristic' | null;
  /** Ranking score: the blended score in hybrid mode, ts_rank in text mode (phase 7 rounds and returns it). */
  score: number;
}

export interface SessionSearchPage {
  sessions: SessionSearchHit[];
  next_cursor: string | null;
  /** The ranking actually used. */
  mode: SearchMode;
  /** Present only when hybrid was asked for but could not run. */
  fallback?: string;
}

type HitDbRow = {
  session_id: string;
  node_id: string;
  repo: string | null;
  host: string;
  cwd: string | null;
  branch: string | null;
  name: string | null;
  custom_title: string | null;
  ai_title: string | null;
  first_prompt: string | null;
  summary: string | null;
  started_at: Date | string | null;
  last_active_at: Date | string | null;
  parent_session_id: string | null;
  parent_link_source: string | null;
  text_rank: number | string | null;
  similarity: number | string | null;
};

const defaultQueryVectors = new QueryVectorCache();

function toDate(v: Date | string | null): Date | null {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampSessionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.min(SESSION_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function tsv(): SQL {
  return sql.raw(`s.${SESSION_TSV_COLUMN}`);
}

function hitFields(): SQL {
  return sql`s.session_id, s.node_id, s.repo, s.host, s.cwd, s.branch, s.name, s.custom_title, s.ai_title,
    left(s.first_prompt, ${HIT_PROMPT_CHARS}) as first_prompt, s.summary, s.started_at, s.last_active_at,
    s.parent_session_id, s.parent_link_source`;
}

function filterSql(filter: SessionSearchFilter): SQL {
  const conds: SQL[] = [sql`true`];
  if (filter.repo !== undefined && filter.repo !== '') conds.push(sql`s.repo = ${filter.repo}`);
  if (filter.host !== undefined && filter.host !== '') conds.push(sql`s.host = ${filter.host}`);
  if (filter.from !== undefined && filter.from !== '') {
    conds.push(sql`coalesce(s.last_active_at, s.started_at) >= ${parseDateBound(filter.from, 'from').toISOString()}::timestamptz`);
  }
  if (filter.to !== undefined && filter.to !== '') {
    conds.push(sql`coalesce(s.started_at, s.last_active_at) < ${parseDateBound(filter.to, 'to').toISOString()}::timestamptz`);
  }
  return sql.join(conds, sql` and `);
}

function toHit(r: HitDbRow, thisHost: string, score: number): SessionSearchHit {
  const source = r.parent_link_source;
  return {
    session_id: r.session_id,
    node_id: r.node_id,
    repo: r.repo,
    host: r.host,
    available: r.host === thisHost,
    cwd: r.cwd,
    branch: r.branch,
    name: r.name,
    title: r.custom_title ?? r.ai_title ?? r.name,
    first_prompt: r.first_prompt,
    summary: r.summary,
    started_at: toDate(r.started_at)?.toISOString() ?? null,
    last_active_at: toDate(r.last_active_at)?.toISOString() ?? null,
    parent_session_id: r.parent_session_id,
    parent_link_source: source === 'env' || source === 'hook' || source === 'heuristic' ? source : null,
    score,
  };
}

async function textSearch(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter,
  offset: number,
  limit: number,
  fallback?: string,
): Promise<SessionSearchPage> {
  const tsq = sql`websearch_to_tsquery('simple', ${query})`;
  const res = await deps.db.execute<HitDbRow>(sql`
    select ${hitFields()}, ts_rank(${tsv()}, ${tsq})::float8 as text_rank, null::float8 as similarity
    from cc_sessions s
    where ${tsv()} @@ ${tsq} and ${filterSql(filter)}
    order by text_rank desc, s.last_active_at desc nulls last, s.session_id desc
    limit ${limit + 1} offset ${offset}
  `);
  const thisHost = deps.host ?? hostname();
  const rows = res.rows;
  const page: SessionSearchPage = {
    sessions: rows.slice(0, limit).map((r) => toHit(r, thisHost, toNumberOrNull(r.text_rank) ?? 0)),
    next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    mode: 'text',
  };
  if (fallback !== undefined) page.fallback = fallback;
  return page;
}

interface HybridQuery {
  query: string;
  vector: readonly number[];
  model: string;
  nodeIds: readonly string[];
  excluded: readonly string[];
}

async function hybridCandidates(db: Db, q: HybridQuery, filter: SessionSearchFilter): Promise<HitDbRow[]> {
  const tsq = sql`websearch_to_tsquery('simple', ${q.query})`;
  const qvec = sql`${toVectorLiteral(q.vector)}::vector`;
  const fields = sql`${hitFields()},
    (case when ${tsv()} @@ ${tsq} then ts_rank(${tsv()}, ${tsq}) end)::float8 as text_rank,
    (1 - (e.embedding <=> ${qvec}))::float8 as similarity`;
  const joinCurrent = sql`e.session_id = s.session_id and e.model = ${q.model} and e.embedding is not null`;
  const filters = filterSql(filter);

  // 1. Full-text matches, best ts_rank first, with their similarity when they have a vector.
  const textRows = await db.execute<HitDbRow>(sql`
    select ${fields}
    from cc_sessions s
    left join cc_session_embeddings e on ${joinCurrent}
    where ${tsv()} @@ ${tsq} and ${filters}
    order by ts_rank(${tsv()}, ${tsq}) desc, s.last_active_at desc nulls last, s.session_id desc
    limit ${BLEND.textCandidates}
  `);

  // 2. Nearest vectors (exclusions apply here too, as in note search).
  const excluded =
    q.excluded.length > 0
      ? sql`not (${tsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
      : sql`true`;
  const vectorRows = await db.execute<HitDbRow>(sql`
    select ${fields}
    from cc_sessions s
    join cc_session_embeddings e on ${joinCurrent}
    where ${filters} and ${excluded}
    order by e.embedding <=> ${qvec}
    limit ${BLEND.vectorCandidates}
  `);

  // 3. Sessions the query names by node id.
  const idRows =
    q.nodeIds.length > 0
      ? await db.execute<HitDbRow>(sql`
          select ${fields}
          from cc_sessions s
          left join cc_session_embeddings e on ${joinCurrent}
          where s.node_id in (${sql.join(
            q.nodeIds.map((id) => sql`${id}`),
            sql`, `,
          )}) and ${filters}
        `)
      : { rows: [] as HitDbRow[] };

  const byId = new Map<string, HitDbRow>();
  for (const r of [...textRows.rows, ...vectorRows.rows, ...idRows.rows]) {
    if (!byId.has(r.session_id)) byId.set(r.session_id, r);
  }
  return [...byId.values()];
}

/**
 * Hybrid search over cc_sessions: full-text rank on the generated tsvector, closeness in
 * meaning from cc_session_embeddings, the repo as a tag, recency of last activity, and an
 * exact node id, blended by src/search/blend.ts (same weights as note search). Falls back to
 * full text, with `fallback` saying why, without an embedder or when the query cannot be
 * embedded in time. The cursor is an offset into whichever ranking produced the page.
 */
export async function searchSessions(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter = {},
  opts: SessionSearchOptions = {},
): Promise<SessionSearchPage> {
  if (query.trim() === '') throw new NoteError('invalid_input', 'sessions search needs a non-empty query.');
  const offset = decodeCursor(filter.cursor);
  const limit = clampSessionLimit(filter.limit);
  // Validate dates before spending an embedding call.
  filterSql(filter);
  if (opts.mode === 'text') return textSearch(deps, query, filter, offset, limit);
  const embedder = deps.embedder;
  if (embedder === null) return textSearch(deps, query, filter, offset, limit, SESSIONS_SEMANTIC_OFF_FALLBACK);

  let vector: number[];
  try {
    vector = await embedQuery(
      embedder,
      deps.queryVectors ?? defaultQueryVectors,
      query,
      opts.queryTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS,
    );
  } catch (err) {
    return textSearch(deps, query, filter, offset, limit, sessionEmbedFailedFallback(err));
  }

  const terms = queryTerms(query);
  const nodeIds = findNodeIdCandidates(query.toUpperCase());
  const rows = await hybridCandidates(
    deps.db,
    { query, vector, model: embedder.model, nodeIds, excluded: terms.excluded },
    filter,
  );
  const epoch = new Date(0);
  const ranked = rankCandidates(
    rows.map((r) => ({
      id: r.session_id,
      textRank: toNumberOrNull(r.text_rank),
      similarity: toNumberOrNull(r.similarity),
      tagMatch: tagMatch(r.repo !== null ? [r.repo.toLowerCase()] : [], terms),
      updatedAt: toDate(r.last_active_at) ?? toDate(r.started_at) ?? epoch,
      exactId: nodeIds.includes(r.node_id),
      row: r,
    })),
    { now: opts.now ?? new Date() },
  );
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  return {
    sessions: ranked.slice(offset, end).map((c) => toHit(c.row, thisHost, c.score)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'hybrid',
  };
}
