import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildContext,
  candidatePids,
  nameFromArgv,
  parentFrom,
  runSession,
  tmuxTarget,
  type FetchLike,
} from '../../../claude/hooks/notes-session.mjs';

const SID = '0ef363d6-0bdd-4a15-aff7-71f0821bd6ee';
const PARENT = 'cc6491fc-1111-4222-8333-944444444444';
const NOW = Date.parse('2026-11-02T03:00:00.000Z');

let tmp: string;
let env: Record<string, string>;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'notes-session-'));
  env = {
    HOME: tmp,
    XDG_STATE_HOME: path.join(tmp, 'state'),
    NOTESD_PORT: '7499',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_PID: '4242',
  };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Call {
  url: string;
  header: string | null;
  body: Record<string, unknown>;
}

function fakeFetch(response: () => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, header: new Headers(init.headers).get('x-notes-capture'), body: JSON.parse(String(init.body)) });
    return response();
  };
  return { fetchImpl, calls };
}

const reply = (extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ session_id: SID, node_id: 'A0-3G', parent_session_id: null, parent_node_id: null, parent_link_source: null, claimed: false, ...extra }), { status: 200 });

function files(map: Record<string, string>): (file: string) => Promise<string> {
  return async (file) => {
    const text = map[file];
    if (text === undefined) throw Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
    return text;
  };
}

const noTmux = async (): Promise<string> => {
  throw new Error('no tmux');
};

function input(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: SID, transcript_path: '/t/s.jsonl', cwd: '/work/repo', hook_event_name: 'SessionStart', source: 'startup', ...extra };
}

