import type { ChatMessage } from '../types';

/** A wire `ChatMessage`: a wall user message in thread T1 at 2026-10-31 01:00 UTC unless overridden. */
export function makeMessage(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    thread_id: 'T1',
    role: 'user',
    text: `message ${id}`,
    source: 'wall',
    brain: null,
    reply_to: null,
    created_at: '2026-10-31T01:00:00.000Z',
    edited_at: null,
    deleted_at: null,
    attachments: [],
    ...over,
  };
}
