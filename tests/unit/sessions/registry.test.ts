import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLiveRegistry, isPidAlive, parseLiveEntry, readLiveRegistry, readLiveSessions } from '../../../src/sessions/registry.js';
import { copyFixtureClaudeHome, FIXTURE } from '../../helpers/claudeHome.js';

let home: string;
beforeEach(async () => {
  home = await copyFixtureClaudeHome();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('readLiveRegistry', () => {
  it('returns live entries by session id and skips dead pids, .key files and junk', async () => {
    await writeFile(path.join(home, 'sessions', '777.json'), '{not json');
    const checked: Array<[number, string | null]> = [];
    const live = await readLiveRegistry({
      claudeHome: home,
      isAlive: (pid, procStart) => {
        checked.push([pid, procStart]);
        return pid === 4242;
      },
    });
    expect([...live.keys()]).toEqual([FIXTURE.main]);
    expect(live.get(FIXTURE.main)).toMatchObject({
      pid: 4242,
      tmux: 'note:@0.%7',
      name: 'session-graph-discussion',
      status: 'busy',
      cwd: '/home/u/mcp-notes',
      messagingSocketPath: '/run/user/1000/cc-socks/4242.sock',
    });
    expect(live.get(FIXTURE.main)?.updatedAt?.getTime()).toBe(1793585600000);
    expect(checked).toContainEqual([4242, '303782']);
    expect(checked).toContainEqual([999, '1000']);
  });

  it('lists the same entries for the summary worker', async () => {
    const list = await readLiveSessions(home, (pid) => pid === 4242);
    expect(list.map((s) => s.sessionId)).toEqual([FIXTURE.main]);
  });

  it('is empty without a sessions dir', async () => {
    expect((await readLiveRegistry({ claudeHome: path.join(home, 'nope') })).size).toBe(0);
  });

  it('prefers the most recently updated entry for a session id', async () => {
    await writeFile(
      path.join(home, 'sessions', '5000.json'),
      JSON.stringify({ pid: 5000, sessionId: FIXTURE.main, status: 'idle', updatedAt: 1793585700000 }),
    );
    const live = await readLiveRegistry({ claudeHome: home, isAlive: (pid) => pid !== 999 });
    expect(live.get(FIXTURE.main)?.pid).toBe(5000);
  });
});

describe('parseLiveEntry', () => {
  it('rejects entries without a pid or session id', () => {
    expect(parseLiveEntry({ sessionId: 'x' })).toBeNull();
    expect(parseLiveEntry({ pid: 1 })).toBeNull();
    expect(parseLiveEntry([])).toBeNull();
    expect(parseLiveEntry({ pid: 1, sessionId: 'x', procStart: 12 })?.procStart).toBe('12');
  });
});

describe('isPidAlive', () => {
  it('sees this process as alive and a recycled pid as dead', () => {
    expect(isPidAlive(process.pid, null)).toBe(true);
    expect(isPidAlive(2 ** 22 + 12345, null)).toBe(false);
    if (process.platform === 'linux') expect(isPidAlive(process.pid, 'not-the-start-time')).toBe(false);
  });
});

describe('createLiveRegistry', () => {
  it('re-reads only after the ttl', async () => {
    let t = 0;
    let reads = 0;
    const registry = createLiveRegistry({
      claudeHome: home,
      ttlMs: 1000,
      now: () => t,
      isAlive: (pid) => {
        reads += 1;
        return pid === 4242;
      },
    });
    await registry.get();
    await registry.get();
    const afterFirst = reads;
    t = 1500;
    await registry.get();
    expect(reads).toBe(afterFirst * 2);
    registry.invalidate();
    await registry.get();
    expect(reads).toBe(afterFirst * 3);
  });
});
