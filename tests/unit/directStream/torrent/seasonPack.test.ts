import { describe, expect, it } from 'vitest';
import { parseRelease, type SwarmCount, type TorrentCandidate } from '../../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../../src/directStream/torrent/probe.js';
import { seasonPacks } from '../../../../src/directStream/torrent/seasonPack.js';
import { TorrentSource, type FindAnswer, type PackOptions, type TorrentSwarm } from '../../../../src/directStream/torrent/source.js';
import type { TorrentFileInfo } from '../../../../src/directStream/torrent/types.js';

const h = (n: number): string => n.toString(16).padStart(40, '0');
const PACK_1080 = h(1);
const PACK_720 = h(2);
const MULTI = h(3);
const SINGLE = h(4);
const OTHER_SEASON = h(5);
const pad = (n: number): string => String(n).padStart(2, '0');

const candidate = (infoHash: string, name: string, seeds: number): TorrentCandidate => ({
  infoHash,
  name,
  fileName: null,
  fileIdx: null,
  seeds,
  sizeBytes: 9_000_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['http://127.0.0.1:1/announce'],
  scoped: false,
  release: parseRelease(name),
});

const CANDIDATES = [
  candidate(PACK_720, 'Fixture.Show.S01.720p.WEB.x264', 90),
  candidate(PACK_1080, 'Fixture.Show.S01.1080p.WEB.x264', 40),
  candidate(MULTI, 'Fixture.Show.S01-S03.1080p.WEB.x264', 200),
  candidate(SINGLE, 'Fixture.Show.S01E01.1080p.WEB.x264', 300),
  candidate(OTHER_SEASON, 'Fixture.Show.S02.1080p.WEB.x264', 300),
];

const file = (index: number, filePath: string): TorrentFileInfo => ({ index, path: filePath, name: filePath.split('/').pop() ?? filePath, length: 500_000_000 });
const seasonFiles = (episodes: number[], season = 1): TorrentFileInfo[] => episodes.map((e, i) => file(i, `Fixture.Show/Fixture.Show.S${pad(season)}E${pad(e)}.1080p.mp4`));

const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 2_700, direct: true };
const MP4_DE: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }] };

const ids = (list: TorrentCandidate[]): string[] => list.map((c) => c.infoHash);

describe('seasonPacks', () => {
  it('keeps the packs that hold the season, the preferred height first, one season before a range, a dead swarm out', () => {
    expect(ids(seasonPacks(CANDIDATES, 1, new Map(), null))).toEqual([PACK_1080, MULTI, PACK_720]);
    expect(ids(seasonPacks(CANDIDATES, 1, new Map(), 1080))).toEqual([PACK_1080, MULTI]);
    const dead = new Map<string, SwarmCount>([[PACK_1080, { seeders: 0, leechers: 3, trackers: 3 }]]);
    expect(ids(seasonPacks(CANDIDATES, 1, dead, 1080))).toEqual([MULTI]);
    expect(ids(seasonPacks(CANDIDATES, 2, new Map(), null))).toEqual([OTHER_SEASON, MULTI]);
  });
});

function setup(o: { files?: Record<string, TorrentFileInfo[]>; probes?: Record<string, MediaProbe>; candidates?: TorrentCandidate[] } = {}) {
  const calls: string[] = [];
  let finds = 0;
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
      return { infoHash: pick.infoHash, files: o.files?.[pick.infoHash] ?? seasonFiles([1, 2, 3]) };
    },
    use: (infoHash, indexes) => {
      calls.push(`use ${infoHash} ${indexes.join(',')}`);
    },
    useSlot: (pick, indexes) => {
      calls.push(`useSlot ${pick.infoHash} E${pick.ref.kind === 'tv' ? pick.ref.episode : 0} ${indexes.join(',')}`);
    },
    release: (infoHash) => {
      calls.push(`release ${infoHash}`);
    },
    drop: (infoHash) => {
      calls.push(`drop ${infoHash}`);
    },
    discard: (infoHash) => {
      calls.push(`discard ${infoHash}`);
    },
    find: async () => null,
    filePath: () => null,
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
  };
  const source = new TorrentSource({
    swarm,
    find: async () => {
      finds += 1;
      const answer: FindAnswer = { candidates: o.candidates ?? CANDIDATES, indexes: [], excluded: [], lastResort: [] };
      return answer;
    },
    probe: async (url) => {
      const m = /\/torrent\/([0-9a-f]+)\/f\/(\d+)/.exec(url);
      calls.push(`probe ${m?.[1]} ${m?.[2]}`);
      return o.probes?.[m?.[1] ?? ''] ?? MP4_EN;
    },
    tiers: [],
    localBase: () => 'http://127.0.0.1:4321',
    log: () => undefined,
  });
  return { source, calls, finds: () => finds };
}

