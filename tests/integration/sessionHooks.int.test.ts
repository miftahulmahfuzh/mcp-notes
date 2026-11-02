import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runSession } from '../../claude/hooks/notes-session.mjs';
import { runSpawn } from '../../claude/hooks/notes-spawn.mjs';
import { SESSION_HOOK_SPAWN_PATH, SESSION_HOOK_START_PATH, type SessionHookStartReply } from '../../src/http/sessionHooks.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { startHarness, type Harness } from './imageHarness.js';
import { truncateAll } from './setup.js';

const NODE_ID = /^[0-9A-Z]{2}-[0-9A-Z]{2}$/;
const ORCH = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const HOST = 'test-host';
const CWD = '/home/u/.worktrees/mcp-notes/feat';

let h: Harness;
let repo: SessionsRepo;

beforeAll(async () => {
  h = await startHarness();
  repo = new SessionsRepo(h.deps.db);
});

beforeEach(async () => {
  await h.reset();
  await truncateAll(h.deps.db); // phase 1 extended it to the cc_* tables
});

afterAll(async () => {
  await h.close();
});

function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    h.app.request(`http://127.0.0.1${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function start(body: Record<string, unknown>): Promise<SessionHookStartReply> {
  const res = await post(SESSION_HOOK_START_PATH, { host: HOST, cwd: CWD, source: 'startup', ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as SessionHookStartReply;
}

async function spawn(body: Record<string, unknown>): Promise<void> {
  const res = await post(SESSION_HOOK_SPAWN_PATH, { host: HOST, cwd: CWD, ...body });
  expect(res.status).toBe(201);
}

describe('POST /api/sessions/hook/start', () => {
  it('creates the row with a node id and no parent', async () => {
    const reply = await start({ session: ORCH, name: 'orch-feat', tmux: 'main:@1.%1', started_at: '2026-11-02T03:00:00.000Z' });
    expect(reply.node_id).toMatch(NODE_ID);
    expect(reply).toMatchObject({ session_id: ORCH, parent_session_id: null, parent_node_id: null, parent_link_source: null, claimed: false });
    const row = await repo.getBySessionId(ORCH);
    expect(row?.nodeId).toBe(reply.node_id);
  });

  it('links an env parent and answers with the parent node id; a second start keeps the same ids', async () => {
    const parent = await start({ session: ORCH });
    const first = await start({ session: CHILD, parent: ORCH, tmux: 'main:@2.%2' });
    expect(first).toMatchObject({ parent_session_id: ORCH, parent_node_id: parent.node_id, parent_link_source: 'env' });
    const again = await start({ session: CHILD, parent: ORCH, tmux: 'main:@2.%2' });
    expect(again.node_id).toBe(first.node_id);
    expect(again.parent_link_source).toBe('env');
  });

  it('records an env parent that has no row yet, creating the parent row so both node ids are known', async () => {
    const reply = await start({ session: CHILD, parent: ORCH });
    expect(reply).toMatchObject({ parent_session_id: ORCH, parent_link_source: 'env' });
    expect(reply.parent_node_id).toMatch(NODE_ID);
    expect((await repo.getBySessionId(ORCH))?.nodeId).toBe(reply.parent_node_id);
  });

  it('prunes pending spawns older than a day when a new one is recorded', async () => {
    await spawn({ parent: ORCH });
    await h.deps.db.execute(sql`update cc_pending_spawns set created_at = now() - interval '25 hours'`);
    await spawn({ parent: ORCH });
    const left = await h.deps.db.execute<{ n: number }>(sql`select count(*)::int as n from cc_pending_spawns`);
    expect(left.rows[0]?.n).toBe(1);
  });

  it('resume and compact never set a parent', async () => {
    for (const source of ['resume', 'compact']) {
      const reply = await start({ session: CHILD, parent: ORCH, source });
      expect(reply.parent_session_id).toBeNull();
    }
  });

  it('claims a pending spawn once, within the window, as hook', async () => {
    await start({ session: ORCH });
    await spawn({ parent: ORCH, name: 'kid' });
    const child = await start({ session: CHILD, name: 'kid', tmux: 'main:@3.%3' });
    expect(child).toMatchObject({ parent_session_id: ORCH, parent_link_source: 'hook', claimed: true });
    const other = await start({ session: OTHER, name: 'kid', tmux: 'main:@4.%4' });
    expect(other).toMatchObject({ parent_session_id: null, claimed: false });
    const repeat = await start({ session: CHILD, name: 'kid', tmux: 'main:@3.%3' });
    expect(repeat).toMatchObject({ parent_link_source: 'hook', claimed: false });
  });

  it('does not claim an old spawn, a spawn elsewhere, without tmux, or on clear', async () => {
    await spawn({ parent: ORCH });
    await h.deps.db.execute(sql`update cc_pending_spawns set created_at = now() - interval '31 seconds'`);
    expect((await start({ session: CHILD, tmux: 'main:@3.%3' })).claimed).toBe(false);

    await spawn({ parent: ORCH, cwd: '/somewhere/else' });
    expect((await start({ session: OTHER, tmux: 'main:@4.%4' })).claimed).toBe(false);

    await spawn({ parent: ORCH });
    const noTmux = '44444444-4444-4444-8444-444444444444';
    expect((await start({ session: noTmux })).claimed).toBe(false);
    const cleared = '55555555-5555-4555-8555-555555555555';
    expect((await start({ session: cleared, tmux: 'main:@5.%5', source: 'clear' })).claimed).toBe(false);
    const fresh = '66666666-6666-4666-8666-666666666666';
    expect((await start({ session: fresh, tmux: 'main:@6.%6' })).claimed).toBe(true);
  });

  it('an env parent wins and leaves the pending spawn for its own child', async () => {
    await spawn({ parent: OTHER });
    const child = await start({ session: CHILD, parent: ORCH, tmux: 'main:@3.%3' });
    expect(child).toMatchObject({ parent_session_id: ORCH, parent_link_source: 'env', claimed: false });
    const kid = '77777777-7777-4777-8777-777777777777';
    expect(await start({ session: kid, tmux: 'main:@7.%7' })).toMatchObject({ parent_session_id: OTHER, claimed: true });
  });

  it('guards like the capture route and validates the body', async () => {
    expect((await post(SESSION_HOOK_START_PATH, { session: ORCH }, { 'x-notes-capture': '0' })).status).toBe(403);
    const foreign = await h.app.request(`http://notes.example${SESSION_HOOK_START_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notes-capture': '1' },
      body: JSON.stringify({ session: ORCH }),
    });
    expect(foreign.status).toBe(403);
    expect((await post(SESSION_HOOK_START_PATH, '{oops')).status).toBe(400);
    expect((await post(SESSION_HOOK_START_PATH, { session: 'x y' })).status).toBe(400);
    expect((await post(SESSION_HOOK_SPAWN_PATH, { parent: ORCH, cwd: 'relative' })).status).toBe(400);
  });
});

