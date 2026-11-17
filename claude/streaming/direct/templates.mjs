// Reads an aggregator site's provider templates with plain requests, no browser: the site's page,
// the scripts it names, and the webpack/Gatsby chunks those scripts load, up to fixed bounds. A
// provider template is an object entry whose value builds an https address around one id
// variable (a film) or three (an episode: id, season, episode, in that order), keyed by the
// provider's name. Prints what it found; the daemon decides what is new
// (src/directStream/updateSource.ts).
//
// A site whose scripts hold no readable template is read a second way, by templatesCommand below:
// frames.mjs opens a watch page in the streaming Chrome and derives templates from the frames it
// loads. readSiteTemplates itself never opens a browser.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrameTemplates, readFrameTemplatesFromTab } from './frames.mjs';

/** Sent as is: this is a plain request, not a browser, and it does not pretend to be one. */
export const USER_AGENT = 'notesd-update-cloud-source (plain request; reads public scripts)';

export const LIMITS = Object.freeze({
  /** Scripts read after the page itself. */
  maxScripts: 40,
  /** One answer is cut here; a Gatsby app bundle is about 1 MB. */
  maxScriptBytes: 4_000_000,
  maxTotalBytes: 30_000_000,
  fetchTimeoutMs: 20_000,
  /** The whole read stops starting new requests after this. */
  deadlineMs: 90_000,
});

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const KEY = String.raw`(?:(?<k1>[A-Za-z_$][\w$]*)|"(?<k2>[^"\\\n]{1,60})"|'(?<k3>[^'\\\n]{1,60})')`;
// An object entry: preceded by `{` or `,`, so `a ? b : c` and `case x:` never count.
const ENTRY_HEAD = String.raw`(?<=[{,]\s*)${KEY}\s*:\s*`;
const TEMPLATE_ENTRY = new RegExp(String.raw`${ENTRY_HEAD}\x60(?<body>https:\/\/[^\x60]{1,500})\x60`, 'g');
const CONCAT_ENTRY = new RegExp(
  String.raw`${ENTRY_HEAD}(?<q>["'])(?<head>https:\/\/[^"'\n\\]{1,500})\k<q>(?<tail>(?:\s*\+\s*(?:[A-Za-z_$][\w$]*|"[^"\n\\]{0,300}"|'[^'\n\\]{0,300}'))+)`,
  'g',
);
/** Keys that name an attribute, not a provider (a poster's `src`, a link's `href`). */
const GENERIC_KEYS = new Set(['src', 'href', 'url', 'link', 'poster', 'image', 'img', 'backdrop', 'logo', 'icon', 'action', 'canonical', 'background', 'thumbnail', 'avatar']);
/** A one-variable address that points at a series' page, not a film. */
const SHOW_PAGE = /\/(?:tv|series|show)(?:\/|$)|[?&]type=(?:tv|series)\b/i;
/** Chunk names worth reading first: where a site keeps its player servers. */
const LIKELY_CHUNK = /movie|detail|watch|player|embed|server|stream|tv|series|episode/i;

/** A template literal's body as text and variables; null when an expression is not a bare name. */
function partsFromTemplate(body) {
  const parts = [];
  let last = 0;
  for (const m of body.matchAll(/\$\{([^{}]*)\}/g)) {
    parts.push({ text: body.slice(last, m.index) });
    const expr = m[1].trim();
    if (!IDENT_RE.test(expr)) return null;
    parts.push({ variable: expr });
    last = m.index + m[0].length;
  }
  parts.push({ text: body.slice(last) });
  return parts.some((p) => 'text' in p && p.text.includes('${')) ? null : parts;
}

/** `"https://a/" + e + "?x=1"` as text and variables; null when the tail is anything else. */
function partsFromConcat(head, tail) {
  const parts = [{ text: head }];
  const part = /\s*\+\s*(?:(?<id>[A-Za-z_$][\w$]*)|"(?<dq>[^"\n\\]*)"|'(?<sq>[^'\n\\]*)')/y;
  while (part.lastIndex < tail.length) {
    const m = part.exec(tail);
    if (m === null) return null;
    parts.push(m.groups.id !== undefined ? { variable: m.groups.id } : { text: m.groups.dq ?? m.groups.sq ?? '' });
  }
  return parts;
}

/**
 * Text and variables -> `{ kind, url }` with `{id}` (and `{season}`, `{episode}`) in the
 * registry's form, or null when it is not a provider address.
 */
