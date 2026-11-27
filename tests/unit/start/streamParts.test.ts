import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TORRENT_CONFIG, DEFAULT_TORRENT_WHISPER_SCRIPT } from '../../../src/config.js';
import { AudioLangCheck } from '../../../src/directStream/audioLang.js';
import type { CloudWhisper } from '../../../src/directStream/cloudWhisper.js';
import { OutsideSubtitles } from '../../../src/directStream/outsideSubtitles.js';
import { PictureCheck, type PictureJudge } from '../../../src/directStream/picture.js';
import { buildStreamChecks, buildTorrentHearer } from '../../../src/directStream/startChecks.js';
import { buildStreamSubtitles, wyzieAccess } from '../../../src/directStream/startSubtitles.js';
import { buildTorrentSubtitles, loopbackBase, torrentSourceFactory, type TorrentSourceWiring } from '../../../src/directStream/startTorrents.js';
import { TITLE_SUBS_SUBDIR } from '../../../src/directStream/titleSubtitles.js';
import type { TorrentMarksRepo } from '../../../src/directStream/torrent/marks.js';
import type { TorrentStreams } from '../../../src/directStream/torrent/service.js';
import type { TorrentSource } from '../../../src/directStream/torrent/source.js';
import { EmbeddedSubtitles } from '../../../src/directStream/torrent/subtitles/embedded.js';
import { CueFeeds } from '../../../src/directStream/torrent/subtitles/feed.js';
import type { BuildWhisperTierOptions, WhisperTier, WorkerTranscriber, WorkerTranscriberOptions } from '../../../src/directStream/torrent/subtitles/whisper.js';
import type { MovieStreams } from '../../../src/movies/streams.js';
import { WHISPER_ON, startConfig, streamConfig } from '../../helpers/startConfig.js';

const judge: PictureJudge = { model: 'haiku', judge: async () => ({}) as never };
const worker = { stop: vi.fn() } as unknown as WorkerTranscriber;

function checksIo(canRun: boolean) {
  const lines: string[] = [];
  const workerOptions: WorkerTranscriberOptions[] = [];
  return {
    lines,
    workerOptions,
    io: {
      judge: vi.fn(() => judge),
      canRun: vi.fn(async () => canRun),
      worker: (o: WorkerTranscriberOptions) => {
        workerOptions.push(o);
        return worker;
      },
      log: (l: string) => lines.push(l),
    },
  };
}

