// dramacool (dramacool9.com.ro), Asian dramas with English subtitles. The site answers a plain
// request, so the search and the episode list need no browser; only playing does. Every title is
// a list of episodes (a film is a title with one), and an episode plays inside a frame from
// another host (vidbasic, the site's "Fast Server"), whose JW Player sits in a second frame of
// that same host. Selectors and addresses as the site had them on 2026-11-18.
import { ChromeError } from '../chrome.mjs';
import { pathOnSite } from '../match.mjs';

/** The site moves between hosts (dramacool9, ...); DRAMACOOL_ORIGIN names the current one. */
const ORIGIN = (process.env.DRAMACOOL_ORIGIN ?? 'https://dramacool9.com.ro').replace(/\/+$/, '');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 30_000;

// The frame on the episode page that holds the player of the server the site chose.
const PLAYER_FRAME = '#video-frame';
const TITLE_PATH = /^\/[a-z0-9-]+$/;
const EPISODE_PATH = /^\/[a-z0-9-]+-episode-\d+\.html$/;

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

const NAMED_ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/** "Lovers &#038; Gangsters" -> "Lovers & Gangsters". */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
    const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  });
}

/**
 * "Summer Vacation (2026)" -> the name and year. A later season is a title of its own on the
 * site ("Love Wins All Season 2 (2026)"): its name is the series' and `full_name` keeps the
 * season, so either finds it. "Concrete Market (Movie) (2025)" keeps the bracket as `other_name`.
 */
export function splitTitle(title) {
  const yearMatch = /\s*\((\d{4})\)\s*$/.exec(title);
  const bare = (yearMatch ? title.slice(0, yearMatch.index) : title).trim();
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const seasonMatch = /^(.*\S)\s+Season\s+(\d{1,3})$/i.exec(bare);
  if (seasonMatch) return { name: seasonMatch[1], full_name: bare, other_name: null, year, season: Number(seasonMatch[2]) };
  const alt = /^(.*\S)\s+\(([^()]+)\)$/.exec(bare);
  return { name: alt ? alt[1] : bare, full_name: bare, other_name: alt ? alt[2] : null, year, season: 1 };
}

/** The titles a search page lists: [{ href, title }] from its result cards, entities decoded. */
export function parseSearch(html) {
  const items = [];
  for (const m of html.matchAll(/<a class="mask" href="([^"]+)" title="([^"]*)"/g)) {
    items.push({ href: decodeEntities(m[1]), title: decodeEntities(m[2]).trim() });
  }
  return items;
}

/** One search result as the skill reports it; null when it is not a title page on the site. */
export function toResult(item, origin = ORIGIN) {
  if (typeof item.href !== 'string' || typeof item.title !== 'string' || item.title === '') return null;
  const pathname = pathOnSite(item.href, origin, TITLE_PATH);
  if (pathname === null) return null;
  const { name, full_name, other_name, year } = splitTitle(item.title);
  return {
    title: item.title,
    name,
    original_name: full_name !== name && other_name === null ? full_name : other_name,
    year,
    // Every title is a page of episodes; nothing in a result says how many.
    kind: 'series',
    quality: null,
    seasons: null,
    url: `${origin}${pathname}`,
  };
}

/** The season a title's page is, read from its address ("love-wins-all-season-2-2026" is 2). */
export function seasonOfPage(url) {
  const m = /-season-(\d{1,3})(?:-|$)/.exec(new URL(url).pathname);
  return m ? Number(m[1]) : 1;
}

/** The episodes a title's page lists under "All Episodes": [{ episode, url }], as the page orders them. */
export function parseEpisodes(html, origin = ORIGIN) {
  const start = html.indexOf('id="all-episodes"');
  const end = html.indexOf('<!--all-episodes-->', start);
  if (start === -1 || end === -1) return [];
  const episodes = [];
  for (const m of html.slice(start, end).matchAll(/<a href=(['"])([^'"]+)\1 title=(['"])(.*?)\3/g)) {
    const number = /\bEpisode\s+(\d{1,5})$/i.exec(decodeEntities(m[4]).trim());
    const pathname = pathOnSite(decodeEntities(m[2]), origin, EPISODE_PATH);
    if (number && pathname !== null) episodes.push({ episode: Number(number[1]), url: `${origin}${pathname}` });
  }
  return episodes;
}

