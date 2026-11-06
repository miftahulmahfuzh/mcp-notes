import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startBackground } from '../../src/background.js';
import { ChatService } from '../../src/chat/service.js';
import { DEFAULT_ADVERSARY_CONFIG, DEFAULT_CHAT_CONFIG, DEFAULT_DWORD_CONFIG, type Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import type { AppDeps } from '../../src/deps.js';
import type { Embedder } from '../../src/embeddings/embedder.js';
import { bodySha256 } from '../../src/embeddings/state.js';
import type { EmbeddingWorker } from '../../src/embeddings/worker.js';
import { NoteEvents } from '../../src/notes/events.js';
import { NotesService } from '../../src/notes/service.js';
import {
  currentReplySha256Sql,
  dbReplyEmbeddingStore,
  isCurrentReplyEmbeddingSql,
  startReplyEmbeddingWorker,
} from '../../src/sessions/replyEmbeddings.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { PROMPTS_VERSION, REPLIES_VERSION } from '../../src/sessions/types.js';
import { createFakeEmbedder, type FakeEmbedder } from '../helpers/fakeEmbedder.js';
import { OTHER_HOST, THIS_HOST, seedSession } from './helpers/sessionsSeed.js';
import { closeTestDb, openTestDb, testDatabaseUrl, truncateAll } from './setup.js';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

// A type alias, not an interface: db.execute<T> needs T assignable to Record<string, unknown>.
type ReplyEmbRow = {
  sha: string;
  model: string;
  has_vector: boolean;
  attempts: number;
  last_error: string | null;
  due: boolean;
  current: boolean;
};

let db: Db;
let dataDir: string;
let worker: EmbeddingWorker | null = null;

async function seedReply(sessionId: string, seq: number, text: string): Promise<void> {
  await db.execute(sql`
    insert into cc_session_prompts (session_id, seq, at, text, truncated)
    values (${sessionId}, ${seq}::integer, now(), ${`prompt ${seq}`}, false)
    on conflict do nothing`);
  await db.execute(sql`
    insert into cc_session_replies (session_id, seq, at, text, truncated)
    values (${sessionId}, ${seq}::integer, now(), ${text}, false)`);
}

/**
 * Marks a seeded row as a live ingest leaves it. Otherwise the daemon's prompts backfill takes a
 * row of this host below PROMPTS_VERSION whose transcript is missing for a pruned one and deletes
 * its replies before the worker sees them.
 */
async function markIngested(sessionId: string): Promise<void> {
  await db.execute(sql`
    update cc_sessions set prompts_version = ${PROMPTS_VERSION}::integer, replies_version = ${REPLIES_VERSION}::integer
    where session_id = ${sessionId}`);
}

async function setReplyText(sessionId: string, seq: number, text: string): Promise<void> {
  await db.execute(sql`update cc_session_replies set text = ${text} where session_id = ${sessionId} and seq = ${seq}::integer`);
}

async function embRow(sessionId: string, seq: number, model: string): Promise<ReplyEmbRow | null> {
  const res = await db.execute<ReplyEmbRow>(sql`
    select cc_session_reply_embeddings.sha, cc_session_reply_embeddings.model,
           cc_session_reply_embeddings.embedding is not null as has_vector,
           cc_session_reply_embeddings.attempts, cc_session_reply_embeddings.last_error,
           (cc_session_reply_embeddings.next_attempt_at is null or cc_session_reply_embeddings.next_attempt_at <= now()) as due,
           coalesce(${isCurrentReplyEmbeddingSql(model)}, false) as current
    from cc_session_reply_embeddings
    join cc_session_replies
      on cc_session_replies.session_id = cc_session_reply_embeddings.session_id
     and cc_session_replies.seq = cc_session_reply_embeddings.seq
    where cc_session_reply_embeddings.session_id = ${sessionId}
      and cc_session_reply_embeddings.seq = ${seq}::integer`);
  return res.rows[0] ?? null;
}

function rig(embedder: FakeEmbedder = createFakeEmbedder()): { embedder: FakeEmbedder; logs: string[]; w: EmbeddingWorker } {
  const logs: string[] = [];
  const w = startReplyEmbeddingWorker({
    store: dbReplyEmbeddingStore(db, new SessionsRepo(db), THIS_HOST),
    embedder,
    minIntervalMs: 0,
    debounceMs: 0,
    sweepMs: 3_600_000,
    log: (line) => logs.push(line),
  });
  worker = w;
  return { embedder, logs, w };
}

async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  db = openTestDb();
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-replyemb-'));
});

