import type { AppDeps } from '../deps.js';
import { ChatImageInputError, chatImageStoreFor, ingestChatImage } from './images.js';

/** Per-image cap for captures (below P3's 50 MB upload cap; Claude Code pastes are a few MB). */
export const MAX_CAPTURED_IMAGE_BYTES = 20 * 1024 * 1024;

export const CAPTURE_SOURCE = 'claude_code' as const;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface ClaudeCodeCaptureInput {
  claudeSession: string;
  userUuid: string;
  /** The prompt as typed, `/n ...`. */
  prompt: string;
  /** The final answer; '' when there was none (no assistant message is written). */
  answer: string;
  promptAt: Date;
  answeredAt: Date;
  images: { mediaType: string; bytes: Buffer }[];
}

export interface CaptureResult {
  /** True when this exchange was captured before: nothing was written now. */
  duplicate: boolean;
  threadId: string;
  userMessageId: string;
  assistantMessageId: string | null;
}

/** An image the chat image store refused; `index` is its position in the request. */
export class CaptureImageError extends Error {
  constructor(
    readonly index: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CaptureImageError';
  }
}

export function captureExternalKey(claudeSession: string, userUuid: string): string {
  return `${claudeSession}:${userUuid}`;
}

/**
 * Stores a Claude Code `/n` exchange as a single-turn `claude_code` thread. Pasted images go
 * into P3's chat image store first (sha-deduped, so a replay stores nothing new; outside the DB
 * transaction because it writes files), then P7's `recordExchange` writes thread, messages and
 * attachments atomically and idempotently on `<claude_session>:<user_uuid>`.
 */
export async function captureClaudeCodeExchange(deps: AppDeps, input: ClaudeCodeCaptureInput): Promise<CaptureResult> {
  const externalKey = captureExternalKey(input.claudeSession, input.userUuid);
  const store = chatImageStoreFor(deps);
  const imageIds: string[] = [];
  for (const [index, image] of input.images.entries()) {
    try {
      const stored = await ingestChatImage(store, {
        bytes: image.bytes,
        originalName: `claude-code-paste-${index + 1}.${EXTENSIONS[image.mediaType] ?? 'bin'}`,
        source: CAPTURE_SOURCE,
        maxBytes: MAX_CAPTURED_IMAGE_BYTES,
      });
      if (!imageIds.includes(stored.image.id)) imageIds.push(stored.image.id);
    } catch (err) {
      if (err instanceof ChatImageInputError) throw new CaptureImageError(index, err.code, err.message);
      throw err;
    }
  }

  const minAnswerMs = input.promptAt.getTime() + 1;
  const assistantAt = input.answeredAt.getTime() < minAnswerMs ? new Date(minAnswerMs) : input.answeredAt;
  const recorded = await deps.chat.recordExchange({
    source: CAPTURE_SOURCE,
    externalKey,
    brain: null,
    user: {
      text: input.prompt,
      createdAt: input.promptAt,
      attachments: imageIds.map((id) => ({ kind: 'chat_image' as const, id })),
    },
    assistant: input.answer.trim() !== '' ? { text: input.answer, createdAt: assistantAt } : null,
  });
  const [userMessageId, assistantMessageId] = recorded.messageIds;
  if (userMessageId === undefined) throw new Error(`captured thread ${recorded.thread.id} has no messages`);
  return {
    duplicate: !recorded.created,
    threadId: recorded.thread.id,
    userMessageId,
    assistantMessageId: assistantMessageId ?? null,
  };
}
