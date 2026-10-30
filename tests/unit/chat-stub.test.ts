import { describe, expect, it } from 'vitest';
import { STUB_REPLY, createStubChatBackend, splitIntoDeltas } from '../../src/chat/stub.js';

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const part of iterable) out.push(part);
  return out;
}

describe('chat stub', () => {
  it('splits text into word deltas that rejoin exactly', () => {
    const parts = splitIntoDeltas(STUB_REPLY);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.join('')).toBe(STUB_REPLY);
  });

  it('mentions iteration 4', () => {
    expect(STUB_REPLY).toMatch(/iteration 4/);
  });

  it('streams the fixed reply and starts a new thread when none is given', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({
      message: 'hello',
      threadId: null,
      signal: new AbortController().signal,
    });
    expect(turn.threadId).toMatch(/^stub-/);
    expect((await collect(turn.deltas)).join('')).toBe(STUB_REPLY);
  });

  it('keeps a given thread id', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({
      message: 'hello',
      threadId: 'thread-1',
      signal: new AbortController().signal,
    });
    expect(turn.threadId).toBe('thread-1');
  });

  it('stops yielding after abort', async () => {
    const backend = createStubChatBackend({ delayMs: 5 });
    const controller = new AbortController();
    const turn = await backend.reply({ message: 'x', threadId: null, signal: controller.signal });
    const out: string[] = [];
    for await (const part of turn.deltas) {
      out.push(part);
      if (out.length === 2) controller.abort();
    }
    expect(out).toHaveLength(2);
  });
});
