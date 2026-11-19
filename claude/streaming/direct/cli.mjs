#!/usr/bin/env node
// The direct-streaming resolver: finds a playable stream for a film or an episode by opening
// provider embeds in the streaming Chrome, out of sight and silent, and opens daemon pages there.
// Usage:
//   cli.mjs resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--skip <name,name>] [--providers <file>] [--health <file>] [--deadline-s <n>] [--audio-lang <code>]
//   cli.mjs providers [--providers <file>] [--health <file>]
//   cli.mjs open <http://localhost:<port>/...> [--fullscreen]
//   cli.mjs templates <site url> [--watch <film page>] [--episode <episode page>] [--no-chrome] [--from-tab]
//                                  read a site's provider templates: its scripts with plain requests,
//                                  and when they hold none, the frames a watch page loads in the streaming Chrome
//                                  (or, with --from-tab, the frames of a tab the owner already gated)
//   cli.mjs gate <site url> [--deadline-s <n>]
//                                  foreground the site so the owner can solve its Cloudflare challenge by hand;
//                                  the cf_clearance cookie the profile keeps then lets later reads through
// Prints one JSON object. Exit 0 when ok, 1 when not, 2 for a usage or input error.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeError, evaluateInChrome, sleep } from '../chrome.mjs';
import { SITES } from '../sites/index.mjs';
import { isBotCheckPage } from '../torrent/page.mjs';
// Origin-agnostic despite its home: the tab these drive is named by address, never a torrent site.
import { askInTab, BotCheckError, foregroundTab, secondsLeft } from '../torrent/browser.mjs';
import { orderProviders } from './order.mjs';
import { probeAudio } from './audio.mjs';
import { normalizeLang } from './lang.mjs';
import { resolveTitle } from './resolve.mjs';
import { sniffEmbed } from './sniff.mjs';
import { templatesCommand } from './templates.mjs';

/** Both steps of `gate` together, when the caller gives no --deadline-s. */
export const DEFAULT_DEADLINE_S = 40;

export const SEED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'providers.seed.json');
/** The anime embeds (keyed by AniList id), tried for a resolve that carries --anime. The daemon loads both files into its registry. */
export const ANIME_SEED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'anime.seed.json');
export const USAGE =
  'resolve <movie|tv> <tmdbId> [season episode] [--only <name>] [--skip <name,name>] [--first <name>] [--providers <file>] [--health <file>] [--deadline-s <n>] [--audio-lang <code>] [--anime <AniList id>:<episode>] | providers [--providers <file>] [--health <file>] | open <http://localhost:<port>/...> [--fullscreen] | templates <site url> [--watch <film page>] [--episode <episode page>] [--no-chrome] [--from-tab] | gate <site url> [--deadline-s <n>]';

/**
 * Evaluated in the player page after `open --fullscreen`: phase 4's page exposes
 * window.notesdStream.start() (go full screen, unmute and play). cdp.ps1 evaluates with
 * userGesture: true, so Chrome lets the page go full screen and the film start with sound.
 * 'waiting' while the page has not exposed it yet; 'started' when the page is full screen,
 * 'windowed' when it started but Chrome did not give it the screen.
 */
export const START_EXPRESSION =
  "(async () => { const s = window.notesdStream; if (!s || typeof s.start !== 'function') return 'waiting'; await s.start(); return document.fullscreenElement ? 'started' : 'windowed'; })()";
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

