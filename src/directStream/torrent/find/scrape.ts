import { createSocket } from 'node:dgram';

/**
 * Asks UDP trackers how many seeders and leechers they know for a list of info hashes (BEP 15 "scrape"),
 * without joining any swarm: nothing is announced, no peer is contacted and no file is asked for. The index's
 * seed count is a claim; this is what the trackers hold now. A tracker that does not know a hash answers 0
 * for it, so one tracker's 0 says little: `trackers` counts how many answered for the hash.
 */

export interface SwarmCount {
  /** The most seeders any one tracker knows. */
  seeders: number;
  /** The leechers that same tracker knows. */
  leechers: number;
  /** How many trackers answered for this hash. */
  trackers: number;
}

export type ScrapeTrackers = (infoHashes: readonly string[], trackers: readonly string[], options?: { timeoutMs?: number }) => Promise<Map<string, SwarmCount>>;

/** The whole scrape answers within this, with whatever arrived. */
export const SCRAPE_TIMEOUT_MS = 1_500;
/**
 * Trackers asked at most per scrape. They are all asked at once on one socket, so more of them cost no time:
 * the scrape still answers within SCRAPE_TIMEOUT_MS.
 */
export const SCRAPE_MAX_TRACKERS = 16;
/** Of those places, the ones kept for the public tracker lists' trackers (trackerLists.ts), asked after the others. */
export const SCRAPE_LIST_SLOTS = 6;
/** Info hashes per request (BEP 15: about 74 fit one packet). */
export const SCRAPE_MAX_HASHES = 70;
/** A candidate is called dead only when at least this many trackers answered and none knows a seeder. */
export const SCRAPE_MIN_ANSWERS = 2;

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_SCRAPE = 2;
const HEX_HASH = /^[0-9a-f]{40}$/;

/** `host:port` of a `udp://` tracker address, lower case; null for any other address. */
export function udpTrackerOf(url: string): { host: string; port: number; key: string } | null {
  const m = /^udp:\/\/(\[[0-9a-f:]+\]|[^/:\s]+):(\d{1,5})(?:\/.*)?$/i.exec(url.trim());
  if (m?.[1] === undefined || m[2] === undefined) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  const host = m[1].replace(/^\[|\]$/g, '').toLowerCase();
  return { host, port, key: `${host}:${port}` };
}

/** The distinct UDP trackers of a list of addresses, in their order, at most `max`. */
export function udpTrackers(urls: readonly string[], max = SCRAPE_MAX_TRACKERS): { host: string; port: number; key: string }[] {
  const seen = new Map<string, { host: string; port: number; key: string }>();
  for (const url of urls) {
    const t = udpTrackerOf(url);
    if (t !== null && !seen.has(t.key)) seen.set(t.key, t);
    if (seen.size >= max) break;
  }
  return [...seen.values()];
}

