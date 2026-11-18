import { describe, expect, it } from 'vitest';
import { connectPacket, deadLast, looksDead, readScrape, SCRAPE_LIST_SLOTS, SCRAPE_MAX_TRACKERS, scrapePacket, scrapeTrackerOrder, udpConnector, udpScraper, udpTrackerOf, udpTrackers, type ScrapeSocket } from '../../../../../src/directStream/torrent/find/scrape.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** A fake UDP socket: each tracker host answers the connect, then the scrape with its counts, or stays silent. */
function fakeSocket(trackers: Record<string, Array<[seeders: number, completed: number, leechers: number]> | 'silent'>) {
  const sent: Array<{ host: string; port: number; action: number }> = [];
  let onMessage: (message: Buffer, from: { address: string; port: number }) => void = () => undefined;
  let closed = 0;
  const socket: ScrapeSocket = {
    send(message, port, host, callback) {
      const packet = Buffer.from(message);
      const connect = packet.readBigUInt64BE(0) === 0x41727101980n && packet.readUInt32BE(8) === 0;
      const tid = packet.readUInt32BE(12);
      sent.push({ host, port, action: connect ? 0 : 2 });
      callback?.(null);
      const answer = trackers[host];
      if (answer === undefined || answer === 'silent') return;
      queueMicrotask(() => {
        if (connect) {
          const reply = Buffer.alloc(16);
          reply.writeUInt32BE(0, 0);
          reply.writeUInt32BE(tid, 4);
          reply.writeBigUInt64BE(77n, 8);
          onMessage(reply, { address: host, port });
          return;
        }
        expect(packet.readBigUInt64BE(0)).toBe(77n);
        const reply = Buffer.alloc(8 + answer.length * 12);
        reply.writeUInt32BE(2, 0);
        reply.writeUInt32BE(tid, 4);
        answer.forEach(([s, c, l], i) => {
          reply.writeUInt32BE(s, 8 + i * 12);
          reply.writeUInt32BE(c, 12 + i * 12);
          reply.writeUInt32BE(l, 16 + i * 12);
        });
        onMessage(reply, { address: host, port });
      });
    },
    on(event: string, listener: (...args: never[]) => void) {
      if (event === 'message') onMessage = listener as typeof onMessage;
      return socket;
    },
    close() {
      closed += 1;
    },
  };
  return { socket, sent, closed: () => closed };
}

describe('the tracker scrape (BEP 15)', () => {
  it('reads a udp tracker address, with or without /announce, and nothing else', () => {
    expect(udpTrackerOf('udp://tracker.opentrackr.org:1337/announce')).toEqual({ host: 'tracker.opentrackr.org', port: 1337, key: 'tracker.opentrackr.org:1337' });
    expect(udpTrackerOf('UDP://Open.Stealth.si:80')?.key).toBe('open.stealth.si:80');
    expect(udpTrackerOf('http://bt.t-ru.org/ann')).toBeNull();
    expect(udpTrackerOf('udp://tracker.example:99999')).toBeNull();
    expect(udpTrackers(['udp://a.example:1/announce', 'udp://a.example:1', 'http://b.example/announce', 'udp://c.example:2']).map((t) => t.key)).toEqual(['a.example:1', 'c.example:2']);
    expect(udpTrackers(Array.from({ length: 20 }, (_, i) => `udp://t${i}.example:1`))).toHaveLength(SCRAPE_MAX_TRACKERS);
  });

  it('builds the connect and scrape packets and reads the answer', () => {
    expect(connectPacket(5).toString('hex')).toBe('0000041727101980' + '00000000' + '00000005');
    const scrape = scrapePacket(Buffer.from('0000000000000009', 'hex'), 7, [A, B]);
    expect(scrape).toHaveLength(16 + 40);
    expect(scrape.subarray(0, 16).toString('hex')).toBe('0000000000000009' + '00000002' + '00000007');
    const reply = Buffer.from('00000002' + '00000007' + '0000005a' + '00000084' + '0000003e', 'hex');
    expect(readScrape(reply, 1)).toEqual([{ seeders: 90, leechers: 62 }]);
    expect(readScrape(reply, 2)).toBeNull();
  });

  it('asks every tracker at once and keeps the most seeders any one of them knows', async () => {
    const net = fakeSocket({ 'one.example': [[1, 9, 7], [0, 0, 0]], 'two.example': [[90, 132, 62], [0, 0, 0]], 'mute.example': 'silent' });
    const counts = await udpScraper({ socket: () => net.socket })([A, B], ['udp://one.example:1337/announce', 'udp://two.example:80', 'udp://mute.example:6969', 'http://web.example/announce'], { timeoutMs: 30 });
    expect(counts.get(A)).toEqual({ seeders: 90, leechers: 62, trackers: 2 });
    expect(counts.get(B)).toEqual({ seeders: 0, leechers: 0, trackers: 2 });
    expect(net.sent.filter((s) => s.action === 0).map((s) => s.host).sort()).toEqual(['mute.example', 'one.example', 'two.example']);
    expect(net.closed()).toBe(1);
  });

  it('answers nothing, and opens no socket, without a udp tracker or a usable hash', async () => {
    let opened = 0;
    const scrape = udpScraper({ socket: () => ((opened += 1), fakeSocket({}).socket) });
    expect((await scrape([A], ['http://web.example/announce'])).size).toBe(0);
    expect((await scrape(['nope'], ['udp://one.example:1'])).size).toBe(0);
    expect(opened).toBe(0);
  });

  it('calls a swarm dead only when two trackers answered and none knows a seeder', () => {
    expect(looksDead({ seeders: 0, leechers: 3, trackers: 2 })).toBe(true);
    expect(looksDead({ seeders: 0, leechers: 0, trackers: 1 })).toBe(false);
    expect(looksDead({ seeders: 1, leechers: 0, trackers: 4 })).toBe(false);
    expect(looksDead(undefined)).toBe(false);
    const list = [{ infoHash: A }, { infoHash: B }, { infoHash: 'c' }];
    expect(deadLast(list, new Map([[A, { seeders: 0, leechers: 0, trackers: 3 }]])).map((c) => c.infoHash)).toEqual([B, 'c', A]);
  });
});

