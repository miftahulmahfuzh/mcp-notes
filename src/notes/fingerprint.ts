import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';

// Timestamps are cast to text so microseconds survive (a JS Date keeps only milliseconds).
type FpRow = Record<string, string | number | null>;

/**
 * Cheap summary of everything `GET /api/notes` and `/api/tags` can show: note rows (body, tags,
 * origin and deletion all move `updated_at` / `deleted_at`), and the image and file rows joined
 * onto each note. Aggregates only: the answer is a few dozen bytes however many notes exist.
 */
export async function notesFingerprint(db: Db): Promise<string> {
  const res = await db.execute<FpRow>(sql`
    select
      (select count(*)::int from notes) as n,
      (select count(*)::int from notes where deleted_at is null) as live,
      (select max(updated_at)::text from notes) as nu,
      (select max(deleted_at)::text from notes) as nd,
      (select count(*)::int from note_images) as ni,
      (select count(*)::int from note_images where deleted_at is null) as nil,
      (select max(greatest(created_at, coalesce(deleted_at, created_at)))::text from note_images) as nit,
      (select count(*)::int from note_files) as nf,
      (select count(*)::int from note_files where deleted_at is null) as nfl,
      (select max(greatest(created_at, coalesce(deleted_at, created_at)))::text from note_files) as nft`);
  return createHash('sha1').update(JSON.stringify(res.rows[0] ?? {})).digest('hex').slice(0, 20);
}

/** Weak ETag for one list request: the data fingerprint plus the request's own shape. */
export function listEtag(fingerprint: string, requestShape: string): string {
  const shape = createHash('sha1').update(requestShape).digest('hex').slice(0, 8);
  return `W/"n-${fingerprint}-${shape}"`;
}
