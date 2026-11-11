import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Embedder } from '../embeddings/embedder.js';
import { noteEmbeddings, notes } from '../db/schema.js';
import { isCurrentEmbeddingSql, toVectorLiteral } from '../embeddings/repo.js';
import { parseDateBound } from '../notes/dates.js';
import { decodeCursor, encodeCursor } from '../notes/repo.js';
import { NoteError, type SearchMode } from '../notes/types.js';
import { BLEND, queryTerms, rankCandidates, tagMatch, type BlendTuning, type RelatedSignals } from '../search/blend.js';
import { QUERY_EMBED_TIMEOUT_MS, QueryVectorCache, embedQuery } from '../search/queryVector.js';
import { findNodeIdCandidates } from './ids.js';
import { isCurrentReplyEmbeddingSql } from './replyEmbeddings.js';
import { NOTE_EXCERPT_CHARS, REPLY_EXCERPT_CHARS, excerpt, linkSource, type ParentLinkSource, type SearchReplyMatch } from './view.js';

export const SESSION_SEARCH_DEFAULT_LIMIT = 20;
export const SESSION_SEARCH_MAX_LIMIT = 200;
/** Phase 1's generated tsvector column on cc_sessions (name, titles, prompts, summary; 'simple'). */
export const SESSION_TSV_COLUMN = 'search_tsv';
/** first_prompt is cut to this many characters in hits. */
const HIT_PROMPT_CHARS = 500;
/** At most this many matching notes are listed in a hit's via_notes. */
export const VIA_NOTES_MAX = 3;
/** At most this many matching replies are listed in a hit's via_replies. */
export const VIA_REPLIES_MAX = 3;
/** ts_headline options for a reply excerpt: one plain fragment around the match (the reply's start when none). */
const REPLY_HEADLINE_OPTIONS = 'MaxWords=45, MinWords=20, StartSel="", StopSel="", MaxFragments=1';

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
  /** Weights to rank with. Default BLEND; tests/integration/sessions.relatedEvidence.int.test.ts sweeps `related`. */
  tuning?: BlendTuning;
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
  parent_link_source: ParentLinkSource | null;
  /**
   * Notes saved from (origin.claude_session) or linked to this session that matched the query,
   * best first, at most VIA_NOTES_MAX. Empty when the session matched on its own text only.
   */
  via_notes: SessionNoteMatch[];
  /**
   * Claude's replies in this session that matched the query, best first, at most VIA_REPLIES_MAX:
   * `seq` is the number of the prompt the reply answered, `excerpt` the passage around the match.
   * Empty when no reply matched.
   */
  via_replies: SearchReplyMatch[];
  /** Ranking score: the blended score in hybrid mode, ts_rank in text mode (phase 7 rounds and returns it). */
  score: number;
}

/** A note of the session that matched the query. */
export interface SessionNoteMatch {
  id: string;
  excerpt: string;
}

export interface SessionSearchPage {
  sessions: SessionSearchHit[];
  next_cursor: string | null;
  /** The ranking actually used. */
  mode: SearchMode;
  /** Present only when hybrid was asked for but could not run. */
  fallback?: string;
}

// ---------------------------------------------------------------------------------------------
// Candidate sources and their merge.
//
// A search gathers candidates from a list of sources. An OWN source (session text, session
// vector, node id) returns cc_sessions rows carrying the session's own signals. A RELATED source
// (notes, replies) returns, per session, the best text rank and similarity among
// that session's matching items plus the items themselves. mergeCandidates folds them into one
// candidate per session that takes the best value of each signal and remembers which kind of
// evidence gave it. Adding context to search = writing one source and listing it below.
// ---------------------------------------------------------------------------------------------

/** Where a signal came from: the session's own text/vector, or one kind of related item. */
export type EvidenceKind = 'own' | 'note' | 'reply';
/** The related item kinds: every evidence kind except the session's own. */
export type RelatedKind = Exclude<EvidenceKind, 'own'>;

