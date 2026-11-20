import type { StreamTorrentRow } from '../../db/schema.js';
import { CUES_DIR } from './subtitles/feed.js';

/** One file under a torrent's folder: its path relative to the folder (`/` between names) and the bytes it takes on disk. */
export interface FolderEntry {
  rel: string;
  bytes: number;
}

/** An episode of a torrent (a film: season 0, episode 0). */
export interface SlotKey {
  season: number;
  episode: number;
}

export const slotId = (s: SlotKey): string => `${s.season}x${s.episode}`;

const REMUX_DIR = 'notesd-remux';
/** `notesd-cues/embedded-<file index>-<stream index>.jsonl`, `notesd-cues/whisper-<file index>.jsonl`. */
const CUE_FILE = /^(?:embedded|whisper)-(\d+)(?:-\d+)?\.jsonl$/;

/**
 * Which episodes of a torrent own one file of its folder: the rows that chose it (by its path on disk), the rows whose
 * video a remux folder (`notesd-remux/<file index>/`) or a cue feed was made from. Anything else (the kept subtitles, the
 * edges of files nobody chose) has no owner.
 */
export function ownersOf(rel: string, rows: readonly StreamTorrentRow[], relOf: (filePath: string) => string | null): StreamTorrentRow[] {
  const parts = rel.split('/');
  let index: number | null = null;
  if (parts[0] === REMUX_DIR && parts.length >= 3) index = Number(parts[1]);
  else if (parts[0] === CUES_DIR && parts.length === 2) {
    const m = CUE_FILE.exec(parts[1]!);
    if (m !== null) index = Number(m[1]);
  }
  if (index !== null) return Number.isInteger(index) ? rows.filter((r) => r.fileIndex === index || r.files.some((f) => f.index === index)) : [];
  return rows.filter((r) => r.files.some((f) => relOf(f.path) === rel));
}

/** A torrent's bytes on disk, split between its episodes: a file one episode alone owns is that episode's; the rest is shared. */
export interface TorrentUsage {
  /** By slotId. */
  slots: Map<string, number>;
  /** Owned by no episode or by several: a season pack's subtitles, extras, the edges of files nobody chose. */
  shared: number;
  total: number;
}

/** Splits a torrent's folder between its rows. A torrent with one row: everything is that row's. */
export function splitUsage(rows: readonly StreamTorrentRow[], entries: readonly FolderEntry[], relOf: (filePath: string) => string | null): TorrentUsage {
  const slots = new Map<string, number>();
  let shared = 0;
  let total = 0;
  for (const e of entries) {
    total += e.bytes;
    const owners = rows.length === 1 ? rows : ownersOf(e.rel, rows, relOf);
    if (owners.length === 1) slots.set(slotId(owners[0]!), (slots.get(slotId(owners[0]!)) ?? 0) + e.bytes);
    else shared += e.bytes;
  }
  return { slots, shared, total };
}

/**
 * What deleting these episodes of a torrent takes from its folder. With no episode left, the whole folder (`all`).
 * Else the files only the deleted episodes own (their videos, their remux and cue files, a subtitle only they chose);
 * a file a kept episode chose too stays, and so does everything shared.
 */
export function removalPlan(
  rows: readonly StreamTorrentRow[],
  gone: ReadonlySet<string>,
  entries: readonly FolderEntry[],
  relOf: (filePath: string) => string | null,
): { all: true; bytes: number } | { all: false; rels: string[]; bytes: number } {
  const kept = rows.filter((r) => !gone.has(slotId(r)));
  if (kept.length === 0) return { all: true, bytes: entries.reduce((n, e) => n + e.bytes, 0) };
  const rels: string[] = [];
  let bytes = 0;
  for (const e of entries) {
    const owners = ownersOf(e.rel, rows, relOf);
    if (owners.length > 0 && owners.every((r) => gone.has(slotId(r)))) {
      rels.push(e.rel);
      bytes += e.bytes;
    }
  }
  return { all: false, rels, bytes };
}
