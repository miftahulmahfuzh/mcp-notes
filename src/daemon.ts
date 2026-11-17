import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { createAdversaryService, type AdversaryService } from './adversary/service.js';
import { startBackground } from './background.js';
import { createAgentChatBackend, type AgentChatBackend } from './chat/agent.js';
import type { ChatBackend } from './chat/backend.js';
import { CHAT_IMAGES_SUBDIR } from './chat/images.js';
import { ChatService } from './chat/service.js';
import { DEFAULT_FFMPEG_BIN, DEFAULT_TORRENT_SITES_CONFIG, DEFAULT_TORRENT_WHISPER_SCRIPT, REPO_ROOT, type Config } from './config.js';
import { closeDb, createDb } from './db/client.js';
import type { AppDeps } from './deps.js';
import type { Embedder } from './embeddings/embedder.js';
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
import { embedderFromConfig } from './embeddings/openrouter.js';
import { imageEmbedderFromConfig } from './embeddings/openrouterImage.js';
import { createApp } from './http/app.js';
import { NoteEvents } from './notes/events.js';
import { NotesService } from './notes/service.js';
import { buildMoviePlayback, type MoviePlayer } from './movies/player.js';
import { windowsForegrounder } from './movies/vlc/foreground.js';
import { buildVlcFinder, buildVlcHealth, type HealthMonitor } from './movies/vlc/health.js';
import { MOVIES_SUBDIR, buildMoviesService } from './movies/service.js';
import { MovieStreams } from './movies/streams.js';
import { StreamLive } from './movies/streamLive.js';
import { createAnimeMapper } from './directStream/anime.js';
import { PICTURE_VERDICTS_FILE, PictureCheck, PictureVerdicts, createPictureJudge, ffmpegFrameGrabber, firstFrameOf, hlsSegmentFrameGrabber, hlsStreamReach } from './directStream/picture.js';
import { loadDialogue } from './directStream/dialogueStore.js';
import { createStoryWriter, MovieStories } from './movies/story.js';
import { buildDirectStreamService } from './directStream/service.js';
import { torrentSiteIndexes, torrentSitesScriptRunner } from './directStream/torrent/find-sites.js';
import { buildTorrentRemux } from './directStream/torrent/remux.js';
import { buildTorrentSource, type TorrentSource } from './directStream/torrent/source.js';
import { buildSubtitleTiers } from './directStream/torrent/subtitles/chain.js';
import { EmbeddedSubtitles } from './directStream/torrent/subtitles/embedded.js';
import { CueFeeds, cueFeedUrl, whisperTrackId } from './directStream/torrent/subtitles/feed.js';
import { ffmpegAssConverter } from './directStream/torrent/subtitles/files.js';
import { OutsideSubtitles } from './directStream/outsideSubtitles.js';
import { TITLE_SUBS_SUBDIR, TitleSubtitleShelf } from './directStream/titleSubtitles.js';
import { SubtitleShelf } from './directStream/torrent/subtitles/disk.js';
import { buildSubtitleSync, torrentSyncPlace } from './directStream/torrent/subtitles/synced.js';
import { buildWhisperTier, WorkerTranscriber } from './directStream/torrent/subtitles/whisper.js';
import { AUDIO_VERDICTS_FILE, AudioLangCheck, AudioVerdicts, ffmpegAudioGrabber } from './directStream/audioLang.js';
import { buildStreamCache } from './directStream/cache/service.js';
import { DirectStreamRepo } from './directStream/repo.js';
import { buildTorrentStreams } from './directStream/torrent/service.js';
import { StreamEvidence } from './directStream/evidence.js';
import { buildStreamProber } from './directStream/prober.js';
import { StreamReporter } from './directStream/report.js';
import { defaultClaudeWindowDeps } from './sessions/resume.js';
import { scriptRunner } from './streaming/service.js';
import { SUMMARIES_SUBDIR, createAgentSummarizer, type Summarizer } from './sessions/summarize.js';
import { SessionEvents } from './sessions/events.js';

/** `<dataDir>/chat`: the fixed cwd of every chat brain run. Sessions are not persisted there (persistSession: false). */
export const CHAT_SUBDIR = 'chat';

export const DATA_SUBDIRS = ['images', 'cache', 'inbox', join('inbox', 'failed'), CHAT_SUBDIR, CHAT_IMAGES_SUBDIR, 'files'] as const;