describe('buildStreamChecks', () => {
  it('builds no check and no worker with direct streaming off, the library off, or Whisper off', async () => {
    for (const [config, moviesOn] of [
      [startConfig(), true],
      [streamConfig({ pictureModel: 'haiku' }), false],
    ] as const) {
      const t = checksIo(true);
      expect(await buildStreamChecks(config, moviesOn, t.io)).toEqual({ picture: null, sharedWhisper: null, audioCheck: null });
      expect(t.io.judge).not.toHaveBeenCalled();
    }
  });

  it('the picture check needs a picture model and a claude binary', async () => {
    const t = checksIo(true);
    expect((await buildStreamChecks(streamConfig({ pictureModel: null }), true, t.io)).picture).toBeNull();
    const none = checksIo(true);
    none.io.judge.mockReturnValue(null as unknown as PictureJudge);
    expect((await buildStreamChecks(streamConfig({ pictureModel: 'haiku' }), true, none.io)).picture).toBeNull();
    const on = checksIo(true);
    const config = streamConfig({ pictureModel: 'haiku' });
    expect((await buildStreamChecks(config, true, on.io)).picture).toBeInstanceOf(PictureCheck);
    expect(on.io.judge).toHaveBeenCalledWith({ claudeBin: config.chat.claudeBin, model: 'haiku', cwd: join(config.dataDir, 'movies-picture') });
  });

  it('one Whisper worker for every hearing, from the installed Python, ended when idle', async () => {
    const t = checksIo(true);
    const checks = await buildStreamChecks(streamConfig({ pictureModel: 'haiku' }, { whisper: WHISPER_ON }), true, t.io);
    expect(checks.sharedWhisper).toBe(worker);
    expect(checks.audioCheck).toBeInstanceOf(AudioLangCheck);
    expect(t.io.canRun).toHaveBeenCalledWith('/fake/python');
    expect(t.workerOptions).toHaveLength(1);
    expect(t.workerOptions[0]).toMatchObject({ python: '/fake/python', script: DEFAULT_TORRENT_WHISPER_SCRIPT, model: 'small', threads: 2, modelsDir: '/fake/whisper/models', hfHome: '/fake/whisper/hf', idleStopMs: 180_000 });
  });

  it('the worker serves the torrent and cloud transcripts even with no picture check, but the audio check needs one', async () => {
    const t = checksIo(true);
    const checks = await buildStreamChecks(streamConfig({ pictureModel: null }, { whisper: WHISPER_ON }), true, t.io);
    expect(checks.sharedWhisper).toBe(worker);
    expect(checks.audioCheck).toBeNull();
  });

  it('NOTESD_STREAM_AUDIO_CHECK=off keeps the worker and drops the audio check', async () => {
    const t = checksIo(true);
    const checks = await buildStreamChecks(streamConfig({ pictureModel: 'haiku', audioCheck: false }, { whisper: WHISPER_ON }), true, t.io);
    expect(checks.sharedWhisper).toBe(worker);
    expect(checks.audioCheck).toBeNull();
  });

  it('before install.sh has made the Python: no worker, and the log says cloud plays are unchanged only when the audio check wanted it', async () => {
    const wanted = checksIo(false);
    expect(await buildStreamChecks(streamConfig({ pictureModel: 'haiku' }, { whisper: WHISPER_ON }), true, wanted.io)).toMatchObject({ sharedWhisper: null, audioCheck: null });
    expect(wanted.lines).toEqual([
      '[notesd] direct stream: no Whisper Python at /fake/python; cloud audio-language check off. No change to cloud plays until scripts/install.sh installs it.',
    ]);
    const quiet = checksIo(false);
    await buildStreamChecks(streamConfig({ pictureModel: null }, { whisper: WHISPER_ON }), true, quiet.io);
    expect(quiet.lines).toEqual([]);
  });
});

describe('buildTorrentHearer', () => {
  it('hears a torrent through the shared worker with direct streaming on and the audio check not off', () => {
    expect(buildTorrentHearer(streamConfig(), worker)).toBeInstanceOf(AudioLangCheck);
    expect(buildTorrentHearer(streamConfig(), null)).toBeNull();
    expect(buildTorrentHearer(streamConfig({ audioCheck: false }), worker)).toBeNull();
    expect(buildTorrentHearer(startConfig(), worker)).toBeNull();
  });
});

describe('wyzieAccess', () => {
  it('needs both the address and the key of the torrent settings', () => {
    expect(wyzieAccess(startConfig())).toBeNull();
    expect(wyzieAccess(streamConfig({}, { wyzieUrl: 'https://w', wyzieKey: null }))).toBeNull();
    expect(wyzieAccess(streamConfig({}, { wyzieUrl: null, wyzieKey: 'k' }))).toBeNull();
    expect(wyzieAccess(streamConfig({}, { wyzieUrl: 'https://w', wyzieKey: 'k' }))).toEqual({ baseUrl: 'https://w', key: 'k' });
  });
});

