import { readFileSync } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ccSessionReplies } from '../../src/db/schema.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { MAX_REPLY_STORE_CHARS, PROMPTS_VERSION, REPLIES_VERSION, type TranscriptPatch } from '../../src/sessions/types.js';
import { copyFixtureClaudeHome, FIXTURE, MANY_PROMPTS } from '../helpers/claudeHome.js';
import { MIGRATIONS_DIR, closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'test-host';
const KEY = MANY_PROMPTS.fakeKey;
const MP = FIXTURE.manyPrompts;

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
  });
  running.push(ingester);
  return ingester;
}

async function replies(sessionId: string) {
  return db
    .select({ seq: ccSessionReplies.seq, text: ccSessionReplies.text, at: ccSessionReplies.at, truncated: ccSessionReplies.truncated })
    .from(ccSessionReplies)
    .where(eq(ccSessionReplies.sessionId, sessionId))
    .orderBy(asc(ccSessionReplies.seq));
}

const pairs = async (sessionId: string) => (await replies(sessionId)).map((r) => [r.seq, r.text]);

let tick = 0;
/** One record of the main fixture session, timestamped after everything already in its file. */
function rec(r: Record<string, unknown>): string {
  tick += 1;
  return `${JSON.stringify({ sessionId: FIXTURE.main, cwd: '/home/u/mcp-notes', timestamp: new Date(Date.UTC(2026, 10, 2, 3, 0, tick)).toISOString(), ...r })}\n`;
}
const usage = { input_tokens: 1, output_tokens: 1 };
const human = (text: string): string => rec({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const say = (id: string, text: string, extra: Record<string, unknown> = {}): string =>
  rec({ type: 'assistant', ...extra, message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text }], usage } });
const toolUse = (id: string, toolId: string): string =>
  rec({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Read', input: { file_path: '/home/u/mcp-notes/README.md' } }], usage } });
const toolResult = (toolId: string): string =>
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] }, toolUseResult: { stdout: 'ok' } });

function patch(sessionId: string, over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return { sessionId, host: HOST, transcriptPath: `/nowhere/${sessionId}.jsonl`, fromOffset: 0, toOffset: 100, size: 100, ...over };
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
  home = await copyFixtureClaudeHome();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((i) => i.close()));
  await rm(home, { recursive: true, force: true });
});

describe('migration 0014 (cc_session_replies)', () => {
  it('is journal entry 14', () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find((e) => e.idx === 14)?.tag).toBe('0014_session_replies');
  });

  it('creates both tables with their keys and indexes', async () => {
    const res = await db.execute<{ indexname: string }>(
      sql`select indexname from pg_indexes where schemaname = 'public' and tablename in ('cc_session_replies', 'cc_session_reply_embeddings')`,
    );
    expect(res.rows.map((r) => r.indexname).sort()).toEqual(
      [
        'cc_session_replies_search_gin',
        'cc_session_replies_session_id_seq_pk',
        'cc_session_reply_embeddings_embedding_hnsw_idx',
        'cc_session_reply_embeddings_next_attempt_idx',
        'cc_session_reply_embeddings_session_id_seq_pk',
      ].sort(),
    );
  });

  it('defaults replies_version to 0, indexes reply words, and cascades deletes', async () => {
    await repo.ensureSession('s-1', HOST);
    expect((await repo.getBySessionId('s-1'))?.repliesVersion).toBe(0);
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'the zebrafish migration is done', at: null }] }));
    const hit = await db.execute<{ seq: number }>(
      sql`select seq from cc_session_replies where session_id = 's-1' and search_tsv @@ plainto_tsquery('simple', 'zebrafish')`,
    );
    expect(hit.rows.map((r) => Number(r.seq))).toEqual([1]);
    await db.execute(sql`insert into cc_session_reply_embeddings (session_id, seq, sha, model) values ('s-1', 1, 'sha', 'm')`);
    // The same reply re-read from byte 0 keeps its row, so its vector survives.
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'the zebrafish migration is done', at: null }] }));
    expect(Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_reply_embeddings`)).rows[0]?.n)).toBe(1);
    // A re-read without that reply deletes it, and its vector with it.
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }] }));
    expect(await replies('s-1')).toEqual([]);
    expect(Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_reply_embeddings`)).rows[0]?.n)).toBe(0);
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'back', at: null }] }));
    await db.execute(sql`delete from cc_sessions where session_id = 's-1'`);
    expect(await replies('s-1')).toEqual([]);
  });
});

