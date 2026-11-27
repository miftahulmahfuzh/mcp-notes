import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSession } from '../../claude/hooks/notes-session.mjs';
import { SESSION_HOOK_START_PATH, sessionHookRoutes, type SessionHookStartReply } from '../../src/http/sessionHooks.js';
import { registerRemindTool, REMIND_TOOL_NAME } from '../../src/mcp/remindTool.js';
import { DAY_MS, REMINDER_REPEAT_MS, RemindersRepo } from '../../src/reminders/repo.js';
import { seedReminders } from '../../src/reminders/seeds.js';
import { startHarness, type Harness } from './imageHarness.js';
import { truncateAll } from './setup.js';

const T0 = new Date('2026-11-27T01:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const S1 = '11111111-1111-4111-8111-000000000001';
const S2 = '11111111-1111-4111-8111-000000000002';
const S3 = '11111111-1111-4111-8111-000000000003';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

beforeEach(async () => {
  await h.reset();
  await truncateAll(h.deps.db);
});

afterAll(async () => {
  await h.close();
});

function repoAt(clock: () => Date): RemindersRepo {
  return new RemindersRepo(h.deps.db, clock);
}

describe('RemindersRepo', () => {
  it('adds, lists the open ones soonest first, and marks one done once', async () => {
    const repo = repoAt(() => T0);
    const later = await repo.add({ body: 'later', dueAt: at(HOUR), repo: 'mcp-notes' });
    const sooner = await repo.add({ body: 'sooner', dueAt: at(-DAY_MS), repo: null });
    expect((await repo.listOpen()).map((r) => r.id)).toEqual([sooner.id, later.id]);
    const first = await repo.done(later.id);
    expect(first).toMatchObject({ changed: true, reminder: { id: later.id, done_at: T0.toISOString() } });
    expect((await repo.listOpen()).map((r) => r.id)).toEqual([sooner.id]);
    expect(await repo.done(later.id)).toMatchObject({ changed: false, reminder: { done_at: T0.toISOString() } });
    expect(await repo.done(999_999)).toBeNull();
  });

  it('dueFor shows a due, open reminder of the repo or of every repo, once per 20 hours', async () => {
    const repo = repoAt(() => T0);
    const mine = await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    const everywhere = await repo.add({ body: 'everywhere', dueAt: at(-2 * HOUR), repo: null });
    // Due exactly when the 20 hours of the two above end (the plan's fixture said one hour, which its own assertion
    // at 20 h - 1 ms contradicts: a due, open reminder never shown is shown).
    await repo.add({ body: 'future', dueAt: at(REMINDER_REPEAT_MS), repo: 'mcp-notes' });
    await repo.add({ body: 'elsewhere', dueAt: at(-HOUR), repo: 'seer' });
    const done = await repo.add({ body: 'done', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.done(done.id);

    expect(await repo.dueFor('mcp-notes', T0)).toEqual([
      { id: everywhere.id, body: 'everywhere', due_at: at(-2 * HOUR).toISOString() },
      { id: mine.id, body: 'mine', due_at: at(-HOUR).toISOString() },
    ]);
    expect(await repo.dueFor('mcp-notes', at(HOUR / 2))).toEqual([]);
    expect(await repo.dueFor('mcp-notes', at(REMINDER_REPEAT_MS - 1))).toEqual([]);
    const again = await repo.dueFor('mcp-notes', at(REMINDER_REPEAT_MS));
    expect(again.map((r) => r.body)).toEqual(['everywhere', 'mine', 'future']);
    const shown = await h.deps.db.execute<{ body: string; last_shown_at: Date }>(sql`select body, last_shown_at from reminders where last_shown_at is not null order by body`);
    expect(shown.rows.map((r) => r.body)).toEqual(['everywhere', 'future', 'mine']);
  });

  it('dueFor with no repository shows only the reminders for every repository', async () => {
    const repo = repoAt(() => T0);
    await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.add({ body: 'everywhere', dueAt: at(-HOUR), repo: null });
    expect((await repo.dueFor(null, T0)).map((r) => r.body)).toEqual(['everywhere']);
  });

  it('dueFor shows at most five, soonest first; the rest come at the next start', async () => {
    const repo = repoAt(() => T0);
    for (let i = 7; i >= 1; i -= 1) await repo.add({ body: `r${i}`, dueAt: at(-i * HOUR), repo: null });
    expect((await repo.dueFor(null, T0)).map((r) => r.body)).toEqual(['r7', 'r6', 'r5', 'r4', 'r3']);
    expect((await repo.dueFor(null, T0)).map((r) => r.body)).toEqual(['r2', 'r1']);
  });

  it('two starts at once never both show one reminder', async () => {
    const repo = repoAt(() => T0);
    await repo.add({ body: 'once', dueAt: at(-HOUR), repo: null });
    const [a, b] = await Promise.all([repo.dueFor(null, T0), repo.dueFor(null, T0)]);
    expect(a.length + b.length).toBe(1);
  });
});

describe('seedReminders', () => {
  it('stores the play-log reminder once, due seven days after the first start, and never moves or revives it', async () => {
    expect(await seedReminders(repoAt(() => T0))).toEqual(['play-log-ranking']);
    expect(await seedReminders(repoAt(() => at(3 * DAY_MS)))).toEqual([]);
    const rows = await h.deps.db.execute<{ repo: string; due_at: Date; body: string }>(sql`select repo, due_at, body from reminders where seed_key = 'play-log-ranking'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.repo).toBe('mcp-notes');
    expect(new Date(rows.rows[0]!.due_at).toISOString()).toBe(at(7 * DAY_MS).toISOString());
    expect(rows.rows[0]?.body).toContain('proposal item 3');

    const repo = repoAt(() => at(8 * DAY_MS));
    const [seeded] = await repo.listOpen();
    await repo.done(seeded!.id);
    expect(await seedReminders(repoAt(() => at(9 * DAY_MS)))).toEqual([]);
    expect(await repo.listOpen()).toEqual([]);
  });

  it('a seed is not due in its first week, so a fresh start then shows nothing', async () => {
    await seedReminders(repoAt(() => T0));
    expect(await repoAt(() => T0).dueFor('mcp-notes', at(7 * DAY_MS - 1))).toEqual([]);
    expect((await repoAt(() => T0).dueFor('mcp-notes', at(7 * DAY_MS))).map((r) => r.body)).toHaveLength(1);
  });
});

describe('POST /api/sessions/hook/start reminders', () => {
  let clock = T0;
  let repoKey: () => Promise<string | null> = async () => 'mcp-notes';
  const app = () => new Hono().route('/', sessionHookRoutes(h.deps, { now: () => clock.getTime(), repoOf: () => repoKey(), repoBudgetMs: 200, hostname: () => 'test-host' }));

  async function start(session: string, source: string, cwd = '/home/u/mcp-notes'): Promise<SessionHookStartReply> {
    const res = await app().request(`http://127.0.0.1${SESSION_HOOK_START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify({ session, cwd, source, host: 'test-host' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as SessionHookStartReply;
  }

  beforeEach(() => {
    clock = T0;
    repoKey = async () => 'mcp-notes';
  });

  it('a fresh start answers the due reminders; resume, compact and a second start within 20 h answer none', async () => {
    const repo = repoAt(() => T0);
    const mine = await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.add({ body: 'elsewhere', dueAt: at(-HOUR), repo: 'seer' });
    await seedReminders(repo);

    expect((await start(S1, 'resume')).reminders).toEqual([]);
    expect((await start(S1, 'startup')).reminders).toEqual([{ id: mine.id, body: 'mine', due_at: at(-HOUR).toISOString() }]);
    expect((await start(S1, 'compact')).reminders).toEqual([]);
    expect((await start(S2, 'startup')).reminders).toEqual([]);
    clock = at(REMINDER_REPEAT_MS);
    expect((await start(S2, 'clear')).reminders.map((r) => r.id)).toEqual([mine.id]);
    clock = at(7 * DAY_MS - 1);
    expect((await start(S3, 'startup')).reminders.map((r) => r.body)).toEqual(['mine']);
    clock = at(7 * DAY_MS + REMINDER_REPEAT_MS);
    expect((await start(S1, 'startup')).reminders.map((r) => r.body)).toEqual(['mine', expect.stringContaining('proposal item 3')]);
  });

  it('a done reminder is never answered again', async () => {
    const repo = repoAt(() => T0);
    const r = await repo.add({ body: 'handled', dueAt: at(-HOUR), repo: null });
    await repo.done(r.id);
    clock = at(30 * DAY_MS);
    expect((await start(S1, 'startup')).reminders).toEqual([]);
  });

  it('a repository that does not resolve in time answers only the reminders for every repository', async () => {
    const repo = repoAt(() => T0);
    await repo.add({ body: 'mine', dueAt: at(-HOUR), repo: 'mcp-notes' });
    await repo.add({ body: 'everywhere', dueAt: at(-HOUR), repo: null });
    repoKey = () => new Promise(() => {});
    expect((await start(S1, 'startup')).reminders.map((r) => r.body)).toEqual(['everywhere']);
  });
});

describe('notes-session end to end against a listening daemon', () => {
  it('puts a due reminder in a fresh session\'s context once, and nothing in the next one', async () => {
    const base = await h.listen();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-reminders-int-'));
    try {
      const env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: new URL(base).port, CLAUDE_CODE_ENTRYPOINT: 'cli' };
      const r = await new RemindersRepo(h.deps.db).add({ body: 'the kettle is on', dueAt: new Date(Date.now() - 60_000), repo: null });
      const run = (session: string) =>
        runSession({ input: { session_id: session, cwd: tmp, source: 'startup' }, env, readText: async () => { throw new Error('ENOENT'); }, runTmux: async () => '', ppid: 1, hostname: () => 'test-host' });
      const first = (await run(S1))!.hookSpecificOutput.additionalContext;
      expect(first).toContain(`- Reminder #${r.id} (due `);
      expect(first).toContain('the kettle is on');
      expect(first).toContain('`remind`');
      const second = (await run(S2))!.hookSpecificOutput.additionalContext;
      expect(second).not.toContain('Reminder #');
      expect(second).toMatch(/node [0-9A-Z]{2}-[0-9A-Z]{2}/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('the remind tool on a real database', () => {
  it('adds with a due time, lists the open ones, marks one done so it is never listed or shown again', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerRemindTool(server, { db: h.deps.db }, { now: () => T0 });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientSide);
    const call = async (args: Record<string, unknown>) => {
      const res = (await client.callTool({ name: REMIND_TOOL_NAME, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
      return { isError: res.isError === true, text: res.content.map((c) => c.text ?? '').join('') };
    };
    try {
      const added = JSON.parse((await call({ action: 'add', body: 'look again', in_days: 2, repo: 'mcp-notes' })).text);
      expect(added.reminder).toMatchObject({ body: 'look again', repo: 'mcp-notes', due_at: at(2 * DAY_MS).toISOString(), done_at: null });
      const listed = JSON.parse((await call({ action: 'list' })).text);
      expect(listed.reminders.map((r: { id: number }) => r.id)).toEqual([added.reminder.id]);
      const done = JSON.parse((await call({ action: 'done', id: `#${added.reminder.id}` })).text);
      expect(done).toMatchObject({ changed: true, reminder: { id: added.reminder.id, done_at: T0.toISOString() } });
      expect(JSON.parse((await call({ action: 'list' })).text).reminders).toEqual([]);
      expect(await repoAt(() => T0).dueFor('mcp-notes', at(30 * DAY_MS))).toEqual([]);
      const missing = await call({ action: 'done', id: 999999 });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('not_found');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