export function templateFromParts(parts) {
  const variables = [...new Set(parts.filter((p) => 'variable' in p).map((p) => p.variable))];
  let names;
  if (variables.length === 1) names = { [variables[0]]: '{id}' };
  else if (variables.length === 3) names = { [variables[0]]: '{id}', [variables[1]]: '{season}', [variables[2]]: '{episode}' };
  else return null;
  const url = parts.map((p) => ('variable' in p ? names[p.variable] : p.text)).join('');
  const kind = variables.length === 3 ? 'tv' : SHOW_PAGE.test(url) ? null : 'movie';
  // An IMDb-keyed address (`tt${id}`) cannot take the TMDB id the registry holds.
  if (kind === null || /tt\{id\}/.test(url)) return null;
  let parsed;
  try {
    parsed = new URL(url.replace('{id}', '550').replace('{season}', '1').replace('{episode}', '1'));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || /\.(?:png|jpe?g|webp|gif|svg|avif|ico|css|js)$/i.test(parsed.pathname)) return null;
  return { kind, url };
}

/** Every provider template in one script, in source order: `{ name, kind, url, found_in }`. */
export function extractTemplates(source, foundIn = null) {
  const entries = [];
  const take = (m, parts) => {
    const name = (m.groups.k1 ?? m.groups.k2 ?? m.groups.k3 ?? '').trim();
    if (name === '' || GENERIC_KEYS.has(name.toLowerCase()) || parts === null) return;
    const template = templateFromParts(parts);
    if (template !== null) entries.push({ name, ...template, at: m.index, found_in: foundIn });
  };
  for (const m of source.matchAll(TEMPLATE_ENTRY)) take(m, partsFromTemplate(m.groups.body));
  for (const m of source.matchAll(CONCAT_ENTRY)) take(m, partsFromConcat(m.groups.head, m.groups.tail));
  return entries.sort((a, b) => a.at - b.at).map(({ at, ...entry }) => entry);
}

/**
 * Film and episode entries -> one provider per name, in first-seen order. The first film
 * template of a name wins; a name with only an episode template is skipped (the registry needs
 * a film template).
 */
export function mergeProviders(entries) {
  const byName = new Map();
  for (const e of entries) {
    const p = byName.get(e.name) ?? { name: e.name, movie: null, tv: null, found_in: e.found_in };
    if (e.kind === 'movie' && p.movie === null) {
      p.movie = e.url;
      p.found_in = e.found_in;
    }
    if (e.kind === 'tv' && p.tv === null) p.tv = e.url;
    byName.set(e.name, p);
  }
  const providers = [];
  const skipped = [];
  for (const p of byName.values()) {
    if (p.movie === null) skipped.push({ name: p.name, reason: 'no_film_template' });
    else providers.push(p);
  }
  return { providers, skipped };
}

/** The script addresses a page names: `<script src>`, and `<link>` preloads of scripts. */
export function scriptUrls(html, pageUrl) {
  const found = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1/gi)) found.push(m[2]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bas\s*=\s*["']?script\b/i.test(tag) && !/\brel\s*=\s*["']?modulepreload\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag);
    if (href) found.push(href[2]);
  }
  return absolute(found, pageUrl);
}

/**
 * The chunks a webpack runtime can load: its `{id: "name"}` and `{id: "<hex hash>"}` maps
 * become `<public path><name or id>-<hash>.js` (Gatsby's naming), plus every hashed script
 * file name the text mentions (Gatsby's inline `___chunkMapping`), taken from the site root.
 */
export function chunkUrls(source, scriptUrl) {
  const names = new Map();
  const hashes = new Map();
  for (const m of source.matchAll(/\{\s*(\d+\s*:\s*"[^"\n]*"(?:\s*,\s*\d+\s*:\s*"[^"\n]*")*)\s*\}/g)) {
    const pairs = [...m[1].matchAll(/(\d+)\s*:\s*"([^"\n]*)"/g)].map((p) => [p[1], p[2]]);
    const target = pairs.every(([, v]) => /^[0-9a-f]{8,}$/.test(v)) ? hashes : names;
    for (const [id, value] of pairs) if (!target.has(id)) target.set(id, value);
  }
  const found = [];
  if (hashes.size > 0) {
    const publicPath = /\.p\s*=\s*"([^"\n]*)"/.exec(source)?.[1] ?? '/';
    for (const [id, hash] of hashes) found.push(`${publicPath}${names.get(id) ?? id}-${hash}.js`);
  }
  for (const m of source.matchAll(/(?<![\w-])([A-Za-z0-9_-]+-[0-9a-f]{16,24}\.js)(?![\w.])/g)) found.push(`/${m[1]}`);
  return absolute(found, scriptUrl);
}

