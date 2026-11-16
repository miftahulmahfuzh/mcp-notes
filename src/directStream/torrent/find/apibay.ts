import { answerOf, candidateFrom } from './candidate.js';
import { asCount, asRecord, asText, failedAnswer, getIndexJson } from './http.js';
import type { IndexRow, TorrentIndex } from './types.js';

function readApibayRow(value: unknown, imdbId: string): IndexRow | null {
  const row = asRecord(value);
  const infoHash = asText(row?.info_hash);
  const name = asText(row?.name);
  if (row === null || infoHash === null || name === null || /^0+$/.test(infoHash)) return null;
  const imdb = asText(row.imdb);
  if (imdb !== null && imdb.toLowerCase() !== imdbId) return null;
  return { infoHash, name, seeds: asCount(row.seeders) ?? 0, sizeBytes: asCount(row.size), site: 'ThePirateBay' };
}

export function apibayIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'apibay',
    async find(query, ctx) {
      const got = await getIndexJson(ctx, `${root}/q.php?q=${encodeURIComponent(query.imdbId)}`);
      if (!got.ok) return failedAnswer(got);
      if (!Array.isArray(got.json)) return { outcome: 'error', detail: 'the answer is not a list', candidates: [] };
      const rows = got.json.map((v: unknown) => readApibayRow(v, query.imdbId)).filter((r): r is IndexRow => r !== null);
      return answerOf(rows.map((row) => candidateFrom(row, 'apibay', query)));
    },
  };
}
