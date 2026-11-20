import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Keeps a late peer from ending the daemon: `TypeError: Cannot read properties of null (reading 'dht')` at
 * webtorrent's `Peer.handshake` (it ended the soak's engine, 2026-11-19 22:16). A torrent that is
 * left (a swarm probe, a torrent that lost the race) sets its `client` to null, and an encrypted peer whose
 * handshake bytes arrive just after still calls `handshake()`, which reads `this.swarm.client.dht`. Thrown inside
 * a stream's write, it is an uncaught exception. The guard wraps `Peer.prototype.handshake`: for a peer whose
 * torrent is gone it does nothing, which is all there is to do for a torrent already left.
 */
export interface PeerLike {
  destroyed?: boolean;
  swarm?: { client?: unknown; destroyed?: boolean } | null;
}

export interface PeerClass {
  prototype: { handshake?: (this: PeerLike) => void; __notesdGuarded?: true };
}

/** Wraps `handshake` once. False when the class has none (webtorrent changed: look at the guard again). */
export function guardPeerHandshake(Peer: PeerClass): boolean {
  const proto = Peer.prototype;
  if (proto.__notesdGuarded === true) return true;
  const handshake = proto.handshake;
  if (typeof handshake !== 'function') return false;
  proto.handshake = function guardedHandshake(this: PeerLike): void {
    const swarm = this.swarm;
    if (this.destroyed === true || swarm === null || swarm === undefined || swarm.destroyed === true || swarm.client === null || swarm.client === undefined) return;
    handshake.call(this);
  };
  proto.__notesdGuarded = true;
  return true;
}

/** Installs the handshake guard on the webtorrent this process loads. Never throws. */
export async function installPeerGuard(log: (line: string) => void): Promise<boolean> {
  try {
    const main = createRequire(import.meta.url).resolve('webtorrent');
    const mod = (await import(new URL('./lib/peer.js', pathToFileURL(main)).href)) as { default?: PeerClass };
    if (mod.default !== undefined && guardPeerHandshake(mod.default)) return true;
  } catch {
    // Falls through to the log line.
  }
  log("[notesd] torrent engine: webtorrent's Peer.handshake could not be guarded; a peer of a torrent already left may end the daemon (see handshakeGuard.ts)");
  return false;
}
