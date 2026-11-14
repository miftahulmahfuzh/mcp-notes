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
 * One read of VLC's HTTP interface. `gone`: nothing listens on the port (VLC exited, or not up yet;
 * see interpretCurl). `unauthorized`: something answers, but not with our password. `error`: a
 * listener took the connection and did not answer in time (a hung VLC), or answered junk.
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

/**
 * curl: "Failed to connect to host". MEASURED 2026-11-14 with curl.exe 8.13 on this Windows: a
 * closed loopback port is refused only after 1.9-5.2 s, so within CURL_CONNECT_TIMEOUT_S curl.exe
 * never gets to say 7; it times out (28) with `time_connect` 0. Linux curl answers 7 at once.
 */
export const CURL_EXIT_CONNECT_FAILED = 7;
/** curl: "Operation timed out": the connect limit or the `-m` limit. `time_connect` tells which. */
export const CURL_EXIT_TIMED_OUT = 28;
/** curl's own `-m` limit, seconds. */
export const CURL_MAX_TIME_S = 2;
/**
 * curl's `--connect-timeout`, seconds. A loopback listener takes the connection in about 1 ms
 * (measured, a hung one included), so no connection after this long means nothing listens.
 */
export const CURL_CONNECT_TIMEOUT_S = 1;
/** `-w`: after the body, a newline, the HTTP status and the seconds the connect took (0: never connected). */
export const CURL_WRITE_OUT = '\\n%{http_code} %{time_connect}';
/** Node's limit on the curl process (curl.exe startup through interop included). */
export const CURL_EXEC_TIMEOUT_MS = 5000;

export interface ExecResult {
  /** The process exit code; -1 when it could not run or was killed by the timeout. */
  exitCode: number;
  stdout: string;
}

export type ExecFn = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

/** execFile that never rejects: the exit code is data here (7 and 28 can both mean "VLC gone"). */
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

/** Silent, time-limited, HTTP status and connect time appended after a newline, Basic auth with an empty user. */
export function curlArgs(ep: VlcEndpoint, url: string): string[] {
  return ['-s', '--connect-timeout', String(CURL_CONNECT_TIMEOUT_S), '-m', String(CURL_MAX_TIME_S), '-w', CURL_WRITE_OUT, '-u', `:${ep.password}`, url];
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

/**
 * curl's exit code and `<body>\n<http code> <time_connect>` output -> one VlcReply. Nothing
 * listening is `gone` however curl learned it: refused (7), or a timeout (28) that never connected.
 * A timeout after a connect is a listener that does not answer: `error`, which the hang rule needs.
 */
export function interpretCurl(r: ExecResult): VlcReply {
  if (r.exitCode === CURL_EXIT_CONNECT_FAILED) return { kind: 'gone' };
  const cut = r.stdout.lastIndexOf('\n');
  const [codeText = '', connectText] = r.stdout.slice(cut + 1).trim().split(/\s+/);
  if (r.exitCode === CURL_EXIT_TIMED_OUT && connectText !== undefined && Number(connectText) === 0) return { kind: 'gone' };
  if (r.exitCode !== 0) return { kind: 'error', message: `curl exited ${r.exitCode}` };
  const code = Number(codeText);
  const body = cut < 0 ? '' : r.stdout.slice(0, cut);
  if (code === 401) return { kind: 'unauthorized' };
  if (code !== 200) return { kind: 'error', message: `HTTP ${Number.isFinite(code) ? code : '?'}` };
  const status = parseStatusJson(body);
  return status === null ? { kind: 'error', message: 'unreadable status.json' } : { kind: 'ok', status };
}

/** The real reader: one curl.exe run per call (~70 ms measured on this host; ~1 s when nothing listens). */
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
