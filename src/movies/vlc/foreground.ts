import { nodeProbe, onceAsync, type DetectProbe } from '../../http/reveal.js';
import { DEFAULT_POWERSHELL_EXE, POWERSHELL_ENV, resolveWindowsExe } from './health.js';
import { execCapture, type ExecFn, type VlcEndpoint } from './http.js';
import { powershellArgs } from './incidents.js';

export const FOREGROUND_TIMEOUT_MS = 20_000;
/** How long the script waits for the new vlc.exe to have a window: 25 tries, 200 ms apart. */
export const FOREGROUND_WINDOW_TRIES = 25;

/** What one attempt to put a VLC window in front came to. Never thrown: a film that plays behind another window is not a failed play. */
export type ForegroundResult =
  | { kind: 'ok'; pid: number; foreground: boolean }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/** Puts the window of the VLC notesd started on `ep` in front of every other window. */
export type VlcForegrounder = (ep: VlcEndpoint) => Promise<ForegroundResult>;

/**
 * Finds the vlc.exe whose command line carries this launch's HTTP password (so never a VLC notesd
 * did not start), waits for its window and makes it the foreground window. Windows lets only the
 * foreground thread hand the foreground over, so the script attaches its input to that thread for
 * the call. MEASURED 2026-11-14: without this a VLC started by the daemon opens behind the window
 * in use; with it, run from the systemd service, VLC is in front in about 0.7 s.
 */
export function foregroundScript(password: string): string {
  if (!/^[0-9a-f]+$/.test(password)) throw new Error('foregroundScript: the HTTP password must be hex');
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public class NotesdFg {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '}',
    '"@',
    `$needle = '${password}'`,
    '$h = [IntPtr]::Zero; $vpid = 0',
    `for ($i = 0; $i -lt ${FOREGROUND_WINDOW_TRIES} -and $h -eq [IntPtr]::Zero; $i++) {`,
    '  $p = Get-CimInstance Win32_Process -Filter "Name=\'vlc.exe\'" | Where-Object { $_.CommandLine -like "*$needle*" } | Select-Object -First 1',
    '  if ($p) { $vpid = [int]$p.ProcessId; $h = (Get-Process -Id $vpid).MainWindowHandle }',
    '  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }',
    '}',
    "if ($h -eq [IntPtr]::Zero) { '{\"found\":false}'; exit 0 }",
    'if ([NotesdFg]::GetForegroundWindow() -ne $h) {',
    '  if ([NotesdFg]::IsIconic($h)) { [void][NotesdFg]::ShowWindow($h, 9) }',
    '  $x = 0; $fg = [NotesdFg]::GetWindowThreadProcessId([NotesdFg]::GetForegroundWindow(), [ref]$x); $me = [NotesdFg]::GetCurrentThreadId()',
    '  [void][NotesdFg]::AttachThreadInput($me, $fg, $true)',
    '  [void][NotesdFg]::BringWindowToTop($h); [void][NotesdFg]::SetForegroundWindow($h)',
    '  [void][NotesdFg]::AttachThreadInput($me, $fg, $false)',
    '  Start-Sleep -Milliseconds 150',
    '}',
    '$ok = ([NotesdFg]::GetForegroundWindow() -eq $h).ToString().ToLower()',
    '"{`"found`":true,`"pid`":$vpid,`"foreground`":$ok}"',
  ].join('\n');
}

/** The script's one JSON line -> a result; null when it is not that line. */
export function parseForegroundOutput(stdout: string): ForegroundResult | null {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
  if (line === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.found === false) return { kind: 'not_found' };
  if (o.found !== true || typeof o.pid !== 'number' || typeof o.foreground !== 'boolean') return null;
  return { kind: 'ok', pid: o.pid, foreground: o.foreground };
}

/** The real foregrounder: one powershell.exe run (`NOTESD_POWERSHELL_EXE`); `unavailable` without it. */
export function windowsForegrounder(probe: DetectProbe = nodeProbe(), exec: ExecFn = execCapture): VlcForegrounder {
  const powershell = onceAsync(() => resolveWindowsExe(probe, POWERSHELL_ENV, DEFAULT_POWERSHELL_EXE));
  return async (ep) => {
    const exe = await powershell();
    if (exe === null) return { kind: 'unavailable' };
    const r = await exec(exe, powershellArgs(foregroundScript(ep.password)), FOREGROUND_TIMEOUT_MS);
    if (r.exitCode !== 0) return { kind: 'error', message: `powershell.exe exited ${r.exitCode}` };
    return parseForegroundOutput(r.stdout) ?? { kind: 'error', message: 'unreadable foreground output' };
  };
}