const VALUE_FLAGS = new Set(['--only', '--skip', '--first', '--providers', '--health', '--deadline-s', '--audio-lang', '--anime', '--watch', '--episode']);
const SWITCH_FLAGS = new Set(['--fullscreen', '--no-chrome', '--from-tab']);
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
      allow(['only', 'skip', 'first', 'providers', 'health', 'deadline-s', 'audio-lang', 'anime']);
      // An anime's AniList id and the episode as AniList counts it ("21:730"): the anime embeds are keyed by them.
      const animeParts = flags.anime === undefined ? null : /^(\d+):(\d+)$/.exec(flags.anime);
      if (flags.anime !== undefined && (animeParts === null || Number(animeParts[1]) < 1 || Number(animeParts[2]) < 1)) {
        throw new InputError('usage', '--anime is <AniList id>:<episode>, such as 21:730');
      }
      const anime = animeParts === null ? null : { id: Number(animeParts[1]), episode: Number(animeParts[2]) };
      // The title's original language (TMDB's code): a stream that speaks only other languages is skipped as a dub.
      const audioLang = flags['audio-lang'] === undefined ? null : normalizeLang(flags['audio-lang']);
      if (flags['audio-lang'] !== undefined && audioLang === null) throw new InputError('usage', '--audio-lang is a language code such as ko, en or jpn');
      const deadlineS = flags['deadline-s'] === undefined ? null : wholeNumber(flags['deadline-s'], 1);
      if (flags['deadline-s'] !== undefined && deadlineS === null) throw new InputError('usage', '--deadline-s is a whole number of seconds, 1 or more');
      return { command, ref: { ...parseRef(rest), anime }, only: flags.only ?? null, skip: (flags.skip ?? '').split(',').map((name) => name.trim()).filter(Boolean), first: flags.first ?? null, providersFile: flags.providers ?? null, healthFile: flags.health ?? null, deadlineS, audioLang };
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
      allow(['watch', 'episode', 'no-chrome', 'from-tab']);
      // templatesCommand checks the addresses itself (usage, bad_url) and answers in its own shape.
      return {
        command,
        rest: [
          ...rest,
          ...(flags.watch === undefined ? [] : ['--watch', flags.watch]),
          ...(flags.episode === undefined ? [] : ['--episode', flags.episode]),
          ...(flags['no-chrome'] === true ? ['--no-chrome'] : []),
          ...(flags['from-tab'] === true ? ['--from-tab'] : []),
        ],
      };
    case 'gate': {
      allow(['deadline-s']);
      if (rest.length !== 1) throw new InputError('usage', 'gate takes one site address');
      let origin;
      try {
        origin = new URL(rest[0]).origin;
      } catch {
        throw new InputError('usage', 'gate needs an http(s) address');
      }
      const deadlineS = flags['deadline-s'] === undefined ? null : wholeNumber(flags['deadline-s'], 1);
      if (flags['deadline-s'] !== undefined && deadlineS === null) throw new InputError('usage', '--deadline-s is a whole number of seconds, 1 or more');
      return { command, origin, deadlineS };
    }
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
    if (id_kind !== 'tmdb' && id_kind !== 'anilist') throw bad('id_kind must be "tmdb" or "anilist"');
    if (!isTemplate(movie, ['{id}'])) throw bad('movie must be an http(s) address with {id}');
    // An anime embed counts episodes through the whole series: it has no season.
    const episodeParts = id_kind === 'anilist' ? ['{id}', '{episode}'] : ['{id}', '{season}', '{episode}'];
    if (tv !== null && !isTemplate(tv, episodeParts)) throw bad(`tv must be null or an http(s) address with ${episodeParts.join(', ')}`);
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
      // What the last try said (order.mjs restingUntil: a provider that is down or behind a check rests).
      last_outcome: string('last_outcome'),
      last_detail: string('last_detail'),
      // The daemon's verdict on the provider's last play here (order.mjs deliveryRank).
      delivery: h.delivery === 'bad' || h.delivery === 'good' ? h.delivery : null,
    };
  }
  return health;
}

/** The hosts of the streaming sites (sites/*.mjs): where a film may be playing in a tab of its own. */
export const SITE_HOSTS = Object.values(SITES).map((site) => new URL(site.origin).host);

/** A full-screen open starts the film with sound, except for a muted check (`?muted=1`, phase 6). */
export function wantsStart(url, fullscreen) {
  return fullscreen === true && new URL(url).searchParams.get('muted') !== '1';
}

/**
 * Opens a daemon page in the streaming Chrome, in front, full screen when asked. Never throws.
 * Other tabs are left alone: a resolve may have one open. Only a streaming site's tab is closed,
 * and only for a play that starts with sound: its film would go on playing behind this one. With `fullscreen` (and no `muted=1`),
 * it then calls the player's start() as a user gesture so the film plays with sound (D2); a page
 * that never exposes start() leaves `started: false` and the page's own muted start stands.
 *
 * Full screen is the page's own (start() asks for it), not the window's: the page can leave its
 * own full screen, so a double click, F or Esc works from the first play, while a window made
 * full screen as F11 does can only be left with F11. The window is made full screen only when the
 * page will not start (`muted=1`) or did not get the screen.
 * `evaluate` and `wait` are test seams (evaluateInChrome and sleep in use).
 */
