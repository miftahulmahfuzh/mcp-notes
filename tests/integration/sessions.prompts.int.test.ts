import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { ccSessionPrompts } from '../../src/db/schema.js';
import { startSessionIngest, type SessionIngester } from '../../src/sessions/ingest.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createRepoResolver } from '../../src/sessions/repoResolve.js';
import { PROMPTS_VERSION, PROMPTS_VERSION_EXCERPTS, type TranscriptPatch } from '../../src/sessions/types.js';
import { copyFixtureClaudeHome, FIXTURE, MANY_PROMPTS, manyPromptsText } from '../helpers/claudeHome.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

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

function patch(sessionId: string, over: Partial<TranscriptPatch> = {}): TranscriptPatch {
  return { sessionId, host: HOST, transcriptPath: `/nowhere/${sessionId}.jsonl`, fromOffset: 0, toOffset: 100, size: 100, ...over };
}

async function sideRows(sessionId: string) {
  return db.select().from(ccSessionPrompts).where(eq(ccSessionPrompts.sessionId, sessionId)).orderBy(asc(ccSessionPrompts.seq));
}

/** Rows anywhere holding the fake key: the side table plus every prompt column of cc_sessions. */
async function keyCount(): Promise<number> {
  const like = `%${KEY}%`;
  const res = await db.execute<{ n: string }>(sql`
    select (select count(*) from cc_session_prompts where text like ${like})
         + (select count(*) from cc_sessions where prompts::text like ${like} or first_prompt like ${like} or last_prompt like ${like}) as n`);
  return Number(res.rows[0]?.n ?? -1);
}

/** Every cc_sessions column the backfill must not change (Invariant 6). */
async function frozen(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const res = await db.execute<Record<string, unknown>>(sql`
    select node_id, host, repo, cwd, branch, name, custom_title, ai_title, entrypoint, version, started_at, last_active_at,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, models, parent_session_id,
           parent_link_source, tmux, transcript_path, transcript_offset, transcript_size, commits, files_edited, plan_docs,
           final_message, summary, summary_sha, summarized_at, summary_requested_at, created_at
    from cc_sessions where session_id = ${sessionId}`);
  return res.rows[0];
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

describe('ingest stores every prompt in full, redacted', () => {
  it('fills cc_session_prompts with all 106 prompts in order: the long one whole, the key redacted', async () => {
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 0 });
    const rows = await sideRows(MP);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: MANY_PROMPTS.count }, (_, i) => i + 1));
    expect(rows[0]?.at?.toISOString()).toBe('2026-10-20T01:01:00.000Z');
    const long = await manyPromptsText(MANY_PROMPTS.long);
    expect(long.length).toBeGreaterThan(2000);
    expect(rows[MANY_PROMPTS.long - 1]).toMatchObject({ text: long, truncated: false });
    const keyed = await manyPromptsText(MANY_PROMPTS.keyed);
    expect(keyed).toContain(KEY);
    expect(rows[MANY_PROMPTS.keyed - 1]?.text).toBe(keyed.replace(KEY, '[redacted]'));
    expect(await keyCount()).toBe(0);

    const row = await repo.getBySessionId(MP);
    expect(row?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(row?.prompts).toHaveLength(100);
    expect(row?.prompts.every((p) => p.text.length <= 2000)).toBe(true);
    expect(row?.prompts[0]?.text).toBe(await manyPromptsText(MANY_PROMPTS.count - 99));
    expect(row?.prompts.find((p) => p.text.startsWith(`fixture prompt ${MANY_PROMPTS.long}:`))?.text.endsWith('…')).toBe(true);
  });

  it('appends prompts typed later after the highest seq', async () => {
    const ingester = start();
    await ingester.ready;
    const user = (content: string, at: string) =>
      `${JSON.stringify({ type: 'user', sessionId: MP, entrypoint: 'cli', cwd: '/home/u/mcp-notes', timestamp: at, message: { role: 'user', content } })}\n`;
    await appendFile(path.join(home, FIXTURE.manyPromptsFile), user('one more', '2026-10-21T00:00:00.000Z') + user(`and ${KEY}`, '2026-10-21T00:01:00.000Z'));
    await ingester.sweep();
    const rows = await sideRows(MP);
    expect(rows).toHaveLength(MANY_PROMPTS.count + 2);
    expect(rows.slice(-2).map((r) => [r.seq, r.text])).toEqual([
      [MANY_PROMPTS.count + 1, 'one more'],
      [MANY_PROMPTS.count + 2, 'and [redacted]'],
    ]);
    expect((await repo.getBySessionId(MP))?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(await keyCount()).toBe(0);
  });
});

