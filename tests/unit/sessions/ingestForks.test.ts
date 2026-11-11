import { appendFile, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSessionIngest, type IngestBatch, type SessionIngester, type SessionIngestOptions } from '../../../src/sessions/ingest.js';
import { createRepoResolver } from '../../../src/sessions/repoResolve.js';
import type { SessionRow } from '../../../src/sessions/types.js';
import {
  appendPendingOwn,
  emptyClaudeHome,
  fixtureTranscript,
  FORK_BOUNDARY,
  forkTranscript,
  FORKS,
  offsetOfUuid,
  OWN_UUID,
  PARENT_HEAD_UUID,
  stageForks,
} from '../../helpers/forkFixtures.js';
import { MemoryIngestStore } from '../../helpers/memoryIngestStore.js';

const HOST = 'test-host';
const PLAN = '/home/u/mcp-notes/docs/plans/fork-plan.md';
let home: string;
let store: MemoryIngestStore;
let logs: string[];
const running: SessionIngester[] = [];

function start(over: Partial<SessionIngestOptions> = {}): SessionIngester {
  const ingester = startSessionIngest({
    claudeHome: home,
    worktreesDir: '/home/u/.worktrees',
    homeDir: '/home/u',
    store,
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
    log: (line) => logs.push(line),
    gitLog: async () => [],
    ...over,
  });
  running.push(ingester);
  return ingester;
}

/** The parent alone first, so it has a row and a head uuid before any fork is read. */
async function startWithParent(over: Partial<SessionIngestOptions> = {}): Promise<SessionIngester> {
  await stageForks(home, FORKS.parent);
  const ingester = start(over);
  await ingester.ready;
  return ingester;
}

function row(sessionId: string): SessionRow {
  const r = store.rows.get(sessionId);
  if (r === undefined) throw new Error(`no row ${sessionId}`);
  return r;
}
const shas = (r: SessionRow): string[] => r.commits.map((c) => c.sha);
const promptTexts = (r: SessionRow): string[] => r.prompts.map((p) => p.text);
const replyTexts = (sessionId: string): string[] => [...(store.sideReplies.get(sessionId)?.values() ?? [])].map((r) => r.text);
const uuidsOf = (b: IngestBatch): string[] => b.records.flatMap((r) => (typeof r.uuid === 'string' ? [r.uuid] : []));

function expectParentUntouched(): void {
  const p = row(FORKS.parent);
  expect(p).toMatchObject({
    parentSessionId: null,
    forkDetectedBy: null,
    forkCutOffset: null,
    headUuid: PARENT_HEAD_UUID,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 3000,
    cacheWriteTokens: 50,
    filesEdited: [PLAN],
    planDocs: [PLAN],
  });
  expect(shas(p)).toEqual(['a1b2c3d']);
  expect(promptTexts(p)).toHaveLength(3);
}

beforeEach(async () => {
  home = await emptyClaudeHome();
  store = new MemoryIngestStore();
  logs = [];
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('ingest: background-job forks', () => {
  it('links the fork to the parent its job state names, with source fork, and counts only its own records', async () => {
    const batches: IngestBatch[] = [];
    const ingester = await startWithParent({ observers: [{ onBatch: (b) => batches.push(b) }] });
    await stageForks(home, FORKS.job);
    expect((await ingester.sweep()).failed).toBe(0);

    const job = row(FORKS.job);
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
      name: 'fork-parent ⑂',
      cwd: '/home/u/mcp-notes',
      entrypoint: 'cli',
    });
    expect(Object.keys(job.models)).toEqual(['claude-opus-5-5']);
    expect(job.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.job), OWN_UUID.job));
    expect(shas(job)).toEqual(['0d0e0f1']);
    expect(promptTexts(job)).toEqual(['job fork prompt: try the other approach']);
    expect(replyTexts(FORKS.job)).toEqual(['Job fork reply.']);

    const batch = batches.find((b) => b.sessionId === FORKS.job);
    if (batch === undefined) throw new Error('no batch for the job fork');
    expect(uuidsOf(batch).filter((u) => u.startsWith('a1'))).toEqual([]);
    expect(uuidsOf(batch)).toContain(OWN_UUID.job);
    expectParentUntouched();
  });

  it('replaces an env link the SessionStart hook wrote first', async () => {
    store.seedRow(FORKS.job, HOST, { parentSessionId: FORKS.unrelated, parentLinkSource: 'env' });
    const ingester = await startWithParent();
    await stageForks(home, FORKS.job);
    await ingester.sweep();
    expect(row(FORKS.job)).toMatchObject({ parentSessionId: FORKS.parent, parentLinkSource: 'fork' });
  });
});

describe('ingest: forks without a job record', () => {
  it('links a terminal fork to the session it shares the copied prefix with', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.terminal);
    expect((await ingester.sweep()).failed).toBe(0);
    const t = row(FORKS.terminal);
    expect(t).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkedAt: FORK_BOUNDARY,
      forkPromptCount: 2,
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      filesEdited: [],
      planDocs: [],
      firstPrompt: 'terminal fork prompt: compare the two',
      startedAt: new Date('2026-11-01T01:30:00.000Z'),
    });
    expect(shas(t)).toEqual([]);
    expect(t.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.terminal), OWN_UUID.terminal));
    expectParentUntouched();
  });

  it('links a fork of a fork to the fork it was copied from, not to the original', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.job, FORKS.terminal, FORKS.pending);
    await ingester.sweep();
    await stageForks(home, FORKS.forkOfFork);
    expect((await ingester.sweep()).failed).toBe(0);
    const ff = row(FORKS.forkOfFork);
    expect(ff).toMatchObject({
      parentSessionId: FORKS.terminal,
      parentLinkSource: 'fork',
      forkDetectedBy: 'uuid',
      forkedAt: new Date('2026-11-01T01:30:05.000Z'),
      forkPromptCount: 3,
      inputTokens: 7,
      outputTokens: 7,
      firstPrompt: 'fork of a fork prompt: go deeper',
    });
    expect(promptTexts(ff)).toEqual(['fork of a fork prompt: go deeper']);
    expect(ff.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.forkOfFork), OWN_UUID.forkOfFork));
  });

  it('never turns an original read again from byte 0 into a fork of its own fork', async () => {
    const first = await startWithParent();
    await stageForks(home, FORKS.terminal);
    await first.sweep();
    await first.close();
    store.rows.set(FORKS.parent, { ...row(FORKS.parent), transcriptOffset: 0 });
    await start().ready;
    expectParentUntouched();
    expect(row(FORKS.terminal)).toMatchObject({ parentSessionId: FORKS.parent, parentLinkSource: 'fork' });
  });
});

