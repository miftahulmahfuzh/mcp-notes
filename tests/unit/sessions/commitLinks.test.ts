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
});
