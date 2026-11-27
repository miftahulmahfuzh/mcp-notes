import type { StreamTorrentRow } from '../../../db/schema.js';
import { jsonError } from '../../passThrough.js';
import { diskFileResponse, swarmFileResponse } from '../serve.js';
import { splitUsage, type TorrentUsage } from '../usage.js';
import { normalizeInfoHash, type TorrentMap } from '../types.js';
import type { StreamsCore } from './core.js';
import type { FileOnDisk, WholeVideo } from './types.js';
import { round1, slotKey, sumRanges } from './util.js';

/**
 * Reading a torrent's files on this machine: where a whole file is, what is on disk of an unfinished one, the Range
 * answers of the file route, the map of seconds on disk, and what the torrents take for the Cache page. Nothing here
 * opens, uses, selects or holds a torrent; only `serve` counts as a request (it keeps a lingering torrent a while).
 */

/** The absolute path of a chosen file once it is whole on this machine's disk, else null. */
export async function filePath(core: StreamsCore, infoHash: string, index: number): Promise<string | null> {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null) return null;
  const found = await core.rowHere(hash, index);
  if (found instanceof Response) return null;
  const file = found.files.find((f) => f.index === index);
  // A file that lives as its remux has no original; what a neighbour's edge piece left at its path is no file.
  if (file === undefined || file.remuxed === true) return null;
  if (found.state !== 'ready' && core.active.get(hash)?.handle.done(index) !== true) return null;
  return core.folder.complete(hash, file.path, file.length);
}

/** True when this host's chosen video lives as its whole remux only (its original was deleted): play and read the remux. */
export async function remuxOnly(core: StreamsCore, infoHash: string, index: number): Promise<boolean> {
  const hash = normalizeInfoHash(infoHash);
  const keeper = core.opts.remuxes ?? null;
  if (hash === null || keeper === null) return false;
  const found = await core.rowHere(hash, index);
  if (found instanceof Response) return false;
  return found.files.some((f) => f.index === index && f.remuxed === true) && keeper.playable(hash, index);
}

/**
 * File `index` of a torrent as it is on this machine's disk now, for the seek previews (previews/torrentSource.ts).
 * It reads the row, the disk and the swarm's map of verified pieces only. It never opens, uses, selects, reads
 * through or holds the torrent, and it is not a request: a torrent waiting to leave the swarm leaves on time. Null
 * for an unknown hash, the other machine's, a file no episode chose, or one that lives as its remux (its original
 * is gone).
 */
export async function onDisk(core: StreamsCore, infoHash: string, index: number): Promise<FileOnDisk | null> {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null) return null;
  const found = await core.rowHere(hash, index);
  if (found instanceof Response) return null;
  const file = found.files.find((f) => f.index === index);
  if (file === undefined || file.remuxed === true) return null;
  const target = core.folder.diskPath(hash, file.path);
  if (target === null) return null;
  const whole = await filePath(core, hash, index);
  if (whole !== null) return { kind: 'whole', path: whole, length: file.length };
  const live = core.active.get(hash);
  return { kind: 'partial', path: target, length: file.length, ranges: live === undefined ? [] : live.handle.ranges(index) };
}

/**
 * GET /api/stream/torrent/:hash/f/:index. A chosen file with Range: from disk when it is whole, else
 * through the swarm, whose pieces for the range come first. 404 unknown_torrent / not_on_this_machine /
 * not_selected, 409 not_in_swarm (unfinished and not open: play it to carry on), 503 closing.
 */
export async function serve(core: StreamsCore, infoHash: string, index: number, rangeHeader: string | null): Promise<Response> {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null || !Number.isSafeInteger(index) || index < 0) return jsonError(404, 'unknown_torrent', 'No torrent download has this info hash.');
  const found = await core.rowHere(hash, index);
  if (found instanceof Response) return found;
  const file = found.files.find((f) => f.index === index);
  if (file === undefined) return jsonError(404, 'not_selected', 'That file of the torrent is not one this machine downloads.');
  if (file.remuxed === true) {
    return jsonError(410, 'remuxed', 'This file lives as its remux now (its original was deleted): play /api/stream/torrent/<hash>/hls/<index>/index.m3u8.');
  }
  const live = core.active.get(hash);
  if (found.state === 'ready' || live?.handle.done(index) === true) {
    const whole = await core.folder.complete(hash, file.path, file.length);
    if (whole !== null) return diskFileResponse(whole, file.path, rangeHeader);
  }
  if (core.closed) return jsonError(503, 'closing', 'The daemon is stopping.');
  if (live === undefined) return jsonError(409, 'not_in_swarm', 'This torrent is not being downloaded now; play it again to carry on.');
  live.lastRequestAt = core.nowMs();
  return swarmFileResponse(live.handle, file, rangeHeader);
}

