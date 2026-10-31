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

/** One pasted image of a turn, resolved by the HTTP layer from `image_ids` (src/chat/images.ts `resolveTurnImages`). */
export interface ChatTurnImage {
  /** `chat_images.id` (`A-B32`). The model sees it as `[image upload:ID]`. */
  id: string;
  /** Absolute path of the `preview` derivative (`cache/c_<id>/preview.jpg`: long edge <= 1568 px, under 3.75 MB). */
  previewPath: string;
  /** Mime of the preview file. */
  previewMime: 'image/jpeg';
  /** Size of the original, display-oriented. */
  width: number;
  height: number;
  originalName: string | null;
}

export interface ChatRequest {
  /** The user's message, trimmed. Empty only when `images` is non-empty. */
  message: string;
  /** Images pasted with this message, in the order the user sent them. Empty for a text-only message. */
  images: readonly ChatTurnImage[];
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
