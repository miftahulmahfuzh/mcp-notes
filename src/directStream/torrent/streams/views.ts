import type { StreamTorrentRow } from '../../../db/schema.js';
import { BYTES_PER_KB, mediaOf, type TorrentDownloadView, type TorrentStatus } from '../types.js';
import type { StreamsCore } from './core.js';
import { sumRanges } from './util.js';

/** What the routes show of the torrents: one download's view (this host's, or the other machine's) and the status. */

/** One row as the routes show it: this host's with what the swarm says now, the other machine's as `available: false`. */
export function viewOf(core: StreamsCore, row: StreamTorrentRow): TorrentDownloadView {
  const available = row.host === core.host;
  const live = available ? core.active.get(row.infoHash) : undefined;
  const stats = live?.handle.stats() ?? { peers: 0, down_kbps: 0, up_kbps: 0 };
  const length = row.fileLength;
  const bytes =
    row.state === 'ready'
      ? (length ?? row.bytesDone)
      : live !== undefined && row.fileIndex !== null
        ? sumRanges(live.handle.ranges(row.fileIndex))
        : row.bytesDone;
  return {
    info_hash: row.infoHash,
    host: row.host,
    available,
    kind: row.kind,
    tmdb_id: row.tmdbId,
    season: row.kind === 'tv' ? row.season : null,
    episode: row.kind === 'tv' ? row.episode : null,
    name: row.name,
    release: row.release,
    state: row.state,
    error: row.error,
    file_index: row.fileIndex,
    file_length: length,
    files: row.files.map((f) => ({ index: f.index, path: f.path, length: f.length, media: mediaOf(f.path) })),
    bytes_done: bytes,
    progress: length === null || length === 0 ? (row.state === 'ready' ? 1 : 0) : Math.round((bytes / length) * 1000) / 1000,
    duration_s: row.durationS,
    in_swarm: live !== undefined,
    users: live?.users ?? 0,
    ...stats,
    file_url: available && row.fileIndex !== null ? core.localUrl(row.infoHash, row.fileIndex) : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    completed_at: row.completedAt === null ? null : row.completedAt.toISOString(),
    played_at: row.playedAt === null ? null : row.playedAt.toISOString(),
  };
}

/** The engine's port, the caps, and every torrent in the swarm with its users and rates. */
export function statusOf(core: StreamsCore): TorrentStatus {
  return {
    host: core.host,
    port: core.engine.port(),
    upload_cap_bytes_per_s: core.opts.uploadKbps * BYTES_PER_KB,
    keep_days: core.opts.keepDays,
    discovery: core.opts.discovery,
    swarm: [...core.active.entries()].map(([hash, live]) => ({ info_hash: hash, name: live.handle.name, users: live.users, ...live.handle.stats() })),
  };
}
