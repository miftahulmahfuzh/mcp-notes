#!/usr/bin/env node
// The direct-streaming resolver: finds a playable stream for a film or an episode by opening
// provider embeds in the streaming Chrome, out of sight and silent, and opens daemon pages there.
// Usage:
//   cli.mjs resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>]
//   cli.mjs providers [--providers <file>] [--health <file>]
//   cli.mjs open <http://localhost:<port>/...> [--fullscreen]
//   cli.mjs templates <site url>   read a site's provider templates (plain requests, no browser)
// Prints one JSON object. Exit 0 when ok, 1 when not, 2 for a usage or input error.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeError, evaluateInChrome, sleep } from '../chrome.mjs';
import { orderProviders } from './order.mjs';
import { resolveTitle } from './resolve.mjs';
import { sniffEmbed } from './sniff.mjs';
import { templatesCommand } from './templates.mjs';

export const SEED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers.seed.json');
export const USAGE =
  'resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--providers <file>] [--health <file>] [--deadline-s <n>] | providers [--providers <file>] [--health <file>] | open <http://localhost:<port>/...> [--fullscreen] | templates <site url>';

/**
 * Evaluated in the player page after `open --fullscreen`: phase 4's page exposes
 * window.notesdStream.start() (unmute and play). cdp.ps1 evaluates with userGesture: true, so
 * Chrome lets the film start with sound. 'waiting' while the page has not exposed it yet.
 */
export const START_EXPRESSION =
  "(async () => { const s = window.notesdStream; if (!s || typeof s.start !== 'function') return 'waiting'; await s.start(); return 'started'; })()";
/** Tries of START_EXPRESSION, START_WAIT_MS apart: 15 s for the page to load and read its session. */
export const START_TRIES = 30;
export const START_WAIT_MS = 500;

/** Bad input, named: usage, bad_providers or bad_health. */
export class InputError extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
}

const VALUE_FLAGS = new Set(['--only', '--providers', '--health', '--deadline-s']);
const SWITCH_FLAGS = new Set(['--fullscreen']);
const WHOLE = /^\d+$/;
const DAEMON_HOSTS = new Set(['localhost', '127.0.0.1']);

function wholeNumber(text, min) {
  if (!WHOLE.test(text ?? '')) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

function parseRef(args) {
  const [kind, id, season, episode, ...extra] = args;
  if (kind !== 'movie' && kind !== 'tv') throw new InputError('usage', 'the kind is movie or tv');
  const tmdbId = wholeNumber(id, 1);
  if (tmdbId === null) throw new InputError('usage', 'the TMDB id is a positive whole number');
  if (extra.length > 0) throw new InputError('usage', 'too many arguments');
  if (kind === 'movie') {
    if (season !== undefined) throw new InputError('usage', 'a film takes no season or episode');
    return { kind, tmdbId, season: null, episode: null };
  }
  const s = wholeNumber(season, 0);
  const e = wholeNumber(episode, 1);
  if (s === null || e === null) throw new InputError('usage', 'an episode needs a season (0 or more) and an episode (1 or more)');
  return { kind, tmdbId, season: s, episode: e };
}

function parseDaemonUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new InputError('usage', `not an address: ${text}`);
  }
  if (url.protocol !== 'http:' || !DAEMON_HOSTS.has(url.hostname)) throw new InputError('usage', 'open takes a daemon page: http://localhost:<port>/...');
  return url.href;
}

