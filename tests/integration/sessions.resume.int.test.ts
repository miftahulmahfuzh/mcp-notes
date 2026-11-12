import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ccSessionPrompts, ccSessionReplies, ccSessions } from '../../src/db/schema.js';
import type { AppDeps } from '../../src/deps.js';
import { sessionLookup, sessionResumeRoutes } from '../../src/http/sessionResume.js';
import { DEFAULT_BASELINE_TOKENS, HANDOFF_MARKER, loadHandoffSource } from '../../src/sessions/handoff.js';
import { generateNodeId, normalizeNodeId } from '../../src/sessions/ids.js';
import { SessionsRepo } from '../../src/sessions/repo.js';
import { createSessionResumer, type CommandRunner, type ResumeDeps } from '../../src/sessions/resume.js';
import { PROMPTS_VERSION } from '../../src/sessions/types.js';
import { closeTestDb, openTestDb } from './setup.js';

const db = openTestDb();
const created: string[] = [];
let dataDir = '';

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'resume-int-'));
});

afterAll(async () => {
  if (created.length > 0) await db.delete(ccSessions).where(inArray(ccSessions.sessionId, created));
  await rm(dataDir, { recursive: true, force: true });
  await closeTestDb(db);
});

interface InsertOptions {
  host: string;
  repo?: string;
  model?: string | null;
  peak?: number | null;
  first?: number | null;
  /** Marks the row a fork (fork_detected_by = 'job', with the cut and prompt count cc_sessions_fork_info_check requires); the baseline leaves it out. */
  fork?: boolean;
  firstPrompt?: string;
  exchanges?: number;
  chars?: number;
}

async function insert(opts: InsertOptions): Promise<{ sessionId: string; nodeId: string; transcriptPath: string }> {
  const sessionId = randomUUID();
  const nodeId = generateNodeId();
  const transcriptPath = `/home/u/.claude/projects/x/${sessionId}.jsonl`;
  const exchanges = opts.exchanges ?? 0;
  created.push(sessionId);
  await db.insert(ccSessions).values({
    sessionId,
    nodeId,
    host: opts.host,
    repo: opts.repo ?? 'mcp-notes',
    cwd: '/nonexistent/worktree',
    name: 'impl-x-p9',
    aiTitle: 'resume test',
    summary: 'A summary.',
    summarizedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    transcriptPath,
    commits: [{ sha: 'abc123def4567890', subject: 'feat: resume', at: null }],
    planDocs: ['docs/plans/PROJECT_SESSION_GRAPH_PLAN.md'],
    entrypoint: 'cli',
    firstPrompt: opts.firstPrompt ?? null,
    startedAt: new Date(),
    promptsVersion: exchanges > 0 ? PROMPTS_VERSION : 0,
  });
  await db.execute(sql`
    update cc_sessions
    set context_model = ${opts.model ?? null}, context_peak_tokens = ${opts.peak ?? null},
        context_first_tokens = ${opts.first ?? null},
        fork_detected_by = ${opts.fork === true ? 'job' : null},
        fork_cut_offset = ${opts.fork === true ? 1 : null},
        fork_prompt_count = ${opts.fork === true ? 0 : null}
    where session_id = ${sessionId}`);
  if (exchanges > 0) {
    const chars = opts.chars ?? 100;
    const seqs = Array.from({ length: exchanges }, (_, i) => i + 1);
    await db.insert(ccSessionPrompts).values(seqs.map((seq) => ({ sessionId, seq, text: `<<PROMPT-${seq}>> ${'p'.repeat(chars)}` })));
    await db.insert(ccSessionReplies).values(seqs.map((seq) => ({ sessionId, seq, text: `<<REPLY-${seq}>> ${'r'.repeat(chars)}` })));
  }
  return { sessionId, nodeId, transcriptPath };
}

interface FakeRun {
  run: CommandRunner;
  tmux: string[][];
  git: string[][];
}

/** tmux answers list-sessions / new-window; git answers status / diff --stat, or fails. */
function fakeRun(gitFails = false): FakeRun {
  const tmux: string[][] = [];
  const git: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    if (cmd === 'git') {
      git.push([...args]);
      if (gitFails) throw new Error('Command failed: git status\nfatal: not a git repository');
      return args.includes('status') ? '## main...origin/main\n M src/x.ts\n' : ' src/x.ts | 2 +-\n 1 file changed\n';
    }
    tmux.push([...args]);
    if (args[0] === 'list-sessions') return '10 note\n';
    if (args[0] === 'new-window') return 'note:5 %30\n';
    return '';
  };
  return { run, tmux, git };
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
    dataDir,
    live: async () => null,
    isDir: async (p) => p === '/home/u',
    repoCwds: async () => [],
    loadHandoff: (node) => loadHandoffSource(db, node),
    now: () => Date.now(),
  };
}

