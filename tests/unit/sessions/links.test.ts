import { describe, expect, it } from 'vitest';

import {
  extractIntents,
  intentWindow,
  matchIntent,
  parseSwarmCommand,
  planLinks,
  sendMessageTarget,
  stripHeredocs,
  swarmChildName,
  swarmSlugify,
  type LinkSession,
  type SpawnIntent,
} from '../../../src/sessions/links.js';

const HOME = '/home/miftah';
const WT = '/home/miftah/.worktrees/mcp-notes/wall-editing';
const parse = (cmd: string, cwd: string | null = WT) => parseSwarmCommand(cmd, { cwd, home: HOME });
const names = (cmd: string, cwd: string | null = WT) => parse(cmd, cwd).map((p) => p.name);

describe('swarm.py naming', () => {
  it('names a phase child like child_name', () => {
    expect(swarmChildName('impl', 'wall-editing', 3)).toBe('impl-wall-editing-p3');
    expect(swarmChildName('fix', 'a b/c', 12)).toBe('fix-a-b-c-p12');
  });

  it('truncates the slug, never the phase tail, at 60 characters', () => {
    const name = swarmChildName('impl', 'x'.repeat(80), 12);
    expect(name).toHaveLength(60);
    expect(name.endsWith('-p12')).toBe(true);
    expect(name.startsWith('impl-xxx')).toBe(true);
  });

  it('slugifies like swarm.py', () => {
    expect(swarmSlugify('  orch wall/editing  ')).toBe('orch-wall-editing');
    expect(swarmSlugify('.-orch-x-.')).toBe('orch-x');
    expect(swarmSlugify('---')).toBe('swarm');
    expect(swarmSlugify('y'.repeat(70))).toHaveLength(60);
  });
});

describe('parseSwarmCommand on commands measured in cc6491fc (orch-wall-editing)', () => {
  it('ignores --help calls', () => {
    expect(
      parse(
        'S=~/.claude/skills/swarm/swarm.py; python3 $S init --help | sed -n 1,30p; python3 $S spawn --help | sed -n 1,40p; python3 $S report --help | sed -n 1,30p',
      ),
    ).toEqual([]);
  });

  it('ignores --dry-run', () => {
    expect(
      parse(
        'python3 ~/.claude/skills/swarm/swarm.py spawn --slug wall-editing --phase 1 --permission-mode bypassPermissions --dry-run; python3 ~/.claude/skills/task/session.py rename "orch-wall-editing" --no-widen',
      ),
    ).toEqual([]);
  });

  it('expands $S and a for-loop over phases', () => {
    const cmd =
      'S=~/.claude/skills/swarm/swarm.py; for n in 1 11; do python3 $S spawn --slug wall-editing --phase $n --permission-mode bypassPermissions | python3 -c "import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in (\'name\',\'window\',\'pane\',\'spawned\',\'error\')})"; done';
    expect(parse(cmd)).toEqual([
      { kind: 'spawn', name: 'impl-wall-editing-p1', cwd: null },
      { kind: 'spawn', name: 'impl-wall-editing-p11', cwd: null },
    ]);
  });

  it('skips report/verify/reap/waves and finds the spawn loop after them', () => {
    const cmd = [
      'S=~/.claude/skills/swarm/swarm.py; python3 $S report --slug wall-editing --phase 2 --status done --commit 42f05d5 --task P1-NOTES-A024 --note "server cut over; unit 641, int 253" >/dev/null; python3 $S verify --slug wall-editing --apply >/dev/null; python3 $S reap --slug wall-editing | grep -E \'"how"\'; python3 $S waves --slug wall-editing | python3 -c "import json,sys;print(1)"; for n in 3 5 6; do python3 $S spawn --slug wall-editing --phase $n --permission-mode bypassPermissions | grep -E \'"name"|"window"|error\'; done; git pull -q --ff-only; L=.workflows/orchestration/wall-editing/ledger.json; cp /home/miftah/mcp-notes/$L $L && export GIT_INDEX_FILE=/tmp/claude-1000/orchidx.$$ && git read-tree HEAD && git add $L && git commit -q -m "orchestration(wall-editing): phase 2 done (42f05d5); phases 3, 5, 6 spawned',
      '',
      'Co-Authored-By: Someone <someone@example.com>" && rm -f $GIT_INDEX_FILE && unset GIT_INDEX_FILE && git push -q; sleep 25',
    ].join('\n');
    expect(names(cmd)).toEqual(['impl-wall-editing-p3', 'impl-wall-editing-p5', 'impl-wall-editing-p6']);
  });

  it('reads launch --name/--cwd with $HOME after a cd (930c1249 launching the orch)', () => {
    const cmd = [
      'cd $HOME/.worktrees/mcp-notes/wall-editing && git add docs && git commit -q -m "plan(wall-editing): iteration 7',
      '',
      'Co-Authored-By: Someone <someone@example.com>" && git log --oneline -1 && python3 ~/.claude/skills/swarm/swarm.py launch --name "orch-wall-editing" --cwd "$HOME/.worktrees/mcp-notes/wall-editing" --permission-mode bypassPermissions --prompt "/analyze-orchestrator -f docs/plans/WALL_EDITING_PLAN.md"',
    ].join('\n');
    expect(parse(cmd, '/home/miftah/mcp-notes')).toEqual([
      { kind: 'launch', name: 'orch-wall-editing', cwd: WT },
    ]);
  });
});