describe('the connect-only check (public tracker lists)', () => {
  it('sends only a connect to each tracker, once, and answers the addresses whose tracker replied', async () => {
    const net = fakeSocket({ 'one.example': [], 'two.example': [], 'mute.example': 'silent' });
    const answered = await udpConnector({ socket: () => net.socket })(
      ['udp://one.example:1337/announce', 'udp://ONE.example:1337', 'udp://two.example:80', 'udp://mute.example:6969', 'http://web.example/announce'],
      { timeoutMs: 30 },
    );
    expect([...answered].sort()).toEqual(['udp://one.example:1337/announce', 'udp://two.example:80']);
    expect(net.sent.every((s) => s.action === 0)).toBe(true);
    expect(net.sent.map((s) => s.host).sort()).toEqual(['mute.example', 'one.example', 'two.example']);
    expect(net.closed()).toBe(1);
  });

  it('opens no socket without a udp tracker, and answers what arrived when the time is up', async () => {
    let opened = 0;
    const connect = udpConnector({ socket: () => ((opened += 1), fakeSocket({}).socket) });
    expect((await connect(['http://web.example/announce'])).size).toBe(0);
    expect(opened).toBe(0);
    const started = Date.now();
    expect((await udpConnector({ socket: () => fakeSocket({ 'mute.example': 'silent' }).socket })(['udp://mute.example:1'], { timeoutMs: 30 })).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('the trackers one scrape asks', () => {
  it('keeps the last SCRAPE_LIST_SLOTS places for the list trackers, after the others, without repeats', () => {
    const first = Array.from({ length: 30 }, (_, i) => `udp://f${i}.example:1`);
    const lists = ['udp://f0.example:1/announce', ...Array.from({ length: 10 }, (_, i) => `udp://l${i}.example:1`)];
    const order = scrapeTrackerOrder(first, lists);
    expect(order).toHaveLength(SCRAPE_MAX_TRACKERS);
    expect(order.slice(0, SCRAPE_MAX_TRACKERS - SCRAPE_LIST_SLOTS)).toEqual(first.slice(0, SCRAPE_MAX_TRACKERS - SCRAPE_LIST_SLOTS));
    expect(order.slice(SCRAPE_MAX_TRACKERS - SCRAPE_LIST_SLOTS)).toEqual(lists.slice(1, 1 + SCRAPE_LIST_SLOTS));
    // Few others: the list trackers fill the rest. No list: the others fill every place. Only UDP is asked.
    expect(scrapeTrackerOrder(first.slice(0, 3), lists)).toEqual([...first.slice(0, 3), ...lists.slice(1)]);
    expect(scrapeTrackerOrder(first, [])).toEqual(first.slice(0, SCRAPE_MAX_TRACKERS));
    expect(scrapeTrackerOrder(['http://web.example/announce', 'udp://a.example:1'], ['http://other.example/announce'])).toEqual(['udp://a.example:1']);
  });
});
