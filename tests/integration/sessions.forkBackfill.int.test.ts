import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ccSessionPrompts } from '../../src/db/schema.js';
import { FORK_BACKFILL_VERSION, FORK_MARKER_PREFIX, startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { dbLinkStore } from '../../src/sessions/links.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { buildTranscriptPatch, parseRecord, readJsonlFrom, TranscriptAccumulator } from '../../src/sessions/transcript.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'test-host';
const P = '662d31f3-8b12-4345-b9d6-f6fd48caa493'; // DM-OV shape: the parent
const F = 'e3650501-2a9d-432a-b2c0-f2aeff23fdf8'; // JM-UJ shape: forked from P
const FF = 'aa11bb22-0000-4000-8000-0000000000ff'; // forked from F
const GONE = 'dead0000-0000-4000-8000-000000000001';
const P_DIR = '-home-u--worktrees-mcp-notes-dmov';
const F_DIR = '-home-u-claude-commands';
const P_CWD = '/home/u/.worktrees/mcp-notes/dmov';
const F_CWD = '/home/u/claude-commands';
const T0 = Date.parse('2026-11-11T01:00:00.000Z');
const ts = (min: number): string => new Date(T0 + min * 60_000).toISOString();

type Rec = Record<string, unknown>;
const jsonl = (records: readonly Rec[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');

let db: Db;
let repo: SessionsRepo;
let home: string;
const running: SessionIngester[] = [];

/** The parent's conversation up to the fork point: a prompt, commit d1b23dc, a reply. Same uuids in every copy. */
function chain(sessionId: string, cwd: string): Rec[] {
  const env = { sessionId, cwd, entrypoint: 'cli', version: '2.1.0' };
  return [
    { ...env, type: 'user', uuid: 'c-1', parentUuid: null, timestamp: ts(0), message: { role: 'user', content: 'build the shared feature' } },
    {
      ...env,
      type: 'assistant',
      uuid: 'c-2',
      parentUuid: 'c-1',
      timestamp: ts(1),
      message: {
        id: 'msg-c2',
        model: 'claude-opus-4-5',
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'tool_use', id: 'tool-commit', name: 'Bash', input: { command: 'git commit -m "feat: shared work"' } }],
      },
    },
    {
      ...env,
      type: 'user',
      uuid: 'c-3',
      parentUuid: 'c-2',
      timestamp: ts(2),
      toolUseResult: { stdout: '[main d1b23dc] feat: shared work' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-commit', content: '[main d1b23dc] feat: shared work' }] },
    },
    {
      ...env,
      type: 'assistant',
      uuid: 'c-4',
      parentUuid: 'c-3',
      timestamp: ts(3),
      message: { id: 'msg-c4', model: 'claude-opus-4-5', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Committed d1b23dc.' }] },
    },
  ];
}

/** What a session adds after the fork point: one prompt and a reply worth 7 + 3 tokens. */
function own(sessionId: string, cwd: string, tag: string, min: number, parentUuid: string | null): Rec[] {
  const env = { sessionId, cwd, entrypoint: 'cli', version: '2.1.0' };
  return [
    { ...env, type: 'user', uuid: `${tag}-1`, parentUuid, timestamp: ts(min), message: { role: 'user', content: `${tag} own question` } },
    {
      ...env,
      type: 'assistant',
      uuid: `${tag}-2`,
      parentUuid: `${tag}-1`,
      timestamp: ts(min + 1),
      message: { id: `msg-${tag}`, model: 'claude-opus-4-5', role: 'assistant', usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'text', text: `${tag} answer` }] },
    },
  ];
}

/** Claude Code writes these for the new session before the copy: no uuid, so always the fork's own. */
function forkHeader(sessionId: string): Rec[] {
  return [
    { type: 'ai-title', sessionId, aiTitle: 'fork' },
    { type: 'agent-name', sessionId, agentName: 'impl ⑂' },
  ];
}

async function writeTranscript(dir: string, sessionId: string, records: readonly Rec[]): Promise<string> {
  const file = path.join(home, 'projects', dir, `${sessionId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, jsonl(records));
  return file;
}

/** The background-job record Claude Code keeps for fork F (measured shape, analysis "Measured"). */
async function writeJob(): Promise<void> {
  const dir = path.join(home, 'jobs', F.slice(0, 8));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'state.json'),
    JSON.stringify({
      jobId: F.slice(0, 8),
      sessionId: F,
      forkSessionId: F,
      forkParentSessionId: P,
      forkBoundaryAt: ts(3),
      backend: 'daemon',
      name: 'impl ⑂',
      intent: '(forked)',
      state: 'running',
    }),
  );
  await writeFile(path.join(dir, 'parent-transcript.jsonl'), jsonl(chain(P, P_CWD)));
}

/** The row the ingester wrote before fork handling: every record counted, no head uuid, no fork link. */
async function legacyRow(file: string, sessionId: string): Promise<void> {
  const acc = new TranscriptAccumulator(sessionId);
  const read = await readJsonlFrom(file, 0, (l) => {
    const r = parseRecord(l);
    if (r !== null) acc.add(r);
  });
  const delta = acc.delta();
  const patch = buildTranscriptPatch(delta, { host: HOST, transcriptPath: file, fromOffset: 0, toOffset: read.endOffset, size: read.size, repo: 'mcp-notes' });
  patch.commits = delta.commits;
  expect((await repo.upsertFromTranscript(patch)).applied).toBe(true);
  await db.execute(sql`
    update cc_sessions set head_uuid = null, fork_cut_offset = null, forked_at = null, fork_prompt_count = null,
      fork_detected_by = null, parent_session_id = null, parent_link_source = null
    where session_id = ${sessionId}`);
}

async function promptTexts(sessionId: string): Promise<string[]> {
  const rows = await db.select().from(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, sessionId)).orderBy(asc(ccSessionPrompts.seq));
  return rows.map((r) => r.text);
}

const marker = (): Promise<unknown> => repo.getSetting(`${FORK_MARKER_PREFIX}${HOST}`);

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

beforeAll(() => {
  db = openTestDb();
  repo = new SessionsRepo(db);
});

afterAll(async () => {
  await closeTestDb(db);
});

beforeEach(async () => {
  await truncateAll(db);
  home = await mkdtemp(path.join(tmpdir(), 'fork-backfill-'));
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('one-time fork backfill (R5.1)', () => {
  it('links a background fork ingested before fork handling to its parent, cuts the copy, and does nothing on the next start', async () => {
    const pFile = await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const copied = [...forkHeader(F), ...chain(F, F_CWD)];
    const cut = Buffer.byteLength(jsonl(copied));
    const fFile = await writeTranscript(F_DIR, F, [...copied, ...own(F, F_CWD, 'f', 20, 'c-4')]);
    await writeJob();
    await legacyRow(pFile, P);
    await legacyRow(fFile, F);
    expect((await repo.getBySessionId(F))?.commits.map((c) => c.sha)).toEqual(['d1b23dc']); // the bug, as stored today
    const pBefore = await repo.getBySessionId(P);

    const first = start();
    expect(await first.forkBackfill).toMatchObject({ ran: true, forks: 1, reingested: 1, missing: 0, deferred: 0, failed: 0 });
    const f = await repo.getBySessionId(F);
    expect(f).toMatchObject({ parentSessionId: P, parentLinkSource: 'fork', headUuid: 'c-1', forkCutOffset: cut, inputTokens: 7, outputTokens: 3, firstPrompt: 'f own question' });
    expect(f?.commits).toEqual([]);
    expect(f?.startedAt?.toISOString()).toBe(ts(20));
    expect(await promptTexts(F)).toEqual(['f own question']);
    const p = await repo.getBySessionId(P);
    expect(p).toMatchObject({ headUuid: 'c-1', parentSessionId: null, inputTokens: 117 });
    expect(p?.updatedAt).toEqual(pBefore?.updatedAt);
    expect(p?.commits.map((c) => c.sha)).toEqual(['d1b23dc']);
    expect(await marker()).toMatchObject({ version: FORK_BACKFILL_VERSION, forks: 1, reingested: 1 });
    await first.close();

    const second = start();
    expect(await second.forkBackfill).toMatchObject({ ran: false, forks: 0, reingested: 0 });
    expect((await repo.getBySessionId(F))?.updatedAt).toEqual(f?.updatedAt);
  });

  it('finds a fork made without a job by its shared head uuid, and links a fork of a fork to the fork', async () => {
    const pFile = await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const fFile = await writeTranscript(F_DIR, F, [...forkHeader(F), ...chain(F, F_CWD), ...own(F, F_CWD, 'f', 20, 'c-4')]);
    const ffCopied = [...forkHeader(FF), ...chain(FF, F_CWD), ...own(FF, F_CWD, 'f', 20, 'c-4')];
    const ffCut = Buffer.byteLength(jsonl(ffCopied));
    const ffFile = await writeTranscript(F_DIR, FF, [...ffCopied, ...own(FF, F_CWD, 'ff', 30, 'f-2')]);
    await legacyRow(pFile, P);
    await legacyRow(fFile, F);
    await legacyRow(ffFile, FF);

    expect(await start().forkBackfill).toMatchObject({ ran: true, forks: 2, reingested: 2, failed: 0 });
    expect(await repo.getBySessionId(F)).toMatchObject({ parentSessionId: P, parentLinkSource: 'fork', inputTokens: 7 });
    const ff = await repo.getBySessionId(FF);
    expect(ff).toMatchObject({ parentSessionId: F, parentLinkSource: 'fork', forkCutOffset: ffCut, inputTokens: 7, firstPrompt: 'ff own question' });
    expect(ff?.commits).toEqual([]);
    expect(await repo.getBySessionId(P)).toMatchObject({ parentSessionId: null, parentLinkSource: null });
  });
});

describe('one-time fork backfill: transcript gone (R5.2)', () => {
  it('skips a row whose transcript is gone without a write, still re-links the fork, and marks the backfill done', async () => {
    const goneFile = await writeTranscript(P_DIR, GONE, own(GONE, P_CWD, 'g', 5, null));
    await legacyRow(goneFile, GONE);
    await rm(goneFile);
    const pFile = await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const fFile = await writeTranscript(F_DIR, F, [...forkHeader(F), ...chain(F, F_CWD), ...own(F, F_CWD, 'f', 20, 'c-4')]);
    await writeJob();
    await legacyRow(pFile, P);
    await legacyRow(fFile, F);
    const before = await repo.getBySessionId(GONE);

    expect(await start().forkBackfill).toMatchObject({ ran: true, rows: 3, missing: 1, forks: 1, reingested: 1, deferred: 0, failed: 0 });
    expect(await repo.getBySessionId(GONE)).toEqual(before);
    expect(await repo.getBySessionId(F)).toMatchObject({ parentSessionId: P, parentLinkSource: 'fork' });
    expect(await marker()).toMatchObject({ version: FORK_BACKFILL_VERSION, missing: 1, reingested: 1 });
  });

  it('writes the marker even when the only row it reaches has no transcript', async () => {
    const goneFile = await writeTranscript(P_DIR, GONE, own(GONE, P_CWD, 'g', 5, null));
    await legacyRow(goneFile, GONE);
    await rm(goneFile);
    const before = await repo.getBySessionId(GONE);
    expect(await start().forkBackfill).toMatchObject({ ran: true, rows: 1, missing: 1, headsFilled: 0, forks: 0, failed: 0 });
    expect(await repo.getBySessionId(GONE)).toEqual(before);
    expect(await marker()).toMatchObject({ version: FORK_BACKFILL_VERSION, missing: 1 });
  });
});

describe('re-readers honour a stored fork cut (R2.2)', () => {
  it('the prompts backfill and the link store use fork_cut_offset', async () => {
    await writeTranscript(P_DIR, P, [...chain(P, P_CWD), ...own(P, P_CWD, 'p', 10, 'c-4')]);
    const copied = [...forkHeader(F), ...chain(F, F_CWD)];
    const cut = Buffer.byteLength(jsonl(copied));
    await writeTranscript(F_DIR, F, [...copied, ...own(F, F_CWD, 'f', 20, 'c-4')]);
    await writeJob();
    const first = start();
    await first.promptsBackfill; // live ingest (phase 2) linked F and stored its cut
    expect(await repo.getBySessionId(F)).toMatchObject({ parentLinkSource: 'fork', forkCutOffset: cut });
    await first.close();

    await db.execute(sql`update cc_sessions set prompts_version = 0 where session_id = ${F}`);
    const second = start();
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(await promptTexts(F)).toEqual(['f own question']);

    const refs = await dbLinkStore(db, repo).transcriptsOnHost(HOST);
    expect(refs.find((r) => r.sessionId === F)?.forkCutOffset).toBe(cut);
    expect(refs.find((r) => r.sessionId === P)?.forkCutOffset).toBeNull();
  });
});
