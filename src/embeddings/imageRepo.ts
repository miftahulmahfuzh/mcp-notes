import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import type { Executor } from '../notes/repo.js';
import { IMAGE_EMBEDDING_DIMENSIONS } from './imageConstants.js';
import { toVectorLiteral } from './repo.js';
import { clampError, retryDelayMs } from './state.js';

/**
 * Queries on `note_image_embeddings`. Plain SQL with full table names (no aliases, no Drizzle
 * column interpolation). The vector column is selected only by `nearestImages` for ranking and
 * never leaves this file.
 */

export interface PendingImage {
  id: string;
  noteId: string;
  /** Data-dir-relative original path (`images/YYYY/MM/<id>.<ext>`). */
  path: string;
  mime: string;
  /** `note_images.sha256` as read; pass it back to save / failure unchanged. */
  sha256: string;
  width: number;
  height: number;
  host: string | null;
  /** The image is part of its note and the note is not deleted. */
  live: boolean;
}

/** True when the joined row holds a vector for the image's current bytes from `model`. */
function isCurrentImageEmbeddingSql(model: string): SQL {
  return sql`(note_image_embeddings.embedding is not null and note_image_embeddings.model = ${model} and note_image_embeddings.image_sha256 = note_images.sha256)`;
}

/** `and not (id in ids)`, bound as one jsonb parameter however many ids there are. */
function excludeIdsSql(ids: readonly string[] | undefined): SQL {
  if (ids === undefined || ids.length === 0) return sql``;
  return sql`and not (note_images.id = any(array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))))`;
}

// Type aliases, not interfaces: db.execute<T> needs T assignable to Record<string, unknown>.
type PendingRow = {
  id: string;
  note_id: string;
  path: string;
  mime: string;
  sha256: string;
  width: number;
  height: number;
  host: string | null;
  live: boolean;
};

/**
 * Images that need an embedding: every image (live, removed, or in a deleted note, so a restore
 * never needs a call) whose row is missing, from another model, for other bytes, or failed and
 * due (`next_attempt_at <= now()`; `ignoreBackoff` makes every failure due). `excludeIds` are
 * left out (the drain loop's settled set). Live images of live notes first, then newest, then id.
 */
export async function listPendingImages(
  db: Executor,
  opts: { model: string; limit: number; ignoreBackoff?: boolean; excludeIds?: readonly string[] },
): Promise<PendingImage[]> {
  const limit = Math.max(1, Math.trunc(opts.limit));
  const due = opts.ignoreBackoff
    ? sql`true`
    : sql`(note_image_embeddings.next_attempt_at is null or note_image_embeddings.next_attempt_at <= now())`;
  const res = await db.execute<PendingRow>(sql`
    select note_images.id, note_images.note_id, note_images.path, note_images.mime, note_images.sha256,
           note_images.width, note_images.height, note_images.host,
           (note_images.deleted_at is null and notes.deleted_at is null) as live
    from note_images
    join notes on notes.id = note_images.note_id
    left join note_image_embeddings on note_image_embeddings.image_id = note_images.id
    where (
      note_image_embeddings.image_id is null
      or note_image_embeddings.model <> ${opts.model}
      or note_image_embeddings.image_sha256 <> note_images.sha256
      or (note_image_embeddings.embedding is null and ${due})
    )
    ${excludeIdsSql(opts.excludeIds)}
    order by (note_images.deleted_at is null and notes.deleted_at is null) desc,
             note_images.created_at desc,
             note_images.id asc
    limit ${limit}
  `);
  return res.rows.map((r) => ({
    id: r.id,
    noteId: r.note_id,
    path: r.path,
    mime: r.mime,
    sha256: r.sha256,
    width: Number(r.width),
    height: Number(r.height),
    host: r.host,
    live: r.live === true,
  }));
}

