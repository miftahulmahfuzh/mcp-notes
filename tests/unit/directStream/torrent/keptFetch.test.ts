import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandAllows } from '../../../../src/directStream/downloads/plan.js';
import type { StreamRef } from '../../../../src/directStream/types.js';
import { parseRelease, type SwarmCount, type TorrentCandidate } from '../../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../../src/directStream/torrent/probe.js';
import { REMUX_DONE_FILE, remuxDir, TorrentRemux } from '../../../../src/directStream/torrent/remux.js';
import type { SubtitleTier } from '../../../../src/directStream/torrent/subtitles/chain.js';
import { TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentHearer, type TorrentSwarm } from '../../../../src/directStream/torrent/source.js';
import { fakeFfmpeg } from '../remuxFakes.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 467905 };
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
const MP4_EN: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 620, direct: true };
const MP4_DE: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: 'ger' }] };
const MP4_UNTAGGED: MediaProbe = { ...MP4_EN, audio: [{ codec: 'aac', lang: null }] };
const MKV: MediaProbe = { container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'ac3', lang: 'eng' }], subtitles: [], durationS: 620, direct: false };
const preferred = (c: TorrentCandidate, count: SwarmCount | null): boolean => bandAllows('preferred', c, count);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-kept-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(o: {
  candidates?: TorrentCandidate[];
  probes?: Record<string, MediaProbe>;
  heard?: Record<string, 'original' | 'dubbed'>;
  tiers?: SubtitleTier[];
  subtitleHeadMs?: number;
  remux?: TorrentRemux;
  ready?: string[];
  stored?: Record<string, string[]>;
  counts?: Record<string, SwarmCount>;
  disk?: DownloadOnDisk | null;
}) {
  const calls: string[] = [];
  const opened: { infoHash: string; trackers: readonly string[] }[] = [];
  let finds = 0;
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
      opened.push({ infoHash: pick.infoHash, trackers: pick.trackers });
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.1080p.mkv', name: 'Film.2026.1080p.mkv', length: 700_000_000 }] };
    },
    use: (infoHash) => void calls.push(`use ${infoHash}`),
    release: (infoHash) => void calls.push(`release ${infoHash}`),
    drop: (infoHash) => void calls.push(`drop ${infoHash}`),
    discard: (infoHash) => void calls.push(`discard ${infoHash}`),
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/data/torrents/${infoHash}/${index}.mkv` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    setDuration: () => undefined,
    trackersOf: async (infoHash) => o.stored?.[infoHash] ?? [],
  };
  const hear: TorrentHearer = {
    hear: async (source) => {
      const hash = /\/torrent\/([0-9a-f]+)\//.exec(source.manifest_url)?.[1] ?? '';
      const verdict = o.heard?.[hash] ?? 'original';
      return { verdict, detected: verdict === 'dubbed' ? 'ru' : 'en', probability: 0.97, reason: verdict === 'dubbed' ? 'the audio is spoken ru, not the original en' : 'the audio is spoken en' };
    },
  };
  const answer: FindAnswer = { candidates: o.candidates ?? [], indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: (o.candidates ?? []).length }], excluded: [], lastResort: [] };
  const source = new TorrentSource({
    swarm,
    find: async () => {
      finds += 1;
      return answer;
    },
    probe: async (url) => o.probes?.[/\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? ''] ?? MP4_EN,
    tiers: o.tiers ?? [],
    remux: o.remux ?? null,
    hear,
    ...(o.counts === undefined ? {} : { scrape: async () => new Map(Object.entries(o.counts!)) }),
    localBase: () => BASE,
    settleMs: 5,
    ...(o.subtitleHeadMs === undefined ? {} : { subtitleHeadMs: o.subtitleHeadMs }),
    log: () => undefined,
  });
  return { source, calls, opened, finds: () => finds };
}

const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('never');
};

describe('R1.2 TorrentSource.fetchKept keeps to the band it is given', () => {
  it('opens only the 1080p torrent with live seeds', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264'), candidate(h(2), 'Film.2026.1080p.WEB-DL.x264')] });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(t.opened.map((x) => x.infoHash)).toEqual([h(2)]);
  });

  it('opens nothing when the only 1080p torrent has no seeder by the trackers’ word', async () => {
    const t = setup({ candidates: [candidate(h(2), 'Film.2026.1080p.WEB-DL.x264', 40)], counts: { [h(2)]: { seeders: 0, leechers: 2, trackers: 2 } } });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    expect(out).toMatchObject({ ok: false, error: 'no_source' });
    expect(t.opened).toEqual([]);
  });
});

describe('R1.5 a dub is left undownloaded and the next torrent taken', () => {
  it('passes over a release whose tags name another language', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.GER'), candidate(h(2), 'Film.2026.1080p.WEB-DL')], probes: { [h(1)]: MP4_DE } });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.infoHash).toBe(h(2));
    expect(out.attempts.find((a) => a.provider.includes('GER'))?.outcome).toBe('dubbed');
  });

  it('hears a file that tags no language, lets a dub go, and keeps the next one heard as the original', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.A'), candidate(h(2), 'Film.2026.1080p.WEB-DL.B')],
      probes: { [h(1)]: MP4_UNTAGGED, [h(2)]: MP4_UNTAGGED },
      heard: { [h(1)]: 'dubbed' },
    });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.infoHash).toBe(h(2));
    expect(t.calls).toContain(`drop ${h(1)}`);
    expect(out.attempts.find((a) => a.provider.endsWith('.A') && a.outcome === 'dubbed')?.detail).toContain('audio heard');
  });

  it('answers dubbed when every torrent found is a dub', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL.GER')], probes: { [h(1)]: MP4_DE } });
    expect(await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905', only: preferred })).toMatchObject({ ok: false, error: 'dubbed' });
  });
});

describe('R1.8 a kept torrent is finished offline-ready', () => {
  it('lets the subtitle search run to its end (a fetch ahead stops it)', async () => {
    const tier: SubtitleTier = { name: 'service', blocks: true, find: () => new Promise((r) => setTimeout(() => r([]), 60)) };
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.WEB-DL')], tiers: [tier], subtitleHeadMs: 5 });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.stop.signal.aborted).toBe(false);
    expect(await t.source.keptState(out.torrent)).toEqual({ file: 'downloading', remux: 'none', subtitles: 'searching' });
    await out.torrent.subtitlesPending;
    expect((await t.source.keptState(out.torrent)).subtitles).toBe('done');
  });

  it('keeps the remux of a file Chrome cannot play running to its end, and the finished remux stays after the release', async () => {
    const ffmpeg = fakeFfmpeg({ segmentsAtStart: 1 });
    const remux = new TorrentRemux({ dir, spawn: ffmpeg.spawn, pollMs: 5, log: () => undefined });
    const ready: string[] = [];
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.AC3')], probes: { [h(1)]: MKV }, remux, ready });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('no torrent kept');
    expect(out.torrent.manifestKind).toBe('hls');
    expect(await t.source.keptState(out.torrent)).toMatchObject({ remux: 'running' });
    ready.push(h(1));
    await ffmpeg.runs[0]!.write(4, true);
    ffmpeg.runs[0]!.exit(0);
    await until(async () => (await t.source.keptState(out.torrent)).remux === 'whole');
    expect(await t.source.keptState(out.torrent)).toEqual({ file: 'whole', remux: 'whole', subtitles: 'done' });
    t.source.release(out.torrent);
    expect(remux.status(h(1), 0)).toBe('whole');
    expect(existsSync(path.join(remuxDir(dir, h(1), 0), REMUX_DONE_FILE))).toBe(true);
  });

  it('opens one torrent by its info hash with the trackers this host kept, asking no index', async () => {
    const t = setup({ stored: { [h(9)]: ['udp://stored.example:1337/announce'] } });
    const out = await t.source.fetchKept(FILM, { audioLang: 'en', imdbId: null, infoHash: h(9) });
    expect(out.ok && out.torrent.infoHash).toBe(h(9));
    expect(t.finds()).toBe(0);
    expect(t.opened[0]!.trackers).toContain('udp://stored.example:1337/announce');
  });

  it('plays a finished download from disk later with no index asked and no swarm joined', async () => {
    const t = setup({ disk: { infoHash: h(1), name: 'Film.2026.1080p.WEB-DL', fileIndex: 0, state: 'ready' }, ready: [h(1)] });
    expect(await t.source.onDisk(FILM)).toBe(true);
    expect(await t.source.fromDisk(FILM, { audioLang: 'en' })).not.toBeNull();
    expect(t.finds()).toBe(0);
    expect(t.calls.filter((c) => c.startsWith('open '))).toEqual([]);
  });
});
