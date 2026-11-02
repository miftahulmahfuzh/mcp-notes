import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, ne, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { appSettings, ccPendingSpawns, ccSessionEmbeddings, ccSessions } from '../db/schema.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings/constants.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import { clampError, retryDelayMs } from '../embeddings/state.js';
import { pgErrorInfo } from '../notes/imageRepo.js';
import { generateNodeId, normalizeNodeId } from './ids.js';
import { clip, earliest, mergeTranscriptPatch, normalizeCwd } from './merge.js';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  MAX_TITLE_CHARS,
  NODE_ID_ATTEMPTS,
  PARENT_LINK_RANK,
  PENDING_SPAWN_SKEW_MS,
  PENDING_SPAWN_WINDOW_MS,
  SELECTED_PROJECT_KEY,
  type HookStart,
  type HookStartResult,
  type ListByNameOptions,
  type ListForRepoOptions,
  type ParentLinkSource,
  type PendingSpawnInput,
  type PendingSpawnRow,
  type ProjectSummary,
  type SessionEmbeddingFailure,
  type SessionEmbeddingInput,
  type SessionListItem,
  type SessionRow,
  type SessionsRepoOptions,
  type SetParentResult,
  type SpawnClaim,
  type SpawnClaimResult,
  type SummaryInput,
  type TranscriptOffset,
  type TranscriptPatch,
  type TranscriptUpsertResult,
} from './types.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

/** Name of the unique index on cc_sessions.node_id; a 23505 on it means "pick another id". */
export const NODE_ID_UNIQUE_INDEX = 'cc_sessions_node_id_uniq';

/** Every cc_sessions column except the generated tsvector. */
function sessionColumns() {
  const { searchTsv, ...rest } = getTableColumns(ccSessions);
  void searchTsv;
  return rest;
}
const SESSION_COLUMNS = sessionColumns();

const LIST_COLUMNS = {
  sessionId: ccSessions.sessionId,
  nodeId: ccSessions.nodeId,
  host: ccSessions.host,
  repo: ccSessions.repo,
  cwd: ccSessions.cwd,
  branch: ccSessions.branch,
  name: ccSessions.name,
  customTitle: ccSessions.customTitle,
  aiTitle: ccSessions.aiTitle,
  firstPrompt: ccSessions.firstPrompt,
  entrypoint: ccSessions.entrypoint,
  startedAt: ccSessions.startedAt,
  lastActiveAt: ccSessions.lastActiveAt,
  inputTokens: ccSessions.inputTokens,
  outputTokens: ccSessions.outputTokens,
  cacheReadTokens: ccSessions.cacheReadTokens,
  cacheWriteTokens: ccSessions.cacheWriteTokens,
  costUsd: ccSessions.costUsd,
  parentSessionId: ccSessions.parentSessionId,
  parentLinkSource: ccSessions.parentLinkSource,
  tmux: ccSessions.tmux,
  transcriptPath: ccSessions.transcriptPath,
  summary: ccSessions.summary,
};

/** Terminal sessions, plus hook-created rows the ingester has not filled yet. */
const CLI_ONLY: SQL = sql`coalesce(${ccSessions.entrypoint}, 'cli') = 'cli'`;

/** Listing order key. */
const ORDER_AT: SQL = sql`coalesce(${ccSessions.startedAt}, ${ccSessions.createdAt})`;

/** `case parent_link_source ... end`: the stored link's rank, 0 when there is none. */
const STORED_RANK: SQL = sql`(case ${ccSessions.parentLinkSource} when 'env' then 3 when 'hook' then 2 when 'heuristic' then 1 else 0 end)`;

const MAX_SESSION_ID_CHARS = 128;

function assertSessionId(id: string, what = 'session id'): void {
  if (id.length === 0 || id.length > MAX_SESSION_ID_CHARS || /\s/.test(id)) {
    throw new TypeError(`invalid ${what}: ${JSON.stringify(id)}`);
  }
}

