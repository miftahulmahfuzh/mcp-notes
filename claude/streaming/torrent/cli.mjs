#!/usr/bin/env node
// One command for the torrent sites (1337x, ext.to, RuTracker), asked inside the streaming Chrome in a background
// tab. Prints one JSON object. The daemon's torrent finder (src/directStream/torrent/find-sites.ts)
// runs `search`, then `magnets` for the few rows it keeps; by hand, `cli.mjs <site> <title> [year]`
// does both for the five best-seeded matches.
// Usage: cli.mjs --sites
//        cli.mjs <site> search --title <words> [--year <n>] [--season <n> --episode <n>] [--imdb <tt...>] [--origin <url>] [--deadline-s <n>]
//        cli.mjs <site> magnets [--origin <url>] [--deadline-s <n>] <release page url>...
//        cli.mjs <site> gate [--origin <url>] [--deadline-s <n>]   # foreground the site so the owner solves its Cloudflare challenge (and, on RuTracker, logs in)
//        cli.mjs <site> <title words> [year] [--season <n> --episode <n>] [--imdb <tt...>] [--origin <url>]
// A failure is { ok: false, site, origin, error, detail }: error is bot_check, no_chrome,
// login_required (the site's search is for logged-in accounts: run its gate), chrome_not_reachable, cdp_failed,
// no_title, usage or site_error.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ChromeError } from '../chrome.mjs';
import { parseQuery } from '../match.mjs';
import { askInTab, BotCheckError, foregroundTab, secondsLeft } from './browser.mjs';
import { parseMagnet, sameTitle } from './match.mjs';
import { isBotCheckPage } from './page.mjs';
import { TORRENT_SITE_MODULES } from './sites/index.mjs';

/** Both steps of one site together, when the caller gives no --deadline-s. */
export const DEFAULT_DEADLINE_S = 40;
/** Release pages a by-hand look reads. */
export const BY_HAND_RELEASES = 5;
/** Release pages one `magnets` call accepts. */
export const MAX_PAGES_ASKED = 10;

const print = (value) => console.log(JSON.stringify(value, null, 2));
const VALUE_FLAGS = new Set(['--title', '--year', '--season', '--episode', '--imdb', '--origin', '--deadline-s']);

/** The words and flags of one call; `bad` names the first thing wrong with them. */
export function readOptions(argv) {
  const words = [];
  const flags = {};
  let bad = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!VALUE_FLAGS.has(arg)) {
      if (arg.startsWith('--')) bad ??= `unknown flag ${arg}`;
      else words.push(arg);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) bad ??= `${arg} needs a value`;
    else flags[arg.slice(2)] = value;
  }
  const whole = (name) => {
    const value = flags[name];
    if (value === undefined) return null;
    if (!/^\d{1,5}$/.test(value)) {
      bad ??= `--${name} takes a whole number`;
      return null;
    }
    return Number(value);
  };
  const year = whole('year');
  const season = whole('season');
  const episode = whole('episode');
  const deadlineS = whole('deadline-s');
  if ((season === null) !== (episode === null)) bad ??= '--season and --episode go together';
  const imdb = flags.imdb ?? null;
  if (imdb !== null && !/^tt\d{5,10}$/.test(imdb)) bad ??= '--imdb takes an IMDb id such as tt1727587';
  let origin = null;
  if (flags.origin !== undefined) {
    try {
      const url = new URL(flags.origin);
      if (url.protocol === 'https:' || url.protocol === 'http:') origin = url.origin;
      else bad ??= '--origin takes a site address such as https://1337x.la';
    } catch {
      bad ??= '--origin takes a site address such as https://1337x.la';
    }
  }
  return { words, title: flags.title ?? null, year, season, episode, imdb, origin, deadlineS, bad };
}

/** A search's rows that count: release pages on the site, named as the title unless the site searched by IMDb id. */
async function searchSite(site, origin, query, deadline) {
  const found = await site.search(origin, query, { deadline });
  const onSite = found.rows.filter((row) => site.releasePath(row.page_url, origin) !== null);
  const rows = found.by_imdb === true ? onSite : onSite.filter((row) => sameTitle(row.name, query));
  return { url: found.url, rows, others: found.rows.length - rows.length };
}

/** Each release page's magnet link, read into its info hash and trackers. */
async function readMagnets(site, origin, paths, deadline) {
  const got = await site.magnets(origin, paths, { deadline });
  return got.map((entry) => {
    const parsed = typeof entry.magnet === 'string' ? parseMagnet(entry.magnet) : null;
    return {
      page_url: new URL(entry.path, origin).href,
      info_hash: parsed === null ? null : parsed.info_hash,
      trackers: parsed === null ? [] : parsed.trackers,
      magnet: parsed === null ? null : entry.magnet,
      error: parsed === null ? (entry.error ?? 'unreadable magnet link') : null,
    };
  });
}

/** The expression evaluated in the tab: whether it still shows a bot-check page, with its title. */
export function gateExpression() {
  return `(() => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  return { bot_check: isBotCheckPage(document), title: document.title, url: location.href };
})()`;
}

