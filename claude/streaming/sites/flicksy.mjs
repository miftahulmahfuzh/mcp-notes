// flicksy (flicksy.pro). The site answers a plain request, so the search needs no browser; only
// playing does. Its search box asks the site's own TMDB pass-through, and a title's page is named
// by its TMDB id. The film plays inside a frame from another host (FrameXTV, the site's first
// server). Selectors and endpoints as the site had them on 2026-11-17.
import { ChromeError } from '../chrome.mjs';
import { pathOnSite } from '../match.mjs';

/** FLICKSY_ORIGIN names the current host, should the site move. */
const ORIGIN = (process.env.FLICKSY_ORIGIN ?? 'https://flicksy.pro').replace(/\/+$/, '');

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TIMEOUT_MS = 30_000;

// The frame on the watch page, and the host of the player inside it.
const PLAYER_FRAME = 'iframe.player';
const FRAME_MATCH = 'framextv';

/** One search result as the skill reports it; null for a person or a result without an id. */
export function toResult(item, origin = ORIGIN) {
  const kind = item.media_type === 'movie' ? 'movie' : item.media_type === 'tv' ? 'series' : null;
  const name = kind === 'movie' ? item.title : item.name;
  if (kind === null || !Number.isInteger(item.id) || item.id <= 0 || typeof name !== 'string' || name === '') return null;
  const date = (kind === 'movie' ? item.release_date : item.first_air_date) ?? '';
  const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
  const original = kind === 'movie' ? item.original_title : item.original_name;
  return {
    title: year === null ? name : `${name} (${year})`,
    name,
    original_name: typeof original === 'string' && original !== '' && original !== name ? original : null,
    year,
    kind,
    quality: null,
    seasons: null,
    // A film's address is its player page; a series' is its own page, which lists the episodes.
    url: kind === 'movie' ? `${origin}/watch/movie/${item.id}` : `${origin}/series/${item.id}`,
  };
}

/**
 * Inside the player's frame: press the player's own play button while the film is not running,
 * and answer once it is. The frame of the page being left may still answer for a moment, so the
 * film's id is checked first. A press counts as the user's only for a few seconds after the
 * expression starts, so this is asked again from outside instead of waiting long in here.
 */
export function startPlayerExpression(id) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.pathname !== ${JSON.stringify(`/embed/${id}`)}) return { playing: false, stage: 'other_frame' };
  const t0 = Date.now();
  let state = null;
  let pressed = 0;
  while (Date.now() - t0 < 9000) {
    const video = document.querySelector('video');
    const button = document.querySelector('button[aria-label="Play Stream"]');
    state = { stage: video ? 'film' : 'loading', visible: document.visibilityState === 'visible' };
    if (video && video.duration > 60 && !video.paused && video.currentTime > 0) {
      return { playing: true, position_s: Math.round(video.currentTime), duration_s: Math.round(video.duration), muted: video.muted };
    }
    if (button && video && video.paused && Date.now() - pressed > 3000) { button.click(); pressed = Date.now(); }
    await sleep(500);
  }
  return { playing: false, ...state };
})()`;
}

export default {
  name: 'flicksy',
  label: 'flicksy (flicksy.pro)',
  origin: ORIGIN,
  originEnv: 'FLICKSY_ORIGIN',
  playerSelector: PLAYER_FRAME,

  // A film's player page; a series has episodes to choose from, so it is a link and nothing more.
  titlePath: (url) => pathOnSite(url, ORIGIN, /^\/watch\/movie\/\d+$/),

  async search(query) {
    const url = `${ORIGIN}/api/tmdb/search/multi?query=${encodeURIComponent(query.name)}&include_adult=false`;
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    const body = await res.json();
    return (Array.isArray(body.results) ? body.results : []).map((item) => toResult(item)).filter(Boolean);
  },

  async start({ evalPage, sleep, pathname }) {
    // The frame loads after the page, so it may not be there yet, or still be the last film's.
    const expression = startPlayerExpression(pathname.split('/').pop());
    let last = { playing: false, stage: 'loading' };
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        last = await evalPage(expression, { frameMatch: FRAME_MATCH, show: true, timeoutS: 30 });
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
