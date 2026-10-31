import type { ChatMessage, ChatReplyPreview, ChatRole } from '../types';

/** Characters of a quoted message shown in a reply header or the composer chip. */
export const SNIPPET_CHARS = 80;

/** The history composer's textarea (P9's `HistoryComposer` renders `div.hist-composer` around ChatBar); focus goes here after Reply or a delete with nothing left. */
export const COMPOSER_SELECTOR = '.hist-composer textarea';

/** Whitespace collapsed to single spaces, cut at `max` characters with an ellipsis. */
export function snippetOf(text: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The author label of a bubble in a quote: the user is "you", every assistant row (either brain, either source) is "claude". */
export function authorOf(m: { role: ChatRole }): string {
  return m.role === 'user' ? 'you' : 'claude';
}

/**
 * Decision (plan index): replying to a bubble in a wall thread continues that thread; replying to a
 * claude_code bubble starts a new thread (null: send no thread_id) that carries reply_to.
 */
export function threadForReply(target: Pick<ChatMessage, 'source' | 'thread_id'>): string | null {
  return target.source === 'wall' && target.thread_id ? target.thread_id : null;
}

/** One history message: P9's bubble root `li.bubble[data-msg]`. */
export function messageSelector(id: string): string {
  return `[data-msg="${id.replace(/["\\]/g, '\\$&')}"]`;
}

const byCreated = (a: ChatMessage, b: ChatMessage): number =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;

/**
 * Question id -> its live answer: within each thread, in time order, the first live assistant row
 * after a user row and before the next user row. A question whose answer is deleted (or that has
 * none yet) is not in the map.
 */
export function answerMap(messages: readonly ChatMessage[]): Map<string, ChatMessage> {
  const threads = new Map<string, ChatMessage[]>();
  for (const m of messages) {
    const list = threads.get(m.thread_id);
    if (list) list.push(m);
    else threads.set(m.thread_id, [m]);
  }
  const out = new Map<string, ChatMessage>();
  for (const list of threads.values()) {
    list.sort(byCreated);
    let open: ChatMessage | null = null;
    for (const m of list) {
      if (m.role === 'user') {
        open = m;
      } else if (open && !m.deleted_at) {
        out.set(open.id, m);
        open = null;
      }
    }
  }
  return out;
}

/** What a reply header shows. */
export interface ResolvedReply {
  id: string;
  author: string;
  snippet: string;
  deleted: boolean;
}

/**
 * Prefer the loaded target (its current text and deleted state, including this session's edits,
 * deletes and restores) over the server's preview in `reply_to` (P7: `{id, role, text, deleted}`,
 * `role` null when the target row is gone).
 */
export function resolveReply(ref: ChatReplyPreview, byId: ReadonlyMap<string, ChatMessage>): ResolvedReply {
  const local = byId.get(ref.id);
  if (local) {
    return { id: ref.id, author: authorOf(local), snippet: snippetOf(local.text), deleted: Boolean(local.deleted_at) };
  }
  return {
    id: ref.id,
    author: ref.role ? authorOf({ role: ref.role }) : 'message',
    snippet: snippetOf(ref.text),
    deleted: ref.deleted,
  };
}
