import { z } from 'zod';
import { execCapture, type ExecFn } from './http.js';
import type { HangRecord, HealthRecord, IncidentRecord, SamplePlay, SampleRecord, WinFaultEvent } from './health.js';

/** Samples of the dead run an incident keeps (20 min at the default 30 s). */
export const INCIDENT_SAMPLES = 40;
/** Windows events are read from this long before the last sample ... */
export const EVENTS_BEFORE_MS = 10 * 60_000;
/** ... to this long after the dead run's last line (or the daemon start, if sooner). */
export const EVENTS_AFTER_MS = 15 * 60_000;
export const EVENTS_TIMEOUT_MS = 20_000;
export const EVENT_MESSAGE_CHARS = 500;
/** Windows "Application Error" (a process crashed) and "Application Hang" (stopped responding). */
export const APPLICATION_ERROR_ID = 1000;
export const APPLICATION_HANG_ID = 1002;

/** How the previous daemon run ended, judged from the tail of the health log. */
export type PreviousRun =
  | { kind: 'none' }
  | { kind: 'clean'; stoppedAt: string }
  | { kind: 'unclean_idle'; lastRecordAt: string }
  | UncleanSampling;

/** The run died while a vlc.exe was being sampled: the case R8.2 writes an incident for. */
export interface UncleanSampling {
  kind: 'unclean_sampling';
  previousStartAt: string | null;
  lastRecordAt: string;
  lastSampleAt: string;
  samples: SampleRecord[];
  hangs: HangRecord[];
}

/**
 * Of the lines after the last `start`, the newest `sample` / `idle` / `clean_stop` decides:
 * clean_stop -> clean; idle or none -> unclean_idle (no VLC was being sampled); sample -> unclean_sampling.
 * Hang and incident lines are not state. An empty log is `none`.
 */
export function analyzePreviousRun(records: readonly HealthRecord[]): PreviousRun {
  if (records.length === 0) return { kind: 'none' };
  let startIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.kind === 'start') {
      startIdx = i;
      break;
    }
  }
  const run = records.slice(startIdx + 1);
  const previousStartAt = startIdx >= 0 ? (records[startIdx]?.ts ?? null) : null;
  const lastRecordAt = (run.length > 0 ? run[run.length - 1] : records[records.length - 1])?.ts ?? '';
  let lastState: HealthRecord | null = null;
  for (let i = run.length - 1; i >= 0; i--) {
    const r = run[i];
    if (r !== undefined && (r.kind === 'sample' || r.kind === 'idle' || r.kind === 'clean_stop')) {
      lastState = r;
      break;
    }
  }
  if (lastState === null || lastState.kind === 'idle') return { kind: 'unclean_idle', lastRecordAt };
  if (lastState.kind === 'clean_stop') return { kind: 'clean', stoppedAt: lastState.ts };
  const samples = run.filter((r): r is SampleRecord => r.kind === 'sample').slice(-INCIDENT_SAMPLES);
  const hangs = run.filter((r): r is HangRecord => r.kind === 'hang');
  return { kind: 'unclean_sampling', previousStartAt, lastRecordAt, lastSampleAt: lastState.ts, samples, hangs };
}

/** [last sample - 10 min, min(now, last line + 15 min)]; never empty. */
export function incidentWindow(prev: Pick<UncleanSampling, 'lastSampleAt' | 'lastRecordAt'>, now: Date): { from: Date; to: Date } {
  const from = Date.parse(prev.lastSampleAt) - EVENTS_BEFORE_MS;
  let to = Math.min(now.getTime(), Date.parse(prev.lastRecordAt) + EVENTS_AFTER_MS);
  if (!(to > from)) to = from + EVENTS_BEFORE_MS + EVENTS_AFTER_MS;
  return { from: new Date(from), to: new Date(to) };
}

/** The JSON a PowerShell script printed: its last line that starts with `[` or `{`. */
export function lastJsonLine(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? '').trim();
    if (t.startsWith('[') || t.startsWith('{')) return t;
  }
  return null;
}

/** powershell.exe argv: the script as -EncodedCommand (UTF-16LE base64), so no quote is lost through WSL interop. */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/**
 * Application Error / Application Hang events between two instants as one JSON array.
 * MEASURED 2026-11-14: FilterHashtable needs local DateTimes (a UTC DateTime matched nothing).
 */