/**
 * Stores a vector for `imageId`, but only while the image's bytes still hash to `imageSha256`.
 * Resets attempts, last_error and next_attempt_at. Returns false when skipped (image gone or
 * other bytes). Idempotent: two daemons saving the same vector leave the same row.
 */
export async function saveImageEmbedding(
  db: Executor,
  v: { imageId: string; imageSha256: string; model: string; embedding: number[] },
): Promise<boolean> {
  if (v.embedding.length !== IMAGE_EMBEDDING_DIMENSIONS) {
    throw new Error(`image embedding has ${v.embedding.length} dimensions, expected ${IMAGE_EMBEDDING_DIMENSIONS}`);
  }
  const literal = toVectorLiteral(v.embedding);
  const res = await db.execute<{ image_id: string }>(sql`
    insert into note_image_embeddings
      (image_id, embedding, image_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select note_images.id, ${literal}::vector, ${v.imageSha256}, ${v.model}, 0, null, null, now(), now()
    from note_images
    where note_images.id = ${v.imageId} and note_images.sha256 = ${v.imageSha256}
    on conflict (image_id) do update set
      embedding = excluded.embedding,
      image_sha256 = excluded.image_sha256,
      model = excluded.model,
      attempts = 0,
      last_error = null,
      next_attempt_at = null,
      embedded_at = excluded.embedded_at,
      updated_at = excluded.updated_at
    returning image_id
  `);
  return res.rows.length > 0;
}

/**
 * Records a failed attempt: embedding := NULL, attempts := previous + 1 when the previous row was
 * already a failure for these bytes and model, else 1; next_attempt_at := now() +
 * retryDelayMs(attempts); last_error := clampError(error). No-op when the image is gone, holds
 * other bytes, or already has a vector for these bytes and model (another daemon succeeded).
 */
export async function recordImageFailure(
  db: Executor,
  v: { imageId: string; imageSha256: string; model: string; error: string },
): Promise<void> {
  const prev = await db.execute<{ image_sha256: string; model: string; attempts: number; has_vector: boolean }>(sql`
    select image_sha256, model, attempts, embedding is not null as has_vector
    from note_image_embeddings
    where image_id = ${v.imageId}
  `);
  const row = prev.rows[0];
  const sameTarget = row !== undefined && row.image_sha256 === v.imageSha256 && row.model === v.model;
  if (sameTarget && row.has_vector) return;
  const attempts = sameTarget ? Number(row.attempts) + 1 : 1;
  const delayMs = retryDelayMs(attempts);
  await db.execute(sql`
    insert into note_image_embeddings
      (image_id, embedding, image_sha256, model, attempts, last_error, next_attempt_at, embedded_at, updated_at)
    select note_images.id, null, ${v.imageSha256}, ${v.model}, ${attempts}::integer, ${clampError(v.error)},
           now() + ${delayMs}::integer * interval '1 millisecond', null, now()
    from note_images
    where note_images.id = ${v.imageId} and note_images.sha256 = ${v.imageSha256}
    on conflict (image_id) do update set
      embedding = null,
      image_sha256 = excluded.image_sha256,
      model = excluded.model,
      attempts = excluded.attempts,
      last_error = excluded.last_error,
      next_attempt_at = excluded.next_attempt_at,
      embedded_at = null,
      updated_at = excluded.updated_at
    where not (
      note_image_embeddings.embedding is not null
      and note_image_embeddings.image_sha256 = excluded.image_sha256
      and note_image_embeddings.model = excluded.model
    )
  `);
}

/** Counts over every image (live, removed, in deleted notes), matching listPendingImages' universe. */
export interface ImageEmbeddingStats {
  images: number;
  /** Images with a current vector for `model`. */
  current: number;
  /** `images - current`: missing, stale or failed (due or not). */
  pending: number;
  /** Of the pending, images whose last attempt for these bytes and model failed. */
  failing: number;
}

