/**
 * This host's torrent downloads (TorrentStreams): every name this file ever exported, from the modules under streams/
 * that now hold them. Import from here; the modules are split by concern so one can be changed alone:
 *
 * - torrentStreams.ts  the TorrentStreams class: the swarm lifecycle (open, use, useSlot, release, drop, discard,
 *                      played, the tick) and the calls it hands to the modules below
 * - core.ts            what every part shares: options, the torrents in the swarm and being opened, the row lookups
 * - leave.ts           settle (progress, finished episodes) and leave (the swarm left, unchosen edges deleted)
 * - files.ts           paths of whole files, Range answers, the map, progress, the Cache page's usage, whole videos
 * - views.ts           a download's view for the routes, and the status
 * - originals.ts       one copy on disk: the original deleted beside a whole remux (dropOriginals, sweepRemuxed)
 * - prune.ts           the prune: by age, orphan folders, the budget (lastActivity, budgetOrder: pure)
 * - types.ts, util.ts  FileOnDisk, WholeVideo, TorrentStreamsOptions; small helpers
 * - build.ts           buildTorrentStreams (the daemon's wiring)
 */

export { TorrentStreams } from './streams/torrentStreams.js';
export { TORRENT_RECENT_MS } from './streams/prune.js';
export type { FileOnDisk, TorrentStreamsOptions, WholeVideo } from './streams/types.js';
export { buildTorrentStreams, type TorrentStreamsOverrides } from './streams/build.js';
