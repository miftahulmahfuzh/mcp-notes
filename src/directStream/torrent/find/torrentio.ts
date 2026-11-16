import { answerOf, candidateFrom, YTS_HINTS } from './candidate.js';
import { asRecord, asText, failedAnswer, getIndexJson, parseSizeText } from './http.js';
import { baseName } from './release.js';
import type { IndexRow, TorrentIndex } from './types.js';

const STATS = /[\u{1F464}\u{1F4BE}]/u;
const SEEDS = /\u{1F464}\s*(\d+)/u;
const SIZE = /\u{1F4BE}\s*([\d.,]+\s*[KMGT]?i?B)/iu;
const SITE = /⚙️?\s*(.+)$/u;
const YTS_RELEASE = /(?<![a-z])(?:yts|yify)(?![a-z])/i;

/** One Torrentio stream as an IndexRow; null when it has no info hash or no title. */
export function readTorrentioStream(value: unknown): IndexRow | null {
  const stream = asRecord(value);
  const infoHash = asText(stream?.infoHash);
  const title = asText(stream?.title);
  if (stream === null || infoHash === null || title === null) return null;
  const lines = title
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const statsAt = lines.findIndex((l) => STATS.test(l));
  const head = statsAt < 0 ? lines : lines.slice(0, statsAt);
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

export function torrentioIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'torrentio',
    async find(query, ctx) {
      // Torrentio numbers an episode within its season: `alt` when TMDB's number runs on across seasons.
      const episode = query.kind === 'movie' ? null : (query.alt ?? query);
      const path = episode === null ? `movie/${query.imdbId}` : `series/${query.imdbId}:${episode.season}:${episode.episode}`;
      const got = await getIndexJson(ctx, `${root}/stream/${path}.json`);
      if (!got.ok) return failedAnswer(got);
      const streams = asRecord(got.json)?.streams;
      if (!Array.isArray(streams)) return { outcome: 'error', detail: 'the answer has no streams list', candidates: [] };
      const rows = streams.map((s: unknown) => readTorrentioStream(s)).filter((r): r is IndexRow => r !== null);
      return answerOf(rows.map((row) => candidateFrom(row, 'torrentio', query, query.kind === 'tv')));
    },
  };
}
