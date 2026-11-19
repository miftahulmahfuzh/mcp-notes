import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Keeps a peer's uTP socket error from ending the daemon.
 *
 * utp-native's Connection keeps the error it was destroyed with (`UTP_ECONNRESET`, `UTP_ETIMEDOUT`, ...) and emits
 * it from `_onclose`, when libutp reports the socket closed. By then webtorrent has usually let go of the peer and
 * removed its listeners, and an `error` nobody listens to is an uncaught exception: one peer resetting a connection
 * ended notesd, and with it every stream session (the journal of 2026-11-19 18:11, and the soak's own engine).
 *
 * The guard wraps `Connection.prototype._onclose`: a connection about to emit an error with no listener gets one
 * first, so the error is counted and logged instead of thrown. A connection webtorrent still listens to is left
 * exactly as it was. Installed once per process, by the engine, before the first swarm is joined.
 */

/** The part of utp-native's Connection the guard reads. */
export interface UtpConnectionLike {
  _error?: unknown;
  listenerCount(event: 'error'): number;
  on(event: 'error', listener: (err: unknown) => void): unknown;
}

export interface UtpConnectionClass {
  prototype: { _onclose?: (this: UtpConnectionLike) => void; __notesdGuarded?: true };
}

/** At most one log line per this long; the errors in between are counted into the next line. */
export const UTP_GUARD_LOG_EVERY_MS = 60_000;

const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
};

/**
 * Wraps `_onclose` of the given Connection class (once: a second call changes nothing). False when the class has
 * no `_onclose` to wrap, which means utp-native changed and the guard must be looked at again.
 */
export function guardUtpConnections(Connection: UtpConnectionClass, options: { log: (line: string) => void; now?: () => number }): boolean {
  const proto = Connection.prototype;
  if (proto.__notesdGuarded === true) return true;
  const onclose = proto._onclose;
  if (typeof onclose !== 'function') return false;
  const now = options.now ?? Date.now;
  let unsaid = 0;
  let saidAt = Number.NEGATIVE_INFINITY;
  const heard = (err: unknown): void => {
    unsaid += 1;
    if (now() - saidAt < UTP_GUARD_LOG_EVERY_MS) return;
    options.log(`[notesd] torrent engine: ${unsaid} uTP connection error(s) nobody was listening for (last: ${codeOf(err)}); ignored`);
    unsaid = 0;
    saidAt = now();
  };
  proto._onclose = function guardedOnclose(this: UtpConnectionLike): void {
    if (this._error !== null && this._error !== undefined && this.listenerCount('error') === 0) this.on('error', heard);
    onclose.call(this);
  };
  proto.__notesdGuarded = true;
  return true;
}

/**
 * Installs the guard on the utp-native this process loads (the one webtorrent requires). Never throws: without
 * utp-native there is no uTP and nothing to guard; a utp-native whose Connection cannot be wrapped is logged.
 */
export function installUtpGuard(log: (line: string) => void): boolean {
  let Connection: UtpConnectionClass;
  try {
    Connection = createRequire(import.meta.url)('utp-native/lib/connection') as UtpConnectionClass;
  } catch {
    return false;
  }
  const guarded = guardUtpConnections(Connection, { log });
  if (!guarded) log('[notesd] torrent engine: utp-native has no Connection._onclose to guard; a peer\'s uTP error may end the daemon (see utpGuard.ts)');
  return guarded;
}

/**
 * The second thing that ended a process from inside the engine (the soak's, 2026-11-19 22:16):
 * `TypeError: Cannot read properties of null (reading 'dht')` at webtorrent's `Peer.handshake`. A torrent that is
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
  log("[notesd] torrent engine: webtorrent's Peer.handshake could not be guarded; a peer of a torrent already left may end the daemon (see utpGuard.ts)");
  return false;
}
