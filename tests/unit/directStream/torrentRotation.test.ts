import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StreamRef } from '../../../src/directStream/types.js';
import { parseRelease, type ScrapeTrackers, type SwarmCount, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import { TrackerBook } from '../../../src/directStream/torrent/origins.js';
import { ProbeError, type MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { FILE_FAILURE_KEEP_MS, MAX_TORRENT_TRIES, SWARM_FAILURE_KEEP_MS, TORRENTS_LEFT, TorrentSource, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 314095 };
const h = (n: number): string => n.toString(16).padStart(40, '0');
const candidate = (n: number, name = `Film.2017.720p.WEB.${n}`): TorrentCandidate => ({
  infoHash: h(n),
  name,
  fileName: null,
  fileIdx: null,
  seeds: 40,
  sizeBytes: 700_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['udp://tracker.example:1337/announce'],
  scoped: false,
  release: parseRelease(name),
});
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };
const MP4_DE: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }] };

interface Fakes {
  candidates: TorrentCandidate[];
  lastResort?: TorrentCandidate[];
  /** Per info hash; default: the swarm sends too little ('timeout'). */
  probes?: Record<string, MediaProbe | 'timeout'>;
  scrape?: ScrapeTrackers;
  book?: TrackerBook;
  sites?: Record<string, string | null>;
}

function setup(o: Fakes) {
  const opened: string[] = [];
  const openedWith: Record<string, readonly string[]> = {};
  const tried: Array<ReadonlySet<string> | undefined> = [];
  const clock = { now: 1_000_000 };
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      opened.push(pick.infoHash);
      openedWith[pick.infoHash] = pick.trackers ?? [];
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2017.720p.mp4', name: 'Film.2017.720p.mp4', length: 500_000_000 }] };
    },
    use: () => undefined,
    release: () => undefined,
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const answer: FindAnswer = { candidates: o.candidates, indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: o.candidates.length }], excluded: [], lastResort: o.lastResort ?? [] };
  const source = new TorrentSource({
    swarm,
    find: async (_query, _signal, options) => {
      tried.push(options?.tried);
      return answer;
    },
    probe: async (url) => {
      const hash = /\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? '';
      const p = o.probes?.[hash] ?? 'timeout';
      if (p === 'timeout') throw new ProbeError('timeout', 'ffprobe gave up after 30 s');
      return p;
    },
    tiers: [],
    localBase: () => 'http://127.0.0.1:4321',
    settleMs: 0,
    now: () => clock.now,
    log: () => undefined,
    ...(o.scrape === undefined ? {} : { scrape: o.scrape }),
    ...(o.book === undefined ? {} : { book: o.book }),
    ...(o.sites === undefined ? {} : { sites: o.sites }),
  });
  const play = async () => {
    const before = opened.length;
    const out = await source.resolve(FILM, { audioLang: 'en', imdbId: 'tt1212428' });
    return { out, opened: opened.slice(before) };
  };
  return { source, play, clock, tried, opened, openedWith };
}

