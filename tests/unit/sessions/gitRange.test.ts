import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRangeLog, parseGitLog, withRangeCommits } from '../../../src/sessions/gitRange.js';

describe('parseGitLog', () => {
  it('reads %h NUL %cI NUL %s lines, times in UTC', () => {
    expect(parseGitLog('81c7f3d\u00002026-11-02T13:30:00+07:00\u0000fix(web): pill\n\n')).toEqual([
      { sha: '81c7f3d', subject: 'fix(web): pill', at: '2026-11-02T06:30:00.000Z' },
    ]);
  });
});

describe('withRangeCommits', () => {
  it('adds each range commit once, after the commit lines', async () => {
    const out = await withRangeCommits(
      [{ sha: 'aaaaaaa', subject: 'a', at: null }],
      [{ from: '1111111', to: '2222222', cwd: '/r', at: null }],
      async () => [
        { sha: 'aaaaaaa', subject: 'dup', at: null },
        { sha: 'bbbbbbb', subject: 'b', at: null },
      ],
    );
    expect(out.map((c) => `${c.sha} ${c.subject}`)).toEqual(['aaaaaaa a', 'bbbbbbb b']);
  });
});

describe('createGitRangeLog', () => {
  let dir: string;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'git-range-'));
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'base');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists the commits of a range, oldest first, with short shas', async () => {
    const from = git('rev-parse', '--short', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    const to = git('rev-parse', '--short', 'HEAD');
    const commits = await createGitRangeLog()({ from, to, cwd: dir, at: null });
    expect(commits.map((c) => c.subject)).toEqual(['one', 'two']);
    expect(commits[1]?.sha).toBe(to);
  });

  it('gives nothing for a missing cwd or an unknown range', async () => {
    const log = createGitRangeLog();
    expect(await log({ from: '1111111', to: '2222222', cwd: dir, at: null })).toEqual([]);
    expect(await log({ from: '1111111', to: '2222222', cwd: path.join(dir, 'gone'), at: null })).toEqual([]);
    expect(await log({ from: '1111111', to: '2222222', cwd: null, at: null })).toEqual([]);
  });
});
