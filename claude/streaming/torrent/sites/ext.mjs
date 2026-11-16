// ext.to. Cloudflare answers a plain request with "Just a moment..." and refuses a fetch made from
// the page (an interactive check, 2026-11-16), but the streaming Chrome's tab loads the site's pages
// when it goes to them, as a person does. So the tab is moved: to the search, then to each release
// page. The site filters by IMDb id (/browse/?imdb_id=tt...), most seeds first. A release page gives
// its magnet through its own "Copy magnet link" request, which is asked here with the page's own
// functions and token, as the button does. Nothing is clicked and the client is the owner's own
// streaming Chrome. Selectors and requests as the site had them on 2026-11-16.
import { askAfterNavigation, askInTab, BotCheckError, ensureBackgroundTab, secondsLeft } from '../browser.mjs';
import { pathOnSite } from '../../match.mjs';
import { toRow } from '../match.mjs';
import { isBotCheckPage } from '../page.mjs';

export const DEFAULT_ORIGIN = 'https://ext.to';

const RELEASE_PATH = /^\/[a-z0-9-]+-\d+\/$/;
const pad = (n) => String(n).padStart(2, '0');

/** The search page: by IMDb id when known (with S02E03 for an episode), else by the title's words. */
export function searchPath(query) {
  const episode = query.episode !== null ? `S${pad(query.season)}E${pad(query.episode)}` : null;
  const params = new URLSearchParams();
  if (query.imdb !== null) {
    if (episode !== null) params.set('q', episode);
    params.set('imdb_id', query.imdb);
  } else {
    params.set('q', [query.title, episode ?? query.year].filter((part) => part !== null && part !== undefined).join(' '));
  }
  params.set('sort', 'seeds');
  params.set('order', 'desc');
  return `/browse/?${params.toString()}`;
}

/** The expression evaluated in the tab: go to `path` once this evaluation has answered. */
export function navigateExpression(path) {
  return `(() => { setTimeout(() => location.assign(${JSON.stringify(path)}), 50); return location.href; })()`;
}

/** The rows of a search page, in the site's order. Runs in the tab and in tests. */
export function readRows(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('table.search-table tbody tr')) {
    const link = tr.querySelector('a.torrent-title-link');
    if (!link) continue;
    const cells = {};
    for (const wrap of tr.querySelectorAll('.add-block-wrapper')) {
      const label = wrap.querySelector('.add-block');
      const value = wrap.lastElementChild;
      if (label && value && value !== label) cells[label.textContent.trim().toLowerCase()] = value.textContent.trim();
    }
    const button = tr.querySelector('.search-magnet-btn[data-id]');
    rows.push({
      name: link.textContent.replace(/\s+/g, ' ').trim(),
      href: link.getAttribute('href'),
      seeds: cells.seeds || '',
      leeches: cells.leechs || '',
      size: cells.size || '',
      id: button ? button.getAttribute('data-id') : null,
    });
  }
  return rows;
}