/** The command line, validated. Throws InputError('usage'). */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError('usage', `${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i++;
    } else if (SWITCH_FLAGS.has(arg)) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      throw new InputError('usage', `unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  const allow = (names) => {
    for (const name of Object.keys(flags)) {
      if (!names.includes(name)) throw new InputError('usage', `--${name} does not apply to ${command}`);
    }
  };
  switch (command) {
    case 'resolve': {
      allow(['only', 'providers', 'health', 'deadline-s']);
      const deadlineS = flags['deadline-s'] === undefined ? null : wholeNumber(flags['deadline-s'], 1);
      if (flags['deadline-s'] !== undefined && deadlineS === null) throw new InputError('usage', '--deadline-s is a whole number of seconds, 1 or more');
      return { command, ref: parseRef(rest), only: flags.only ?? null, providersFile: flags.providers ?? null, healthFile: flags.health ?? null, deadlineS };
    }
    case 'providers':
      allow(['providers', 'health']);
      if (rest.length > 0) throw new InputError('usage', 'providers takes no arguments');
      return { command, providersFile: flags.providers ?? null, healthFile: flags.health ?? null };
    case 'open':
      allow(['fullscreen']);
      if (rest.length !== 1) throw new InputError('usage', 'open takes one address');
      return { command, url: parseDaemonUrl(rest[0]), fullscreen: flags.fullscreen === true };
    case 'templates':
      allow([]);
      // templatesCommand checks the address itself (usage, bad_url) and answers in its own shape.
      return { command, rest };
    default:
      throw new InputError('usage', command === undefined ? 'no command' : `unknown command "${command}"`);
  }
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InputError(code, `not JSON: ${err.message}`);
  }
}

function isTemplate(value, placeholders) {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return false;
  if (!placeholders.every((p) => value.includes(p))) return false;
  try {
    new URL(value.replace(/\{(id|season|episode)\}/g, '1'));
    return true;
  } catch {
    return false;
  }
}

/** A providers file (the seed, or the registry's rows), validated. Extra fields are dropped. */
export function readProviders(text) {
  const data = parseJson(text, 'bad_providers');
  if (!Array.isArray(data) || data.length === 0) throw new InputError('bad_providers', 'expected a non-empty array of providers');
  const seen = new Set();
  return data.map((entry, index) => {
    const label = entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? ` (${entry.name})` : '';
    const bad = (why) => new InputError('bad_providers', `provider ${index}${label}: ${why}`);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw bad('not an object');
    const { name, id_kind, movie, tv, browser_only, en_subtitle, notes } = entry;
    if (typeof name !== 'string' || name.trim() === '') throw bad('name is empty');
    if (seen.has(name.toLowerCase())) throw bad('name is used twice');
    seen.add(name.toLowerCase());
    if (id_kind !== 'tmdb') throw bad('id_kind must be "tmdb"');
    if (!isTemplate(movie, ['{id}'])) throw bad('movie must be an http(s) address with {id}');
    if (tv !== null && !isTemplate(tv, ['{id}', '{season}', '{episode}'])) throw bad('tv must be null or an http(s) address with {id}, {season} and {episode}');
    if (typeof browser_only !== 'boolean') throw bad('browser_only must be true or false');
    if (en_subtitle !== true && en_subtitle !== false && en_subtitle !== null) throw bad('en_subtitle must be true, false or null');
    if (typeof notes !== 'string') throw bad('notes must be a string');
    return { name, id_kind, movie, tv, browser_only, en_subtitle, notes };
  });
}

/** A health file: provider name -> what this host measured. Missing fields become null / 0. */
export function readHealth(text) {
  const data = parseJson(text, 'bad_health');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new InputError('bad_health', 'expected an object keyed by provider name');
  const health = {};
  for (const [name, h] of Object.entries(data)) {
    const bad = (why) => new InputError('bad_health', `${name}: ${why}`);
    if (h === null || typeof h !== 'object' || Array.isArray(h)) throw bad('not an object');
    const number = (key) => {
      const v = h[key];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(`${key} must be a number`);
      return v;
    };
    const string = (key) => {
      const v = h[key];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') throw bad(`${key} must be a string`);
      return v;
    };
    const en = h.en_subtitle ?? null;
    if (en !== true && en !== false && en !== null) throw bad('en_subtitle must be true, false or null');
    health[name] = {
      en_subtitle: en,
      best_height: number('best_height'),
      median_s: number('median_s'),
      last_success_at: string('last_success_at'),
      last_failure_at: string('last_failure_at'),
      consecutive_failures: Math.floor(number('consecutive_failures') ?? 0),
    };
  }
  return health;
}

