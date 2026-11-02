import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/client.js';
import { LINKS_BACKFILL_VERSION, LINKS_MARKER_PREFIX, dbLinkStore, startLinkWorker } from '../../src/sessions/links.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { closeTestDb, openTestDb, truncateAll } from './setup.js';

const HOST = 'links-int-host';
const HOME = '/home/u';
const MAIN = '/home/u/demo';
const WT = '/home/u/.worktrees/demo/x';
const T0 = Date.parse('2026-10-30T09:16:21.489Z');
const at = (ms: number) => new Date(T0 + ms);

const ANALYZE = '00000000-0000-4000-8000-0000000000a1';
const ORCH = '00000000-0000-4000-8000-0000000000b1';
const P1 = '00000000-0000-4000-8000-0000000000c1';
const P1_OLD = '00000000-0000-4000-8000-0000000000c0';
const P1_GPD = '00000000-0000-4000-8000-0000000000c9';
const P2 = '00000000-0000-4000-8000-0000000000c2';
const P3 = '00000000-0000-4000-8000-0000000000c3';
const P4 = '00000000-0000-4000-8000-0000000000c4';
const HAND = '00000000-0000-4000-8000-0000000000d1';

function assistant(sessionId: string, cwd: string, ms: number, name: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    sessionId,
    cwd,
    entrypoint: 'cli',
    isSidechain: false,
    timestamp: at(ms).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${ms}`, name, input }] },
  };
}

async function writeTranscript(home: string, dirName: string, sessionId: string, records: unknown[]): Promise<string> {
  const dir = path.join(home, 'projects', dirName);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

interface Seed {
  sessionId: string;
  nodeId: string;
  host?: string;
  repo: string;
  cwd: string;
  name: string;
  startedAt: Date;
  transcriptPath?: string | null;
  parent?: { id: string; source: 'env' | 'hook' | 'heuristic' };
}

async function insertSession(db: Db, s: Seed): Promise<void> {
  await db.execute(sql`
    insert into cc_sessions (session_id, node_id, host, repo, cwd, name, custom_title, entrypoint,
                             started_at, last_active_at, transcript_path, parent_session_id, parent_link_source)
    values (${s.sessionId}, ${s.nodeId}, ${s.host ?? HOST}, ${s.repo}, ${s.cwd}, ${s.name}, ${s.name}, 'cli',
            ${s.startedAt.toISOString()}::timestamptz, ${s.startedAt.toISOString()}::timestamptz,
            ${s.transcriptPath ?? null}, ${s.parent?.id ?? null}, ${s.parent?.source ?? null})
  `);
}

async function parentOf(db: Db, sessionId: string): Promise<{ parent: string | null; source: string | null }> {
  const res = await db.execute<{ parent_session_id: string | null; parent_link_source: string | null }>(sql`
    select parent_session_id, parent_link_source from cc_sessions where session_id = ${sessionId}
  `);
  const row = res.rows[0];
  return { parent: row?.parent_session_id ?? null, source: row?.parent_link_source ?? null };
}

describe('heuristic parent links over a fixture Claude home', () => {
  let db: Db;
  let repo: SessionsRepo;
  let home: string;

  beforeAll(() => {
    db = openTestDb();
    repo = new SessionsRepo(db);
  });

  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
    await closeTestDb(db);
  });

  beforeEach(async () => {
    await truncateAll(db); // phase 1 extended it to the cc_* tables and app_settings
    await db.execute(sql`delete from app_settings where key like ${`${LINKS_MARKER_PREFIX}%`}`);
    if (home) await rm(home, { recursive: true, force: true });
    home = await mkdtemp(path.join(tmpdir(), 'claude-home-'));

    const analyzeFile = await writeTranscript(home, '-home-u-demo', ANALYZE, [
      { type: 'custom-title', customTitle: 'analyze-demo-x', sessionId: ANALYZE },
      assistant(ANALYZE, MAIN, 0, 'Bash', {
        command:
          'cd $HOME/.worktrees/demo/x && git log --oneline -1 && python3 ~/.claude/skills/swarm/swarm.py launch --name "orch-demo-x" --cwd "$HOME/.worktrees/demo/x" --permission-mode bypassPermissions --prompt "/analyze-orchestrator -f docs/plans/X_PLAN.md"',
      }),
    ]);
    const orchFile = await writeTranscript(home, '-home-u--worktrees-demo-x', ORCH, [
      { type: 'agent-name', agentName: 'orch-demo-x', sessionId: ORCH },
      assistant(ORCH, WT, 180_000, 'Bash', {
        command: 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug demo-x --phase 3 --dry-run',
      }),
      assistant(ORCH, WT, 200_000, 'Bash', {
        command: 'S=~/.claude/skills/swarm/swarm.py; for n in 1 2; do python3 $S spawn --slug demo-x --phase $n | tail -3; done',
      }),
      assistant(ORCH, WT, 240_000, 'SendMessage', { to: 'impl-demo-x-p1', recipient: 'impl-demo-x-p1', message: 'rules' }),
    ]);

    await insertSession(db, { sessionId: ANALYZE, nodeId: 'L4-A1', repo: 'demo', cwd: MAIN, name: 'analyze-demo-x', startedAt: at(-60_000), transcriptPath: analyzeFile });
    await insertSession(db, { sessionId: ORCH, nodeId: 'L4-B1', repo: 'demo', cwd: WT, name: 'orch-demo-x', startedAt: at(2_300), transcriptPath: orchFile });
    await insertSession(db, { sessionId: P1, nodeId: 'L4-C1', repo: 'demo', cwd: WT, name: 'impl-demo-x-p1', startedAt: at(203_808), transcriptPath: path.join(home, 'projects', 'gone', `${P1}.jsonl`) });
    await insertSession(db, { sessionId: P1_OLD, nodeId: 'L4-C0', repo: 'demo', cwd: WT, name: 'impl-demo-x-p1', startedAt: at(-86_400_000) });
    await insertSession(db, { sessionId: P1_GPD, nodeId: 'L4-C9', host: 'other-host', repo: 'demo', cwd: WT, name: 'impl-demo-x-p1', startedAt: at(204_000) });
    await insertSession(db, { sessionId: HAND, nodeId: 'L4-D1', repo: 'demo', cwd: MAIN, name: 'by-hand', startedAt: at(100_000) });
    await insertSession(db, { sessionId: P2, nodeId: 'L4-C2', repo: 'demo', cwd: WT, name: 'impl-demo-x-p2', startedAt: at(204_500), parent: { id: HAND, source: 'hook' } });
    await insertSession(db, { sessionId: P3, nodeId: 'L4-C3', repo: 'demo', cwd: WT, name: 'impl-demo-x-p3', startedAt: at(183_000) });
  });

  it('links launched and spawned children as heuristic, and nothing else', async () => {
    const worker = startLinkWorker({ store: dbLinkStore(db, repo), host: HOST, home: HOME, debounceMs: 60_000, log: () => {} });
    try {
      await worker.onPassComplete({ initial: true });
    } finally {
      await worker.close();
    }

    expect(await parentOf(db, ORCH)).toEqual({ parent: ANALYZE, source: 'heuristic' });
    expect(await parentOf(db, P1)).toEqual({ parent: ORCH, source: 'heuristic' });
    expect(await parentOf(db, P2)).toEqual({ parent: HAND, source: 'hook' });
    expect(await parentOf(db, P3)).toEqual({ parent: null, source: null });
    expect(await parentOf(db, P1_OLD)).toEqual({ parent: null, source: null });
    expect(await parentOf(db, P1_GPD)).toEqual({ parent: null, source: null });
    expect(await parentOf(db, ANALYZE)).toEqual({ parent: null, source: null });

    const marker = await db.execute<{ value: { version: number; linked: number } }>(sql`
      select value from app_settings where key = ${`${LINKS_MARKER_PREFIX}${HOST}`}
    `);
    expect(marker.rows[0]?.value).toMatchObject({ version: LINKS_BACKFILL_VERSION, linked: 2 });
  });

  it('never replaces an env link on a re-run', async () => {
    await repo.setParent(P1, HAND, 'env');
    const worker = startLinkWorker({ store: dbLinkStore(db, repo), host: HOST, home: HOME, debounceMs: 60_000, log: () => {} });
    try {
      await worker.onPassComplete({ initial: true });
    } finally {
      await worker.close();
    }
    expect(await parentOf(db, P1)).toEqual({ parent: HAND, source: 'env' });
    expect(await parentOf(db, ORCH)).toEqual({ parent: ANALYZE, source: 'heuristic' });
  });

  it('links a child spawned while the daemon runs, from the batch records', async () => {
    const worker = startLinkWorker({
      store: dbLinkStore(db, repo),
      host: HOST,
      home: HOME,
      debounceMs: 60_000,
      log: () => {},
      now: () => at(605_000),
    });
    try {
      await worker.onPassComplete({ initial: true });
      worker.onBatch({
        sessionId: ORCH,
        host: HOST,
        records: [assistant(ORCH, WT, 600_000, 'Bash', { command: 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug demo-x --phase 4' })],
      });
      await insertSession(db, { sessionId: P4, nodeId: 'L4-C4', repo: 'demo', cwd: WT, name: 'impl-demo-x-p4', startedAt: at(603_000) });
      worker.onBatch({ sessionId: P4, host: HOST, records: [] });
      const report = await worker.drainNow();
      expect(report.linked).toBe(1);
    } finally {
      await worker.close();
    }
    expect(await parentOf(db, P4)).toEqual({ parent: ORCH, source: 'heuristic' });
  });
});
