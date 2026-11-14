import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthLog, HealthMonitor, type HangRecord, type HealthRecord, type IncidentRecord, type SampleRecord, type StartRecord } from '../../../src/movies/vlc/health.js';
import {
  INCIDENT_SAMPLES,
  analyzePreviousRun,
  eventsScript,
  exceptionCode,
  incidentWindow,
  parseWinEvents,
  type EventLogReader,
} from '../../../src/movies/vlc/incidents.js';

const HOST = 'this-host';
const at = (iso: string): number => Date.parse(iso);
const iso = (ms: number): string => new Date(ms).toISOString();

/** MEASURED 2026-11-14: eventsScript's output for the 13:03 WIB crash on this machine (messages cut). */
const MEASURED_STDOUT =
  JSON.stringify([
    { time: '2026-11-14T06:03:45.7356997Z', id: 1000, provider: 'Application Error', props: ['Explorer.EXE', '10.0.22621.6199', '89967d6d', 'Windows.UI.Xaml.dll', '10.0.22621.6133', 'd64b13a4', 'c000027b', '00000000004cae0f', '10444'], message: 'Faulting application name: Explorer.EXE' },
    { time: '2026-11-14T06:03:47.0286178Z', id: 1000, provider: 'Application Error', props: ['WindowsTerminal.exe', '1.24.2610.1001', '6abeb4ee', 'igd10umt64xe.DLL', '32.0.101.6733', '67ed76ed', 'c0000005', '00000000008d9409', '23248'], message: 'Faulting application name: WindowsTerminal.exe' },
    { time: '2026-11-14T06:04:53.7853510Z', id: 1000, provider: 'Application Error', props: ['WindowsTerminal.exe', '1.24.2610.1001', '6abeb4ee', 'ucrtbase.dll', '10.0.22621.3593', '10c46e71', 'c0000409', '000000000007f6fe', '11692'], message: 'Faulting application name: WindowsTerminal.exe' },
    { time: '2026-11-14T06:04:00.0000000Z', id: 1002, provider: 'Application Hang', props: ['vlc.exe', '3.0.21.0', '3a5c', '01db5a1c'], message: 'The program vlc.exe version 3.0.21.0 stopped interacting with Windows' },
    { time: '2026-11-14T04:00:00.0000000Z', id: 1000, provider: 'Application Error', props: ['old.exe', '1', '0', 'old.dll', '1', '0', 'c0000409'], message: 'outside the window' },
  ]) + '\r\n';

function start(ts: string): StartRecord {
  return { kind: 'start', ts, host: HOST, daemon_pid: 1, interval_ms: 30_000, process_detail: true, previous: 'none' };
}

