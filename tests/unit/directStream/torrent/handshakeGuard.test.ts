import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { guardPeerHandshake, installPeerGuard, type PeerClass } from '../../../../src/directStream/torrent/handshakeGuard.js';

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