function absolute(paths, base) {
  const out = [];
  for (const p of paths) {
    try {
      const url = new URL(p, base);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.push(url.href);
    } catch {
      // not an address
    }
  }
  return [...new Set(out)];
}

/** The site's own host or one under it; adverts and analytics on other hosts are never read. */
function onSite(url, page) {
  const root = page.hostname.replace(/^www\./, '');
  const host = new URL(url).hostname;
  return host === root || host.endsWith(`.${root}`);
}

/** A Cloudflare-style challenge page instead of the content. */
export function isBotCheck(answer) {
  if (answer.headers?.get?.('cf-mitigated') === 'challenge') return true;
  const head = answer.text.slice(0, 20_000);
  // Not a bare "challenge-platform": plenty of ordinary pages load Cloudflare's passive JS
  // Detection beacon (/cdn-cgi/challenge-platform/scripts/jsd/main.js) for bot scoring without
  // ever blocking anything. _cf_chl_opt is the actual challenge's own config object, which only
  // appears on a page Cloudflare really replaced with a challenge.
  return /<title>\s*(?:Just a moment|Attention Required|Checking your browser)/i.test(head) || /_cf_chl_opt\s*=/.test(head);
}

async function readCapped(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

async function get(fetchImpl, url, limits) {
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });
    return { status: res.status, headers: res.headers, text: await readCapped(res, limits.maxScriptBytes) };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

const NOT_BUILT = "A plain request cannot read it; give a film's watch page (--watch) to read the frames it loads in the streaming Chrome instead.";

const KNOWN_TITLES_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'known-titles.json');

