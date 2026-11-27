import { DEFAULT_TRACKERS, udpTrackerOf, type SwarmCount } from '../find/index.js';
import { readMagnet, trackerKey } from '../origins.js';
import { TRACKER_PROBE_MS } from './constants.js';
import { messageOf, plural } from './text.js';
import type { MagnetReport, TorrentSourceOptions } from './types.js';

/**
 * /update-cloud-source <magnet>: reads where a pasted magnet comes from (the index its own trackers name), asks
 * the trackers for its swarm, and keeps its public UDP trackers that answer in the tracker book, so every later
 * torrent is opened and scraped with them too. Joins no swarm and plays nothing. Never throws.
 */
export async function learnMagnet(opts: Pick<TorrentSourceOptions, 'book' | 'scrape' | 'sites'>, log: (line: string) => void, magnet: string): Promise<MagnetReport> {
  const book = opts.book ?? null;
  const facts = readMagnet(magnet, [...DEFAULT_TRACKERS, ...(book?.list() ?? [])]);
  if (facts === null) return { ok: false, error: 'bad_magnet', detail: 'not a magnet link or a 40-character info hash' };
  const scrape = opts.scrape ?? null;
  const knownKeys = new Set([...DEFAULT_TRACKERS, ...(book?.list() ?? [])].map(trackerKey));
  const known = facts.others.filter((t) => knownKeys.has(trackerKey(t)));
  const fresh = facts.others.filter((t) => !knownKeys.has(trackerKey(t)));
  const udp = fresh.filter((t) => udpTrackerOf(t) !== null);
  const skipped = fresh.filter((t) => udpTrackerOf(t) === null);
  const answered = new Set<string>();
  let swarm: SwarmCount | null = null;
  if (scrape !== null) {
    const asks = udp.map(async (tracker) => {
      try {
        if ((await scrape([facts.infoHash], [tracker], { timeoutMs: TRACKER_PROBE_MS })).has(facts.infoHash)) answered.add(tracker);
      } catch {
        // A tracker that cannot be asked is a silent one.
      }
    });
    const whole = scrape([facts.infoHash], [...facts.trackers, ...DEFAULT_TRACKERS, ...(book?.list() ?? [])], { timeoutMs: TRACKER_PROBE_MS }).then(
      (counts) => counts.get(facts.infoHash) ?? null,
      () => null,
    );
    await Promise.all(asks);
    swarm = await whole;
  }
  let added: string[] = [];
  try {
    added = book === null ? [] : book.add(udp.filter((t) => answered.has(t)), facts.infoHash);
  } catch (err) {
    log(`[notesd] torrent: the tracker book could not be written: ${messageOf(err)}`);
  }
  const silent = udp.filter((t) => !added.includes(t));
  const o = facts.origin;
  const siteOrigin = o === null || o.known.site === null ? null : (opts.sites?.[o.known.site] ?? null);
  const origin = o === null ? null : { index: o.known.index, label: o.known.label, by: o.by, supported: o.known.site !== null, enabled: siteOrigin !== null, site_origin: siteOrigin, gate: o.known.site === null ? null : o.known.gate };
  const next =
    origin === null
      ? facts.unknownHosts.length > 0
        ? `No index we know signs its magnets with these trackers. The hosts ${facts.unknownHosts.join(', ')} are not public trackers we hold: find out which site runs them (a web search of the host, and the name's format), and when it is a torrent index worth asking, add it as a torrent site (claude/streaming/torrent/sites/, TORRENT_SITES, KNOWN_ORIGINS).`
        : 'The magnet carries only public trackers: nothing tells which index it came from.'
      : origin.supported
        ? origin.enabled
          ? `The magnet is from ${origin.label} (its tracker ${origin.by}), an index the torrent finder already asks at ${origin.site_origin} when the JSON indexes have nothing new.${origin.gate === null ? '' : ` Tell the owner: ${origin.gate}.`}`
          : `The magnet is from ${origin.label} (its tracker ${origin.by}); its site module exists and is switched off in this daemon's settings.`
        : `The magnet is from ${origin.label} (its tracker ${origin.by}), an index the torrent finder cannot ask yet: add it as a torrent site (claude/streaming/torrent/sites/, TORRENT_SITES, and its \`site\` in KNOWN_ORIGINS).`;
  log(`[notesd] torrent: magnet ${facts.infoHash.slice(0, 8)} read: ${origin === null ? 'no known index' : origin.label}, ${plural(added.length, 'tracker')} added${swarm === null ? '' : `, ${plural(swarm.seeders, 'seeder')} known`}`);
  return { ok: true, info_hash: facts.infoHash, name: facts.name, origin, unknown_hosts: facts.unknownHosts, trackers: { own: facts.own, known, added, silent, skipped }, swarm, next };
}
