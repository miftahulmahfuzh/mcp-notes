import { heightRank, looksDead, parseEpisodeRef, type ReleaseHeight, type SwarmCount, type TorrentCandidate } from './find/index.js';

/**
 * The season packs among a season's torrent candidates, for a season download (TorrentSource.fetchPack): a release
 * whose name holds more than one episode (`release.pack`) and names `season` (alone, in a range of seasons that covers
 * it, or a complete series that names no season), whose swarm the trackers do not call dead, at `height` when one is
 * given. Best first: the preferred height (HEIGHT_PREFERENCE), one season before a range or a complete series, then
 * more seeders. What the finder left out stays out: nothing here loosens its rules.
 */
export function seasonPacks(
  candidates: readonly TorrentCandidate[],
  season: number,
  counts: ReadonlyMap<string, SwarmCount>,
  height: ReleaseHeight | null,
): TorrentCandidate[] {
  const seeders = (c: TorrentCandidate): number => Math.max(c.seeds, counts.get(c.infoHash)?.seeders ?? 0);
  return candidates
    .filter((c) => c.release.pack && holdsSeason(c.name, season) && !looksDead(counts.get(c.infoHash)) && (height === null || c.release.height === height))
    .sort(
      (a, b) =>
        heightRank(a.release.height) - heightRank(b.release.height) ||
        Number(spansMore(a.name)) - Number(spansMore(b.name)) ||
        seeders(b) - seeders(a) ||
        a.infoHash.localeCompare(b.infoHash),
    );
}

/** The release name names `season`: alone, inside a range of seasons, or a complete series that names no season. */
export function holdsSeason(name: string, season: number): boolean {
  const ref = parseEpisodeRef(name);
  if (ref.season === null) return ref.complete;
  return season >= ref.season && season <= (ref.seasonTo ?? ref.season);
}

/** A range of seasons or a complete series: more than the one season is listed. */
function spansMore(name: string): boolean {
  const ref = parseEpisodeRef(name);
  return ref.seasonTo !== null || ref.complete;
}