afterAll(async () => {
  await closeTestDb(db);
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll(db);
});

afterEach(async () => {
  await worker?.close();
  worker = null;
});

describe('reply embedding worker against Postgres', () => {
  it('embeds every non-blank reply of this host, keyed by sha256 of its text and the model', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST, lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedSession(db, { sessionId: S2, nodeId: 'B1-4H', host: OTHER_HOST, lastActiveAt: '2026-11-02T00:00:00Z' });
    await seedReply(S1, 0, 'the arango password lives in the vault');
    await seedReply(S1, 1, 'login broke after the laptop slept; resume fixed it');
    await seedReply(S1, 2, '   \n ');
    await seedReply(S2, 0, 'reply owned by the other machine');

    const { embedder, w } = rig();
    await w.idle();

    for (const [seq, text] of [
      [0, 'the arango password lives in the vault'],
      [1, 'login broke after the laptop slept; resume fixed it'],
    ] as const) {
      expect(await embRow(S1, seq, embedder.model)).toMatchObject({
        sha: bodySha256(text),
        model: embedder.model,
        has_vector: true,
        attempts: 0,
        last_error: null,
        current: true,
      });
    }
    expect(await embRow(S1, 2, embedder.model)).toBeNull();
    expect(await embRow(S2, 0, embedder.model)).toBeNull();
    expect(embedder.calls.flat().sort()).toEqual([
      'login broke after the laptop slept; resume fixed it',
      'the arango password lives in the vault',
    ]);

    // Nothing pending: another drain makes no call.
    const callsBefore = embedder.calls.length;
    w.kick();
    await w.idle();
    expect(embedder.calls.length).toBe(callsBefore);
  });

  it('an edited reply stops counting as current and is re-embedded under its new sha', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST, lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'first answer');
    const { embedder, w } = rig();
    await w.idle();
    expect((await embRow(S1, 0, embedder.model))?.current).toBe(true);

    await setReplyText(S1, 0, 'first answer, extended in a later read');
    // The phase-5 predicate already ignores the stale vector before the worker catches up.
    expect((await embRow(S1, 0, embedder.model))?.current).toBe(false);

    w.kick();
    await w.idle();
    expect(await embRow(S1, 0, embedder.model)).toMatchObject({
      sha: bodySha256('first answer, extended in a later read'),
      current: true,
    });
  });

  it('a failing embedder never throws; the reply backs off and is retried once due', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST, lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'the deploy failed on resume');
    const embedder = createFakeEmbedder();
    embedder.failWhen(() => true);
    const { logs, w } = rig(embedder);
    await w.idle();

    expect(await embRow(S1, 0, embedder.model)).toMatchObject({ has_vector: false, attempts: 1, due: false, current: false });
    expect((await embRow(S1, 0, embedder.model))?.last_error).not.toBeNull();
    expect(logs.some((l) => l.startsWith('[notesd] reply embeddings: 0/1 embedded, 1 failed'))).toBe(true);

    // Not due yet: a drain makes no new call.
    const callsAfterFailure = embedder.calls.length;
    w.kick();
    await w.idle();
    expect(embedder.calls.length).toBe(callsAfterFailure);

    embedder.failWhen(null);
    await db.execute(sql`update cc_session_reply_embeddings set next_attempt_at = now() - interval '1 second'`);
    w.kick();
    await w.idle();
    expect(await embRow(S1, 0, embedder.model)).toMatchObject({ has_vector: true, attempts: 0, last_error: null, current: true });
  });

  it('a second failure for the same text doubles the backoff counter', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST });
    await seedReply(S1, 0, 'flaky reply');
    const repo = new SessionsRepo(db);
    const sha = bodySha256('flaky reply');
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha, model: 'm', error: 'Bearer sk-or-abc123 timed out' });
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha, model: 'm', error: 'timed out again' });
    const row = await embRow(S1, 0, 'm');
    expect(row).toMatchObject({ attempts: 2, has_vector: false });
    expect(row?.last_error).toBe('timed out again');

    await repo.recordReplyEmbeddingFailure(S1, 0, { sha, model: 'other-model', error: 'Bearer sk-or-abc123 boom' });
    const reset = await embRow(S1, 0, 'other-model');
    expect(reset?.attempts).toBe(1);
    expect(reset?.last_error).not.toContain('sk-or-abc123');
  });

  it('saveReplyEmbedding drops a vector made from text that has since changed, and a failure never clobbers a current vector', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST });
    await seedReply(S1, 0, 'old text');
    const repo = new SessionsRepo(db);
    const fake = createFakeEmbedder();
    const oldSha = bodySha256('old text');

    await setReplyText(S1, 0, 'new text');
    expect(await repo.saveReplyEmbedding(S1, 0, { sha: oldSha, model: fake.model, embedding: fake.vectorFor('old text') })).toBe(false);
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha: oldSha, model: fake.model, error: 'late failure' });
    expect(await embRow(S1, 0, fake.model)).toBeNull();

    const newSha = bodySha256('new text');
    expect(await repo.saveReplyEmbedding(S1, 0, { sha: newSha, model: fake.model, embedding: fake.vectorFor('new text') })).toBe(true);
    await repo.recordReplyEmbeddingFailure(S1, 0, { sha: newSha, model: fake.model, error: 'the other daemon failed' });
    expect(await embRow(S1, 0, fake.model)).toMatchObject({ has_vector: true, attempts: 0, current: true });
  });

  it('the SQL sha twin equals bodySha256 for non-ASCII text', async () => {
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: THIS_HOST });
    const text = 'café — 日本語 🚀 [redacted]';
    await seedReply(S1, 0, text);
    const res = await db.execute<{ sha: string }>(sql`
      select ${currentReplySha256Sql()} as sha from cc_session_replies where cc_session_replies.session_id = ${S1}`);
    expect(res.rows[0]?.sha).toBe(bodySha256(text));
  });
});

