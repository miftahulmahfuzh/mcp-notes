import { inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps } from '../deps.js';
import type { Db } from '../db/client.js';
import { movieIds, notes } from '../db/schema.js';
import { MOVIE_ID_PATTERN } from '../movies/ids.js';
import { ID_PATTERN } from '../notes/ids.js';
import { NODE_ID_PATTERN } from '../sessions/ids.js';
import { KNOWN_MAX_IDS, knownNodes, type KnownNode } from '../sessions/readModel.js';
import { parseIdList } from './sessionsApi.js';

export const MAX_KNOWN_IDS_CHARS = 1000;

/** Which of the asked ids exist, per kind. A soft-deleted note still counts: its id is real. */
export type KnownIds = {
  notes: string[];
  nodes: KnownNode[];
  movies: string[];
};

/**
 * Which ids exist, of every kind an id can be: a note (`A-B32`), a session node (`BE-XU`) or a
 * movie id (`M-23T4`, a title or an episode). The three shapes never overlap, so an id is asked
 * of one table only. Canonical form only (upper case, dashed): this answers "is this token an
 * id?" for a client that links ids where shape alone is not enough (the note-links mod, for an id
 * written as a code span), and a looser match would say yes to more tokens than were written.
 * Unknown and malformed ids are dropped.
 */
export async function knownIds(db: Db, rawIds: readonly string[]): Promise<KnownIds> {
  const ids = [...new Set(rawIds)].slice(0, KNOWN_MAX_IDS);
  const noteIds = ids.filter((id) => ID_PATTERN.test(id));
  const nodeIds = ids.filter((id) => NODE_ID_PATTERN.test(id));
  const movieIdList = ids.filter((id) => MOVIE_ID_PATTERN.test(id));
  const [noteRows, nodes, movieRows] = await Promise.all([
    noteIds.length === 0 ? [] : db.select({ id: notes.id }).from(notes).where(inArray(notes.id, noteIds)),
    nodeIds.length === 0 ? [] : knownNodes({ db }, nodeIds),
    movieIdList.length === 0 ? [] : db.select({ id: movieIds.id }).from(movieIds).where(inArray(movieIds.id, movieIdList)),
  ]);
  return {
    notes: noteRows.map((r) => r.id).sort(),
    nodes,
    movies: movieRows.map((r) => r.id).sort(),
  };
}

/** GET /api/ids/known?ids=   which ids exist, by kind (the note-links mod asks before linking an id in a code span). */
export function knownIdsRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  r.get('/api/ids/known', async (c) => {
    const raw = c.req.query('ids') ?? '';
    if (raw.length > MAX_KNOWN_IDS_CHARS) return c.json({ error: 'ids: too long' }, 400);
    return c.json(await knownIds(deps.db, parseIdList(raw)));
  });
  return r;
}
