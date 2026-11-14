import { execFile } from 'node:child_process';
import { VLC_HTTP_HOST } from './launch.js';

export type VlcState = 'playing' | 'paused' | 'stopped';

/** The three fields of `/requests/status.json` notesd uses. `time`/`length` are seconds. */
export interface VlcStatus {
  state: VlcState;
  time: number;
  length: number;
}

export interface VlcEndpoint {
  port: number;
  password: string;
}

/**
 * One read of VLC's HTTP interface. `gone`: nothing listens on the port (curl exit 7: VLC exited,
 * or not up yet). `unauthorized`: something answers, but not with our password.
 */
export type VlcReply =
  | { kind: 'ok'; status: VlcStatus }
  | { kind: 'gone' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string };

export type VlcCommand = { command: 'pl_play' } | { command: 'seek'; val: number };

export interface VlcStatusReader {
  status(curl: string, ep: VlcEndpoint): Promise<VlcReply>;
  command(curl: string, ep: VlcEndpoint, cmd: VlcCommand): Promise<VlcReply>;
}

/** curl: "Failed to connect to host" (MEASURED 2026-11-14: what curl.exe returns once VLC exits). */
export const CURL_EXIT_CONNECT_FAILED = 7;
/** curl's own `-m` limit, seconds. */
export const CURL_MAX_TIME_S = 2;
/** Node's limit on the curl process (curl.exe startup through interop included). */
export const CURL_EXEC_TIMEOUT_MS = 5000;

export interface ExecResult {
  /** The process exit code; -1 when it could not run or was killed by the timeout. */
  exitCode: number;
  stdout: string;
}

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/** execFile that never rejects: the exit code is data here (7 means "VLC gone"). */
export const execCapture: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err === null) {
        resolve({ exitCode: 0, stdout });
        return;
      }
      const code = (err as { code?: unknown }).code;
      resolve({ exitCode: typeof code === 'number' ? code : -1, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });

export function statusUrl(ep: VlcEndpoint, cmd?: VlcCommand): string {
  const base = `http://${VLC_HTTP_HOST}:${ep.port}/requests/status.json`;
  if (cmd === undefined) return base;
  if (cmd.command === 'pl_play') return `${base}?command=pl_play`;
  return `${base}?command=seek&val=${Math.max(0, Math.floor(cmd.val))}`;
}

/** Silent, time-limited, HTTP status appended after a newline, Basic auth with an empty user. */
export function curlArgs(ep: VlcEndpoint, url: string): string[] {
  return ['-s', '-m', String(CURL_MAX_TIME_S), '-w', '\\n%{http_code}', '-u', `:${ep.password}`, url];
}

/** status.json -> VlcStatus; null when it is not VLC's shape. */
export function parseStatusJson(text: string): VlcStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const state = o.state;
  if (state !== 'playing' && state !== 'paused' && state !== 'stopped') return null;
  const seconds = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return { state, time: seconds(o.time), length: seconds(o.length) };
}

/** curl's exit code and `<body>\n<http code>` output -> one VlcReply. */
export function interpretCurl(r: ExecResult): VlcReply {
  if (r.exitCode === CURL_EXIT_CONNECT_FAILED) return { kind: 'gone' };
  if (r.exitCode !== 0) return { kind: 'error', message: `curl exited ${r.exitCode}` };
  const cut = r.stdout.lastIndexOf('\n');
  const code = Number(r.stdout.slice(cut + 1).trim());
  const body = cut < 0 ? '' : r.stdout.slice(0, cut);
  if (code === 401) return { kind: 'unauthorized' };
  if (code !== 200) return { kind: 'error', message: `HTTP ${Number.isFinite(code) ? code : '?'}` };
  const status = parseStatusJson(body);
  return status === null ? { kind: 'error', message: 'unreadable status.json' } : { kind: 'ok', status };
}

/** The real reader: one curl.exe run per call (~70 ms measured on this host). */
export function curlStatusReader(exec: ExecFn = execCapture): VlcStatusReader {
  return {
    async status(curl, ep) {
      return interpretCurl(await exec(curl, curlArgs(ep, statusUrl(ep)), CURL_EXEC_TIMEOUT_MS));
    },
    async command(curl, ep, cmd) {
      return interpretCurl(await exec(curl, curlArgs(ep, statusUrl(ep, cmd)), CURL_EXEC_TIMEOUT_MS));
    },
  };
}
