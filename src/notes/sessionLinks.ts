import { and, eq } from 'drizzle-orm';
import { ccSessions, noteSessionLinks } from '../db/schema.js';
import type { Executor } from './repo.js';

/**
 * Rows of `note_session_links` (migration 0009): explicit note -> Claude Code session links.
 * Only NotesService calls these; session detail reads the table in src/sessions/readModel.ts.
 */

/** The session a canonical node id names. */
export interface LinkedSession {
  sessionId: string;
  nodeId: string;
}

export async function findSessionByNodeId(db: Executor, nodeId: string): Promise<LinkedSession | null> {
  const rows = await db
    .select({ sessionId: ccSessions.sessionId, nodeId: ccSessions.nodeId })
    .from(ccSessions)
    .where(eq(ccSessions.nodeId, nodeId))
    .limit(1);
  return rows[0] ?? null;
}

/** Inserts the link; true when this call created it, false when it already existed. */
export async function insertLink(db: Executor, noteId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .insert(noteSessionLinks)
    .values({ noteId, sessionId })
    .onConflictDoNothing()
    .returning({ noteId: noteSessionLinks.noteId });
  return rows.length > 0;
}

/** Deletes the link; true when this call removed it, false when there was none. */
export async function deleteLink(db: Executor, noteId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .delete(noteSessionLinks)
    .where(and(eq(noteSessionLinks.noteId, noteId), eq(noteSessionLinks.sessionId, sessionId)))
    .returning({ noteId: noteSessionLinks.noteId });
  return rows.length > 0;
}
