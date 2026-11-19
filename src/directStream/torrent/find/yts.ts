import { answerOf, candidateFrom, withoutImdbId, YTS_HINTS } from './candidate.js';
import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import type { IndexRow, TorrentIndex } from './types.js';

/** YTS did not answer within 20 s from this network on 2026-11-16; it may not hold the others up for 10. */
export const DEFAULT_YTS_TIMEOUT_MS = 6_000;

function readYtsTorrent(value: unknown, title: string): IndexRow | null {
  const torrent = asRecord(value);
  const infoHash = asText(torrent?.hash);
  if (torrent === null || infoHash === null) return null;
  const quality = asText(torrent.quality) ?? '';
  const parts = [quality, asText(torrent.type), asText(torrent.video_codec)].filter((p): p is string => p !== null && p !== '');
  return {
    infoHash,
    name: `${title} ${parts.map((p) => `[${p}]`).join(' ')} [YTS]`,
    seeds: asCount(torrent.seeds) ?? 0,
    sizeBytes: asCount(torrent.size_bytes),
    site: 'YTS',
    hints: quality.toUpperCase() === '3D' ? { ...YTS_HINTS, threeD: true } : YTS_HINTS,
  };
}

export function ytsIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'yts',
    kinds: ['movie'],
    timeoutMs: DEFAULT_YTS_TIMEOUT_MS,
    async find(query, ctx) {
      const imdbId = query.imdbId;
      if (imdbId === null) return withoutImdbId();
      const got = await getIndexJson(ctx, `${root}/list_movies.json?query_term=${encodeURIComponent(imdbId)}`);
      if (!got.ok) return failedAnswer(got);
      const answer = asRecord(got.json);
      const status = asText(answer?.status);
      if (answer === null || status !== 'ok') return { outcome: 'error', detail: `YTS answered status ${status ?? 'none'}`, candidates: [] };
      const rows: IndexRow[] = [];
      for (const value of asList(asRecord(answer.data)?.movies) ?? []) {
        const movie = asRecord(value);
        if (movie === null || asText(movie.imdb_code)?.toLowerCase() !== imdbId) continue;
        const title = asText(movie.title_long) ?? asText(movie.title) ?? imdbId;
        for (const torrent of asList(movie.torrents) ?? []) {
          const row = readYtsTorrent(torrent, title);
          if (row !== null) rows.push(row);
        }
      }
      return answerOf(rows.map((row) => candidateFrom(row, 'yts', query)));
    },
  };
}
