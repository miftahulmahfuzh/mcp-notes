import { z } from 'zod';

/**
 * Project scoping of chat threads (phase 12). A project is a repo key as resolved by the session
 * ingester (`cc_sessions.repo`, e.g. `mcp-notes`): a directory basename, so it is short and has no
 * line breaks. It is stored on `chat_threads.project` and written into the model's <project> block.
 */

/** Longest repo key a chat thread may carry. */
export const PROJECT_KEY_MAX = 200;

/** Non-empty, at most PROJECT_KEY_MAX characters, no control characters, no `<` or `>`. */
export function isProjectKey(value: string): boolean {
  if (value.length === 0 || value.length > PROJECT_KEY_MAX) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '<' || ch === '>') return false;
  }
  return true;
}

/** Trimmed, then `isProjectKey`. Shared by POST /api/chat (`project`) and GET /api/chat/messages (`?project=`). */
export const projectKeySchema = z.string().trim().refine(isProjectKey, { message: 'not a project key' });
