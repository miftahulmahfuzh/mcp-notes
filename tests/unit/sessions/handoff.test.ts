import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_MARKER as HOOK_MARKER } from '../../../claude/hooks/notes-prompt.mjs';
import {
  buildHandoff,
  DEFAULT_BASELINE_TOKENS,
  estimateTokens,
  formatAge,
  gitState,
  handoffBudget,
  handoffEstimateBody,
  handoffFileName,
  HANDOFF_MARKER,
  HANDOFF_MAX_AGE_MS,
  writeHandoff,
  type GitState,
  type HandoffExchange,
  type HandoffSource,
} from '../../../src/sessions/handoff.js';
import type { CommandRunner, ResumeNode } from '../../../src/sessions/resume.js';

const NOW = new Date('2026-11-12T03:00:00Z');
const SID = '6f1c2d3e-0000-4000-8000-00000000abcd';
const TRANSCRIPT = `/home/u/.claude/projects/-home-u-mcp-notes/${SID}.jsonl`;
const ONE_M = { model: 'claude-opus-5-5', peakTokens: 300_000, longBeta: false };
const UNKNOWN_200K = { model: 'glm-5.3', peakTokens: 10_000, longBeta: false };
const COLLECTED: GitState = {
  kind: 'collected',
  cwd: '/home/u/mcp-notes',
  status: '## main...origin/main\n M src/x.ts',
  diffStat: ' src/x.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
};

function node(over: Partial<ResumeNode> = {}): ResumeNode {
  return {
    sessionId: SID,
    nodeId: 'A0-3G',
    host: 'lenovo',
    repo: 'mcp-notes',
    cwd: '/home/u/mcp-notes',
    name: 'impl-x-p1',
    title: 'wall editing',
    summary: 'Built the photo delete flow.',
    firstPrompt: 'make photos deletable',
    transcriptPath: TRANSCRIPT,
    commits: ['abc123def456 feat: delete photos'],
    planDocs: ['docs/plans/WALL_PLAN.md'],
    ...over,
  };
}

/** n exchanges, each prompt and reply `chars` long, tagged <<PROMPT-k>> / <<REPLY-k>>. */
function exchanges(n: number, chars: number): HandoffExchange[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    at: new Date(NOW.getTime() - (n - i) * 60_000),
    prompt: `<<PROMPT-${i + 1}>> ${'p'.repeat(chars)}`,
    promptTruncated: false,
    reply: `<<REPLY-${i + 1}>> ${'r'.repeat(chars)}`,
    replyTruncated: false,
  }));
}

function source(over: Partial<HandoffSource> = {}): HandoffSource {
  return {
    node: node(),
    summarizedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
    promptsComplete: true,
    exchanges: exchanges(3, 100),
    context: ONE_M,
    baselineTokens: DEFAULT_BASELINE_TOKENS,
    ...over,
  };
}

