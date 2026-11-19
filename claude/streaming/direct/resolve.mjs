// Resolving a film or an episode: try providers in order, open each embed with the sniffer, and
// keep the first one that loaded a stream in the title's original language. Pure apart from the
// injected sniffer and audio probe.
import { ChromeError } from '../chrome.mjs';
import { isOriginalAudio } from './audio.mjs';
import { normalizeLang } from './lang.mjs';
import { orderProviders } from './order.mjs';

export const OUTCOMES = Object.freeze(['resolved', 'no_stream', 'bot_check', 'error', 'dubbed', 'skipped_browser_only', 'skipped_no_template']);

/** Failures that would hit every provider the same way: stop instead of trying the rest. */
const ABORTS = new Set(['no_chrome', 'chrome_not_reachable']);
/** After a stream without a subtitle was found for a title that is not in English, this many more providers are asked for one with it. */
export const SUBTITLE_EXTRA_TRIES = 4;

/**
 * How well a stream's subtitles serve a viewer who reads English: 0 an English track (its own or
 * one borrowed from a dub), 1 exactly one track that names no language (the player shows it by
 * default: a provider that hands out one unnamed file means it for the viewer), 2 nothing to show.
 */
export function subtitleRank(subtitles) {
  if (subtitles.some(isEnglish)) return 0;
  const [only] = subtitles;
  return subtitles.length === 1 && (only.lang ?? null) === null && (only.label ?? '') === '' ? 1 : 2;
}
const NO_OPTIONS = Object.freeze({});
const SUBTITLE_EXT = /\.(vtt|srt)$/i;

/**
 * The embed address for a title, or null when the provider has no template for its kind. A
 * provider keyed by AniList id (`id_kind: "anilist"`, an anime embed) takes `ref.anime`
 * ({ id, episode }: the AniList id and the episode as AniList counts it) and has no address for a
 * title without one.
 */
export function embedUrl(provider, ref) {
  const template = ref.kind === 'movie' ? provider.movie : provider.tv;
  if (!template) return null;
  if (provider.id_kind === 'anilist') {
    if (!ref.anime) return null;
    return template.replaceAll('{id}', String(ref.anime.id)).replaceAll('{episode}', String(ref.anime.episode));
  }
  return template
    .replaceAll('{id}', String(ref.tmdbId))
    .replaceAll('{season}', String(ref.season ?? ''))
    .replaceAll('{episode}', String(ref.episode ?? ''));
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function dirOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/[^/]*$/, '');
  } catch {
    return null;
  }
}

function absolute(address, base) {
  try {
    return new URL(address, base).href;
  } catch {
    return null;
  }
}

const okStatus = (hit) => typeof hit.status === 'number' && hit.status >= 200 && hit.status < 300;

/** hls, dash or mp4 for a hit that is a stream, else null. The body decides first. */
export function manifestKind(hit) {
  const body = typeof hit.body === 'string' ? hit.body.trimStart() : '';
  if (body.startsWith('#EXTM3U')) return 'hls';
  if (/<MPD[\s>]/.test(body.slice(0, 4000))) return 'dash';
  const mime = String(hit.mime ?? '').toLowerCase();
  // A page is never a stream, whatever its address ends in: a provider that is down answers its
  // `demo-video.mp4` with an HTML page (VidRock, 2026-11-15), and playing it ends in a media error.
  if (mime.startsWith('text/html')) return null;
  const file = pathOf(hit.url);
  if (mime.includes('mpegurl') || /\.m3u8$/i.test(file)) return 'hls';
  if (mime.includes('dash+xml') || /\.mpd$/i.test(file)) return 'dash';
  if (mime.startsWith('video/mp4') || /\.mp4$/i.test(file)) return 'mp4';
  return null;
}

function rank(hit, kind) {
  if (kind === 'dash') return 0;
  if (kind === 'hls') return typeof hit.body === 'string' && hit.body.includes('#EXT-X-STREAM-INF') ? 0 : 1;
  return 2;
}

/** HLS attribute list: KEY=value or KEY="value", comma separated. */
function attributes(text) {
  const out = {};
  for (const m of text.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) out[m[1]] = m[3] ?? m[2];
  return out;
}

