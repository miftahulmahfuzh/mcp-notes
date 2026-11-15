#!/usr/bin/env node
// The /idlix skill's search: ask idlix's own search API for a title, from inside a real Chrome on
// Windows (cdp.ps1), and print, as JSON, the results whose name (and year, when one was given)
// match. Usage: search.mjs <title> [year]
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
const TIMEOUT_MS = 60_000;

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

/** Runs one expression in the Chrome tab and returns its value, or throws with a short reason. */
async function evaluateInChrome(expression) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cdp.ps1');
  const { stdout: winScript } = await run('wslpath', ['-w', script]);
  let stdout;
  try {
    ({ stdout } = await run(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript.trim(), '-Origin', IDLIX_ORIGIN, '-JsB64', Buffer.from(expression, 'utf8').toString('base64')],
      // powershell.exe cannot start in a Linux-only folder.
      { cwd: '/mnt/c', timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    ));
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

async function main(argv) {
  const query = parseQuery(argv);
  if (query.name === '') {
    console.error('usage: search.mjs <title> [year]');
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
  console.log(JSON.stringify({ ok: true, query, site: IDLIX_ORIGIN, matches, others }, null, 2));
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
