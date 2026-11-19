import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { guardUtpConnections, installUtpGuard, UTP_GUARD_LOG_EVERY_MS, type UtpConnectionClass } from '../../../../src/directStream/torrent/utpGuard.js';

const reset = (): Error => Object.assign(new Error('UTP_ECONNRESET'), { code: 'UTP_ECONNRESET' });

/** utp-native's Connection as far as the guard goes: `_onclose` emits the kept error, then `close`. */
function fakeConnectionClass(): { Connection: UtpConnectionClass; make: (error: Error | null) => EventEmitter & { _error: Error | null; _onclose(): void } } {
  class Connection extends EventEmitter {
    _error: Error | null = null;
    _onclose(): void {
      if (this._error) this.emit('error', this._error);
      this.emit('close');
    }
  }
  return {
    Connection: Connection as unknown as UtpConnectionClass,
    make: (error) => {
      const c = new Connection();
      c._error = error;
      return c;
    },
  };
}

describe('guardUtpConnections', () => {
  it('without the guard, a reset on a connection nobody listens to throws (what ended the daemon)', () => {
    const { make } = fakeConnectionClass();
    expect(() => make(reset())._onclose()).toThrow('UTP_ECONNRESET');
  });

  it('with the guard, the same close is logged and still emits close', () => {
    const { Connection, make } = fakeConnectionClass();
    const lines: string[] = [];
    expect(guardUtpConnections(Connection, { log: (l) => lines.push(l) })).toBe(true);
    const c = make(reset());
    let closed = 0;
    c.on('close', () => (closed += 1));
    expect(() => c._onclose()).not.toThrow();
    expect(closed).toBe(1);
    expect(lines).toEqual(['[notesd] torrent engine: 1 uTP connection error(s) nobody was listening for (last: UTP_ECONNRESET); ignored']);
  });

  it('leaves a connection that has a listener alone: its listener hears the error once, nothing is logged', () => {
    const { Connection, make } = fakeConnectionClass();
    const lines: string[] = [];
    guardUtpConnections(Connection, { log: (l) => lines.push(l) });
    const c = make(reset());
    const heard: unknown[] = [];
    c.on('error', (e) => heard.push(e));
    c._onclose();
    expect(heard).toHaveLength(1);
    expect(c.listenerCount('error')).toBe(1);
    expect(lines).toEqual([]);
  });

  it('adds nothing to a connection that closes without an error', () => {
    const { Connection, make } = fakeConnectionClass();
    guardUtpConnections(Connection, { log: () => undefined });
    const c = make(null);
    c._onclose();
    expect(c.listenerCount('error')).toBe(0);
  });

  it('logs at most once a minute and counts the errors in between', () => {
    const { Connection, make } = fakeConnectionClass();
    const lines: string[] = [];
    let now = 1_000_000;
    guardUtpConnections(Connection, { log: (l) => lines.push(l), now: () => now });
    make(reset())._onclose();
    make(reset())._onclose();
    make(reset())._onclose();
    expect(lines).toHaveLength(1);
    now += UTP_GUARD_LOG_EVERY_MS;
    make(reset())._onclose();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('3 uTP connection error(s)');
  });

  it('wraps once: a second install does not stack', () => {
    const { Connection, make } = fakeConnectionClass();
    const lines: string[] = [];
    guardUtpConnections(Connection, { log: (l) => lines.push(l) });
    const wrapped = Connection.prototype._onclose;
    expect(guardUtpConnections(Connection, { log: (l) => lines.push(l) })).toBe(true);
    expect(Connection.prototype._onclose).toBe(wrapped);
    make(reset())._onclose();
    expect(lines).toHaveLength(1);
  });

  it('answers false for a class with no _onclose', () => {
    expect(guardUtpConnections({ prototype: {} }, { log: () => undefined })).toBe(false);
  });
});

describe('installUtpGuard', () => {
  it('guards the real utp-native Connection: its own _onclose no longer throws a kept error', () => {
    const lines: string[] = [];
    expect(installUtpGuard((l) => lines.push(l))).toBe(true);
    const Connection = createRequire(import.meta.url)('utp-native/lib/connection') as { prototype: object };
    // A connection as libutp leaves it at close: destroyed with an error, no listener left, not in the socket's list.
    const c = Object.create(Connection.prototype) as EventEmitter & Record<string, unknown> & { _onclose(): void };
    EventEmitter.call(c);
    c._index = -1;
    c._error = reset();
    c._utp = { connections: [], maxConnections: 0, firewall: () => undefined, _closeMaybe: () => undefined };
    let closed = 0;
    c.on('close', () => (closed += 1));
    expect(() => c._onclose()).not.toThrow();
    expect(closed).toBe(1);
  });
});
