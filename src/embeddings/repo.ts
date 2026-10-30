import { sql, type SQL } from 'drizzle-orm';

import { noteEmbeddings, notes } from '../db/schema.js';
import type { Executor } from '../notes/repo.js';
import { EMBEDDING_DIMENSIONS } from './constants.js';
import { clampError, retryDelayMs } from './state.js';

/**
 * Queries on `note_embeddings`. Every statement here refers to the tables by their real names
 * (`notes`, `note_embeddings`) with no alias, because the SQL fragments below interpolate
 * Drizzle columns, which render as `"notes"."body"` / `"note_embeddings"."embedding"`.
 * Callers that join these fragments into their own queries (phase 4 search, phase 5 related)
 * must not alias the two tables either.
 *
 * The vector column is never selected here except by the callers that rank by it; it never
 * enters `NoteRow`, the wire `Note`, or a log line.
 */

/** `encode(sha256(convert_to(notes.body, 'UTF8')), 'hex')`: the SQL twin of `bodySha256`. */
export function currentBodySha256Sql(): SQL {
  return sql`encode(sha256(convert_to(${notes.body}, 'UTF8')), 'hex')`;
}

/**
 * True when the joined `note_embeddings` row holds a vector made from the note's current body
 * by `model`. Null (not false) when the left join found no row; wrap in `coalesce(..., false)`
 * where that matters.
 */
export function isCurrentEmbeddingSql(model: string): SQL {
  return sql`(${noteEmbeddings.embedding} is not null and ${noteEmbeddings.bodySha256} = ${currentBodySha256Sql()} and ${noteEmbeddings.model} = ${model})`;
}

/**
 * Postgres regex matching any character JS `String.prototype.trim` keeps, so
 * `body ~ NON_BLANK_PATTERN` is exactly `embedInput(body) !== null`. Bound as a parameter, so
 * the backslash escapes reach the regex engine untouched.
 */
const NON_BLANK_PATTERN =
  '[^\\u0009\\u000a\\u000b\\u000c\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';

function hasTextSql(): SQL {
  return sql`(${notes.body} ~ ${NON_BLANK_PATTERN})`;
}

/** `JSON.stringify` of the vector, for binding as `${toVectorLiteral(v)}::vector`. Rejects NaN/Infinity. */
export function toVectorLiteral(v: readonly number[]): string {
  for (const x of v) {
    if (!Number.isFinite(x)) throw new Error('embedding contains a non-finite value');
  }
  return JSON.stringify(Array.from(v));
}

export interface PendingNote {
  id: string;
  body: string;
  /** Hash of `body` as read; pass it back to `saveEmbedding` / `recordFailure` unchanged. */
  bodySha256: string;
}

/**
 * Notes that need an embedding: live AND deleted (so a restore never needs a call), with a
 * non-blank body, whose row is missing, stale (other body hash or other model), or failed
 * for this body and due (`next_attempt_at <= now()`; `ignoreBackoff` makes every failure due).
 * Live notes first, then most recently updated, then id.
 */
export async function listPending(
  db: Executor,
  opts: { model: string; limit: number; ignoreBackoff?: boolean },
): Promise<PendingNote[]> {
  const limit = Math.max(1, Math.trunc(opts.limit));
  const due = opts.ignoreBackoff
    ? sql`true`
    : sql`(note_embeddings.next_attempt_at is null or note_embeddings.next_attempt_at <= now())`;
  const res = await db.execute<{ id: string; body: string; body_sha256: string }>(sql`
    select notes.id, notes.body, ${currentBodySha256Sql()} as body_sha256
    from notes
    left join note_embeddings on note_embeddings.note_id = notes.id
    where ${hasTextSql()}
      and (
        note_embeddings.note_id is null
        or note_embeddings.model <> ${opts.model}
        or note_embeddings.body_sha256 <> ${currentBodySha256Sql()}
        or (note_embeddings.embedding is null and ${due})
      )
    order by (notes.deleted_at is null) desc, notes.updated_at desc, notes.id asc
    limit ${limit}
  `);
  return res.rows.map((r) => ({ id: r.id, body: r.body, bodySha256: r.body_sha256 }));
}

/**
 * Stores a vector for `noteId`, but only if the note's body still hashes to `bodySha256`
 * (the body may have changed while the embedding call was in flight). Resets attempts,
 * last_error and next_attempt_at. Returns false when skipped (body changed or note gone).
 * Idempotent: two daemons saving the same vector leave the same row.
 */
