import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MOVIES_CONFIG, REPO_ROOT } from '../../../src/config.js';
import type { Db } from '../../../src/db/client.js';
import type { AppDeps } from '../../../src/deps.js';
import { CACHE_PENDING_FILE, CacheShelf } from '../../../src/directStream/cacheShelf.js';
import { DisabledCanary, StreamCanary } from '../../../src/directStream/canary.js';
import type { StreamCache } from '../../../src/directStream/cache/service.js';
import type { StreamEvidence } from '../../../src/directStream/evidence.js';
import { StreamReporter } from '../../../src/directStream/report.js';
import type { DirectStreamService } from '../../../src/directStream/service.js';
import type { DirectStreamWiring } from '../../../src/directStream/start.js';
import { buildCacheShelf, buildCanary, buildStreamReporter, buildSubtitleCheck, playingNow, wireStreamExtras } from '../../../src/directStream/startExtras.js';
import { SubtitleCheckService } from '../../../src/directStream/subtitleCheck/subjects.js';
import { TitleSubtitleShelf } from '../../../src/directStream/titleSubtitles.js';
import { CueFeeds } from '../../../src/directStream/torrent/subtitles/feed.js';
import type { TorrentStreams } from '../../../src/directStream/torrent/service.js';
import type { WorkerTranscriber } from '../../../src/directStream/torrent/subtitles/whisper.js';
import { buildTrackerLists } from '../../../src/directStream/torrent/trackerLists.js';
import type { MoviePlayer } from '../../../src/movies/player.js';
import type { MoviesService } from '../../../src/movies/service.js';
import type { StreamLive } from '../../../src/movies/streamLive.js';
import type { MovieStreams } from '../../../src/movies/streams.js';
import { scriptWarp } from '../../../src/streaming/warp.js';
import { WHISPER_ON, startConfig, streamConfig } from '../../helpers/startConfig.js';

const db = {} as Db;

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return { config: startConfig(), db, events: {} as never, service: {} as never, embedder: null, imageEmbedder: null, chat: {} as never, adversary: null, movies: null, ...over };
}

function service(starting: number = 0): DirectStreamService {
  return {
    starting: vi.fn(() => Array.from({ length: starting }, () => ({ kind: 'movie', tmdb_id: 1, season: null, episode: null }))),
    providers: vi.fn(async () => [{ name: 'VidFast', id_kind: 'tmdb', browser_only: false }]),
    runResolve: vi.fn(async () => ({})),
    evidenceSource: vi.fn((id: string) => (id === 'live' ? {} : null)),
    aheadFetching: vi.fn(() => null),
  } as unknown as DirectStreamService;
}

describe('playingNow', () => {
  it('is true while a VLC play, a stream on screen or a stream being started exists', () => {
    expect(playingNow(deps())).toBe(false);
    expect(playingNow(deps({ moviesPlayer: { current: () => null } as unknown as MoviePlayer, streamLive: { current: () => null } as unknown as StreamLive, directStream: service(0) }))).toBe(false);
    expect(playingNow(deps({ moviesPlayer: { current: () => ({}) } as unknown as MoviePlayer }))).toBe(true);
    expect(playingNow(deps({ streamLive: { current: () => ({}) } as unknown as StreamLive }))).toBe(true);
    expect(playingNow(deps({ directStream: service(1) }))).toBe(true);
  });
});

