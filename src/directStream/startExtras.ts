import { join } from 'node:path';
import { REPO_ROOT, type Config } from '../config.js';
import type { AppDeps } from '../deps.js';
import { titleWatchViews } from '../movies/read.js';
import type { MovieStreams } from '../movies/streams.js';
import { defaultClaudeWindowDeps } from '../sessions/resume.js';
import { CACHE_PENDING_FILE, CacheShelf, liveSlots } from './cacheShelf.js';
import { DisabledCanary, StreamCanary, type CanaryHandle } from './canary.js';
import { buildStreamDownloads } from './downloads/service.js';
import { withHlsSegments } from './hlsCut.js';
import { buildStreamPreviews } from './previews/service.js';
import { StreamReporter } from './report.js';
import type { DirectStreamWiring } from './start.js';
import { SubtitleChecker, WINDOW_CUT_TIMEOUT_MS } from './subtitleCheck/checker.js';
import { CheckSubjects, SubtitleCheckService } from './subtitleCheck/subjects.js';
import { SubtitleShelf } from './torrent/subtitles/disk.js';
import { ffmpegCutter, sharedTranscriber } from './torrent/subtitles/whisper.js';
import { buildTrending } from './trending/job.js';
import { loadKnownTitles } from './updateSource.js';

/** True while a VLC play, a stream on screen or a stream being started exists: the canary and the import's restart wait. */
export function playingNow(deps: Pick<AppDeps, 'moviesPlayer' | 'streamLive' | 'directStream'>): boolean {
  return deps.moviesPlayer?.current() != null || deps.streamLive?.current() != null || (deps.directStream?.starting(null).length ?? 0) > 0;
}

/**
 * The daily stream canary: each cloud provider asked for one known film, for its health only; nothing while a play
 * exists. A DisabledCanary with NOTESD_STREAM_CANARY off or direct streaming off.
 */
export function buildCanary(config: Pick<Config, 'directStream'>, directStream: AppDeps['directStream'], busy: () => boolean): CanaryHandle {
  if (config.directStream?.canary !== true) return new DisabledCanary('setting_off');
  const service = directStream ?? null;
  if (service === null) return new DisabledCanary('direct_stream_off');
  return new StreamCanary({
    providers: async () => (await service.providers()).map((p) => ({ name: p.name, idKind: p.id_kind, browserOnly: p.browser_only })),
    knownTitles: () => loadKnownTitles(),
    resolve: (ref, options) => service.runResolve(ref, options),
    busy,
  });
}

/**
 * The Cache page (src/directStream/cacheShelf.ts): this host's torrents and cloud caches on disk, deleted after an undo
 * window, and what downloads now and why. Null with neither torrents nor the stream cache, or without the library.
 * The download queue is read from `deps` at each listing: it is built after the shelf.
 */
export function buildCacheShelf(deps: AppDeps): CacheShelf | null {
  const { config, db } = deps;
  const movies = deps.movies;
  const torrents = deps.torrents ?? null;
  const streamCache = deps.streamCache ?? null;
  if ((torrents === null && streamCache === null) || movies === null) return null;
  return new CacheShelf({
    host: movies.host,
    torrents,
    caches: streamCache,
    // The download queue's unfinished rows (StreamDownloads.list(): this host's only), as `asked` downloads.
    downloads: {
      list: async () => {
        const queue = deps.streamDownloads ?? null;
        if (queue === null) return [];
        return (await queue.list()).flatMap((d) =>
          d.state === 'queued' || d.state === 'running' || d.state === 'paused'
            ? [{ kind: d.kind, tmdbId: d.tmdb_id, season: d.season ?? 0, episode: d.episode ?? 0, state: d.state, progress: d.progress }]
            : [],
        );
      },
    },
    ahead: () => deps.directStream?.aheadFetching() ?? null,
    titles: (ids) => titleWatchViews(db, ids, { host: movies.host, imageBase: config.movies.tmdb.imageBase }),
    live: () => liveSlots(deps.streamLive ?? null, deps.directStream ?? null),
    pendingFile: join(config.dataDir, 'movies', CACHE_PENDING_FILE),
  });
}

/**
 * /sync-subtitle: a stream's subtitle judged against the film's own audio (subtitleCheck/), heard through the shared
 * Whisper worker. Null without direct streaming, with Whisper off, or before install.sh has made Whisper's Python.
 */
