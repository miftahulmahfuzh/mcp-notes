import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MoviesConfig } from '../../config.js';
import { findOnPath, nodeProbe, WSL_INTEROP_FILES, type DetectProbe } from '../../http/reveal.js';
import { MOVIES_SUBDIR } from '../service.js';
import { execCapture, type ExecFn, type VlcEndpoint, type VlcState } from './http.js';
import {
  analyzePreviousRun,
  buildIncident,
  incidentWindow,
  lastJsonLine,
  powershellArgs,
  powershellEventLogReader,
  type EventLogReader,
  type EventsResult,
  type UncleanSampling,
} from './incidents.js';

/** Override for tasklist.exe (authoritative when set, like NOTESD_EXPLORER_BIN). */
export const TASKLIST_ENV = 'NOTESD_TASKLIST_EXE';
/** Override for powershell.exe. */
export const POWERSHELL_ENV = 'NOTESD_POWERSHELL_EXE';
/** The systemd unit's PATH has no /mnt/c, so the absolute paths are the defaults. */
export const DEFAULT_TASKLIST_EXE = '/mnt/c/Windows/System32/tasklist.exe';
export const DEFAULT_POWERSHELL_EXE = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
export const TASKLIST_TIMEOUT_MS = 10_000;
export const POWERSHELL_TIMEOUT_MS = 20_000;
/** Current file cap; one previous file is kept (`.1.jsonl`). */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** What start() reads to judge how the previous run ended. */
export const TAIL_BYTES = 256 * 1024;
/** What the health route reads. */
export const REPORT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REPORT_SAMPLES = 200;
export const MAX_REPORT_SAMPLES = 2000;
export const REPORT_HANGS = 50;
export const REPORT_INCIDENTS = 20;
/** close() waits this long at most for a start-up incident still reading the Windows event log. */
export const INCIDENT_WAIT_ON_CLOSE_MS = 3000;
export const CMD_MAX_CHARS = 600;

// ---- Log records: one JSON object per line. The schemas are the boundary for reading the file back.

const stamp = { ts: z.string(), host: z.string() };
const vlcState = z.enum(['playing', 'paused', 'stopped']);
const samplePlaySchema = z.object({
  play_id: z.number(),
  file_id: z.number(),
  name: z.string(),
  state: vlcState,
  position_s: z.number(),
  paused_s: z.number().nullable(),
  http_silent_s: z.number().nullable(),
  hung: z.boolean(),
});
const sampleSchema = z.object({
  kind: z.literal('sample'),
  ...stamp,
  pid: z.number(),
  ws_bytes: z.number(),
  private_bytes: z.number().nullable(),
  handles: z.number().nullable(),
  proc_started_at: z.string().nullable(),
  ours: z.boolean().nullable(),
  play: samplePlaySchema.nullable(),
  cmd: z.string().nullable(),
});
const hangOutcomeSchema = z.enum(['answered', 'exited', 'tracking_ended']);
const hangSchema = z.object({
  kind: z.literal('hang'),
  ...stamp,
  phase: z.enum(['start', 'end']),
  pid: z.number().nullable(),
  port: z.number(),
  play_id: z.number(),
  file_id: z.number(),
  name: z.string(),
  position_s: z.number(),
  silent_s: z.number(),
  outcome: hangOutcomeSchema.nullable(),
});
const previousRunKindSchema = z.enum(['none', 'clean', 'unclean_idle', 'unclean_sampling']);
const startSchema = z.object({
  kind: z.literal('start'),
  ...stamp,
  daemon_pid: z.number(),
  interval_ms: z.number(),
  process_detail: z.boolean(),
  previous: previousRunKindSchema,
});
const idleSchema = z.object({ kind: z.literal('idle'), ...stamp });
const cleanStopSchema = z.object({ kind: z.literal('clean_stop'), ...stamp });
const winFaultEventSchema = z.object({
  time: z.string(),
  event_id: z.number(),
  provider: z.string(),
  application: z.string().nullable(),
  module: z.string().nullable(),
  exception_code: z.string().nullable(),
  message: z.string().nullable(),
});
const incidentSchema = z.object({
  kind: z.literal('incident'),
  ...stamp,
  previous_start_at: z.string().nullable(),
  last_record_at: z.string(),
  last_sample_at: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  samples: z.array(sampleSchema),
  hangs: z.array(hangSchema),
  open_play: samplePlaySchema.nullable(),
  events: z.array(winFaultEventSchema),
  events_error: z.string().nullable(),
});
const recordSchema = z.discriminatedUnion('kind', [startSchema, sampleSchema, idleSchema, hangSchema, cleanStopSchema, incidentSchema]);

