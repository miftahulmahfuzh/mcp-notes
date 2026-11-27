import { describe, expect, it } from 'vitest';
import type { CacheSubtitleView } from '../../../src/directStream/cachePlay.js';
import type { StreamRef } from '../../../src/directStream/types.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import { ProbeError, type MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { runSubtitleChain, SUBTITLE_BUDGET_MS, type SubtitleTier } from '../../../src/directStream/torrent/subtitles/chain.js';
import { chooseOrder, delivers, HEALTHY_PEERS, MAX_TORRENT_TRIES, SUBTITLES_PENDING, TORRENT_RACE_WIDTH, TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import type { TorrentSyncRequest as SyncRequest } from '../../../src/directStream/torrent/subtitles/synced.js';
import type { TorrentFileInfo } from '../../../src/directStream/torrent/types.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 467905 };
const EPISODE: StreamRef = { kind: 'tv', tmdbId: 247718, season: 1, episode: 2 };
const BASE = 'http://127.0.0.1:4321';

const h = (n: number): string => n.toString(16).padStart(40, '0');

const candidate = (infoHash: string, name: string, seeds = 40): TorrentCandidate => ({
  infoHash,
  name,
  fileName: null,
  fileIdx: null,
  seeds,
  sizeBytes: 700_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['http://127.0.0.1:1/announce'],
  scoped: false,
  release: parseRelease(name),
});

const file = (index: number, path: string, length = 500_000_000): TorrentFileInfo => ({ index, path, name: path.split('/').pop() ?? path, length });

const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 62, direct: true };
const MP4_DE: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }] };
const MP4_UNTAGGED: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: null }] };
const MKV: MediaProbe = { container: 'matroska,webm', video: { codec: 'hevc', height: 1080 }, audio: [{ codec: 'eac3', lang: 'eng' }], subtitles: [], durationS: 62, direct: false };

interface Fakes {
  candidates?: TorrentCandidate[];
  lastResort?: TorrentCandidate[];
  files?: Record<string, TorrentFileInfo[]>;
  failOpen?: string[];
  probes?: Record<string, MediaProbe | 'timeout'>;
  ready?: string[];
  disk?: DownloadOnDisk | null;
  tiers?: SubtitleTier[];
  onFind?: (query: unknown) => void;
  /** Wyzie Synced as a recorder of what it was started with. */
  sync?: SyncRequest[];
  /** What each swarm delivers; with it the swarm also has `drop` and `discard` (recorded as `drop <hash>`, `discard <hash>`). */
  stats?: Record<string, { peers: number; down_kbps: number }>;
  /** Milliseconds before a torrent's file list arrives, and before its header is read. */
  openDelay?: Record<string, number>;
  probeDelay?: Record<string, number>;
  settleMs?: number;
  subtitleHeadMs?: number;
  /** The source's clock; with it each open may move it on (`openTakesMs`). */
  clock?: { now: number };
  openTakesMs?: Record<string, number>;
  /** Bytes each swarm received so far (read at each look); with it the probe is watched for stalls, not timed out at 30 s. */
  received?: Record<string, () => number>;
  probeStallMs?: number;
  probeSampleMs?: number;
  heightSettleMs?: number;
  headerGiveWayMs?: number;
}

