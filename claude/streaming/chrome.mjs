// The WSL half of driving the streaming Chrome: starts cdp.ps1 through powershell.exe and reads
// its one line of JSON.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const POWERSHELL = 'powershell.exe';
const CDP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp.ps1');

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error cdp.ps1 named, such as no_chrome or no_frame; `code` holds the name. */
export class ChromeError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/**
 * Runs one expression in the site's tab of the streaming Chrome and returns its value, or throws
 * with a short reason.
 * - frameMatch: evaluate inside the embedded frame whose address matches (a player on another host).
 * - show: put the window in front first; windowState 'fullscreen' makes it fill the screen.
 * - closeOtherTabs: close the advertising tabs a player's clicks open.
 */
export async function evaluateInChrome(origin, expression, { frameMatch = '', show = false, windowState = 'normal', closeOtherTabs = false, timeoutS = 45 } = {}) {
  const { stdout: winScript } = await run('wslpath', ['-w', CDP_SCRIPT]);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(), '-Origin', origin];
  args.push('-JsB64', Buffer.from(expression, 'utf8').toString('base64'), '-TimeoutS', String(timeoutS));
  if (frameMatch) args.push('-FrameMatch', frameMatch);
  if (show) args.push('-Show', '-WindowState', windowState);
  if (closeOtherTabs) args.push('-CloseOtherTabs');
  let stdout;
  try {
    // powershell.exe cannot start in a Linux-only folder.
    ({ stdout } = await run(POWERSHELL, args, { cwd: '/mnt/c', timeout: (timeoutS + 15) * 1000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    // cdp.ps1 exits 3 with its reason on stdout.
    stdout = err?.stdout;
    if (!stdout) throw new Error(`powershell: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  const line = stdout.trim().split(/\r?\n/).pop() ?? '';
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error(`unreadable reply from Chrome: ${line.slice(0, 200)}`);
  }
  if (reply.cdp_error) throw new ChromeError(reply.cdp_error, reply.detail);
  const outer = reply.result ?? {};
  if (outer.exceptionDetails) throw new Error(`page error: ${outer.exceptionDetails.exception?.description ?? outer.exceptionDetails.text}`);
  return outer.result?.value;
}
