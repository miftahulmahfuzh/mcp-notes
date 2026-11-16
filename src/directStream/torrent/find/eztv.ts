import { answerOf, candidateFrom } from './candidate.js';
import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson, trackersFromMagnet } from './http.js';
import { episodeFit, stripExtension } from './release.js';
import type { IndexRow, TorrentIndex } from './types.js';

export const EZTV_PAGE_LIMIT = 100;
/** EZTV lists newest first; older episodes of a long series are left to Torrentio. */
export const EZTV_MAX_PAGES = 3;

function readEztvRow(value: unknown, imdbDigits: string): IndexRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.hash);
  const fileName = asText(row?.filename);
  const name = asText(row?.title) ?? (fileName === null ? null : stripExtension(fileName));
  if (row === null || infoHash === null || name === null) return null;
  const imdb = asText(row.imdb_id);
  if (imdb !== null && Number(imdb.replace(/^tt/i, '')) !== Number(imdbDigits)) return null;
  const magnet = asText(row.magnet_url);
  return {
    infoHash,
    name,
    fileName,
    seeds: asCount(row.seeds) ?? 0,
    sizeBytes: asCount(row.size_bytes),
    trackers: magnet === null ? [] : trackersFromMagnet(magnet),
    site: 'EZTV',
  };
}

export function eztvIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'eztv',
    kinds: ['tv'],
    async find(query, ctx) {
      if (query.kind !== 'tv') return { outcome: 'empty', detail: 'EZTV lists series only', candidates: [] };
      const digits = query.imdbId.slice(2);
      const rows: IndexRow[] = [];
      for (let page = 1; page <= EZTV_MAX_PAGES; page++) {
        const got = await getIndexJson(ctx, `${root}/api/get-torrents?imdb_id=${digits}&limit=${EZTV_PAGE_LIMIT}&page=${page}`);
        if (!got.ok) {
          if (page === 1) return failedAnswer(got);
          break;
        }
        const answer = asRecord(got.json);
        const list = asList(answer?.torrents) ?? [];
        for (const value of list) {
          const row = readEztvRow(value, digits);
          if (row !== null) rows.push(row);
        }
        const total = asCount(answer?.torrents_count) ?? 0;
        if (list.length < EZTV_PAGE_LIMIT || page * EZTV_PAGE_LIMIT >= total) break;
      }
      const fitting = rows.filter((row) => episodeFit(row.name, row.fileName ?? null, query.season, query.episode) !== 'other');
      return answerOf(fitting.map((row) => candidateFrom(row, 'eztv', query)));
    },
  };
}
