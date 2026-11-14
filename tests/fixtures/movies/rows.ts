import type { movieFiles, moviePlays } from '../../../src/db/schema.js';

export type FileRow = typeof movieFiles.$inferSelect;
export type PlayRow = typeof moviePlays.$inferSelect;

export const T0 = new Date('2026-11-01T00:00:00Z');

/** A full movie_files row; every column the contract names, overridable. */
export function fileRow(over: Partial<FileRow> & Pick<FileRow, 'id'>): FileRow {
  return {
    titleId: 'movie-1',
    host: 'this-host',
    path: `/lib/file-${over.id}.mkv`,
    name: `file-${over.id}.mkv`,
    size: 1024,
    mtime: T0,
    durationS: 3000,
    season: null,
    episode: null,
    absoluteEpisode: null,
    status: 'matched',
    reason: null,
    parsed: null,
    source: 'scan',
    firstSeenAt: T0,
    lastSeenAt: T0,
    deletedAt: null,
    movedAt: null,
    doneAt: null,
    watchedAt: null,
    updatedAt: T0,
    ...over,
  };
}

/** A full movie_plays row (ended), overridable. */
export function playRow(over: Partial<PlayRow> & Pick<PlayRow, 'id' | 'fileId'>): PlayRow {
  return {
    host: 'this-host',
    source: 'live',
    startedAt: T0,
    endedAt: T0,
    startPositionS: 0,
    positionS: 0,
    durationS: 3000,
    updatedAt: T0,
    ...over,
  };
}