/** The part of node:dgram's socket the scraper uses; tests pass a fake. */
export interface ScrapeSocket {
  send(message: Uint8Array, port: number, host: string, callback?: (err: Error | null) => void): void;
  on(event: 'message', listener: (message: Buffer, from: { address: string; port: number }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(): void;
}

function transactionId(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** The connect request: the protocol id, action 0 and a transaction id. */
export function connectPacket(tid: number): Buffer {
  const packet = Buffer.alloc(16);
  packet.writeBigUInt64BE(PROTOCOL_ID, 0);
  packet.writeUInt32BE(ACTION_CONNECT, 8);
  packet.writeUInt32BE(tid, 12);
  return packet;
}

/** The scrape request: the connection id, action 2, a transaction id and the hashes, 20 bytes each. */
export function scrapePacket(connectionId: Uint8Array, tid: number, infoHashes: readonly string[]): Buffer {
  const head = Buffer.alloc(16);
  Buffer.from(connectionId).copy(head, 0, 0, 8);
  head.writeUInt32BE(ACTION_SCRAPE, 8);
  head.writeUInt32BE(tid, 12);
  return Buffer.concat([head, ...infoHashes.map((h) => Buffer.from(h, 'hex'))]);
}

/** A scrape answer's counts, one per hash asked, in order; null when the packet is not a whole scrape answer. */
export function readScrape(message: Uint8Array, hashes: number): { seeders: number; leechers: number }[] | null {
  const packet = Buffer.from(message);
  if (packet.length < 8 + hashes * 12 || packet.readUInt32BE(0) !== ACTION_SCRAPE) return null;
  const out: { seeders: number; leechers: number }[] = [];
  for (let i = 0; i < hashes; i++) out.push({ seeders: packet.readUInt32BE(8 + i * 12), leechers: packet.readUInt32BE(8 + i * 12 + 8) });
  return out;
}

/**
 * The scraper over UDP. One socket per call; every tracker is asked at once and the call answers when all have
 * answered or the time is up. Never throws: a tracker that does not answer simply is not counted.
 */
export function udpScraper(deps: { socket?: () => ScrapeSocket; now?: () => number } = {}): ScrapeTrackers {
  const open = deps.socket ?? ((): ScrapeSocket => createSocket('udp4') as unknown as ScrapeSocket);
  return (infoHashes, trackers, options = {}) => {
    const hashes = [...new Set(infoHashes.map((h) => h.toLowerCase()))].filter((h) => HEX_HASH.test(h)).slice(0, SCRAPE_MAX_HASHES);
    const asked = udpTrackers(trackers);
    const counts = new Map<string, SwarmCount>();
    if (hashes.length === 0 || asked.length === 0) return Promise.resolve(counts);
    return new Promise((resolve) => {
      let socket: ScrapeSocket;
      try {
        socket = open();
      } catch {
        resolve(counts);
        return;
      }
      /** Transaction id -> the tracker it was sent to, and whether it is the connect or the scrape. */
      const pending = new Map<number, { tracker: (typeof asked)[number]; step: 'connect' | 'scrape' }>();
      let left = asked.length;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve(counts);
      };
      const timer = setTimeout(finish, options.timeoutMs ?? SCRAPE_TIMEOUT_MS);
      const gone = (): void => {
        left -= 1;
        if (left <= 0) finish();
      };
      socket.on('error', finish);
      socket.on('message', (message) => {
        if (done || message.length < 8) return;
        const tid = message.readUInt32BE(4);
        const sent = pending.get(tid);
        if (sent === undefined) return;
        pending.delete(tid);
        const action = message.readUInt32BE(0);
        if (sent.step === 'connect') {
          if (action !== ACTION_CONNECT || message.length < 16) return gone();
          const next = transactionId();
          pending.set(next, { tracker: sent.tracker, step: 'scrape' });
          socket.send(scrapePacket(message.subarray(8, 16), next, hashes), sent.tracker.port, sent.tracker.host, (err) => {
            if (err !== null && err !== undefined && pending.delete(next)) gone();
          });
          return;
        }
        const read = readScrape(message, hashes.length);
        if (read !== null) {
          hashes.forEach((hash, i) => {
            const got = read[i]!;
            const had = counts.get(hash);
            if (had === undefined) counts.set(hash, { seeders: got.seeders, leechers: got.leechers, trackers: 1 });
            else counts.set(hash, got.seeders > had.seeders ? { seeders: got.seeders, leechers: got.leechers, trackers: had.trackers + 1 } : { ...had, trackers: had.trackers + 1 });
          });
        }
        gone();
      });
      for (const tracker of asked) {
        const tid = transactionId();
        pending.set(tid, { tracker, step: 'connect' });
        socket.send(connectPacket(tid), tracker.port, tracker.host, (err) => {
          if (err !== null && err !== undefined && pending.delete(tid)) gone();
        });
      }
    });
  };
}

/** The UDP addresses of `urls` whose tracker is not in `taken` yet, in order, at most `max`; marks them taken. */
function distinctUdp(urls: readonly string[], max: number, taken: Set<string>): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (out.length >= max) break;
    const t = udpTrackerOf(url);
    if (t === null || taken.has(t.key)) continue;
    taken.add(t.key);
    out.push(url);
  }
  return out;
}

