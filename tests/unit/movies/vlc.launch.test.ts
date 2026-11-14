import { describe, expect, it } from 'vitest';
import type { DetectProbe } from '../../../src/http/reveal.js';
import { detectPlayerEnv, newHttpPassword, runningAsSystemdService, scopeArgs, vlcArgs } from '../../../src/movies/vlc/launch.js';

describe('VLC outlives a daemon restart (Design decision 8)', () => {
  it('detects a systemd service from /proc/self/cgroup, not a tmux shell or the user manager', () => {
    expect(runningAsSystemdService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/notesd.service\n')).toBe(true);
    expect(runningAsSystemdService('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.slice/tmux-spawn-1.scope\n')).toBe(false);
    expect(runningAsSystemdService('0::/user.slice/user-1000.slice/user@1000.service\n')).toBe(false);
    expect(runningAsSystemdService('')).toBe(false);
  });
  it('puts VLC in its own transient user scope', () => {
    expect(scopeArgs('/mnt/c/vlc.exe', ['--x', 'C:\\f.mkv'])).toEqual(['--user', '--scope', '--quiet', '--collect', '--', '/mnt/c/vlc.exe', '--x', 'C:\\f.mkv']);
  });
});

const VLC = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe';
const CURL = '/mnt/c/Windows/System32/curl.exe';
const BINS = { bin: VLC, curlExe: CURL };

function probe(o: { platform?: NodeJS.Platform; files?: string[]; execs?: string[] } = {}): DetectProbe {
  const files = new Set(o.files ?? ['/proc/sys/fs/binfmt_misc/WSLInterop']);
  const execs = new Set(o.execs ?? ['/usr/bin/wslpath', VLC, CURL]);
  return {
    platform: o.platform ?? 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    exists: async (p) => files.has(p) || execs.has(p),
    executable: async (p) => execs.has(p),
  };
}

describe('detectPlayerEnv', () => {
  it('is available with interop, wslpath, vlc.exe and curl.exe', async () => {
    expect(await detectPlayerEnv(BINS, probe())).toEqual({ available: true, env: { vlc: VLC, curl: CURL, wslpath: '/usr/bin/wslpath' } });
  });

  it('accepts the -late interop entry of newer WSL builds', async () => {
    const d = await detectPlayerEnv(BINS, probe({ files: ['/proc/sys/fs/binfmt_misc/WSLInterop-late'] }));
    expect(d.available).toBe(true);
  });

  it.each([
    ['not_linux', probe({ platform: 'darwin' })],
    ['no_interop', probe({ files: [] })],
    ['no_wslpath', probe({ execs: [VLC, CURL] })],
    ['no_vlc', probe({ execs: ['/usr/bin/wslpath', CURL] })],
    ['no_curl', probe({ execs: ['/usr/bin/wslpath', VLC] })],
  ] as const)('reports %s', async (reason, p) => {
    expect(await detectPlayerEnv(BINS, p)).toEqual({ available: false, reason });
  });

  it('looks a bare binary name up on PATH', async () => {
    const d = await detectPlayerEnv({ bin: 'vlc.exe', curlExe: CURL }, probe({ execs: ['/usr/bin/wslpath', '/usr/bin/vlc.exe', CURL] }));
    expect(d).toMatchObject({ available: true, env: { vlc: '/usr/bin/vlc.exe' } });
  });
});

describe('vlcArgs', () => {
  it('starts a separate instance with loopback HTTP, no resume prompt, the start second and the file last', () => {
    expect(vlcArgs({ winPath: 'C:\\Videos\\A (2015)\\A.mkv', port: 47318, password: 'abc123', startTime: 1200.7 })).toEqual([
      '--no-one-instance',
      '--no-one-instance-when-started-from-file',
      '--qt-continue=0',
      '--no-qt-privacy-ask',
      '--extraintf',
      'http',
      '--http-host',
      '127.0.0.1',
      '--http-port',
      '47318',
      '--http-password',
      'abc123',
      '--start-time=1200',
      'C:\\Videos\\A (2015)\\A.mkv',
    ]);
  });

  it('never passes a negative start', () => {
    expect(vlcArgs({ winPath: 'C:\\a.mkv', port: 1, password: 'p', startTime: -3 })).toContain('--start-time=0');
  });
});

describe('newHttpPassword', () => {
  it('is 32 hex chars and differs per launch', () => {
    const a = newHttpPassword();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newHttpPassword()).not.toBe(a);
  });
});
