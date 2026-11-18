import { stremioAddonIndex } from './torrentio.js';
import type { TorrentIndex } from './types.js';

/**
 * TorrentsDB (torrentsdb.com), a Stremio torrent add-on asked by IMDb id for every film and episode. It answers in
 * Torrentio's shape and lists sites Torrentio does not (knaben, rargb, sktorrent, ilcorsaronero): for The Shawshank
 * Redemption, 7 of its 96 streams were info hashes Torrentio's 500 did not hold (probed 2026-11-19). A torrent both
 * list is one candidate: rankCandidates joins listings by info hash, `listedBy` naming both.
 */
export function torrentsdbIndex(base: string): TorrentIndex {
  return stremioAddonIndex({ name: 'torrentsdb', base });
}