describe('ingest stores Claude replies', () => {
  it('stores the final text of each turn of the fixtures, never the narration, and marks rows current', async () => {
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 0 });
    expect(await replies(FIXTURE.main)).toEqual([{ seq: 1, text: 'Done: the plan is written.', at: new Date('2026-11-02T02:23:10.000Z'), truncated: false }]);
    expect(await pairs(FIXTURE.worktreeChild)).toEqual([[1, 'Phase 1 implemented.']]);
    const many = await replies(MP);
    expect(many.map((r) => r.seq)).toEqual(Array.from({ length: MANY_PROMPTS.count }, (_, i) => i + 1));
    expect(many[0]).toMatchObject({ text: 'Done with step 1.', at: new Date('2026-10-20T01:01:30.000Z') });
    expect(many.at(-1)?.text).toBe(`Done with step ${MANY_PROMPTS.count}.`);
    const narration = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_replies where text like '%I will read the swarm code first%'`);
    expect(Number(narration.rows[0]?.n)).toBe(0);
    const versions = await db.execute<{ v: number }>(sql`select distinct replies_version as v from cc_sessions`);
    expect(versions.rows.map((r) => Number(r.v))).toEqual([REPLIES_VERSION]);
  });

  it('gives straddling reads and a restart mid-turn the rows a single read gives, redacted', async () => {
    const main = path.join(home, FIXTURE.mainFile);
    let ingester = start();
    await ingester.ready;
    await appendFile(main, human('why does resume break?') + say('msg_r1', 'Let me check the resume code.'));
    await ingester.sweep();
    expect(await pairs(FIXTURE.main)).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'Let me check the resume code.'],
    ]);
    // A restart mid-turn: the next ingester starts with no carry, and its first read opens with the tool call.
    await ingester.close();
    await appendFile(main, toolUse('msg_r2', 'tu_r1') + toolResult('tu_r1') + say('msg_r3', 'Resume breaks because the tmux target is stale.'));
    ingester = start();
    await ingester.ready;
    expect(await pairs(FIXTURE.main)).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'Resume breaks because the tmux target is stale.'],
    ]);
    // Text alone across the next boundary continues the stored reply.
    await appendFile(main, say('msg_r4', `Fix: re-read it on attach. ${KEY}`));
    await ingester.sweep();
    await appendFile(main, human('and the hook?') + toolUse('msg_r5', 'tu_r2') + toolResult('tu_r2'));
    await ingester.sweep();
    const incremental = await replies(FIXTURE.main);
    expect(incremental.map((r) => [r.seq, r.text])).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'Resume breaks because the tmux target is stale.\n\nFix: re-read it on attach. [redacted]'],
    ]);
    const leaked = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_replies where text like ${`%${KEY}%`}`);
    expect(Number(leaked.rows[0]?.n)).toBe(0);
    await ingester.close();
    await truncateAll(db);
    await start().ready;
    expect(await replies(FIXTURE.main)).toEqual(incremental);
  });

  it('caps a long reply and marks it truncated', async () => {
    const main = path.join(home, FIXTURE.mainFile);
    const ingester = start();
    await ingester.ready;
    await appendFile(main, human('write a lot') + say('msg_long', 'word '.repeat(MAX_REPLY_STORE_CHARS)));
    await ingester.sweep();
    const row = (await replies(FIXTURE.main)).find((r) => r.seq === 2);
    expect(row?.truncated).toBe(true);
    expect(row?.text.length).toBe(MAX_REPLY_STORE_CHARS);
  });

  it('never stores sidechain text as a reply', async () => {
    const main = path.join(home, FIXTURE.mainFile);
    const sub = path.join(home, `projects/-home-u-mcp-notes/${FIXTURE.main}/subagents/agent-a1.jsonl`);
    const ingester = start();
    await ingester.ready;
    await appendFile(main, human('ask the subagent') + say('msg_s1', 'sidechain chatter', { isSidechain: true }) + say('msg_s2', 'The subagent finished.'));
    await appendFile(sub, say('msg_s3', 'subagent says hi', { isSidechain: true }));
    await ingester.sweep();
    expect(await pairs(FIXTURE.main)).toEqual([
      [1, 'Done: the plan is written.'],
      [2, 'The subagent finished.'],
    ]);
    const side = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_replies where text like '%sidechain chatter%' or text like '%subagent says hi%'`);
    expect(Number(side.rows[0]?.n)).toBe(0);
  });
});

describe('replies backfill', () => {
  it('fills the replies of a row ingested before them, once', async () => {
    await start().ready;
    await db.execute(sql`update cc_sessions set replies_version = 0 where session_id = ${MP}`);
    await db.execute(sql`delete from cc_session_replies where session_id = ${MP}`);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(await replies(MP)).toHaveLength(MANY_PROMPTS.count);
    expect(await repo.getBySessionId(MP)).toMatchObject({ promptsVersion: PROMPTS_VERSION, repliesVersion: REPLIES_VERSION });
    const third = start();
    await third.ready;
    expect(await third.promptsBackfill).toMatchObject({ candidates: 0 });
  });

  it('keeps no replies for a pruned transcript and skips it without a write', async () => {
    const gone = path.join(home, 'projects/-home-u-mcp-notes/5e55a001-0000-4000-8000-0000000000aa.jsonl');
    const current = '5e55a001-0000-4000-8000-0000000000aa';
    await repo.upsertFromTranscript(patch(current, { transcriptPath: gone, toOffset: 50, size: 50, prompts: [{ text: 'q', at: null }] }));
    await db.execute(sql`update cc_sessions set replies_version = 0 where session_id = ${current}`);
    const legacy = '5e55a001-0000-4000-8000-0000000000ab';
    const legacyPath = path.join(home, `projects/-home-u-mcp-notes/${legacy}.jsonl`);
    await repo.upsertFromTranscript(patch(legacy, { transcriptPath: legacyPath, toOffset: 50, size: 50, prompts: [{ text: 'q', at: null }], replies: [{ prompt: 0, text: 'a', at: null }] }));
    await db.execute(sql`update cc_sessions set prompts_version = 0, replies_version = 0 where session_id = ${legacy}`);
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ skipped: 1, redacted: 1, filled: 0, failed: 0 });
    expect(await replies(current)).toEqual([]);
    expect(await replies(legacy)).toEqual([]);
    expect((await repo.getBySessionId(current))?.repliesVersion).toBe(0);
  });
});
