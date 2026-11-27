import { refLabel, type StreamRef } from '../../types.js';
import { parseRelease, type TorrentCandidate } from '../find/index.js';
import type { TorrentMark } from '../marks.js';
import type { TorrentSlotRecord } from '../types.js';
import { CANDIDATE_LIST_FIND_MS, CANDIDATE_LIST_TTL_MS, candidateRows, type Gathered, type TorrentCandidateList } from '../candidates.js';
import { TRACKER_PROBE_MS } from './constants.js';
import type { SourceContext } from './context.js';
import { queryOf, refKey } from './query.js';
import { messageOf } from './text.js';
import { swarmCounts } from './trackers.js';
import type { FindAnswer, TitleNames } from './types.js';

/** Titles whose last finder answer is kept; past it the oldest goes first. */
export const LISTINGS_KEPT = 64;

/** Per film or episode, in memory: the finder's last answer and when, for the candidates list (CANDIDATE_LIST_TTL_MS). */
export class CandidateListings {
  private readonly listings = new Map<string, { at: number; found: FindAnswer }>();

  constructor(private readonly now: () => number) {}

  keep(key: string, found: FindAnswer): void {
    this.listings.set(key, { at: this.now(), found });
    // A few dozen titles at most: the oldest goes first.
    while (this.listings.size > LISTINGS_KEPT) this.listings.delete(this.listings.keys().next().value as string);
  }

  get(key: string): { at: number; found: FindAnswer } | null {
    return this.listings.get(key) ?? null;
  }
}

/**
 * Every candidate torrent of a film or episode, for the candidates list: what the indexes list (asked now, or their
 * answer of the last CANDIDATE_LIST_TTL_MS, a play's own included; `fresh` always asks), the torrents this machine
 * opened for it before, and the magnets pasted for it, each with its marks, how it went and what the trackers know.
 * Joins no swarm. `remembered` is the info hash a Torrent Stream play opens again first.
 */
export async function listCandidates(
  ctx: SourceContext,
  ref: StreamRef,
  options: { audioLang: string | null; imdbId: string | null; names?: TitleNames | null; fresh?: boolean; remembered?: string | null },
): Promise<TorrentCandidateList> {
  const { opts, now, log, listings } = ctx;
  const key = refKey(ref);
  const query = queryOf(ref, options.imdbId, options.names ?? null, options.audioLang);
  let kept = listings.get(key);
  let cached = true;
  if (kept !== null && now() - kept.at >= CANDIDATE_LIST_TTL_MS) kept = null;
  if (options.fresh === true || kept === null) {
    cached = false;
    try {
      const found = await opts.find(query, AbortSignal.timeout(CANDIDATE_LIST_FIND_MS));
      listings.keep(key, found);
      kept = listings.get(key);
    } catch (err) {
      log(`[notesd] torrent: the indexes could not be asked for the candidates of ${refLabel(ref)}: ${messageOf(err)}`);
    }
  }
  const found = kept?.found ?? null;
  const failedOf = ctx.failures.whyOf(key);
  const releaseOf = (name: string) => parseRelease(name, { title: query.title ?? null, originalTitle: query.originalTitle ?? null, originalLanguage: query.originalLanguage ?? null });
  const gathered: Gathered[] = [];
  const seen = new Set<string>();
  const add = (g: Gathered): void => {
    if (seen.has(g.infoHash)) return;
    seen.add(g.infoHash);
    gathered.push(g);
  };
  for (const [list, dubNamed] of [[found?.candidates ?? [], false], [found?.lastResort ?? [], true]] as const) {
    for (const c of list) {
      add({ infoHash: c.infoHash, name: c.name, release: c.release, sizeBytes: c.sizeBytes, seeds: c.seeds, from: c.listedBy.length > 0 ? c.listedBy : [c.index], dubNamed, leftOut: null, failed: failedOf(c.infoHash), worked: false, onDisk: false });
    }
  }
  for (const [hash, p] of ctx.pasted.of(key)) {
    add({ infoHash: hash, name: p.name, release: releaseOf(p.name), sizeBytes: null, seeds: null, from: ['magnet'], dubNamed: false, leftOut: null, failed: p.failed, worked: p.failed === null, onDisk: false });
  }
  let rows: TorrentSlotRecord[] = [];
  try {
    rows = (await opts.swarm.downloadsOf?.(ref)) ?? [];
  } catch (err) {
    log(`[notesd] torrent: this machine's torrents of ${refLabel(ref)} could not be read: ${messageOf(err)}`);
  }
  for (const r of rows) {
    const name = r.release ?? r.name;
    add({ infoHash: r.infoHash, name, release: releaseOf(name), sizeBytes: r.fileLength, seeds: null, from: ['played before'], dubNamed: false, leftOut: null, failed: failedOf(r.infoHash), worked: false, onDisk: false });
  }
  const remembered = options.remembered?.toLowerCase() ?? null;
  if (remembered !== null && !seen.has(remembered)) {
    add({ infoHash: remembered, name: (await opts.swarm.releaseName?.(remembered).catch(() => null)) ?? remembered, release: { height: null, languages: [], dubGroup: null }, sizeBytes: null, seeds: null, from: ['played before'], dubNamed: false, leftOut: null, failed: failedOf(remembered), worked: true, onDisk: false });
  }
  for (const e of found?.excluded ?? []) {
    if (e.reason === 'bad_hash' || e.reason === 'other_title' || e.reason === 'other_year' || e.reason === 'other_episode') continue;
    add({ infoHash: e.infoHash, name: e.name, release: releaseOf(e.name), sizeBytes: null, seeds: e.seeds, from: [e.index], dubNamed: false, leftOut: e.reason, failed: failedOf(e.infoHash), worked: false, onDisk: false });
  }
  const hashes = gathered.map((g) => g.infoHash);
  let marks = new Map<string, TorrentMark>();
  try {
    marks = (await opts.marks?.many(hashes)) ?? new Map();
  } catch (err) {
    log(`[notesd] torrent: the torrent marks could not be read: ${messageOf(err)}`);
  }
  const counts = await swarmCounts(opts, log, gathered.map((g) => ({ infoHash: g.infoHash, trackers: [] }) as unknown as TorrentCandidate), TRACKER_PROBE_MS);
  return {
    original_language: options.audioLang,
    listed_at: kept === null ? null : new Date(kept.at).toISOString(),
    cached: kept !== null && cached,
    indexes: found?.indexes ?? [],
    candidates: candidateRows(gathered, { audioLang: options.audioLang, marks, rows, counts, remembered }),
  };
}