const wait = (ms: number | undefined): Promise<void> => (ms === undefined ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

function setup(o: Fakes = {}) {
  const calls: string[] = [];
  const probed: string[] = [];
  const durations: string[] = [];
  const logged: string[] = [];
  const openTimeouts: Record<string, number> = {};
  const probeTimeouts: Record<string, number> = {};
  const swarm: TorrentSwarm = {
    open: async (pick, options) => {
      calls.push(`open ${pick.infoHash}`);
      openTimeouts[pick.infoHash] = options.timeoutMs;
      if (o.clock !== undefined) o.clock.now += o.openTakesMs?.[pick.infoHash] ?? 0;
      await wait(o.openDelay?.[pick.infoHash]);
      if ((o.failOpen ?? []).includes(pick.infoHash)) throw new Error('no metadata within 20 s');
      return { infoHash: pick.infoHash, files: o.files?.[pick.infoHash] ?? [file(0, 'Film.2026.720p.mp4')] };
    },
    use: (infoHash, indexes) => {
      calls.push(`use ${infoHash} ${indexes.join(',')}`);
    },
    release: (infoHash) => {
      calls.push(`release ${infoHash}`);
    },
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/data/torrents/${infoHash}/${index}` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: (infoHash, s) => {
      durations.push(`${infoHash} ${s}`);
    },
    ...(o.received === undefined ? {} : { received: (infoHash: string) => o.received?.[infoHash]?.() ?? null }),
    ...(o.stats === undefined
      ? {}
      : {
          stats: (infoHash: string) => o.stats?.[infoHash] ?? null,
          drop: (infoHash: string) => {
            calls.push(`drop ${infoHash}`);
          },
          discard: (infoHash: string) => {
            calls.push(`discard ${infoHash}`);
          },
        }),
  };
  let finds = 0;
  const answer: FindAnswer = { candidates: o.candidates ?? [], indexes: [{ index: 'torrentio', outcome: 'ok', detail: `${(o.candidates ?? []).length} candidates`, took_s: 0.3, listed: (o.candidates ?? []).length }], excluded: [], lastResort: o.lastResort ?? [] };
  const source = new TorrentSource({
    swarm,
    find: async (query) => {
      finds += 1;
      o.onFind?.(query);
      return answer;
    },
    probe: async (url, timeoutMs, options) => {
      probed.push(url);
      const hash = /\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? '';
      probeTimeouts[hash] = timeoutMs;
      const signal = options?.signal;
      await Promise.race([
        wait(o.probeDelay?.[hash]),
        new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      if (signal?.aborted === true) throw new ProbeError('aborted', 'ffprobe was stopped');
      const p = o.probes?.[hash] ?? MP4_EN;
      if (p === 'timeout') throw new ProbeError('timeout', 'ffprobe gave up after 30 s');
      return p;
    },
    tiers: o.tiers ?? [],
    ...(o.sync === undefined ? {} : { sync: { start: (request) => (o.sync?.push(request), null) } }),
    localBase: () => BASE,
    ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }),
    ...(o.subtitleHeadMs === undefined ? {} : { subtitleHeadMs: o.subtitleHeadMs }),
    ...(o.probeStallMs === undefined ? {} : { probeStallMs: o.probeStallMs }),
    ...(o.probeSampleMs === undefined ? {} : { probeSampleMs: o.probeSampleMs }),
    ...(o.heightSettleMs === undefined ? {} : { heightSettleMs: o.heightSettleMs }),
    ...(o.headerGiveWayMs === undefined ? {} : { headerGiveWayMs: o.headerGiveWayMs }),
    log: (line) => void logged.push(line),
    ...(o.clock === undefined ? {} : { now: () => o.clock!.now }),
  });
  // Releases are handed to the swarm on the next tick.
  const settled = async (): Promise<string[]> => {
    await new Promise((r) => setTimeout(r, 0));
    return calls;
  };
  return { source, calls, settled, probed, durations, logged, openTimeouts, probeTimeouts, finds: () => finds };
}

describe('the header probe goes on while the swarm delivers', () => {
  /** Bytes that grow by `perMs` bytes each millisecond from now on. */
  const growing = (perMs: number): (() => number) => {
    const from = Date.now();
    return () => (Date.now() - from) * perMs;
  };

  it('is not cut at 30 s: it gets the play budget left, and plays when the header arrives', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264.AAC-A')],
      received: { [h(1)]: growing(100_000) },
      probeDelay: { [h(1)]: 150 },
      probeStallMs: 50,
      probeSampleMs: 10,
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0000001' });
    expect(out.ok).toBe(true);
    expect(t.probeTimeouts[h(1)]).toBeGreaterThan(60_000);
  });

  it('gives up a swarm that stalls, says what it received, and the next torrent plays', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.1080p.WEB-DL.x264.AAC-B')],
      received: { [h(1)]: () => 1_000, [h(2)]: growing(100_000) },
      probeDelay: { [h(1)]: 10_000, [h(2)]: 100 },
      probeStallMs: 60,
      probeSampleMs: 10,
      settleMs: 0,
    });
    const started = Date.now();
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0000001' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    const first = out.attempts.find((a) => a.provider.endsWith('-A'));
    expect(first).toMatchObject({ outcome: 'no_stream' });
    expect(first?.detail).toMatch(/stalled before the header arrived: 0\.0 MB in the last/);
    expect(t.logged.some((l) => l.includes(`(${h(1).slice(0, 8)}) lost: no_stream`))).toBe(true);
  });
});

describe('a torrent that delivers but sends no header gives way to the ones waiting (note 2-IFP, A Record of a Mortal\'s Journey)', () => {
  const growing = (perMs: number): (() => number) => {
    const from = Date.now();
    return () => (Date.now() - from) * perMs;
  };
  const PACK = 'A.Record.Of.A.Mortals.Journey.To.Immortality.S01-S03E117.1080p';

  it('the only proper candidate, a pack, stops waiting for its header after the give-way time, and the dub-named round plays', async () => {
    const t = setup({
      candidates: [candidate(h(1), PACK)],
      lastResort: [candidate(h(2), 'Fanren.Xiuxian.Chuan.S01E01.1080p.WEB-DL.Multi-Audio')],
      received: { [h(1)]: growing(100_000), [h(2)]: growing(100_000) },
      probeDelay: { [h(1)]: 10_000, [h(2)]: 50 },
      probeStallMs: 60,
      probeSampleMs: 10,
      headerGiveWayMs: 150,
      settleMs: 0,
    });
    const started = Date.now();
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0000001' });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    const pack = out.attempts.find((a) => a.provider === `Torrent: ${PACK}`);
    expect(pack).toMatchObject({ outcome: 'no_stream' });
    expect(pack?.detail).toMatch(/no header after 0 s while it delivered \(.*\); 1 more torrent waited/);
  });

  it('a torrent nothing waits behind keeps the whole budget, however long its header takes', async () => {
    const t = setup({
      candidates: [candidate(h(1), PACK)],
      received: { [h(1)]: growing(100_000) },
      probeDelay: { [h(1)]: 400 },
      probeStallMs: 60,
      probeSampleMs: 10,
      headerGiveWayMs: 100,
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0000001' });
    expect(out.ok && out.torrent.infoHash).toBe(h(1));
  });
});

describe('1080p first', () => {
  const D = (peers: number) => ({ peers, downKbps: 5000, filmKbps: 2000 });

  it('chooseOrder takes the preferred height among torrents that deliver, and delivery over height', () => {
    const p720 = { position: 0, english: true, height: 720 as const };
    const p1080 = { position: 1, english: false, height: 1080 as const };
    const p2160 = { position: 2, english: false, height: 2160 as const };
    expect(chooseOrder([p720, p2160, p1080], () => D(10)).map((p) => p.height)).toEqual([1080, 720, 2160]);
    expect(chooseOrder([p720, p1080], (p) => (p.height === 720 ? D(10) : { peers: 1, downKbps: 100, filmKbps: 2000 })).map((p) => p.height)).toEqual([720, 1080]);
  });

  it('waits for a 1080p racer still receiving when a 720p header arrives first, and plays the 1080p', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')],
      probeDelay: { [h(1)]: 250, [h(2)]: 10 },
      settleMs: 5,
      heightSettleMs: 2_000,
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0000001' });
    expect(out.ok && out.torrent.infoHash).toBe(h(1));
    expect(t.logged.some((l) => /waiting up to 2 s for Film\.2026\.1080p/.test(l))).toBe(true);
    expect(t.logged.some((l) => l.includes(`(${h(2).slice(0, 8)}) lost: its header arrived too (720p`))).toBe(true);
  });

  it('plays the 720p when the 1080p racer does not arrive within the wait', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')],
      probeDelay: { [h(1)]: 5_000, [h(2)]: 10 },
      settleMs: 5,
      heightSettleMs: 100,
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0000001' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(t.logged.some((l) => l.includes(`(${h(1).slice(0, 8)}) lost: still opening`))).toBe(true);
  });
});

describe('a dub-named release as a last resort', () => {
  // A dual-audio file: the dub first, then the original (eng). Directly playable.
  const MP4_DUAL_ORIG_FIRST: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'eng' }, { codec: 'aac', lang: 'ger' }] };
  const MP4_DUAL_DUB_FIRST: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }, { codec: 'aac', lang: 'eng' }] };

  it('tries the dub-named releases only after the proper ones fail, and plays one whose file carries the original', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264-PROPER')],
      files: { [h(1)]: [] }, // no video file: the proper one fails
      lastResort: [candidate(h(2), 'Film.2026.1080p.Hindi.Dubbed.WEB-DL')],
      probes: { [h(2)]: MP4_DUAL_ORIG_FIRST },
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.torrent.infoHash).toBe(h(2));
    const order = out.attempts.map((a) => a.provider);
    // The proper one is tried (and fails) before the dub-named one.
    expect(order).toEqual(['Index: torrentio', 'Torrent: Film.2026.1080p.WEB-DL.x264-PROPER', 'Torrent: Film.2026.1080p.Hindi.Dubbed.WEB-DL']);
    expect(out.attempts[1]?.outcome).toBe('no_stream');
    expect(out.attempts[2]?.outcome).toBe('resolved');
  });

  it('gets what the proper round left of the one budget, not a budget of its own', async () => {
    const clock = { now: 1_000_000 };
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264-PROPER')],
      failOpen: [h(1)],
      lastResort: [candidate(h(2), 'Film.2026.1080p.Hindi.Dubbed.WEB-DL')],
      probes: { [h(2)]: MP4_DUAL_ORIG_FIRST },
      clock,
      openTakesMs: { [h(1)]: 80_000 },
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    // 90 s in all, 80 of them spent: the dub-named torrent may take 10 s to open, not 20.
    expect(t.openTimeouts[h(2)]).toBe(10_000);

    const late = { now: 1_000_000 };
    const spent = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264-PROPER')],
      failOpen: [h(1)],
      lastResort: [candidate(h(2), 'Film.2026.1080p.Hindi.Dubbed.WEB-DL')],
      clock: late,
      openTakesMs: { [h(1)]: 88_000 },
    });
    const none = await spent.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(none.ok).toBe(false);
    expect(spent.calls).not.toContain(`open ${h(2)}`);
  });

  it('refuses a dub-named release whose file really is only the dub, so the original-language rule holds', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264-PROPER')],
      files: { [h(1)]: [] },
      lastResort: [candidate(h(2), 'Film.2026.1080p.Hindi.Dubbed.WEB-DL')],
      probes: { [h(2)]: MP4_DE }, // German only: a true dub
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    // The last attempt says what asking again would try (TORRENTS_LEFT); the torrent's own is the one before it.
    expect(out.attempts.at(-2)).toMatchObject({ provider: 'Torrent: Film.2026.1080p.Hindi.Dubbed.WEB-DL', outcome: 'dubbed' });
  });

  it('refuses a dual-audio file whose original is not the default when no remux can force it', async () => {
    // No remux in this setup: a directly-playable file with the dub as its first (default) track cannot be forced.
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264-PROPER')],
      files: { [h(1)]: [] },
      lastResort: [candidate(h(2), 'Film.2026.1080p.Hindi.Dubbed.WEB-DL')],
      probes: { [h(2)]: MP4_DUAL_DUB_FIRST },
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.attempts.at(-2)).toMatchObject({ outcome: 'dubbed' });
    // ...but the same file with the original first plays directly, no remux needed.
    const ok = setup({ candidates: [candidate(h(3), 'Film.2026.1080p.WEB-DL.x264')], probes: { [h(3)]: MP4_DUAL_ORIG_FIRST } });
    expect((await ok.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' })).ok).toBe(true);
  });
});

describe('TorrentSource.playMagnet', () => {
  const magnetOf = (hash: string, dn = 'Film.2026.1080p.WEB-DL.x264-GRP') => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}&tr=udp://tracker.example:1337/announce`;

  it('opens the pasted magnet, probes it and builds the session torrent, asking no index', async () => {
    const t = setup({ files: { [h(1)]: [file(0, 'Film.2026.1080p.mp4')] } });
    const out = await t.source.playMagnet(FILM, { magnet: magnetOf(h(1)), audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.torrent).toMatchObject({ infoHash: h(1), fileIndex: 0, index: 'magnet', held: true, manifestKind: 'mp4' });
    expect(out.attempts.map((a) => a.provider)).toEqual(['Torrent: Film.2026.1080p.WEB-DL.x264-GRP']);
    // No index was asked.
    expect(t.finds()).toBe(0);
    expect(await t.settled()).toEqual([`open ${h(1)}`, `use ${h(1)} 0`]);
  });

  it('refuses a magnet whose audio is a dub, keeping the original-language rule', async () => {
    const t = setup({ files: { [h(2)]: [file(0, 'Film.2026.1080p.mp4')] }, probes: { [h(2)]: MP4_DE } });
    const out = await t.source.playMagnet(FILM, { magnet: magnetOf(h(2)), audioLang: 'en', imdbId: null });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.attempts[0]).toMatchObject({ outcome: 'dubbed' });
  });

  it('is no_source for a magnet with no video file, and for a string that is not a magnet', async () => {
    const noVideo = setup({ files: { [h(3)]: [file(0, 'Film.2026.OST.flac'), file(1, 'cover.jpg')] } });
    const out = await noVideo.source.playMagnet(FILM, { magnet: magnetOf(h(3), 'Curious Tales OST [FLAC]'), audioLang: 'zh', imdbId: null });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.attempts[0]).toMatchObject({ outcome: 'no_stream' });

    const bad = setup();
    const garbage = await bad.source.playMagnet(FILM, { magnet: 'not a magnet', audioLang: 'en', imdbId: null });
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.attempts[0]).toMatchObject({ provider: 'Torrent: magnet', outcome: 'error' });
  });
});

