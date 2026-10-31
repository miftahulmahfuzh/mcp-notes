import type { ChatAttachmentKind, ChatMessageRow, ChatRole, ChatSource, ChatThreadRow } from '../db/schema.js';

/** One attachment by reference: what is stored in chat_message_attachments. */
export interface AttachmentRef {
  kind: ChatAttachmentKind;
  id: string;
}

/** An attachment on the wire. `url` is the large form (lightbox / download); `thumb_url` is null for files. */
export interface ChatAttachmentView {
  kind: ChatAttachmentKind;
  id: string;
  url: string;
  thumb_url: string | null;
}

/** The quoted header of a reply bubble. A deleted (or vanished) target has `deleted: true` and empty text. */
export interface ChatReplyPreview {
  id: string;
  role: ChatRole | null;
  text: string;
  deleted: boolean;
}

/** A chat message on the wire. Every timestamp is a UTC ISO string. */
export interface ChatMessageView {
  id: string;
  thread_id: string;
  role: ChatRole;
  text: string;
  source: ChatSource;
  brain: string | null;
  reply_to: ChatReplyPreview | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  attachments: ChatAttachmentView[];
}

export interface ChatThreadView {
  id: string;
  source: ChatSource;
  brain: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatThreadDetail {
  thread: ChatThreadView;
  /** Ascending (created_at, seq). */
  messages: ChatMessageView[];
}

/** One timeline page: ascending for display; `next_before` fetches the page of older messages, null at the start. */
export interface ChatTimelinePage {
  messages: ChatMessageView[];
  next_before: string | null;
}

export type ChatErrorCode =
  | 'invalid_id'
  | 'not_found'
  | 'thread_not_found'
  | 'reply_not_found'
  | 'not_editable'
  | 'empty_text'
  | 'invalid_cursor'
  | 'conflict';

export class ChatError extends Error {
  override name = 'ChatError';
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const REPLY_SNIPPET_CHARS = 140;

/** Whitespace collapsed to single spaces, cut with an ellipsis at `max` characters. */
export function snippet(text: string, max: number = REPLY_SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** URLs per kind: phase 3 chat image routes, note image routes, phase 4 file download. */
export function attachmentView(ref: AttachmentRef): ChatAttachmentView {
  switch (ref.kind) {
    case 'chat_image':
      return { kind: ref.kind, id: ref.id, url: `/api/chat/images/${ref.id}/display`, thumb_url: `/api/chat/images/${ref.id}/thumb` };
    case 'note_image':
      return { kind: ref.kind, id: ref.id, url: `/api/images/${ref.id}/display`, thumb_url: `/api/images/${ref.id}/thumb` };
    case 'note_file':
      return { kind: ref.kind, id: ref.id, url: `/api/files/${ref.id}/download`, thumb_url: null };
  }
}

export function toThreadView(row: ChatThreadRow): ChatThreadView {
  return {
    id: row.id,
    source: row.source,
    brain: row.brain,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** `target` is the row `row.replyTo` names, or null when it is gone (or `row.replyTo` is null). */
export function toMessageView(
  row: ChatMessageRow,
  attachments: readonly AttachmentRef[],
  target: ChatMessageRow | null,
): ChatMessageView {
  let reply: ChatReplyPreview | null = null;
  if (row.replyTo !== null) {
    if (target === null) {
      reply = { id: row.replyTo, role: null, text: '', deleted: true };
    } else {
      const deleted = target.deletedAt !== null;
      reply = { id: target.id, role: target.role, text: deleted ? '' : snippet(target.text), deleted };
    }
  }
  return {
    id: row.id,
    thread_id: row.threadId,
    role: row.role,
    text: row.text,
    source: row.source,
    brain: row.brain,
    reply_to: reply,
    created_at: row.createdAt.toISOString(),
    edited_at: row.editedAt === null ? null : row.editedAt.toISOString(),
    deleted_at: row.deletedAt === null ? null : row.deletedAt.toISOString(),
    attachments: attachments.map(attachmentView),
  };
}