describe('buildStreamSubtitles', () => {
  const movieStreams = { imdbId: vi.fn(async () => 'tt0137523') } as unknown as MovieStreams;

  function subsIo() {
    const sweeps: { perItem: readonly string[]; flat: readonly string[] }[] = [];
    const cloudOptions: unknown[] = [];
    const cloud = { close: vi.fn() } as unknown as CloudWhisper;
    return {
      sweeps,
      cloudOptions,
      cloud,
      io: {
        sweep: async (roots: { perItem: readonly string[]; flat: readonly string[] }) => {
          sweeps.push(roots);
          return 0;
        },
        cloudWhisper: async (o: unknown) => {
          cloudOptions.push(o);
          return cloud;
        },
        log: () => {},
      },
    };
  }

  it('without the library or the torrent settings: the shelf and its feeds, no transcript and no outside subtitles', async () => {
    const t = subsIo();
    const config = startConfig();
    const subs = await buildStreamSubtitles(config, null, null, t.io);
    expect(subs.titleSubtitles.dir('movie-550')).toBe(join(config.dataDir, TITLE_SUBS_SUBDIR, 'movie-550'));
    expect(subs.titleCues).toBeInstanceOf(CueFeeds);
    expect(subs).toMatchObject({ wyzie: null, subtitleSync: null, cloudWhisper: null, outsideSubtitles: null });
    expect(t.cloudOptions).toEqual([]);
    // The leftovers of a stretch in progress are swept whatever is on.
    expect(t.sweeps).toEqual([{ perItem: [join(config.dataDir, TITLE_SUBS_SUBDIR)], flat: [join(config.dataDir, 'movies', 'subtitle-check')] }]);
  });

  it('with the library and the torrent settings: the cloud transcript on the shared worker, and the outside subtitles', async () => {
    const t = subsIo();
    const config = streamConfig({}, { dir: '/t', whisper: WHISPER_ON });
    const subs = await buildStreamSubtitles(config, movieStreams, worker, t.io);
    expect(subs.cloudWhisper).toBe(t.cloud);
    expect(subs.outsideSubtitles).toBeInstanceOf(OutsideSubtitles);
    expect(t.cloudOptions[0]).toMatchObject({ whisper: WHISPER_ON, shelf: subs.titleSubtitles, feeds: subs.titleCues, ffmpegBin: DEFAULT_TORRENT_CONFIG.ffmpegBin });
    expect(t.cloudOptions[0]).toHaveProperty('transcriber');
    expect(t.sweeps[0]!.perItem).toEqual([join(config.dataDir, TITLE_SUBS_SUBDIR), '/t']);
  });

  it('a cloud transcript of its own when there is no shared worker', async () => {
    const t = subsIo();
    await buildStreamSubtitles(streamConfig({}, {}), movieStreams, null, t.io);
    expect(t.cloudOptions[0]).not.toHaveProperty('transcriber');
  });
});

describe('loopbackBase', () => {
  it('is the bound port once the daemon listens, the configured one before', () => {
    let port: number | null = null;
    expect(loopbackBase(() => port, 7317)).toBe('http://127.0.0.1:7317');
    port = 41000;
    expect(loopbackBase(() => port, 7317)).toBe('http://127.0.0.1:41000');
  });
});