function knownTitles() {
  try {
    return JSON.parse(readFileSync(KNOWN_TITLES_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Reads one site. Answers `{ ok: true, site, scripts_read, providers, skipped }` or
 * `{ ok: false, site, error, detail, scripts_read }` with error `bad_url`, `unreachable`,
 * `bot_check` or `no_templates`.
 */
export async function readSiteTemplates(siteUrl, { fetch: fetchImpl = globalThis.fetch, limits = LIMITS, now = Date.now } = {}) {
  let page;
  try {
    page = new URL(siteUrl);
  } catch {
    return { ok: false, site: String(siteUrl), error: 'bad_url', detail: `not an address: ${siteUrl}`, scripts_read: 0 };
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') {
    return { ok: false, site: page.href, error: 'bad_url', detail: 'only an http or https address can be read', scripts_read: 0 };
  }
  const site = page.href;
  const started = now();
  const home = await get(fetchImpl, site, limits);
  if (home.error !== undefined) return { ok: false, site, error: 'unreachable', detail: home.error, scripts_read: 0 };
  if (isBotCheck(home)) {
    return { ok: false, site, error: 'bot_check', detail: `the page answered HTTP ${home.status} with a bot check. ${NOT_BUILT}`, scripts_read: 0 };
  }
  if (home.status >= 400) return { ok: false, site, error: 'unreachable', detail: `the page answered HTTP ${home.status}`, scripts_read: 0 };

  const entries = extractTemplates(home.text, site);
  const queue = [];
  const seen = new Set();
  const enqueue = (urls) => {
    const fresh = [...new Set(urls)].filter((u) => !seen.has(u) && onSite(u, page));
    for (const u of fresh) seen.add(u);
    queue.unshift(...fresh.filter((u) => LIKELY_CHUNK.test(new URL(u).pathname)));
    queue.push(...fresh.filter((u) => !LIKELY_CHUNK.test(new URL(u).pathname)));
  };
  enqueue([...scriptUrls(home.text, site), ...chunkUrls(home.text, site)]);

  let read = 0;
  let bytes = 0;
  let challenged = 0;
  while (queue.length > 0 && read < limits.maxScripts && bytes < limits.maxTotalBytes && now() - started < limits.deadlineMs) {
    const url = queue.shift();
    const answer = await get(fetchImpl, url, limits);
    if (answer.error !== undefined) continue;
    if (isBotCheck(answer)) {
      challenged += 1;
      continue;
    }
    if (answer.status >= 400) continue;
    read += 1;
    bytes += answer.text.length;
    entries.push(...extractTemplates(answer.text, url));
    enqueue(chunkUrls(answer.text, url));
  }

  const { providers, skipped } = mergeProviders(entries);
  if (providers.length > 0) return { ok: true, site, scripts_read: read, providers, skipped };
  if (read === 0 && challenged > 0) {
    return { ok: false, site, error: 'bot_check', detail: `every script answered with a bot check. ${NOT_BUILT}`, scripts_read: 0 };
  }
  return {
    ok: false,
    site,
    error: 'no_templates',
    detail: `read the page and ${read} scripts (${Math.round(bytes / 1024)} kB) and found no provider template. ${NOT_BUILT}`,
    scripts_read: read,
  };
}

function pageAddress(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Either frame reader's answer, folded against the scripts' failure into templatesCommand's shape. */
function fromFrames(scripts, frames) {
  if (!frames.ok) {
    return {
      code: 1,
      answer: { ok: false, site: scripts.site, error: frames.error, detail: `Scripts: ${scripts.detail} Frames: ${frames.detail}`, scripts_read: scripts.scripts_read },
    };
  }
  const { providers, skipped } = mergeProviders(frames.entries);
  if (providers.length === 0) {
    return {
      code: 1,
      answer: { ok: false, site: scripts.site, error: 'no_templates', detail: `Scripts: ${scripts.detail} Frames: only an episode address was found, and a provider needs a film address.`, scripts_read: scripts.scripts_read },
    };
  }
  return {
    code: 0,
    answer: {
      ok: true,
      site: scripts.site,
      reader: 'frames',
      scripts_read: scripts.scripts_read,
      frames_read: frames.frames_read,
      pages: frames.pages,
      providers: providers.map((p) => ({ ...p, reader: 'frames' })),
      skipped,
    },
  };
}

/**
 * `cli.mjs templates <site url> [--watch <film page>] [--episode <episode page>] [--no-chrome] [--from-tab]`:
 * the answer to print and the exit code (0 found, 1 not, 2 usage).
 *
 * The scripts are read first, with plain requests. The frames are read only when the scripts gave
 * nothing: on `no_templates`, from --watch or else the site address itself; on a plain request's
 * `bot_check`, only from a --watch page that was asked for. --no-chrome never opens the browser.
 * Every provider says which reader found it (`reader`: `scripts` or `frames`), and so does the
 * answer.
 *
 * Two ways to read the frames: by default, frames.mjs's sniffer opens a fresh background tab
 * (`sniff`, sniff.mjs's sniffEmbed), which re-navigates and so re-triggers a site's Cloudflare
 * challenge every time. `--from-tab` instead reads the CURRENT frames of a tab the owner already
 * solved that challenge in by hand (`cli.mjs gate <origin>`), through `ask` (torrent/browser.mjs's
 * askInTab) — no navigation, so the challenge never shows again.
 * options: { fetch, limits, now } for the script reader; { sniff, ask, known } for the frame
 * readers. Without `sniff` or `ask`, nothing that calls this by itself (a test) can reach the
 * streaming Chrome.
 */
export async function templatesCommand(argv, options = {}) {
  const usage = (detail) => ({ code: 2, answer: { ok: false, site: null, error: 'usage', detail, scripts_read: 0 } });
  const positional = [];
  const flags = { watch: null, episode: null, chrome: true, fromTab: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-chrome') flags.chrome = false;
    else if (arg === '--from-tab') flags.fromTab = true;
    else if (arg === '--watch' || arg === '--episode') {
      const value = pageAddress(argv[i + 1] ?? '');
      if (value === null) return usage(`${arg} needs an http or https address`);
      flags[arg.slice(2)] = value;
      i++;
    } else if (arg.startsWith('--')) return usage(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  const site = positional[0];
  if (site === undefined || site.trim() === '' || positional.length > 1) {
    return usage('usage: templates <site url> [--watch <film page>] [--episode <episode page>] [--no-chrome] [--from-tab]');
  }
  const scripts = await readSiteTemplates(site.trim(), options);
  if (scripts.ok) {
    return { code: 0, answer: { ...scripts, reader: 'scripts', providers: scripts.providers.map((p) => ({ ...p, reader: 'scripts' })) } };
  }
  const wantsFrames = flags.chrome && (scripts.error === 'no_templates' || (scripts.error === 'bot_check' && flags.watch !== null));
  if (!wantsFrames) return { code: 1, answer: scripts };

  if (flags.fromTab) {
    if (options.ask == null) return { code: 1, answer: scripts };
    const frames = await readFrameTemplatesFromTab(flags.watch ?? scripts.site, { ask: options.ask, known: options.known ?? knownTitles() });
    return fromFrames(scripts, frames);
  }
  if (options.sniff == null) return { code: 1, answer: scripts };
  const frames = await readFrameTemplates(
    { watch: flags.watch ?? scripts.site, episode: flags.episode },
    { sniff: options.sniff, known: options.known ?? knownTitles() },
  );
  return fromFrames(scripts, frames);
}