/** A signal's value and the evidence that produced it. */
export interface Signal {
  value: number;
  from: EvidenceKind;
}

/** A cc_sessions row as the database returns it: hit fields plus the session's own signals. */
type SessionDbRow = {
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

/** A session candidate's row with its own signals as numbers. */
export type SessionRow = Omit<SessionDbRow, 'text_rank' | 'similarity'> & {
  /** ts_rank of the session's own search_tsv; null when its own text does not match. */
  text_rank: number | null;
  /** Cosine similarity of the session's own current vector; null without one, always null in text mode. */
  similarity: number | null;
};

/** One related source's per-session row as the database returns it. */
export type RelatedDbRow = {
  session_id: string;
  text_rank: number | string | null;
  similarity: number | string | null;
  /** jsonb array of the session's matching items, best first. */
  items: unknown;
};

/** One kind of related item's best evidence for one session. */
export interface RelatedEvidence {
  kind: RelatedKind;
  session_id: string;
  /** Best ts_rank among the session's matching items of this kind; null when none matched by words. */
  text_rank: number | null;
  /** Best cosine similarity among them; null when none has a current vector (or text mode). */
  similarity: number | null;
  /** The matching items, best first, as the source's jsonb array; toHit maps them to via_*. */
  items: unknown;
}

/** One session after the merge. */
export interface MergedCandidate {
  row: SessionRow;
  /** Best full-text rank over own and related evidence; null when nothing matched by words. */
  text: Signal | null;
  /** Best similarity over own and related evidence; null when nothing has a current vector. */
  similarity: Signal | null;
  /** Each related kind's evidence for this session, when that kind matched. */
  related: Partial<Record<RelatedKind, RelatedEvidence>>;
}

export type SourceRows = { kind: 'own'; rows: SessionRow[] } | { kind: 'related'; rows: RelatedEvidence[] };

/** The query vector and the embedding model it belongs to. */
export interface QueryVector {
  /** `'[...]'::vector` literal. */
  qvec: SQL;
  model: string;
}

/** Everything a source needs to know about one search. */
export interface SourceQuery {
  /** websearch_to_tsquery('simple', query). */
  tsq: SQL;
  /** Null in text mode: sources then run their full-text part only and report no similarity. */
  vector: QueryVector | null;
  /** Node ids named in the query (hybrid only; empty in text mode). */
  nodeIds: readonly string[];
  /** Websearch exclusions, applied to vector candidates (hybrid only; empty in text mode). */
  excluded: readonly string[];
  filter: SessionSearchFilter;
  /** Rows per full-text source; null = every match (text mode is exhaustive). */
  textLimit: number | null;
}

export interface CandidateSource {
  /** Stable name for tests and logs. */
  name: string;
  run(db: Db, q: SourceQuery): Promise<SourceRows>;
}

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

function toSessionRow(r: SessionDbRow): SessionRow {
  return { ...r, text_rank: toNumberOrNull(r.text_rank), similarity: toNumberOrNull(r.similarity) };
}

/** The boundary for related sources: database rows -> typed evidence of one kind. */
export function relatedSourceRows(kind: RelatedKind, rows: readonly RelatedDbRow[]): SourceRows {
  return {
    kind: 'related',
    rows: rows.map((r) => ({
      kind,
      session_id: r.session_id,
      text_rank: toNumberOrNull(r.text_rank),
      similarity: toNumberOrNull(r.similarity),
      items: r.items,
    })),
  };
}

/** `e.*` is the session's current embedding for the query's model. */
function currentEmbeddingOn(v: QueryVector): SQL {
  return sql`e.session_id = s.session_id and e.model = ${v.model} and e.embedding is not null`;
}

/** The left join that gives own rows their similarity; nothing in text mode. */
function ownEmbeddingJoin(q: SourceQuery): SQL {
  return q.vector === null ? sql.empty() : sql`left join cc_session_embeddings e on ${currentEmbeddingOn(q.vector)}`;
}

/** Hit fields plus the session's own text rank and similarity. Every own source selects exactly this. */
function ownFields(q: SourceQuery): SQL {
  const similarity = q.vector === null ? sql`null::float8` : sql`(1 - (e.embedding <=> ${q.vector.qvec}))::float8`;
  return sql`${hitFields()},
    (case when ${tsv()} @@ ${q.tsq} then ts_rank(${tsv()}, ${q.tsq}) end)::float8 as text_rank,
    ${similarity} as similarity`;
}

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** Sessions whose own search_tsv matches, best ts_rank first (at most textLimit). */
export const sessionTextSource: CandidateSource = {
  name: 'session_text',
  async run(db, q) {
    const limit = q.textLimit === null ? sql.empty() : sql`limit ${q.textLimit}`;
    const res = await db.execute<SessionDbRow>(sql`
      select ${ownFields(q)}
      from cc_sessions s
      ${ownEmbeddingJoin(q)}
      where ${tsv()} @@ ${q.tsq} and ${filterSql(q.filter)}
      order by ts_rank(${tsv()}, ${q.tsq}) desc, s.last_active_at desc nulls last, s.session_id desc
      ${limit}
    `);
    return { kind: 'own', rows: res.rows.map(toSessionRow) };
  },
};

/** The sessions nearest the query vector (exclusions apply here too, as in note search). Hybrid only. */
export const sessionVectorSource: CandidateSource = {
  name: 'session_vector',
  async run(db, q) {
    if (q.vector === null) return { kind: 'own', rows: [] };
    const excluded =
      q.excluded.length > 0
        ? sql`not (${tsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
        : sql`true`;
    const res = await db.execute<SessionDbRow>(sql`
      select ${ownFields(q)}
      from cc_sessions s
      join cc_session_embeddings e on ${currentEmbeddingOn(q.vector)}
      where ${filterSql(q.filter)} and ${excluded}
      order by e.embedding <=> ${q.vector.qvec}
      limit ${BLEND.vectorCandidates}
    `);
    return { kind: 'own', rows: res.rows.map(toSessionRow) };
  },
};

/** Sessions the query names by node id. */
export const nodeIdSource: CandidateSource = {
  name: 'node_id',
  async run(db, q) {
    if (q.nodeIds.length === 0) return { kind: 'own', rows: [] };
    const res = await db.execute<SessionDbRow>(sql`
      select ${ownFields(q)}
      from cc_sessions s
      ${ownEmbeddingJoin(q)}
      where s.node_id in (${idList(q.nodeIds)}) and ${filterSql(q.filter)}
    `);
    return { kind: 'own', rows: res.rows.map(toSessionRow) };
  },
};

/** Live notes that belong to a session: saved from it, or linked to it with link_note. */
function noteHasSessionSql(): SQL {
  return sql`(${notes.origin} ->> 'claude_session' is not null
    or exists (select 1 from note_session_links l where l.note_id = ${notes.id}))`;
}

/**
 * `matched(note_id, body, text_rank, similarity)` -> per session of `filter`:
 * `(session_id, text_rank, similarity, items)`, the best of its matching notes. A note counts
 * for every session it was saved from or is linked to (each session once per note).
 */
function sessionsOfNotesSql(matched: SQL, filter: SessionSearchFilter): SQL {
  return sql`
    with matched as (${matched}),
    owners as (
      select m.note_id, n.origin ->> 'claude_session' as session_id
      from matched m join notes n on n.id = m.note_id
      where n.origin ->> 'claude_session' is not null
      union
      select l.note_id, l.session_id from note_session_links l where l.note_id in (select note_id from matched)
    )
    select s.session_id,
      max(m.text_rank)::float8 as text_rank,
      max(m.similarity)::float8 as similarity,
      jsonb_agg(jsonb_build_object('id', m.note_id, 'body', left(m.body, ${NOTE_EXCERPT_CHARS * 2}))
        order by m.text_rank desc nulls last, m.similarity desc nulls last, m.note_id) as items
    from matched m
    join owners o on o.note_id = m.note_id
    join cc_sessions s on s.session_id = o.session_id
    where ${filterSql(filter)}
    group by s.session_id
  `;
}

function noteTsv(): SQL {
  return sql`to_tsvector('simple', ${notes.body})`;
}

/** Text mode: every live session note that matches by words. */
function notesTextOnlySql(q: SourceQuery): SQL {
  return sql`select ${notes.id} as note_id, ${notes.body} as body, ts_rank(${noteTsv()}, ${q.tsq}) as text_rank, null::float8 as similarity
    from ${notes}
    where ${notes.deletedAt} is null and ${noteTsv()} @@ ${q.tsq} and ${noteHasSessionSql()}`;
}

/** Hybrid: the best word matches (at most textLimit) and the nearest notes, session notes only. */
function notesHybridSql(q: SourceQuery, v: QueryVector): SQL {
  const noteVec = sql`(${noteEmbeddings.embedding} <=> ${v.qvec})`;
  const noteJoin = sql`${noteEmbeddings.noteId} = ${notes.id} and ${isCurrentEmbeddingSql(v.model)}`;
  const noteFields = sql`${notes.id} as note_id, ${notes.body} as body,
    (case when ${noteTsv()} @@ ${q.tsq} then ts_rank(${noteTsv()}, ${q.tsq}) end)::float8 as text_rank,
    (1 - ${noteVec})::float8 as similarity`;
  const noteExcluded =
    q.excluded.length > 0
      ? sql`not (${noteTsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
      : sql`true`;
  const textLimit = q.textLimit === null ? sql.empty() : sql`limit ${q.textLimit}`;
  return sql`(select ${noteFields} from ${notes} left join ${noteEmbeddings} on ${noteJoin}
      where ${notes.deletedAt} is null and ${noteTsv()} @@ ${q.tsq} and ${noteHasSessionSql()}
      order by ts_rank(${noteTsv()}, ${q.tsq}) desc
      ${textLimit})
    union
    (select ${noteFields} from ${notes} join ${noteEmbeddings} on ${noteJoin}
      where ${notes.deletedAt} is null and ${noteHasSessionSql()} and ${noteExcluded}
      order by ${noteVec}
      limit ${BLEND.vectorCandidates})`;
}

/** Sessions whose notes (saved from them or linked to them) match, by words or meaning. */
export const notesSource: CandidateSource = {
  name: 'notes',
  async run(db, q) {
    const matched = q.vector === null ? notesTextOnlySql(q) : notesHybridSql(q, q.vector);
    const res = await db.execute<RelatedDbRow>(sessionsOfNotesSql(matched, q.filter));
    return relatedSourceRows('note', res.rows);
  },
};

/** A reply's generated 'simple' tsvector (migration 0014). Tables stay unaliased: isCurrentReplyEmbeddingSql names them. */
function replyTsv(): SQL {
  return sql.raw('cc_session_replies.search_tsv');
}

/** Replies joined to their session as `s`, so filterSql applies. */
function repliesOfSessions(): SQL {
  return sql.raw('cc_session_replies join cc_sessions s on s.session_id = cc_session_replies.session_id');
}

/** The reply's embedding row, when it holds a vector made from the reply's current text by `v.model`. */
function replyEmbeddingOn(v: QueryVector): SQL {
  return sql`cc_session_reply_embeddings.session_id = cc_session_replies.session_id
    and cc_session_reply_embeddings.seq = cc_session_replies.seq
    and ${isCurrentReplyEmbeddingSql(v.model)}`;
}

/**
 * `matched(session_id, seq, text_rank, similarity)` -> per session: `(session_id, text_rank,
 * similarity, items)`, the best of its matching replies, with `items` = jsonb `[{ seq }]` best
 * first. Reply text is not aggregated (a reply is up to 16k characters and up to 600 match):
 * toHit gets each shown reply's passage from replyExcerpts. `matched` has already applied the filter.
 */
function sessionsOfRepliesSql(matched: SQL): SQL {
  return sql`
    with matched as (${matched})
    select m.session_id,
      max(m.text_rank)::float8 as text_rank,
      max(m.similarity)::float8 as similarity,
      jsonb_agg(jsonb_build_object('seq', m.seq)
        order by m.text_rank desc nulls last, m.similarity desc nulls last, m.seq) as items
    from matched m
    group by m.session_id
  `;
}

/** Text mode: every reply of a filtered session that matches by words. */
function repliesTextOnlySql(q: SourceQuery): SQL {
  return sql`select cc_session_replies.session_id, cc_session_replies.seq,
      ts_rank(${replyTsv()}, ${q.tsq})::float8 as text_rank, null::float8 as similarity
    from ${repliesOfSessions()}
    where ${replyTsv()} @@ ${q.tsq} and ${filterSql(q.filter)}`;
}

/** Hybrid: the best word matches (at most textLimit) and the nearest current reply vectors, filtered sessions only. */
function repliesHybridSql(q: SourceQuery, v: QueryVector): SQL {
  const fields = sql`cc_session_replies.session_id, cc_session_replies.seq,
    (case when ${replyTsv()} @@ ${q.tsq} then ts_rank(${replyTsv()}, ${q.tsq}) end)::float8 as text_rank,
    (1 - (cc_session_reply_embeddings.embedding <=> ${v.qvec}))::float8 as similarity`;
  const excluded =
    q.excluded.length > 0
      ? sql`not (${replyTsv()} @@ websearch_to_tsquery('simple', ${q.excluded.join(' OR ')}))`
      : sql`true`;
  const textLimit = q.textLimit === null ? sql.empty() : sql`limit ${q.textLimit}`;
  return sql`(select ${fields}
      from ${repliesOfSessions()}
      left join cc_session_reply_embeddings on ${replyEmbeddingOn(v)}
      where ${replyTsv()} @@ ${q.tsq} and ${filterSql(q.filter)}
      order by ts_rank(${replyTsv()}, ${q.tsq}) desc, cc_session_replies.session_id, cc_session_replies.seq
      ${textLimit})
    union
    (select ${fields}
      from ${repliesOfSessions()}
      join cc_session_reply_embeddings on ${replyEmbeddingOn(v)}
      where ${filterSql(q.filter)} and ${excluded}
      order by cc_session_reply_embeddings.embedding <=> ${v.qvec}
      limit ${BLEND.vectorCandidates})`;
}

/**
 * Sessions whose replies (what Claude said after each turn's last tool call, cc_session_replies)
 * match, by words (the reply's own search_tsv) or meaning (its current vector). Read from the
 * shared database, so it works for both machines' sessions.
 */
export const repliesSource: CandidateSource = {
  name: 'replies',
  async run(db, q) {
    const matched = q.vector === null ? repliesTextOnlySql(q) : repliesHybridSql(q, q.vector);
    const res = await db.execute<RelatedDbRow>(sessionsOfRepliesSql(matched));
    return relatedSourceRows('reply', res.rows);
  },
};

/** Hybrid mode's sources, in the order their rows are merged. */
export const HYBRID_SOURCES: readonly CandidateSource[] = [
  sessionTextSource,
  sessionVectorSource,
  nodeIdSource,
  notesSource,
  repliesSource,
];
/** Text mode's sources: the full-text part of every source that has one. */
export const TEXT_SOURCES: readonly CandidateSource[] = [sessionTextSource, notesSource, repliesSource];

/**
 * The own row (signals included) of sessions only a related source found. No filterSql: the
 * related source has already applied the filter to these sessions.
 */
async function sessionRowsById(db: Db, q: SourceQuery, ids: readonly string[]): Promise<SessionRow[]> {
  if (ids.length === 0) return [];
  const res = await db.execute<SessionDbRow>(sql`
    select ${ownFields(q)}
    from cc_sessions s
    ${ownEmbeddingJoin(q)}
    where s.session_id in (${idList(ids)})
  `);
  return res.rows.map(toSessionRow);
}

/** `cur`, or a signal from `from` when `value` strictly beats it. */
function better(cur: Signal | null, value: number | null, from: RelatedKind): Signal | null {
  if (value === null) return cur;
  if (cur === null || value > cur.value) return { value, from };
  return cur;
}

/**
 * One candidate per session: the first own row of each session (every own source computes the
 * same own signals), then each related evidence row takes over a signal it strictly beats, so
 * the session's own evidence wins ties and earlier sources win ties among related kinds. A
 * related row whose session has no own row (gone between the source query and hydration) and a
 * second row of the same kind for one session (sources group by session, so none is produced)
 * are ignored. Pure: no I/O.
 */
export function mergeCandidates(own: readonly SessionRow[], related: readonly RelatedEvidence[]): MergedCandidate[] {
  const byId = new Map<string, MergedCandidate>();
  for (const row of own) {
    if (byId.has(row.session_id)) continue;
    byId.set(row.session_id, {
      row,
      text: row.text_rank === null ? null : { value: row.text_rank, from: 'own' },
      similarity: row.similarity === null ? null : { value: row.similarity, from: 'own' },
      related: {},
    });
  }
  for (const ev of related) {
    const c = byId.get(ev.session_id);
    if (c === undefined || c.related[ev.kind] !== undefined) continue;
    c.related[ev.kind] = ev;
    c.text = better(c.text, ev.text_rank, ev.kind);
    c.similarity = better(c.similarity, ev.similarity, ev.kind);
  }
  return [...byId.values()];
}

/** Runs `sources` in order, hydrates sessions only related evidence found, and merges. */
export async function collectCandidates(
  db: Db,
  q: SourceQuery,
  sources: readonly CandidateSource[],
): Promise<MergedCandidate[]> {
  const own: SessionRow[] = [];
  const related: RelatedEvidence[] = [];
  for (const source of sources) {
    const out = await source.run(db, q);
    if (out.kind === 'own') own.push(...out.rows);
    else related.push(...out.rows);
  }
  const known = new Set(own.map((r) => r.session_id));
  const missing = [...new Set(related.map((r) => r.session_id))].filter((id) => !known.has(id));
  own.push(...(await sessionRowsById(db, q, missing)));
  return mergeCandidates(own, related);
}

/**
 * Text mode's order: best text rank first, then most recently active (no activity last), then
 * session id descending. The same order the single SQL query used before the sources existed.
 */
export function compareTextRanked(a: MergedCandidate, b: MergedCandidate): number {
  const ra = a.text?.value ?? Number.NEGATIVE_INFINITY;
  const rb = b.text?.value ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb > ra ? 1 : -1;
  const ta = toDate(a.row.last_active_at)?.getTime() ?? null;
  const tb = toDate(b.row.last_active_at)?.getTime() ?? null;
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  const ia = a.row.session_id;
  const ib = b.row.session_id;
  return ia < ib ? 1 : ia > ib ? -1 : 0;
}

function toViaNotes(v: unknown): SessionNoteMatch[] {
  if (!Array.isArray(v)) return [];
  const out: SessionNoteMatch[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, body } = item as { id?: unknown; body?: unknown };
    if (typeof id !== 'string' || out.some((n) => n.id === id)) continue;
    out.push({ id, excerpt: excerpt(typeof body === 'string' ? body : '', NOTE_EXCERPT_CHARS) ?? '' });
    if (out.length === VIA_NOTES_MAX) break;
  }
  return out;
}

function replyKey(sessionId: string, seq: number): string {
  return `${sessionId}#${seq}`;
}

/** The reply seqs of a replies source's `items`, deduped, best first, at most VIA_REPLIES_MAX. */
function viaReplySeqs(items: unknown): number[] {
  if (!Array.isArray(items)) return [];
  const out: number[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const seq = (item as { seq?: unknown }).seq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || out.includes(seq)) continue;
    out.push(seq);
    if (out.length === VIA_REPLIES_MAX) break;
  }
  return out;
}

/**
 * The passage around the match of every reply the shown hits list, keyed by replyKey: one
 * ts_headline query per page, so only the replies a user sees are cut (not every matching one).
 */
async function replyExcerpts(db: Db, query: string, shown: readonly MergedCandidate[]): Promise<Map<string, string>> {
  const pairs = shown.flatMap((c) => viaReplySeqs(c.related.reply?.items).map((seq) => sql`(${c.row.session_id}, ${seq}::int)`));
  const out = new Map<string, string>();
  if (pairs.length === 0) return out;
  const res = await db.execute<{ session_id: string; seq: number | string; headline: string | null }>(sql`
    select cc_session_replies.session_id, cc_session_replies.seq,
      ts_headline('simple', cc_session_replies.text, websearch_to_tsquery('simple', ${query}), ${REPLY_HEADLINE_OPTIONS}) as headline
    from cc_session_replies
    where (cc_session_replies.session_id, cc_session_replies.seq) in (values ${sql.join(pairs, sql`, `)})
  `);
  for (const row of res.rows) {
    const text = excerpt(row.headline, REPLY_EXCERPT_CHARS);
    if (text !== null) out.set(replyKey(row.session_id, Number(row.seq)), text);
  }
  return out;
}

/** via_replies of one hit: its best seqs with their passages; a reply gone since the search is dropped. */
function toViaReplies(sessionId: string, items: unknown, excerpts: ReadonlyMap<string, string>): SearchReplyMatch[] {
  return viaReplySeqs(items).flatMap((seq) => {
    const text = excerpts.get(replyKey(sessionId, seq));
    return text === undefined ? [] : [{ seq, excerpt: text }];
  });
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** The best raw rank and similarity over every related kind of a candidate; undefined when it has none. */
function relatedSignals(c: MergedCandidate): RelatedSignals | undefined {
  let found = false;
  let textRank: number | null = null;
  let similarity: number | null = null;
  for (const ev of Object.values(c.related)) {
    if (ev === undefined) continue;
    found = true;
    textRank = maxOrNull(textRank, ev.text_rank);
    similarity = maxOrNull(similarity, ev.similarity);
  }
  return found ? { textRank, similarity } : undefined;
}

/**
 * Text mode's view of a candidate: its text signal is the better of its own rank and each
 * related kind's rank times `tuning.related` (blend.ts literalRank), so text mode weighs a
 * note's or reply's words the way hybrid does. compareTextRanked then orders it unchanged.
 */
function withWeightedText(c: MergedCandidate, tuning: BlendTuning): MergedCandidate {
  let text: Signal | null = c.row.text_rank === null ? null : { value: c.row.text_rank, from: 'own' };
  for (const ev of Object.values(c.related)) {
    if (ev === undefined || ev.text_rank === null) continue;
    const value = tuning.related * ev.text_rank;
    if (text === null || value > text.value) text = { value, from: ev.kind };
  }
  return { ...c, text };
}

function toHit(c: MergedCandidate, thisHost: string, score: number, replyExcerpts: ReadonlyMap<string, string>): SessionSearchHit {
  const r = c.row;
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
    parent_link_source: linkSource(r.parent_link_source),
    via_notes: toViaNotes(c.related.note?.items),
    via_replies: toViaReplies(r.session_id, c.related.reply?.items, replyExcerpts),
    score,
  };
}

function tsQuery(query: string): SQL {
  return sql`websearch_to_tsquery('simple', ${query})`;
}

async function textSearch(
  deps: SessionSearchDeps,
  query: string,
  filter: SessionSearchFilter,
  offset: number,
  limit: number,
  tuning: BlendTuning,
  fallback?: string,
): Promise<SessionSearchPage> {
  const q: SourceQuery = { tsq: tsQuery(query), vector: null, nodeIds: [], excluded: [], filter, textLimit: null };
  // A session ranks by the better of its own text rank and its related items' best, weighted by tuning.related.
  const ranked = (await collectCandidates(deps.db, q, TEXT_SOURCES)).map((c) => withWeightedText(c, tuning)).sort(compareTextRanked);
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  const shown = ranked.slice(offset, end);
  const excerpts = await replyExcerpts(deps.db, query, shown);
  const page: SessionSearchPage = {
    sessions: shown.map((c) => toHit(c, thisHost, c.text?.value ?? 0, excerpts)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'text',
  };
  if (fallback !== undefined) page.fallback = fallback;
  return page;
}

/**
 * Hybrid search over cc_sessions. Signals: full-text rank on the generated tsvector, closeness
 * in meaning from cc_session_embeddings, the repo as a tag, recency of last activity, and an
 * exact node id. Candidates come from HYBRID_SOURCES. The notes saved from or linked to a
 * session, and Claude's replies in it, count as related evidence: the session competes with the
 * better of its own signal and its related items' best times BLEND.related, per signal. Hits
 * list the notes in via_notes and the replies in via_replies. Everything is blended by
 * src/search/blend.ts. Falls back to full text (TEXT_SOURCES, same weighting), with `fallback`
 * saying why, when there is no embedder or the query cannot be embedded in time. The cursor is
 * an offset into whichever ranking produced the page.
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
  const tuning = opts.tuning ?? BLEND;
  // Validate dates before spending an embedding call.
  filterSql(filter);
  if (opts.mode === 'text') return textSearch(deps, query, filter, offset, limit, tuning);
  const embedder = deps.embedder;
  if (embedder === null) return textSearch(deps, query, filter, offset, limit, tuning, SESSIONS_SEMANTIC_OFF_FALLBACK);

  let vector: number[];
  try {
    vector = await embedQuery(
      embedder,
      deps.queryVectors ?? defaultQueryVectors,
      query,
      opts.queryTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS,
    );
  } catch (err) {
    return textSearch(deps, query, filter, offset, limit, tuning, sessionEmbedFailedFallback(err));
  }

  const terms = queryTerms(query);
  const nodeIds = findNodeIdCandidates(query.toUpperCase());
  const candidates = await collectCandidates(
    deps.db,
    {
      tsq: tsQuery(query),
      vector: { qvec: sql`${toVectorLiteral(vector)}::vector`, model: embedder.model },
      nodeIds,
      excluded: terms.excluded,
      filter,
      textLimit: BLEND.textCandidates,
    },
    HYBRID_SOURCES,
  );
  const epoch = new Date(0);
  // Own and related signals go to the blend separately: the weight decides which one wins.
  const ranked = rankCandidates(
    candidates.map((c) => ({
      id: c.row.session_id,
      textRank: c.row.text_rank,
      similarity: c.row.similarity,
      related: relatedSignals(c),
      tagMatch: tagMatch(c.row.repo !== null ? [c.row.repo.toLowerCase()] : [], terms),
      updatedAt: toDate(c.row.last_active_at) ?? toDate(c.row.started_at) ?? epoch,
      exactId: nodeIds.includes(c.row.node_id),
      candidate: c,
    })),
    { now: opts.now ?? new Date(), tuning },
  );
  const thisHost = deps.host ?? hostname();
  const end = offset + limit;
  const shown = ranked.slice(offset, end);
  const excerpts = await replyExcerpts(
    deps.db,
    query,
    shown.map((r) => r.candidate),
  );
  return {
    sessions: shown.map((r) => toHit(r.candidate, thisHost, r.score, excerpts)),
    next_cursor: ranked.length > end ? encodeCursor(end) : null,
    mode: 'hybrid',
  };
}
