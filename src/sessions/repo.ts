import { randomInt } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { ingestChatImage, type ChatImageStoreDeps } from '../chat/images.js';
import { appSettings, ccPendingSpawns, ccSessionEmbeddings, ccSessionPromptImages, ccSessionPrompts, ccSessionReplies, ccSessionReplyEmbeddings, ccSessions, ccSubagentTranscripts } from '../db/schema.js';
import { EMBEDDING_DIMENSIONS } from '../embeddings/constants.js';
import { toVectorLiteral } from '../embeddings/repo.js';
import { clampError, retryDelayMs } from '../embeddings/state.js';
import { pgErrorInfo } from '../notes/imageRepo.js';
import { generateNodeId, normalizeNodeId } from './ids.js';
import { currentReplySha256Sql } from './replyEmbeddings.js';
import {
  clip,
  earliest,
  latest,
  mergeCommits,
  mergeModels,
  mergeTranscriptPatch,
  nextLeadingReply,
  normalizeCwd,
  redactedPromptColumns,
  replacedPromptColumns,
  sameReply,
  storedLeadingReply,
  storedPrompts,
  storedPromptsFromExcerpts,
  storedReplies,
  subtractModels,
} from './merge.js';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  MAX_TITLE_CHARS,
  NODE_ID_ATTEMPTS,
  PARENT_LINK_RANK,
  PENDING_SPAWN_SKEW_MS,
  PENDING_SPAWN_WINDOW_MS,
  PROMPTS_VERSION,
  PROMPTS_VERSION_EXCERPTS,
  REPLIES_VERSION,
  SELECTED_PROJECT_KEY,
  type HookStart,
  type HookStartResult,
  type ListByNameOptions,
  type ListForRepoOptions,
  type ParentLinkSource,
  type PendingSpawnInput,
  type PendingSpawnRow,
  type ProjectSummary,
  type PromptImageLink,
  type PromptsBackfillCandidate,
  type PromptsReplacement,
  type RedactStoredPromptsResult,
  type ReplacePromptsResult,
  type ReplyContent,
  type SessionEmbeddingFailure,
  type SessionEmbeddingInput,
  type SessionListItem,
  type SessionRow,
  type SessionsRepoOptions,
  type SetParentResult,
  type SpawnClaim,
  type SpawnClaimResult,
  type StoredLeadingReply,
  type StoredPrompt,
  type StoredReply,
  type SubagentTotals,
  type SubagentTranscriptPatch,
  type SubagentUpsertResult,
  type SummaryInput,
  type SummaryRequest,
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

/** Rows and characters per insert into cc_session_prompts, so one statement stays small. */
const PROMPT_INSERT_ROWS = 200;
const PROMPT_INSERT_CHARS = 4 * 1024 * 1024;

/** Rows per insert into cc_session_replies; each is at most MAX_REPLY_STORE_CHARS, so a statement stays under ~3.2 MB. */
const REPLY_INSERT_ROWS = 200;

