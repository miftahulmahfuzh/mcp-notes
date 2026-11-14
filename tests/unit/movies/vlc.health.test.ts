import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetectProbe } from '../../../src/http/reveal.js';
import {
  DEFAULT_POWERSHELL_EXE,
  DEFAULT_TASKLIST_EXE,
  HealthLog,
  HealthMonitor,
  detectHealthEnv,
  healthReport,
  parsePowerShellProcesses,
  parseTasklistCsv,
  redactCommandLine,
  startedByNotesd,
  summarizeRuns,
  type HangRecord,
  type HealthDetection,
  type HealthRecord,
  type ProcessListing,
  type SampleRecord,
  type TrackedVlc,
  type VlcProcess,
} from '../../../src/movies/vlc/health.js';

const HOST = 'this-host';
const PW = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OURS_CMD = `"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --no-one-instance --extraintf http --http-host 127.0.0.1 --http-port 47318 --http-password ${PW} --start-time=1200 C:\\Users\\x\\Videos\\Film.mkv`;
const FOREIGN_CMD = '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --started-from-file "C:\\Users\\x\\Videos\\Other.mkv"';
const ENV_OK: HealthDetection = { available: true, env: { tasklist: '/t.exe', powershell: '/p.exe' } };
const T = new Date('2026-11-14T06:00:00.000Z');

function proc(o: Partial<VlcProcess> & { pid: number }): VlcProcess {
  return { wsBytes: 500_000_000, privateBytes: 700_000_000, handles: 1500, startedAt: '2026-11-14T05:00:00.000Z', commandLine: FOREIGN_CMD, ...o };
}

class FakeLister {
  listing: ProcessListing = { kind: 'ok', detail: true, processes: [] };
  calls = 0;
  async list(): Promise<ProcessListing> {
    this.calls += 1;
    return this.listing;
  }
}

const TRACKED: TrackedVlc = {
  playId: 7,
  fileId: 3,
  name: 'Film.mkv',
  port: 47318,
  password: PW,
  state: 'paused',
  positionS: 1234.56,
  pausedSince: new Date(T.getTime() - 90_000),
  silentSince: null,
  hung: false,
};

let dir: string;
const monitors: HealthMonitor[] = [];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vlc-health-'));
});
afterEach(async () => {
  for (const m of monitors.splice(0)) await m.close();
  await rm(dir, { recursive: true, force: true });
});

function setup(o: { tracked?: TrackedVlc | null; intervalMs?: number; detection?: HealthDetection; maxLogBytes?: number } = {}) {
  const lister = new FakeLister();
  const clock = { now: T };
  const lines: string[] = [];
  let tracked = o.tracked ?? null;
  const m = new HealthMonitor({
    host: HOST,
    logDir: dir,
    intervalMs: o.intervalMs ?? 60_000,
    detect: async () => o.detection ?? ENV_OK,
    tracked: () => tracked,
    makeLister: () => lister,
    makeEvents: () => null,
    now: () => clock.now,
    log: (l) => lines.push(l),
    ...(o.maxLogBytes !== undefined ? { maxLogBytes: o.maxLogBytes } : {}),
  });
  monitors.push(m);
  return { m, lister, clock, lines, setTracked: (t: TrackedVlc | null) => (tracked = t) };
}

function records(): HealthRecord[] {
  return new HealthLog(dir, HOST).readTail(50_000_000);
}

function samples(): SampleRecord[] {
  return records().filter((r): r is SampleRecord => r.kind === 'sample');
}

