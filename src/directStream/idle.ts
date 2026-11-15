import { nodeProbe, WSL_INTEROP_FILES, type DetectProbe } from '../http/reveal.js';
import { DEFAULT_POWERSHELL_EXE, POWERSHELL_ENV, resolveWindowsExe } from '../movies/vlc/health.js';
import { execCapture, type ExecFn } from '../movies/vlc/http.js';
import { lastJsonLine, powershellArgs } from '../movies/vlc/incidents.js';

/**
 * How long Windows has had no keyboard or mouse input, for the direct-streaming prober (D6: it
 * probes only while the laptop is idle). One powershell.exe run (NOTESD_POWERSHELL_EXE, the same
 * override the VLC code uses) calls user32 GetLastInputInfo. Outside WSL, or without powershell.exe,
 * there is no idle time to read and the prober stays off, saying why.
 */

export const IDLE_TIMEOUT_MS = 15_000;

export type IdleReading = { kind: 'ok'; idleSeconds: number } | { kind: 'error'; message: string };
export type IdleReader = () => Promise<IdleReading>;
export type IdleOffReason = 'not_linux' | 'no_interop' | 'no_powershell';
export type IdleDetection = { available: true; read: IdleReader } | { available: false; reason: IdleOffReason };

/**
 * Prints `{"idle_ms":N}`: milliseconds since the last input of the interactive session. The
 * subtraction is unsigned, so it stays right when the 32-bit tick count wraps (every 49.7 days).
 * N is -1 when GetLastInputInfo fails.
 */
export const IDLE_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class NotesdIdle {',
  '  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);',
  '  public static long IdleMs() {',
  '    LastInput info = new LastInput(); info.cbSize = (uint)Marshal.SizeOf(typeof(LastInput));',
  '    if (!GetLastInputInfo(ref info)) return -1;',
  '    return (long)unchecked((uint)Environment.TickCount - info.dwTime);',
  '  }',
  '}',
  '"@',
  '$ms = [NotesdIdle]::IdleMs()',
  '"{`"idle_ms`":$ms}"',
].join('\n');

/** Whole idle seconds from the script's last JSON line; null when it is not that line or N < 0. */
export function parseIdleOutput(stdout: string): number | null {
  const line = lastJsonLine(stdout);
  if (line === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const ms = (raw as { idle_ms?: unknown }).idle_ms;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 1000);
}

/** The real reader. Never throws: a failed run is an `error` reading, which the prober treats as "not idle". */
export function powershellIdleReader(powershell: string, exec: ExecFn = execCapture): IdleReader {
  const args = powershellArgs(IDLE_SCRIPT);
  return async () => {
    const r = await exec(powershell, args, IDLE_TIMEOUT_MS);
    if (r.exitCode !== 0) return { kind: 'error', message: `powershell.exe exited ${r.exitCode}` };
    const idleSeconds = parseIdleOutput(r.stdout);
    return idleSeconds === null ? { kind: 'error', message: 'unreadable idle output' } : { kind: 'ok', idleSeconds };
  };
}

/** Linux + WSL interop + powershell.exe, or why not. Never throws. */
export async function detectIdleReader(probe: DetectProbe = nodeProbe(), exec: ExecFn = execCapture): Promise<IdleDetection> {
  if (probe.platform !== 'linux') return { available: false, reason: 'not_linux' };
  let interop = false;
  for (const file of WSL_INTEROP_FILES) {
    if (await probe.exists(file)) {
      interop = true;
      break;
    }
  }
  if (!interop) return { available: false, reason: 'no_interop' };
  const powershell = await resolveWindowsExe(probe, POWERSHELL_ENV, DEFAULT_POWERSHELL_EXE);
  if (powershell === null) return { available: false, reason: 'no_powershell' };
  return { available: true, read: powershellIdleReader(powershell, exec) };
}
