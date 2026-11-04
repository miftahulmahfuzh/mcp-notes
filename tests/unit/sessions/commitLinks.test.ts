import { describe, expect, it } from 'vitest';
import { commitUrl, createCommitLinker, webFromRemote, type GitRunner } from '../../../src/sessions/commitLinks.js';

describe('webFromRemote', () => {
  it('reads scp-style, ssh and https remotes', () => {
    expect(webFromRemote('git@github.com:miftahulmahfuzh/mcp-notes')).toEqual({ base: 'https://github.com/miftahulmahfuzh/mcp-notes', kind: 'github' });
    expect(webFromRemote('git@github.com:miftahulmahfuzh/mcp-notes.git\n')).toEqual({
      base: 'https://github.com/miftahulmahfuzh/mcp-notes',
      kind: 'github',
    });
    expect(webFromRemote('https://git.tuntun.co.id/ai/chatbot/agentic')).toEqual({ base: 'https://git.tuntun.co.id/ai/chatbot/agentic', kind: 'gitlab' });
    expect(webFromRemote('https://oauth2:tok@git.tuntun.co.id/ai/chatbot/agentic.git')).toEqual({
      base: 'https://git.tuntun.co.id/ai/chatbot/agentic',
      kind: 'gitlab',
    });
    expect(webFromRemote('ssh://git@git.tuntun.co.id:2222/ai/chatbot/agentic.git')?.base).toBe('https://git.tuntun.co.id/ai/chatbot/agentic');
    expect(webFromRemote('git@bitbucket.org:team/repo.git')?.kind).toBe('bitbucket');
  });

  it('refuses what is not a hosted repo', () => {
    expect(webFromRemote('/srv/git/repo.git')).toBeNull();
    expect(webFromRemote('file:///srv/git/repo.git')).toBeNull();
    expect(webFromRemote('https://github.com/')).toBeNull();
    expect(webFromRemote('')).toBeNull();
  });
});

describe('commitUrl', () => {
  it('uses each forge path', () => {
    const sha = '9740de10b2f28ae165a33539b0f24adc6a2b7d23';
    expect(commitUrl({ base: 'https://github.com/o/r', kind: 'github' }, sha)).toBe(`https://github.com/o/r/commit/${sha}`);
    expect(commitUrl({ base: 'https://git.tuntun.co.id/ai/chatbot/agentic', kind: 'gitlab' }, sha)).toBe(
      `https://git.tuntun.co.id/ai/chatbot/agentic/-/commit/${sha}`,
    );
    expect(commitUrl({ base: 'https://bitbucket.org/t/r', kind: 'bitbucket' }, sha)).toBe(`https://bitbucket.org/t/r/commits/${sha}`);
  });
});

