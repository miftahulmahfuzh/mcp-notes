// The tab a torrent site is asked in: a background tab of the streaming Chrome, made out of sight by
// tab.ps1 (cdp.ps1 opens a missing tab in front), then driven through chrome.mjs. Never the owner's
// everyday Chrome, never a Chrome notesd did not start, never a disguised client.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ChromeError, evaluateInChrome, sleep } from '../chrome.mjs';

const run = promisify(execFile);
// The daemon runs under systemd without the Windows folders on its PATH, so name the usual place.
const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const POWERSHELL = existsSync(POWERSHELL_PATH) ? POWERSHELL_PATH : 'powershell.exe';
const TAB_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tab.ps1');

/** The site answered a bot check (or only a "Just a moment" page): reported, never clicked through. */
export class BotCheckError extends Error {
  constructor(detail) {
    super(`bot_check: ${detail}`);
    this.code = 'bot_check';
    this.detail = detail;
  }
}

/** Seconds left before `deadline` (ms since the epoch): at least 5, at most `cap`. */
export function secondsLeft(deadline, cap = 20) {
  return Math.max(5, Math.min(cap, Math.floor((deadline - Date.now()) / 1000)));
}

/**
 * Makes sure the streaming Chrome has a tab on `origin`, created in the background, or starts that
 * Chrome minimized on it. Throws ChromeError: no_chrome (no Windows PowerShell or no chrome.exe on
 * this machine), chrome_not_reachable, cdp_failed.
 */
export async function ensureBackgroundTab(origin, { timeoutS = 20 } = {}) {
  let stdout;
  try {
    const { stdout: winScript } = await run('wslpath', ['-w', TAB_SCRIPT]);
    ({ stdout } = await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(), '-Origin', origin, '-TimeoutS', String(timeoutS)], {
      // powershell.exe cannot start in a Linux-only folder.
      cwd: existsSync('/mnt/c') ? '/mnt/c' : undefined,
      timeout: (timeoutS + 15) * 1000,
    }));
  } catch (err) {
    // tab.ps1 exits 3 with its reason on stdout; anything else means no Windows Chrome to drive.
    stdout = err?.stdout;
    if (!stdout) throw new ChromeError('no_chrome', `cannot run PowerShell: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  const line = String(stdout).trim().split(/\r?\n/).pop() ?? '';
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error(`unreadable reply from tab.ps1: ${line.slice(0, 200)}`);
  }
  if (reply.cdp_error) throw new ChromeError(reply.cdp_error, reply.detail ?? '');
  return { created: reply.created === true };
}

/**
 * Brings the site's tab to the front of the streaming Chrome and restores its window, so the owner
 * can solve a Cloudflare challenge by hand (tab.ps1 -Activate). Starts that Chrome on the site when
 * it is not running. Throws ChromeError like ensureBackgroundTab. { created, activated }.
 */
export async function foregroundTab(origin, { timeoutS = 20 } = {}) {
  let stdout;
  try {
    const { stdout: winScript } = await run('wslpath', ['-w', TAB_SCRIPT]);
    ({ stdout } = await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(), '-Origin', origin, '-TimeoutS', String(timeoutS), '-Activate'], {
      cwd: existsSync('/mnt/c') ? '/mnt/c' : undefined,
      timeout: (timeoutS + 15) * 1000,
    }));
  } catch (err) {
    stdout = err?.stdout;
    if (!stdout) throw new ChromeError('no_chrome', `cannot run PowerShell: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  const line = String(stdout).trim().split(/\r?\n/).pop() ?? '';
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error(`unreadable reply from tab.ps1: ${line.slice(0, 200)}`);
  }
  if (reply.cdp_error) throw new ChromeError(reply.cdp_error, reply.detail ?? '');
  return { created: reply.created === true, activated: reply.activated === true };
}

/**
 * Evaluates one expression in the site's tab. cdp.ps1 answers no_tab when the only page on the site
 * is still "Just a moment...", which is a bot check.
 */
export async function askInTab(origin, expression, { timeoutS = 20 } = {}) {
  try {
    return await evaluateInChrome(origin, expression, { timeoutS });
  } catch (err) {
    if (err instanceof ChromeError && err.code === 'no_tab') {
      throw new BotCheckError(`no page on ${new URL(origin).host} got past its check within ${timeoutS} s`);
    }
    throw err;
  }
}

/**
 * askInTab, tried again (up to `tries` times) when the page was replaced under the expression by a
 * navigation the previous expression started. A named Chrome failure or a bot check is final.
 */
export async function askAfterNavigation(origin, expression, { timeoutS = 20, tries = 3, pauseMs = 1500 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await askInTab(origin, expression, { timeoutS });
    } catch (err) {
      if (err instanceof ChromeError || err instanceof BotCheckError) throw err;
      last = err;
      await sleep(pauseMs);
    }
  }
  throw last;
}
