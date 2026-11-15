#!/usr/bin/env node
// The WSL half of the direct-streaming sniffer: runs sniff.ps1 through powershell.exe for one
// embed address and returns what it captured. The tab is opened out of sight and kept silent.
// Usage (diagnosis): sniff.mjs <embed url> [--seconds n]   prints one JSON object.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ChromeError } from '../chrome.mjs';

const run = promisify(execFile);
// The daemon runs under systemd without the Windows folders on its PATH, so name the usual place.
const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const POWERSHELL = existsSync(POWERSHELL_PATH) ? POWERSHELL_PATH : 'powershell.exe';
const SNIFF_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sniff.ps1');

export const SNIFF_DEFAULTS = Object.freeze({ seconds: 35, linger: 4, botGraceS: 5, port: 9333 });

/**
 * Installed in the tab and in every frame before any page script runs. Media elements cannot be
 * unmuted and Web Audio stays suspended, so a page that starts a film or an advert on the
 * sniffer's click is never heard. This is the page's own mute button, not a disguise: nothing
 * about the client changes.
 */
export const MUTE_SCRIPT = `(() => {
  if (window.__notesdSilent) return;
  window.__notesdSilent = true;
  const proto = HTMLMediaElement.prototype;
  const muted = Object.getOwnPropertyDescriptor(proto, 'muted');
  if (!muted || !muted.get || !muted.set) return;
  const silence = (el) => { try { muted.set.call(el, true); } catch {} };
  Object.defineProperty(proto, 'muted', {
    configurable: true,
    enumerable: muted.enumerable,
    get() { return muted.get.call(this); },
    set() { silence(this); },
  });
  const play = proto.play;
  proto.play = function () { silence(this); return play.apply(this, arguments); };
  for (const type of ['loadstart', 'play', 'playing', 'volumechange']) {
    addEventListener(type, (event) => {
      const el = event.target;
      if (el instanceof HTMLMediaElement && !muted.get.call(el)) silence(el);
    }, true);
  }
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Base = window[name];
    if (typeof Base !== 'function') continue;
    window[name] = class extends Base {
      constructor(...args) { super(...args); Base.prototype.suspend.call(this).catch(() => {}); }
      resume() { return Promise.resolve(); }
    };
  }
})();`;

/** Evaluated in the tab and its frames at the end: what could have been heard. */
export const MEDIA_EXPRESSION = `(() => { const media = [...document.querySelectorAll('video, audio')]; return { elements: media.length, audible: media.filter((m) => !m.muted && !m.paused && m.volume > 0).length }; })()`;

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const list = (value) => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]);

/** The capture from sniff.ps1's last line of output; a named failure throws ChromeError. */
export function parseSniffReply(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
  let reply;
  try {
    reply = JSON.parse(line);
  } catch {
    throw new Error(`unreadable reply from the sniffer: ${line.slice(0, 200)}`);
  }
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new Error(`unreadable reply from the sniffer: ${line.slice(0, 200)}`);
  if (typeof reply.error === 'string') throw new ChromeError(reply.error, reply.detail ?? '');
  return {
    url: reply.url ?? null,
    took_s: num(reply.took_s),
    user_agent: typeof reply.user_agent === 'string' ? reply.user_agent : null,
    bot_check: reply.bot_check === true,
    bot_check_reason: typeof reply.bot_check_reason === 'string' ? reply.bot_check_reason : null,
    requests: num(reply.requests),
    clicks: num(reply.clicks),
    popups_closed: num(reply.popups_closed),
    tabs_left_open: num(reply.tabs_left_open),
    frames: list(reply.frames),
    hosts: list(reply.hosts),
    media: { elements: num(reply.media?.elements), audible: num(reply.media?.audible) },
    hits: list(reply.hits),
    inspect: reply.inspect === null || reply.inspect === undefined ? null : list(reply.inspect),
  };
}

/**
 * Opens one embed address in a background tab of the streaming Chrome and returns what it
 * loaded. Throws ChromeError (no_chrome, chrome_not_reachable, cdp_failed) or Error.
 */
export async function sniffEmbed(url, options = {}) {
  const { seconds, linger, botGraceS, port } = { ...SNIFF_DEFAULTS, ...options };
  const { stdout: winScript } = await run('wslpath', ['-w', SNIFF_SCRIPT]);
  const args = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(),
    '-UrlB64', b64(url), '-MuteJsB64', b64(MUTE_SCRIPT), '-MediaJsB64', b64(MEDIA_EXPRESSION),
    '-Port', String(port), '-Seconds', String(seconds), '-Linger', String(linger), '-BotGrace', String(botGraceS),
  ];
  if (options.inspect === true) args.push('-Inspect');
  let stdout;
  try {
    // powershell.exe cannot start in a Linux-only folder.
    ({ stdout } = await run(POWERSHELL, args, { cwd: '/mnt/c', timeout: (seconds + 90) * 1000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (err) {
    // sniff.ps1 exits 3 with its reason on stdout.
    stdout = err?.stdout;
    if (!stdout) throw new Error(`powershell: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  return parseSniffReply(stdout);
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const [url, flag, value] = process.argv.slice(2);
  if (!url || (flag !== undefined && (flag !== '--seconds' || !/^\d+$/.test(value ?? '')))) {
    console.log(JSON.stringify({ error: 'usage', detail: 'sniff.mjs <embed url> [--seconds n]' }));
    process.exitCode = 2;
  } else {
    try {
      const options = flag === '--seconds' ? { seconds: Number(value) } : {};
      console.log(JSON.stringify(await sniffEmbed(url, options), null, 2));
    } catch (err) {
      console.log(JSON.stringify({ error: err instanceof ChromeError ? err.code : 'sniff_failed', detail: String(err?.message ?? err) }));
      process.exitCode = 1;
    }
  }
}