/**
 * The trackers one scrape asks: the distinct UDP trackers of `first` (the defaults, the tracker book, the
 * candidates' own), then those of `then` (the public lists' trackers), at most `max`. When `then` has any, the
 * last `slots` places are kept for it, so the list trackers are really asked.
 */
export function scrapeTrackerOrder(first: readonly string[], then: readonly string[], max = SCRAPE_MAX_TRACKERS, slots = SCRAPE_LIST_SLOTS): string[] {
  const taken = new Set<string>();
  const listed = then.filter((url) => udpTrackerOf(url) !== null);
  const head = distinctUdp(first, listed.length === 0 ? max : Math.max(0, max - slots), taken);
  return [...head, ...distinctUdp(listed, max - head.length, taken)];
}

/** Asks UDP trackers for a connect only: answers the addresses, as given, whose tracker answered one. */
export type ConnectTrackers = (trackers: readonly string[], options?: { timeoutMs?: number }) => Promise<Set<string>>;

/** The whole connect check answers within this, with whatever arrived. */
export const CONNECT_TIMEOUT_MS = 3_000;
/** Trackers asked at most per connect check. */
export const CONNECT_MAX_TRACKERS = 100;

/**
 * The BEP 15 connect alone, over UDP: tells a tracker that answers from one that does not, and nothing else. No
 * info hash is sent, nothing is announced and no peer is contacted (the public tracker lists, trackerLists.ts).
 * One socket per call; every tracker is asked at once and the call answers when all have answered or the time is
 * up. Never throws.
 */
export function udpConnector(deps: { socket?: () => ScrapeSocket } = {}): ConnectTrackers {
  const open = deps.socket ?? ((): ScrapeSocket => createSocket('udp4') as unknown as ScrapeSocket);
  return (trackers, options = {}) => {
    const asked = udpTrackers(trackers, CONNECT_MAX_TRACKERS);
    /** Tracker key -> the first address given for it. */
    const addressOf = new Map<string, string>();
    for (const url of trackers) {
      const t = udpTrackerOf(url);
      if (t !== null && !addressOf.has(t.key)) addressOf.set(t.key, url);
    }
    const answered = new Set<string>();
    if (asked.length === 0) return Promise.resolve(answered);
    return new Promise((resolve) => {
      let socket: ScrapeSocket;
      try {
        socket = open();
      } catch {
        resolve(answered);
        return;
      }
      /** Transaction id -> the key of the tracker it was sent to. */
      const pending = new Map<number, string>();
      let left = asked.length;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve(answered);
      };
      const timer = setTimeout(finish, options.timeoutMs ?? CONNECT_TIMEOUT_MS);
      const gone = (): void => {
        left -= 1;
        if (left <= 0) finish();
      };
      socket.on('error', finish);
      socket.on('message', (message) => {
        if (done || message.length < 8) return;
        const tid = message.readUInt32BE(4);
        const key = pending.get(tid);
        if (key === undefined) return;
        pending.delete(tid);
        const address = addressOf.get(key);
        if (message.readUInt32BE(0) === ACTION_CONNECT && message.length >= 16 && address !== undefined) answered.add(address);
        gone();
      });
      for (const tracker of asked) {
        const tid = transactionId();
        pending.set(tid, tracker.key);
        socket.send(connectPacket(tid), tracker.port, tracker.host, (err) => {
          if (err !== null && err !== undefined && pending.delete(tid)) gone();
        });
      }
    });
  };
}

/** True when enough trackers answered for the hash and none of them knows a seeder. */
export function looksDead(count: SwarmCount | undefined): boolean {
  return count !== undefined && count.trackers >= SCRAPE_MIN_ANSWERS && count.seeders === 0;
}

/** The candidates in their order, with those whose swarm the trackers call dead moved to the end. */
export function deadLast<T extends { infoHash: string }>(candidates: readonly T[], counts: ReadonlyMap<string, SwarmCount>): T[] {
  const alive = candidates.filter((c) => !looksDead(counts.get(c.infoHash)));
  return [...alive, ...candidates.filter((c) => looksDead(counts.get(c.infoHash)))];
}