export function eventsScript(from: Date, to: Date): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$from = [DateTimeOffset]::Parse('${from.toISOString()}').LocalDateTime`,
    `$to = [DateTimeOffset]::Parse('${to.toISOString()}').LocalDateTime`,
    "$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error', 'Application Hang'; StartTime = $from; EndTime = $to } -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq 1000 -or $_.Id -eq 1002 } | ForEach-Object { [pscustomobject]@{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); id = [int]$_.Id; provider = $_.ProviderName; props = @($_.Properties | ForEach-Object { [string]$_.Value }); message = $_.Message } })",
    'ConvertTo-Json -InputObject $ev -Compress -Depth 3',
  ].join('\n');
}

/** `c0000005` / `0xC0000005` -> `0xc0000005`; anything else is kept as written. */
export function exceptionCode(v: string | null): string | null {
  if (v === null) return null;
  const hex = v.toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{1,8}$/.test(hex) ? `0x${hex.padStart(8, '0')}` : v;
}

const rawEventSchema = z.object({
  time: z.string(),
  id: z.number().int(),
  provider: z.string(),
  props: z.array(z.string().nullable()).nullable().optional(),
  message: z.string().nullable().optional(),
});
type RawEvent = z.infer<typeof rawEventSchema>;

function toFaultEvent(e: RawEvent): WinFaultEvent {
  const props = e.props ?? [];
  const at = (i: number): string | null => {
    const v = props[i];
    return v === undefined || v === null || v.trim() === '' ? null : v.trim();
  };
  const message = e.message === undefined || e.message === null ? null : e.message.slice(0, EVENT_MESSAGE_CHARS);
  if (e.id === APPLICATION_ERROR_ID) {
    // MEASURED 2026-11-14: [0] application, [3] faulting module, [6] exception code, [8] pid.
    return { time: e.time, event_id: e.id, provider: e.provider, application: at(0), module: at(3), exception_code: exceptionCode(at(6)), message };
  }
  return { time: e.time, event_id: e.id, provider: e.provider, application: at(0), module: null, exception_code: null, message };
}

/** eventsScript's stdout -> events (1000 and 1002 only); null when it is not that JSON. */
export function parseWinEvents(stdout: string): WinFaultEvent[] | null {
  const json = lastJsonLine(stdout);
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = z.union([z.array(rawEventSchema), rawEventSchema]).safeParse(raw);
  if (!parsed.success) return null;
  const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return list.filter((e) => e.id === APPLICATION_ERROR_ID || e.id === APPLICATION_HANG_ID).map(toFaultEvent);
}

export type EventsResult = { kind: 'ok'; events: WinFaultEvent[] } | { kind: 'error'; message: string };

/** Reads the Windows Application log. Read only; never throws. */
export interface EventLogReader {
  read(from: Date, to: Date): Promise<EventsResult>;
}

export function powershellEventLogReader(powershell: string, exec: ExecFn = execCapture): EventLogReader {
  return {
    async read(from, to) {
      const r = await exec(powershell, powershellArgs(eventsScript(from, to)), EVENTS_TIMEOUT_MS);
      if (r.exitCode !== 0) return { kind: 'error', message: `powershell.exe exited ${r.exitCode}` };
      const events = parseWinEvents(r.stdout);
      return events === null ? { kind: 'error', message: 'unreadable Get-WinEvent output' } : { kind: 'ok', events };
    },
  };
}

/** One incident line: the dead run's last samples, its hangs, the play it followed, and the in-window events. */
export function buildIncident(input: {
  host: string;
  now: Date;
  previous: UncleanSampling;
  window: { from: Date; to: Date };
  events: EventsResult;
}): IncidentRecord {
  const fromMs = input.window.from.getTime();
  const toMs = input.window.to.getTime();
  const events =
    input.events.kind === 'ok'
      ? input.events.events
          .filter((e) => {
            const t = Date.parse(e.time);
            return t >= fromMs && t <= toMs;
          })
          .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      : [];
  let openPlay: SamplePlay | null = null;
  for (const s of input.previous.samples) {
    if (s.ts === input.previous.lastSampleAt && s.play !== null) openPlay = s.play;
  }
  return {
    kind: 'incident',
    ts: input.now.toISOString(),
    host: input.host,
    previous_start_at: input.previous.previousStartAt,
    last_record_at: input.previous.lastRecordAt,
    last_sample_at: input.previous.lastSampleAt,
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    samples: input.previous.samples,
    hangs: input.previous.hangs,
    open_play: openPlay,
    events,
    events_error: input.events.kind === 'error' ? input.events.message : null,
  };
}