describe('buildCanary', () => {
  it('is a DisabledCanary with NOTESD_STREAM_CANARY off, whatever else is on', () => {
    const c = buildCanary(streamConfig({ canary: false }), service(), () => false);
    expect(c).toBeInstanceOf(DisabledCanary);
    expect((c as DisabledCanary).reason).toBe('setting_off');
  });

  it('is a DisabledCanary with direct streaming off', () => {
    const c = buildCanary(streamConfig({ canary: true }), null, () => false);
    expect((c as DisabledCanary).reason).toBe('direct_stream_off');
  });

  it('asks the service for its providers and resolves through it, and waits while something plays', async () => {
    const svc = service();
    const busy = vi.fn(() => true);
    const c = buildCanary(streamConfig({ canary: true }), svc, busy);
    expect(c).toBeInstanceOf(StreamCanary);
    const o = (c as unknown as { o: { providers: () => Promise<unknown>; busy: () => boolean; resolve: (r: unknown, o: unknown) => unknown } }).o;
    expect(await o.providers()).toEqual([{ name: 'VidFast', idKind: 'tmdb', browserOnly: false }]);
    expect(o.busy()).toBe(true);
    await o.resolve('ref', { only: 'VidFast', deadlineS: 30 });
    expect(svc.runResolve).toHaveBeenCalledWith('ref', { only: 'VidFast', deadlineS: 30 });
  });
});

describe('buildCacheShelf', () => {
  const movies = { host: 'pc' } as unknown as MoviesService;
  const torrents = {} as TorrentStreams;
  const cache = {} as StreamCache;

  it('is null without the library, or with neither torrents nor the stream cache', () => {
    expect(buildCacheShelf(deps({ movies: null, torrents, streamCache: cache }))).toBeNull();
    expect(buildCacheShelf(deps({ movies, torrents: null, streamCache: null }))).toBeNull();
  });

  it('lists the unfinished downloads asked for, read from deps at each listing', async () => {
    const config = { ...startConfig(), movies: { ...DEFAULT_MOVIES_CONFIG, enabled: true } };
    const d = deps({ config, movies, torrents: null, streamCache: cache });
    const shelf = buildCacheShelf(d);
    expect(shelf).toBeInstanceOf(CacheShelf);
    const opts = (shelf as unknown as { opts: { pendingFile: string; downloads: { list: () => Promise<unknown[]> } } }).opts;
    expect(opts.pendingFile).toBe(join(config.dataDir, 'movies', CACHE_PENDING_FILE));
    // Built before the download queue: nothing to list yet.
    expect(await opts.downloads.list()).toEqual([]);
    d.streamDownloads = {
      list: async () => [
        { kind: 'movie', tmdb_id: 550, season: null, episode: null, state: 'running', progress: 0.5 },
        { kind: 'tv', tmdb_id: 1399, season: 1, episode: 2, state: 'paused', progress: 0.1 },
        { kind: 'movie', tmdb_id: 13, season: null, episode: null, state: 'done', progress: 1 },
        { kind: 'movie', tmdb_id: 14, season: null, episode: null, state: 'queued', progress: 0 },
      ],
    } as unknown as AppDeps['streamDownloads'];
    expect(await opts.downloads.list()).toEqual([
      { kind: 'movie', tmdbId: 550, season: 0, episode: 0, state: 'running', progress: 0.5 },
      { kind: 'tv', tmdbId: 1399, season: 1, episode: 2, state: 'paused', progress: 0.1 },
      { kind: 'movie', tmdbId: 14, season: 0, episode: 0, state: 'queued', progress: 0 },
    ]);
  });
});

describe('buildStreamReporter', () => {
  const evidence = { reportsDir: '/data/movies/stream-reports' } as unknown as StreamEvidence;

  it('needs direct streaming and the evidence log', () => {
    expect(buildStreamReporter(deps({ directStream: service(), streamEvidence: null }))).toBeNull();
    expect(buildStreamReporter(deps({ directStream: null, streamEvidence: evidence }))).toBeNull();
  });

  it('runs in this checkout and peeks at a session without marking it used', () => {
    const svc = service();
    const r = buildStreamReporter(deps({ directStream: svc, streamEvidence: evidence }));
    expect(r).toBeInstanceOf(StreamReporter);
    const o = (r as unknown as { opts: Record<string, unknown> }).opts;
    expect(o.cwd).toBe(REPO_ROOT);
    expect(o.reportsDir).toBe('/data/movies/stream-reports');
    expect((o.isLive as (id: string) => boolean)('live')).toBe(true);
    expect((o.isLive as (id: string) => boolean)('gone')).toBe(false);
  });
});