const OPTIONS: PackOptions = { audioLang: 'en', imdbId: null, names: null, heights: 'preferred' };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('TorrentSource.fetchPack', () => {
  it("opens one pack once, checks the first episode's audio before any other is taken, and takes a hold per episode", async () => {
    const { source, calls } = setup();
    const out = await source.fetchPack(1399, 1, [3, 1, 2], OPTIONS);
    expect(out.ok && out.pack).toMatchObject({ infoHash: PACK_1080, episodes: [{ episode: 1, video: 0 }, { episode: 2, video: 1 }, { episode: 3, video: 2 }], lacking: [] });
    expect(calls).toEqual([`open ${PACK_1080}`, `useSlot ${PACK_1080} E1 0`, `probe ${PACK_1080} 0`, `useSlot ${PACK_1080} E2 1`, `useSlot ${PACK_1080} E3 2`]);
  });

  it('lets go of a pack whose first episode is a dub before the rest is taken, and tries the next', async () => {
    const { source, calls } = setup({ probes: { [PACK_1080]: MP4_DE } });
    const out = await source.fetchPack(1399, 1, [1, 2, 3], OPTIONS);
    await settle();
    expect(out.ok && out.pack.infoHash).toBe(MULTI);
    expect(calls.filter((c) => c.startsWith(`useSlot ${PACK_1080}`))).toEqual([`useSlot ${PACK_1080} E1 0`]);
    expect(calls).toContain(`drop ${PACK_1080}`);
    expect(out.ok && out.pack.attempts.find((a) => a.provider.includes('S01.1080p'))?.outcome).toBe('dubbed');
  });

  it('asks only for a 1080p pack with no source named; any height when a torrent is asked for', async () => {
    const only720 = [candidate(PACK_720, 'Fixture.Show.S01.720p.WEB.x264', 90)];
    const preferred = setup({ candidates: only720 });
    expect(await preferred.source.fetchPack(1399, 1, [1, 2, 3], OPTIONS)).toMatchObject({ ok: false, error: 'no_pack' });
    expect(preferred.calls).toEqual([]);
    const any = setup({ candidates: only720 });
    const out = await any.source.fetchPack(1399, 1, [1, 2, 3], { ...OPTIONS, heights: 'any' });
    expect(out.ok && out.pack.infoHash).toBe(PACK_720);
  });

  it('says which wanted episodes the pack lacks, and lets go of a pack holding none of them', async () => {
    const lacking = setup({ files: { [PACK_1080]: [file(0, 'Fixture.Show/Fixture.Show.S01E01.mp4'), file(1, 'Fixture.Show/Fixture.Show.S01E03.mp4')] } });
    const out = await lacking.source.fetchPack(1399, 1, [1, 2, 3], OPTIONS);
    expect(out.ok && out.pack).toMatchObject({ infoHash: PACK_1080, episodes: [{ episode: 1, video: 0 }, { episode: 3, video: 1 }], lacking: [2] });
    const none = setup({ files: { [PACK_1080]: seasonFiles([1, 2, 3], 2) } });
    const next = await none.source.fetchPack(1399, 1, [1, 2, 3], OPTIONS);
    await settle();
    expect(next.ok && next.pack.infoHash).toBe(MULTI);
    expect(none.calls).toContain(`discard ${PACK_1080}`);
  });

  it('tries the pack a batch was downloading from before a restart first, with no index asked', async () => {
    const { source, finds } = setup();
    const out = await source.fetchPack(1399, 1, [1, 2, 3], { ...OPTIONS, known: PACK_720 });
    expect(out.ok && out.pack.infoHash).toBe(PACK_720);
    expect(finds()).toBe(0);
  });
});