describe('parseSwarmCommand, other measured shapes', () => {
  it('handles `for N in` with echo in the body', () => {
    const cmd =
      'cd /home/miftah/agentic_golang && for N in 1 4 5 6; do echo "=== phase $N ==="; python3 ~/.claude/skills/swarm/swarm.py spawn --slug uatp-4258-remaining --phase $N --permission-mode bypassPermissions 2>&1 | grep -v "FakeAssoc"; done';
    expect(names(cmd)).toEqual([
      'impl-uatp-4258-remaining-p1',
      'impl-uatp-4258-remaining-p4',
      'impl-uatp-4258-remaining-p5',
      'impl-uatp-4258-remaining-p6',
    ]);
  });

  it('drops heredoc bodies that quote swarm commands', () => {
    const cmd = [
      "cd /home/miftah/seer && read -r -d '' EXTRA <<'EOF' || true",
      'Brief: never run python3 ~/.claude/skills/swarm/swarm.py spawn --slug nope --phase 9 yourself.',
      'EOF',
      'python3 ~/.claude/skills/swarm/swarm.py spawn --slug lab-shortfall --phase 2 --prompt "$EXTRA"',
    ].join('\n');
    expect(names(cmd)).toEqual(['impl-lab-shortfall-p2']);
  });

  it('follows line continuations and --flag=value', () => {
    const cmd =
      'python3 ~/.claude/skills/swarm/swarm.py launch \\\n    --name "orch-popup-data-refactor" \\\n    --cwd "/home/miftah/.worktrees/agentic/popup-data-refactor" \\\n    --prompt "/analyze-orchestrator"';
    expect(parse(cmd, '/home/miftah/agentic')).toEqual([
      { kind: 'launch', name: 'orch-popup-data-refactor', cwd: '/home/miftah/.worktrees/agentic/popup-data-refactor' },
    ]);
    expect(names('python3 ~/.claude/skills/swarm/swarm.py spawn --slug=x --phase=4 --prefix fix')).toEqual(['fix-x-p4']);
  });

  it('expands brace ranges in loops', () => {
    expect(names('for n in {1..3}; do python3 ~/.claude/skills/swarm/swarm.py spawn --slug s --phase $n; done')).toEqual([
      'impl-s-p1',
      'impl-s-p2',
      'impl-s-p3',
    ]);
  });

  it('defaults a launch cwd to the tool call cwd, moved by cd', () => {
    expect(parse('python3 ~/.claude/skills/swarm/swarm.py launch --name analyze-x --prompt p', '/home/miftah/seer')).toEqual([
      { kind: 'launch', name: 'analyze-x', cwd: '/home/miftah/seer' },
    ]);
    expect(parse('cd ../seer && python3 ~/.claude/skills/swarm/swarm.py launch --name a --prompt p', '/home/miftah/notes')).toEqual([
      { kind: 'launch', name: 'a', cwd: '/home/miftah/seer' },
    ]);
  });

  it('gives up on unknown variables and on swarm.py that is not executed', () => {
    expect(parse('python3 ~/.claude/skills/swarm/swarm.py spawn --slug x --phase $UNKNOWN')).toEqual([]);
    expect(parse('python3 ~/.claude/skills/swarm/swarm.py launch --name "$NAME" --prompt p')).toEqual([]);
    expect(parse('grep -n spawn ~/.claude/skills/swarm/swarm.py')).toEqual([]);
    expect(parse('python3 -c "print(\'swarm.py spawn --slug x --phase 1\')"')).toEqual([]);
    expect(parse('ls ~/.claude/skills/swarm/')).toEqual([]);
  });

  it('treats an executable swarm.py as the command itself', () => {
    expect(names('~/.claude/skills/swarm/swarm.py spawn --slug x --phase 2')).toEqual(['impl-x-p2']);
  });
});

