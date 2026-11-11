import { rm, unlink } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import type { SessionRow } from '../../src/sessions/types.js';
import {
  appendPendingOwn,
  emptyClaudeHome,
  FORK_BOUNDARY,
  forkTranscript,
  FORKS,
  offsetOfUuid,
  OWN_UUID,
  PARENT_HEAD_UUID,
  stageForks,
} from '../helpers/forkFixtures.js';
import { closeTestDb, openTestDb } from './setup.js';

const HOST = 'test-host';
const IDS = Object.values(FORKS);
let db: Db;
let repo: SessionsRepo;
let home: string;
const running: SessionIngester[] = [];

function start(): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: '/home/u/.worktrees',
    homeDir: '/home/u',
    store: repo,
    hostname: () => HOST,
    resolver: createRepoResolver({
      homeDir: '/home/u',
      worktreesDir: '/home/u/.worktrees',
      isDirectory: async () => false,
      gitRoots: async () => null,
      listRepoNames: async () => ['mcp-notes'],
    }),
    watch: false,
    sweepMs: 0,
    log: () => undefined,
    gitLog: async () => [],
  });
  running.push(ingester);
  return ingester;
}

async function row(sessionId: string): Promise<SessionRow> {
  const r = await repo.getBySessionId(sessionId);
  if (r === null) throw new Error(`no row ${sessionId}`);
  return r;
}
const shas = (r: SessionRow): string[] => r.commits.map((c) => c.sha);

/** Parent first, then the job and terminal forks, then the fork of the terminal fork. */
async function ingestChain(): Promise<SessionIngester> {
  await stageForks(home, FORKS.parent);
  const ingester = start();
  await ingester.ready;
  await stageForks(home, FORKS.job, FORKS.terminal);
  expect((await ingester.sweep()).failed).toBe(0);
  await stageForks(home, FORKS.forkOfFork);
  expect((await ingester.sweep()).failed).toBe(0);
  return ingester;
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
  home = await emptyClaudeHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('fork ingest into cc_sessions', () => {
  it('links job, terminal and fork-of-fork forks with source fork and stores only their own records', async () => {
    // The SessionStart hook of a background fork may carry an unrelated CC_PARENT_SESSION.
    await repo.upsertFromHook({ sessionId: FORKS.job, host: HOST, parentSessionId: FORKS.unrelated });
    await ingestChain();

    const job = await row(FORKS.job);
    expect(job).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'job',
      forkedAt: FORK_BOUNDARY,
      forkPromptCount: 2,
      headUuid: PARENT_HEAD_UUID,
      inputTokens: 130,
      outputTokens: 13,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      filesEdited: [],
      planDocs: [],
      firstPrompt: 'job fork prompt: try the other approach',
      finalMessage: 'Job fork reply.',
      startedAt: new Date('2026-11-01T01:20:00.000Z'),
    });
    expect(shas(job)).toEqual(['0d0e0f1']);
    expect(Object.keys(job.models)).toEqual(['claude-opus-5-5']);
    expect(job.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.job), OWN_UUID.job));
    const prompts = await db.execute<{ text: string }>(sql`select text from cc_session_prompts where session_id = ${FORKS.job} order by seq`);
    expect(prompts.rows.map((r) => r.text)).toEqual(['job fork prompt: try the other approach']);
    const replies = await db.execute<{ text: string }>(sql`select text from cc_session_replies where session_id = ${FORKS.job} order by seq`);
    expect(replies.rows.map((r) => r.text)).toEqual(['Job fork reply.']);

    expect(await row(FORKS.terminal)).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkPromptCount: 2,
      inputTokens: 50,
      outputTokens: 5,
      commits: [],
    });
    expect(await row(FORKS.forkOfFork)).toMatchObject({
      parentSessionId: FORKS.terminal,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkPromptCount: 3,
      inputTokens: 7,
      outputTokens: 7,
    });

    const parent = await row(FORKS.parent);
    expect(parent).toMatchObject({ parentSessionId: null, forkDetectedBy: null, headUuid: PARENT_HEAD_UUID, inputTokens: 1000, outputTokens: 100 });
    expect(shas(parent)).toEqual(['a1b2c3d']);
  });

  it('offers as candidates only rows with the same head that are neither descendants nor newer', async () => {
    await ingestChain();
    // Every other fixture row descends from the parent.
    expect(await repo.forkCandidates(HOST, PARENT_HEAD_UUID, FORKS.parent)).toEqual([]);
    const forFf = await repo.forkCandidates(HOST, PARENT_HEAD_UUID, FORKS.forkOfFork);
    expect(forFf.map((c) => c.sessionId).sort()).toEqual([FORKS.parent, FORKS.job, FORKS.terminal].sort());
    expect(forFf.find((c) => c.sessionId === FORKS.terminal)?.forkDetectedBy).toBe('uuid');
    expect(forFf.find((c) => c.sessionId === FORKS.parent)?.forkDetectedBy).toBeNull();
    expect(await repo.forkCandidates('another-host', PARENT_HEAD_UUID, FORKS.forkOfFork)).toEqual([]);
  });

  it('keeps a fork that holds only its copy at zero, then counts its own records, across a restart', async () => {
    await stageForks(home, FORKS.parent);
    const first = start();
    await first.ready;
    await stageForks(home, FORKS.pending);
    await first.sweep();
    const before = await row(FORKS.pending);
    expect(before).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      inputTokens: 0,
      outputTokens: 0,
      prompts: [],
      commits: [],
      firstPrompt: null,
      startedAt: null,
    });
    expect(before.forkCutOffset).toBe(before.transcriptOffset);
    await first.close();

    await appendPendingOwn(home);
    await start().ready;
    const after = await row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1, firstPrompt: 'pending fork prompt: now it has its own work' });
    expect(after.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.pending), OWN_UUID.pending));
  });

  it("ingests a session whose candidate parent's transcript is gone as an ordinary unlinked node", async () => {
    await stageForks(home, FORKS.parent);
    const ingester = start();
    await ingester.ready;
    await unlink(forkTranscript(home, FORKS.parent));
    await stageForks(home, FORKS.terminal);
    expect((await ingester.sweep()).failed).toBe(0);
    expect(await row(FORKS.terminal)).toMatchObject({ parentSessionId: null, forkDetectedBy: null, inputTokens: 650, outputTokens: 65 });
  });
});
