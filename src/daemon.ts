import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { buildAdversary } from './adversary/start.js';
import { startBackground } from './background.js';
import type { ChatBackend } from './chat/backend.js';
import { CHAT_IMAGES_SUBDIR } from './chat/images.js';
import { ChatService } from './chat/service.js';
import { CHAT_SUBDIR, buildChatBackend } from './chat/start.js';
import type { Config } from './config.js';
import { closeDb, createDb } from './db/client.js';
import { openLocalDb } from './db/localDb.js';
import { mergeSharedImportAtStart, startSharedImportRestart } from './db/sharedImportStart.js';
import type { AppDeps } from './deps.js';
import { startDirectStreaming } from './directStream/start.js';
import { playingNow, wireStreamExtras } from './directStream/startExtras.js';
import type { Embedder } from './embeddings/embedder.js';
import type { ImageEmbedder } from './embeddings/imageEmbedder.js';
import { embedderFromConfig } from './embeddings/openrouter.js';
import { imageEmbedderFromConfig } from './embeddings/openrouterImage.js';
import { createApp } from './http/app.js';
import { buildMovieWriters, startMovies, startMoviesHealth } from './movies/start.js';
import { NoteEvents } from './notes/events.js';
import { NotesService } from './notes/service.js';
import { seedRemindersAtStart } from './reminders/start.js';
import { SessionEvents } from './sessions/events.js';
import { buildSessionSummarizer } from './sessions/start.js';

export { CHAT_SUBDIR } from './chat/start.js';
export { IMPORT_RESTART_CHECK_MS } from './db/sharedImportStart.js';

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
  /** The clock of the reminder seeds (src/reminders/seeds.ts): a seed is due its days after this. Omitted: the wall clock. */
  now?: () => Date;
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

/**
 * config -> data dirs -> embedders -> db (waited for and migrated when local) -> the staged import's merge -> reminder
 * seeds -> notes, chat history, adversary -> movies -> direct streaming -> deps -> chat -> app -> listen on loopback ->
 * VLC health -> background jobs -> the import's staging. Each subsystem's wiring lives in a start file beside it; this
 * keeps only the order. stop() closes them in the reverse order.
 */
export async function startDaemon(config: Config, options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  if (config.host !== '127.0.0.1') {
    throw new Error(`notesd binds 127.0.0.1 only (got host ${config.host}).`);
  }
  await ensureDataDirs(config.dataDir);
  // Before createDb: a blank key throws EmbeddingError here, with no pool to leak.
  const embedder = options.embedder !== undefined ? options.embedder : embedderFromConfig(config.embeddings);
  const imageEmbedder = options.imageEmbedder !== undefined ? options.imageEmbedder : imageEmbedderFromConfig(config.embeddings);
  // This machine's own database is waited for and migrated here; any other is its caller's to prepare.
  const db = config.localDatabase === true ? await openLocalDb(config.databaseUrl) : createDb(config.databaseUrl);
  // A complete stage of the old shared database is merged now, before anything else uses the database.
  const sharedImport = await mergeSharedImportAtStart(config.importDatabaseUrl, db);
  await seedRemindersAtStart(db, options.now);
  const events = new NoteEvents();
  const sessionEvents = new SessionEvents();
  const service = new NotesService({ db, dataDir: config.dataDir, events, embedder });
  const chatHistory = new ChatService({ db });
  const adversary = buildAdversary(config, db);
  const { movies, moviesHealth, moviesPlayer, movieStreams } = await startMovies(config, db);
  // The bound port, known only after listen() (config.port may be 0). The chat agent reaches notes through this
  // daemon's own /mcp, a direct-stream play opens this daemon's player page, and the streaming command reports to it.
  let boundPort: number | null = null;
  const port$ = (): number | null => boundPort;
  const stream = await startDirectStreaming({ config, db, movies, movieStreams, importPending: sharedImport.pending, boundPort: port$ });
  const { movieStories, genreGuides } = buildMovieWriters(config, db, movies, stream.directStream);
  const deps: AppDeps = {
    config,
    db,
    ...(sharedImport.pending ? { importPending: true } : {}),
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
    streaming: stream.streaming,
    warp: stream.warp,
    directStream: stream.directStream,
    streamCache: stream.streamCache,
    torrents: stream.torrents,
    torrentCues: stream.torrentCues,
    torrentRemux: stream.torrentRemux,
    movieStories,
    genreGuides,
    streamLive: stream.streamLive,
    streamEvidence: stream.streamEvidence,
    playLog: stream.playLog,
  };
  wireStreamExtras(deps, stream, movieStreams, port$);
  const { chat, agent } = buildChatBackend(config, options.chat, port$);
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
  await startMoviesHealth(moviesHealth);
  const stopBackground = await startBackground(deps, { sessionSummarizer: buildSessionSummarizer(config) });
  // Once the stage is complete the daemon asks to be restarted, and waits with that while something plays.
  const stopSharedImport = startSharedImportRestart({
    importDatabaseUrl: config.importDatabaseUrl,
    db,
    stageable: sharedImport.stageable,
    ...(options.onRestartWanted === undefined ? {} : { onRestartWanted: options.onRestartWanted }),
    busy: () => playingNow(deps),
  });

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
      await stream.streamEvidence?.flushed();
      await closeDb(db);
    })();
    return stopping;
  };
  return { deps, port, stop };
}
