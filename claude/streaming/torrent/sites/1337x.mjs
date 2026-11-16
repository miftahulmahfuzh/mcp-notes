// 1337x (1337x.la). Its pages answered a plain request too on 2026-11-16, but the torrent sites are
// asked only inside the streaming Chrome, in a background tab. Its search lists a row when any one
// word matches, so the title's small words are left out (match.mjs searchWords) and the rows are
// matched to the title afterwards (cli.mjs). Selectors as the site had them on 2026-11-16.
import { askInTab, BotCheckError, ensureBackgroundTab, secondsLeft } from '../browser.mjs';
import { pathOnSite } from '../../match.mjs';
import { searchWords, toRow } from '../match.mjs';
import { isBotCheckPage } from '../page.mjs';

export const DEFAULT_ORIGIN = 'https://1337x.la';
/** A result page lists 20 rows; the next page is read only when one is full. */
export const PAGE_ROWS = 20;
export const MAX_PAGES = 2;

const RELEASE_PATH = /^\/torrent\/\d+\/[^/]+\/$/;

/** The address of one result page: films under Movies, an episode under TV. */
export function searchPath(words, episode, page) {
  return `/category-search/${encodeURIComponent(words)}/${episode ? 'TV' : 'Movies'}/${page}/`;
}

/** The rows of one result page, in the site's order. Runs in the tab and in tests. */
export function readRows(doc) {
  const rows = [];
  for (const tr of doc.querySelectorAll('table.table-list tbody tr')) {
    const link = tr.querySelector('td.name a[href^="/torrent/"]');
    if (!link) continue;
    const cell = (selector) => {
      const td = tr.querySelector(selector);
      if (!td) return '';
      return (td.childNodes[0] ? td.childNodes[0].textContent : td.textContent).trim();
    };
    rows.push({
      name: link.textContent.replace(/\s+/g, ' ').trim(),
      href: link.getAttribute('href'),
      seeds: cell('td.seeds'),
      leeches: cell('td.leeches'),
      size: cell('td.size'),
    });
  }
  return rows;
}

/** The magnet link on a release page, or null. Runs in the tab and in tests. */
export function readMagnet(doc) {
  const link = doc.querySelector('a[href^="magnet:?"]');
  return link ? link.getAttribute('href') : null;
}

/** The expression evaluated in the tab: the result pages, as the site's own search links them. */
export function searchExpression(paths) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const readRows = ${readRows.toString()};
  const rows = [];
  for (const path of ${JSON.stringify(paths)}) {
    const res = await fetch(path, { headers: { accept: 'text/html' } });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    if (isBotCheckPage(doc)) return { status: res.status, bot_check: true, title: doc.title };
    if (res.status !== 200) return { status: res.status, title: doc.title, rows };
    const found = readRows(doc);
    rows.push(...found);
    if (found.length < ${PAGE_ROWS}) break;
  }
  return { status: 200, rows };
})()`;
}

/** The expression evaluated in the tab: each release page's magnet link, read side by side. */
export function magnetsExpression(paths) {
  return `(async () => {
  const isBotCheckPage = ${isBotCheckPage.toString()};
  const readMagnet = ${readMagnet.toString()};
  return Promise.all(${JSON.stringify(paths)}.map(async (path) => {
    try {
      const res = await fetch(path, { headers: { accept: 'text/html' } });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (isBotCheckPage(doc)) return { path, bot_check: true };
      return { path, status: res.status, magnet: res.status === 200 ? readMagnet(doc) : null };
    } catch (err) {
      return { path, error: String((err && err.message) || err) };
    }
  }));
})()`;
}

export default {
  name: '1337x',
  label: '1337x',
  defaultOrigin: DEFAULT_ORIGIN,
  /** 1337x has no IMDb search: it is asked by the title's words. */
  needsTitle: true,

  /** The path of a release page on the site, or null for any other address. */
  releasePath: (url, origin) => pathOnSite(url, origin, RELEASE_PATH),

  /** { url, rows: [{ name, page_url, seeds, leeches, size_bytes }] }; throws BotCheckError or ChromeError. */
  async search(origin, query, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const words = searchWords(query.title);
    const paths = Array.from({ length: MAX_PAGES }, (_, i) => searchPath(words, query.episode !== null, i + 1));
    const value = await askInTab(origin, searchExpression(paths), { timeoutS: secondsLeft(deadline) });
    if (value?.bot_check) throw new BotCheckError(`${paths[0]} answered "${value.title ?? ''}"`);
    if (!value || !Array.isArray(value.rows) || (value.status !== 200 && value.rows.length === 0)) {
      throw new Error(`the site answered HTTP ${value?.status ?? '?'} (page title: ${value?.title ?? '?'})`);
    }
    return { url: new URL(paths[0], origin).href, rows: value.rows.map((row) => toRow(row, origin)).filter(Boolean) };
  },

  /** [{ path, magnet | null, error | null }] in the order asked; throws BotCheckError when every page is one. */
  async magnets(origin, paths, { deadline }) {
    await ensureBackgroundTab(origin, { timeoutS: secondsLeft(deadline) });
    const value = await askInTab(origin, magnetsExpression(paths), { timeoutS: secondsLeft(deadline, 30) });
    if (!Array.isArray(value)) throw new Error('the release pages answered nothing');
    if (value.length > 0 && value.every((entry) => entry.bot_check)) throw new BotCheckError('every release page answered a bot check');
    return value.map((entry) => ({
      path: entry.path,
      magnet: typeof entry.magnet === 'string' ? entry.magnet : null,
      error: typeof entry.magnet === 'string' ? null : (entry.error ?? (entry.bot_check ? 'bot_check' : `HTTP ${entry.status ?? '?'}: no magnet link`)),
    }));
  },
};
