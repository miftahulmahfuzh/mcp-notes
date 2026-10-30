import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon.js';
import { testDatabaseUrl } from './setup.js';

const url = testDatabaseUrl();

const dataDir = join(mkdtempSync(join(tmpdir(), 'notesd-')), 'data');
let daemon: RunningDaemon;

beforeAll(async () => {
  // Port 0: never the installed daemon's 7317.
  daemon = await startDaemon({ databaseUrl: url, port: 0, host: '127.0.0.1', dataDir });
});

afterAll(async () => {
  await daemon.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('startDaemon', () => {
  it('creates the data dirs', () => {
    for (const sub of ['images', 'cache', 'inbox', 'inbox/failed']) expect(existsSync(join(dataDir, sub))).toBe(true);
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

  it('refuses a non-loopback host', async () => {
    // Config types host as the literal '127.0.0.1'; the cast simulates a hand-built bad config.
    const bad = { databaseUrl: url, port: 0, host: '0.0.0.0', dataDir } as unknown as Config;
    await expect(startDaemon(bad)).rejects.toThrow(/127\.0\.0\.1/);
  });
});
