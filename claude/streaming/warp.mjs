// Cloudflare WARP on the Windows side. Three users:
// - a streaming site this network does not reach: some sites answer only through WARP (the provider
//   blocks them), and some refuse it (lk21's Cloudflare answers "you have been blocked" to WARP's
//   addresses, measured 2026-11-18). A site that fails is asked once more with WARP the other way
//   round, and WARP is put back when that did not help (flipWarp).
// - the owner's own switch: `node warp.mjs status|on|off` (the /warp skill, the daemon's `warp` tool)
//   prints one JSON answer with WARP's state and the Wi-Fi network's name (SSID).
// - the daemon's torrent play on the office network (src/directStream/torrentWarp.ts), through that switch.
// WARP switches the whole machine's traffic.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const WARP_CLI = '/mnt/c/Program Files/Cloudflare/Cloudflare WARP/warp-cli.exe';
export const NETSH = '/mnt/c/Windows/System32/netsh.exe';
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

/** `netsh wlan show interfaces` on Windows; its output, or null when it cannot be run. */
async function netshInterfaces() {
  try {
    const { stdout } = await run(NETSH, ['wlan', 'show', 'interfaces'], { cwd: '/mnt/c', timeout: 10_000 });
    return stdout;
  } catch {
    return null;
  }
}

/** The SSID of the first connected Wi-Fi interface in `netsh wlan show interfaces`, or null (no Wi-Fi, wired, not connected). */
export function readSsid(output) {
  for (const block of (output ?? '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const state = /^\s*State\s*:\s*(.+)$/m.exec(block)?.[1]?.trim().toLowerCase();
    const ssid = /^\s*SSID\s*:\s*(.*)$/m.exec(block)?.[1]?.trim();
    if (state === 'connected' && ssid) return ssid;
  }
  return null;
}

const defaults = { cli: warpCli, netsh: netshInterfaces, installed: () => existsSync(WARP_CLI), env: process.env, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };

/**
 * Switches WARP to the other state (on when it is off, off when it is on) and waits until it is
 * there. Answers `{ now: 'connected' | 'disconnected', back }`, where `back()` puts it as it was;
 * or null when nothing was changed: WARP is not installed, is left alone by the scripts
 * (NOTESD_STREAM_WARP=off), is in a state that is neither on nor off, or did not switch in time.
 * `deps` are test seams.
 */
/** Asks WARP for `want` and waits up to SWITCH_WAIT_MS until it is there; true when it is. */
async function reachState(want, { cli, sleep, now }) {
  await cli([want === 'connected' ? 'connect' : 'disconnect']);
  const deadline = now() + SWITCH_WAIT_MS;
  while (now() < deadline) {
    await sleep(1000);
    if (readStatus(await cli(['status'])) === want) return true;
  }
  return false;
}

/** Whether the scripts and the daemon may switch WARP by themselves (NOTESD_STREAM_WARP is not `off`). */
export function warpAllowed(env = process.env) {
  return (env.NOTESD_STREAM_WARP ?? '').trim().toLowerCase() !== 'off';
}

/**
 * WARP's state and the Wi-Fi network's name: `{ ok: true, warp, ssid }`, where warp is `connected`,
 * `disconnected`, `connecting`, `unknown` or `not_installed`, and ssid null when no Wi-Fi is connected.
 */
export async function warpState(deps = {}) {
  const { cli, netsh, installed } = { ...defaults, ...deps };
  const ssid = readSsid(await netsh());
  if (!installed()) return { ok: true, warp: 'not_installed', ssid };
  return { ok: true, warp: readStatus(await cli(['status'])), ssid };
}

/**
 * The owner's switch: WARP on (`connected`) or off (`disconnected`), waiting until it is there.
 * Answers the state after, with `changed` (false when it already was), or ok false with `error`:
 * `not_installed`, or `did_not_switch` (it was asked for the other state again).
 * NOTESD_STREAM_WARP=off does not stop it: that switch is for what the scripts do by themselves.
 */
export async function setWarp(on, deps = {}) {
  const d = { ...defaults, ...deps };
  const want = on ? 'connected' : 'disconnected';
  const before = await warpState(d);
  if (before.warp === 'not_installed') return { ...before, ok: false, error: 'not_installed' };
  if (before.warp === want) return { ...before, changed: false };
  if (await reachState(want, d)) return { ok: true, warp: want, ssid: readSsid(await d.netsh()), changed: true };
  if (before.warp === 'connected' || before.warp === 'disconnected') await d.cli([before.warp === 'connected' ? 'connect' : 'disconnect']);
  return { ...(await warpState(d)), ok: false, error: 'did_not_switch', changed: false };
}

export async function flipWarp(deps = {}) {
  const d = { ...defaults, ...deps };
  const { cli, installed, env } = d;
  if (!warpAllowed(env) || !installed()) return null;
  const was = readStatus(await cli(['status']));
  if (was !== 'connected' && was !== 'disconnected') return null;
  const reach = (want) => reachState(want, d);
  const to = was === 'connected' ? 'disconnected' : 'connected';
  if (!(await reach(to))) {
    // Half way is nowhere: ask for what it was.
    await cli([was === 'connected' ? 'connect' : 'disconnect']);
    return null;
  }
  return { now: to, back: () => reach(was) };
}

const USAGE = 'usage: node warp.mjs status | on | off';

/** `node warp.mjs status|on|off`: one JSON answer on stdout. */
export async function main(argv, deps = {}) {
  const action = argv[0];
  if (action === 'status') return warpState(deps);
  if (action === 'on' || action === 'off') return setWarp(action === 'on', deps);
  return { ok: false, error: 'usage', detail: USAGE };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await main(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = out.ok ? 0 : 1;
}
