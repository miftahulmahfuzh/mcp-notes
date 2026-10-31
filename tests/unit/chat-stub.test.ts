import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../src/chat/backend.js';
import { STUB_REPLY, createStubChatBackend, splitIntoDeltas } from '../../src/chat/stub.js';

async function collect(iterable: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

function texts(events: ChatEvent[]): string {
  return events.map((e) => e.text).join('');
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

  it('streams the fixed reply as delta events only', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({ turn: { text: 'hello', images: [] }, signal: new AbortController().signal });
    const events = await collect(turn.events);
    expect(events.every((e) => e.type === 'delta')).toBe(true);
    expect(texts(events)).toBe(STUB_REPLY);
    expect(turn.end()).toEqual({});
  });

  it('reports no brain', async () => {
    const backend = createStubChatBackend({ delayMs: 0 });
    const turn = await backend.reply({ turn: { text: 'hi', images: [] }, signal: new AbortController().signal });
    await collect(turn.events);
    const end = turn.end();
    expect(end.brain).toBeUndefined();
    expect('brain' in end).toBe(false);
  });

  it('stops yielding after abort', async () => {
    const backend = createStubChatBackend({ delayMs: 5 });
    const controller = new AbortController();
    const turn = await backend.reply({ turn: { text: 'x', images: [] }, signal: controller.signal });
    const out: ChatEvent[] = [];
    for await (const event of turn.events) {
      out.push(event);
      if (out.length === 2) controller.abort();
    }
    expect(out).toHaveLength(2);
  });
});
