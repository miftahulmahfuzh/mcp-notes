import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamRef } from '../../../src/directStream/types.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import type { MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { REMUX_DONE_FILE, REMUX_PROBE_FILE, remuxDir, TorrentRemux } from '../../../src/directStream/torrent/remux.js';
import { REMUX_STARVED_BYTES, remuxTimeoutOutcome, TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
import { eventPlaylist, fakeFfmpeg } from './remuxFakes.js';

const FILM: StreamRef = { kind: 'movie', tmdbId: 467905 };
const BASE = 'http://127.0.0.1:4321';
const h = (n: number): string => n.toString(16).padStart(40, '0');
const candidate = (infoHash: string, name: string): TorrentCandidate => ({
  infoHash,
  name,
  fileName: null,
  fileIdx: null,
  seeds: 40,
  sizeBytes: 700_000_000,
  index: 'torrentio',
  listedBy: ['torrentio'],
  site: null,
  trackers: ['http://127.0.0.1:1/announce'],
  scoped: false,
  release: parseRelease(name),
});
const MKV_AC3: MediaProbe = { container: 'matroska,webm', video: { codec: 'h264', height: 1080 }, audio: [{ codec: 'ac3', lang: 'spa' }, { codec: 'ac3', lang: 'eng' }], subtitles: [], durationS: 120, direct: false };
const MPEG2: MediaProbe = { ...MKV_AC3, video: { codec: 'mpeg2video', height: 576 } };
const MP4: MediaProbe = { container: 'mov,mp4,m4a,3gp,3g2,mj2', video: { codec: 'h264', height: 720 }, audio: [{ codec: 'aac', lang: 'eng' }], subtitles: [], durationS: 120, direct: true };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'notesd-remux-source-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(o: { candidates: TorrentCandidate[]; probes: Record<string, MediaProbe>; ready?: string[]; remuxOnly?: string[]; disk?: DownloadOnDisk | null; ffmpeg?: ReturnType<typeof fakeFfmpeg> }) {
  const probed: string[] = [];
  const calls: string[] = [];
  const ffmpeg = o.ffmpeg ?? fakeFfmpeg({ segmentsAtStart: 1 });
  const remux = new TorrentRemux({ dir, spawn: ffmpeg.spawn, pollMs: 5, log: () => undefined });
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
      return { infoHash: pick.infoHash, files: [{ index: 0, path: 'Film.2026.1080p.mkv', name: 'Film.2026.1080p.mkv', length: 700_000_000 }] };
    },
    use: (infoHash) => {
      calls.push(`use ${infoHash}`);
    },
    release: (infoHash) => {
      calls.push(`release ${infoHash}`);
    },
    find: async () => o.disk ?? null,
    filePath: (infoHash, index) => ((o.ready ?? []).includes(infoHash) ? `/data/torrents/${infoHash}/${index}.mkv` : null),
    localUrl: (infoHash, index) => `/api/stream/torrent/${infoHash}/f/${index}`,
    remuxOnly: (infoHash) => (o.remuxOnly ?? []).includes(infoHash),
    setDuration: () => undefined,
  };
  const answer: FindAnswer = { candidates: o.candidates, indexes: [{ index: 'torrentio', outcome: 'ok', detail: '', took_s: 0.1, listed: o.candidates.length }], excluded: [], lastResort: [] };
  const source = new TorrentSource({
    swarm,
    find: async () => answer,
    probe: async (url) => {
      probed.push(url);
      return o.probes[/\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? ''] ?? MP4;
    },
    tiers: [],
    remux,
    localBase: () => BASE,
    log: () => undefined,
  });
  return { source, remux, ffmpeg, calls, probed };
}

