import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startBackground } from '../../src/background.js';
import { ChatService } from '../../src/chat/service.js';
import { DEFAULT_CHAT_CONFIG, DEFAULT_EMBEDDINGS_CONFIG, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { copyFixtureClaudeHome, FIXTURE } from '../helpers/claudeHome.js';
import { closeTestDb, openTestDb, testDatabaseUrl } from './setup.js';

const NODE_ID = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/;
const IDS = [FIXTURE.main, FIXTURE.worktreeChild, FIXTURE.sdkCli, FIXTURE.sdkTs];

let db: Db;
let repo: SessionsRepo;
let home: string;
const running: SessionIngester[] = [];

function start(): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: FIXTURE.worktreesDir,
    homeDir: FIXTURE.homeDir,
    store: repo,
    hostname: () => 'test-host',
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
  });
  running.push(ingester);
  return ingester;
}

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => {
  db = openTestDb();
  repo = new SessionsRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await db.execute(sql`delete from cc_sessions where session_id in (${sql.join(IDS.map((id) => sql`${id}`), sql`, `)})`);
  home = await copyFixtureClaudeHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('session ingest into cc_sessions', () => {
  it('backfills one row per cli session with a node id and a resolved repo', async () => {
    const report = await start().ready;
    expect(report).toMatchObject({ upserted: 2, failed: 0 });

    const main = await repo.getBySessionId(FIXTURE.main);
    expect(main?.nodeId).toMatch(NODE_ID);
    expect(main).toMatchObject({
      host: 'test-host',
      repo: 'mcp-notes',
      cwd: '/home/u/mcp-notes',
      branch: 'main',
      name: 'session-graph-discussion',
      customTitle: 'session-graph-discussion',
      aiTitle: 'Project session graph',
      firstPrompt: 'sketch the project-session-graph feature',
      entrypoint: 'cli',
      version: '2.1.311',
      inputTokens: 5,
      outputTokens: 914,
      costUsd: 1.25,
      transcriptPath: path.join(home, FIXTURE.mainFile),
      finalMessage: 'Done: the plan is written.',
      parentSessionId: null,
    });
    expect(main?.startedAt?.toISOString()).toBe('2026-11-02T02:12:57.806Z');
    expect(main?.commits.map((c) => c.sha)).toEqual(['abc1234']);
    expect(main?.planDocs).toHaveLength(2);

    const child = await repo.getBySessionId(FIXTURE.worktreeChild);
    expect(child).toMatchObject({ repo: 'mcp-notes', branch: 'feature/wall-editing', name: 'impl-wall-editing-p1' });
    expect(child?.nodeId).not.toBe(main?.nodeId);

    expect(await repo.getBySessionId(FIXTURE.sdkCli)).toBeNull();
    expect(await repo.getBySessionId(FIXTURE.sdkTs)).toBeNull();
  });

  it('tails appended bytes and resumes from stored offsets after a restart', async () => {
    const first = start();
    await first.ready;
    const before = await repo.getBySessionId(FIXTURE.worktreeChild);
    await appendFile(
      path.join(home, FIXTURE.worktreeFile),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-30T09:00:00.000Z',
        sessionId: FIXTURE.worktreeChild,
        message: { id: 'msg_Y', model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Second answer.' }], usage: { input_tokens: 1, output_tokens: 2 } },
      })}\n`,
    );
    await first.sweep();
    const after = await repo.getBySessionId(FIXTURE.worktreeChild);
    expect(after?.inputTokens).toBe((before?.inputTokens ?? 0) + 1);
    expect(after?.finalMessage).toBe('Second answer.');
    expect(after?.nodeId).toBe(before?.nodeId);
    await first.close();

    const second = start();
    const report = await second.ready;
    expect(report.upserted).toBe(0);
    expect((await repo.getBySessionId(FIXTURE.worktreeChild))?.updatedAt.getTime()).toBe(after?.updatedAt.getTime());
  });
});

describe('startBackground with sessions enabled', () => {
  it('ingests the configured Claude home and stops within the grace period', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'notes-bg-sessions-'));
    const config: Config = {
      databaseUrl: testDatabaseUrl(),
      port: 0,
      host: '127.0.0.1',
      dataDir,
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: DEFAULT_EMBEDDINGS_CONFIG,
      sessions: { claudeHome: home, worktreesDir: FIXTURE.worktreesDir, enabled: true },
    };
    const events = new NoteEvents();
    const deps: AppDeps = {
      config,
      db,
      events,
      service: new NotesService({ db, dataDir, events }),
      embedder: null,
      imageEmbedder: null,
      chat: new ChatService({ db }),
    };
    const stop = await startBackground(deps);
    try {
      await until(async () => (await repo.getBySessionId(FIXTURE.main)) !== null);
      const row = await repo.getBySessionId(FIXTURE.main);
      expect(row?.host).toBe(os.hostname());
      expect(row?.repo).toBe('mcp-notes');
    } finally {
      const t0 = Date.now();
      await stop();
      expect(Date.now() - t0).toBeLessThan(6_000);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