describe('HealthMonitor samples', () => {
  it('R8.1: appends one sample per vlc.exe per tick, the notesd-started one with its play state and seconds paused', async () => {
    const { m, lister, clock } = setup({ tracked: TRACKED });
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 100, commandLine: OURS_CMD }), proc({ pid: 200 })] };
    await m.start();
    expect(await m.sampleNow()).toBe(2);
    expect(records().map((r) => r.kind)).toEqual(['start', 'sample', 'sample']);
    const [ours, foreign] = samples();
    expect(ours).toMatchObject({
      pid: 100,
      ws_bytes: 500_000_000,
      private_bytes: 700_000_000,
      handles: 1500,
      ours: true,
      play: { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', position_s: 1234.6, paused_s: 90, http_silent_s: null, hung: false },
    });
    expect(ours!.cmd).toContain('--http-password ***');
    expect(JSON.stringify(records())).not.toContain(PW);
    expect(foreign).toMatchObject({ pid: 200, ours: false, play: null });
    expect(foreign!.cmd).toContain('Other.mkv');

    clock.now = new Date(T.getTime() + 30_000);
    await m.sampleNow();
    const later = samples().slice(-2);
    expect(later.map((s) => s.cmd)).toEqual([null, null]);
    expect(later[0]!.play!.paused_s).toBe(120);
    await m.close();
    expect(records().at(-1)!.kind).toBe('clean_stop');
  });

  it('R8.1: writes nothing while no vlc.exe runs, and one idle line when the last one exits', async () => {
    const { m, lister } = setup();
    await m.start();
    await m.sampleNow();
    expect(records().map((r) => r.kind)).toEqual(['start']);
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 5 })] };
    await m.sampleNow();
    lister.listing = { kind: 'ok', detail: true, processes: [] };
    await m.sampleNow();
    await m.sampleNow();
    expect(records().map((r) => r.kind)).toEqual(['start', 'sample', 'idle']);
  });

  it('keeps sampling without PowerShell detail: ours unknown, no play', async () => {
    const { m, lister } = setup({ tracked: TRACKED });
    lister.listing = { kind: 'ok', detail: false, processes: [proc({ pid: 5, privateBytes: null, handles: null, startedAt: null, commandLine: null })] };
    await m.start();
    await m.sampleNow();
    expect(samples()[0]).toMatchObject({ pid: 5, private_bytes: null, handles: null, ours: null, play: null, cmd: null });
  });

  it('stays off and writes nothing with NOTESD_VLC_HEALTH_MS=0 or without tasklist.exe, saying so once', async () => {
    const zero = setup({ intervalMs: 0 });
    await zero.m.start();
    expect(zero.m.status()).toMatchObject({ sampling: false, reason: 'disabled' });
    expect(await zero.m.sampleNow()).toBe(0);
    expect(zero.lines).toEqual(['[notesd] vlc health off (NOTESD_VLC_HEALTH_MS=0 or no NOTESD_MOVIES_ROOTS)']);

    const none = setup({ detection: { available: false, reason: 'no_tasklist' } });
    await none.m.start();
    expect(none.m.status()).toMatchObject({ sampling: false, reason: 'no_tasklist' });
    expect(none.lines).toEqual(['[notesd] vlc health off (no_tasklist)']);
    await zero.m.close();
    await none.m.close();
    expect(existsSync(new HealthLog(dir, HOST).file)).toBe(false);
  });

  it('logs a failed listing once and keeps going', async () => {
    const { m, lister, lines } = setup();
    await m.start();
    lister.listing = { kind: 'error', message: 'tasklist.exe exited 1' };
    await m.sampleNow();
    await m.sampleNow();
    expect(lines.filter((l) => l.includes('listing vlc.exe failed'))).toHaveLength(1);
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 9 })] };
    expect(await m.sampleNow()).toBe(1);
  });
});

describe('HealthLog', () => {
  it('rotates past maxBytes into one previous file and still reads across both', async () => {
    const { m, lister, clock } = setup({ maxLogBytes: 2000 });
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 5 })] };
    await m.start();
    for (let i = 0; i < 30; i++) {
      clock.now = new Date(T.getTime() + i * 30_000);
      await m.sampleNow();
    }
    const log = new HealthLog(dir, HOST);
    expect((await stat(log.file)).size).toBeLessThanOrEqual(2000);
    expect(existsSync(log.previousFile)).toBe(true);
    const all = samples();
    expect(all.at(-1)!.ts).toBe(new Date(T.getTime() + 29 * 30_000).toISOString());
    expect(all.length).toBeGreaterThan(log.readTail(2000).filter((r) => r.kind === 'sample').length - 1);
  });

  it('repairs a torn last line (a crash mid-write) before the next append', async () => {
    const log = new HealthLog(dir, HOST);
    log.append({ kind: 'idle', ts: T.toISOString(), host: HOST });
    await writeFile(log.file, `${JSON.stringify({ kind: 'idle', ts: T.toISOString(), host: HOST })}\n{"kind":"sample","ts":"2026`);
    log.append({ kind: 'clean_stop', ts: T.toISOString(), host: HOST });
    expect(log.readTail(1_000_000).map((r) => r.kind)).toEqual(['idle', 'clean_stop']);
  });
});

