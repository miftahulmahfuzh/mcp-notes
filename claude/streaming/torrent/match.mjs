// What the torrent sites' rows are read with: the words a search asks for, which release names are
// the asked title, a size in bytes, a count, the row shape the CLI prints, and a magnet link's info
// hash and trackers. Shared by sites/*.mjs and cli.mjs.
import { normalizeName } from '../match.mjs';

const STOP_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * The words a site's search is asked for. 1337x lists a row when any one word matches (on
 * 2026-11-16 "the bear" put The Lion King first), so small words are left out. A title made only
 * of small words is kept whole.
 */
export function searchWords(title) {
  const words = String(title ?? '').normalize('NFKC').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  const kept = words.filter((word) => !STOP_WORDS.has(word.toLowerCase()));
  return (kept.length > 0 ? kept : words).join(' ');
}

// Where a release name's title can end: a year, an episode or season mark, or a quality word.
const TITLE_END =
  /\b(?:(?:19|20)\d{2}|S\d{1,2}(?:E\d{1,4})?|Season\s?\d{1,2}|Complete|\d{3,4}p|4K|UHD|HDR\d*|HDRip|BRRip|BDRip|BluRay|Blu-Ray|WEB(?:-?DL|-?Rip)?|HDTV|DVDRip|DVD|HDCAM|CAM|TS|TeleSync|x26[45]|H\.?26[45]|HEVC|XviD|REMUX)\b/gi;

/**
 * The titles a release name can be read as, and the years it names. Every place a title can end
 * gives one reading, so "Blade.Runner.2049.2017.1080p" reads as "Blade Runner" and as
 * "Blade Runner 2049". "Синтел / Sintel (2010)" gives each side of the slash.
 */
export function releaseNames(release) {
  const text = String(release ?? '').replace(/[._]+/g, ' ').replace(/[[\](){}]/g, ' ').replace(/\s+/g, ' ').trim();
  const titles = [];
  for (const m of text.matchAll(TITLE_END)) {
    const head = text.slice(0, m.index).replace(/[\s\-–:,|+]+$/, '').trim();
    if (head === '') continue;
    for (const alt of head.split(/\s+\/\s+/)) {
      const title = alt.trim();
      if (title !== '' && !titles.includes(title)) titles.push(title);
    }
  }
  const years = [...text.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => Number(m[1]));
  return { titles, years };
}

/**
 * The exact-title rule for a release name: one of its readings has the asked title's normalized
 * name. For a film with a year, a release that names years must name that one. An episode's year
 * is not compared, since releases name the series' first year, the season's year or none.
 * query: { title, year, episode }.
 */
export function sameTitle(release, query) {
  const wanted = normalizeName(String(query.title ?? ''));
  if (wanted === '') return false;
  const { titles, years } = releaseNames(release);
  if (!titles.some((title) => normalizeName(title) === wanted)) return false;
  if (query.episode === null && query.year !== null && years.length > 0 && !years.includes(query.year)) return false;
  return true;
}

const UNITS = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4 };

/** "4.8 GB", "136.52 MB", "1,234.5 MB" -> bytes; null when there is no size. */
export function parseSize(text) {
  const m = /(\d[\d,]*(?:\.\d+)?)\s*([KMGT]i?B|B)\b/i.exec(String(text ?? ''));
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  const unit = UNITS[m[2].toLowerCase()];
  return Number.isFinite(value) && unit !== undefined ? Math.round(value * unit) : null;
}

/** "1717", "1 086" -> a whole number; null when the cell holds no digit. */
export function parseCount(text) {
  const digits = String(text ?? '').replace(/[^\d]/g, '');
  return digits === '' ? null : Number(digits);
}

/**
 * One row as the CLI prints it, from what a page reader returned ({ name, href, seeds, leeches,
 * size }). Null for a row without a name, or one whose link leaves the site.
 */
export function toRow(raw, origin) {
  if (!raw || typeof raw.name !== 'string' || raw.name.trim() === '' || typeof raw.href !== 'string') return null;
  let url;
  try {
    url = new URL(raw.href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return {
    name: raw.name.replace(/\s+/g, ' ').trim(),
    page_url: url.href,
    seeds: parseCount(raw.seeds) ?? 0,
    leeches: parseCount(raw.leeches),
    size_bytes: parseSize(raw.size),
  };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(text) {
  let bits = '';
  for (const ch of text.toUpperCase()) {
    const value = BASE32.indexOf(ch);
    if (value < 0) return null;
    bits += value.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/**
 * A magnet link -> { info_hash (40 lower-case hex), trackers, name }; null when it names no BitTorrent
 * info hash. A 32-character base32 hash is turned into hex.
 */
export function parseMagnet(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('magnet:?')) return null;
  const params = new URLSearchParams(uri.slice('magnet:?'.length));
  let hash = null;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.exec(xt.trim());
    if (!m) continue;
    hash = m[1].length === 40 ? m[1].toLowerCase() : base32ToHex(m[1]);
    break;
  }
  if (hash === null || !/^[0-9a-f]{40}$/.test(hash)) return null;
  const trackers = [...new Set(params.getAll('tr').map((t) => t.trim()).filter((t) => /^(udp|https?|wss?):\/\//i.test(t)))];
  return { info_hash: hash, trackers, name: params.get('dn') };
}
