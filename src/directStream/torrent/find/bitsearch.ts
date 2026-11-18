import { asCount, asList, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import { TITLE_SEARCH_TIMEOUT_MS, titleSearchAnswer, titleSearchText, unsearchable } from './titleSearch.js';
import type { IndexRow, TorrentIndex } from './types.js';

function readBitsearchResult(value: unknown): IndexRow | null {
  const result = asRecord(value);
  const infoHash = asText(result?.infohash);
  const name = asText(result?.title);
  if (result === null || infoHash === null || name === null) return null;
  return { infoHash, name, seeds: asCount(result.seeders) ?? 0, sizeBytes: asCount(result.size), site: 'Bitsearch' };
}

/** Bitsearch (bitsearch.to/api/v1; solidtorrents answers from the same backend, so it is not asked too). */
export function bitsearchIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'bitsearch',
    timeoutMs: TITLE_SEARCH_TIMEOUT_MS,
    async find(query, ctx) {
      const text = titleSearchText(query);
      if (text === null) return unsearchable(query);
      const got = await getIndexJson(ctx, `${root}/search?q=${encodeURIComponent(text)}&sort=seeders`);
      if (!got.ok) return failedAnswer(got);
      const answer = asRecord(got.json);
      const results = asList(answer?.results);
      if (answer?.success !== true || results === null) return { outcome: 'error', detail: 'the answer is not a successful results list', candidates: [] };
      const rows = results.map((r: unknown) => readBitsearchResult(r)).filter((r): r is IndexRow => r !== null);
      return titleSearchAnswer(rows, 'bitsearch', query);
    },
  };
}
