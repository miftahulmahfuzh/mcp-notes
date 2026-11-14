import { mkdir } from 'node:fs/promises';
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
import type { Config } from './config.js';
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
import { buildMoviesService } from './movies/service.js';
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
  // Movies phase 5: VLC playback and the [RecentsMRL] hook hang off the movies service.
  const moviesPlayer: MoviePlayer | null = movies === null ? null : buildMoviePlayback(movies, config.movies);
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
  const deps: AppDeps = { config, db, events, service, embedder, imageEmbedder, chat: chatHistory, adversary, movies, moviesPlayer, sessionEvents };
  // The agent reaches notes through this daemon's own /mcp. The port is known only after
  // listen() (config.port may be 0), and the first chat run can only start after that.
  let boundPort: number | null = null;
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
      await stopBackground();
      await closeServer(server);
      await closeDb(db);
    })();
    return stopping;
  };
  return { deps, port, stop };
}
