import type { AdversaryService } from './adversary/service.js';
import type { ChatService } from './chat/service.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Embedder } from './embeddings/embedder.js';
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
import type { MoviePlayer } from './movies/player.js';
import type { HealthMonitor } from './movies/vlc/health.js';
import type { MoviesService } from './movies/service.js';
import type { GenreGuides } from './movies/guides.js';
import type { MovieStories } from './movies/story.js';
import type { StreamingRunner } from './streaming/service.js';
import type { WarpSwitch } from './streaming/warp.js';
import type { DirectStreamService } from './directStream/service.js';
import type { StreamCache } from './directStream/cache/service.js';
import type { TorrentStreams } from './directStream/torrent/service.js';
import type { CacheShelf } from './directStream/cacheShelf.js';
import type { CueFeeds } from './directStream/torrent/subtitles/feed.js';
import type { TorrentRemux } from './directStream/torrent/remux.js';
import type { SubtitleCheckService } from './directStream/subtitleCheck/subjects.js';
import type { CloudWhisper } from './directStream/cloudWhisper.js';
import type { TitleSubtitleShelf } from './directStream/titleSubtitles.js';
import type { SubtitleSync } from './directStream/torrent/subtitles/synced.js';
import type { WhisperTier, WorkerTranscriber } from './directStream/torrent/subtitles/whisper.js';
import type { StreamLive } from './movies/streamLive.js';
import type { CanaryHandle } from './directStream/canary.js';
import type { TrendingHandle } from './directStream/trending/job.js';
import type { TrackerListsHandle } from './directStream/torrent/trackerLists.js';
import type { StreamEvidence } from './directStream/evidence.js';
import type { StreamReporter } from './directStream/report.js';
import type { NoteEvents } from './notes/events.js';
import type { NotesService } from './notes/service.js';
import type { SessionEvents } from './sessions/events.js';

