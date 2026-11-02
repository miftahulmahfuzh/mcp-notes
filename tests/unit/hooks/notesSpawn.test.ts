import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSpawn, mayLaunchClaude, runSpawn, shellTokens, type FetchLike } from '../../../claude/hooks/notes-spawn.mjs';

const SID = '0ef363d6-0bdd-4a15-aff7-71f0821bd6ee';
const CTX = { cwd: '/home/u/mcp-notes', home: '/home/u' };

describe('detectSpawn', () => {
  const cases: [string, { cwd: string; name: string | null } | null][] = [
    [`tmux new-window -n foo -c /work/repo "claude -n foo 'do it'"`, { cwd: '/work/repo', name: 'foo' }],
    [`tmux split-window -h -c "#{pane_current_path}" claude`, { cwd: '/home/u/mcp-notes', name: null }],
    [`tmux send-keys -t main:1 'cd ~/x && claude --name bar' Enter`, { cwd: '/home/u/x', name: 'bar' }],
    [`tmux new-window -dP -F '#{pane_id}' -c ../sib 'exec claude'`, { cwd: '/home/u/sib', name: null }],
    [`tmux new-window bash -lc 'claude -n z'`, { cwd: '/home/u/mcp-notes', name: 'z' }],
    [`cd /a && tmux new-window -c sub claude`, { cwd: '/a/sub', name: null }],
    [`tmux new-window -c "$HOME/p" "FOO=1 claude --name=q"`, { cwd: '/home/u/p', name: 'q' }],
    [`tmux -L other new-session -d -s s -c /srv claude`, { cwd: '/srv', name: null }],
    [`python3 ~/.claude/skills/swarm/swarm.py spawn --name x && tmux new-window claude`, null],
    [`tmux new-window -e CC_PARENT_SESSION=abc claude`, null],
    [`tmux new-window "claude --resume abc"`, null],
    [`tmux new-window "claude -c"`, null],
    [`tmux new-window "claude -p hi"`, null],
    [`tmux list-windows | grep claude`, null],
    [`echo "tmux new-window claude"`, null],
    [`tmux new-window vim`, null],
    [`ls -la`, null],
  ];
  for (const [command, expected] of cases) {
    it(command, () => {
      expect(detectSpawn(command, CTX)).toEqual(expected);
    });
  }
});

describe('shellTokens / mayLaunchClaude', () => {
  it('splits on operators but keeps quotes, $( ) and 2>&1 inside words', () => {
    const words = shellTokens(`a "b c" 'd' $(pwd) 2>&1 && e; f | g`).map((t) => t.word ?? t.op);
    expect(words).toEqual(['a', 'b c', 'd', '$(pwd)', '2>&1', '&&', 'e', ';', 'f', '|', 'g']);
  });

  it('is a cheap word test that excludes swarm.py and CC_PARENT_SESSION', () => {
    expect(mayLaunchClaude('git status')).toBe(false);
    expect(mayLaunchClaude('tmux ls')).toBe(false);
    expect(mayLaunchClaude('tmux new-window claude')).toBe(true);
    expect(mayLaunchClaude('swarm.py launch tmux claude')).toBe(false);
    expect(mayLaunchClaude(42)).toBe(false);
  });
});

describe('runSpawn', () => {
  let tmp: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-spawn-'));
    env = { HOME: tmp, XDG_STATE_HOME: path.join(tmp, 'state'), NOTESD_PORT: '7499', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function fake(response: () => Response): { fetchImpl: FetchLike; calls: { url: string; header: string | null; body: unknown }[] } {
    const calls: { url: string; header: string | null; body: unknown }[] = [];
    return {
      calls,
      fetchImpl: async (url, init) => {
        calls.push({ url, header: new Headers(init.headers).get('x-notes-capture'), body: JSON.parse(String(init.body)) });
        return response();
      },
    };
  }

  const bash = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    session_id: SID,
    cwd: '/work/repo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    ...extra,
  });

  it('records a pending spawn and returns null (no decision)', async () => {
    const { fetchImpl, calls } = fake(() => new Response(JSON.stringify({ recorded: true }), { status: 201 }));
    const out = await runSpawn({ input: bash(`tmux new-window -c /work/repo "claude -n kid"`), env, fetchImpl, hostname: () => 'lenovo' });
    expect(out).toBeNull();
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:7499/api/sessions/hook/spawn',
        header: '1',
        body: { parent: SID, cwd: '/work/repo', name: 'kid', host: 'lenovo' },
      },
    ]);
  });

  it('does no I/O for other tools, ordinary commands, swarm launches and non-cli sessions', async () => {
    const { fetchImpl, calls } = fake(() => new Response('{}', { status: 201 }));
    await runSpawn({ input: { ...bash('tmux new-window claude'), tool_name: 'Read' }, env, fetchImpl });
    await runSpawn({ input: bash('npm test'), env, fetchImpl });
    await runSpawn({ input: bash('python3 swarm.py spawn --name x'), env, fetchImpl });
    await runSpawn({ input: bash('tmux new-window claude'), env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, fetchImpl });
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('logs and still returns null when the daemon is down', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await runSpawn({ input: bash('tmux new-window claude'), env, fetchImpl: down })).toBeNull();
    expect(await readFile(path.join(tmp, 'state', 'notes-capture', 'spawn.log'), 'utf8')).toMatch(/fetch failed/);
  });
});
