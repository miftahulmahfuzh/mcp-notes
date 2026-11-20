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
import { openLocalDb } from './db/localDb.js';
import { mergeStagedImport, sharedImportState, startSharedImport } from './db/sharedImport.js';
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
import { createGuideWriter, GenreGuides } from './movies/guides.js';
import { createStoryWriter, MovieStories } from './movies/story.js';
import { createWebStoryWriter } from './movies/webStory.js';
import { buildDirectStreamService } from './directStream/service.js';
import { torrentSiteIndexes, torrentSitesScriptRunner } from './directStream/torrent/find-sites.js';
import { buildTorrentRemux, remuxAudioInput } from './directStream/torrent/remux.js';
import { buildTorrentSource, type TorrentSource } from './directStream/torrent/source.js';
import { TorrentMarksRepo } from './directStream/torrent/marks.js';
import { buildTrackerLists } from './directStream/torrent/trackerLists.js';
import { buildSubtitleTiers } from './directStream/torrent/subtitles/chain.js';
import { EmbeddedSubtitles } from './directStream/torrent/subtitles/embedded.js';
import { CueFeeds, cueFeedUrl, whisperTrackId } from './directStream/torrent/subtitles/feed.js';
import { ffmpegAssConverter } from './directStream/torrent/subtitles/files.js';
import { OutsideSubtitles } from './directStream/outsideSubtitles.js';
import { buildCloudWhisper, titleCueFeeds } from './directStream/cloudWhisper.js';
import { TITLE_SUBS_SUBDIR, TitleSubtitleShelf } from './directStream/titleSubtitles.js';
import { sweepAudioLeftovers } from './directStream/leftovers.js';
import { SubtitleChecker, WINDOW_CUT_TIMEOUT_MS } from './directStream/subtitleCheck/checker.js';
import { CheckSubjects, SubtitleCheckService } from './directStream/subtitleCheck/subjects.js';
import { SubtitleShelf } from './directStream/torrent/subtitles/disk.js';
import { withHlsSegments } from './directStream/hlsCut.js';
import { buildSubtitleSync, torrentSyncPlace } from './directStream/torrent/subtitles/synced.js';
import { buildWhisperTier, ffmpegCutter, sharedTranscriber, WHISPER_IDLE_STOP_MS, WorkerTranscriber } from './directStream/torrent/subtitles/whisper.js';
import { AUDIO_VERDICTS_FILE, AudioLangCheck, AudioVerdicts, streamAudioGrabber } from './directStream/audioLang.js';
import { buildStreamCache } from './directStream/cache/service.js';
import { buildStreamPreviews } from './directStream/previews/service.js';
import { buildStreamDownloads } from './directStream/downloads/service.js';
import { DirectStreamRepo } from './directStream/repo.js';
import { buildTorrentStreams } from './directStream/torrent/service.js';
import { CACHE_PENDING_FILE, CacheShelf, liveSlots } from './directStream/cacheShelf.js';
import { titleWatchViews } from './movies/read.js';
import { StreamEvidence } from './directStream/evidence.js';
import { DisabledCanary, StreamCanary } from './directStream/canary.js';
import { loadKnownTitles } from './directStream/updateSource.js';
import { buildTrending } from './directStream/trending/job.js';
import { StreamReporter } from './directStream/report.js';
import { defaultClaudeWindowDeps } from './sessions/resume.js';
import { siteFallback } from './streaming/fallback.js';
import { scriptRunner } from './streaming/service.js';
import { scriptWarp } from './streaming/warp.js';
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
  /**
   * Called when the daemon needs a fresh start and nothing is playing: the old shared database is
   * staged and its merge runs at start. src/main.ts stops the daemon and exits, and systemd starts
   * it again. Omitted (tests): the stage waits for whoever starts the daemon next.
   */
  onRestartWanted?: () => void;
}

