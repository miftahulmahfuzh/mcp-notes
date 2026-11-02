import { describe, expect, it } from 'vitest';
import { embedBackfill, type EmbedBackfillIo } from '../../../src/cli/embedBackfill.js';
import { ConfigError, DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, DEFAULT_SESSIONS_CONFIG, type Config } from '../../../src/config.js';

interface Captured {
  io: EmbedBackfillIo;
  out: string[];
  err: string[];
  dbsOpened: () => number;
}

function capture(loadConfig: () => Config): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let dbs = 0;
  const io: EmbedBackfillIo = {
    loadConfig,
    createDb: () => {
      dbs += 1;
      throw new Error('createDb must not be called');
    },
    closeDb: async () => {},
    createEmbedder: () => {
      throw new Error('createEmbedder must not be called');
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err, dbsOpened: () => dbs };
}

const noKey = (): Config => ({
  databaseUrl: 'postgres://u:p@127.0.0.1:1/x',
  port: 0,
  host: '127.0.0.1',
  dataDir: '/tmp/mcp-notes-unused',
  chat: DEFAULT_CHAT_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
  sessions: DEFAULT_SESSIONS_CONFIG,
});

describe('embedBackfill CLI', () => {
  it('prints usage for --help and exits 0 without loading config', async () => {
    const c = capture(() => {
      throw new Error('loadConfig must not be called');
    });
    expect(await embedBackfill(['--help'], c.io)).toBe(0);
    expect(c.out.join('\n')).toMatch(/--retry-failed/);
  });

  it('rejects an unknown argument with exit 2', async () => {
    const c = capture(noKey);
    expect(await embedBackfill(['--fast'], c.io)).toBe(2);
    expect(c.err[0]).toBe('embed:backfill: unknown argument --fast');
  });

  it('exits 1 without OPENROUTER_API_KEY and never opens the database', async () => {
    const c = capture(noKey);
    expect(await embedBackfill([], c.io)).toBe(1);
    expect(c.err.join('\n')).toMatch(/OPENROUTER_API_KEY is not set/);
    expect(c.dbsOpened()).toBe(0);
  });

  it('exits 1 on a config error', async () => {
    const c = capture(() => {
      throw new ConfigError('DATABASE_URL is not set.');
    });
    expect(await embedBackfill([], c.io)).toBe(1);
    expect(c.err).toEqual(['embed:backfill: DATABASE_URL is not set.']);
  });
});