describe('runSession', () => {
  it('posts the start with the registry name/tmux and the env parent, and returns the node ids as context', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply({ parent_session_id: PARENT, parent_node_id: 'B1-2C', parent_link_source: 'env' }));
    const readText = files({
      [path.join(tmp, '.claude', 'sessions', '4242.json')]: JSON.stringify({ sessionId: SID, name: 'impl-x-p5', tmux: 'iter1:@12.%34' }),
    });
    const out = await runSession({
      input: input(),
      env: { ...env, CC_PARENT_SESSION: PARENT },
      fetchImpl,
      readText,
      runTmux: noTmux,
      now: () => NOW,
      ppid: 1,
      hostname: () => 'lenovo',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:7499/api/sessions/hook/start');
    expect(calls[0]!.header).toBe('1');
    expect(calls[0]!.body).toEqual({
      session: SID,
      parent: PARENT,
      cwd: '/work/repo',
      name: 'impl-x-p5',
      tmux: 'iter1:@12.%34',
      host: 'lenovo',
      started_at: '2026-11-02T03:00:00.000Z',
      source: 'startup',
      transcript_path: '/t/s.jsonl',
    });
    expect(out?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out?.hookSpecificOutput.additionalContext).toContain('node A0-3G');
    expect(out?.hookSpecificOutput.additionalContext).toContain('spawned by node B1-2C');
  });

  it('falls back to the claude argv for the name and tmux display-message for the pane', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply());
    const readText = files({ '/proc/4242/cmdline': ['/usr/bin/claude', '-n', 'scratch', 'hello'].join('\0') });
    const seen: string[][] = [];
    await runSession({
      input: input(),
      env: { ...env, TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%9' },
      fetchImpl,
      readText,
      runTmux: async (args) => {
        seen.push(args);
        return 'main:@3.%9\n';
      },
      now: () => NOW,
      ppid: 1,
      hostname: () => 'lenovo',
    });
    expect(calls[0]!.body.name).toBe('scratch');
    expect(calls[0]!.body.tmux).toBe('main:@3.%9');
    expect(seen).toEqual([['display-message', '-p', '-t', '%9', '#{session_name}:#{window_id}.#{pane_id}']]);
  });

  it('keeps the bare pane id when tmux cannot answer, and sends null tmux outside tmux', async () => {
    expect(await tmuxTarget({ TMUX: 'x', TMUX_PANE: '%7' }, noTmux)).toBe('%7');
    expect(await tmuxTarget({ TMUX_PANE: '%7' }, noTmux)).toBeNull();
    expect(await tmuxTarget({ TMUX: 'x', TMUX_PANE: 'bogus' }, noTmux)).toBeNull();
  });

  it('resume and compact send no started_at but still return the context', async () => {
    for (const source of ['resume', 'compact']) {
      const { fetchImpl, calls } = fakeFetch(() => reply());
      const out = await runSession({ input: input({ source }), env, fetchImpl, readText: files({}), runTmux: noTmux, now: () => NOW, ppid: 1, hostname: () => 'h' });
      expect(calls[0]!.body.started_at).toBeNull();
      expect(calls[0]!.body.source).toBe(source);
      expect(out?.hookSpecificOutput.additionalContext).toContain('A0-3G');
    }
  });

  it('does nothing at all for a non-cli session', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply());
    const out = await runSession({ input: input(), env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' }, fetchImpl, readText: files({}), runTmux: noTmux });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(tmp, 'state'))).toBe(false);
  });

  it('daemon down, an error status or a reply without a node id: no output, one log line', async () => {
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await runSession({ input: input(), env, fetchImpl: down, readText: files({}), runTmux: noTmux, ppid: 1 })).toBeNull();
    const bad = fakeFetch(() => new Response('nope', { status: 500 }));
    expect(await runSession({ input: input(), env, fetchImpl: bad.fetchImpl, readText: files({}), runTmux: noTmux, ppid: 1 })).toBeNull();
    const empty = fakeFetch(() => new Response(JSON.stringify({ node_id: 'not-an-id' }), { status: 200 }));
    expect(await runSession({ input: input(), env, fetchImpl: empty.fetchImpl, readText: files({}), runTmux: noTmux, ppid: 1 })).toBeNull();
    const log = await readFile(path.join(tmp, 'state', 'notes-capture', 'session.log'), 'utf8');
    expect(log.trim().split('\n')).toHaveLength(3);
  });

  it('ignores an input without a valid session id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => reply());
    expect(await runSession({ input: { session_id: '' }, env, fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('parentFrom drops a blank, malformed or self parent', () => {
    expect(parentFrom({ CC_PARENT_SESSION: ` ${PARENT}\n` }, SID)).toBe(PARENT);
    expect(parentFrom({ CC_PARENT_SESSION: SID }, SID)).toBeNull();
    expect(parentFrom({ CC_PARENT_SESSION: '  ' }, SID)).toBeNull();
    expect(parentFrom({ CC_PARENT_SESSION: 'x y' }, SID)).toBeNull();
    expect(parentFrom({}, SID)).toBeNull();
  });

  it('candidatePids takes CLAUDE_PID then ppid, distinct and numeric', () => {
    expect(candidatePids({ CLAUDE_PID: '42' }, 7)).toEqual(['42', '7']);
    expect(candidatePids({ CLAUDE_PID: '42' }, 42)).toEqual(['42']);
    expect(candidatePids({ CLAUDE_PID: 'abc' }, undefined)).toEqual([]);
  });

  it('nameFromArgv reads -n, --name and --name= of a claude argv only', () => {
    expect(nameFromArgv(['claude', '-n', 'a'])).toBe('a');
    expect(nameFromArgv(['/x/claude.exe', '--name', 'b c'])).toBe('b c');
    expect(nameFromArgv(['node', '/x/@anthropic-ai/claude-code/cli.js', '--name=z'])).toBe('z');
    expect(nameFromArgv(['vim', '-n', 'a'])).toBeNull();
    expect(nameFromArgv(['claude'])).toBeNull();
  });

  it('buildContext names the parent session when it has no node id yet, and says when there is none', () => {
    expect(buildContext({ node_id: 'A0-3G', parent_session_id: PARENT, parent_node_id: null, parent_link_source: 'env' })).toContain(
      `spawned by Claude Code session ${PARENT}`,
    );
    expect(buildContext({ node_id: 'A0-3G' })).toContain('No parent session is recorded');
  });
});