export async function openInChrome(url, { fullscreen }, { evaluate = evaluateInChrome, wait = sleep } = {}) {
  const target = new URL(url);
  const where = `${target.pathname}${target.search}${target.hash}`;
  const starts = wantsStart(url, fullscreen);
  const go = () => evaluate(target.origin, `location.assign(${JSON.stringify(where)}); 'ok'`, { show: true, windowState: fullscreen && !starts ? 'fullscreen' : 'normal', ...(starts ? { closeHosts: SITE_HOSTS } : {}) });
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
  if (starts) {
    started = false;
    let ownFullscreen = false;
    for (let i = 0; i < START_TRIES && !started; i++) {
      await wait(START_WAIT_MS);
      try {
        // The tab is the one just navigated (cdp.ps1 picks the loaded tab on the daemon's host).
        const answer = await evaluate(target.origin, START_EXPRESSION, {});
        started = answer === 'started' || answer === 'windowed';
        ownFullscreen = answer === 'started';
      } catch {
        // The page is still loading (no title yet, so cdp.ps1 finds no tab): try again.
      }
    }
    if (!ownFullscreen) {
      // The page did not take the screen itself: the window does, as before.
      await evaluate(target.origin, "'ok'", { show: true, windowState: 'fullscreen' }).catch(() => {});
    }
  }
  return { ok: true, url, fullscreen, started };
}

/** Evaluated in the gated tab: whether the challenge is gone, read the same way torrent/cli.mjs's gate does. */
export function gateExpression() {
  return `(() => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  return { bot_check: isBotCheckPage(document), title: document.title, url: location.href };
})()`;
}

/**
 * The `gate` command: brings the site's tab to the front of the streaming Chrome so the owner can
 * solve a Cloudflare challenge by hand, then watches the tab until it is no longer a bot-check
 * page or the deadline passes. The cf_clearance cookie the profile keeps then lets later reads
 * (`templates --from-tab`) through. Returns { cleared, title }. Throws ChromeError.
 */
export async function clearGate(origin, deadline, { foreground = foregroundTab, ask = askInTab, sleep: wait = sleep } = {}) {
  await foreground(origin, { timeoutS: secondsLeft(deadline) });
  let last = { bot_check: true, title: '' };
  while (Date.now() < deadline) {
    try {
      last = await ask(origin, gateExpression(), { timeoutS: secondsLeft(deadline) });
    } catch (err) {
      // While a challenge holds the only tab, cdp.ps1 answers no_tab (a BotCheckError here): keep waiting.
      if (!(err instanceof BotCheckError)) throw err;
      last = { bot_check: true, title: last.title };
    }
    if (last && last.bot_check === false) return { cleared: true, title: last.title ?? '' };
    await wait(2000);
  }
  return { cleared: false, title: last?.title ?? '' };
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
  const { sniff = sniffEmbed, ask = askInTab, gate = clearGate, open = openInChrome, readText = (file) => readFileSync(file, 'utf8'), print = printJson } = io;
  let args;
  let providers = [];
  let health = {};
  try {
    args = parseArgs(argv);
    if (args.command !== 'open' && args.command !== 'templates' && args.command !== 'gate') {
      providers = readProviders(readInput(readText, args.providersFile ?? SEED_PATH, 'bad_providers'));
      // Run by hand without --providers: the anime embeds come from their own seed.
      if (args.providersFile === null && args.command === 'resolve' && args.ref.anime !== null) {
        providers = [...providers, ...readProviders(readInput(readText, ANIME_SEED_PATH, 'bad_providers'))];
      }
      health = args.healthFile === null ? {} : readHealth(readInput(readText, args.healthFile, 'bad_health'));
    }
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    print(err.code === 'usage' ? { ok: false, error: err.code, detail: err.message, usage: USAGE } : { ok: false, error: err.code, detail: err.message });
    return 2;
  }
  if (args.command === 'templates') {
    const { code, answer } = await templatesCommand(args.rest, { sniff, ask });
    print(answer);
    return code;
  }
  if (args.command === 'gate') {
    const deadline = Date.now() + (args.deadlineS ?? DEFAULT_DEADLINE_S) * 1000;
    try {
      const { cleared, title } = await gate(args.origin, deadline);
      print({ ok: true, origin: args.origin, cleared, title });
      return 0;
    } catch (err) {
      print({ ok: false, origin: args.origin, error: err instanceof ChromeError ? err.code : 'gate_failed', detail: String(err?.message ?? err) });
      return 1;
    }
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
  const result = await resolveTitle(args.ref, { providers, health, sniff, only: args.only, skip: args.skip, first: args.first, deadlineS: args.deadlineS, audioLang: args.audioLang, probeAudio });
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