describe('ingest: a fork that holds only its copy', () => {
  it('reports zero, then counts its own records once they arrive', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.pending);
    expect((await ingester.sweep()).failed).toBe(0);
    const before = row(FORKS.pending);
    expect(before).toMatchObject({
      parentSessionId: FORKS.parent,
      parentLinkSource: 'fork',
      forkDetectedBy: 'job',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      prompts: [],
      commits: [],
      filesEdited: [],
      firstPrompt: null,
      finalMessage: null,
      startedAt: null,
    });
    expect(before.forkCutOffset).toBe(before.transcriptOffset);

    await appendPendingOwn(home);
    await ingester.sweep();
    const after = row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1, commits: [], firstPrompt: 'pending fork prompt: now it has its own work' });
    expect(promptTexts(after)).toEqual(['pending fork prompt: now it has its own work']);
    expect(after.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.pending), OWN_UUID.pending));
    expect(after.transcriptOffset).toBeGreaterThan(after.forkCutOffset ?? Number.POSITIVE_INFINITY);
  });

  it('a restart while the cut is pending still reads the fork from byte 0', async () => {
    const first = await startWithParent();
    await stageForks(home, FORKS.pending);
    await first.sweep();
    await first.close();
    await appendPendingOwn(home);
    await start().ready;
    const after = row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1 });
    expect(after.forkCutOffset).toBe(await offsetOfUuid(forkTranscript(home, FORKS.pending), OWN_UUID.pending));
  });

  it('a copy half written when first read is never counted', async () => {
    const ingester = await startWithParent();
    await stageForks(home, FORKS.pending);
    const all = (await readFile(fixtureTranscript(FORKS.pending), 'utf8')).split('\n').filter((l) => l !== '');
    // ai-title, agent-name, mode, then the parent's first prompt and its commit call: the rest of the copy comes later.
    await writeFile(forkTranscript(home, FORKS.pending), all.slice(0, 5).map((l) => `${l}\n`).join(''));
    await ingester.sweep();
    expect(row(FORKS.pending)).toMatchObject({ inputTokens: 0, commits: [], prompts: [] });

    await appendFile(forkTranscript(home, FORKS.pending), all.slice(5).map((l) => `${l}\n`).join(''));
    await appendPendingOwn(home);
    await ingester.sweep();
    const after = row(FORKS.pending);
    expect(after).toMatchObject({ inputTokens: 11, outputTokens: 1, cacheReadTokens: 0, commits: [], filesEdited: [] });
    expect(promptTexts(after)).toEqual(['pending fork prompt: now it has its own work']);
  });

  it('drops a start, first prompt and final message an uncut read had taken from the copy', async () => {
    store.seedRow(FORKS.pending, HOST, {
      startedAt: new Date('2026-11-01T01:00:00.000Z'),
      firstPrompt: 'parent prompt one: build the fork fixture',
      finalMessage: 'Parent reply two.',
    });
    const ingester = await startWithParent();
    await stageForks(home, FORKS.pending);
    await ingester.sweep();
    expect(row(FORKS.pending)).toMatchObject({ startedAt: null, firstPrompt: null, finalMessage: null, inputTokens: 0 });
  });
});

describe('ingest: fork source not determinable', () => {
  it("reads a session whose only candidate parent's transcript is gone as an ordinary unlinked node", async () => {
    const ingester = await startWithParent();
    await unlink(forkTranscript(home, FORKS.parent));
    await stageForks(home, FORKS.terminal);
    expect((await ingester.sweep()).failed).toBe(0);
    const t = row(FORKS.terminal);
    expect(t).toMatchObject({ parentSessionId: null, parentLinkSource: null, forkDetectedBy: null, forkCutOffset: null, headUuid: PARENT_HEAD_UUID });
    // Nothing could be cut: the copy counts, as before fork handling.
    expect(t).toMatchObject({ inputTokens: 650, outputTokens: 65, cacheReadTokens: 3000, cacheWriteTokens: 50 });
  });

  it('reads a session with an unreadable job record as an ordinary node, every record in its batch', async () => {
    const batches: IngestBatch[] = [];
    const ingester = await startWithParent({ observers: [{ onBatch: (b) => batches.push(b) }] });
    await stageForks(home, FORKS.unrelated);
    expect((await ingester.sweep()).failed).toBe(0);
    expect(row(FORKS.unrelated)).toMatchObject({ parentSessionId: null, forkDetectedBy: null, inputTokens: 9, outputTokens: 9 });
    const batch = batches.find((b) => b.sessionId === FORKS.unrelated);
    if (batch === undefined) throw new Error('no batch for the unrelated session');
    expect(uuidsOf(batch)).toEqual(['f6000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000002']);
  });
});
