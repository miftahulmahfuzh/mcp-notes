import { describe, expect, it } from 'vitest';
import { batchMovesContext, sessionContextObserver, SessionEvents, type ContextBatchLike } from '../../../src/sessions/events.js';

const usage = { input_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 };
const assistant = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  isSidechain: false,
  message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage },
  ...extra,
});
const batch = (records: Record<string, unknown>[], fromOffset = 100): ContextBatchLike => ({ sessionId: 's-1', fromOffset, records });

describe('SessionEvents', () => {
  it('delivers context events to every listener until it unsubscribes', () => {
    const bus = new SessionEvents();
    const a: string[] = [];
    const b: string[] = [];
    const offA = bus.on((e) => a.push(e.sessionId));
    const offB = bus.on((e) => b.push(e.sessionId));
    bus.emitContext('s-1');
    offA();
    bus.emitContext('s-2');
    offB();
    bus.emitContext('s-3');
    expect(a).toEqual(['s-1']);
    expect(b).toEqual(['s-1', 's-2']);
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('batchMovesContext', () => {
  it('a main-chain assistant record with usage moves the context', () => {
    expect(batchMovesContext(batch([{ type: 'user' }, assistant()]))).toBe(true);
    expect(batchMovesContext(batch([assistant({ isSidechain: undefined })]))).toBe(true);
  });

  it('sidechain, usage-less, user and bookkeeping records do not', () => {
    expect(batchMovesContext(batch([assistant({ isSidechain: true })]))).toBe(false);
    expect(batchMovesContext(batch([{ type: 'assistant', message: { id: 'm', content: [] } }]))).toBe(false);
    expect(batchMovesContext(batch([{ type: 'user', message: { role: 'user', content: 'hi' } }, { type: 'ai-title', aiTitle: 't' }]))).toBe(false);
    expect(batchMovesContext(batch([]))).toBe(false);
  });

  it('a read from byte 0 always may (first read, shrunk file, fork re-read)', () => {
    expect(batchMovesContext(batch([], 0))).toBe(true);
  });
});

describe('sessionContextObserver', () => {
  it('emits the batch session id only when the batch can move the context', () => {
    const bus = new SessionEvents();
    const seen: string[] = [];
    bus.on((e) => seen.push(e.sessionId));
    const observer = sessionContextObserver(bus);
    observer.onBatch(batch([assistant({ isSidechain: true })]));
    observer.onBatch({ sessionId: 's-9', fromOffset: 500, records: [assistant()] });
    expect(seen).toEqual(['s-9']);
  });
});
