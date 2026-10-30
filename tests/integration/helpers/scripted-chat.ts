import type {
  ChatBackend,
  ChatEvent,
  ChatRequest,
  ChatTurn,
  ChatTurnEnd,
} from '../../../src/chat/backend.js';

/** One scripted step: an event to yield, an error to throw, or "wait until the request aborts". */
export type ScriptStep = ChatEvent | { type: 'throw'; message: string } | { type: 'hang' };

export interface ChatScript {
  steps: ScriptStep[];
  /** What `end()` returns. Default: `{ threadId: request.threadId ?? 'fake-thread' }` (no brain). */
  end?: ChatTurnEnd;
  /** When set, `reply()` itself rejects with this message before any event. */
  rejectWith?: string;
}

export interface ScriptedChatBackend extends ChatBackend {
  /** Queues a script for the next `reply()`. A reply with nothing queued gets an empty script. */
  push(script: ChatScript): void;
  /** Every request received, in arrival order (signals included, so tests can see aborts). */
  readonly requests: ChatRequest[];
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function* play(steps: ScriptStep[], signal: AbortSignal): AsyncGenerator<ChatEvent> {
  for (const step of steps) {
    if (signal.aborted) return;
    if (step.type === 'throw') throw new Error(step.message);
    if (step.type === 'hang') {
      await untilAborted(signal);
      return;
    }
    yield step;
  }
}

/** A `ChatBackend` that replays queued scripts: the fake injected into /api/chat tests. */
export function createScriptedChatBackend(): ScriptedChatBackend {
  const queue: ChatScript[] = [];
  const requests: ChatRequest[] = [];
  return {
    requests,
    push(script: ChatScript): void {
      queue.push(script);
    },
    async reply(request: ChatRequest): Promise<ChatTurn> {
      requests.push(request);
      const script = queue.shift() ?? { steps: [] };
      if (script.rejectWith !== undefined) throw new Error(script.rejectWith);
      const end: ChatTurnEnd = script.end ?? { threadId: request.threadId ?? 'fake-thread' };
      return { events: play(script.steps, request.signal), end: () => end };
    },
  };
}