describe('SessionsRepo prompt rows', () => {
  it('a read from byte 0 replaces the rows; an append continues the seq', async () => {
    await repo.upsertFromTranscript(patch('s-1', { prompts: [{ text: 'a', at: null }, { text: 'b', at: null }, { text: 'c', at: '2026-11-01T10:00:00.000Z' }] }));
    await repo.upsertFromTranscript(patch('s-1', { fromOffset: 100, toOffset: 150, size: 150, prompts: [{ text: 'd', at: null, truncated: true }] }));
    expect((await sideRows('s-1')).map((r) => [r.seq, r.text, r.truncated])).toEqual([
      [1, 'a', false],
      [2, 'b', false],
      [3, 'c', false],
      [4, 'd', true],
    ]);
    await repo.upsertFromTranscript(patch('s-1', { toOffset: 160, size: 160, prompts: [{ text: 'x', at: null }] }));
    expect((await sideRows('s-1')).map((r) => [r.seq, r.text])).toEqual([[1, 'x']]);
  });

  it('an append to a version-0 row adds its prompts but leaves the version at 0', async () => {
    await repo.upsertFromTranscript(patch('s-2', { prompts: [{ text: 'a', at: null }] }));
    expect((await repo.getBySessionId('s-2'))?.promptsVersion).toBe(PROMPTS_VERSION);
    await db.execute(sql`update cc_sessions set prompts_version = 0 where session_id = 's-2'`);
    await repo.upsertFromTranscript(patch('s-2', { fromOffset: 100, toOffset: 120, size: 120, prompts: [{ text: 'b', at: null }] }));
    expect((await repo.getBySessionId('s-2'))?.promptsVersion).toBe(0);
    expect((await sideRows('s-2')).map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('replacePrompts is a compare-and-set on offset and host and writes only the prompt columns', async () => {
    await repo.upsertFromTranscript(patch('s-3', { tokens: { inputTokens: 7 }, prompts: [{ text: 'old', at: null }] }));
    const before = await frozen('s-3');
    const input = { upToOffset: 100, prompts: [{ text: `new ${KEY}`, at: null }], firstPrompt: 'new', lastPrompt: null };
    expect(await repo.replacePrompts('s-3', HOST, { ...input, upToOffset: 90 })).toEqual({ status: 'offset_mismatch', storedOffset: 100 });
    expect(await repo.replacePrompts('s-3', 'other-laptop', input)).toEqual({ status: 'other_host' });
    expect(await repo.replacePrompts('nope', HOST, input)).toEqual({ status: 'missing' });
    expect(await repo.replacePrompts('s-3', HOST, input)).toEqual({ status: 'applied' });
    expect(await frozen('s-3')).toEqual(before);
    expect((await sideRows('s-3')).map((r) => r.text)).toEqual(['new [redacted]']);
    expect(await repo.getBySessionId('s-3')).toMatchObject({ firstPrompt: 'new', prompts: [{ text: 'new [redacted]', at: null }], promptsVersion: PROMPTS_VERSION });
  });
});

describe('prompts backfill', () => {
  it('replaces legacy prompts with full redacted ones, changes nothing else, and a second run is a no-op', async () => {
    const first = start();
    await first.ready;
    await first.promptsBackfill;
    await first.close();
    // What a row written before this phase looks like: version 0, clipped unredacted excerpts, no side rows.
    const legacy = [{ text: `legacy ${KEY} clipped…`, at: null }];
    await db.execute(sql`update cc_sessions set prompts_version = 0, prompts = ${JSON.stringify(legacy)}::jsonb, last_prompt = ${`legacy ${KEY}`} where session_id = ${MP}`);
    await db.execute(sql`delete from cc_session_prompts where session_id = ${MP}`);
    await repo.setSummary(MP, { summary: 'a summary', sha: 'abc' });
    const before = await frozen(MP);
    expect(await keyCount()).toBe(1);

    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1, failed: 0 });
    expect(await frozen(MP)).toEqual(before);
    expect(await sideRows(MP)).toHaveLength(MANY_PROMPTS.count);
    expect(await keyCount()).toBe(0);
    const row = await repo.getBySessionId(MP);
    expect(row).toMatchObject({ promptsVersion: PROMPTS_VERSION, lastPrompt: await manyPromptsText(MANY_PROMPTS.count) });
    expect(row?.prompts).toHaveLength(100);
    await second.close();

    const third = start();
    await third.ready;
    expect(await third.promptsBackfill).toMatchObject({ candidates: 0 });
    expect((await repo.getBySessionId(MP))?.updatedAt.getTime()).toBe(row?.updatedAt.getTime());
  });

  it("leaves another host's rows untouched", async () => {
    await repo.ensureSession('other-host-session', 'other-laptop');
    await db.execute(sql`update cc_sessions set prompts = ${JSON.stringify([{ text: `raw ${KEY}`, at: null }])}::jsonb,
      transcript_path = ${path.join(home, FIXTURE.manyPromptsFile)}, transcript_offset = 10 where session_id = 'other-host-session'`);
    const before = await db.execute(sql`select * from cc_sessions where session_id = 'other-host-session'`);
    const ingester = start();
    await ingester.ready;
    await ingester.promptsBackfill;
    const after = await db.execute(sql`select * from cc_sessions where session_id = 'other-host-session'`);
    expect(after.rows).toEqual(before.rows);
    expect(await sideRows('other-host-session')).toEqual([]);
  });

  it('redacts the stored excerpts in place when the transcript is gone', async () => {
    const id = '5e55a001-0000-4000-8000-0000000000dd';
    await repo.ensureSession(id, HOST);
    const excerpts = [
      { text: 'old one', at: '2026-10-01T00:00:00.000Z' },
      { text: `deploy with ${KEY} and more…`, at: null },
    ];
    await db.execute(sql`update cc_sessions set prompts = ${JSON.stringify(excerpts)}::jsonb, first_prompt = 'old one',
      last_prompt = ${`use ${KEY}`}, transcript_offset = 500,
      transcript_path = ${path.join(home, `projects/-home-u-mcp-notes/${id}.jsonl`)} where session_id = ${id}`);
    const before = await frozen(id);
    const ingester = start();
    await ingester.ready;
    expect(await ingester.promptsBackfill).toMatchObject({ candidates: 1, redacted: 1 });
    expect(await frozen(id)).toEqual(before);
    expect(await repo.getBySessionId(id)).toMatchObject({
      promptsVersion: PROMPTS_VERSION_EXCERPTS,
      firstPrompt: 'old one',
      lastPrompt: 'use [redacted]',
      prompts: [
        { text: 'old one', at: '2026-10-01T00:00:00.000Z' },
        { text: 'deploy with [redacted] and more…', at: null },
      ],
    });
    expect((await sideRows(id)).map((r) => [r.seq, r.text, r.truncated, r.at?.toISOString() ?? null])).toEqual([
      [1, 'old one', false, '2026-10-01T00:00:00.000Z'],
      [2, 'deploy with [redacted] and more…', true, null],
    ]);
    expect(await keyCount()).toBe(0);
    const updatedAt = (await repo.getBySessionId(id))?.updatedAt.getTime();
    await ingester.close();

    // Still gone on the next start: listed again, skipped, nothing written.
    const again = start();
    await again.ready;
    expect(await again.promptsBackfill).toMatchObject({ candidates: 1, skipped: 1, redacted: 0 });
    expect((await repo.getBySessionId(id))?.updatedAt.getTime()).toBe(updatedAt);
  });

  it('upgrades a row redacted in place to full prompts once its transcript is readable', async () => {
    const first = start();
    await first.ready;
    await first.promptsBackfill;
    await first.close();
    await db.execute(sql`update cc_sessions set prompts_version = ${PROMPTS_VERSION_EXCERPTS} where session_id = ${MP}`);
    await db.execute(sql`delete from cc_session_prompts where session_id = ${MP} and seq > 3`);
    const second = start();
    await second.ready;
    expect(await second.promptsBackfill).toMatchObject({ candidates: 1, filled: 1 });
    expect((await repo.getBySessionId(MP))?.promptsVersion).toBe(PROMPTS_VERSION);
    expect(await sideRows(MP)).toHaveLength(MANY_PROMPTS.count);
  });
});