/** Byte stretches of a video as seconds, to one decimal, once its length and duration are known; else none. Pure. */
export function secondsOf(bytes: readonly [number, number][], length: number | null, duration: number | null): [number, number][] {
  return duration === null || length === null || length === 0 ? [] : bytes.map(([from, to]) => [round1((from / length) * duration), round1((to / length) * duration)]);
}

/** The video's stretches on this machine's disk; null for an unknown hash or the other machine's. */
export async function map(core: StreamsCore, infoHash: string): Promise<TorrentMap | null> {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null) return null;
  const found = await core.rowHere(hash);
  if (found instanceof Response) return null;
  const live = core.active.get(hash);
  const length = found.fileLength;
  let bytes: [number, number][] = [];
  if (found.fileIndex !== null && length !== null) {
    if (found.state === 'ready') bytes = length > 0 ? [[0, length]] : [];
    else if (live !== undefined) bytes = live.handle.ranges(found.fileIndex);
  }
  const duration = found.durationS;
  return { duration_s: duration, ranges: secondsOf(bytes, length, duration), length, byte_ranges: bytes };
}

/**
 * How much of one chosen file is on this machine's disk now, for a download's progress: its whole length once it is
 * ready (or lives as its remux), else the verified bytes the swarm holds (the row's last count when not in the swarm).
 * Null for an unknown hash, the other machine's, or a file no episode chose.
 */
export async function fileProgress(core: StreamsCore, infoHash: string, fileIndex: number): Promise<{ bytesDone: number; length: number } | null> {
  const hash = normalizeInfoHash(infoHash);
  if (hash === null) return null;
  const found = await core.rowHere(hash, fileIndex);
  if (found instanceof Response) return null;
  const file = found.files.find((f) => f.index === fileIndex);
  if (file === undefined) return null;
  if (found.state === 'ready' || file.remuxed === true) return { bytesDone: file.length, length: file.length };
  const live = core.active.get(hash);
  const bytes = live !== undefined ? sumRanges(live.handle.ranges(fileIndex)) : found.bytesDone;
  return { bytesDone: Math.min(bytes, file.length), length: file.length };
}

/**
 * What this host's torrents take on disk, for the Cache page: per torrent its rows (one per episode) and its bytes split
 * between them (blocks on disk, as the budget counts), and the bytes of folders no row names. Never the other host's.
 */
export async function diskUsage(core: StreamsCore): Promise<{ torrents: { infoHash: string; rows: StreamTorrentRow[]; usage: TorrentUsage }[]; unnamedBytes: number; budgetBytes: number | null }> {
  const byHash = new Map<string, StreamTorrentRow[]>();
  for (const stored of await core.hostRows()) {
    const row = core.active.get(stored.infoHash)?.rows.get(slotKey(stored)) ?? stored;
    byHash.set(row.infoHash, [...(byHash.get(row.infoHash) ?? []), row]);
  }
  const torrents: { infoHash: string; rows: StreamTorrentRow[]; usage: TorrentUsage }[] = [];
  for (const [hash, rows] of byHash) torrents.push({ infoHash: hash, rows, usage: splitUsage(rows, await core.folder.usage(hash), core.relOf(hash)) });
  let unnamedBytes = 0;
  for (const hash of await core.folder.hashes()) if (!byHash.has(hash)) unnamedBytes += await core.folder.size(hash);
  return { torrents, unnamedBytes, budgetBytes: core.opts.budgetBytes ?? null };
}

/**
 * This host's chosen videos that are whole on disk now, for the seek previews' sweep: a ready row's video at its full
 * length, or one that lives as its finished remux. It reads rows and the disk only, and joins or holds nothing.
 */
export async function wholeVideos(core: StreamsCore): Promise<WholeVideo[]> {
  const out: WholeVideo[] = [];
  for (const row of await core.hostRows()) {
    if (row.state !== 'ready' || row.fileIndex === null) continue;
    const video = row.files.find((f) => f.index === row.fileIndex);
    if (video === undefined) continue;
    const base = { infoHash: row.infoHash, fileIndex: video.index, durationS: row.durationS };
    if (video.remuxed === true) {
      if (core.opts.remuxes?.playable(row.infoHash, video.index) === true) out.push({ ...base, via: 'remux' });
      continue;
    }
    const whole = await core.folder.complete(row.infoHash, video.path, video.length);
    if (whole !== null) out.push({ ...base, via: 'file', path: whole });
  }
  return out;
}