function xmlAttr(text, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? null;
}

function hlsSubtitles(body, base) {
  const tracks = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = attributes(line.slice('#EXT-X-MEDIA:'.length));
    if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;
    const url = absolute(a.URI, base);
    if (url) tracks.push({ url, lang: a.LANGUAGE ?? null, label: a.NAME ?? null, format: 'hls', source: 'manifest' });
  }
  return tracks;
}

function dashSubtitles(body, base) {
  const tracks = [];
  for (const m of body.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const mime = xmlAttr(attrs, 'mimeType') ?? xmlAttr(inner, 'mimeType') ?? '';
    const isText = xmlAttr(attrs, 'contentType') === 'text' || /^(text\/vtt|application\/ttml\+xml)/.test(mime);
    if (!isText) continue;
    const baseUrl = /<BaseURL>([^<]+)<\/BaseURL>/.exec(inner)?.[1];
    const url = baseUrl ? absolute(baseUrl.trim().replace(/&amp;/g, '&'), base) : null;
    if (!url) continue;
    const format = mime.startsWith('application/ttml') ? 'ttml' : mime.startsWith('text/vtt') ? 'vtt' : 'dash';
    tracks.push({ url, lang: xmlAttr(attrs, 'lang'), label: /<Label>([^<]*)<\/Label>/.exec(inner)?.[1] ?? null, format, source: 'manifest' });
  }
  return tracks;
}

function guessLang(url) {
  let text;
  try {
    text = decodeURIComponent(url).toLowerCase();
  } catch {
    text = url.toLowerCase();
  }
  return /(?:^|[^a-z])(en|eng|english)(?:[^a-z]|$)/.test(text) ? 'en' : null;
}