function spawnedArgv(f: FakeRun): string[] {
  const argv = f.tmux.find((a) => a[0] === 'new-window');
  expect(argv).toBeDefined();
  return argv!;
}

function handoffFile(argv: string[]): string {
  const i = argv.indexOf('--append-system-prompt-file');
  expect(i).toBeGreaterThan(-1);
  return argv[i + 1]!;
}

async function unusedNodeId(repo: SessionsRepo): Promise<string> {
  let id = generateNodeId();
  while ((await repo.getByNodeId(id)) !== null) id = generateNodeId();
  return id;
}

describe('session resume against cc_sessions', () => {
  const repo = new SessionsRepo(db);
  const lookup = sessionLookup(repo);

  it('maps a real row into a ResumeNode', async () => {
    const { sessionId, nodeId } = await insert({ host: 'this-host' });
    expect(await lookup(nodeId)).toMatchObject({
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
    const local = await insert({ host: 'this-host' });
    const remote = await insert({ host: 'GPD' });
    const f = fakeRun();
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect(await resumer.resume(local.nodeId.toLowerCase().replace('-', ''), {})).toEqual({
      status: 200,
      body: { action: 'resumed', window: 'note:5', cwd: '/home/u', original_cwd: '/nonexistent/worktree' },
    });
    const before = f.tmux.length;
    expect(await resumer.resume(remote.nodeId, {})).toEqual({ status: 404, body: { error: 'not_on_this_machine', host: 'GPD' } });
    expect(f.tmux.length).toBe(before);
    expect(await resumer.resume(await unusedNodeId(repo), {})).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('R4.1/R4.3/R4.4: spawn fresh from a 1M node carries every stored exchange, the header and git state, through --append-system-prompt-file', async () => {
    const n = await insert({ host: 'this-host', model: 'claude-opus-5-5', peak: 300_000, exchanges: 30, chars: 2000 });
    const f = fakeRun();
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect(await resumer.resume(n.nodeId, { fresh: true, prompt: 'finish the tests' })).toEqual({
      status: 200,
      body: { action: 'spawned', window: 'note:5', cwd: '/home/u', original_cwd: '/nonexistent/worktree' },
    });
    const argv = spawnedArgv(f);
    const file = handoffFile(argv);
    expect(path.dirname(file)).toBe(path.join(dataDir, 'handoffs'));
    expect(path.basename(file)).toMatch(new RegExp(`^${n.nodeId}-\\d{8}T\\d{6}\\.md$`));
    expect(argv).toContain(`CC_PARENT_SESSION=${n.sessionId}`);
    const first = argv[argv.length - 1]!;
    expect(first.split('\n')[0]).toBe(HANDOFF_MARKER);
    expect(first).toContain(n.nodeId);
    expect(first).toContain(file);
    expect(first.endsWith('Task: finish the tests')).toBe(true);
    const text = await readFile(file, 'utf8');
    for (let seq = 1; seq <= 30; seq += 1) {
      expect(text).toContain(`<<PROMPT-${seq}>>`);
      expect(text).toContain(`<<REPLY-${seq}>>`);
    }
    expect(text).toContain('All 30 stored exchanges follow');
    for (const part of [
      n.nodeId,
      '"resume test"',
      '- Cwd: /nonexistent/worktree',
      '- Repo: mcp-notes',
      `- Transcript: ${n.transcriptPath}`,
      'A summary.',
      'Written 2 hours ago',
      'may be older than the latest exchanges',
      '- docs/plans/PROJECT_SESSION_GRAPH_PLAN.md',
      '- abc123def456 feat: resume',
      '`git status --porcelain=v1 -b`:',
      '## main...origin/main',
      '`git diff --stat`:',
      '1 file changed',
    ]) {
      expect(text).toContain(part);
    }
    expect(f.git).toEqual([
      ['--no-optional-locks', '-C', '/home/u', 'status', '--porcelain=v1', '-b'],
      ['--no-optional-locks', '-C', '/home/u', 'diff', '--stat'],
    ]);
  });

  it('R4.2: spawn fresh from a 200k node carries the first exchange and the newest that fit, and says what was left out', async () => {
    const n = await insert({ host: 'this-host', model: 'glm-5.3', peak: 20_000, exchanges: 80, chars: 4000 });
    const f = fakeRun();
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect((await resumer.resume(n.nodeId, { fresh: true })).body).toMatchObject({ action: 'spawned' });
    const text = await readFile(handoffFile(spawnedArgv(f)), 'utf8');
    const kept = [...text.matchAll(/^### Prompt (\d+)/gm)].map((m) => Number(m[1]));
    expect(kept[0]).toBe(1);
    expect(kept[kept.length - 1]).toBe(80);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept.length).toBeLessThan(80);
    expect(kept.slice(1)).toEqual(Array.from({ length: kept.length - 1 }, (_, i) => 80 - (kept.length - 2) + i));
    expect(text).toContain('<<REPLY-1>>');
    expect(text).not.toContain('<<PROMPT-2>>');
    expect(text).toContain(`${80 - kept.length} exchanges were left out`);
    expect(text).toContain(n.transcriptPath);
  });

  it('R4.6: a failing git still spawns; the handoff has no git state and says so', async () => {
    const n = await insert({ host: 'this-host', model: 'claude-opus-5-5', peak: 300_000, exchanges: 2 });
    const f = fakeRun(true);
    const resumer = createSessionResumer({ normalize: normalizeNodeId, lookup, deps: deps(f.run) });
    expect((await resumer.resume(n.nodeId, { fresh: true })).body).toMatchObject({ action: 'spawned' });
    const text = await readFile(handoffFile(spawnedArgv(f)), 'utf8');
    expect(text).toContain('Git state unavailable for /home/u');
    expect(text).toContain('not a git repository');
    expect(text).not.toContain('## main...origin/main');
  });

  it('R4.7: GET /api/sessions/:nodeId/handoff answers the estimate from real rows, on any host, writing no file', async () => {
    const repoName = `handoff-int-${randomUUID().slice(0, 8)}`;
    for (const first of [30_000, 40_000, 50_000]) await insert({ host: 'GPD', repo: repoName, first });
    // Forks carry their parent's history in their first message: two big ones must not move the median.
    for (const first of [400_000, 500_000]) await insert({ host: 'GPD', repo: repoName, first, fork: true });
    // A skill's first prompt (/implement) and a handoff spawn start heavier than a fresh spawn would.
    await insert({ host: 'GPD', repo: repoName, first: 66_000, firstPrompt: '/implement -f PLAN.md --phase 1' });
    await insert({ host: 'GPD', repo: repoName, first: 90_000, firstPrompt: `${HANDOFF_MARKER}\nContinue A0-3G.` });
    const n = await insert({ host: 'GPD', repo: repoName, model: 'claude-opus-5-5', peak: 300_000, exchanges: 12, chars: 500 });
    const estDir = await mkdtemp(path.join(os.tmpdir(), 'handoff-est-'));
    try {
      const app = sessionResumeRoutes({ db, config: { dataDir: estDir } } as unknown as AppDeps);
      const res = await app.request(`/api/sessions/${n.nodeId.toLowerCase().replace('-', '')}/handoff`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tokens: number; percent: number };
      expect(body).toMatchObject({
        node_id: n.nodeId,
        window: 1_000_000,
        baseline: 40_000,
        exchanges_included: 12,
        exchanges_total: 12,
        truncated: false,
      });
      expect(body.tokens).toBeGreaterThan((12 * 2 * 500) / 4);
      expect(body.percent).toBe(Math.round(((40_000 + body.tokens) / 1_000_000) * 1000) / 10);
      expect(existsSync(path.join(estDir, 'handoffs'))).toBe(false);

      const lonely = await insert({ host: 'GPD', repo: `handoff-int-${randomUUID().slice(0, 8)}` });
      const lonelyBody = await (await app.request(`/api/sessions/${lonely.nodeId}/handoff`)).json();
      expect(lonelyBody).toMatchObject({ baseline: DEFAULT_BASELINE_TOKENS, exchanges_total: 0, truncated: false });

      const unknown = await app.request(`/api/sessions/${await unusedNodeId(repo)}/handoff`);
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: string }).error).toBe('not_found');
    } finally {
      await rm(estDir, { recursive: true, force: true });
    }
  });
});