const keptSeqs = (text: string): number[] => [...text.matchAll(/^### Prompt (\d+)/gm)].map((m) => Number(m[1]));

describe('buildHandoff', () => {
  it('R4.1: a 1M node whose exchanges fit carries every prompt and reply', () => {
    const { text, estimate } = buildHandoff(source({ exchanges: exchanges(40, 2000) }), { now: NOW, git: COLLECTED });
    expect(estimate.window).toBe(1_000_000);
    expect(estimate).toMatchObject({ exchanges_included: 40, exchanges_total: 40, truncated: false });
    for (let k = 1; k <= 40; k += 1) {
      expect(text).toContain(`<<PROMPT-${k}>>`);
      expect(text).toContain(`<<REPLY-${k}>>`);
    }
    expect(text).toContain('All 40 stored exchanges follow');
    expect(estimate.tokens).toBe(estimateTokens(text));
    expect(estimate.percent).toBe(Math.round(((DEFAULT_BASELINE_TOKENS + estimate.tokens) / 1_000_000) * 1000) / 10);
  });

  it('R4.2: over budget it keeps the first exchange and the newest that fit, and says what was left out', () => {
    const { text, estimate } = buildHandoff(source({ exchanges: exchanges(60, 4000), context: UNKNOWN_200K }), {
      now: NOW,
      git: COLLECTED,
    });
    expect(estimate.window).toBe(200_000);
    expect(estimate.truncated).toBe(true);
    const kept = keptSeqs(text);
    expect(kept.length).toBe(estimate.exchanges_included);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept.length).toBeLessThan(60);
    expect(kept[0]).toBe(1);
    expect(kept.slice(1)).toEqual(Array.from({ length: kept.length - 1 }, (_, i) => 60 - (kept.length - 2) + i));
    expect(text).toContain('<<REPLY-1>>');
    expect(text).not.toContain('<<PROMPT-2>>');
    expect(text).toContain(`${60 - kept.length} exchanges were left out`);
    expect(text).toContain(`Read the transcript ${TRANSCRIPT} for what was left out`);
    expect(estimate.tokens).toBeLessThanOrEqual(handoffBudget(200_000, DEFAULT_BASELINE_TOKENS));
    expect(estimate.percent).toBeLessThanOrEqual(50);
  });

  it('a first exchange bigger than the budget is cut to fit, and nothing newer is carried', () => {
    const giant: HandoffExchange = { ...exchanges(1, 0)[0]!, prompt: `<<PROMPT-1>> ${'g'.repeat(300_000)}` };
    const rest = exchanges(6, 100).slice(1);
    const { text, estimate } = buildHandoff(source({ exchanges: [giant, ...rest], context: UNKNOWN_200K }), {
      now: NOW,
      git: COLLECTED,
    });
    expect(keptSeqs(text)).toEqual([1]);
    expect(text).toContain('more characters left out');
    expect(text).toContain('The first exchange was cut to fit.');
    expect(estimate).toMatchObject({ exchanges_included: 1, exchanges_total: 6, truncated: true });
    expect(estimate.tokens).toBeLessThanOrEqual(handoffBudget(200_000, DEFAULT_BASELINE_TOKENS));
  });

  it('R4.3: the header names node, title, cwd, repo, transcript, summary with age, plan docs, commits and git state', () => {
    const { text } = buildHandoff(source(), { now: NOW, git: COLLECTED });
    for (const part of [
      'A0-3G',
      '"wall editing"',
      '- Cwd: /home/u/mcp-notes',
      '- Repo: mcp-notes',
      `- Transcript: ${TRANSCRIPT}`,
      'Written 2 hours ago (2026-11-12T01:00:00.000Z)',
      'may be older than the latest exchanges',
      'Built the photo delete flow.',
      '- docs/plans/WALL_PLAN.md',
      '- abc123def456 feat: delete photos',
      '`git status --porcelain=v1 -b`:',
      '## main...origin/main',
      '`git diff --stat`:',
      '1 file changed, 1 insertion(+), 1 deletion(-)',
    ]) {
      expect(text).toContain(part);
    }
    expect(buildHandoff(source({ node: node({ summary: null }) }), { now: NOW, git: COLLECTED }).text).toContain('Not summarized yet.');
  });

  it('R4.6: unavailable git state is said in the handoff; the estimate notes git is collected at spawn', () => {
    const failed = buildHandoff(source(), {
      now: NOW,
      git: { kind: 'unavailable', cwd: '/tmp/x', reason: 'git timed out after 5000 ms' },
    }).text;
    expect(failed).toContain('Git state unavailable for /tmp/x: git timed out after 5000 ms.');
    expect(failed).not.toContain('`git status --porcelain=v1 -b`:');
    expect(buildHandoff(source(), { now: NOW, git: { kind: 'not_collected' } }).text).toContain('collected at spawn time');
  });

  it('a legacy row says only excerpts are stored and marks missing replies', () => {
    const legacy = exchanges(2, 50).map((e) => ({ ...e, reply: null }));
    const { text, estimate } = buildHandoff(source({ promptsComplete: false, exchanges: legacy }), { now: NOW, git: COLLECTED });
    expect(text).toContain("Only excerpts of this session's prompts are stored");
    expect(text).toContain('(no reply stored)');
    expect(estimate).toMatchObject({ exchanges_included: 2, exchanges_total: 2, truncated: false });
  });

  it('no exchanges: says so and still estimates', () => {
    const { text, estimate } = buildHandoff(source({ exchanges: [] }), { now: NOW, git: COLLECTED });
    expect(text).toContain('No exchanges are stored for this session.');
    expect(estimate).toMatchObject({ exchanges_included: 0, exchanges_total: 0, truncated: false });
  });

  it('R4.7: handoffEstimateBody is the dry-run shape with the baseline', () => {
    const body = handoffEstimateBody(source({ baselineTokens: 40_000 }), NOW);
    expect(Object.keys(body).sort()).toEqual(
      ['baseline', 'exchanges_included', 'exchanges_total', 'node_id', 'percent', 'tokens', 'truncated', 'window'],
    );
    expect(body).toMatchObject({ node_id: 'A0-3G', baseline: 40_000, window: 1_000_000, exchanges_total: 3 });
  });

  it('formatAge', () => {
    expect(formatAge(-5)).toBe('0 minutes');
    expect(formatAge(60_000)).toBe('1 minute');
    expect(formatAge(2 * 3_600_000)).toBe('2 hours');
    expect(formatAge(3 * 86_400_000)).toBe('3 days');
  });

  it('the marker is the same text the notes-prompt hook tests for', () => {
    expect(HANDOFF_MARKER).toBe('[notesd handoff]');
    expect(HOOK_MARKER).toBe(HANDOFF_MARKER);
  });
});

describe('gitState', () => {
  it('runs status and diff --stat in the cwd', async () => {
    const calls: Array<[string, string[]]> = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push([cmd, [...args]]);
      return args.includes('status') ? '## main\n M a.ts\n' : ' a.ts | 1 +\n';
    };
    expect(await gitState(run, '/repo')).toEqual({ kind: 'collected', cwd: '/repo', status: '## main\n M a.ts', diffStat: ' a.ts | 1 +' });
    expect(calls).toEqual([
      ['git', ['--no-optional-locks', '-C', '/repo', 'status', '--porcelain=v1', '-b']],
      ['git', ['--no-optional-locks', '-C', '/repo', 'diff', '--stat']],
    ]);
  });

  it('R4.6: a failing git is unavailable with the reason, never a throw', async () => {
    const run: CommandRunner = async () => {
      throw new Error('Command failed: git -C /tmp status\nfatal: not a git repository');
    };
    expect(await gitState(run, '/tmp')).toEqual({
      kind: 'unavailable',
      cwd: '/tmp',
      reason: 'Command failed: git -C /tmp status fatal: not a git repository',
    });
  });

  it('R4.6: a git that never answers times out as unavailable', async () => {
    const run: CommandRunner = () => new Promise<string>(() => undefined);
    expect(await gitState(run, '/repo', 20)).toEqual({ kind: 'unavailable', cwd: '/repo', reason: 'git timed out after 20 ms' });
  });
});

