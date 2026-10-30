/**
 * The chat brain seam. The HTTP layer (src/http/api.ts POST /api/chat) is the only consumer:
 * it writes each `ChatEvent` as an SSE event of the same name, then `event: done` with
 * `end()`, or `event: error` when `events` throws. Implementations: the stub
 * (src/chat/stub.ts) and the Agent SDK backend (src/chat/agent.ts, iteration 4).
 */

/** Which model family answered. The stub reports none. */
export type ChatBrain = 'claude' | 'glm';

export type ChatEvent =
  /** -> `event: delta {"text": "..."}`. Concatenated, the deltas are the full reply. */
  | { type: 'delta'; text: string }
  /** -> `event: status {"text": "searching notes"}`. `""` clears the caption. */
  | { type: 'status'; text: string };

export interface ChatTurnEnd {
  /** The thread this reply belongs to (new or continued). -> `done.thread_id`. */
  threadId: string;
  /** The brain that answered. -> `done.brain`; omitted from `done` when undefined. */
  brain?: ChatBrain;
}

export interface ChatRequest {
  /** The user's message, already trimmed and non-empty. */
  message: string;
  /** The thread the client wants to continue, or null to start a new one. */
  threadId: string | null;
  /** Aborted when the HTTP client disconnects. Backends must stop yielding promptly. */
  signal: AbortSignal;
}

export interface ChatTurn {
  /** Events in order. Ends normally, or throws (-> `event: error`). */
  events: AsyncIterable<ChatEvent>;
  /** Valid only after `events` finished without throwing. */
  end(): ChatTurnEnd;
}

export interface ChatBackend {
  reply(request: ChatRequest): Promise<ChatTurn>;
}
