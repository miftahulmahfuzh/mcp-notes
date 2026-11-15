import type { AdversaryService } from './adversary/service.js';
import type { ChatService } from './chat/service.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Embedder } from './embeddings/embedder.js';
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
import type { MoviePlayer } from './movies/player.js';
import type { HealthMonitor } from './movies/vlc/health.js';
import type { MoviesService } from './movies/service.js';
import type { StreamingRunner } from './streaming/service.js';
import type { DirectStreamService } from './directStream/service.js';
import type { StreamLive } from './movies/streamLive.js';
import type { StreamProberHandle } from './directStream/prober.js';
import type { NoteEvents } from './notes/events.js';
import type { NotesService } from './notes/service.js';
import type { SessionEvents } from './sessions/events.js';

/** Everything the daemon wires together once at startup and hands to routes and background jobs. */
export interface AppDeps {
  config: Config;
  db: Db;
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
   * Direct streaming (DIRECT_STREAMING_PLAN phase 3): registry, resolves, sessions and the
   * pass-through. Null or absent when NOTESD_DIRECT_STREAM=off, NOTESD_MOVIES=off or `movies` is
   * null; every /api/stream/* route then answers 503 direct_stream_off.
   */
  directStream?: DirectStreamService | null;
  /** The stream on screen in the player page (src/movies/streamLive.ts); null or absent with the movie library off. */
  streamLive?: StreamLive | null;
  /**
   * The direct-streaming prober (phase 10). The daemon always sets it: a DisabledProber unless
   * NOTESD_STREAM_PROBER=on and everything it needs is there. Absent (tests), GET /api/stream/prober
   * reports it off. Started and closed by startBackground.
   */
  streamProber?: StreamProberHandle | null;
  /**
   * Session context changes: this host's ingest emits (src/background.ts), each open
   * GET /api/sessions/:nodeId/context/stream listens. The daemon always sets it; omitted (tests),
   * a context stream sends its first event and heartbeats only.
   */
  sessionEvents?: SessionEvents;
}
