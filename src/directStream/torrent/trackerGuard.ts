import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Keeps an HTTP tracker's late answer from ending the daemon: `DOMException [AbortError]: This operation was aborted`
 * at bittorrent-tracker's `HTTPTracker` `destroyCleanup` (it ended the soak's daemon, 2026-11-20 11:14 WIB, while
 * Jujutsu Kaisen's racers were opening). `_request` is an async function whose `await res.arrayBuffer()` sits outside
 * its try: when the torrent is left (it lost the race, its file did not fit) while a tracker's body is still coming,
 * the tracker's destroy aborts the request, the read rejects, and nothing catches the rejected promise. The guard
 * wraps `_request`: a rejection after the tracker was destroyed, or an abort, is dropped (there is nobody left to
 * tell); any other is handed to the request's own callback, as the library does for a failed fetch.
 */
export interface TrackerLike {
  destroyed?: boolean;
}

type Request = (this: TrackerLike, url: string, params: unknown, cb: (err: Error | null, data?: unknown) => void) => unknown;

export interface TrackerClass {
  prototype: { _request?: Request; __notesdGuarded?: true };
}

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError';

/** Wraps `_request` once. False when the class has none (bittorrent-tracker changed: look at the guard again). */
export function guardTrackerRequest(Tracker: TrackerClass, log: (line: string) => void = () => undefined): boolean {
  const proto = Tracker.prototype;
  if (proto.__notesdGuarded === true) return true;
  const request = proto._request;
  if (typeof request !== 'function') return false;
  proto._request = function guardedRequest(this: TrackerLike, url, params, cb) {
    const out = request.call(this, url, params, cb);
    if (out instanceof Promise) {
      out.catch((err: unknown) => {
        if (this.destroyed === true || isAbort(err)) return;
        try {
          cb(err instanceof Error ? err : new Error(String(err)));
        } catch (cbErr) {
          log(`[notesd] torrent engine: a tracker's failure could not be reported: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`);
        }
      });
    }
    return out;
  };
  proto.__notesdGuarded = true;
  return true;
}

/** Installs the tracker guard on the bittorrent-tracker this process loads. Never throws. */
export async function installTrackerGuard(log: (line: string) => void): Promise<boolean> {
  try {
    // The package exports only its entry points; the file sits beside its `client.js`, which torrent-discovery imports.
    let client: string;
    try {
      client = import.meta.resolve('bittorrent-tracker/client');
    } catch {
      client = new URL('../bittorrent-tracker/client.js', pathToFileURL(createRequire(import.meta.url).resolve('webtorrent/package.json'))).href;
    }
    const mod = (await import(new URL('./lib/client/http-tracker.js', client).href)) as { default?: TrackerClass };
    if (mod.default !== undefined && guardTrackerRequest(mod.default, log)) return true;
  } catch {
    // Falls through to the log line.
  }
  log("[notesd] torrent engine: bittorrent-tracker's HTTPTracker._request could not be guarded; a tracker answer after its torrent left may end the daemon (see trackerGuard.ts)");
  return false;
}
