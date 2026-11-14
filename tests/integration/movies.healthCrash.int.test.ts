import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { WSL_INTEROP_FILES } from '../../src/http/reveal.js';
import { healthLogPath, parseHealthLine, type HealthRecord, type HealthReport, type IncidentRecord, type SampleRecord } from '../../src/movies/vlc/health.js';
import { testDatabaseUrl } from './setup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_WINDOWS = path.join(ROOT, 'tests/fixtures/movies/fake-windows.mjs');
const WSL = WSL_INTEROP_FILES.some((f) => existsSync(f));

interface Child {
  proc: ChildProcess;
  port: number;
  exited: Promise<number | null>;
}

async function startChild(env: NodeJS.ProcessEnv): Promise<Child> {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  let out = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon did not listen within 30 s:\n${out}`)), 30_000);
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m !== null) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.stderr?.on('data', (b: Buffer) => {
      out += b.toString();
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited ${code} during startup:\n${out}`));
    });
  });
  return { proc, port, exited };
}

async function records(file: string): Promise<HealthRecord[]> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .map(parseHealthLine)
      .filter((r): r is HealthRecord => r !== null);
  } catch {
    return [];
  }
}

describe.skipIf(!WSL)('VLC health across a daemon crash', () => {
  let dir = '';
  const children: ChildProcess[] = [];

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    if (dir !== '') await rm(dir, { recursive: true, force: true });
  });

  it('R8.2: a daemon SIGKILLed while sampling a vlc.exe leaves its samples; the next start writes one incident with the Windows events and serves it (R8.1, R8.5)', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'notesd-health-crash-'));
    const dataDir = path.join(dir, 'data');
    const state = path.join(dir, 'win.json');
    const now = Date.now();
    await writeFile(
      state,
      JSON.stringify({
        vlc: [
          {
            pid: 4242,
            ws: 524_288_000,
            priv: 734_003_200,
            handles: 1500,
            started: new Date(now - 3_600_000).toISOString(),
            cmd: '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --started-from-file "C:\\Users\\x\\Videos\\Film.mkv"',
          },
        ],
        events: [
          { time: new Date(now - 60_000).toISOString(), id: 1000, provider: 'Application Error', props: ['vlc.exe', '3.0.21.0', '6abeb4ee', 'libdirect3d11_filters_plugin.dll', '3.0.21.0', '0', 'c0000005', '0000000000012345', '4242'], message: 'Faulting application name: vlc.exe' },
          { time: new Date(now - 30_000).toISOString(), id: 1002, provider: 'Application Hang', props: ['vlc.exe', '3.0.21.0', '1092'], message: 'The program vlc.exe version 3.0.21.0 stopped interacting with Windows' },
          { time: new Date(now - 3 * 3_600_000).toISOString(), id: 1000, provider: 'Application Error', props: ['old.exe', '1', '0', 'old.dll', '1', '0', 'c0000409'], message: 'outside the window' },
        ],
      }),
    );
    // Invariant 5: with no library root the sampler stays off, so the daemons get an empty one (never rescanned in the test's lifetime).
    const roots = path.join(dir, 'roots');
    await mkdir(roots);
    const wrap = async (mode: string): Promise<string> => {
      const f = path.join(dir, `${mode}.exe`);
      await writeFile(f, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WINDOWS}" ${mode} "$@"\n`);
      await chmod(f, 0o755);
      return f;
    };
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: testDatabaseUrl(),
      NOTESD_PORT: '0',
      NOTES_DATA_DIR: dataDir,
      CLAUDE_HOME: path.join(dir, 'claude'),
      NOTES_WORKTREES_DIR: path.join(dir, 'worktrees'),
      NOTESD_SWARM_SCRIPT: path.join(dir, 'no-swarm.py'),
      OPENROUTER_API_KEY: '',
      CHAT_BRAIN: 'claude',
      NOTESD_SESSIONS: 'off',
      NOTESD_ADVERSARY: 'off',
      NOTESD_SEER_DISPATCH: 'off',
      NOTESD_MOVIES: 'on',
      NOTESD_MOVIES_ROOTS: roots,
      NOTESD_MOVIES_SCAN_MS: '86400000',
      TMDB_API_READ_ACCESS_TOKEN: '',
      TMDB_API_KEY: '',
      NOTESD_VLC_INI: '',
      NOTESD_VLC_BIN: path.join(dir, 'no-such-vlc.exe'),
      NOTESD_VLC_HEALTH_MS: '5000',
      NOTESD_TASKLIST_EXE: await wrap('tasklist'),
      NOTESD_POWERSHELL_EXE: await wrap('powershell'),
      FAKE_WIN_STATE: state,
    };
    const log = healthLogPath(path.join(dataDir, 'movies'), os.hostname());

    const first = await startChild(env);
    children.push(first.proc);
    await vi.waitFor(async () => expect((await records(log)).filter((r) => r.kind === 'sample').length).toBeGreaterThanOrEqual(2), {
      timeout: 25_000,
      interval: 250,
    });
    first.proc.kill('SIGKILL');
    await first.exited;
    const before = await records(log);
    expect(before.map((r) => r.kind)).not.toContain('clean_stop');
    expect(before.at(-1)?.kind).toBe('sample');
    const lastSample = before.filter((r): r is SampleRecord => r.kind === 'sample').at(-1)!;

    const second = await startChild(env);
    children.push(second.proc);
    await vi.waitFor(async () => expect((await records(log)).some((r) => r.kind === 'incident')).toBe(true), { timeout: 20_000, interval: 250 });
    const incidents = (await records(log)).filter((r): r is IncidentRecord => r.kind === 'incident');
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(inc.last_sample_at).toBe(lastSample.ts);
    expect(inc.samples.length).toBeGreaterThanOrEqual(2);
    expect(inc.samples.at(-1)).toMatchObject({ pid: 4242, ws_bytes: 524_288_000, private_bytes: 734_003_200, handles: 1500, ours: false, play: null });
    expect(inc.events.map((e) => [e.event_id, e.application, e.module, e.exception_code])).toEqual([
      [1000, 'vlc.exe', 'libdirect3d11_filters_plugin.dll', '0xc0000005'],
      [1002, 'vlc.exe', null, null],
    ]);
    expect(inc.events_error).toBeNull();

    const res = await fetch(`http://127.0.0.1:${second.port}/api/movies/player/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthReport;
    expect(body).toMatchObject({ sampling: true, interval_ms: 5000, process_detail: true });
    expect(body.samples.length).toBeGreaterThanOrEqual(2);
    expect(body.incidents).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ pid: 4242, ours: false });
    expect(body.last_start?.previous).toBe('unclean_sampling');

    second.proc.kill('SIGTERM');
    expect(await second.exited).toBe(0);
    expect((await records(log)).at(-1)?.kind).toBe('clean_stop');
  }, 120_000);
});
