import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_MARKER,
  REPORT_PERMISSION_MODE,
  StreamReporter,
  type EvidenceSnapshotter,
  type PageReport,
} from '../../../src/directStream/report.js';
import type { CommandRunner } from '../../../src/sessions/resume.js';

const SID = 'AbCdEf0123456789_-AbCdEf01234567';
const ENDED = 'ZyXwVu0123456789_-ZyXwVu01234567';
const CLAUDE = '/opt/claude/claude';
const CWD = '/home/owner/mcp-notes';
const PAGE: PageReport = {
  stage: 'error',
  error: 'networkError fragLoadError',
  errors: ['networkError fragLoadError'],
  log: ['error: networkError fragLoadError'],
  title: 'One Piece S18E787',
  position_s: 612.4,
};

let root = '';
let reportsDir = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'stream-report-'));
  reportsDir = path.join(root, 'movies', 'stream-reports');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Phase 1's snapshot, faked: a new folder per call, `complete` while the session is live. */
function fakeEvidence(live: Set<string>, flags: { fail?: boolean } = {}) {
  const calls: (string | null)[] = [];
  const evidence: EvidenceSnapshotter = {
    async snapshot(sessionId) {
      calls.push(sessionId);
      if (flags.fail === true) throw new Error('disk full');
      const dir = path.join(reportsDir, `20261116-12000${calls.length}-${(sessionId ?? 'last00').slice(0, 6)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'session.json'), '{}\n');
      return { dir, session_id: sessionId, complete: sessionId !== null && live.has(sessionId) };
    },
  };
  return { evidence, calls };
}

/** A tmux that records every call; `down` answers like a tmux with no server. */
function fakeTmux(state: { down?: boolean; failNewWindow?: boolean } = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    expect(cmd).toBe('tmux');
    calls.push([...args]);
    if (state.down === true) throw new Error('no server running on /tmp/tmux-1000/default');
    switch (args[0]) {
      case 'list-sessions':
        return '100 work\n200 note\n';
      case 'show-environment':
        return 'PATH=/usr/local/bin:/usr/bin\n';
      case 'list-clients':
        return '90 /dev/pts/2\n';
      case 'new-window':
        if (state.failNewWindow === true) throw new Error('create window failed: index in use');
        return 'note:3 %12\n';
      default:
        return '';
    }
  };
  const newWindows = (): string[][] => calls.filter((c) => c[0] === 'new-window');
  return { run, calls, newWindows, state };
}

function makeReporter(
  tmux: ReturnType<typeof fakeTmux>,
  ev: ReturnType<typeof fakeEvidence>,
  live: Set<string>,
  opts: { canRun?: boolean } = {},
): StreamReporter {
  return new StreamReporter({
    evidence: ev.evidence,
    isLive: (id) => live.has(id),
    reportsDir,
    cwd: CWD,
    window: { run: tmux.run, tmuxBin: 'tmux', tmuxSocket: null, claudeBin: CLAUDE },
    canRun: async () => opts.canRun ?? true,
    now: () => new Date('2026-11-16T05:00:00Z'),
  });
}

async function marker(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, REPORT_MARKER), 'utf8')) as Record<string, unknown>;
}

function dirOf(body: object): string {
  const dir = (body as { dir?: unknown }).dir;
  if (typeof dir !== 'string') throw new Error(`no dir in ${JSON.stringify(body)}`);
  return dir;
}

describe('StreamReporter (R4.2)', () => {
  it('snapshots at once and opens one window running /report-stream-bug on the folder, in the checkout, named after the session', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live).report(SID, PAGE);
    expect(out.status).toBe(200);
    const dir = dirOf(out.body);
    expect(out.body).toEqual({ ok: true, dir, window: 'note:3', complete: true });
    expect(ev.calls).toEqual([SID]);
    expect(tmux.newWindows()).toHaveLength(1);
    const argv = tmux.newWindows()[0]!;
    expect(argv.slice(0, 7)).toEqual(['new-window', '-t', '=note:', '-c', CWD, '-n', `stream-bug-${SID.slice(0, 6)}`]);
    expect(argv.slice(-4)).toEqual([CLAUDE, '--permission-mode', REPORT_PERMISSION_MODE, `/report-stream-bug ${dir}`]);
    expect(REPORT_PERMISSION_MODE).toBe('auto');
    // The markers a Claude Code parent would leak are scrubbed, and tmux's PATH is handed on.
    expect(argv).toEqual(expect.arrayContaining(['env', '-u', 'CLAUDECODE', 'PATH=/usr/local/bin:/usr/bin']));
    expect(await marker(dir)).toEqual({
      session_id: SID,
      dir,
      reported_at: '2026-11-16T05:00:00.000Z',
      complete: true,
      prompt: `/report-stream-bug ${dir}`,
      page: PAGE,
      result: { outcome: 'opened', window: 'note:3' },
    });
  });

  it("reports a session the daemon no longer knows from the page's own log, marked incomplete", async () => {
    const live = new Set<string>();
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live).report(ENDED, PAGE);
    expect(out).toMatchObject({ status: 200, body: { ok: true, complete: false } });
    expect(await marker(dirOf(out.body))).toMatchObject({ complete: false, page: PAGE });
  });

  it('an ended session sent with no page log, or a malformed id, is unknown_session and snapshots nothing', async () => {
    const live = new Set<string>();
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    expect(await reporter.report(ENDED, null)).toMatchObject({ status: 403, body: { error: 'unknown_session' } });
    expect(await reporter.report('../../etc', PAGE)).toMatchObject({ status: 403, body: { error: 'unknown_session' } });
    expect(ev.calls).toEqual([]);
    expect(tmux.calls).toEqual([]);
  });

  it('a failed snapshot answers snapshot_failed, remembers nothing, and a later click reports', async () => {
    const live = new Set([SID]);
    const flags = { fail: true };
    const tmux = fakeTmux();
    const ev = fakeEvidence(live, flags);
    const reporter = makeReporter(tmux, ev, live);
    expect(await reporter.report(SID, PAGE)).toEqual({ status: 500, body: { error: 'snapshot_failed', message: 'disk full' } });
    expect(tmux.newWindows()).toHaveLength(0);
    flags.fail = false;
    expect((await reporter.report(SID, PAGE)).status).toBe(200);
  });
});

describe('StreamReporter: one report per session (R4.3)', () => {
  it('a second click opens no second window and answers already_reported with the first folder', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    const first = await reporter.report(SID, PAGE);
    const dir = dirOf(first.body);
    expect(await reporter.report(SID, PAGE)).toEqual({ status: 409, body: { error: 'already_reported', dir } });
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });

  it('two clicks at once make one snapshot and one window', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    const outs = await Promise.all([reporter.report(SID, PAGE), reporter.report(SID, PAGE)]);
    expect(outs.map((o) => o.status).sort()).toEqual([200, 409]);
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });

  it('a restarted daemon remembers the report by its marker file', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const dir = dirOf((await makeReporter(tmux, ev, live).report(SID, PAGE)).body);
    const afterRestart = makeReporter(tmux, ev, live);
    expect(await afterRestart.report(SID, PAGE)).toEqual({ status: 409, body: { error: 'already_reported', dir } });
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });
});

describe('StreamReporter: the snapshot is kept when no window opens (R4.4)', () => {
  it('no tmux: answers no_tmux with the folder, keeps it, and a later click opens it on the same folder', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux({ down: true });
    const ev = fakeEvidence(live);
    const reporter = makeReporter(tmux, ev, live);
    const first = await reporter.report(SID, PAGE);
    const dir = dirOf(first.body);
    expect(first).toEqual({ status: 409, body: { error: 'no_tmux', dir, complete: true } });
    expect((await stat(path.join(dir, 'session.json'))).isFile()).toBe(true);
    expect(await marker(dir)).toMatchObject({ result: { outcome: 'no_tmux' } });
    tmux.state.down = false;
    expect(await reporter.report(SID, PAGE)).toEqual({ status: 200, body: { ok: true, dir, window: 'note:3', complete: true } });
    expect(ev.calls).toHaveLength(1);
    expect(tmux.newWindows()).toHaveLength(1);
  });

  it('a claude binary that cannot be run: spawn_failed with the folder, and no window is tried', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux();
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live, { canRun: false }).report(SID, PAGE);
    expect(out).toMatchObject({ status: 500, body: { error: 'spawn_failed', complete: true } });
    expect((out.body as { message: string }).message).toContain(CLAUDE);
    expect(tmux.newWindows()).toHaveLength(0);
    expect(await marker(dirOf(out.body))).toMatchObject({ result: { outcome: 'spawn_failed' } });
  });

  it('new-window fails: spawn_failed with tmux\'s message and the folder kept', async () => {
    const live = new Set([SID]);
    const tmux = fakeTmux({ failNewWindow: true });
    const ev = fakeEvidence(live);
    const out = await makeReporter(tmux, ev, live).report(SID, PAGE);
    const dir = dirOf(out.body);
    expect(out).toEqual({ status: 500, body: { error: 'spawn_failed', dir, message: 'create window failed: index in use', complete: true } });
    expect((await stat(path.join(dir, 'session.json'))).isFile()).toBe(true);
  });
});
