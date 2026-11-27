import { DEFAULT_TRACKERS, type SwarmCount, type TorrentCandidate } from '../find/index.js';
import { scrapeTrackerOrder } from '../find/scrape.js';
import { trackerKey } from '../origins.js';
import { messageOf } from './text.js';
import type { TorrentSourceOptions } from './types.js';

/** The tracker sources a torrent is opened and scraped with: the book learned from pasted magnets, the public lists, the scraper. */
type TrackerSources = Pick<TorrentSourceOptions, 'book' | 'lists' | 'scrape'>;

/**
 * A candidate's trackers, then the learned ones (the tracker book), then the public lists' (trackerLists.ts),
 * without repeats: two spellings of one tracker (trackerKey) are one, the first kept.
 */
export function trackersOf(sources: TrackerSources, c: Pick<TorrentCandidate, 'trackers'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of [...c.trackers, ...(sources.book?.list() ?? []), ...(sources.lists?.list() ?? [])]) {
    const key = trackerKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/**
 * What the trackers know of each candidate's swarm, asked before any is joined; empty when nobody is asked or
 * answers. The defaults, the book and the candidates' own trackers come first; the list trackers get the last
 * places (scrapeTrackerOrder), so they are asked without making the scrape longer. Never throws.
 */
export async function swarmCounts(
  sources: TrackerSources,
  log: (line: string) => void,
  candidates: readonly Pick<TorrentCandidate, 'infoHash' | 'trackers'>[],
  timeoutMs?: number,
): Promise<Map<string, SwarmCount>> {
  const scrape = sources.scrape ?? null;
  if (scrape === null || candidates.length === 0) return new Map();
  const trackers = scrapeTrackerOrder([...DEFAULT_TRACKERS, ...(sources.book?.list() ?? []), ...candidates.flatMap((c) => c.trackers)], sources.lists?.list() ?? []);
  try {
    return await scrape(candidates.map((c) => c.infoHash), trackers, timeoutMs === undefined ? {} : { timeoutMs });
  } catch (err) {
    log(`[notesd] torrent: the trackers could not be asked: ${messageOf(err)}`);
    return new Map();
  }
}
