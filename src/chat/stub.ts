import { randomUUID } from 'node:crypto';
import type { ChatBackend, ChatEvent, ChatRequest, ChatTurn } from './backend.js';

export const STUB_REPLY =
  'The chat brain arrives in iteration 4. Until then this panel only echoes that fact.';

export interface StubChatOptions {
  /** Delay before each delta, in ms. Default 40. Tests pass 0. */
  delayMs?: number;
}

/** Splits text into word-sized pieces that keep their trailing whitespace. */
export function splitIntoDeltas(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function* streamDeltas(
  parts: string[],
  delayMs: number,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  for (const part of parts) {
    if (signal.aborted) return;
    if (delayMs > 0) await sleep(delayMs, signal);
    if (signal.aborted) return;
    yield { type: 'delta', text: part };
  }
}

/** A fixed reply as word deltas. No status events, no brain: `done` carries only the thread id. */
export function createStubChatBackend(options: StubChatOptions = {}): ChatBackend {
  const delayMs = options.delayMs ?? 40;
  return {
    async reply(request: ChatRequest): Promise<ChatTurn> {
      const threadId = request.threadId ?? `stub-${randomUUID()}`;
      return {
        events: streamDeltas(splitIntoDeltas(STUB_REPLY), delayMs, request.signal),
        end: () => ({ threadId }),
      };
    },
  };
}