/** The Stream side at start, every part off unless named. */
function wiring(over: Partial<DirectStreamWiring> = {}): DirectStreamWiring {
  const titleSubtitles = new TitleSubtitleShelf('/data/movies/stream-subs');
  return {
    playLog: null,
    streaming: null,
    warp: scriptWarp(),
    streamLive: null,
    streamEvidence: null,
    directStream: null,
    streamCache: null,
    torrents: null,
    torrentRemux: null,
    trackerLists: buildTrackerLists(undefined, false),
    torrentCues: null,
    whisperTier: null,
    sharedWhisper: null,
    wyzie: null,
    subtitleSync: null,
    titleSubtitles,
    titleCues: new CueFeeds({ folderOf: (k) => `/data/movies/stream-subs/${k}` }),
    cloudWhisper: null,
    torrentSourceOf: () => null,
    ...over,
  };
}

describe('buildSubtitleCheck', () => {
  const worker = {} as WorkerTranscriber;

  it('needs direct streaming, the shared Whisper worker and the torrent settings', () => {
    const config = streamConfig({}, { whisper: WHISPER_ON });
    expect(buildSubtitleCheck({ config }, wiring({ directStream: null, sharedWhisper: worker }), null, () => null)).toBeNull();
    expect(buildSubtitleCheck({ config }, wiring({ directStream: service(), sharedWhisper: null }), null, () => null)).toBeNull();
    expect(buildSubtitleCheck({ config: streamConfig() }, wiring({ directStream: service(), sharedWhisper: worker }), null, () => null)).toBeNull();
    expect(buildSubtitleCheck({ config }, wiring({ directStream: service(), sharedWhisper: worker }), null, () => null)).toBeInstanceOf(SubtitleCheckService);
  });
});

describe('wireStreamExtras', () => {
  it('with the Stream side off: every extra off or disabled, and the Whisper parts carried onto deps', () => {
    const d = deps();
    const w = wiring();
    wireStreamExtras(d, w, null, () => null);
    expect(d.cacheShelf).toBeNull();
    expect(d.streamPreviews).toBeNull();
    expect(d.streamDownloads).toBeNull();
    expect(d.streamCanary).toBeInstanceOf(DisabledCanary);
    expect(d.trending?.enabled).toBe(false);
    expect(d.trackerLists).toBe(w.trackerLists.job);
    expect(d.torrentWhisper).toBeNull();
    expect(d.cloudWhisper).toBeNull();
    expect(d.titleCues).toBe(w.titleCues);
    expect(d.audioDetector).toBeNull();
    expect(d.torrentSync).toBeNull();
    expect(d.titleSubtitles).toBe(w.titleSubtitles);
    expect(d.subtitleCheck).toBeNull();
    expect(d.streamReporter).toBeNull();
  });

  it('sets the extras in the order the daemon always did', () => {
    const d = deps();
    const set: string[] = [];
    const watched = new Proxy(d, {
      set(target, key, value) {
        set.push(String(key));
        return Reflect.set(target, key, value);
      },
    });
    wireStreamExtras(watched, wiring(), null, () => null);
    expect(set).toEqual(['cacheShelf', 'streamPreviews', 'streamDownloads', 'streamCanary', 'trending', 'trackerLists', 'torrentWhisper', 'cloudWhisper', 'titleCues', 'audioDetector', 'torrentSync', 'titleSubtitles', 'subtitleCheck', 'streamReporter']);
  });

  it('the canary it sets waits while the deps say something plays', () => {
    const svc = service(1);
    const d = deps({ config: streamConfig({ canary: true }), directStream: svc });
    wireStreamExtras(d, wiring({ directStream: svc }), null as MovieStreams | null, () => null);
    expect(d.streamCanary).toBeInstanceOf(StreamCanary);
    expect((d.streamCanary as unknown as { o: { busy: () => boolean } }).o.busy()).toBe(true);
  });
});