const text = (html) => decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * What a title's own page says of it: { poster_url, overview, country, status, year, genres,
 * also_known }, each null (or []) when the page does not say. For a title TMDB does not list, this
 * is all there is to show of it.
 */
export function parseDetails(html, origin = ORIGIN) {
  const block = /<p class="([a-z-]+)">([\s\S]*?)<\/p>/g;
  const said = {};
  for (const m of html.matchAll(block)) said[m[1]] = m[2];
  const poster = /<figure class="drama-thumbnail">[\s\S]*?<img[^>]*\bdata-original="([^"]+)"/.exec(html);
  let posterUrl = null;
  try {
    const url = poster ? new URL(decodeEntities(poster[1]), origin) : null;
    if (url && url.protocol === 'https:') posterUrl = url.href;
  } catch {}
  const synopsis = /<div class="synopsis">([\s\S]*?)<\/div>/.exec(html);
  const overview = synopsis ? text(synopsis[1]).replace(/^Synopsis:\s*/i, '') : '';
  const known = /<span>Also known as:\s*<\/span>([\s\S]*?)<\/p>/.exec(html);
  const value = (name, label) => (said[name] === undefined ? null : text(said[name]).replace(label, '').trim() || null);
  const year = value('release-year', /^Release Year:/i);
  const genres = value('genres', /^Genres:/i);
  return {
    poster_url: posterUrl,
    overview: overview === '' ? null : overview,
    country: value('country', /^Country:/i),
    status: value('status', /^Status:/i),
    year: year !== null && /^\d{4}$/.test(year) ? Number(year) : null,
    genres: genres === null ? [] : genres.split(',').map((g) => g.trim()).filter(Boolean),
    also_known: known ? text(known[1]) || null : null,
  };
}

/** On the episode page: wait for the player's frame and say where it points. */
export const FIND_FRAME_EXPRESSION = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let frame;
  while (!((frame = document.querySelector(${JSON.stringify(PLAYER_FRAME)})) && /^https:/.test(frame.src)) && Date.now() - t0 < 10000) await sleep(300);
  return { url: location.href, frame: frame && /^https:/.test(frame.src) ? frame.src : null, visible: document.visibilityState === 'visible' };
})()`;

// Inside the player's frame: the second frame, of the same host, that holds the JW Player.
const INNER_FRAME = '#embedvideo';
// The host gives both a size in pixels once, at load. These follow the frame when it is stretched.
const OUTER_FILL_CSS = `html{overflow:hidden!important}${INNER_FRAME}{display:block!important;width:100vw!important;height:100vh!important}`;
const INNER_FILL_CSS = '.jwplayer{width:100vw!important;height:100vh!important}';

/**
 * Inside the player's frame: press the player's own play button while the episode is not running,
 * and answer once it is. The frame of the page being left may still answer for a moment, so its
 * address is checked first. The adverts the player's host lays over it are left alone: their
 * "Close" opens an advertising page, in this tab too. A press counts as the user's only for a few
 * seconds after the expression starts, so this is asked again from outside instead of waiting
 * long in here.
 */
export function startPlayerExpression(frameUrl) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.href !== ${JSON.stringify(frameUrl)}) return { playing: false, stage: 'other_frame' };
  const playerDocument = () => {
    const inner = document.querySelector(${JSON.stringify(INNER_FRAME)});
    let doc = null;
    try { doc = inner && inner.contentDocument; } catch {}
    return doc && doc.querySelector('.jwplayer') ? doc : null;
  };
  const follow = (doc, css) => {
    if (doc.getElementById('notesd-stream-fill')) return;
    const style = doc.createElement('style');
    style.id = 'notesd-stream-fill';
    style.textContent = css;
    doc.head.appendChild(style);
  };
  const t0 = Date.now();
  let state = null;
  let pressed = 0;
  while (Date.now() - t0 < 9000) {
    const doc = playerDocument();
    const video = doc && doc.querySelector('video');
    const button = doc && doc.querySelector('.jw-icon-display');
    state = { stage: !doc ? 'loading' : video && video.duration > 0 ? 'film' : 'play_button', visible: document.visibilityState === 'visible' };
    if (video && video.duration > 60 && !video.paused && video.currentTime > 0) {
      follow(document, ${JSON.stringify(OUTER_FILL_CSS)});
      follow(doc, ${JSON.stringify(INNER_FILL_CSS)});
      return { playing: true, position_s: Math.round(video.currentTime), duration_s: Math.round(video.duration), muted: video.muted };
    }
    if (button && video && video.paused && Date.now() - pressed > 3000) { button.click(); pressed = Date.now(); }
    await sleep(500);
  }
  return { playing: false, ...state };
})()`;
}