describe('writeHandoff', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'handoff-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('R4.4: writes <dataDir>/handoffs/<NODE>-<stamp>.md, creating the folder', async () => {
    expect(handoffFileName('A0-3G', NOW)).toBe('A0-3G-20261112T030000.md');
    const file = await writeHandoff(dir, 'A0-3G', 'hello handoff', NOW);
    expect(file).toBe(path.join(dir, 'handoffs', 'A0-3G-20261112T030000.md'));
    expect(await readFile(file, 'utf8')).toBe('hello handoff');
  });

  it('prunes handoffs older than 14 days and keeps fresh ones and other files', async () => {
    const hdir = path.join(dir, 'handoffs');
    await mkdir(hdir, { recursive: true });
    const old = path.join(hdir, 'B1-2C-20261020T000000.md');
    const fresh = path.join(hdir, 'B1-2C-20261110T000000.md');
    const other = path.join(hdir, 'keep.txt');
    for (const f of [old, fresh, other]) await writeFile(f, 'x');
    const oldTime = new Date(NOW.getTime() - HANDOFF_MAX_AGE_MS - 60_000);
    await utimes(old, oldTime, oldTime);
    await utimes(other, oldTime, oldTime);
    const recent = new Date(NOW.getTime() - 2 * 86_400_000);
    await utimes(fresh, recent, recent);
    await writeHandoff(dir, 'A0-3G', 'new', NOW);
    expect((await readdir(hdir)).sort()).toEqual(['A0-3G-20261112T030000.md', 'B1-2C-20261110T000000.md', 'keep.txt']);
  });
});
