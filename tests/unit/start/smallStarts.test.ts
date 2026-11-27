import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AdversaryService } from '../../../src/adversary/service.js';
import { buildAdversary } from '../../../src/adversary/start.js';
import type { AgentChatBackend } from '../../../src/chat/agent.js';
import type { ChatBackend } from '../../../src/chat/backend.js';
import { CHAT_SUBDIR, buildChatBackend } from '../../../src/chat/start.js';
import { DEFAULT_ADVERSARY_CONFIG, DEFAULT_SESSIONS_CONFIG } from '../../../src/config.js';
import { CHAT_SUBDIR as FROM_DAEMON } from '../../../src/daemon.js';
import type { Db } from '../../../src/db/client.js';
import { seedRemindersAtStart } from '../../../src/reminders/start.js';
import { buildSessionSummarizer } from '../../../src/sessions/start.js';
import { SUMMARIES_SUBDIR, type Summarizer } from '../../../src/sessions/summarize.js';
import { startConfig } from '../../helpers/startConfig.js';

const db = {} as Db;

describe('seedRemindersAtStart', () => {
  it('says which seeds it stored, with the clock it was given', async () => {
    const lines: string[] = [];
    const at = new Date('2026-11-27T00:00:00Z');
    const seed = vi.fn(async (_db: Db, now: () => Date) => {
      expect(now()).toBe(at);
      return ['play-log-ranking', 'other'];
    });
    await seedRemindersAtStart(db, () => at, { seed, log: (l) => lines.push(l) });
    expect(seed).toHaveBeenCalledWith(db, expect.any(Function));
    expect(lines).toEqual(['[notesd] reminders: stored play-log-ranking, other']);
  });

  it('says nothing when every seed was stored by an earlier start', async () => {
    const lines: string[] = [];
    await seedRemindersAtStart(db, undefined, { seed: async () => [], log: (l) => lines.push(l) });
    expect(lines).toEqual([]);
  });

  it('a failure costs the seed, never the start', async () => {
    const errors: string[] = [];
    await expect(
      seedRemindersAtStart(db, undefined, {
        seed: async () => {
          throw new Error('relation "reminders" does not exist');
        },
        error: (l) => errors.push(l),
      }),
    ).resolves.toBeUndefined();
    expect(errors).toEqual(['[notesd] reminders: could not store the seeds: relation "reminders" does not exist']);
  });
});

describe('buildAdversary', () => {
  const fake = { host: 'pc' } as unknown as AdversaryService;

  it('builds nothing with NOTESD_ADVERSARY=off', () => {
    const create = vi.fn(() => fake);
    expect(buildAdversary(startConfig(), db, { create })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('builds the reviewer from the config, the database, the claude binary, the data dir and this host', () => {
    const config = startConfig({ adversary: { ...DEFAULT_ADVERSARY_CONFIG, enabled: true } });
    const create = vi.fn(() => fake);
    expect(buildAdversary(config, db, { create, host: () => 'laptop' })).toBe(fake);
    expect(create).toHaveBeenCalledWith({ config: config.adversary, db, claudeBin: config.chat.claudeBin, dataDir: config.dataDir, host: 'laptop' });
  });

  it('says once that the reviewer is off when no claude binary is found', () => {
    const config = startConfig({ adversary: { ...DEFAULT_ADVERSARY_CONFIG, enabled: true } });
    const lines: string[] = [];
    expect(buildAdversary(config, db, { create: () => null, log: (l) => lines.push(l) })).toBeNull();
    expect(lines).toEqual([`[notesd] adversary off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`]);
  });
});

describe('buildSessionSummarizer', () => {
  const fake = { model: 'haiku' } as unknown as Summarizer;

  it('builds nothing with NOTESD_SESSIONS=off', () => {
    const create = vi.fn(() => fake);
    expect(buildSessionSummarizer(startConfig(), { create })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('runs the summarizer in <dataDir>/session-summaries with the claude binary', () => {
    const config = startConfig({ sessions: { ...DEFAULT_SESSIONS_CONFIG, enabled: true } });
    const create = vi.fn(() => fake);
    expect(buildSessionSummarizer(config, { create })).toBe(fake);
    expect(create).toHaveBeenCalledWith({ claudeBin: config.chat.claudeBin, cwd: join(config.dataDir, SUMMARIES_SUBDIR) });
  });

  it('says once that summaries are off when no claude binary is found', () => {
    const config = startConfig({ sessions: { ...DEFAULT_SESSIONS_CONFIG, enabled: true } });
    const lines: string[] = [];
    expect(buildSessionSummarizer(config, { create: () => null, log: (l) => lines.push(l) })).toBeNull();
    expect(lines).toEqual([`[notesd] session summaries off: claude binary "${config.chat.claudeBin}" not found (set NOTESD_CLAUDE_BIN)`]);
  });
});

describe('buildChatBackend', () => {
  it('keeps the daemon export of the chat cwd', () => {
    expect(FROM_DAEMON).toBe(CHAT_SUBDIR);
  });

  it('serves an injected backend and builds no agent', () => {
    const injected = {} as ChatBackend;
    const create = vi.fn();
    expect(buildChatBackend(startConfig(), injected, () => 1, create)).toEqual({ chat: injected, agent: null });
    expect(create).not.toHaveBeenCalled();
  });

  it('builds the Agent SDK backend in <dataDir>/chat, reaching this daemon /mcp once it listens', () => {
    const config = startConfig();
    const agent = { close: vi.fn() } as unknown as AgentChatBackend;
    let options: Parameters<Parameters<typeof buildChatBackend>[3] & object>[0] | null = null;
    let port: number | null = null;
    const built = buildChatBackend(config, undefined, () => port, (o) => {
      options = o;
      return agent;
    });
    expect(built).toEqual({ chat: agent, agent });
    expect(options!.cwd).toBe(join(config.dataDir, CHAT_SUBDIR));
    expect(options!.chat).toBe(config.chat);
    expect(() => options!.mcpUrl()).toThrow('notesd is not listening yet.');
    port = 45123;
    expect(options!.mcpUrl()).toBe('http://127.0.0.1:45123/mcp');
  });
});
