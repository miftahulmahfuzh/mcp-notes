import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import { TITLE_SEARCH_ROWS, TITLE_SEARCH_TIMEOUT_MS, titleSearchAnswer, titleSearchText, unsearchable } from './titleSearch.js';
import type { IndexRow, TorrentIndex } from './types.js';

function readTorrentsCsvRow(value: unknown): IndexRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.infohash);
  const name = asText(row?.name);
  if (row === null || infoHash === null || name === null) return null;
  return { infoHash, name, seeds: asCount(row.seeders) ?? 0, sizeBytes: asCount(row.size_bytes), site: 'torrents-csv' };
}

/** torrents-csv (torrents-csv.com/service): a GET search by title. */
export function torrentscsvIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'torrentscsv',
    timeoutMs: TITLE_SEARCH_TIMEOUT_MS,
    async find(query, ctx) {
      const text = titleSearchText(query);
      if (text === null) return unsearchable(query);
      const got = await getIndexJson(ctx, `${root}/search?q=${encodeURIComponent(text)}&size=${TITLE_SEARCH_ROWS}`);
      if (!got.ok) return failedAnswer(got);
      const torrents = asList(asRecord(got.json)?.torrents);
      if (torrents === null) return { outcome: 'error', detail: 'the answer has no torrents list', candidates: [] };
      const rows = torrents.map((t: unknown) => readTorrentsCsvRow(t)).filter((r): r is IndexRow => r !== null);
      return titleSearchAnswer(rows, 'torrentscsv', query);
    },
  };
}