function sample(ts: string, play: boolean): SampleRecord {
  return {
    kind: 'sample',
    ts,
    host: HOST,
    pid: 4242,
    ws_bytes: 600_000_000,
    private_bytes: 800_000_000,
    handles: 1500,
    proc_started_at: '2026-11-14T05:30:00.000Z',
    ours: true,
    play: play ? { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', position_s: 3600, paused_s: 900, http_silent_s: null, hung: false } : null,
    cmd: null,
  };
}

const T0 = at('2026-11-14T05:38:30.000Z');
const LAST_SAMPLE = '2026-11-14T06:03:30.000Z';
function crashedRun(): HealthRecord[] {
  const recs: HealthRecord[] = [start('2026-11-14T05:38:00.000Z')];
  for (let i = 0; i <= 50; i++) recs.push(sample(iso(T0 + i * 30_000), true));
  const hang: HangRecord = { kind: 'hang', ts: '2026-11-14T06:02:00.000Z', host: HOST, phase: 'start', pid: 4242, port: 47318, play_id: 7, file_id: 3, name: 'Film.mkv', position_s: 3600, silent_s: 10, outcome: null };
  recs.push(hang);
  return recs;
}

describe('analyzePreviousRun', () => {
  it('R8.2: a run whose newest state line is a sample died while sampling', () => {
    const prev = analyzePreviousRun(crashedRun());
    expect(prev).toMatchObject({ kind: 'unclean_sampling', previousStartAt: '2026-11-14T05:38:00.000Z', lastSampleAt: LAST_SAMPLE, lastRecordAt: '2026-11-14T06:02:00.000Z' });
    if (prev.kind !== 'unclean_sampling') throw new Error('unreachable');
    expect(prev.samples).toHaveLength(INCIDENT_SAMPLES);
    expect(prev.samples.at(-1)!.ts).toBe(LAST_SAMPLE);
    expect(prev.hangs).toHaveLength(1);
  });

  it('clean_stop is clean; idle, or a start with nothing after it, is unclean but not while sampling; an empty log is none', () => {
    expect(analyzePreviousRun([...crashedRun(), { kind: 'clean_stop', ts: '2026-11-14T06:10:00.000Z', host: HOST }]).kind).toBe('clean');
    expect(analyzePreviousRun([...crashedRun(), { kind: 'idle', ts: '2026-11-14T06:05:00.000Z', host: HOST }]).kind).toBe('unclean_idle');
    expect(analyzePreviousRun([...crashedRun(), start('2026-11-14T06:07:00.000Z')]).kind).toBe('unclean_idle');
    expect(analyzePreviousRun([]).kind).toBe('none');
  });
});

describe('the event window and parsing', () => {
  it('spans 10 min before the last sample to the daemon start, capped at 15 min after the last line', () => {
    const prev = { lastSampleAt: LAST_SAMPLE, lastRecordAt: '2026-11-14T06:03:30.000Z' };
    const soon = incidentWindow(prev, new Date('2026-11-14T06:07:00.000Z'));
    expect([soon.from.toISOString(), soon.to.toISOString()]).toEqual(['2026-11-14T05:53:30.000Z', '2026-11-14T06:07:00.000Z']);
    const days = incidentWindow(prev, new Date('2026-11-16T09:00:00.000Z'));
    expect(days.to.toISOString()).toBe('2026-11-14T06:18:30.000Z');
  });

  it('R8.2: reads application, faulting module and exception code from the MEASURED 13:03 crash events', () => {
    const events = parseWinEvents(MEASURED_STDOUT)!;
    expect(events.map((e) => [e.event_id, e.application, e.module, e.exception_code])).toEqual([
      [1000, 'Explorer.EXE', 'Windows.UI.Xaml.dll', '0xc000027b'],
      [1000, 'WindowsTerminal.exe', 'igd10umt64xe.DLL', '0xc0000005'],
      [1000, 'WindowsTerminal.exe', 'ucrtbase.dll', '0xc0000409'],
      [1002, 'vlc.exe', null, null],
      [1000, 'old.exe', 'old.dll', '0xc0000409'],
    ]);
    expect(parseWinEvents('[]')).toEqual([]);
    expect(parseWinEvents('Get-WinEvent : error')).toBeNull();
    expect(exceptionCode('0xC0000005')).toBe('0xc0000005');
    expect(exceptionCode('not a code')).toBe('not a code');
  });

  it('asks Windows in local time (MEASURED: a UTC DateTime matched nothing)', () => {
    const s = eventsScript(new Date('2026-11-14T05:53:30.000Z'), new Date('2026-11-14T06:07:00.000Z'));
    expect(s).toContain("[DateTimeOffset]::Parse('2026-11-14T05:53:30.000Z').LocalDateTime");
    expect(s).toContain("ProviderName = 'Application Error', 'Application Hang'");
  });
});

describe('HealthMonitor.start after a crash', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'vlc-incident-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function monitor(events: EventLogReader | null, now: string): { m: HealthMonitor; asked: Array<[string, string]> } {
    const asked: Array<[string, string]> = [];
    const reader: EventLogReader | null =
      events === null
        ? null
        : {
            read: async (from, to) => {
              asked.push([from.toISOString(), to.toISOString()]);
              return events.read(from, to);
            },
          };
    const m = new HealthMonitor({
      host: HOST,
      logDir: dir,
      intervalMs: 60_000,
      detect: async () => ({ available: true, env: { tasklist: '/t.exe', powershell: '/p.exe' } }),
      tracked: () => null,
      makeLister: () => ({ list: async () => ({ kind: 'ok', detail: true, processes: [] }) }),
      makeEvents: () => reader,
      now: () => new Date(now),
      log: () => {},
    });
    return { m, asked };
  }

  const measured: EventLogReader = { read: async () => ({ kind: 'ok', events: parseWinEvents(MEASURED_STDOUT)! }) };

  function seed(recs: HealthRecord[]): HealthLog {
    const log = new HealthLog(dir, HOST);
    for (const r of recs) log.append(r);
    return log;
  }

  it('R8.2: writes one incident with the last samples, the open play, the hang and the in-window Windows events', async () => {
    const log = seed(crashedRun());
    const { m, asked } = monitor(measured, '2026-11-14T06:07:00.000Z');
    await m.start();
    await m.settled();
    await m.close();
    const recs = log.readTail(10_000_000);
    const incidents = recs.filter((r): r is IncidentRecord => r.kind === 'incident');
    expect(incidents).toHaveLength(1);
    const inc = incidents[0]!;
    expect(asked).toEqual([['2026-11-14T05:53:30.000Z', '2026-11-14T06:07:00.000Z']]);
    expect(inc).toMatchObject({
      last_sample_at: LAST_SAMPLE,
      previous_start_at: '2026-11-14T05:38:00.000Z',
      window: { from: '2026-11-14T05:53:30.000Z', to: '2026-11-14T06:07:00.000Z' },
      open_play: { play_id: 7, file_id: 3, name: 'Film.mkv', state: 'paused', paused_s: 900 },
      events_error: null,
    });
    expect(inc.samples).toHaveLength(INCIDENT_SAMPLES);
    expect(inc.hangs.map((h) => h.phase)).toEqual(['start']);
    expect(inc.events.map((e) => [e.time, e.application, e.module, e.exception_code])).toEqual([
      ['2026-11-14T06:03:45.7356997Z', 'Explorer.EXE', 'Windows.UI.Xaml.dll', '0xc000027b'],
      ['2026-11-14T06:03:47.0286178Z', 'WindowsTerminal.exe', 'igd10umt64xe.DLL', '0xc0000005'],
      ['2026-11-14T06:04:00.0000000Z', 'vlc.exe', null, null],
      ['2026-11-14T06:04:53.7853510Z', 'WindowsTerminal.exe', 'ucrtbase.dll', '0xc0000409'],
    ]);
    const starts = recs.filter((r): r is StartRecord => r.kind === 'start');
    expect(starts.at(-1)!.previous).toBe('unclean_sampling');
  });

  it('writes no incident after a clean stop or an unclean stop with no VLC open', async () => {
    seed([...crashedRun(), { kind: 'clean_stop', ts: '2026-11-14T06:05:00.000Z', host: HOST }]);
    const a = monitor(measured, '2026-11-14T06:07:00.000Z');
    await a.m.start();
    await a.m.settled();
    await a.m.close();
    seed([{ kind: 'idle', ts: '2026-11-14T06:08:00.000Z', host: HOST }]);
    const b = monitor(measured, '2026-11-14T06:09:00.000Z');
    await b.m.start();
    await b.m.settled();
    await b.m.close();
    const recs = new HealthLog(dir, HOST).readTail(10_000_000);
    expect(recs.some((r) => r.kind === 'incident')).toBe(false);
    expect(a.asked).toEqual([]);
  });

  it('records the incident with events_error when Windows events cannot be read', async () => {
    const log = seed(crashedRun());
    const { m } = monitor(null, '2026-11-14T06:07:00.000Z');
    await m.start();
    await m.settled();
    await m.close();
    const inc = log.readTail(10_000_000).find((r): r is IncidentRecord => r.kind === 'incident')!;
    expect(inc).toMatchObject({ events: [], events_error: 'no powershell.exe: Windows events not read' });
    expect(inc.samples.length).toBeGreaterThan(0);
  });
});