/** Everything the daemon wires together once at startup and hands to routes and background jobs. */
export interface AppDeps {
  config: Config;
  db: Db;
  /**
   * True while the old shared database has not been copied in yet (src/db/sharedImport.ts): the
   * billed work on sessions (summaries, reply vectors) waits, since the copy brings those along.
   */
  importPending?: boolean;
  events: NoteEvents;
  service: NotesService;
  /** Null without OPENROUTER_API_KEY (or when a test injects null): semantic features off. */
  embedder: Embedder | null;
  /** Gemini image embedder for `similar_images` and the image worker. Null: image search off. */
  imageEmbedder: ImageEmbedder | null;
  /** Chat history: threads, messages, edits, deletes (phase 7). The only writer of the chat tables. */
  chat: ChatService;
  /** Seer Adversarial reviewer (phase 4). Null when NOTESD_ADVERSARY=off or no claude binary. Phase 5's routes call it. */
  adversary: AdversaryService | null;
  /**
   * The movies library: sync, matching and playback on this host (MOVIES_LIBRARY_PLAN phase 3
   * builds it). Null when NOTESD_MOVIES=off, and always null until phase 3 lands. Routes answer
   * 503 `movies_off` without it.
   */
  movies: MoviesService | null;
  /**
   * VLC playback (movies phase 5). The daemon builds it next to `movies`; null or absent when
   * `movies` is null. Read by moviesPlayRoutes, /api/capabilities and (phase 7) movies_continue.
   */
  moviesPlayer?: MoviePlayer | null;
  /**
   * The VLC health log (movies phase 9): built next to `moviesPlayer`; null or absent when `movies`
   * is null. Read by GET /api/movies/player/health.
   */
  moviesHealth?: HealthMonitor | null;
  /**
   * Runs claude/streaming/cli.mjs for the streaming tools (src/mcp/streamingTools.ts). The daemon
   * sets it unless NOTESD_STREAMING=off; null or absent (tests), the tools answer streaming_off.
   */
  streaming?: StreamingRunner | null;
  /**
   * Cloudflare WARP's switch on the Windows side (src/streaming/warp.ts) behind the `warp` tool. The daemon always
   * builds it (it runs nothing until asked); null or absent (tests): the tool answers warp_off.
   */
  warp?: WarpSwitch | null;
  /**
   * Direct streaming (DIRECT_STREAMING_PLAN phase 3): registry, resolves, sessions and the
   * pass-through. Null or absent when NOTESD_DIRECT_STREAM=off, NOTESD_MOVIES=off or `movies` is
   * null; every /api/stream/* route then answers 503 direct_stream_off.
   */
  directStream?: DirectStreamService | null;
  /**
   * The stream cache (stream-cache phase 5): films and episodes downloaded to this host's disk. Built
   * next to `directStream`; null or absent with direct streaming off. startBackground carries its
   * unfinished downloads on and closes it.
   */
  streamCache?: StreamCache | null;
  /**
   * Torrents (torrent-stream-source phase 1): this host's torrent downloads, the engine and the
   * /api/stream/torrent routes. Built next to `directStream`; null or absent with direct streaming off or
   * NOTESD_TORRENT=off. startBackground starts its tick and closes it.
   */
  torrents?: TorrentStreams | null;
  /**
   * The Cache page (src/directStream/cacheShelf.ts): this host's torrents and cloud caches on disk, and their deletion
   * after an undo window. Built next to `torrents` and `streamCache`; null or absent with both off (the routes and the
   * `stream_disk` tool then answer stream_disk_off). startBackground carries out what a restart left pending.
   */
  cacheShelf?: CacheShelf | null;
  /**
   * The growing cue feeds of torrent sessions (torrent-stream-source phase 7: the subtitle track inside
   * a torrent's file; phase 8: Whisper). Built next to `torrents`; null or absent with torrents off,
   * and GET /api/stream/torrent/:hash/cues/:track then answers 503 torrent_off.
   */
  torrentCues?: CueFeeds | null;
  /**
   * The remux of torrent files Chrome cannot play as is (torrent phase 5, src/directStream/torrent/remux.ts): its
   * file route is /api/stream/torrent/:hash/hls/:index/:name. Null or absent with torrents or NOTESD_TORRENT_REMUX
   * off. startBackground's close stops its ffmpeg runs.
   */
  torrentRemux?: TorrentRemux | null;
  /**
   * The stories of films and episodes (src/movies/story.ts): read from the store, written by
   * Claude on the owner's click. The daemon builds it next to `movies`; null or absent, the story
   * routes answer 503.
   */
  movieStories?: MovieStories | null;
  /**
   * What a genre means for one title (src/movies/guides.ts): read from the store, collated by Claude
   * with web search on the owner's click. Null or absent, the genre routes answer 503.
   */
  genreGuides?: GenreGuides | null;
  /**
   * Wakes the session summary worker now (a summary was requested). Set by startBackground while the
   * worker runs; absent, the request waits for the worker's sweep.
   */
  kickSummaries?: () => void;
  /** The stream on screen in the player page (src/movies/streamLive.ts); null or absent with the movie library off. */
  streamLive?: StreamLive | null;
  /**
   * The daily stream canary (src/directStream/canary.ts): every cloud provider asked for one known film, for
   * its health. The daemon always sets it (a DisabledCanary with NOTESD_STREAM_CANARY=off or direct streaming
   * off); absent in tests. Started and closed by startBackground.
   */
  streamCanary?: CanaryHandle | null;
  /**
   * The Stream side's daily trending list (src/directStream/trending/job.ts). The daemon always sets it: a
   * DisabledTrending unless NOTESD_TRENDING is on and movies, direct streaming, torrents and TMDB are there.
   * Absent (tests), GET /api/movies/trending reports it off. Started and closed by startBackground.
   */
  trending?: TrendingHandle | null;
  /**
   * The public tracker lists' daily refresh (src/directStream/torrent/trackerLists.ts). The daemon always sets it: a
   * DisabledTrackerLists unless NOTESD_TORRENT_TRACKER_LISTS, torrents and discovery are on. Started and closed by
   * startBackground; absent (tests): nothing runs.
   */
  trackerLists?: TrackerListsHandle | null;
  /**
   * This host's stream evidence log (src/directStream/evidence.ts): every pass-through answer, the
   * player page's log lines, and snapshots under <dataDir>/movies/stream-reports/. The daemon builds
   * it with direct streaming; null or absent, the evidence routes answer 503 direct_stream_off.
   */
  streamEvidence?: StreamEvidence | null;
  /**
   * The player's report button (stream-cache-and-bug-report phase 4): one evidence snapshot and one
   * tmux Claude Code window per stream session. The daemon sets it while direct streaming and the
   * evidence log are on; null or absent, POST /api/stream/sessions/:id/report answers 503 report_off.
   */
  streamReporter?: StreamReporter | null;
  /**
   * Whisper, the last subtitle tier of a torrent session (torrent phase 8). Null or absent with
   * Whisper off or not installed; startBackground's stop closes it, which ends its worker.
   */
  torrentWhisper?: WhisperTier | null;
  /**
   * Whisper for a cloud stream the subtitle services have nothing for (cloudWhisper.ts), and the store of its
   * growing cue feeds, which `GET /api/stream/subs/:title/cues/:track` reads. Null or absent with Whisper off, not
   * installed, or without direct streaming; startBackground's stop closes the transcript, which ends its worker.
   */
  cloudWhisper?: CloudWhisper | null;
  titleCues?: CueFeeds | null;
  /**
   * The daemon's one Whisper worker, shared by the cloud audio-language check (audioLang.ts), the torrent and cloud
   * transcripts and /sync-subtitle. It starts on the first ask and ends when idle. Null or absent with Whisper off or
   * not installed; startBackground's stop ends it.
   */
  audioDetector?: WorkerTranscriber | null;
  /**
   * Wyzie Synced: the background re-timing of a stream session's subtitle that came from outside the
   * stream (a torrent's service or borrowed file, a cloud session's outside file). Null or absent when
   * off or with no Wyzie key. startBackground's stop closes it, which stops its jobs.
   */
  torrentSync?: SubtitleSync | null;
  /** Where a title's outside subtitle is kept on this machine (`<data dir>/movies/stream-subs`); the `/api/stream/subs` route reads it. Null or absent without direct streaming. */
  titleSubtitles?: TitleSubtitleShelf | null;
  /**
   * /sync-subtitle (direct_stream_sync_subtitle): judges a stream's subtitle against the film's own audio, heard
   * by a Whisper worker of its own, and replaces a wrong or out-of-step one (src/directStream/subtitleCheck/).
   * Null or absent with direct streaming off, Whisper off or not installed. startBackground's stop closes it.
   */
  subtitleCheck?: SubtitleCheckService | null;
  /**
   * Session context changes: this host's ingest emits (src/background.ts), each open
   * GET /api/sessions/:nodeId/context/stream listens. The daemon always sets it; omitted (tests),
   * a context stream sends its first event and heartbeats only.
   */
  sessionEvents?: SessionEvents;
}
