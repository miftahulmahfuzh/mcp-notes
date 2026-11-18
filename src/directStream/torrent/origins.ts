import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_TRACKERS, normalizeInfoHash, isUsableHash } from './find/candidate.js';
import { trackersFromMagnet } from './find/http.js';
import { udpTrackerOf } from './find/scrape.js';

/**
 * What a pasted magnet link says about where it came from (/update-cloud-source <magnet>). A magnet holds an info
 * hash, a name and trackers, and no link to its page; but an index that runs its own trackers signs its magnets
 * with them (RuTracker's bt*.t-ru.org), so the trackers name the index. The magnet's other, public trackers are
 * kept in the tracker book and added to every torrent the daemon opens and every scrape it asks.
 */

export interface KnownOrigin {
  /** Lower case, as an index is named in attempts. */
  index: string;
  label: string;
  /** Tracker hosts only this index's magnets carry. */
  hosts: readonly RegExp[];
  /** The torrent site module that asks it (claude/streaming/torrent/sites/<site>.mjs, TORRENT_SITES); null: none yet. */
  site: string | null;
  /** What the owner must do once by hand before the site answers; null: nothing. */
  gate: string | null;
}

/** The indexes whose magnets can be told by their trackers. One line per index; add a line when a new one is met. */
export const KNOWN_ORIGINS: readonly KnownOrigin[] = [
  { index: 'rutracker', label: 'RuTracker', hosts: [/(^|\.)t-ru\.org$/, /(^|\.)rutracker\.(org|net|cc|nl)$/], site: 'rutracker', gate: 'its search needs a logged-in account: node claude/streaming/torrent/cli.mjs rutracker gate' },
  { index: 'nnmclub', label: 'NNM-Club', hosts: [/(^|\.)nnm-club\.(to|cx|me|name|tv)$/, /(^|\.)nnmclub\.to$/], site: null, gate: null },
  { index: 'kinozal', label: 'Kinozal', hosts: [/(^|\.)torrent4me\.com$/, /(^|\.)kinozal\.(tv|me|guru)$/], site: null, gate: null },
  { index: 'rutor', label: 'Rutor', hosts: [/(^|\.)opentor\.(net|org)$/, /(^|\.)rutor\.(info|is|org)$/], site: null, gate: null },
  { index: 'nyaa', label: 'Nyaa', hosts: [/(^|\.)nyaa\.tracker\.wf$/, /(^|\.)nyaa\.si$/], site: null, gate: null },
];

export interface MagnetFacts {
  infoHash: string;
  /** The magnet's `dn`, or null. */
  name: string | null;
  trackers: string[];
  /** The index its trackers name, with the tracker host that says so; null when none does. */
  origin: { known: KnownOrigin; by: string } | null;
  /** The trackers that belong to that index. */
  own: string[];
  /** Every other tracker. */
  others: string[];
  /** Tracker hosts no known index owns and no public tracker list of ours holds: what an unknown index would be told by. */
  unknownHosts: string[];
}

/** The host of a tracker address, lower case; null when it has none. */
export function trackerHost(url: string): string | null {
  const udp = udpTrackerOf(url);
  if (udp !== null) return udp.host;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** `host:port` for a UDP tracker, else the address without a trailing slash: two spellings of one tracker compare equal. */
export function trackerKey(url: string): string {
  const udp = udpTrackerOf(url);
  return udp === null ? url.trim().replace(/\/+$/, '').toLowerCase() : `udp:${udp.key}`;
}

/** Reads a magnet link (or a bare 40-hex info hash); null when it names no usable info hash. */
export function readMagnet(magnet: string, knownTrackers: readonly string[] = DEFAULT_TRACKERS): MagnetFacts | null {
  const trimmed = magnet.trim();
  const bare = /^[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed : null;
  const raw = bare ?? /xt=urn:btih:([0-9a-fA-F]{40}|[2-7a-zA-Z]{32})/.exec(trimmed)?.[1] ?? null;
  if (raw === null) return null;
  const infoHash = normalizeInfoHash(raw);
  if (!isUsableHash(infoHash)) return null;
  const at = trimmed.indexOf('?');
  const name = bare !== null || at < 0 ? null : (new URLSearchParams(trimmed.slice(at + 1)).get('dn') ?? '').trim() || null;
  const trackers = bare !== null ? [] : [...new Set(trackersFromMagnet(trimmed))];
  let origin: MagnetFacts['origin'] = null;
  const own: string[] = [];
  const others: string[] = [];
  for (const tracker of trackers) {
    const host = trackerHost(tracker);
    const known = host === null ? undefined : KNOWN_ORIGINS.find((o) => o.hosts.some((h) => h.test(host)));
    if (known === undefined || host === null) {
      others.push(tracker);
      continue;
    }
    origin ??= { known, by: host };
    if (known === origin.known) own.push(tracker);
    else others.push(tracker);
  }
  const knownKeys = new Set(knownTrackers.map(trackerKey));
  const unknownHosts = [...new Set(others.filter((t) => !knownKeys.has(trackerKey(t))).map(trackerHost).filter((h): h is string => h !== null))];
  return { infoHash, name, trackers, origin, own, others, unknownHosts };
}

/** Trackers kept at most. */
export const TRACKER_BOOK_MAX = 40;

interface BookEntry {
  url: string;
  added_at: string;
  /** Where it was learned: the info hash of the magnet that carried it. */
  from: string;
}

/**
 * The public trackers learned from magnets the owner pasted, kept in one JSON file per host (in the torrent
 * folder). Only UDP trackers that answered are added (TorrentSource.learnMagnet). Reading never throws: a missing or
 * broken file is an empty book.
 */
export class TrackerBook {
  private entries: BookEntry[] | null = null;

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private load(): BookEntry[] {
    if (this.entries !== null) return this.entries;
    let entries: BookEntry[] = [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { trackers?: unknown };
      if (Array.isArray(parsed.trackers)) {
        entries = parsed.trackers.filter((e): e is BookEntry => typeof e === 'object' && e !== null && typeof (e as BookEntry).url === 'string' && udpTrackerOf((e as BookEntry).url) !== null);
      }
    } catch {
      entries = [];
    }
    this.entries = entries;
    return entries;
  }

  /** The learned trackers' addresses, oldest first. */
  list(): string[] {
    return this.load().map((e) => e.url);
  }

  has(url: string): boolean {
    const key = trackerKey(url);
    return this.load().some((e) => trackerKey(e.url) === key);
  }

  /** Adds the trackers the book lacks (and DEFAULT_TRACKERS lack), up to TRACKER_BOOK_MAX; answers the ones added. */
  add(urls: readonly string[], from: string): string[] {
    const entries = this.load();
    const taken = new Set([...DEFAULT_TRACKERS, ...entries.map((e) => e.url)].map(trackerKey));
    const added: string[] = [];
    for (const url of urls) {
      if (udpTrackerOf(url) === null || taken.has(trackerKey(url)) || entries.length >= TRACKER_BOOK_MAX) continue;
      taken.add(trackerKey(url));
      entries.push({ url: url.trim(), added_at: this.now().toISOString(), from });
      added.push(url.trim());
    }
    if (added.length > 0) {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ trackers: entries }, null, 2)}\n`);
    }
    return added;
  }
}

/** The tracker book's file name inside the torrent folder. */
export const TRACKER_BOOK_FILE = 'trackers.json';
