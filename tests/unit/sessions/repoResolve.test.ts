import { describe, expect, it } from 'vitest';
import {
  createRepoResolver,
  encodeProjectDir,
  repoFromClaudeWorktree,
  repoFromGitRoots,
  repoFromPath,
  repoFromProjectDir,
  repoFromWorktreePath,
  type GitRoots,
} from '../../../src/sessions/repoResolve.js';

const HOME = '/home/u';
const WT = '/home/u/.worktrees';

describe('path conventions', () => {
  it('maps a worktree path to its repo whether or not the dir exists', () => {
    expect(repoFromWorktreePath('/home/u/.worktrees/mcp-notes/wall-editing', WT)).toBe('mcp-notes');
    expect(repoFromWorktreePath('/home/u/.worktrees/agentic_golang/uatp-4258/tools/x', WT)).toBe('agentic_golang');
    expect(repoFromWorktreePath('/home/u/mcp-notes', WT)).toBeNull();
    expect(repoFromWorktreePath(WT, WT)).toBeNull();
  });

  it('maps a Claude Code worktree to the repo that holds it', () => {
    expect(repoFromClaudeWorktree('/home/u/seer/.claude/worktrees/ui-copy-spacing')).toBe('seer');
    expect(repoFromClaudeWorktree('/home/u/seer')).toBeNull();
  });

  it('falls back to ~, the first segment under home, then the basename', () => {
    expect(repoFromPath('/home/u', HOME)).toBe('~');
    expect(repoFromPath('/home/u/agentic/docs/plans', HOME)).toBe('agentic');
    expect(repoFromPath('/srv/tools/thing', HOME)).toBe('thing');
  });

  it('names the main checkout from git roots, also for a linked worktree', () => {
    expect(repoFromGitRoots({ toplevel: '/home/u/mcp-notes', commonDir: '/home/u/mcp-notes/.git' })).toBe('mcp-notes');
    expect(repoFromGitRoots({ toplevel: '/elsewhere/feature-x', commonDir: '/home/u/seer/.git' })).toBe('seer');
    expect(repoFromGitRoots({ toplevel: '/srv/bare-co', commonDir: '/srv/bare.git' })).toBe('bare-co');
  });
});

describe('repoFromProjectDir', () => {
  const known = ['agentic', 'agentic_golang', 'mcp-notes'];
  it('decodes worktree and home project dirs against real directory names', () => {
    expect(encodeProjectDir('/home/u/.worktrees/agentic_golang/x')).toBe('-home-u--worktrees-agentic-golang-x');
    expect(repoFromProjectDir('-home-u--worktrees-agentic-golang-fix-stream', HOME, WT, known)).toBe('agentic_golang');
    expect(repoFromProjectDir('-home-u--worktrees-agentic-popup-data', HOME, WT, known)).toBe('agentic');
    expect(repoFromProjectDir('-home-u-mcp-notes', HOME, WT, known)).toBe('mcp-notes');
    expect(repoFromProjectDir('-home-u', HOME, WT, known)).toBe('~');
    expect(repoFromProjectDir('-home-u-unknown-thing', HOME, WT, known)).toBe('unknown');
    expect(repoFromProjectDir('-tmp-scratch', HOME, WT, known)).toBeNull();
  });
});

describe('createRepoResolver', () => {
  it('uses git only for a directory that exists, and caches per cwd', async () => {
    const gitCalls: string[] = [];
    const resolver = createRepoResolver({
      homeDir: HOME,
      worktreesDir: WT,
      isDirectory: async (p) => p === '/home/u/mcp-notes/web',
      gitRoots: async (cwd): Promise<GitRoots | null> => {
        gitCalls.push(cwd);
        return { toplevel: '/home/u/mcp-notes', commonDir: '/home/u/mcp-notes/.git' };
      },
      listRepoNames: async () => ['mcp-notes'],
    });
    expect(await resolver.resolve('/home/u/mcp-notes/web', '-home-u-mcp-notes-web')).toBe('mcp-notes');
    expect(await resolver.resolve('/home/u/mcp-notes/web', '-home-u-mcp-notes-web')).toBe('mcp-notes');
    expect(gitCalls).toEqual(['/home/u/mcp-notes/web']);
    expect(await resolver.resolve('/home/u/.worktrees/mcp-notes/gone', 'x')).toBe('mcp-notes');
    expect(await resolver.resolve('/home/u/deleted-repo/sub', 'x')).toBe('deleted-repo');
    expect(await resolver.resolve(null, '-home-u--worktrees-mcp-notes-wall-editing')).toBe('mcp-notes');
    expect(gitCalls).toHaveLength(1);
  });
});
