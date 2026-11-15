#!/usr/bin/env node
// The /idlix skill's search: ask idlix's own search API for a title, from inside a real Chrome on
// Windows (cdp.ps1), and print, as JSON, the results whose name (and year, when one was given)
// match. With --play, a single matching film is also opened, started and shown full screen.
// Usage: search.mjs [--play] <title> [year] | search.mjs --play-url <url>
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { normalizeName, parseQuery } from '../pahe/search.mjs';

const run = promisify(execFile);

/** The site moves between hosts (z1, z2, ...); IDLIX_ORIGIN names the current one. */
export const IDLIX_ORIGIN = (process.env.IDLIX_ORIGIN ?? 'https://z2.idlixku.com').replace(/\/+$/, '');

const POWERSHELL = 'powershell.exe';
const SEARCH_LIMIT = 20;

// contentType -> the first path segment of the title's page.
const PATH_BY_TYPE = { movie: 'movie', tv_series: 'series' };

/** The expression cdp.ps1 evaluates in the tab: the search request the site's own modal makes. */
export function searchExpression(name) {
  const query = `/api/search?q=${encodeURIComponent(name).replace(/%20/g, '+')}&page=1&limit=${SEARCH_LIMIT}`;
  return `(async () => {
  const res = await fetch(${JSON.stringify(query)}, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, title: document.title, results: body && Array.isArray(body.results) ? body.results : null };
})()`;
}

/** One API result as the skill reports it; null for a kind of content with no known page. */
export function toResult(item, origin = IDLIX_ORIGIN) {
  const segment = PATH_BY_TYPE[item.contentType];
  if (!segment || typeof item.slug !== 'string' || item.slug === '') return null;
  const date = item.releaseDate ?? item.firstAirDate ?? '';
  const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
  return {
    title: year === null ? item.title : `${item.title} (${year})`,
    name: item.title,
    original_name: item.originalTitle || null,
    year,
    kind: item.contentType === 'movie' ? 'movie' : 'series',
    quality: item.quality ?? null,
    seasons: item.numberOfSeasons ?? null,
    url: `${origin}/${segment}/${item.slug}`,
  };
}

/**
 * Splits results into the ones that are the asked title and the rest, in the site's order. A match
 * has the same normalized name (its English or its original one), and the same year when a year
 * was asked for and the result has one.
 */
export function pickMatches(results, query) {
  const wanted = normalizeName(query.name);
  const matches = [];
  const others = [];
  for (const result of results) {
    const sameName =
      normalizeName(result.name) === wanted ||
      (result.original_name !== null && result.original_name.normalize('NFKC').toLowerCase() === query.name.normalize('NFKC').toLowerCase());
    const sameYear = query.year === null || result.year === null || result.year === query.year;
    (sameName && sameYear ? matches : others).push(result);
  }
  return { matches, others };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The pieces of the title page the play flow touches, as the site had them on 2026-11-15.
const FRAME = '.hero-player-frame';
const HERO_BUTTON = `[...document.querySelectorAll('button')].find((b) => /absolute inset-0/.test(b.className) && /cursor-pointer/.test(b.className))`;

/** Step 1: wait for the big play button on the title page and click it. */
export const CLICK_PLAY_EXPRESSION = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let hero;
  while (!(hero = ${HERO_BUTTON}) && !document.querySelector(${JSON.stringify(FRAME)}) && Date.now() - t0 < 15000) await sleep(300);
  if (hero) hero.click();
  return { clicked: !!hero, player: !!document.querySelector(${JSON.stringify(FRAME)}), url: location.href };
})()`;

/**
 * Step 2: sit through what the site shows before the film (a countdown, then an advert), press
 * the site's own "Skip Ad" when it offers it, and answer once the film itself is running.
 */
export const WAIT_FOR_FILM_EXPRESSION = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let skipped = false;
  let state = null;
  while (Date.now() - t0 < 55000) {
    const frame = document.querySelector(${JSON.stringify(FRAME)});
    const video = frame && frame.querySelector('video');
    const text = frame ? frame.innerText.replace(/\\s+/g, ' ').trim() : '';
    const advert = /^AD\\b/.test(text);
    state = { stage: !frame ? 'no_player' : advert ? 'advert' : video ? 'film' : 'countdown', visible: document.visibilityState === 'visible' };
    if (video && !advert && video.duration > 60 && !video.paused && video.currentTime > 0) {
      return { playing: true, skipped, position_s: Math.round(video.currentTime), duration_s: Math.round(video.duration), muted: video.muted };
    }
    const skip = frame && advert && [...frame.querySelectorAll('button')].find((b) => /^skip ad$/i.test(b.innerText.trim()));
    if (skip) { skip.click(); skipped = true; }
    await sleep(1000);
  }
  return { playing: false, skipped, ...state };
})()`;

/**
 * Step 3, in a window that is already full screen: stretch the player over the page. The page's
 * own full-screen button is refused when the click does not come from the keyboard or mouse, so
 * this is the F11 kind of full screen. Esc, or leaving full screen with F11, puts the page back.
 */
