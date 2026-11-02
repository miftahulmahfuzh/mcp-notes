import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { ccSessions } from '../../src/db/schema.js';
import { sessionLookup } from '../../src/http/sessionResume.js';
import { generateNodeId, normalizeNodeId } from '../../src/sessions/ids.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createSessionResumer, type CommandRunner, type ResumeDeps } from '../../src/sessions/resume.js';
import { closeTestDb, openTestDb } from './setup.js';

const db = openTestDb();
const created: string[] = [];

afterAll(async () => {
  if (created.length > 0) await db.delete(ccSessions).where(inArray(ccSessions.sessionId, created));
  await closeTestDb(db);
});

async function insert(host: string): Promise<{ sessionId: string; nodeId: string }> {
  const sessionId = randomUUID();
  const nodeId = generateNodeId();
  created.push(sessionId);
  await db.insert(ccSessions).values({
    sessionId,
    nodeId,
    host,
    repo: 'mcp-notes',
    cwd: '/nonexistent/worktree',
    name: 'impl-x-p9',
    aiTitle: 'resume test',
    summary: 'A summary.',
    transcriptPath: `/home/u/.claude/projects/x/${sessionId}.jsonl`,
    commits: [{ sha: 'abc123def4567890', subject: 'feat: resume', at: null }],
    planDocs: ['docs/plans/PROJECT_SESSION_GRAPH_PLAN.md'],
    entrypoint: 'cli',
  });
  return { sessionId, nodeId };
}

function deps(run: CommandRunner): ResumeDeps {
  return {
    host: 'this-host',
    run,
    tmuxBin: 'tmux',
    tmuxSocket: null,
    claudeBin: '/opt/claude',
    homeDir: '/home/u',
    worktreesDir: '/home/u/.worktrees',
    live: async () => null,
    isDir: async (p) => p === '/home/u',
    repoCwds: async () => [],
    now: () => Date.now(),
  };
}

describe('session resume against cc_sessions', () => {
  const repo = new SessionsRepo(db);
  const lookup = sessionLookup(repo);

  it('maps a real row into a ResumeNode', async () => {
    const { sessionId, nodeId } = await insert('this-host');
    const node = await lookup(nodeId);
    expect(node).toMatchObject({
      sessionId,
      nodeId,
      host: 'this-host',
      repo: 'mcp-notes',
      cwd: '/nonexistent/worktree',
      name: 'impl-x-p9',
      title: 'resume test',
      summary: 'A summary.',
      commits: ['abc123def456 feat: resume'],
      planDocs: ['docs/plans/PROJECT_SESSION_GRAPH_PLAN.md'],
    });
  });

  it('resumes a local row (cwd gone -> $HOME fallback) and refuses another host', async () => {
    const local = await insert('this-host');
    const remote = await insert('GPD');
    const calls: string[][] = [];
    const run: CommandRunner = async (_cmd, args) => {
      calls.push([...args]);
      if (args[0] === 'list-sessions') return '10 note\n';
      if (args[0] === 'new-window') return 'note:5 %30\n';
      return '';
    };
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(run) });
    expect(await resumer.resume(local.nodeId.toLowerCase().replace('-', ''), {})).toEqual({
      status: 200,
      body: { action: 'resumed', window: 'note:5', cwd: '/home/u', original_cwd: '/nonexistent/worktree' },
    });
    const before = calls.length;
    expect(await resumer.resume(remote.nodeId, {})).toEqual({
      status: 404,
      body: { error: 'not_on_this_machine', host: 'GPD' },
    });
    expect(calls.length).toBe(before);
    let unused = generateNodeId();
    while ((await repo.getByNodeId(unused)) !== null) unused = generateNodeId();
    expect(await resumer.resume(unused, {})).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});
