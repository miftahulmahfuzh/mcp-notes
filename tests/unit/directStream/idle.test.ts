import { describe, expect, it } from 'vitest';
import { detectIdleReader, IDLE_SCRIPT, IDLE_TIMEOUT_MS, parseIdleOutput, powershellIdleReader } from '../../../src/directStream/idle.js';
import type { DetectProbe } from '../../../src/http/reveal.js';
import { DEFAULT_POWERSHELL_EXE } from '../../../src/movies/vlc/health.js';
import type { ExecFn } from '../../../src/movies/vlc/http.js';
import { powershellArgs } from '../../../src/movies/vlc/incidents.js';

function probe(over: { platform?: NodeJS.Platform; env?: Record<string, string>; files?: string[]; exes?: string[] }): DetectProbe {
  return {
    platform: over.platform ?? 'linux',
    env: over.env ?? {},
    exists: async (p) => (over.files ?? ['/proc/sys/fs/binfmt_misc/WSLInterop']).includes(p),
    executable: async (p) => (over.exes ?? [DEFAULT_POWERSHELL_EXE]).includes(p),
  };
}

describe('idle time', () => {
  it('says why it cannot be read outside WSL or without powershell.exe', async () => {
    expect(await detectIdleReader(probe({ platform: 'darwin' }))).toEqual({ available: false, reason: 'not_linux' });
    expect(await detectIdleReader(probe({ files: [] }))).toEqual({ available: false, reason: 'no_interop' });
    expect(await detectIdleReader(probe({ exes: [] }))).toEqual({ available: false, reason: 'no_powershell' });
  });

  it('runs NOTESD_POWERSHELL_EXE when it is set', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: '{"idle_ms":1000}\r\n' };
    };
    const d = await detectIdleReader(probe({ env: { NOTESD_POWERSHELL_EXE: '/opt/ps' }, exes: ['/opt/ps'] }), exec);
    if (!d.available) throw new Error('expected a reader');
    expect(await d.read()).toEqual({ kind: 'ok', idleSeconds: 1 });
    expect(calls).toEqual(['/opt/ps']);
  });

  it('asks GetLastInputInfo through an encoded script with a timeout', async () => {
    let seen: { args: string[]; timeout: number } | null = null;
    const exec: ExecFn = async (_cmd, args, timeout) => {
      seen = { args, timeout };
      return { exitCode: 0, stdout: 'noise\n{"idle_ms":754999}\n' };
    };
    expect(await powershellIdleReader('/ps', exec)()).toEqual({ kind: 'ok', idleSeconds: 754 });
    expect(seen).toEqual({ args: powershellArgs(IDLE_SCRIPT), timeout: IDLE_TIMEOUT_MS });
    expect(IDLE_SCRIPT).toContain('GetLastInputInfo');
  });

  it('turns a failed or unreadable run into an error reading', async () => {
    expect(await powershellIdleReader('/ps', async () => ({ exitCode: 1, stdout: '' }))()).toEqual({ kind: 'error', message: 'powershell.exe exited 1' });
    expect(await powershellIdleReader('/ps', async () => ({ exitCode: 0, stdout: '{"found":false}' }))()).toEqual({ kind: 'error', message: 'unreadable idle output' });
    expect(parseIdleOutput('{"idle_ms":-1}')).toBeNull();
    expect(parseIdleOutput('{"found":false,"idle_ms":3600000}')).toBe(3600);
  });
});