export const FILL_SCREEN_EXPRESSION = `(async () => {
  const frame = document.querySelector(${JSON.stringify(FRAME)});
  if (!frame) return { filled: false };
  if (!document.getElementById('notesd-idlix-fill')) {
    const style = document.createElement('style');
    style.id = 'notesd-idlix-fill';
    style.textContent = '${FRAME}{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;border-radius:0!important;background:#000!important}html{overflow:hidden!important}';
    document.head.appendChild(style);
    const undo = () => { style.remove(); removeEventListener('resize', onResize); removeEventListener('keydown', onKey, true); };
    const onResize = () => { if (innerHeight < screen.height - 40) undo(); };
    const onKey = (e) => { if (e.key === 'Escape') undo(); };
    addEventListener('resize', onResize);
    addEventListener('keydown', onKey, true);
  }
  await new Promise((r) => setTimeout(r, 600));
  const rect = frame.getBoundingClientRect();
  return { filled: rect.width >= screen.width - 2 && rect.height >= screen.height - 2 };
})()`;

/**
 * Runs one expression in the Chrome tab and returns its value, or throws with a short reason.
 * show puts the window in front first, windowState 'fullscreen' makes it fill the screen, and
 * closeOtherTabs closes the advertising tabs the player's clicks open.
 */
async function evaluateInChrome(expression, { show = false, windowState = 'normal', closeOtherTabs = false, timeoutS = 45 } = {}) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp.ps1');
  const { stdout: winScript } = await run('wslpath', ['-w', script]);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(), '-Origin', IDLIX_ORIGIN];
  args.push('-JsB64', Buffer.from(expression, 'utf8').toString('base64'), '-TimeoutS', String(timeoutS));
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
  if (reply.cdp_error) throw new Error(`${reply.cdp_error}: ${reply.detail}`);
  const outer = reply.result ?? {};
  if (outer.exceptionDetails) throw new Error(`page error: ${outer.exceptionDetails.exception?.description ?? outer.exceptionDetails.text}`);
  return outer.result?.value;
}

/** The path of a title page on the site, or null for any other address. */
export function titlePath(url, origin = IDLIX_ORIGIN) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin || !/^\/(movie|series)\/[a-z0-9-]+$/.test(parsed.pathname)) return null;
  return parsed.pathname;
}

/**
 * Opens a title page in the skill's Chrome, in front of everything, starts the film and fills the
 * screen with it. Answers what happened; never throws.
 */
async function play(url) {
  const pathname = titlePath(url);
  if (pathname === null) return { playing: false, error: `not a title page on ${IDLIX_ORIGIN}: ${url}` };
  try {
    await evaluateInChrome(`location.assign(${JSON.stringify(pathname)}); 'ok'`, { show: true, closeOtherTabs: true });
    // The old page may still answer for a moment while the new one loads.
    let clicked = null;
    for (let attempt = 0; attempt < 4 && !(clicked?.url?.endsWith(pathname) && (clicked.clicked || clicked.player)); attempt++) {
      await sleep(1500);
      clicked = await evaluateInChrome(CLICK_PLAY_EXPRESSION, { show: true, timeoutS: 30 }).catch(() => null);
    }
    if (!clicked?.clicked && !clicked?.player) return { playing: false, error: 'the page has no play button' };
    // The click opens an advertising tab in front of the page, and the countdown stops behind it.
    await sleep(1500);
    const film = await evaluateInChrome(WAIT_FOR_FILM_EXPRESSION, { show: true, closeOtherTabs: true, timeoutS: 75 });
    if (!film?.playing) return { ...film, playing: false };
    const filled = await evaluateInChrome(FILL_SCREEN_EXPRESSION, { show: true, windowState: 'fullscreen', closeOtherTabs: true });
    return { ...film, fullscreen: filled?.filled === true };
  } catch (err) {
    return { playing: false, error: String(err?.message ?? err) };
  }
}

async function main(argv) {
  const wantPlay = argv[0] === '--play';
  if (argv[0] === '--play-url') {
    const played = await play(argv[1] ?? '');
    console.log(JSON.stringify({ ok: played.playing === true, site: IDLIX_ORIGIN, url: argv[1] ?? null, play: played }, null, 2));
    return played.playing ? 0 : 1;
  }
  const query = parseQuery(wantPlay ? argv.slice(1) : argv);
  if (query.name === '') {
    console.error('usage: search.mjs [--play] <title> [year] | search.mjs --play-url <url>');
    return 2;
  }
  let value;
  try {
    value = await evaluateInChrome(searchExpression(query.name));
    if (!value || value.status !== 200 || value.results === null) {
      throw new Error(`the site answered HTTP ${value?.status ?? '?'} (page title: ${value?.title ?? '?'})`);
    }
  } catch (err) {
    console.log(JSON.stringify({ ok: false, site: IDLIX_ORIGIN, error: String(err?.message ?? err) }, null, 2));
    return 1;
  }
  const results = value.results.map((item) => toResult(item)).filter(Boolean);
  const { matches, others } = pickMatches(results, query);
  const out = { ok: true, query, site: IDLIX_ORIGIN, matches, others };
  if (wantPlay) {
    // Only an unambiguous film starts on its own; a series has episodes to choose from.
    out.play =
      matches.length === 1 && matches[0].kind === 'movie'
        ? await play(matches[0].url)
        : { playing: false, skipped_play: matches.length === 0 ? 'no_match' : matches.length > 1 ? 'several_matches' : 'series' };
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

// The skill folder is a symlink in ~/.claude/skills, so compare real paths.
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