describe('the player link', () => {
  it('processAlive finds the tracked VLC by its password, says gone when no vlc.exe runs, unknown without detail', async () => {
    const { m, lister } = setup();
    await m.start();
    lister.listing = { kind: 'ok', detail: true, processes: [proc({ pid: 100, commandLine: OURS_CMD }), proc({ pid: 200 })] };
    expect(await m.processAlive({ port: 47318, password: PW })).toEqual({ kind: 'alive', pid: 100 });
    expect(await m.processAlive({ port: 47319, password: 'b'.repeat(32) })).toEqual({ kind: 'gone' });
    lister.listing = { kind: 'ok', detail: true, processes: [] };
    expect(await m.processAlive({ port: 47318, password: PW })).toEqual({ kind: 'gone' });
    lister.listing = { kind: 'ok', detail: false, processes: [proc({ pid: 100, commandLine: null })] };
    expect(await m.processAlive({ port: 47318, password: PW })).toMatchObject({ kind: 'unknown' });
  });

  it('R8.3: onHang writes start and end lines with the seconds VLC has been silent', async () => {
    const { m, clock } = setup();
    await m.start();
    const base = { pid: 100, port: 47318, playId: 7, fileId: 3, name: 'Film.mkv', positionS: 1234.56, silentSince: new Date(T.getTime() - 10_000) };
    m.onHang({ ...base, phase: 'start' });
    clock.now = new Date(T.getTime() + 50_000);
    m.onHang({ ...base, phase: 'end', outcome: 'answered' });
    const hangs = records().filter((r): r is HangRecord => r.kind === 'hang');
    expect(hangs.map((h) => [h.phase, h.silent_s, h.outcome, h.position_s, h.pid])).toEqual([
      ['start', 10, null, 1234.6, 100],
      ['end', 60, 'answered', 1234.6, 100],
    ]);
  });
});

describe('detectHealthEnv', () => {
  function probe(o: { platform?: NodeJS.Platform; interop?: boolean; execs?: string[]; env?: Record<string, string> } = {}): DetectProbe {
    const execs = new Set(o.execs ?? [DEFAULT_TASKLIST_EXE, DEFAULT_POWERSHELL_EXE]);
    return {
      platform: o.platform ?? 'linux',
      env: { PATH: '/usr/bin:/bin', ...(o.env ?? {}) },
      exists: async (p) => (o.interop ?? true) && p === '/proc/sys/fs/binfmt_misc/WSLInterop',
      executable: async (p) => execs.has(p),
    };
  }

  it('finds both Windows binaries at their absolute defaults, honours overrides, and says why it is off', async () => {
    expect(await detectHealthEnv(probe())).toEqual({ available: true, env: { tasklist: DEFAULT_TASKLIST_EXE, powershell: DEFAULT_POWERSHELL_EXE } });
    expect(await detectHealthEnv(probe({ execs: ['/x/t.exe'], env: { NOTESD_TASKLIST_EXE: '/x/t.exe' } }))).toEqual({
      available: true,
      env: { tasklist: '/x/t.exe', powershell: null },
    });
    expect(await detectHealthEnv(probe({ execs: [] }))).toEqual({ available: false, reason: 'no_tasklist' });
    expect(await detectHealthEnv(probe({ interop: false }))).toEqual({ available: false, reason: 'no_interop' });
    expect(await detectHealthEnv(probe({ platform: 'darwin' }))).toEqual({ available: false, reason: 'not_linux' });
  });
});

