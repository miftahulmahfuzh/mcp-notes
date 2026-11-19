import { trackersFromMagnet } from './http.js';
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

/**
 * A candidate built from a magnet link or a bare 40-hex info hash the owner pasted (not an index):
 * its info hash and `tr=` trackers, named from the magnet's `dn` (or the hash). The release is parsed
 * from the name as an index row's is, so the file-pick and the language check read it the same way.
 * Null when there is no usable info hash. index "magnet", seeds 0 (its swarm, not a seed count, decides).
 */
export function candidateFromMagnet(magnet: string, query: TorrentQuery): TorrentCandidate | null {
  const trimmed = magnet.trim();
  const bare = /^[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed : null;
  const match = bare === null ? /xt=urn:btih:([0-9a-fA-F]{40}|[2-7a-zA-Z]{32})/.exec(trimmed) : null;
  const raw = bare ?? match?.[1] ?? null;
  if (raw === null) return null;
  let infoHash: string;
  try {
    infoHash = normalizeInfoHash(raw);
  } catch {
    return null;
  }
  const dn = bare === null ? new URLSearchParams(trimmed.slice(trimmed.indexOf('?') + 1)).get('dn') : null;
  const name = (dn ?? '').trim() || infoHash;
  return {
    infoHash,
    name,
    fileName: null,
    fileIdx: null,
    seeds: 0,
    sizeBytes: null,
    index: 'magnet',
    listedBy: ['magnet'],
    site: null,
    trackers: [...new Set([...(bare === null ? trackersFromMagnet(trimmed) : []), ...DEFAULT_TRACKERS])],
    scoped: false,
    release: parseRelease(name, { originalLanguage: query.originalLanguage, title: query.title, originalTitle: query.originalTitle }),
  };
}

/** The detail of an index keyed by the IMDb id when the title has none. */
export const NO_IMDB_ID = 'not asked: no IMDb id is known for this title, and this index is asked by it';

/** The answer of an index keyed by the IMDb id for a query that carries none: `empty`, and no request is sent. */
export function withoutImdbId(): IndexAnswer {
  return { outcome: 'empty', detail: NO_IMDB_ID, candidates: [] };
}

/** `ok` with what was listed, or `empty`. */
export function answerOf(candidates: TorrentCandidate[]): IndexAnswer {
  return candidates.length > 0
    ? { outcome: 'ok', detail: `${candidates.length} listed`, candidates }
    : { outcome: 'empty', detail: 'nothing listed', candidates: [] };
}
