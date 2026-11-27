import { and, inArray, isNotNull, or } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Db } from '../../../db/client.js';
import { movieTitles } from '../../../db/schema.js';
import { WebTorrentEngine } from '../engine.js';
import { ffprobeFile } from '../probe.js';
import { RemuxOnly } from '../remuxOnly.js';
import { TorrentsRepo } from '../repo.js';
import { TorrentFolder } from '../store.js';
import type { TorrentEngine } from '../types.js';
import { TorrentStreams } from './torrentStreams.js';
import { GIB } from './util.js';

/** Test seams for buildTorrentStreams. */
export interface TorrentStreamsOverrides {
  engine?: TorrentEngine;
  now?: () => Date;
  log?: (line: string) => void;
  /** False while the shared import is pending: no folder a row does not name is swept. */
  sweepOrphans?: boolean;
}

/**
 * The daemon's torrents, or null with direct streaming off or NOTESD_TORRENT=off (then nothing is built,
 * no swarm is joined and the routes answer torrent_off). Building it starts nothing: the engine starts
 * with the first torrent opened.
 */
export function buildTorrentStreams(
  config: Config,
  directStream: { readonly host: string } | null,
  db: Db,
  overrides: TorrentStreamsOverrides = {},
): TorrentStreams | null {
  const t = config.torrent;
  if (directStream === null || t === undefined || !t.enabled) return null;
  const folder = new TorrentFolder(t.dir);
  const log = overrides.log ?? ((line: string) => console.log(line));
  return new TorrentStreams({
    engine: overrides.engine ?? new WebTorrentEngine({ folder, uploadKbps: t.uploadKbps, discovery: t.discovery, peers: t.peers, log }),
    repo: new TorrentsRepo(db),
    folder,
    host: directStream.host,
    uploadKbps: t.uploadKbps,
    keepDays: t.keepDays,
    budgetBytes: t.budgetGb * GIB,
    discovery: t.discovery,
    // With the remux on, a remuxed film keeps its remux only once nothing needs the original (remuxOnly.ts).
    remuxes: t.remux ? new RemuxOnly({ dir: t.dir, probe: ffprobeFile({ ffprobeBin: config.movies.ffprobeBin }) }) : null,
    marked: async (ids) => {
      if (ids.length === 0) return new Set<string>();
      const found = await db
        .select({ id: movieTitles.id })
        .from(movieTitles)
        .where(and(inArray(movieTitles.id, [...ids]), or(isNotNull(movieTitles.watchedAt), isNotNull(movieTitles.notInterestedAt))));
      return new Set(found.map((r) => r.id));
    },
    log,
    ...(overrides.sweepOrphans === undefined ? {} : { sweepOrphans: overrides.sweepOrphans }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}