describe('reading the Windows side', () => {
  it('parses tasklist CSV (MEASURED INFO line, both locale separators) and ignores other images', () => {
    expect(parseTasklistCsv('INFO: No tasks are running which match the specified criteria.\r\n')).toEqual([]);
    expect(parseTasklistCsv('"vlc.exe","13572","Console","1","512,000 K"\r\n"vlc.exe","2048","Console","1","1.024 K"\r\n"explorer.exe","5044","Console","1","409,188 K"\r\n')).toEqual([
      { pid: 13572, wsBytes: 512_000 * 1024 },
      { pid: 2048, wsBytes: 1024 * 1024 },
    ]);
  });

  it('parses the PowerShell process JSON (MEASURED shape), a single object, and refuses garbage', () => {
    const one = '{"pid":5044,"ws":419008512,"priv":267444224,"handles":3170,"started":"2026-11-14T06:04:49.2149510Z","cmd":"C:\\\\Windows\\\\Explorer.EXE"}';
    expect(parsePowerShellProcesses(`[${one}]\r\n`)).toEqual([
      { pid: 5044, wsBytes: 419008512, privateBytes: 267444224, handles: 3170, startedAt: '2026-11-14T06:04:49.2149510Z', commandLine: 'C:\\Windows\\Explorer.EXE' },
    ]);
    expect(parsePowerShellProcesses(`#< CLIXML\r\n${one}\r\n`)).toHaveLength(1);
    expect(parsePowerShellProcesses('[]')).toEqual([]);
    expect(parsePowerShellProcesses('Get-CimInstance : Access denied')).toBeNull();
    expect(parsePowerShellProcesses('[{"pid":"x"}]')).toBeNull();
  });

  it('redacts the HTTP password in both flag forms and recognises a notesd launch', () => {
    expect(redactCommandLine(OURS_CMD)).not.toContain(PW);
    expect(redactCommandLine(`vlc.exe --http-password=${PW} f.mkv`)).toBe('vlc.exe --http-password=*** f.mkv');
    expect(startedByNotesd(OURS_CMD)).toBe(true);
    expect(startedByNotesd(FOREIGN_CMD)).toBe(false);
    expect(redactCommandLine('x'.repeat(700))).toHaveLength(601);
  });
});

describe('the health report', () => {
  function sample(minute: number, o: Partial<SampleRecord> = {}): SampleRecord {
    return {
      kind: 'sample',
      ts: new Date(T.getTime() + minute * 60_000).toISOString(),
      host: HOST,
      pid: 100,
      ws_bytes: 500_000_000 + minute * 1_000_000,
      private_bytes: 700_000_000 + minute * 10_485_760,
      handles: 1500 + minute,
      proc_started_at: '2026-11-14T05:00:00.000Z',
      ours: true,
      play: { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', position_s: 1200, paused_s: minute * 60, http_silent_s: null, hung: false },
      cmd: null,
      ...o,
    };
  }

  it('R8.5: summarizes each VLC run with its growth per paused minute', () => {
    const run = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((m) => sample(m));
    run[0] = sample(0, { play: { ...run[0]!.play!, state: 'playing', paused_s: null } });
    const foreign = [sample(0, { pid: 200, ours: false, play: null, private_bytes: null }), sample(10, { pid: 200, ours: false, play: null, private_bytes: null })];
    const [ours, theirs] = summarizeRuns([...run, ...foreign]);
    expect(ours).toMatchObject({
      pid: 100,
      ours: true,
      samples: 11,
      ws_max: 510_000_000,
      private_max: 700_000_000 + 10 * 10_485_760,
      handles_max: 1510,
      paused_s_max: 600,
      private_growth_per_paused_min: 10_485_760,
      ws_growth_per_paused_min: 1_000_000,
      private_growth_per_min: 10_485_760,
    });
    expect(theirs).toMatchObject({ pid: 200, ours: false, private_growth_per_paused_min: null, ws_growth_per_paused_min: null, ws_growth_per_min: 1_000_000 });
  });

  it('R8.5: returns the newest `limit` samples, the hangs, incidents and the last start', () => {
    const recs: HealthRecord[] = [
      { kind: 'start', ts: T.toISOString(), host: HOST, daemon_pid: 1, interval_ms: 30_000, process_detail: true, previous: 'none' },
      sample(0),
      sample(1),
      sample(2),
    ];
    const status = { sampling: true, reason: null, interval_ms: 30_000, process_detail: true, log_file: '/x' };
    const r = healthReport(recs, { host: HOST, limit: 2, status });
    expect(r.samples.map((s) => s.ts)).toEqual([sample(1).ts, sample(2).ts]);
    expect(r.runs[0]!.samples).toBe(3);
    expect(r.last_start?.kind).toBe('start');
    expect(r).toMatchObject({ host: HOST, sampling: true, hangs: [], incidents: [] });
  });
});
