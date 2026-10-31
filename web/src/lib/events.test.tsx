import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENTS_URL, subscribeEvents } from './events';

class FakeES {
  static all: FakeES[] = [];
  closed = false;
  private l = new Map<string, Array<(e?: unknown) => void>>();
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (e?: unknown) => void) {
    this.l.set(type, [...(this.l.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: string) {
    for (const fn of this.l.get(type) ?? []) fn({ data });
  }
}

afterEach(() => {
  FakeES.all = [];
  vi.unstubAllGlobals();
});

describe('subscribeEvents', () => {
  it('shares one connection between subscribers and fans each event out', () => {
    vi.stubGlobal('EventSource', FakeES);
    const notes = vi.fn();
    const chats = vi.fn();
    const offA = subscribeEvents('note', notes);
    const offB = subscribeEvents('chat', chats);
    expect(FakeES.all).toHaveLength(1);
    expect(FakeES.all[0]?.url).toBe(EVENTS_URL);
    FakeES.all[0]?.emit('chat', '{"op":"created"}');
    expect(chats).toHaveBeenCalledWith({ data: '{"op":"created"}' });
    expect(notes).not.toHaveBeenCalled();
    offA();
    offB();
  });

  it('closes on the last unsubscribe and opens a fresh source next time', () => {
    vi.stubGlobal('EventSource', FakeES);
    const offA = subscribeEvents('note', vi.fn());
    const offB = subscribeEvents('note', vi.fn());
    offA();
    offA(); // idempotent
    expect(FakeES.all[0]?.closed).toBe(false);
    offB();
    expect(FakeES.all[0]?.closed).toBe(true);
    const fn = vi.fn();
    const offC = subscribeEvents('note', fn);
    expect(FakeES.all).toHaveLength(2);
    FakeES.all[1]?.emit('note');
    expect(fn).toHaveBeenCalledTimes(1);
    offC();
  });

  it('is a no-op without EventSource', () => {
    vi.stubGlobal('EventSource', undefined);
    const off = subscribeEvents('note', vi.fn());
    expect(() => off()).not.toThrow();
  });
});