export async function imageEmbeddingStats(db: Executor, model: string): Promise<ImageEmbeddingStats> {
  const res = await db.execute<{ images: number; current: number; failing: number }>(sql`
    select
      count(*)::int as images,
      count(*) filter (where coalesce(${isCurrentImageEmbeddingSql(model)}, false))::int as current,
      count(*) filter (
        where note_image_embeddings.embedding is null
          and note_image_embeddings.image_sha256 = note_images.sha256
          and note_image_embeddings.model = ${model}
      )::int as failing
    from note_images
    left join note_image_embeddings on note_image_embeddings.image_id = note_images.id
  `);
  const r = res.rows[0];
  const images = Number(r?.images ?? 0);
  const current = Number(r?.current ?? 0);
  return { images, current, pending: images - current, failing: Number(r?.failing ?? 0) };
}

/** An existing image (its stored vector) or a raw vector (an upload or a text query). */
export type NearestImageSource = { imageId: string } | { vector: readonly number[] };

export interface NearestImage {
  imageId: string;
  noteId: string;
  /** Cosine distance (pgvector `<=>`): 0 = same direction, 2 = opposite. */
  distance: number;
  /** 1 - distance, rounded to 4 decimals (the `related` convention). */
  similarity: number;
}

function roundSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

type NearestRow = { image_id: string; note_id: string; distance: number };

/**
 * Live images of live notes nearest to `source`, closest first. Candidates use only current
 * vectors for `model`. An image source is never returned itself.
 *
 * Returns null when an image source has no current vector for `model` (no row, failed, other
 * bytes or other model), so the caller can embed it and ask again. A vector source never
 * returns null.
 *
 * `ORDER BY embedding <=> (source) LIMIT n` is what the HNSW cosine index serves; iterative scan
 * (pgvector >= 0.8) keeps walking past rows the WHERE clause drops (removed, deleted, stale,
 * self), so `limit` rows come back whenever that many exist.
 */
export async function nearestImages(
  db: Db,
  opts: { source: NearestImageSource; model: string; limit: number },
): Promise<NearestImage[] | null> {
  const limit = Math.max(1, Math.trunc(opts.limit));
  return db.transaction(async (tx) => {
    let target: SQL;
    let exclude: SQL = sql``;
    if ('imageId' in opts.source) {
      const id = opts.source.imageId;
      const src = await tx.execute<{ ok: number }>(sql`
        select 1 as ok
        from note_image_embeddings
        join note_images on note_images.id = note_image_embeddings.image_id
        where note_image_embeddings.image_id = ${id} and ${isCurrentImageEmbeddingSql(opts.model)}
        limit 1
      `);
      if (src.rows.length === 0) return null;
      target = sql`(select src.embedding from note_image_embeddings as src where src.image_id = ${id})`;
      exclude = sql`and note_images.id <> ${id}`;
    } else {
      if (opts.source.vector.length !== IMAGE_EMBEDDING_DIMENSIONS) {
        throw new Error(
          `query vector has ${opts.source.vector.length} dimensions, expected ${IMAGE_EMBEDDING_DIMENSIONS}`,
        );
      }
      target = sql`${toVectorLiteral(opts.source.vector)}::vector`;
    }

    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);

    const res = await tx.execute<NearestRow>(sql`
      select note_images.id as image_id, note_images.note_id,
             (note_image_embeddings.embedding <=> ${target}) as distance
      from note_image_embeddings
      join note_images on note_images.id = note_image_embeddings.image_id
      join notes on notes.id = note_images.note_id
      where note_images.deleted_at is null
        and notes.deleted_at is null
        and ${isCurrentImageEmbeddingSql(opts.model)}
        ${exclude}
      order by note_image_embeddings.embedding <=> ${target}
      limit ${limit}
    `);
    return res.rows.map((r) => {
      const distance = Number(r.distance);
      return { imageId: r.image_id, noteId: r.note_id, distance, similarity: roundSimilarity(1 - distance) };
    });
  });
}
