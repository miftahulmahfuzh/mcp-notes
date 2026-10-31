/**
 * The chat brain seam. The HTTP layer (src/http/api.ts POST /api/chat) is the only consumer: it
 * writes the user row, composes the turn from our own rows (src/chat/turn.ts), streams each
 * `ChatEvent` as an SSE event of the same name, then writes the assistant row and `event: done`,
 * or `event: error` when `events` throws. Implementations: the stub (src/chat/stub.ts) and the
 * Agent SDK backend (src/chat/agent.ts). Backends keep no conversation state: everything the
 * model should know about earlier turns is in `turn.text`.
 */

/**
 * One pasted image of a turn, resolved from `chat_images` (src/chat/images.ts `resolveTurnImages`).
 * Phase 3's declaration, kept as is, plus `messageId` (phase 7).
 */
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
  /** The chat message this image belongs to (phase 7). Set: its label reads `[image upload:ID] from [msg:K7F2]`. */
  messageId?: string;
  /**
   * Set for a picture that lives in a note (attached with "chat about this image") instead of a
   * pasted upload: `id` is then `note_images.id`, and the model reads
   * `[note image:ID in note NOTE, image k of n]`.
   */
  note?: { id: string; k: number; n: number };
}

/** Which model family answered. The stub reports none. */
export type ChatBrain = 'claude' | 'glm';

export type ChatEvent =
  /** -> `event: delta {"text": "..."}`. Concatenated, the deltas are the full reply. */
  | { type: 'delta'; text: string }
  /** -> `event: status {"text": "searching notes"}`. `""` clears the caption. */
  | { type: 'status'; text: string };

export interface ChatTurnEnd {
  /** The brain that answered. -> `done.brain`; omitted from `done` when undefined. */
  brain?: ChatBrain;
}

/**
 * One composed user turn: the whole prompt text (context blocks + current message) and the images
 * sent as image blocks. The agent reads each image's preview and shapes the SDK message with
 * phase 3's src/chat/compose.ts (`composeUserTurn` -> `toSdkPrompt`).
 */
export interface ComposedTurn {
  /** src/chat/context.ts layout. Identical for every brain and every attempt. */
  text: string;
  /** Current-turn images, then reply-target images, each with `messageId`. Earlier images are only labels inside `text`. */
  images: readonly ChatTurnImage[];
}

export interface ChatRequest {
  turn: ComposedTurn;
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