/** A pattern for cdp.ps1's -FrameMatch that finds the frame of one address by its host. */
export function frameMatchOf(frameUrl) {
  return new URL(frameUrl).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  name: 'dramacool',
  label: 'dramacool (dramacool9.com.ro)',
  origin: ORIGIN,
  originEnv: 'DRAMACOOL_ORIGIN',
  playerSelector: PLAYER_FRAME,

  // An episode's page; a title's page lists its episodes, so it is a link and nothing more.
  titlePath: (url) => pathOnSite(url, ORIGIN, EPISODE_PATH),

  /**
   * The episode of that number a title's page lists: [{ season, episode, name, has_video, url }],
   * one or none. The address is the one the page links; nothing is guessed. A title is one season
   * (a later one is its own title), so a season asked for that is not the page's finds nothing.
   */
  async episodes(titleUrl, { season, episode }) {
    if (pathOnSite(titleUrl, ORIGIN, TITLE_PATH) === null) throw new Error(`not a title page on ${ORIGIN}: ${titleUrl}`);
    const pageSeason = seasonOfPage(titleUrl);
    if (season !== null && season !== pageSeason) return [];
    return parseEpisodes(await get(titleUrl))
      .filter((hit) => hit.episode === episode)
      .slice(0, 1)
      .map((hit) => ({ season: pageSeason, episode: hit.episode, name: null, has_video: true, url: hit.url }));
  },

  /** What the title's own page says of it (parseDetails). Throws for an address that is not a title page on the site. */
  async details(titleUrl) {
    if (pathOnSite(titleUrl, ORIGIN, TITLE_PATH) === null) throw new Error(`not a title page on ${ORIGIN}: ${titleUrl}`);
    return parseDetails(await get(titleUrl));
  },

  async search(query) {
    // The site's own search page; its first page (20 titles) is read.
    const html = await get(`${ORIGIN}/?s=${encodeURIComponent(query.name).replace(/%20/g, '+')}`);
    return parseSearch(html).map((item) => toResult(item)).filter(Boolean);
  },

  async start({ evalPage, sleep, pathname }) {
    // The old page may still answer for a moment while the new one loads. And now and then the
    // site's advertising sends the tab to an advert's address in place of the episode: the site's
    // tab is then a new one on another page, and the episode is asked for again, as a person
    // would go back and click it again.
    let page = null;
    const onEpisode = () => page?.url !== undefined && new URL(page.url).pathname === pathname;
    for (let attempt = 0; attempt < 6 && !(page?.frame && onEpisode()); attempt++) {
      if (attempt > 0) await sleep(1500);
      page = await evalPage(FIND_FRAME_EXPRESSION, { show: true, timeoutS: 30 }).catch(() => null);
      if (page !== null && !onEpisode() && attempt >= 1) {
        await evalPage(`location.assign(${JSON.stringify(pathname)}); 'ok'`, { show: true, closeOtherTabs: true }).catch(() => null);
      }
    }
    if (!page?.frame || !onEpisode()) return { playing: false, stage: 'no_player' };
    // The frame loads after the page, and one press is not always enough. Ask until it runs.
    const expression = startPlayerExpression(page.frame);
    const frameMatch = frameMatchOf(page.frame);
    let last = { playing: false, stage: 'loading' };
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        last = await evalPage(expression, { frameMatch, show: true, timeoutS: 30 });
        if (last?.playing) return last;
        if (last?.stage === 'other_frame') await sleep(1500);
      } catch (err) {
        if (!(err instanceof ChromeError && err.code === 'no_frame')) throw err;
        last = { playing: false, stage: 'no_player' };
        await sleep(1500);
      }
    }
    return last;
  },
};
