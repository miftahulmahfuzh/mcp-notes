import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_CONFIG, type Config } from '../../src/config.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { createScriptedChatBackend } from './helpers/scripted-chat.js';
import { parseSse } from './helpers/sse.js';
import { testDatabaseUrl } from './setup.js';

const url = testDatabaseUrl();

const dataDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
let daemon: RunningDaemon;

function config(dir: string): Config {
  return { databaseUrl: url, port: 0, host: '127.0.0.1', dataDir: dir, chat: DEFAULT_CHAT_CONFIG };
}

async function postChat(port: number, message: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

beforeAll(async () => {
  // Port 0: never the installed daemon's 7317.
  daemon = await startDaemon(config(dataDir));
});

afterAll(async () => {
  await daemon.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('startDaemon', () => {
  it('creates the data dirs, including the chat cwd', () => {
    for (const sub of ['images', 'cache', 'inbox', 'inbox/failed', 'chat']) expect(existsSync(join(dataDir, sub))).toBe(true);
  });

  it('listens on 127.0.0.1 and answers /health', async () => {
    expect(daemon.port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'notesd' });
  });

  it('answers an MCP initialize over real HTTP', async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name?: string }; instructions?: string } };
    expect(body.result?.serverInfo?.name).toBe('mcp-notes');
    expect(body.result?.instructions).toContain('A-B32');
  });

  it('serves the stub chat backend when none is injected', async () => {
    const messages = await postChat(daemon.port, 'hello');
    expect(messages.every((m) => m.event === 'delta' || m.event === 'done')).toBe(true);
    expect(messages.at(-1)?.event).toBe('done');
    expect((messages.at(-1)?.data as { thread_id: string }).thread_id).toMatch(/^stub-/);
  });

  it('serves an injected chat backend', async () => {
    const otherDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
    const fake = createScriptedChatBackend();
    fake.push({
      steps: [{ type: 'status', text: 'searching notes' }, { type: 'delta', text: 'injected' }],
      end: { threadId: 'sess-d', brain: 'claude' },
    });
    const other = await startDaemon(config(otherDir), { chat: fake });
    try {
      expect(await postChat(other.port, 'hi')).toEqual([
        { event: 'status', data: { text: 'searching notes' } },
        { event: 'delta', data: { text: 'injected' } },
        { event: 'done', data: { thread_id: 'sess-d', brain: 'claude' } },
      ]);
      expect(fake.requests).toHaveLength(1);
    } finally {
      await other.stop();
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('refuses a non-loopback host', async () => {
    // Config types host as the literal '127.0.0.1'; the cast simulates a hand-built bad config.
    const bad = { ...config(dataDir), host: '0.0.0.0' } as unknown as Config;
    await expect(startDaemon(bad)).rejects.toThrow(/127\.0\.0\.1/);
  });
});