describe('stripHeredocs', () => {
  it('keeps here-strings and unterminated text intact', () => {
    expect(stripHeredocs('cat <<<"abc"; echo hi')).toBe('cat <<<"abc"; echo hi');
    expect(stripHeredocs("cat <<-'X'\nbody\n  X\nafter")).toBe("cat <<-'X'\nafter");
  });
});

describe('sendMessageTarget', () => {
  it('reads to, then recipient, then the unparsed raw input', () => {
    expect(sendMessageTarget({ to: 'impl-wall-editing-p3', recipient: 'impl-wall-editing-p3' })).toBe('impl-wall-editing-p3');
    expect(sendMessageTarget({ recipient: 'orch-x' })).toBe('orch-x');
    expect(
      sendMessageTarget({ __unparsedToolInput: { raw: '{"to": "impl-uatp-4258-remaining-p1", "summary": "x' } }),
    ).toBe('impl-uatp-4258-remaining-p1');
  });

  it('rejects sockets, main, blanks and garbage', () => {
    expect(sendMessageTarget({ to: 'uds:/run/user/1000/cc-socks/1925001.sock' })).toBeNull();
    expect(sendMessageTarget({ to: 'main' })).toBeNull();
    expect(sendMessageTarget({ to: '' })).toBeNull();
    expect(sendMessageTarget({ to: 42 })).toBeNull();
    expect(sendMessageTarget(null)).toBeNull();
  });
});