export interface RunningDaemon {
  deps: AppDeps;
  /** The bound port (useful when config.port is 0). */
  port: number;
  stop: () => Promise<void>;
}

export interface StartDaemonOptions {
  /** The brain behind POST /api/chat. Omitted: the Agent SDK backend built from config.chat (tests inject the stub or a scripted fake). */
  chat?: ChatBackend;
  /**
   * The embedder for the worker, hybrid search and `related`. Omitted: built from
   * config.embeddings (null without OPENROUTER_API_KEY). Tests inject the fake embedder, or null
   * to keep the daemon off the network.
   */
  embedder?: Embedder | null;
  /**
   * The image embedder for the image worker and `similar_images`. Omitted: built from
   * config.embeddings (same key; null without it). Tests inject the fake, or null.
   */
  imageEmbedder?: ImageEmbedder | null;
}

export async function ensureDataDirs(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  for (const sub of DATA_SUBDIRS) await mkdir(join(dataDir, sub), { recursive: true });
}

function listen(server: ServerType): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

/** config -> data dirs -> embedder -> db -> service -> chat -> app -> listen on loopback -> background jobs. */
export async function startDaemon(config: Config, options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  if (config.host !== '127.0.0.1') {
    throw new Error(`notesd binds 127.0.0.1 only (got host ${config.host}).`);
  }
  await ensureDataDirs(config.dataDir);
  // Before createDb: a blank key throws EmbeddingError here, with no pool to leak.
  const embedder = options.embedder !== undefined ? options.embedder : embedderFromConfig(config.embeddings);
  const imageEmbedder =
    options.imageEmbedder !== undefined ? options.imageEmbedder : imageEmbedderFromConfig(config.embeddings);
  const db = createDb(config.databaseUrl);
  const events = new NoteEvents();
  const sessionEvents = new SessionEvents();
  const service = new NotesService({ db, dataDir: config.dataDir, events, embedder });
  const chatHistory = new ChatService({ db });
  let adversary: AdversaryService | null = null;
  if (config.adversary.enabled) {
    adversary = createAdversaryService({
      config: config.adversary,
      db,
      claudeBin: config.chat.claudeBin,
      dataDir: config.dataDir,
      host: hostname(),
    });
    if (adversary === null) {
      console.log(`[notesd] adversary off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`);
    }
  }
  // Movies library (phase 3): null with NOTESD_MOVIES=off; started and closed by startBackground.
  const movies = buildMoviesService(config, db);
  // Movies phase 9: the VLC health log. Built before the player, whose hang rule asks it whether a
  // silent VLC still exists; it reads the followed play back through the player. Started after listen.
  let moviesPlayer: MoviePlayer | null = null;
  const moviesHealth: HealthMonitor | null =
    movies === null
      ? null
      : buildVlcHealth({ config: config.movies, dataDir: config.dataDir, host: movies.host, tracked: () => moviesPlayer?.healthView() ?? null });
  // Movies phase 5: VLC playback and the [RecentsMRL] hook hang off the movies service.
  const findVlcs = movies === null ? null : buildVlcFinder(config.movies);
  moviesPlayer =
    movies === null
      ? null
      : buildMoviePlayback(movies, config.movies, {
          foreground: windowsForegrounder(),
          ...(moviesHealth === null ? {} : { health: moviesHealth }),
          ...(findVlcs === null ? {} : { findVlcs }),
        });
  if (moviesPlayer !== null) {
    try {
      const closed = await moviesPlayer.start();
      if (closed > 0) console.log(`[notesd] movies: closed ${closed} play(s) left open by the previous run at their last position`);
    } catch (err) {
      console.error(`[notesd] movies: could not close stale plays: ${err instanceof Error ? err.message : String(err)}`);
    }
    const playback = await moviesPlayer.availability();
    console.log(
      playback.available
        ? `[notesd] movies: playback via ${config.movies.vlc.bin} on ports ${config.movies.vlc.httpPort}+`
        : `[notesd] movies: playback off (${playback.reason})`,
    );
  }
  // Direct streaming phase 5: stream plays and verified sources are written to the movies store.
  // Player sessions live in memory, so a stream play the previous run left open is closed here.
  const movieStreams = movies === null ? null : new MovieStreams(movies);
  if (movieStreams !== null) {
    try {
      const closed = await movieStreams.closeLeftOpen();
      if (closed > 0) console.log(`[notesd] direct stream: closed ${closed} stream play(s) left open by the previous run at their last position`);
    } catch (err) {
      console.error(`[notesd] direct stream: could not close stale stream plays: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Builds nothing and runs nothing until a streaming tool is called.
  const streaming = config.streaming?.enabled ? scriptRunner() : null;
  // The bound port, known only after listen() (config.port may be 0). The chat agent reaches notes
  // through this daemon's own /mcp, and a direct-stream play opens this daemon's player page.
  let boundPort: number | null = null;
  // Direct streaming: null with NOTESD_DIRECT_STREAM=off or NOTESD_MOVIES=off. The provider seed is
  // loaded into the shared registry here; the resolver and Chrome run only when a play or a tool asks.
  // null with NOTESD_ANIME_MAP_URL=off: no lookup is made and an anime resolves like any series.
  const animeMapper = createAnimeMapper({ baseUrl: config.directStream?.animeMapUrl ?? null });
  // The stream on screen in the player page: built here so the evidence log can ask for it.
  const streamLive = movies === null ? null : new StreamLive();
  // Stream bug reporting phase 1: this machine's stream evidence log. The service records every
  // pass-through answer and session change into it; a snapshot reads the live session back through
  // the service (a closure: the service is built next) and the stream on screen through streamLive.
  const streamEvidence =
    movies === null || config.directStream?.enabled !== true
      ? null
      : new StreamEvidence({
          dir: join(config.dataDir, MOVIES_SUBDIR),
          host: movies.host,
          source: (id) => directStream?.evidenceSource(id) ?? null,
          onScreen: () => streamLive?.current()?.session_id ?? null,
        });
  // Looks at a stream's picture before its first play of a title (a cinema recording, a burned-in
  // advert): two frames through ffmpeg and one model call, kept per title and provider. Null with
  // NOTESD_STREAM_PICTURE_MODEL=off, without direct streaming, or without a claude binary.
  const pictureModel = movies === null || config.directStream?.enabled !== true ? null : (config.directStream.pictureModel ?? null);
  const pictureJudge = pictureModel === null ? null : createPictureJudge({ claudeBin: config.chat.claudeBin, model: pictureModel, cwd: join(config.dataDir, 'movies-picture') });
  const picture =
    pictureJudge === null
      ? null
      : new PictureCheck({
          verdicts: new PictureVerdicts(join(config.dataDir, MOVIES_SUBDIR, PICTURE_VERDICTS_FILE)),
          // ffmpeg on the manifest; for an HLS stream it cannot open (segments wrapped in a picture file), the segment itself.
          grab: firstFrameOf(
            ffmpegFrameGrabber({ ffmpegBin: config.directStream?.ffmpegBin ?? DEFAULT_FFMPEG_BIN }),
            hlsSegmentFrameGrabber({ ffmpegBin: config.directStream?.ffmpegBin ?? DEFAULT_FFMPEG_BIN }),
          ),
          // No frame: a stream whose host still hands out a segment plays; only one it does not is passed over.
          reach: hlsStreamReach(),
          judge: pictureJudge,
        });
  // Hears a cloud stream's audio before its first play of a foreign-language title: ~30 s through
  // Whisper tells a dub from the original (audioLang.ts). It reuses the Whisper worker; a dedicated
  // one, since the subtitle tier's is built later (below) and may be off while this is on. Null with
  // NOTESD_STREAM_AUDIO_CHECK=off, without the picture check, without direct streaming, or before
  // install.sh has made Whisper's Python (the log then says cloud plays are unchanged).
  const whisperCfg = config.torrent?.whisper;
  const audioCheckOn = movies !== null && config.directStream?.enabled === true && config.directStream.audioCheck !== false && picture !== null;
  let audioDetector: WorkerTranscriber | null = null;
  if (audioCheckOn && whisperCfg?.enabled === true) {
    try {
      await access(whisperCfg.python, fsConstants.X_OK);
      audioDetector = new WorkerTranscriber({
        python: whisperCfg.python,
        script: DEFAULT_TORRENT_WHISPER_SCRIPT,
        model: whisperCfg.model,
        threads: whisperCfg.threads,
        modelsDir: join(whisperCfg.dir, 'models'),
        hfHome: join(whisperCfg.dir, 'hf'),
        log: (line) => console.log(line),
      });
    } catch {
      console.log(`[notesd] direct stream: no Whisper Python at ${whisperCfg.python}; cloud audio-language check off. No change to cloud plays until scripts/install.sh installs it.`);
    }
  }
  const audioCheck =
    audioDetector === null
      ? null
      : new AudioLangCheck({
          verdicts: new AudioVerdicts(join(config.dataDir, MOVIES_SUBDIR, AUDIO_VERDICTS_FILE)),
          grab: ffmpegAudioGrabber({ ffmpegBin: config.directStream?.ffmpegBin ?? DEFAULT_FFMPEG_BIN }),
          detector: audioDetector,
        });
  // Torrent phase 3: the torrent source, built on first use from phase 1's TorrentStreams (deps.torrents, null
  // with NOTESD_TORRENT=off). ffprobe reads a torrent's file through this daemon's own route on loopback.
  // 1337x and ext.to through the streaming Chrome (torrent phase 9): asked only when the JSON indexes
  // give nothing usable; NOTESD_TORRENT_<SITE>_ORIGIN=off leaves a site out.
  const torrentSites = config.torrent?.sites ?? DEFAULT_TORRENT_SITES_CONFIG;
  const torrentSiteFallback = torrentSiteIndexes(torrentSites, torrentSitesScriptRunner({ cliPath: torrentSites.cli }));
  // Torrent phase 5: the remux of files Chrome cannot play as is; null with torrents or NOTESD_TORRENT_REMUX off.
  const torrentRemux = buildTorrentRemux(config.torrent);
  // The subtitle services (Wyzie Subs with a key, then the OpenSubtitles add-on) and Wyzie Synced, for every stream
  // session: a torrent's `service` tier, and a cloud session whose stream has no English subtitle. Their settings
  // are the torrent ones, read whether or not torrents are on. Synced: null with NOTESD_TORRENT_WYZIE_SYNC=off or no key.
  const wyzie =
    config.torrent === undefined || config.torrent.wyzieKey === null || config.torrent.wyzieUrl === null ? null : { baseUrl: config.torrent.wyzieUrl, key: config.torrent.wyzieKey };
  const subtitleSync = buildSubtitleSync({
    sync: config.torrent?.wyzieSync,
    wyzie,
    ffmpegBin: config.torrent?.ffmpegBin ?? DEFAULT_FFMPEG_BIN,
    fetch: (url, init) => fetch(url, init),
    log: (line) => console.log(line),
  });
  const titleSubtitles = new TitleSubtitleShelf(join(config.dataDir, TITLE_SUBS_SUBDIR));
  const outsideSubtitles =
    movieStreams === null || config.torrent === undefined
      ? null
      : new OutsideSubtitles({
          shelf: titleSubtitles,
          services: { baseUrl: config.torrent.subtitleUrl, wyzie, fetch: (url, init) => fetch(url, init), log: (line) => console.log(line) },
          sync: subtitleSync,
          imdbId: (ref) => movieStreams.imdbId(ref),
        });
  let torrentSource: TorrentSource | null = null;
  const torrentSourceOf = (): TorrentSource | null => {
    const torrents = deps.torrents ?? null;
    if (torrentSource === null && torrents !== null && config.torrent?.enabled === true) {
      const place = {
        torrentDir: config.torrent.dir,
        shelf: new SubtitleShelf(config.torrent.dir),
        input: async (infoHash: string, fileIndex: number): Promise<string> =>
          (await torrents.filePath(infoHash, fileIndex)) ?? `http://127.0.0.1:${boundPort ?? config.port}${torrents.localUrl(infoHash, fileIndex)}`,
      };
      torrentSource = buildTorrentSource(config, torrents, {
        localBase: () => `http://127.0.0.1:${boundPort ?? config.port}`,
        tiers: buildSubtitleTiers({
          torrentDir: config.torrent.dir,
          torrents,
          log: (line) => console.log(line),
          subtitleUrl: config.torrent.subtitleUrl,
          wyzie,
          fetch: (url, init) => fetch(url, init),
          // The borrow reads the title's English subtitle from a cloud provider, out of sight.
          lend: () => (directStream === null ? null : (ref, options) => directStream.subtitleText(ref, options)),
          convertAss: ffmpegAssConverter(config.torrent.ffmpegBin),
          embedded: embeddedSubtitles,
          whisper: whisperTier,
        }),
        // Phase 5 adds `remux` and phase 9 `fallback` here (one line each).
        remux: torrentRemux,
        fallback: torrentSiteFallback,
        sync:
          subtitleSync === null
            ? null
            : { start: ({ infoHash, fileIndex, ...rest }) => subtitleSync.start({ ...rest, key: `${infoHash}-${fileIndex}`, place: torrentSyncPlace(place, infoHash, fileIndex) }) },
      });
    }
    return torrentSource;
  };
  const directStream = buildDirectStreamService(config, db, {
    movies,
    picture,
    audioCheck,
    pageBase: () => `http://localhost:${boundPort ?? config.port}`,
    evidence: streamEvidence,
    // Phase 6: a play reads this host's stream cache first. Phase 5 builds it after this service, so
    // it is read at play time (deps exists by then).
    caches: () => deps.streamCache?.player() ?? null,
    torrent: torrentSourceOf,
    outside: () => outsideSubtitles,
    hooks:
      movieStreams === null
        ? undefined
        : {
            recordResolve: (ref, result) => movieStreams.recordResolve(ref, result),
            resumeS: (ref) => movieStreams.resumeS(ref),
            originalLanguage: (ref) => movieStreams.originalLanguage(ref),
            titleLabel: (ref) => movieStreams.titleLabel(ref),
            anime: (ref) => movieStreams.animeRef(ref, animeMapper),
            neighbors: (ref) => movieStreams.neighbors(ref),
            imdbId: (ref) => movieStreams.imdbId(ref),
            titleNames: (ref) => movieStreams.titleNames(ref),
          },
  });
  if (directStream !== null) {
    try {
      const seeded = await directStream.syncSeed();
      console.log(`[notesd] direct stream: on, ${seeded.total} providers in the seed (${seeded.inserted} new, ${seeded.updated} updated)`);
    } catch (err) {
      console.error(`[notesd] direct stream: could not load the provider seed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Stream cache (stream-cache phase 5): null with direct streaming off. Downloads start only when
  // asked; startBackground carries unfinished ones on.
  const streamCache = buildStreamCache(config, directStream, new DirectStreamRepo(db));
  // Torrents (torrent-stream-source phase 1): null with NOTESD_TORRENT=off or direct streaming off.
  // Building it joins nothing: the WebTorrent engine starts with the first torrent opened.
  const torrents = buildTorrentStreams(config, directStream, db);
  // Phase 7: the growing cue feeds (the subtitle track inside a torrent's file; phase 8's Whisper) and
  // the ffmpeg extraction that fills them. ffmpeg reads the file from disk once it is complete, else
  // through this daemon's own file route, which waits for the pieces as the torrent downloads.
  const torrentDir = config.torrent?.dir ?? null;
  const torrentCues = torrents === null || torrentDir === null ? null : new CueFeeds({ folderOf: (infoHash) => join(torrentDir, infoHash) });
  const embeddedSubtitles =
    torrents === null || torrentCues === null || config.torrent === undefined
      ? null
      : new EmbeddedSubtitles({
          ffmpegBin: config.torrent.ffmpegBin,
          feeds: torrentCues,
          input: async (infoHash, fileIndex) =>
            (await torrents.filePath(infoHash, fileIndex)) ?? `http://127.0.0.1:${boundPort ?? config.port}${torrents.localUrl(infoHash, fileIndex)}`,
        });
  // Torrent phase 8: Whisper, the last subtitle tier. Null with NOTESD_TORRENT_WHISPER=off or before
  // install.sh has made its Python; the chain then ends at phase 6's borrow. The worker starts on the
  // first stretch, never at boot. Its cues go into phase 7's feed `whisper-<file index>` of the torrent.
  const whisperTier =
    torrents === null || torrentCues === null || config.torrent === undefined
      ? null
      : await buildWhisperTier({
          whisper: config.torrent.whisper,
          torrentDir: config.torrent.dir,
          ffmpegBin: config.torrent.ffmpegBin,
          fileUrl: (infoHash, fileIndex) => `http://127.0.0.1:${boundPort ?? config.port}${torrents.localUrl(infoHash, fileIndex)}`,
          openFeed: async (infoHash, fileIndex) => {
            const track = whisperTrackId(fileIndex);
            // A feed a stopped run left carries on (the progress file says which stretches are in it); else a new one.
            const feed = (await torrentCues.get(infoHash, track)) ?? (await torrentCues.start(infoHash, track));
            return { url: cueFeedUrl(infoHash, track), append: (cues) => feed.append(cues), complete: () => feed.complete() };
          },
        });
  // The story of an episode, written from its dialogue when the owner asks (one model call, then kept).
  const movieStories =
    movies === null
      ? null
      : new MovieStories({
          repo: movies.repo,
          dialogue: (target) => loadDialogue(movies.repo, directStream, target),
          writer:
            config.movies.storyModel === null || config.movies.storyModel === undefined
              ? null
              : createStoryWriter({ claudeBin: config.chat.claudeBin, model: config.movies.storyModel, cwd: join(config.dataDir, 'movies-story') }),
        });
  const deps: AppDeps = {
    config,
    db,
    events,
    service,
    embedder,
    imageEmbedder,
    chat: chatHistory,
    adversary,
    movies,
    moviesPlayer,
    moviesHealth,
    sessionEvents,
    streaming,
    directStream,
    streamCache,
    torrents,
    torrentCues,
    torrentRemux,
    movieStories,
    streamLive,
    streamEvidence,
  };
  // Direct streaming phase 10: the background prober. A DisabledProber unless NOTESD_STREAM_PROBER=on;
  // started and closed by startBackground. Built after `deps` so it reads deps.directStream.
  deps.streamProber = await buildStreamProber({ config, db, movies, moviesPlayer, directStream: deps.directStream });
  // Torrent phase 8: closed by startBackground's stop, which ends a running Whisper worker.
  deps.torrentWhisper = whisperTier;
  // The cloud audio-language check's Whisper worker (audioLang.ts): closed by startBackground's stop. Null when the check is off.
  deps.audioDetector = audioDetector;
  // Wyzie Synced and the per-title subtitle shelf: closed by startBackground's stop; read by the `/api/stream/subs` route.
  deps.torrentSync = subtitleSync;
  deps.titleSubtitles = titleSubtitles;
  // The player's report button (stream-cache-and-bug-report phase 4): phase 1's snapshot, then a
  // tmux window running claude on /report-stream-bug in this checkout. Nothing runs until a click.
  const reportStream = deps.directStream ?? null;
  const reportEvidence = deps.streamEvidence ?? null;
  deps.streamReporter =
    reportStream === null || reportEvidence === null
      ? null
      : new StreamReporter({
          evidence: reportEvidence,
          // Phase 1's evidenceSource peeks without marking the session used.
          isLive: (id) => reportStream.evidenceSource(id) !== null,
          reportsDir: reportEvidence.reportsDir,
          cwd: REPO_ROOT,
          window: () => defaultClaudeWindowDeps({ claudeBin: config.chat.claudeBin }),
        });
  let agent: AgentChatBackend | null = null;
  let chat: ChatBackend;
  if (options.chat !== undefined) {
    chat = options.chat;
  } else {
    agent = createAgentChatBackend({
      chat: config.chat,
      cwd: join(config.dataDir, CHAT_SUBDIR),
      mcpUrl: () => {
        if (boundPort === null) throw new Error('notesd is not listening yet.');
        return `http://${config.host}:${boundPort}/mcp`;
      },
    });
    chat = agent;
  }
  const app = createApp(deps, { chat });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    await closeDb(db);
    throw err;
  }
  boundPort = port;
  // Movies phase 9: sampling starts once the daemon serves; the incident of a crashed run is written in the background.
  if (moviesHealth !== null) {
    try {
      await moviesHealth.start();
    } catch (err) {
      console.error(`[notesd] vlc health: could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let sessionSummarizer: Summarizer | null = null;
  if (config.sessions.enabled) {
    sessionSummarizer = createAgentSummarizer({
      claudeBin: config.chat.claudeBin,
      cwd: join(config.dataDir, SUMMARIES_SUBDIR),
    });
    if (sessionSummarizer === null) {
      console.log(`[notesd] session summaries off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`);
    }
  }
  const stopBackground = await startBackground(deps, { sessionSummarizer });

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      agent?.close();
      // Ends the tracked play at its last read position while the DB is still open; VLC stays open.
      await moviesPlayer?.close();
      // After the player (its last hang line), before the DB: writes `clean_stop`.
      await moviesHealth?.close();
      await stopBackground();
      await closeServer(server);
      await streamEvidence?.flushed();
      await closeDb(db);
    })();
    return stopping;
  };
  return { deps, port, stop };
}