describe('TorrentSource: asking again tries the next torrents', () => {
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => candidate(n));

  it(`tries ${MAX_TORRENT_TRIES} of 8, says 2 are left, tries those next, then starts over`, async () => {
    const t = setup({ candidates: eight });
    const first = await t.play();
    expect(first.out.ok).toBe(false);
    expect(first.opened.sort()).toEqual([1, 2, 3, 4, 5, 6].map(h));
    expect(first.out.attempts.at(-1)).toMatchObject({ provider: TORRENTS_LEFT, outcome: 'skipped' });
    expect(first.out.attempts.at(-1)?.detail).toMatch(/^2 more torrents of this title were found and not tried yet/);

    const second = await t.play();
    expect(second.opened.sort()).toEqual([7, 8].map(h));
    // The finder is told what was tried, so its fallback indexes are asked once nothing new is left.
    expect([...(t.tried[1] ?? [])].sort()).toEqual([1, 2, 3, 4, 5, 6].map(h));
    expect(second.out.attempts.at(-1)?.detail).toMatch(/^every torrent found was tried/);

    const third = await t.play();
    expect(third.opened.sort()).toEqual([1, 2, 3, 4, 5, 6].map(h));
  });

  it('plays a later candidate on the second ask when its swarm delivers', async () => {
    const t = setup({ candidates: eight, probes: { [h(8)]: MP4_EN } });
    expect((await t.play()).out.ok).toBe(false);
    const second = await t.play();
    expect(second.out.ok).toBe(true);
    if (second.out.ok) expect(second.out.torrent.infoHash).toBe(h(8));
  });

  it('never starts over with a torrent whose file is a dub: that failure is the file\'s, not the swarm\'s', async () => {
    const t = setup({ candidates: [candidate(1), candidate(2)], probes: { [h(1)]: MP4_DE } });
    expect((await t.play()).opened.sort()).toEqual([1, 2].map(h));
    // Both were tried: the ask starts over, with the swarm failure only.
    expect((await t.play()).opened).toEqual([h(2)]);
    t.clock.now += SWARM_FAILURE_KEEP_MS + 1;
    expect((await t.play()).opened).toEqual([h(2)]);
    t.clock.now += FILE_FAILURE_KEEP_MS;
    expect((await t.play()).opened.sort()).toEqual([1, 2].map(h));
  });

  it('forgets a swarm failure after half an hour: the best candidates are tried first again', async () => {
    const t = setup({ candidates: eight });
    await t.play();
    t.clock.now += SWARM_FAILURE_KEEP_MS + 1;
    expect((await t.play()).opened.sort()).toEqual([1, 2, 3, 4, 5, 6].map(h));
  });

  it('keeps the memory per title: another film starts at its own first candidate', async () => {
    const t = setup({ candidates: eight });
    await t.play();
    const before = t.opened.length;
    await t.source.resolve({ kind: 'movie', tmdbId: 550 }, { audioLang: 'en', imdbId: 'tt0137523' });
    expect(t.opened.slice(before).sort()).toEqual([1, 2, 3, 4, 5, 6].map(h));
  });

  it('tries the dub-named releases it did not reach on the next ask too', async () => {
    const dubs = [11, 12, 13, 14, 15, 16, 17].map((n) => candidate(n, `Film.2017.1080p.Hindi.Dubbed.${n}`));
    const t = setup({ candidates: [candidate(1)], lastResort: dubs });
    const first = await t.play();
    expect(first.opened).toHaveLength(1 + MAX_TORRENT_TRIES);
    expect(first.out.attempts.at(-1)?.detail).toMatch(/^1 more torrent of this title was found and not tried yet/);
    expect((await t.play()).opened).toEqual([h(17)]);
  });
});

describe('TorrentSource: the trackers are asked before a swarm is joined', () => {
  const counts = (entries: Record<string, SwarmCount>): ScrapeTrackers => async (hashes) => new Map(hashes.filter((x) => entries[x] !== undefined).map((x) => [x, entries[x]!]));

  it('tries a torrent the trackers know no seeder for after the others', async () => {
    const asked: string[][] = [];
    const scrape: ScrapeTrackers = async (hashes, trackers) => {
      asked.push([...trackers]);
      return counts({ [h(1)]: { seeders: 0, leechers: 2, trackers: 3 }, [h(2)]: { seeders: 90, leechers: 4, trackers: 3 } })(hashes, trackers);
    };
    const t = setup({ candidates: [1, 2, 3, 4].map((n) => candidate(n)), scrape, probes: { [h(1)]: MP4_EN, [h(2)]: MP4_EN, [h(3)]: MP4_EN, [h(4)]: MP4_EN } });
    const { out, opened } = await t.play();
    expect(opened.slice(0, 3).sort()).toEqual([2, 3, 4].map(h));
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(asked[0]).toContain('udp://tracker.example:1337/announce');
  });

  it('one tracker that does not know a torrent says nothing: its place is kept', async () => {
    const t = setup({ candidates: [1, 2, 3, 4].map((n) => candidate(n)), scrape: counts({ [h(1)]: { seeders: 0, leechers: 0, trackers: 1 } }) });
    expect((await t.play()).opened.slice(0, 3).sort()).toEqual([1, 2, 3].map(h));
  });

  it('a pasted magnet that sends nothing says how thin its swarm is', async () => {
    const magnet = `magnet:?xt=urn:btih:${h(9)}&dn=Film.2017.2160p&tr=udp://tracker.example:1337/announce`;
    const t = setup({ candidates: [], scrape: counts({ [h(9)]: { seeders: 1, leechers: 7, trackers: 2 } }) });
    const out = await t.source.playMagnet(FILM, { magnet, audioLang: 'en', imdbId: 'tt1212428' });
    expect(out.ok).toBe(false);
    expect(out.attempts[0]?.detail).toMatch(/the swarm sent too little.*; the trackers asked know 1 seeder and 7 leechers for it$/);
  });
});

