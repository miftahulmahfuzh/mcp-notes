import { describe, expect, it } from 'vitest';
import type { CacheSubtitleView } from '../../../src/directStream/cachePlay.js';
import type { StreamRef } from '../../../src/directStream/types.js';
import { parseRelease, type TorrentCandidate } from '../../../src/directStream/torrent/find/index.js';
import { ProbeError, type MediaProbe } from '../../../src/directStream/torrent/probe.js';
import { runSubtitleChain, SUBTITLE_BUDGET_MS, type SubtitleTier } from '../../../src/directStream/torrent/subtitles/chain.js';
import { MAX_TORRENT_TRIES, TorrentSource, type DownloadOnDisk, type FindAnswer, type TorrentSwarm } from '../../../src/directStream/torrent/source.js';
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
  files?: Record<string, TorrentFileInfo[]>;
  failOpen?: string[];
  probes?: Record<string, MediaProbe | 'timeout'>;
  ready?: string[];
  disk?: DownloadOnDisk | null;
  tiers?: SubtitleTier[];
  onFind?: (query: unknown) => void;
  /** Wyzie Synced as a recorder of what it was started with. */
  sync?: SyncRequest[];
}

function setup(o: Fakes = {}) {
  const calls: string[] = [];
  const probed: string[] = [];
  const durations: string[] = [];
  const swarm: TorrentSwarm = {
    open: async (pick) => {
      calls.push(`open ${pick.infoHash}`);
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
  };
  let finds = 0;
  const answer: FindAnswer = { candidates: o.candidates ?? [], indexes: [{ index: 'torrentio', outcome: 'ok', detail: `${(o.candidates ?? []).length} candidates`, took_s: 0.3, listed: (o.candidates ?? []).length }], excluded: [] };
  const source = new TorrentSource({
    swarm,
    find: async (query) => {
      finds += 1;
      o.onFind?.(query);
      return answer;
    },
    probe: async (url) => {
      probed.push(url);
      const hash = /\/torrent\/([0-9a-f]+)\//.exec(url)?.[1] ?? '';
      const p = o.probes?.[hash] ?? MP4_EN;
      if (p === 'timeout') throw new ProbeError('timeout', 'ffprobe gave up after 30 s');
      return p;
    },
    tiers: o.tiers ?? [],
    ...(o.sync === undefined ? {} : { sync: { start: (request) => (o.sync?.push(request), null) } }),
    localBase: () => BASE,
    log: () => undefined,
  });
  // Releases are handed to the swarm on the next tick.
  const settled = async (): Promise<string[]> => {
    await new Promise((r) => setTimeout(r, 0));
    return calls;
  };
  return { source, calls, settled, probed, durations, finds: () => finds };
}

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
      ['dubbed', 'its audio is de, not the original en'],
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
    expect(out.attempts[1]?.detail).toBe('matroska hevc 1080p / eac3: Chrome does not play it as is');
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

  it('asks no index without an IMDb id, and says why in attempts', async () => {
    const t = setup({ candidates: [candidate(h(1), 'Film.2026.720p.WEB-DL.x264.AAC-A')] });
    const out = await t.source.resolve(FILM, { audioLang: 'en', imdbId: null });
    expect(out.ok).toBe(false);
    expect(out.attempts).toEqual([expect.objectContaining({ provider: 'Index: all', outcome: 'error' })]);
    expect(t.finds()).toBe(0);
    expect(await t.settled()).toEqual([]);
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
    expect(await runSubtitleChain([], ctx)).toEqual({ subtitles: [], attempts: [] });
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

  it('gives up on a blocking tier still running when the budget runs out', async () => {
    const out = await runSubtitleChain([tier('hung', () => new Promise(() => undefined))], ctx, { budgetMs: 20 });
    expect(out.attempts).toEqual([expect.objectContaining({ provider: 'Subtitles: hung', outcome: 'error' })]);
  });
});
