import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { ccSessionReplies, ccSessionReplyEmbeddings } from '../db/schema.js';
import type { EmbeddingStore } from '../embeddings/backfill.js';
import { NON_BLANK_PATTERN, type PendingNote } from '../embeddings/repo.js';
import { startEmbeddingWorker, type EmbeddingWorker, type EmbeddingWorkerOptions } from '../embeddings/worker.js';
import type { SessionsRepo } from './repo.js';

/**
 * Background embeddings for Claude's replies (`cc_session_replies`, written by the session
 * ingester through SessionsRepo). One vector per reply in `cc_session_reply_embeddings`, keyed
 * by (session_id, seq), tied to the text it was made from by `sha` = sha256 of the stored
 * (already redacted) text, and to the embedder by `model`. The vector is current iff it is not
 * null and both keys still match (`isCurrentReplyEmbeddingSql`). Embed input is the text trimmed
 * and clamped by `embedInput` (8000 chars), exactly like a note body.
 *
 * Reads here, writes only through SessionsRepo (`saveReplyEmbedding`, `recordReplyEmbeddingFailure`).
 * Batching, rate limit, per-reply fallback, retry backoff (`retryDelayMs`) and error clamping
 * (`clampError`) are the note embedding worker's (src/embeddings/backfill.ts, worker.ts): this
 * module only supplies the store. Never blocks or fails ingest: the ingester only kicks it.
 *
 * The SQL fragments name the two tables without an alias. A caller that joins them into its own
 * query (search, phase 5) must not alias `cc_session_replies` or `cc_session_reply_embeddings`.
 */

/** Log prefix: `[notesd] reply embeddings: ...`. */
export const REPLY_EMBEDDINGS_LABEL = 'reply embeddings';

/** `encode(sha256(convert_to(cc_session_replies.text, 'UTF8')), 'hex')`: the SQL twin of `bodySha256(text)`. */
export function currentReplySha256Sql(): SQL {
  return sql`encode(sha256(convert_to(${ccSessionReplies.text}, 'UTF8')), 'hex')`;
}

/**
 * True when the joined `cc_session_reply_embeddings` row holds a vector made from the reply's
 * current text by `model`. Null (not false) when a left join found no row; wrap in
 * `coalesce(..., false)` where that matters. The ONE definition of a usable reply vector.
 */
export function isCurrentReplyEmbeddingSql(model: string): SQL {
  return sql`(${ccSessionReplyEmbeddings.embedding} is not null and ${ccSessionReplyEmbeddings.sha} = ${currentReplySha256Sql()} and ${ccSessionReplyEmbeddings.model} = ${model})`;
}

const KEY_SEPARATOR = '#';

function replyKey(sessionId: string, seq: number): string {
  return `${sessionId}${KEY_SEPARATOR}${seq}`;
}

function parseReplyKey(key: string): { sessionId: string; seq: number } {
  const at = key.lastIndexOf(KEY_SEPARATOR);
  const seq = at > 0 ? Number(key.slice(at + 1)) : Number.NaN;
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`not a reply key: ${key}`);
  return { sessionId: key.slice(0, at), seq };
}

type PendingReplyDbRow = { session_id: string; seq: number | string; text: string; sha: string };

/**
 * The reply store for `runBackfill` / `startEmbeddingWorker`. Pending = a non-blank reply of a
 * session of `host` whose embedding row is missing, stale (other sha or model), or failed for
 * this text and due (`next_attempt_at <= now()`; `ignoreBackoff` makes every failure due).
 * Most recently active sessions first, then session id, then seq.
 */
export function dbReplyEmbeddingStore(db: Db, repo: SessionsRepo, host: string): EmbeddingStore {
  return {
    async listPending(o): Promise<PendingNote[]> {
      const limit = Math.max(1, Math.trunc(o.limit));
      const due = o.ignoreBackoff
        ? sql`true`
        : sql`(cc_session_reply_embeddings.next_attempt_at is null or cc_session_reply_embeddings.next_attempt_at <= now())`;
      const res = await db.execute<PendingReplyDbRow>(sql`
        select cc_session_replies.session_id, cc_session_replies.seq, cc_session_replies.text,
               ${currentReplySha256Sql()} as sha
        from cc_session_replies
        join cc_sessions on cc_sessions.session_id = cc_session_replies.session_id
        left join cc_session_reply_embeddings
          on cc_session_reply_embeddings.session_id = cc_session_replies.session_id
         and cc_session_reply_embeddings.seq = cc_session_replies.seq
        where cc_sessions.host = ${host}
          and cc_session_replies.text ~ ${NON_BLANK_PATTERN}
          and (
            cc_session_reply_embeddings.session_id is null
            or cc_session_reply_embeddings.model <> ${o.model}
            or cc_session_reply_embeddings.sha <> ${currentReplySha256Sql()}
            or (cc_session_reply_embeddings.embedding is null and ${due})
          )
        order by cc_sessions.last_active_at desc nulls last, cc_session_replies.session_id asc, cc_session_replies.seq asc
        limit ${limit}
      `);
      return res.rows.map((r) => ({ id: replyKey(r.session_id, Number(r.seq)), body: r.text, bodySha256: r.sha }));
    },
    async saveEmbedding(v): Promise<boolean> {
      const { sessionId, seq } = parseReplyKey(v.noteId);
      return repo.saveReplyEmbedding(sessionId, seq, { sha: v.bodySha256, model: v.model, embedding: v.embedding });
    },
    async recordFailure(v): Promise<void> {
      const { sessionId, seq } = parseReplyKey(v.noteId);
      await repo.recordReplyEmbeddingFailure(sessionId, seq, { sha: v.bodySha256, model: v.model, error: v.error });
    },
  };
}

/** The note worker's knobs, minus what this worker fixes (no note events, its own log label). */
export type ReplyEmbeddingWorkerOptions = Omit<EmbeddingWorkerOptions, 'events' | 'label' | 'itemNoun'>;

/**
 * Embeds pending replies at start, on `kick()` (the session ingester calls it after a sweep that
 * wrote rows) and every sweep (60 s: catches the watcher's reads, the one-time replies backfill and
 * due retries). `close()` waits at most `closeGraceMs` (5 s) for the in-flight batch.
 */
export function startReplyEmbeddingWorker(opts: ReplyEmbeddingWorkerOptions): EmbeddingWorker {
  return startEmbeddingWorker({ ...opts, label: REPLY_EMBEDDINGS_LABEL, itemNoun: 'reply' });
}