export type SamplePlay = z.infer<typeof samplePlaySchema>;
export type SampleRecord = z.infer<typeof sampleSchema>;
export type HangOutcome = z.infer<typeof hangOutcomeSchema>;
export type HangRecord = z.infer<typeof hangSchema>;
export type PreviousRunKind = z.infer<typeof previousRunKindSchema>;
export type StartRecord = z.infer<typeof startSchema>;
export type IdleRecord = z.infer<typeof idleSchema>;
export type CleanStopRecord = z.infer<typeof cleanStopSchema>;
export type WinFaultEvent = z.infer<typeof winFaultEventSchema>;
export type IncidentRecord = z.infer<typeof incidentSchema>;
export type HealthRecord = z.infer<typeof recordSchema>;

/** One log line -> a record; null for a blank, torn or foreign line. */
export function parseHealthLine(line: string): HealthRecord | null {
  const text = line.trim();
  if (text === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = recordSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ---- The file.

export function safeHostName(host: string): string {
  const s = host.replace(/[^A-Za-z0-9._-]/g, '_');
  return s === '' ? 'host' : s;
}

export function healthLogPath(logDir: string, host: string): string {
  return path.join(logDir, `vlc-health-${safeHostName(host)}.jsonl`);
}

export function previousHealthLogPath(logDir: string, host: string): string {
  return path.join(logDir, `vlc-health-${safeHostName(host)}.1.jsonl`);
}

interface Tail {
  text: string;
  bytes: number;
  /** The whole file was read (no partial first line). */
  whole: boolean;
}

function readLastBytes(file: string, max: number): Tail {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { text: '', bytes: 0, whole: true };
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, Math.max(0, max));
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), bytes: len, whole: len === size };
  } finally {
    closeSync(fd);
  }
}

/**
 * The per-host append-only log. Every append is fsync'd before it returns, so the last line
 * survives the WSL VM dying a moment later (the page cache does not).
 */
export class HealthLog {
  readonly file: string;
  readonly previousFile: string;

  constructor(
    readonly logDir: string,
    readonly host: string,
    private readonly maxBytes: number = MAX_LOG_BYTES,
  ) {
    this.file = healthLogPath(logDir, host);
    this.previousFile = previousHealthLogPath(logDir, host);
  }