describe('extractIntents', () => {
  const base = {
    type: 'assistant',
    sessionId: 'cc6491fc-2dc1-4f2d-9d28-db3fbf6baa0a',
    cwd: WT,
    timestamp: '2026-10-30T09:36:25.606Z',
    entrypoint: 'cli',
    isSidechain: false,
  };

  it('returns SendMessage and Bash intents with the record time', () => {
    const rec = {
      ...base,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sending' },
          { type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: 'impl-wall-editing-p3', message: 'rules' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'python3 ~/.claude/skills/swarm/swarm.py spawn --slug wall-editing --phase 4' } },
        ],
      },
    };
    expect(extractIntents(rec, { home: HOME })).toEqual([
      { parentSessionId: base.sessionId, kind: 'message', name: 'impl-wall-editing-p3', at: new Date(base.timestamp), cwd: null },
      { parentSessionId: base.sessionId, kind: 'spawn', name: 'impl-wall-editing-p4', at: new Date(base.timestamp), cwd: null },
    ]);
  });

  it('uses the caller-given parent over the record sessionId', () => {
    const rec = { ...base, message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'a-b' } }] } };
    expect(extractIntents(rec, { home: HOME, parentSessionId: 'owner' })[0]?.parentSessionId).toBe('owner');
  });

  it('ignores other record types, missing timestamps and other tools', () => {
    expect(extractIntents({ ...base, type: 'user', message: { content: [] } }, { home: HOME })).toEqual([]);
    expect(
      extractIntents({ ...base, timestamp: undefined, message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'x' } }] } }, { home: HOME }),
    ).toEqual([]);
    expect(
      extractIntents({ ...base, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'swarm.py' } }] } }, { home: HOME }),
    ).toEqual([]);
    expect(extractIntents('not a record', { home: HOME })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

const T = Date.parse('2026-10-30T09:19:49.264Z');
const at = (ms: number) => new Date(T + ms);

function session(over: Partial<LinkSession> & { sessionId: string }): LinkSession {
  return {
    host: 'lenovo',
    repo: 'mcp-notes',
    cwd: WT,
    name: null,
    customTitle: null,
    startedAt: at(0),
    parentSessionId: null,
    parentLinkSource: null,
    ...over,
  };
}

const ORCH = session({ sessionId: 'orch', name: 'orch-wall-editing', customTitle: 'orch-wall-editing', startedAt: at(-200_000) });

function intent(over: Partial<SpawnIntent>): SpawnIntent {
  return { parentSessionId: 'orch', kind: 'spawn', name: 'impl-wall-editing-p1', at: at(0), cwd: null, ...over };
}

describe('intentWindow', () => {
  it('opens after a spawn and before a message', () => {
    const s = intentWindow(intent({}));
    expect(s.from.getTime()).toBe(T - 10_000);
    expect(s.to.getTime()).toBe(T + 300_000);
    const m = intentWindow(intent({ kind: 'message' }));
    expect(m.from.getTime()).toBe(T - 6 * 3_600_000);
    expect(m.to.getTime()).toBe(T + 10_000);
  });
});

describe('matchIntent', () => {
  const p1 = session({ sessionId: 'p1', name: 'impl-wall-editing-p1', startedAt: at(3_808) });
  const p1Old = session({ sessionId: 'p1-old', name: 'impl-wall-editing-p1', startedAt: at(-86_400_000) });
  const p1Relaunch = session({ sessionId: 'p1-again', name: 'impl-wall-editing-p1', startedAt: at(120_000) });

  it('takes the earliest child inside a spawn window, not an older session with the same name', () => {
    expect(matchIntent(intent({}), ORCH, [p1Old, p1Relaunch, p1])?.sessionId).toBe('p1');
  });

  it('takes the latest child started before a message', () => {
    expect(matchIntent(intent({ kind: 'message', at: at(150_000) }), ORCH, [p1, p1Relaunch, p1Old])?.sessionId).toBe('p1-again');
  });

  it('never links a session that started before the parent (a child messaging its coordinator)', () => {
    const child = session({ sessionId: 'p3', name: 'impl-wall-editing-p3', startedAt: at(0) });
    const reply = intent({ parentSessionId: 'p3', kind: 'message', name: 'orch-wall-editing', at: at(60_000) });
    expect(matchIntent(reply, child, [ORCH])).toBeNull();
  });

  it('requires the same host, and the same repo when both are known', () => {
    expect(matchIntent(intent({}), ORCH, [{ ...p1, host: 'gpd' }])).toBeNull();
    expect(matchIntent(intent({}), ORCH, [{ ...p1, repo: 'seer' }])).toBeNull();
    expect(matchIntent(intent({}), ORCH, [{ ...p1, repo: null }])?.sessionId).toBe('p1');
  });

  it('accepts a launch into another repo when the cwd matches', () => {
    const child = session({ sessionId: 'a', name: 'analyze-x', repo: 'seer', cwd: '/home/miftah/seer', startedAt: at(2_000) });
    expect(matchIntent(intent({ kind: 'launch', name: 'analyze-x', cwd: '/home/miftah/seer' }), ORCH, [child])?.sessionId).toBe('a');
  });

  it('matches custom_title when name differs', () => {
    const child = session({ sessionId: 'c', name: 'renamed', customTitle: 'impl-wall-editing-p1', startedAt: at(4_000) });
    expect(matchIntent(intent({}), ORCH, [child])?.sessionId).toBe('c');
  });
});

describe('planLinks', () => {
  const parents = new Map([[ORCH.sessionId, ORCH]]);

  it('links each child once, preferring a spawn over a message', () => {
    const p3 = session({ sessionId: 'p3', name: 'impl-wall-editing-p3', startedAt: at(3_000) });
    const spawn = intent({ name: 'impl-wall-editing-p3' });
    const msg = intent({ kind: 'message', name: 'impl-wall-editing-p3', at: at(40_000) });
    const plan = planLinks([msg, spawn], parents, [p3]);
    expect(plan.links).toEqual([{ childSessionId: 'p3', parentSessionId: 'orch', intent: spawn }]);
    expect(plan.resolved.size).toBe(2);
  });

  it('resolves but does not relink a child that already has a parent', () => {
    const p2 = session({ sessionId: 'p2', name: 'impl-wall-editing-p2', startedAt: at(2_000), parentSessionId: 'x', parentLinkSource: 'hook' });
    const i = intent({ name: 'impl-wall-editing-p2' });
    const plan = planLinks([i], parents, [p2]);
    expect(plan.links).toEqual([]);
    expect(plan.resolved.has(i)).toBe(true);
  });

  it('leaves an intent unresolved when its parent or child is not ingested yet', () => {
    const orphan = intent({ parentSessionId: 'unknown' });
    const early = intent({ name: 'impl-wall-editing-p9' });
    const plan = planLinks([orphan, early], parents, []);
    expect(plan.links).toEqual([]);
    expect(plan.resolved.size).toBe(0);
  });
});
