import { asCount, asList, asRecord, asText, failedAnswer, postIndexJson, trackersFromMagnet } from './http.js';
import { TITLE_SEARCH_ROWS, TITLE_SEARCH_TIMEOUT_MS, titleSearchAnswer, titleSearchText, unsearchable } from './titleSearch.js';
import type { IndexRow, TorrentIndex } from './types.js';

/** One Knaben hit as an IndexRow; null without an info hash (a link-only listing) or a title. */
function readKnabenHit(value: unknown): IndexRow | null {
  const hit = asRecord(value);
  const infoHash = asText(hit?.hash);
  const name = asText(hit?.title);
  if (hit === null || infoHash === null || name === null) return null;
  const magnet = asText(hit.magnetUrl);
  return {
    infoHash,
    name,
    seeds: asCount(hit.seeders) ?? 0,
    sizeBytes: asCount(hit.bytes),
    trackers: magnet === null ? [] : trackersFromMagnet(magnet),
    // Knaben aggregates: "The Pirate Bay", "1337x", ...
    site: asText(hit.tracker) ?? 'Knaben',
  };
}

/** Knaben (api.knaben.org/v1): one JSON POST, searched by title, most seeded first. */
export function knabenIndex(base: string): TorrentIndex {
  const root = base.replace(/\/+$/, '');
  return {
    name: 'knaben',
    timeoutMs: TITLE_SEARCH_TIMEOUT_MS,
    async find(query, ctx) {
      const text = titleSearchText(query);
      if (text === null) return unsearchable(query);
      const got = await postIndexJson(ctx, root, {
        search_type: '100%',
        search_field: 'title',
        query: text,
        order_by: 'seeders',
        order_direction: 'desc',
        size: TITLE_SEARCH_ROWS,
        hide_unsafe: true,
        hide_xxx: true,
      });
      if (!got.ok) return failedAnswer(got);
      const hits = asList(asRecord(got.json)?.hits);
      if (hits === null) return { outcome: 'error', detail: 'the answer has no hits list', candidates: [] };
      const rows = hits.map((h: unknown) => readKnabenHit(h)).filter((r): r is IndexRow => r !== null);
      return titleSearchAnswer(rows, 'knaben', query);
    },
  };
}
