// The second template reader of /update-cloud-source, for a site whose scripts hold no template
// a plain request can read (templates.mjs answers no_templates). It opens a watch page of the
// site in the streaming Chrome through the sniffer (sniff.mjs: a background tab, muted, the
// notesd-stream-chrome profile, closed afterwards), takes the addresses of the frames the page
// loaded, and derives a provider template from each frame that carries the title's TMDB id: the
// id becomes {id}, and on an episode page the season and episode become {season} and {episode}.
//
// Which number is the id: one of the known titles' TMDB ids (known-titles.json: a watch page of
// Fight Club carries 550), or a number the watch page's own address carries. A frame without such
// a number is an advert or a player inside a player and is left out. A provider is named after
// its frame's host, since a frame has no name; the registry matches providers by address, not by
// name, so one it already has is still recognised.
//
// Only the frames the page loads by itself (and after the sniffer's own play click) are seen: the
// site's other server buttons are not pressed. A bot check is an outcome (bot_check): the sniffer
// stops clicking once it sees one, and nothing here tries to get past it.
//
// A site whose Cloudflare challenge the sniffer's fresh navigation cannot clear (it never
// completes in a background tab) is read a third way, by readFrameTemplatesFromTab below: the
// owner solves the challenge by hand in a foregrounded tab (cli.mjs gate), and this reads that
// SAME tab's current frames with a JS expression (never a new navigation, so the challenge never
// shows again). It only sees the top page's own <iframe> elements (their `src` attribute, which
// is readable cross-origin without touching the frame's content) — a frame nested inside another
// cross-origin frame is invisible this way, unlike the sniffer's CDP-level capture. That is the
// one thing this reader gives up for never re-navigating the already-solved tab.
import { BotCheckError } from '../torrent/browser.mjs';

/** Seconds one watch page is watched for its frames. */
export const FRAME_SNIFF_SECONDS = 20;

/** A season or episode number or word in a page's path: the tab is probably on an episode. */
const EPISODE_PAGE_HINT = /season|episode|\bs\d{1,2}[-_]?e\d{1,3}\b/i;

const ASSET = /\.(?:png|jpe?g|webp|gif|svg|avif|ico|css|js|json|woff2?)$/i;
const SEASON_KEY = /^(?:s|season|ss|se)$/i;
const EPISODE_KEY = /^(?:e|ep|episode|eps)$/i;

/** The whole-number parts of an address, in order: path segments and query values that are digits only. */
export function numberTokens(url) {
  const tokens = [];
  url.pathname.split('/').forEach((segment, index) => {
    if (/^\d+$/.test(segment)) tokens.push({ value: segment, where: 'path', index, key: null });
  });
  let n = 0;
  for (const [key, value] of url.searchParams) {
    if (/^\d+$/.test(value)) tokens.push({ value, where: 'query', index: n, key });
    n++;
  }
  return tokens;
}

/** The numbers a watch page's address carries: whole segments and query values, and the number a slug starts or ends with (`550-fight-club`, `fight-club-550`). */
export function pageNumbers(url) {
  const numbers = numberTokens(url).map((t) => t.value);
  for (const segment of url.pathname.split('/')) {
    const m = /^(\d{2,})[-_.]/.exec(segment) ?? /[-_](\d{2,})(?:\.[a-z]+)?$/i.exec(segment);
    if (m) numbers.push(m[1]);
  }
  return numbers;
}

/** `url` with the chosen tokens replaced by placeholders, written by hand so the braces stay unescaped. */
function withPlaceholders(url, replacements) {
  const segments = url.pathname.split('/');
  const pairs = [...url.searchParams].map(([key, value]) => [key, encodeURIComponent(value)]);
  for (const [token, placeholder] of replacements) {
    if (token.where === 'path') segments[token.index] = placeholder;
    else pairs[token.index][1] = placeholder;
  }
  const query = pairs.map(([key, value]) => `${encodeURIComponent(key)}=${value}`).join('&');
  return `${url.origin}${segments.join('/')}${query === '' ? '' : `?${query}`}`;
}

/**
 * The template one frame address gives, or null. `wanted`: { ids: Set of id strings, season,
 * episode } where season and episode are strings on an episode page and null on a film page.
 */