/** `vtt` or `srt` when the address names such a file anywhere, also as a relay's parameter (fetch?url=...%2Fx.vtt&ref=...). */
function subtitleExtIn(url) {
  let text = url;
  try {
    text = decodeURIComponent(url);
  } catch {
    // keep the address as written
  }
  return /\.(vtt|srt)(?:[?&#]|$)/i.exec(text)?.[1]?.toLowerCase() ?? null;
}

/**
 * The subtitle files a page's subtitle service listed (the sniffer's SubtitleIndex hits: a JSON
 * array such as sub.vdrk.site's [{ label, file }] or sub.wyzie.io's [{ url, display, language }]).
 * A page loads a file only once the viewer picks its language, so the list is where they show.
 */
export function indexSubtitles(hits) {
  const tracks = [];
  for (const hit of hits) {
    if (hit.type !== 'SubtitleIndex' || typeof hit.body !== 'string') continue;
    let list;
    try {
      list = JSON.parse(hit.body);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const entry of list.slice(0, 80)) {
      const url = entry?.url ?? entry?.file;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      const label = [entry.label, entry.display, entry.lang, entry.language].find((v) => typeof v === 'string' && v.trim() !== '') ?? null;
      const lang = typeof entry.language === 'string' && /^[a-z]{2,3}$/i.test(entry.language) ? entry.language.toLowerCase() : label !== null && /english/i.test(label) ? 'en' : null;
      tracks.push({ url, lang, label, format: subtitleExtIn(url) ?? (typeof entry.format === 'string' ? entry.format.toLowerCase() : 'vtt'), source: 'request' });
    }
  }
  return tracks;
}

/**
 * A player's seek-preview file: WebVTT whose cues are picture addresses (thumbs/sprite-001.jpg#xywh=160,0,160,90),
 * not words. Shown as a subtitle it prints those addresses over the film. Told by its name
 * (thumbs.vtt, thumbnails/…, sprite, storyboard) or, when the sniffer kept the body, by its cues.
 */
export function isThumbnailTrack(hit) {
  if (typeof hit.body === 'string' && /#xywh=\d+,\d+,\d+,\d+/.test(hit.body)) return true;
  let path = pathOf(String(hit.url ?? ''));
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the path as written
  }
  return /(?:^|[\/_.-])(?:thumbs?|thumbnails?|sprites?|storyboards?)(?:[\/_.-]|$)/i.test(path);
}

function requestSubtitles(hits, skipDirs) {
  const tracks = [];
  for (const hit of hits) {
    if (typeof hit.status === 'number' && !okStatus(hit)) continue;
    if (!/^https?:\/\//.test(String(hit.url ?? ''))) continue;
    const ext =
      SUBTITLE_EXT.exec(pathOf(hit.url))?.[1]?.toLowerCase() ??
      (/^text\/vtt/i.test(String(hit.mime ?? '')) ? 'vtt' : null) ??
      subtitleExtIn(hit.url) ??
      (hit.type === 'TextTrack' ? 'vtt' : null);
    if (!ext) continue;
    if (ext === 'vtt' && skipDirs.has(dirOf(hit.url))) continue;
    if (ext === 'vtt' && isThumbnailTrack(hit)) continue;
    tracks.push({ url: hit.url, lang: guessLang(hit.url), label: null, format: ext, source: 'request' });
  }
  return tracks;
}

/** An English track: lang en / eng / english (any region), or a label that says English. */
export function isEnglish(track) {
  const lang = String(track.lang ?? '').toLowerCase();
  return /^(en|eng|english)([-_].*)?$/.test(lang) || /english/i.test(String(track.label ?? ''));
}

function bestHeight(hit, kind) {
  const body = typeof hit.body === 'string' ? hit.body : '';
  const pattern = kind === 'hls' ? /RESOLUTION=\d+x(\d+)/g : kind === 'dash' ? /\bheight="(\d+)"/g : null;
  if (pattern === null) return null;
  let best = null;
  for (const m of body.matchAll(pattern)) {
    const height = Number(m[1]);
    if (best === null || height > best) best = height;
  }
  return best;
}

/** The capture's stream request: `{ hit, kind }`, or null when it holds none. */
function bestHit(sniff) {
  const hits = Array.isArray(sniff?.hits) ? sniff.hits : [];
  let best = null;
  for (const hit of hits) {
    if (!okStatus(hit)) continue;
    const kind = manifestKind(hit);
    if (kind === null) continue;
    // An answer Chrome kept that is no playlist (a relay's error page, a bare list of addresses) cannot be played.
    if (kind === 'hls' && typeof hit.body === 'string' && hit.body.trim() !== '' && !hit.body.trimStart().startsWith('#EXTM3U')) continue;
    const r = rank(hit, kind);
    if (best === null || r < best.rank) best = { hit, kind, rank: r };
  }
  return best;
}

/** The text of the manifest pickSource chose ('' when the capture kept none): the audio probe reads it. */
export function manifestBody(sniff) {
  const body = bestHit(sniff)?.hit.body;
  return typeof body === 'string' ? body : '';
}

/**
 * The stream in one capture: the manifest, the headers its request carried, the subtitle tracks
 * seen, the best height. Null when the capture holds no stream.
 */
export function pickSource(sniff) {
  const hits = Array.isArray(sniff?.hits) ? sniff.hits : [];
  const best = bestHit(sniff);
  if (best === null) return null;
  const { hit, kind } = best;
  const body = typeof hit.body === 'string' ? hit.body : '';
  const inManifest = kind === 'hls' ? hlsSubtitles(body, hit.url) : kind === 'dash' ? dashSubtitles(body, hit.url) : [];
  const skipDirs = new Set(inManifest.filter((t) => t.format === 'hls').map((t) => dirOf(t.url)));
  const seen = new Set();
  const subtitles = [...inManifest, ...requestSubtitles(hits, skipDirs), ...indexSubtitles(hits)].filter((t) => (seen.has(t.url) ? false : (seen.add(t.url), true)));
  return {
    manifest_url: hit.url,
    manifest_kind: kind,
    headers: { referer: hit.referer ?? null, origin: hit.origin ?? null, user_agent: hit.user_agent ?? sniff.user_agent ?? null },
    subtitles,
    best_height: bestHeight(hit, kind),
    en_subtitle: subtitles.some(isEnglish),
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** The numbers an address names, one per part of its path and query: 3 for `3`, `03`, `e3` or `episode=3`, 2 and 3 for `s02e03`. */
function numbersIn(parts) {
  const out = [];
  for (const part of parts) {
    const both = /^s(\d{1,4})e(\d{1,4})$/i.exec(part);
    if (both) out.push(Number(both[1]), Number(both[2]));
    const one = /^(?:s|e|ep|season|episode)?(\d{1,9})$/i.exec(part);
    if (one) out.push(Number(one[1]));
  }
  return out;
}

/**
 * The host of a whole-series player an episode's stream came from, or null. A provider that does
 * not have the episode asked may fall back to a second player in a nested frame that is given the
 * series alone (NexaStream, 2026-11-19: `.../play/tt0903747` for Breaking Bad S01E99) and plays
 * whatever that player starts with. Such a stream is another episode, so it is no stream. Told by
 * the frame the manifest's request came from (its Referer): its address names the title (the TMDB
 * id, or an IMDb id) and not both the season and the episode. A frame whose address names no
 * title (an opaque token) says nothing and is kept.
 */
export function seriesPlayerFrame(sniff, source, ref) {
  if (ref.kind !== 'tv' || ref.season == null || ref.episode == null) return null;
  const from = hostOf(source?.headers?.referer ?? '');
  if (from === '') return null;
  const frames = (Array.isArray(sniff?.frames) ? sniff.frames : [])
    .map(String)
    .filter((f) => f.startsWith('iframe '))
    .map((f) => f.slice('iframe '.length))
    .filter((url) => hostOf(url) === from);
  if (frames.length === 0) return null;
  const wholeSeries = (url) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const parts = `${parsed.pathname}&${parsed.search}`.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const title = parts.findIndex((part) => part === String(ref.tmdbId) || /^tt\d{5,}$/i.test(part));
    if (title === -1) return false;
    const numbers = numbersIn(parts.filter((_, index) => index !== title));
    const season = numbers.indexOf(Number(ref.season));
    if (season === -1) return true;
    numbers.splice(season, 1);
    return !numbers.includes(Number(ref.episode));
  };
  return frames.every(wholeSeries) ? from : null;
}

const seconds = (ms) => Math.round(ms / 100) / 10;
const attempt = (provider, outcome, tookS, detail) => ({ provider: provider.name, outcome, took_s: tookS, detail });

function describe(found) {
  const height = found.best_height ? ` ${found.best_height}p` : '';
  const english = found.en_subtitle ? ', English' : '';
  return `${found.manifest_kind}${height}, ${found.subtitles.length} subtitle track(s)${english}`;
}

/**
 * Resolves a title: providers in the D1 order, the first stream wins. `ref` is
 * { kind: 'movie' | 'tv', tmdbId, season, episode }, already validated. `sniff(url, options)` is
 * the sniffer (sniffEmbed in use, a fake in tests); every call gets the same options object.
 * `first` (null: none) names the provider tried before every other while it keeps working (order.mjs).
 * `deadlineS` (null: none): once that many seconds have passed, no further provider is sniffed and
 * the answer is `error: "deadline"` (it says nothing about the title).
 *
 * `audioLang` is the title's original language (TMDB's code, "ko"); with it and `probeAudio`
 * (audio.mjs in use, a fake in tests) a stream that speaks only other languages is a dub: its
 * provider is recorded as `dubbed` and the next one is tried. A stream whose language nothing
 * names is kept. The source carries `audio: { languages, tracks, original, track }`.
 *
 * A dub's separate English subtitle files are not thrown away: when the stream that is kept has
 * no English subtitle of its own, they are added to its tracks with `borrowed_from` naming the
 * provider (the same episode, so the timing fits), and `en_subtitle` stays the provider's own.
 *
 * A title that is not in English is not worth much without a subtitle. When its first stream has
 * no English track, the stream is held and up to SUBTITLE_EXTRA_TRIES more providers are asked:
 * the first with an English track, or with a single unnamed file (the player shows that one by
 * default), wins; else the held stream plays. Its attempt says `held`. Once a stream is held, a
 * provider that was tried on this machine and never gave a stream is not asked. `--only`
 * and an English or unknown original language take the first stream, as before. When the provider
 * with the English track has the shorter picture (a 960p cinema recording after a 1080p stream),
 * the held stream plays and takes that provider's English subtitle file (`borrowed_from`).
 */
export async function resolveTitle(
  ref,
  { providers, health = {}, sniff, only = null, skip = [], first = null, sniffOptions = NO_OPTIONS, clock = () => performance.now(), deadlineS = null, audioLang = null, probeAudio = null },
) {
  const base = { kind: ref.kind, tmdb_id: ref.tmdbId, season: ref.season ?? null, episode: ref.episode ?? null };
  let candidates = orderProviders(providers, health, { first });
  // An anime goes to the anime embeds first: they are asked for the original audio with English subtitles.
  if (ref.anime) candidates = [...candidates.filter((p) => p.id_kind === 'anilist'), ...candidates.filter((p) => p.id_kind !== 'anilist')];
  // A session that left a provider because its stream stalled asks for another one.
  if (skip.length > 0) {
    const left = new Set(skip.map((name) => name.toLowerCase()));
    candidates = candidates.filter((p) => !left.has(p.name.toLowerCase()));
  }
  if (only !== null) {
    candidates = candidates.filter((p) => p.name.toLowerCase() === only.toLowerCase());
    if (candidates.length === 0) return { ok: false, ...base, source: null, error: 'unknown_provider', detail: `no provider named ${only}`, attempts: [] };
  }
  const attempts = [];
  /** English subtitle files seen at providers skipped as dubs. */
  const spare = [];
  /** The best stream found so far that has no English subtitle, while a few more providers are asked. */
  let held = null;
  let extraTries = 0;
  const wantsSubtitle = only === null && audioLang !== null && normalizeLang(audioLang) !== 'en';
  const begun = clock();
  for (const [index, provider] of candidates.entries()) {
    if (provider.browser_only) {
      attempts.push(attempt(provider, 'skipped_browser_only', 0, 'plays only inside its own page'));
      continue;
    }
    const url = embedUrl(provider, ref);
    if (url === null) {
      attempts.push(attempt(provider, 'skipped_no_template', 0, provider.id_kind === 'anilist' ? 'an anime embed, and this title has no AniList id' : `no ${ref.kind} template`));
      continue;
    }
    if (held !== null && extraTries >= SUBTITLE_EXTRA_TRIES) break;
    // With a stream in hand, a provider that was tried on this machine and never gave one is not worth the wait.
    if (held !== null && Object.hasOwn(health, provider.name) && !health[provider.name]?.last_success_at) continue;
    if (deadlineS !== null && clock() - begun >= deadlineS * 1000) {
      if (held !== null) break;
      const left = candidates.length - index;
      return { ok: false, ...base, source: null, error: 'deadline', detail: `stopped after ${seconds(clock() - begun)} s; ${left} provider(s) not tried`, attempts };
    }
    const started = clock();
    if (held !== null) extraTries += 1;
    let sniffed;
    try {
      sniffed = await sniff(url, sniffOptions);
    } catch (err) {
      attempts.push(attempt(provider, 'error', seconds(clock() - started), String(err?.message ?? err)));
      if (err instanceof ChromeError && ABORTS.has(err.code)) {
        if (held !== null) break;
        return { ok: false, ...base, source: null, error: err.code, attempts };
      }
      continue;
    }
    const tookS = seconds(clock() - started);
    let found = pickSource(sniffed);
    const seriesPlayer = found && provider.id_kind !== 'anilist' ? seriesPlayerFrame(sniffed, found, ref) : null;
    if (seriesPlayer !== null) {
      // The provider's fallback for an episode it does not have: another episode of the series.
      attempts.push(attempt(provider, 'no_stream', tookS, `the stream came from ${seriesPlayer}, a whole-series player whose address names no episode`));
      found = null;
      continue;
    }
    if (found && provider.id_kind === 'anilist') {
      // The template asks the embed for its subtitled version (/sub): a track it names no language for is the English one.
      found.subtitles = found.subtitles.map((t) => (t.lang === null && t.label === null ? { ...t, lang: 'en', label: 'English' } : t));
      found.en_subtitle = found.subtitles.some(isEnglish);
    }
    if (found) {
      let audio = null;
      if (audioLang !== null && probeAudio !== null) {
        const heard = await probeAudio({ ...found, manifest_body: manifestBody(sniffed) });
        // The manifest's track in the original language, as written: the player picks it by these.
        const own = (heard.named ?? []).find((t) => t.language === normalizeLang(audioLang)) ?? null;
        audio = {
          languages: heard.languages,
          tracks: heard.tracks,
          original: isOriginalAudio(heard.languages, audioLang),
          track: own === null ? null : { lang: own.lang ?? null, label: own.label ?? null },
        };
        if (audio.original === false) {
          attempts.push(attempt(provider, 'dubbed', tookS, `audio is ${heard.languages.join(', ')}, the original is ${normalizeLang(audioLang)}`));
          for (const t of found.subtitles) {
            if (t.source === 'request' && isEnglish(t) && !spare.some((s) => s.url === t.url)) spare.push({ ...t, lang: t.lang ?? 'en', borrowed_from: provider.name });
          }
          continue;
        }
      }
      const heardAs = audio === null || audio.languages.length === 0 ? '' : `, audio ${audio.languages.join('/')}`;
      const borrowed = found.en_subtitle ? [] : spare;
      const lent = borrowed.length === 0 ? '' : `, English subtitle from ${[...new Set(borrowed.map((t) => t.borrowed_from))].join(', ')}`;
      const source = { provider: provider.name, embed_url: url, ...found, subtitles: [...found.subtitles, ...borrowed], audio, took_s: tookS };
      const rank = subtitleRank(source.subtitles);
      // A subtitle to show (English, or the single unnamed file the player shows by default) ends the search.
      if (!wantsSubtitle || (rank <= 1 && held === null)) {
        attempts.push(attempt(provider, 'resolved', tookS, `${describe(found)}${heardAs}${lent}`));
        return { ok: true, ...base, source, attempts };
      }
      if (rank <= 1 && held !== null) {
        // A stream with a subtitle, after one without. The better picture plays: this
        // one when it is at least as tall, else the held one with this one's subtitle file (the
        // same title, so the lines fit; the player's subtitle delay keys cover an offset).
        const file = source.subtitles.find((t) => t.source === 'request' && (rank === 1 || isEnglish(t))) ?? null;
        if (file === null || (source.best_height ?? 0) >= (held.source.best_height ?? 0)) {
          attempts.push(attempt(provider, 'resolved', tookS, `${describe(found)}${heardAs}${lent}`));
          return { ok: true, ...base, source, attempts };
        }
        attempts.push(attempt(provider, 'resolved', tookS, `${describe(found)}${heardAs}, shorter than ${held.source.provider}: its English subtitle is lent`));
        // The unnamed file keeps no language: alone on the held stream it is still the one the player shows.
        const lentFile = { ...file, ...(rank === 0 ? { lang: file.lang ?? 'en' } : {}), borrowed_from: provider.name };
        return { ok: true, ...base, source: { ...held.source, subtitles: [...held.source.subtitles, lentFile] }, attempts };
      }
      attempts.push(attempt(provider, 'resolved', tookS, `${describe(found)}${heardAs}, held: no English subtitle`));
      if (held === null || rank < held.rank) held = { source, rank };
      continue;
    }
    if (sniffed.bot_check) {
      attempts.push(attempt(provider, 'bot_check', tookS, sniffed.bot_check_reason ?? 'bot check'));
      continue;
    }
    const detail = `${sniffed.requests ?? 0} requests, ${sniffed.hits?.length ?? 0} media hits, ${sniffed.clicks ?? 0} clicks, ${sniffed.popups_closed ?? 0} advert tabs closed`;
    attempts.push(attempt(provider, 'no_stream', tookS, detail));
  }
  if (held !== null) return { ok: true, ...base, source: held.source, attempts };
  return { ok: false, ...base, source: null, error: 'no_source', attempts };
}