function assertHost(host: string): void {
  if (host.trim().length === 0) throw new TypeError('host must be non-empty');
}

function assertOffset(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer, got ${n}`);
}

function isNodeIdClash(err: unknown): boolean {
  const info = pgErrorInfo(err);
  if (!info || info.code !== '23505') return false;
  if (info.constraint !== undefined) return info.constraint === NODE_ID_UNIQUE_INDEX;
  return info.message.includes(NODE_ID_UNIQUE_INDEX);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIST_DEFAULT_LIMIT;
  return Math.min(LIST_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The only writer of `cc_sessions`, `cc_session_embeddings`, `cc_pending_spawns` and
 * `app_settings`. Ingest (Phase 3), the heuristic linker (Phase 4), the hook endpoints
 * (Phase 5), the summarizer (Phase 6) and the read API (Phase 7) all go through it.
 */
export class SessionsRepo {
  private readonly random: (max: number) => number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    opts: SessionsRepoOptions = {},
  ) {
    this.random = opts.random ?? randomInt;
    this.now = opts.now ?? (() => new Date());
  }

  // ---------- rows and node ids ----------

  /**
   * The session's row, inserting a minimal one (session id, node id, host) when missing. The
   * node id is drawn at random and redrawn on a clash with another row, NODE_ID_ATTEMPTS times.
   * An existing row keeps its node id and host.
   */
  async ensureSession(sessionId: string, host: string): Promise<SessionRow> {
    assertSessionId(sessionId);
    assertHost(host);
    for (let attempt = 0; attempt < NODE_ID_ATTEMPTS; attempt += 1) {
      const existing = await this.getBySessionId(sessionId);
      if (existing) return existing;
      try {
        const now = this.now();
        const inserted = await this.db
          .insert(ccSessions)
          .values({ sessionId, nodeId: generateNodeId(this.random), host, createdAt: now, updatedAt: now })
          .onConflictDoNothing({ target: ccSessions.sessionId })
          .returning(SESSION_COLUMNS);
        const row = inserted[0];
        if (row) return row;
        // Another writer inserted the same session id first: the next loop reads it.
      } catch (err) {
        if (!isNodeIdClash(err)) throw err;
      }
    }
    throw new Error(`could not find a free node id for session ${sessionId} after ${NODE_ID_ATTEMPTS} attempts`);
  }

  async getBySessionId(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.db.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, sessionId)).limit(1);
    return rows[0] ?? null;
  }

  /** Case-insensitive, dash optional. Null for input that is not a node id, or an id nobody has. */
  async getByNodeId(input: string): Promise<SessionRow | null> {
    const id = normalizeNodeId(input);
    if (id === null) return null;
    const rows = await this.db.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.nodeId, id)).limit(1);
    return rows[0] ?? null;
  }

  /** Rows for the ids that exist, in the order first requested; invalid and unknown ids are dropped. */
  async getManyByNodeIds(inputs: readonly string[]): Promise<SessionRow[]> {
    const ids = [...new Set(inputs.map((s) => normalizeNodeId(s)).filter((s): s is string => s !== null))];
    if (ids.length === 0) return [];
    const rows = await this.db.select(SESSION_COLUMNS).from(ccSessions).where(inArray(ccSessions.nodeId, ids));
    const byId = new Map(rows.map((r) => [r.nodeId, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  private async lock(tx: Tx, sessionId: string): Promise<SessionRow> {
    const rows = await tx.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, sessionId)).for('update');
    const row = rows[0];
    if (!row) throw new Error(`cc_sessions row ${sessionId} disappeared`);
    return row;
  }

  // ---------- transcript ingest (Phase 3) ----------

  /**
   * Applies one ingest pass. Compare-and-set on transcript_offset: see TranscriptPatch. Replaying
   * a patch is a no-op (`offset_mismatch`); the caller then resumes from `storedOffset`.
   */
  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    assertSessionId(patch.sessionId);
    assertHost(patch.host);
    assertOffset(patch.fromOffset, 'fromOffset');
    assertOffset(patch.toOffset, 'toOffset');
    assertOffset(patch.size, 'size');
    if (patch.toOffset < patch.fromOffset) throw new RangeError('toOffset is before fromOffset');
    await this.ensureSession(patch.sessionId, patch.host);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, patch.sessionId);
      if (row.host !== patch.host) {
        return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row } as const;
      }
      if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
        return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row } as const;
      }
      const set = mergeTranscriptPatch(row, patch);
      const updated = await tx
        .update(ccSessions)
        .set({ ...set, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, patch.sessionId))
        .returning(SESSION_COLUMNS);
      const next = updated[0];
      if (!next) throw new Error(`cc_sessions row ${patch.sessionId} disappeared`);
      return { applied: true, row: next } as const;
    });
  }

  /** session_id -> stored offset/size/path, for every row of `host`. The ingester's resume point. */
  async offsets(host: string): Promise<Map<string, TranscriptOffset>> {
    const rows = await this.db
      .select({
        sessionId: ccSessions.sessionId,
        offset: ccSessions.transcriptOffset,
        size: ccSessions.transcriptSize,
        path: ccSessions.transcriptPath,
      })
      .from(ccSessions)
      .where(eq(ccSessions.host, host));
    return new Map(rows.map((r) => [r.sessionId, { offset: r.offset, size: r.size, path: r.path }]));
  }

  // ---------- hooks (Phase 5) ----------

  /**
   * SessionStart: records what the hook knows, without clobbering better data (`name`/`tmux`
   * from the hook win over null; cwd/repo fill only when empty; started_at is the minimum),
   * and links the parent (default source 'env'). Both rows exist afterwards, so both node ids
   * can be returned to the session.
   */
  async upsertFromHook(start: HookStart): Promise<HookStartResult> {
    assertSessionId(start.sessionId);
    assertHost(start.host);
    const parentId = start.parentSessionId ?? null;
    if (parentId !== null) assertSessionId(parentId, 'parent session id');
    await this.ensureSession(start.sessionId, start.host);
    if (parentId !== null && parentId !== start.sessionId) await this.ensureSession(parentId, start.host);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, start.sessionId);
      const name = start.name ? clip(start.name, MAX_TITLE_CHARS) : null;
      await tx
        .update(ccSessions)
        .set({
          name: name ?? row.name,
          tmux: start.tmux ?? row.tmux,
          cwd: row.cwd ?? start.cwd ?? null,
          repo: row.repo ?? start.repo ?? null,
          startedAt: earliest(row.startedAt, start.startedAt ?? null),
          updatedAt: this.now(),
        })
        .where(eq(ccSessions.sessionId, start.sessionId));
      const parentLink =
        parentId === null ? null : await this.setParentIn(tx, start.sessionId, parentId, start.parentSource ?? 'env');
      const session = await this.lock(tx, start.sessionId);
      let parent: SessionRow | null = null;
      if (parentId !== null) {
        const rows = await tx.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, parentId)).limit(1);
        parent = rows[0] ?? null;
      }
      return { session, parent, parentLink };
    });
  }

  /** Bash PreToolUse: a `claude` launched in tmux by `parentSessionId`, not via swarm.py. */
  async recordPendingSpawn(input: PendingSpawnInput): Promise<PendingSpawnRow> {
    assertSessionId(input.parentSessionId, 'parent session id');
    assertHost(input.host);
    const cwd = normalizeCwd(input.cwd);
    if (cwd.length === 0) throw new TypeError('cwd must be non-empty');
    const rows = await this.db
      .insert(ccPendingSpawns)
      .values({
        parentSessionId: input.parentSessionId,
        host: input.host,
        cwd,
        name: input.name ?? null,
        createdAt: input.createdAt ?? this.now(),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('insert into cc_pending_spawns returned no row');
    return row;
  }

  /**
   * A child's SessionStart claims the newest matching unclaimed spawn (see the contract in the
   * Phase 1 plan) and, in the same transaction, links child -> parent with source 'hook'.
   * Null when nothing matches. A spawn is claimed at most once.
   */
  async claimPendingSpawn(claim: SpawnClaim): Promise<SpawnClaimResult | null> {
    assertSessionId(claim.childSessionId);
    assertHost(claim.host);
    const cwd = normalizeCwd(claim.cwd);
    const at = claim.at ?? this.now();
    const windowMs = claim.windowMs ?? PENDING_SPAWN_WINDOW_MS;
    const from = new Date(at.getTime() - windowMs);
    const to = new Date(at.getTime() + PENDING_SPAWN_SKEW_MS);
    const name = claim.name ?? null;
    await this.ensureSession(claim.childSessionId, claim.host);
    return this.db.transaction(async (tx) => {
      const conditions: SQL[] = [
        eq(ccPendingSpawns.host, claim.host),
        eq(ccPendingSpawns.cwd, cwd),
        isNull(ccPendingSpawns.claimedBy),
        gte(ccPendingSpawns.createdAt, from),
        lte(ccPendingSpawns.createdAt, to),
        ne(ccPendingSpawns.parentSessionId, claim.childSessionId),
      ];
      if (name !== null) conditions.push(sql`(${ccPendingSpawns.name} is null or ${ccPendingSpawns.name} = ${name})`);
      const order: SQL[] =
        name === null
          ? [desc(ccPendingSpawns.createdAt), desc(ccPendingSpawns.id)]
          : [
              sql`(case when ${ccPendingSpawns.name} = ${name} then 0 else 1 end)`,
              desc(ccPendingSpawns.createdAt),
              desc(ccPendingSpawns.id),
            ];
      const found = await tx
        .select()
        .from(ccPendingSpawns)
        .where(and(...conditions))
        .orderBy(...order)
        .limit(1)
        .for('update', { skipLocked: true });
      const spawn = found[0];
      if (!spawn) return null;
      const claimed = await tx
        .update(ccPendingSpawns)
        .set({ claimedBy: claim.childSessionId, claimedAt: this.now() })
        .where(and(eq(ccPendingSpawns.id, spawn.id), isNull(ccPendingSpawns.claimedBy)))
        .returning();
      const row = claimed[0];
      if (!row) return null;
      const parentLink = await this.setParentIn(tx, claim.childSessionId, row.parentSessionId, 'hook');
      return { spawn: row, parentLink };
    });
  }

  /** Deletes spawns (claimed or not) created before `before`. Returns how many. */
  async prunePendingSpawns(before: Date): Promise<number> {
    const rows = await this.db
      .delete(ccPendingSpawns)
      .where(lt(ccPendingSpawns.createdAt, before))
      .returning({ id: ccPendingSpawns.id });
    return rows.length;
  }

  // ---------- parent links (Phases 4, 5) ----------

  /**
   * Links child -> parent unless a better source already linked it (env > hook > heuristic;
   * equal rank overwrites). Refuses self-links and links that would close a cycle. The child
   * row must exist; the parent need not have been ingested.
   */
  async setParent(childSessionId: string, parentSessionId: string, source: ParentLinkSource): Promise<SetParentResult> {
    assertSessionId(childSessionId);
    assertSessionId(parentSessionId, 'parent session id');
    return this.setParentIn(this.db, childSessionId, parentSessionId, source);
  }

  private async setParentIn(
    ex: Executor,
    childSessionId: string,
    parentSessionId: string,
    source: ParentLinkSource,
  ): Promise<SetParentResult> {
    if (childSessionId === parentSessionId) return 'self';
    const cycle = await ex.execute<{ hit: number }>(sql`
      with recursive up(id, depth) as (
        select ${parentSessionId}::text, 0
        union all
        select s.parent_session_id, up.depth + 1
        from cc_sessions s join up on s.session_id = up.id
        where s.parent_session_id is not null and up.depth < 64
      )
      select 1 as hit from up where id = ${childSessionId} limit 1
    `);
    if (cycle.rows.length > 0) return 'cycle';
    const updated = await ex
      .update(ccSessions)
      .set({ parentSessionId, parentLinkSource: source, updatedAt: this.now() })
      .where(and(eq(ccSessions.sessionId, childSessionId), sql`${STORED_RANK} <= ${PARENT_LINK_RANK[source]}::int`))
      .returning({ id: ccSessions.sessionId });
    if (updated.length > 0) return 'set';
    const exists = await ex
      .select({ id: ccSessions.sessionId })
      .from(ccSessions)
      .where(eq(ccSessions.sessionId, childSessionId))
      .limit(1);
    return exists.length > 0 ? 'kept' : 'missing';
  }

  // ---------- listings (Phases 4, 7) ----------

  /** Direct children, oldest first. */
  async listChildren(parentSessionId: string): Promise<SessionListItem[]> {
    return this.db
      .select(LIST_COLUMNS)
      .from(ccSessions)
      .where(and(eq(ccSessions.parentSessionId, parentSessionId), CLI_ONLY))
      .orderBy(asc(ORDER_AT), asc(ccSessions.sessionId));
  }

  /** Sessions with exactly this name, oldest first, optionally within a time range / on one host. */
  async listByName(name: string, opts: ListByNameOptions = {}): Promise<SessionListItem[]> {
    const conditions: SQL[] = [eq(ccSessions.name, name), CLI_ONLY];
    if (opts.from) conditions.push(sql`${ORDER_AT} >= ${opts.from.toISOString()}::timestamptz`);
    if (opts.to) conditions.push(sql`${ORDER_AT} <= ${opts.to.toISOString()}::timestamptz`);
    if (opts.host !== undefined) conditions.push(eq(ccSessions.host, opts.host));
    return this.db
      .select(LIST_COLUMNS)
      .from(ccSessions)
      .where(and(...conditions))
      .orderBy(asc(ORDER_AT), asc(ccSessions.sessionId));
  }

  /** One entry per repo with at least one terminal session, most recently active first. */
  async listProjects(): Promise<ProjectSummary[]> {
    const lastActive = sql<Date>`max(coalesce(${ccSessions.lastActiveAt}, ${ccSessions.startedAt}, ${ccSessions.createdAt}))`.mapWith(
      ccSessions.createdAt,
    );
    const sessionCount = sql<number>`count(*)`.mapWith(Number);
    const hosts = sql<string[]>`array_agg(distinct ${ccSessions.host} order by ${ccSessions.host})`;
    const rows = await this.db
      .select({ repo: ccSessions.repo, sessionCount, lastActiveAt: lastActive, hosts })
      .from(ccSessions)
      .where(and(isNotNull(ccSessions.repo), CLI_ONLY))
      .groupBy(ccSessions.repo)
      .orderBy(desc(lastActive), asc(ccSessions.repo));
    return rows.flatMap((r) =>
      r.repo === null ? [] : [{ repo: r.repo, sessionCount: r.sessionCount, lastActiveAt: r.lastActiveAt, hosts: r.hosts }],
    );
  }

  /** A repo's sessions, newest first (coalesce(started_at, created_at) desc, session_id). */
  async listForRepo(repo: string, opts: ListForRepoOptions = {}): Promise<SessionListItem[]> {
    const conditions: SQL[] = [eq(ccSessions.repo, repo), CLI_ONLY];
    if (opts.before) conditions.push(sql`${ORDER_AT} < ${opts.before.toISOString()}::timestamptz`);
    return this.db
      .select(LIST_COLUMNS)
      .from(ccSessions)
      .where(and(...conditions))
      .orderBy(desc(ORDER_AT), asc(ccSessions.sessionId))
      .limit(clampLimit(opts.limit));
  }

  // ---------- summaries and embeddings (Phase 6) ----------

  /** False when the session has no row. */
  async setSummary(sessionId: string, input: SummaryInput): Promise<boolean> {
    const at = input.at ?? this.now();
    const rows = await this.db
      .update(ccSessions)
      .set({ summary: input.summary, summarySha: input.sha, summarizedAt: at, updatedAt: this.now() })
      .where(eq(ccSessions.sessionId, sessionId))
      .returning({ id: ccSessions.sessionId });
    return rows.length > 0;
  }

  /** Stores a vector (clearing any failure). False when the session has no row. */
  async saveEmbedding(sessionId: string, input: SessionEmbeddingInput): Promise<boolean> {
    if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding has ${input.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
    }
    const literal = toVectorLiteral(input.embedding);
    const res = await this.db.execute<{ session_id: string }>(sql`
      insert into cc_session_embeddings
        (session_id, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, created_at, updated_at)
      select cc_sessions.session_id, ${literal}::vector, ${input.sha}, ${input.model}, 0, null, null, now(), now(), now()
      from cc_sessions
      where cc_sessions.session_id = ${sessionId}
      on conflict (session_id) do update set
        embedding = excluded.embedding,
        sha = excluded.sha,
        model = excluded.model,
        attempts = 0,
        last_error = null,
        next_attempt_at = null,
        embedded_at = excluded.embedded_at,
        updated_at = excluded.updated_at
      returning session_id
    `);
    return res.rows.length > 0;
  }

  /**
   * Records a failed attempt for `sha` + `model` with backoff (src/embeddings/state.ts
   * retryDelayMs). A row already holding a vector for the same sha + model is left alone.
   */
  async recordEmbeddingFailure(sessionId: string, input: SessionEmbeddingFailure): Promise<void> {
    const prev = await this.db
      .select({
        sha: ccSessionEmbeddings.sha,
        model: ccSessionEmbeddings.model,
        attempts: ccSessionEmbeddings.attempts,
        hasVector: sql<boolean>`${ccSessionEmbeddings.embedding} is not null`,
      })
      .from(ccSessionEmbeddings)
      .where(eq(ccSessionEmbeddings.sessionId, sessionId))
      .limit(1);
    const row = prev[0];
    const sameTarget = row !== undefined && row.sha === input.sha && row.model === input.model;
    if (sameTarget && row.hasVector) return;
    const attempts = sameTarget ? row.attempts + 1 : 1;
    const delayMs = retryDelayMs(attempts);
    await this.db.execute(sql`
      insert into cc_session_embeddings
        (session_id, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, created_at, updated_at)
      select cc_sessions.session_id, null, ${input.sha}, ${input.model}, ${attempts}::integer, ${clampError(input.error)},
             now() + ${delayMs}::integer * interval '1 millisecond', null, now(), now()
      from cc_sessions
      where cc_sessions.session_id = ${sessionId}
      on conflict (session_id) do update set
        embedding = null,
        sha = excluded.sha,
        model = excluded.model,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        next_attempt_at = excluded.next_attempt_at,
        embedded_at = null,
        updated_at = excluded.updated_at
    `);
  }

  // ---------- settings (Phase 7) ----------

  /** The stored JSON value, or null when the key is unset. */
  async getSetting(key: string): Promise<unknown | null> {
    const rows = await this.db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
    const row = rows[0];
    return row === undefined ? null : row.value;
  }

  /** Stores any JSON value; null or undefined deletes the key. */
  async putSetting(key: string, value: unknown): Promise<void> {
    if (key.length === 0) throw new TypeError('setting key must be non-empty');
    if (value === null || value === undefined) {
      await this.db.delete(appSettings).where(eq(appSettings.key, key));
      return;
    }
    const now = this.now();
    await this.db
      .insert(appSettings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  }

  /** The repo selected in the wall's project sidebar, shared by both machines. */
  async getSelectedProject(): Promise<string | null> {
    const value = await this.getSetting(SELECTED_PROJECT_KEY);
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  async setSelectedProject(repo: string | null): Promise<void> {
    await this.putSetting(SELECTED_PROJECT_KEY, repo === null || repo.length === 0 ? null : repo);
  }
}
