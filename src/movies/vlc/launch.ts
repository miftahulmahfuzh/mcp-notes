import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { findOnPath, nodeProbe, spawnDetached, WSL_INTEROP_FILES, type DetectProbe } from '../../http/reveal.js';

/** What a working playback needs: three binaries, resolved to runnable Linux paths. */
export interface PlayerEnv {
  /** vlc.exe (NOTESD_VLC_BIN). */
  vlc: string;
  /** The Windows curl.exe (NOTESD_CURL_EXE): VLC binds Windows loopback, which WSL NAT cannot reach. */
  curl: string;
  /** wslpath, for the Windows path of the file. */
  wslpath: string;
}

/** Why playback is off on this host. `no_free_port` and `launch_failed` come from a play attempt. */
export type PlayerUnavailableReason =
  | 'not_linux'
  | 'no_interop'
  | 'no_wslpath'
  | 'no_vlc'
  | 'no_curl'
  | 'no_free_port'
  | 'launch_failed';

/** Either a usable env or the reason there is none; never both. */
export type PlayerDetection =
  | { available: true; env: PlayerEnv }
  | { available: false; reason: PlayerUnavailableReason };

/** The two configured Windows binaries (`config.movies.vlc.bin` / `.curlExe`). */
export interface PlayerBinaries {
  bin: string;
  curlExe: string;
}

/** A path is taken as is (must be executable); a bare name is looked up on PATH. */
async function resolveBinary(value: string, probe: DetectProbe): Promise<string | null> {
  const v = value.trim();
  if (v === '') return null;
  if (v.includes('/')) return (await probe.executable(v)) ? v : null;
  return findOnPath(v, probe.env, probe.executable);
}

/** Linux + WSL interop + wslpath on PATH + vlc.exe + curl.exe, checked in that order. */
export async function detectPlayerEnv(bins: PlayerBinaries, probe: DetectProbe): Promise<PlayerDetection> {
  if (probe.platform !== 'linux') return { available: false, reason: 'not_linux' };
  let interop = false;
  for (const file of WSL_INTEROP_FILES) {
    if (await probe.exists(file)) {
      interop = true;
      break;
    }
  }
  if (!interop) return { available: false, reason: 'no_interop' };
  const wslpath = await findOnPath('wslpath', probe.env, probe.executable);
  if (wslpath === null) return { available: false, reason: 'no_wslpath' };
  const vlc = await resolveBinary(bins.bin, probe);
  if (vlc === null) return { available: false, reason: 'no_vlc' };
  const curl = await resolveBinary(bins.curlExe, probe);
  if (curl === null) return { available: false, reason: 'no_curl' };
  return { available: true, env: { vlc, curl, wslpath } };
}

/** VLC's HTTP interface listens on Windows loopback only; never on the LAN. */
export const VLC_HTTP_HOST = '127.0.0.1';

export interface VlcLaunch {
  /** The file as Windows sees it (`wslpath -w`). */
  winPath: string;
  port: number;
  password: string;
  /** Seconds; floored, never negative. */
  startTime: number;
}

/**
 * vlc.exe's argv. A separate instance (never the owner's running VLC), no "Continue playback?"
 * question (`qt-continue` is 0 never / 1 ask / 2 always), no first-run privacy dialog, full screen
 * from the first frame (the owner clicks Play and watches; `vlc/foreground.ts` puts the window in
 * front), the HTTP interface beside the normal Qt window, and the resume second. Then NOTESD_VLC_EXTRA_ARGS
 * (movies phase 9; config.ts rejects any that would set the HTTP interface), and the file last.
 */
export function vlcArgs(l: VlcLaunch, extraArgs: readonly string[] = []): string[] {
  return [
    '--no-one-instance',
    '--no-one-instance-when-started-from-file',
    '--qt-continue=0',
    '--no-qt-privacy-ask',
    '--fullscreen',
    '--extraintf',
    'http',
    '--http-host',
    VLC_HTTP_HOST,
    '--http-port',
    String(l.port),
    '--http-password',
    l.password,
    `--start-time=${Math.max(0, Math.floor(l.startTime))}`,
    ...extraArgs,
    l.winPath,
  ];
}

/** Starts VLC and returns once it has spawned. There is deliberately no stop: notesd never kills a VLC. */
export interface VlcLauncher {
  launch(env: PlayerEnv, l: VlcLaunch): Promise<void>;
}

/**
 * True when /proc/self/cgroup says this process is a systemd service (the last cgroup segment is a
 * `*.service` other than the user manager's `user@<uid>.service`), e.g. `.../app.slice/notesd.service`.
 * A shell in tmux (`...tmux-spawn-<id>.scope`) or a test runner is not.
 */
export function runningAsSystemdService(cgroupText: string): boolean {
  for (const line of cgroupText.split('\n')) {
    const path = line.split(':').slice(2).join(':').trim();
    if (path === '') continue;
    const last = path.split('/').pop() ?? '';
    if (last.endsWith('.service') && !/^user@\d+\.service$/.test(last)) return true;
  }
  return false;
}

/** `systemd-run` argv that starts VLC in its own transient user scope, outside the daemon's cgroup. */
export function scopeArgs(vlc: string, args: string[]): string[] {
  return ['--user', '--scope', '--quiet', '--collect', '--', vlc, ...args];
}

/**
 * The real launcher: detached, stdio ignored, unref'd. Under systemd (`scope` true; default: detected
 * from /proc/self/cgroup) VLC goes through `systemd-run --user --scope` so `systemctl --user restart
 * notesd` (KillMode=control-group) cannot kill it; without systemd-run it falls back to a plain
 * detached spawn. `extraArgs` (config.movies.vlc.extraArgs) go on every launch.
 */
export function spawnVlcLauncher(opts: { scope?: boolean; extraArgs?: readonly string[] } = {}): VlcLauncher {
  let scoped: Promise<string | null> | null = null;
  const systemdRun = (): Promise<string | null> => {
    scoped ??= (async () => {
      const scope = opts.scope ?? runningAsSystemdService(await readFile('/proc/self/cgroup', 'utf8').catch(() => ''));
      if (!scope) return null;
      const probe = nodeProbe();
      return findOnPath('systemd-run', probe.env, (p) => probe.executable(p));
    })();
    return scoped;
  };
  const extra = opts.extraArgs ?? [];
  return {
    async launch(env, l) {
      const run = await systemdRun();
      if (run !== null) return spawnDetached(run, scopeArgs(env.vlc, vlcArgs(l, extra)));
      return spawnDetached(env.vlc, vlcArgs(l, extra));
    },
  };
}

/** A fresh HTTP password per launch: 32 hex chars (no leading '-', no shell or URL quoting needed). */
export function newHttpPassword(): string {
  return randomBytes(16).toString('hex');
}