describe('startBackground and the reply embedding worker', () => {
  function deps(embedder: Embedder | null, claudeHome: string): AppDeps {
    const events = new NoteEvents();
    const config: Config = {
      databaseUrl: testDatabaseUrl(),
      port: 0,
      host: '127.0.0.1',
      dataDir,
      chat: DEFAULT_CHAT_CONFIG,
      embeddings: { apiKey: null },
      sessions: { claudeHome, worktreesDir: claudeHome, enabled: true, swarmScript: null },
      adversary: DEFAULT_ADVERSARY_CONFIG,
      dword: DEFAULT_DWORD_CONFIG,
    };
    return {
      config,
      db,
      events,
      service: new NotesService({ db, dataDir, events }),
      embedder,
      imageEmbedder: null,
      chat: new ChatService({ db }),
      adversary: null,
    };
  }

  async function emptyClaudeHome(): Promise<string> {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mcp-notes-replyemb-home-'));
    await mkdir(path.join(home, 'projects'), { recursive: true });
    return home;
  }

  it('embeds this host\'s replies when an embedder is configured and stops on shutdown', async () => {
    const home = await emptyClaudeHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: os.hostname(), lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'reply embedded by the daemon path');
    await markIngested(S1);
    const embedder = createFakeEmbedder();
    const stop = await startBackground(deps(embedder, home));
    try {
      await until(async () => (await embRow(S1, 0, embedder.model))?.current === true);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(`[notesd] embedding session replies with ${embedder.model}`);
    } finally {
      await stop();
      log.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('without an embedder it logs once and writes no reply vector', async () => {
    const home = await emptyClaudeHome();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedSession(db, { sessionId: S1, nodeId: 'A0-3G', host: os.hostname(), lastActiveAt: '2026-11-01T00:00:00Z' });
    await seedReply(S1, 0, 'no key, no vector');
    await markIngested(S1);
    const stop = await startBackground(deps(null, home));
    try {
      await new Promise((r) => setTimeout(r, 300));
      const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from cc_session_reply_embeddings`);
      expect(count.rows[0]?.n).toBe(0);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.includes('session reply vectors off'))).toHaveLength(1);
    } finally {
      await stop();
      log.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });
});
