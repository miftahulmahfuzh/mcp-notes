import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../src/deps.js';
import { sessionsApiRoutes } from '../../src/http/sessionsApi.js';
import { SessionEvents, sessionContextObserver } from '../../src/sessions/events.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import type { SessionContextPayload } from '../../src/sessions/view.js';
import { copyFixtureClaudeHome, FIXTURE } from '../helpers/claudeHome.js';
import { createApiHarness, type ApiHarness } from './helpers/api-harness.js';
import { parseSse, readUntil, waitFor } from './helpers/sse.js';
import { truncateAll } from './setup.js';

const HOST = 'test-host';

let h: ApiHarness;
let home: string;
let bus: SessionEvents;
let app: Hono;
const running: SessionIngester[] = [];

function start(): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: FIXTURE.worktreesDir,
    homeDir: FIXTURE.homeDir,
    store: new SessionsRepo(h.deps.db),
    hostname: () => HOST,
    resolver: createRepoResolver({
      homeDir: FIXTURE.homeDir,
      worktreesDir: FIXTURE.worktreesDir,
      isDirectory: async () => false,
      gitRoots: async () => null,
      listRepoNames: async () => ['mcp-notes'],
    }),
    watch: false,
    sweepMs: 0,
    log: () => undefined,
    gitLog: async () => [],
    observers: [sessionContextObserver(bus)],
  });
  running.push(ingester);
  return ingester;
}

const contextEvents = (text: string): SessionContextPayload[] =>
  parseSse(text)
    .filter((m) => m.event === 'context')
    .map((m) => m.data as SessionContextPayload);

/** A main-chain assistant message of the main fixture session whose usage sums to 300,015 tokens. */
const assistantLine = `${JSON.stringify({
  parentUuid: 'u-9',
  isSidechain: false,
  type: 'assistant',
  uuid: 'ctx-int-1',
  timestamp: '2026-11-02T02:30:00.000Z',
  sessionId: FIXTURE.main,
  cwd: '/home/u/mcp-notes',
  message: {
    id: 'msg_ctx_int_1',
    model: 'claude-opus-5-5',
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 10, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0, output_tokens: 5 },
  },
})}\n`;

beforeAll(async () => {
  h = await createApiHarness();
});

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await truncateAll(h.deps.db);
  home = await copyFixtureClaudeHome();
  bus = new SessionEvents();
  const deps: AppDeps = { ...h.deps, sessionEvents: bus };
  app = new Hono();
  app.route('/', sessionsApiRoutes(deps, { host: HOST, live: async () => [], commitLinks: async () => new Map(), contextDebounceMs: 20 }));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('GET /api/sessions/:nodeId/context/stream with real ingest', () => {
  it('sends the stored context on connect, then a new event once ingest commits a main-chain assistant append', async () => {
    const ingester = start();
    await ingester.ready;
    const res0 = await h.deps.db.execute<{ node_id: string }>(sql`select node_id from cc_sessions where session_id = ${FIXTURE.main}`);
    const nodeId = res0.rows[0]?.node_id;
    expect(nodeId).toBeDefined();

    const res = await app.request(`/api/sessions/${nodeId}/context/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1));
    expect(first[0]).toMatchObject({ node_id: nodeId, host: HOST, available: true });
    expect(first[0]?.context).not.toBeNull();
    expect(first[0]?.context?.tokens).not.toBe(300_015);
    await waitFor(() => bus.listenerCount() === 1);

    await appendFile(path.join(home, FIXTURE.mainFile), assistantLine);
    await ingester.sweep();
    const next = contextEvents(await readUntil(reader, (t) => contextEvents(t).length >= 1, 5000));
    expect(next[0]).toMatchObject({ node_id: nodeId, context: { tokens: 300_015, model: 'claude-opus-5-5' } });

    await reader.cancel();
    await waitFor(() => bus.listenerCount() === 0);
  });
});