/** The expression evaluated in the tab: wait until it shows `path`, then read the rows. */
export function rowsExpression(path) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const readRows = ${readRows.toString()};
  const want = ${JSON.stringify(path)};
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (isBotCheckPage(document)) return { bot_check: true, title: document.title };
    if (location.pathname + location.search === want && document.readyState === 'complete') {
      return { url: location.href, title: document.title, rows: readRows(document) };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { url: location.href, title: document.title, waited: true };
})()`;
}

/**
 * The release page's own magnet request ("Copy magnet link"): the page's computeHMAC, its session
 * token and its page token, posted to /ajax/getTorrentMagnet.php. Runs in the tab (its arguments are
 * the page's own) and in tests (with fakes). { magnet } or { error }.
 */
export async function askExtMagnet({ fetch, computeHMAC, sessid, pageToken, torrentId, now }) {
  if (typeof computeHMAC !== 'function' || !pageToken || !sessid) return { error: 'the page has no magnet button script' };
  if (!Number.isInteger(torrentId) || torrentId <= 0) return { error: 'the page names no torrent id' };
  const timestamp = Math.floor(now() / 1000);
  const body = new URLSearchParams({
    torrent_id: String(torrentId),
    action: 'get_magnet',
    timestamp: String(timestamp),
    hmac: computeHMAC(torrentId, timestamp, pageToken),
    sessid,
  });
  const res = await fetch('/ajax/getTorrentMagnet.php', { method: 'POST', body, headers: { 'x-requested-with': 'XMLHttpRequest' } });
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  }
  if (answer && answer.success && typeof answer.magnet === 'string') return { magnet: answer.magnet };
  return { error: (answer && answer.error) || `HTTP ${res.status}` };
}

/**
 * The expression evaluated in the tab: wait until it shows the release page `path`, ask its magnet,
 * then (unless a bot check stood in the way) send the tab on to `nextPath`.
 */
export function magnetExpression(path, nextPath) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const askExtMagnet = ${askExtMagnet.toString()};
  const want = ${JSON.stringify(path)};
  const next = ${JSON.stringify(nextPath)};
  const t0 = Date.now();
  let out = null;
  while (Date.now() - t0 < 15000) {
    if (isBotCheckPage(document)) { out = { bot_check: true, title: document.title }; break; }
    if (location.pathname === want && document.readyState === 'complete') break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (out === null) {
    if (location.pathname !== want) {
      out = { error: 'the release page did not load' };
    } else {
      const button = document.querySelector('.copy-magnet-btn[data-id], .download-btn-magnet[data-id]');
      const id = Number(button ? button.getAttribute('data-id') : (want.match(/-(\\d+)\\/$/) || [])[1]);
      out = await askExtMagnet({
        fetch: (url, init) => fetch(url, init),
        computeHMAC: typeof computeHMAC === 'function' ? computeHMAC : null,
        sessid: typeof getMagnetSessid === 'function' ? getMagnetSessid() : '',
        pageToken: window.pageToken,
        torrentId: id,
        now: () => Date.now(),
      });
    }
  }
  if (next !== null && !out.bot_check) setTimeout(() => location.assign(next), 50);
  return { path: want, ...out };
})()`;
}

export default {
  name: 'ext',
  label: 'ext.to',
  defaultOrigin: DEFAULT_ORIGIN,
  /** ext.to is searched by IMDb id; words only when no id is known. */
  needsTitle: false,

  /** The path of a release page on the site, or null for any other address. */
  releasePath: (url, origin) => pathOnSite(url, origin, RELEASE_PATH),

  /** { url, rows, by_imdb }; throws BotCheckError or ChromeError. */
  async search(origin, query, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const path = searchPath(query);
    await askInTab(origin, navigateExpression(path), { timeoutS: secondsLeft(deadline) });
    const value = await askAfterNavigation(origin, rowsExpression(path), { timeoutS: secondsLeft(deadline) });
    if (value?.bot_check) throw new BotCheckError(`${path} answered "${value.title ?? ''}"`);
    if (!value || !Array.isArray(value.rows)) throw new Error(`the search page did not load (the tab shows ${value?.url ?? '?'}, title: ${value?.title ?? '?'})`);
    return { url: new URL(path, origin).href, rows: value.rows.map((row) => toRow(row, origin)).filter(Boolean), by_imdb: query.imdb !== null };
  },

  /** [{ path, magnet | null, error | null }] in the order asked; one release page after the other. */
  async magnets(origin, paths, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    await askInTab(origin, navigateExpression(paths[0]), { timeoutS: secondsLeft(deadline) });
    const out = [];
    for (let i = 0; i < paths.length; i++) {
      if (deadline - Date.now() < 6000) {
        out.push(...paths.slice(i).map((path) => ({ path, magnet: null, error: 'deadline' })));
        break;
      }
      const value = await askAfterNavigation(origin, magnetExpression(paths[i], paths[i + 1] ?? null), { timeoutS: secondsLeft(deadline) });
      if (value?.bot_check) {
        if (!out.some((entry) => entry.magnet !== null)) throw new BotCheckError(`${paths[i]} answered "${value.title ?? ''}"`);
        out.push(...paths.slice(i).map((path) => ({ path, magnet: null, error: 'bot_check' })));
        break;
      }
      out.push({ path: paths[i], magnet: typeof value?.magnet === 'string' ? value.magnet : null, error: typeof value?.magnet === 'string' ? null : (value?.error ?? 'no answer') });
    }
    return out;
  },
};
