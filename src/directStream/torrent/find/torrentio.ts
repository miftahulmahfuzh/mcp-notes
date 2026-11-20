import { answerOf, candidateFrom, withoutImdbId, YTS_HINTS } from './candidate.js';
import { asRecord, asText, failedAnswer, getIndexJson, parseSizeText } from './http.js';
import { baseName } from './release.js';
import type { IndexAnswer, IndexRow, TorrentIndex, TorrentQuery } from './types.js';

/**
 * Stremio torrent add-ons (Torrentio, TorrentsDB, Peerflix) answer one open JSON protocol keyed by IMDb id:
 * GET `<base>/stream/movie/<imdb>.json` or `<base>/stream/series/<imdb>:<season>:<episode>.json`, a `streams` list.
 * A stream's `title` holds the release on its first line, the file on the last line before the stats line, and the
 * stats line `👤 <seeds> 💾 <size> ⚙️ <site>` (Peerflix: `🌐 <site>`, sometimes without 💾, after a line of flags).
 * One reader serves them all; each add-on is one stremioAddonIndex.
 */

const STATS = /[\u{1F464}\u{1F4BE}]/u;
const SEEDS = /\u{1F464}\s*(\d+)/u;
const SIZE = /\u{1F4BE}\s*([\d.,]+\s*[KMGT]?i?B)/iu;
/** The site after ⚙️ (Torrentio, TorrentsDB) or 🌐 (Peerflix). */
const SITE = /(?:⚙️?|\u{1F310})\s*(.+)$/u;
/** A line of country flags only ("🇪🇸", "🇬🇧 / 🇮🇹"): never the release or the file. */
const FLAGS = /^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[\s\/])+$/u;
const YTS_RELEASE = /(?<![a-z])(?:yts|yify)(?![a-z])/i;

/** One Stremio add-on stream as an IndexRow; null when it has no info hash or no title. */
export function readStremioStream(value: unknown): IndexRow | null {
  const stream = asRecord(value);
  const infoHash = asText(stream?.infoHash);
  const title = asText(stream?.title);
  if (stream === null || infoHash === null || title === null) return null;
  const lines = title
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const statsAt = lines.findIndex((l) => STATS.test(l));
  const head = (statsAt < 0 ? lines : lines.slice(0, statsAt)).filter((l) => !FLAGS.test(l));
  const name = head[0];
  if (name === undefined) return null;
  const stats = statsAt < 0 ? '' : (lines[statsAt] ?? '');
  const fileLine = head.length > 1 ? (head[head.length - 1] ?? null) : null;
  const fileName = asText(asRecord(stream.behaviorHints)?.filename) ?? (fileLine === null ? null : baseName(fileLine));
  const sizeText = SIZE.exec(stats)?.[1];
  const site = SITE.exec(stats)?.[1]?.trim() ?? null;
  const sources = Array.isArray(stream.sources) ? stream.sources : [];
  const trackers = sources
    .map((s) => asText(s))
    .filter((s): s is string => s !== null && s.startsWith('tracker:'))
    .map((s) => s.slice('tracker:'.length));
  const fileIdx = typeof stream.fileIdx === 'number' && Number.isInteger(stream.fileIdx) && stream.fileIdx >= 0 ? stream.fileIdx : null;
  const yts = site?.toUpperCase() === 'YTS' || YTS_RELEASE.test(`${name} ${fileName ?? ''}`);
  return {
    infoHash,
    name,
    fileName,
    fileIdx,
    seeds: Number(SEEDS.exec(stats)?.[1] ?? 0),
    sizeBytes: sizeText === undefined ? null : parseSizeText(sizeText),
    trackers,
    site,
    hints: yts ? YTS_HINTS : undefined,
  };
}

export interface StremioAddon {
  /** Lower case: the attempt's name and each candidate's `index`. */
  name: string;
  /** The add-on's address, up to (not including) `/stream`. */
  base: string;
  /** Whether this title is one the add-on is asked for (TorrentIndex.asks); absent: every title. */
  asks?: (query: TorrentQuery) => boolean;
}

/** A Stremio torrent add-on as a TorrentIndex, asked by IMDb id for a film or one episode. */
export function stremioAddonIndex(addon: StremioAddon): TorrentIndex {
  const root = addon.base.replace(/\/+$/, '');
  return {
    name: addon.name,
    ...(addon.asks === undefined ? {} : { asks: addon.asks }),
    async find(query, ctx): Promise<IndexAnswer> {
      const imdbId = query.imdbId;
      if (imdbId === null) return withoutImdbId();
      // The add-ons number an episode within its season: `alt` when TMDB's number runs on across seasons.
      const episode = query.kind === 'movie' ? null : (query.alt ?? query);
      const path = episode === null ? `movie/${imdbId}` : `series/${imdbId}:${episode.season}:${episode.episode}`;
      const got = await getIndexJson(ctx, `${root}/stream/${path}.json`);
      if (!got.ok) return failedAnswer(got);
      const streams = asRecord(got.json)?.streams;
      if (!Array.isArray(streams)) return { outcome: 'error', detail: 'the answer has no streams list', candidates: [] };
      const rows = streams.map((s: unknown) => readStremioStream(s)).filter((r): r is IndexRow => r !== null);
      return answerOf(rows.map((row) => candidateFrom(row, addon.name, query, query.kind === 'tv')));
    },
  };
}

export function torrentioIndex(base: string): TorrentIndex {
  return stremioAddonIndex({ name: 'torrentio', base });
}