describe('TorrentSource.fetchAhead', () => {
  it('takes the torrent like a play, stops what only a page needs, and lets it go once', async () => {
    const sync: SyncRequest[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Show.S01E03.720p.WEB-DL.x264.AAC-GRP')], sync });
    const next: StreamRef = { kind: 'tv', tmdbId: 247718, season: 1, episode: 3 };
    expect(await t.source.onDisk(next)).toBe(false);
    const out = await t.source.fetchAhead(next, { audioLang: 'en', imdbId: 'tt0247718' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.torrent).toMatchObject({ infoHash: h(1), held: true });
    // The subtitle tiers and the sync of a page are stopped; the download goes on.
    expect(out.torrent.stop.signal.aborted).toBe(true);
    expect(await t.settled()).toEqual([`open ${h(1)}`, `use ${h(1)} 0`]);
    t.source.releaseAhead(out.torrent);
    t.source.releaseAhead(out.torrent);
    expect(await t.settled()).toEqual([`open ${h(1)}`, `use ${h(1)} 0`, `release ${h(1)}`]);
  });

  it('says a finished download of the episode is on disk, and one still downloading is not', async () => {
    const whole = setup({ disk: { infoHash: h(1), name: 'Show.S01E03', fileIndex: 0, state: 'ready' } });
    expect(await whole.source.onDisk(EPISODE)).toBe(true);
    const partial = setup({ disk: { infoHash: h(1), name: 'Show.S01E03', fileIndex: 0, state: 'downloading' } });
    expect(await partial.source.onDisk(EPISODE)).toBe(false);
  });
});

describe('TorrentSource.resolve', () => {
  it('plays the first torrent that opens: the local file route, the Torrent stand-in, the index then the torrent in attempts', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-GRP')] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.torrent).toMatchObject({ infoHash: h(1), fileIndex: 0, name: 'Film.2026.720p.WEB-DL.x264.AAC-GRP', index: 'torrentio', seeds: 40, state: 'downloading', height: 720, manifestUrl: `/api/stream/torrent/${h(1)}/f/0`, manifestKind: 'mp4', held: true, imdbId: 'tt0467905' });
    expect(out.source).toMatchObject({ provider: 'Torrent', manifest_url: `/api/stream/torrent/${h(1)}/f/0`, manifest_kind: 'mp4', headers: { referer: null, origin: null, user_agent: null }, audio: { languages: ['en'], original: true } });
    expect(out.attempts.map((a) => [a.provider, a.outcome])).toEqual([
      ['Index: torrentio', 'resolved'],
      ['Torrent: Film.2026.720p.WEB-DL.x264.AAC-GRP', 'resolved'],
    ]);
    expect(t.probed).toEqual([`${BASE}/api/stream/torrent/${h(1)}/f/0`]);
    expect(await t.settled()).toEqual([`open ${h(1)}`, `use ${h(1)} 0`]);
    // The probe's length reaches phase 1's map (seconds for the page's grey bar).
    expect(t.durations).toEqual([`${h(1)} 62`]);
  });

  it('skips a file whose audio names only another language as dubbed, releases it, and plays the next (R1.6)', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')], probes: { [h(1)]: MP4_DE } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(out.attempts.slice(1).map((a) => [a.outcome, a.detail])).toEqual([
      ['dubbed', 'its audio is de, not the original en (from torrentio)'],
      ['resolved', 'mov h264 720p / aac, 40 seeds'],
    ]);
    expect(await t.settled()).toContain(`release ${h(1)}`);
  });

  it('plays a file whose audio names no language, since nothing says it is a dub', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], probes: { [h(1)]: MP4_UNTAGGED } });
    const out = await t.source.resolve(FILM, { audioLang: 'ko', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    expect(out.ok && out.source.audio).toEqual({ languages: [], tracks: 0, original: null, track: null });
  });

  it('answers unplayable for a file Chrome cannot play, and no_stream for a torrent with no file list in time', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x265.EAC3-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B'), candidate(h(3), 'Film.2026.720p.WEB-DL.x264.AAC-C')],
      probes: { [h(1)]: MKV },
      failOpen: [h(2)],
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(3));
    expect(out.attempts.slice(1).map((a) => a.outcome)).toEqual(['unplayable', 'no_stream', 'resolved']);
    expect(out.attempts[1]?.detail).toBe('matroska hevc 1080p / eac3: Chrome does not play it as is (from torrentio)');
    const calls = await t.settled();
    expect(calls).toContain(`release ${h(1)}`);
    expect(calls).toContain(`release ${h(2)}`);
  });

  it('answers no_stream when the swarm sends too little to probe in time', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], probes: { [h(1)]: 'timeout' } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(false);
    expect(out.attempts[1]).toMatchObject({ provider: 'Torrent: Film.2026.720p.WEB-DL.x264.AAC-A', outcome: 'no_stream' });
  });

  it(`tries at most ${MAX_TORRENT_TRIES} torrents, and keeps the ones after the played one for the shuffle button`, async () => {
    const many = Array.from({ length: 8 }, (_, i) => candidate(h(i + 1), `Film.2026.720p.WEB-DL.x264.AAC-G${i + 1}`));
    const failing = setup({ candidates: many, failOpen: many.map((c) => c.infoHash) });
    const none = await failing.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(none.attempts.filter((a) => a.provider.startsWith('Torrent: '))).toHaveLength(MAX_TORRENT_TRIES);
    const second = setup({ candidates: many, failOpen: [h(1)] });
    const out = await second.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.candidates.map((c) => c.infoHash)).toEqual(many.slice(2).map((c) => c.infoHash));
  });

  it('asks the finder by the IMDb id, the names, the year and the original language, and keeps the query for the shuffle button', async () => {
    const asked: unknown[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Show.S01E02.720p.WEB-DL.x264.AAC-A')], files: { [h(1)]: [file(0, 'Show.S01E02.720p.mp4')] }, probes: { [h(1)]: MP4_UNTAGGED }, onFind: (q) => asked.push(q) });
    const out = await t.source.resolve(EPISODE, { audioLang: 'ko', imdbId: 'tt9999999', names: { title: 'Show', originalTitle: '쇼', year: 2025 } });
    expect(asked).toEqual([{ kind: 'tv', imdbId: 'tt9999999', title: 'Show', originalTitle: '쇼', year: 2025, originalLanguage: 'ko', season: 1, episode: 2 }]);
    expect(out.ok && out.torrent.query).toEqual(asked[0]);
  });

  it('adds the number within the season to the query when TMDB\'s number runs on across seasons (One Piece)', async () => {
    const asked: any[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Show.S01E02.720p.WEB-DL.x264.AAC-A')], files: { [h(1)]: [file(0, 'Show.S01E02.720p.mp4')] }, probes: { [h(1)]: MP4_UNTAGGED }, onFind: (q) => asked.push(q) });
    const names = { title: 'One Piece', originalTitle: null, year: 1999 };
    await t.source.resolve({ kind: 'tv', tmdbId: 37854, season: 21, episode: 1000 }, { audioLang: 'ja', imdbId: 'tt0388629', names: { ...names, episodeInSeason: 109 } });
    expect(asked[0]).toMatchObject({ season: 21, episode: 1000, absoluteEpisode: 1000, alt: { season: 21, episode: 109 } });
    // A number that is already the one within the season adds nothing.
    await t.source.resolve({ kind: 'tv', tmdbId: 37854, season: 2, episode: 3 }, { audioLang: 'ja', imdbId: 'tt0388629', names: { ...names, episodeInSeason: 3 } });
    expect(asked[1]).not.toHaveProperty('alt');
    expect(asked[1]).not.toHaveProperty('absoluteEpisode');
  });

  it('chooses the asked episode\'s file inside a season pack (R1.4)', async () => {
    const pack = candidate(h(9), 'Show.S01.720p.WEB-DL.x264.AAC-PACK');
    const t = setup({
      candidates: [pack],
      files: {
        [h(9)]: [file(0, 'Show.S01/Show.S01E01.720p.mp4'), file(1, 'Show.S01/Show.S01E02.720p.mp4'), file(2, 'Show.S01/Show.S01E03.720p.mp4'), file(3, 'Show.S01/sample.mp4', 9_000_000)],
      },
    });
    const out = await t.source.resolve(EPISODE, { audioLang: 'en', imdbId: 'tt9999999' });
    expect(out.ok && out.torrent.fileIndex).toBe(1);
    expect(out.ok && out.torrent.manifestUrl).toBe(`/api/stream/torrent/${h(9)}/f/1`);
    expect((await t.settled()).find((c) => c.startsWith('use '))).toBe(`use ${h(9)} 1`);
  });

  it('without an IMDb id the finder is still asked (the indexes asked by title need none), and the torrent plays', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: null });
    expect(t.finds()).toBe(1);
    expect(out.ok && out.torrent.infoHash).toBe(h(1));
    expect(out.ok && out.torrent.imdbId).toBeNull();
    expect(out.attempts.some((a) => a.provider === 'Index: all')).toBe(false);
  });
});