/** `prompts` in insert-sized groups, in order. */
function promptBatches(prompts: readonly StoredPrompt[]): StoredPrompt[][] {
  const batches: StoredPrompt[][] = [];
  let current: StoredPrompt[] = [];
  let chars = 0;
  for (const p of prompts) {
    if (current.length > 0 && (current.length >= PROMPT_INSERT_ROWS || chars + p.text.length > PROMPT_INSERT_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(p);
    chars += p.text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** A token delta as stored: a non-negative integer. */
function tokenCount(n: number | undefined): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

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
 * The only writer of `cc_sessions`, `cc_session_prompts`, `cc_session_replies`, `cc_subagent_transcripts`,
 * `cc_session_embeddings`, `cc_session_reply_embeddings`, `cc_pending_spawns` and `app_settings`.
 * Ingest, the heuristic linker, the hook endpoints, the summary worker, the reply embedding worker,
 * the Summarize request route and the read API all go through it; nothing else writes these tables.
 */
export class SessionsRepo {
  private readonly random: (max: number) => number;
  private readonly now: () => Date;
  private readonly imageDeps: ChatImageStoreDeps | null;

  constructor(
    private readonly db: Db,
    opts: SessionsRepoOptions = {},
  ) {
    this.random = opts.random ?? randomInt;
    this.now = opts.now ?? (() => new Date());
    this.imageDeps = opts.dataDir === undefined ? null : { db, dataDir: opts.dataDir, ...(opts.hostname ? { hostname: opts.hostname } : {}) };
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

  /** The row, locked until the transaction ends, or null when the session has no row. */
  private async lockIfExists(tx: Tx, sessionId: string): Promise<SessionRow | null> {
    const rows = await tx.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, sessionId)).for('update');
    return rows[0] ?? null;
  }

  /**
   * Stores each prompt's pasted images as `chat_images` (source `claude_code`, sha256-deduped), so
   * every image gets the same stable id a wall-chat image has. Runs before the write transaction:
   * `ingestChatImage` does its own file write and insert, and is cheap to redo if the transaction it
   * feeds is later discarded (an offset race, or a replayed patch finds nothing new to do). Returns
   * one array per `prompts` entry, aligned by index; a prompt with no images gets `[]`. No
   * `imageDeps` (a `SessionsRepo` not built for ingest): every prompt gets `[]`, images are dropped.
   * A single image that cannot be stored (corrupt bytes, over the chat image size cap) is skipped;
   * the rest of its prompt's images, and the prompt's text, are unaffected.
   */
  private async ingestPromptImages(prompts: readonly StoredPrompt[]): Promise<PromptImageLink[][]> {
    const deps = this.imageDeps;
    if (deps === null) return prompts.map(() => []);
    return Promise.all(
      prompts.map(async (p) => {
        if (p.images.length === 0) return [];
        const out: PromptImageLink[] = [];
        for (const img of p.images) {
          try {
            const { image } = await ingestChatImage(deps, { bytes: Buffer.from(img.dataBase64, 'base64'), originalName: null, source: 'claude_code' });
            out.push({ imageId: image.id, pasteId: img.pasteId });
          } catch {
            // Corrupt or oversized paste: drop this one image, keep the rest of the prompt.
          }
        }
        return out;
      }),
    );
  }

  /**
   * Writes a session's `cc_session_prompts` rows, their `cc_session_prompt_images` links and their
   * `cc_session_replies` rows. The caller holds the cc_sessions row lock, which every writer of a
   * session's prompt rows takes, so seq cannot race. `replace`: the rows become exactly `prompts`,
   * seq 1..n (their old images are dropped by the FK cascade; `images` relinks them, free of charge
   * when the same bytes dedupe), and the replies exactly `replies`. Otherwise `leading` is applied
   * to the reply of the highest stored seq, then `prompts` are appended after it. `images[i]` are
   * prompts[i]'s images; `replies[j].prompt` indexes `prompts`.
   */
  private async writePromptRows(
    tx: Tx,
    sessionId: string,
    prompts: readonly StoredPrompt[],
    images: readonly PromptImageLink[][],
    replies: readonly StoredReply[],
    leading: StoredLeadingReply | null,
    replace: boolean,
  ): Promise<void> {
    let next = 1;
    if (replace) {
      await tx.delete(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, sessionId));
    } else {
      if (prompts.length === 0 && leading === null) return;
      const top = await tx
        .select({ max: sql<number>`coalesce(max(${ccSessionPrompts.seq}), 0)`.mapWith(Number) })
        .from(ccSessionPrompts)
        .where(eq(ccSessionPrompts.sessionId, sessionId));
      next = (top[0]?.max ?? 0) + 1;
      if (leading !== null && next > 1) await this.writeLeadingReply(tx, sessionId, next - 1, leading);
    }
    const first = next;
    let index = 0;
    for (const batch of promptBatches(prompts)) {
      const values = batch.map((p, i) => ({ sessionId, seq: next + i, at: p.at, text: p.text, truncated: p.truncated }));
      await tx.insert(ccSessionPrompts).values(values);
      const imageValues = batch.flatMap((_, i) =>
        (images[index + i] ?? []).map((img, position) => ({ sessionId, promptSeq: next + i, position, imageId: img.imageId, pasteId: img.pasteId })),
      );
      if (imageValues.length > 0) await tx.insert(ccSessionPromptImages).values(imageValues);
      next += batch.length;
      index += batch.length;
    }
    await this.writeReplyRows(tx, sessionId, first, replies, replace);
  }

  /**
   * `cc_session_replies` for prompts written from seq `first`. Upserts by (session_id, seq) and
   * rewrites a row only when its content changed, so a from-byte-0 replace that finds the same
   * reply keeps the row and its `cc_session_reply_embeddings` row (which cascades only on delete).
   * `replace`: replies of every other seq of the session are deleted.
   */
  private async writeReplyRows(tx: Tx, sessionId: string, first: number, replies: readonly StoredReply[], replace: boolean): Promise<void> {
    const rows = replies.map((r) => ({ sessionId, seq: first + r.prompt, at: r.at, text: r.text, truncated: r.truncated }));
    if (replace) {
      const keep = rows.map((r) => r.seq);
      await tx
        .delete(ccSessionReplies)
        .where(
          keep.length === 0
            ? eq(ccSessionReplies.sessionId, sessionId)
            : and(eq(ccSessionReplies.sessionId, sessionId), notInArray(ccSessionReplies.seq, keep)),
        );
    }
    for (let i = 0; i < rows.length; i += REPLY_INSERT_ROWS) {
      await tx
        .insert(ccSessionReplies)
        .values(rows.slice(i, i + REPLY_INSERT_ROWS))
        .onConflictDoUpdate({
          target: [ccSessionReplies.sessionId, ccSessionReplies.seq],
          set: { at: sql`excluded.at`, text: sql`excluded.text`, truncated: sql`excluded.truncated` },
          setWhere: sql`${ccSessionReplies.text} is distinct from excluded.text or ${ccSessionReplies.truncated} is distinct from excluded.truncated or ${ccSessionReplies.at} is distinct from excluded.at`,
        });
    }
  }

  /** Applies a read's `leading` to the reply of prompt `seq`, the last one stored before the read. */
  private async writeLeadingReply(tx: Tx, sessionId: string, seq: number, leading: StoredLeadingReply): Promise<void> {
    const where = and(eq(ccSessionReplies.sessionId, sessionId), eq(ccSessionReplies.seq, seq));
    const found = await tx
      .select({ text: ccSessionReplies.text, at: ccSessionReplies.at, truncated: ccSessionReplies.truncated })
      .from(ccSessionReplies)
      .where(where);
    const stored: ReplyContent | null = found[0] ?? null;
    const next = nextLeadingReply(stored, leading);
    if (next === null) {
      if (stored !== null) await tx.delete(ccSessionReplies).where(where);
      return;
    }
    if (stored !== null && sameReply(stored, next)) return;
    await tx
      .insert(ccSessionReplies)
      .values({ sessionId, seq, at: next.at, text: next.text, truncated: next.truncated })
      .onConflictDoUpdate({
        target: [ccSessionReplies.sessionId, ccSessionReplies.seq],
        set: { at: next.at, text: next.text, truncated: next.truncated },
      });
  }

  // ---------- transcript ingest (Phase 3) ----------

  /**
   * Applies one ingest pass. Compare-and-set on transcript_offset: see TranscriptPatch. Replaying
   * a patch is a no-op (`offset_mismatch`); the caller then resumes from `storedOffset`.
   *
   * The pass's prompts go to `cc_session_prompts` in the same transaction, redacted: appended after
   * the highest seq, or replacing every row on fromOffset 0. Their replies go to
   * `cc_session_replies` in the same transaction, redacted and capped, keyed to the prompt's seq;
   * an appending pass first applies `leadingReply` to the reply of the last prompt stored before
   * it. Only a read from byte 0 has seen every prompt and reply, so only it marks the row
   * `prompts_version = PROMPTS_VERSION` and `replies_version = REPLIES_VERSION`. An append to a row
   * below PROMPTS_VERSION (0: written before full prompts existed; PROMPTS_VERSION_EXCERPTS:
   * rebuilt from excerpts) adds its prompts but leaves the versions, so the prompts backfill still
   * replaces that row's side rows whole.
   */
  async upsertFromTranscript(patch: TranscriptPatch): Promise<TranscriptUpsertResult> {
    assertSessionId(patch.sessionId);
    assertHost(patch.host);
    assertOffset(patch.fromOffset, 'fromOffset');
    assertOffset(patch.toOffset, 'toOffset');
    assertOffset(patch.size, 'size');
    if (patch.toOffset < patch.fromOffset) throw new RangeError('toOffset is before fromOffset');
    await this.ensureSession(patch.sessionId, patch.host);
    const prompts = storedPrompts(patch.prompts);
    const replies = storedReplies(patch.prompts, patch.replies);
    const leading = patch.fromOffset === 0 ? null : storedLeadingReply(patch.leadingReply);
    const promptImages = await this.ingestPromptImages(prompts);
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, patch.sessionId);
      if (row.host !== patch.host) {
        return { applied: false, reason: 'other_host', storedOffset: row.transcriptOffset, row } as const;
      }
      if (patch.fromOffset !== 0 && row.transcriptOffset !== patch.fromOffset) {
        return { applied: false, reason: 'offset_mismatch', storedOffset: row.transcriptOffset, row } as const;
      }
      const reset = patch.fromOffset === 0;
      const set = mergeTranscriptPatch(row, patch, reset ? await this.subagentTotals(tx, patch.sessionId) : null);
      await this.writePromptRows(tx, patch.sessionId, prompts, promptImages, replies, leading, reset);
      const now = this.now();
      const updated = await tx
        .update(ccSessions)
        .set(
          reset
            ? { ...set, promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION, updatedAt: now }
            : { ...set, updatedAt: now },
        )
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

  // ---------- full prompts (and replies) backfill ----------

  /**
   * Rows of `host` below PROMPTS_VERSION or below REPLIES_VERSION, most recently active first:
   * legacy rows (0), rows redacted in place from excerpts (PROMPTS_VERSION_EXCERPTS), which upgrade
   * if their transcript is readable again, and rows ingested before replies were stored.
   */
  async promptsBackfillCandidates(host: string): Promise<PromptsBackfillCandidate[]> {
    assertHost(host);
    return this.db
      .select({
        sessionId: ccSessions.sessionId,
        transcriptPath: ccSessions.transcriptPath,
        transcriptOffset: ccSessions.transcriptOffset,
        promptsVersion: ccSessions.promptsVersion,
      })
      .from(ccSessions)
      .where(and(eq(ccSessions.host, host), or(lt(ccSessions.promptsVersion, PROMPTS_VERSION), lt(ccSessions.repliesVersion, REPLIES_VERSION))))
      .orderBy(desc(sql`coalesce(${ccSessions.lastActiveAt}, ${ccSessions.createdAt})`), asc(ccSessions.sessionId));
  }

  /**
   * Replaces a session's prompts and replies with those of its transcript re-read from byte 0 to
   * `upToOffset`. Compare-and-set on transcript_offset and host, under the row lock. Writes
   * `cc_session_prompts` (redacted, seq 1..n), `cc_session_replies` (redacted, capped, unchanged
   * rows kept), the excerpt list, first_prompt, last_prompt, prompts_version, replies_version and
   * updated_at, and no other column.
   */
  async replacePrompts(sessionId: string, host: string, input: PromptsReplacement): Promise<ReplacePromptsResult> {
    assertSessionId(sessionId);
    assertHost(host);
    assertOffset(input.upToOffset, 'upToOffset');
    const prompts = storedPrompts(input.prompts);
    const replies = storedReplies(input.prompts, input.replies);
    const promptImages = await this.ingestPromptImages(prompts);
    return this.db.transaction(async (tx): Promise<ReplacePromptsResult> => {
      const row = await this.lockIfExists(tx, sessionId);
      if (row === null) return { status: 'missing' };
      if (row.host !== host) return { status: 'other_host' };
      if (row.transcriptOffset !== input.upToOffset) return { status: 'offset_mismatch', storedOffset: row.transcriptOffset };
      await this.writePromptRows(tx, sessionId, prompts, promptImages, replies, null, true);
      await tx
        .update(ccSessions)
        .set({ ...replacedPromptColumns(row, input), promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, sessionId));
      return { status: 'applied' };
    });
  }

  /**
   * For a row of `host` whose transcript is gone: redacts the stored excerpts, first_prompt and
   * last_prompt in place, rebuilds `cc_session_prompts` from the redacted excerpts (the full text
   * cannot be recovered; `truncated` where an excerpt ends in `…`), deletes the session's replies
   * (their seqs pointed at the old prompt rows, and a pruned transcript keeps none), and marks the
   * row PROMPTS_VERSION_EXCERPTS, never PROMPTS_VERSION: the list is not complete. replies_version
   * is left as it was. Same columns as replacePrompts. A row already at PROMPTS_VERSION_EXCERPTS or
   * above is left alone ('current'), so a pruned transcript costs one locked read per daemon start,
   * not a rewrite.
   */
  async redactStoredPrompts(sessionId: string, host: string): Promise<RedactStoredPromptsResult> {
    assertSessionId(sessionId);
    assertHost(host);
    return this.db.transaction(async (tx): Promise<RedactStoredPromptsResult> => {
      const row = await this.lockIfExists(tx, sessionId);
      if (row === null) return 'missing';
      if (row.host !== host) return 'other_host';
      if (row.promptsVersion >= PROMPTS_VERSION_EXCERPTS) return 'current';
      const prompts = storedPromptsFromExcerpts(row.prompts);
      await this.writePromptRows(
        tx,
        sessionId,
        prompts,
        prompts.map(() => []),
        [],
        null,
        true,
      );
      await tx
        .update(ccSessions)
        .set({ ...redactedPromptColumns(row), promptsVersion: PROMPTS_VERSION_EXCERPTS, updatedAt: this.now() })
        .where(eq(ccSessions.sessionId, sessionId));
      return 'applied';
    });
  }

  /** What the session's subagent transcripts add up to (zeros and no commits when it has none). */
  private async subagentTotals(tx: Tx, sessionId: string): Promise<SubagentTotals> {
    const rows = await tx
      .select({
        inputTokens: ccSubagentTranscripts.inputTokens,
        outputTokens: ccSubagentTranscripts.outputTokens,
        cacheReadTokens: ccSubagentTranscripts.cacheReadTokens,
        cacheWriteTokens: ccSubagentTranscripts.cacheWriteTokens,
        models: ccSubagentTranscripts.models,
        commits: ccSubagentTranscripts.commits,
      })
      .from(ccSubagentTranscripts)
      .where(eq(ccSubagentTranscripts.sessionId, sessionId));
    const totals: SubagentTotals = {
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      models: {},
      commits: [],
    };
    for (const r of rows) {
      totals.tokens.inputTokens += r.inputTokens;
      totals.tokens.outputTokens += r.outputTokens;
      totals.tokens.cacheReadTokens += r.cacheReadTokens;
      totals.tokens.cacheWriteTokens += r.cacheWriteTokens;
      totals.models = mergeModels(totals.models, r.models, false);
      totals.commits = mergeCommits(totals.commits, r.commits, false);
    }
    return totals;
  }

  /**
   * Applies one read of a subagent transcript: compare-and-set on the subagent row's offset, then
   * the delta goes onto the subagent row and onto the parent session's totals, in one transaction
   * under the parent's row lock (the same lock the main transcript's writes take). A read from byte
   * 0 first takes the subagent row's old values back out of the parent. Commits are only ever added.
   */
  async upsertFromSubagentTranscript(patch: SubagentTranscriptPatch): Promise<SubagentUpsertResult> {
    assertSessionId(patch.sessionId);
    assertSessionId(patch.agentId, 'agent id');
    assertHost(patch.host);
    assertOffset(patch.fromOffset, 'fromOffset');
    assertOffset(patch.toOffset, 'toOffset');
    assertOffset(patch.size, 'size');
    if (patch.toOffset < patch.fromOffset) throw new RangeError('toOffset is before fromOffset');
    return this.db.transaction(async (tx) => {
      const parents = await tx.select(SESSION_COLUMNS).from(ccSessions).where(eq(ccSessions.sessionId, patch.sessionId)).for('update');
      const parent = parents[0];
      const subs = await tx
        .select()
        .from(ccSubagentTranscripts)
        .where(eq(ccSubagentTranscripts.transcriptPath, patch.transcriptPath))
        .for('update');
      const prev = subs[0] ?? null;
      const storedOffset = prev?.transcriptOffset ?? 0;
      if (!parent) return { applied: false, reason: 'no_session', storedOffset } as const;
      if (parent.host !== patch.host || (prev !== null && prev.host !== patch.host)) {
        return { applied: false, reason: 'other_host', storedOffset } as const;
      }
      if (patch.fromOffset !== 0 && storedOffset !== patch.fromOffset) {
        return { applied: false, reason: 'offset_mismatch', storedOffset } as const;
      }
      // On a re-read from 0 the subagent row starts over, and its old share leaves the parent.
      const old = patch.fromOffset === 0 ? prev : null;
      const t = patch.tokens ?? {};
      const delta = {
        inputTokens: tokenCount(t.inputTokens),
        outputTokens: tokenCount(t.outputTokens),
        cacheReadTokens: tokenCount(t.cacheReadTokens),
        cacheWriteTokens: tokenCount(t.cacheWriteTokens),
      };
      const base = old === null && prev !== null ? prev : null;
      const now = this.now();
      const sub = {
        sessionId: patch.sessionId,
        agentId: patch.agentId,
        host: patch.host,
        transcriptOffset: patch.toOffset,
        transcriptSize: patch.size,
        inputTokens: (base?.inputTokens ?? 0) + delta.inputTokens,
        outputTokens: (base?.outputTokens ?? 0) + delta.outputTokens,
        cacheReadTokens: (base?.cacheReadTokens ?? 0) + delta.cacheReadTokens,
        cacheWriteTokens: (base?.cacheWriteTokens ?? 0) + delta.cacheWriteTokens,
        models: mergeModels(base?.models ?? {}, patch.models, false),
        commits: mergeCommits(base?.commits ?? [], patch.commits, false),
        lastActiveAt: latest(base?.lastActiveAt ?? null, patch.lastActiveAt),
        updatedAt: now,
      };
      await tx
        .insert(ccSubagentTranscripts)
        .values({ transcriptPath: patch.transcriptPath, ...sub })
        .onConflictDoUpdate({ target: ccSubagentTranscripts.transcriptPath, set: sub });
      await tx
        .update(ccSessions)
        .set({
          inputTokens: Math.max(0, parent.inputTokens - (old?.inputTokens ?? 0)) + delta.inputTokens,
          outputTokens: Math.max(0, parent.outputTokens - (old?.outputTokens ?? 0)) + delta.outputTokens,
          cacheReadTokens: Math.max(0, parent.cacheReadTokens - (old?.cacheReadTokens ?? 0)) + delta.cacheReadTokens,
          cacheWriteTokens: Math.max(0, parent.cacheWriteTokens - (old?.cacheWriteTokens ?? 0)) + delta.cacheWriteTokens,
          models: mergeModels(old === null ? parent.models : subtractModels(parent.models, old.models), patch.models, false),
          commits: mergeCommits(parent.commits, patch.commits, false),
          lastActiveAt: latest(parent.lastActiveAt, patch.lastActiveAt),
          updatedAt: now,
        })
        .where(eq(ccSessions.sessionId, patch.sessionId));
      return { applied: true } as const;
    });
  }

  /** transcript path -> stored offset, for every subagent transcript of `host`. The ingester's resume point. */
  async subagentOffsets(host: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ path: ccSubagentTranscripts.transcriptPath, offset: ccSubagentTranscripts.transcriptOffset })
      .from(ccSubagentTranscripts)
      .where(eq(ccSubagentTranscripts.host, host));
    return new Map(rows.map((r) => [r.path, r.offset]));
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

  /**
   * Stores a summary and clears any pending summary request (`summary_requested_at`): the
   * request is served. False when the session has no row.
   */
  async setSummary(sessionId: string, input: SummaryInput): Promise<boolean> {
    const at = input.at ?? this.now();
    const rows = await this.db
      .update(ccSessions)
      .set({ summary: input.summary, summarySha: input.sha, summarizedAt: at, summaryRequestedAt: null, updatedAt: this.now() })
      .where(eq(ccSessions.sessionId, sessionId))
      .returning({ id: ccSessions.sessionId });
    return rows.length > 0;
  }

  /**
   * Records that someone wants this session summarized. Idempotent: the first request time is
   * kept, and only that first call bumps `updated_at`. Never calls a summarizer; the owning
   * host's summary worker serves the request. Null when the session has no row. Whether a
   * request makes sense (an empty session, one already summarized) is the caller's decision.
   */
  async requestSummary(sessionId: string): Promise<SummaryRequest | null> {
    const now = this.now().toISOString();
    const rows = await this.db
      .update(ccSessions)
      .set({
        summaryRequestedAt: sql`coalesce(${ccSessions.summaryRequestedAt}, ${now}::timestamptz)`,
        updatedAt: sql`case when ${ccSessions.summaryRequestedAt} is null then ${now}::timestamptz else ${ccSessions.updatedAt} end`,
      })
      .where(eq(ccSessions.sessionId, sessionId))
      .returning({ requestedAt: ccSessions.summaryRequestedAt });
    const row = rows[0];
    if (!row) return null;
    if (row.requestedAt === null) throw new Error(`summary request on ${sessionId} was not stored`);
    return { requestedAt: row.requestedAt };
  }

  /**
   * Drops a pending summary request without storing a summary (e.g. the session has nothing to
   * summarize). True when a pending request was cleared; false when there was none or no row.
   */
  async clearSummaryRequest(sessionId: string): Promise<boolean> {
    const rows = await this.db
      .update(ccSessions)
      .set({ summaryRequestedAt: null, updatedAt: this.now() })
      .where(and(eq(ccSessions.sessionId, sessionId), isNotNull(ccSessions.summaryRequestedAt)))
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
        (session_id, embedding, sha, model, text_version, attempts, last_error, next_attempt_at, embedded_at, created_at, updated_at)
      select cc_sessions.session_id, ${literal}::vector, ${input.sha}, ${input.model}, ${input.textVersion}::integer, 0, null, null, now(), now(), now()
      from cc_sessions
      where cc_sessions.session_id = ${sessionId}
      on conflict (session_id) do update set
        embedding = excluded.embedding,
        sha = excluded.sha,
        model = excluded.model,
        text_version = excluded.text_version,
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

  // ---------- reply embeddings (cc_session_reply_embeddings) ----------

  /**
   * Stores the vector of reply (`sessionId`, `seq`), but only while the reply's text still hashes
   * to `input.sha` (it may have been replaced during the call). Clears any failure. False when
   * skipped (text changed or reply gone). Idempotent.
   */
  async saveReplyEmbedding(sessionId: string, seq: number, input: Omit<SessionEmbeddingInput, 'textVersion'>): Promise<boolean> {
    if (input.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`embedding has ${input.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
    }
    const literal = toVectorLiteral(input.embedding);
    const res = await this.db.execute<{ session_id: string }>(sql`
      insert into cc_session_reply_embeddings
        (session_id, seq, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
      select cc_session_replies.session_id, cc_session_replies.seq, ${literal}::vector, ${input.sha}, ${input.model},
             0, null, null, now(), now()
      from cc_session_replies
      where cc_session_replies.session_id = ${sessionId}
        and cc_session_replies.seq = ${seq}::integer
        and ${currentReplySha256Sql()} = ${input.sha}
      on conflict (session_id, seq) do update set
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
   * Records a failed attempt for reply (`sessionId`, `seq`): embedding := null, attempts := previous
   * + 1 when the previous row was a failure for the same sha and model, else 1; next_attempt_at :=
   * now() + retryDelayMs(attempts); last_error := clampError(error). No-op when the reply no longer
   * hashes to `input.sha`, or when the row already holds a vector for this sha and model.
   */
  async recordReplyEmbeddingFailure(sessionId: string, seq: number, input: SessionEmbeddingFailure): Promise<void> {
    const prev = await this.db
      .select({
        sha: ccSessionReplyEmbeddings.sha,
        model: ccSessionReplyEmbeddings.model,
        attempts: ccSessionReplyEmbeddings.attempts,
        hasVector: sql<boolean>`${ccSessionReplyEmbeddings.embedding} is not null`,
      })
      .from(ccSessionReplyEmbeddings)
      .where(and(eq(ccSessionReplyEmbeddings.sessionId, sessionId), eq(ccSessionReplyEmbeddings.seq, seq)))
      .limit(1);
    const row = prev[0];
    const sameTarget = row !== undefined && row.sha === input.sha && row.model === input.model;
    if (sameTarget && row.hasVector) return;
    const attempts = sameTarget ? row.attempts + 1 : 1;
    const delayMs = retryDelayMs(attempts);
    await this.db.execute(sql`
      insert into cc_session_reply_embeddings
        (session_id, seq, embedding, sha, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
      select cc_session_replies.session_id, cc_session_replies.seq, null, ${input.sha}, ${input.model},
             ${attempts}::integer, ${clampError(input.error)},
             now() + ${delayMs}::integer * interval '1 millisecond', null, now()
      from cc_session_replies
      where cc_session_replies.session_id = ${sessionId}
        and cc_session_replies.seq = ${seq}::integer
        and ${currentReplySha256Sql()} = ${input.sha}
      on conflict (session_id, seq) do update set
        embedding = null,
        sha = excluded.sha,
        model = excluded.model,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        next_attempt_at = excluded.next_attempt_at,
        embedded_at = null,
        updated_at = excluded.updated_at
      where not (
        cc_session_reply_embeddings.embedding is not null
        and cc_session_reply_embeddings.sha = excluded.sha
        and cc_session_reply_embeddings.model = excluded.model
      )
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