export function templateFromFrame(frameUrl, wanted) {
  let url;
  try {
    url = new URL(frameUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || ASSET.test(url.pathname)) return null;
  const tokens = numberTokens(url);
  const id = tokens.find((t) => wanted.ids.has(t.value));
  if (id === undefined) return null;
  if (wanted.season === null || wanted.episode === null) {
    return { kind: 'movie', url: withPlaceholders(url, [[id, '{id}']]) };
  }
  const rest = tokens.filter((t) => t !== id);
  // A named parameter says which number it is; otherwise the season comes before the episode.
  const season =
    rest.find((t) => t.key !== null && SEASON_KEY.test(t.key) && t.value === wanted.season) ??
    rest.find((t) => t.value === wanted.season && !(t.key !== null && EPISODE_KEY.test(t.key)));
  const episode =
    rest.find((t) => t !== season && t.key !== null && EPISODE_KEY.test(t.key) && t.value === wanted.episode) ??
    rest.find((t) => t !== season && t.value === wanted.episode);
  if (season === undefined || episode === undefined) return null;
  return { kind: 'tv', url: withPlaceholders(url, [[id, '{id}'], [season, '{season}'], [episode, '{episode}']]) };
}

/** A provider's name when all there is is its frame: the host without `www.`. */
export function nameFromHost(frameUrl) {
  return new URL(frameUrl).hostname.replace(/^www\./, '').toLowerCase();
}

/**
 * What one watch page is about, for templateFromFrame. `known`: [{ kind, tmdb_id, season?,
 * episode? }] (known-titles.json). `episodePage` says the page is an episode's: its season and
 * episode are a known series' when its id is in the page or a frame, else the two numbers that
 * follow the id in the page's own address.
 */
export function wantedFor(pageUrl, frames, known, episodePage) {
  const page = new URL(pageUrl);
  const ids = new Set(pageNumbers(page).filter((n) => n.length >= 2));
  for (const title of known) if (!episodePage || title.kind === 'tv') ids.add(String(title.tmdb_id));
  if (!episodePage) return { ids, season: null, episode: null };
  const frameNumbers = new Set(frames.flatMap((f) => { try { return numberTokens(new URL(f)).map((t) => t.value); } catch { return []; } }));
  const series = known.find((t) => t.kind === 'tv' && (frameNumbers.has(String(t.tmdb_id)) || pageNumbers(page).includes(String(t.tmdb_id))));
  if (series !== undefined) return { ids: new Set([String(series.tmdb_id)]), season: String(series.season ?? 1), episode: String(series.episode ?? 1) };
  const tokens = numberTokens(page);
  const named = (re) => tokens.find((t) => t.key !== null && re.test(t.key))?.value ?? null;
  const at = tokens.findIndex((t) => t.value.length >= 2);
  const after = at === -1 ? [] : tokens.slice(at + 1).filter((t) => t.key === null || (!SEASON_KEY.test(t.key) && !EPISODE_KEY.test(t.key)));
  const season = named(SEASON_KEY) ?? after[0]?.value ?? null;
  const episode = named(EPISODE_KEY) ?? after[named(SEASON_KEY) === null ? 1 : 0]?.value ?? null;
  return { ids: at === -1 ? new Set() : new Set([tokens[at].value]), season, episode };
}

/** The template entries (`{ name, kind, url, found_in }`, templates.mjs's shape) of one watch page's frames, off the site's own host. */
export function entriesFromFrames(pageUrl, frames, known, episodePage) {
  const site = new URL(pageUrl).hostname.replace(/^www\./, '');
  const wanted = wantedFor(pageUrl, frames, known, episodePage);
  const entries = [];
  const seen = new Set();
  for (const frame of frames) {
    if (typeof frame !== 'string') continue;
    const template = templateFromFrame(frame, wanted);
    if (template === null) continue;
    const name = nameFromHost(frame);
    if (name === site || seen.has(`${template.kind} ${template.url}`)) continue;
    seen.add(`${template.kind} ${template.url}`);
    entries.push({ name, ...template, found_in: frame });
  }
  return entries;
}

/** The https addresses of the frames a capture lists. The sniffer writes each target as "<type> <address>": the page itself and workers are not frames. */
export function frameAddresses(targets) {
  const out = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (typeof target !== 'string') continue;
    const space = target.indexOf(' ');
    const type = space === -1 ? 'iframe' : target.slice(0, space);
    const address = space === -1 ? target : target.slice(space + 1).trim();
    if (type === 'iframe' && address.startsWith('https://') && !out.includes(address)) out.push(address);
  }
  return out;
}

/**
 * The frame addresses a capture's network hits carry, off `pageHost`: `Target.attachedToTarget`
 * fires at a frame's creation, before it navigates away from `about:blank`, so a frame that
 * navigates fast can leave `frameAddresses` with a blank address even though its own requests
 * (a manifest, a subtitle index) carry `documentURL` — the frame's address once it has navigated.
 * A fallback, not a replacement: it only ever adds addresses `frameAddresses` missed.
 */
export function hitFrameAddresses(hits, pageHost) {
  const out = [];
  for (const hit of Array.isArray(hits) ? hits : []) {
    const doc = hit?.document;
    if (typeof doc !== 'string' || !doc.startsWith('https://') || out.includes(doc)) continue;
    try {
      if (new URL(doc).hostname.replace(/^www\./, '') === pageHost) continue;
    } catch {
      continue;
    }
    out.push(doc);
  }
  return out;
}

/**
 * Reads the frames of one or two watch pages. `pages`: { watch, episode } (addresses; episode may
 * be null). `sniff(url, options)` is sniff.mjs's sniffEmbed (tests pass a fake). Answers
 * `{ ok: true, entries, frames_read, pages }` or `{ ok: false, error, detail }` with error
 * `bot_check`, `chrome_unavailable` or `no_templates`.
 */
