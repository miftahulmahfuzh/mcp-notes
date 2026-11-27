import { stat } from 'node:fs/promises';
import type { StreamTorrentRow } from '../../../db/schema.js';
import type { StreamRef } from '../../types.js';
import type { TorrentSlot } from '../repo.js';

/** Small pure helpers TorrentStreams' modules share (plus `allocated`, which reads one file's size). */

export const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** The bytes `[from, to)` stretches cover. */
export const sumRanges = (ranges: readonly [number, number][]): number => ranges.reduce((n, [from, to]) => n + (to - from), 0);
export const round1 = (n: number): number => Math.round(n * 10) / 10;
/** The key an episode's row goes by in Active.rows: `<season>x<episode>` (a film: `0x0`). */
export const slotKey = (s: Pick<TorrentSlot, 'season' | 'episode'>): string => `${s.season}x${s.episode}`;
export const GIB = 1024 ** 3;
/** Bytes for a log line: `1.4 GB` from a GiB up, else whole MB. */
export const gb = (bytes: number): string => (bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1_048_576)} MB`);
/** The torrents the owner keeps as downloads (any row of it has `kept_at`): neither prune deletes them. */
export const keptHashes = (rows: readonly StreamTorrentRow[]): Set<string> => new Set(rows.filter((r) => r.keptAt !== null).map((r) => r.infoHash));
/** ` S01E02` for an episode's row, nothing for a film's. */
export const episodeOf = (row: Pick<StreamTorrentRow, 'kind' | 'season' | 'episode'>): string =>
  row.kind === 'tv' ? ` S${String(row.season).padStart(2, '0')}E${String(row.episode).padStart(2, '0')}` : '';
/** The same film, or the same episode of the same series. */
export const sameRef = (a: StreamRef, b: StreamRef): boolean =>
  a.kind === b.kind && a.tmdbId === b.tmdbId && (a.kind === 'movie' || (b.kind === 'tv' && a.season === b.season && a.episode === b.episode));

/** The bytes a file takes on disk (its blocks), 0 when it is not there. */
export async function allocated(file: string): Promise<number> {
  try {
    const s = await stat(file);
    return s.isFile() ? (s.blocks > 0 ? s.blocks * 512 : s.size) : 0;
  } catch {
    return 0;
  }
}
