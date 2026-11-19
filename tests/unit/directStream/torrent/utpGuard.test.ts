import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { guardPeerHandshake, guardUtpConnections, installPeerGuard, installUtpGuard, UTP_GUARD_LOG_EVERY_MS, type PeerClass, type UtpConnectionClass } from '../../../../src/directStream/torrent/utpGuard.js';

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

describe('guardPeerHandshake', () => {
  /** webtorrent's Peer as far as the guard goes: handshake reads the torrent's client. */
  function fakePeerClass(): { Peer: PeerClass; make: (swarm: unknown, destroyed?: boolean) => { handshake(): void; sent: number } } {
    class Peer {
      sent = 0;
      destroyed = false;
      swarm: { client: { dht: unknown } | null; destroyed?: boolean } | null = null;
      handshake(): void {
        // As peer.js: `!!this.swarm.client.dht`.
        void (this.swarm as { client: { dht: unknown } }).client.dht;
        this.sent += 1;
      }
    }
    return {
      Peer: Peer as unknown as PeerClass,
      make: (swarm, destroyed = false) => {
        const p = new Peer();
        p.swarm = swarm as Peer['swarm'];
        p.destroyed = destroyed;
        return p;
      },
    };
  }

  it("without the guard, a handshake for a torrent already left throws (what ended the soak's engine)", () => {
    const { make } = fakePeerClass();
    expect(() => make({ client: null }).handshake()).toThrow(TypeError);
  });

  it('with the guard, that handshake does nothing; a live torrent still shakes hands', () => {
    const { Peer, make } = fakePeerClass();
    expect(guardPeerHandshake(Peer)).toBe(true);
    for (const gone of [make({ client: null }), make(null), make({ client: {}, destroyed: true }), make({ client: { dht: {} } }, true)]) {
      expect(() => gone.handshake()).not.toThrow();
      expect(gone.sent).toBe(0);
    }
    const live = make({ client: { dht: {} } });
    live.handshake();
    expect(live.sent).toBe(1);
  });

  it('wraps once, and answers false for a class with no handshake', () => {
    const { Peer } = fakePeerClass();
    guardPeerHandshake(Peer);
    const wrapped = Peer.prototype.handshake;
    guardPeerHandshake(Peer);
    expect(Peer.prototype.handshake).toBe(wrapped);
    expect(guardPeerHandshake({ prototype: {} })).toBe(false);
  });

  it("guards the real webtorrent Peer: its handshake for a torrent already left no longer throws", async () => {
    const lines: string[] = [];
    expect(await installPeerGuard((l) => lines.push(l))).toBe(true);
    expect(lines).toEqual([]);
    const main = createRequire(import.meta.url).resolve('webtorrent');
    const Peer = ((await import(new URL('./lib/peer.js', `file://${main}`).href)) as { default: { prototype: { handshake(): void } } }).default;
    const peer = Object.create(Peer.prototype) as { swarm: unknown; destroyed: boolean; handshake(): void };
    peer.destroyed = false;
    peer.swarm = { private: false, client: null, infoHash: 'x' };
    expect(() => peer.handshake()).not.toThrow();
  });
});
