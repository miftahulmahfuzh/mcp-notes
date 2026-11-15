import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVIES_CONFIG } from '../../../src/config.js';
import { buildVlcFinder, notesdVlcs, type VlcProcess } from '../../../src/movies/vlc/health.js';

const PW = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const proc = (o: Partial<VlcProcess> & { pid: number }): VlcProcess => ({ wsBytes: 1, privateBytes: 1, handles: 1, startedAt: null, commandLine: null, ...o });

describe('finding the VLCs notesd started', () => {
  it('reads port and password from the command line, newest process first, and skips a VLC opened by hand or without detail', () => {
    const ours = (port: number, pw: string) => `vlc.exe --no-one-instance --fullscreen --extraintf http --http-host 127.0.0.1 --http-port ${port} --http-password ${pw} --start-time=31 "C:\\Films\\A.mkv"`;
    const found = notesdVlcs([
      proc({ pid: 1, startedAt: '2026-11-15T01:00:00.000Z', commandLine: ours(47318, PW) }),
      proc({ pid: 2, commandLine: '"C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" --started-from-file "C:\\Films\\B.mkv"' }),
      proc({ pid: 3 }),
      proc({ pid: 4, startedAt: '2026-11-15T02:00:00.000Z', commandLine: ours(47319, 'f'.repeat(32)) }),
    ]);
    expect(found.map((v) => [v.pid, v.port, v.password])).toEqual([
      [4, 47319, 'f'.repeat(32)],
      [1, 47318, PW],
    ]);
  });

  it('is not built when the health log is off or the library has no roots, so nothing on the Windows side is read', () => {
    expect(buildVlcFinder(DEFAULT_MOVIES_CONFIG)).toBeNull();
    expect(buildVlcFinder({ ...DEFAULT_MOVIES_CONFIG, roots: ['/lib'], vlc: { ...DEFAULT_MOVIES_CONFIG.vlc, healthMs: 0 } })).toBeNull();
  });

  it('answers [] outside WSL and lists through tasklist and PowerShell inside it', async () => {
    const config = { ...DEFAULT_MOVIES_CONFIG, roots: ['/lib'], vlc: { ...DEFAULT_MOVIES_CONFIG.vlc, healthMs: 30_000 } };
    const off = buildVlcFinder(config, { platform: 'darwin', env: {}, exists: async () => false, executable: async () => false });
    expect(await off!()).toEqual([]);
    const ps = JSON.stringify([{ pid: 9, ws: 1, priv: 1, handles: 1, started: '2026-11-15T01:00:00.000Z', cmd: `vlc.exe --extraintf http --http-port 47318 --http-password ${PW} C:\\A.mkv` }]);
    const on = buildVlcFinder(
      config,
      { platform: 'linux', env: {}, exists: async () => true, executable: async () => true },
      async (cmd) => ({ exitCode: 0, stdout: cmd.includes('tasklist') ? '"vlc.exe","9","Console","1","512,000 K"\r\n' : ps }),
    );
    expect(await on!()).toMatchObject([{ pid: 9, port: 47318, password: PW }]);
  });
});
