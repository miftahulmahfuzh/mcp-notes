// RuTracker (rutracker.net here: this network's provider blocks rutracker.org, and the .net mirror answers).
// Cloudflare puts a managed challenge in front of its search and topic pages, and the search itself is
// for logged-in accounts only. Both are the owner's to clear, once, by hand: `cli.mjs rutracker gate`
// brings the site's tab to the front, the owner solves the check and logs in, and the streaming Chrome's
// profile keeps the cookies. After that the tab asks the site's own pages with fetch, as its links do.
// Nothing is clicked, no login is typed by a script, and no password is ever read or kept.
// The pages are windows-1251, so they are decoded by hand. A topic's title is written the site's way
// ("Рассказ служанки / The Handmaid's Tale / Сезон: 1 / Серии: 1-10 из 10 (…) [2017, США, …, WEB-DL 2160p]
// MVO + Original (Eng)"); releaseName turns it into a release name the finder reads.
// Selectors as the site had them on 2026-11-19 (tracker.php #tor-tbl, viewtopic.php a.magnet-link,
// #logged-in-username on a member's page).
import { askInTab, BotCheckError, ensureBackgroundTab, secondsLeft } from '../browser.mjs';
import { pathOnSite } from '../../match.mjs';
import { searchWords, toRow } from '../match.mjs';
import { isBotCheckPage } from '../page.mjs';

export const DEFAULT_ORIGIN = 'https://rutracker.net';
/** A result page lists 50 rows; only the first, most seeded page is read. */
export const SEARCH_PATH = '/forum/tracker.php';
/** Logging in takes a person longer than a Cloudflare check. */
export const GATE_DEADLINE_S = 180;

const RELEASE_PATH = /^\/forum\/viewtopic\.php$/;
const CYRILLIC = /[\u0400-\u04ff]/;

/** The site wants the owner logged in: reported as login_required, cleared with the gate command. */
export class LoginRequiredError extends Error {
  constructor(detail) {
    super(`login_required: ${detail}`);
    this.code = 'login_required';
    this.detail = detail;
  }
}

/** The search address: the title's words (and a film's year), most seeders first. */
export function searchPath(query) {
  const words = [searchWords(query.title), query.episode === null && query.year !== null ? String(query.year) : null].filter(Boolean).join(' ');
  const params = new URLSearchParams({ nm: words, o: '10', s: '2' });
  return `${SEARCH_PATH}?${params.toString()}`;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * A topic title as a release name: the Latin title, the season and episodes as S01E01-E10, then the bracket's year
 * and words and the audio after it. "Сезон: 1 / Серии: 1-10 из 10" is S01E01-E10; "Сезон: 2 / Серии: 1-5 из 8" is
 * S02E01-E05; a film has neither. A title with no Latin part keeps its Russian one. Pure; runs in tests.
 */
export function releaseName(topic) {
  const text = String(topic ?? '').replace(/\s+/g, ' ').trim();
  const open = text.search(/[([]/);
  const head = open < 0 ? text : text.slice(0, open);
  const parts = head.split(/\s+\/\s+/).map((p) => p.trim()).filter(Boolean);
  const season = /Сезон(?:ы)?:?\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?/i.exec(text);
  const episodes = /Сери[ия]:?\s*(\d{1,4})(?:\s*-\s*(\d{1,4}))?/i.exec(text);
  const names = parts.filter((p) => !/^(Сезон|Сери)/i.test(p));
  const latin = names.filter((p) => !CYRILLIC.test(p));
  const title = (latin.length > 0 ? latin : names).join(' / ');
  let mark = '';
  if (season) {
    if (season[2] !== undefined) mark = `S${pad(season[1])}-S${pad(season[2])}`;
    else if (episodes) mark = `S${pad(season[1])}E${pad(episodes[1])}${episodes[2] !== undefined && episodes[2] !== episodes[1] ? `-E${pad(episodes[2])}` : ''}`;
    else mark = `S${pad(season[1])}`;
  }
  const bracket = /\[([^\]]*)\]/.exec(text);
  const inside = bracket ? bracket[1].split(',').map((p) => p.trim()).filter((p) => p !== '' && !CYRILLIC.test(p)) : [];
  const year = inside.find((p) => /^(19|20)\d{2}(?:\s*-\s*(19|20)\d{2})?$/.test(p)) ?? null;
  const words = inside.filter((p) => p !== year);
  const tail = bracket ? text.slice(bracket.index + bracket[0].length).trim() : '';
  // A film's year comes before its marks; a series' mark first, so the title ends where a release name's does.
  const ordered = mark === '' ? [title, year ? year.slice(0, 4) : null] : [title, mark, year ? year.slice(0, 4) : null];
  return [...ordered, ...words, tail].filter((p) => p !== null && p !== '').join(' ').replace(/\s+/g, ' ').trim();
}

/** The rows of a search page, in the site's order. Runs in the tab and in tests. */
export function readRows(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('#tor-tbl tr.hl-tr, #tor-tbl tr[data-topic_id]')) {
    const link = tr.querySelector('a.tLink, a[href*="viewtopic.php?t="]');
    if (!link) continue;
    const size = tr.querySelector('td.tor-size');
    const seeds = tr.querySelector('b.seedmed, .seedmed');
    const leeches = tr.querySelector('td.leechmed, .leechmed');
    const bytes = size ? size.getAttribute('data-ts_text') : null;
    rows.push({
      name: link.textContent.replace(/\s+/g, ' ').trim(),
      href: link.getAttribute('href'),
      seeds: seeds ? seeds.textContent.trim() : '',
      leeches: leeches ? leeches.textContent.trim() : '',
      size: bytes && /^\d+$/.test(bytes) ? `${bytes} B` : size ? size.textContent.replace(/[^\d.,A-Za-z ]/g, ' ').trim() : '',
    });
  }
  return rows;
}

/** True when the page is the site's as a logged-in member sees it. Runs in the tab and in tests. */
export function isLoggedIn(doc) {
  return doc.querySelector('#logged-in-username, a.logged-in-as-uname, a[href*="login.php?logout"]') !== null;
}

/** The magnet link on a topic page, or null. Runs in the tab and in tests. */
export function readMagnet(doc) {
  const link = doc.querySelector('a.magnet-link[href^="magnet:?"], a[href^="magnet:?"]');
  return link ? link.getAttribute('href') : null;
}

// Fetches one page of the site from inside the tab and reads it as windows-1251.
const FETCH_PAGE = `async (path) => {
  const res = await fetch(path, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
  const html = new TextDecoder('windows-1251').decode(await res.arrayBuffer());
  return { status: res.status, url: res.url, doc: new DOMParser().parseFromString(html, 'text/html') };
}`;

/** The expression evaluated in the tab: the search page's rows, or why there are none. */
export function searchExpression(path) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const isLoggedIn = ${isLoggedIn.toString()};
  const readRows = ${readRows.toString()};
  const page = await (${FETCH_PAGE})(${JSON.stringify(path)});
  if (isBotCheckPage(page.doc)) return { status: page.status, bot_check: true, title: page.doc.title };
  if (/login\\.php/.test(page.url) || !isLoggedIn(page.doc)) return { status: page.status, login: true, title: page.doc.title };
  return { status: page.status, title: page.doc.title, rows: readRows(page.doc) };
})()`;
}

/** The expression evaluated in the tab: each topic page's magnet link, read side by side. */
export function magnetsExpression(paths) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const readMagnet = ${readMagnet.toString()};
  const fetchPage = ${FETCH_PAGE};
  return Promise.all(${JSON.stringify(paths)}.map(async (path) => {
    try {
      const page = await fetchPage(path);
      if (isBotCheckPage(page.doc)) return { path, bot_check: true };
      return { path, status: page.status, magnet: page.status === 200 ? readMagnet(page.doc) : null };
    } catch (err) {
      return { path, error: String((err && err.message) || err) };
    }
  }));
})()`;
}