describe('TorrentSource with the remux (torrent phase 5, R2.8)', () => {
  it('plays an MKV with AC3 sound through the remux: an hls session on the remux playlist, ffmpeg reading the file route', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-GRP')], probes: { [h(1)]: MKV_AC3 } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const playlist = `/api/stream/torrent/${h(1)}/hls/0/index.m3u8?remux=1&total_s=120`;
    expect(out.torrent).toMatchObject({ manifestUrl: playlist, manifestKind: 'hls', durationS: 120 });
    expect(out.source).toMatchObject({ provider: 'Torrent', manifest_url: playlist, manifest_kind: 'hls' });
    expect(out.attempts.at(-1)).toMatchObject({ outcome: 'resolved', detail: 'matroska h264 1080p / ac3+ac3, remuxed, 40 seeds' });
    expect(t.ffmpeg.runs[0]?.args).toContain(`${BASE}/api/stream/torrent/${h(1)}/f/0`);
    expect(t.ffmpeg.runs[0]?.args).toContain('0:a:1');
  });

  it('has ffmpeg read the file from disk once the download is whole', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-GRP')], probes: { [h(1)]: MKV_AC3 }, ready: [h(1)] });
    await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(t.ffmpeg.runs[0]?.args).toContain(`/data/torrents/${h(1)}/0.mkv`);
  });

  it('leaves a file whose video Chrome cannot decode as unplayable without running ffmpeg, and plays the next', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.DVD.MPEG2-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')], probes: { [h(1)]: MPEG2, [h(2)]: MP4 } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.manifestKind).toBe('mp4');
    expect(out.attempts[1]).toMatchObject({ outcome: 'unplayable', detail: 'matroska mpeg2video 576p / ac3+ac3: Chrome does not play it as is, and a remux cannot make its video playable' });
    expect(t.ffmpeg.runs).toHaveLength(0);
  });

  it('makes a remux that does not start unplayable with its reason, releases that torrent and plays the next', async () => {
    const t = setup({
      candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-A'), candidate(h(2), 'Film.2026.720p.WEB-DL.x264.AAC-B')],
      probes: { [h(1)]: MKV_AC3, [h(2)]: MP4 },
      ffmpeg: fakeFfmpeg({ exitAtStart: 1 }),
    });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    expect(out.ok && out.torrent.infoHash).toBe(h(2));
    expect(out.attempts[1]?.outcome).toBe('unplayable');
    expect(out.attempts[1]?.detail).toContain('the remux did not start');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls).toContain(`release ${h(1)}`);
  });

  it('stops the remux when the session lets go of its torrent, and starts it again when the session takes it back', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.1080p.BluRay.x264.AC3-GRP')], probes: { [h(1)]: MKV_AC3 } });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: 'tt0467905' });
    if (!out.ok) throw new Error('no play');
    t.source.release(out.torrent);
    expect(t.ffmpeg.runs[0]?.killed).toBe(true);
    await t.source.hold(FILM, out.torrent);
    expect(t.ffmpeg.runs).toHaveLength(2);
    expect(await t.remux.map(h(1))).toEqual({ duration_s: 120, ranges: [[0, 6]] });
  });

  it('plays a finished download again from disk through its finished remux, with no ffmpeg', async () => {
    const files = remuxDir(dir, h(1), 0);
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, 'index.m3u8'), eventPlaylist(20, true));
    await writeFile(path.join(files, REMUX_DONE_FILE), '{}');
    const t = setup({ candidates: [], probes: { [h(1)]: MKV_AC3 }, ready: [h(1)], disk: { infoHash: h(1), name: 'Film.2026.1080p.BluRay.x264.AC3-GRP', fileIndex: 0, state: 'ready' } });
    const disk = await t.source.fromDisk(FILM, { audioLang: 'en' });
    expect(disk?.torrent).toMatchObject({ manifestKind: 'hls', manifestUrl: `/api/stream/torrent/${h(1)}/hls/0/index.m3u8?remux=1&total_s=120`, candidate: null });
    expect(t.ffmpeg.runs).toHaveLength(0);
    expect(existsSync(path.join(files, REMUX_DONE_FILE))).toBe(true);
    await vi.waitFor(async () => expect(await t.remux.map(h(1))).toEqual({ duration_s: 120, ranges: [[0, 120]] }));
  });

  it('plays a download whose original was deleted beside its remux from the remux alone, with the probe kept beside it', async () => {
    const files = remuxDir(dir, h(1), 0);
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, 'index.m3u8'), eventPlaylist(20, true));
    await writeFile(path.join(files, REMUX_DONE_FILE), '{}');
    // Kept when the remux started: the original's streams, so the probe never reads the (gone) file again.
    const kept: MediaProbe = { ...MKV_AC3, direct: true, container: 'mov,mp4,m4a,3gp,3g2,mj2' };
    await writeFile(path.join(files, REMUX_PROBE_FILE), JSON.stringify(kept));
    const t = setup({ candidates: [], probes: {}, remuxOnly: [h(1)], disk: { infoHash: h(1), name: 'Film.2026.1080p.BluRay.x264.AC3-GRP', fileIndex: 0, state: 'ready' } });
    const disk = await t.source.fromDisk(FILM, { audioLang: 'en' });
    // The probe says MP4 now, yet nothing but the remux is there: the remux plays, never the file route.
    expect(disk?.torrent).toMatchObject({ manifestKind: 'hls', manifestUrl: `/api/stream/torrent/${h(1)}/hls/0/index.m3u8?remux=1&total_s=120`, state: 'ready', height: 1080 });
    expect(t.probed).toEqual([]);
    expect(t.ffmpeg.runs).toHaveLength(0);
    expect(await t.source.state(disk!.torrent)).toBe('ready');
    // No probe kept: the replay is passed over rather than reading a file that is not there.
    await rm(path.join(files, REMUX_PROBE_FILE));
    expect(await t.source.fromDisk(FILM, { audioLang: 'en' })).toBeNull();
    expect(t.probed).toEqual([]);
  });
});

describe('remuxTimeoutOutcome: a remux with no segment in time, read against what the swarm delivered', () => {
  it('is no_stream when the swarm sent under two segments of the film, unplayable when ffmpeg had the bytes', () => {
    // A 9.6 Mbps film: two 6 s segments are 14.4 MB.
    expect(remuxTimeoutOutcome(3_000_000, 9_600)).toBe('no_stream');
    expect(remuxTimeoutOutcome(20_000_000, 9_600)).toBe('unplayable');
    // Without the film's bitrate, a flat 8 MiB.
    expect(remuxTimeoutOutcome(REMUX_STARVED_BYTES - 1, null)).toBe('no_stream');
    expect(remuxTimeoutOutcome(REMUX_STARVED_BYTES, null)).toBe('unplayable');
    // A swarm that cannot say what it received: the verdict stays as before.
    expect(remuxTimeoutOutcome(null, 9_600)).toBe('unplayable');
  });
});
