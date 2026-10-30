import { sql } from 'drizzle-orm';
import type { Executor } from '../notes/repo.js';

/**
 * Copies legacy one-image-per-note images (`notes.image_path` + `notes.image_meta`, iterations
 * 2-6) into `note_images`. One INSERT...SELECT, idempotent.
 *
 * Every `notes` row (live or soft-deleted) with both legacy columns set and no `note_images` row
 * whose id is the note id gets exactly one row: id = note_id = notes.id, path = image_path, the
 * metadata from image_meta (taken_at cast to timestamptz), position 0, created_at =
 * notes.created_at. deleted_at is null, except when that would break
 * `note_images_sha256_live_uniq` (an existing live row, or an earlier candidate of the same batch,
 * has the same sha256; candidates are ranked live notes first, then most recently deleted): then
 * deleted_at = coalesce(notes.deleted_at, now()), so the image is kept and shows in the bin.
 *
 * drizzle/0002_note_images.sql ends with this exact statement (tests/integration/
 * migration0002.int.test.ts asserts it). Keep the two identical; never edit the applied migration.
 */
export const LEGACY_COPY_SQL = `insert into note_images (id, note_id, path, sha256, mime, width, height, bytes, taken_at, original_name, host, position, created_at, deleted_at)
select
  c.id,
  c.id,
  c.image_path,
  c.sha256,
  c.image_meta ->> 'mime',
  (c.image_meta ->> 'width')::integer,
  (c.image_meta ->> 'height')::integer,
  (c.image_meta ->> 'bytes')::integer,
  (c.image_meta ->> 'taken_at')::timestamptz,
  c.image_meta ->> 'original_name',
  c.image_meta ->> 'host',
  0,
  c.created_at,
  case
    when c.sha_rank = 1
      and not exists (
        select 1 from note_images l where l.sha256 = c.sha256 and l.deleted_at is null
      )
    then null
    else coalesce(c.deleted_at, now())
  end
from (
  select
    n.id,
    n.image_path,
    n.image_meta,
    n.image_meta ->> 'sha256' as sha256,
    n.created_at,
    n.deleted_at,
    row_number() over (
      partition by n.image_meta ->> 'sha256'
      order by n.deleted_at is not null, n.deleted_at desc, n.id
    ) as sha_rank
  from notes n
  where n.image_path is not null
    and n.image_meta is not null
    and not exists (select 1 from note_images i where i.id = n.id)
) c
on conflict do nothing`;

/**
 * Runs `LEGACY_COPY_SQL`. Returns the number of `note_images` rows inserted (0 when every legacy
 * image already has its row). Phase 2 calls it once at daemon start, so images the old daemon
 * ingested between the Neon migration and the restart are picked up.
 */
export async function reconcileLegacyImages(db: Executor): Promise<number> {
  const res = await db.execute(sql.raw(LEGACY_COPY_SQL));
  return res.rowCount ?? 0;
}