export function buildSubtitleCheck(
  deps: Pick<AppDeps, 'config'>,
  stream: DirectStreamWiring,
  movieStreams: MovieStreams | null,
  boundPort: () => number | null,
): SubtitleCheckService | null {
  const { config } = deps;
  const { directStream, torrents, sharedWhisper, subtitleSync, wyzie, streamLive } = stream;
  if (directStream === null || sharedWhisper === null || config.torrent === undefined) return null;
  const ffmpegBin = config.torrent.ffmpegBin;
  return new SubtitleCheckService(
    new CheckSubjects({
      directStream,
      torrents,
      torrentShelf: torrents === null ? null : new SubtitleShelf(config.torrent.dir),
      titleShelf: stream.titleSubtitles,
      services: { baseUrl: config.torrent.subtitleUrl, wyzie, fetch: (url, init) => fetch(url, init) },
      localBase: () => `http://127.0.0.1:${boundPort() ?? config.port}`,
      onScreen: () => {
        const on = streamLive?.current() ?? null;
        return on === null ? null : { sessionId: on.session_id, durationS: on.duration, positionS: on.position };
      },
      imdbId: async (ref) => (movieStreams === null ? null : movieStreams.imdbId(ref)),
      audioLang: async (ref) => (movieStreams === null ? null : movieStreams.originalLanguage(ref)),
      titleLabel: async (ref) => (movieStreams === null ? null : movieStreams.titleLabel(ref)),
      cancelSync: (key) => subtitleSync?.cancel(key),
    }),
    new SubtitleChecker({
      cutter: withHlsSegments(ffmpegCutter({ ffmpegBin, timeoutMs: WINDOW_CUT_TIMEOUT_MS }), { ffmpegBin, timeoutMs: WINDOW_CUT_TIMEOUT_MS }),
      transcriber: sharedTranscriber(sharedWhisper),
      workDir: join(config.dataDir, 'movies', 'subtitle-check'),
    }),
  );
}

/**
 * The player's report button (stream-cache-and-bug-report phase 4): the evidence snapshot, then a tmux window running
 * claude on /report-stream-bug in this checkout. Nothing runs until a click. Null without direct streaming or the evidence log.
 */
export function buildStreamReporter(deps: Pick<AppDeps, 'config' | 'directStream' | 'streamEvidence'>): StreamReporter | null {
  const reportStream = deps.directStream ?? null;
  const reportEvidence = deps.streamEvidence ?? null;
  if (reportStream === null || reportEvidence === null) return null;
  return new StreamReporter({
    evidence: reportEvidence,
    // Phase 1's evidenceSource peeks without marking the session used.
    isLive: (id) => reportStream.evidenceSource(id) !== null,
    reportsDir: reportEvidence.reportsDir,
    cwd: REPO_ROOT,
    window: () => defaultClaudeWindowDeps({ claudeBin: deps.config.chat.claudeBin }),
  });
}

/**
 * The Stream side's parts that read AppDeps, set onto `deps` in the order the daemon always set them: the Cache page,
 * seek previews, the downloads the owner asks for, the canary, the trending list, the tracker lists' job, the Whisper
 * parts startBackground's stop closes, /sync-subtitle and the report button.
 */
export function wireStreamExtras(deps: AppDeps, stream: DirectStreamWiring, movieStreams: MovieStreams | null, boundPort: () => number | null): void {
  const { config, db } = deps;
  const { directStream, streamCache, torrents, warp } = stream;
  deps.cacheShelf = buildCacheShelf(deps);
  // Seek previews (src/directStream/previews/): sheets made by one niced ffmpeg from what is on this machine, the
  // session on screen first. Null with NOTESD_STREAM_PREVIEWS=off or without direct streaming.
  deps.streamPreviews = buildStreamPreviews(config, { directStream, streamCache, torrents });
  // Downloads the owner asks for (src/directStream/downloads/): one at a time, a 1080p torrent first, then the cloud
  // cache, kept until deleted on the Cache page. On the office network it holds WARP through the stream service's
  // WarpHolds. A finished download's seek previews are queued at once. Null with NOTESD_STREAM_DOWNLOADS=off or neither source.
  deps.streamDownloads = buildStreamDownloads(config, {
    db,
    directStream,
    torrentSource: stream.torrentSourceOf,
    torrents,
    streamCache,
    warp,
    afterDone: () => void deps.streamPreviews?.sweep(),
    movieStreams,
  });
  deps.streamCanary = buildCanary(config, deps.directStream, () => playingNow(deps));
  // The daily trending list of the Stream side: a DisabledTrending unless NOTESD_TRENDING is on.
  deps.trending = buildTrending({ config, db, movies: deps.movies, torrents: deps.torrents ?? null });
  // Started and closed by startBackground; never in a play's path.
  deps.trackerLists = stream.trackerLists.job;
  // Closed (or ended) by startBackground's stop.
  deps.torrentWhisper = stream.whisperTier;
  deps.cloudWhisper = stream.cloudWhisper;
  deps.titleCues = stream.titleCues;
  deps.audioDetector = stream.sharedWhisper;
  deps.torrentSync = stream.subtitleSync;
  deps.titleSubtitles = stream.titleSubtitles;
  deps.subtitleCheck = buildSubtitleCheck(deps, stream, movieStreams, boundPort);
  deps.streamReporter = buildStreamReporter(deps);
}