describe('torrentSourceFactory', () => {
  const source = {} as TorrentSource;
  const torrents = {} as TorrentStreams;

  function wiring(over: Partial<TorrentSourceWiring> & { torrentsNow?: () => TorrentStreams | null } = {}) {
    const build = vi.fn((..._args: Parameters<NonNullable<TorrentSourceWiring['build']>>) => source);
    const late = vi.fn(() => ({ torrents: over.torrentsNow === undefined ? torrents : over.torrentsNow(), directStream: null, embedded: null, whisper: null, lists: null }));
    const w: TorrentSourceWiring = {
      config: streamConfig({}, { enabled: true, dir: '/t' }),
      boundPort: () => 41000,
      late,
      wyzie: null,
      fallback: [],
      remux: null,
      marks: {} as TorrentMarksRepo,
      hear: null,
      sync: null,
      build: build as unknown as TorrentSourceWiring['build'],
      ...over,
    };
    return { w, build, late };
  }

  it('builds nothing at boot: the late parts are read at the first ask', () => {
    const t = wiring();
    torrentSourceFactory(t.w);
    expect(t.late).not.toHaveBeenCalled();
    expect(t.build).not.toHaveBeenCalled();
  });

  it('builds the source once, on the first ask, from the torrents and the wiring', () => {
    const t = wiring();
    const of = torrentSourceFactory(t.w);
    expect(of()).toBe(source);
    expect(of()).toBe(source);
    expect(t.build).toHaveBeenCalledTimes(1);
    const [config, swarm, w] = t.build.mock.calls[0]!;
    expect(config).toBe(t.w.config);
    expect(swarm).toBe(torrents);
    expect(w.localBase()).toBe('http://127.0.0.1:41000');
    expect(w.marks).toBe(t.w.marks);
    expect(w.sync).toBeNull();
    expect(w.tiers!.length).toBeGreaterThan(0);
  });

  it('answers null while there are no torrents, and builds once they exist', () => {
    let now: TorrentStreams | null = null;
    const t = wiring({ torrentsNow: () => now });
    const of = torrentSourceFactory(t.w);
    expect(of()).toBeNull();
    now = torrents;
    expect(of()).toBe(source);
  });

  it('answers null with NOTESD_TORRENT=off', () => {
    const t = wiring({ config: streamConfig({}, { enabled: false }) });
    expect(torrentSourceFactory(t.w)()).toBeNull();
    expect(t.build).not.toHaveBeenCalled();
  });

  it('a session synced by Wyzie is keyed by the torrent and its file', () => {
    const start = vi.fn();
    const t = wiring({ sync: { start } as unknown as TorrentSourceWiring['sync'] });
    torrentSourceFactory(t.w)();
    const w = t.build.mock.calls[0]![2];
    const hash = 'a'.repeat(40);
    w.sync!.start({ infoHash: hash, fileIndex: 2, lang: 'en' } as never);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ key: `${hash}-2`, lang: 'en', place: expect.any(Object) }));
  });
});

describe('buildTorrentSubtitles', () => {
  const tier = { id: 'whisper' } as unknown as WhisperTier;
  function fakeTorrents(remuxOnly: boolean, onDisk: string | null) {
    return {
      filePath: vi.fn(async () => onDisk),
      remuxOnly: vi.fn(async () => remuxOnly),
      localUrl: (h: string, i: number) => `/api/stream/torrent/${h}/file/${i}`,
    } as unknown as TorrentStreams;
  }

  it('builds nothing with torrents off', async () => {
    const whisperTier = vi.fn();
    expect(await buildTorrentSubtitles(streamConfig({}, { dir: '/t' }), null, () => null, null, { whisperTier })).toEqual({ torrentCues: null, embeddedSubtitles: null, whisperTier: null });
    expect(whisperTier).not.toHaveBeenCalled();
  });

  it('builds the feeds, the extraction and the Whisper tier, reading through this daemon on loopback', async () => {
    let options: BuildWhisperTierOptions | null = null;
    const config = streamConfig({}, { enabled: true, dir: '/t', whisper: WHISPER_ON });
    const subs = await buildTorrentSubtitles(config, fakeTorrents(false, null), () => 41000, worker, {
      whisperTier: async (o) => {
        options = o;
        return tier;
      },
    });
    expect(subs.torrentCues).toBeInstanceOf(CueFeeds);
    expect(subs.embeddedSubtitles).toBeInstanceOf(EmbeddedSubtitles);
    expect(subs.whisperTier).toBe(tier);
    expect(options!).toMatchObject({ whisper: WHISPER_ON, torrentDir: '/t' });
    expect(options!).toHaveProperty('transcriber');
    expect(await options!.fileUrl('abc', 1)).toBe('http://127.0.0.1:41000/api/stream/torrent/abc/file/1');
  });

  it('a film that lives as its remux is heard from the remux segments', async () => {
    let options: BuildWhisperTierOptions | null = null;
    await buildTorrentSubtitles(streamConfig({}, { enabled: true, dir: '/t' }), fakeTorrents(true, null), () => 41000, null, {
      whisperTier: async (o) => {
        options = o;
        return null;
      },
    });
    expect(options!).not.toHaveProperty('transcriber');
    const input = (await options!.fileUrl('abc', 1)) as { url: string; hls: { manifest_kind: string } };
    expect(input.url.startsWith('http://127.0.0.1:41000/api/stream/torrent/abc/hls/1/')).toBe(true);
    expect(input.hls.manifest_kind).toBe('hls');
  });
});