describe('createCommitLinker', () => {
  const FULL = 'ba90ae1f540e248de36fa3db3698dff07e5b0860';

  function fakeGit(remotes: Record<string, string>): { git: GitRunner; calls: string[] } {
    const calls: string[] = [];
    const git: GitRunner = async (dir, args, input) => {
      calls.push(`${dir} ${args.join(' ')}`);
      if (args[0] === 'remote') return remotes[dir] ?? null;
      if (args[0] === 'cat-file') {
        return (input ?? '')
          .trim()
          .split('\n')
          .map((s) => (FULL.startsWith(s) ? `${FULL} commit` : `${s} missing`))
          .join('\n');
      }
      return null;
    };
    return { git, calls };
  }

  it('links through the cwd clone, widening known shas, and caches the repo', async () => {
    const { git, calls } = fakeGit({ '/w/mcp-notes': 'git@github.com:o/mcp-notes' });
    const link = createCommitLinker({ homeDir: '/home/u', git });
    const out = await link({ repo: 'mcp-notes', cwd: '/w/mcp-notes', shas: ['ba90ae1', 'DEAD123'] });
    expect(out.get('ba90ae1')).toBe(`https://github.com/o/mcp-notes/commit/${FULL}`);
    expect(out.get('dead123')).toBe('https://github.com/o/mcp-notes/commit/dead123');
    await link({ repo: 'mcp-notes', cwd: '/w/mcp-notes', shas: ['ba90ae1'] });
    expect(calls.filter((c) => c.includes('remote'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('cat-file'))).toHaveLength(1);
  });

  it('falls back to ~/<repo> when the cwd is gone, and links nothing without a clone', async () => {
    const { git } = fakeGit({ '/home/u/agentic_golang': 'https://git.tuntun.co.id/ai/chatbot/agentic' });
    const link = createCommitLinker({ homeDir: '/home/u', git });
    const out = await link({ repo: 'agentic_golang', cwd: '/gone/worktree', shas: ['9740de1'] });
    expect(out.get('9740de1')).toBe('https://git.tuntun.co.id/ai/chatbot/agentic/-/commit/9740de1');
    expect((await link({ repo: 'elsewhere', cwd: null, shas: ['9740de1'] })).size).toBe(0);
  });

  it('links a commit made in another clone to that clone, not to the session repo', async () => {
    const OTHER = 'a91b816000000000000000000000000000000000';
    const git: GitRunner = async (dir, args, input) => {
      if (args[0] === 'remote') {
        return { '/home/u/seer': 'git@github.com:o/seer.git', '/home/u/mcp-notes': 'git@github.com:o/mcp-notes.git' }[dir] ?? null;
      }
      if (args[0] === 'cat-file') {
        const own = dir === '/home/u/mcp-notes';
        return (input ?? '').trim().split('\n').map((s) => (own && OTHER.startsWith(s) ? `${OTHER} commit` : `${s} missing`)).join('\n');
      }
      return null;
    };
    const link = createCommitLinker({ homeDir: '/home/u', git, siblings: async () => ['/home/u/mcp-notes', '/home/u/seer'] });
    const out = await link({ repo: 'seer', cwd: '/home/u/seer', shas: ['a91b816', '0b6e27d'] });
    expect(out.get('a91b816')).toBe(`https://github.com/o/mcp-notes/commit/${OTHER}`);
    // Held by no clone: still linked through the session's own repo.
    expect(out.get('0b6e27d')).toBe('https://github.com/o/seer/commit/0b6e27d');
  });

  /** Git where `commonDirs` maps a checkout (or a worktree) to its absolute `--git-common-dir`. */
  function cloneGit(remotes: Record<string, string>, commonDirs: Record<string, string>, calls: string[] = []): GitRunner {
    const { git: base } = fakeGit(remotes);
    return async (dir, args, input) => {
      calls.push(`${dir} ${args.join(' ')}`);
      if (args[0] === 'rev-parse') return commonDirs[dir] === undefined ? null : `${commonDirs[dir]}\n`;
      return base(dir, args, input);
    };
  }

  it('finds the clone through another session of the repo when the cwd worktree is gone', async () => {
    const calls: string[] = [];
    const git = cloneGit({ '/home/u/proj': 'git@github.com:o/proj.git' }, { '/home/u/.worktrees/proj/alive': '/home/u/proj/.git' }, calls);
    const asked: string[] = [];
    const link = createCommitLinker({
      homeDir: '/srv/elsewhere',
      git,
      siblings: async () => [],
      knownClones: async (repo) => {
        asked.push(repo);
        return ['/home/u/.worktrees/proj/gone', '/home/u/.worktrees/proj/alive'];
      },
    });
    const out = await link({ repo: 'proj', cwd: '/home/u/.worktrees/proj/gone', shas: ['ba90ae1'] });
    // The surviving worktree leads to the main checkout, which supplies the remote and the full sha.
    expect(out.get('ba90ae1')).toBe(`https://github.com/o/proj/commit/${FULL}`);
    expect(asked).toEqual(['proj']);
    expect(calls).toContain('/home/u/proj cat-file --batch-check=%(objectname) %(objecttype)');
    await link({ repo: 'proj', cwd: '/home/u/.worktrees/proj/other-gone', shas: ['ba90ae1'] });
    expect(asked).toHaveLength(1);
  });

  it('reaches a clone in a dot dir (~/.config/nvim) that the home scan skips', async () => {
    const git = cloneGit(
      { '/home/u/.config/nvim': 'git@github.com:o/nvim-config.git' },
      { '/home/u/.config/nvim': '/home/u/.config/nvim/.git', '/home/u/.config/nvim/lua': '/home/u/.config/nvim/.git' },
    );
    const link = createCommitLinker({ homeDir: '/home/u', git, siblings: async () => [], knownClones: async () => ['/home/u/.config/nvim/lua'] });
    const out = await link({ repo: 'nvim', cwd: '/home/u/.worktrees/nvim/fix-bugs', shas: ['ba90ae1', 'dead123'] });
    expect(out.get('ba90ae1')).toBe(`https://github.com/o/nvim-config/commit/${FULL}`);
    expect(out.get('dead123')).toBe('https://github.com/o/nvim-config/commit/dead123');
  });

  it('links nothing, and does not throw, when the known clones are gone or the lookup fails', async () => {
    const git = cloneGit({}, {});
    const gone = createCommitLinker({ homeDir: '/home/u', git, siblings: async () => [], knownClones: async () => ['/home/u/.worktrees/x/a'] });
    expect((await gone({ repo: 'x', cwd: '/home/u/.worktrees/x/b', shas: ['ba90ae1'] })).size).toBe(0);
    const failing = createCommitLinker({
      homeDir: '/home/u',
      git: cloneGit({ '/home/u/x': 'git@github.com:o/x.git' }, {}),
      siblings: async () => [],
      knownClones: async () => {
        throw new Error('db down');
      },
    });
    expect((await failing({ repo: 'x', cwd: null, shas: ['ba90ae1'] })).get('ba90ae1')).toBe(`https://github.com/o/x/commit/${FULL}`);
    const failingNoHome = createCommitLinker({
      homeDir: '/home/u',
      git,
      siblings: async () => [],
      knownClones: async () => {
        throw new Error('db down');
      },
    });
    expect((await failingNoHome({ repo: 'y', cwd: null, shas: ['ba90ae1'] })).size).toBe(0);
  });
});
