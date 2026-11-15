// lk21 / LayarKaca21 (tv12.lk21official.cc). The site answers a plain request, so the search needs
// no browser; only playing does. The film plays inside a frame from another host, nested in a
// second one. Selectors and endpoints as the site had them on 2026-11-15.
import { ChromeError } from '../chrome.mjs';
import { pathOnSite } from '../match.mjs';

/** The site moves between hosts (tv11, tv12, ...); LK21_ORIGIN names the current one. */
const ORIGIN = (process.env.LK21_ORIGIN ?? 'https://tv12.lk21official.cc').replace(/\/+$/, '');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 30_000;

// The frame on the title page, and the innermost frame that holds the play button and the video.
const PLAYER_FRAME = '#main-player';
const INNER_FRAME_MATCH = 'playcdn';

async function get(url) {
  // The search host answers only a request that names the site as where it came from.
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, referer: `${ORIGIN}/` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

/** The host the home page's search box asks, read from <body data-search_url="...">. */
export function searchHost(homeHtml) {
  const m = /<body[^>]*\bdata-search_url=(['"])(https?:\/\/[^'"]+)\1/.exec(homeHtml);
  return m ? m[2].replace(/\/+$/, '') : null;
}

/**
 * "Love of Your Life (2026)", "La Brea (2021) - Series" and
 * "Just a Breath Away (Dans la brume) (2018)" -> the name, and the other name in brackets.
 */
export function splitTitle(title) {
  const bare = title.replace(/\s+-\s+Series$/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim();
  const alt = /^(.*\S)\s+\(([^()]+)\)$/.exec(bare);
  return alt ? { name: alt[1], original_name: alt[2] } : { name: bare, original_name: null };
}

/** One search result as the skill reports it; null when it has no page. */
export function toResult(item, origin = ORIGIN) {
  if (typeof item.slug !== 'string' || item.slug === '' || typeof item.title !== 'string') return null;
  const year = Number.isInteger(item.year) ? item.year : null;
  const kind = item.type === 'series' ? 'series' : 'movie';
  const { name, original_name } = splitTitle(item.title);
  return {
    title: year === null ? name : `${name} (${year})`,
    name,
    original_name,
    year,
    kind,
    quality: kind === 'movie' && item.quality ? item.quality : null,
    seasons: kind === 'series' && Number.isInteger(item.season) ? item.season : null,
    url: `${origin}/${item.slug}`,
  };
}

/**
 * Inside the player's frame: press its play button, then, while the film is not running, press
 * the player's own play again, and answer once the film is running. The first press only sets
 * the player up on some loads, and a press counts as the user's only for a few seconds after the
 * expression starts, so this is asked again from outside instead of waiting long in here.
 */
export const START_PLAYER_EXPRESSION = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let state = null;
  const button = document.querySelector('.custom-play-btn');
  if (button && getComputedStyle(button).display !== 'none') button.click();
  else if (typeof window.jwplayer === 'function') { try { window.jwplayer().play(); } catch {} }
  while (Date.now() - t0 < 9000) {
    const video = document.querySelector('video');
    state = { stage: video ? 'film' : document.querySelector('.custom-play-btn') ? 'play_button' : 'loading', visible: document.visibilityState === 'visible' };
    if (video && video.duration > 60 && !video.paused && video.currentTime > 0) {
      return { playing: true, position_s: Math.round(video.currentTime), duration_s: Math.round(video.duration), muted: video.muted };
    }
    await sleep(500);
  }
  return { playing: false, ...state };
})()`;

export default {
  name: 'lk21',
  label: 'lk21 (LayarKaca21)',
  origin: ORIGIN,
  originEnv: 'LK21_ORIGIN',
  playerSelector: PLAYER_FRAME,

  // A film's page; a series only forwards to another site, so it is a link and nothing more.
  titlePath: (url) => pathOnSite(url, ORIGIN, /^\/[a-z0-9-]+-\d{4}$/),

  async search(query) {
    const host = searchHost(await get(`${ORIGIN}/`));
    if (host === null) throw new Error('the home page no longer names its search host');
    const body = JSON.parse(await get(`${host}/search.php?s=${encodeURIComponent(query.name).replace(/%20/g, '+')}`));
    return (Array.isArray(body.data) ? body.data : []).map((item) => toResult(item)).filter(Boolean);
  },

  async start({ evalPage, sleep }) {
    // The frames load after the page, so the player's frame may not be there yet; and one press
    // is not always enough (see START_PLAYER_EXPRESSION). Ask until the film runs.
    let last = { playing: false, stage: 'loading' };
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        last = await evalPage(START_PLAYER_EXPRESSION, { frameMatch: INNER_FRAME_MATCH, show: true, timeoutS: 30 });
        if (last?.playing) return last;
      } catch (err) {
        if (!(err instanceof ChromeError && err.code === 'no_frame')) throw err;
        last = { playing: false, stage: 'no_player' };
        await sleep(1500);
      }
    }
    return last;
  },
};