describe('hooks end to end against a listening daemon', () => {
  let tmp: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    const base = await h.listen();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-session-int-'));
    env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: new URL(base).port, CLAUDE_CODE_ENTRYPOINT: 'cli' };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const noFiles = async (): Promise<string> => {
    throw new Error('ENOENT');
  };

  it('a hand-rolled tmux launch links the child to its parent as hook, and both learn their node ids', async () => {
    const orch = await runSession({
      input: { session_id: ORCH, cwd: CWD, source: 'startup', transcript_path: '/t/o.jsonl' },
      env,
      readText: noFiles,
      runTmux: async () => 'main:@1.%1',
      ppid: 1,
      hostname: () => HOST,
    });
    const orchNode = /node ([0-9A-Z]{2}-[0-9A-Z]{2})/.exec(orch!.hookSpecificOutput.additionalContext)![1];

    await runSpawn({
      input: { session_id: ORCH, cwd: CWD, tool_name: 'Bash', tool_input: { command: `tmux new-window -c ${CWD} "claude -n kid"` } },
      env,
      hostname: () => HOST,
    });

    const child = await runSession({
      input: { session_id: CHILD, cwd: CWD, source: 'startup' },
      env: { ...env, TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%2' },
      readText: async (file) => {
        if (file === '/proc/9/cmdline') return ['claude', '-n', 'kid'].join('\0');
        throw new Error('ENOENT');
      },
      runTmux: async () => 'main:@2.%2',
      ppid: 9,
      hostname: () => HOST,
    });
    expect(child!.hookSpecificOutput.additionalContext).toContain(`spawned by node ${orchNode}`);
    const row = await repo.getBySessionId(CHILD);
    expect(row).toMatchObject({ parentSessionId: ORCH, parentLinkSource: 'hook' });
  });

  it('a swarm child (CC_PARENT_SESSION) links as env', async () => {
    await runSession({ input: { session_id: ORCH, cwd: CWD }, env, readText: noFiles, runTmux: async () => '', ppid: 1, hostname: () => HOST });
    const out = await runSession({
      input: { session_id: CHILD, cwd: CWD, source: 'startup' },
      env: { ...env, CC_PARENT_SESSION: ORCH },
      readText: noFiles,
      runTmux: async () => '',
      ppid: 1,
      hostname: () => HOST,
    });
    expect(out!.hookSpecificOutput.additionalContext).toMatch(/spawned by node [0-9A-Z]{2}-[0-9A-Z]{2} \(exact link/);
    expect(await repo.getBySessionId(CHILD)).toMatchObject({ parentSessionId: ORCH, parentLinkSource: 'env' });
  });
});
