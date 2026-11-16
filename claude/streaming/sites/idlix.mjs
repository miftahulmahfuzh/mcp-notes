// idlix (z2.idlixku.com). Cloudflare answers 403 to every client but a real browser, so even the
// search runs inside the streaming Chrome. Selectors and endpoints as the site had them on
// 2026-11-15.
import { evaluateInChrome } from '../chrome.mjs';
import { pathOnSite } from '../match.mjs';

/** The site moves between hosts (z1, z2, ...); IDLIX_ORIGIN names the current one. */
const ORIGIN = (process.env.IDLIX_ORIGIN ?? 'https://z2.idlixku.com').replace(/\/+$/, '');

const SEARCH_LIMIT = 20;
// contentType -> the first path segment of the title's page.
const PATH_BY_TYPE = { movie: 'movie', tv_series: 'series' };

const FRAME = '.hero-player-frame';
const HERO_BUTTON = `[...document.querySelectorAll('button')].find((b) => /absolute inset-0/.test(b.className) && /cursor-pointer/.test(b.className))`;

/** The expression evaluated in the tab: the search request the site's own modal makes. */
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
export function toResult(item, origin = ORIGIN) {
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

const EPISODE_PROBES_AT_ONCE = 6;

/**
 * The expression evaluated in the tab: which episodes of a series the site has under one episode
 * number. The site's own API is asked, the way its episode page asks it
 * (/api/series/<slug>/season/<s>/episode/<n>: 200 with the episode, 404 without). With a season
 * only that one is asked; without, every season the series lists, since a long anime's episode
 * numbers run on across seasons (One Piece 787 is in season 18) and only the site knows where.
 */
export function episodeExpression(slug, season, episode) {
  return `(async () => {
  const get = async (path) => {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  };
  const slug = ${JSON.stringify(slug)};
  let seasons = ${season === null ? 'null' : JSON.stringify([season])};
  let status = 200;
  if (seasons === null) {
    const series = await get('/api/series/' + slug);
    status = series.status;
    seasons = series.body && Array.isArray(series.body.seasons) ? series.body.seasons.map((s) => s.seasonNumber).filter((n) => Number.isInteger(n)) : [];
  }
  const hits = [];
  for (let i = 0; i < seasons.length; i += ${EPISODE_PROBES_AT_ONCE}) {
    await Promise.all(seasons.slice(i, i + ${EPISODE_PROBES_AT_ONCE}).map(async (s) => {
      const found = await get('/api/series/' + slug + '/season/' + s + '/episode/' + ${JSON.stringify(episode)});
      if (found.status !== 200 && found.status !== 404) status = found.status;
      const e = found.body && found.body.episode;
      if (found.status === 200 && e) hits.push({ season: s, episode: e.episodeNumber, name: e.name || null, has_video: e.hasVideo !== false });
    }));
  }
  return { status, title: document.title, hits: hits.sort((a, b) => a.season - b.season) };
})()`;
}

/** The slug of a series page on the site, or null for any other address. */
export function seriesSlug(url, origin = ORIGIN) {
  const pathname = pathOnSite(url, origin, /^\/series\/[a-z0-9-]+$/);
  return pathname === null ? null : pathname.slice('/series/'.length);
}

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

export default {
  name: 'idlix',
  label: 'idlix',
  origin: ORIGIN,
  originEnv: 'IDLIX_ORIGIN',
  playerSelector: FRAME,

  titlePath: (url) => pathOnSite(url, ORIGIN, /^\/(movie|series)\/[a-z0-9-]+$/) ?? pathOnSite(url, ORIGIN, /^\/series\/[a-z0-9-]+\/season\/\d+\/episode\/\d+$/),

  /**
   * The episodes a series has under one episode number: [{ season, episode, name, has_video, url }],
   * one per season that has it. The address is the series page the search returned plus the season
   * and episode the site's own API confirmed; nothing is guessed.
   */
  async episodes(seriesUrl, { season, episode }) {
    const slug = seriesSlug(seriesUrl);
    if (slug === null) throw new Error(`not a series page on ${ORIGIN}: ${seriesUrl}`);
    const value = await evaluateInChrome(ORIGIN, episodeExpression(slug, season, episode));
    if (!value || value.status !== 200 || !Array.isArray(value.hits)) {
      throw new Error(`the site answered HTTP ${value?.status ?? '?'} (page title: ${value?.title ?? '?'})`);
    }
    return value.hits.map((hit) => ({ ...hit, url: `${ORIGIN}/series/${slug}/season/${hit.season}/episode/${hit.episode}` }));
  },

  async search(query) {
    const value = await evaluateInChrome(ORIGIN, searchExpression(query.name));
    if (!value || value.status !== 200 || value.results === null) {
      throw new Error(`the site answered HTTP ${value?.status ?? '?'} (page title: ${value?.title ?? '?'})`);
    }
    return value.results.map((item) => toResult(item)).filter(Boolean);
  },

  async start({ evalPage, sleep, pathname }) {
    // The old page may still answer for a moment while the new one loads.
    let clicked = null;
    for (let attempt = 0; attempt < 4 && !(clicked?.url?.endsWith(pathname) && (clicked.clicked || clicked.player)); attempt++) {
      if (attempt > 0) await sleep(1500);
      clicked = await evalPage(CLICK_PLAY_EXPRESSION, { show: true, timeoutS: 30 }).catch(() => null);
    }
    if (!clicked?.clicked && !clicked?.player) return { playing: false, error: 'the page has no play button' };
    // The click opens an advertising tab in front of the page, and the countdown stops behind it.
    await sleep(1500);
    return evalPage(WAIT_FOR_FILM_EXPRESSION, { show: true, closeOtherTabs: true, timeoutS: 75 });
  },
};
