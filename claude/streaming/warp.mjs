// Cloudflare WARP on the Windows side, for a streaming site this network does not reach. Some
// sites answer only through it (the provider blocks them), and some refuse it (lk21's Cloudflare
// answers "you have been blocked" to WARP's addresses, measured 2026-11-18). So a site that fails
// is asked once more with WARP the other way round, and WARP is put back when that did not help.
// WARP switches the whole machine's traffic: it is only ever touched after a site failed.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const WARP_CLI = '/mnt/c/Program Files/Cloudflare/Cloudflare WARP/warp-cli.exe';
const SWITCH_WAIT_MS = 20_000;

/** `warp-cli <args>` on Windows; its output, or null when it cannot be run. */
async function warpCli(args) {
  try {
    // A Windows program cannot start in a Linux-only folder.
    const { stdout } = await run(WARP_CLI, args, { cwd: '/mnt/c', timeout: 15_000 });
    return stdout;
  } catch (err) {
    return typeof err?.stdout === 'string' && err.stdout !== '' ? err.stdout : null;
  }
}

/** `connected`, `disconnected`, `connecting`, or `unknown`, from `warp-cli status`. */
export function readStatus(output) {
  const m = /Status update:\s*([A-Za-z]+)/.exec(output ?? '');
  const word = m ? m[1].toLowerCase() : '';
  return word === 'connected' || word === 'disconnected' || word === 'connecting' ? word : 'unknown';
}

const defaults = { cli: warpCli, installed: () => existsSync(WARP_CLI), env: process.env, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };

/**
 * Switches WARP to the other state (on when it is off, off when it is on) and waits until it is
 * there. Answers `{ now: 'connected' | 'disconnected', back }`, where `back()` puts it as it was;
 * or null when nothing was changed: WARP is not installed, is left alone by the scripts
 * (NOTESD_STREAM_WARP=off), is in a state that is neither on nor off, or did not switch in time.
 * `deps` are test seams.
 */
export async function flipWarp(deps = {}) {
  const { cli, installed, env, sleep, now } = { ...defaults, ...deps };
  if ((env.NOTESD_STREAM_WARP ?? '').trim().toLowerCase() === 'off' || !installed()) return null;
  const was = readStatus(await cli(['status']));
  if (was !== 'connected' && was !== 'disconnected') return null;
  const reach = async (want) => {
    await cli([want === 'connected' ? 'connect' : 'disconnect']);
    const deadline = now() + SWITCH_WAIT_MS;
    while (now() < deadline) {
      await sleep(1000);
      if (readStatus(await cli(['status'])) === want) return true;
    }
    return false;
  };
  const to = was === 'connected' ? 'disconnected' : 'connected';
  if (!(await reach(to))) {
    // Half way is nowhere: ask for what it was.
    await cli([was === 'connected' ? 'connect' : 'disconnect']);
    return null;
  }
  return { now: to, back: () => reach(was) };
}
