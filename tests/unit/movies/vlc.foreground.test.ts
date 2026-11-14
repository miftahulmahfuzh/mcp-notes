import { describe, expect, it } from 'vitest';
import { foregroundScript, parseForegroundOutput, windowsForegrounder } from '../../../src/movies/vlc/foreground.js';
import type { DetectProbe } from '../../../src/http/reveal.js';
import type { ExecFn } from '../../../src/movies/vlc/http.js';

const EP = { port: 47318, password: 'ab12cd34' };
const probe = (powershell: string | null): DetectProbe =>
  ({ platform: 'linux', env: { NOTESD_POWERSHELL_EXE: '/win/powershell.exe' }, exists: async () => true, executable: async (p: string) => p === powershell }) as unknown as DetectProbe;

describe('foregroundScript', () => {
  it('matches only the vlc.exe of this launch, by its HTTP password', () => {
    const script = foregroundScript('ab12cd34');
    expect(script).toContain("$needle = 'ab12cd34'");
    expect(script).toContain('SetForegroundWindow');
    expect(() => foregroundScript("x'; calc")).toThrow();
  });
});

describe('parseForegroundOutput', () => {
  it('reads the last JSON line', () => {
    expect(parseForegroundOutput('{"found":true,"pid":14572,"foreground":true}\r\n')).toEqual({ kind: 'ok', pid: 14572, foreground: true });
    expect(parseForegroundOutput('noise\r\n{"found":false}\r\n')).toEqual({ kind: 'not_found' });
    expect(parseForegroundOutput('nope')).toBeNull();
  });
});

describe('windowsForegrounder', () => {
  it('runs powershell.exe with the script encoded, and reports what it printed', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { exitCode: 0, stdout: '{"found":true,"pid":9,"foreground":false}\r\n' };
    };
    expect(await windowsForegrounder(probe('/win/powershell.exe'), exec)(EP)).toEqual({ kind: 'ok', pid: 9, foreground: false });
    expect(calls[0]!.slice(0, 4)).toEqual(['/win/powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(calls[0]![4]!, 'base64').toString('utf16le')).toBe(foregroundScript(EP.password));
  });

  it('is unavailable without powershell.exe and an error when it fails', async () => {
    const never: ExecFn = async () => ({ exitCode: 1, stdout: '' });
    expect(await windowsForegrounder(probe(null), never)(EP)).toEqual({ kind: 'unavailable' });
    expect(await windowsForegrounder(probe('/win/powershell.exe'), never)(EP)).toEqual({ kind: 'error', message: 'powershell.exe exited 1' });
  });
});
