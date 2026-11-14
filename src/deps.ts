import type { AdversaryService } from './adversary/service.js';
import type { ChatService } from './chat/service.js';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { Embedder } from './embeddings/embedder.js';
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
import type { MoviesService } from './movies/service.js';
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
   * Session context changes: this host's ingest emits (src/background.ts), each open
   * GET /api/sessions/:nodeId/context/stream listens. The daemon always sets it; omitted (tests),
   * a context stream sends its first event and heartbeats only.
   */
  sessionEvents?: SessionEvents;
}