describe('TorrentSource: the torrent is chosen by what its swarm delivers', () => {
  const A = candidate(h(1), 'Film.2026.1080p.WEB-DL.x264.AAC-A', 16);
  const B = candidate(h(2), 'Film.2026.1080p.WEB-DL.x264.AAC-B', 9);
  const C = candidate(h(3), 'Film.2026.720p.WEB-DL.x264.AAC-C', 7);
  const D = candidate(h(4), 'Film.2026.720p.WEB-DL.x264.AAC-D', 5);
  // 500 MB over 62 s: a 64.5 Mbps "film", so only peers make a swarm healthy here.
  const THIN = { peers: 3, down_kbps: 1740 };
  const WIDE = { peers: 14, down_kbps: 900 };

  it(`opens the best ${TORRENT_RACE_WIDTH} side by side, not one after the other`, async () => {
    const t = setup({ candidates: [A, B, C, D], openDelay: { [h(1)]: 30, [h(2)]: 30, [h(3)]: 30 }, settleMs: 0 });
    const asked = t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    await wait(5);
    expect(t.calls).toEqual([`open ${h(1)}`, `open ${h(2)}`, `open ${h(3)}`]);
    await asked;
    expect(t.calls).not.toContain(`open ${h(4)}`);
  });

  it('plays the torrent with the connected peers, not the one the index listed with more seeds (16 listed, 3 connected)', async () => {
    const t = setup({ candidates: [A, B, C], stats: { [h(1)]: THIN, [h(2)]: WIDE, [h(3)]: THIN } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(out.attempts.slice(1).map((a) => [a.outcome, a.detail])).toEqual([
      ['skipped', `its header arrived too (16 seeds listed; 3 peers connected, 1.7 Mbps for a 64.5 Mbps film); ${B.name} was chosen`],
      ['resolved', 'mov h264 720p / aac, 9 seeds listed; 14 peers connected, 0.9 Mbps for a 64.5 Mbps film'],
      ['skipped', `its header arrived too (7 seeds listed; 3 peers connected, 1.7 Mbps for a 64.5 Mbps film); ${B.name} was chosen`],
    ]);
    // The ones not chosen leave their swarms at once, and stay first in line for the shuffle button.
    const calls = await t.settled();
    expect(calls.filter((c) => c.startsWith('drop ')).sort()).toEqual([`drop ${h(1)}`, `drop ${h(3)}`]);
    expect(calls).not.toContain(`drop ${h(2)}`);
    expect(out.ok && out.torrent.candidates.map((c) => c.infoHash)).toEqual([h(1), h(3)]);
  });

  it('takes the first whose header arrives when the others are still opening after the settle time, and lets go of them', async () => {
    const t = setup({ candidates: [A, B, C], openDelay: { [h(1)]: 400, [h(3)]: 400 }, stats: { [h(2)]: THIN }, settleMs: 20 });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(out.attempts.slice(1).map((a) => [a.outcome, a.detail])).toEqual([
      ['skipped', `still opening when ${B.name} was chosen`],
      ['resolved', expect.stringContaining('3 peers connected')],
      ['skipped', `still opening when ${B.name} was chosen`],
    ]);
    expect(out.ok && out.torrent.candidates.map((c) => c.infoHash)).toEqual([h(1), h(3)]);
    // A torrent cancelled while its file list was on its way is let go of as soon as it is open, and never used:
    // it took no hold, so it gives none back.
    await wait(450);
    expect(t.calls.filter((c) => c.startsWith('discard ')).sort()).toEqual([`discard ${h(1)}`, `discard ${h(3)}`]);
    expect(t.calls.some((c) => c.startsWith('drop '))).toBe(false);
    expect(t.calls).not.toContain(`use ${h(1)} 0`);
    expect(t.calls).not.toContain(`use ${h(3)} 0`);
  });

  it('waits the settle time for a healthier swarm that is a moment behind', async () => {
    const t = setup({ candidates: [A, B], probeDelay: { [h(2)]: 40 }, stats: { [h(1)]: THIN, [h(2)]: WIDE }, settleMs: 500 });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
  });

  it('a torrent that fails makes room for the next candidate', async () => {
    const t = setup({ candidates: [A, B, C, D], failOpen: [h(1), h(2), h(3)] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(4));
    expect(out.attempts.slice(1).map((a) => a.outcome)).toEqual(['no_stream', 'no_stream', 'no_stream', 'resolved']);
  });

  it('among swarms alike, the one whose files hold an English subtitle file is chosen (R3.2)', async () => {
    const t = setup({
      candidates: [A, B],
      files: { [h(2)]: [file(0, 'Film/Film.2026.mp4'), file(1, 'Film/Film.2026.en.srt', 40_000)] },
      stats: { [h(1)]: WIDE, [h(2)]: WIDE },
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(out.ok && out.torrent.selected).toEqual([0, 1]);
  });

  it('chooseOrder: a swarm that delivers, then an English subtitle file, then more peers, then the finder\'s order', () => {
    const d = (peers: number, downKbps: number) => ({ peers, downKbps, filmKbps: 2640 });
    expect(delivers(d(3, 1740))).toBe(false);
    expect(delivers(d(3, 2640))).toBe(true);
    expect(delivers(d(HEALTHY_PEERS, 0))).toBe(true);
    expect(delivers(null)).toBe(false);
    // Many peers are no promise for a film this link cannot carry; its own rate still is.
    expect(delivers({ peers: 7, downKbps: 4000, filmKbps: 18_300 })).toBe(false);
    expect(delivers({ peers: 7, downKbps: 19_000, filmKbps: 18_300 })).toBe(true);
    expect(delivers({ peers: 7, downKbps: 0, filmKbps: null })).toBe(true);
    const passed = [
      { position: 0, english: false, d: d(3, 1740) },
      { position: 1, english: true, d: d(2, 500) },
      { position: 2, english: false, d: d(9, 4000) },
      { position: 3, english: true, d: d(7, 100) },
      { position: 4, english: false, d: null },
    ];
    expect(chooseOrder(passed, (p) => p.d).map((p) => p.position)).toEqual([3, 2, 1, 0, 4]);
  });

  it('tells the caller where the play stands: the stage and the attempts so far', async () => {
    const seen: Array<{ stage: string; attempts: number }> = [];
    const t = setup({ candidates: [A, B], failOpen: [h(1)] });
    await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905', progress: (p) => seen.push({ stage: p.stage, attempts: p.attempts.length }) });
    expect(seen[0]).toEqual({ stage: 'asking the torrent indexes', attempts: 0 });
    expect(seen.some((p) => p.stage === `opening 2 torrents: ${A.name}; ${B.name}` && p.attempts === 1)).toBe(true);
    // The index, then the torrent that failed.
    expect(seen[seen.length - 1]!.attempts).toBeGreaterThanOrEqual(2);
  });
});

describe('TorrentSource: the film starts before the subtitle search ends', () => {
  const view: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/service-wyzie-1.vtt`, lang: 'en', label: 'English (Wyzie)' };
  const slow = (ms: number, found: CacheSubtitleView[]): SubtitleTier => ({ name: 'service', blocks: true, find: async () => (await wait(ms), found) });

  it('answers the play with Subtitles: pending, then puts the track on the session and bumps subtitleRev', async () => {
    const sync: SyncRequest[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], tiers: [slow(80, [view])], subtitleHeadMs: 10, sync });
    const started = Date.now();
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('not resolved');
    expect(Date.now() - started).toBeLessThan(70);
    expect(out.attempts.map((a) => [a.provider, a.outcome])).toEqual([['Index: torrentio', 'resolved'], [`Torrent: ${out.torrent.name}`, 'resolved'], [SUBTITLES_PENDING, 'skipped']]);
    expect(out.torrent.subtitles).toEqual([]);
    expect(out.torrent.subtitleRev).toBe(0);
    // Wyzie Synced waits for the chain: there is nothing to re-time yet.
    expect(sync).toHaveLength(0);
    const late = await out.torrent.subtitlesPending;
    expect(late?.map((a) => [a.provider, a.outcome])).toEqual([['Subtitles: service', 'resolved']]);
    expect(out.torrent.subtitles).toEqual([view]);
    expect(out.torrent.subtitleRev).toBe(1);
    expect(out.torrent.subtitlesPending).toBeNull();
    expect(sync).toHaveLength(1);
    expect(sync[0]!.target).toBe(out.torrent);
    expect(t.logged.some((l) => /subtitles of 00000000 arrived .* \(service resolved/.test(l))).toBe(true);
  });

  it('a chain that ends with nothing leaves subtitleRev alone', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], tiers: [slow(40, [])], subtitleHeadMs: 5 });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('not resolved');
    expect((await out.torrent.subtitlesPending)?.map((a) => a.outcome)).toEqual(['no_stream']);
    expect(out.torrent.subtitleRev).toBe(0);
  });

  it('a tier that answers at once (a kept file) is in the answer, with nothing pending', async () => {
    const kept: SubtitleTier = { name: 'kept', blocks: true, find: async () => [view] };
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], tiers: [kept, slow(5_000, [])] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('not resolved');
    expect(out.attempts.slice(2).map((a) => [a.provider, a.outcome])).toEqual([['Subtitles: kept', 'resolved']]);
    expect(out.torrent.subtitles).toEqual([view]);
    expect(out.torrent.subtitlesPending ?? null).toBeNull();
    expect(out.torrent.subtitleRev).toBe(0);
  });

  it('a replay from disk does not wait for a slow chain either', async () => {
    const t = setup({ disk: { infoHash: h(5), name: 'Film.2026.720p', fileIndex: 0, state: 'ready' }, ready: [h(5)], tiers: [slow(60, [view])], subtitleHeadMs: 5 });
    const out = await t.source.fromDisk(FILM, { audioLang: 'en' });
    expect(out?.attempts.map((a) => a.provider)).toEqual([SUBTITLES_PENDING]);
    await out?.torrent.subtitlesPending;
    expect(out?.torrent.subtitles).toEqual([view]);
    expect(out?.torrent.subtitleRev).toBe(1);
  });
});

describe('TorrentSource: the release\'s own subtitle arrives after the chain', () => {
  const service: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/service-wyzie-1.vtt`, lang: 'en', label: 'English (Wyzie)' };
  const own: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/file-1.vtt`, lang: 'en', label: 'English' };
  const filesLate = (ms: number): SubtitleTier => ({ name: 'files', blocks: false, aside: true, release: true, find: async () => (await wait(ms), [own]) });
  const serviceTier: SubtitleTier = { name: 'service', blocks: true, find: async () => [service] };

  it('takes the place of the service\'s file and bumps subtitleRev', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], tiers: [filesLate(400), serviceTier] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('not resolved');
    expect(out.torrent.subtitles).toEqual([service]);
    expect(out.torrent.subtitleRev).toBe(0);
    await wait(500);
    expect(out.torrent.subtitles).toEqual([own]);
    expect(out.torrent.subtitleRev).toBe(1);
    expect(t.logged.some((l) => /release's own subtitle of 00000000 arrived/.test(l))).toBe(true);
  });

  it('never takes the place of a checked file put on the session meanwhile', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], tiers: [filesLate(400), serviceTier] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('not resolved');
    const checked: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/checked-0-ab12.vtt`, lang: 'en', label: 'English (checked)' };
    out.torrent.subtitles = [checked];
    out.torrent.subtitleRev = 5;
    await wait(500);
    expect(out.torrent.subtitles).toEqual([checked]);
    expect(out.torrent.subtitleRev).toBe(5);
  });

  it('a late chain does not replace a checked file put on the session while it ran', async () => {
    const slowService: SubtitleTier = { name: 'service', blocks: true, find: async () => (await wait(80), [service]) };
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')], tiers: [slowService], subtitleHeadMs: 5 });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('not resolved');
    const checked: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/checked-0-ab12.vtt`, lang: 'en', label: 'English (checked)' };
    out.torrent.subtitles = [checked];
    await out.torrent.subtitlesPending;
    expect(out.torrent.subtitles).toEqual([checked]);
    expect(out.torrent.subtitleRev).toBe(0);
  });
});

describe('TorrentSource.next, hold and release', () => {
  it('moves to the next candidate without asking the indexes, and opens a released torrent again', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')] });
    const first = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!first.ok) throw new Error('expected a torrent');
    const next = await t.source.next(FILM, first.torrent, 'en');
    expect(next.ok && next.torrent.infoHash).toBe(h(2));
    expect(t.finds()).toBe(1);
    t.source.release(first.torrent);
    t.source.release(first.torrent);
    expect((await t.settled()).filter((c) => c === `release ${h(1)}`)).toHaveLength(1);
    await t.source.hold(FILM, first.torrent);
    expect(first.torrent.held).toBe(true);
    expect(t.calls.slice(-2)).toEqual([`open ${h(1)}`, `use ${h(1)} 0`]);
  });
});

describe('TorrentSource and Wyzie Synced', () => {
  const serviceTier: SubtitleTier = { name: 'service', blocks: true, find: async (ctx) => [{ url: `/api/stream/torrent/${ctx.infoHash}/sub/service-wyzie-1.vtt`, lang: 'en', label: 'English (Wyzie)' }] };

  it('hands the sync the session\'s own torrent after the chain, and again when the session takes the torrent back', async () => {
    const sync: SyncRequest[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')], tiers: [serviceTier], sync });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('not resolved');
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({ ref: FILM, imdbId: 'tt0467905', infoHash: h(1), fileIndex: 0, durationS: 62 });
    // The very object the session keeps: what the sync writes is what the page reads.
    expect(sync[0]!.target).toBe(out.torrent);
    expect(out.torrent.subtitleRev).toBe(0);
    expect(out.torrent.candidates.map((c) => c.infoHash)).toEqual([h(2)]);
    expect(sync[0]!.signal).toBe(out.torrent.stop.signal);
    t.source.release(out.torrent);
    expect(sync[0]!.signal.aborted).toBe(true);
    await t.source.hold(FILM, out.torrent);
    expect(sync).toHaveLength(2);
    expect(sync[1]!.signal.aborted).toBe(false);
    expect(sync[1]!.target).toBe(out.torrent);
  });

  it('a replay from disk is handed over too, by the TMDB id (no IMDb id is known)', async () => {
    const sync: SyncRequest[] = [];
    const t = setup({ disk: { infoHash: h(5), name: 'Film.2026.720p', fileIndex: 0, state: 'ready' }, ready: [h(5)], tiers: [serviceTier], sync });
    const out = await t.source.fromDisk(FILM, { audioLang: 'en' });
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({ imdbId: null, infoHash: h(5), fileIndex: 0, durationS: 62 });
    expect(sync[0]!.target).toBe(out?.torrent);
  });
});

describe('TorrentSource.fromDisk (R2.9)', () => {
  const disk: DownloadOnDisk = { infoHash: h(5), name: 'Film.2026.720p.WEB-DL.x264.AAC-A', fileIndex: 0, state: 'ready' };

  it('plays a whole download from disk: no index, no open, not held', async () => {
    const t = setup({ disk, ready: [h(5)] });
    const out = await t.source.fromDisk(FILM, { audioLang: 'en' });
    expect(out?.torrent).toMatchObject({ infoHash: h(5), state: 'ready', held: false, candidate: null, manifestUrl: `/api/stream/torrent/${h(5)}/f/0` });
    expect(out?.source.provider).toBe('Torrent');
    expect(t.finds()).toBe(0);
    expect(await t.settled()).toEqual([]);
  });

  it('passes over a download that is not whole, or whose file is a dub', async () => {
    expect(await setup({ disk: { ...disk, state: 'downloading' }, ready: [h(5)] }).source.fromDisk(FILM, { audioLang: 'en' })).toBeNull();
    expect(await setup({ disk, ready: [] }).source.fromDisk(FILM, { audioLang: 'en' })).toBeNull();
    expect(await setup({ disk, ready: [h(5)], probes: { [h(5)]: MP4_DE } }).source.fromDisk(FILM, { audioLang: 'en' })).toBeNull();
  });
});

describe('runSubtitleChain', () => {
  const english: CacheSubtitleView = { url: '/api/stream/torrent/x/sub/0.vtt', lang: 'en', label: 'English' };
  const ctx = { ref: FILM, imdbId: null, infoHash: h(1), release: 'Film', files: [], fileIndex: 0, subtitleIndexes: [], handle: null, probe: MP4_EN, audioLang: 'en', resumeS: null, cloudTried: false, localBase: BASE, signal: new AbortController().signal };
  const tier = (name: string, find: SubtitleTier['find'], extra: Partial<SubtitleTier> = {}): SubtitleTier => ({ name, blocks: true, find, ...extra });

  it('stops at the first tier that answers anything (a lone unnamed track too), with one attempt per tier asked', async () => {
    const lines: string[] = [];
    const lone: CacheSubtitleView = { url: '/lone.vtt', lang: null, label: '' };
    const out = await runSubtitleChain(
      [
        tier('broken', async () => Promise.reject(new Error('boom'))),
        tier('empty', async () => []),
        tier('files', async () => [lone]),
        tier('never', async () => Promise.reject(new Error('must not be asked'))),
      ],
      ctx,
      { log: (l) => lines.push(l) },
    );
    expect(out.subtitles).toEqual([lone]);
    expect(out.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: broken=error', 'Subtitles: empty=no_stream', 'Subtitles: files=resolved']);
    expect(lines).toHaveLength(1);
    expect(await runSubtitleChain([], ctx)).toEqual({ subtitles: [], attempts: [], later: null });
  });

  it('shares one 40 s budget among the blocking tiers, skips one past it, never counts a growing tier, and honours a tier\'s own skip', async () => {
    let now = 0;
    const out = await runSubtitleChain(
      [
        tier('borrow', async () => [english], { skip: () => 'Whisper covers English audio' }),
        tier('slow', async () => ((now += 41_000), [])),
        tier('service', async () => [english]),
        tier('whisper', async (c) => [{ ...english, url: `/cues/${c.deadline}` }], { blocks: false }),
      ],
      ctx,
      { now: () => now },
    );
    expect(out.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: borrow=skipped', 'Subtitles: slow=no_stream', 'Subtitles: service=skipped', 'Subtitles: whisper=resolved']);
    expect(out.attempts[2]?.detail).toBe('the 40 s subtitle budget was spent');
    expect(out.subtitles[0]?.url).toBe(`/cues/${SUBTITLE_BUDGET_MS}`);
  });

  const fileSub: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/file-3.vtt`, lang: 'en', label: 'English' };
  const serviceSub: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/service-wyzie-1.vtt`, lang: 'en', label: 'English (Wyzie)' };
  const syncedSub: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/sub/synced-0.vtt`, lang: 'en', label: 'English (Wyzie, synced)' };
  const embeddedSub: CacheSubtitleView = { url: `/api/stream/torrent/${h(1)}/cues/embedded-0-2`, lang: 'en', label: 'English', growing: true };
  const files = (ms: number, found: CacheSubtitleView[]): SubtitleTier => tier('files', async () => (await wait(ms), found), { blocks: false, aside: true, release: true });

  it('a release file on disk at once ends the chain: nothing after it is asked', async () => {
    const out = await runSubtitleChain([files(0, [fileSub]), tier('service', async () => Promise.reject(new Error('must not be asked')))], ctx, { asideHeadMs: 50 });
    expect(out.subtitles).toEqual([fileSub]);
    expect(out.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: files=resolved']);
    expect(out.later).toBeNull();
  });

  it('the release file\'s wait holds back neither the embedded track nor the service; arriving later, it is handed over', async () => {
    const out = await runSubtitleChain([files(60, [fileSub]), tier('embedded', async () => [], { blocks: false, release: true }), tier('service', async () => [serviceSub])], ctx, { asideHeadMs: 5 });
    expect(out.subtitles).toEqual([serviceSub]);
    expect(out.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: embedded=no_stream', 'Subtitles: service=resolved', 'Subtitles: files=skipped']);
    const later = await out.later;
    expect(later?.subtitles).toEqual([fileSub]);
    expect(later?.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: files=resolved']);
  });

  it('a release file that arrives while a service is still asked wins at once', async () => {
    const out = await runSubtitleChain([files(20, [fileSub]), tier('service', async () => (await wait(200), [serviceSub]))], ctx, { asideHeadMs: 5 });
    expect(out.subtitles).toEqual([fileSub]);
    expect(out.attempts.map((a) => `${a.provider}=${a.outcome}`)).toEqual(['Subtitles: files=resolved', 'Subtitles: service=skipped']);
    expect(out.later).toBeNull();
  });

  it('a kept choice from outside the release is shown, but the release\'s own subtitle still takes its place', async () => {
    const kept = (found: CacheSubtitleView[]): SubtitleTier => tier('kept', async () => found, { provisional: (f) => f.every((t) => !t.url.includes('/file-') && !t.url.includes('/checked-')) });
    const service = tier('service', async () => Promise.reject(new Error('must not be asked')));
    const embedded = tier('embedded', async () => [embeddedSub], { blocks: false, release: true });
    // The track inside the video outranks a kept service file.
    const a = await runSubtitleChain([kept([syncedSub]), files(0, []), embedded, service], ctx, { asideHeadMs: 5 });
    expect(a.subtitles).toEqual([embeddedSub]);
    // No release subtitle: the kept file stands, and no service is asked.
    const b = await runSubtitleChain([kept([syncedSub]), files(0, []), tier('embedded', async () => [], { blocks: false, release: true }), service], ctx, { asideHeadMs: 5 });
    expect(b.subtitles).toEqual([syncedSub]);
    expect(b.attempts.map((x) => x.provider)).toEqual(['Subtitles: kept', 'Subtitles: files', 'Subtitles: embedded']);
    // A release file that is still downloading is handed over later.
    const c = await runSubtitleChain([kept([syncedSub]), files(30, [fileSub]), service], ctx, { asideHeadMs: 5 });
    expect(c.subtitles).toEqual([syncedSub]);
    expect((await c.later)?.subtitles).toEqual([fileSub]);
    // A checked choice ends the chain.
    const checked = { ...fileSub, url: `/api/stream/torrent/${h(1)}/sub/checked-0-ab.vtt` };
    const d = await runSubtitleChain([kept([checked]), tier('files', async () => Promise.reject(new Error('must not be asked')), { aside: true, release: true, blocks: false })], ctx);
    expect(d.subtitles).toEqual([checked]);
    expect(d.attempts).toHaveLength(1);
  });

  it('gives up on a blocking tier still running when the budget runs out', async () => {
    const out = await runSubtitleChain([tier('hung', () => new Promise(() => undefined))], ctx, { budgetMs: 20 });
    expect(out.attempts).toEqual([expect.objectContaining({ provider: 'Subtitles: hung', outcome: 'error' })]);
  });
});
