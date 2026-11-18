// Cloudflare WARP on the Windows side, for a streaming site this network does not reach (the
// provider blocks it, or the page never loads). WARP switches the whole machine's traffic, so it is
// only ever turned on, by a site that failed without it, and never turned off again from here.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const WARP_CLI = '/mnt/c/Program Files/Cloudflare/Cloudflare WARP/warp-cli.exe';
const CONNECT_WAIT_MS = 20_000;

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

/**
 * Turns WARP on when it is off, and waits until it is connected. True only when this call turned
 * it on: the caller then asks the site once more. False when WARP is not installed, is switched
 * off for the scripts (NOTESD_STREAM_WARP=off), was on already (the site failed for another
 * reason), or did not connect. `deps` are test seams.
 */
export async function turnWarpOn({ cli = warpCli, installed = () => existsSync(WARP_CLI), env = process.env, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  if ((env.NOTESD_STREAM_WARP ?? '').trim().toLowerCase() === 'off' || !installed()) return false;
  if (readStatus(await cli(['status'])) !== 'disconnected') return false;
  await cli(['connect']);
  const deadline = now() + CONNECT_WAIT_MS;
  while (now() < deadline) {
    await sleep(1000);
    if (readStatus(await cli(['status'])) === 'connected') return true;
  }
  return false;
}