/**
 * The `gate` command: brings the site's tab to the front of the streaming Chrome so the owner can
 * solve a Cloudflare challenge by hand, then watches the tab until it is no longer a bot-check page
 * or the deadline passes. The cf_clearance cookie the profile keeps then lets the daemon's later
 * background searches through. Returns { cleared, title }. Throws ChromeError.
 */
export async function clearGate(site, origin, deadline, { foreground = foregroundTab, ask = askInTab, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  await foreground(origin, { timeoutS: secondsLeft(deadline) });
  let last = { bot_check: true, title: '' };
  while (Date.now() < deadline) {
    try {
      last = await ask(origin, (site?.gateExpression ?? gateExpression)(), { timeoutS: secondsLeft(deadline) });
    } catch (err) {
      // While a challenge holds the only tab, cdp.ps1 answers no_tab (a BotCheckError here): keep waiting.
      if (!(err instanceof BotCheckError)) throw err;
      last = { bot_check: true, title: last.title };
    }
    // A site with a login (RuTracker) is cleared only once the page is a logged-in member's.
    if (last && last.bot_check === false && last.login !== true) return { cleared: true, title: last.title ?? '' };
    await sleep(2000);
  }
  return { cleared: false, title: last?.title ?? '', ...(last?.login === true ? { waiting_for: 'login' } : {}) };
}

export async function main(argv, { sites = TORRENT_SITE_MODULES, gate = clearGate } = {}) {
  const [siteName, ...rest] = argv;
  if (siteName === '--sites') {
    print(Object.values(sites).map((site) => ({ name: site.name, label: site.label, origin: site.defaultOrigin })));
    return 0;
  }
  const site = sites[siteName ?? ''];
  if (!site) {
    print({ ok: false, error: 'usage', detail: `unknown site "${siteName ?? ''}"; known: ${Object.keys(sites).join(', ')}` });
    return 2;
  }
  const command = rest[0] === 'search' || rest[0] === 'magnets' || rest[0] === 'gate' ? rest[0] : 'find';
  const options = readOptions(command === 'find' ? rest : rest.slice(1));
  const origin = options.origin ?? site.defaultOrigin;
  const fail = (error, detail, code) => {
    print({ ok: false, site: site.name, origin, error, detail });
    return code;
  };
  if (options.bad !== null) return fail('usage', options.bad, 2);
  const deadline = Date.now() + (options.deadlineS ?? (command === 'gate' ? (site.gateDeadlineS ?? DEFAULT_DEADLINE_S) : DEFAULT_DEADLINE_S)) * 1000;
  try {
    if (command === 'gate') {
      const { cleared, title, waiting_for: waitingFor } = await gate(site, origin, deadline);
      print({ ok: true, site: site.name, origin, cleared, title, ...(waitingFor === undefined ? {} : { waiting_for: waitingFor }) });
      return 0;
    }
    if (command === 'magnets') {
      if (options.words.length === 0 || options.words.length > MAX_PAGES_ASKED) return fail('usage', `magnets takes 1 to ${MAX_PAGES_ASKED} release page addresses`, 2);
      const paths = [];
      for (const url of options.words) {
        const releasePath = site.releasePath(url, origin);
        if (releasePath === null) return fail('usage', `not a release page on ${origin}: ${url}`, 2);
        paths.push(releasePath);
      }
      print({ ok: true, site: site.name, origin, magnets: await readMagnets(site, origin, paths, deadline) });
      return 0;
    }
    const parsed = command === 'find' ? parseQuery(options.words) : { name: '', year: null };
    const query = {
      title: options.title ?? (parsed.name === '' ? null : parsed.name),
      year: options.year ?? parsed.year,
      season: options.season,
      episode: options.episode,
      imdb: options.imdb,
    };
    if (query.title === null && (site.needsTitle || query.imdb === null)) return fail('no_title', `${site.label} is searched by the title's words: give --title`, 2);
    const found = await searchSite(site, origin, query, deadline);
    if (command === 'search') {
      print({ ok: true, site: site.name, origin, query, url: found.url, rows: found.rows, others: found.others });
      return 0;
    }
    const best = [...found.rows].sort((a, b) => b.seeds - a.seeds).slice(0, BY_HAND_RELEASES);
    const magnets = best.length === 0 ? [] : await readMagnets(site, origin, best.map((row) => site.releasePath(row.page_url, origin)), deadline);
    const byPage = new Map(magnets.map((entry) => [entry.page_url, entry]));
    const releases = best.map((row) => {
      const entry = byPage.get(row.page_url);
      return { ...row, info_hash: entry?.info_hash ?? null, trackers: entry?.trackers ?? [], magnet: entry?.magnet ?? null, error: entry ? entry.error : 'not read' };
    });
    print({ ok: true, site: site.name, origin, query, url: found.url, releases, others: found.others });
    return 0;
  } catch (err) {
    if (err instanceof BotCheckError) return fail('bot_check', err.detail, 1);
    if (err?.code === 'login_required') return fail('login_required', err.detail, 1);
    if (err instanceof ChromeError) return fail(err.code, err.message, 1);
    return fail('site_error', String(err?.message ?? err), 1);
  }
}

// Run by path or through a symlink, so compare real paths.
function isMain() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2));