export async function readFrameTemplates(pages, { sniff, known = [], seconds = FRAME_SNIFF_SECONDS } = {}) {
  const entries = [];
  const read = [];
  let framesRead = 0;
  for (const [pageUrl, episodePage] of [[pages.watch, false], [pages.episode ?? null, true]]) {
    if (pageUrl === null || pageUrl === undefined) continue;
    let capture;
    try {
      capture = await sniff(pageUrl, { seconds });
    } catch (err) {
      const code = typeof err?.code === 'string' ? err.code : 'sniff_failed';
      return { ok: false, error: 'chrome_unavailable', detail: `the streaming Chrome could not open ${pageUrl}: ${code}${err?.message ? ` (${String(err.message).slice(0, 200)})` : ''}` };
    }
    if (capture.bot_check === true) {
      return { ok: false, error: 'bot_check', detail: `${pageUrl} shows a bot check in the streaming Chrome${capture.bot_check_reason ? ` (${capture.bot_check_reason})` : ''}. It is not got past.` };
    }
    const site = new URL(pageUrl).hostname.replace(/^www\./, '');
    const frames = [...frameAddresses(capture.frames), ...hitFrameAddresses(capture.hits, site)];
    framesRead += frames.length;
    read.push(pageUrl);
    entries.push(...entriesFromFrames(pageUrl, frames, known, episodePage));
  }
  if (entries.some((e) => e.kind === 'movie')) return { ok: true, entries, frames_read: framesRead, pages: read };
  return {
    ok: false,
    error: 'no_templates',
    detail:
      `opened ${read.length === 1 ? read[0] : `${read.length} pages`} in the streaming Chrome and read ${framesRead} frame addresses; none carries a film's TMDB id. ` +
      "Pass a film's watch page as watch_page (a page of a known title works best: Fight Club, TMDB 550). Only the frames the page loads by itself are read; its other server buttons are not pressed.",
  };
}

/** Whether a page is probably on an episode, from its own address: no site is asked. */
export function looksLikeEpisodePage(url) {
  try {
    return EPISODE_PAGE_HINT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Evaluated (toString'd) in the gated tab by `ask` (torrent/browser.mjs's askInTab): the tab's own
 * frame addresses, read without navigating it.
 */
export function tabFramesExpression() {
  return `(() => {
  const frames = Array.from(document.querySelectorAll('iframe'))
    .map((f) => f.src)
    .filter((s) => typeof s === 'string' && s.startsWith('https://'));
  return { url: location.href, frames };
})()`;
}

/**
 * The alternate frame reader: reads the CURRENT frames of a tab the owner already solved a
 * Cloudflare challenge in by hand (`cli.mjs gate <origin>`), instead of opening a fresh
 * navigation that would show the challenge again. `ask`: torrent/browser.mjs's askInTab (origin,
 * expression) -> Promise, a test seam otherwise. Answers the same shape as readFrameTemplates:
 * `{ ok: true, entries, frames_read, pages }` or `{ ok: false, error, detail }`, with error
 * `no_tab` (no gated tab answered, or it is still on the challenge), `chrome_unavailable` or
 * `no_templates`.
 */
export async function readFrameTemplatesFromTab(origin, { ask, known = [] } = {}) {
  let reply;
  try {
    reply = await ask(origin, tabFramesExpression());
  } catch (err) {
    if (err instanceof BotCheckError) {
      return { ok: false, error: 'no_tab', detail: `no gated tab answered on ${new URL(origin).host} within the time given. Clear its challenge by hand first: cli.mjs gate ${origin}` };
    }
    const code = typeof err?.code === 'string' ? err.code : null;
    if (code === 'no_chrome' || code === 'chrome_not_reachable' || code === 'cdp_failed') {
      return { ok: false, error: 'chrome_unavailable', detail: `the streaming Chrome could not read the gated tab on ${new URL(origin).host}: ${code}${err?.message ? ` (${String(err.message).slice(0, 200)})` : ''}` };
    }
    return { ok: false, error: 'no_tab', detail: `could not read the gated tab on ${new URL(origin).host}: ${err?.message ?? err}` };
  }
  const pageUrl = typeof reply?.url === 'string' ? reply.url : origin;
  const frames = Array.isArray(reply?.frames) ? reply.frames.filter((f) => typeof f === 'string') : [];
  const entries = entriesFromFrames(pageUrl, frames, known, looksLikeEpisodePage(pageUrl));
  if (entries.some((e) => e.kind === 'movie')) return { ok: true, entries, frames_read: frames.length, pages: [pageUrl] };
  return {
    ok: false,
    error: 'no_templates',
    detail:
      `read the gated tab on ${pageUrl} and found ${frames.length} frame address${frames.length === 1 ? '' : 'es'}; none carries a film's TMDB id. ` +
      'Only the top page\'s own frames are read this way; a frame nested inside another is not seen.',
  };
}