/** How often a daemon that wants a restart looks whether something still plays. */
export const IMPORT_RESTART_CHECK_MS = 60_000;

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
  // This machine's own database is waited for and migrated here; any other is its caller's to prepare.
  const db = config.localDatabase === true ? await openLocalDb(config.databaseUrl) : createDb(config.databaseUrl);
  // The old shared database is copied in once (src/db/sharedImport.ts). A stage that is complete is
  // merged now, before anything else uses the database; until then the copy is pending.
  let importPending = false;
  let importStageable = false;
  if (config.importDatabaseUrl != null) {
    try {
      let state = await sharedImportState(db);
      if (state === 'staged') {
        const rows = await mergeStagedImport(db);
        console.log(`[notesd] shared import: merged ${Object.entries(rows).map(([t, n]) => `${t} ${n}`).join(', ')}`);
        state = 'done';
      }
      importPending = state !== 'done';
      importStageable = importPending;
    } catch (err) {
      // Left staged: the next start tries the merge again. Nothing is staged twice and nothing restarts for it.
      importPending = true;
      console.error(`[notesd] shared import: the merge failed, nothing was changed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
  // The bound port, known only after listen() (config.port may be 0). The chat agent reaches notes
  // through this daemon's own /mcp, a direct-stream play opens this daemon's player page, and the
  // streaming command reports its plays to it.
  let boundPort: number | null = null;
  // Builds nothing and runs nothing until a streaming tool is called.
  const streaming = config.streaming?.enabled ? scriptRunner({ port: () => boundPort }) : null;
  // Cloudflare WARP on the Windows side (claude/streaming/warp.mjs): the owner's switch (the `warp` tool) and, with
  // NOTESD_STREAM_WARP on, the torrent play on the office network. Runs nothing until asked.
  const warp = scriptWarp();
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
          // No frame: the attempt says whether the stream's host still hands out a segment. Either way the stream plays.
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
  // One Whisper worker (about 850 MB loaded) serves every user: this check, the torrent and cloud transcripts and
  // /sync-subtitle. It starts on the first ask, ends after WHISPER_IDLE_STOP_MS with nothing asked, and a play's
  // language check goes ahead of queued transcriptions. Null with Whisper off or before install.sh has made its Python.
  let sharedWhisper: WorkerTranscriber | null = null;
  if (whisperCfg?.enabled === true) {
    if (await access(whisperCfg.python, fsConstants.X_OK).then(() => true, () => false)) {
      sharedWhisper = new WorkerTranscriber({
        python: whisperCfg.python,
        script: DEFAULT_TORRENT_WHISPER_SCRIPT,
        model: whisperCfg.model,
        threads: whisperCfg.threads,
        modelsDir: join(whisperCfg.dir, 'models'),
        hfHome: join(whisperCfg.dir, 'hf'),
        idleStopMs: WHISPER_IDLE_STOP_MS,
        log: (line) => console.log(line),
      });
    } else if (audioCheckOn) {
      console.log(`[notesd] direct stream: no Whisper Python at ${whisperCfg.python}; cloud audio-language check off. No change to cloud plays until scripts/install.sh installs it.`);
    }
  }
  const audioDetector = audioCheckOn ? sharedWhisper : null;
  const audioCheck =
    audioDetector === null
      ? null
      : new AudioLangCheck({
          verdicts: new AudioVerdicts(join(config.dataDir, MOVIES_SUBDIR, AUDIO_VERDICTS_FILE)),
          // The stream's own segments first (hlsCut.ts), ffmpeg on the manifest when they give nothing.
          grab: streamAudioGrabber({ ffmpegBin: config.directStream?.ffmpegBin ?? DEFAULT_FFMPEG_BIN }),
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
  // The WAVs and empty work folders a stretch in progress left when notesd last stopped (leftovers.ts); in the background.
  void sweepAudioLeftovers(
    { perItem: [join(config.dataDir, TITLE_SUBS_SUBDIR), ...(config.torrent?.dir === undefined ? [] : [config.torrent.dir])], flat: [join(config.dataDir, 'movies', 'subtitle-check')] },
    (line) => console.log(line),
  );
  // The last resort of a cloud stream the services have nothing for: a Whisper transcript of its own audio, as a
  // torrent has (cloudWhisper.ts). Null with NOTESD_TORRENT_WHISPER=off or before install.sh has made Whisper's Python.
  const titleCues = titleCueFeeds(titleSubtitles);
  const cloudWhisper =
    movieStreams === null || config.torrent === undefined
      ? null
      : await buildCloudWhisper({ whisper: config.torrent.whisper, shelf: titleSubtitles, feeds: titleCues, ffmpegBin: config.torrent.ffmpegBin ?? DEFAULT_FFMPEG_BIN, ...(sharedWhisper === null ? {} : { transcriber: sharedTranscriber(sharedWhisper) }) });
  const outsideSubtitles =
    movieStreams === null || config.torrent === undefined
      ? null
      : new OutsideSubtitles({
          whisper: cloudWhisper,
          shelf: titleSubtitles,
          services: { baseUrl: config.torrent.subtitleUrl, wyzie, fetch: (url, init) => fetch(url, init), log: (line) => console.log(line) },
          sync: subtitleSync,
          imdbId: (ref) => movieStreams.imdbId(ref),
        });
  // What this machine knows of each torrent whatever the title (stream_torrent_marks): the owner's blacklist and the
  // language heard in a file that tags none.
  const torrentMarks = new TorrentMarksRepo(db);
  // The torrent audio check: a torrent whose file tags no audio language is heard behind the play through the shared
  // Whisper worker, for any title whose original language is known. Off with NOTESD_STREAM_AUDIO_CHECK=off or no Whisper.
  const torrentHearer =
    sharedWhisper === null || config.directStream?.enabled !== true || config.directStream.audioCheck === false
      ? null
      : new AudioLangCheck({
          verdicts: new AudioVerdicts(join(config.dataDir, MOVIES_SUBDIR, AUDIO_VERDICTS_FILE)),
          grab: streamAudioGrabber({ ffmpegBin: config.directStream.ffmpegBin ?? DEFAULT_FFMPEG_BIN }),
          detector: sharedWhisper,
        });
  let torrentSource: TorrentSource | null = null;
  const torrentSourceOf = (): TorrentSource | null => {
    const torrents = deps.torrents ?? null;
    if (torrentSource === null && torrents !== null && config.torrent?.enabled === true) {
      const place = {
        torrentDir: config.torrent.dir,
        shelf: new SubtitleShelf(config.torrent.dir),
        input: async (infoHash: string, fileIndex: number) => {
          const base = `http://127.0.0.1:${boundPort ?? config.port}`;
          const onDisk = await torrents.filePath(infoHash, fileIndex);
          if (onDisk !== null) return onDisk;
          // A film that lives as its remux (its original deleted) is heard from the remux's segments.
          return (await torrents.remuxOnly(infoHash, fileIndex)) ? remuxAudioInput(base, infoHash, fileIndex) : `${base}${torrents.localUrl(infoHash, fileIndex)}`;
        },
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
        // The public tracker lists' store, filled by startBackground's daily refresh; null when it is off.
        lists: trackerLists.lists,
        marks: torrentMarks,
        hear: torrentHearer,
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
    // The streaming sites, asked only when a play with no source named found nothing through direct streaming.
    siteFallback:
      movieStreams === null || streaming === null
        ? null
        : siteFallback({ runner: streaming, remembered: (ref) => movieStreams.channel(ref), title: (ref) => movieStreams.titleNames(ref), streams: movieStreams }),
    warp,
    hooks:
      movieStreams === null
        ? undefined
        : {
            recordResolve: (ref, result) => movieStreams.recordResolve(ref, result),
            resumeS: (ref) => movieStreams.resumeS(ref),
            originalLanguage: (ref) => movieStreams.originalLanguage(ref),
            setAudioLanguage: (ref, language) => movieStreams.setAudioLanguage(ref, language),
            titleLabel: (ref) => movieStreams.titleLabel(ref),
            anime: (ref) => movieStreams.animeRef(ref, animeMapper),
            neighbors: (ref) => movieStreams.neighbors(ref),
            imdbId: (ref) => movieStreams.imdbId(ref),
            titleNames: (ref) => movieStreams.titleNames(ref),
            channel: (ref) => movieStreams.channel(ref),
            channelFailed: (ref, kind) => movieStreams.channelFailed(ref, kind),
            forgetTorrent: (infoHash) => movieStreams.forgetTorrent(infoHash),
            releaseDate: (ref) => movieStreams.releaseDate(ref),
          },
  });
  if (directStream !== null) {
    try {
      const seeded = await directStream.syncSeed();
      console.log(`[notesd] direct stream: on, ${seeded.total} providers in the seed (${seeded.inserted} new, ${seeded.updated} updated${seeded.removed.length === 0 ? '' : `, ${seeded.removed.join(', ')} removed`}${seeded.reset.length === 0 ? '' : `, ${seeded.reset.join(', ')} asked again`})`);
    } catch (err) {
      console.error(`[notesd] direct stream: could not load the provider seed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Stream cache (stream-cache phase 5): null with direct streaming off. Downloads start only when
  // asked; startBackground carries unfinished ones on.
  // While the old shared database is still to be merged, this host's cache rows may yet arrive: no folder is swept.
  const streamCache = buildStreamCache(config, directStream, new DirectStreamRepo(db), { sweepOrphans: !importPending });
  // Torrents (torrent-stream-source phase 1): null with NOTESD_TORRENT=off or direct streaming off.
  // Building it joins nothing: the WebTorrent engine starts with the first torrent opened.
  // As with the stream cache, a download whose row is still only in the old shared database keeps its folder.
  const torrents = buildTorrentStreams(config, directStream, db, { sweepOrphans: !importPending });
  // A remux that became whole: its original goes now when nothing uses the torrent, else when the torrent leaves the swarm.
  if (torrents !== null) torrentRemux?.whenDone((infoHash, fileIndex) => void torrents.dropOriginals(infoHash, { fileIndex }));
  // The public tracker lists (wider-torrent-sources phase 3): one store, read by every torrent opened and every scrape,
  // and the job that refreshes it once a day from startBackground. Off with NOTESD_TORRENT_TRACKER_LISTS, torrents or
  // discovery off: no store, and a job that does nothing.
  const trackerLists = buildTrackerLists(config.torrent, torrents !== null);
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
          input: async (infoHash, fileIndex) => {
            const onDisk = await torrents.filePath(infoHash, fileIndex);
            if (onDisk !== null) return onDisk;
            // The remux holds no subtitle stream; the original went only once this track's cue feed was complete.
            if (await torrents.remuxOnly(infoHash, fileIndex)) throw new Error('it lives as its remux, which holds no subtitle track');
            return `http://127.0.0.1:${boundPort ?? config.port}${torrents.localUrl(infoHash, fileIndex)}`;
          },
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
          // Asked for every stretch: a film whose original was deleted beside its whole remux is heard from the remux.
          fileUrl: async (infoHash, fileIndex) => {
            const base = `http://127.0.0.1:${boundPort ?? config.port}`;
            return (await torrents.remuxOnly(infoHash, fileIndex)) ? remuxAudioInput(base, infoHash, fileIndex) : `${base}${torrents.localUrl(infoHash, fileIndex)}`;
          },
          ...(sharedWhisper === null ? {} : { transcriber: sharedTranscriber(sharedWhisper) }),
          openFeed: async (infoHash, fileIndex) => {
            const track = whisperTrackId(fileIndex);
            // A feed a stopped run left carries on (the progress file says which stretches are in it); else a new one.
            const feed = (await torrentCues.get(infoHash, track)) ?? (await torrentCues.start(infoHash, track));
            return { url: cueFeedUrl(infoHash, track), append: (cues) => feed.append(cues), complete: () => feed.complete() };
          },
        });
  // The story of a film, an episode or a whole season: from published recaps found with WebSearch first; an
  // episode or a film the web has none of, from its dialogue (one model run, then kept in movie_stories).
  const storyModel = config.movies.storyModel ?? null;
  const movieStories =
    movies === null
      ? null
      : new MovieStories({
          repo: movies.repo,
          dialogue: (target) => loadDialogue(movies.repo, directStream, target),
          writer: storyModel === null ? null : createStoryWriter({ claudeBin: config.chat.claudeBin, model: storyModel, cwd: join(config.dataDir, 'movies-story') }),
          webWriter: storyModel === null ? null : createWebStoryWriter({ claudeBin: config.chat.claudeBin, model: storyModel, cwd: join(config.dataDir, 'movies-web-story') }),
        });
  // What a genre means for one title, collated with web search when the owner clicks it (one model run, then kept).
  const genreGuides =
    movies === null
      ? null
      : new GenreGuides({
          db,
          repo: movies.repo,
          tmdb: movies.tmdb,
          writer:
            config.movies.storyModel === null || config.movies.storyModel === undefined
              ? null
              : createGuideWriter({ claudeBin: config.chat.claudeBin, model: config.movies.storyModel, cwd: join(config.dataDir, 'movies-guide') }),
        });
  const deps: AppDeps = {
    config,
    db,
    ...(importPending ? { importPending } : {}),
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
    warp,
    directStream,
    streamCache,
    torrents,
    torrentCues,
    torrentRemux,
    movieStories,
    genreGuides,
    streamLive,
    streamEvidence,
  };
  // The Cache page (src/directStream/cacheShelf.ts): this host's torrents and cloud caches on disk, deleted after an undo
  // window. Null with neither torrents nor the stream cache. startBackground carries out what a restart left pending.
  deps.cacheShelf =
    (torrents === null && streamCache === null) || movies === null
      ? null
      : new CacheShelf({
          host: movies.host,
          torrents,
          caches: streamCache,
          titles: (ids) => titleWatchViews(db, ids, { host: movies.host, imageBase: config.movies.tmdb.imageBase }),
          live: () => liveSlots(streamLive, deps.directStream ?? null),
          pendingFile: join(config.dataDir, 'movies', CACHE_PENDING_FILE),
        });
  // Seek previews (src/directStream/previews/): sheets made by one niced ffmpeg from what is on this machine, the
  // session on screen first. Null with NOTESD_STREAM_PREVIEWS=off or without direct streaming.
  deps.streamPreviews = buildStreamPreviews(config, { directStream, streamCache, torrents });
  // Downloads the owner asks for (src/directStream/downloads/): one at a time, a 1080p torrent first, then the cloud
  // cache, kept until deleted on the Cache page. It reads the SSID through warp's status; on the office network it
  // holds WARP through the stream service's WarpHolds (directStream.warpForDownloads) to reach a torrent's peers.
  // A finished download's seek previews are queued at once. Null with NOTESD_STREAM_DOWNLOADS=off or neither source.
  deps.streamDownloads = buildStreamDownloads(config, {
    db,
    directStream,
    torrentSource: torrentSourceOf,
    torrents,
    streamCache,
    warp,
    afterDone: () => void deps.streamPreviews?.sweep(),
    movieStreams,
  });
  // True while a VLC play, a stream on screen or a stream being started exists.
  const playing = (): boolean => moviesPlayer?.current() != null || streamLive?.current() != null || (deps.directStream?.starting(null).length ?? 0) > 0;
  // The daily stream canary: each cloud provider asked for one known film, for its health only; nothing while a play exists.
  const canaryService = deps.directStream ?? null;
  deps.streamCanary =
    config.directStream?.canary !== true
      ? new DisabledCanary('setting_off')
      : canaryService === null
        ? new DisabledCanary('direct_stream_off')
        : new StreamCanary({
            providers: async () => (await canaryService.providers()).map((p) => ({ name: p.name, idKind: p.id_kind, browserOnly: p.browser_only })),
            knownTitles: () => loadKnownTitles(),
            resolve: (ref, options) => canaryService.runResolve(ref, options),
            busy: playing,
          });
  // The daily trending list of the Stream side: a DisabledTrending unless NOTESD_TRENDING is on.
  deps.trending = buildTrending({ config, db, movies, torrents: deps.torrents ?? null });
  // Started and closed by startBackground; never in a play's path.
  deps.trackerLists = trackerLists.job;
  // Torrent phase 8: closed by startBackground's stop, which ends a running Whisper worker.
  deps.torrentWhisper = whisperTier;
  deps.cloudWhisper = cloudWhisper;
  deps.titleCues = titleCues;
  // The shared Whisper worker: ended by startBackground's stop. Null with Whisper off or not installed.
  deps.audioDetector = sharedWhisper;
  // Wyzie Synced and the per-title subtitle shelf: closed by startBackground's stop; read by the `/api/stream/subs` route.
  deps.torrentSync = subtitleSync;
  deps.titleSubtitles = titleSubtitles;
  // /sync-subtitle: a stream's subtitle judged against the film's own audio (subtitleCheck/). It hears with a Whisper
  // worker of its own, started by the first check and ended when none runs. Null without direct streaming, with
  // Whisper off, or before install.sh has made Whisper's Python.
  deps.subtitleCheck = null;
  if (directStream !== null && sharedWhisper !== null && config.torrent !== undefined) {
    const ffmpegBin = config.torrent.ffmpegBin;
    deps.subtitleCheck = new SubtitleCheckService(
      new CheckSubjects({
        directStream,
        torrents,
        torrentShelf: torrents === null ? null : new SubtitleShelf(config.torrent.dir),
        titleShelf: titleSubtitles,
        services: { baseUrl: config.torrent.subtitleUrl, wyzie, fetch: (url, init) => fetch(url, init) },
        localBase: () => `http://127.0.0.1:${boundPort ?? config.port}`,
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
  // The old shared database is staged behind the daemon as soon as it can be read. The merge needs a
  // start with nothing running, so once the stage is complete the daemon asks to be restarted, and
  // waits with that while something plays.
  let restartTimer: ReturnType<typeof setInterval> | null = null;
  const stopSharedImport =
    importStageable && config.importDatabaseUrl != null
      ? startSharedImport(config.importDatabaseUrl, db, {
          onStaged: () => {
            if (options.onRestartWanted === undefined) return;
            const busy = (): boolean =>
              moviesPlayer?.current() != null || streamLive?.current() != null || (deps.directStream?.starting(null).length ?? 0) > 0;
            const ask = (): void => {
              if (busy()) return;
              if (restartTimer !== null) clearInterval(restartTimer);
              restartTimer = null;
              console.log('[notesd] shared import: restarting to merge the staged rows');
              options.onRestartWanted?.();
            };
            restartTimer = setInterval(ask, IMPORT_RESTART_CHECK_MS);
            restartTimer.unref();
            ask();
          },
        })
      : (): void => {};

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
      stopSharedImport();
      if (restartTimer !== null) clearInterval(restartTimer);
      await streamEvidence?.flushed();
      await closeDb(db);
    })();
    return stopping;
  };
  return { deps, port, stop };
}