describe('TorrentSource.learnMagnet (/update-cloud-source <magnet>)', () => {
  const MAGNET =
    'magnet:?xt=urn:btih:8A088FF63E25EE6614151853A2FA232243B9CAE7&dn=Рассказ служанки / The Handmaid\'s Tale / Сезон: 1&tr=http://bt.t-ru.org/ann?magnet&tr=http://bt2.t-ru.org/ann' +
    '&tr=udp://tracker.opentrackr.org:1337&tr=udp://p4p.arenabg.com:1337&tr=udp://tracker.coppersurfer.tk:6969&tr=http://tracker.example/announce';
  const HASH = '8a088ff63e25ee6614151853a2fa232243b9cae7';

  it('names the index by its own trackers, keeps the new public trackers that answer, and reports the swarm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notesd-book-'));
    const book = new TrackerBook(join(dir, 'trackers.json'));
    // arenabg answers, coppersurfer does not; asked together they know one seeder.
    const scrape: ScrapeTrackers = async (hashes, trackers) =>
      trackers.some((x) => x.includes('arenabg') || x.includes('opentrackr')) ? new Map(hashes.map((x) => [x, { seeders: 1, leechers: 7, trackers: 2 }])) : new Map();
    const t = setup({ candidates: [], scrape, book, sites: { rutracker: 'https://rutracker.net' } });
    const report = await t.source.learnMagnet(MAGNET);
    expect(report).toMatchObject({
      ok: true,
      info_hash: HASH,
      origin: { index: 'rutracker', label: 'RuTracker', by: 'bt.t-ru.org', supported: true, enabled: true, site_origin: 'https://rutracker.net' },
      unknown_hosts: ['p4p.arenabg.com', 'tracker.coppersurfer.tk', 'tracker.example'],
      trackers: {
        own: ['http://bt.t-ru.org/ann?magnet', 'http://bt2.t-ru.org/ann'],
        known: ['udp://tracker.opentrackr.org:1337'],
        added: ['udp://p4p.arenabg.com:1337'],
        silent: ['udp://tracker.coppersurfer.tk:6969'],
        skipped: ['http://tracker.example/announce'],
      },
      swarm: { seeders: 1, leechers: 7 },
    });
    expect(JSON.parse(readFileSync(join(dir, 'trackers.json'), 'utf8')).trackers.map((e: { url: string }) => e.url)).toEqual(['udp://p4p.arenabg.com:1337']);

    // A learned tracker goes to every torrent opened afterwards, and is not added twice.
    const u = setup({ candidates: [candidate(1)], book: new TrackerBook(join(dir, 'trackers.json')) });
    await u.play();
    expect(u.openedWith[h(1)]).toEqual(['udp://tracker.example:1337/announce', 'udp://p4p.arenabg.com:1337']);
    const again = await t.source.learnMagnet(MAGNET);
    expect(again.ok && again.trackers.added).toEqual([]);
    expect(again.ok && again.trackers.known).toContain('udp://p4p.arenabg.com:1337');
  });

  it('says so when the index is one the finder cannot ask, is switched off, or is not told by the trackers', async () => {
    const t = setup({ candidates: [], sites: { rutracker: null } });
    const off = await t.source.learnMagnet(MAGNET);
    expect(off.ok && off.origin).toMatchObject({ index: 'rutracker', supported: true, enabled: false });
    const nnm = await t.source.learnMagnet(`magnet:?xt=urn:btih:${h(5)}&tr=http://bt02.nnm-club.to:2710/announce`);
    expect(nnm.ok && nnm.origin).toMatchObject({ index: 'nnmclub', supported: false, enabled: false });
    expect(nnm.ok && nnm.next).toMatch(/cannot ask yet/);
    const bare = await t.source.learnMagnet(h(6));
    expect(bare).toMatchObject({ ok: true, origin: null, unknown_hosts: [], swarm: null });
    expect(await t.source.learnMagnet('not a magnet')).toMatchObject({ ok: false, error: 'bad_magnet' });
  });
});