/** The expression the gate command watches: a bot check, or a page that is not logged in, keeps the gate shut. */
export function gateExpression() {
  return `(() => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const isLoggedIn = ${isLoggedIn.toString()};
  const bot = isBotCheckPage(document);
  const login = !bot && !isLoggedIn(document);
  // Not logged in and not on the login page yet: show it, so the owner only has to type.
  if (login && document.readyState === 'complete' && !/\\/login\\.php/.test(location.pathname)) setTimeout(() => location.assign('/forum/login.php'), 50);
  return { bot_check: bot, login, title: document.title, url: location.href };
})()`;
}

export default {
  name: 'rutracker',
  label: 'RuTracker',
  defaultOrigin: DEFAULT_ORIGIN,
  /** RuTracker has no IMDb search: it is asked by the title's words. */
  needsTitle: true,
  gateExpression,
  gateDeadlineS: GATE_DEADLINE_S,

  /** The path (with its ?t=) of a topic page on the site, or null for any other address. */
  releasePath(url, origin) {
    const path = pathOnSite(url, origin, RELEASE_PATH);
    if (path === null) return null;
    const topic = new URL(url, origin).searchParams.get('t');
    return topic !== null && /^\d+$/.test(topic) ? `${path}?t=${topic}` : null;
  },

  /** { url, rows }; throws BotCheckError, LoginRequiredError or ChromeError. */
  async search(origin, query, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const path = searchPath(query);
    const value = await askInTab(origin, searchExpression(path), { timeoutS: secondsLeft(deadline) });
    if (value?.bot_check) throw new BotCheckError(`${path} answered "${value.title ?? ''}"`);
    if (value?.login) throw new LoginRequiredError('the search is for logged-in accounts: run `node claude/streaming/torrent/cli.mjs rutracker gate` and log in once in the streaming Chrome');
    if (!value || !Array.isArray(value.rows) || value.status !== 200) throw new Error(`the site answered HTTP ${value?.status ?? '?'} (page title: ${value?.title ?? '?'})`);
    const rows = value.rows.map((row) => toRow({ ...row, href: `/forum/${String(row.href ?? '').replace(/^\/?(forum\/)?/, '')}`, name: releaseName(row.name) }, origin)).filter(Boolean);
    return { url: new URL(path, origin).href, rows };
  },

  /** [{ path, magnet | null, error | null }] in the order asked; throws BotCheckError when every page is one. */
  async magnets(origin, paths, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const value = await askInTab(origin, magnetsExpression(paths), { timeoutS: secondsLeft(deadline, 30) });
    if (!Array.isArray(value)) throw new Error('the topic pages answered nothing');
    if (value.length > 0 && value.every((entry) => entry.bot_check)) throw new BotCheckError('every topic page answered a bot check');
    return value.map((entry) => ({
      path: entry.path,
      magnet: typeof entry.magnet === 'string' ? entry.magnet : null,
      error: typeof entry.magnet === 'string' ? null : (entry.error ?? (entry.bot_check ? 'bot_check' : `HTTP ${entry.status ?? '?'}: no magnet link (log in with the gate command)`)),
    }));
  },
};
