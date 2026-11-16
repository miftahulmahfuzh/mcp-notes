import { parseRelease } from './release.js';
import type { IndexAnswer, IndexRow, ReleaseHints, TorrentCandidate, TorrentQuery } from './types.js';

/**
 * Public trackers added to every candidate (apibay and YTS list none; a Torrentio row may list only
 * one site's retrackers). The swarm is also found through DHT; these only speed up the first peers.
 */
export const DEFAULT_TRACKERS: readonly string[] = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
];

/** YTS releases are H.264 or HEVC with AAC in MP4; its names do not say so. */
export const YTS_HINTS: Readonly<ReleaseHints> = { container: 'mp4', audioCodec: 'aac' };

const HEX_HASH = /^[0-9a-f]{40}$/;
const BASE32_HASH = /^[a-z2-7]{32}$/i;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32ToHex(text: string): string {
  let bits = '';
  for (const ch of text.toLowerCase()) bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** 40 lower-case hex characters when the text is a hex or base32 info hash; else the text lower-cased (rank leaves it out). */
export function normalizeInfoHash(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (HEX_HASH.test(text)) return text;
  if (BASE32_HASH.test(text)) return base32ToHex(text);
  return text;
}

export function isUsableHash(hash: string): boolean {
  return HEX_HASH.test(hash) && !/^0+$/.test(hash);
}

/** `tt` and at least seven digits, from "tt1727587", "TT1727587" or "1727587"; null for anything else. */
export function normalizeImdbId(text: string): string | null {
  const digits = /^(?:tt)?(\d{5,10})$/i.exec(text.trim())?.[1];
  return digits === undefined ? null : `tt${digits.padStart(7, '0')}`;
}

/** The one place a listed row becomes a candidate. `scoped`: the index answered for the asked episode. */
export function candidateFrom(row: IndexRow, index: string, query: TorrentQuery, scoped = false): TorrentCandidate {
  const fileName = row.fileName?.trim() ? row.fileName.trim() : null;
  const seeds = Number.isFinite(row.seeds) && row.seeds > 0 ? Math.floor(row.seeds) : 0;
  return {
    infoHash: normalizeInfoHash(row.infoHash),
    name: row.name.trim(),
    fileName,
    fileIdx: row.fileIdx ?? null,
    seeds,
    sizeBytes: row.sizeBytes !== null && Number.isFinite(row.sizeBytes) && row.sizeBytes > 0 ? row.sizeBytes : null,
    index,
    listedBy: [index],
    site: row.site ?? null,
    trackers: [...new Set([...(row.trackers ?? []), ...DEFAULT_TRACKERS])],
    scoped,
    release: parseRelease(row.name, {
      originalLanguage: query.originalLanguage,
      title: query.title,
      originalTitle: query.originalTitle,
      fileName,
      hints: row.hints,
    }),
  };
}

/** `ok` with what was listed, or `empty`. */
export function answerOf(candidates: TorrentCandidate[]): IndexAnswer {
  return candidates.length > 0
    ? { outcome: 'ok', detail: `${candidates.length} listed`, candidates }
    : { outcome: 'empty', detail: 'nothing listed', candidates: [] };
}
