import { normalizeName } from '../../match.js';
import { isUsableHash } from './candidate.js';
import { episodeFitOf, type EpisodeFit } from './release.js';
import type { ExcludedCandidate, ExcludeReason, ReleaseHeight, TorrentCandidate, TorrentQuery } from './types.js';

/** Fewer seeds than this and a torrent is never picked. */
export const DEFAULT_MIN_SEEDS = 5;
/** The seed floor for the last-resort (dub-named) tier: a thin swarm is tried when nothing else exists, a dead one is not. */
export const LAST_RESORT_MIN_SEEDS = 1;
/** This many seeds or more streams without waiting; such a torrent comes before a better picture with fewer. */
export const DEFAULT_GOOD_SEEDS = 20;
/** A single file larger than this is left out (a pack is not: only the episode file is downloaded). */
export const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 ** 3;
/** Picture heights, preferred first; anything else (unknown) comes after. */
export const HEIGHT_PREFERENCE: readonly ReleaseHeight[] = [1080, 720, 2160, 480];

export interface RankSettings {
  minSeeds: number;
  goodSeeds: number;
  maxSizeBytes: number;
}

export const DEFAULT_RANK_SETTINGS: Readonly<RankSettings> = {
  minSeeds: DEFAULT_MIN_SEEDS,
  goodSeeds: DEFAULT_GOOD_SEEDS,
  maxSizeBytes: DEFAULT_MAX_SIZE_BYTES,
};

export interface Ranked {
  kept: TorrentCandidate[];
  excluded: ExcludedCandidate[];
  /**
   * Releases left out only because the name reads as a dub, but otherwise this title and playable (right
   * episode, enough seeds, not a cam/3D, not too big). The torrent source tries these after the kept ones all
   * fail, and the file probe decides: many such releases are dual-audio and still carry the original track.
   */
  lastResort: TorrentCandidate[];
}

const FIT_ORDER: Record<EpisodeFit, number> = { match: 0, pack: 1, unknown: 2, other: 3 };

function fitOf(c: TorrentCandidate, query: TorrentQuery): EpisodeFit {
  return query.kind === 'tv' ? episodeFitOf(c.name, c.fileName, query) : 'match';
}

/** One candidate for every listing of one info hash. */
function joinListings(group: readonly TorrentCandidate[], query: TorrentQuery): TorrentCandidate {
  const ordered = [...group].sort(
    (a, b) =>
      FIT_ORDER[fitOf(a, query)] - FIT_ORDER[fitOf(b, query)] ||
      Number(b.fileName !== null) - Number(a.fileName !== null) ||
      b.seeds - a.seeds,
  );
  const [base] = ordered;
  if (base === undefined) throw new RangeError('an empty listing group');
  if (group.length === 1) return base;
  return {
    ...base,
    seeds: Math.max(...group.map((c) => c.seeds)),
    sizeBytes: base.sizeBytes ?? group.find((c) => c.sizeBytes !== null)?.sizeBytes ?? null,
    listedBy: [...new Set(group.flatMap((c) => c.listedBy))],
    trackers: [...new Set(group.flatMap((c) => c.trackers))],
    scoped: group.some((c) => c.scoped),
  };
}

function namesTitle(c: TorrentCandidate, query: TorrentQuery): boolean {
  const wanted = [query.title, query.originalTitle].map((t) => normalizeName(t ?? '')).filter((t) => t.length > 0);
  if (wanted.length === 0) return true;
  const text = normalizeName(`${c.name} ${c.fileName ?? ''}`);
  return wanted.some((t) => text.includes(t));
}

/** Why a candidate is left out, or null when it is kept. */
export function exclusionOf(c: TorrentCandidate, query: TorrentQuery, settings: RankSettings = DEFAULT_RANK_SETTINGS): ExcludeReason | null {
  if (!isUsableHash(c.infoHash)) return 'bad_hash';
  if (!namesTitle(c, query)) return 'other_title';
  if (c.release.dubbed) return 'dubbed';
  if (c.release.cam) return 'cam';
  if (c.release.threeD) return 'three_d';
  if (query.kind === 'tv') {
    const fit = fitOf(c, query);
    if (fit === 'other' || (fit === 'unknown' && !c.scoped)) return 'other_episode';
  }
  if (c.seeds < settings.minSeeds) return 'few_seeds';
  if (!c.release.pack && c.sizeBytes !== null && c.sizeBytes > settings.maxSizeBytes) return 'too_big';
  return null;
}

function heightRank(height: ReleaseHeight | null): number {
  const at = height === null ? -1 : HEIGHT_PREFERENCE.indexOf(height);
  return at < 0 ? HEIGHT_PREFERENCE.length : at;
}

/** Negative when `a` is the better pick. */
export function compareCandidates(a: TorrentCandidate, b: TorrentCandidate, settings: RankSettings = DEFAULT_RANK_SETTINGS): number {
  return (
    Number(b.release.direct) - Number(a.release.direct) ||
    Number(b.seeds >= settings.goodSeeds) - Number(a.seeds >= settings.goodSeeds) ||
    heightRank(a.release.height) - heightRank(b.release.height) ||
    b.seeds - a.seeds ||
    a.infoHash.localeCompare(b.infoHash)
  );
}

/** Joins listings by info hash, leaves out what may not be picked, orders the rest best first. */
export function rankCandidates(all: readonly TorrentCandidate[], query: TorrentQuery, settings: RankSettings = DEFAULT_RANK_SETTINGS): Ranked {
  const groups = new Map<string, TorrentCandidate[]>();
  for (const c of all) {
    const group = groups.get(c.infoHash);
    if (group === undefined) groups.set(c.infoHash, [c]);
    else group.push(c);
  }
  const kept: TorrentCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  const lastResort: TorrentCandidate[] = [];
  for (const group of groups.values()) {
    const joined = joinListings(group, query);
    const reason = exclusionOf(joined, query, settings);
    if (reason === null) kept.push(joined);
    else {
      excluded.push({ infoHash: joined.infoHash, name: joined.name, index: joined.index, seeds: joined.seeds, reason });
      // Left out only for the dub in its name, but otherwise this title and playable: a last resort the probe decides on.
      // The normal seed floor does not apply here — in this tier there is nothing better — but a dead (0-seed) swarm is
      // still skipped, so the dub flag and the seed floor are both lowered to LAST_RESORT_MIN_SEEDS for this check.
      const withoutDub = { ...joined, release: { ...joined.release, dubbed: false } };
      if (reason === 'dubbed' && joined.seeds >= LAST_RESORT_MIN_SEEDS && exclusionOf(withoutDub, query, { ...settings, minSeeds: LAST_RESORT_MIN_SEEDS }) === null) lastResort.push(joined);
    }
  }
  kept.sort((a, b) => compareCandidates(a, b, settings));
  lastResort.sort((a, b) => compareCandidates(a, b, settings));
  return { kept, excluded, lastResort };
}