export async function saveEmbedding(
  db: Executor,
  v: { noteId: string; bodySha256: string; model: string; embedding: number[] },
): Promise<boolean> {
  if (v.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding has ${v.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
  }
  const literal = toVectorLiteral(v.embedding);
  const res = await db.execute<{ note_id: string }>(sql`
    insert into note_embeddings
      (note_id, embedding, body_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select notes.id, ${literal}::vector, ${v.bodySha256}, ${v.model}, 0, null, null, now(), now()
    from notes
    where notes.id = ${v.noteId} and ${currentBodySha256Sql()} = ${v.bodySha256}
    on conflict (note_id) do update set
      embedding = excluded.embedding,
      body_sha256 = excluded.body_sha256,
      model = excluded.model,
      attempts = 0,
      last_error = null,
      next_attempt_at = null,
      embedded_at = excluded.embedded_at,
      updated_at = excluded.updated_at
    returning note_id
  `);
  return res.rows.length > 0;
}

/**
 * Records a failed embedding attempt: embedding := NULL, attempts := previous + 1 when the
 * previous row was already a failure for this same body hash and model, else 1;
 * next_attempt_at := now() + retryDelayMs(attempts); last_error := clampError(error).
 *
 * No-op when the note's body no longer hashes to `bodySha256` (the new body is pending anyway)
 * or when the row already holds a vector for this body and model (another daemon succeeded).
 */
export async function recordFailure(
  db: Executor,
  v: { noteId: string; bodySha256: string; model: string; error: string },
): Promise<void> {
  const prev = await db.execute<{ body_sha256: string; model: string; attempts: number; has_vector: boolean }>(sql`
    select body_sha256, model, attempts, embedding is not null as has_vector
    from note_embeddings
    where note_id = ${v.noteId}
  `);
  const row = prev.rows[0];
  const sameTarget = row !== undefined && row.body_sha256 === v.bodySha256 && row.model === v.model;
  if (sameTarget && row.has_vector) return;
  const attempts = sameTarget ? row.attempts + 1 : 1;
  const delayMs = retryDelayMs(attempts);
  await db.execute(sql`
    insert into note_embeddings
      (note_id, embedding, body_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select notes.id, null, ${v.bodySha256}, ${v.model}, ${attempts}::integer, ${clampError(v.error)},
           now() + ${delayMs}::integer * interval '1 millisecond', null, now()
    from notes
    where notes.id = ${v.noteId} and ${currentBodySha256Sql()} = ${v.bodySha256}
    on conflict (note_id) do update set
      embedding = null,
      body_sha256 = excluded.body_sha256,
      model = excluded.model,
      attempts = excluded.attempts,
      last_error = excluded.last_error,
      next_attempt_at = excluded.next_attempt_at,
      embedded_at = null,
      updated_at = excluded.updated_at
    where not (
      note_embeddings.embedding is not null
      and note_embeddings.body_sha256 = excluded.body_sha256
      and note_embeddings.model = excluded.model
    )
  `);
}

/** Counts over every note (live and deleted), matching `listPending`'s universe. */
export interface EmbeddingStats {
  /** Notes whose body is non-blank, i.e. that should have an embedding. */
  withText: number;
  /** Of those, notes with a current vector for `model`. */
  current: number;
  /** `withText - current`: missing, stale or failed (due or not). `0` means fully embedded. */
  pending: number;
  /** Of the pending, notes whose last attempt for this body and model failed. */
  failing: number;
}

export async function embeddingStats(db: Executor, model: string): Promise<EmbeddingStats> {
  const res = await db.execute<{ with_text: number; current: number; failing: number }>(sql`
    select
      count(*)::int as with_text,
      count(*) filter (where coalesce(${isCurrentEmbeddingSql(model)}, false))::int as current,
      count(*) filter (
        where note_embeddings.embedding is null
          and note_embeddings.body_sha256 = ${currentBodySha256Sql()}
          and note_embeddings.model = ${model}
      )::int as failing
    from notes
    left join note_embeddings on note_embeddings.note_id = notes.id
    where ${hasTextSql()}
  `);
  const r = res.rows[0];
  const withText = r?.with_text ?? 0;
  const current = r?.current ?? 0;
  return { withText, current, pending: withText - current, failing: r?.failing ?? 0 };
}