/** A full-screen open starts the film with sound, except for a muted check (`?muted=1`, phase 6). */
export function wantsStart(url, fullscreen) {
  return fullscreen === true && new URL(url).searchParams.get('muted') !== '1';
}

/**
 * Opens a daemon page in the streaming Chrome, in front, full screen when asked. Never throws.
 * Other tabs are left alone: a resolve may have one open. With `fullscreen` (and no `muted=1`),
 * it then calls the player's start() as a user gesture so the film plays with sound (D2); a page
 * that never exposes start() leaves `started: false` and the page's own muted start stands.
 * `evaluate` and `wait` are test seams (evaluateInChrome and sleep in use).
 */
export async function openInChrome(url, { fullscreen }, { evaluate = evaluateInChrome, wait = sleep } = {}) {
  const target = new URL(url);
  const where = `${target.pathname}${target.search}${target.hash}`;
  const go = () => evaluate(target.origin, `location.assign(${JSON.stringify(where)}); 'ok'`, { show: true, windowState: fullscreen ? 'fullscreen' : 'normal' });
  try {
    // A Chrome that is just closing still answers its port and then drops the call. Once more
    // starts a fresh one (as claude/streaming/play.mjs does).
    await go().catch(async (err) => {
      if (!(err instanceof ChromeError)) throw err;
      await wait(2500);
      return go();
    });
  } catch (err) {
    return { ok: false, url, error: err instanceof ChromeError ? err.code : 'open_failed', detail: String(err?.message ?? err) };
  }
  let started = null;
  if (wantsStart(url, fullscreen)) {
    started = false;
    for (let i = 0; i < START_TRIES && !started; i++) {
      await wait(START_WAIT_MS);
      try {
        // The tab is the one just navigated (cdp.ps1 picks the loaded tab on the daemon's host).
        started = (await evaluate(target.origin, START_EXPRESSION, {})) === 'started';
      } catch {
        // The page is still loading (no title yet, so cdp.ps1 finds no tab): try again.
      }
    }
  }
  return { ok: true, url, fullscreen, started };
}

const printJson = (value) => console.log(JSON.stringify(value, null, 2));

function readInput(readText, file, code) {
  try {
    return readText(file);
  } catch (err) {
    throw new InputError(code, `cannot read ${file}: ${err?.message ?? err}`);
  }
}

/** Runs one command and prints one JSON object. Returns the exit code. Everything is injectable. */
export async function main(argv, io = {}) {
  const { sniff = sniffEmbed, open = openInChrome, readText = (file) => readFileSync(file, 'utf8'), print = printJson } = io;
  let args;
  let providers = [];
  let health = {};
  try {
    args = parseArgs(argv);
    if (args.command !== 'open' && args.command !== 'templates') {
      providers = readProviders(readInput(readText, args.providersFile ?? SEED_PATH, 'bad_providers'));
      health = args.healthFile === null ? {} : readHealth(readInput(readText, args.healthFile, 'bad_health'));
    }
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    print(err.code === 'usage' ? { ok: false, error: err.code, detail: err.message, usage: USAGE } : { ok: false, error: err.code, detail: err.message });
    return 2;
  }
  if (args.command === 'templates') {
    const { code, answer } = await templatesCommand(args.rest);
    print(answer);
    return code;
  }
  if (args.command === 'providers') {
    print({ ok: true, providers: orderProviders(providers, health).map((p) => ({ ...p, health: Object.hasOwn(health, p.name) ? health[p.name] : null })) });
    return 0;
  }
  if (args.command === 'open') {
    const result = await open(args.url, { fullscreen: args.fullscreen });
    print(result);
    return result.ok ? 0 : 1;
  }
  const result = await resolveTitle(args.ref, { providers, health, sniff, only: args.only, deadlineS: args.deadlineS });
  print(result);
  return result.ok ? 0 : 1;
}

// Reached through a symlink from ~/.claude/skills one day, so compare real paths.
function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
