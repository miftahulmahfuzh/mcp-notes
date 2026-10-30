/**
 * The chat brain seam. Iteration 3 ships a stub (src/chat/stub.ts); iteration 4 replaces
 * only the implementation passed to apiRoutes(). The HTTP layer streams whatever
 * `deltas` yields as `event: delta` and then sends `event: done` with `threadId`.
 */
export interface ChatRequest {
  /** The user's message, already trimmed and non-empty. */
  message: string;
  /** The thread the client wants to continue, or null to start a new one. */
  threadId: string | null;
  /** Aborted when the HTTP client disconnects. Backends must stop yielding promptly. */
  signal: AbortSignal;
}

export interface ChatTurn {
  /** The thread this reply belongs to (new or continued). Sent in `event: done`. */
  threadId: string;
  /** Text fragments in order. Their concatenation is the full reply. */
  deltas: AsyncIterable<string>;
}

export interface ChatBackend {
  reply(request: ChatRequest): Promise<ChatTurn>;
}
