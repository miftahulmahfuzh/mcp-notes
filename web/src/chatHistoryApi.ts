import { ApiError } from './api';
import type { ChatAttachment, ChatMessage, ChatPage } from './types';

const enc = encodeURIComponent;

async function failure(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`.trim();
  try {
    const j: unknown = await res.json();
    if (j && typeof j === 'object' && typeof (j as { error?: unknown }).error === 'string') msg = (j as { error: string }).error;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(res.status, msg);
}

export interface ChatPageQuery {
  /** Opaque cursor from a previous page's `next_before`; absent = the latest page. */
  before?: string | null;
  limit?: number;
  /** Phase 10's "show deleted" toggle. */
  includeDeleted?: boolean;
}

function normalize(m: ChatMessage): ChatMessage {
  return {
    ...m,
    text: typeof m.text === 'string' ? m.text : '',
    brain: m.brain ?? null,
    reply_to: m.reply_to ?? null,
    edited_at: m.edited_at ?? null,
    deleted_at: m.deleted_at ?? null,
    attachments: Array.isArray(m.attachments) ? (m.attachments as ChatAttachment[]) : [],
  };
}

/** Phase 7: `GET /api/chat/messages?before&limit&include_deleted=1` → one page of the unified timeline (ascending; the hook re-sorts anyway). */
export async function fetchChatMessages(q: ChatPageQuery = {}): Promise<ChatPage> {
  const p = new URLSearchParams();
  if (q.before) p.set('before', q.before);
  if (q.limit) p.set('limit', String(q.limit));
  if (q.includeDeleted) p.set('include_deleted', '1');
  const qs = p.toString();
  const res = await fetch(`/api/chat/messages${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { messages?: unknown; next_before?: unknown };
  const messages = Array.isArray(j.messages) ? (j.messages as ChatMessage[]).map(normalize) : [];
  const next = typeof j.next_before === 'string' && j.next_before !== '' ? j.next_before : null;
  return { messages, next_before: next };
}

export interface StreamChatRequest {
  message: string;
  /** Our thread id (phase 7, a UUID); absent (or unknown to the server) = a new thread. */
  threadId?: string;
  /** Phase 3 chat image ids, already uploaded. */
  imageIds?: string[];
  /** Phase 10: the bubble this message replies to (a 4-char message id), sent as `reply_to`. */
  replyTo?: string;
  signal: AbortSignal;
}

/** `POST /api/chat` for the history composer; the caller reads the SSE body (lib/sse `readSSE`). */
export function streamChat(r: StreamChatRequest): Promise<Response> {
  const payload: { message: string; thread_id?: string; image_ids?: string[]; reply_to?: string } = { message: r.message };
  if (r.threadId) payload.thread_id = r.threadId;
  if (r.replyTo) payload.reply_to = r.replyTo;
  if (r.imageIds && r.imageIds.length > 0) payload.image_ids = r.imageIds;
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal: r.signal,
  });
}

/** Phase 7: `PATCH /api/chat/messages/:id {text}`, user messages only. Returns the updated message; the old text is kept as a revision server-side. */
export async function editChatMessage(id: string, text: string): Promise<ChatMessage> {
  const res = await fetch(`/api/chat/messages/${enc(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw await failure(res);
  return normalize((await res.json()) as ChatMessage);
}

/**
 * Phase 7: soft delete, `?with_answer=1` also deletes the question's answer. Resolves to the ids
 * the server deleted (`{deleted}`, question first); a row that was already deleted is not listed.
 */
export async function deleteChatMessage(id: string, withAnswer: boolean): Promise<string[]> {
  const res = await fetch(`/api/chat/messages/${enc(id)}${withAnswer ? '?with_answer=1' : ''}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
  const j = (await res.json()) as { deleted?: unknown };
  return Array.isArray(j.deleted) ? j.deleted.filter((x): x is string => typeof x === 'string') : [];
}

/** Phase 7: `POST /api/chat/messages/:id/restore`, one id per call. Restoring a live message is a 200 no-op. */
export async function restoreChatMessage(id: string): Promise<ChatMessage> {
  const res = await fetch(`/api/chat/messages/${enc(id)}/restore`, { method: 'POST' });
  if (!res.ok) throw await failure(res);
  return normalize((await res.json()) as ChatMessage);
}

export type ChatImageVariant = 'thumb' | 'display';

/** Phase 3: `/api/chat/images/<id>/<variant>`. */
export function chatImageSrc(id: string, variant: ChatImageVariant): string {
  return `/api/chat/images/${enc(id)}/${variant}`;
}
