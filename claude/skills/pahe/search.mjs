#!/usr/bin/env node
// The /pahe skill's search: fetch pahe.ink's search page for a title and print, as JSON, the
// results whose name (and year, when one was given) match. Usage: search.mjs <title> [year]
import { pathToFileURL } from 'node:url';

export const PAHE_ORIGIN = 'https://pahe.ink';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 30_000;

// Best source first; a result with none of these sorts last.
const SOURCE_ORDER = ['bluray', 'web-dl', 'webrip', 'hdrip', 'hdtv', 'dvdrip'];

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** Lower case, accents dropped, "&" read as "and", everything but letters and digits removed. */
export function normalizeName(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * "no other choice 2025" -> { name: "no other choice", year: 2025 }. A trailing number is a year
 * only when words come before it and it is a plausible release year, so "1917" and
 * "blade runner 2049" stay whole titles.
 */
export function parseQuery(words, now = new Date()) {
  const text = words.join(' ').trim().replace(/\s+/g, ' ');
  const m = /^(.+?)\s+\(?(\d{4})\)?$/.exec(text);
  if (m) {
    const year = Number(m[2]);
    if (year >= 1900 && year <= now.getFullYear() + 1) return { name: m[1], year };
  }
  return { name: text, year: null };
}

/** "No Other Choice (2025) BluRay 480p, 720p & 1080p" -> its name, year and release. */
export function splitTitle(title) {
  const movie = /^(.*?)\s*\((\d{4})\)\s*(.*)$/.exec(title);
  if (movie) return { name: movie[1], year: Number(movie[2]), release: movie[3] };
  const series = /^(.*?)\s+(Season\s+\d.*)$/i.exec(title);
  if (series) return { name: series[1], year: null, release: series[2] };
  return { name: title, year: null, release: '' };
}

/**
 * The search results of one pahe.ink search page, in page order. Only a link inside an
 * <h2 class="post-box-title"> is a result: the page's menus, lists and featured posts are not.
 */
export function parseResults(html) {
  const results = [];
  const seen = new Set();
  const re = /<h2[^>]*class="[^"]*\bpost-box-title\b[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const url = decodeEntities(m[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    results.push({ title, url, ...splitTitle(title) });
  }
  return results;
}

function sourceRank(release) {
  const lower = release.toLowerCase();
  const rank = SOURCE_ORDER.findIndex((source) => lower.includes(source));
  return rank === -1 ? SOURCE_ORDER.length : rank;
}

/**
 * Splits results into the ones that are the asked title and the rest. A match has the same
 * normalized name, and the same year when a year was asked for; a series (no year in its title)
 * matches on the name alone. Matches are ordered best source first.
 */
export function pickMatches(results, query) {
  const wanted = normalizeName(query.name);
  const matches = [];
  const others = [];
  for (const result of results) {
    const sameName = normalizeName(result.name) === wanted;
    const sameYear = query.year === null || result.year === null || result.year === query.year;
    (sameName && sameYear ? matches : others).push(result);
  }
  matches.sort((a, b) => sourceRank(a.release) - sourceRank(b.release));
  return { matches, others };
}

export function searchUrl(name) {
  return `${PAHE_ORIGIN}/?s=${encodeURIComponent(name).replace(/%20/g, '+')}`;
}

async function main(argv) {
  const query = parseQuery(argv);
  if (query.name === '') {
    console.error('usage: search.mjs <title> [year]');
    return 2;
  }
  const url = searchUrl(query.name);
  let html;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.log(JSON.stringify({ ok: false, search_url: url, error: String(err?.message ?? err) }, null, 2));
    return 1;
  }
  const results = parseResults(html);
  const { matches, others } = pickMatches(results, query);
  console.log(JSON.stringify({ ok: true, query, search_url: url, matches, others }, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