  /** Rotates first when this line would pass maxBytes; repairs a torn last line (crash mid-write). */
  append(record: HealthRecord): void {
    mkdirSync(this.logDir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    let size = 0;
    try {
      size = statSync(this.file).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) {
      renameSync(this.file, this.previousFile);
      size = 0;
    }
    const fd = openSync(this.file, 'a+');
    try {
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) writeSync(fd, '\n');
      }
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** The newest records, oldest first, from the last maxBytes of the current file, then the previous one. */
  readTail(maxBytes: number): HealthRecord[] {
    const cur = readLastBytes(this.file, maxBytes);
    let text = cur.text;
    let whole = cur.whole;
    if (cur.whole && cur.bytes < maxBytes) {
      const prev = readLastBytes(this.previousFile, maxBytes - cur.bytes);
      if (prev.bytes > 0) {
        text = `${prev.text}${prev.text.endsWith('\n') ? '' : '\n'}${cur.text}`;
        whole = prev.whole;
      }
    }
    const lines = text.split('\n');
    if (!whole) lines.shift();
    const out: HealthRecord[] = [];
    for (const line of lines) {
      const r = parseHealthLine(line);
      if (r !== null) out.push(r);
    }
    return out;
  }
}

// ---- The Windows side.

/** One vlc.exe. Without PowerShell only pid and working set are known. */
export interface VlcProcess {
  pid: number;
  wsBytes: number;
  privateBytes: number | null;
  handles: number | null;
  /** ISO 8601 UTC. */
  startedAt: string | null;
  commandLine: string | null;
}

/** `detail`: command lines are known, so "no VLC with this password" means gone. */
export type ProcessListing = { kind: 'ok'; detail: boolean; processes: VlcProcess[] } | { kind: 'error'; message: string };

export interface ProcessLister {
  list(): Promise<ProcessListing>;
}

export interface HealthEnv {
  tasklist: string;
  /** null: no detail (private bytes, handles, command line) and no Windows events. */
  powershell: string | null;
}

export type HealthOffReason = 'disabled' | 'not_linux' | 'no_interop' | 'no_tasklist';

export type HealthDetection = { available: true; env: HealthEnv } | { available: false; reason: HealthOffReason };

export async function resolveWindowsExe(probe: DetectProbe, envName: string, fallback: string): Promise<string | null> {
  const value = probe.env[envName]?.trim() || fallback;
  if (value.includes('/')) return (await probe.executable(value)) ? value : null;
  return findOnPath(value, probe.env, probe.executable);
}

/** Linux + WSL interop + tasklist.exe (required) + powershell.exe (optional). Never throws. */
export async function detectHealthEnv(probe: DetectProbe): Promise<HealthDetection> {
  if (probe.platform !== 'linux') return { available: false, reason: 'not_linux' };
  let interop = false;
  for (const file of WSL_INTEROP_FILES) {
    if (await probe.exists(file)) {
      interop = true;
      break;
    }
  }
  if (!interop) return { available: false, reason: 'no_interop' };
  const tasklist = await resolveWindowsExe(probe, TASKLIST_ENV, DEFAULT_TASKLIST_EXE);
  if (tasklist === null) return { available: false, reason: 'no_tasklist' };
  const powershell = await resolveWindowsExe(probe, POWERSHELL_ENV, DEFAULT_POWERSHELL_EXE);
  return { available: true, env: { tasklist, powershell } };
}

/**
 * `tasklist /FO CSV /NH` rows of vlc.exe -> pid and working set. "Mem Usage" is KB with a locale
 * separator ("512,000 K" / "512.000 K"), so only its digits count. The INFO line yields [].
 */
export function parseTasklistCsv(stdout: string): Array<{ pid: number; wsBytes: number }> {
  const out: Array<{ pid: number; wsBytes: number }> = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"') || !line.endsWith('"')) continue;
    const f = line.slice(1, -1).split('","');
    if (f.length < 5 || (f[0] ?? '').toLowerCase() !== 'vlc.exe') continue;
    const pid = Number(f[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const kb = Number((f[4] ?? '').replace(/[^0-9]/g, ''));
    out.push({ pid, wsBytes: Number.isFinite(kb) ? kb * 1024 : 0 });
  }
  return out;
}

/** Every vlc.exe with the fields R8.1 needs, as one JSON array (MEASURED 2026-11-14: PrivatePageCount is bytes). */
export const PROCESS_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$p = @(Get-CimInstance Win32_Process -Filter \"Name='vlc.exe'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ws = [int64]$_.WorkingSetSize; priv = [int64]$_.PrivatePageCount; handles = [int]$_.HandleCount; started = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); cmd = $_.CommandLine } })",
  'ConvertTo-Json -InputObject $p -Compress -Depth 2',
].join('\n');

const psProcessSchema = z.object({
  pid: z.number().int().positive(),
  ws: z.number().nonnegative(),
  priv: z.number().nonnegative().nullable().optional(),
  handles: z.number().int().nonnegative().nullable().optional(),
  started: z.string().nullable().optional(),
  cmd: z.string().nullable().optional(),
});

/** PROCESS_SCRIPT's stdout -> processes; null when it is not that JSON. */
export function parsePowerShellProcesses(stdout: string): VlcProcess[] | null {
  const json = lastJsonLine(stdout);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = z.union([z.array(psProcessSchema), psProcessSchema]).safeParse(raw);
  if (!parsed.success) return null;
  const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return list.map((p) => ({
    pid: p.pid,
    wsBytes: p.ws,
    privateBytes: p.priv ?? null,
    handles: p.handles ?? null,
    startedAt: p.started ?? null,
    commandLine: p.cmd ?? null,
  }));
}

/** tasklist every call; PowerShell only when tasklist lists a vlc.exe. Never throws. */
export function windowsProcessLister(env: HealthEnv, exec: ExecFn = execCapture): ProcessLister {
  return {
    async list() {
      const t = await exec(env.tasklist, ['/FI', 'IMAGENAME eq vlc.exe', '/FO', 'CSV', '/NH'], TASKLIST_TIMEOUT_MS);
      if (t.exitCode !== 0 && !t.stdout.includes('INFO:')) return { kind: 'error', message: `tasklist.exe exited ${t.exitCode}` };
      const rows = parseTasklistCsv(t.stdout);
      if (rows.length === 0) return { kind: 'ok', detail: true, processes: [] };
      const basic: VlcProcess[] = rows.map((r) => ({
        pid: r.pid,
        wsBytes: r.wsBytes,
        privateBytes: null,
        handles: null,
        startedAt: null,
        commandLine: null,
      }));
      if (env.powershell === null) return { kind: 'ok', detail: false, processes: basic };
      const p = await exec(env.powershell, powershellArgs(PROCESS_SCRIPT), POWERSHELL_TIMEOUT_MS);
      const detailed = p.exitCode === 0 ? parsePowerShellProcesses(p.stdout) : null;
      if (detailed === null) return { kind: 'ok', detail: false, processes: basic };
      return { kind: 'ok', detail: true, processes: detailed };
    },
  };
}

/** The per-launch password never reaches the log. */
export function redactCommandLine(cmd: string): string {
  const red = cmd.replace(/(--http-password(?:=|\s+)"?)[^\s"]+/gi, '$1***');
  return red.length > CMD_MAX_CHARS ? `${red.slice(0, CMD_MAX_CHARS)}…` : red;
}

/** Phase 5's launch flags: `--extraintf http` and a 32-hex `--http-password`. */
export function startedByNotesd(cmd: string): boolean {
  return /--extraintf(?:=|\s+)"?http\b/i.test(cmd) && /--http-password(?:=|\s+)"?[0-9a-f]{32}\b/i.test(cmd);
}

// ---- The player's side.

/** What the player tells the monitor about the play it follows (MoviePlayer.healthView()). */
export interface TrackedVlc {
  playId: number;
  fileId: number;
  name: string;
  port: number;
  /** Matched against command lines in memory; never logged. */
  password: string;
  state: VlcState;
  positionS: number;
  pausedSince: Date | null;
  silentSince: Date | null;
  hung: boolean;
}

/** Whether the vlc.exe behind an endpoint still exists. `unknown`: no command lines to match. */
export type PidCheck = { kind: 'alive'; pid: number } | { kind: 'gone' } | { kind: 'unknown'; reason: string };

interface HangEventBase {
  pid: number | null;
  port: number;
  playId: number;
  fileId: number;
  name: string;
  positionS: number;
  silentSince: Date;
}

export type HangEvent = (HangEventBase & { phase: 'start' }) | (HangEventBase & { phase: 'end'; outcome: HangOutcome });

/** What MoviePlayer needs from the monitor for the hang rule (R8.3). */
export interface PlayerHealthLink {
  processAlive(ep: VlcEndpoint): Promise<PidCheck>;
  onHang(e: HangEvent): void;
}

function secondsSince(since: Date | null, now: Date): number | null {
  return since === null ? null : Math.max(0, Math.round((now.getTime() - since.getTime()) / 1000));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** One sample line. `play` only on the VLC whose command line carries the tracked play's password. */
export function sampleRecord(host: string, now: Date, p: VlcProcess, tracked: TrackedVlc | null, withCmd: boolean): SampleRecord {
  const t = tracked !== null && p.commandLine !== null && p.commandLine.includes(tracked.password) ? tracked : null;
  return {
    kind: 'sample',
    ts: now.toISOString(),
    host,
    pid: p.pid,
    ws_bytes: p.wsBytes,
    private_bytes: p.privateBytes,
    handles: p.handles,
    proc_started_at: p.startedAt,
    ours: p.commandLine === null ? null : startedByNotesd(p.commandLine),
    play:
      t === null
        ? null
        : {
            play_id: t.playId,
            file_id: t.fileId,
            name: t.name,
            state: t.state,
            position_s: round1(t.positionS),
            paused_s: t.state === 'paused' ? secondsSince(t.pausedSince, now) : null,
            http_silent_s: secondsSince(t.silentSince, now),
            hung: t.hung,
          },
    cmd: withCmd && p.commandLine !== null ? redactCommandLine(p.commandLine) : null,
  };
}

export function hangRecord(host: string, now: Date, e: HangEvent): HangRecord {
  return {
    kind: 'hang',
    ts: now.toISOString(),
    host,
    phase: e.phase,
    pid: e.pid,
    port: e.port,
    play_id: e.playId,
    file_id: e.fileId,
    name: e.name,
    position_s: round1(e.positionS),
    silent_s: secondsSince(e.silentSince, now) ?? 0,
    outcome: e.phase === 'end' ? e.outcome : null,
  };
}

// ---- The report.

export interface VlcRunSummary {
  pid: number;
  proc_started_at: string | null;
  ours: boolean | null;
  first_at: string;
  last_at: string;
  samples: number;
  ws_first: number;
  ws_last: number;
  ws_max: number;
  private_first: number | null;
  private_last: number | null;
  private_max: number | null;
  handles_max: number | null;
  paused_s_max: number | null;
  /** Bytes per minute from the first to the last sample. */
  ws_growth_per_min: number | null;
  private_growth_per_min: number | null;
  /** Bytes per minute over consecutive samples that were both paused: the leak signal. */
  ws_growth_per_paused_min: number | null;
  private_growth_per_paused_min: number | null;
}

function maxOf(values: Array<number | null>): number | null {
  let m: number | null = null;
  for (const v of values) if (v !== null && (m === null || v > m)) m = v;
  return m;
}

function summarize(list: SampleRecord[]): VlcRunSummary {
  const first = list[0] as SampleRecord;
  const last = list[list.length - 1] as SampleRecord;
  const minutes = (Date.parse(last.ts) - Date.parse(first.ts)) / 60_000;
  let pausedMin = 0;
  let pausedWs = 0;
  let pausedPrivMin = 0;
  let pausedPriv = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1] as SampleRecord;
    const b = list[i] as SampleRecord;
    if (a.play?.state !== 'paused' || b.play?.state !== 'paused') continue;
    const m = (Date.parse(b.ts) - Date.parse(a.ts)) / 60_000;
    if (!(m > 0)) continue;
    pausedMin += m;
    pausedWs += b.ws_bytes - a.ws_bytes;
    if (a.private_bytes !== null && b.private_bytes !== null) {
      pausedPrivMin += m;
      pausedPriv += b.private_bytes - a.private_bytes;
    }
  }
  let ours: boolean | null = null;
  for (const s of list) if (s.ours !== null) ours = s.ours;
  return {
    pid: first.pid,
    proc_started_at: first.proc_started_at,
    ours,
    first_at: first.ts,
    last_at: last.ts,
    samples: list.length,
    ws_first: first.ws_bytes,
    ws_last: last.ws_bytes,
    ws_max: maxOf(list.map((s) => s.ws_bytes)) ?? first.ws_bytes,
    private_first: first.private_bytes,
    private_last: last.private_bytes,
    private_max: maxOf(list.map((s) => s.private_bytes)),
    handles_max: maxOf(list.map((s) => s.handles)),
    paused_s_max: maxOf(list.map((s) => s.play?.paused_s ?? null)),
    ws_growth_per_min: minutes > 0 ? Math.round((last.ws_bytes - first.ws_bytes) / minutes) : null,
    private_growth_per_min:
      minutes > 0 && first.private_bytes !== null && last.private_bytes !== null
        ? Math.round((last.private_bytes - first.private_bytes) / minutes)
        : null,
    ws_growth_per_paused_min: pausedMin > 0 ? Math.round(pausedWs / pausedMin) : null,
    private_growth_per_paused_min: pausedPrivMin > 0 ? Math.round(pausedPriv / pausedPrivMin) : null,
  };
}

/** One summary per VLC process (pid + start time), in order of first appearance. */
export function summarizeRuns(samples: readonly SampleRecord[]): VlcRunSummary[] {
  const runs = new Map<string, SampleRecord[]>();
  for (const s of samples) {
    const key = `${s.pid}|${s.proc_started_at ?? ''}`;
    const list = runs.get(key);
    if (list === undefined) runs.set(key, [s]);
    else list.push(s);
  }
  return [...runs.values()].map(summarize);
}

export interface HealthStatus {
  sampling: boolean;
  reason: HealthOffReason | 'not_started' | null;
  interval_ms: number;
  process_detail: boolean;
  log_file: string;
}

export interface HealthReport extends HealthStatus {
  host: string;
  samples: SampleRecord[];
  runs: VlcRunSummary[];
  hangs: HangRecord[];
  incidents: IncidentRecord[];
  last_start: StartRecord | null;
}

/** GET /api/movies/player/health: the newest `limit` samples, run summaries over every sample read, hangs, incidents. */
export function healthReport(records: readonly HealthRecord[], o: { host: string; limit: number; status: HealthStatus }): HealthReport {
  const samples = records.filter((r): r is SampleRecord => r.kind === 'sample');
  const hangs = records.filter((r): r is HangRecord => r.kind === 'hang');
  const incidents = records.filter((r): r is IncidentRecord => r.kind === 'incident');
  let lastStart: StartRecord | null = null;
  for (const r of records) if (r.kind === 'start') lastStart = r;
  return {
    ...o.status,
    host: o.host,
    samples: samples.slice(-o.limit),
    runs: summarizeRuns(samples),
    hangs: hangs.slice(-REPORT_HANGS),
    incidents: incidents.slice(-REPORT_INCIDENTS),
    last_start: lastStart,
  };
}

// ---- The monitor.

export interface HealthMonitorDeps {
  /** MoviesService.host (os.hostname()). */
  host: string;
  /** `<dataDir>/movies`. */
  logDir: string;
  /** NOTESD_VLC_HEALTH_MS; 0 = off. */
  intervalMs: number;
  detect: () => Promise<HealthDetection>;
  /** The play the player follows now (MoviePlayer.healthView()). */
  tracked: () => TrackedVlc | null;
  /** Default: windowsProcessLister. */
  makeLister?: (env: HealthEnv) => ProcessLister;
  /** Default: powershellEventLogReader when powershell.exe exists, else null. */
  makeEvents?: (env: HealthEnv) => EventLogReader | null;
  now?: () => Date;
  log?: (line: string) => void;
  maxLogBytes?: number;
}

type Mode =
  | { kind: 'not_started' }
  | { kind: 'off'; reason: HealthOffReason }
  | { kind: 'on'; env: HealthEnv; lister: ProcessLister; events: EventLogReader | null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Samples every vlc.exe on this host into the health log (R8.1), writes an incident at start when
 * the previous run died while sampling (R8.2), records the player's hangs (R8.3) and answers the
 * health route (R8.5). Read only on the Windows side: it never kills, pauses or restarts a VLC.
 */
export class HealthMonitor implements PlayerHealthLink {
  readonly store: HealthLog;
  private mode: Mode = { kind: 'not_started' };
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private incident: Promise<void> | null = null;
  private closed = false;
  private sampling = false;
  private listErrorLogged = false;
  private cmdLogged = new Set<number>();

  constructor(private readonly deps: HealthMonitorDeps) {
    this.store = new HealthLog(deps.logDir, deps.host, deps.maxLogBytes ?? MAX_LOG_BYTES);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private say(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(line);
  }

  /** Detect, judge the previous run, write `start`, start ticking. The incident is written in the background (settled()). */
  async start(): Promise<void> {
    if (this.mode.kind !== 'not_started' || this.closed) return;
    if (this.deps.intervalMs === 0) {
      this.mode = { kind: 'off', reason: 'disabled' };
      this.say('[notesd] vlc health off (NOTESD_VLC_HEALTH_MS=0 or no NOTESD_MOVIES_ROOTS)');
      return;
    }
    const d = await this.deps.detect();
    if (this.closed) return;
    if (!d.available) {
      this.mode = { kind: 'off', reason: d.reason };
      this.say(`[notesd] vlc health off (${d.reason})`);
      return;
    }
    const lister = (this.deps.makeLister ?? ((env: HealthEnv) => windowsProcessLister(env)))(d.env);
    const events =
      this.deps.makeEvents !== undefined
        ? this.deps.makeEvents(d.env)
        : d.env.powershell === null
          ? null
          : powershellEventLogReader(d.env.powershell);
    const startedAt = this.now();
    const previous = analyzePreviousRun(this.store.readTail(TAIL_BYTES));
    this.store.append({
      kind: 'start',
      ts: startedAt.toISOString(),
      host: this.deps.host,
      daemon_pid: process.pid,
      interval_ms: this.deps.intervalMs,
      process_detail: d.env.powershell !== null,
      previous: previous.kind,
    });
    this.mode = { kind: 'on', env: d.env, lister, events };
    this.say(
      `[notesd] vlc health: sampling vlc.exe every ${Math.round(this.deps.intervalMs / 1000)} s into ${this.store.file}` +
        (d.env.powershell === null ? ' (no powershell.exe: pid and working set only)' : ''),
    );
    if (previous.kind === 'unclean_sampling') {
      this.say(`[notesd] vlc health: the previous run stopped uncleanly at ${previous.lastRecordAt} while vlc.exe was sampled; writing an incident`);
      this.incident = this.recordIncident(previous, events, startedAt).catch((err: unknown) =>
        this.say(`[notesd] vlc health: incident failed: ${message(err)}`),
      );
    }
    this.schedule();
  }

  /** Resolves once the start-up incident (if any) is in the log. */
  async settled(): Promise<void> {
    if (this.incident !== null) await this.incident;
  }

  private async recordIncident(previous: UncleanSampling, events: EventLogReader | null, startedAt: Date): Promise<void> {
    const window = incidentWindow(previous, startedAt);
    const result: EventsResult =
      events === null ? { kind: 'error', message: 'no powershell.exe: Windows events not read' } : await events.read(window.from, window.to);
    const record = buildIncident({ host: this.deps.host, now: this.now(), previous, window, events: result });
    this.store.append(record);
    this.say(
      `[notesd] vlc health: incident written: ${record.samples.length} sample(s), ${record.events.length} Windows fault event(s)` +
        (record.events_error === null ? '' : ` (${record.events_error})`),
    );
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.sampleNow()
        .then(
          () => undefined,
          (err: unknown) => this.say(`[notesd] vlc health: sample failed: ${message(err)}`),
        )
        .finally(() => {
          this.inFlight = null;
          this.schedule();
        });
    }, this.deps.intervalMs);
    this.timer.unref();
  }

  /** One tick: a sample line per vlc.exe, an `idle` line when the last one went away. Returns the samples written. */
  async sampleNow(): Promise<number> {
    if (this.mode.kind !== 'on' || this.closed) return 0;
    const listing = await this.mode.lister.list();
    if (this.closed) return 0;
    if (listing.kind === 'error') {
      if (!this.listErrorLogged) this.say(`[notesd] vlc health: listing vlc.exe failed: ${listing.message}`);
      this.listErrorLogged = true;
      return 0;
    }
    this.listErrorLogged = false;
    const now = this.now();
    if (listing.processes.length === 0) {
      if (this.sampling) this.store.append({ kind: 'idle', ts: now.toISOString(), host: this.deps.host });
      this.sampling = false;
      this.cmdLogged.clear();
      return 0;
    }
    const tracked = this.deps.tracked();
    const logged = new Set<number>();
    for (const p of listing.processes) {
      const withCmd = p.commandLine !== null && !this.cmdLogged.has(p.pid);
      this.store.append(sampleRecord(this.deps.host, now, p, tracked, withCmd));
      if (p.commandLine !== null || this.cmdLogged.has(p.pid)) logged.add(p.pid);
    }
    this.cmdLogged = logged;
    this.sampling = true;
    return listing.processes.length;
  }

  async processAlive(ep: VlcEndpoint): Promise<PidCheck> {
    const mode = this.mode;
    if (mode.kind !== 'on') return { kind: 'unknown', reason: mode.kind === 'off' ? mode.reason : 'not_started' };
    const listing = await mode.lister.list();
    if (listing.kind === 'error') return { kind: 'unknown', reason: listing.message };
    if (listing.processes.length === 0) return { kind: 'gone' };
    if (!listing.detail) return { kind: 'unknown', reason: 'no_process_detail' };
    const p = listing.processes.find((x) => x.commandLine !== null && x.commandLine.includes(ep.password));
    return p === undefined ? { kind: 'gone' } : { kind: 'alive', pid: p.pid };
  }

  onHang(e: HangEvent): void {
    if (this.mode.kind !== 'on' || this.closed) return;
    try {
      this.store.append(hangRecord(this.deps.host, this.now(), e));
    } catch (err) {
      this.say(`[notesd] vlc health: could not write a hang line: ${message(err)}`);
    }
  }

  status(): HealthStatus {
    const m = this.mode;
    return {
      sampling: m.kind === 'on' && !this.closed,
      reason: m.kind === 'off' ? m.reason : m.kind === 'not_started' ? 'not_started' : null,
      interval_ms: this.deps.intervalMs,
      process_detail: m.kind === 'on' && m.env.powershell !== null,
      log_file: this.store.file,
    };
  }

  report(limit: number): HealthReport {
    return healthReport(this.store.readTail(REPORT_BYTES), { host: this.deps.host, limit, status: this.status() });
  }

  /** Daemon stop, after the player closed: finish a tick, give a pending incident up to 3 s, write `clean_stop`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) await this.inFlight;
    if (this.incident !== null) {
      let waiter: NodeJS.Timeout | undefined;
      await Promise.race([
        this.incident,
        new Promise<void>((resolve) => {
          waiter = setTimeout(resolve, INCIDENT_WAIT_ON_CLOSE_MS);
        }),
      ]);
      if (waiter !== undefined) clearTimeout(waiter);
    }
    if (this.mode.kind === 'on') this.store.append({ kind: 'clean_stop', ts: this.now().toISOString(), host: this.deps.host });
  }
}

export interface VlcHealthOptions {
  config: MoviesConfig;
  dataDir: string;
  host: string;
  tracked: () => TrackedVlc | null;
  probe?: DetectProbe;
  makeLister?: (env: HealthEnv) => ProcessLister;
  makeEvents?: (env: HealthEnv) => EventLogReader | null;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The daemon's monitor: `<dataDir>/movies`, `config.vlc.healthMs`, real WSL detection. Builds nothing that runs until start(). */
export function buildVlcHealth(o: VlcHealthOptions): HealthMonitor {
  const probe = o.probe ?? nodeProbe();
  return new HealthMonitor({
    host: o.host,
    logDir: path.join(o.dataDir, MOVIES_SUBDIR),
    // Invariant 5: with no library roots nothing runs on its own, so the sampler stays off (as NOTESD_VLC_HEALTH_MS=0).
    intervalMs: o.config.roots.length === 0 ? 0 : o.config.vlc.healthMs,
    detect: () => detectHealthEnv(probe),
    tracked: o.tracked,
    ...(o.makeLister !== undefined ? { makeLister: o.makeLister } : {}),
    ...(o.makeEvents !== undefined ? { makeEvents: o.makeEvents } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.log !== undefined ? { log: o.log } : {}),
  });
}
