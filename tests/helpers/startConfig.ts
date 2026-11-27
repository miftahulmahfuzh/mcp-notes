import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_ADVERSARY_CONFIG,
  DEFAULT_CHAT_CONFIG,
  DEFAULT_DIRECT_STREAM_CONFIG,
  DEFAULT_DWORD_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_MOVIES_CONFIG,
  DEFAULT_SESSIONS_CONFIG,
  DEFAULT_TORRENT_CONFIG,
  type Config,
  type TorrentConfig,
} from '../../src/config.js';

/** A Config literal for the start-wiring tests: every subsystem off, nothing on disk outside a temp dir. */
export function startConfig(over: Partial<Config> = {}): Config {
  return {
    databaseUrl: 'postgres://unused',
    port: 7999,
    host: '127.0.0.1',
    dataDir: join(tmpdir(), 'notesd-start-test'),
    chat: DEFAULT_CHAT_CONFIG,
    embeddings: DEFAULT_EMBEDDINGS_CONFIG,
    sessions: DEFAULT_SESSIONS_CONFIG,
    adversary: DEFAULT_ADVERSARY_CONFIG,
    dword: DEFAULT_DWORD_CONFIG,
    movies: DEFAULT_MOVIES_CONFIG,
    ...over,
  };
}

/** Direct streaming on (the library is a caller's fake), with the picture check named by `pictureModel`. */
export function streamConfig(over: Partial<NonNullable<Config['directStream']>> = {}, torrent?: Partial<TorrentConfig>): Config {
  return startConfig({
    directStream: { ...DEFAULT_DIRECT_STREAM_CONFIG, enabled: true, ...over },
    ...(torrent === undefined ? {} : { torrent: { ...DEFAULT_TORRENT_CONFIG, ...torrent } }),
  });
}

/** Whisper on, with its Python at `/fake/python`. */
export const WHISPER_ON = { enabled: true, dir: '/fake/whisper', python: '/fake/python', model: 'small', threads: 2, stretchS: 300 } as const;
